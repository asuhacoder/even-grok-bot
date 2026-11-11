// Regressions from the independent review of the first G2 machine.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BotSummary, Conversation, Entry, ServerMessage } from '../../shared/protocol.ts';
import { OFFLINE, initialModel, step, top } from './machine.ts';
import type { Effect, Input, Model } from './machine.ts';
import { LINES_PER_PAGE, lastTop, lineOfEntry } from './pages.ts';
import { view } from './view.ts';

const bots: BotSummary[] = [
  { id: 'a', name: 'A', status: 'idle', preview: 'pa', activityAt: 3 },
  { id: 'b', name: 'B', status: 'idle', preview: 'pb', activityAt: 2 },
  { id: 'c', name: 'C', status: 'idle', preview: 'pc', activityAt: 1 },
];
const health = { relay: 'ok', grok: 'ok', asr: 'ok', detail: '' } as const;
const srv = (msg: ServerMessage): Input => ({ type: 'server', msg });
function run(inputs: Input[], start?: Model) {
  let m = start ?? step(initialModel(), srv({ type: 'welcome', bots, health })).model;
  const effects: Effect[] = [];
  for (const i of inputs) {
    const r = step(m, i);
    m = r.model;
    effects.push(...r.effects);
  }
  return { m, effects, screen: top(m), view: view(m) };
}
const notice = (botId: string, id: string): Input =>
  srv({ type: 'notice', notice: { id, botId, botName: botId.toUpperCase(), kind: 'message', text: id, at: 1 } });
const conv = (botId: string, entries: Entry[], extra: Partial<Conversation> = {}): Input =>
  srv({ type: 'conversation', conversation: { botId, botName: botId, entries, firstUnreadId: null, running: false, hasOlder: false, pending: null, canStop: false, ...extra } });
const msgs = (fx: Effect[], type: string) => fx.flatMap(e => (e.type === 'send' && e.msg.type === type ? [e.msg] : []));
const text = (id: string, t: string): Entry => ({ kind: 'text', id, at: 0, author: 'bot', from: '', text: t });
const approval: Entry = { kind: 'approval', id: 'p1', at: 0, summary: 's', reason: 'r', state: 'pending' };

test('the notice on screen stays put when a queued Bot re-notifies', () => {
  const r = run([notice('a', 'a1'), notice('b', 'b1'), notice('a', 'a2'), { type: 'tap' }]);
  assert.deepEqual(msgs(r.effects, 'open'), [{ type: 'open', botId: 'a' }]);
});

test('the list tap always opens the row on screen, across re-sorts and preview updates', () => {
  const resorted = run([srv({ type: 'bots', bots: [bots[0]!, bots[1]!, { ...bots[2]!, status: 'needs-action' }] })]);
  const shown = resorted.view.kind === 'list' ? resorted.view.items : [];
  assert.equal(shown[0]!.split('｜')[0], 'C');
  const preview = run([srv({ type: 'bots', bots: [bots[0]!, { ...bots[1]!, preview: '新しい' }, { ...bots[2]!, status: 'needs-action' }] })], resorted.m);
  assert.deepEqual(preview.view, resorted.view, 'preview-only change does not rebuild the list');
  const tap = run([{ type: 'select', index: 1 }], preview.m);
  assert.deepEqual(msgs(tap.effects, 'open'), [{ type: 'open', botId: shown[1]!.startsWith('A') ? 'a' : 'b' }]);
});

test('offline: approving refuses and stays on the choices', () => {
  const r = run([{ type: 'select', index: 0 }, conv('a', [approval], { pending: { kind: 'approval', entryId: 'p1' } }), { type: 'tap' }, { type: 'tap' }, { type: 'connection', up: false }, { type: 'select', index: 1 }]);
  assert.equal(r.screen.name, 'approval');
  assert.equal(r.m.toast, OFFLINE);
  assert.deepEqual(msgs(r.effects, 'approve'), []);
});

test('offline: recording does not start', () => {
  const r = run([{ type: 'select', index: 0 }, conv('a', []), { type: 'connection', up: false }, { type: 'tap' }]);
  assert.equal(r.screen.name, 'conversation');
  assert.equal(r.effects.some(e => e.type === 'mic'), false);
});

test('an approval resolved elsewhere closes both the always-confirm and the approval screen', () => {
  const r = run([{ type: 'select', index: 0 }, conv('a', [approval], { pending: { kind: 'approval', entryId: 'p1' } }), { type: 'tap' }, { type: 'tap' }, { type: 'select', index: 2 }]);
  assert.equal(r.screen.name, 'always-confirm');
  const done = run([conv('a', [{ ...approval, state: 'approved' }])], r.m);
  assert.equal(done.screen.name, 'conversation');
});

test('with more than 19 options the last row records a voice answer', () => {
  const q: Entry = { kind: 'question', id: 'q1', at: 0, prompt: '?', options: Array.from({ length: 22 }, (_, i) => ({ label: `o${i}`, value: `v${i}` })), state: 'pending' };
  const r = run([{ type: 'select', index: 0 }, conv('a', [q], { pending: { kind: 'question', entryId: 'q1' } }), { type: 'tap' }, { type: 'tap' }]);
  const items = r.view.kind === 'list' ? r.view.items : [];
  assert.equal(items.length, 20);
  assert.equal(items[19], '音声で回答');
  const voice = run([{ type: 'select', index: 19 }], r.m);
  assert.equal(voice.screen.name, 'recording');
  assert.deepEqual(msgs(voice.effects, 'answer'), []);
});

