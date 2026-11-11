// Relay between the G2 app and the Grok Bot desktop app on this Mac.
// Listens on loopback only; `tailscale serve` publishes it inside the tailnet.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { ClientMessage, Health, Notice, ServerMessage } from '../../shared/protocol.ts';
import { identityMatches } from './auth.ts';
import type { AdmitVia } from './auth.ts';
import { Recording, asrUp, transcribe } from './asr.ts';
import { handleRelayHttp, stripEvengrok } from './http.ts';
import { proxyModeFromEnv } from './proxy.ts';
import { listenRaw } from './raw.ts';
import { attachRelaySocket } from './session.ts';
import { tailscaleWhois } from './whois.ts';
import { GrokClient, GrokError } from './grok/client.ts';
import { maxSeq, normalizeEntry, questionChoice, toConversation } from './grok/normalize.ts';
import type { RawTranscript } from './grok/normalize.ts';
import { cdpUp, ensureGrok } from './supervisor.ts';
import { diffRows, emptyWatch, entryPreview, newBotEntries, notice, reflectShown, summaries } from './watch.ts';
import type { BotRow } from './watch.ts';

const PORT = Number(process.env.RELAY_PORT ?? 8791);
/** Client headers on this port are ignored. */
const RAW_PORT = Number(process.env.RELAY_RAW_PORT ?? 8793);
const PROXY_MODE = proxyModeFromEnv(process.env.RELAY_RAW_PROXY_PROTOCOL);
const OWNER_LOGIN = process.env.RELAY_OWNER_LOGIN ?? '';
const CDP_PORT = Number(process.env.GROK_CDP_PORT ?? 9447);
const ASR_URL = process.env.ASR_URL ?? 'http://127.0.0.1:8178';
const STATE = process.env.RELAY_STATE_DIR ?? new URL('../state', import.meta.url).pathname;
const TICK_MS = 1500;

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

mkdirSync(STATE, { recursive: true });
const tokenFile = join(STATE, 'token');
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('base64url'), { mode: 0o600 });
const TOKEN = readFileSync(tokenFile, 'utf8').trim();

const seenFile = join(STATE, 'seen.json');
const seen: Record<string, number> = existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, 'utf8')) : {};
const saveSeen = () => writeFileSync(seenFile, JSON.stringify(seen));

const grok = new GrokClient(CDP_PORT, join(STATE, 'fixtures'));

interface Client {
  ws: WebSocket;
  authed: boolean;
  openBot: string | null;
  pushedSig: string;
  pushedAt: number;
  /** seq of each entry in the last conversation pushed, to turn a `read` entry id into a read point. */
  seqOf: Map<string, number>;
  recordings: Map<string, Recording>;
  current: string | null;
}
const clients = new Set<Client>();

let watch = emptyWatch();
let rows: BotRow[] = [];
let health: Health = { relay: 'ok', grok: 'down', asr: 'down', detail: '起動中' };
let botsJson = '';
const currentSeq = new Map<string, number>();

