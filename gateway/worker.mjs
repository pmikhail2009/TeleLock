import { experience, modeNames } from './experience.mjs';
import { community } from './community.mjs';
import { completePairing } from './tgcloud-runtime.mjs';
import { keyboard, restrictedText } from '../serverless/tgcloud/lib/controls.js';

import { fullAccess, allowedCommand } from './access.mjs';

const encoder = new TextEncoder();
const commands = ['/play_normal', '/play_ranked', '/play_street', '/cancel', '/watch_black'];
const help = '/code — подключить Telegram\n/play_normal — обычный режим\n/play_ranked — ранговый режим\n/play_street — уличная стычка\n/cancel — отменить поиск\n/watch_black — включить наблюдение';
const resultMessages = {
  queued: '🔎 Поиск матча начат в Deadlock.',
  cancelled: '⏹ Поиск матча отменён.',
  watching: '👀 Наблюдение за найденным матчем включено.',
  already_open: 'Поиск не запущен: выбор героев уже открыт. Закройте его и отправьте команду заново.',
  failed: 'Не удалось выполнить команду в Deadlock. Проверьте доступность режима и выбранных героев.',
  unconfirmed: 'Игра не подтвердила выполнение команды. Проверьте состояние Deadlock.',
};

function allowedResult(action, status) {
  if (['/play_normal', '/play_ranked', '/play_street'].includes(action))
    return ['queued', 'already_open', 'failed', 'unconfirmed'].includes(status);
  if (action === '/cancel') return ['cancelled', 'unconfirmed'].includes(status);
  return action === '/watch_black' && status === 'watching';
}

