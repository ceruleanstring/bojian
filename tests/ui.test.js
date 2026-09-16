// 前端（ui/app.js、ui/style.css）測試：讀原文做字串斷言＋用 node:vm 把單一頂層函式切出來跑（移植第一批 T4 起）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
let _ui, _css;
export const uiSrc = () => (_ui ??= fs.readFileSync(path.join(UI, 'app.js'), 'utf8'));
export const cssSrc = () => (_css ??= fs.readFileSync(path.join(UI, 'style.css'), 'utf8'));

// ---------- uiFn：把 app.js 的頂層函式切出來，在假 state 裡跑 ----------
// app.js 是瀏覽器腳本（頂層有 document／window／addEventListener）。做法：掃出全部頂層語句，
// 只把 const／let（改成 var，免 TDZ 汙染）與 function 宣告逐條 eval 進同一個 vm context；
// 碰 document 之類炸 ReferenceError 的那條跳過（記在 skipped）；事件綁定與 init 那些「其他語句」一律不跑。
// ctx 裡給的名字優先：同名的 app.js 宣告不載入，測試才能塞假 fmtInt／fileChipHtml／state。

// 頂層語句切片：處理字串、模板（含 ${} 巢狀）、註解、正規式；回傳 [start, end) 陣列
function splitTop(src) {
  const out = [];
  const n = src.length;
  let i = 0, depth = 0, start = -1, head = '';
  const tpl = []; // 模板 ${} 巢狀：每層記進入時的 depth，回到該 depth 的 } 就接回模板文字
  const kw = ['return', 'typeof', 'case', 'in', 'of', 'instanceof', 'delete', 'void', 'throw', 'new', 'do', 'else', 'yield', 'await'];
  const regexStart = (j) => { // / 是正規式開頭還是除號：看前一個非空白字元
    let k = j - 1;
    while (k >= 0 && /\s/.test(src[k])) k--;
    if (k < 0) return true;
    if (!/[\w$)\]]/.test(src[k])) return true;
    let w = k; while (w >= 0 && /[\w$]/.test(src[w])) w--;
    return kw.includes(src.slice(w + 1, k + 1));
  };
  const scanTpl = (j) => { // 從模板文字位置 j 掃到結尾 ` 或下一個 ${；回傳下一個 i
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') return j + 1;
      if (src[j] === '$' && src[j + 1] === '{') { tpl.push(depth); depth++; return j + 2; }
      j++;
    }
    return n;
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (depth === 0 && start < 0 && !/\s/.test(c) && !(c === '/' && (d === '/' || d === '*'))) { start = i; head = src.slice(i, i + 16); }
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"') { let j = i + 1; while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; } i = j + 1; continue; }
    if (c === '`') { i = scanTpl(i + 1); continue; }
    if (c === '/' && regexStart(i)) {
      let j = i + 1, cls = false;
      while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (cls) { if (src[j] === ']') cls = false; } else if (src[j] === '[') cls = true; else if (src[j] === '/' || src[j] === '\n') break; j++; }
      j++; while (j < n && /[a-z]/.test(src[j])) j++; i = j; continue;
    }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (c === '}' && tpl.length && tpl[tpl.length - 1] === depth) { tpl.pop(); i = scanTpl(i + 1); continue; }
      if (c === '}' && depth === 0 && start >= 0 && /^(async\s+)?function\b|^class\b|^(if|for|while|try|switch)\b/.test(head)) {
        let j = i + 1; while (j < n && /\s/.test(src[j])) j++;
        if (!/^(else|catch|finally)\b/.test(src.slice(j, j + 8))) { out.push([start, i + 1]); start = -1; }
      }
    } else if (c === ';' && depth === 0 && start >= 0) { out.push([start, i + 1]); start = -1; }
    i++;
  }
  if (start >= 0) out.push([start, n]);
  return out;
}

let _stmts;
const uiStmts = () => (_stmts ??= splitTop(uiSrc()).map(([s, e]) => {
  const text = uiSrc().slice(s, e);
  const m = /^(?:(const|let)\s+([\w$]+)|(?:async\s+)?function\s+([\w$]+)\s*\()/.exec(text);
  return m ? { text, kind: m[1] ? 'var' : 'fn', name: m[2] ?? m[3] } : null;
}).filter(Boolean));

// 建 vm context：基底 { state, esc, fmtInt } ＋ ctx，再載入 app.js 的頂層常數與函式（ctx 有的名字不載）
export function uiCtx(ctx = {}) {
  const sandbox = { esc: (s) => String(s ?? ''), fmtInt: String, ...ctx };
  const context = vm.createContext(sandbox);
  const skipped = [];
  for (const st of uiStmts()) {
    if (st.name in sandbox) continue;
    const code = st.kind === 'var' ? st.text.replace(/^(const|let)\b/, 'var') : st.text;
    try { vm.runInContext(code, context, { filename: `app.js#${st.name}` }); }
    catch (e) { if (e.name === 'ReferenceError' || e.name === 'TypeError') skipped.push(`${st.name}: ${e.message}`); else throw e; }
  }
  return { context, sandbox, skipped };
}

// 切出 `function <name>(` 到對應 `}` 的原文，在 uiCtx 裡 eval 後回傳該函式；沒有同名 function 宣告就回 context 裡的同名箭頭函式
export function uiFn(name, ctx = {}) {
  const { context, sandbox } = uiCtx(ctx);
  const st = uiStmts().find((s) => s.kind === 'fn' && s.name === name);
  if (st) return vm.runInContext(`(${st.text})`, context, { filename: `app.js#${name}` });
  if (typeof sandbox[name] === 'function') return sandbox[name];
  throw new Error(`uiFn：app.js 沒有頂層函式 ${name}`);
}

const cssVar = (name) => { const m = new RegExp(`${name.replace(/[-]/g, '\\-')}:([^;]+);`).exec(cssSrc()); return m ? m[1].trim() : null; };
const cssRule = (sel) => { const m = new RegExp(`^${sel.replace(/\./g, '\\.')}\\{([^}]*)\\}`, 'm').exec(cssSrc()); return m ? m[1] : null; };
const count = (src, needle) => src.split(needle).length - 1;

// ---------- T4 皮：淡暖 token 五組＋去柔霧底與玻璃層 ----------
test('T4 皮①：紙面 token 改純色——--wp／--hairline／--m1〜m4-bg／--paper-rail', () => {
  const css = cssSrc();
  assert.ok(css.includes('--wp:#fcfbf9'), '--wp 該是純色 #fcfbf9');
  assert.ok(css.includes('--hairline:rgb(128 118 100 / .18)'), '--hairline 該是暖灰 rgb(128 118 100 / .18)');
  assert.ok(css.includes('--m1-bg:#f7f5f1'), '--m1-bg（側欄）該是 #f7f5f1');
  assert.ok(css.includes('--m2-bg:#fcfbf9'), '--m2-bg（頂欄）該是 #fcfbf9');
  assert.ok(css.includes('--m3-bg:#ffffff'), '--m3-bg（卡片／work）該是純白');
  assert.ok(css.includes('--m4-bg:#fcfbf9'), '--m4-bg（抽屜／浮窗）該是 #fcfbf9');
  assert.ok(css.includes('--paper-rail:#f5f3ef'), '新增 --paper-rail:#f5f3ef');
});

test('T4 皮②：漸層底 0 命中；--m1-f〜--m4-f 各一個 none（去玻璃）', () => {
  const css = cssSrc();
  assert.equal(count(css, 'radial-gradient(120%'), 0, 'radial-gradient(120% 該清掉');
  assert.equal(count(css, 'linear-gradient(158deg'), 0, 'linear-gradient(158deg 該清掉');
  for (const k of ['--m1-f', '--m2-f', '--m3-f', '--m4-f']) assert.equal(count(css, `${k}:none`), 1, `${k}:none 該剛好一個`);
  assert.equal(count(css, 'blur('), 0, '硬編 blur( 該清掉（.cvdrawer 原本自帶 blur(16px)，8788 實走抓到，改走 --m4）');
});

test('T4 皮③：陰影 --e1〜--e4 換暖色 rgb(70 50 20，紫底 rgb(40 20 60 0 命中', () => {
  const css = cssSrc();
  for (const k of ['--e1', '--e2', '--e3']) assert.ok(cssVar(k)?.includes('rgb(70 50 20'), `${k} 該含 rgb(70 50 20：${cssVar(k)}`);
  assert.equal(cssVar('--e4'), '-14px 0 34px -18px rgb(70 50 20 / .30)', '--e4 同色系減淡');
  assert.equal(count(css, 'rgb(40 20 60'), 0, 'rgb(40 20 60 該清掉');
  assert.equal(count(css, 'rgb(30 20 70'), 0, 'rgb(30 20 70 該清掉');
  assert.equal(count(css, 'rgb(20 10 50'), 0, '.modal／.pvmodal 冷紫陰影 rgb(20 10 50 該換暖色（覆核員抓到）');
});

test('T4 皮④：.modalback 與 .pvback 遮罩換暖灰 rgb(60 45 20', () => {
  for (const sel of ['.modalback', '.pvback']) {
    const rule = cssRule(sel);
    assert.ok(rule, `${sel} 規則該存在`);
    assert.ok(rule.includes('background:rgb(60 45 20'), `${sel} 的 background 該含 rgb(60 45 20：${rule}`);
  }
  assert.equal(count(cssSrc(), 'rgb(20 16 40'), 0, 'rgb(20 16 40 該清掉');
});

// ---------- uiFn 骨架：T5／T6 要用的五個函式切得出來、跑得動（不斷言輸出） ----------
test('uiFn 骨架：stepPill／checkChip／dashRunCard／sideHtml／workHeadHtml 各切一次不 crash', (t) => {
  const { skipped } = uiCtx();
  t.diagnostic(`uiCtx 跳過（碰 document 等）：${skipped.join('；') || '無'}`);
  assert.ok(skipped.every((s) => /^(app|hostdot):/.test(s)), `只准跳過 app／hostdot 兩個 DOM 常數：${skipped.join('；')}`);
  const stepPill = uiFn('stepPill');
  const checkChip = uiFn('checkChip');
  const dashRunCard = uiFn('dashRunCard', { fmtInt: String, fileChipHtml: () => '', state: { dash: { open: {} } } });
  const sideHtml = uiFn('sideHtml');
  const workHeadHtml = uiFn('workHeadHtml');
  for (const [k, f] of Object.entries({ stepPill, checkChip, dashRunCard, sideHtml, workHeadHtml })) assert.equal(typeof f, 'function', `${k} 該是函式`);
  const outs = {
    stepPill: stepPill({ status: 'done' }),
    checkChip: checkChip({ check: { status: 'pass' } }, { input: 12, output: 3 }),
    dashRunCard: dashRunCard({ category: 'c', id: 'w', run_id: 'r1', name: 'n', status: 'done', steps: { done: 1, total: 1, failed: 0 }, finals: [] }),
    sideHtml: sideHtml(),
    workHeadHtml: workHeadHtml(),
  };
  for (const [k, v] of Object.entries(outs)) { assert.equal(typeof v, 'string', `${k} 該回字串`); assert.ok(v.length > 0, `${k} 不該回空字串`); t.diagnostic(`${k} → ${v.replace(/\s+/g, ' ').slice(0, 110)}`); }
});

// ---------- T5 狀態色收斂：膠囊只剩 wait（琥珀）／bad（紅）／quiet（灰）五表對齊；色條照 09-10 定案 C ----------
const STATUS_CHIPS = ['chip green', 'chip amber', 'chip red', 'chip blue', 'chip violet'];

test('T5 ①：stepPill 十種 status → bad／wait／quiet；字面「停點／人工處理／出錯／資料不全／等你」各一次，舊字 0 命中（U6a 補 waiting_check；U6b 字改「等你」）', () => {
  const stepPill = uiFn('stepPill');
  const out = Object.fromEntries(['done', 'running', 'waiting_review', 'waiting_human', 'waiting_branch', 'waiting_data', 'waiting_check', 'failed', 'skipped', 'nonsense']
    .map((s) => [s, stepPill({ status: s })]));
  assert.ok(out.failed.includes('chip bad'), `failed 該是 chip bad：${out.failed}`);
  for (const s of ['waiting_review', 'waiting_human', 'waiting_branch', 'waiting_data', 'waiting_check']) assert.ok(out[s].includes('chip wait'), `${s} 該是 chip wait：${out[s]}`);
  for (const s of ['done', 'running', 'skipped', 'nonsense']) assert.ok(out[s].includes('chip quiet'), `${s} 該是 chip quiet：${out[s]}`);
  assert.ok(out.waiting_check.includes('ph-hand-palm'), `waiting_check 圖標 ph-hand-palm（同 checkChip blocked）：${out.waiting_check}`);
  const all = Object.values(out).join('\n');
  // U6b：waiting_check 的字改「等你」——中欄那列已有 checkChip 的「查核攔下」，同列同字不留兩顆
  for (const w of ['停點', '人工處理', '出錯', '資料不全', '等你']) assert.equal(count(all, w), 1, `「${w}」該剛好出現一次`);
  assert.equal(count(all, '查核攔下'), 0, '「查核攔下」留給 checkChip，stepPill 不印');
  for (const w of ['等你過目', '這步你來', '出狀況停住', '等你選路', '資料不全停住']) assert.equal(count(all, w), 0, `舊字「${w}」該清掉`);
  for (const c of STATUS_CHIPS) assert.equal(count(all, c), 0, `stepPill 不該再吐 ${c}`);
  assert.ok(stepPill({ status: 'done', edited_output: 'x' }).includes('完成 · 你改過'), '改過的完成步驟仍標「 · 你改過」');
  assert.ok(out.skipped.includes('跳過'), 'skipped 的字沿用現況');
});

test('T5 ②：checkChip：blocked／incomplete→wait、pass／redo-pass／accepted→quiet；usage 有值仍印「查核 N token」', () => {
  const checkChip = uiFn('checkChip');
  const c = (status, usage) => checkChip({ check: { status } }, usage);
  for (const s of ['blocked', 'incomplete']) assert.ok(c(s).includes('chip wait'), `${s} 該是 chip wait：${c(s)}`);
  for (const s of ['pass', 'redo-pass', 'accepted']) assert.ok(c(s).includes('chip quiet'), `${s} 該是 chip quiet：${c(s)}`);
  assert.ok(c('pass', { input: 12, output: 3 }).includes('查核 15 token'), `usage 該仍印查核 token：${c('pass', { input: 12, output: 3 })}`);
  assert.equal(c('off'), '', 'off 不標');
  for (const s of ['blocked', 'incomplete', 'pass', 'redo-pass', 'accepted']) for (const k of STATUS_CHIPS) assert.equal(count(c(s), k), 0, `${s} 不該吐 ${k}`);
});

test('T5 ③：dashRunCard：done／running→quiet、有步驟失敗→bad、其餘→wait「等你」', () => {
  const dashRunCard = uiFn('dashRunCard', { fmtInt: String, fileChipHtml: () => '', state: { dash: { open: {} } } });
  const base = { category: 'c', id: 'w', run_id: 'r1', name: 'n', steps: { done: 1, total: 2, failed: 0 }, finals: [] };
  const head = (r) => { // 名字後面第一顆 chip：[class, 字（去標籤）]
    const m = /<b>n<\/b><span class="chip ([^"]*)">(.*?)<\/span>/.exec(dashRunCard({ ...base, ...r }));
    assert.ok(m, `該有狀態 chip：${dashRunCard({ ...base, ...r }).slice(0, 200)}`);
    return [m[1].trim(), m[2].replace(/<[^>]+>/g, '')];
  };
  assert.deepEqual(head({ status: 'done' }), ['quiet', '完成']);
  assert.deepEqual(head({ status: 'running' }), ['quiet', '進行中']);
  assert.equal(head({ status: 'paused', steps: { done: 1, total: 2, failed: 1 } })[0], 'bad');
  assert.deepEqual(head({ status: 'paused', steps: { done: 1, total: 2, failed: 0 } }), ['wait', '等你']);
});

test('T5 ④：uiSrc 內 chip green／\'green\' 0 命中；STEP_TXT 表只剩 wait／bad／quiet／空，逐格照契約 A', () => {
  const src = uiSrc();
  assert.equal(count(src, 'chip green'), 0, '「v · 現行」「現行版」成品檔 chip「啟用中」四處綠 chip 該改無色');
  assert.equal(count(src, "'green'"), 0, "hostdot／Google 快照／Claude 連線三處 `'green'` 也該退場（整頁無綠）");
  const m = /const STEP_TXT = \{([\s\S]*?)\};/.exec(src);
  assert.ok(m, 'dashStepRows 內該有 STEP_TXT 區塊');
  for (const c of ["'amber'", "'red'", "'green'", "'blue'"]) assert.equal(count(m[1], c), 0, `STEP_TXT 不該再有 ${c}`);
  const tbl = new Function(`return {${m[1]}}`)();
  const want = {
    done: 'quiet', skipped: 'quiet', pending: 'quiet', running: 'quiet', waiting_time: 'quiet',
    waiting_review: 'wait', waiting_human: 'wait', waiting_branch: 'wait', waiting_data: 'wait', time_pending: 'wait', waiting_check: 'wait',
    failed: 'bad',
  };
  for (const [k, tone] of Object.entries(want)) assert.equal(tbl[k]?.[0], tone, `STEP_TXT.${k} 該是 ${tone}：${JSON.stringify(tbl[k])}`);
  for (const [k, v] of Object.entries(tbl)) assert.ok(['wait', 'bad', 'quiet', ''].includes(v[0]), `STEP_TXT.${k} 的色只准 wait／bad／quiet／空：${v[0]}`);
  assert.equal(count(src, "'<span class=\"chip green'"), 0);
  assert.equal(count(src, 'class="chip amber"><i class="ph-fill ph-hourglass-medium"></i>停著等你'), 0, 'run 頁頂 pill 停著等你該改 wait');
  assert.ok(src.includes('class="chip wait"><i class="ph-fill ph-hourglass-medium"></i>停著等你'), 'run 頁頂 pill：停著等你→wait');
  assert.ok(src.includes('class="chip quiet"><i class="ph-fill ph-check-circle"></i>全部完成'), 'run 頁頂 pill：全部完成→quiet');
  assert.ok(src.includes('class="chip quiet">第 ${Math.min(doneCount + 1, def.nodes.length)} 步'), 'run 頁頂 pill：第 N 步→quiet');
});

test('T5 ⑤：style.css 有 .chip.wait（＝舊 amber 值）／.chip.bad（＝舊 red 值）／.chip.quiet（--paper-rail 底）；無 .chip.green；儀表板 .st 同套', () => {
  const css = cssSrc();
  assert.ok(cssRule('.chip.wait'), '.chip.wait 該存在');
  assert.equal(cssRule('.chip.wait'), cssRule('.chip.amber'), '.chip.wait＝現 .chip.amber 值');
  assert.ok(cssRule('.chip.bad'), '.chip.bad 該存在');
  assert.equal(cssRule('.chip.bad'), cssRule('.chip.red'), '.chip.bad＝現 .chip.red 值');
  assert.ok(css.includes('.chip.quiet{background:var(--paper-rail)'), '.chip.quiet 底該是 --paper-rail');
  assert.ok(cssRule('.chip.quiet').includes('color:var(--ink-500)'), '.chip.quiet 字該是 --ink-500');
  assert.equal(count(css, '.chip.green'), 0, '.chip.green 該刪');
  for (const t of ['wait', 'bad', 'quiet']) assert.ok(css.includes(`.stepline .st.${t}{`), `儀表板展開列 .st.${t} 該有規則（STEP_TXT 的色進的是 .st 不是 .chip）`);
  for (const t of ['green', 'red', 'amber', 'blue']) assert.equal(count(css, `.stepline .st.${t}{`), 0, `.st.${t} 沒人用了該刪`);
  assert.equal(count(css, 'rgb(var(--green-rgb)'), 0, '整頁無綠：.filechip:hover 的綠也該退');
});

test('T5 ⑥（定案 C）：色條只留琥珀等你／紅出錯、選中藍框；紫／綠／accent 條退場；行事曆 AI 自動改灰', () => {
  const css = cssSrc();
  for (const sel of ['.step.done::before', '.step.running::before', '.step.humanmarked::before', '.step.sel::before', '.node.human::before', '.cev.human::before', '.item.you::before']) {
    assert.equal(count(css, sel), 0, `${sel} 該刪（條回預設灰）`);
  }
  for (const sel of ['.step.halt::before', '.step.errstep::before', '.node.hold::before', '.cev.missed::before', '.cev.makeup::before', '.item.err::before', '.item.hold::before', '.item.warn::before']) {
    assert.equal(count(css, sel), 1, `${sel} 該留`);
  }
  assert.equal(count(css, 'var(--violet)'), 0, '紫色 3px 條 0 命中');
  assert.equal(count(css, 'var(--green)'), 0, '綠色 3px 條 0 命中');
  assert.ok(css.includes('.cev.auto::before{background:var(--ink-300)}'), '行事曆 AI 自動事件：條改灰');
  assert.ok(css.includes('.cev.auto .t{color:var(--ink-500)}'), '行事曆 AI 自動事件：字改灰');
  assert.ok(css.includes('.cev.human .t{color:var(--ink-500)}'), '行事曆人做事件：字改灰');
  const sel = cssRule('.step.sel');
  assert.ok(sel?.includes('outline:2px solid var(--accent)') && sel.includes('outline-offset:-2px'), `.step.sel 該是藍框：${sel}`);
  assert.ok(sel.includes('background:rgb(var(--accent-rgb) / .12)'), '.step.sel 淡藍底留');
  assert.equal(cssRule('.step.done'), 'color:var(--ink-500)', '.step.done 字色留');
  assert.equal(cssRule('.item.prop::before'), 'background:var(--amber)', '優化提議列＝等你決定，條改琥珀（主 agent 定）');
  assert.equal(cssRule('.card.hold'), 'border-left:3px solid var(--amber)', '.card.hold 琥珀左緣留');
  for (const r of ['.mkic.you', '.who.hu', '.who.ai']) assert.ok(cssRule(r) && !/violet|accent/.test(cssRule(r)), `${r} 該退紫／藍改灰：${cssRule(r)}`);
});

