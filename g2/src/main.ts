// G2 app entry: bridge events -> machine inputs, machine effects -> relay / mic / exit.

import { AudioInputSource, OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { Glasses, menuById } from './glasses.ts';
import { Link } from './link.ts';
import { initialModel, step, top } from './machine.ts';
import type { Effect, Input, Model } from './machine.ts';
import { diagPayload, relayCandidates, resolveSetup } from './relay-config.ts';
import type { Setup } from './relay-config.ts';
import { view } from './view.ts';

const SETTINGS_KEY = 'evengrok.settings';
const TOKEN_KEY = 'evengrok.token';

function sameOriginUrl(): string {
  const at = location.pathname.indexOf('/app/');
  if (at < 0 || !location.protocol.startsWith('http')) return '';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${location.pathname.slice(0, at)}/ws`;
}

const env = import.meta.env as Record<string, string | undefined>;
const developing = import.meta.env.MODE === 'development';

function readQr(): Setup {
  const hash = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  return {
    url: (hash.get('url') ?? query.get('url') ?? '').trim(),
    token: (hash.get('token') ?? query.get('token') ?? '').trim(),
  };
}

function readPage(): Setup {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Setup>;
    return { url: saved.url ?? '', token: saved.token ?? '' };
  } catch {
    return { url: '', token: '' };
  }
}

const qr = readQr();
let settings = resolveSetup(readPage(), qr, null);
if (developing && !settings.token) settings = { ...settings, token: env.VITE_RELAY_TOKEN ?? '' };
localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
if (qr.url || qr.token) history.replaceState(null, '', location.pathname);

function endpoints() {
  const dev = developing ? (env.VITE_RELAY_URLS ?? env.VITE_RELAY_URL ?? '') : '';
  return relayCandidates([settings.url, sameOriginUrl(), dev]);
}

function diag(event: string, data: Record<string, unknown> = {}): void {
  const relay = endpoints();
  const body = diagPayload(event, data, {
    candidates: relay.urls,
    diag: relay.diag,
    hasToken: !!settings.token,
    href: location.href.split('#')[0]!.split('?')[0]!,
    secure: isSecureContext,
    ua: navigator.userAgent,
    now: Date.now(),
  });
  console.log('[diag]', event, body);
  for (const url of relay.diag) fetch(url, { method: 'POST', body, keepalive: true }).catch(() => {});
}

const phone = document.getElementById('app')!;
const cgnat = '100.' + '64.0.0/10';
phone.innerHTML = `
  <h1>Grok Bot × G2</h1>
  <p id="status">起動中…</p>
  <p>中継の WebSocket URL をこの電話に保存します。パッケージには接続先を入れません。</p>
  <label>中継URL<input id="url" placeholder="wss://relay.example/ws"></label>
  <p>複数はカンマ区切りです。wss を先に試します。開かないときは Tailscale の IPv4（${cgnat}）への ws を足します。それ以外の平文 ws は拒否します。</p>
  <label>トークン<input id="token" type="password" autocomplete="off"></label>
  <p>生TCPでも自分のTailscaleログインならトークンは不要です。一致しないときや身元が取れないときはトークンが要ります。無いか違うときは中継ログに client denied (token) が出ます。</p>
  <button id="save">保存して接続</button>`;
const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
$('url').value = settings.url;
$('token').value = settings.token;

window.addEventListener('error', e => diag('error', { message: e.message }));
window.addEventListener('unhandledrejection', e => diag('rejection', { message: String(e.reason) }));

const bridge = await waitForEvenAppBridge();

let model: Model = initialModel();
let micOn = false;
const glasses = new Glasses(bridge, e => diag('render', { message: e instanceof Error ? e.message : JSON.stringify(e) }));
let lastAttempt = '';

// The WebView's localStorage does not survive app updates in the Even app; the host's own storage does.
const bridgedRaw = await bridge.getLocalStorage(SETTINGS_KEY).catch(() => '');
let bridged: Setup | null = null;
try {
  const parsed = JSON.parse(bridgedRaw) as Partial<Setup>;
  if (parsed.url || parsed.token) bridged = { url: parsed.url ?? '', token: parsed.token ?? '' };
} catch {
  bridged = null;
}
if (!bridged?.token) {
  const legacy = (await bridge.getLocalStorage(TOKEN_KEY).catch(() => '')) || '';
  if (legacy) bridged = { url: bridged?.url ?? '', token: legacy };
}
settings = resolveSetup(readPage(), qr, bridged);
if (developing && !settings.token) settings = { ...settings, token: env.VITE_RELAY_TOKEN ?? '' };
localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
void bridge.setLocalStorage(SETTINGS_KEY, JSON.stringify(settings)).catch(() => false);
if (settings.token) void bridge.setLocalStorage(TOKEN_KEY, settings.token).catch(() => false);
$('url').value = settings.url;
$('token').value = settings.token;
diag('boot', { rejected: endpoints().rejected });
diag('token', { source: settings.token ? 'stored' : 'none' });

const link = new Link(endpoints().urls, settings.token, {
  onMessage: msg => {
    if (msg.type === 'denied') diag('denied', { reason: msg.reason });
    dispatch({ type: 'server', msg });
  },
  onUp: up => dispatch({ type: 'connection', up }),
  onAttempt: a => {
    lastAttempt = `${a.result} ${a.url} ${a.detail}`;
    diag('attempt', a);
    updateStatus();
  },
});

function run(e: Effect): void {
  switch (e.type) {
    case 'send':
      return link.send(e.msg);
    case 'mic':
      micOn = e.on;
      void bridge.audioControl(e.on, AudioInputSource.Glasses);
      return;
    case 'exit':
      void bridge.shutDownPageContainer(1);
      return;
  }
}

let lastScreen = '';
function dispatch(input: Input): void {
  const r = step(model, input);
  model = r.model;
  // Screen transitions in the console let the simulator harness (g2/sim/flows.mjs) assert flows.
  if (top(model).name !== lastScreen) console.log(`[screen] ${(lastScreen = top(model).name)}`);
  for (const e of r.effects) if (e.type === 'send' && e.msg.type !== 'read') console.log(`[send] ${e.msg.type}`);
  r.effects.forEach(run);
  glasses.show(view(model));
  updateStatus();
}

function updateStatus(): void {
  const relay = endpoints();
  const rejected = relay.rejected.length ? `\n拒否: ${relay.rejected.join(', ')}` : '';
  document.getElementById('status')!.textContent =
    `${model.connected ? '接続中' : '未接続'} / 画面: ${top(model).name} ${model.health.detail}\n最後の接続試行: ${lastAttempt}${rejected}`;
}

$('save').onclick = () => {
  const next: Setup = { url: $('url').value.trim(), token: $('token').value.trim() };
  const parsed = relayCandidates([next.url]);
  if (next.url && parsed.urls.length === 0) {
    document.getElementById('status')!.textContent = `中継URLを拒否しました: ${parsed.rejected.join(', ')}`;
    return;
  }
  settings = next;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  void bridge.setLocalStorage(SETTINGS_KEY, JSON.stringify(settings)).catch(() => false);
  void bridge.setLocalStorage(TOKEN_KEY, settings.token).catch(() => false);
  link.reconfigure(endpoints().urls, settings.token);
  diag('save', { rejected: endpoints().rejected });
};

/** Protobuf drops zero values, so a click can arrive with eventType undefined inside its envelope. */
const typeOf = (env?: { eventType?: OsEventTypeList }) => (env ? (env.eventType ?? OsEventTypeList.CLICK_EVENT) : null);

bridge.onEvenHubEvent(ev => {
  const pcm = ev.audioEvent?.audioPcm;
  if (pcm) {
    if (micOn) link.sendBinary(pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm as ArrayLike<number>));
    return;
  }
  if (ev.menuItemClickEvent) {
    const item = menuById(ev.menuItemClickEvent.itemID ?? 0);
    if (item) dispatch({ type: 'menu', item });
    return;
  }
  const t = typeOf(ev.listEvent) ?? typeOf(ev.textEvent) ?? typeOf(ev.sysEvent);
  switch (t) {
    case OsEventTypeList.CLICK_EVENT:
      return dispatch(ev.listEvent ? { type: 'select', index: ev.listEvent.currentSelectItemIndex ?? 0 } : { type: 'tap' });
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      return dispatch({ type: 'double' });
    case OsEventTypeList.SCROLL_TOP_EVENT:
      return dispatch({ type: 'scroll', dir: 'up' });
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      return dispatch({ type: 'scroll', dir: 'down' });
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      diag('foreground');
      link.start();
      if (micOn) void bridge.audioControl(true, AudioInputSource.Glasses);
      return;
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      if (micOn) void bridge.audioControl(false);
      link.stop();
      return;
  }
});

glasses.show(view(model));
link.start();
