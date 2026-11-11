import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPending, firstUnread, normalizeEntry, questionChoice, toConversation } from './grok/normalize.ts';
import { diffRows, emptyWatch, entryPreview, reflectShown, shownPreview, summaries } from './watch.ts';
import type { BotRow } from './watch.ts';

const row = (o: Partial<BotRow>): BotRow => ({ id: 'a', name: '開発PM', preview: '了解', awaiting: false, working: false, unread: false, current: false, ...o });

function after(prev: BotRow[], next: BotRow[]) {
  const w = diffRows(emptyWatch(), prev, 100).watch;
  return diffRows(w, next, 200);
}

test('first snapshot never notifies', () => {
  assert.deepEqual(diffRows(emptyWatch(), [row({ unread: true })], 1).notices, []);
});

test('bot reply that marks the bot unread notifies with the preview verbatim', () => {
  const r = after([row({ working: true })], [row({ preview: 'PRを出しました', unread: true })]);
  assert.deepEqual(r.notices, [{ id: 'a:200', botId: 'a', botName: '開発PM', kind: 'done', text: 'PRを出しました', at: 200 }]);
});

test('user message sent from the phone does not notify', () => {
  assert.deepEqual(after([row({})], [row({ preview: '進捗は？', working: true })]).notices, []);
});

test('waiting on the user is a needs-action notice', () => {
  const r = after([row({ working: true })], [row({ preview: 'Approval needed', awaiting: true, working: true })]);
  assert.equal(r.notices[0]?.kind, 'needs-action');
});

test('the bot shown on the desktop is left to the transcript path', () => {
  assert.deepEqual(after([row({ current: true })], [row({ current: true, preview: '新着', unread: true })]).notices, []);
});

test('summaries rank status and keep observed activity time', () => {
  const r = after([row({}), row({ id: 'b', name: 'B' })], [row({}), row({ id: 'b', name: 'B', preview: 'x', unread: true })]);
  assert.deepEqual(
    summaries(r.watch).map(s => [s.id, s.status, s.activityAt]),
    [['a', 'idle', 2], ['b', 'unread', 200]],
  );
});

test('normalize: shapes observed in Grok Bot 0.71.2', () => {
  assert.deepEqual(normalizeEntry({ kind: 'message', id: 'u1', role: 'user', content: 'こんにちは', timestampMs: 5 }), {
    kind: 'text', id: 'u1', at: 5, author: 'me', from: '', text: 'こんにちは',
  });
  assert.deepEqual(normalizeEntry({ kind: 'message', id: 'u2', role: 'user', content: '初期設定を', fromAgent: { id: 'x', name: 'デモボット' } }), {
    kind: 'text', id: 'u2', at: 0, author: 'other', from: 'デモボット', text: 'デモボット から',
  });
  assert.deepEqual(
    normalizeEntry({ kind: 'send-message', id: 'w', message: { type: 'widget', widget: { prompt: '2段階認証は？', options: [{ label: '設定済み', value: 'もう設定済み' }] } } }),
    { kind: 'question', id: 'w', at: 0, prompt: '2段階認証は？', options: [{ label: '設定済み', value: 'もう設定済み' }], state: 'pending' },
  );
  assert.deepEqual(
    normalizeEntry({ kind: 'send-message', id: 'p', message: { type: 'auto-review-approval', approval: { summary: 'Run a task', reason: 'sign in', status: 'approved' } } }),
    { kind: 'approval', id: 'p', at: 0, summary: 'Run a task', reason: 'sign in', state: 'approved' },
  );
  assert.deepEqual(
    normalizeEntry({ kind: 'event', id: 'ev', event: { type: 'automation-changed', action: 'created', automationName: '稼働報告' } }),
    { kind: 'item', id: 'ev', at: 0, label: 'ルーティン作成: 稼働報告' },
  );
  assert.equal(normalizeEntry({ kind: 'send-message', id: 'f', message: { type: 'user-form', formRequest: { title: 'ログイン' } } }).kind, 'item');
});

