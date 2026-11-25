export const currentLanguage = value => value === 'ru' ? 'ru' : 'en';
export const localize = (language, en, ru) => currentLanguage(language) === 'ru' ? ru : en;
export const languageChanged = language => localize(language, 'Language set to English.', 'Выбран русский язык.');

const russianLabels = {
  play: '🎮 Играть',
  control: '⚙️ Центр управления',
  pro: '⭐ Перейти на Pro',
  modes: '🎮 Выбрать режим',
  watch: '👀 Включить наблюдение',
  cancel: '⏹ Отменить поиск',
  settings: '⚙️ Оповещения',
  help: '❓ Справка',
  code: '🔑 Новый код',
  normal: '▶️ Обычный',
  ranked: '▶️ Ранговый',
  street: '▶️ Уличная стычка',
  back: '↩️ Назад',
  language: '🌐 Язык',
  feedback: '💬 Оставить отзыв',
  reviews: '⭐ Оценки и отзывы',
  stats: '📊 Статистика Telelock',
};

export const labels = {
  play: '🎮 Play',
  control: '⚙️ Control Center',
  pro: '⭐ Upgrade to Pro',
  modes: '🎮 Choose mode',
  watch: '👀 Enable monitoring',
  cancel: '⏹ Cancel search',
  settings: '⚙️ Notifications',
  help: '❓ Help',
  code: '🔑 New code',
  normal: '▶️ Normal',
  ranked: '▶️ Ranked',
  street: '▶️ Street Brawl',
  back: '↩️ Back',
  language: '🌐 Language',
  feedback: '💬 Give feedback',
  reviews: '⭐ Ratings and reviews',
  stats: '📊 Telelock statistics',
};

export const staffAccess = tier => tier === 'owner' || tier === 'test';
export const fullAccess = tier => staffAccess(tier) || tier === 'pro';
export const staffMenu = tier => tier === 'owner' ? 'admin' : tier === 'test' ? 'test' : null;

export function keyboard(linked, section = 'home', tier = 'free', language = 'en') {
  const buttons = localize(language, labels, russianLabels);
  const role = staffMenu(tier);
  let rows = [[buttons.play, buttons.control], [buttons.pro]];
  if (role) rows.push([role]);
  if (section === 'staff' && role) {
    rows = [[buttons.reviews], [buttons.back]];
    if (tier === 'owner') rows.unshift([buttons.stats]);
  }
  if (section === 'play') {
    rows = [];
    if (linked) {
      const modes = [buttons.normal, buttons.ranked];
      if (fullAccess(tier)) rows.push([...modes, buttons.street], [buttons.cancel, buttons.watch]);
      else rows.push(modes, [buttons.street]);
    }
    rows.push([buttons.back]);
  }
  if (section === 'control') {
    rows = [[buttons.language, buttons.code]];
    if (linked && fullAccess(tier)) rows.push([buttons.settings]);
    rows.push([buttons.feedback], [buttons.help, buttons.back]);
  }
  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: linked ? localize(language, 'Control your game', 'Управление вашей игрой')
      : localize(language, 'Get a code to connect your game', 'Получите код и подключите игру'),
  };
}

const buttonCommands = {
  play: '/play', control: '/control', pro: '/pro',
  settings: '/settings', modes: '/modes', watch: '/watch_black', cancel: '/cancel',
  help: '/help', code: '/code', normal: '/play_normal',
  ranked: '/play_ranked', street: '/play_street', back: '/menu', language: '/language',
  feedback: '/feedback', reviews: '/reviews', stats: '/stats',
};
const buttons = Object.fromEntries(Object.entries(buttonCommands).flatMap(([key, command]) =>
  [[labels[key], command], [russianLabels[key], command]]));
