// Requests survive replacement of a dashboard or popup window.
(function () {
  'use strict';
  var panel = $.GetContextPanel();
  var frame = panel.FindChildTraverse('KatkaRosterTransport');
  if (!frame) return;
  var diagnosticOnly = "KATKA_DIAGNOSTIC_ONLY" === 'true';
  var panelUrl = "KATKA_PANEL_URL";
  var url = panelUrl + '?view=roster&session=' + Date.now();
  var ready = false, busy = false, lastReply = Date.now(), recovery = 0;
  var handled = {};
  var label = panel.FindChildTraverse('KatkaRosterDiagnostics');
  if (label) label.style.visibility = diagnosticOnly ? 'visible' : 'collapse';
  function buttonReady() {
    var button = panel.FindChildTraverse('ConfirmButton');
    return panel.visible && !panel.BHasClass('Hidden') && button && button.visible && button.enabled;
  }
  function transportUrl() { return url + (recovery ? '&recovery=' + recovery : ''); }
  function pulse() {
    if (Date.now() - lastReply > 10000) {
      recovery++; ready = false; busy = false; lastReply = Date.now();
      frame.SetURL(transportUrl());
    } else if (ready && !busy) {
      busy = true;
      frame.SetURL(transportUrl() + '#' + Date.now() + ':' + (buttonReady() ? 'ready' : 'waiting'));
    }
    $.Schedule(0.25, pulse);
  }
  $.RegisterEventHandler('HTMLTitle', frame, function (_, title) {
    if (title === 'ready:roster') { ready = true; busy = false; lastReply = Date.now(); return false; }
    if (/^busy:roster:/.test(title)) { busy = true; return false; }
    if (/^roster:(none|error):/.test(title)) { busy = false; lastReply = Date.now(); return false; }
    var request = /^roster:([a-f0-9]{32}):([1-9][0-9]{0,14}):(\/play_normal|\/play_ranked|\/play_street):(\d{13}):\d+$/.exec(title);
    if (!request) return false;
    busy = false; lastReply = Date.now();
    var key = request[1] + ':' + request[2], status = 'failed';
    if (!Object.prototype.hasOwnProperty.call(handled, key)) {
      // Reserve before calling the handler: it can synchronously close this popup.
      handled[key] = 'failed';
      try {
        if (!diagnosticOnly && Number(request[4]) > Date.now() && buttonReady()) {
          // Execute the stock XML handler on its owning button. Activated is an
          // input notification; DispatchPanelEvent explicitly invokes onactivate,
          // including CitadelRosterSelectConfirm in the correct popup context.
          $.DispatchEvent('DispatchPanelEvent', panel.FindChildTraverse('ConfirmButton'), 'onactivate');
          status = 'event_sent';
          handled[key] = status;
        }
      } catch (error) { if (label) label.text = 'Ошибка подтверждения: ' + String(error); }
    } else status = handled[key];
    // The reservation was committed before this callback; losing the popup cannot repeat it.
    busy = true;
    frame.SetURL(transportUrl() + '#ack=' + key + ':' + status + ':' + Date.now());
    return false;
  });
  frame.SetURL(url);
  $.Schedule(0.25, pulse);
})();
