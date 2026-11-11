import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptRelayUrl, diagPayload, rejectPackagedSecrets, relayCandidates, resolveSetup } from './relay-config.ts';

const ip = (a: number, b: number, c: number, d: number) => [a, b, c, d].join('.');
const ws = (host: string, port = 9) => `ws://${host}:${port}/ws`;

test('accepts a wss relay and a tailnet or loopback ws relay, and rejects other cleartext', () => {
  assert.equal(acceptRelayUrl('wss://relay.example.test/evengrok/ws')?.websocket, 'wss://relay.example.test/evengrok/ws');
  assert.equal(acceptRelayUrl('wss://relay.example.test/evengrok/ws')?.diag, 'https://relay.example.test/evengrok/diag');
  const tailnet = ws(ip(100, 64, 0, 1), 8792);
  assert.equal(acceptRelayUrl(tailnet)?.websocket, tailnet);
  assert.equal(acceptRelayUrl(tailnet)?.diag, `http://${ip(100, 64, 0, 1)}:8792/diag`);
  assert.equal(acceptRelayUrl(ws(ip(100, 127, 255, 254)))?.websocket, ws(ip(100, 127, 255, 254)));
  assert.ok(acceptRelayUrl('ws://127.0.0.1:8809/ws'));
  for (const value of [
    'not a url',
    'https://relay.example.test/ws',
    'ws://relay.example.test/ws',
    ws(ip(100, 63, 0, 1)),
    ws(ip(100, 128, 0, 1)),
    ws(ip(10, 0, 0, 1)),
    ws(ip(192, 168, 1, 1)),
    'wss://user:secret@relay.example.test/ws',
    'wss://relay.example.test/ws?token=secret',
    'wss://relay.example.test/ws#secret',
    'wss://relay.example.test/',
    'wss://relay.example.test/evengrok',
  ]) {
    assert.equal(acceptRelayUrl(value), null, value);
  }
});

test('tries wss before a tailnet ws and drops duplicates', () => {
  const tailnet = ws(ip(100, 64, 1, 2));
  const secure = 'wss://relay.example.test/ws';
  const got = relayCandidates([`${tailnet}, ${secure}`, secure]);
  assert.deepEqual(got.urls, [secure, tailnet]);
  assert.deepEqual(got.diag, ['https://relay.example.test/diag', `http://${ip(100, 64, 1, 2)}:9/diag`]);
  assert.deepEqual(got.rejected, []);
});

test('reports rejected candidates without dropping the ones it can try', () => {
  const got = relayCandidates(['ws://relay.example.test/ws, wss://relay.example.test/ws']);
  assert.deepEqual(got.urls, ['wss://relay.example.test/ws']);
  assert.deepEqual(got.rejected, ['ws://relay.example.test/ws']);
});

test('a package build rejects an embedded relay URL or token', () => {
  assert.doesNotThrow(() => rejectPackagedSecrets({}));
  assert.doesNotThrow(() => rejectPackagedSecrets({ VITE_RELAY_URLS: '  ', VITE_RELAY_TOKEN: '' }));
  for (const env of [
    { VITE_RELAY_URLS: 'wss://relay.example.test/ws' },
    { VITE_RELAY_URL: 'wss://relay.example.test/ws' },
    { VITE_RELAY_TOKEN: 'secret' },
  ]) {
    assert.throws(() => rejectPackagedSecrets(env), /Do not embed/);
  }
});

test('setup prefers the QR, then the phone bridge, then this page', () => {
  const page = { url: 'wss://page.example/ws', token: 'page' };
  const bridge = { url: 'wss://bridge.example/ws', token: 'bridge' };
  assert.deepEqual(resolveSetup(page, { url: '', token: '' }, null), page);
  assert.deepEqual(resolveSetup({ url: '', token: '' }, { url: '', token: '' }, bridge), bridge);
  assert.deepEqual(resolveSetup(page, { url: 'wss://qr.example/ws', token: '' }, bridge), { url: 'wss://qr.example/ws', token: 'bridge' });
  assert.deepEqual(resolveSetup(page, { url: '', token: 'qr' }, bridge), { url: bridge.url, token: 'qr' });
});

test('diagnostic payload names every candidate and does not carry a token', () => {
  const body = diagPayload('attempt', { result: 'closed', detail: 'code=4401 reason=denied' }, {
    candidates: ['wss://relay.example.test/ws'],
    diag: ['https://relay.example.test/diag'],
    hasToken: false,
    href: 'https://app.example/index.html',
    secure: true,
    ua: 'test',
    now: 1,
  });
  const parsed = JSON.parse(body) as { event: string; hasToken: boolean; candidates: string[]; token?: string };
  assert.equal(parsed.event, 'attempt');
  assert.equal(parsed.hasToken, false);
  assert.deepEqual(parsed.candidates, ['wss://relay.example.test/ws']);
  assert.equal(parsed.token, undefined);
  assert.equal(body.includes('secret-token'), false);
});
