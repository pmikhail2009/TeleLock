import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./panorama/scripts/katka_roster.js',import.meta.url),'utf8');
function popup({diagnostic=false,enabled=true,visible=true,hidden=false,throws=false}={}) {
  const urls=[],events=[],tasks=[]; let receive;
  const frame={SetURL:url=>urls.push(url)}, button={visible:true,enabled};
  const label={style:{}};
  const panel={visible,BHasClass:()=>hidden,FindChildTraverse:id=>id==='KatkaRosterTransport'?frame:id==='ConfirmButton'?button:label};
  vm.runInNewContext(source.replace('"KATKA_DIAGNOSTIC_ONLY"',JSON.stringify(String(diagnostic))),{Date,$:{
    GetContextPanel:()=>panel,Schedule:(delay,fn)=>tasks.push(fn),RegisterEventHandler:(name,target,fn)=>{receive=fn;},
    DispatchEvent:(name,target,event)=>{assert.equal(target,button);assert.equal(event,'onactivate');events.push(name);if(throws)throw Error('handler failed');}
  }});
  return {urls,events,button,label,receive:title=>receive(null,title),tick:()=>tasks.shift()?.()};
}
const title=(expires=Date.now()+10000)=>'roster:'+'a'.repeat(32)+':17:/play_normal:'+expires+':1';
test('popup confirms a durable claim in its own context with no parent/root dependency',()=>{
  const c=popup(); c.receive(title());
  assert.deepEqual(c.events,['DispatchPanelEvent']); assert.match(c.urls.at(-1),/#ack=a{32}:17:event_sent:/);
  c.receive(title());assert.equal(c.events.length,1);
  assert.equal(c.label.style.visibility,'collapse');
});
test('expired and disabled requests never activate the button',()=>{
  for(const c of [popup(),popup({enabled:false})]) {
    c.receive(title(c.button.enabled?Date.now()-1:Date.now()+10000));
    assert.deepEqual(c.events,[]);assert.match(c.urls.at(-1),/:failed:/);
  }
});
test('diagnostic build cannot activate the real button',()=>{
  const c=popup({diagnostic:true}); c.receive(title());assert.deepEqual(c.events,[]);
});

test('hidden popup cannot invoke the stock handler',()=>{
  for(const c of [popup({visible:false}),popup({hidden:true})]) {
    c.receive(title());assert.deepEqual(c.events,[]);assert.match(c.urls.at(-1),/:failed:/);
  }
});

test('duplicate failed claims preserve failure and cannot retry the handler',()=>{
  for(const c of [popup({enabled:false}),popup({throws:true})]) {
    c.receive(title());const count=c.events.length;
    c.button.enabled=true;c.receive(title());
    assert.equal(c.events.length,count);assert.match(c.urls.at(-1),/:failed:/);
  }
});
test('popup transport waits for ready and does not interrupt a busy operation',()=>{
  const c=popup(); c.tick();assert.equal(c.urls.length,1);
  c.receive('ready:roster');c.tick();assert.match(c.urls.at(-1),/:ready$/);
  const count=c.urls.length;c.tick();assert.equal(c.urls.length,count);
  c.receive('roster:none:2');c.tick();assert.equal(c.urls.length,count+1);
});
