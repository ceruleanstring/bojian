// supervisor — 監工：一趟流程開跑前寫開場備註、每一步開跑前寫交接、跑完寫執行紀錄。
// 監工是每次一次全新的 adapter.complete（meta.kind='supervisor'，不帶工具、不帶側寫）；業務 prompt 只在這裡組。
// 三條紀律：
//   1. 存的全文＝送出的全文——prompt 一律經這裡的三個 build* 函式，卷宗由 onPrompt／onReply 回呼收。
//   2. 監工失敗不擋流程——宿主錯、解析不出、超時，一律回 { ok: false, fail_note }，絕不 throw 給引擎。
//   3. 監工不能改流程定義、不能改成品、不能新增沒畫過的步驟、不能把備註寫進查核必守。
import { nodeKind } from './schema.js';
import { predecessors, ancestorIds } from './graph.js';
import { extractJson, CheckParseError } from './checker.js';
import { attName } from './shared.js';

const str = (v) => (v === null || v === undefined ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
// 超量就截，並且講明截了——監工看到「（截）」才知道自己看的不是全部，不會把「後面沒提到」當成「沒有」
const cut = (v, n) => {
  const s = str(v);
  return s.length > n ? `${s.slice(0, n)}（截）` : s;
};
const NONE = '（無）';
const lines = (xs) => {
  const out = arr(xs).map((x) => str(x).trim()).filter(Boolean).map((x) => `- ${x}`);
  return out.length ? out.join('\n') : NONE;
};

// ---- 三份固定交代（逐字；改這裡＝改契約，tests/supervisor.test.js 一起改） ----

// 「你只交接、不設限」那句（US-111／L068）：監工讀了截斷的參考檔節錄後寫「只能用上一步的數字」，工人照做，成品少了客單價——
// 使用者拍板監工只交接、不設限；這句是第一道，brief()／handoff() 的 stripLimits 是第二道
export const BRIEF_RULES = '你是「剝繭」流程的監工。這趟流程要開跑了，你先通盤看一次這條流程的全部設定與這次帶進來的資料，寫一份給每一步工人的開場備註：這趟的資料長什麼樣（件數、類別、期間、缺什麼）、哪幾步要特別注意什麼、成品一定要有什麼。只寫從設定與資料看得出來的事，不編、不加新要求、不改任何步驟的指示；最多八條，一條一句。你只交接、不設限：不要寫「不得」「不准」「只能」「禁止」這類限制句，工人該守的規則由設定與使用者的要求管，不由你管。全篇使用與流程相同的語言。只輸出一個 JSON 物件，前後不要任何其他文字：{"note":"…"}';

export const HANDOFF_RULES = '你是「剝繭」流程的監工。上一步剛做完，下一步要開始。請讀上一步的成品、這趟的開場備註、之前的交接、下一步的設定、使用者剛交代的話，寫一段給下一步工人的交接：上一步成品裡哪些東西下一步要用、要照什麼分法或順序、有什麼要避開。只寫從成品與設定看得出來的事，不編、不新增使用者沒提的要求、不改下一步的指示；最多五條，一條一句。你只交接、不設限：不要寫「不得」「不准」「只能」「禁止」這類限制句，工人該守的規則由設定與使用者的要求管，不由你管。「允許你調的」列出的欄位才能給值（tier 只能是 fast、balanced、deep 之一；web 是要不要開查網，true 或 false），沒列的一律 null。有「判路題」時從選項裡選一條，route 寫該選項的編號（字串），判斷不了寫 null；沒有判路題 route 一律 null。全篇使用與流程相同的語言。只輸出一個 JSON 物件，前後不要任何其他文字：{"note":"…","tier":null,"web":null,"route":null}';

export const RECORD_RULES = '你是「剝繭」流程的監工。這趟已經跑完。下面是程式整理的對應表（每一步用了哪些設定、規則、備註，查核結果，使用者改了什麼）與各步成品。請用使用者聽得懂的話寫這趟的執行紀錄：發生了什麼、哪裡被攔或被改、原因最可能在哪個設定或哪條規則；然後列「建議改哪裡」，每條指到一個具體位置與改法一句。where 只能是這五個字之一：instruction（那一步的指示）、constraints（限制條件）、review_focus（驗收重點）、params（某個欄位）、rule（某條規則）；node 只能是「可用的步驟 id」裡的一個。不評論好壞、不編沒發生的事；紀錄六句內，建議最多三條，沒有就給空清單。只輸出一個 JSON 物件，前後不要任何其他文字：{"text":"…","suggestions":[{"node":"步驟id","where":"instruction","text":"…"}]}';

// 建議指到哪裡（前端另寫同一張表；node 詳情頁的「改這裡」按這個對應到抽屜欄位）
export const WHERE_LABELS = {
  instruction: '指示',
  constraints: '限制條件',
  review_focus: '驗收重點',
  params: '欄位',
  rule: '規則',
};

// ---- 三個勾 ----

// 監工「可以」改這一步的什麼。缺省：寫交接備註開、調檔位關、開關查網關。
// 調檔位 09-09 由開改關（定案）：真 AI 前後對照時監工四次交接都回 balanced，把 deep 的工人降級；要監工調檔位得在抽屜明勾。
// 一律走這個函式取值——節點沒寫 supervisor、寫成半套、寫成非布林，都要回三個布林，呼叫端不用自己防；ui/app.js 的 supFlags 要同步
export function supervisorFlags(node) {
  const sv = isObj(node) && isObj(node.supervisor) ? node.supervisor : {};
  const pick = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
  return { note: pick(sv.note, true), tier: pick(sv.tier, false), tools: pick(sv.tools, false) };
}

// ---- prompt 組裝 ----

// US-117 ③：使用者說明書「什麼事要問我、什麼事自己決定」段——以獨立欄位 userAsk 進開場與交接，
// 不混進監工備註（stripLimits 只剔監工寫的句子，使用者這段原句照傳）。空／缺席＝兩份 prompt 逐字同舊。
const ASK_TITLE = '# 使用者交代（什麼事要問我、什麼事自己決定）';
const ASK_NOTE = '（使用者親口說的，當已知：哪一步會碰到要問他的事，備註裡提醒那一步先停下來問；原句工人會另外拿到，不用重抄）';
const askLines = (v) => arr(v).map((x) => str(x).trim()).filter(Boolean);
const askSection = (userAsk) => {
  const ask = askLines(userAsk);
  return ask.length ? ['', ASK_TITLE, ASK_NOTE, ask.map((x) => `- ${x}`).join('\n')] : [];
};

// 參考檔一行：名稱、掛在哪幾步、行數、（表格檔才有）欄位＝第一行。不附任何內文節錄——
// L068：監工看到截了 500 字的節錄，以為資料只有那些，就寫出「只能用上一步的數字」把工人綁死
// 表格＝副檔名 csv／tsv 或第一行含 tab；第一行只是含逗號的散文（.md 的一句話）不算，不然那句散文會被印成「欄位」
const TABLE_EXTS = ['csv', 'tsv'];
function refLine(name, text, titles) {
  const at = titles.length ? `（掛在：${titles.join('、')}）` : '';
  if (!text) return `【參考檔：${name}】`; // 讀不出文字（或空檔）的只印名稱
  // 行數以換行計；最後一行沒換行也算一行（"a\nb"＝2、"a\nb\n"＝2、"a"＝1）
  const nl = (text.match(/\n/g) ?? []).length;
  const rows = nl + (text.endsWith('\n') ? 0 : 1);
  const first = text.split(/\r?\n/, 1)[0].replace(/\r$/, '');
  const ext = name.replace(/（[^（）]*）$/, '').split('.').pop()?.toLowerCase();
  const table = TABLE_EXTS.includes(ext) || first.includes('\t');
  return `【參考檔：${name}】${at}｜行數 ${rows}${table ? `｜欄位：${cut(first, 200)}` : ''}`;
}

// 開場備註：通盤看一次全部設定＋這次的欄位值＋參考檔清單（只列名稱／掛在哪步／行數／欄位）
// refTexts＝{ 檔名: 全文 }；檔名清單取自全部節點 attachments 的聯集，讀不出文字的只列名字
export function buildBriefPrompt({ def, params, paramLabels, refTexts, userAsk } = {}) {
  const d = isObj(def) ? def : {};
  const nodes = arr(d.nodes);
  // 步驟行不給 id：開場備註是寫給工人與使用者看的，id 是給不了資訊的 slug（收尾另有「可用的步驟 id」段）
  const steps = nodes.map((n) => [
    `- ${str(n?.title)}｜${str(n?.executor || nodeKind(n ?? {}))}｜停點 ${str(n?.stop_point || '無')}`,
    `要求：${cut(n?.instruction, 200)}`,
    `限制：${cut(n?.constraints, 200) || NONE}`,
    `驗收：${cut(n?.review_focus, 200) || NONE}`,
  ].join('｜'));
  const values = Object.entries(isObj(params) ? params : {})
    .map(([k, v]) => `【欄位：${str(paramLabels?.[k] ?? k)}】\n${cut(v, 2000)}`);
  // 參考檔名（三層共用檔）：組織／分類層的 {scope,name} 顯示成「名稱（公司）」，refTexts 也用這個當鍵
  const nameOf = (a) => (a && typeof a === 'object' ? attName(a) : str(a));
  const names = [...new Set(nodes.flatMap((n) => arr(n?.attachments).map(nameOf)))];
  const refs = names.map((name) => {
    const titles = nodes.filter((n) => arr(n?.attachments).some((a) => nameOf(a) === name)).map((n) => str(n?.title)).filter(Boolean);
    return refLine(name, str(refTexts?.[name]), titles);
  });
  return [
    BRIEF_RULES,
    '',
    `# 流程：${str(d.name)}`,
    '',
    '# 步驟',
    steps.length ? steps.join('\n') : NONE,
    '',
    '# 這次的欄位值',
    values.length ? values.join('\n\n') : NONE,
    '',
    '# 參考檔',
    refs.length ? refs.join('\n\n') : NONE,
    ...askSection(userAsk),
  ].join('\n');
}

// 交接：上一步剛做完、下一步要開始時給下一步工人的話
// flags 決定「允許你調的」列什麼——沒列出來的欄位，監工就算寫了值也會被 handoff() 強制回 null
export function buildHandoffPrompt({ node, flags, routeOptions, brief, priorHandoffs, rules, interjections, upstream, userAsk } = {}) {
  const n = isObj(node) ? node : {};
  const f = flags ?? supervisorFlags(n);
  // 附現值：不講現在的檔位，監工會每次都回 balanced，把設 deep 的工人一路降級（真 AI 前後對照實測）
  // web 現值一律「開」——工人缺省就帶查網，只有監工把 web 寫成 false 才會關
  const allow = [
    f.tier ? `- tier（現在：${str(n.model_tier) || 'balanced'}；沒必要改就寫 null）` : null,
    f.tools ? '- web（現在：開；沒必要改就寫 null）' : null,
  ].filter(Boolean);
  const options = arr(routeOptions);
  const out = [
    HANDOFF_RULES,
    '',
    `# 下一步：${str(n.title)}`,
    `要求：${str(n.instruction)}`,
    `限制：${str(n.constraints) || NONE}`,
    `驗收重點：${str(n.review_focus) || NONE}`,
    `產出格式：${str(n.output_format) || NONE}`,
    '',
    '# 允許你調的',
    allow.length ? allow.join('\n') : NONE,
  ];
  if (options.length) {
    out.push(
      '',
      '# 判路題',
      `判斷依據：${str(n.instruction)}`,
      options.map((o, i) => `${i + 1}. ${str(o?.label)}`).join('\n'),
    );
  }
  const priors = arr(priorHandoffs).filter((h) => str(h?.text).trim()).map((h) => `- ${str(h?.title)}：${str(h.text).trim()}`);
  // 超過 8,000 字的成品不截：截斷版會讓監工把「後面沒看到」當成「沒有」（L068）；換成一句講明太長，工人拿的是全文
  const ups = arr(upstream).filter((u) => str(u?.text)).map((u) => {
    const text = str(u.text);
    return text.length > 8000
      ? `【步驟：${str(u?.title)}】（成品 ${text.length} 字，太長未附；下一步工人會拿到全文）`
      : `【步驟：${str(u?.title)}】\n${text}`;
  });
  out.push(
    '', '# 生效的規矩', lines(rules),
    '', '# 開場備註', str(brief).trim() || NONE,
    '', '# 之前的交接', priors.length ? priors.join('\n') : NONE,
    '', '# 使用者剛交代的話', lines(interjections),
    ...askSection(userAsk),
    '', '# 上一步的成品', ups.length ? ups.join('\n\n') : NONE,
  );
  return out.join('\n');
}

// 執行紀錄：對應表是程式整理的事實，監工只負責翻成人話＋指出可以改哪裡
export function buildRecordPrompt({ def, table, outputs } = {}) {
  const d = isObj(def) ? def : {};
  const nodes = arr(d.nodes);
  const outs = arr(outputs).filter((o) => str(o?.text)).map((o) => `【步驟：${str(o?.title)}】\n${cut(o.text, 1500)}`);
  return [
    RECORD_RULES,
    '',
    `# 流程：${str(d.name)}`,
    '',
    '# 可用的步驟 id',
    nodes.length ? nodes.map((n) => `- ${str(n?.id)}：${str(n?.title)}`).join('\n') : NONE,
    '',
    '# 對應表',
    JSON.stringify(arr(table)),
    '',
    '# 各步成品（節錄）',
    outs.length ? outs.join('\n\n') : NONE,
  ].join('\n');
}

// ---- 解析 ----
// 走 checker 的同一套候選政策（全文一個池、包含依名次、含糊即失敗）：監工被要求「只輸出一個 JSON 物件」，
// 回覆裡有兩份內容不同、一樣像的結果＝交件不合格，誠實說沒寫成，不准靠位置去猜。

const NO_RESULT = '監工回覆裡沒有可用的結果';
const AMBIGUOUS = '監工這次交了不只一份結果，分不出哪份是真的';
const TIERS = ['fast', 'balanced', 'deep'];

function pick(text, rank, normalize) {
  const v = extractJson(text, rank, normalize, AMBIGUOUS);
  if (v === null) throw new CheckParseError(NO_RESULT);
  return v;
}

export function parseBrief(text) {
  return pick(
    text,
    (v) => (isObj(v) && typeof v.note === 'string' ? [1] : [0]),
    (v) => ({ note: v.note.trim() }),
  );
}

export function parseHandoff(text) {
  return pick(
    text,
    (v) => (isObj(v) && ('note' in v || 'route' in v) ? [1] : [0]),
    (v) => ({
      note: typeof v.note === 'string' ? v.note.trim() : '',
      tier: TIERS.includes(v.tier) ? v.tier : null,
      web: typeof v.web === 'boolean' ? v.web : null,
      route: v.route == null ? null : String(v.route).trim(),
    }),
  );
}

export function parseRecord(text, nodeIds) {
  const ids = arr(nodeIds);
  const wheres = Object.keys(WHERE_LABELS);
  return pick(
    text,
    // 建議清單裡的單筆建議也有 text，但沒有 suggestions 陣列——名次 [0]，不會混進候選池跟外層搶
    (v) => (isObj(v) && typeof v.text === 'string' && Array.isArray(v.suggestions) ? [1] : [0]),
    (v) => ({
      text: v.text.trim(),
      suggestions: v.suggestions
        .filter((s) => s && ids.includes(s.node) && wheres.includes(s.where) && typeof s.text === 'string' && s.text.trim())
        .slice(0, 3)
        .map((s) => ({ node: s.node, where: s.where, text: s.text.trim() })),
    }),
  );
}

// ---- 剔限制句 ----
// 第二道（第一道是 BRIEF_RULES／HANDOFF_RULES 那句）：note 依換行與「；」拆條，含任一中文限制詞的整條剔掉，其餘照原分隔接回。
// 只比對中文關鍵字、不碰英文；一條都沒剔＝逐字原樣。被剔的原句回 dropped（卷宗 *.reply.txt 另存監工原話，那才是正本）
// L084①：規則寫的是「不可」——「不可」含「不可以」，一條就夠（「不可新增欄位」以前剔不掉）
const LIMIT_WORDS = ['不得', '不准', '不可', '只能', '禁止'];
const SEP = /(\r?\n|；)/;
export function stripLimits(note) {
  if (typeof note !== 'string' || !note) return { note: typeof note === 'string' ? note : '', dropped: [] };
  const parts = note.split(SEP); // [條, 分隔, 條, 分隔, …]
  const kept = [];
  const dropped = [];
  for (let i = 0; i < parts.length; i += 2) {
    const item = parts[i];
    if (LIMIT_WORDS.some((w) => item.includes(w))) dropped.push(item.trim());
    else kept.push(item + (parts[i + 1] ?? ''));
  }
  if (!dropped.length) return { note, dropped };
  const out = kept.join('').replace(/^(\r?\n|；)+/, '').replace(/(\r?\n|；)+$/, '').trim();
  return { note: out, dropped };
}

// ---- 呼叫 ----

// 卷宗回呼（比照 checker.notePrompt）：寫不進卷宗只是少一份紀錄，不該把監工整個降級成沒寫成
async function note(fn, value) {
  if (typeof fn !== 'function') return;
  try { await fn(value); } catch { /* 卷宗寫不進不擋監工 */ }
}

const humanReason = (e) => str(e?.message).replace(/可以按[\s\S]*$/, '').trim() || '原因不明';
// 全計畫只有這一句式（run 紀錄的 fail_note、紀錄格的 text 都用它）
const failed = (e) => ({ ok: false, fail_note: `監工這次沒寫成：${humanReason(e)}` });

// 送出→收回。回覆原文一收到就進卷宗（不等解析成不成功）——「這次沒寫成」事後要查得出為什麼
async function ask({ adapter, meta, onPrompt, onReply, prompt }) {
  await note(onPrompt, prompt);
  const raw = str(await adapter.complete({ prompt, meta: { ...(meta ?? {}), kind: 'supervisor' } }));
  await note(onReply, raw);
  return raw;
}

// US-117 ③：userAsk 有內容 → 回傳多 user_ask（使用者原句，不經 stripLimits、不併進 text）；空＝回傳形狀逐字同舊
export async function brief({ adapter, meta, onPrompt, onReply, def, params, paramLabels, refTexts, userAsk }) {
  try {
    const prompt = buildBriefPrompt({ def, params, paramLabels, refTexts, userAsk });
    const { note: text, dropped } = stripLimits(parseBrief(await ask({ adapter, meta, onPrompt, onReply, prompt })).note);
    const user_ask = askLines(userAsk);
    return { ok: true, text, dropped, ...(user_ask.length ? { user_ask } : {}) };
  } catch (e) {
    return failed(e);
  }
}

export async function handoff({ adapter, meta, onPrompt, onReply, node, flags, routeOptions, brief: briefText, priorHandoffs, rules, interjections, upstream, userAsk }) {
  const f = flags ?? supervisorFlags(node);
  try {
    const prompt = buildHandoffPrompt({ node, flags: f, routeOptions, brief: briefText, priorHandoffs, rules, interjections, upstream, userAsk });
    const v = parseHandoff(await ask({ adapter, meta, onPrompt, onReply, prompt }));
    // 沒勾的欄位程式強制清空：勾是「監工可以動」的授權，監工自己寫了值不算數（route 例外——判路永遠跑）
    const s = f.note ? stripLimits(v.note) : { note: '', dropped: [] };
    return { ok: true, text: s.note, tier: f.tier ? v.tier : null, web: f.tools ? v.web : null, route: v.route, dropped: s.dropped };
  } catch (e) {
    return failed(e);
  }
}

export async function record({ adapter, meta, onPrompt, onReply, def, table, outputs }) {
  try {
    const prompt = buildRecordPrompt({ def, table, outputs });
    const ids = arr(def?.nodes).map((n) => n?.id).filter((x) => typeof x === 'string');
    const v = parseRecord(await ask({ adapter, meta, onPrompt, onReply, prompt }), ids);
    return { ok: true, text: v.text, suggestions: v.suggestions };
  } catch (e) {
    return failed(e);
  }
}

// ---- 對應表 ----
// 「這一步用了哪些設定、規則、備註，查核怎麼判，使用者改了什麼，花了多少」——全部由程式從 run 與帳本整理，
// 監工只讀不寫。事實由程式給，監工才不會編。

// 節點的設定欄位（非空的才列進 fields；也是掃 {{欄位}} 引用的範圍）
const NODE_FIELDS = [
  'role_context', 'background', 'constraints', 'examples', 'review_focus',
  'output_type', 'output_structure', 'output_length', 'output_tone',
  'output_format', 'output_file', 'template_file', 'attachments',
];
const PARAM_REF = /\{\{\s*([\w-]+)\s*\}\}/g;
// 逐步 chip 與紀錄格的數字要對得起來：篩選跟 server 的 usageByNode 同一套（擬規則不算）
const USAGE_KINDS = ['step', 'check', 'supervisor'];
const emptyUsage = () => ({ input: 0, output: 0, calls: 0 });

function addUsage(acc, u) {
  acc.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  acc.output += u.output_tokens ?? 0;
  acc.calls += 1;
  return acc;
}

const fieldText = (v) => (Array.isArray(v) ? v.map(str).join('\n') : str(v));
const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : Boolean(str(v).trim()));

