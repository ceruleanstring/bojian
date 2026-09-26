// checker — 交貨查核：程式對成品裡的數字（checkNumbers）、組查核 prompt、解析查核員的 JSON、分類成攔／標／缺。
// 查核員是每步一次全新的 adapter.complete（meta.kind='check'，不帶工具、不帶側寫），只查文字事實（ADR-010）；業務 prompt 只在這裡組。
// 判定不信查核員的總結——status 一律由 classify 依規則算出來。verifyArithmetic（算式驗算）留著，classify 不再用它。
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import { PDFParse } from 'pdf-parse';

export class CheckParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CheckParseError';
  }
}

const str = (v) => (v === null || v === undefined ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const bare = (v) => str(v).replace(/\s+/g, ''); // 比對規則用：空白差異不算不同

// ---- 算式驗算 ----
// 手寫掃描＋遞迴下降，只認數字與 + - * / ( )。查核員給的字串是外來輸入，絕不交給直譯器執行。

const SYMBOLS = { '＋': '+', '－': '-', '−': '-', '×': '*', '＊': '*', '÷': '/', '／': '/', '＝': '=', '（': '(', '）': ')', '，': ',', '．': '.' };

// 查核員很常順手寫上單位、貨幣符號與標籤（「總計：6+3=9 件」）——那些不是算式的一部分，剝掉再算，
// 不剝就會整條看不懂而不表態，假算式就被當成真的放行。
const CURRENCY = /NT\$|[$¥￥€]/gi;
const LABEL = /^[^=]*[:：]/; // 只吃第一個等號之前的標籤
const TAIL_NOISE = /[一-鿿。、；：！？,.;:!?]+$/; // 數字後面的中文單位與句末標點（漢字＋全形標點）；百分號刻意不在內——那不是單位，是「除以 100」，留給 percentSide 換算

function normalizeCalc(text) {
  return str(text)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[＋－−×＊÷／＝（），．]/g, (c) => SYMBOLS[c])
    .replace(/\s+/g, '')
    .replace(CURRENCY, '')
    .replace(LABEL, '');
}

function readNumber(s, pos) {
  const m = /^\d[\d,]*(?:\.\d+)?|^\.\d+/.exec(s.slice(pos));
  if (!m) return null;
  const value = Number(m[0].replace(/,/g, '')); // 千分位是寫法不是運算子
  return Number.isFinite(value) ? { value, pos: pos + m[0].length } : null;
}

function readPrimary(s, pos) {
  if (s[pos] === '(') {
    const inner = readSum(s, pos + 1);
    if (!inner || s[inner.pos] !== ')') return null;
    return { value: inner.value, pos: inner.pos + 1 };
  }
  return readNumber(s, pos);
}

function readSigned(s, pos) {
  if (s[pos] === '-' || s[pos] === '+') {
    const r = readSigned(s, pos + 1);
    return r ? { value: s[pos] === '-' ? -r.value : r.value, pos: r.pos } : null;
  }
  return readPrimary(s, pos);
}

function readProduct(s, pos) {
  let left = readSigned(s, pos);
  if (!left) return null;
  while (s[left.pos] === '*' || s[left.pos] === '/') {
    const op = s[left.pos];
    const right = readSigned(s, left.pos + 1);
    if (!right || (op === '/' && right.value === 0)) return null;
    left = { value: op === '*' ? left.value * right.value : left.value / right.value, pos: right.pos };
  }
  return left;
}

function readSum(s, pos) {
  let left = readProduct(s, pos);
  if (!left) return null;
  while (s[left.pos] === '+' || s[left.pos] === '-') {
    const op = s[left.pos];
    const right = readProduct(s, left.pos + 1);
    if (!right) return null;
    left = { value: op === '+' ? left.value + right.value : left.value - right.value, pos: right.pos };
  }
  return left;
}

const cleanSide = (s) => s.replace(TAIL_NOISE, ''); // 「14 件」「14。」照算；「14%」的百分號留著

function sideValue(t) {
  const r = readSum(t, 0);
  return r && r.pos === t.length ? r.value : null; // 有殘字＝看不懂，不猜
}

// 這一側「寫出來」有幾位小數（整數＝0）。位數上限 12，再多就是浮點雜訊不是精度
// 括號先剝掉：(42.0)% 的小數點後面跟著「0)」不是純數字，不剝就當成整數，位數退化成 0＝整數比
function decimalsOf(text) {
  const t = text.replace(/[()]/g, '');
  const at = t.lastIndexOf('.');
  if (at < 0) return 0;
  const d = t.slice(at + 1);
  return /^\d+$/.test(d) ? Math.min(d.length, 12) : 0;
}

const roundTo = (v, k) => Number(v.toFixed(k));
const truncTo = (v, k) => Math.trunc(v * 10 ** k) / 10 ** k;

// 算出來的 v 對得上寫出來的 written 嗎——比到 k 位為止，四捨五入或截斷都算對
//（v 一定要放算出來的那一側：截斷是查核員把商寫短的動作，寫出來的那一側沒有東西可以截）
//（written 也收到同一位數，免得浮點雜訊自己製造差異）
const fitsAt = (v, written, k) => {
  const w = roundTo(written, k);
  return roundTo(v, k) === w || truncTo(v, k) === w;
};

// 結尾百分號＝這一側寫的是「除以 100」的值（42.9% 就是 0.429）。剝掉並記下來，兩邊才會在同一個單位上比。
const percentSide = (t) => (/[%％]$/.test(t) ? { text: t.slice(0, -1), percent: true } : { text: t, percent: false });

// 純數字＝整條只有一個數（千分位與小數點是寫法不是運算子）；百分號已經被 percentSide 剝掉了。
// 前導正負號與包住整個數的括號也算「寫出來的數字」——不認就退回照右邊取位數，-50%／(50)% 這些寫法又變回整數比。
//（值本身由 sideValue 解析，負號跟著值走；括號沒收尾的寫法解不出來，早就在前面回 null 了）
const isLiteral = (t) => /^[+-]?\(?(?:\d[\d,]*(?:\.\d+)?|\.\d+)\)?$/.test(t);

// 這一側自己乘過 100 了嗎：6/14*100、100*6/14 都算；*1000、*100.5 不算
const scaledBy100 = (t) => /\*100(?![\d.])|(?:^|[^\d.])100\*/.test(t);

