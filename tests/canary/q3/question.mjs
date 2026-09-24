// q3 大資料量：5,000 筆、三個月（6～8 月）、約 400KB CSV；埋兩個異常：
//   ① 蝦皮在 7/13–7/19 那一週退貨筆數是平常的 4 倍以上；② 手工陶瓷馬克杯有 30 筆單價錄成十倍（5,600）。
// 三步同 q1 的結構：算數字 → 找三個重點含異常 → 月報。truth 照原始資料算（錄錯的那 30 筆不修正——指示也這麼講）。
import fs from 'node:fs';
import path from 'node:path';
import { makeRng } from '../lib/seed.mjs';
import { writeCsv } from '../lib/csv.mjs';
import { num, pct, countUnit, matchKeys, sentences } from '../lib/text.mjs';
import { forbiddenHits, RX } from '../q1/question.mjs';
export { forbiddenHits };

export const id = 'q3';
export const title = '大資料量月報（5,000 筆・兩個異常）';
export const kind = 'compare';
export const anomalies = ['蝦皮 7/13–7/19 退貨暴增（≥4 倍）', '手工陶瓷馬克杯 30 筆單價錄成十倍'];

const SEED = 20260924;
const N = 5000;
export const PRODUCTS = [
  ['經典帆布托特包', 1280], ['防潑水後背包', 2380], ['皮革短夾', 1680], ['旅行收納袋組', 690],
  ['亞麻漁夫帽', 880], ['手工陶瓷馬克杯', 560], ['香氛蠟燭禮盒', 1450], ['羊毛圍巾', 1980],
  ['不鏽鋼保溫瓶', 990], ['棉麻餐墊組', 450], ['真皮鑰匙圈', 380], ['帆布筆袋', 320],
];
export const CHANNELS = ['官網', '蝦皮', '門市'];
const CH_W = [0.42, 0.35, 0.23];
const CITIES = ['台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市', '新竹市', '基隆市'];
const PAYS = ['信用卡', '貨到付款', '銀行轉帳', '行動支付'];
const DAYS = { 6: 30, 7: 31, 8: 31 };
export const SPIKE = { channel: '蝦皮', week_start: '2026-07-13', week_end: '2026-07-19', p: 0.45 };
export const MISPRICED = { product: '手工陶瓷馬克杯', count: 30, wrong_price: 5600, true_price: 560 };
const BASE_RET_P = 0.05;

export const HEADERS = ['訂單編號', '日期', '通路', '商品', '數量', '單價', '金額', '狀態', '縣市', '付款方式'];

