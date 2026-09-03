// schema — workflow 定義驗證（命名見 GLOSSARY.md；有向圖模型見 規劃/機器合約.md）
// 節點 kind：task（預設）｜branch 分岔｜fork 並行點（畫布調色盤元件）｜join（舊格式相容，畫布編輯時自動拆直——會合=多條線接進同一步）
export class SchemaError extends Error {
  constructor(problems) {
    super(`流程定義有問題：${problems.join('；')}`);
    this.problems = problems;
  }
}

const EXECUTORS = ['ai', 'human'];
const STOP_POINTS = ['always', 'never'];
const KINDS = ['task', 'branch', 'fork', 'join'];
// 檔案格式三級制（D19→產檔輪）：TIER1 引擎直接存文字；OFFICE 由工人在產出資料夾用剝繭自帶套件產真檔（需流程 permissions.files）；
// TIER2（簡報／PDF）第二批才接，未接時降級存 .md 並講明
export const OUTPUT_TIER1 = ['md', 'txt', 'csv', 'html', 'json'];
export const OUTPUT_OFFICE = ['docx', 'xlsx'];
export const OUTPUT_TIER2 = ['pptx', 'pdf'];
const OUTPUT_EXTS = [...OUTPUT_TIER1, ...OUTPUT_OFFICE, ...OUTPUT_TIER2];

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
  if (typeof def.name !== 'string' || !def.name.trim()) problems.push('缺 name（流程名稱）');
  // 流程權限（產檔輪）：files＝允許工人在這趟的產出資料夾寫檔與執行程式；沒帶＝關
  if (def.permissions !== undefined) {
    const pm = def.permissions;
    if (!pm || typeof pm !== 'object' || Array.isArray(pm)) problems.push('permissions 要是物件');
    else if (pm.files !== undefined && typeof pm.files !== 'boolean') problems.push('permissions.files 要是開或關');
  }

  const params = Array.isArray(def.params) ? def.params : (problems.push('params 必須是陣列'), []);
  const paramKeys = new Set();
  params.forEach((p, i) => {
    if (!p || typeof p.key !== 'string' || !p.key.trim()) problems.push(`params[${i}] 缺 key`);
    else if (paramKeys.has(p.key)) problems.push(`參數 key「${p.key}」重複`);
    else paramKeys.add(p.key);
    if (!p || typeof p.label !== 'string' || !p.label.trim()) problems.push(`params[${i}] 缺 label`);
    if (!p || p.default === undefined) problems.push(`params[${i}] 缺 default`);
    // required／hint（排程與健檢輪）：必填旗標＋「要貼什麼」提示；純資料欄位由拆解器標，開跑前健檢據此擋沒填
    if (p && p.required !== undefined && typeof p.required !== 'boolean') problems.push(`params[${i}] required 要是開或關`);
    if (p && p.hint !== undefined && typeof p.hint !== 'string') problems.push(`params[${i}] hint 要是文字`);
  });

  const nodes = Array.isArray(def.nodes) && def.nodes.length ? def.nodes : (problems.push('nodes 必須是非空陣列'), []);
  const ids = new Set();
  for (const [i, n] of nodes.entries()) {
    const at = `nodes[${i}]`;
    if (!n || typeof n.id !== 'string' || !n.id.trim()) { problems.push(`${at} 缺 id`); continue; }
    if (ids.has(n.id)) problems.push(`節點 id「${n.id}」重複`);
    else ids.add(n.id);
    if (typeof n.title !== 'string' || !n.title.trim()) problems.push(`${at} 缺 title`);
    const kind = nodeKind(n);
    if (!KINDS.includes(kind)) { problems.push(`節點「${n.id}」kind 必須是 task/branch/fork/join`); continue; }
    if (!Array.isArray(n.next)) problems.push(`${at} next 必須是陣列`);
    if (kind === 'task') {
      if (!EXECUTORS.includes(n.executor)) problems.push(`節點「${n.id}」executor 必須是 ai 或 human`);
      if (!STOP_POINTS.includes(n.stop_point)) problems.push(`節點「${n.id}」stop_point 必須是 always 或 never`);
      if (typeof n.instruction !== 'string' || !n.instruction.trim()) problems.push(`節點「${n.id}」缺 instruction`);
      if (n.output_format !== undefined && typeof n.output_format !== 'string') problems.push(`節點「${n.id}」output_format 要是文字`);
      // handoff（資料通道輪）：人做步驟「完成時要交出什麼」——健檢據此判定下游 AI 有沒有內容來源
      for (const f of ['role_context', 'background', 'constraints', 'examples', 'review_focus', 'output_type', 'output_structure', 'output_length', 'output_tone', 'template_file', 'handoff']) {
        if (n[f] !== undefined && typeof n[f] !== 'string') problems.push(`節點「${n.id}」${f} 要是文字`);
      }
      if (n.output_file !== undefined && !OUTPUT_EXTS.includes(n.output_file)) problems.push(`節點「${n.id}」output_file 必須是 ${OUTPUT_EXTS.join('/')}`);
      if (n.attachments !== undefined && (!Array.isArray(n.attachments) || n.attachments.some((a) => typeof a !== 'string' || /[\\/]|\.\./.test(a)))) {
        problems.push(`節點「${n.id}」attachments 要是檔名清單（不含路徑符號）`);
      }
      // 步驟層提前提醒（D20）：等時刻步驟的擋時限升級用；元素=九檔字串或 {at: 自訂時刻}
      if (n.remind_leads !== undefined) {
        const LEADS = ['10m', '30m', '1h', '2h', '3h', '6h', '12h', '1d', '2d'];
        const bad = !Array.isArray(n.remind_leads) || n.remind_leads.some((l) =>
          !(typeof l === 'string' ? LEADS.includes(l) : l && typeof l === 'object' && typeof l.at === 'string'));
        if (bad) problems.push(`節點「${n.id}」remind_leads 要是提前量清單（${'10m/30m/1h/2h/3h/6h/12h/1d/2d'} 或 {at: 時刻}）`);
      }
      // 等時刻（D20）：字串=固定時刻（ISO），物件 {from: nodeId}=由上游步驟產出決定（動態時刻）
      if (n.wait_until !== undefined) {
        const w = n.wait_until;
        const isFixed = typeof w === 'string' && w.trim();
        const isFrom = w && typeof w === 'object' && typeof w.from === 'string' && w.from.trim();
        if (!isFixed && !isFrom) problems.push(`節點「${n.id}」wait_until 要是時刻文字或 {from: 步驟id}`);
      }
      if (n.model_tier !== undefined && !['fast', 'balanced', 'deep'].includes(n.model_tier)) problems.push(`節點「${n.id}」model_tier 必須是 fast/balanced/deep`);
      if (n.creativity !== undefined && !['strict', 'open'].includes(n.creativity)) problems.push(`節點「${n.id}」creativity 必須是 strict/open`);
      if (n.retry !== undefined && ![0, 1, 2].includes(n.retry)) problems.push(`節點「${n.id}」retry 必須是 0/1/2`);
      // 一般節點多個 next＝並行分頭（畫布回饋輪：fork/join 盒退場，多出線即並行、多入線即會合）
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
    if (nodes.some((n) => cyc(n.id))) problems.push('流程有繞圈（某條路走回了前面的步驟）');
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
      for (const n of nodes) if (!reach.has(n.id)) problems.push(`斷鏈：「${n.title ?? n.id}」還沒接進流程`);
    }
  }

  if (problems.length) throw new SchemaError(problems);
}
