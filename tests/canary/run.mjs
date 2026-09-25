// 金絲雀跑手：起分身、建流程、兩邊各跑、收結果、叫 score.mjs 產 summary.md（介面見 CONTRACT.md）
//   node tests/canary/run.mjs [--q q1,q2] [--arms bojian,cc] [--reps 1] [--model sonnet] [--parallel 3] [--port 8797] [--data <dir>] [--timeout 45] [--force]
// 沒給 --port 就自己起一份分身（BOJIAN_PORT＋BOJIAN_DATA_DIR 指到 %TEMP% 新資料夾），跑完關掉；不准打 8787、不准動 bojian/data。
// 給了 --port（接既有分身）：先比分身行程的啟動時間與 bojian/src 最新改動——分身比程式舊就停（跑舊碼），帶 --force 才照跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeApi } from './lib/api.mjs';
import { spawnServer, NODE_MODULES, BOJIAN_ROOT } from './lib/server.mjs';
import { runClaude } from './lib/claude.mjs';
import { tokOf, weighted, usageOfRun } from './lib/usage.mjs';
import { scoreDir } from './score.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };

const ALL_Q = fs.readdirSync(HERE).filter((d) => /^q\d+$/.test(d)).sort();
const Q = (opt('--q', ALL_Q.join(',')) || '').split(',').map((s) => s.trim()).filter(Boolean);
const ARMS = (opt('--arms', 'bojian,cc') || '').split(',').map((s) => s.trim()).filter(Boolean);
const REPS = Number(opt('--reps', 1));
const MODEL = opt('--model', 'sonnet');
const PARALLEL = Number(opt('--parallel', 3));
const PORT = opt('--port', null);
const DATA_ROOT = opt('--data', null);
const TIMEOUT_MS = Number(opt('--timeout', 45)) * 60e3;
const FORCE = args.includes('--force'); // 分身比程式舊仍照跑
const POLL_MS = 3000;

const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toTimeString().slice(0, 8); // 本地時間，與結果夾名同一個時區
const log = (...xs) => console.log(`[${ts()}]`, ...xs);

const RES_DIR = path.join(HERE, 'results', stamp());
fs.mkdirSync(RES_DIR, { recursive: true });
const dataRoot = DATA_ROOT ? path.resolve(DATA_ROOT) : fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-canary-'));

// ---- 接既有分身前的新舊比對（L081）：分身是改碼前起的＝跑舊碼（09-24 白燒 3 趟）。
// 分身沒有回報自己的啟動時間（/api/health 不帶），所以從作業系統拿：埠 → 監聽的 pid → 行程啟動時間；拿不到就印一行提醒、照跑（不猜）。
function listeningPid(port) {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true }).stdout || '';
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
        if (m && Number(m[1]) === Number(port)) return Number(m[2]);
      }
      return null;
    }
    const out = spawnSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || '';
    const pid = Number(out.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}
function processStartedAt(pid) {
  try {
    const out = process.platform === 'win32'
      ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')`], { encoding: 'utf8', windowsHide: true }).stdout || ''
      : spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout || '';
    const d = new Date(out.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}
function newestSrcFile(dir = path.join(BOJIAN_ROOT, 'src')) {
  let best = null;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else { const { mtime } = fs.statSync(p); if (!best || mtime > best.mtime) best = { file: p, mtime }; }
    }
  };
  walk(dir);
  return best;
}
function checkReplicaFreshness(port) {
  const pid = listeningPid(port);
  const started = pid ? processStartedAt(pid) : null;
  if (!started) { log(`⚠ 拿不到 ${port} 埠分身的啟動時間（pid ${pid ?? '找不到'}），沒法比對程式新舊——請自己確認分身是改碼後才起的`); return; }
  const newest = newestSrcFile();
  const fmt = (d) => d.toLocaleString('sv-SE'); // 本地時間 YYYY-MM-DD HH:mm:ss
  if (newest && newest.mtime > started) {
    console.error([
      '',
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      `!!  分身比程式舊：${port} 埠的分身（pid ${pid}）是 ${fmt(started)} 起的，`,
      `!!  但 bojian/src 最新改動在 ${fmt(newest.mtime)}（${path.relative(BOJIAN_ROOT, newest.file)}）。`,
      '!!  接著跑＝跑舊碼（09-24 白燒 3 趟）。把分身重起再來；真的要照跑就帶 --force。',
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      '',
    ].join('\n'));
    if (!FORCE) { try { fs.rmdirSync(RES_DIR); } catch { /* 非空就留 */ } process.exit(2); }
    log('--force：照跑（結果代表的是舊碼）');
    return;
  }
  log(`分身 pid ${pid} 起於 ${fmt(started)}，晚於 bojian/src 最新改動（${fmt(newest.mtime)}），程式一致`);
}

