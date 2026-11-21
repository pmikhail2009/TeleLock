export const labels = {
  community: '👥 Центр сообщества Telelock',
  modes: '🎮 Выбрать режим',
  watch: '👀 Включить наблюдение',
  cancel: '⏹ Отменить поиск',
  status: '📡 Что сейчас?',
  settings: '⚙️ Оповещения',
  help: '❓ Справка',
  code: '🔑 Новый код',
  normal: '▶️ Обычный поиск',
  ranked: '▶️ Ранговый поиск',
  street: '▶️ Уличная стычка',
  back: '↩️ Управление',
};

export function keyboard(linked, modes = false, tier = 'free') {
  return {
    keyboard: !linked ? [[labels.code, labels.help], [labels.community]] : modes
      ? [[labels.normal], [labels.ranked], [labels.street], [labels.back]]
      : tier === 'owner' || tier === 'test'
        ? [[labels.modes, labels.watch], [labels.cancel, labels.status], [labels.settings], [labels.help, labels.code], [labels.community]]
        : [[labels.modes], [labels.help, labels.code], [labels.community]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: linked ? 'Управление вашей игрой' : 'Получите код и подключите игру',
  };
}

export function commandFor(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  const buttons = {
    [labels.community]: '/community',
    [labels.settings]: '/settings', ['📡 Статус подключения']: '/status', [labels.modes]: '/modes', [labels.watch]: '/watch_black',
    [labels.cancel]: '/cancel', [labels.status]: '/status',
    [labels.help]: '/help', [labels.code]: '/code',
    [labels.normal]: '/play_normal', [labels.ranked]: '/play_ranked',
    [labels.street]: '/play_street', [labels.back]: '/menu',
  };
  if (Object.hasOwn(buttons, value)) return buttons[value];
  if (!value.startsWith('/')) return null;
  return value.split(/\s+/, 1)[0].split('@', 1)[0].toLowerCase();
}

export const helpText = [
  'KATKA — управление вашей подключённой игрой.',
  'Оповещения в меню KATKA: ВКЛ — для любого найденного матча; ВЫКЛ — отключены; Авто — только при запуске поиска через бота. Режим сохраняется.',
  '«Выбрать режим» открывает меню. Кнопка с ▶️ сразу запускает поиск выбранного режима.',
  'Ранговый поиск и «Уличная стычка» работают, когда они доступны в меню игры.',
  '«Включить наблюдение» возобновляет наблюдение. Оповещения зависят от режима в моде; в Авто нужен запуск поиска через бота.',
  '«Отменить поиск» отменяет поиск и останавливает наблюдение.',
  '«Что сейчас?» показывает связь с игрой и последнее подтверждённое состояние очереди.',
  '«Оповещения» — ВКЛ / ВЫКЛ / Авто, проверка и одно повторное напоминание через 15, 30 или 60 секунд.',
  '/code — новый код для подключения через меню Esc.',
  '/menu — показать кнопки управления.',
].join('\n');

export const restrictedText = 'Эта функция недоступна в бесплатной версии. Доступны запуск матчей и уведомления в режиме Авто.';
export const freeHelpText = 'KATKA: запускайте матчи кнопками выбора режима и получайте уведомления в Telegram. Оповещения всегда в режиме Авто: для поиска, запущенного через бота. /code — подключение, /menu — кнопки управления.';

export function statusText(live) {
  if (!live?.online) return 'Telegram подключён. Игра сейчас не отвечает. Последнее состояние может быть устаревшим.';
  const states = {waiting:'🔎 Идёт поиск матча',idle:'Поиск не идёт',party:'Ожидаем готовности группы',connecting:'Подключение к матчу',unknown:'Состояние очереди пока неизвестно'};
  let text = '🟢 Игра на связи.\n' + (states[live.state] || states.unknown);
  if (live.state === 'waiting' && live.since) {
    const seconds = Math.max(0,Math.floor((Date.now()-live.since)/1000));
    text += ' · ' + Math.floor(seconds/60) + ':' + String(seconds%60).padStart(2,'0');
  }
  if (live.state === 'waiting' && live.mode) text += '\nПоследний запрошенный режим: ' + live.mode;
  return text;
}
export function settingsMessage(settings = {}, generation) {
  const names = {on:'ВКЛ',off:'ВЫКЛ',auto:'Авто'};
  return {text:'⚙️ Оповещения: ' + (names[settings.mode] || 'Авто') +
    '\nВКЛ — любой найденный матч; ВЫКЛ — без оповещений; Авто — поиск через бота.' +
    '\nПовторное напоминание: ' + (settings.repeat ? 'через ' + settings.repeat + ' сек' : 'выключено') +
    '\nИзменения сохраняются и применяются в игре при следующем обмене с сервером.',
    reply_markup:{inline_keyboard:[
      ['on','off','auto'].map(mode=>({text:names[mode],callback_data:'mode:' + generation + ':' + mode})),
      [0,15,30,60].map(seconds=>({text:seconds ? seconds + ' сек' : 'Без повтора',callback_data:'repeat:' + generation + ':' + seconds})),
      [{text:'🔔 Проверить уведомление',callback_data:'test:' + generation}],
    ]}};
}
