import { api, fetch } from 'sdk';
import { gateway, secret } from '../lib/config.js';
import { issueCode, pairingForOwner, redeemCode } from '../lib/pairing.js';
import { commandFor, keyboard, helpText, freeHelpText, restrictedText, statusText, settingsMessage } from '../lib/controls.js';

async function relay(action, payload) {
  const response = await fetch(gateway + '/service/' + action, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (response.status === 400 || response.status === 409) return null;
  if (!response.ok) throw new Error('Сервис подключения KATKA недоступен');
  return response.json();
}

async function finishPairing(owner, code) {
  const claim = await relay('inspect', { code });
  if (!claim) return 'Код недействителен. Получите новый командой /code.';
  if (!claim.installation) return 'Введите код в меню Esc и нажмите «Подключить».';
  await redeemCode(owner, code, claim.installation);
  const row = await pairingForOwner(owner);
  if (row?.redeemed_code !== code || row.installation !== claim.installation)
    return 'Привязка изменилась. Получите новый код командой /code.';
  const confirmed = await relay('confirm', { code, owner, installation: claim.installation,
    generation: row.generation, revision: row.revision });
  return confirmed?.ok ? 'Telegram подключён.' : 'Код истёк. Получите новый командой /code.';
}

export default async function (message, ctx) {
  if (message.chat?.type !== 'private' || message.from?.is_bot ||
      message.from?.id !== message.chat.id) return;
  const command = commandFor(message.text);
  let tier = 'free';
  if (!command) {
    if (!gateway || typeof message.text !== 'string' || !message.text.trim()) return;
    const result = await relay('access', { owner: message.chat.id, password: message.text.trim(), id: message.message_id ?? ctx.update?.update_id });
    const status = result?.changed ? await relay('status', { owner: message.chat.id }) : null;
    if (result?.changed) await api.sendMessage({ chat_id: message.chat.id,
      text: result.tier === 'free' ? 'Скрытый доступ выключен. Бесплатная версия: оповещения Авто.' : 'Полный доступ включён. Повторите этот же пароль, чтобы выйти.',
      reply_markup: keyboard(!!status?.generation, false, result.tier) });
    return;
  }
  const send = (text, linked = false, modes = false) => api.sendMessage({
    chat_id: message.chat.id, text, reply_markup: keyboard(linked, modes, tier),
  });
  async function sendCode(linked = false) {
    const owner = message.chat.id;
    const expires = Date.now() + 600000;
    const code = await issueCode(owner);
    try {
      if (gateway && !(await relay('offer', { code, expires, owner }))?.ok)
        throw new Error('Не удалось зарегистрировать код');
    } catch {
      await send('Сервис подключения временно недоступен. Попробуйте получить код немного позже.', linked);
      return;
    }
    await send('Код KATKA: ' + code + '\nВведите его в меню Esc и нажмите «Подключить». Код действует 10 минут.' +
      (gateway ? '' : '\nПодключение игровых клиентов ещё не настроено.'), linked);
  }
  if (gateway && command === '/confirm') {
    const row = await pairingForOwner(message.chat.id);
    const code = row?.pending_code || row?.redeemed_code;
    const text = code ? await finishPairing(message.chat.id, code) : 'Получите код командой /code.';
    await send(text, text === 'Telegram подключён.');
    return;
  }
  if (!gateway) {
    if (command === '/start' || command === '/code') await sendCode();
    else await send('Подключение игровых клиентов ещё не настроено. Получите код командой /code.');
    return;
  }
  let binding, current;
  try {
    binding = await pairingForOwner(message.chat.id);
    current = await relay('status', { owner: message.chat.id });
  } catch {
    await send((command === '/help' ? helpText + '\n\n' : '') +
      'Не удалось проверить подключение: сервис временно недоступен. Попробуйте ещё раз позже.');
    return;
  }
  tier = ['owner', 'test'].includes(current?.tier) ? current.tier : 'free';
  const linked = !!binding?.generation && current?.generation === binding.generation;
  if (command === '/code') {
    await sendCode(linked);
    return;
  }
  if (command === '/start' && !linked) {
    await sendCode();
    return;
  }
  if (command === '/help') {
    await send(tier === 'free' ? freeHelpText : helpText, linked);
    return;
  }
  if (!linked) {
    await send('Telegram не подключён к игре. Получите новый код и введите его в меню Esc в Deadlock.');
    return;
  }
  if (command === '/modes') {
    await send('Выберите режим. Нажатие кнопки с ▶️ запустит поиск в вашей игре. Режим должен быть доступен в Deadlock.', true, true);
    return;
  }
  if (command === '/start' || command === '/menu') {
    await send('Telegram подключён. Управляйте своей игрой кнопками ниже.', true);
    return;
  }
  if (tier === 'free' && ['/status','/cancel','/watch_black','/settings','/test'].includes(command)) {
    await send(restrictedText, true); return;
  }
  if (command === '/status') {
    await send(statusText(current.live), true);
    return;
  }
  if (command === '/settings') {
    await api.sendMessage({chat_id:message.chat.id,...settingsMessage(current.settings,binding.generation)}); return;
  }
  if (command === '/test') { await relay('testbot',{owner:message.chat.id,generation:binding.generation}); return; }
  if (!['/play_normal', '/play_ranked', '/play_street', '/cancel', '/watch_black'].includes(command)) {
    await send(tier === 'free' ? freeHelpText : helpText, true);
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
  if (!response.ok) throw new Error('Не удалось связаться с реестром KATKA');
  const { reply } = await response.json();
  if (reply) await api.sendMessage({ ...reply, reply_markup: keyboard(true, false, tier) });
}
