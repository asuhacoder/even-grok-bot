// Keeps Grok Bot running with its DevTools port open on loopback.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function grokAppPath(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string {
  if (env.GROK_APP) return env.GROK_APP;
  const user = `${env.HOME}/Applications/Grok Bot.app`;
  return exists(user) ? user : '/Applications/Grok Bot.app';
}

const APP = grokAppPath(process.env, existsSync);
const BINARY = `${APP}/Contents/MacOS/Grok Bot`;
const RELAUNCH_GAP_MS = 10 * 60 * 1000;

let lastAttempt = 0;

export async function cdpUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function grokPids(): Promise<number[]> {
  try {
    const { stdout } = await run('/usr/bin/pgrep', ['-f', `^${BINARY}( |$)`]);
    return stdout.split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** Seconds since the last keyboard or mouse input on this Mac. */
export async function idleSeconds(): Promise<number> {
  try {
    const { stdout } = await run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4']);
    const ns = /"HIDIdleTime" = (\d+)/.exec(stdout)?.[1];
    return ns ? Number(BigInt(ns) / 1_000_000_000n) : 0;
  } catch {
    return 0;
  }
}

const IDLE_BEFORE_RELAUNCH_S = 120;

/**
 * Starts Grok Bot with CDP if it is not reachable. A Grok Bot started without
 * the port (e.g. by hand) is quit and relaunched only once the Mac has been
 * idle for two minutes, so a person using it is not interrupted, and at most
 * once per 10 minutes.
 */
export async function ensureGrok(port: number, log: (s: string) => void): Promise<void> {
  if (await cdpUp(port)) return;
  if (Date.now() - lastAttempt < RELAUNCH_GAP_MS) return;
  const pids = await grokPids();
  if (pids.length && (await idleSeconds()) < IDLE_BEFORE_RELAUNCH_S) return;
  lastAttempt = Date.now();
  if (pids.length) {
    log(`Grok Bot is running without CDP (pid ${pids.join(',')}); relaunching while the Mac is idle`);
    for (const pid of pids) process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 40 && (await grokPids()).length; i++) await new Promise(r => setTimeout(r, 250));
  } else {
    log('Grok Bot is not running; launching');
  }
  await run('/usr/bin/open', ['-g', '-a', APP, '--args', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1']);
}