function send(c: Client, msg: ServerMessage): void {
  if (c.authed && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
}
const broadcast = (msg: ServerMessage) => clients.forEach(c => send(c, msg));
const rowSig = (id: string) => {
  const r = rows.find(x => x.id === id);
  return r ? `${r.preview}|${r.working}|${r.awaiting}` : '';
};

async function pushConversation(c: Client, read?: { transcript: RawTranscript; canStop: boolean }): Promise<void> {
  const botId = c.openBot;
  if (!botId) return;
  const row = rows.find(r => r.id === botId);
  if (!row) return;
  const { transcript, canStop } = read ?? (await grok.read(botId));
  if (c.openBot !== botId) return;
  const conversation = toConversation(transcript, row, seen[botId], canStop);
  c.pushedSig = rowSig(botId);
  c.pushedAt = Date.now();
  c.seqOf = new Map(transcript.entries.map(e => [e.id, e.seq ?? 0]));
  send(c, { type: 'conversation', conversation });
}

/** Re-reading a Bot the desktop is not showing switches the desktop, so do it at most this often. */
const REFRESH_GAP_MS = 4000;

type CurrentRead = { transcript: RawTranscript | null } | { error: unknown };

async function currentBotNotices(now: number, read: CurrentRead): Promise<Notice[]> {
  const cur = rows.find(r => r.current);
  // A Bot that stops being current re-baselines when it becomes current again; its notices came from diffRows meanwhile.
  for (const id of currentSeq.keys()) if (id !== cur?.id) currentSeq.delete(id);
  if (!cur) return [];
  if ('error' in read) throw read.error;
  const t = read.transcript;
  if (!t || t.agentId !== cur.id) return [];
  const top = maxSeq(t);
  const last = currentSeq.get(cur.id);
  currentSeq.set(cur.id, top);
  if (last === undefined || top <= last) return [];
  const fresh = newBotEntries(t.entries.map(e => ({ seq: e.seq ?? 0, entry: normalizeEntry(e) })), last);
  const latest = fresh.at(-1);
  if (!latest) return [];
  const kind = cur.awaiting ? 'needs-action' : t.running ? 'message' : 'done';
  return [notice(cur, kind, entryPreview(latest), now)];
}

async function tick(): Promise<void> {
  const now = Date.now();
  try {
    rows = await grok.rows();
    if (!rows.length) {
      health = { ...health, grok: 'signed-out', detail: 'Grok Botにサインインしていません' };
    } else {
      const cur = rows.find(r => r.current);
      let read: CurrentRead = { transcript: null };
      if (cur) {
        try {
          const transcript = await grok.currentTranscript();
          read = { transcript };
          if (transcript && transcript.agentId === cur.id) {
            const entries = transcript.entries.map(normalizeEntry);
            rows = rows.map(r => (r.id === cur.id ? reflectShown(r, entries) : r));
          }
        } catch (error) {
          read = { error };
        }
      }
      const d = diffRows(watch, rows, now);
      watch = d.watch;
      health = { ...health, grok: 'ok', detail: '' };
      const json = JSON.stringify(summaries(watch));
      if (json !== botsJson) {
        botsJson = json;
        broadcast({ type: 'bots', bots: summaries(watch) });
      }
      const notices = [...d.notices, ...(await currentBotNotices(now, read).catch(e => (log(`current: ${e}`), [])))];
      for (const n of notices) {
        log(`notice ${n.kind} ${n.botName}`);
        broadcast({ type: 'notice', notice: n });
      }
      for (const c of clients) {
        if (!c.openBot || c.pushedSig === rowSig(c.openBot)) continue;
        const showing = rows.find(r => r.id === c.openBot)?.current;
        if (showing || now - c.pushedAt >= REFRESH_GAP_MS) await pushConversation(c).catch(e => log(`refresh: ${e}`));
      }
    }
  } catch (e) {
    health = { ...health, grok: 'down', detail: e instanceof GrokError ? e.message : `Grok Botに接続できません（${(e as Error).message}）` };
    if (!(await cdpUp(CDP_PORT))) await ensureGrok(CDP_PORT, log).catch(err => log(`ensureGrok: ${err}`));
  }
}

let healthJson = '';
function publishHealth(): void {
  const json = JSON.stringify(health);
  if (json === healthJson) return;
  healthJson = json;
  log(`health ${json}`);
  broadcast({ type: 'health', health });
}

async function healthTick(): Promise<void> {
  health = { ...health, asr: (await asrUp(ASR_URL)) ? 'ok' : 'down' };
  publishHealth();
}

async function handle(c: Client, m: ClientMessage): Promise<void> {
  const result = async (reqId: string, op: () => Promise<string>) => {
    try {
      send(c, { type: 'result', reqId, ok: true, message: await op() });
    } catch (e) {
      const message = e instanceof GrokError ? e.message : `失敗しました: ${(e as Error).message}`;
      send(c, { type: 'result', reqId, ok: false, message });
    }
    await pushConversation(c).catch(() => undefined);
  };
  switch (m.type) {
    case 'hello':
      return;
    case 'open':
      c.openBot = m.botId;
      return pushConversation(c);
    case 'close':
      c.openBot = null;
      return;
    case 'read': {
      const seq = c.seqOf.get(m.entryId);
      if (seq !== undefined && seq > (seen[m.botId] ?? -1)) {
        seen[m.botId] = seq;
        saveSeen();
      }
      return;
    }
    case 'older': {
      const loaded = await grok.loadOlder(m.botId);
      if (loaded) return pushConversation(c, loaded);
      send(c, { type: 'result', reqId: 'older', ok: false, message: 'これより前の会話はありません' });
      return;
    }
    case 'send':
      return result(m.reqId, () => grok.send(m.botId, m.text));
    case 'answer':
      return result(m.reqId, async () => {
        const t = await grok.read(m.botId);
        const raw = t.transcript.entries.find(e => e.id === m.entryId);
        const e = raw && normalizeEntry(raw);
        const label = e ? questionChoice(e, m.value) : null;
        if (!label) throw new GrokError('この質問はもう回答済みです');
        return grok.answer(m.botId, m.entryId, label);
      });
    case 'approve':
      return result(m.reqId, () => grok.approve(m.botId, m.entryId, m.choice));
    case 'stop':
      return result(m.reqId, () => grok.stop(m.botId));
    case 'audio-begin':
      c.current = m.reqId;
      c.recordings.set(m.reqId, new Recording());
      return;
    case 'audio-cancel':
      c.recordings.delete(m.reqId);
      if (c.current === m.reqId) c.current = null;
      return;
    case 'audio-end': {
      const rec = c.recordings.get(m.reqId);
      c.recordings.delete(m.reqId);
      if (c.current === m.reqId) c.current = null;
      if (!rec) return;
      try {
        const t0 = Date.now();
        const text = await transcribe(ASR_URL, rec.pcm());
        log(`asr ${rec.seconds.toFixed(1)}s audio in ${Date.now() - t0}ms`);
        send(c, { type: 'transcript', reqId: m.reqId, text });
      } catch (e) {
        send(c, { type: 'result', reqId: m.reqId, ok: false, message: (e as Error).message });
        send(c, { type: 'transcript', reqId: m.reqId, text: '' });
      }
      return;
    }
  }
}

function authorized(token: string): boolean {
  const a = Buffer.from(token);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const APP_DIR = resolve(new URL('../../g2/dist', import.meta.url).pathname);
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

function serveApp(path: string, res: import('node:http').ServerResponse): void {
  let rel: string;
  try {
    rel = decodeURIComponent(path.slice('/app/'.length)) || 'index.html';
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }
  const file = resolve(APP_DIR, rel);
  if (!file.startsWith(APP_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(readFileSync(file));
}

const server = createServer((req, res) => {
  try {
    handleHttp(req, res);
  } catch (e) {
    log(`http: ${e}`);
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  }
});

function handleHttp(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  handleRelayHttp(req, res, {
    log,
    serveApp,
    health: () => ({ ok: health.grok === 'ok' }),
  });
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
const onUpgrade = (trustIdentity: boolean) => (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
  if (stripEvengrok(req.url) !== '/ws') return socket.destroy();
  // tailscale serve (HTTPS proxy on PORT) sets this header from the peer's WireGuard identity and strips any client copy.
  const owner = trustIdentity && identityMatches(req.headers['tailscale-user-login'], OWNER_LOGIN);
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, owner, 'header' satisfies AdmitVia));
};
server.on('upgrade', onUpgrade(true));
const alive = new WeakSet<WebSocket>();
setInterval(() => {
  for (const c of clients) {
    if (!alive.has(c.ws)) {
      c.ws.terminate();
      continue;
    }
    alive.delete(c.ws);
    c.ws.ping();
  }
}, 20000);
wss.on('connection', (ws: WebSocket, owner: boolean, via: AdmitVia) => {
  const c: Client = { ws, authed: false, openBot: null, pushedSig: '', pushedAt: 0, seqOf: new Map(), recordings: new Map(), current: null };
  clients.add(c);
  alive.add(ws);
  ws.on('pong', () => alive.add(ws));
  attachRelaySocket(ws, { owner, via }, {
    authorized,
    log,
    welcome: () => ({ type: 'welcome', bots: summaries(watch), health }),
    onAuthed() {
      c.authed = true;
    },
    onMessage(_ws, message) {
      handle(c, message).catch(e => log(`handle ${message.type}: ${e}`));
    },
    onBinary(_ws, data) {
      if (c.authed && c.current) c.recordings.get(c.current)?.push(new Uint8Array(data));
    },
    onClose(_ws, wasAuthed) {
      if (wasAuthed) log('client disconnected');
      clients.delete(c);
    },
  });
});

process.on('uncaughtException', e => log(`uncaught: ${e.stack ?? e}`));
process.on('unhandledRejection', e => log(`unhandled: ${e}`));

server.listen(PORT, '127.0.0.1', () => log(`relay listening on 127.0.0.1:${PORT}`));
const socketEnv = process.env.TAILSCALE_SOCKET;
void listenRaw({
  port: RAW_PORT,
  mode: PROXY_MODE,
  whois: tailscaleWhois({
    bin: process.env.TAILSCALE_BIN || 'tailscale',
    socket: socketEnv ? socketEnv : undefined,
  }),
  ownerLogin: OWNER_LOGIN,
  log,
  onRequest(req, res) {
    try {
      handleHttp(req, res);
    } catch (e) {
      log(`http: ${e}`);
      res.end();
    }
  },
  onUpgrade(req, socket, head, owner) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, owner, 'proxy' satisfies AdmitVia));
  },
}).then(raw => {
  const label = PROXY_MODE.kind === 'require' ? `proxy protocol ${PROXY_MODE.version}` : 'token only';
  log(`relay (${label}) listening on 127.0.0.1:${raw.port}`);
}).catch(err => log(`raw: ${err}`));

let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  await tick().finally(() => {
    ticking = false;
    publishHealth();
  });
}, TICK_MS);
setInterval(healthTick, 5000);
healthTick();
