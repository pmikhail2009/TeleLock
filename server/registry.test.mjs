import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Registry, MATCH_MESSAGE } from './registry.mjs';
import { clientServer } from './http.mjs';

test('Привязка, команды двух установок, потеря ответа, перезапуск и смена владельца', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'katka-test-'));
  const db = join(dir, 'registry.sqlite');
  let registry;
  let server;
  let base;
  const sent = [];
  async function start() {
    registry = new Registry(db);
    server = clientServer(registry, async (chat, text) => sent.push([chat, text]));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port + '/v1/';
  }
  async function stop() {
    await new Promise(resolve => server.close(resolve));
    registry.db.close();
  }
  async function post(client, route, body = {}) {
    const res = await fetch(base + route, { method: 'POST',
      headers: { Authorization: 'Bearer ' + client, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
  }
  const a = randomBytes(32).toString('hex');
  const b = randomBytes(32).toString('hex');
  await start();
  try {
    assert.deepEqual(await post(a,'status'), { generation: null });
    await assert.rejects(post(a,'bind',{ code:'bad' }), /Код неверен/);
    const expired = registry.issue('11');
    registry.db.exec('UPDATE codes SET expires=0');
    await assert.rejects(post(a,'bind',{ code:expired }), /Код неверен/);
    const code = registry.issue('11');
    const ga = await post(a,'bind',{code});
    await assert.rejects(post(b,'bind',{code}), /Код неверен/);
    const gb = await post(b,'bind',{code:registry.issue('22')});
    registry.enqueue('11','/play_normal');
    registry.enqueue('22','/cancel');
    const first = (await post(a,'poll',ga)).command;
    assert.equal(first.action,'/play_normal');
    assert.deepEqual((await post(a,'poll',ga)).command,first);
    assert.equal((await post(b,'poll',{...gb,ack:first.id})).command.action,'/cancel');
    assert.equal((await post(a,'poll',{...ga,ack:first.id})).command,null);
    await assert.rejects(post(b,'test',ga), /Привязка/);
    await Promise.all([post(a,'match',{...ga,match:'123'}),post(a,'match',{...ga,match:'123'})]);
    await post(b,'match',{...gb,match:'123'});
    await stop();
    await start();
    assert.deepEqual(await post(a,'status'),ga);
    await post(a,'match',{...ga,match:'123'});
    assert.deepEqual(sent.filter(([,text]) => text===MATCH_MESSAGE), [['11',MATCH_MESSAGE],['22',MATCH_MESSAGE]]);
    registry.enqueue('11','/play_street');
    const moved = await post(a,'bind',{code:registry.issue('22')});
    assert.deepEqual(await post(b,'status'),{generation:null});
    await assert.rejects(post(a,'poll',ga),/Привязка/);
    await assert.rejects(post(b,'poll',gb),/Привязка/);
    assert.equal((await post(a,'poll',moved)).command,null);
    assert.throws(() => registry.enqueue('11','/cancel'), /подключите/);
    await post(a,'test',moved);
    assert.equal(sent.at(-1)[0],'22');
    await post(a,'unlink',moved);
    await assert.rejects(post(a,'match',{...moved,match:'124'}),/Привязка/);
  } finally {
    await stop();
    rmSync(dir, {recursive:true});
  }
});
