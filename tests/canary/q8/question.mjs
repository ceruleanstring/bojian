// q8 髒資料月報：專門揭穿「工人的程式算錯」。資料是系統匯出的訂單明細，埋五種陷阱（見 gen.mjs 檔頭）；
// 標準答案由 truth.mjs 把 CSV 重新讀回來另算；score 對成品的數字只認 truth，另外對「陷阱誘導出的錯數字」反向計分（trap_hit）。
// 三步同 q1 的結構：算數字 → 找三個重點 → 寫成月報。
import fs from 'node:fs';
import path from 'node:path';
import { buildCsvText } from './gen.mjs';
import { computeTruth } from './truth.mjs';
import { num, pct, count, countUnit, matchKeys } from '../lib/text.mjs';

export const id = 'q8';
export const title = '髒資料月報（多列訂單・混狀態・混日期・千分位・空金額）';
export const kind = 'compare';
export const anomalies = ['訂單數不被列數灌水', '營收排除已取消／已退款', '三種日期寫法與 8/31–9/1 邊界', '千分位金額字串', '空白金額用數量×單價補'];

export const FILE = 'orders.csv';

// ---- 三步指示（使用者口吻；兩邊逐字相同）----
export const STEP1 = `附件 ${FILE} 是我們系統匯出的 2026 年 7、8 月訂單明細。匯出的檔有點亂，先講清楚：一張訂單買幾樣就有幾列（同一張的訂單編號相同），
訂單數要算張數不是列數；狀態有「完成」「已取消」「已退款」三種，營收只算「完成」的；下單時間的寫法不統一（都是 2026 年），8 月就是 8/1 到 8/31；
金額欄有一兩筆是空的或寫「－」，那幾筆請用 數量×單價 補上。請算出：
8 月完成訂單數、8 月營收、客單價（營收÷完成訂單數，四捨五入到整數）、7 月營收、8 月對 7 月營收增減百分比（小數一位）、
8 月營收前三名商品與各自營收、8 月各通路營收與佔比（小數一位）、8 月退款張數與退款金額（狀態「已退款」的訂單）。`;
export const STEP2 = '根據這些數字找出三個重點（成長動能、風險、異常各一），每點附一句原因推測與一句建議。';
export const STEP3 = '寫成一頁 8 月銷售月報給主管：開頭一段總結，接著數字表格、三個重點、下月建議。';

export async function generate(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const csvPath = path.join(dataDir, FILE);
  fs.writeFileSync(csvPath, buildCsvText(), 'utf8');
  const truth = computeTruth(csvPath); // 重新讀回來算，不從產生器的物件抄
  fs.writeFileSync(path.join(dataDir, 'truth.json'), JSON.stringify(truth, null, 2));
  return { files: [{ name: FILE, path: csvPath }], truth };
}

// ---- 剝繭流程：三步、Sonnet、查核與監工關、可寫程式算 ----
export function flowDef() {
  const node = (nid, t, instruction, next, extra = {}) => ({ id: nid, title: t, executor: 'ai', stop_point: 'never', model_tier: 'balanced', instruction, next, ...extra });
  return {
    format: 1,
    name: '金絲雀 q8：髒資料 8 月月報',
    params: [],
    permissions: { files: true, connectors: false },
    check: { enabled: false },
    supervisor: { enabled: false },
    nodes: [
      node('numbers', '算數字', STEP1, ['points'], { attachments: [FILE] }),
      node('points', '找三個重點', STEP2, ['report']),
      node('report', '寫成月報', STEP3, []),
    ],
  };
}

// ---- Claude Code 一句話（同一句交代；成品寫 report.md）----
export function ccPrompt() {
  return `目前資料夾裡的 ${FILE} 就是附件。請依序做完三件事：\n一、${STEP1}\n二、${STEP2}\n三、${STEP3}\n最後把月報全文寫進 report.md。`;
}

// ---- 計分：13 項關鍵數字只對 truth；陷阱誘導出的錯數字出現＝trap_hit ----
export function keysOf(T) {
  return [
    ['8月完成訂單數', count(T.aug_orders)],
    ['8月營收', num(T.aug_revenue)],
    ['客單價', num(T.aov)],
    ['7月營收', num(T.jul_revenue)],
    ['月增減%', pct(Math.abs(T.mom_pct))], // 負的常寫成「下降 12.3%」，不強求負號
    ...T.top3.map((p, i) => [`第${i + 1}名營收（${p.name}）`, num(p.rev)]),
    ...Object.entries(T.channel_share).map(([c, v]) => [`${c}佔比`, pct(v)]),
    ['8月退款張數', countUnit(T.aug_refund_orders, '張|筆|件|單')],
    ['8月退款金額', num(T.aug_refund_amount)],
  ];
}

export function decoysOf(T) {
  const reOf = (d) => (d.type === 'count' ? count(d.value) : d.type === 'countUnit' ? countUnit(d.value, '張|筆|件|單') : num(d.value));
  return (T.decoys ?? []).map((d) => [d.label, reOf(d)]);
}

export async function score({ finalText, truth }) {
  const text = finalText ?? '';
  const m = matchKeys(text, keysOf(truth));
  const traps = decoysOf(truth).filter(([, re]) => re.test(text)).map(([label]) => label);
  const notes = [];
  if (!text.trim()) notes.push('成品是空的');
  if (traps.length) notes.push(`trap_hit ${traps.length} 條：${traps.join('、')}`);
  return {
    pass: m.misses.length === 0 && traps.length === 0,
    metrics: {
      primary: m.ok, primary_label: `關鍵數字命中（/${m.total}）`,
      errors: m.misses.length + traps.length, trap_hits: traps.length,
      keys_ok: m.ok, keys_total: m.total, traps,
    },
    misses: [...m.misses, ...traps.map((t) => `陷阱命中：${t}`)],
    notes,
  };
}
