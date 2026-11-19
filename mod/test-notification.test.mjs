import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('./panel/index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('async function testNotification('),html.indexOf("element('test').onclick"));

test('test latency uses the game clock through Telegram confirmation, excluding the edit',async()=>{
  let now=100;const calls=[];
  const sandbox={performance:{now:()=>now},api:async(action,body)=>{
    calls.push({action,body}); now+=1234;
    return {delivery:'delivered',test:'receipt'};
  }};
  vm.runInNewContext(source,sandbox);
  await sandbox.testNotification('owner',100);
  assert.equal(calls.length,2);
  assert.equal(calls[1].body.elapsed,1234);
  assert.equal(calls[1].body.test,'receipt');
});

test('unconfirmed send does not publish a fabricated delay',async()=>{
  let calls=0;
  const sandbox={performance:{now:()=>100},api:async()=>{calls++;return {delivery:'unknown'};}};
  vm.runInNewContext(source,sandbox);
  await assert.rejects(()=>sandbox.testNotification('owner'),/не подтвердил/);
  assert.equal(calls,1);
});
