// q5 產出真檔：用 q1 的資料；三步：算數字 → 產 月報.docx（含一張數字表）→ 產 明細.xlsx（兩個分頁「按通路」「按商品」）。
// 計分：mammoth 抽 docx 文字對 13 項數字；exceljs 開 xlsx 確認兩個分頁存在、各分頁金額合計等於 truth；檔打不開＝不過。
import fs from 'node:fs';
import path from 'node:path';
import * as q1 from '../q1/question.mjs';
import { docxText } from '../lib/docx.mjs';
import { readXlsx, numbersOf } from '../lib/xlsx.mjs';
import { matchKeys } from '../lib/text.mjs';

export const id = 'q5';
export const title = '產真檔：月報.docx＋明細.xlsx';
export const kind = 'compare';
export const anomalies = ['docx 13 項數字', 'xlsx 兩分頁合計對 truth'];

export const DOCX = '月報.docx';
export const XLSX = '明細.xlsx';
export const SHEETS = ['按通路', '按商品'];

export const generate = q1.generate; // 資料與 truth 完全同 q1（含 aug_product_rev）

export const STEP1 = q1.STEP1;
export const STEP2 = `把這些數字寫成一頁 8 月銷售月報 Word 檔給主管：開頭一段總結，接著一張數字表（表裡要有 8 月完成訂單數、8 月營收、客單價、7 月營收、月增減百分比、前三名商品與營收、各通路營收與佔比、退貨筆數與金額），最後一段下月建議。`;
export const STEP3 = `另外做一份 Excel 明細檔給主管核對，兩個分頁：「按通路」列 8 月各通路的營收與佔比、最後一列合計；「按商品」列 8 月每個商品的營收（全部商品都要列，由高到低）、最後一列合計。兩個分頁的合計都要等於 8 月營收。`;

// 節點 title 決定產出檔名（runner artifactName＝title＋副檔名）：'月報'→月報.docx、'明細'→明細.xlsx
export function flowDef() {
  const node = (nid, t, instruction, next, extra = {}) => ({ id: nid, title: t, executor: 'ai', stop_point: 'never', model_tier: 'balanced', instruction, next, ...extra });
  return {
    format: 1,
    name: '金絲雀 q5：月報 Word＋明細 Excel',
    params: [],
    permissions: { files: true, connectors: false },
    check: { enabled: false },
    supervisor: { enabled: false },
    nodes: [
      node('numbers', '算數字', STEP1, ['docx'], { attachments: ['sales.csv'] }),
      node('docx', '月報', STEP2, ['xlsx'], { output_file: 'docx' }),
      node('xlsx', '明細', STEP3, [], { output_file: 'xlsx' }),
    ],
  };
}

export function ccPrompt() {
  return `目前資料夾裡的 sales.csv 就是附件。請依序做完三件事：\n一、${STEP1}\n二、${STEP2}把檔案存成目前資料夾的「${DOCX}」。\n三、${STEP3}把檔案存成目前資料夾的「${XLSX}」。\n`
    + `寫檔可以用 node 腳本，套件 docx、exceljs 已經裝好（NODE_PATH 已設，直接 require，不要安裝任何套件）。兩個檔都要真的寫在目前資料夾、檔名一個字都不能改。最後把你算出的數字摘要寫進 report.md。`;
}

function findArtifact(artifacts, ext, preferred) {
  const list = (artifacts ?? []).filter((a) => a.name.toLowerCase().endsWith(`.${ext}`));
  return list.find((a) => a.name === preferred) ?? list[0] ?? null;
}

export async function score({ artifacts, truth }) {
  const notes = []; const misses = [];
  let docxOk = false; let keysOk = 0; let keysMisses = [];
  const KEYS = q1.keysOf(truth);
  // ---- docx ----
  const d = findArtifact(artifacts, 'docx', DOCX);
  if (!d) { notes.push(`沒有產出 ${DOCX}`); misses.push('月報.docx 不存在'); }
  else {
    if (d.name !== DOCX) notes.push(`docx 檔名是「${d.name}」不是「${DOCX}」`);
    try {
      const text = await docxText(d.path);
      const m = matchKeys(text, KEYS);
      keysOk = m.ok; keysMisses = m.misses;
      docxOk = text.trim().length > 0;
      if (!docxOk) notes.push('docx 抽不出文字');
      misses.push(...m.misses.map((k) => `docx 缺 ${k}`));
    } catch (e) { notes.push(`docx 打不開：${e.message}`); misses.push('月報.docx 打不開'); }
  }
  // ---- xlsx ----
  let xlsxOk = false; const sheetOk = {};
  const x = findArtifact(artifacts, 'xlsx', XLSX);
  if (!x) { notes.push(`沒有產出 ${XLSX}`); misses.push('明細.xlsx 不存在'); }
  else {
    if (x.name !== XLSX) notes.push(`xlsx 檔名是「${x.name}」不是「${XLSX}」`);
    try {
      const { sheets, names } = await readXlsx(x.path);
      const total = truth.aug_revenue;
      const want = {
        按通路: Object.values(truth.channel_rev),
        按商品: Object.values(truth.aug_product_rev),
      };
      for (const s of SHEETS) {
        const key = names.find((n) => n.trim() === s) ?? names.find((n) => n.includes(s.slice(1)));
        if (!key) { sheetOk[s] = false; misses.push(`xlsx 缺分頁「${s}」`); continue; }
        const nums = numbersOf(sheets[key]);
        const hasTotal = nums.some((n) => Math.abs(n - total) < 0.5);
        const missing = want[s].filter((v) => !nums.some((n) => Math.abs(n - v) < 0.5));
        sheetOk[s] = hasTotal && missing.length === 0;
        if (!hasTotal) misses.push(`xlsx「${s}」合計 ≠ ${total}`);
        if (missing.length) misses.push(`xlsx「${s}」少 ${missing.length} 個金額`);
      }
      xlsxOk = SHEETS.every((s) => sheetOk[s]);
    } catch (e) { notes.push(`xlsx 打不開：${e.message}`); misses.push('明細.xlsx 打不開'); }
  }
  const filesOk = (docxOk ? 1 : 0) + (xlsxOk ? 1 : 0);
  return {
    pass: docxOk && xlsxOk && keysMisses.length <= 2,
    metrics: { primary: filesOk, primary_label: '真檔合格（/2）', errors: misses.length, docx_ok: docxOk, docx_keys_ok: keysOk, docx_keys_total: KEYS.length, xlsx_ok: xlsxOk, sheets: sheetOk },
    misses,
    notes,
  };
}
