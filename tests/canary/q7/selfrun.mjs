// 獨立跑手（給題目工人自驗用；框架 run.mjs 接好 drive 之後可以不用它）
//   node tests/canary/q7/selfrun.mjs --q q7 --port 8796 --data <分身的 BOJIAN_DATA_DIR> [--out <結果夾>]
//   --q 可給 q6 或 q7（q6 的模組在 ../q6/question.mjs）。分身要先自己起：
//   BOJIAN_PORT=8796 BOJIAN_DATA_DIR=<%TEMP% 新資料夾> node src/server.js
// 流程：generate → POST /workflows＋上傳檔 → POST /runs → 題目的 drive → 收 steps／prompts／finalText → 題目的 score → 印 JSON
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const Q = opt('--q', 'q7');
const PORT = Number(opt('--port', 8796));
const DATA = opt('--data', null);
// 結果預設寫到 %TEMP%（不碰 tests/canary/results，那是框架跑手的）
const OUT = opt('--out', path.join(os.tmpdir(), `canary-selfrun-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`));
if (PORT === 8787) throw new Error('不准打 8787（正式的那份）');

const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = txt; }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${typeof j === 'string' ? j : JSON.stringify(j)}`);
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mod = await import(`../${Q}/question.mjs`);
  const settings = await api('GET', '/settings');
  // 檔案路徑一律用分身自己回報的 data_dir（多組織時是 <root>/orgs/<org>/，跟 --data 給的根不同層）；--data 只拿來擋錯打正式資料
  const dataDir = settings.data_dir ?? DATA;
  if (!dataDir) throw new Error('要給 --data（分身的資料夾），或分身要回 data_dir');
  const forbidden = path.resolve(HERE, '..', '..', '..', 'data').toLowerCase();
  for (const d of [dataDir, DATA].filter(Boolean)) {
    if (path.resolve(d).toLowerCase().startsWith(forbidden)) throw new Error('不准動 bojian/data');
  }
  fs.mkdirSync(OUT, { recursive: true });
  const log = (m) => console.log(`[${Q}] ${m}`);

  // 1. 造資料
  const genDir = fs.mkdtempSync(path.join(os.tmpdir(), `canary-${Q}-`));
  const { files, truth } = await mod.generate(genDir);
  log(`資料 ${files.map((f) => f.name).join(', ')} → ${genDir}`);

  // 2. 建流程＋上傳
  const cat = '金絲雀';
  const def = mod.flowDef({ files, truth });
  const { id } = await api('POST', '/workflows', { category: cat, def });
  for (const f of files) {
    await api('POST', `/workflows/${encodeURIComponent(cat)}/${id}/files`, { name: f.name, content_b64: fs.readFileSync(f.path).toString('base64') });
  }
  const base = `/workflows/${encodeURIComponent(cat)}/${id}/runs`;
  log(`流程 ${cat}/${id}`);

  // 3. 開跑＋駕駛
  const t0 = Date.now();
  const run = await api('POST', base, {});
  const rid = run.run_id;
  log(`開跑 ${rid}`);
  const driven = typeof mod.drive === 'function'
    ? await mod.drive({ api, base, rid, poll: 3000, log })
    : await defaultDrive({ api, base, rid, mod, log });
  const ms = Date.now() - t0;
  await sleep(2000);

  // 4. 收結果
  const final = await api('GET', `${base}/${rid}`);
  const steps = Object.fromEntries(Object.entries(final.steps ?? {}).map(([k, s]) => [k, { status: s.status, output: s.edited_output ?? s.output ?? null, check: s.check ?? null }]));
  const promptDir = path.join(dataDir, 'workflows', cat, id, 'runs', rid, 'prompts');
  const prompts = fs.existsSync(promptDir) ? fs.readdirSync(promptDir).sort().map((n) => ({ name: n, path: path.join(promptDir, n) })) : [];
  const outDir = path.join(dataDir, 'workflows', cat, id, 'runs', rid, 'out');
  const artifacts = fs.existsSync(outDir) ? fs.readdirSync(outDir).map((n) => ({ name: n, path: path.join(outDir, n) })) : [];
  const lastNode = [...def.nodes].reverse().find((n) => (n.kind ?? 'task') === 'task' && steps[n.id]?.status === 'done');
  const finalText = lastNode ? String(steps[lastNode.id].output ?? '') : '';

  // 5. 評分
  const scored = await mod.score({ arm: 'bojian', finalText, artifacts, steps, prompts, truth, runDir: OUT });
  const result = { q: Q, arm: 'bojian', rep: 1, workflow: `${cat}/${id}`, run_id: rid, ms, status: final.status, interventions: driven?.interventions ?? [], drive: driven?.[Q] ?? null, score: scored };
  fs.writeFileSync(path.join(OUT, `${Q}-bojian-1.json`), JSON.stringify(result, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, `${Q}-bojian-1.md`), finalText, 'utf8');
  console.log(JSON.stringify({ q: Q, run_id: rid, status: final.status, ms, score: scored }, null, 2));
  console.log(`結果 → ${OUT}`);
}

// 契約裡的預設駕駛（題目沒給 drive 時用）
async function defaultDrive({ api, base, rid, mod, log }) {
  const interventions = [];
  const t0 = Date.now();
  for (;;) {
    await sleep(3000);
    const r = await api('GET', `${base}/${rid}`);
    if (r.status === 'done') break;
    if (Date.now() - t0 > 40 * 60e3) { interventions.push({ kind: 'timeout' }); break; }
    for (const [nid, s] of Object.entries(r.steps ?? {})) {
      let act = null; let body = { node: nid };
      if (s.status === 'waiting_check') act = 'check-accept';
      else if (s.status === 'waiting_data') act = 'data-accept';
      else if (s.status === 'waiting_review') act = 'approve';
      else if (s.status === 'waiting_human') { act = 'human-done'; body = { node: nid, content: mod.humanContent?.(nid) ?? '' }; }
      else if (s.status === 'failed') act = 'retry';
      if (!act) continue;
      if (act === 'retry' && interventions.filter((x) => x.node === nid && x.act === 'retry').length >= 2) return { interventions: [...interventions, { node: nid, act: 'give-up' }] };
      interventions.push({ node: nid, act, status: s.status });
      log(`${nid} ${s.status} → ${act}`);
      await api('POST', `${base}/${rid}/${act}`, body);
    }
  }
  return { interventions };
}

main().catch((e) => { console.error(e); process.exit(1); });
