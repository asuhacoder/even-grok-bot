import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BotSummary, Conversation, Entry, Notice, ServerMessage } from '../../shared/protocol.ts';
import { initialModel, step, top } from './machine.ts';
import type { Effect, Input, Model } from './machine.ts';
import { view } from './view.ts';

const bots: BotSummary[] = [
  { id: 'a', name: '開発PM', status: 'idle', preview: '了解', activityAt: 1 },
  { id: 'b', name: '総務担当', status: 'idle', preview: '送った', activityAt: 2 },
];
const health = { relay: 'ok', grok: 'ok', asr: 'ok', detail: '' } as const;

function run(inputs: Input[], start: Model = online()) {
  let m = start;
  const effects: Effect[] = [];
  for (const i of inputs) {
    const r = step(m, i);
    m = r.model;
    effects.push(...r.effects);
  }
  return { m, effects, screen: top(m).name, view: view(m) };
}
const srv = (msg: ServerMessage): Input => ({ type: 'server', msg });
function online(): Model {
  return step(initialModel(), srv({ type: 'welcome', bots, health })).model;
}
function text(id: string, author: 'me' | 'bot', t: string): Entry {
  if (author === 'me') return { kind: 'text', id, at: 0, author: 'me', from: '', text: t };
  return { kind: 'text', id, at: 0, author: 'bot', from: '', text: t };
}
const conv = (botId: string, entries: Entry[], extra: Partial<Conversation> = {}): Input =>
  srv({
    type: 'conversation',
    conversation: { botId, botName: botId === 'a' ? '開発PM' : '総務担当', entries, firstUnreadId: null, running: false, hasOlder: false, pending: null, canStop: false, ...extra },
  });
const notice = (n: Partial<Notice>): Input =>
  srv({ type: 'notice', notice: { id: 'n', botId: 'a', botName: '開発PM', kind: 'message', text: 'できました', at: 1, ...n } });
const sent = (effects: Effect[]) => effects.flatMap(e => (e.type === 'send' && e.msg.type !== 'read' ? [e.msg.type] : []));
const acts = (effects: Effect[]) => effects.filter(e => !(e.type === 'send' && e.msg.type === 'read'));

test('1 completion: notice -> first unread -> scroll down -> back to the list', () => {
  const entries = [text('e1', 'me', 'あ'.repeat(300)), text('e2', 'bot', 'い'.repeat(200)), text('e3', 'bot', '完了しました')];
  const r = run([notice({ kind: 'done' }), { type: 'tap' }, conv('a', entries, { firstUnreadId: 'e2' })]);
  assert.equal(r.screen, 'conversation');
  assert.match(r.view.kind === 'text' ? r.view.body : '', /^◀開発PM/);
  assert.doesNotMatch(r.view.kind === 'text' ? r.view.body : '', /完了しました/);
  const r2 = run([{ type: 'scroll', dir: 'down' }], r.m);
  assert.match(r2.view.kind === 'text' ? r2.view.body : '', /完了しました/);
  assert.match(r2.view.kind === 'text' ? r2.view.header : '', /^100% /);
  const r3 = run([{ type: 'double' }], r2.m);
  assert.equal(r3.screen, 'list');
  assert.deepEqual(sent(r3.effects), ['close']);
});

const approvalEntry: Entry = { kind: 'approval', id: 'p1', at: 0, summary: 'Slackにメッセージを送る', reason: '報告のため', state: 'pending' };

test('2 approval: notice -> approval content -> choices -> allow once -> conversation', () => {
  const r = run([notice({ kind: 'needs-action' }), { type: 'tap' }, conv('a', [approvalEntry], { pending: { kind: 'approval', entryId: 'p1' } })]);
  assert.equal(r.screen, 'approval');
  assert.match(r.view.kind === 'text' ? r.view.body : '', /Slackにメッセージを送る/);
  const r2 = run([{ type: 'scroll', dir: 'down' }], r.m);
  assert.deepEqual(r2.view.kind === 'list' ? r2.view.items : [], ['一回だけ許可', '拒否', '常に許可', '音声で返答']);
  const r3 = run([{ type: 'select', index: 0 }], r2.m);
  assert.equal(r3.screen, 'conversation');
  assert.deepEqual(acts(r3.effects), [{ type: 'send', msg: { type: 'approve', reqId: 'r1', botId: 'a', entryId: 'p1', choice: 'once' } }]);
});