export function buildRecordTable({ run, usageRows }) {
  const def = isObj(run?.def) ? run.def : {};
  const nodes = arr(def.nodes).filter((n) => isObj(n) && typeof n.id === 'string');
  const steps = isObj(run?.steps) ? run.steps : {};
  const predMap = predecessors({ ...def, nodes });
  const labels = new Map(arr(def.params).filter(isObj).map((p) => [p.key, p.label ?? p.key]));

  const rows = arr(usageRows).filter((u) => isObj(u) && u.run === run?.run_id && u.node && USAGE_KINDS.includes(u.kind));
  const byNode = new Map();
  for (const u of rows) {
    if (!byNode.has(u.node)) byNode.set(u.node, emptyUsage());
    addUsage(byNode.get(u.node), u);
  }
  const usageOf = (nodeId) => byNode.get(nodeId) ?? emptyUsage();

  const table = nodes.map((n) => {
    const s = isObj(steps[n.id]) ? steps[n.id] : {};
    const kind = nodeKind(n);
    const scanned = [str(n.instruction), ...NODE_FIELDS.map((f) => fieldText(n[f]))].join('\n');
    const keys = [...new Set([...scanned.matchAll(PARAM_REF)].map((m) => m[1]))];
    const ck = isObj(s.check) ? s.check : null;
    return {
      node: n.id,
      title: str(n.title),
      kind,
      executor: kind === 'task' ? (n.executor ?? null) : null,
      status: str(s.status),
      upstream: [...(predMap.get(n.id) ?? [])],
      fields: NODE_FIELDS.filter((f) => nonEmpty(n[f])),
      params: keys.map((k) => str(labels.get(k) ?? k)),
      edit_rules_in: ancestorIds(run, n.id, predMap)
        .flatMap((p) => arr(steps[p]?.edit_rules))
        .filter((r) => isObj(r) && r.scope === 'all')
        .map((r) => str(r.text)),
      handoff: str(s.handoff?.text) || null,
      check: ck ? { status: str(ck.status), blocks: arr(ck.blocks).length, flags: arr(ck.flags).length, attempts: Number(ck.attempts ?? 0) } : null,
      edited: s.edited_output !== null && s.edited_output !== undefined,
      edit_note: s.edit_note ?? null,
      cards: arr(s.memory?.cards).map((c) => str(c?.id)).filter(Boolean), // 這步用了哪幾條，只鏡像 steps[n].memory 的 id
      usage: usageOf(n.id),
    };
  });

  return {
    table,
    usage: { brief: usageOf('_brief'), record: usageOf('_record'), total: rows.reduce(addUsage, emptyUsage()) },
  };
}

// ---- 相似度 ----

const bigrams = (s) => {
  const t = str(s);
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
};

// 字元二元組的 Jaccard：|A∩B|/|A∪B|。任一方不足兩字→聯集可能為空，一律回 0，永不回 NaN
//（優化員訊號 E 用它判「連續兩趟的交接是不是同一句話」，NaN 會讓比較永遠為假，該提的提議就不見了）
export function bigramJaccard(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size && !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  const union = A.size + B.size - hit;
  return union ? hit / union : 0;
}
