import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./panorama/scripts/katka.js', import.meta.url), 'utf8');
const generation = 'a'.repeat(32);
function client({ open = false, diagnosticOnly = false, initialState = 'State_None', hasState = true } = {}) {
  let now = Date.now(), state = initialState, inQueue = false;
  const initialExpiry = now + 30000;
  const scheduled = [], events = [], handlers = {}, globalHandlers = {}, attributes = {}, reportUrls = [], pollUrls = [];
  const roster = { visible: open, BHasClass: () => false, FindChildTraverse: () => ({ visible: true, enabled: true }) };
  const statusPanel = { visible: true, BHasClass: name => name === state };
  const dashboard = { BHasClass: name => name === 'in_matchmaking' && inQueue };
  const frame = { id: 'KatkaCommands', SetURL: url => pollUrls.push(url) };
  const matchUrls = [];
  const reporter = { id: 'KatkaMatchReport', SetURL: url => matchUrls.push(url) };
  const commandReporter = { id: 'KatkaCommandReport', SetURL: url => reportUrls.push(url) };
  const root = { GetParent: () => null, id: 'root',
    FindChildTraverse: name => name === 'Dashboard' ? dashboard : null,
    FindChildrenWithClassTraverse: name => name === 'KatkaRosterSelect' ? [roster] : hasState ? [statusPanel] : [],
    SetAttributeString: (key, value) => { attributes[key] = value; },
    GetAttributeString: (key, fallback) => attributes[key] ?? fallback };
  const context = { GetParent: () => root, FindChildTraverse: id =>
    id === 'KatkaCommands' ? frame : id === 'KatkaMatchReport' ? reporter
      : id === 'KatkaCommandReport' ? commandReporter : null };
  vm.runInNewContext(source.replaceAll('"KATKA_DIAGNOSTIC_ONLY"', diagnosticOnly ? '"true"' : '"false"'), {
    Date: { now: () => now }, $: {
      GetContextPanel: () => context,
      RegisterForUnhandledEvent: (name, fn) => { globalHandlers[name] = fn; },
      RegisterEventHandler: (name, panel, fn) => { handlers[panel.id] = fn; },
      DispatchEvent: (...args) => events.push(args[0]),
      Schedule: (delay, fn) => scheduled.push({ delay, fn }),
    }
  });
  const title = text => handlers.KatkaCommands(null, text);
  const command = (id, action, expires = initialExpiry) =>
    title(`katka:${generation}:${id}:${action}:${expires}:7`);
  const execute = (id, action, expires = initialExpiry, gen = generation) =>
    title(`execute:${gen}:${id}:${action}:${expires}:8`);
  const tick = (delay = 1) => {
    const i = scheduled.findIndex(item => item.delay === delay);
    if (i < 0) return false;
    scheduled.splice(i, 1)[0].fn(); return true;
  };
  const setState = (next, queue = false) => { state = next; inQueue = queue; };
  const ackResult = id => handlers.KatkaCommandReport(null, 'result:' + generation + ':' + id);
  return { title, command, execute, tick, events, roster, root, attributes, setState, initialExpiry,
    reportUrls, pollUrls, matchUrls, globalHandlers, ackResult, advance: ms => { now += ms; } };
}

test('auto receipt tracks bot execution, clears after match, manual start, cancel and refusal', () => {
  const c = client(); c.title('owner:' + generation);
  c.globalHandlers.CitadelMatchFormed();
  assert.match(c.matchUrls.at(-1), /:manual$/);
  const bot = client(); bot.command(1, '/play_normal'); bot.execute(1, '/play_normal');
  bot.globalHandlers.CitadelMatchFormed();
  assert.match(bot.matchUrls.at(-1), /:bot$/);
  assert.equal(bot.attributes.katka_bot_search, 'false');
  const manual = client(); manual.command(1, '/play_normal'); manual.execute(1, '/play_normal');
  manual.globalHandlers.CitadelStartUnrankedMatch(); manual.globalHandlers.CitadelMatchFormed();
  assert.match(manual.matchUrls.at(-1), /:manual$/);
  const cancelled = client(); cancelled.command(1, '/play_normal'); cancelled.execute(1, '/play_normal');
  cancelled.command(2, '/cancel'); cancelled.globalHandlers.CitadelMatchFormed();
  assert.match(cancelled.matchUrls.at(-1), /:manual$/);
  const refused = client({open:true}); refused.command(1, '/play_normal'); refused.globalHandlers.CitadelMatchFormed();
  assert.match(refused.matchUrls.at(-1), /:manual$/);
});

