import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import worker, { Pairing } from './worker.mjs';

const token = 'a'.repeat(64);
const installation = createHash('sha256').update(token).digest('hex');
const generation = 'b'.repeat(32);
const origin = 'https://pmikhail2009.github.io';
const started = 1_800_000_000_000;

function fixture(tier = 'owner') {
  const data = new Map([
    ['client:' + installation, {owner: 101, generation, since: 0, recent: []}],
    ['owner:101', installation],
    ['access:101', {tier}],
    ['language:101', 'ru'],
    ['preferences:101', {mode: 'on'}],
  ]);
  const reads = [];
  const storage = {
    get: async key => { reads.push(key); return structuredClone(data.get(key)); },
    put: async (key, value) => data.set(key, structuredClone(value)),
    transaction: fn => fn(storage),
  };
  const pairing = new Pairing({storage}, {KATKA_BOT_TOKEN: 'mock'});
  const env = {
    PAIRINGS: {idFromName: name => name, get: () => ({fetch: (url, init) => pairing.fetch(new Request(url, init))})},
    KATKA_CLOUD_SECRET: 'c'.repeat(64),
  };
  function call(path, body = {}, method = 'POST') {
    return worker.fetch(new Request('https://gateway.invalid' + path, {
      method, body: method === 'POST' ? JSON.stringify(body) : undefined,
      headers: {Origin: origin, Authorization: 'Bearer ' + (path.startsWith('/service/') ? env.KATKA_CLOUD_SECRET : token)},
    }), env);
  }
  function command(text, id = 41) {
    return call('/service/command', {generation, id, message: {
      chat: {type: 'private', id: 101}, from: {id: 101}, date: Math.floor(Date.now() / 1000), text,
    }});
  }
  return {data, reads, call, command};
}

test('lab status strategies isolate the cache and keep the gameplay settings', async () => {
  const f = fixture();
  for (const [path, cached] of [['status', true], ['status?lab=baseline', false], ['status?lab=cached', true], ['status?lab=lean', true]]) {
    const preflight = await f.call('/v1/' + path, {}, 'OPTIONS');
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Max-Age'), cached ? '600' : null);
    f.reads.length = 0;
    const response = await f.call('/v1/' + path);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json();
    assert.equal(body.generation, generation);
    assert.equal(body.language, 'ru');
    assert.deepEqual(body.settings, {mode: 'on', repeat: 0});
    if (path === 'status') {
      assert.equal(response.headers.get('Server-Timing'), null);
    } else {
      assert.match(response.headers.get('Server-Timing'), /^gateway;dur=\d+\.\d+$/);
      assert.equal(response.headers.get('Timing-Allow-Origin'), origin);
    }
    assert.equal(Boolean(body.live), path !== 'status?lab=lean');
    assert.equal(f.reads.filter(key => key === 'preferences:101').length, path === 'status?lab=lean' ? 1 : 2);
  }
});

test('game preflight permissions are cached only for the configured panel origin', async () => {
  for (const path of ['/v1/status', '/v1/poll', '/v1/result', '/v1/bind']) {
    for (const requestOrigin of [origin, 'https://other.invalid']) {
      const response = await worker.fetch(new Request('https://gateway.invalid' + path, {
        method: 'OPTIONS', headers: {Origin: requestOrigin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type'},
      }), {});
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), requestOrigin === origin ? origin : null);
      assert.equal(response.headers.get('Access-Control-Max-Age'), requestOrigin === origin ? '600' : null);
      if (requestOrigin === origin) assert.equal(response.status, 204);
    }
  }
});

test('a lab launch reaches only the lab client and Telegram receives measured game confirmation once', async t => {
  const f = fixture();
  const messages = [];
  t.mock.method(Date, 'now', () => started);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(url, /\/sendMessage$/);
    messages.push(JSON.parse(init.body));
    return Response.json({ok: true});
  });
  assert.match((await (await f.command('/lab_play')).json()).reply.text, /реальный обычный поиск/);
  assert.equal((await (await f.call('/v1/poll')).json()).command, null);
  const report = {generation, command: 42, status: 'queued'};
  assert.equal((await f.call('/v1/result', report)).status, 409);
  Date.now.mock.mockImplementation(() => started + 400);
  const result = await (await f.call('/v1/poll', {lab: true})).json();
  assert.deepEqual(result.command, {id: 42, action: '/play_normal', expires: started + 30_000});
  assert.equal((await (await f.call('/v1/poll', {generation, ack: 42, lab: true})).json()).command, null);
  Date.now.mock.mockImplementation(() => started + 1700);
  assert.equal((await f.call('/v1/result', report)).status, 200);
  assert.equal((await f.call('/v1/result', report)).status, 200);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].chat_id, 101);
  assert.match(messages[0].text, /Поиск матча начат.*\n.*1700 мс.*400 мс/);
});

test('free accounts and staff testers have no access to lab launch or timing', async () => {
  for (const tier of ['free', 'test']) {
    const f = fixture(tier);
    await f.command('/lab_play');
    assert.deepEqual(f.data.get('client:' + installation).recent, []);
    const response = await f.call('/v1/status?lab=lean');
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Server-Timing'), null);
  }
});
