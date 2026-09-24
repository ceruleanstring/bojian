// CSV 寫讀（欄位不含逗號與換行——資料全是程式生成，不做引號跳脫；讀的一方仍容忍雙引號欄）
import fs from 'node:fs';

export function toCsv(headers, rows) {
  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';
}

export function writeCsv(file, headers, rows) {
  const text = toCsv(headers, rows);
  fs.writeFileSync(file, text, 'utf8');
  return Buffer.byteLength(text, 'utf8');
}

function splitLine(line) {
  const out = [];
  let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

// 回 [{欄名: 值}]；值一律字串，呼叫端自己轉數字
export function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const headers = splitLine(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(splitLine(l).map((v, i) => [headers[i], v])));
}

export function readCsv(file) {
  return parseCsv(fs.readFileSync(file, 'utf8'));
}
