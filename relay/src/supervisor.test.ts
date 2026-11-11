import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grokAppPath } from './supervisor.ts';

test('Grok Bot is found in ~/Applications, then /Applications, unless GROK_APP names it', () => {
  const home = '/home/someone';
  const user = `${home}/Applications/Grok Bot.app`;
  assert.equal(grokAppPath({ HOME: home }, path => path === user), user);
  assert.equal(grokAppPath({ HOME: home }, () => false), '/Applications/Grok Bot.app');
  assert.equal(grokAppPath({ HOME: home, GROK_APP: '/opt/Grok Bot.app' }, () => true), '/opt/Grok Bot.app');
});
