import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker, { Pairing } from './worker.mjs';

const generation = 'a'.repeat(32);
const otherGeneration = 'b'.repeat(32);
const item = (id, action = '/play_normal') => ({ id, action, expires: Date.now() + 30000 });

function fixture() {
  const entries = new Map([
    ['client:one', { owner: 101, generation, recent: [item(11), item(12, '/cancel'), item(13, '/watch_black')] }],
    ['client:two', { owner: 202, generation: otherGeneration, recent: [item(22)] }],
    ['owner:101', 'one'], ['owner:202', 'two'],
  ]);
  const storage = {
    get: async key => structuredClone(entries.get(key)),
    put: async (key, value) => entries.set(key, structuredClone(value)),
    transaction: async fn => fn(storage),
  };
  const directory = new Pairing({ storage }, { KATKA_BOT_TOKEN: 'mock' });
  const report = (overrides = {}) => directory.fetch(new Request('https://internal.invalid', {
    method: 'POST', body: JSON.stringify({ action: 'result', installation: 'one', generation,
      command: 11, status: 'queued', ...overrides }),
  }));
  return { directory, report, entries };
}

async function intercept(fn, response = () => Response.json({ ok: true })) {
  const original = globalThis.fetch, sent = [];
  globalThis.fetch = async (url, init) => {
    assert.match(url, /^https:\/\/api\.telegram\.org\/botmock\/sendMessage$/);
    sent.push(JSON.parse(init.body));
    return response();
  };
  try { await fn(sent); } finally { globalThis.fetch = original; }
}

test('execution results notify only the installation owner and expose no owner in response', async () => {
  const f = fixture();
  await intercept(async sent => {
    const first = await f.report();
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { accepted: true, status: 'queued', delivery: 'delivered' });
    await f.report({ installation: 'two', generation: otherGeneration, command: 22 });
    assert.deepEqual(sent.map(message => message.chat_id), [101, 202]);
    assert.match(sent[0].text, /Matchmaking started/);
  });
});

test('unknown, foreign commands, stale generation and removed binding cannot notify anybody', async () => {
  const f = fixture();
  await intercept(async sent => {
    assert.equal((await f.report({ command: 22 })).status, 404);
    assert.equal((await f.report({ command: 999 })).status, 404);
    assert.equal((await f.report({ generation: otherGeneration })).status, 409);
    assert.equal((await f.report({ installation: 'missing' })).status, 409);
    assert.equal(sent.length, 0);
  });
});

test('duplicate delivered report survives command-history pruning without a second message', async () => {
  const f = fixture();
  await intercept(async sent => {
    await f.report();
    f.entries.get('client:one').recent = [];
    const repeated = await (await f.report()).json();
    assert.equal(repeated.delivery, 'delivered');
    assert.equal(sent.length, 1);
    assert.equal((await f.report({ status: 'failed' })).status, 409);
    assert.equal(sent.length, 1);
  });
});

test('lost Telegram response keeps a persisted reservation and is never sent again', async () => {
  const f = fixture();
  await intercept(async sent => {
    const first = await (await f.report()).json();
    assert.equal(first.delivery, 'unknown');
    assert.equal((await (await f.report()).json()).delivery, 'unknown');
    assert.equal(sent.length, 1);
  }, () => { throw new Error('response lost after send'); });
});

test('Telegram 429 waits until retry_after, revalidates the report, reserves the retry and sends once', async () => {
  const f = fixture();
  const originalNow = Date.now;
  let now = originalNow(), attempts = 0;
  Date.now = () => now;
  try {
    await intercept(async sent => {
      const first = await f.report();
      assert.equal(first.status, 503);
      assert.deepEqual(await first.json(), { accepted: true, status: 'queued', delivery: 'pending', retryAt: now + 3000 });
      now += 2999;
      const early = await f.report();
      assert.equal(early.status, 503);
      assert.equal((await early.json()).delivery, 'pending');
      assert.equal(sent.length, 1);
      assert.equal((await f.report({ status: 'failed' })).status, 409);
      assert.equal((await f.report({ generation: otherGeneration })).status, 409);
      assert.equal((await f.report({ command: 999 })).status, 404);
      assert.equal(sent.length, 1);
      now++;
      const retry = await f.report();
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).delivery, 'delivered');
      assert.equal((await (await f.report()).json()).delivery, 'delivered');
      assert.equal(sent.length, 2);
    }, () => {
      attempts++;
      assert.deepEqual(f.entries.get('commandResult:one:' + generation + ':11'), { status: 'queued', delivery: 'unknown' });
      return attempts === 1
        ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 3 } }, { status: 429 })
        : Response.json({ ok: true });
    });
  } finally { Date.now = originalNow; }
});

