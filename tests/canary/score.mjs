// 金絲雀計分：讀 results/<最新或指定>/*.json 產 summary.md（第一行「金絲雀：活／死（哪幾題）」＋一張表）
//   node tests/canary/score.mjs [results/<時間戳>] [--rescore]   （--rescore＝計分規則改了，用存下的成品重算 score 再判生死）
// 生死規則（CONTRACT.md）：
//   compare：剝繭 score.pass 為真、且 weighted(剝繭) ≤ 1.5 × weighted(cc)、且主指標不輸 cc → 活
//   structural：score.pass 為真 → 活
//   任何一題死＝金絲雀死
//   完整性（2026-09-25 E2 前置的 E1）：以 run-info.json 宣告的 questions×arms×reps 矩陣為準，缺任何一格、空集、壞 JSON、沒有 run-info.json ＝不得活（列出缺哪些）
// 主指標約定（README）：score.metrics.primary（數字，越大越好；沒給＝pass 當 1/0）、metrics.errors（沒給＝misses.length）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { weighted } from './lib/usage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_ROOT = path.join(HERE, 'results');

export function latestResultsDir() {
  if (!fs.existsSync(RESULTS_ROOT)) return null;
  const dirs = fs.readdirSync(RESULTS_ROOT).filter((d) => fs.statSync(path.join(RESULTS_ROOT, d)).isDirectory()).sort();
  return dirs.length ? path.join(RESULTS_ROOT, dirs[dirs.length - 1]) : null;
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const primaryOf = (r) => {
  const p = r.score?.metrics?.primary;
  if (typeof p === 'number') return p;
  if (typeof p === 'boolean') return p ? 1 : 0;
  return r.score?.pass ? 1 : 0;
};
const errorsOf = (r) => {
  const e = r.score?.metrics?.errors;
  return typeof e === 'number' ? e : (r.score?.misses?.length ?? 0);
};
// 有給才算（q10 才有攔／冤枉；其他題 null，表格不印）
const metricAvg = (rs, key) => { const xs = rs.map((r) => r.score?.metrics?.[key]).filter((x) => typeof x === 'number'); return xs.length ? avg(xs) : null; };

// 讀結果夾：rows＝讀得懂的結果列；broken＝讀不懂的檔名（壞 JSON 要列名，不能靜默跳過——E1）
export function readResults(dir) {
  const rows = []; const broken = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^q\d+-(bojian|cc)-\d+\.json$/.test(x)).sort()) {
    try { rows.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { broken.push(f); }
  }
  return { rows, broken };
}
export function loadResults(dir) { return readResults(dir).rows; }