test('T5 ⑦：執行者 chip 無色＋人做步驟前置 ph-user；行事曆人做事件也帶 ph-user', () => {
  const src = uiSrc();
  assert.equal(count(src, "executor === 'human' ? 'violet' : 'blue'"), 0, '執行者 chip 不再紫／藍');
  assert.equal(count(src, `'<i class="ph ph-user"></i>你來' : 'AI'`), 2, '步驟清單＋run 頁兩處執行者 chip：你來帶 ph-user、AI 無圖標');
  const stepListHtml = uiFn('stepListHtml', { state: { expanded: new Set() } });
  const def = { nodes: [{ id: 'a', title: '人做', executor: 'human', next: ['b'] }, { id: 'b', title: 'AI做', executor: 'ai', next: [] }] };
  const rows = stepListHtml(def).split('<div class="step').slice(1);
  assert.equal(rows.length, 2);
  const [hu, ai] = rows;
  assert.ok(hu.includes('<span class="chip"><i class="ph ph-user"></i>你來</span>'), `人做步驟：無色 chip＋ph-user：${hu}`);
  assert.ok(hu.startsWith(' humanmarked"'), 'humanmarked class 留（DOM 不動，只是條不再上色）');
  assert.ok(ai.includes('<span class="chip">AI</span>'), `AI 步驟：無色 chip 無圖標：${ai}`);
  assert.equal(count(ai, 'ph-user'), 0, 'AI 步驟不該有人形');
  for (const c of STATUS_CHIPS) assert.equal(count(hu + ai, c), 0, `步驟清單不該有 ${c}`);
  const calEvChip = uiFn('calEvChip');
  const ev = (kind) => calEvChip({ kind, time: '09:00', title: '晨報' });
  assert.ok(ev('human').includes('<i class="ph ph-user"></i>'), `行事曆人做事件該帶 ph-user：${ev('human')}`);
  assert.equal(count(ev('auto'), 'ph-user'), 0, 'AI 自動事件不帶人形');
  assert.ok(ev('human').includes('class="cev human"'), 'cev kind class 不動');
});

test('T5 ⑧ 畫布節點執行者 chip（canvas.js）：紫／藍退場、人做帶 ph-user（定案 C，主 agent 補）', () => {
  const cv = fs.readFileSync(path.join(UI, 'canvas.js'), 'utf8');
  assert.equal(count(cv, "'violet' : 'blue'"), 0, 'canvas.js 執行者 chip 不該再分紫藍');
  assert.equal(count(cv, 'chip violet'), 0, 'canvas.js 無 chip violet');
  assert.ok(cv.includes(`'<i class="ph ph-user"></i>你來'`), '畫布人做節點 chip 該帶 ph-user');
});

// ---------- T6 文案 A：卡片鈕、記憶卡標籤、抽屜標籤、零碎短詞化（契約 B 第 1、2、3、6 組；不碰 src） ----------
const T6_SCAN = ['我改一下', '回話重做', '就這樣過', '先放著', '晚點回來', '我補給你', '就用現有的做', '我處理好了', '重抓一次',
  '誰說的', '怎麼用', '從哪來', '做完給你看', 'AI 來做', '你來做', '開跑時會拿到', '這次的設定', '先跳過', '自動補跑（不勾',
  '問我補不補', '常用⋯', '存常用', '要你看一眼', '記住這三條', '存進去', '清掉重來', '存起來', '只有這一步', '重試這步',
  '用改過的版本往下', '取消，不改了'];
// 例外表（契約 A-1：note／title／描述句不改）：命中行必含這些字面之一；表上的字面若已不存在也紅，免得例外表變殭屍
const T6_SCAN_ALLOW = {
  '你來做': ['title="這步你來做，完成後回報一句"', '（你來做）交出的內容'], // :650 步驟 title 提示句；:1072 抽屜輸入清單描述句
  '要你看一眼': ['需要你看一眼的'], // :2551 設定→記憶 h5 段標（契約 B 未列）；:2552 note
  '存起來': ['這份流程會存起來，愈用愈準', '左邊寫幾條存起來'], // :765 sub 句；:2255 note
  // 「重試這步」原有一處 note 引用舊鈕名（設定→連線），鈕已改名「重試」，引用跟著改，不留例外
};
const btnsOf = (html) => [...html.matchAll(/<button class="btn[^"]*" data-act="([^"]+)"[^>]*>(.*?)<\/button>/g)].map((m) => [m[1], m[2].replace(/<[^>]+>/g, '')]);
const CARD_STUBS = { mdBlock: () => '', mdToggleHtml: () => '', memoryUsedHtml: () => '', supervisorNoteHtml: () => '', fileChipHtml: () => '' };
const cardState = (extra = {}) => ({ editingNode: null, dataSupplyOpen: null, editRulesOpen: null, keep: {}, run: { run_id: 'r1', workflow: { category: 'c', id: 'w' }, params: {} }, ...extra });

test('T6 ①：舊字掃描——契約 B 第 1、2、3、6 組 31 個舊字在 app.js 0 命中（例外表逐行核）', () => {
  const lines = uiSrc().split('\n');
  const bad = [];
  for (const w of T6_SCAN) {
    const allow = T6_SCAN_ALLOW[w] ?? [];
    lines.forEach((ln, i) => { if (ln.includes(w) && !allow.some((a) => ln.includes(a))) bad.push(`「${w}」@${i + 1}: ${ln.trim().slice(0, 90)}`); });
  }
  assert.deepEqual(bad, [], `舊字還在：\n${bad.join('\n')}`);
  for (const [w, list] of Object.entries(T6_SCAN_ALLOW)) for (const a of list) assert.ok(lines.some((ln) => ln.includes(w) && ln.includes(a)), `例外表「${w}」的「${a}」已不存在，該從表上拿掉`);
});

test('T6 ②：停點卡 繼續／編輯／稍後（data-act 不動、不加第四鈕）；編輯框 繼續／取消；查核卡四鈕；資料不全卡四鈕；人工／分岔／出錯卡；停點規則', () => {
  const node = { id: 'n1', title: '寫稿', instruction: '做', next: [] };
  const step = { output: '成品', error: '炸了', data_note: '缺名單', check: { blocks: [], summary: '' } };
  const stop = uiFn('stopCardHtml', { ...CARD_STUBS, state: cardState() })(node, step);
  assert.deepEqual(btnsOf(stop), [['approve', '繼續'], ['start-edit', '編輯'], ['back', '稍後']], `停點卡三鈕：${btnsOf(stop)}`);
  const editing = uiFn('stopCardHtml', { ...CARD_STUBS, state: cardState({ editingNode: 'n1' }) })(node, step);
  assert.deepEqual(btnsOf(editing), [['edit', '繼續'], ['cancel-edit', '取消']], `編輯框兩鈕：${btnsOf(editing)}`);
  const check = uiFn('checkCardHtml', { ...CARD_STUBS, state: cardState() })(node, step);
  assert.deepEqual(btnsOf(check), [['check-retry', '重做'], ['check-accept', '放行'], ['start-edit', '修改'], ['back', '稍後']], `查核卡四鈕：${btnsOf(check)}`);
  const data = uiFn('dataCardHtml', { ...CARD_STUBS, state: cardState() })(node, step);
  assert.deepEqual(btnsOf(data), [['data-retry', '重抓'], ['data-accept', '沿用'], ['data-supply-open', '補資料'], ['back', '稍後']], `資料不全卡四鈕：${btnsOf(data)}`);
  const human = uiFn('humanCardHtml', { ...CARD_STUBS, state: cardState({ run: { run_id: 'r1', def: { nodes: [node], params: [] }, params: {} } }) })(node);
  assert.deepEqual(btnsOf(human), [['human-done', '標記完成'], ['back', '稍後']], `人工卡：${btnsOf(human)}`);
  const branch = uiFn('branchChoiceCardHtml', { ...CARD_STUBS, state: cardState({ run: { def: { nodes: [node] } } }) })({ ...node, branches: [] });
  assert.deepEqual(btnsOf(branch), [['back', '稍後']], `分岔卡：${btnsOf(branch)}`);
  const fail = uiFn('failCardHtml', { ...CARD_STUBS, state: cardState() })(node, step);
  assert.deepEqual(btnsOf(fail), [['retry', '重試'], ['back', '稍後']], `出錯卡：${btnsOf(fail)}`);
  const rules = { edit_rules: [{ text: '用繁中', scope: 'this-step' }] };
  const rulesView = uiFn('editRulesHtml', { ...CARD_STUBS, state: cardState() })(node, rules);
  assert.ok(rulesView.includes('<span class="chip">僅此步</span>'), `停點規則 chip 僅此步：${rulesView}`);
  assert.ok(rulesView.includes('data-act="edit-rules-open" data-node="n1"><i class="ph ph-pencil-simple"></i>編輯</span>'), `停點規則 改一下→編輯：${rulesView}`);
  const rulesEdit = uiFn('editRulesHtml', { ...CARD_STUBS, state: cardState({ editRulesOpen: 'n1' }) })(node, rules);
  assert.deepEqual(btnsOf(rulesEdit), [['edit-rules-save', '儲存'], ['edit-rules-cancel', '取消']], `停點規則編輯：${btnsOf(rulesEdit)}`);
});

test('T6 ③：記憶卡浮窗 .k 標籤 來自／用法／範圍／來源／有效期；群組卡「來自」印「分類・旅遊」', () => {
  const ks = (html) => [...html.matchAll(/<div class="k">(.*?)<\/div><div class="v">(.*?)<\/div>/g)].map((m) => [m[1], m[2]]);
  const card = { id: 'h-1', bucket: 'habit', text: '用繁中', who: 'you', field: '語言', scope: { level: 'all' }, source: { kind: 'chat' }, expires: null, status: 'active' };
  const habit = uiFn('memCardModalHtml', { state: { memModal: { id: 'h-1', bucket: 'habit', card, err: null, busy: false }, keep: {}, run: null } })();
  assert.deepEqual(ks(habit).map((x) => x[0]), ['來自', '用法', '範圍', '來源', '有效期'], `習慣卡標籤：${ks(habit)}`);
  assert.equal(ks(habit)[2][1], '全部流程', '「範圍」值仍走 memScopeText');
  const group = uiFn('memCardModalHtml', { state: { memModal: { id: 'g-1', bucket: 'group', card: { id: 'g-1', text: '不用簡體', field: null, value: null, category: '旅遊' }, err: null, busy: false }, keep: {}, run: null } })();
  assert.deepEqual(ks(group).map((x) => x[0]), ['來自', '用法', '範圍', '來源'], `群組卡標籤：${ks(group)}`);
  assert.equal(ks(group)[0][1], '分類・旅遊', '群組卡「來自」印「分類・X」（契約 D5）');
});

test('T6 ④：「用在哪」只剩註解與詞典「用在哪些流程」；src/memory.js 的驗證訊息原封不動', () => {
  const hits = uiSrc().split('\n').map((ln, i) => [i + 1, ln]).filter(([, ln]) => ln.includes('用在哪'));
  assert.ok(hits.length >= 2, `該至少剩註解＋詞典表頭：${hits.map((h) => h[0])}`);
  for (const [no, ln] of hits) assert.ok(ln.trim().startsWith('//') || ln.includes('用在哪些流程'), `「用在哪」@${no} 既不是註解也不是詞典「用在哪些流程」：${ln.trim().slice(0, 90)}`);
  const mem = fs.readFileSync(path.join(UI, '..', 'src', 'memory.js'), 'utf8');
  assert.ok(mem.includes('用在哪只能是全部、分類、流程'), 'src/memory.js:21 驗證訊息不准動（memory.test／server.test 有斷言）');
});

test('T6 ⑤：抽屜／流程頁／零碎：AI 執行／人工、停點、輸入來源、本次資料、常用片段⋯×4、存為片段、錯過時、記憶待整理', () => {
  const src = uiSrc();
  assert.ok(src.includes(`<option value="ai" \${isAI ? 'selected' : ''}>AI 執行</option><option value="human" \${!isAI ? 'selected' : ''}>人工</option>`), '抽屜執行者下拉 AI 執行／人工');
  assert.ok(src.includes(`id="cv-stop" \${n.stop_point === 'always' ? 'checked' : ''}> 停點</label>`), '抽屜勾選「停點」');
  assert.equal(count(src, '<div class="overline">輸入來源</div>'), 2, '抽屜「輸入來源」overline 兩處（檢查中＋清單）');
  assert.ok(src.includes('<h5>本次資料</h5>'), '流程頁 h5 本次資料（分頁結構歸 T10；U4b 底部另有「只用於本次」）');
  assert.equal(count(src, '<option value="">常用片段⋯</option>'), 3, '常用片段⋯：模板＋JS 重繪兩處');
  assert.ok(src.includes("window.alert('先在「常用片段⋯」裡選一個要刪的')"), 'alert 句跟著改名');
  assert.ok(src.includes('<i class="ph ph-star"></i>存為片段</span>'), '存常用→存為片段');
  assert.ok(src.includes('<span class="lb2">錯過時</span>') && src.includes('>自動補（不勾＝先詢問）</label>'), '新增排程視窗：列標題「錯過時」＋勾選字「自動補（不勾＝先詢問）」（同列不念兩次錯過）');
  assert.equal(count(src, '錯過的時候'), 0, '舊列標題「錯過的時候」清掉');
  assert.ok(src.includes("setRow('錯過時', "), '設定→執行與排程 列標題「錯過時」');
  assert.ok(src.includes('data-v="false">先詢問</span>') && src.includes('data-v="true">自動補</span>'), '設定 seg 先詢問／自動補');
  assert.ok(src.includes('記憶待整理 ${ex.total} 條'), '儀表板記憶列');
  assert.ok(src.includes("it.saving ? '記著⋯' : '儲存'"), '介紹頁 記住這三條→儲存');
  assert.ok(src.includes('data-act="intro-skip" ${it.saving ? \'disabled\' : \'\'}>先略過</button>'), '介紹頁 先跳過→先略過');
  assert.equal(count(src, 'data-act="clear-draft">清空</button>'), 2, '清掉重來→清空 兩處');
  assert.ok(src.includes('data-act="confirm-save-draft">儲存</button>'), '存進去→儲存');
  assert.ok(src.includes("accepted: ['quiet', 'ph ph-check', '你說放行']"), 'CHECK_CHIP accepted 膠囊跟著「放行」（契約 B 未列行號，依全域約束膠囊要改）');
  assert.equal(count(src, '記下</button>'), 1, '「記下」不動');
  assert.equal(count(src, 'placeholder="給接下來的步驟交代一句（選填）"'), 1, '框標籤句不動');
});

test('T6 ⑥：GLOSSARY 六處改字、行數不超預算 100、「存為片段」剛好一次', () => {
  const g = fs.readFileSync(path.join(UI, '..', '..', 'GLOSSARY.md'), 'utf8');
  assert.ok(count(g, '\n') <= 100, 'wc -l GLOSSARY.md 該 ≤100（budgets.json；活文件不寫死精確行數，2026-09-17 拆法輪設計站改）');
  assert.equal(count(g, '存為片段'), 1, 'grep -c 存為片段 該是 1');
  assert.ok(g.includes('\n| 停點 | stop_point |'), '停點列中文欄「停點」');
  assert.ok(g.includes('\n| 本次資料（這次的設定） | overrides |'), '本次資料列');
  assert.ok(g.includes('UI：錯過時 先詢問／自動補'), '錯過列備註');
  assert.ok(g.includes('UI 字 重做／放行／修改／稍後'), '查核攔下列備註');
  assert.ok(g.includes('正面 UI 標籤 來自／用法／範圍／來源'), '記憶卡列備註');
  assert.ok(g.includes('抽屜鈕「存為片段」'), '素材庫列備註');
  assert.equal(count(g, '用在哪只能是全部、分類、流程'), 1, '記憶卡列的驗證訊息原話留著（對應 src/memory.js）');
});

// ---------- T7 文案 B 第 5 組：「分類守則」統一（UI 四處＋src 三段字串＋測試同步） ----------
// 舊字用兩截拼起來，免得本檔自己被 grep -rn 三目錄掃到（完成定義：三字串在 ui／src／tests 0 命中）
const T7_OLD = [['這類流程', '要守的'], ['這類流程', '都要守的'], ['這個分類', '要守的']].map((p) => p.join(''));
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

test('T7 ①：舊字掃描——「分類守則」三種舊寫法在 bojian/ui、bojian/src、bojian/tests 全部檔案 0 命中（＝grep -rn 三目錄為空）', () => {
  const bad = [];
  for (const dir of ['ui', 'src', 'tests']) {
    for (const f of walk(path.join(UI, '..', dir))) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((ln, i) => { for (const w of T7_OLD) if (ln.includes(w)) bad.push(`「${w}」${path.relative(path.join(UI, '..'), f)}:${i + 1}`); });
    }
  }
  assert.deepEqual(bad, [], `舊字還在：\n${bad.join('\n')}`);
});

test('T7 ②：memTagHtml 群組條 chip 印「分類守則」', () => {
  assert.equal(uiFn('memTagHtml')({ bucket: 'group' }), '<span class="chip">分類守則</span>');
});

test('T7 ③：分類頁文字框 h5 為「分類守則（一行一條）」', () => {
  const html = uiFn('categoryPageHtml', { state: { categoryPage: { category: '旅遊', data: { rules: [], text: '' }, cards: [] }, keep: {}, run: null } })();
  const h5 = /<h5>(.*?)<\/h5>/.exec(html)?.[1];
  assert.equal(h5, '分類守則（一行一條）', `分類頁第一個 h5：${h5}`);
});

test('T7 ④：流程頁兩格 chip、抽屜一列、記憶卡浮窗標題與「來源」值、側欄分類 title 都改「分類守則」', () => {
  const src = uiSrc();
  assert.ok(src.includes('關於你 ${core.length} 條・分類守則 ${rules.length} 條'), '流程頁「每步都帶」chip');
  assert.ok(src.includes('`分類守則 ${rules}`'), '抽屜「這一步會帶：」（T11 起不加「條」）');
  assert.ok(src.includes("title = '分類守則';"), '記憶卡浮窗群組卡標題');
  assert.ok(src.includes('你在分類頁「分類守則」文字框打的'), '記憶卡浮窗群組卡「來源」值');
  assert.ok(src.includes('data-cat="${esc(cat)}" title="分類守則">'), '側欄分類名滑過 title');
});

test('T7 ⑤：GLOSSARY 群組圈列中文欄加「分類守則」、卷宗與常駐段列段標題改「# 分類守則」、行數不超預算 100、舊字 0 命中', () => {
  const g = fs.readFileSync(path.join(UI, '..', '..', 'GLOSSARY.md'), 'utf8');
  assert.ok(count(g, '\n') <= 100, 'wc -l GLOSSARY.md 該 ≤100（budgets.json）');
  assert.ok(g.includes('\n| 群組圈／群組規矩／分類守則 | category scope / group rules |'), '群組圈列中文欄');
  assert.ok(g.includes('「# 關於你」「# 分類守則」兩段'), '卷宗列');
  assert.ok(g.includes('「# 分類守則（分類「X」，一定要守）」插在限制條件後'), '常駐段列（段標題與 host-adapter 同字）');
  for (const w of T7_OLD) assert.equal(count(g, w), 0, `GLOSSARY 舊字「${w}」該 0 命中`);
});

// ---------- T8 設定頁：三分頁改名、關於你層級、監工搬家、錯過時 ----------
test('T8 ①：SET_TABS 三組改名；「地圖與例外」「連接器與保險箱」「保險箱」「錯過的排程」「自動補跑」在 app.js 0 命中；儀表板「去看」跳記憶總覽', () => {
  const src = uiSrc();
  for (const w of ['地圖與例外', '連接器與保險箱', '保險箱', '錯過的排程', '自動補跑']) assert.equal(count(src, w), 0, `「${w}」該 0 命中`);
  assert.ok(src.includes("記憶: ['記憶總覽', '關於你', '連接器與金鑰']"), '記憶三分頁');
  assert.ok(src.includes("連線: ['Claude', 'Google 行事曆']"), '連線兩分頁');
  assert.ok(src.includes("素材庫: ['角色情境', '常用片段']"), '素材庫兩分頁');
  assert.ok(src.includes("openSettings('記憶', '記憶總覽')"), '儀表板「去看」');
  assert.ok(src.includes("tab === '關於你' ? setKnowHtml(d) : tab === '連接器與金鑰' ? setKeysHtml(d)"), '記憶分派');
  assert.ok(src.includes("act === 'intro-open'"), '關於你頁「介紹你自己」鈕的事件');
});

const t8DefCtx = (tab) => ({ state: { settings: { tab: {}, busy: null }, claude: true }, setTab: () => tab });
test('T8 ②：新流程的預設——監工總開關與三勾搬到「權限與查核」（數字對原始資料之後）；「AI 步驟」0 命中監工；停點句', () => {
  const perm = uiFn('setDefaultsHtml', t8DefCtx('權限與查核'))({ cfg: { defaults: {} } });
  assert.ok(perm.includes('<h5>監工</h5>') && perm.includes('data-k="supervisor_enabled"'), '監工總開關');
  assert.equal(count(perm, 'data-act="set-def-flag"'), 3, '三勾 pill');
  assert.ok(perm.indexOf('數字對原始資料') < perm.indexOf('<h5>監工</h5>'), '監工在數字對原始資料之後');
  const ai = uiFn('setDefaultsHtml', t8DefCtx('AI 步驟'))({ cfg: { defaults: {} } });
  assert.equal(count(ai, '監工'), 0, 'AI 步驟不再有監工');
  assert.ok(ai.includes('模型檔位') && ai.includes('出錯自動重試'), 'AI 步驟留模型與重試');
  const stop = uiFn('setDefaultsHtml', t8DefCtx('停點'))({ cfg: { defaults: {} } });
  assert.ok(stop.includes('在每個步驟的「停點」設定。'), '停點句');
});

