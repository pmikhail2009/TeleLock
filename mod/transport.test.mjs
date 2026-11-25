import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Pairing } from '../gateway/worker.mjs';

const html = await readFile(new URL('./panel/index.html', import.meta.url), 'utf8');
const helpers = html.slice(html.indexOf('// These records belong'), html.indexOf('function render()'));
const loops = html.slice(html.indexOf('function commandLoop('), html.indexOf('async function reportMatch()'));
const generation = 'a'.repeat(32);

function installation() {
  let state = {active:undefined, receipt:undefined, outbox:[]}, tail=Promise.resolve(), now=Date.now();
  const calls = [];
  let nextPoll={generation,command:null}, networkError=null, reportError=null;
  const transaction = change => {
    const next=tail.then(()=>{const copy=structuredClone(state), result=change(copy);state=copy;return structuredClone(result);});
    tail=next.catch(()=>{});return next;
  };
  const clock = class extends Date { static now(){return now;} };
  function context(view, hash='', onTitle) {
    const location={hash}; let pulse, title='';
    const document={};
    Object.defineProperty(document,'title',{get:()=>title,set:value=>{
      title=value;
      if(onTitle)onTitle(value,next=>{location.hash=next;pulse?.();});
    }});
    const sandbox = {document,location,Date:clock,Number,JSON,Error,Math,testStore:transaction,
      window:{addEventListener:(name,fn)=>{pulse=fn;}},
      api:async(action,body)=>{
        calls.push({action,body:structuredClone(body)});
        if(action==='poll'){if(networkError)throw networkError;return structuredClone(nextPoll);}
        if(action==='result'){if(reportError)throw reportError;return {accepted:true,delivery:'delivered'};}
        throw new Error('Unexpected API action '+action);
      }};
    vm.runInNewContext(helpers+'\ncommandStore=testStore;\n'+loops+'\n'+view+'();',sandbox);
    return {document,location,send:async value=>{location.hash=value;await pulse();await drain();}};
  }
  async function drain(){for(let i=0;i<5;i++){await tail;await new Promise(resolve=>setImmediate(resolve));}}
  return {context,drain,calls,get state(){return state;},get now(){return now;},
    advance:ms=>{now+=ms;}, poll:value=>{nextPoll=value;}, network:error=>{networkError=error;},
    resultError:error=>{reportError=error;},
    command:(id=9,action='/play_normal')=>({generation,command:{id,action,expires:now+30000}})};
}

test('one native pulse stores a command before title delivery without browser timers',async()=>{
  const app=installation();app.poll(app.command());
  const first=app.context('commandLoop','#poll=1:');await app.drain();
  assert.match(first.document.title,/^katka:a{32}:9:\/play_normal:/);
  assert.equal(app.calls.filter(call=>call.action==='poll').length,1);
  assert.equal(app.state.active.phase,'received');
  assert.equal(app.state.active.expires,app.now+15000);
  assert.deepEqual(app.state.receipt,{generation,id:9});
});

test('a recreated command frame acknowledges durable receipt without repeating a mode command',async()=>{
  const app=installation();app.poll(app.command());app.context('commandLoop','#poll=1:');await app.drain();
  const second=app.context('commandLoop','#poll=2:');await app.drain();
  assert.equal(second.document.title,'owner:'+generation+':2');
  const request=app.calls.filter(call=>call.action==='poll').at(-1);
  assert.equal(request.body.ack,9);assert.equal(request.body.generation,generation);
});

test('approval is durable before execute and only one recreated popup can claim it',async()=>{
  const app=installation();app.poll(app.command());
  const controller=app.context('commandLoop','#poll=1:');await app.drain();
  const early=app.context('rosterLoop','#2:ready');await app.drain();assert.equal(early.document.title,'roster:none:2');
  await controller.send('#approve='+generation+':9:3');
  assert.equal(app.state.active.phase,'armed');assert.match(controller.document.title,/^execute:/);
  const one=app.context('rosterLoop','#4:ready'),two=app.context('rosterLoop','#5:ready');await app.drain();
  assert.equal([one,two].filter(item=>/^roster:a/.test(item.document.title)).length,1);
  assert.equal(app.state.active.phase,'activation_reserved');
  const receiver=/^roster:a/.test(one.document.title)?one:two;
  await receiver.send('#ack='+generation+':9:event_sent:6');
  assert.equal(app.state.active.phase,'event_sent');assert.equal(app.calls.some(call=>call.action==='result'),false);
});

test('native approval and popup acknowledgement arriving during title publication are not lost',async()=>{
  const app=installation();app.poll(app.command());
  const controller=app.context('commandLoop','#poll=1:',(title,send)=>{
    if(title.startsWith('katka:'))send('#approve='+generation+':9:2');
  });
  await app.drain();
  assert.equal(app.state.active.phase,'armed');assert.match(controller.document.title,/^execute:/);
  const popup=app.context('rosterLoop','#3:ready',(title,send)=>{
    if(title.startsWith('roster:'+generation))send('#ack='+generation+':9:event_sent:4');
  });
  await app.drain();
  assert.equal(app.state.active.phase,'event_sent');assert.equal(popup.document.title,'roster:none:4');
});

