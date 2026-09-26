// metrics — 本機使用計數（US-119／US-120、ADR-013）。只記次數、大小、時間長度與 id，不記任何內容。
// 事件檔 data/metrics.jsonl：append-only，一行一事件 {at, event, ...欄位}。欄位只准 id 字串（run／node／workflow／proposal／card）、
// 固定選項（artifact_open.mode）與數字；文字內容（成品、欄位值、流程名、檔名、句子）一律丟錯不落地——這是 ADR-013 安全考量的硬規則。
// summarize 回純計數；buildReport 是「匯出封測報告」與「回傳使用計數」共用的唯一內容，裡面不得出現任何 id／名稱／字串。
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'metrics.jsonl';
const ID = 'id';
const NUM = 'num'; // 數字或 null
const MODES = ['preview', 'inline', 'download'];

// 事件 → 欄位規格。只列在這裡的欄位才收，多來的一律擋
export const EVENTS = Object.freeze({
  stop_pass: { run: ID, node: ID },
  stop_edit: { run: ID, node: ID, size: NUM },
  artifact_open: { run: ID, mode: MODES },
  run_abandon: { run: ID, step_done: NUM, step_total: NUM },
  workflow_create: { workflow: ID },
  workflow_first_run: { workflow: ID, interval_ms: NUM },
  proposal_accept: { proposal: ID },
  proposal_reject: { proposal: ID },
  memory_undo: { card: ID },
  check_block: { run: ID, node: ID },
  check_wrong: { run: ID, node: ID },
});

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\n\r]/.test(v);
const isNum = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));

function validate(event, fields) {
  const spec = EVENTS[event];
  if (!spec) throw new Error(`不認得的計數事件「${String(event)}」`);
  const f = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
  const out = {};
  for (const [k, kind] of Object.entries(spec)) {
    const v = f[k];
    if (v === undefined) throw new Error(`計數事件「${event}」缺欄位「${k}」`);
    const ok = kind === ID ? isId(v) : kind === NUM ? isNum(v) : Array.isArray(kind) && kind.includes(v);
    if (!ok) throw new Error(`計數事件「${event}」欄位「${k}」只准${kind === ID ? ' id' : kind === NUM ? '數字' : kind.join('／')}`);
    out[k] = v;
  }
  const extra = Object.keys(f).filter((k) => !(k in spec));
  if (extra.length) throw new Error(`計數事件「${event}」不收欄位「${extra.join('、')}」（計數只記次數與 id，不記內容）`);
  return out;
}

export function record(dataDir, event, fields = {}, { now = () => Date.now() } = {}) {
  const clean = validate(event, fields);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(path.join(dataDir, FILE), `${JSON.stringify({ at: new Date(now()).toISOString(), event, ...clean })}\n`, 'utf8');
  return clean;
}

export function readEvents(dataDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dataDir, FILE), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s);
      if (e && typeof e === 'object' && typeof e.event === 'string') out.push(e);
    } catch { /* append 中斷的殘行跳過，不擋整本 */ }
  }
  return out;
}

// 同一 run＋node 的事件有沒有記過（「這條查錯了」只記一次）
export function hasEvent(dataDir, event, fields) {
  const keys = Object.keys(fields ?? {});
  return readEvents(dataDir).some((e) => e.event === event && keys.every((k) => e[k] === fields[k]));
}

function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ratio = (a, b) => (b > 0 ? a / b : null);

export function summarize(events) {
  const list = (Array.isArray(events) ? events : []).filter((e) => e && typeof e === 'object' && EVENTS[e.event]);
  const of = (name) => list.filter((e) => e.event === name);
  const stopEdits = of('stop_edit');
  const opens = of('artifact_open');
  const abandons = of('run_abandon');
  const byStep = {};
  for (const e of abandons) { const k = num(e.step_done); if (k !== null) byStep[k] = (byStep[k] ?? 0) + 1; }
  const created = new Set(of('workflow_create').map((e) => e.workflow).filter(isId));
  const firstRuns = of('workflow_first_run');
  const ran = new Set(firstRuns.map((e) => e.workflow));
  const accept = of('proposal_accept').length;
  const reject = of('proposal_reject').length;
  const block = of('check_block').length;
  const wrong = of('check_wrong').length;
  return {
    stop: { pass: of('stop_pass').length, edit: stopEdits.length, edit_size_median: median(stopEdits.map((e) => num(e.size)).filter((v) => v !== null)) },
    artifact_open: Object.fromEntries(MODES.map((m) => [m, opens.filter((e) => e.mode === m).length])),
    abandon: { count: abandons.length, by_step_done: byStep },
    workflows: {
      created: created.size,
      never_run: [...created].filter((w) => !ran.has(w)).length,
      first_run_interval_median_ms: median(firstRuns.map((e) => num(e.interval_ms)).filter((v) => v !== null)),
    },
    proposals: { accept, reject, accept_rate: ratio(accept, accept + reject) },
    memory_undo: of('memory_undo').length,
    check: { block, wrong, wrong_rate: ratio(wrong, block) },
  };
}

// 封測報告：版本號、產出時刻、計數、每條流程五個數（不帶流程名與 id）。這份就是匯出檔與回傳內容，一個位元組都不多
export function buildReport({ dataDir, version = null, workflowsStats = [], now = () => Date.now() } = {}) {
  const workflows = (Array.isArray(workflowsStats) ? workflowsStats : []).map((w) => ({
    runs: num(w?.runs) ?? 0,
    rate: num(w?.rate),
    median_ms: num(w?.median_ms),
    edited_avg: num(w?.edited_avg),
    series_len: num(w?.series_len) ?? 0,
  }));
  return {
    version: typeof version === 'string' ? version : null,
    generated_at: new Date(now()).toISOString(),
    counts: summarize(dataDir ? readEvents(dataDir) : []),
    workflows,
  };
}

// 停點「改了」的改動大小＝改前改後的行級差異（LCS：新增＋刪除行數）。文字都在記憶體，行數通常幾十到幾百；
// 任一側超過 2000 行就退化成行數差，免得 O(n·m) 吃記憶體。只回大小，不回內容
const LCS_CAP = 2000;
const lines = (s) => (s === null || s === undefined || s === '' ? [] : String(s).split(/\r?\n/));
export function editSize(before, after) {
  const a = lines(before);
  const b = lines(after);
  if (!a.length || !b.length) return a.length + b.length;
  if (a.length > LCS_CAP || b.length > LCS_CAP) return Math.abs(a.length - b.length);
  // 兩列滾動的 LCS 表
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[b.length];
  return (a.length - lcs) + (b.length - lcs);
}
