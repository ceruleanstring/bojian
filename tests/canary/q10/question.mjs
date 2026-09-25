// q10 誤攔率題（結構題，只跑剝繭）：資料與三步跟 q1 一模一樣，但「查核」打開（check.enabled＋數字對原始資料），監工關、可寫程式。
// 量的是查核閘本身：每步攔了幾條數字（first_blocks）、重寫後仍沒出處幾條（recheck_blocks，工單 A 新加的欄位）、
// 其中幾條是「冤枉」——被攔的那個數字對 truth 其實是對的（truth 裡有、容差到成品寫的位數）。
// 冤枉有兩種：(a) 程式攔的數字其實在 truth（wrongful_blocks）；(b) 查核員判 missing「原始資料本來就沒有」的主張，claim 裡的數字其實在 truth（wrongful_missing）——
//   (b) 會停下走資料不全卡叫人（真趟 20260924-2125 report 步：「官網7月營收75,590元」被判 missing，數字其實在 points 步的產出裡）。
// pass＝完整性閘先過（那趟 status 是 done、三個 AI 步都有查核紀錄、假話 0 句；2026-09-25 E2 補，lib/gates.mjs）
//   ＋13 項關鍵數字全中、冤枉（兩種加總）≤ 1、且要人出手 0 次（使用者 09-24 裁定不停下叫人）。假話反向計分沿用 q1 的 forbidden。
import fs from 'node:fs';
import path from 'node:path';
import * as q1 from '../q1/question.mjs';
import { matchKeys } from '../lib/text.mjs';
import { completenessGates } from '../lib/gates.mjs';

export const id = 'q10';
export const title = '誤攔率（查核打開・q1 同一份資料）';
export const kind = 'structural';
export const anomalies = ['查核攔了幾條、冤枉幾條（真數字被當沒出處）'];

// ---- 資料：q1 同一份（不複製），truth 多幾個從同一批 rows 推出的數字——判「冤枉」時才認得出 7 月訂單數、各品項退貨這類合理的衍生數 ----
export function extraTruth(rows) {
  const sum = (xs) => xs.reduce((a, r) => a + r.amt, 0);
  const r1 = (x) => Math.round(x * 10) / 10;
  const by = (xs, key) => { const o = {}; for (const r of xs) o[r[key]] = (o[r[key]] ?? 0) + 1; return o; };
  const byAmt = (xs, key) => { const o = {}; for (const r of xs) o[r[key]] = (o[r[key]] ?? 0) + r.amt; return o; };
  const jul = rows.filter((r) => r.m === 7); const aug = rows.filter((r) => r.m === 8);
  const julDone = jul.filter((r) => r.status === '完成'); const augDone = aug.filter((r) => r.status === '完成');
  const julRet = jul.filter((r) => r.status === '退貨'); const augRet = aug.filter((r) => r.status === '退貨');
  const julRev = sum(julDone); const augRev = sum(augDone);
  const julChRev = byAmt(julDone, 'ch'); const augChRev = byAmt(augDone, 'ch');
  const julProdRev = byAmt(julDone, 'name'); const augProdRev = byAmt(augDone, 'name');
  const pctChange = (a, b) => (b ? r1((a - b) / b * 100) : null);
  return {
    jul_orders_all: jul.length, aug_orders_all: aug.length,
    jul_orders: julDone.length,
    jul_returns: julRet.length, jul_return_amount: sum(julRet),
    jul_aov: Math.round(julRev / julDone.length),
    jul_channel_rev: julChRev, jul_product_rev: julProdRev,
    jul_channel_share: Object.fromEntries(Object.entries(julChRev).map(([c, v]) => [c, r1(v / julRev * 100)])),
    channel_mom_pct: Object.fromEntries(Object.keys(augChRev).map((c) => [c, pctChange(augChRev[c], julChRev[c] ?? 0)])),
    product_mom_pct: Object.fromEntries(Object.keys(augProdRev).map((p) => [p, pctChange(augProdRev[p], julProdRev[p] ?? 0)])),
    aug_return_rate_pct: r1(augRet.length / aug.length * 100), jul_return_rate_pct: r1(julRet.length / jul.length * 100),
    aug_return_amount_share_pct: r1(sum(augRet) / augRev * 100),
    aug_returns_by_channel: by(augRet, 'ch'), aug_sold_by_product: by(aug, 'name'), aug_returns_by_product: by(augRet, 'name'),
    aug_return_amount_by_product: byAmt(augRet, 'name'),
    scarf_return_rate_pct: r1(augRet.filter((r) => r.name === '羊毛圍巾').length / aug.filter((r) => r.name === '羊毛圍巾').length * 100),
    aug_qty: augDone.reduce((a, r) => a + r.qty, 0), jul_qty: julDone.reduce((a, r) => a + r.qty, 0),
    revenue_diff: augRev - julRev,
  };
}