test('T8 ③：關於你——頂部介紹三列各附「修改」、敏感四類改四個開關（health 開）、身分段收在 details；沒介紹過→灰字＋「介紹你自己」鈕', () => {
  const at = '2026-09-01T00:00:00.000Z';
  const card = (id, layer, text, kind) => ({ id, bucket: 'profile', status: 'active', layer, text, scope: { level: 'all' }, source: { kind }, created_at: at });
  const cards = [card('i1', 'content', '小公司負責人', 'intro'), card('i2', 'content', '給主管看', 'intro'), card('i3', 'expression', '受不了術語', 'intro'), card('p1', 'expression', '不要恭維', 'chat')];
  const ctx = { state: { settings: { idEdit: null, tab: {} }, categories: ['旅遊'] } };
  const html = uiFn('setKnowHtml', ctx)({ cfg: { memory: { sensitive: { health: true } } }, cards, identities: [] });
  const intro = html.slice(html.indexOf('data-intro'), html.indexOf('<div class="group">'));
  for (const t of ['你是誰、做什麼', '小公司負責人', '你做出來的東西通常給誰看', '給主管看', '你最受不了什麼', '受不了術語']) assert.ok(intro.includes(t), `介紹列缺「${t}」`);
  assert.equal(count(intro, '>修改</button>'), 3, '三列各一顆修改');
  assert.equal(count(intro, 'data-act="mem-card"'), 3, '修改＝開那張卡');
  assert.equal(count(html, 'data-act="set-sens"'), 4, '敏感四個開關');
  assert.ok(html.includes('data-act="set-sens" data-k="health" role="switch" aria-checked="true"'), 'health 開');
  assert.ok(html.includes('data-act="set-sens" data-k="politics" role="switch" aria-checked="false"'), 'politics 關');
  assert.equal(count(html, 'class="pill'), 0, '敏感類別不再是 pills');
  const det = html.slice(html.indexOf('<details data-fold="identity"'));
  assert.ok(det.includes('身分') && det.includes('data-act="id-add"') && det.includes('</details>'), '身分段搬進 details');
  assert.ok(html.indexOf('data-layer="content"') < html.indexOf('<details data-fold="identity"'), '身分在兩層清單之後');
  const none = uiFn('setKnowHtml', ctx)({ cfg: { memory: {} }, cards: [cards[3]], identities: [] });
  assert.ok(none.includes('data-act="intro-open"') && none.includes('還沒介紹過'), '沒介紹過');
  assert.equal(count(none, '>修改</button>'), 0);
});

test('T8 ④：執行與排程→排程：「錯過時」二鍵「先詢問／自動補」，無「自動補跑」', () => {
  const html = uiFn('setExecHtml', { state: { settings: { tab: {}, busy: null }, calendar: null }, setTab: () => '排程' })({ cfg: { exec: {} } });
  assert.ok(html.includes('錯過時') && html.includes('>先詢問<') && html.includes('>自動補<'));
  assert.equal(count(html, '自動補跑'), 0);
});

test('T8 ⑤：記憶→連接器與金鑰：兩列「尚未提供」；記憶總覽底部收摺欄位詞典（表格照舊）；素材庫沒有身分分支', () => {
  const keys = uiFn('setMemoryHtml', { state: { settings: { tab: {} } }, setTab: () => '連接器與金鑰' })({});
  assert.equal(count(keys, '尚未提供'), 2);
  assert.ok(keys.includes('連接器與金鑰') && keys.includes('雲端硬碟、信箱'));
  const fold = uiFn('setDictFoldHtml', { state: { settings: { merge: null } } })({ dict: { fields: [{ name: '語氣', kind: 'appearance', synonyms: ['口吻'], origin: 'factory' }], usage: {} }, cards: [] });
  assert.ok(fold.startsWith('<details data-fold="dict"') && fold.includes('<table class="dict"') && fold.includes('<b>語氣</b>'), '詞典摺在 details 裡、表格照舊');
  const assets = uiFn('setAssetsHtml', { state: { settings: { tab: {}, presetEdit: null }, presets: { role_context: [], snippet: [] } }, setTab: () => '角色情境' })({});
  assert.ok(assets.includes('data-presets="role_context"') && !assets.includes('data-act="id-add"'), '素材庫預設分頁＝角色情境、沒有身分');
});

