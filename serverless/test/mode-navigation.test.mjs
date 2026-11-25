import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { keyboard } from '../tgcloud/lib/controls.js';

async function fixture({ tier, language, card }) {
  const sent = [], commands = [];
  const generation = 'a'.repeat(32);
  const context = vm.createContext({ Date, JSON, Number, Object, Error });
  const modules = {
    sdk: new vm.SyntheticModule(['api', 'fetch'], function () {
      this.setExport('api', { sendMessage: async body => sent.push(body) });
      this.setExport('fetch', async (url, options) => {
        const body = JSON.parse(options.body);
        if (url.endsWith('/status')) return Response.json({ generation, tier, language });
        assert.ok(url.endsWith('/command'));
        commands.push(body);
        return Response.json({ reply: card ? null : { chat_id: 101, text: 'Command accepted.' } });
      });
    }, { context }),
    '../lib/config.js': new vm.SyntheticModule(['gateway', 'secret'], function () {
      this.setExport('gateway', 'https://mock.invalid');
      this.setExport('secret', 'test');
    }, { context }),
    '../lib/pairing.js': new vm.SyntheticModule(['issueCode', 'pairingForOwner', 'redeemCode'], function () {
      this.setExport('issueCode', async () => { throw new Error('Must not issue a pairing code'); });
      this.setExport('pairingForOwner', async () => ({ generation }));
      this.setExport('redeemCode', async () => { throw new Error('Must not change the binding'); });
    }, { context }),
  };
  const handlerUrl = new URL('../tgcloud/handlers/message.js', import.meta.url);
  const cache = new Map(Object.entries(modules).map(([name, module]) =>
    [name === 'sdk' ? name : new URL(name, handlerUrl).href, module]));
  const handler = new vm.SourceTextModule(
    await readFile(handlerUrl, 'utf8'), { context, identifier: handlerUrl.href });
  await handler.link(async (name, referrer) => {
    const key = name === 'sdk' ? name : new URL(name, referrer.identifier).href;
    if (!cache.has(key)) cache.set(key, new vm.SourceTextModule(await readFile(new URL(key), 'utf8'),
      { context, identifier: key }));
    return cache.get(key);
  });
  await handler.evaluate();
  return {
    sent, commands,
    invoke: text => handler.namespace.default({ text, chat: { id: 101, type: 'private' },
      from: { id: 101 }, date: Math.floor(Date.now() / 1000) }, { update: { update_id: 123 } }),
  };
}

test('selecting a mode returns to the main keyboard, including when the gateway sends a search card', async () => {
  for (const tier of ['free', 'pro', 'test', 'owner']) {
    for (const language of ['en', 'ru']) {
      for (const card of [false, true]) {
        for (const command of ['/play_normal', '/play_ranked', '/play_street', ...(tier === 'owner' ? ['/lab_play'] : [])]) {
          const f = await fixture({ tier, language, card });
          await f.invoke(command);
          assert.equal(f.commands.length, 1);
          assert.equal(f.commands[0].message.text, command);
          assert.equal(f.commands[0].generation, 'a'.repeat(32));
          assert.equal(f.sent.length, 1);
          assert.deepEqual(JSON.parse(JSON.stringify(f.sent[0].reply_markup)), keyboard(true, 'home', tier, language));
        }
      }
    }
  }
});

test('cancel and monitoring controls keep their play keyboard', async () => {
  for (const command of ['/cancel', '/watch_black']) {
    const f = await fixture({ tier: 'pro', language: 'ru', card: false });
    await f.invoke(command);
    assert.deepEqual(JSON.parse(JSON.stringify(f.sent[0].reply_markup)), keyboard(true, 'play', 'pro', 'ru'));
  }
});