// ---- 載題：缺的題目印一行跳過，不炸 ----
async function loadQuestions() {
  const out = [];
  for (const q of Q) {
    const file = path.join(HERE, q, 'question.mjs');
    if (!fs.existsSync(file)) { log(`${q}：還沒有 question.mjs，跳過`); continue; }
    try {
      const mod = await import(pathToFileURL(file).href);
      for (const k of ['id', 'kind', 'generate', 'flowDef', 'score']) if (mod[k] === undefined) throw new Error(`缺 export ${k}`);
      if (mod.kind === 'compare' && typeof mod.ccPrompt !== 'function') throw new Error('compare 題缺 ccPrompt');
      out.push(mod);
    } catch (e) { log(`${q}：載入失敗，跳過——${e.message}`); }
  }
  return out;
}

// ---- 並行上限 ----
async function pmap(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) { const k = i++; if (k >= items.length) return; results[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return results;
}

const save = (name, obj, text) => {
  fs.writeFileSync(path.join(RES_DIR, `${name}.json`), JSON.stringify(obj, null, 2));
  fs.writeFileSync(path.join(RES_DIR, `${name}.md`), text ?? '');
};
const filesDirFor = (name) => { const d = path.join(RES_DIR, 'files', name); fs.mkdirSync(d, { recursive: true }); return d; };

// ---- 預設駕駛（CONTRACT）：waiting_check→check-accept、waiting_data→data-accept、failed→retry ≤2、waiting_human→human-done、停點→approve ----
async function defaultDrive({ api, wf, rid, question, log: qlog, deadline }) {
  const interventions = [];
  let r;
  for (;;) {
    await sleep(POLL_MS);
    r = await api.getRun(wf, rid);
    if (r.status === 'done') break;
    if (Date.now() > deadline) { interventions.push({ kind: 'timeout' }); r.status = 'timeout'; break; }
    let gaveUp = false;
    for (const [nid, s] of Object.entries(r.steps ?? {})) {
      let act = null; let body = { node: nid };
      switch (s.status) {
        case 'waiting_check': act = 'check-accept'; break;
        case 'waiting_data': act = 'data-accept'; break;
        case 'waiting_review': act = 'approve'; break;
        case 'waiting_human': act = 'human-done'; body = { node: nid, content: question.humanContent?.(nid) ?? '' }; break;
        case 'waiting_time': case 'time_pending': act = 'resume-time'; body = { node: nid, at: null }; break;
        case 'waiting_branch': {
          const node = (r.def?.nodes ?? []).find((n) => n.id === nid);
          const target = node?.branches?.[0]?.next;
          if (target) { act = 'choose-branch'; body = { node: nid, target }; }
          break;
        }
        case 'failed': {
          const retries = interventions.filter((x) => x.node === nid && x.act === 'retry').length;
          if (retries >= 2) { interventions.push({ node: nid, act: 'give-up', error: s.error ?? null }); gaveUp = true; }
          else act = 'retry';
          break;
        }
        default: break;
      }
      if (gaveUp) break;
      if (!act) continue;
      interventions.push({ node: nid, act, status: s.status, error: s.error ?? null, check: s.check ? { status: s.check.status, blocks: s.check.blocks, missing: s.check.missing } : null });
      qlog(`${nid} ${s.status} → ${act}`);
      try { await api.act(wf, rid, act, body); } catch (e) { qlog(`動作 ${act} 失敗：${e.message}`); interventions.push({ node: nid, act: `${act}-failed`, error: e.message }); }
    }
    if (gaveUp) { r.status = 'gave_up'; break; }
  }
  return { run: r, interventions };
}

// 終點步驟（沒有出邊的 task）的有效產出＝最終文字成品；多個終點就接起來
function finalTextOf(run) {
  const nodes = run.def?.nodes ?? [];
  const outgoing = (n) => (n.kind === 'branch' ? (n.branches ?? []).map((b) => b.next) : (n.next ?? []));
  const terminals = nodes.filter((n) => (n.kind ?? 'task') === 'task' && outgoing(n).length === 0);
  const texts = terminals.map((n) => run.steps?.[n.id]).filter(Boolean).map((s) => s.edited_output ?? s.output ?? '').filter(Boolean);
  return texts.join('\n\n---\n\n');
}

// ---- 剝繭那一邊 ----
async function armBojian({ api, dataDir, wf, question, gen, rep, qlog }) {
  const name = `${question.id}-bojian-${rep}`;
  const t0 = Date.now();
  const deadline = t0 + TIMEOUT_MS;
  const run0 = await api.startRun(wf, {});
  const rid = run0.run_id;
  qlog(`開跑 ${rid}`);
  const driver = typeof question.drive === 'function' ? question.drive : null;
  let run; let interventions = []; let driveRes = null;
  if (driver) {
    const res = await driver({ api: api.api, apiClient: api, base: `${wf.base}/runs`, wf, rid, poll: () => api.getRun(wf, rid), log: qlog, deadline, defaultDrive: () => defaultDrive({ api, wf, rid, question, log: qlog, deadline }) });
    driveRes = res ?? null;
    interventions = res?.interventions ?? [];
    run = res?.run ?? await api.getRun(wf, rid);
  } else {
    ({ run, interventions } = await defaultDrive({ api, wf, rid, question, log: qlog, deadline }));
  }
  const ms = Date.now() - t0;
  // 收尾類呼叫（總覽）晚一點才入帳：等 run.overview 出現（≤90 秒）再結算
  if (run.status === 'done') {
    for (let i = 0; i < 30; i++) {
      const again = await api.getRun(wf, rid);
      if (again.overview !== undefined) { run = again; break; }
      await sleep(3000);
    }
  }
  const usage = usageOfRun(dataDir, rid);
  const finalText = finalTextOf(run);
  // 產出檔與卷宗落到 results/<ts>/files/<name>/
  const fdir = filesDirFor(name);
  const artifacts = [];
  try {
    for (const f of await api.listFiles(wf, rid)) {
      const dest = path.join(fdir, f);
      await api.downloadFile(wf, rid, f, dest);
      artifacts.push({ name: f, path: dest });
    }
  } catch (e) { qlog(`抓產出檔失敗：${e.message}`); }
  const prompts = [];
  try {
    for (const p of await api.listPrompts(wf, rid)) {
      const pname = typeof p === 'string' ? p : p.name;
      const { text } = await api.readPrompt(wf, rid, pname);
      const dest = path.join(fdir, 'prompts', pname);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text ?? '', 'utf8');
      prompts.push({ name: pname, path: dest });
    }
  } catch (e) { qlog(`抓卷宗失敗：${e.message}`); }
  const steps = Object.fromEntries(Object.entries(run.steps ?? {}).map(([k, s]) => [k, { status: s.status, output: s.edited_output ?? s.output ?? null, check: s.check ?? null, file: s.file ?? null, error: s.error ?? null }]));
  let score;
  try { score = await question.score({ arm: 'bojian', finalText, artifacts, steps, prompts, truth: gen.truth, runDir: fdir, drive: driveRes ?? { interventions }, runStatus: run?.status ?? null }); }
  catch (e) { score = { pass: false, metrics: {}, misses: [], notes: [`計分炸了：${e.message}`] }; }
  const res = {
    q: question.id, title: question.title, kind: question.kind, arm: 'bojian', rep, run_id: rid, ms, status: run.status,
    tokens: usage.tokens, weighted: weighted(usage.tokens), calls: usage.calls, by_kind: usage.by_kind, models: usage.models,
    // output 也存：多步成品（如 q2 的信＋待辦）--rescore 才重算得出來；check 整份存（含 first_blocks／recheck_blocks）：q10 誤攔率題從這裡計分
    interventions, steps: Object.fromEntries(Object.entries(steps).map(([k, s]) => [k, { status: s.status, file: s.file, error: s.error, output: s.output ?? null, check: s.check ?? null }])),
    artifacts: artifacts.map((a) => a.name), score,
  };
  save(name, res, finalText);
  qlog(`剝繭 完成：${run.status}，${Math.round(ms / 1000)} 秒，用量 ${res.weighted}，pass=${score.pass}`);
  return res;
}

