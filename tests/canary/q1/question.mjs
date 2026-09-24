// q1 月報異常：reviews/對照測試-2026-09-23 的月報題搬成金絲雀模組。
// gen 逐字沿用 gen-data.mjs 的種子與商品（truth 相同）；三步指示逐字沿用 steps.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { makeRng } from '../lib/seed.mjs';
import { writeCsv } from '../lib/csv.mjs';
import { num, pct, count, countUnit, matchKeys, coOccur, sentences } from '../lib/text.mjs';

export const id = 'q1';
export const title = '月報＋找異常（200 筆）';
export const kind = 'compare';
export const anomalies = ['8 月退貨集中在羊毛圍巾'];

// ---- 三步指示（逐字＝reviews/對照測試-2026-09-23/steps.mjs）----
export const STEP1 = `附件 sales.csv 是 2026 年 7、8 月的訂單明細。算出以下數字（營收只算狀態為「完成」的訂單，退貨不算）：
8 月完成訂單數、8 月營收、客單價（營收÷完成訂單數，四捨五入到整數）、7 月營收、8 月對 7 月營收增減百分比（小數一位）、
8 月營收前三名商品與各自營收、8 月各通路營收與佔比（小數一位）、8 月退貨筆數與退貨金額。`;
export const STEP2 = '根據這些數字找出三個重點（成長動能、風險、異常各一），每點附一句原因推測與一句建議。';
export const STEP3 = '寫成一頁 8 月銷售月報給主管：開頭一段總結，接著數字表格、三個重點、下月建議。';

// ---- 造資料（逐字＝gen-data.mjs：種子 20260923、八個商品、三通路權重、8 月羊毛圍巾退貨 0.45）----
export const PRODUCTS = [
  ['經典帆布托特包', 1280], ['防潑水後背包', 2380], ['皮革短夾', 1680], ['旅行收納袋組', 690],
  ['亞麻漁夫帽', 880], ['手工陶瓷馬克杯', 560], ['香氛蠟燭禮盒', 1450], ['羊毛圍巾', 1980],
];
export const CHANNELS = ['官網', '蝦皮', '門市'];
const CH_W = { 7: [0.34, 0.40, 0.26], 8: [0.45, 0.33, 0.22] };

