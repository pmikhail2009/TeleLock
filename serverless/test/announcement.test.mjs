import test from 'node:test';
import assert from 'node:assert/strict';
import { freeModelAnnouncement } from '../tgcloud/lib/announcement.js';
import { keyboard } from '../tgcloud/lib/controls.js';

test('the announcement describes the free features and refreshes both language keyboards',()=>{
  for(const language of ['ru','en']) {
    const text=freeModelAnnouncement(language);
    assert.ok(text.length<4096);
    for(const seconds of [15,30,60]) assert.ok(text.includes(String(seconds)));
    assert.match(text,/@zzzMister/);
    const buttons=keyboard(true,'home','free',language).keyboard.flat();
    assert.ok(buttons.includes(language==='ru'?'Сказать автору спасибо':'Thank the author'));
    assert.ok(buttons.every(label=>!label.includes('Pro')));
  }
});
