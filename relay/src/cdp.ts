// Minimal Chrome DevTools Protocol client for the Grok Bot renderer.

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export class CdpError extends Error {}

export class Cdp {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(params: any) => void>>();
  readonly closed: Promise<void>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new CdpError(m.error.message));
        else p.resolve(m.result);
      } else if (m.method) {
        for (const l of this.listeners.get(m.method) ?? []) l(m.params);
      }
    };
    this.closed = new Promise(resolve => {
      ws.onclose = () => {
        for (const p of this.pending.values()) p.reject(new CdpError('CDP connection closed'));
        this.pending.clear();
        resolve();
      };
    });
  }

  static async connect(port: number): Promise<Cdp> {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    const targets = (await res.json()) as Target[];
    const page = targets.find(t => t.type === 'page' && t.url.includes('/dist/renderer/index.html'));
    if (!page) throw new CdpError('Grok Bot renderer target not found');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new CdpError('CDP websocket failed'));
    });
    return new Cdp(ws);
  }

  send<T = any>(method: string, params: object = {}, timeoutMs = 10000): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: v => (clearTimeout(timer), resolve(v)),
        reject: e => (clearTimeout(timer), reject(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, fn: (params: any) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(fn);
    this.listeners.set(method, set);
    return () => set.delete(fn);
  }

  async evaluate<T>(expression: string, timeoutMs = 10000): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new CdpError(d.exception?.description ?? d.text ?? 'evaluate failed');
    }
    return r.result.value as T;
  }

  close(): void {
    this.ws.close();
  }
}
