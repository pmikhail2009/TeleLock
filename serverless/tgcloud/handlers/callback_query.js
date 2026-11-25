import { api, fetch } from 'sdk';
import { gateway, secret } from '../lib/config.js';
import { pairingForOwner } from '../lib/pairing.js';
import { feedbackMessage, feedbackReply, languageMessage, localize, thanksMessage,
  reviewsMessage, settingsMessage } from '../lib/controls.js';

async function relay(endpoint, body) {
  const response = await fetch(gateway + '/service/' + endpoint, {method:'POST',
    headers:{Authorization:'Bearer ' + secret,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result = await response.json();
  if (endpoint === 'feedback' && response.status === 403) return result;
  if (!response.ok) throw new Error(result.error || 'The service is temporarily unavailable.');
  return result;
}

export default async function(query, ctx) {
  const owner = query.from?.id;
  if (!Number.isSafeInteger(owner) || query.from?.is_bot || query.message?.chat?.type !== 'private' ||
      query.message.chat.id !== owner) return;
  const selection = /^language:(en|ru)$/.exec(query.data || '');
  const review = /^feedback:(write|rate:([1-5])|list:(\d{10}:\d{16}))$/.exec(query.data || '');
  const payment = query.data === 'pro:pay';
  const input = /^(mode|repeat|test|cancel):([a-f0-9]{32})(?::(on|off|auto|0|15|30|60|[1-9][0-9]{0,14}))?$/.exec(query.data || '');
  if (!input && !selection && !review && !payment) { await api.answerCallbackQuery({callback_query_id:query.id,text:'Unknown button / Неизвестная кнопка'}); return; }
  await api.answerCallbackQuery({callback_query_id:query.id});
  if (payment) {
    let result;
    try {
      result = await relay('thanks', { owner });
    } catch {
      const language = /[А-Яа-яЁё]/.test(query.message.text || '') ? 'ru' : 'en';
      await api.sendMessage({ chat_id: owner, text: localize(language,
        'Could not register your thanks. Please try again.',
        'Не удалось зарегистрировать ваше спасибо. Попробуйте ещё раз.') });
      return;
    }
    try {
      await api.editMessageText({ chat_id: owner, message_id: query.message.message_id,
        ...thanksMessage(result.language) });
    } catch (error) {
      if (!String(error.message).includes('message is not modified'))
        await api.sendMessage({ chat_id: owner, ...thanksMessage(result.language) });
    }
    return;
  }
  try {
    if (review) {
      const [, type, rating, cursor] = review;
      if (type === 'write') {
        const { language } = await relay('feedback', { owner, operation: 'open' });
        await api.sendMessage({ chat_id: owner, ...feedbackReply(language) });
        return;
      }
      const result = await relay('feedback', rating ? { owner, operation: 'rate', value: Number(rating) }
        : { owner, operation: 'list', cursor });
      const message = rating ? feedbackMessage(result.language, result.rating) : reviewsMessage(result);
      await api.editMessageText({ chat_id: owner, message_id: query.message.message_id, ...message });
      return;
    }
    if (selection) {
      const { language } = await relay('language', { owner, language: selection[1] });
      await api.editMessageText({chat_id:owner,message_id:query.message.message_id,...languageMessage(language)});
      return;
    }
    const [,action,generation,value] = input;
    const binding = await pairingForOwner(owner);
    if (binding?.generation !== generation)
      throw new Error('Connection changed. Open /menu again. / Привязка изменилась. Откройте /menu заново.');
    const endpoint = action === 'cancel' ? 'command' : action === 'test' ? 'testbot' : 'settings';
    const body = action === 'cancel' ? {generation,expectedCommand:Number(value),id:ctx.update.update_id,
      message:{chat:{id:owner,type:'private'},from:{id:owner},date:Math.floor(Date.now()/1000),text:'/cancel'}}
      : {owner,generation,...(action==='mode'?{mode:value}:action==='repeat'?{repeat:Number(value)}:{})};
    const result = await relay(endpoint, body);
    if (result.settings) await api.editMessageText({chat_id:owner,message_id:query.message.message_id,...settingsMessage(result.settings,generation,result.language)});
    if (result.reply) await api.sendMessage(result.reply);
  } catch (error) {
    if (!String(error.message).includes('message is not modified'))
      await api.sendMessage({chat_id:owner,text:error.message || 'The action could not be completed.'});
  }
}
