// Wire contract between the Mac relay and the G2 app. JSON over one WebSocket;
// microphone PCM travels as binary frames between audio-begin and audio-end.

export type BotStatus = 'needs-action' | 'working' | 'unread' | 'idle';

export interface BotSummary {
  id: string;
  name: string;
  status: BotStatus;
  preview: string;
  /** Order key: the relay's observation time of the latest preview change. */
  activityAt: number;
}

export type Author = 'me' | 'bot' | 'other';

export type Entry =
  | { kind: 'text'; id: string; at: number; author: 'me'; from: ''; text: string }
  | { kind: 'text'; id: string; at: number; author: 'bot'; from: string; text: string }
  | { kind: 'text'; id: string; at: number; author: 'other'; from: string; text: string }
  | { kind: 'text'; id: string; at: number; author: 'bot'; from: ''; peer: 'out'; text: string }
  | {
      kind: 'question';
      id: string;
      at: number;
      prompt: string;
      options: { label: string; value: string }[];
      state: 'pending' | 'answered' | 'skipped';
    }
  | {
      kind: 'approval';
      id: string;
      at: number;
      summary: string;
      reason: string;
      state: 'pending' | 'approved' | 'denied' | 'expired';
    }
  /** Files, tool runs, forms, credential requests, routines, calls: shown as presence only. */
  | { kind: 'item'; id: string; at: number; label: string };

export function peerText(e: Entry): string | undefined {
  if (e.kind !== 'text') return;
  if (e.author === 'other' || (e.author === 'bot' && 'peer' in e)) return e.text;
  return;
}

export type Pending =
  | { kind: 'question'; entryId: string }
  | { kind: 'approval'; entryId: string };

export interface Conversation {
  botId: string;
  botName: string;
  entries: Entry[];
  firstUnreadId: string | null;
  running: boolean;
  hasOlder: boolean;
  pending: Pending | null;
  /** True when the desktop app offers a stop control right now. */
  canStop: boolean;
}

export type NoticeKind = 'needs-action' | 'done' | 'message';

export interface Notice {
  id: string;
  botId: string;
  botName: string;
  kind: NoticeKind;
  text: string;
  at: number;
}

export type HealthPart = 'ok' | 'down';

export interface Health {
  relay: HealthPart;
  grok: HealthPart | 'signed-out';
  asr: HealthPart;
  detail: string;
}

export type ApprovalChoice = 'once' | 'always' | 'deny';

export type ClientMessage =
  | { type: 'hello'; token: string }
  | { type: 'open'; botId: string }
  | { type: 'close' }
  | { type: 'older'; botId: string }
  /** The G2 user has seen the conversation up to and including this entry. */
  | { type: 'read'; botId: string; entryId: string }
  | { type: 'send'; reqId: string; botId: string; text: string }
  | { type: 'answer'; reqId: string; botId: string; entryId: string; value: string }
  | { type: 'approve'; reqId: string; botId: string; entryId: string; choice: ApprovalChoice }
  | { type: 'stop'; reqId: string; botId: string }
  | { type: 'audio-begin'; reqId: string }
  | { type: 'audio-end'; reqId: string }
  | { type: 'audio-cancel'; reqId: string };

export type ServerMessage =
  | { type: 'welcome'; bots: BotSummary[]; health: Health }
  | { type: 'bots'; bots: BotSummary[] }
  | { type: 'notice'; notice: Notice }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'transcript'; reqId: string; text: string }
  | { type: 'result'; reqId: string; ok: boolean; message: string }
  | { type: 'health'; health: Health }
  | { type: 'denied'; reason: string };

export function parseClientMessage(raw: string): ClientMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const m = v as Record<string, unknown>;
  const str = (k: string) => typeof m[k] === 'string' && (m[k] as string).length <= 8000;
  switch (m.type) {
    case 'hello':
      return str('token') ? (m as unknown as ClientMessage) : null;
    case 'open':
    case 'older':
      return str('botId') ? (m as unknown as ClientMessage) : null;
    case 'read':
      return str('botId') && str('entryId') ? (m as unknown as ClientMessage) : null;
    case 'close':
      return { type: 'close' };
    case 'send':
      return str('reqId') && str('botId') && str('text') ? (m as unknown as ClientMessage) : null;
    case 'answer':
      return str('reqId') && str('botId') && str('entryId') && str('value') ? (m as unknown as ClientMessage) : null;
    case 'approve':
      return str('reqId') && str('botId') && str('entryId') && ['once', 'always', 'deny'].includes(m.choice as string)
        ? (m as unknown as ClientMessage)
        : null;
    case 'stop':
      return str('reqId') && str('botId') ? (m as unknown as ClientMessage) : null;
    case 'audio-begin':
    case 'audio-end':
    case 'audio-cancel':
      return str('reqId') ? (m as unknown as ClientMessage) : null;
    default:
      return null;
  }
}