export async function generate(dataDir) {
  const gen = await q1.generate(dataDir); // 同一份 sales.csv、同一個 truth（含 forbidden）
  const truth = { ...gen.truth, extra: extraTruth(q1.buildRows()) };
  fs.writeFileSync(path.join(dataDir, 'truth.json'), JSON.stringify(truth, null, 2));
  return { files: gen.files, truth };
}

// ---- 流程：q1 的三步，查核開（含數字對原始資料）、監工關、可寫程式（工人才印得出數字讓程式對）----
export function flowDef(ctx) {
  const def = q1.flowDef(ctx);
  return { ...def, name: '金絲雀 q10：8 月銷售月報（查核打開）', check: { enabled: true, facts: true }, supervisor: { enabled: false }, permissions: { files: true, connectors: false } };
}
// 預期會被查核的步驟＝流程裡每一個 AI 步（查核全開）；score 用它核對「查核真的跑過」（E2，2026-09-25）
export const CHECKED_STEPS = flowDef({ files: [], truth: {} }).nodes.filter((n) => n.executor === 'ai').map((n) => n.id);

// ---- 冤枉判定：被攔的數字對 truth ----
// 成品寫的數字 w（d 位小數、有無 %、有無萬／億／千）對 truth 任一數 t：
//   fits(t, w, d)（四捨五入或截斷都算對）、w 帶 % 時 fits(t×100)、w 不帶 % 且 0<t<1 時 fits(t×100)、w 帶倍數時 t 先除倍數再比；正負不計較
const UNIT = { 萬: 1e4, 万: 1e4, 億: 1e8, 亿: 1e8, 千: 1e3 };
const roundTo = (v, k) => Number(v.toFixed(k));
const truncTo = (v, k) => Math.trunc(v * 10 ** k) / 10 ** k;
const fits = (t, w, k) => roundTo(t, k) === roundTo(w, k) || truncTo(t, k) === roundTo(w, k);

// 攔下來的 number 原文（"258,450"、"14.4%"、"25.8 萬"、"-36.5%"）→ { value, decimals, percent, mult }；看不懂回 null
// 另吃「萬＋尾數」合成數（"25萬8,450"、"25 萬 8,450"、"1億2,345萬6,789"、"1億2,345萬"）→ 合成後的整數、mult 1——
// checker 修好前 number 欄給的是半截「8,450」，修好後可能給合成原文或直接給 258450，後兩種都認得
const SP = '[\\s\\u3000]*';
const TAIL = '(\\d{1,3}[,，]\\d{3}|\\d{1,4})'; // 尾數 0～9,999，可帶千分位
const COMPOSITE = new RegExp(`^[-－−+]?${SP}(?:(\\d+)${SP}[億亿])?${SP}(?:(\\d{1,3}(?:[,，]\\d{3})+|\\d+)${SP}[萬万])?${SP}${TAIL}?${SP}$`);
const toInt = (s) => Number(String(s).replace(/[,，]/g, ''));
export function parseNumber(raw) {
  const s = String(raw ?? '').trim();
  const m = /^[-－−+]?\(?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*\)?\s*([萬万億亿千])?\s*([%％])?$/.exec(s);
  if (m) {
    const value = Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);
    return { value, decimals: m[2] ? Math.min(m[2].length, 12) : 0, mult: m[3] ? UNIT[m[3]] : 1, percent: !!m[4] };
  }
  const c = COMPOSITE.exec(s);
  if (!c) return null;
  const [, yi, wan, tail] = c;
  // 合法的組合：億＋萬（尾數可有可無）、萬＋尾數；「1億5,000」這種億後面直接接尾數的不知道是 5,000 萬還是 5,000 元，不猜
  if (!((yi && wan) || (wan && tail))) return null;
  const value = (yi ? toInt(yi) * 1e8 : 0) + (wan ? toInt(wan) * 1e4 : 0) + (tail ? toInt(tail) : 0);
  return { value, decimals: 0, mult: 1, percent: false };
}

// truth 裡所有數值（遞迴；forbidden 那段是文字不算）
export function truthNumbers(truth) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'number') { if (Number.isFinite(v)) out.add(Math.abs(v)); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'forbidden') continue; walk(x); }
  };
  walk(truth);
  return out;
}

