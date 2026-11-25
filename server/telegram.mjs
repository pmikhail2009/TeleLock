import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { COMMANDS } from './registry.mjs';

const HELP = [
  'Оповещения в меню Telelock: ВКЛ — для любого найденного матча; ВЫКЛ — отключены; Авто — только при запуске поиска через бота. Режим сохраняется.',
  '/code — получить одноразовый код подключения',
  '/play_normal — искать матч в обычном режиме',
  '/play_ranked — искать ранговый матч',
  '/play_street — искать матч в «Уличной стычке»',
  '/cancel — отменить поиск',
  '/watch_black — включить наблюдение за матчем',
  '/help — показать команды',
].join('\n');

const KEYBOARD = {
  keyboard: [['/code', '/help'], ['/play_normal', '/play_ranked'], ['/play_street', '/cancel'], ['/watch_black']],
  resize_keyboard: true,
};

async function api(token, method, params, outerSignal) {
  const timeout = AbortSignal.timeout(method === 'getUpdates' ? 35000 : 15000);
  const signal = outerSignal ? AbortSignal.any([timeout, outerSignal]) : timeout;
  const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal,
    redirect: 'error',
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const status = data.error_code || response.status;
    const error = new Error('Telegram ' + method + ' HTTP ' + status);
    error.status = status;
    error.retryAfter = data.parameters?.retry_after;
    // Only an explicit Bot API refusal proves the message was not accepted.
    // A timeout, a proxy response or a server error can follow a successful send.
    error.definiteRejection = data.ok === false && response.status === data.error_code &&
      [400, 401, 403, 404, 429].includes(status);
    throw error;
  }
  return data.result;
}

export function sendText(token, chat, text) {
  if (!/^[1-9]\d{0,18}$/.test(chat)) throw new Error('Требуется личный чат');
  return api(token, 'sendMessage', { chat_id: String(chat), text });
}

export function replyFor(registry, message) {
  const chat = String(message?.chat?.id);
  if (message?.chat?.type !== 'private' || message.from?.is_bot ||
      String(message.from?.id) !== chat || !/^[1-9]\d{0,18}$/.test(chat) ||
      typeof message.text !== 'string') return null;
  const command = message.text.trim().split(/\s+/, 1)[0].toLowerCase();
  if (!command.startsWith('/')) return null;
  let text;
  if (command === '/start' || command === '/code') {
    const code = registry.issue(chat);
    text = 'Код из Telegram: ' + code + '\nОткройте меню Esc в Deadlock, введите код и нажмите «Подключить». Код действует 10 минут.';
    if (command === '/start') text += '\n\n' + HELP;
  } else if (COMMANDS.has(command)) {
    if (!Number.isSafeInteger(message.date) || Date.now() - message.date * 1000 >= 30000) {
      text = 'Команда устарела. Отправьте её ещё раз.';
    } else {
      try {
        registry.enqueue(chat, command);
        text = 'Команда передана в очередь вашей игры.';
      } catch (error) {
        if (error.message !== 'Сначала подключите Telegram в игре') throw error;
        text = 'Сначала подключите Telegram в игре. Получите код командой /code.';
      }
    }
  } else {
    text = HELP;
  }
  const reply = { chat_id: chat, text };
  if (command === '/start' || command === '/help') reply.reply_markup = KEYBOARD;
  return reply;
}

export async function startTelegram(registry, token, signal) {
  // Use the bot ID as the cursor namespace so a token rotation retains progress.
  const bot = createHash('sha256').update(token.split(':', 1)[0]).digest('hex');
  const db = registry.db;
  db.exec('CREATE TABLE IF NOT EXISTS telegram_cursor(bot TEXT PRIMARY KEY, next_id INTEGER NOT NULL, updated INTEGER NOT NULL)');
  const cursor = db.prepare('SELECT next_id,updated FROM telegram_cursor WHERE bot=?');
  const advance = db.prepare('INSERT OR REPLACE INTO telegram_cursor VALUES(?,?,?)');
  // Telegram expires pending updates after 24 hours and can randomize IDs after a week idle.
  const readOffset = () => {
    const state = cursor.get(bot);
    return state && Date.now() - state.updated < 6 * 86400000 ? state.next_id : 0;
  };
  while (!signal?.aborted) {
    try {
      const updates = await api(token, 'getUpdates', {
        offset: readOffset(), timeout: 25, allowed_updates: ['message'],
      }, signal);
      for (const update of updates) {
        if (signal?.aborted) return;
        const reply = registry.atomic(() => {
          if (!Number.isSafeInteger(update.update_id)) throw new Error('Неверный номер обновления');
          if (update.update_id < readOffset()) return null;
          const result = replyFor(registry, update.message);
          advance.run(bot, update.update_id + 1, Date.now());
          return result;
        });
        if (reply) {
          try {
            await api(token, 'sendMessage', reply, signal);
          } catch {
            if (!signal?.aborted) console.error('Telelock: Telegram не подтвердил ответ на команду.');
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) return;
      if (error.status === 401 || error.status === 404) throw error;
      console.error('Telelock: получение Telegram-команд прервано, повторяю подключение.');
      const backoff = Math.max(2, error.retryAfter || 0) * 1000;
      try { await delay(backoff, undefined, { signal }); }
      catch (abort) { if (!signal?.aborted) throw abort; }
    }
  }
}
