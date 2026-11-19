// The build substitutes the owner's HTTPS origin in this local resource.
(function () {
  'use strict';
  var panelUrl = "KATKA_PANEL_URL";
  var context = $.GetContextPanel();
  var frame = context.FindChildTraverse('KatkaCommands') || context.FindChildTraverse('KatkaSettings');
  if (!frame) return;
  var isController = frame.id === 'KatkaCommands';
  var session = String(Date.now());
  var url = panelUrl + (isController ? '?view=commands' : '?view=native') + '&session=' + session;
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
        diagnostic.text = 'KATKA: этап=' + launchStage + '; ready=' + commandsReady + '; busy=' + commandsBusy +
          '; in_matchmaking=' + dashboardInQueue();
      } catch (error) { diagnostic.text = 'KATKA: ошибка проверки: ' + String(error); }
      $.Schedule(0.5, inspectRoster);
    }
    if (diagnostic) inspectRoster();
    pollCommands = function () {
      if (Date.now() - lastReply > 10000) {
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
      while (root.GetParent()) root = root.GetParent();
      return root;
    }
    var diagnoseButton = item('Diagnose');
    if (diagnoseButton && "KATKA_DIAGNOSTIC_ONLY" === 'true') {
      diagnoseButton.SetPanelEvent('onactivate', function () {
        settingsRoot().SetAttributeString('katka_diagnostic_request', String(Date.now()));
      });
    }
    var requestId = 0, active = false, activeAction = '', connected = false, linked = false;
    var confirmingUnlink = false, connectionError = false;
    var notificationMode = 'auto', accessTier = 'free';
    function fullAccess() { return accessTier === 'owner' || accessTier === 'test'; }
    function renderMode() {
      var labels = { on: 'ВКЛ', off: 'ВЫКЛ', auto: 'Авто' };
      item('Notifications').enabled = fullAccess();
      item('Test').visible = fullAccess();
      item('Notifications').text = 'Оповещения: ' + labels[notificationMode];
    }
    renderMode();
    function render() {
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
        action === 'notifications' ? notificationMode : action === 'test' ? String(Date.now()) : '';
      if (action === 'bind' && !/^[0-9A-F]{16}$/.test(code)) {
        item('Feedback').text = 'Введите 16 символов кода из Telegram.';
        return;
      }
      active = true;
      activeAction = action;
      if (action !== 'status') item('Feedback').text = action === 'bind' ? 'Подключаем Telegram…' : '';
      render();
      var id = ++requestId;
      frame.SetURL(url + '#' + id + ':' + action + ':' + code);
      $.Schedule(action === 'bind' ? 630 : action === 'test' ? 65 : 25, function () {
        if (active && id === requestId) {
          active = connected = false;
          activeAction = '';
          item('Connection').text = 'Нет связи с сервером';
          item('Ping').text = 'Отклик сервера: —';
          connectionError = true;
          item('Feedback').text = 'Нет ответа. Повторяем проверку связи…';
          render();
        }
      });
    }
    item('Notifications').SetPanelEvent('onactivate', function () {
      if (active && activeAction !== 'status') return;
      if (!fullAccess()) return;
      notificationMode = { on: 'off', off: 'auto', auto: 'on' }[notificationMode];
      renderMode();
      send('notifications');
    });
    item('Bind').SetPanelEvent('onactivate', function () { send('bind'); });
    item('Test').SetPanelEvent('onactivate', function () { send('test'); });
    item('Unlink').SetPanelEvent('onactivate', function () { confirmingUnlink = true; render(); });
    item('UnlinkNo').SetPanelEvent('onactivate', function () { confirmingUnlink = false; render(); });
    item('UnlinkYes').SetPanelEvent('onactivate', function () {
      if (confirmingUnlink) send('unlink');
    });
    $.RegisterEventHandler('HTMLTitle', frame, function (_, title) {
      var reply = /^native:(\d+):(offline|linked|unlinked):(\w+)(?::(\d+|none))?(?::(on|off|auto))?(?::(free|owner|test))?$/.exec(title);
      if (!reply || Number(reply[1]) !== requestId) return false;
      active = false;
      activeAction = '';
      accessTier = reply[6] || 'free';
      if (reply[5]) { notificationMode = reply[5]; renderMode(); }
      connected = reply[2] !== 'offline';
      if (connected) linked = reply[2] === 'linked';
      item('Connection').text = connected ? 'Сервер на связи' : 'Нет связи с сервером';
      item('Ping').text = 'Отклик сервера: ' + (connected && reply[4] && reply[4] !== 'none' ? reply[4] + ' мс' : '—');
      if (reply[3] === 'bound') item('Code').text = '';
      var messages = { bound: 'Подключено', tested: 'Уведомление отправлено, задержка указана в Telegram', test_failed: 'Не удалось подтвердить уведомление или записать задержку. Повторите проверку.', unbound: 'Telegram отключён', rejected: 'Запрос отклонён. Проверьте код и привязку.' };
      if (!connected) {
        connectionError = true;
        var failures = {
          connection_storage: 'Не удалось открыть хранилище установки.',
          connection_network: 'Не удалось получить ответ сервера.',
          connection_response: 'Получен некорректный ответ сервера.',
          connection_timeout: 'Сервер не ответил за 20 секунд.'
        };
        item('Feedback').text = failures[reply[3]] || 'Подключение повторится автоматически.';
        render();
        return false;
      }
      if (connectionError) { item('Feedback').text = ''; connectionError = false; }
      if (messages[reply[3]]) item('Feedback').text = messages[reply[3]];
      render();
      return false;
    });
    function refresh() {
      send('status');
      $.Schedule(12, refresh);
    }
    refresh();
    return;
  }
  frame.SetURL(url);
  if (isController) $.Schedule(1, pollCommands);
})();
