// schema — workflow 定義驗證（命名見 GLOSSARY.md；有向圖模型見 規劃/機器合約.md）
// 節點 kind：task（預設）｜branch 分岔｜fork 並行點（畫布調色盤元件）｜join（舊格式相容，畫布編輯時自動拆直——會合=多條線接進同一步）
import { FIELD_KINDS } from './memory.js';
import { DEFAULT_SETTINGS } from './store.js';

export class SchemaError extends Error {
  constructor(problems) {
    super(`Workflow 定義有問題：${problems.join('；')}`);
    this.problems = problems;
  }
}

const EXECUTORS = ['ai', 'human'];
const STOP_POINTS = ['always', 'never'];
const KINDS = ['task', 'branch', 'fork', 'join'];
// 檔案格式三級制（D19→；把簡報搬進 OFFICE）：TIER1 引擎直接存文字；
// OFFICE 由工人在產出資料夾用剝繭自帶套件產真檔（需流程 permissions.files）；
// TIER2 尚未接，未接時降級存 .md 並講明——只剩 PDF：要嵌中文字型（好幾 MB），與離線化衝突，已定案延後
export const OUTPUT_TIER1 = ['md', 'txt', 'csv', 'html', 'json'];
export const OUTPUT_OFFICE = ['docx', 'xlsx', 'pptx', 'pdf'];
// 全部接完了。留著這個常數是因為 runner／preflight 都吃它——之後再有「還沒接的格式」直接加進來
export const OUTPUT_TIER2 = [];
const OUTPUT_EXTS = [...OUTPUT_TIER1, ...OUTPUT_OFFICE, ...OUTPUT_TIER2];
// 提前提醒九檔：步驟層 remind_leads 與全域設定 exec.remind_leads 共用
const REMIND_LEADS = ['10m', '30m', '1h', '2h', '3h', '6h', '12h', '1d', '2d'];
const isLeadList = (v) => Array.isArray(v) && v.every((l) =>
  (typeof l === 'string' ? REMIND_LEADS.includes(l) : l && typeof l === 'object' && typeof l.at === 'string'));
// 開跑時「本次附件」佔用的保留鍵：欄位取這個名字的話，值會被附件蓋掉而且沒有任何提示
// （手改 YAML 或匯入別人的檔才碰得到）。直接擋下來講清楚，比讓他查半天好。
const RESERVED_PARAM_KEYS = new Set(['__run__']);
const MODEL_TIERS = ['fast', 'balanced', 'deep'];
const CONNECTOR_SETTERS = ['ai', 'user'];
const ATT_SCOPES = ['company', 'category'];
const isPlainName = (v) => typeof v === 'string' && !!v.trim() && !/[\\/]|\.\./.test(v);
const isAttachment = (a) => isPlainName(a) || (a && typeof a === 'object' && ATT_SCOPES.includes(a.scope) && isPlainName(a.name));
const KIND_LIST = Object.keys(FIELD_KINDS).join('/');

export function nodeKind(n) {
  return n.kind ?? 'task';
}

// 節點的全部出邊（分岔的邊在 branches 裡）
export function outgoing(n) {
  return nodeKind(n) === 'branch' ? (n.branches ?? []).map((b) => b.next) : (n.next ?? []);
}

