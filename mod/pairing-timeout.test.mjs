import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const html = await readFile(new URL('./panel/index.html', import.meta.url), 'utf8');
const generation = 'a'.repeat(32);
const drain = () => new Promise(resolve => setImmediate(resolve));
function client(overrides = '') {
  const timers = new Map(), titles = [], storage = new Map();
  const location = {search:'?view=native&profile=1&errors=1',hash:'',origin:'https://mock.invalid'};
  const context = vm.createContext({
    Date, URLSearchParams, URL, AbortController, performance,
    setTimeout(fn, ms) { const id = {}; timers.set(id, {fn, ms}); return id; },
    clearTimeout(id) { timers.delete(id); },
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
    document:{querySelector:()=>({content:location.origin}),getElementById:()=>({}),
      set title(value) { titles.push(value); }},
    location, window:{addEventListener(name, fn) { this.receive = fn; }},
  });
  vm.runInContext(html.split('<script>')[1].split('</script>')[0].replace('const view =', `
    ${overrides}
    Object.assign(globalThis,{api,bindInstallation,readProfile});
    const view =`), context);
  return {context,titles, async fire(ms) {
    const entry = [...timers].find(([,timer])=>timer.ms===ms);
    assert.ok(entry, 'Expected timeout at ' + ms);
    timers.delete(entry[0]); entry[1].fn(); await drain();
  }, async bind() { location.hash = '#1:bind:0123456789ABCDEF'; return context.window.receive(); }};
}

test('blocked installation storage returns a storage error without waiting for IndexedDB', async () => {
  const app = client('installationKey = () => new Promise(() => {});');
  const request = assert.rejects(app.context.api('bind', {code:'0123456789ABCDEF'}),
    error => error.connectionFailure === 'storage');
  await app.fire(10000);
  await request;
});

test('pending pairing times out and a late server reply cannot reset command state', async () => {
  const app = client(`
    globalThis.resets = 0;
    resetCommands = async () => { globalThis.resets++; };
    api = async () => { await new Promise(resolve => {globalThis.reply = resolve;}); return {generation:'${generation}'}; };
  `);
  const request = assert.rejects(app.context.bindInstallation('0123456789ABCDEF'),
    error => error.connectionFailure === 'timeout');
  await app.fire(35000);
  await request;
  app.context.reply(); await drain();
  assert.equal(app.context.resets, 0);
});

test('repeated pending responses stop after 35 seconds and allow another attempt', async () => {
  const app = client(`
    api = async () => ({pending:true});
  `);
  const request = assert.rejects(app.context.bindInstallation('0123456789ABCDEF'),
    error => error.connectionFailure === 'timeout');
  await drain(); await app.fire(1000);
  await app.fire(35000); await request;
  vm.runInContext(`api = async () => ({generation:'${generation}'}); resetCommands = async () => {};`, app.context);
  assert.equal((await app.context.bindInstallation('0123456789ABCDEF')).generation, generation);
});

test('successful pairing is shown before a status refresh that never finishes', async () => {
  const app = client(`
    api = async () => { online = true; return {generation:'${generation}'}; };
    resetCommands = async () => {};
    refreshProfile = () => new Promise(() => {});
  `);
  app.bind(); await drain();
  assert.ok(app.titles.some(title=>/^native:1:linked:bound:/.test(title)));
  assert.equal(app.context.readProfile().generation, generation);
});

test('a stuck command mailbox cannot hide a successful server binding', async () => {
  const app = client(`
    api = async () => { online = true; return {generation:'${generation}'}; };
    resetCommands = () => new Promise(() => {});
  `);
  const request = app.bind(); await drain();
  await request;
  assert.ok(app.titles.some(title=>/^native:1:linked:bound:/.test(title)));
});

test('status publishes a verified binding even when command storage is unavailable', async () => {
  const app = client(`
    api = async () => { online = true; return {generation:'${generation}',tier:'owner',language:'ru'}; };
    observeGeneration = () => new Promise(() => {});
  `);
  app.context.location.hash = '#1:status:';
  await app.context.window.receive();
  assert.ok(app.titles.some(title => /^native:1:linked:status:/.test(title)));
  assert.equal(app.context.readProfile().generation, generation);
});

test('pending preference synchronization cannot delay a verified connection status', async () => {
  const app = client(`
    api = async () => { online = true; return {generation:'${generation}',tier:'owner'}; };
    syncPreferences = () => new Promise(() => {});
  `);
  app.context.location.hash = '#1:status:';
  app.context.window.receive(); await drain();
  assert.ok(app.titles.some(title => /^native:1:linked:status:/.test(title)));
});

test('pairing rejection distinguishes an expired code, a changed binding and unavailable Telegram', async () => {
  for (const [httpStatus, result] of [[400,'pairing_expired'],[409,'pairing_changed'],[503,'pairing_unavailable']]) {
    const app = client(`api = async () => { online = true; throw Object.assign(new Error('Rejected'), {httpStatus:${httpStatus}}); };`);
    await app.bind();
    assert.ok(app.titles.some(title => title.startsWith('native:1:unlinked:' + result + ':')));
  }
});

test('the game stops waiting for an unresponsive browser after 45 seconds and explains expired codes', async () => {
  const items = {}, timers = [];
  let receive;
  const item = id => items[id] ||= {text:'',SetPanelEvent(name,fn){this.activate=fn;}};
  const frame = {id:'KatkaSettings',SetURL(){}};
  const context = {FindChildTraverse:id=>id==='KatkaCommands'?null:id==='KatkaSettings'?frame:item(id)};
  vm.runInNewContext(await readFile(new URL('./panorama/scripts/katka.js',import.meta.url),'utf8'), {
    Date,$:{GetContextPanel:()=>context,Schedule:(ms,fn)=>timers.push({ms,fn}),
      RegisterEventHandler:(name,target,fn)=>{receive=fn;}},
  });
  receive(null,'native:1:unlinked:status:12000:auto:free:ru');
  item('KatkaCode').text='0123456789ABCDEF'; items.KatkaBind.activate();
  const watchdog=timers.at(-1); assert.equal(watchdog.ms,45);
  assert.equal(items.KatkaFeedback.text,'Подключаем Telegram…');
  watchdog.fn(); assert.equal(items.KatkaFeedback.text,'Сервер не ответил вовремя.');
  receive(null,'native:2:unlinked:pairing_expired:12000:auto:free:ru');
  assert.match(items.KatkaFeedback.text,/Код неверен или истёк.*\/code/);
  assert.equal(items.KatkaBind.enabled,true);
});