buttons['📡 Статус подключения'] = '/status';
buttons['📡 Что сейчас?'] = '/status';
buttons['📡 Game status'] = '/status';
buttons['▶️ Обычный поиск'] = '/play_normal';
buttons['▶️ Ранговый поиск'] = '/play_ranked';
buttons['▶️ Normal matchmaking'] = '/play_normal';
buttons['▶️ Ranked matchmaking'] = '/play_ranked';
buttons['↩️ Управление'] = '/menu';
buttons['↩️ Main menu'] = '/menu';
buttons.admin = '/admin_menu';
buttons.test = '/test_menu';

export function commandFor(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (Object.hasOwn(buttons, value)) return buttons[value];
  if (!value.startsWith('/')) return null;
  return value.split(/\s+/, 1)[0].split('@', 1)[0].toLowerCase();
}

const russianHelp = [
  'Telelock — управление вашей подключённой игрой.',
  'Оповещения в меню Telelock: ВКЛ — для любого найденного матча; ВЫКЛ — отключены; Авто — только при запуске поиска через бота. Режим сохраняется.',
  'В разделе «Играть» кнопка с ▶️ сразу запускает поиск выбранного режима.',
  'Ранговый поиск и «Уличная стычка» работают, когда они доступны в меню игры.',
  '«Включить наблюдение» возобновляет наблюдение. Оповещения зависят от режима в моде; в Авто нужен запуск поиска через бота.',
  '«Отменить поиск» отменяет поиск и останавливает наблюдение.',
  '/status показывает связь с игрой и последнее подтверждённое состояние очереди.',
  'В центре управления доступны подключение, язык и оповещения. В оповещениях можно выбрать режим, отправить проверку и настроить повторное напоминание.',
  '/code — новый код для подключения через меню Esc.',
  '/menu — показать кнопки управления.',
  '«Язык» — изменить язык Telelock в Telegram и игре.',
  '/feedback — оценить Telelock или оставить отзыв.',
].join('\n');

export const helpText = language => localize(language, [
  'Telelock lets you control your connected game.',
  'Open Play and choose a mode to start matchmaking. Ranked and Street Brawl depend on availability in Deadlock.',
  'Enable monitoring resumes match detection. Cancel search stops matchmaking and monitoring.',
  '/status shows whether the game is reachable and the last confirmed queue state.',
  'Open Control Center to manage your connection, language and notifications. Notifications lets you choose On, Off or Auto, send a test and set one reminder after 15, 30 or 60 seconds.',
  '/feedback — rate Telelock or leave a written review.',
  '/code — connect via the Esc menu. /menu — show the controls.',
].join('\n'), russianHelp);

export const restrictedText = language => localize(language,
  'This feature requires Telelock Pro. The free version supports starting matchmaking and Auto notifications. Use /pro to see the offer.',
  'Эта функция недоступна в бесплатной версии. Доступны запуск матчей и уведомления в режиме Авто.');

export function statsText({ language, denied, connected, launched }) {
  const t = (en, ru) => localize(language, en, ru);
  if (denied) return t('Statistics are available in admin mode.', 'Статистика доступна в режиме admin.');
  return [
    t('📊 Telelock · all-time users', '📊 Telelock · пользователи за всё время'),
    t('Connected Deadlock to Telegram: ', 'Подключили Deadlock к Telegram: ') + connected,
    t('Started matchmaking through the bot: ', 'Запустили поиск через бота: ') + launched,
    t('Each Telegram account is counted once per line.', 'Каждый аккаунт Telegram считается один раз в каждой строке.'),
  ].join('\n');
}

export const freeHelpText = language => localize(language,
  'Open Play to start matchmaking and get Telegram notifications for searches started through the bot. Open Control Center to connect your game, change the language or leave feedback. Use /pro to see the Pro offer.',
  'Откройте «Играть», чтобы запустить поиск и получать уведомления о матчах. В центре управления можно подключить игру, сменить язык или оставить отзыв. Команда /pro открывает предложение Pro.');