test('a lost response after a permitted 429 retry becomes terminal unknown and cannot resend', async () => {
  const f = fixture();
  const originalNow = Date.now;
  let now = originalNow(), attempts = 0;
  Date.now = () => now;
  try {
    await intercept(async sent => {
      assert.equal((await f.report()).status, 503);
      now += 1000;
      const retry = await f.report();
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).delivery, 'unknown');
      now += 100000;
      assert.equal((await (await f.report()).json()).delivery, 'unknown');
      assert.equal(sent.length, 2);
    }, () => {
      if (++attempts === 1) return Response.json({ ok: false, error_code: 429,
        parameters: { retry_after: 1 } }, { status: 429 });
      throw new Error('response lost after retry');
    });
  } finally { Date.now = originalNow; }
});

test('result is reserved before Telegram receives the request', async () => {
  const f = fixture();
  await intercept(async () => {
    const result = await f.report();
    assert.equal(result.status, 200);
  }, () => {
    assert.deepEqual(f.entries.get('commandResult:one:' + generation + ':11'), { status: 'queued', delivery: 'unknown' });
    return Response.json({ ok: true });
  });
});

test('status schema and per-action result allowlists reject invalid reports', async () => {
  const f = fixture();
  await intercept(async sent => {
    for (const overrides of [{ status: 'activated' }, { status: null }, { status: { toString: null } },
      { command: 0 }, { command: '11' }, { generation: 'wrong' }, { status: 'cancelled' },
      { status: 'watching' }, { command: 12, status: 'queued' }, { command: 13, status: 'queued' }]) {
      assert.equal((await f.report(overrides)).status, 400, JSON.stringify(overrides));
    }
    assert.equal(sent.length, 0);
    await f.report({ command: 12, status: 'cancelled' });
    await f.report({ command: 13, status: 'watching' });
    assert.equal(sent.length, 2);
  });
});

test('all play results are accepted without pretending an unconfirmed result is success', async () => {
  for (const status of ['queued', 'already_open', 'failed', 'unconfirmed']) {
    const f = fixture();
    await intercept(async sent => {
      assert.equal((await f.report({ status })).status, 200);
      if (status === 'unconfirmed') assert.match(sent[0].text, /did not confirm/);
    });
  }
});

test('expired reports are rejected but execution may report shortly after queue TTL', async () => {
  const f = fixture();
  await intercept(async sent => {
    f.entries.get('client:one').recent[0].expires = Date.now() - 120001;
    assert.equal((await f.report()).status, 409);
    assert.equal(sent.length, 0);
    f.entries.get('client:one').recent[0].expires = Date.now() - 1000;
    assert.equal((await f.report({ status: 'unconfirmed' })).status, 200);
    assert.equal(sent.length, 1);
  });
});

test('public result endpoint derives installation from bearer token and forwards no owner override', async () => {
  const token = 'c'.repeat(64); let forwarded;
  const result = await worker.fetch(new Request('https://gateway.invalid/v1/result', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ installation: 'two', owner: 202, generation, command: 11, status: 'queued' }),
  }), { PAIRINGS: { idFromName: name => name, get: () => ({ fetch: async (_, options) => {
    forwarded = JSON.parse(options.body); return Response.json({ accepted: true, delivery: 'delivered' });
  } }) } });
  assert.equal(result.status, 200);
  assert.equal(forwarded.installation, createHash('sha256').update(token).digest('hex'));
  assert.equal(forwarded.owner, undefined);
  assert.equal(forwarded.command, 11);
  assert.equal(forwarded.status, 'queued');
  assert.equal((await worker.fetch(new Request('https://gateway.invalid/v1/result', {
    method: 'POST', body: '{}',
  }), {})).status, 403);
});

test('initial server reply clearly distinguishes acceptance from execution', async () => {
  const f = fixture();
  const result = await f.directory.fetch(new Request('https://internal.invalid', { method: 'POST', body: JSON.stringify({
    action: 'command', generation, update: { id: 55, message: { chat: { id: 101, type: 'private' },
      from: { id: 101 }, date: Math.floor(Date.now() / 1000), text: '/play_normal' } },
  }) }));
  const body = await result.json();
  assert.match(body.reply.text, /Command accepted/);
  assert.match(body.reply.text, /Waiting for the game/);
});
