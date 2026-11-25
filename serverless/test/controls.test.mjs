import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { feedbackPrompt, labels, keyboard } from '../tgcloud/lib/controls.js';
import { Pairing, default as worker } from '../../gateway/worker.mjs';

async function fixture({ linked = true, stale = false, offline = false, tier = 'test', language, directory } = {}) {
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
        const action = url.split('/').at(-1);
        if (directory && ['access', 'status', 'stats'].includes(action)) {
          return directory.fetch(new Request(url, { method: 'POST', body: JSON.stringify({ action, owner: body.owner, update: body }) }));
        }
        if (url.endsWith('/status')) return Response.json({ generation: linked && !stale ? generation : null, tier, language });
        if (url.endsWith('/offer')) return Response.json({ ok: true });
        if (url.endsWith('/feedback')) {
          if (body.operation === 'list') return tier === 'free'
            ? Response.json({language,denied:true},{status:403})
            : Response.json({language,counts:[0,0,0,1,1],texts:['A useful review'],next:null});
          return Response.json({language,saved:body.operation === 'write'});
        }
        if (url.endsWith('/command')) return Response.json({ reply: { chat_id: body.message.chat.id, text: 'Command accepted.' } });
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

test('main menu groups settings and game actions without queueing a search', async () => {
  const f = await fixture();
  await f.invoke('/start');
  assert.deepEqual(Array.from(f.sent[0].reply_markup.keyboard.flat()), [labels.play, labels.control, labels.pro, 'test']);
  await f.invoke(labels.play);
  assert.deepEqual(Array.from(f.sent.at(-1).reply_markup.keyboard, row => Array.from(row)),
    [[labels.normal, labels.ranked, labels.street], [labels.cancel, labels.watch], [labels.back]]);
  assert.match(f.sent.at(-1).text, /start matchmaking/);
  await f.invoke(labels.modes);
  assert.ok(f.sent.at(-1).reply_markup.keyboard.flat().includes(labels.normal));
  for (const back of [labels.back, '↩️ Main menu', '↩️ Управление']) {
    await f.invoke(back);
    assert.ok(f.sent.at(-1).reply_markup.keyboard.flat().includes(labels.play));
  }
  await f.invoke(labels.control);
  assert.deepEqual(Array.from(f.sent.at(-1).reply_markup.keyboard.flat()),
    [labels.language, labels.code, labels.settings, labels.feedback, labels.help, labels.back]);
  assert.equal(f.calls.filter(c => !c.url.endsWith('/status')).length, 0);
});

test('signing into each staff role shows the shared menu in Russian with only its role button added', async () => {
  const hash = text => createHash('sha256').update(text).digest('hex');
  const directory = new Pairing({ storage: storage([['ownerVersion:202', 1], ['feedback:launches:202', 5]]) }, {
    KATKA_OWNER_PASSWORD_HASH: hash('personal'), KATKA_TEST_PASSWORD_HASH: hash('shared'),
  });
  const f = await fixture({ linked: false, directory });
  await f.invoke('/menu');
  assert.deepEqual(Array.from(f.sent.at(-1).reply_markup.keyboard.flat()), [labels.play, labels.control, labels.pro]);
  let messageId = 1;
  for (const [password, role, other] of [['personal', 'admin', 'test'], ['shared', 'test', 'admin']]) {
    await f.invoke(password, { message_id: messageId++ });
    assert.match(f.sent.at(-1).text, new RegExp('Режим ' + role + ' включён'));
    assert.deepEqual(Array.from(f.sent.at(-1).reply_markup.keyboard.flat()),
      ['🎮 Играть', '⚙️ Центр управления', '⭐ Перейти на Pro', role]);
    await f.invoke(role);
    const staffButtons = ['⭐ Оценки и отзывы', '↩️ Назад'];
    if (role === 'admin') staffButtons.unshift('📊 Статистика Telelock');
    assert.deepEqual(Array.from(f.sent.at(-1).reply_markup.keyboard.flat()), staffButtons);
    await f.invoke('📊 Статистика Telelock');
    if (role === 'admin') {
      assert.match(f.sent.at(-1).text, /Подключили Deadlock к Telegram: 1\nЗапустили поиск через бота: 1/);
    } else {
      assert.match(f.sent.at(-1).text, /доступна в режиме admin/);
    }
    await f.invoke(other);
    assert.match(f.sent.at(-1).text, /соответствующей служебной ролью/);
    await f.invoke(password, { message_id: messageId++ });
    assert.deepEqual(Array.from(f.sent.at(-1).reply_markup.keyboard.flat()),
      ['🎮 Играть', '⚙️ Центр управления', '⭐ Перейти на Pro']);
  }
});

test('language menu works before pairing and accepts labels from either keyboard', async () => {
  const f = await fixture({linked:false, tier:'free', language:'ru'});
  await f.invoke(labels.control);
  assert.ok(f.sent[0].reply_markup.keyboard.flat().includes('🌐 Язык'));
  for (const label of [labels.language, '🌐 Язык', '/language']) {
    await f.invoke(label);
    assert.match(f.sent.at(-1).text, /Выберите язык/);
    const options = f.sent.at(-1).reply_markup.inline_keyboard[0];
    assert.equal(options[0].callback_data, 'language:en');
    assert.equal(options[1].text, '✓ Русский');
  }
  assert.ok(f.calls.every(call => call.url.endsWith('/status')));
});

test('any user can rate or reply with written feedback before pairing', async () => {
  const f = await fixture({ linked:false, tier:'free', language:'en' });
  await f.invoke(labels.feedback);
  assert.match(f.sent[0].text,/I’m Mikhail/);
  assert.deepEqual(Array.from(f.sent[0].reply_markup.inline_keyboard[0], button=>button.text), ['1','2','3','4','5']);
  await f.invoke('It found my match in time.', {reply_to_message:{from:{is_bot:true},text:feedbackPrompt('en')}});
  assert.equal(f.calls[1].body.operation,'write');
  assert.equal(f.calls[1].body.text,'It found my match in time.');
  assert.match(f.sent.at(-1).text,/Thank you/);
  assert.equal(f.calls.every(call=>call.url.endsWith('/feedback')),true);
});

test('the ratings menu shows staff results and denies free users', async () => {
  const staff = await fixture({tier:'test'});
  await staff.invoke(labels.reviews);
  assert.match(staff.sent[0].text,/4\.50 \/ 5/);
  assert.match(staff.sent[0].text,/A useful review/);
  const free = await fixture({tier:'free',language:'ru'});
  await free.invoke('/reviews');
  assert.match(free.sent[0].text,/нужен тестовый или админ-доступ/);
});

test('each control button maps to its canonical command for its own owner (mock only)', async () => {
  for (const [label, command] of [[labels.normal, '/play_normal'], [labels.ranked, '/play_ranked'],
    ['▶️ Обычный поиск', '/play_normal'], ['▶️ Ranked matchmaking', '/play_ranked'],
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
    assert.deepEqual(Array.from(f.sent[0].reply_markup.keyboard.flat()), keyboard(false, 'home', 'test').keyboard.flat());
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
  for (const label of ['/status', '📡 Что сейчас?', labels.back, labels.help, labels.code]) await f.invoke(label);
  assert.ok(!f.calls.some(c => c.url.endsWith('/command') || c.url.endsWith('/wait')));
  assert.match(f.sent.at(-1).text, /Telelock code: B{16}/);
  assert.ok(f.sent.at(-1).reply_markup.keyboard.flat().includes(labels.code));
});

test('temporary outage produces a useful reply and never queues a command', async () => {
  const f = await fixture({ offline: true });
  await f.invoke(labels.normal);
  assert.match(f.sent[0].text, /service is temporarily unavailable/);
  assert.ok(!f.calls.some(c => c.url.endsWith('/command')));
});

test('free keyboard and manual commands expose only starting modes and auto notifications', async () => {
  const f = await fixture({tier:'free'});
  await f.invoke(labels.play);
  assert.deepEqual(Array.from(f.sent[0].reply_markup.keyboard, row => Array.from(row)),
    [[labels.normal, labels.ranked], [labels.street], [labels.back]]);
  for(const action of ['/cancel','/watch_black','/status']) {
    await f.invoke(action);
    assert.match(f.sent.at(-1).text,/free version/);
  }
  assert.ok(!f.calls.some(call=>call.url.endsWith('/command')));
  await f.invoke(labels.normal);
  assert.equal(f.calls.at(-1).body.message.text,'/play_normal');
});

test('unpaired users can open the Pro offer without claiming the trial', async () => {
  const f = await fixture({ linked: false, tier: 'free' });
  await f.invoke('/menu');
  assert.ok(f.sent.at(-1).reply_markup.keyboard.flat().includes(labels.pro));
  await f.invoke(labels.pro);
  const payment = f.sent.at(-1).reply_markup.inline_keyboard[0][0];
  assert.equal(payment.text, 'Continue to payment');
  assert.equal(payment.callback_data, 'pro:pay');
  assert.ok(f.calls.every(call => call.url.endsWith('/status')));
});

test('Pro enables game and notification controls without exposing staff reviews', async () => {
  const f = await fixture({ tier: 'pro' });
  await f.invoke('/menu');
  assert.deepEqual(Array.from(f.sent.at(-1).reply_markup.keyboard.flat()), [labels.play, labels.control, labels.pro]);
  await f.invoke(labels.play);
  assert.deepEqual(Array.from(f.sent.at(-1).reply_markup.keyboard.at(-1)), [labels.back]);
  assert.ok(f.sent.at(-1).reply_markup.keyboard.flat().includes(labels.cancel));
  await f.invoke(labels.cancel);
  assert.equal(f.calls.at(-1).body.message.text, '/cancel');
  await f.invoke(labels.control);
  const buttons = f.sent.at(-1).reply_markup.keyboard.flat();
  assert.ok(buttons.includes(labels.settings));
  assert.ok(!buttons.includes(labels.reviews));
});

function storage(entries) {
  const data = new Map(entries);
  const store = { get: async k => data.get(k), put: async (k,v) => data.set(k,v),
    list: async ({ prefix }) => new Map([...data].filter(([key]) => key.startsWith(prefix))),
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
