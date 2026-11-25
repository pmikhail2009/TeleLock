import { api, fetch } from 'sdk';
import { gateway, secret } from '../lib/config.js';
import { issueCode, pairingForOwner, redeemCode } from '../lib/pairing.js';
import { commandFor, keyboard, helpText, restrictedText, statusText, settingsMessage,
  currentLanguage, localize, languageMessage, feedbackMaxLength, feedbackPrompt, feedbackThanks,
  feedbackMessage, reviewsMessage, thanksMessage, staffMenu, statsText } from '../lib/controls.js';

async function relay(action, payload) {
  const response = await fetch(gateway + '/service/' + action, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (response.status === 400 || response.status === 409) return null;
  if (['feedback', 'stats'].includes(action) && response.status === 403) return response.json();
  if (!response.ok) throw new Error('Сервис подключения Telelock недоступен');
  return response.json();
}

async function finishPairing(owner, code, t) {
  const claim = await relay('inspect', { code });
  if (!claim) return t('This code is invalid. Get a new code with /code.', 'Код недействителен. Получите новый командой /code.');
  if (!claim.installation) return t('Enter the code in the Esc menu and select Connect.', 'Введите код в меню Esc и нажмите «Подключить».');
  await redeemCode(owner, code, claim.installation);
  const row = await pairingForOwner(owner);
  if (row?.redeemed_code !== code || row.installation !== claim.installation)
    return t('The connection changed. Get a new code with /code.', 'Привязка изменилась. Получите новый код командой /code.');
  const confirmed = await relay('confirm', { code, owner, installation: claim.installation,
    generation: row.generation, revision: row.revision });
  return confirmed?.ok ? null : t('The code expired. Get a new code with /code.', 'Код истёк. Получите новый командой /code.');
}

export default async function (message, ctx) {
  if (message.chat?.type !== 'private' || message.from?.is_bot ||
      message.from?.id !== message.chat.id) return;
  const command = commandFor(message.text);
  const owner = message.chat.id;
  let tier = 'free';
  let language = 'en';
  const t = (en, ru) => localize(language, en, ru);
  const connectedText = () => t('Telegram is connected. Use the buttons below to control your game.',
    'Telegram подключён. Управляйте своей игрой кнопками ниже.');
  const original = message.reply_to_message;
  if (gateway && !command && original?.from?.is_bot &&
      [feedbackPrompt('en'), feedbackPrompt('ru')].includes(original.text)) {
    language = original.text === feedbackPrompt('ru') ? 'ru' : 'en';
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text || text.length > feedbackMaxLength) {
      await api.sendMessage({ chat_id: owner, text: t('Send a text reply of up to 1,000 characters.',
        'Отправьте текстовый ответ длиной до 1000 символов.') });
      return;
    }
    try {
      const result = await relay('feedback', { owner, operation: 'write', text, date: message.date, id: ctx.update?.update_id });
      if (!result?.saved) throw new Error('Feedback save failed');
      await api.sendMessage({ chat_id: owner, text: feedbackThanks(result.language) });
    } catch {
      await api.sendMessage({ chat_id: owner, text: t('Could not confirm your review. Please try again.',
        'Не удалось подтвердить сохранение отзыва. Попробуйте ещё раз.') });
    }
    return;
  }
  if (!command) {
    if (!gateway || typeof message.text !== 'string' || !message.text.trim()) return;
    const result = await relay('access', { owner: message.chat.id, password: message.text.trim(), id: message.message_id ?? ctx.update?.update_id });
    const status = result?.changed ? await relay('status', { owner }) : null;
    language = currentLanguage(status?.language);
    if (result?.changed) await api.sendMessage({ chat_id: message.chat.id,
      text: result.tier === 'free'
        ? t('Staff mode is off. All game features remain available for free.', 'Служебный режим выключен. Все игровые функции по-прежнему доступны бесплатно.')
        : t(`Signed in as ${staffMenu(result.tier)}. Send the same password to sign out.`,
          `Режим ${staffMenu(result.tier)} включён. Отправьте тот же пароль, чтобы выйти.`),
      reply_markup: keyboard(!!status?.generation, 'home', status?.tier ?? result.tier, language) });
    return;
  }
  const send = (text, linked = false, section = 'home') => api.sendMessage({
    chat_id: owner, text, reply_markup: keyboard(linked, section, tier, language),
  });
  async function sendCode(linked = false, section = 'control') {
    const owner = message.chat.id;
    const expires = Date.now() + 600000;
    const code = await issueCode(owner);
    try {
      if (gateway && !(await relay('offer', { code, expires, owner }))?.ok)
        throw new Error('Не удалось зарегистрировать код');
    } catch {
      await send(t('Pairing is temporarily unavailable. Try requesting a code again later.',
        'Сервис подключения временно недоступен. Попробуйте получить код немного позже.'), linked, section);
      return;
    }
    await send(t('Telelock code: ', 'Код Telelock: ') + code +
      t('\nEnter it in the Esc menu and select Connect. The code expires in 10 minutes.',
        '\nВведите его в меню Esc и нажмите «Подключить». Код действует 10 минут.') +
      (gateway ? '' : '\nGame pairing is not configured yet.'), linked, section);
  }
  if (!gateway) {
    if (command === '/start' || command === '/code') await sendCode(false, command === '/start' ? 'home' : 'control');
    else await send('Game pairing is not configured yet. Get a code with /code.');
    return;
  }
  let binding, current;
  try {
    if (command === '/thanks' || command === '/pro') {
      const result = await relay('thanks', { owner });
      await api.sendMessage({ chat_id: owner, ...thanksMessage(result.language) });
      return;
    }
    if (command === '/stats') {
      const result = await relay('stats', { owner });
      await api.sendMessage({ chat_id: owner, text: statsText(result) });
      return;
    }
    if (command === '/feedback' || command === '/reviews') {
      const result = await relay('feedback', { owner, operation: command === '/feedback' ? 'open' : 'list' });
      const reply = command === '/feedback' ? feedbackMessage(result.language, result.rating) : reviewsMessage(result);
      await api.sendMessage({ chat_id: owner, ...reply });
      return;
    }
    current = await relay('status', { owner });
    language = currentLanguage(current?.language);
    if (!['/language', '/pro'].includes(command)) binding = await pairingForOwner(owner);
  } catch {
    await send((command === '/help' ? helpText(language) + '\n\n' : '') +
      t('Could not check the connection. The service is temporarily unavailable. Try again later.',
        'Не удалось проверить подключение: сервис временно недоступен. Попробуйте ещё раз позже.'));
    return;
  }
  tier = current?.tier ?? 'free';
  const linked = !!binding?.generation && current?.generation === binding.generation;
  const connectText = () => t('Open Control Center, get a new code and enter it in the Deadlock Esc menu.',
    'Откройте центр управления, получите новый код и введите его в меню Esc в Deadlock.');
  if (command === '/language') {
    await api.sendMessage({ chat_id: owner, ...languageMessage(language) });
    return;
  }
  if (command === '/control') {
    await send(t('Control Center', 'Центр управления'), linked, 'control');
    return;
  }
  if (command === '/admin_menu' || command === '/test_menu') {
    const role = staffMenu(tier);
    if (role && command === '/' + role + '_menu') await send(role, linked, 'staff');
    else await send(t('This menu requires the corresponding staff role.', 'Это меню доступно только с соответствующей служебной ролью.'), linked);
    return;
  }
  if (command === '/play' || command === '/modes') {
    await send(linked ? t('Choose a mode to start matchmaking in Deadlock.',
      'Выберите режим, чтобы запустить поиск матча в Deadlock.') : connectText(), linked, 'play');
    return;
  }
  if (command === '/confirm') {
    const code = binding?.pending_code || binding?.redeemed_code;
    const error = code ? await finishPairing(owner, code, t) : t('Get a code with /code.', 'Получите код командой /code.');
    await send(error || connectedText(), !error);
    return;
  }
  if (command === '/code') {
    await sendCode(linked);
    return;
  }
  if (command === '/start' && !linked) {
    await sendCode(false, 'home');
    return;
  }
  if (command === '/help') {
    await send(helpText(language), linked, 'control');
    return;
  }
  if (command === '/start' || command === '/menu') {
    await send(linked ? connectedText() : connectText(), linked);
    return;
  }
  if (!linked) {
    await send(connectText());
    return;
  }
  if (command === '/status') {
    await send(statusText(current.live, language), true, 'play');
    return;
  }
  if (command === '/settings') {
    await api.sendMessage({chat_id:owner,...settingsMessage(current.settings,binding.generation,language)}); return;
  }
  if (command === '/test') { await relay('testbot',{owner:message.chat.id,generation:binding.generation}); return; }
  if (command === '/lab_play' && tier !== 'owner') {
    await send(restrictedText(language), true, 'play');
    return;
  }
  if (!['/play_normal', '/play_ranked', '/play_street', '/cancel', '/watch_black', '/lab_play'].includes(command)) {
    await send(helpText(language), true, 'control');
    return;
  }
  const response = await fetch(gateway + '/service/command', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: ctx.update.update_id, generation: binding?.generation, message: {
      chat: { id: message.chat.id, type: 'private' }, from: { id: message.from.id },
      date: message.date, text: command,
    } }),
  });
  if (!response.ok) throw new Error('Не удалось связаться с реестром Telelock');
  const { reply } = await response.json();
  const section = ['/play_normal', '/play_ranked', '/play_street', '/lab_play'].includes(command) ? 'home' : 'play';
  if (reply) await api.sendMessage({ ...reply, reply_markup: keyboard(true, section, tier, language) });
  else if (section === 'home') await send(t('Main menu', 'Главное меню'), true);
}
