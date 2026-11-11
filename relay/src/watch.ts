// Sidebar snapshot diff -> Bot summaries and notices. Pure.
//
// A Bot the desktop is not showing gets a notice when its latest entry
// changes and the app marks it unread or waiting on the user. A message the
// user sent from the phone changes the preview but does not mark the Bot
// unread, so it does not notify. The Bot the desktop is showing never turns
// unread; the relay reads its transcript instead (see newBotEntries).

import { peerText, type BotStatus, type BotSummary, type Entry, type Notice, type NoticeKind } from '../../shared/protocol.ts';
import { findPending } from './grok/normalize.ts';

export interface BotRow {
  id: string;
  name: string;
  preview: string;
  awaiting: boolean;
  working: boolean;
  unread: boolean;
  current: boolean;
}

export interface Watch {
  rows: Map<string, BotRow>;
  activity: Map<string, number>;
}

export const emptyWatch = (): Watch => ({ rows: new Map(), activity: new Map() });

const statusOf = (r: BotRow): BotStatus =>
  r.awaiting ? 'needs-action' : r.working ? 'working' : r.unread ? 'unread' : 'idle';

export function summaries(w: Watch): BotSummary[] {
  return [...w.rows.values()].map(r => ({
    id: r.id,
    name: r.name,
    status: statusOf(r),
    preview: r.preview,
    activityAt: w.activity.get(r.id) ?? 0,
  }));
}

export function diffRows(w: Watch, next: BotRow[], now: number): { watch: Watch; notices: Notice[] } {
  const first = w.rows.size === 0;
  const rows = new Map<string, BotRow>();
  const activity = new Map(w.activity);
  const notices: Notice[] = [];
  next.forEach((r, i) => {
    rows.set(r.id, r);
    const p = w.rows.get(r.id);
    if (!p) {
      if (!activity.has(r.id)) activity.set(r.id, first ? next.length - i : now);
      return;
    }
    const changed = r.preview !== p.preview;
    if (changed) activity.set(r.id, now);
    if (r.current) return;
    const becameAwaiting = r.awaiting && !p.awaiting;
    const finished = p.working && !r.working;
    let kind: NoticeKind | null = null;
    if (becameAwaiting) kind = 'needs-action';
    else if (changed && (r.unread || r.awaiting)) kind = finished ? 'done' : 'message';
    else if (finished && r.unread) kind = 'done';
    if (kind) notices.push(notice(r, kind, r.preview, now));
  });
  return { watch: { rows, activity }, notices };
}

export function notice(r: Pick<BotRow, 'id' | 'name'>, kind: NoticeKind, text: string, now: number): Notice {
  return { id: `${r.id}:${now}`, botId: r.id, botName: r.name, kind, text, at: now };
}

/** Bot-authored entries that appeared after `lastSeq`, for the Bot the desktop is showing. */
export function newBotEntries(entries: { seq: number; entry: Entry }[], lastSeq: number): Entry[] {
  return entries
    .filter(e => e.seq > lastSeq)
    .map(e => e.entry)
    .filter(e => (e.kind === 'text' ? e.author === 'bot' : e.kind !== 'item'));
}

export function entryPreview(e: Entry): string {
  switch (e.kind) {
    case 'text':
      return e.text;
    case 'question':
      return e.prompt;
    case 'approval':
      return `承認が必要: ${e.summary}`;
    case 'item':
      return e.label;
  }
}

export function shownPreview(sidebar: string, latest: Entry | undefined): string {
  if (!latest) return sidebar;
  return peerText(latest) ?? sidebar;
}

// Sidebar data-awaiting is a browser-tab handoff, so an open choice is read from the transcript.
export function reflectShown(row: BotRow, entries: Entry[]): BotRow {
  const choice = findPending(entries, false)?.kind === 'question';
  return {
    ...row,
    preview: shownPreview(row.preview, entries.at(-1)),
    awaiting: row.awaiting || choice,
  };
}
