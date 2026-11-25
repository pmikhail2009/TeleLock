import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('ping requests a fresh server measurement and can retry after losing the connection', async () => {
  const items = {}, urls = [], requests = [];
  let receive, handleNative, tick = 0, latency = 217, offline = false;
  const item = id => items[id] ||= {SetPanelEvent(name, fn) { this.activate = fn; }};
  const frame = {id: 'KatkaSettings', SetURL: url => urls.push(url)};
  const context = {FindChildTraverse: id =>
    id === 'KatkaCommands' ? null : id === 'KatkaSettings' ? frame : item(id)};
  vm.runInNewContext(await readFile(new URL('./panorama/scripts/katka.js', import.meta.url), 'utf8'), {
    Date, $: {GetContextPanel: () => context, Schedule() {},
      RegisterEventHandler(name, target, fn) { receive = fn; }},
  });
  const location = {search: '?view=native', hash: ''};
  const html = await readFile(new URL('./panel/index.html', import.meta.url), 'utf8');
  const script = html.split('<script>')[1].split('</script>')[0]
    .replace('const view =', 'installationKey = async () => "key"; observeGeneration = async () => {}; const view =');
  vm.runInNewContext(script, {
    Date, URL, URLSearchParams, location, AbortController, setTimeout, clearTimeout,
    performance: {now: () => tick},
    document: {getElementById: () => ({}), querySelector: () => ({content: 'https://gateway.invalid'}),
      set title(value) { receive(null, value); }},
    localStorage: {getItem: () => null},
    window: {addEventListener(name, fn) { handleNative = fn; }},
    async fetch(url, options) {
      requests.push(url.pathname);
      assert.equal(options.cache, 'default');
      tick += latency;
      if (offline) throw Object.assign(new Error('Timed out'), {name: 'AbortError'});
      return Response.json({generation: null, language: 'ru'});
    },
  });
  async function deliver() {
    location.hash = urls.at(-1).slice(urls.at(-1).indexOf('#'));
    await handleNative();
  }
  await deliver();
  assert.equal(items.KatkaPing.text, 'Отклик сервера: 217 мс');
  assert.equal(items.KatkaPingNow.text, 'ping');

  latency = 89;
  items.KatkaPingNow.activate();
  assert.match(urls.at(-1), /#2:status:$/);
  assert.equal(items.KatkaPingNow.text, 'ping');
  items.KatkaPingNow.activate();
  assert.equal(urls.length, 2);
  await deliver();
  assert.equal(items.KatkaPing.text, 'Отклик сервера: 89 мс');
  assert.equal(items.KatkaPingNow.text, 'ping');

  offline = true;
  items.KatkaPingNow.activate();
  await deliver();
  assert.equal(items.KatkaPing.text, 'Отклик сервера: —');
  assert.equal(items.KatkaPingNow.text, 'ping');
  assert.match(items.KatkaFeedback.text, /не ответил вовремя/);

  offline = false;
  latency = 45;
  items.KatkaPingNow.activate();
  await deliver();
  assert.equal(items.KatkaPing.text, 'Отклик сервера: 45 мс');
  assert.equal(items.KatkaFeedback.text, '');
  assert.deepEqual(requests, Array(4).fill('/v1/status'));
});