test('peer sends are one line and drop the message body', () => {
  const body = 'この長い本文はピアの行に残らないことを確認するための文字列です';
  const outbound = {
    kind: 'text', id: 'o1', at: 0, author: 'bot', from: '', peer: 'out', text: 'Bot B へ',
  };
  const sent = normalizeEntry({
    kind: 'message', id: 'o1', role: 'assistant', content: body, attachments: [{ name: 'a' }], toAgent: { id: 'b', name: 'Bot B' },
  });
  assert.deepEqual(sent, outbound);
  assert.ok(sent.kind === 'text' && !sent.text.includes(body));
  assert.equal(shownPreview('本文が長い', sent), 'Bot B へ');
  assert.equal(entryPreview(sent), 'Bot B へ');
  assert.deepEqual(
    normalizeEntry({ kind: 'message', id: 'o1', role: 'assistant', content: body, toAgent: { id: 'b', name: 'Bot B', kind: 'agent' } }),
    outbound,
  );
  assert.deepEqual(normalizeEntry({ kind: 'message', id: 'ni', role: 'user', content: body, fromAgent: { id: 'x' } }), {
    kind: 'text', id: 'ni', at: 0, author: 'other', from: '他のボット', text: '他のボット から',
  });
  assert.deepEqual(normalizeEntry({ kind: 'message', id: 'ne', role: 'user', content: body, fromAgent: { id: 'x', name: '' } }), {
    kind: 'text', id: 'ne', at: 0, author: 'other', from: '他のボット', text: '他のボット から',
  });
  assert.deepEqual(normalizeEntry({ kind: 'message', id: 'no', role: 'assistant', content: body, toAgent: { id: 'b' } }), {
    kind: 'text', id: 'no', at: 0, author: 'bot', from: '', peer: 'out', text: '他のボット へ',
  });
  assert.deepEqual(normalizeEntry({ kind: 'message', id: 'u1', role: 'user', content: 'こんにちは', timestampMs: 5 }), {
    kind: 'text', id: 'u1', at: 5, author: 'me', from: '', text: 'こんにちは',
  });
  assert.deepEqual(
    normalizeEntry({ kind: 'send-message', id: 'sm', toAgent: { id: 'b', name: 'Bot B' }, message: { type: 'text', content: '全文の返信です' } }),
    { kind: 'text', id: 'sm', at: 0, author: 'bot', from: '', text: '全文の返信です' },
  );
  assert.deepEqual(normalizeEntry({ kind: 'message', id: 'a1', role: 'assistant', content: body }), {
    kind: 'text', id: 'a1', at: 0, author: 'bot', from: '', text: body,
  });
  const inbound = normalizeEntry({ kind: 'message', id: 'u2', role: 'user', content: body, fromAgent: { id: 'x', name: 'デモボット' } });
  assert.equal(shownPreview('本文が長い', inbound), 'デモボット から');
  const user = normalizeEntry({ kind: 'message', id: 'u', role: 'user', content: 'こんにちは' });
  assert.equal(shownPreview('了解', user), '了解');
});

test('a choice stays open without the sidebar flag and closes after the wearer replies', () => {
  const q = normalizeEntry({ kind: 'send-message', id: 'w', message: { type: 'widget', widget: { prompt: '?', options: [] } } });
  const me = normalizeEntry({ kind: 'message', id: 'u', role: 'user', content: 'A' });
  assert.deepEqual(findPending([q], false), { kind: 'question', entryId: 'w' });
  assert.deepEqual(findPending([q], true), { kind: 'question', entryId: 'w' });
  assert.equal(findPending([q, me], false), null);
  assert.equal(findPending([q, me], true), null);
});

const choice = (id: string, extra: Record<string, unknown> = {}) =>
  normalizeEntry({
    kind: 'send-message',
    id,
    message: { type: 'widget', widget: { prompt: 'どれにしますか', options: [{ label: '案B', value: 'b' }, { label: '案A', value: 'a' }] } },
    ...extra,
  });

test('an answered, skipped, or dismissed widget is not waiting', () => {
  const answered = choice('w', { respondedValue: 'b' });
  assert.equal(answered.kind === 'question' && answered.state, 'answered');
  assert.equal(findPending([answered], true), null);
  assert.equal(findPending([choice('e', { respondedValue: 'b', respondedValueEchoed: true })], false), null);
  const legacy = choice('old', { widgetAnswer: 'b' });
  assert.equal(legacy.kind === 'question' && legacy.state, 'answered');
  const skipped = choice('s', { widgetSkipped: true });
  assert.equal(skipped.kind === 'question' && skipped.state, 'skipped');
  assert.equal(findPending([skipped], true), null);
  const dismissed = choice('d', { widgetDismissed: true });
  assert.equal(dismissed.kind === 'question' && dismissed.state, 'skipped');
  assert.equal(findPending([dismissed], false), null);
});

test('a pending approval still needs the sidebar flag and blocks an older choice', () => {
  const q = choice('w');
  const approval = normalizeEntry({
    kind: 'send-message', id: 'p', message: { type: 'auto-review-approval', approval: { summary: 'Run', reason: '', status: 'pending' } },
  });
  assert.equal(findPending([approval], false), null);
  assert.deepEqual(findPending([approval], true), { kind: 'approval', entryId: 'p' });
  assert.equal(findPending([q, approval], false), null);
  assert.deepEqual(findPending([approval, q], false), { kind: 'question', entryId: 'w' });
});

