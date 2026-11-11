// End-to-end check of the spec's nine thought-experiment flows on the real G2 app
// running in the Even Hub simulator, against a mock relay (no Grok Bot involved).
//
// usage: node g2/sim/flows.mjs   (expects vite on 5174 with VITE_RELAY_URLS=ws://127.0.0.1:8809/ws
//                                  VITE_RELAY_TOKEN=test, and the simulator with --automation-port 9898)
import { WebSocketServer } from 'ws';

const API = process.env.SIM_API ?? 'http://127.0.0.1:9898';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const health = { relay: 'ok', grok: 'ok', asr: 'ok', detail: '' };
const now = Date.now();
const bots = [
  { id: 'a', name: '承認Bot', status: 'idle', preview: '準備中', activityAt: 3 },
  { id: 'b', name: '質問Bot', status: 'idle', preview: '準備中', activityAt: 2 },
  { id: 'c', name: '作業Bot', status: 'idle', preview: '作業中です', activityAt: 1 },
];
const text = (id, author, t) => ({ kind: 'text', id, at: now, author, from: '', text: t });
const approval = { kind: 'approval', id: 'p1', at: now, summary: 'Slackの#generalに報告を投稿する', reason: '作業完了の報告のため', state: 'pending' };
const question = { kind: 'question', id: 'q1', at: now, prompt: 'どちらで進めますか？', options: [{ label: '案A', value: '案Aで進めて' }, { label: '案B', value: '案Bで進めて' }], state: 'pending' };
const state = {
  a: { entries: [text('a1', 'bot', '投稿の許可をください'), approval], pending: { kind: 'approval', entryId: 'p1' } },
  b: { entries: [text('b1', 'bot', '方針を決めてください'), question], pending: { kind: 'question', entryId: 'q1' } },
  c: { entries: [text('c1', 'me', '進捗を教えて'), text('c2', 'bot', '作業中です。'.repeat(40)), text('c3', 'bot', '完了しました')], pending: null },
};
const received = [];
let client = null;
const send = m => client?.send(JSON.stringify(m));
const conv = id => ({
  type: 'conversation',
  conversation: { botId: id, botName: bots.find(b => b.id === id).name, entries: state[id].entries, firstUnreadId: null, running: id === 'c', hasOlder: false, pending: state[id].pending, canStop: id === 'c' },
});
const notice = (botId, kind) => send({ type: 'notice', notice: { id: `${botId}:${Date.now()}`, botId, botName: bots.find(b => b.id === botId).name, kind, text: `${kind} の通知`, at: Date.now() } });
const resetCards = () => {
  state.a.pending = { kind: 'approval', entryId: 'p1' };
  state.a.entries[1] = { ...approval };
  state.b.pending = { kind: 'question', entryId: 'q1' };
  state.b.entries[1] = { ...question };
};

const wss = new WebSocketServer({ host: '127.0.0.1', port: Number(process.env.MOCK_PORT ?? 8809), path: '/ws' });
wss.on('connection', ws => {
  ws.on('message', (data, binary) => {
    if (binary) return;
    const m = JSON.parse(String(data));
    if (m.type !== 'read') received.push(m);
    if (m.type === 'hello') {
      client = ws;
      send({ type: 'welcome', bots, health });
    } else if (m.type === 'open') send(conv(m.botId));
    else if (m.type === 'audio-end') send({ type: 'transcript', reqId: m.reqId, text: 'テストの指示です' });
    else if (m.type === 'approve' || m.type === 'answer') {
      const id = m.botId;
      state[id].pending = null;
      send({ type: 'result', reqId: m.reqId, ok: true, message: '完了' });
      send(conv(id));
    } else if (m.type === 'send' || m.type === 'stop') send({ type: 'result', reqId: m.reqId, ok: true, message: '完了' });
  });
});

let consoleId = 0;
const screens = [];
const sends = [];
async function pollConsole() {
  const res = await (await fetch(`${API}/api/console?since_id=${consoleId}`)).json();
  const entries = Array.isArray(res) ? res : (res.entries ?? res.logs ?? []);
  for (const e of entries) {
    consoleId = Math.max(consoleId, e.id ?? 0);
    const msg = String(e.message);
    const s = /^\[screen\] (.+)$/.exec(msg);
    if (s) screens.push(s[1]);
    const t = /^\[send\] (.+)$/.exec(msg);
    if (t) sends.push(t[1]);
  }
}
async function input(action) {
  await fetch(`${API}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
  await sleep(900);
  await pollConsole();
}
const top = () => screens.at(-1);

const results = [];
async function flow(name, fn) {
  const mark = { s: screens.length, r: received.length };
  let ok = true;
  let why = '';
  try {
    await fn({
      expect(cond, msg) {
        if (!cond && ok) {
          ok = false;
          why = msg;
        }
      },
      since: () => ({ screens: screens.slice(mark.s), received: received.slice(mark.r) }),
    });
  } catch (e) {
    ok = false;
    why = String(e);
  }
  results.push({ name, ok, why, screens: screens.slice(mark.s).join(' > ') });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${why}`}\n     ${screens.slice(mark.s).join(' > ')}`);
  // Back to the root Bot list between flows (a double tap there would open the exit dialog).
  for (let i = 0; i < 6 && top() !== 'list'; i++) await input('double_click');
  resetCards();
}

for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(`${API}/api/ping`)).ok) break;
  } catch {}
  await sleep(500);
}
await fetch(`${API}/api/console`, { method: 'DELETE' });
await fetch(`${API}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'click' }) }).catch(() => {});
// The app reloads on simulator start; wait for its connection.
for (let i = 0; i < 40 && !client; i++) await sleep(500);
if (!client) throw new Error('G2 app never connected to the mock relay');
await sleep(1000);
await pollConsole();
for (let i = 0; i < 6 && top() !== 'list'; i++) await input('double_click');
if (top() !== 'list') screens.push('list');

