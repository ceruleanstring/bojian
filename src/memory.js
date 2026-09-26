// memory — 記憶模組。上半＝純函式：卡的結構、詞典、群組拆條、用在哪、範圍擴大、選項計數、
// 兩條程式判的記路（paramSignal／stopEditSignal）、三問路由的 prompt 與解析、選卡與外圈蓋內圈（selectCore／resolveOverrides）、開跑選項（habitOptions）（不碰檔案）。
// 下半＝createMemory 門面：拿 store 讀寫卡與設定的組合動作（摘要、這條流程會帶什麼、介紹三題、通知撤回、
// 四條記路的落地）。三問路由 route() 是唯一的新 AI 呼叫（meta.kind='memory'），失敗不擋任何流程。
// 資料模型契約：規劃/2026-09-09--實作計畫.md「契約 (a)(c)」。
import { extractJson, CheckParseError } from './checker.js';

// 欄位性質六類（封閉）：拆解器給的 params[].kind、詞典 fields[].kind 只准這六個
export const FIELD_KINDS = Object.freeze({
  appearance: '產出的樣子', audience: '對象', time: '時間', range: '範圍', limits: '資源與限制', method: '做法',
});
export const SCOPE_LEVELS = Object.freeze(['all', 'category', 'workflow']);
// 出處八種＋取代；認識卡只准前五種（步驟產出永遠不是認識卡的來源）
export const SOURCE_KINDS = Object.freeze(['intro', 'chat', 'stop-note', 'run-params', 'stop-edit', 'feedback', 'group-box', 'manual', 'replace']);
// 認識卡只准這幾種出處＝「他自己打的字」（步驟產出永遠不是來源）。feedback 也是他自己打的字——
// 跑完丟的那一句；沒有家的欄位改記成認識卡（已定案）之後這條路變常態，標成 chat 等於天天誤導
export const PROFILE_SOURCE_KINDS = Object.freeze(['intro', 'chat', 'stop-note', 'feedback', 'manual', 'replace']);
// 認識卡層級：表達層（每步帶）｜內容層（按場合帶）
export const PROFILE_LAYERS = Object.freeze(['expression', 'content']);
// 當選項連續沒被選幾次→休眠（確認書 §十一 暫定數字）
export const DORMANT_STREAK = 5;

const SCOPE_MSG = '用在哪只能是全部、分類、Workflow';

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

const factory = (name, kind, synonyms) => ({ name, kind, synonyms, origin: 'factory', created_at: null });
// 出廠詞典（created_at 由 store.readDict 缺檔時蓋上當下時間）；凍結＝誰改它誰炸，不准當可變狀態用
export const FACTORY_DICT = deepFreeze({
  version: 1,
  fields: [
    factory('語氣', 'appearance', ['口吻', '風格']),
    factory('長度', 'appearance', ['篇幅', '字數']),
    factory('格式', 'appearance', ['排版', '版型']),
    factory('讀者', 'audience', ['對象', '給誰看']),
    factory('語言', 'appearance', ['中英文']),
    factory('截止日', 'time', ['交期', '什麼時候要']),
    factory('產出檔類型', 'appearance', ['檔案格式']),
    factory('型態', 'appearance', ['成品類型', '做成什麼']), // 成品卡七格對詞典正式名——型態／分段歸「產出的樣子」、範圍歸「範圍」，六類不加
    factory('分段', 'appearance', ['段落', '章節']),
    factory('範圍', 'range', ['期間', '涵蓋']),
  ],
});

// ---- id ----

