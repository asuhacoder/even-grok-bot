// G2 screen state machine. Pure: (model, input) -> (model, effects).
// The screen stack encodes "double tap = previous screen". The Bot list is the
// root; opening from a notice rebuilds the stack as [list, ...] so back lands there.

import type {
  ApprovalChoice,
  BotSummary,
  ClientMessage,
  Conversation,
  Entry,
  Health,
  Notice,
  ServerMessage,
} from '../../shared/protocol.ts';
import { LINES_PER_PAGE, LIST_MAX_ITEMS, approvalText, lastTop, lineOfEntry, lines, openingTop, paginate, questionText, SCROLL_LINES } from './pages.ts';

/** A question or an approval: read its content first, then choose. */
export type CardScreen = {
  name: 'question' | 'approval';
  botId: string;
  entryId: string;
  phase: 'content' | 'choices';
  page: number;
};

export type Screen =
  | { name: 'notice'; id: string }
  /** Rows are frozen while the list is shown, so a tap opens the Bot the user saw. */
  | { name: 'list'; rows: BotSummary[] }
  /**
   * `top` is the first line on screen. `anchor` pins it to an entry, so new or
   * older entries arriving never move what the reader is looking at.
   */
  | { name: 'conversation'; botId: string; top: number | null; anchor: { id: string; offset: number } | null; routePending: boolean }
  | { name: 'recording'; botId: string; reqId: string }
  | { name: 'transcribing'; botId: string; reqId: string }
  | { name: 'confirm'; botId: string; text: string }
  | CardScreen
  | { name: 'always-confirm'; botId: string; entryId: string }
  | { name: 'status' };

export interface Model {
  stack: Screen[];
  bots: BotSummary[];
  conversation: Conversation | null;
  notices: Notice[];
  health: Health;
  connected: boolean;
  toast: string | null;
  seq: number;
  /** Notices arrived while recording or confirming; show them once the user is back on the list. */
  deferred: boolean;
}

export type MenuId = 'stop' | 'latest' | 'unread' | 'list' | 'status' | 'redo';

export type Input =
  | { type: 'tap' }
  | { type: 'select'; index: number }
  | { type: 'double' }
  | { type: 'scroll'; dir: 'up' | 'down' }
  | { type: 'menu'; item: MenuId }
  | { type: 'server'; msg: ServerMessage }
  | { type: 'connection'; up: boolean };

export type Effect =
  | { type: 'send'; msg: ClientMessage }
  | { type: 'mic'; on: boolean }
  | { type: 'exit' };

export interface Step {
  model: Model;
  effects: Effect[];
}

export const QUESTION_VOICE = '音声で回答';
export const APPROVAL_CHOICES: { label: string; choice: ApprovalChoice | 'voice' }[] = [
  { label: '一回だけ許可', choice: 'once' },
  { label: '拒否', choice: 'deny' },
  { label: '常に許可', choice: 'always' },
  { label: '音声で返答', choice: 'voice' },
];
export const OFFLINE = '未接続のため送れません';

export function initialModel(): Model {
  return {
    stack: [{ name: 'list', rows: [] }],
    bots: [],
    conversation: null,
    notices: [],
    health: { relay: 'down', grok: 'down', asr: 'down', detail: '接続していません' },
    connected: false,
    toast: null,
    seq: 0,
    deferred: false,
  };
}

export function top(m: Model): Screen {
  return m.stack[m.stack.length - 1] ?? { name: 'list', rows: [] };
}

/** Screens during which notices must not take over the display. */
function isCapturing(s: Screen): boolean {
  return s.name === 'recording' || s.name === 'transcribing' || s.name === 'confirm';
}

export function sortBots(bots: BotSummary[]): BotSummary[] {
  const rank = (b: BotSummary) => (b.status === 'needs-action' ? 0 : b.status === 'unread' ? 1 : 2);
  return [...bots].sort((a, b) => rank(a) - rank(b) || b.activityAt - a.activityAt);
}

const home = (m: Model): Screen => ({ name: 'list', rows: sortBots(m.bots) });
const rowKey = (rows: BotSummary[]) => rows.map(b => `${b.id}:${b.status}`).join(',');