// ---------- T9 側欄：四全域項、分類樹收合（文字開頁／箭頭收合）、流程庫頁 ----------
const t9Side = (extra = {}) => uiFn('sideHtml', { state: { categories: ['旅遊'], workflows: [{ id: 'a', name: 'A', category: '旅遊' }], trash: [], notices: { unread: [] }, catClosed: new Set(), categoryPage: null, wf: null, calendar: null, settings: null, library: null, dash: null, addingCategory: false, ...extra }, subjectIsDraft: () => false })();
test('T9 ①：側欄四全域項依序 儀表板／流程庫／行事曆／設定、無 h4；分類樹＝details.cat open，summary 帶 open-category、箭頭 cat-toggle；流程列不變', () => {
  const html = t9Side();
  const acts = [...html.matchAll(/class="wf calentry[^"]*" data-act="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(acts, ['open-dash', 'open-library', 'open-calendar', 'open-settings']);
  assert.equal(count(html, '<h4>'), 0, '「我的流程庫」標題拿掉');
  assert.ok(html.includes('<details class="cat" data-cat="旅遊" open>'), 'details 預設展開');
  const summary = /<summary[^>]*>[\s\S]*?<\/summary>/.exec(html)[0];
  assert.ok(summary.includes('data-act="open-category" data-cat="旅遊" title="分類守則"'), 'summary 文字＝開分類頁');
  assert.ok(summary.includes('<i class="ph ph-caret-down catcaret" data-act="cat-toggle" data-cat="旅遊"'), '箭頭＝收合');
  assert.ok(html.includes('data-act="open" data-cat="旅遊" data-id="a"'), '流程列還在');
  assert.ok(html.includes('data-act="new-flow"') && html.includes('data-act="pick-import"') && html.includes('data-act="view-trash"'), '建立／匯入／垃圾桶留在側欄');
});

test('T9 ②：catClosed 含分類→details 無 open；正在看的分類 summary aria-current="page" 且強制 open', () => {
  const closed = t9Side({ catClosed: new Set(['旅遊']) });
  assert.ok(closed.includes('<details class="cat" data-cat="旅遊" >') && !closed.includes('data-cat="旅遊" open>'), '收合');
  const now = t9Side({ catClosed: new Set(['旅遊']), categoryPage: { category: '旅遊' } });
  assert.ok(now.includes('<details class="cat" data-cat="旅遊" open>'), '看著的分類強制展開');
  assert.ok(now.includes('<summary class="nm now" aria-current="page"'), 'summary aria-current');
});

const t9Lib = (library) => uiFn('libraryHtml', { state: { categories: ['旅遊', '工作'], workflows: [{ id: 'a', name: 'A 報告', category: '旅遊' }, { id: 'b', name: 'B 週報', category: '工作' }, { id: 'c', name: 'C', category: '旅遊' }], library } })();
test('T9 ③：流程庫頁——三張卡、搜尋只剩 1、分類過濾、卡上「打開」走既有 open、空→還沒有流程', () => {
  const all = t9Lib({ q: '', cat: '' });
  assert.equal(count(all, 'class="libcard"'), 3);
  assert.ok(all.includes('id="lib-search"') && all.includes('data-act="lib-cat" data-cat=""') && all.includes('data-act="lib-cat" data-cat="旅遊"'), '搜尋框與分類鍵');
  assert.equal(count(t9Lib({ q: 'A', cat: '' }), 'class="libcard"'), 1, '搜尋');
  const cat = t9Lib({ q: '', cat: '旅遊' });
  assert.equal(count(cat, 'class="libcard"'), 2, '分類過濾');
  assert.ok(!cat.includes('B 週報'));
  assert.ok(cat.includes('data-act="open" data-cat="旅遊" data-id="a"'), '卡上「打開」');
  assert.ok(uiFn('libraryHtml', { state: { categories: [], workflows: [], library: { q: '', cat: '' } } })().includes('還沒有流程'));
  assert.ok(t9Lib({ q: 'zzz', cat: '' }).includes('沒有符合的流程'));
});

test('T9 ④：每個 closeSettings() 呼叫站都配 closeLibrary()（地雷 6）；openSettings 也關流程庫；closeLibrary 只定義一次', () => {
  const src = uiSrc().replace(/function openLibrary\(\) \{[\s\S]*?\n\}\n/, '');
  assert.equal(count(src, 'closeSettings(); closeLibrary();'), count(src, 'closeSettings();'), '每站都配');
  assert.ok(count(src, 'closeSettings();') >= 12, `呼叫站 ${count(src, 'closeSettings();')}`);
  const os = /async function openSettings\([\s\S]*?\n\}\n/.exec(uiSrc())[0];
  assert.ok(os.includes('closeLibrary();'), 'openSettings 關流程庫');
  assert.equal(count(uiSrc(), 'function closeLibrary()'), 1);
});

test('T9 ⑤：「我的流程庫」在 app.js 0 命中；CSS 有 details 去標記與箭頭旋轉、libgrid／libcard', () => {
  assert.equal(count(uiSrc(), '我的流程庫'), 0);
  const css = cssSrc();
  for (const r of ['.side details.cat>summary.nm{list-style:none}', '.cat:not([open]) .catcaret{transform:rotate(-90deg)}', '.libgrid{', '.libcard{']) assert.ok(css.includes(r), r);
});

test('T9 ⑥：render 的 state.library 判在 state.settings 之後、state.categoryPage 之前；搜尋 input 只換 #lib-grid；事件 open-library／cat-toggle／lib-cat 都在', () => {
  const src = uiSrc();
  const a = src.indexOf('else if (state.settings) inner = settingsHtml()'), b = src.indexOf('else if (state.library) inner = libraryHtml()'), c = src.indexOf('else if (state.categoryPage) inner = categoryPageHtml()');
  assert.ok(a > 0 && a < b && b < c, `順序 ${a} ${b} ${c}`);
  assert.ok(src.includes("t.id === 'lib-search'") && src.includes("getElementById('lib-grid')"), '搜尋只換卡片格');
  for (const w of ["act === 'open-library'", "act === 'cat-toggle'", "act === 'lib-cat'"]) assert.ok(src.includes(w), w);
  const oc = /else if \(act === 'open-category'\) \{[\s\S]*?render\(\);/.exec(src)[0];
  assert.ok(oc.includes('e.preventDefault()'), '點文字不觸發 details 原生切換');
});

// ---------- T10 流程頁：設計流程｜本次資料、流程設定浮窗、記憶一行 ----------
const t10Def = { name: 'X', permissions: {}, check: {}, supervisor: {}, params: [{ key: 'k1', label: '欄一', default: 'v1' }], nodes: [{ id: 'n1', title: '步一', executor: 'ai', instruction: 'i' }] };
const t10Ctx = (extra = {}, helpers = {}) => ({
  state: { wf: { category: 'a', id: 'x', def: t10Def, runs: [] }, versions: [], categories: ['a'], flowTab: 'design', flowSettingsOpen: false, flowMemOpen: false, permFlashUntil: 0, permErr: null, mode: 'list', paramNow: {}, identities: [{ id: 'id1', name: '我' }], memIdentity: '', wfMemory: null, startCheck: null, claude: true, memMore: {}, memPicks: {}, addingParam: false, expanded: new Set(), run: null, drawerOpen: false, ...extra },
  subjectIsDraft: () => false, subjectDef: () => t10Def, ...helpers,
});
test('T10 ①：workHeadHtml——右上「流程設定」鈕、seg 兩鍵「設計流程」「本次資料」、不再直印三開關；本次資料分頁不印四模式 seg；草稿沒有這些', () => {
  const h = uiFn('workHeadHtml', t10Ctx())();
  assert.ok(h.includes('data-act="flow-settings"'), '流程設定鈕');
  assert.ok(h.includes('data-act="flow-tab" data-tab="design"') && h.includes('>設計流程</span>') && h.includes('data-act="flow-tab" data-tab="data"') && h.includes('>本次資料</span>'), '兩分頁');
  for (const id of ['id="perm-files"', 'id="check-delivery"', 'id="supervisor-row"']) assert.ok(!h.includes(id), `標題列不該直印 ${id}`);
  assert.ok(h.includes('data-act="mode-chat"'), '設計流程下有四模式 seg');
  const d = uiFn('workHeadHtml', t10Ctx({ flowTab: 'data' }))();
  assert.ok(!d.includes('data-act="mode-chat"') && d.includes('class="on" data-act="flow-tab" data-tab="data"'), '本次資料分頁：seg 收起、本次資料 on');
  const draft = uiFn('workHeadHtml', t10Ctx({}, { subjectIsDraft: () => true }))();
  assert.ok(!draft.includes('data-act="flow-settings"') && !draft.includes('data-flowtabs'), '草稿沒有流程設定鈕與分頁');
});

test('T10 ②：flowSettingsModalHtml——開著時三開關列（id 與 data-act 原名）都在浮窗裡、有關閉鈕；關著回空字串；草稿回空', () => {
  const m = uiFn('flowSettingsModalHtml', t10Ctx({ flowSettingsOpen: true }))();
  for (const s of ['id="perm-files"', 'id="check-delivery"', 'id="supervisor-row"', 'data-act="perm-files-toggle"', 'data-act="check-toggle"', 'data-act="facts-toggle"', 'data-act="supervisor-toggle"', 'data-act="flow-settings-close"', 'class="pvback memmodal flowsettings"']) assert.ok(m.includes(s), s);
  assert.equal(uiFn('flowSettingsModalHtml', t10Ctx({ flowSettingsOpen: false }))(), '');
  assert.equal(uiFn('flowSettingsModalHtml', t10Ctx({ flowSettingsOpen: true }, { subjectIsDraft: () => true }))(), '');
});

const t10Stubs = { resumeHtml: () => '<div data-resume></div>', proposalsHtml: () => '', stepListHtml: () => '<div class="step" data-step></div>', startCheckHtml: () => '', habitChipsHtml: () => '', preflightFor: () => null, flowMemLineHtml: () => '<div data-flowmemline></div>' };
test('T10 ③：本次資料分頁＝身分＋欄位值＋開始、不含步驟清單；設計流程的清單模式不再有開跑表單、留欄位定義與記憶一行', () => {
  const data = uiFn('dataTabHtml', t10Ctx({}, t10Stubs))();
  assert.ok(data.includes('<h5>本次資料</h5>') && data.includes('data-act="start"') && data.includes('id="mem-identity"') && data.includes('data-param="k1"'), '開跑表單四件');
  assert.ok(!data.includes('class="step') && !data.includes('欄位 · 會存進流程'), '不含步驟清單與欄位定義');
  const list = uiFn('listModeHtml', t10Ctx({}, t10Stubs))();
  assert.ok(!list.includes('data-act="start"') && !list.includes('<h5>本次資料</h5>') && !list.includes('data-param="k1"'), '清單模式不再有開跑表單');
  assert.ok(list.includes('欄位 · 會存進流程') && list.includes('data-req="k1"') && list.includes('data-flowmemline') && list.includes('data-step'), '欄位定義、記憶一行、步驟清單留著');
  assert.equal(uiFn('dataTabHtml', t10Ctx({}, { ...t10Stubs, subjectIsDraft: () => true }))(), '', '草稿沒有本次資料');
});

test('T10 ④：flowMemLineHtml——「關於你 1・分類守則 2」「開跑選項 1 張」「查看」；全空→空字串；paused→整層暫停中', () => {
  const line = uiFn('flowMemLineHtml', t10Ctx({ wfMemory: { core: { expression: [1], content: [] }, group: { rules: [1, 1] }, habits: { own: [1], inherited: [], probes: [] }, paused: false } }))();
  assert.ok(line.includes('關於你 1・分類守則 2') && line.includes('開跑選項 1 張') && line.includes('>查看</span>') && line.includes('data-act="flowmem-open"'), line);
  assert.ok(!line.includes('整層暫停中'));
  assert.equal(uiFn('flowMemLineHtml', t10Ctx({ wfMemory: { core: { expression: [], content: [] }, group: { rules: [] }, habits: { own: [], inherited: [], probes: [] }, paused: false } }))(), '');
  assert.ok(uiFn('flowMemLineHtml', t10Ctx({ wfMemory: { core: {}, group: {}, habits: {}, paused: true } }))().includes('整層暫停中'));
  assert.equal(uiFn('flowMemLineHtml', t10Ctx({ wfMemory: null }))(), '');
});

test('T10 ⑤：flowMemModalHtml 開著＝原兩格（data-flowmem）＋關閉鈕；關著空', () => {
  const wfMemory = { core: { expression: [{ id: 'c1', text: '不要恭維', layer: 'expression' }], content: [] }, group: { rules: [] }, habits: { own: [], inherited: [], probes: [] }, options: {}, paused: false };
  const m = uiFn('flowMemModalHtml', t10Ctx({ flowMemOpen: true, wfMemory }, { wfNameOf: () => '' }))();
  assert.ok(m.includes('data-flowmem') && m.includes('不要恭維') && m.includes('data-act="flowmem-close"') && m.includes('class="pvback memmodal flowmemmodal"'), m.slice(0, 200));
  assert.equal(uiFn('flowMemModalHtml', t10Ctx({ flowMemOpen: false, wfMemory }))(), '');
});

test('T10 ⑥：接線——drawerHtml 只在設計流程；「修這裡」先開浮窗；render 本次資料蓋過四模式、兩浮窗掛 .layout 外；openWorkflow 重設；Esc 關；事件五個', () => {
  const src = uiSrc();
  const dr = /function drawerHtml\(\) \{\n([^\n]*)/.exec(src)[1];
  assert.ok(dr.includes("state.flowTab === 'design'"), '抽屜條件');
  const fix = /el\.dataset\.kind === 'flow'\) \{[\s\S]*?render\(\);/.exec(src)[0];
  assert.ok(fix.includes('flowSettingsOpen = true'), '修這裡先開浮窗');
  assert.ok(src.includes("state.flowTab === 'data' ? dataTabHtml()"), 'render 分派');
  assert.ok(src.includes('memCardModalHtml() + flowSettingsModalHtml() + flowMemModalHtml()'), '兩浮窗掛 .layout 外');
  const ow = /async function openWorkflow\([\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(ow.includes("state.flowTab = 'design'") && ow.includes('state.flowSettingsOpen = false') && ow.includes('state.flowMemOpen = false'), '換流程重設');
  assert.ok(src.includes("e.key === 'Escape' && state.flowMemOpen") && src.includes("e.key === 'Escape' && state.flowSettingsOpen"), 'Esc');
  for (const a of ['flow-tab', 'flow-settings', 'flow-settings-close', 'flowmem-open', 'flowmem-close']) assert.ok(src.includes(`act === '${a}'`), a);
  assert.equal(count(src, 'id="perm-files"'), 1, 'perm-files id 只在 permRowHtml 一處（地雷 7）');
  assert.ok(src.includes('function paramRowsHtml(def)'), '值列搬成函式');
});

// ---------- T11 抽屜：先兩格、其餘收摺；子頁保留 ----------
const t11Ctx = (extra = {}) => ({ state: { drawerTab: 'content', cvMore: null, presets: {}, wfFiles: [], wfMemory: null, ...extra }, kindOf: () => 'task', refFilesSectionHtml: () => '<div id="ref-section"></div>', supChecksHtml: () => '', templateSectionHtml: () => '', drawerInputsHtml: () => '', drawerMemoryHtml: () => '' });
const t11Node = (extra = {}) => ({ id: 'n1', title: 't', executor: 'ai', instruction: 'i', ...extra });
test('T11 ①：任務內容頁——任務與驗收重點在 <details> 之前；角色／背景／限制／範例／參考檔在 <details class="cvmore"> 內；九個欄位 id 全在（套用不丟欄）', () => {
  const html = uiFn('canvasEditorHtml', t11Ctx())(t11Node(), {});
  const d0 = html.indexOf('<details class="cvmore"'), d1 = html.indexOf('</details>');
  assert.ok(d0 > 0 && d1 > d0, 'details 存在');
  for (const id of ['id="cv-instruction"', 'id="cv-review"']) assert.ok(html.indexOf(id) < d0, `${id} 該在 details 之前`);
  for (const id of ['id="cv-role"', 'id="cv-bg"', 'id="cv-constraints"', 'id="cv-examples"', 'id="ref-section"']) { const i = html.indexOf(id); assert.ok(i > d0 && i < d1, `${id} 該在 details 內`); }
  for (const id of ['cv-title', 'cv-executor', 'cv-stop', 'cv-instruction', 'cv-review', 'cv-role', 'cv-bg', 'cv-constraints', 'cv-examples']) assert.equal(count(html, `id="${id}"`), 1, id);
  assert.ok(html.includes('id="cv-page-spec"') && html.includes('data-act="cv-tab" data-tab="spec"'), '產出規格子頁還在');
  assert.ok(html.includes('<summary data-act="cv-more">') && html.includes('背景、限制與參考資料'), 'summary');
});

test('T11 ②：有值（background）→ details open＋「1 項有內容」；五欄全空→無 open；使用者收過（cvMore=false）→即使有值也不 open', () => {
  const withBg = uiFn('canvasEditorHtml', t11Ctx())(t11Node({ background: 'x' }), {});
  assert.ok(withBg.includes('<details class="cvmore" id="cv-more" open>') && withBg.includes('1 項有內容'), '有值展開');
  const empty = uiFn('canvasEditorHtml', t11Ctx())(t11Node(), {});
  assert.ok(empty.includes('<details class="cvmore" id="cv-more" >') && !empty.includes('項有內容'), '全空收起');
  const closed = uiFn('canvasEditorHtml', t11Ctx({ cvMore: false }))(t11Node({ background: 'x', constraints: 'y' }), {});
  assert.ok(closed.includes('<details class="cvmore" id="cv-more" >') && closed.includes('2 項有內容'), '使用者收過就照他的');
  const forced = uiFn('canvasEditorHtml', t11Ctx({ cvMore: true }))(t11Node(), {});
  assert.ok(forced.includes('id="cv-more" open>'), '使用者開過就照他的');
});

test('T11 ③：人做步驟沒有 <details>（只有任務＋驗收重點）', () => {
  const html = uiFn('canvasEditorHtml', t11Ctx())(t11Node({ executor: 'human' }), {});
  assert.ok(!html.includes('<details') && html.includes('id="cv-instruction"') && html.includes('id="cv-review"'));
});

test('T11 ④：「這一步會帶的記憶」0 命中、改「這一步會帶：」且不加「條」；cv-more 事件不 render、換節點重設 cvMore；CSS 有 .cvmore 兩欄與旋轉', () => {
  const src = uiSrc();
  assert.equal(count(src, '這一步會帶的記憶'), 0);
  assert.ok(src.includes('這一步會帶：') && src.includes('`關於你 ${core}`, `分類守則 ${rules}`'), '一行分開數');
  const h = /else if \(act === 'cv-more'\) \{[^\n]*/.exec(src)[0];
  assert.ok(h.includes('e.preventDefault()') && h.includes('state.cvMore = d.open') && !h.includes('render()'), '收摺不重繪');
  assert.ok(src.includes("state.drawerTabFor = n.id; state.cvMore = null;"), '換節點回自動');
  const css = cssSrc();
  for (const r of ['.cvmore{grid-column:1/-1', '.cvmore:not([open])>summary i{transform:rotate(-90deg)}', '.cvmore .cvgrid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)', '.cvmore .cvgrid2>.cvcol{overflow:auto}']) assert.ok(css.includes(r), r);
});

// ---------- U2a 移植合併輪：側欄公司節點、麵包屑、公司名稱載入 ----------
const u2aSide = (extra = {}) => t9Side({ companyName: '範例公司', ...extra });
test('U2a ①：側欄公司節點在「建立新流程」之後、第一個 details.cat 之前，class="wf companynode" data-act="open-company"；calentry 仍四個；分類樹包 .tree；名稱空→「公司」；看著公司頁→now', () => {
  const html = u2aSide();
  const node = 'class="wf companynode" data-act="open-company"';
  assert.ok(html.includes(node), '公司節點');
  const i = html.indexOf(node);
  assert.ok(html.indexOf('data-act="new-flow"') < i && i < html.indexOf('<details class="cat"'), '位置：newflow 之後、分類樹之前');
  assert.ok(/class="wf companynode" data-act="open-company"[^>]*>[\s\S]*?<i class="ph ph-buildings"><\/i><span class="wfname">範例公司<\/span>/.test(html), '圖標 buildings＋公司名');
  const acts = [...html.matchAll(/class="wf calentry[^"]*" data-act="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(acts, ['open-dash', 'open-library', 'open-calendar', 'open-settings'], '四全域項不變（公司節點不是第五個）');
  assert.ok(html.includes('<div class="tree">') && html.indexOf('<div class="tree">') < html.indexOf('<details class="cat"'), '分類樹包 .tree');
  assert.ok(u2aSide({ companyName: '' }).includes('<span class="wfname">公司</span>'), '空字串→「公司」');
  assert.ok(u2aSide({ companyName: '  ' }).includes('<span class="wfname">公司</span>'), '空白→「公司」');
  const now = u2aSide({ categoryPage: { category: '_company' } });
  assert.ok(now.includes('class="wf companynode now" aria-current="page" data-act="open-company"'), '看著公司頁時 now');
  assert.ok(!now.includes('summary class="nm now"'), '_company 不會把任何分類標成 now');
});

test('U2a ②：crumbsHtml 依序 公司›分類›流程名，前兩節 data-act、末節 aria-current；extra 多一節；草稿與「開始一件事」只印 公司›草稿', () => {
  const ctx = { state: { wf: { category: '旅遊', def: { name: 'A' } }, companyName: '' } };
  const html = uiFn('crumbsHtml', ctx)();
  assert.ok(html.startsWith('<nav class="crumbs"'), 'nav.crumbs');
  const parts = [...html.matchAll(/<span([^>]*)>([^<]*)<\/span>/g)].map((m) => [m[1].trim(), m[2]]);
  assert.deepEqual(parts.map((p) => p[1]), ['公司', '旅遊', 'A'], '三節依序');
  assert.ok(parts[0][0].includes('data-act="open-company"'), '第一節 open-company');
  assert.ok(parts[1][0].includes('data-act="open-category" data-cat="旅遊"'), '第二節 open-category');
  assert.ok(parts[2][0].includes('aria-current="page"') && !parts[2][0].includes('data-act'), '末節 aria-current 且不可點');
  assert.equal(count(html, 'ph-caret-right'), 2, '兩個分隔符');
  const run = uiFn('crumbsHtml', ctx)('這次的執行');
  const rparts = [...run.matchAll(/<span([^>]*)>([^<]*)<\/span>/g)].map((m) => [m[1].trim(), m[2]]);
  assert.deepEqual(rparts.map((p) => p[1]), ['公司', '旅遊', 'A', '這次的執行']);
  assert.ok(rparts[3][0].includes('aria-current="page"') && !rparts[2][0].includes('aria-current'), 'extra 成末節；流程名那節不再 current');
  assert.ok(uiFn('crumbsHtml', { state: { wf: { category: '旅遊', def: { name: 'A' } }, companyName: '範例公司' } })().includes('>範例公司</span>'), '公司名跟設定');
  const draft = uiFn('crumbsHtml', { state: { wf: null, chat: { draft: { name: '' } }, companyName: '' } })();
  assert.deepEqual([...draft.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]), ['公司', '草稿'], '草稿');
  assert.deepEqual([...uiFn('crumbsHtml', { state: { wf: null, chat: { draft: null }, companyName: '' } })().matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]), ['公司', '草稿'], '「開始一件事」還沒拆出草稿也算草稿');
});

test('U2a ③：open-company 分支含字面 closeSettings(); closeLibrary(); 且 categoryPage = { category: \'_company\'；loadCategoryPage 對 _company 不抓群組；boot 讀 /api/settings 的 company_name；workHeadHtml／runHtml 前置麵包屑；CSS 三段', () => {
  const src = uiSrc();
  const br = /else if \(act === 'open-company'\) \{[\s\S]*?\n    \}/.exec(src);
  assert.ok(br, 'open-company 分支存在');
  assert.ok(br[0].includes('closeSettings(); closeLibrary();'), '關頁站字面（地雷 6）');
  assert.ok(br[0].includes("categoryPage = { category: '_company'"), '走分類頁特例');
  assert.equal(count(src, 'function closeLibrary()'), 1);
  const lcp = /async function loadCategoryPage\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(/_company/.test(lcp) && lcp.indexOf('_company') < lcp.indexOf('/api/memory/groups/'), 'loadCategoryPage 先判 _company 再抓群組');
  assert.ok(/function refreshCompanyName\(\)[\s\S]*?\/api\/settings[\s\S]*?company_name/.test(src), 'refreshCompanyName 讀 /api/settings 的 company_name');
  const init = /\(async function init\(\) \{[\s\S]*?\}\)\(\);/.exec(src)[0];
  assert.ok(init.includes('refreshCompanyName()'), 'boot 時讀公司名');
  assert.ok(src.includes('companyName: \'\''), 'state.companyName 初值空字串');
  const wh = /function workHeadHtml\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(wh.includes('return `${crumbsHtml()}<div class="tophead">'), 'workHeadHtml 麵包屑在 tophead 之上');
  const rh = /function runHtml\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(rh.includes("return `${crumbsHtml('這次的執行')}<div class=\"tophead\">"), 'runHtml 麵包屑多一節');
  const css = cssSrc();
  for (const r of ['.companynode{', '.side .tree{', '.crumbs{', '.crumbs [data-act]:hover{', '.crumbs [aria-current]{']) assert.ok(css.includes(r), r);
});

test('U2a ④：categoryPageHtml 對 _company 標題印公司名＋「改名在 設定→資料」、chip「公司」、不含分類守則也不印讀取中；一般分類 data:null 仍讀取中', () => {
  // U2b 起公司頁也有共用檔要抓：shared 給空清單＝已讀完，才不印「讀取中」
  const cp = (category, extra = {}) => uiFn('categoryPageHtml', { state: { categoryPage: { category, data: null, cards: [], err: null, saving: false, saveErr: null, shared: { rules: [], refs: [], rule_chars: 0 } }, workflows: [], companyName: '範例公司', ...extra } })();
  const co = cp('_company');
  assert.ok(co.includes('<h3>範例公司</h3>'), '標題＝公司名');
  assert.ok(co.includes('改名在 設定→資料'), '灰字');
  assert.ok(co.includes('<i class="ph ph-buildings"></i>公司</span>'), 'chip 公司');
  assert.ok(!co.includes('分類守則') && !co.includes('讀取中') && !co.includes('data-act="save-group"'), '沒有分類守則框');
  assert.ok(co.includes('data-act="close-category"'), '回工作區');
  assert.ok(cp('_company', { companyName: '' }).includes('<h3>公司</h3>'), '空名→公司');
  const dept = cp('旅遊');
  assert.ok(dept.includes('<h3>旅遊</h3>') && dept.includes('讀取中'), '一般分類照舊');
  const wh = uiFn('workHeadHtml', { state: { wf: { category: '旅遊', id: 'a', def: { name: 'A' } }, chat: { draft: null }, versions: [], categories: ['旅遊'], flowTab: 'design', mode: 'chat', companyName: '範例公司' } })();
  assert.ok(wh.startsWith('<nav class="crumbs"') && wh.includes('>範例公司</span>') && wh.includes('<h3>A</h3>'), '流程頁標題上方有麵包屑');
});

// ---------- U2b 移植合併輪：公司頁／部門頁——規範區、參考區、上傳、刪除、流程卡 ----------
const realFmtInt = (n) => Number(n ?? 0).toLocaleString('en-US');
const u2bPage = (category, cpExtra = {}, stateExtra = {}) => uiFn('categoryPageHtml', {
  fmtInt: realFmtInt,
  state: {
    categoryPage: { category, data: { rules: [], text: '' }, cards: [], err: null, saving: false, saveErr: null, shared: { rules: [], refs: [], rule_chars: 0, limits: { per_file: 4000, per_layer: 8000 } }, uploadErr: null, msg: null, ...cpExtra },
    workflows: [{ id: 'a', name: 'A 訂餐廳', category: '旅遊' }, { id: 'b', name: 'B 週報', category: '行銷' }, { id: 'c', name: 'C 找店', category: '旅遊' }],
    keep: {}, run: null, companyName: '範例公司', ...stateExtra,
  },
})();
const u2bShared = (over = {}) => ({ rules: [{ name: 'a.md', chars: 1200, bytes: 3600, uploaded_at: '2026-09-15T08:00:00.000Z' }], refs: [], rule_chars: 1200, limits: { per_file: 4000, per_layer: 8000 }, ...over });

test('U2b ①：部門頁依序 分類守則框→規範（每步都帶）→參考（勾了才帶）→流程 N；規範區「本層已 1,200／8,000 字」、一列 a.md・1,200 字・時間・shared-del；兩顆 shared-upload（rule／ref）；流程卡只列該分類、走既有 open', () => {
  const html = u2bPage('旅遊', { shared: u2bShared() });
  const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, `該有：${s}`); return i; };
  assert.ok(at('分類守則（一行一條）') < at('規範（每步都帶）') && at('規範（每步都帶）') < at('參考（勾了才帶）') && at('參考（勾了才帶）') < at('流程 2'), '四段順序');
  assert.ok(html.includes('data-act="save-group"') && html.includes('id="group-text"'), '分類守則框原樣留著');
  assert.ok(html.includes('本層已 1,200／8,000 字'), '規範區標題旁常駐本層字數');
  const row = /<div class="sharedrow"[^]*?<\/div>/.exec(html)?.[0];
  assert.ok(row && row.includes('a.md') && row.includes('1,200 字') && row.includes('2026') && row.includes('data-act="shared-del" data-kind="rule" data-name="a.md"'), `一列 檔名・字數・時間・刪除：${row}`);
  assert.equal(count(html, 'class="sharedrow"'), 1, '只有一列');
  assert.ok(html.includes('data-act="shared-upload" data-kind="rule"') && html.includes('data-act="shared-upload" data-kind="ref"'), '兩顆上傳');
  assert.equal(count(html, 'data-act="shared-upload"'), 2);
  assert.equal(count(html, 'class="libcard"'), 2, '流程卡＝該分類兩張');
  assert.ok(html.includes('data-act="open" data-cat="旅遊" data-id="a"') && html.includes('data-act="open" data-cat="旅遊" data-id="c"') && !html.includes('B 週報'), '卡上「打開」走既有 open、別的分類不列');
  assert.ok(!html.includes('data-company-page'), '部門頁不是公司頁');
});

test('U2b ②：公司頁——無分類守則框、無流程區、含「改名在 設定→資料」與 data-company-page；兩區都在；chip 公司', () => {
  const html = u2bPage('_company', { data: null, shared: u2bShared() });
  assert.ok(!html.includes('分類守則') && !html.includes('data-act="save-group"') && !html.includes('id="group-text"'), '無分類守則框');
  assert.ok(!/流程 \d/.test(html) && !html.includes('class="libcard"'), '無流程區');
  assert.ok(html.includes('改名在 設定→資料') && html.includes('data-company-page') && html.includes('<h3>範例公司</h3>'), '公司頁標題與灰字');
  assert.ok(html.includes('規範（每步都帶）') && html.includes('參考（勾了才帶）') && html.includes('本層已 1,200／8,000 字'), '兩區');
  assert.equal(count(html, 'data-act="shared-upload"'), 2);
  assert.ok(html.includes('data-act="shared-del" data-kind="rule" data-name="a.md"'));
});

test('U2b ③：空區兩句空態各一次；參考類 chars 為 null 的二進位印 KB 不印字數、md 參考印字數；shared 還沒讀到→兩區印「讀取中」', () => {
  const empty = u2bPage('_company', { data: null });
  assert.equal(count(empty, '還沒有規範。放進來的內容，AI 每一步都照著。'), 1);
  assert.equal(count(empty, '還沒有參考。步驟裡勾了才給 AI。'), 1);
  assert.equal(count(empty, 'class="sharedrow"'), 0);
  assert.ok(empty.includes('本層已 0／8,000 字'), '空層也常駐字數');
  const refs = u2bPage('_company', { data: null, shared: u2bShared({ rules: [], rule_chars: 0, refs: [{ name: '範本.docx', chars: null, bytes: 15360, uploaded_at: '2026-09-15T08:00:00.000Z' }, { name: '說明.md', chars: 5, bytes: 15, uploaded_at: '2026-09-15T08:00:00.000Z' }] }) });
  const rows = [...refs.matchAll(/<div class="sharedrow"[^]*?<\/div>/g)].map((m) => m[0]);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes('範本.docx') && rows[0].includes('15 KB') && !rows[0].includes(' 字') && rows[0].includes('data-act="shared-del" data-kind="ref" data-name="範本.docx"'), `二進位參考印 KB：${rows[0]}`);
  assert.ok(rows[1].includes('說明.md') && rows[1].includes('5 字') && !rows[1].includes('KB'), `文字參考印字數：${rows[1]}`);
  const loading = u2bPage('_company', { data: null, shared: null });
  assert.equal(count(loading, '讀取中'), 2, '兩區各印一次讀取中');
  assert.ok(!loading.includes('還沒有規範'), '讀取中不印空態');
  const deptLoading = u2bPage('旅遊', { shared: null });
  assert.ok(deptLoading.includes('分類守則（一行一條）') && count(deptLoading, '讀取中') === 2, '部門頁守則框照印、兩區讀取中');
});

test('U2b ④：cp.uploadErr 有值→該區標題下紅字一句；cp.msg→該區一句；沒值→都不印', () => {
  const err = u2bPage('_company', { data: null, uploadErr: { kind: 'rule', text: '太長，請精簡或改放參考' } });
  assert.equal(count(err, '太長，請精簡或改放參考'), 1);
  assert.ok(/<p class="note err"[^>]*>太長，請精簡或改放參考<\/p>/.test(err), '紅字 .note.err');
  assert.ok(err.indexOf('規範（每步都帶）') < err.indexOf('太長，請精簡或改放參考') && err.indexOf('太長，請精簡或改放參考') < err.indexOf('參考（勾了才帶）'), '印在規範區內');
  const refErr = u2bPage('_company', { data: null, uploadErr: { kind: 'ref', text: '已有同名檔，先刪再傳' } });
  assert.ok(refErr.indexOf('參考（勾了才帶）') < refErr.indexOf('已有同名檔，先刪再傳'), '參考區的錯印在參考區');
  const msg = u2bPage('_company', { data: null, msg: { kind: 'ref', text: '已刪除，並從 2 個步驟取消勾選' } });
  assert.equal(count(msg, '已刪除，並從 2 個步驟取消勾選'), 1);
  assert.ok(msg.indexOf('參考（勾了才帶）') < msg.indexOf('已刪除，並從 2 個步驟取消勾選'), '一句在參考區');
  const none = u2bPage('_company', { data: null });
  assert.ok(!none.includes('class="note err"') && !none.includes('已刪除'), '沒值不印');
});

test('U2b ⑤：#shared-file change 只放行 md／txt／docx 給 rule（前端先擋）、POST content_b64 到 /api/shared；shared-upload 存 state.sharedUpload 後 click；shared-del confirm→DELETE→cp.msg；closeCategory 清 sharedUpload；loadCategoryPage 兩支都抓 /api/shared；libraryCardsHtml 走 flowCardsHtml；index.html 有 id="shared-file"；CSS', () => {
  const src = uiSrc();
  const ch = /getElementById\('shared-file'\)\.addEventListener\('change', async \(e\) => \{[\s\S]*?\n\}\);/.exec(src)?.[0];
  assert.ok(ch, 'shared-file change 處理存在');
  assert.ok(/md\|txt\|docx/.test(ch) && ch.includes("'rule'"), '規範只放行 md／txt／docx');
  assert.ok(ch.includes('content_b64') && ch.includes("'POST'") && ch.includes('sharedPath(up.scope)') && ch.includes('state.sharedUpload'), 'base64 POST 到共用檔 API');
  assert.ok(ch.includes('uploadErr'), '失敗一句');
  const up = /else if \(act === 'shared-upload'\) \{[\s\S]*?\n    \}/.exec(src)?.[0];
  assert.ok(up && up.includes('state.sharedUpload = {') && up.includes("getElementById('shared-file')") && up.includes('input.click()') && up.includes("'.md,.txt,.docx'"), 'shared-upload：存層與區→規範區 accept 只列三種→開檔案選擇');
  const del = /else if \(act === 'shared-del'\) \{[\s\S]*?\n    \}/.exec(src)?.[0];
  assert.ok(del && del.includes('window.confirm(') && del.includes("'DELETE'") && del.includes('unlinked_steps') && del.includes('cp.msg = ') && del.includes('不進垃圾桶'), 'shared-del：confirm 講清楚不進垃圾桶→DELETE→一句');
  const cc = /function closeCategory\(\) \{[\s\S]*?\n\}/.exec(src)[0];
  assert.ok(cc.includes('sharedUpload'), 'closeCategory 清 sharedUpload');
  const lcp = /async function loadCategoryPage\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(count(lcp, 'sharedPath(') >= 1, '公司頁與部門頁都抓共用檔清單');
  assert.equal(count(src, 'const sharedPath = (scope) => `/api/shared/'), 1, '共用檔 API 路徑只定義一次');
  const lib = /function libraryCardsHtml\(\) \{[\s\S]*?\n\}/.exec(src)[0];
  assert.ok(lib.includes('return flowCardsHtml(list)'), '流程庫卡片抽成 flowCardsHtml 共用');
  assert.equal(count(src, 'function flowCardsHtml('), 1);
  assert.ok(src.includes("sharedUpload: null"), 'state.sharedUpload 初值');
  const index = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  assert.ok(index.includes('<input type="file" id="shared-file" hidden>'), 'index.html 加共用檔 input（不借 #ref-file）');
  assert.ok(index.includes('id="ref-file"'), '既有 #ref-file 不動');
  const css = cssSrc();
  for (const r of ['.sharedsec h5{', '.sharedrow{', '.sharedsec .note.err{', '.catpage .sharedflows{']) assert.ok(css.includes(r), r);
});

// ---------- U0 移植合併輪：SPEC／GLOSSARY 對齊實作計畫（文件 task，計畫的驗證指令變斷言；☑ 留 U7） ----------
test('U0→U7：SPEC／GLOSSARY 對齊移植合併輪——run.shared 各 1、行數 198／93、⬜ 各 0（U7 收工 ☑）、sharedRulesSection 取代舊字、v0.22〜v0.25 全文在 SPEC-archive', () => {
  const root = path.join(UI, '..', '..');
  const spec = fs.readFileSync(path.join(root, 'SPEC.md'), 'utf8');
  const g = fs.readFileSync(path.join(root, 'GLOSSARY.md'), 'utf8');
  const arc = fs.readFileSync(path.join(root, 'SPEC-archive.md'), 'utf8');
  assert.equal(count(spec, 'run.shared'), 1, 'grep -c run.shared SPEC.md 該是 1');
  assert.equal(count(g, 'run.shared'), 1, 'grep -c run.shared GLOSSARY.md 該是 1');
  assert.ok(count(spec, '\n') <= 200, 'wc -l SPEC.md 該 ≤200（budgets.json；活文件不寫死精確行數）');
  assert.ok(count(g, '\n') <= 100, 'wc -l GLOSSARY.md 該 ≤100（budgets.json）');
  assert.equal(count(spec, '⬜'), 0, 'SPEC ⬜ 該 0（U7 總覽列 ✅）');
  assert.equal(count(g, '⬜'), 0, 'GLOSSARY ⬜ 該 0（U7 已實作 v0.27）');
  assert.equal(count(spec, '第二批，未做') + count(spec, '移植第二批'), 0, 'SPEC 舊字 0 命中');
  assert.equal(count(g, 'companyRulesSection'), 0, '舊字 companyRulesSection 該 0 命中');
  assert.equal(count(g, 'sharedRulesSection'), 1, '契約 A 函式名 sharedRulesSection 該 1 命中');
  assert.ok(spec.includes('計畫 規劃/2026-09-15-移植合併輪-實作計畫.md 文末「實作後差異」為準'), '總覽列尾');
  assert.ok(/\n- v0\.27 2026-09-16 移植合併輪/.test(spec) && spec.startsWith('# SPEC — 剝繭\n\n> ') && spec.includes('\nv0.27｜變更紀錄'), 'v0.27 一行＋版本頭');
  assert.ok(arc.includes('## 變更紀錄 v0.25（2026-09-16 自 SPEC 歸檔）') && arc.includes('- v0.25 2026-09-09 記憶輪 1＋設定頁＋群組圈（') && arc.includes('09-09 下午答五題'), 'v0.25 全文在 SPEC-archive');
  assert.ok(/\n- v0\.25 2026-09-09 [^\n]*全文見 SPEC-archive\.md/.test(spec), 'SPEC 留 v0.25 短樁');
  assert.ok(spec.includes('GET /api/workflows/:cat/:id/runs?detail=1'), 'US-076 API 名寫實');
  assert.ok(spec.includes("categoryPage.category==='_company'"), 'US-075 公司頁＝分類頁特例');
  assert.ok(spec.includes('執行頁右欄『這步會用到的資料』一行'), 'US-074');
  // budget_gate 歸檔：v0.22〜v0.24 全文搬到 SPEC-archive、SPEC 留短樁（證明沒丟）
  assert.ok(arc.includes('## 變更紀錄 v0.22〜v0.24（2026-09-16 自 SPEC 歸檔）'), '歸檔節標題');
  for (const [a, b] of [['- v0.24 2026-09-09 監工輪（', '09-09 答範圍表「過」、預算題「照原範圍做完」）：每趟多一個**監工**'], ['- v0.23 2026-09-08 交貨查核輪（', '09-08 答範圍表「1 過」＋長欄位不代進句子'], ['- v0.22 2026-09-03 產檔輪第一批（', '三題照建議＋範圍表「OK」）：流程權限 `permissions.files`']]) assert.ok(arc.includes(a) && arc.includes(b), `SPEC-archive 該含原文：${a.slice(0, 20)}`);
  for (const v of ['v0.22', 'v0.23', 'v0.24']) assert.ok(new RegExp(`\\n- ${v.replace('.', '\\.')} 2026-09-0\\d [^\\n]*全文見 SPEC-archive\\.md`).test(spec), `SPEC 留 ${v} 短樁`);
});

// U2b 覆核該修：共用檔與群組圈各自容錯——一方失敗不蓋整頁
test('U2b 修正：shared 拋錯→部門頁仍有分類守則框、兩區印「共用檔讀不到：原因」＋重試；groups 拋錯→shared 區仍列檔、守則處錯誤卡；公司頁只打 shared、失敗印同一句；成功兩邊都清錯', async () => {
  const fakeApi = (fail) => async (method, p) => {
    if (p.includes('/api/shared/')) { if (fail === 'shared') throw new Error('共用夾壞了'); return { scope: '旅遊', rules: [{ name: 'a.md', chars: 12, bytes: 36, uploaded_at: '2026-09-15T08:00:00.000Z' }], refs: [], rule_chars: 12, limits: { per_file: 4000, per_layer: 8000 } }; }
    if (p.includes('/api/memory/groups/')) { if (fail === 'groups') throw new Error('群組圈壞了'); return { rules: [], text: '' }; }
    if (p.includes('/api/memory/cards')) return [];
    throw new Error(`沒料到的呼叫 ${method} ${p}`);
  };
  const run = async (category, fail) => {
    const state = { categoryPage: { category, data: null, cards: [], err: null, saving: false, saveErr: null }, workflows: [], keep: {}, run: null, companyName: '範例公司' };
    await uiFn('loadCategoryPage', { state, api: fakeApi(fail) })();
    return { cp: state.categoryPage, html: uiFn('categoryPageHtml', { state, fmtInt: realFmtInt })() };
  };
  const a = await run('旅遊', 'shared');
  assert.equal(a.cp.shared, null, 'shared 失敗→null');
  assert.equal(a.cp.sharedErr, '共用夾壞了');
  assert.equal(a.cp.err, null, '群組圈沒錯');
  assert.ok(a.html.includes('分類守則（一行一條）') && a.html.includes('id="group-text"') && a.html.includes('data-act="save-group"'), '守則框照常畫');
  assert.equal(count(a.html, '共用檔讀不到：共用夾壞了'), 2, '兩區各印一句');
  assert.ok(/data-act="(reload-category|shared-retry)"[^>]*>(?:<i[^>]*><\/i>)?重試/.test(a.html), '重試鈕');
  assert.ok(!a.html.includes('這個分類的規矩讀不到') && !a.html.includes('讀取中'), '不蓋整頁、不印讀取中');
  const b = await run('旅遊', 'groups');
  assert.equal(b.cp.err, '群組圈壞了');
  assert.ok(b.cp.shared && b.cp.sharedErr === null, 'shared 照常');
  assert.ok(b.html.includes('這個分類的規矩讀不到') && b.html.includes('data-act="reload-category"'), '守則處錯誤卡');
  assert.ok(b.html.includes('data-act="shared-del" data-kind="rule" data-name="a.md"') && b.html.includes('本層已 12／8,000 字'), 'shared 區仍列檔');
  assert.ok(!b.html.includes('id="group-text"'), '群組圈壞了就沒有守則框');
  const c = await run('_company', 'shared');
  assert.equal(c.cp.sharedErr, '共用夾壞了');
  assert.equal(count(c.html, '共用檔讀不到：共用夾壞了'), 2, '公司頁同一句');
  assert.ok(c.html.includes('data-company-page') && !c.html.includes('公司共用檔讀不到'), '公司頁不走整頁錯誤卡');
  const d = await run('旅遊', null);
  assert.ok(d.cp.err === null && d.cp.sharedErr === null && d.cp.data && d.cp.shared, '成功兩邊都清錯');
  assert.ok(d.html.includes('id="group-text"') && d.html.includes('data-name="a.md"') && !d.html.includes('讀不到'));
  const src = uiSrc();
  const rl = /else if \(act === 'reload-category'\) \{[\s\S]*?\n    \}/.exec(src)[0];
  assert.ok(rl.includes('sharedErr'), 'reload-category 也清 sharedErr');
});

// ---------- U3 設定→資料：公司名稱、規範上限 ----------
const u3Ctx = (tab, msg = null) => ({ state: { settings: { tab: {}, busy: null, msg } }, setTab: () => tab, memAt: () => '' });
const u3Data = { cfg: { company_name: '範例公司', data_dir: 'x' }, backups: [], trash: { wf: [], cards: [] } };
test('U3 ①：位置與備份分頁頂端「公司」group——公司名稱列 id="set-company-name" value="範例公司"、maxlength 60、說明含「清空顯示「公司」」；規範上限列「單檔 4,000 字・每層合計 8,000 字」＋ chip 固定；公司 group 在位置之前；msg key company 印在該 group', () => {
  const html = uiFn('setDataHtml', u3Ctx('位置與備份'))(u3Data);
  const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, `該有：${s}`); return i; };
  assert.ok(/<input[^>]*id="set-company-name"[^>]*value="範例公司"/.test(html) || /<input[^>]*value="範例公司"[^>]*id="set-company-name"/.test(html), '公司名稱輸入框帶現值');
  assert.ok(/<input[^>]*id="set-company-name"[^>]*maxlength="60"/.test(html), '前端也擋 60 字（與後端同）');
  assert.ok(at('<h5>公司</h5>') < at('<h5>位置</h5>'), '公司 group 在位置 group 之前');
  assert.ok(html.includes('清空顯示「公司」'), '說明句寫清空退回「公司」');
  assert.ok(html.includes('規範上限') && html.includes('單檔 4,000 字・每層合計 8,000 字'), '規範上限列與說明');
  assert.ok(at('規範上限') < at('<span class="chip">固定</span>'), '上限列右側 chip 固定（唯讀）');
  assert.equal(count(html, 'id="set-company-name"'), 1, '輸入框只一個');
  assert.equal(count(html, 'data-act="set-company'), 0, '不靠按鈕存，change／Enter 即存');
  const empty = uiFn('setDataHtml', u3Ctx('位置與備份'))({ ...u3Data, cfg: { data_dir: 'x' } });
  assert.ok(/<input[^>]*id="set-company-name"[^>]*value=""/.test(empty), '舊設定沒 company_name 鍵→印空字串不印 undefined');
  assert.equal(count(empty, 'undefined'), 0);
  const withMsg = uiFn('setDataHtml', u3Ctx('位置與備份', { key: 'company', text: '改好了' }))(u3Data);
  assert.ok(withMsg.includes('data-setmsg="company"') && withMsg.includes('改好了'), '存成／失敗一句掛在公司 group');
  assert.ok(withMsg.indexOf('data-setmsg="company"') < withMsg.indexOf('<h5>位置</h5>'), '那一句在公司 group 內');
});

