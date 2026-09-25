// q9 漏報題：三個月（6～8 月）約 1,700 筆訂單，埋四種不同類型的異常，每種只埋一個、彼此不重疊：
//   ① 商品類別「文具」8 月營收歸零（6、7 月都正常）；
//   ② 7/13（一）～7/19（日）整週一筆資料都沒有；
//   ③ 同一客戶編號同一天下了 6 張一模一樣的單（重複下單）；
//   ④ 有一筆金額是負數（-58,000）。
// 量的是「資料裡有東西、成品沒提」（漏報）＋「成品另外編出來的異常」（誤報）。
// 產生器與計分都在本檔；只用 lib 的 seed／csv／sentences，不改 lib。
import fs from 'node:fs';
import path from 'node:path';
import { makeRng } from '../lib/seed.mjs';
import { writeCsv } from '../lib/csv.mjs';
import { sentences } from '../lib/text.mjs';

export const id = 'q9';
export const title = '漏報題（四種異常・量漏報與誤報）';
export const kind = 'compare';
export const anomalies = ['文具類 8 月營收歸零', '7/13–7/19 整週缺資料', '同一客戶同日 6 張一模一樣的單', '一筆金額 -58,000'];

// ---- 常數（固定種子；改任何一個＝換題）----
export const SEED = 20260924;
const N_BASE = 2000;                       // 基底筆數；扣掉缺週與歸零類別後約 1,700 筆
export const MONTHS = [6, 7, 8];
const DAYS = { 6: 30, 7: 31, 8: 31 };
export const CATEGORIES = {
  包款: [['經典帆布托特包', 1280], ['防潑水後背包', 2380], ['皮革短夾', 1680]],
  家居: [['手工陶瓷馬克杯', 560], ['香氛蠟燭禮盒', 1450], ['棉麻餐墊組', 450]],
  配件: [['亞麻漁夫帽', 880], ['羊毛圍巾', 1980], ['真皮鑰匙圈', 380]],
  文具: [['帆布筆袋', 320], ['皮革手帳本', 520], ['鋼筆禮盒', 2600]],
  戶外: [['不鏽鋼保溫瓶', 990], ['露營摺疊椅', 1850], ['旅行收納袋組', 690]],
};
export const PRODUCTS = Object.entries(CATEGORIES).flatMap(([cat, ps]) => ps.map(([name, price]) => ({ cat, name, price })));
export const CHANNELS = ['官網', '蝦皮', '門市'];
const CH_W = [0.42, 0.35, 0.23];
const N_CUSTOMERS = 320;

export const ZERO_CAT = { category: '文具', month: 8 };                                   // ①
export const MISSING_WEEK = { start: '2026-07-13', end: '2026-07-19' };                    // ②（週一～週日）
export const DUP = { customer: 'C0187', date: '2026-06-24', product: '不鏽鋼保溫瓶', qty: 2, channel: '官網', count: 6 }; // ③
export const NEG = { customer: 'C0042', date: '2026-08-11', product: '皮革短夾', qty: 1, channel: '門市', amount: -58000 };  // ④

export const HEADERS = ['訂單編號', '日期', '客戶編號', '通路', '商品類別', '商品', '數量', '單價', '金額'];

const pad2 = (n) => String(n).padStart(2, '0');
const sig = (r) => [r.customer, r.date, r.ch, r.cat, r.name, r.qty, r.price, r.amt].join('|');
const inWeek = (date) => date >= MISSING_WEEK.start && date <= MISSING_WEEK.end;
const prodOf = (name) => PRODUCTS.find((p) => p.name === name);