export function loadRunInfo(dir) {
  const p = path.join(dir, 'run-info.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// 一題的 kind：結果列有寫就用它；一列都沒有時看 qN/question.mjs 的 `export const kind = '…'`；再沒有＝null（宣告的邊全算預期）
export function kindOf(q, rows) {
  const fromRows = rows.find((r) => r.q === q && r.kind)?.kind;
  if (fromRows) return fromRows;
  const qfile = path.join(HERE, q, 'question.mjs');
  if (!fs.existsSync(qfile)) return null;
  const m = /export\s+const\s+kind\s*=\s*['"](compare|structural)['"]/.exec(fs.readFileSync(qfile, 'utf8'));
  return m ? m[1] : null;
}

// 完整性核對（E1）：run-info.json 宣告的 questions×arms×reps 每一格都要有一列讀得懂的結果
//   structural 題只預期 bojian 那邊（跑手本來就只跑剝繭）；compare 題預期宣告的每一邊
//   回 { ok, planned, present, missing:['q7-bojian-1',…], broken:['x.json'], reasons:[…] }
export function checkCompleteness(dir, rows, broken = []) {
  const info = loadRunInfo(dir);
  const reasons = [];
  const missing = [];
  let planned = 0;
  if (!info || !Array.isArray(info.questions)) {
    reasons.push('沒有 run-info.json（或裡面沒有 questions），核對不了宣告的題×趟矩陣');
  } else {
    const arms = Array.isArray(info.arms) && info.arms.length ? info.arms : ['bojian', 'cc'];
    const reps = Math.max(1, Number(info.reps) || 1);
    const have = new Set(rows.map((r) => `${r.q}-${r.arm}-${r.rep}`));
    for (const q of info.questions) {
      const kind = kindOf(q, rows);
      const qArms = kind === 'structural' ? arms.filter((a) => a === 'bojian') : arms;
      for (const arm of qArms) for (let rep = 1; rep <= reps; rep++) {
        planned++;
        const key = `${q}-${arm}-${rep}`;
        if (!have.has(key)) missing.push(key);
      }
    }
    if (missing.length) reasons.push(`缺趟 ${missing.length}/${planned}：${missing.join('、')}`);
  }
  if (broken.length) reasons.push(`壞檔：${broken.join('、')}`);
  if (!rows.length) reasons.push('沒有任何一趟跑完');
  return { ok: reasons.length === 0, planned, present: rows.length, missing, broken: [...broken], reasons };
}

// 一邊多趟的彙總
function aggregate(rs) {
  if (!rs.length) return null;
  const w = rs.map((r) => r.weighted ?? weighted(r.tokens));
  return {
    n: rs.length,
    weighted: avg(w),
    minutes: r1(avg(rs.map((r) => (r.ms ?? 0) / 60000))),
    pass_n: rs.filter((r) => r.score?.pass).length,
    pass: rs.every((r) => r.score?.pass),
    primary: avg(rs.map(primaryOf)),
    primary_label: rs.find((r) => r.score?.metrics?.primary_label)?.score?.metrics?.primary_label ?? '主指標',
    errors: avg(rs.map(errorsOf)),
    blocks: metricAvg(rs, 'stops') ?? metricAvg(rs, 'blocks'),                 // 查核停下的次數：攔＋判 missing（q10；舊結果只有 blocks）
    wrongful: metricAvg(rs, 'wrongful') ?? metricAvg(rs, 'wrongful_blocks'),   // 其中冤枉的：攔錯＋missing 錯判（q10）
    false_claims: metricAvg(rs, 'false_claims'),     // 假話句數（q1／q3／q10）
    status: [...new Set(rs.map((r) => r.status))].join('/'),
    interventions: avg(rs.map((r) => (r.interventions ?? []).length)),
    misses: [...new Set(rs.flatMap((r) => r.score?.misses ?? []))],
    notes: [...new Set(rs.flatMap((r) => r.score?.notes ?? []))],
  };
}

export function judge(rows) {
  const byQ = {};
  for (const r of rows) ((byQ[r.q] ??= { q: r.q, title: r.title, kind: r.kind, arms: {} }).arms[r.arm] ??= []).push(r);
  const out = [];
  for (const q of Object.values(byQ).sort((a, b) => a.q.localeCompare(b.q))) {
    const b = aggregate(q.arms.bojian ?? []);
    const c = aggregate(q.arms.cc ?? []);
    const reasons = [];
    let alive;
    if (q.kind === 'structural') {
      alive = !!b?.pass;
      if (!b) reasons.push('剝繭沒跑');
      else if (!b.pass) reasons.push(`剝繭 ${b.pass_n}/${b.n} 趟 pass`);
    } else {
      if (!b) reasons.push('剝繭沒跑');
      if (!c) reasons.push('Claude Code 沒跑，比不了');
      if (b && !b.pass) reasons.push(`剝繭 ${b.pass_n}/${b.n} 趟 pass`);
      const ratio = b && c ? b.weighted / c.weighted : null;
      if (ratio !== null && ratio > 1.5) reasons.push(`用量 ${r2(ratio)} 倍 > 1.5`);
      if (b && c && b.primary < c.primary) reasons.push(`${b.primary_label} ${r1(b.primary)} < cc ${r1(c.primary)}`);
      alive = reasons.length === 0;
      q.ratio = ratio;
    }
    out.push({ ...q, bojian: b, cc: c, alive, reasons });
  }
  return out;
}

// 生死一句話（Markdown 第一行與 summary.json 的 alive 都由這裡決定，兩邊講同一件事）
export function verdict(judged, complete = null) {
  const dead = judged.filter((j) => !j.alive);
  const gaps = complete && !complete.ok ? complete.reasons : [];
  const alive = judged.length > 0 && dead.length === 0 && gaps.length === 0;
  let line;
  if (!judged.length) line = `金絲雀：無結果（沒有任何一趟跑完，不能當活${gaps.filter((g) => g !== '沒有任何一趟跑完').map((g) => `；${g}`).join('')}）`;
  else if (!alive) line = `金絲雀：死（${[...dead.map((j) => `${j.q} ${j.reasons.join('、')}`), ...gaps].join('；')}）`;
  else line = `金絲雀：活（${judged.length} 題全過${complete ? `，宣告 ${complete.planned} 趟全到齊` : ''}）`;
  return { alive, line };
}

export function renderSummary(dir, judged, complete = null) {
  const lines = [];
  lines.push(verdict(judged, complete).line);
  lines.push('');
  lines.push(`結果夾：\`${path.relative(HERE, dir).replace(/\\/g, '/')}\`　產生時間：${new Date().toISOString()}`);
  lines.push('');
  // 「攔／冤枉」欄只在有題目給了 metrics.blocks（q10）時才印；別的題那格印「—」
  const hasBlocks = judged.some((j) => [j.bojian, j.cc].some((a) => a && a.blocks != null));
  lines.push(`| 題 | 邊 | 抓到異常／主指標 | 錯誤數 |${hasBlocks ? ' 攔／冤枉 |' : ''} 用量倍數 | 分鐘 | pass |`);
  lines.push(`|---|---|---|---|${hasBlocks ? '---|' : ''}---|---|---|`);
  const fmtArm = (j, name, a) => {
    if (!a) return `| ${j.q} ${j.title ?? ''} | ${name} | （沒跑） | |${hasBlocks ? ' |' : ''} | | |`;
    const ratio = name === '剝繭' ? (j.kind === 'structural' ? '—' : (j.ratio == null ? '？' : `${r2(j.ratio)}×`)) : (j.kind === 'structural' ? '—' : '1×');
    const prim = `${a.primary_label}：${r1(a.primary)}`;
    const pass = a.pass ? `過（${a.pass_n}/${a.n}）` : `不過（${a.pass_n}/${a.n}）`;
    const blk = hasBlocks ? ` ${a.blocks == null ? '—' : `${r1(a.blocks)}／${r1(a.wrongful ?? 0)}`} |` : '';
    return `| ${j.q} ${j.title ?? ''} | ${name} | ${prim} | ${r1(a.errors)} |${blk} ${ratio}（${Math.round(a.weighted / 1000)}k） | ${a.minutes} | ${pass} |`;
  };
  for (const j of judged) {
    lines.push(fmtArm(j, '剝繭', j.bojian));
    if (j.kind !== 'structural') lines.push(fmtArm(j, 'Claude Code', j.cc));
  }
  lines.push('');
  lines.push(`用量倍數＝剝繭換算用量 ÷ Claude Code 換算用量（新讀＋1.25×快取寫入＋0.1×重複讀＋5×寫出）；括號內是換算用量（千）。${hasBlocks ? '攔／冤枉＝查核停下的次數（程式攔的數字＋查核員判 missing）／其中對 truth 其實是對的（誤攔、誤判 missing）次數，每趟平均。' : ''}`);
  lines.push('');
  for (const j of judged) {
    lines.push(`## ${j.q} ${j.title ?? ''}（${j.kind}）——${j.alive ? '活' : `死：${j.reasons.join('、')}`}`);
    for (const [name, a] of [['剝繭', j.bojian], ['Claude Code', j.cc]]) {
      if (!a) continue;
      lines.push(`- ${name}：狀態 ${a.status}；要人出手 ${r1(a.interventions)} 次/趟${a.misses.length ? `；沒命中：${a.misses.join('、')}` : ''}${a.notes.length ? `；備註：${a.notes.join('、')}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// 重新計分（--rescore）：計分規則改了不必重跑 Claude——用存下來的成品（.md）、產出檔（files/<name>/）、
// 與重新造出來的 truth（資料固定種子，generate 一次就同一份）再跑一次題目的 score()，寫回 json
export async function rescoreDir(dir) {
  const os = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const cache = {};
  for (const f of fs.readdirSync(dir).filter((x) => /^q\d+-(bojian|cc)-\d+\.json$/.test(x)).sort()) {
    const jp = path.join(dir, f);
    const r = JSON.parse(fs.readFileSync(jp, 'utf8'));
    const qfile = path.join(HERE, r.q, 'question.mjs');
    if (!fs.existsSync(qfile)) { console.error(`${f}：找不到 ${r.q}/question.mjs，沿用舊分`); continue; }
    cache[r.q] ??= await (async () => {
      const mod = await import(pathToFileURL(qfile).href);
      const gen = await mod.generate(fs.mkdtempSync(path.join(os.tmpdir(), `canary-rescore-${r.q}-`)));
      return { mod, gen };
    })();
    const { mod, gen } = cache[r.q];
    const name = f.replace(/\.json$/, '');
    const fdir = path.join(dir, 'files', name);
    const finalText = fs.existsSync(path.join(dir, `${name}.md`)) ? fs.readFileSync(path.join(dir, `${name}.md`), 'utf8') : '';
    const artifacts = fs.existsSync(fdir) ? fs.readdirSync(fdir).filter((x) => fs.statSync(path.join(fdir, x)).isFile()).map((x) => ({ name: x, path: path.join(fdir, x) })) : [];
    const pdir = path.join(fdir, 'prompts');
    const prompts = fs.existsSync(pdir) ? fs.readdirSync(pdir).map((x) => ({ name: x, path: path.join(pdir, x) })) : [];
    const steps = Object.fromEntries(Object.entries(r.steps ?? {}).map(([k, s]) => [k, { status: s.status, output: s.output ?? null, check: s.check ?? null, file: s.file ?? null }])); // 2026-09-24 起結果檔有存各步 output，重算多步成品才對得起來
    try {
      // drive／runStatus 照 run.mjs 的約定一起傳：結果檔存的 interventions 就是當時的駕駛紀錄（q10 用它數要人出手幾次）
      r.score = await mod.score({ arm: r.arm, finalText, artifacts, steps, prompts, truth: gen.truth, runDir: fdir, drive: { interventions: r.interventions ?? [] }, runStatus: r.status ?? null });
      r.rescored_at = new Date().toISOString();
    } catch (e) { r.score = { pass: false, metrics: {}, misses: [], notes: [`重新計分炸了：${e.message}`] }; }
    fs.writeFileSync(jp, JSON.stringify(r, null, 2));
    console.error(`${name}：pass=${r.score.pass}${r.score.misses?.length ? `，沒命中 ${r.score.misses.join('、')}` : ''}`);
  }
}

export function scoreDir(dir) {
  const { rows, broken } = readResults(dir);
  const judged = judge(rows);
  const complete = checkCompleteness(dir, rows, broken);
  const { alive } = verdict(judged, complete);
  const md = renderSummary(dir, judged, complete);
  fs.writeFileSync(path.join(dir, 'summary.md'), md, 'utf8');
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ alive, complete, questions: judged }, null, 2), 'utf8');
  return { rows, judged, complete, alive, md };
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rest = process.argv.slice(2);
  const rescore = rest.includes('--rescore');
  const arg = rest.find((a) => !a.startsWith('--'));
  const dir = arg ? path.resolve(arg) : latestResultsDir();
  if (!dir || !fs.existsSync(dir)) { console.error('找不到結果夾：', dir ?? '（results/ 是空的）'); process.exit(1); }
  if (rescore) await rescoreDir(dir);
  const { md, alive } = scoreDir(dir);
  console.log(md);
  process.exitCode = alive ? 0 : 2; // 判死（含缺趟／空集／壞檔）exit 2、活 exit 0（2026-09-25）；找不到結果夾是上面的 exit 1
}
