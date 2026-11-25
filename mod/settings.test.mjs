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
  assert.equal(items.KatkaPing.text, 'Server latency: 217 ms');
  assert.equal(items.KatkaTelegramBot.text, 'Open Telegram bot');
  receive(null, 'native:1:offline:connection_timeout:none');
  assert.match(items.KatkaFeedback.text, /did not respond/);
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
  assert.equal(items.KatkaPing.text, 'Server latency: —');
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
  receive(null, 'native:1:linked:status:12:auto:test:ru');
  assert.equal(items.KatkaTelegramBot.text, 'Открыть бота в Telegram');
  for (const [index, mode, label] of [[2,'on','ВКЛ'], [3,'off','ВЫКЛ'], [4,'auto','Авто']]) {
    items.KatkaNotifications.activate();
    assert.match(urls.at(-1), new RegExp(`#${index}:notifications:${mode}$`));
    receive(null, `native:${index}:linked:notifications:12:${mode}:test:ru`);
    assert.equal(items.KatkaNotifications.text, 'Оповещения: ' + label);
  }
});

test('the native flag opens a language picker, retries offline choices and reflects the account language', async () => {
  const generation = 'a'.repeat(32);
  const items = {}, urls = [], storage = new Map(), writes = [], requests = [];
  const item = id => items[id] ||= {text:'', SetPanelEvent(name, fn) {this.activate=fn;}};
  const frame = {id:'KatkaSettings', SetURL: url => urls.push(url)};
  const context = {GetParent:()=>null, FindChildTraverse: id =>
    id === 'KatkaCommands' ? null : id === 'KatkaSettings' ? frame : item(id)};
  let receive, hashChanged, accountLanguage = 'en', refresh, offline = false;
  const location = {search:'?view=native',hash:''};
  const document = {
    getElementById:()=>({}), querySelector:()=>({}),
    set title(value) {receive(null,value);},
  };
  const native = await readFile(new URL('./panorama/scripts/katka.js', import.meta.url), 'utf8');
  vm.runInNewContext(native, {Date, $:{
    GetContextPanel:()=>context,
    Schedule(seconds, fn) {if (seconds === 12) refresh = fn;},
    RegisterEventHandler(name, target, fn) {receive=fn;},
  }});
  const html = await readFile(new URL('./panel/index.html', import.meta.url), 'utf8');
  const script = html.split('<script>')[1].split('</script>')[0]
    .replace('const view =', 'api = window.request; observeGeneration = async () => {}; const view =');
  vm.runInNewContext(script, {
    document, location, URLSearchParams, performance,
    localStorage: {getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    window: {
      addEventListener(name, fn) {hashChanged=fn;},
      async request(action, body) {
        requests.push(action);
        if (offline) throw Object.assign(new Error('Connection lost'), {connectionFailure:'network'});
        if (action === 'status') return {generation,language:accountLanguage};
        assert.equal(action,'language');
        assert.equal(body.generation,generation);
        writes.push(body.language);
        accountLanguage = body.language;
        return {language:accountLanguage};
      },
    },
  });
  async function deliverRequest() {
    location.hash = urls.at(-1).slice(urls.at(-1).indexOf('#'));
    await hashChanged();
  }
  await deliverRequest();
  assert.equal(items.KatkaFlagEn.visible,true);
  items.KatkaLanguage.activate();
  assert.equal(items.KatkaLanguagePicker.visible,true);
  assert.equal(items.KatkaLanguageEn.text,'✓ English');
  assert.equal(urls.length,1);
  items.KatkaLanguageEn.activate();
  assert.equal(items.KatkaLanguagePicker.visible,false);
  assert.equal(urls.length,1);

  offline = true;
  items.KatkaLanguage.activate();
  items.KatkaLanguageRu.activate();
  assert.equal(items.KatkaLanguagePicker.visible,false);
  assert.match(urls.at(-1),/#2:language:ru$/);
  assert.equal(items.KatkaFlagRu.visible,true);
  assert.equal(items.KatkaBind.text,'Подключить');
  await deliverRequest();
  assert.deepEqual(writes,[]);
  assert.equal(items.KatkaFlagRu.visible,true);
  assert.match(items.KatkaFeedback.text,/Синхронизируем язык/);

  offline = false;
  refresh();
  assert.match(urls.at(-1),/#3:language:ru$/);
  await deliverRequest();
  assert.deepEqual(writes,['ru']);
  assert.deepEqual(requests,['status','language','language']);
  assert.equal(items.KatkaFlagRu.visible,true);
  assert.equal(items.KatkaBind.text,'Подключить');

  accountLanguage = 'en';
  refresh();
  await deliverRequest();
  assert.equal(items.KatkaFlagEn.visible,true);
  assert.equal(items.KatkaFlagRu.visible,false);
  assert.equal(items.KatkaBind.text,'Connect');
  assert.equal(storage.get('katka_language'),'en');
});

test('the lab panel measures each selected strategy across the game-browser bridge', async () => {
  const items = {}, urls = [], logs = [], endpoints = [];
  let receive, hashChanged, now = 1000, tick = 10;
  const item = id => items[id] ||= {SetPanelEvent(name, fn) { this.activate = fn; }};
  const frame = {id: 'KatkaSettings', SetURL: url => urls.push(url)};
  const context = {FindChildTraverse: id =>
    id === 'KatkaCommands' ? null : id === 'KatkaSettings' ? frame : item(id)};
  const native = await readFile(new URL('./panorama/scripts/katka.js', import.meta.url), 'utf8');
  vm.runInNewContext(native.replace('"KATKA_LAB"', '"true"'), {
    Date: {now: () => now},
    $: {GetContextPanel: () => context, Schedule() {}, Msg: text => logs.push(text),
      RegisterEventHandler(name, target, fn) { receive = fn; }},
  });
  const html = await readFile(new URL('./panel/index.html', import.meta.url), 'utf8');
  const script = html.split('<script>')[1].split('</script>')[0]
    .replace('const view =', 'installationKey = async () => "key"; observeGeneration = async () => {}; const view =');
  const location = {search: '?view=native&lab=1', hash: ''};
  vm.runInNewContext(script, {
    URL, URLSearchParams, location, AbortController, setTimeout, clearTimeout,
    performance: {now: () => tick, getEntriesByName: () => [
      {startTime: tick - 220, responseEnd: tick - 20, duration: 200, serverTiming: [{name: 'gateway', duration: 70}]},
    ]},
    document: {getElementById: () => ({}), querySelector: () => ({content: 'https://gateway.invalid'}),
      set title(value) { receive(null, value); }},
    localStorage: {getItem: () => null, setItem() {}},
    window: {addEventListener(name, fn) { hashChanged = fn; }},
    async fetch(url) {
      endpoints.push(url.pathname + url.search);
      now += 250;
      tick += 220;
      return Response.json({generation: 'b'.repeat(32), tier: 'owner', language: 'ru'});
    },
  });
  async function deliver() {
    location.hash = urls.at(-1).slice(urls.at(-1).indexOf('#'));
    await hashChanged();
    assert.match(items.KatkaLabTiming.text, /250 мс.*\nHTTP 200 мс · шлюз 70 мс\nОбработка ответа 20 мс/);
  }
  await deliver();
  items.KatkaLabStrategy.activate();
  await deliver();
  items.KatkaLabStrategy.activate();
  await deliver();
  items.KatkaLabMeasure.activate();
  await deliver();
  assert.deepEqual(endpoints, ['/v1/status?lab=baseline', '/v1/status?lab=cached', '/v1/status?lab=lean', '/v1/status?lab=lean']);
  assert.equal(logs.length, 4);
});
