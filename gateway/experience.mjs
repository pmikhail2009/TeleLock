import { fullAccess } from './access.mjs';
import { currentLanguage, keyboard, localize, languageChanged, modeNames } from '../serverless/tgcloud/lib/controls.js';

export const experience = {
  async language(owner) {
    return currentLanguage(owner && await this.storage.get('language:' + owner));
  },
  async changeLanguage({ installation, owner, generation, language }) {
    if (!['en', 'ru'].includes(language))
      return Response.json({ error: 'Invalid language' }, { status: 400 });
    const result = await this.storage.transaction(async tx => {
      const binding = owner ? null : await tx.get('client:' + installation);
      if (!owner && (!binding || binding.generation !== generation)) return null;
      const account = owner || binding.owner;
      const key = 'language:' + account;
      if (currentLanguage(await tx.get(key)) === language) return { account, changed: false };
      await tx.put(key, language);
      return { account, changed: true };
    });
    if (!result) return Response.json({ error: 'Connection changed' }, { status: 409 });
    if (result.changed && this.botToken) {
      const account = result.account;
      const notification = this.runForOwner('language:' + account, async () => {
        if (await this.language(account) !== language) return;
        const client = await this.storage.get('owner:' + account);
        const binding = client && await this.storage.get('client:' + client);
        await this.telegram('sendMessage', { chat_id: account, text: languageChanged(language),
          reply_markup: keyboard(binding?.owner === account, 'home', await this.tier(account), language) });
      }).catch(() => { /* The saved language remains available from either client. */ });
      this.state.waitUntil(notification);
    }
    return Response.json({ language });
  },
  async telegram(method, body) {
    const response = await fetch('https://api.telegram.org/bot' + this.botToken + '/' + method, {
      method: 'POST', redirect: 'manual', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (method === 'editMessageText' && data.description?.includes('message is not modified')) return {};
    if (!response.ok || data.ok !== true) throw new Error('Telegram не подтвердил запрос');
    return data.result;
  },
  async preferences(owner, tier) {
    const saved = await this.storage.get('preferences:' + owner) || {};
    const enabled = fullAccess(tier ?? await this.tier(owner));
    return { mode: enabled ? saved.mode || 'auto' : 'auto', repeat: enabled ? saved.repeat || 0 : 0 };
  },
  async experienceRequest({action, installation, owner, generation, update, telemetry}) {
    const client = owner ? await this.storage.get('owner:' + owner) : installation;
    const binding = client && await this.storage.get('client:' + client);
    if (!binding || (owner && binding.owner !== owner) || binding.generation !== generation)
      return Response.json({error:'Привязка изменилась'}, {status:409});
    if (action === 'settings') {
      const language = await this.language(binding.owner);
      const t = (en, ru) => localize(language, en, ru);
      if (!fullAccess(await this.tier(binding.owner))) return Response.json({error:t('Settings require full access.', 'Настройки доступны в полном доступе')}, {status:403});
      const change = update || telemetry || {};
      const settings = await this.preferences(binding.owner);
      if (change.mode !== undefined && !['on','off','auto'].includes(change.mode) ||
          change.repeat !== undefined && ![0,15,30,60].includes(change.repeat))
        return Response.json({error:t('Invalid setting.', 'Неверная настройка')}, {status:400});
      if (change.mode !== undefined) settings.mode = change.mode;
      if (change.repeat !== undefined) settings.repeat = change.repeat;
      await this.storage.put('preferences:' + binding.owner, settings);
      return Response.json({settings,language});
    }
    if (action === 'testbot') {
      if (!fullAccess(await this.tier(binding.owner))) return Response.json({error:localize(await this.language(binding.owner),
        'Test notifications require full access.', 'Проверка доступна в полном доступе')}, {status:403});
      return this.testNotification(client, generation);
    }
    if (action === 'telemetry') {
      if (!telemetry || !['waiting','idle','party','connecting','unknown'].includes(telemetry.state) ||
          !Number.isSafeInteger(telemetry.observed) || Math.abs(Date.now()-telemetry.observed)>15000)
        return Response.json({error:'Устаревшее состояние'}, {status:400});
      const key = 'live:' + client + ':' + generation;
      const previous = await this.storage.get(key) || {};
      if ((previous.observed || 0) >= telemetry.observed) return Response.json({ok:true});
      const now = Date.now();
      await this.storage.put(key, {state:telemetry.state, observed:telemetry.observed, seen:now,
        since: previous.state === telemetry.state && now-previous.seen < 30000 ? previous.since : now});
      return Response.json({ok:true});
    }
    return Response.json({error:'Неизвестное действие'}, {status:400});
  },
  async liveStatus(client, binding, language) {
    const live = await this.storage.get('live:' + client + ':' + binding.generation);
    const seen = await this.storage.get('seen:' + client + ':' + binding.generation) || 0;
    const card = await this.storage.get('card:' + client + ':' + binding.generation);
    return { online: Date.now()-Math.max(live?.seen || 0,seen) < 30000,
      seen: Math.max(live?.seen || 0,seen), state: live && Date.now()-live.seen < 30000 ? live.state : 'unknown',
      since: live?.since || null, mode: card && !card.finished ? modeNames(language)[card.action] : null,
      settings: await this.preferences(binding.owner) };
  },
  async scheduleTask(key, task) {
    await this.storage.transaction(tx => this.storeTask(tx, key, task));
  },
  async storeTask(storage, key, task) {
    await storage.put('task:' + key, task);
    if (storage.setAlarm) {
      const alarm = await storage.getAlarm();
      if (!alarm || alarm > task.at) await storage.setAlarm(task.at);
    }
  },
  async createSearchCard(client, binding, item) {
    const language = await this.language(binding.owner);
    const t = (en, ru) => localize(language, en, ru);
    if (!this.botToken || !modeNames(language)[item.action]) return false;
    const key = 'card:' + client + ':' + binding.generation;
    const previous = await this.storage.get(key);
    if (previous && !previous.finished) {
      try { await this.editSearchCard(client,binding.generation,t('A new search replaced this request.', 'Предыдущий запрос заменён новым.'),true); } catch {}
    }
    const card = {owner:binding.owner, command:item.id, action:item.action, started:Date.now(), finished:false};
    try {
      const message = await this.telegram('sendMessage', {chat_id:binding.owner,
        text:modeNames(language)[item.action] + t('\nRequest received. Waiting for the game to confirm matchmaking.',
          '\nКоманда получена. Ожидаем подтверждения поиска от игры.'),
        reply_markup: await this.searchCardKeyboard(card, binding.generation, language)});
      if (!Number.isSafeInteger(message?.message_id)) return false;
      await this.storage.put(key,{...card,message:message.message_id});
      await this.scheduleTask('card:' + client + ':' + binding.generation, {kind:'card',client,generation:binding.generation,
        command:item.id,at:item.expires+5000});
      return true;
    } catch { return false; }
  },
  async searchCardKeyboard(card, generation, language) {
    return { inline_keyboard: fullAccess(await this.tier(card.owner))
      ? [[{ text:localize(language,'⏹ Cancel search','⏹ Отменить поиск'),callback_data:'cancel:' + generation + ':' + card.command }]]
      : [] };
  },
  async editSearchCard(client, generation, text, finished = false, command) {
    const key = 'card:' + client + ':' + generation;
    const card = await this.storage.get(key);
    const binding = await this.storage.get('client:' + client);
    if (!card || binding?.generation !== generation || card.finished || command && card.command !== command) return false;
    const language = await this.language(card.owner);
    await this.telegram('editMessageText',{chat_id:card.owner,message_id:card.message,
      text:modeNames(language)[card.action] + '\n' + text,
      reply_markup: finished ? {inline_keyboard:[]} : await this.searchCardKeyboard(card,generation,language)});
    await this.storage.put(key,{...card,finished,confirmed:true});
    return true;
  },
  async experienceAlarm() {
    const tasks = await this.storage.list({prefix:'task:'});
    for (const [key, task] of tasks) {
      if (task.at > Date.now()) continue;
      // Reserve before sending. A lost reply must not duplicate a reminder.
      await this.storage.delete(key);
      try {
        if (task.kind === 'feedback') {
          await this.requestFeedback(task.owner);
          continue;
        }
        const binding = await this.storage.get('client:' + task.client);
        if (binding?.generation !== task.generation) continue;
        const language = await this.language(binding.owner);
        const t = (en, ru) => localize(language, en, ru);
        if (task.kind === 'card') {
          const card = await this.storage.get('card:' + task.client + ':' + task.generation);
          if (card?.command === task.command && !card.confirmed)
            await this.editSearchCard(task.client,task.generation,t('The game did not confirm matchmaking. Check the connection and Deadlock.',
              'Игра не подтвердила начало поиска. Проверьте связь и состояние Deadlock.'),true,task.command);
        } else if (task.kind === 'repeat') {
          const settings = await this.preferences(binding.owner);
          if (settings.repeat && settings.mode !== 'off')
            await this.telegram('sendMessage',{chat_id:binding.owner,text:t('🎮 Reminder: match found. Return to Deadlock!',
              '🎮 Напоминание: матч найден. Возвращайся в Deadlock!')});
        }
      } catch { /* Never retry an ambiguous send. */ }
    }
    const remaining = await this.storage.list({prefix:'task:'});
    if (remaining.size) await this.storage.setAlarm(Math.min(...[...remaining.values()].map(task=>task.at)));
  },
};