async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class Pairing {
  constructor(state, env) {
    this.storage = state.storage;
    this.accessEnv = env;
    this.botToken = env.KATKA_BOT_TOKEN;
  }

  async tier(owner, storage = this.storage) {
    return owner ? (await storage.get('access:' + owner))?.tier || 'free' : 'free';
  }

  async commandResult(installation, generation, command, status) {
    if (typeof generation !== 'string' || !/^[a-f0-9]{32}$/.test(generation) ||
        !Number.isSafeInteger(command) || command <= 0 || typeof status !== 'string' || !Object.hasOwn(resultMessages, status))
      return Response.json({ error: 'Неверный отчёт выполнения' }, { status: 400 });
    if (!this.botToken) return Response.json({ error: 'Бот не настроен' }, { status: 503 });
    const key = 'commandResult:' + installation + ':' + generation + ':' + command;
    const reservation = await this.storage.transaction(async tx => {
      const binding = await tx.get('client:' + installation);
      if (!binding || binding.generation !== generation) return { error: 'Привязка изменилась', code: 409 };
      const saved = await tx.get(key);
      if (saved) {
        if (saved.status !== status) return { error: 'Результат уже сохранён', code: 409 };
        if (saved.delivery !== 'pending' || saved.retryAt > Date.now()) return saved;
        // Telegram explicitly rejected the previous attempt with 429, so retry is safe.
        await tx.put(key, { status, delivery: 'unknown' });
        return { owner: binding.owner };
      }
      const item = (binding.recent || []).find(item => item.id === command);
      if (!item) return { error: 'Команда не найдена', code: 404 };
      if (!allowedResult(item.action, status)) return { error: 'Результат не соответствует команде', code: 400 };
      // A delayed report is allowed after queue expiry, but not indefinitely.
      if (!Number.isSafeInteger(item.expires) || item.expires + 120000 <= Date.now())
        return { error: 'Отчёт устарел', code: 409 };
      await tx.put(key, { status, delivery: 'unknown' });
      return { owner: binding.owner };
    });
    if (reservation.error) return Response.json({ error: reservation.error }, { status: reservation.code });
    if (!reservation.owner) return Response.json({ accepted: true, ...reservation },
      { status: reservation.delivery === 'pending' ? 503 : 200 });
    let result = { status, delivery: 'unknown' };
    let editingCard = false;
    try {
      const card = await this.storage.get('card:' + installation + ':' + generation);
      const binding = await this.storage.get('client:' + installation);
      const item = binding?.recent?.find(item=>item.id === command);
      const cardCommand = item?.action === '/cancel' ? item.targetCard || command : command;
      if (card && card.command === cardCommand) {
        editingCard = true;
        if (card.finished || await this.editSearchCard(installation,generation,resultMessages[status],status !== 'queued',cardCommand)) {
          result = {status,delivery:'delivered'};
          await this.storage.put(key,result);
          return Response.json({accepted:true,...result});
        }
      }

      const response = await fetch('https://api.telegram.org/bot' + this.botToken + '/sendMessage', {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: reservation.owner, text: resultMessages[status] }),
      });
      const data = await response.json();
      if (response.ok && data.ok === true) result = { status, delivery: 'delivered' };
      else if (data.ok === false && data.error_code === response.status) {
        if (response.status === 429) {
          const seconds = data.parameters?.retry_after;
          const retryAt = Date.now() + (Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : 5000);
          result = { status, delivery: 'pending', retryAt:
            Number.isSafeInteger(retryAt) ? retryAt : Date.now() + 5000 };
        } else result = { status, delivery: 'rejected' };
      }
    } catch {
      // Repeating an edit is safe; repeating sendMessage after a lost response is not.
      if (editingCard) result = {status,delivery:'pending',retryAt:Date.now()+3000};
    }
    await this.storage.put(key, result);
    return Response.json({ accepted: true, ...result }, { status: result.delivery === 'pending' ? 503 : 200 });
  }

  async testNotification(installation, generation, receipt, elapsed) {
    if (!this.botToken) return Response.json({ error: 'Бот не настроен' }, { status: 503 });
    const binding = await this.storage.get('client:' + installation);
    if (!binding || binding.generation !== generation)
      return Response.json({ error: 'Привязка изменилась' }, { status: 409 });
    const key = 'test:' + installation;
    const started = Date.now();
    let method = 'sendMessage', message = { chat_id: binding.owner, text: '✅ Проверочное уведомление KATKA получено. Если численный замер не появился, связь с Telegram всё равно работает.' };
    let saved;
    if (receipt !== undefined) {
      if (typeof receipt !== 'string' || !/^[a-f0-9-]{36}$/.test(receipt) ||
          !Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > 120000)
        return Response.json({ error: 'Неверный замер задержки' }, { status: 400 });
      saved = await this.storage.get(key);
      if (!saved || saved.receipt !== receipt || saved.generation !== generation || saved.expires <= Date.now())
        return Response.json({ error: 'Проверочное уведомление устарело' }, { status: 409 });
      if (saved.elapsed !== undefined && saved.elapsed !== elapsed)
        return Response.json({ error: 'Замер уже сохранён' }, { status: 409 });
      method = 'editMessageText';
      message.message_id = saved.message;
      message.text = '✅ Проверка из игры: ' + elapsed + ' мс (' +
        (elapsed / 1000).toFixed(3).replace('.', ',') + ' сек) до ответа сервера. Это не время доставки push на телефон.';
    }
    try {
      const response = await fetch('https://api.telegram.org/bot' + this.botToken + '/' + method, {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message), signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      const unchanged = method === 'editMessageText' && response.status === 400 &&
        typeof data.description === 'string' && data.description.includes('message is not modified');
      if (!(response.ok && data.ok === true) && !unchanged)
        return Response.json({ error: 'Telegram не подтвердил проверочное уведомление' }, { status: 503 });
      if (method === 'sendMessage') {
        if (!Number.isSafeInteger(data.result?.message_id) || data.result.message_id <= 0)
          return Response.json({ error: 'Telegram не вернул номер уведомления' }, { status: 503 });
        const receipt = crypto.randomUUID();
        await this.storage.put(key, { receipt, message: data.result.message_id, generation, expires: Date.now() + 300000 });
        const serverElapsed = Math.max(0, Date.now()-started);
        try { await this.telegram('editMessageText', {chat_id:binding.owner,message_id:data.result.message_id,
          text:'✅ Уведомление отправлено. Telegram подтвердил запрос сервера за ' + serverElapsed + ' мс. Это не время доставки push на телефон.'}); } catch {}
        return Response.json({ delivery: 'delivered', test: receipt, serverElapsed });
      }
      await this.storage.put(key, { ...saved, elapsed });
      return Response.json({ delivery: 'delivered' });
    } catch {
      return Response.json({ error: 'Не удалось подтвердить проверочное уведомление' }, { status: 503 });
    }
  }

  async notify(action, installation, generation, match, origin) {
    if (!this.botToken) return Response.json({ error: 'Бот не настроен' }, { status: 503 });
    if (action === 'match' && (typeof match !== 'string' || !/^[1-9]\d{0,19}$/.test(match)))
      return Response.json({ error: 'Неверный номер матча' }, { status: 400 });
    if (action === 'match') {
      const binding = await this.storage.get('client:' + installation);
      if (!binding || binding.generation !== generation) return Response.json({delivery:'previous_binding'}, {status:409});
      try { await this.editSearchCard(installation,generation,'🎮 Матч найден! Возвращайся в Deadlock.',true); } catch {}
      const settings = await this.preferences(binding.owner);
      if (settings.mode === 'off' || settings.mode === 'auto' && origin === 'manual')
        return Response.json({delivery:'delivered',suppressed:true});
    }
    const key = action === 'match' ? 'match:' + installation + ':' + match
      : action === 'connected' ? 'connected:' + installation + ':' + generation : null;
    const reservation = await this.storage.transaction(async tx => {
      const binding = await tx.get('client:' + installation);
      if (!binding || binding.generation !== generation) return { delivery: 'previous_binding' };
      if (key) {
        const saved = await tx.get(key);
        if (saved && !(saved.delivery === 'pending' && saved.retryAt <= Date.now())) return saved;
        await tx.put(key, { delivery: 'unknown' });
      }
      return { owner: binding.owner };
    });
    if (!reservation.owner) return Response.json(reservation, { status: reservation.delivery === 'delivered' ? 200 : 409 });
    let result = { delivery: 'unknown' };
    try {
      const response = await fetch('https://api.telegram.org/bot' + this.botToken + '/sendMessage', {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: reservation.owner, text: action === 'match'
          ? '🎮 Матч найден! Возвращайся в Deadlock'
          : action === 'connected' ? 'Telegram подключён. Управляйте своей игрой кнопками ниже.' : 'Проверочное уведомление KATKA из Deadlock.',
          ...(action === 'connected' ? { reply_markup: keyboard(true, false, await this.tier(reservation.owner)) } : {}) }),
      });
      const data = await response.json();
      if (response.ok && data.ok === true) result = { delivery: 'delivered' };
      else if (data.ok === false && data.error_code === response.status) {
        if (response.status === 429) {
          const seconds = data.parameters?.retry_after;
          result = { delivery: 'pending', retryAt: Date.now() + 1000 * (Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 5) };
        } else if ([400,401,403,404].includes(response.status)) result = { delivery: 'rejected' };
      }
    } catch { /* A lost Telegram response can follow a successful send. */ }
    if (key) await this.storage.put(key, result);
    if (action === 'match' && result.delivery === 'delivered') {
      const settings = await this.preferences(reservation.owner);
      if (settings.repeat) await this.scheduleTask('repeat:' + installation + ':' + generation,
        {kind:'repeat',client:installation,generation,at:Date.now()+settings.repeat*1000});
    }
    return Response.json(result, { status: result.delivery === 'delivered' ? 200 : 503 });
  }

  async runForOwner(owner, operation) {
    this.operations ||= new Map();
    const previous = this.operations.get(owner) || Promise.resolve();
    const current = previous.catch(()=>{}).then(operation);
    this.operations.set(owner,current);
    try { return await current; }
    finally { if (this.operations.get(owner) === current) this.operations.delete(owner); }
  }

  async fetch(request) {
    const input = await request.clone().json();
    if (['command','result','match','telemetry','settings','test','testbot','unlink','register'].includes(input.action)) {
      const owner = input.owner || input.update?.message?.chat?.id ||
        (await this.storage.get('client:' + input.installation))?.owner;
      if (owner) return this.runForOwner(owner,()=>this.handleRequest(request));
    }
    return this.handleRequest(request);
  }

  async handleRequest(request) {
    const { action, installation, expires, generation, owner, revision, update, ack, match,
      command: commandId, status: resultStatus, test: receipt, elapsed, telemetry, origin } = await request.json();
    if (action === 'community') return this.handleCommunity(owner, update);
    if (['settings','telemetry','testbot'].includes(action)) return this.experienceRequest({action,installation,owner,generation,update,telemetry});
    if (action === 'access') {
      if (!Number.isSafeInteger(owner) || owner <= 0) return Response.json({ error: 'Неверный аккаунт' }, { status: 400 });
      const password = update?.password;
      if (!Number.isSafeInteger(update?.id) || update.id < 0 || typeof password !== 'string' || password.length > 256) return Response.json({ changed: false });
      const hash = await fingerprint(password);
      const role = hash === this.accessEnv.KATKA_OWNER_PASSWORD_HASH ? 'owner'
        : hash === this.accessEnv.KATKA_TEST_PASSWORD_HASH ? 'test' : null;
      return this.storage.transaction(async tx => {
        const lastId = await tx.get('accessMessage:' + owner);
        if (lastId !== undefined && update.id <= lastId) return Response.json({ changed: false });
        const key = 'access:' + owner;
        const current = await tx.get(key);
        const limitKey = 'accessAttempts:' + owner;
        const attempts = await tx.get(limitKey);
        if (attempts?.until > Date.now() && attempts.count >= 10)
          return Response.json({ changed: false });
        if (!role) {
          await tx.put(limitKey, { count: attempts?.until > Date.now() ? attempts.count + 1 : 1, until: attempts?.until > Date.now() ? attempts.until : Date.now() + 60000 });
          return Response.json({ changed: false });
        }
        // The personal password can belong to one account; test access is shared.
        const ownerAccount = await tx.get('accessOwner');
        if (role === 'owner' && ownerAccount && ownerAccount !== owner) return Response.json({ changed: false });
        if (role === 'owner') await tx.put('accessOwner', owner);
        const tier = current?.tier === role ? 'free' : role;
        await tx.put(key, { tier });
        await tx.put('accessMessage:' + owner, update.id);
        return Response.json({ changed: true, tier });
      });
    }
    if (action === 'test') {
      const binding = await this.storage.get('client:' + installation);
      if (!binding || binding.generation !== generation) return Response.json({ error: 'Привязка изменилась' }, { status: 409 });
      if (!fullAccess(await this.tier(binding?.owner))) return Response.json({ error: restrictedText }, { status: 403 });
      return this.testNotification(installation, generation, receipt, elapsed);
    }
    if (action === 'match' || action === 'connected') return this.notify(action, installation, generation, match, origin);
    if (action === 'result') return this.commandResult(installation, generation, commandId, resultStatus);
    if (action === 'command') {
      const chat = update?.message?.chat;
      const id = update?.id;
      if (chat?.type !== 'private' || !Number.isSafeInteger(chat.id) || chat.id <= 0 ||
          update.message.from?.id !== chat.id || !Number.isSafeInteger(id) || id < 0 ||
          typeof update.message.text !== 'string') return Response.json({ reply: null });
      const command = update.message.text.toLowerCase();
      const reply = text => Response.json({ reply: { chat_id: chat.id, text } });
      if (!commands.includes(command)) return reply(help);
      if (!allowedCommand(await this.tier(chat.id), command)) return reply(restrictedText);
      const sent = update.message.date;
      if (!Number.isSafeInteger(sent) || sent > Math.floor(Date.now()/1000) || sent * 1000 + 30000 <= Date.now())
        return reply('Команда устарела. Отправьте её ещё раз.');
      const queued = await this.storage.transaction(async tx => {
        const client = await tx.get('owner:' + chat.id);
        const binding = client && await tx.get('client:' + client);
        if (binding?.owner !== chat.id || binding.generation !== generation)
          return reply('Сначала подключите Telegram в игре командой /code.');
        if (update.expectedCommand !== undefined) {
          const card = await tx.get('card:' + client + ':' + generation);
          if (command !== '/cancel' || card?.command !== update.expectedCommand || card.finished)
            return reply('Эта кнопка относится к завершённому поиску.');
        }
        const now = Date.now();
        const recent = (binding.recent || []).filter(item => item.expires + 120000 > now);
        if (recent.some(item => item.update === id)) return Response.json({ reply: null });
        if (sent < binding.since) return reply('Привязка изменилась. Отправьте команду ещё раз.');
        const targetCard = command === '/cancel' ? (await tx.get('card:' + client + ':' + generation))?.command : undefined;
        const item = { ...(targetCard ? {targetCard} : {}), update: id, id: id + 1, action: command, expires: sent * 1000 + 30000, preparing: !!this.botToken && !!modeNames[command] };
        recent.push(item);
        await tx.put('client:' + client, { ...binding, recent });
        return {client,binding,item};
      });
      if (queued instanceof Response) return queued;
      const {client,binding,item} = queued;
      let card = await this.createSearchCard(client,binding,item);
      if (command === '/cancel' && item.targetCard) {
        try { card = await this.editSearchCard(client,generation,'Отмена запрошена. Ожидаем подтверждения игры.',false,item.targetCard); } catch {}
      }
      await this.storage.transaction(async tx => {
        const current = await tx.get('client:' + client);
        if (current?.generation !== generation) return;
        const saved = current.recent?.find(entry=>entry.id===item.id);
        if (saved) saved.preparing = false;
        await tx.put('client:' + client,current);
      });
      return card ? Response.json({reply:null}) : reply('Команда принята сервером. Ожидаем выполнения в вашей игре.');
    }
    if (action === 'poll') {
      return this.storage.transaction(async tx => {
        const key = 'client:' + installation;
        const binding = await tx.get(key);
        if (!binding) return Response.json({ generation: null, command: null });
        if (generation && binding.generation !== generation) return Response.json({ error: 'Привязка изменилась' }, { status: 409 });
        await tx.put('seen:' + installation + ':' + binding.generation,Date.now());
        const recent = binding.recent || [];
        const head = recent.find(item => !item.preparing && !item.done && item.expires > Date.now());
        if (head && generation === binding.generation && ack === head.id) {
          head.done = true;
          await tx.put(key, { ...binding, recent });
        }
        const tier = await this.tier(binding.owner, tx);
        const next = recent.find(item => !item.preparing && !item.done && item.expires > Date.now() && allowedCommand(tier, item.action));
        return Response.json({ settings: await this.preferences(binding.owner), generation: binding.generation, command: next ? { id: next.id, action: next.action, expires: next.expires } : null });
      });
    }
    if (action === 'status') {
      const client = owner ? await this.storage.get('owner:' + owner) : installation;
      const binding = client && await this.storage.get('client:' + client);
      if (owner && binding?.owner !== owner) return Response.json({ generation: null, tier: 'free' });
      return Response.json({ generation: binding?.generation ?? null, tier: await this.tier(binding?.owner),
        ...(binding ? {live:await this.liveStatus(client,binding),settings:await this.preferences(binding.owner)} : {}) });
    }
    if (action === 'unlink') {
      return this.storage.transaction(async tx => {
        const key = 'client:' + installation;
        const binding = await tx.get(key);
        if (!binding) return Response.json({ ok: true });
        if (binding.generation !== generation)
          return Response.json({ error: 'Привязка изменилась' }, { status: 409 });
        await tx.delete(key);
        await tx.delete('owner:' + binding.owner);
        return Response.json({ ok: true });
      });
    }
    if (action === 'register') {
      return this.storage.transaction(async tx => {
        // A confirmation may be retried after a lost response or a later rebind.
        const ownerVersion = await tx.get('ownerVersion:' + owner) || 0;
        const clientVersion = await tx.get('clientVersion:' + installation) || 0;
        if (revision < Math.max(ownerVersion, clientVersion)) return Response.json({ ok: false }, { status: 409 });
        if (revision === ownerVersion && revision === clientVersion) {
          const active = await tx.get('client:' + installation);
          return active?.generation === generation && active.owner === owner
            ? Response.json({ ok: true }) : Response.json({ ok: false }, { status: 409 });
        }
        const oldInstallation = await tx.get('owner:' + owner);
        if (oldInstallation && oldInstallation !== installation) await tx.delete('client:' + oldInstallation);
        const oldBinding = await tx.get('client:' + installation);
        if (oldBinding && oldBinding.owner !== owner) await tx.delete('owner:' + oldBinding.owner);
        await tx.put('client:' + installation, { owner, generation, since: Math.floor(Date.now()/1000) });
        await tx.put('owner:' + owner, installation);
        await tx.put('ownerVersion:' + owner, revision);
        await tx.put('clientVersion:' + installation, revision);
        return Response.json({ ok: true });
      });
    }
    if (action === 'wait') {
      const deadline = Date.now() + 18000;
      while (Date.now() < deadline) {
        const current = await this.storage.get('pairing');
        if (!current || current.expires <= Date.now()) return Response.json({ expired: true });
        if (current.installation) return Response.json({ installation: current.installation });
        await new Promise(resolve => setTimeout(resolve, 750));
      }
      return Response.json({ pending: true });
    }
    return this.storage.transaction(async tx => {
      const current = await tx.get('pairing');
      if (action === 'offer') {
        if (!current) {
          await tx.put('pairing', { expires, owner, installation: null });
          await tx.setAlarm(expires + 60000);
        }
        return Response.json({ ok: true });
      }
      if (!current || current.expires <= Date.now()) return Response.json({ error: 'Код неверен или истёк' }, { status: 400 });
      if (action === 'inspect') return Response.json({ installation: current.installation });
      if (action === 'confirm') {
        if (!current.installation || current.installation !== installation ||
            (current.generation && current.generation !== generation)) {
          return Response.json({ error: 'Привязка изменилась' }, { status: 409 });
        }
        await tx.put('pairing', { ...current, generation });
        return Response.json({ ok: true });
      }
      if (current.installation && current.installation !== installation) {
        return Response.json({ error: 'Код уже использован' }, { status: 409 });
      }
      if (current.generation) return Response.json({ generation: current.generation });
      if (!current.installation) await tx.put('pairing', { ...current, installation });
      return Response.json({ pending: true, owner: current.owner }, { status: 202 });
    });
  }

  async alarm() {
    if (await this.storage.get('pairing')) await this.storage.delete('pairing');
    else await this.experienceAlarm();
  }
}

