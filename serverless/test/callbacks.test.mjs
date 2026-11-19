import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const generation='a'.repeat(32);
async function fixture() {
 const sent=[],calls=[],edits=[],answers=[];
 const context=vm.createContext({Date,JSON,Number,Object,String,Error});
 const modules={
  sdk:new vm.SyntheticModule(['api','fetch'],function(){this.setExport('api',{
   sendMessage:async body=>sent.push(body),editMessageText:async body=>edits.push(body),answerCallbackQuery:async body=>answers.push(body)});
   this.setExport('fetch',async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});return Response.json(url.endsWith('/settings')?{settings:{mode:body.mode||'auto',repeat:body.repeat||0}}:{reply:null});});},{context}),
  '../lib/config.js':new vm.SyntheticModule(['gateway','secret'],function(){this.setExport('gateway','https://mock');this.setExport('secret','mock');},{context}),
  '../lib/pairing.js':new vm.SyntheticModule(['pairingForOwner'],function(){this.setExport('pairingForOwner',async()=>({generation}));},{context}),
  '../lib/controls.js':new vm.SourceTextModule(await readFile(new URL('../tgcloud/lib/controls.js',import.meta.url),'utf8'),{context}),
 };
 const handler=new vm.SourceTextModule(await readFile(new URL('../tgcloud/handlers/callback_query.js',import.meta.url),'utf8'),{context});
 await handler.link(name=>modules[name]);await handler.evaluate();
 const invoke=(data,overrides={})=>handler.namespace.default({id:'callback',data,from:{id:101},message:{message_id:42,chat:{id:101,type:'private'}},...overrides},{update:{update_id:123}});
 return {invoke,sent,calls,edits,answers};
}
test('settings buttons edit their message and send only the authenticated owner',async()=>{
 const f=await fixture();await f.invoke('mode:'+generation+':off');
 assert.equal(f.calls[0].body.owner,101);assert.equal(f.calls[0].body.mode,'off');assert.equal(f.edits[0].message_id,42);assert.match(f.edits[0].text,/ВЫКЛ/);
 await f.invoke('repeat:'+generation+':30');assert.equal(f.calls[1].body.repeat,30);
});
test('cancel callback carries expected search and fresh command date',async()=>{
 const f=await fixture();await f.invoke('cancel:'+generation+':11');
 assert.equal(f.calls[0].body.expectedCommand,11);assert.equal(f.calls[0].body.message.text,'/cancel');assert.equal(f.calls[0].body.id,123);
});
test('foreign chats and stale generations never reach the gateway',async()=>{
 const f=await fixture();await f.invoke('test:'+generation,{from:{id:202}});await f.invoke('test:'+'b'.repeat(32));assert.equal(f.calls.length,0);
});
