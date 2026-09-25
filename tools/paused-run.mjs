// 排版輪 並排驗收資料：在資料副本裡用假宿主（不叫 AI）跑出一筆「停在停點」的執行紀錄，給 12 執行頁量測用。
// 用法：node bojian/tools/paused-run.mjs --data <資料副本> [--wf 範例/quarterly-report]
// 印出 run 路徑。絕不寫 bojian/data。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  return o;
}
const a = args(process.argv.slice(2));
if (!a.data) { console.error('要 --data <資料副本>'); process.exit(2); }
const dataDir = path.resolve(a.data);
if (dataDir.toLowerCase().startsWith(path.resolve(HERE, '..', 'data').toLowerCase())) { console.error('不准寫 bojian/data'); process.exit(2); }
if (!fs.existsSync(dataDir)) { console.error(`${dataDir} 不存在`); process.exit(2); }
const [cat, wid] = String(a.wf ?? '範例/quarterly-report').split('/');

// 假宿主：每步回固定產出、健檢一律可用、查核與其他補全回空字串（＝沒意見）
const adapter = {
  async complete() { return ''; },
  async checkAvailable() { return true; },
  async executeNode({ nodeId }) { return `（假宿主產出）${nodeId}：這是並排驗收用的示範產出，內容不是 AI 寫的。`; },
};
const app = createApp({ dataDir, adapter });
await app.start(0, { tickMs: 24 * 3600_000 });
const base = `http://127.0.0.1:${app.port()}`;
const wfPath = `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(wid)}`;
try {
  const res = await fetch(`${base}${wfPath}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const started = await res.json();
  if (!res.ok) throw new Error(`開跑失敗 ${res.status} ${JSON.stringify(started)}`);
  let run = null;
  for (let i = 0; i < 300 && run?.status !== 'paused'; i++) {
    await new Promise((r) => setTimeout(r, 50));
    run = await (await fetch(`${base}${wfPath}/runs/${started.run_id}`)).json();
  }
  if (run?.status !== 'paused') throw new Error(`等不到停點，最後狀態 ${run?.status}`);
  const waiting = Object.entries(run.steps).filter(([, s]) => /^waiting/.test(s.status)).map(([k, s]) => `${k}:${s.status}`);
  console.log(JSON.stringify({ run_id: started.run_id, status: run.status, waiting, dir: path.join(dataDir, 'workflows', cat, wid, 'runs', started.run_id) }));
} finally {
  await app.stop();
}
