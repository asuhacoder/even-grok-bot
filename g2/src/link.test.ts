import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { Link } from './link.ts';

test('falls through dead and invalid candidates to the working relay, and reports each attempt', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(r => wss.on('listening', r));
  const port = (wss.address() as { port: number }).port;
  wss.on('connection', ws =>
    ws.on('message', d => {
      if (JSON.parse(String(d)).type === 'hello') ws.send(JSON.stringify({ type: 'welcome', bots: [], health: { relay: 'ok', grok: 'ok', asr: 'ok', detail: '' } }));
    }),
  );
  const attempts: string[] = [];
  let welcomed: () => void;
  const done = new Promise<void>(r => (welcomed = r));
  const link = new Link(['not a url', 'ws://127.0.0.1:9/ws', `ws://127.0.0.1:${port}/ws`], 't', {
    onMessage: m => m.type === 'welcome' && welcomed(),
    onUp: () => {},
    onAttempt: a => attempts.push(`${a.result} ${a.url.replace(String(port), 'P')}`),
  });
  link.start();
  await done;
  link.stop();
  wss.close();
  assert.deepEqual(attempts, ['throw not a url', 'closed ws://127.0.0.1:9/ws', 'open ws://127.0.0.1:P/ws', 'welcome ws://127.0.0.1:P/ws']);
});

test('an auth-denied route is not connected and falls through to the authenticated route', { timeout: 5000 }, async t => {
  const denied = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const accepted = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await Promise.all([denied, accepted].map(s => new Promise(r => s.on('listening', r))));
  const states: boolean[] = [];
  denied.on('connection', ws => ws.on('message', () => {
    assert.deepEqual(states, []);
    ws.close(4401, 'denied');
  }));
  accepted.on('connection', ws => ws.on('message', () => {
    assert.deepEqual(states, [false]);
    ws.send(JSON.stringify({ type: 'welcome', bots: [], health: { relay: 'ok', grok: 'ok', asr: 'ok', detail: '' } }));
  }));
  let finish!: () => void;
  const done = new Promise<void>(r => { finish = r; });
  const urls = [denied, accepted].map(s => `ws://127.0.0.1:${(s.address() as { port: number }).port}/ws`);
  const link = new Link(urls, '', {
    onMessage: m => { if (m.type === 'welcome') finish(); },
    onUp: up => states.push(up),
    onAttempt: () => {},
  });
  t.after(() => { link.stop(); for (const s of [denied, accepted]) { for (const ws of s.clients) ws.terminate(); s.close(); } });
  link.start();
  await done;
  assert.deepEqual(states, [false, true]);
});