const lastOf = (rx, type) => rx.filter(m => m.type === type).at(-1);

await flow('1 作業完了: 通知→会話→スクロール→一覧', async ({ expect }) => {
  notice('c', 'done');
  await sleep(900);
  await pollConsole();
  expect(top() === 'notice', `通知が出ない (${top()})`);
  await input('click');
  expect(top() === 'conversation', `会話が開かない (${top()})`);
  await input('down');
  await input('double_click');
  expect(top() === 'list', `一覧に戻らない (${top()})`);
});

await flow('2 承認依頼: 通知→承認内容→一回だけ許可', async ({ expect, since }) => {
  notice('a', 'needs-action');
  await sleep(900);
  await pollConsole();
  await input('click');
  await sleep(500);
  await pollConsole();
  expect(top() === 'approval', `承認画面が開かない (${top()})`);
  await input('down');
  await input('click');
  const m = lastOf(since().received, 'approve');
  expect(m?.choice === 'once', `once が送られない (${JSON.stringify(m)})`);
  expect(top() === 'conversation', `会話に戻らない (${top()})`);
});

await flow('3 常に許可: 確認画面→戻る→確定', async ({ expect, since }) => {
  notice('a', 'needs-action');
  await sleep(900);
  await pollConsole();
  await input('click');
  await sleep(500);
  await input('down');
  await input('down');
  await input('down');
  await input('click');
  expect(top() === 'always-confirm', `確認画面が出ない (${top()})`);
  await input('double_click');
  expect(top() === 'approval', `承認画面に戻らない (${top()})`);
  expect(!lastOf(since().received, 'approve'), '確認前に承認が送られた');
  await input('down');
  await input('down');
  await input('click');
  await input('click');
  const m = lastOf(since().received, 'approve');
  expect(m?.choice === 'always', `always が送られない (${JSON.stringify(m)})`);
});

await flow('4 音声で指示: 一覧→会話→録音→確認→送信', async ({ expect, since }) => {
  expect(top() === 'list', `一覧から始まらない (${top()})`);
  await input('down');
  await input('down');
  await input('click');
  expect(top() === 'conversation', `会話が開かない (${top()})`);
  const opened = lastOf(since().received, 'open');
  expect(opened?.botId === 'c', `作業Bot以外が開いた (${JSON.stringify(opened)})`);
  await input('click');
  expect(top() === 'recording', `録音にならない (${top()})`);
  await sleep(1000);
  await input('click');
  await sleep(500);
  await pollConsole();
  expect(top() === 'confirm', `送信確認にならない (${top()})`);
  await input('click');
  const m = lastOf(since().received, 'send');
  expect(m?.text === 'テストの指示です' && m?.botId === 'c', `送信内容が違う (${JSON.stringify(m)})`);
  expect(top() === 'conversation', `会話に戻らない (${top()})`);
});

await flow('5 選択肢の質問: 通知→質問内容→案Bで回答', async ({ expect, since }) => {
  notice('b', 'needs-action');
  await sleep(900);
  await pollConsole();
  await input('click');
  await sleep(500);
  await pollConsole();
  expect(top() === 'question', `質問画面が開かない (${top()})`);
  await input('click');
  await input('down');
  await input('click');
  const m = lastOf(since().received, 'answer');
  expect(m?.value === '案Bで進めて', `回答が違う (${JSON.stringify(m)})`);
});

await flow('6 作業中のBotを止める: 会話→長押しメニュー→停止', async ({ expect, since }) => {
  await input('down');
  await input('down');
  await input('click');
  await input('context_menu');
  await input('click');
  const m = lastOf(since().received, 'stop');
  expect(m?.botId === 'c', `停止が送られない (${JSON.stringify(m)})`);
  expect(top() === 'conversation', `会話から外れた (${top()})`);
});

await flow('7 読書中の別Bot通知: 画面は変わらない→一覧へ', async ({ expect }) => {
  await input('down');
  await input('down');
  await input('click');
  notice('a', 'needs-action');
  await sleep(900);
  await pollConsole();
  expect(top() === 'conversation', `通知が画面を奪った (${top()})`);
  await input('double_click');
  expect(top() === 'list', `一覧に戻らない (${top()})`);
});

await flow('8 起動画面はBot一覧: スワイプでは何も送らない', async ({ expect, since }) => {
  expect(top() === 'list', `一覧ではない (${top()})`);
  await input('down');
  await input('up');
  const acts = since().received.filter(m => m.type !== 'hello');
  expect(acts.length === 0, `何か送られた (${JSON.stringify(acts)})`);
  expect(top() === 'list', `一覧から外れた (${top()})`);
});

await flow('9 録音中の通知: 録音を優先し、送信後に通知', async ({ expect }) => {
  await input('down');
  await input('down');
  await input('click');
  await input('click');
  expect(top() === 'recording', `録音にならない (${top()})`);
  notice('b', 'message');
  await sleep(900);
  await pollConsole();
  expect(top() === 'recording', `通知が録音を奪った (${top()})`);
  await input('click');
  await sleep(500);
  await pollConsole();
  expect(top() === 'confirm', `送信確認にならない (${top()})`);
  await input('click');
  await input('double_click');
  expect(top() === 'notice', `送信後に通知が出ない (${top()})`);
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} flows passed`);
wss.close();
process.exit(failed.length ? 1 : 0);