test('3 always allow needs confirmation; double tap returns to approval', () => {
  const r = run([notice({ kind: 'needs-action' }), { type: 'tap' }, conv('a', [approvalEntry], { pending: { kind: 'approval', entryId: 'p1' } }), { type: 'tap' }, { type: 'select', index: 2 }]);
  assert.equal(r.screen, 'always-confirm');
  assert.deepEqual(sent(r.effects), ['open']);
  assert.equal(run([{ type: 'double' }], r.m).screen, 'approval');
  const ok = run([{ type: 'tap' }], r.m);
  assert.equal(ok.screen, 'conversation');
  assert.deepEqual(acts(ok.effects), [{ type: 'send', msg: { type: 'approve', reqId: 'r1', botId: 'a', entryId: 'p1', choice: 'always' } }]);
});

test('4 voice instruction: idle -> list -> conversation -> record -> confirm -> send; double tap discards', () => {
  const r = run([{ type: 'select', index: 0 }, conv('b', [text('e1', 'bot', 'hi')]), { type: 'tap' }]);
  assert.equal(r.screen, 'recording');
  assert.deepEqual(r.effects.filter(e => e.type === 'mic'), [{ type: 'mic', on: true }]);
  const t = run([{ type: 'tap' }, srv({ type: 'transcript', reqId: 'r1', text: '今日の進捗を教えて' })], r.m);
  assert.equal(t.screen, 'confirm');
  assert.match(t.view.kind === 'text' ? t.view.body : '', /今日の進捗を教えて/);
  const send = run([{ type: 'tap' }], t.m);
  assert.equal(send.screen, 'conversation');
  assert.deepEqual(acts(send.effects), [{ type: 'send', msg: { type: 'send', reqId: 'r2', botId: 'b', text: '今日の進捗を教えて' } }]);
  const discard = run([{ type: 'double' }, { type: 'tap' }], t.m);
  assert.equal(discard.screen, 'recording');
  assert.deepEqual(sent(discard.effects), ['audio-begin']);
});

test('5 choice question: pick option, or fall through to voice answer', () => {
  const q: Entry = { kind: 'question', id: 'q1', at: 0, prompt: '2段階認証は？', options: [{ label: '設定済み', value: 'もう設定済み' }, { label: 'これから', value: 'これからやる' }], state: 'pending' };
  const c = run([notice({ kind: 'needs-action' }), { type: 'tap' }, conv('a', [q], { pending: { kind: 'question', entryId: 'q1' } })]);
  assert.equal(c.screen, 'question');
  assert.match(c.view.kind === 'text' ? c.view.body : '', /2段階認証は？\n1\. 設定済み\n2\. これから/);
  const r = run([{ type: 'tap' }], c.m);
  assert.deepEqual(r.view.kind === 'list' ? r.view.items : [], ['1. 設定済み', '2. これから', '音声で回答']);
  const pick = run([{ type: 'select', index: 1 }], r.m);
  assert.deepEqual(acts(pick.effects), [{ type: 'send', msg: { type: 'answer', reqId: 'r1', botId: 'a', entryId: 'q1', value: 'これからやる' } }]);
  assert.equal(pick.screen, 'conversation');
  const voice = run([{ type: 'select', index: 2 }], r.m);
  assert.equal(voice.screen, 'recording');
  assert.equal(run([{ type: 'double' }], voice.m).screen, 'conversation');
});

test('6 stop from the conversation menu', () => {
  const r = run([{ type: 'select', index: 0 }, conv('b', [], { running: true }), { type: 'menu', item: 'stop' }]);
  assert.deepEqual(acts(r.effects).at(-1), { type: 'send', msg: { type: 'stop', reqId: 'r1', botId: 'b' } });
  assert.equal(r.screen, 'conversation');
});

