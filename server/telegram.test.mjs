import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Registry } from './registry.mjs';
import { sendText, startTelegram } from './telegram.mjs';

const credential = () => randomBytes(32).toString('hex');
const privateUpdate = (id, user, text) => ({
  update_id: id,
  message: { date: Math.floor(Date.now() / 1000), from: { id: user }, chat: { type: 'private', id: user }, text },
});

test('private bot commands persist once across polling restarts and only reach their installation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'katka-telegram-'));
  const dbPath = join(dir, 'test.db');
  let registry = new Registry(dbPath);
  t.after(() => { registry.db.close(); rmSync(dir, { recursive: true }); });
  const a = credential();
  const b = credential();
  const ownerB = registry.bind(b, registry.issue('222'));
  const group = privateUpdate(12, 111, '/code');
  group.message.chat = { type: 'group', id: -123 };
  const forged = privateUpdate(13, 111, '/play_street');
  forged.message.from.id = 222;
  const stale = privateUpdate(14, 111, '/cancel');
  stale.message.date -= 60;
  const replies = [];
  let phase;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const method = url.split('/').at(-1);
    const params = JSON.parse(opts.body);
    if (method === 'sendMessage') {
      replies.push(params);
      return Response.json({ ok: true, result: {} });
    }
    assert.equal(method, 'getUpdates');
    assert.deepEqual(params.allowed_updates, ['message']);
    if (phase.index >= phase.batches.length) phase.controller.abort();
    else assert.equal(params.offset, phase.offsets[phase.index]);
    return Response.json({ ok: true, result: phase.batches[phase.index++] || [] });
  });
  const run = async (offsets, ...batches) => {
    phase = { controller: new AbortController(), index: 0, batches, offsets };
    await startTelegram(registry, '123:test', phase.controller.signal);
  };

  await run([0], [privateUpdate(10, 111, '/start')]);
  assert.equal(replies[0].chat_id, '111');
  assert.ok(replies[0].reply_markup.keyboard.flat().includes('/watch_black'));
  const code = replies[0].text.match(/[A-F0-9]{16}/)[0];
  const ownerA = registry.bind(a, code);
  const queueA = privateUpdate(11, 111, '/play_street');
  await run([11], [queueA, group, forged, stale, privateUpdate(15, 222, '/watch_black')]);
  assert.equal(replies.length, 4);
  assert.match(replies[2].text, /устарела/);
  assert.equal(replies[3].chat_id, '222');

  registry.db.close();
  registry = new Registry(dbPath);
  await run([16], [queueA, privateUpdate(16, 333, '/cancel')]);
  assert.equal(replies.length, 5);
  assert.match(replies[4].text, /подключите/);
  const cmdA = registry.next(a, ownerA.generation);
  const cmdB = registry.next(b, ownerB.generation);
  assert.equal(cmdA.action, '/play_street');
  assert.equal(cmdB.action, '/watch_black');
  assert.equal(registry.next(a, ownerA.generation, cmdA.id), null);
  assert.equal(registry.next(b, ownerB.generation, cmdB.id), null);
  await sendText('123:test', '222', 'Проверка');
  assert.deepEqual(replies.at(-1), { chat_id: '222', text: 'Проверка' });
  assert.throws(() => sendText('123:test', '-123', 'Проверка'));
});
