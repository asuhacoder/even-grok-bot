import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTailnetIp } from './proxy.ts';
import { tailscaleWhois } from './whois.ts';

test('whois remembers a login and fetches again after a miss or expiry', async () => {
  const ipText = [203, 0, 113, 10].join('.');
  assert.equal(isTailnetIp(ipText), true);
  if (!isTailnetIp(ipText)) return;
  let clock = 0;
  const lookups: string[] = [];
  let miss = true;
  const whois = tailscaleWhois({
    bin: 'tailscale',
    now: () => clock,
    lookup(ip) {
      lookups.push(ip);
      if (miss) {
        miss = false;
        return Promise.resolve({ kind: 'miss' });
      }
      return Promise.resolve({ kind: 'login', login: 'you@example.com' });
    },
  });
  assert.deepEqual(await whois.loginFor(ipText), { kind: 'miss' });
  assert.deepEqual(await whois.loginFor(ipText), { kind: 'login', login: 'you@example.com' });
  assert.equal(lookups.length, 2);
  assert.deepEqual(await whois.loginFor(ipText), { kind: 'login', login: 'you@example.com' });
  assert.equal(lookups.length, 2);
  clock = 30_001;
  assert.deepEqual(await whois.loginFor(ipText), { kind: 'login', login: 'you@example.com' });
  assert.equal(lookups.length, 3);
});