/**
 * Re-sorts the root list when order or status changed. Rows stay put on preview-only
 * changes, because a rebuild moves the firmware's highlight back to the first row.
 */
function refreshHome(m: Model): Model {
  const s = top(m);
  if (m.stack.length !== 1 || s.name !== 'list') return m;
  const rows = sortBots(m.bots);
  return rowKey(rows) === rowKey(s.rows) ? m : { ...m, stack: [{ name: 'list', rows }] };
}

const entryOf = (m: Model, id: string): Entry | undefined => m.conversation?.entries.find(e => e.id === id);

/** Choice rows for a card; the list holds at most 20 rows, the last being the voice reply. */
export function cardChoices(m: Model, s: CardScreen): { label: string; pick: { value: string } | ApprovalChoice | 'voice' }[] {
  if (s.name === 'approval') return APPROVAL_CHOICES.map(c => ({ label: c.label, pick: c.choice }));
  const e = entryOf(m, s.entryId);
  const opts = e?.kind === 'question' ? e.options.slice(0, LIST_MAX_ITEMS - 1) : [];
  return [...opts.map(o => ({ label: o.label, pick: { value: o.value } })), { label: QUESTION_VOICE, pick: 'voice' as const }];
}

/** Card content split into screens, leaving two lines per screen for the hint. */
export function cardPages(m: Model, s: CardScreen): string[] {
  const e = entryOf(m, s.entryId);
  if (e?.kind === 'approval') return paginate(approvalText(e), LINES_PER_PAGE - 2);
  if (e?.kind === 'question') return paginate(questionText(e), LINES_PER_PAGE - 2);
  return [''];
}

export function step(m: Model, input: Input): Step {
  const fx: Effect[] = [];
  let next: Model = input.type === 'server' || input.type === 'connection' ? m : { ...m, toast: null };
  next = reduce(next, input, fx);
  return { model: next, effects: fx };
}

function reduce(m: Model, input: Input, fx: Effect[]): Model {
  switch (input.type) {
    case 'server':
      return onServer(m, input.msg, fx);
    case 'connection':
      return input.up ? { ...m, connected: true } : onDisconnect(m, fx);
    case 'menu':
      return onMenu(m, input.item, fx);
    default:
      return onGesture(m, input, fx);
  }
}

const reqId = (m: Model): [Model, string] => [{ ...m, seq: m.seq + 1 }, `r${m.seq + 1}`];

const replaceTop = (m: Model, s: Screen): Model => ({ ...m, stack: [...m.stack.slice(0, -1), s] });
const push = (m: Model, s: Screen): Model => ({ ...m, stack: [...m.stack, s] });

function pop(m: Model, fx: Effect[]): Model {
  const popped = m.stack.length > 1 ? { ...m, stack: m.stack.slice(0, -1) } : m;
  return settle(popped, fx);
}

/** After leaving a screen: close the relay's view if no conversation remains, surface deferred notices on the list. */
function settle(m: Model, fx: Effect[]): Model {
  const hasConversation = m.stack.some(s => 'botId' in s);
  let next = m;
  if (!hasConversation && m.conversation) {
    fx.push({ type: 'send', msg: { type: 'close' } });
    next = { ...next, conversation: null };
  }
  if (top(next).name !== 'list') return next;
  // Coming back to the list re-sorts it, so a Bot that notified meanwhile is near the top.
  next = replaceTop(next, home(next));
  const first = next.notices[0];
  if (next.deferred && first) next = push({ ...next, deferred: false }, { name: 'notice', id: first.id });
  return next;
}

/** Actions that need the relay refuse while offline instead of pretending to send. */
function offline(m: Model): Model | null {
  return m.connected ? null : { ...m, toast: OFFLINE };
}

function openBot(m: Model, botId: string, routePending: boolean, fx: Effect[]): Model {
  fx.push({ type: 'send', msg: { type: 'open', botId } });
  const notices = m.notices.filter(n => n.botId !== botId);
  const conversation = m.conversation?.botId === botId ? m.conversation : null;
  return push({ ...m, notices, conversation }, { name: 'conversation', botId, top: null, anchor: null, routePending });
}

