import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectedOutcome, connectionLog, identityMatches } from './auth.ts';

test('tailnet identity matches only a configured login', () => {
  assert.equal(identityMatches('owner@example.com', 'owner@example.com'), true);
  assert.equal(identityMatches('owner@example.com', ''), false);
  assert.equal(identityMatches('other@example.com', 'owner@example.com'), false);
  assert.equal(identityMatches(undefined, 'owner@example.com'), false);
  assert.equal(identityMatches(['owner@example.com'], 'owner@example.com'), true);
});

test('auth logs name the result and never the token', () => {
  assert.equal(connectionLog('tailnet identity'), 'client connected (tailnet identity)');
  assert.equal(connectionLog('tailnet identity via proxy'), 'client connected (tailnet identity via proxy)');
  assert.equal(connectionLog('token'), 'client connected (token)');
  assert.equal(connectionLog('denied'), 'client denied (token)');
  assert.equal(connectionLog('auth timeout'), 'client denied (auth timeout)');
  for (const outcome of ['tailnet identity', 'tailnet identity via proxy', 'token', 'denied', 'auth timeout'] as const) {
    assert.equal(connectionLog(outcome).includes('secret-token'), false);
  }
});

test('a proxy owner and a header owner log differently, and a failed owner is the token path', () => {
  assert.equal(connectedOutcome(true, 'proxy'), 'tailnet identity via proxy');
  assert.equal(connectedOutcome(true, 'header'), 'tailnet identity');
  assert.equal(connectedOutcome(false, 'proxy'), 'token');
  assert.equal(connectedOutcome(false, 'header'), 'token');
});
