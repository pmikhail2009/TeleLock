import test from 'node:test';
import assert from 'node:assert/strict';
import { Pairing } from './worker.mjs';
const generation='a'.repeat(32);
function fixture() {
  const rows=new Map([['client:one',{owner:101,generation,since:0}],['owner:101','one'],['access:101',{tier:'test'}]]);
  let alarm;
  const storage={get:async key=>structuredClone(rows.get(key)),put:async(key,value)=>rows.set(key,structuredClone(value)),
    delete:async key=>rows.delete(key),transaction:async fn=>fn(storage),getAlarm:async()=>alarm,setAlarm:async value=>{alarm=value;},
    list:async({prefix})=>new Map([...rows].filter(([key])=>key.startsWith(prefix)))};
  const directory=new Pairing({storage},{KATKA_BOT_TOKEN:'mock'});
  const call=body=>directory.fetch(new Request('https://internal',{method:'POST',body:JSON.stringify({installation:'one',generation,...body})}));
  const command=(id,text='/play_normal',extra={})=>call({action:'command',update:{id,message:{chat:{id:101,type:'private'},from:{id:101},date:Math.floor(Date.now()/1000),text},...extra}});
  return {rows,directory,call,command};
}
async function mock(fn) {
  const original=globalThis.fetch, sent=[];
  globalThis.fetch=async(url,options)=>{sent.push({method:url.split('/').pop(),...JSON.parse(options.body)});return Response.json({ok:true,result:{message_id:42}});};
  try {await fn(sent);} finally {globalThis.fetch=original;}
}
test('one search card advances on confirmed result and match; replay never sends a second notification',async()=>mock(async sent=>{
  const f=fixture();
  assert.equal((await (await f.command(10)).json()).reply,null);
  assert.equal(sent.length,1); assert.equal(sent[0].method,'sendMessage');
  assert.match(sent[0].reply_markup.inline_keyboard[0][0].callback_data,/cancel:/);
  await f.call({action:'result',command:11,status:'queued'});
  assert.equal(sent[1].method,'editMessageText'); assert.match(sent[1].text,/Поиск матча начат/);
  await f.call({action:'match',match:'123',origin:'bot'});
  assert.equal(sent[2].method,'editMessageText'); assert.match(sent[2].text,/Матч найден/);
  assert.equal(sent[3].method,'sendMessage'); // A fresh push accompanies the edited card.
  await f.call({action:'match',match:'123',origin:'bot'});
  await f.call({action:'result',command:11,status:'queued'});
  assert.equal(sent.length,4);
}));
test('stale cancel buttons cannot cancel a newer search, duplicate commands do not create cards',async()=>mock(async sent=>{
  const f=fixture();await f.command(10);await f.command(10);assert.equal(sent.length,1);
  await f.command(12);
  const response=await (await f.command(14,'/cancel',{expectedCommand:11})).json();
  assert.match(response.reply.text,/завершённому/);
  assert.equal(f.rows.get('client:one').recent.length,2);
}));
test('heartbeat expires and telemetry rejects stale or foreign reports',async()=>{
  const f=fixture();const real=Date.now;let now=real();Date.now=()=>now;
  try {
    await f.call({action:'poll'});
    let status=await (await f.call({action:'status',owner:101})).json();assert.equal(status.live.online,true);assert.equal(status.live.state,'unknown');
    await f.call({action:'telemetry',telemetry:{state:'waiting',observed:now}});
    now+=4000;
    await f.call({action:'telemetry',telemetry:{state:'waiting',observed:now}});
    status=await (await f.call({action:'status',owner:101})).json();assert.equal(status.live.since,now-4000);
    assert.equal((await f.call({action:'telemetry',telemetry:{state:'idle',observed:now-30000}})).status,400);
    assert.equal((await f.call({action:'telemetry',generation:'b'.repeat(32),telemetry:{state:'idle',observed:now}})).status,409);
    now+=31000;status=await (await f.call({action:'status',owner:101})).json();assert.equal(status.live.online,false);assert.equal(status.live.state,'unknown');
  } finally {Date.now=real;}
});
test('server preferences suppress pushes but complete cards, restrict free settings and schedule one reminder',async()=>mock(async sent=>{
  const f=fixture();await f.command(10);
  await f.call({action:'settings',owner:101,update:{mode:'off',repeat:15}});
  await f.call({action:'match',match:'123',origin:'bot'});
  assert.equal(sent.filter(x=>x.method==='sendMessage').length,1);
  assert.match(sent.at(-1).text,/Матч найден/);
  await f.call({action:'settings',owner:101,update:{mode:'on',repeat:15}});
  await f.call({action:'match',match:'124',origin:'manual'});
  const task=f.rows.get('task:repeat:one:'+generation);assert.ok(task);
  task.at=0;await f.directory.alarm();await f.directory.alarm();
  assert.equal(sent.filter(x=>x.text.includes('Напоминание:')).length,1);
  f.rows.delete('access:101');
  assert.equal((await f.call({action:'settings',owner:101,update:{mode:'on'}})).status,403);
  assert.equal((await f.call({action:'testbot',owner:101})).status,403);
  assert.deepEqual(await f.directory.preferences(101),{mode:'auto',repeat:0});
}));
test('missing game confirmation terminates the card; alarms preserve bindings',async()=>mock(async sent=>{
  const f=fixture();await f.command(10);f.rows.get('task:card:one:'+generation).at=0;
  await f.directory.alarm();assert.match(sent.at(-1).text,/не подтвердила/);assert.ok(f.rows.has('client:one'));
}));
test('server test completes without the game second request; edit failure leaves a definitive success message',async()=>{
  const f=fixture(),original=globalThis.fetch,sent=[];
  globalThis.fetch=async(url,options)=>{sent.push(JSON.parse(options.body));if(url.endsWith('/editMessageText'))throw new Error('offline');return Response.json({ok:true,result:{message_id:42}});};
  try {
    const response=await (await f.call({action:'testbot',owner:101})).json();
    assert.equal(response.delivery,'delivered');assert.match(sent[0].text,/получено/);assert.doesNotMatch(sent[0].text,/Измеряем/);
  } finally {globalThis.fetch=original;}
});

test('late cancellation result cannot overwrite a newer search card',async()=>mock(async sent=>{
 const f=fixture();await f.command(10);await f.command(12,'/cancel',{expectedCommand:11});await f.command(14);
 await f.call({action:'result',command:13,status:'cancelled'});
 const card=f.rows.get('card:one:'+generation);assert.equal(card.command,15);assert.equal(card.finished,false);
 assert.doesNotMatch(sent.filter(x=>x.method==='editMessageText').at(-1).text,/Поиск матча отменён/);
}));
test('lost edit response retries the same card safely',async()=>{
 const f=fixture();await mock(async()=>{await f.command(10);});
 const original=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('lost response');};
 try {
  const result=await f.call({action:'result',command:11,status:'queued'});assert.equal(result.status,503);
  f.rows.get('commandResult:one:'+generation+':11').retryAt=0;
 } finally {globalThis.fetch=original;}
 await mock(async sent=>{await f.call({action:'result',command:11,status:'queued'});assert.equal(sent.length,1);assert.equal(sent[0].method,'editMessageText');});
});