test('U3 ②：「清理」「關於」分頁 0 命中「公司名稱」與 set-company-name；SET_TABS 資料三分頁不變', () => {
  for (const tab of ['清理', '關於']) {
    const html = uiFn('setDataHtml', u3Ctx(tab))(u3Data);
    assert.equal(count(html, '公司名稱'), 0, `${tab} 不印公司名稱`);
    assert.equal(count(html, 'set-company-name'), 0, `${tab} 不印輸入框`);
    assert.equal(count(html, '規範上限'), 0, `${tab} 不印規範上限`);
  }
  assert.ok(uiSrc().includes("資料: ['位置與備份', '清理', '關於']"), 'SET_TABS 資料組不動');
});

test('U3 ③：set-company-name 的 change 處理 PUT /api/settings 帶 company_name、成功同步 state.companyName 與 cfg.company_name、失敗走 msg key company；Enter＝blur 觸發 change；不動 setPut', () => {
  const src = uiSrc();
  const i = src.indexOf("e.target.id === 'set-company-name' && state.settings?.data");
  assert.ok(i >= 0, 'change 監聽裡有 set-company-name 分支（設定頁資料還沒讀到就不存）');
  const block = src.slice(i, i + 900);
  assert.ok(block.includes("api('PUT', '/api/settings', { company_name"), 'PUT 只送 company_name');
  assert.ok(block.includes('state.companyName ='), '存成同步側欄／麵包屑／公司頁用的 state.companyName');
  assert.ok(block.includes('cfg.company_name ='), '存成同步設定頁現值（重繪從它還原）');
  assert.ok(block.includes("key: 'company'"), '結果一句走 setMsgHtml(\'company\')');
  assert.ok(block.includes('err: true'), '失敗一句標 err');
  assert.ok(/id === 'set-company-name' && e\.key === 'Enter'\) e\.target\.blur\(\)/.test(src), 'Enter＝blur，交給 change 存');
  assert.equal(count(src, "case 'set-company-name'"), 0, '不走 setPut 的 data-act 路徑（setPut 會 alert＋重抓記憶）');
});

// ---------- U4b 移植合併輪：流程頁右側資料夾、共用檔浮窗、本次資料必填在前選填收摺 ----------
const u4bRuns = [
  { run_id: 'r2', status: 'paused', started_at: '2026-09-15T10:00:00.000Z', finished_at: null, steps: { total: 2, done: 1, failed: 0 }, finals: [], files: [] },
  { run_id: 'r1', status: 'done', started_at: '2026-09-14T09:00:00.000Z', finished_at: '2026-09-14T09:06:00.000Z', steps: { total: 2, done: 2, failed: 0 }, finals: [{ node: 'w', title: '寫週報', preview: '# 週報', file: '寫週報.md' }], files: ['寫週報.md', '草稿.txt'] },
];
const u4bShared = { company: { rules: [{ name: 'r.md', chars: 10, bytes: 30 }], refs: [], rule_chars: 10 }, dept: { rules: [], refs: [{ name: 'x.md', chars: 5, bytes: 15 }, { name: 'y.docx', chars: null, bytes: 2048 }], rule_chars: 0 } };
const u4bEmptyShared = { company: { rules: [], refs: [], rule_chars: 0 }, dept: { rules: [], refs: [], rule_chars: 0 } };
const u4bCtx = (extra = {}, helpers = {}) => t10Ctx({ wfFiles: ['a.md', 'b.md', 'c.md', 'd.docx'], wfRuns: u4bRuns, shared: u4bShared, sharedOpen: false, folderOpen: { refs: true, runs: true, optional: null }, companyName: '範例公司', chat: { draft: null }, ...extra }, { fmtInt: realFmtInt, ...helpers });

test('U4b ①：flowAsideHtml——父層兩鈕、流程名、參考檔只印 3＋「查看全部 4 份」、上傳參考檔、每次執行兩筆（日期・膠囊・todo-go・成品 filechip）、灰字「公司 1 份・部門 2 份共用檔」＋shared-open；兩層皆 0→上層還沒有共用檔；草稿／run→空', () => {
  const h = uiFn('flowAsideHtml', u4bCtx())();
  assert.ok(h.startsWith('<aside class="flowaside"'), '外殼 aside.flowaside');
  assert.ok(h.includes('流程資料夾'), '標題');
  assert.ok(h.includes('data-act="open-company"') && h.includes('>範例公司<') && h.includes('data-act="open-category" data-cat="a"'), '父層兩鈕（公司名／分類）');
  assert.ok(h.includes('data-folder-now') && h.includes('>X<'), '目前流程名');
  assert.equal(count(h, 'class="folderfile"'), 3, '參考檔最多 3');
  assert.ok(h.includes('a.md') && h.includes('c.md') && !h.includes('d.docx'), '第 4 份收起');
  assert.ok(h.includes('data-act="refs-all"') && h.includes('查看全部 4 份'), '查看全部 4 份');
  assert.ok(h.includes('data-act="ref-upload"') && h.includes('上傳參考檔'), '上傳參考檔走原鍵');
  assert.equal(count(h, 'class="folderrun"'), 2, '每次執行兩筆');
  assert.ok(h.indexOf('data-rid="r2"') < h.indexOf('data-rid="r1"'), '照 API 順序（新的在前）');
  assert.ok(h.includes('data-act="todo-go" data-cat="a" data-id="x" data-rid="r2"') && h.includes('data-act="todo-go" data-cat="a" data-id="x" data-rid="r1"'), '「打開」走 todo-go 原鍵');
  assert.ok(/<span class="rtime">9\/15[\s ]1[08]:00<\/span>/.test(h), `日期（fmtWhen；Intl 的分隔是 U+2009 細空白）：${h.match(/<span class="rtime">[^<]*<\/span>/g)}`);
  assert.ok(h.includes('<span class="chip wait"><i class="ph ph-hand-palm"></i>等你</span>') && h.includes('<span class="chip quiet"><i class="ph-fill ph-check-circle"></i>完成</span>'), '狀態膠囊沿 dashRunCard 三色');
  assert.ok(h.includes('class="chip expander filechip" data-act="preview-file" data-cat="a" data-id="x" data-rid="r1" data-fname="寫週報.md"'), '成品檔 chip 走既有預覽');
  assert.ok(!h.includes('data-fname="草稿.txt"') && h.includes('其他產出 1 份'), '非成品不列 chip，只計數');
  assert.ok(h.includes('公司 1 份・部門 2 份共用檔') && h.includes('data-act="shared-open"'), '灰字一行＋查看');
  assert.ok(h.includes('<details data-folder="refs" open>') && h.includes('<details data-folder="runs" open>'), '兩塊預設展開');
  assert.ok(h.includes('data-act="folder-toggle" data-k="refs"') && h.includes('data-act="folder-toggle" data-k="runs"'), 'summary 帶 folder-toggle');
  const closed = uiFn('flowAsideHtml', u4bCtx({ folderOpen: { refs: false, runs: false, optional: null } }))();
  assert.ok(closed.includes('<details data-folder="refs">') && closed.includes('<details data-folder="runs">'), 'folderOpen false→不帶 open（狀態驅動）');
  const all = uiFn('flowAsideHtml', u4bCtx({ folderOpen: { refs: true, runs: true, optional: null, refsAll: true, runsAll: true } }))();
  assert.equal(count(all, 'class="folderfile"'), 4, 'refsAll→全列');
  assert.ok(!all.includes('data-act="refs-all"'));
  const many = uiFn('flowAsideHtml', u4bCtx({ wfRuns: [...u4bRuns, { ...u4bRuns[1], run_id: 'r0' }, { ...u4bRuns[1], run_id: 'r-1' }] }))();
  assert.equal(count(many, 'class="folderrun"'), 3, '每次執行最多 3');
  assert.ok(many.includes('data-act="runs-all"') && many.includes('查看全部 4 趟'));
  const none = uiFn('flowAsideHtml', u4bCtx({ shared: u4bEmptyShared, wfFiles: [], wfRuns: [] }))();
  assert.ok(none.includes('上層還沒有共用檔') && !none.includes('data-act="shared-open"'), '兩層皆 0');
  assert.ok(none.includes('還沒有參考檔') && none.includes('還沒開跑過'), '兩塊空態');
  const bad = uiFn('flowAsideHtml', u4bCtx({ wfRuns: null, shared: { company: null, dept: null, err: 'x' } }))();
  assert.equal(count(bad, '讀不到'), 2, '執行與共用檔各印一次讀不到');
  const unreadable = uiFn('flowAsideHtml', u4bCtx({ wfRuns: [{ run_id: 'c', status: 'unreadable', error: '檔案讀不懂', started_at: null, finished_at: null, steps: { total: 0, done: 0, failed: 0 }, finals: [], files: [] }] }))();
  assert.ok(unreadable.includes('chip bad') && unreadable.includes('檔案讀不懂') && !unreadable.includes('data-act="todo-go"'), '壞掉那趟：紅膠囊＋原因、沒有打開');
  assert.equal(uiFn('flowAsideHtml', u4bCtx({}, { subjectIsDraft: () => true }))(), '', '草稿沒有側欄');
  assert.equal(uiFn('flowAsideHtml', u4bCtx({ run: { run_id: 'r' } }))(), '', '執行頁沒有側欄');
});

test('U4b ②：sharedModalHtml——開著：pvback.memmodal.sharedmodal、兩層標題各一、每列 規範／參考 chip＋字數、去公司頁／部門頁管理鈕；關著空；run 時空', () => {
  const m = uiFn('sharedModalHtml', u4bCtx({ sharedOpen: true }))();
  assert.ok(m.startsWith('<div class="pvback memmodal sharedmodal" data-act="shared-close">'), '掛 .pvback');
  assert.ok(m.includes('role="dialog"') && m.includes('data-act="shared-close"') && m.includes('title="關閉（Esc）"'), '關閉鈕');
  assert.equal(count(m, 'data-shared-layer="company"'), 1);
  assert.equal(count(m, 'data-shared-layer="dept"'), 1);
  assert.ok(m.indexOf('data-shared-layer="company"') < m.indexOf('data-shared-layer="dept"'), '公司在上、部門在下');
  assert.ok(m.includes('>範例公司<') && m.includes('>a<'), '兩層標題＝公司名／分類名');
  assert.equal(count(m, 'class="sharedrow"'), 3, '三列');
  assert.equal(count(m, '>規範</span>'), 1);
  assert.equal(count(m, '>參考</span>'), 2);
  assert.ok(m.includes('r.md') && m.includes('10 字') && m.includes('x.md') && m.includes('5 字') && m.includes('y.docx') && m.includes('2 KB'), '檔名＋字數／KB');
  assert.ok(m.includes('data-act="open-company"') && m.includes('去公司頁管理') && m.includes('data-act="open-category" data-cat="a"') && m.includes('去部門頁管理'), '去管理兩鈕');
  assert.ok(!m.includes('data-act="shared-del"') && !m.includes('data-act="shared-upload"'), '唯讀：沒有刪除與上傳');
  const empty = uiFn('sharedModalHtml', u4bCtx({ sharedOpen: true, shared: u4bEmptyShared }))();
  assert.equal(count(empty, '尚無共用檔'), 2, '兩層空態各一');
  assert.equal(uiFn('sharedModalHtml', u4bCtx({ sharedOpen: false }))(), '', '關著空');
  assert.equal(uiFn('sharedModalHtml', u4bCtx({ sharedOpen: true, run: { run_id: 'r' } }))(), '', '執行頁不彈');
  assert.equal(uiFn('sharedModalHtml', u4bCtx({ sharedOpen: true }, { subjectIsDraft: () => true }))(), '', '草稿不彈');
});

const u4bDef = { ...t10Def, params: [{ key: 'r1', label: '必一', default: '', required: true }, { key: 'o1', label: '選一', default: '', hint: 'h' }, { key: 'r2', label: '必二', default: '', required: true }] };
const u4bParams = (extra = {}) => uiFn('paramRowsHtml', u4bCtx({ paramNow: {}, ...extra }, { ...t10Stubs, subjectDef: () => u4bDef, habitChipsHtml: () => '<i data-habit></i>' }))(u4bDef);
test('U4b ③：paramRowsHtml——必填兩列在 <details class="formdetails"> 之前、選填在其內；三個 data-param 都在、必填 chip 兩個、habitChipsHtml 三次；open＝有值或 folderOpen.optional；沒有選填就沒有 details', () => {
  const h = u4bParams();
  const d = h.indexOf('<details class="formdetails"');
  assert.ok(d >= 0, '有 details.formdetails');
  assert.ok(h.indexOf('data-param="r1"') < d && h.indexOf('data-param="r2"') < d, '必填兩列在前');
  assert.ok(h.indexOf('data-param="o1"') > d && h.indexOf('data-param="o1"') < h.lastIndexOf('</details>'), '選填在 details 內');
  assert.equal(count(h, 'data-param="'), 3, '三個 data-param 一個不少');
  assert.equal(count(h, 'class="chip req"'), 2, '必填 chip 兩個');
  assert.equal(count(h, 'data-habit'), 3, 'habitChipsHtml 三次');
  assert.ok(h.includes('其他資料（選填）') && h.includes('data-act="folder-toggle" data-k="optional"'), 'summary 字與 folder-toggle');
  assert.ok(h.includes('placeholder="h"'), '每列 markup 原樣（hint）');
  assert.ok(!h.includes('<details class="formdetails" open'), '沒值→收摺');
  assert.ok(u4bParams({ paramNow: { o1: 'v' } }).includes('<details class="formdetails" open'), '選填有值→展開');
  assert.ok(u4bParams({ folderOpen: { refs: true, runs: true, optional: true } }).includes('<details class="formdetails" open'), '使用者展開過→展開');
  assert.ok(!u4bParams({ paramNow: { o1: 'v' }, folderOpen: { refs: true, runs: true, optional: false } }).includes('<details class="formdetails" open'), '使用者收過→即使有值也收');
  const reqOnly = { ...u4bDef, params: u4bDef.params.filter((p) => p.required) };
  const r = uiFn('paramRowsHtml', u4bCtx({ paramNow: {} }, { ...t10Stubs, subjectDef: () => reqOnly }))(reqOnly);
  assert.ok(!r.includes('formdetails') && count(r, 'data-param="') === 2, '沒有選填就沒有 details');
});