// 週一起算的那一週：回 'YYYY-MM-DD'（週一）。2026-06-01 本身就是週一。
export function weekMonday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function buildRows() {
  const { rnd, pick, int } = makeRng(SEED);
  const chOf = () => { const r = rnd(); return r < CH_W[0] ? CHANNELS[0] : r < CH_W[0] + CH_W[1] ? CHANNELS[1] : CHANNELS[2]; };
  let rows = [];
  for (let i = 0; i < N_BASE; i++) {
    const m = pick(MONTHS);
    const day = int(1, DAYS[m]);
    const p = pick(PRODUCTS);
    const qty = int(1, 3);
    rows.push({ date: `2026-${pad2(m)}-${pad2(day)}`, m, customer: `C${String(int(1, N_CUSTOMERS)).padStart(4, '0')}`, ch: chOf(), cat: p.cat, name: p.name, qty, price: p.price, amt: qty * p.price, seq: i });
  }
  // 基底去掉「碰巧一模一樣」的單，讓 ③ 是唯一一組重複；也去掉跟 ③ 同簽名的
  const seen = new Set();
  rows = rows.filter((r) => { const s = sig(r); if (seen.has(s)) return false; seen.add(s); return true; });
  // ① 歸零：那個類別在最後一個月一筆都不留
  rows = rows.filter((r) => !(r.cat === ZERO_CAT.category && r.m === ZERO_CAT.month));
  // ② 缺週：那七天整週抽掉
  rows = rows.filter((r) => !inWeek(r.date));
  // ③ 重複下單：同一客戶同一天 6 張一模一樣（先清掉基底裡同簽名的，再插 6 張）
  const dp = prodOf(DUP.product);
  const dupRow = { date: DUP.date, m: Number(DUP.date.slice(5, 7)), customer: DUP.customer, ch: DUP.channel, cat: dp.cat, name: dp.name, qty: DUP.qty, price: dp.price, amt: DUP.qty * dp.price };
  rows = rows.filter((r) => sig(r) !== sig(dupRow));
  for (let k = 0; k < DUP.count; k++) rows.push({ ...dupRow, seq: N_BASE + k });
  // ④ 負數金額：插一筆單價與金額都是 -58,000 的單
  const np = prodOf(NEG.product);
  rows.push({ date: NEG.date, m: Number(NEG.date.slice(5, 7)), customer: NEG.customer, ch: NEG.channel, cat: np.cat, name: np.name, qty: NEG.qty, price: NEG.amount, amt: NEG.amount, negative: true, seq: N_BASE + DUP.count });
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
  rows.forEach((r, i) => { r.id = `SO${String(i + 1).padStart(5, '0')}`; });
  return rows;
}

// ---- 命中判定規則（truth.json 也帶一份人看得懂的說明）----
export const HIT_RULES = {
  zero_category: '同一句同時出現：類別名「文具」＋最後一個月（8 月／八月／2026-08／最後一個月）＋歸零語（歸零／為 0／0 元／沒有／一筆都沒／消失／中斷／停…）',
  missing_week: '同一句同時出現：缺週裡任一天的日期（7/13～7/19 任一寫法、7 月 13 日至 19 日、7 月第 3 週、7 月中旬、第 29 週、13～19 日區間）＋缺資料語（缺／沒有／空白／中斷／斷層／遺漏／無資料／一筆都沒／零訂單／零筆／掛零／空窗／停擺）',
  duplicate_orders: '同一句同時出現：客戶編號（或那 6 張單裡至少兩張的訂單編號）＋重複語（重複／一模一樣／相同／6 筆／6 張／六筆／多次下單）',
  negative_amount: '同一句出現帶負號的 -58,000（任一負號寫法、有無千分位皆可）；或同一句同時出現該筆的訂單編號／58,000 ＋ 負數語（負／負數／負值／小於 0）',
};
export const FALSE_ALARM_RULE = '成品裡帶「異常／不對勁／值得注意／可疑／有誤／錄錯／錯誤／不合理／奇怪／警訊／需確認／留意」的句子，若本身沒命中四個異常任一條，且句中點名的商品／類別／客戶編號／訂單編號／通路／日期全都不在四個異常的要素裡（每個異常的訂單編號、客戶、商品、類別、通路、日期都算要素），算一個誤報；同一組被點名的要素只算一次。句子有異常語但沒點名任何要素＝判不準，記 notes 不計數。';