function startRecording(m: Model, botId: string, fx: Effect[]): Model {
  const down = offline(m);
  if (down) return down;
  const [m2, id] = reqId(m);
  fx.push({ type: 'send', msg: { type: 'audio-begin', reqId: id } }, { type: 'mic', on: true });
  return push(m2, { name: 'recording', botId, reqId: id });
}

/** Scrolls the open conversation so `topLine` is first on screen and reports the G2 read point. */
function showLines(m: Model, s: Extract<Screen, { name: 'conversation' }>, topLine: number, fx: Effect[]): Model {
  const c = m.conversation;
  if (!c) return m;
  const ls = lines(c);
  const t = Math.max(0, Math.min(lastTop(c), topLine));
  const last = ls.slice(t, t + LINES_PER_PAGE).findLast(l => l.entryId)?.entryId;
  if (last) fx.push({ type: 'send', msg: { type: 'read', botId: s.botId, entryId: last } });
  const first = ls.slice(t).find(l => l.entryId)?.entryId;
  const anchor = first ? { id: first, offset: t - lineOfEntry(c, first)! } : null;
  return replaceTop(m, { ...s, top: t, anchor });
}

const cardFor = (c: Conversation): CardScreen | null =>
  c.pending ? { name: c.pending.kind, botId: c.botId, entryId: c.pending.entryId, phase: 'content', page: 0 } : null;

function onGesture(m: Model, g: Exclude<Input, { type: 'server' | 'connection' | 'menu' }>, fx: Effect[]): Model {
  const s = top(m);
  const isTap = g.type === 'tap' || g.type === 'select';
  const index = g.type === 'select' ? g.index : 0;

  switch (s.name) {
    case 'notice': {
      const i = m.notices.findIndex(n => n.id === s.id);
      const n = m.notices[i];
      if (!n || g.type === 'double') return pop({ ...m, notices: [] }, fx);
      if (g.type === 'scroll') {
        const j = Math.max(0, Math.min(m.notices.length - 1, i + (g.dir === 'down' ? 1 : -1)));
        return replaceTop(m, { name: 'notice', id: m.notices[j]!.id });
      }
      return openBot({ ...m, stack: [home(m)] }, n.botId, n.kind === 'needs-action', fx);
    }

    case 'list': {
      // The list is the root: double tap asks the OS exit dialog (required by Even Hub review).
      if (g.type === 'double') {
        fx.push({ type: 'exit' });
        return m;
      }
      if (!isTap) return m;
      const bot = s.rows[index];
      // A Bot waiting on the user opens straight onto its question or approval.
      return bot ? openBot(m, bot.id, bot.status === 'needs-action', fx) : m;
    }

    case 'conversation': {
      const c = m.conversation?.botId === s.botId ? m.conversation : null;
      if (g.type === 'double') return pop(m, fx);
      if (g.type === 'scroll') {
        if (!c || s.top === null) return m;
        if (g.dir === 'up' && s.top === 0 && c.hasOlder) {
          const down = offline(m);
          if (down) return down;
          fx.push({ type: 'send', msg: { type: 'older', botId: s.botId } });
          return { ...m, toast: '過去の会話を読み込み中…' };
        }
        return showLines(m, s, s.top + (g.dir === 'down' ? SCROLL_LINES : -SCROLL_LINES), fx);
      }
      if (!isTap) return m;
      const card = c && cardFor(c);
      if (card) return push(m, card);
      return startRecording(m, s.botId, fx);
    }

    case 'recording':
      if (isTap) {
        fx.push({ type: 'mic', on: false }, { type: 'send', msg: { type: 'audio-end', reqId: s.reqId } });
        return replaceTop(m, { name: 'transcribing', botId: s.botId, reqId: s.reqId });
      }
      if (g.type === 'double') {
        fx.push({ type: 'mic', on: false }, { type: 'send', msg: { type: 'audio-cancel', reqId: s.reqId } });
        return pop(m, fx);
      }
      return m;

    case 'transcribing':
      if (g.type === 'double') {
        fx.push({ type: 'send', msg: { type: 'audio-cancel', reqId: s.reqId } });
        return pop(m, fx);
      }
      return m;

    case 'confirm': {
      if (g.type === 'double') return pop({ ...m, toast: '破棄しました' }, fx);
      if (!isTap) return m;
      const down = offline(m);
      if (down) return down;
      const [m2, id] = reqId(m);
      fx.push({ type: 'send', msg: { type: 'send', reqId: id, botId: s.botId, text: s.text } });
      return pop({ ...m2, toast: '送信中…' }, fx);
    }

    case 'question':
    case 'approval':
      return onCard(m, s, g, index, fx);

    case 'always-confirm': {
      if (g.type === 'double') return pop(m, fx);
      if (!isTap) return m;
      const down = offline(m);
      if (down) return down;
      const [m2, id] = reqId(m);
      fx.push({ type: 'send', msg: { type: 'approve', reqId: id, botId: s.botId, entryId: s.entryId, choice: 'always' } });
      return pop({ ...m2, stack: m2.stack.slice(0, -1), toast: '送信中…' }, fx);
    }

    case 'status':
      if (g.type === 'double') return pop(m, fx);
      return m;
  }
}

