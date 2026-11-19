(function () {
  'use strict';
  var panel = $.GetContextPanel();
  var frame = panel.FindChildTraverse('KatkaStateReport');
  if (!frame) return;
  var panelUrl = "KATKA_PANEL_URL";
  var url = panelUrl + '?view=state&session=' + Date.now();
  var ready = false, busy = false, lastReply = Date.now(), recovery = 0;
  function state() {
    if (panel.BHasClass('State_WaitingForMatch')) return 'waiting';
    if (panel.BHasClass('State_None') || panel.BHasClass('State_RosterSelect')) return 'idle';
    if (panel.BHasClass('State_WaitingForPartyRosters')) return 'party';
    if (panel.BHasClass('State_ConnectingToServer')) return 'connecting';
    return 'unknown';
  }
  function pulse() {
    if (Date.now() - lastReply > 10000) {
      recovery++; ready = false; busy = false; lastReply = Date.now();
      frame.SetURL(url + '&recovery=' + recovery);
    } else if (ready && !busy) {
      busy = true;
      frame.SetURL(url + (recovery ? '&recovery=' + recovery : '') + '#' + Date.now() + ':' + state());
    }
    $.Schedule(0.5, pulse);
  }
  $.RegisterEventHandler('HTMLTitle', frame, function (_, title) {
    if (title === 'ready:state' || /^state:/.test(title)) {
      ready = true; busy = false; lastReply = Date.now();
    } else if (/^busy:state:/.test(title)) busy = true;
    return false;
  });
  frame.SetURL(url);
  $.Schedule(0.5, pulse);
})();