test('actual queue observation reports success across independent windows only once',async()=>{
  const app=installation();app.poll(app.command());const controller=app.context('commandLoop','#poll=1:');await app.drain();
  await controller.send('#approve='+generation+':9:2');app.context('rosterLoop','#3:ready');await app.drain();
  const first=app.context('queueStateLoop','#'+app.now+':waiting');await app.drain();
  assert.equal(first.document.title,'state:'+app.now);assert.equal(app.state.active.outcome,'queued');
  assert.deepEqual(app.calls.filter(call=>call.action==='result').map(call=>call.body),[{generation,command:9,status:'queued'}]);
  app.context('queueStateLoop','#'+app.now+':waiting');await app.drain();
  assert.equal(app.calls.filter(call=>call.action==='result').length,1);
});

test('cancel invalidates the old popup command and requires a fresh idle observation',async()=>{
  const app=installation();app.poll(app.command());const controller=app.context('commandLoop','#poll=1:');await app.drain();
  await controller.send('#approve='+generation+':9:2');const old=app.now;
  app.advance(1000);app.poll(app.command(10,'/cancel'));await controller.send('#poll=3:');
  const popup=app.context('rosterLoop','#4:ready');await app.drain();
  assert.equal(popup.document.title,'roster:none:4');assert.equal(app.state.active.action,'/cancel');
  app.context('queueStateLoop','#'+old+':idle');await app.drain();assert.equal(app.state.active.outcome,undefined);
  app.context('queueStateLoop','#'+app.now+':idle');await app.drain();assert.equal(app.state.active.outcome,'cancelled');
});

test('watch preserves pending play but updates durable acknowledgement',async()=>{
  const app=installation();app.poll(app.command());const controller=app.context('commandLoop','#poll=1:');await app.drain();
  await controller.send('#approve='+generation+':9:2');app.poll(app.command(10,'/watch_black'));await controller.send('#poll=3:');
  assert.equal(app.state.active.id,9);assert.equal(app.state.active.phase,'armed');assert.equal(app.state.receipt.id,10);
});

test('timeout never activates popup and persists an unconfirmed report',async()=>{
  const app=installation();app.poll(app.command());const controller=app.context('commandLoop','#poll=1:');await app.drain();
  await controller.send('#approve='+generation+':9:2');app.advance(15001);
  const popup=app.context('rosterLoop','#3:ready');await app.drain();
  assert.equal(popup.document.title,'roster:none:3');assert.equal(app.state.active.outcome,'unconfirmed');
  assert.equal(app.calls.filter(call=>call.action==='result').at(-1).body.status,'unconfirmed');
});

test('network errors preserve state while a real generation conflict invalidates it',async()=>{
  const app=installation();app.poll(app.command());const controller=app.context('commandLoop','#poll=1:');await app.drain();
  app.network(new Error('offline'));await controller.send('#poll=7:');
  assert.equal(controller.document.title,'transport:offline:7');assert.equal(app.state.active.id,9);
  app.network(Object.assign(new Error('changed binding'),{httpStatus:409}));await controller.send('#poll=8:');
  assert.equal(controller.document.title,'owner:none:8');assert.equal(app.state.active,undefined);assert.equal(app.state.receipt,undefined);
});

test('already-open refusal prevents any later popup activation',async()=>{
  const app=installation();app.poll(app.command());app.context('commandLoop','#poll=1:');await app.drain();
  const result=app.context('commandResultLoop','#2:'+generation+':9:already_open');await app.drain();
  assert.equal(result.document.title,'result:'+generation+':9');
  const controller=app.context('commandLoop');await controller.send('#approve='+generation+':9:3');
  assert.equal(controller.document.title,'execute:none:3');
  const popup=app.context('rosterLoop','#4:ready');await app.drain();assert.equal(popup.document.title,'roster:none:4');
});

test('a recreated result frame retries its durable outbox after a network error',async()=>{
  const app=installation();app.resultError(new Error('offline'));
  const result=app.context('commandResultLoop','#1:'+generation+':9:unconfirmed');await app.drain();
  assert.equal(result.document.title,'result:'+generation+':9');assert.equal(app.state.outbox[0].delivered,false);
  app.advance(1600);app.resultError(null);app.context('queueStateLoop','#'+app.now+':unknown');await app.drain();
  assert.equal(app.calls.filter(call=>call.action==='result').length,2);assert.equal(app.state.outbox[0].delivered,true);
});

test('party readiness and connecting never count as a started search',async()=>{
  for(const value of ['party','connecting','unknown']){
    const app=installation();app.poll(app.command());const controller=app.context('commandLoop','#poll=1:');await app.drain();
    await controller.send('#approve='+generation+':9:2');app.context('queueStateLoop','#'+app.now+':'+value);await app.drain();
    assert.equal(app.state.active.outcome,undefined);assert.equal(app.calls.some(call=>call.action==='result'),false);
  }
});

test('poll resolves its installation, returns expiry and rejects another generation',async()=>{
  const binding={generation,owner:101,recent:[{id:9,action:'/play_normal',expires:Date.now()+10000}]};
  const values=new Map([['client:one',binding]]);
  const storage={get:async k=>values.get(k),put:async(k,v)=>values.set(k,v),transaction:async fn=>fn(storage)};
  const directory=new Pairing({storage},{});
  const poll=payload=>directory.fetch(new Request('https://mock.invalid',{method:'POST',body:JSON.stringify({action:'poll',installation:'one',...payload})}));
  const first=await(await poll({})).json();assert.equal(first.generation,generation);assert.equal(first.command.expires,binding.recent[0].expires);
  assert.equal((await poll({generation:'b'.repeat(32),ack:9})).status,409);
  assert.equal((await(await poll({generation,ack:9})).json()).command,null);
});
