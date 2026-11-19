import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { labels, keyboard } from '../tgcloud/lib/controls.js';
import { Pairing, default as worker } from '../../gateway/worker.mjs';

async function fixture({ linked = true, stale = false, offline = false, tier = 'test' } = {}) {
  const sent = [], calls = [];
  const context = vm.createContext({ Date, JSON, Number, Object, Error });
  const generation = 'a'.repeat(32);
  const modules = {
    sdk: new vm.SyntheticModule(['api', 'fetch'], function () {
      this.setExport('api', { sendMessage: async body => sent.push(body) });
      this.setExport('fetch', async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({ url, body });
        if (offline) throw new Error('Offline');
        if (url.endsWith('/status')) return Response.json({ generation: linked && !stale ? generation : null, tier });
        if (url.endsWith('/offer')) return Response.json({ ok: true });
        if (url.endsWith('/command')) return Response.json({ reply: { chat_id: body.message.chat.id, text: 'В очереди.' } });
        throw new Error('Unexpected URL: ' + url);
      });
    }, { context }),
    '../lib/config.js': new vm.SyntheticModule(['gateway', 'secret'], function () {
      this.setExport('gateway', 'https://mock.invalid'); this.setExport('secret', 'test');
    }, { context }),
    '../lib/pairing.js': new vm.SyntheticModule(['issueCode', 'pairingForOwner', 'redeemCode'], function () {
      this.setExport('issueCode', async () => 'B'.repeat(16));
      this.setExport('pairingForOwner', async () => linked ? { generation } : null);
      this.setExport('redeemCode', async () => {});
    }, { context }),
    '../lib/controls.js': new vm.SourceTextModule(await readFile(new URL('../tgcloud/lib/controls.js', import.meta.url), 'utf8'), { context }),
  };
  const handler = new vm.SourceTextModule(await readFile(new URL('../tgcloud/handlers/message.js', import.meta.url), 'utf8'), { context });
  await handler.link(name => modules[name]);
  await handler.evaluate();
  const invoke = async (text, overrides = {}) => handler.namespace.default({
    chat: { id: 101, type: 'private' }, from: { id: 101 },
    text, date: Math.floor(Date.now() / 1000), ...overrides,
  }, { update: { update_id: 123 } });
  return { invoke, sent, calls };
}

test('connected /start and mode picker never queue a search', async () => {
  const f = await fixture();
  await f.invoke('/start');
  assert.ok(f.sent[0].reply_markup.keyboard.flat().includes(labels.modes));
  await f.invoke(labels.modes);
  assert.ok(f.sent[1].reply_markup.keyboard.flat().includes(labels.normal));
  assert.match(f.sent[1].text, /запустит поиск/);
  assert.equal(f.calls.filter(c => !c.url.endsWith('/status')).length, 0);
});

test('each control button maps to its canonical command for its own owner (mock only)', async () => {
  for (const [label, command] of [[labels.normal, '/play_normal'], [labels.ranked, '/play_ranked'],
    [labels.street, '/play_street'], [labels.cancel, '/cancel'], [labels.watch, '/watch_black']]) {
    const f = await fixture();
    await f.invoke(label);
    const request = f.calls.find(c => c.url.endsWith('/command')).body;
    assert.equal(request.message.text, command);
    assert.equal(request.message.chat.id, 101);
    assert.equal(request.message.from.id, 101);
    assert.equal(request.generation, 'a'.repeat(32));
  }
});

test('unlinked and stale bindings cannot send game controls', async () => {
  for (const options of [{ linked: false }, { stale: true }]) {
    const f = await fixture(options);
    await f.invoke(labels.normal);
    assert.ok(!f.calls.some(c => c.url.endsWith('/command')));
    assert.deepEqual(Array.from(f.sent[0].reply_markup.keyboard.flat()), keyboard(false).keyboard.flat());
  }
});

test('group messages and mismatched sender IDs are ignored', async () => {
  const f = await fixture();
  await f.invoke(labels.normal, { chat: { id: 101, type: 'group' } });
  await f.invoke(labels.watch, { from: { id: 202 } });
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
});

