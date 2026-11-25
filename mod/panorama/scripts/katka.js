// The build substitutes the owner's HTTPS origin in this local resource.
(function () {
  'use strict';
  var panelUrl = "KATKA_PANEL_URL";
  var lab = "KATKA_LAB" === 'true';
  var context = $.GetContextPanel();
  var frame = context.FindChildTraverse('KatkaCommands') || context.FindChildTraverse('KatkaSettings');
  if (!frame) return;
  var isController = frame.id === 'KatkaCommands';
  var session = String(Date.now());
  var url = panelUrl + (isController ? '?view=commands' : '?view=native&profile=1&errors=1') + '&session=' + session + (lab ? '&lab=1' : '');
  // Never pass received strings to DispatchEvent as event names.
  var events = {
    '/play_normal': 'CitadelStartUnrankedMatch',
    '/play_ranked': 'CitadelStartRankedMatch',
    '/play_street': 'CitadelStartUnrankedStreetBrawl',
    '/cancel': 'CitadelLeaveMatchmaking'
  };
  var previous = '';
  var botDispatch = false;
  var pollCommands;
  if (isController) {
    var diagnosticOnly = "KATKA_DIAGNOSTIC_ONLY" === 'true';
    var owner = '', watching = true, acknowledged = '';
    var pollSequence = 0, approved = null, approvalSequence = 0;
    var lastReply = Date.now(), recoverySequence = 0;
    var commandsReady = false, commandsBusy = false;
    var launchStage = 'Ожидаем готовности связи';
    var resultFrame = context.FindChildTraverse('KatkaCommandReport');
    var results = [], resultSequence = 0, handled = {};
    function rootPanel() {
      var root = context;
      while (root.GetParent()) root = root.GetParent();
      return root;
    }
    rootPanel().SetAttributeString('katka_diagnostic_only', diagnosticOnly ? 'true' : 'false');
    function traceLaunch(message, userMessage) {
      launchStage = message;
      rootPanel().SetAttributeString('katka_launch_stage', message);
      if (userMessage) rootPanel().SetAttributeString('katka_user_status', userMessage);
    }
    function commandsUrl() {
      return url + (recoverySequence ? '&recovery=' + recoverySequence : '');
    }
    function showResult() {
      if (resultFrame && results.length) {
        var item = results[0];
        resultFrame.SetURL(panelUrl + '?view=result&session=' + session + '#' + (++resultSequence) + ':' +
          item.generation + ':' + item.command + ':' + item.status);
      }
    }
    function reportResult(generation, command, status) {
      if (diagnosticOnly) return;
      for (var i = 0; i < results.length; i++) {
        if (results[i].generation === generation && results[i].command === command) return;
      }
      results.push({ generation: generation, command: command, status: status });
      if (results.length === 1) showResult();
    }
    if (resultFrame) $.RegisterEventHandler('HTMLTitle', resultFrame, function (_, title) {
      if (results.length && title === 'result:' + results[0].generation + ':' + results[0].command) {
        results.shift(); showResult();
      }
      return false;
    });
    function retryResult() { showResult(); $.Schedule(2, retryResult); }
    $.Schedule(2, retryResult);
    function dashboardInQueue() {
      var root = rootPanel();
      var dashboard = root.FindChildTraverse ? root.FindChildTraverse('Dashboard') : null;
      return dashboard ? dashboard.BHasClass('in_matchmaking') : null;
    }
    function queueKnownActive() {
      var panels = rootPanel().FindChildrenWithClassTraverse('KatkaMatchmakingStatus');
      for (var i = 0; i < panels.length; i++) {
        if (panels[i].visible !== false && panels[i].BHasClass('State_WaitingForMatch')) return true;
      }
      return false;
    }
    function rosterAlreadyOpen() {
      var candidates = rootPanel().FindChildrenWithClassTraverse('KatkaRosterSelect');
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].visible && !candidates[i].BHasClass('Hidden')) return true;
      }
      return false;
    }
    function refuseMode(generation, command) {
      if (rosterAlreadyOpen()) {
        traceLaunch('Отказ: экран выбора уже открыт', 'Экран выбора героев уже открыт. Закройте его и повторите команду');
        reportResult(generation, command, 'already_open'); return true;
      }
      if (dashboardInQueue() === true || queueKnownActive()) {
        traceLaunch('Отказ: игра уже находится в очереди', 'Игра уже находится в очереди; новый поиск не запускался');
        reportResult(generation, command, 'unconfirmed'); return true;
      }
      return false;
    }
    function approveMode(generation, command, action, expires) {
      if (diagnosticOnly) {
        traceLaunch('Диагностическая сборка: запуск заблокирован', 'Диагностика без запуска поиска');
        return;
      }
      if (refuseMode(generation, command)) return;
      approved = { generation: generation, command: command, action: action, expires: expires };
      traceLaunch('Режим разрешён локально; сохраняем запрос', 'Команда получена игрой');
      commandsBusy = true;
      lastReply = Date.now();
      frame.SetURL(commandsUrl() + '#approve=' + generation + ':' + command + ':' + (++approvalSequence));
    }
    function setOwner(next) {
      if (owner !== next) {
        watching = true; acknowledged = ''; approved = null;
        rootPanel().SetAttributeString('katka_bot_search', 'false');
        rootPanel().SetAttributeString('katka_user_status', '');
        traceLaunch(next ? 'Изменилась привязка' : 'Привязка отсутствует');
      }
      owner = next;
    }
    var diagnostic = diagnosticOnly ? context.FindChildTraverse('KatkaCommandDiagnostics') : null;
    function inspectRoster() {
      if (!diagnostic) return;
      try {
        diagnostic.text = 'Telelock: этап=' + launchStage + '; ready=' + commandsReady + '; busy=' + commandsBusy +
          '; in_matchmaking=' + dashboardInQueue();
      } catch (error) { diagnostic.text = 'Telelock: ошибка проверки: ' + String(error); }
      $.Schedule(0.5, inspectRoster);
    }
    if (diagnostic) inspectRoster();
    pollCommands = function () {
      if (Date.now() - lastReply > 25000) {
        recoverySequence++;
        commandsReady = false;
        commandsBusy = false;
        approved = null;
        lastReply = Date.now();
        frame.SetURL(commandsUrl());
      } else if (commandsReady && !commandsBusy) {
        frame.SetURL(commandsUrl() + '#poll=' + (++pollSequence) + ':' + acknowledged);
      }
      $.Schedule(1, pollCommands);
    };
    function enableWatch() {
      watching = true;
      rootPanel().SetAttributeString('katka_bot_search', botDispatch ? 'true' : 'false');
    }
    $.RegisterForUnhandledEvent(events['/play_normal'], enableWatch);
    $.RegisterForUnhandledEvent(events['/play_ranked'], enableWatch);
    $.RegisterForUnhandledEvent(events['/play_street'], enableWatch);
    var reporter = context.FindChildTraverse('KatkaMatchReport');
    var outstanding = [];
    var sequence = 0;
    function showReport() {
      if (outstanding.length) reporter.SetURL(panelUrl + '?view=match&session=' + session + '#' + outstanding[0]);
    }
    $.RegisterEventHandler('HTMLTitle', reporter, function (_, title) {
      if (outstanding.length && title === 'received:' + outstanding[0]) {
        outstanding.shift();
        showReport();
      }
      return false;
    });
    $.RegisterForUnhandledEvent('CitadelMatchFormed', function () {
      if (!owner) return;
      var botSearch = rootPanel().GetAttributeString('katka_bot_search', 'false') === 'true';
      rootPanel().SetAttributeString('katka_bot_search', 'false');
      // Reuse one receipt on transport retries even when the event has no match ID.
      sequence = (sequence + 1) % 10000;
      var receipt = String(Date.now()) + ('0000' + sequence).slice(-4);
      outstanding.push(owner + ':' + receipt + ':' + (botSearch ? 'bot' : 'manual'));
      if (outstanding.length === 1) showReport();
    });
    function retryReport() {
      showReport();
      $.Schedule(12, retryReport);
    }
    $.Schedule(12, retryReport);
    $.RegisterEventHandler('HTMLTitle', frame, function (_, title) {
      if (title === 'ready:commands') {
        commandsReady = true; commandsBusy = false; lastReply = Date.now();
        return false;
      }
      if (/^busy:commands:[0-9]+$/.test(title)) {
        if (!commandsBusy) lastReply = Date.now();
        commandsBusy = true;
        return false;
      }
      if (/^transport:offline(?::[0-9]+)?$/.test(title)) {
        commandsBusy = false; lastReply = Date.now();
        traceLaunch('Транспорт временно недоступен; привязка сохранена');
        return false;
      }
      var status = /^owner:([a-f0-9]{32}|none)(?::[0-9]+)?$/.exec(title);
      if (status) {
        commandsBusy = false; lastReply = Date.now();
        if (status[1] === 'none' || owner !== status[1]) acknowledged = '';
        setOwner(status[1] === 'none' ? '' : status[1]);
        return false;
      }
      var execute = /^execute:([a-f0-9]{32}):([1-9][0-9]{0,14}):(\/play_normal|\/play_ranked|\/play_street):(\d{13})(?::[0-9]+)?$/.exec(title);
      if (execute) {
        commandsBusy = false; lastReply = Date.now();
        var permission = approved;
        if (diagnosticOnly || !permission || permission.generation !== execute[1] ||
            permission.command !== Number(execute[2]) || permission.action !== execute[3] ||
            execute[1] !== owner || Number(execute[4]) > permission.expires ||
            Number(execute[4]) <= Date.now()) return false;
        // Consume permission before dispatch: opening a popup can recreate this context.
        approved = null;
        if (refuseMode(execute[1], Number(execute[2]))) return false;
        traceLaunch('Запрос сохранён; открываем режим ' + execute[3], 'Открываем выбор героев');
        try {
          botDispatch = true;
          rootPanel().SetAttributeString('katka_bot_search', 'true');
          $.DispatchEvent(events[execute[3]]);
        }
        catch (error) {
          traceLaunch('Ошибка открытия режима: ' + String(error), 'Не удалось открыть выбор героев');
          reportResult(execute[1], Number(execute[2]), 'failed');
          rootPanel().SetAttributeString('katka_bot_search', 'false');
        } finally { botDispatch = false; }
        return false;
      }
      var match = /^katka:([a-f0-9]{32}):([1-9][0-9]{0,14}):(\/play_normal|\/play_ranked|\/play_street|\/cancel|\/watch_black):(\d{13})(?::[0-9]+)?$/.exec(title);
      if (!match) return false;
      commandsBusy = false; lastReply = Date.now();
      if (Number(match[4]) <= Date.now()) return false;
      setOwner(match[1]);
      var key = match[1] + ':' + match[2];
      if (!handled[key]) {
        handled[key] = true;
        var action = match[3], command = Number(match[2]);
        if (action === '/watch_black') {
          watching = true;
          traceLaunch('Наблюдение включено; разрешение режима сохранено', 'Наблюдение включено');
          reportResult(owner, command, 'watching');
        } else {
          approved = null;
          watching = action !== '/cancel';
          traceLaunch('Получена команда ' + action, 'Команда получена игрой');
          if (action === '/cancel') {
            rootPanel().SetAttributeString('katka_bot_search', 'false');
            if (!diagnosticOnly) {
              try {
                $.DispatchEvent(events[action]);
                traceLaunch('Выход из очереди передан игре; ждём нативное состояние', 'Ждём подтверждения отмены от игры');
              } catch (error) {
                traceLaunch('Ошибка отмены: ' + String(error), 'Не удалось подтвердить отмену поиска');
                reportResult(owner, command, 'unconfirmed');
              }
            }
          } else approveMode(owner, command, action, Number(match[4]));
        }
        previous = key;
      }
      acknowledged = key;
      return false;
    });
  } else {
    function item(id) { return context.FindChildTraverse('Katka' + id); }
    function settingsRoot() {
      var root = context;
      while (root.GetParent && root.GetParent()) root = root.GetParent();
      return root;
    }
    var diagnoseButton = item('Diagnose');
    if (diagnoseButton && "KATKA_DIAGNOSTIC_ONLY" === 'true') {
      diagnoseButton.SetPanelEvent('onactivate', function () {
        settingsRoot().SetAttributeString('katka_diagnostic_request', String(Date.now()));
      });
    }
    var requestId = 0, active = false, activeAction = '', connected = false, linked = false;
    var labStrategy = 'baseline', labStarted = 0, labTiming = null;
    var confirmingUnlink = false, connectionError = false, checked = false, ping = null, feedback = '';
    var notificationMode = 'auto', accessTier = 'free', language = 'en', pendingLanguage = '';
    var languagePickerOpen = false;
    var pendingNotifications = false;
    var localRoot = settingsRoot();
    try {
      var cached = JSON.parse(localRoot.GetAttributeString('telelock_local_profile', 'null'));
      if (cached && (cached.language === 'en' || cached.language === 'ru') &&
          /^(free|owner|test)$/.test(cached.tier) && /^(on|off|auto)$/.test(cached.mode)) {
        language = cached.language; accessTier = cached.tier; notificationMode = cached.mode;
        linked = cached.linked === true;
        pendingLanguage = cached.pendingLanguage ? language : '';
        pendingNotifications = cached.pendingNotifications === true;
      }
    } catch (_) {}
    function rememberProfile() {
      if (localRoot.SetAttributeString) localRoot.SetAttributeString('telelock_local_profile', JSON.stringify({
        language: language, tier: accessTier, mode: notificationMode, linked: linked,
        pendingLanguage: !!pendingLanguage, pendingNotifications: pendingNotifications
      }));
    }
    var languageChoices = { en: { button: 'LanguageEn', name: 'English' }, ru: { button: 'LanguageRu', name: 'Русский' } };
    function t(en, ru) { return language === 'ru' ? ru : en; }
    function fullAccess() { return accessTier === 'owner' || accessTier === 'test'; }
    function render() {
      var labels = t({ on: 'On', off: 'Off', auto: 'Auto' }, { on: 'ВКЛ', off: 'ВЫКЛ', auto: 'Авто' });
      var copy = {
        Heading: lab ? t('Telelock — test build', 'Telelock — тестовая версия') :
          t('Telelock — match alerts', 'Telelock — уведомления о матче'),
        LatencyHint: t('Commands can take longer to reach the game.', 'Доставка команды может занять больше времени.'),
        CodeLabel: t('Telegram code', 'Код из Telegram'), Bind: t('Connect', 'Подключить'),
        TelegramBot: t('Open Telegram bot', 'Открыть бота в Telegram'),
        LinkedLabel: t('Telegram connected', 'Telegram подключён'),
        Test: t('Send a test notification', 'Проверить уведомление'),
        Unlink: t('Disconnect Telegram', 'Отключить Telegram'),
        UnlinkPrompt: t('Disconnect Telegram? Bot controls and match alerts will stop.',
          'Отключить Telegram? Уведомления и управление через бота перестанут работать.'),
        UnlinkYes: t('Disconnect', 'Да, отключить'), UnlinkNo: t('Cancel', 'Отмена')
      };
      for (var id in copy) item(id).text = copy[id];
      if (diagnoseButton) diagnoseButton.text = t('Test controls without matchmaking', 'Проверить управление без поиска');
      item('FlagEn').visible = language === 'en';
      item('FlagRu').visible = language === 'ru';
      var canChooseLanguage = !active || activeAction === 'status';
      item('Language').enabled = canChooseLanguage;
      item('LanguagePicker').visible = languagePickerOpen;
      Object.keys(languageChoices).forEach(function (choice) {
        var option = languageChoices[choice];
        item(option.button).text = (language === choice ? '✓ ' : '') + option.name;
        item(option.button).enabled = canChooseLanguage;
      });
      item('Connection').text = !checked ? t('Connecting to the server…', 'Подключаемся к серверу…')
        : connected ? t('Server online', 'Сервер на связи') : t('Server unreachable', 'Нет связи с сервером');
      item('Ping').text = t('Server latency: ', 'Отклик сервера: ') + (ping === null ? '—' : ping + t(' ms', ' мс'));
      item('PingNow').text = 'ping';
      if (lab) {
        var strategy = {
          baseline: t('Baseline', 'Текущий маршрут'),
          cached: t('Cached preflight', 'Кэш предварительного запроса'),
          lean: t('Lean status + cache', 'Короткий статус + кэш')
        };
        item('LabStrategy').text = strategy[labStrategy];
        item('LabMeasure').text = t('Measure now', 'Замерить сейчас');
        item('LabStrategy').enabled = item('LabMeasure').enabled = !active;
        item('LabTiming').text = !labTiming ? t('Waiting for a timing sample', 'Ожидаем замер') :
          t('Game round trip ', 'Полный цикл ') + labTiming.total + t(' ms', ' мс') +
          (labTiming.http === null ? t(' · detailed timing unavailable', ' · детализация недоступна') :
            '\nHTTP ' + labTiming.http + t(' ms · gateway ', ' мс · шлюз ') + (labTiming.gateway === null ? '—' : labTiming.gateway + t(' ms', ' мс')) +
            '\n' + t('Response processing ', 'Обработка ответа ') + (labTiming.browser === null ? '—' : labTiming.browser + t(' ms', ' мс')));
      }
      var messages = {
        invalid_code: t('Enter the 16-character Telegram code.', 'Введите 16 символов кода из Telegram.'),
        binding: t('Connecting Telegram…', 'Подключаем Telegram…'),
        pairing_expired: t('The code is invalid or expired. Get a new code with /code in the Telelock bot.',
          'Код неверен или истёк. Получите новый командой /code в боте Telelock.'),
        pairing_changed: t('The code was used or the connection changed. Get a new code with /code.',
          'Код уже использован или привязка изменилась. Получите новый код командой /code.'),
        pairing_unavailable: t('Telegram could not confirm the connection. Try connecting again.',
          'Telegram не подтвердил подключение. Повторите попытку.'),
        bound: t('Connected', 'Подключено'),
        tested: t('Test sent. Check Telegram for the timing.', 'Уведомление отправлено, задержка указана в Telegram'),
        test_failed: t('Could not confirm the test. Try again.', 'Не удалось подтвердить уведомление или записать задержку. Повторите проверку.'),
        unbound: t('Telegram disconnected', 'Telegram отключён'),
        rejected: t('Request rejected. Check the code and connection.', 'Запрос отклонён. Проверьте код и привязку.'),
        language_failed: t('Could not change the language. Try again.', 'Не удалось изменить язык. Попробуйте ещё раз.'),
        connection_storage: t('Could not open installation storage.', 'Не удалось открыть хранилище установки.'),
        connection_network: t('Could not reach the server.', 'Не удалось получить ответ сервера.'),
        connection_response: t('The server returned an invalid response.', 'Получен некорректный ответ сервера.'),
        connection_timeout: t('The server did not respond in time.', 'Сервер не ответил вовремя.'),
        connection_unknown: t('Reconnecting automatically…', 'Подключение повторится автоматически.')
      };
      item('Feedback').text = pendingLanguage
        ? t('Saved on this PC. Syncing language with Telegram…', 'Сохранено на ПК. Синхронизируем язык с Telegram…')
        : pendingNotifications ? t('Saved on this PC. Syncing notifications with Telegram…',
          'Сохранено на ПК. Синхронизируем оповещения с Telegram…')
        : messages[feedback] || '';
      item('Notifications').enabled = fullAccess();
      item('Test').visible = fullAccess();
      item('Notifications').text = t('Notifications: ', 'Оповещения: ') + labels[notificationMode];
      item('Pair').visible = !linked;
      item('Linked').visible = linked;
      item('Bind').enabled = item('Test').enabled = item('Unlink').enabled =
        connected && (!active || activeAction === 'status');
      if (!linked) confirmingUnlink = false;
      item('Unlink').visible = !confirmingUnlink;
      item('UnlinkConfirm').visible = confirmingUnlink;
      item('UnlinkYes').enabled = connected && (!active || activeAction === 'status');
    }
    function send(action) {
      if (active && (action === 'status' || activeAction !== 'status')) return;
      var code = action === 'bind' ? item('Code').text.trim().toUpperCase() :
        action === 'notifications' ? notificationMode : action === 'test' ? String(Date.now()) :
        action === 'language' ? pendingLanguage : lab && action === 'status' ? labStrategy : '';
      if (action === 'bind' && !/^[0-9A-F]{16}$/.test(code)) {
        feedback = 'invalid_code';
        render();
        return;
      }
      active = true;
      activeAction = action;
      if (action !== 'status') feedback = action === 'bind' ? 'binding' : '';
      render();
      var id = ++requestId;
      if (lab && action === 'status') labStarted = Date.now();
      frame.SetURL(url + '#' + id + ':' + action + ':' + code);
      $.Schedule(action === 'bind' ? 45 : action === 'status' ? 45 : action === 'test' || action === 'language' ? 65 : 25, function () {
        if (active && id === requestId) {
          active = connected = false;
          activeAction = '';
          checked = true;
          ping = null;
          if (lab && action === 'status') {
            labTiming = null;
            $.Msg('Telelock lab status [' + labStrategy + '] no reply from game browser');
          }
          connectionError = true;
          feedback = 'connection_timeout';
          render();
        }
      });
    }
    item('PingNow').SetPanelEvent('onactivate', function () { send('status'); });
    if (lab) {
      item('LabStrategy').SetPanelEvent('onactivate', function () {
        if (active) return;
        labStrategy = { baseline: 'cached', cached: 'lean', lean: 'baseline' }[labStrategy];
        labTiming = null;
        send('status');
      });
      item('LabMeasure').SetPanelEvent('onactivate', function () { send('status'); });
    }
    item('Notifications').SetPanelEvent('onactivate', function () {
      if (active && activeAction !== 'status') return;
      if (!fullAccess()) return;
      notificationMode = { on: 'off', off: 'auto', auto: 'on' }[notificationMode];
      pendingNotifications = true;
      send('notifications');
    });
    item('Language').SetPanelEvent('onactivate', function () {
      languagePickerOpen = !languagePickerOpen;
      render();
    });
    item('Close').SetPanelEvent('onactivate', function () {
      languagePickerOpen = false;
      item('NativeSettings').visible = false;
      render();
    });
    Object.keys(languageChoices).forEach(function (choice) {
      item(languageChoices[choice].button).SetPanelEvent('onactivate', function () {
        if (active && activeAction !== 'status') return;
        languagePickerOpen = false;
        if (choice === language) { render(); return; }
        language = pendingLanguage = choice;
        send('language');
      });
    });
    item('Bind').SetPanelEvent('onactivate', function () { send('bind'); });
    item('Test').SetPanelEvent('onactivate', function () { send('test'); });
    item('Unlink').SetPanelEvent('onactivate', function () { confirmingUnlink = true; render(); });
    item('UnlinkNo').SetPanelEvent('onactivate', function () { confirmingUnlink = false; render(); });
    item('UnlinkYes').SetPanelEvent('onactivate', function () {
      if (confirmingUnlink) send('unlink');
    });
    $.RegisterEventHandler('HTMLTitle', frame, function (_, title) {
      var reply = /^native:(\d+):(offline|linked|unlinked|cached_linked|cached_unlinked):(\w+)(?::(\d+|none))?(?::(on|off|auto))?(?::(free|owner|test))?(?::(en|ru))?(?::lab,(\d+|none),(\d+|none),(\d+|none))?(?::pending,(0|1),(0|1))?$/.exec(title);
      if (!reply || Number(reply[1]) !== requestId) return false;
      if (reply[11] !== undefined) {
        pendingLanguage = reply[11] === '1' ? reply[7] : '';
        pendingNotifications = reply[12] === '1';
      }
      if (reply[2].indexOf('cached_') === 0) {
        linked = reply[2] === 'cached_linked';
        accessTier = reply[6] || 'free';
        notificationMode = reply[5] || 'auto';
        language = reply[7] || language;
        if (reply[3] === 'saved') { active = false; activeAction = ''; }
        rememberProfile();
        render();
        return false;
      }
      if (lab && activeAction === 'status') {
        labTiming = reply[2] === 'offline' ? null : {
          total: Math.max(0, Date.now() - labStarted),
          http: reply[8] && reply[8] !== 'none' ? Number(reply[8]) : null,
          gateway: reply[9] && reply[9] !== 'none' ? Number(reply[9]) : null,
          browser: reply[10] && reply[10] !== 'none' ? Number(reply[10]) : null
        };
        $.Msg('Telelock lab status [' + labStrategy + '] ' + (labTiming ? JSON.stringify(labTiming) : reply[3]));
      }
      active = false;
      activeAction = '';
      accessTier = reply[6] || 'free';
      if (reply[5]) notificationMode = reply[5];
      if (reply[11] === undefined && reply[2] !== 'offline' && (reply[3] === 'language' || reply[3] === 'language_failed' || reply[3] === 'synced'))
        pendingLanguage = '';
      if (reply[7] && !pendingLanguage) language = reply[7];
      checked = true;
      connected = reply[2] !== 'offline';
      if (connected) linked = reply[2] === 'linked';
      ping = connected && reply[4] && reply[4] !== 'none' ? reply[4] : null;
      if (reply[3] === 'bound') item('Code').text = '';
      rememberProfile();
      if (!connected) {
        connectionError = true;
        feedback = reply[3].indexOf('connection_') === 0 ? reply[3] : 'connection_unknown';
        render();
        return false;
      }
      if (connectionError) { feedback = ''; connectionError = false; }
      if (reply[3] !== 'status') feedback = reply[3];
      render();
      return false;
    });
    function refresh() {
      if (!active || !pendingLanguage) send(pendingLanguage ? 'language' : 'status');
      $.Schedule(12, refresh);
    }
    refresh();
    return;
  }
  frame.SetURL(url);
  if (isController) $.Schedule(1, pollCommands);
})();
