import { isIP } from 'node:net';

export type TailnetIp = string & { readonly __brand: 'TailnetIp' };

export function isTailnetIp(value: string): value is TailnetIp {
  return isIP(value) !== 0;
}

export type ProxyMode = { readonly kind: 'off' } | { readonly kind: 'require'; readonly version: 1 | 2 };

export function proxyModeFromEnv(raw: string | undefined): ProxyMode {
  const text = (raw ?? '').trim();
  if (text === '' || text === 'off') return { kind: 'off' };
  if (text === '1') return { kind: 'require', version: 1 };
  if (text === '2') return { kind: 'require', version: 2 };
  throw new Error('RELAY_RAW_PROXY_PROTOCOL must be 1, 2, or off');
}

export type HeaderRead =
  | { readonly kind: 'need' }
  | { readonly kind: 'ready'; readonly source: TailnetIp | null; readonly consumed: number }
  | { readonly kind: 'refuse' };

const V1_LIMIT = 107;
const V2_SIG = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
const V2_MAX_LEN = 512;

export function readProxyHeader(buffer: Buffer, version: 1 | 2): HeaderRead {
  return version === 1 ? readV1(buffer) : readV2(buffer);
}

function readV1(buffer: Buffer): HeaderRead {
  if (buffer.length === 0) return { kind: 'need' };
  if (buffer[0] !== 0x50) return { kind: 'refuse' };
  if (buffer.length < 6) return { kind: 'need' };
  if (buffer.subarray(0, 6).toString('ascii') !== 'PROXY ') return { kind: 'refuse' };
  const end = buffer.indexOf('\r\n');
  if (end < 0) return buffer.length >= V1_LIMIT ? { kind: 'refuse' } : { kind: 'need' };
  const consumed = end + 2;
  if (consumed > V1_LIMIT) return { kind: 'refuse' };
  const parts = buffer.subarray(0, end).toString('ascii').split(' ');
  const proto = parts[1];
  if (proto === 'UNKNOWN') return { kind: 'ready', source: null, consumed };
  if (proto !== 'TCP4' && proto !== 'TCP6') return { kind: 'refuse' };
  if (parts.length !== 6) return { kind: 'refuse' };
  const src = parts[2] ?? '';
  const sport = parts[4] ?? '';
  const dport = parts[5] ?? '';
  if (!isTailnetIp(src) || !portOk(sport) || !portOk(dport)) return { kind: 'refuse' };
  return { kind: 'ready', source: src, consumed };
}

function readV2(buffer: Buffer): HeaderRead {
  if (buffer.length === 0) return { kind: 'need' };
  if (buffer[0] !== V2_SIG[0]) return { kind: 'refuse' };
  if (buffer.length < 16) {
    return V2_SIG.subarray(0, buffer.length).equals(buffer) ? { kind: 'need' } : { kind: 'refuse' };
  }
  if (!V2_SIG.equals(buffer.subarray(0, 12))) return { kind: 'refuse' };
  const verCmd = buffer.readUInt8(12);
  const version = verCmd >> 4;
  const command = verCmd & 0x0f;
  if (version !== 0x2 || (command !== 0x0 && command !== 0x1)) return { kind: 'refuse' };
  const famProto = buffer.readUInt8(13);
  const family = famProto >> 4;
  const proto = famProto & 0x0f;
  const len = buffer.readUInt16BE(14);
  if (len > V2_MAX_LEN) return { kind: 'refuse' };
  const total = 16 + len;
  if (buffer.length < total) return { kind: 'need' };
  if (command === 0x0 || family === 0x0) return { kind: 'ready', source: null, consumed: total };
  if (command !== 0x1 || proto !== 0x1) return { kind: 'refuse' };
  const addr = buffer.subarray(16, total);
  const source = family === 0x1 ? ipv4(addr, 12) : family === 0x2 ? ipv6(addr, 36) : undefined;
  if (!source) return { kind: 'refuse' };
  return { kind: 'ready', source, consumed: total };
}

function ipv4(addr: Buffer, min: number): TailnetIp | undefined {
  if (addr.length < min) return undefined;
  const text = [addr.readUInt8(0), addr.readUInt8(1), addr.readUInt8(2), addr.readUInt8(3)].join('.');
  return isTailnetIp(text) ? text : undefined;
}

function ipv6(addr: Buffer, min: number): TailnetIp | undefined {
  if (addr.length < min) return undefined;
  let mapped = true;
  for (let i = 0; i < 10; i += 1) if (addr.readUInt8(i) !== 0) mapped = false;
  if (mapped && addr.readUInt8(10) === 0xff && addr.readUInt8(11) === 0xff) return ipv4(addr.subarray(12, 16), 4);
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(addr.readUInt16BE(i).toString(16));
  const text = parts.join(':');
  return isTailnetIp(text) ? text : undefined;
}

function portOk(text: string): boolean {
  if (!/^\d{1,5}$/.test(text)) return false;
  const n = Number(text);
  return n <= 65535;
}