// 週一起算的那一週：回 'YYYY-MM-DD'（週一）
export function weekMonday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 週一=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function buildRows() {
  const { rnd, pick } = makeRng(SEED);
  const chOf = () => { const r = rnd(); return r < CH_W[0] ? CHANNELS[0] : r < CH_W[0] + CH_W[1] ? CHANNELS[1] : CHANNELS[2]; };
  const rows = [];
  for (let i = 0; i < N; i++) {
    const m = pick([6, 7, 8]);
    const day = 1 + Math.floor(rnd() * DAYS[m]);
    const date = `2026-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const ch = chOf();
    const [name, price] = pick(PRODUCTS);
    const qty = 1 + Math.floor(rnd() * 3);
    const inSpike = ch === SPIKE.channel && date >= SPIKE.week_start && date <= SPIKE.week_end;
    const status = rnd() < (inSpike ? SPIKE.p : BASE_RET_P) ? '退貨' : '完成';
    rows.push({ date, ch, name, qty, price, status, city: pick(CITIES), pay: pick(PAYS), m });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  rows.forEach((r, i) => { r.id = `SO${String(i + 1).padStart(5, '0')}`; });
  // ② 十倍單價：那個商品的訂單裡等距挑 30 筆
  const idx = rows.map((r, i) => (r.name === MISPRICED.product ? i : -1)).filter((i) => i >= 0);
  const step = Math.floor(idx.length / MISPRICED.count);
  const chosen = new Set(Array.from({ length: MISPRICED.count }, (_, k) => idx[k * step]));
  for (const i of chosen) { rows[i].price = MISPRICED.wrong_price; rows[i].mispriced = true; }
  for (const r of rows) r.amt = r.qty * r.price;
  return rows;
}

export function buildTruth(rows) {
  const sum = (xs) => xs.reduce((a, r) => a + r.amt, 0);
  const r1 = (x) => Math.round(x * 10) / 10;
  const done = rows.filter((r) => r.status === '完成');
  const month_revenue = Object.fromEntries([6, 7, 8].map((m) => [m, sum(done.filter((r) => r.m === m))]));
  const aug = done.filter((r) => r.m === 8);
  const byProd = {}; for (const r of aug) byProd[r.name] = (byProd[r.name] ?? 0) + r.amt;
  const byCh = {}; for (const r of aug) byCh[r.ch] = (byCh[r.ch] ?? 0) + r.amt;
  const augRet = rows.filter((r) => r.m === 8 && r.status === '退貨');
  // ① 週退貨：那個通路每週（週一起算）退貨筆數；尖峰週 vs 其他週平均
  const weekly = {};
  for (const r of rows.filter((x) => x.ch === SPIKE.channel && x.status === '退貨')) {
    const w = weekMonday(r.date); weekly[w] = (weekly[w] ?? 0) + 1;
  }
  const spikeCount = weekly[SPIKE.week_start] ?? 0;
  const others = Object.entries(weekly).filter(([w]) => w !== SPIKE.week_start).map(([, c]) => c);
  const baseline = others.reduce((a, b) => a + b, 0) / others.length;
  const mis = rows.filter((r) => r.mispriced);
  // 假話反向計分要用的推導值
  const retByProd = Object.fromEntries(PRODUCTS.map(([name]) => [name, augRet.filter((r) => r.name === name).length]));
  const spikeWeekRetByCh = Object.fromEntries(CHANNELS.map((c) => [c, rows.filter((r) => r.ch === c && r.status === '退貨' && r.date >= SPIKE.week_start && r.date <= SPIKE.week_end).length]));
  const chMonthRev = Object.fromEntries(CHANNELS.map((c) => [c, Object.fromEntries([6, 7, 8].map((m) => [m, sum(done.filter((r) => r.ch === c && r.m === m))]))]));
  const misInSpike = mis.filter((r) => r.ch === SPIKE.channel && r.date >= SPIKE.week_start && r.date <= SPIKE.week_end).length;
  const top3names = Object.entries(byProd).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name);
  return {
    forbidden: forbiddenOf({ retByProd, augReturns: augRet.length, top3: top3names, spikeWeekRetByCh, monthRevenue: month_revenue, chMonthRev, misInSpike, misCount: mis.length }),
    aug_returns_by_product: retByProd,
    spike_week_returns_by_channel: spikeWeekRetByCh,
    channel_month_rev: chMonthRev,
    rows: rows.length,
    month_revenue,
    aug_orders: aug.length,
    aug_revenue: month_revenue[8],
    top3: Object.entries(byProd).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, rev]) => ({ name, rev })),
    channel_share: Object.fromEntries(CHANNELS.map((c) => [c, r1((byCh[c] ?? 0) / month_revenue[8] * 100)])),
    channel_rev: Object.fromEntries(CHANNELS.map((c) => [c, byCh[c] ?? 0])),
    aug_returns: augRet.length,
    aug_return_amount: sum(augRet),
    spike: { channel: SPIKE.channel, week_start: SPIKE.week_start, week_end: SPIKE.week_end, returns: spikeCount, other_weeks_avg: r1(baseline), ratio: r1(spikeCount / baseline), weekly },
    mispriced: { product: MISPRICED.product, count: mis.length, wrong_price: MISPRICED.wrong_price, true_price: MISPRICED.true_price, order_ids: mis.map((r) => r.id) },
  };
}

// ---- 不准出現的假話（列管 L079 三種型，q3 版）：從 truth 推出、資料明確否定的主張 ----
//   low-as-concentrated（型①變體）：營收前三名裡退貨最少（不到各品項平均一半）的品項被寫成退貨集中
//   spike-wrong-channel（型①變體）：尖峰週退貨不到蝦皮四分之一的通路被寫成那週退貨暴增
//   month-growth-as-flat（型②）：8 月對 7 月有增（全站與各通路都增）被寫成下滑／持平
//   misprice-linked-to-spike（型③）：單價錄錯與蝦皮退貨潮被寫成同一批／有關（錄錯落在尖峰週蝦皮的不到兩成）
export function forbiddenOf({ retByProd, augReturns, top3, spikeWeekRetByCh, monthRevenue, chMonthRev, misInSpike, misCount }) {
  const out = [];
  const avg = augReturns / Object.keys(retByProd).length;
  for (const name of top3) {
    if (retByProd[name] < avg / 2) out.push({ id: `${name}退貨集中（實際 ${retByProd[name]} 筆／${augReturns}）`, type: 'low-as-concentrated', claim: `退貨集中在${name}`, product: name });
  }
  const peak = spikeWeekRetByCh[SPIKE.channel];
  for (const [c, n] of Object.entries(spikeWeekRetByCh)) {
    if (c !== SPIKE.channel && n * 4 <= peak) out.push({ id: `${c}在 ${SPIKE.week_start}～${SPIKE.week_end} 退貨暴增（實際 ${n} 筆，蝦皮 ${peak}）`, type: 'spike-wrong-channel', claim: `${c}那週退貨暴增`, channel: c });
  }
  if (monthRevenue[8] > monthRevenue[7]) out.push({ id: `8 月營收比 7 月下滑（實際 ${monthRevenue[7]}→${monthRevenue[8]}）`, type: 'month-growth-as-flat', claim: '8 月營收較 7 月下滑／持平', subject: null });
  for (const [c, m] of Object.entries(chMonthRev)) {
    if (m[8] > m[7]) out.push({ id: `${c} 8 月比 7 月下滑（實際 ${m[7]}→${m[8]}）`, type: 'month-growth-as-flat', claim: `${c}營收較 7 月下滑`, subject: c });
  }
  if (misInSpike * 5 <= misCount) out.push({ id: `單價錄錯與蝦皮退貨潮是同一批／有關（錄錯落在尖峰週蝦皮的只有 ${misInSpike}／${misCount}）`, type: 'misprice-linked-to-spike', claim: '馬克杯單價錄錯與蝦皮退貨暴增來自同一批訂單', product: MISPRICED.product });
  return out;
}

const { CONC, FLAT, CL } = RX;
const NOT = (words) => `(?:(?!${words})${CL})`; // 同一子句內、且中間不准出現這些字
const LINK = '同一批|同一群|同一週|同一波|同一組|導致|造成|引發|所致|連動|牽連|(?<!不|無|沒有|非|不相)(?:有關|相關|關聯)';
// q3 自己的型；不是 q3 的型就回 null（交回 q1 的三種標準型）
export function customRule(f) {
  if (f.type === 'low-as-concentrated') {
    const p = f.product;
    return {
      id: f.id,
      patterns: [
        new RegExp(`退貨${CL}{0,6}(${CONC})[^。]{0,24}${p}`),
        new RegExp(`${p}${CL}{0,6}(的)?退貨(率|量|筆數|金額)?${CL}{0,6}(${CONC}|率高|率偏高)`),
        new RegExp(`退貨(率|量|筆數|金額)?${CL}{0,2}(${CONC})的?(是|為|在|：|:)?${CL}{0,12}${p}`),
      ],
      unless: new RegExp(`${p}${CL}{0,8}(退貨)?${CL}{0,4}(退貨)?(最少|最低|很少|偏低|不多|只有 ?\\d)`),
    };
  }
  if (f.type === 'spike-wrong-channel') {
    const c = f.channel;
    const week = weekWords(SPIKE);
    return {
      id: f.id,
      patterns: [
        new RegExp(`${c}${NOT('蝦皮')}{0,20}退貨${CL}{0,8}(暴增|激增|飆升|飆高|大增|翻倍|異常|集中|倍|爆量)`),
        new RegExp(`退貨${CL}{0,8}(暴增|激增|飆升|飆高|大增|翻倍|異常|集中|爆量)${NOT('蝦皮|而非|不是|並非|排除|沒有|未見|正常')}{0,12}${c}`),
      ],
      // 沒提到那一週的句子不算（整月來看官網退貨本來就最多）；明說那通路那週正常的也不算
      unlessFn: (s) => !week.some((w) => s.includes(w)) || new RegExp(`${c}${CL}{0,10}(正常|沒有異常|無異常|平穩|持平|各 ?\\d+ ?筆)`).test(s),
    };
  }
  if (f.type === 'month-growth-as-flat') {
    const subj = f.subject ? f.subject : '(營收|業績|銷售額|銷售|收入)';
    const stop = ['退貨', '訂單', '筆數', '客單價', '6 ?月', ...CHANNELS.filter((c) => c !== f.subject)].join('|'); // 通路句：中間換了別的通路就不算這條
    return {
      id: f.id,
      patterns: [
        new RegExp(`${subj}${NOT(stop)}{0,12}(較|比|對|相較|相比|相較於|對比|vs)\\s?7\\s?月${NOT(stop)}{0,12}(${FLAT}|低|少)`), // 8月營收比7月下滑；官網較7月減少
        new RegExp(`(較|比|相較|相比|對比)\\s?7\\s?月${NOT(stop)}{0,12}${subj}${NOT(stop)}{0,8}(${FLAT}|低|少)`), // 比7月營收少
        new RegExp(`7\\s?月${CL}{0,4}(到|至|→|~|～|－|-)\\s?8\\s?月${NOT(stop)}{0,6}${subj}${NOT(stop)}{0,8}(${FLAT})`), // 7月到8月營收下滑
        new RegExp(`${subj}(?:(?!${stop})[^。]){0,40}(較|比|相較|相比|對比)\\s?7\\s?月${NOT(stop)}{0,8}(${FLAT}|低|少)`), // 8 月營收 3,440,260 元，比 7 月下滑（主詞在前一個子句）
      ],
    };
  }
  if (f.type === 'misprice-linked-to-spike') {
    const mis = '(馬克杯|錄錯|輸入錯|單價(異常|錯誤|不一致)|十倍|10 ?倍|多一個零)';
    return {
      id: f.id,
      patterns: [
        new RegExp(`${mis}[^。]{0,30}(${LINK})[^。]{0,24}退貨`), // 錄錯…導致…退貨
        new RegExp(`退貨[^。]{0,30}(${LINK})[^。]{0,24}${mis}`), // 退貨…同一批…錄錯
        new RegExp(`${mis}[^。]{0,40}退貨[^。]{0,20}(${LINK})`), // 錄錯 30 筆，與蝦皮退貨暴增來自同一批
        new RegExp(`退貨[^。]{0,40}${mis}[^。]{0,20}(${LINK})`), // 退貨潮很可能是錄錯單價導致
      ],
    };
  }
  return null;
}

export async function generate(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const rows = buildRows();
  const csvPath = path.join(dataDir, 'sales.csv');
  const bytes = writeCsv(csvPath, HEADERS, rows.map((r) => [r.id, r.date, r.ch, r.name, r.qty, r.price, r.amt, r.status, r.city, r.pay]));
  const truth = buildTruth(rows);
  truth.bytes = bytes;
  if (truth.spike.ratio < 4) throw new Error(`q3 造資料：尖峰週只有平常的 ${truth.spike.ratio} 倍，不到 4 倍——換種子`);
  if (truth.mispriced.count !== MISPRICED.count) throw new Error(`q3 造資料：錄錯筆數 ${truth.mispriced.count} ≠ ${MISPRICED.count}`);
  fs.writeFileSync(path.join(dataDir, 'truth.json'), JSON.stringify(truth, null, 2));
  return { files: [{ name: 'sales.csv', path: csvPath }], truth };
}

// ---- 三步指示（使用者口吻；兩邊逐字相同）----
export const STEP1 = `附件 sales.csv 是 2026 年 6、7、8 月的訂單明細（約 5,000 筆）。照原始資料算（不要自行修正任何數值），營收只算狀態為「完成」的訂單，退貨不算：
6 月營收、7 月營收、8 月營收、8 月完成訂單數、8 月營收前三名商品與各自營收、8 月各通路營收與佔比（小數一位）、8 月退貨筆數與退貨金額、
以及各通路每週（週一到週日）的退貨筆數表。`;
export const STEP2 = '根據這些數字與原始明細找出三個重點（成長動能、風險、異常各一），每點附一句原因推測與一句建議。異常要具體到通路、日期區間、商品、筆數；如果懷疑有資料錄錯（例如同一商品單價不一致）也要明講。';
export const STEP3 = '寫成一頁 8 月銷售月報給主管：開頭一段總結，接著數字表格（含三個月營收）、三個重點、下月建議。';

export function flowDef() {
  const node = (nid, t, instruction, next, extra = {}) => ({ id: nid, title: t, executor: 'ai', stop_point: 'never', model_tier: 'balanced', instruction, next, ...extra });
  return {
    format: 1,
    name: '金絲雀 q3：三個月 5,000 筆月報',
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

export function ccPrompt() {
  return `目前資料夾裡的 sales.csv 就是附件。請依序做完三件事：\n一、${STEP1}\n二、${STEP2}\n三、${STEP3}\n最後把月報全文寫進 report.md。`;
}

// ---- 計分 ----
export function keysOf(T) {
  return [
    ['6月營收', num(T.month_revenue[6])],
    ['7月營收', num(T.month_revenue[7])],
    ['8月營收', num(T.month_revenue[8])],
    ['8月完成訂單數', num(T.aug_orders)], // 1,539 有千分位，count() 對不上
    ...T.top3.map((p, i) => [`第${i + 1}名營收（${p.name}）`, num(p.rev)]),
    ...Object.entries(T.channel_share).map(([c, v]) => [`${c}佔比`, pct(v)]),
    ['8月退貨筆數', countUnit(T.aug_returns)],
  ];
}

// 尖峰週被點名：通路名＋（那一週任一天的日期，或「第 N 週」／「7 月中」這類指到那週的寫法）同句
function dateForms(iso) {
  const [, mm, dd] = iso.split('-');
  const m = Number(mm); const d = Number(dd);
  return [`${mm}-${dd}`, `${m}/${d}`, `${mm}/${dd}`, `${m}月${d}日`, `${m} 月 ${d} 日`, `${m}月${d}`, `${mm}月${dd}日`];
}
export function weekWords(spike) {
  const days = [];
  const d = new Date(`${spike.week_start}T00:00:00Z`);
  for (let i = 0; i < 7; i++) { days.push(...dateForms(d.toISOString().slice(0, 10))); d.setUTCDate(d.getUTCDate() + 1); }
  const m = Number(spike.week_start.slice(5, 7));
  return [...days, `${m} 月第 3 週`, `${m}月第3週`, `${m} 月第三週`, `${m}月第三週`, `${m} 月中旬`, `${m}月中旬`, '第 29 週', '第29週'];
}
export function spikeNamed(text, spike) {
  const words = weekWords(spike);
  return sentences(text).some((s) => s.includes(spike.channel) && /退貨|退回/.test(s) && words.some((w) => s.includes(w)));
}
// 錄錯被點名：商品名＋（單價／十倍／錄錯／多一個零／異常高／5,600 或 5600）同句
export function mispriceNamed(text, mis) {
  const words = ['單價', '十倍', '10 倍', '10倍', '錄錯', '輸入錯', '多一個零', '多了一個零', '異常', '錯誤', String(mis.wrong_price), mis.wrong_price.toLocaleString('en-US')];
  return sentences(text).some((s) => s.includes(mis.product) && words.some((w) => s.includes(w)));
}

export async function score({ finalText, truth }) {
  const text = finalText ?? '';
  const m = matchKeys(text, keysOf(truth));
  const spike = spikeNamed(text, truth.spike);
  const mis = mispriceNamed(text, truth.mispriced);
  const caught = (spike ? 1 : 0) + (mis ? 1 : 0);
  const falseClaims = forbiddenHits(text, truth, customRule);
  const notes = [];
  if (!text.trim()) notes.push('成品是空的');
  if (!spike) notes.push('沒點名蝦皮 7/13–7/19 退貨暴增');
  if (!mis) notes.push('沒點名手工陶瓷馬克杯單價錄成十倍');
  const misses = [...m.misses, ...falseClaims.map((id) => `假話：${id}`)];
  const errors = m.misses.length + falseClaims.length;
  return {
    pass: caught >= 1 && errors <= 3, // 兩個異常至少抓到一個、錯誤（11 項沒命中＋假話）最多 3 個
    metrics: { primary: caught, primary_label: '抓到異常（/2）', errors, false_claims: falseClaims.length, keys_ok: m.ok, keys_total: m.total, spike, mispriced: mis },
    misses,
    notes,
  };
}