export function inTruth(raw, nums) {
  const p = parseNumber(raw);
  if (!p) return false;
  const d = p.decimals;
  for (const t of nums) {
    const a = t / p.mult;
    if (fits(a, p.value, d)) return true;
    if (p.percent && fits(a * 100, p.value, d)) return true;
    if (!p.percent && a > 0 && a < 1 && fits(a * 100, p.value, d)) return true;
  }
  return false;
}

// 成品裡的數字原文（給沒有 number 欄的攔條用：查核員攔的文字主張，從 claim 裡撈數字）
// 「25萬8,450」「1億2,345萬6,789」這種合成數當一個原文撈出來（不拆成 25 與 8,450）；7月、15日、2026年 這種不是量；數字不准被截一半
const NUM_IN_TEXT = new RegExp(
  `(?<![\\d.,])(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?` // 主數
  + `(?:\\s?[億亿](?!分)(?:\\s?${TAIL}(?=\\s?[萬万]))?)?` // 億＋（接著要有萬的）中段
  + `(?:\\s?[萬万](?!分)(?:\\s?${TAIL})?)?` // 萬＋尾數
  + `(?:\\s?千(?![\\d分]))?\\s?[%％]?(?![\\d.,]|\\s?[月日年號])`,
  'g',
);
export function numbersIn(text) {
  return [...String(text ?? '').matchAll(NUM_IN_TEXT)].map((m) => m[0].trim()).filter((x) => /\d/.test(x));
}

// 一步的查核紀錄 → { first:[…], recheck:[…]|null }
//   first_blocks＝第一次攔的（status='redone' 時 blocks 已清空、留在 first_blocks）；沒重做過的舊格式（status='blocked'）就用 blocks
//   recheck_blocks＝重寫後仍沒出處的（工單 A 新加）；欄位不存在＝null（呼叫端當 [] 並記 notes）
export function blocksOf(check) {
  if (!check || typeof check !== 'object') return { first: [], recheck: null };
  const first = Array.isArray(check.first_blocks) ? check.first_blocks : (Array.isArray(check.blocks) ? check.blocks : []);
  const recheck = Array.isArray(check.recheck_blocks) ? check.recheck_blocks : null;
  return { first, recheck };
}

// 每條攔下來的：有 number 欄就對那個數；沒有（查核員攔的文字句）就把 claim 裡的數字全撈出來、全部在 truth 裡才算冤枉；一個數字都沒有＝判不了，不算冤枉
export function isWrongful(block, nums) {
  const raws = block?.number ? [String(block.number)] : numbersIn(block?.claim);
  if (!raws.length) return false;
  return raws.every((r) => inTruth(r, nums));
}

// 一步的 missing 清單：steps[nid].check.missing ＋ interventions 裡同一步 waiting_data 帶的 check.missing（同一 claim 只算一次——兩邊通常是同一份）
export function missingOf(nid, check, interventions) {
  const out = []; const seen = new Set();
  const add = (list) => { for (const x of (Array.isArray(list) ? list : [])) { const k = String(x?.claim ?? ''); if (!k || seen.has(k)) continue; seen.add(k); out.push(x); } };
  add(check?.missing);
  for (const iv of (Array.isArray(interventions) ? interventions : [])) if (iv?.node === nid && (iv.status === 'waiting_data' || iv.check?.status === 'missing')) add(iv.check?.missing);
  return out;
}

