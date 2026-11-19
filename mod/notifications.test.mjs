import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./panel/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function notificationMode('), html.indexOf('const view ='));
const generation = 'a'.repeat(32);

test('free access ignores old on/off settings and always uses auto', async () => {
  for(const previous of ['on','off']) for(const origin of ['bot','manual']) {
    const saved = new Map([['katka_notifications',previous]]), calls=[];
    const sandbox={document:{},location:{hash:`#${generation}:123:${origin}`},
      fullAccess:()=>false,
      localStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)},
      api:async action=>{calls.push(action);return {generation};}};
    vm.runInNewContext(source,sandbox);
    assert.equal(sandbox.notificationMode('on'),'auto');
    assert.equal(saved.get('katka_notifications'),previous);
    await sandbox.reportMatch();
    assert.deepEqual(calls,['status','match']);
  }
});

for (const mode of ['on', 'off', 'auto', null]) {
  for (const origin of ['bot', 'manual']) {
    test(`${mode ?? 'default'} notifications for ${origin} search`, async () => {
      const saved = new Map(mode ? [['katka_notifications', mode]] : []);
      const calls = [], document = {}, location = {hash: `#${generation}:123:${origin}`};
      const sandbox = {document, location, fullAccess: () => true, localStorage: {
        getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value),
      }, api: async action => { calls.push(action); return {generation}; }};
      vm.runInNewContext(source, sandbox);
      await sandbox.reportMatch();
      // Server applies the preference; every match must update its search card.
      assert.deepEqual(calls, ['status', 'match']);
      assert.equal(document.title, 'received:' + location.hash.slice(1));
      sandbox.notificationMode('off');
      assert.equal(saved.get('katka_notifications'), 'off');
      const recreated = {...sandbox};
      vm.runInNewContext(source, recreated);
      assert.equal(recreated.notificationMode(), 'off');
    });
  }
}