test('commands page must be ready before any poll pulse is sent', () => {
  const c = client(); const initial = c.pollUrls.length;
  c.tick(); c.tick(); assert.equal(c.pollUrls.length, initial);
  c.title('ready:commands'); c.tick();
  assert.match(c.pollUrls.at(-1), /#poll=1:$/);
});

test('Standard is approved durably before opening the native mode', () => {
  const c = client(); c.title('ready:commands'); c.command(1, '/play_normal');
  assert.deepEqual(c.events, []);
  assert.match(c.pollUrls.at(-1), /#approve=a{32}:1:1$/);
  assert.equal(c.attributes.katka_launch_request, undefined);
  c.execute(1, '/play_normal');
  assert.deepEqual(c.events, ['CitadelStartUnrankedMatch']);
  assert.equal(c.reportUrls.length, 0);
});

test('Ranked and Street execute only their approved native mode', () => {
  const c = client(); c.command(1, '/play_ranked'); c.execute(1, '/play_ranked');
  c.command(2, '/play_street'); c.execute(2, '/play_street');
  assert.deepEqual(c.events, ['CitadelStartRankedMatch', 'CitadelStartUnrankedStreetBrawl']);
});

test('execute requires matching local generation, id, mode and bounded expiry', () => {
  const c = client(); c.command(1, '/play_normal');
  c.execute(2, '/play_normal'); c.execute(1, '/play_ranked');
  c.execute(1, '/play_normal', c.initialExpiry, 'b'.repeat(32));
  c.execute(1, '/play_normal', c.initialExpiry + 1);
  assert.deepEqual(c.events, []);
  c.execute(1, '/play_normal');
  assert.deepEqual(c.events, ['CitadelStartUnrankedMatch']);
});

test('expired and unsolicited execute titles do not open a mode', () => {
  const unsolicited = client(); unsolicited.execute(1, '/play_normal');
  assert.deepEqual(unsolicited.events, []);
  const expired = client(); expired.command(1, '/play_normal'); expired.advance(30001);
  expired.execute(1, '/play_normal'); assert.deepEqual(expired.events, []);
});

test('permission is consumed before dispatch and duplicate deliveries do not reopen', () => {
  const c = client(); c.command(1, '/play_normal'); c.execute(1, '/play_normal');
  c.execute(1, '/play_normal'); c.command(1, '/play_normal');
  assert.deepEqual(c.events, ['CitadelStartUnrankedMatch']);
});

test('an already visible manual roster is refused before approval', () => {
  const c = client({ open: true }); c.command(1, '/play_ranked');
  assert.deepEqual(c.events, []);
  assert.ok(!c.pollUrls.some(url => url.includes('#approve=')));
  assert.match(c.reportUrls.at(-1), /:1:already_open$/);
});

test('a manual roster opened after approval disarms execution rather than confirming it', () => {
  const c = client(); c.command(1, '/play_normal'); c.roster.visible = true;
  c.execute(1, '/play_normal'); assert.deepEqual(c.events, []);
  assert.match(c.reportUrls.at(-1), /:1:already_open$/);
  c.roster.visible = false; c.execute(1, '/play_normal'); assert.deepEqual(c.events, []);
});

test('already queued mode is refused without claiming a newly started search', () => {
  const c = client({ initialState: 'State_WaitingForMatch' }); c.command(1, '/play_normal');
  assert.deepEqual(c.events, []); assert.match(c.reportUrls.at(-1), /:1:unconfirmed$/);
});

test('watch preserves an approved mode and sends only its own watching report', () => {
  const c = client(); c.command(1, '/play_normal'); c.command(2, '/watch_black'); c.execute(1, '/play_normal');
  assert.deepEqual(c.events, ['CitadelStartUnrankedMatch']);
  assert.match(c.reportUrls[0], /:2:watching$/);
  assert.equal(c.reportUrls.length, 1);
});

test('cancel invalidates approval and dispatches leave but does not invent cancellation proof', () => {
  const c = client(); c.command(1, '/play_normal'); c.command(2, '/cancel'); c.execute(1, '/play_normal');
  assert.deepEqual(c.events, ['CitadelLeaveMatchmaking']);
  assert.equal(c.reportUrls.length, 0);
  assert.equal(c.attributes.katka_launch_request, undefined);
});

test('state panel owns queue proof; controller does not report queued or time out root attributes', () => {
  const c = client(); c.command(1, '/play_normal'); c.execute(1, '/play_normal');
  c.setState('State_WaitingForMatch', true);
  for (let i = 0; i < 30; i++) { c.advance(1000); c.tick(); }
  assert.equal(c.reportUrls.length, 0);
  assert.ok(!c.attributes.katka_launch_request);
});

test('network failure preserves approval; actual owner removal revokes it', () => {
  const online = client(); online.command(1, '/play_normal'); online.title('transport:offline:9');
  online.execute(1, '/play_normal'); assert.deepEqual(online.events, ['CitadelStartUnrankedMatch']);
  const unlinked = client(); unlinked.command(1, '/play_normal'); unlinked.title('owner:none:10');
  unlinked.execute(1, '/play_normal'); assert.deepEqual(unlinked.events, []);
});

test('busy page is never navigated before completion or the ten-second watchdog', () => {
  const c = client(); c.title('ready:commands'); c.tick(); c.title('busy:commands:1');
  const count = c.pollUrls.length; c.advance(9000); c.tick();
  assert.equal(c.pollUrls.length, count);
  c.advance(2000); c.tick();
  assert.match(c.pollUrls.at(-1), /recovery=1$/);
  const recoveredCount = c.pollUrls.length; c.advance(1000); c.tick();
  assert.equal(c.pollUrls.length, recoveredCount);
  c.title('ready:commands'); c.tick();
  assert.match(c.pollUrls.at(-1), /recovery=1#poll=/);
});

test('approval request also suppresses poll pulses until its execute reply', () => {
  const c = client(); c.title('ready:commands'); c.command(1, '/play_normal');
  const count = c.pollUrls.length; c.tick();
  assert.equal(c.pollUrls.length, count);
  c.execute(1, '/play_normal'); c.tick();
  assert.match(c.pollUrls.at(-1), /#poll=1:a{32}:1$/);
});

test('local result outbox retries with a new pulse and drains on durable acknowledgement', () => {
  const c = client(); c.command(1, '/watch_black'); c.command(2, '/watch_black');
  assert.match(c.reportUrls[0], /:1:watching$/);
  c.tick(2); assert.match(c.reportUrls.at(-1), /:1:watching$/);
  assert.notEqual(c.reportUrls[0], c.reportUrls[1]);
  c.ackResult(1); assert.match(c.reportUrls.at(-1), /:2:watching$/);
  c.ackResult(2); const count = c.reportUrls.length; c.tick(2);
  assert.equal(c.reportUrls.length, count);
});

test('diagnostic build never approves or executes a real mode', () => {
  const c = client({ diagnosticOnly: true }); c.command(1, '/play_normal'); c.execute(1, '/play_normal');
  assert.deepEqual(c.events, []);
  assert.ok(!c.pollUrls.some(url => url.includes('#approve=')));
  assert.equal(c.reportUrls.length, 0);
  assert.equal(c.attributes.katka_diagnostic_only, 'true');
});
