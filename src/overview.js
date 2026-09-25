// overview — 一趟跑完的「總覽規格單」（US-104／ADR-007）：重點句＋圖表規格。
// AI 只回結構化規格，圖由剝繭自己畫；這裡負責組 prompt、解 JSON、清洗與把關。
// 四條紀律：
//   1. AI 不產生任何畫面標記——所有文字欄位存進卷宗前就跳脫（與 server.js 的 escHtml 同一張表）。
//   2. 數字必須來自成品——每個 value 都要在該趟成品全文裡逐字找得到（容許千分位逗號與百分號），
//      對不上的整張圖不畫，理由寫進 dropped；總覽自己不算任何新數字。
//   3. 版型只有四種、出圖有門檻——認不得的 kind 不猜，同一類數字不到三筆不給 bar／line。
//   4. 失敗不擋收工——呼叫錯、解不出 JSON 一律回 { ok:false, fail_note }，不重試第二次，絕不 throw 給引擎。
import { nodeKind } from './schema.js';
import { extractJson, CheckParseError } from './checker.js';

const str = (v) => (v === null || v === undefined ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const NONE = '（無）';
// 超量就截，並且講明截了——整理員看到「（截）」才知道自己看的不是全部
const cut = (v, n) => {
  const s = str(v);
  return s.length > n ? `${s.slice(0, n)}（截）` : s;
};

// 畫面標記一律當純文字：與 server.js 的 escHtml 同一張表（那支沒有匯出，這裡留一份；改一邊要兩邊一起改）。
// 跳脫在截斷之後做——先跳脫再截會把 &quot; 這種實體切成半截
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (v, n) => escHtml(str(v).trim().slice(0, n));

// ADR-007 第 2 條：版型只有四種，不做 pie、不做堆疊
export const CHART_KINDS = ['bar', 'line', 'kpi', 'table'];
// ADR-007 安全考量的長度上限；MIN_TREND＝第 4 條的出圖門檻
export const MAX_SUMMARY = 5;
export const MAX_SENTENCE = 200;
export const MAX_TITLE = 40;
export const MAX_UNIT = 6; // 單位只收「%、次、元、人」這種一兩個字的標記，不收句子
export const MAX_SERIES = 12;
export const MIN_TREND = 3;

// ---- 固定交代（逐字；改這裡＝改契約，tests/overview.test.js 一起改） ----

export const OVERVIEW_RULES = '你是「剝繭」的總覽整理員。這趟流程已經跑完，下面是各步的成品全文。請整理一份總覽規格單。'
  + 'summary＝三到五句重點，每句 200 字內，cite 必須是下面「可用的步驟 id」裡的一個；重點不足三句就照實給，超過五句只留最重要的五句。'
  + 'charts＝可以畫的圖，每張只准四種版型之一：bar（比大小）、line（比時間）、kpi（單一重點大字）、table（表格）；不做圓餅、不做堆疊。'
  + '同一類數字滿三筆才准用 bar 或 line，兩筆以內只能用 kpi。series 最多 12 筆，title 40 字內，note 選填。'
  + 'unit 選填，照原文那個數字後面的單位填（％、次、元、人、天…），6 字內，原文沒有寫單位就留空字串；'
  + 'value 裡只放數字本身，不要把單位寫進 value。'
  + '每個 value 都必須是上面成品全文裡逐字寫出來的數字——不准自己加總、平均、換算、估算、四捨五入；'
  + '找不到一模一樣的數字就不要放那張圖。baseline 選填，是成品文字裡已經寫出來的比較基準（例如「全月平均」），一樣要逐字找得到。'
  + '沒有數字的流程就只給重點句，charts 給空清單，不要補裝飾圖。'
  + '全部欄位只寫純文字，不准寫 HTML、SVG、script 或任何標記。全篇使用與成品相同的語言。'
  + '只輸出一個 JSON 物件，前後不要任何其他文字：'
  + '{"summary":[{"text":"…","cite":"步驟id"}],"charts":[{"kind":"bar","title":"…","unit":"","note":"","series":[{"label":"…","value":0}],"baseline":null}]}';

// ---- 設定：跑完出總覽（ADR-007 第 5 條，預設開） ----

// 關掉＝整趟不發那次呼叫。只有明明白白寫 false 才算關——設定檔沒有這個鍵（舊設定檔）一律當開
export function overviewEnabled(settings) {
  const s = isObj(settings) ? settings : {};
  const v = (isObj(s.exec) ? s.exec.overview_enabled : undefined) ?? s.overview_enabled;
  return v !== false;
}

// ---- 數字比對（ADR-007 第 3 條） ----

// 成品文字裡的數字字面：先認千分位寫法（1,234.5），認不得再退回一般寫法；% 不吃進來，所以 12.5 與「12.5%」對得上。
// 「-」只有在前一個字元不是任何語系的字母或數字時才算負號——不然「客服專線 02-2345」「頁碼 12-15」
// 「訂單編號 A-99」會被讀成 -2345、-15、-99，原文只要有電話、頁碼或編號，AI 就能憑空生一個負數洞見騙過逐字比對。
// 必須用 \p{L}\p{N}（要 u 旗標）不能用 \w：\w 只認 ASCII，「客服專線-2345」「商品編號甲-99」「分店代號忠-15」
// 這類中文店號型號照樣會漏掉，而剝繭的成品幾乎全是中文，那才是最常出現的情境
const NUM_SIGN = '(?:(?<![\\p{L}\\p{N}_])-)?';
const NUM_LITERAL = new RegExp(`${NUM_SIGN}\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|${NUM_SIGN}\\d+(?:\\.\\d+)?`, 'gu');

// 成品全文裡出現過的數字字面（已去千分位逗號）。小數另收一份去尾零的寫法（「12.50」也算寫過 12.5）；
// 整數的開頭零不補（「05」不算寫過 5——那是日期，不是數字），逐字就是逐字
export function numberIndex(text) {
  const out = new Set();
  for (const m of str(text).matchAll(NUM_LITERAL)) {
    const raw = m[0].replace(/,/g, '');
    out.add(raw);
    if (raw.includes('.')) {
      const n = Number(raw);
      if (Number.isFinite(n)) out.add(String(n));
    }
  }
  return out;
}

// 這個數字在成品裡逐字寫過嗎？不是數字（字串、null、NaN）一律不算——契約寫的是數字，不替 AI 轉型
export function hasNumber(index, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return index.has(String(value));
}

// ---- 頁尾那行（stats 由程式算，不問 AI） ----

// steps_total＝這趟真的要做事的步驟（並行點與會合點是結構、未選到的支已跳過，都不算一步）
// check_blocked＝查核攔下的次數（每一次交卷各算一次；沒有 attempts 的舊 run 退回看最後一次的判定）
// recheck_unresolved（US-112）＝重寫後仍有數字沒出處的步數：check.status=redone 且 recheck_blocks 是非空陣列的步；舊趟缺欄位＝0
export function buildStats(run) {
  const def = isObj(run?.def) ? run.def : {};
  const steps = isObj(run?.steps) ? run.steps : {};
  const nodes = arr(def.nodes).filter((n) => isObj(n) && typeof n.id === 'string');
  const counted = nodes.filter((n) => !['fork', 'join'].includes(nodeKind(n)) && str(steps[n.id]?.status) !== 'skipped');
  let blocked = 0;
  let unresolved = 0;
  for (const n of nodes) {
    const s = isObj(steps[n.id]) ? steps[n.id] : {};
    const tries = arr(s.attempts).filter((a) => str(a?.check?.status) === 'blocked').length;
    blocked += tries || (str(s.check?.status) === 'blocked' ? 1 : 0);
    if (str(s.status) !== 'skipped' && str(s.check?.status) === 'redone' && Array.isArray(s.check?.recheck_blocks) && s.check.recheck_blocks.length) unresolved += 1;
  }
  const t0 = Date.parse(str(run?.started_at));
  const t1 = Date.parse(str(run?.finished_at));
  return {
    steps_total: counted.length,
    steps_passed: counted.filter((n) => str(steps[n.id]?.status) === 'done').length,
    check_blocked: blocked,
    recheck_unresolved: unresolved,
    duration_ms: Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, t1 - t0) : 0,
  };
}