export function proMessage(language) {
  return {
    text: localize(language,
      'Telelock Pro unlocks game status, search cancellation, match monitoring and notification settings.',
      'Telelock Pro открывает статус игры, отмену поиска, наблюдение и настройки уведомлений.'),
    reply_markup: { inline_keyboard: [[{
      text: localize(language, 'Continue to payment', 'Перейти к оплате'),
      callback_data: 'pro:pay',
    }]] },
  };
}

export function proPaymentMessage({ language, state }) {
  const t = (en, ru) => localize(language, en, ru);
  const messages = {
    granted: t('Enjoy 7 days of Telelock Pro for free!', 'Дарим 7 дней Telelock Pro бесплатно!'),
    active: t('Your free 7-day Telelock Pro trial is already active.', 'Ваш бесплатный семидневный пробный период Telelock Pro уже активен.'),
    expired: t('Your free Telelock Pro trial has ended.', 'Ваш пробный период Telelock Pro закончился.'),
    staff: t('You already have access to all Pro features.', 'У вас уже есть доступ ко всем функциям Pro.'),
  };
  return t('Payments aren’t available yet.', 'Оплата пока недоступна.') + ' ' + messages[state];
}

export const feedbackMaxLength = 1000;
export const feedbackPrompt = language => localize(language,
  'Reply to this message with your feedback about Telelock (up to 1,000 characters).',
  'Ответьте на это сообщение, чтобы оставить отзыв о Telelock (до 1000 символов).');
export const feedbackThanks = language => localize(language,
  'Thank you for sharing your feedback! It helps me make Telelock better. ❤️',
  'Спасибо за отзыв! Он помогает мне сделать Telelock лучше. ❤️');

const writeFeedbackButton = language => ({
  text: localize(language, '✍️ Write a review', '✍️ Написать отзыв'),
  callback_data: 'feedback:write',
});

export function feedbackMessage(language, rating) {
  if (rating) return {
    text: localize(language, `Thank you for rating Telelock ${rating}/5! Your opinion means a lot to me. ❤️`,
      `Спасибо за оценку ${rating}/5! Мне очень важно ваше мнение. ❤️`),
    reply_markup: { inline_keyboard: [[writeFeedbackButton(language)]] },
  };
  return {
    text: localize(language,
      'Rate Telelock from 1 to 5.\n\nI’m Mikhail, and this is the project I’m working on!\nYour opinion means a lot to me. It will help me improve Telelock and make my project better. I’d be grateful for any feedback! ❤️',
      'Оцените сервис от 1 до 5.\n\nЯ Михаил, и это проект, над которым я работаю!\nМне очень важно ваше мнение. Оно поможет мне улучшить Telelock и мой проект. Буду очень рад и благодарен каждому отзыву! ❤️'),
    reply_markup: { inline_keyboard: [
      [1, 2, 3, 4, 5].map(value => ({ text: String(value), callback_data: 'feedback:rate:' + value })),
      [writeFeedbackButton(language)],
    ] },
  };
}

export function feedbackReply(language) {
  return { text: feedbackPrompt(language), reply_markup: { force_reply: true } };
}

export function reviewsMessage({ language, counts, texts, next, denied }) {
  const t = (en, ru) => localize(language, en, ru);
  if (denied) return { text: t('Viewing ratings requires test or admin access.',
    'Для просмотра оценок нужен тестовый или админ-доступ.') };
  const total = counts.reduce((sum, count) => sum + count, 0);
  const average = total ? counts.reduce((sum, count, index) => sum + count * (index + 1), 0) / total : null;
  const summary = [
    t('⭐ Telelock ratings', '⭐ Оценки Telelock'),
    t('Ratings received ', 'Получено оценок ') + total,
    t('Average ', 'Средняя оценка ') + (average === null ? '—' : average.toFixed(2).replace('.', t('.', ',')) + ' / 5'),
    counts.map((count, index) => (index + 1) + '★ ' + count).join('   ·   '),
    '',
    t('Written reviews', 'Текстовые отзывы'),
    ...(texts.length ? texts.map(text => '• ' + text) : [t('No written reviews yet.', 'Текстовых отзывов пока нет.')]),
  ];
  return { text: summary.join('\n'), link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: next ? [[
    {text:t('More reviews', 'Ещё отзывы'),callback_data:'feedback:list:' + next},
  ]] : [] } };
}

