// stats — 一條 Workflow 近 N 天的成效統計（US-099）。純函式：吃已讀出的 run 物件陣列，不碰檔案。
// 近 N 天以 started_at 判（(now−N天, now]）；讀不到／缺 started_at 的那趟不算。
// 一路跑完＝status done 且沒有 failed 步驟；分母＝已結束或停住的趟（排除 running）。
// 一趟通常多久＝status done 的 finished_at−started_at 中位數（含等你的時間）。
// 平均每趟被你改幾處＝每趟 edited_output 非 null 的步驟數平均（排除 running）。
// 最常出事的步驟＝窗內每個節點 failed＋edited 次數，由大到小、同分 failed 多者先，取前 3，0 不列。

const DAY = 86400000;

const ms = (s) => {
  if (typeof s !== 'string' || !s) return NaN;
  return Date.parse(s);
};
const stepsOf = (r) => (r.steps && typeof r.steps === 'object' && !Array.isArray(r.steps) ? r.steps : {});
const isEdited = (s) => !!s && typeof s === 'object' && s.edited_output !== undefined && s.edited_output !== null;
const isFailed = (s) => !!s && typeof s === 'object' && s.status === 'failed';

function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function rateOf(runs) {
  const ended = runs.filter((r) => r.status !== 'running');
  if (!ended.length) return null;
  const clean = ended.filter((r) => r.status === 'done' && !Object.values(stepsOf(r)).some(isFailed)).length;
  return clean / ended.length;
}

export function runStats(runs, nowMs = Date.now(), days = 30) {
  const span = days * DAY;
  const valid = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && typeof r === 'object' && !Array.isArray(r) && Number.isFinite(ms(r.started_at)));
  const inRange = (r, lo, hi) => { const t = ms(r.started_at); return t > lo && t <= hi; };
  const cur = valid.filter((r) => inRange(r, nowMs - span, nowMs));
  const prev = valid.filter((r) => inRange(r, nowMs - 2 * span, nowMs - span));

  const durations = cur
    .filter((r) => r.status === 'done')
    .map((r) => ms(r.finished_at) - ms(r.started_at))
    .filter((d) => Number.isFinite(d) && d >= 0);
  const ended = cur.filter((r) => r.status !== 'running');
  const editedAvg = ended.length
    ? ended.reduce((a, r) => a + Object.values(stepsOf(r)).filter(isEdited).length, 0) / ended.length
    : null;

  // 最常出事的步驟：標題取最近一趟快照裡的 title
  const byNode = new Map();
  const newestFirst = [...cur].sort((a, b) => ms(b.started_at) - ms(a.started_at));
  for (const r of newestFirst) {
    const titles = new Map((Array.isArray(r.def?.nodes) ? r.def.nodes : []).filter((n) => n && n.id).map((n) => [n.id, n.title]));
    for (const [node, s] of Object.entries(stepsOf(r))) {
      const f = isFailed(s) ? 1 : 0;
      const e = isEdited(s) ? 1 : 0;
      let row = byNode.get(node);
      if (!row) { row = { node, title: null, failed: 0, edited: 0 }; byNode.set(node, row); }
      if (row.title == null && titles.get(node) != null) row.title = String(titles.get(node));
      row.failed += f;
      row.edited += e;
    }
  }
  const top = [...byNode.values()]
    .filter((x) => x.failed + x.edited > 0)
    .sort((a, b) => (b.failed + b.edited) - (a.failed + a.edited) || b.failed - a.failed)
    .slice(0, 3)
    .map((x) => ({ ...x, title: x.title ?? x.node }));

  return {
    days,
    window: { runs: cur.length, rate: rateOf(cur), median_ms: median(durations), edited_avg: editedAvg },
    prev_rate: rateOf(prev),
    top_steps: top,
  };
}

// ---- US-118 逐趟曲線：同一條流程按 started_at 由早到晚，每趟四個數（改幾處／花多久／用量／被攔幾次）----
// 純函式：吃已讀出的 run 陣列與用量帳本列。進行中（running）、讀不到、缺 run_id 或 started_at 的那趟略過。
// tokens＝帳本裡 run===run_id 的輸入（含快取建立／快取讀取）＋輸出加總，公式與 supervisor.addUsage／server.tokenInput 同一套。
// blocked＝各步 attempts 裡 check.status==='blocked' 的次數。duration_ms＝finished_at−started_at，沒 finished_at 就 null。
const tokensOf = (u) => (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.output_tokens ?? 0);

export function runSeries(runs, usageRows) {
  const byRun = new Map();
  for (const u of Array.isArray(usageRows) ? usageRows : []) {
    if (!u || typeof u !== 'object' || typeof u.run !== 'string') continue;
    byRun.set(u.run, (byRun.get(u.run) ?? 0) + tokensOf(u));
  }
  return (Array.isArray(runs) ? runs : [])
    .filter((r) => r && typeof r === 'object' && !Array.isArray(r) && typeof r.run_id === 'string' && r.status !== 'running' && Number.isFinite(ms(r.started_at)))
    .sort((a, b) => ms(a.started_at) - ms(b.started_at) || (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0))
    .map((r) => {
      const steps = Object.values(stepsOf(r));
      const dur = ms(r.finished_at) - ms(r.started_at);
      return {
        run_id: r.run_id,
        started_at: r.started_at,
        edited: steps.filter(isEdited).length,
        duration_ms: Number.isFinite(dur) && dur >= 0 ? dur : null,
        tokens: byRun.get(r.run_id) ?? 0,
        blocked: steps.reduce((n, s) => n + (Array.isArray(s?.attempts) ? s.attempts.filter((a) => a?.check?.status === 'blocked').length : 0), 0),
      };
    });
}
