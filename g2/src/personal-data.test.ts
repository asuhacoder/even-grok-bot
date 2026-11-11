import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const skipDir = new Set(['.git', 'node_modules', 'vendor', 'dist', '.cache', '.pnpm-store', '.worktrees']);
const allowed = ['secret@relay.example.test', 'machine.tailXXXX.ts.net', '100.' + '64.0.0/10'];
const homeMarker = '/Users' + '/';
const publicHandle = 'asu' + 'hacoder';

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (skipDir.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...files(path));
    else if (stat.isFile() && stat.size < 2_000_000) out.push(path);
  }
  return out;
}

test('the tree has no home path, email, tailnet name, or tailnet address', () => {
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const host = /[A-Za-z0-9-]+\.ts\.net/g;
  const cgnat = /\b100\.(?:6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g;
  const hits: string[] = [];
  for (const path of files(root)) {
    let text = readText(path);
    if (text === null) continue;
    for (const ok of allowed) text = text.split(ok).join('');
    const rel = path.slice(root.length + 1);
    if (text.includes(homeMarker)) hits.push(`${rel}: home path`);
    for (const match of text.match(email) ?? []) {
      const domain = match.slice(match.indexOf('@') + 1);
      if (domain === 'example.com' || domain === 'relay.example.test') continue;
      hits.push(`${rel}: ${match}`);
    }
    for (const match of text.match(host) ?? []) hits.push(`${rel}: ${match}`);
    for (const match of text.match(cgnat) ?? []) hits.push(`${rel}: ${match}`);
  }
  assert.deepEqual(hits, []);
});

test('the shipped manifest has a placeholder id and an empty network whitelist', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'g2/app.json'), 'utf8')) as {
    package_id: string;
    version: string;
    permissions: { name: string; whitelist?: string[] }[];
  };
  assert.equal(manifest.package_id, 'com.example.grokbotg2');
  assert.equal(manifest.version, '0.1.8');
  const network = manifest.permissions.find(p => p.name === 'network');
  assert.deepEqual(network?.whitelist, []);
});

