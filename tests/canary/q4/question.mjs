// 金絲雀 q4：多來源交叉比對——Excel 庫存＋CSV 訂單＋Markdown 供應商交期
// 介面照 ../CONTRACT.md。模組自帶小工具（seed 亂數、CSV 寫入），xlsx 用 bojian 自帶的 exceljs。
//
// 陷阱：訂單 CSV 裡三成 SKU 寫法歪掉（小寫 sk-001、含空格 SK 001、前後空白），庫存表全是 SK-001。
//   沒對齊就會少算三成需求，前五名會錯；truth 用「對齊後」的答案，並在造資料時確認
//   「不對齊的前五名」≠「對齊後的前五名」（陷阱真的會咬人）。
// 口徑（寫進題目，兩邊一致）：
//   - 今天固定 2026-10-01
//   - 某 SKU 需求量＝該 SKU 全部未出貨訂單數量加總；缺貨風險＝需求量－現有庫存，前五名取最大者
//   - 庫存不足＝需求量＞現有庫存；會延遲的訂單＝庫存不足的 SKU 之訂單，且（需求日－今天）的天數＜補貨天數
// 評分：前五名命中數（主指標，順序不計）、延遲訂單命中率與多列錯的筆數、有沒有點出編號寫法不一致
//   errors ＝ 前五名沒命中數 ＋ 列出的延遲訂單裡錯的筆數
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

export const id = 'q4';
export const title = '多來源交叉比對：庫存×訂單×交期';
export const kind = 'compare';
export const anomalies = ['訂單 SKU 三成寫法不一致（小寫／含空格）', '缺貨風險前五名', '會延遲的訂單清單'];

// ---------- 小工具 ----------
function makeRnd(seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  return { rnd, pick, int };
}
const csvLine = (cells) => cells.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',');
const TODAY = '2026-10-01';
const dayMs = 86400e3;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs);
const normSku = (s) => { const m = String(s ?? '').toUpperCase().replace(/\s+/g, '').match(/^SK-?(\d{3})$/); return m ? `SK-${m[1]}` : null; };

const FILES = { stock: '庫存表.xlsx', orders: '訂單.csv', lead: '供應商交期.md' };
const ITEMS = ['帆布托特包', '防潑水後背包', '皮革短夾', '旅行收納袋', '亞麻漁夫帽', '陶瓷馬克杯', '香氛蠟燭', '羊毛圍巾', '棉麻餐墊', '不鏽鋼保溫瓶'];
const COLORS = ['米白', '墨綠', '藏青', '磚紅'];
const SUPPLIERS = ['和成工坊', '大昌製造', '永盛實業', '凱旋皮件', '晨光陶瓷'];