export function languageMessage(language) {
  return {
    text: localize(language, 'Choose the Telelock language.', 'Выберите язык Telelock.'),
    reply_markup: { inline_keyboard: [[
      { text: (language === 'en' ? '✓ ' : '') + 'English', callback_data: 'language:en' },
      { text: (language === 'ru' ? '✓ ' : '') + 'Русский', callback_data: 'language:ru' },
    ]] },
  };
}

export const modeNames = language => localize(language,
  { '/play_normal': 'Normal matchmaking', '/play_ranked': 'Ranked matchmaking', '/play_street': 'Street Brawl' },
  { '/play_normal': 'Обычный режим', '/play_ranked': 'Ранговый режим', '/play_street': 'Уличная стычка' });

export function statusText(live, language) {
  const t = (en, ru) => localize(language, en, ru);
  if (!live?.online) return t('Telegram is connected. The game is currently unreachable. The last known state may be outdated.',
    'Telegram подключён. Игра сейчас не отвечает. Последнее состояние может быть устаревшим.');
  const states = t({waiting:'🔎 Finding a match',idle:'No active search',party:'Waiting for the party',connecting:'Connecting to a match',unknown:'Queue state is unknown'},
    {waiting:'🔎 Идёт поиск матча',idle:'Поиск не идёт',party:'Ожидаем готовности группы',connecting:'Подключение к матчу',unknown:'Состояние очереди пока неизвестно'});
  let text = t('🟢 Game online.\n', '🟢 Игра на связи.\n') + (states[live.state] || states.unknown);
  if (live.state === 'waiting' && live.since) {
    const seconds = Math.max(0,Math.floor((Date.now()-live.since)/1000));
    text += ' · ' + Math.floor(seconds/60) + ':' + String(seconds%60).padStart(2,'0');
  }
  if (live.state === 'waiting' && live.mode)
    text += t('\nLast requested mode: ', '\nПоследний запрошенный режим: ') + live.mode;
  return text;
}
export function settingsMessage(settings = {}, generation, language) {
  const t = (en, ru) => localize(language, en, ru);
  const names = t({on:'On',off:'Off',auto:'Auto'}, {on:'ВКЛ',off:'ВЫКЛ',auto:'Авто'});
  const secondsLabel = seconds => seconds + t(' sec', ' сек');
  return {text:t('⚙️ Notifications: ', '⚙️ Оповещения: ') + (names[settings.mode] || names.auto) +
    t('\nOn: every match found. Off: no alerts. Auto: searches started through the bot.',
      '\nВКЛ — любой найденный матч; ВЫКЛ — без оповещений; Авто — поиск через бота.') +
    t('\nRepeat reminder: ', '\nПовторное напоминание: ') +
    (settings.repeat ? t('after ', 'через ') + secondsLabel(settings.repeat) : t('off', 'выключено')) +
    t('\nChanges sync with the game.', '\nИзменения синхронизируются с игрой.'),
    reply_markup:{inline_keyboard:[
      ['on','off','auto'].map(mode=>({text:names[mode],callback_data:'mode:' + generation + ':' + mode})),
      [0,15,30,60].map(seconds=>({text:seconds ? secondsLabel(seconds) : t('No reminder', 'Без повтора'),callback_data:'repeat:' + generation + ':' + seconds})),
      [{text:t('🔔 Send a test notification', '🔔 Проверить уведомление'),callback_data:'test:' + generation}],
    ]}};
}
