import { spawn } from 'node:child_process';
import type { TailnetIp } from './proxy.ts';

export type WhoisAnswer = { readonly kind: 'login'; readonly login: string } | { readonly kind: 'miss' };

export interface Whois {
  loginFor(ip: TailnetIp): Promise<WhoisAnswer>;
}

const TTL_MS = 30_000;
const STDOUT_CAP = 1_048_576;

export function tailscaleWhois(opts: {
  readonly bin: string;
  readonly socket?: string | undefined;
  readonly now?: () => number;
  readonly lookup?: (ip: TailnetIp) => Promise<WhoisAnswer>;
  readonly timeoutMs?: number;
}): Whois {
  const cache = new Map<string, { login: string; expiresAt: number }>();
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 1500;
  return {
    async loginFor(ip) {
      const clock = now();
      const hit = cache.get(ip);
      if (hit && hit.expiresAt > clock) return { kind: 'login', login: hit.login };
      let answer: WhoisAnswer;
      try {
        answer = opts.lookup ? await opts.lookup(ip) : await runWhois(opts.bin, opts.socket, ip, timeoutMs);
      } catch {
        return { kind: 'miss' };
      }
      // Misses are not stored. A cached miss would hide a later successful lookup.
      if (answer.kind !== 'login') return { kind: 'miss' };
      cache.set(ip, { login: answer.login, expiresAt: clock + TTL_MS });
      return answer;
    },
  };
}

function runWhois(bin: string, socket: string | undefined, ip: string, timeoutMs: number): Promise<WhoisAnswer> {
  const args = socket ? ['--socket', socket, 'whois', '--json', ip] : ['whois', '--json', ip];
  return new Promise(resolve => {
    let settled = false;
    const done = (answer: WhoisAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ kind: 'miss' });
    }, timeoutMs);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= STDOUT_CAP) chunks.push(chunk);
    });
    child.on('error', () => done({ kind: 'miss' }));
    child.on('close', code => {
      if (code !== 0 || size > STDOUT_CAP) return done({ kind: 'miss' });
      done(parseWhois(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

function parseWhois(text: string): WhoisAnswer {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'miss' };
  }
  if (!isRecord(body)) return { kind: 'miss' };
  const profile = body.UserProfile;
  if (!isRecord(profile)) return { kind: 'miss' };
  const login = profile.LoginName;
  if (typeof login !== 'string' || login.length === 0) return { kind: 'miss' };
  return { kind: 'login', login };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