export function buildTruth(rows) {
  const sum = (xs) => xs.reduce((a, r) => a + r.amt, 0);
  const month_revenue = Object.fromEntries(MONTHS.map((m) => [m, sum(rows.filter((r) => r.m === m))]));
  const month_orders = Object.fromEntries(MONTHS.map((m) => [m, rows.filter((r) => r.m === m).length]));
  const category_month_revenue = Object.fromEntries(Object.keys(CATEGORIES).map((c) => [c, Object.fromEntries(MONTHS.map((m) => [m, sum(rows.filter((r) => r.cat === c && r.m === m))]))]));
  const weekly_orders = {};
  for (const r of rows) { const w = weekMonday(r.date); weekly_orders[w] = (weekly_orders[w] ?? 0) + 1; }
  // 缺週在表裡要以 0 出現（沒有任何一筆落在那週）
  weekly_orders[MISSING_WEEK.start] = weekly_orders[MISSING_WEEK.start] ?? 0;
  const dupRows = rows.filter((r) => r.customer === DUP.customer && r.date === DUP.date && r.name === DUP.product);
  const negRow = rows.find((r) => r.negative);
  const dp = prodOf(DUP.product);
  return {
    rows: rows.length,
    month_revenue,
    month_orders,
    category_month_revenue,
    weekly_orders: Object.fromEntries(Object.entries(weekly_orders).sort(([a], [b]) => a.localeCompare(b))),
    anomalies: {
      zero_category: {
        category: ZERO_CAT.category, month: ZERO_CAT.month, month_label: `2026-${pad2(ZERO_CAT.month)}`,
        products: CATEGORIES[ZERO_CAT.category].map(([n]) => n),
        revenue_by_month: category_month_revenue[ZERO_CAT.category],
        hit_rule: HIT_RULES.zero_category,
      },
      missing_week: { start: MISSING_WEEK.start, end: MISSING_WEEK.end, days: weekDays(MISSING_WEEK.start), hit_rule: HIT_RULES.missing_week },
      duplicate_orders: {
        customer: DUP.customer, date: DUP.date, product: DUP.product, category: dp.cat, channel: DUP.channel, qty: DUP.qty, price: dp.price, amount: DUP.qty * dp.price,
        count: dupRows.length, order_ids: dupRows.map((r) => r.id), hit_rule: HIT_RULES.duplicate_orders,
      },
      negative_amount: {
        order_id: negRow.id, date: NEG.date, customer: NEG.customer, product: NEG.product, category: negRow.cat, channel: NEG.channel, amount: NEG.amount, hit_rule: HIT_RULES.negative_amount,
      },
    },
    false_alarm_rule: FALSE_ALARM_RULE,
    pass_rule: '抓到 ≥3 且誤報 ≤1',
  };
}