// 哪一側是「寫出來的結果」：純數字的那一側，比對的位數就照它寫的位數。
// 兩側都是純數字時取帶百分號的那一側——它的值已經被縮小 100 倍，位數不跟著往後補就退化成整數比，
// 「50%=0」這種一定被判成立；兩側都不是純數字時照舊用右側。
const writtenSide = (L, R) => {
  const literals = [R, L].filter((s) => isLiteral(s.text));
  return literals.find((s) => s.percent) ?? literals[0] ?? R;
};

// true＝算得出來且成立；false＝算得出來但不成立；null＝看不懂，不表態
// 比到右邊寫的位數為止：成品裡的佔比多半除不盡（6÷14），查核員照規則把算式寫進 calc 時只能四捨五入或截斷；
// 用固定容差比，這種算式一定判不成立，查核員說 ok 反被程式翻成攔——真跑一趟九次誤攔全出在這裡。
// 百分比再放行一層：查核員把成品的「43%」搬到等號右邊時，不是寫 6/14=42.9% 就是漏寫百分號寫成 6/14=43，
// 兩種寫法都要看得懂，否則 只是把「除不盡」的假攔換成「差 100 倍」的假攔。
// 位數取自寫成純數字的那一側：一律照右邊取，百分號寫在左邊、右邊是算式或整數時位數退化成 0，
// 等於整數比——0% 到 100% 之間隨便寫什麼都判成立（50%=6/14、50%=0 全被放行），等於這一整條驗算沒在驗。
export function verifyArithmetic(calc) {
  const s = normalizeCalc(calc);
  const at = s.lastIndexOf('=');
  if (at <= 0 || at === s.length - 1) return null;
  const L = percentSide(cleanSide(s.slice(0, at)));
  const R = percentSide(cleanSide(s.slice(at + 1)));
  const lv = sideValue(L.text);
  const rv = sideValue(R.text);
  if (lv === null || rv === null) return null;
  const left = L.percent ? lv / 100 : lv;
  const right = R.percent ? rv / 100 : rv;
  const W = writtenSide(L, R);
  const written = W === R ? right : left;
  const computed = W === R ? left : right;
  if (fitsAt(computed, written, decimalsOf(W.text) + (W.percent ? 2 : 0))) return true; // 42.9% 換成小數就是 0.429，位數往後兩位
  // 恰一側寫百分號、上面那關過不了：退一步用兩側「剝掉百分號的原始數值」再比一次——
  // 查核員把佔比乘完 100 又補上百分號（6/14*100=42.9%）是最自然的寫法，硬判不成立就是假攔。
  // 只退這一步：50%=6/14 的原始值是 50 對 0.43，照樣不成立，百分號在左的恆真洞沒有被重新打開。
  // 而且只有另一側真的乘過 100 才退：沒設這道門檻就等於「剝掉百分號比整數位」，
  // 6/14=0%（0.43 對 0）、6+3+4+1=14%（14 對 14）一比就成立——假放行比假攔更難被發現。
  if (L.percent !== R.percent && scaledBy100((W === R ? L : R).text)) {
    return fitsAt(W === R ? lv : rv, W === R ? rv : lv, decimalsOf(W.text));
  }
  // 兩邊都沒寫百分號，一邊是比例、一邊是百分數（6/14=43）——比例乘 100 對得上就算成立
  //（位數一樣取自寫出來的那一側，也就是這裡不小於 1 的那一側）
  if (L.percent || R.percent) return false;
  if (left > 0 && left < 1 && right >= 1) return fitsAt(left * 100, right, decimalsOf(R.text));
  if (right > 0 && right < 1 && left >= 1) return fitsAt(right * 100, left, decimalsOf(L.text));
  return false;
}

// ---- 成品數字對出處（ADR-010 決策 1）----
// 成品裡每一個阿拉伯數字由程式對來源（工人程式印出的全文 exec.out、這趟的數字檔、祖先成品、原始資料），不由 AI 對。
// 幾十趟裡程式印出的數字從沒錯過，錯的全是句子裡順口算的比例／倍數／差額／天數——找不到出處的數字＝可能是順口算的，攔。
// 不是量的數字（年份、日期、時間、第 N、行首清單編號、Q1～Q4、電話／編號）不抓；來源那一側抓得越寬越好（只會少攔、不會多攔）。