Object.assign(Pairing.prototype, experience, community);

export default {
  async fetch(request, env) {
    const panelOrigin = env.KATKA_PANEL_ORIGIN;
    const path = new URL(request.url).pathname;
    const game = ['/pairing/claim','/v1/bind','/v1/status','/v1/poll','/v1/match','/v1/test','/v1/unlink','/v1/result','/v1/telemetry','/v1/settings'].includes(path);
    const actions = { '/service/community':'community', '/service/settings':'settings', '/service/testbot':'testbot', '/service/access': 'access', '/service/status': 'status', '/service/command': 'command', '/service/offer': 'offer', '/service/inspect': 'inspect', '/service/confirm': 'confirm', '/service/wait': 'wait' };
    if (!game && !Object.hasOwn(actions, path)) return new Response(null, { status: 404 });
    const headers = {};
    if (game && request.headers.get('Origin') === panelOrigin) {
      headers['Access-Control-Allow-Origin'] = panelOrigin;
      headers['Access-Control-Allow-Methods'] = 'POST';
      headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
      headers.Vary = 'Origin';
    }
    headers['Cache-Control'] = 'no-store';
    if (request.method === 'OPTIONS' && headers.Vary) return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers });
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') || '')?.[1];
    if (!token || (!game && token !== env.KATKA_CLOUD_SECRET)) return new Response(null, { status: 403, headers });
    let body;
    try { body = await request.json(); } catch { return new Response(null, { status: 400, headers }); }
    const directory = () => env.PAIRINGS.get(env.PAIRINGS.idFromName('bindings'));
    if (path === '/service/community' && (!Number.isSafeInteger(body?.owner) || body.owner <= 0))
      return new Response(null, { status: 400, headers });
    if (['/service/community','/v1/status','/v1/poll','/v1/match','/v1/test','/v1/unlink','/v1/result','/service/command','/service/status','/service/access','/service/settings','/service/testbot','/v1/telemetry','/v1/settings'].includes(path)) {
      if (path === '/service/status' && body?.owner !== undefined &&
          (!Number.isSafeInteger(body.owner) || body.owner <= 0)) return new Response(null, { status: 400, headers });
      const action = path.split('/').pop();
      const reply = await directory().fetch('https://pairing.internal/', {
        method: 'POST', body: JSON.stringify({ action, installation: path === '/service/status' ? body?.installation : await fingerprint(token),
          owner: ['/service/community','/service/status','/service/access','/service/settings','/service/testbot'].includes(path) ? body?.owner : undefined,
          generation: body?.generation, ack: body?.ack, match: body?.match,
          command: body?.command, status: body?.status, test: body?.test, elapsed: body?.elapsed,
          telemetry: game ? body?.telemetry : undefined, origin: body?.origin,
          update: game ? undefined : body }),
      });
      return new Response(reply.body, { status: reply.status, headers: { ...headers, 'Content-Type': 'application/json' } });
    }
    if (typeof body?.code !== 'string' || !/^[A-F0-9]{16}$/.test(body.code)) return new Response(null, { status: 400, headers });
    if (path === '/service/offer' && (!Number.isSafeInteger(body.owner) || body.owner <= 0 || !Number.isSafeInteger(body.expires) ||
        body.expires <= Date.now() || body.expires > Date.now() + 660000)) return new Response(null, { status: 400, headers });
    if (path === '/service/confirm' && (
      !Number.isSafeInteger(body.owner) || body.owner <= 0 ||
      !Number.isSafeInteger(body.revision) || body.revision <= 0 ||
      typeof body.installation !== 'string' || !/^[a-f0-9]{64}$/.test(body.installation) ||
      typeof body.generation !== 'string' || !/^[a-f0-9]{32}$/.test(body.generation)
    )) return new Response(null, { status: 400, headers });
    const id = env.PAIRINGS.idFromName(await fingerprint(body.code));
    const pairing = env.PAIRINGS.get(id);
    let reply = await pairing.fetch('https://pairing.internal/', {
      method: 'POST', body: JSON.stringify({ action: game ? 'claim' : actions[path],
        expires: path === '/service/offer' ? Math.min(body.expires, Date.now() + 600000) : body.expires,
        owner: body.owner, installation: game ? await fingerprint(token) : body.installation, generation: body.generation }),
    });
    if (game && reply.status === 202) {
      const claim = await reply.json();
      if (!Number.isSafeInteger(claim.owner) || claim.owner <= 0)
        return Response.json({ error: 'Получите новый код в Telegram' }, { status: 400, headers });
      const installation = await fingerprint(token);
      let binding;
      try {
        binding = await completePairing(env.KATKA_APP_TOKEN, claim.owner, body.code, installation);
      } catch {
        return Response.json({ error: 'Не удалось подтвердить привязку в Telegram. Повторите подключение.' }, { status: 503, headers });
      }
      const stored = await directory().fetch('https://pairing.internal/', {
        method: 'POST', body: JSON.stringify({ action: 'register', owner: claim.owner, installation,
          generation: binding.generation, revision: binding.revision }),
      });
      if (!stored.ok) return Response.json({ error: 'Привязка изменилась' }, { status: 409, headers });
      const confirmed = await pairing.fetch('https://pairing.internal/', {
        method: 'POST', body: JSON.stringify({ action: 'confirm', installation, generation: binding.generation }),
      });
      if (!confirmed.ok) return Response.json({ error: 'Код истёк. Получите новый код в Telegram.' }, { status: 400, headers });
      await directory().fetch('https://pairing.internal/', {
        method: 'POST', body: JSON.stringify({ action: 'connected', installation, generation: binding.generation }),
      });
      return Response.json({ generation: binding.generation }, { headers });
    }
    if (path === '/service/confirm' && reply.ok) {
      const stored = await directory().fetch('https://pairing.internal/', {
        method: 'POST', body: JSON.stringify({ action: 'register', owner: body.owner,
          installation: body.installation, generation: body.generation, revision: body.revision }),
      });
      if (!stored.ok) return Response.json({ error: 'Привязка изменилась' }, { status: stored.status, headers });
    }
    if (game && reply.status === 200) {
      const result = await reply.json();
      const current = await directory().fetch('https://pairing.internal/', {
        method: 'POST', body: JSON.stringify({ action: 'status', installation: await fingerprint(token) }),
      });
      if (!current.ok) return new Response(null, { status: 503, headers });
      const binding = await current.json();
      if (binding.generation !== result.generation) return Response.json({ pending: true }, { status: 202, headers });
      return Response.json(result, { headers });
    }
    return new Response(reply.body, { status: reply.status, headers: { ...headers, 'Content-Type': 'application/json' } });
  },
};
