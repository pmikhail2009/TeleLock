import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./panel/index.html', import.meta.url), 'utf8');
const generation = 'a'.repeat(32), replacement = 'b'.repeat(32);
const scope = 'https://gateway.invalid', key = 'telelock_profile_v1';
const initial = {version:1,scope,generation,tier:'test',language:'ru',mode:'off',pending:{},epoch:'binding-a',revision:'initial'};
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const drain = () => new Promise(resolve => setImmediate(resolve));

function client({storage = new Map([[key,JSON.stringify(initial)]]), request = async () => ({generation,tier:'test',language:'ru',settings:{mode:'off'}}), auto = false, protocol = true, storageFails = false} = {}) {
  const titles = [], calls = [], elements = {};
  let receive;
  const location = {search:'?view=native' + (protocol?'&profile=1':''),hash:auto?'#1:status:':'',origin:scope};
  const document = {querySelector:()=>({content:scope}),getElementById:id=>elements[id] ||= {},
    set title(value) {titles.push(value);},get title(){return titles.at(-1);}};
  const script = html.split('<script>')[1].split('</script>')[0].replace('const view =', `
    api = async (action, body) => {
      try { const value = await window.request(action, body); online = true; return value; }
      catch (error) { online = false; throw error; }
    };
    observeGeneration = async () => {};
    Object.assign(globalThis, {readProfile,saveLocalPreference,syncPreferences,refreshProfile,cacheBinding});
    const view =`);
  const context = vm.createContext({document,location,URLSearchParams,performance,
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>{if(storageFails)throw new Error('Disk unavailable');storage.set(k,v);}},
    window:{addEventListener(name,fn){receive=fn;},async request(action,body){calls.push({action,body});return request(action,body);}}});
  vm.runInContext(script,context);
  return {storage,titles,calls,context,async send(id,action,value=''){location.hash=`#${id}:${action}:${value}`;await receive();}};
}

test('native menu publishes the saved profile before the network responds', async () => {
  const response = deferred();
  const app = client({auto:true,request:()=>response.promise});
  assert.match(app.titles[0],/^native:1:cached_linked:cached:none:off:test:ru:pending,0,0$/);
  assert.equal(app.calls.length,1);
  response.resolve({generation,tier:'test',language:'ru',settings:{mode:'off'}});
  await drain();
  assert.match(app.titles.at(-1),/^native:1:linked:status:/);
});

test('offline preferences survive recreation and sync from the next status check', async () => {
  const storage = new Map([[key,JSON.stringify(initial)]]);
  const offline = client({storage,request:async()=>{throw Object.assign(new Error('offline'),{connectionFailure:'network'});}});
  await offline.send(1,'language','en');
  await offline.send(2,'notifications','on');
  let saved = JSON.parse(storage.get(key));
  assert.equal(saved.language,'en');assert.equal(saved.mode,'on');
  assert.equal(saved.pending.language.value,'en');assert.equal(saved.pending.notifications.value,'on');
  assert.ok(offline.titles.some(title=>title.includes(':saved:')));
  const restored = client({storage,async request(action,body){
    return action === 'status' ? {generation,tier:'test',language:'ru',settings:{mode:'off'}}
      : action === 'language' ? {language:body.language} : {settings:{mode:body.telemetry.mode}};
  }});
  await restored.send(3,'status');
  assert.deepEqual(restored.calls.map(call=>call.action),['status','language','settings']);
  saved = JSON.parse(storage.get(key));
  assert.equal(saved.language,'en');assert.equal(saved.mode,'on');assert.deepEqual(saved.pending,{});
});

test('an older save acknowledgement cannot discard a newer local edit', async () => {
  const first = deferred();let saves=0;
  const app = client({request:async(action,body)=>++saves===1 ? first.promise : {language:body.language}});
  const saving = app.send(1,'language','en');
  await drain();
  app.context.saveLocalPreference('language','ru');
  first.resolve({language:'en'});
  await saving;
  assert.deepEqual(app.calls.map(call=>call.body.language),['en','ru']);
  assert.equal(app.context.readProfile().language,'ru');
  assert.deepEqual(Object.keys(app.context.readProfile().pending),[]);
});

test('a stale status cannot roll back an edit that was already synchronized', async () => {
  const status = deferred();
  const app = client({request:async(action,body)=>action==='status'?status.promise:{language:body.language}});
  const checking = app.context.refreshProfile();
  await app.send(2,'language','en');
  status.resolve({generation,tier:'test',language:'ru',settings:{mode:'off'}});
  await checking;
  assert.equal(app.context.readProfile().language,'en');
});

test('a late status cannot restore an explicitly removed binding', async () => {
  const response = deferred();
  const app = client({request:()=>response.promise});
  const checking = app.context.refreshProfile();
  app.context.cacheBinding(null);
  response.resolve({generation,tier:'test',language:'ru'});
  await checking;
  assert.equal(app.context.readProfile().generation,null);
  assert.equal(app.context.readProfile().tier,'free');
});

test('a replacement binding discards pending edits belonging to the old account', async () => {
  const app = client({request:async()=>({generation:replacement,tier:'free',language:'en',settings:{mode:'auto'}})});
  app.context.saveLocalPreference('language','ru');
  app.context.saveLocalPreference('notifications','on');
  await app.send(1,'status');
  const saved=app.context.readProfile();
  assert.equal(saved.generation,replacement);assert.equal(saved.language,'en');assert.equal(saved.mode,'auto');
  assert.deepEqual(Object.keys(saved.pending),[]);
  assert.deepEqual(app.calls.map(call=>call.action),['status']);
});

