import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('native ping updates and unlink requires a second deliberate action', async () => {
  const items = {}, urls = []; let receive;
  const item = id => items[id] ||= { text: '', SetPanelEvent(name, fn) { this.activate = fn; } };
  const frame = { id: 'KatkaSettings', SetURL: url => urls.push(url) };
  const context = { GetParent:()=>null, GetAttributeString:(key,fallback)=>fallback, SetAttributeString(){},
    FindChildTraverse: id => id === 'KatkaCommands' ? null : id === 'KatkaSettings' ? frame : item(id) };
  vm.runInNewContext(await readFile(new URL('./panorama/scripts/katka.js', import.meta.url), 'utf8'), { Date, $: {
    GetContextPanel: () => context, Schedule() {}, RegisterEventHandler: (name, target, fn) => { receive = fn; },
  } });
  receive(null, 'native:1:linked:status:217');
  assert.equal(items.KatkaPing.text, 'Отклик сервера: 217 мс');
  receive(null, 'native:1:offline:connection_timeout:none');
  assert.match(items.KatkaFeedback.text, /Сервер не ответил/);
  receive(null, 'native:1:linked:status:218');
  assert.equal(items.KatkaFeedback.text, '');
  const count = urls.length;
  items.KatkaUnlink.activate();
  assert.equal(urls.length, count);
  assert.equal(items.KatkaUnlinkConfirm.visible, true);
  items.KatkaUnlinkNo.activate();
  assert.equal(items.KatkaUnlinkConfirm.visible, false);
  items.KatkaUnlinkYes.activate();
  assert.equal(urls.length, count);
  items.KatkaUnlink.activate(); items.KatkaUnlinkYes.activate();
  assert.match(urls.at(-1), /#2:unlink:$/);
  receive(null, 'native:2:unlinked:unbound:none');
  assert.equal(items.KatkaUnlinkConfirm.visible, false);
  assert.equal(items.KatkaPing.text, 'Отклик сервера: —');
});

test('notification switch cycles three modes and restores the persisted reply', async () => {
  const items = {}, urls = []; let receive;
  const item = id => items[id] ||= {text:'', SetPanelEvent(name, fn) {this.activate=fn;}};
  const frame = {id:'KatkaSettings', SetURL: url => urls.push(url)};
  const context = {GetParent:()=>null, FindChildTraverse: id =>
    id === 'KatkaCommands' ? null : id === 'KatkaSettings' ? frame : item(id)};
  vm.runInNewContext(await readFile(new URL('./panorama/scripts/katka.js', import.meta.url), 'utf8'), {Date, $:{
    GetContextPanel:()=>context, Schedule(){}, RegisterEventHandler:(name, target, fn)=>{receive=fn;},
  }});
  receive(null, 'native:1:linked:status:12:auto:test');
  for (const [index, mode, label] of [[2,'on','ВКЛ'], [3,'off','ВЫКЛ'], [4,'auto','Авто']]) {
    items.KatkaNotifications.activate();
    assert.match(urls.at(-1), new RegExp(`#${index}:notifications:${mode}$`));
    receive(null, `native:${index}:linked:notifications:12:${mode}:test`);
    assert.equal(items.KatkaNotifications.text, 'Оповещения: ' + label);
  }
});