function onCard(m: Model, s: CardScreen, g: Exclude<Input, { type: 'server' | 'connection' | 'menu' }>, index: number, fx: Effect[]): Model {
  const isTap = g.type === 'tap' || g.type === 'select';
  if (g.type === 'double') return pop(m, fx);
  if (s.phase === 'content') {
    const count = cardPages(m, s).length;
    if (g.type === 'scroll' && g.dir === 'up') return replaceTop(m, { ...s, page: Math.max(0, s.page - 1) });
    if (g.type === 'scroll' && g.dir === 'down')
      return replaceTop(m, s.page + 1 < count ? { ...s, page: s.page + 1 } : { ...s, phase: 'choices' });
    return isTap ? replaceTop(m, { ...s, phase: 'choices' }) : m;
  }
  if (g.type === 'scroll' && g.dir === 'up') return replaceTop(m, { ...s, phase: 'content' });
  if (!isTap) return m;
  const choice = cardChoices(m, s)[index];
  if (!choice) return m;
  if (choice.pick === 'voice') return startRecording(pop(m, []), s.botId, fx);
  if (choice.pick === 'always') return push(m, { name: 'always-confirm', botId: s.botId, entryId: s.entryId });
  const down = offline(m);
  if (down) return down;
  const [m2, id] = reqId(m);
  const msg: ClientMessage =
    typeof choice.pick === 'object'
      ? { type: 'answer', reqId: id, botId: s.botId, entryId: s.entryId, value: choice.pick.value }
      : { type: 'approve', reqId: id, botId: s.botId, entryId: s.entryId, choice: choice.pick };
  fx.push({ type: 'send', msg });
  return pop({ ...m2, toast: '送信中…' }, fx);
}

export function menuFor(s: Screen): MenuId[] {
  switch (s.name) {
    case 'conversation':
      return ['stop', 'latest', 'unread', 'list'];
    case 'confirm':
      return ['redo'];
    case 'recording':
    case 'transcribing':
    case 'always-confirm':
      return [];
    default:
      return ['status'];
  }
}

function onMenu(m: Model, item: MenuId, fx: Effect[]): Model {
  const s = top(m);
  if (!menuFor(s).includes(item)) return m;
  switch (item) {
    case 'list':
      return settle({ ...m, stack: [home(m)] }, fx);
    case 'status':
      return push(m, { name: 'status' });
    case 'stop': {
      if (s.name !== 'conversation') return m;
      const down = offline(m);
      if (down) return down;
      const [m2, id] = reqId(m);
      fx.push({ type: 'send', msg: { type: 'stop', reqId: id, botId: s.botId } });
      return { ...m2, toast: '停止中…' };
    }
    case 'latest':
    case 'unread': {
      if (s.name !== 'conversation' || !m.conversation) return m;
      const c = m.conversation;
      const t = item === 'latest' ? lastTop(c) : (lineOfEntry(c, c.firstUnreadId) ?? lastTop(c));
      return showLines(m, s, t, fx);
    }
    case 'redo': {
      if (s.name !== 'confirm') return m;
      const down = offline(m);
      if (down) return down;
      const [m2, id] = reqId(m);
      fx.push({ type: 'send', msg: { type: 'audio-begin', reqId: id } }, { type: 'mic', on: true });
      return replaceTop(m2, { name: 'recording', botId: s.botId, reqId: id });
    }
  }
}