// ---- Claude Code 那一邊 ----
async function armCC({ question, gen, rep, qlog }) {
  const name = `${question.id}-cc-${rep}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `bojian-canary-cc-${question.id}-`));
  const inputNames = new Set();
  for (const f of gen.files) { fs.copyFileSync(f.path, path.join(cwd, f.name)); inputNames.add(f.name); }
  const prompt = question.ccPrompt({ files: gen.files, truth: gen.truth });
  const fdir = filesDirFor(name);
  fs.mkdirSync(path.join(fdir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(fdir, 'prompts', 'cc.txt'), prompt, 'utf8');
  qlog('Claude Code 開跑');
  const t0 = Date.now();
  const r = await runClaude({ cwd, prompt, model: MODEL, env: { NODE_PATH: NODE_MODULES }, timeoutMs: TIMEOUT_MS });
  const ms = Date.now() - t0;
  const j = r.json;
  const reportName = question.ccReportName ?? 'report.md';
  const reportPath = path.join(cwd, reportName);
  const finalText = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : (j?.result ?? '');
  // 產出檔＝cwd 裡除了輸入檔以外的東西（含 report.md），複製進結果夾
  const artifacts = [];
  for (const f of fs.readdirSync(cwd)) {
    if (inputNames.has(f)) continue;
    const src = path.join(cwd, f);
    if (!fs.statSync(src).isFile()) continue;
    const dest = path.join(fdir, f);
    fs.copyFileSync(src, dest);
    artifacts.push({ name: f, path: dest });
  }
  const tokens = tokOf(j?.usage);
  const ok = r.code === 0 && !!j && !j.is_error && !r.timedOut;
  const steps = { cc: { status: ok ? 'done' : 'failed', output: j?.result ?? null, check: null } };
  let score;
  try { score = await question.score({ arm: 'cc', finalText, artifacts, steps, prompts: [{ name: 'cc.txt', path: path.join(fdir, 'prompts', 'cc.txt') }], truth: gen.truth, runDir: fdir }); }
  catch (e) { score = { pass: false, metrics: {}, misses: [], notes: [`計分炸了：${e.message}`] }; }
  const res = {
    q: question.id, title: question.title, kind: question.kind, arm: 'cc', rep, ms, status: r.timedOut ? 'timeout' : (ok ? 'done' : 'failed'),
    tokens, weighted: weighted(tokens), calls: 1, turns: j?.num_turns ?? null, model_usage: j?.modelUsage ?? null, model: MODEL,
    interventions: [], report_from: fs.existsSync(reportPath) ? reportName : 'result 欄', cwd, artifacts: artifacts.map((a) => a.name), score,
    ...(j ? {} : { raw: r.out.slice(0, 2000), stderr: r.err.slice(0, 2000) }),
  };
  save(name, res, finalText);
  qlog(`Claude Code 完成：${res.status}，${Math.round(ms / 1000)} 秒，用量 ${res.weighted}，pass=${score.pass}`);
  return res;
}

// ---- 一題 ----
async function runQuestion(question, { api, dataDir }) {
  const qlog = (...xs) => log(`[${question.id}]`, ...xs);
  const qData = path.join(dataRoot, question.id);
  let gen;
  try { gen = await question.generate(qData); } catch (e) { qlog(`造資料失敗：${e.message}`); return []; }
  qlog(`資料：${gen.files.map((f) => f.name).join('、')}`);
  const arms = question.kind === 'structural' ? ARMS.filter((a) => a === 'bojian') : ARMS;
  const jobs = [];
  let wf = null;
  if (arms.includes('bojian')) {
    try {
      const def = question.flowDef({ files: gen.files, truth: gen.truth });
      wf = await api.createWorkflow(`金絲雀-${question.id}`, def);
      for (const f of gen.files) await api.uploadFile(wf, f.name, f.path);
      qlog(`流程 ${wf.id}`);
    } catch (e) { qlog(`建流程失敗：${e.message}`); wf = null; }
  }
  for (let rep = 1; rep <= REPS; rep++) {
    if (wf) jobs.push(() => armBojian({ api, dataDir, wf, question, gen, rep, qlog }).catch((e) => { qlog(`剝繭 第 ${rep} 趟炸了：${e.message}`); return null; }));
    if (arms.includes('cc')) jobs.push(() => armCC({ question, gen, rep, qlog }).catch((e) => { qlog(`Claude Code 第 ${rep} 趟炸了：${e.message}`); return null; }));
  }
  // 同題兩邊並行（每趟兩邊一起）
  const out = await pmap(jobs, 2, (job) => job());
  return out.filter(Boolean);
}

async function main() {
  // 接既有分身：先比新舊再做任何事（比程式舊＝停；--force 照跑）
  if (PORT && ARMS.includes('bojian')) checkReplicaFreshness(Number(PORT));
  const questions = await loadQuestions();
  if (!questions.length) { log('沒有可跑的題目'); process.exit(1); }
  log(`題目：${questions.map((q) => q.id).join('、')}；邊：${ARMS.join('、')}；趟數 ${REPS}；模型 ${MODEL}；並行 ${PARALLEL}；結果 → ${RES_DIR}`);
  let server = null; let port = PORT ? Number(PORT) : null; let dataDir = DATA_ROOT;
  const needBojian = ARMS.includes('bojian');
  if (needBojian) {
    if (port === 8787) throw new Error('不准打 8787（正式台）');
    if (!port) {
      server = await spawnServer({ log });
      port = server.port; dataDir = server.dataDir;
    } else if (!dataDir) {
      throw new Error('給了 --port 就要一起給 --data <那份分身的資料根>（用量從它的 usage.jsonl 讀）');
    }
  }
  const api = needBojian ? makeApi(port) : null;
  const t0 = Date.now();
  try {
    await pmap(questions, PARALLEL, (q) => runQuestion(q, { api, dataDir }));
  } finally {
    if (server) { server.kill(); log('分身已關'); }
  }
  log(`全部跑完，${Math.round((Date.now() - t0) / 60000 * 10) / 10} 分鐘；計分…`);
  fs.writeFileSync(path.join(RES_DIR, 'run-info.json'), JSON.stringify({ questions: questions.map((q) => q.id), arms: ARMS, reps: REPS, model: MODEL, parallel: PARALLEL, port, dataDir, dataRoot, started: new Date(t0).toISOString(), minutes: Math.round((Date.now() - t0) / 6000) / 10 }, null, 2));
  const { md } = scoreDir(RES_DIR);
  console.log('\n' + md);
}

main().catch((e) => { console.error(e); process.exit(1); });