test('a widget sent to another bot is still a pending choice', () => {
  const q = normalizeEntry({
    kind: 'send-message',
    id: 'w',
    toAgent: { id: 'b', name: 'Bot B' },
    message: { type: 'widget', widget: { prompt: 'どっち？', options: [{ label: '案B', value: 'b' }] } },
  });
  assert.equal(q.kind, 'question');
  if (q.kind !== 'question') return;
  assert.equal(q.state, 'pending');
  assert.deepEqual(q.options, [{ label: '案B', value: 'b' }]);
  assert.deepEqual(findPending([q], false), { kind: 'question', entryId: 'w' });
});

test('opening a bot keeps a pending choice when the sidebar is not awaiting', () => {
  const widget = (extra: Record<string, unknown> = {}) => ({
    kind: 'send-message',
    id: 'w',
    seq: 4,
    message: { type: 'widget', widget: { prompt: 'どれにしますか', options: [{ label: '案B', value: 'b' }] } },
    ...extra,
  });
  const open = (entry: ReturnType<typeof widget>, awaiting: boolean) => toConversation(
    { agentId: 'a', loadState: 'ready', running: false, hasOlder: false, unreadAnchor: null, entries: [entry] },
    { name: '開発PM', awaiting },
    undefined,
    false,
  );
  assert.deepEqual(open(widget(), false).pending, { kind: 'question', entryId: 'w' });
  assert.equal(open(widget({ respondedValue: 'b' }), true).pending, null);
});

test('the label sent to the desktop is the pending option only', () => {
  const pending = choice('w');
  assert.equal(questionChoice(pending, 'b'), '案B');
  assert.equal(questionChoice(pending, 'missing'), null);
  assert.equal(questionChoice(choice('a', { respondedValue: 'b' }), 'b'), null);
  assert.equal(questionChoice(choice('s', { widgetSkipped: true }), 'b'), null);
  assert.equal(questionChoice(choice('d', { widgetDismissed: true }), 'b'), null);
  const text = normalizeEntry({ kind: 'message', id: 'u', role: 'user', content: 'A' });
  assert.equal(questionChoice(text, 'b'), null);
});

test('the shown bot is needs-action when its transcript has an open choice', () => {
  const shown = reflectShown(row({ current: true, awaiting: false, preview: '古い' }), [choice('w')]);
  assert.equal(shown.awaiting, true);
  assert.equal(shown.preview, '古い');
  assert.equal(summaries(after([row({ current: true })], [shown]).watch)[0]?.status, 'needs-action');
  assert.equal(reflectShown(row({ current: true, awaiting: false }), [choice('a', { respondedValue: 'b' })]).awaiting, false);
  const approval = normalizeEntry({
    kind: 'send-message', id: 'p', message: { type: 'auto-review-approval', approval: { summary: 'Run', reason: '', status: 'pending' } },
  });
  assert.equal(reflectShown(row({ awaiting: false }), [approval]).awaiting, false);
  const peer = normalizeEntry({ kind: 'message', id: 'o', role: 'assistant', content: '本文', toAgent: { id: 'b', name: 'Bot B' } });
  const collapsed = reflectShown(row({ preview: '古い' }), [peer]);
  assert.equal(collapsed.preview, 'Bot B へ');
  assert.equal(collapsed.awaiting, false);
});

test('first unread follows the G2 read point', () => {
  const c = toConversation(
    { agentId: 'a', loadState: 'ready', running: false, hasOlder: false, unreadAnchor: null, entries: [
      { kind: 'message', id: 'u', role: 'user', content: 'x', seq: 1 },
      { kind: 'send-message', id: 's1', message: { type: 'text', content: 'y' }, seq: 2 },
      { kind: 'send-message', id: 's2', message: { type: 'text', content: 'z' }, seq: 3 },
    ] },
    { name: '開発PM', awaiting: false },
    2,
    false,
  );
  assert.equal(c.firstUnreadId, 's2');
});

test('seeing the last entry leaves nothing unread, even when the desktop anchor is older', () => {
  const entries = [
    { kind: 'message', id: 'u', role: 'user', content: 'x', seq: 1 },
    { kind: 'send-message', id: 's1', message: { type: 'text', content: 'y' }, seq: 2 },
    { kind: 'send-message', id: 's2', message: { type: 'text', content: 'z' }, seq: 3 },
  ];
  const transcript = { agentId: 'a', loadState: 'ready', running: false, hasOlder: false, unreadAnchor: 's1', entries };
  assert.equal(toConversation(transcript, { name: '開発PM', awaiting: false }, 3, false).firstUnreadId, null);
  assert.equal(firstUnread(entries, undefined, 's1'), 's1');
});
