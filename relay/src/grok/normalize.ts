// Grok Bot transcript entries (as the renderer holds them) -> protocol Entry.

import type { Conversation, Entry, Pending } from '../../../shared/protocol.ts';

export interface RawTranscript {
  agentId: string;
  loadState: string;
  running: boolean;
  hasOlder: boolean;
  unreadAnchor: unknown;
  entries: RawEntry[];
}

export type RawEntry = { kind: string; id: string; seq?: number; timestampMs?: number; [k: string]: any };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const APPROVAL_STATE: Record<string, Extract<Entry, { kind: 'approval' }>['state']> = {
  pending: 'pending',
  requested: 'pending',
  awaiting: 'pending',
  approved: 'approved',
  allowed: 'approved',
  'always-allowed': 'approved',
  denied: 'denied',
  rejected: 'denied',
  expired: 'expired',
  cancelled: 'expired',
};

const ITEM_LABELS: Record<string, (m: any) => string> = {
  'user-form': m => `入力フォーム: ${str(m.formRequest?.title)}（Macかスマホで入力してください）`,
  'credential-request': () => 'ログイン情報の使用リクエスト（Macかスマホで対応してください）',
  connector: m => `アプリ連携: ${str(m.connector)}`,
  file: m => `ファイル: ${str(m.name ?? m.file?.name ?? m.filename)}`,
  attachment: m => `ファイル: ${str(m.name ?? m.attachment?.name)}`,
  image: () => '画像',
  video: () => '動画',
  audio: () => '音声',
};

function sendMessage(e: RawEntry, at: number): Entry {
  const m = e.message ?? {};
  const type = str(m.type);
  if (type === 'text') return { kind: 'text', id: e.id, at, author: 'bot', from: '', text: str(m.content) };
  if (type === 'widget') {
    const w = m.widget ?? {};
    const options = Array.isArray(w.options)
      ? w.options.map((o: any) => ({ label: str(o.label), value: str(o.value) || str(o.label) }))
      : [];
    const responded =
      e.respondedValue != null ||
      e.widgetAnswer != null ||
      e.widgetResponse != null ||
      e.widgetSelected != null ||
      e.widgetAnswered === true;
    const skipped = e.widgetSkipped === true || e.widgetDismissed === true;
    const state = skipped ? 'skipped' : responded ? 'answered' : 'pending';
    return { kind: 'question', id: e.id, at, prompt: str(w.prompt), options, state };
  }
  if (type.includes('approval')) {
    const a = m.approval ?? m;
    return {
      kind: 'approval',
      id: e.id,
      at,
      summary: str(a.summary) || str(a.title) || str(a.command) || str(a.description),
      reason: str(a.reason),
      state: APPROVAL_STATE[str(a.status)] ?? 'pending',
    };
  }
  const named = ITEM_LABELS[type];
  return { kind: 'item', id: e.id, at, label: named ? named(m) : `${type || '不明な項目'}` };
}

function isPlainObject(agent: unknown): agent is Record<string, unknown> {
  if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) return false;
  const proto = Object.getPrototypeOf(agent);
  return proto === Object.prototype || proto === null;
}

function peerName(agent: unknown): string {
  if (!isPlainObject(agent)) return '他のボット';
  const { name } = agent;
  if (typeof name !== 'string') return '他のボット';
  const trimmed = name.trim();
  return trimmed === '' ? '他のボット' : trimmed;
}

function peerLine(direction: 'in' | 'out', name: string): string {
  return direction === 'in' ? `${name} から` : `${name} へ`;
}

export function normalizeEntry(e: RawEntry): Entry {
  const at = e.timestampMs ?? 0;
  switch (e.kind) {
    case 'message': {
      if (isPlainObject(e.toAgent)) {
        return { kind: 'text', id: e.id, at, author: 'bot', from: '', peer: 'out', text: peerLine('out', peerName(e.toAgent)) };
      }
      if (isPlainObject(e.fromAgent)) {
        const name = peerName(e.fromAgent);
        return { kind: 'text', id: e.id, at, author: 'other', from: name, text: peerLine('in', name) };
      }
      const files = Array.isArray(e.attachments) && e.attachments.length ? `\n［添付 ${e.attachments.length}件］` : '';
      const text = str(e.content) + files;
      if (e.role === 'assistant') return { kind: 'text', id: e.id, at, author: 'bot', from: str(e.fromAgent?.name), text };
      return { kind: 'text', id: e.id, at, author: 'me', from: '', text };
    }
    case 'send-message':
      return sendMessage(e, at);
    case 'event': {
      const ev = e.event ?? {};
      if (ev.type === 'automation-changed') {
        const verb = { created: '作成', updated: '更新', deleted: '削除' }[str(ev.action)] ?? str(ev.action);
        return { kind: 'item', id: e.id, at, label: `ルーティン${verb}: ${str(ev.automationName)}` };
      }
      return { kind: 'item', id: e.id, at, label: `イベント: ${str(ev.type)}` };
    }
    case 'voice-call':
      return { kind: 'item', id: e.id, at, label: '音声通話' };
    default:
      return { kind: 'item', id: e.id, at, label: e.kind };
  }
}

/** Latest open choice, or a pending approval while the sidebar says this bot is waiting. */
export function findPending(entries: Entry[], awaiting: boolean): Pending | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === 'text' && e.author === 'me') return null;
    if (e.kind === 'approval' && e.state === 'pending') return awaiting ? { kind: 'approval', entryId: e.id } : null;
    if (e.kind === 'question' && e.state === 'pending') return { kind: 'question', entryId: e.id };
  }
  return null;
}

export function questionChoice(entry: Entry, value: string): string | null {
  if (entry.kind !== 'question' || entry.state !== 'pending') return null;
  return entry.options.find(o => o.value === value)?.label ?? null;
}

/** First Bot-authored entry after the G2 user's last read point. */
export function firstUnread(raw: RawEntry[], lastSeenSeq: number | undefined, unreadAnchor: unknown): string | null {
  if (lastSeenSeq !== undefined) {
    const e = raw.find(r => (r.seq ?? 0) > lastSeenSeq && !(r.kind === 'message' && r.role === 'user' && !r.fromAgent));
    return e ? e.id : null;
  }
  if (typeof unreadAnchor === 'string') return unreadAnchor;
  if (unreadAnchor && typeof unreadAnchor === 'object') {
    const a = unreadAnchor as Record<string, unknown>;
    const id = a.entryId ?? a.id;
    if (typeof id === 'string') return id;
    if (typeof a.seq === 'number') return raw.find(r => (r.seq ?? 0) >= (a.seq as number))?.id ?? null;
  }
  return null;
}

export function toConversation(
  t: RawTranscript,
  bot: { name: string; awaiting: boolean },
  lastSeenSeq: number | undefined,
  canStop: boolean,
): Conversation {
  const entries = t.entries.map(normalizeEntry);
  return {
    botId: t.agentId,
    botName: bot.name,
    entries,
    firstUnreadId: firstUnread(t.entries, lastSeenSeq, t.unreadAnchor),
    running: t.running,
    hasOlder: t.hasOlder,
    pending: findPending(entries, bot.awaiting),
    canStop,
  };
}

export function maxSeq(t: RawTranscript): number {
  return t.entries.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
}