// ---------- 造資料 ----------
export function buildData(seed) {
  const R = makeRnd(seed);
  const skus = [];
  for (let i = 0; i < 40; i++) {
    const code = `SK-${String(i + 1).padStart(3, '0')}`;
    const name = `${COLORS[i % 4]}${ITEMS[Math.floor(i / 4)]}`;
    skus.push({ code, name, stock: R.int(0, 220), safety: R.int(20, 80), lead: R.int(3, 28), supplier: R.pick(SUPPLIERS) });
  }
  const bySku = Object.fromEntries(skus.map((s) => [s.code, s]));
  const orders = [];
  for (let i = 0; i < 120; i++) {
    // 偏態挑 SKU：少數 SKU 集中下單，前五名才拉得開
    const idx = Math.floor(Math.pow(R.rnd(), 1.6) * 40);
    const code = skus[idx].code;
    const qty = R.int(5, 80);
    const need = addDays(TODAY, R.int(1, 40));
    orders.push({ no: `PO-${String(i + 1).padStart(4, '0')}`, code, qty, need });
  }
  orders.sort((a, b) => a.need.localeCompare(b.need) || a.no.localeCompare(b.no));
  // 三成寫法歪掉（不改 truth 用的 code，只改寫進 CSV 的字串）
  const MANGLE = [(c) => c.toLowerCase(), (c) => c.replace('-', ' '), (c) => ` ${c}`, (c) => c.toLowerCase().replace('-', ' '), (c) => `${c} `];
  const mangledIdx = new Set();
  while (mangledIdx.size < 36) mangledIdx.add(Math.floor(R.rnd() * 120));
  for (const o of orders) o.written = o.code;
  [...mangledIdx].forEach((i, k) => { orders[i].written = MANGLE[k % MANGLE.length](orders[i].code); });

  // truth（對齊後）
  const demand = {};
  for (const o of orders) demand[o.code] = (demand[o.code] ?? 0) + o.qty;
  const risk = skus.map((s) => ({ sku: s.code, name: s.name, demand: demand[s.code] ?? 0, stock: s.stock, gap: (demand[s.code] ?? 0) - s.stock }))
    .sort((a, b) => b.gap - a.gap || a.sku.localeCompare(b.sku));
  const top5 = risk.slice(0, 5);
  const shortSet = new Set(risk.filter((r) => r.gap > 0).map((r) => r.sku));
  const delayed = orders.filter((o) => shortSet.has(o.code) && daysBetween(TODAY, o.need) < bySku[o.code].lead)
    .map((o) => ({ order: o.no, sku: o.code, qty: o.qty, need: o.need, days: daysBetween(TODAY, o.need), lead: bySku[o.code].lead }));
  // 不對齊（只認 SK-xxx 原樣）的前五名——造資料時確認陷阱有效
  const naiveDemand = {};
  for (const o of orders) if (o.written === o.code) naiveDemand[o.code] = (naiveDemand[o.code] ?? 0) + o.qty;
  const naiveTop5 = skus.map((s) => ({ sku: s.code, gap: (naiveDemand[s.code] ?? 0) - s.stock })).sort((a, b) => b.gap - a.gap || a.sku.localeCompare(b.sku)).slice(0, 5).map((r) => r.sku);
  const tieAtBoundary = risk[4].gap === risk[5].gap;
  return { skus, orders, top5, risk, delayed, naiveTop5, tieAtBoundary, mangled: orders.filter((o) => o.written !== o.code) };
}

// 種子：從 20260924 起找第一個「陷阱有效（不對齊只會中 3 個）、第五／六名不同分、延遲 12～40 筆」的種子，定死在這裡；generate 會再驗一次
export const SEED = 20260927;

export async function generate(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const d = buildData(SEED);
  if (d.tieAtBoundary) throw new Error('q4 造資料：前五名第五／六名同分，換種子');
  const naiveSame = d.naiveTop5.slice().sort().join() === d.top5.map((r) => r.sku).sort().join();
  if (naiveSame) throw new Error('q4 造資料：不對齊也能算對前五名，陷阱無效，換種子');

  // 庫存表.xlsx
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('庫存');
  ws.addRow(['編號', '品名', '現有庫存', '安全庫存']);
  for (const s of d.skus) ws.addRow([s.code, s.name, s.stock, s.safety]);
  const stockPath = path.join(dataDir, FILES.stock);
  await wb.xlsx.writeFile(stockPath);

  // 訂單.csv
  const csv = [csvLine(['訂單號', 'SKU', '數量', '需求日']), ...d.orders.map((o) => csvLine([o.no, o.written, o.qty, o.need]))].join('\n') + '\n';
  const ordersPath = path.join(dataDir, FILES.orders);
  fs.writeFileSync(ordersPath, csv);

  // 供應商交期.md
  const md = [
    '# 供應商補貨交期',
    '',
    `基準日：${TODAY}。補貨天數＝今天下單到貨進倉的天數。`,
    '',
    '| SKU | 供應商 | 補貨天數 |',
    '|---|---|---|',
    ...d.skus.map((s) => `| ${s.code} | ${s.supplier} | ${s.lead} |`),
    '',
  ].join('\n');
  const leadPath = path.join(dataDir, FILES.lead);
  fs.writeFileSync(leadPath, md);

  const truth = {
    today: TODAY,
    sku_count: d.skus.length,
    order_count: d.orders.length,
    mismatch_count: d.mangled.length,
    mismatch_orders: d.mangled.map((o) => ({ order: o.no, written: o.written, sku: o.code })),
    top5: d.top5,
    risk_table: d.risk.slice(0, 10),
    delayed: d.delayed,
    naive_top5: d.naiveTop5,
  };
  fs.writeFileSync(path.join(dataDir, 'truth.json'), JSON.stringify(truth, null, 2));
  return {
    files: [
      { name: FILES.stock, path: stockPath },
      { name: FILES.orders, path: ordersPath },
      { name: FILES.lead, path: leadPath },
    ],
    truth,
  };
}

