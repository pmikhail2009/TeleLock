import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Pairing } from './worker.mjs';

const generation = 'a'.repeat(32);
function fixture() {
  const values = new Map([['access:101', {tier:'test'}], ['client:one', {owner:101,generation}]]);
  const storage = {get:async key=>structuredClone(values.get(key)),
    put:async(key,value)=>values.set(key,structuredClone(value))};
  const directory = new Pairing({storage},{KATKA_BOT_TOKEN:'mock'});
  const call = (body={})=>directory.fetch(new Request('https://internal.invalid', {
    method:'POST', body:JSON.stringify({action:'test',installation:'one',generation,...body}),
  }));
  return {values,call};
}

test('test receipt edits only the original message with milliseconds and seconds', async () => {
  const f=fixture(), sent=[], original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    sent.push({url,body:JSON.parse(init.body)});
    return Response.json({ok:true,result:{message_id:42}});
  };
  try {
    const result=await (await f.call()).json();
    assert.equal(result.delivery,'delivered');
    assert.match(sent[0].body.text,/Telelock test notification received/);
    assert.match(sent[1].body.text,/Telegram acknowledged the server request/);
    assert.equal((await f.call({test:result.test,elapsed:1234})).status,200);
    assert.match(sent[2].url,/\/editMessageText$/);
    assert.deepEqual(sent[2].body,{chat_id:101,message_id:42,
      text:'✅ In-game test: 1234 ms (1.234 s) until the server responded.'});
    assert.equal((await f.call({test:result.test,elapsed:5678})).status,409);
    assert.equal((await f.call({installation:'other',test:result.test,elapsed:1234})).status,409);
    assert.equal((await f.call({generation:'b'.repeat(32),test:result.test,elapsed:1234})).status,409);
    assert.equal((await f.call({test:result.test,elapsed:-1})).status,400);
    assert.equal((await f.call({test:result.test,elapsed:Infinity})).status,400);
    assert.equal((await f.call({test:result.test,elapsed:120001})).status,400);
    assert.equal(sent.length,3);
    f.values.get('test:one').expires=0;
    assert.equal((await f.call({test:result.test,elapsed:1234})).status,409);
  } finally {globalThis.fetch=original;}
});

test('Telegram failures and malformed success never count as delivered',async()=>{
  const f=fixture(), original=globalThis.fetch;
  try {
    for(const reply of [()=>Response.json({ok:false},{status:429}),
      ()=>Response.json({ok:true}), ()=>{throw new Error('offline');}]) {
      globalThis.fetch=reply;
      assert.equal((await f.call()).status,503);
      assert.equal(f.values.get('test:one'),undefined);
    }
  } finally {globalThis.fetch=original;}
});

test('public endpoint derives installation from bearer and forwards measurement only',async()=>{
  let forwarded;
  const response=await worker.fetch(new Request('https://gateway.invalid/v1/test',{
    method:'POST',headers:{Authorization:'Bearer '+'c'.repeat(64)},
    body:JSON.stringify({generation,test:'receipt',elapsed:987,installation:'other',owner:999}),
  }),{PAIRINGS:{idFromName:name=>name,get:()=>({fetch:async(url,init)=>{
    forwarded=JSON.parse(init.body);return Response.json({delivery:'delivered'});
  }})}});
  assert.equal(response.status,200);
  assert.match(forwarded.installation,/^[a-f0-9]{64}$/);
  assert.equal(forwarded.owner,undefined);
  assert.equal(forwarded.elapsed,987);
  assert.equal(forwarded.test,'receipt');
});
