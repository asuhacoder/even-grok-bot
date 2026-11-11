// Drives the Even Hub simulator's automation API and saves glasses screenshots.
// usage: node g2/sim/drive.mjs <outDir> <step>...
//   step: up | down | click | double_click | long_press | context_menu | wait:<ms> | shot:<name> | console
import { mkdirSync, writeFileSync } from 'node:fs';

const API = process.env.SIM_API ?? 'http://127.0.0.1:9898';
const [outDir, ...steps] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(`${API}/api/ping`)).ok) break;
  } catch {}
  await new Promise(r => setTimeout(r, 500));
}

let consoleId = 0;
for (const s of steps) {
  if (s.startsWith('wait:')) await new Promise(r => setTimeout(r, Number(s.slice(5))));
  else if (s.startsWith('shot:')) {
    const png = Buffer.from(await (await fetch(`${API}/api/screenshot/glasses`)).arrayBuffer());
    writeFileSync(`${outDir}/${s.slice(5)}.png`, png);
    console.log(`shot ${s.slice(5)}`);
  } else if (s === 'console') {
    const logs = await (await fetch(`${API}/api/console?since_id=${consoleId}`)).json();
    const entries = Array.isArray(logs) ? logs : (logs.entries ?? logs.logs ?? []);
    for (const e of entries) {
      consoleId = Math.max(consoleId, e.id ?? 0);
      console.log('console', JSON.stringify(e).slice(0, 300));
    }
  } else {
    const r = await fetch(`${API}/api/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: s }),
    });
    console.log(`input ${s} -> ${r.status}`);
    await new Promise(r => setTimeout(r, 700));
  }
}