// 同一毫秒連叫也不重複：時間部分單調遞增（同程序內）；四碼亂數只是防跨程序撞。匯出供身分 i-（M1b／M5a）用
let lastTick = 0;
export function newId(prefix) {
  lastTick = Math.max(Date.now(), lastTick + 1);
  return `${prefix}-${lastTick.toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
}

export function newCardId(bucket) {
  return newId(bucket === 'profile' ? 'p' : 'h');
}

// 從 id 前綴反推在哪本帳（p-＝認識卡，其餘＝習慣卡）；API 只拿到 id 時用
export function bucketOfId(id) {
  return String(id ?? '').startsWith('p-') ? 'profile' : 'habit';
}

// ---- 卡 ----

// 用在哪：不適用的鍵一律 null（all 沒有分類與流程；category 沒有流程）
function normScope(scope) {
  const level = scope?.level ?? null;
  return {
    level,
    category: level === 'all' ? null : (scope?.category ?? null),
    workflow: level === 'workflow' ? (scope?.workflow ?? null) : null,
  };
}

// 正面五行＋各自多一行＋背面缺省。不驗證——驗證走 validateCard
export function makeCard(input = {}, now = new Date().toISOString()) {
  const { bucket } = input;
  const s = input.source ?? {};
  const card = {
    id: input.id ?? newCardId(bucket),
    bucket,
    text: String(input.text ?? '').trim(),
    who: input.who ?? 'you',
    scope: normScope(input.scope),
    source: {
      kind: s.kind ?? null, category: s.category ?? null, workflow: s.workflow ?? null,
      run: s.run ?? null, node: s.node ?? null, at: s.at ?? now, quote: s.quote ?? null,
    },
    expires: input.expires ?? null,
  };
  if (bucket === 'profile') card.layer = input.layer ?? 'expression';
  if (bucket === 'profile' && input.section != null) card.section = input.section; // 說明書五段之一（US-115）；沒給就不帶＝舊卡形狀不變
  if (bucket === 'habit' || input.field != null) card.field = input.field ?? null; // 認識卡選填，沒給就不帶
  return Object.assign(card, {
    status: input.status ?? 'active',
    replaces: input.replaces ?? null,
    replaced_by: null,
    created_at: now,
    last_used_at: null,
    shown_count: 0,
    picked_count: 0,
    changed_count: 0,
    unpicked_streak: 0,
    scope_log: [],
    route_reason: input.route_reason ?? '',
  });
}

function isDateOnly(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // 擋 2026-02-31
}

// 回人話清單，空＝合法。給了詞典就連習慣卡的欄位對不對得到一起驗
export function validateCard(card, dict = null) {
  const c = card ?? {};
  const out = [];
  if (!String(c.text ?? '').trim()) out.push('卡要有內容');
  if (c.bucket !== 'habit' && c.bucket !== 'profile') out.push('卡只能是習慣卡或認識卡');
  if (c.bucket === 'habit') {
    const f = String(c.field ?? '').trim();
    if (!f || (dict && !matchField(dict, f))) out.push('習慣卡要對到詞典裡的欄位');
  }
  if (!SCOPE_LEVELS.includes(c.scope?.level)) out.push(SCOPE_MSG);
  const has = (v) => String(v ?? '').trim() !== '';
  if (c.scope?.level === 'workflow' && !(has(c.scope.category) && has(c.scope.workflow))) out.push('用在 Workflow 時要指定分類和 Workflow');
  if (c.scope?.level === 'category' && !has(c.scope.category)) out.push('用在分類時要指定分類');
  if (!String(c.source?.quote ?? '').trim()) out.push('沒有出處的卡不存在');
  if (c.expires != null && !isDateOnly(c.expires)) out.push('有效期要是 YYYY-MM-DD');
  if (c.bucket === 'profile' && !PROFILE_SOURCE_KINDS.includes(c.source?.kind)) out.push('認識卡的來源只限你打的字');
  if (c.bucket === 'profile' && !PROFILE_LAYERS.includes(c.layer)) out.push('認識卡的層級只能是表達層或內容層');
  if (c.bucket === 'profile' && c.section != null && !MANUAL_SECTION_KEYS.includes(c.section)) out.push('說明書的段落只能是五段之一');
  return out;
}

// ---- 詞典 ----

const fieldsOf = (dict) => (Array.isArray(dict) ? dict : (dict?.fields ?? []));
const cloneField = (f) => ({ ...f, synonyms: [...(f.synonyms ?? [])] });
const withFields = (dict, fields) => ({ ...(Array.isArray(dict) ? { version: 1 } : dict), fields });

// 名字或同義詞相等（兩側 trim）→該條；否則 null
export function matchField(dict, name) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  return fieldsOf(dict).find((f) => String(f.name ?? '').trim() === n
    || (f.synonyms ?? []).some((s) => String(s).trim() === n)) ?? null;
}

// 每個 label 對不上就新建一條（kind 不在六類＝method；origin 記它從哪條流程長出來）；回新詞典，不改原物件
export function ensureFields(dict, params, { category = null, workflow = null } = {}, now = new Date().toISOString()) {
  const fields = fieldsOf(dict).map(cloneField);
  const next = withFields(dict, fields);
  const added = [];
  for (const p of params ?? []) {
    const label = String(p?.label ?? '').trim();
    if (!label || matchField(next, label)) continue;
    const f = { name: label, kind: Object.hasOwn(FIELD_KINDS, p.kind) ? p.kind : 'method', synonyms: [], origin: { category, workflow }, created_at: now };
    fields.push(f);
    added.push(f);
  }
  return { dict: next, added };
}

// 與既有名字或同義詞互為子字串（至少兩字；完全相同不算，那是 matchField 的事）的正式名清單——存檔健檢提一句用
export function similarFields(dict, label) {
  const n = String(label ?? '').trim();
  if (n.length < 2) return [];
  const like = (raw) => {
    const b = String(raw ?? '').trim();
    return b.length >= 2 && b !== n && (b.includes(n) || n.includes(b));
  };
  return fieldsOf(dict).filter((f) => like(f.name) || (f.synonyms ?? []).some(like)).map((f) => f.name);
}

// 併欄位：drop 的名字與同義詞併進 keep、drop 從詞典移除；掛在 drop 的卡改掛 keep（回改過的卡，不改原卡）
export function mergeFields(dict, cards, keep, drop) {
  const k = matchField(dict, keep);
  const d = matchField(dict, drop);
  if (!k) throw new Error(`詞典裡沒有「${keep}」`);
  if (!d) throw new Error(`詞典裡沒有「${drop}」`);
  if (k === d) throw new Error('留下的和併掉的是同一條');
  const synonyms = [...new Set([...(k.synonyms ?? []), d.name, ...(d.synonyms ?? [])])].filter((s) => s !== k.name);
  const fields = fieldsOf(dict).filter((f) => f !== d).map((f) => (f === k ? { ...cloneField(f), synonyms } : cloneField(f)));
  const changed = (cards ?? []).filter((c) => c.field === d.name).map((c) => ({ ...c, field: k.name }));
  return { dict: withFields(dict, fields), cards: changed };
}

// ---- 群組圈 ----

// 文字框原文→一行一條；「<詞典名或同義詞>：<值>」（全形／半形冒號都認）＝有名字的欄位，其餘自由規矩。
// 再存一次：同文字的條保留原 id 與 created_at（比對 text）；少掉的行標 retired 留著；重新出現的行拿回原 id
export function parseGroupText(text, dict, prevRules = [], now = new Date().toISOString()) {
  const prevByText = new Map((prevRules ?? []).map((r) => [r.text, r]));
  const seen = new Set();
  const rules = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    const m = /^([^：:]+)[：:](.*)$/.exec(line);
    const f = m ? matchField(dict, m[1]) : null;
    const value = m ? m[2].trim() : '';
    const named = Boolean(f && value);
    const prev = prevByText.get(line);
    rules.push({
      id: prev?.id ?? newId('g'),
      text: line,
      field: named ? f.name : null,
      value: named ? value : null,
      status: 'active',
      created_at: prev?.created_at ?? now,
    });
  }
  for (const r of prevRules ?? []) if (!seen.has(r.text)) rules.push({ ...r, status: 'retired' });
  return rules;
}

// ---- 用在哪 ----

// 這張卡（或這個 scope）涵不涵蓋這條流程。分類、流程層級都嚴格比對：鍵是 null 不當萬用（少了分類的流程卡誰都不涵蓋）
export function coversWorkflow(target, { category = null, workflow = null } = {}) {
  const s = target?.scope ?? target ?? {};
  if (s.level === 'all') return true;
  const sameCategory = s.category != null && s.category === category;
  if (s.level === 'category') return sameCategory;
  if (s.level === 'workflow') return sameCategory && s.workflow != null && s.workflow === workflow;
  return false;
}

// 範圍靠證據往外擴：流程→分類→全部；沒指定 level＝往外一圈。scope_log 記一筆。回新卡，不改原卡
export function widenScope(card, { level, category = null, why = '在別條流程也被選了', now = new Date().toISOString() } = {}) {
  const from = card.scope ?? {};
  const to = level ?? (from.level === 'workflow' && category ? 'category' : 'all');
  if (!SCOPE_LEVELS.includes(to)) throw new Error(SCOPE_MSG);
  if (to === 'workflow') throw new Error('範圍只能往外擴（分類、全部）');
  const scope = normScope({ level: to, category: to === 'category' ? (category ?? from.category) : null });
  if (scope.level === from.level && scope.category === (from.category ?? null)) return card; // 已經在那圈
  return { ...card, scope, scope_log: [...(card.scope_log ?? []), { at: now, from: { ...from }, to: { ...scope }, why }] };
}

// 當選項出現一次：被選→被選次數加一、連續未選歸零、記最近用；沒被選→連續未選加一，滿 DORMANT_STREAK 休眠。回新卡
export function tickShown(card, picked, now = new Date().toISOString()) {
  const shown_count = (card.shown_count ?? 0) + 1;
  if (picked) {
    return {
      ...card, shown_count, picked_count: (card.picked_count ?? 0) + 1, unpicked_streak: 0, last_used_at: now,
      status: card.status === 'dormant' ? 'active' : card.status,
    };
  }
  const unpicked_streak = (card.unpicked_streak ?? 0) + 1;
  return { ...card, shown_count, unpicked_streak, status: unpicked_streak >= DORMANT_STREAK && card.status === 'active' ? 'dormant' : card.status };
}

// ---- 記路（程式判的兩條，M2）----

const str = (v) => (v === null || v === undefined ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
// 一句話才成卡：多行或超過 200 字的值是貼進來的資料，不是習慣（門檻跟工作單「長欄位」同一條）
const isOneLiner = (v) => !v.includes('\n') && v.length <= 200;

// 記路①：開跑同值連兩趟。對每個欄位：這趟非空、不等於預設、跟前一趟一樣、這趟不是從卡點來的（picks）、
// 也還沒有同欄位同內容的 active 習慣卡→一張草稿 { key, label, text, quote }。給了詞典時，卡上的欄位名先對回正式名再比
export function paramSignal({ def, prevRun, run, picks, cards, dict = null } = {}) {
  if (!prevRun?.params || !run?.params) return [];
  const picked = picks ?? run.memory?.picks ?? {};
  const have = arr(cards).filter((c) => c?.bucket === 'habit' && c.status === 'active');
  const formal = (label) => (dict ? (matchField(dict, label)?.name ?? label) : label);
  const out = [];
  for (const p of arr(def?.params)) {
    const raw = run.params[p.key];
    if (raw === undefined || raw === null) continue;
    const v = String(raw);
    if (!v.trim() || v === String(p.default ?? '') || !isOneLiner(v)) continue;
    const prev = prevRun.params[p.key];
    if (prev === undefined || prev === null || String(prev) !== v) continue;
    if (picked[p.key]) continue;
    const label = str(p.label).trim() || p.key;
    const name = formal(label);
    if (have.some((c) => c.field === name && c.text === v)) continue;
    out.push({ key: p.key, label, text: v, quote: `（開跑表單）${label}：${v}` });
  }
  return out;
}

// 記路②：停點同步連兩趟——前一趟那一步改過（edited_output 非 null），且這趟也改了（沒給這趟＝只看前趟）
export function stopEditSignal({ prevRun, run, nodeId } = {}) {
  const prevEdited = prevRun?.steps?.[nodeId]?.edited_output != null;
  const thisEdited = run == null || run.steps?.[nodeId]?.edited_output != null;
  return prevEdited && thisEdited;
}

// ---- 三問路由（M2；唯一的新 AI 呼叫）----
// 業務 prompt 只在 buildRoutePrompt 組；解析走 checker 的候選政策（全文一個池、含糊即失敗）；route() 失敗回 fail_note 不 throw。

export const MEMORY_ROUTE_RULES = [
  '你是「剝繭」的記憶整理員。使用者剛說了一句話，請照三個問題判它該記成什麼：',
  '1. 它是不是「欄位詞典」裡某一格的答案？是→第 2 問；不是→第 3 問。',
  '2. 換個場合他會不會填別的？會→對事，記成習慣卡（bucket 寫 habit，field 寫詞典裡那一格的正式名；詞典裡沒有但確實是某一格的答案，field 寫新名字並給 kind）；不會→對人，記成認識卡表達層（bucket 寫 profile，layer 寫 expression）。',
  '3. 講的是他和他的世界（他、他的人、他的處境），還是這一趟的內容？他的世界→認識卡內容層（bucket 寫 profile，layer 寫 content）；這一趟的內容→不記（bucket 寫 none）。',
  '複句拆成多張。不記觀點與立場；健康、政治、宗教、財務四類一律不記，除了「允許的敏感類別」列出的。text 用他的原意改寫成一句可以直接照做的話，不加東西。',
  '只輸出一個 JSON 物件，前後不要任何其他文字：{"cards":[{"bucket":"habit","field":"…","kind":null,"layer":null,"text":"…","reason":"…"}]}',
].join('\n');

// 敏感四類（settings.memory.sensitive 的鍵→中文名；開著的才列進「允許的敏感類別」）
export const SENSITIVE_LABELS = Object.freeze({ health: '健康', politics: '政治', religion: '宗教', finance: '財務' });
// 提示段：觸發點→這句是什麼、通常記成什麼（判斷仍照三問）
export const ROUTE_HINTS = Object.freeze({
  feedback: { what: '跑完的回饋', usually: '習慣卡' },
  'stop-note': { what: '停點註記', usually: '認識卡' },
  'stop-edit': { what: '停點註記', usually: '習慣卡' },
  chat: { what: '聊天', usually: '認識卡' },
});
const NONE_LINE = '（無）';
const ROUTE_BUCKETS = ['habit', 'profile', 'none'];
const ROUTE_MAX_CARDS = 3;

// 規則→他說的話→提示（有 hint 或場合才有）→欄位詞典→這條流程的欄位→允許的敏感類別。categories 收了不用：三問用不到分類清單
export function buildRoutePrompt({ text, dict, category = null, workflowName = null, paramLabels, hint = null, sensitive } = {}) {
  const h = ROUTE_HINTS[hint];
  const place = [category ? `分類「${category}」` : '', workflowName ? `流程「${workflowName}」` : ''].filter(Boolean).join('、');
  const hintLines = [];
  if (h) hintLines.push(`這句是${h.what}，通常記成${h.usually}；判斷仍照三問`);
  if (place) hintLines.push(`場合：${place}`);
  const fields = fieldsOf(dict).map((f) => {
    const syn = arr(f.synonyms).filter(Boolean);
    return `- ${f.name}（${FIELD_KINDS[f.kind] ?? FIELD_KINDS.method}${syn.length ? `；同義：${syn.join('、')}` : ''}）`;
  });
  const labels = arr(paramLabels).map((l) => str(l).trim()).filter(Boolean);
  const open = Object.entries(SENSITIVE_LABELS).filter(([k]) => sensitive?.[k] === true).map(([, name]) => `- ${name}`);
  return [
    MEMORY_ROUTE_RULES,
    '', '# 他說的話', str(text).trim(),
    ...(hintLines.length ? ['', '# 提示', ...hintLines] : []),
    '', '# 欄位詞典', fields.length ? fields.join('\n') : NONE_LINE,
    '', '# 這條流程的欄位', labels.length ? labels.map((l) => `- ${l}`).join('\n') : NONE_LINE,
    '', '# 允許的敏感類別', open.length ? open.join('\n') : NONE_LINE,
  ].join('\n');
}

// 逐張過濾：bucket 三選一；habit 要有 field；profile 要有 layer；text 非空（none 例外）；kind 只認六類，其餘 null
function normalizeRouteCard(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  if (!ROUTE_BUCKETS.includes(c.bucket)) return null;
  const text = str(c.text).trim();
  const field = str(c.field).trim() || null;
  const layer = PROFILE_LAYERS.includes(c.layer) ? c.layer : null;
  if (c.bucket === 'habit' && (!field || !text)) return null;
  if (c.bucket === 'profile' && (!layer || !text)) return null;
  return {
    bucket: c.bucket,
    field,
    kind: Object.hasOwn(FIELD_KINDS, c.kind) ? c.kind : null,
    layer: c.bucket === 'profile' ? layer : null,
    text,
    reason: str(c.reason).trim(),
  };
}

// 截尾修補（2026-09-25 實走抓到：模型偶發少收尾括號，整份 JSON 就不是候選）：忽略字串內的括號，數未關閉的 { [，
// 依序補 } ]，最多補 3 個。字串沒關、括號對不上、沒缺或缺太多＝修不了回 null。只在 extractJson 一份候選都挑不出時才用
export const JSON_REPAIR_MAX = 3;
export function repairJsonTail(text) {
  const s = str(text).trimEnd();
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const c of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') { if (stack.pop() !== c) return null; }
  }
  if (inString || !stack.length || stack.length > JSON_REPAIR_MAX) return null;
  return s + stack.reverse().join('');
}

// extractJson 一份都挑不出→補括號再挑一次；含糊（CheckParseError）照丟，不修
function extractJsonOrRepair(text, rank, normalize, ambiguousMessage) {
  const v = extractJson(text, rank, normalize, ambiguousMessage);
  if (v !== null) return v;
  const fixed = repairJsonTail(text);
  return fixed === null ? null : extractJson(fixed, rank, normalize, ambiguousMessage);
}

// 回覆→卡的清單（最多 3 張）。沒有像樣的 {"cards":[…]}／兩份內容不同的候選→CheckParseError（route() 接住變 fail_note）
export function parseRoute(text) {
  const v = extractJsonOrRepair(
    text,
    (x) => (x && typeof x === 'object' && !Array.isArray(x) && Array.isArray(x.cards) ? [1] : [0]),
    (x) => x.cards.map(normalizeRouteCard).filter(Boolean).slice(0, ROUTE_MAX_CARDS),
    '記憶整理員這次交了不只一份結果，分不出哪份是真的',
  );
  if (v === null) throw new CheckParseError('記憶整理員這次沒有交出看得懂的結果');
  return v;
}

// 卷宗回呼（比照 checker.notePrompt）：寫不進卷宗只是少一份紀錄，不該讓路由整個沒寫成
async function note(fn, value) {
  if (typeof fn !== 'function') return;
  try { await fn(value); } catch { /* 卷宗寫不進不擋路由 */ }
}
const humanReason = (e) => str(e?.message).trim() || '原因不明';
const failNote = (why) => `這句沒記成：${why}`;

// 送出→收回→解析。meta 強制 kind='memory'、phase='route'（不進三個用量桶，儀表板總量自動含）。
// 回 { ok:true, cards } 或 { ok:false, fail_note }；空句不打 AI；任何錯都接住，不 throw
export async function route({ adapter, meta, onPrompt, onReply, text, ...rest }) {
  const said = str(text).trim();
  if (!said) return { ok: false, fail_note: failNote('沒有句子可記') };
  try {
    const prompt = buildRoutePrompt({ text: said, ...rest });
    await note(onPrompt, prompt);
    const raw = str(await adapter.complete({ prompt, meta: { ...(meta ?? {}), kind: 'memory', phase: 'route' } }));
    await note(onReply, raw);
    return { ok: true, cards: parseRoute(raw) };
  } catch (e) {
    return { ok: false, fail_note: failNote(humanReason(e)) };
  }
}

// ---- 說明書問答（US-115）：五段、最多三輪、每輪最多三題。出題與寫草稿各是一次小 AI 呼叫，走 route() 同一個 adapter 通道
// （meta.kind='memory'，phase 分 manual-questions／manual-draft）；三輪與每輪三題由程式硬擋，不靠 AI 自律；AI 出不了題退備用題、寫不出草稿退原句。----

// 五段（順序固定）：「我是誰」內容層按場合帶，其餘四段表達層每步帶
export const MANUAL_SECTIONS = deepFreeze([
  { key: 'who', label: '我是誰', layer: 'content' },
  { key: 'talk', label: '怎麼跟我講話', layer: 'expression' },
  { key: 'ask', label: '什麼事要問我、什麼事自己決定', layer: 'expression' },
  { key: 'show', label: '什麼時候叫我看', layer: 'expression' },
  { key: 'redline', label: '紅線', layer: 'expression' },
]);
const MANUAL_SECTION_KEYS = MANUAL_SECTIONS.map((s) => s.key);
const sectionOf = (key) => MANUAL_SECTIONS.find((s) => s.key === key) ?? null;
export const MANUAL_ROUNDS_MAX = 3;
export const MANUAL_PER_ROUND_MAX = 3;
// 第一輪三題固定（參考物 2-a；US-115 ①②③），分別對 who／talk／ask
export const MANUAL_ROUND1 = deepFreeze([
  { id: 'r1-who', q: '你是誰、平常在做什麼？哪些東西你看不懂、或不想自己碰？', section: 'who' },
  { id: 'r1-talk', q: '你最常想請 AI 幫你做哪類事？它做出來的東西，通常哪裡讓你不滿意？', section: 'talk' },
  { id: 'r1-ask', q: '做事的時候，哪些事你一定要自己決定？哪些你希望它自己定、事後跟你講一聲就好？', section: 'ask' },
]);
// 備用題（參考物 2-b 三題的通用版；who／talk 補通用問法）：AI 出不了題時每段一題、只取還空的段
export const MANUAL_FALLBACK = deepFreeze({
  who: { q: '再多講一點你自己：你的角色、平常經手哪些事、哪些領域你不熟或不想自己碰？', why: '為什麼問：「我是誰」這段還空著' },
  talk: { q: '你希望它怎麼跟你講話？例如先講結論、不要術語、不要恭維——哪些是你受不了的？', why: '為什麼問：「怎麼跟我講話」這段還空著' },
  ask: { q: '措辭、排版、二選一都差不多的事，要它自己定就好，還是也先問你？', why: '為什麼問：「什麼事要問我」這段還缺「什麼可以不問」' },
  show: { q: '它做到一半，什麼時候你想被叫來看？每一步都看、只看做完的成品、還是只有出問題才叫你？', why: '為什麼問：「什麼時候叫我看」這段是空的' },
  redline: { q: '有沒有不管做什麼都絕對不准的事？例如不准自己編數字、不准動你原文的口吻。', why: '為什麼問：「紅線」這段是空的' },
});
// 禁問關鍵字：給誰看／什麼形式／多長是分類層的事（ADR-012 第 3 條）；健康／政治／宗教／財務照 US-064 不記。AI 出的題含這些字＝剔掉
export const MANUAL_BANNED = Object.freeze(['給誰看', '讀者', '對象', '什麼形式', '型態', '多長', '長度', '頁數', '健康', '政治', '宗教', '財務']);
const MANUAL_TRANSCRIPT_MAX = MANUAL_ROUNDS_MAX * MANUAL_PER_ROUND_MAX; // 三輪×三題＝最多 9 筆問答
const MANUAL_ANSWER_MAX = 2000; // 一題答案的字數上限（用講的，不是貼文件）
const MANUAL_LINE_MAX = 200; // 說明書一行＝一句可直接照做的話（跟「一句話才成卡」同一條門檻）
const MANUAL_LINES_MAX = 50; // 五段合計最多存幾行

const err400 = (message) => Object.assign(new Error(message), { status: 400 });

// 2026-09-25 實走抓到：輕裝系統提示只說「語言跟訊息一致」，第二輪題目整段飄成簡體。兩支提示都硬要求繁體；
// 回覆再過一道保險——含常見簡體字就當「看不懂」走既有退路（備用題／原句落地），寧可退備用也不把簡體存進說明書。
// 名單裡的 于／后 在繁體也偶爾出現（姓氏、皇后），誤判＝退備用，不會壞資料
export const TRADITIONAL_RULE = '一律用繁體中文（台灣用語），不准出現簡體字。';
export const SIMPLIFIED_CHARS = Object.freeze([...(
  '么这说会为决对让问时间应还没过动东后们个关于发现该经验请报单' // 發單者指定的最少名單
  + '设负责认识议论语书写读长门开车员业产务类术数据结处层电网页点线图标题规则总备选择义种样从与谁两几万钱买卖价计划' // 常見補充
)]);
const SIMPLIFIED_RE = new RegExp(`[${SIMPLIFIED_CHARS.join('')}]`);
export const hasSimplified = (text) => SIMPLIFIED_RE.test(str(text));
const rejectSimplified = (what) => { throw new CheckParseError(`說明書助手這次用了簡體字，${what}不收`); };
const roundOr = (v) => (Number.isInteger(v) && v >= 1 && v <= MANUAL_ROUNDS_MAX ? v : null);

// 問答紀錄→乾淨清單：沒答的題（跳過）不算；round 只認 1～3、section 只認五段（其餘 null）；問與答去前後空白
export function normalizeTranscript(transcript) {
  return arr(transcript)
    .filter((t) => t && typeof t === 'object' && !Array.isArray(t))
    .map((t) => ({ round: roundOr(t.round), q: str(t.q).trim(), section: MANUAL_SECTION_KEYS.includes(t.section) ? t.section : null, a: str(t.a).trim() }))
    .filter((t) => t.a);
}

// 進門第一關（輸入面向）：要是清單、最多 9 筆、每題答案不超過 2000 字；不合法丟 400 並講哪裡不對
function checkTranscript(transcript) {
  if (!Array.isArray(transcript)) throw err400('問答紀錄要是清單（每筆含 round、q、section、a）');
  if (transcript.length > MANUAL_TRANSCRIPT_MAX) throw err400(`問答最多 ${MANUAL_TRANSCRIPT_MAX} 筆（三輪、每輪三題），這次給了 ${transcript.length} 筆`);
  for (const t of transcript) if (str(t?.a).length > MANUAL_ANSWER_MAX) throw err400(`一題的答案最多 ${MANUAL_ANSWER_MAX} 字，用講的就好`);
  return normalizeTranscript(transcript);
}

// 已被答案覆蓋的段（有答案、且題目對到五段之一）
export function manualCovered(transcript) {
  return new Set(normalizeTranscript(transcript).map((t) => t.section).filter(Boolean));
}

const sectionLines = () => MANUAL_SECTIONS.map((s) => `- ${s.key}＝${s.label}`);
const transcriptLines = (t) => t.map((x) => `第 ${x.round ?? '?'} 輪｜段落 ${x.section ?? '（沒對到段）'}｜問：${x.q || '（沒有題目）'}｜答：${x.a}`);

// 出題那次呼叫的交代（參考物「它出題時照的規矩」表）：目標五段→只問空的→每題附理由→禁問→只輸出一個 JSON；上限由程式擋，這裡只是告知
export function buildManualQuestionPrompt({ transcript, round } = {}) {
  const t = normalizeTranscript(transcript);
  const covered = new Set(t.map((x) => x.section).filter(Boolean));
  const empty = MANUAL_SECTIONS.filter((s) => !covered.has(s.key)).map((s) => `- ${s.key}＝${s.label}`);
  return [
    '你是「剝繭」的說明書助手。使用者正在回答幾輪問題，剝繭要把答案寫成一份「怎麼跟我合作」的說明書，分五段：',
    ...sectionLines(),
    `請看「已答的問答」，判斷五段哪幾段還空或還模糊，只針對那幾段出第 ${round} 輪的題目，最多 ${MANUAL_PER_ROUND_MAX} 題；夠的段不問。`,
    '每題附一句理由，格式「為什麼問：你剛說⋯，所以想確認⋯」，讓他知道不是亂問。用他聽得懂的話問，不用術語。',
    `禁問（出了也會被剔掉）：${MANUAL_BANNED.join('、')}——給誰看、什麼形式、多長是分類層的事；健康、政治、宗教、財務一律不問。`,
    TRADITIONAL_RULE,
    '五段都夠了就回 {"done":true,"why":"一句話說為什麼夠了"}。',
    '只輸出一個 JSON 物件，前後不要任何其他文字：{"questions":[{"q":"…","why":"為什麼問：…","section":"who|talk|ask|show|redline"}]}',
    '', '# 已答的問答', ...(t.length ? transcriptLines(t) : [NONE_LINE]),
    '', '# 還空的段落', ...(empty.length ? empty : [NONE_LINE]),
  ].join('\n');
}

// 回覆→{done, why} 或 {questions:[{q, why, section}]}（q 空、section 不在五段的剔掉）。像樣的候選一個都沒有→CheckParseError
export function parseManualQuestions(text) {
  if (hasSimplified(text)) rejectSimplified('題目');
  const v = extractJsonOrRepair(
    text,
    (x) => (x && typeof x === 'object' && !Array.isArray(x) && (x.done === true || Array.isArray(x.questions)) ? [1] : [0]),
    (x) => (x.done === true
      ? { done: true, why: str(x.why).trim() }
      : { questions: x.questions.map((q) => (q && typeof q === 'object' && str(q.q).trim() && MANUAL_SECTION_KEYS.includes(q.section)
        ? { q: str(q.q).trim(), why: str(q.why).trim(), section: q.section } : null)).filter(Boolean) }),
    '說明書助手這次交了不只一份題目，分不出哪份是真的',
  );
  if (v === null) throw new CheckParseError('說明書助手這次沒有交出看得懂的題目');
  return v;
}

// 程式硬擋：只留還沒被覆蓋的段、含禁問字的剔掉、最多 3 題；每題編 id（r<輪>-<序>）
export function guardManualQuestions(questions, covered, round) {
  const has = covered instanceof Set ? covered : new Set(arr(covered));
  return arr(questions)
    .filter((q) => q && !has.has(q.section) && !MANUAL_BANNED.some((w) => q.q.includes(w)))
    .slice(0, MANUAL_PER_ROUND_MAX)
    .map((q, i) => ({ id: `r${round}-${i + 1}`, q: q.q, why: q.why, section: q.section }));
}

// 備用題：還空的段各一題（五段順序）、最多 3 題；五段都覆蓋＝空清單（呼叫端當 done）
export function fallbackManualQuestions(covered, round) {
  const has = covered instanceof Set ? covered : new Set(arr(covered));
  return MANUAL_SECTIONS.filter((s) => !has.has(s.key)).slice(0, MANUAL_PER_ROUND_MAX)
    .map((s, i) => ({ id: `r${round}-fb-${i + 1}`, q: MANUAL_FALLBACK[s.key].q, why: MANUAL_FALLBACK[s.key].why, section: s.key }));
}

// 寫草稿那次呼叫的交代：每行一句可直接照做的話、用他的意思改寫不加東西、標第幾輪；敏感四類只寫允許的
export function buildManualDraftPrompt({ transcript, sensitive } = {}) {
  const t = normalizeTranscript(transcript);
  const open = Object.entries(SENSITIVE_LABELS).filter(([k]) => sensitive?.[k] === true).map(([, name]) => `- ${name}`);
  return [
    '你是「剝繭」的說明書助手。把使用者幾輪問答的答案寫成一份「怎麼跟我合作」的說明書草稿，分五段：',
    ...sectionLines(),
    '規矩：每行一句可以直接照做的話；用他的意思改寫，不加他沒說的東西；每行標第幾輪說的（round＝1～3）；他沒講到的段落 lines 留空陣列，不要自己補；',
    '不寫觀點與立場；健康、政治、宗教、財務一律不寫，除了「允許的敏感類別」列出的；「給誰看、什麼形式、多長」不屬於這份說明書，不寫。',
    TRADITIONAL_RULE,
    '只輸出一個 JSON 物件，前後不要任何其他文字：{"sections":[{"key":"who","lines":[{"text":"…","round":1}]},{"key":"talk","lines":[]},{"key":"ask","lines":[]},{"key":"show","lines":[]},{"key":"redline","lines":[]}]}',
    '', '# 他的問答', ...(t.length ? transcriptLines(t) : [NONE_LINE]),
    '', '# 允許的敏感類別', open.length ? open.join('\n') : NONE_LINE,
  ].join('\n');
}

// 一行草稿正規化：text 去空白、空的剔掉、round 只認 1～3（其餘 null）
const normalizeLine = (l) => {
  const text = str(l && typeof l === 'object' ? l.text : l).trim();
  return text ? { text, round: roundOr(l?.round) } : null;
};
const emptySections = () => MANUAL_SECTIONS.map((s) => ({ key: s.key, label: s.label, lines: [] }));

// 回覆→五段固定順序（缺的段補空；不在五段的段丟掉）。像樣的候選一個都沒有→CheckParseError
export function parseManualDraft(text) {
  if (hasSimplified(text)) rejectSimplified('草稿');
  const v = extractJsonOrRepair(
    text,
    (x) => (x && typeof x === 'object' && !Array.isArray(x) && Array.isArray(x.sections) ? [1] : [0]),
    (x) => {
      const out = emptySections();
      for (const s of x.sections) {
        const hit = s && typeof s === 'object' ? out.find((o) => o.key === s.key) : null;
        if (hit) hit.lines.push(...arr(s.lines).map(normalizeLine).filter(Boolean));
      }
      return out;
    },
    '說明書助手這次交了不只一份草稿，分不出哪份是真的',
  );
  if (v === null) throw new CheckParseError('說明書助手這次沒有交出看得懂的草稿');
  return v;
}

// 寫草稿的退路：各輪答案照題目所屬段落原句放進去，一題一行、標輪次；沒對到段的答案放不進任何段
export function fallbackManualDraft(transcript) {
  const out = emptySections();
  for (const t of normalizeTranscript(transcript)) {
    const hit = out.find((o) => o.key === t.section);
    if (hit) hit.lines.push({ text: t.a, round: t.round });
  }
  return out;
}

// 卡的出處原話：（說明書第 N 輪）內容；沒輪次（他自己加的行）＝（說明書）內容。manual() 從這裡讀回輪次
const manualQuote = (text, round) => `（說明書${round ? `第 ${round} 輪` : ''}）${text}`;
const roundOfQuote = (quote) => { const m = /^（說明書第 (\d) 輪）/.exec(str(quote)); return m ? Number(m[1]) : null; };

// ---- 門面（M1b 起）：拿 store 做的組合動作。四條記路的落地在這（M2）；每步要帶的（contextFor，M3a）；點了即核可與範圍擴大（accountPicks，M3b）----

// 介紹三題：前兩題（你是誰、給誰看）＝內容層，第三題（最受不了什麼）＝表達層；答案原文就是卡的內容
export const INTRO_QUESTIONS = Object.freeze([
  { key: 'who', layer: 'content' },
  { key: 'audience', layer: 'content' },
  { key: 'dislike', layer: 'expression' },
]);

const dateOnly = (ms) => new Date(ms).toISOString().slice(0, 10);
// 活著＝active 且沒過期（expires 空＝永久；到期日當天還算）
const isLive = (c, today) => c.status === 'active' && (c.expires == null || String(c.expires) >= today);
const byCreated = (a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));

// ---- 拿（M3a）：選卡與外圈蓋內圈（純函式，零 AI）----

// 內容層按場合帶幾張（確認書 §十四 第 2 項：只用「場合對上＋最近用過」）
export const CONTENT_TOP = 3;

// 這一步要帶的認識卡（扁平清單，表達層在前）：整層暫停→空；否則 active、未過期、有身分時只留身分裡列的；
// 表達層全帶依 created_at；內容層只留場合對上的（全部／同分類／同流程），依 last_used_at 新→舊取前 CONTENT_TOP 張——
// 沒用過的拿 created_at 當「最近」，不然剛記的內容卡永遠排不進來
export function selectCore({ profileCards, category = null, workflowId = null, paused = false, identity = null, today = dateOnly(Date.now()) } = {}) {
  if (paused) return [];
  const allowed = identity ? new Set(arr(identity.cards)) : null;
  const live = arr(profileCards).filter((c) => c?.bucket === 'profile' && isLive(c, today) && (!allowed || allowed.has(c.id)));
  const recent = (c) => String(c.last_used_at ?? c.created_at ?? '');
  const content = live
    .filter((c) => c.layer === 'content' && coversWorkflow(c, { category, workflow: workflowId }))
    .sort((a, b) => recent(b).localeCompare(recent(a)) || byCreated(b, a))
    .slice(0, CONTENT_TOP);
  return [...live.filter((c) => c.layer === 'expression').sort(byCreated), ...content];
}

// 有名字的項目外圈取代內圈（核心＜群組＜流程預設＜這一次的值），自由規矩疊加。「有名字」＝卡或群組條的 field 非空，
// 欄位名經詞典對回正式名再比（沒詞典就照字面）。這一次的值＝開跑表單填的、跟流程預設不同的；等於預設＝值是流程給的，算流程那一圈。
// 被蓋掉的核心卡／群組條不進工作單，記進 overridden（by＝蓋它的那一圈、by_text＝那個值）；used＝真的帶進去的（核心在前、群組在後）
export function resolveOverrides({ core, group, def, params, dict = null } = {}) {
  const formal = (name) => { const n = str(name).trim(); return n && dict ? (matchField(dict, n)?.name ?? n) : n; };
  const outer = new Map(); // 正式名→{ by, text }：流程預設先放，這一次的值蓋上去
  for (const p of arr(def?.params)) {
    const f = formal(p?.label);
    if (!f) continue;
    const d = str(p.default).trim();
    const v = str(params?.[p.key]).trim();
    if (v && v !== d) outer.set(f, { by: 'run', text: v });
    else if (d) outer.set(f, { by: 'workflow', text: d });
  }
  const groupVals = new Map();
  const g = { lines: [], used: [], overridden: [] };
  for (const r of arr(group)) {
    if (!r || r.status !== 'active') continue;
    const f = formal(r.field);
    const hit = f ? outer.get(f) : null;
    if (hit) { g.overridden.push({ id: r.id, text: r.text, by: hit.by, by_text: hit.text }); continue; }
    if (f && !groupVals.has(f)) groupVals.set(f, { by: 'group', text: str(r.value) });
    g.lines.push(r.text);
    g.used.push({ id: r.id, bucket: 'group', text: r.text, field: r.field ?? null, level: 'category' });
  }
  const c = { lines: [], used: [], overridden: [] };
  for (const card of arr(core)) {
    if (!card) continue;
    const f = formal(card.field);
    const hit = f ? (outer.get(f) ?? groupVals.get(f)) : null;
    if (hit) { c.overridden.push({ id: card.id, text: card.text, by: hit.by, by_text: hit.text }); continue; }
    c.lines.push(card.text);
    c.used.push({ id: card.id, bucket: 'profile', text: card.text, layer: card.layer ?? null, level: card.scope?.level ?? null });
  }
  return { coreLines: c.lines, groupLines: g.lines, used: [...c.used, ...g.used], overridden: [...c.overridden, ...g.overridden] };
}

// ---- 拿（M3b）：開跑表單的習慣選項（純函式）----

// 每個欄位旁的選項：{ [key]: { covers, probes } }。covers＝活著的習慣卡、field 對到這欄（詞典同義詞也算）、範圍涵蓋這條流程；
// probes＝同欄位、同分類另一條流程的 workflow 尺度卡（虛線，多 from＝來源流程名；沒對照表就用流程 id）。
// 沒卡的欄位沒有鍵；每欄回全部，截 3 由前端做
export function habitOptions({ habitCards, def, category = null, workflowId = null, dict = null, workflowNames = {}, today = dateOnly(Date.now()) } = {}) {
  const formal = (name) => { const n = str(name).trim(); return n && dict ? (matchField(dict, n)?.name ?? n) : n; };
  const here = { category, workflow: workflowId };
  const live = arr(habitCards).filter((c) => c?.bucket === 'habit' && isLive(c, today) && str(c.field).trim());
  const out = {};
  for (const p of arr(def?.params)) {
    const f = formal(p?.label);
    if (!f || !p?.key) continue;
    const same = live.filter((c) => formal(c.field) === f);
    const covers = same.filter((c) => coversWorkflow(c, here));
    const probes = same
      .filter((c) => c.scope?.level === 'workflow' && c.scope.category != null && c.scope.category === category && c.scope.workflow !== workflowId)
      .map((c) => ({ ...c, from: workflowNames?.[c.scope.workflow] ?? c.scope.workflow }));
    if (covers.length || probes.length) out[p.key] = { covers, probes };
  }
  return out;
}

const EMPTY_RUN_MEMORY = () => ({ identity: null, picks: {}, changed: [], prev_run: null, notices: [] });

export function createMemory({ store, adapter = null, now = () => Date.now() } = {}) {
  const nowIso = () => new Date(now()).toISOString();

  // 聊天記路的去重（實測補的）：拆解器第二趟每跑一次就路由一次最後那句話，
  // 而 AI 每次改寫出來的文字都不一樣，所以既有的「同值比對」擋不住——同一句話跑兩次會記成兩組意思一樣的卡
  // （實測 0 → 3 → 6 張）。用句子本身的指紋擋：一模一樣的句子只記一次；使用者換句話說是新的意思，照記。
  const chatFingerprint = (text, category) => {
    const s = String(text ?? '').replace(/\s+/g, '').trim();
    if (!s) return null;
    const key = (category ?? '') + '\u0000' + s;
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  };
  const readChatSeen = () => { try { return store.readMemoryState?.('chat-seen') ?? []; } catch { return []; } };
  const seenChat = (fp) => readChatSeen().includes(fp);
  const markChat = (fp) => {
    try {
      const list = readChatSeen().filter((x) => x !== fp);
      list.push(fp);
      store.writeMemoryState?.('chat-seen', list.slice(-200)); // 只留最近 200 筆，檔案不會長大
    } catch { /* 存不進去就當沒去重：寧可多記，也不要因為寫不了檔就不記 */ }
  };

  // 一行通知寫進 run.memory.notices：同步 readRun→改→writeRun（單執行緒同步 fs，與 runner.update() 不交錯），只碰這一欄。
  // 舊 run 沒有 memory 欄＝補一個空殼再塞
  function noteOnRun(category, id, runId, { kind, card = null, text }) {
    const notice = { at: nowIso(), kind, card, text, undone: false };
    const r = store.readRun(category, id, runId);
    r.memory ??= EMPTY_RUN_MEMORY();
    (r.memory.notices ??= []).push(notice);
    store.writeRun(category, id, runId, r);
    return notice;
  }

  // 卷宗 logs/memory/<ts>[-<category>-<id>]：指示與回覆同名、回覆多 .reply（跟 server.logPair 同規矩；沒有 run 的呼叫也有紀錄）
  function logPair(category, id) {
    const tail = [category, id].filter(Boolean).map((s) => `-${s}`).join('');
    let name = null;
    return {
      onPrompt: (t) => { name = `${nowIso().replace(/:/g, '-')}${tail}`; store.writeLog('memory', name, t); },
      onReply: (t) => { if (name) store.writeLog('memory', `${name}.reply`, t); },
    };
  }

  const readRunOr = (category, id, runId) => { try { return store.readRun(category, id, runId); } catch { return null; } };
  const sensitiveNow = () => { try { return store.readSettings().memory.sensitive; } catch { return {}; } };

  // 通知的一句：習慣卡講用在哪、下次開跑當選項；認識卡講每步帶還是按場合帶
  const cardNotice = (card, { wfName = null, why }) => (card.bucket === 'habit'
    ? `習慣卡「${card.field}：${card.text}」${wfName ? `，用在「${wfName}」` : ''}。${why} · 下次開跑當選項`
    : `認識卡「${card.text}」，${card.layer === 'expression' ? '每步帶' : '按場合帶'}。${why}`);

  // 路由結果落地：習慣卡的欄位對不上詞典就先長出來（先寫詞典再寫卡）；認識卡的 field 只在詞典對得到時帶；
  // 每張過 validateCard 才寫，不合格的只留 console 一句。force='profile'＝不管路由怎麼判都成認識卡（「以後都」）
  // 這一格有沒有「家」＝有沒有任何一條流程的開跑表單有這個欄位。習慣卡只在對得上的欄位下面出 chip，
  // 沒有家的卡就永遠出不來。**不能拿詞典當判準**：詞典會累積路由自己發明出來的格，等於自己給自己開後門
  // ——2026-09-19 實測踩到（第一次發明「住宿位置」進了詞典，之後每一張同格的卡都被判成「有家」）。
  // 讀不到流程庫＝當作沒有家（寧可記成認識卡，至少帶得進工作單）。
  function fieldHasHome(dict, field) {
    const want = str(matchField(dict, field)?.name ?? field).trim();
    if (!want) return false;
    let list = [];
    try { list = store.listWorkflows(); } catch { return false; }
    for (const w of list) {
      let def = null;
      try { def = store.readWorkflow(w.category, w.id); } catch { continue; }
      for (const p of arr(def?.params)) {
        const label = str(p?.label).trim();
        if (label && str(matchField(dict, label)?.name ?? label) === want) return true;
      }
    }
    return false;
  }

  function land(cards, { category, id, runId, node, quote, scopeFor, sourceFor, force = null }) {
    let dict = store.readDict();
    let dictChanged = false;
    const at = nowIso();
    const written = [];
    let sawNone = false;
    for (const rc of cards) {
      let c = rc;
      if (force === 'profile' && c.bucket !== 'profile') c = { ...c, bucket: 'profile', layer: c.layer ?? 'expression', text: c.text || quote };
      if (c.bucket === 'none') { sawNone = true; continue; }
      const input = {
        bucket: c.bucket, text: c.text, scope: scopeFor(c.bucket), route_reason: c.reason,
        source: { kind: sourceFor(c.bucket), category, workflow: id, run: runId, node, at, quote },
      };
      const hit = c.field ? matchField(dict, c.field) : null;
      if (c.bucket === 'habit') {
        if (fieldHasHome(dict, c.field)) {
          if (!hit) { dict = ensureFields(dict, [{ label: c.field, kind: c.kind }], { category, workflow: id }, at).dict; dictChanged = true; }
          input.field = hit?.name ?? c.field;
        } else {
          // 沒有家的格＝沒有任何流程的開跑表單有這個欄位，做成習慣卡就沒有
          // chip 的位置：開跑表單上永遠不會出現，通知卻已經說了「下次開跑當選項」。改記成認識卡內容層——
          // 它講的本來就是偏好，按場合帶進每一步立刻有用（2026-09-19 劇本實走，裁示「這是記憶問題」）。
          // 詞典照樣長那一格：拆解器看得到，以後的流程拆得出這個欄位，那時再由使用者設成開跑選項。
          dict = ensureFields(dict, [{ label: c.field, kind: c.kind }], { category, workflow: id }, at).dict;
          dictChanged = true;
          input.bucket = 'profile';
          input.layer = 'content';
          input.field = c.field;
          input.scope = scopeFor('profile');
          input.source = { ...input.source, kind: sourceFor('profile') };
        }
      } else {
        input.layer = c.layer;
        if (hit) input.field = hit.name;
      }
      const card = makeCard(input, at);
      const errs = validateCard(card, dict);
      if (errs.length) { console.error('[bojian] 記憶：這張卡沒存成——', errs.join('；')); continue; }
      written.push(card);
    }
    if (dictChanged) store.writeDict(dict);
    for (const card of written) store.writeCard(card);
    return { written, sawNone };
  }

  // 一句話→路由→落地→通知清單（card 一張一則；沒卡＝none 或 fail 一則）。這裡不寫 run，由呼叫端決定要不要記到哪一趟
  async function routeAndLand({ text, hint, category, id, runId = null, node = '_memory', def = null, force = null, scopeFor, sourceFor, why }) {
    const res = await route({
      adapter, meta: { category, workflow: id, run: runId, node }, ...logPair(category, id),
      text, dict: store.readDict(), category, workflowName: def?.name ?? null,
      paramLabels: (def?.params ?? []).map((p) => p?.label), hint, sensitive: sensitiveNow(),
    });
    if (!res.ok) return [{ kind: 'fail', card: null, text: res.fail_note }];
    const { written, sawNone } = land(res.cards, { category, id, runId, node, quote: str(text).trim(), scopeFor, sourceFor, force });
    if (written.length) return written.map((c) => ({ kind: 'card', card: c.id, text: cardNotice(c, { wfName: def?.name ?? null, why }) }));
    if (sawNone) return [{ kind: 'none', card: null, text: '這句沒記：它講的是這一趟的內容，不是你的習慣或你的情況' }];
    return [{ kind: 'fail', card: null, text: failNote('整理出來的卡不合格') }];
  }

  const stamp = (n) => ({ at: nowIso(), ...n, undone: false });
  const failStamp = (e) => stamp({ kind: 'fail', card: null, text: failNote(humanReason(e)) });
  // 流程名（通知與虛線 chip 的「來自「某流程」」）：讀不到＝用 id
  const nameOf = (category, wfId) => { try { return store.readWorkflow(category, wfId)?.name || wfId; } catch { return wfId; } };
  // 通知顯示用：分類名本身已以「分類」結尾（資料值「未分類」）就不再加尾綴，免得拼成「未分類分類」；資料值不動
  const catText = (c) => (String(c ?? '').endsWith('分類') ? String(c ?? '') : `${c}分類`);

  // 這一趟每一步要帶的（M3a，runner 在 runUntilPause 開頭叫一次——卡、群組、欄位值都是趟級的，每步一樣）：
  // 選卡（暫停、身分、過期）→外圈蓋內圈→兩段文字＋這步用了哪幾條；picks＝開跑表單點的習慣卡（欄位 key→卡），
  // 由 runner 依每步引用的 {{欄位}} 挑。身分找不到、群組檔壞、卡讀不到＝當沒有；詞典或設定讀不到才整個丟出去（runner 接住＝這趟不帶）
  function contextFor({ category, id, def = null, params = {}, identity = null, picks = {}, settings = null } = {}) {
    const paused = (settings ?? store.readSettings()).memory?.paused === true;
    let idn = null;
    if (identity) { try { idn = store.readIdentities().find((i) => i?.id === identity) ?? null; } catch { /* 身分讀不到＝不限縮 */ } }
    let group = null;
    try { group = store.readGroup(category); } catch { /* 群組檔壞＝沒有群組圈 */ }
    let profileCards = [];
    try { profileCards = store.listCards('profile'); } catch (e) { console.error('[bojian] 記憶卡讀不到，這趟不帶關於你：', e.message); /* 只丟關於你，群組規矩照帶 */ }
    const core = selectCore({ profileCards, category, workflowId: id, paused, identity: idn, today: dateOnly(now()) });
    const inj = resolveOverrides({ core, group: group?.rules, def, params, dict: store.readDict() });
    const picked = {};
    for (const [key, cardId] of Object.entries(picks ?? {})) {
      try {
        const c = store.readCard('habit', cardId);
        if (c?.id) picked[key] = { id: c.id, bucket: 'habit', text: c.text, field: c.field ?? null, level: c.scope?.level ?? null };
      } catch { /* 點的卡已經不在＝不算這一步用了它 */ }
    }
    // 說明書五段分組（US-115／US-117 ①）：只放這一步真的帶進去（inj.used）、且有 section 的認識卡，各段照 created_at；
    // coreNotes 逐字照舊（含沒 section 的舊卡），manual 只是另一個切面，不改既有輸出
    const byId = new Map(core.map((c) => [c.id, c]));
    const manual = Object.fromEntries(MANUAL_SECTION_KEYS.map((k) => [k, []]));
    const usedManual = inj.used.filter((u) => u.bucket === 'profile').map((u) => byId.get(u.id)).filter((c) => c && MANUAL_SECTION_KEYS.includes(c.section)).sort(byCreated);
    for (const c of usedManual) manual[c.section].push(c.text);
    return { coreNotes: inj.coreLines, groupRules: inj.groupLines, groupName: category, cards: inj.used, overridden: inj.overridden, picks: picked, paused, manual, redlines: manual.redline };
  }

  // ---- 說明書問答（US-115）----

  // 設定 › 記憶 › 關於你 與引導卡第 2 步的資料源：五段各列 active 且有 section 的認識卡（照 created_at），輪次從出處原話讀回
  function manual() {
    const settings = store.readSettings();
    const cards = store.listCards('profile').filter((c) => c.status === 'active' && MANUAL_SECTION_KEYS.includes(c.section)).sort(byCreated);
    return {
      intro_done: settings.memory.intro_done_at != null,
      rounds_max: MANUAL_ROUNDS_MAX,
      per_round_max: MANUAL_PER_ROUND_MAX,
      round1: MANUAL_ROUND1.map((q) => ({ ...q })),
      sections: MANUAL_SECTIONS.map((s) => ({
        key: s.key, label: s.label, layer: s.layer,
        lines: cards.filter((c) => c.section === s.key).map((c) => ({ card: c.id, text: c.text, round: roundOfQuote(c.source?.quote) })),
      })),
    };
  }

  // 一次小 AI 呼叫（走 route() 同一個 adapter 通道、同一套卷宗）：回原文字串；沒有 adapter＝回 null；任何錯都接住回 null（呼叫端退備用）
  async function askManual(phase, prompt, tail) {
    if (!adapter?.complete) return null;
    const { onPrompt, onReply } = logPair('manual', tail);
    try {
      await note(onPrompt, prompt);
      const raw = str(await adapter.complete({ prompt, meta: { kind: 'memory', phase } }));
      await note(onReply, raw);
      return raw;
    } catch (e) {
      console.error(`[bojian] 說明書（${phase}）AI 沒回好，退備用：`, humanReason(e));
      return null;
    }
  }

  // 第二、三輪出題：五段都覆蓋→不打 AI 直接 done；否則一次 AI 呼叫→硬擋（覆蓋段不問、禁問字剔掉、最多 3 題）；
  // AI 壞掉／看不懂／剔完是空→備用題（只取還空的段）。round 不是 2 或 3、紀錄不合法→400
  async function manualRound({ round, transcript } = {}) {
    if (!Number.isInteger(round) || round < 2 || round > MANUAL_ROUNDS_MAX) throw err400(`第 2、3 輪才由它出題（round 只能是 2 或 ${MANUAL_ROUNDS_MAX}）`);
    const t = checkTranscript(transcript);
    const covered = new Set(t.map((x) => x.section).filter(Boolean));
    if (MANUAL_SECTION_KEYS.every((k) => covered.has(k))) return { done: true, why: '五段都有內容了，直接寫草稿' };
    const raw = await askManual('manual-questions', buildManualQuestionPrompt({ transcript: t, round }), `round${round}`);
    if (raw !== null) {
      try {
        const parsed = parseManualQuestions(raw);
        if (parsed.done) return { done: true, why: parsed.why || '五段都夠了' };
        const kept = guardManualQuestions(parsed.questions, covered, round);
        if (kept.length) return { questions: kept };
      } catch (e) {
        console.error('[bojian] 說明書出題回覆看不懂，退備用題：', humanReason(e));
      }
    }
    const fallback = fallbackManualQuestions(covered, round);
    return fallback.length ? { questions: fallback } : { done: true, why: '五段都有內容了，直接寫草稿' };
  }

  // 寫草稿：一次 AI 呼叫→五段；AI 壞掉／看不懂／五段全空→各輪答案照題目段落原句放進去
  async function manualDraft({ transcript } = {}) {
    const t = checkTranscript(transcript);
    const raw = await askManual('manual-draft', buildManualDraftPrompt({ transcript: t, sensitive: sensitiveNow() }), 'draft');
    if (raw !== null) {
      try {
        const sections = parseManualDraft(raw);
        if (sections.some((s) => s.lines.length)) return { sections };
      } catch (e) {
        console.error('[bojian] 說明書草稿回覆看不懂，退原句：', humanReason(e));
      }
    }
    return { sections: fallbackManualDraft(t) };
  }

  // 存說明書：先全部驗過（段落鍵、行數、行長）一張都不寫→既有「有 section 的 active 認識卡」全部退休（新卡取代舊卡）→
  // 逐行寫新卡（bucket profile、section、layer 照五段表、scope 全部、source.kind='intro'、quote 帶輪次）→寫 intro_done_at。空行不存
  function manualSave({ sections } = {}) {
    if (!Array.isArray(sections)) throw err400('要給五段的內容（sections 清單，每段含 key 與 lines）');
    const at = nowIso();
    const cards = [];
    for (const s of sections) {
      const sec = s && typeof s === 'object' ? sectionOf(s.key) : null;
      if (!sec) throw err400(`沒有「${str(s?.key) || '（空）'}」這一段：只有 ${MANUAL_SECTION_KEYS.join('、')}`);
      if (s.lines != null && !Array.isArray(s.lines)) throw err400(`「${sec.label}」的內容要是清單（一行一筆）`);
      for (const raw of arr(s.lines)) {
        const line = normalizeLine(raw);
        if (!line) continue;
        if (line.text.length > MANUAL_LINE_MAX) throw err400(`「${sec.label}」有一行超過 ${MANUAL_LINE_MAX} 字：一行寫一句可以直接照做的話，長的拆成幾行`);
        const card = makeCard({
          bucket: 'profile', text: line.text, layer: sec.layer, section: sec.key, scope: { level: 'all' },
          source: { kind: 'intro', at, quote: manualQuote(line.text, line.round) }, route_reason: '你的說明書，逐行存成認識卡',
        }, at);
        const errs = validateCard(card);
        if (errs.length) throw err400(`「${sec.label}」有一行存不成：${errs.join('；')}`);
        cards.push(card);
      }
    }
    if (cards.length > MANUAL_LINES_MAX) throw err400(`說明書最多 ${MANUAL_LINES_MAX} 行，這次有 ${cards.length} 行`);
    for (const c of store.listCards('profile')) {
      if (c.status === 'active' && MANUAL_SECTION_KEYS.includes(c.section)) store.writeCard({ ...c, status: 'retired' });
    }
    for (const c of cards) store.writeCard(c);
    const settings = store.readSettings();
    settings.memory.intro_done_at = at;
    store.writeSettings(settings);
    return { saved: cards.length, sections: manual().sections };
  }

  // 點了即核可、範圍靠證據擴大（M3b）：picks 逐張＝被選（被選次數、最近用、連續未選歸零）；同一張同時在 picks 與 changed＝選了優先
  //（不算改掉）；changed 的卡＝出現過＋改掉一次（shown_count、changed_count 各＋1），連續未選不動——有互動就不是「被無視」，
  // 休眠只給出現了、沒點、也沒改的（連續未選滿五次）。被選的卡範圍不涵蓋這條流程＝證據，往外擴：
  // 同分類別條流程的→分類；其餘（含一開始就跨分類）一步到全部；每擴一次寫一行 widen 通知。點的卡已經不在＝跳過
  function accountPicks({ category, id, run }) {
    const at = nowIso();
    const here = { category, workflow: id };
    const pickedIds = new Set(Object.values(run.memory?.picks ?? {}).filter((v) => typeof v === 'string' && v));
    const changedIds = new Set(arr(run.memory?.changed).filter((v) => typeof v === 'string' && v && !pickedIds.has(v)));
    const options = habitOptions({ habitCards: store.listCards('habit'), def: run.def, category, workflowId: id, dict: store.readDict(), today: dateOnly(now()) });
    const shownIds = new Set(Object.values(options).flatMap((o) => [...o.covers, ...o.probes].map((c) => c.id)));
    const notices = [];
    for (const cid of new Set([...shownIds, ...pickedIds, ...changedIds])) {
      let c;
      try { c = store.readCard('habit', cid); } catch { continue; }
      if (!c?.id) continue;
      const picked = pickedIds.has(cid);
      if (picked) c = tickShown(c, true, at);
      else if (changedIds.has(cid)) c = { ...c, shown_count: (c.shown_count ?? 0) + 1, changed_count: (c.changed_count ?? 0) + 1 };
      else if (shownIds.has(cid)) c = tickShown(c, false, at);
      if (picked && !coversWorkflow(c, here)) {
        const from = c.scope ?? {};
        if (from.level === 'workflow' && from.category === category) {
          c = widenScope(c, { level: 'category', category, why: '在第二條流程也被選了', now: at });
          notices.push({ kind: 'widen', card: c.id, text: `「${c.text}」的範圍從「${nameOf(from.category, from.workflow)}」擴大到${catText(category)}：你在第二條 Workflow 也選了它。仍是選項，沒有升格` });
        } else {
          const fromText = from.level === 'workflow' ? `「${nameOf(from.category, from.workflow)}」` : catText(from.category);
          c = widenScope(c, { level: 'all', why: '在別的分類也被選了', now: at });
          notices.push({ kind: 'widen', card: c.id, text: `「${c.text}」的範圍從${fromText}擴大到全部 Workflow：你在別的分類也選了它。仍是選項，沒有升格` });
        }
      }
      store.writeCard(c);
    }
    for (const n of notices) noteOnRun(category, id, run.run_id, n);
  }

  // 帶進工作單的認識卡寫 last_used_at（M3a 差異 ②：內容層「最近用過」的排序鍵靠它）：跟 runner 同一套 contextFor 算，
  // 被外圈蓋掉的、身分沒列的、整層暫停的都不算「帶進去」
  function touchCoreCards({ category, id, run }) {
    const at = nowIso();
    const ctx = contextFor({ category, id, def: run.def, params: run.params ?? {}, identity: run.memory?.identity ?? null, picks: {} });
    for (const used of ctx.cards) {
      if (used.bucket !== 'profile') continue;
      try { store.writeCard({ ...store.readCard('profile', used.id), last_used_at: at }); } catch { /* 卡已經不在＝不寫 */ }
    }
  }

  return {
    adapter,
    noteOnRun,
    contextFor,
    manual,
    manualRound,
    manualDraft,
    manualSave,

    // 開跑（runner.startRun 寫完 run 後呼叫）三件事各自包一層，一件炸了其他照做、run 照建（runner 那邊也包了一層）：
    // ①點了即核可與範圍擴大（M3b）②帶進工作單的認識卡寫 last_used_at（M3b）③記路①開跑同值連兩趟（M2）——
    // 純程式比對（paramSignal），零 AI；欄位不在詞典先長出來；每張成卡就在這一趟寫一行通知
    onRunStart({ category, id, run, prevRun = null }) {
      try { accountPicks({ category, id, run }); } catch (e) { console.error('[bojian] 記憶（開跑選項計數）沒記成：', e.message); }
      try { touchCoreCards({ category, id, run }); } catch (e) { console.error('[bojian] 記憶（認識卡最近用）沒記成：', e.message); }
      try {
        let dict = store.readDict();
        const drafts = paramSignal({ def: run.def, prevRun, run, cards: store.listCards('habit', { status: 'active' }), dict });
        const at = nowIso();
        for (const s of drafts) {
          let hit = matchField(dict, s.label);
          if (!hit) {
            const kind = (run.def?.params ?? []).find((p) => p.key === s.key)?.kind;
            dict = ensureFields(dict, [{ label: s.label, kind }], { category, workflow: id }, at).dict;
            store.writeDict(dict);
            hit = matchField(dict, s.label);
          }
          const card = makeCard({
            bucket: 'habit', text: s.text, field: hit.name, scope: { level: 'workflow', category, workflow: id },
            source: { kind: 'run-params', category, workflow: id, run: run.run_id, node: null, at, quote: s.quote },
            route_reason: '連兩趟開跑都填了同一個值，程式直接記成習慣卡',
          }, at);
          const errs = validateCard(card, dict);
          if (errs.length) { console.error('[bojian] 記憶：這張卡沒存成——', errs.join('；')); continue; }
          store.writeCard(card);
          noteOnRun(category, id, run.run_id, { kind: 'card', card: card.id, text: cardNotice(card, { wfName: run.def?.name ?? null, why: '連兩趟同值' }) });
        }
      } catch (e) {
        console.error('[bojian] 記憶（開跑記路）沒記成：', e.message);
      }
    },

    // 記路②（停點）：server 的 edit 在 resume() 之後 fire-and-forget。註記含「以後都」→不等第二趟、直接路由並強制成認識卡；
    // 前一趟同一步沒改過→first-edit 通知（沒記、沒問）；連兩趟改了且有註記→路由；第二趟註記空→沒句子可記，什麼都不做
    async onStopEdit({ category, id, runId, node, note }) {
      try {
        const run = store.readRun(category, id, runId);
        const said = str(note).trim();
        const title = (run.def?.nodes ?? []).find((n) => n.id === node)?.title ?? node;
        const base = { category, id, runId, node, def: run.def };
        const push = (notices) => { for (const n of notices) noteOnRun(category, id, runId, n); };
        if (/以後都/.test(said)) {
          push(await routeAndLand({ ...base, text: said, hint: 'stop-note', force: 'profile', scopeFor: () => ({ level: 'all' }), sourceFor: () => 'stop-note', why: '你寫了「以後都」，所以直接成卡' }));
          return;
        }
        const prevRun = run.memory?.prev_run ? readRunOr(category, id, run.memory.prev_run) : null;
        if (!stopEditSignal({ prevRun, run, nodeId: node })) {
          noteOnRun(category, id, runId, { kind: 'first-edit', card: null, text: `這趟你改了「${title}」，第一次。它沒記、也沒問；下一趟再改同方向就會記` });
          return;
        }
        if (!said) return;
        push(await routeAndLand({
          ...base, text: said, hint: 'stop-edit',
          scopeFor: (b) => (b === 'habit' ? { level: 'workflow', category, workflow: id } : { level: 'category', category }),
          sourceFor: (b) => (b === 'habit' ? 'stop-edit' : 'stop-note'),
          why: `連兩趟改了「${title}」`,
        }));
      } catch (e) {
        console.error('[bojian] 記憶（停點記路）沒記成：', e.message);
      }
    },

    // 記路③（跑完回饋）：server 的 run-feedback await 它，回第一則通知隨 200 回去（全部通知都寫進這一趟）。
    // 提示＝跑完的回饋通常是習慣卡；路由判成認識卡也收（出處寫 chat：認識卡的來源只限你打的字）；判 none＝一則「沒記」
    async onFeedback({ category, id, runId, text }) {
      try {
        const run = store.readRun(category, id, runId);
        const notices = await routeAndLand({
          category, id, runId, node: '_memory', def: run.def, text, hint: 'feedback',
          scopeFor: (b) => (b === 'habit' ? { level: 'workflow', category, workflow: id } : { level: 'category', category }),
          // 兩種 bucket 的出處都是 feedback：記憶頁把 chat 顯示成「聊天裡說的」，但這句話是跑完丟的一句結果。
          // 沒有家的欄位改記成認識卡（已定案）之後，這條路變成常態，標錯就是天天在誤導人
          sourceFor: () => 'feedback',
          why: '你回報的',
        });
        return notices.map((n) => noteOnRun(category, id, runId, n))[0];
      } catch (e) {
        console.error('[bojian] 記憶（回饋記路）沒記成：', e.message);
        return failStamp(e);
      }
    },

    // 記路④（聊天）：server 的 compose 成功後 await 它。已存流程上講的用在那個分類、新草稿用在全部；
    // 沒有 run 可寫，通知只隨回應回去；判 none 回 null（聊天大多是在講流程本身，不值得每句都提）
    async onChat({ text, category = null, def = null }) {
      try {
        const fp = chatFingerprint(text, category);
        if (fp && seenChat(fp)) return null; // 這句話記過了
        const notices = await routeAndLand({
          category, id: null, runId: null, node: '_memory', def, text, hint: 'chat',
          scopeFor: () => (category ? { level: 'category', category } : { level: 'all' }),
          sourceFor: () => 'chat',
          why: '你在聊天裡說的',
        });
        const n = notices[0];
        // 記成了（成卡）或合法判 none 才登記指紋；路由失敗（模型逾時、回覆看不懂）不登記——
        // 否則使用者再講同一句會被當「已處理」直接吞掉、一張卡也沒存（B08，Codex 2026-09-25）
        if (fp && n && n.kind !== 'fail') markChat(fp);
        return !n || n.kind === 'none' ? null : stamp(n);
      } catch (e) {
        console.error('[bojian] 記憶（聊天記路）沒記成：', e.message);
        return failStamp(e);
      }
    },

    // 記憶頁「地圖與例外」＋儀表板一行的資料源。counts 數全部不在垃圾桶的卡（不分狀態）；例外四格見契約 (h)
    summary() {
      const settings = store.readSettings();
      const today = dateOnly(now());
      const cards = store.listCards();
      const groups = store.listGroups();
      const stamps = [...cards.flatMap((c) => [c.created_at, c.last_used_at]), ...groups.map((g) => g.updated_at)].filter(Boolean).sort();
      return {
        intro_done: settings.memory.intro_done_at != null,
        paused: settings.memory.paused === true,
        sensitive: settings.memory.sensitive,
        counts: {
          profile: cards.filter((c) => c.bucket === 'profile').length,
          habit: cards.filter((c) => c.bucket === 'habit').length,
          groups: groups.length,
          dict: store.readDict().fields.length,
        },
        exceptions: {
          expired: cards.filter((c) => c.status === 'active' && c.expires != null && String(c.expires) < today),
          dormant: cards.filter((c) => c.status === 'dormant'),
          replaced: cards.filter((c) => c.status === 'replaced'),
          changed: cards.filter((c) => c.status === 'active' && (c.changed_count ?? 0) >= 2), // 選了又改掉兩次以上：只列不提議
        },
        updated_at: stamps.at(-1) ?? null,
      };
    },

    // 這條流程會帶什麼（流程頁兩格、抽屜一列、開跑選項的資料源）。流程不存在→store NOT_FOUND（404）。
    // 整層暫停：關於你不帶、群組規矩照帶、習慣選項照給（它們不是「關於你」）。options＝每個欄位旁的習慣選項（habitOptions）
    forWorkflow(category, id) {
      const def = store.readWorkflow(category, id);
      const paused = store.readSettings().memory.paused === true;
      const today = dateOnly(now());
      const here = { category, workflow: id };
      const core = selectCore({ profileCards: store.listCards('profile'), category, workflowId: id, paused, today });
      const habits = store.listCards('habit').filter((c) => isLive(c, today));
      const group = store.readGroup(category);
      const workflowNames = {};
      for (const c of habits) {
        const w = c.scope?.level === 'workflow' && c.scope.category === category ? c.scope.workflow : null;
        if (w && w !== id && !(w in workflowNames)) workflowNames[w] = nameOf(category, w);
      }
      return {
        core: {
          expression: core.filter((c) => c.layer === 'expression'),
          content: core.filter((c) => c.layer === 'content'),
        },
        group: { rules: (group?.rules ?? []).filter((r) => r.status === 'active') },
        habits: {
          own: habits.filter((c) => c.scope?.level === 'workflow' && coversWorkflow(c, here)),
          inherited: habits.filter((c) => c.scope?.level !== 'workflow' && coversWorkflow(c, here)),
          probes: habits.filter((c) => c.scope?.level === 'workflow' && c.scope.category === category && c.scope.workflow !== id),
        },
        options: habitOptions({ habitCards: habits, def, category, workflowId: id, dict: store.readDict(), workflowNames, today }),
        paused,
      };
    },

    // 首次三題：答了的題各成一張認識卡（scope 全部、出處 intro）；跳過＝零張。兩種都寫 intro_done_at，之後不再問
    intro({ answers = {}, skip = false } = {}) {
      const at = nowIso();
      const created = [];
      if (!skip) {
        for (const q of INTRO_QUESTIONS) {
          const text = String(answers?.[q.key] ?? '').trim();
          if (!text) continue;
          const card = makeCard({
            bucket: 'profile', text, layer: q.layer, scope: { level: 'all' },
            source: { kind: 'intro', at, quote: `（介紹你自己）${text}` }, route_reason: '介紹你自己的答案，直接記成認識卡',
          }, at);
          store.writeCard(card);
          created.push(card.id);
        }
      }
      const settings = store.readSettings();
      settings.memory.intro_done_at = at;
      store.writeSettings(settings);
      return { created, done_at: at };
    },

    // 一行通知的「不要記」：卡進記憶垃圾桶，該趟（給了 category／id／run 才有）所有指到這張卡的通知標 undone。卡不存在→NOT_FOUND（404）
    undo({ cardId, category = null, id = null, run = null } = {}) {
      const r = category && id && run ? store.readRun(category, id, run) : null; // 先讀：趟不存在就不動卡
      const key = store.trashCard(bucketOfId(cardId), cardId);
      if (r) {
        let touched = false;
        for (const n of r.memory?.notices ?? []) if (n.card === cardId && n.undone !== true) { n.undone = true; touched = true; }
        if (touched) store.writeRun(category, id, run, r);
      }
      return { ok: true, key };
    },
  };
}
