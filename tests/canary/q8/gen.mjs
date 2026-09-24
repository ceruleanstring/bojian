// q8 造資料：髒的訂單匯出檔（一張訂單買幾樣就幾列）。固定種子，每次產出一模一樣。
// 五種陷阱（每種都讓「直觀但錯」的程式算出錯的數字）：
//   ① 同一張訂單拆成多列（品項列）——直接數列數會把訂單數灌水
//   ② 狀態欄混著「已取消」「已退款」——營收只能算「完成」
//   ③ 下單時間三種寫法混用（2026-08-03 14:22／2026/8/3 14:22／8月3日 14:22），另有幾張在 8/31 23:xx 與 9/1 00:xx 跨月邊界
//   ④ 金額欄有些寫成帶千分位的字串（"12,800"）
//   ⑤ 有兩列金額空白或「－」（要用 數量×單價 補）
// 這支只負責「寫出去」；標準答案由 truth.mjs 把 CSV 重新讀回來另外算，不從這裡的物件抄。
import { makeRng } from '../lib/seed.mjs';

export const SEED = 20260831;
export const PRODUCTS = [
  ['經典帆布托特包', 1280], ['防潑水後背包', 2380], ['皮革短夾', 1680], ['旅行收納袋組', 690],
  ['亞麻漁夫帽', 880], ['手工陶瓷馬克杯', 560], ['香氛蠟燭禮盒', 1450], ['羊毛圍巾', 1980],
];
export const CHANNELS = ['官網', '蝦皮', '門市'];
const CH_W = [0.42, 0.35, 0.23];
export const STATUSES = ['完成', '已取消', '已退款'];
const ST_W = [0.82, 0.08, 0.10];
export const DATE_FORMATS = ['iso', 'slash', 'zh'];
const FMT_W = [0.60, 0.25, 0.15];
export const N_ORDERS = { 7: 110, 8: 130 };
export const BOUNDARY = { aug31_late: 3, sep1_early: 3 };
export const MULTI_P = 0.35;   // 35% 的訂單有 2～3 個品項（＝2～3 列）
export const COMMA_P = 0.15;   // 金額 ≥ 1,000 的列有 15% 寫成 "12,800"
export const BLANK_PICK = [6, 39]; // 8 月「完成」的列裡（依序）第 7、第 40 列金額寫成空白／「－」
export const HEADERS = ['訂單編號', '下單時間', '通路', '商品', '數量', '單價', '金額', '狀態'];

const pad2 = (n) => String(n).padStart(2, '0');
function weightedPick(rnd, items, w) {
  const r = rnd();
  let acc = 0;
  for (let i = 0; i < items.length; i++) { acc += w[i]; if (r < acc) return items[i]; }
  return items[items.length - 1];
}

// 三種日期寫法
export function fmtWhen({ y, m, d, hh, mm }, fmt) {
  const t = `${pad2(hh)}:${pad2(mm)}`;
  if (fmt === 'iso') return `${y}-${pad2(m)}-${pad2(d)} ${t}`;
  if (fmt === 'slash') return `${y}/${m}/${d} ${t}`;
  return `${m}月${d}日 ${t}`;
}

export function buildOrders() {
  const { rnd, pick } = makeRng(SEED);
  const orders = [];
  const mk = (m, d, hh, mm, fmtOverride) => {
    const ch = weightedPick(rnd, CHANNELS, CH_W);
    const status = weightedPick(rnd, STATUSES, ST_W);
    const fmt = fmtOverride ?? weightedPick(rnd, DATE_FORMATS, FMT_W);
    const nItems = rnd() < MULTI_P ? 2 + Math.floor(rnd() * 2) : 1;
    const items = [];
    const used = new Set();
    while (items.length < nItems) {
      const [name, price] = pick(PRODUCTS);
      if (used.has(name)) continue;
      used.add(name);
      items.push({ name, price, qty: 1 + Math.floor(rnd() * 3) });
    }
    orders.push({ y: 2026, m, d, hh, mm, ch, status, fmt, items });
  };
  for (const m of [7, 8]) {
    for (let i = 0; i < N_ORDERS[m]; i++) {
      const d = 1 + Math.floor(rnd() * 31);
      const hh = Math.floor(rnd() * 24);
      const mm = Math.floor(rnd() * 60);
      mk(m, d, hh, mm);
    }
  }
  // ③ 跨月邊界：8/31 23:xx（算 8 月，三種寫法都有）、9/1 00:xx（不算 8 月；用 iso／slash，讓 Date 解析得出來才有陷阱）
  for (let i = 0; i < BOUNDARY.aug31_late; i++) mk(8, 31, 23, 5 + Math.floor(rnd() * 55), DATE_FORMATS[i % 3]);
  for (let i = 0; i < BOUNDARY.sep1_early; i++) mk(9, 1, 0, 3 + Math.floor(rnd() * 50), ['iso', 'slash'][i % 2]);
  orders.sort((a, b) => a.m - b.m || a.d - b.d || a.hh - b.hh || a.mm - b.mm);
  orders.forEach((o, i) => { o.id = `SO${String(i + 1).padStart(5, '0')}`; });

  // 攤成列（① 多品項＝多列）
  const rows = [];
  for (const o of orders) {
    for (const it of o.items) {
      const amt = it.qty * it.price;
      // ④ 千分位字串
      const comma = amt >= 1000 && rnd() < COMMA_P;
      rows.push({ id: o.id, when: fmtWhen(o, o.fmt), ch: o.ch, name: it.name, qty: it.qty, price: it.price, amt, amtStr: comma ? amt.toLocaleString('en-US') : String(amt), status: o.status, m: o.m });
    }
  }
  // ⑤ 兩列金額空白／「－」：挑 8 月完成的列，位置固定
  const eligible = rows.filter((r) => r.m === 8 && r.status === '完成');
  eligible[BLANK_PICK[0]].amtStr = '';
  eligible[BLANK_PICK[1]].amtStr = '－';
  return { orders, rows };
}

// 自己的 CSV 寫法：含逗號的欄位加雙引號（lib/csv.mjs 的 toCsv 不跳脫，這題需要 "12,800"）
export function toCsvQuoted(headers, rows) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [headers.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n') + '\n';
}

export function buildCsvText() {
  const { rows } = buildOrders();
  return toCsvQuoted(HEADERS, rows.map((r) => [r.id, r.when, r.ch, r.name, r.qty, r.price, r.amtStr, r.status]));
}