// ---------- 題目文字 ----------
const RULES = `口徑：今天是 ${TODAY}。某 SKU 的需求量＝訂單表裡該 SKU 全部未出貨訂單的數量加總；缺貨風險＝需求量－現有庫存；庫存不足＝需求量大於現有庫存。`;
const STEP1 = `附件有三份檔：${FILES.stock}（40 個 SKU 的編號、品名、現有庫存、安全庫存）、${FILES.orders}（120 筆未出貨訂單：訂單號、SKU、數量、需求日）、${FILES.lead}（每個 SKU 的補貨天數）。請先把三份檔用 SKU 編號對起來，檢查訂單表的編號跟庫存表對不對得上；對不上的要找出原因、統一寫法後再對，並回報「編號寫法不一致的訂單有幾筆、是哪種寫法」。輸出對齊後的表（SKU、品名、現有庫存、需求量、補貨天數）。`;
const STEP2 = `${RULES}請算：（一）缺貨風險前五名的 SKU（缺貨風險最大的五個，附需求量、現有庫存、風險值）；（二）會延遲的訂單清單：庫存不足的 SKU 底下、且「需求日減今天的天數」小於該 SKU 補貨天數的訂單，列出訂單號、SKU、需求日、距今天數、補貨天數。`;
const STEP3 = `把結果寫成一頁給採購主管的報告：開頭兩三句總結，接著標題「缺貨風險前五名」列五個 SKU（每行一個，寫 SKU 編號），再一個標題「會延遲的訂單」列出全部訂單號，最後一段「資料品質備註」講編號寫法不一致的問題與筆數，以及給採購的建議。`;

export function flowDef({ files }) {
  const att = files.map((f) => f.name);
  const node = (nid, ttl, instruction, next) => ({
    id: nid, title: ttl, executor: 'ai', stop_point: 'never', model_tier: 'balanced', instruction, next, attachments: att,
  });
  return {
    format: 1,
    name: '金絲雀 q4：庫存×訂單×交期交叉比對',
    params: [],
    permissions: { files: true, connectors: false },
    check: { enabled: false },
    supervisor: { enabled: false },
    nodes: [
      node('align', '對齊三表', STEP1, ['calc']),
      node('calc', '算缺貨風險與延遲清單', STEP2, ['report']),
      node('report', '寫給採購的報告', STEP3, []),
    ],
  };
}

export function ccPrompt() {
  return `目前資料夾裡有三份檔：${FILES.stock}、${FILES.orders}、${FILES.lead}。請依序做完三件事：
一、${STEP1}
二、${STEP2}
三、${STEP3}
最後把報告全文寫進 report.md。`;
}

