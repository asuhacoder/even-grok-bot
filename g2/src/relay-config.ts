export interface Setup {
  url: string;
  token: string;
}

export interface RelayCandidate {
  websocket: string;
  diag: string;
}

const TAILNET_FIRST = 100;
const TAILNET_SECOND_MIN = 64;
const TAILNET_SECOND_MAX = 127;
const LOOPBACK = 127;

function octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^[0-9]{1,3}$/.test(part))) return null;
  const nums = parts.map(part => Number(part));
  if (nums.some(n => n > 255) || nums.join('.') !== host) return null;
  return nums;
}

function cleartextHost(host: string): boolean {
  const oct = octets(host);
  if (!oct) return false;
  if (oct[0] === LOOPBACK) return true;
  return oct[0] === TAILNET_FIRST && oct[1]! >= TAILNET_SECOND_MIN && oct[1]! <= TAILNET_SECOND_MAX;
}

export function acceptRelayUrl(raw: string): RelayCandidate | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const secure = url.protocol === 'wss:';
  if (!secure && !(url.protocol === 'ws:' && cleartextHost(url.hostname))) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!url.pathname.endsWith('/ws')) return null;
  const diagPath = url.pathname.replace(/\/ws$/, '/diag');
  const http = secure ? 'https:' : 'http:';
  return {
    websocket: `${url.protocol}//${url.host}${url.pathname}`,
    diag: `${http}//${url.host}${diagPath}`,
  };
}

export function relayCandidates(chunks: string[]): { urls: string[]; diag: string[]; rejected: string[] } {
  const accepted: RelayCandidate[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const item of chunks.flatMap(chunk => chunk.split(',')).map(item => item.trim()).filter(Boolean)) {
    const hit = acceptRelayUrl(item);
    if (!hit) {
      rejected.push(item);
      continue;
    }
    if (seen.has(hit.websocket)) continue;
    seen.add(hit.websocket);
    accepted.push(hit);
  }
  accepted.sort((a, b) => Number(b.websocket.startsWith('wss:')) - Number(a.websocket.startsWith('wss:')));
  return {
    urls: accepted.map(item => item.websocket),
    diag: accepted.map(item => item.diag),
    rejected,
  };
}

export function rejectPackagedSecrets(env: { VITE_RELAY_URLS?: string; VITE_RELAY_URL?: string; VITE_RELAY_TOKEN?: string }): void {
  const urls = (env.VITE_RELAY_URLS ?? env.VITE_RELAY_URL ?? '').trim();
  const token = (env.VITE_RELAY_TOKEN ?? '').trim();
  if (urls || token) throw new Error('Do not embed a relay URL or token in a distributed package. Set them on the phone or with the setup QR.');
}

export function resolveSetup(page: Setup, qr: Setup, bridge: Setup | null): Setup {
  if (qr.url.trim() || qr.token.trim()) {
    return {
      url: qr.url.trim() || bridge?.url || page.url,
      token: qr.token.trim() || bridge?.token || page.token,
    };
  }
  if (bridge && (bridge.url || bridge.token)) return { url: bridge.url || page.url, token: bridge.token || page.token };
  return { url: page.url, token: page.token };
}

export function diagPayload(
  event: string,
  fields: Record<string, unknown>,
  meta: { candidates: string[]; diag: string[]; hasToken: boolean; href: string; secure: boolean; ua: string; now: number },
): string {
  return JSON.stringify({
    event,
    ...fields,
    candidates: meta.candidates,
    diag: meta.diag,
    hasToken: meta.hasToken,
    href: meta.href,
    secure: meta.secure,
    ua: meta.ua,
    t: meta.now,
  });
}