test('7 notice while reading: screen kept, edge mark shown, back to list shows the bot first', () => {
  const r = run([{ type: 'select', index: 0 }, conv('b', [text('e1', 'bot', 'x')])]);
  const n = run([notice({ botId: 'a', kind: 'needs-action' }), srv({ type: 'bots', bots: [{ ...bots[0]!, status: 'needs-action', activityAt: 9 }, bots[1]!] })], r.m);
  assert.equal(n.screen, 'conversation');
  assert.match(n.view.kind === 'text' ? n.view.header : '', /●1/);
  const back = run([{ type: 'double' }], n.m);
  assert.equal(back.screen, 'list');
  assert.match(back.view.kind === 'list' ? back.view.items[0]! : '', /^開発PM｜要対応/);
});

test('8 the app opens on the Bot list, sorted waiting-first, and swiping sends nothing', () => {
  const r = run([{ type: 'scroll', dir: 'down' }], step(initialModel(), srv({ type: 'welcome', bots: [bots[0]!, { ...bots[1]!, status: 'needs-action' }], health })).model);
  assert.equal(r.screen, 'list');
  assert.deepEqual(r.view.kind === 'list' ? r.view.items.map(i => i.split('｜')[0]) : [], ['総務担当', '開発PM']);
  assert.deepEqual(r.effects, []);
});

test('a Bot waiting on the user opens straight onto its question from the list', () => {
  const q: Entry = { kind: 'question', id: 'q1', at: 0, prompt: '?', options: [{ label: 'A', value: 'A' }], state: 'pending' };
  const start = step(initialModel(), srv({ type: 'welcome', bots: [{ ...bots[0]!, status: 'needs-action' }], health })).model;
  assert.equal(run([{ type: 'select', index: 0 }, conv('a', [q], { pending: { kind: 'question', entryId: 'q1' } })], start).screen, 'question');
});

test('9 notice during recording is deferred until the confirmation is finished', () => {
  const r = run([{ type: 'select', index: 0 }, conv('b', []), { type: 'tap' }, notice({ botId: 'a' })]);
  assert.equal(r.screen, 'recording');
  const c = run([{ type: 'tap' }, srv({ type: 'transcript', reqId: 'r1', text: 'はい' })], r.m);
  assert.equal(c.screen, 'confirm');
  const done = run([{ type: 'tap' }, { type: 'double' }], c.m);
  assert.equal(done.screen, 'notice');
  assert.match(done.view.kind === 'text' ? done.view.header : '', /開発PM/);
});

test('root double tap asks the OS exit dialog', () => {
  assert.deepEqual(run([{ type: 'double' }]).effects, [{ type: 'exit' }]);
});

test('the list header shows the failure when the relay is down', () => {
  const r = run([{ type: 'connection', up: false }]);
  assert.equal(r.view.kind === 'list' ? r.view.header : '', '！ Mac miniに接続できません');
});

test('menus follow the spec per screen', () => {
  assert.deepEqual(run([{ type: 'select', index: 0 }]).view.menu, ['stop', 'latest', 'unread', 'list']);
  assert.deepEqual(run([]).view.menu, ['status']);
});

test('answered elsewhere: an open question screen closes when the pending entry clears', () => {
  const q: Entry = { kind: 'question', id: 'q1', at: 0, prompt: '?', options: [{ label: 'A', value: 'A' }], state: 'pending' };
  const r = run([notice({ kind: 'needs-action' }), { type: 'tap' }, conv('a', [q], { pending: { kind: 'question', entryId: 'q1' } }), conv('a', [{ ...q, state: 'answered' }])]);
  assert.equal(r.screen, 'conversation');
  assert.match(r.view.kind === 'text' ? r.view.header : '', /回答済みです/);
});

test('reconnecting while a conversation is open re-opens it on the relay', () => {
  const r = run([{ type: 'select', index: 0 }, { type: 'connection', up: false }, { type: 'connection', up: true }, srv({ type: 'welcome', bots, health })]);
  assert.equal(r.screen, 'conversation');
  assert.deepEqual(sent(r.effects), ['open', 'open']);
});