test('U4b ④：接線——render 工作區包 .flowlayout（只在 else 分支，run 分支不含）；浮窗串加 sharedModalHtml；Esc 關；事件五個；openWorkflow 重抓資料夾＋關浮窗；state.wf.runs 原形狀不動；ref-file change 後重畫側欄；CSS', () => {
  const src = uiSrc();
  const rd = /function render\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(rd.includes('<div class="flowlayout"><section class="flowmain">${body}</section>${aside}</div>'), '工作區串包 flowlayout');
  const runBranch = /else if \(state\.run\) inner = runHtml\(\);/.exec(rd);
  assert.ok(runBranch && rd.indexOf('flowAsideHtml()') > runBranch.index, 'run 分支不含側欄，側欄只在最後 else');
  assert.equal(count(rd, 'flowAsideHtml()'), 1);
  const fa = /function flowAsideHtml\(\) \{\n([^\n]*)/.exec(src)[1];
  assert.ok(fa.includes('state.run') && fa.includes('subjectIsDraft()') && fa.includes("return ''"), '側欄第一行守門：run／草稿回空');
  assert.ok(src.includes('memCardModalHtml() + flowSettingsModalHtml() + flowMemModalHtml() + sharedModalHtml() + setConfirmModalHtml()'), '浮窗掛 .layout 外（地雷 5）');
  assert.ok(src.includes("e.key === 'Escape' && state.sharedOpen"), 'Esc 關共用檔浮窗');
  for (const a of ['folder-toggle', 'shared-open', 'shared-close', 'refs-all', 'runs-all']) assert.ok(src.includes(`act === '${a}'`), a);
  const ft = /act === 'folder-toggle'\) \{[\s\S]*?\n    \}/.exec(src)[0];
  assert.ok(!ft.includes('render()'), 'folder-toggle 不整頁重繪（打到一半的值不洗）；狀態進 state 下次重繪讀回');
  const ow = /async function openWorkflow\([\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(ow.includes("const runs = await api('GET', `${wfPath({ category, id })}/runs`);") && ow.includes('state.wf = { category, id, def, runs };'), 'state.wf.runs 原形狀（resumeHtml 讀者）');
  assert.ok(ow.includes('await refreshFolder()') && ow.includes('state.sharedOpen = false'), '開流程重抓資料夾、關浮窗');
  const rf = /async function refreshFolder\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(rf.includes('/runs?detail=1') && rf.includes("sharedPath('_company')") && rf.includes('sharedPath(wf.category)'), '三支：runs?detail=1＋兩層 shared');
  assert.ok(rf.includes('state.wfRuns = ') && rf.includes('state.shared = '), '存進 wfRuns／shared');
  for (const at of ["act === 'back'", "act === 'del-run'"]) { const b = new RegExp(at.replace(/[()]/g, '\\$&') + '\\) \\{[\\s\\S]*?\\n    \\}').exec(src)[0]; assert.ok(b.includes('refreshFolder()'), `${at} 重抓資料夾`); }
  const rfile = /getElementById\('ref-file'\)\.addEventListener\('change'[\s\S]*?\n\}\);/.exec(src)[0];
  assert.ok(rfile.includes('repaintAside()'), 'ref-file change 後重畫側欄（不整頁）');
  assert.ok(/wfRuns: \[\]/.test(src) && /shared: \{ company: null, dept: null/.test(src) && /sharedOpen: false/.test(src) && /folderOpen: \{ refs: true, runs: true, optional: null/.test(src), 'state 四鍵');
  const css = cssSrc();
  for (const s of ['.flowlayout{display:grid;grid-template-columns:minmax(0,1fr) 260px', '.flowaside{', '.formdetails{', '.sharedmodal .modal{', '.folderrun{']) assert.ok(css.includes(s), `CSS ${s}`);
  assert.ok(/@media \(max-width:1100px\)\{[^}]*\.flowlayout\{grid-template-columns:1fr\}/.test(css), '1100 以下退單欄');
});

test('U4b ⑤：dataTabHtml——「開始」與身分列原樣、h5 本次資料、底部「只用於本次」；T10③ 的四件續在', () => {
  const data = uiFn('dataTabHtml', u4bCtx({}, { ...t10Stubs, subjectDef: () => u4bDef }))();
  assert.ok(data.includes('<h5>本次資料</h5>') && data.includes('只用於本次'), 'h5 與底部一句');
  assert.ok(data.includes('data-act="start"') && data.includes('id="mem-identity"') && data.includes('data-param="r1"') && data.includes('data-resume'), '開始／身分／欄位／續跑卡都在');
  assert.ok(data.lastIndexOf('只用於本次') < data.lastIndexOf('data-act="start"'), '「只用於本次」在「開始」旁');
  assert.ok(!data.includes('本次資料 · 只影響這一次'), '舊 h5 字退場');
});

// ---------- U4c 移植合併輪：抽屜參考檔三段、跨層勾選 {scope,name}、「這一步會帶」四段 ----------
const u4cShared = { company: { rules: [{ name: 'r.md', chars: 10, bytes: 30 }], refs: [{ name: 'b.md', chars: 5, bytes: 15 }], rule_chars: 10 }, dept: { rules: [], refs: [], rule_chars: 0 } };
const u4cRefs = (wfFiles, shared, node) => uiFn('refFilesInner', { state: { wfFiles, shared } })(node);
test('U4c ①：refFilesInner 三段「這條流程／部門／公司」各一次；部門段「尚無參考」；流程檔與公司檔都 checked、id 帶 scope、data-att-scope；規範不進勾選；流程段有範本 chip、ref-del、上傳參考檔；上層讀不到→該段一句', () => {
  const html = u4cRefs(['a.docx'], u4cShared, { id: 'n1', attachments: ['a.docx', { scope: 'company', name: 'b.md' }] });
  for (const seg of ['這條流程', '部門', '公司']) assert.equal(count(html, `<div class="refseghead">${seg}</div>`), 1, seg);
  assert.ok(html.indexOf('data-refseg="flow"') < html.indexOf('data-refseg="category"') && html.indexOf('data-refseg="category"') < html.indexOf('data-refseg="company"'), '順序 流程→部門→公司');
  assert.equal(count(html, '尚無參考'), 1, '只有部門段空');
  assert.ok(/id="ref-flow-a\.docx"[^>]*data-att="a\.docx" data-att-scope="flow" checked/.test(html), '流程檔 checked＋scope flow');
  assert.ok(/id="ref-company-b\.md"[^>]*data-att="b\.md" data-att-scope="company" checked/.test(html), '公司檔 checked＋scope company');
  assert.equal(count(html, 'name="ref-flow-a.docx"'), 1, 'name 同 id');
  assert.equal(count(html, 'r.md'), 0, '規範不進勾選');
  assert.equal(count(html, '<input type="checkbox"'), 2, '兩顆勾');
  assert.ok(html.includes('>範本</span>') && html.includes('data-act="ref-del" data-name="a.docx"'), '流程段範本 chip 與刪除鈕');
  const flowSeg = html.slice(html.indexOf('data-refseg="flow"'), html.indexOf('data-refseg="category"'));
  assert.ok(flowSeg.includes('data-act="ref-upload"') && count(html, 'data-act="ref-upload"') === 1, '上傳參考檔只在流程段');
  assert.equal(count(html, 'data-act="ref-del"'), 1, '共用層沒有刪除鈕');
  const unchecked = u4cRefs(['a.docx'], u4cShared, { id: 'n1' });
  assert.ok(!unchecked.includes('checked'), '沒勾就沒 checked');
  const loading = u4cRefs([], { company: null, dept: null, err: null }, { id: 'n1' });
  assert.equal(count(loading, '讀取中'), 2, '兩層還沒讀到→各一句');
  const broken = u4cRefs([], { company: null, dept: null, err: 'boom' }, { id: 'n1' });
  assert.equal(count(broken, '讀不到'), 2, '兩層讀不到→各一句');
  assert.equal(count(loading, '尚無參考'), 1, '流程段空→尚無參考');
});

test('U4c ②：同名兩層 x.md→兩個不同 id、各自 checked 互不影響；checkedOverride 走 scope:name 鍵；舊流程（attachments 全字串）只勾流程段', () => {
  const both = { company: { rules: [], refs: [{ name: 'x.md', chars: 1, bytes: 3 }], rule_chars: 0 }, dept: { rules: [], refs: [{ name: 'x.md', chars: 1, bytes: 3 }], rule_chars: 0 } };
  const html = u4cRefs(['x.md'], both, { id: 'n1', attachments: [{ scope: 'category', name: 'x.md' }] });
  assert.equal(count(html, 'id="ref-flow-x.md"'), 1);
  assert.equal(count(html, 'id="ref-category-x.md"'), 1);
  assert.equal(count(html, 'id="ref-company-x.md"'), 1);
  assert.equal(count(html, 'checked'), 1, '只有部門那份勾');
  assert.ok(/id="ref-category-x\.md"[^>]*checked/.test(html), '勾在部門段');
  const over = uiFn('refFilesInner', { state: { wfFiles: ['x.md'], shared: both } })({ id: 'n1' }, new Set(['company:x.md', 'flow:x.md']));
  assert.ok(/id="ref-flow-x\.md"[^>]*checked/.test(over) && /id="ref-company-x\.md"[^>]*checked/.test(over) && !/id="ref-category-x\.md"[^>]*checked/.test(over), 'override 依 scope:name');
  const old = u4cRefs(['x.md'], both, { id: 'n1', attachments: ['x.md'] });
  assert.ok(/id="ref-flow-x\.md"[^>]*checked/.test(old) && count(old, 'checked') === 1, '舊字串陣列只勾流程段');
});

test('U4c ③：接線原文——cv-apply 用 data-att-scope 組回 string｜{scope,name}（flow 段仍存字串）；refreshRefSection 收 scope:name；ref-file change 與 cvmore 結構不動；CSS .refseg', () => {
  const src = uiSrc();
  const apply = src.slice(src.indexOf("else if (act === 'cv-apply')"), src.indexOf("else if (act === 'cv-delete')"));
  assert.ok(/scope === 'flow' \? name : \{ scope/.test(apply), 'flow 段存字串、其餘存物件');
  assert.ok(apply.includes('attScope') && apply.includes("if (picked.length) n.attachments = picked; else delete n.attachments;"), '收值那段原樣（只擴 scope）');
  const refresh = src.slice(src.indexOf('async function refreshRefSection()'), src.indexOf('// 抽屜內容'));
  assert.ok(refresh.includes("`${c.dataset.attScope ?? 'flow'}:${c.dataset.att}`"), 'refreshRefSection 鍵 scope:name');
  assert.ok(src.includes('<details class="cvmore" id="cv-more"') && src.includes('${refFilesSectionHtml(n)}'), 'T11 結構不動');
  assert.ok(src.includes("document.getElementById('ref-file').addEventListener('change'") && src.includes('await refreshRefSection();\n    repaintAside();'), 'ref-file change 原樣');
  const css = cssSrc();
  assert.ok(css.includes('.refseg{') && css.includes('.refseghead{'), 'CSS .refseg／.refseghead');
});

const u4cMemCtx = (wfMemory, shared) => ({ state: { wfMemory, shared }, subjectIsDraft: () => false, kindOf: () => 'task' });
const u4cMem = { core: { expression: [{}], content: [{}, {}] }, group: { rules: [{}, {}] }, options: {} };
const u4cNode = { id: 'n1', executor: 'ai', instruction: 'i' };
test('U4c ④：drawerMemoryHtml——「關於你 3・分類守則 2・公司規範 2・部門規範 1」；兩層 0→不含「規範」；全 0→「這一步會帶：沒有記憶與規範」；記憶讀不到但有規範→仍印規範；人做步驟空', () => {
  const sh = (c, d) => ({ company: { rules: Array.from({ length: c }, (_, i) => ({ name: `c${i}.md` })), refs: [], rule_chars: 0 }, dept: { rules: Array.from({ length: d }, (_, i) => ({ name: `d${i}.md` })), refs: [], rule_chars: 0 } });
  const four = uiFn('drawerMemoryHtml', u4cMemCtx(u4cMem, sh(2, 1)))(u4cNode);
  assert.ok(four.includes('這一步會帶：') && four.includes('關於你 3・分類守則 2・公司規範 2・部門規範 1'), four);
  const none = uiFn('drawerMemoryHtml', u4cMemCtx(u4cMem, sh(0, 0)))(u4cNode);
  assert.ok(none.includes('關於你 3・分類守則 2') && !none.includes('規範'), '兩層 0 不印規範');
  const onlyDept = uiFn('drawerMemoryHtml', u4cMemCtx(u4cMem, sh(0, 3)))(u4cNode);
  assert.ok(onlyDept.includes('分類守則 2・部門規範 3') && !onlyDept.includes('公司規範'), '公司 0 省略');
  const zero = uiFn('drawerMemoryHtml', u4cMemCtx({ core: { expression: [], content: [] }, group: { rules: [] }, options: {} }, sh(0, 0)))(u4cNode);
  assert.ok(zero.includes('這一步會帶：') && zero.includes('沒有記憶與規範') && !zero.includes('關於你'), '全 0');
  const noMem = uiFn('drawerMemoryHtml', u4cMemCtx(null, sh(1, 0)))(u4cNode);
  assert.ok(noMem.includes('公司規範 1') && !noMem.includes('關於你'), '記憶讀不到、有規範仍印');
  assert.equal(uiFn('drawerMemoryHtml', u4cMemCtx(null, sh(0, 0)))(u4cNode), '', '記憶讀不到、沒規範→空');
  assert.equal(uiFn('drawerMemoryHtml', u4cMemCtx(u4cMem, sh(2, 1)))({ ...u4cNode, executor: 'human' }), '', '人做步驟不印');
  const paused = uiFn('drawerMemoryHtml', u4cMemCtx({ ...u4cMem, paused: true }, sh(2, 1)))(u4cNode);
  assert.ok(paused.includes('關於你 暫停中・分類守則 2・公司規範 2・部門規範 1'), '暫停中照印規範');
});

// ---------- 移植合併輪 U5：儀表板兩欄＋最近完成三行版＋接下來的安排＋流程提議＋用量小圖與浮窗 ----------
const u5Recent = (n) => Array.from({ length: n }, (_, i) => ({
  category: 'a', id: 'x', run_id: `r${i}`, name: `趟${i}`, status: 'done', source: 'manual', makeup: false,
  started_at: '2026-09-14T09:00:00.000Z', finished_at: '2026-09-14T09:06:00.000Z', steps: { done: 2, total: 2, failed: 0 },
  finals: [{ node: 'w', title: '寫週報', preview: '# 週報', file: '寫週報.md' }],
  usage: { input: 100, output: 50, cost: 0.01, check: { input: 10, output: 5 }, supervisor: { input: 0, output: 0 } },
}));
const u5Todos = [
  { kind: 'proposal', tone: 'prop', title: '寫週報有新提議', desc: '把「先列安全處置」加進流程', workflow: { category: 'a', id: 'x' } },
  { kind: 'stop', tone: 'hold', title: '寫週報停在第 2 步', desc: '等你過目', run: { category: 'a', id: 'x', run_id: 'r9' } },
];
const u5Ctx = (dash = {}, extra = {}, helpers = {}) => ({
  state: {
    dash: { data: { recent: u5Recent(4), usage: [], usage_days: 30, memory: { exceptions: { total: 0 } } }, usageView: 'flow', open: {}, promptView: null, usageOpen: false, showAll: false, calendar: { events: [] }, ...dash },
    todos: u5Todos, notices: { unread: [], done: [] }, noticesOpen: false, workflows: [], rendered: {}, rawView: new Set(), ...extra,
  },
  fileChipHtml: () => '', mdBlock: (t, k, cls) => `<div class="${cls}">${t}</div>`, ...helpers,
});
const u5Split = (h) => { const a = h.indexOf('<aside class="homeaside">'); return [h.slice(h.indexOf('<section class="homemain">'), a), h.slice(a)]; };

test('U5 ①：dashHtml 兩欄——左「要你處理」（1 列＋chip wait 等你、提議列不在）＋「最近完成」三張＋dash-show-all；右依序 接下來的安排→系統通知→流程提議（去看提議）→用量（小圖＋用量明細）；CSS .homegrid 300px、1100 以下退單欄', () => {
  const h = uiFn('dashHtml', u5Ctx())();
  assert.ok(h.includes('<div class="homegrid">') && h.includes('<section class="homemain">') && h.includes('<aside class="homeaside">'), '兩欄外殼');
  assert.ok(!h.includes('dashtop'), '舊的上下堆疊 .dashtop 退場');
  const [main, aside] = u5Split(h);
  assert.ok(main.includes('要你處理') && main.includes('<span class="cnt hot">1</span>'), `待辦數字不算提議：${main.match(/class="cnt[^<]*</)}`);
  assert.equal(count(main, 'class="item '), 1, '只剩 stop 那列');
  assert.ok(main.includes('data-act="todo-go" data-cat="a" data-id="x" data-rid="r9"') && main.includes('<span class="chip wait"><i class="ph ph-hand-palm"></i>等你</span>'), '去處理鈕＋等你膠囊');
  assert.ok(!main.includes('去看提議') && !main.includes('todo-open-wf'), '提議列搬去右欄');
  assert.ok(main.includes('最近完成'), '最近完成標題');
  assert.equal(count(main, 'class="runcard'), 3, '預設 3 張');
  assert.ok(main.includes('data-act="dash-show-all"') && main.includes('查看全部（4）'), '查看全部（N）');
  const order = ['接下來的安排', '系統通知', '流程提議', 'data-act="dash-usage-open"'].map((s) => aside.indexOf(s));
  assert.ok(order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), `右欄順序：${order}`);
  assert.ok(aside.includes('data-act="todo-open-wf" data-cat="a" data-id="x"') && aside.includes('去看提議'), '流程提議那塊有那筆提議');
  assert.ok(aside.includes('<svg class="usagechart"') && aside.includes('用量明細'), '用量小圖＋用量明細鈕');
  assert.ok(aside.includes('data-act="notices-toggle-done"'), '系統通知原樣（noticeSectionHtml）');
  const none = uiFn('dashHtml', u5Ctx({}, { todos: [u5Todos[1]] }))();
  assert.ok(u5Split(none)[1].includes('沒有新提議'), '沒有提議→空態');
  const css = cssSrc();
  assert.ok(css.includes('.homegrid{display:grid;grid-template-columns:minmax(0,1fr) 300px'), 'CSS .homegrid');
  assert.ok(/@media \(max-width:1100px\)\{[^\n]*\.homegrid\{grid-template-columns:1fr\}/.test(css), '1100 以下退單欄');
  assert.ok(css.includes('.usagechart rect.today{fill:var(--accent)}') && css.includes('.usagechart rect{fill:var(--ink-300)}'), '小長條：灰＋今天 accent');
});

test('U5 ①-b：dashRunCard 三行版——收合＝名稱・膠囊・rtime・打開・更多，不含 tokens／查核 token／final／dash-prompt；展開＝全出現＋stepline；T5③ 三色續綠', () => {
  const card = (dash) => uiFn('dashRunCard', u5Ctx(dash))(u5Recent(1)[0]);
  const closed = card();
  assert.ok(closed.includes('<b>趟0</b><span class="chip quiet">'), '名稱後緊接狀態膠囊（T5③ regex）');
  assert.ok(closed.includes('<span class="rtime">') && closed.includes('手動開跑・2/2 步'), 'rtime 一行');
  assert.ok(closed.includes('data-act="todo-go" data-cat="a" data-id="x" data-rid="r0"'), '打開');
  assert.ok(closed.includes('data-act="dash-expand" data-key="a/x/r0"') && closed.includes('>更多<'), '更多＝dash-expand 原鍵');
  for (const w of ['tokens', '查核 15 token', 'class="final"', 'dash-prompt', 'stepline']) assert.ok(!closed.includes(w), `收合不該有 ${w}`);
  const opened = card({ open: { 'a/x/r0': { run: { def: { nodes: [{ id: 'w', title: '寫週報' }] }, steps: { w: { status: 'done', output: '內容', check: { status: 'pass' } } }, usage_by_node: { w: { check: { input: 10, output: 5 } } } }, prompts: ['w.txt'], cat: 'a', id: 'x', rid: 'r0' } } });
  for (const w of ['150 tokens', '查核 15 token', 'class="final"', 'data-act="dash-prompt"', 'class="stepline"', '>收合<', '寫週報']) assert.ok(opened.includes(w), `展開該有 ${w}`);
  assert.ok(opened.includes('<b>趟0</b><span class="chip quiet">'), '展開時頭一列不變');
  const loading = card({ open: { 'a/x/r0': null } });
  assert.ok(loading.includes('讀取中') && loading.includes('150 tokens'), '骨架中：token 已在、每步讀取中');
});

test('U5 ②：usageChartHtml——30 根 rect、今天一根 class="today"、viewBox 0 0 120 24；large→0 0 120 40；空帳本 30 根高 0 不炸', () => {
  const chart = uiFn('usageChartHtml', u5Ctx());
  const now = new Date().toISOString();
  const h = chart([{ at: now, input_tokens: 100, output_tokens: 50 }, { at: '2000-01-01T00:00:00.000Z', input_tokens: 999, output_tokens: 1 }]);
  assert.equal(count(h, '<rect '), 30, '30 根');
  assert.equal(count(h, 'class="today"'), 1, '今天一根');
  assert.ok(h.includes('<svg class="usagechart" viewBox="0 0 120 24"'), 'viewBox 小圖');
  assert.ok(/<rect x="116" y="0" width="3" height="24" class="today">/.test(h), `最右一根＝今天、滿高：${h.match(/<rect x="116"[^>]*>/)}`);
  const big = chart([], true);
  assert.ok(big.includes('<svg class="usagechart large" viewBox="0 0 120 40"'), '大圖');
  assert.equal(count(big, '<rect '), 30);
  assert.equal(count(big, 'height="0"'), 30, '空帳本 30 根高 0');
});

test('U5 ③：usageModalHtml——usageOpen 才印 .modalback＋seg 按流程／按日＋usagetbl 表格；按日多一張大圖；接線：state 三鍵、loadDash 抓 calendar、事件三鍵、Esc、輪詢守門', () => {
  const ledger = [{ at: new Date().toISOString(), input_tokens: 100, output_tokens: 50, cost_usd: 0.01, kind: 'compose' }];
  const modal = (dash) => { const c = u5Ctx({ usageOpen: true, data: { recent: [], usage: ledger, usage_days: 30, memory: { exceptions: { total: 0 } } }, ...dash }); return uiFn('usageModalHtml', c)(c.state.dash); };
  const flow = modal();
  assert.ok(flow.startsWith('<div class="modalback" data-act="dash-usage-back">'), '.modalback 外殼');
  assert.ok(flow.includes('data-act="dash-usage-view" data-view="flow"') && flow.includes('data-act="dash-usage-view" data-view="day"'), 'seg 兩鍵原鍵');
  assert.ok(flow.includes('class="usagetbl"') && flow.includes('聊天建流程'), '數字表原樣');
  assert.ok(flow.includes('data-act="dash-usage-close"'), '關閉鈕');
  assert.ok(!flow.includes('usagechart large'), '按流程沒有大圖');
  const day = modal({ usageView: 'day' });
  assert.ok(day.includes('usagechart large') && day.includes('viewBox="0 0 120 40"'), '按日有大圖');
  const closedCtx = u5Ctx();
  assert.equal(uiFn('usageModalHtml', closedCtx)(closedCtx.state.dash), '', 'usageOpen false→空');
  const src = uiSrc();
  assert.equal(count(src, "state.dash = { data: null, usageView: 'flow', open: {}, promptView: null, usageOpen: false, showAll: false, calendar: null };"), 2, '兩處初值同步');
  assert.ok(src.includes("api('GET', `/api/calendar?month=${ymOf(new Date())}`).catch(() => null)"), 'loadDash 多抓 calendar（失敗＝null）');
  for (const a of ["act === 'dash-usage-open'", "act === 'dash-usage-close'", "act === 'dash-show-all'"]) assert.ok(src.includes(a), `事件 ${a}`);
  assert.ok(src.includes("if (e.key === 'Escape' && state.dash?.usageOpen) { state.dash.usageOpen = false; render(); return; }"), 'Esc 關用量浮窗');
  assert.ok(src.includes('if (!typing && !state.preview && !state.dash?.usageOpen) render();'), '輪詢守門：浮窗開著不重繪');
});

test('U5 ④：showAll——true 印全部 4 張＋「收起」；recent ≤ 3 沒有鈕', () => {
  const all = uiFn('dashHtml', u5Ctx({ showAll: true }))();
  assert.equal(count(all, 'class="runcard'), 4);
  assert.ok(all.includes('data-act="dash-show-all"') && all.includes('>收起<') && !all.includes('查看全部'), '收起');
  const few = uiFn('dashHtml', u5Ctx({ data: { recent: u5Recent(2), usage: [], usage_days: 30, memory: { exceptions: { total: 0 } } } }))();
  assert.equal(count(few, 'class="runcard'), 2);
  assert.ok(!few.includes('data-act="dash-show-all"'), '不到 3 張沒有鈕');
});

test('U5 ⑤：upcomingHtml——calendar null→讀不到；事件空→這個月沒有安排＋open-calendar；未來事件取前兩筆（時刻・名・AI 自動／你出面），過去與 Google 快照不算', () => {
  const up = (calendar) => { const c = u5Ctx({ calendar }); return uiFn('upcomingHtml', c)(c.state.dash); };
  assert.ok(up(null).includes('讀不到'), 'null→讀不到');
  const empty = up({ events: [] });
  assert.ok(empty.includes('這個月沒有安排') && empty.includes('data-act="open-calendar"'), '空態＋查看行事曆');
  const ev = (date, time, kind, title) => ({ date, time, kind, title });
  const h = up({ events: [
    ev('2000-01-01', '08:00', 'auto', '過去的'), ev('2999-01-01', '07:00', 'goog', 'Google 的'),
    ev('2999-01-02', '08:00', 'auto', '寫週報 自動開跑'), ev('2999-01-03', '09:30', 'human', '交安全處置（寫週報）'), ev('2999-01-04', '10:00', 'auto', '第三筆'),
  ] });
  assert.equal(count(h, 'class="upcoming"'), 2, '只取兩筆');
  assert.ok(h.includes('1/2 08:00') && h.includes('寫週報 自動開跑') && h.includes('AI 自動'), '第一筆');
  assert.ok(h.includes('1/3 09:30') && h.includes('交安全處置（寫週報）') && h.includes('你出面'), '第二筆');
  for (const w of ['過去的', 'Google 的', '第三筆']) assert.ok(!h.includes(w), `${w} 不該出現`);
  assert.ok(h.includes('data-act="open-calendar"'), '查看行事曆常駐');
  assert.ok(!h.includes('這個月沒有安排'));
});

// ---------- U6a 移植合併輪：執行頁三欄骨架（左軌／中欄／右欄摺疊殼）＋ waiting_check 膠囊 ----------
const U6_NODES = () => [
  { id: 'n1', title: '收集', executor: 'ai', instruction: '做', next: ['n2'], review_focus: '件數要對' },
  { id: 'n2', title: '寫稿', executor: 'ai', instruction: '做', next: ['n3'] },
  { id: 'n3', title: '定稿', executor: 'human', instruction: '做', next: [] },
];
const u6Run = (over = {}) => ({
  run_id: 'r1', workflow: { category: 'c', id: 'w' }, status: 'running', started_at: '2026-09-15T10:00:00Z', params: {},
  def: { name: '週報', nodes: U6_NODES(), params: [], supervisor: { enabled: true } },
  brief: { text: '先守住件數' },
  steps: {
    n1: { status: 'done', output: '成品一', memory: { cards: [], shared: { company: [{ name: '手冊.md', chars: 20 }], dept: [], refs: [] } }, attempts: [{ at: '2026-09-15T10:01:00Z', reason: 'first', check: { status: 'pass', blocks: [], flags: [] } }], handoff: { text: '交接一' } },
    n2: { status: 'waiting_review', output: '成品二', check: { blocks: [], summary: '' } },
    n3: { status: 'pending' },
  },
  ...over,
});
const u6State = (extra = {}) => ({
  ...cardState({ run: u6Run() }), companyName: '', wf: null, chat: { draft: null }, supOpen: {}, memOpen: {}, rawView: new Set(), rendered: {},
  feedbackSent: false, proposals: { pending: [], more: 0 }, sideOpen: { sup: true, data: true, focus: false, attempts: false }, runInspect: null, ...extra,
});
// preflightFor 預設塞 null（真的那支會背景打 API＋碰 document）；U6b 的來源一行測試自己給假健檢結果
const u6Html = (extra = {}, stubs = {}) => uiFn('runHtml', { ...CARD_STUBS, preflightFor: () => null, ...stubs, state: u6State(extra) })();
const u6Cols = (h) => { // 三欄各自的片段（依序切）
  const a = h.indexOf('<aside class="progressrail">'), b = h.indexOf('<section class="runmain">'), c = h.indexOf('<aside class="sideinfo">');
  return { a, b, c, rail: h.slice(a, b), main: h.slice(b, c), side: h.slice(c) };
};

test('U6a ①：runHtml 三欄——.runlayout 內依序 progressrail／runmain／sideinfo；左軌三顆 run-inspect、等你那步 active、每顆帶 stepPill；中欄 stopCardHtml 原樣（三鈕字串仍在）＋每個 .step 帶 data-steprow；右欄四個 sidefold，sup／data 有 open，標「目前這步」', () => {
  const h = u6Html();
  const { a, b, c, rail, main, side } = u6Cols(h);
  assert.ok(h.includes('<div class="runlayout">') && a > 0 && b > a && c > b, `三欄依序：${a}/${b}/${c}`);
  assert.ok(h.indexOf('<div class="runlayout">') < a, 'runlayout 包住三欄');
  assert.equal(count(rail, 'data-act="run-inspect"'), 3, `左軌三顆：${rail}`);
  assert.ok(rail.includes('<h5>這次的進度</h5>'), '左軌標題');
  assert.ok(/class="runstep active" data-act="run-inspect" data-node="n2"/.test(rail), `等你那步（n2）active：${rail}`);
  assert.equal(count(rail, 'class="runstep active"'), 1, '只有一顆 active');
  assert.ok(rail.includes('data-node="n1"') && rail.includes('data-node="n3"'), '三步都在');
  assert.equal(count(rail, 'chip wait'), 1, '左軌 n2 停點膠囊');
  assert.ok(rail.includes('停點') && rail.includes('完成'), '左軌每顆帶 stepPill');
  const st = u6State();
  const stop = uiFn('stopCardHtml', { ...CARD_STUBS, state: st })(st.run.def.nodes[1], st.run.steps.n2);
  assert.ok(main.includes(stop), '停點卡原文一字不改地出現在中欄');
  assert.deepEqual(btnsOf(stop), [['approve', '繼續'], ['start-edit', '編輯'], ['back', '稍後']], '三鈕仍在（不加第四鈕）');
  assert.equal(count(h, 'data-steprow="'), 3, `每個 .step 帶 data-steprow：${count(h, 'data-steprow="')}`);
  for (const id of ['n1', 'n2', 'n3']) assert.ok(main.includes(`data-steprow="${id}"`), `中欄 ${id} 列`);
  assert.equal(count(side, 'class="sidefold"'), 4, `右欄四格：${side}`);
  assert.ok(/<details class="sidefold" open><summary data-act="side-toggle" data-k="sup">/.test(side), 'sup 預設開');
  assert.ok(/<details class="sidefold" open><summary data-act="side-toggle" data-k="data">/.test(side), 'data 預設開');
  assert.ok(/<details class="sidefold"><summary data-act="side-toggle" data-k="focus">/.test(side), 'focus 預設關');
  assert.ok(/<details class="sidefold"><summary data-act="side-toggle" data-k="attempts">/.test(side), 'attempts 預設關');
  for (const w of ['監工交代', '這步會用到的資料', '驗收重點', '每次交卷']) assert.equal(count(side, w), 1, `右欄格標題「${w}」一次`);
  assert.ok(side.includes('目前這步') && side.includes('寫稿'), `右欄標「目前這步」＝等你那步的標題：${side}`);
  assert.ok(!side.includes('data-act="sup-toggle"') && !side.includes('data-act="mem-toggle"'), '右欄不重印卡片的監工交代／記憶（不共用 supOpen／memOpen）');
  assert.ok(h.indexOf('<nav class="crumbs"') < h.indexOf('<div class="tophead">') && h.indexOf('<div class="tophead">') < h.indexOf('<div class="runlayout">'), '麵包屑＋tophead＋sub 在 runlayout 之前（原樣）');
  const cur = uiFn('currentNodeOf');
  assert.equal(cur(st.run), 'n2', '目前這步＝第一個 waiting_*');
  assert.equal(cur(u6Run({ status: 'done', steps: { n1: { status: 'done' }, n2: { status: 'done' }, n3: { status: 'done' } } })), 'n3', '全完成＝最後一個 done');
  assert.equal(cur(u6Run({ steps: { n1: { status: 'done' }, n2: { status: 'running' }, n3: { status: 'pending' } } })), 'n2', '沒有停著的＝進行中那步');
});

test('U6a ②：waiting_check 的步——左軌琥珀「等你」、中欄那列「查核攔下」（checkChip）＋「等你」（stepPill）各一顆，checkCardHtml 原文在中欄（四鈕不動）；sideOpen.sup=false→sup 無 open、其餘照舊', () => {
  const steps = { n1: { status: 'done', output: '成品一' }, n2: { status: 'waiting_check', output: '成品二', check: { status: 'blocked', blocks: [{ text: '件數不對' }], flags: [], summary: '' } }, n3: { status: 'pending' } };
  const h = u6Html({ run: u6Run({ steps }) });
  const { rail, main } = u6Cols(h);
  assert.ok(/class="runstep active" data-act="run-inspect" data-node="n2"/.test(rail), '被攔那步 active');
  assert.ok(rail.includes('等你') && rail.includes('ph-hand-palm') && !rail.includes('查核攔下'), `左軌被攔那步印「等你」（U6b：字讓給 checkChip）：${rail}`);
  const st = u6State({ run: u6Run({ steps }) });
  const check = uiFn('checkCardHtml', { ...CARD_STUBS, state: st })(st.run.def.nodes[1], steps.n2);
  assert.ok(main.includes(check), '查核卡原文一字不改地在中欄');
  assert.equal(btnsOf(check).length, 4, '查核卡四鈕');
  const row = /<div class="step halt" data-steprow="n2"[\s\S]*?<\/span><\/div>/.exec(main)?.[0] ?? '';
  assert.equal(count(row, '查核攔下'), 1, `中欄被攔那列「查核攔下」只剩 checkChip 一顆：${row}`);
  assert.equal(count(row, '等你'), 1, `同列 stepPill 印「等你」：${row}`);
  const closed = u6Cols(u6Html({ sideOpen: { sup: false, data: true, focus: true, attempts: false } })).side;
  assert.ok(/<details class="sidefold"><summary data-act="side-toggle" data-k="sup">/.test(closed), 'sup 關');
  assert.ok(/<details class="sidefold" open><summary data-act="side-toggle" data-k="data">/.test(closed), 'data 仍開');
  assert.ok(/<details class="sidefold" open><summary data-act="side-toggle" data-k="focus">/.test(closed), 'focus 使用者開了就開');
});

test('U6a ③：舊 run（steps 無 memory／attempts／handoff、無 brief、def 無 supervisor）不炸且仍三欄；跑完的 run：這趟的紀錄與成品區都在中欄（不搬進側欄）、右欄「目前這步」＝最後一個 done', () => {
  const old = u6Run({ brief: undefined, def: { name: '舊', nodes: U6_NODES(), params: [] }, steps: { n1: { status: 'done', output: 'x' }, n2: { status: 'waiting_review', output: 'y' }, n3: { status: 'pending' } } });
  delete old.brief;
  const h = u6Html({ run: old });
  const { a, b, c } = u6Cols(h);
  assert.ok(a > 0 && b > a && c > b, '舊 run 三欄');
  assert.equal(count(h, 'class="sidefold"'), 4);
  const done = u6Run({ status: 'done', finished_at: '2026-09-15T10:30:00Z', record: null, steps: { n1: { status: 'done', output: 'a' }, n2: { status: 'done', output: 'b' }, n3: { status: 'done', output: 'c' } } });
  const hd = u6Html({ run: done });
  const { main, side } = u6Cols(hd);
  assert.ok(main.includes('這趟的紀錄') && main.includes('成品在這裡') && main.includes('id="run-feedback-input"'), '紀錄、成品、回饋框都在中欄');
  assert.ok(!side.includes('成品在這裡') && !side.includes('這趟的紀錄'), '側欄不放成品區');
  assert.ok(side.includes('定稿'), '右欄目前這步＝最後一個 done（n3 定稿）');
  assert.ok(hd.includes('全部完成'), '頂 pill 原樣');
});

test('U6a ④：接線原文——run-inspect 分支設 runInspect 後 render（U6c 接成歷史視圖，U6a 的 scroll 過渡反轉）；side-toggle 只記 state.sideOpen 不 render；state 三鍵；schedulePoll 不碰 runInspect／sideOpen；開跑／續跑／todo-go／cal-ev／back 都重設 runInspect', () => {
  const src = uiSrc();
  const branch = (act) => { const m = new RegExp(`act === '${act}'\\) \\{[\\s\\S]*?\\n    \\}`).exec(src); assert.ok(m, `分支 ${act}`); return m[0]; };
  const ri = branch('run-inspect');
  assert.ok(ri.includes('state.runInspect =') && ri.includes('render()'), `run-inspect 切歷史視圖（U6c）：${ri}`);
  const stg = branch('side-toggle');
  assert.ok(stg.includes('state.sideOpen[') && !stg.includes('render()'), `side-toggle 只記 state 不重繪：${stg}`);
  assert.ok(/sideOpen: \{ sup: true, data: true, focus: false, attempts: false \}/.test(src) && /\n  runInspect: null,/.test(src) && /\n  promptView: null,/.test(src), 'state 三鍵');
  const sp = /function schedulePoll\([\s\S]*?\n\}\n/.exec(src)[0];
  assert.equal(count(sp, 'runInspect') + count(sp, 'sideOpen'), 0, '輪詢只換 run，不動視圖狀態（地雷 4）');
  for (const act of ['back', 'todo-go', 'resume', 'cal-ev']) assert.ok(branch(act).includes('state.runInspect = null'), `${act} 重設 runInspect`);
  const start = /act === 'start' \|\| act === 'start-force'\) \{[\s\S]*?\n    \}/.exec(src)[0];
  assert.ok(start.includes('state.runInspect = null'), '開跑重設 runInspect');
  const rh = /function runHtml\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(rh.includes('<div class="runlayout">${progressRailHtml(run)}<section class="runmain">${main}</section>${sideInfoHtml(run)}</div>'), 'runHtml 三欄串');
  assert.ok(rh.includes('`${isDone ? recordHtml(run) : \'\'}${rows}${tail}`'), '紀錄＋rows＋tail 留中欄（現況分支）');
  const css = cssSrc();
  assert.ok(css.includes('.runlayout{display:grid;grid-template-columns:200px minmax(0,1fr) 250px'), 'CSS 三欄格');
  for (const s of ['.progressrail{', '.runstep{', '.runstep.active{', '.sideinfo{', '.sidefold{', '.sidefold>summary{']) assert.ok(css.includes(s), `CSS ${s}`);
  assert.ok(/@media \(max-width:1100px\)\{[^}]*\.runlayout\{grid-template-columns:1fr\}/.test(css), '1100 以下退單欄');
  assert.ok(/@media \(max-width:1100px\)\{[^}]*\.runlayout\{grid-template-columns:1fr\}[^@]*\.progressrail\{display:none\}/.test(css), '單欄時左軌隱藏');
  assert.ok(/\.progressrail,\.sideinfo\{position:sticky;top:76px;align-self:start;max-height:calc\(100vh - 96px\);overflow:auto/.test(css), '左右欄 sticky＋自捲');
});

test('U6a ⑤：五張卡函式（stopCardHtml／checkCardHtml／humanCardHtml／dataCardHtml／failCardHtml）＋editRulesHtml／recordHtml 原文與 HEAD 逐字相同；四張卡的 data-act 清單前後一致', () => {
  const head = execSync('git show HEAD:bojian/ui/app.js', { cwd: UI, encoding: 'utf8' });
  const fnOf = (src, name) => { const m = new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(src); assert.ok(m, `${name} 找得到`); return m[0]; };
  for (const f of ['stopCardHtml', 'checkCardHtml', 'humanCardHtml', 'dataCardHtml', 'failCardHtml', 'editRulesHtml', 'recordHtml']) assert.equal(fnOf(uiSrc(), f), fnOf(head, f), `${f} 原文與 HEAD 逐字相同`);
  const acts = (s) => [...s.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]).sort();
  for (const f of ['stopCardHtml', 'checkCardHtml', 'humanCardHtml', 'dataCardHtml']) assert.deepEqual(acts(fnOf(uiSrc(), f)), acts(fnOf(head, f)), `${f} data-act 清單前後相同`);
});

// ---------- U6b 移植合併輪：右欄接資料（這步會用到的資料／每次交卷／監工交代／當時指示浮窗共用） ----------
const U6B_SHARED = { company: [{ name: '手冊.md', chars: 20 }, { name: '語氣.md', chars: 9 }], dept: [{ name: '部門規範.md', chars: 7 }], refs: [{ scope: 'category', name: '往期.md', chars: 18 }] };
const u6bSteps = (n2 = {}) => ({ n1: { status: 'done', output: '成品一' }, n2: { status: 'waiting_review', output: '成品二', ...n2 }, n3: { status: 'pending' } });
const u6bData = (h) => /<summary data-act="side-toggle" data-k="data">[\s\S]*?<\/details>/.exec(u6Cols(h).side)?.[0] ?? '';

test('U6b ①：這步會用到的資料——有 memory.shared→「帶了公司規範 2 份・部門規範 1 份・參考 1 份」＋「哪幾份」四列（層・檔名・字數）；沒有→「這趟沒有共用檔紀錄」；有紀錄但全 0→一句；人做步驟不印「帶了」；來源一行讀 preflightFor；右欄不重印 memoryUsedHtml；卡上空態句有規範時不說「沒帶任何記憶」', () => {
  const withShared = u6bData(u6Html({ run: u6Run({ steps: u6bSteps({ memory: { cards: [], shared: U6B_SHARED } }) }) }));
  assert.ok(withShared.includes('帶了公司規範 2 份・部門規範 1 份・參考 1 份'), `帶了…行：${withShared}`);
  assert.equal(count(withShared, '<li>'), 4, `哪幾份四列：${withShared}`);
  for (const w of ['公司規範・手冊.md', '公司規範・語氣.md', '部門規範・部門規範.md', '部門參考・往期.md', '20 字', '18 字']) assert.ok(withShared.includes(w), `哪幾份含「${w}」：${withShared}`);
  assert.ok(!withShared.includes('mem-toggle') && !withShared.includes('class="used"') && !withShared.includes('沒帶任何記憶'), '右欄不重印 memoryUsedHtml（不共用 memOpen）');
  const none = u6bData(u6Html({ run: u6Run({ steps: u6bSteps() }) }));
  assert.ok(none.includes('這趟沒有共用檔紀錄') && !none.includes('帶了'), `舊 run 沒有 memory.shared：${none}`);
  const zero = u6bData(u6Html({ run: u6Run({ steps: u6bSteps({ memory: { cards: [], shared: { company: [], dept: [], refs: [] } } }) }) }));
  assert.ok(zero.includes('這步沒帶共用檔') && !zero.includes('帶了') && !zero.includes('這趟沒有共用檔紀錄'), `有紀錄但全 0：${zero}`);
  const human = u6bData(u6Html({ run: u6Run({ steps: { n1: { status: 'done' }, n2: { status: 'done', memory: { cards: [], shared: U6B_SHARED } }, n3: { status: 'waiting_human' } } }) }));
  assert.ok(!human.includes('帶了') && human.includes('這步由你處理'), `人做步驟不印「帶了」：${human}`);
  // 來源一行：健檢還沒回→「檢查中」；回了→照 inputs[node] 的 label 串；空→一句
  assert.ok(u6bData(u6Html()).includes('來源：檢查中'), '健檢還沒回');
  const pf = { inputs: { n2: [{ kind: 'upstream', id: 'n1', label: '上一步《收集》的產出' }, { kind: 'param', id: 'k', label: '設定欄位：期間' }, { kind: 'attachment', id: 'company:範本.docx', label: '參考檔：範本.docx（公司）' }] } };
  const src = u6bData(u6Html({}, { preflightFor: () => pf }));
  assert.ok(src.includes('來源：上一步《收集》的產出、設定欄位：期間、參考檔：範本.docx（公司）'), `來源一行：${src}`);
  assert.ok(u6bData(u6Html({}, { preflightFor: () => ({ inputs: { n2: [] }, unused_params: [] }) })).includes('來源：沒有指定輸入'), '沒有輸入');
  assert.ok(src.includes('data-srcline'), '來源一行帶 data-srcline（健檢回來只補這一行）');
  // 卡上「這步用了 N 條記憶」的空態：有規範／共用檔時不能說「沒帶任何記憶」（U1b 覆核 ⑩）
  const mu = uiFn('memoryUsedHtml', { state: { memOpen: {}, run: { workflow: { category: 'c' } } } });
  const node = { id: 'n2', title: '寫稿' };
  const ruleOnly = mu(node, { memory: { cards: [], overridden: [], paused: false, shared: U6B_SHARED } });
  assert.ok(!ruleOnly.includes('沒帶任何記憶') && ruleOnly.includes('右欄'), `有規範沒記憶卡：${ruleOnly}`);
  assert.ok(mu(node, { memory: { cards: [], overridden: [], paused: false } }).includes('這步沒帶任何記憶'), '沒規範也沒卡：原句');
  assert.ok(mu(node, { memory: { cards: [], overridden: [], paused: true, shared: U6B_SHARED } }).includes('整層暫停中'), '暫停句優先');
});

test('U6b ②：每次交卷——attempts 三筆→三列，reason 中文（第一次／重做／照你的話重做）＋checkChip；有交出檔的那筆帶成品 chip（走既有預覽）；無→「還沒交過卷」', () => {
  const attempts = [
    { at: '2026-09-15T10:01:00Z', reason: 'first', check: { status: 'blocked', blocks: [{ text: 'x' }], flags: [] } },
    { at: '2026-09-15T10:03:00Z', reason: 'retry', check: { status: 'blocked', blocks: [{ text: 'y' }], flags: [] } },
    { at: '2026-09-15T10:05:00Z', reason: 'retry-note', file: { name: '週報.docx', size: 12 }, check: { status: 'redo-pass', blocks: [], flags: [] } },
  ];
  const fileChipHtml = (cat, id, rid, name) => `<span class="chip filechip" data-act="preview-file" data-fname="${name}">${name}</span>`;
  const h = u6Html({ run: u6Run({ steps: u6bSteps({ attempts }) }) }, { fileChipHtml });
  const fold = /<summary data-act="side-toggle" data-k="attempts">[\s\S]*?<\/details>/.exec(u6Cols(h).side)[0];
  assert.equal(count(fold, 'class="attempt"'), 3, `三列：${fold}`);
  for (const w of ['第一次', '重做', '照你的話重做']) assert.ok(fold.includes(w), `原因「${w}」`);
  assert.equal(count(fold, '回話重做'), 0, '不用舊鈕名（T6① 禁用表）');
  assert.equal(count(fold, '查核攔下'), 2, '前兩筆 checkChip 查核攔下');
  assert.ok(fold.includes('重做過一次'), '第三筆 redo-pass');
  assert.equal(count(fold, 'data-act="preview-file" data-fname="週報.docx"'), 1, '有交出檔的那筆帶成品 chip');
  assert.ok(u6Html().includes('還沒交過卷'), '沒 attempts 一句');
});

test('U6b ③：監工交代——關→「這條流程沒開監工」一句；開→開場＋各步交接各一次（only_route 的不列）；開但都沒有→「監工還沒交代什麼」', () => {
  const fold = (h) => /<summary data-act="side-toggle" data-k="sup">[\s\S]*?<\/details>/.exec(u6Cols(h).side)[0];
  const off = fold(u6Html({ run: u6Run({ def: { name: '週報', nodes: U6_NODES(), params: [], supervisor: { enabled: false } } }) }));
  assert.ok(off.includes('這條流程沒開監工') && !off.includes('開場') && !off.includes('交接一'), `關：${off}`);
  const on = fold(u6Html());
  assert.equal(count(on, '開場'), 1, `開場一次：${on}`);
  assert.equal(count(on, '先守住件數'), 1);
  assert.equal(count(on, '交接一'), 1, '交接一次');
  const routed = fold(u6Html({ run: u6Run({ steps: { ...u6bSteps(), n1: { status: 'done', handoff: { text: '只判路', only_route: true } } } }) }));
  assert.ok(!routed.includes('只判路'), 'only_route 的交接不列');
  const empty = u6Run({ steps: u6bSteps() });
  delete empty.brief;
  assert.ok(fold(u6Html({ run: empty })).includes('監工還沒交代什麼'), '開但都沒有');
});

test('U6b ④：當時指示——promptModalHtml(view) 儀表板與執行頁共用（掛 .layout 外、舊字面 d.promptView 0 命中）；右欄底部 run-prompt 鈕（AI 步 n.txt、分岔 n-判路.txt、人做／還沒跑不印）；事件 run-prompt／prompt-close 接線、Esc、back 清掉', () => {
  const modal = uiFn('promptModalHtml');
  const m = modal({ title: '寫稿', text: '<x>' });
  assert.ok(m.startsWith('<div class="modalback" data-act="prompt-back">'), `.modalback 外殼：${m}`);
  assert.ok(m.includes('當時送出的指示——寫稿') && m.includes('class="promptpre"'), '標題與全文');
  assert.equal(count(m, 'data-act="prompt-close"'), 2, '關閉兩處（X＋按鈕）');
  assert.equal(modal(null), '', '沒開＝空');
  const src = uiSrc();
  assert.equal(count(src, 'd.promptView'), 0, '儀表板不再自己組浮窗');
  const dash = /function dashHtml\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(!dash.includes('promptpre') && !dash.includes('dash-prompt-back'), 'dashHtml 內沒有浮窗 markup');
  const renderLine = src.split('\n').find((l) => l.includes('app.innerHTML = hostAlert()'));
  assert.ok(renderLine && /previewHtml\(\).*promptModalHtml\(/.test(renderLine), `浮窗接在 .layout 後面那串：${renderLine}`);
  assert.ok(count(src, 'promptModalHtml(') >= 2, '定義＋render 呼叫');
  const branch = (act) => { const m2 = new RegExp(`act === '${act}'\\) \\{[\\s\\S]*?\\n    \\}`).exec(src); assert.ok(m2, `分支 ${act}`); return m2[0]; };
  const rp = branch('run-prompt');
  assert.ok(rp.includes('/prompts/') && rp.includes('state.promptView = {') && rp.includes('render()'), `run-prompt 抓卷宗→state.promptView→render：${rp}`);
  const close = src.split('\n').find((l) => l.includes("act === 'prompt-close'"));
  assert.ok(close && close.includes("'dash-prompt-close'"), `舊鍵 dash-prompt-close 與新鍵 prompt-close 同一站：${close}`);
  assert.ok(src.split('\n').some((l) => l.includes("e.key === 'Escape' && state.promptView")), 'Esc 關');
  assert.ok(branch('back').includes('state.promptView = null'), '回工作區清掉');
  // 右欄底部鈕
  const side = u6Cols(u6Html()).side;
  assert.ok(side.includes('data-act="run-prompt" data-pname="n2.txt"') && side.includes('當時指示'), `AI 步鈕：${side}`);
  const human = u6Cols(u6Html({ run: u6Run({ steps: { n1: { status: 'done' }, n2: { status: 'done' }, n3: { status: 'waiting_human' } } }) })).side;
  assert.ok(!human.includes('run-prompt'), '人做步驟不印');
  const notRun = u6Cols(u6Html({ runInspect: 'n3' })).side;
  assert.ok(!notRun.includes('run-prompt'), '還沒跑的步不印');
  const nodes = [{ id: 'n1', title: '收集', executor: 'ai', instruction: '做', next: ['b1'] }, { id: 'b1', title: '分', kind: 'branch', branches: [{ label: 'x', next: 'n3' }], next: [] }, { id: 'n3', title: '定稿', executor: 'ai', instruction: '做', next: [] }];
  const br = u6Cols(u6Html({ run: u6Run({ def: { name: '週報', nodes, params: [], supervisor: { enabled: true } }, steps: { n1: { status: 'done' }, b1: { status: 'waiting_branch' }, n3: { status: 'pending' } } }) })).side;
  assert.ok(br.includes('data-pname="b1-判路.txt"'), `分岔用判路卷宗：${br}`);
});

// ---------- U6c 移植合併輪：左軌點步驟＝歷史視圖（demo runPage 的 inspect）；回到目前；停著的歷史步 inert 唯讀 ----------
// mdBlock 給個看得見的假：印鍵＋原文，才斷得到「n1 的產出在 mdBlock 內」
const MD_STUB = { mdBlock: (t, key, cls = 'output') => `<div class="${cls}" data-mdkey="${key}">${t}</div>` };
const HIST_WORDS = ['data-act="run-current"', 'class="runbanner hist"', 'class="histcard" inert', '這一步的歷史'];

test('U6c ①：runInspect:null → 中欄＝U6a 現況（三步全列、停點卡三鈕在中欄）、整頁 0 命中 run-current／runbanner／histcard', () => {
  const h = u6Html({}, MD_STUB);
  const { main } = u6Cols(h);
  for (const w of HIST_WORDS) assert.equal(count(h, w), 0, `現況不帶歷史視圖字面 ${w}`);
  assert.equal(count(main, 'data-steprow="'), 3, '三步全列');
  const st = u6State();
  const stop = uiFn('stopCardHtml', { ...CARD_STUBS, ...MD_STUB, state: st })(st.run.def.nodes[1], st.run.steps.n2);
  assert.ok(main.includes(stop), '停點卡原文在中欄');
  assert.deepEqual(btnsOf(main), [['approve', '繼續'], ['start-edit', '編輯'], ['back', '稍後']], '三鈕可點（沒被 inert 包）');
});

test('U6c ②：runInspect:"n1"（n1 done、目前停在 n2）→ 橫幅 run-current＋「收集」、只有 n1 一列、n1 產出在 mdBlock（鍵 hist:n1）、不含停點卡三鈕、不含 recordHtml／tail；edited_output→「你改過的版本」；done 步的 editRulesHtml 照印；左軌 active＝n1、右欄目前這步跟著換', () => {
  const h = u6Html({ runInspect: 'n1' }, MD_STUB);
  const { rail, main, side } = u6Cols(h);
  assert.equal(count(main, 'data-act="run-current"'), 1, `橫幅一顆回到目前：${main}`);
  assert.ok(main.includes('class="runbanner hist"') && main.includes('你在看「收集」這一步的歷史') && main.includes('回到目前'), `橫幅字：${main}`);
  assert.ok(main.indexOf('class="runbanner hist"') < main.indexOf('data-steprow="n1"'), '橫幅在最上面');
  assert.equal(count(main, 'data-steprow="'), 1, '只印那一步');
  assert.ok(main.includes('data-steprow="n1"'), 'n1 那列');
  assert.ok(main.includes('data-mdkey="hist:n1">成品一<'), `n1 產出在 mdBlock 內、鍵 hist:n1：${main}`);
  assert.ok(!main.includes('成品二'), '不印 n2 的產出');
  for (const b of ['data-act="approve"', 'data-act="start-edit"', 'data-act="back"', 'histcard']) assert.equal(count(main, b), 0, `歷史視圖不帶 n2 的停點卡：${b}`);
  assert.ok(!main.includes('你改過的版本'), '沒改過就不標');
  assert.ok(/class="runstep active" data-act="run-inspect" data-node="n1"/.test(rail) && count(rail, 'class="runstep active"') === 1, `左軌 active＝看的那步：${rail}`);
  assert.ok(side.includes('目前這步') && side.includes('收集') && !side.includes('寫稿'), `右欄跟著看的那步：${side}`);
  // 改過的版本優先＋標字
  const edited = u6Run(); edited.steps.n1.edited_output = '改過的';
  const he = u6Cols(u6Html({ runInspect: 'n1', run: edited }, MD_STUB)).main;
  assert.ok(he.includes('你改過的版本') && he.includes('data-mdkey="hist:n1">改過的<') && !he.includes('>成品一<'), `edited_output 優先並標字：${he}`);
  // done 步的「後面每步會守」照印（可編輯，不在 inert 內）
  const ruled = u6Run(); ruled.steps.n1.edit_rules = [{ text: '守這條', scope: 'all' }];
  const hr = u6Cols(u6Html({ runInspect: 'n1', run: ruled }, MD_STUB)).main;
  assert.ok(hr.includes('後面每步會守') && hr.includes('data-act="edit-rules-open" data-node="n1"') && !hr.includes('inert'), `editRulesHtml 在歷史視圖照印：${hr}`);
  // 跑完的 run 看歷史步：紀錄、成品區、回饋框都不印
  const done = u6Run({ status: 'done', finished_at: '2026-09-15T10:30:00Z', record: null, steps: { n1: { status: 'done', output: 'a' }, n2: { status: 'done', output: 'b' }, n3: { status: 'done', output: 'c' } } });
  const hd = u6Cols(u6Html({ runInspect: 'n1', run: done }, MD_STUB)).main;
  assert.ok(!hd.includes('這趟的紀錄') && !hd.includes('成品在這裡') && !hd.includes('run-feedback-input') && hd.includes('data-mdkey="hist:n1">a<'), `跑完的 run 歷史視圖不印 recordHtml／tail：${hd}`);
});

test('U6c ③：runInspect ＝目前停著的 n2 → 輸出與 ① 完全相同（不算歷史）', () => {
  assert.equal(u6Html({ runInspect: 'n2' }, MD_STUB), u6Html({}, MD_STUB), '點目前這步＝現況');
  assert.equal(count(u6Html({ runInspect: 'n2' }, MD_STUB), 'data-act="run-current"'), 0);
});

test('U6c ④：並行支線——n3 waiting_review 但目前這步是 n2，runInspect:"n3" → stopCardHtml(n3) 原文出現在 <div class="histcard" inert> 內、三顆 data-act 仍在（卡片未改）、含「回到目前才能操作」', () => {
  const steps = { n1: { status: 'done', output: '成品一' }, n2: { status: 'waiting_review', output: '成品二', check: { blocks: [], summary: '' } }, n3: { status: 'waiting_review', output: '成品三', check: { blocks: [], summary: '' } } };
  const st = u6State({ runInspect: 'n3', run: u6Run({ steps }) });
  assert.equal(uiFn('currentNodeOf')(st.run), 'n2', '目前這步仍是 n2');
  const h = u6Html({ runInspect: 'n3', run: u6Run({ steps }) }, MD_STUB);
  const { main } = u6Cols(h);
  const stop = uiFn('stopCardHtml', { ...CARD_STUBS, ...MD_STUB, state: st })(st.run.def.nodes[2], steps.n3);
  const inertBlock = /<div class="histcard" inert>[\s\S]*?<\/div>\s*<p class="note histnote">/.exec(main)?.[0] ?? '';
  assert.ok(inertBlock.includes(stop), `停點卡原文一字不改地在 inert 塊內：${main}`);
  assert.equal(count(main, 'class="histcard" inert'), 1, '只包一塊');
  assert.deepEqual(btnsOf(inertBlock), [['approve', '繼續'], ['start-edit', '編輯'], ['back', '稍後']], '三顆 data-act 仍在、數量＝3（不逐顆 disabled）');
  assert.equal(count(inertBlock, 'disabled'), 0, '沒有逐顆 disabled');
  assert.ok(main.includes('回到目前才能操作'), 'note 一句');
  assert.ok(main.includes('你在看「定稿」這一步的歷史') && count(main, 'data-steprow="') === 1 && main.includes('data-steprow="n3"'), '橫幅＋只印 n3 那列');
  assert.ok(!main.includes('成品二'), 'n2 的停點卡不印');
  // 中欄 n2 的卡在現況（runInspect:null）仍可點：確認 inert 只在歷史視圖出現
  assert.equal(count(u6Html({ run: u6Run({ steps }) }, MD_STUB), 'inert'), 0, '現況不包 inert');
});

test('U6c ⑤：接線原文——schedulePoll 0 命中 runInspect；run-current 分支 runInspect = null＋render()；run-inspect 分支改成設 runInspect＋render()（U6a ④ 的過渡反轉）；runInspect 指到不存在／fork／pending 節點→不炸；CSS .runbanner.hist、.histcard[inert]', () => {
  const src = uiSrc();
  const sp = /function schedulePoll\([\s\S]*?\n\}\n/.exec(src)[0];
  assert.equal(count(sp, 'runInspect'), 0, '輪詢只換 run，不動視圖狀態（地雷 4）');
  const branch = (act) => { const m = new RegExp(`act === '${act}'\\) \\{[\\s\\S]*?\\n    \\}`).exec(src); assert.ok(m, `分支 ${act}`); return m[0]; };
  const rc = branch('run-current');
  assert.ok(rc.includes('state.runInspect = null') && rc.includes('render()'), `run-current：${rc}`);
  const ri = branch('run-inspect');
  assert.ok(ri.includes('state.runInspect =') && ri.includes('render()') && !ri.includes('scrollIntoView'), `run-inspect 改成切視圖：${ri}`);
  assert.ok(ri.includes('currentNodeOf'), '點目前這步不進歷史（存 null 而不是存目前那步的 id，免得跑到下一步時彈成歷史）');
  assert.equal(count(src, "keepKey('runInspect')") + count(src, 'keep.runInspect'), 0, 'runInspect 不進 state.keep');
  // 不存在的節點：不炸、退回 null、輸出同現況
  const st = u6State({ runInspect: 'ghost' });
  const ghost = uiFn('runHtml', { ...CARD_STUBS, ...MD_STUB, preflightFor: () => null, state: st })();
  assert.equal(ghost, u6Html({}, MD_STUB), '找不到節點＝現況');
  assert.equal(st.runInspect, null, '找不到節點退回 null');
  // 還沒開始的步：左軌鈕照 demo 灰掉（disabled、title「還沒跑到」），done／目前這步不灰（U6c 覆核該修）；歷史視圖那條路（鍵盤導航仍可到）不炸、橫幅在、一句「還沒開始」、沒有產出格
  const { rail: r0, main: pend } = u6Cols(u6Html({ runInspect: 'n3' }, MD_STUB));
  assert.ok(/<button class="runstep[^"]*" data-act="run-inspect" data-node="n3" title="還沒跑到" disabled>/.test(r0), `pending 步鈕 disabled：${r0}`);
  assert.ok(/<button class="runstep[^"]*" data-act="run-inspect" data-node="n1" title="收集">/.test(r0) && /data-node="n2" title="寫稿">/.test(r0), `done／目前這步不 disabled：${r0}`);
  assert.equal(count(r0, ' disabled'), 1, '只有未來步灰掉');
  assert.ok(pend.includes('data-act="run-current"') && pend.includes('data-steprow="n3"') && pend.includes('還沒開始') && !pend.includes('data-mdkey="hist:n3"'), `pending 步：${pend}`);
  const rDone = u6Cols(u6Html({ run: u6Run({ status: 'done', steps: { n1: { status: 'done', output: 'a' }, n2: { status: 'done', output: 'b' }, n3: { status: 'done', output: 'c' } } }) }, MD_STUB)).rail;
  assert.equal(count(rDone, ' disabled'), 0, '全做完＝三顆都可點');
  assert.ok(cssSrc().includes('.runstep:disabled{'), 'CSS 灰掉');
  // fork／join 節點不當歷史步
  const nodes = [{ id: 'n1', title: '收集', executor: 'ai', instruction: '做', next: ['f1'] }, { id: 'f1', title: '分頭', kind: 'fork', next: ['n2'] }, { id: 'n2', title: '寫稿', executor: 'ai', instruction: '做', next: [] }];
  const stf = u6State({ runInspect: 'f1', run: u6Run({ def: { name: '週報', nodes, params: [], supervisor: { enabled: true } }, steps: { n1: { status: 'done', output: 'a' }, f1: { status: 'done' }, n2: { status: 'waiting_review', output: 'b', check: { blocks: [], summary: '' } } } }) });
  const hf = uiFn('runHtml', { ...CARD_STUBS, ...MD_STUB, preflightFor: () => null, state: stf })();
  assert.equal(count(hf, 'data-act="run-current"'), 0, 'fork 不算一步');
  assert.equal(stf.runInspect, null);
  const css = cssSrc();
  assert.ok(css.includes('.runbanner.hist{') && css.includes('.histcard[inert]{'), 'CSS 兩條');
});