const SIGN = '-－‐–—−'; // L061 的負數寫法：半形減號、全形減號、Unicode hyphen、en dash、em dash、minus sign（空白分隔與會計括號另判）
// 千分位只認「三位一組、後面不再接數字」：1,2,3 這種列舉是三個數；CSV 的「1,1980」是 1 與 1980，不是 1,198 加 0
const NUM_TOKEN = /(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?/g;
const UNIT_MULT = { 萬: 1e4, 万: 1e4, 億: 1e8, 亿: 1e8, 千: 1e3 }; // 金絲雀真成品寫過「22万5,960」（簡體萬）
const LATIN = /[A-Za-zＡ-Ｚａ-ｚ#]$/; // 字母接數字＝編號（SO00001、Q1、H2），不是量

// 不是量的區段：日期（YYYY-MM-DD、YYYY/MM/DD、M/D）、時間（HH:mm）、連字號串起的長數字（電話、編號：數字合計 ≥7 位）
function excludedSpans(text) {
  const spans = [];
  for (const re of [/\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?/g, /(?<![\d/])\d{1,2}\/\d{1,2}(?![\d/])/g, /\d{1,2}:\d{2}/g]) {
    for (const m of text.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(/\d+(?:-\d+)+/g)) {
    if (m[0].replace(/-/g, '').length >= 7) spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

// 成品或來源文字裡的數字：[{value, decimals, percent, raw, index}]
// value＝含正負號、乘過倍數的數值；decimals＝寫出來的小數位數；percent＝結尾有百分號；raw＝原文片段；index＝raw 在文字裡的位置
// all=true（來源側）：不套「不是量」的排除，什麼數字都收
const TAIL_UNIT = { 千: 1e3, 百: 1e2, 萬: 1e4, 万: 1e4, 億: 1e8, 亿: 1e8 }; // 合成數的尾數後面再接的單位：2萬5千＝25,000、3億2千萬＝320,000,000
const SIGN_RE = new RegExp(`([${SIGN}])( ?)$`);
const TAIL_RE = /(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/y; // 倍數後面接的尾數（黏著比對，從 lastIndex 起算，不切字串）
const GAP = /^[ 　]$/; // 合成數裡單位與尾數之間准的那一個空白：半形或全形
const LOOK = 8; // 數字後面只看這幾個字：單位、百分號、年月日、清單符號、表格線都在裡面
export function extractNumbers(text, { all = false } = {}) {
  const s = str(text);
  if (!s) return [];
  // 不是量的區段照起點排好；數字由左而右來，已經整個在這個數字前面的區段以後都用不到——來源側 5,000 列 CSV 才不會變二次方
  const spans = all ? [] : excludedSpans(s).sort((a, b) => a[0] - b[0]);
  let si = 0;
  const inSpan = (i, j) => {
    while (si < spans.length && spans[si][1] <= i) si++;
    for (let k = si; k < spans.length && spans[k][0] < j; k++) if (spans[k][1] > i) return true;
    return false;
  };
  const out = [];
  let skipUntil = 0; // 合成數（25萬8,450）的尾數已經被前一個數吃掉，不再當獨立的數
  for (const m of s.matchAll(NUM_TOKEN)) {
    if (m.index < skipUntil) continue;
    const num = m[0];
    let start = m.index;
    let end = start + num.length;
    // 前面只看「這一行的行首到數字」：每個判斷都只看尾端幾個字，$ 錨定的正規式不必掃整段前綴（長文才是線性的）
    const lineAt = s.lastIndexOf('\n', start - 1) + 1;
    const before = s.slice(lineAt, start);
    if (/[.\d]$/.test(before)) continue; // 1.2.3 的後段、被截斷的數字：不是獨立的數
    if (!all) {
      if (inSpan(start, end)) continue;
      if (LATIN.test(before)) continue;
      if (/第\s?$/.test(before)) continue; // 第 N（步／名／季／頁）
      // 行首清單編號：1. ／ 1) ／ 1、／ (1)（前面准有 Markdown 的粗體、標題、引用、子彈符號）；表格第一格只有一個數＝名次
      const after = s.slice(end, end + LOOK);
      const lineStart = /^[ \t]*(?:[*#>+\-]+[ \t]*)*$/.test(before);
      if (lineStart && (/^[.)）](?:\s|$)/.test(after) || after.startsWith('、'))) continue;
      if (/^[ \t]*(?:[*#>+\-]+[ \t]*)*[(（]$/.test(before) && /^[)）]/.test(after)) continue;
      if (/^[ \t]*\|[ \t]*$/.test(before) && /^[ \t]*\|/.test(after)) continue;
    }
    // 倍數與百分號：25.8 萬、14.4%、15.2％（數字與符號間准一個空白）；「25萬8,450」「25 萬 8,450」這種倍數後面接尾數的合成一個數
    // （單位與尾數之間准一個空白，半形或全形——金絲雀 q10 真成品寫「25 萬 8,450 元」，數字全對卻只差那個空白被攔）
    let mult = 1;
    let tail = 0;
    let tailNum = null;
    const unit = /^\s?([萬万億亿千])(?!分)/.exec(s.slice(end, end + LOOK));
    if (unit) {
      mult = UNIT_MULT[unit[1]];
      end += unit[0].length;
      const tailStart = end + (GAP.test(s[end]) ? 1 : 0);
      TAIL_RE.lastIndex = tailStart;
      const rest = TAIL_RE.exec(s);
      if (rest && !num.includes('.')) {
        tailNum = rest[0];
        tail = Number(tailNum.replace(/,/g, ''));
        end = tailStart + tailNum.length;
        // 尾數再接單位（2萬5千、3億2千萬、2 萬 5 千）：接一個就再乘一次，前面同樣准一個空白；「千分」不是單位
        for (;;) {
          const gap = GAP.test(s[end]) ? 1 : 0;
          const u = TAIL_UNIT[s[end + gap]];
          if (!u || s[end + gap + 1] === '分') break;
          tail *= u;
          end += gap + 1;
        }
        skipUntil = end;
      }
    }
    const pct = /^\s?[%％]/.exec(s.slice(end, end + 2));
    if (pct) end += pct[0].length;
    const percent = !!pct;
    if (!all) {
      const y = Number(num.replace(/,/g, ''));
      const next = s.slice(end, end + 2);
      if (!unit && !pct && /^\s?年/.test(next) && y >= 1900 && y <= 2100 && !num.includes('.')) continue; // 年份
      if (!unit && !pct && /^\s?[月日號]/.test(next)) continue; // 8 月、15 日
    }
    // 負號：數字前是減號（准隔一個空白）、且減號前面不是數字或拉丁字母（10-20 是範圍、A-1 是編號，不是負號）；行首「- 15」是清單符號
    let neg = false;
    const sign = SIGN_RE.exec(before);
    if (sign && !/[\dA-Za-z]$/.test(before.slice(0, sign.index)) && !(sign[2] && /^[ \t]*$/.test(before.slice(0, sign.index)))) {
      neg = true;
      start = lineAt + sign.index;
    } else if (before.endsWith('(') && s[end] === ')' && !percent) { // 會計括號 (5,000)；(47.0%) 是括號註記不是負數
      neg = true;
      start -= 1;
      end += 1;
    }
    const written = Number(num.replace(/,/g, ''));
    // 合成數（25萬8,450）：值＝25×10000＋8450，位數照尾數；比對時不再除倍數（raw 裡的單位字被尾數接住，multOf 認不到）
    const value = tailNum !== null ? written * mult + tail : written * mult;
    out.push({
      value: neg ? -value : value,
      decimals: decimalsOf(tailNum ?? num),
      percent,
      raw: s.slice(start, end),
      index: start,
    });
  }
  return out;
}

const UNSOURCED_DETAIL = '這個數字在程式輸出、數字檔、前面步驟與原始資料裡都找不到（可能是順口算的）；要用就讓程式印出來或寫進數字檔';

// 含那個數字的句子（最多 80 字）：以句號／驚嘆號／問號／換行切句；太長就以數字為中心取一段
function sentenceAt(text, index, len) {
  const sep = /[。！？!?\r\n]/;
  let a = index;
  while (a > 0 && !sep.test(text[a - 1])) a--;
  let b = index + len;
  while (b < text.length && !sep.test(text[b])) b++;
  let sent = text.slice(a, b);
  if (sent.length > 80) {
    const from = Math.max(0, Math.min(index - a - 30, sent.length - 80));
    sent = sent.slice(from, from + 80);
  }
  return sent.trim();
}

// 數字檔的值：遞迴取所有數值；數字字串（"47.0"）與夾在文字裡的數字也收
function numbersInJson(v, into) {
  if (typeof v === 'number') { if (Number.isFinite(v)) into.add(v); return; }
  if (typeof v === 'string') { for (const n of extractNumbers(v, { all: true })) into.add(n.value); return; }
  if (Array.isArray(v)) { for (const x of v) numbersInJson(x, into); return; }
  if (v && typeof v === 'object') for (const x of Object.values(v)) numbersInJson(x, into);
}

// 成品的每個數字 v（寫了 d 位小數、有無 %、有無倍數）對來源任一數 s：
//   fitsAt(s, v, d)（四捨五入或截斷都算對）、v 帶 % 時 fitsAt(s*100, v, d)、v 不帶 % 且 0<s<1 時 fitsAt(s*100, v, d)；
//   v 帶 萬／億／千 時 s 先除以倍數再比（25.8 萬 對 258450 → 25.845 對 25.8）；正負不計較（「減少 14.4%」程式可能印 -14.4）
// 都不成立＝一條 number-unsourced；同一個數字只記一次。來源一個數字都沒有＝不對（空 blocks、checked 0）。
export function checkNumbers({ product, printed = '', numberFiles = [], upstream = [], raw = [] } = {}) {
  const sources = new Set();
  const addText = (t) => { for (const n of extractNumbers(t, { all: true })) sources.add(Math.abs(n.value)); };
  addText(printed);
  for (const f of arr(numberFiles)) {
    const tmp = new Set();
    numbersInJson(f?.json, tmp);
    for (const v of tmp) sources.add(Math.abs(v));
  }
  for (const t of arr(upstream)) addText(t);
  for (const t of arr(raw)) addText(t);
  if (sources.size === 0) return { blocks: [], checked: 0 };
  const text = str(product);
  const seen = new Set();
  const blocks = [];
  for (const n of extractNumbers(text)) {
    const key = `${n.value}|${n.percent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 單位字在尾端才是倍數寫法；25萬8,450、2萬5千、25 萬 8,450 這種單位後面（准一個空白）接尾數的是合成數，整個比
    const composite = /[萬万億亿千][ 　]?\d/.test(n.raw);
    const mult = composite ? 1 : (UNIT_MULT[(/[萬万億亿千]$/.exec(n.raw) ?? [])[0]] ?? 1);
    const written = Math.abs(n.value) / mult;
    const d = n.decimals;
    let hit = false;
    for (const s of sources) {
      const a = s / mult;
      if (fitsAt(a, written, d) || (n.percent && fitsAt(a * 100, written, d)) || (!n.percent && a > 0 && a < 1 && fitsAt(a * 100, written, d))) { hit = true; break; }
    }
    if (!hit) blocks.push({ kind: 'number-unsourced', claim: sentenceAt(text, n.index, n.raw.length), source: '', detail: UNSOURCED_DETAIL, number: n.raw });
  }
  return { blocks, checked: seen.size };
}

// 沒開「允許寫檔與執行程式」的流程：工人根本沒法印數字，找不到出處的數字只標黃不攔——checkNumbers 的 blocks 收成一條 flag（列前三個數字）
export function unsourcedFlag(blocks) {
  const nums = arr(blocks).map((b) => str(b?.number)).filter(Boolean);
  return { kind: 'number-unsourced', detail: `有 ${nums.length} 個數字找不到出處（這條流程沒開「允許寫檔與執行程式」，無法由程式對）：${nums.slice(0, 3).join('、')}` };
}

// ---- JSON 解析 ----
// 候選政策：查核員被要求「只輸出一個 JSON 物件」，所以回覆裡有幾份一樣像的結果＝交件不合格，誠實說沒查成，
// 不准靠「第一個」「最後一個」「圍欄裡的」這種位置裁判去猜——猜錯一次，真的 mismatch 就被吞成 pass。
//   (a) 全文一個池：```json 圍欄不優先——圍欄本來就在全文裡，掃全文就掃得到；圍欄裡放範例、正文放真結果的回覆一樣照名次比
//   (b) 包含依名次：被別的候選整個包住的，名次不高於外層才丟（真結果裡塞的 meta 子物件不算）；內層更像就兩個都留給名次裁——
//       空殼把真結果包在自己裡面、裸陣列包著真結果物件，都是內層贏
//   (c) 名次：層級（物件 2 ＞ 裸逐項表 1 ＞ 不算 0）→ 有沒有內容 → 型別對的欄位數
//   (d) 含糊即失敗：最高名次有兩份以上、正規化後內容不一樣＝丟錯；一字不差的重複收成一份

// 從 start 這個 { 或 [ 走到對應的收尾（字串內的括號與跳脫不算），回收尾的下一個位置；走到底還沒收就回 -1
function jsonEnd(s, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return i + 1;
  }
  return -1;
}

// 全文裡所有解得出來的 JSON：每個 { 與 [ 都當一次起點（含包在外層物件裡的），附起訖位置——誰包誰要靠位置看
function* jsonCandidates(s) {
  for (let start = 0; start < s.length; start++) {
    if (s[start] !== '{' && s[start] !== '[') continue;
    const end = jsonEnd(s, start);
    if (end < 0) continue;
    try { yield { value: JSON.parse(s.slice(start, end)), start, end }; } catch { /* 括號對得上但不是 JSON，略過 */ }
  }
}

// 名次逐項比大小（第一項最重要），全同回 0
function cmpRank(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// 照政策 (b)(c)(d) 從候選裡挑一份：回正規化後的結果；一份都不像回 null；含糊丟 CheckParseError（訊息由呼叫端給）
function selectCandidate(candidates, rank, normalize, ambiguousMessage) {
  const scored = [];
  for (const c of candidates) {
    const key = rank(c.value);
    if (key[0]) scored.push({ ...c, key });
  }
  // (b) 被嚴格包住、且名次不高於外層的才丟；內層更像就留著，讓下面的名次去裁
  const contains = (o, c) => o.start <= c.start && c.end <= o.end && o.end - o.start > c.end - c.start;
  const kept = scored.filter((c) => !scored.some((o) => contains(o, c) && cmpRank(c.key, o.key) <= 0));
  if (!kept.length) return null;
  kept.sort((a, b) => cmpRank(b.key, a.key));
  const top = kept.filter((c) => cmpRank(c.key, kept[0].key) === 0).map((c) => normalize(c.value));
  if (new Set(top.map((v) => JSON.stringify(v))).size > 1) throw new CheckParseError(ambiguousMessage);
  return top[0];
}

// 回覆裡挖 JSON：政策 (a)——全文一個池，圍欄不優先
// 匯出給監工用：三份監工回覆走同一套候選政策，含糊與挑不出來的行為才會一致
export const extractJson = (text, rank, normalize, ambiguousMessage) => selectCandidate(jsonCandidates(str(text)), rank, normalize, ambiguousMessage);

// 非空、且每個元素都是物件的陣列＝逐項表。空陣列與 []、[1]、[来源1] 不算——那是正文裡的括號，收了就等於放行。
const isItemList = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x));

// 有多像查核結果（政策 c）：層級——挑得出像樣的物件（2）就不看裸逐項表（1），裸陣列只是退路；
// 物件先比「有沒有內容」（items／must_violations／flags 任一非空）再比型別對的欄位數（滿分 4）。
// 先比內容是為了堵「欄位齊全但全空的範例」：範例四個欄位都寫了、真結果少寫一個，比欄位數就輸給範例。
function rankCheckResult(v) {
  if (Array.isArray(v)) return isItemList(v) ? [1] : [0];
  if (!v || typeof v !== 'object') return [0];
  const lists = [v.items, v.must_violations, v.flags];
  const typed = lists.filter(Array.isArray).length + (typeof v.summary === 'string' ? 1 : 0);
  return typed ? [2, lists.some((x) => Array.isArray(x) && x.length > 0) ? 1 : 0, typed] : [0];
}

// 正規化＝契約的四個欄位；裸逐項表包成 items。也是 (d) 比對「兩份是不是同一份」的依據
function normalizeCheckResult(v) {
  const j = Array.isArray(v) ? { items: v } : v;
  return {
    items: arr(j.items),
    must_violations: arr(j.must_violations),
    flags: arr(j.flags),
    summary: typeof j.summary === 'string' ? j.summary : '',
  };
}

export function parseCheckResult(text) {
  const v = extractJson(text, rankCheckResult, normalizeCheckResult, '查核員這次交了不只一份結果，分不出哪份是真的');
  // 回覆裡隨便一個括號不算查核結果——認不出查核表就當沒查（incomplete），不准當成「查過且全過」
  if (v === null) throw new CheckParseError('查核員這次沒有交出看得懂的結果');
  return v;
}

// ---- 分類 ----

const VERDICTS = ['ok', 'mismatch', 'unsupported', 'missing'];
const FLAG_KINDS = ['conclusion-changed', 'format', 'number-unsourced']; // number-unsourced＝沒程式權限時程式對數字只標不攔（runner 產生）

const HEDGED = /推測|估計|可能|或許|大概|疑似|約(?![定束])/; // 「約定」「約束」不是約略
export function classify(parsed, { editRules = [] } = {}) {
  const stopRules = new Set(arr(editRules).map(bare).filter(Boolean));
  const items = arr(parsed?.items).filter((x) => x && typeof x === 'object').map((x) => {
    const verdict = str(x.verdict).trim().toLowerCase();
    return {
      claim: str(x.claim),
      source: str(x.source),
      scope: str(x.scope),
      calc: str(x.calc),
      verdict: VERDICTS.includes(verdict) ? verdict : 'unsupported', // 看不懂的判定當沒根據，寧可攔
    };
  });

  const blocks = [];
  const missing = [];
  for (const it of items) {
    const block = (kind, detail) => blocks.push({ kind, claim: it.claim, source: it.source, detail });
    // ADR-010 決策 1：帶阿拉伯數字的主張歸程式對（checkNumbers），查核員對它說 mismatch／unsupported 一律不攔——
    // 關掉思考的查核員照樣會列「羊毛圍巾退貨金額 37,620 元」然後因為自己算不出來判 unsupported（全開版 3 趟裡 2 趟被這樣誤攔）。
    // 判定留在 items 當紀錄，不進 blocks；missing 不受影響（那是「指示要但資料本來就沒有」）
    // 決策 2 後半：成品自己標成推測的句子不查——規則第 3 條這麼寫，關掉思考的查核員照樣會列（adr010d 第 3 趟 4 條 unsupported 全是「可能…」），程式再擋一次
    const numeric = /\d/.test(it.claim) || HEDGED.test(it.claim);
    if (it.verdict === 'mismatch') { if (!numeric) block('number-mismatch', it.calc || '跟原始資料對不上'); }
    else if (it.verdict === 'unsupported') { if (!numeric) block('unsupported', it.calc || '原始資料裡找不到根據'); }
    else if (it.verdict === 'missing') missing.push({ claim: it.claim, detail: it.calc || it.source || '' });
    // ADR-010 決策 1、2：數字由程式對（checkNumbers），查核員不再列數字項也不寫算式——「查核員說 ok 但算式不成立」那條翻案拿掉；
    // verifyArithmetic 留著（不再被這裡用）
  }
  for (const v of arr(parsed?.must_violations)) {
    if (!v || typeof v !== 'object') continue;
    const rule = str(v.rule);
    // 撞到使用者在停點改出來的規則＝他已經講過一次還沒守，另分一類
    blocks.push({ kind: stopRules.has(bare(rule)) ? 'stop-edit' : 'must', claim: rule, source: '', detail: str(v.where) });
  }
  const flags = arr(parsed?.flags)
    .filter((f) => f && typeof f === 'object' && FLAG_KINDS.includes(f.kind))
    .map((f) => ({ kind: f.kind, detail: str(f.detail) }));

  const status = blocks.length ? 'blocked' : (missing.length ? 'missing' : 'pass');
  return { status, blocks, flags, missing, items, summary: str(parsed?.summary) };
}

// ---- 查核 prompt ----

// ADR-010 決策 2：查核員只查文字事實——數字由程式對（checkNumbers），查核員不列數字項、不驗算、沒有 calc。
// 查核員心算 200 筆 CSV 是 9 次查核 6 次逾時的原因（L073）。第 4～6 條逐字不動。
const JUDGE_RULES = [
  '1. 把成品裡每一個原始資料裡查得到的文字主張（名稱、事件、排序、引用、時程、規格）列成一項，逐項回到原始資料裡找根據。數字一律不列、不驗算——成品裡的數字已由程式對過，不是你的工作。需要自己加總、排序、統計整張表才能判斷的主張（例如誰是第一名、哪個通路最多）也不列——那些數字由程式對過。只列能在原始資料裡直接找到對應句子或欄位值的主張。',
  '2. verdict 只有四種：ok＝原始資料撐得住；mismatch＝跟原始資料對不上；unsupported＝原始資料裡找不到根據；missing＝指示要這一項但原始資料本來就沒有。unsupported 只用在事實性主張（事件、引用、名稱、時程、規格）；這一步被指示要做的判斷、評分、排序、建議本身不需要出處，但它引用的事實要有。source 抄原始資料的逐字原文，不准改寫或轉述；scope 寫清楚這個主張涵蓋的範圍（期間、類別、對象）。',
  '3. 成品裡標「推測」「估計」「可能」「約」的句子不列。一句話裡除了數字沒有別的主張，整句跳過。',
  '4. 「必守」逐條檢查，違反的寫進 must_violations：rule 抄那一條原文，where 寫成品哪裡違反。',
  '5. flags 只有兩種：conclusion-changed＝成品改了上游的結論或排序；format＝格式跟要求不同。其他一律不要寫。',
  '6. 只輸出一個 JSON 物件，前後不要任何其他文字。',
].join('\n');

// 流程沒開「數字對原始資料」（def.check.facts === false）時整段換掉 JUDGE_RULES：
// 第 1 條改成只找「該有的東西有沒有」，原第 4、5、6 條（必守、flags、只輸出 JSON）重新編號為 2、3、4
const JUDGE_RULES_MUSTS_ONLY = [
  '1. 這一步的主要工作是：使用者要求一定要有的東西，成品裡有沒有對應內容——逐條找。成品裡的事實不對照原始資料，items 給空清單。',
  '2. 「必守」逐條檢查，違反的寫進 must_violations：rule 抄那一條原文，where 寫成品哪裡違反。',
  '3. flags 只有兩種：conclusion-changed＝成品改了上游的結論或排序；format＝格式跟要求不同。其他一律不要寫。',
  '4. 只輸出一個 JSON 物件，前後不要任何其他文字。',
].join('\n');

// 範例的 claim 是文字主張（沒有數字、沒有 calc）——示範一個數字項會誤導查核員回去對數字
const OUTPUT_EXAMPLE = [
  '{"items":[{"claim":"退貨最多的是羊毛圍巾","source":"…原文逐字…","scope":"8 月、全部通路","verdict":"mismatch"}],',
  ' "must_violations":[{"rule":"每段不超過三句","where":"第二段有五句"}],',
  ' "flags":[{"kind":"conclusion-changed","detail":"上游排 D 第一，成品改成 C 第一，理由是…"}],',
  ' "summary":"一句話"}',
].join('\n');

// factsOff 時輸出範例改成 items 給空清單，其餘欄位形狀不變（跟 JUDGE_RULES_MUSTS_ONLY 第 1 條「items 給空清單」一致）
const OUTPUT_EXAMPLE_MUSTS_ONLY = [
  '{"items":[],',
  ' "must_violations":[{"rule":"每段不超過三句","where":"第二段有五句"}],',
  ' "flags":[{"kind":"conclusion-changed","detail":"上游排 D 第一，成品改成 C 第一，理由是…"}],',
  ' "summary":"一句話"}',
].join('\n');

// 開場白：預設版會叫查核員拿原始資料逐條對——factsOff 時「# 原始資料」段是空的，這樣寫會誤導模型自己把成品裡每個數字列成 item 再判 unsupported。
// factsOff 版不提原始資料，只叫查核員拿使用者的要求對成品。
const OPENING_LINES = [
  '你是「剝繭」流程的交貨查核員。這一步的成品已經做好，你的工作是拿原始資料與使用者的要求逐條對它，把對不上的地方挑出來。',
  '你不改成品、不補內容、不評論好不好——只回報事實對不對、要求有沒有守。原始資料裡沒有的東西，一律不准當成常識自己補。',
];
const OPENING_LINES_MUSTS_ONLY = [
  '你是「剝繭」流程的交貨查核員。這一步的成品已經做好，你的工作是拿使用者的要求逐條對成品，看一定要有的東西有沒有、格式對不對。',
  '你不改成品、不補內容、不評論好不好——只回報要求有沒有守。本流程沒開數字對原始資料，成品裡的事實不用查出處。',
];

// 必守第五路的小標（US-117 ②）：使用者說明書「紅線」段，逐條列在「# 必守（逐條對）」底下
export const REDLINE_HEADING = '## 你的紅線（使用者親口定的，跟上面同等必守）';

export function buildCheckPrompt({ title, requirements, sources, product }) {
  const req = requirements ?? {};
  // 必守三路＝使用者寫的：驗收重點、停點規則、群組規矩（違反歸既有 must 攔）
  const musts = [
    ...str(req.reviewFocus).split('\n').map((x) => x.trim()).filter(Boolean),
    ...arr(req.editRules).map((r) => str(r).trim()).filter(Boolean),
    ...arr(req.groupRules).map((r) => str(r).trim()).filter(Boolean),
  ];
  const format = [str(req.constraints).trim(), str(req.outputFormat).trim()].filter(Boolean);
  const factsOff = req.factsOff === true; // 流程關掉「數字對原始資料」：只對必守與格式
  // 監工備註是參考不是必守——自成一段擺在格式要求之後，永遠不併進 musts
  const notes = arr(req.supervisorNotes).map((x) => str(x).trim()).filter(Boolean);
  // 必守第四路：組織／分類規範整份貼成一段（不拆成條列——4,000 字的檔拆進 musts 會把清單撐爆），
  // 判定規則加一句「違反規範歸 must」；classify 不動，違反走既有 must 攔。沒給＝一字不多
  // 規範內文行首 # 降一級、###### 封頂（同 host-adapter，手冊標題不與段標題同級）
  const demote = (text) => str(text).replace(/^(#{1,6})(?=\s)/gm, (m) => (m.length < 6 ? `#${m}` : m));
  const ruleFiles = (list, layer) => arr(list).filter((f) => f && str(f.name)).flatMap((f) => [`## ${layer}：${str(f.name)}`, demote(f.text)]);
  const sharedRules = [...ruleFiles(req.companyRules, '公司規範'), ...ruleFiles(req.deptRules, '部門規範')];
  // 必守第五路（US-117 ②）：使用者說明書的「紅線」段——逐條列在必守底下自己的小標，違反走既有 must 攔（classify 不動、rule 抄原文）。
  // 沒給／全空＝一字不多；其他必守全空但有紅線＝不印「（無）」，直接接小標
  const redlines = arr(req.redlines).map((r) => str(r).trim()).filter(Boolean);
  const mustLines = [
    ...(musts.length ? [musts.map((m) => `- ${m}`).join('\n')] : (redlines.length ? [] : ['（無）'])),
    ...(redlines.length ? [REDLINE_HEADING, redlines.map((r) => `- ${r}`).join('\n')] : []),
  ];
  const judge = factsOff ? JUDGE_RULES_MUSTS_ONLY : JUDGE_RULES;
  const judgeExtra = [
    sharedRules.length ? '- 「公司／部門規範」段跟必守同等：違反規範歸 must_violations，rule 寫明是哪份規範的哪一條。' : null,
    redlines.length ? '- 「你的紅線」小標下每一條跟必守同等：違反歸 must_violations，rule 抄那一條原文。' : null,
  ].filter(Boolean);
  return [
    ...(factsOff ? OPENING_LINES_MUSTS_ONLY : OPENING_LINES),
    '全篇使用與「這一步」相同的語言。',
    '',
    `# 這一步：${str(title)}`,
    str(req.instruction),
    '',
    '# 必守（逐條對）',
    ...mustLines,
    ...(sharedRules.length ? ['', '# 公司／部門規範（一定要守）', ...sharedRules] : []),
    '',
    '# 格式要求',
    format.length ? format.join('\n') : '（無）',
    ...(notes.length ? ['', '# 監工備註（參考，不是必守）', notes.map((n) => `- ${n}`).join('\n')] : []),
    '',
    '# 判定規則',
    [judge, ...judgeExtra].join('\n'),
    '',
    '# 輸出格式',
    factsOff ? OUTPUT_EXAMPLE_MUSTS_ONLY : OUTPUT_EXAMPLE,
    '',
    // ADR-009 ⑤：標題講明這一段是使用者給的檔與欄位；祖先步驟的產出由 buildSources 另立「# 前面步驟的整理」段接在後面
    factsOff ? '# 原始資料' : '# 原始資料（使用者給的檔與欄位）',
    factsOff ? '（本流程沒開數字對原始資料，只對必守與格式）' : (str(sources) || '（無）'),
    '',
    '# 成品',
    str(product),
  ].join('\n');
}

// ---- 原始資料組裝 ----

// ADR-009 ⑤：兩段——前段（使用者給的）＝欄位→補的資料→參考檔節錄，落在呼叫端的「# 原始資料（使用者給的檔與欄位）」底下；
// 後段＝祖先步驟產出，自帶標題 UPSTREAM_HEADING（不是原始資料，衝突時以原始資料為準）。沒有祖先產出＝沒有後段，逐字同以前。
// 總量上限照舊從最前面截（留最近的）；perFile 只截參考檔
export const UPSTREAM_HEADING = '# 前面步驟的整理（不是原始資料；跟原始資料衝突時以原始資料為準）';
export function buildSources({ params = {}, paramLabels = {}, ancestors = [], supplied = '', attachments = [] } = {}, { cap = 80000, perFile = 20000 } = {}) {
  const raw = [];
  for (const [key, value] of Object.entries(params ?? {})) raw.push(`【欄位：${paramLabels?.[key] ?? key}】\n${str(value)}`);
  if (str(supplied).trim()) raw.push(`【你補的資料】\n${str(supplied)}`);
  for (const f of arr(attachments)) raw.push(`【參考檔：${str(f?.name)}】\n${str(f?.text).slice(0, perFile)}`);
  const upstream = arr(ancestors).map((a) => `【步驟：${str(a?.title)}】\n${str(a?.text)}`);
  const front = raw.length ? raw.join('\n\n') : (upstream.length ? '（無）' : ''); // 前段空著也要有東西，標題底下不能直接接另一個標題
  const back = upstream.length ? `${UPSTREAM_HEADING}\n${upstream.join('\n\n')}` : '';
  const join = (a, b) => (a && b ? `${a}\n\n${b}` : a || b);
  const all = join(front, back);
  if (all.length <= cap) return all;
  // 超過上限先砍後段（前面步驟的整理），原始資料能留就整段留；後段砍光還不夠才砍原始資料——
  // 這輪的方向是「原始資料為準」，不能反過來先把原始資料截掉、留下上游整理（ADR-009）
  const head = '（前面已截斷，只保留最近的資料）\n';
  if (cap < head.length) return ''; // L070：上限連提示語都塞不下 → 回空，不回一句比上限還長的提示語
  const tail = (s, room) => head + s.slice(s.length - Math.max(0, room - head.length));
  const roomForBack = cap - front.length - 2;
  if (front.length <= cap && roomForBack >= head.length + UPSTREAM_HEADING.length + 1) {
    return join(front, `${UPSTREAM_HEADING}\n${tail(back.slice(UPSTREAM_HEADING.length + 1), roomForBack - UPSTREAM_HEADING.length - 1)}`);
  }
  return tail(front, cap);
}

// ---- 成品檔文字 ----

const PLAIN_EXT = ['md', 'txt', 'csv', 'json', 'html', 'htm'];

// 成品是 Word／Excel 真檔時抽出可查核的文字；讀不出來、或抽出來只有空白＝等於沒抽到，一律回 null
//（呼叫端一個 null 判斷就夠，不會拿空字串去查核然後說「查過了」）
export async function extractFileText(buf, name) {
  const text = await readFileText(buf, str(name).toLowerCase().split('.').pop());
  return str(text).trim() ? text : null;
}


// pptx 抽文字。ppt/slides/slideN.xml 裡的 <a:t> 就是投影片上看得到的字；
// <a:p> 是一段。沒有這一支的話，每張簡報成品都會被判「成品檔讀不出來，這次沒查」——交貨查核對簡報整個失效。
// 查核員（readFileText）與頁內預覽（server.previewArtifact）共用這一支，兩邊看到的字才會一樣。
const XML_ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
export function pptxSlides(buf) {
  const zip = new PizZip(buf);
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  return names.map((name, i) => {
    const xml = zip.files[name].asText();
    const texts = [];
    for (const para of xml.split('</a:p>')) {
      // 同一段裡字型一變就會被切成好幾個 <a:t>，所以段內先接起來再當一行
      const line = (para.match(/<a:t[^>]*>[\s\S]*?<\/a:t>/g) ?? [])
        .map((m) => m.replace(/<[^>]+>/g, ''))
        .join('')
        .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENT[m]);
      if (line.trim()) texts.push(line.trim());
    }
    return { n: i + 1, texts };
  });
}

async function readFileText(buf, ext) {
  try {
    if (ext === 'docx') return str((await mammoth.extractRawText({ buffer: buf })).value);
    if (ext === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const out = [];
      wb.eachSheet((ws) => {
        out.push(`【表：${ws.name}】`);
        let rows = 0;
        ws.eachRow({ includeEmpty: false }, (row) => {
          if (rows >= 500) return;
          const cells = [];
          row.eachCell({ includeEmpty: true }, (cell) => cells.push(str(cell.text)));
          const line = cells.join('\t');
          if (!line.trim()) return;
          rows++;
          out.push(line);
        });
      });
      return out.join('\n');
    }
    if (ext === 'pptx') return pptxSlides(buf).map((s) => `【第 ${s.n} 張】\n${s.texts.join('\n')}`).join('\n\n');
    // PDF 進了產檔清單就一定要讀得回來，不然查核員會判「成品檔讀不出來，這次沒查」——
    // 簡報那次就是漏掉這一步，等於對那個格式整個失效
    if (ext === 'pdf') return str((await new PDFParse({ data: buf }).getText()).text);
    if (PLAIN_EXT.includes(ext)) return buf.toString('utf8');
  } catch {
    return null;
  }
  return null;
}

// ---- 查核與擬規則 ----

// 卷宗回呼（全域約束：存的全文＝送出的全文）：送出前交出這一份 prompt 原文。
// 刻意獨立 try——寫不進卷宗只是少一份紀錄，不該把查核／擬規則整個降級成沒查成或退回預設規則。
async function notePrompt(onPrompt, prompt) {
  if (typeof onPrompt !== 'function') return;
  try { await onPrompt(prompt); } catch { /* 卷宗寫不進不擋查核 */ }
}

export async function runCheck({ adapter, meta, title, requirements, sources, product, onPrompt }) {
  let raw = ''; // 收到的回覆原文；沒收到（連不上、卡在送出前）就是空字串
  try {
    const prompt = buildCheckPrompt({ title, requirements, sources, product });
    await notePrompt(onPrompt, prompt);
    const text = await adapter.complete({ prompt, meta: { ...(meta ?? {}), kind: 'check' } });
    raw = str(text);
    return { ...classify(parseCheckResult(text), { editRules: requirements?.editRules ?? [] }), note: '' };
  } catch (e) {
    // 查核本身失敗不擋交貨：狀態 incomplete，原因翻成人話給卡片顯示（宿主原話裡的操作指示由卡片上的按鈕負責，不重複推給使用者）
    // raw＝查核員這次到底回了什麼：卷宗只存指示，沒有原文，「這次沒查成」事後永遠查不出為什麼
    return { status: 'incomplete', blocks: [], flags: [], missing: [], items: [], summary: '', note: `這次沒查成：${humanReason(e)}`, raw };
  }
}

function humanReason(e) {
  return str(e?.message).replace(/可以按[\s\S]*$/, '').trim() || '原因不明';
}

export function buildEditRulesPrompt({ title, original, edited, note }) {
  return [
    '你是「剝繭」流程的規則整理員。使用者在停點親手改過這一步的產出，請看出他真正要的是什麼，寫成後面每一步都能照著做的要求。',
    '只寫改動裡看得出來的要求（數字、份量、格式、語氣、禁忌、對象），一條一句話、具體到執行者不用猜；沒把握的不要寫，寧可少一條。',
    '全篇使用與「這一步」相同的語言。',
    'scope 兩種：all＝後面每一步都要守；this-step＝只跟這一步的內容有關。',
    '只輸出一個 JSON 物件，前後不要任何其他文字：',
    '{"rules":[{"text":"…","scope":"all"}]}',
    '',
    `# 這一步：${str(title)}`,
    '',
    '# 原本的產出',
    str(original) || '（空）',
    '',
    '# 使用者改成',
    str(edited) || '（空）',
    '',
    '# 使用者的說明',
    str(note).trim() || '（沒有說明）',
  ].join('\n');
}

const isRule = (r) => Boolean(r && typeof r === 'object' && !Array.isArray(r) && typeof r.text === 'string' && r.text.trim());

// 合格的候選＝帶 rules 陣列、裡面至少一條寫得出來的物件（scope 沒寫也是規則，一律補 all，不加分）
const rankEditRules = (v) => (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.rules) && v.rules.some(isRule) ? [1] : [0]);
const normalizeEditRules = (v) => v.rules.filter(isRule).map((r) => ({ text: r.text.trim(), scope: r.scope === 'this-step' ? 'this-step' : 'all' }));

export async function deriveEditRules({ adapter, meta, title, original, edited, note, onPrompt }) {
  const fallback = [{ text: str(note).trim() || '以改過的版本為準', scope: 'all' }];
  try {
    const prompt = buildEditRulesPrompt({ title, original, edited, note });
    await notePrompt(onPrompt, prompt);
    const text = await adapter.complete({ prompt, meta: { ...(meta ?? {}), kind: 'edit-rules' } });
    // 同一套候選政策（全文一個池、包含依名次、含糊即失敗）：AI 貼了「範例」又貼「實際」兩組不同的規則，分不出他要哪組，
    // 丟出來的 CheckParseError 由下面接住退成預設——寧可退成「以改過的版本為準」，不准猜一組塞給下游每一步
    return extractJson(text, rankEditRules, normalizeEditRules, '規則整理員這次交了不只一組規則') ?? fallback;
  } catch {
    return fallback; // 擬不出來不擋停點：退成一條「以改過的版本為準」
  }
}
