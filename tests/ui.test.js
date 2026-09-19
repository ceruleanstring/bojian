// 前端（ui/app.js、ui/style.css）測試：讀原文做字串斷言＋用 node:vm 把單一頂層函式切出來跑（移植第一批 T4 起）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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
test('T4 皮①：紙面 token 純色——--wp／--hairline／--m1〜m4-bg／--paper-rail（拆法輪 P1 改冷灰藍，契約 G）', () => {
  const css = cssSrc();
  assert.ok(css.includes('--wp:#f3f5fa'), '--wp 該是冷灰藍 #f3f5fa（DEMO --paper）');
  assert.ok(css.includes('--hairline:#dbe1ec'), '--hairline 該是 #dbe1ec（DEMO --line）');
  assert.ok(css.includes('--m1-bg:#edf0f7'), '--m1-bg（側欄）該是 #edf0f7（DEMO --side）');
  assert.ok(css.includes('--m2-bg:#ffffff'), '--m2-bg（頂欄）該是純白');
  assert.ok(css.includes('--m3-bg:#ffffff'), '--m3-bg（卡片／work）該是純白');
  assert.ok(css.includes('--m4-bg:#ffffff'), '--m4-bg（抽屜／浮窗）該是純白');
  assert.ok(css.includes('--paper-rail:#eef1f7'), '--paper-rail 該是 #eef1f7（DEMO --soft）');
});

test('T4 皮②：漸層底 0 命中；--m1-f〜--m4-f 各一個 none（去玻璃）', () => {
  const css = cssSrc();
  assert.equal(count(css, 'radial-gradient(120%'), 0, 'radial-gradient(120% 該清掉');
  assert.equal(count(css, 'linear-gradient(158deg'), 0, 'linear-gradient(158deg 該清掉');
  for (const k of ['--m1-f', '--m2-f', '--m3-f', '--m4-f']) assert.equal(count(css, `${k}:none`), 1, `${k}:none 該剛好一個`);
  assert.equal(count(css, 'blur('), 1, '硬編 blur( 該清掉（.cvdrawer 原本自帶 blur(16px)，8788 實走抓到，改走 --m4）；排版輪 L10：樣稿步驟彈窗背景霧化恰一處');
  assert.ok(cssRule('.stepmodal')?.includes('blur('), `排版輪 L10：唯一的 blur( 在 .stepmodal：${cssRule('.stepmodal')}`);
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
  assert.ok(skipped.every((s) => /^app:/.test(s)), `只准跳過 app 一個 DOM 常數（排版輪 L3 頂欄退場刪 hostdot）：${skipped.join('；')}`);
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
  for (const sel of ['.step.halt::before', '.step.errstep::before', '.cev.missed::before', '.cev.makeup::before', '.item.err::before', '.item.hold::before', '.item.warn::before']) {
    assert.equal(count(css, sel), 1, `${sel} 該留`);
  }
  assert.equal(count(css, '.node.hold::before'), 0, '排版輪 L14（款 A）：畫布卡無色條，停點改卡內小手');
  assert.ok(cssRule('.node.human')?.includes('border-color:#e6cfa6'), `排版輪 L14（款 A）：人做卡＝琥珀框：${cssRule('.node.human')}`);
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
  const rows = stepListHtml(def).split('<article class="step').slice(1); // 排版輪 L8：清單卡 div→article
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

// ---------- T6 文案 A：卡片鈕、記憶卡標籤、抽屜標籤、零碎短詞化（ 1、2、3、6 組；不碰 src） ----------
const T6_SCAN = ['我改一下', '回話重做', '就這樣過', '先放著', '晚點回來', '我補給你', '就用現有的做', '我處理好了', '重抓一次',
  '誰說的', '怎麼用', '從哪來', '做完給你看', 'AI 來做', '你來做', '開跑時會拿到', '這次的設定', '先跳過', '自動補跑（不勾',
  '問我補不補', '常用⋯', '存常用', '要你看一眼', '記住這三條', '存進去', '清掉重來', '存起來', '只有這一步', '重試這步',
  '用改過的版本往下', '取消，不改了'];
// 例外表（-1：note／title／描述句不改）：命中行必含這些字面之一；表上的字面若已不存在也紅，免得例外表變殭屍
const T6_SCAN_ALLOW = {
  '你來做': ['title="這步你來做，完成後回報一句"', '（你來做）交出的內容'], // :650 步驟 title 提示句；:1072 抽屜輸入清單描述句
  '要你看一眼': ['需要你看一眼的'], // :2551 設定→記憶 h5 段標；:2552 note
  '存起來': ['上面寫幾條存起來'], /* 排版輪 L7：規矩收進守則卡下方，左邊→上面；排版輪 L8：清單頂「這份 Workflow 會存起來…」提示句退場（工具列「準備執行」取代） */// :2255 note
  '從哪來': ['<h3>資料從哪來</h3>', '成品長相卡（樣稿 uxProductCard）'], // 成品卡小表標題＝設計 §五-1 定名「資料從哪來」（批准的文案）；一處標題（ h5→樣稿 h3）＋函式頭註解
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
  assert.equal(ks(habit)[2][1], '全部 Workflow', '「範圍」值仍走 memScopeText');
  const group = uiFn('memCardModalHtml', { state: { memModal: { id: 'g-1', bucket: 'group', card: { id: 'g-1', text: '不用簡體', field: null, value: null, category: '旅遊' }, err: null, busy: false }, keep: {}, run: null } })();
  assert.deepEqual(ks(group).map((x) => x[0]), ['來自', '用法', '範圍', '來源'], `群組卡標籤：${ks(group)}`);
  assert.equal(ks(group)[0][1], '分類・旅遊', '群組卡「來自」印「分類・X」（契約 D5；排版輪 L2 換字）');
});

test('T6 ④：「用在哪」只剩註解與詞典「用在哪些流程」；src/memory.js 的驗證訊息原封不動', () => {
  const hits = uiSrc().split('\n').map((ln, i) => [i + 1, ln]).filter(([, ln]) => ln.includes('用在哪'));
  assert.ok(hits.length >= 2, `該至少剩註解＋詞典表頭：${hits.map((h) => h[0])}`);
  for (const [no, ln] of hits) assert.ok(ln.trim().startsWith('//') || ln.includes('用在哪些 Workflow'), `「用在哪」@${no} 既不是註解也不是詞典「用在哪些 Workflow」：${ln.trim().slice(0, 90)}`);
  const mem = fs.readFileSync(path.join(UI, '..', 'src', 'memory.js'), 'utf8');
  assert.ok(mem.includes('用在哪只能是全部、分類、Workflow'), 'src/memory.js:21 驗證訊息只准照排版輪 L2 換字（memory.test／server.test 有斷言）');
});

test('T6 ⑤：抽屜／流程頁／零碎：AI 執行／人工、停點、輸入來源、本次資料、常用片段⋯×4、存為片段、錯過時、記憶待整理', () => {
  const src = uiSrc();
  assert.ok(src.includes(`id="cv-human" \${!isAI ? 'checked' : ''}>你來處理</label>`), '抽屜執行者（排版輪 L10：下拉 AI 執行／人工→勾選「你來處理」）');
  assert.ok(src.includes(`id="cv-stop" \${n.stop_point === 'always' ? 'checked' : ''}>完成後停點</label>`), '抽屜勾選「停點」（排版輪 L10：樣稿字「完成後停點」）');
  assert.equal(count(src, '<span class="lb">輸入來源：</span>'), 2, '抽屜「輸入來源」兩處（檢查中＋清單；排版輪 L10：overline 改一行灰字）');
  assert.ok(src.includes('<h3>${title}${hint(sub)}</h3>') && src.includes("box('填寫這次的值'"), '流程頁本次資料標題（分頁結構歸 T10；調整輪：整頁 h3「這次的值」→任務卡展開區標題「填寫這次的值」，標題由 .focus-editor header 統一印）');
  assert.equal(count(src, '<option value="">常用片段⋯</option>'), 3, '常用片段⋯：模板＋JS 重繪兩處');
  assert.ok(src.includes("window.alert('先在「常用片段⋯」裡選一個要刪的')"), 'alert 句跟著改名');
  assert.ok(src.includes('<i class="ph ph-star"></i>存為片段</span>'), '存常用→存為片段');
  assert.ok(src.includes('<span class="lb2">錯過時</span>') && src.includes('>自動補（不勾＝先詢問）</label>'), '新增排程視窗：列標題「錯過時」＋勾選字「自動補（不勾＝先詢問）」（同列不念兩次錯過）');
  assert.equal(count(src, '錯過的時候'), 0, '舊列標題「錯過的時候」清掉');
  assert.ok(src.includes('setRow(`錯過時${hint('), '設定→執行與排程 列標題「錯過時」（說明文案輪：說明搬進標題旁的問號）');
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
  assert.equal(count(g, '用在哪只能是全部、分類、Workflow'), 1, '記憶卡列的驗證訊息原話留著（對應 src/memory.js）');
});

// ---------- T7 文案 B 第 5 組：「分類守則」統一（UI 四處＋src 三段字串＋測試同步） ----------
// 舊字用兩截拼起來，免得本檔自己被 grep -rn 三目錄掃到（完成定義：三字串在 ui／src／tests 0 命中）
const T7_OLD = [['這類流程', '要守的'], ['這類流程', '都要守的'], ['這個分類', '要守的'], ['這類 Workflow ', '要守的'], ['這類 Workflow ', '都要守的'], ['這個部門', '要守的']].map((p) => p.join('')); // 後三＝ 新字版本
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
  const h5 = /<h3>(.*?)<\/h3>/.exec(html)?.[1]; // 守則卡標題 h5→h3「分類守則」（樣稿 .guidelines h3）
  assert.equal(h5, '分類守則', `分類頁第一個 h3：${h5}`);
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
  assert.ok(g.includes('\n| 群組圈／群組規矩／分類守則 | category scope / group rules |'), '群組圈列中文欄（排版輪 L2 換字；AI 段標題「# 分類守則」不改）');
  assert.ok(g.includes('「# 關於你」「# 分類守則」兩段'), '卷宗列');
  assert.ok(g.includes('「# 分類守則（分類「X」，一定要守）」插在限制條件後'), '常駐段列（段標題與 host-adapter 同字）');
  for (const w of T7_OLD) assert.equal(count(g, w), 0, `GLOSSARY 舊字「${w}」該 0 命中`);
});

// ---------- T8 設定頁：三分頁改名、關於你層級、監工搬家、錯過時 ----------
test('T8 ①：SET_TABS 三組改名；「地圖與例外」「連接器與保險箱」「保險箱」「錯過的排程」「自動補跑」在 app.js 0 命中；儀表板「去看」跳記憶總覽', () => {
  const src = uiSrc();
  for (const w of ['地圖與例外', '連接器與保險箱', '保險箱', '錯過的排程', '自動補跑']) assert.equal(count(src, w), 0, `「${w}」該 0 命中`);
  // 只有「個人與記憶」留四分頁；連線、素材庫的子分頁退場（連線改單頁分段、素材庫搬共用素材頁）
  assert.ok(src.includes("const SET_TABS = { 個人與記憶: ['關於你', '身分', '記憶總覽', '欄位詞典'] };"), '個人與記憶四分頁（SET_TABS 只剩這組）');
  assert.equal(count(src, "連線: ['Claude', 'Google 行事曆']"), 0, '連線不再分頁');
  assert.equal(count(src, "素材庫: ['角色情境', '常用片段']"), 0, '素材庫組退場');
  assert.ok(src.includes("openSettings('個人與記憶', '記憶總覽')"), '儀表板「去看」');
  assert.ok(src.includes("tab === '身分' ? setIdentitiesHtml(d) : tab === '記憶總覽' ? setMapHtml(d) : tab === '欄位詞典' ? setDictHtml(d) : setKnowHtml(d)"), '個人與記憶分派');
  assert.ok(src.includes("act === 'intro-open'"), '關於你頁「介紹你自己」鈕的事件');
});

const t8DefCtx = (tab) => ({ state: { settings: { tab: {}, busy: null }, claude: true }, setTab: () => tab });
// 設定各組改同一張卡分段（h3）；切出某一段＝從 <h3>段名</h3> 到下一個 <h3>
const secOf = (html, t) => { const i = html.indexOf(`<h3>${t}</h3>`); assert.ok(i >= 0, `該有分段 <h3>${t}</h3>`); const j = html.indexOf('<h3>', i + 4); return html.slice(i, j < 0 ? undefined : j); };
test('T8 ②：新流程的預設——監工總開關與三勾搬到「權限與查核」（數字對原始資料之後）；「AI 步驟」0 命中監工；停點句', () => {
  const all = uiFn('setDefaultsHtml', t8DefCtx('權限與查核'))({ cfg: { defaults: {} } });
  const perm = secOf(all, '權限與查核');
  assert.ok(perm.includes('<h5>監工</h5>') && perm.includes('data-k="supervisor_enabled"'), '監工總開關');
  assert.equal(count(perm, 'data-act="set-def-flag"'), 3, '三勾 pill');
  assert.ok(perm.indexOf('數字對原始資料') < perm.indexOf('<h5>監工</h5>'), '監工在數字對原始資料之後');
  const ai = secOf(all, 'AI 步驟');
  assert.equal(count(ai, '監工'), 0, 'AI 步驟不再有監工');
  assert.ok(ai.includes('模型檔位') && ai.includes('出錯自動重試'), 'AI 步驟留模型與重試');
  const stop = secOf(all, '停點');
  // 這一列沒有任何可操作的東西，作用是指路，所以話留在畫面上——但要講完整
  assert.ok(stop.includes('哪幾步要停下來等你，在每個步驟自己的設定裡改，不在這一頁。'), '停點指路句');
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
  // （09-19 裁示：「記敏感資訊的可以合成一欄」）：四列各印一次同樣的小字→合成一列，說明只講一次
  assert.equal(count(html, 'data-act="set-sens"'), 4, '四類還是四個可點項');
  assert.equal(count(html, '記敏感資訊'), 1, '合成一列');
  for (const t of ['記健康', '記政治', '記宗教', '記財務']) assert.ok(!html.includes(t), `「${t}」自成一列的寫法退場`);
  assert.equal(count(html, '預設不記。打開＝只記你親口說的。'), 0, '重複四次的小字退場');
  assert.ok(html.includes('class="pill on" data-act="set-sens" data-k="health" aria-pressed="true"'), 'health 開');
  assert.ok(html.includes('class="pill" data-act="set-sens" data-k="politics" aria-pressed="false"'), 'politics 關');
  assert.ok(/記敏感資訊<button type="button" class="hint"[^>]*data-hint="[^"]*預設都不記[^"]*"/.test(html), '說明收進問號，只出現一次');
  // 身分從「關於你」拆出成自己的分頁（原收在 details 裡）
  assert.equal(count(html, 'data-fold="identity"') + count(html, 'data-act="id-add"'), 0, '關於你不再帶身分段');
  const idTab = uiFn('setMemoryHtml', { ...ctx, state: { ...ctx.state, settings: { idEdit: null, tab: { 個人與記憶: '身分' } } } })({ cfg: { memory: {} }, cards, identities: [] });
  assert.ok(idTab.includes('身分') && idTab.includes('data-act="id-add"'), '身分分頁有身分段與新增');
  assert.ok(idTab.indexOf('data-act="set-tab"') < idTab.indexOf('data-act="id-add"'), '身分段在分頁鈕之後');
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
  // 連接器與金鑰搬到「連線」分段；欄位詞典改「個人與記憶→欄位詞典」分頁；素材庫改共用素材整頁
  const keys = uiFn('setConnHtml', { state: { settings: { busy: null, msg: null }, claude: true }, memAt: () => '' })({ snapshot: null });
  assert.equal(count(secOf(keys, '連接器與金鑰'), '尚未提供'), 2);
  assert.ok(keys.includes('連接器與金鑰') && keys.includes('雲端硬碟、信箱'));
  const dict = uiFn('setMemoryHtml', { state: { settings: { merge: null, tab: { 個人與記憶: '欄位詞典' } } } })({ dict: { fields: [{ name: '語氣', kind: 'appearance', synonyms: ['口吻'], origin: 'factory' }], usage: {} }, cards: [] });
  assert.ok(dict.includes('<table class="dict"') && dict.includes('<b>語氣</b>') && !dict.includes('<details data-fold="dict"'), '詞典是分頁內容、表格照舊（不再收摺）');
  const assets = uiFn('assetsHtml', { state: { assets: { tab: '全部', edit: null, err: null }, presets: { role_context: [], snippet: [] } } })();
  assert.ok(assets.includes('data-act="asset-new"') && !assets.includes('data-act="id-add"'), '共用素材頁沒有身分');
});

// ---------- T9 側欄：四全域項、分類樹收合（文字開頁／箭頭收合）、流程庫頁 ----------
// 側欄草稿列改判 draftLive()（讀 state.chat），假 state 補上空的 chat
const t9Side = (extra = {}) => uiFn('sideHtml', { state: { categories: ['旅遊'], workflows: [{ id: 'a', name: 'A', category: '旅遊' }], trash: [], notices: { unread: [] }, catClosed: new Set(), categoryPage: null, wf: null, calendar: null, settings: null, library: null, dash: null, addingCategory: false, chat: emptyChatLike(), ...extra }, subjectIsDraft: () => false })();
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
  // （驗收第 2 條）：建立留側欄；匯入與垃圾桶搬到 Workflow 庫——側欄不再有
  assert.ok(html.includes('data-act="new-flow"') && !html.includes('data-act="pick-import"') && !html.includes('data-act="view-trash"'), '建立在側欄、匯入與垃圾桶不在側欄');
  // 入口在 Workflow 庫頁（右上「匯入」、工具列「垃圾桶（N）」）
  const lib = uiFn('libraryHtml', { state: { categories: ['旅遊'], workflows: [], trash: [{}], library: { q: '', cat: '' } } })();
  assert.ok(lib.includes('data-act="pick-import"') && lib.includes('data-act="view-trash"'), '匯入與垃圾桶入口在 Workflow 庫頁');
});

test('T9 ②：catClosed 含分類→details 無 open；正在看的分類 summary aria-current="page" 且強制 open', () => {
  const closed = t9Side({ catClosed: new Set(['旅遊']) });
  assert.ok(closed.includes('<details class="cat" data-cat="旅遊" >') && !closed.includes('data-cat="旅遊" open>'), '收合');
  const now = t9Side({ catClosed: new Set(['旅遊']), categoryPage: { category: '旅遊' } });
  assert.ok(now.includes('<details class="cat" data-cat="旅遊" open>'), '看著的分類強制展開');
  assert.ok(now.includes('<summary class="nm now" aria-current="page"'), 'summary aria-current');
});

const t9Lib = (library) => uiFn('libraryHtml', { state: { categories: ['旅遊', '工作'], workflows: [{ id: 'a', name: 'A 報告', category: '旅遊' }, { id: 'b', name: 'B 週報', category: '工作' }, { id: 'c', name: 'C', category: '旅遊' }], trash: [], library } })();
test('T9 ③：流程庫頁——三張卡、搜尋只剩 1、分類過濾、卡上「打開」走既有 open、空→還沒有流程', () => {
  const all = t9Lib({ q: '', cat: '' });
  assert.equal(count(all, 'class="flowcard"'), 3);
  assert.ok(all.includes('id="lib-search"') && all.includes('<option value="" selected>全部</option>') && all.includes('<option value="旅遊" >旅遊</option>'), '搜尋框與分類下拉（排版輪 L5：膠囊 lib-cat→下拉 lib-dept）');
  assert.equal(count(t9Lib({ q: 'A', cat: '' }), 'class="flowcard"'), 1, '搜尋');
  const cat = t9Lib({ q: '', cat: '旅遊' });
  assert.equal(count(cat, 'class="flowcard"'), 2, '分類過濾');
  assert.ok(cat.includes('<option value="旅遊" selected>旅遊</option>'), '下拉選中目前分類');
  assert.ok(!cat.includes('B 週報'));
  assert.ok(cat.includes('data-act="open" data-cat="旅遊" data-id="a"'), '卡上「打開」');
  assert.ok(uiFn('libraryHtml', { state: { categories: [], workflows: [], trash: [], library: { q: '', cat: '' } } })().includes('還沒有 Workflow'));
  assert.ok(t9Lib({ q: 'zzz', cat: '' }).includes('沒有符合的 Workflow'));
});

test('T9 ④：每個 closeSettings() 呼叫站都配 closeLibrary(); closeAssets();（地雷 6，排版輪 L6 擴成三連）；openSettings／openLibrary 也關共用素材；closeLibrary／closeAssets 只定義一次', () => {
  const src = uiSrc().replace(/function openLibrary\(\) \{[\s\S]*?\n\}\n/, '');
  assert.equal(count(src, 'closeSettings(); closeLibrary(); closeAssets();'), count(src, 'closeSettings();'), '每站都配三連');
  assert.ok(count(src, 'closeSettings();') >= 12, `呼叫站 ${count(src, 'closeSettings();')}`);
  const os = /async function openSettings\([\s\S]*?\n\}\n/.exec(uiSrc())[0];
  assert.ok(os.includes('closeLibrary();') && os.includes('closeAssets();'), 'openSettings 關流程庫與共用素材');
  assert.ok(/function openLibrary\(\) \{[\s\S]*?closeAssets\(\);[\s\S]*?\n\}\n/.test(uiSrc()), 'openLibrary 關共用素材');
  assert.equal(count(uiSrc(), 'function closeLibrary()'), 1);
  assert.equal(count(uiSrc(), 'function closeAssets()'), 1);
});

test('T9 ⑤：「我的流程庫」在 app.js 0 命中；CSS 有 details 去標記與箭頭旋轉、libgrid／libcard', () => {
  assert.equal(count(uiSrc(), '我的流程庫'), 0);
  const css = cssSrc();
  for (const r of ['.side details.cat>summary.nm{list-style:none}', '.cat:not([open]) .catcaret{transform:rotate(-90deg)}', '.libgrid{', '.flowcard{']) assert.ok(css.includes(r), r);
});

test('T9 ⑥：render 的 state.library 判在 state.settings 之後、state.categoryPage 之前；搜尋 input 只換 #lib-grid；事件 open-library／cat-toggle／lib-cat 都在', () => {
  const src = uiSrc();
  const a = src.indexOf('else if (state.settings) inner = settingsHtml()'), b = src.indexOf('else if (state.library) inner = libraryHtml()'), c = src.indexOf('else if (state.categoryPage) inner = categoryPageHtml()');
  assert.ok(a > 0 && a < b && b < c, `順序 ${a} ${b} ${c}`);
  assert.ok(src.includes("t.id === 'lib-search'") && src.includes("getElementById('lib-grid')"), '搜尋只換卡片格');
  for (const w of ["act === 'open-library'", "act === 'cat-toggle'", "e.target.id === 'lib-dept'"]) assert.ok(src.includes(w), w);
  const oc = /else if \(act === 'open-category'\) \{[\s\S]*?render\(\);/.exec(src)[0];
  assert.ok(oc.includes('e.preventDefault()'), '點文字不觸發 details 原生切換');
});

// ---------- T10 流程頁：設計流程｜本次資料、流程設定浮窗、記憶一行 ----------
const t10Def = { name: 'X', permissions: {}, check: {}, supervisor: {}, params: [{ key: 'k1', label: '欄一', default: 'v1' }], nodes: [{ id: 'n1', title: '步一', executor: 'ai', instruction: 'i' }] };
const t10Ctx = (extra = {}, helpers = {}) => ({
  state: { wf: { category: 'a', id: 'x', def: t10Def, runs: [] }, versions: [], categories: ['a'], flowTab: 'design', flowSettingsOpen: false, flowMemOpen: false, permFlashUntil: 0, permErr: null, mode: 'list', paramNow: {}, identities: [{ id: 'id1', name: '我' }], memIdentity: '', wfMemory: null, startCheck: null, claude: true, memMore: {}, memPicks: {}, addingParam: false, expanded: new Set(), run: null, drawerOpen: false, keep: {}, ...extra },
  subjectIsDraft: () => false, subjectDef: () => t10Def, ...helpers,
});
test('T10 ①：workHeadHtml——右上「流程設定」鈕、seg 兩鍵「設計流程」「本次資料」、不再直印三開關；本次資料分頁不印四模式 seg；草稿沒有這些', () => {
  const h = uiFn('workHeadHtml', t10Ctx())();
  assert.ok(h.includes('data-act="flow-settings"'), '流程設定鈕');
  assert.ok(h.includes('data-act="flow-tab" data-tab="design"') && h.includes('>設計 Workflow</span>') && h.includes('data-act="flow-tab" data-tab="data"') && h.includes('>本次資料</span>'), '兩分頁');
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

const t10Stubs = { resumeHtml: () => '<div data-resume></div>', proposalsHtml: () => '', stepListHtml: () => '<div class="step" data-step></div>', startCheckHtml: () => '', habitChipsHtml: () => '', preflightFor: () => null, flowMemLineHtml: () => '<div data-flowmemline></div>', healthCardHtml: () => '' }; // 健檢卡會背景打 API，另測
test('T10 ③：本次資料分頁＝任務卡＋展開的身分／欄位值，開始鈕在右欄摘要卡、不含步驟清單；設計流程的清單模式不再有開跑表單、留欄位定義與記憶一行', () => {
  // 開跑表單拆成主欄任務卡（展開＝身分＋欄位值）與右欄「開始這次執行」摘要卡，「開始」不再在 dataTabHtml 裡
  const data = uiFn('dataTabHtml', t10Ctx({}, t10Stubs))();
  assert.ok(data.includes('<h3>填寫這次的值<button type="button" class="hint"') && data.includes('id="mem-identity"') && data.includes('data-param="k1"'), '開跑表單三件（標題／身分／欄位值）');
  assert.ok(!data.includes('data-act="start"') && uiFn('dataAsideHtml', t10Ctx({}, t10Stubs))().includes('data-act="start"'), '開始鈕搬到右欄摘要卡');
  assert.ok(!data.includes('class="step') && !data.includes('執行需要的資料'), '不含步驟清單與欄位定義（排版輪 L8：欄位卡改名「執行需要的資料」）');
  const list = uiFn('listModeHtml', t10Ctx({}, t10Stubs))();
  assert.ok(!list.includes('data-act="start"') && !list.includes('<h3>填寫這次的值<button type="button" class="hint"') && !list.includes('data-param="k1"'), '清單模式不再有開跑表單');
  assert.ok(list.includes('執行需要的資料') && list.includes('data-req="k1"') && list.includes('data-flowmemline') && list.includes('data-step'), '欄位定義、記憶一行、步驟清單留著');
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
  assert.ok(ow.includes('restoreWorkspace(') && !ow.includes("state.flowTab = 'design'") && ow.includes('state.flowSettingsOpen = false') && ow.includes('state.flowMemOpen = false'), '換流程：沒有暫存才重設（flowTab 預設住在 restoreWorkspace；兩浮窗仍每次關）');
  assert.ok(src.includes("e.key === 'Escape' && state.flowMemOpen") && src.includes("e.key === 'Escape' && state.flowSettingsOpen"), 'Esc');
  for (const a of ['flow-tab', 'flow-settings', 'flow-settings-close', 'flowmem-open', 'flowmem-close']) assert.ok(src.includes(`act === '${a}'`), a);
  assert.equal(count(src, 'id="perm-files"'), 1, 'perm-files id 只在 permRowHtml 一處（地雷 7）');
  assert.ok(src.includes('function paramRowsHtml(def)'), '值列搬成函式');
});

// ---------- T11 抽屜：先兩格、其餘收摺；子頁保留 ----------
const t11Ctx = (extra = {}) => ({ state: { drawerTab: 'content', cvMore: null, presets: {}, wfFiles: [], wfMemory: null, keep: {}, ...extra }, kindOf: () => 'task', refFilesSectionHtml: () => '<div id="ref-section"></div>', supChecksHtml: () => '', templateSectionHtml: () => '', drawerInputsHtml: () => '', drawerMemoryHtml: () => '' });
const t11Node = (extra = {}) => ({ id: 'n1', title: 't', executor: 'ai', instruction: 'i', ...extra });
test('T11 ①：任務內容頁——任務與驗收重點在 <details> 之前；角色／背景／限制／範例／參考檔在 <details class="cvmore"> 內；九個欄位 id 全在（套用不丟欄）', () => {
  const html = uiFn('canvasEditorHtml', t11Ctx())(t11Node(), {});
  const d0 = html.indexOf('<details class="cvmore"'), d1 = html.indexOf('</details>');
  assert.ok(d0 > 0 && d1 > d0, 'details 存在');
  for (const id of ['id="cv-instruction"', 'id="cv-review"']) assert.ok(html.indexOf(id) < d0, `${id} 該在 details 之前`);
  for (const id of ['id="cv-role"', 'id="cv-bg"', 'id="cv-constraints"', 'id="cv-examples"', 'id="ref-section"']) { const i = html.indexOf(id); assert.ok(i > d0 && i < d1, `${id} 該在 details 內`); }
  for (const id of ['cv-title', 'cv-human', 'cv-stop', 'cv-instruction', 'cv-review', 'cv-role', 'cv-bg', 'cv-constraints', 'cv-examples']) assert.equal(count(html, `id="${id}"`), 1, id);
  assert.ok(!html.includes('id="cv-page-spec"') && !html.includes('data-act="cv-tab"') && html.includes('id="cv-file"') && html.includes('id="cv-model"'), '排版輪 L10：產出規格子頁退場，欄位併進同一頁');
  assert.ok(html.includes('<summary data-act="cv-more">') && html.includes('更多設定'), 'summary（排版輪 L10：樣稿字「更多設定」）');
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

// ---------- U2a 側欄公司節點、麵包屑、公司名稱載入 ----------
const u2aSide = (extra = {}) => t9Side({ companyName: '範例公司', ...extra });
test('U2a ①：側欄公司節點在「建立新流程」之後、第一個 details.cat 之前，class="wf companynode" data-act="open-company"；calentry 仍四個；分類樹包 .tree；名稱空→「公司」；看著公司頁→now', () => {
  const html = u2aSide();
  const node = 'class="wf companynode" data-act="open-company"';
  assert.ok(html.includes(node), '公司節點');
  const i = html.indexOf(node);
  assert.ok(html.indexOf('data-act="new-flow"') < i && i < html.indexOf('<details class="cat"'), '位置：newflow 之後、分類樹之前');
  // 內容改 DEMO 的小字「公司」＋粗體名（原本 <span class="wfname">名</span>）
  assert.ok(/class="wf companynode" data-act="open-company"[^>]*>[\s\S]*?<i class="ph ph-buildings"><\/i>[\s\S]*?<small>組織<\/small><strong>範例公司<\/strong>/.test(html), '圖標 buildings＋小字公司＋粗體公司名');
  const acts = [...html.matchAll(/class="wf calentry[^"]*" data-act="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(acts, ['open-dash', 'open-library', 'open-calendar', 'open-settings'], '四全域項不變（公司節點不是第五個）');
  assert.ok(html.includes('<div class="tree">') && html.indexOf('<div class="tree">') < html.indexOf('<details class="cat"'), '分類樹包 .tree');
  assert.ok(u2aSide({ companyName: '' }).includes('<strong>組織</strong>'), '空字串→「公司」');
  assert.ok(u2aSide({ companyName: '  ' }).includes('<strong>組織</strong>'), '空白→「公司」');
  const now = u2aSide({ categoryPage: { category: '_company' } });
  assert.ok(now.includes('class="wf companynode now" aria-current="page" data-act="open-company"'), '看著公司頁時 now');
  assert.ok(!now.includes('summary class="nm now"'), '_company 不會把任何分類標成 now');
});

test('U2a ②：crumbsHtml 依序 公司›分類›流程名，前兩節 data-act、末節 aria-current；extra 多一節；草稿與「開始一件事」只印 公司›草稿', () => {
  const ctx = { state: { wf: { category: '旅遊', def: { name: 'A' } }, companyName: '' } };
  const html = uiFn('crumbsHtml', ctx)();
  assert.ok(html.startsWith('<nav class="crumbs"'), 'nav.crumbs');
  const parts = [...html.matchAll(/<span([^>]*)>([^<]*)<\/span>/g)].map((m) => [m[1].trim(), m[2]]);
  assert.deepEqual(parts.map((p) => p[1]), ['組織', '旅遊', 'A'], '三節依序');
  assert.ok(parts[0][0].includes('data-act="open-company"'), '第一節 open-company');
  assert.ok(parts[1][0].includes('data-act="open-category" data-cat="旅遊"'), '第二節 open-category');
  assert.ok(parts[2][0].includes('aria-current="page"') && !parts[2][0].includes('data-act'), '末節 aria-current 且不可點');
  assert.equal(count(html, 'ph-caret-right'), 2, '兩個分隔符');
  const run = uiFn('crumbsHtml', ctx)('這次的執行');
  const rparts = [...run.matchAll(/<span([^>]*)>([^<]*)<\/span>/g)].map((m) => [m[1].trim(), m[2]]);
  assert.deepEqual(rparts.map((p) => p[1]), ['組織', '旅遊', 'A', '這次的執行']);
  assert.ok(rparts[3][0].includes('aria-current="page"') && !rparts[2][0].includes('aria-current'), 'extra 成末節；流程名那節不再 current');
  assert.ok(uiFn('crumbsHtml', { state: { wf: { category: '旅遊', def: { name: 'A' } }, companyName: '範例公司' } })().includes('>範例公司</span>'), '公司名跟設定');
  const draft = uiFn('crumbsHtml', { state: { wf: null, chat: { draft: { name: '' } }, companyName: '' } })();
  assert.deepEqual([...draft.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]), ['組織', '草稿'], '草稿');
  assert.deepEqual([...uiFn('crumbsHtml', { state: { wf: null, chat: { draft: null }, companyName: '' } })().matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]), ['組織', '草稿'], '「開始一件事」還沒拆出草稿也算草稿');
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
  assert.ok(wh.includes('return `${crumbsHtml()}<div class="heading">'), 'workHeadHtml 麵包屑在標題列之上（排版輪 L8：tophead→heading）');
  const rh = /function runHtml\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(rh.includes("return `${crumbsHtml('這次的執行')}${head}"), 'runHtml 麵包屑多一節（排版輪 L12：tophead→page-head）');
  const css = cssSrc();
  for (const r of ['.companynode{', '.side .tree{', '.crumbs{', '.crumbs [data-act]:hover{', '.crumbs [aria-current]{']) assert.ok(css.includes(r), r);
});

test('U2a ④：categoryPageHtml 對 _company 標題印公司名（P2 起「改名在 設定→資料」改成標題列「修改名稱」鈕）、chip「公司」、不含分類守則也不印讀取中；一般分類 data:null 仍讀取中', () => {
  // U2b 起公司頁也有共用檔要抓：shared 給空清單＝已讀完，才不印「讀取中」
  const cp = (category, extra = {}) => uiFn('categoryPageHtml', { state: { categoryPage: { category, data: null, cards: [], err: null, saving: false, saveErr: null, shared: { rules: [], refs: [], rule_chars: 0 } }, workflows: [], companyName: '範例公司', ...extra } })();
  const co = cp('_company');
  assert.ok(co.includes('<h1>範例公司</h1>'), '標題＝公司名（排版輪 L7：page-head h1）');
  assert.ok(!co.includes('改名在 設定→資料') && co.includes('data-act="rename-open" data-type="company"'), '灰字句刪掉，改「修改名稱」鈕（P2）');
  assert.ok(co.includes('<nav class="breadcrumb">工作空間</nav>'), 'chip 公司（排版輪 L7：樣稿無 chip，改由麵包屑「工作空間」交代是組織層）');
  assert.ok(!co.includes('分類守則') && !co.includes('讀取中') && !co.includes('data-act="save-group"'), '沒有分類守則框');
  assert.ok(cp('_company', { wf: { category: '旅遊', id: 'a' } }).includes('data-act="close-category"'), '回工作區（排版輪 L7 W11：有打開中的工作區才有）');
  assert.ok(cp('_company', { companyName: '' }).includes('<h1>組織</h1>'), '空名→公司');
  const dept = cp('旅遊');
  assert.ok(dept.includes('<h1>旅遊</h1>') && dept.includes('讀取中'), '一般分類照舊');
  const wh = uiFn('workHeadHtml', { state: { wf: { category: '旅遊', id: 'a', def: { name: 'A' } }, chat: { draft: null }, versions: [], categories: ['旅遊'], flowTab: 'design', mode: 'chat', companyName: '範例公司' } })();
  assert.ok(wh.startsWith('<nav class="crumbs"') && wh.includes('>範例公司</span>') && wh.includes('<h1>A</h1>'), '流程頁標題上方有麵包屑（排版輪 L8：h3→h1）');
});

// ---------- U2b 公司頁／分類頁——規範區、參考區、上傳、刪除、流程卡 ----------
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

test('U2b ①：分類頁依序 分類守則框→規範（每步都帶）→參考（勾了才帶）→流程 N；規範區「已 1,200／8,000 字」、一列 a.md・1,200 字・時間・shared-del；兩顆 shared-upload（rule／ref）；流程卡只列該分類、走既有 open', () => {
  const html = u2bPage('旅遊', { shared: u2bShared() });
  const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, `該有：${s}`); return i; };
  assert.ok(at('<h3>分類守則</h3>') < at('<h2>規範</h2>') && at('<h2>規範</h2>') < at('<h2>參考</h2>') && at('<h2>參考</h2>') < at('<h2 class="section-title">分類 Workflow</h2>'), '四段順序');
  assert.ok(html.includes('data-act="save-group"') && html.includes('id="group-text"'), '分類守則框原樣留著');
  assert.ok(html.includes('已 1,200／8,000 字'), '規範區標題旁常駐本層字數');
  const row = /<div class="file"[^]*?<\/button><\/div>/.exec(html)?.[0];
  assert.ok(row && row.includes('a.md') && row.includes('1,200 字') && row.includes('2026') && row.includes('data-act="shared-del" data-kind="rule" data-name="a.md"'), `一列 檔名・字數・時間・刪除：${row}`);
  assert.equal(count(html, 'class="file"'), 1, '只有一列');
  assert.ok(html.includes('data-act="shared-upload" data-kind="rule"') && html.includes('data-act="shared-upload" data-kind="ref"'), '兩顆上傳');
  assert.equal(count(html, 'data-act="shared-upload"'), 2);
  assert.equal(count(html, 'class="flowcard"'), 2, '流程卡＝該分類兩張');
  assert.ok(html.includes('data-act="open" data-cat="旅遊" data-id="a"') && html.includes('data-act="open" data-cat="旅遊" data-id="c"') && !html.includes('B 週報'), '卡上「打開」走既有 open、別的分類不列');
  assert.ok(!html.includes('data-company-page'), '分類頁不是公司頁');
});

test('U2b ②：公司頁——無分類守則框、無流程區、含「修改名稱」鈕（P2 起取代「改名在 設定→資料」）與 data-company-page；兩區都在；chip 公司', () => {
  const html = u2bPage('_company', { data: null, shared: u2bShared() });
  assert.ok(!html.includes('分類守則') && !html.includes('data-act="save-group"') && !html.includes('id="group-text"'), '無分類守則框');
  assert.ok(!/Workflow \d/.test(html) && !html.includes('class="flowcard"'), '無流程區');
  assert.ok(html.includes('data-act="rename-open" data-type="company"') && html.includes('data-company-page') && html.includes('<h1>範例公司</h1>'), '公司頁標題與「修改名稱」鈕');
  assert.ok(html.includes('<h2>規範</h2>') && html.includes('<h2>參考</h2>') && html.includes('已 1,200／8,000 字'), '兩區');
  assert.equal(count(html, 'data-act="shared-upload"'), 2);
  assert.ok(html.includes('data-act="shared-del" data-kind="rule" data-name="a.md"'));
});

test('U2b ③：空區兩句空態各一次；參考類 chars 為 null 的二進位印 KB 不印字數、md 參考印字數；shared 還沒讀到→兩區印「讀取中」', () => {
  const empty = u2bPage('_company', { data: null });
  assert.equal(count(empty, '還沒有規範。放進來的內容，AI 每一步都照著。'), 1);
  assert.equal(count(empty, '還沒有參考。步驟裡勾了才給 AI。'), 1);
  assert.equal(count(empty, 'class="file"'), 0);
  assert.ok(empty.includes('已 0／8,000 字'), '空層也常駐字數');
  const refs = u2bPage('_company', { data: null, shared: u2bShared({ rules: [], rule_chars: 0, refs: [{ name: '範本.docx', chars: null, bytes: 15360, uploaded_at: '2026-09-15T08:00:00.000Z' }, { name: '說明.md', chars: 5, bytes: 15, uploaded_at: '2026-09-15T08:00:00.000Z' }] }) });
  const rows = [...refs.matchAll(/<div class="file"[^]*?<\/button><\/div>/g)].map((m) => m[0]);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes('範本.docx') && rows[0].includes('15 KB') && !rows[0].includes(' 字') && rows[0].includes('data-act="shared-del" data-kind="ref" data-name="範本.docx"'), `二進位參考印 KB：${rows[0]}`);
  assert.ok(rows[1].includes('說明.md') && rows[1].includes('5 字') && !rows[1].includes('KB'), `文字參考印字數：${rows[1]}`);
  const loading = u2bPage('_company', { data: null, shared: null });
  assert.equal(count(loading, '讀取中'), 2, '兩區各印一次讀取中');
  assert.ok(!loading.includes('還沒有規範'), '讀取中不印空態');
  const deptLoading = u2bPage('旅遊', { shared: null });
  assert.ok(deptLoading.includes('<h3>分類守則</h3>') && count(deptLoading, '讀取中') === 2, '分類頁守則框照印、兩區讀取中');
});

test('U2b ④：cp.uploadErr 有值→該區標題下紅字一句；cp.msg→該區一句；沒值→都不印', () => {
  const err = u2bPage('_company', { data: null, uploadErr: { kind: 'rule', text: '太長，請精簡或改放參考' } });
  assert.equal(count(err, '太長，請精簡或改放參考'), 1);
  assert.ok(/<p class="note err"[^>]*>太長，請精簡或改放參考<\/p>/.test(err), '紅字 .note.err');
  assert.ok(err.indexOf('<h2>規範</h2>') < err.indexOf('太長，請精簡或改放參考') && err.indexOf('太長，請精簡或改放參考') < err.indexOf('<h2>參考</h2>'), '印在規範區內');
  const refErr = u2bPage('_company', { data: null, uploadErr: { kind: 'ref', text: '已有同名檔，先刪再傳' } });
  assert.ok(refErr.indexOf('<h2>參考</h2>') < refErr.indexOf('已有同名檔，先刪再傳'), '參考區的錯印在參考區');
  const msg = u2bPage('_company', { data: null, msg: { kind: 'ref', text: '已刪除，並從 2 個步驟取消勾選' } });
  assert.equal(count(msg, '已刪除，並從 2 個步驟取消勾選'), 1);
  assert.ok(msg.indexOf('<h2>參考</h2>') < msg.indexOf('已刪除，並從 2 個步驟取消勾選'), '一句在參考區');
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
  assert.ok(count(lcp, 'sharedPath(') >= 1, '公司頁與分類頁都抓共用檔清單');
  assert.equal(count(src, 'const sharedPath = (scope) => `/api/shared/'), 1, '共用檔 API 路徑只定義一次');
  const lib = /function libraryCardsHtml\(\) \{[\s\S]*?\n\}/.exec(src)[0];
  assert.ok(lib.includes('return flowCardsHtml(list)'), '流程庫卡片抽成 flowCardsHtml 共用');
  assert.equal(count(src, 'function flowCardsHtml('), 1);
  assert.ok(src.includes("sharedUpload: null"), 'state.sharedUpload 初值');
  const index = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  assert.ok(index.includes('<input type="file" id="shared-file" hidden>'), 'index.html 加共用檔 input（不借 #ref-file）');
  assert.ok(index.includes('id="ref-file"'), '既有 #ref-file 不動');
  const css = cssSrc();
  for (const r of ['.org-files .file{', '.sharedrow{', '.sharedsec .note.err{', '.section-title{']) assert.ok(css.includes(r), r);
});

// ---------- U0 SPEC／GLOSSARY 對齊實作計畫（文件 task，計畫的驗證指令變斷言；☑ 留 U7） ----------
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
  assert.ok(/\n- v0\.27 2026-09-16 移植合併輪/.test(spec) && spec.startsWith('# SPEC — 剝繭\n\n> ') && /\nv0\.\d+｜變更紀錄/.test(spec), 'v0.27 一行＋版本頭（拆法輪 W2 起版本頭 v0.28，活文件不寫死版號）');
  assert.ok(arc.includes('## 變更紀錄 v0.25（2026-09-16 自 SPEC 歸檔）') && arc.includes('- v0.25 2026-09-09 記憶輪 1＋設定頁＋群組圈（') && arc.includes('09-09 下午答五題'), 'v0.25 全文在 SPEC-archive');
  assert.ok(!/\n- v0\.25 2026-09-09 /.test(spec), 'v0.25 短樁已代謝進 SPEC-archive（成品格式輪為了騰行數搬的；全文仍在 archive，見上一條）');
  assert.ok(spec.includes('GET /api/workflows/:cat/:id/runs?detail=1'), 'US-076 API 名寫實');
  assert.ok(spec.includes("categoryPage.category==='_company'"), 'US-075 公司頁＝分類頁特例');
  assert.ok(spec.includes('執行頁右欄『這步會用到的資料』一行'), 'US-074');
  // budget_gate 歸檔：v0.22〜v0.24 全文搬到 SPEC-archive、SPEC 留短樁（證明沒丟）
  assert.ok(arc.includes('## 變更紀錄 v0.22〜v0.24（2026-09-16 自 SPEC 歸檔）'), '歸檔節標題');
  for (const [a, b] of [['- v0.24 2026-09-09 監工輪（', '09-09 答範圍表「過」、預算題「照原範圍做完」）：每趟多一個**監工**'], ['- v0.23 2026-09-08 交貨查核輪（', '09-08 答範圍表「1 過」＋長欄位不代進句子'], ['- v0.22 2026-09-03 產檔輪第一批（', '三題照建議＋範圍表「OK」）：流程權限 `permissions.files`']]) assert.ok(arc.includes(a) && arc.includes(b), `SPEC-archive 該含原文：${a.slice(0, 20)}`);
  // SPEC 撞到 200 行上限，v0.22〜v0.26 五條短樁一併代謝進 archive；全文仍在 archive（見上一條）
  for (const v of ['v0.22', 'v0.23', 'v0.24']) assert.ok(!new RegExp(`\\n- ${v.replace('.', '\\.')} 2026-09-0\\d `).test(spec), `${v} 短樁已代謝，SPEC 不該再留`);
});

// U2b 共用檔與群組圈各自容錯——一方失敗不蓋整頁
test('U2b 修正：shared 拋錯→分類頁仍有分類守則框、兩區印「共用檔讀不到：原因」＋重試；groups 拋錯→shared 區仍列檔、守則處錯誤卡；公司頁只打 shared、失敗印同一句；成功兩邊都清錯', async () => {
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
  assert.ok(a.html.includes('<h3>分類守則</h3>') && a.html.includes('id="group-text"') && a.html.includes('data-act="save-group"'), '守則框照常畫');
  assert.equal(count(a.html, '共用檔讀不到：共用夾壞了'), 2, '兩區各印一句');
  assert.ok(/data-act="(reload-category|shared-retry)"[^>]*>(?:<i[^>]*><\/i>)?重試/.test(a.html), '重試鈕');
  assert.ok(!a.html.includes('這個分類的規矩讀不到') && !a.html.includes('讀取中'), '不蓋整頁、不印讀取中');
  const b = await run('旅遊', 'groups');
  assert.equal(b.cp.err, '群組圈壞了');
  assert.ok(b.cp.shared && b.cp.sharedErr === null, 'shared 照常');
  assert.ok(b.html.includes('這個分類的規矩讀不到') && b.html.includes('data-act="reload-category"'), '守則處錯誤卡');
  assert.ok(b.html.includes('data-act="shared-del" data-kind="rule" data-name="a.md"') && b.html.includes('已 12／8,000 字'), 'shared 區仍列檔');
  assert.ok(!b.html.includes('id="group-text"'), '群組圈壞了就沒有守則框');
  const c = await run('_company', 'shared');
  assert.equal(c.cp.sharedErr, '共用夾壞了');
  assert.equal(count(c.html, '共用檔讀不到：共用夾壞了'), 2, '公司頁同一句');
  assert.ok(c.html.includes('data-company-page') && !c.html.includes('組織共用檔讀不到'), '公司頁不走整頁錯誤卡');
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
  assert.ok(at('<h3>組織</h3>') < at('<h5>位置</h5>'), '公司 group 在位置 group 之前（排版輪 L6：組織改分段 h3）');
  assert.ok(html.includes('清空顯示「組織」'), '說明句寫清空退回「公司」');
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

test('U3 ②：「清理」「關於」分段 0 命中「公司名稱」與 set-company-name；資料管理四段（組織／位置與備份／清理／關於）依序在同一頁', () => {
  const all = uiFn('setDataHtml', u3Ctx('位置與備份'))(u3Data);
  for (const tab of ['清理', '關於']) {
    const html = secOf(all, tab);
    assert.equal(count(html, '組織名稱'), 0, `${tab} 不印組織名稱`);
    assert.equal(count(html, 'set-company-name'), 0, `${tab} 不印輸入框`);
    assert.equal(count(html, '規範上限'), 0, `${tab} 不印規範上限`);
  }
  const order = ['<h3>組織</h3>', '<h3>位置與備份</h3>', '<h3>清理</h3>', '<h3>關於</h3>'].map((s) => all.indexOf(s));
  assert.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), `資料管理四段依序（原三分頁內容不少）：${order}`);
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

// ---------- U4b 流程頁右側資料夾、共用檔浮窗、本次資料必填在前選填收摺 ----------
const u4bRuns = [
  { run_id: 'r2', status: 'paused', started_at: '2026-09-15T10:00:00.000Z', finished_at: null, steps: { total: 2, done: 1, failed: 0 }, finals: [], files: [] },
  { run_id: 'r1', status: 'done', started_at: '2026-09-14T09:00:00.000Z', finished_at: '2026-09-14T09:06:00.000Z', steps: { total: 2, done: 2, failed: 0 }, finals: [{ node: 'w', title: '寫週報', preview: '# 週報', file: '寫週報.md' }], files: ['寫週報.md', '草稿.txt'] },
];
const u4bShared = { company: { rules: [{ name: 'r.md', chars: 10, bytes: 30 }], refs: [], rule_chars: 10 }, dept: { rules: [], refs: [{ name: 'x.md', chars: 5, bytes: 15 }, { name: 'y.docx', chars: null, bytes: 2048 }], rule_chars: 0 } };
const u4bEmptyShared = { company: { rules: [], refs: [], rule_chars: 0 }, dept: { rules: [], refs: [], rule_chars: 0 } };
const u4bCtx = (extra = {}, helpers = {}) => t10Ctx({ wfFiles: ['a.md', 'b.md', 'c.md', 'd.docx'], wfRuns: u4bRuns, shared: u4bShared, sharedOpen: false, folderOpen: { refs: true, runs: true, optional: null }, companyName: '範例公司', chat: { draft: null }, ...extra }, { fmtInt: realFmtInt, ...helpers });

test('U4b ①：flowAsideHtml——父層兩鈕、流程名、參考檔只印 3＋「查看全部 4 份」、上傳參考檔、每次執行兩筆（日期・膠囊・todo-go・成品 filechip）、灰字「公司 1 份・分類 2 份共用檔」＋shared-open；兩層皆 0→上層還沒有共用檔；草稿／run→空', () => {
  const h = uiFn('flowAsideHtml', u4bCtx())();
  assert.ok(h.startsWith('<aside class="flowaside"'), '外殼 aside.flowaside');
  assert.ok(h.includes('Workflow 資料夾'), '標題');
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
  assert.ok(h.includes('組織 1 份・分類 2 份共用檔') && h.includes('data-act="shared-open"'), '灰字一行＋查看');
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

test('U4b ②：sharedModalHtml——開著：pvback.memmodal.sharedmodal、兩層標題各一、每列 規範／參考 chip＋字數、去公司頁／分類頁管理鈕；關著空；run 時空', () => {
  const m = uiFn('sharedModalHtml', u4bCtx({ sharedOpen: true }))();
  assert.ok(m.startsWith('<div class="pvback memmodal sharedmodal" data-act="shared-close">'), '掛 .pvback');
  assert.ok(m.includes('role="dialog"') && m.includes('data-act="shared-close"') && m.includes('title="關閉（Esc）"'), '關閉鈕');
  assert.equal(count(m, 'data-shared-layer="company"'), 1);
  assert.equal(count(m, 'data-shared-layer="dept"'), 1);
  assert.ok(m.indexOf('data-shared-layer="company"') < m.indexOf('data-shared-layer="dept"'), '公司在上、分類在下');
  assert.ok(m.includes('>範例公司<') && m.includes('>a<'), '兩層標題＝公司名／分類名');
  assert.equal(count(m, 'class="sharedrow"'), 3, '三列');
  assert.equal(count(m, '>規範</span>'), 1);
  assert.equal(count(m, '>參考</span>'), 2);
  assert.ok(m.includes('r.md') && m.includes('10 字') && m.includes('x.md') && m.includes('5 字') && m.includes('y.docx') && m.includes('2 KB'), '檔名＋字數／KB');
  assert.ok(m.includes('data-act="open-company"') && m.includes('去組織頁管理') && m.includes('data-act="open-category" data-cat="a"') && m.includes('去分類頁管理'), '去管理兩鈕');
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
  assert.equal(count(h, 'class="chip wait req"'), 2, '必填 chip 兩個（排版輪 L11：樣稿 chip wait）');
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
  assert.ok(runBranch && rd.indexOf('dataAsideHtml()') > runBranch.index, 'run 分支不含側欄，側欄只在最後 else（排版輪 L11：本次資料右欄換 dataAsideHtml，資料夾在檢視器）');
  assert.equal(count(rd, 'dataAsideHtml()'), 1);
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
  for (const s of ['.flowlayout{display:grid;grid-template-columns:minmax(0,1fr) 268px', '.flowaside{', '.formdetails{', '.sharedmodal .modal{', '.folderrun{']) assert.ok(css.includes(s), `CSS ${s}`);
  assert.ok(/@media \(max-width:1100px\)\{[^}]*\.flowlayout\{grid-template-columns:1fr\}/.test(css), '1100 以下退單欄');
});

test('U4b ⑤：本次資料——主欄任務卡（含續跑那張）＋展開的身分與欄位值；「開始」與「只用於本次」在右欄摘要卡', () => {
  // 主欄只剩任務卡與展開區；續跑卡的「接回去繼續／刪掉」改成展開「繼續上次執行」那張才看得到（resumeHtml 原樣沒動）
  const ctx = () => u4bCtx({}, { ...t10Stubs, subjectDef: () => u4bDef });
  const data = uiFn('dataTabHtml', ctx())();
  assert.ok(data.includes('<h3>填寫這次的值<button type="button" class="hint"') && data.includes('id="mem-identity"') && data.includes('data-param="r1"'), '標題／身分／欄位');
  assert.ok(data.includes('data-prep="resume"') && uiFn('dataTabHtml', u4bCtx({ dataCard: 'resume' }, { ...t10Stubs, subjectDef: () => u4bDef }))().includes('data-resume'), '續跑那張卡在、展開它就是原本的續跑卡');
  const aside = uiFn('dataAsideHtml', ctx())();
  assert.ok(aside.includes('只用於本次') && aside.includes('data-act="start"'), '開始與「只用於本次」在右欄');
  assert.ok(aside.lastIndexOf('只用於本次') > aside.lastIndexOf('data-act="start"'), '「只用於本次」緊接在「開始」下');
  assert.ok(!data.includes('本次資料 · 只影響這一次'), '舊 h5 字退場');
});

// ---------- U4c 抽屜參考檔三段、跨層勾選 {scope,name}、「這一步會帶」四段 ----------
const u4cShared = { company: { rules: [{ name: 'r.md', chars: 10, bytes: 30 }], refs: [{ name: 'b.md', chars: 5, bytes: 15 }], rule_chars: 10 }, dept: { rules: [], refs: [], rule_chars: 0 } };
const u4cRefs = (wfFiles, shared, node) => uiFn('refFilesInner', { state: { wfFiles, shared } })(node);
test('U4c ①：refFilesInner 三段「這條流程／分類／公司」各一次；分類段「尚無參考」；流程檔與公司檔都 checked、id 帶 scope、data-att-scope；規範不進勾選；流程段有範本 chip、ref-del、上傳參考檔；上層讀不到→該段一句', () => {
  const html = u4cRefs(['a.docx'], u4cShared, { id: 'n1', attachments: ['a.docx', { scope: 'company', name: 'b.md' }] });
  for (const seg of ['這條 Workflow', '分類', '組織']) assert.equal(count(html, `<div class="refseghead">${seg}</div>`), 1, seg);
  assert.ok(html.indexOf('data-refseg="flow"') < html.indexOf('data-refseg="category"') && html.indexOf('data-refseg="category"') < html.indexOf('data-refseg="company"'), '順序 流程→分類→公司');
  assert.equal(count(html, '尚無參考'), 1, '只有分類段空');
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
  assert.equal(count(html, 'checked'), 1, '只有分類那份勾');
  assert.ok(/id="ref-category-x\.md"[^>]*checked/.test(html), '勾在分類段');
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
test('U4c ④：drawerMemoryHtml——「關於你 3・分類守則 2・公司規範 2・分類規範 1」；兩層 0→不含「規範」；全 0→「這一步會帶：沒有記憶與規範」；記憶讀不到但有規範→仍印規範；人做步驟空', () => {
  const sh = (c, d) => ({ company: { rules: Array.from({ length: c }, (_, i) => ({ name: `c${i}.md` })), refs: [], rule_chars: 0 }, dept: { rules: Array.from({ length: d }, (_, i) => ({ name: `d${i}.md` })), refs: [], rule_chars: 0 } });
  const four = uiFn('drawerMemoryHtml', u4cMemCtx(u4cMem, sh(2, 1)))(u4cNode);
  assert.ok(four.includes('這一步會帶：') && four.includes('關於你 3・分類守則 2・組織規範 2・分類規範 1'), four);
  const none = uiFn('drawerMemoryHtml', u4cMemCtx(u4cMem, sh(0, 0)))(u4cNode);
  assert.ok(none.includes('關於你 3・分類守則 2') && !none.includes('規範'), '兩層 0 不印規範');
  const onlyDept = uiFn('drawerMemoryHtml', u4cMemCtx(u4cMem, sh(0, 3)))(u4cNode);
  assert.ok(onlyDept.includes('分類守則 2・分類規範 3') && !onlyDept.includes('組織規範'), '公司 0 省略');
  const zero = uiFn('drawerMemoryHtml', u4cMemCtx({ core: { expression: [], content: [] }, group: { rules: [] }, options: {} }, sh(0, 0)))(u4cNode);
  assert.ok(zero.includes('這一步會帶：') && zero.includes('沒有記憶與規範') && !zero.includes('關於你'), '全 0');
  const noMem = uiFn('drawerMemoryHtml', u4cMemCtx(null, sh(1, 0)))(u4cNode);
  assert.ok(noMem.includes('組織規範 1') && !noMem.includes('關於你'), '記憶讀不到、有規範仍印');
  assert.equal(uiFn('drawerMemoryHtml', u4cMemCtx(null, sh(0, 0)))(u4cNode), '', '記憶讀不到、沒規範→空');
  assert.equal(uiFn('drawerMemoryHtml', u4cMemCtx(u4cMem, sh(2, 1)))({ ...u4cNode, executor: 'human' }), '', '人做步驟不印');
  const paused = uiFn('drawerMemoryHtml', u4cMemCtx({ ...u4cMem, paused: true }, sh(2, 1)))(u4cNode);
  assert.ok(paused.includes('關於你 暫停中・分類守則 2・組織規範 2・分類規範 1'), '暫停中照印規範');
});

// ---------- 儀表板兩欄＋最近完成三行版＋接下來的安排＋流程提議＋用量小圖與浮窗 ----------
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
  // 數字改樣稿「N 件」膠囊；Workflow 提議搬回左欄第三塊（樣稿位置，工程報備 8）——「要你處理」那塊仍不算提議
  const waitPanel = main.slice(0, main.indexOf('最近完成'));
  assert.ok(waitPanel.includes('要你處理') && waitPanel.includes('<span class="chip wait">1 件</span>'), `待辦數字不算提議：${waitPanel.match(/class="chip[^<]*</)}`);
  assert.equal(count(waitPanel, 'class="item '), 1, '只剩 stop 那列');
  assert.ok(waitPanel.includes('data-act="todo-go" data-cat="a" data-id="x" data-rid="r9"') && waitPanel.includes('<span class="chip wait"><i class="ph ph-hand-palm"></i>等你</span>'), '去處理鈕＋等你膠囊');
  assert.ok(!waitPanel.includes('去看提議') && !waitPanel.includes('todo-open-wf'), '提議列不在「要你處理」');
  assert.ok(main.includes('最近完成'), '最近完成標題');
  assert.equal(count(main, 'class="runcard'), 3, '預設 3 張');
  assert.ok(main.includes('data-act="dash-show-all"') && main.includes('查看全部（4）'), '查看全部（N）');
  const order = ['接下來', '系統通知', 'data-act="dash-usage-open"'].map((s) => aside.indexOf(s));
  assert.ok(order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), `右欄順序：${order}`);
  assert.ok(main.indexOf('Workflow 提議') > main.indexOf('最近完成') && main.includes('data-act="todo-open-wf" data-cat="a" data-id="x"') && main.includes('去看提議'), '流程提議那塊（左欄第三）有那筆提議');
  assert.ok(!aside.includes('Workflow 提議'), '右欄不再有提議');
  assert.ok(aside.includes('<svg class="usagechart"') && aside.includes('用量明細'), '用量小圖＋用量明細鈕');
  assert.ok(aside.includes('data-act="notices-toggle-done"'), '系統通知原樣（noticeSectionHtml）');
  const none = uiFn('dashHtml', u5Ctx({}, { todos: [u5Todos[1]] }))();
  assert.ok(u5Split(none)[0].includes('沒有新提議'), '沒有提議→空態');
  const css = cssSrc();
  assert.ok(css.includes('.homegrid{display:grid;grid-template-columns:minmax(0,1fr) 310px'), 'CSS .homegrid（排版輪 L5 照樣稿 310）');
  assert.ok(/@media \(max-width:950px\)\{[^\n]*\.homegrid\{grid-template-columns:1fr\}/.test(css), '950 以下退單欄（照樣稿）');
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
  assert.ok(flow.includes('class="usagetbl"') && flow.includes('聊天建 Workflow'), '數字表原樣');
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
  assert.ok(src.includes('if (!isTyping() && !state.preview && !state.dash?.usageOpen) render();'), '輪詢守門：浮窗開著不重繪');
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
  // 「查看」搬到「接下來」白卡右上（dashHtml 的 section-head，L5 ① 驗），清單本身不再帶
  assert.ok(empty.includes('這個月沒有安排') && !empty.includes('data-act="open-calendar"'), '空態；查看鈕在卡片右上');
  const ev = (date, time, kind, title) => ({ date, time, kind, title });
  const h = up({ events: [
    ev('2000-01-01', '08:00', 'auto', '過去的'), ev('2999-01-01', '07:00', 'goog', 'Google 的'),
    ev('2999-01-02', '08:00', 'auto', '寫週報 自動開跑'), ev('2999-01-03', '09:30', 'human', '交安全處置（寫週報）'), ev('2999-01-04', '10:00', 'auto', '第三筆'),
  ] });
  assert.equal(count(h, 'class="upcoming"'), 2, '只取兩筆');
  assert.ok(h.includes('1/2 08:00') && h.includes('寫週報 自動開跑') && h.includes('AI 自動'), '第一筆');
  assert.ok(h.includes('1/3 09:30') && h.includes('交安全處置（寫週報）') && h.includes('你出面'), '第二筆');
  for (const w of ['過去的', 'Google 的', '第三筆']) assert.ok(!h.includes(w), `${w} 不該出現`);
  assert.ok(!h.includes('data-act="open-calendar"'), '查看鈕常駐在卡片右上（dashHtml），不在清單裡重複');
  assert.ok(!h.includes('這個月沒有安排'));
});

// ---------- U6a 執行頁三欄骨架（左軌／中欄／右欄摺疊殼）＋ waiting_check 膠囊 ----------
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
  const a = h.indexOf('<aside class="panel progressrail">'), b = h.indexOf('<section class="runmain">'), c = h.indexOf('<aside class="sideinfo">');
  return { a, b, c, rail: h.slice(a, b), main: h.slice(b, c), side: h.slice(c) };
};

test('U6a ①：runHtml 三欄——.runlayout 內依序 progressrail／runmain／sideinfo；左軌三顆 run-inspect、等你那步 active、每顆帶 stepPill；中欄 stopCardHtml 原樣（三鈕字串仍在）＋只放目前這步一列（排版輪 L12）；右欄四個 sidefold，sup／data 有 open，標「目前這步」', () => {
  const h = u6Html();
  const { a, b, c, rail, main, side } = u6Cols(h);
  assert.ok(h.includes('<div class="runlayout">') && a > 0 && b > a && c > b, `三欄依序：${a}/${b}/${c}`);
  assert.ok(h.indexOf('<div class="runlayout">') < a, 'runlayout 包住三欄');
  assert.equal(count(rail, 'data-act="run-inspect"'), 3, `左軌三顆：${rail}`);
  assert.ok(rail.includes('<h3>這次的進度</h3>'), '左軌標題（排版輪 L12：h5→h3）');
  assert.ok(/class="runstep active" data-act="run-inspect" data-node="n2"/.test(rail), `等你那步（n2）active：${rail}`);
  assert.equal(count(rail, 'class="runstep active"'), 1, '只有一顆 active');
  assert.ok(rail.includes('data-node="n1"') && rail.includes('data-node="n3"'), '三步都在');
  assert.equal(count(rail, 'chip wait'), 1, '左軌 n2 停點膠囊');
  assert.ok(rail.includes('停點') && rail.includes('完成'), '左軌每顆帶 stepPill');
  const st = u6State();
  const stop = uiFn('stopCardHtml', { ...CARD_STUBS, state: st })(st.run.def.nodes[1], st.run.steps.n2);
  assert.ok(main.includes(stop), '停點卡原文一字不改地出現在中欄');
  assert.deepEqual(btnsOf(stop), [['approve', '繼續'], ['start-edit', '編輯'], ['back', '稍後']], '三鈕仍在（不加第四鈕）');
  assert.equal(count(h, 'data-steprow="'), 1, `中欄只放目前這步（排版輪 L12）：${count(h, 'data-steprow="')}`);
  for (const id of ['n1', 'n3']) assert.ok(!main.includes(`data-steprow="${id}"`), `中欄沒有 ${id} 列`);
  assert.ok(main.includes('data-steprow="n2"'), '中欄 n2 列');
  assert.equal(count(side, 'class="sidefold"'), 4, `右欄四格：${side}`);
  assert.ok(/<details class="sidefold" open><summary data-act="side-toggle" data-k="sup">/.test(side), 'sup 預設開');
  assert.ok(/<details class="sidefold" open><summary data-act="side-toggle" data-k="data">/.test(side), 'data 預設開');
  assert.ok(/<details class="sidefold"><summary data-act="side-toggle" data-k="focus">/.test(side), 'focus 預設關');
  assert.ok(/<details class="sidefold"><summary data-act="side-toggle" data-k="attempts">/.test(side), 'attempts 預設關');
  for (const w of ['監工交代', '這步會用到的資料', '驗收重點', '每次交卷']) assert.equal(count(side, w), 1, `右欄格標題「${w}」一次`);
  assert.ok(side.includes('目前這步') && side.includes('寫稿'), `右欄標「目前這步」＝等你那步的標題：${side}`);
  assert.ok(!side.includes('data-act="sup-toggle"') && !side.includes('data-act="mem-toggle"'), '右欄不重印卡片的監工交代／記憶（不共用 supOpen／memOpen）');
  assert.ok(h.indexOf('<nav class="crumbs"') < h.indexOf('<div class="page-head">') && h.indexOf('<div class="page-head">') < h.indexOf('<div class="runlayout">'), '麵包屑＋page-head（含 sub）在 runlayout 之前（排版輪 L12：tophead→page-head）');
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
  assert.ok(main.includes('這趟的紀錄') && main.includes('這次的成品已備妥') && main.includes('id="run-feedback-input"'), '紀錄、成品、回饋框都在中欄（排版輪 L12：成品在這裡→這次的成品已備妥）');
  assert.ok(!side.includes('這次的成品已備妥') && !side.includes('這趟的紀錄'), '側欄不放成品區');
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
  assert.ok(rh.includes('else if (isDone) main = runCompleteHtml(run);') && /function runCompleteHtml\(run\) \{[\s\S]*?\$\{recordHtml\(run\)\}\$\{proposalsHtml\(\)\}\$\{feedbackBox\}/.test(src), '跑完：成品＋紀錄＋提議＋回饋留中欄（排版輪 L12：現況分支改只放一步）');
  const css = cssSrc();
  assert.ok(css.includes('.runlayout{display:grid;grid-template-columns:190px minmax(0,1fr) 240px'), 'CSS 三欄格（排版輪 L12：樣稿 190／240）');
  for (const s of ['.progressrail{', '.runstep{', '.runstep.active{', '.sideinfo{', '.sidefold{', '.sidefold>summary{']) assert.ok(css.includes(s), `CSS ${s}`);
  assert.ok(/@media \(max-width:1100px\)\{[^}]*\.runlayout\{grid-template-columns:1fr\}/.test(css), '1100 以下退單欄');
  assert.ok(/@media \(max-width:1100px\)\{[^}]*\.runlayout\{grid-template-columns:1fr\}[^@]*\.progressrail\{display:none\}/.test(css), '單欄時左軌隱藏');
  assert.ok(/\.progressrail,\.sideinfo\{position:sticky;top:20px;align-self:start;max-height:calc\(100vh - 40px\);overflow:auto/.test(css), '左右欄 sticky＋自捲（排版輪 L3 無頂欄後 top:20px）');
});

test('U6a ⑤：五張卡函式（stopCardHtml／checkCardHtml／humanCardHtml／dataCardHtml／failCardHtml）＋editRulesHtml／recordHtml 原文與 HEAD 逐字相同；四張卡的 data-act 清單前後一致', () => {
  const head = execSync('git show HEAD:bojian/ui/app.js', { cwd: UI, encoding: 'utf8' });
  const fnOf = (src, name) => { const m = new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(src); assert.ok(m, `${name} 找得到`); return m[0]; };
  for (const f of ['stopCardHtml', 'checkCardHtml', 'humanCardHtml', 'dataCardHtml', 'failCardHtml', 'editRulesHtml', 'recordHtml']) assert.equal(fnOf(uiSrc(), f), fnOf(head, f), `${f} 原文與 HEAD 逐字相同`);
  const acts = (s) => [...s.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]).sort();
  for (const f of ['stopCardHtml', 'checkCardHtml', 'humanCardHtml', 'dataCardHtml']) assert.deepEqual(acts(fnOf(uiSrc(), f)), acts(fnOf(head, f)), `${f} data-act 清單前後相同`);
});

// ---------- U6b 右欄接資料（這步會用到的資料／每次交卷／監工交代／當時指示浮窗共用） ----------
const U6B_SHARED = { company: [{ name: '手冊.md', chars: 20 }, { name: '語氣.md', chars: 9 }], dept: [{ name: '分類規範.md', chars: 7 }], refs: [{ scope: 'category', name: '往期.md', chars: 18 }] };
const u6bSteps = (n2 = {}) => ({ n1: { status: 'done', output: '成品一' }, n2: { status: 'waiting_review', output: '成品二', ...n2 }, n3: { status: 'pending' } });
const u6bData = (h) => /<summary data-act="side-toggle" data-k="data">[\s\S]*?<\/details>/.exec(u6Cols(h).side)?.[0] ?? '';

test('U6b ①：這步會用到的資料——有 memory.shared→「帶了公司規範 2 份・分類規範 1 份・參考 1 份」＋「哪幾份」四列（層・檔名・字數）；沒有→「這趟沒有共用檔紀錄」；有紀錄但全 0→一句；人做步驟不印「帶了」；來源一行讀 preflightFor；右欄不重印 memoryUsedHtml；卡上空態句有規範時不說「沒帶任何記憶」', () => {
  const withShared = u6bData(u6Html({ run: u6Run({ steps: u6bSteps({ memory: { cards: [], shared: U6B_SHARED } }) }) }));
  assert.ok(withShared.includes('帶了組織規範 2 份・分類規範 1 份・參考 1 份'), `帶了…行：${withShared}`);
  assert.equal(count(withShared, '<li>'), 4, `哪幾份四列：${withShared}`);
  for (const w of ['組織規範・手冊.md', '組織規範・語氣.md', '分類規範・分類規範.md', '分類參考・往期.md', '20 字', '18 字']) assert.ok(withShared.includes(w), `哪幾份含「${w}」：${withShared}`);
  assert.ok(!withShared.includes('mem-toggle') && !withShared.includes('class="used"') && !withShared.includes('沒帶任何記憶'), '右欄不重印 memoryUsedHtml（不共用 memOpen）');
  const none = u6bData(u6Html({ run: u6Run({ steps: u6bSteps() }) }));
  assert.ok(none.includes('這趟沒有共用檔紀錄') && !none.includes('帶了'), `舊 run 沒有 memory.shared：${none}`);
  const zero = u6bData(u6Html({ run: u6Run({ steps: u6bSteps({ memory: { cards: [], shared: { company: [], dept: [], refs: [] } } }) }) }));
  assert.ok(zero.includes('這步沒帶共用檔') && !zero.includes('帶了') && !zero.includes('這趟沒有共用檔紀錄'), `有紀錄但全 0：${zero}`);
  const human = u6bData(u6Html({ run: u6Run({ steps: { n1: { status: 'done' }, n2: { status: 'done', memory: { cards: [], shared: U6B_SHARED } }, n3: { status: 'waiting_human' } } }) }));
  assert.ok(!human.includes('帶了') && human.includes('這步由你處理'), `人做步驟不印「帶了」：${human}`);
  // 來源一行：健檢還沒回→「檢查中」；回了→照 inputs[node] 的 label 串；空→一句
  assert.ok(u6bData(u6Html()).includes('來源：檢查中'), '健檢還沒回');
  const pf = { inputs: { pred: { n2: ['n1'] }, src: { n1: { t: '收集' } }, at: { n2: { near: ['n1'], own: [{ kind: 'param', id: 'k', label: '設定欄位：期間' }, { kind: 'attachment', id: 'company:範本.docx', label: '參考檔：範本.docx（公司）' }] } } } }; // L14b：健檢回應改不重複的寫法（pfInputs 展開）
  const src = u6bData(u6Html({}, { preflightFor: () => pf }));
  assert.ok(src.includes('來源：上一步《收集》的產出、設定欄位：期間、參考檔：範本.docx（公司）'), `來源一行：${src}`);
  assert.ok(u6bData(u6Html({}, { preflightFor: () => ({ inputs: { pred: {}, src: {}, at: { n2: { near: [], own: [] } } }, unused_params: [] }) })).includes('來源：沒有指定輸入'), '沒有輸入');
  assert.ok(src.includes('data-srcline'), '來源一行帶 data-srcline（健檢回來只補這一行）');
  // 卡上「這步用了 N 條記憶」的空態：有規範／共用檔時不能說「沒帶任何記憶」
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
  assert.ok(off.includes('這條 Workflow 沒開監工') && !off.includes('開場') && !off.includes('交接一'), `關：${off}`);
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
  const renderLine = src.split('\n').find((l) => l.includes('app.innerHTML = `<div class="layout">'));
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

// ---------- U6c 左軌點步驟＝歷史視圖（demo runPage 的 inspect）；回到目前；停著的歷史步 inert 唯讀 ----------
// mdBlock 給個看得見的假：印鍵＋原文，才斷得到「n1 的產出在 mdBlock 內」
const MD_STUB = { mdBlock: (t, key, cls = 'output') => `<div class="${cls}" data-mdkey="${key}">${t}</div>` };
const HIST_WORDS = ['data-act="run-current"', 'class="runbanner hist"', 'class="histcard" inert', '這一步的歷史'];

test('U6c ①：runInspect:null → 中欄＝目前這步（排版輪 L12：只放一步、停點卡三鈕在中欄）、整頁 0 命中 run-current／runbanner／histcard', () => {
  const h = u6Html({}, MD_STUB);
  const { main } = u6Cols(h);
  for (const w of HIST_WORDS) assert.equal(count(h, w), 0, `現況不帶歷史視圖字面 ${w}`);
  assert.equal(count(main, 'data-steprow="'), 1, '只放目前這步（排版輪 L12）');
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

test('U6c ④：並行支線——n3 waiting_review 但目前這步是 n2，runInspect:"n3" → stopCardHtml(n3) 原文在中欄、不包 inert、三顆 data-act 可按（排版輪 L12 報備 9：中欄只放一步後別條支線從左軌點進來必須能操作）', () => {
  const steps = { n1: { status: 'done', output: '成品一' }, n2: { status: 'waiting_review', output: '成品二', check: { blocks: [], summary: '' } }, n3: { status: 'waiting_review', output: '成品三', check: { blocks: [], summary: '' } } };
  const st = u6State({ runInspect: 'n3', run: u6Run({ steps }) });
  assert.equal(uiFn('currentNodeOf')(st.run), 'n2', '目前這步仍是 n2');
  const h = u6Html({ runInspect: 'n3', run: u6Run({ steps }) }, MD_STUB);
  const { main } = u6Cols(h);
  const stop = uiFn('stopCardHtml', { ...CARD_STUBS, ...MD_STUB, state: st })(st.run.def.nodes[2], steps.n3);
  assert.ok(main.includes(stop), `停點卡原文一字不改地在中欄：${main}`);
  assert.equal(count(main, 'inert'), 0, '不包 inert（可操作）');
  assert.deepEqual(btnsOf(main.slice(main.indexOf('<div class="panel runstep-now">'))), [['approve', '繼續'], ['start-edit', '編輯'], ['back', '稍後']], '三顆 data-act 可按、數量＝3（不逐顆 disabled）');
  assert.equal(count(main, 'disabled'), 0, '沒有逐顆 disabled');
  assert.ok(!main.includes('回到目前才能操作') && !main.includes('這一步的歷史'), '不是歷史視圖');
  assert.ok(main.includes('data-act="run-current"') && count(main, 'data-steprow="') === 1 && main.includes('data-steprow="n3"'), '支線橫幅（可回到目前）＋只印 n3 那列');
  assert.ok(!main.includes('成品二'), 'n2 的停點卡不印');
  // 中欄 n2 的卡在現況（runInspect:null）仍可點：確認 inert 只在歷史視圖出現
  assert.equal(count(u6Html({ run: u6Run({ steps }) }, MD_STUB), 'inert'), 0, '現況不包 inert');
});

test('U6c ⑤：接線原文——schedulePoll 0 命中 runInspect；run-current 分支 runInspect = null＋render()；run-inspect 分支改成設 runInspect＋render()（U6a ④ 的過渡反轉）；runInspect 指到不存在／fork／pending 節點→不炸；CSS .runbanner.hist；inert 唯讀退場（排版輪 L12）', () => {
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
  // 還沒開始的步：左軌鈕照 demo 灰掉（disabled、title「還沒跑到」），done／目前這步不灰；歷史視圖那條路（鍵盤導航仍可到）不炸、橫幅在、一句「還沒開始」、沒有產出格
  const { rail: r0, main: pend } = u6Cols(u6Html({ runInspect: 'n3' }, MD_STUB));
  assert.ok(/<button class="runstep[^"]*" data-act="run-inspect" data-node="n3" title="還沒跑到" disabled>/.test(r0), `pending 步鈕 disabled：${r0}`);
  assert.ok(/<button class="runstep[^"]*" data-act="run-inspect" data-node="n1" title="收集">/.test(r0) && /data-node="n2" title="寫稿" data-waiting>/.test(r0), `done／目前這步不 disabled：${r0}`);
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
  assert.ok(css.includes('.runbanner.hist{') && count(css, '.histcard') === 0 && count(src, 'histcard') === 0, 'CSS .runbanner.hist 留、.histcard 退場（排版輪 L12）');
});

// ----------  色彩分層與 token（第二列；DEMO hierarchy.css :root） ----------
test('P1 ①：token 改靛藍／冷灰藍——--accent 四件、--accent-soft、--m1〜m4-bg、--wp、--paper-rail、--ink-900／500、--amber-text；--green-soft 新增；--amber-rgb／--red-text 不動', () => {
  assert.equal(cssVar('--accent'), '#445bc4', '--accent 靛藍');
  assert.equal(cssVar('--accent-hover'), '#3549a6');
  assert.equal(cssVar('--accent-text'), '#354daf');
  assert.equal(cssVar('--accent-rgb'), '68 91 196');
  assert.equal(cssVar('--accent-soft'), '#e7ecff', '--accent-soft 新增');
  assert.equal(cssVar('--m1-bg'), '#edf0f7', '側欄');
  assert.equal(cssVar('--m2-bg'), '#ffffff');
  assert.equal(cssVar('--m3-bg'), '#ffffff', '內容面純白');
  assert.equal(cssVar('--m4-bg'), '#ffffff');
  assert.equal(cssVar('--wp'), '#f3f5fa', '頁底冷灰藍');
  assert.equal(cssVar('--paper-rail'), '#eef1f7');
  assert.equal(cssVar('--hairline'), '#dbe1ec');
  assert.equal(cssVar('--ink-900'), '#26334a');
  assert.equal(cssVar('--ink-500'), '#657189');
  assert.equal(cssVar('--amber-text'), '#956019', '琥珀字');
  assert.equal(cssVar('--green-soft'), '#94b7ad', '--green-soft 新增（完成頂線低彩綠）');
  assert.equal(cssVar('--amber-rgb'), '245 166 35', '--amber-rgb 不動');
  assert.equal(cssVar('--red-text'), '#c0242b', '--red-text 不動');
});

test('P1 ②：頂線四 class（.panel-wait／.panel-done／.panel-blue／.homeaside .asideblock）；.newflow 實心靛藍白字；.btn-primary／.seg span.on／.wf.now 讀 token', () => {
  assert.ok(cssRule('.panel-wait')?.includes('border-top:3px solid #c58b31') && cssRule('.panel-wait').includes('background:#fffbf2'), `.panel-wait 琥珀頂線＋暖底：${cssRule('.panel-wait')}`);
  assert.ok(cssRule('.panel-done')?.includes('border-top:3px solid var(--green-soft)'), `.panel-done 低彩綠頂線：${cssRule('.panel-done')}`);
  assert.ok(cssRule('.panel-blue')?.includes('background:#f0f3ff'), `.panel-blue 藍底：${cssRule('.panel-blue')}`);
  assert.ok(cssRule('.homeaside .asideblock')?.includes('background:#edf1f8'), `.homeaside .asideblock 灰藍底：${cssRule('.homeaside .asideblock')}`);
  const nf = cssRule('.newflow');
  assert.ok(nf?.includes('background:var(--accent)') && nf.includes('color:#fff'), `.newflow 實心靛藍白字：${nf}`);
  assert.ok(cssRule('.newflow:hover')?.includes('background:var(--accent-hover)'), '.newflow:hover 深一階');
  assert.ok(cssRule('.btn-primary')?.includes('background:var(--accent)'), '.btn-primary 讀 --accent');
  const seg = cssRule('.seg span.on');
  assert.ok(seg?.includes('background:#fff') && seg.includes('color:var(--accent-text)'), `seg .on＝白底＋靛藍字：${seg}`);
  assert.ok(cssRule('.wf.now')?.includes('rgb(var(--accent-rgb)') && cssRule('.wf.now').includes('color:var(--accent-text)'), '.wf.now 讀 token');
});

test('P1 ③：舊藍 #0a84ff／舊紙 #fcfbf9 在 style.css 0 命中；非狀態 chip（violet／amber／red／blue）仍在；.step.sel 寫法逐字不動（換色靠 token）', () => {
  const css = cssSrc();
  assert.equal(count(css, '#0a84ff'), 0, '舊藍退場');
  assert.equal(count(css, '#fcfbf9'), 0, '舊暖紙退場');
  for (const c of ['.chip.violet', '.chip.amber', '.chip.red', '.chip.blue']) assert.ok(cssRule(c), `${c} 不刪`);
  assert.equal(cssRule('.step.sel'), 'background:rgb(var(--accent-rgb) / .12);outline:2px solid var(--accent);outline-offset:-2px', '.step.sel 與 HEAD 逐字相同');
});

// ---------- P2 側欄三層樹（公司→分類→流程）＋三層鉛筆改名浮窗＋同步（G 側欄樹列） ----------
const p2Side = (extra = {}) => t9Side({ companyName: '範例公司', categories: ['旅遊', '未分類'], workflows: [{ id: 'a', name: 'A', category: '旅遊' }, { id: 'b', name: 'B', category: '旅遊' }], ...extra });
test('P2 ①：sideHtml——.company-row 在 new-flow 之後（open-company＋小字公司＋粗體名＋鉛筆 company）；.company-children 包住全部 details.cat；summary 有 .dept-row／.dept-count＝流程數／鉛筆 category（未分類沒有）；.flow-row 有 flow-dot／wfdel／鉛筆 flow；calentry 仍四個、companynode 不是 calentry、cat-toggle 仍在', () => {
  const html = p2Side();
  const iRow = html.indexOf('<div class="company-row');
  assert.ok(iRow > 0 && html.indexOf('data-act="new-flow"') < iRow, '.company-row 在「建立新流程」之後');
  const iKids = html.indexOf('<div class="company-children">');
  assert.ok(iKids > iRow, '.company-children 在 .company-row 之後');
  const row = html.slice(iRow, iKids);
  assert.ok(row.includes('data-act="open-company"'), '公司列點了開公司頁（語意不變）');
  assert.ok(row.includes('<small>組織</small>') && row.includes('<strong>範例公司</strong>'), '小字「公司」＋粗體名');
  assert.ok(row.includes('data-act="rename-open" data-type="company"'), '公司鉛筆');
  const kids = html.slice(iKids, html.indexOf('data-act="open-assets"')); // 新增分類搬走，切點改共用素材入口
  assert.equal(count(kids, '<details class="cat"'), 2, '兩個分類都在 .company-children 裡');
  assert.equal(count(html, '<details class="cat"'), 2, '沒有分類漏在外面');
  const summaries = [...html.matchAll(/<summary[^>]*>[\s\S]*?<\/summary>/g)].map((m) => m[0]);
  assert.equal(summaries.length, 2);
  assert.ok(summaries[0].includes('class="dept-row') && summaries[0].includes('<span class="dept-mark"'), '分類列');
  assert.ok(/class="dept-count"[^>]*>2</.test(summaries[0]) && /class="dept-count"[^>]*>0</.test(summaries[1]), '流程數 2／0');
  assert.ok(summaries[0].includes('data-act="rename-open" data-type="category" data-cat="旅遊"'), '分類鉛筆');
  assert.ok(!summaries[1].includes('rename-open'), '「未分類」不能改名，沒有鉛筆');
  assert.ok(summaries[0].includes('data-act="open-category" data-cat="旅遊" title="分類守則"') && summaries[0].includes('data-act="cat-toggle" data-cat="旅遊"'), 'open-category／cat-toggle 照舊');
  assert.equal(count(html, '<div class="flow-row'), 2, '兩條流程列');
  const flow = /<div class="flow-row[^"]*">[\s\S]*?data-id="a"[\s\S]*?<\/div>[\s\S]*?class="rowmore"[\s\S]*?<\/button><\/div>/.exec(html)?.[0] ?? '';
  assert.ok(flow.includes('data-act="open" data-cat="旅遊" data-id="a"') && flow.includes('<span class="flow-dot"'), '流程列：open＋flow-dot');
  assert.ok(flow.includes('data-act="row-menu" data-cat="旅遊" data-id="a"') && !flow.includes('wfdel'), '排版輪 L4：列上垃圾桶收進「⋯」（del-wf-row 在 rowMenuHtml）');
  assert.ok(flow.includes('data-act="rename-open" data-type="flow" data-cat="旅遊" data-id="a"'), '流程鉛筆');
  assert.ok(html.includes('class="flow-branches"'), '流程列包 .flow-branches');
  assert.ok(html.includes('tree-empty'), '空分類印「尚無工作流」');
  const acts = [...html.matchAll(/class="wf calentry[^"]*" data-act="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(acts, ['open-dash', 'open-library', 'open-calendar', 'open-settings'], '四全域項不變');
  assert.ok(!/class="wf calentry[^"]*companynode/.test(html), 'companynode 不是 calentry');
  const now = p2Side({ wf: { id: 'a', category: '旅遊', def: { name: 'A' } } });
  assert.ok(now.includes('<div class="flow-row active">') && /class="wf now"[^>]*data-id="a"/.test(now), '正在看的流程：flow-row.active＋wf.now');
  assert.ok(p2Side({ categoryPage: { category: '_company' } }).includes('<div class="company-row active">'), '看著公司頁：company-row.active');
  assert.ok(p2Side({ categoryPage: { category: '旅遊' } }).includes('class="dept-row active"'), '看著分類頁：dept-row.active');
});

test('P2 ②：renameModalHtml——分類：id="rename-name" value="旅遊" maxlength="60"、data-keep、標題「修改分類名稱」、DEMO note；流程：「修改工作流名稱」＋流程那句；err→紅字；busy→鈕 disabled；rename:null→空字串', () => {
  const rm = (rename) => uiFn('renameModalHtml', { state: { rename } })();
  const dept = rm({ type: 'category', cat: '旅遊', id: '', value: '旅遊', err: null, busy: false });
  assert.ok(dept.includes('id="rename-name" value="旅遊" maxlength="60"'), '輸入框帶現名與上限');
  assert.ok(/id="rename-name"[^>]*data-keep/.test(dept), 'data-keep（輪詢重繪不洗字）');
  assert.ok(dept.includes('修改分類名稱'), '標題');
  assert.ok(dept.includes('名稱會同步到工作空間及相關 Workflow。'), 'DEMO note');
  assert.ok(dept.startsWith('<div class="pvback memmodal renamemodal" data-act="rename-close">'), '掛既有浮窗語彙');
  assert.ok(dept.includes('data-act="rename-save"') && dept.includes('data-act="rename-close"'), '儲存／取消');
  assert.ok(/<p id="rename-error" class="form-error" role="alert"><\/p>/.test(dept), '沒錯就空');
  assert.equal(count(dept, '<i class="ph ph-'), count(dept, '<i class="ph'), '只用 Phosphor 圖標');
  const flow = rm({ type: 'flow', cat: '旅遊', id: 'a', value: 'A', err: null, busy: false });
  assert.ok(flow.includes('修改 Workflow 名稱') && flow.includes('名稱會同步顯示於工作空間；既有執行與版本快照保留原名。'), '流程標題＋流程那句');
  assert.ok(rm({ type: 'company', cat: '', id: '', value: '範例公司', err: null, busy: false }).includes('修改組織名稱'), '組織標題');
  const err = rm({ type: 'category', cat: '旅遊', id: '', value: '工作', err: '已有同名分類', busy: false });
  assert.ok(err.includes('<p id="rename-error" class="form-error" role="alert">已有同名分類</p>'), '紅字');
  const busy = rm({ type: 'category', cat: '旅遊', id: '', value: '工作', err: null, busy: true });
  assert.ok(/data-act="rename-save" disabled/.test(busy) && /id="rename-name"[^>]*disabled/.test(busy), 'busy 鎖住');
  assert.equal(rm(null), '', 'rename:null→不印');
});

test('P2 ③：接線原文——renameSave 對三種 type 分別 PUT /api/settings／PUT /api/categories/／PUT wfPath，含 refreshLibrary() 與 render()；空白先寫 err 不打 API；rename-open／rename-save／rename-close 三分支；Enter 存、Esc 關；浮窗掛 render 串；state.rename 初值 null；輸入寫回 state.rename.value', () => {
  const src = uiSrc();
  const fn = /async function renameSave\(\) \{[\s\S]*?\n\}\n/.exec(src)?.[0];
  assert.ok(fn, 'renameSave 是頂層 async function');
  assert.ok(fn.includes("api('PUT', '/api/settings', { company_name: name })"), '公司→既有設定 API');
  assert.ok(fn.includes('/api/categories/${encodeURIComponent('), '分類→新 API PUT /api/categories/:name');
  assert.ok(fn.includes("api('PUT', wfPath(") && fn.includes('{ def }'), '流程→既有存新版本');
  assert.ok(fn.includes('refreshLibrary()') && fn.includes('render()'), '存成後重抓流程庫＋重繪');
  assert.ok(fn.includes('state.companyName = name'), '公司同步 state.companyName');
  assert.ok(fn.includes('state.categoryPage.category = name') && fn.includes('state.wf.category = name') && fn.includes('state.library.cat = name'), '分類同步三處');
  assert.ok(fn.includes('/versions'), '流程改名後版本重抓');
  const iErr = fn.indexOf('名稱不可留空');
  assert.ok(iErr > 0 && iErr < fn.indexOf('api('), '空白：先寫 err、不打 API');
  assert.ok(/if \(!name\) \{[^}]*\.err = /.test(fn), '空白寫進 state.rename.err');
  for (const a of ['rename-open', 'rename-save', 'rename-close']) assert.ok(src.includes(`act === '${a}'`), `事件 ${a}`);
  assert.ok(/e\.target\.id === 'rename-name' && e\.key === 'Enter'/.test(src), 'Enter＝儲存');
  assert.ok(/e\.key === 'Escape' && state\.rename/.test(src), 'Esc＝關');
  const rd = /function render\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(rd.includes('+ renameModalHtml()'), '浮窗掛在 render 的浮窗串');
  assert.ok(/^  rename: null,/m.test(src), 'state.rename 初值 null');
  assert.ok(/t\.id === 'rename-name' && state\.rename\) state\.rename\.value = t\.value/.test(src), '打字寫回 state.rename.value（輪詢重繪讀回）');
  assert.equal(count(src, 'closeSettings(); closeLibrary();'), count(src.replace(/function openLibrary\(\) \{[\s\S]*?\n\}\n/, ''), 'closeSettings();'), '沒加第 14 個關頁站（T9④ 續綠）');
});

test('P2 ④：categoryPageHtml head——分類頁「修改名稱」rename-open category；公司頁 rename-open company 且「改名在 設定→資料」0 命中；「未分類」沒有鈕', () => {
  const cp = (category, extra = {}) => uiFn('categoryPageHtml', { state: { categoryPage: { category, data: null, cards: [], err: null, saving: false, saveErr: null, shared: { rules: [], refs: [], rule_chars: 0 } }, workflows: [], companyName: '範例公司', ...extra } })();
  const dept = cp('旅遊');
  const head = dept.slice(0, dept.indexOf('<div class="orggrid'));
  assert.ok(head.includes('data-act="rename-open" data-type="category" data-cat="旅遊"') && head.includes('修改名稱'), '分類頁標題列「修改名稱」');
  const co = cp('_company');
  const cohead = co.slice(0, co.indexOf('<div class="orggrid'));
  assert.ok(cohead.includes('data-act="rename-open" data-type="company"') && cohead.includes('修改名稱'), '公司頁標題列「修改名稱」');
  assert.equal(count(uiSrc(), '改名在 設定→資料'), 0, '公司頁那句灰字刪掉');
  assert.ok(!cp('未分類').includes('rename-open'), '「未分類」不能改名');
});

test('P2 ⑤：workHeadHtml——已存流程標題旁有 rename-open data-type="flow" data-cat data-id；草稿沒有', () => {
  const base = { chat: { draft: null }, versions: [], categories: ['旅遊'], flowTab: 'design', mode: 'chat', companyName: '範例公司' };
  const saved = uiFn('workHeadHtml', { state: { ...base, wf: { category: '旅遊', id: 'a', def: { name: 'A' } } } })();
  const head = /<div class="heading">[\s\S]*?<\/div>/.exec(saved)[0];
  assert.ok(head.includes('<h1>A</h1>') && head.includes('data-act="rename-open" data-type="flow" data-cat="旅遊" data-id="a"'), '標題旁鉛筆（排版輪 L8：tophead h3→heading h1）');
  const draft = uiFn('workHeadHtml', { state: { ...base, wf: null, chat: { draft: { name: '草稿 X', nodes: [], params: [] } } } })();
  assert.equal(count(draft, 'rename-open'), 0, '草稿沒有');
});

test('P2 ⑥：CSS——.company-row、.company-children 含 border-left、.tree-rename、.flow-row.active 含 inset 3px 0；.companynode{ 仍在（U2a③）', () => {
  const css = cssSrc();
  assert.ok(cssRule('.company-row')?.includes('#fff') && cssRule('.company-row').includes('border-radius:12px'), `.company-row 白底圓角卡：${cssRule('.company-row')}`);
  assert.ok(cssRule('.company-children')?.includes('border-left'), `.company-children 樹線：${cssRule('.company-children')}`);
  assert.ok(cssRule('.tree-rename')?.includes('width:24px') && cssRule('.tree-rename').includes('height:28px'), `.tree-rename 24×28：${cssRule('.tree-rename')}`);
  assert.ok(cssRule('.flow-row.active')?.includes('inset 3px 0'), `.flow-row.active 左靛藍條：${cssRule('.flow-row.active')}`);
  for (const r of ['.company-row.active{', '.dept-row.active{', '.flow-branches{', '.dept-mark{', '.dept-count{', '.flow-dot{', '.companynode{']) assert.ok(css.includes(r), r);
});

// ---------- 每流程各自的工作區狀態——wsByFlow、stashWorkspace／restoreWorkspace、草稿列、「有改動未存」chip ----------
const J = (v) => JSON.stringify(v); // vm 另一個 realm 的物件，deepEqual 會嫌原型不同——比字串
const p3Pkg = () => ({ chat: { messages: [{ role: 'user', text: 'hi' }], draft: null, busy: false }, mode: 'canvas', flowTab: 'data', canvasSel: 'n1', drawerOpen: true, paramNow: { x: '1' }, memPicks: { x: 'c1' }, memChanged: ['c2'], memIdentity: 'id1', memIdentitySet: true, folderOpen: { refs: false, runs: true, optional: null, refsAll: false, runsAll: false }, expanded: new Set(['n1']), cvWork: { name: 'A', nodes: [], params: [] }, cvDirty: true });
const p3State = (extra = {}) => ({ wf: { category: '旅遊', id: 'a', def: { name: 'A', nodes: [], params: [] }, runs: [] }, run: null, chat: { messages: [], draft: null, busy: false }, mode: 'list', flowTab: 'design', canvasSel: null, drawerOpen: false, paramNow: {}, memPicks: {}, memChanged: [], memIdentity: '', memIdentitySet: false, folderOpen: { refs: true, runs: true, optional: null, refsAll: false, runsAll: false }, expanded: new Set(), cvWork: null, cvDirty: false, versions: [{ version: 3 }], wfRuns: [{ run_id: 'r' }], wfFiles: [{ name: 'f' }], shared: { company: [], dept: [], err: null }, ...extra });

test('P3 ①：原文——chatByFlow 0 命中；wsByFlow 與 stashWorkspace( 各 ≥10；openWorkflow 含 restoreWorkspace(；九個離開站分支各含 stashWorkspace()；open-draft 分支；new-flow 先 confirm 草稿；del-wf-row／delete-wf／分類改名同步 wsByFlow 鍵', () => {
  const src = uiSrc();
  assert.equal(count(src, 'chatByFlow'), 0, 'chatByFlow 該全改成 wsByFlow');
  assert.ok(count(src, 'wsByFlow') >= 10, `wsByFlow 命中數：${count(src, 'wsByFlow')}`);
  assert.ok(count(src, 'stashWorkspace(') >= 10, `stashWorkspace( 命中數：${count(src, 'stashWorkspace(')}`);
  assert.ok(/^function stashWorkspace\(\) \{/m.test(src) && /^function restoreWorkspace\(key\) \{/m.test(src), '兩支頂層 function 宣告（地雷 13）');
  const ow = /async function openWorkflow\([\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(ow.includes('stashWorkspace();') && ow.includes('restoreWorkspace(flowKey({ category, id }))'), 'openWorkflow 先暫存再讀回');
  assert.ok(ow.indexOf('stashWorkspace();') < ow.indexOf('restoreWorkspace('), '先存再讀');
  for (const a of ['open-dash', 'open-calendar', 'open-category', 'open-company', 'new-flow', 'todo-go', 'open-draft']) {
    const br = new RegExp(`act === '${a}'\\) \\{([\\s\\S]*?)\\n    \\}`).exec(src);
    assert.ok(br, `分支 ${a}`);
    assert.ok(br[1].includes('stashWorkspace();'), `${a} 分支該呼叫 stashWorkspace()`);
    assert.equal(br[1].includes('canvasLeaveBlocked()'), false, `${a}：畫布未存改動進暫存包，不再問「丟掉？」`);
  }
  for (const fn of ['openLibrary', 'openSettings']) {
    const body = new RegExp(`(?:async )?function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(src)[0];
    assert.ok(body.includes('stashWorkspace();') && !body.includes('canvasLeaveBlocked()'), `${fn} 該呼叫 stashWorkspace()、不問丟掉`);
  }
  assert.ok(/act === 'open'\) \{\n      await openWorkflow\(/.test(src), '側欄 open 直接 openWorkflow（暫存在裡面）');
  for (const a of ['mode-chat', 'mode-list', 'mode-history']) assert.ok(new RegExp(`act === '${a}'\\) \\{ ?if \\(canvasLeaveBlocked\\(\\)\\) return;`).test(src) || new RegExp(`act === '${a}'\\) \\{\\n      if \\(canvasLeaveBlocked\\(\\)\\) return;`).test(src), `${a}：同一條流程內離開畫布照舊問`);
  const nf = /act === 'new-flow'\) \{([\s\S]*?)\n    \}/.exec(src)[1];
  assert.ok(nf.includes("window.confirm('已有一份沒存的草稿，要丟掉重來嗎？')") && nf.indexOf('window.confirm') < nf.indexOf('stashWorkspace();'), 'new-flow：已有草稿先問，問完才暫存');
  assert.ok(nf.includes("wsByFlow.delete('__draft__')"), 'new-flow 丟掉暫存的草稿');
  const od = /act === 'open-draft'\) \{([\s\S]*?)\n    \}/.exec(src)[1];
  assert.ok(od.includes("restoreWorkspace('__draft__')") && od.includes('state.wf = null'), 'open-draft 讀回草稿包');
  assert.ok(/act === 'del-wf-row'\) \{[\s\S]*?wsByFlow\.delete\(`\$\{cat\}\/\$\{id\}`\)/.test(src), 'del-wf-row 刪鍵');
  assert.ok(/act === 'delete-wf'\) \{[\s\S]*?wsByFlow\.delete\(flowKey\(state\.wf\)\)/.test(src), 'delete-wf 刪鍵');
  const rs = /async function renameSave\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(rs.includes('for (const [k, v] of [...wsByFlow]) if (k.startsWith(`${r.cat}/`)) { wsByFlow.delete(k); wsByFlow.set(`${name}/${k.slice(r.cat.length + 1)}`, v); }'), '分類改名同步 wsByFlow 鍵');
  assert.ok(rs.includes('wsByFlow.get(flowKey(w))'), '流程改名：暫存包裡的畫布工作本名字跟著改');
  assert.ok(/state\.cvDirty \|\| dsAtRisk\(\) \|\| \[\.\.\.wsByFlow\.values\(\)\]\.some\(\(p\) => p\.cvDirty\)/.test(src), 'beforeunload 也看暫存包裡的未存改動（排版輪 F3：中間多一條「沒存的東西存不進瀏覽器」）');
});

test('P3 ②：vm——restoreWorkspace：有包→mode／flowTab／paramNow／canvasSel 等十四項讀回且包從 Map 取走；沒包→預設（list／design／{}）；__draft__ 沒包→mode chat；部分包補預設', () => {
  const ws = new Map([['旅遊/a', p3Pkg()]]);
  const state = p3State({ wf: null });
  const restore = uiFn('restoreWorkspace', { state, wsByFlow: ws });
  assert.equal(restore('旅遊/a'), true, '有包回 true');
  assert.equal(state.mode, 'canvas'); assert.equal(state.flowTab, 'data'); assert.equal(state.paramNow.x, '1'); assert.equal(state.canvasSel, 'n1');
  assert.equal(state.drawerOpen, true); assert.equal(state.chat.messages[0].text, 'hi'); assert.equal(J(state.memPicks), J({ x: 'c1' })); assert.equal(J(state.memChanged), J(['c2']));
  assert.equal(state.memIdentity, 'id1'); assert.equal(state.memIdentitySet, true); assert.equal(state.folderOpen.refs, false); assert.ok(state.expanded.has('n1'));
  assert.equal(state.cvWork.name, 'A'); assert.equal(state.cvDirty, true);
  assert.equal(ws.has('旅遊/a'), false, '讀回即取走（不留過期副本）');
  assert.equal(restore('旅遊/a'), false, '沒包回 false');
  assert.equal(state.mode, 'list'); assert.equal(state.flowTab, 'design'); assert.equal(J(state.paramNow), '{}'); assert.equal(state.canvasSel, null);
  assert.equal(state.drawerOpen, false); assert.equal(J(state.chat), J(uiFn('emptyChat')())); assert.equal(J(state.memPicks), '{}'); assert.equal(J(state.memChanged), '[]'); // 預設 chat 改由 emptyChat() 給（多 shape／sources／category／shapeEdit）
  assert.equal(state.memIdentity, ''); assert.equal(state.memIdentitySet, false); assert.equal(J(state.folderOpen), J({ refs: true, runs: true, optional: null, refsAll: false, runsAll: false }));
  assert.equal(state.expanded.size, 0); assert.equal(state.cvWork, null); assert.equal(state.cvDirty, false);
  restore('__draft__');
  assert.equal(state.mode, 'chat', '草稿沒包＝聊天');
  ws.set('旅遊/b', { mode: 'canvas', flowTab: 'data', paramNow: { x: '1' }, canvasSel: 'n1' });
  restore('旅遊/b');
  assert.equal(state.mode, 'canvas'); assert.equal(state.flowTab, 'data'); assert.equal(state.paramNow.x, '1'); assert.equal(state.canvasSel, 'n1');
  assert.equal(state.drawerOpen, false, '部分包：缺的補預設'); assert.equal(J(state.chat), J(uiFn('emptyChat')()));
  // T10⑥ 改「沒有暫存才重設」：預設值住在 restoreWorkspace，openWorkflow 不再直接寫 flowTab／mode／paramNow
  const ow = /async function openWorkflow\([\s\S]*?\n\}\n/.exec(uiSrc())[0];
  for (const s of ["state.flowTab = 'design'", "state.mode = 'list'", 'state.paramNow = {}', 'state.canvasSel = null', 'state.memPicks = {}', 'state.memIdentitySet = false']) assert.equal(ow.includes(s), false, `openWorkflow 不該直接重設：${s}`);
});

test('P3 ③：vm——stashWorkspace：已存流程→wsByFlow.get(key) 十四鍵齊、不含 run／versions／wfRuns／wfFiles／shared；草稿（wf null＋chat.draft）→ __draft__；wf null 沒草稿→不存；wf 開著但主體是草稿→不存', () => {
  const ws = new Map();
  const state = p3State({ run: { run_id: 'r' }, mode: 'canvas', flowTab: 'data', paramNow: { x: '1' }, canvasSel: 'n1', cvWork: { name: 'A' }, cvDirty: true });
  uiFn('stashWorkspace', { state, wsByFlow: ws })();
  const p = ws.get('旅遊/a');
  assert.ok(p, '存在 旅遊/a');
  assert.deepEqual(Object.keys(p).sort(), ['canvasSel', 'chat', 'cvDirty', 'cvWork', 'drawerOpen', 'expanded', 'flowTab', 'folderOpen', 'memChanged', 'memIdentity', 'memIdentitySet', 'memPicks', 'mode', 'paramNow', 'runUploads', 'runNote'].sort(), '十四鍵＋排版輪 L11 本次上傳與本次補充兩鍵（跟著那條 Workflow 暫存）');
  for (const k of ['run', 'versions', 'wfRuns', 'wfFiles', 'shared', 'wf']) assert.equal(k in p, false, `不暫存 ${k}`);
  assert.equal(p.mode, 'canvas'); assert.equal(p.paramNow.x, '1'); assert.equal(p.canvasSel, 'n1'); assert.equal(p.cvDirty, true);
  const ws2 = new Map();
  const draft = { name: '草稿', nodes: [], params: [] };
  uiFn('stashWorkspace', { state: p3State({ wf: null, chat: { messages: [], draft, busy: false }, mode: 'chat' }), wsByFlow: ws2 })();
  assert.equal(ws2.get('__draft__')?.chat.draft, draft, '草稿存 __draft__');
  assert.equal(ws2.get('__draft__').mode, 'chat');
  const ws3 = new Map();
  uiFn('stashWorkspace', { state: p3State({ wf: null }), wsByFlow: ws3 })();
  assert.equal(ws3.size, 0, 'wf null 沒草稿→不存');
  const ws4 = new Map();
  uiFn('stashWorkspace', { state: p3State({ chat: { messages: [], draft, busy: false } }), wsByFlow: ws4 })();
  assert.equal(ws4.size, 0, 'wf 開著但主體是草稿→不存（同舊 chatByFlow 規則）');
  // 第一趟還在等（只有訊息、busy）或只有訊息→也算草稿，打包進 __draft__
  const ws5 = new Map();
  uiFn('stashWorkspace', { state: p3State({ wf: null, chat: { messages: [{ role: 'user', text: 'hi' }], draft: null, shape: null, busy: true } }), wsByFlow: ws5 })();
  assert.ok(ws5.has('__draft__'), '第一趟等待中離開→__draft__');
  const ws6 = new Map();
  uiFn('stashWorkspace', { state: p3State({ wf: null, chat: { messages: [{ role: 'user', text: 'hi' }], draft: null, shape: null, busy: false } }), wsByFlow: ws6 })();
  assert.ok(ws6.has('__draft__'), '只有訊息→__draft__');
});

// 側欄草稿列改判 draftLive()（跟 stashWorkspace／dsSnapshot 同一式），假 state 要有 chat
const emptyChatLike = (extra = {}) => ({ messages: [], draft: null, shape: null, busy: false, ...extra });

test('P3 ④：sideHtml——wsByFlow 有 __draft__→一列 .flow-row.draftrow data-act="open-draft"「草稿・還沒存」（排版輪 F3：挪到「＋ 建立新 Workflow」下方，不再進分類樹）；有沒有「未分類」都同一個位置；正在看的草稿→.active；沒有草稿→0 命中；CSS .flow-row.draftrow 虛線框', () => {
  const ws = new Map([['__draft__', p3Pkg()]]);
  const side = (extra = {}, helpers = {}) => uiFn('sideHtml', { state: { categories: ['旅遊', '未分類'], workflows: [{ id: 'a', name: 'A', category: '旅遊' }], trash: [], notices: { unread: [] }, catClosed: new Set(), categoryPage: null, wf: null, calendar: null, settings: null, library: null, dash: null, addingCategory: false, companyName: '', chat: emptyChatLike(), ...extra }, wsByFlow: ws, ...helpers })();
  const html = side();
  assert.equal(count(html, 'class="flow-row draftrow"'), 1, '草稿列一列');
  assert.ok(html.includes('data-act="open-draft"') && html.includes('草稿・還沒存'), '草稿列字與事件');
  const uncat = /<details class="cat" data-cat="未分類"[\s\S]*?<\/details>/.exec(html)[0];
  assert.ok(!uncat.includes('draftrow'), '排版輪 F3：草稿列不再塞進「未分類」群組');
  assert.ok(!/<details class="cat" data-cat="旅遊"[\s\S]*?<\/details>/.exec(html)[0].includes('draftrow'), '旅遊群組沒有');
  assert.ok(html.indexOf('class="flow-row draftrow') > html.indexOf('data-act="new-flow"'), '在「＋ 建立新 Workflow」下方');
  const bottom = side({ categories: ['旅遊'] });
  assert.equal(count(bottom, 'draftrow'), 1, '沒有「未分類」→仍一列');
  assert.ok(bottom.indexOf('class="flow-row draftrow') < bottom.indexOf('<div class="tree">'), '沒有「未分類」→位置照舊在樹上方（不再掉到整棵樹最底端）');
  const none = uiFn('sideHtml', { state: { categories: ['旅遊', '未分類'], workflows: [], trash: [], notices: { unread: [] }, catClosed: new Set(), categoryPage: null, wf: null, calendar: null, settings: null, library: null, dash: null, addingCategory: false, companyName: '', chat: emptyChatLike() }, wsByFlow: new Map() })();
  assert.equal(count(none, 'draftrow'), 0, '沒草稿→無');
  const now = uiFn('sideHtml', { state: { categories: ['旅遊', '未分類'], workflows: [], trash: [], notices: { unread: [] }, catClosed: new Set(), categoryPage: null, wf: null, calendar: null, settings: null, library: null, dash: null, addingCategory: false, companyName: '', chat: emptyChatLike({ draft: { name: 'A', nodes: [] } }) }, wsByFlow: new Map() })();
  assert.ok(now.includes('class="flow-row draftrow active"'), '正在看的草稿列亮著');
  assert.ok(cssRule('.flow-row.draftrow')?.includes('dashed'), `.flow-row.draftrow 虛線框：${cssRule('.flow-row.draftrow')}`);
});

// （驗收第 4 條）：「有改動未存」chip 改成版本標籤本身——有未存改動時「未儲存」優先顯示（取代版本號）、點了開履歷；工具列另有「有改動未存檔」一句
test('P3 ⑤：workHeadHtml——cvDirty→標題旁 <span class="chip wait vertag" data-act="mode-history">未儲存（取代 v3・現行）；乾淨→v3・現行、無未儲存；草稿 chip wait；標題列內 chip amber 0 命中', () => {
  const base = { chat: { draft: null }, versions: [{ version: 3 }], categories: ['旅遊'], flowTab: 'design', mode: 'canvas', companyName: '範例公司', wf: { category: '旅遊', id: 'a', def: { name: 'A', nodes: [] } } };
  const dirty = uiFn('workHeadHtml', { state: { ...base, cvDirty: true } })();
  const head = /<div class="heading">[\s\S]*?<\/div>/.exec(dirty)[0];
  assert.ok(/<span class="chip wait vertag" data-act="mode-history"[^>]*><i class="ph ph-pencil-simple-line"><\/i>未儲存<\/span>/.test(head), `未儲存 chip：${head}`);
  assert.equal(count(head, '現行'), 0, '未儲存優先（版本號不並列）');
  const clean = uiFn('workHeadHtml', { state: { ...base, cvDirty: false } })();
  const cleanHead = /<div class="heading">[\s\S]*?<\/div>/.exec(clean)[0];
  assert.equal(count(cleanHead, '未儲存'), 0, '乾淨→無');
  assert.ok(cleanHead.includes('v3・現行'), '乾淨→版本號');
  const draft = uiFn('workHeadHtml', { state: { ...base, wf: null, chat: { draft: { name: '草稿 X', nodes: [], params: [] } } } })();
  assert.ok(draft.includes('<span class="chip wait"><i class="ph ph-pencil-simple-line"></i>草稿・還沒存</span>'), '草稿 chip 改 wait');
  assert.equal(count(/<div class="heading">[\s\S]*?<\/div>/.exec(draft)[0], 'chip amber'), 0, '標題列內沒有 amber');
  assert.equal(count(head, 'chip amber'), 0);
});

// ---------- 聊天窗成品卡空殼----------
const SHAPE_FIX = () => ({
  deliverable: { value: '新聞播報稿', basis: '你說的' }, type: { value: '文字稿', basis: '預設' }, audience: { value: 'VTuber 觀眾', basis: '自我介紹' },
  style: { value: '輕鬆', basis: '分類守則' }, length: { value: '800 字', basis: '公司規範' }, sections: { value: '3 段', basis: '預設' }, range: { value: '本週', basis: '你說的' },
});
const SRC_FIX = () => [{ name: '本週大事', from: 'web', note: '只取本週' }, { name: '節目口頭禪', from: 'paste', note: '每次不一樣' }, { name: '行事曆', from: 'later', note: '還沒接' }];
const p4State = (extra = {}) => ({ chat: { messages: [], draft: null, busy: false, shape: SHAPE_FIX(), sources: SRC_FIX(), category: '旅遊', shapeEdit: null }, categories: ['旅遊', '未分類'], keep: {}, run: null, wf: null, claude: true, ...extra });

test('P4 ①：shapeCardHtml——七格依序（排版輪 L9 題 5-4：常駐輸入框 data-shape-input＋中文＋依據小字七個＋值＝fixture）、來源三列（名稱／膠囊字／備註；paste＝chip wait、later＝chip quiet）、#shape-category 選中「旅遊」末項「不分類」、兩鈕 shape-redo／shape-confirm', () => {
  const html = uiFn('shapeCardHtml', { state: p4State() })();
  assert.ok(html.includes('data-shapecard') && html.includes('成品長相') && html.includes('待你確認'), '卡框、標題、待你確認');
  const keys = [...html.matchAll(/data-shape-input="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['deliverable', 'type', 'audience', 'style', 'length', 'sections', 'range'], '七格順序');
  const cells = [...html.matchAll(/<span class="label">([^<]+)<span class="basis">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(cells.map((c) => c[0]), ['成品', '型態', '對象', '段子或風格', '長度', '分段', '範圍'], '七格中文');
  assert.deepEqual(cells.map((c) => c[1]), ['你說的', '預設', '自我介紹', '分類守則', '組織規範', '預設', '你說的'], '依據小字七個（BASIS_TXT 換字，資料值不變）');
  for (const [k, v] of [['deliverable', '新聞播報稿'], ['type', '文字稿'], ['audience', 'VTuber 觀眾'], ['style', '輕鬆'], ['length', '800 字'], ['sections', '3 段'], ['range', '本週']]) {
    assert.ok(new RegExp(`data-shape-input="${k}"[^>]*value="${v}"`).test(html), `${k} 值＝${v}`);
  }
  assert.ok(html.includes('資料從哪來') && html.includes('<div class="srclist">'), '資料從哪來清單（排版輪 L9：樣稿逐列，取代小表）');
  const rows = [...html.matchAll(/<div class="srcrow">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert.equal(rows.length, 3, '三列');
  assert.ok(rows[0].includes('本週大事') && rows[0].includes('<span class="chip">AI 上網查</span>') && rows[0].includes('只取本週'), `web 列：${rows[0]}`);
  assert.ok(rows[1].includes('節目口頭禪') && rows[1].includes('<span class="chip wait">你貼・必填</span>') && rows[1].includes('每次不一樣'), `paste 列：${rows[1]}`);
  assert.ok(rows[2].includes('行事曆') && rows[2].includes('<span class="chip quiet">連接器・未接</span>') && rows[2].includes('還沒接'), `later 列：${rows[2]}`);
  const sel = /<select id="shape-category">([\s\S]*?)<\/select>/.exec(html);
  assert.ok(sel, '分類下拉');
  assert.ok(/<option value="旅遊" selected>旅遊<\/option>/.test(sel[1]), `預選旅遊：${sel[1]}`);
  assert.ok(/<option value="未分類"\s*>不分類<\/option>\s*$/.test(sel[1]), `末項不分類：${sel[1]}`);
  assert.equal(count(sel[1], '<option'), 2, '「未分類」不重複列');
  assert.ok(html.includes('data-act="shape-redo"') && html.includes('data-act="shape-confirm"'), '兩鈕');
  assert.ok(/data-act="shape-redo"[^>]*>[^<]*<i class="ph [^"]+"><\/i>重擬</.test(html) && /data-act="shape-confirm"[^>]*>[^<]*<i class="ph [^"]+"><\/i>照這樣拆</.test(html), '短詞＋Phosphor 圖標');
  assert.equal(count(html, 'disabled'), 0, '不 busy 沒 disabled');
});

test('P4 ②：shapeCardHtml——shape:null→\'\'；來源空→仍印小表但一列「（拆解器沒列）」；category null→預選「不分類」；六種 from 的膠囊字全對、不認識的 from 當 paste', () => {
  assert.equal(uiFn('shapeCardHtml', { state: p4State({ chat: { messages: [], draft: null, busy: false, shape: null, sources: [], category: null, shapeEdit: null } }) })(), '');
  const html = uiFn('shapeCardHtml', { state: p4State({ chat: { messages: [], draft: null, busy: false, shape: SHAPE_FIX(), sources: [], category: null, shapeEdit: null } }) })();
  assert.ok(html.includes('拆解器沒列'), '來源空的一列');
  assert.ok(/<option value="未分類" selected>不分類<\/option>/.test(html), 'category null→不分類');
  const six = uiFn('shapeCardHtml', { state: p4State({ chat: { messages: [], draft: null, busy: false, shape: SHAPE_FIX(), category: '旅遊', shapeEdit: null, sources: ['web', 'paste', 'upload', 'shared', 'upstream', 'later', 'zzz'].map((f) => ({ name: f, from: f, note: '' })) } }) })();
  for (const [f, txt, cls] of [['web', 'AI 上網查', 'chip'], ['paste', '你貼・必填', 'chip wait'], ['upload', '你上傳', 'chip'], ['shared', '組織／分類參考檔', 'chip'], ['upstream', '前一步', 'chip'], ['later', '連接器・未接', 'chip quiet']]) {
    assert.ok(six.includes(`<span class="srcname">${f}</span><span class="${cls}">${txt}</span>`), `${f}→${txt}（${cls}）`);
  }
  assert.ok(six.includes('<span class="srcname">zzz</span><span class="chip wait">你貼・必填</span>'), '不認識的 from 當 paste');
  // 覆核該修①：value 空（「用不到＝value:''＋basis:'預設'」）→輸入框空值、提示「（空）」，不印空膠囊
  const blank = uiFn('shapeCardHtml', { state: p4State({ chat: { ...p4State().chat, shape: { ...SHAPE_FIX(), sections: { value: '', basis: '預設' } } } }) })();
  assert.ok(/data-shape-input="sections"[^>]*value=""[^>]*placeholder="（空）"/.test(blank), `空值格提示「（空）」：${/<input[^>]*data-shape-input="sections"[^>]*>/.exec(blank)?.[0]}`);
  assert.equal(count(blank, '（空）'), 1, '只有那一格');
});

test('P4 ③b：vm——shapeInput（排版輪 L9 題 5-4 常駐輸入框，取代 commitShapeEdit）：改了字→value 換、basis 改「你說的」；改回原樣→value 與 basis 回拆解器給的（不假冒成你說的）；原樣快照只取一次、新卡清掉；沒卡→不動', () => {
  const state = p4State();
  const set = uiFn('shapeInput', { state });
  set('audience', '新對象');
  assert.equal(J(state.chat.shape.audience), J({ value: '新對象', basis: '你說的' }), '改了字→你說的');
  assert.equal(state.chat.shapeBase.audience.basis, '自我介紹', '原樣快照留拆解器給的');
  set('audience', '新對象再改');
  assert.equal(state.chat.shapeBase.audience.value, 'VTuber 觀眾', '快照不跟著改');
  set('audience', 'VTuber 觀眾');
  assert.equal(J(state.chat.shape.audience), J({ value: 'VTuber 觀眾', basis: '自我介紹' }), '覆核該修②：改回原樣→basis 仍「自我介紹」');
  set('sections', '');
  assert.equal(J(state.chat.shape.sections), J({ value: '', basis: '你說的' }), '清空也是你說的（第二趟照空格不做欄位）');
  assert.equal(J(state.chat.shape.type), J({ value: '文字稿', basis: '預設' }), '別格不動');
  const none = p4State({ chat: { ...p4State().chat, shape: null } });
  uiFn('shapeInput', { state: none })('audience', 'x');
  assert.equal(none.chat.shape, null, '沒卡→不動');
  assert.equal(count(uiSrc(), 'shapeEdit'), 0, '點改機制退場（shapeEdit 0 命中）');
  assert.equal(count(uiSrc(), 'function commitShapeEdit('), 0, 'commitShapeEdit 退場');
  const sc = fnSrc('sendChat');
  assert.ok(count(sc, 'chat.shapeBase = null') >= 2, '出新卡、拆好收卡都清原樣快照');
});

test('P4 ③：七格一直是輸入框——<input data-keep data-shape-input>（值＝state 格值，輪詢重繪讀 state 不洗字）、沒有 shape-edit chip；basis 小字七個；busy→七格 disabled', () => {
  const html = uiFn('shapeCardHtml', { state: p4State() })();
  assert.ok(/<input [^>]*id="shape-in-type"[^>]*data-keep[^>]*data-shape-input="type"[^>]*value="文字稿"/.test(html), `型態格是輸入框：${html}`);
  assert.equal(count(html, 'data-shape-input='), 7, '七格都是輸入框');
  assert.equal(count(html, 'data-act="shape-edit"'), 0, '沒有點改 chip');
  assert.equal(count(html, '<span class="basis">'), 7, '依據小字七個不少');
  const typed = p4State();
  typed.chat.shape.type = { value: '打到一半', basis: '你說的' };
  assert.ok(uiFn('shapeCardHtml', { state: typed })().includes('value="打到一半"'), '輪詢重繪：打的字已寫進 state，重繪放回輸入框');
  const busy = uiFn('shapeCardHtml', { state: p4State({ chat: { ...p4State().chat, busy: true } }) })();
  // 卡下半段多了四顆檔案種類與一顆選舊作品，busy 時也要一起鎖住（PDF 那顆本來就點不下去，不算）
  assert.equal(count(busy, 'disabled'), 14, '七格＋兩鈕＋四顆檔案種類＋一顆選舊作品 disabled');
});

test('P4 ④：chatModeHtml——有 shape→含 data-shapecard、卡在表單與訊息之後（排版輪 L9：表單卡在上、對話紀錄在下、卡最後）、有草稿也不印 save-draft；沒 shape→現況（草稿印 save-draft、無卡）；busy→兩鈕 disabled', () => {
  const draft = { name: '草稿', nodes: [], params: [] };
  const withCard = uiFn('chatModeHtml', { state: p4State({ chat: { ...p4State().chat, draft, messages: [{ role: 'ai', text: '先看成品' }] } }) })();
  assert.ok(withCard.includes('data-shapecard'), '有卡');
  assert.equal(count(withCard, 'data-act="save-draft"'), 0, '卡在時不印 save-draft');
  assert.ok(withCard.indexOf('id="chat-input"') < withCard.indexOf('data-shapecard'), '卡在表單卡之後');
  assert.ok(withCard.indexOf('class="msg ai"') < withCard.indexOf('data-shapecard'), '卡在訊息之後');
  const noCard = uiFn('chatModeHtml', { state: p4State({ chat: { messages: [], draft, busy: false, shape: null, sources: [], category: null, shapeEdit: null } }) })();
  assert.equal(count(noCard, 'data-shapecard'), 0, '沒 shape→無卡');
  assert.equal(count(noCard, 'data-act="save-draft"'), 1, '沒 shape→現況 save-draft');
  assert.equal(count(noCard, 'data-act="clear-draft"'), 1);
  const busy = uiFn('chatModeHtml', { state: p4State({ chat: { ...p4State().chat, busy: true } }) })();
  assert.ok(/data-act="shape-redo"[^>]*\bdisabled/.test(busy) && /data-act="shape-confirm"[^>]*\bdisabled/.test(busy), `busy→兩鈕 disabled：${/<div class="btns"[\s\S]*?<\/div>/.exec(busy)?.[0]}`);
});

test('P4 ⑤：原文——shape-confirm／shape-redo 分支只 console.info、0 命中 /api/compose；emptyChat() ≥5、舊字面 { messages: [], draft: null, busy: false } 0 命中；data-shape-input／shape-category 事件都在；clear-draft 與 new-flow 走 emptyChat；CSS 有 .shapecard／.shapegrid 兩欄／.basis／.srcrow', () => {
  const src = uiSrc();
  // W1 接線後：兩鈕各一個分支（原 P4 空殼「只 console.info、0 命中 /api/compose」由 W1 ②③ 取代）
  assert.equal(count(src, "act === 'shape-confirm'"), 1, 'shape-confirm 只有這一處');
  assert.equal(count(src, "act === 'shape-redo'"), 1, 'shape-redo 只有這一處');
  assert.ok(count(src, 'emptyChat()') >= 5, `emptyChat() ≥5：${count(src, 'emptyChat()')}`);
  assert.equal(count(src, '{ messages: [], draft: null, busy: false }'), 0, '舊字面 0 命中');
  assert.equal(count(src, 'function emptyChat()'), 1);
  assert.equal(count(src, "act === 'shape-edit'"), 0, '排版輪 L9：點改分支退場（七格常駐輸入框）');
  assert.ok(src.includes("t.matches?.('[data-shape-input]')") && src.includes('shapeInput(t.dataset.shapeInput, t.value)') && src.includes("e.target.id === 'shape-category'"), '兩個事件：打字寫回 state、分類下拉');
  // 分身實走抓到的：render 換 DOM 拔掉聚焦中的輸入框→瀏覽器同步發 blur→巢狀 render 炸 NotFoundError。旗標留著；常駐輸入框不靠 blur 收尾，重繪後焦點與游標放回打字中的那格
  assert.equal(count(src, 'let rendering = false'), 1, 'rendering 旗標');
  assert.equal(count(src, 'commitShapeEdit('), 0, 'focusout 收尾退場');
  const rd = /function render\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(rd.includes('rendering = true;') && rd.includes('finally { rendering = false; }'), 'render 換 DOM 期間舉旗');
  assert.ok(rd.includes("const typing = fa?.matches?.('[data-keep][id]') ? { id: fa.id, s: fa.selectionStart, e: fa.selectionEnd } : null;") && rd.includes('ed.setSelectionRange(typing.s, typing.e)'), '重繪後焦點與游標放回打字中的輸入框');
  // 分身實走抓到的：卡出來時還沒有草稿（chat.draft null），P3 的 stashWorkspace 不會把它當 __draft__ 存→切去別條流程卡就沒了。改成「有草稿或有卡」都存
  const ws = new Map();
  uiFn('stashWorkspace', { state: { wf: null, run: null, chat: { messages: [], draft: null, busy: false, shape: SHAPE_FIX(), sources: SRC_FIX(), category: '旅遊', shapeEdit: null }, mode: 'chat', flowTab: 'design', canvasSel: null, drawerOpen: false, paramNow: {}, memPicks: {}, memChanged: [], memIdentity: '', memIdentitySet: false, folderOpen: {}, expanded: new Set(), cvWork: null, cvDirty: false }, wsByFlow: ws })();
  assert.equal(ws.get('__draft__')?.chat.shape?.type.value, '文字稿', '只有卡、沒草稿→也存進 __draft__（切走再回來卡還在）');
  const clear = /else if \(act === 'clear-draft'\) \{[\s\S]*?\n {4}\}/.exec(src)[0];
  assert.ok(clear.includes('emptyChat()'), 'clear-draft 清 shape（走 emptyChat）');
  const nf = /else if \(act === 'new-flow'\) \{[\s\S]*?\n {4}\}/.exec(src)[0];
  assert.ok(nf.includes('state.chat = emptyChat()'), 'new-flow 清 shape');
  assert.ok(cssRule('.shapecard'), '.shapecard');
  assert.ok(cssRule('.shapegrid')?.includes('grid-template-columns:1fr 1fr'), `.shapegrid 兩欄：${cssRule('.shapegrid')}`);
  assert.ok(cssRule('.basis')?.includes('--ink-400'), `.basis 灰小字：${cssRule('.basis')}`);
  assert.ok(cssRule('.srcrow')?.includes('border-bottom:1px solid'), `.srcrow 樣稿 .file 逐列：${cssRule('.srcrow')}`);
  assert.equal(cssRule('.pchip.shapechip') ?? cssRule('.srctable'), null, '點改 chip 與小表 CSS 退場');
  assert.ok(cssRule('.shapein')?.includes('width:100%') && cssRule('.shapein').includes('border-radius:9px'), `常駐輸入框：${cssRule('.shapein')}`);
});

// ---------- 其餘頁面換皮（「選取語彙」＋頁面級頂線）----------
test('P5 ①：dashHtml——「要你處理」<section class="crs panel-wait">、「最近完成」dashsec panel-done、右欄四塊 asideblock、只有「流程提議」那塊 panel-blue；U5①／T5③ 續綠', () => {
  const h = uiFn('dashHtml', u5Ctx())();
  const [main, aside] = u5Split(h);
  // 三塊都換樣稿 .panel 白卡；提議搬左欄第三塊（藍底），右欄三塊 asideblock
  assert.ok(main.includes('<section class="panel panel-wait">'), `要你處理＝琥珀頂線：${main.slice(0, 120)}`);
  assert.ok(main.includes('<section class="panel panel-done">'), '最近完成＝低彩綠頂線');
  assert.equal(count(main, 'panel-'), 3, '左欄三個頂線／底色 class');
  assert.equal(count(aside, '<section class="panel asideblock'), 3, '右欄三塊都是 asideblock');
  const prop = /<section class="([^"]*)">\s*<div class="section-head"><h2>Workflow 提議/.exec(main);
  assert.equal(prop?.[1], 'panel panel-blue', `流程提議＝藍底：${prop?.[1]}`);
  assert.equal(count(main, 'panel-blue'), 1, '只有提議那塊藍');
  assert.equal(count(aside, 'panel-wait') + count(aside, 'panel-done') + count(aside, 'panel-blue'), 0, '右欄沒有頂線與藍底');
});

test('P5 ②：CSS——.libcard 頂線 3px #c4cfee；.setnav .it.on＝#dfe7fc＋左靛藍條；.runstep.active＝#e6ecff＋#b1c1ec 框（底框透明不跳）；.mcell.today .d 靛藍底白字；.overline #526aa0；.memnotice／.alert 琥珀 #fff3db；.cev #e9effb／條 #7088c8；.seg span.on 白底靛藍字；.panel-wait h4 #825716', () => {
  assert.ok(cssRule('.flowcard')?.includes('border-top:3px solid #c4cfee'), `.flowcard（排版輪 L5 由 .libcard 改名）：${cssRule('.flowcard')}`);
  const on = cssRule('.setnav .it.on');
  assert.ok(on?.includes('background:#dfe7fc') && on.includes('box-shadow:inset 3px 0 var(--accent)'), `.setnav .it.on：${on}`);
  const rs = cssRule('.runstep.active');
  assert.ok(rs?.includes('background:#e6ecff') && rs.includes('border-color:#b1c1ec'), `.runstep.active：${rs}`);
  assert.ok(cssRule('.runstep')?.includes('border:1px solid transparent'), '.runstep 底框透明，選中不跳 1px');
  const td = cssRule('.mcell.today .d');
  assert.ok(td?.includes('background:var(--accent)') && td.includes('color:#fff'), `.mcell.today .d：${td}`);
  assert.ok(cssRule('.overline')?.includes('color:#526aa0'), `.overline：${cssRule('.overline')}`);
  const mn = cssRule('.memnotice');
  assert.ok(mn?.includes('background:#fff3db') && mn.includes('#ead1a2') && mn.includes('color:#815820'), `.memnotice：${mn}`);
  assert.ok(cssRule('.memnotice>i')?.includes('var(--amber-text)'), '.memnotice 圖標琥珀字');
  assert.ok(cssRule('.alert')?.includes('background:#fff3db'), `.alert（健檢卡 warn）：${cssRule('.alert')}`);
  assert.ok(cssRule('.cev')?.includes('background:#e9effb'), `.cev：${cssRule('.cev')}`);
  assert.ok(cssRule('.cev::before')?.includes('background:#7088c8'), `.cev::before：${cssRule('.cev::before')}`);
  assert.ok(cssRule('.cev.makeup')?.includes('background:#fff2d8'), '.cev.makeup（補跑＝等你）琥珀底');
  assert.equal(cssRule('.seg span.on'), 'background:#fff;color:var(--accent-text);box-shadow:var(--e1)', 'seg .on 白底靛藍字');
  assert.ok(cssRule('.panel-wait h2')?.includes('color:#825716'), '要你處理標題琥珀字（排版輪 L5 標題 h4→h2）');
  // 分身抓到的：.homeaside .asideblock（兩層）壓過 .panel-blue（一層），右欄提議塊算出來還是 #edf1f8
  assert.ok(cssRule('.homeaside .asideblock.panel-blue')?.includes('background:#f0f3ff'), '右欄提議塊要同權重規則才藍得起來');
});

test('P5 ③：六個卡片函式原文釘住（sha1 ＝ P5 開工前 HEAD 3f8e9d9 的原文）——dashRunCard／stopCardHtml／checkCardHtml／humanCardHtml／dataCardHtml／failCardHtml 一字不動', () => {
  const pins = {
    dashRunCard: '2bf8eaa352d7e127aef94e3c93bbf5b32687d367', stopCardHtml: '38fe9a612e2aa03e7420e149fa77732e2309de06', checkCardHtml: 'c4f0a269dd883debf93f3fe62f1fb61c79a2e697',
    humanCardHtml: 'e63dfa6fdb2a765113d651fdfeb9eaab2a7243dc', dataCardHtml: '6894843650dcc0817d3cfd3676ec7d8f85c395a9', failCardHtml: '237846d095d4c42193fd1026a80544e1a4bbe37c',
  };
  for (const [name, sha] of Object.entries(pins)) {
    const st = uiStmts().find((s) => s.kind === 'fn' && s.name === name);
    assert.ok(st, `有 function ${name}`);
    assert.equal(createHash('sha1').update(st.text.replace(/\r\n/g, '\n')).digest('hex'), sha, `${name} 原文變了（要改卡片函式不是 P5 的事）`);
  }
});

test('P5 ④：style.css 舊色 #0a84ff／#f5f3ef／#fcfbf9 0 命中；style.css 與 app.js 零 emoji', () => {
  const css = cssSrc();
  for (const c of ['#0a84ff', '#f5f3ef', '#fcfbf9']) assert.equal(count(css, c), 0, `${c} 該 0 命中`);
  const emo = /\p{Extended_Pictographic}/u;
  assert.ok(!emo.test(css), 'style.css 零 emoji');
  assert.ok(!emo.test(uiSrc()), 'app.js 零 emoji');
});

test('P5 ⑤：.step.sel 寫法不動（P5 不碰；T5⑥ 續綠）', () => {
  assert.equal(cssRule('.step.sel'), 'background:rgb(var(--accent-rgb) / .12);outline:2px solid var(--accent);outline-offset:-2px');
});

test('P5 ⑥（收 P2 範圍外兩條）：sideHtml——儀表板開著時流程列不標 active／now（四全域項照舊）；沒開儀表板照舊 active；CSS 舊 .cat .nm 字級規則收掉、.company-children .cat .nm 覆寫 0 命中', () => {
  const base = { categories: ['旅遊', '未分類'], workflows: [{ id: 'a', name: 'A', category: '旅遊' }], trash: [], notices: { unread: [] }, catClosed: new Set(), categoryPage: null, wf: { id: 'a', category: '旅遊', def: { name: 'A' } }, calendar: null, settings: null, library: null, dash: null, addingCategory: false, companyName: '', chat: emptyChatLike() };
  const side = (extra = {}) => uiFn('sideHtml', { state: { ...base, ...extra }, subjectIsDraft: () => false, wsByFlow: new Map() })();
  const flow = side();
  assert.equal(count(flow, 'class="flow-row active"'), 1, '在流程頁：那條 active');
  assert.equal(count(flow, 'class="wf now"'), 1, '在流程頁：那條 now');
  const d = side({ dash: { data: null } });
  assert.equal(count(d, 'flow-row active'), 0, '儀表板開著：流程列不 active');
  assert.equal(count(d, 'class="wf now"'), 0, '儀表板開著：流程列不 now');
  assert.ok(d.includes('class="wf calentry now" data-act="open-dash"'), '儀表板項自己選中');
  const css = cssSrc();
  assert.equal(count(css, '.company-children .cat .nm'), 0, '覆寫規則收掉');
  const nm = cssRule('.cat .nm');
  assert.ok(nm?.includes('font-size:12px') && nm.includes('cursor:pointer') && !nm.includes('10.5px'), `.cat .nm 直接寫 DEMO 分類列字級：${nm}`);
});

// ---------- 接線——前端兩趟＋設定開關列＋自動確認灰字----------
const fnSrc = (name) => { const m = new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(uiSrc()); assert.ok(m, `app.js 有頂層 function ${name}`); return m[0]; };
const actBranch = (act) => { const m = new RegExp(`else if \\(act === '${act}'\\) \\{?[\\s\\S]*?(?=\\n {4}(?:\\}\\n {4})?else if \\(|\\n {4}\\}\\n {2}\\})`).exec(uiSrc()); assert.ok(m, `事件委派有 ${act} 分支`); return m[0]; };

test('W1 ①：sendChat——無草稿且無卡→不明帶 phase（伺服器缺省解析成 shape；B4 定案明帶 shape 永遠不連跑，開關關掉要靠缺省）、回應 phase shape 存 state.chat.shape/sources/category（空→第一個分類或「未分類」）；句含「重拆」（/重拆/）且有草稿→明帶 phase shape＋current_draft 照帶；有草稿→現況不帶 shape；auto→存 autoShape 不出卡', () => {
  const s = fnSrc('sendChat');
  assert.equal(count(s, "phase: 'shape'"), 1, '只有「重拆」那條明帶 phase shape；第一趟不明帶（否則開關關掉也連跑不了）');
  assert.ok(s.includes("current && /重拆/.test(text) ? { phase: 'shape' } : {}"), `明帶只在有草稿且句含重拆：${/round = [^\n]*/.exec(s)?.[0]}`);
  assert.ok(s.includes("out.phase === 'shape' && !out.auto"), '出卡看回應的 phase，不看自己送了什麼');
  assert.ok(s.includes('chat.shape = out.shape'), '回應的 shape 存進發問工作區的 chat.shape（排版輪 L1：綁 chat，不寫 state.chat）');
  assert.ok(s.includes('chat.sources = out.sources'), 'sources 存進 chat');
  assert.ok(s.includes('chat.category = out.category'), 'category 存進 chat');
  assert.ok(/out\.category \?\? [^;]*'未分類'/.test(s), `category 空→第一個分類或「未分類」：${/chat\.category = [^\n]*/.exec(s)?.[0]}`);
  assert.ok(s.includes('/重拆/'), '「重拆」判斷用 /重拆/');
  assert.ok(s.includes('current_draft: current'), 'current_draft 照帶（重拆時拆解器當背景）');
  assert.ok(s.includes('chat.autoShape = out.shape'), 'auto:true→shape 存進 autoShape');
  assert.ok(s.includes('out.auto'), '看 auto 旗');
  assert.ok(s.includes('chat.draft = out.draft'), '第二趟／現況：草稿存回');
  assert.ok(s.indexOf('chat.draft = out.draft') < s.indexOf('chat.shape = null'), '拆好草稿後清卡（不在第二趟後再出卡）');
  assert.equal(count(s, 'state.chat.'), 0, '排版輪 L1：sendChat 內 0 處寫 state.chat.（全綁開頭抓的 chat）');
  assert.equal(count(uiSrc(), 'autoShape: null'), 1, 'emptyChat() 加 autoShape:null');
  assert.ok(fnSrc('emptyChat').includes('autoShape: null'), 'autoShape 在 emptyChat 裡');
});

test('W1 ②：shape-confirm 分支——phase: \'draft\'、shape: state.chat.shape、sources: state.chat.sources、category: state.chat.category；成功後 state.chat.shape = null（sendChat 收到 draft 就清）', () => {
  const b = actBranch('shape-confirm');
  assert.ok(b.includes("phase: 'draft'"), `帶 phase draft：${b}`);
  assert.ok(b.includes('shape: state.chat.shape') && b.includes('sources: state.chat.sources') && b.includes('category: state.chat.category'), `卡上三樣帶回去：${b}`);
  assert.equal(count(b, 'console.info'), 0, '不再是 P4 空殼');
  assert.equal(count(uiSrc(), "act === 'shape-confirm'"), 1, 'shape-confirm 只有這一處');
  assert.ok(count(fnSrc('sendChat'), 'chat.shape = null') >= 1, '拆好後清卡（排版輪 L1：sendChat 綁發問的 chat）');
});

test('W1 ③：shape-redo 分支——重送最後一句 phase: \'shape\'（明帶，伺服器不連跑）；不帶 shape 回去', () => {
  const b = actBranch('shape-redo');
  assert.ok(b.includes("phase: 'shape'"), `重擬帶 phase shape：${b}`);
  assert.equal(count(b, 'shape: state.chat.shape'), 0, '重擬不把卡帶回去');
  assert.equal(count(b, 'console.info'), 0, '不再是 P4 空殼');
});

test('W1 ④：setDefaultsHtml 停點分頁——「拆之前先確認成品長相」列＋data-act="set-compose-sw" 開（confirm_shape:true）；compose 缺→仍視為開；false→關；「權限與查核」「AI 步驟」0 命中', () => {
  const on = secOf(uiFn('setDefaultsHtml', t8DefCtx('停點'))({ cfg: { defaults: {}, compose: { confirm_shape: true } } }), '停點'); // 分頁改分段
  assert.ok(on.includes('拆之前先確認成品長相'), '開關列標題');
  assert.ok(on.includes('關掉＝一句話直接出草稿；等分類拆法偏好學會了再關比較保險。'), '契約 F 原句');
  assert.ok(/<span class="sw on" data-act="set-compose-sw" data-k="confirm_shape" role="switch" aria-checked="true">開<i><\/i><\/span>/.test(on), `開關開：${/<span class="sw[^>]*set-compose-sw[^<]*<i><\/i><\/span>/.exec(on)?.[0]}`);
  assert.ok(on.includes('哪幾步要停下來等你，在每個步驟自己的設定裡改，不在這一頁。'), 'T8② 停點指路句續在');
  const missing = uiFn('setDefaultsHtml', t8DefCtx('停點'))({ cfg: { defaults: {} } });
  assert.ok(/<span class="sw on" data-act="set-compose-sw"[^>]*aria-checked="true">開/.test(missing), 'compose 缺→仍視為開（舊設定檔相容）');
  const off = uiFn('setDefaultsHtml', t8DefCtx('停點'))({ cfg: { defaults: {}, compose: { confirm_shape: false } } });
  assert.ok(/<span class="sw " data-act="set-compose-sw"[^>]*aria-checked="false">關/.test(off), `false→關：${/<span class="sw[^>]*set-compose-sw[^<]*/.exec(off)?.[0]}`);
  for (const tab of ['權限與查核', 'AI 步驟']) {
    const h = secOf(uiFn('setDefaultsHtml', t8DefCtx(tab))({ cfg: { defaults: {}, compose: { confirm_shape: true } } }), tab);
    assert.equal(count(h, 'set-compose-sw') + count(h, '拆之前先確認成品長相'), 0, `${tab} 0 命中`);
  }
});

test('W1 ⑤：listModeHtml 草稿——autoShape 有值→頂端一行 class="note"「成品長相：…（自動確認）」（在 <div class="sub"> 之前、七格有值的印格名＋值）；autoShape null→0 命中；已存流程 0 命中', () => {
  const draft = { name: '草稿', nodes: [], params: [], category: '旅遊' };
  const ctx = (chat) => t10Ctx({ wf: null, chat: { messages: [], draft, busy: false, shape: null, sources: [], category: null, shapeEdit: null, autoShape: null, ...chat }, categories: ['旅遊', '未分類'], savingDraft: false }, { ...t10Stubs, subjectIsDraft: () => true, subjectDef: () => draft });
  const auto = uiFn('listModeHtml', ctx({ autoShape: { ...SHAPE_FIX(), sections: { value: '', basis: '預設' } } }))();
  const line = /<p class="note"[^>]*data-autoshape[^>]*>([^<]*)<\/p>/.exec(auto);
  assert.ok(line, `灰字一行：${auto.slice(0, 300)}`);
  assert.ok(line[1].startsWith('成品長相：') && line[1].endsWith('（自動確認）'), `句型：${line[1]}`);
  assert.ok(line[1].includes('成品 新聞播報稿') && line[1].includes('對象 VTuber 觀眾') && line[1].includes('範圍 本週'), `格名＋值：${line[1]}`);
  assert.equal(count(line[1], '分段'), 0, '空格不印');
  assert.ok(auto.indexOf('data-autoshape') < auto.indexOf('<div class="sub">'), '在清單頂端');
  assert.ok(auto.includes('data-act="save-draft"'), '草稿現況（存進流程庫）續在');
  const plain = uiFn('listModeHtml', ctx({}))();
  assert.equal(count(plain, '成品長相：') + count(plain, 'data-autoshape'), 0, 'autoShape null→不印');
  const saved = uiFn('listModeHtml', t10Ctx({ chat: { autoShape: SHAPE_FIX() } }, t10Stubs))();
  assert.equal(count(saved, 'data-autoshape'), 0, '已存流程不印');
});

test('W1 ⑥：set-compose-sw 分支——setPut({ compose: { confirm_shape: 反轉現值 } })；讀 state.settings.data.cfg.compose', () => {
  const b = actBranch('set-compose-sw');
  assert.ok(b.includes('setPut({ compose: { confirm_shape:'), `走 setPut：${b}`);
  assert.ok(b.includes('cfg.compose?.confirm_shape === false'), '缺值視為開、反轉＝關（同 set-def-sw 寫法）');
});

// ---------- 成品卡底「這次拆解會參考」一行（純顯示） ----------
test('W2 ①：shapeCardHtml——卡底 <p class="note shaperefs">「這次拆解會參考：關於你 N 條・公司規範 N 份・分類規範 N 份・工人能：上網查／讀參考檔／產 Word、Excel、簡報」；查網關→無「上網查」；暫停→「關於你 暫停中」；某段 null→「讀不到」；refs null→「讀取中」；sendChat 第一趟叫 refreshShapeRefs、它打 _company 與 /api/settings、數字不進第二趟 body；countCore 照 selectCore；CSS .shaperefs', () => {
  // 卡底一行搬到聊天右欄「這次拆解會參考」逐項列；字與數字規則不變
  const refs = { core: 2, company: 1, dept: 0, web: true, paused: false };
  const html = uiFn('shapeCardHtml', { state: p4State({ chat: { ...p4State().chat, refs } }) })();
  assert.equal(count(html, 'shaperefs') + count(html, '這次拆解會參考'), 0, '卡底那行退場');
  const items = uiFn('shapeRefsItems', {});
  const text = (r) => [...items(r)]; // vm 另一個 realm 的陣列：展開成本 realm 才能 deepEqual
  assert.deepEqual(text(refs), ['關於你 2 條', '組織規範 1 份', '分類規範 0 份', '工人能：上網查／讀參考檔／產 Word、Excel、簡報']);
  assert.deepEqual(text({ ...refs, web: false }), ['關於你 2 條', '組織規範 1 份', '分類規範 0 份', '工人能：讀參考檔／產 Word、Excel、簡報'], '查網關掉不印上網查');
  assert.equal(text({ ...refs, paused: true })[0], '關於你 暫停中', '整層暫停');
  assert.deepEqual(text({ ...refs, company: null }), ['關於你 2 條', '組織規範 讀不到', '分類規範 0 份', '工人能：上網查／讀參考檔／產 Word、Excel、簡報'], '讀不到的段');
  assert.deepEqual(text(null), ['讀取中⋯']);
  assert.ok(uiFn('chatAsideHtml', { state: p4State() })().includes('讀取中⋯'), '舊 fixture 沒 refs→讀取中');
  assert.equal(uiFn('shapeCardHtml', { state: p4State({ chat: { ...p4State().chat, shape: null } }) })(), '', 'shape null 仍空');
  // countCore：active 未過期；表達層全算、內容層只算「全部」或同分類、最多 3
  const cc = uiFn('countCore', {});
  const card = (layer, level, category = null, extra = {}) => ({ status: 'active', layer, scope: { level, category }, ...extra });
  assert.equal(cc([card('expression', 'all'), card('expression', 'category', '別的'), card('content', 'all'), card('content', 'category', '旅遊'), card('content', 'category', '別的'), card('content', 'all', null, { status: 'retired' }), card('content', 'all', null, { expires: '2000-01-01' })], '旅遊'), 4, '表達 2＋內容 2（別分類、退休、過期不算）');
  assert.equal(cc([card('content', 'all'), card('content', 'all'), card('content', 'all'), card('content', 'all')], 'x'), 3, '內容層封頂 3');
  const src = uiSrc();
  assert.equal(count(src, 'function refreshShapeRefs('), 1);
  const rf = /async function refreshShapeRefs\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(rf.includes("sharedPath('_company')") && rf.includes("'/api/settings'") && rf.includes('/api/memory/cards?bucket=profile'), `草稿抓三支：${rf}`);
  assert.ok(rf.includes('state.wfMemory') && rf.includes('state.shared?.company'), '已存流程讀 wfMemory／shared');
  assert.ok(rf.includes("if (state.chat !== c || (!saved && (c.category ?? '未分類') !== cat)) return;"), '換了工作區或分類又改了不寫回（排版輪 L9：右欄常駐，沒卡也抓；還沒出卡的草稿分類＝未分類）');
  assert.equal(count(rf, 'c.shape'), 0, '排版輪 L9：不再只在有卡時抓');
  const sc = /async function sendChat\([\s\S]*?\n\}\n/.exec(src)[0];
  const shapeBranch = /if \(out\.phase === 'shape' && !out\.auto\) \{([\s\S]*?)\} else if/.exec(sc)[1];
  assert.ok(shapeBranch.includes('chat.refs = null') && shapeBranch.includes('if (state.chat === chat) refreshShapeRefs();'), '第一趟出卡→清舊數字、另抓（排版輪 L1：只在沒切走時抓）');
  assert.equal(count(actBranch('shape-confirm'), 'refs'), 0, '數字不進第二趟 body');
  assert.ok(src.includes("function emptyChat() { return { messages: [], draft: null, busy: false, shape: null, sources: [], category: null, shapeBase: null, autoShape: null, refs: null, fileKind: null, sample: null }; }"), 'emptyChat 多 refs（排版輪 L9）＋ fileKind／sample（成品格式輪：檔案種類與舊作品）');
  assert.equal(cssRule('.shaperefs'), null, '卡底一行 CSS 退場');
  assert.ok(cssRule('.refrow')?.includes('border-bottom:1px solid'), `右欄逐項：${cssRule('.refrow')}`);
});

// ---------- sendChat 綁發問工作區——等待中切頁，回覆寫回發問的那個工作區 ----------
// 假 api：POST /api/compose 回一個手動放行的 promise（模擬拆解器還在想），其餘立即回 {}；render／refreshShapeRefs 記次數
const l1Env = (stateExtra = {}, chatExtra = {}) => {
  const calls = [];
  const pending = [];
  const api = (method, p, body) => {
    calls.push({ method, path: p, body });
    if (method === 'POST') return new Promise((res, rej) => pending.push({ res, rej }));
    return env.putFail && method === 'PUT' ? Promise.reject(new Error('存檔失敗')) : Promise.resolve({});
  };
  const chat = { ...uiFn('emptyChat')(), messages: [{ role: 'user', text: '做一份週報' }], ...chatExtra };
  const state = { wf: null, run: null, categories: ['旅遊', '未分類'], chat, ...stateExtra };
  const env = { state, chat, calls, pending, renders: 0, refsFor: [], wsByFlow: new Map() };
  env.sendChat = uiFn('sendChat', { state, api, wsByFlow: env.wsByFlow, render: () => { env.renders++; }, refreshShapeRefs: () => { env.refsFor.push(state.chat); } });
  return env;
};
const l1Wf = (id, name) => ({ category: '旅遊', id, def: { name, nodes: [{ id: 'n1', title: name }], params: [] }, runs: [] });
const l1Other = () => ({ ...uiFn('emptyChat')(), messages: [{ role: 'user', text: 'B 的舊對話' }] });

test('L1 ①：vm——草稿發問、等待中切到已存 B→回 phase draft：不打 PUT、草稿寫進原 chat（busy 解開）、B 的 def 與 state.chat 不動；回 phase shape 也寫原 chat、不替別的工作區抓數字', async () => {
  const env = l1Env();
  const run = env.sendChat({});
  assert.equal(env.chat.busy, true, '送出即 busy');
  const B = l1Wf('b', 'B');
  const bChat = l1Other();
  env.state.wf = B; env.state.chat = bChat; // 模擬 openWorkflow：換 wf、restoreWorkspace 換 chat 物件
  const bDef = J(B.def), bMsgs = J(bChat.messages);
  env.pending[0].res({ phase: 'draft', draft: { name: '週報', nodes: [], params: [] }, reply: '拆好了' });
  await run;
  assert.equal(env.calls.filter((c) => c.method === 'PUT').length, 0, '草稿的回覆不准 PUT 蓋掉 B');
  assert.equal(env.chat.draft?.name, '週報', '草稿寫進發問的 chat');
  assert.equal(env.chat.busy, false, '原 chat busy 解開');
  assert.equal(env.chat.messages.at(-1).role, 'ai', 'AI 回覆進原 chat');
  assert.equal(J(B.def), bDef, 'B 的 def 不變');
  assert.equal(env.state.chat, bChat, 'state.chat 仍是 B 的');
  assert.equal(J(bChat.messages), bMsgs, 'B 的對話不變');
  assert.equal(bChat.draft, null); assert.equal(bChat.busy, false);
  assert.ok(env.renders >= 2, '回覆到達仍 render（側欄草稿列更新）');
  const body = env.calls.find((c) => c.method === 'POST').body;
  assert.equal(body.current_draft, null); assert.equal(body.category, null, '發問當下是空白草稿');
  // 第一趟回卡時已切走：卡寫原 chat、refreshShapeRefs 不叫（它讀的是當下工作區）
  const e2 = l1Env();
  const r2 = e2.sendChat({});
  e2.state.wf = l1Wf('b', 'B'); e2.state.chat = l1Other();
  e2.pending[0].res({ phase: 'shape', shape: { deliverable: '週報' }, sources: [], category: null, reply: '先看卡' });
  await r2;
  assert.equal(e2.chat.shape?.deliverable, '週報'); assert.equal(e2.chat.category, '旅遊'); assert.equal(e2.chat.refs, null);
  assert.equal(e2.refsFor.length, 0, '切走了不抓數字');
  assert.equal(e2.state.chat.shape, null, '當下工作區不出卡');
});

test('L1 ②：vm——已存 A 對話修改、等待中切到 B→PUT 打 A 的路徑（剝 category）、B 的 def 不變、A 的 chat 多一則回覆；等待中切走又回 A（新 wf 物件）→state.wf.def 換新', async () => {
  const A = l1Wf('a', 'A');
  const env = l1Env({ wf: A });
  env.chat.messages[0].text = '第一步改短';
  const run = env.sendChat({});
  const body = env.calls[0].body;
  assert.equal(body.current_draft.name, 'A', 'current_draft＝A 的 def'); assert.equal(body.category, '旅遊');
  const B = l1Wf('b', 'B');
  env.state.wf = B; env.state.chat = l1Other();
  const bDef = J(B.def);
  env.pending[0].res({ phase: 'draft', draft: { name: 'A2', category: '旅遊', nodes: [], params: [] }, reply: '改好了' });
  await run;
  const puts = env.calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, `/api/workflows/${encodeURIComponent('旅遊')}/a`, 'PUT 打發問的 A');
  assert.equal('category' in puts[0].body.def, false, '分類是路徑，不進 def');
  assert.equal(J(B.def), bDef, 'B 的 def 不變');
  assert.equal(A.def.name, 'A', '已離開的 A 物件不寫（開回 A 會重抓）');
  assert.ok(env.chat.messages.at(-1).text.startsWith('改好了'), 'A 的 chat 多回覆');
  assert.equal(env.chat.busy, false);
  // 切走又切回 A：openWorkflow 造新 wf 物件、讀回同一個 chat
  const e2 = l1Env({ wf: l1Wf('a', 'A') });
  const r2 = e2.sendChat({});
  e2.state.wf = l1Wf('b', 'B'); e2.state.chat = l1Other();
  e2.state.wf = l1Wf('a', 'A'); e2.state.chat = e2.chat;
  e2.pending[0].res({ phase: 'draft', draft: { name: 'A3', nodes: [], params: [] } });
  await r2;
  assert.equal(e2.state.wf.def.name, 'A3', 'state.wf 仍是發問的 A→def 換新');
});

test('L1 ③：vm——第一趟等待中離開：stashWorkspace 把只有訊息、busy 的草稿打包進 __draft__，回覆寫進包裡那份；open-draft／openWorkflow 讀回「有卡沒數字」補叫 refreshShapeRefs', async () => {
  const env = l1Env({ ...p3State({ wf: null, mode: 'chat' }) });
  env.state.chat = env.chat; // p3State 自帶 chat，換回發問那份
  const run = env.sendChat({});
  const ws = new Map();
  uiFn('stashWorkspace', { state: env.state, wsByFlow: ws })();
  assert.ok(ws.has('__draft__'), '第一趟等待中離開也打包');
  assert.equal(ws.get('__draft__').chat, env.chat, '包裡是同一個 chat 物件');
  env.state.wf = l1Wf('b', 'B'); env.state.chat = l1Other();
  env.pending[0].res({ phase: 'shape', shape: { deliverable: '週報' }, sources: [], category: '旅遊' });
  await run;
  assert.equal(ws.get('__draft__').chat.shape?.deliverable, '週報', '回來看得到卡');
  assert.equal(ws.get('__draft__').chat.busy, false, '回來送得出');
  const src = uiSrc();
  const od = /act === 'open-draft'\) \{([\s\S]*?)\n    \}/.exec(src)[1];
  assert.ok(od.indexOf("restoreWorkspace('__draft__')") < od.indexOf('if (state.chat.shape && !state.chat.refs) refreshShapeRefs();'), 'open-draft 讀回後補抓卡底數字');
  const ow = /async function openWorkflow\([\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(ow.indexOf('await refreshWfMemory();') < ow.indexOf('if (!state.chat.refs) refreshShapeRefs();'), 'openWorkflow 等 wfMemory／shared 抓完才補抓（排版輪 L9：右欄常駐，沒卡也抓）');
});

test('L1 ④：vm——回應拋錯、等待中已切走：錯誤氣泡在原 chat、原 chat busy 解開、當下工作區不多氣泡', async () => {
  const env = l1Env();
  const run = env.sendChat({});
  const bChat = l1Other();
  env.state.wf = l1Wf('b', 'B'); env.state.chat = bChat;
  env.pending[0].rej(new Error('Claude 連不上'));
  await run;
  assert.equal(env.chat.messages.at(-1).role, 'error'); assert.equal(env.chat.messages.at(-1).text, 'Claude 連不上');
  assert.equal(env.chat.busy, false, 'finally 解開原 chat');
  assert.equal(bChat.messages.length, 1, 'B 不多錯誤氣泡');
  // PUT 失敗也一樣
  const e2 = l1Env({ wf: l1Wf('a', 'A') });
  e2.putFail = true;
  const api2 = e2.sendChat({});
  e2.state.chat = l1Other();
  e2.pending[0].res({ phase: 'draft', draft: { name: 'A2', nodes: [], params: [] } });
  await api2;
  assert.equal(e2.chat.busy, false, 'PUT 失敗也解開');
  assert.equal(e2.chat.messages.at(-1).text, '存檔失敗', 'PUT 失敗氣泡也在原 chat');
  const src = fnSrc('sendChat');
  assert.ok(/\} finally \{\n\s+chat\.busy = false;/.test(src), 'busy 在 finally 解開');
  assert.ok(src.includes("chat.messages.push({ role: 'error', text: e.message })"), '錯誤氣泡寫原 chat');
});

test('L1 ⑤：vm——沒切頁＝現況：第一趟出卡（分類空→第一個分類、叫 refreshShapeRefs）、第二趟清卡存草稿、auto 存 autoShape、已存流程 PUT 後 state.wf.def 換新；原文開頭抓 chat／current／target／category，之後 0 處寫 state.chat.', async () => {
  const env = l1Env();
  let run = env.sendChat({});
  env.pending[0].res({ phase: 'shape', shape: { deliverable: '週報' }, sources: [{ name: 'x', from: 'web' }], category: null });
  await run;
  assert.equal(env.chat.shape.deliverable, '週報'); assert.equal(env.chat.sources.length, 1); assert.equal(env.chat.category, '旅遊');
  assert.equal(env.refsFor.length, 1); assert.equal(env.refsFor[0], env.chat, '沒切頁照抓');
  assert.equal(env.chat.messages.at(-1).role, 'ai');
  run = env.sendChat({ phase: 'draft', shape: env.chat.shape, sources: env.chat.sources, category: env.chat.category });
  assert.equal(env.calls[1].body.phase, 'draft'); assert.equal(env.calls[1].body.category, '旅遊', '第二趟卡上分類蓋過');
  env.pending[1].res({ phase: 'draft', draft: { name: '週報', nodes: [], params: [] } });
  await run;
  assert.equal(env.chat.draft.name, '週報'); assert.equal(env.chat.shape, null, '第二趟清卡'); assert.equal(env.chat.autoShape, null);
  const e2 = l1Env();
  run = e2.sendChat({});
  e2.pending[0].res({ phase: 'shape', auto: true, shape: { deliverable: '週報' }, draft: { name: '週報', nodes: [], params: [] } });
  await run;
  assert.equal(e2.chat.autoShape.deliverable, '週報'); assert.equal(e2.chat.shape, null); assert.equal(e2.chat.draft.name, '週報');
  const e3 = l1Env({ wf: l1Wf('a', 'A') });
  run = e3.sendChat({});
  e3.pending[0].res({ phase: 'draft', draft: { name: 'A2', nodes: [], params: [] } });
  await run;
  assert.equal(e3.state.wf.def.name, 'A2'); assert.ok(e3.chat.messages.at(-1).text.includes('已存檔'));
  const s = fnSrc('sendChat');
  assert.ok(s.includes('const chat = state.chat;') && s.includes('const current = subjectDef();'), '開頭一次抓住 chat／current');
  assert.ok(s.includes('const target = state.wf && !subjectIsDraft() ? { category: state.wf.category, id: state.wf.id } : null;'), 'target');
  assert.ok(s.indexOf('const target') < s.indexOf("await api('POST'"), '在送出前抓');
  assert.equal(count(s, 'state.chat.'), 0, '之後全部寫 chat.*');
  assert.equal(count(s, "const current = subjectDef();"), 1, 'current 只抓一次（送出後切頁不再讀當下主體）');
  assert.ok(s.includes('wfPath(target)'), 'PUT 打 target');
  assert.ok(s.includes('if (state.chat === chat) refreshShapeRefs();'), '只替發問的工作區抓數字');
});

// ---------- 全站換字（公司→組織、流程→Workflow； 起中間層改回「分類」＝組織 › 分類 › Workflow；鍵名／API／data-act／資料值不動） ----------
// 去掉整行註解與行尾「 // 」註解；資料值 '未分類' 不算畫面字
const l2Visible = (src) => src.split('\n').map((ln) => (/^\s*\/\//.test(ln) ? '' : ln.replace(/\s\/\/\s.*$/, '').replaceAll("'未分類'", '')));
// 例外表：命中行必含這些字面之一（表上字面不存在也紅）
const L2_SCAN_ALLOW = {
  公司: ['例：小公司負責人', '讀者、公司、進行中的事', "'公司規範': '組織規範'"], // 前二＝使用者自己的真實公司（例句），不是組織層；末項 BASIS_TXT 鍵（素材庫舊輸入框「例：公司一句話簡介」隨共用素材頁退場）
  部門: [], // 中間層改回「分類」，畫面上不該再有「部門」；拆解器回的 basis 資料值「分類守則」現在與畫面同字，不必換字、也不進例外表
};
test('L2 ①：換字掃描——app.js／canvas.js 去註解後「流程」「公司」「部門」0 命中（資料值 \'未分類\' 與例外表除外；例外表逐行核）', () => {
  const bad = [];
  const lines = { 'app.js': l2Visible(uiSrc()), 'canvas.js': l2Visible(fs.readFileSync(path.join(UI, 'canvas.js'), 'utf8')) };
  for (const [f, ls] of Object.entries(lines)) {
    for (const w of ['流程', '公司', '部門']) {
      const allow = L2_SCAN_ALLOW[w] ?? [];
      ls.forEach((ln, i) => { if (ln.includes(w) && !allow.some((a) => ln.includes(a))) bad.push(`${f}「${w}」@${i + 1}: ${ln.trim().slice(0, 90)}`); });
    }
  }
  assert.deepEqual(bad, [], `舊字還在：\n${bad.join('\n')}`);
  for (const [w, list] of Object.entries(L2_SCAN_ALLOW)) for (const a of list) assert.ok(lines['app.js'].some((ln) => ln.includes(w) && ln.includes(a)), `例外表「${w}」的「${a}」已不存在，該從表上拿掉`);
});

test('L2 ②：crumbsHtml 依序「組織 › 旅遊 › A」；草稿「組織 › 草稿」；分類是「未分類」時畫面印「未分類」、data-cat 仍是資料值', () => {
  const texts = (html) => [...html.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(texts(uiFn('crumbsHtml', { state: { wf: { category: '旅遊', def: { name: 'A' } }, companyName: '' } })()), ['組織', '旅遊', 'A']);
  assert.deepEqual(texts(uiFn('crumbsHtml', { state: { wf: null, chat: { draft: { name: '' } }, companyName: '' } })()), ['組織', '草稿']);
  const un = uiFn('crumbsHtml', { state: { wf: { category: '未分類', def: { name: 'A' } }, companyName: '' } })();
  assert.deepEqual(texts(un), ['組織', '未分類', 'A']);
  assert.ok(un.includes('data-act="open-category" data-cat="未分類"'), 'data-cat 仍是資料值');
});

test('L2 ③：側欄組織卡 <small>組織</small>、空名 <strong>組織</strong>、有名印名；data-act="open-company" 不變', () => {
  const empty = uiFn('companyNodeHtml', { state: { categoryPage: null, companyName: '' } })();
  assert.ok(empty.includes('<small>組織</small>') && empty.includes('<strong>組織</strong>'), `空名：${empty}`);
  assert.ok(empty.includes('data-act="open-company"'), 'data-act 不變');
  assert.ok(uiFn('companyNodeHtml', { state: { categoryPage: null, companyName: '明遠' } })().includes('<strong>明遠</strong>'), '有名印名');
  assert.equal(count(empty, '公司'), 0, '畫面字沒有「公司」');
});

test('L2 ④：shapeCardHtml 依據小字顯示「分類守則」「組織規範」、state.chat.shape 資料值不被改；存檔下拉末項「不分類」、標籤「分類」；鍵名／API／data-act 抽查仍在', () => {
  const st = p4State();
  const html = uiFn('shapeCardHtml', { state: st })();
  const basis = [...html.matchAll(/<span class="basis">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(basis, ['你說的', '預設', '自我介紹', '分類守則', '組織規範', '預設', '你說的']);
  assert.equal(st.chat.shape.style.basis, '分類守則', '資料值不變');
  assert.equal(st.chat.shape.length.basis, '公司規範', '資料值不變');
  assert.ok(/<option value="未分類"\s*>不分類<\/option>\s*<\/select>/.test(html), '末項不分類（值仍未分類）');
  assert.ok(html.includes('<label class="label" for="shape-category">分類</label>'), '下拉標籤分類');
  const src = uiSrc();
  for (const s of ["'/api/categories'", 'data-act="open-company"', "categoryPage = { category: '_company'", 'data-act="open-category"', 'data-act="add-category"']) assert.ok(src.includes(s), `還在：${s}`); // 「新增分類」放組織頁，改回原字面
});

// ----------  外框：拿掉頂欄、側欄貼左到底、白卡退場、頁標題元件、元件尺標 ----------
test('L3 ①：index.html 沒有 <header 與 hostdot；app.js 0 命中 hostdot；uiFn 骨架只跳過 app', () => {
  const index = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  assert.equal(count(index, '<header'), 0, 'index.html 頂欄退場');
  assert.equal(count(index, 'hostdot'), 0, 'index.html 沒有 #hostdot');
  assert.equal(count(uiSrc(), 'hostdot'), 0, 'app.js 沒有 hostdot');
  assert.equal(count(cssSrc(), 'header.bar'), 0, 'style.css 頂欄規則退場');
  const { skipped } = uiCtx();
  assert.ok(skipped.every((s) => /^app:/.test(s)), `只准跳過 app：${skipped.join('；')}`);
});

test('L3 ②：CSS 行首規則——.layout grid 244、.side 貼左 sticky 全高、.work 無白底、.page-head h1 26/600、.panel 白卡；main 無內距；body 14px/1.65 照樣稿字型', () => {
  assert.ok(cssRule('.layout')?.startsWith('display:grid;grid-template-columns:244px minmax(0,1fr)'), `.layout：${cssRule('.layout')}`);
  assert.ok(cssRule('.layout').includes('min-height:100vh'), '.layout 滿高');
  const side = cssRule('.side');
  assert.ok(side?.startsWith('position:sticky;top:0;height:100vh'), `.side：${side}`);
  for (const s of ['overflow:auto', 'padding:25px 18px', 'background:var(--m1-bg)', 'border-right:1px solid var(--hairline)']) assert.ok(side.includes(s), `.side 含 ${s}`);
  assert.ok(!/border-radius|box-shadow/.test(side), '.side 無圓角無浮起');
  const work = cssRule('.work');
  assert.ok(work && !work.includes('background:var(--m3-bg)') && !/border-radius|box-shadow|border:/.test(work), `.work 無底色無框：${work}`);
  for (const s of ['padding:29px 35px', 'position:relative', 'min-width:0']) assert.ok(work.includes(s), `.work 含 ${s}`);
  assert.ok(cssRule('.page-head h1')?.startsWith('font-size:26px;font-weight:600'), `.page-head h1：${cssRule('.page-head h1')}`);
  assert.ok(cssRule('.page-head p')?.includes('font-size:12px'), '.page-head p 12px');
  assert.ok(cssRule('.panel')?.startsWith('background:#fff;border:1px solid #dce2ee;border-radius:16px;padding:20px'), `.panel：${cssRule('.panel')}`);
  assert.equal(cssRule('main'), 'padding:0', 'main 無內距');
  assert.ok(cssRule('body')?.includes('14px/1.65'), `body 14px/1.65：${cssRule('body')}`);
  assert.ok(cssVar('--font')?.startsWith('"Segoe UI","Microsoft JhengHei",'), `--font 照樣稿（定案 5.1；排版輪 L15 拿掉鏈上 Noto Sans TC，見 L15 ①）：${cssVar('--font')}`);
  assert.ok(cssVar('--mono')?.startsWith("'Geist Mono'"), 'Geist Mono 留給數字／代碼');
  const css = cssSrc();
  assert.ok(/@media \(min-width:1600px\)\{\.work\{padding:35px 55px\}\}/.test(css), '≥1600 內距放大');
  assert.ok(/@media \(max-width:1100px\) and \(min-width:801px\)\{\.layout\{grid-template-columns:218px minmax\(0,1fr\)\}/.test(css), '1100–801 側欄 218');
  assert.ok(/@media \(max-width:900px\)\{\.layout\{grid-template-columns:1fr\}/.test(css), '≤900 單欄堆疊（W3）');
  assert.ok(cssRule('.chip.wait')?.includes('background:#fff0d0;color:#895616;border-color:#e8c78d'), `.chip.wait 樣稿色：${cssRule('.chip.wait')}`);
  const index = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  assert.ok(index.includes('Geist+Mono') && !/family=Geist:/.test(index), 'Google Fonts 只載 Geist Mono（排版輪 L15 起不載 Noto Sans TC）');
});

test('L3 ③：pageHeadHtml(title, sub, actions)——.page-head 結構；標題與說明 escape、動作原樣；沒說明／沒動作不印空殼', () => {
  const tag = (s) => `[${s}]`;
  const f = uiFn('pageHeadHtml', { esc: tag });
  assert.equal(f('A', 'B', '<b>c</b>'), '<div class="page-head"><div><h1>[A]</h1><p>[B]</p></div><div class="actions"><b>c</b></div></div>');
  assert.equal(f('A'), '<div class="page-head"><div><h1>[A]</h1></div></div>');
  const realEsc = vm.runInNewContext(/^const esc = (.*);$/m.exec(uiSrc())[1]);
  const out = uiFn('pageHeadHtml', { esc: realEsc })('<i>x</i>', 'a&b', '');
  assert.equal(out, '<div class="page-head"><div><h1>&lt;i&gt;x&lt;/i&gt;</h1><p>a&amp;b</p></div></div>', `真 esc：${out}`);
});

test('L3 ④：無頂欄後 sticky——左右欄與右側資料夾 top:20px／calc(100vh - 40px)；render() 抽屜捲動段刪除（drawerWasOpen 0 命中）', () => {
  const css = cssSrc();
  assert.ok(css.includes('\n.progressrail,.sideinfo{position:sticky;top:20px;align-self:start;max-height:calc(100vh - 40px)'), '執行頁左右欄');
  assert.ok(cssRule('.inspector')?.startsWith('position:sticky;top:20px;align-self:start;max-height:calc(100vh - 40px)'), `右欄（排版輪 L8：資料夾收進右欄檢視器 .inspector）：${cssRule('.inspector')}`);
  assert.equal(count(css, 'top:76px'), 0, '舊頂欄位移 76px 清掉');
  assert.equal(count(css, '100vh - 96px'), 0, '舊頂欄位移 96px 清掉');
  assert.equal(count(uiSrc(), 'drawerWasOpen'), 0, 'render 抽屜捲動段刪除');
});

test('L3 ⑤：側欄底部依 state.claude 印 data-claude="ok|down"（null 不印）；連不上附重新連線；refreshHealth 不再碰 DOM', () => {
  const side = (claude) => { const { context } = uiCtx(); context.state.claude = claude; return vm.runInContext('sideHtml()', context); };
  const ok = side(true);
  assert.equal(count(ok, 'data-claude="ok"'), 1, `連上：${ok.slice(-300)}`);
  assert.ok(/data-claude="ok"[^]*Claude 已連上[^]*<\/aside>$/.test(ok.trim()), '在側欄最底');
  const down = side(false);
  assert.equal(count(down, 'data-claude="down"'), 1, '連不上');
  assert.ok(/data-claude="down"[^]*Claude 連不上[^]*data-act="reconnect"/.test(down), '連不上附重新連線');
  const none = side(null);
  assert.equal(count(none, 'data-claude'), 0, 'null 不印');
  const rh = /async function refreshHealth\(\) \{[\s\S]*?\n\}\n/.exec(uiSrc())[0];
  assert.ok(!/document|innerHTML|className/.test(rh), `refreshHealth 只寫 state：${rh}`);
});

// ---------- 側欄（樣稿 uxWorkspaceNav＋驗收第 1／2／3／13 條）----------
const l4Side = (extra = {}) => t9Side({ companyName: '範例組織', categories: ['旅遊', '未分類'], workflows: [{ id: 'a', name: 'A', category: '旅遊' }, { id: 'b', name: 'B', category: '旅遊' }], claude: true, ...extra });
test('L4 ①：側欄由上而下 .brand（剝繭／MAKE WORK CLEAR）→四全域項→建立新 Workflow→分隔線→小標「工作空間」→.company-row→.company-children→共用素材 open-assets→.sidefoot', () => {
  const html = l4Side();
  assert.ok(/<div class="brand">剝繭<span>MAKE WORK CLEAR<\/span><\/div>/.test(html), '品牌＋副標（上桌題 5-2 照樣稿）');
  const at = (needle) => { const i = html.indexOf(needle); assert.ok(i >= 0, `側欄該有 ${needle}`); return i; };
  const order = ['class="brand"', 'data-act="open-dash"', 'data-act="open-library"', 'data-act="open-calendar"', 'data-act="open-settings"', 'data-act="new-flow"', 'class="rule"', '<div class="caption">工作空間</div>', '<div class="company-row', '<div class="company-children">', 'class="asset-entry" data-act="open-assets"', 'class="sidefoot"'].map(at);
  assert.deepEqual([...order].sort((x, y) => x - y), order, `順序：${order}`);
  assert.ok(/data-act="new-flow"[^>]*>＋ 建立新 Workflow</.test(html), '建立鈕字「＋ 建立新 Workflow」');
  assert.ok(/class="asset-entry" data-act="open-assets"[^>]*><i class="ph ph-files"><\/i>共用素材</.test(html), '共用素材入口');
  assert.ok(html.indexOf('class="asset-entry"') > html.lastIndexOf('</details>'), '共用素材在整棵樹之後');
  const acts = [...html.matchAll(/class="wf calentry[^"]*" data-act="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(acts, ['open-dash', 'open-library', 'open-calendar', 'open-settings'], '四全域項順序不變');
  assert.ok(/<nav class="nav" aria-label="主要導覽">[\s\S]*data-act="open-settings"[\s\S]*?<\/nav>/.test(html), '四項包在 nav');
  assert.ok(l4Side({ library: { q: '', cat: '' } }).includes('class="wf calentry now" data-act="open-library" tabindex="0" role="button" aria-current="page"'), '選中項 aria-current');
  const src = uiSrc();
  assert.ok(/else if \(act === 'open-assets'\) \{?[^\n]*openAssets\(\)/.test(src), 'open-assets 分支（排版輪 L6：開共用素材整頁）');
});

test('L4 ②：分類 summary——收合箭頭在最前（常駐、可聚焦）、方塊、名、數、鉛筆；「未分類」無鉛筆；.catset 0 命中（app.js 與 CSS）', () => {
  const html = l4Side();
  const sums = [...html.matchAll(/<summary[^>]*>[\s\S]*?<\/summary>/g)].map((m) => m[0]);
  assert.equal(sums.length, 2);
  const s = sums[0];
  const iCaret = s.indexOf('catcaret'), iMark = s.indexOf('dept-mark'), iName = s.indexOf('class="tree-name"'), iCount = s.indexOf('dept-count'), iPen = s.indexOf('data-act="rename-open"');
  assert.ok(iCaret > 0 && iCaret < iMark && iMark < iName && iName < iCount && iCount < iPen, `箭頭→方塊→名→數→鉛筆：${[iCaret, iMark, iName, iCount, iPen]}`);
  assert.ok(s.includes('<i class="ph ph-caret-down catcaret" data-act="cat-toggle" data-cat="旅遊" tabindex="0" role="button" aria-expanded="true" aria-label="收起「旅遊」"'), `箭頭可聚焦＋狀態：${s}`);
  const closed = [...l4Side({ catClosed: new Set(['旅遊']) }).matchAll(/<summary[^>]*>[\s\S]*?<\/summary>/g)][0][0];
  assert.ok(closed.includes('aria-expanded="false" aria-label="展開「旅遊」"'), '收合時 aria-expanded=false');
  assert.ok(!sums[1].includes('rename-open') && sums[1].includes('<span class="tree-name">未分類</span>'), '「未分類」顯示原字、沒有鉛筆');
  assert.equal(count(html, 'catset'), 0, '.catset 裝飾圖示拿掉');
  assert.equal(count(uiSrc(), 'catset'), 0, 'app.js 0 命中 catset');
  assert.equal(count(cssSrc(), 'catset'), 0, 'CSS 0 命中 catset');
});

test('L4 ③：Workflow 列——開啟列可聚焦、鉛筆＋「⋯」data-act="row-menu" data-cat data-id data-name（鉛筆在前）；.wfdel 0 命中；草稿列沒有鉛筆與「⋯」', () => {
  const html = l4Side();
  assert.equal(count(html, 'wfdel'), 0, '列上垃圾桶移進「⋯」');
  const row = /<div class="flow-row">[\s\S]*?data-id="a"[\s\S]*?<\/button><\/div>/.exec(html)?.[0] ?? '';
  assert.ok(row.includes('class="wf" data-act="open" data-cat="旅遊" data-id="a" tabindex="0" role="button"'), `開啟列：${row}`);
  const iPen = row.indexOf('data-act="rename-open" data-type="flow" data-cat="旅遊" data-id="a"');
  const iMore = row.indexOf('<button type="button" class="rowmore" data-act="row-menu" data-cat="旅遊" data-id="a" data-name="A"');
  assert.ok(iPen > 0 && iMore > iPen, `鉛筆→「⋯」：${row}`);
  assert.ok(/class="rowmore"[^>]*aria-haspopup="menu"[^>]*aria-label="「A」更多動作"[^>]*><i class="ph ph-dots-three"><\/i><\/button>/.test(row), '「⋯」無障礙標記＋Phosphor 圖標');
  assert.equal(count(html, 'data-act="row-menu"'), 2, '兩條 Workflow 各一顆');
  const withDraft = uiFn('sideHtml', { state: { categories: ['未分類'], workflows: [], trash: [], notices: { unread: [] }, catClosed: new Set(), categoryPage: null, wf: null, calendar: null, settings: null, library: null, dash: null, companyName: '', chat: emptyChatLike() }, subjectIsDraft: () => false, wsByFlow: new Map([['__draft__', {}]]) })();
  const draft = /<div class="flow-row draftrow[\s\S]*?<\/button><\/div>/.exec(withDraft)[0]; // 排版輪 F3：列尾多一顆「丟掉」
  assert.ok(draft.includes('data-act="open-draft" tabindex="0" role="button"') && !draft.includes('row-menu') && !draft.includes('rename-open'), `草稿列：${draft}`);
  assert.equal(count(html, 'data-act="row-menu" data-cat="旅遊" data-id="a"'), 1);
});

test('L4 ④：rowMenuHtml——state.rowMenu 有值→移至分類（子清單列別的分類）／複製／匯出／移到垃圾桶（del-wf-row 帶 cat/id/name）；null→空；掛 render 浮窗串尾；Esc 與點外面關；複製、移至分類 vm', async () => {
  const menu = (rowMenu) => uiFn('rowMenuHtml', { state: { rowMenu, categories: ['旅遊', '工作', '未分類'] } })();
  assert.equal(menu(null), '', 'null→空字串');
  const m = menu({ cat: '旅遊', id: 'a', name: 'A', x: 230, y: 340, sub: false });
  assert.ok(m.startsWith('<div class="rowmenu" role="menu" aria-label="「A」更多動作" style="left:230px;top:340px">'), `外框與定位：${m.slice(0, 120)}`);
  const acts = [...m.matchAll(/data-act="([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(acts, ['row-move-open', 'row-copy', 'row-export', 'del-wf-row'], `四項順序：${acts}`);
  assert.ok(m.includes('aria-expanded="false"') && !m.includes('data-act="row-move"'), '子清單收著');
  assert.ok(m.includes('data-act="del-wf-row" data-cat="旅遊" data-id="a" data-name="A"'), '移到垃圾桶走既有 del-wf-row（確認句不變）');
  for (const w of ['移至分類', '複製', '匯出', '移到垃圾桶']) assert.ok(m.includes(w), w);
  const sub = menu({ cat: '旅遊', id: 'a', name: 'A', x: 1, y: 2, sub: true });
  const tos = [...sub.matchAll(/data-act="row-move" data-to="([^"]+)"[^>]*>([^<]+)</g)].map((x) => [x[1], x[2]]);
  assert.deepEqual(tos, [['工作', '工作'], ['未分類', '未分類']], `子清單＝別的分類（顯示名過 catLabel、值是資料名）：${JSON.stringify(tos)}`);
  assert.ok(sub.includes('aria-expanded="true"'));
  assert.ok(menu({ cat: '旅遊', id: 'a', name: 'A', x: 1, y: 2, sub: true }).includes('row-move'), 'sub 開');
  assert.ok(uiFn('rowMenuHtml', { state: { rowMenu: { cat: '旅遊', id: 'a', name: 'A', x: 1, y: 2, sub: true }, categories: ['旅遊'] } })().includes('沒有別的分類'), '只有一個分類→一句');
  const src = uiSrc();
  assert.ok(src.includes('+ renameModalHtml() + rowMenuHtml() + drawerHtml(); }'), '浮窗串尾（地雷 5；排版輪 L10 步驟彈窗接在其後）');
  assert.ok(/if \(e\.key === 'Escape' && state\.rowMenu\) \{/.test(src), 'Esc 關');
  assert.ok(/if \(state\.rowMenu && !e\.target\.closest\('\.rowmenu'\) && !e\.target\.closest\('\[data-act="row-menu"\]'\)\) \{/.test(src), '點外面關');
  assert.ok(src.includes('rowMenu: null,'), 'state.rowMenu 初值 null');
  // 複製（上桌a）：讀定義→名字加「（副本）」→POST 同分類，不帶執行紀錄（新 id 由後端配）
  const calls = [];
  const st = { rowMenu: { cat: '旅遊', id: 'a' }, wf: null, run: null };
  const api = async (method, p, body) => { calls.push([method, p, body]); return method === 'GET' ? { name: 'A', nodes: [{ id: 'n1' }], params: [] } : { category: '旅遊', id: 'wf-new' }; };
  let refreshed = 0;
  await uiFn('copyWorkflow', { state: st, api, refreshLibrary: async () => { refreshed++; } })('旅遊', 'a');
  assert.equal(calls[0][0], 'GET'); assert.equal(calls[0][1], `/api/workflows/${encodeURIComponent('旅遊')}/a`);
  assert.equal(calls[1][0], 'POST'); assert.equal(calls[1][1], '/api/workflows');
  assert.equal(calls[1][2].category, '旅遊'); assert.equal(calls[1][2].def.name, 'A（副本）'); assert.equal(calls[1][2].def.nodes.length, 1);
  assert.equal(refreshed, 1);
  // 移至分類：POST move；正在看的那條 state.wf／state.run 換分類；暫存包換鍵
  const calls2 = [];
  const ws = new Map([['旅遊/a', { chat: 'pkg' }], ['旅遊/b', { chat: 'other' }]]);
  const st2 = { wf: { category: '旅遊', id: 'a' }, run: { workflow: { category: '旅遊', id: 'a' } } };
  await uiFn('moveWorkflowTo', { state: st2, api: async (...x) => { calls2.push(x); return { ok: true }; }, refreshLibrary: async () => {}, wsByFlow: ws })('旅遊', 'a', '工作');
  assert.deepEqual(J(calls2[0]), J(['POST', `/api/workflows/${encodeURIComponent('旅遊')}/a/move`, { to: '工作' }]));
  assert.equal(st2.wf.category, '工作'); assert.equal(st2.run.workflow.category, '工作');
  assert.ok(ws.has('工作/a') && !ws.has('旅遊/a') && ws.get('工作/a').chat === 'pkg' && ws.has('旅遊/b'), `暫存包換鍵：${[...ws.keys()]}`);
  const st3 = { wf: { category: '旅遊', id: 'b' }, run: null };
  await uiFn('moveWorkflowTo', { state: st3, api: async () => ({}), refreshLibrary: async () => {}, wsByFlow: new Map() })('旅遊', 'a', '工作');
  assert.equal(st3.wf.category, '旅遊', '別條不動');
});

test('L4 ⑤：鍵盤與觸控——可點元素 tabindex="0" role="button"；keyActivate：[data-act][tabindex] 上 Enter／Space 轉 click＋preventDefault、其他不管；CSS :focus-within 與 (hover:none) 顯示鉛筆與「⋯」', () => {
  const html = l4Side({ categoryPage: null });
  for (const a of ['open-dash', 'open-library', 'open-calendar', 'open-settings', 'new-flow', 'open-company', 'open', 'cat-toggle', 'open-assets']) {
    assert.ok(new RegExp(`data-act="${a}"[^>]*tabindex="0" role="button"`).test(html), `${a} 可聚焦`);
  }
  const ka = uiFn('keyActivate');
  const ev = (key, attrs) => { const e = { key, prevented: false, clicked: 0, preventDefault() { this.prevented = true; } }; e.target = { matches: (s) => s === '[data-act][tabindex]' && attrs, click() { e.clicked++; } }; return e; };
  for (const k of ['Enter', ' ']) { const e = ev(k, true); assert.equal(ka(e), true); assert.equal(e.clicked, 1, `${JSON.stringify(k)} 轉 click`); assert.equal(e.prevented, true, '擋掉原生（summary 不跟著收合、空白鍵不捲頁）'); }
  const other = ev('a', true); assert.equal(ka(other), false); assert.equal(other.clicked, 0, '別的鍵不管');
  const plain = ev('Enter', false); assert.equal(ka(plain), false); assert.equal(plain.clicked, 0, '沒 tabindex 的（原生按鈕、輸入框）不管');
  assert.ok(/app\.addEventListener\('keydown', \(e\) => \{\n {2}if \(keyActivate\(e\)\) return;/.test(uiSrc()), 'app keydown 第一行先走 keyActivate');
  const rd = /function render\(\) \{[\s\S]*?\n\}\n/.exec(uiSrc())[0];
  assert.ok(rd.indexOf("fa.closest('.side, .rowmenu') && fa.matches(':focus-visible')") < rd.indexOf('app.innerHTML') && rd.indexOf('if (keepFocus && document.activeElement === document.body)') > rd.indexOf('app.innerHTML'), '輪詢重繪不把鍵盤焦點丟回 body（側欄／選單裡的那顆放回）');
  const css = cssSrc();
  for (const r of ['.flow-row:focus-within .tree-rename,.flow-row:focus-within .rowmore,.flow-row:hover .rowmore{display:grid}', '.company-row:focus-within .tree-rename,.side summary:focus-within .tree-rename{display:grid}', '@media (hover:none){.side .tree-rename,.side .rowmore{display:grid}}', '.side [tabindex]:focus-visible{']) assert.ok(css.includes(r), r);
  assert.ok(cssRule('.rowmore')?.includes('display:none'), `.rowmore 平常收著：${cssRule('.rowmore')}`);
});

test('L4 ⑥：側欄 0 命中 add-category／pick-import／view-trash／.org-switch；CSS .side .calentry 14px 內距 11px 13px、.brand 22px、.newflow 全寬 14px/600 上距 20px', () => {
  const html = l4Side({ addingCategory: true });
  for (const n of ['add-category', 'confirm-category', 'pick-import', 'view-trash', 'org-switch', 'addcat']) assert.equal(count(html, n), 0, `側欄 0 命中 ${n}`);
  const cal = cssRule('.side .calentry');
  assert.ok(cal?.includes('font-size:14px') && cal.includes('padding:11px 13px'), `.side .calentry：${cal}`);
  assert.ok(cssRule('.side .calentry.now')?.includes('#dce4fb') && cssRule('.side .calentry.now').includes('inset 3px 0') && cssRule('.side .calentry.now').includes('font-weight:650'), `.side .calentry.now：${cssRule('.side .calentry.now')}`);
  assert.ok(cssRule('.side .calentry i')?.includes('font-size:18px'), `圖標 18px：${cssRule('.side .calentry i')}`);
  const brand = cssRule('.brand');
  assert.ok(brand?.startsWith('font-size:22px') && brand.includes('font-weight:700') && brand.includes('letter-spacing:5px') && brand.includes('#293d70'), `.brand：${brand}`);
  assert.ok(cssRule('.brand span')?.includes('font-size:10px') && cssRule('.brand span').includes('letter-spacing:3px'), `.brand span：${cssRule('.brand span')}`);
  const nf = cssRule('.newflow');
  assert.ok(nf?.includes('font-size:14px') && nf.includes('font-weight:600') && nf.includes('padding:10px') && nf.includes('margin-top:20px'), `.newflow：${nf}`);
  assert.equal(count(cssSrc(), '.addcat'), 0, '.addcat 樣式跟著退場');
});

test('L4 ⑦（L1 覆核補）：vm——已存 Workflow 對話修改等待中，它的分類被改名（wsByFlow 換鍵）→回覆不崩、PUT 打改名後的路徑、寫回那條 Workflow；已切走時當下工作區不動', async () => {
  // 情境 1：還開著 A，分類「旅遊」改名「行銷」（renameSave 同步 state.wf.category、state.workflows、wsByFlow 鍵）
  const env = l1Env({ wf: l1Wf('a', 'A'), workflows: [{ category: '旅遊', id: 'a', name: 'A' }] });
  const run = env.sendChat({});
  env.state.wf.category = '行銷';
  env.state.workflows = [{ category: '行銷', id: 'a', name: 'A' }];
  env.pending[0].res({ phase: 'draft', draft: { name: 'A2', category: '旅遊', nodes: [], params: [] }, reply: '改好了' });
  await run;
  const puts = env.calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1, '有存檔');
  assert.equal(puts[0].path, `/api/workflows/${encodeURIComponent('行銷')}/a`, `PUT 打改名後的分類（舊路徑會 404、改動丟掉）：${puts[0].path}`);
  assert.equal(env.state.wf.def.name, 'A2', '開著的 A 換新定義');
  assert.ok(env.chat.messages.at(-1).text.startsWith('改好了'), '回覆寫進 A 的 chat，不是錯誤氣泡');
  assert.equal(env.chat.busy, false);
  // 情境 2：已切到 B（另一分類「工作」），A 的分類改名後回覆到達
  const e2 = l1Env({ wf: l1Wf('a', 'A'), workflows: [{ category: '旅遊', id: 'a', name: 'A' }, { category: '工作', id: 'b', name: 'B' }] });
  const r2 = e2.sendChat({});
  const B = { ...l1Wf('b', 'B'), category: '工作' };
  const bDef = J(B.def);
  e2.state.wf = B; e2.state.chat = l1Other();
  e2.state.workflows = [{ category: '行銷', id: 'a', name: 'A' }, { category: '工作', id: 'b', name: 'B' }];
  e2.pending[0].res({ phase: 'draft', draft: { name: 'A3', nodes: [], params: [] } });
  await r2;
  const p2 = e2.calls.filter((c) => c.method === 'PUT');
  assert.equal(p2.length, 1);
  assert.equal(p2[0].path, `/api/workflows/${encodeURIComponent('行銷')}/a`, `切走後照樣打改名後的 A：${p2[0].path}`);
  assert.equal(J(B.def), bDef, 'B 不動');
  assert.equal(e2.chat.messages.at(-1).role, 'ai');
  // 情境 3：沒改名（state.workflows 找得到原鍵）＝現況路徑
  const e3 = l1Env({ wf: l1Wf('a', 'A'), workflows: [{ category: '旅遊', id: 'a', name: 'A' }] });
  const r3 = e3.sendChat({});
  e3.pending[0].res({ phase: 'draft', draft: { name: 'A4', nodes: [], params: [] } });
  await r3;
  assert.equal(e3.calls.find((c) => c.method === 'PUT').path, `/api/workflows/${encodeURIComponent('旅遊')}/a`);
  // 情境 4：原鍵不見、同 id 在兩個分類都有（認不準）→不猜，照發問當下的路徑
  const e4 = l1Env({ wf: l1Wf('a', 'A'), workflows: [{ category: '旅遊', id: 'a', name: 'A' }] });
  const r4 = e4.sendChat({});
  e4.state.workflows = [{ category: '行銷', id: 'a', name: 'A' }, { category: '工作', id: 'a', name: 'A 範例' }];
  e4.pending[0].res({ phase: 'draft', draft: { name: 'A5', nodes: [], params: [] } });
  await r4;
  assert.equal(e4.calls.find((c) => c.method === 'PUT').path, `/api/workflows/${encodeURIComponent('旅遊')}/a`, '同 id 兩條不猜');
});

// ---------- 儀表板＋Workflow 庫 ----------
test('L5 ①：dashHtml——page-head「工作，逐件有進展。」＋日期與件數＋建立鈕；左 要你處理→最近完成→Workflow 提議（.panel）；右 接下來（右上查看）→系統通知→用量；舊 dashhead／crs 退場', () => {
  const h = uiFn('dashHtml', u5Ctx())();
  assert.ok(h.includes('<div class="page-head"><div><h1>工作，逐件有進展。</h1>'), 'page-head 大標');
  assert.ok(/<p>\d{1,2} 月 \d{1,2} 日，星期[日一二三四五六]・有 1 件事情需要你處理。<\/p>/.test(h), `說明含日期與件數：${h.match(/<p>[^<]*<\/p>/)?.[0]}`);
  const head = h.slice(h.indexOf('<div class="page-head">'), h.indexOf('<div class="homegrid">'));
  assert.ok(head.includes('<button class="btn" data-act="new-flow">＋ 建立新 Workflow</button>'), '右上建立鈕（樣稿為一般鈕；側欄已有實心建立鈕）');
  const zero = uiFn('dashHtml', u5Ctx({}, { todos: [] }))();
  assert.ok(zero.includes('・目前沒有待處理事項。</p>'), '0 件的說明');
  const [main, aside] = u5Split(h);
  const at = (src, s) => { const i = src.indexOf(s); assert.ok(i >= 0, `該有：${s}`); return i; };
  assert.ok(at(main, '<section class="panel panel-wait">') < at(main, '<section class="panel panel-done">') && at(main, '<section class="panel panel-done">') < at(main, '<section class="panel panel-blue">'), '左欄三塊順序');
  assert.ok(main.includes('<div class="section-head"><h2>要你處理</h2><span class="chip wait">1 件</span></div>'), '要你處理 h2＋N 件');
  assert.ok(main.includes('<div class="section-head"><h2>最近完成</h2>') && main.includes('<span class="chip">4 次</span>'), '最近完成 h2＋N 次');
  assert.ok(uiFn('dashHtml', u5Ctx({}, { todos: [] }))().includes('<span class="chip">0 件</span>'), '0 件不是琥珀');
  assert.equal(count(aside, '<section class="panel asideblock">'), 3, '右欄三塊白卡');
  const order = ['<h2>接下來</h2>', '<h2>系統通知</h2>', '<h2>用量</h2>'].map((s) => at(aside, s));
  assert.ok(order[0] < order[1] && order[1] < order[2], `右欄順序：${order}`);
  const next = aside.slice(order[0] - 30, order[1]);
  assert.ok(/<div class="section-head"><h2>接下來<\/h2><button[^>]*data-act="open-calendar"[^>]*>查看<\/button><\/div>/.test(next), `接下來右上「查看」：${next.slice(0, 200)}`);
  assert.ok(aside.includes('data-act="dash-usage-open"') && aside.includes('用量明細'), '用量位置不改（驗收第 9 條）');
  for (const old of ['dashhead', 'class="crs', 'dashsec', '<h4>']) assert.equal(count(h, old), 0, `舊殼 ${old} 退場`);
});

test('L5 ②：noticeSectionHtml——已處理通知收在 <details>「已處理（N）」（驗收第 9 條）；noticesOpen 真→open；summary 事件 preventDefault 由 state 控開關（輪詢重繪讀回）', () => {
  const ctx = (noticesOpen) => ({ state: { notices: { unread: [{ id: 'n1', title: '新的', desc: 'x', type: 'reminder' }], done: [{ id: 'd1', title: '舊的一', result: '補跑了', resolved_at: '2026-09-14T09:00:00.000Z' }, { id: 'd2', title: '舊的二', result: '略過', created_at: '2026-09-13T09:00:00.000Z' }] }, noticesOpen } });
  const closed = uiFn('noticeSectionHtml', ctx(false))();
  assert.ok(closed.includes('新的'), '未讀照列在外面');
  const fold = /<details class="donefold"( open)?><summary data-act="notices-toggle-done"[^>]*>[\s\S]*?已處理（2）[\s\S]*?<\/summary>([\s\S]*?)<\/details>/.exec(closed);
  assert.ok(fold, `details 摺疊：${closed}`);
  assert.equal(fold[1], undefined, '預設收著');
  assert.ok(fold[2].includes('舊的一') && fold[2].includes('舊的二'), '已處理兩筆在 details 裡');
  assert.ok(closed.indexOf('新的') < closed.indexOf('<details'), '未讀在前');
  assert.ok(uiFn('noticeSectionHtml', ctx(true))().includes('<details class="donefold" open>'), 'noticesOpen→open');
  assert.ok(uiSrc().includes("else if (act === 'notices-toggle-done') { e.preventDefault(); state.noticesOpen = !state.noticesOpen; render(); }"), 'summary 原生切換擋掉、由 state 控');
});

test('L5 ③：libraryHtml——page-head「Workflow 庫」＋右上 匯入（pick-import，合併入口）＋建立（primary）；工具列 #lib-search＋#lib-dept 下拉＋「垃圾桶（N）」view-trash；lib-cat 膠囊退場；下拉 change 只換 #lib-grid', () => {
  const html = uiFn('libraryHtml', { state: { categories: ['旅遊', '未分類'], workflows: [], trash: [{}, {}], library: { q: 'x', cat: '未分類' } } })();
  assert.ok(html.includes('<div class="page-head"><div><h1>Workflow 庫</h1><p>把重複的工作整理成可以再次執行的 Workflow。</p></div>'), 'page-head');
  const head = html.slice(0, html.indexOf('class="libtools"'));
  assert.ok(head.indexOf('data-act="pick-import"') > 0 && head.indexOf('data-act="pick-import"') < head.indexOf('data-act="new-flow"'), '右上 匯入 在 建立 前');
  assert.ok(/<button[^>]*btn-primary[^>]*data-act="new-flow"[^>]*>＋ 建立新 Workflow<\/button>/.test(head), '建立＝primary');
  assert.ok(/data-act="pick-import"[^>]*>(<i[^>]*><\/i>)?匯入<\/button>/.test(head), '「匯入」一個入口');
  const tools = /<div class="libtools">([\s\S]*?)<\/div>\s*<div class="libgrid" id="lib-grid">/.exec(html)?.[1];
  assert.ok(tools, '工具列在卡片格之前');
  assert.ok(tools.includes('id="lib-search"') && tools.includes('value="x"'), '搜尋框（沿用 id、值讀回）');
  assert.ok(tools.includes('<select id="lib-dept"') && tools.includes('<option value="未分類" selected>未分類</option>'), '分類下拉（值是資料名、字過 catLabel）');
  assert.ok(/data-act="view-trash"[^>]*>(<i[^>]*><\/i>)?垃圾桶（2）<\/button>/.test(tools), '垃圾桶（N）');
  assert.equal(count(html, 'lib-cat'), 0, '膠囊 lib-cat 退場');
  assert.equal(count(uiSrc(), "act === 'lib-cat'"), 0, 'lib-cat 事件分支跟著退場');
  const src = uiSrc();
  const ch = /if \(e\.target\.id === 'lib-dept' && state\.library\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0];
  assert.ok(ch && ch.includes('state.library.cat = e.target.value') && ch.includes("getElementById('lib-grid')") && ch.includes('libraryCardsHtml()') && !ch.includes('render()'), `下拉只換卡片格：${ch}`);
});

test('L5 ④：flowCardsHtml——.flowcard 分類 caption、h2 名、「N 步驟・M 步你來」（W7）、打開、「⋯」row-menu（共用 rowMenuHtml）；步數讀不到不崩；rowMenuPos 靠右往左開', () => {
  const f = uiFn('flowCardsHtml');
  const html = f([{ category: '未分類', id: 'a', name: 'A 報告', steps: 3, human_steps: 1 }]);
  assert.ok(html.startsWith('<article class="flowcard" data-lib-card="a">'), `卡外殼：${html.slice(0, 80)}`);
  const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, `該有：${s}`); return i; };
  assert.ok(at('<span class="caption">未分類</span>') < at('<h2>A 報告</h2>') && at('<h2>A 報告</h2>') < at('3 步驟・1 步你來') && at('3 步驟・1 步你來') < at('data-act="open" data-cat="未分類" data-id="a"') && at('data-act="open" data-cat="未分類" data-id="a"') < at('data-act="row-menu" data-cat="未分類" data-id="a" data-name="A 報告"'), '順序：分類→名→步數→打開→⋯');
  assert.ok(html.includes('aria-haspopup="menu"'), '「⋯」宣告選單');
  const bad = f([{ category: 'c', id: 'b', name: 'B', steps: null, human_steps: null }, { category: 'c', id: 'd', name: '舊回應' }]);
  assert.equal(count(bad, '步數讀不到'), 2, '壞檔（null）與舊回應（沒欄位）都不印 null／undefined');
  assert.ok(!bad.includes('null') && !bad.includes('undefined'));
  const pos = uiFn('rowMenuPos');
  assert.deepEqual(J(pos({ left: 100, right: 124, top: 300 }, 1440, 900)), J({ x: 130, y: 300 }), '左邊的「⋯」往右開（側欄原樣）');
  const right = pos({ left: 1380, right: 1404, top: 850 }, 1440, 900);
  assert.ok(right.x + 196 <= 1440 && right.x < 1380, `靠右往左開、不超出視窗：${J(right)}`);
  assert.equal(right.y, 710, '靠底往上收（原 innerHeight-190）');
  assert.ok(/state\.rowMenu = \{ cat, id, name, \.\.\.rowMenuPos\(el\.getBoundingClientRect\(\), window\.innerWidth, window\.innerHeight\), sub: false \};/.test(uiSrc()), 'row-menu 分支用 rowMenuPos');
});

test('L5 ⑤：CSS——.libgrid 三欄 gap 17、1150 以下兩欄；.flowcard 圓角 16 內距 22 min-height 232 頂線；.libtools 搜尋拉滿；.homegrid 310／21；app.js 0 命中 libcard', () => {
  assert.ok(cssSrc().includes('.libgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:17px'), `.libgrid：${cssRule('.libgrid')}`);
  assert.ok(/@media \(max-width:1150px\)\{[^\n]*\.libgrid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/.test(cssSrc()), '1150 以下兩欄');
  const fc = cssRule('.flowcard');
  assert.ok(fc?.includes('border-radius:16px;padding:22px;min-height:232px') && fc.includes('background:#fff') && fc.includes('border-top:3px solid #c4cfee'), `.flowcard：${fc}`);
  assert.ok(cssRule('.flowcard h2')?.includes('font-size:17px'), `.flowcard h2：${cssRule('.flowcard h2')}`);
  assert.ok(cssRule('.libtools')?.includes('display:flex') && cssRule('.libtools input')?.includes('flex:1'), '工具列搜尋拉滿');
  assert.ok(cssSrc().includes('.homegrid{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:21px'), '.homegrid 310／21');
  assert.ok(cssRule('.section-head')?.includes('display:flex'), '.section-head 基底');
  assert.equal(count(uiSrc(), 'libcard'), 0, 'app.js 不再輸出 libcard');
  assert.equal(count(cssSrc(), '.libcard'), 0, '.libcard 樣式退場');
});

test('L5 ⑦：垃圾桶頁、匯入預覽頁、讀不懂卡換 page-head＋.panel；按鈕與 data-act 不變', () => {
  const trash = uiFn('trashViewHtml', { state: { trash: [{ key: 'k1', name: 'A', category: '未分類', trashed_at: '2026-09-10T00:00:00.000Z' }] } })();
  assert.ok(trash.startsWith('<div class="page-head"><div><h1>垃圾桶</h1><p>刪掉的 Workflow 放 30 天'), `垃圾桶 page-head：${trash.slice(0, 80)}`);
  assert.ok(trash.includes('data-act="close-trash"') && trash.includes('data-act="restore-trash" data-key="k1"') && trash.includes('class="panel'), '回去鈕＋復原＋白卡');
  assert.ok(uiFn('trashViewHtml', { state: { trash: [] } })().includes('垃圾桶是空的'), '空態');
  const scan = { verdict: 'clean', findings: [] };
  const imp = uiFn('importPreviewHtml', { state: { importPreview: { def: { name: '別人的', nodes: [{ id: 'n1', title: '步一', executor: 'ai', instruction: 'i' }] }, scan } } })();
  assert.ok(imp.startsWith('<div class="page-head"><div><h1>匯入預覽：別人的</h1><p>共 1 步。'), `匯入預覽 page-head：${imp.slice(0, 90)}`);
  assert.ok(imp.includes('class="panel') && imp.includes('data-act="confirm-import"') && imp.includes('data-act="cancel-import"'), '白卡＋確認／不匯入');
  const bad = uiFn('corruptCardHtml', { state: { corrupt: { message: '第 3 行壞掉' } } })();
  assert.ok(bad.startsWith('<div class="page-head"><div><h1>這個 Workflow 的檔案讀不懂</h1>'), `讀不懂 page-head：${bad.slice(0, 80)}`);
  assert.ok(bad.includes('class="panel') && bad.includes('第 3 行壞掉') && bad.includes('data-act="restore-corrupt"') && bad.includes('data-act="close-trash"'), '白卡＋還原上一版＋先回工作區');
  for (const h of [trash, imp, bad]) assert.equal(count(h, 'class="tophead"'), 0, '舊 tophead 退場');
});

// ---------- 行事曆（樣稿 uxCalendar＋驗收第 10 條）、設定（uxSettings）、共用素材頁（uxAssets，驗收第 13 條） ----------
// 多行分支（`} else if (act === 'x') {` … `\n    }`）切到本分支結尾為止（actBranch 遇 `} else if` 同行接續時會切過頭）
const l6Br = (act) => { const m = new RegExp(`act === '${act}'\\) \\{([\\s\\S]*?)\\n {4}\\}`).exec(uiSrc()); assert.ok(m, `事件委派有 ${act} 分支`); return m[1]; };
const l6Cal = (month, cal = {}, extra = {}) => uiFn('calendarHtml', { state: { calendar: { month, data: { events: [], today: '2026-02-10', snapshot: null }, scheds: [], snapErr: null, ...cal }, calPicker: null, calMore: false, ...extra } })();
test('L6 ①：calendarHtml——page-head 行事曆＋新增排程＋「⋯」（內含 cal-refresh）；月份列 h2 點開跳月、←／今天／→、快照時間或失敗句常駐；星期列日開頭；週日開頭依月份 4／5／6 週；圖例在月曆後；排程清單（N）白卡含 cal-manage；頁底提醒＋去設定；CSS 整頁可捲', () => {
  const feb = l6Cal('2026-02');
  assert.ok(feb.includes('<div class="page-head"><div><h1>行事曆</h1><p>工作排程與 Google 唯讀快照，一眼看清安排。</p></div>'), `page-head：${feb.slice(0, 160)}`);
  const head = feb.slice(0, feb.indexOf('class="caltools"'));
  assert.ok(/<button class="btn btn-primary" data-act="cal-add-sched">(<i[^>]*><\/i>)?＋ 新增排程<\/button>/.test(head), '右上 primary 新增排程');
  assert.ok(/data-act="cal-more"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/.test(head), '右上「⋯」');
  assert.equal(count(feb, 'data-act="cal-refresh"'), 0, '重新整理收進「⋯」：收著時不出現');
  const more = l6Cal('2026-02', {}, { calMore: true });
  const menu = /<div class="calmore" role="menu">([\s\S]*?)<\/div>/.exec(more)?.[1];
  assert.ok(menu && /data-act="cal-refresh"[^>]*>(<i[^>]*><\/i>)?重新整理 Google 快照<\/button>/.test(menu), `「⋯」內含重新整理：${menu}`);
  assert.equal(count(more, 'data-act="cal-refresh"'), 1, '整頁只有選單裡這一顆');
  const tools = /<div class="caltools">([\s\S]*?)<div class="mdays">/.exec(feb)?.[1] ?? '';
  assert.ok(/<h2[^>]*>[\s\S]*data-act="cal-pick"[^>]*>2026 年 2 月/.test(tools), `月份 h2 點開跳月：${tools.slice(0, 200)}`);
  const nav = ['data-act="cal-prev"', 'data-act="cal-today"', 'data-act="cal-next"'].map((s) => tools.indexOf(s));
  assert.ok(nav[0] > 0 && nav[0] < nav[1] && nav[1] < nav[2], `←／今天／→：${nav}`);
  assert.ok(/<span class="snapnote" data-snap="none">Google 快照：還沒抓過<\/span>/.test(tools), '沒抓過也常駐一句');
  const ok = l6Cal('2026-02', { data: { events: [], today: '2026-02-10', snapshot: { status: 'ok', fetched_at: '2026-02-09T01:02:00.000Z' } } });
  assert.ok(/<span class="snapnote" data-snap="ok">Google 快照：[^<]*2026[^<]*<\/span>/.test(ok), '最後更新時間常駐可見');
  const bad = l6Cal('2026-02', { data: { events: [], today: '2026-02-10', snapshot: { status: 'failed', reason: '授權過期' } } });
  assert.ok(bad.includes('<span class="snapnote err" data-snap="failed">Google 快照抓不到：授權過期'), '失敗狀態常駐可見（紅字）');
  assert.ok(l6Cal('2026-02', { snapErr: '連不上' }).includes('<span class="snapnote err" data-snap="failed">Google 快照抓不到：連不上'), '剛按重新整理失敗的原因優先');
  assert.ok(/<div class="mdays"><span>日<\/span><span>一<\/span><span>二<\/span><span>三<\/span><span>四<\/span><span>五<\/span><span>六<\/span><\/div>/.test(feb), '星期列日開頭');
  const cells = (h) => [...h.matchAll(/<div class="mcell[^"]*" data-date="([\d-]+)"/g)].map((m) => m[1]);
  assert.equal(cells(feb).length, 28, '2026-02：週日開頭 28 天＝4 週');
  assert.equal(cells(feb)[0], '2026-02-01');
  const aug = cells(l6Cal('2026-08'));
  assert.equal(aug.length, 42, '2026-08：6 週');
  assert.deepEqual([aug[0], aug[41]], ['2026-07-26', '2026-09-05'], '前後補滿整週');
  assert.equal(cells(l6Cal('2026-09')).length, 35, '2026-09：5 週');
  const scheds = [{ id: 's1', name: '週報', freq: 'weekly', weekday: 1, time: '09:00', enabled: true }, { id: 's2', name: '月報', freq: 'monthly', day: 1, time: '08:00', enabled: false }, { id: 's3', name: '日報', freq: 'daily', time: '07:00', enabled: true }];
  const events = [{ sid: 's1', occ: '2026-02-09T09:00', date: '2026-02-09', time: '09:00', kind: 'auto', title: '週報' }, { sid: 's1', occ: '2026-02-16T09:00', date: '2026-02-16', time: '09:00', kind: 'auto', title: '週報' }, { sid: 's1', occ: '2026-02-23T09:00', date: '2026-02-23', time: '09:00', kind: 'auto', title: '週報' }];
  const full = l6Cal('2026-02', { scheds, data: { events, today: '2026-02-10', snapshot: null } });
  const at = (s) => { const i = full.indexOf(s); assert.ok(i >= 0, `該有：${s}`); return i; };
  assert.ok(at('<div class="mgrid">') < at('<div class="callegend">') && at('<div class="callegend">') < at('<section class="panel schedlist">') && at('<section class="panel schedlist">') < at('<div class="calfoot">'), '月曆→圖例→排程清單→頁底提醒');
  const list = full.slice(at('<section class="panel schedlist">'), at('<div class="calfoot">'));
  assert.ok(/<div class="section-head"><h2>排程清單（3）<\/h2><button[^>]*data-act="cal-manage"[^>]*>管理<\/button><\/div>/.test(list), `排程清單（N）＋管理：${list.slice(0, 200)}`);
  assert.ok(list.includes('週報') && list.includes('每週一 09:00') && list.includes('下次 2/16 09:00'), '名稱・頻率・下次時間（本月還沒到的第一場）');
  assert.ok(list.includes('月報') && list.includes('已暫停'), '暫停的排程');
  assert.ok(list.includes('日報') && list.includes('這個月沒有場次'), '本月沒場次也列出');
  assert.ok(l6Cal('2026-02').includes('排程清單（0）') && l6Cal('2026-02').includes('還沒有任何排程'), '空態');
  const foot = full.slice(at('<div class="calfoot">'));
  assert.ok(foot.includes('剝繭沒開著時排程不會跑；錯過的會在下次打開時問你要不要補。') && foot.includes('data-act="open-settings-exec"'), '頁底提醒＋去設定');
  const css = cssSrc();
  assert.ok(!(cssRule('.calpage') ?? '').includes('height'), `.calpage 固定高度退場：${cssRule('.calpage')}`);
  assert.ok(cssRule('.mgrid')?.includes('grid-template-columns:repeat(7,minmax(0,1fr))') && !cssRule('.mgrid').includes('grid-template-rows') && cssRule('.mgrid').includes('border-radius:13px'), `.mgrid 一個大框、列數跟月份：${cssRule('.mgrid')}`);
  assert.ok(cssRule('.mcell')?.includes('min-height:113px'), `.mcell 格高 113：${cssRule('.mcell')}`);
  assert.ok(cssRule('.caltools h2')?.includes('font-size:20px'), `月份 h2 20px：${cssRule('.caltools h2')}`);
  assert.ok(cssRule('.calmore')?.includes('border-radius:12px') && cssRule('.calmore').includes('padding:6px'), `「⋯」選單尺標（W15）：${cssRule('.calmore')}`);
  assert.equal(count(css, '.calhead'), 0, '舊標題列樣式退場');
});

test('L6 ②：拖拉與單次取消照舊——事件落在對的日期格、可拖（draggable）、滑過垃圾桶 cal-ev-del；drop 仍認 .mcell data-date；「⋯」Esc／點外面關、離開行事曆收起', () => {
  const events = [{ sid: 's1', occ: '2026-02-12T09:00', date: '2026-02-12', time: '09:00', kind: 'auto', title: '週報' }];
  const html = l6Cal('2026-02', { data: { events, today: '2026-02-10', snapshot: null } });
  const cell = /<div class="mcell[^"]*" data-date="2026-02-12">([\s\S]*?)<\/div><\/div>/.exec(html)?.[1] ?? '';
  assert.ok(cell.includes('draggable="true" data-sid="s1" data-occ="2026-02-12T09:00"') && cell.includes('data-act="cal-ev-del"'), `事件在 2/12 格內、可拖、可取消：${cell}`);
  assert.ok(/<div class="mcell today" data-date="2026-02-10">/.test(html), '今天格');
  const src = uiSrc();
  assert.ok(src.includes("if (state.calendar && e.target.closest('.mcell')) e.preventDefault();") && src.includes("const cell = e.target.closest('.mcell');"), 'dragover／drop 語意不變');
  assert.ok(src.includes("action: 'move', to: `${cell.dataset.date}T${d.time || '08:00'}`"), '拖拉＝單次 move');
  assert.ok(l6Br('cal-more').includes('state.calMore = !state.calMore'), 'cal-more 切換');
  assert.ok(l6Br('cal-refresh').includes('state.calMore = false'), '按了重新整理收選單');
  assert.ok(src.includes("if (e.key === 'Escape' && state.calMore) { state.calMore = false; render(); return; }"), 'Esc 關');
  assert.ok(/if \(state\.calMore && !e\.target\.closest\('\.calmore'\) && !e\.target\.closest\('\[data-act="cal-more"\]'\)\) \{/.test(src), '點外面關');
  assert.ok(/function closeCalendar\(\) \{[\s\S]*?state\.calMore = false;[\s\S]*?\n\}/.test(src), '離開行事曆收起');
});

const l6SetCtx = (extra = {}) => ({ state: { settings: { group: '個人與記憶', tab: {}, data: null, err: null, msg: null, busy: null }, claude: true, presets: {}, ...extra } });
test('L6 ③：settingsHtml——page-head 設定；.setnav 五組兩行鈕（名稱＋說明，例外改琥珀字）；素材庫組退場；右邊白卡 .setbody h2＝組名；CSS 204／29、白卡 800／24 28／16', () => {
  const html = uiFn('settingsHtml', l6SetCtx())();
  assert.ok(html.startsWith('<div class="page-head"><div><h1>設定</h1><p>個人偏好、Workflow 預設與系統執行，各有明確範圍。</p></div>'), `page-head：${html.slice(0, 120)}`);
  const nav = /<nav class="setnav" aria-label="設定項目">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
  const items = [...nav.matchAll(/<button type="button" class="it( on)?" data-act="set-group" data-g="([^"]+)"[^>]*>([^<]+)<small( class="warn")?>([^<]*)<\/small><\/button>/g)].map((m) => [m[2], m[3], m[5], !!m[1]]);
  assert.deepEqual(J(items), J([
    ['個人與記憶', '個人與記憶', '偏好、身分與資訊範圍', true], ['Workflow 預設', 'Workflow 預設', '只影響新建的 Workflow', false], ['連線', '連線', 'AI 與行事曆快照', false],
    ['執行與排程', '執行與排程', '啟動、提醒與補跑', false], ['資料管理', '資料管理', '備份、垃圾桶與版本', false]]), `五組兩行：${nav}`);
  assert.equal(count(html, '素材庫'), 0, '素材庫組退場（驗收第 13 條）');
  // 白卡頂的 <p class="lead"> 整條退場，那句話收進 h2 旁的說明鈕
  assert.ok(/<section class="setbody" data-group="個人與記憶"><h2>個人與記憶<button type="button" class="hint" aria-expanded="false" aria-label="說明" data-hint="[^"]+">\?<\/button><\/h2>/.test(html), `右邊白卡 h2＝組名＋說明鈕：${html.slice(html.indexOf('class="setbody"'), html.indexOf('class="setbody"') + 220)}`);
  assert.equal(count(html, 'class="lead"'), 0, '白卡頂不再印說明段');
  const down = uiFn('settingsHtml', l6SetCtx({ claude: false, settings: { group: '連線', tab: {}, data: null, err: null } }))();
  assert.ok(/data-g="連線"[^>]*>連線<small class="warn">Claude 連不上<\/small>/.test(down), '連不上改第二行琥珀字');
  const ex = { summary: { paused: false, exceptions: { expired: [{}], dormant: [], replaced: [], changed: [{}] }, counts: { profile: 0, habit: 0 } }, trash: { wf: [], cards: [] }, cfg: {} };
  assert.equal(count(uiFn('settingsHtml', { ...l6SetCtx(), setMemoryHtml: () => 'MEM' })(), 'MEM'), 0, '沒資料時不畫內容（骨架）');
  const withEx = uiFn('settingsHtml', { ...l6SetCtx({ settings: { group: '個人與記憶', tab: {}, data: ex, err: null } }), setMemoryHtml: () => 'MEM' })();
  assert.ok(/data-g="個人與記憶"[^>]*>個人與記憶<small class="warn">2 條例外要看<\/small>/.test(withEx) && withEx.includes('MEM'), '記憶例外改琥珀字');
  const src = uiSrc();
  assert.ok(src.includes("async function openSettings(group = '個人與記憶', tab = null)") && src.includes("await openSettings('執行與排程');"), '預設組與行事曆「去設定」');
  assert.equal(count(src, 'function setAssetsHtml') + count(src, 'setDictFoldHtml') + count(src, 'setTabsHtml'), 0, '舊素材庫分頁、詞典收摺、每組子分頁函式退場');
  assert.ok(cssRule('.setwrap')?.includes('display:grid;grid-template-columns:204px 1fr;gap:29px'), `.setwrap：${cssRule('.setwrap')}`);
  const sb = cssRule('.setbody');
  assert.ok(sb?.includes('background:#fff') && sb.includes('border-radius:16px') && sb.includes('padding:24px 28px') && sb.includes('max-width:800px') && sb.includes('font-size:14px'), `.setbody 白卡：${sb}`);
  assert.ok(cssRule('.setbody h2')?.includes('font-size:21px'), `.setbody h2：${cssRule('.setbody h2')}`);
  assert.ok(cssRule('.setnav .it small')?.includes('font-size:10px'), `說明行 10px：${cssRule('.setnav .it small')}`);
});

test('L6 ④：個人與記憶四個有框分頁鈕 關於你／身分／記憶總覽／欄位詞典（預設關於你）；身分分頁含 id-add、欄位詞典分頁含 <table class="dict"', () => {
  const ctx = (tab) => ({ state: { settings: { tab: tab ? { 個人與記憶: tab } : {}, idEdit: null, merge: null }, categories: [] }, setKnowHtml: () => 'KNOW', setMapHtml: () => 'MAP' });
  const d = { identities: [], cards: [], dict: { fields: [{ name: '語氣', kind: 'appearance', synonyms: [], origin: 'factory' }], usage: {} }, cfg: {} };
  const def = uiFn('setMemoryHtml', ctx(null))(d);
  const tabs = [...def.matchAll(/<button type="button" class="([^"]*)" data-act="set-tab" data-g="個人與記憶" data-k="([^"]+)">/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(J(tabs), J([['關於你', 'on'], ['身分', ''], ['記憶總覽', ''], ['欄位詞典', '']]), `四分頁、預設關於你：${def.slice(0, 400)}`);
  assert.ok(/<div class="settabs" role="tablist">/.test(def) && def.includes('KNOW'), '有框分頁鈕列＋關於你內容');
  assert.ok(uiFn('setMemoryHtml', ctx('身分'))(d).includes('data-act="id-add"'), '身分分頁');
  assert.ok(uiFn('setMemoryHtml', ctx('記憶總覽'))(d).includes('MAP'), '記憶總覽分頁');
  assert.ok(uiFn('setMemoryHtml', ctx('欄位詞典'))(d).includes('<table class="dict"'), '欄位詞典分頁');
  assert.ok(cssRule('.settabs button.on')?.includes('background:#e8edff'), `分頁鈕選中：${cssRule('.settabs button.on')}`);
});

test('L6 ⑤：Workflow 預設、執行與排程、資料管理、連線各為單頁分段（h3，無子分頁鈕）；連線頁含連接器與金鑰兩列「尚未提供」', () => {
  const noTabs = (h) => count(h, 'data-act="set-tab"') + count(h, 'memtabs');
  const df = uiFn('setDefaultsHtml', { state: { settings: { busy: null } } })({ cfg: { defaults: {} } });
  const ex = uiFn('setExecHtml', { state: { settings: { busy: null }, calendar: null } })({ cfg: { exec: {} }, autostart: { enabled: true, supported: true } });
  const da = uiFn('setDataHtml', { state: { settings: { busy: null, msg: null } }, memAt: () => '' })({ cfg: { data_dir: 'x' }, backups: [], trash: { wf: [], cards: [] } });
  const co = uiFn('setConnHtml', { state: { settings: { busy: null, msg: null }, claude: true }, memAt: () => '' })({ snapshot: null });
  for (const [name, h, secs] of [['Workflow 預設', df, ['權限與查核', 'AI 步驟', '停點']], ['執行與排程', ex, ['常駐', '排程', 'AI 工人']], ['資料管理', da, ['組織', '位置與備份', '清理', '關於']], ['連線', co, ['Claude', 'Google 行事曆', '連接器與金鑰']]]) {
    const idx = secs.map((s) => h.indexOf(`<h3>${s}</h3>`));
    assert.ok(idx.every((x, i) => x >= 0 && (i === 0 || x > idx[i - 1])), `${name} 分段依序：${idx}`);
    assert.equal(noTabs(h), 0, `${name} 沒有子分頁鈕`);
  }
  assert.ok(secOf(ex, '常駐').includes('data-act="autostart-toggle"') && secOf(ex, '排程').includes('錯過時') && secOf(ex, 'AI 工人').includes('允許查網路'), '執行與排程三段內容');
  assert.ok(secOf(co, 'Claude').includes('data-act="reconnect"') && secOf(co, 'Google 行事曆').includes('data-act="set-cal-refresh"'), '連線 Claude／Google 內容');
  assert.equal(count(secOf(co, '連接器與金鑰'), '尚未提供'), 2, '連接器與金鑰兩列');
  assert.ok(secOf(da, '清理').includes('清空記憶') && secOf(da, '關於').includes('MIT 授權'), '資料管理 清理／關於 內容');
  const { sandbox } = uiCtx();
  assert.deepEqual(Object.keys(sandbox.SET_TABS), ['個人與記憶'], '只剩個人與記憶有分頁');
});

const l6Presets = { role_context: [{ name: '行銷主管', text: '你是行銷主管，重視轉換。' }], snippet: [{ name: '簡介', text: '一句話簡介' }] };
const l6Assets = (a = {}, presets = l6Presets) => uiFn('assetsHtml', { state: { assets: { tab: '全部', edit: null, err: null, ...a }, presets } })();
test('L6 ⑥：assetsHtml——page-head 共用素材＋新增素材；分頁鈕 全部／角色情境／常用片段；.assetcard 列出兩種素材（類型 chip、h3、內文）、編輯／刪除沿用 presets API；側欄入口選中；CSS 兩欄', () => {
  const html = l6Assets();
  assert.ok(html.includes('<div class="page-head"><div><h1>共用素材</h1><p>把好用的角色情境與指示片段整理起來，編輯步驟時隨手取用。</p></div>'), `page-head：${html.slice(0, 140)}`);
  assert.ok(/<button class="btn btn-primary" data-act="asset-new">＋ 新增素材<\/button>/.test(html), '右上 primary 新增素材');
  const tabs = [...html.matchAll(/<button type="button" class="([^"]*)" data-act="assets-tab" data-t="([^"]+)">/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(J(tabs), J([['全部', 'on'], ['角色情境', ''], ['常用片段', '']]), '分頁鈕三個');
  const cards = [...html.matchAll(/<article class="assetcard" data-field="([^"]+)" data-preset="([^"]+)"><span class="chip">([^<]+)<\/span><h3>([^<]+)<\/h3><p>([^<]*)<\/p>/g)].map((m) => m.slice(1, 6));
  assert.deepEqual(J(cards), J([['role_context', '行銷主管', '角色情境', '行銷主管', '你是行銷主管，重視轉換。'], ['snippet', '簡介', '常用片段', '簡介', '一句話簡介']]), `兩種素材各一張：${html}`);
  assert.ok(html.includes('data-act="asset-edit" data-field="snippet" data-name="簡介"') && html.includes('data-act="asset-del" data-field="snippet" data-name="簡介"'), '編輯／刪除');
  assert.equal(count(l6Assets({ tab: '常用片段' }), 'class="assetcard"'), 1, '分頁篩類型');
  const editing = l6Assets({ edit: { field: 'snippet', orig: '簡介', name: '簡介', text: '改過', err: '要有名字和內容才能存' } });
  assert.ok(/<article class="assetcard editing" data-edit="snippet">/.test(editing) && editing.includes('data-pf="name"') && editing.includes('data-pf="text"') && editing.includes('data-act="asset-save"') && editing.includes('data-act="asset-cancel"') && editing.includes('要有名字和內容才能存'), '編輯中卡原地換表單');
  assert.equal(count(editing, 'data-preset="簡介"'), 0, '被編輯那張不重複出現');
  const adding = l6Assets({ edit: { field: 'role_context', orig: null, name: '', text: '', err: null } });
  assert.ok(adding.indexOf('data-edit="role_context"') < adding.indexOf('data-preset="行銷主管"') && /<select[^>]*data-pf="field"/.test(adding), '新增表單在最前、可選類型');
  assert.ok(l6Assets({}, { role_context: [], snippet: [] }).includes('還沒有素材'), '空態');
  const src = uiSrc();
  const save = l6Br('asset-save');
  assert.ok(save.includes('state.assets.edit') && save.includes("api('POST', '/api/presets'") && save.includes("state.presets = await api('GET', '/api/presets')"), 'asset-save 沿用 presets API');
  assert.ok(l6Br('asset-del').includes("api('DELETE', `/api/presets/"), 'asset-del 沿用 presets API');
  assert.ok(src.includes("if (t.dataset?.pf && state.assets?.edit) state.assets.edit[t.dataset.pf] = t.value;"), '輸入寫回 state（輪詢重繪讀回）');
  assert.ok(/async function openAssets\(\) \{[\s\S]*?state\.assets = \{ tab: '全部', edit: null, err: null \};[\s\S]*?api\('GET', '\/api\/presets'\)[\s\S]*?\n\}/.test(src), 'openAssets 開整頁並讀素材');
  assert.ok(src.includes('else if (state.assets) inner = assetsHtml();'), 'render 分派');
  const side = t9Side({ assets: { tab: '全部' }, claude: true });
  assert.ok(/class="asset-entry active" data-act="open-assets"[^>]*aria-current="page"/.test(side), `側欄共用素材選中：${/<div class="asset-entry[^>]*>/.exec(side)?.[0]}`);
  assert.equal(count(side, 'calentry now'), 0, '四全域項不亮');
  assert.ok(cssSrc().includes('.assetgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px'), `.assetgrid：${cssRule('.assetgrid')}`);
  assert.ok(cssRule('.assetcard')?.includes('border-radius:13px') && cssRule('.assetcard').includes('padding:21px'), `.assetcard：${cssRule('.assetcard')}`);
  assert.ok(cssRule('.asset-entry.active')?.includes('background:#dce5ff'), `.asset-entry.active：${cssRule('.asset-entry.active')}`);
});

test('L6 ⑧（L5 範圍外遺留）：Workflow 庫「匯入」選檔取消＝留在 Workflow 庫（選到檔才關頁）；從 Workflow 庫進垃圾桶，「回 Workflow 庫」回庫頁', () => {
  const src = uiSrc();
  const pick = l6Br('pick-import');
  assert.ok(pick.includes("document.getElementById('import-file').click();") && !pick.includes('closeLibrary()') && !pick.includes('closeSettings()'), `按匯入只開選檔，不先關頁：${pick}`);
  const change = /document\.getElementById\('import-file'\)\.addEventListener\('change', async \(e\) => \{([\s\S]*?)\n\}\);/.exec(src)?.[1] ?? '';
  assert.ok(change.indexOf('if (!file) return;') >= 0 && change.indexOf('if (!file) return;') < change.indexOf('closeSettings(); closeLibrary(); closeAssets();'), `選到檔才關頁（取消＝留在原頁）：${change}`);
  const vt = l6Br('view-trash');
  assert.ok(vt.indexOf('state.trashFromLib = !!state.library;') >= 0 && vt.indexOf('state.trashFromLib = !!state.library;') < vt.indexOf('closeLibrary()'), '記住是從庫頁進來的（關頁前）');
  const ct = l6Br('close-trash');
  assert.ok(/if \(back\) openLibrary\(\);\s*else render\(\);/.test(ct) && ct.includes('state.trashFromLib = false;'), `回庫頁：${ct}`);
  const lib = uiFn('trashViewHtml', { state: { trash: [], trashFromLib: true } })();
  assert.ok(/data-act="close-trash">(<i[^>]*><\/i>)?回 Workflow 庫<\/button>/.test(lib), '從庫頁來＝「回 Workflow 庫」');
  assert.ok(/data-act="close-trash">(<i[^>]*><\/i>)?回工作區<\/button>/.test(uiFn('trashViewHtml', { state: { trash: [], trashFromLib: false } })()), '其他入口照舊「回工作區」');
});

// ---------- 組織頁（樣稿 uxOrgPage）＋分類頁（樣稿分類版＋驗收第 2／7 條）；共用檔「查看」（上桌b） ----------
const l7Shared = (over = {}) => ({ rules: [{ name: 'a.md', chars: 1200, bytes: 3600, uploaded_at: '2026-09-15T08:00:00.000Z' }], refs: [{ name: '範本.docx', chars: null, bytes: 15360, uploaded_at: '2026-09-15T08:00:00.000Z' }], rule_chars: 1200, limits: { per_file: 4000, per_layer: 8000 }, ...over });
const l7Page = (category, cpExtra = {}, stateExtra = {}) => uiFn('categoryPageHtml', {
  fmtInt: realFmtInt,
  state: {
    categoryPage: { category, data: { rules: [{ status: 'active', field: '語氣', value: '輕鬆' }, { status: 'active', text: '不提競品' }, { status: 'retired', text: '舊的' }], text: '語氣：輕鬆\n不提競品' }, cards: [{ id: 'c1' }], err: null, saving: false, saveErr: null, shared: l7Shared(), uploadErr: null, msg: null, ...cpExtra },
    categories: ['旅遊', '行銷', '未分類'],
    workflows: [{ id: 'a', name: 'A 訂餐廳', category: '旅遊', steps: 3, human_steps: 1 }, { id: 'b', name: 'B 週報', category: '行銷', steps: 2, human_steps: 0 }],
    keep: {}, run: null, wf: null, chat: { draft: null, messages: [] }, addingCategory: false, companyName: '範例公司', ...stateExtra,
  },
})();

test('L7 ①：組織頁——麵包屑「工作空間」→ page-head 組織名＋說明＋修改名稱＋「＋ 新增分類」；新增分類行內表單（confirm-category）；各分類「X →」捷徑；.orggrid 兩張 .panel.org-files（section-head h2 規範／參考＋上傳；灰字 每一步都帶・已 N／8,000 字｜勾選才帶；每檔 檔名・大小・時間＋查看＋刪除）', () => {
  const html = l7Page('_company', { data: null });
  const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, `該有：${s}`); return i; };
  assert.ok(at('<nav class="breadcrumb">工作空間</nav>') < at('<div class="page-head"><div><h1>範例公司</h1><p>組織規範會帶進每一條 Workflow；參考按需選用。</p></div>'), '麵包屑在標題上');
  const head = /<div class="page-head">[\s\S]*?<\/div><\/div>/.exec(html)[0];
  assert.ok(head.includes('data-act="rename-open" data-type="company"') && head.includes('修改名稱'), '修改名稱在標題右側');
  assert.ok(/data-act="add-category"[^>]*>＋ 新增分類<\/button>/.test(head), `＋ 新增分類在標題右側（驗收第 2 條）：${head}`);
  assert.equal(count(html, 'id="new-category"'), 0, '沒按新增時沒有表單');
  const adding = l7Page('_company', { data: null }, { addingCategory: true });
  assert.ok(adding.includes('id="new-category"') && adding.includes('data-act="confirm-category"') && adding.includes('data-act="cancel-category"'), '行內表單：名稱＋建立＋取消');
  assert.ok(/<input id="new-category"[^>]*data-keep/.test(adding), '輸入框 data-keep（輪詢重繪不洗字）');
  const pills = /<div class="pillnav">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  assert.deepEqual([...pills.matchAll(/data-act="open-category" data-cat="([^"]+)"[^>]*>([^<]+)<\/button>/g)].map((m) => [m[1], m[2]]), [['旅遊', '旅遊 →'], ['行銷', '行銷 →'], ['未分類', '未分類 →']], '分類捷徑（顯示名 catLabel、data-cat 資料值）');
  assert.ok(at('<div class="pillnav">') < at('<div class="orggrid">'), '捷徑在檔案卡之前');
  assert.equal(count(html, 'class="panel org-files sharedsec"'), 2, '兩張檔案卡');
  const [rule, ref] = html.split('<section class="panel org-files sharedsec"').slice(1);
  assert.ok(/<div class="section-head"><h2>規範<\/h2><button[^>]*data-act="shared-upload" data-kind="rule"/.test(rule) && rule.includes('<p class="note">每一步都帶・已 1,200／8,000 字</p>'), `規範卡頭＋灰字：${rule.slice(0, 300)}`);
  assert.ok(/<div class="section-head"><h2>參考<\/h2><button[^>]*data-act="shared-upload" data-kind="ref"/.test(ref) && ref.includes('<p class="note">勾選才帶</p>'), '參考卡頭＋灰字');
  const row = /<div class="file">[\s\S]*?<\/button><\/div>/.exec(ref)[0];
  assert.ok(row.includes('<h3><i class="ph ph-file"></i>範本.docx</h3>') && row.includes('<small>15 KB・') && row.includes('data-act="shared-view" data-kind="ref" data-name="範本.docx"') && row.includes('>查看</button>') && row.includes('data-act="shared-del" data-kind="ref" data-name="範本.docx"') && row.includes('>刪除</button>'), `一列 檔名・大小・時間＋查看＋刪除：${row}`);
  assert.ok(row.indexOf('shared-view') < row.indexOf('shared-del'), '查看在刪除之前（樣稿）');
  assert.ok(!html.includes('分類 Workflow') && !html.includes('guidelines'), '組織頁沒有守則卡與 Workflow 區');
  const css = cssSrc();
  assert.ok(cssRule('.breadcrumb')?.includes('font-size:11px') && cssRule('.breadcrumb').includes('margin-bottom:15px'), `.breadcrumb：${cssRule('.breadcrumb')}`);
  assert.ok(cssRule('.orggrid')?.includes('grid-template-columns:1fr 1fr') && cssRule('.orggrid').includes('gap:19px'), `.orggrid：${cssRule('.orggrid')}`);
  assert.ok(cssRule('.pillnav')?.includes('gap:8px') && cssRule('.pillnav').includes('margin:18px 0'), `.pillnav：${cssRule('.pillnav')}`);
  assert.ok(cssRule('.org-files .file')?.includes('padding:12px 0') && cssRule('.org-files .file').includes('display:flex'), `.org-files .file：${cssRule('.org-files .file')}`);
  assert.equal(count(css, '.catpage{'), 0, '舊兩欄 .catpage 格線退場');
});

test('L7 ②：分類頁——麵包屑「工作空間 › 組織名」→ page-head 分類名＋說明＋修改名稱 → .panel.guidelines 在最前（h3 分類守則、灰字、#group-text、save-group「儲存」、拆好的規矩 <details> 在卡內）→ .orggrid 兩張檔案卡 → h2 分類 Workflow＋.libgrid .flowcard；「未分類」無修改名稱、無新增分類', () => {
  const html = l7Page('旅遊');
  const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, `該有：${s}`); return i; };
  const bc = /<nav class="breadcrumb">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
  assert.equal(bc.replace(/<[^>]+>/g, ''), '工作空間 › 範例公司', `麵包屑字：${bc}`);
  assert.ok(bc.includes('data-act="open-company"'), '組織名可點回組織頁');
  assert.ok(at('<nav class="breadcrumb">') < at('<h1>旅遊</h1><p>分類守則與資料，讓同一團隊的工作保持一致。</p>'), '標題＋說明');
  assert.ok(/<div class="page-head">[\s\S]*?data-act="rename-open" data-type="category" data-cat="旅遊"/.test(html) && !html.includes('data-act="add-category"'), '分類頁有修改名稱、沒有新增分類');
  const g = at('<section class="panel guidelines">');
  assert.ok(g < at('<div class="orggrid">') && at('<div class="orggrid">') < at('<h2 class="section-title">分類 Workflow</h2>') && at('<h2 class="section-title">分類 Workflow</h2>') < at('<div class="libgrid">'), '守則卡→檔案卡→分類 Workflow');
  const card = html.slice(g, html.indexOf('<div class="orggrid">'));
  assert.ok(card.includes('<h3>分類守則</h3><p class="note">這個分類的每一步都會帶入。</p>') && card.includes('id="group-text"') && /data-act="save-group"[^>]*>(<i[^>]*><\/i>)?儲存<\/button>/.test(card), `守則卡：${card.slice(0, 400)}`);
  const fold = /<details class="rulefold">([\s\S]*?)<\/details>/.exec(card)?.[1];
  assert.ok(fold, '拆好的規矩收在守則卡內的 <details>（驗收第 7 條）');
  assert.ok(!/<details class="rulefold"[^>]*\sopen/.test(card), '預設收著，細項點開才看');
  assert.ok(fold.includes('<summary>拆好的規矩・2 條</summary>') && fold.includes('<span class="chip gfield">語氣</span><span class="gval">輕鬆</span>') && fold.includes('不提競品') && !fold.includes('舊的') && fold.includes('這個分類共用 1 張習慣卡'), `規矩列與習慣卡數：${fold}`);
  assert.equal(count(html, 'class="panel org-files sharedsec"'), 2);
  assert.equal(count(html, 'class="flowcard"'), 1, '只列該分類');
  assert.ok(html.includes('1 步你來') && html.includes('data-act="open" data-cat="旅遊" data-id="a"'), '同 Workflow 庫卡');
  const busy = l7Page('旅遊', { saving: true, saveErr: '存不進去' });
  assert.ok(/data-act="save-group" disabled[^>]*>(<i[^>]*><\/i>)?存檔中⋯<\/button>/.test(busy) && busy.includes('存不進去'), '存檔中與錯誤一句照舊');
  const un = l7Page('未分類');
  assert.ok(!un.includes('rename-open') && un.includes('<h1>未分類</h1>'), '「未分類」不能改名、顯示未分類');
  assert.ok(cssRule('.guidelines')?.includes('margin-bottom:20px'), `.guidelines：${cssRule('.guidelines')}`);
  assert.ok(cssRule('.guidelines textarea')?.includes('min-height:80px'), `.guidelines textarea：${cssRule('.guidelines textarea')}`);
  assert.ok(cssRule('.section-title')?.includes('font-size:16px') && cssRule('.section-title').includes('margin:27px 0 15px'), `.section-title：${cssRule('.section-title')}`);
});

test('L7 ③：空態兩句、分類沒有 Workflow 一句、上傳錯／訊息各一句在該卡、群組圈讀不到錯誤卡（檔案卡與 Workflow 區照常）、共用檔讀不到兩卡各一句＋重試', () => {
  const empty = l7Page('旅遊', { shared: l7Shared({ rules: [], refs: [], rule_chars: 0 }) }, { workflows: [] });
  assert.equal(count(empty, '還沒有規範。放進來的內容，AI 每一步都照著。'), 1);
  assert.equal(count(empty, '還沒有參考。步驟裡勾了才給 AI。'), 1);
  assert.equal(count(empty, '這個分類還沒有 Workflow。'), 1);
  const up = l7Page('旅遊', { uploadErr: { kind: 'ref', text: '已有同名檔，先刪再傳' }, msg: { kind: 'rule', text: '已刪除' } });
  const [rule, ref] = up.split('<section class="panel org-files sharedsec"').slice(1);
  assert.ok(ref.includes('<p class="note err" role="alert">已有同名檔，先刪再傳</p>') && !rule.includes('已有同名檔'), '上傳錯在參考卡');
  assert.ok(rule.includes('<p class="note ok">已刪除</p>') && !ref.includes('已刪除'), '訊息在規範卡');
  const gerr = l7Page('旅遊', { err: '群組圈壞了', data: null });
  assert.ok(gerr.includes('這個分類的規矩讀不到') && gerr.includes('群組圈壞了') && gerr.includes('data-act="reload-category"'), '錯誤卡');
  assert.ok(gerr.indexOf('這個分類的規矩讀不到') < gerr.indexOf('<div class="orggrid">') && gerr.includes('分類 Workflow') && !gerr.includes('id="group-text"'), '檔案卡與 Workflow 區照常、無守則框');
  const serr = l7Page('旅遊', { shared: null, sharedErr: '共用夾壞了' });
  assert.equal(count(serr, '共用檔讀不到：共用夾壞了'), 2);
  assert.equal(count(serr, 'data-act="reload-category"'), 2, '兩卡各一顆重試');
});

test('L7 ④：W11——有打開中的工作區（state.wf、草稿或聊天）才有「回工作區」；沒有就不印；closeCategory 收起新增分類表單；cancel-category 分支', () => {
  const back = (st) => count(l7Page('旅遊', {}, st), 'data-act="close-category"');
  assert.equal(back({}), 0, '沒打開工作區不印');
  assert.equal(back({ wf: { category: '旅遊', id: 'a' } }), 1, '有 state.wf');
  assert.equal(back({ chat: { draft: { name: 'x' }, messages: [] } }), 1, '有草稿');
  assert.equal(back({ chat: { draft: null, messages: [{ role: 'user', text: 'hi' }] } }), 1, '有對話');
  assert.equal(count(l7Page('_company', { data: null }, { wf: { category: '旅遊', id: 'a' } }), 'data-act="close-category"'), 1, '組織頁同');
  const head = /<div class="page-head">[\s\S]*?<\/div><\/div>/.exec(l7Page('旅遊', {}, { wf: { category: '旅遊', id: 'a' } }))[0];
  assert.ok(head.includes('data-act="close-category"'), '回工作區在標題右側');
  const cc = /function closeCategory\(\) \{[\s\S]*?\n\}/.exec(uiSrc())[0];
  assert.ok(cc.includes('state.addingCategory = false;'), '離開組織頁收起表單');
  const cancel = l6Br('cancel-category');
  assert.ok(cancel.includes('state.addingCategory = false;') && cancel.includes('render();'), `取消：${cancel}`);
  assert.ok(l6Br('confirm-category').includes("delete state.keep[keepKey('new-category')]"), '建立後清掉暫存字');
});

test('L7 ⑤（題 3b）：「查看」——shared-view 開既有預覽浮窗（GET 共用檔 /view）；previewHtml 共用檔的下載走共用檔路徑、kind text 印原文 <pre>；錯誤一句＋下載', async () => {
  const src = uiSrc();
  assert.ok(l6Br('shared-view').includes('openSharedPreview(state.categoryPage.category, el.dataset.name)'), '分支');
  const calls = [];
  const st = { preview: null };
  const renders = [];
  await uiFn('openSharedPreview', { state: st, render: () => renders.push(st.preview?.data ? 'data' : 'wait'), api: async (m, p) => { calls.push([m, p]); return { name: 'a.md', kind: 'text', text: '# 原文' }; } })('旅遊', 'a b.md');
  assert.deepEqual(calls, [['GET', `/api/shared/${encodeURIComponent('旅遊')}/files/${encodeURIComponent('a b.md')}/view`]]);
  assert.deepEqual(renders, ['wait', 'data'], '先開浮窗再填內容');
  assert.equal(st.preview.shared, '旅遊');
  const pv = uiFn('previewHtml', { state: st, runFileUrl: () => 'RUN' })();
  assert.ok(pv.includes('<pre class="pvtext"># 原文</pre>'), 'md／txt 看原文');
  assert.ok(pv.includes(`href="/api/shared/${encodeURIComponent('旅遊')}/files/${encodeURIComponent('a b.md')}"`) && !pv.includes('RUN'), '下載走共用檔既有下載路徑');
  const e = { preview: null };
  await uiFn('openSharedPreview', { state: e, render: () => {}, api: async () => { throw new Error('這種檔不能在頁內看'); } })('_company', 'x.pdf');
  assert.ok(uiFn('previewHtml', { state: e, runFileUrl: () => 'RUN' })().includes('預覽讀不到：這種檔不能在頁內看'), '讀不到一句');
  assert.ok(/previewHtml\(\).*promptModalHtml\(/.test(src.split('\n').find((l) => l.includes('app.innerHTML = `<div class="layout">'))), '浮窗串不動');
});

test('L7 ⑥（L6 範圍外遺留）：從 Workflow 庫匯入，預覽頁「不匯入」回 Workflow 庫；掃描失敗也回；其他入口照舊回工作區；確認匯入清旗標', () => {
  const src = uiSrc();
  const change = /document\.getElementById\('import-file'\)\.addEventListener\('change', async \(e\) => \{([\s\S]*?)\n\}\);/.exec(src)?.[1] ?? '';
  const flag = change.indexOf('state.importFromLib = !!state.library;');
  assert.ok(flag >= 0 && flag < change.indexOf('closeSettings(); closeLibrary(); closeAssets();'), `關頁前記住從庫頁來：${change}`);
  assert.ok(/if \(!state\.importPreview && state\.importFromLib\) \{ state\.importFromLib = false; openLibrary\(\); return; \}/.test(change), '掃描失敗回庫頁');
  const cancel = l6Br('cancel-import');
  assert.ok(/const back = state\.importFromLib;\s*state\.importFromLib = false;\s*state\.importPreview = null;\s*if \(back\) openLibrary\(\);\s*else render\(\);/.test(cancel), `不匯入：${cancel}`);
  assert.ok(l6Br('confirm-import').includes('state.importFromLib = false;'), '確認匯入清旗標');
  assert.ok(src.includes('importFromLib: false,'), 'state 初值');
});

// ---------- Workflow 頁框＋清單大卡＋右欄步驟檢視器＋執行需要的資料＋履歷 ----------
const l8Nodes = [{ id: 'n1', title: '一', executor: 'ai', stop_point: 'always', next: ['n2'] }, { id: 'n2', title: '二', executor: 'human', next: [] }, { id: 'f', kind: 'fork', next: [] }];
const l8Base = { chat: { draft: null }, versions: [{ version: 3 }], categories: ['旅遊', '行銷'], flowTab: 'design', mode: 'list', companyName: '範例公司', cvDirty: false, wf: { category: '旅遊', id: 'a', def: { name: 'A', params: [], nodes: l8Nodes } } };
const l8Head = (extra = {}) => uiFn('workHeadHtml', { state: { ...l8Base, ...extra } })();

test('L8 ①：workHeadHtml——麵包屑→.heading（h1＋修改名稱＋版本標籤 vN・現行 可點開履歷）→右「Workflow 設定」＋「⋯」row-menu；#move-select／export-wf／delete-wf 0 命中；.sub「N 個步驟・M 個停點」；cvDirty＝未儲存取代版本號；草稿＝草稿・還沒存、無設定與「⋯」', () => {
  const h = l8Head();
  const at = (s) => { const i = h.indexOf(s); assert.ok(i >= 0, `該有：${s}\n${h}`); return i; };
  assert.ok(h.startsWith('<nav class="crumbs"'), '麵包屑在最上');
  assert.ok(at('<div class="heading">') < at('<h1>A</h1>') && at('<h1>A</h1>') < at('data-act="rename-open" data-type="flow"') && at('data-act="rename-open"') < at('v3・現行'), '標題→修改名稱→版本標籤');
  assert.ok(/<span class="chip vertag" data-act="mode-history" tabindex="0" role="button"[^>]*><i class="ph-fill ph-seal-check"><\/i>v3・現行<\/span>/.test(h), '版本標籤可點開履歷、鍵盤可聚焦');
  const actions = h.slice(at('<div class="actions">'), at('<p class="sub flowsub">'));
  assert.ok(actions.indexOf('data-act="flow-settings"') >= 0 && actions.indexOf('data-act="flow-settings"') < actions.indexOf('data-act="row-menu" data-cat="旅遊" data-id="a" data-name="A"'), `右側 Workflow 設定→⋯：${actions}`);
  assert.ok(actions.includes('Workflow 設定</button>') && actions.includes('aria-haspopup="menu"'), '兩顆鈕');
  for (const gone of ['id="move-select"', 'data-act="export-wf"', 'data-act="delete-wf"']) assert.equal(count(h, gone), 0, `${gone} 收進「⋯」`);
  assert.ok(h.includes('<p class="sub flowsub">2 個步驟・1 個停點</p>'), '步數一行（並行點不算步驟）');
  const dirty = l8Head({ cvDirty: true });
  assert.ok(/<span class="chip wait vertag" data-act="mode-history" tabindex="0" role="button"[^>]*><i class="ph ph-pencil-simple-line"><\/i>未儲存<\/span>/.test(dirty), '未儲存');
  assert.equal(count(dirty, '現行'), 0, '未儲存優先');
  const draft = l8Head({ wf: null, chat: { draft: { name: '草稿 X', nodes: l8Nodes, params: [] } } });
  assert.ok(draft.includes('<h1>草稿 X</h1>') && draft.includes('草稿・還沒存') && count(draft, 'vertag') === 0 && !draft.includes('row-menu') && !draft.includes('flow-settings'), `草稿：${draft}`);
  assert.equal(count(uiSrc(), 'move-select'), 0, '#move-select 的 change 分支一併退場');
});

test('L8 ②：底線分頁 .flowtabs（data-flowtabs、flow-tab data-tab）→ 工具列 .flowtool：四個 mode-*＋.saved＋存檔（cvDirty 才可按）＋primary 準備執行（flow-tab data）；本次資料分頁無工具列；草稿只有四模式；畫布自己的工具列不再有存檔', () => {
  const h = l8Head();
  const tabs = /<div class="flowtabs" data-flowtabs>[\s\S]*?<\/div>/.exec(h)?.[0] ?? '';
  assert.ok(tabs.includes('<span class="on" data-act="flow-tab" data-tab="design" tabindex="0" role="button">設計 Workflow</span>') && tabs.includes('<span class="" data-act="flow-tab" data-tab="data" tabindex="0" role="button">本次資料</span>'), `分頁：${tabs}`);
  assert.ok(h.indexOf('data-flowtabs') < h.indexOf('<div class="flowtool">'), '分頁在工具列之上');
  const tool = h.slice(h.indexOf('<div class="flowtool">'));
  for (const m of ['mode-chat', 'mode-list', 'mode-canvas', 'mode-history']) assert.ok(tool.includes(`data-act="${m}" tabindex="0" role="button"`), m);
  assert.ok(tool.includes('<span class="saved">所有變更已儲存</span>') && tool.includes('<button class="btn" data-act="cv-save" disabled>存檔</button>'), '乾淨：已儲存、存檔不可按');
  assert.ok(tool.includes('<button class="btn btn-primary" data-act="flow-tab" data-tab="data">準備執行</button>'), '準備執行');
  const dirty = l8Head({ cvDirty: true });
  assert.ok(dirty.includes('<span class="saved">有改動未存檔</span>') && dirty.includes('<button class="btn" data-act="cv-save">存檔</button>'), '有改動：存檔可按');
  const data = l8Head({ flowTab: 'data' });
  assert.ok(data.includes('<span class="on" data-act="flow-tab" data-tab="data"') && count(data, 'class="flowtool"') === 0, '本次資料分頁：無工具列');
  const draft = l8Head({ wf: null, chat: { draft: { name: '草稿 X', nodes: [], params: [] } } });
  assert.ok(draft.includes('<div class="flowtool">') && draft.includes('data-act="mode-canvas"') && !draft.includes('cv-save') && !draft.includes('準備執行') && !draft.includes('data-flowtabs'), '草稿只有四模式');
  const cv = /function canvasModeHtml\(\) \{[\s\S]*?\n\}\n/.exec(uiSrc())[0];
  assert.equal(count(cv, 'data-act="cv-save"'), 0, '畫布工具列不重複存檔');
});

const l8Def = { name: 'X', params: [{ key: 'k1', label: '期間', default: 'Q3' }], nodes: [
  { id: 'n1', title: '收集', executor: 'ai', instruction: '整理 {{k1}} 的資料', output_type: '表格', output_length: '一頁', review_focus: '數字對得上', stop_point: 'always', next: ['n2'] },
  { id: 'n2', title: '確認', executor: 'human', instruction: '你看過', handoff: '確認後的名單', next: [] }] };
const l8Runs = [...u4bRuns, { ...u4bRuns[1], run_id: 'r0' }, { ...u4bRuns[1], run_id: 'r-1' }];
const l8Insp = (extra = {}, helpers = {}) => uiFn('inspectorHtml', u4bCtx({ canvasSel: 'n1', inspectorTab: 'step', cvWork: null, wfRuns: l8Runs, wfMemory: { core: { expression: [1], content: [] }, group: { rules: [] }, habits: { own: [], inherited: [], probes: [] }, options: {} }, ...extra },
  { subjectDef: () => l8Def, cvDef: () => l8Def, preflightFor: () => ({ inputs: { pred: {}, src: {}, at: { n1: { near: [], own: [{ kind: 'param', label: '期間' }] } } } }), ...helpers }))();

test('L8 ③：inspectorHtml——aside.right 內 .panel.inspector；步驟｜Workflow 資料分頁；步驟頁＝STEP NN、名稱、任務（人話化）、輸入來源、這一步會帶、交付、驗收、完整編輯；人做步驟＝交出什麼；沒選＝提示；讀取中；Workflow 資料頁＝原資料夾全部 data-act＋每步會帶入；草稿無分頁；執行頁空', () => {
  const h = l8Insp();
  assert.ok(h.startsWith('<aside class="right"><div class="panel inspector" data-inspector>'), '外殼');
  assert.ok(h.includes('<span class="on" data-act="inspector-tab" data-tab="step" tabindex="0" role="button">步驟</span>') && h.includes('data-act="inspector-tab" data-tab="data" tabindex="0" role="button">Workflow 資料</span>'), '兩分頁');
  const at = (s) => { const i = h.indexOf(s); assert.ok(i >= 0, `該有：${s}\n${h}`); return i; };
  const order = ['STEP 01', '<h3 class="insptitle">收集</h3>', '>任務</span>', '整理 <span class="pchip" title="期間">Q3</span> 的資料', '>輸入來源・沿路產出</span>', '設定欄位：期間', 'data-dmem', '>交付內容</span>', '類型：表格', '份量：一頁', '>驗收重點</span>', '數字對得上', 'data-act="edit-step" data-node="n1"'].map(at);
  assert.ok(order.every((x, i) => i === 0 || x > order[i - 1]), `順序：${order}`);
  assert.ok(h.includes('>完整編輯</button>') && h.includes('<span class="chip wait"><i class="ph-fill ph-hand-palm"></i>停點</span>') && h.includes('<span class="chip">AI</span>'), '完整編輯＋執行者／停點 chip');
  assert.ok(h.includes('data-insp-inputs'), '輸入來源可局部補畫');
  const hu = l8Insp({ canvasSel: 'n2' });
  assert.ok(hu.includes('STEP 02') && hu.includes('確認後的名單') && hu.includes('<i class="ph ph-user"></i>你來') && hu.includes('01 收集') && !hu.includes('data-dmem'), `人做步驟：${hu}`);
  assert.ok(hu.includes('>驗收重點</span><p><span class="note">沒設</span></p>'), '驗收重點沒設');
  const none = l8Insp({ canvasSel: null });
  assert.ok(none.includes('點一張步驟卡看細節') && !none.includes('edit-step'), '沒選');
  assert.ok(l8Insp({}, { preflightFor: () => null }).includes('檢查中⋯'), '健檢還沒回');
  const data = l8Insp({ inspectorTab: 'data' });
  for (const a of ['open-company', 'open-category', 'ref-upload', 'refs-all', 'runs-all', 'todo-go', 'shared-open', 'flowmem-open']) assert.ok(data.includes(`data-act="${a}"`), `Workflow 資料頁含 ${a}`);
  assert.ok(data.includes('<span class="on" data-act="inspector-tab" data-tab="data"') && data.includes('<aside class="flowaside"') && data.includes('data-flowmemline') && !data.includes('STEP 01'), '資料頁＝原資料夾＋每步會帶入一行');
  const draft = l8Insp({ inspectorTab: 'data' }, { subjectIsDraft: () => true });
  assert.ok(!draft.includes('inspector-tab') && draft.includes('STEP 01'), '草稿只有步驟頁');
  assert.equal(l8Insp({ run: { run_id: 'r' } }), '', '執行頁不印');
});

test('L8 ④：stepListHtml——每個 task 一張 <article class="step">（序號、h3、執行者 chip、整張卡 step-pick、編輯 edit-step、卡上不印任務指示、產出／來源）；選中 .sel；出口入口小 chip；舊分岔照現況一行說明（09-18 第 12 條：「查看」鈕退場、點卡就選）', () => {
  const def = { params: [{ key: 'k1', label: '期間', default: 'Q3' }], nodes: [
    { id: 'a', title: '收集', executor: 'ai', instruction: '整理 {{k1}}', output_type: '表格', next: ['b', 'c'] },
    { id: 'b', title: '寫稿', executor: 'ai', instruction: '寫', output_file: 'docx', stop_point: 'always', next: ['d'] },
    { id: 'c', title: '核對', executor: 'human', handoff: '核對表', next: ['d'] },
    { id: 'd', title: '彙整', executor: 'ai', instruction: '合', next: [] }] };
  const html = uiFn('stepListHtml', { state: { expanded: new Set(), canvasSel: 'b', editingParam: null } })(def);
  const cards = html.split('<article class="step').slice(1);
  assert.equal(cards.length, 4, '四張卡');
  const [a, b, c, d] = cards;
  const pickAttr = (id) => ` data-step="${id}" data-act="step-pick" data-node="${id}" data-id="${id}" tabindex="0" role="button">`;
  assert.ok(a.startsWith(`"${pickAttr('a')}`) && b.startsWith(` stopmarked sel"${pickAttr('b')}`) && c.startsWith(` humanmarked"${pickAttr('c')}`), '選中 .sel、停點／人做 class；整張卡可點可聚焦');
  [a, b, c, d].forEach((x, i) => {
    const id = 'abcd'[i];
    assert.ok(x.includes(`<span class="num">0${i + 1}</span>`) && x.includes(`<h3>${def.nodes[i].title}</h3>`), `序號與名稱 ${id}`);
    assert.ok(!x.includes('>查看</button>') && x.includes(`data-act="edit-step" data-node="${id}"`), `「查看」鈕退場、編輯還在 ${id}`);
  });
  // 09-18：橫向卡不印中間那行任務指示（卡片變細，指示改看右欄檢視器）；分岔卡的一行說明另計
  [a, b, c, d].forEach((x, i) => assert.ok(!x.includes('<p>'), `卡上不印任務指示 ${'abcd'[i]}：${x}`));
  assert.ok(a.includes('產出：表格<br>來源：本次資料') && a.includes('<span class="chip quiet">同時做 2 條</span>'), `a：${a}`);
  assert.ok(b.includes('產出：.docx 檔') && b.includes('來源：01 收集'), `b：${b}`);
  assert.ok(c.includes('產出：核對表') && c.includes('<span class="chip"><i class="ph ph-user"></i>你來</span>'), `c：${c}`);
  assert.ok(d.includes('來源：02 寫稿、03 核對') && d.includes('<span class="chip quiet">等全部</span>'), `d：${d}`);
  const br = { params: [], nodes: [{ id: 'a', title: '看', executor: 'ai', instruction: 'x', next: ['B'] }, { id: 'B', kind: 'branch', title: '判斷', instruction: '看金額', branches: [{ label: '大', next: 'c' }, { label: '小', next: 'd' }], next: [] }, { id: 'c', title: 'C', executor: 'ai', next: [] }, { id: 'd', title: 'D', executor: 'ai', next: [] }] };
  const bh = uiFn('stepListHtml', { state: { expanded: new Set(), canvasSel: null, editingParam: null } })(br);
  assert.ok(bh.includes('<span class="chip amber">分岔</span>') && bh.includes('↳ 大 → 「C」') && bh.includes('data-act="edit-step" data-node="B"'), '舊分岔一行說明＋編輯');
  assert.ok(bh.includes(`<article class="step stopmarked"${pickAttr('B')}`) && !bh.includes('>查看</button>'), '舊分岔卡也是整張可點');
  assert.ok(bh.includes('<span class="chip quiet">擇一 2 條</span>'), '接分岔＝擇一');
  assert.ok(/data-step="c"[\s\S]*?來源：01 看/.test(bh), '跨過分岔找上游');
});

test('L8 ⑤：listModeHtml——清單最下 <details class="panel fieldsfold" data-fields>「執行需要的資料・N 欄」（folderOpen.fields 開合、新增中強制開）：欄位名稱輸入框 param-label（data-keep，打到一半讀回）＋必填 data-req＋新增 add-param；param-label change＝PUT 定義改 label、Enter＝blur', () => {
  const list = uiFn('listModeHtml', t10Ctx({ folderOpen: { fields: true } }, t10Stubs))();
  const fold = /<details class="panel fieldsfold" data-fields open>[\s\S]*<\/details>/.exec(list)?.[0];
  assert.ok(fold, `有收合卡：${list}`);
  assert.ok(list.indexOf('data-step') < list.indexOf('data-fields') && list.indexOf('data-flowmemline') < list.indexOf('data-fields'), '在清單與每步會帶入之後');
  assert.ok(fold.includes('<summary data-act="folder-toggle" data-k="fields">') && fold.replace(/<[^>]+>/g, '').includes('執行需要的資料・1 欄'), '標題與欄數');
  assert.ok(/<input id="param-label-k1" class="notein" data-act="param-label" data-key="k1" data-keep aria-label="欄位名稱" value="欄一">/.test(fold), `欄位名稱輸入框：${fold}`);
  assert.ok(fold.includes('data-req="k1"') && fold.includes('data-act="add-param"') && fold.includes('本次資料'), '必填、新增、填值在本次資料');
  assert.ok(uiFn('listModeHtml', t10Ctx({ folderOpen: {} }, t10Stubs))().includes('<details class="panel fieldsfold" data-fields>'), '預設收著');
  assert.ok(uiFn('listModeHtml', t10Ctx({ folderOpen: {}, addingParam: true }, t10Stubs))().includes('data-fields open>'), '新增中強制開');
  assert.ok(uiFn('listModeHtml', t10Ctx({ folderOpen: { fields: true }, keep: { '-:param-label-k1': '改到一半' } }, t10Stubs))().includes('value="改到一半"'), '輪詢重繪讀回打到一半的字');
  assert.equal(count(list, '這份 Workflow 會存起來'), 0, '清單頂提示句退場');
  const src = uiSrc();
  const ch = src.slice(src.indexOf("if (e.target.dataset?.act === 'param-label' && state.wf && !subjectIsDraft())"), src.indexOf('if (e.target.dataset?.req !== undefined'));
  assert.ok(ch.length > 0 && ch.includes('p.label = label;') && ch.includes("await api('PUT', wfPath(state.wf), { def });") && ch.includes('state.wf.def = def;') && ch.includes('delete state.keep[keepKey(e.target.id)];'), `change 分支：${ch}`);
  assert.ok(src.includes("if (e.target.dataset?.act === 'param-label' && e.key === 'Enter') e.target.blur();"), 'Enter＝失焦存');
});

test('L8 ⑥：historyModeHtml——seg 執行紀錄｜Workflow 版本（history-tab、state.historyTab）；執行紀錄＝每趟一列（todo-go、全列不收）、空與讀不到各一句；版本＝原履歷列含退回；草稿照舊', () => {
  const ctx = (extra = {}) => u4bCtx({ mode: 'history', versions: [{ version: 1, diff_note: '建立', source: 'create' }, { version: 2, diff_note: '改', source: 'manual' }], historyTab: 'runs', ...extra });
  const runs = uiFn('historyModeHtml', ctx())();
  assert.ok(runs.includes('<span class="on" data-act="history-tab" data-tab="runs" tabindex="0" role="button">執行紀錄</span>') && runs.includes('data-tab="versions" tabindex="0" role="button">Workflow 版本</span>'), '兩分頁');
  assert.ok(runs.includes('<div class="panel histpanel">') && count(runs, 'class="folderrun"') === 2 && runs.includes('data-act="todo-go" data-cat="a" data-id="x" data-rid="r1"') && !runs.includes('rollback-version'), '執行紀錄');
  assert.equal(count(uiFn('historyModeHtml', ctx({ wfRuns: l8Runs }))(), 'class="folderrun"'), 4, '全列（不像右欄只列 3）');
  const empty = uiFn('historyModeHtml', ctx({ wfRuns: [] }))();
  assert.ok(empty.includes('還沒開跑過') && empty.includes('data-act="flow-tab" data-tab="data">準備執行'), '空');
  assert.ok(uiFn('historyModeHtml', ctx({ wfRuns: null }))().includes('讀不到歷次執行'), '讀不到');
  const vers = uiFn('historyModeHtml', ctx({ historyTab: 'versions' }))();
  assert.ok(vers.includes('<span class="on" data-act="history-tab" data-tab="versions"') && vers.includes('data-act="rollback-version" data-version="1"') && vers.includes('現行版') && count(vers, 'class="folderrun"') === 0, '版本');
  assert.ok(uiFn('historyModeHtml', u4bCtx({}, { subjectIsDraft: () => true }))().includes('草稿還沒有履歷'), '草稿');
  const br = l6Br('history-tab');
  assert.ok(br.includes("state.historyTab = el.dataset.tab === 'versions' ? 'versions' : 'runs';") && br.includes('render();'), `分支：${br}`);
  assert.ok(uiSrc().includes("historyTab: 'runs',") && uiSrc().includes("inspectorTab: 'step',"), 'state 初值');
});

test('L8 ⑦（題 3a）：標題旁「⋯」＝共用 rowMenuHtml（移至分類／複製／匯出／移到垃圾桶）；複製讀定義另存「（副本）」；對正在看的那條刪除清掉工作區', async () => {
  const h = l8Head();
  const more = /<button class="btn iconb more" data-act="row-menu"[^>]*>/.exec(h)?.[0] ?? '';
  assert.ok(more.includes('data-cat="旅遊" data-id="a" data-name="A"'), `⋯：${more}`);
  const m = uiFn('rowMenuHtml', { state: { rowMenu: { cat: '旅遊', id: 'a', name: 'A', x: 1, y: 2, sub: false }, categories: ['旅遊', '行銷'] } })();
  for (const a of ['row-move-open', 'row-copy', 'row-export']) assert.ok(m.includes(`data-act="${a}"`), a);
  assert.ok(m.includes('data-act="del-wf-row" data-cat="旅遊" data-id="a" data-name="A"'), '移到垃圾桶');
  const calls = [];
  await uiFn('copyWorkflow', { state: {}, api: async (mth, p, b) => { calls.push([mth, p, b]); return mth === 'GET' ? { name: 'A', nodes: [] } : {}; }, refreshLibrary: async () => {} })('旅遊', 'a');
  assert.equal(JSON.stringify(calls[1]), JSON.stringify(['POST', '/api/workflows', { category: '旅遊', def: { name: 'A（副本）', nodes: [] } }]), '複製');
  assert.ok(/if \(state\.wf && state\.wf\.category === cat && state\.wf\.id === id\) \{\s*state\.wf = null;/.test(l6Br('del-wf-row')), '刪正在看的那條');
  assert.ok(/if \(state\.wf\?\.category === cat && state\.wf\.id === id\) state\.wf\.category = to;/.test(uiSrc()), '移至分類同步正在看的那條');
});

test('L8 ⑧：接線與 CSS——render 清單／畫布（已存聊天）右欄 inspectorHtml、本次資料暫放資料夾白卡、履歷單欄；step-pick 只選取；inspector-tab 只換右欄；patchPreflightDom 補檢視器輸入來源；.flowlayout 268（≥1600 300）、article.step 13／12px 16px、.inspector sticky、標題 26/600、底線分頁', () => {
  const src = uiSrc();
  const rd = /function render\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(rd.includes("state.mode === 'chat' ? chatAsideHtml() : state.mode === 'list' || state.mode === 'canvas' ? inspectorHtml() : ''"), '右欄分派（排版輪 L9：聊天改 D-聊天右欄）');
  assert.ok(rd.includes('const aside = onDataTab ? dataAsideHtml()'), '本次資料右欄（排版輪 L11：暫放的資料夾換成這次會帶入／執行選項）');
  const pick = l6Br('step-pick');
  assert.ok(pick.includes('state.canvasSel = el.dataset.node;') && !pick.includes('drawerOpen') && pick.includes('render();'), `查看＝只選取：${pick}`);
  const it = l6Br('inspector-tab');
  assert.ok(it.includes("app.querySelector('.work .right')") && it.includes('box.outerHTML = inspectorHtml()'), `分頁只換右欄：${it}`);
  const pp = /function patchPreflightDom\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(pp.includes("document.querySelector('[data-insp-inputs]')") && pp.includes('inspInputsHtml(n, def)'), 'patchPreflightDom');
  assert.ok(src.includes('onSelect: (id) => cvSelect(id),') && fs.readFileSync(path.join(UI, 'canvas.js'), 'utf8').includes('if (!d.moved) { if (!cancel) handlers.onSelect?.(d.id); return; }'), '畫布點一下選卡（排版輪 L14：canvas.js 按下沒拖動就回報 onSelect，不靠 click 目標）');
  const css = cssSrc();
  assert.ok(css.includes('\n.flowlayout{display:grid;grid-template-columns:minmax(0,1fr) 268px;gap:21px}'), '.flowlayout');
  assert.ok(css.includes('@media (min-width:1600px){.flowlayout{grid-template-columns:minmax(0,1fr) 300px}}'), '≥1600');
  assert.ok(cssRule('article.step')?.includes('border-radius:13px;padding:12px 16px;margin-bottom:8px;font-size:14px'), `article.step：${cssRule('article.step')}`);
  assert.equal(cssRule('article.step.sel'), 'background:#f5f7ff;border-color:#7389d5;box-shadow:0 0 0 1px #445bc416;outline:0', '選中淡藍底藍邊（題 5-5）');
  assert.ok(cssRule('.step.sel')?.includes('outline:2px solid var(--accent)'), '執行頁 div.step 選中照舊');
  assert.ok(cssRule('.inspector')?.startsWith('position:sticky;top:20px;'), '.inspector sticky');
  assert.ok(cssRule('.heading h1')?.startsWith('font-size:26px;font-weight:600;letter-spacing:-.6px;color:#263853'), '.heading h1');
  assert.ok(cssRule('.flowtabs span.on') === 'color:#4057b5;border-bottom-color:#445bc4' && cssRule('.flowtabs')?.includes('border-bottom:1px solid var(--hairline)'), '底線分頁');
  assert.ok(cssRule('.crumbs')?.includes('margin-bottom:12px'), '麵包屑下距 12');
  assert.ok(cssRule('.stephead h3')?.includes('font-size:14px') && cssRule('article.step>p')?.includes('font-size:12px') && cssRule('article.step>p').includes('-webkit-line-clamp:2'), '卡內 h3 14、任務 12 兩行（p 只剩分岔卡的一行說明在用）');
  // 09-18：產出／來源字色要更清楚——#989891（對比 2.8:1）換成 --ink-500（5.0:1），字級 11→11.5
  assert.equal(cssRule('article.step .meta'), 'margin:5px 0 0 29px;font-size:11.5px;color:var(--ink-500)', '產出／來源字色加深');
  // 09-18 複驗②：右欄檢視器的長參數值要能換行，不准 nowrap 撐出 268px 容器被切掉
  const pchip = cssRule('.pchip');
  assert.ok(pchip?.includes('white-space:normal') && pchip.includes('overflow-wrap:anywhere') && pchip.includes('max-width:100%') && !pchip.includes('white-space:nowrap'), `.pchip 可換行：${pchip}`);
});

// ---------- 聊天＋建立新 Workflow＋成品卡版型（樣稿 uxChatPage／uxProductCard／uxNewFlow；驗收第 1／12 條 ----------
const l9State = (extra = {}, chat = {}) => ({ wf: { category: '旅遊', id: 'a', def: { name: 'A', nodes: [], params: [] } }, run: null, categories: ['旅遊', '未分類'], keep: {}, claude: true, mode: 'chat', flowTab: 'design', versions: [{ version: 2 }], cvDirty: false, companyName: '範例公司', ...extra, chat: { ...uiFn('emptyChat')(), ...chat } });

test('L9 ①：已存 Workflow 聊天——表單卡 .panel.chatform（caption 調整目前 Workflow、h3 告訴我想改哪裡、textarea#chat-input data-keep、send-chat「送出修改」）在上；對話紀錄一則一張 .msg 卡（角色 chip＋內容）在下；render 聊天右欄＝chatAsideHtml 兩塊 .panel', () => {
  const st = l9State({}, { messages: [{ role: 'user', text: '第 2 步加停點' }, { role: 'ai', text: '改好了。' }, { role: 'error', text: '連不上' }] });
  const h = uiFn('chatModeHtml', { state: st })();
  const form = /<div class="panel chatform">[\s\S]*?<\/div>\s*<div class="chatlog"/.exec(h)?.[0] ?? '';
  assert.ok(form && h.indexOf('class="panel chatform"') < h.indexOf('class="msg '), `表單卡在最上、訊息在下：${h}`);
  assert.ok(form.includes('<span class="caption">調整目前 Workflow</span>') && form.includes('<h3>告訴我想改哪裡</h3>'), `caption＋h3：${form}`);
  assert.ok(/<textarea id="chat-input" data-keep[^>]*><\/textarea>/.test(form), 'textarea 多行、data-keep（輪詢重繪不洗字）');
  assert.ok(/data-act="send-chat"[^>]*>送出修改<\/button>/.test(form), '送出修改');
  assert.equal(count(h, '<input id="chat-input"') + count(h, 'class="bubble') + count(h, 'class="chatin"'), 0, '單行輸入列與氣泡退場');
  const msgs = [...h.matchAll(/<div class="msg (\w+)"><span class="chip[^"]*">([^<]+)<\/span><p>([^<]*)<\/p><\/div>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(msgs, [['me', '你', '第 2 步加停點'], ['ai', '剝繭', '改好了。'], ['err', '剝繭', '連不上']], '一則一張卡、角色 chip');
  assert.equal(count(h, 'data-cat="範例"'), 0, '已存 Workflow 不印範例連結');
  const busy = uiFn('chatModeHtml', { state: l9State({}, { busy: true }) })();
  assert.ok(busy.includes('在想了，等我一下⋯') && /<textarea id="chat-input"[^>]*disabled/.test(busy) && /data-act="send-chat"[^>]*disabled/.test(busy), 'busy：在想＋停用');
  const aside = uiFn('chatAsideHtml', { state: st })();
  assert.ok(aside.startsWith('<aside class="right chatside">') && count(aside, '<div class="panel') === 2, `右欄兩塊：${aside}`);
  assert.ok(aside.indexOf('<h3>這次拆解會參考</h3>') < aside.indexOf('<h3>你保有最後決定') && aside.includes('先填好的答案都有依據。改掉不符合的地方，再按「照這樣拆」。'), '樣稿原句（說明文案輪：那句收進 h3 旁的說明鈕，字還在）');
  const rd = /function render\(\) \{[\s\S]*?\n\}\n/.exec(uiSrc())[0];
  assert.ok(rd.includes("state.mode === 'chat' ? chatAsideHtml()"), '聊天右欄（已存與草稿同一套）');
  assert.ok(cssRule('.chatform textarea')?.includes('min-height:110px'), `textarea：${cssRule('.chatform textarea')}`);
  assert.ok(cssRule('.msg')?.includes('border-radius:13px') && cssRule('.msg').includes('margin-top:13px'), `.msg：${cssRule('.msg')}`);
  assert.ok(cssRule('aside.right.chatside>.panel')?.includes('position:static'), '兩塊不疊在同一個 sticky 位置（權重蓋過 .right>.panel:not(.inspector)）');
  assert.equal(cssRule('.chatpane')?.includes('100vh') ?? false, false, '聊天區不再鎖一屏高（表單在上、紀錄往下長）');
});

test('L9 ②：建立新 Workflow——workHeadHtml 沒有 def＝麵包屑「Workflow 庫 › 建立新 Workflow」＋頁標題「把工作說清楚」＋回 Workflow 庫；chatModeHtml：建立 Workflow／你想完成什麼工作？／確認成品＋表單下方「先試一個範例」（open 範例/quarterly-report，開範例不執行，驗收第 12 條）；有草稿＝調整草稿、存進 Workflow 庫列在表單卡底', () => {
  const st = l9State({ wf: null });
  const head = uiFn('workHeadHtml', { state: st })();
  assert.ok(/^<nav class="crumbs"[^>]*><span data-act="open-library" tabindex="0" role="button">Workflow 庫<\/span><i class="ph ph-caret-right"><\/i><span aria-current="page">建立新 Workflow<\/span><\/nav>/.test(head), head);
  assert.ok(head.includes('<div class="page-head"><div><h1>把工作說清楚</h1><p>先確認成品長相，再拆成可以逐步驗收的 Workflow。</p></div>'), '頁標題');
  assert.ok(/<button class="btn" data-act="open-library">[^<]*(<i[^>]*><\/i>)?回 Workflow 庫<\/button>/.test(head), '回 Workflow 庫');
  assert.equal(count(head, 'data-act="mode-') + count(head, '開始一件事'), 0, '還沒東西可看：不印四模式、舊標題退場');
  const h = uiFn('chatModeHtml', { state: st })();
  assert.ok(h.includes('<span class="caption">建立 Workflow</span>') && h.includes('<h3>你想完成什麼工作？</h3>') && /data-act="send-chat"[^>]*>確認成品<\/button>/.test(h), '新建三個字');
  const link = /<p class="trysample">([\s\S]*?)<\/p>/.exec(h)?.[1] ?? '';
  assert.ok(link.includes('data-act="open" data-cat="範例" data-id="quarterly-report" tabindex="0" role="button">先試一個範例</span>'), `一行連結：${link}`);
  assert.ok(h.indexOf('data-act="send-chat"') < h.indexOf('class="trysample"') && h.indexOf('class="trysample"') < h.indexOf('class="chatlog"'), '表單下方、對話紀錄之上');
  assert.equal(count(h, '跑跑看範例'), 0, '舊「跑跑看範例」chip 合併成這行');
  const draft = { name: '草稿 X', nodes: [], params: [] };
  const d = uiFn('chatModeHtml', { state: l9State({ wf: null }, { draft }) })();
  assert.ok(d.includes('<span class="caption">調整草稿</span>') && d.includes('<h3>告訴我想改哪裡</h3>') && /data-act="send-chat"[^>]*>送出修改<\/button>/.test(d), '有草稿＝改草稿');
  const form = d.slice(d.indexOf('class="panel chatform"'), d.indexOf('class="chatlog"'));
  assert.ok(form.includes('data-act="save-draft"') && form.includes('data-act="clear-draft">清空</button>') && form.includes('data-act="mode-list"'), '草稿三顆留在表單卡底');
  assert.equal(count(d, 'trysample'), 0, '有草稿不印範例連結');
  assert.ok(uiFn('workHeadHtml', { state: l9State({ wf: null }, { draft }) })().includes('<h1>草稿 X</h1>'), '有草稿的標題區照 L8');
  assert.ok(cssRule('.trysample')?.includes('font-size:12px'), '.trysample');
});

test('L9 ③：Ctrl+Enter（Mac ⌘+Enter）送出、Enter 換行不送；送出後清輸入框與暫存字；placeholder 教快捷鍵', () => {
  const src = uiSrc();
  assert.ok(src.includes("if (e.target.id === 'chat-input' && e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); sendChat(); }"), 'Ctrl+Enter 送出');
  assert.equal(count(src, "e.target.id === 'chat-input' && e.key === 'Enter') sendChat();"), 0, '單按 Enter 不再送出');
  const sc = fnSrc('sendChat');
  assert.ok(sc.indexOf('if (!text) return;') < sc.indexOf("input.value = '';") && sc.includes("delete state.keep[keepKey('chat-input')];"), '有字才送、送出後清框與暫存字');
  assert.ok(/<textarea id="chat-input"[^>]*placeholder="[^"]*Ctrl\+Enter 送出/.test(uiFn('chatModeHtml', { state: l9State() })()), 'placeholder');
});

test('L9 ④：成品卡版型（樣稿 uxProductCard）——.panel.shapecard：標題列→兩欄七格→資料從哪來逐列→分類 label＋下拉→右下 重擬／照這樣拆；打字事件寫回 state、就地換依據小字（不整頁重繪）', () => {
  const h = uiFn('shapeCardHtml', { state: p4State() })();
  assert.ok(h.startsWith('<div class="panel shapecard" data-shapecard>'), h.slice(0, 80));
  const at = (s) => { const i = h.indexOf(s); assert.ok(i >= 0, `該有：${s}`); return i; };
  assert.ok(at('<div class="shapehead"><h3>成品長相</h3><span class="chip wait">待你確認</span></div>') < at('<div class="shapegrid">'), '標題列在七格上');
  assert.ok(at('<div class="shapegrid">') < at('<h3>資料從哪來</h3>') && at('<h3>資料從哪來</h3>') < at('<label class="label" for="shape-category">分類</label>'), '七格→資料從哪來→分類');
  assert.ok(at('<select id="shape-category">') < at('<div class="shapeacts">') && at('data-act="shape-redo"') < at('data-act="shape-confirm"'), '右下兩鈕');
  const inputL = /app\.addEventListener\('input', \(e\) => \{([\s\S]*?)\n\}\);/.exec(uiSrc())[1];
  const blk = /if \(t\.matches\?\.\('\[data-shape-input\]'\)\) \{([\s\S]*?)\n {2}\}/.exec(inputL)?.[1] ?? '';
  assert.ok(blk.includes('shapeInput(t.dataset.shapeInput, t.value);') && blk.includes("t.closest('label')?.querySelector('.basis')"), `打字寫回＋就地換依據：${blk}`);
  assert.equal(count(blk, 'render('), 0, '打字不整頁重繪');
  assert.ok(cssRule('.shapeacts')?.includes('justify-content:flex-end'), '.shapeacts 右下');
  assert.ok(cssRule('.shapegrid .label')?.includes('margin:17px 0 5px'), `樣稿 .label：${cssRule('.shapegrid .label')}`);
  assert.ok(cssRule('.shapehead')?.includes('justify-content:space-between'), '待你確認靠右');
});

test('L9 ⑤：右欄「這次拆解會參考」逐項（關於你 N 條／組織規範 N 份／分類規範 N 份／工人能…；讀取中／讀不到照 W2）；沒卡也抓：草稿聊天 render 補抓一次、openWorkflow 抓；vm 沒卡的草稿抓得到', async () => {
  const rows = (refs) => [...uiFn('chatAsideHtml', { state: l9State({}, { refs }) })().matchAll(/<div class="refrow">([^<]*)<\/div>/g)].map((m) => m[1]);
  assert.deepEqual(rows({ core: 2, company: 1, dept: 0, web: true, paused: false }), ['關於你 2 條', '組織規範 1 份', '分類規範 0 份', '工人能：上網查／讀參考檔／產 Word、Excel、簡報']);
  assert.deepEqual(rows(null), ['讀取中⋯']);
  assert.deepEqual(rows({ core: null, company: 1, dept: null, web: false, paused: false }), ['關於你 讀不到', '組織規範 1 份', '分類規範 讀不到', '工人能：讀參考檔／產 Word、Excel、簡報']);
  const src = uiSrc();
  const rd = /function render\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(rd.includes("if (state.mode === 'chat' && !state.wf && !state.chat.refs && refsFor !== state.chat) refreshShapeRefs();"), '草稿聊天沒數字＝補抓（抓的中途不重複打）');
  const rf = fnSrc('refreshShapeRefs');
  assert.ok(rf.includes('refsFor = c;') && rf.includes('if (refsFor === c) refsFor = null;'), '抓的中途記著');
  const chat = uiFn('emptyChat')();
  const state = { chat, wf: null, categories: ['旅遊', '未分類'] };
  let renders = 0;
  const api = async (m, p) => (p === '/api/settings' ? { exec: { web: false } } : p.startsWith('/api/shared/') ? { rules: [{}, {}] } : [{ status: 'active', layer: 'expression', scope: { level: 'all' } }]);
  await uiFn('refreshShapeRefs', { state, api, render: () => { renders++; } })();
  assert.equal(J(chat.refs), J({ core: 1, company: 2, dept: 0, web: false, paused: false }), '沒卡的草稿：組織 2 份、未分類 0 份、關於你 1 條');
  assert.equal(renders, 1, '抓完重繪一次');
});

test('L9 ⑥：Claude 連不上——送出鈕旁紅卡（驗收第 1 條：拆解也要 Claude）＋重新連線 reconnect；送出與輸入停用；連上 0 命中', () => {
  const down = uiFn('chatModeHtml', { state: l9State({ claude: false }) })();
  const card = /<div class="claudecard" data-claude-card>[\s\S]*?<\/div>/.exec(down)?.[0] ?? '';
  assert.ok(card.includes('Claude 連不上') && card.includes('data-act="reconnect"'), `紅卡：${card}`);
  const acts = /<div class="chatacts">[\s\S]*?data-act="send-chat"/.exec(down)?.[0] ?? '';
  assert.ok(acts.includes('data-claude-card'), `紅卡跟送出鈕同一列：${acts}`);
  assert.ok(/data-act="send-chat"[^>]*disabled/.test(down) && /<textarea id="chat-input"[^>]*disabled/.test(down), '停用');
  assert.equal(count(uiFn('chatModeHtml', { state: l9State() })(), 'data-claude-card'), 0, '連上不印');
  assert.ok(cssRule('.claudecard')?.includes('#fbf1ef'), `樣稿 .ux-danger 色：${cssRule('.claudecard')}`);
});

test('L9 ⑦（L6 覆核該修）：行事曆 Google 快照事件左色條＝圖例淡灰 #c9cfdb，與「AI 自動」ink-300 分得開', () => {
  assert.equal(cssRule('.cev.goog::before'), 'background:#c9cfdb', 'Google 事件色條＝圖例色');
  assert.ok(cssRule('.cev.auto::before')?.includes('var(--ink-300)'), 'AI 自動維持');
  const src = uiSrc();
  assert.ok(src.includes('<b style="background:#c9cfdb"></b>Google 快照（唯讀）') && src.includes('<b style="background:var(--ink-300)"></b>AI 自動'), '圖例兩色不同');
});

// ---------- 步驟編輯置中彈窗 ----------
const l10Def = () => ({ name: 'W', params: [], nodes: [{ id: 'n0', title: '收集', executor: 'ai', instruction: 'a', next: ['n1'] }, { id: 'n1', title: '整理', executor: 'ai', instruction: 'b', next: [] }] });
const l10State = (extra = {}) => ({ drawerOpen: true, run: null, mode: 'list', flowTab: 'design', canvasSel: 'n1', drawerTabFor: null, cvMore: null, keep: {}, ...extra });
test('L10 ①：drawerHtml——第一行條件續含設計分頁；輸出 .pvback.stepmodal（cv-close-drawer）包 .modal.stepdlg role=dialog＋h2「編輯步驟 NN」＋✕；清單與畫布都開得起來；本次資料／關著＝空；換節點清掉 cv-* 暫存字、關著時忘記節點；render 掛浮窗串尾、不在 .work 內', () => {
  const src = uiSrc();
  assert.ok(/function drawerHtml\(\) \{\n([^\n]*)/.exec(src)[1].includes("state.flowTab === 'design'"), '第一行條件');
  const def = l10Def();
  const run = (st) => uiFn('drawerHtml', { state: st, cvDef: () => def, canvasEditorHtml: (n) => `BODY:${n.id}` })();
  for (const mode of ['list', 'canvas']) {
    const html = run(l10State({ mode }));
    assert.ok(html.startsWith('<div class="pvback stepmodal" data-act="cv-close-drawer"><div class="modal stepdlg" role="dialog" aria-label="編輯步驟">'), `${mode}：${html.slice(0, 120)}`);
    assert.ok(html.includes('<h2>編輯步驟 02</h2>') && html.includes('aria-label="關閉"') && html.includes('BODY:n1') && html.indexOf('<h2>') < html.indexOf('BODY:n1'), `${mode}：標題在內容前`);
  }
  assert.equal(run(l10State({ flowTab: 'data' })), '', '本次資料分頁不開');
  const st = l10State({ drawerTabFor: 'n0', keep: { '-:cv-title': '舊的字', '-:chat-input': '聊天' } });
  run(st);
  assert.equal(J(st.keep), J({ '-:chat-input': '聊天' }), '換節點：cv-* 暫存字清掉、別的不動');
  assert.equal(st.drawerTabFor, 'n1');
  const same = l10State({ drawerTabFor: 'n1', keep: { '-:cv-title': '打到一半' } });
  run(same);
  assert.equal(same.keep['-:cv-title'], '打到一半', '同一顆重繪：暫存字留著');
  const shut = l10State({ drawerOpen: false, drawerTabFor: 'n1' });
  run(shut);
  assert.equal(shut.drawerTabFor, null, '沒畫出來＝忘記節點（下次打開不放回舊暫存字）');
  const rd = /function render\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.equal(count(rd, 'drawerHtml()'), 1, 'render 只呼叫一次');
  assert.ok(rd.includes('+ rowMenuHtml() + drawerHtml(); }') && rd.includes('<div class="work">${inner}${state.calendar'), '浮窗串尾、.work 內沒有');
});

const l10EdCtx = (extra = {}) => ({ state: { cvMore: null, presets: {}, wfFiles: [], wfMemory: null, keep: {}, ...extra }, subjectIsDraft: () => false,
  drawerInputsHtml: () => '<div id="drawer-inputs"></div>', drawerMemoryHtml: () => '<div class="dmem" data-dmem></div>', refFilesSectionHtml: () => '<div id="ref-section"></div>', templateSectionHtml: () => '<div id="tpl-section"></div>' });
test('L10 ②：AI 步驟一頁到底（樣稿順序）——輸入來源→這一步會帶→步驟名稱→你來處理＋完成後停點→任務｜驗收重點（textarea）→交付內容（檔案＋四格）→「更多設定」收合（角色／背景／限制／範例／參考檔三段／格式補充／範本／模型／創意度／監工／出錯時）→底列 刪除＋說明＋取消＋套用；欄位 id 各一；文字欄 data-keep 並讀暫存字', () => {
  const html = uiFn('canvasEditorHtml', l10EdCtx({ keep: { '-:cv-title': '打到一半' } }))({ id: 'n1', title: '整理', executor: 'ai', instruction: 'b', stop_point: 'always' }, l10Def());
  const order = ['id="drawer-inputs"', 'data-dmem', 'id="cv-title"', 'id="cv-human"', '>你來處理</label>', 'id="cv-stop"', '>完成後停點</label>', 'id="cv-instruction"', '<textarea id="cv-review"', '>交付內容</label>', 'id="cv-file"', 'id="cv-otype"', 'id="cv-ostructure"', 'id="cv-olength"', 'id="cv-otone"',
    '<details class="cvmore" id="cv-more"', '更多設定', 'id="cv-role"', 'id="cv-bg"', 'id="cv-constraints"', 'id="cv-examples"', 'id="ref-section"', 'id="cv-output-format"', 'id="tpl-section"', 'id="cv-model"', 'id="cv-creativity"', 'id="cv-sup-note"', 'id="cv-retry"', '</details>',
    'data-act="cv-delete"', '{{欄位}}', 'data-act="cv-close-drawer"', 'data-act="cv-apply"'];
  const at = order.map((s) => html.indexOf(s));
  order.forEach((s, i) => assert.ok(at[i] >= 0 && (i === 0 || at[i] > at[i - 1]), `順序：${s} @${at[i]}（前一個 ${order[i - 1]} @${at[i - 1]}）`));
  for (const id of ['cv-title', 'cv-human', 'cv-stop', 'cv-instruction', 'cv-review', 'cv-file', 'cv-otype', 'cv-ostructure', 'cv-olength', 'cv-otone', 'cv-role', 'cv-bg', 'cv-constraints', 'cv-examples', 'cv-output-format', 'cv-model', 'cv-creativity', 'cv-retry']) assert.equal(count(html, `id="${id}"`), 1, id);
  for (const id of ['cv-title', 'cv-instruction', 'cv-review', 'cv-otype', 'cv-ostructure', 'cv-olength', 'cv-otone', 'cv-role', 'cv-bg', 'cv-constraints', 'cv-examples', 'cv-output-format']) assert.ok(new RegExp(`id="${id}"[^>]*data-keep`).test(html), `${id} data-keep`);
  assert.ok(/id="cv-title"[^>]*value="打到一半"/.test(html), '輪詢重繪讀回暫存字');
  assert.ok(/id="cv-stop" checked/.test(html) && !/id="cv-human" checked/.test(html), '勾選狀態');
  assert.ok(html.includes('<div class="dialog-foot">') && !html.includes('cv-tab') && !html.includes('cvdrawer'), '底列、子頁退場');
  for (const k of ['常用片段⋯', 'data-preset-for="cv-role"', 'data-preset-for="cv-constraints"', 'data-preset-for="cv-output-format"']) assert.ok(html.includes(k), k);
});

test('L10 ③：人做步驟——「完成時要交出什麼」#cv-handoff 取代交付四格、沒有「更多設定」；你來處理已勾；分岔／並行點／舊會合點換進同一外殼（底列 dialog-foot、取消）', () => {
  const html = uiFn('canvasEditorHtml', l10EdCtx())({ id: 'h', title: '確認', executor: 'human', instruction: 'x', handoff: '名單' }, l10Def());
  assert.ok(!html.includes('<details') && !html.includes('id="cv-otype"') && !html.includes('id="cv-file"') && !html.includes('drawer-inputs'), '沒有 AI 專屬欄');
  assert.ok(/id="cv-human" checked/.test(html) && /<input id="cv-handoff"[^>]*data-keep[^>]*value="名單"/.test(html), 'handoff');
  assert.ok(html.indexOf('id="cv-review"') < html.indexOf('id="cv-handoff"') && html.indexOf('id="cv-handoff"') < html.indexOf('data-act="cv-apply"'), '交出什麼在驗收重點之後、套用之前');
  const br = uiFn('canvasEditorHtml', l10EdCtx())({ id: 'b', kind: 'branch', title: '分岔', instruction: '金額', branches: [{ label: '大', next: 'x' }, { label: '小', next: 'y' }] }, l10Def());
  assert.ok(br.includes('id="cv-title"') && br.includes('id="cv-instruction"') && count(br, 'data-branch-label=') === 2 && br.includes('cv-branch-to-par') && br.includes('<div class="dialog-foot">') && br.includes('>取消</button>'), '分岔');
  const fk = uiFn('canvasEditorHtml', l10EdCtx())({ id: 'f', kind: 'fork', title: '並行', next: [] }, l10Def());
  assert.ok(fk.includes('並行點：') && fk.includes('cv-apply') && fk.includes('<div class="dialog-foot">'), '並行點');
  const jn = uiFn('canvasEditorHtml', l10EdCtx())({ id: 'j', kind: 'join', title: '會合', next: [] }, l10Def());
  assert.ok(jn.includes('cv-dissolve') && jn.includes('<div class="dialog-foot">'), '舊會合點');
});

const l10Apply = (vals, node, extra = {}) => {
  const src = uiSrc();
  const branch = src.slice(src.indexOf("else if (act === 'cv-apply')"), src.indexOf("else if (act === 'cv-delete')"));
  const def = { nodes: [node] };
  const el = (id) => (id in vals ? (typeof vals[id] === 'boolean' ? { checked: vals[id] } : { value: vals[id] }) : null);
  const state = { canvasSel: node.id, drawerOpen: true, drawerTabFor: node.id, cvMore: true, run: null, keep: { '-:cv-title': '打到一半', '-:chat-input': '聊天' }, ...extra };
  let renders = 0;
  const { context } = uiCtx({ state, document: { getElementById: el, querySelectorAll: () => [] }, app: { querySelectorAll: () => [] }, canvasOp: async (fn) => { fn(def); renders++; }, render: () => { renders++; } });
  return vm.runInContext(`(async (act) => { if (0) {} ${branch} })`, context)('cv-apply').then(() => ({ n: def.nodes[0], state, renders }));
};
test('L10 ④：cv-apply（vm 塞假 DOM 值跑一次）——讀 #cv-human 寫 executor、其餘欄位名照舊寫回；套用後關窗、清 cv-* 暫存字；換了「你來處理」留著窗（換出對應欄位）；cv-tab 分支 0 命中', async () => {
  const vals = { 'cv-title': ' 新名 ', 'cv-instruction': '做事', 'cv-human': false, 'cv-stop': true, 'cv-review': '看數字', 'cv-otype': '表格', 'cv-ostructure': '', 'cv-olength': '一頁', 'cv-otone': '', 'cv-role': '主管', 'cv-bg': '', 'cv-constraints': '', 'cv-examples': '',
    'cv-output-format': '', 'cv-file': 'md', 'cv-model': '', 'cv-creativity': 'strict', 'cv-template': '', 'cv-retry': '1', 'cv-sup-note': true, 'cv-sup-tier': false, 'cv-sup-tools': false };
  const a = await l10Apply(vals, { id: 'n1', title: '舊', executor: 'ai', instruction: '舊', background: '舊背景', output_structure: '舊', next: [] });
  assert.equal(J(a.n), J({ id: 'n1', title: '新名', executor: 'ai', instruction: '做事', next: [], stop_point: 'always', role_context: '主管', review_focus: '看數字', output_type: '表格', output_length: '一頁', creativity: 'strict', output_file: 'md', retry: 1 }), J(a.n));
  assert.equal(a.state.drawerOpen, false, '套用後關窗');
  assert.equal(J(a.state.keep), J({ '-:chat-input': '聊天' }), '清 cv-* 暫存字');
  const b = await l10Apply({ 'cv-title': '確認', 'cv-instruction': '看', 'cv-human': true, 'cv-stop': false, 'cv-review': '' }, { id: 'n2', title: '確認', executor: 'ai', instruction: '看', next: [] });
  assert.equal(b.n.executor, 'human', '勾你來處理＝human');
  assert.equal(b.state.drawerOpen, true, '換了執行者：窗留著，重繪換出「完成時要交出什麼」');
  const h = await l10Apply({ 'cv-title': '確認', 'cv-instruction': '看', 'cv-human': true, 'cv-stop': false, 'cv-review': '', 'cv-handoff': '名單' }, { id: 'n3', title: '確認', executor: 'human', instruction: '看', next: [] });
  assert.ok(h.n.handoff === '名單' && h.state.drawerOpen === false, '人做 handoff 寫回、關窗');
  assert.equal(count(uiSrc(), "act === 'cv-tab'"), 0, 'cv-tab 分支退場');
  assert.equal(count(uiSrc(), 'cv-executor'), 0, 'cv-executor 退場');
});

test('L10 ⑤：CSS——.stepdlg 樣稿 dialog 尺寸（700／90vh／18／27、fixed 置中）、.stepmodal 背景霧化；.cvdrawer.full 與子頁樣式退場、行事曆 .cvdrawer 基底留著；樣稿 .label／.formline／.dialog-foot', () => {
  assert.ok(cssRule('.stepdlg')?.startsWith('width:min(700px,calc(100% - 40px));max-height:90vh;overflow:auto;border-radius:18px;padding:27px'), `.stepdlg：${cssRule('.stepdlg')}`);
  assert.ok(cssRule('.stepdlg').includes('position:fixed;inset:0;margin:auto;height:fit-content'), '置中（同樣稿 <dialog> 的 fixed＋inset 0＋margin auto）');
  assert.ok(cssRule('.stepmodal')?.startsWith('backdrop-filter:blur(3px)'), `.stepmodal：${cssRule('.stepmodal')}`);
  const css = cssSrc();
  for (const gone of ['.cvdrawer.full', '.segtabs', '.cvpage.off', '.cvdtop{', '.cvdbody{', '.cvdfoot{']) assert.equal(count(css, gone), 0, `${gone} 退場`);
  assert.ok(cssRule('.cvdrawer')?.startsWith('position:absolute'), '行事曆單次抽屜基底留著（地雷 11）');
  assert.ok(cssRule('.stepdlg .label')?.includes('font-size:11px') && cssRule('.stepdlg .label').includes('margin:17px 0 5px'), '樣稿 .label');
  assert.ok(cssRule('.stepdlg .formline')?.includes('gap:24px') && cssRule('.dialog-foot')?.includes('justify-content:flex-end'), '.formline／.dialog-foot');
  assert.ok(cssRule('.stepdlg h2')?.includes('font-size:20px'), '.stepdlg h2 20px');
});

test('L10 ⑥：關窗——背景只認按下與放開都在遮罩本身（框內點、框內選字拖到外面都不關）；✕／取消／Esc＝關、未套用的改動丟掉（同原抽屜「關閉」）；常用片段帶入觸發 input 存暫存字；彈窗開著畫布快捷鍵不動', async () => {
  const src = uiSrc();
  const branch = src.slice(src.indexOf("else if (act === 'cv-close-drawer')"), src.indexOf("else if (act === 'preset-save')"));
  const back = { classList: { contains: (c) => c === 'pvback' } };
  const btn = { classList: { contains: () => false } };
  const inner = {};
  const close = (el, target, down) => {
    const state = { drawerOpen: true, drawerTabFor: 'n1', cvMore: true, run: null, keep: { '-:cv-bg': '沒套用的字' } };
    const { context } = uiCtx({ state, render: () => {}, backDown: down });
    vm.runInContext(`((act, el, e) => { if (0) {} ${branch} })`, context)('cv-close-drawer', el, { target });
    return state;
  };
  assert.equal(close(back, inner, inner).drawerOpen, true, '框內點（冒泡到遮罩）不關');
  assert.equal(close(back, back, inner).drawerOpen, true, '框內按下、遮罩放開（選字拖出去）不關');
  const s = close(back, back, back);
  assert.ok(s.drawerOpen === false && s.drawerTabFor === null && s.cvMore === null && !('-:cv-bg' in s.keep), '背景點一下＝關、丟掉未套用');
  assert.equal(close(btn, btn, btn).drawerOpen, false, '✕／取消＝關');
  assert.ok(src.includes("app.addEventListener('pointerdown', (e) => { backDown = e.target; }, true);"), '記住按下點');
  assert.ok(/if \(e\.key === 'Escape' && !e\.isComposing && state\.drawerOpen && document\.querySelector\('\.stepmodal'\)\) \{ if \(state\.stepAsk\) hideStepAsk\(\); else if \(stepModalDirty\(\)\) showStepAsk\(\); else \{ closeStepModal\(\); render\(\); \} return; \}/.test(src), 'Esc 關（輸入法組字中不關；排版輪 L12：有未套用改動先問）');
  assert.ok(src.includes("target.dispatchEvent(new Event('input', { bubbles: true }))"), '常用片段帶入走 input（存進暫存字）');
  assert.ok(src.includes("if (document.querySelector('.stepmodal')) return; // 彈窗開著"), '彈窗開著畫布快捷鍵不動');
  assert.ok(uiFn('textFieldHtml', { state: { presets: {}, keep: {} } })('cv-x', '任務', 'v', 'p', null).startsWith('<label class="label" for="cv-x">任務</label>'), '欄名 label for');
});

// ----------  本次資料（樣稿 uxDataPage／uxHealth）：必填標示、常駐開跑健檢、本次上傳 A）、本次補充f）、Claude 連不上 ----------
const l11Def = { ...t10Def, params: [
  { key: 'r1', label: '必一', default: '', required: true },
  { key: 'src', label: '原始資料', default: '', input: 'file', required: true },
  { key: 'o1', label: '選一', default: '', hint: 'h' },
] };
const l11Ctx = (extra = {}, helpers = {}) => u4bCtx({ runUploads: {}, runNote: '', health: null, ...extra }, { ...t10Stubs, subjectDef: () => l11Def, healthCardHtml: () => '<div class="healthcard" data-healthcard></div>', ...helpers });
test('L11 ①（調整輪改寫）：dataTabHtml 在 .dataform——四張任務卡→展開的「填寫這次的值」（身分→必填 chip→上傳框→選填 details→本次補充）→常駐健檢卡；上傳欄位不印成文字框；草稿空', () => {
  // 核可的任務卡版（原型 PROTO/設定與本次資料-任務卡-demo.html）。主欄不再是一張白卡開跑表單，
  // 改成四張 .prep-card ＋內嵌 .focus-editor；「只用於本次／回設計／開始」搬到右欄摘要卡（見 L11 ④）。
  const h = uiFn('dataTabHtml', l11Ctx())();
  const order = ['<section class="dataform">', 'data-prep="resume"', 'data-prep="data"', 'data-prep="auto"', 'data-prep="execution"',
    '<section class="focus-editor" data-focus="data">', '<h3>填寫這次的值<button type="button" class="hint"', 'id="mem-identity"', 'data-param="r1"', 'data-upload-box="src"',
    '<details class="formdetails"', 'data-param="o1"', 'id="run-note"', 'data-healthcard', '</section>'];
  order.reduce((prev, s) => { const i = h.indexOf(s, prev + 1); assert.ok(i > prev, `順序：${s}（${i} vs ${prev}）`); return i; }, -1);
  assert.equal(count(h, '<span class="chip wait req"'), 2, '必一＋原始資料兩個「必填」黃 chip');
  assert.equal(count(h, 'data-param="src"'), 0, '上傳欄位不是文字框');
  assert.equal(count(h, 'class="prep-card'), 4, '四張任務卡');
  assert.ok(h.includes('還差 2 項必填資料。') && h.includes('沒有跑到一半的；這次是全新一趟。'), '卡上一句狀態');
  assert.equal(count(h, '<h5>'), 0, '舊 h5 標題退場');
  assert.equal(uiFn('dataTabHtml', l11Ctx({}, { subjectIsDraft: () => true }))(), '', '草稿沒有本次資料');
  // 展開別張：會帶入／執行選項的內容進主欄，三個開關仍然可改（驗收第 3 條：原型畫成唯讀，照抄就是把能力做丟）
  const auto = uiFn('dataTabHtml', l11Ctx({ dataCard: 'auto' }))();
  assert.ok(auto.includes('<h3>查看這次會帶入<button type="button" class="hint"') && auto.includes('組織規範 1 份') && !auto.includes('id="mem-identity"'), auto.slice(0, 200));
  const exec = uiFn('dataTabHtml', l11Ctx({ dataCard: 'execution' }))();
  for (const s of ['id="perm-files"', 'id="check-delivery"', 'id="supervisor-row"', 'data-act="perm-files-toggle"', 'data-act="check-toggle"', 'data-act="facts-toggle"', 'data-act="supervisor-toggle"']) assert.ok(exec.includes(s), `三開關可編輯：${s}`);
  assert.equal(uiFn('dataTabHtml', l11Ctx({ dataCard: null }))().indexOf('focus-editor'), -1, 'null＝全收起');
});

test('L11 ②：常駐開跑健檢——healthCardHtml 檢查中／讀不到／block 紅＋修這裡／只有提醒琥珀／全過「資料已備齊・N 個步驟已準備」；重新檢查走 preflightNow 帶這次的值；輸入 600ms 後只補畫健檢卡不整頁重繪', async () => {
  const hc = (health) => uiFn('healthCardHtml', l11Ctx({ health }, { healthCardHtml: undefined, healthFor: () => health }))();
  const base = (s) => { for (const w of ['data-healthcard', '<h3>開跑健檢</h3>', 'data-act="pf-recheck"', '重新檢查']) assert.ok(s.includes(w), `${w}：${s}`); return s; };
  assert.ok(base(hc(null)).includes('檢查中⋯'));
  assert.ok(base(hc({ err: '壞了' })).includes('健檢暫時讀不到'));
  const block = base(hc({ result: { issues: [{ level: 'block', title: '「必一」還沒填', detail: 'd', fix: { kind: 'param', id: 'r1' } }, { level: 'warn', title: '提醒', detail: '' }] } }));
  assert.ok(block.includes('class="healthcard block"') && count(block, 'class="pfrow block"') === 1 && count(block, 'class="pfrow warn"') === 1 && block.includes('data-act="pf-fix" data-kind="param" data-id="r1"') && block.includes('有 1 處要先修'), block);
  const warn = base(hc({ result: { issues: [{ level: 'warn', title: '提醒', detail: '' }] } }));
  assert.ok(warn.includes('class="healthcard warn"') && warn.includes('1 則提醒，不擋跑') && !warn.includes('pfrow block'), warn);
  const pass = base(hc({ result: { issues: [] } }));
  assert.ok(pass.includes('class="healthcard ok"') && pass.includes('資料已備齊・1 個步驟已準備'), pass);
  // 這次的值：文字欄位＝輸入中或預設；上傳欄位＝上傳好的檔名，沒上傳（或還在傳、傳失敗）＝空
  const hv = (runUploads) => uiFn('healthValues', l11Ctx({ paramNow: { r1: '填了' }, runUploads }))(l11Def);
  assert.equal(JSON.stringify(hv({})), JSON.stringify({ r1: '填了', src: '', o1: '' }));
  assert.equal(hv({ src: { token: 't', name: '三月.csv', size: 3 } }).src, '三月.csv');
  assert.equal(hv({ src: { busy: true, name: '三月.csv' } }).src, '');
  // recheckHealth：preflightNow(def, 值)→存 state.health→只 patchHealthCard；回來時值已經又變了＝丟掉這份
  const calls = { pf: [], patch: 0, render: 0 };
  const st = l11Ctx({ paramNow: { r1: 'a' }, wf: { category: 'a', id: 'x', def: l11Def, runs: [] } }).state;
  const ctx = { ...l11Ctx(), state: st, preflightNow: async (d, v) => { calls.pf.push(v); return { issues: [] }; }, patchHealthCard: () => { calls.patch++; }, render: () => { calls.render++; } };
  delete ctx.healthCardHtml;
  await uiFn('recheckHealth', ctx)();
  assert.equal(JSON.stringify(calls.pf[0]), JSON.stringify({ r1: 'a', src: '', o1: '' }), '帶這次的值');
  assert.ok(st.health.result && st.health.key && calls.patch === 1 && calls.render === 0, `只補畫健檢卡：${JSON.stringify(calls)}`);
  const stale = { ...ctx, preflightNow: async () => { st.paramNow.r1 = 'b'; return { issues: [{ level: 'block', title: 'x' }] }; } };
  await uiFn('recheckHealth', stale)();
  assert.equal(st.health.result.issues.length, 0, '值已變的舊結果丟掉');
  const src = uiSrc();
  assert.ok(l6Br('pf-recheck').includes('recheckHealth()'), 'pf-recheck');
  const rh = /async function recheckHealth\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(rh.includes('preflightNow(def, values)') && rh.includes('patchHealthCard()') && !rh.includes('render()'), rh);
  const sh = /function scheduleHealth\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(sh.includes('setTimeout(recheckHealth, 600)') && !sh.includes('render()'), sh);
  const ph = /function patchHealthCard\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(ph.includes("document.querySelector('[data-healthcard]')") && ph.includes('outerHTML = healthCardHtml()'), ph);
  const inp = src.slice(src.indexOf("app.addEventListener('input'"), src.indexOf("t.id === 'cal-pick-year'"));
  assert.ok(/if \(t\.dataset\?\.param !== undefined\) \{[^}]*scheduleHealth\(\);/.test(inp), '欄位輸入排健檢');
  assert.ok(/function healthFor\(def\) \{[\s\S]*?recheckHealth\(\)/.test(src), '打開分頁（render 途中）沒結果就背景跑一次');
});

test('L11 ③（調整輪改寫）：Claude 連不上——紅卡在右欄「開始」上方、重新連線；連得上沒有卡；頂端整頁 hostAlert 退場', () => {
  // 「開始」搬到右欄摘要卡，這張紅卡跟著搬（驗收第 1 條：要在「開始」附近）
  const down = uiFn('dataAsideHtml', l11Ctx({ claude: false }))();
  const card = down.indexOf('class="claudecard runclaude"');
  assert.ok(card > down.indexOf('class="meter') && card < down.indexOf('data-act="start"'), '在進度條之後、開始之前');
  assert.ok(down.slice(card, down.indexOf('data-act="start"')).includes('Claude 連不上，現在按開始會失敗') && down.includes('data-act="reconnect"'), down.slice(card, card + 300));
  assert.ok(/data-act="start" disabled/.test(down), '開始停用');
  assert.equal(count(uiFn('dataAsideHtml', l11Ctx({ claude: true }))(), 'claudecard'), 0);
  assert.equal(count(uiFn('dataTabHtml', l11Ctx({ claude: false }))(), 'claudecard'), 0, '主欄不再印這張');
  const src = uiSrc();
  assert.equal(count(src, 'hostAlert'), 0, 'hostAlert 退場（render 串與函式）');
});

test('L11 ④（調整輪改寫）：右欄＝一張「開始這次執行」摘要卡（必填 x/y、開跑健檢、交貨查核、進度條、開始）；「這次會帶入／執行選項」改由主欄任務卡展開；讀取中／讀不到；render 本次資料分頁接 dataAsideHtml', () => {
  // 原型把右欄兩塊靜態面板收進主欄任務卡，右欄換成 .sticky-start 摘要卡
  const a = uiFn('dataAsideHtml', l11Ctx())();
  assert.ok(a.startsWith('<aside class="right dataside"><section class="panel sticky-start" data-startcard>') && count(a, '<section class="panel') === 1, a.slice(0, 120));
  for (const w of ['<h3>開始這次執行</h3>', '<span>必填資料</span><strong>0 / 2</strong>', '<span>開跑健檢</span>', '<span>交貨查核</span><strong>開啟</strong>', 'class="meter partial"', 'data-act="start"', 'data-act="pf-recheck"', 'data-act="flow-tab" data-tab="design"', '只用於本次']) assert.ok(a.includes(w), w);
  const full = uiFn('dataAsideHtml', l11Ctx({ paramNow: { r1: '填了' }, runUploads: { src: { token: 't', name: 'a.csv', size: 1 } }, health: { result: { issues: [] } } }))();
  assert.ok(full.includes('<strong>2 / 2</strong>') && full.includes('<strong>通過</strong>') && full.includes('class="meter"'), full);
  assert.ok(uiFn('dataAsideHtml', l11Ctx({ health: { result: { issues: [{ level: 'block' }, { level: 'warn' }] } } }))().includes('<strong>1 處要修</strong>'), '有擋跑的印處數');
  assert.ok(uiFn('dataAsideHtml', l11Ctx({ health: { err: 'x' } }))().includes('<strong>讀不到</strong>'));
  // 兩塊靜態面板的真數字改在主欄任務卡「查看這次會帶入」／「確認執行選項」
  const d = uiFn('dataTabHtml', l11Ctx({ dataCard: 'auto' }))();
  for (const w of ['<h3>查看這次會帶入<button type="button" class="hint"', '組織規範 1 份', '分類規範 0 份', 'Workflow 參考檔 4 份', '開始時會鎖定這次的值與 Workflow 版本，跑到一半改設計不影響這一趟。']) assert.ok(d.includes(w), w);
  assert.ok(uiFn('dataTabHtml', l11Ctx())().includes('產出檔案 關閉・交貨查核 開啟・監工 開啟'), '執行選項卡上一句現況');
  const on = uiFn('dataTabHtml', l11Ctx({}, { subjectDef: () => ({ ...l11Def, permissions: { files: true }, check: { enabled: false }, supervisor: { enabled: false } }) }))();
  assert.ok(on.includes('產出檔案 開啟・交貨查核 關閉・監工 關閉'), on.slice(on.indexOf('產出檔案') - 40, on.indexOf('產出檔案') + 60));
  assert.ok(uiFn('dataTabHtml', l11Ctx({ dataCard: 'auto', shared: { company: null, dept: null, err: null } }))().includes('組織規範 讀取中⋯'));
  assert.ok(uiFn('dataTabHtml', l11Ctx({ dataCard: 'auto', shared: { company: null, dept: null, err: 'x' } }))().includes('分類規範 讀不到'));
  const rd = /function render\(\) \{[\s\S]*?\n\}\n/.exec(uiSrc())[0];
  assert.ok(rd.includes('const aside = onDataTab ? dataAsideHtml()'), '本次資料分頁右欄');
  assert.ok(cssRule('aside.right.dataside>.panel')?.includes('position:sticky'), '一張卡跟著捲（原型 .sticky-start）');
  assert.ok(cssRule('.prep-card')?.includes('grid-template-columns:32px minmax(0,1fr) auto') && cssRule('.meter')?.includes('height:5px') && cssRule('.focus-editor')?.includes('background:#fafbff'), '骨架照原型');
});

test('L11 ⑤：本次上傳——上傳框四態；選檔→POST run-uploads→state.runUploads；移除清掉；開始 body 帶 uploads 與 note（沒有就不帶）；清單「執行需要的資料」可設「每次上傳檔案」', async () => {
  const box = (u) => uiFn('uploadBoxHtml', l11Ctx({ runUploads: u ? { src: u } : {} }))(l11Def.params[1]);
  const empty = box(null);
  assert.ok(empty.includes('<label class="label">原始資料 <span class="chip wait req"') && empty.includes('class="upload" data-upload-box="src"') && empty.includes('尚未選擇檔案') && empty.includes('data-act="run-upload" data-key="src"') && empty.includes('>選檔</button>'), empty);
  const done = box({ token: 't', name: '三月.csv', size: 3000 });
  assert.ok(done.includes('<strong>三月.csv</strong>') && done.includes('3 KB') && done.includes('data-act="run-upload-del" data-key="src"') && done.includes('>移除</button>') && done.includes('只給這一趟用'), done);
  assert.ok(box({ busy: true, name: '三月.csv' }).includes('上傳中⋯'));
  const bad = box({ err: '檔案太大（上限 10MB）' });
  assert.ok(bad.includes('class="note bad"') && bad.includes('檔案太大') && bad.includes('>選檔</button>'), bad);
  assert.ok(!uiFn('uploadBoxHtml', l11Ctx())({ key: 'x', label: '附件', default: '', input: 'file' }).includes('chip wait req'), '選填沒有必填 chip');
  // 選檔上傳（vm）
  const st = { runUploads: {}, wf: { category: '旅遊', id: 'a', def: l11Def } };
  const posts = [];
  let renders = 0;
  const up = uiFn('uploadRunFile', { state: st, wfPath: (w) => `/api/workflows/${w.category}/${w.id}`, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), render: () => { renders++; }, recheckHealth: async () => {}, api: async (m, p, b) => { posts.push([m, p, b]); return { token: 'tok', name: b.name, size: 3 }; } });
  await up('src', { name: 'a.csv', size: 3, arrayBuffer: async () => new TextEncoder().encode('a,b').buffer });
  assert.equal(JSON.stringify(posts[0]), JSON.stringify(['POST', '/api/workflows/旅遊/a/run-uploads', { name: 'a.csv', content_b64: 'YSxi' }]));
  assert.equal(JSON.stringify(st.runUploads.src), JSON.stringify({ token: 'tok', name: 'a.csv', size: 3 }));
  assert.ok(renders >= 2, '上傳中與上傳好各畫一次');
  const fail = uiFn('uploadRunFile', { state: st, wfPath: () => '/x', btoa: () => '', render: () => {}, recheckHealth: async () => {}, api: async () => { throw new Error('這裡只收 csv'); } });
  await fail('src', { name: 'a.exe', size: 1, arrayBuffer: async () => new ArrayBuffer(1) });
  assert.equal(st.runUploads.src.err, '這裡只收 csv');
  assert.ok(l6Br('run-upload-del').includes('delete state.runUploads[el.dataset.key]') && l6Br('run-upload-del').includes('recheckHealth()'), '移除');
  assert.ok(l6Br('run-upload').includes('uploadRunFile(key, input.files[0])'), '選檔');
  // 開始帶的欄位
  const extras = (runUploads, runNote) => uiFn('runStartExtras', { state: { runUploads, runNote } })();
  assert.equal(JSON.stringify(extras({}, '')), '{}', '沒有上傳與補充＝body 跟現況一樣');
  assert.equal(JSON.stringify(extras({ src: { token: 't', name: 'a' }, x: { busy: true }, y: { err: 'e' } }, '  留意新品 ')), JSON.stringify({ uploads: { src: 't' }, note: '留意新品' }));
  const start = /act === 'start' \|\| act === 'start-force'\) \{[\s\S]*?\n    \}/.exec(uiSrc())[0];
  assert.ok(start.includes('{ overrides, ...memStartFields(overrides), ...runStartExtras() }') && start.includes('preflightNow(state.wf.def, { ...healthValues(state.wf.def), ...overrides })'), start.slice(0, 400));
  assert.ok(start.indexOf('state.runUploads = {};') > start.indexOf('state.run = run;') && start.includes("state.runNote = '';"), '開跑成功才清（token 已用掉）');
  for (const k of ['runUploads', 'runNote']) assert.ok(/const WS_KEYS = \[[^\]]*'runUploads', 'runNote'/.test(uiSrc()), `WS_KEYS ${k}`);
  // 清單「執行需要的資料」：每次上傳檔案勾選即 PUT
  const list = uiFn('listModeHtml', l11Ctx({}, { subjectDef: () => l11Def }))();
  assert.ok(/<label class="reqtoggle"><input type="checkbox" data-upload="src" checked>每次上傳檔案<\/label>/.test(list) && /data-upload="r1" >每次上傳檔案/.test(list), list.slice(list.indexOf('fieldrow'), list.indexOf('fieldrow') + 600));
  const chg = uiSrc().slice(uiSrc().indexOf('if (e.target.dataset?.upload !== undefined'), uiSrc().indexOf('if (e.target.dataset?.presetFor'));
  assert.ok(chg.includes("p.input = 'file'") && chg.includes('delete p.input') && chg.includes("api('PUT', wfPath(state.wf), { def })"), chg);
  assert.ok(/el\.dataset\.kind === 'node'\) \{[^}]*state\.flowTab = 'design';/.test(uiSrc()), '修這裡（步驟）從本次資料切回設計才看得到彈窗');
  assert.ok(uiSrc().includes('[data-upload-box="${CSS.escape(el.dataset.id)}"] button'), '修這裡（上傳欄位）捲到上傳框');
});

test('L11 ⑥⑦：本次補充 #run-note data-keep、值讀 state.runNote、2,000 字上限、打字寫回；startCheckHtml 原文一字不動', () => {
  const h = uiFn('dataTabHtml', l11Ctx({ runNote: '留意<新品>' }))();
  assert.ok(h.includes('<label class="label" for="run-note">本次補充<button type="button" class="hint"') && h.includes('<textarea id="run-note" class="runnote" data-keep maxlength="2000" placeholder="'), h.slice(h.indexOf('run-note') - 60, h.indexOf('run-note') + 200));
  assert.ok(h.includes('>留意<新品></textarea>') && h.includes('每個 AI 步驟都看得到'), '值讀 state.runNote（測試 esc 為原樣）＋說明');
  const inp = uiSrc().slice(uiSrc().indexOf("app.addEventListener('input'"), uiSrc().indexOf("t.id === 'cal-pick-year'"));
  assert.ok(inp.includes("if (t.id === 'run-note') state.runNote = t.value;"), '打字寫回');
  const fnText = (src) => /function startCheckHtml\(\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  const before = execSync('git show 5586683:bojian/ui/app.js', { cwd: UI, encoding: 'utf8' });
  assert.equal(fnText(uiSrc()), fnText(before), 'startCheckHtml 與 L10 收工版逐字相同');
  assert.ok(uiFn('dataTabHtml', l11Ctx({}, { startCheckHtml: () => '<div data-startcheck></div>' }))().includes('data-startcheck'), '按開始後的確認卡照舊掛在本次資料');
});

// ---------- 本次附件（原型 .upload-box「本次附件」）＝檔案版的本次補充，接在本次補充下方 ----------
test('大跑輪 UI ①：本次附件框在「本次補充」下方、沿用既有 uploadBoxHtml（不新造元件）、保留鍵 __run__、沒有必填 chip；選檔／移除走既有 run-upload 分支；開始時 body 帶 uploads.__run__', () => {
  const h = uiFn('dataTabHtml', l11Ctx({ runNote: '留意新品' }))();
  // 那句從 textarea 下方收進「本次補充」label 旁的說明鈕，所以排到 run-note 前面
  ['這一趟每個 AI 步驟都看得到這段話。', 'id="run-note"', '<label class="label">本次附件</label>', 'data-upload-box="__run__"', 'data-healthcard']
    .reduce((prev, s) => { const i = h.indexOf(s, prev + 1); assert.ok(i > prev, `順序：${s}（${i} vs ${prev}）`); return i; }, -1);
  // 同一顆元件：本次附件框的 html＝uploadBoxHtml 出來的那串，一字不差
  const box = uiFn('uploadBoxHtml', l11Ctx())({ key: '__run__', label: '本次附件' }, '這一趟每個 AI 步驟都看得到這個檔；只給這一趟用，下次不留。');
  assert.ok(h.includes(box), `本次附件框＝uploadBoxHtml 的輸出：${box}`);
  assert.ok(box.includes('class="upload" data-upload-box="__run__"') && box.includes('data-act="run-upload" data-key="__run__"') && box.includes('>選檔</button>'), box);
  assert.ok(!box.includes('chip wait req'), '本次附件永遠選填（沒上傳照樣開跑）');
  assert.equal(count(h, '<span class="chip wait req"'), 2, '必填 chip 還是那兩個欄位（附件不算必填項）');
  // 上傳好／上傳中／失敗三態也共用同一顆元件
  const done = uiFn('uploadBoxHtml', l11Ctx({ runUploads: { __run__: { token: 't', name: '這趟附件.md', size: 2048 } } }))({ key: '__run__', label: '本次附件' });
  assert.ok(done.includes('<strong>這趟附件.md</strong>') && done.includes('2 KB') && done.includes('data-act="run-upload-del" data-key="__run__"'), done);
  // 事件分支沒有為附件另開一條：既有 run-upload／run-upload-del 都只認 el.dataset.key
  assert.ok(l6Br('run-upload').includes('const key = el.dataset.key;') && l6Br('run-upload-del').includes('delete state.runUploads[el.dataset.key]'), '沿用既有分支，不另開附件專用分支');
  assert.equal(count(uiSrc(), "data-act=\"run-upload\""), 1, '只有一處印選檔鈕（同一顆元件）');
  // 開始時：附件跟逐欄上傳一起走 uploads，保留鍵原樣送出；沒選附件＝不帶（body 與現況逐字相同）
  const extras = (runUploads, runNote) => uiFn('runStartExtras', { state: { runUploads, runNote } })();
  assert.equal(JSON.stringify(extras({ __run__: { token: 'ta' }, src: { token: 'ts' } }, '')), JSON.stringify({ uploads: { __run__: 'ta', src: 'ts' } }));
  assert.equal(JSON.stringify(extras({ __run__: { busy: true, name: 'x.md' } }, '')), '{}', '還在傳的不送');
  assert.equal(JSON.stringify(extras({}, '')), '{}', '沒附件沒補充＝body 跟現況一樣');
  // 保留鍵不會混進「這次的值」：healthValues 與必填進度只看 def.params
  const vals = uiFn('healthValues', l11Ctx({ runUploads: { __run__: { token: 't', name: 'a.md' }, src: { token: 's', name: 'b.csv' } }, paramNow: {} }))(l11Def);
  assert.ok(!('__run__' in vals), '附件不是欄位，不進健檢的值');
  assert.equal(vals.src, 'b.csv', '逐欄上傳的值照舊');
  assert.equal(JSON.stringify(uiFn('requiredNow', l11Ctx({ runUploads: { __run__: { token: 't', name: 'a.md' } } }))(l11Def)), JSON.stringify({ total: 2, done: 0 }), '附件不算必填進度');
  assert.ok(uiSrc().includes("const RUN_ATTACH_KEY = '__run__';"), '前端保留鍵與伺服器 RUN_ATTACH_KEY 同字');
});

// ----------  執行頁（樣稿 uxRunPage／uxRunOutput／uxRunComplete）：三欄白卡、中欄只放一步、看原文貼成品、監工與回饋擺放 ----------
const L12_MD = { ...MD_STUB, mdToggleHtml: (k) => `<span class="pbtn mdtoggle" data-act="md-toggle" data-key="${k}">看原文</span>` };
const l12Html = (extra = {}, stubs = {}) => u6Html(extra, { ...L12_MD, ...stubs });
const l12Stop = (st, i, step) => uiFn('stopCardHtml', { ...CARD_STUBS, ...L12_MD, state: st })(st.run.def.nodes[i], step);

test('L12 ①：三欄各為白卡——左 aside.panel.progressrail h3「這次的進度」、中 section.runmain 內 .panel.runstep-now、右 aside.sideinfo 內 .panel h3「目前這步」；CSS .runlayout 190／1fr／240＋gap 18、右欄卡底 #f9faff、左右欄 sticky 不再帶 12.5px 字級與分隔線', () => {
  const h = l12Html();
  const { a, b, c, rail, main, side } = u6Cols(h);
  assert.ok(a > 0 && b > a && c > b, `三欄依序：${a}/${b}/${c}`);
  assert.ok(rail.startsWith('<aside class="panel progressrail"><h3>這次的進度</h3>'), rail.slice(0, 80));
  assert.ok(main.startsWith('<section class="runmain"><div class="panel runstep-now">'), main.slice(0, 80));
  assert.ok(side.startsWith('<aside class="sideinfo"><div class="panel"><h3>目前這步</h3>'), side.slice(0, 80));
  assert.equal(count(h, '<h5>'), 0, 'h5 小標退場');
  assert.ok(cssRule('.runlayout')?.startsWith('display:grid;grid-template-columns:190px minmax(0,1fr) 240px;gap:18px;align-items:start'), cssRule('.runlayout'));
  const sticky = cssRule('.progressrail,.sideinfo');
  assert.ok(sticky?.startsWith('position:sticky;top:20px;align-self:start;max-height:calc(100vh - 40px);overflow:auto') && !sticky.includes('font-size'), `左右欄沿用 .panel 14px：${sticky}`);
  assert.ok(!cssRule('.progressrail')?.includes('border-right') && !cssRule('.sideinfo')?.includes('border-left'), '分隔線退場（改白卡）');
  assert.ok(cssRule('.progressrail')?.includes('padding:17px 13px'), `左軌內距照樣稿 .ux-progress：${cssRule('.progressrail')}`);
  assert.ok(cssRule('.sideinfo>.panel')?.includes('background:#f9faff'), '右欄卡底色（樣稿 hierarchy .right .panel）');
  assert.ok(cssRule('.runstep-now>h2')?.startsWith('font-size:21px;font-weight:500'), `步名 21px：${cssRule('.runstep-now>h2')}`);
});

test('L12 ②：停在 n2——中欄只有 n2 一列、STEP 02、「第 2 次交卷」、h2 步名、停點卡原文完整（三鈕）、本步監工交代在卡之後；沒交過卷不印「第 0 次」', () => {
  const steps = u6bSteps({ attempts: [{ at: '2026-09-15T10:02:00Z', reason: 'first' }, { at: '2026-09-15T10:04:00Z', reason: 'retry' }], handoff: { text: '交接二' } });
  const st = u6State({ run: u6Run({ steps }) });
  const { main } = u6Cols(l12Html({ run: u6Run({ steps }) }));
  assert.equal(count(main, 'data-steprow="'), 1);
  assert.ok(main.includes('data-steprow="n2"'));
  const order = ['<span class="caption">STEP 02</span>', '<span class="chip">第 2 次交卷</span>', '<h2>寫稿</h2>', 'data-steprow="n2"'];
  order.forEach((w, i) => assert.ok(main.indexOf(w) >= 0 && (i === 0 || main.indexOf(w) > main.indexOf(order[i - 1])), `順序 ${w}：${main.slice(0, 400)}`));
  const stop = l12Stop(st, 1, steps.n2);
  assert.ok(main.includes(stop), '停點卡原文一字不改');
  assert.deepEqual(btnsOf(stop), [['approve', '繼續'], ['start-edit', '編輯'], ['back', '稍後']]);
  const hand = main.indexOf('<div class="stephandoff">');
  assert.ok(hand > main.indexOf(stop) && main.slice(hand).includes('交接二'), `本步監工交代在停點卡之後（驗收第 11 條）：${main.slice(hand, hand + 160)}`);
  const quiet = u6Cols(l12Html()).main;
  assert.ok(!quiet.includes('次交卷') && !quiet.includes('stephandoff'), '沒交卷、沒交代＝不印');
  const routed = u6Cols(l12Html({ run: u6Run({ steps: u6bSteps({ handoff: { text: '只判路', only_route: true } }) }) })).main;
  assert.ok(!routed.includes('只判路'), 'only_route 交接不印');
});

test('L12 ③：有產出、沒有卡的步——.runout 裡「看原文」緊貼產出框（同一容器，outbar 在上）；停點卡自己帶產出時不重印；左軌點做完的步＝歷史視圖也用同一個 .runout', () => {
  const steps = { n1: { status: 'done', output: '成品一' }, n2: { status: 'done', output: '成品二' }, n3: { status: 'pending' } };
  const { main } = u6Cols(l12Html({ run: u6Run({ steps }) }));
  assert.ok(/<div class="runout"><div class="outbar"><span class="pbtn mdtoggle" data-act="md-toggle" data-key="out:n2">看原文<\/span><\/div><div class="output" data-mdkey="out:n2">成品二<\/div><\/div>/.test(main), `目前這步（最後做完的 n2）：${main}`);
  const stopMain = u6Cols(l12Html()).main;
  assert.equal(count(stopMain, 'class="runout"'), 0, '停點卡已帶產出與看原文，不重印一份');
  const edited = u6Run(); edited.steps.n1.edited_output = '改過的';
  const hist = u6Cols(l12Html({ runInspect: 'n1', run: edited })).main;
  assert.ok(/<div class="runout"><div class="outbar"><span class="chip">你改過的版本<\/span><span class="pbtn mdtoggle" data-act="md-toggle" data-key="hist:n1">看原文<\/span><\/div><div class="output" data-mdkey="hist:n1">改過的<\/div><\/div>/.test(hist), `歷史視圖：${hist}`);
  assert.ok(hist.includes('class="runbanner hist"') && hist.includes('<span class="caption">STEP 01</span>'), '歷史橫幅＋STEP 01');
  assert.ok(cssRule('.runout')?.includes('border-radius:13px') && cssRule('.runout .outbar')?.includes('justify-content:flex-end'), `產出框樣稿 .ux-output、看原文靠右上：${cssRule('.runout')}`);
});

test('L12 ④：左軌點到「等你／出錯」的步都可操作——並行 n3 等你：卡在中欄、不 inert、左軌 active＝n3、橫幅可回到目前；出錯的步算目前這步（重試鈕在中欄）；點做完的 n1 仍是歷史視圖', () => {
  const steps = { n1: { status: 'done', output: '成品一' }, n2: { status: 'waiting_review', output: '成品二', check: { blocks: [], summary: '' } }, n3: { status: 'waiting_human' } };
  const st = u6State({ runInspect: 'n3', run: u6Run({ steps }) });
  const { rail, main, side } = u6Cols(l12Html({ runInspect: 'n3', run: u6Run({ steps }) }));
  const human = uiFn('humanCardHtml', { ...CARD_STUBS, humanize: (t) => t, kept: () => undefined, state: st })(st.run.def.nodes[2]);
  assert.ok(main.includes(human) && count(main, 'inert') === 0, `人做卡原文、可輸入：${main}`);
  assert.ok(main.includes('data-act="human-done" data-node="n3"'), '標記完成可按');
  assert.ok(main.includes('class="runbanner branch"') && main.includes('data-act="run-current"'), '支線橫幅＋回到目前');
  assert.ok(/class="runstep active" data-act="run-inspect" data-node="n3"/.test(rail), '左軌 active＝n3');
  assert.ok(side.includes('定稿'), '右欄跟著 n3');
  const failed = { n1: { status: 'done', output: 'a' }, n2: { status: 'failed', error: '連不上' }, n3: { status: 'pending' } };
  assert.equal(uiFn('currentNodeOf')(u6Run({ steps: failed })), 'n2', '出錯的步＝目前這步');
  const fm = u6Cols(l12Html({ run: u6Run({ steps: failed }) })).main;
  assert.ok(fm.includes('data-act="retry" data-node="n2"') && fm.includes('data-steprow="n2"'), `出錯卡在中欄：${fm}`);
  const hm = u6Cols(l12Html({ runInspect: 'n1', run: u6Run({ steps }) })).main;
  assert.ok(hm.includes('class="runbanner hist"') && !hm.includes('human-done'), '做完的步＝歷史視圖');
  // 在支線上處理完（n3 做完了）＝回到目前這步 n2；一開始就點做完的步則留在歷史
  const s2 = u6State({ runInspect: 'n3', run: u6Run({ steps }) });
  const rh = uiFn('runHtml', { ...CARD_STUBS, ...L12_MD, preflightFor: () => null, humanize: (t) => t, kept: () => undefined, state: s2 });
  rh();
  assert.equal(s2.runInspectLive, 'n3', '點進來的是等你的支線（記住是哪一步，排版輪 L12b）');
  s2.run = u6Run({ steps: { ...steps, n3: { status: 'done', output: '乙好了' } } });
  const back = u6Cols(rh()).main;
  assert.ok(s2.runInspect === null && back.includes('data-steprow="n2"') && !back.includes('runbanner'), `處理完回目前這步：${back.slice(0, 300)}`);
  const s3 = u6State({ runInspect: 'n1', run: u6Run({ steps }) });
  const rh3 = uiFn('runHtml', { ...CARD_STUBS, ...L12_MD, preflightFor: () => null, state: s3 });
  rh3(); rh3();
  assert.ok(s3.runInspect === 'n1' && s3.runInspectLive === null,'看做完的步：重繪後仍在歷史');
  const ri = /act === 'run-inspect'\) \{[\s\S]*?\n    \}/.exec(uiSrc())[0];
  assert.ok(ri.includes("state.run.status !== 'done'"), `跑完的 run 點最後一步也看得到它的歷史：${ri}`);
});

test('L12 ⑤：跑完——中欄一張 .panel.runcomplete：「這次的成品已備妥」→成品列（每項名稱＋旁邊看原文，可展開）→這趟的紀錄→提議→回饋框；左軌三顆可點、沒有預設 active；右欄照出', () => {
  const done = u6Run({ status: 'done', finished_at: '2026-09-15T10:30:00Z', record: { text: '這趟很順', suggestions: [] }, steps: { n1: { status: 'done', output: 'a' }, n2: { status: 'done', output: 'b' }, n3: { status: 'done', output: 'c' } } });
  const { rail, main, side } = u6Cols(l12Html({ run: done }, { proposalsHtml: () => '<div data-proposals></div>' }));
  const order = ['<div class="panel runcomplete">', '<h2>這次的成品已備妥</h2>', '<details class="artifact">', 'data-key="art:n1">看原文', '這趟的紀錄', '這趟很順', 'data-proposals', 'id="run-feedback-input"'];
  order.forEach((w, i) => assert.ok(main.indexOf(w) >= 0 && (i === 0 || main.indexOf(w) > main.indexOf(order[i - 1])), `順序 ${w}：${main}`));
  assert.equal(count(main, '<details class="artifact">'), 3, '三份成品（含你交出的）');
  assert.ok(/<summary>[^]*?定稿（你交出的）[^]*?data-key="art:n3">看原文<\/span><\/span><\/summary>/.test(main), '看原文在成品名旁');
  assert.equal(count(rail, 'class="runstep active"'), 0, '跑完沒有預設 active');
  assert.equal(count(rail, 'data-act="run-inspect"'), 3);
  assert.ok(side.includes('目前這步'), '右欄照出');
  const sent = u6Cols(l12Html({ run: done, feedbackSent: { memory_notice: null } }, { proposalsHtml: () => '', feedbackReplyHtml: () => '<div data-reply></div>' })).main;
  assert.ok(sent.includes('data-reply') && !sent.includes('run-feedback-input'), '送出回饋後換回覆');
  const last = u6Cols(l12Html({ run: done, runInspect: 'n3' })).main;
  assert.ok(last.includes('你在看「定稿」這一步的歷史') && !last.includes('runcomplete'), '跑完點最後一步＝它的歷史');
});

test('L12 ⑥：page-head——h1＝Workflow 名、一行 sub（開跑時間＋這次設定）、右上狀態 chip 三句＋「回 Workflow」（back）；tophead／「進行中：」「跑完了：」退場', () => {
  const h = l12Html({ run: u6Run({ status: 'paused' }) });
  assert.ok(h.includes('<div class="page-head"><div><h1>週報</h1><p>') && /<p>[^<]*開跑 · 這次設定：（無）<\/p><\/div><div class="actions">/.test(h), h.slice(h.indexOf('page-head'), h.indexOf('page-head') + 300));
  const acts = h.slice(h.indexOf('<div class="actions">'), h.indexOf('<div class="runlayout">'));
  assert.ok(acts.includes('停著等你') && acts.includes('<button class="btn" data-act="back"><i class="ph ph-caret-left"></i>回 Workflow</button>'), acts);
  assert.ok(u6Html({ run: u6Run({ status: 'done', steps: { n1: { status: 'done' }, n2: { status: 'done' }, n3: { status: 'done' } } }) }).includes('全部完成'));
  assert.ok(u6Html({ run: u6Run({ steps: { n1: { status: 'done' }, n2: { status: 'running' }, n3: { status: 'pending' } } }) }).includes('>第 2 步</span>'));
  for (const gone of ['class="tophead"', '進行中：', '跑完了：', 'class="backb"']) assert.equal(count(h, gone), 0, gone);
  const params = u6Run({ def: { name: '週報', nodes: U6_NODES(), params: [{ key: 'k', label: '期間' }] }, params: { k: '第三季\n細節' } });
  assert.ok(u6Html({ run: params }).includes('<span title="第三季\n細節">第三季</span>'), '欄位值第一行＋整份放 title（原樣）');
});

test('L12 ⑦：右欄「本次補充」——run.note 有值才出第二塊 .panel（escape）；沒有／空白不出', () => {
  const side = (run) => u6Cols(u6Html({ run })).side;
  const withNote = side(u6Run({ note: '留意<新品>' }));
  assert.ok(withNote.includes('<div class="panel sidenote"><h3>本次補充</h3><p class="note">留意<新品></p></div></aside>'), withNote.slice(-200)); // 測試 ctx 的 esc 原樣；真 esc 看下一行原文
  assert.ok(uiSrc().includes('<p class="note">${esc(run.note)}</p>'), '補充經 esc');
  assert.equal(count(withNote, 'class="panel'), 2, '兩塊白卡');
  for (const note of [undefined, '  ']) assert.ok(!side(u6Run({ note })).includes('本次補充'), `沒有補充：${note}`);
});

test('L12b ①：連續操作（同一個 state 沿用）——看過等你的支線 n3 後，第一次點做完的 n1 就是 n1 歷史（左軌 active＝n1）、輪詢重繪不踢回；再點回 n3＝可操作；n3 在那裡處理完＝回目前這步 n2；看 n1 時 n3 被處理完也不踢回', () => {
  const steps = { n1: { status: 'done', output: '成品一' }, n2: { status: 'waiting_review', output: '成品二', check: { blocks: [], summary: '' } }, n3: { status: 'waiting_human' } };
  const s = u6State({ run: u6Run({ steps }) });
  const rh = uiFn('runHtml', { ...CARD_STUBS, ...L12_MD, preflightFor: () => null, humanize: (t) => t, kept: () => undefined, state: s });
  const cur = uiFn('currentNodeOf');
  // 照 run-inspect 分支：點目前這步存 null
  const click = (node) => { s.runInspect = node === cur(s.run) && s.run.status !== 'done' ? null : node; return u6Cols(rh()); };
  const poll = () => u6Cols(rh());
  const active = (rail) => /class="runstep active" data-act="run-inspect" data-node="(\w+)"/.exec(rail)?.[1] ?? null;
  const isHist = (v, id) => v.main.includes('class="runbanner hist"') && v.main.includes(`data-steprow="${id}"`) && active(v.rail) === id;
  const isBranch = (v, id) => v.main.includes('class="runbanner branch"') && v.main.includes(`data-act="human-done" data-node="${id}"`) && active(v.rail) === id;
  const isNow = (v) => !v.main.includes('runbanner') && v.main.includes('data-steprow="n2"') && active(v.rail) === 'n2';

  assert.ok(isNow(poll()), '一開始＝目前這步 n2');
  assert.ok(isBranch(click('n3'), 'n3'), '點等你的支線 n3＝可操作');
  let v = click('n1');
  assert.ok(isHist(v, 'n1') && s.runInspect === 'n1', `第一次點 n1 就要是 n1 歷史（左軌 active ${active(v.rail)}）：${v.main.slice(0, 300)}`);
  assert.ok(isHist(poll(), 'n1') && isHist(poll(), 'n1'), '看歷史時輪詢重繪不踢回');
  assert.ok(isBranch(click('n3'), 'n3'), '再點回 n3＝可操作');
  assert.ok(isBranch(poll(), 'n3'), 'n3 還在等：輪詢不動');
  s.run = u6Run({ steps: { ...steps, n3: { status: 'done', output: '乙好了' } } });
  assert.ok(isNow(poll()) && s.runInspect === null, '在 n3 上處理完＝回目前這步 n2');
  assert.ok(isHist(click('n1'), 'n1'), '回來後點 n1＝歷史');

  // 看支線 → 去看 n1 → 支線在別處被處理完：人在看 n1，不踢回
  s.run = u6Run({ steps }); s.runInspect = null; poll();
  click('n3'); click('n1');
  s.run = u6Run({ steps: { ...steps, n3: { status: 'done', output: '乙好了' } } });
  assert.ok(isHist(poll(), 'n1'), '看 n1 時 n3 處理完：留在 n1 歷史');
  // 點目前這步 → 再點支線 → 支線處理完＝回目前
  s.run = u6Run({ steps }); s.runInspect = null; poll();
  click('n2'); click('n3'); click('n1'); click('n3');
  s.run = u6Run({ steps: { ...steps, n3: { status: 'done', output: '乙好了' } } });
  assert.ok(isNow(poll()), '多次切換後在 n3 上處理完仍回目前這步');
});

// ---------- （L10 覆核新風險，主 agent 定案）：步驟彈窗有未套用改動——背景不關、Esc／✕／取消先問 ----------
const l12Dlg = (fields) => ({ querySelectorAll: () => fields });
const l12F = (o) => ({ matches: (sel) => (sel === '[data-preset-field]' ? !!o.preset : false), dataset: o.dataset ?? {}, ...o });
test('L12 彈窗 ①：stepFormValues／stepModalDirty——任一欄位值（含勾選、參考檔勾選）跟開窗時不同＝有改動；常用片段選單不算；後來才長出來的欄位補進開窗值；沒開窗＝沒改動', () => {
  const fields = [l12F({ id: 'cv-title', value: '整理' }), l12F({ id: 'cv-stop', type: 'checkbox', checked: true }), l12F({ type: 'checkbox', checked: false, dataset: { att: 'a.md', attScope: 'company' } }), l12F({ id: 'cv-preset-role', value: '', preset: true }), l12F({ value: 'x' })];
  const vals = uiFn('stepFormValues')(l12Dlg(fields));
  assert.equal(J(vals), J({ 'cv-title': '整理', 'cv-stop': true, 'att:company:a.md': false }), J(vals));
  const state = { drawerOpen: true, drawerTabFor: 'n1', stepSnap: null, stepSnapFor: null };
  let dlg = l12Dlg(fields);
  const ctx = { state, document: { querySelector: (s) => (s === '.stepdlg' ? dlg : null) } };
  uiFn('syncStepSnap', ctx)();
  assert.ok(state.stepSnapFor === 'n1' && J(state.stepSnap) === J(vals), '開窗記下');
  const dirty = uiFn('stepModalDirty', ctx);
  assert.equal(dirty(), false, '沒動');
  fields[0].value = '整理2'; assert.equal(dirty(), true, '文字改了'); fields[0].value = '整理'; assert.equal(dirty(), false, '改回去＝沒改動');
  fields[2].checked = true; assert.equal(dirty(), true, '參考檔勾了'); fields[2].checked = false;
  fields[1].checked = false; assert.equal(dirty(), true, '停點取消勾'); fields[1].checked = true;
  fields[3].value = '主管'; assert.equal(dirty(), false, '常用片段選單不算');
  fields.push(l12F({ type: 'checkbox', checked: true, dataset: { att: 'b.md' } }));
  uiFn('syncStepSnap', ctx)();
  assert.ok(state.stepSnap['att:flow:b.md'] === true && dirty() === false, '後來長出來的欄位（參考檔清單載入）補進開窗值');
  state.drawerTabFor = 'n2'; fields[0].value = '別顆';
  uiFn('syncStepSnap', ctx)();
  assert.ok(state.stepSnapFor === 'n2' && state.stepSnap['cv-title'] === '別顆', '換節點重記');
  dlg = null; uiFn('syncStepSnap', ctx)();
  assert.equal(state.stepSnap, null, '關窗清掉');
  assert.equal(uiFn('stepModalDirty', { state: { stepSnap: null } })(), false, '沒開窗（沒有 document 也不炸）');
  const rd = /function render\(\) \{[\s\S]*?\n\}\n/.exec(uiSrc())[0];
  assert.ok(rd.includes('syncStepSnap();'), 'render 後記開窗值');
});

test('L12 彈窗 ②：有改動時——背景點一下不關（框線閃一下）；✕／取消／Esc 先問「套用／丟掉／繼續編輯」；丟掉＝關；繼續編輯＝收起詢問；套用走 cv-apply；沒改動照現行直接關；詢問列 vm 與分身都認得', async () => {
  const src = uiSrc();
  const branch = src.slice(src.indexOf("else if (act === 'cv-close-drawer')"), src.indexOf("else if (act === 'preset-save')"));
  const back = { classList: { contains: (c) => c === 'pvback' }, dataset: {} };
  const btn = { classList: { contains: () => false }, dataset: {} };
  const discard = { classList: { contains: () => false }, dataset: { discard: '1' } };
  const run = (el, isDirty) => {
    const calls = [];
    const state = { drawerOpen: true, drawerTabFor: 'n1', cvMore: true, run: null, keep: { '-:cv-bg': '沒套用的字' }, stepAsk: false };
    const { context } = uiCtx({ state, render: () => calls.push('render'), backDown: el, stepModalDirty: () => isDirty, nudgeStepModal: () => calls.push('nudge'), showStepAsk: () => { state.stepAsk = true; calls.push('ask'); } });
    vm.runInContext(`((act, el, e) => { if (0) {} ${branch} })`, context)('cv-close-drawer', el, { target: el });
    return { state, calls };
  };
  const b1 = run(back, true);
  assert.ok(b1.state.drawerOpen === true && J(b1.calls) === J(['nudge']) && b1.state.keep['-:cv-bg'], `背景＋有改動＝不關、閃框：${J(b1.calls)}`);
  const b2 = run(btn, true);
  assert.ok(b2.state.drawerOpen === true && b2.state.stepAsk === true && J(b2.calls) === J(['ask']), '✕／取消＋有改動＝先問');
  const b3 = run(discard, true);
  assert.ok(b3.state.drawerOpen === false && b3.state.stepAsk === false && !('-:cv-bg' in b3.state.keep), '丟掉＝關、清暫存字');
  for (const el of [back, btn]) assert.equal(run(el, false).state.drawerOpen, false, '沒改動照現行直接關');
  // 詢問列
  const ask = uiFn('stepAskHtml')();
  assert.ok(ask.startsWith('<div class="stepask" role="alertdialog"') && ask.includes('有改動還沒套用'), ask);
  assert.deepEqual(btnsOf(ask), [['cv-apply', '套用'], ['cv-close-drawer', '丟掉'], ['step-ask-cancel', '繼續編輯']]);
  assert.ok(ask.includes('data-act="cv-close-drawer" data-discard="1"'), '丟掉帶 data-discard');
  const drawer = uiFn('drawerHtml', { state: { drawerOpen: true, run: null, mode: 'list', flowTab: 'design', canvasSel: 'n1', drawerTabFor: 'n1', keep: {}, stepAsk: true }, cvDef: () => l10Def(), canvasEditorHtml: () => 'BODY', stepAskHtml: () => 'ASK' })();
  assert.ok(drawer.indexOf('ASK') > drawer.indexOf('</h2>') && drawer.indexOf('ASK') < drawer.indexOf('BODY'), '重繪時詢問列留著（標題下）');
  const closeSt = { drawerOpen: true, drawerTabFor: 'n1', cvMore: 1, keep: {}, stepAsk: true };
  uiFn('closeStepModal', { state: closeSt })();
  assert.equal(closeSt.stepAsk, false, '關窗收起詢問');
  const cancel = /act === 'step-ask-cancel'\) \{[\s\S]*?\n    \}/.exec(src)?.[0] ?? '';
  assert.ok(cancel.includes('hideStepAsk()'), `繼續編輯：${cancel}`);
  const apply = src.slice(src.indexOf("else if (act === 'cv-apply')"), src.indexOf("else if (act === 'cv-delete')"));
  assert.ok(apply.includes('state.stepAsk = false;') && apply.includes('if (flip) state.stepSnap = null;'), '套用收起詢問；換執行者留窗時重記開窗值');
  assert.ok(cssRule('.stepask')?.includes('position:sticky') && cssRule('.stepdlg.nudge')?.includes('animation:stepnudge'), 'CSS 詢問列黏在彈窗上緣、閃框動畫');
});

// ----------  畫布資料模型：款 A 同時做／擇一／等全部的顯示模型、存檔轉換、由上往下自動排、舊結構相容 ----------
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { validateWorkflow } from '../src/schema.js';
import { ancestorIds } from '../src/graph.js';
import { exportText, parseImport } from '../src/porter.js';
import { DAG_DEF, PAR_DEF } from './fixtures.js';
import { inputSources, packInputs } from '../src/preflight.js';

const cvT = (id, next = [], more = {}) => ({ id, title: id.toUpperCase(), executor: 'ai', stop_point: 'never', instruction: 'x', next, ...more });
const cvBr = (id, arms, more = {}) => ({ id, title: '分', kind: 'branch', instruction: '看', next: [], branches: arms.map(([label, next]) => ({ label, next })), ...more });
const cvDefOf = (nodes) => ({ format: 1, name: 'W', params: [], nodes });
const cvState = (extra = {}) => ({ canvasSel: null, drawerOpen: false, mode: 'canvas', ...extra });
const cvF = (name, extra = {}) => uiFn(name, { state: cvState(), structuredClone, ...extra });
const edgeKeys = (m) => [...m.edges].map((e) => `${e.from}>${e.to}${e.dashed ? `~${e.cond}` : ''}`).sort();
// canvas.js 是 IIFE：塞假 window 載進 vm，拿 window.BJCanvas
const loadCanvas = () => { const w = {}; vm.runInNewContext(fs.readFileSync(path.join(UI, 'canvas.js'), 'utf8'), { window: w, document: {} }); return w.BJCanvas; };

test('L13 ①：cvModel——task 多 next＝同時做；T→fork（唯一）吸收成 T 實線；T→branch（唯一）＝虛線＋條件＋choose；分岔在第一步／分岔接並行點／T 同時接一般線與分岔＝舊寫法；多入線 entries（merge any）；舊 join 畫成直連；純函式不改 def', () => {
  const cvModel = cvF('cvModel');
  const multi = cvModel(cvDefOf([cvT('a', ['b', 'c']), cvT('b'), cvT('c')]));
  assert.equal(J(multi.exits), J({ a: 'all' }));
  assert.deepEqual(edgeKeys(multi), ['a>b', 'a>c']);
  assert.equal(J(multi.hidden), '[]');
  const fk = cvDefOf([cvT('a', ['F']), { id: 'F', title: '並行', kind: 'fork', next: ['b', 'c'] }, cvT('b'), cvT('c')]);
  const before = J(fk);
  const mf = cvModel(fk);
  assert.equal(J(fk), before, 'cvModel 不改 def');
  assert.equal(J(mf.hidden), J(['F']));
  assert.equal(J(mf.exits), J({ a: 'all' }));
  assert.deepEqual(edgeKeys(mf), ['a>b', 'a>c']);
  assert.equal(J(mf.cards.map((n) => n.id)), J(['a', 'b', 'c']), 'cards＝全部 task＋舊寫法');
  const br = cvDefOf([cvT('a', ['B']), cvBr('B', [['大', 'b'], ['小', 'c']], { instruction: '看金額' }), cvT('b'), cvT('c')]);
  const mb = cvModel(br);
  assert.equal(J(mb.exits), J({ a: 'one' }));
  assert.deepEqual(edgeKeys(mb), ['a>b~大', 'a>c~小']);
  assert.ok(mb.edges.every((e) => e.dashed && e.via === 'B'), '擇一線記得藏在哪個分岔');
  assert.equal(J(mb.edges.map((e) => e.arm)), J([0, 1]));
  assert.equal(mb.choose.a, '看金額');
  // 舊寫法三種
  const first = cvModel(cvDefOf([cvBr('B', [['一', 'b'], ['二', 'c']]), cvT('b'), cvT('c')]));
  assert.equal(J(first.legacy), J(['B']), '分岔在第一步');
  assert.deepEqual(edgeKeys(first), ['B>b~一', 'B>c~二']);
  const brFork = cvModel(cvDefOf([cvT('a', ['B']), cvBr('B', [['一', 'F'], ['二', 'x']]), { id: 'F', title: '並行', kind: 'fork', next: ['c', 'd'] }, cvT('x'), cvT('c'), cvT('d')]));
  assert.equal(J(brFork.legacy), J(['F']), '分岔接並行點：並行點是舊寫法');
  assert.equal(J(brFork.hidden), J(['B']));
  assert.deepEqual(edgeKeys(brFork), ['F>c', 'F>d', 'a>F~一', 'a>x~二']);
  const mixed = cvModel(cvDefOf([cvT('a', ['x', 'B']), cvT('x'), cvBr('B', [['一', 'c'], ['二', 'd']]), cvT('c'), cvT('d')]));
  assert.equal(J(mixed.legacy), J(['B']), 'T 同時接一般線與分岔');
  assert.equal(J(mixed.exits), J({ a: 'all' }));
  // 多入線與舊 join
  const any = cvModel(cvDefOf([cvT('a', ['b', 'c']), cvT('b', ['d']), cvT('c', ['d']), cvT('d', [], { merge: 'any' })]));
  assert.equal(J(any.entries), J({ d: 'any' }));
  const jn = cvModel(cvDefOf([cvT('a', ['b', 'c']), cvT('b', ['J']), cvT('c', ['J']), { id: 'J', title: '會合', kind: 'join', next: ['d'] }, cvT('d')]));
  assert.equal(J(jn.hidden), J(['J']));
  assert.deepEqual(edgeKeys(jn), ['a>b', 'a>c', 'b>d', 'c>d']);
  assert.equal(J(jn.entries), J({ d: 'all' }));
});

test('L13 ②：cvConnect——一般卡第二條線成立（不再擋）；成環擋；擇一出口多一條空條件路；重複的線不重加', () => {
  const cvConnect = cvF('cvConnect');
  const d = cvDefOf([cvT('a', ['b']), cvT('b'), cvT('c')]);
  cvConnect(d, 'a', 'c');
  assert.equal(J(d.nodes[0].next), J(['b', 'c']));
  cvConnect(d, 'a', 'c');
  assert.equal(J(d.nodes[0].next), J(['b', 'c']), '重複不加');
  assert.throws(() => cvConnect(d, 'c', 'a'), /繞圈/);
  assert.throws(() => cvConnect(d, 'a', 'a'), /自己接自己/);
  const one = cvDefOf([cvT('a', ['B']), cvBr('B', [['大', 'b']]), cvT('b'), cvT('c')]);
  cvConnect(one, 'a', 'c');
  assert.equal(J(one.nodes[0].next), J(['B']));
  assert.equal(J(one.nodes[1].branches), J([{ label: '大', next: 'b' }, { label: '', next: 'c' }]), '擇一出口多一條空條件路');
});

test('L13 ③：cvSetExit all→one→all 來回，def 回到原樣（JSON 相等）；all→one 建藏起來的分岔（卡名・擇一、預設怎麼挑、每條原線空條件）', () => {
  const cvSetExit = cvF('cvSetExit');
  const cvModel = cvF('cvModel');
  const d = cvDefOf([cvT('a', ['b', 'c']), cvT('b'), cvT('c')]);
  const orig = J(d);
  cvSetExit(d, 'a', 'one');
  const B = d.nodes.find((n) => n.kind === 'branch');
  assert.ok(B && d.nodes[1] === B, '分岔緊接在卡後面');
  assert.equal(J(d.nodes[0].next), J([B.id]));
  assert.equal(B.title, 'A・擇一');
  assert.equal(B.instruction, '依每條線上的條件，挑符合的一條走');
  assert.equal(J(B.branches), J([{ label: '', next: 'b' }, { label: '', next: 'c' }]));
  assert.equal(J(B.next), '[]');
  assert.equal(cvModel(d).exits.a, 'one');
  cvSetExit(d, 'a', 'one');
  assert.equal(d.nodes.filter((n) => n.kind === 'branch').length, 1, '已是擇一再設一次不重建');
  cvSetExit(d, 'a', 'all');
  assert.equal(J(d), orig, '來回回到原樣');
});

test('L13 ④：cvCut——擇一剪到剩一條＝藏起來的分岔被拆、next 單一；同時做剪一條；cvSetCond／cvSetChoose／cvSetEntry 寫回', () => {
  const [cvCut, cvSetCond, cvSetChoose, cvSetEntry] = ['cvCut', 'cvSetCond', 'cvSetChoose', 'cvSetEntry'].map((f) => cvF(f));
  const d = cvDefOf([cvT('a', ['B']), cvBr('B', [['大', 'b'], ['小', 'c']]), cvT('b'), cvT('c')]);
  cvSetCond(d, 'a', 'c', '  金額小於五千 ');
  assert.equal(d.nodes[1].branches[1].label, '金額小於五千');
  cvSetChoose(d, 'a', '看報帳金額');
  assert.equal(d.nodes[1].instruction, '看報帳金額');
  cvSetChoose(d, 'a', '   ');
  assert.equal(d.nodes[1].instruction, '依每條線上的條件，挑符合的一條走', '怎麼挑不准空（定義檔不允許）');
  cvCut(d, 'a', 'c');
  assert.equal(J(d.nodes.map((n) => n.id)), J(['a', 'b', 'c']), '分岔拆掉');
  assert.equal(J(d.nodes[0].next), J(['b']));
  const all = cvDefOf([cvT('a', ['b', 'c']), cvT('b'), cvT('c', [])]);
  cvCut(all, 'a', 'b');
  assert.equal(J(all.nodes[0].next), J(['c']));
  cvSetEntry(all, 'c', 'any');
  assert.equal(all.nodes[2].merge, 'any');
  cvSetEntry(all, 'c', 'all');
  assert.ok(!('merge' in all.nodes[2]), '等全部＝刪鍵（舊檔形狀）');
  // 同一對卡兩條擇一路：用 arm 指定剪哪條
  const dup = cvDefOf([cvT('a', ['B']), cvBr('B', [['一', 'b'], ['二', 'b'], ['三', 'c']]), cvT('b'), cvT('c')]);
  cvCut(dup, 'a', 'b', 1);
  assert.equal(J(dup.nodes[1].branches.map((x) => x.label)), J(['一', '三']));
});

test('L13 ⑤：normalize——可吸收的 fork 就地拆成多 next；不可吸收的（兩個前驅、只剩一支）留著；舊 join 照拆；帶 merge 的舊 join 不拆（拆了會丟掉任一條到）', () => {
  const normalize = cvF('normalize');
  const d = cvDefOf([cvT('a', ['F']), { id: 'F', title: '並行', kind: 'fork', next: ['b', 'c'] }, cvT('b', ['J']), cvT('c', ['J']), { id: 'J', title: '會合', kind: 'join', next: ['e'] }, cvT('e')]);
  normalize(d);
  assert.equal(J(d.nodes.map((n) => n.id)), J(['a', 'b', 'c', 'e']));
  assert.equal(J(d.nodes[0].next), J(['b', 'c']));
  assert.equal(J(d.nodes[1].next), J(['e']));
  const keep = cvDefOf([cvT('a', ['F']), cvT('x', ['F']), { id: 'F', title: '並行', kind: 'fork', next: ['b', 'c'] }, cvT('b'), cvT('c'), cvT('y', ['G']), { id: 'G', title: '並行', kind: 'fork', next: ['z'] }, cvT('z')]);
  normalize(keep);
  assert.equal(J(keep.nodes.map((n) => n.id)), J(['a', 'x', 'F', 'b', 'c', 'y', 'G', 'z']), '兩個前驅的 fork、只剩一支的 fork 留著');
  const mj = cvDefOf([cvT('a', ['b', 'c']), cvT('b', ['J']), cvT('c', ['J']), { id: 'J', title: '會合', kind: 'join', next: ['e'], merge: 'any' }, cvT('e')]);
  normalize(mj);
  assert.ok(mj.nodes.some((n) => n.id === 'J'), '帶 merge 的 join 留著');
});

test('L13 ⑥：cvEmptyConds 回空條件的線（藏起來的分岔記在卡上、舊分岔記在分岔上）；cvSave 有空條件不送 PUT、標出那幾條、講幾條沒寫；saveDef 也攔（清單即改即存那條路）', async () => {
  const cvEmptyConds = cvF('cvEmptyConds');
  const d = cvDefOf([cvT('a', ['B']), cvBr('B', [['大', 'b'], [' ', 'c']]), cvT('b', ['L', 'x']), cvBr('L', [['', 'c'], ['有', 'x']]), cvT('c'), cvT('x')]);
  assert.equal(J(cvEmptyConds(d)), J([{ from: 'a', to: 'c', arm: 1 }, { from: 'L', to: 'c', arm: 0 }]));
  assert.equal(J(cvEmptyConds(cvDefOf([cvT('a', ['b', 'c']), cvT('b'), cvT('c')]))), '[]');
  let puts = 0;
  const alerts = [];
  const state = cvState({ cvDirty: true, cvWork: d, wf: { category: 'c', id: 'w', def: {} } });
  const cvSave = uiFn('cvSave', { state, structuredClone, subjectIsDraft: () => false, saveDef: async () => { puts++; }, render: () => {}, window: { alert: (m) => alerts.push(m) } });
  await cvSave();
  assert.equal(puts, 0, '不送 PUT');
  assert.equal(state.cvDirty, true, '工作本留著');
  assert.equal(J(state.cvCondIssues), J(cvEmptyConds(d)), '標出那幾條');
  assert.ok(alerts[0].includes('還有 2 條擇一的線沒寫條件'), alerts[0]);
  let api = 0;
  const saveDef = uiFn('saveDef', { state: cvState({ wf: { category: 'c', id: 'w' }, chat: {} }), subjectIsDraft: () => false, wfPath: () => '/x', api: async () => { api++; } });
  await assert.rejects(() => saveDef(d), /還有 2 條擇一的線沒寫條件/);
  assert.equal(api, 0);
});

test('L13 ⑦：座標——canvas.layout 不是 tb（舊由左往右座標）→忽略舊座標；一次 canvasOp 後全部卡片座標＋layout:tb 寫入、隱藏節點無座標；之後加卡別張不跳', async () => {
  const BJCanvas = loadCanvas();
  const def = cvDefOf([cvT('a', ['B']), cvBr('B', [['大', 'b'], ['小', 'c']]), cvT('b', ['d']), cvT('c', ['d']), cvT('d')]);
  def.canvas = { positions: { a: { x: 999, y: 7 }, B: { x: 1, y: 1 } } };
  const state = cvState({ wf: { category: 'c', id: 'w', def }, cvWork: null });
  const ctx = { state, structuredClone, window: { BJCanvas }, subjectIsDraft: () => false, subjectDef: () => def, render: () => {}, saveDef: async () => { throw new Error('畫布模式不該直接存'); } };
  const { context } = uiCtx(ctx);
  const canvasOp = vm.runInContext('canvasOp', context);
  const auto = BJCanvas.layout(vm.runInContext('cvModel', context)(def), def.canvas).pos;
  assert.notEqual(auto.get('a').x, 999, '舊座標不沿用');
  await canvasOp((d) => vm.runInContext('cvSetEntry', context)(d, 'd', 'any'));
  const w1 = state.cvWork;
  assert.equal(w1.canvas.layout, 'tb');
  assert.equal(J(Object.keys(w1.canvas.positions).sort()), J(['a', 'b', 'c', 'd']), '全部卡片、隱藏分岔無座標');
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(J(w1.canvas.positions[id]), J({ x: auto.get(id).x, y: auto.get(id).y }), `${id} 存的是畫面上的座標`);
  // 之後加一張卡（放在指定位置）：別張不動
  await canvasOp((d) => { d.nodes.push(cvT('e')); vm.runInContext('setPos', context)(d, 'e', 5, 600); vm.runInContext('cvConnect', context)(d, 'd', 'e'); });
  const w2 = state.cvWork;
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(J(w2.canvas.positions[id]), J(w1.canvas.positions[id]), `${id} 不跳`);
  assert.equal(J(w2.canvas.positions.e), J({ x: 5, y: 600 }));
  // 清單模式（即改即存）不動座標
  const listState = cvState({ mode: 'list', wf: { category: 'c', id: 'w2' } });
  let saved = null;
  const lctx = uiCtx({ ...ctx, state: listState, subjectDef: () => structuredClone(def), saveDef: async (d) => { saved = d; } }).context;
  await vm.runInContext('canvasOp', lctx)((d) => { d.nodes[0].title = '改名'; });
  assert.equal(J(saved.canvas), J(def.canvas), '清單模式只清掉死座標，不改排法');
});

test('L13 ⑧：canvas.js layout（vm 載 canvas.js）——a→{b,c}→d 由上往下三列、b／c 同列左右置中、列距 155、欄距 250、卡 210×105；tb 存的座標蓋過自動排', () => {
  const BJCanvas = loadCanvas();
  const cvModel = cvF('cvModel');
  const def = cvDefOf([cvT('a', ['b', 'c']), cvT('b', ['d']), cvT('c', ['d']), cvT('d')]);
  const L = BJCanvas.layout(cvModel(def), def.canvas);
  const p = (id) => L.pos.get(id);
  assert.equal(J(L.sz.get('a')), J({ w: 210, h: 105 }));
  assert.equal(p('b').y - p('a').y, 182); // L14b：a 有出口膠囊（同時做）列距 155＋27
  assert.equal(p('d').y - p('b').y, 183); // L14b：d 有入口膠囊（等全部）列距 155＋28
  assert.equal(p('b').y, p('c').y);
  assert.equal(p('c').x - p('b').x, 250);
  const mid = (id) => p(id).x + 105;
  assert.equal(mid('a'), (mid('b') + mid('c')) / 2, 'a 在 b／c 正中');
  assert.equal(mid('d'), mid('a'));
  assert.ok(p('a').x >= 0 && p('b').x >= 0);
  assert.equal(J(L.edges.map((e) => `${e.from}>${e.to}`)), J(['a>b', 'a>c', 'b>d', 'c>d']));
  const stored = BJCanvas.layout(cvModel(def), { layout: 'tb', positions: { c: { x: 3, y: 4 } } });
  assert.equal(J(stored.pos.get('c')), J({ x: 3, y: 4 }));
  assert.equal(J(stored.pos.get('a')), J(p('a')), '沒存的照自動排');
  const old = BJCanvas.layout(cvModel(def), { positions: { c: { x: 3, y: 4 } } });
  assert.equal(J(old.pos.get('c')), J(p('c')), '不是 tb 的舊座標不用');
  const legacy = cvDefOf([cvBr('B', [['一', 'b'], ['二', 'c']]), cvT('b'), cvT('c')]);
  assert.equal(J(BJCanvas.layout(cvModel(legacy), null).sz.get('B')), J({ w: 34, h: 34 }), '舊寫法小圓點');
  const html = BJCanvas.html(legacy, null, new Set(), cvModel(legacy));
  assert.ok(html.includes('舊寫法') && html.includes('stroke-dasharray="6 5"') && !html.includes('data-node="undefined"'), '舊寫法點、擇一線虛線');
});

// 語意比對：每個 task 的祖先 task 集合相同、每個分岔每條路（照順序）條件與最近 task 相同
const semOf = (def) => {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const kind = (n) => n.kind ?? 'task';
  const near = (id, seen = new Set()) => { const n = byId.get(id); if (!n || seen.has(id)) return []; seen.add(id); if (kind(n) === 'task') return [id]; return (kind(n) === 'branch' ? n.branches.map((b) => b.next) : n.next).flatMap((t) => near(t, seen)); };
  const tasks = def.nodes.filter((n) => kind(n) === 'task').map((n) => n.id).sort();
  return {
    tasks,
    anc: Object.fromEntries(tasks.map((t) => [t, ancestorIds({ def }, t).filter((p) => kind(byId.get(p)) === 'task').sort()])),
    arms: def.nodes.filter((n) => kind(n) === 'branch').map((n) => n.branches.map((b) => [b.label, near(b.next).sort()])),
    merge: Object.fromEntries(def.nodes.filter((n) => n.merge).map((n) => [n.id, n.merge])),
  };
};
test('L13 ⑨：舊 Workflow 樣本（範例 quarterly-report、報帳 DAG 含 fork／branch／join、平行 fork／join）cvModel→寫回（不編輯的 canvasOp）→validateWorkflow 通過且語意相同', async () => {
  const BJCanvas = loadCanvas();
  const samples = {
    quarterly: yaml.load(fs.readFileSync(path.join(UI, '..', 'examples', 'quarterly-report.yaml'), 'utf8')),
    dag: structuredClone(DAG_DEF),
    par: structuredClone(PAR_DEF),
  };
  for (const [name, def] of Object.entries(samples)) {
    const state = cvState({ wf: { category: 'c', id: name, def } });
    const { context } = uiCtx({ state, structuredClone, window: { BJCanvas }, subjectIsDraft: () => false, subjectDef: () => def, render: () => {} });
    const model = vm.runInContext('cvModel', context)(def);
    assert.ok(model.cards.length >= 1, name);
    await vm.runInContext('canvasOp', context)(() => {});
    const out = JSON.parse(J(state.cvWork));
    validateWorkflow(out);
    assert.equal(J(semOf(out)), J(semOf(def)), `${name} 語意相同`);
    assert.equal(out.canvas.layout, 'tb', name);
  }
  // 報帳 DAG：舊 join 拆直、並行點前有兩個前驅＝留著當舊寫法
  const dagModel = cvF('cvModel')(DAG_DEF);
  assert.equal(J(dagModel.legacy), J(['par']));
  assert.equal(J(dagModel.hidden.sort()), J(['amount-check', 'done-join', 'merge']));
});

test('L13 ⑩：匯出檔（porter）不含任何新鍵時照讀——解析後 cvModel 畫得出來、不長出 merge／layout；轉得過的舊寫法 cvCanConvert＝true、cvConvert 後語意不變', () => {
  const def = parseImport(exportText(DAG_DEF)).def;
  const snap = J(def);
  assert.ok(!snap.includes('"merge":') && !snap.includes('"layout":'));
  const m = cvF('cvModel')(def);
  assert.equal(J(def), snap, '讀不改');
  assert.ok(m.cards.some((n) => n.id === 'par') && m.edges.length > 0);
  const legacyFork = cvDefOf([cvT('a', ['F']), cvT('x', ['F']), { id: 'F', title: '並行', kind: 'fork', next: ['b', 'c'] }, cvT('b'), cvT('c')]);
  const cvCanConvert = cvF('cvCanConvert');
  assert.equal(cvCanConvert(legacyFork, 'F'), true);
  assert.equal(cvCanConvert(cvDefOf([cvBr('B', [['一', 'b'], ['二', 'c']]), cvT('b'), cvT('c')]), 'B'), false, '分岔在第一步轉不過');
  assert.equal(cvCanConvert(DAG_DEF, 'par'), false, '分岔的路經舊 join 接進並行點：拆了那條路只能指一步，轉不過（先收整再判斷）');
  const viaJoin = cvDefOf([cvT('a', ['J']), cvT('x', ['J']), { id: 'J', title: '會合', kind: 'join', next: ['F'] }, { id: 'F', title: '並行', kind: 'fork', next: ['b', 'c'] }, cvT('b'), cvT('c')]);
  assert.equal(cvCanConvert(viaJoin, 'F'), true);
  const semJ = J(semOf(viaJoin));
  cvF('cvConvert')(viaJoin, 'F');
  assert.equal(J(semOf(viaJoin)), semJ);
  validateWorkflow(JSON.parse(J(viaJoin)));
  const sem = J(semOf(legacyFork));
  cvF('cvConvert')(legacyFork, 'F');
  assert.ok(!legacyFork.nodes.some((n) => n.id === 'F'));
  assert.equal(J(semOf(legacyFork)), sem);
  validateWorkflow(JSON.parse(J(legacyFork)));
});

test('L13 ⑪：perf-fixture 產 w200c——200 步、10 組擇一（藏起來的分岔、條件非空）、validateWorkflow 通過、cvModel 認得 10 個擇一出口', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-w200c-'));
  const from = path.join(tmp, 'from');
  fs.mkdirSync(from);
  const tool = path.join(UI, '..', 'tools', 'perf-fixture.mjs');
  execFileSync(process.execPath, [tool, '--from', from, '--data', path.join(tmp, 'data'), '--id', 'w200c', '--groups', '40', '--choose', '10'], { stdio: 'pipe' });
  const def = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'workflows', '效能', 'w200c', 'workflow.yaml'), 'utf8'));
  validateWorkflow(def);
  const brs = def.nodes.filter((n) => n.kind === 'branch');
  assert.equal(brs.length, 10);
  assert.ok(brs.every((b) => b.branches.length === 3 && b.branches.every((x) => x.label.trim())), '條件非空');
  const m = cvF('cvModel')(def);
  assert.equal(Object.values(m.exits).filter((x) => x === 'one').length, 10);
  assert.equal(m.cards.length, 200);
  assert.equal(J(cvF('cvEmptyConds')(def)), '[]');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('L13 ⑫：cvHandlers——onConnect／onNewFrom 不含「一個步驟只接一條出線」、接線走 cvConnect、剪線走 cvCut、插一步走 cvInsert；canvasModeHtml 把 cvModel 交給畫布', () => {
  const src = uiSrc();
  const h = src.slice(src.indexOf('const cvHandlers = {'), src.indexOf('// ---------- 事件 ----------'));
  assert.equal(count(h, '一個步驟只接一條出線'), 0);
  assert.equal(count(src, '一個步驟只接一條出線'), 0);
  assert.ok(/onConnect: \(from, to\) => cvEdit\(\(d\) => cvConnect\(d, from, to\)\)/.test(h), 'onConnect');
  assert.ok(h.includes('cvConnect(d, from, t.id)'), 'onNewFrom');
  assert.ok(h.includes('cvCut(def, edge.from, edge.to, edge.arm)'), 'onCut');
  assert.ok(h.includes('cvInsert(def, edge, t)'), 'onInsert');
  assert.ok(src.includes('window.BJCanvas.html(def, state.canvasSel, issues, cvModel(def), cvCanvasOpts(def))'), 'canvasModeHtml（排版輪 L14：多交畫面選項）');
  // cvInsert：擇一線上插一步＝那條路改指新卡、條件留在原路上
  const d = cvDefOf([cvT('a', ['B']), cvBr('B', [['大', 'b'], ['小', 'c']]), cvT('b'), cvT('c'), cvT('n')]);
  cvF('cvInsert')(d, { from: 'a', to: 'c', arm: 1 }, d.nodes[4]);
  assert.equal(J(d.nodes[1].branches), J([{ label: '大', next: 'b' }, { label: '小', next: 'n' }]));
  assert.equal(J(d.nodes[4].next), J(['c']));
});

test('L13 彈窗：擇一的卡多「擇一：怎麼挑」#cv-choose＋每條線條件（data-cond-arm）、兩條以上線進來的卡多 #cv-merge（等全部／任一條到）——插在交付內容四格之後、更多設定之前，data-keep、cv- 開頭；人做步驟插在交出什麼之後；舊寫法點標「舊寫法」、轉得過的給「轉成新寫法」', () => {
  const def = cvDefOf([cvT('a', ['B']), cvBr('B', [['大', 'b'], ['', 'c']], { instruction: '看金額' }), cvT('b', ['d']), cvT('c', ['d']), cvT('d', [], { merge: 'any' }), cvT('h', [], { executor: 'human' })]);
  def.nodes[1].branches[1].next = 'c';
  def.nodes.find((n) => n.id === 'h').next = [];
  def.nodes.find((n) => n.id === 'b').next = ['d', 'h'];
  const ed = (n, keep = {}) => uiFn('canvasEditorHtml', l10EdCtx({ keep }))(n, def);
  const a = ed(def.nodes[0], { '-:cv-cond-1': '打到一半' });
  const at = ['id="cv-otone"', 'id="cv-choose"', 'data-cond-arm="0"', 'data-cond-arm="1"', '<details class="cvmore"'].map((s) => a.indexOf(s));
  at.forEach((x, i) => assert.ok(x >= 0 && (i === 0 || x > at[i - 1]), `順序 ${i}：${at}`));
  assert.ok(/<textarea id="cv-choose"[^>]*data-keep[^>]*>看金額<\/textarea>/.test(a), 'choose');
  assert.ok(/id="cv-cond-0"[^>]*data-keep[^>]*data-cond-to="b"[^>]*value="大"/.test(a), '條件 0');
  assert.ok(/id="cv-cond-1"[^>]*value="打到一半"/.test(a), '輪詢讀回打到一半');
  assert.ok(a.includes('走「C」這條的條件'), '標出是哪條線');
  assert.ok(!a.includes('id="cv-merge"'), '只有一條線進來不出入口');
  const dd = ed(def.nodes.find((n) => n.id === 'd'));
  assert.ok(/<select id="cv-merge"[^>]*data-keep/.test(dd) && /<option value="any" selected>任一條到/.test(dd), '入口設定');
  assert.ok(dd.indexOf('id="cv-merge"') < dd.indexOf('<details class="cvmore"'));
  assert.ok(!dd.includes('cv-choose'));
  const plain = ed(def.nodes.find((n) => n.id === 'b'));
  assert.ok(!plain.includes('cv-choose') && !plain.includes('cv-merge') && !plain.includes('cv-cond-'), '一般卡不多欄');
  const fk = cvDefOf([cvT('a', ['F']), cvT('x', ['F']), { id: 'F', title: '並行', kind: 'fork', next: ['b', 'c'] }, cvT('b'), cvT('c')]);
  const fh = uiFn('canvasEditorHtml', l10EdCtx())(fk.nodes[2], fk);
  assert.ok(fh.includes('舊寫法') && fh.includes('data-act="cv-convert"'), '轉得過的給按鈕');
  const lb = cvDefOf([cvBr('B', [['一', 'b'], ['二', 'c']]), cvT('b'), cvT('c')]);
  const bh = uiFn('canvasEditorHtml', l10EdCtx())(lb.nodes[0], lb);
  assert.ok(bh.includes('舊寫法') && !bh.includes('cv-convert'), '轉不過的只標舊寫法');
});

test('L13 彈窗套用：cv-apply 寫回怎麼挑、每條線條件、入口（走 cvSetChoose／cvSetCond／cvSetEntry）；清單卡出口入口 chip 讀 cvModel（任一條到）', async () => {
  const src = uiSrc();
  const branch = src.slice(src.indexOf("else if (act === 'cv-apply')"), src.indexOf("else if (act === 'cv-delete')"));
  const def = cvDefOf([cvT('a', ['B']), cvBr('B', [['大', 'b'], ['', 'c']]), cvT('b', ['d']), cvT('c', ['d']), cvT('d')]);
  const vals = { 'cv-title': 'A', 'cv-instruction': 'x', 'cv-human': false, 'cv-stop': false, 'cv-choose': '看金額', 'cv-cond-0': '大於五千', 'cv-cond-1': '其他' };
  const conds = [{ dataset: { condArm: '0', condTo: 'b' }, value: '大於五千' }, { dataset: { condArm: '1', condTo: 'c' }, value: '其他' }];
  const el = (id) => (id in vals ? (typeof vals[id] === 'boolean' ? { checked: vals[id] } : { value: vals[id] }) : null);
  const state = { canvasSel: 'a', drawerOpen: true, run: null, keep: {}, mode: 'canvas' };
  const mk = (getEl, qsa) => uiCtx({ state, structuredClone, document: { getElementById: getEl, querySelectorAll: qsa }, app: { querySelectorAll: () => [] }, canvasOp: async (fn) => { fn(def); }, render: () => {} }).context;
  await vm.runInContext(`(async (act) => { if (0) {} ${branch} })`, mk(el, (s) => (s === '[data-cond-arm]' ? conds : [])))('cv-apply');
  assert.equal(def.nodes[1].instruction, '看金額');
  assert.equal(J(def.nodes[1].branches.map((b) => b.label)), J(['大於五千', '其他']));
  state.canvasSel = 'd';
  state.drawerOpen = true;
  const vd = { 'cv-title': 'D', 'cv-instruction': 'x', 'cv-human': false, 'cv-stop': false, 'cv-merge': 'any' };
  await vm.runInContext(`(async (act) => { if (0) {} ${branch} })`, mk((id) => (id in vd ? (typeof vd[id] === 'boolean' ? { checked: vd[id] } : { value: vd[id] }) : null), () => []))('cv-apply');
  assert.equal(def.nodes.find((n) => n.id === 'd').merge, 'any');
  const list = uiFn('stepListHtml', { state: { expanded: new Set(), canvasSel: null, editingParam: null } })(def);
  const dCard = list.split('<article class="step').find((x) => x.includes('data-step="d"'));
  assert.ok(dCard.includes('<span class="chip quiet">任一條到</span>'), dCard);
  const aCard = list.split('<article class="step').find((x) => x.includes('data-step="a"'));
  assert.ok(aCard.includes('<span class="chip quiet">擇一 2 條</span>'), aCard);
});

// ---------- 畫布畫面與互動＋效能（款 A） ----------
const cvSrc = () => fs.readFileSync(path.join(UI, 'canvas.js'), 'utf8');
const L14_HELP = ['雙擊空白處：新增步驟', '拖卡片：移動位置', '從圓點拉線：接到下一步', '一張卡拉出兩條以上的線：決定同時做或擇一', '點線、按 Delete：刪掉這條線', 'Ctrl+Z／Ctrl+Y：復原／重做', '滾輪＋Ctrl：縮放'];

test('L14 ①：canvasModeHtml——無頂上工具列列、無 .cvpalette、無整行長說明；.cvtools＝復原／重做／縮小・百分比・放大／全覽／整理排列／「？」；.cvhint 一行；「？」浮層款 A 七行（state.cvHelp，切換只改 hidden 不重繪）', () => {
  const BJCanvas = loadCanvas();
  BJCanvas.resetView();
  const def = cvDefOf([cvT('a', ['b']), cvT('b')]);
  const mk = (extra = {}, hist = { undo: [], redo: [{}] }) => uiFn('canvasModeHtml', { state: cvState({ wf: { category: 'c', id: 'w', def }, cvWork: null, cvShowIssues: false, cvHelp: false, keep: {}, ...extra }), structuredClone, window: { BJCanvas }, subjectDef: () => def, subjectIsDraft: () => false, cvHistoryFor: () => hist })();
  const html = mk();
  for (const gone of ['class="toolbar"', 'cvpalette', 'data-pal', '下方按鈕', '右緣圓點', 'zoomer']) assert.equal(count(html, gone), 0, `不該再有：${gone}`);
  assert.ok(html.startsWith('<div class="cvstage"><div class="cvwrap"'), '畫布直接在舞台裡');
  const tools = /<div class="cvtools" role="toolbar" aria-label="畫布工具">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const order = ['data-act="cv-undo"', 'data-act="cv-redo"', 'data-cv-zoom="out"', 'class="pct">100%<', 'data-cv-zoom="in"', 'data-cv-zoom="fit"', 'data-act="cv-tidy"', 'data-act="cv-help"'].map((s) => tools.indexOf(s));
  assert.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), `工具列順序：${order}\n${tools}`);
  assert.ok(/data-act="cv-undo"[^>]*disabled/.test(tools) && !/data-act="cv-redo"[^>]*disabled/.test(tools), '復原／重做鈕態照 cvHistory');
  assert.equal(count(tools, '<button'), 7, '七顆：復原、重做、縮小、放大、全覽、整理排列（09-18 第 5 條新增）、？');
  assert.ok(html.includes('<div class="cvhint">雙擊空白處新增步驟　·　從卡片圓點拉線到下一步</div>'), '左下一行基本提示常駐');
  const help = /<div class="cvhelp"( hidden)?><b>操作說明<\/b>([\s\S]*?)<\/div>/.exec(html);
  assert.ok(help && help[1] === ' hidden', '「？」浮層預設收著');
  assert.equal(J(help[2].split('<br>')), J(L14_HELP), '款 A 七行');
  assert.ok(/<div class="cvhelp"><b>操作說明/.test(mk({ cvHelp: true })) && mk({ cvHelp: true }).includes('aria-expanded="true"'), 'state.cvHelp 開著');
  const br = l6Br('cv-help');
  assert.ok(br.includes('state.cvHelp = !state.cvHelp;') && br.includes('hp.hidden = !state.cvHelp;') && !br.includes('render()'), `切換不整頁重繪：${br}`);
});

test('L14 ②：BJCanvas.html——卡 .node 含 STEP 序號、名稱、產出；上緣 .port.in／下緣 .port.out；擇一線虛線；出口膠囊只在 ≥2 出線、入口膠囊只在 ≥2 入線；空條件格「點此寫條件」；人做琥珀＋你來；停點小手；舊寫法', () => {
  const BJCanvas = loadCanvas();
  const cvModel = cvF('cvModel');
  const def = cvDefOf([cvT('a', ['B'], { output_type: '表格' }), cvBr('B', [['大', 'b'], ['', 'c']]), cvT('b', ['d'], { executor: 'human', handoff: '名單' }), cvT('c', ['d'], { stop_point: 'always' }), cvT('d')]);
  const seq = new Map([['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
  const html = BJCanvas.html(def, 'c', new Set(), cvModel(def), { seq });
  const a = html.slice(html.lastIndexOf('<div', html.indexOf('data-node="a"')), html.indexOf('data-node="b"'));
  assert.ok(a.startsWith('<div class="node" data-node="a"') && a.includes('STEP <span class="sq">01</span>') && a.includes('<b class="nname" title="A">A</b>') && a.includes('<div class="nout">產出：表格</div>'), `卡 a：${a}`);
  assert.ok(a.indexOf('class="port in"') < a.indexOf('class="nstep"') && a.indexOf('class="port out"') > a.indexOf('class="nout"'), '入口接點在上、出口接點在下');
  assert.ok(a.includes('data-pill="exit" data-id="a" data-mode="one"') && a.includes('>擇一<i class="ph ph-caret-down"></i></span>'), '兩條擇一線＝出口膠囊「擇一」');
  assert.equal(count(html, 'data-pill="exit"'), 1, 'b／c 只有一條出線，沒有出口膠囊');
  assert.equal(count(html, 'data-pill="entry"'), 1, '只有 d 兩條線進來');
  assert.ok(html.includes('data-pill="entry" data-id="d" data-mode="all"') && html.includes('>等全部<i'), '入口膠囊「等全部」');
  assert.equal(count(html, 'stroke-dasharray="6 5"'), 2, '擇一兩條線虛線');
  assert.ok(/<span class="cond empty" data-cond="a&gt;c&gt;1"[^>]*>點此寫條件<\/span>/.test(html) && /<span class="cond" data-cond="a&gt;b&gt;0"[^>]*>大<\/span>/.test(html), '條件格：空的琥珀提示、有字照寫');
  assert.ok(/<div class="node human" data-node="b"[\s\S]*?<span class="chip you"><i class="ph ph-user"><\/i>你來<\/span>[\s\S]*?產出：名單/.test(html), '人做卡：琥珀框 class＋你來 chip＋交出什麼');
  assert.ok(/<div class="node hold sel" data-node="c"[\s\S]*?STEP <span class="sq">03<\/span><i class="ph-fill ph-hand-palm"/.test(html), '停點小手、選中 .sel');
  const all = cvDefOf([cvT('a', ['b', 'c']), cvT('b'), cvT('c')]);
  assert.ok(BJCanvas.html(all, null, new Set(), cvModel(all)).includes('data-mode="all" title="點一下切換：同時做／擇一">同時做'), '兩條一般線＝同時做');
  const legacy = cvDefOf([cvBr('B', [['一', 'b'], ['二', 'c']]), cvT('b'), cvT('c')]);
  assert.ok(BJCanvas.html(legacy, null, new Set(), cvModel(legacy)).includes('<span class="legacytag">舊寫法</span>'), '舊寫法小圓點（題 4 A）');
  const css = cssSrc();
  for (const [sel, want] of [['.cvwrap', 'height:541px'], ['.cvwrap', 'border-radius:16px'], ['.cvwrap', '#edf1f8'], ['.node', 'width:210px'], ['.node', 'height:105px'], ['.node', 'border-radius:16px'], ['.nname', 'font-size:17px'], ['.nstep', 'letter-spacing:.12em'], ['.node .pill', 'width:80px'], ['.cond.empty', 'dashed']]) assert.ok(cssRule(sel)?.includes(want), `${sel} 該含 ${want}：${cssRule(sel)}`);
  assert.equal(count(css, '.cvpalette'), 0, '調色盤樣式退場');
});

test('L14 ③：拖拉不整頁重繪、不吸附——canvas.js 0 命中 snap(／app.js 0 命中 gsnap；redrawEdges 查索引不 querySelector；pointermove 以 requestAnimationFrame 合批；拉線不 querySelectorAll(\'.droptgt\')；cvHandlers.onMove 走 canvasCommit＋只補畫面（vm：render 0 次）', () => {
  const cv = cvSrc();
  assert.equal(count(cv, 'snap('), 0, 'canvas.js 不吸附');
  assert.equal(count(uiSrc(), 'gsnap'), 0, 'app.js 不吸附');
  const redraw = /function redrawEdges\([\s\S]*?\n {2}\}\n/.exec(cv)?.[0] ?? '';
  assert.ok(redraw.includes('last.byNode.get(id)') && !redraw.includes('querySelector'), `redrawEdges：${redraw}`);
  const pm = cv.slice(cv.indexOf("wrap.addEventListener('pointermove'"), cv.indexOf('const end = '));
  assert.ok(pm.includes('requestAnimationFrame(frame)') && !pm.includes('redrawEdges'), `pointermove 只記座標、一幀處理一次：${pm}`);
  assert.equal(count(cv, "querySelectorAll('.droptgt')"), 0, '拉線只記上一個高亮目標');
  assert.ok(cv.includes('moveProxy(d.proxy, nx, ny);') && cv.includes('d.el.style.left = `${p.x}px`; d.el.style.top = `${p.y}px`;') && count(cv, 'd.el.style.transform') === 0, '拖卡中只動上層 SVG 替身的座標（不動 HTML 卡）、放開才寫 left/top');
  const mp = /function moveProxy\([\s\S]*?\}\n/.exec(cv)?.[0] ?? '';
  assert.ok(mp.includes('setAttribute(ax, x + dx)') && !mp.includes('transform'), `替身只改座標屬性：${mp}`);
  // vm：搬卡＝只改座標（不重畫畫布、不整頁重繪）；接線＝結構改動，只換 .cvwrap 裡有變的
  const def = cvDefOf([cvT('a', ['b']), cvT('b'), cvT('c')]);
  const state = cvState({ wf: { category: 'c', id: 'w', def }, cvWork: null, cvDirty: false, keep: {}, cvShowIssues: false });
  const calls = { render: 0, update: 0, adopt: null };
  const BJCanvas = { shown: () => ({ a: { x: 1, y: 2 }, b: { x: 3, y: 4 }, c: { x: 5, y: 6 } }), adopt: (d) => { calls.adopt = d; }, update: () => { calls.update++; return true; }, view: () => ({ z: 1 }), layout: loadCanvas().layout };
  const { context } = uiCtx({ state, structuredClone, window: { BJCanvas, alert: () => {} }, app: { querySelector: (s) => (s === '.cvwrap' ? {} : null) }, subjectDef: () => def, subjectIsDraft: () => false, render: () => { calls.render++; } });
  const h = vm.runInContext('cvHandlers', context);
  h.onMove('a', 50, 60);
  assert.equal(calls.render, 0, '放開不整頁重繪');
  assert.equal(calls.update, 0, '只搬位置：畫布本來就畫好了');
  assert.equal(calls.adopt, state.cvWork, '快照認新的工作本');
  assert.equal(J(state.cvWork.canvas.positions.a), J({ x: 50, y: 60 }));
  assert.equal(J(state.cvWork.canvas.positions.b), J({ x: 3, y: 4 }), '別張照畫面上的位置');
  assert.equal(state.cvWork.canvas.layout, 'tb');
  assert.equal(state.cvDirty, true);
  h.onConnect('a', 'c');
  assert.equal(calls.render, 0, '接線也不整頁重繪');
  assert.equal(calls.update, 1, '接線只補畫布');
  assert.equal(J(state.cvWork.nodes[0].next), J(['b', 'c']));
  assert.equal(vm.runInContext('cvHistory', context).undo.length, 2, '兩次改動都進復原');
});

test('L14 ④：打開畫布＝100%、不 fit——resetView 後 bind：z＝1、第一列水平置中、上緣留 24px；換 Workflow 才重設視角', () => {
  const BJCanvas = loadCanvas();
  const cvModel = cvF('cvModel');
  const def = cvDefOf([cvT('a', ['b', 'c']), cvT('b'), cvT('c')]);
  BJCanvas.resetView();
  BJCanvas.html(def, null, new Set(), cvModel(def));
  const L = BJCanvas.layout(cvModel(def), def.canvas);
  const fake = (extra = {}) => ({ style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, ...extra });
  const parts = { '.cv-inner': fake({ querySelector: () => null }), '.cvscroll': fake(), '.cvspace': fake(), '.edgetools': fake(), '.pct': fake() };
  parts['.cv-inner'].querySelector = (s) => (s === 'g.edges' || s === '.cvnodes' || s === '.cvconds' || s === 'g.liveedges' ? fake() : s === '.ghost' ? fake() : s === 'svg.wire' ? fake() : null);
  const wrap = fake({ clientWidth: 900, clientHeight: 541, dataset: { cvw: String(L.width), cvh: String(L.height) }, querySelector: (s) => parts[s] ?? null });
  BJCanvas.bind(wrap, {});
  const v = BJCanvas.view();
  assert.equal(v.z, 1, '100%');
  assert.equal(v.home, false);
  const top = L.pos.get('a');
  assert.equal(v.px, Math.round(900 / 2 - (top.x + 105)), '第一列（a）水平置中');
  assert.equal(v.py, 24 - top.y, '上緣留 24px');
  assert.equal(parts['.pct'].textContent, '100%');
  const cv = cvSrc();
  assert.ok(cv.includes('if (view.home) { if (home(wrap)) view.home = false; } else apply(wrap);') && count(cv, 'fitPending') === 0, '打開走 home 不走 fit');
  assert.equal(count(/function bind\([\s\S]*?const tools = /.exec(cv)?.[0] ?? 'fit(', 'fit('), 0, '綁定時不 fit（全覽鈕才 fit）');
  const ow = /async function openWorkflow\([\s\S]*?\n\}\n/.exec(uiSrc())[0];
  assert.ok(ow.includes('window.BJCanvas.resetView();'), '換 Workflow 重設視角');
});

test('L14 ⑤：擇一條件格點改——cvCondStart 記 state.cvCondEdit、清暫存字、補畫面並聚焦；輸入框 data-keep（打到一半輪詢讀回）；Enter 呼叫 cvSetCond 存、Esc 放棄；app keydown 接上', () => {
  const BJCanvas = loadCanvas();
  const cvModel = cvF('cvModel');
  const def = cvDefOf([cvT('a', ['B']), cvBr('B', [['', 'b'], ['大', 'c']]), cvT('b'), cvT('c')]);
  const state = cvState({ keep: { '-:cvcond-edit': '舊字' }, cvCondIssues: [{ from: 'a', to: 'b', arm: 0 }] });
  const calls = { refresh: 0, focus: 0, edit: 0 };
  const ed = { focus: () => { calls.focus++; }, select() {} };
  const ctx = { state, structuredClone, cvRefresh: () => { calls.refresh++; }, document: { getElementById: (id) => (id === 'cvcond-edit' ? ed : null) }, cvEdit: (fn) => { calls.edit++; fn(def); } };
  const { context } = uiCtx(ctx);
  vm.runInContext('cvCondStart', context)({ from: 'a', to: 'b', arm: 0, dashed: true });
  assert.equal(J(state.cvCondEdit), J({ from: 'a', to: 'b', arm: 0 }));
  assert.ok(!('-:cvcond-edit' in state.keep) && calls.refresh === 1 && calls.focus === 1, '清暫存字、補畫面、聚焦');
  // 畫面：正在寫的那格變輸入框，打到一半的字（kept）讀回
  state.keep['-:cvcond-edit'] = '打到一半';
  const opts = uiFn('cvCanvasOpts', { state, stepSeqMap: () => new Map(), cvChromeHtml: () => '' })(def);
  const html = BJCanvas.html(def, null, new Set(), cvModel(def), opts);
  assert.ok(/<input id="cvcond-edit" class="cond editing" data-cond="a&gt;b&gt;0"[^>]* data-keep [^>]*value="打到一半"/.test(html), `輸入框：${html.slice(html.indexOf('cvconds'), html.indexOf('cvconds') + 400)}`);
  // Enter＝存（cvSetCond）、清掉這條的空條件標記
  const key = (k, value) => { let prevented = false; vm.runInContext('cvCondKey', context)({ key: k, isComposing: false, target: { value }, preventDefault: () => { prevented = true; } }); return prevented; };
  assert.ok(key('Enter', '金額小於五千'));
  assert.equal(def.nodes[1].branches[0].label, '金額小於五千', 'Enter 走 cvSetCond 寫回');
  assert.equal(state.cvCondEdit, null);
  assert.equal(J(state.cvCondIssues), '[]', '寫好的那條不再亮');
  // Esc＝放棄
  vm.runInContext('cvCondStart', context)({ from: 'a', to: 'c', arm: 1 });
  const before = calls.edit;
  assert.ok(key('Escape', '不要了'));
  assert.equal(calls.edit, before, 'Esc 不寫回');
  assert.equal(state.cvCondEdit, null);
  assert.equal(def.nodes[1].branches[1].label, '大');
  const src = uiSrc();
  assert.ok(src.includes("if (e.target.id === 'cvcond-edit') cvCondKey(e);"), 'app keydown 接條件格');
  assert.ok(src.includes("if (e.target.id === 'cvcond-edit' && state.cvCondEdit && !rendering) cvCondFinish(e.target.value, true);"), '點到別處＝存（重繪拔掉的不算）');
  assert.ok(/onCond: \(edge\) => cvCondStart\(edge\)/.test(src), 'canvas.js 點條件格 → cvCondStart');
});

test('L14 ⑥：單擊卡只換 .sel 與右欄（不整頁重繪）——canvas.js 放開沒拖動＝onSelect；cvSelect 叫 BJCanvas.select＋右欄 outerHTML；app.js 不再用 cvDownNode 與 click 選卡', () => {
  const calls = { render: 0, select: null };
  const box = { outerHTML: '' };
  const state = cvState({ canvasSel: 'a' });
  uiFn('cvSelect', { state, window: { BJCanvas: { select: (id) => { calls.select = id; } } }, app: { querySelector: (s) => (s === '.work .right' ? box : null) }, inspectorHtml: () => 'INSP:b', render: () => { calls.render++; } })('b');
  assert.equal(state.canvasSel, 'b');
  assert.equal(calls.select, 'b');
  assert.equal(box.outerHTML, 'INSP:b', '右欄換成選中那一步');
  assert.equal(calls.render, 0, '不整頁重繪');
  const cv = cvSrc();
  assert.ok(cv.includes('if (!d.moved) { if (!cancel) handlers.onSelect?.(d.id); return; }'), 'canvas.js：按下沒拖動＝選卡');
  const src = uiSrc();
  assert.ok(/onSelect: \(id\) => cvSelect\(id\)/.test(src), 'cvHandlers.onSelect');
  assert.equal(count(src, 'cvDownNode'), 0, 'pointer capture 補丁退場');
  assert.equal(count(src, "const nodeEl = e.target.closest('[data-node]')"), 0, 'click 不再整頁重繪選卡');
  // canvas.js select 只換 class
  const sel = /function select\(id\) \{[\s\S]*?\n {2}\}\n/.exec(cv)[0];
  assert.ok(sel.includes("classList.remove('sel')") && sel.includes("classList.add('sel')") && !sel.includes('innerHTML'), sel);
});

test('L14 ⑦：點線選取後按 Delete＝剪線——cvKeyDelete 剪 state.cvEdgeSel（走 cvCut，擇一剪到剩一條拆分岔）；沒選線／打字中／別的鍵不動；快捷鍵排在彈窗開著那行之後', () => {
  const def = cvDefOf([cvT('a', ['B']), cvBr('B', [['大', 'b'], ['小', 'c']]), cvT('b'), cvT('c')]);
  const state = cvState({ cvEdgeSel: { from: 'a', to: 'c', arm: 1 } });
  const { context } = uiCtx({ state, structuredClone, cvEdit: (fn) => fn(def) });
  const del = vm.runInContext('cvKeyDelete', context);
  const ev = (key, typing = false) => ({ key, target: { matches: () => typing }, preventDefault() {} });
  assert.equal(del(ev('Backspace')), false, '別的鍵不動');
  assert.equal(del(ev('Delete', true)), false, '打字中不動');
  assert.equal(state.cvEdgeSel !== null, true);
  assert.equal(del(ev('Delete')), true);
  assert.equal(state.cvEdgeSel, null);
  assert.ok(!def.nodes.some((n) => n.id === 'B') && J(def.nodes[0].next) === J(['b']), `擇一剪到剩一條＝拆掉分岔、直接接 b：${J(def.nodes)}`);
  assert.equal(del(ev('Delete')), false, '沒選線不動');
  // 點線選取
  let picked = null;
  const st2 = cvState({});
  uiFn('cvEdgeSelect', { state: st2, window: { BJCanvas: { selectEdge: (e) => { picked = e; } } } })({ from: 'a', to: 'b', dashed: true, cond: 'x' });
  assert.equal(J(st2.cvEdgeSel), J({ from: 'a', to: 'b', arm: null }));
  assert.equal(J(picked), J(st2.cvEdgeSel));
  const src = uiSrc();
  const kd = src.slice(src.indexOf("if (document.querySelector('.stepmodal')) return; // 彈窗開著"), src.indexOf("if (!(e.ctrlKey || e.metaKey)) return;"));
  assert.ok(kd.includes('if (cvKeyDelete(e)) return;'), `Delete 在彈窗那行之後、Ctrl 判斷之前：${kd}`);
  const cv = cvSrc();
  assert.ok(cv.includes('handlers.onEdgeSel?.(last.edgeByKey.get(hit))') && /onEdgeSel: \(edge\) => cvEdgeSelect\(edge\)/.test(src), '點線 → 選取');
  assert.ok(cv.includes("handlers.onCut?.(edge)") && cv.includes("handlers.onInsert?.(edge"), '線上滑過的插入一步／剪線照留（W9）');
});

//（與 tools/canvas-perf.mjs 的 GATE 同一張表；x4 主判準）
const L14_GATE = {
  4: { moveMs: 6, handlerP95: 2, longTasks: 0, frameMax: 50, rafP95: 16.7, renders: 0, releaseMs: 60, jumpPx: 1, openMs: 233 },
  1: { moveMs: 2, handlerP95: 0.5, longTasks: 0, frameMax: 20, rafP95: 16.7, renders: 0, releaseMs: 25, jumpPx: 1, openMs: 50 },
};
test('L14 ⑧：canvas-perf 全表達標——w200 與 w200c、x1 與 x4、25／100／200％、拖卡片／拉線／平移，每格照契約 I 門檻逐項重算（結果 JSON 在 reviews/排版輪-實走-2026-09-17/perf/L14-*.json）', () => {
  const dir = path.join(UI, '..', '..', 'reviews', '排版輪-實走-2026-09-17', 'perf');
  for (const wf of ['w200', 'w200c']) {
    for (const th of [1, 4]) {
      const f = path.join(dir, `L14-${wf}-x${th}.json`);
      assert.ok(fs.existsSync(f), `缺 ${f}`);
      const r = JSON.parse(fs.readFileSync(f, 'utf8'));
      const g = L14_GATE[th];
      const at = `${wf} x${th}`;
      assert.equal(r.throttle, th, at);
      assert.equal(r.workflow, `效能/${wf}`, at);
      assert.equal(J(r.missing), '[]', `${at} 沒量到的手勢`);
      assert.ok(r.open.toPaintMs <= g.openMs, `${at} 打開到畫出 ${r.open.toPaintMs}`);
      assert.equal(J(r.zooms.map((z) => z.target)), J([25, 100, 200]), at);
      for (const z of r.zooms) {
        assert.equal(J(z.actions.map((x) => x.name)), J(['拖卡片', '拉線', '平移']), `${at} ${z.target}%`);
        for (const x of z.actions) {
          const w = `${at} ${z.target}% ${x.name}`;
          assert.ok(x.moves >= 55, `${w} 移動次數 ${x.moves}`);
          assert.ok(x.mainThreadPerMoveMs.task <= g.moveMs, `${w} 每次移動主執行緒 ${x.mainThreadPerMoveMs.task}`);
          assert.ok(x.moveHandlerMs.p95 <= g.handlerP95, `${w} pointermove p95 ${x.moveHandlerMs.p95}`);
          assert.ok(x.longTasks.count <= g.longTasks, `${w} 長任務 ${x.longTasks.count}`);
          assert.ok(x.frameIntervalMs.max <= g.frameMax, `${w} 最大幀間隔 ${x.frameIntervalMs.max}`);
          assert.ok(x.frameIntervalMs.p95 <= g.rafP95, `${w} rAF p95 ${x.frameIntervalMs.p95}`);
          assert.ok(x.fullRenders.count <= g.renders, `${w} 整頁 render ${x.fullRenders.count}`);
          assert.ok(x.release.taskMs <= g.releaseMs, `${w} 放開後 1.5 秒 ${x.release.taskMs}`);
          if (x.name === '拖卡片') assert.ok(x.release.jumpPx !== null && x.release.jumpPx <= g.jumpPx, `${w} 跳位 ${x.release.jumpPx}`);
        }
      }
      assert.equal(r.gate?.pass, true, `${at} 工具自評 gate：${J(r.gate?.fails)}`);
    }
  }
});

// ---------- L14 自報的四項畫布遺留（序號跳號、列距、線穿卡／條件格壓卡、健檢回應平方成長） ----------
// SVG 路徑（M／C／L）取樣成點；卡片矩形；兩矩形相交
const l14bPathPts = (d) => {
  const tk = d.match(/[MCL]|-?\d+(?:\.\d+)?/g);
  const pts = [];
  let cur = null;
  let i = 0;
  const num = () => Number(tk[i++]);
  while (i < tk.length) {
    const c = tk[i++];
    if (c === 'M') { cur = [num(), num()]; pts.push(cur); } else if (c === 'L') {
      const nx = [num(), num()];
      for (let s = 1; s <= 10; s++) pts.push([cur[0] + ((nx[0] - cur[0]) * s) / 10, cur[1] + ((nx[1] - cur[1]) * s) / 10]);
      cur = nx;
    } else if (c === 'C') {
      const p1 = [num(), num()]; const p2 = [num(), num()]; const p3 = [num(), num()];
      for (let s = 1; s <= 20; s++) {
        const t = s / 20; const m = 1 - t;
        const f = (k) => m * m * m * cur[k] + 3 * m * m * t * p1[k] + 3 * m * t * t * p2[k] + t * t * t * p3[k];
        pts.push([f(0), f(1)]);
      }
      cur = p3;
    }
  }
  return pts;
};
const l14bRects = (L) => [...L.pos].map(([id, p]) => ({ id, x: p.x, y: p.y, w: L.sz.get(id).w, h: L.sz.get(id).h }));
const l14bHit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const l14bUnesc = (s) => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
// 畫出來的線不穿過兩端以外的卡、條件格不壓任何卡、條件格彼此不疊
function l14bCheckGeometry(def, name) {
  const BJCanvas = loadCanvas();
  const model = cvF('cvModel')(def);
  const L = BJCanvas.layout(model, def.canvas);
  const html = BJCanvas.html(def, null, new Set(), model, {});
  const rects = l14bRects(L);
  let lines = 0;
  for (const m of html.matchAll(/<g data-k="([^"]*)"[^>]*><path class="ln" d="([^"]*)"/g)) {
    const [from, to] = l14bUnesc(m[1]).split('>');
    lines++;
    for (const [x, y] of l14bPathPts(m[2])) {
      for (const r of rects) {
        if (r.id === from || r.id === to) continue;
        assert.ok(!(x > r.x + 1 && x < r.x + r.w - 1 && y > r.y + 1 && y < r.y + r.h - 1), `${name}：線 ${from}→${to} 從卡 ${r.id} 下面穿過（${Math.round(x)},${Math.round(y)}）`);
      }
    }
  }
  assert.equal(lines, L.edges.length, `${name}：每條線都有畫`);
  const conds = [...html.matchAll(/<span class="cond[^"]*" data-cond="([^"]*)" data-w="(\d+)" style="left:(-?[\d.]+)px;top:(-?[\d.]+)px;width:(\d+)px"/g)]
    .map((m) => ({ k: l14bUnesc(m[1]), x: Number(m[3]), y: Number(m[4]), w: Number(m[5]), h: 24 }));
  for (const c of conds) for (const r of rects) assert.ok(!l14bHit(c, r), `${name}：條件格 ${c.k} 壓在卡 ${r.id} 上 ${J(c)} ${J(r)}`);
  for (const a of conds) for (const b of conds) if (a !== b) assert.ok(!l14bHit(a, b), `${name}：條件格 ${a.k} 與 ${b.k} 疊在一起`);
  return { L, html, conds };
}

test('L14b ①：STEP 序號只數看得到的步驟卡——藏起來的擇一分岔不佔號；畫布、右欄、清單、執行頁左軌同一套號碼', () => {
  const BJCanvas = loadCanvas();
  const def = cvDefOf([cvT('a', ['B']), cvBr('B', [['大', 'b'], ['小', 'c']]), cvT('b', ['d']), cvT('c', ['d']), cvT('d')]);
  const seqOf = uiFn('stepSeqMap', { state: cvState() });
  assert.equal(J([...seqOf(def)]), J([['a', 1], ['b', 2], ['c', 3], ['d', 4]]), '藏起來的分岔 B 不佔號');
  const legacy = cvDefOf([cvBr('B', [['一', 'b'], ['二', 'c']]), cvT('b'), cvT('c')]);
  assert.equal(J([...seqOf(legacy)]), J([['B', 1], ['b', 2], ['c', 3]]), '畫面上看得到的舊寫法分岔照樣佔號');
  assert.equal(J([...seqOf(DAG_DEF)]), J([['fill', 1], ['boss-sign', 2], ['scan', 3], ['mail', 4]]), '報帳 DAG：01 之後是 02，不跳 03');
  // 畫布：卡上 STEP 連號
  const html = BJCanvas.html(def, null, new Set(), cvF('cvModel')(def), { seq: seqOf(def) });
  const steps = [...html.matchAll(/STEP <span class="sq">(\d+)<\/span>/g)].map((m) => m[1]).sort();
  assert.equal(J(steps), J(['01', '02', '03', '04']), `畫布序號：${steps}`);
  // 清單：同一套號碼；藏起來的分岔不印 00
  const list = uiFn('stepListHtml', { state: cvState() })(def);
  const nums = [...list.matchAll(/<span class="num">([^<]*)<\/span><h3>([^<]*)<\/h3>/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.equal(J(nums), J(['01 A', '02 B', '03 C', '04 D']), `清單序號：${nums}`);
  assert.ok(!list.includes('>00<'), '清單不出現 00');
  // 右欄檢視器
  const insp = uiFn('inspectorStepHtml', { state: cvState({ canvasSel: 'c' }), preflightFor: () => null, drawerMemoryHtml: () => '' })(def);
  assert.ok(insp.includes('STEP 03</span>'), `右欄：${insp.slice(0, 120)}`);
  // 執行頁：左軌與中欄 STEP 同一套號碼；藏起來的分岔中欄標它那張卡的號碼
  const run = { def, steps: { a: { status: 'done' }, B: { status: 'done' }, b: { status: 'running' } }, status: 'running' };
  const stepSeqOf = uiFn('stepSeqOf', { state: cvState() });
  assert.equal(stepSeqOf(run, def.nodes[2]), 2, 'b＝2');
  assert.equal(stepSeqOf(run, def.nodes[4]), 4, 'd＝4');
  assert.equal(stepSeqOf(run, def.nodes[1]), 1, '藏起來的分岔＝它那張卡 a 的號碼');
  const rail = uiFn('progressRailHtml', { state: cvState({ runInspect: null }) })(run);
  const railNums = [...rail.matchAll(/<span class="n">([^<]*)<\/span><span class="t">([^<]*)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`).filter((s) => /^\d/.test(s));
  assert.equal(J(railNums), J(['2 B', '3 C', '4 D']), `左軌還沒做完的步驟號碼：${rail}`);
});

test('L14b ②：列距依膠囊／條件格動態加大——沒有膠囊維持 155；出口膠囊＋27、入口膠囊＋28、擇一條件格再＋60（約款 A 240）；條件格不再壓到 116px；存過的座標不動', () => {
  const BJCanvas = loadCanvas();
  const cvModel = cvF('cvModel');
  const lay = (def, canvas = def.canvas) => BJCanvas.layout(cvModel(def), canvas).pos;
  const chain = cvDefOf([cvT('a', ['b']), cvT('b', ['c']), cvT('c')]);
  const pc = lay(chain);
  assert.equal(pc.get('b').y - pc.get('a').y, 155, '一路直下維持緊湊');
  assert.equal(pc.get('c').y - pc.get('b').y, 155);
  const br = cvDefOf([cvT('a', ['B']), cvBr('B', [['金額超過五千元而且要主管簽核', 'b'], ['其他', 'c']]), cvT('b', ['d']), cvT('c', ['d']), cvT('d')]);
  const pb = lay(br);
  assert.equal(pb.get('b').y - pb.get('a').y, 242, '擇一：出口膠囊＋條件格');
  assert.equal(pb.get('d').y - pb.get('b').y, 183, '會合：入口膠囊');
  const { conds } = l14bCheckGeometry(br, '擇一兩條');
  assert.equal(conds.length, 2);
  assert.ok(conds.some((c) => c.w > 116), `長條件不再被壓到 116：${J(conds)}`);
  const kept = lay(br, { layout: 'tb', positions: { a: { x: 7, y: 9 }, b: { x: 300, y: 164 } } });
  assert.equal(J(kept.get('a')), J({ x: 7, y: 9 }), '拖過的位置不動');
  assert.equal(J(kept.get('b')), J({ x: 300, y: 164 }));
  assert.equal(J(kept.get('c')), J(pb.get('c')), '沒存的照自動排');
});

test('L14b ③：自動排版同層排序＋跨列的線讓出通道——報帳 DAG 的「五千以下」不再從主管簽核卡下穿過、條件格不壓卡；跨兩列的線與同時做的組合同樣不穿卡', () => {
  const dag = l14bCheckGeometry(structuredClone(DAG_DEF), '報帳 DAG');
  const p = dag.L.pos;
  assert.ok(p.get('boss-sign').y > p.get('fill').y && p.get('par').y > p.get('boss-sign').y, '由上往下三列');
  const skip = cvDefOf([cvT('a', ['b', 'd']), cvT('b', ['c']), cvT('c', ['d']), cvT('d')]);
  l14bCheckGeometry(skip, '跨兩列的線');
  const skipBr = cvDefOf([cvT('a', ['B']), cvBr('B', [['長', 'b'], ['短', 'd']]), cvT('b', ['c']), cvT('c', ['d']), cvT('d')]);
  l14bCheckGeometry(skipBr, '擇一跨兩列');
  // 同層排序：下層照上層位置排，兩組交叉的線理順
  const cross = cvDefOf([cvT('r', ['p', 'q']), cvT('p', ['y']), cvT('q', ['x']), cvT('x'), cvT('y')]);
  const pc = l14bCheckGeometry(cross, '交叉').L.pos;
  assert.ok(pc.get('y').x < pc.get('x').x, 'p 在左→y 在左');
});

test('L14b ④：健檢回應的輸入來源不重複傳（src/preflight packInputs）——前端 pfInputs 展開後與 inputSources 逐項相同；三處顯示都走 pfInputs；/api/preflight 回 packInputs；連續編排延後維持 2 秒', () => {
  const pfInputs = uiFn('pfInputs', { state: cvState() });
  const human = { format: 1, name: '任一條到', params: [{ key: 'k', label: '期間', default: 'Q3' }, { key: 'up', label: '原始資料', default: '', input: 'file' }], nodes: [
    { id: 'h', title: '人工整理', executor: 'human', stop_point: 'never', instruction: '整理', handoff: '整理表', next: ['a', 'b'] },
    { id: 'a', title: '起頭', executor: 'ai', stop_point: 'never', instruction: '起 {{k}}', attachments: ['範本.docx', { scope: 'company', name: '規範.pdf' }], next: ['c'] },
    { id: 'b', title: '快的', executor: 'ai', stop_point: 'never', instruction: '快', next: ['c'] },
    { id: 'c', title: '會合', executor: 'ai', stop_point: 'never', instruction: '依上一步合', next: [], merge: 'any' },
  ] };
  for (const [name, def] of Object.entries({ dag: DAG_DEF, par: PAR_DEF, human })) {
    const full = inputSources(def);
    const packed = JSON.parse(J(packInputs(def)));
    assert.equal(J(Object.keys(packed.at).sort()), J(Object.keys(full).sort()), `${name} 步驟`);
    for (const id of Object.keys(full)) assert.equal(J(pfInputs({ inputs: packed }, id)), J(full[id]), `${name} ${id}`);
  }
  assert.equal(J(pfInputs(null, 'x')), '[]');
  assert.equal(J(pfInputs({ inputs: packInputs(DAG_DEF) }, 'nope')), '[]');
  const src = uiSrc();
  assert.equal(count(src, 'pf.inputs?.['), 0, '不再直接讀 inputs[步驟]');
  assert.equal(count(src, 'pfInputs(pf, n.id)'), 2, '檢視器與彈窗');
  assert.equal(count(src, 'pfInputs(pf, node.id)'), 1, '執行頁右欄');
  const server = fs.readFileSync(path.join(UI, '..', 'src', 'server.js'), 'utf8');
  assert.ok(server.includes('inputs: packInputs(body.def)'), '/api/preflight 回不重複的寫法');
  const q = /const CV_PF_QUIET = (\d+);/.exec(src);
  assert.ok(q && Number(q[1]) === 2000, `連續編排延後維持 2 秒（縮短實測讓拉線放開後變慢，見 L14b 留證）：${q?.[1]}`);
});

test('L15 ①：中文字不從網路載字型——index.html 只向 Google Fonts 要 Geist Mono；--font 以 Segoe UI／微軟正黑體為首、Mac 退 PingFang TC，字型鏈不再列 Noto Sans TC（L14 覆核：全新裝置第一次拉線長新卡觸發 Noto 網路子集載入→多一次整頁重排；L15 實測只拿掉網路載入、名字留在鏈上時，本機查無此字型反讓長新卡排版慢 7ms）', () => {
  const index = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  assert.equal(count(index, 'Noto+Sans+TC'), 0, '不載 Noto Sans TC 網路字型');
  assert.ok(/fonts\.googleapis\.com\/css2\?family=Geist\+Mono:wght@400;600&display=swap"/.test(index), 'Geist Mono 照載（數字／代碼）');
  const font = cssVar('--font');
  assert.ok(font?.startsWith('"Segoe UI","Microsoft JhengHei",') && font.includes('"PingFang TC"') && !font.includes('Noto'), `--font 後備鏈：${font}`);
});

test('L15 ②：沒人用的 CSS 清掉——.crs*（L5 儀表板改 .panel 後無引用）、.sharedrow .wfdel2（共用檔浮窗列沒有刪除鈕）；.refrow .wfdel2 仍在用、.homeaside .asideblock.panel-blue 被 P5 ② 釘住保留', () => {
  const css = cssSrc();
  assert.equal((css.match(/^\s*\.crs[\s{.:]/gm) ?? []).length, 0, '.crs 規則全數退場');
  assert.equal(cssRule('.sharedrow .wfdel2'), null, '.sharedrow .wfdel2 退場');
  assert.equal(cssRule('.sharedrow .wfdel2:hover'), null, '.sharedrow .wfdel2:hover 退場');
  assert.ok(cssRule('.refrow .wfdel2'), '.refrow .wfdel2 參考檔刪除鈕仍在用');
  const src = uiSrc();
  assert.equal(count(src, 'crs'), 0, 'app.js 沒有 crs');
  assert.ok(src.includes('wfdel2') && !/sharedrow[^\n]*wfdel2/.test(src), 'wfdel2 只在參考檔列');
});

// ---------- F1（09-18 驗收退件）：第 5 條「整理排列」入口、第 12 條 點步驟卡就顯示內容 ----------
test('F1 ①：畫布工具列「整理排列」——小圖標＋tooltip；cvTidy 先問一次，按確定才照自動排版重排（拖過的座標全部蓋掉、用 L13／L14b 的排法）、進工作本標「有改動未存」、cvHistory 留得住可 Ctrl+Z；按取消什麼都不動', () => {
  const BJCanvas = loadCanvas();
  BJCanvas.resetView();
  const html = uiFn('cvChromeHtml', { state: cvState({ cvHelp: false }), window: { BJCanvas }, cvHistoryFor: () => ({ undo: [], redo: [] }) })();
  const btn = /<button class="cvtool" data-act="cv-tidy"[^>]*>(<i[^>]*><\/i>)<\/button>/.exec(html);
  assert.ok(btn, `工具列有「整理排列」：${html}`);
  assert.ok(btn[0].includes('title="整理排列：') && btn[0].includes('aria-label="整理排列"') && btn[1].includes('class="ph '), `款 A 小圖標＋tooltip、不放字：${btn[0]}`);
  assert.ok(l6Br('cv-tidy').includes('cvTidy();'), '事件委派接到 cvTidy');

  const def = cvDefOf([cvT('a', ['b', 'c']), cvT('b', ['d']), cvT('c', ['d']), cvT('d')]);
  def.canvas = { layout: 'tb', positions: { a: { x: 900, y: 900 }, b: { x: 10, y: 20 }, c: { x: 30, y: 40 }, d: { x: 50, y: 60 } } };
  const state = cvState({ wf: { category: 'c', id: 'w', def }, cvWork: null, cvDirty: false });
  const asks = [];
  let yes = false;
  let refreshed = 0;
  const { context } = uiCtx({ state, structuredClone, window: { BJCanvas, confirm: (m) => { asks.push(m); return yes; }, alert: () => {} }, subjectIsDraft: () => false, subjectDef: () => def, cvRefresh: () => { refreshed++; }, render: () => {}, saveDef: async () => { throw new Error('整理排列不該直接存檔'); } });
  const cvTidy = vm.runInContext('cvTidy', context);
  const cvModel = vm.runInContext('cvModel', context);
  cvTidy();
  assert.equal(asks.length, 1, '動手前問一次');
  assert.ok(asks[0].includes('會被蓋掉') && asks[0].includes('Ctrl+Z'), `講清楚代價與退路：${asks[0]}`);
  assert.equal(state.cvWork, null, '按取消＝工作本不動');
  assert.equal(state.cvDirty, false, '按取消＝不標未存');
  assert.equal(refreshed, 0, '按取消＝畫面不動');
  yes = true;
  cvTidy();
  const auto = BJCanvas.layout(cvModel(def), null).pos; // 不帶 canvas＝純自動排版
  assert.equal(state.cvWork.canvas.layout, 'tb');
  assert.equal(J(Object.keys(state.cvWork.canvas.positions).sort()), J(['a', 'b', 'c', 'd']), '只留卡片座標');
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(J(state.cvWork.canvas.positions[id]), J({ x: auto.get(id).x, y: auto.get(id).y }), `${id} 照自動排版重排`);
  assert.notEqual(state.cvWork.canvas.positions.a.x, 900, '自己拖過的位置被蓋掉');
  assert.equal(state.cvDirty, true, '標「有改動未存」——按存檔才寫回');
  assert.equal(refreshed, 1, '只補畫面，不整頁重繪');
  const h = vm.runInContext('cvHistoryFor', context)();
  assert.equal(h.undo.length, 1, '進 cvHistory');
  assert.equal(J(h.undo[0].canvas.positions.a), J({ x: 900, y: 900 }), 'Ctrl+Z 回得去原本拖的位置');
});

test('F1 ②：清單步驟卡——「查看」鈕退場、整張卡就是 step-pick（右欄檢視器換這一步）；tabindex／role 讓 Enter 與空白鍵同效、data-id 讓重繪後焦點回同一張；卡上「編輯」只開編輯（事件取最內層 data-act）；選中樣式照現行淡藍底藍邊，可點卡有手指游標與聚焦外框', () => {
  const src = uiSrc();
  const def = { params: [], nodes: [{ id: 'a', title: '收集', executor: 'ai', instruction: '整理', next: [] }] };
  const html = uiFn('stepListHtml', { state: { expanded: new Set(), canvasSel: null, editingParam: null } })(def);
  assert.equal(count(html, '>查看</button>'), 0, '「查看」鈕退場（驗收第 12 條）');
  assert.equal(count(html, 'data-act="step-pick"'), 1, '一張卡只有一個 step-pick——就是卡片本身');
  assert.ok(html.startsWith('<article class="step" data-step="a" data-act="step-pick" data-node="a" data-id="a" tabindex="0" role="button">'), `整張卡可點可聚焦：${html.slice(0, 160)}`);
  assert.ok(html.indexOf('data-act="edit-step"') > html.indexOf('data-act="step-pick"'), '「編輯」在卡片裡面');
  assert.ok(src.includes("const el = e.target.closest('[data-act]');"), '事件委派取最內層的 data-act＝點「編輯」不會連帶觸發選取');
  const pick = l6Br('step-pick');
  assert.ok(pick.includes('state.canvasSel = el.dataset.node;') && pick.includes("state.inspectorTab = 'step';") && !pick.includes('drawerOpen'), `點卡＝選取＋右欄步驟頁（不開編輯彈窗）：${pick}`);
  const ka = /function keyActivate\(e\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.ok(ka.includes("(e.key !== 'Enter' && e.key !== ' ')") && ka.includes('[data-act][tabindex]') && ka.includes('t.click();'), 'Enter／空白鍵＝點一下');
  assert.ok(ka.includes('x.dataset.cat === d.cat && x.dataset.id === d.id'), '重繪後焦點靠 data-id 回到同一張卡');
  const css = cssSrc();
  assert.equal(cssRule('article.step.sel'), 'background:#f5f7ff;border-color:#7389d5;box-shadow:0 0 0 1px #445bc416;outline:0', '選中樣式照現行（淡藍底＋藍邊）');
  assert.ok(css.includes('\narticle.step[data-act]{cursor:pointer}'), '可點的卡有手指游標');
  assert.ok(css.includes('\narticle.step[data-act]:not(.sel):hover{'), '滑過變色要讓開選中的藍邊（實走抓到：:hover 比 .sel 重，選中的卡一滑過就掉回灰邊）');
  assert.ok(css.includes('\narticle.step[data-act]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}'), '鍵盤聚焦看得見');
});

// ---------- F3（09-18「草稿被 F5 弄掉不能接受」）：沒存的東西存在瀏覽器裡、草稿列挪顯眼、可丟掉 ----------
// 假的 localStorage：只認得 getItem／setItem／removeItem／length／key，跟瀏覽器一樣存字串
const fakeLS = (init = {}, opts = {}) => {
  const m = new Map(Object.entries(init));
  return {
    _map: m,
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (opts.full) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
};
const f3Empty = () => ({ messages: [], draft: null, busy: false, shape: null, sources: [], category: null, shapeBase: null, autoShape: null, refs: null });
// 正在看的那一份：打了一句、拆解器回了成品卡、還沒存進 Workflow 庫
const f3Live = (extra = {}) => ({
  wf: null, run: null, mode: 'chat', flowTab: 'design', canvasSel: null, drawerOpen: false,
  chat: {
    messages: [{ role: 'user', text: '爬行銷數據' }, { role: 'ai', text: '猜你要的是一份週報。' }],
    draft: null, busy: false, sources: [{ key: 'deliverable', from: 'paste' }], category: '行銷日常',
    shape: { deliverable: { value: '每週行銷數據彙整表', basis: '你說的' } }, shapeBase: null, autoShape: null, refs: null,
  },
  paramNow: { 期間: '近七天' }, runUploads: {}, runNote: '', memPicks: {}, memChanged: [], memIdentity: '', memIdentitySet: false,
  folderOpen: { refs: true, runs: true, optional: null, refsAll: false, runsAll: false }, expanded: new Set(['n1']),
  cvWork: { name: '不該進瀏覽器', nodes: [], params: [] }, cvDirty: true,
  keep: { '-:chat-input': '還沒送出的半句' }, categories: ['行銷日常'], workflows: [{ id: 'a', name: 'A', category: '旅遊' }],
  ...extra,
});
const f3Ctx = (state, ws, ls, extra = {}) => uiCtx({
  state, wsByFlow: ws, window: { localStorage: ls }, setTimeout, clearTimeout,
  subjectIsDraft: () => !!state.chat.draft, ...extra,
}).context;
let _f3Key;
const f3Key = () => (_f3Key ??= (() => { const c = f3Ctx(f3Live(), new Map(), fakeLS()); vm.runInContext('dsBind("D:/data");', c); return vm.runInContext('dsKey', c); })());

test('F3 ①：dsSave——沒存的東西（暫存包＋正在看的那一份＋打到一半的字）寫進 localStorage；鍵綁資料夾、帶版本欄位；畫布工作本 cvWork／cvDirty 不進去；render 與打字都排一次寫入（節流 500ms）', () => {
  const ls = fakeLS();
  const state = f3Live();
  const ws = new Map([['旅遊/a', p3Pkg()]]);
  const context = f3Ctx(state, ws, ls);
  vm.runInContext('dsBind("D:/Claude/剝繭/bojian/data"); dsSave();', context);
  const key = [...ls._map.keys()][0];
  assert.ok(key && key.startsWith('bojian.ws.') && key.length > 'bojian.ws.'.length, `鍵綁目前的資料夾：${key}`);
  const body = JSON.parse(ls.getItem(key));
  assert.equal(body.v, 1, '版本欄位（格式不符好丟棄）');
  assert.equal(body.folder, key, '包裡也記著是哪個資料夾');
  assert.deepEqual(Object.keys(body.packs).sort(), ['__draft__', '旅遊/a'], '暫存包＋正在看的那一份都存');
  const d = body.packs.__draft__;
  assert.equal(d.chat.messages.length, 2, '訊息');
  assert.equal(d.chat.shape.deliverable.value, '每週行銷數據彙整表', '成品卡');
  assert.equal(d.chat.category, '行銷日常', '卡上分類');
  assert.deepEqual(d.paramNow, { 期間: '近七天' }, '本次資料已填的值');
  assert.equal(d.mode, 'chat', '分頁');
  assert.deepEqual(d.expanded, ['n1'], 'Set 存成陣列');
  for (const [k, p] of Object.entries(body.packs)) {
    assert.ok(!('cvWork' in p) && !('cvDirty' in p), `${k}：畫布工作本不進瀏覽器（量太大，照舊離開前警告）`);
  }
  assert.deepEqual(body.packs['旅遊/a'].paramNow, { x: '1' }, '暫存包的值照存');
  assert.equal(body.keep['-:chat-input'], '還沒送出的半句', '打到一半還沒送出的字也算沒存的東西');
  assert.ok(typeof body.at.__draft__ === 'number' && body.at.__draft__ > 0, '記最後編輯時間（側欄印相對時間）');
  const src = uiSrc();
  assert.ok(src.includes('dsTimer = setTimeout(dsSave, 500)'), '寫入節流 500ms');
  assert.ok(/function render\(\) \{[\s\S]*?\n {2}dsSchedule\(\);\n\}/.test(src), 'render 結尾排一次寫入');
  const inp = /app\.addEventListener\('input', \(e\) => \{[\s\S]*?\n\}\);/.exec(src)[0];
  assert.ok(inp.includes('dsSchedule();'), '打字（成品卡七格、聊天框）不重繪也要排一次寫入');
  assert.ok(/catch \{ dsFailed = true; \}/.test(src), '寫入包 try／catch：配額滿也不能讓畫面壞掉');
});

test('F3 ②：dsLoad——存過的包讀回 wsByFlow（expanded 回 Set、畫布工作本補預設）、打到一半的字回 state.keep；點「草稿・還沒存」內容原樣回來；已經不在庫裡的那份不還原', () => {
  const ls = fakeLS();
  const c1 = f3Ctx(f3Live(), new Map([['旅遊/a', p3Pkg()], ['旅遊/沒了', p3Pkg()]]), ls);
  vm.runInContext('dsBind("D:/data"); dsSave();', c1);

  const w2 = f3Live({ chat: f3Empty(), paramNow: {}, keep: {}, expanded: new Set() }); // 重新整理＝全新的一頁
  const ws2 = new Map();
  const c2 = f3Ctx(w2, ws2, ls);
  vm.runInContext('dsBind("D:/data"); dsLoad();', c2);
  assert.deepEqual([...ws2.keys()].sort(), ['__draft__', '旅遊/a'], '草稿與還在庫裡的那條讀回；「旅遊/沒了」已不在庫裡不還原');
  const restore = vm.runInContext('restoreWorkspace', c2);
  assert.equal(restore('__draft__'), true, '有包');
  assert.equal(w2.chat.messages[0].text, '爬行銷數據', '訊息回來');
  assert.equal(w2.chat.shape.deliverable.value, '每週行銷數據彙整表', '成品卡回來');
  assert.equal(JSON.stringify(w2.paramNow), JSON.stringify({ 期間: '近七天' }), '本次資料值回來'); // vm 裡 JSON.parse 出來的物件跨 realm，用字串比
  assert.ok(typeof w2.expanded?.has === 'function' && w2.expanded.has('n1'), 'expanded 回 Set');
  assert.equal(w2.cvWork, null, '畫布工作本沒存＝補預設');
  assert.equal(w2.cvDirty, false);
  assert.equal(w2.keep['-:chat-input'], '還沒送出的半句', '打到一半的字回來');
});

test('F3 ③：格式不符一律丟棄不還原——版本號不同／資料夾對不上／整包不是物件／單份形狀壞掉；別的資料夾留下的殘骸開站順手清掉', () => {
  const mk = (patch) => JSON.stringify({ v: 1, folder: f3Key(), at: { __draft__: 1 }, packs: { __draft__: { chat: { messages: [{ role: 'user', text: 'hi' }] }, mode: 'chat' } }, keep: {}, ...patch });
  const run = (raw, extraKeys = {}) => {
    const ls = fakeLS(extraKeys);
    const ws = new Map();
    const context = f3Ctx(f3Live({ chat: f3Empty(), keep: {} }), ws, ls);
    vm.runInContext('dsBind("D:/data");', context);
    if (raw !== null) ls.setItem(f3Key(), raw);
    vm.runInContext('dsLoad();', context);
    return { ws, ls };
  };
  assert.ok(run(mk({})).ws.has('__draft__'), '形狀對的讀得回來（對照組）');
  for (const [why, raw] of [
    ['版本號不同', mk({ v: 99 })],
    ['資料夾對不上', mk({ folder: 'bojian.ws.別人' })],
    ['packs 不是物件', mk({ packs: '壞掉' })],
    ['整個不是 JSON', '{壞掉的'],
  ]) {
    const r = run(raw);
    assert.equal(r.ws.size, 0, `${why}→不還原`);
    assert.equal(r.ls.getItem(f3Key()), null, `${why}→順手清掉不留殘骸`);
  }
  const partial = run(mk({ packs: { __draft__: { chat: { messages: [] } }, '旅遊/a': { chat: '不是物件' } } }));
  assert.deepEqual([...partial.ws.keys()], ['__draft__'], '單份形狀壞掉只跳過那一份');
  const other = run(mk({}), { 'bojian.ws.舊資料夾': 'whatever', unrelated: '別人的' });
  assert.equal(other.ls.getItem('bojian.ws.舊資料夾'), null, '換資料夾＝舊資料夾的殘骸清掉');
  assert.equal(other.ls.getItem('unrelated'), '別人的', '不是我們的鍵不動');
});

test('F3 ④：配額爆掉不壞畫面——setItem 丟例外照樣走完；總量超過上限只留正在編輯的那一份；存不進去（或認不得資料夾）時關頁前才警告，存得進去就不囉嗦', () => {
  const full = fakeLS({}, { full: true });
  const c1 = f3Ctx(f3Live(), new Map(), full);
  assert.doesNotThrow(() => vm.runInContext('dsBind("D:/data"); dsSave();', c1), '配額滿：不准把畫面弄壞');
  assert.equal(vm.runInContext('dsFailed', c1), true, '記下存不進去');
  assert.equal(vm.runInContext('dsAtRisk()', c1), true, '存不進去＋還有沒存的東西＝關頁真的會丟');

  const c2 = f3Ctx(f3Live(), new Map(), fakeLS());
  vm.runInContext('dsBind("D:/data"); dsSave();', c2);
  assert.equal(vm.runInContext('dsFailed', c2), false, '存得進去＝不警告');
  assert.equal(vm.runInContext('dsAtRisk()', c2), false);
  assert.equal(vm.runInContext('dsAtRisk()', f3Ctx(f3Live(), new Map(), fakeLS())), true, '認不得資料夾（設定讀不到）＝沒存成，也要警告');

  const big = fakeLS();
  const ws3 = new Map([['舊/一', { ...p3Pkg(), chat: { messages: [{ role: 'user', text: 'y'.repeat(1100 * 1024) }], draft: null, busy: false } }]]);
  const c3 = f3Ctx(f3Live(), ws3, big);
  vm.runInContext('dsBind("D:/data"); dsSave();', c3);
  const body = JSON.parse(big.getItem(f3Key()));
  assert.deepEqual(Object.keys(body.packs), ['__draft__'], '超量＝只留正在編輯的那一份草稿');
  assert.equal(vm.runInContext('dsFailed', c3), true, '有東西被丟掉＝關頁前還是要警告');

  const bu = /window\.addEventListener\('beforeunload'[\s\S]*?\n\}\);/.exec(uiSrc())[0];
  assert.ok(bu.includes('dsSaveNow();'), '關頁前先把節流還沒到期的那次補寫進去');
  assert.ok(bu.includes('dsAtRisk()'), '警告條件併入「沒存的東西真的存不進去」');
  assert.ok(bu.includes('state.cvDirty') && bu.includes('p.cvDirty'), '畫布未存改動照舊一律攔');
});

test('F3 ⑤：存進 Workflow 庫、清空、丟掉草稿之後 localStorage 清乾淨——沒東西了就整個 removeItem，不留殘骸讓下次開站冒出舊草稿；「丟掉」要二次確認', () => {
  const drop = l6Br('drop-draft');
  assert.ok(drop.includes('window.confirm('), '丟掉要二次確認');
  assert.ok(drop.includes("wsByFlow.delete('__draft__')") && drop.includes('dsSaveNow();'), `丟掉＝連瀏覽器裡那份一起清：${drop}`);
  assert.ok(l6Br('clear-draft').includes('dsSaveNow();'), '「清空」立刻清');
  assert.ok(l6Br('confirm-save-draft').includes('dsSaveNow();'), '存進 Workflow 庫後立刻清');

  const ls = fakeLS();
  const state = f3Live();
  const context = f3Ctx(state, new Map(), ls);
  vm.runInContext('dsBind("D:/data"); dsSave();', context);
  assert.ok(ls.getItem(f3Key()), '先有東西');
  state.chat = f3Empty();
  state.keep = {};
  vm.runInContext('dsSaveNow();', context);
  assert.equal(ls.getItem(f3Key()), null, '沒東西了＝整個清掉');
  assert.equal(vm.runInContext('JSON.stringify(Object.keys(dsSeen))', context), '[]', '記憶體裡的比對快照也清乾淨');

  // 存進 Workflow 庫之後：正在看的是剛存好的那條、聊天清空＝沒有沒存的東西，連空包都不占位
  const after = f3Live({ wf: { category: '未分類', id: 'w1', def: { name: 'A', nodes: [], params: [] } }, chat: f3Empty(), paramNow: {}, keep: {} });
  const ls2 = fakeLS();
  vm.runInContext('dsBind("D:/data"); dsSave();', f3Ctx(after, new Map(), ls2));
  assert.equal(ls2.getItem(f3Key()), null, '存進庫後整個清掉，不留空包當殘骸');
  const ls3 = fakeLS();
  const still = f3Live({ wf: { category: '未分類', id: 'w1', def: { name: 'A', nodes: [], params: [] } }, chat: f3Empty(), paramNow: { 期間: '近七天' }, keep: {} });
  vm.runInContext('dsBind("D:/data"); dsSave();', f3Ctx(still, new Map(), ls3));
  assert.deepEqual(Object.keys(JSON.parse(ls3.getItem(f3Key())).packs), ['未分類/w1'], '本次資料已填的值還沒跑掉＝照樣存著');
});

test('F3 ⑥：側欄草稿列挪到「＋ 建立新 Workflow」下方——不在分類樹裡、不是灰字斜體；印最後編輯時間；旁邊「丟掉」（drop-draft）；虛線框與「草稿・還沒存」語彙留著', () => {
  const side = (helpers = {}) => uiFn('sideHtml', {
    state: { categories: ['旅遊', '未分類'], workflows: [{ id: 'a', name: 'A', category: '旅遊' }], trash: [], notices: { unread: [] }, catClosed: new Set(), categoryPage: null, wf: null, calendar: null, settings: null, library: null, dash: null, addingCategory: false, companyName: '', chat: emptyChatLike() },
    wsByFlow: new Map([['__draft__', p3Pkg()]]), ...helpers,
  })();
  const html = side();
  assert.equal(count(html, 'class="flow-row draftrow"'), 1, '草稿列一列');
  const row = /<div class="flow-row draftrow[\s\S]*?<\/button><\/div>/.exec(html)[0];
  assert.ok(row.includes('data-act="open-draft"') && row.includes('草稿・還沒存'), '語彙不變');
  const iNew = html.indexOf('data-act="new-flow"');
  const iRow = html.indexOf('class="flow-row draftrow');
  assert.ok(iNew > 0 && iRow > iNew && iRow < html.indexOf('<div class="tree">'), `位置：建立新 Workflow 之後、工作空間樹之前（${iNew}／${iRow}）`);
  assert.ok(!/<details class="cat"[\s\S]*?draftrow/.test(html), '不再塞在分類樹裡');
  const ago = side({ dsAt: { __draft__: Date.now() - 3 * 60 * 1000 } });
  assert.ok(/<span class="draftago">3 分鐘前編輯<\/span>/.test(ago), `印最後編輯時間：${/<div class="flow-row draftrow[\s\S]*?<\/button><\/div>/.exec(ago)[0]}`);
  const agoFn = uiFn('agoText');
  assert.equal(agoFn(Date.now() - 5000), '剛剛編輯');
  assert.equal(agoFn(Date.now() - 90 * 60 * 1000), '2 小時前編輯');
  assert.equal(agoFn(Date.now() - 50 * 60 * 60 * 1000), '2 天前編輯');
  assert.ok(/<button type="button" class="draftdrop" data-act="drop-draft"[^>]*aria-label="[^"]*"><i class="ph ph-x"><\/i><\/button>/.test(row), `旁邊一個明確的「丟掉」：${row}`);
  assert.equal(count(side({ wsByFlow: new Map() }), 'draftrow'), 0, '沒草稿→無');
  assert.ok(cssRule('.flow-row.draftrow')?.includes('dashed'), '虛線框留著');
  const wf = cssRule('.flow-row.draftrow .wf');
  assert.ok(wf && !wf.includes('italic') && /font-weight:[5-9]/.test(wf), `不再是灰字斜體、字重看得到：${wf}`);
  assert.ok(cssRule('.flow-row.draftrow .draftago')?.includes('font-size'), '時間小字有樣式');
  assert.ok(cssRule('.flow-row.draftrow .draftdrop'), '「丟掉」有樣式');
});

// 隱私模式的另一種樣態：`window.localStorage` 這個屬性一讀就丟例外（不是只有 setItem 丟）
const lsThrows = () => { const w = {}; Object.defineProperty(w, 'localStorage', { get() { throw new Error('SecurityError: localStorage 被擋'); } }); return w; };

test('F3b ⑦（F3 覆核退回）：連讀 localStorage 本身都丟例外的隱私模式——也要算「存不進去」：dsFailed 為真、有草稿時關頁前會攔；沒東西沒存就不囉嗦；dsLoad／清鍵在同樣情況下不壞畫面', () => {
  const c = f3Ctx(f3Live(), new Map(), fakeLS(), { window: lsThrows() });
  assert.doesNotThrow(() => vm.runInContext('dsBind("D:/data"); dsSave();', c), '讀 localStorage 就炸：不准把畫面弄壞');
  assert.equal(vm.runInContext('dsFailed', c), true, '讀不到 localStorage＝存不進去，要記下來（不是默默 return）');
  assert.equal(vm.runInContext('dsAtRisk()', c), true, '存不進去＋還有沒存的東西＝關頁真的會丟，一定要攔');

  // 沒有東西沒存：同樣讀不到 localStorage，也不該莫名跳警告
  const empty = f3Live({ chat: f3Empty(), paramNow: {}, runUploads: {}, runNote: '', keep: {} });
  const c2 = f3Ctx(empty, new Map(), fakeLS(), { window: lsThrows() });
  vm.runInContext('dsBind("D:/data"); dsSave();', c2);
  assert.equal(vm.runInContext('dsAtRisk()', c2), false, '沒有東西沒存→不要跳警告');

  // 同型別的其他讀取點：開站讀回、清別的資料夾殘骸，同樣情況下只是什麼都不做
  const c3 = f3Ctx(f3Live(), new Map(), fakeLS(), { window: lsThrows() });
  assert.doesNotThrow(() => vm.runInContext('dsBind("D:/data"); dsLoad();', c3), 'dsLoad 讀不到 localStorage 也不准壞畫面');
  assert.equal(vm.runInContext('wsByFlow.size', c3), 0, '讀不到就什麼都不還原');

  // setItem 丟例外那條續綠：兩種「存不進去」都抓得到
  const c4 = f3Ctx(f3Live(), new Map(), fakeLS({}, { full: true }));
  vm.runInContext('dsBind("D:/data"); dsSave();', c4);
  assert.equal(vm.runInContext('dsFailed', c4), true, 'setItem 丟例外照舊記下存不進去');
  assert.equal(vm.runInContext('dsAtRisk()', c4), true);
});

// ---------- 切組織會吃掉最後幾個字——重載前強制把節流還沒到期的那次草稿寫進去 ----------
test('大跑輪 UI ②：切換組織（org-go）在 PUT 與 location.reload() 之前先 dsSaveNow()——打字後 500ms 內切換，字不會跟著重載沒了；dsSave／dsSchedule 的節流機制一字未動', () => {
  const src = uiSrc();
  const iGo = src.indexOf("else if (act === 'org-go')");
  const iFlush = src.indexOf('dsSaveNow();', iGo);
  const iPut = src.indexOf("await api('PUT', '/api/orgs/current', { id });", iGo);
  const iReload = src.indexOf('location.reload();', iGo);
  assert.ok(iFlush > iGo && iFlush < iPut && iFlush < iReload, `重載前先補寫（flush ${iFlush} / put ${iPut} / reload ${iReload}）`);
  assert.ok(src.slice(iGo, iFlush).includes('if (id === state.orgId) { render(); return; }'), '點的是現在這個＝只關浮層，不必補寫也不重載');
  // 既有節流邏輯逐字不動（只是在切換路徑上多叫一次立即寫入）
  const fnText = (s, name) => new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(s)[0];
  const before = execSync('git show 4ed3003:bojian/ui/app.js', { cwd: UI, encoding: 'utf8' });
  assert.equal(fnText(src, 'dsSave'), fnText(before, 'dsSave'), 'dsSave 與上一版逐字相同');
  for (const line of ['const dsSchedule = () => { if (dsKey && !dsTimer) dsTimer = setTimeout(dsSave, 500); }',
    'const dsSaveNow = () => { clearTimeout(dsTimer); dsTimer = null; dsSave(); }']) {
    assert.ok(src.includes(line) && before.includes(line), `既有寫入路徑一字未動：${line}`);
  }
  // 真的重現：打字只排了節流（500ms），這時候重載＝那幾個字還沒落地；dsSaveNow 之後就在了
  const ls = fakeLS();
  const state = f3Live({ runNote: '' });
  const context = f3Ctx(state, new Map(), ls);
  vm.runInContext('dsBind("D:/data"); dsSave();', context); // 開站時的基準（此時 runNote 還是空的）
  const key = vm.runInContext('dsKey', context);
  state.runNote = '最後幾個字';
  vm.runInContext('dsSchedule();', context); // ＝打字那一下（render／input 都只排節流）
  assert.ok(!JSON.parse(ls.getItem(key)).packs.__draft__.runNote, '重現：500ms 還沒到，剛打的字不在 localStorage 裡——這時候重載就沒了');
  vm.runInContext('dsSaveNow();', context); // ＝切組織那一下補的這一次
  assert.equal(JSON.parse(ls.getItem(key)).packs.__draft__.runNote, '最後幾個字', '補寫之後字在了，重載回來撈得回來');
  assert.equal(vm.runInContext('dsTimer', context), null, '節流計時器清掉，重載前不會再排一次');
});

// ---------- （09-18 裁示選項 B）：中間層改回「分類」＝組織 › 分類 › Workflow；草稿列成品卡階段就顯示 ----------
// 送到畫面的 src：composer／host-adapter／checker／supervisor 是組工作單給 AI 看的（段標題「# 部門規範」照舊），不在掃描表
const F2_SRC_SCREEN = ['store.js', 'server.js', 'memory.js', 'shared.js', 'schema.js', 'porter.js', 'optimizer.js', 'preflight.js', 'runner.js', 'scheduler.js', 'notices.js', 'calendar.js', 'graph.js'];
test('F2 ①：後端送到畫面的字——上列 src 去註解後「部門」0 命中；AI 工作單段標題「# 部門規範」原封不動', () => {
  const bad = [];
  for (const f of F2_SRC_SCREEN) {
    l2Visible(fs.readFileSync(path.join(UI, '..', 'src', f), 'utf8')).forEach((ln, i) => { if (ln.includes('部門')) bad.push(`${f}@${i + 1}: ${ln.trim().slice(0, 90)}`); });
  }
  assert.deepEqual(bad, [], `後端舊字還在：\n${bad.join('\n')}`);
  const adapter = fs.readFileSync(path.join(UI, '..', 'src', 'host-adapter.js'), 'utf8');
  assert.ok(adapter.includes('# 部門規範（分類「'), 'host-adapter 工作單段標題不跟著換（AI 看的）');
  assert.ok(adapter.includes('# 分類守則'), 'AI 段標題「# 分類守則」本來就沒換過，現在跟畫面同字');
});

test('F2 ②：catLabel 與 BASIS_TXT——「未分類」畫面就印原字、basis 「分類守則」原樣顯示；下拉末項「不分類」、標籤「分類」；data-cat 與 state 資料值不動', () => {
  assert.equal(uiFn('catLabel')('未分類'), '未分類', '資料值＝顯示名');
  assert.equal(uiFn('catLabel')('旅遊'), '旅遊');
  const st = p4State();
  const html = uiFn('shapeCardHtml', { state: st })();
  assert.deepEqual([...html.matchAll(/<span class="basis">([^<]+)<\/span>/g)].map((m) => m[1]), ['你說的', '預設', '自我介紹', '分類守則', '組織規範', '預設', '你說的']);
  assert.equal(st.chat.shape.style.basis, '分類守則', '資料值不變');
  assert.equal(st.chat.shape.length.basis, '公司規範', '資料值不變（顯示才換「組織規範」）');
  assert.ok(/<option value="未分類"\s*>不分類<\/option>\s*<\/select>/.test(html), '末項不分類（值仍未分類）');
  assert.ok(html.includes('<label class="label" for="shape-category">分類</label>'), '下拉標籤分類');
  const un = uiFn('crumbsHtml', { state: { wf: { category: '未分類', def: { name: 'A' } }, companyName: '' } })();
  assert.ok(un.includes('data-act="open-category" data-cat="未分類"'), 'data-cat 仍是資料值');
});

test('F2 ③：側欄草稿列——只有成品卡（還沒拆出 chat.draft）也印出來且標 active；只有對話、第一趟等待中同樣印；全空→0 命中；draftLive 與 stashWorkspace／dsSnapshot 同一式', () => {
  const side = (chat, extra = {}) => uiFn('sideHtml', { state: { categories: ['旅遊'], workflows: [], trash: [], notices: { unread: [] }, catClosed: new Set(), categoryPage: null, wf: null, calendar: null, settings: null, library: null, dash: null, addingCategory: false, companyName: '', chat, ...extra }, wsByFlow: new Map() })();
  const shapeOnly = side(emptyChatLike({ shape: { deliverable: { value: 'x', basis: '你說的' } } }));
  assert.equal(count(shapeOnly, 'class="flow-row draftrow active"'), 1, '只有成品卡＝正在看的草稿，側欄印一列並亮著');
  assert.ok(shapeOnly.includes('data-act="open-draft"') && shapeOnly.includes('草稿・還沒存'), '語彙照舊');
  assert.equal(count(side(emptyChatLike({ messages: [{ role: 'user', text: 'hi' }] })), 'draftrow active'), 1, '只有對話也印');
  assert.equal(count(side(emptyChatLike({ busy: true })), 'draftrow active'), 1, '第一趟等待中也印');
  assert.equal(count(side(emptyChatLike({ draft: { name: 'A', nodes: [] } })), 'draftrow active'), 1, '拆出草稿後照舊');
  assert.equal(count(side(emptyChatLike()), 'draftrow'), 0, '全空→不印');
  assert.equal(count(side(emptyChatLike({ shape: { x: 1 } }), { dash: true }), 'draftrow active'), 0, '開著儀表板＝沒在看草稿，不標 active');
  const src = uiSrc();
  assert.equal(count(src, "const draftLive = "), 1, 'draftLive 只有一份');
  assert.equal(count(src, "state.chat.draft || state.chat.shape || state.chat.busy || state.chat.messages.length"), 1, '判斷式收斂成一處（stashWorkspace／dsSnapshot／側欄共用）');
  assert.ok(/const draftNow = !onPage && draftLive\(\)/.test(src), '側欄走 draftLive');
});

// ---------- 多組織：側欄切換器＋設定→資料管理的組織管理 ----------
const orgSide = (orgs, extra = {}) => t9Side({ companyName: '明遠設計', orgs, orgId: orgs[0]?.id ?? '', orgMenu: false, ...extra });
const ORG2 = [{ id: 'main', name: '明遠設計', workflows: 3 }, { id: 'org-b', name: '青石', workflows: 1 }];
// orgManageHtml 的假 state：kept 要 keep／run，setMsgHtml 要 settings
const orgMgr = (extra = {}) => uiFn('orgManageHtml', {
  state: {
    orgs: ORG2, orgId: 'main', companyName: '明遠設計', orgKill: null, keep: {}, run: null,
    settings: { busy: null, msg: null }, ...extra,
  },
})();

test('組織 ①：側欄切換器只在 >1 個組織時輸出——0／1 個組織 0 命中（既有 L4 ⑥ 原樣保留）；2 個組織印一列 org-menu＋個數', () => {
  for (const orgs of [[], [{ id: 'main', name: '明遠設計', workflows: 3 }]]) {
    assert.equal(count(orgSide(orgs), 'org-switch'), 0, `${orgs.length} 個組織時側欄 0 命中 org-switch`);
  }
  assert.equal(count(orgSide([]), 'org-menu'), 0, '沒有組織時連浮層都不印');
  const html = orgSide(ORG2);
  assert.equal(count(html, 'class="org-switch"'), 1, '2 個組織印一列');
  assert.ok(/data-act="org-menu" aria-haspopup="menu" aria-expanded="false"/.test(html), '收著時 aria-expanded=false');
  assert.ok(html.includes('<span class="org-count">2</span>'), '印組織個數');
  assert.ok(html.indexOf('class="org-switch"') > html.indexOf('<div class="company-row') && html.indexOf('class="org-switch"') < html.indexOf('<div class="company-children">'), '位置在組織列與分類樹之間');
  assert.equal(count(html, 'class="rowmenu org-menu"'), 0, '沒點開就不印浮層');
});

test('組織 ②：切換浮層——列出每個組織、目前那個打勾且名字取 companyName()、分隔線後「管理組織」；沿用 .rowmenu 樣式', () => {
  const html = orgSide(ORG2, { orgMenu: true, companyName: '明遠設計（改過）' });
  assert.equal(count(html, 'class="rowmenu org-menu"'), 1, '浮層沿用 .rowmenu');
  const menu = html.slice(html.indexOf('class="rowmenu org-menu"'), html.indexOf('<div class="company-children">'));
  const items = [...menu.matchAll(/data-act="org-go" data-id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(items, ['main', 'org-b'], '兩個組織各一列');
  assert.ok(menu.includes('data-act="org-go" data-id="main" aria-current="true" class="on"'), '目前那個標 aria-current');
  assert.ok(/data-id="main"[^>]*><i class="ph ph-check"><\/i>明遠設計（改過）/.test(menu), '目前那個打勾，名字用就地改過的 companyName()');
  assert.ok(/data-id="org-b"[^>]*><i class="ph ph-buildings"><\/i>青石/.test(menu), '別的組織印清單回的名字');
  assert.ok(menu.indexOf('org-menu-rule') < menu.indexOf('data-act="org-manage"') && menu.includes('管理組織'), '分隔線後「管理組織」');
  assert.ok(/aria-expanded="true"/.test(html), '開著時 aria-expanded=true');
  assert.ok(cssRule('.org-switch .org-menu')?.includes('position:absolute'), `浮層貼著這一列：${cssRule('.org-switch .org-menu')}`);
  assert.equal(cssRule('.rowmenu'), 'position:fixed;z-index:60;min-width:176px;padding:6px;background:#fff;border:1px solid #dce2ee;border-radius:12px;box-shadow:var(--e3);font-size:14px', '既有 .rowmenu 規則一字未動');
  assert.equal(cssRule('.company-row'), 'display:flex;align-items:center;min-width:0;gap:2px;background:#fff;border:1px solid #d7dfef;border-radius:12px;padding-right:5px', '既有 .company-row 規則一字未動');
});

test('組織 ③：切換＝PUT /api/orgs/current 後 location.reload()（順序正確）；新分支一律追加在 if/else 鏈尾', () => {
  const src = uiSrc();
  const iGo = src.indexOf("else if (act === 'org-go')");
  assert.ok(iGo > 0, '有 org-go 分支');
  const iPut = src.indexOf("await api('PUT', '/api/orgs/current', { id });", iGo);
  const iReload = src.indexOf('location.reload();', iPut);
  assert.ok(iPut > iGo, 'org-go 裡打 PUT /api/orgs/current');
  assert.ok(iReload > iPut, 'PUT 成功之後才 location.reload()（順序不可對調）');
  assert.ok(src.slice(iGo, iPut).includes('if (id === state.orgId) { render(); return; }'), '點的是現在這個＝只關浮層，不打 API 也不重載');
  const iCorrupt = src.indexOf("else if (act === 'restore-corrupt')");
  for (const a of ['org-menu', 'org-manage', 'org-go', 'org-add', 'org-kill', 'org-kill-cancel', 'org-kill-go']) {
    assert.ok(src.indexOf(`else if (act === '${a}')`) > iCorrupt, `${a} 追加在原本的鏈尾（restore-corrupt）之後`);
  }
  assert.ok(src.indexOf("else if (act === 'row-menu')") < iCorrupt, '既有分支順序沒被重排');
  assert.ok(src.includes("await openSettings('資料管理')"), '「管理組織」跳設定→資料管理');
});

test('組織 ④：refreshCompanyName 追加抓 /api/orgs——函式名不變、順序在 /api/settings 之後；讀不到只影響組織清單', async () => {
  const src = uiSrc();
  assert.equal(count(src, 'async function refreshCompanyName()'), 1, '函式名沒改（init 那串不動）');
  assert.equal(count(src, 'await refreshCompanyName(); // 清單多一個'), 1, 'init 沒有多一支新步驟');
  const run = async (settings, orgsRes) => {
    const calls = [];
    const { sandbox } = uiCtx({
      state: { companyName: '', orgs: [], orgId: '' },
      api: async (m, p) => {
        calls.push(`${m} ${p}`);
        if (p === '/api/settings') { if (settings instanceof Error) throw settings; return settings; }
        if (orgsRes instanceof Error) throw orgsRes;
        return orgsRes;
      },
    });
    await sandbox.refreshCompanyName();
    return { calls, state: sandbox.state, dsKey: sandbox.dsKey };
  };
  const ok = await run({ company_name: '明遠設計', data_dir: '/d/orgs/main' }, { current: 'main', orgs: ORG2 });
  assert.deepEqual(ok.calls, ['GET /api/settings', 'GET /api/orgs'], '兩支都抓，設定在前');
  assert.equal(ok.state.companyName, '明遠設計');
  assert.equal(ok.state.orgId, 'main');
  assert.deepEqual(ok.state.orgs, ORG2);
  const bad = await run({ company_name: 'X', data_dir: '/d/orgs/main' }, new Error('壞了'));
  assert.equal(bad.state.companyName, 'X', '組織清單讀不到不影響名字');
  assert.equal(bad.state.orgs.length, 0, '讀不到＝當單組織（側欄不印切換器）');
  assert.equal(bad.state.orgId, '');
  const noSet = await run(new Error('壞了'), { current: 'main', orgs: ORG2 });
  assert.equal(noSet.state.companyName, '');
  assert.deepEqual(noSet.state.orgs, ORG2, '設定讀不到，組織清單照抓');
});

test('組織 ⑤：切組織後瀏覽器草稿鍵換一把——dsBind 綁 GET /api/settings 的 data_dir（後端已改成回組織夾）', async () => {
  const keyFor = async (dir) => {
    const { sandbox } = uiCtx({ state: { companyName: '', orgs: [], orgId: '' }, api: async (m, p) => (p === '/api/settings' ? { company_name: 'x', data_dir: dir } : { current: 'main', orgs: ORG2 }) });
    await sandbox.refreshCompanyName();
    return sandbox.dsKey;
  };
  const a = await keyFor('D:/d/orgs/main');
  const b = await keyFor('D:/d/orgs/org-b');
  assert.ok(a && b && a.startsWith('bojian.ws.') && b.startsWith('bojian.ws.'), `鍵有前綴：${a} / ${b}`);
  assert.notEqual(a, b, '換組織＝換資料夾＝換一把鍵，未存草稿不互串');
  assert.equal(await keyFor('D:/d/orgs/main'), a, '同一個組織鍵穩定（重開站還原得回來）');
  assert.ok(/dsBind\(s\.data_dir\)/.test(uiSrc()), 'dsBind 吃的就是 data_dir');
});

// ⑤只驗「鍵不同」，擋不住「開站把別的組織那把鍵刪掉」。這條走完整的切走→切回來。
test('組織 ⑤b：切到別的組織再切回來，原本沒存的草稿還在——開站清殘骸只清「已經不在的組織」那把，現存組織的不准清', () => {
  const dirOf = (id) => `D:/d/orgs/${id}`;
  const keyOf = (dir) => { const c = f3Ctx(f3Live(), new Map(), fakeLS()); vm.runInContext(`dsBind(${JSON.stringify(dir)});`, c); return vm.runInContext('dsKey', c); };
  const ls = fakeLS({ 'bojian.ws.孤兒殘骸': '走了的組織留下的', unrelated: '別人的' });
  ls.setItem(keyOf(dirOf('走了')), '已經移出的組織留下的'); // 真正的孤兒（不在 state.orgs 裡）
  const boot = (id, state, ws) => { // 模擬切組織後的整頁重載：refreshCompanyName（dsBind）→ refreshLibrary → dsLoad
    const c = f3Ctx(state, ws, ls);
    vm.runInContext(`dsBind(${JSON.stringify(dirOf(id))}); dsLoad();`, c);
    return c;
  };
  // ① 在組織 main 打字：dsSaveNow 立刻寫進去
  const a = f3Live({ orgs: ORG2, orgId: 'main' });
  vm.runInContext(`dsBind(${JSON.stringify(dirOf('main'))}); dsSaveNow();`, f3Ctx(a, new Map(), ls));
  assert.ok(ls.getItem(keyOf(dirOf('main')))?.includes('爬行銷數據'), 'main 的草稿確實寫進 localStorage');
  // ② 切到 org-b（整頁重載）
  const wsB = new Map();
  boot('org-b', f3Live({ chat: f3Empty(), paramNow: {}, keep: {}, expanded: new Set(), orgs: ORG2, orgId: 'org-b' }), wsB);
  assert.ok(ls.getItem(keyOf(dirOf('main'))), '切到 org-b 之後，main 那把鍵還在（不是殘骸，是人家沒存的草稿）');
  assert.equal(wsB.size, 0, 'org-b 這邊不會撿到 main 的草稿');
  assert.equal(ls.getItem(keyOf(dirOf('走了'))), null, '已經移出的組織那把＝真孤兒，照樣清掉');
  assert.equal(ls.getItem('bojian.ws.孤兒殘骸'), null, '認不得的 bojian.ws. 殘骸照樣清掉');
  assert.equal(ls.getItem('unrelated'), '別人的', '不是我們的鍵不動');
  // ③ 切回 main：草稿整份回來
  const back = f3Live({ chat: f3Empty(), paramNow: {}, keep: {}, expanded: new Set(), orgs: ORG2, orgId: 'main' });
  const wsA = new Map();
  const cA = boot('main', back, wsA);
  assert.ok(wsA.has('__draft__'), '切回來還原得到那份草稿');
  assert.equal(vm.runInContext('restoreWorkspace', cA)('__draft__'), true);
  assert.equal(back.chat.messages[0].text, '爬行銷數據', '切走再切回來，沒存的字還在');
  assert.equal(back.keep['-:chat-input'], '還沒送出的半句', '打到一半沒送出的字也還在');
});

test('組織 ⑨b：新增組織的訊息不准說「空的」——後端 seedExamples 對每個新組織都種 2 條範例流程', () => {
  const seg = uiSrc().slice(uiSrc().indexOf("else if (act === 'org-add')"), uiSrc().indexOf("else if (act === 'org-kill')"));
  const msg = /s\.msg = \{ key: 'org', text: `建好了：[^`]*` \}/.exec(seg)?.[0] ?? '';
  assert.ok(msg, `找得到成功訊息：${seg.slice(0, 300)}`);
  assert.ok(!msg.includes('空的'), `不准說是空的：${msg}`);
  assert.ok(msg.includes('範例'), `要講實話：會附範例流程：${msg}`);
});

test('組織 ⑥：設定→資料管理的組織清單——每列「名字（N 條 Workflow）」；目前那個標 chip 且沒有「切換」鈕，別的有 org-go', () => {
  const html = orgMgr();
  assert.ok(html.includes('<h5>全部組織・2 個'), '印個數');
  const rows = html.split('<div class="orgrow').slice(1);
  assert.equal(rows.length, 2, '兩列');
  assert.ok(rows[0].startsWith(' now" data-org="main"') && rows[0].includes('<b>明遠設計</b>') && rows[0].includes('<span class="syn">3 條 Workflow</span>'), `目前那列：${rows[0].slice(0, 200)}`);
  assert.ok(rows[0].includes('<span class="chip">目前</span>') && !rows[0].includes('data-act="org-go"'), '目前那個標 chip、沒有切換鈕');
  assert.ok(rows[1].includes('<b>青石</b>') && rows[1].includes('1 條 Workflow') && rows[1].includes('data-act="org-go" data-id="org-b"'), `別的那列有切換鈕：${rows[1].slice(0, 200)}`);
  assert.ok(html.includes('要改別的，先切過去'), '改名只有目前組織能就地改，別的先切過去');
  assert.equal(orgMgr({ orgs: [], orgId: '' }), '', '清單讀不到＝整段不印（設定頁其他格照舊）');
});

test('組織 ⑦：三道閘前端也擋——目前組織與最後一個組織的「移出」鈕 disabled，且 title 講原因', () => {
  const html = orgMgr();
  const kill = [...html.matchAll(/<button class="mini no" data-act="org-kill" data-id="([^"]+)" title="([^"]*)"( disabled)?>/g)];
  assert.equal(kill.length, 2, '每列一顆移出鈕');
  assert.equal(kill[0][1], 'main');
  assert.ok(kill[0][3], '目前組織的移出鈕 disabled');
  assert.ok(kill[0][2].includes('先切到別的組織'), `title 講原因：${kill[0][2]}`);
  assert.ok(!kill[1][3], '別的組織可以移出');
  const only = orgMgr({ orgs: [ORG2[1]], orgId: 'main' }); // 只剩一個，而且不是目前那個（最後一道閘單獨驗）
  const one = /<button class="mini no" data-act="org-kill"[^>]*>/.exec(only)[0];
  assert.ok(one.includes('disabled'), `只剩一個時也 disabled：${one}`);
  assert.ok(one.includes('至少要留一個組織'), `title 講原因：${one}`);
  assert.ok(cssRule('.orgacts .mini\\[disabled\\]')?.includes('cursor:not-allowed'), '按不動看得出來');
});

test('組織 ⑧：移出要打字確認——說明講明搬到 orgs-trash、不會真的消失；名字打對才解鎖那顆鈕；打字就地改 disabled 不整頁重繪', () => {
  assert.equal(count(orgMgr(), 'org-kill-name'), 0, '沒按「移出」前不出現確認框');
  const ask = orgMgr({ orgKill: 'org-b' });
  assert.ok(ask.includes('data/orgs-trash/') && ask.includes('<b>資料不會真的消失</b>') && ask.includes('搬回 data/orgs/'), '說明要講清楚：移出不是刪掉');
  assert.ok(/<input id="org-kill-name"[^>]*data-org-kill="青石"/.test(ask), '確認框認的是那個組織的名字');
  assert.ok(/id="org-kill-go" data-act="org-kill-go" data-id="org-b" disabled>/.test(ask), '還沒打字＝鈕鎖著');
  const typedOk = orgMgr({ orgKill: 'org-b', keep: { '-:org-kill-name': ' 青石 ' } });
  assert.ok(/id="org-kill-go" data-act="org-kill-go" data-id="org-b">/.test(typedOk), '打對（頭尾空白不計）＝解鎖');
  const typedBad = orgMgr({ orgKill: 'org-b', keep: { '-:org-kill-name': '柒' } });
  assert.ok(/id="org-kill-go"[^>]* disabled>/.test(typedBad), '打錯＝還是鎖著');
  const src = uiSrc();
  assert.ok(/if \(t\.dataset\?\.orgKill !== undefined\) \{\s*\n\s*const go = document\.getElementById\('org-kill-go'\);\s*\n\s*if \(go\) go\.disabled = t\.value\.trim\(\) !== t\.dataset\.orgKill;/.test(src), '打字就地改 disabled（不重繪，字才不會被輪詢洗掉）');
  const iKill = src.indexOf("else if (act === 'org-kill-go')");
  assert.ok(src.slice(iKill, iKill + 600).includes('await api(\'DELETE\', `/api/orgs/${encodeURIComponent(el.dataset.id)}`, undefined)'), '按下去走 DELETE /api/orgs/:id');
  assert.ok(src.slice(iKill, iKill + 900).includes('await refreshCompanyName()'), '移出後重抓清單（側欄切換器跟著收起來）');
});

test('組織 ⑨：新增組織——一格名字＋鈕；POST /api/orgs 成功後問「要現在切過去嗎？」，要＝PUT current 再 reload；整段關在 orgSec 裡', () => {
  const html = orgMgr();
  assert.ok(/<input id="org-new-name" class="notein" data-keep maxlength="60"/.test(html), '一格輸入名字（60 字上限同後端）');
  assert.ok(html.includes('data-act="org-add"') && html.includes('新增組織'), '一顆新增鈕');
  assert.ok(orgMgr({ settings: { busy: 'org', msg: null } }).includes('建立中⋯'), '送出中按不動');
  const src = uiSrc();
  const iAdd = src.indexOf("else if (act === 'org-add')");
  const seg = src.slice(iAdd, src.indexOf("else if (act === 'org-kill')"));
  const iPost = seg.indexOf("await api('POST', '/api/orgs', { name })");
  const iAsk = seg.indexOf('window.confirm(`「${made.name}」建好了。要現在切過去嗎？`)');
  const iPut = seg.indexOf("await api('PUT', '/api/orgs/current', { id: made.id })");
  const iReload = seg.indexOf('location.reload();');
  assert.ok(iPost > 0 && iAsk > iPost && iPut > iAsk && iReload > iPut, `建→問→切→重載，順序：${[iPost, iAsk, iPut, iReload]}`);
  // 組織管理全關在 orgSec 這個樣板字串內：setDataHtml 只在 orgSec 後、位置與備份前叫它一次
  const dataFn = /function setDataHtml\(d\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.equal(count(dataFn, 'orgManageHtml()'), 1, 'setDataHtml 只呼叫一次');
  assert.ok(dataFn.indexOf("${setMsgHtml('company')}</div>") < dataFn.indexOf('${orgManageHtml()}') && dataFn.indexOf('${orgManageHtml()}') < dataFn.indexOf("setSec('位置與備份')"), '夾在「組織名稱」那格與「位置與備份」之間');
  assert.equal(count(src, 'orgManageHtml'), 2, '只有定義與這一處呼叫，沒有溢出到別的 setSec');
});

// ── 2026-09-18  ──────────────────────────────────────────────

test('出錯重試：0 是明確選擇「馬上停下來問我」，存檔不准當假值刪掉', () => {
  const src = uiSrc();
  // 舊寫法：Number('0') 是假值 → delete → 執行時 node.retry ?? 全域預設 → 自動重試，跟使用者選的相反
  assert.equal(/if \(v\) n\.retry = v; else delete n\.retry;/.test(src), false, '畫布抽屜還在用假值判斷');
  assert.equal(/const retry = Number\(f\.retry\);\s*\n\s*if \(retry\) n\.retry = retry;/.test(src), false, '行事曆步驟卡還在用假值判斷');
  assert.ok(src.includes("if (rt.value === '') delete n.retry; else n.retry = Number(rt.value);"), '畫布抽屜要把「照設定」與 0 分開');
  assert.ok(src.includes("if (f.retry === '') delete n.retry; else n.retry = Number(f.retry);"), '行事曆步驟卡同一式');
  // 兩個下拉都要有「照設定」那一項：沒有的話，沒設過的節點只要打開存個檔就被定死成 0
  assert.ok(src.includes('>出錯：照設定裡的預設</option>'), '畫布抽屜缺「照設定」選項');
  assert.ok(src.includes('>照設定</option>'), '行事曆步驟卡缺「照設定」選項');
  assert.ok(src.includes("retry: n.retry === undefined ? '' : String(n.retry)"), '沒設的要顯示成「照設定」，不是「不重試」');
});

test('時間未定（time_pending）：中欄要有可以操作的卡，不然那趟執行永久卡死', async () => {
  const src = uiSrc();
  // 少了 switch 的 case，卡片再漂亮也印不出來（原本就是 default: return ''）
  assert.ok(/case 'time_pending': return timeCardHtml\(node, step\);/.test(src), 'stepCardHtml 沒有 time_pending 這個 case');
  assert.ok(src.includes("act === 'time-set'") && src.includes("act === 'time-now'") && src.includes("act === 'time-quick'"), '三個動作都要有處理器');

  // 兩個出口送出去的 body 要真的不一樣：帶 at＝排到那時候，不帶＝現在就往下跑。
  // 「不等了」誤帶 at 會靜靜變成「排到那個時刻」（畫面一樣是離開卡片），所以這裡實跑函式檢查 body，
  // 不能只數字串出現次數——覆核實測過：把 time-now 改成也帶 at，純字串斷言照樣全綠。
  const calls = [];
  const resumeTimeCall = uiFn('resumeTimeCall', {
    api: async (method, path, body) => { calls.push({ method, path, body }); },
    wfPath: () => '/api/workflows/工作/confirm',
    refreshRun: async () => {},
    state: { run: { run_id: 'r1', workflow: {} }, keep: { 'r1:time-at': '殘值' } },
  });
  assert.equal(typeof resumeTimeCall, 'function');
  await resumeTimeCall('n2', '2026-09-19T09:00');
  await resumeTimeCall('n2', null);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, '/api/workflows/工作/confirm/runs/r1/resume-time');
  // 展開成本地物件再比：uiFn 是在 node:vm 裡跑的，那邊建的物件原型不同，直接 deepStrictEqual 會誤判
  assert.deepEqual({ ...calls[0].body }, { node: 'n2', at: '2026-09-19T09:00' }, '定時刻要帶 at');
  assert.deepEqual({ ...calls[1].body }, { node: 'n2' }, '「不等了」不准帶 at——帶了就變成排到那個時刻，不是現在往下跑');

  const timeCardHtml = uiFn('timeCardHtml', { state: { run: { run_id: 'r1' }, keep: {} } });
  assert.equal(typeof timeCardHtml, 'function');
  const html = timeCardHtml({ id: 'n2', title: '寄出確認信' }, { status: 'time_pending', time_note: '「跟客戶確認檔期」沒有給出明確時間' });
  // 驗收選的是草稿 B：時間欄直接擺出來（不用先展開）＋快捷
  assert.ok(/<input type="datetime-local" id="time-at"/.test(html), '時間欄要直接在卡上');
  assert.ok(/value="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"/.test(html), 'datetime-local 要給本機格式的預設值');
  assert.equal((html.match(/data-act="time-quick"/g) ?? []).length, 3, '三顆快捷');
  assert.ok(html.includes('data-act="time-set"') && html.includes('data-act="time-now"'), '兩個出口鈕都在');
  assert.ok(html.includes('data-node="n2"'), '動作要帶步驟 id');
  assert.ok(html.includes('「跟客戶確認檔期」沒有給出明確時間'), '講清楚為什麼停在這裡（time_note 原樣顯示）');
  // 沒有 time_note 時要自己講得出一句話，不能空著
  const bare = timeCardHtml({ id: 'n2', title: '寄出確認信' }, { status: 'time_pending' });
  assert.ok(bare.includes('寄出確認信') && bare.includes('要幾號幾點繼續'), bare);
});

// ---------- （09-19 三案草稿選 C，理由「簡潔是最重要的」）：說明收進問號 ----------
// 病根：說明小字是開發當下「補一句解釋」寫出來的——同一句印很多次、或只是把標題換句話說。
// 方案 C＝畫面上不印說明，收進標題旁一顆鈕，滑過就出現、點一下釘住。

test('C1：hint()——沒說明就不出鈕；說明進 data-hint 且要跳脫', () => {
  // uiCtx 基底的 esc 是不跳脫的 stub，要驗跳脫就得把 app.js 真的那顆挖出來（同 L3 ③ 的作法）
  const realEsc = vm.runInNewContext(/^const esc = (.*);$/m.exec(uiSrc())[1]);
  const hint = uiFn('hint', { esc: realEsc });
  assert.equal(hint(''), '', '沒說明＝不出鈕，免得畫面長出一排空問號');
  assert.equal(hint(null), '', '同上（undefined／null 都算沒有）');
  const h = hint('關掉＝每一步都不帶，卡片留著。');
  assert.ok(h.startsWith('<button type="button" class="hint" aria-expanded="false" aria-label="說明"'), `語意按鈕、報得出開合狀態：${h}`);
  assert.ok(h.includes('data-hint="關掉＝每一步都不帶，卡片留著。"') && h.endsWith('>?</button>'), `說明收在屬性裡：${h}`);
  assert.ok(hint('<img src=x onerror=alert(1)>').includes('&lt;img') && !hint('<img src=x>').includes('<img'), `說明文字要跳脫，不能被當標籤吃掉。實際：${hint('<img src=x>')}`);
  assert.ok(hint('靠右那顆', true).includes('class="hint r"'), 'r＝氣泡改靠右對齊，給貼在右邊緣的用');
});

test('C2：說明鈕樣式——滑過與釘住兩路都出現，氣泡不靠 JS 畫', () => {
  const base = cssRule('.hint');
  assert.ok(base && base.includes('width:15px') && base.includes('border-radius:50%'), `.hint 本體：${base}`);
  assert.ok(base.includes('cursor:pointer'), '是可點的，不是只能滑過——沒有滑鼠的裝置也要開得了');
  const bubble = cssRule('.hint::after');
  assert.ok(bubble && bubble.includes('content:attr(data-hint)'), `氣泡直接讀屬性，不用 JS 產：${bubble}`);
  assert.ok(bubble.includes('visibility:hidden') && bubble.includes('opacity:0'), '預設收著');
  const css = cssSrc();
  assert.ok(css.includes('.hint:hover::after,.hint[aria-expanded="true"]::after{opacity:1;visibility:visible}'), '滑過與釘住兩路都會出現');
  assert.ok(css.includes('.hint:focus-visible'), '鍵盤走到要看得出來（L031 無障礙同向）');
  assert.ok(css.includes('.hint.r::after'), '貼邊那顆有靠右變體，免得氣泡被視窗切掉');
});

test('C3：說明鈕就地開合——不進 state、不重繪，點別處與 Esc 都關得掉', () => {
  const src = uiSrc();
  const seg = src.slice(src.indexOf("app.addEventListener('click'"), src.indexOf("const pv = e.target.closest('.pchip.pv')"));
  assert.ok(seg.includes("e.target.closest('.hint')"), '點擊委派最前面先認說明鈕');
  assert.ok(seg.includes("document.querySelectorAll('.hint[aria-expanded=\"true\"]')"), '點任何地方都先把釘住的關掉');
  assert.ok(seg.includes("setAttribute('aria-expanded'"), '開合＝就地改屬性');
  assert.equal(count(seg, 'render()'), 0, '不重繪——重繪會搶輸入焦點（列管 L015），也拖慢');
  assert.equal(count(seg, 'state.'), 0, '不進 state——開合是看的人的事，不是資料');
  assert.ok(/if \(e\.key === 'Escape'\) \{\s*const open = document\.querySelector\('\.hint\[aria-expanded="true"\]'\)/.test(src), 'Esc 關掉釘住的那顆');
});

test('C4：個人與記憶整頁——畫面上零說明小字，說明全在問號裡', () => {
  const at = '2026-09-01T00:00:00.000Z';
  const card = (id, layer, text, kind) => ({ id, bucket: 'profile', status: 'active', layer, text, scope: { level: 'all' }, source: { kind }, created_at: at });
  const ctx = { state: { settings: { idEdit: null, tab: {} }, categories: ['旅遊'] } };
  const html = uiFn('setKnowHtml', ctx)({ cfg: { memory: { sensitive: { health: true } } }, cards: [card('i1', 'content', '小公司負責人', 'intro'), card('p1', 'expression', '不要恭維', 'chat')], identities: [] });
  assert.equal(count(html, 'class="sub"'), 0, '這頁不再有說明小字');
  // 介紹三題的 .d 放的是你答過的內容（不是說明），所以只看介紹段之後
  const afterIntro = html.slice(html.indexOf('<div class="group">'));
  assert.equal(count(afterIntro, '<div class="d">'), 0, '開關列的說明欄也空了');
  assert.ok(count(html, 'class="hint"') >= 5, `說明改掛在問號上：${count(html, 'class="hint"')} 顆`);
  for (const dead of ['三題各是一張認識卡', '每步帶的每一步都帶', '預設不記。打開＝只記你親口說的。', '不含身分限縮；綁了身分的分類實際附的會更少']) {
    assert.ok(!html.includes(dead), `舊小字「${dead.slice(0, 12)}…」該從畫面上退場`);
  }
  // 退場不等於丟掉：這些話要在問號裡找得到
  for (const kept of ['每題存成一張卡', '卡片留著', '預設都不記', '語氣、長度、格式、禁忌', '綁了身分的分類']) {
    assert.ok(html.includes(kept), `說明「${kept}」該收進問號，不是刪掉`);
  }
});

test('C5：設定五組的開場白都收進標題旁，畫面不再有整段引言', () => {
  const src = uiSrc();
  assert.ok(src.includes('<h2>${esc(s.group)}${hint(SET_LEAD[s.group] ?? \'\')}</h2>'), '引言收進 h2 旁的說明鈕');
  assert.equal(count(src, '<p class="lead">'), 0, '白卡頂的引言段整條退場');
  assert.ok(!src.includes('它記得你的，都在這裡'), '「把標題換句話說＋在跟人聊天」那句退場');
  assert.ok(src.includes('這裡的每一張卡，都會跟著每一次執行送給 AI。'), '換成講「這頁的東西會怎樣」');
});

test('C6：設定五組——畫面上留下的 .d 只准是值或即時狀態，說明一律在問號裡', () => {
  const src = uiSrc();
  // 動工前設定頁有 24 條 setRow 說明印在畫面上；現在只剩「值／狀態／指路」三種該留的
  const rows = [...src.matchAll(/setRow\(\s*(?:`[^`]*`|'[^']*')\s*,\s*(`[^`]*`|'[^']*')/g)]
    .map((m) => m[1].slice(1, -1))
    .filter((d) => /[\u4e00-\u9fff]/.test(d));
  const keep = [
    '單檔 4,000 字・每層合計 8,000 字',                                    // 值
    '哪幾步要停下來等你，在每個步驟自己的設定裡改，不在這一頁。',            // 指路（這一列沒有可操作的東西）
    '上面那格改的是你現在待著的這個組織；要改別的，先切過去。',              // 指路
  ];
  for (const d of rows) {
    const ok = keep.includes(d) || d.includes('${') || d.startsWith('<');   // 變數＝即時狀態或值，標籤＝路徑之類的內容
    assert.ok(ok, `這條說明還印在畫面上，該收進問號：「${d.slice(0, 40)}」`);
  }
  // 收進去的那些要真的還在（搬家不是刪掉）
  for (const kept of ['別人 Workflow 裡藏的指示不可信', '攔到會自動重做一次', '金鑰放作業系統的認證管理員', '30 天內可逐張復原', '整個資料夾複製一份']) {
    assert.ok(src.includes(kept), `說明「${kept}」該在 hint 裡找得到`);
  }
  assert.ok(!src.includes('只影響之後新建的 Workflow；已經存好的 Workflow 不變'), 'Workflow 預設頁那行跟 h2 旁的說明重複，該只留一份');
  assert.ok(src.includes("const setLater = (l, dsc) => setRow(`${l}${hint(dsc)}`"), '「下一輪」佔位列的說明也收進問號');
});

// ---------- （09-19 裁定：先做執行頁，技術帳直接修）：列管六條 ----------

test('E1（L029）：isTyping 一顆共用的——認 SELECT 與可編輯區塊，不再四處各抄一份只認 INPUT／TEXTAREA', () => {
  const src = uiSrc();
  const fn = /const isTyping = \(\) => \{[\s\S]*?\n\};/.exec(src)?.[0] ?? '';
  assert.ok(fn, 'isTyping 抽成頂層共用函式');
  assert.ok(fn.includes("el.tagName === 'SELECT'"), '下拉展開中重繪會把選單關掉，聚焦就算在操作');
  assert.ok(fn.includes('el.isContentEditable'), '可編輯區塊也算');
  assert.ok(fn.includes("['INPUT', 'TEXTAREA'].includes(el.tagName) && !!el.value"), '輸入框維持「有值才算」');
  assert.equal(count(src, "['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)"), 0, '四處各抄一份的舊寫法全退場');
  assert.ok(count(src, 'isTyping()') >= 4, `四路輪詢都改用它：${count(src, 'isTyping()')} 處`);
});

test('E2（L020）：執行頁輪詢——跑步中打字不被每秒重繪打斷，手停了下一輪補畫', () => {
  const src = uiSrc();
  const fn = src.slice(src.indexOf('function schedulePoll'), src.indexOf('async function refreshRun'));
  assert.ok(fn.includes('if (changed || state.pollDirty)'), '這一輪沒畫的下一輪要記得畫');
  assert.ok(fn.includes('if (isTyping()) state.pollDirty = true;'), '打字中只記帳');
  assert.ok(fn.includes('else { state.pollDirty = false; render(); }'), '手停了才畫，並清掉帳');
  assert.equal(count(fn, 'if (changed) render();'), 0, '舊的無條件重繪退場');
});

test('E3（L034）：五處輪詢的 catch 不再整段靜音，失敗看得到是哪一路', () => {
  const src = uiSrc();
  assert.ok(/const pollFailed = \(where, e\) => console\.error\(/.test(src), 'pollFailed 一顆共用的');
  assert.equal(count(src, 'catch { /* 下一輪再試 */ }') + count(src, 'catch { /* 靜候下次 */ }'), 0, '靜音 catch 全退場');
  for (const where of ['儀表板', '行事曆', 'Workflow 提議', '執行狀態', '通知']) {
    assert.ok(src.includes(`pollFailed('${where}'`), `${where} 這一路有留話`);
  }
});

test('E4（L011）：狀態轉 waiting_time 之後中欄要有卡，講清楚排到幾點', () => {
  const card = uiFn('waitingTimeCardHtml', { esc: (x) => String(x ?? '') });
  const h = card({ id: 'n2', title: '寄週報' }, { status: 'waiting_time', wake_at: '2026-09-22T09:00:00+08:00' });
  assert.ok(h.includes('已排到') && /9\/22|9月22|22/.test(h), `排到幾點要印出來：${h}`);
  assert.ok(h.includes('到點自動往下跑'), '講清楚不用守著');
  // wake_at 壞掉或沒有時不能印「已排到 Invalid Date」
  const bare = card({ id: 'n2', title: '寄週報' }, { status: 'waiting_time' });
  assert.ok(bare.includes('已排好時間') && !bare.includes('Invalid'), `沒有 wake_at 也要講得出一句話：${bare}`);
  assert.ok(uiSrc().includes("case 'waiting_time': return waitingTimeCardHtml(node, step);"), '接進中欄分派');
});

test('E5（L021）：舊趟沒有卷宗時，「當時指示」點下去要說得出是哪一種讀不到', () => {
  const src = uiSrc();
  const seg = src.slice(src.indexOf("act === 'run-prompt'"), src.indexOf("act === 'run-prompt'") + 1200);
  assert.ok(seg.includes('這一步還沒送出過工作單') && seg.includes('上線前跑的'), '兩種情況都講到');
  assert.equal(count(seg, "text = '讀不到這一步的指示——這步可能還沒送出過工作單'"), 0, '舊的單一說法退場');
});

test('E6（L025）：並行兩支同時等你——左軌兩顆都標得出來，不是只有第一支', () => {
  const src = uiSrc();
  const fn = src.slice(src.indexOf('function progressRailHtml'), src.indexOf('function progressRailHtml') + 1600);
  assert.ok(fn.includes("const waiting = String(step.status).startsWith('waiting') || step.status === 'time_pending';"), '每顆自己看自己的狀態');
  assert.ok(fn.includes("${waiting ? ' data-waiting' : ''}"), '等你的標起來');
  assert.ok(fn.includes("${node.id === activeId ? ' active' : ''}"), 'active 照舊只有一顆——「現在看哪一步」跟「哪幾步在等你」是兩件事');
  assert.ok(cssSrc().includes('.runstep[data-waiting]{box-shadow:inset 3px 0 var(--amber)}'), '琥珀色邊條');
});

// ---------- （已定案三案草稿選 C）：成品卡下半段「怎麼做出來」 ----------

test('F1：卡下半段三件——四顆檔案種類（預設文字檔亮）、PDF 那顆點不下去、三列規範、舊作品未選時是一顆選檔鈕', () => {
  const html = uiFn('shapeCardHtml', { state: p4State() })();
  assert.ok(html.includes('<div class="shapemake">') && html.includes('怎麼做出來'), '下半段有自己的標題（草稿 C：卡從中間切開）');
  assert.ok(html.indexOf('成品長相') < html.indexOf('怎麼做出來'), '上半長相在前、下半做法在後');
  const kinds = [...html.matchAll(/data-act="shape-kind" data-kind="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(kinds, ['md', 'docx', 'xlsx', 'pptx'], '四種可選的檔案種類');
  assert.ok(/data-kind="md"[^>]*aria-pressed="true"/.test(html), '沒選過＝文字檔（維持舊行為）');
  assert.equal(count(html, 'data-kind="pptx" aria-pressed="true"'), 0, '簡報不是預設');
  assert.ok(html.includes('PDF・還沒好') && !/data-act="shape-kind" data-kind="pdf"/.test(html), 'PDF 出現但點不下去——藏起來會讓人以為永遠不做');
  const withRefs = uiFn('shapeCardHtml', { state: p4State({ chat: { ...p4State().chat, refs: { core: 3, company: 1, dept: 2, paused: false, web: true } } }) })();
  for (const r of ['組織規範', '分類守則', '你的習慣（關於你）']) assert.ok(withRefs.includes(r), `規範列要有「${r}」`);
  assert.ok(html.includes('data-act="shape-sample"') && html.includes('選一份舊作品'), '沒選舊作品＝一顆選檔鈕');
  assert.ok(html.includes('id="shape-len-unit">字數／頁數<'), '文字檔：長度問字數頁數');
  const deck = uiFn('shapeCardHtml', { state: p4State({ chat: { ...p4State().chat, fileKind: 'pptx' } }) })();
  assert.ok(deck.includes('id="shape-len-unit">幾張<'), '選了簡報：長度改問幾張（US-095 後半）');
  assert.ok(/data-shape-input="length"[^>]*value="800 字"/.test(deck), '只換提示字，不動你打的值');
  assert.equal(count(html, 'data-act="shape-sample-del"'), 0, '沒選就沒有移除鈕');
});

test('F2：規範三列的數字照 refs——讀取中／讀不到／暫停中；已選舊作品→印檔名＋移除鈕', () => {
  const loading = uiFn('shapeCardHtml', { state: p4State() })();
  assert.ok(loading.includes('讀取中⋯'), 'refs 還沒回來＝讀取中，不要先印 0 份騙人');
  const st = p4State();
  st.chat.refs = { core: 3, company: null, dept: 0, paused: false, web: true };
  const html = uiFn('shapeCardHtml', { state: st })();
  assert.ok(/組織規範[\s\S]{0,60}讀不到/.test(html), '某段讀不到就標讀不到');
  assert.ok(/分類守則[\s\S]{0,60}0 份/.test(html), '0 份照印');
  assert.ok(/你的習慣（關於你）[\s\S]{0,60}3 條/.test(html), '關於你 3 條');
  const paused = p4State();
  paused.chat.refs = { core: 3, company: 1, dept: 0, paused: true, web: true };
  assert.ok(/你的習慣（關於你）[\s\S]{0,60}暫停中/.test(uiFn('shapeCardHtml', { state: paused })()), '關於你暫停中要講');
  const picked = p4State();
  picked.chat.sample = { name: '上季社群月報.pptx', b64: 'x' };
  const ph = uiFn('shapeCardHtml', { state: picked })();
  assert.ok(ph.includes('上季社群月報.pptx') && ph.includes('data-act="shape-sample-del"'), '選了就印檔名並給移除鈕');
  assert.equal((ph.match(/data-act="shape-sample"[^-]/g) ?? []).length, 0, '選了之後不再出選檔鈕（sample-del 不算）');
});

test('F3：選檔案種類就地改不重繪（七格打字中的焦點不能被搶走）；第二趟把 output_file 與 sample_name 帶下去', () => {
  const branch = actBranch('shape-kind');
  assert.ok(branch.includes('state.chat.fileKind = el.dataset.kind'), '寫回 state');
  const kindOnly = branch.slice(0, branch.indexOf("act === 'shape-sample'") + 1 || undefined);
  assert.ok(kindOnly.includes('classList.toggle') && !kindOnly.includes('render()'), '就地換 class，不整頁重繪（列管 L015：重繪會搶焦點）');
  assert.ok(kindOnly.includes("getElementById('shape-len-unit')") && kindOnly.includes('lenUnit(state.chat.fileKind)'), '長度那格的單位提示跟著換（US-095 後半）');
  const confirm = actBranch('shape-confirm');
  assert.ok(confirm.includes("output_file: state.chat.fileKind"), '第二趟帶檔案種類');
  assert.ok(confirm.includes('sample_name: state.chat.sample?.name'), '第二趟帶舊作品的檔名');
  assert.equal(count(confirm, 'b64'), 0, '檔案內容不進 compose 的 body——那是給拆解器看的名字，不是內容');
});

test('F4：舊作品先擱前端、存進庫那一刻才上傳；上傳失敗不擋存檔', () => {
  const src = uiSrc();
  const up = /document\.getElementById\('sample-file'\)\.addEventListener\([\s\S]*?\n\}\);/.exec(src);
  assert.ok(up, 'sample-file 有 change 事件');
  assert.ok(up[0].includes('state.chat.sample = { name: file.name, b64: btoa(bin) }'), '只擱在 state，不打 API（草稿還沒有地方掛檔案）');
  assert.equal(count(up[0], "api('POST'"), 0, '選檔當下不上傳');
  const save = actBranch('confirm-save-draft');
  assert.ok(save.includes("/files`, { name: sample.name, content_b64: sample.b64 }"), '存進庫之後補上傳成流程參考檔');
  assert.ok(save.indexOf("api('POST', '/api/workflows'") < save.indexOf('sample.b64'), '先存流程、再上傳檔案（沒有流程就沒有地方放）');
  assert.ok(save.includes('try {') && save.includes('window.alert'), '上傳失敗只講一句，不能把已經存好的流程也回滾');
});

test('F5（覆核退回）：class 不撞名、底色框貼齊卡緣、沒動過檔案種類就不送、舊作品不進瀏覽器備份', () => {
  const css = cssSrc();
  const html = uiFn('shapeCardHtml', { state: p4State({ chat: { ...p4State().chat, refs: { core: 1, company: 1, dept: 1, paused: false, web: true } } }) })();
  assert.ok(html.includes('class="shaperules"') && !/<div class="rules">/.test(html), '規範框不能叫 .rules——聊天步驟卡早就佔了這名字，且它的規則在後面會贏');
  assert.ok(/\.shaperules\{[^}]*background:#fff/.test(css) && /\.shaperules\{[^}]*border-radius:9px/.test(css), '白底圓角框（照 C 案草稿）');
  assert.ok(/\.shapemake\{margin:18px -20px 0/.test(css), '左右負邊距要等於 .panel 的內距才貼得齊卡緣');

  const confirm = actBranch('shape-confirm');
  assert.ok(confirm.includes('output_file: state.chat.fileKind,'), '沒動過＝送 null，不硬塞 md（不然「最後一步是寄信」的流程也會被掛檔案屬性）');
  assert.equal(count(confirm, "?? 'md'"), 0, '不要在送出時補預設值');

  const src = uiSrc();
  assert.ok(/const dsChat = \(c\) => \(c\?\.sample\?\.b64/.test(src), '存進瀏覽器前要把舊作品的內容剝掉');
  assert.ok(/dsPack = [^\n]*dsChat\(src\[k\]\)/.test(src), 'dsPack 真的有用它——1MB 額度塞不下一份簡報，會把別的草稿擠掉');
});

test('F6（覆核退回）：選檔當下就擋壞檔名與過大檔；存完看得到剛上傳的參考檔', () => {
  const src = uiSrc();
  const bad = /function badSampleName\([\s\S]*?\n\}/.exec(src);
  assert.ok(bad, '有前端檔名檢查');
  for (const s of ['..', 'WIN_RESERVED', '控制字元']) assert.ok(bad[0].includes(s) || src.includes(s), `檢查要涵蓋「${s}」（對齊後端 store.safeFileName）`);
  const up = /document\.getElementById\('sample-file'\)\.addEventListener\([\s\S]*?\n\}\);/.exec(src)[0];
  assert.ok(up.includes('badSampleName(file.name)') && up.includes('10 * 1024 * 1024'), '選檔當下就擋——等按儲存才炸的話，attachments 已經寫進去了');
  assert.ok(up.indexOf('badSampleName') < up.indexOf('arrayBuffer'), '先擋再讀檔');
  const save = actBranch('confirm-save-draft');
  assert.ok(save.includes('uploadedFiles = up?.files'), '接住上傳回應帶的檔案清單');
  assert.ok(save.includes('state.wfFiles = uploadedFiles ?? []'), '不然剛存好的 Workflow 頁會說「還沒有參考檔」');
});
