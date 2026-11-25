import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Pairing } from './worker.mjs';
import { createHash } from 'node:crypto';
const generation='a'.repeat(32);
function fixture() {
  const rows=new Map([['client:one',{owner:101,generation,since:0}],['owner:101','one'],['access:101',{tier:'test'}]]);
  const background = [];
  let alarm;
  const storage={get:async key=>structuredClone(rows.get(key)),put:async(key,value)=>rows.set(key,structuredClone(value)),
    delete:async key=>rows.delete(key),transaction:async fn=>fn(storage),getAlarm:async()=>alarm,setAlarm:async value=>{alarm=value;},
    list:async({prefix, startAfter = '', limit})=>new Map([...rows]
      .filter(([key])=>key.startsWith(prefix) && key > startAfter)
      .sort(([first], [second])=>first.localeCompare(second)).slice(0, limit))};
  const directory=new Pairing({storage,waitUntil:task=>background.push(task)},{KATKA_BOT_TOKEN:'mock'});
  const call=body=>directory.fetch(new Request('https://internal',{method:'POST',body:JSON.stringify({installation:'one',generation,...body})}));
  const command=(id,text='/play_normal',extra={})=>call({action:'command',update:{id,message:{chat:{id:101,type:'private'},from:{id:101},date:Math.floor(Date.now()/1000),text},...extra}});
  return {rows,directory,call,command,drainNotifications:()=>Promise.all(background.splice(0))};
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
  assert.equal(sent[1].method,'editMessageText'); assert.match(sent[1].text,/Matchmaking started/);
  await f.call({action:'match',match:'123',origin:'bot'});
  assert.equal(sent[2].method,'editMessageText'); assert.match(sent[2].text,/Match found/);
  assert.equal(sent[3].method,'sendMessage'); // A fresh push accompanies the edited card.
  await f.call({action:'match',match:'123',origin:'bot'});
  await f.call({action:'result',command:11,status:'queued'});
  assert.equal(sent.length,4);
}));
test('stale cancel buttons cannot cancel a newer search, duplicate commands do not create cards',async()=>mock(async sent=>{
  const f=fixture();await f.command(10);await f.command(10);assert.equal(sent.length,1);
  await f.command(12);
  const response=await (await f.command(14,'/cancel',{expectedCommand:11})).json();
  assert.match(response.reply.text,/search that has ended/);
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
test('server preferences suppress pushes but complete cards, allow ordinary settings and schedule one reminder',async()=>mock(async sent=>{
  const f=fixture();await f.command(10);
  await f.call({action:'settings',owner:101,update:{mode:'off',repeat:15}});
  await f.call({action:'match',match:'123',origin:'bot'});
  assert.equal(sent.filter(x=>x.method==='sendMessage').length,1);
  assert.match(sent.at(-1).text,/Match found/);
  await f.call({action:'settings',owner:101,update:{mode:'on',repeat:15}});
  await f.call({action:'match',match:'124',origin:'manual'});
  const task=f.rows.get('task:repeat:one:'+generation);assert.ok(task);
  task.at=0;await f.directory.alarm();await f.directory.alarm();
  assert.equal(sent.filter(x=>x.text.includes('Reminder:')).length,1);
  f.rows.delete('access:101');
  assert.equal((await f.call({action:'settings',owner:101,update:{mode:'on'}})).status,200);
  assert.equal((await f.call({action:'testbot',owner:101})).status,200);
  assert.deepEqual(await f.directory.preferences(101),{mode:'on',repeat:15});
}));
test('missing game confirmation terminates the card; alarms preserve bindings',async()=>mock(async sent=>{
  const f=fixture();await f.command(10);f.rows.get('task:card:one:'+generation).at=0;
  await f.directory.alarm();assert.match(sent.at(-1).text,/did not confirm/);assert.ok(f.rows.has('client:one'));
}));
test('server test completes without the game second request; edit failure leaves a definitive success message',async()=>{
  const f=fixture(),original=globalThis.fetch,sent=[];
  globalThis.fetch=async(url,options)=>{sent.push(JSON.parse(options.body));if(url.endsWith('/editMessageText'))throw new Error('offline');return Response.json({ok:true,result:{message_id:42}});};
  try {
    const response=await (await f.call({action:'testbot',owner:101})).json();
    assert.equal(response.delivery,'delivered');assert.match(sent[0].text,/received/);assert.doesNotMatch(sent[0].text,/Measuring/);
  } finally {globalThis.fetch=original;}
});

test('late cancellation result cannot overwrite a newer search card',async()=>mock(async sent=>{
 const f=fixture();await f.command(10);await f.command(12,'/cancel',{expectedCommand:11});await f.command(14);
 await f.call({action:'result',command:13,status:'cancelled'});
 const card=f.rows.get('card:one:'+generation);assert.equal(card.command,15);assert.equal(card.finished,false);
 assert.doesNotMatch(sent.filter(x=>x.method==='editMessageText').at(-1).text,/Matchmaking cancelled/);
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

test('language syncs through both authenticated entry points on free accounts', async () => mock(async sent => {
  const f = fixture();
  const key = 'b'.repeat(64), secret = 'c'.repeat(64);
  const installation = createHash('sha256').update(key).digest('hex');
  f.rows.set('client:' + installation, f.rows.get('client:one'));
  f.rows.delete('client:one');
  f.rows.set('owner:101', installation);
  f.rows.delete('access:101');
  const env = { KATKA_CLOUD_SECRET:secret, PAIRINGS:{idFromName:name=>name,get:()=>({
    fetch:(url, init)=>f.directory.fetch(new Request(url,init)),
  })} };
  const request = (path, body = {}, token = path.startsWith('/service/') ? secret : key) => worker.fetch(
    new Request('https://gateway.invalid'+path,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(body)}),env);
  const gameStatus = async () => (await request('/v1/status')).json();
  const accountStatus = async owner => (await request('/service/status',{owner})).json();
  assert.equal((await gameStatus()).language,'en');
  assert.equal((await request('/service/language',{owner:101,language:'ru'},key)).status,403);
  assert.equal((await request('/v1/language',{generation:'d'.repeat(32),language:'ru'})).status,409);
  assert.equal((await request('/v1/language',{generation,language:'fr'})).status,400);
  assert.equal((await request('/service/language',{owner:101,language:'ru'})).status,200);
  await f.drainNotifications();
  assert.equal((await gameStatus()).language,'ru');
  assert.equal((await accountStatus(202)).language,'en');
  assert.ok(sent.at(-1).reply_markup.keyboard.flat().includes('⚙️ Центр управления'));
  await request('/v1/match',{generation,match:'123',origin:'bot'});
  assert.match(sent.at(-1).text,/Матч найден/);
  const change = {generation,owner:202,language:'en'};
  const before = sent.length;
  await request('/v1/language', change);
  await request('/v1/language', change);
  await f.drainNotifications();
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).chat_id,101);
  assert.ok(sent.at(-1).reply_markup.keyboard.flat().includes('⚙️ Control Center'));
  assert.equal((await accountStatus(101)).language,'en');
  // A preference set before pairing remains available when a game is connected.
  await request('/service/language',{owner:202,language:'ru'});
  await f.drainNotifications();
  assert.equal((await accountStatus(202)).generation,null);
  assert.equal((await accountStatus(202)).language,'ru');
  assert.equal((await gameStatus()).language,'en');
}));

test('the language save returns before Telegram finishes updating its keyboard', {timeout:2000}, async () => {
  const f = fixture();
  let acknowledge;
  const telegramResponse = new Promise(resolve => { acknowledge = resolve; });
  f.directory.telegram = () => telegramResponse;
  try {
    const response = await f.call({action:'language',language:'ru'});
    assert.deepEqual(await response.json(),{language:'ru'});
    assert.equal((await (await f.call({action:'status',owner:101})).json()).language,'ru');
  } finally {
    acknowledge();
    await f.drainNotifications();
  }
});

test('five distinct confirmed launches trigger one localized rating request', async () => mock(async sent => {
  const f = fixture();
  f.rows.set('language:101', 'ru');
  const prompts = () => sent.filter(item => item.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === 'feedback:rate:1');
  await f.command(90);
  await f.call({action:'result',command:91,status:'failed'});
  for (let id = 100; id < 106; id++) {
    await f.command(id);
    await f.call({action:'result',command:id+1,status:'queued'});
    await f.call({action:'result',command:id+1,status:'queued'});
    const reminder = f.rows.get('task:feedback:101');
    if (reminder) {
      assert.equal(id,104);
      reminder.at = 0;
      await f.directory.alarm();
    }
    assert.equal(prompts().length, id >= 104 ? 1 : 0);
  }
  assert.match(prompts()[0].text, /Я Михаил/);
  assert.deepEqual(prompts()[0].reply_markup.inline_keyboard[0].map(button=>button.text), ['1','2','3','4','5']);
}));

test('ratings are account-scoped, written reviews are idempotent and access is checked on every page', async () => {
  const f = fixture();
  const call = (owner, operation, extra={}) => f.call({action:'feedback',owner,update:{operation,...extra}});
  const json = async (...args) => (await call(...args)).json();
  assert.equal((await call(201,'rate',{value:6})).status,400);
  assert.equal((await json(201,'rate',{value:4})).rating,4);
  assert.equal((await json(201,'rate',{value:5})).rating,4);
  assert.equal((await json(202,'rate',{value:1})).rating,1);
  assert.equal((await call(201,'list')).status,403);
  assert.equal((await call(201,'write',{text:' ',date:10,id:10})).status,400);
  for (let id=1; id<=4; id++) {
    const input = {text:'Review '+id,date:100+id,id};
    assert.equal((await json(201,'write',input)).saved,true);
    await call(201,'write',input);
  }
  const first = await json(101,'list');
  assert.deepEqual(first.counts,[1,0,0,1,0]);
  assert.deepEqual(first.texts,['Review 4','Review 3','Review 2']);
  f.rows.set('access:202',{tier:'owner'});
  const second = await json(202,'list',{cursor:first.next});
  assert.deepEqual(second.texts,['Review 1']);
  assert.equal(second.next,null);
  f.rows.delete('access:101');
  assert.equal((await call(101,'list',{cursor:first.next})).status,403);
});
