import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./panorama/scripts/katka_queue_state.js',import.meta.url),'utf8');
function statusPanel(className){
  const urls=[],tasks=[];let receive;
  const frame={SetURL:url=>urls.push(url)};
  const panel={FindChildTraverse:()=>frame,BHasClass:name=>name===className};
  vm.runInNewContext(source,{Date,$:{GetContextPanel:()=>panel,Schedule:(delay,fn)=>tasks.push(fn),
    RegisterEventHandler:(event,target,fn)=>{receive=fn;}}});
  receive(null,'ready:state');tasks.shift()();return urls.at(-1);
}
test('native state context reports actual waiting distinctly from roster, party and connection',()=>{
  for(const [name,expected] of [['State_WaitingForMatch','waiting'],['State_RosterSelect','idle'],
    ['State_None','idle'],['State_WaitingForPartyRosters','party'],['State_ConnectingToServer','connecting'],['other','unknown']]) {
    assert.match(statusPanel(name),new RegExp('#[0-9]{13}:'+expected+'$'));
  }
});
test('native state reporting requires no dashboard object or root attribute',()=>{
  assert.match(statusPanel('State_WaitingForMatch'),/:waiting$/);
});
