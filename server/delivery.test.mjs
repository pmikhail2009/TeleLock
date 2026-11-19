import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MatchDelivery } from './delivery.mjs';
import { clientServer } from './http.mjs';
import { MATCH_MESSAGE, Registry } from './registry.mjs';
import { sendText } from './telegram.mjs';

test('match delivery survives rate limits, ambiguous replies, restart and replacement of the owner', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'katka-delivery-'));
  const path = join(dir, 'test.sqlite');
  const client = randomBytes(32).toString('hex');
  let registry, server, delivery, endpoint;
  const calls = [];
  const outcomes = [];
  const realFetch = globalThis.fetch;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.telegram.org/bot123:test/sendMessage');
    calls.push(JSON.parse(options.body));
    return outcomes.shift()();
  });
  const send = (chat, text) => sendText('123:test', chat, text);
  async function start() {
    registry = new Registry(path);
    delivery = new MatchDelivery(registry, send);
    server = clientServer(registry, send, delivery);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/match';
  }
  async function stop() {
    await new Promise(resolve => server.close(resolve));
    registry.db.close();
  }
  const receipt = (status, extra) => () => Response.json({ ok: false, error_code: status, ...extra }, { status });
  const report = async (binding, match) => {
    const res = await realFetch(endpoint, {
      method: 'POST', headers: { Authorization: 'Bearer ' + client, 'Content-Type': 'application/json' },
      body: JSON.stringify({ generation: binding.generation, match }),
    });
    return { status: res.status, ...await res.json() };
  };
  await start();
  t.after(async () => { await stop(); rmSync(dir, { recursive: true }); });
  const one = registry.bind(client, registry.issue('111'));

  outcomes.push(receipt(429, { parameters: { retry_after: 12 } }));
  const limited = await report(one, '1');
  assert.equal(limited.status, 202);
  assert.equal(limited.delivery, 'pending');
  assert.equal(limited.retryAt, Date.now() + 12000);
  assert.equal(calls.length, 1);
  await stop();
  await start();
  t.mock.timers.tick(11999);
  assert.equal((await report(one, '1')).delivery, 'pending');
  assert.deepEqual(registry.dueDeliveries(), []);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  const controller = new AbortController();
  outcomes.push(() => {
    controller.abort();
    return Response.json({ ok: true, result: { message_id: 456 } });
  });
  await delivery.retryUntilStopped(controller.signal);
  assert.deepEqual(await report(one, '1'), { status: 200, ok: true, delivery: 'delivered' });
  assert.equal(calls.length, 2);

  outcomes.push(() => { throw new TypeError('socket closed while receiving the response'); });
  assert.equal((await report(one, '2')).delivery, 'unknown');
  outcomes.push(receipt(403));
  assert.equal((await report(one, '3')).delivery, 'rejected');
  outcomes.push(receipt(503));
  assert.equal((await report(one, '4')).delivery, 'unknown');
  const stranded = registry.recordMatch(client, one.generation, '5');
  assert.equal(registry.reserveDelivery(stranded).chat, '111');
  await stop();
  await start();
  for (const [id, state] of [['2','unknown'], ['3','rejected'], ['4','unknown'], ['5','unknown']]) {
    const result = await report(one, id);
    assert.equal(result.status, 502);
    assert.equal(result.ok, false);
    assert.equal(result.delivery, state);
  }
  assert.equal(calls.length, 5);

  outcomes.push(receipt(429, { parameters: { retry_after: 1 } }));
  assert.equal((await report(one, '6')).delivery, 'pending');
  const two = registry.bind(client, registry.issue('222'));
  t.mock.timers.tick(2000);
  assert.deepEqual(registry.dueDeliveries(), []);
  assert.equal((await report(two, '6')).delivery, 'previous_binding');
  assert.equal((await report(one, '7')).status, 400);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls, Array(6).fill({ chat_id: '111', text: MATCH_MESSAGE }));
  outcomes.push(() => Response.json({ ok: true, result: { message_id: 789 } }));
  assert.equal((await report(two, '7')).delivery, 'delivered');
  assert.deepEqual(calls.at(-1), { chat_id: '222', text: MATCH_MESSAGE });
});

test('older claims migrate to unknown without sending again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'katka-old-'));
  const path = join(dir, 'test.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec('CREATE TABLE matches(client TEXT NOT NULL, match TEXT NOT NULL, PRIMARY KEY(client,match))');
  legacy.prepare('INSERT INTO matches VALUES(?,?)').run('original-client', '123');
  legacy.close();
  const registry = new Registry(path);
  try {
    assert.deepEqual(registry.reserveDelivery({ client: 'original-client', match: '123', generation: 'new' }), { delivery: 'unknown' });
    assert.deepEqual(registry.dueDeliveries(), []);
  } finally {
    registry.db.close();
    rmSync(dir, { recursive: true });
  }
});