// allowFloating：編輯中的定義允許「還沒接進流程」的步驟（畫布自由編輯，D17）；開跑（runner）一律嚴格
export function validateWorkflow(def, { allowFloating = false } = {}) {
  const problems = [];
  if (!def || typeof def !== 'object') throw new SchemaError(['整份定義不是物件']);
  if (def.format !== 1) problems.push('format 必須是 1');
  if (typeof def.name !== 'string' || !def.name.trim()) problems.push('缺 name（Workflow 名稱）');
  // 拆解器的草稿可帶頂層 category（放哪個分類）；這裡只驗型別，POST /api/workflows 存檔前剝掉（分類是路徑，不進 workflow.yaml）
  if (def.category !== undefined && typeof def.category !== 'string') problems.push('category 要是文字');
  // 流程權限：files＝允許工人在這趟的產出資料夾寫檔與執行程式；沒帶＝關
  if (def.permissions !== undefined) {
    const pm = def.permissions;
    if (!pm || typeof pm !== 'object' || Array.isArray(pm)) problems.push('permissions 要是物件');
    else {
      if (pm.files !== undefined && typeof pm.files !== 'boolean') problems.push('permissions.files 要是開或關');
      // connectors＝允許步驟讀勾選的外部服務（ADR-006）；沒帶＝開（親手建的預設開），匯入的一律關
      if (pm.connectors !== undefined && typeof pm.connectors !== 'boolean') problems.push('permissions.connectors 要是開或關');
    }
  }
  // 流程層一個開關；缺省＝開（enabled !== false 即開）
  // 子開關 facts＝數字對原始資料；缺省也是開（facts !== false）
  if (def.check !== undefined) {
    const ck = def.check;
    if (!ck || typeof ck !== 'object' || Array.isArray(ck)) problems.push('check 要是物件');
    else {
      if (ck.enabled !== undefined && typeof ck.enabled !== 'boolean') problems.push('check.enabled 要是開或關');
      if (ck.facts !== undefined && typeof ck.facts !== 'boolean') problems.push('check.facts 要是開或關');
    }
  }
  // 流程層監工開關；缺省＝開（enabled !== false）。只管開場備註、交接備註、派工、收尾紀錄——判路永遠跑
  if (def.supervisor !== undefined) {
    const sv = def.supervisor;
    if (!sv || typeof sv !== 'object' || Array.isArray(sv)) problems.push('supervisor 要是物件');
    else if (sv.enabled !== undefined && typeof sv.enabled !== 'boolean') problems.push('supervisor.enabled 要是開或關');
  }

  const params = Array.isArray(def.params) ? def.params : (problems.push('params 必須是陣列'), []);
  const paramKeys = new Set();
  params.forEach((p, i) => {
    if (!p || typeof p.key !== 'string' || !p.key.trim()) problems.push(`params[${i}] 缺 key`);
    else if (paramKeys.has(p.key)) problems.push(`參數 key「${p.key}」重複`);
    else if (RESERVED_PARAM_KEYS.has(p.key)) problems.push(`參數 key「${p.key}」是保留字（開跑時「本次附件」在用），換一個名字`);
    else paramKeys.add(p.key);
    if (!p || typeof p.label !== 'string' || !p.label.trim()) problems.push(`params[${i}] 缺 label`);
    if (!p || p.default === undefined) problems.push(`params[${i}] 缺 default`);
    // required／hint：必填旗標＋「要貼什麼」提示；純資料欄位由拆解器標，開跑前健檢據此擋沒填
    if (p && p.required !== undefined && typeof p.required !== 'boolean') problems.push(`params[${i}] required 要是開或關`);
    if (p && p.hint !== undefined && typeof p.hint !== 'string') problems.push(`params[${i}] hint 要是文字`);
    // kind：欄位性質六類，拆解器給、詞典長新欄位時沿用；沒給（含 null）＝詞典補成「做法」
    if (p && p.kind != null && !Object.hasOwn(FIELD_KINDS, p.kind)) problems.push(`params[${i}] kind 必須是 ${KIND_LIST}`);
    // input：'file'＝每次開跑上傳一個檔（只跟這一趟存）；缺省＝文字欄位（舊檔都沒有這個鍵）
    if (p && p.input !== undefined && p.input !== 'file') problems.push(`params[${i}] input 只能是 file（每次上傳一個檔）`);
  });

  const nodes = Array.isArray(def.nodes) && def.nodes.length ? def.nodes : (problems.push('nodes 必須是非空陣列'), []);
  const ids = new Set();
  for (const [i, n] of nodes.entries()) {
    const at = `nodes[${i}]`;
    if (!n || typeof n.id !== 'string' || !n.id.trim()) { problems.push(`${at} 缺 id`); continue; }
    // 底線開頭保留給 _brief／_record 兩個偽節點（用量帳本與卷宗都用它們當 node 鍵）
    if (n.id.startsWith('_')) problems.push(`節點「${n.id}」步驟 id 不能以 _ 開頭`);
    if (ids.has(n.id)) problems.push(`節點 id「${n.id}」重複`);
    else ids.add(n.id);
    if (typeof n.title !== 'string' || !n.title.trim()) problems.push(`${at} 缺 title`);
    const kind = nodeKind(n);
    if (!KINDS.includes(kind)) { problems.push(`節點「${n.id}」kind 必須是 task/branch/fork/join`); continue; }
    if (!Array.isArray(n.next)) problems.push(`${at} next 必須是陣列`);
    // merge：'any'＝任一條線到就開始；缺省＝等全部（舊檔都沒有這個鍵）
    if (n.merge !== undefined && n.merge !== 'any') problems.push(`節點「${n.id}」merge 只能是 any（任一條到）`);
    if (kind === 'task') {
      if (!EXECUTORS.includes(n.executor)) problems.push(`節點「${n.id}」executor 必須是 ai 或 human`);
      if (!STOP_POINTS.includes(n.stop_point)) problems.push(`節點「${n.id}」stop_point 必須是 always 或 never`);
      if (typeof n.instruction !== 'string' || !n.instruction.trim()) problems.push(`節點「${n.id}」缺 instruction`);
      if (n.output_format !== undefined && typeof n.output_format !== 'string') problems.push(`節點「${n.id}」output_format 要是文字`);
      // handoff：人做步驟「完成時要交出什麼」——健檢據此判定下游 AI 有沒有內容來源
      for (const f of ['role_context', 'background', 'constraints', 'examples', 'review_focus', 'output_type', 'output_structure', 'output_length', 'output_tone', 'template_file', 'handoff']) {
        if (n[f] !== undefined && typeof n[f] !== 'string') problems.push(`節點「${n.id}」${f} 要是文字`);
      }
      if (n.output_file !== undefined && !OUTPUT_EXTS.includes(n.output_file)) problems.push(`節點「${n.id}」output_file 必須是 ${OUTPUT_EXTS.join('/')}`);
      // 參考檔勾選（三層共用檔）：字串＝這條流程自己的檔；{scope: company|category, name}＝組織／分類共用夾的參考類檔
      if (n.attachments !== undefined && (!Array.isArray(n.attachments) || !n.attachments.every(isAttachment))) {
        problems.push(`節點「${n.id}」attachments 要是檔名清單或 {scope, name}（不含路徑符號）`);
      }
      // 步驟層提前提醒：等時刻步驟的擋時限升級用；元素=九檔字串或 {at: 自訂時刻}
      if (n.remind_leads !== undefined && !isLeadList(n.remind_leads)) {
        problems.push(`節點「${n.id}」remind_leads 要是提前量清單（${REMIND_LEADS.join('/')} 或 {at: 時刻}）`);
      }
      // 等時刻：字串=固定時刻（ISO），物件 {from: nodeId}=由上游步驟產出決定（動態時刻）
      if (n.wait_until !== undefined) {
        const w = n.wait_until;
        const isFixed = typeof w === 'string' && w.trim();
        const isFrom = w && typeof w === 'object' && typeof w.from === 'string' && w.from.trim();
        if (!isFixed && !isFrom) problems.push(`節點「${n.id}」wait_until 要是時刻文字或 {from: 步驟id}`);
      }
      // 三個勾＝監工可以改這一步的什麼（缺省 note 開、tier 關（09-09 改）、tools 關，取值一律走 supervisor.supervisorFlags）
      if (n.supervisor !== undefined) {
        const sv = n.supervisor;
        if (!sv || typeof sv !== 'object' || Array.isArray(sv)) problems.push(`節點「${n.id}」supervisor 要是物件`);
        else {
          for (const f of ['note', 'tier', 'tools']) {
            if (sv[f] !== undefined && typeof sv[f] !== 'boolean') problems.push(`節點「${n.id}」supervisor.${f} 要是開或關`);
          }
        }
      }
      // 連線（ADR-006）：這一步要讀哪幾家已連上的服務（存服務全名，例 "claude.ai Gmail"）；誰勾的（ai 預勾／user 改過，重拆不蓋）
      if (n.connectors !== undefined && (!Array.isArray(n.connectors) || !n.connectors.every((c) => typeof c === 'string' && c.trim()))) {
        problems.push(`節點「${n.id}」connectors 要是服務名稱清單`);
      }
      if (n.connectors_set_by !== undefined && !CONNECTOR_SETTERS.includes(n.connectors_set_by)) problems.push(`節點「${n.id}」connectors_set_by 只能是 ai 或 user`);
      if (n.model_tier !== undefined && !MODEL_TIERS.includes(n.model_tier)) problems.push(`節點「${n.id}」model_tier 必須是 fast/balanced/deep`);
      if (n.creativity !== undefined && !['strict', 'open'].includes(n.creativity)) problems.push(`節點「${n.id}」creativity 必須是 strict/open`);
      if (n.retry !== undefined && ![0, 1, 2].includes(n.retry)) problems.push(`節點「${n.id}」retry 必須是 0/1/2`);
      // 一般節點多個 next＝並行分頭（fork/join 盒退場，多出線即並行、多入線即會合）
    } else if (kind === 'branch') {
      if (typeof n.instruction !== 'string' || !n.instruction.trim()) problems.push(`分岔「${n.id}」缺 instruction（判斷依據）`);
      const brs = Array.isArray(n.branches) ? n.branches : [];
      // 編輯中（allowFloating）允許剛放上畫布、路還沒拉滿的分岔／並行點；開跑與入庫一律要拉滿
      if (!allowFloating && brs.length < 2) problems.push(`分岔「${n.id}」至少要兩條路`);
      brs.forEach((b, j) => {
        if (!b || typeof b.label !== 'string' || !b.label.trim()) problems.push(`分岔「${n.id}」第 ${j + 1} 條路缺人話條件`);
      });
      if ((n.next ?? []).length) problems.push(`分岔「${n.id}」的路要寫在 branches，next 必須為空`);
    } else if (kind === 'fork') {
      if (!allowFloating && (n.next ?? []).length < 2) problems.push(`並行點「${n.id}」至少要兩支`);
    } else if (kind === 'join') {
      if ((n.next ?? []).length > 1) problems.push(`會合點「${n.id}」最多一個 next`);
    }
  }

  const byId = new Map(nodes.filter((n) => n && n.id).map((n) => [n.id, n]));
  for (const n of nodes) {
    if (!n || !n.id) continue;
    for (const target of outgoing(n)) {
      if (!ids.has(target)) problems.push(`節點「${n.id}」指向不存在的「${target}」`);
    }
    for (const m of String(n.instruction ?? '').matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)) {
      if (!paramKeys.has(m[1])) problems.push(`節點「${n.id}」的指示用了不存在的參數「${m[1]}」`);
    }
    if (n.wait_until && typeof n.wait_until === 'object' && n.wait_until.from && !ids.has(n.wait_until.from)) {
      problems.push(`節點「${n.id}」wait_until 引用了不存在的步驟「${n.wait_until.from}」`);
    }
  }

  if (!problems.length && nodes.length) {
    // 循環偵測（DFS 三色，掃全部節點——只從第一顆走會漏掉別支上的圈）
    const color = new Map(); // 0 未訪 1 訪問中 2 完成
    const cyc = (id) => {
      if (color.get(id) === 1) return true;
      if (color.get(id) === 2) return false;
      color.set(id, 1);
      for (const t of outgoing(byId.get(id))) if (byId.has(t) && cyc(t)) return true;
      color.set(id, 2);
      return false;
    };
    if (nodes.some((n) => cyc(n.id))) problems.push('Workflow 有繞圈（某條路走回了前面的步驟）');
    if (!allowFloating) {
      // 接進流程＝與第一顆節點連在同一張圖（不分方向）。多起點平行流程合法——
      // 執行引擎按「前面步驟都完成才開跑」推進，入度 0 的起點可以有多顆（健檢 P2-04；畫布同規則）
      const adj = new Map(nodes.map((n) => [n.id, new Set()]));
      for (const n of nodes) {
        for (const t of outgoing(n)) {
          if (!byId.has(t)) continue;
          adj.get(n.id).add(t);
          adj.get(t).add(n.id);
        }
      }
      const reach = new Set([nodes[0].id]);
      const stack = [nodes[0].id];
      while (stack.length) {
        for (const t of adj.get(stack.pop()) ?? []) if (!reach.has(t)) { reach.add(t); stack.push(t); }
      }
      for (const n of nodes) if (!reach.has(n.id)) problems.push(`斷鏈：「${n.title ?? n.id}」還沒接進 Workflow`);
    }
  }

  if (problems.length) throw new SchemaError(problems);
}