// ---- prompt 組裝 ----

// outputs＝[{id, title, text}]（只給這趟真的有成品的步驟）；id 清單同時是 cite 的白名單
export function buildOverviewPrompt({ def, outputs } = {}) {
  const d = isObj(def) ? def : {};
  const outs = arr(outputs).filter((o) => isObj(o) && str(o.text).trim());
  return [
    OVERVIEW_RULES,
    '',
    `# 流程：${str(d.name)}`,
    '',
    '# 可用的步驟 id',
    outs.length ? outs.map((o) => `- ${str(o.id)}：${str(o.title)}`).join('\n') : NONE,
    '',
    '# 各步成品全文',
    outs.length ? outs.map((o) => `【步驟：${str(o.title)}｜id：${str(o.id)}】\n${cut(o.text, 20000)}`).join('\n\n') : NONE,
  ].join('\n');
}

// ---- 解析 ----
// 走 checker 的同一套候選政策（全文一個池、包含依名次、含糊即失敗）：整理員被要求「只輸出一個 JSON 物件」，
// 交了兩份一樣像的就是交件不合格，誠實說沒寫成，不准靠位置去猜

const NO_RESULT = '總覽的回覆裡沒有可用的規格單';
const AMBIGUOUS = '總覽這次交了不只一份規格單，分不出哪份是真的';

export function parseOverview(text) {
  const v = extractJson(
    text,
    // 單張圖的物件沒有 summary／charts 陣列，名次 0，不會混進候選池跟外層搶
    (x) => (isObj(x) && (Array.isArray(x.summary) || Array.isArray(x.charts)) ? [1] : [0]),
    (x) => ({ summary: arr(x.summary), charts: arr(x.charts) }),
    AMBIGUOUS,
  );
  if (v === null) throw new CheckParseError(NO_RESULT);
  return v;
}

