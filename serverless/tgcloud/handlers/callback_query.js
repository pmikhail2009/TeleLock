import { api, fetch } from 'sdk';
import { gateway, secret } from '../lib/config.js';
import { pairingForOwner } from '../lib/pairing.js';
import { settingsMessage } from '../lib/controls.js';

import { communityCallbackPattern, communityDenied, communityMessage, communityReply } from '../lib/community.js';

async function handleCommunity(query, owner, operation, position) {
  await api.answerCallbackQuery({ callback_query_id: query.id });
  const prompt = ['suggestion', 'report', 'add'].includes(operation);
  const body = prompt ? { owner, operation: 'home' }
    : { owner, operation, ...(operation === 'delete' ? { id: position } : { cursor: position }) };
  const response = await fetch(gateway + '/service/community', { method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok && response.status !== 403) throw new Error('Сервис временно недоступен. Попробуйте снова.');
  const result = await response.json();
  if (prompt) {
    const { language, admin } = result;
    const reply = operation === 'add' && !admin ? { text: communityDenied(language) } : communityReply(language, operation);
    await api.sendMessage({ chat_id: owner, ...reply });
    return;
  }
  await api.editMessageText({ chat_id: owner, message_id: query.message.message_id,
    ...communityMessage(result, operation === 'delete' ? 'known' : operation) });
}

export default async function(query, ctx) {
  const owner = query.from?.id;
  if (!Number.isSafeInteger(owner) || query.from?.is_bot || query.message?.chat?.type !== 'private' ||
      query.message.chat.id !== owner) return;
  const community = communityCallbackPattern.exec(query.data || '');
  const input = /^(mode|repeat|test|cancel):([a-f0-9]{32})(?::(on|off|auto|0|15|30|60|[1-9][0-9]{0,14}))?$/.exec(query.data || '');
  if (!input && !community) { await api.answerCallbackQuery({callback_query_id:query.id,text:'Неизвестная кнопка'}); return; }
  try {
    if (community) {
      await handleCommunity(query, owner, community[1], community[2]);
      return;
    }
    const [,action,generation,value] = input;
    const binding = await pairingForOwner(owner);
    if (binding?.generation !== generation) throw new Error('Привязка изменилась. Откройте меню заново.');
    await api.answerCallbackQuery({callback_query_id:query.id});
    const endpoint = action === 'cancel' ? 'command' : action === 'test' ? 'testbot' : 'settings';
    const body = action === 'cancel' ? {generation,expectedCommand:Number(value),id:ctx.update.update_id,
      message:{chat:{id:owner,type:'private'},from:{id:owner},date:Math.floor(Date.now()/1000),text:'/cancel'}}
      : {owner,generation,...(action==='mode'?{mode:value}:action==='repeat'?{repeat:Number(value)}:{})};
    const response = await fetch(gateway + '/service/' + endpoint,{method:'POST',
      headers:{Authorization:'Bearer ' + secret,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Сервис временно недоступен. Попробуйте снова.');
    if (result.settings) await api.editMessageText({chat_id:owner,message_id:query.message.message_id,...settingsMessage(result.settings,generation)});
    if (result.reply) await api.sendMessage(result.reply);
  } catch (error) {
    if (!String(error.message).includes('message is not modified'))
      await api.sendMessage({chat_id:owner,text:error.message || 'Не удалось выполнить действие.'});
  }
}