const bannedByLength = new Map<number, Set<string>>();
for (const [len, hash] of [
  [2, '07fc6c1ea93020c7ea099a11581cdfc2306a8039836b940581721623de4f89f4'],
  [2, 'bb8b40a6b626da1ceb5f97f6ad31c9a2c894bf5631e60db865caa806c5f1b08f'],
  [2, 'dda7cb1de943c04465e39e79c894b6c450e459248095e81f6d5caaaad006fe27'],
  [3, '2e0c22f44f8d337e69b3da971dbc94641c795e26bc6cf224e0b0a5e44bffaabd'],
  [3, '79b89520750b886f335602106b0223e974dee0da2f57767e80cac334aa57fc32'],
  [3, '898b77915fad40e3c257311767f15a7678c5c7ae90701e8903a0e78905910a3a'],
  [3, 'bb15c4f0c9df1c77e9914a74e712cb52914b759e2434f2da9e9c7212fb0a1a01'],
  [3, 'efe6291fbaf8f7ca6da1e809e51843283cfd1594e6795e6c9e94a3058c13b28c'],
  [4, '7de0adb311372accc1afac5b10df6a4b22498787620ac561f30a8b97606d7d01'],
  [4, 'c70393d1c5cd8d31694315dbc431fabd5a0d3851035fb5f2d40d32a795641d70'],
  [4, 'db0f17768e0e55d824b849e7ed2b9d3b95ce263e2d237f80630f7a4a328c33dc'],
  [4, 'dc6f17bbec824fff8f86587966b2047db6ab736785840151f13d1dab124e2a54'],
  [4, 'f24723b66c6844e5e5827988e21c38283c72d9c1175ac12e5463f6d29b7fb7fc'],
  [4, 'fbdabfdaa898ca0e2c8db3c90394227598945335b3b44d6113e4117aa2a4aa9d'],
  [5, '59c21a6b212c431425f81f235f4c7ee87a7b2dd8c9888e2ac039cdec78860d27'],
  [5, '8321a60d94909f8b1b062a91c211b99c263f04aa348767086fca7bf324b2c669'],
  [5, '86a4d8c3abb32287eb1a7803b80852cb1366f6bef5728aea5e9b3368da42ac66'],
  [6, '0953ad0078195ee1ce37ea4f6abacb5dfb920e3730e2ad75d29388a2264f9c20'],
  [6, '13857c220ae3ac10ccefd5fe4eb50a1f026e41f4a237ab562e3cc8868dd67488'],
  [9, '35b7682ae0a8d274586942d807c1d36220944ad791903f0728d4723557e91db9'],
  [9, '6142b77e283b193d88ff5c2decd318c8e3f71a6f467416eb10e1611c77dc4718'],
  [9, 'b36647dc7de33abede145afdd87b2d620fb82a68fd179e01db3e2354851f4a38'],
  [10, '4f5b5f7f2bd5ee8177fa9b6db363feb6eb9dc8efc26e01c73065daeb5acf9367'],
  [10, '84c9b9050a5a84d00a4053aa4cf39adea244e5ea3a6a01c92858e19d94c4085c'],
  [14, '3be22d9590b5455aab521cd462399d2d68cf066215e0080c13e105da815fdb3c'],
] as const) {
  const set = bannedByLength.get(len) ?? new Set<string>();
  set.add(hash);
  bannedByLength.set(len, set);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readText(path: string): string | null {
  try {
    const raw = readFileSync(path);
    if (raw.includes(0)) return execFileSync('strings', ['-n', '4', path], { encoding: 'utf8' });
    return raw.toString('utf8');
  } catch {
    return null;
  }
}

function bannedLength(text: string): number | null {
  const lower = text.toLowerCase();
  for (const [len, hashes] of bannedByLength) {
    if (lower.length < len) continue;
    for (let i = 0; i <= lower.length - len; i++) {
      if (hashes.has(digest(lower.slice(i, i + len)))) return len;
    }
  }
  return null;
}

test('the tree has no org names, bot names, phone numbers, addresses, or agent ids', () => {
  const phone = /(?<!\d)(?:0\d{1,3}-\d{1,4}-\d{4}|\+81[-\s]?\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4})(?!\d)/g;
  const postalMark = String.fromCodePoint(0x3012);
  const block = String.fromCodePoint(0x4e01) + String.fromCodePoint(0x76ee);
  const postal = new RegExp(`${postalMark}\\s?\\d{3}-?\\d{4}|\\d{1,4}${block}`, 'g');
  const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
  const cloudAgent = /\bbc-[0-9a-f]{8,}\b/gi;
  const token = new RegExp(`\\b(?:gh${'p_'}|github_${'pat_'}|sk-|xo${'x'}[baprs]-|AKIA)[A-Za-z0-9_-]{16,}`, 'g');
  const boxHome = '/home/' + 'box';
  const agentData = 'agent-' + 'data';
  const hits: string[] = [];
  for (const path of files(root)) {
    const text = readText(path);
    if (text === null) continue;
    const rel = path.slice(root.length + 1);
    const named = bannedLength(text.split(publicHandle).join(''));
    if (named !== null) hits.push(`${rel}: hashed name length ${named}`);
    if (text.includes(boxHome)) hits.push(`${rel}: home path`);
    if (text.toLowerCase().includes(agentData)) hits.push(`${rel}: agent data path`);
    for (const match of text.match(phone) ?? []) hits.push(`${rel}: phone`);
    if ((text.match(postal) ?? []).length > 0) hits.push(`${rel}: address`);
    for (const match of text.match(uuid) ?? []) hits.push(`${rel}: uuid`);
    for (const match of text.match(cloudAgent) ?? []) hits.push(`${rel}: cloud agent id`);
    for (const match of text.match(token) ?? []) hits.push(`${rel}: token`);
  }
  assert.deepEqual(hits, []);
});

test('git tracks no audio, image, package, or dist output', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const bad = tracked.filter(path => /(^|\/)dist\/|\.(?:wav|pcm|aiff|mp3|flac|ogg|m4a|aac|png|jpe?g|gif|webp|ehpk)$/i.test(path));
  assert.deepEqual(bad, []);
});