test('swiping up at the top asks the relay for older entries, and the reader stays on the same line', () => {
  const entries = ['e1', 'e2', 'e3'].map(id => text(id, 'あ'.repeat(200)));
  const r = run([{ type: 'select', index: 0 }, conv('a', entries, { hasOlder: true, firstUnreadId: 'e1' })]);
  const before = r.view.kind === 'text' ? r.view.body : '';
  const older = run([{ type: 'scroll', dir: 'up' }], r.m);
  assert.deepEqual(msgs(older.effects, 'older'), [{ type: 'older', botId: 'a' }]);
  const loaded = run([conv('a', [text('e0', 'い'.repeat(200)), ...entries], { hasOlder: false })], older.m);
  assert.equal(loaded.view.kind === 'text' ? loaded.view.body : '', before);
  const up = run([{ type: 'scroll', dir: 'up' }], loaded.m);
  assert.match(up.view.kind === 'text' ? up.view.body : '', /い/);
});

test('new entries do not move the lines being read', () => {
  const entries = ['e1', 'e2'].map(id => text(id, 'あ'.repeat(200)));
  const r = run([{ type: 'select', index: 0 }, conv('a', entries, { firstUnreadId: 'e1' })]);
  const more = run([conv('a', [...entries, text('e3', '新着')])], r.m);
  assert.equal(more.view.kind === 'text' ? more.view.body : '', r.view.kind === 'text' ? r.view.body : '');
});

test('a swipe scrolls three lines, not a whole screen', () => {
  const r = run([{ type: 'select', index: 0 }, conv('a', [text('e1', 'あ'.repeat(28 * 20))], { firstUnreadId: 'e1' })]);
  const body = (v: typeof r.view) => (v.kind === 'text' ? v.body.split('\n') : []);
  const down = run([{ type: 'scroll', dir: 'down' }], r.m);
  assert.deepEqual(body(down.view).slice(0, 6), body(r.view).slice(3, 9));
});

test('the read point sent to the relay is the last entry on the page shown', () => {
  const entries = ['e1', 'e2'].map(id => text(id, 'あ'.repeat(200)));
  const r = run([{ type: 'select', index: 0 }, conv('a', entries, { firstUnreadId: 'e1' })]);
  assert.deepEqual(msgs(r.effects, 'read'), [{ type: 'read', botId: 'a', entryId: 'e1' }]);
  const down = run([{ type: 'scroll', dir: 'down' }], r.m);
  assert.deepEqual(msgs(down.effects, 'read'), [{ type: 'read', botId: 'a', entryId: 'e2' }]);
});

const body = (v: { kind: string; body?: string }) => (v.kind === 'text' ? v.body ?? '' : '');
const bubble = (id: string, mark: string): Entry => text(id, `${mark}${'あ'.repeat(200)}`);

function unreadGap(entries: Entry[], firstUnreadId: string): number {
  const c: Conversation = {
    botId: 'a',
    botName: 'a',
    entries,
    firstUnreadId,
    running: false,
    hasOlder: false,
    pending: null,
    canStop: false,
  };
  return lastTop(c) - lineOfEntry(c, firstUnreadId)!;
}

test('a nearby unread opens on that entry, and the read point stays on the page', () => {
  const entries = [bubble('e0', '先頭'), bubble('e1', '中'), bubble('e2', '末尾')];
  const gap = unreadGap(entries, 'e0');
  assert.ok(gap <= LINES_PER_PAGE * 3, `fixture gap ${gap} is more than three screens`);
  const r = run([{ type: 'select', index: 0 }, conv('a', entries, { firstUnreadId: 'e0' })]);
  assert.match(body(r.view), /先頭/);
  assert.doesNotMatch(body(r.view), /末尾/);
  assert.deepEqual(msgs(r.effects, 'read'), [{ type: 'read', botId: 'a', entryId: 'e0' }]);
});

test('an unread more than three screens from the end opens on the latest page and marks that page read', () => {
  const entries = [bubble('e0', '先頭'), bubble('e1', '中'), bubble('e2', '中'), bubble('e3', '末尾')];
  const gap = unreadGap(entries, 'e0');
  assert.ok(gap > LINES_PER_PAGE * 3, `fixture gap ${gap} is within three screens`);
  const r = run([{ type: 'select', index: 0 }, conv('a', entries, { firstUnreadId: 'e0' })]);
  assert.match(body(r.view), /末尾/);
  assert.doesNotMatch(body(r.view), /先頭/);
  assert.deepEqual(msgs(r.effects, 'read'), [{ type: 'read', botId: 'a', entryId: 'e3' }]);
  const jump = run([{ type: 'menu', item: 'unread' }], r.m);
  assert.match(body(jump.view), /先頭/);
  assert.doesNotMatch(body(jump.view), /末尾/);
});

test('an unknown unread opens on the latest page', () => {
  const entries = [bubble('e0', '先頭'), bubble('e1', '中'), bubble('e2', '中'), bubble('e3', '末尾')];
  const r = run([{ type: 'select', index: 0 }, conv('a', entries, { firstUnreadId: null })]);
  assert.match(body(r.view), /末尾/);
  assert.doesNotMatch(body(r.view), /先頭/);
  assert.deepEqual(msgs(r.effects, 'read'), [{ type: 'read', botId: 'a', entryId: 'e3' }]);
});