// 預設補值：純函式，回新物件——把「缺省」寫成明值，好讓流程頁的開關有東西可顯示、可切換。
// mode='create'（親手建的新流程、前端「存進流程庫」的 POST /api/workflows）：監工、查核、數字對原始資料三個都補。
//   facts 看這條流程有沒有「必填的資料欄位」——有資料要對才對，沒有就不必每步都去翻原始資料。
// mode='save'（PUT 存檔）：只補監工與查核，永遠不碰 facts——既有流程沒這個欄位＝缺省開，
//   手改一個節點位置就把它靜默翻成關，等於使用者沒按過任何按鈕，「數字對原始資料」就自己關掉了。
// 匯入不套（沿用缺省語意）。型別錯不在這裡表態，交給 validateWorkflow 報人話。
// 第三參數 defaults＝設定頁「新流程的預設」（settings.json 的 defaults，缺鍵補程式缺省）。只有 create 吃它：
//   產檔權限、查核開關、監工開關照設定；check_facts 'auto'＝現行 required 規則、'on'／'off'＝固定；
//   每個 task 節點缺三個勾且設定值不等於程式缺省時才寫進節點（等於缺省就不寫，節點乾淨、supervisorFlags 取值一樣）。
//   save 永遠只補兩個主開關（既有流程缺省語意＝開，不吃新流程的預設）。defaults 省略＝程式缺省，行為與以前一字不差。
const PROGRAM_DEFAULTS = DEFAULT_SETTINGS.defaults;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function applyDefaults(def, { mode, defaults } = {}) {
  if (!isObj(def)) return def;
  const out = { ...def };
  if (mode !== 'create') {
    if (out.supervisor === undefined) out.supervisor = { enabled: true };
    if (out.check === undefined) out.check = { enabled: true };
    return out;
  }
  const d = { ...PROGRAM_DEFAULTS, ...(isObj(defaults) ? defaults : {}) };
  if (out.supervisor === undefined) out.supervisor = { enabled: d.supervisor_enabled !== false };
  if (out.check === undefined) out.check = { enabled: d.check_enabled !== false };
  if (out.permissions === undefined) out.permissions = { files: d.permissions_files !== false };
  // 連線權限：親手建的新流程預設開（草稿帶了 permissions 但沒寫 connectors 也補開；明寫關的照留）
  if (isObj(out.permissions) && out.permissions.connectors === undefined) out.permissions = { ...out.permissions, connectors: true };
  const ck = out.check;
  if (isObj(ck) && ck.facts === undefined) {
    const facts = d.check_facts === 'on' ? true : d.check_facts === 'off' ? false
      : Array.isArray(out.params) && out.params.some((p) => p && p.required === true);
    out.check = { ...ck, facts };
  }
  const flags = { ...PROGRAM_DEFAULTS.supervisor_flags, ...(isObj(d.supervisor_flags) ? d.supervisor_flags : {}) };
  const custom = Object.keys(PROGRAM_DEFAULTS.supervisor_flags).some((k) => flags[k] !== PROGRAM_DEFAULTS.supervisor_flags[k]);
  if (custom && Array.isArray(out.nodes)) {
    out.nodes = out.nodes.map((n) => (isObj(n) && nodeKind(n) === 'task' && n.supervisor === undefined ? { ...n, supervisor: { ...flags } } : n));
  }
  return out;
}

