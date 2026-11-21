import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Pairing, default as worker } from './worker.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
const generation = 'a'.repeat(32);
function fixture() {
  const rows = new Map([
    ['owner:101', 'one'], ['owner:202', 'two'],
    ['client:one', {owner:101, generation, since:0}],
    ['client:two', {owner:202, generation, since:0}],
  ]);
  const storage = {get:async key=>structuredClone(rows.get(key)),
    put:async(key,value)=>rows.set(key,structuredClone(value)), delete:async key=>rows.delete(key),
    list:async ({prefix, limit, startAfter = ''}) => new Map([...rows].sort()
      .filter(([key]) => key.startsWith(prefix) && key > startAfter).slice(0, limit)),
    transaction:async fn=>fn(storage)};
  const directory = new Pairing({storage}, {KATKA_OWNER_PASSWORD_HASH:hash('personal'), KATKA_TEST_PASSWORD_HASH:hash('shared')});
  const request = body => directory.fetch(new Request('https://internal', {method:'POST',body:JSON.stringify(body)}));
  let accessId = 0;
  const access = async (owner,password) => (await request({action:'access',owner,update:{password,id:++accessId}})).json();
  const command = async (text, owner=101) => (await request({action:'command', generation,update:{id:10,message:{chat:{id:owner,type:'private'},from:{id:owner},date:Math.floor(Date.now()/1000),text}}})).json();
  return {rows,request,access,command};
}
test('shared password enables multiple accounts independently and repeats toggle each off',async()=>{
  const f=fixture();
  for(const owner of [101,202]) assert.deepEqual(await f.access(owner,'shared'),{changed:true,tier:'test'});
  assert.deepEqual(await f.access(101,'shared'),{changed:true,tier:'free'});
  assert.equal(f.rows.get('access:202').tier,'test');
  assert.deepEqual(await f.access(202,'shared'),{changed:true,tier:'free'});
});
test('personal access is pinned to the first owner; wrong passwords do not change access',async()=>{
  const f=fixture();
  assert.equal((await f.access(101,'personal')).tier,'owner');
  assert.equal((await f.access(202,'personal')).changed,false);
  assert.equal((await f.access(101,'wrong')).changed,false);
  assert.equal(f.rows.get('access:101').tier,'owner');
  assert.equal((await f.access(101,'personal')).tier,'free');
  assert.equal((await f.access(101,'personal')).tier,'owner');
});
test('free users can start every mode but cannot cancel or watch; password restores controls',async()=>{
  for(const action of ['/play_normal','/play_ranked','/play_street']) {
    const f=fixture(); assert.match((await f.command(action)).reply.text,/Ожидаем/);
  }
  for(const action of ['/cancel','/watch_black']) {
    const f=fixture(); assert.match((await f.command(action)).reply.text,/бесплатной/);
    assert.equal(f.rows.get('client:one').recent,undefined);
    await f.access(101,'shared'); assert.match((await f.command(action)).reply.text,/Ожидаем/);
    await f.access(101,'shared');
    const poll=await (await f.request({action:'poll',installation:'one',generation})).json();
    assert.equal(poll.command,null);
  }
});
test('status reflects current role without trusting game tier; free test notifications are refused',async()=>{
  const f=fixture();
  const status=()=>f.request({action:'status',installation:'one',tier:'owner'}).then(r=>r.json());
  assert.equal((await status()).tier,'free');
  assert.equal((await f.request({action:'test',installation:'one',generation})).status,403);
  await f.access(101,'shared'); assert.equal((await status()).tier,'test');
  await f.access(101,'shared'); assert.equal((await status()).tier,'free');
});
test('public game requests cannot activate access and service access needs authentication',async()=>{
  for(const path of ['/v1/access','/service/access']) {
    const response=await worker.fetch(new Request('https://example.test'+path,{method:'POST',headers:{Authorization:'Bearer '+'b'.repeat(64)},body:JSON.stringify({owner:101,password:'shared'})}),{});
    assert.equal(response.status,path==='/v1/access'?404:403);
  }
});

test('community reports stay private and only the owner can publish or remove known issues', async () => {
  const f = fixture();
  await f.access(101, 'personal');
  await f.access(202, 'shared');
  const call = (owner, operation, extra = {}) => f.request({ action: 'community', owner, update: { operation, ...extra } });
  const report = { text: 'Два уведомления.', date: 1800000000, id: 1 };
  assert.equal((await call(303, 'report', report)).status, 200);
  await call(303, 'report', report);
  assert.equal((await call(202, 'inbox')).status, 403);
  const inbox = await (await call(101, 'inbox')).json();
  assert.equal(inbox.entries.length, 1);
  assert.equal(inbox.entries[0].text, report.text);
  assert.deepEqual((await (await call(303, 'known')).json()).entries, []);
  assert.equal((await call(202, 'add', report)).status, 403);
  assert.equal((await call(101, 'add', report)).status, 200);
  const { entries: [{ id }] } = await (await call(303, 'known')).json();
  assert.equal((await call(202, 'delete', { id })).status, 403);
  assert.equal((await call(101, 'delete', { id })).status, 200);
  await call(101, 'add', report);
  assert.deepEqual((await (await call(303, 'known')).json()).entries, []);
});

test('re-delivering a password message does not toggle access twice',async()=>{
  const f=fixture();
  const body={action:'access',owner:101,update:{password:'shared',id:999}};
  assert.equal((await (await f.request(body)).json()).tier,'test');
  assert.equal((await (await f.request(body)).json()).changed,false);
  assert.equal(f.rows.get('access:101').tier,'test');
  body.update.id++;
  assert.equal((await (await f.request(body)).json()).tier,'free');
});