test('a language chosen before the first status response remains the user choice', async () => {
  const status=deferred();
  const app=client({storage:new Map(),request:async(action,body)=>action==='status'?status.promise:{language:body.language}});
  const checking=app.context.refreshProfile();
  app.context.saveLocalPreference('language','ru');
  status.resolve({generation,tier:'test',language:'en'});
  await checking;await app.context.syncPreferences();
  assert.equal(app.context.readProfile().language,'ru');
  assert.equal(app.calls.at(-1).body.language,'ru');
});

test('malformed profiles and profiles for another gateway are ignored', () => {
  for(const value of ['{broken',JSON.stringify({...initial,scope:'https://other.invalid'}),JSON.stringify({...initial,tier:'admin'})]) {
    const app=client({storage:new Map([[key,value]])});
    assert.equal(app.context.readProfile().generation,null);
    assert.equal(app.context.readProfile().tier,'free');
  }
});

test('a rejected stale preference refreshes the binding instead of retrying forever', async () => {
  const app=client({async request(action){
    if(action==='language')throw Object.assign(new Error('Binding replaced'),{httpStatus:409});
    return {generation:replacement,tier:'free',language:'en',settings:{mode:'auto'}};
  }});
  await app.send(1,'language','ru');
  assert.equal(app.context.readProfile().generation,replacement);
  assert.deepEqual(Object.keys(app.context.readProfile().pending),[]);
  assert.deepEqual(app.calls.map(call=>call.action),['language','status']);
});

test('unavailable disk storage does not block online status or claim a successful local save', async () => {
  const app=client({storageFails:true,request:async()=>({generation:replacement,tier:'test',language:'en',settings:{mode:'on'}})});
  await app.send(1,'status');
  assert.equal(app.context.readProfile().generation,replacement);
  await app.send(2,'language','ru');
  assert.match(app.titles.at(-1),/:connection_storage:/);
  assert.equal(app.context.readProfile().language,'en');
  assert.equal(app.titles.some(title=>title.includes(':saved:')),false);
});

test('older VPKs receive the original title format without cached intermediate replies', async () => {
  const app=client({protocol:false});
  await app.send(1,'status');
  assert.equal(app.titles.length,1);
  assert.match(app.titles[0],/^native:1:linked:status:none:off:test:ru$/);
});

test('older VPKs receive their original preference-save confirmations', async () => {
  const app=client({protocol:false,async request(action,body){
    return action==='language'?{language:body.language}:{settings:{mode:body.telemetry.mode}};
  }});
  await app.send(1,'language','en');
  assert.match(app.titles.at(-1),/^native:1:linked:language:none:off:test:en$/);
  await app.send(2,'notifications','on');
  assert.match(app.titles.at(-1),/^native:2:linked:notifications:none:on:test:en$/);
  assert.deepEqual(Object.keys(app.context.readProfile().pending),[]);
});

test('Panorama restores its last display immediately and keeps local saves interactive', async () => {
  const source=await readFile(new URL('./panorama/scripts/katka.js',import.meta.url),'utf8');
  const items={},attributes=new Map([['telelock_local_profile',JSON.stringify({language:'ru',tier:'test',mode:'off',linked:true})]]);
  let receive;
  const item=id=>items[id] ||= {SetPanelEvent(name,fn){this.activate=fn;}};
  const frame={id:'KatkaSettings',SetURL(){}};
  const root={GetParent:()=>null,GetAttributeString:(k,f)=>attributes.get(k)??f,SetAttributeString:(k,v)=>attributes.set(k,v),
    FindChildTraverse:id=>id==='KatkaCommands'?null:id==='KatkaSettings'?frame:item(id)};
  vm.runInNewContext(source,{Date,$:{GetContextPanel:()=>root,Schedule(){},RegisterEventHandler(name,panel,fn){receive=fn;}}});
  assert.equal(items.KatkaLinked.visible,true);assert.equal(items.KatkaFlagRu.visible,true);
  assert.match(items.KatkaNotifications.text,/ВЫКЛ/);assert.match(items.KatkaConnection.text,/Подключаемся/);
  receive(null,'native:1:cached_linked:cached:none:off:test:ru:pending,0,0');
  items.KatkaNotifications.activate();
  receive(null,'native:2:cached_linked:saved:none:auto:test:ru:pending,0,1');
  assert.match(items.KatkaFeedback.text,/Сохранено на ПК/);
  assert.equal(items.KatkaNotifications.enabled,true);
});

test('ordinary profiles retain notification settings and pending edits without staff access',async()=>{
 const storage=new Map([[key,JSON.stringify({...initial,tier:'free',mode:'off'})]]);
 const app=client({storage,request:async(action,body)=> action==='status'
   ? {generation,tier:'free',language:'ru',settings:{mode:'off'}}
   : {settings:{mode:body.telemetry.mode}}});
 await app.send(1,'status');assert.equal(app.context.readProfile().mode,'off');
 await app.send(2,'notifications','on');assert.equal(app.context.readProfile().mode,'on');
 assert.ok(app.titles.at(-1).includes(':on:free:ru:'));
 assert.ok(app.calls.some(call=>call.action==='settings'));
});
