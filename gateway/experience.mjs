import { fullAccess } from './access.mjs';

export const modeNames = { '/play_normal': 'Обычный режим', '/play_ranked': 'Ранговый режим', '/play_street': 'Уличная стычка' };
export const experience = {
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
  async preferences(owner) {
    const saved = await this.storage.get('preferences:' + owner) || {};
    return { mode: fullAccess(await this.tier(owner)) ? saved.mode || 'auto' : 'auto',
      repeat: fullAccess(await this.tier(owner)) ? saved.repeat || 0 : 0 };
  },
  async experienceRequest({action, installation, owner, generation, update, telemetry}) {
    const client = owner ? await this.storage.get('owner:' + owner) : installation;
    const binding = client && await this.storage.get('client:' + client);
    if (!binding || (owner && binding.owner !== owner) || binding.generation !== generation)
      return Response.json({error:'Привязка изменилась'}, {status:409});
    if (action === 'settings') {
      if (!fullAccess(await this.tier(binding.owner))) return Response.json({error:'Настройки доступны в полном доступе'}, {status:403});
      const change = update || telemetry || {};
      const settings = await this.preferences(binding.owner);
      if (change.mode !== undefined && !['on','off','auto'].includes(change.mode) ||
          change.repeat !== undefined && ![0,15,30,60].includes(change.repeat))
        return Response.json({error:'Неверная настройка'}, {status:400});
      if (change.mode !== undefined) settings.mode = change.mode;
      if (change.repeat !== undefined) settings.repeat = change.repeat;
      await this.storage.put('preferences:' + binding.owner, settings);
      return Response.json({settings});
    }
    if (action === 'testbot') {
      if (!fullAccess(await this.tier(binding.owner))) return Response.json({error:'Проверка доступна в полном доступе'}, {status:403});
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
  async liveStatus(client, binding) {
    const live = await this.storage.get('live:' + client + ':' + binding.generation);
    const seen = await this.storage.get('seen:' + client + ':' + binding.generation) || 0;
    const card = await this.storage.get('card:' + client + ':' + binding.generation);
    return { online: Date.now()-Math.max(live?.seen || 0,seen) < 30000,
      seen: Math.max(live?.seen || 0,seen), state: live && Date.now()-live.seen < 30000 ? live.state : 'unknown',
      since: live?.since || null, mode: card && !card.finished && modeNames[card.action] || null,
      settings: await this.preferences(binding.owner) };
  },
  async scheduleTask(key, task) {
    await this.storage.transaction(async tx => {
      await tx.put('task:' + key, task);
      if (tx.setAlarm) {
        const alarm = await tx.getAlarm();
        if (!alarm || alarm > task.at) await tx.setAlarm(task.at);
      }
    });
  },
  async createSearchCard(client, binding, item) {
    if (!this.botToken || !modeNames[item.action]) return false;
    const key = 'card:' + client + ':' + binding.generation;
    const previous = await this.storage.get(key);
    if (previous && !previous.finished) {
      try { await this.editSearchCard(client,binding.generation,'Предыдущий запрос заменён новым.',true); } catch {}
    }
    const card = {owner:binding.owner, command:item.id, action:item.action, started:Date.now(), finished:false};
    const reply_markup = fullAccess(await this.tier(binding.owner))
      ? {inline_keyboard:[[{text:'⏹ Отменить поиск',callback_data:'cancel:' + binding.generation + ':' + item.id}]]} : {inline_keyboard:[]};
    try {
      const message = await this.telegram('sendMessage', {chat_id:binding.owner,
        text:modeNames[item.action] + '\nКоманда получена. Ожидаем подтверждения поиска от игры.', reply_markup});
      if (!Number.isSafeInteger(message?.message_id)) return false;
      await this.storage.put(key,{...card,message:message.message_id,reply_markup});
      await this.scheduleTask('card:' + client + ':' + binding.generation, {kind:'card',client,generation:binding.generation,
        command:item.id,at:item.expires+5000});
      return true;
    } catch { return false; }
  },
  async editSearchCard(client, generation, text, finished = false, command) {
    const key = 'card:' + client + ':' + generation;
    const card = await this.storage.get(key);
    const binding = await this.storage.get('client:' + client);
    if (!card || binding?.generation !== generation || card.finished || command && card.command !== command) return false;
    await this.telegram('editMessageText',{chat_id:card.owner,message_id:card.message,
      text:modeNames[card.action] + '\n' + text,
      reply_markup: finished ? {inline_keyboard:[]} : card.reply_markup});
    await this.storage.put(key,{...card,finished,confirmed:true});
    return true;
  },
  async experienceAlarm() {
    const tasks = await this.storage.list({prefix:'task:'});
    for (const [key, task] of tasks) {
      if (task.at > Date.now()) continue;
      // Reserve before sending. A lost reply must not duplicate a reminder.
      await this.storage.delete(key);
      const binding = await this.storage.get('client:' + task.client);
      if (binding?.generation !== task.generation) continue;
      try {
        if (task.kind === 'card') {
          const card = await this.storage.get('card:' + task.client + ':' + task.generation);
          if (card?.command === task.command && !card.confirmed)
            await this.editSearchCard(task.client,task.generation,'Игра не подтвердила начало поиска. Проверьте связь и состояние Deadlock.',true,task.command);
        } else if (task.kind === 'repeat') {
          const settings = await this.preferences(binding.owner);
          if (settings.repeat && settings.mode !== 'off')
            await this.telegram('sendMessage',{chat_id:binding.owner,text:'🎮 Напоминание: матч найден. Возвращайся в Deadlock!'});
        }
      } catch { /* Never retry an ambiguous send. */ }
    }
    const remaining = await this.storage.list({prefix:'task:'});
    if (remaining.size) await this.storage.setAlarm(Math.min(...[...remaining.values()].map(task=>task.at)));
  },
};
