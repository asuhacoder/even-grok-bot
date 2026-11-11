// One WebSocket to the relay. Tries each candidate URL in turn (a host may block
// some schemes, e.g. ws:// from a secure page), sticks with the first that works,
// and reconnects with backoff. Every attempt is reported through `onAttempt`.

import type { ClientMessage, ServerMessage } from '../../shared/protocol.ts';

export interface LinkEvents {
  onMessage: (m: ServerMessage) => void;
  onUp: (up: boolean) => void;
  onAttempt: (a: { url: string; result: 'open' | 'welcome' | 'closed' | 'timeout' | 'throw'; detail: string }) => void;
}

const CONNECT_TIMEOUT_MS = 8000;

export class Link {
  private ws: WebSocket | null = null;
  private retry = 0;
  private index = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private urls: string[];
  private token: string;
  private readonly ev: LinkEvents;

  constructor(urls: string[], token: string, ev: LinkEvents) {
    this.urls = urls;
    this.token = token;
    this.ev = ev;
  }

  get url(): string {
    return this.urls[this.index % Math.max(1, this.urls.length)] ?? '';
  }

  start(): void {
    this.stopped = false;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const url = this.url;
    if (!url) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.ev.onAttempt({ url, result: 'throw', detail: String(e) });
      return this.fail();
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let opened = false;
    let welcomed = false;
    const connectTimer = setTimeout(() => {
      if (opened || this.ws !== ws) return;
      this.ev.onAttempt({ url, result: 'timeout', detail: `${CONNECT_TIMEOUT_MS}ms` });
      // WebKit may never fire onclose for a socket closed while connecting; move on ourselves.
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.close();
      this.fail();
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      opened = true;
      clearTimeout(connectTimer);
      this.ev.onAttempt({ url, result: 'open', detail: '' });
      ws.send(JSON.stringify({ type: 'hello', token: this.token } satisfies ClientMessage));
    };
    ws.onmessage = e => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data) as ServerMessage;
      if (m.type === 'welcome' && !welcomed) {
        welcomed = true;
        this.retry = 0;
        this.ev.onAttempt({ url, result: 'welcome', detail: '' });
        this.ev.onUp(true);
      }
      this.ev.onMessage(m);
    };
    ws.onclose = e => {
      clearTimeout(connectTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      this.ev.onAttempt({ url, result: 'closed', detail: `code=${e.code} reason=${e.reason} opened=${opened} welcomed=${welcomed}` });
      if (opened) this.ev.onUp(false);
      // A URL that never opened is probably blocked here; try the next one.
      // Denied (4401) means this route needs a token we lack; another route may authenticate by tailnet identity.
      if (!opened || e.code === 4401) return this.fail();
      this.schedule();
    };
  }

  private fail(): void {
    this.ws = null;
    this.index = (this.index + 1) % Math.max(1, this.urls.length);
    // Walk all candidates quickly; back off only after a full round failed.
    if (this.index !== 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.stopped) this.start();
      }, 200);
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    const delay = Math.min(15000, 1000 * 2 ** this.retry++);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, delay);
  }

  reconfigure(urls: string[], token: string): void {
    this.urls = urls;
    this.token = token;
    this.index = 0;
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.retry = 0;
    this.start();
  }

  send(m: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  sendBinary(chunk: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(chunk);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const old = this.ws;
    this.ws = null;
    old?.close();
  }
}