export async function score({ finalText, steps = {}, truth, drive = null, runStatus = null }) {
  const text = finalText ?? '';
  const interventions = Array.isArray(drive?.interventions) ? drive.interventions : null; // run.mjs 與 --rescore 都傳 drive；沒傳＝null（舊 score.mjs）
  const m = matchKeys(text, q1.keysOf(truth));
  const falseClaims = q1.forbiddenHits(text, truth);
  const nums = truthNumbers(truth);
  const notes = [];
  const misses = [...m.misses, ...falseClaims.map((id) => `假話：${id}`)];
  let blocks = 0; let wrongful = 0; let recheckTotal = 0; let recheckMissing = false; let stepsChecked = 0;
  let missingTotal = 0; let wrongfulMissing = 0; let missingSteps = 0;
  const wrongfulList = []; const perStep = {};
  for (const [nid, s] of Object.entries(steps)) {
    if (!s || s.check === undefined || s.check === null) continue; // 這步沒查核紀錄（cc 邊或查核關）
    stepsChecked++;
    const { first, recheck } = blocksOf(s.check);
    if (recheck === null && first.length) recheckMissing = true; // 有攔過（重寫過）才該有 recheck_blocks；一次過關的步本來就沒有
    const rc = recheck ?? [];
    const wrong = first.filter((b) => isWrongful(b, nums));
    blocks += first.length; wrongful += wrong.length; recheckTotal += rc.length;
    // 查核員判 missing（走資料不全卡、停下叫人）：claim 裡的數字其實在 truth ＝ 冤枉
    const missing = missingOf(nid, s.check, interventions);
    const wrongMissing = missing.filter((x) => isWrongful({ claim: x.claim }, nums));
    missingTotal += missing.length; wrongfulMissing += wrongMissing.length;
    if (missing.length || s.check?.status === 'missing') missingSteps++;
    perStep[nid] = { blocks: first.length, wrongful: wrong.length, recheck: rc.length, missing: missing.length, wrongful_missing: wrongMissing.length, status: s.check?.status ?? null };
    for (const b of wrong) wrongfulList.push(`${nid}：${b.number ?? numbersIn(b.claim).join('/')}`);
    for (const x of wrongMissing) wrongfulList.push(`${nid}：判 missing 的「${x.claim}」（數字 ${numbersIn(x.claim).join('/')} 其實在 truth）`);
  }
  // 要人出手：drive 有紀錄就數它（run.mjs 存的 interventions）；沒紀錄就以判 missing 的步數當下限並記 notes
  const humanTouches = interventions ? interventions.filter((iv) => !['timeout'].includes(iv?.kind)).length : missingSteps;
  const wrongfulTotal = wrongful + wrongfulMissing;
  const stops = blocks + missingTotal;
  if (!text.trim()) notes.push('成品是空的');
  if (!stepsChecked) notes.push('沒有任何一步帶查核紀錄（check 沒開？）');
  if (recheckMissing) notes.push('查核紀錄沒有 recheck_blocks 欄位（工單 A 還沒落地或跑的是舊碼）——當 0 計');
  if (!interventions) notes.push('score 沒拿到 drive.interventions——要人出手次數以判 missing 的步數當下限');
  if (wrongfulList.length) notes.push(`冤枉：${wrongfulList.join('、')}`);
  if (humanTouches > 0) notes.push(`要人出手 ${humanTouches} 次${interventions ? `（${interventions.map((iv) => `${iv.node ?? iv.kind}:${iv.act ?? iv.kind}`).join('、')}）` : ''}——使用者 09-24 裁定不停下叫人，這題不過`);
  notes.push(`攔 ${blocks} 條＋判 missing ${missingTotal} 條、冤枉 ${wrongfulTotal} 條（攔錯 ${wrongful}＋missing 錯 ${wrongfulMissing}）、重寫後仍沒出處 ${recheckTotal} 條（每步 攔/冤枉/重寫後/missing：${Object.entries(perStep).map(([k, v]) => `${k} ${v.blocks}/${v.wrongful}/${v.recheck}/${v.missing}`).join('；') || '無'}）`);
  // 完整性閘（E2）：①那趟 status 是 done ②預期會查核的三步（CHECKED_STEPS）都有查核紀錄 ③假話 0 句——缺任一項不得 pass，reasons 寫明是哪一項
  const gate = completenessGates({ runStatus, steps, expectChecked: CHECKED_STEPS, falseClaims: falseClaims.length });
  const reasons = [...gate.reasons];
  if (m.misses.length) reasons.push(`關鍵數字沒中 ${m.misses.length} 項`);
  if (wrongfulTotal > 1) reasons.push(`冤枉 ${wrongfulTotal} 條 > 1`);
  if (humanTouches > 0) reasons.push(`要人出手 ${humanTouches} 次`);
  for (const r of gate.reasons) { misses.push(r); notes.push(`不過：${r}`); }
  return {
    pass: reasons.length === 0, // 完整性閘全過＋關鍵數字全中、冤枉（含 missing 錯判）≤1、沒停下叫人
    reasons,
    metrics: {
      primary: m.ok, primary_label: `關鍵數字（/${m.total}）`,
      errors: m.misses.length + falseClaims.length,
      blocks, wrongful_blocks: wrongful, recheck_blocks: recheckTotal, false_claims: falseClaims.length,
      missing: missingTotal, wrongful_missing: wrongfulMissing,
      stops, wrongful: wrongfulTotal, // summary 表「攔／冤枉」欄印這兩個：停下的總次數（攔＋missing）／冤枉總數（攔錯＋missing 錯）
      interventions: humanTouches,
      keys_ok: m.ok, keys_total: m.total, steps_checked: stepsChecked, per_step: perStep,
    },
    misses,
    notes,
  };
}
