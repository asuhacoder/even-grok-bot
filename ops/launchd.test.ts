import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const templates = [join(root, 'asr/dev.evengrok.asr.plist'), join(root, 'ops/dev.evengrok.relay.plist')];

function writeStubs(bin: string): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'launchctl'), `#!/bin/bash
printf '%s\\n' "$*" >> "\${LAUNCHCTL_LOG:?}"
if [[ "\${FAIL_FIRST_BOOTSTRAP:-}" == 1 && "$1" == bootstrap ]]; then
  n=$(grep -c '^bootstrap ' "\${LAUNCHCTL_LOG}")
  [[ "$n" -eq 1 ]] && exit 1
fi
exit 0
`, { mode: 0o755 });
  writeFileSync(join(bin, 'tailscale'), `#!/bin/bash
printf '%s\\n' "\$*" >> "\${TAILSCALE_LOG:-/dev/null}"
if [[ "$1" == --socket ]]; then shift 2; fi
case "$1" in
  serve) exit 0 ;;
  status) printf '%s\\n' '{"Self":{"DNSName":"relay.example.test."}}' ;;
  ip) printf '%s\\n' '203.0.113.10' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
}

function runInstall(script: string, home: string, env: Record<string, string> = {}) {
  const bin = join(home, 'bin');
  const log = join(home, 'launchctl.log');
  const tailscaleLog = join(home, 'tailscale.log');
  writeStubs(bin);
  writeFileSync(log, '');
  writeFileSync(tailscaleLog, '');
  const { TAILSCALE_SOCKET: _socket, TAILSCALE_BIN: _bin, GROK_APP: _app, ...inherited } = process.env;
  try {
    const stdout = execFileSync(script, {
      encoding: 'utf8',
      env: { ...inherited, HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}`, LAUNCHCTL_LOG: log, TAILSCALE_LOG: tailscaleLog, ...env },
    });
    return { status: 0, stdout, stderr: '', log: readFileSync(log, 'utf8') };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { status: failed.status, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', log: readFileSync(log, 'utf8') };
  }
}

test('both launchd templates parse, and each label is a string', () => {
  const parsed = execFileSync('python3', ['-c', `
import plistlib, sys
for path in sys.argv[1:]:
    data = plistlib.load(open(path, 'rb'))
    label = data.get('Label')
    if not isinstance(label, str) or not label:
        raise SystemExit('missing Label')
    print(label)
`, ...templates], { encoding: 'utf8' });
  assert.deepEqual(parsed.trim().split('\n'), ['dev.evengrok.asr', 'dev.evengrok.relay']);
});

test('install.sh loads asr before relay when both templates parse', () => {
  const home = join(tmpdir(), `even-grok-install-${process.pid}-ok`);
  const result = runInstall(join(root, 'ops/install.sh'), home);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.log.trim().split('\n');
  assert.deepEqual(lines.map(line => line.split(' ')[0]), ['bootout', 'bootstrap', 'bootout', 'bootstrap']);
  assert.match(lines[0] ?? '', /dev\.evengrok\.asr$/);
  assert.match(lines[2] ?? '', /dev\.evengrok\.relay$/);
  const tailscale = readFileSync(join(home, 'tailscale.log'), 'utf8');
  assert.match(tailscale, /serve --tcp=8792 off/);
  assert.match(tailscale, /serve --bg --tcp=8792 --proxy-protocol=2 tcp:\/\/127\.0\.0\.1:8793/);
  const relay = readFileSync(join(home, 'Library/LaunchAgents/dev.evengrok.relay.plist'), 'utf8');
  assert.match(relay, /<key>RELAY_RAW_PROXY_PROTOCOL<\/key>\s*<string>2<\/string>/);
  const asr = readFileSync(join(home, 'Library/LaunchAgents/dev.evengrok.asr.plist'), 'utf8');
  assert.match(asr, /<string>dev\.evengrok\.asr<\/string>/);
  assert.doesNotMatch(asr, /<string>dev\.evengrok\.asr<\/key>/);
});

test('an invalid asr template stops install.sh before launchctl unloads the job', () => {
  const home = join(tmpdir(), `even-grok-install-${process.pid}-bad`);
  const tree = join(home, 'tree');
  mkdirSync(join(tree, 'asr'), { recursive: true });
  mkdirSync(join(tree, 'ops'), { recursive: true });
  cpSync(join(root, 'ops/install.sh'), join(tree, 'ops/install.sh'));
  cpSync(join(root, 'ops/dev.evengrok.relay.plist'), join(tree, 'ops/dev.evengrok.relay.plist'));
  const broken = readFileSync(join(root, 'asr/dev.evengrok.asr.plist'), 'utf8')
    .replace('<string>dev.evengrok.asr</string>', '<string>dev.evengrok.asr</key>');
  writeFileSync(join(tree, 'asr/dev.evengrok.asr.plist'), broken);
  const result = runInstall(join(tree, 'ops/install.sh'), home);
  assert.notEqual(result.status, 0);
  assert.equal(result.log, '');
  assert.match(result.stderr, /invalid/);
});

test('a failed bootstrap puts the previous asr job back', () => {
  const home = join(tmpdir(), `even-grok-install-${process.pid}-restore`);
  const dest = join(home, 'Library/LaunchAgents');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'dev.evengrok.asr.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>previous-asr</string></dict></plist>
`);
  const result = runInstall(join(root, 'ops/install.sh'), home, { FAIL_FIRST_BOOTSTRAP: '1' });
  assert.notEqual(result.status, 0);
  assert.match(readFileSync(join(dest, 'dev.evengrok.asr.plist'), 'utf8'), /previous-asr/);
  const bootstraps = result.log.split('\n').filter(line => line.startsWith('bootstrap '));
  assert.equal(bootstraps.length, 2);
  assert.match(bootstraps[0] ?? '', /dev\.evengrok\.asr/);
  assert.doesNotMatch(result.log, /dev\.evengrok\.relay/);
});

test('install.sh uses the default tailscaled socket unless a userspace socket exists', () => {
  const plain = join(tmpdir(), `even-grok-install-${process.pid}-plain`);
  const result = runInstall(join(root, 'ops/install.sh'), plain);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(readFileSync(join(plain, 'tailscale.log'), 'utf8'), /--socket/);
  const relay = readFileSync(join(plain, 'Library/LaunchAgents/dev.evengrok.relay.plist'), 'utf8');
  assert.match(relay, /<key>TAILSCALE_SOCKET<\/key>\s*<string><\/string>/);
  assert.match(relay, /<key>GROK_APP<\/key>\s*<string><\/string>/);

  const userspace = join(tmpdir(), `even-grok-install-${process.pid}-userspace`);
  mkdirSync(join(userspace, '.tailscale'), { recursive: true });
  writeFileSync(join(userspace, '.tailscale/tailscaled.sock'), '');
  const second = runInstall(join(root, 'ops/install.sh'), userspace);
  assert.equal(second.status, 0, second.stderr);
  const calls = readFileSync(join(userspace, 'tailscale.log'), 'utf8').trim().split('\n');
  assert.ok(calls.length > 0 && calls.every(line => line.startsWith(`--socket ${userspace}/.tailscale/tailscaled.sock `)), calls.join('\n'));
});
