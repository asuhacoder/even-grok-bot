import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTailnetIp, proxyModeFromEnv, readProxyHeader } from './proxy.ts';

const sig = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);

function dot(a: number, b: number, c: number, d: number): string {
  return [a, b, c, d].join('.');
}

function v1(src: string): Buffer {
  return Buffer.from(`PROXY TCP4 ${src} 127.0.0.1 50000 8792\r\n`);
}

function v2(octets: readonly [number, number, number, number], extra = 0): Buffer {
  const addr = Buffer.alloc(12 + extra);
  addr.writeUInt8(octets[0], 0);
  addr.writeUInt8(octets[1], 1);
  addr.writeUInt8(octets[2], 2);
  addr.writeUInt8(octets[3], 3);
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

test('proxy mode accepts only 1, 2, and off', () => {
  assert.deepEqual(proxyModeFromEnv(undefined), { kind: 'off' });
  assert.deepEqual(proxyModeFromEnv(''), { kind: 'off' });
  assert.deepEqual(proxyModeFromEnv('off'), { kind: 'off' });
  assert.deepEqual(proxyModeFromEnv('1'), { kind: 'require', version: 1 });
  assert.deepEqual(proxyModeFromEnv(' 2\n'), { kind: 'require', version: 2 });
  assert.throws(() => proxyModeFromEnv('nope'), /RELAY_RAW_PROXY_PROTOCOL/);
});

test('version 1 and version 2 headers yield the source address', () => {
  const src = dot(203, 0, 113, 10);
  const v1read = readProxyHeader(v1(src), 1);
  assert.equal(v1read.kind, 'ready');
  if (v1read.kind === 'ready') assert.equal(v1read.source, src);
  const bytes = v2([203, 0, 113, 10], 4);
  const v2read = readProxyHeader(bytes, 2);
  assert.equal(v2read.kind, 'ready');
  if (v2read.kind === 'ready') {
    assert.equal(v2read.source, src);
    assert.equal(v2read.consumed, bytes.length);
  }
});

test('a short prefix waits, and the other version is refused', () => {
  const src = dot(203, 0, 113, 10);
  assert.equal(readProxyHeader(Buffer.from('PROXY'), 1).kind, 'need');
  assert.equal(readProxyHeader(sig.subarray(0, 4), 2).kind, 'need');
  assert.equal(readProxyHeader(v1(src), 2).kind, 'refuse');
  assert.equal(readProxyHeader(v2([203, 0, 113, 10]), 1).kind, 'refuse');
  assert.equal(readProxyHeader(Buffer.from('GET /diag HTTP/1.1\r\n\r\n'), 2).kind, 'refuse');
});

test('LOCAL and UNKNOWN carry no address, and a mapped IPv6 address becomes IPv4', () => {
  const local = Buffer.alloc(16);
  sig.copy(local);
  local.writeUInt8(0x20, 12);
  local.writeUInt8(0x11, 13);
  local.writeUInt16BE(0, 14);
  const localRead = readProxyHeader(local, 2);
  assert.deepEqual(localRead, { kind: 'ready', source: null, consumed: 16 });
  const unknown = readProxyHeader(Buffer.from('PROXY UNKNOWN\r\n'), 1);
  assert.deepEqual(unknown, { kind: 'ready', source: null, consumed: Buffer.from('PROXY UNKNOWN\r\n').length });

  const addr = Buffer.alloc(36);
  addr.writeUInt8(0xff, 10);
  addr.writeUInt8(0xff, 11);
  addr.writeUInt8(203, 12);
  addr.writeUInt8(0, 13);
  addr.writeUInt8(113, 14);
  addr.writeUInt8(10, 15);
  const head = Buffer.alloc(16);
  sig.copy(head);
  head.writeUInt8(0x21, 12);
  head.writeUInt8(0x21, 13);
  head.writeUInt16BE(addr.length, 14);
  const mapped = readProxyHeader(Buffer.concat([head, addr]), 2);
  assert.equal(mapped.kind, 'ready');
  if (mapped.kind === 'ready') {
    assert.equal(mapped.source, dot(203, 0, 113, 10));
    assert.equal(mapped.source !== null && isTailnetIp(mapped.source), true);
  }
});