// 全域設定逐欄驗證（PUT /api/settings）：回人話清單，空＝合法。缺鍵不報（readSettings 會補缺省），只驗有給的。
const SENSITIVE_NAMES = { health: '健康', politics: '政治', religion: '宗教', finance: '財務' };
export function validateSettings(s) {
  const out = [];
  if (!isObj(s)) return ['設定格式不對'];
  const isBool = (v) => typeof v === 'boolean';
  const chk = (v, ok, msg) => { if (v !== undefined && !ok(v)) out.push(msg); };
  chk(s.version, (v) => v === 1, '設定版本只能是 1');
  const m = s.memory;
  chk(m, isObj, '設定的記憶格式不對');
  if (isObj(m)) {
    chk(m.paused, isBool, '記憶整層暫停要是開或關');
    chk(m.sensitive, isObj, '設定的敏感類別格式不對');
    if (isObj(m.sensitive)) {
      for (const [k, name] of Object.entries(SENSITIVE_NAMES)) chk(m.sensitive[k], isBool, `敏感類別「${name}」要是開或關`);
    }
    chk(m.intro_done_at, (v) => v === null || typeof v === 'string', '介紹完成時間要是時刻文字或空');
  }
  const d = s.defaults;
  chk(d, isObj, '設定的新 Workflow 預設格式不對');
  if (isObj(d)) {
    chk(d.permissions_files, isBool, '新 Workflow 的產檔權限預設要是開或關');
    chk(d.check_enabled, isBool, '新 Workflow 的每步都查預設要是開或關');
    chk(d.check_facts, (v) => ['auto', 'on', 'off'].includes(v), '數字對原始資料的預設只能是 auto、on、off');
    chk(d.supervisor_enabled, isBool, '新 Workflow 的監工預設要是開或關');
    chk(d.supervisor_flags, isObj, '設定的監工三個勾預設格式不對');
    if (isObj(d.supervisor_flags)) {
      for (const k of ['note', 'tier', 'tools']) chk(d.supervisor_flags[k], isBool, `監工三個勾的預設（${k}）要是開或關`);
    }
    chk(d.model_tier, (v) => v === null || MODEL_TIERS.includes(v), '模型檔位的預設只能是 fast、balanced、deep，或不設');
    chk(d.retry, (v) => v === null || [0, 1, 2].includes(v), '自動重試的預設只能是 0、1、2，或不設');
  }
  const e = s.exec;
  chk(e, isObj, '設定的執行與排程格式不對');
  if (isObj(e)) {
    chk(e.auto_makeup, isBool, '錯過自動補的預設要是開或關');
    chk(e.remind_leads, isLeadList, `提前提醒的預設要是提前量清單（${REMIND_LEADS.join('/')} 或 {at: 時刻}）`);
    chk(e.web, isBool, '允許查網路要是開或關');
  }
  chk(s.company_name, (v) => typeof v === 'string' && Array.from(v).length <= 60, '組織名稱要是文字、60 字內');
  const c = s.compose; //
  chk(c, isObj, '設定的拆解格式不對');
  if (isObj(c)) chk(c.confirm_shape, isBool, '拆之前先確認成品長相要是開或關');
  return out;
}