// ---------- 評分 ----------
// 段落標題：起點用寬的（# 開頭、粗體整行、或 ≤16 字且不是條列／表格的短行），終點只認 # 與粗體整行
//（成品裡「一、……」這種條列不能被當成段落終點）
const isStrictHeading = (line) => /^\s*#{1,6}\s/.test(line) || /^\s*\*\*[^*]+\*\*\s*[:：]?\s*$/.test(line);
const isLooseHeading = (line) => isStrictHeading(line) || (line.trim().length <= 16 && !/^\s*(?:[-*•|]|\d+[.、)])/.test(line));
// 依序試每個候選標題；段落要通過 has（真的含 SKU／訂單號）才算找到——不然「# 缺貨風險報告」這種大標會先被抓走
function extractSection(text, res, has) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (const re of res) {
    for (let i = 0; i < lines.length; i++) {
      if (!(isLooseHeading(lines[i]) && re.test(lines[i]))) continue;
      const body = [];
      for (let j = i + 1; j < lines.length; j++) { if (isStrictHeading(lines[j])) break; body.push(lines[j]); }
      const sec = body.join('\n').trim();
      if (sec && has(sec)) return sec;
    }
  }
  return null;
}
const readArtifact = (artifacts, name) => {
  const a = (artifacts ?? []).find((x) => x.name === name);
  try { return a && fs.existsSync(a.path) ? fs.readFileSync(a.path, 'utf8') : ''; } catch { return ''; }
};
const skusIn = (text) => { const out = []; for (const m of String(text ?? '').matchAll(/sk[-\s]?(\d{3})/gi)) { const c = `SK-${m[1]}`; if (!out.includes(c)) out.push(c); } return out; };
const ordersIn = (text) => { const out = new Set(); for (const m of String(text ?? '').matchAll(/PO[-\s]?(\d{4})/gi)) out.add(`PO-${m[1]}`); return out; };
const MISMATCH_RE = /不一致|大小寫|小寫|空格|空白|寫法不同|寫法不一|格式不同|格式不一|正規化|統一格式|統一寫法|對不上|對不起來/;

export async function score({ finalText, artifacts, truth }) {
  const notes = [];
  const misses = [];
  let text = String(finalText ?? '').trim();
  if (!text) { text = readArtifact(artifacts, 'report.md').trim(); if (text) notes.push('finalText 空，改讀 report.md'); }

  // 前五名
  let topSec = extractSection(text, [/前五|前 5|top ?5/i, /缺貨風險/], (s) => /sk[-\s]?\d{3}/i.test(s));
  if (!topSec) { topSec = text; notes.push('找不到「缺貨風險前五名」段落，以整份文字前五個 SKU 評'); }
  const listed = skusIn(topSec).slice(0, 5);
  const truthTop = truth.top5.map((r) => r.sku);
  const top5Hit = listed.filter((s) => truthTop.includes(s)).length;
  if (top5Hit < 5) misses.push(`前五名命中 ${top5Hit}/5（列出：${listed.join('、') || '無'}；正確：${truthTop.join('、')}）`);

  // 延遲訂單
  let delSec = extractSection(text, [/延遲|延誤|逾期|趕不上/], (s) => /PO[-\s]?\d{4}/i.test(s));
  if (!delSec) { delSec = text; notes.push('找不到「會延遲的訂單」段落，以整份文字的訂單號評'); }
  const listedOrders = ordersIn(delSec);
  const truthOrders = new Set(truth.delayed.map((d) => d.order));
  const delHit = [...listedOrders].filter((o) => truthOrders.has(o)).length;
  const delWrong = [...listedOrders].filter((o) => !truthOrders.has(o)).length;
  const delRecall = truthOrders.size ? delHit / truthOrders.size : 1;
  if (delRecall < 0.8) misses.push(`延遲訂單只命中 ${delHit}/${truthOrders.size}`);
  if (delWrong > 1) misses.push(`延遲訂單多列了 ${delWrong} 筆不該在裡面的`);

  // 編號寫法不一致
  const mentioned = MISMATCH_RE.test(text);
  if (!mentioned) misses.push('沒點出訂單表 SKU 編號寫法不一致');
  const countReported = mentioned && new RegExp(`(^|[^\\d])${truth.mismatch_count}([^\\d]|$)`).test(text);

  const errors = (5 - top5Hit) + delWrong;
  const pass = top5Hit === 5 && delRecall >= 0.8 && delWrong <= 1 && mentioned;
  return {
    pass,
    metrics: {
      primary: top5Hit, primary_label: '缺貨前五名命中（/5）',
      top5_hit: top5Hit,
      delayed_hit: delHit,
      delayed_total: truthOrders.size,
      delayed_recall: Math.round(delRecall * 100) / 100,
      delayed_wrong: delWrong,
      mismatch_mentioned: mentioned,
      mismatch_count_reported: countReported,
      errors,
    },
    misses,
    notes,
  };
}
