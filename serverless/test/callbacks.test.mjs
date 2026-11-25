import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const generation='a'.repeat(32);
async function fixture({proUnavailable=false,editUnavailable=false}={}) {
 const sent=[],calls=[],edits=[],answers=[];
 const context=vm.createContext({Date,JSON,Number,Object,String,Error});
 const modules={
  sdk:new vm.SyntheticModule(['api','fetch'],function(){this.setExport('api',{
   sendMessage:async body=>sent.push(body),editMessageText:async body=>{
    if(editUnavailable) throw new Error('Message could not be edited');
    edits.push(body);
   },answerCallbackQuery:async body=>answers.push(body)});
   this.setExport('fetch',async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,body});
    if(url.endsWith('/feedback'))return Response.json({language:'ru',rating:body.value});
    if(url.endsWith('/thanks'))return proUnavailable
      ? Response.json({error:'Temporarily unavailable'},{status:503})
      : Response.json({language:'en',registered:true});
    return Response.json(url.endsWith('/language') ? {language:body.language} : url.endsWith('/settings') ? {settings:{mode:body.mode||'auto',repeat:body.repeat||0},language:'ru'} : {reply:null});
   });},{context}),
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
test('language callback is account scoped and updates the chooser in the saved language', async () => {
 const f=await fixture();
 await f.invoke('language:en',{from:{id:202}});
 await f.invoke('language:other');
 assert.equal(f.calls.length,0);
 await f.invoke('language:ru');
 assert.deepEqual(f.calls[0].body,{owner:101,language:'ru'});
 assert.match(f.edits[0].text,/Выберите язык/);
 assert.equal(f.edits[0].reply_markup.inline_keyboard[0][1].text,'✓ Русский');
});

test('rating callbacks thank the user and the review button opens a text reply', async () => {
 const f = await fixture();
 await f.invoke('feedback:rate:6');
 await f.invoke('feedback:rate:5',{from:{id:202}});
 assert.equal(f.calls.length,0);
 await f.invoke('feedback:rate:5');
 assert.deepEqual(f.calls[0].body,{owner:101,operation:'rate',value:5});
 assert.match(f.edits[0].text,/Спасибо за оценку 5\/5/);
 assert.equal(f.edits[0].reply_markup.inline_keyboard[0][0].callback_data,'feedback:write');
 await f.invoke('feedback:write');
 assert.equal(f.sent[0].reply_markup.force_reply,true);
 assert.match(f.sent[0].text,/Ответьте на это сообщение/);
});

test('legacy payment buttons register thanks without starting a trial or requesting money',async()=>{
 const f=await fixture();
 await f.invoke('pro:pay',{from:{id:202}});assert.equal(f.calls.length,0);
 await f.invoke('pro:pay');
 assert.equal(f.calls[0].url,'https://mock/service/thanks');
 assert.deepEqual(f.calls[0].body,{owner:101});
 assert.equal(f.edits[0].text,'Your thanks have been registered👍');
 assert.equal(f.edits[0].reply_markup.inline_keyboard[0][0].url,'https://t.me/zzzMister');
});

test('an unavailable thanks service does not claim success and preserves the old button language',async()=>{
 const f=await fixture({proUnavailable:true});
 await f.invoke('pro:pay',{message:{message_id:42,chat:{id:101,type:'private'},text:'Telelock Pro открывает статус игры'}});
 assert.equal(f.edits.length,0);assert.match(f.sent[0].text,/Не удалось зарегистрировать/);
});

test('confirmed thanks keeps the donation link if an old offer cannot be edited',async()=>{
 const f=await fixture({editUnavailable:true});await f.invoke('pro:pay');
 assert.equal(f.calls.length,1);assert.equal(f.sent[0].text,'Your thanks have been registered👍');
 assert.equal(f.sent[0].reply_markup.inline_keyboard[0][0].url,'https://t.me/zzzMister');
});