test('status, back and help are read-only; /code still returns promptly', async () => {
  const f = await fixture();
  for (const label of [labels.status, labels.back, labels.help, labels.code]) await f.invoke(label);
  assert.ok(!f.calls.some(c => c.url.endsWith('/command') || c.url.endsWith('/wait')));
  assert.match(f.sent.at(-1).text, /Код KATKA: B{16}/);
  assert.ok(f.sent.at(-1).reply_markup.keyboard.flat().includes(labels.modes));
});

test('temporary outage produces a useful reply and never queues a command', async () => {
  const f = await fixture({ offline: true });
  await f.invoke(labels.normal);
  assert.match(f.sent[0].text, /сервис временно недоступен/);
  assert.ok(!f.calls.some(c => c.url.endsWith('/command')));
});

test('free keyboard and manual commands expose only starting modes and auto notifications', async () => {
  const f = await fixture({tier:'free'});
  await f.invoke('/menu');
  const buttons=f.sent[0].reply_markup.keyboard.flat();
  assert.ok(buttons.includes(labels.modes));
  for(const label of [labels.cancel,labels.watch,labels.status]) assert.ok(!buttons.includes(label));
  for(const action of ['/cancel','/watch_black','/status']) {
    await f.invoke(action);
    assert.match(f.sent.at(-1).text,/бесплатной/);
  }
  assert.ok(!f.calls.some(call=>call.url.endsWith('/command')));
  await f.invoke(labels.normal);
  assert.equal(f.calls.at(-1).body.message.text,'/play_normal');
});

function storage(entries) {
  const data = new Map(entries);
  const store = { get: async k => data.get(k), put: async (k,v) => data.set(k,v),
    transaction: async fn => fn(store) };
  return store;
}

test('owner status resolves only that owner and hides removed/replaced bindings', async () => {
  const data = storage([
    ['owner:101', 'clientA'], ['owner:202', 'clientB'],
    ['client:clientA', { owner: 101, generation: 'first' }],
    ['client:clientB', { owner: 202, generation: 'second' }],
    ['owner:303', 'clientA'],
  ]);
  const directory = new Pairing({ storage: data }, {});
  for (const [owner, generation] of [[101, 'first'], [202, 'second'], [303, null], [404, null]]) {
    const result = await directory.fetch(new Request('https://mock.invalid', {
      method: 'POST', body: JSON.stringify({ action: 'status', owner }),
    }));
    const data = await result.json();
    assert.equal(data.generation,generation); assert.equal(data.tier,'free');
    if (generation) {assert.equal(data.live.online,false);assert.equal(data.live.state,'unknown');}
  }
});

test('game status cannot select another owner using the request body', async () => {
  let internal;
  const result = await worker.fetch(new Request('https://mock.invalid/v1/status', {
    method: 'POST', headers: { Authorization: 'Bearer ' + 'b'.repeat(64) }, body: JSON.stringify({ owner: 202 }),
  }), { PAIRINGS: { idFromName: n => n, get: () => ({ fetch: async (_, init) => {
    internal = JSON.parse(init.body); return Response.json({ generation: null });
  } }) } });
  assert.equal(result.status, 200);
  assert.equal(internal.owner, undefined);
  assert.match(internal.installation, /^[a-f0-9]{64}$/);
});

test('pairing confirmation sends the control keyboard only to its owner', async () => {
  const data = storage([['client:clientA', { owner: 101, generation: 'first' }]]);
  const directory = new Pairing({ storage: data }, { KATKA_BOT_TOKEN: 'mock' });
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_, init) => {
    sent = JSON.parse(init.body); return Response.json({ ok: true });
  };
  try {
    const result = await directory.notify('connected', 'clientA', 'first');
    assert.equal(result.status, 200);
    assert.equal(sent.chat_id, 101);
    assert.deepEqual(sent.reply_markup, keyboard(true));
  } finally { globalThis.fetch = originalFetch; }
});
