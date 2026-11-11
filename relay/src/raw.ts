import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { identityMatches } from './auth.ts';
import { readProxyHeader } from './proxy.ts';
import type { ProxyMode, TailnetIp } from './proxy.ts';
import { stripEvengrok } from './http.ts';
import type { Whois } from './whois.ts';

const HOST = '127.0.0.1';
const HEADER_DEADLINE_MS = 1000;

export interface RawListen {
  readonly port: number;
  close(): Promise<void>;
}

export interface RawDeps {
  readonly port: number;
  readonly mode: ProxyMode;
  readonly whois: Whois;
  readonly ownerLogin: string;
  log(line: string): void;
  onRequest(req: IncomingMessage, res: ServerResponse): void;
  /** Do not read Tailscale-User-Login. */
  onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, owner: boolean): void;
}

// The header is trusted because this bind is loopback and tailscaled is the writer.
export async function listenRaw(deps: RawDeps): Promise<RawListen> {
  if (deps.mode.kind === 'off') {
    const httpServer = createHttpServer((req, res) => deps.onRequest(req, res));
    httpServer.on('upgrade', (req, socket, head) => deps.onUpgrade(req, socket, head, false));
    await listen(httpServer, deps.port);
    return { port: portOf(httpServer), close: () => closeServer(httpServer) };
  }
  const version = deps.mode.version;
  const sources = new WeakMap<Duplex, TailnetIp | null>();
  const httpServer = createHttpServer((req, res) => deps.onRequest(req, res));
  httpServer.on('upgrade', (req, socket, head) => {
    if (stripEvengrok(req.url) !== '/ws') {
      socket.destroy();
      return;
    }
    socket.pause();
    const source = sources.get(socket) ?? null;
    void settleOwner(deps, source).then(owner => {
      // The hello frame may already sit in `head`. Resume so the WebSocket reader can take it.
      socket.resume();
      deps.onUpgrade(req, socket, head, owner);
    });
  });
  const netServer = createNetServer(socket => {
    peel(socket, version, source => {
      sources.set(socket, source);
      httpServer.emit('connection', socket);
    }, () => {
      deps.log('proxy header refused');
    });
  });
  await listen(netServer, deps.port);
  return {
    port: portOf(netServer),
    close: async () => {
      await closeServer(netServer);
      await closeServer(httpServer);
    },
  };
}

async function settleOwner(deps: RawDeps, source: TailnetIp | null): Promise<boolean> {
  if (!source) return false;
  try {
    const answer = await deps.whois.loginFor(source);
    if (answer.kind !== 'login') {
      deps.log('whois miss');
      return false;
    }
    return identityMatches(answer.login, deps.ownerLogin);
  } catch {
    deps.log('whois miss');
    return false;
  }
}

function peel(socket: Socket, version: 1 | 2, onReady: (source: TailnetIp | null) => void, onRefuse: () => void): void {
  let buf = Buffer.alloc(0);
  let settled = false;
  const stop = () => {
    settled = true;
    clearTimeout(deadline);
    socket.off('data', onData);
    socket.off('error', fail);
    socket.off('end', fail);
  };
  const fail = () => {
    if (settled) return;
    stop();
    onRefuse();
    socket.destroy();
  };
  const deadline = setTimeout(fail, HEADER_DEADLINE_MS);
  const onData = (chunk: Buffer) => {
    if (settled) return;
    buf = Buffer.concat([buf, chunk]);
    const read = readProxyHeader(buf, version);
    if (read.kind === 'need') return;
    if (read.kind === 'refuse') return fail();
    stop();
    const rest = buf.subarray(read.consumed);
    if (rest.length > 0) socket.unshift(rest);
    onReady(read.source);
  };
  socket.on('data', onData);
  socket.on('error', fail);
  socket.on('end', fail);
}

function listen(server: NetServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function portOf(server: NetServer): number {
  const address = server.address();
  return address && typeof address === 'object' ? address.port : 0;
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}