function onServer(m: Model, msg: ServerMessage, fx: Effect[]): Model {
  switch (msg.type) {
    case 'welcome': {
      const open = m.stack.find((x): x is Extract<Screen, { name: 'conversation' }> => x.name === 'conversation');
      if (open) fx.push({ type: 'send', msg: { type: 'open', botId: open.botId } });
      return refreshHome({ ...m, bots: msg.bots, health: msg.health, connected: true });
    }
    case 'bots':
      return refreshHome({ ...m, bots: msg.bots });
    case 'health':
      return { ...m, health: msg.health };
    case 'denied':
      return { ...m, connected: false, health: { ...m.health, relay: 'down', detail: `認証エラー: ${msg.reason}` } };
    case 'result':
      return { ...m, toast: msg.message };
    case 'notice':
      return onNotice(m, msg.notice);
    case 'transcript': {
      const s = top(m);
      if (s.name !== 'transcribing' || s.reqId !== msg.reqId) return m;
      const text = msg.text.trim();
      if (!text) return pop({ ...m, toast: '聞き取れませんでした' }, fx);
      return replaceTop(m, { name: 'confirm', botId: s.botId, text });
    }
    case 'conversation':
      return onConversation(m, msg.conversation, fx);
  }
}

function onNotice(m: Model, n: Notice): Model {
  const s = top(m);
  const openBotId = m.stack.find((x): x is Extract<Screen, { name: 'conversation' }> => x.name === 'conversation')?.botId;
  if (openBotId === n.botId) return m;
  // A newer notice from the same Bot replaces the older one; the screen keeps pointing at what it shows by id.
  const stale = m.notices.find(x => x.botId === n.botId);
  const notices = m.notices.map(x => (x === stale ? n : x));
  if (!stale) notices.push(n);
  const stack = m.stack.map(x => (x.name === 'notice' && x.id === stale?.id ? { name: 'notice' as const, id: n.id } : x));
  if (s.name === 'list') return { ...m, notices, stack: [...stack, { name: 'notice', id: n.id }] };
  // While reading only the header mark shows it; while recording it waits for the list.
  return { ...m, notices, stack, deferred: m.deferred || isCapturing(s) };
}

function onConversation(m: Model, c: Conversation, fx: Effect[]): Model {
  const idx = m.stack.findIndex(s => s.name === 'conversation' && s.botId === c.botId);
  if (idx < 0) return m;
  const s = m.stack[idx] as Extract<Screen, { name: 'conversation' }>;
  let next: Model = { ...m, conversation: c };
  const anchored = s.anchor ? lineOfEntry(c, s.anchor.id) : null;
  const t = s.top === null ? openingTop(c) : anchored !== null ? anchored + s.anchor!.offset : s.top;
  const stack = [...next.stack];
  stack[idx] = { ...s, top: Math.max(0, Math.min(lastTop(c), t)), routePending: false };
  next = { ...next, stack };
  if (idx === stack.length - 1) next = showLines(next, stack[idx] as Extract<Screen, { name: 'conversation' }>, t, fx);
  const card = s.routePending && idx === next.stack.length - 1 ? cardFor(c) : null;
  if (card) next = push(next, card);
  // Close question/approval screens for this Bot whose entry is no longer waiting (answered on the Mac or phone).
  const dead = next.stack.findIndex(x => 'entryId' in x && x.botId === c.botId && c.pending?.entryId !== x.entryId);
  if (dead >= 0) next = { ...next, stack: next.stack.slice(0, dead), toast: '回答済みです' };
  return next;
}

function onDisconnect(m: Model, fx: Effect[]): Model {
  const s = top(m);
  if (s.name === 'recording') fx.push({ type: 'mic', on: false });
  const stack = isCapturing(s) ? m.stack.slice(0, -1) : m.stack;
  return {
    ...m,
    stack,
    connected: false,
    health: { relay: 'down', grok: 'down', asr: 'down', detail: 'Mac miniに接続できません' },
  };
}