export function buildRows() {
  const { rnd, pick } = makeRng(20260923);
  const chOf = (m) => { const r = rnd(); const w = CH_W[m]; return r < w[0] ? CHANNELS[0] : r < w[0] + w[1] ? CHANNELS[1] : CHANNELS[2]; };
  const rows = [];
  let no = 1;
  for (const [m, n] of [[7, 92], [8, 108]]) {
    for (let i = 0; i < n; i++) {
      const [name, price] = pick(PRODUCTS);
      const qty = 1 + Math.floor(rnd() * 3);
      const day = 1 + Math.floor(rnd() * 31);
      const retP = m === 8 && name === '羊毛圍巾' ? 0.45 : 0.06;
      const status = rnd() < retP ? '退貨' : '完成';
      rows.push({ id: `SO${String(no++).padStart(5, '0')}`, date: `2026-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`, ch: chOf(m), name, qty, price, amt: qty * price, status, m });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return rows;
}

export function buildTruth(rows) {
  const done = (m) => rows.filter((r) => r.m === m && r.status === '完成');
  const sum = (xs) => xs.reduce((a, r) => a + r.amt, 0);
  const aug = done(8);
  const revAug = sum(aug);
  const revJul = sum(done(7));
  const byProd = {};
  for (const r of aug) byProd[r.name] = (byProd[r.name] ?? 0) + r.amt;
  const top3 = Object.entries(byProd).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const byCh = {};
  for (const r of aug) byCh[r.ch] = (byCh[r.ch] ?? 0) + r.amt;
  const ret = rows.filter((r) => r.m === 8 && r.status === '退貨');
  const r1 = (x) => Math.round(x * 10) / 10;
  const retByProd = Object.fromEntries(PRODUCTS.map(([name]) => [name, ret.filter((r) => r.name === name).length]));
  const julOrders = done(7).length;
  const augTop3 = top3.map(([name]) => name);
  return {
    forbidden: forbiddenOf({ retByProd, julOrders, augOrders: aug.length, top3: augTop3 }),
    jul_orders: julOrders,
    aug_returns_by_product: retByProd,
    aug_orders: aug.length,
    aug_revenue: revAug,
    aov: Math.round(revAug / aug.length),
    jul_revenue: revJul,
    mom_pct: r1((revAug - revJul) / revJul * 100),
    top3: top3.map(([name, rev]) => ({ name, rev })),
    channel_share: Object.fromEntries(CHANNELS.map((c) => [c, r1((byCh[c] ?? 0) / revAug * 100)])),
    channel_rev: Object.fromEntries(CHANNELS.map((c) => [c, byCh[c] ?? 0])),
    aug_returns: ret.length,
    aug_return_amount: sum(ret),
    scarf_returns: ret.filter((r) => r.name === '羊毛圍巾').length,
    // q5 用：8 月各商品營收全表（明細.xlsx「按商品」分頁要對）
    aug_product_rev: byProd,
    rows: rows.length,
  };
}

// ---- 不准出現的假話（列管 L079 三種型）：從 truth 推出、資料明確否定的主張 ----
// 型 zero-as-concentrated＝把退貨 0 筆的品項寫成退貨集中；型 growth-as-flat＝把有增的東西寫成沒增；
// 型 unrelated-as-same-group＝把兩件無關的事寫成同一群。truth.forbidden 只存資料（id／type／claim／要素），判法在 forbiddenRules。
export function forbiddenOf({ retByProd, julOrders, augOrders, top3 }) {
  const out = [];
  for (const [name, n] of Object.entries(retByProd)) {
    if (n === 0) out.push({ id: `${name}退貨集中（實際 0 筆）`, type: 'zero-as-concentrated', claim: `退貨集中在${name}`, product: name });
  }
  if (augOrders > julOrders) out.push({ id: `訂單數沒增（實際 ${julOrders}→${augOrders}）`, type: 'growth-as-flat', claim: '成長不是訂單數衝出來的／訂單數持平', subject: '訂單數' });
  const zeroInTop = top3.filter((name) => retByProd[name] === 0);
  if (zeroInTop.length) out.push({ id: `退貨與成長動能來自同一群品項（${zeroInTop.join('、')}退貨 0 筆）`, type: 'unrelated-as-same-group', claim: '退貨跟成長動能來自同一群高單價品項', products: zeroInTop });
  return out;
}

// 三種型各自的「要素共現」判法：同一句（sentences 切）裡、同一子句（逗號內）短距離同時出現要素；不是整句比對。
// 每條規則＝{ id, patterns:[RegExp…], unless?:RegExp, unlessFn?:(句)=>bool }：任一 pattern 命中且 unless／unlessFn 都沒命中＝這句是假話。
const CONC = '集中|偏高|最多|最高|最嚴重|嚴重|爆量|暴增|大增|主要來自|主要是|重災|居高';
const FLAT = '沒有增|沒增|未增|無增|沒有成長|沒成長|未成長|零成長|負成長|持平|下降|減少|下滑|衰退|不變|萎縮|縮水';
const SAME = '同一群|同一批|同一組|同一類|同樣一群|同樣一批|相同的一群|同一群組';
const NEG = '(不是|並非|而非|並不是|不是靠|不靠|非)';
const CL = '[^。，,、；;：:（）()]'; // 同一子句：逗號、頓號、括號都當邊界
export const RX = { CONC, FLAT, SAME, NEG, CL }; // q3 自己的型會用到同一套字
// custom(f)＝題目自己的型（q3 用）；回 null 就走這裡的三種標準型
export function forbiddenRules(truth, custom = null) {
  return (truth?.forbidden ?? []).map((f) => {
    const own = custom?.(f);
    if (own) return own;
    if (f.type === 'zero-as-concentrated') {
      const p = f.product;
      return {
        id: f.id,
        patterns: [
          new RegExp(`退貨${CL}{0,6}(${CONC})[^。]{0,24}${p}`), // 退貨集中在羊毛圍巾、防潑水後背包
          new RegExp(`${p}${CL}{0,6}(的)?退貨(率|量|筆數|金額)?${CL}{0,6}(${CONC}|率高|率偏高)`), // 防潑水後背包退貨偏高
          new RegExp(`退貨(率|量|筆數|金額)?${CL}{0,2}(${CONC})的?(是|為|在|：|:)?${CL}{0,12}${p}`), // 退貨最多的是防潑水後背包
        ],
        unless: new RegExp(`${p}${CL}{0,8}(退貨)?${CL}{0,4}(0\\s?筆|零退貨|沒有退貨|無退貨|未退貨|沒退貨|退貨為零|退貨 ?0|一筆都沒)`),
      };
    }
    if (f.type === 'growth-as-flat') {
      const s = '訂單數|訂單量|單量|完成訂單數|訂單筆數';
      return {
        id: f.id,
        patterns: [
          new RegExp(`${NEG}${CL}{0,4}(${s})${CL}{0,6}(衝|撐|帶|拉|推|增|多|來|貢獻)`), // 不是訂單數衝出來的
          new RegExp(`(${s})${CL}{0,8}(${FLAT})`), // 訂單數持平／訂單數沒有增加
          new RegExp(`(${s})${CL}{0,6}${NEG}${CL}{0,6}(主因|原因|來源|動能|推手|關鍵|貢獻)`), // 訂單數不是主因
          new RegExp(`(靠|來自|由|全靠)${CL}{0,6}(客單價|單價|平均單價)[^。]{0,10}${NEG}${CL}{0,4}(訂單|單量)`), // 靠客單價拉高，而非訂單數
        ],
      };
    }
    if (f.type === 'unrelated-as-same-group') {
      const g = '成長|動能|營收|熱銷|暢銷|主力|前三名|高單價';
      return {
        id: f.id,
        patterns: [
          new RegExp(`退貨[^。]{0,24}(${g})[^。]{0,16}(${SAME})`), // 退貨跟成長動能來自同一群
          new RegExp(`(${g})[^。]{0,24}退貨[^。]{0,16}(${SAME})`), // 成長動能與退貨來自同一批
          new RegExp(`(${SAME})[^。]{0,16}(品項|商品|產品)[^。]{0,24}退貨[^。]{0,16}(${g})`), // 同一群品項既撐起成長也貢獻退貨
          new RegExp(`(${SAME})[^。]{0,16}(品項|商品|產品)[^。]{0,24}(${g})[^。]{0,16}退貨`),
        ],
      };
    }
    return { id: f.id, patterns: [] };
  });
}

// 回命中的規則 id 陣列：每條規則最多記一次
export function forbiddenHits(text, truth, custom = null) {
  const hits = [];
  const sents = sentences(text);
  for (const rule of forbiddenRules(truth, custom)) {
    const hit = sents.some((s) => rule.patterns.some((re) => re.test(s)) && !(rule.unless && rule.unless.test(s)) && !(rule.unlessFn && rule.unlessFn(s)));
    if (hit) hits.push(rule.id);
  }
  return hits;
}

export const HEADERS = ['訂單編號', '日期', '通路', '商品', '數量', '單價', '金額', '狀態'];

export async function generate(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const rows = buildRows();
  const csvPath = path.join(dataDir, 'sales.csv');
  writeCsv(csvPath, HEADERS, rows.map((r) => [r.id, r.date, r.ch, r.name, r.qty, r.price, r.amt, r.status]));
  const truth = buildTruth(rows);
  fs.writeFileSync(path.join(dataDir, 'truth.json'), JSON.stringify(truth, null, 2));
  return { files: [{ name: 'sales.csv', path: csvPath }], truth };
}

// ---- 剝繭流程：三步（算數字→找三個重點→寫成月報），Sonnet、查核與監工關、可寫程式算 ----
export function flowDef() {
  const node = (nid, t, instruction, next, extra = {}) => ({ id: nid, title: t, executor: 'ai', stop_point: 'never', model_tier: 'balanced', instruction, next, ...extra });
  return {
    format: 1,
    name: '金絲雀 q1：8 月銷售月報',
    params: [],
    permissions: { files: true, connectors: false },
    check: { enabled: false },
    supervisor: { enabled: false },
    nodes: [
      node('numbers', '算數字', STEP1, ['points'], { attachments: ['sales.csv'] }),
      node('points', '找三個重點', STEP2, ['report']),
      node('report', '寫成月報', STEP3, []),
    ],
  };
}

// ---- Claude Code 一句話（逐字＝對照測試 armCC 的 prompt）----
export function ccPrompt() {
  return `目前資料夾裡的 sales.csv 就是附件。請依序做完三件事：\n一、${STEP1}\n二、${STEP2}\n三、${STEP3}\n最後把月報全文寫進 report.md。`;
}

// ---- 計分：13 項關鍵數字命中＋「羊毛圍巾」與「退貨」同句出現＝抓到異常＋不准出現的假話反向計分（命中一句＝errors＋1、列進 misses）----
export function keysOf(T) {
  return [
    ['8月完成訂單數', count(T.aug_orders)],
    ['8月營收', num(T.aug_revenue)],
    ['客單價', num(T.aov)],
    ['7月營收', num(T.jul_revenue)],
    ['月增減%', pct(T.mom_pct)],
    ...T.top3.map((p, i) => [`第${i + 1}名營收（${p.name}）`, num(p.rev)]),
    ...Object.entries(T.channel_share).map(([c, v]) => [`${c}佔比`, pct(v)]),
    ['退貨筆數', countUnit(T.aug_returns)],
    ['退貨金額', num(T.aug_return_amount)],
  ];
}

export async function score({ finalText, truth }) {
  const text = finalText ?? '';
  const m = matchKeys(text, keysOf(truth));
  const anomaly = coOccur(text, ['羊毛圍巾'], ['退貨', '退回']);
  const falseClaims = forbiddenHits(text, truth);
  const notes = [];
  if (!text.trim()) notes.push('成品是空的');
  const misses = [...m.misses, ...falseClaims.map((id) => `假話：${id}`)];
  const errors = m.misses.length + falseClaims.length;
  return {
    pass: anomaly && errors <= 2, // 抓到異常、且錯誤（13 項沒命中＋假話）最多 2 個——覆核段「合計錯 N 個（目標 ≤2）」把假話算進錯裡，這裡跟它同一把尺
    metrics: { primary: anomaly ? 1 : 0, primary_label: '抓到異常', errors, false_claims: falseClaims.length, keys_ok: m.ok, keys_total: m.total, anomaly },
    misses,
    notes,
  };
}
