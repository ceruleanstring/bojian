// xlsx 寫讀——用剝繭自帶的 exceljs（bojian/node_modules），計分時開工人產的檔核對
import ExcelJS from 'exceljs';

// 讀整本：{ 分頁名: [[格值, ...], ...] }；公式格取算好的結果；打不開就丟錯（呼叫端判「檔打不開＝不過」）
export async function readXlsx(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheets = {};
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell) => { vals.push(cellValue(cell)); });
      rows.push(vals);
    });
    sheets[ws.name] = rows;
  });
  return { sheets, names: Object.keys(sheets) };
}

function cellValue(cell) {
  const v = cell.value;
  if (v && typeof v === 'object') {
    if ('result' in v) return v.result ?? null;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
    if (v instanceof Date) return v.toISOString();
    return null;
  }
  return v ?? null;
}

// 一張分頁裡全部數字格（字串裡的純數字也算，例如 "258,450"）
export function numbersOf(rows) {
  const out = [];
  for (const r of rows) for (const v of r) {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    else if (typeof v === 'string' && /^-?[\d,]+(\.\d+)?%?$/.test(v.trim())) {
      const n = Number(v.trim().replace(/,/g, '').replace('%', ''));
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

// 寫一本簡單的（測試自用）：sheets = { 分頁名: [[...], ...] }
export async function writeXlsx(file, sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  await wb.xlsx.writeFile(file);
}
