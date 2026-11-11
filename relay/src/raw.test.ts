import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { handleRelayHttp } from './http.ts';
import { listenRaw } from './raw.ts';
import { attachRelaySocket } from './session.ts';
import type { Whois } from './whois.ts';

const ownerLogin = 'you@example.com';
const sig = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);

function dot(a: number, b: number, c: number, d: number): string {
  return [a, b, c, d].join('.');
}

const ownerIp = dot(203, 0, 113, 10);
const otherIp = dot(203, 0, 113, 11);
const missIp = dot(203, 0, 113, 12);
const diagIp = dot(203, 0, 113, 13);

function v2(src: string, extra = 0): Buffer {
  const octets = src.split('.').map(part => Number(part));
  const addr = Buffer.alloc(12 + extra);
  for (let i = 0; i < 4; i += 1) addr.writeUInt8(octets[i] ?? 0, i);
  addr.writeUInt8(127, 4);
  addr.writeUInt16BE(50000, 8);
  addr.writeUInt16BE(8792, 10);
  const head = Buffer.alloc(16);
  sig.copy(head);
  head.writeUInt8(0x21, 12);
  head.writeUInt8(0x11, 13);
  head.writeUInt16BE(addr.length, 14);
  return Buffer.concat([head, addr]);
}

function v1(src: string): Buffer {
  return Buffer.from(`PROXY TCP4 ${src} 127.0.0.1 50000 8792\r\n`);
}

function clientFrame(text: string): Buffer {
  const data = Buffer.from(text);
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const header = Buffer.alloc(6);
  header.writeUInt8(0x81, 0);
  header.writeUInt8(0x80 | data.length, 1);
  mask.copy(header, 2);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) masked.writeUInt8(data.readUInt8(i) ^ mask.readUInt8(i % 4), i);
  return Buffer.concat([header, masked]);
}

function framesOf(buf: Buffer): string[] {
  const split = buf.indexOf('\r\n\r\n');
  if (split < 0) return [];
  let rest = buf.subarray(split + 4);
  const out: string[] = [];
  while (rest.length >= 2) {
    const len = rest.readUInt8(1) & 0x7f;
    if (rest.length < 2 + len) break;
    if ((rest.readUInt8(0) & 0x0f) === 0x1) out.push(rest.subarray(2, 2 + len).toString('utf8'));
    rest = rest.subarray(2 + len);
  }
  return out;
}

function exchange(port: number, payload: Buffer): Promise<{ status: string; frames: string[]; bytes: number }> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      const buf = Buffer.concat(chunks);
      const lineEnd = buf.indexOf('\r\n');
      resolve({
        status: lineEnd >= 0 ? buf.subarray(0, lineEnd).toString('ascii') : '',
        frames: framesOf(buf),
        bytes: buf.length,
      });
    };
    const timer = setTimeout(finish, 1000);
    socket.on('data', chunk => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (framesOf(buf).length > 0) finish();
    });
    socket.on('close', finish);
    socket.on('error', finish);
    socket.on('connect', () => socket.write(payload));
  });
}

function upgrade(token: string, headerLogin?: string): Buffer {
  const extra = headerLogin ? `Tailscale-User-Login: ${headerLogin}\r\n` : '';
  const req = `GET /ws HTTP/1.1\r\nHost: relay.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${extra}Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`;
  return Buffer.concat([Buffer.from(req), clientFrame(JSON.stringify({ type: 'hello', token }))]);
}

async function start(version: 1 | 2, seen: string[]) {
  const logs: string[] = [];
  const whois: Whois = {
    async loginFor(ip) {
      seen.push(ip);
      if (ip === otherIp) return { kind: 'login', login: 'guest@example.com' };
      if (ip === missIp) return { kind: 'miss' };
      return { kind: 'login', login: ownerLogin };
    },
  };
  const wss = new WebSocketServer({ noServer: true });
  const raw = await listenRaw({
    port: 0,
    mode: { kind: 'require', version },
    whois,
    ownerLogin,
    log: line => logs.push(line),
    onRequest(req, res) {
      handleRelayHttp(req, res, {
        log() {},
        serveApp(_path, response) {
          response.statusCode = 404;
          response.end();
        },
        health: () => ({ ok: false }),
      });
    },
    onUpgrade(req, socket, head, owner) {
      wss.handleUpgrade(req, socket, head, ws => {
        attachRelaySocket(ws, { owner, via: 'proxy' }, {
          authorized: token => token === 'secret-token',
          log: line => logs.push(line),
          welcome: () => ({ type: 'welcome', bots: [], health: { relay: 'ok', grok: 'down', asr: 'down', detail: '' } }),
          onAuthed() {},
          onMessage() {},
          onBinary() {},
          onClose() {},
        });
      });
    },
  });
  return {
    port: raw.port,
    logs,
    stop: async () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await raw.close();
    },
  };
}

