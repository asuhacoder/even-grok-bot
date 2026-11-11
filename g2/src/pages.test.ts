import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Entry } from '../../shared/protocol.ts';
import { LINES_PER_PAGE, clipBytes, entryText, fitLine, paginate, sanitize, wrap } from './pages.ts';

test('Japanese wraps at 28 glyphs per line (20 px each within 560 px)', () => {
  assert.deepEqual(wrap('あ'.repeat(30)).map(l => l.length), [28, 2]);
});

test('a page never exceeds the lines that fit on screen', () => {
  const ps = paginate('開発PMに、今日のプルリクエストのレビュー状況を教えて。'.repeat(20));
  assert.ok(ps.length > 1);
  for (const p of ps) assert.ok(p.split('\n').length <= LINES_PER_PAGE);
});

test('glyphs missing from the firmware font are mapped or dropped', () => {
  assert.equal(sanitize('`npm` ✓ ❌ ⚠️'), "'npm' ○ × ！");
});

test('list rows end with an ellipsis when they would overflow one line', () => {
  const line = fitLine('明'.repeat(40));
  assert.equal(line.length, 28);
  assert.ok(line.endsWith('…'));
});

test('byte clipping keeps Japanese list rows within the 63-byte host limit', () => {
  const r = clipBytes('開発PM｜要対応｜Allowed: Save the routine “pjt_sample GitHubイベント対応”', 63);
  assert.ok(new TextEncoder().encode(r).length <= 63);
  assert.ok(r.endsWith('…'));
  assert.equal(clipBytes('短い', 63), '短い');
});

test('a closing mark never starts a line', () => {
  const lines = wrap('あ'.repeat(28) + '。次の文');
  assert.deepEqual(lines, ['あ'.repeat(27), 'あ。次の文']);
});

test('a peer line is the phrase with no speaker header', () => {
  const inbound: Entry = { kind: 'text', id: 'in', at: 1, author: 'other', from: 'デモボット', text: 'デモボット から' };
  const inboundLine = entryText(inbound, 'Bot A');
  assert.equal(inboundLine, 'デモボット から');
  assert.equal(inboundLine.includes('\n'), false);
  const outbound: Entry = { kind: 'text', id: 'out', at: 1, author: 'bot', from: '', peer: 'out', text: 'Bot B へ' };
  const outboundLine = entryText(outbound, 'Bot A');
  assert.equal(outboundLine, 'Bot B へ');
  assert.equal(outboundLine.includes('\n'), false);
});

test('a person and a bot reply keep the speaker header and the body', () => {
  const person: Entry = { kind: 'text', id: 'me', at: 0, author: 'me', from: '', text: 'こんにちは' };
  const personLine = entryText(person, 'Bot A');
  assert.ok(personLine.includes('▶あなた'));
  assert.ok(personLine.includes('こんにちは'));
  const reply: Entry = { kind: 'text', id: 'bot', at: 0, author: 'bot', from: '', text: '了解しました' };
  const replyLine = entryText(reply, 'Bot A');
  assert.ok(replyLine.includes('◀'));
  assert.ok(replyLine.includes('Bot A'));
  assert.ok(replyLine.includes('了解しました'));
});