function weekDays(start) {
  const out = []; const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < 7; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

export async function generate(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const rows = buildRows();
  const csvPath = path.join(dataDir, 'sales.csv');
  const bytes = writeCsv(csvPath, HEADERS, rows.map((r) => [r.id, r.date, r.customer, r.ch, r.cat, r.name, r.qty, r.price, r.amt]));
  const truth = buildTruth(rows);
  truth.bytes = bytes;
  const A = truth.anomalies;
  if (rows.length < 1500 || rows.length > 3000) throw new Error(`q9 造資料：${rows.length} 筆不在 1,500～3,000 之間`);
  if (A.zero_category.revenue_by_month[ZERO_CAT.month] !== 0) throw new Error('q9 造資料：歸零類別最後一月不是 0');
  if (A.duplicate_orders.count !== DUP.count) throw new Error(`q9 造資料：重複單 ${A.duplicate_orders.count} ≠ ${DUP.count}`);
  if (truth.weekly_orders[MISSING_WEEK.start] !== 0) throw new Error('q9 造資料：缺週還有資料');
  fs.writeFileSync(path.join(dataDir, 'truth.json'), JSON.stringify(truth, null, 2));
  return { files: [{ name: 'sales.csv', path: csvPath }], truth };
}

// ---- 三步指示（使用者口吻；兩邊逐字相同）----
export const STEP1 = `附件 sales.csv 是 2026 年 6、7、8 月的訂單明細（欄位：訂單編號、日期、客戶編號、通路、商品類別、商品、數量、單價、金額）。照原始資料算，不要自行修正或剔除任何一筆：
三個月各月的營收與訂單數、各商品類別每個月的營收、每週（週一到週日）的訂單數。`;
export const STEP2 = '幫我看這三個月的銷售有什麼不對勁的地方，列出來並說明。根據上面的數字和原始明細去看，每一項要具體寫到是哪個類別／商品／客戶編號／訂單編號／日期區間、金額或筆數是多少、為什麼不對勁。沒有把握的不要硬湊。';
export const STEP3 = '整理成一頁給主管看的報告：開頭一段總結，接著三個月的數字表，然後逐項列出不對勁的地方與建議怎麼處理。';

export function flowDef() {
  const node = (nid, t, instruction, next, extra = {}) => ({ id: nid, title: t, executor: 'ai', stop_point: 'never', model_tier: 'balanced', instruction, next, ...extra });
  return {
    format: 1,
    name: '金絲雀 q9：三個月銷售找不對勁',
    params: [],
    permissions: { files: true, connectors: false },
    check: { enabled: false },
    supervisor: { enabled: false },
    nodes: [
      node('numbers', '算數字', STEP1, ['anomalies'], { attachments: ['sales.csv'] }),
      node('anomalies', '找不對勁的地方', STEP2, ['report']),
      node('report', '寫成報告', STEP3, []),
    ],
  };
}

export function ccPrompt() {
  return `目前資料夾裡的 sales.csv 就是附件。請依序做完三件事：\n一、${STEP1}\n二、${STEP2}\n三、${STEP3}\n最後把報告全文寫進 report.md。`;
}

// ---- 計分 ----
function dateForms(iso) {
  const [, mm, dd] = iso.split('-');
  const m = Number(mm); const d = Number(dd);
  return [iso, `${mm}-${dd}`, `${m}/${d}`, `${mm}/${dd}`, `${m}月${d}日`, `${m} 月 ${d} 日`, `${m}月${d}`, `${mm}月${dd}日`, `${m}月 ${d}日`];
}
const hasAny = (s, words) => words.some((w) => s.includes(w));

const LAST_MONTH = /8\s*月|八月|2026-08|2026\/8|08\s*月|最後一個月|最後一月|最近一個月|第三個月|末月/;
const ZERO_WORDS = /歸零|掛零|為\s*零|零\s*元|0\s*元|沒有|無任何|完全沒|一筆都|一張都|消失|中斷|斷貨|停售|停止|下架|零筆|0\s*筆|(?<![\d.,])0(?![\d.,%])/;
// 缺資料語：2026-09-24 真趟後補「零訂單／零筆／掛零／歸零／斷層／沒有任何／停擺／當機／0 筆／0 訂單」
const ABSENT_WORDS = /缺|沒有|沒資料|無資料|無任何|空白|中斷|斷層|斷檔|斷崖|遺漏|漏|一筆都|一張都|零\s*(筆|張|單|訂單)|0\s*(筆|張|單|訂單)|掛零|歸零|空窗|停擺|當機|missing|gap/i;
const DUP_WORDS = /重複|重覆|一模一樣|相同|同樣|6\s*(筆|張|次|單)|六\s*(筆|張|次)|多次下單|連續下|重送|duplicate/i;
const NEG_WORDS = /負|小於\s*0|<\s*0|negative|minus/i;
const ALARM_WORDS = /異常|不對勁|值得注意|可疑|有誤|錄錯|錯誤|不合理|奇怪|警訊|需要確認|需確認|留意/;

// ① 類別＋最後一月＋歸零語 同句
export function zeroCatNamed(s, A) {
  return s.includes(A.zero_category.category) && LAST_MONTH.test(s) && ZERO_WORDS.test(s);
}
// ② 缺週的任一天／指到那週的寫法 ＋ 缺資料語 同句
export function missingWeekNamed(s, A) {
  const W = A.missing_week;
  const words = W.days.flatMap(dateForms);
  const m = Number(W.start.slice(5, 7));
  words.push(`${m} 月第 3 週`, `${m}月第3週`, `${m} 月第三週`, `${m}月第三週`, `${m} 月中旬`, `${m}月中旬`, '第 29 週', '第29週', '第 29 周', '第29周');
  // 區間寫法：「13～19 日」「7月13日至19日」（同月只寫一次月份）「7/13-19」
  const range = /(?<![\d])1[3-9]\s*[日號]?\s*(?:[~～\-–—]|至|到)\s*(?:0?7\s*[\/\-月]\s*)?1[3-9]\s*[日號]?/;
  return (hasAny(s, words) || range.test(s)) && ABSENT_WORDS.test(s);
}
// ③ 客戶編號（或至少兩張重複單的訂單編號）＋ 重複語 同句
export function duplicateNamed(s, A) {
  const D = A.duplicate_orders;
  const idHits = D.order_ids.filter((oid) => s.includes(oid)).length;
  return (s.includes(D.customer) || idHits >= 2) && DUP_WORDS.test(s);
}
// ④ 帶負號的金額；或 訂單編號／無號金額 ＋ 負數語 同句
export function negativeNamed(s, A) {
  const G = A.negative_amount;
  const abs = Math.abs(G.amount);
  const signed = new RegExp(`[-−－]\\s?(${abs}|${abs.toLocaleString('en-US')})(?![\\d])`);
  const unsigned = new RegExp(`(?<![\\d.,])(${abs}|${abs.toLocaleString('en-US')})(?![\\d])`);
  if (signed.test(s)) return true;
  return (s.includes(G.order_id) || unsigned.test(s)) && NEG_WORDS.test(s);
}

// 四個異常的要素集合：句子裡點到任一個，就不算「編出來的」
function knownEntities(A) {
  const Z = A.zero_category; const D = A.duplicate_orders; const G = A.negative_amount;
  // 每個異常的訂單編號、客戶、商品、類別、通路、日期全算真要素（2026-09-24 真趟：④ 的建議句提到「門市」「包款」被冤枉成誤報）
  const set = new Set([
    Z.category, ...Z.products,
    D.customer, ...D.order_ids, D.product, D.category, D.channel,
    G.order_id, G.customer, G.product, G.category, G.channel,
  ]);
  for (const d of [...A.missing_week.days, D.date, G.date]) for (const f of dateForms(d)) set.add(f);
  return set;
}
// 句子裡點名的要素：商品／類別／客戶編號／訂單編號／通路／具體日期
function entitiesIn(s) {
  const out = [];
  for (const c of Object.keys(CATEGORIES)) if (s.includes(c)) out.push(c);
  for (const p of PRODUCTS) if (s.includes(p.name)) out.push(p.name);
  for (const c of CHANNELS) if (s.includes(c)) out.push(c);
  out.push(...(s.match(/C\d{4}/g) ?? []));
  out.push(...(s.match(/SO\d{5}/g) ?? []));
  for (const m of s.matchAll(/(?<![\d])(?:2026[-\/])?0?([678])\s*[-\/月]\s*(\d{1,2})\s*日?(?![\d])/g)) out.push(`2026-${pad2(m[1])}-${pad2(m[2])}`);
  return [...new Set(out)];
}

// 一次算完：四個異常各有沒有命中、誤報清單、判不準清單
export function detect(text, truth) {
  const A = truth.anomalies;
  const ss = sentences(text);
  const hits = { zero_category: false, missing_week: false, duplicate_orders: false, negative_amount: false };
  const known = knownEntities(A);
  const isKnown = (e) => known.has(e);
  const falseAlarms = new Map(); const unclear = [];
  for (const s of ss) {
    const h = { zero_category: zeroCatNamed(s, A), missing_week: missingWeekNamed(s, A), duplicate_orders: duplicateNamed(s, A), negative_amount: negativeNamed(s, A) };
    for (const k of Object.keys(hits)) if (h[k]) hits[k] = true;
    if (!ALARM_WORDS.test(s)) continue;
    if (Object.values(h).some(Boolean)) continue;               // 這句講的是四個異常之一
    const ents = entitiesIn(s);
    if (!ents.length) { unclear.push(s); continue; }             // 有異常語但沒點名任何要素：判不準
    if (ents.some(isKnown)) continue;                            // 點到四個異常的要素：不算編的
    const key = ents.slice().sort().join('+');
    if (!falseAlarms.has(key)) falseAlarms.set(key, s);
  }
  return { hits, falseAlarms: [...falseAlarms.entries()].map(([entities, sentence]) => ({ entities, sentence })), unclear };
}

const LABELS = { zero_category: '文具類 8 月營收歸零', missing_week: '7/13–7/19 整週缺資料', duplicate_orders: 'C0187 同日 6 張一模一樣的單', negative_amount: '一筆金額 -58,000' };

export async function score({ finalText, truth }) {
  const text = finalText ?? '';
  const r = detect(text, truth);
  const caught = Object.values(r.hits).filter(Boolean).length;
  const misses = Object.keys(r.hits).filter((k) => !r.hits[k]).map((k) => `沒點名：${LABELS[k]}`);
  const false_alarms = r.falseAlarms.length;
  const notes = [];
  if (!text.trim()) notes.push('成品是空的');
  for (const f of r.falseAlarms) notes.push(`誤報（${f.entities}）：${f.sentence.slice(0, 80)}`);
  for (const s of r.unclear.slice(0, 5)) notes.push(`判不準（有異常語但沒點名要素，不計）：${s.slice(0, 80)}`);
  return {
    pass: caught >= 3 && false_alarms <= 1,
    metrics: { primary: caught, primary_label: '抓到異常（/4）', errors: (4 - caught) + false_alarms, false_alarms, hits: r.hits, unclear: r.unclear.length },
    misses,
    notes,
  };
}