test('an owner login welcomes without a token, and a different login is denied', async () => {
  const seen: string[] = [];
  const relay = await start(2, seen);
  try {
    const ok = await exchange(relay.port, Buffer.concat([v2(ownerIp), upgrade('')]));
    assert.equal(ok.frames.length, 1);
    assert.equal(JSON.parse(ok.frames[0] ?? '{}').type, 'welcome');
    assert.ok(relay.logs.includes('client connected (tailnet identity via proxy)'));
    assert.deepEqual(seen, [ownerIp]);

    const denied = await exchange(relay.port, Buffer.concat([v2(otherIp), upgrade('', ownerLogin)]));
    const body = JSON.parse(denied.frames[0] ?? '{}') as { type?: string; reason?: string };
    assert.equal(body.type, 'denied');
    assert.equal(body.reason, 'トークンが違います');
    assert.equal(relay.logs.includes('client connected (tailnet identity via proxy)'), true);
    assert.equal(relay.logs.filter(line => line.startsWith('client connected')).length, 1);
  } finally {
    await relay.stop();
  }
});

test('a whois miss stays on the token path and the next lookup can still welcome', async () => {
  const seen: string[] = [];
  const relay = await start(2, seen);
  try {
    const denied = await exchange(relay.port, Buffer.concat([v2(missIp), upgrade('')]));
    assert.equal(JSON.parse(denied.frames[0] ?? '{}').type, 'denied');
    assert.ok(relay.logs.includes('whois miss'));
    const withToken = await exchange(relay.port, Buffer.concat([v2(missIp), upgrade('secret-token')]));
    assert.equal(JSON.parse(withToken.frames[0] ?? '{}').type, 'welcome');
    assert.ok(relay.logs.includes('client connected (token)'));
    assert.equal(seen.filter(ip => ip === missIp).length, 2);
  } finally {
    await relay.stop();
  }
});

test('version 1 admits the owner the same way', async () => {
  const seen: string[] = [];
  const relay = await start(1, seen);
  try {
    const ok = await exchange(relay.port, Buffer.concat([v1(ownerIp), upgrade('')]));
    assert.equal(JSON.parse(ok.frames[0] ?? '{}').type, 'welcome');
    assert.deepEqual(seen, [ownerIp]);
  } finally {
    await relay.stop();
  }
});

test('a missing header is refused and /diag still answers 204 after a valid header', async () => {
  const seen: string[] = [];
  const relay = await start(2, seen);
  try {
    const bare = await exchange(relay.port, Buffer.from('GET /diag HTTP/1.1\r\nHost: relay.example\r\nConnection: close\r\n\r\n'));
    assert.equal(bare.bytes, 0);
    assert.equal(seen.length, 0);

    const diag = await exchange(relay.port, Buffer.concat([
      v2(diagIp, 4),
      Buffer.from('GET /diag HTTP/1.1\r\nHost: relay.example\r\nConnection: close\r\n\r\n'),
    ]));
    assert.match(diag.status, /^HTTP\/1\.1 204/);
    assert.equal(seen.includes(diagIp), false);

    const split = await new Promise<string>(resolve => {
      const socket = connect(relay.port, '127.0.0.1');
      const header = v2(diagIp);
      const req = Buffer.from('GET /diag HTTP/1.1\r\nHost: relay.example\r\nConnection: close\r\n\r\n');
      let buf = Buffer.alloc(0);
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.includes('\r\n\r\n')) {
          socket.end();
          resolve(buf.subarray(0, buf.indexOf('\r\n')).toString('ascii'));
        }
      });
      socket.on('connect', () => {
        socket.write(header.subarray(0, 4));
        setTimeout(() => socket.write(Buffer.concat([header.subarray(4), req])), 30);
      });
    });
    assert.match(split, /^HTTP\/1\.1 204/);
  } finally {
    await relay.stop();
  }
});

test('mode off accepts a bare /diag and does not call whois', async () => {
  const seen: string[] = [];
  const raw = await listenRaw({
    port: 0,
    mode: { kind: 'off' },
    whois: { async loginFor(ip) { seen.push(ip); return { kind: 'miss' }; } },
    ownerLogin,
    log() {},
    onRequest(req, res) {
      handleRelayHttp(req, res, { log() {}, serveApp() {}, health: () => ({ ok: false }) });
    },
    onUpgrade(req, socket) {
      socket.destroy();
    },
  });
  try {
    const diag = await exchange(raw.port, Buffer.from('GET /diag HTTP/1.1\r\nHost: relay.example\r\nConnection: close\r\n\r\n'));
    assert.match(diag.status, /^HTTP\/1\.1 204/);
    assert.deepEqual(seen, []);
  } finally {
    await raw.close();
  }
});
