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
    list:async ({prefix,limit,startAfter=''})=>new Map([...rows.keys()].sort()
      .filter(key=>key.startsWith(prefix) && key>startAfter).slice(0,limit).map(key=>[key,rows.get(key)])),
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
test('ordinary users can start all modes, cancel and monitor without a password',async()=>{
 for(const action of ['/play_normal','/play_ranked','/play_street','/cancel','/watch_black']) {
   const f=fixture();assert.match((await f.command(action)).reply.text,/Waiting/);
   const poll=await (await f.request({action:'poll',installation:'one',generation})).json();
   assert.equal(poll.command.action,action);
 }
});

test('both staff passwords set Russian for the signing-in account and its game', async () => {
  const f = fixture();
  const status = target => f.request({action:'status',...target}).then(r=>r.json());
  assert.equal((await status({owner:101})).language, 'en');
  await f.access(101,'personal');
  assert.equal((await status({owner:101})).language, 'ru');
  assert.equal((await status({installation:'one'})).language, 'ru');
  assert.equal((await status({owner:202})).language, 'en');
  await f.access(202,'shared');
  assert.equal((await status({owner:202})).language, 'ru');
  assert.equal((await status({installation:'two'})).language, 'ru');
  await f.request({action:'language',owner:202,language:'en'});
  await f.access(202,'shared');
  assert.equal((await status({owner:202})).language, 'en');
  await f.access(202,'shared');
  assert.equal((await status({owner:202})).language, 'ru');
});
test('status keeps staff roles server-side and ordinary test notifications reach the delivery service',async()=>{
  const f=fixture();
  const status=()=>f.request({action:'status',installation:'one',tier:'owner'}).then(r=>r.json());
  assert.equal((await status()).tier,'free');
  assert.equal((await f.request({action:'test',installation:'one',generation})).status,503); // No bot token in this fixture.
  await f.access(101,'shared'); assert.equal((await status()).tier,'test');
  await f.access(101,'shared'); assert.equal((await status()).tier,'free');
});
test('public game requests cannot activate access and service access needs authentication',async()=>{
  for(const path of ['/v1/access','/service/access','/v1/pro','/service/pro','/v1/thanks','/service/thanks','/v1/stats','/service/stats']) {
    const response=await worker.fetch(new Request('https://example.test'+path,{method:'POST',headers:{Authorization:'Bearer '+'b'.repeat(64)},body:JSON.stringify({owner:101,password:'shared'})}),{});
    assert.equal(response.status,path.startsWith('/v1/')?404:403);
  }
});

test('only the owner can read usage totals, including unlinked accounts and multiple pages', async () => {
  const f = fixture();
  const stats = owner => f.request({action:'stats',owner});
  await f.access(202,'shared');
  assert.equal((await stats(202)).status, 403);
  assert.equal((await stats(303)).status, 403);
  await f.access(101,'personal');
  for (let owner = 1000; owner < 2001; owner++) f.rows.set('ownerVersion:' + owner, 1);
  for (const revision of [1, 2]) {
    assert.equal((await f.request({action:'register',owner:101,installation:'one',generation,revision})).status, 200);
  }
  await f.request({action:'unlink',installation:'one',generation});
  f.rows.set('feedback:launches:101', 5);
  f.rows.set('feedback:launches:1000', 1);
  const secret = 'a'.repeat(64);
  const response = await worker.fetch(new Request('https://example.test/service/stats', {
    method:'POST',headers:{Authorization:'Bearer '+secret},body:JSON.stringify({owner:101}),
  }), { KATKA_CLOUD_SECRET:secret, PAIRINGS:{idFromName:name=>name,get:()=>({
    fetch:(_,init)=>f.request(JSON.parse(init.body)),
  })} });
  assert.deepEqual(await response.json(), {language:'ru',connected:1002,launched:2});
});

test('expired or active former trials cannot restrict free features or grant staff privileges',async()=>{
 const f=fixture();
 for(const expiry of [Date.now()-1,Date.now()+86400000]) {
   f.rows.set('proTrial:101',expiry);
   assert.equal((await (await f.request({action:'status',owner:101})).json()).tier,'free');
   assert.equal((await f.request({action:'settings',owner:101,generation,update:{mode:'on',repeat:30}})).status,200);
   assert.deepEqual((await (await f.request({action:'status',owner:101})).json()).settings,{mode:'on',repeat:30});
   assert.equal((await f.request({action:'feedback',owner:101,update:{operation:'list'}})).status,403);
 }
});

test('thanks is registered once before pairing without creating a subscription',async()=>{
 const f=fixture(),secret='e'.repeat(64);
 const env={KATKA_CLOUD_SECRET:secret,PAIRINGS:{idFromName:n=>n,get:()=>({fetch:(_,init)=>f.request(JSON.parse(init.body))})}};
 const request=(path,owner)=>worker.fetch(new Request('https://example.test/service/'+path,{
   method:'POST',headers:{Authorization:'Bearer '+secret},body:JSON.stringify({owner}),
 }),env);
 f.rows.set('language:303','ru');
 assert.deepEqual(await (await request('thanks',303)).json(),{language:'ru',registered:true});
 const registered=f.rows.get('thanks:303');assert.ok(registered.registered);
 assert.equal((await request('pro',303)).status,200);
 assert.deepEqual(f.rows.get('thanks:303'),registered);assert.equal(f.rows.has('proTrial:303'),false);
 assert.equal((await request('thanks',-1)).status,400);
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
