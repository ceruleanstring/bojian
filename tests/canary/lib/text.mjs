// 成品文字裡「有沒有出現正確數字」的機械初篩（沿用 reviews/對照測試-2026-09-23/score.mjs 的規則）
// 出現≠用對地方——只是初篩；亂編的數字要另請覆核員讀

const comma = (n) => n.toLocaleString('en-US');

// 空白（半形、全形）可有可無；萬／億簡繁都准；千分位逗號半形全形都准
const SP = '[\\s\\u3000]*';
const WAN = '[萬万]';
const YI = '[億亿]';
const digits = (n) => comma(n).replace(/,/g, '[,，]?'); // 258450 → 258[,，]?450
const NO_DIGIT_AFTER = `(?!${SP}\\d)`; // 「25萬」後面不准再接數字——「25萬8,450」不能被「25萬」半截命中

// 一個整數 ≥ 10,000 的「萬＋尾數」合成寫法（台灣人最常見：25萬8,450、25 萬 8,450、25萬；一億以上另加 1億2,345萬6,789）
function compositeForms(n) {
  const out = [];
  const tail = n % 10000;
  const wanAll = Math.floor(n / 10000);
  out.push(tail ? `${digits(wanAll)}${SP}${WAN}${SP}${digits(tail)}` : `${digits(wanAll)}${SP}${WAN}${NO_DIGIT_AFTER}`);
  if (n >= 1e8) {
    const yi = Math.floor(n / 1e8);
    const wanMid = Math.floor((n % 1e8) / 1e4);
    let f = `${digits(yi)}${SP}${YI}`;
    if (wanMid) f += `${SP}${digits(wanMid)}${SP}${WAN}`;
    f += tail ? `${SP}${digits(tail)}` : NO_DIGIT_AFTER;
    out.push(f);
  }
  return out;
}

// 整數／金額：接受有無千分位（258450 與 258,450 都算），前後不能黏著別的數字；
// 一萬以上另接受「X.X 萬」寫法（714,000 → 71.4 萬；四捨五入到小數一位要正好對上）——實跑月報常把表格數字縮成萬；
// 以及「萬＋尾數」合成數（258,450 → 25萬8,450／25 萬 8,450；250,000 → 25萬；尾數可帶千分位、0～9,999）——真趟 20260924-2144 整份月報都這樣寫。
// 每種萬的寫法後面都不准再接數字，免得「25萬8,450」被「25萬」或「25.8萬」半截命中
export const num = (n) => {
  const forms = [comma(n).replace(/,/g, ',?')];
  if (n >= 10000) {
    const wan = Math.round(n / 1000) / 10;
    forms.push(`${String(wan).replace('.', '\\.')}${SP}${WAN}${NO_DIGIT_AFTER}`);
    if (Number.isInteger(n)) forms.push(...compositeForms(n));
  }
  return new RegExp(`(?<![\\d.,])(${forms.join('|')})(?![\\d])`);
};

// 百分比：47 接受 47 與 47.0；37.8 只接受 37.8；後面要跟 % 或 ％（可有空白）
export const pct = (x) => {
  const s = Number.isInteger(x) ? `${x}(?:\\.0)?` : String(x).replace('.', '\\.');
  return new RegExp(`(?<![\\d.])${s}\\s*[%％]`);
};

// 純計數（訂單數、筆數）：只要那個整數獨立出現
export const count = (n) => new RegExp(`(?<![\\d.,])${n}(?![\\d.,])`);

// 計數＋單位（例：17 筆／張／件）
export const countUnit = (n, units = '筆|張|件') => new RegExp(`(?<![\\d.,])${n}\\s*(${units})`);

// 逐項比對：keys = [[名稱, RegExp]]；回 { hits, misses, ok, total }
export function matchKeys(text, keys) {
  const hits = []; const misses = [];
  for (const [k, re] of keys) (re.test(text) ? hits : misses).push(k);
  return { hits, misses, ok: hits.length, total: keys.length };
}

// 拆句（中文句號、換行、驚嘆／問號、分號）——「兩個詞同句出現」用
export function sentences(text) {
  return String(text ?? '').split(/[。\n！？!?；;]+/).map((s) => s.trim()).filter(Boolean);
}

// 兩組詞是否在同一句同時出現：a、b 各為字串陣列（任一命中即可）
export function coOccur(text, a, b) {
  const A = Array.isArray(a) ? a : [a]; const B = Array.isArray(b) ? b : [b];
  return sentences(text).some((s) => A.some((x) => s.includes(x)) && B.some((y) => s.includes(y)));
}