// ---- 清洗與把關 ----

// raw＝parseOverview 的結果；nodeIds＝這趟真的有成品的步驟 id；sourceText＝該趟成品全文（數字逐字比對的唯一依據）
// 回 { summary, charts, dropped }：
//   - cite 對不上這趟的步驟＝丟那一句（其餘照留）
//   - kind 認不得、數字對不上、沒數字、bar／line 不到三筆＝整張圖不畫，各留一句原因進 dropped
export function sanitizeOverview(raw, { nodeIds = [], sourceText = '' } = {}) {
  const ids = new Set(arr(nodeIds).filter((x) => typeof x === 'string' && x));
  const index = numberIndex(sourceText);
  const dropped = [];

  const summary = [];
  for (const s of arr(raw?.summary)) {
    if (summary.length >= MAX_SUMMARY) break; // 超過五句只留最重要的前五句（US-104）
    if (!isObj(s)) continue;
    const text = str(s.text).trim();
    const cite = str(s.cite).trim();
    if (!text || !ids.has(cite)) continue; // 出處對不上＝這句沒有原文可點回去，丟掉
    summary.push({ text: clean(text, MAX_SENTENCE), cite });
  }

  const charts = [];
  for (const c of arr(raw?.charts)) {
    if (!isObj(c)) { dropped.push('有一張圖的格式看不懂，沒有畫出來'); continue; }
    const title = clean(c.title, MAX_TITLE);
    const name = title || '沒有標題的圖';
    const kind = str(c.kind).trim();
    if (!CHART_KINDS.includes(kind)) {
      dropped.push(`「${name}」的版型「${clean(kind, 20) || '空白'}」認不得，沒有畫出來`);
      continue;
    }
    const series = arr(c.series).filter(isObj).slice(0, MAX_SERIES);
    if (!series.length) { dropped.push(`「${name}」沒有可用的數字，沒有畫出來`); continue; }
    if (['bar', 'line'].includes(kind) && series.length < MIN_TREND) {
      dropped.push(`「${name}」只有 ${series.length} 筆數字，長條與趨勢線要三筆以上才畫，沒有畫出來`);
      continue;
    }
    const bad = series.find((p) => !hasNumber(index, p.value));
    if (bad) {
      dropped.push(`「${name}」裡的數字（${clean(bad.value ?? '空白', 20) || '空白'}）在這趟的成品裡找不到一模一樣的，沒有畫出來`);
      continue;
    }
    // baseline 是選填的；給了就一樣要逐字找得到，對不上＝整張圖不畫（ADR-007 第 3 條：每個 value 都算數）
    let baseline = null;
    if (c.baseline !== null && c.baseline !== undefined) {
      if (!isObj(c.baseline) || !hasNumber(index, c.baseline.value)) {
        dropped.push(`「${name}」的比較基準在這趟的成品裡找不到一模一樣的數字，沒有畫出來`);
        continue;
      }
      baseline = { label: clean(c.baseline.label, MAX_TITLE), value: c.baseline.value };
    }
    const note = clean(c.note, MAX_SENTENCE);
    // 單位只是顯示用的純文字標記（原文寫 13.28% 就填「%」）；value 的逐字比對不吃它，單位對錯不影響畫不畫
    const unit = clean(c.unit, MAX_UNIT);
    charts.push({
      kind,
      title,
      ...(unit ? { unit } : {}),
      ...(note ? { note } : {}),
      series: series.map((p) => ({ label: clean(p.label, MAX_TITLE), value: p.value })),
      ...(baseline ? { baseline } : {}),
    });
  }

  return { summary, charts, dropped };
}

// ---- 呼叫 ----

// 卷宗回呼（比照 supervisor.note）：寫不進卷宗只是少一份紀錄，不該把總覽整個降級成沒寫成
async function note(fn, value) {
  if (typeof fn !== 'function') return;
  try { await fn(value); } catch { /* 卷宗寫不進不擋總覽 */ }
}

const humanReason = (e) => str(e?.message).replace(/可以按[\s\S]*$/, '').trim() || '原因不明';

// 一趟只發一次：呼叫失敗或解不出 JSON 都不重試第二次，回 { ok:false, fail_note } 由 runner 存「這趟沒有總覽」
export async function overview({ adapter, meta, onPrompt, onReply, def, outputs }) {
  const outs = arr(outputs).filter((o) => isObj(o) && str(o.text).trim());
  try {
    const prompt = buildOverviewPrompt({ def, outputs: outs });
    await note(onPrompt, prompt);
    const raw = str(await adapter.complete({ prompt, meta: { ...(meta ?? {}), kind: 'overview' } }));
    await note(onReply, raw);
    const parsed = parseOverview(raw);
    return {
      ok: true,
      ...sanitizeOverview(parsed, {
        nodeIds: outs.map((o) => str(o.id)).filter(Boolean),
        sourceText: outs.map((o) => str(o.text)).join('\n\n'),
      }),
    };
  } catch (e) {
    return { ok: false, fail_note: `這趟沒有總覽：${humanReason(e)}` };
  }
}
