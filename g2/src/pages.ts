// Text layout for the 576x288 display, measured with the firmware's own glyph
// advances (@evenrealities/pretext) so one page is exactly one screen.
// Conversation pages are filled greedily from the first entry, so appending
// entries never moves earlier page boundaries and the reader's page stays put.

import { getAdvW } from '@evenrealities/pretext';
import { peerText, type Conversation, type Entry } from '../../shared/protocol.ts';

export const HEADER_HEIGHT = 36;
export const PADDING = 4;
/** Wrap width: 576 minus padding, with slack for kerning differences on device. */
const WRAP_PX = 576 - 2 * PADDING - 8;
/** (288 - header - padding) / 27 px line height. */
export const LINES_PER_PAGE = 9;

/** Glyphs the firmware font lacks (from a scan of real transcripts), mapped to ones it has. */
const GLYPH_MAP: Record<string, string> = { '`': "'", '❌': '×', '✗': '×', '✓': '○', '⏭': '»', '⚠': '！' };

/** Host limits measured in the simulator (g2/sim/exp.ts): text <= 999 bytes, list item <= 63 bytes, <= 20 items. */
export const TEXT_MAX_BYTES = 999;
export const ITEM_MAX_BYTES = 63;
export const LIST_MAX_ITEMS = 20;

const encoder = new TextEncoder();
export function clipBytes(text: string, max: number): string {
  if (encoder.encode(text).length <= max) return text;
  let out = '';
  let used = 0;
  const ell = encoder.encode('…').length;
  for (const ch of text) {
    const n = encoder.encode(ch).length;
    if (used + n + ell > max) break;
    out += ch;
    used += n;
  }
  return out + '…';
}

const advance = (ch: string) => Math.round(getAdvW(ch.codePointAt(0)!) / 16);

export function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const mapped = GLYPH_MAP[ch] ?? ch;
    if (mapped === '\n' || advance(mapped) > 0) out += mapped;
  }
  return out;
}

/** Characters Japanese typesetting never puts at the start of a line. */
const NO_LINE_START = new Set([...'、。，．,.!?！？)）]］}｝」』】〉》ー々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ…・：；:;']);

export function wrap(text: string): string[] {
  const lines: string[] = [];
  for (const para of sanitize(text).split('\n')) {
    let line = '';
    let width = 0;
    for (const ch of para) {
      const w = advance(ch);
      if (width + w > WRAP_PX && line) {
        // Carry the previous character down so a closing mark does not open the next line.
        const chars = [...line];
        const carry = NO_LINE_START.has(ch) && chars.length > 1 ? chars.pop()! : '';
        lines.push(chars.join(''));
        line = carry;
        width = carry ? advance(carry) : 0;
      }
      line += ch;
      width += w;
    }
    lines.push(line);
  }
  return lines;
}

/** Splits text into screen-sized pages. */
export function paginate(text: string, linesPerPage = LINES_PER_PAGE): string[] {
  const lines = wrap(text);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) out.push(lines.slice(i, i + linesPerPage).join('\n'));
  return out.length ? out : [''];
}

export function fitLine(text: string, px = WRAP_PX): string {
  const flat = sanitize(text.replace(/\s+/g, ' ').trim());
  let width = 0;
  let out = '';
  for (const ch of flat) {
    width += advance(ch);
    if (width > px - advance('…')) return out + '…';
    out += ch;
  }
  return out;
}

const hhmm = (at: number) => {
  const d = new Date(at);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function entryText(e: Entry, botName: string): string {
  switch (e.kind) {
    case 'text': {
      const peer = peerText(e);
      if (peer !== undefined) return peer;
      const who = e.author === 'me' ? '▶あなた' : `◀${botName}`;
      return `${who} ${hhmm(e.at)}\n${e.text}`;
    }
    case 'question': {
      const state = e.state === 'pending' ? '回答待ち' : e.state === 'answered' ? '回答済み' : 'スキップ';
      const opts = e.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
      const hint = e.state === 'pending' ? '\n（タップで回答を選ぶ）' : '';
      return `◀${botName} ${hhmm(e.at)}［質問・${state}］\n${e.prompt}\n${opts}${hint}`;
    }
    case 'approval': {
      const state = { pending: '承認待ち', approved: '許可済み', denied: '拒否済み', expired: '期限切れ' }[e.state];
      const hint = e.state === 'pending' ? '\n（タップで許可・拒否を選ぶ）' : '';
      return `◀${botName} ${hhmm(e.at)}［承認・${state}］\n${e.summary}${hint}`;
    }
    case 'item':
      return `［${e.label}］`;
  }
}

export function questionText(e: Extract<Entry, { kind: 'question' }>): string {
  return [e.prompt, ...e.options.map((o, i) => `${i + 1}. ${o.label}`)].join('\n');
}

export function approvalText(e: Extract<Entry, { kind: 'approval' }>): string {
  return `${e.summary}\n\n理由: ${e.reason || '（記載なし）'}`;
}

/** One screen line of the conversation, tagged with the entry it belongs to (null for separators). */
export interface Line {
  text: string;
  entryId: string | null;
}

/** Lines moved per swipe: a third of the screen, so the reader keeps context. */
export const SCROLL_LINES = 3;

export const UNREAD_OPEN_MAX_LINES = LINES_PER_PAGE * 3;

const cache = new WeakMap<Conversation, Line[]>();

export function lines(c: Conversation): Line[] {
  const hit = cache.get(c);
  if (hit) return hit;
  const out: Line[] = [];
  for (const e of c.entries) {
    if (out.length) out.push({ text: '', entryId: null });
    for (const text of wrap(entryText(e, c.botName))) out.push({ text, entryId: e.id });
  }
  if (out.length === 0) out.push({ text: 'まだ会話がありません', entryId: null });
  cache.set(c, out);
  return out;
}

/** Top line that shows the end of the conversation. */
export const lastTop = (c: Conversation) => Math.max(0, lines(c).length - LINES_PER_PAGE);

export function lineOfEntry(c: Conversation, entryId: string | null): number | null {
  if (!entryId) return null;
  const i = lines(c).findIndex(l => l.entryId === entryId);
  return i < 0 ? null : i;
}

export function openingTop(c: Conversation): number {
  const end = lastTop(c);
  const unread = lineOfEntry(c, c.firstUnreadId);
  if (unread === null || end - unread > UNREAD_OPEN_MAX_LINES) return end;
  return unread;
}

export const windowLines = (c: Conversation, top: number) => lines(c).slice(top, top + LINES_PER_PAGE);
