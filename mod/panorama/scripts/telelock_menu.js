(function () {
  'use strict';
  var context = $.GetContextPanel();
  var menuButton = null;
  var settingsHost = null;

  function toggleSettings(menu) {
    if (!settingsHost || !settingsHost.IsValid()) {
      settingsHost = $.CreatePanel('Panel', menu, 'TelelockSettingsHost');
      if (!settingsHost.BLoadLayout('file://{resources}/layout/telelock_settings.xml', false, false)) {
        settingsHost.DeleteAsync(0);
        settingsHost = null;
        return;
      }
      return;
    }
    var settings = settingsHost.FindChildTraverse('KatkaNativeSettings');
    settings.visible = !settings.visible;
  }

  function mountMenuButton() {
    if (!context.IsValid()) return;
    if (!menuButton || !menuButton.IsValid()) {
      var root = context;
      while (root.GetParent()) root = root.GetParent();
      var background = root.FindChildTraverse('EscapeBackground');
      var menu = background && background.GetParent();
      var options = menu && menu.FindChildTraverse('SubOptions');
      var quit = options && options.FindChild('quit');
      if (quit) {
        var row = $.CreatePanel('Panel', options, 'TelelockMenuRow', { class: 'SettingsRow' });
        options.MoveChildBefore(row, quit);
        menuButton = $.CreatePanel('Button', row, 'TelelockMenuButton', { class: 'nav_menu_item minor' });
        $.CreatePanel('Label', menuButton, '', { class: 'menuButtonLabel', text: 'Telelock' });
        menuButton.SetPanelEvent('onactivate', function () { toggleSettings(menu); });
      }
    }
    $.Schedule(menuButton ? 2 : 0.5, mountMenuButton);
  }

  mountMenuButton();
})();
