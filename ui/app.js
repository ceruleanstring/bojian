// 剝繭 UI — 白澤皮 · D15 雙區版型：左=流程庫邊欄；右=工作區（聊天｜清單｜畫布｜履歷 一鍵切換）。
// 聊天、清單、畫布是同一份定義的三種建立／編輯方式；run 執行畫面整區接管。
/* global document, fetch, window, BJCanvas */
const app = document.getElementById('app');
const hostdot = document.getElementById('hostdot');

const state = {
  workflows: [],
  categories: [],
  wf: null,          // 已存流程 {category, id, def, runs}
  run: null,         // 開著的 run 紀錄
  mode: 'chat',      // 工作區分頁：chat｜list｜canvas｜history
  editingNode: null, // 停點卡原地編輯中的節點 id
  expanded: new Set(), // 清單模式展開指示的節點
  chat: { messages: [], draft: null, busy: false },
  paramNow: {},      // 這次開跑要用的欄位值（僅本次，開別的流程即清）
  editingParam: null, // 指示句內正在點改的欄位 key
  canvasSel: null,
  presets: {},       // 常用預設庫（D19，複製式）
  wfFiles: [],       // 當前流程的參考檔清單
  drawerOpen: false, // 畫布右側抽屜（雙擊節點打開，D17）
  drawerTab: 'content', // 抽屜子頁（D21）：content=任務內容、spec=產出規格
  drawerTabFor: null,   // 這個頁位屬於哪顆節點——換節點自動回「任務內容」
  cvMore: null,         // 抽屜「背景、限制與參考資料」收摺（移植第一批 T11）：null＝照有沒有值決定、true/false＝使用者點過
  cvShowIssues: false, // 存檔查出接線問題後，紅標未接上／線不足的步驟
  cvWork: null,      // 畫布工作本（v0.18）：已存流程的未存檔改動
  cvDirty: false,    // 畫布有未存檔改動
  proposals: { pending: [], more: 0 },
  versions: [],
  feedbackSent: false,
  trash: [],
  showTrash: false,
  corrupt: null,
  importPreview: null,
  importScanning: false,
  addingCategory: false,
  addingParam: false,
  savingDraft: false,
  claude: null,
  pollTimer: null,
  // ---- 行事曆（D20）----
  calendar: null,      // 開啟時 {month:'YYYY-MM', data, snapErr}
  calDrawer: null,     // 單次抽屜：{kind:'sched', sid, occ, time}｜{kind:'goog', title, time}
  calDrawerDef: null,  // 抽屜內排程對應流程的定義（步驟清單用）
  stepModal: null,     // 步驟浮窗 {sid, nodeId}
  schedModal: null,    // 排程設定浮窗 {sid}（null 欄位=新增）
  schedManage: false,  // 排程清單浮窗（健檢 M3：停用／過期／設定有誤的排程也有穩定入口）
  calPicker: null,     // 快速跳月浮層 {year}（null=關）：開著＋暫選年份都在 state，輪詢重繪不會關掉或打回
  todos: [],
  notices: { unread: [], done: [] },
  noticesOpen: false,  // 已處理摺疊展開
  calPollTimer: null,
  // ---- 儀表板（儀表板輪）----
  dash: null,          // 開啟時 {data, usageView:'flow'|'day', open:{run鍵→細節}, promptView}
  dashPollTimer: null,
  // ---- 資料通道輪（T5）----
  startCheck: null,    // 開跑前健檢卡 {key:定義JSON, level:'block'|'warn', issues}；定義一變就作廢
  dataSupplyOpen: null, // 資料不全卡「補資料」展開中的節點 id
  editRulesOpen: null,  // 「後面每步會守」清單改寫中的節點 id（交貨查核輪）
  supOpen: {},          // 停點卡／查核卡「監工交代」展開中的節點（監工輪）——狀態在這，輪詢重繪不會收合
  keep: {},            // 打字中的多行內容（run_id:元素id → 文字）——整頁重繪後放回，不被輪詢吃掉
  runJson: null,       // 上次抓到的 run 原文——輪詢只在真的變了才重繪
  // ---- 產檔輪（T5）----
  preview: null,       // 成品預覽浮窗 {cat,id,rid,name,data,err,sheet}——狀態在這，輪詢重繪不會關掉它
  rendered: {},        // 文字成品排版快取：內容雜湊 → html（false＝這段排不出來，顯示原文）
  rawView: new Set(),  // 停點卡／成品區按了「看原文」的鍵
  permErr: null,       // 產檔權限開關沒存成的一句話
  permFlashUntil: 0,   // 健檢「修這裡」把權限列亮到幾點（毫秒）——狀態驅動，中途整頁重繪也不會掉 class
  // ---- 記憶輪（M1c）----
  categoryPage: null,  // 群組圈分類頁（側欄分類標題點開）：{category, data:群組圈|null, cards:分類層習慣卡, err, saving, saveErr}
  // ---- 移植第一批 T9：側欄四全域項＋流程庫頁 ----
  library: null,       // 流程庫頁 {q, cat}；null＝沒開
  catClosed: new Set(), // 側欄收合中的分類（只在這個 session，不存）
  // ---- 移植第一批 T10：流程頁兩分頁＋兩浮窗 ----
  flowTab: 'design',   // 流程頁上層分頁：design＝設計流程（聊天／清單／畫布／履歷）、data＝本次資料（開跑表單）
  flowSettingsOpen: false, // 「流程設定」浮窗（產出檔案／交貨查核／監工三開關）
  flowMemOpen: false,  // 記憶一行「查看」浮窗（兩格）
  // ---- 記憶輪（M2）----
  intro: null,         // 首次三題介紹（開站蓋在儀表板前）：{saving, err}；null＝答過或跳過了
  memUndoing: {},      // 通知「不要記」按下去到回來之間（卡 id→true），輪詢重繪不會把按鈕復活
  // ---- 記憶輪（M3b）：開跑表單的習慣選項、點了即核可、身分 ----
  wfMemory: null,      // GET /api/memory/for-workflow 的回應（options＝每個欄位旁的習慣選項）；讀不到＝null：沒有 chip，流程照開
  memPicks: {},        // 這次開跑點了哪些習慣卡（欄位 key→卡 id）——點了即核可，隨「開始」送出
  memChanged: [],      // 點了又改掉的卡 id（後端只記數）
  memMore: {},         // 欄位 key→true：那格的「更多」展開中
  memIdentity: '',     // 這次以哪個身分跑（身分 id；空＝不限縮）
  identities: [],      // 身分清單（有才顯示下拉）
  // ---- 記憶輪（M4）：就地看 ----
  memOpen: {},         // 停點卡／查核卡「這步用了 N 條記憶」展開中的節點（不共用 supOpen）——狀態在這，輪詢重繪不會收合
  memModal: null,      // 卡片浮窗 {id, bucket, card, err, busy, replacing}：card＝GET /api/memory/cards/:id 讀回的整張卡（群組條沒有 API，直接帶 text）；replacing＝「改」展開新內容框
  // ---- 記憶輪（M5a）：設定頁（整頁模式，同儀表板／行事曆）----
  settings: null,      // 開啟時 {group, tab:{組→子分頁}, data, err, idEdit, presetEdit, merge}：data＝summary／cards／groups／dict／cfg／identities；idEdit／presetEdit＝編輯中的表單（單一真相，重繪從它還原）
  memIdentitySet: false, // 開跑表單的身分下拉被人動過：沒動＝用 for-workflow 回的預設（綁這個分類的身分）
  // ---- 移植合併輪 U2a：三層樹的根＝公司 ----
  companyName: '',     // 設定的公司名稱（GET /api/settings 的 company_name；空＝側欄印「公司」）
  sharedUpload: null,  // 移植合併輪 U2b：公司頁／部門頁按「上傳」後記 {scope, kind}，#shared-file 的 change 事件讀它決定傳到哪一層哪一區
  // ---- 移植合併輪 U4b：流程頁右側「流程資料夾」＋共用檔浮窗＋本次資料收摺（狀態都在這，重繪讀回，不靠 DOM 的 open） ----
  wfRuns: [],          // GET …/runs?detail=1 的歷次執行摘要（started_at 倒序）；null＝讀不到。state.wf.runs 仍是原三欄形狀給 resumeHtml
  shared: { company: null, dept: null, err: null }, // 兩層共用檔清單（GET /api/shared/:scope/files）；null＝還沒讀到；err＝哪一支讀不到的一句
  sharedOpen: false,   // 「公司 N 份・部門 M 份共用檔 → 查看」浮窗
  folderOpen: { refs: true, runs: true, optional: null, refsAll: false, runsAll: false }, // 側欄兩塊 details、本次資料「其他資料（選填）」（null＝照有沒有值決定）、兩個「查看全部」
  // ---- 移植合併輪 U6a：執行頁三欄（狀態都在這，輪詢重繪讀回，不靠 DOM 的 open）----
  sideOpen: { sup: true, data: true, focus: false, attempts: false }, // 右欄四格開合：監工交代／這步會用到的資料／驗收重點／每次交卷
  runInspect: null,    // 左軌點了哪一步＝歷史視圖（U6c；null＝看目前這步）。開跑／打開別的 run／節點消失重設，輪詢不碰，不進 keep
  promptView: null,    // 執行頁「當時指示」卷宗浮窗 {title, text}（U6b 接；與儀表板的 promptModalHtml 共用）
};
const seenNotices = new Set(); // 桌面通知去重（本次開頁期間）

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wfPath = (w) => `/api/workflows/${encodeURIComponent(w.category)}/${encodeURIComponent(w.id)}`;
// 成品檔位址：不帶 sub＝下載；'/preview'＝頁內預覽形態；'/inline'＝內嵌回檔（pdf iframe）
const runFileUrl = (cat, id, rid, name, sub = '') => `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}/runs/${encodeURIComponent(rid)}/files/${encodeURIComponent(name)}${sub}`;

// 目前工作區的主體：草稿優先，其次已存流程
const subjectDef = () => state.chat.draft ?? state.wf?.def ?? null;
const subjectIsDraft = () => !!state.chat.draft;
// 畫布工作本（v0.18）：已存流程在畫布的改動先進本地緩衝，按「存檔」才落地；離開畫布即清
const cvDef = () => (!subjectIsDraft() && state.cvWork ? state.cvWork : subjectDef());

// 聊天紀錄按流程各自保留（僅存於本次開啟期間；重開頁面歸零）
const chatByFlow = new Map();
const flowKey = (w) => `${w.category}/${w.id}`;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.error ?? '發生未知錯誤');
    err.status = res.status;
    err.body = json; // 409 帶 issues（開跑前健檢後端兜底）
    throw err;
  }
  return json;
}

// ---- 開跑前健檢（T5）：結果按定義 JSON 字串快取，抽屜／清單每次 render 不重打 ----
const preflightCache = { key: null, result: null, failed: false, pending: null };
// values＝這次的欄位值（只有按「開始」才帶）：帶值的結果隨值而變，不進快取
async function preflightNow(def, values) {
  const key = JSON.stringify(def);
  if (!values && preflightCache.key === key && preflightCache.result) return preflightCache.result;
  const r = await api('POST', '/api/preflight', values ? { def, values } : { def });
  if (!values) Object.assign(preflightCache, { key, result: r, failed: false, pending: null });
  return r;
}
// render 途中用：有快取就回，沒有就背景打一次、回來只補 DOM（不整頁 render，免得洗掉抽屜裡的字）
function preflightFor(def) {
  if (!def) return null;
  const key = JSON.stringify(def);
  if (preflightCache.key === key) return preflightCache.result;
  if (preflightCache.pending !== key) {
    preflightCache.pending = key;
    preflightNow(def).then(patchPreflightDom).catch(() => {
      if (preflightCache.pending !== key) return;
      Object.assign(preflightCache, { key, result: null, failed: true, pending: null }); // 端點沒好／讀不到：這份定義不再重試
      patchPreflightDom();
    });
  }
  return null;
}
function patchPreflightDom() {
  const box = document.getElementById('drawer-inputs');
  if (box) {
    const def = cvDef();
    const n = def?.nodes.find((x) => x.id === state.canvasSel);
    if (n) box.outerHTML = drawerInputsHtml(n, def);
  }
  const unused = preflightCache.result?.unused_params ?? [];
  for (const c of document.querySelectorAll('[data-unused]')) c.hidden = !unused.includes(c.dataset.unused);
  const src = document.querySelector('[data-srcline]'); // 執行頁右欄「來源：」（U6b）：健檢回來只補這一行，不整頁重繪
  if (src && state.run) src.outerHTML = sideSourceHtml(state.run, sideNodeOf(state.run));
}

// ---- 打字中的多行框（T5）：input 事件存進 state.keep，重繪後放回 ----
const keepKey = (id) => `${state.run?.run_id ?? '-'}:${id}`;
const kept = (id) => state.keep[keepKey(id)];
const FIELD_SIZING = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');
function autoGrow(el) {
  el.classList.toggle('multi', el.value.includes('\n'));
  if (FIELD_SIZING) return; // 瀏覽器原生自動長高；沒有的退化成用 scrollHeight 撐
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}
const autoGrowAll = () => { for (const el of app.querySelectorAll('textarea.autogrow')) autoGrow(el); };

async function refreshLibrary() {
  state.workflows = await api('GET', '/api/workflows');
  state.categories = await api('GET', '/api/categories');
  state.trash = await api('GET', '/api/trash');
}

// ---- 圖形小工具（與後端 graph.js 同邏輯的前端版）----
const kindOf = (n) => n.kind ?? 'task';
const outgoingOf = (n) => (kindOf(n) === 'branch' ? (n.branches ?? []).map((b) => b.next) : (n.next ?? []));
function topoNodes(def) {
  const preds = new Map(def.nodes.map((n) => [n.id, []]));
  for (const n of def.nodes) for (const t of outgoingOf(n)) preds.get(t)?.push(n.id);
  const depth = new Map();
  const visit = (id) => {
    if (depth.has(id)) return depth.get(id);
    depth.set(id, 0);
    const ps = preds.get(id) ?? [];
    const d = ps.length ? Math.max(...ps.map(visit)) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  for (const n of def.nodes) visit(n.id);
  return [...def.nodes].sort((a, b) => depth.get(a.id) - depth.get(b.id) || def.nodes.indexOf(a) - def.nodes.indexOf(b));
}
const newNodeId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// {{代碼}} → 句子裡直接放值（前台）；代碼只留後台與畫布編輯器
// values=這次要用的值（缺項退預設）；editable=true 時值可點改（草稿改預設、已存流程只影響這一次）
function humanize(text, def, values, editable) {
  const params = Object.fromEntries((def?.params ?? []).map((p) => [p.key, p]));
  return esc(text).replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, key) => {
    const p = params[key];
    if (!p) return `<span class="pchip"><i class="ph ph-sliders-horizontal"></i>${esc(key)}</span>`;
    const val = values?.[key] ?? p.default;
    if (editable && state.editingParam === key) {
      return `<input class="pvedit" data-pedit="${esc(key)}" value="${esc(val)}" style="width:${Math.min(24, Math.max(4, String(val).length + 2))}ch">`;
    }
    if (editable) return paramChipHtml(p, key, val);
    return `<span class="pchip" title="${esc(p.label)}">${esc(val)}</span>`;
  });
}
// 句內可點改的欄位膠囊（humanize 與行內編輯收尾共用）
function paramChipHtml(p, key, val) {
  const hint = subjectIsDraft() ? '點一下改預設' : '點一下改，只影響這一次';
  return `<span class="pchip pv" data-pkey="${esc(key)}" title="${esc(p.label)}——${hint}">${esc(val)}</span>`;
}
// 欄位值一改，句內同名膠囊就地更新——不整頁重繪（blur 時重繪會讓正要按下的「開始」落空）
function syncParamChips(key, val) {
  for (const c of app.querySelectorAll(`.pchip.pv[data-pkey="${CSS.escape(key)}"]`)) c.textContent = val;
}

// 句內欄位值編輯收尾：寫回（草稿=預設值；已存流程=只影響這一次）並關閉編輯
function commitParamEdit(el) {
  const key = state.editingParam;
  if (!key) return;
  if (el && el.value.trim() !== '') {
    if (subjectIsDraft()) {
      const p = state.chat.draft.params.find((x) => x.key === key);
      if (p) p.default = el.value.trim();
    } else state.paramNow[key] = el.value.trim();
  }
  state.editingParam = null;
  if (subjectIsDraft()) { render(); return; }
  // 已存流程不整頁重繪（focusout 常是正要按「開始」，重繪會讓那一下落空）：輸入框換回膠囊、同名膠囊與下方表單同步
  const p = state.wf?.def.params.find((x) => x.key === key);
  if (!p) { render(); return; }
  const val = state.paramNow[key] ?? p.default;
  if (el?.isConnected) el.outerHTML = paramChipHtml(p, key, val);
  syncParamChips(key, val);
  memParamEdited(key, val);
  const ta = app.querySelector(`[data-param="${CSS.escape(key)}"]`);
  if (ta && ta.value !== val) { ta.value = val; autoGrow(ta); }
}

// ---- 記憶輪（M3b）：開跑表單的習慣選項 ----
// 這格的選項清單：實線＝涵蓋這條流程的卡（covers）、虛線＝同分類別條流程的（probes，標來源流程）；沒卡的欄位回空
function memOptionsOf(key) {
  const o = state.wfMemory?.options?.[key];
  if (!o) return [];
  return [...(o.covers ?? []), ...(o.probes ?? []).map((c) => ({ ...c, probe: true }))];
}
const memOptionCard = (key, id) => memOptionsOf(key).find((c) => c.id === id) ?? null;
const HABIT_SHOW = 3; // 每格先露幾張，其餘收「更多」
// 欄位值框下方那一排 chip：點了＝填值＋核可（.on）；虛線的點了開跑後範圍才擴大；超過三張收「更多 N」
function habitChipsHtml(p) {
  const list = memOptionsOf(p.key);
  if (!list.length) return '';
  const open = state.memMore[p.key] === true;
  const show = open ? list : list.slice(0, HABIT_SHOW);
  const picked = state.memPicks[p.key];
  const scopeHint = (c) => (c.probe ? `來自「${c.from}」：點了開跑後範圍會擴大到這個分類，仍是選項`
    : c.scope?.level === 'all' ? '全部流程共用的習慣' : c.scope?.level === 'category' ? '這個分類共用的習慣' : '這條流程的習慣');
  const chip = (c) => `<span class="hchip${c.probe ? ' probe' : ''}${picked === c.id ? ' on' : ''}" data-act="mem-pick" data-key="${esc(p.key)}" data-id="${esc(c.id)}" title="${esc(scopeHint(c))}">
      <i class="${picked === c.id ? 'ph-fill ph-check-circle' : c.probe ? 'ph ph-arrows-out-line-horizontal' : 'ph ph-cards'}"></i><span class="t">${esc(c.text)}</span>${c.probe ? `<span class="fr">來自「${esc(c.from)}」</span>` : ''}</span>`;
  const more = list.length > HABIT_SHOW
    ? `<span class="hchip more" data-act="mem-more" data-key="${esc(p.key)}">${open ? '收起' : `更多 ${list.length - HABIT_SHOW}`}</span>` : '';
  return `<div class="habits" data-habits="${esc(p.key)}"><span class="lbl">習慣選項</span>${show.map(chip).join('')}${more}</div>`;
}
// 表單頂端的身分下拉（有身分才顯示）：只限縮「關於你」帶哪些認識卡，習慣選項與群組規矩不受它影響
function identityRowHtml() {
  const list = state.identities ?? [];
  if (!list.length) return '';
  return `<div class="param memidn"><span>身分</span>
    <select id="mem-identity" class="moveselect" title="只帶這個身分列的認識卡；不指定＝全部都帶">
      <option value="">不指定（全部認識卡都帶）</option>
      ${list.map((i) => `<option value="${esc(i.id)}" ${state.memIdentity === i.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}
    </select></div>`;
}
const habitsNoteHtml = () => (Object.keys(state.wfMemory?.options ?? {}).length
  ? '<p class="note habitsnote"><i class="ph ph-info"></i> 習慣選項只是選項：沒點就不套用；點了就是核可，不另外問。虛線的來自別條流程，點了範圍才擴大。</p>' : '');
// 欄位被改字（表單框或句內膠囊）：點過的卡若跟現在的值不同＝取消核可、記進 memChanged（後端只記數）；chip 就地取消選中，不重繪
function memParamEdited(key, val) {
  const id = state.memPicks[key];
  if (!id) return;
  const card = memOptionCard(key, id);
  if (card && card.text === val) return;
  delete state.memPicks[key];
  if (!state.memChanged.includes(id)) state.memChanged.push(id);
  for (const el of app.querySelectorAll(`.hchip.on[data-key="${CSS.escape(key)}"]`)) {
    el.classList.remove('on');
    const ic = el.querySelector('i');
    if (ic) ic.className = el.classList.contains('probe') ? 'ph ph-arrows-out-line-horizontal' : 'ph ph-cards';
  }
}
// 開跑表單的習慣選項與身分清單：讀不到＝沒有 chip、沒有下拉，流程照開。
// 身分（M5a）：下拉沒動過＝不帶參數，後端回預設綁這個分類的身分（identity），下拉跟著預選；動過＝照下拉的值帶 ?identity=（空＝不限縮）
async function refreshWfMemory() {
  const w = state.wf;
  if (!w) return;
  const idq = state.memIdentitySet ? `?identity=${encodeURIComponent(state.memIdentity)}` : '';
  const [mem, idns] = await Promise.all([
    api('GET', `/api/memory/for-workflow/${encodeURIComponent(w.category)}/${encodeURIComponent(w.id)}${idq}`).catch(() => null),
    api('GET', '/api/memory/identities').catch(() => []),
  ]);
  if (state.wf !== w) return; // 讀到一半已切走
  state.wfMemory = mem;
  state.identities = Array.isArray(idns) ? idns : [];
  if (!state.memIdentitySet) state.memIdentity = mem?.identity ?? '';
}

// ---- 記憶輪（M4）：就地看——流程頁兩格、停點卡「這步用了 N 條」、抽屜一列、卡片浮窗、儀表板一行 ----
// 卡上的小標籤：認識卡照層、群組條照來源、習慣卡照欄位（都用既有 .chip 淺底墨字，不另配色）
function memTagHtml(c) {
  if (c.bucket === 'group') return '<span class="chip">分類守則</span>';
  if (c.bucket === 'profile') return `<span class="chip">${c.layer === 'content' ? '按場合帶' : '每步帶'}</span>`;
  return `<span class="chip">${c.field ? `欄位：${esc(c.field)}` : '開跑選項'}</span>`;
}
// 「用在哪」人話：全部流程／<分類>這個分類／只有「<流程名>」（流程名對不到側欄清單就退回「分類/id」）
function memScopeText(s) {
  if (!s?.level) return '（沒寫）';
  if (s.level === 'all') return '全部流程';
  if (s.level === 'category') return `${s.category ?? ''}這個分類`;
  return `只有「${s.workflow && s.category ? wfNameOf(s.category, s.workflow) : (s.workflow ?? '')}」`;
}
const MEM_SOURCE_TXT = { intro: '介紹你自己時說的', chat: '聊天裡說的', 'stop-note': '停點的註記', 'run-params': '開跑表單連兩趟填同一個值', 'stop-edit': '停點連兩趟往同方向改', feedback: '跑完丟的一句結果', 'group-box': '分類的規矩框', manual: '你在記憶頁加的', replace: '取代舊卡時寫的' };
const MEM_STATUS_TXT = { active: '活躍', dormant: '休眠', retired: '退休', replaced: '被取代' };
const memAt = (x) => (x ? new Date(x).toLocaleString('zh-TW', { hour12: false }) : '—');
// 條目：點了開卡片浮窗（群組條沒有卡 API，text 與分類直接帶在 dataset 上）
const memCardLi = (c, tag, cat = '') => `<li data-act="mem-card" data-id="${esc(c.id)}" data-bucket="${esc(c.bucket ?? 'habit')}" data-text="${esc(c.text)}" data-cat="${esc(cat)}" title="點開看出處原話"><span class="t">${esc(c.text)}</span>${tag ? `<span class="from">${esc(tag)}</span>` : ''}</li>`;

// 流程頁兩格（讀 state.wfMemory，不走 preflight）：格一「每步都帶」＝關於你（表達層＋內容層場合對上的）＋分類守則（群組條）；
// 格二「開跑選項（習慣卡）」＝自己（生在這條）・繼承（分類／全部）・別條的（同分類別條流程的，點了才擴）。兩格都空→不顯示
function flowMemHtml() {
  const m = state.wfMemory;
  if (!m || subjectIsDraft()) return '';
  const core = [...(m.core?.expression ?? []), ...(m.core?.content ?? [])].map((c) => ({ ...c, bucket: 'profile' }));
  const rules = (m.group?.rules ?? []).map((r) => ({ ...r, bucket: 'group' }));
  const own = m.habits?.own ?? [];
  const inh = m.habits?.inherited ?? [];
  const probes = m.habits?.probes ?? [];
  if (!core.length && !rules.length && !own.length && !inh.length && !probes.length && !m.paused) return '';
  const cat = state.wf?.category ?? '';
  // 別條流程的名字：options[].probes 已帶 from（M3b），同一張卡照抄；對不到就查側欄清單
  const fromOf = (c) => Object.values(m.options ?? {}).flatMap((o) => o.probes ?? []).find((p) => p.id === c.id)?.from
    ?? (c.scope?.workflow ? wfNameOf(c.scope.category, c.scope.workflow) : '');
  const box1 = `<ul>${core.map((c) => memCardLi(c, c.layer === 'content' ? '按場合帶' : '每步帶')).join('')}${rules.map((r) => memCardLi(r, `${cat}的規矩`, cat)).join('')}</ul>`;
  const box2 = `<ul>${own.map((c) => memCardLi(c, '生在這條')).join('')}${inh.map((c) => memCardLi(c, `繼承自${memScopeText(c.scope)}`)).join('')}${probes.map((c) => memCardLi(c, `來自「${fromOf(c)}」，點了才擴`)).join('')}</ul>`;
  const none = '<span class="none">還沒有</span>';
  return `<div class="flowmem" data-flowmem>
    <div class="box"><h6><i class="ph ph-identification-card"></i>每步都帶<span class="chip" data-count="core">關於你 ${core.length} 條・分類守則 ${rules.length} 條</span></h6>
      ${m.paused ? '<div class="note" style="margin:0 0 4px">整層暫停中：關於你不帶，分類的規矩照帶</div>' : ''}${core.length + rules.length ? box1 : none}</div>
    <div class="box"><h6><i class="ph ph-cards"></i>開跑選項（習慣卡）<span class="chip" data-count="habits">自己 ${own.length}・繼承 ${inh.length}・別條的 ${probes.length}</span></h6>${own.length + inh.length + probes.length ? box2 : none}</div>
  </div>`;
}

// 停點卡／查核卡「這步用了 N 條記憶 ▸」：讀 run.steps[node].memory（runner 送工作單前寫好的快照，不另算）；
// 沒有 memory（人做、分岔、舊 run）＝整段不顯示。蓋掉行不用展開就看得到（同心圓：跨圈矛盾外圈贏，在停點標示）
const MEM_OVER_BY = { group: '分類的規矩', workflow: '這條流程', run: '這一次的設定' };
function memoryUsedHtml(node, step) {
  const mem = step?.memory;
  if (!mem) return '';
  const cards = mem.cards ?? [];
  const open = !!state.memOpen[node.id];
  const cat = state.run?.workflow?.category ?? '';
  // U6b：沒記憶卡但這步帶了規範／共用檔（U1b 覆核 ⑩：沒接記憶門面時 cards 是空殼）——別說「沒帶任何記憶」，指去右欄
  const sh = mem.shared;
  const hasShared = !!sh && ['company', 'dept', 'refs'].some((k) => Array.isArray(sh[k]) && sh[k].length);
  const head = cards.length
    ? `<span class="pbtn" data-act="mem-toggle" data-node="${esc(node.id)}"><i class="ph ph-cards"></i>這步用了 ${cards.length} 條記憶 ${open ? '▾' : '▸'}</span>`
    : `<span class="none"><i class="ph ph-cards"></i>${mem.paused ? '整層暫停中，這步沒帶關於你' : hasShared ? '這步沒帶記憶卡；帶了的規範與共用檔在右欄' : '這步沒帶任何記憶'}</span>`;
  const pausedNote = mem.paused && cards.length ? '<span class="none">整層暫停中，這步沒帶關於你</span>' : '';
  const over = (mem.overridden ?? []).map((o) => `<div class="over"><i class="ph ph-arrow-bend-down-right"></i><span>這步蓋掉了${String(o.id).startsWith('g-') ? '分類規矩' : '核心'}的「${esc(o.text)}」——${MEM_OVER_BY[o.by] ?? esc(o.by)}定了「${esc(o.by_text)}」</span></div>`).join('');
  const list = open ? `<ul>${cards.map((c) => `<li>${memTagHtml(c)}<span class="t">${esc(c.text)}</span><span class="lnk" data-act="mem-card" data-id="${esc(c.id)}" data-bucket="${esc(c.bucket)}" data-text="${esc(c.text)}" data-cat="${esc(cat)}">出處</span></li>`).join('')}</ul>` : '';
  return `<div class="used" data-used="${esc(node.id)}"><div class="usedhead">${head}${pausedNote}</div>${over}${list}</div>`;
}

// 抽屜「輸入來源」下一列「這一步會帶：」：只給 AI 步驟；讀 state.wfMemory（不進 preflight 快取，卡改了立刻對）。
// 關於你＝表達層全部＋內容層場合對上的（後端 selectCore 已挑好）；分類守則＝群組條；這一步引用到的欄位有幾張習慣卡可選
const MEM_REF_FIELDS = ['instruction', 'role_context', 'background', 'constraints', 'examples', 'review_focus', 'output_type', 'output_structure', 'output_length', 'output_tone', 'output_format']; // 與 runner 的 INJECTED_FIELDS 同一份
const MEM_PARAM_REF = /\{\{\s*([\w-]+)\s*\}\}/g;
function drawerMemoryHtml(n) {
  const m = state.wfMemory;
  // 移植合併輪 U4c：公司／部門規範每步自動帶（讀 state.shared 的 rules 數）；記憶讀不到但有規範仍印規範那兩段
  const cRules = state.shared?.company?.rules?.length ?? 0;
  const dRules = state.shared?.dept?.rules?.length ?? 0;
  if ((!m && !cRules && !dRules) || subjectIsDraft() || kindOf(n) !== 'task' || n.executor !== 'ai') return '';
  const core = (m?.core?.expression?.length ?? 0) + (m?.core?.content?.length ?? 0);
  const rules = m?.group?.rules?.length ?? 0;
  const keys = new Set([...MEM_REF_FIELDS.map((f) => String(n[f] ?? '')).join('\n').matchAll(MEM_PARAM_REF)].map((x) => x[1]));
  const opts = [...keys].reduce((a, k) => a + (m?.options?.[k]?.covers?.length ?? 0), 0);
  // 移植第一批 T11（契約 E-2）：一行分開數，不加「條」；U4c（契約 F-2）：四段 關於你・分類守則・公司規範・部門規範，0 的段省略、全 0 印「沒有記憶與規範」
  const parts = [m?.paused ? '關於你 暫停中' : `關於你 ${core}`, `分類守則 ${rules}`, `公司規範 ${cRules}`, `部門規範 ${dRules}`, ...(opts ? [`習慣選項 ${opts}`] : [])].filter((p) => !/ 0$/.test(p));
  return `<div class="dmem" data-dmem><i class="ph ph-cards"></i><span class="lb">這一步會帶：</span><span>${parts.join('・') || '沒有記憶與規範'}</span></div>`;
}

// 卡片浮窗：正面五行＋出處原話＋背面計數＋「退休」「刪掉」（呼叫既有卡 API；成功後重抓 for-workflow，流程頁數字立刻變）
async function openMemCard(el, { replacing = false } = {}) {
  const { id, bucket, text, cat } = el.dataset;
  if (bucket === 'group') {
    // 群組條的規矩來源：流程頁用 state.wfMemory；設定頁地圖用設定頁讀回的 groups
    const rules = [...(state.wfMemory?.group?.rules ?? []), ...(state.settings?.data?.groups ?? []).flatMap((g) => g.rules ?? [])];
    const rule = rules.find((r) => r.id === id);
    state.memModal = { id, bucket, card: { id, text: rule?.text ?? text ?? '', field: rule?.field ?? null, value: rule?.value ?? null, category: cat || state.wf?.category || '' }, err: null, busy: false };
    render();
    return;
  }
  const mm = { id, bucket, card: null, err: null, busy: false, replacing };
  state.memModal = mm;
  render();
  try { mm.card = await api('GET', `/api/memory/cards/${encodeURIComponent(id)}`); }
  catch (e) { mm.err = e.message; }
  if (state.memModal === mm) render();
}
// 卡改了之後把看得到它的地方都重抓：流程頁兩格、抽屜一列、開跑選項（不靠 preflight 快取）；設定頁開著就連設定頁的資料一起
async function afterMemChange() {
  await refreshWfMemory();
  if (state.settings) await loadSettings();
}
// 浮窗裡的動作：退休／刪掉／取代（「改」＝開一張新卡取代，鐵則：卡的內容不改寫）。失敗停在原卡上、一句原因在按鈕旁
async function memCardAction(act) {
  const mm = state.memModal;
  if (!mm || mm.busy) return;
  if (act === 'del' && !window.confirm('把這張卡移到記憶垃圾桶？30 天內都能復原。')) return;
  const text = act === 'replace' ? (document.getElementById('mem-replace-text')?.value ?? '').trim() : '';
  if (act === 'replace' && !text) { mm.err = '要先寫新的內容'; render(); return; }
  mm.busy = true;
  mm.err = null;
  render();
  try {
    if (act === 'retire') await api('POST', `/api/memory/cards/${encodeURIComponent(mm.id)}/retire`, {});
    else if (act === 'replace') await api('POST', `/api/memory/cards/${encodeURIComponent(mm.id)}/replace`, { text });
    else await api('DELETE', `/api/memory/cards/${encodeURIComponent(mm.id)}`, undefined);
    state.memModal = null;
    delete state.keep[keepKey('mem-replace-text')];
    await afterMemChange();
  } catch (e) {
    mm.busy = false;
    mm.err = e.message;
  }
  render();
}
function memCardModalHtml() {
  const mm = state.memModal;
  if (!mm) return '';
  const c = mm.card;
  let title = '記憶卡';
  let body;
  const errLine = mm.err ? `<div class="pverr"><i class="ph-fill ph-warning"></i><span>${esc(mm.err)}</span></div>` : '';
  if (mm.err && !c) body = errLine; // 卡本身讀不到才整窗換成錯誤；動作失敗停在原卡上（M4 觀察修正）
  else if (!c) body = '<div class="note" style="margin:0">讀取中⋯</div>';
  else if (mm.bucket === 'group') {
    title = '分類守則';
    body = `<h3>${esc(c.text)}</h3><div class="sub" style="margin:0">分類「${esc(c.category)}」的規矩・每一步都帶，交貨查核也會對</div>
      <div class="face">
        <div class="k">來自</div><div class="v">分類・${esc(c.category)}</div>
        <div class="k">用法</div><div class="v">${c.field ? `有名字的欄位「${esc(c.field)}」＝「${esc(c.value ?? '')}」：這條流程或這一次另有值時，以外圈為準` : '自由規矩：不管外圈怎麼寫都疊加'}</div>
        <div class="k">範圍</div><div class="v">${esc(c.category)}這個分類的每一條流程</div>
        <div class="k">來源</div><div class="v">你在分類頁「分類守則」文字框打的</div>
      </div>
      <p class="note" style="margin:0">要改或刪，去側欄點分類名，改那段文字就好。</p>`;
  } else {
    const isP = c.bucket === 'profile';
    title = isP ? '認識卡' : '習慣卡';
    const how = isP ? `${c.layer === 'content' ? '按場合帶：這條流程的場合對上才附在每步指示裡' : '每步帶：每一步的指示都附上'}${c.field ? `　欄位：${esc(c.field)}` : ''}`
      : `開跑選項：欄位「${esc(c.field ?? '')}」旁的選項，點了才套用`;
    const widened = (c.scope_log ?? []).length ? `　<span class="sub" style="margin:0">範圍改過 ${c.scope_log.length} 次</span>` : '';
    const back = isP
      ? `<span>建立 <b>${esc(memAt(c.created_at))}</b></span><span>上次帶 <b>${esc(memAt(c.last_used_at))}</b></span>`
      : `<span>建立 <b>${esc(memAt(c.created_at))}</b></span><span>上次被選 <b>${esc(memAt(c.last_used_at))}</b></span><span>被拿出來 <b>${c.shown_count ?? 0}</b> 次</span><span>被選 <b>${c.picked_count ?? 0}</b> 次</span><span>選了又改掉 <b>${c.changed_count ?? 0}</b> 次</span>`;
    const canRetire = c.status === 'active';
    body = `<h3>${esc(c.text)}</h3><div class="sub" style="margin:0">${title}・${esc(MEM_STATUS_TXT[c.status] ?? c.status)}${c.status === 'replaced' && c.replaced_by ? `（被 ${esc(c.replaced_by)} 取代）` : ''}</div>
      <div class="face">
        <div class="k">來自</div><div class="v">${c.who === 'ai' ? 'AI 觀察，還沒經你確認' : '你說的'}</div>
        <div class="k">用法</div><div class="v">${how}</div>
        <div class="k">範圍</div><div class="v">${esc(memScopeText(c.scope))}${widened}</div>
        <div class="k">來源</div><div class="v">${esc(MEM_SOURCE_TXT[c.source?.kind] ?? c.source?.kind ?? '—')}${c.source?.at ? `・${esc(memAt(c.source.at))}` : ''}</div>
        <div class="k">有效期</div><div class="v">${c.expires ? esc(c.expires) : '永久'}</div>
        ${c.route_reason ? `<div class="k">對人對事</div><div class="v">${esc(c.route_reason)}</div>` : ''}
      </div>
      <div class="overline">當時的原話</div><div class="quote">${esc(c.source?.quote ?? '')}</div>
      <div class="back">${back}</div>
      ${mm.replacing ? `<div class="flabel" style="margin-top:0">新的內容（存成新卡取代這張；這張留著當紀錄）</div>
        <textarea id="mem-replace-text" class="feedbackin autogrow" data-keep placeholder="一句可以直接照做的話">${esc(kept('mem-replace-text') ?? c.text)}</textarea>`
    : '<p class="note" style="margin:0 0 4px">卡的內容不會被改寫。要改，按「改」開一張新的取代它，這張留著當紀錄。</p>'}
      ${errLine}
      <div class="btns">${mm.replacing
    ? `<button class="btn btn-primary" data-act="mem-replace-save" ${mm.busy ? 'disabled' : ''}><i class="ph ph-check"></i>存成新卡</button><button class="btn btn-ghost" data-act="mem-replace-cancel" ${mm.busy ? 'disabled' : ''}>取消</button>`
    : `${canRetire ? `<button class="btn" data-act="mem-replace-open" ${mm.busy ? 'disabled' : ''}><i class="ph ph-pencil-simple-line"></i>改</button><button class="btn" data-act="mem-retire" ${mm.busy ? 'disabled' : ''}><i class="ph ph-moon"></i>退休</button>` : ''}
        <button class="btn btn-ghost btn-danger" data-act="mem-del" ${mm.busy ? 'disabled' : ''}><i class="ph ph-trash"></i>刪掉</button>`}</div>`;
  }
  return `<div class="pvback memmodal" data-act="mem-modal-back"><div class="modal" role="dialog" aria-label="${esc(title)}">
    <div class="cvdhead" style="margin-bottom:var(--s2)"><span class="overline">${esc(title)}</span>
      <button class="btn btn-ghost iconb" data-act="mem-modal-close" style="margin-left:auto" title="關閉（Esc）"><i class="ph ph-x"></i></button></div>
    ${body}
  </div></div>`;
}
// 儀表板「要你處理」第一列：到期＋休眠＋被取代（GET /api/dashboard 的 memory.exceptions）；0 條不顯示。「去看」＝設定→記憶→記憶總覽（M5a）
function memExceptionRowHtml() {
  const ex = state.dash?.data?.memory?.exceptions;
  if (!ex?.total) return '';
  return `<div class="item prop" data-memex><div class="ti">記憶待整理 ${ex.total} 條</div><div class="de">到期 ${ex.expired}・休眠 ${ex.dormant}・被取代 ${ex.replaced}</div>
    <div class="acts"><button class="btn sm2 btn-primary" data-act="open-settings-memory" title="設定→記憶→記憶總覽">去看</button></div></div>`;
}
// 「開始」送出的三個記憶欄位：點了的卡（只送值還跟卡一樣的）、點了又改掉的、身分
function memStartFields(overrides) {
  const picks = {};
  for (const [key, id] of Object.entries(state.memPicks)) {
    const card = memOptionCard(key, id);
    if (card && overrides[key] === card.text) picks[key] = id;
  }
  return { memory_picks: picks, memory_changed: [...state.memChanged], memory_identity: state.memIdentity || null };
}

// ---------- 宿主狀態 ----------
async function refreshHealth() {
  try {
    state.claude = (await api('GET', '/api/health')).claude;
  } catch {
    state.claude = false;
  }
  hostdot.hidden = false;
  hostdot.className = `chip ${state.claude ? '' : 'red'}`;
  hostdot.innerHTML = state.claude
    ? '<i class="ph-fill ph-plugs-connected"></i>Claude 已連上'
    : '<i class="ph ph-plugs"></i>Claude 連不上';
}

// 移植合併輪 U2a：公司名稱——側欄根節點、麵包屑、公司頁標題共用；空白退回「公司」（契約 C-8）
const companyName = () => (state.companyName ?? '').trim() || '公司';
async function refreshCompanyName() {
  try {
    state.companyName = (await api('GET', '/api/settings')).company_name ?? '';
  } catch {
    state.companyName = ''; // 讀不到＝未設
  }
}

function hostAlert() {
  if (state.claude !== false) return '';
  return `<div class="card err" style="margin-bottom:16px">
    <h3><i class="ph ph-plugs"></i> 連不上 Claude</h3>
    <p class="sub" style="margin:8px 0">剝繭是掛在 Claude 上跑的。看起來 Claude 目前沒有開著、沒登入，或外掛沒接上。你的流程庫都在，不會不見。</p>
    <div class="btns"><button class="btn btn-primary" data-act="reconnect"><i class="ph ph-arrows-clockwise"></i>重新連線</button></div>
  </div>`;
}

// ---------- 流程庫邊欄 ----------
// 移植合併輪 U2a：三層樹的根節點（公司）——不是第五個全域項（不用 .calentry，T9① 只認四個）；點了開公司頁（分類頁特例 _company）
function companyNodeHtml() {
  const now = state.categoryPage?.category === '_company';
  return `<div class="wf companynode${now ? ' now' : ''}"${now ? ' aria-current="page"' : ''} data-act="open-company" title="公司層共用檔"><i class="ph ph-buildings"></i><span class="wfname">${esc(companyName())}</span></div>`;
}
function sideHtml() {
  const byCat = {};
  for (const c of state.categories) byCat[c] = [];
  for (const w of state.workflows) (byCat[w.category] ??= []).push(w);
  // 移植第一批 T9：分類樹＝<details>；點文字開分類頁（click 處理器 preventDefault 不讓 summary 原生切換）、點箭頭收合；
  // 收合狀態在 state.catClosed（重繪照它還原）；正在看的分類強制展開
  const catHtml = Object.entries(byCat).map(([cat, wfs]) => {
    const now = state.categoryPage?.category === cat;
    const open = now || !state.catClosed.has(cat);
    return `
    <details class="cat" data-cat="${esc(cat)}" ${open ? 'open' : ''}><summary class="nm ${now ? 'now' : ''}" ${now ? 'aria-current="page"' : ''} data-act="open-category" data-cat="${esc(cat)}" title="分類守則"><span>${esc(cat)}</span><i class="ph ph-sliders-horizontal catset"></i><i class="ph ph-caret-down catcaret" data-act="cat-toggle" data-cat="${esc(cat)}" title="${open ? '收起' : '展開'}"></i></summary>
      ${wfs.map((w) => `<div class="wf ${state.wf && !state.calendar && !state.categoryPage && !state.settings && !state.library && !subjectIsDraft() && w.id === state.wf.id && w.category === state.wf.category ? 'now' : ''}"
        data-act="open" data-cat="${esc(w.category)}" data-id="${esc(w.id)}">
        <i class="${state.wf && w.id === state.wf.id && w.category === state.wf.category ? 'ph-fill' : 'ph'} ph-flow-arrow"></i><span class="wfname">${esc(w.name)}</span>
        <i class="ph ph-trash wfdel" data-act="del-wf-row" data-cat="${esc(w.category)}" data-id="${esc(w.id)}" data-name="${esc(w.name)}" title="移到垃圾桶"></i></div>`).join('')}
    </details>`;
  }).join('');
  const adder = state.addingCategory
    ? `<div style="display:flex;gap:4px;margin-top:4px"><input id="new-category" class="notein" style="margin:0" placeholder="分類名稱">
       <button class="btn btn-primary" style="padding:6px 10px" data-act="confirm-category">建立</button></div>`
    : `<div class="addcat" data-act="add-category"><i class="ph ph-plus"></i>新增分類</div>`;
  return `<aside class="side">
    <div class="wf calentry ${state.dash ? 'now' : ''}" data-act="open-dash">
      <i class="${state.dash ? 'ph-fill' : 'ph'} ph-gauge"></i><span class="wfname">儀表板</span>
      ${state.notices.unread.length ? '<span class="reddot" title="有新通知"></span>' : ''}</div>
    <div class="wf calentry ${state.library ? 'now' : ''}" data-act="open-library" title="全部流程的卡片格，可搜尋、按分類看">
      <i class="${state.library ? 'ph-fill' : 'ph'} ph-books"></i><span class="wfname">流程庫</span></div>
    <div class="wf calentry ${state.calendar ? 'now' : ''}" data-act="open-calendar">
      <i class="${state.calendar ? 'ph-fill' : 'ph'} ph-calendar-blank"></i><span class="wfname">行事曆</span></div>
    <div class="wf calentry ${state.settings ? 'now' : ''}" data-act="open-settings" title="預設值、記憶、素材庫都在這">
      <i class="${state.settings ? 'ph-fill' : 'ph'} ph-gear"></i><span class="wfname">設定</span></div>
    <div class="newflow" data-act="new-flow"><i class="ph ph-plus-circle"></i>建立新流程</div>
    ${companyNodeHtml()}<div class="tree">${catHtml}</div>${adder}
    <div class="addcat" data-act="pick-import"><i class="ph ph-upload-simple"></i>匯入別人的流程檔</div>
    <div class="wf" style="margin-top:var(--s3);color:var(--ink-400)" data-act="view-trash"><i class="ph ph-trash"></i>垃圾桶（${state.trash.length}）</div>
  </aside>`;
}

// ---------- 移植第一批 T9：流程庫頁（側欄第二個全域項）——全部流程的卡片格＋搜尋＋分類過濾；只讀 state.workflows，不叫 API ----------
function closeLibrary() {
  if (!state.library) return;
  state.library = null;
}
function openLibrary() {
  if (canvasLeaveBlocked()) return;
  clearTimeout(state.pollTimer);
  closeCalendar();
  closeDash();
  closeCategory();
  closeSettings();
  state.run = null;
  state.showTrash = false;
  state.corrupt = null;
  state.importPreview = null;
  state.library = { q: '', cat: '' };
  render();
}
// 卡片格單獨切出來：搜尋框 input 事件只換這一格，不整頁 render（打字不被洗掉）
function libraryCardsHtml() {
  const l = state.library;
  const q = (l.q ?? '').trim().toLowerCase();
  const list = state.workflows.filter((w) => (!l.cat || w.category === l.cat) && (!q || `${w.name} ${w.category}`.toLowerCase().includes(q)));
  if (!list.length) return `<div class="none" data-lib-empty>${q || l.cat ? '沒有符合的流程' : '還沒有流程：側欄「建立新流程」或「匯入別人的流程檔」'}</div>`;
  return flowCardsHtml(list);
}
// 流程卡（移植合併輪 U2b 抽出）：流程庫頁與部門頁「流程 N」共用同一張卡，「打開」走既有 open
function flowCardsHtml(list) {
  return list.map((w) => `<div class="libcard" data-lib-card="${esc(w.id)}"><div class="libcat">${esc(w.category)}</div><b>${esc(w.name)}</b>
      <div class="btns"><button class="btn sm2" data-act="open" data-cat="${esc(w.category)}" data-id="${esc(w.id)}"><i class="ph ph-arrow-up-right"></i>打開</button></div></div>`).join('');
}
function libraryHtml() {
  const l = state.library;
  return `<div class="libpage" data-library><h4>流程庫</h4><div class="lead">全部流程都在這，搜尋或按分類找；建立與匯入在側欄。</div>
    <div class="libbar"><input id="lib-search" class="notein" placeholder="搜尋流程名稱" value="${esc(l.q ?? '')}"><div class="seg sm" data-lib-cats><span class="${!l.cat ? 'on' : ''}" data-act="lib-cat" data-cat="">全部</span>${state.categories.map((c) => `<span class="${l.cat === c ? 'on' : ''}" data-act="lib-cat" data-cat="${esc(c)}">${esc(c)}</span>`).join('')}</div></div>
    <div class="libgrid" id="lib-grid">${libraryCardsHtml()}</div></div>`;
}

// ---------- 移植合併輪 U2a：麵包屑（公司 › 分類 › 流程名［› extra］）——流程頁與執行頁標題上方；頂欄品牌塊不動（契約 §三） ----------
// 草稿（含還沒拆出草稿的「開始一件事」）只印「公司 › 草稿」。末節 aria-current 不可點，前面每節都是 data-act 可點
function crumbsHtml(extra) {
  const items = [{ label: companyName(), act: 'open-company' }];
  const wf = state.wf ?? (state.run?.workflow ? { ...state.run.workflow, def: state.run.def } : null);
  if (state.chat?.draft || !wf) items.push({ label: '草稿' });
  else items.push({ label: wf.category, act: 'open-category', cat: wf.category }, { label: wf.def?.name ?? '' });
  if (extra) items.push({ label: extra });
  const last = items.length - 1;
  return `<nav class="crumbs" aria-label="資料夾路徑">${items.map((x, i) => `${i ? '<i class="ph ph-caret-right"></i>' : ''}${i === last
    ? `<span aria-current="page">${esc(x.label)}</span>`
    : `<span data-act="${x.act}"${x.cat ? ` data-cat="${esc(x.cat)}"` : ''}>${esc(x.label)}</span>`}`).join('')}</nav>`;
}

// ---------- 工作區標題列（兩行） ----------
function modeSeg() {
  const m = state.mode;
  return `<div class="seg">
    <span class="${m === 'chat' ? 'on' : ''}" data-act="mode-chat"><i class="ph ph-chat-circle-dots"></i>聊天</span>
    <span class="${m === 'list' ? 'on' : ''}" data-act="mode-list"><i class="ph ph-list-checks"></i>清單</span>
    <span class="${m === 'canvas' ? 'on' : ''}" data-act="mode-canvas"><i class="ph ph-tree-structure"></i>畫布</span>
    <span class="${m === 'history' ? 'on' : ''}" data-act="mode-history"><i class="ph ph-clock-counter-clockwise"></i>履歷</span>
  </div>`;
}

function workHeadHtml() {
  const def = subjectDef();
  const title = def ? def.name : '開始一件事';
  const draftChip = subjectIsDraft() ? '<span class="chip amber"><i class="ph ph-pencil-simple-line"></i>草稿 · 還沒存</span>' : '';
  const verChip = !subjectIsDraft() && state.wf && state.versions.length
    ? `<span class="chip"><i class="ph-fill ph-seal-check"></i>v${state.versions.at(-1).version} · 現行</span>` : '';
  const catOptions = state.categories.map((c) =>
    `<option value="${esc(c)}" ${state.wf && c === state.wf.category ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const wfCtrls = !subjectIsDraft() && state.wf ? `
      <select id="move-select" class="moveselect" title="搬到別的分類">${catOptions}</select>
      <span class="btn iconb" data-act="export-wf" title="匯出成單一檔案"><i class="ph ph-export"></i></span>
      <span class="btn iconb btn-danger" data-act="delete-wf" title="移到垃圾桶，30 天內可復原"><i class="ph ph-trash"></i></span>` : '';
  // 移植第一批 T10：三開關收進「流程設定」浮窗（右上鈕）；標題下「設計流程｜本次資料」兩分頁，草稿只有設計流程
  const saved = !subjectIsDraft() && !!state.wf;
  const settingsBtn = saved ? `<span class="btn iconb flowsetbtn" data-act="flow-settings" title="流程設定：產出檔案、交貨查核、監工"><i class="ph ph-sliders-horizontal"></i>流程設定</span>` : '';
  const onData = saved && state.flowTab === 'data';
  const flowTabs = saved ? `<div class="seg flowtabs" data-flowtabs><span class="${onData ? '' : 'on'}" data-act="flow-tab" data-tab="design"><i class="ph ph-pencil-simple"></i>設計流程</span><span class="${onData ? 'on' : ''}" data-act="flow-tab" data-tab="data"><i class="ph ph-play"></i>本次資料</span></div>` : '';
  return `${crumbsHtml()}<div class="tophead"><h3>${esc(title)}</h3>${draftChip}${verChip}</div>
    ${flowTabs}<div class="headrow">${onData ? '' : modeSeg()}<span class="right">${settingsBtn}${wfCtrls}</span></div>`;
}

// 產檔權限列（產檔輪）：已存流程才有，草稿不顯示；開關即 PUT 定義（permissions.files）。健檢「修這裡」會捲到這列並亮 1.5 秒
function permRowHtml() {
  if (subjectIsDraft() || !state.wf) return '';
  const on = state.wf.def.permissions?.files === true;
  const flash = state.permFlashUntil > Date.now();
  return `<div class="permrow ${on ? 'on' : ''} ${flash ? 'flash' : ''}" id="perm-files">
    <label class="switch" title="${on ? '點一下關掉' : '點一下打開'}"><input type="checkbox" data-act="perm-files-toggle" ${on ? 'checked' : ''} aria-label="允許這條流程產出檔案"><span class="knob"></span></label>
    <span class="permtxt"><b>允許這條流程產出檔案</b>
      <span class="permnote">開了會讓 AI 工人在這趟的產出資料夾裡寫檔與執行程式；匯入別人的流程預設關。</span>
      ${state.permErr ? `<span class="permerr"><i class="ph-fill ph-warning"></i>${esc(state.permErr)}</span>` : ''}</span>
  </div>`;
}

// 交貨查核開關（交貨查核輪）：已存流程才有，草稿不顯示；缺省＝開。切換即 PUT 定義（def.check.enabled）
// 監工輪加兩個：查核列右邊的子開關「數字對原始資料」（def.check.facts）、下一列的監工總開關（def.supervisor.enabled）
function checkRowHtml() {
  if (subjectIsDraft() || !state.wf) return '';
  const on = state.wf.def.check?.enabled !== false;
  const facts = state.wf.def.check?.facts !== false;
  const sup = state.wf.def.supervisor?.enabled !== false;
  const subSw = `<span style="display:flex;align-items:flex-start;gap:8px;margin-left:auto;flex:none;${on ? '' : 'opacity:.45'}">
      <label class="switch" title="${on ? (facts ? '點一下關掉' : '點一下打開') : '要先打開「每步交貨先查」'}"><input type="checkbox" data-act="facts-toggle" ${facts ? 'checked' : ''} ${on ? '' : 'disabled'} aria-label="數字對原始資料"><span class="knob"></span></label>
      <span class="permtxt"><b>數字對原始資料</b>
        ${on && !facts ? '<span class="permnote">只對必守與格式</span>' : ''}</span>
    </span>`;
  return `<div class="permrow checkrow ${on ? 'on' : ''}" id="check-delivery">
    <label class="switch" title="${on ? '點一下關掉' : '點一下打開'}"><input type="checkbox" data-act="check-toggle" ${on ? 'checked' : ''} aria-label="每步交貨先查"><span class="knob"></span></label>
    <span class="permtxt"><b>每步交貨先查</b>
      <span class="permnote">每個 AI 步驟做完先對照原始資料與你的要求；攔到會自動重做一次，還錯才停下問你。關掉就不查、也不多花 token。</span></span>
    ${subSw}
  </div>
  <div class="permrow checkrow ${sup ? 'on' : ''}" id="supervisor-row">
    <label class="switch" title="${sup ? '點一下關掉' : '點一下打開'}"><input type="checkbox" data-act="supervisor-toggle" ${sup ? 'checked' : ''} aria-label="監工：開場備註、每步交接、跑完紀錄"><span class="knob"></span></label>
    <span class="permtxt"><b>監工：開場備註、每步交接、跑完紀錄</b>
      <span class="permnote">開跑前先通盤看一次寫下開場備註，每一步之間補一句交接，跑完寫一份紀錄與「建議改哪裡」。關掉就都不做、也不多花 token；分岔還是照樣自動選路。</span></span>
  </div>`;
}

// ---------- 移植第一批 T10：流程設定浮窗（產出檔案／交貨查核／監工三開關；即點即存，開關本身沒動）----------
function flowSettingsModalHtml() {
  if (!state.flowSettingsOpen || !state.wf || subjectIsDraft()) return '';
  return `<div class="pvback memmodal flowsettings" data-act="flow-settings-close"><div class="modal" role="dialog" aria-label="流程設定">
    <div class="cvdhead" style="margin-bottom:var(--s2)"><span class="overline">流程設定・${esc(state.wf.def.name)}</span>
      <button class="btn btn-ghost iconb" data-act="flow-settings-close" style="margin-left:auto" title="關閉（Esc）"><i class="ph ph-x"></i></button></div>
    <p class="note" style="margin:0 0 var(--s3)">只管這條流程；點了就存。新流程的預設在「設定」。</p>
    ${permRowHtml()}${checkRowHtml()}
  </div></div>`;
}
// 「本次資料」分頁＝開跑表單（身分、欄位值＋習慣選項、健檢卡、開始）——從清單模式拆出來；欄位定義（必填、新增）留在設計流程
function dataTabHtml() {
  const def = subjectDef();
  if (!def || subjectIsDraft()) return '';
  const paramRows = paramRowsHtml(def);
  return `<div class="sub">填這一次要用的資料，按「開始」。欄位本身要改，回「設計流程」。</div>
    ${resumeHtml()}
    <div class="params"><h5>本次資料</h5>${identityRowHtml()}${paramRows || '<p class="note" style="margin:0">這份流程沒有可調欄位。</p>'}</div>
    ${habitsNoteHtml()}
    ${startCheckHtml()}
    <div class="runbtn"><span class="note">只用於本次</span><button class="btn btn-primary" style="padding:11px 44px" data-act="start" ${state.claude === false ? 'disabled title="先把 Claude 連上"' : ''}><i class="ph-fill ph-play"></i>開始</button></div>`;
}
// 記憶一行（09-10 定案「demo 一行」）：兩格收成一句數字＋「查看」；查看開浮窗，浮窗內容＝原兩格 flowMemHtml，內容不減
function flowMemLineHtml() {
  const m = state.wfMemory;
  if (!m || subjectIsDraft()) return '';
  const core = (m.core?.expression?.length ?? 0) + (m.core?.content?.length ?? 0);
  const rules = m.group?.rules?.length ?? 0;
  const k = (m.habits?.own?.length ?? 0) + (m.habits?.inherited?.length ?? 0) + (m.habits?.probes?.length ?? 0);
  if (!core && !rules && !k && !m.paused) return '';
  return `<div class="flowmemline" data-flowmemline><i class="ph ph-identification-card"></i><span>每步都帶 關於你 ${core}・分類守則 ${rules}　開跑選項 ${k} 張${m.paused ? '　<span class="chip wait">整層暫停中</span>' : ''}</span>
    <span class="btn sm2 btn-ghost" data-act="flowmem-open"><i class="ph ph-arrow-up-right"></i>查看</span></div>`;
}
function flowMemModalHtml() {
  if (!state.flowMemOpen || !state.wf || subjectIsDraft()) return '';
  return `<div class="pvback memmodal flowmemmodal" data-act="flowmem-close"><div class="modal" role="dialog" aria-label="這條流程會帶的記憶">
    <div class="cvdhead" style="margin-bottom:var(--s2)"><span class="overline">這條流程會帶的記憶・${esc(state.wf.def.name)}</span>
      <button class="btn btn-ghost iconb" data-act="flowmem-close" style="margin-left:auto" title="關閉（Esc）"><i class="ph ph-x"></i></button></div>
    ${flowMemHtml() || '<div class="none">還沒有</div>'}
  </div></div>`;
}

// ---------- 移植合併輪 U4b：流程頁右側「流程資料夾」（demo workflowFolderAside）——父層兩鈕→目前流程→流程參考檔→每次執行→上層共用檔一行 ----------
// 兩個 details 的開合在 state.folderOpen（輪詢重繪讀回，不靠 DOM）；「打開」走 todo-go 原鍵、成品檔走 fileChipHtml 既有預覽；草稿與執行頁不印
const FOLDER_MAX = 3;
async function refreshFolder() {
  const wf = state.wf;
  if (!wf || subjectIsDraft()) return;
  const settle = (p) => p.then((value) => ({ value }), (err) => ({ err }));
  const [runs, company, dept] = await Promise.all([
    settle(api('GET', `${wfPath(wf)}/runs?detail=1`)),
    settle(api('GET', sharedPath('_company'))),
    settle(api('GET', sharedPath(wf.category))),
  ]);
  if (state.wf?.category !== wf.category || state.wf?.id !== wf.id) return; // 讀到一半已換流程
  state.wfRuns = runs.err ? null : runs.value;
  state.shared = { company: company.err ? null : company.value, dept: dept.err ? null : dept.value, err: (company.err ?? dept.err)?.message ?? null };
}
// 參考檔上傳／刪除後只換側欄這一塊（抽屜開著時整頁 render 會洗掉打到一半的字）
function repaintAside() {
  const aside = app.querySelector('.flowaside');
  if (aside) aside.outerHTML = flowAsideHtml();
}
// 歷次執行的狀態膠囊（儀表板最近完成卡同一張表：done／running 灰、有步驟失敗紅、其餘琥珀等你；U4a 讀不到那筆紅）
function runStatusChip(r) {
  return r.status === 'done' ? '<span class="chip quiet"><i class="ph-fill ph-check-circle"></i>完成</span>'
    : r.status === 'running' ? '<span class="chip quiet"><i class="ph ph-circle-notch"></i>進行中</span>'
      : r.status === 'unreadable' ? '<span class="chip bad"><i class="ph ph-warning-circle"></i>讀不到</span>'
        : r.steps.failed > 0 ? '<span class="chip bad"><i class="ph ph-warning-circle"></i>有步驟失敗</span>'
          : '<span class="chip wait"><i class="ph ph-hand-palm"></i>等你</span>';
}
function flowAsideHtml() {
  if (!state.wf || subjectIsDraft() || state.run) return '';
  const wf = state.wf;
  const fo = state.folderOpen ?? {};
  const fold = (k, title, icon, count, body) => `<details data-folder="${k}"${fo[k] ? ' open' : ''}><summary data-act="folder-toggle" data-k="${k}"><i class="ph ph-caret-down"></i><i class="ph ${icon}"></i>${title}<span class="meta">${count}</span></summary>${body}</details>`;
  // 流程參考檔（這條流程自己的；勾選在步驟抽屜）
  const files = state.wfFiles ?? [];
  const fileRows = (fo.refsAll ? files : files.slice(0, FOLDER_MAX)).map((f) => `<div class="folderfile"><i class="ph ph-file-text"></i><span class="wfname" title="${esc(f)}">${esc(f)}</span></div>`).join('');
  const refsBody = `${fileRows || '<p class="note">還沒有參考檔。</p>'}
      ${files.length > FOLDER_MAX && !fo.refsAll ? `<span class="pbtn" data-act="refs-all"><i class="ph ph-caret-down"></i>查看全部 ${files.length} 份</span>` : ''}
      <span class="pbtn" data-act="ref-upload"><i class="ph ph-upload-simple"></i>上傳參考檔</span>`;
  // 每次執行（U4a runs?detail=1）：時間・膠囊・成品檔 chip・打開；讀不到的那趟印原因、沒有「打開」
  const runs = state.wfRuns;
  const runRow = (r) => {
    const finalFiles = [...new Set(r.finals.map((f) => f.file).filter(Boolean))];
    const others = r.files.filter((n) => !finalFiles.includes(n)).length;
    const bad = r.status === 'unreadable';
    return `<div class="folderrun" data-run="${esc(r.run_id)}"><div class="frhead"><span class="rtime">${esc(bad ? r.run_id : fmtWhen(r.started_at))}</span>${runStatusChip(r)}
        ${bad ? '' : `<button class="btn sm2" data-act="todo-go" data-cat="${esc(wf.category)}" data-id="${esc(wf.id)}" data-rid="${esc(r.run_id)}">打開</button>`}</div>
      ${bad ? `<p class="note">${esc(r.error ?? '')}</p>` : ''}
      ${finalFiles.length || others ? `<div class="frfiles">${finalFiles.map((n) => fileChipHtml(wf.category, wf.id, r.run_id, n)).join('')}${others ? `<span class="meta">其他產出 ${others} 份</span>` : ''}</div>` : ''}
    </div>`;
  };
  const runsBody = runs === null ? '<p class="note">讀不到歷次執行。</p>'
    : !runs.length ? '<p class="note">還沒開跑過。</p>'
      : `${(fo.runsAll ? runs : runs.slice(0, FOLDER_MAX)).map(runRow).join('')}
      ${runs.length > FOLDER_MAX && !fo.runsAll ? `<span class="pbtn" data-act="runs-all"><i class="ph ph-caret-down"></i>查看全部 ${runs.length} 趟</span>` : ''}`;
  // 上層共用檔一行：兩層都讀到才算數；任一讀不到印「讀不到」
  const sh = state.shared ?? {};
  const cn = sh.company ? (sh.company.rules?.length ?? 0) + (sh.company.refs?.length ?? 0) : null;
  const dn = sh.dept ? (sh.dept.rules?.length ?? 0) + (sh.dept.refs?.length ?? 0) : null;
  const sharedLine = cn === null || dn === null ? (sh.err ? '共用檔讀不到。' : '讀取中⋯')
    : cn + dn === 0 ? '上層還沒有共用檔'
      : `公司 ${cn} 份・部門 ${dn} 份共用檔 <span data-act="shared-open"><i class="ph ph-arrow-up-right"></i>查看</span>`;
  return `<aside class="flowaside" aria-label="流程資料夾"><h5>流程資料夾</h5>
    <div class="folderparents"><span class="btn sm2 btn-ghost" data-act="open-company" title="公司頁：全公司共用的規範與參考"><i class="ph ph-buildings"></i>${esc(companyName())}</span><i class="ph ph-caret-right"></i><span class="btn sm2 btn-ghost" data-act="open-category" data-cat="${esc(wf.category)}" title="部門頁：這個分類共用的守則、規範與參考"><i class="ph ph-folder"></i>${esc(wf.category)}</span></div>
    <div class="foldernow" data-folder-now><i class="ph ph-folder-open"></i><span class="wfname" title="${esc(wf.def.name)}">${esc(wf.def.name)}</span></div>
    ${fold('refs', '流程參考檔', 'ph-files', files.length, refsBody)}
    ${fold('runs', '每次執行', 'ph-clock-counter-clockwise', runs ? runs.length : '', runsBody)}
    <p class="sharedline">${sharedLine}</p>
  </aside>`;
}
// 共用檔浮窗（demo showParentResources）：兩層各列 檔名・規範／參考 chip・字數，唯讀；上傳與刪除去公司頁／部門頁。掛 .layout 外（地雷 5）
function sharedModalHtml() {
  if (!state.sharedOpen || !state.wf || subjectIsDraft() || state.run) return '';
  const wf = state.wf;
  const sh = state.shared ?? {};
  const layer = (key, label, d, manage) => {
    const rows = d ? [...(d.rules ?? []).map((f) => ({ ...f, rule: true })), ...(d.refs ?? [])] : null;
    const body = !rows ? `<p class="note">${sh.err ? `讀不到：${esc(sh.err)}` : '讀取中⋯'}</p>`
      : rows.map((f) => `<div class="sharedrow"><i class="ph ${f.rule ? 'ph-file-text' : 'ph-file'}"></i><span class="wfname" title="${esc(f.name)}">${esc(f.name)}</span><span class="chip ${f.rule ? '' : 'quiet'}">${f.rule ? '規範' : '參考'}</span><span class="meta">${sharedSizeText(f)}</span></div>`).join('') || '<p class="note">尚無共用檔</p>';
    return `<section class="sharedlayer" data-shared-layer="${key}"><h4><span>${esc(label)}</span>${manage}</h4>${body}</section>`;
  };
  return `<div class="pvback memmodal sharedmodal" data-act="shared-close"><div class="modal" role="dialog" aria-label="上層共用檔">
    <div class="cvdhead" style="margin-bottom:var(--s2)"><span class="overline">上層共用檔・${esc(wf.def.name)}</span>
      <button class="btn btn-ghost iconb" data-act="shared-close" style="margin-left:auto" title="關閉（Esc）"><i class="ph ph-x"></i></button></div>
    <p class="note" style="margin:0 0 var(--s3)">規範每一步都帶；參考在步驟裡勾了才帶。要上傳或刪除，去公司頁／部門頁。</p>
    ${layer('company', companyName(), sh.company, `<span class="btn sm2 btn-ghost" data-act="open-company"><i class="ph ph-arrow-up-right"></i>去公司頁管理</span>`)}
    ${layer('dept', wf.category, sh.dept, `<span class="btn sm2 btn-ghost" data-act="open-category" data-cat="${esc(wf.category)}"><i class="ph ph-arrow-up-right"></i>去部門頁管理</span>`)}
  </div></div>`;
}

// ---------- 聊天模式 ----------
function chatModeHtml() {
  const bubbles = state.chat.messages.map((m, i) => {
    if (m.role === 'memnotice') return memNoticeLine(m.notice, { where: 'chat', idx: i }); // 記憶輪（M2）：氣泡下的一行「記下來了…不要記」
    const cls = m.role === 'user' ? 'me' : m.role === 'error' ? 'ai errbubble' : 'ai';
    return `<div class="bubble ${cls}">${esc(m.text)}</div>`;
  }).join('');
  const intro = state.chat.messages.length ? '' : subjectDef() && !subjectIsDraft()
    ? `<div class="bubble ai">這裡講的話會直接改「${esc(state.wf.def.name)}」——例如「第 2 步幫我加停點」「多加一步寄給主管」。改壞了到「履歷」退回就好。</div>`
    : `<div class="bubble ai">跟我講一件你常做的事（例如「我每週要整理競品動態寄給團隊」），我幫你拆成流程；或口述你平常怎麼做，我照建。\n\n想先看看它怎麼運作，也可以直接跑範例。</div>`;
  const busy = state.chat.busy ? '<div class="bubble ai"><span class="thinking">在想了，等我一下⋯</span></div>' : '';
  const quick = !subjectDef() && !state.chat.messages.length
    ? `<div style="display:flex;gap:6px;margin-bottom:var(--s3)"><span class="chip blue expander" data-act="open" data-cat="範例" data-id="quarterly-report"><i class="ph ph-play"></i>跑跑看範例：跟主管報告</span></div>` : '';
  const disabled = state.claude === false || state.chat.busy ? 'disabled' : '';
  const savedDraftRow = subjectIsDraft()
    ? `<div class="btns" style="justify-content:center;padding-top:var(--s2)">
        <button class="btn btn-primary" data-act="save-draft"><i class="ph ph-tray-arrow-down"></i>存進流程庫</button>
        <button class="btn btn-ghost" data-act="clear-draft">清空</button>
        <span class="chip expander" data-act="mode-list"><i class="ph ph-list-checks"></i>到清單看草稿</span></div>` : '';
  return `<div class="chatpane"><div class="chatlog" id="chatlog">${intro}${bubbles}${busy}${quick}</div>
    <div class="chatin"><input id="chat-input" placeholder="${subjectDef() && !subjectIsDraft() ? '跟它講怎麼改這個流程⋯' : '跟它用講的就好⋯'}" ${disabled}>
    <button class="btn btn-primary" data-act="send-chat" ${disabled}><i class="ph-fill ph-paper-plane-tilt"></i></button></div>
    ${savedDraftRow}</div>`;
}

// ---------- 清單模式 ----------
// 停點標示（定案方案一）：小圖標＋懸停說明；「直接往下」是預設、不標示
function stopMark(n) {
  if (n.executor === 'human') return '<span class="mkic you" title="這步你來做，完成後回報一句"><i class="ph-fill ph-user"></i></span>';
  return n.stop_point === 'always'
    ? '<span class="mkic stop" title="做完會停下來給你看"><i class="ph-fill ph-hand-palm"></i></span>'
    : '';
}

function stepListHtml(def) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  let seq = 0;
  return topoNodes(def).map((n) => {
    const kind = kindOf(n);
    if (kind === 'fork') return '<div class="sub" style="margin:2px 0 6px"><i class="ph ph-git-branch"></i> 以下幾步同時進行</div>';
    if (kind === 'join') return '<div class="sub" style="margin:2px 0 6px"><i class="ph ph-git-merge"></i> 會合——等上面全部完成</div>';
    seq++;
    if (kind === 'branch') {
      const arms = n.branches.map((b) => `<div class="sub" style="margin:0 0 3px 30px">↳ ${esc(b.label)} → 「${esc(byId.get(b.next)?.title ?? '')}」</div>`).join('');
      return `<div class="step stopmarked"><span class="n"><i class="ph ph-arrows-split"></i></span><b>${esc(n.title)}</b><span class="chip amber">分岔</span>
        <span class="pillslot"><span class="chip expander" data-act="edit-step" data-node="${esc(n.id)}"><i class="ph ph-pencil-simple"></i>編輯</span></span></div>${arms}`;
    }
    const open = state.expanded.has(n.id);
    const cls = n.executor === 'human' ? 'humanmarked' : n.stop_point === 'always' ? 'stopmarked' : '';
    return `<div class="step ${cls}"><span class="n">${seq}</span><b>${esc(n.title)}</b>
      <span class="chip">${n.executor === 'human' ? '<i class="ph ph-user"></i>你來' : 'AI'}</span>
      <span class="pillslot">${stopMark(n)}
        <span class="chip expander" data-act="edit-step" data-node="${esc(n.id)}"><i class="ph ph-pencil-simple"></i>編輯</span>
      </span></div>`;
  }).join('');
}

function resumeHtml() {
  const open = (state.wf?.runs ?? []).filter((r) => r.status === 'paused' || r.status === 'running');
  if (!open.length || subjectIsDraft()) return '';
  return open.map((r) => `<div class="card hold" style="margin-bottom:var(--s3)">
    <b><i class="ph-fill ph-hourglass-medium"></i> 有一趟跑到一半</b>
    <div class="sub" style="margin:6px 0">${esc(new Date(r.started_at).toLocaleString('zh-TW', { hour12: false }))} 開跑——進度都在，接回去就從停的地方繼續。</div>
    <div class="btns"><button class="btn btn-primary" data-act="resume" data-rid="${esc(r.run_id)}">接回去繼續</button>
      <button class="btn btn-ghost" data-act="del-run" data-rid="${esc(r.run_id)}" title="這一趟不用跑完了，整筆刪掉"><i class="ph ph-trash"></i>不用跑了，刪掉</button></div>
  </div>`).join('');
}

async function refreshProposals(w) {
  state.proposals = await api('GET', `${wfPath(w)}/proposals`);
}

function proposalText(p) {
  if (p.change?.summary) return p.change.summary;
  if (p.kind === 'param_default') return `以後「${p.change.param_label}」預設就用「${p.change.new_default}」？`;
  // 監工建議只指路不改法：卡上要講清楚按了會被帶去哪裡（它沒有 summary 也沒有 node_title）
  if (p.kind === 'supervisor_hint') {
    const t = state.wf?.def?.nodes.find((n) => n.id === p.change.node_id)?.title ?? p.change.node_id;
    return `去改「${t}」的${WHERE_LABELS[p.change.field] ?? p.change.field}？`;
  }
  return `更新「${p.change.node_title}」這步的做法？`;
}

function proposalsHtml() {
  const { pending, more } = state.proposals;
  if (!pending.length || subjectIsDraft()) return '';
  const cards = pending.map((p) => `<div class="card proposal" style="margin-bottom:var(--s3)">
    <div class="overline" style="margin-bottom:4px">它想學一招 · 依據：${esc(p.evidence)}</div>
    <b>${esc(proposalText(p))}</b>
    <div class="btns" style="margin-top:10px">
      <button class="btn btn-primary" data-act="accept-proposal" data-pid="${esc(p.id)}">${p.kind === 'supervisor_hint' ? '帶我去改' : '好，以後都這樣'}</button>
      <button class="btn btn-ghost" data-act="reject-proposal" data-pid="${esc(p.id)}">不用，我看情況</button>
    </div>
  </div>`).join('');
  const moreNote = more ? `<p class="note" style="margin:0 0 8px">還有 ${more} 條想法，處理完這些再給你看。</p>` : '';
  return cards + moreNote;
}

// 移植第一批 T10：本次資料的值列（從 listModeHtml 搬出，內容原樣）——健檢的「沒有步驟用到」chip、習慣選項 chip 都在這
function paramRowsHtml(def) {
  // 欄位值改多行框（T5）：單行時跟原本一樣高，貼一封信也放得下；「沒有步驟用到」chip 由健檢結果決定顯隱
  const unused = subjectIsDraft() ? [] : (preflightFor(def)?.unused_params ?? []);
  // 值列：placeholder＝該欄位的 hint（要貼什麼）；required 的標「必填」chip；值框下方＝習慣選項 chip（記憶輪 M3b，沒卡的欄位什麼都不顯示）
  const row = (p) => `
    <div class="param"><span>${esc(p.label)}${p.required ? '<span class="chip req" title="開跑前健檢：這欄沒填不給跑">必填</span>' : ''}<span class="chip unusedchip" data-unused="${esc(p.key)}" ${unused.includes(p.key) ? '' : 'hidden'} title="這個欄位沒有任何步驟的指示引用到——填了也沒人看">沒有步驟用到</span></span>
      <div class="val"><textarea class="autogrow" rows="1" data-param="${esc(p.key)}" placeholder="${esc(p.hint ?? '')}">${esc(state.paramNow[p.key] ?? p.default)}</textarea>${habitChipsHtml(p)}</div></div>`;
  // 移植合併輪 U4b：必填在前、選填收進「其他資料（選填）」；每列 markup 原樣（data-param／必填 chip／習慣 chip 一個不少，地雷 8）。
  // 收摺開合＝state.folderOpen.optional（使用者點過），沒點過＝這次有填到選填欄位就開
  const required = def.params.filter((p) => p.required);
  const optional = def.params.filter((p) => !p.required);
  if (!optional.length) return required.map(row).join('');
  const open = state.folderOpen?.optional ?? optional.some((p) => String(state.paramNow[p.key] ?? '').trim() !== '');
  return `${required.map(row).join('')}
    <details class="formdetails" ${open ? 'open' : ''}><summary data-act="folder-toggle" data-k="optional"><i class="ph ph-caret-down"></i>其他資料（選填）<span class="meta">${optional.length} 欄</span></summary>${optional.map(row).join('')}</details>`;
}
function listModeHtml() {
  const def = subjectDef();
  if (!def) {
    return `<div class="empty-c"><div class="ic"><i class="ph ph-list-checks"></i></div>
      <h3>還沒選流程</h3><p>左邊挑一個打開，或切到「聊天」講一件你的事拆一個新的。</p>
      <button class="btn btn-primary" data-act="open" data-cat="範例" data-id="quarterly-report"><i class="ph ph-play"></i>跑跑看範例</button></div>`;
  }
  // 欄位列（存進流程）：必填勾選即 PUT 定義
  const fieldRows = def.params.map((p) => `
    <div class="param"><span>${esc(p.label)}</span>
      <label class="reqtoggle"><input type="checkbox" data-req="${esc(p.key)}" ${p.required ? 'checked' : ''}>必填</label></div>`).join('');
  const addParam = state.addingParam
    ? `<div class="saverow" style="justify-content:flex-start">
        <input id="new-param-label" class="notein" style="margin:0;width:120px" placeholder="欄位名稱">
        <input id="new-param-default" class="notein" style="margin:0;width:150px" placeholder="預設值（留空＝必填）">
        <button class="btn btn-primary" data-act="confirm-param">加入</button>
        <button class="btn btn-ghost" data-act="cancel-param">取消</button>
      </div>`
    : `<div class="param expander" style="justify-content:flex-start;color:var(--ink-400);font-size:12px" data-act="add-param"><i class="ph ph-plus"></i> 新增欄位</div>`;
  if (subjectIsDraft()) {
    // 存檔下拉（記憶輪 M1c）：拆解器問過分類、草稿頂層有 category 就預選；「不分類」＝存進「未分類」（它是一般分類，先建目錄）
    const opt = (v, label) => `<option value="${esc(v)}" ${v === def.category ? 'selected' : ''}>${esc(label)}</option>`;
    const catOptions = state.categories.filter((c) => c !== '未分類').map((c) => opt(c, c)).join('') + opt('未分類', '不分類');
    const saveRow = state.savingDraft
      ? `<div class="saverow">
          <select id="save-category">${catOptions}<option value="__new__">＋ 新分類⋯</option></select>
          <input id="save-new-category" class="notein" style="margin:0;display:none;width:130px" placeholder="新分類名稱">
          <button class="btn btn-primary" data-act="confirm-save-draft">儲存</button>
          <button class="btn btn-ghost" data-act="cancel-save-draft">取消</button>
        </div>`
      : `<div class="saverow">
          <button class="btn btn-primary" data-act="save-draft"><i class="ph ph-tray-arrow-down"></i>存進流程庫</button>
          <button class="btn btn-ghost" data-act="clear-draft">清空</button>
        </div>`;
    return `<div class="sub">草稿——想調哪裡切「聊天」用講的，或切「畫布」直接拉。</div>
      ${stepListHtml(def)}
      ${def.params.length ? `<div class="params"><h5>可調欄位 · 每次開跑前能微調</h5>${def.params.map((p) => `<div class="param"><span>${esc(p.label)}</span><span class="chip">${esc(p.default)}</span></div>`).join('')}</div>` : ''}
      ${saveRow}`;
  }
  // 移植第一批 T10：開跑表單搬到「本次資料」分頁（dataTabHtml）；兩格記憶收成一行＋查看
  return `<div class="sub">這份流程會存起來，愈用愈準。要開跑，切上面的「本次資料」。</div>
    ${resumeHtml()}
    ${proposalsHtml()}
    ${stepListHtml(def)}
    ${flowMemLineHtml()}
    <div class="params"><h5>欄位 · 會存進流程</h5>${fieldRows}${addParam}</div>
    ${state.wf?.dictSimilar?.length ? `<p class="note"><i class="ph ph-info"></i> 這幾個欄位名跟詞典裡的很像：${esc(state.wf.dictSimilar.join('、'))}——已經照存，沒擋你。</p>` : ''}`;
}

// 開跑前健檢卡（T5）：block＝紅卡不給跑、只有提醒＝琥珀卡要按「照跑」；定義一改就自動作廢
function startCheckHtml() {
  const c = state.startCheck;
  if (!c || !state.wf || c.key !== JSON.stringify(state.wf.def)) return '';
  const blocks = c.issues.filter((i) => i.level === 'block');
  const warns = c.issues.filter((i) => i.level !== 'block');
  const row = (i) => `<div class="pfrow ${i.level === 'block' ? 'block' : 'warn'}">
      <span class="pfic"><i class="ph-fill ${i.level === 'block' ? 'ph-x-circle' : 'ph-warning'}"></i></span>
      <div class="pftext"><span class="pft">${esc(i.title)}</span><div class="pfdetail">${esc(i.detail ?? '')}</div></div>
      ${i.fix ? `<button class="btn sm2" data-act="pf-fix" data-kind="${esc(i.fix.kind)}" data-id="${esc(i.fix.id)}">修這裡</button>` : ''}
    </div>`;
  if (blocks.length) {
    return `<div class="alert red pfcard"><b><i class="ph-fill ph-warning"></i> 開跑前健檢：有 ${blocks.length} 處要先修</b>
      ${blocks.map(row).join('')}
      ${warns.length ? `<div class="pfsub">另外 ${warns.length} 則提醒，不擋跑</div>${warns.map(row).join('')}` : ''}
      <div class="btns"><button class="btn btn-ghost" data-act="start-check-close">先不跑</button></div>
    </div>`;
  }
  return `<div class="alert pfcard"><b><i class="ph-fill ph-warning"></i> 開跑前健檢：${warns.length} 則提醒</b>
    ${warns.map(row).join('')}
    <div class="btns"><button class="btn btn-primary" data-act="start-force"><i class="ph-fill ph-play"></i>照跑</button>
      <button class="btn btn-ghost" data-act="start-check-close">先不跑</button></div>
  </div>`;
}

// ---------- 畫布模式 ----------
// 常用預設列（D19 複製式）：選了＝把內容複製進欄位；☆＝把目前欄位內容存成常用；－＝刪掉選中的常用
function presetRowHtml(field, targetId) {
  const list = state.presets[field] ?? [];
  return `<div class="presetrow">
    <select class="moveselect" data-preset-for="${targetId}" data-preset-field="${field}">
      <option value="">常用片段⋯</option>
      ${list.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')}
    </select>
    <span class="pbtn" data-act="preset-save" data-field="${field}" data-target="${targetId}" title="把目前欄位內容存成常用"><i class="ph ph-star"></i>存為片段</span>
    <span class="pbtn" data-act="preset-del" data-field="${field}" data-target="${targetId}" title="刪掉上面選中的常用"><i class="ph ph-minus-circle"></i></span>
  </div>`;
}

function textFieldHtml(id, label, val, ph, presetField) {
  return `<div class="flabel">${label}</div>
    ${presetField ? presetRowHtml(presetField, id) : ''}
    <textarea id="${id}" class="feedbackin advarea" placeholder="${esc(ph)}">${esc(val ?? '')}</textarea>`;
}

// 參考檔區（D19）：勾選＝這一步的附件；範本填空選一檔
// 移植合併輪 U4c：三段「這條流程／部門／公司」各自勾（demo v8RefSections）。勾選鍵＝`scope:name`（同名兩層不撞，壓測 A3）；
// 流程段存字串（舊流程原樣）、上層存 {scope,name}（scope＝company｜category，同 U1b 後端）；規範類每步自動帶，不進勾選
const attKey = (a) => (typeof a === 'string' ? `flow:${a}` : `${a?.scope}:${a?.name}`);
function refFilesInner(n, checkedOverride) {
  const att = checkedOverride ?? new Set((n.attachments ?? []).map(attKey));
  const sh = state.shared ?? {};
  const box = (scope, name) => `<input type="checkbox" id="ref-${scope}-${esc(name)}" name="ref-${scope}-${esc(name)}" data-att="${esc(name)}" data-att-scope="${scope}" ${att.has(`${scope}:${name}`) ? 'checked' : ''}>`;
  // .docx／.xlsx 參考檔＝產檔範本（產檔輪）：檔名旁標「範本」，產出規格頁「範本填空」選它就叫工人套用；刪除鈕只有流程層
  const flowRows = (state.wfFiles ?? []).map((f) => `<label class="refrow">${box('flow', f)}<span class="wfname">${esc(f)}${/\.(docx|xlsx)$/i.test(f) ? '<span class="tplchip" title="Word／Excel 範本：在「產出規格」頁選為範本，工人會照它產檔">範本</span>' : ''}</span>
    <i class="ph ph-trash wfdel2" data-act="ref-del" data-name="${esc(f)}" title="刪掉這個參考檔"></i></label>`).join('');
  const sharedRows = (scope, d) => (d ? (d.refs ?? []).map((f) => `<label class="refrow">${box(scope, f.name)}<span class="wfname" title="${esc(f.name)}">${esc(f.name)}</span></label>`).join('') || '<p class="note">尚無參考</p>'
    : `<p class="note">${sh.err ? '共用檔讀不到' : '讀取中⋯'}</p>`);
  const seg = (scope, label, body) => `<div class="refseg" data-refseg="${scope}"><div class="refseghead">${label}</div>${body}</div>`;
  return `<div class="flabel">參考檔（勾＝這一步會看）</div>
    <div class="reflist">
      ${seg('flow', '這條流程', `${flowRows || '<p class="note">尚無參考</p>'}<span class="pbtn" data-act="ref-upload"><i class="ph ph-upload-simple"></i>上傳參考檔</span>`)}
      ${seg('category', '部門', sharedRows('category', sh.dept))}
      ${seg('company', '公司', sharedRows('company', sh.company))}
    </div>`;
}
// 範本填空（D21 起與參考檔分家：勾選住「任務內容」頁、範本住「產出規格」頁）
function templateInner(n, keepVal) {
  const files = state.wfFiles ?? [];
  const sel = keepVal !== undefined ? keepVal : (n.template_file ?? '');
  return `<div class="flabel">範本填空（選填）</div>
    <select id="cv-template" class="moveselect wfull">
      <option value="">不用範本</option>
      ${files.map((f) => `<option value="${esc(f)}" ${sel === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}
    </select>
    <p class="note" style="margin:4px 0 0">範本裡的 {{output}} 會被這步產出取代，{{參數}} 照常代入。</p>`;
}
function refFilesSectionHtml(n) {
  if (subjectIsDraft()) {
    return `<div class="flabel">參考檔</div><p class="note" style="margin:0">存進流程庫後才能掛參考檔。</p>`;
  }
  return `<div id="ref-section">${refFilesInner(n)}</div>`;
}
function templateSectionHtml(n) {
  if (subjectIsDraft()) {
    return `<div class="flabel">範本填空</div><p class="note" style="margin:0">存進流程庫後才能用範本填空。</p>`;
  }
  return `<div id="tpl-section">${templateInner(n)}</div>`;
}
// 檔案區操作後只重畫該兩區塊——整頁 render 會洗掉抽屜裡打到一半的字
async function refreshRefSection() {
  const checked = new Set([...document.querySelectorAll('[data-att]')].filter((c) => c.checked).map((c) => `${c.dataset.attScope ?? 'flow'}:${c.dataset.att}`)); // U4c：鍵 scope:name
  const tplNow = document.getElementById('cv-template')?.value;
  state.wfFiles = await api('GET', `${wfPath(state.wf)}/files`);
  const n = cvDef()?.nodes.find((x) => x.id === state.canvasSel);
  if (!n) return;
  const wrap = document.getElementById('ref-section');
  if (wrap) wrap.innerHTML = refFilesInner(n, checked);
  const tw = document.getElementById('tpl-section');
  if (tw) tw.innerHTML = templateInner(n, tplNow);
}

// 抽屜內容（D16／D17：設定型與內容型同一個地方；雙擊節點打開）
// 版面（排程與健檢輪 T4）：頂部固定列（標題／誰來做／停點／交出什麼／輸入來源）＋中段（子頁內兩欄 grid）＋底部固定列（套用／刪除／關閉）
// 監工三個勾（監工輪）：監工「可以」改這一步的什麼。缺省與後端 supervisor.supervisorFlags 同一組值
const supFlags = (n) => {
  const sv = n && typeof n.supervisor === 'object' && n.supervisor && !Array.isArray(n.supervisor) ? n.supervisor : {};
  const pick = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
  return { note: pick(sv.note, true), tier: pick(sv.tier, false), tools: pick(sv.tools, false) }; // 缺省與 src/supervisor.js supervisorFlags 同步（調檔位 09-09 改關）
};
const SUP_CHK =[['cv-sup-note', 'note', '寫交接備註'], ['cv-sup-tier', 'tier', '調檔位'], ['cv-sup-tools', 'tools', '開關查網']];
function supChecksHtml(n) {
  const f = supFlags(n);
  const boxes = SUP_CHK.map(([id, key, label]) => `<label class="chk"><input type="checkbox" id="${id}" ${f[key] ? 'checked' : ''}>${label}</label>`).join('');
  return `<div class="flabel">監工可以：</div>
    <div class="chkrow">${boxes}</div>
    <p class="note" style="margin:4px 0 0">勾了才會動；備註永遠只是加上去，不改你的指示</p>`;
}

function canvasEditorHtml(n, def) {
  const kind = kindOf(n);
  const titleRow = `<input id="cv-title" class="notein" style="margin:0;flex:1;min-width:160px" value="${esc(n.title)}" placeholder="這一步叫什麼">`;
  const closeBtn = '<button class="btn" data-act="cv-close-drawer" style="margin-left:auto">關閉</button>';
  if (kind === 'task') {
    const isAI = n.executor === 'ai';
    // 頂部固定列：標題、誰來做、停點、（人做）完成時要交出什麼、（AI）輸入來源
    const head = `<div class="cvdtop">
      <div class="cvdrow">${titleRow}
        <select id="cv-executor" class="moveselect"><option value="ai" ${isAI ? 'selected' : ''}>AI 執行</option><option value="human" ${!isAI ? 'selected' : ''}>人工</option></select>
        <label style="font-size:12.5px;display:flex;gap:4px;align-items:center;white-space:nowrap"><input type="checkbox" id="cv-stop" ${n.stop_point === 'always' ? 'checked' : ''}> 停點</label>
      </div>
      ${isAI ? drawerInputsHtml(n, def) + drawerMemoryHtml(n) : `<div class="cvdrow"><span class="flabel" style="margin:0;white-space:nowrap">完成時要交出什麼</span>
        <input id="cv-handoff" class="notein" style="margin:0;flex:1" placeholder="例：來信全文、整理好的名單——後面的 AI 步驟靠這份內容往下做" value="${esc(n.handoff ?? '')}"></div>`}
    </div>`;
    const foot = `<div class="cvdfoot">
        <button class="btn btn-primary" data-act="cv-apply">套用</button>
        <button class="btn btn-ghost btn-danger" data-act="cv-delete">刪除這步</button>
        <span class="note">這裡是後台原文，{{欄位}} 代碼在前台會自動變成欄位值。</span>
        ${closeBtn}
      </div>`;
    const reviewHtml = `<div class="flabel">驗收重點（選填）</div>
        <input id="cv-review" class="notein wfull" placeholder="你檢查時要看什麼；AI 交件前也會照它自檢" value="${esc(n.review_focus ?? '')}">`;
    if (!isAI) {
      return `${head}
        <div class="cvdbody single"><div class="cvcol">
          ${textFieldHtml('cv-instruction', '任務——這一步要做什麼', n.instruction, '這一步要做什麼', null)}
          ${reviewHtml}
        </div></div>
        ${foot}`;
    }
    // AI 步驟：兩子頁（D21，2026-09-03 定案保留）。切換走 DOM 顯隱不 render，套用時隱藏頁欄位照收；每頁內兩欄 grid
    const tab = state.drawerTab === 'spec' ? 'spec' : 'content';
    // 移植第一批 T11：任務內容頁先「任務」「驗收重點」兩格，其餘四欄＋參考檔收在 <details>；有值就預設展開，使用者點過就照他的（state.cvMore）
    const moreN = ['role_context', 'background', 'constraints', 'examples'].filter((k) => String(n[k] ?? '').trim()).length + (n.attachments?.length ? 1 : 0);
    const moreOpen = state.cvMore ?? moreN > 0;
    return `${head}
      <div class="seg segtabs" id="cv-tabs">
        <span class="${tab === 'content' ? 'on' : ''}" data-act="cv-tab" data-tab="content"><i class="ph ph-article"></i>任務內容</span>
        <span class="${tab === 'spec' ? 'on' : ''}" data-act="cv-tab" data-tab="spec"><i class="ph ph-sliders-horizontal"></i>產出規格</span>
      </div>
      <div class="cvpage cvdbody ${tab === 'content' ? '' : 'off'}" id="cv-page-content">
        <div class="cvcol">
          ${textFieldHtml('cv-instruction', '任務——這一步要做什麼', n.instruction, '這一步要做什麼', null)}
        </div>
        <div class="cvcol">
          ${reviewHtml}
        </div>
        <details class="cvmore" id="cv-more" ${moreOpen ? 'open' : ''}>
          <summary data-act="cv-more"><i class="ph ph-caret-down"></i>背景、限制與參考資料${moreN ? `<span class="chip">${moreN} 項有內容</span>` : ''}</summary>
          <div class="cvgrid2">
            <div class="cvcol">
              ${textFieldHtml('cv-role', '角色情境', n.role_context, '例：你是資深客服主管，語氣專業溫和', 'role_context')}
              ${textFieldHtml('cv-bg', '背景資料', n.background, '這一步需要知道的固定背景', 'snippet')}
            </div>
            <div class="cvcol">
              ${textFieldHtml('cv-constraints', '限制條件', n.constraints, '不可違反的規則，例：不承諾具體賠償金額', 'constraints')}
              ${textFieldHtml('cv-examples', '範例', n.examples, '貼一段理想產出的樣子，AI 會照著寫', 'snippet')}
              ${refFilesSectionHtml(n)}
            </div>
          </div>
        </details>
      </div>
      <div class="cvpage cvdbody ${tab === 'spec' ? '' : 'off'}" id="cv-page-spec">
        <div class="cvcol">
          <div class="flabel">輸出規格</div>
          <select id="cv-file" class="moveselect wfull">
            <option value="">產出檔案：不存檔（只顯示在畫面）</option>
            <optgroup label="直接存">
              ${['md', 'txt', 'csv', 'html', 'json'].map((x) => `<option value="${x}" ${n.output_file === x ? 'selected' : ''}>.${x}</option>`).join('')}
            </optgroup>
            <optgroup label="產真檔（需開產檔權限）">
              <option value="docx" ${n.output_file === 'docx' ? 'selected' : ''}>Word .docx</option>
              <option value="xlsx" ${n.output_file === 'xlsx' ? 'selected' : ''}>Excel .xlsx</option>
            </optgroup>
            <optgroup label="第二批（先降級存 .md）">
              <option value="pptx" ${n.output_file === 'pptx' ? 'selected' : ''}>簡報 .pptx</option>
              <option value="pdf" ${n.output_file === 'pdf' ? 'selected' : ''}>PDF .pdf</option>
            </optgroup>
          </select>
          <input id="cv-otype" class="notein wfull" placeholder="類型：表格／條列／一段文字／Email 草稿⋯" value="${esc(n.output_type ?? '')}">
          <input id="cv-ostructure" class="notein wfull" placeholder="結構：例 欄位=日期/標題/連結；或段落大綱" value="${esc(n.output_structure ?? '')}">
          <input id="cv-olength" class="notein wfull" placeholder="份量：例 500 字內、最多 10 列" value="${esc(n.output_length ?? '')}">
          <input id="cv-otone" class="notein wfull" placeholder="語言與語氣：例 中文、正式對外" value="${esc(n.output_tone ?? '')}">
          ${presetRowHtml('output_format', 'cv-output-format')}
          <input id="cv-output-format" class="notein wfull" placeholder="格式補充（規格外的特殊要求）" value="${esc(n.output_format ?? '')}">
        </div>
        <div class="cvcol">
          <div class="flabel">模型檔位與創意度</div>
          <div class="cvdrow" style="margin-bottom:6px">
            <select id="cv-model" class="moveselect" title="這一步用哪一檔模型">
              <option value="">模型：跟整體一樣</option>
              <option value="fast" ${n.model_tier === 'fast' ? 'selected' : ''}>模型：快而省</option>
              <option value="balanced" ${n.model_tier === 'balanced' ? 'selected' : ''}>模型：均衡</option>
              <option value="deep" ${n.model_tier === 'deep' ? 'selected' : ''}>模型：深而慢</option>
            </select>
            <select id="cv-creativity" class="moveselect" title="產出風格">
              <option value="">創意度：預設</option>
              <option value="strict" ${n.creativity === 'strict' ? 'selected' : ''}>創意度：嚴謹</option>
              <option value="open" ${n.creativity === 'open' ? 'selected' : ''}>創意度：發散</option>
            </select>
          </div>
          ${supChecksHtml(n)}
          <div class="flabel">出錯時</div>
          <select id="cv-retry" class="moveselect wfull" title="這一步出錯時怎麼辦">
            <option value="0">出錯：馬上停下來問我</option>
            <option value="1" ${n.retry === 1 ? 'selected' : ''}>出錯：先自動重試 1 次</option>
            <option value="2" ${n.retry === 2 ? 'selected' : ''}>出錯：先自動重試 2 次</option>
          </select>
          ${templateSectionHtml(n)}
        </div>
      </div>
      ${foot}`;
  }
  if (kind === 'branch') {
    const arms = n.branches.map((b, i) => `<input class="notein" style="margin:2px 0;width:100%" data-branch-label="${i}" value="${esc(b.label)}">`).join('');
    return `<div class="cvdtop"><div class="cvdrow">${titleRow}</div></div>
      <div class="cvdbody single"><div class="cvcol">
        <div class="flabel">判斷依據（人話）</div>
        <textarea id="cv-instruction" class="feedbackin advarea" style="border-color:var(--hairline)">${esc(n.instruction)}</textarea>
        <div class="flabel">每條路的條件</div>${arms}
        <p class="note">要多一條路：從畫布上這顆分岔小圓點的右緣再拉一條線出去，路的條件標籤就釘在各自的線上。「變並行點」＝去掉條件判斷，各條路改成同時做。</p>
      </div></div>
      <div class="cvdfoot">
        <button class="btn btn-primary" data-act="cv-apply">套用</button>
        <button class="btn btn-secondary" data-act="cv-branch-to-par">變並行點</button>
        <button class="btn btn-ghost btn-danger" data-act="cv-delete">刪掉這個點</button>
        ${closeBtn}
      </div>`;
  }
  if (kind === 'fork') {
    return `<div class="cvdtop"><div class="cvdrow">${titleRow}</div></div>
      <div class="cvdbody single"><div class="cvcol">
        <p class="sub" style="margin:6px 0"><i class="ph ph-git-branch"></i> 並行點：從它拉出去的幾條線同時進行；要會合，就把各支最後一步的線接進同一個步驟（它會自動收齊全部產出）。</p>
      </div></div>
      <div class="cvdfoot">
        <button class="btn btn-primary" data-act="cv-apply">套用</button>
        <button class="btn btn-ghost btn-danger" data-act="cv-delete">刪掉這個點</button>
        ${closeBtn}
      </div>`;
  }
  // 舊式 join（新流程不再產生）：說明＋一鍵拆直
  return `<div class="cvdtop"><div class="cvdrow">${titleRow}</div></div>
    <div class="cvdbody single"><div class="cvcol">
      <p class="sub" style="margin:6px 0"><i class="ph ph-git-merge"></i> 這是舊式會合點——現在會合＝多條線直接接進同一步，不需要這顆點。下次任何畫布編輯它會自動拆掉，線直接相連；也可以現在就拆。</p>
    </div></div>
    <div class="cvdfoot">
      <button class="btn btn-secondary" data-act="cv-dissolve">現在拆直</button>
      ${closeBtn}
    </div>`;
}

function canvasModeHtml() {
  const def = cvDef();
  if (!def) {
    return `<div class="empty-c"><div class="ic"><i class="ph ph-tree-structure"></i></div>
      <h3>還沒有流程可以畫</h3><p>左邊挑一個流程，或切到「聊天」講一件事——也可以雙擊下面空白處直接開始拉。</p>
      <button class="btn btn-primary" data-act="cv-new-blank"><i class="ph ph-plus"></i>從一個空白步驟開始拉</button></div>`;
  }
  const issues = state.cvShowIssues ? new Set(canvasIssues(def)) : new Set();
  if (!issues.size) state.cvShowIssues = false;
  const h = cvHistoryFor();
  return `<div class="toolbar">
      ${subjectIsDraft() ? '' : `<button class="btn btn-primary" data-act="cv-save" ${state.cvDirty ? '' : 'disabled'} title="存檔（Ctrl+S）——存檔時會檢查接線，沒接好的流程按「開始」不會跑"><i class="ph ph-floppy-disk"></i>存檔</button>`}
      <button class="btn btn-ghost" data-act="cv-undo" ${h.undo.length ? '' : 'disabled'} title="上一步（Ctrl+Z）"><i class="ph ph-arrow-counter-clockwise"></i>上一步</button>
      <button class="btn btn-ghost" data-act="cv-redo" ${h.redo.length ? '' : 'disabled'} title="重做（Ctrl+Y）"><i class="ph ph-arrow-clockwise"></i>重做</button>
      <span class="hint"><i class="ph ph-hand-tap"></i> 下方按鈕＝加框／並行／分岔｜雙擊空白＝加步驟｜雙擊節點＝打開細節｜按住節點＝拖位置｜右緣圓點拉線＝接線｜線上懸停＝插步／剪線</span>
      ${subjectIsDraft() ? '<span class="chip amber" style="margin-left:auto"><i class="ph ph-pencil-simple-line"></i>草稿——記得回聊天或清單按「存進流程庫」</span>'
    : state.cvDirty ? '<span class="chip amber" style="margin-left:auto"><i class="ph ph-pencil-simple-line"></i>有改動未存檔</span>' : ''}
    </div>
    <div class="cvstage">${window.BJCanvas.html(def, state.canvasSel, issues)}</div>`;
}

// 步驟抽屜（D18）：清單與畫布共用，蓋在工作區右側
function drawerHtml() {
  if (!state.drawerOpen || state.run || !(state.mode === 'list' || state.mode === 'canvas') || !(state.flowTab === 'design')) return ''; // T10：本次資料分頁不開抽屜
  const def = cvDef();
  const n = def?.nodes.find((x) => x.id === state.canvasSel);
  if (!n) return '';
  if (state.drawerTabFor !== n.id) { state.drawerTab = 'content'; state.drawerTabFor = n.id; state.cvMore = null; } // 換節點回預設頁、收摺回自動
  // 刻意簡化（T4）：原本頂部的「指示句人話預覽」拿掉——整幅雙欄要把垂直空間留給欄位；句子在清單／畫布上本來就看得到
  return `<div class="cvdrawer full"><div class="cvdhead"><span class="overline">步驟細節</span>
      <button class="btn btn-ghost iconb" data-act="cv-close-drawer"><i class="ph ph-x"></i></button></div>
    ${canvasEditorHtml(n, def)}</div>`;
}

// 抽屜頂部「輸入來源」（T5）：只給 AI 步驟；清單來自 /api/preflight 的 inputs，空的標紅
// 健檢一條輸入來源→一句（抽屜「輸入來源」清單與執行頁右欄「來源：」共用，U6b）：後端的 label 已是整句（含《》／「設定欄位：」）就照用；只給名字才包句子
const INPUT_WRAP = {
  upstream: (x) => `上一步《${x}》的產出`,
  human: (x) => `《${x}》（你來做）交出的內容`,
  param: (x) => `設定欄位：${x}`,
  attachment: (x) => `參考檔：${x}`,
};
function inputSourceText(s) {
  const raw = String(s.label ?? s.id);
  return /《|^設定欄位：|^參考檔：/.test(raw) ? raw : (INPUT_WRAP[s.kind] ?? ((x) => x))(raw);
}
function drawerInputsHtml(n, def) {
  if (kindOf(n) !== 'task' || n.executor !== 'ai') return '';
  const pf = preflightFor(def);
  if (!pf) {
    if (preflightCache.failed && preflightCache.key === JSON.stringify(def)) return '<div id="drawer-inputs"></div>'; // 健檢讀不到就不佔位
    return '<div id="drawer-inputs" class="dinputs"><div class="overline">輸入來源</div><div class="note" style="margin:2px 0 0">檢查中⋯</div></div>';
  }
  const ICON = { upstream: 'ph-arrow-bend-down-right', human: 'ph-user', param: 'ph-sliders-horizontal', attachment: 'ph-paperclip' };
  const items = (pf.inputs?.[n.id] ?? []).map((s) => `<li><i class="ph ${ICON[s.kind] ?? 'ph-dot'}"></i>${esc(inputSourceText(s))}</li>`).join('');
  return `<div id="drawer-inputs" class="dinputs"><div class="overline">輸入來源</div>
    ${items ? `<ul>${items}</ul>` : '<div class="none"><i class="ph-fill ph-warning"></i>開跑時什麼都拿不到</div>'}</div>`;
}

// ---------- 履歷模式 ----------
function historyModeHtml() {
  if (!state.wf || subjectIsDraft()) {
    return `<div class="empty-c"><div class="ic"><i class="ph ph-clock-counter-clockwise"></i></div>
      <h3>草稿還沒有履歷</h3><p>存進流程庫之後，每次它學新招或你動手改都會留一版，隨時退回。</p></div>`;
  }
  const cur = state.versions.at(-1)?.version;
  const srcLabel = { create: '建立', params: '參數習慣', edits: '停點修改', feedback: '事後回饋', rollback: '退回', manual: '手動編輯' };
  const rows = [...state.versions].reverse().map((v) => `
    <div class="ver ${v.version === cur ? 'now' : ''}">
      <b>v${v.version}</b>
      <span style="flex:1">${esc(v.diff_note)}<span class="meta">${esc(srcLabel[v.source] ?? v.source)}${v.at ? ' · ' + esc(new Date(v.at).toLocaleString('zh-TW', { hour12: false })) : ''}</span></span>
      ${v.version === cur ? '<span class="chip">現行版</span>' : `<span class="backb" data-act="rollback-version" data-version="${v.version}"><i class="ph ph-arrow-counter-clockwise"></i>退回這版</span>`}
    </div>`).join('');
  return `<div class="sub">每次它學新招、或你動手改（畫布／聊天）都留一版；改壞了退回就好，進行中的那趟會用當時的版本跑完。</div>
    ${rows || '<p class="note">還沒有版本紀錄。</p>'}`;
}

// ---------- 匯入預覽／垃圾桶／壞檔 ----------
function importPreviewHtml() {
  const { def, scan } = state.importPreview;
  const findingByNode = {};
  for (const f of scan.findings) (findingByNode[f.where] ??= []).push(f);
  const steps = def.nodes.map((n) => {
    const hits = findingByNode[n.id] ?? [];
    const flag = hits.length ? '<span class="chip red"><i class="ph-fill ph-warning"></i>可疑</span>' : '';
    const hitHtml = hits.map((f) => `<div class="finding">「${esc(f.quote)}」——${esc(f.reason)}</div>`).join('');
    return `<details class="artifact" ${hits.length ? 'open' : ''}><summary><i class="ph ph-file-text"></i>${esc(n.title)} <span class="chip">${(n.kind ?? 'task') !== 'task' ? esc(n.kind) : n.executor === 'human' ? '你來' : 'AI'}</span> ${flag}</summary>
      <div class="output" style="max-height:200px">${esc(n.instruction ?? '（無指示）')}</div>${hitHtml}</details>`;
  }).join('');
  let banner;
  let confirmBtn;
  if (scan.verdict === 'suspicious') {
    banner = `<div class="alert red"><b><i class="ph-fill ph-warning"></i> 掃描發現 ${scan.findings.length} 處可疑指示（已標黃）</b>
      <div class="why">看清楚再決定。預設是不匯入。</div></div>`;
    confirmBtn = `<button class="btn gray" data-act="confirm-import">仍要匯入</button>
      <button class="btn btn-primary" data-act="cancel-import">不匯入</button>`;
  } else if (scan.verdict === 'clean') {
    banner = `<div class="alert"><b>掃描沒有發現可疑指示</b>
      <div class="why">這不代表保證安全——步驟內容請自己過目一遍再確認。</div></div>`;
    confirmBtn = `<button class="btn btn-primary" data-act="confirm-import">確認匯入</button>
      <button class="btn btn-ghost" data-act="cancel-import">不匯入</button>`;
  } else {
    banner = `<div class="alert red"><b><i class="ph-fill ph-warning"></i> 掃描沒完成</b>
      <div class="why">安全掃描這次沒跑成。內容都列在下面，沒把握就先不要匯入。</div></div>`;
    confirmBtn = `<button class="btn gray" data-act="confirm-import">仍要匯入</button>
      <button class="btn btn-primary" data-act="cancel-import">不匯入</button>`;
  }
  return `<div class="tophead"><h3>匯入預覽：${esc(def.name)}</h3></div>
    ${banner}
    <div class="sub">共 ${def.nodes.length} 步。匯入後放在「匯入」分類，資料來源要在你自己這邊重新接（別人的連線不會跟過來）。</div>
    ${steps}
    <div class="btns" style="margin-top:var(--s4);justify-content:center">${confirmBtn}</div>`;
}

function trashViewHtml() {
  const rows = state.trash.map((t) => `<div class="step">
    <span class="n"><i class="ph ph-trash"></i></span><b>${esc(t.name)}</b>
    <span class="chip">${esc(t.category)}</span>
    <span class="sub" style="margin:0">${esc(new Date(t.trashed_at).toLocaleDateString('zh-TW'))} 刪除</span>
    <span class="pillslot"><button class="btn btn-secondary" style="padding:5px 13px" data-act="restore-trash" data-key="${esc(t.key)}">復原</button></span>
  </div>`).join('');
  return `<div class="tophead"><h3>垃圾桶</h3><span class="backb" data-act="close-trash"><i class="ph ph-caret-left"></i>回工作區</span></div>
    <div class="sub">刪掉的流程放 30 天，期限內都能整個復原（含履歷和跑過的紀錄）。</div>
    ${rows || '<div class="empty-c"><div class="ic"><i class="ph ph-trash"></i></div><h3>垃圾桶是空的</h3></div>'}`;
}

function corruptCardHtml() {
  return `<div class="card err" style="max-width:560px;margin:20px auto">
    <h3><i class="ph-fill ph-warning"></i> 這個流程的檔案讀不懂</h3>
    <p class="sub" style="margin:8px 0">${esc(state.corrupt.message)}（可能被手動改壞）。清單和其他流程都沒事。</p>
    <div class="btns">
      <button class="btn btn-primary" data-act="restore-corrupt"><i class="ph ph-arrow-counter-clockwise"></i>還原上一版</button>
      <button class="btn btn-ghost" data-act="close-trash">先回工作區</button>
    </div>
  </div>`;
}

// ---------- 執行畫面（整區接管） ----------
function stepPill(step) {
  switch (step.status) {
    case 'done': return `<span class="chip quiet"><i class="ph-fill ph-check-circle"></i>完成${step.edited_output != null ? ' · 你改過' : ''}</span>`;
    case 'running': return '<span class="chip quiet"><span class="thinking">進行中</span></span>';
    case 'waiting_review': return '<span class="chip wait"><i class="ph-fill ph-hand-pointing"></i>停點</span>';
    case 'waiting_human': return '<span class="chip wait"><i class="ph-fill ph-user"></i>人工處理</span>';
    case 'waiting_branch': return '<span class="chip wait"><i class="ph ph-arrows-split"></i>待選擇路徑</span>';
    case 'waiting_data': return '<span class="chip wait"><i class="ph-fill ph-warning"></i>資料不全</span>';
    case 'waiting_check': return '<span class="chip wait"><i class="ph-fill ph-hand-palm"></i>等你</span>'; // 移植合併輪 U6a：三欄化後左軌也用這顆，被攔的步不能灰成「等待」（地雷 3）；U6b：字用「等你」——「查核攔下」留給同列的 checkChip，不印兩顆同字
    case 'failed': return '<span class="chip bad"><i class="ph-fill ph-warning"></i>出錯</span>';
    case 'skipped': return '<span class="chip quiet" style="opacity:.6">跳過</span>';
    default: return '<span class="chip quiet">等待</span>';
  }
}

// 查核結果 chip（交貨查核輪）：missing 由資料不全卡呈現、off／skipped 不標；usage＝這一步的查核用量 {input,output}
const CHECK_CHIP = {
  pass: ['quiet', 'ph-fill ph-shield-check', '查過'],
  'redo-pass': ['quiet', 'ph-fill ph-arrows-clockwise', '重做過一次'],
  blocked: ['wait', 'ph-fill ph-hand-palm', '查核攔下'],
  incomplete: ['wait', 'ph-fill ph-warning', '未完成查核'],
  accepted: ['quiet', 'ph ph-check', '你說放行'],
};
function checkChip(step, usage) {
  const hit = CHECK_CHIP[step?.check?.status];
  if (!hit) return '';
  const [tone, icon, txt] = hit;
  const n = (usage?.input ?? 0) + (usage?.output ?? 0);
  return `<span class="chip ${tone}"><i class="${icon}"></i>${txt}${n ? ` · 查核 ${fmtInt(n)} token` : ''}</span>`;
}

// 標黃行（交貨查核輪）：查核沒攔下、但值得你看一眼的兩種情形
const FLAG_TXT = { 'conclusion-changed': '這一步把結論或排序改了', format: '格式跟要求不同' };
function flagsHtml(step) {
  return (step?.check?.flags ?? [])
    .filter((f) => FLAG_TXT[f.kind])
    .map((f) => `<div class="flagline"><i class="ph-fill ph-flag"></i><span>${esc(FLAG_TXT[f.kind])}：${esc(f.detail)}</span></div>`)
    .join('');
}

// ---------- 文字成品真排版（產檔輪）：POST /api/render 按內容雜湊快取；拿到前先顯示原文，回來只補該區塊不整頁重繪 ----------
const mdHash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return `${h.toString(36)}-${s.length}`; };
const mdTextByKey = new Map(); // 「看原文／看排版」切換時要拿得到原文
const mdPending = new Set();
let mdDown = false; // /api/render 回 404（後端沒好）：這次開頁不再打，全部顯示原文
// key＝這一格的識別（stop:節點／art:節點／dash:…），決定它是不是被切成「看原文」；cls＝外框 class（output／fprev／sprev）
function mdBlock(text, key, cls = 'output') {
  const t = String(text ?? '');
  const h = mdHash(t);
  mdTextByKey.set(key, t);
  const html = state.rendered[h];
  if (html === undefined && !mdDown && !mdPending.has(h)) {
    mdPending.add(h);
    api('POST', '/api/render', { text: t })
      .then((r) => { state.rendered[h] = r.html; patchRendered(h); })
      .catch((e) => { if (e.status === 404) mdDown = true; state.rendered[h] = false; })
      .finally(() => mdPending.delete(h));
  }
  const pretty = !state.rawView.has(key) && html;
  return `<div class="${cls} ${pretty ? 'docview' : ''}" data-md="${h}" data-mdkey="${esc(key)}">${pretty ? html : esc(t)}</div>`;
}
function patchRendered(h) {
  const html = state.rendered[h];
  if (!html) return;
  for (const el of document.querySelectorAll(`[data-md="${CSS.escape(h)}"]`)) {
    if (state.rawView.has(el.dataset.mdkey)) continue;
    el.innerHTML = html;
    el.classList.add('docview');
  }
}
// 「看原文／看排版」切換鈕；切換只改那一格（整頁重繪會把成品區展開的收起來）
function mdToggleHtml(key) {
  if (mdDown) return '';
  const raw = state.rawView.has(key);
  return `<span class="pbtn mdtoggle" data-act="md-toggle" data-key="${esc(key)}"><i class="ph ${raw ? 'ph-text-aa' : 'ph-code'}"></i>${raw ? '看排版' : '看原文'}</span>`;
}
function applyMdView(key) {
  const t = mdTextByKey.get(key) ?? '';
  const html = state.rendered[mdHash(t)];
  const el = document.querySelector(`[data-mdkey="${CSS.escape(key)}"]`);
  if (!el) { render(); return; }
  const pretty = !state.rawView.has(key) && html;
  el.innerHTML = pretty ? html : esc(t);
  el.classList.toggle('docview', !!pretty);
  const btn = document.querySelector(`[data-act="md-toggle"][data-key="${CSS.escape(key)}"]`);
  if (btn) btn.outerHTML = mdToggleHtml(key);
}

// 成品檔 chip（產檔輪）：點開頁內預覽浮窗，下載在浮窗裡
const FILE_ICON = { docx: 'ph-file-doc', xlsx: 'ph-file-xls', pdf: 'ph-file-pdf', csv: 'ph-file-csv', pptx: 'ph-file-ppt', txt: 'ph-file-txt', html: 'ph-file-html' };
function fileChipHtml(cat, id, rid, name, note) {
  const ext = String(name).split('.').pop().toLowerCase();
  return `<span class="chip expander filechip" data-act="preview-file" data-cat="${esc(cat)}" data-id="${esc(id)}" data-rid="${esc(rid)}" data-fname="${esc(name)}" title="${esc(note ?? '點開看內容，浮窗裡可下載')}"><i class="ph ${FILE_ICON[ext] ?? 'ph-file-text'}"></i>${esc(name)}</span>`;
}

// ---------- 成品預覽浮窗（產檔輪）：GET …/files/:name/preview 依 kind 渲染；狀態在 state.preview，輪詢重繪不會關掉 ----------
async function openPreview(cat, id, rid, name) {
  const pv = { cat, id, rid, name, data: null, err: null, sheet: 0 };
  state.preview = pv;
  render();
  try { pv.data = await api('GET', runFileUrl(cat, id, rid, name, '/preview')); }
  catch (e) { pv.err = e.message; }
  if (state.preview === pv) render();
}
function previewHtml() {
  const pv = state.preview;
  if (!pv) return '';
  const d = pv.data;
  let body;
  let tabs = '';
  if (pv.err) body = `<div class="pverr"><i class="ph-fill ph-warning"></i><span>預覽讀不到：${esc(pv.err)}。先用下面的「下載」開原檔。</span></div>`;
  else if (!d) body = '<div class="pvload"><span class="thinking">載入中⋯</span></div>';
  else if (d.kind === 'html') body = `<div class="docview">${d.html}</div>`;
  else if (d.kind === 'sheets') {
    const sheets = d.sheets ?? [];
    const i = Math.min(pv.sheet, Math.max(0, sheets.length - 1));
    if (sheets.length > 1) tabs = `<div class="seg pvtabs">${sheets.map((s, j) => `<span class="${j === i ? 'on' : ''}" data-act="preview-sheet" data-i="${j}">${esc(s.name)}</span>`).join('')}</div>`;
    body = sheets.length ? `<div class="sheetwrap">${sheets[i].html}</div>` : '<div class="pvload">這個檔案裡沒有工作表</div>';
  } else if (d.kind === 'pdf') body = `<iframe class="pdfframe" src="${esc(d.url)}" title="${esc(pv.name)}"></iframe>`;
  else body = `<pre class="pvtext">${esc(d.text ?? '')}</pre>`;
  const KIND_TXT = { html: '文件', sheets: '表格', pdf: 'PDF', text: '純文字' };
  const kindChip = d ? `<span class="chip">${esc(KIND_TXT[d.kind] ?? d.kind)}</span>` : '';
  // PDF 本身就是 PDF：不給「列印成 PDF」，直接下載
  const printBtn = d && d.kind !== 'pdf' ? '<button class="btn" data-act="preview-print"><i class="ph ph-printer"></i>列印成 PDF</button>' : '';
  const note = d?.kind === 'pdf' ? '這份已經是 PDF，直接下載就好。' : '列印只印這份內容；在列印視窗選「另存為 PDF」就是 PDF 檔。';
  return `<div class="pvback" data-act="preview-back"><div class="pvmodal" role="dialog" aria-label="成品預覽">
    <div class="pvhead"><i class="ph ${FILE_ICON[String(pv.name).split('.').pop().toLowerCase()] ?? 'ph-file-text'}"></i><b title="${esc(pv.name)}">${esc(pv.name)}</b>${kindChip}
      <button class="btn btn-ghost iconb" data-act="preview-close" style="margin-left:auto" title="關閉（Esc）"><i class="ph ph-x"></i></button></div>
    ${tabs}
    <div class="pvbody ${d?.kind ?? 'wait'}">${body}</div>
    <div class="pvfoot">
      <a class="btn btn-primary" href="${esc(runFileUrl(pv.cat, pv.id, pv.rid, pv.name))}" download="${esc(pv.name)}"><i class="ph ph-download-simple"></i>下載</a>
      ${printBtn}
      <span class="note">${note}</span>
      <button class="btn" data-act="preview-close">關閉</button>
    </div>
  </div></div>`;
}

// 監工交代＋插話（監工輪）：停點卡與查核卡共用。
// 「監工交代 ▸」只有真的有話時才出現（只帶 route 的分岔交接不算）；插話框只要卡在停點就給——
// 話會等到下一次交接時才交給監工消化，所以記下後這裡改標灰字「已交代：…」。
function supervisorNoteHtml(node) {
  const run = state.run;
  // 這趟沒開監工＝沒有人會來消化插話：不給輸入框、不標「已交代」，直說一句，免得使用者對著空氣交代
  if (run.def?.supervisor?.enabled === false) {
    return '<div class="supnote"><div class="note">監工關著，這裡交代的話不會帶到下一步</div></div>';
  }
  const step = run.steps?.[node.id] ?? {};
  const briefText = String(run.brief?.text ?? '');
  const handoffText = step.handoff?.only_route ? '' : String(step.handoff?.text ?? '');
  const open = !!state.supOpen[node.id];
  let head = '';
  if (briefText || handoffText) {
    const body = open ? `<div class="supbody">
      ${briefText ? `<div>開場：${esc(briefText)}</div>` : ''}
      ${handoffText ? `<div>交接：${esc(handoffText)}</div>` : ''}
    </div>` : '';
    head = `<span class="pbtn" data-act="sup-toggle" data-node="${esc(node.id)}">監工交代 ${open ? '▾' : '▸'}</span>${body}`;
  }
  const said = (run.interjections ?? []).filter((x) => x.node === node.id && !x.consumed);
  const saidLine = said.map((x) => `<div class="note">已交代：${esc(x.text)}</div>`).join('');
  const iid = `interject-${node.id}`;
  return `<div class="supnote">${head}${saidLine}
    <div class="interjectrow">
      <input id="${esc(iid)}" class="notein" data-keep placeholder="給接下來的步驟交代一句（選填）" data-node="${esc(node.id)}" value="${esc(kept(iid) ?? '')}">
      <button class="btn sm2" data-act="interject" data-node="${esc(node.id)}">記下</button>
    </div>
  </div>`;
}

function stopCardHtml(node, step) {
  if (state.editingNode === node.id) {
    return `<div class="card hold" style="margin:10px 0">
      <b>「${esc(node.title)}」——直接在下面這格改，改完往下</b>
      <textarea id="edit-output" class="output-edit">${esc(step.output)}</textarea>
      <input id="edit-note" class="notein" placeholder="（選填）一句話說你改了什麼——它之後會來問你要不要學起來">
      <div class="btns" style="margin-top:8px">
        <button class="btn btn-primary" data-act="edit" data-node="${esc(node.id)}">繼續</button>
        <button class="btn btn-ghost" data-act="cancel-edit">取消</button>
      </div>
    </div>`;
  }
  // 成品排版（產檔輪）：預設看排版、可切原文；有產出檔就給 chip 點開預覽。「編輯」的框仍用原文
  const w = state.run.workflow;
  const key = `stop:${node.id}`;
  const fileChip = step.file ? fileChipHtml(w.category, w.id, state.run.run_id, step.file, step.file_note) : '';
  return `<div class="card hold" style="margin:10px 0">
    <b>「${esc(node.title)}」做好了，給你過目</b>
    ${node.review_focus ? `<div class="sub" style="margin:6px 0"><i class="ph ph-list-magnifying-glass"></i> 檢查重點：${esc(node.review_focus)}</div>` : ''}
    <div class="outbar">${fileChip}${mdToggleHtml(key)}</div>
    ${mdBlock(step.output, key)}
    ${memoryUsedHtml(node, step)}
    ${supervisorNoteHtml(node)}
    <div class="btns">
      <button class="btn btn-primary" data-act="approve" data-node="${esc(node.id)}">繼續</button>
      <button class="btn btn-secondary" data-act="start-edit" data-node="${esc(node.id)}">編輯</button>
      <button class="btn btn-ghost" data-act="back">稍後</button>
    </div>
  </div>`;
}

// 往下找最近的幾個真正步驟（穿過並行點／分岔／舊會合點）
function nextTasks(def, id, seen = new Set()) {
  const n = def.nodes.find((x) => x.id === id);
  if (!n || seen.has(id)) return [];
  seen.add(id);
  return outgoingOf(n).flatMap((t) => {
    const m = def.nodes.find((x) => x.id === t);
    if (!m) return [];
    return kindOf(m) === 'task' ? [m] : nextTasks(def, t, seen);
  });
}

function humanCardHtml(node) {
  const def = state.run.def;
  const aiNext = nextTasks(def, node.id).filter((m) => m.executor === 'ai');
  const handLabel = node.handoff ? `交給下一步的內容：${esc(node.handoff)}` : '交給下一步的內容';
  const nextNote = aiNext.length
    ? `<p class="note handnote">下一步《${aiNext.map((m) => esc(m.title)).join('》《')}》要用這裡的內容，留空它就空手。</p>` : '';
  return `<div class="card hold" style="margin:10px 0">
    <b>輪到你了：${esc(node.title)}——這步 AI 代替不了</b>
    <div class="output">${humanize(node.instruction, def, state.run.params)}</div>
    <div class="flabel">${handLabel}</div>
    <textarea id="human-content" class="feedbackin autogrow" data-keep placeholder="做完把要交出去的內容貼在這裡（可以留空）">${esc(kept('human-content') ?? '')}</textarea>
    ${nextNote}
    <div class="sub" style="margin:6px 0">流程會停在這裡等你，不趕時間。順手留一句現場狀況更好（選填）。</div>
    <textarea id="human-feedback" class="feedbackin" placeholder="例：主管對第三頁的圖很有興趣，數據問得很細⋯"></textarea>
    <div class="btns" style="margin-top:8px">
      <button class="btn btn-primary" data-act="human-done" data-node="${esc(node.id)}"><i class="ph ph-check"></i>標記完成</button>
      <button class="btn btn-ghost" data-act="back">稍後</button>
    </div>
  </div>`;
}

function branchChoiceCardHtml(node) {
  const byId = new Map(state.run.def.nodes.map((n) => [n.id, n]));
  const options = node.branches.map((b) => `
    <div class="step expander" data-act="choose-branch" data-node="${esc(node.id)}" data-target="${esc(b.next)}">
      <span class="n"><i class="ph ph-arrow-right"></i></span><b>${esc(b.label)}</b>
      <span class="chip">接著走「${esc(byId.get(b.next)?.title ?? b.next)}」</span>
    </div>`).join('');
  return `<div class="card hold" style="margin:10px 0">
    <b>這筆該走哪條？AI 判不出來，你指一下</b>
    <div class="sub" style="margin:6px 0">判斷依據：${esc(node.instruction)}</div>
    ${options}
    <div class="btns" style="margin-top:6px"><button class="btn btn-ghost" data-act="back">稍後</button></div>
  </div>`;
}

function joinBlockedCardHtml(node, run) {
  const preds = run.def.nodes.filter((p) => outgoingOf(p).includes(node.id));
  const lacking = preds.filter((p) => !['done', 'skipped'].includes(run.steps[p.id].status));
  if (!lacking.length) return '';
  const names = lacking.map((p) => `「${esc(p.title)}」`).join('、');
  return `<div class="alert" style="margin:6px 0"><b>會合點等著</b>
    <div class="why">還缺 ${names}——好了會自動繼續，不用你按。</div></div>`;
}

function dataCardHtml(node, step) {
  const note = String(step.data_note ?? '').trim();
  const sentence = !note || /[。.!?！？]$/.test(note) ? note : `${note}。`; // 結尾已有句號就不再補（雙句號修掉）
  const d = step.data_diagnosis;
  const diag = d ? `<div class="diag"><i class="ph ph-first-aid-kit"></i>
      <span><span class="lb">可能的原因：</span>${esc(d.reason ?? '')}${d.suggestion ? `　<span class="lb">建議：</span>${esc(d.suggestion)}` : ''}</span>
      ${d.fix?.kind === 'node' ? `<button class="btn sm2" data-act="data-fix-node" data-node="${esc(d.fix.id)}">去改這一步</button>` : ''}
    </div>` : '';
  const supplyOpen = state.dataSupplyOpen === node.id;
  const supply = supplyOpen ? `<div class="supplybox">
      <div class="flabel">把這一步需要的資料貼在這裡，它會連同原本拿到的一起重做</div>
      <textarea id="data-supply-text" class="feedbackin autogrow" data-keep placeholder="例：貼上來信全文、名單、紀錄⋯">${esc(kept('data-supply-text') ?? step.supplied_input ?? '')}</textarea>
      <div class="btns" style="margin-top:6px">
        <button class="btn btn-primary" data-act="data-supply" data-node="${esc(node.id)}"><i class="ph ph-arrows-clockwise"></i>用這份重跑</button>
        <button class="btn btn-ghost" data-act="data-supply-cancel">取消</button>
      </div>
    </div>` : '';
  return `<div class="alert red">
    <b><i class="ph-fill ph-warning"></i> 資料不全，先停在這裡</b>
    <div class="why">${esc(sentence)}拿不齊的資料做下去，風險在你，所以先問你。</div>
    ${diag}
    ${step.output ? `<div class="output" style="max-height:160px">${esc(step.output)}</div>` : ''}
    ${supply}
    <div class="btns">
      <button class="btn btn-primary" data-act="data-retry" data-node="${esc(node.id)}">重抓</button>
      <button class="btn btn-secondary" data-act="data-accept" data-node="${esc(node.id)}">沿用</button>
      ${supplyOpen ? '' : `<button class="btn btn-secondary" data-act="data-supply-open" data-node="${esc(node.id)}"><i class="ph ph-clipboard-text"></i>補資料</button>`}
      <button class="btn btn-ghost" data-act="back">稍後</button>
    </div>
  </div>`;
}

// 查核卡（交貨查核輪）：重做一次仍被攔下——把原始資料那句與成品那句並排，三個出口＋稍後
function checkCardHtml(node, step) {
  if (state.editingNode === node.id) return stopCardHtml(node, step); // 「修改」沿用停點卡的編輯框
  const key = `check:${node.id}`;
  const blocks = (step.check?.blocks ?? []).map((b) => {
    // must／stop-edit 這兩種攔的是「你的要求」，沒有原始資料可並排——並排只給對得上原文的那兩種
    const body = ['must', 'stop-edit'].includes(b.kind)
      ? `<div class="rulehit"><span class="lb">你的要求：</span>${esc(b.claim)}</div>`
      : `<div class="pair">
          <div class="col"><div class="lb">原始資料（相關原文）</div><div class="tx">${b.source ? esc(b.source) : '—'}</div></div>
          <div class="col"><div class="lb">成品（那句話）</div><div class="tx">${b.claim ? esc(b.claim) : '—'}</div></div>
        </div>`;
    return `<div class="blk"><div class="bd"><span class="lb">錯在哪：</span>${esc(b.detail)}</div>${body}</div>`;
  }).join('');
  // 查核員自己那句話：實走發現只有「錯在哪：算式」時看不懂為什麼被攔（例：成品寫 14、錯在哪也寫 6+3+4+1=14）
  const summary = step.check?.summary ? `<div class="cksum">${esc(step.check.summary)}</div>` : '';
  return `<div class="card err checkcard" style="margin:10px 0">
    <b><i class="ph-fill ph-hand-palm"></i> 查核攔下：成品跟原始資料對不上，重做一次還是不對</b>
    ${summary}
    ${blocks}
    <div class="outbar">${mdToggleHtml(key)}</div>
    ${mdBlock(step.output, key)}
    ${memoryUsedHtml(node, step)}
    <textarea id="check-note-${esc(node.id)}" class="feedbackin autogrow" data-keep placeholder="跟它講哪裡不對、要怎麼改；留空就是照查核結果重做">${esc(kept(`check-note-${node.id}`) ?? '')}</textarea>
    ${supervisorNoteHtml(node)}
    <div class="btns" style="margin-top:8px">
      <button class="btn btn-primary" data-act="check-retry" data-node="${esc(node.id)}"><i class="ph ph-arrows-clockwise"></i>重做</button>
      <button class="btn btn-secondary" data-act="check-accept" data-node="${esc(node.id)}">放行</button>
      <button class="btn btn-secondary" data-act="start-edit" data-node="${esc(node.id)}">修改</button>
      <button class="btn btn-ghost" data-act="back">稍後</button>
    </div>
  </div>`;
}

// 停點修改後擬出的規則（交貨查核輪）：後面每一步都會帶著它跑，查核也把它當必守；使用者可以自己改
function editRulesHtml(node, step) {
  const rules = step.edit_rules ?? [];
  if (!rules.length) return '';
  if (state.editRulesOpen === node.id) {
    return `<div class="rules editing">
      <div class="flabel">後面每步會守：（一行一條）</div>
      <textarea id="edit-rules-text" class="feedbackin autogrow" data-keep>${esc(kept('edit-rules-text') ?? rules.map((r) => r.text).join('\n'))}</textarea>
      <div class="btns" style="margin-top:6px">
        <button class="btn btn-primary" data-act="edit-rules-save" data-node="${esc(node.id)}">儲存</button>
        <button class="btn btn-ghost" data-act="edit-rules-cancel">取消</button>
      </div>
    </div>`;
  }
  const items = rules.map((r) => `<li>${esc(r.text)}${r.scope === 'this-step' ? '<span class="chip">僅此步</span>' : ''}</li>`).join('');
  return `<div class="rules"><div class="rhead"><b>後面每步會守：</b>
      <span class="pbtn" data-act="edit-rules-open" data-node="${esc(node.id)}"><i class="ph ph-pencil-simple"></i>編輯</span></div>
    <ul>${items}</ul></div>`;
}

function failCardHtml(node, step) {
  return `<div class="alert red">
    <b><i class="ph-fill ph-warning"></i> 這一步出狀況，先停在這裡</b>
    <div class="why">${esc(step.error)}</div>
    <div class="btns"><button class="btn btn-primary" data-act="retry" data-node="${esc(node.id)}"><i class="ph ph-arrows-clockwise"></i>重試</button>
    <button class="btn btn-ghost" data-act="back">稍後</button></div>
  </div>`;
}

// 監工「建議改哪裡」指到的位置（與 supervisor.js 的 WHERE_LABELS 同一張表）
const WHERE_LABELS = { instruction: '指示', constraints: '限制條件', review_focus: '驗收重點', params: '欄位', rule: '規則' };
// 每步「監工 N token」：開場、交接、收尾都記在 supervisor 那一格
const supTokens = (usage) => (usage?.input ?? 0) + (usage?.output ?? 0);
function supChip(usage) {
  const n = supTokens(usage);
  return n ? `<span class="chip" title="這一步的監工交接花掉的">監工 ${fmtInt(n)} token</span>` : '';
}

// 「紀錄整理中…」最多等這麼久：run 標 done 之後監工還要跑一次收尾呼叫才會有 record，
// 超過這個窗口還沒有就代表沒指望了（收尾監工失敗，或這是本功能上線前跑完的舊 run）——schedulePoll 共用同一個常數
const RECORD_WAIT_MS = 3 * 60 * 1000;
// run 跑完了、監工有開、但收尾紀錄還沒寫進來、且還在等待窗口內——recordHtml 顯示與 schedulePoll 續輪詢共用同一個判斷
function recordPending(run) {
  return run?.status === 'done'
    && run.def?.supervisor?.enabled !== false
    && !run.record
    && !!run.finished_at
    && Date.now() - Date.parse(run.finished_at) < RECORD_WAIT_MS;
}

// 「這趟的紀錄」（監工輪）：跑完才有——監工用人話寫這趟發生了什麼，外加指得到位置的「建議改哪裡」
function recordHtml(run) {
  const rec = run.record;
  if (run.def?.supervisor?.enabled === false) {
    return '<div class="card" style="margin:10px 0"><b>這趟的紀錄</b><div class="sub" style="margin:6px 0 0">這條流程沒開監工。</div></div>';
  }
  if (!rec) {
    const msg = recordPending(run) ? '紀錄整理中⋯' : '這趟沒有監工紀錄';
    return `<div class="card" style="margin:10px 0"><b>這趟的紀錄</b><div class="sub" style="margin:6px 0 0">${msg}</div></div>`;
  }
  const tot = rec.usage?.total ?? {};
  const supAll = Object.values(run.usage_by_node ?? {}).reduce((a, u) => a + supTokens(u.supervisor), 0);
  const usageLine = `<div class="note" style="margin:6px 0 0">這趟共 ${fmtInt((tot.input ?? 0) + (tot.output ?? 0))} token・其中監工 ${fmtInt(supAll)} token</div>`;
  // 記憶輪（M4）：對應表的「卡」欄只加總成一句（表本身不顯示卡欄）；舊紀錄沒有 table 就不提
  const cardsN = Array.isArray(rec.table) ? rec.table.reduce((a, r) => a + (r.cards?.length ?? 0), 0) : null;
  const memLine = cardsN == null ? '' : `<div class="note" style="margin:2px 0 0" data-record-cards="${cardsN}">${cardsN ? `這趟每步帶了記憶，各步加起來 ${cardsN} 條` : '這趟沒帶任何記憶'}</div>`;
  const titleOf = (id) => run.def?.nodes.find((n) => n.id === id)?.title ?? id;
  const sug = (rec.suggestions ?? []).map((s) => `<div class="sugrow">
      <span>${esc(titleOf(s.node))}・${esc(WHERE_LABELS[s.where] ?? s.where)}：${esc(s.text)}</span>
      <button class="btn sm2" data-act="record-goto" data-node="${esc(s.node)}" data-where="${esc(s.where)}">改這裡</button>
    </div>`).join('');
  return `<div class="card" style="margin:10px 0"><b>這趟的紀錄</b>
    <div class="output" style="max-height:220px">${esc(rec.text)}</div>
    ${sug ? `<div class="flabel">建議改哪裡</div>${sug}` : ''}
    ${usageLine}${memLine}
  </div>`;
}

function runHtml() {
  const run = state.run;
  const def = run.def;
  const doneCount = def.nodes.filter((n) => run.steps[n.id].status === 'done').length;
  const isDone = run.status === 'done';
  const started = new Date(run.started_at);
  // 欄位值可多行了（T5）：摘要列只露第一行前 40 字，整份放 title
  const brief = (v) => { const s = String(v ?? '').split('\n')[0]; return s.length > 40 ? `${s.slice(0, 40)}⋯` : s; };
  const meta = `${started.toLocaleString('zh-TW', { hour12: false })} 開跑 · 這次設定：${def.params.map((p) => `<span title="${esc(run.params[p.key])}">${esc(brief(run.params[p.key]))}</span>`).join('・') || '（無）'}`;

  // 移植合併輪 U6c：左軌點了別的步＝歷史視圖（demo runPage 的 inspect），中欄只印那一步；＝目前這步或節點找不到＝現況
  const histNode = historyNodeOf(run);
  const historical = !!histNode;

  let rows = '';
  let seq = 0;
  if (!historical) for (const node of topoNodes(def)) {
    const step = run.steps[node.id];
    const kind = kindOf(node);
    if (kind === 'fork') continue;
    if (kind === 'join') {
      if (!isDone && !['done', 'skipped'].includes(step.status)) rows += joinBlockedCardHtml(node, run);
      continue;
    }
    seq++;
    if (kind === 'branch') { rows += branchRowHtml(run, node, step) + stepCardHtml(node, step); continue; }
    rows += taskRowHtml(run, node, step, seq) + flagsHtml(step) + stepCardHtml(node, step);
    if (step.status === 'done') rows += editRulesHtml(node, step);
  }

  let tail = '';
  if (isDone && !historical) {
    // 人做步驟有交出內容的也列（T5），標「（你交出的）」
    const artifacts = topoNodes(def)
      .filter((n) => kindOf(n) === 'task' && run.steps[n.id].status === 'done' && (n.executor === 'ai' || run.steps[n.id].output))
      .map((n) => {
        const s = run.steps[n.id];
        const tag = n.executor === 'human' ? '（你交出的）' : s.edited_output != null ? '（你改過的版本）' : '';
        const key = `art:${n.id}`;
        const chip = s.file ? fileChipHtml(run.workflow.category, run.workflow.id, run.run_id, s.file, s.file_note) : '';
        return `<details class="artifact"><summary><i class="ph ${n.executor === 'human' ? 'ph-user' : 'ph-file-text'}"></i>${esc(n.title)}${tag}${chip}<span class="pillslot">${mdToggleHtml(key)}</span></summary>
          ${mdBlock(s.edited_output ?? s.output, key)}</details>`;
      }).join('');
    const feedbackBox = state.feedbackSent
      ? feedbackReplyHtml(state.feedbackSent) // 記憶輪（M2）：回覆照 memory_notice 講記成卡了／沒記成
      : `<div class="card proposal">
          回來丟一句結果吧——「主管說哪裡好、哪裡不行」，它會學起來。
          <div class="chatin" style="margin-top:8px"><input id="run-feedback-input" placeholder="例：主管說數據太細了⋯">
          <button class="btn btn-primary" data-act="send-run-feedback"><i class="ph-fill ph-paper-plane-tilt"></i></button></div>
        </div>`;
    tail = `<div class="card" style="margin:var(--s4) 0;background:var(--fill-soft)"><b>成品在這裡</b>
      <div style="margin-top:8px">${artifacts}</div></div>
      ${proposalsHtml()}
      ${feedbackBox}`;
  }

  const title = isDone ? `跑完了：${esc(def.name)}` : `進行中：${esc(def.name)}`;
  const pill = isDone ? '<span class="chip quiet"><i class="ph-fill ph-check-circle"></i>全部完成</span>'
    : run.status === 'paused' ? '<span class="chip wait"><i class="ph-fill ph-hourglass-medium"></i>停著等你</span>'
      : `<span class="chip quiet">第 ${Math.min(doneCount + 1, def.nodes.length)} 步</span>`;
  const main = historical ? runHistoryHtml(run, histNode) : `${isDone ? recordHtml(run) : ''}${rows}${tail}`;
  return `${crumbsHtml('這次的執行')}<div class="tophead"><h3>${title}</h3>${pill}<span class="backb" style="margin-left:auto" data-act="back"><i class="ph ph-caret-left"></i>回工作區</span></div>
    <div class="sub">${meta}</div>${memoryNoticeHtml(run)}<div class="runlayout">${progressRailHtml(run)}<section class="runmain">${main}</section>${sideInfoHtml(run)}</div>`;
}

// 步驟列（中欄現況與歷史視圖共用；U6c 從 runHtml 的迴圈抽出，字面不變）
function branchRowHtml(run, node, step) {
  const chosenNote = step.choice
    ? `<span class="chip">走了「${esc(step.choice_label)}」${step.choice_by === 'user' ? '（你選的）' : ''}</span>` : '';
  const cls = step.status === 'done' ? 'done' : step.status === 'waiting_branch' ? 'halt' : step.status === 'running' ? 'running' : '';
  return `<div class="step ${cls}" data-steprow="${esc(node.id)}"><span class="n"><i class="ph ph-arrows-split"></i></span><b>${esc(node.title)}</b>
        <span class="chip amber">分岔</span>${chosenNote}<span class="pillslot">${supChip(run.usage_by_node?.[node.id]?.supervisor)}${stepPill(step)}</span></div>`;
}
function taskRowHtml(run, node, step, seq) {
  const cls = step.status === 'done' ? 'done' : step.status === 'failed' ? 'errstep' : step.status.startsWith('waiting') ? 'halt' : step.status === 'running' ? 'running' : '';
  const dim = step.status === 'skipped' ? 'style="opacity:.55"' : '';
  const fileChip = step.file ? fileChipHtml(run.workflow.category, run.workflow.id, run.run_id, step.file, step.file_note) : '';
  let h = `<div class="step ${cls}" data-steprow="${esc(node.id)}" ${dim}><span class="n">${step.status === 'done' ? '<i class="ph ph-check"></i>' : step.status === 'skipped' ? '—' : seq}</span><b>${esc(node.title)}</b>
      <span class="chip">${node.executor === 'human' ? '<i class="ph ph-user"></i>你來' : 'AI'}</span>
      <span class="pillslot">${fileChip}${checkChip(step, run.usage_by_node?.[node.id]?.check)}${supChip(run.usage_by_node?.[node.id]?.supervisor)}${stepPill(step)}</span></div>`;
  if (step.file_note && step.file) h += `<p class="note" style="margin:2px 0 6px 20px">${esc(step.file_note)}</p>`;
  return h;
}
// 停著／出錯那步的卡：現況直接印；歷史視圖整張包進 inert（卡片函式與 data-act 一字不動）
function stepCardHtml(node, step) {
  if (kindOf(node) === 'branch') return step.status === 'waiting_branch' ? branchChoiceCardHtml(node) : step.status === 'failed' ? failCardHtml(node, step) : '';
  switch (step.status) {
    case 'waiting_review': return stopCardHtml(node, step);
    case 'waiting_check': return checkCardHtml(node, step);
    case 'waiting_human': return humanCardHtml(node);
    case 'waiting_data': return dataCardHtml(node, step);
    case 'failed': return failCardHtml(node, step);
    default: return '';
  }
}

// ---------- 移植合併輪 U6c：歷史視圖（demo runPage 的 inspect／historical）——左軌點了做過的一步，中欄只剩那一步 ----------
// 看的那步：state.runInspect 指到的節點；＝目前這步（currentNodeOf）不算歷史；指到不存在／fork／join（輪詢中被刪）退回 null
function historyNodeOf(run) {
  const id = state.runInspect;
  if (id == null) return null;
  const node = run.def.nodes.find((n) => n.id === id);
  if (!node || ['fork', 'join'].includes(kindOf(node))) { state.runInspect = null; return null; }
  return id === currentNodeOf(run) ? null : node;
}
// 橫幅「你在看…回到目前」＋那一步的列＋產出（edited_output 優先並標「你改過的版本」）＋後面每步會守；
// 那步若正停著（並行支線的 waiting_*／出錯）→ 卡整張包進 <div class="histcard" inert>（整塊不可點不可輸入）＋一句 note；recordHtml／tail／回饋框不印
function runHistoryHtml(run, node) {
  const step = run.steps[node.id] ?? { status: 'pending' };
  const isBranch = kindOf(node) === 'branch';
  const seq = topoNodes(run.def).filter((n) => !['fork', 'join'].includes(kindOf(n))).findIndex((n) => n.id === node.id) + 1;
  const banner = `<div class="runbanner hist"><i class="ph ph-clock-counter-clockwise"></i><span>你在看「${esc(node.title)}」這一步的歷史</span><button class="btn btn-secondary sm2" data-act="run-current"><i class="ph ph-arrow-bend-up-left"></i>回到目前</button></div>`;
  const row = isBranch ? branchRowHtml(run, node, step) : taskRowHtml(run, node, step, seq) + flagsHtml(step);
  const card = stepCardHtml(node, step);
  let body;
  if (card) body = `<div class="histcard" inert>${card}</div><p class="note histnote"><i class="ph ph-lock-simple"></i>回到目前才能操作</p>`;
  else if (step.status === 'done' && !isBranch && (step.edited_output != null || step.output)) {
    const key = `hist:${node.id}`;
    body = `<div class="outbar">${step.edited_output != null ? '<span class="chip">你改過的版本</span>' : ''}${mdToggleHtml(key)}</div>${mdBlock(step.edited_output ?? step.output, key)}`;
  }
  else if (step.status === 'done') body = isBranch ? '' : '<p class="note">這一步沒有留下產出</p>';
  else if (step.status === 'pending') body = '<p class="note">這一步還沒開始</p>';
  else if (step.status === 'running') body = '<p class="note">這一步進行中</p>';
  else body = '<p class="note">這一步沒走到</p>'; // skipped
  return banner + row + body + (step.status === 'done' ? editRulesHtml(node, step) : '');
}

// ---------- 移植合併輪 U6a：執行頁三欄——左軌（這次的進度）、中欄（原樣：步驟列＋卡＋成品）、右欄（四格摺疊）；demo runPage() ----------
// 「目前這步」：第一個停著等你的（waiting_*），否則進行中的，否則最後一個做完的，否則第一步
function currentNodeOf(run) {
  const nodes = topoNodes(run.def).filter((n) => !['fork', 'join'].includes(kindOf(n)));
  const st = (n) => run.steps?.[n.id]?.status ?? '';
  return (nodes.find((n) => st(n).startsWith('waiting')) ?? nodes.find((n) => st(n) === 'running') ?? [...nodes].reverse().find((n) => st(n) === 'done') ?? nodes[0])?.id ?? null;
}

// 左軌：每個非 fork／join 節點一顆鈕；點了＝切成那一步的歷史視圖（U6c）；active＝看的那步（沒點就是目前這步）
function progressRailHtml(run) {
  const currentId = currentNodeOf(run);
  const activeId = state.runInspect ?? currentId;
  let seq = 0;
  const items = topoNodes(run.def).filter((n) => !['fork', 'join'].includes(kindOf(n))).map((node) => {
    const step = run.steps?.[node.id] ?? { status: 'pending' };
    seq++;
    const n = step.status === 'done' ? '<i class="ph ph-check"></i>' : step.status === 'skipped' ? '—' : kindOf(node) === 'branch' ? '<i class="ph ph-arrows-split"></i>' : seq;
    // 還沒跑到的步（pending／skipped 且不是目前這步）照 demo 灰掉不可點（U6c 覆核該修）；running／done／failed／waiting 都可點
    const future = ['pending', 'skipped'].includes(step.status) && node.id !== currentId;
    return `<button class="runstep${node.id === activeId ? ' active' : ''}" data-act="run-inspect" data-node="${esc(node.id)}" title="${future ? '還沒跑到' : esc(node.title)}"${future ? ' disabled' : ''}><span class="n">${n}</span><span class="t">${esc(node.title)}</span>${stepPill(step)}</button>`;
  }).join('');
  return `<aside class="progressrail"><h5>這次的進度</h5>${items}</aside>`;
}

// 右欄看的那一步：state.runInspect（歷史視圖，U6c）優先，否則 currentNodeOf
function sideNodeOf(run) {
  const curId = state.runInspect ?? currentNodeOf(run);
  return run.def.nodes.find((n) => n.id === curId) ?? run.def.nodes[0] ?? {};
}

// 右欄「這步會用到的資料」（U6b）：共用檔行讀 step.memory.shared（runner 送工作單前寫的快照＝開跑鎖的那版）＋「哪幾份」＋來源一行；
// 不重印 memoryUsedHtml（會共用 memOpen 雙開）——記憶卡看卡片上那行
function sideDataHtml(run, node, step) {
  if (kindOf(node) !== 'task') return '<p class="note">分岔不帶資料，只照流程判路</p>';
  if (node.executor === 'human') return '<p class="note">這步由你處理，不帶共用檔</p>';
  const sh = step.memory?.shared;
  const arr = (k) => (Array.isArray(sh?.[k]) ? sh[k] : []);
  let shared;
  if (!sh) shared = '<p class="note">這趟沒有共用檔紀錄</p>'; // 舊 run／還沒送出工作單的步
  else {
    const rows = [...arr('company').map((r) => ['公司規範', r]), ...arr('dept').map((r) => ['部門規範', r]), ...arr('refs').map((r) => [r.scope === 'company' ? '公司參考' : '部門參考', r])];
    const counts = [['公司規範', arr('company').length], ['部門規範', arr('dept').length], ['參考', arr('refs').length]].filter(([, k]) => k);
    shared = counts.length
      ? `<p class="sharedline">帶了${counts.map(([l, k]) => `${l} ${k} 份`).join('・')}</p><ul class="sharedwhich">${rows.map(([layer, r]) => `<li>${layer}・${esc(r.name)}${r.chars != null ? ` · ${fmtInt(r.chars)} 字` : ''}</li>`).join('')}</ul>`
      : '<p class="note">這步沒帶共用檔</p>';
  }
  return shared + sideSourceHtml(run, node);
}
// 來源一行：健檢（preflightFor，快取沒有就背景打一次、回來 patchPreflightDom 只補這一行）的 inputs[node]；讀不到就不佔位
function sideSourceHtml(run, node) {
  const pf = preflightFor(run.def);
  if (!pf) return preflightCache.failed && preflightCache.key === JSON.stringify(run.def) ? '' : '<p class="note" data-srcline>來源：檢查中⋯</p>';
  const list = (pf.inputs?.[node.id] ?? []).map(inputSourceText);
  return `<p class="note" data-srcline>來源：${list.length ? esc(list.join('、')) : '沒有指定輸入'}</p>`;
}

// 右欄：「目前這步」＋四格 <details>（開合狀態在 state.sideOpen，summary 走 side-toggle；重繪讀回）＋底部「當時指示」（U6b）
function sideInfoHtml(run) {
  const node = sideNodeOf(run);
  const step = run.steps?.[node.id] ?? {};
  const fold = (k, title, body) => `<details class="sidefold"${state.sideOpen?.[k] ? ' open' : ''}><summary data-act="side-toggle" data-k="${k}"><i class="ph ph-caret-down"></i>${title}</summary><div class="sidebody">${body}</div></details>`;
  // 監工交代：唯讀摘要（開場備註＋各步交接）；插話框留在卡片上
  let sup;
  if (run.def?.supervisor?.enabled === false) sup = '<p class="note">這條流程沒開監工</p>';
  else {
    const brief = String(run.brief?.text ?? '');
    const hands = run.def.nodes.filter((n) => run.steps?.[n.id]?.handoff?.text && !run.steps[n.id].handoff.only_route)
      .map((n) => `<p><b>${esc(n.title)}</b>：${esc(run.steps[n.id].handoff.text)}</p>`).join('');
    sup = (brief ? `<p><b>開場</b>：${esc(brief)}</p>` : '') + hands || '<p class="note">監工還沒交代什麼</p>';
  }
  const focus = node.review_focus ? `<p>${esc(node.review_focus)}</p>` : '<p class="note">沒設</p>';
  const REASON = { first: '第一次', retry: '重做', 'retry-note': '照你的話重做' }; // retry-note 的舊鈕名在 T6① 禁用表上，這裡用口語
  const when = (iso) => { const d = new Date(iso ?? ''); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' }); };
  const w = run.workflow ?? {};
  const attempts = Array.isArray(step.attempts) && step.attempts.length
    ? step.attempts.map((a) => `<div class="attempt"><span>${esc(when(a.at))}・${esc(REASON[a.reason] ?? a.reason ?? '')}</span>${checkChip({ check: a.check })}${a.file?.name ? fileChipHtml(w.category, w.id, run.run_id, a.file.name) : ''}</div>`).join('')
    : '<p class="note">還沒交過卷</p>';
  // 當時指示：AI 步＝n.txt、分岔＝n-判路.txt（同儀表板 dashStepRows 的卷宗名）；人做／還沒送出工作單的步沒卷宗，不印鈕
  const pname = kindOf(node) === 'branch' ? `${node.id}-判路.txt` : kindOf(node) === 'task' && node.executor === 'ai' ? `${node.id}.txt` : null;
  const promptBtn = pname && step.status && step.status !== 'pending'
    ? `<div class="sidefoot"><button class="btn sm2" data-act="run-prompt" data-pname="${esc(pname)}" data-ptitle="${esc(node.title ?? '')}"><i class="ph ph-scroll"></i>當時指示</button></div>` : '';
  return `<aside class="sideinfo"><h5>目前這步</h5><div class="curstep"><b>${esc(node.title ?? '')}</b>${stepPill(step)}</div>
    ${fold('sup', '監工交代', sup)}
    ${fold('data', '這步會用到的資料', sideDataHtml(run, node, step))}
    ${fold('focus', '驗收重點', focus)}
    ${fold('attempts', '每次交卷', attempts)}${promptBtn}</aside>`;
}

// 「當時指示」卷宗浮窗（U6b）：儀表板每步列與執行頁右欄共用同一張；掛 .layout 外（地雷 5）；view＝{title, text}
function promptModalHtml(view) {
  if (!view) return '';
  return `<div class="modalback" data-act="prompt-back"><div class="modal" style="max-width:680px">
      <div class="cvdhead"><b style="font-size:15px">當時送出的指示——${esc(view.title)}</b>
        <span class="btn btn-ghost iconb" data-act="prompt-close" style="margin-left:auto"><i class="ph ph-x"></i></span></div>
      <pre class="promptpre">${esc(view.text)}</pre>
      <div class="saverow"><button class="btn" data-act="prompt-close">關閉</button></div>
    </div></div>`;
}

// ---------- 儀表板（儀表板輪）：要你處理／系統通知／最近完成／用量監控 ----------
// 離開儀表板的唯一出口（照 closeCalendar 的教訓）：任何切去別的畫面的動作都要走這裡
function closeDash() {
  if (!state.dash) return;
  clearTimeout(state.dashPollTimer);
  state.dash = null;
}

async function loadDash() {
  const d = state.dash;
  if (!d) return;
  const [data, todos, notices, calendar] = await Promise.all([
    api('GET', '/api/dashboard?limit=12&days=30'),
    api('GET', '/api/todos'),
    api('GET', '/api/notices'),
    api('GET', `/api/calendar?month=${ymOf(new Date())}`).catch(() => null), // U5「接下來的安排」：讀不到＝null，那塊印一句，不擋儀表板
  ]);
  if (!state.dash) return; // 載入途中已離開
  d.data = data;
  d.calendar = calendar;
  state.todos = todos.items;
  applyNotices(notices);
}

function dashPoll() {
  clearTimeout(state.dashPollTimer);
  if (!state.dash) return;
  state.dashPollTimer = setTimeout(async () => {
    try {
      await loadDash();
      const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && document.activeElement.value;
      if (!typing && !state.preview && !state.dash?.usageOpen) render(); // 預覽／用量浮窗開著時不重繪（重繪會把浮窗捲回頂、pdf 重載）；關掉下一輪就補上
    } catch { /* 下一輪再試 */ }
    dashPoll();
  }, 5000);
}

// 待辦/通知動作後重載目前開著的頁面（儀表板或行事曆）
async function reloadPageData() {
  if (state.dash) await loadDash();
  else if (state.calendar) await loadCalendar();
}

// 待辦與通知的列（原行事曆側欄，儀表板輪搬家至此）；移植合併輪 U5：提議列拆去右欄「流程提議」（proposalRowsHtml），每列右側琥珀「等你」
const todoItems = () => state.todos.filter((t) => t.kind !== 'proposal');
function todoRowsHtml() {
  return todoItems().map((t) => {
    let actions = '';
    if (t.kind === 'google_shift') {
      actions = `<button class="btn sm2 btn-primary" data-act="todo-shift" data-do="follow" data-shift='${esc(JSON.stringify(t.shift))}'>跟著移</button>
        <button class="btn sm2" data-act="todo-shift" data-do="keep" data-shift='${esc(JSON.stringify(t.shift))}'>保持原時間</button>`;
    } else {
      actions = `<button class="btn sm2 btn-primary" data-act="todo-go" data-cat="${esc(t.run.category)}" data-id="${esc(t.run.id)}" data-rid="${esc(t.run.run_id)}">去處理</button>`;
    }
    return `<div class="item ${t.tone}"><div class="ti">${esc(t.title)}<span class="chip wait"><i class="ph ph-hand-palm"></i>等你</span></div><div class="de">${esc(t.desc)}</div><div class="acts">${actions}</div></div>`;
  }).join('');
}
function proposalRowsHtml() {
  return state.todos.filter((t) => t.kind === 'proposal').map((t) =>
    `<div class="item ${t.tone}"><div class="ti">${esc(t.title)}</div><div class="de">${esc(t.desc)}</div>
      <div class="acts"><button class="btn sm2 btn-primary" data-act="todo-open-wf" data-cat="${esc(t.workflow.category)}" data-id="${esc(t.workflow.id)}">去看提議</button></div></div>`).join('')
    || '<div class="railempty">沒有新提議</div>';
}
// 接下來的安排（U5）：本月行事曆裡還沒到的剝繭排程與等時刻步驟，前兩筆；Google 快照、錯過、已跳過、暫停不算（工程報備 7）
function upcomingHtml(d) {
  if (!d.calendar) return '<div class="railempty">讀不到接下來的安排</div>';
  const p = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const nowKey = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}`;
  const next = (d.calendar.events ?? []).filter((e) => ['auto', 'human', 'makeup'].includes(e.kind) && `${e.date}T${e.time}` >= nowKey).slice(0, 2);
  const rows = next.map((e) => `<div class="upcoming"><span class="uptime">${Number(e.date.slice(5, 7))}/${Number(e.date.slice(8, 10))} ${esc(e.time)}</span>
      <div class="upbody"><b>${esc(e.title)}</b><span class="meta">${e.kind === 'human' ? '你出面' : 'AI 自動'}</span></div></div>`).join('');
  return `${rows || '<div class="railempty">這個月沒有安排</div>'}
    <span class="pbtn" data-act="open-calendar"><i class="ph ph-calendar-blank"></i>查看行事曆</span>`;
}

function noticeSectionHtml() {
  const nRows = state.notices.unread.map((n) => {
    const btn = (a, label, primary) => `<button class="btn sm2 ${primary ? 'btn-primary' : ''}" data-act="notice-act" data-nid="${esc(n.id)}" data-do="${a}">${label}</button>`;
    const acts = [
      (n.actions ?? []).includes('makeup') ? btn('makeup', '補跑', 1) : '',
      (n.actions ?? []).includes('force-run') ? btn('force-run', '照跑一份', 1) : '',
      (n.actions ?? []).includes('retry') ? btn('retry', '重試', 1) : '',
      (n.actions ?? []).includes('skip') ? btn('skip', '跳過這次', 0) : '',
      btn('dismiss', '知道了', 0),
    ].join('');
    return `<div class="item ${n.type === 'reminder' ? 'warn' : 'err'}"><div class="ti">${esc(n.title)}</div><div class="de">${esc(n.desc ?? '')}</div><div class="acts">${acts}</div></div>`;
  }).join('');
  const doneRows = state.noticesOpen ? `<div class="donelist">${state.notices.done.map((n) =>
    `<div class="item"><div class="ti">${esc(n.title)}</div><div class="de">${esc(n.result ?? '')}・${new Date(n.resolved_at ?? n.created_at).toLocaleString('zh-TW', { hour12: false })}</div></div>`).join('') || '<div class="railempty">還沒有已處理的通知</div>'}</div>` : '';
  return `${nRows || '<div class="railempty">沒有新通知</div>'}
    <div class="donefold" data-act="notices-toggle-done"><i class="ph ph-caret-${state.noticesOpen ? 'up' : 'down'}"></i>已處理（${state.notices.done.length}）——點開回看</div>
    ${doneRows}`;
}

const fmtInt = (n) => Number(n ?? 0).toLocaleString('en-US');
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const wfNameOf = (cat, id) => state.workflows.find((w) => w.category === cat && w.id === id)?.name ?? `${cat}/${id}`;

// 最近完成卡（移植合併輪 U5 照 demo 三行版）：收合＝一列「名稱・膠囊・時間・打開・更多」；展開（key in state.dash.open，原機制）
// 才印 token 三膠囊、成品預覽、每步列與「當時指示」——功能一項不少，只是收進展開；整列標題也可點（rchead 帶 dash-expand，裡面的鈕先攔）
function dashRunCard(r) {
  const key = `${r.category}/${r.id}/${r.run_id}`;
  const chip = runStatusChip(r); // 移植合併輪 U4b：與流程頁「每次執行」同一張膠囊表
  const src = `${r.source === 'schedule' ? '排程自動' : '手動開跑'}${r.makeup ? '・補跑' : ''}`;
  const open = key in (state.dash.open ?? {});
  const ids = `data-key="${esc(key)}" data-cat="${esc(r.category)}" data-id="${esc(r.id)}" data-rid="${esc(r.run_id)}"`;
  let body = '';
  if (open) {
    const checkTok = (r.usage?.check?.input ?? 0) + (r.usage?.check?.output ?? 0);
    const supTok = (r.usage?.supervisor?.input ?? 0) + (r.usage?.supervisor?.output ?? 0);
    const usage = r.usage ? `<div class="rcchips"><span class="chip" title="輸入 ${fmtInt(r.usage.input)}／輸出 ${fmtInt(r.usage.output)} tokens">${fmtInt(r.usage.input + r.usage.output)} tokens</span>${checkTok ? `<span class="chip" title="其中交貨查核花掉的">查核 ${fmtInt(checkTok)} token</span>` : ''}${supTok ? `<span class="chip" title="其中監工花掉的">監工 ${fmtInt(supTok)} token</span>` : ''}</div>` : '';
    // 成品預覽走排版（產檔輪）；檔案 chip 點開預覽浮窗
    const finals = r.finals.map((f, i) => `<div class="final"><span class="ftitle"><i class="ph-fill ph-flag-checkered"></i> 成品・${esc(f.title)}${f.file ? `　${fileChipHtml(r.category, r.id, r.run_id, f.file)}` : ''}</span>
    ${mdBlock(`${f.preview}${f.preview.length >= 400 ? '⋯' : ''}`, `dash:${key}:${f.node ?? i}`, 'fprev')}</div>`).join('');
    body = `<div class="rcbody">${usage}${finals || (r.status === 'done' ? '<div class="railempty">這次執行沒有留下成品文字</div>' : '')}${dashStepRows(key)}</div>`;
  }
  return `<div class="runcard${open ? ' open' : ''}">
    <div class="rchead" data-act="dash-expand" ${ids}><b>${esc(r.name)}</b>${chip}
      <span class="rtime">${fmtWhen(r.finished_at ?? r.started_at)}・${src}・${r.steps.done}/${r.steps.total} 步</span>
      <span class="right">
        <button class="btn sm2 btn-primary" data-act="todo-go" data-cat="${esc(r.category)}" data-id="${esc(r.id)}" data-rid="${esc(r.run_id)}">打開</button>
        <button class="btn sm2" data-act="dash-expand" ${ids}>${open ? '收合' : '更多'}</button></span></div>
    ${body}
  </div>`;
}

function dashStepRows(key) {
  const o = state.dash.open[key];
  if (!o) return '<div class="railempty">讀取中⋯</div>';
  const STEP_TXT = {
    done: ['quiet', '完成'], failed: ['bad', '失敗'], skipped: ['quiet', '略過'], pending: ['quiet', '還沒跑'], running: ['quiet', '進行中'],
    waiting_review: ['wait', '等你過目'], waiting_human: ['wait', '等你做'], waiting_branch: ['wait', '等你選路'],
    waiting_data: ['wait', '等補資料'], waiting_time: ['quiet', '等時間到'], time_pending: ['wait', '時間未定'],
    waiting_check: ['wait', '查核攔下'],
  };
  const rows = topoNodes(o.run.def).filter((n) => !['fork', 'join'].includes(kindOf(n))).map((n) => {
    const s = o.run.steps?.[n.id] ?? {};
    const [tone, txt] = STEP_TXT[s.status] ?? ['', s.status ?? ''];
    const text = String(s.edited_output ?? s.output ?? s.error ?? '');
    const pname = (o.prompts ?? []).find((p) => p === `${n.id}.txt` || p === `${n.id}-判路.txt`);
    const pbtn = pname ? `<button class="btn sm2" data-act="dash-prompt" data-cat="${esc(o.cat)}" data-id="${esc(o.id)}" data-rid="${esc(o.rid)}" data-pname="${esc(pname)}" data-ptitle="${esc(n.title)}">當時指示</button>` : '';
    return `<div class="stepline"><span class="st ${tone}">${txt}</span><div style="flex:1;min-width:0"><b>${esc(n.title)}</b>${checkChip(s, o.run.usage_by_node?.[n.id]?.check)}
      ${text ? mdBlock(`${text.slice(0, 200)}${text.length > 200 ? '⋯' : ''}`, `dashstep:${key}:${n.id}`, 'sprev') : ''}</div>${pbtn}</div>`;
  }).join('');
  return `<div style="margin-top:var(--s2)">${rows}</div>`;
}

// 用量（U5）：帳本一筆的輸入 tokens（含快取兩桶）；日期鍵＝本機日期（表格與小圖同一把尺，晚上跑的不會被 UTC 切到隔天）
const usageIn = (u) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
const dayKey = (x) => { const d = new Date(x); const p = (n) => String(n).padStart(2, '0'); return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
// 近 30 天逐日小長條（純 SVG，30 根＝每日 輸入＋輸出，最右今天 accent、其餘灰、無軸）；large＝浮窗大圖
function usageChartHtml(entries, large = false) {
  const h = large ? 40 : 24;
  const days = Array.from({ length: 30 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (29 - i)); return dayKey(d); });
  const sum = Object.fromEntries(days.map((k) => [k, 0]));
  for (const u of entries ?? []) { const k = dayKey(u.at); if (k in sum) sum[k] += usageIn(u) + (u.output_tokens ?? 0); }
  const max = Math.max(1, ...days.map((k) => sum[k]));
  const rects = days.map((k, i) => {
    const bar = +(sum[k] / max * h).toFixed(1);
    return `<rect x="${i * 4}" y="${+(h - bar).toFixed(1)}" width="3" height="${bar}"${i === 29 ? ' class="today"' : ''}><title>${k}：${fmtInt(sum[k])} tokens</title></rect>`;
  }).join('');
  return `<svg class="usagechart${large ? ' large' : ''}" viewBox="0 0 120 ${h}" preserveAspectRatio="none" role="img" aria-label="近 30 天每日用量，今天 ${fmtInt(sum[days[29]])} tokens">${rects}</svg>`;
}
// 用量明細浮窗（U5；state.dash.usageOpen 驅動、掛在 promptModal 同一位置）：seg 按流程／按日（原鍵）＋按日大圖＋數字表
function usageModalHtml(d) {
  if (!d.usageOpen) return '';
  const seg = `<span class="seg sm">
    <span class="${d.usageView === 'flow' ? 'on' : ''}" data-act="dash-usage-view" data-view="flow">按流程</span>
    <span class="${d.usageView === 'day' ? 'on' : ''}" data-act="dash-usage-view" data-view="day">按日</span></span>`;
  return `<div class="modalback" data-act="dash-usage-back"><div class="modal usagemodal" role="dialog" aria-label="用量明細">
      <div class="cvdhead"><b style="font-size:15px"><i class="ph ph-chart-bar"></i> 用量明細</b>${seg}
        <span class="btn btn-ghost iconb" data-act="dash-usage-close" style="margin-left:auto" title="關閉（Esc）"><i class="ph ph-x"></i></span></div>
      ${d.usageView === 'day' ? `${usageChartHtml(d.data.usage, true)}<p class="note">30 根＝近 30 天，最右是今天。</p>` : ''}
      ${usageSectionHtml(d)}
      <div class="saverow"><button class="btn" data-act="dash-usage-close">關閉</button></div>
    </div></div>`;
}
// 用量數字表：近 30 天帳本，按流程或按日彙總（U5 起住在浮窗裡；seg 搬到浮窗標題列）
function usageSectionHtml(d) {
  const entries = d.data.usage ?? [];
  const KIND_TXT = { compose: '聊天建流程', scan: '匯入掃描', snapshot: 'Google 快照', optimize: '優化提議' };
  const inOf = usageIn;
  const tot = entries.reduce((a, u) => ({ calls: a.calls + 1, input: a.input + inOf(u), output: a.output + (u.output_tokens ?? 0), cost: a.cost + (u.cost_usd ?? 0) }), { calls: 0, input: 0, output: 0, cost: 0 });
  const groups = new Map();
  for (const u of entries) {
    const gk = d.usageView === 'day'
      ? dayKey(u.at)
      : (u.workflow ? wfNameOf(u.category, u.workflow) : (KIND_TXT[u.kind] ?? '其他'));
    const g = groups.get(gk) ?? { calls: 0, input: 0, output: 0, cost: 0 };
    g.calls += 1; g.input += inOf(u); g.output += u.output_tokens ?? 0; g.cost += u.cost_usd ?? 0;
    groups.set(gk, g);
  }
  const rows = [...groups.entries()]
    .sort((a, b) => (d.usageView === 'day' ? b[0].localeCompare(a[0]) : b[1].cost - a[1].cost))
    .map(([gk, g]) => `<tr><td>${esc(gk)}</td><td>${g.calls}</td><td>${fmtInt(g.input)}</td><td>${fmtInt(g.output)}</td><td>$${g.cost.toFixed(3)}</td></tr>`)
    .join('');
  return entries.length
    ? `<div class="sub" style="margin-bottom:var(--s2)">近 ${d.data.usage_days ?? 30} 天：呼叫 ${tot.calls} 次・輸入 ${fmtInt(tot.input)}・輸出 ${fmtInt(tot.output)} tokens・約 $${tot.cost.toFixed(2)} 美元</div>
      <table class="usagetbl"><thead><tr><th>${d.usageView === 'day' ? '日期' : '流程／用途'}</th><th>次數</th><th>輸入 tokens</th><th>輸出 tokens</th><th>花費</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="railempty">還沒有用量紀錄——這次改版之後跑的才會記帳，舊紀錄沒有數字</div>';
}

// 儀表板（移植合併輪 U5 照 demo home()）：左欄 要你處理＋最近完成（預設 3 張、查看全部）；右欄 接下來的安排／系統通知／流程提議／用量
function dashHtml() {
  const d = state.dash;
  if (!d.data) return '<div class="empty-c"><div class="skel" style="height:200px"></div></div>';
  const memRow = memExceptionRowHtml(); // 記憶輪（M4）：第一列＝記憶例外，算進「要你處理」的數
  const todoRows = memRow + todoRowsHtml();
  const todoCount = todoItems().length + (memRow ? 1 : 0); // 提議拆去右欄，數字跟著少（工程報備 8）
  const recent = d.data.recent;
  const cards = (d.showAll ? recent : recent.slice(0, 3)).map(dashRunCard).join('')
    || '<div class="railempty">還沒有任何執行紀錄——從左邊點開一條流程按「開始」</div>';
  const showAll = recent.length > 3 ? `<span class="pbtn" data-act="dash-show-all"><i class="ph ph-caret-${d.showAll ? 'up' : 'down'}"></i>${d.showAll ? '收起' : `查看全部（${recent.length}）`}</span>` : '';
  const entries = d.data.usage ?? [];
  const usageTot = entries.reduce((a, u) => a + usageIn(u) + (u.output_tokens ?? 0), 0);
  return `<div class="dashpage">
    <div class="dashhead"><h3 style="margin:0;font-size:17px;font-weight:800"><i class="ph ph-gauge"></i> 儀表板</h3>
      <span class="sub">任務有沒有正常進行，這一頁講完</span></div>
    <div class="homegrid">
    <section class="homemain">
      <section class="crs">
        <h4><i class="ph ph-check-square"></i>要你處理 <span class="cnt ${todoCount ? 'hot' : 'zero'}">${todoCount}</span></h4>
        <div class="crlist">${todoRows || '<div class="railempty">現在沒有等你的事</div>'}</div>
      </section>
      <section class="dashsec"><h4><i class="ph ph-flag-checkered"></i>最近完成${showAll ? `<span class="meta">${showAll}</span>` : ''}</h4>${cards}</section>
    </section>
    <aside class="homeaside">
      <section class="dashsec asideblock">
        <h4><i class="ph ph-calendar-blank"></i>接下來的安排</h4>${upcomingHtml(d)}
      </section>
      <section class="dashsec asideblock">
        <h4><i class="ph ph-bell"></i>系統通知 <span class="cnt ${state.notices.unread.length ? 'hotred' : 'zero'}">${state.notices.unread.length}</span></h4>
        <div class="crlist">${noticeSectionHtml()}</div>
      </section>
      <section class="dashsec asideblock">
        <h4><i class="ph ph-lightbulb"></i>流程提議</h4>${proposalRowsHtml()}
      </section>
      <section class="dashsec asideblock">
        <h4><i class="ph ph-chart-bar"></i>用量<span class="meta">近 ${d.data.usage_days ?? 30} 天</span></h4>
        ${usageChartHtml(entries)}
        ${entries.length ? `<div class="usagetot"><b>${fmtInt(usageTot)}</b> tokens・${entries.length} 次呼叫</div>` : '<div class="railempty">還沒有用量紀錄</div>'}
        <span class="pbtn" data-act="dash-usage-open"><i class="ph ph-list-numbers"></i>用量明細</span>
      </section>
    </aside>
    </div>
    ${usageModalHtml(d)}
  </div>`;
}

// ---------- 行事曆（D20）：月視圖＋待辦/通知＋單次抽屜＋浮窗 ----------
const CAL_KIND_TXT = { auto: 'AI 自動', human: '你出面', goog: 'Google', missed: '錯過', makeup: '補', skipped: '已跳過' };

function calMonthShift(month, delta) {
  const d = new Date(`${month}-01T00:00`);
  d.setMonth(d.getMonth() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function loadCalendar() {
  const c = state.calendar;
  if (!c) return;
  const [data, notices, scheds, cfg] = await Promise.all([
    api('GET', `/api/calendar?month=${c.month}`),
    api('GET', '/api/notices'), // 通知照抓：排程清單浮窗要標「設定有誤」＋側欄紅點
    api('GET', '/api/schedules'),
    api('GET', '/api/settings').catch(() => null), // 記憶輪（M5b）：新增排程視窗的初值讀設定的 exec；讀不到就用程式缺省
  ]);
  c.data = data;
  c.scheds = scheds;
  c.exec = cfg?.exec ?? null;
  applyNotices(notices);
}

// 桌面通知（US-036）：授權一次；新的未讀通知彈桌面
function applyNotices(n) {
  state.notices = n;
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    for (const x of n.unread) {
      if (seenNotices.has(x.id)) continue;
      seenNotices.add(x.id);
      try { new Notification(`剝繭：${x.title}`, { body: x.desc ?? '' }); } catch { /* 環境不支援就算了 */ }
    }
  } else {
    for (const x of n.unread) seenNotices.add(x.id);
  }
}

// 離開行事曆的唯一出口：任何切去別的畫面的動作都要走這裡（列管缺陷「open 未清 calendar 態」修正）
function closeCalendar() {
  if (!state.calendar) return;
  clearTimeout(state.calPollTimer);
  state.calendar = null;
  state.calDrawer = null;
  state.calDrawerDef = null;
  state.stepModal = null;
  state.schedModal = null;
  state.schedManage = false;
  state.calPicker = null;
}

// 快速跳月浮層（錨在標題列月份膠囊下方）：年份 ‹ › ／可直接打、3×4 月格（目前月高亮、今天所在月加小圓點）、底列「今天」
const ymOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
function calPickerHtml() {
  const pk = state.calPicker;
  if (!pk || !state.calendar) return '';
  const cur = state.calendar.month;
  const todayYM = ymOf(new Date());
  const cells = Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, '0');
    const ym = `${pk.year}-${m}`;
    return `<button class="pm ${ym === cur ? 'on' : ''} ${ym === todayYM ? 'now' : ''}" data-act="cal-pick-month" data-m="${m}" data-month="${ym}">${i + 1} 月</button>`;
  }).join('');
  return `<div class="calpicker" id="cal-picker" role="dialog" aria-label="快速跳月">
    <div class="pyear"><button type="button" data-act="cal-pick-year" data-delta="-1" aria-label="前一年">‹</button>
      <input id="cal-pick-year" class="pyin" inputmode="numeric" maxlength="4" value="${pk.year}" aria-label="年份">
      <button type="button" data-act="cal-pick-year" data-delta="1" aria-label="後一年">›</button></div>
    <div class="pgrid">${cells}</div>
    <div class="pfoot"><button class="btn sm2" data-act="cal-pick-today">今天</button></div>
  </div>`;
}
// 年份小輸入框邊打邊改：只補月格的目標月與高亮，不整頁重繪（重繪會洗掉輸入框游標）
function patchCalPickerGrid() {
  const pk = state.calPicker;
  if (!pk || !state.calendar) return;
  const todayYM = ymOf(new Date());
  for (const b of document.querySelectorAll('#cal-picker [data-act="cal-pick-month"]')) {
    const ym = `${pk.year}-${b.dataset.m}`;
    b.dataset.month = ym;
    b.classList.toggle('on', ym === state.calendar.month);
    b.classList.toggle('now', ym === todayYM);
  }
}

function calendarPoll() {
  clearTimeout(state.calPollTimer);
  if (!state.calendar) return;
  state.calPollTimer = setTimeout(async () => {
    try {
      await loadCalendar();
      const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && document.activeElement.value;
      if (!typing) render();
    } catch { /* 下一輪再試 */ }
    calendarPoll();
  }, 5000);
}

function calEvChip(e) {
  const dr = e.sid ? `draggable="true" data-sid="${esc(e.sid)}" data-occ="${esc(e.occ)}"` : '';
  const runAttrs = e.run ? `data-run-cat="${esc(e.run.category)}" data-run-id="${esc(e.run.id)}" data-run-rid="${esc(e.run.run_id)}"` : '';
  const del = e.sid && !['skipped'].includes(e.kind)
    ? `<button class="cevdel" data-act="cal-ev-del" data-sid="${esc(e.sid)}" data-occ="${esc(e.occ)}" data-title="${esc(e.title)}" title="取消這一次" aria-label="取消這一次"><i class="ph ph-trash"></i></button>` : '';
  const badge = { missed: '錯過', makeup: '補', skipped: '已跳過', paused: '已暫停' }[e.kind];
  return `<div class="cev ${e.kind}" data-act="cal-ev" data-kind="${e.kind}" ${dr} ${runAttrs} data-time="${esc(e.time)}" data-title="${esc(e.title)}">
    ${e.kind === 'human' ? '<i class="ph ph-user"></i> ' : ''}<span class="t">${esc(e.time)}${badge ? `・${badge}` : ''}</span> ${esc(e.title)}${del}</div>`;
}

function calendarHtml() {
  const c = state.calendar;
  if (!c.data) return '<div class="empty-c"><div class="skel" style="height:200px"></div></div>';
  const d0 = new Date(`${c.month}-01T00:00`);
  const first = new Date(d0);
  const dow = first.getDay() === 0 ? 7 : first.getDay();
  first.setDate(first.getDate() - (dow - 1)); // 週一起始
  const byDate = {};
  for (const e of c.data.events) (byDate[e.date] ??= []).push(e);
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(first);
    d.setDate(d.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dim = key.slice(0, 7) !== c.month;
    const today = key === c.data.today;
    const evs = (byDate[key] ?? []).map(calEvChip).join('');
    cells += `<div class="mcell ${dim ? 'dim' : ''} ${today ? 'today' : ''}" data-date="${key}"><span class="d">${d.getDate() === 1 ? `${d.getMonth() + 1}/` : ''}${d.getDate()}</span>${evs}</div>`;
  }
  const snap = c.data.snapshot;
  const snapNote = snap
    ? (snap.status === 'ok' ? `Google 快照：${new Date(snap.fetched_at).toLocaleString('zh-TW', { hour12: false })}` : 'Google 快照：抓不到')
    : 'Google 快照：還沒抓過';
  const snapErr = c.snapErr ? `<div class="alert red" style="margin-bottom:var(--s3)"><i class="ph ph-warning-circle"></i>
      Google 快照抓不到——${esc(c.snapErr)}。剝繭自己的排程不受影響，照常運作。
      <span class="btns" style="margin:0 0 0 auto"><button class="btn btn-primary" style="padding:6px 12px" data-act="cal-refresh">重試</button></span></div>` : '';
  return `<div class="calpage">
    <div class="calhead">
      <h3 style="margin:0;font-size:17px;font-weight:800"><i class="ph ph-calendar-blank"></i> 行事曆</h3>
      <span class="wknav"><button data-act="cal-prev" aria-label="上個月">‹</button><button class="cur" data-act="cal-pick" aria-haspopup="dialog" aria-expanded="${state.calPicker ? 'true' : 'false'}" title="點一下快速跳到別的年月">${c.month.replace('-', ' 年 ')} 月<i class="ph ph-caret-down"></i></button><button data-act="cal-next" aria-label="下個月">›</button>${calPickerHtml()}</span>
      <button class="btn sm2" data-act="cal-today">今天</button>
      <button class="btn sm2 btn-primary" data-act="cal-add-sched"><i class="ph ph-plus"></i>新增排程</button>
      <button class="btn sm2" data-act="cal-manage"><i class="ph ph-list-bullets"></i>排程清單${(state.calendar.scheds ?? []).length ? `（${state.calendar.scheds.length}）` : ''}</button>
      <span class="snapnote">${snapNote}<button class="btn sm2" data-act="cal-refresh"><i class="ph ph-arrows-clockwise"></i>重新整理</button></span>
    </div>
    <div class="callegend">
      <span><b style="background:var(--accent)"></b>AI 自動</span><span><b style="background:var(--violet)"></b>你出面</span>
      <span><b style="background:var(--ink-300)"></b>Google 快照（唯讀）</span><span><b style="background:var(--amber)"></b>補跑</span>
      <span><b style="background:var(--red)"></b>錯過</span><span><b class="dash"></b>已跳過</span>
      <span style="margin-left:auto;color:var(--ink-400)">拖拉事件=改那一次的時間｜滑過按垃圾桶=取消該次</span>
    </div>
    ${snapErr}
    <div class="calbody">
      <div class="calmain">
        <div class="mdays"><div>一</div><div>二</div><div>三</div><div>四</div><div>五</div><div>六</div><div>日</div></div>
        <div class="mgrid">${cells}</div>
      </div>
    </div>
    <div class="calfoot">
      <span>開機自動啟動搬到「設定→執行與排程」。剝繭沒開著時排程不會跑；錯過的會在下次打開時問你要不要補。</span>
      <button class="btn sm2" data-act="open-settings-exec"><i class="ph ph-gear"></i>去設定</button>
    </div>
  </div>`;
}

// 單次抽屜（點行事曆事件）：這一次的動作＋提醒＋該排程的步驟清單
function calDrawerHtml() {
  const d = state.calDrawer;
  if (!d) return '';
  if (d.kind === 'goog') {
    return `<div class="cvdrawer" style="z-index:9">
      <div class="cvdhead"><span class="overline">Google 行程（唯讀快照）</span>
        <span class="btn btn-ghost iconb" data-act="cal-drawer-close"><i class="ph ph-x"></i></span></div>
      <h3 style="margin:6px 0">${esc(d.title)}</h3><div class="sub">${esc(d.time)}</div>
      <p class="note">這是你 Google 行事曆的快照，剝繭不能改它——要改請到 Google 行事曆，改完按「重新整理」。</p>
      <div class="saverow"><button class="btn" data-act="cal-refresh">重新整理快照</button></div>
    </div>`;
  }
  const sched = (state.calendar?.scheds ?? []).find((s) => s.id === d.sid);
  if (!sched) return '';
  const chips = (sched.remind_leads ?? []).map((l, i) => {
    const label = typeof l === 'string' ? ({ '10m': '10 分鐘前', '30m': '30 分鐘前', '1h': '1 小時前', '2h': '2 小時前', '3h': '3 小時前', '6h': '6 小時前', '12h': '12 小時前', '1d': '1 天前', '2d': '2 天前' }[l] ?? l) : `自訂：${l.at}`;
    return `<span class="rchip">${esc(label)}<button data-act="cal-lead-del" data-i="${i}" aria-label="移除">✕</button></span>`;
  }).join('');
  const steps = (state.calDrawerDef?.nodes ?? []).map((n) => `
    <div class="steprow" data-act="cal-step" data-node="${esc(n.id)}">
      <span class="who ${n.executor === 'human' ? 'hu' : 'ai'}">${n.executor === 'human' ? '你' : 'AI'}</span>
      <span class="nm">${esc(n.title)}</span>
      <span class="meta">${n.wait_until ? (typeof n.wait_until === 'object' ? '時間由上游決定' : esc(n.wait_until)) : ''}</span>
      <i class="ph ph-caret-right" style="color:var(--ink-300)"></i></div>`).join('');
  return `<div class="cvdrawer" style="z-index:9">
    <div class="cvdhead"><span class="overline">這一次</span>
      <span class="btn iconb" data-act="cal-run-now" title="現在就跑" style="color:var(--accent-text);background:rgb(var(--accent-rgb)/.12)"><i class="ph-fill ph-play"></i></span>
      <span class="btn btn-ghost iconb" data-act="cal-drawer-close"><i class="ph ph-x"></i></span></div>
    <h3 style="margin:6px 0">${esc(sched.name)}</h3><div class="sub">${esc(d.occ ? d.occ.replace('T', ' ') : '')}${sched.enabled === false ? '・<b style="color:var(--amber-text)">已暫停</b>' : ''}</div>
    <div class="frow2"><span class="lb2">提前提醒</span><span class="rchips">${chips}<button class="raddbtn" data-act="cal-lead-add">＋ 加一次提醒</button></span></div>
    <p class="note">改這次時間＝直接在行事曆上把它拖到別格；取消這一次＝滑過事件按垃圾桶。</p>
    <div class="overline" style="margin-top:var(--s3)">這個排程的步驟（點一步進去調）</div>
    ${steps || '<p class="note">讀取步驟中⋯</p>'}
    <div class="saverow" style="margin-top:var(--s3)">
      <button class="btn" data-act="cal-open-sched-setting">整條排程設定</button>
      <button class="btn" data-act="cal-pause">${sched.enabled === false ? '恢復排程' : '暫停整條排程'}</button>
    </div>
  </div>`;
}

// 排程頻率的人話摘要（排程清單用）
function schedFreqText(s) {
  if (s.freq === 'daily') return `每天 ${s.time}`;
  if (s.freq === 'weekly') return `每週${['', '一', '二', '三', '四', '五', '六', '日'][s.weekday] ?? '?'} ${s.time}`;
  if (s.freq === 'monthly') return `每月 ${s.day} 日 ${s.time}`;
  if (s.freq === 'once') return `單次 ${String(s.at ?? '').replace('T', ' ')}`;
  return '（頻率不明）';
}

// 浮窗：步驟設定（點抽屜步驟）＋排程設定（新增/整條共用）＋排程清單（管理入口，健檢 M3）
function calModalsHtml() {
  let html = '';
  if (state.schedManage) {
    const broken = new Set(state.notices.unread.filter((n) => n.type === 'invalid_schedule').map((n) => n.schedule_id));
    const rows = (state.calendar?.scheds ?? []).map((s) => {
      const st = broken.has(s.id)
        ? '<span class="chip red">設定有誤</span>'
        : (s.enabled === false ? '<span class="chip amber">已暫停</span>' : '<span class="chip">啟用中</span>');
      return `<div class="steprow" style="cursor:default">
        <span class="nm">${esc(s.name ?? s.workflow_id)}</span>
        <span class="meta">${esc(schedFreqText(s))}</span>${st}
        <button class="btn sm2" data-act="smgr-toggle" data-sid="${esc(s.id)}">${s.enabled === false ? '啟用' : '暫停'}</button>
        <button class="btn sm2 btn-primary" data-act="smgr-edit" data-sid="${esc(s.id)}">設定</button>
      </div>`;
    }).join('');
    html += `<div class="modalback" data-act="smgr-back"><div class="modal">
      <div class="cvdhead"><b style="font-size:15px">排程清單</b>
        <span class="btn btn-ghost iconb" data-act="smgr-close" style="margin-left:auto"><i class="ph ph-x"></i></span></div>
      <p class="note" style="margin:0 0 6px">所有排程都在這裡——包含已暫停、過期、或本月沒有場次的（月曆上看不到的也能從這裡進設定）。</p>
      ${rows || '<div class="railempty">還沒有任何排程</div>'}
      <div class="saverow"><button class="btn" data-act="smgr-close">關閉</button></div>
    </div></div>`;
  }
  if (state.stepModal) {
    const n = (state.calDrawerDef?.nodes ?? []).find((x) => x.id === state.stepModal.nodeId);
    if (n) {
      // 表單暫存（T3）：第一次打開才從步驟初始化，之後每個欄位一改就寫進 form，calendarPoll 重繪照 form 還原
      const f = (state.stepModal.form ??= { instruction: n.instruction ?? '', review: n.review_focus ?? '', tier: n.model_tier ?? '', retry: String(n.retry ?? 0) });
      html += `<div class="modalback" data-act="sm-back"><div class="modal">
        <div class="cvdhead"><span class="who ${n.executor === 'human' ? 'hu' : 'ai'}">${n.executor === 'human' ? '你' : 'AI'}</span>
          <b style="font-size:15px">${esc(n.title)}</b>
          <span class="btn btn-ghost iconb" data-act="sm-close" style="margin-left:auto"><i class="ph ph-x"></i></span></div>
        <div class="flabel" style="margin-top:0">任務指示</div>
        <textarea id="sm-instruction" class="output-edit" style="min-height:80px">${esc(f.instruction)}</textarea>
        ${n.wait_until ? `<div class="frow2"><span class="lb2">執行時刻</span><span class="pchip">${typeof n.wait_until === 'object' ? `由「${esc((state.calDrawerDef.nodes.find((x) => x.id === n.wait_until.from) ?? {}).title ?? n.wait_until.from)}」的結果決定` : esc(n.wait_until)}</span></div>` : ''}
        <div class="frow2"><span class="lb2">驗收重點</span><input id="sm-review" class="notein" style="margin:0;flex:1" value="${esc(f.review)}" placeholder="停點卡會顯示，AI 交件前自檢"></div>
        <div class="frow2"><span class="lb2">模型檔位</span><select id="sm-tier" class="moveselect">
          <option value="">預設</option><option value="fast" ${f.tier === 'fast' ? 'selected' : ''}>快而省</option>
          <option value="balanced" ${f.tier === 'balanced' ? 'selected' : ''}>均衡</option>
          <option value="deep" ${f.tier === 'deep' ? 'selected' : ''}>深而慢</option></select>
          <span class="lb2" style="width:auto">出錯重試</span><select id="sm-retry" class="moveselect">
          <option value="0" ${f.retry === '0' ? 'selected' : ''}>不重試</option><option value="1" ${f.retry === '1' ? 'selected' : ''}>1 次</option><option value="2" ${f.retry === '2' ? 'selected' : ''}>2 次</option></select></div>
        <div class="saverow"><button class="btn" data-act="sm-close">關閉</button><button class="btn btn-primary" data-act="sm-save">儲存</button></div>
      </div></div>`;
    }
  }
  if (state.schedModal) {
    const m = state.schedModal;
    const sched = m.sid ? (state.calendar?.scheds ?? []).find((s) => s.id === m.sid) : null;
    // 表單暫存（T3）：form 是唯一真相——第一次打開才從排程既有值／預設值初始化，之後每個欄位 input/change 即寫入，
    // calendarPoll 的重繪照 form 還原，慢慢填也不會被打回
    const f = (m.form ??= {
      wf: sched?.workflow_id ?? (state.workflows[0] ? `${state.workflows[0].category}/${state.workflows[0].id}` : ''),
      freq: sched?.freq ?? 'weekly',
      weekday: String(sched?.weekday ?? 1),
      day: String(sched?.day ?? 1),
      time: sched?.time ?? '08:00',
      at: sched?.at ?? '',
      // 新增的初值讀設定→執行與排程的預設（記憶輪 M5b）；編輯讀那條排程自己的
      lead: sched ? (typeof (sched.remind_leads ?? [])[0] === 'string' ? sched.remind_leads[0] : '') : execLead0(),
      makeup: sched ? !!sched.auto_makeup : state.calendar?.exec?.auto_makeup === true,
      enabled: sched?.enabled !== false,
    });
    const execMore = !sched && (state.calendar?.exec?.remind_leads ?? []).length > 1 ? (state.calendar.exec.remind_leads.length - 1) : 0;
    const wfOptions = state.workflows.map((w) => {
      const v = `${w.category}/${w.id}`;
      return `<option value="${esc(v)}" ${f.wf === v ? 'selected' : ''}>${esc(w.name)}（${esc(w.category)}）</option>`;
    }).join('');
    // 頻率決定哪些欄位露出：每週=星期、每月=幾號、每天=只有時刻、單次=只有單次時刻
    const show = { weekday: f.freq === 'weekly', day: f.freq === 'monthly', time: f.freq !== 'once', at: f.freq === 'once' };
    html += `<div class="modalback" data-act="sc-back"><div class="modal">
      <div class="cvdhead"><b style="font-size:15px">${sched ? '整條排程設定' : '新增排程'}</b>
        <span class="btn btn-ghost iconb" data-act="sc-close" style="margin-left:auto"><i class="ph ph-x"></i></span></div>
      <div class="frow2"><span class="lb2">流程</span><select id="sc-wf" class="moveselect" ${sched ? 'disabled' : ''}>${wfOptions}</select></div>
      <div class="frow2"><span class="lb2">頻率</span><select id="sc-freq" class="moveselect">
        <option value="weekly" ${f.freq === 'weekly' ? 'selected' : ''}>每週</option><option value="daily" ${f.freq === 'daily' ? 'selected' : ''}>每天</option>
        <option value="monthly" ${f.freq === 'monthly' ? 'selected' : ''}>每月</option><option value="once" ${f.freq === 'once' ? 'selected' : ''}>單次</option></select>
        <select id="sc-weekday" class="moveselect" ${show.weekday ? '' : 'hidden'}>${['一', '二', '三', '四', '五', '六', '日'].map((w, i) =>
          `<option value="${i + 1}" ${f.weekday === String(i + 1) ? 'selected' : ''}>週${w}</option>`).join('')}</select>
        <select id="sc-day" class="moveselect" ${show.day ? '' : 'hidden'}>${Array.from({ length: 31 }, (_, i) =>
          `<option value="${i + 1}" ${f.day === String(i + 1) ? 'selected' : ''}>${i + 1} 號</option>`).join('')}</select>
        <input id="sc-time" class="notein" style="margin:0;width:80px" value="${esc(f.time)}" placeholder="08:00" ${show.time ? '' : 'hidden'}>
      </div>
      <div class="frow2" ${show.at ? '' : 'hidden'}><span class="lb2">單次時刻</span><input id="sc-at" class="notein" style="margin:0;flex:1" value="${esc(f.at)}" placeholder="例：2026-08-30T15:00"></div>
      <div class="frow2"><span class="lb2">提前提醒</span><select id="sc-lead" class="moveselect">
        <option value="">先不提醒</option>
        ${['10m|10 分鐘前', '30m|30 分鐘前', '1h|1 小時前', '2h|2 小時前', '3h|3 小時前', '6h|6 小時前', '12h|12 小時前', '1d|1 天前', '2d|2 天前'].map((o) => {
    const [v, t] = o.split('|');
    return `<option value="${v}" ${f.lead === v ? 'selected' : ''}>${t}</option>`;
  }).join('')}</select>
        <span style="font-size:11.5px;color:var(--ink-400)">${execMore ? `設定裡的預設還有 ${execMore} 個提醒點，這一格不改就一起帶上；` : ''}要加更多或自訂時刻，建立後點事件開抽屜</span></div>
      <div class="frow2"><span class="lb2">錯過時</span><label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px">
        <input type="checkbox" id="sc-makeup" ${f.makeup ? 'checked' : ''}>自動補（不勾＝先詢問）</label></div>
      <div class="frow2"><span class="lb2">狀態</span><label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px">
        <input type="checkbox" id="sc-enabled" ${f.enabled ? 'checked' : ''}>啟用中（取消勾選＝暫停整條排程）</label></div>
      <p class="note">提前提醒在點開單次事件的抽屜裡設定；建立後會直接出現在行事曆上。</p>
      <div class="saverow"><button class="btn" data-act="sc-close">取消</button><button class="btn btn-primary" data-act="sc-save">${sched ? '儲存' : '建立排程'}</button></div>
    </div></div>`;
  }
  return html;
}

// ---------- 群組圈分類頁（記憶輪 M1c）：側欄分類標題點開——「分類守則」文字框＋拆好的條＋分類共用幾張習慣卡 ----------
// 離開分類頁的唯一出口（同 closeDash／closeCalendar）：任何切去別的畫面的動作都要走這裡
function closeCategory() {
  if (!state.categoryPage) return;
  clearTimeout(state.categoryPage.msgTimer);
  state.categoryPage = null;
  state.sharedUpload = null;
  delete state.keep[keepKey('group-text')];
}
const sharedPath = (scope) => `/api/shared/${encodeURIComponent(scope)}/files`;

async function loadCategoryPage() {
  const cp = state.categoryPage;
  if (!cp) return;
  // 移植合併輪 U2b（覆核該修）：群組圈＋習慣卡（cp.data／cp.err）與共用檔（cp.shared／cp.sharedErr）各自容錯——一方讀不到不蓋另一方
  const company = cp.category === '_company'; // U2a：公司頁＝分類頁特例，沒有群組圈也沒有分類層習慣卡，只抓公司層共用檔
  const settle = (p) => p.then((value) => ({ value }), (err) => ({ err }));
  const [shared, group] = await Promise.all([
    settle(api('GET', sharedPath(cp.category))),
    company ? null : settle(Promise.all([
      api('GET', `/api/memory/groups/${encodeURIComponent(cp.category)}`),
      api('GET', '/api/memory/cards?bucket=habit'),
    ])),
  ]);
  if (state.categoryPage !== cp) return; // 讀到一半已切走
  cp.shared = shared.err ? null : shared.value;
  cp.sharedErr = shared.err ? shared.err.message : null;
  if (company) {
    cp.data = null;
    cp.cards = [];
    cp.err = null;
    return;
  }
  if (group.err) {
    cp.err = group.err.message;
    return;
  }
  const [g, habits] = group.value;
  cp.data = g;
  cp.cards = habits.filter((c) => c.status === 'active' && c.scope?.level === 'category' && c.scope?.category === cp.category);
  cp.err = null;
}

// ---------- 記憶輪（M2）：首次三題介紹、一行通知 ----------
// 三題（順序與層級跟後端 INTRO_QUESTIONS 一致）：前兩題按場合帶、第三題每步帶。答案原文就是卡的內容
const INTRO_QUESTIONS = [
  { key: 'who', label: '你是誰、做什麼', ex: '例：小公司負責人，看不懂程式，要用比喻講', layer: 'content' },
  { key: 'audience', label: '你做出來的東西通常給誰看', ex: '例：大多給主管或客戶看，偶爾自己用', layer: 'content' },
  { key: 'dislike', label: '你最受不了什麼', ex: '例：長篇鋪陳、看不懂的術語', layer: 'expression' },
];
const introInputId = (key) => `intro-${key}`;
const introAnswers = () => Object.fromEntries(INTRO_QUESTIONS.map((q) => [q.key, (kept(introInputId(q.key)) ?? document.getElementById(introInputId(q.key))?.value ?? '').trim()]));

function introHtml() {
  const it = state.intro;
  const rows = INTRO_QUESTIONS.map((q) => `<div class="q"><div class="flabel">${q.label}</div><div class="ex">${esc(q.ex)}</div>
      <input id="${introInputId(q.key)}" data-keep value="${esc(kept(introInputId(q.key)) ?? '')}" ${it.saving ? 'disabled' : ''}></div>`).join('');
  const willbe = INTRO_QUESTIONS.map((q) => `<li><span class="chip ${q.layer === 'expression' ? 'violet' : 'blue'}">${q.layer === 'expression' ? '每步帶' : '按場合帶'}</span><span>${q.label}</span></li>`).join('');
  return `<div class="intro">
    <div class="overline">第一次打開</div>
    <h3>先讓它認識你，三題，可以跳過</h3>
    <div class="sub">答了直接成三張「認識卡」，之後每次拆流程、每一步指示都帶著。之後在設定的記憶頁隨時可以改、可以刪，不會再問你一次。</div>
    ${rows}
    <div class="willbe"><div class="overline">會記成</div><ul>${willbe}</ul></div>
    <p class="note">健康、政治、宗教、財務這四類它不會記，除非你在設定裡打開。</p>
    <div class="btns" style="margin-top:14px;align-items:center">
      <button class="btn btn-primary" data-act="intro-save" ${it.saving ? 'disabled' : ''}><i class="ph ph-check"></i>${it.saving ? '記著⋯' : '儲存'}</button>
      <button class="btn btn-ghost" data-act="intro-skip" ${it.saving ? 'disabled' : ''}>先略過</button>
      ${it.err ? `<span class="note" style="margin:0;color:var(--red-text)">${esc(it.err)}</span>` : ''}
    </div>
  </div>`;
}

// 一行通知（run 頁頂、跑完回饋回覆、聊天氣泡下共用）：card＝「記下來了：… 不要記」可撤；撤了或其他種類＝灰字無鈕。
// where：'run'＝撤回時帶這一趟（該趟通知標 undone）；'chat'＝沒有趟，只丟卡
function memNoticeLine(n, { where, idx = 0 } = {}) {
  if (!n) return '';
  if (n.kind === 'card' && n.undone) return `<div class="memnotice off"><i class="ph ph-arrow-u-up-left"></i><span>不記了：${esc(n.text)}</span></div>`;
  if (n.kind === 'card') {
    const busy = state.memUndoing[n.card];
    return `<div class="memnotice"><i class="ph ph-cards"></i><span>記下來了：${esc(n.text)}</span>
      <span class="lnk ${busy ? 'busy' : ''}" data-act="${where === 'chat' ? 'mem-undo-chat' : 'mem-undo'}" data-card="${esc(n.card)}" data-idx="${idx}">${busy ? '收回中⋯' : '不要記'}</span></div>`;
  }
  const icon = n.kind === 'fail' ? 'ph-warning-circle' : n.kind === 'widen' ? 'ph-arrows-out-line-horizontal' : 'ph-info';
  return `<div class="memnotice off"><i class="ph ${icon}"></i><span>${esc(n.text)}</span></div>`;
}
const memoryNoticeHtml = (run) => ((run.memory?.notices ?? []).length
  ? `<div class="memnotices">${run.memory.notices.map((n, i) => memNoticeLine(n, { where: 'run', idx: i })).join('')}</div>` : '');

// 跑完頁「回來丟一句結果」送出後的回覆：照通知種類講記成什麼／沒記成什麼。「不要記」在頁頂那一行（送出後會重抓 run），這裡不重複放
function feedbackReplyHtml(n) {
  const lead = !n || n === true ? '收到。' : n.kind === 'card' ? `收到，記成卡了：${esc(n.text)}` : `收到。${esc(n.text)}`;
  return `<div class="card proposal"><b>${lead}</b><span class="sub" style="margin:0"> 它也會想想怎麼學起來——之後打開這個流程就會看到提議。${n && n.kind === 'card' ? '不想記的話，頁面最上面那一行按「不要記」。' : ''}</span></div>`;
}

// ---------- 移植合併輪 U2b：公司頁／部門頁的共用檔兩區——規範（每步都帶）／參考（勾了才帶）；每檔一列 檔名・字數（二進位印 KB）・時間・刪除 ----------
// 字數：規範與 md／txt 參考有 chars；docx／xlsx 等二進位參考 chars 為 null → 只印大小
const sharedWhen = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const sharedSizeText = (f) => (f.chars != null ? `${fmtInt(f.chars)} 字` : `${Math.max(1, Math.ceil((f.bytes ?? 0) / 1024))} KB`);
function sharedSectionHtml(cp, kind) {
  const rule = kind === 'rule';
  const sh = cp.shared;
  const list = sh ? (rule ? sh.rules : sh.refs) ?? [] : null;
  const rows = (list ?? []).map((f) => `<div class="sharedrow"><i class="ph ${rule ? 'ph-file-text' : 'ph-file'}"></i><span class="wfname" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="meta">${sharedSizeText(f)}・${esc(sharedWhen(f.uploaded_at))}</span>
      <i class="ph ph-trash wfdel2" data-act="shared-del" data-kind="${kind}" data-name="${esc(f.name)}" title="刪掉這份（不進垃圾桶）"></i></div>`).join('');
  // 共用檔那支讀不到：只有這兩區印一句＋重試（走 reload-category 整頁重讀），分類守則框照常
  const body = cp.sharedErr ? `<p class="note err" role="alert">共用檔讀不到：${esc(cp.sharedErr)}</p><span class="pbtn" data-act="reload-category"><i class="ph ph-arrow-clockwise"></i>重試</span>`
    : !list ? '<p class="note">讀取中⋯</p>'
    : rows || `<p class="note">${rule ? '還沒有規範。放進來的內容，AI 每一步都照著。' : '還沒有參考。步驟裡勾了才給 AI。'}</p>`;
  return `<div class="params sharedsec" data-shared-kind="${kind}"><h5>${rule ? '規範（每步都帶）' : '參考（勾了才帶）'}
      ${rule ? `<span class="meta">本層已 ${fmtInt(sh?.rule_chars ?? 0)}／${fmtInt(sh?.limits?.per_layer ?? 8000)} 字</span>` : ''}
      <span class="pbtn" data-act="shared-upload" data-kind="${kind}"><i class="ph ph-upload-simple"></i>上傳</span></h5>
    ${cp.uploadErr?.kind === kind ? `<p class="note err" role="alert">${esc(cp.uploadErr.text)}</p>` : ''}
    ${body}
    ${cp.msg?.kind === kind ? `<p class="note ok">${esc(cp.msg.text)}</p>` : ''}
  </div>`;
}
// 部門頁最下面：該分類的流程卡（與流程庫同一張卡）
function sharedFlowsHtml(category) {
  const list = (state.workflows ?? []).filter((w) => w.category === category);
  return `<div class="sharedflows"><h5>流程 ${list.length}</h5>
    <div class="libgrid">${flowCardsHtml(list) || '<p class="note" style="margin:0">這個部門還沒有流程。</p>'}</div></div>`;
}

function categoryPageHtml() {
  const cp = state.categoryPage;
  const company = cp.category === '_company'; // 移植合併輪 U2a：公司頁＝分類頁特例（標題＝公司名，沒有分類守則框、沒有流程區）
  const head = company
    ? `<div class="tophead"><h3>${esc(companyName())}</h3><span class="chip"><i class="ph ph-buildings"></i>公司</span>
      <span class="backb" style="margin-left:auto" data-act="close-category"><i class="ph ph-caret-left"></i>回工作區</span></div>
    <div class="sub">全公司共用的規範與參考放這裡；改名在 設定→資料。</div>`
    : `<div class="tophead"><h3>${esc(cp.category)}</h3><span class="chip"><i class="ph ph-folder"></i>分類</span>
      <span class="backb" style="margin-left:auto" data-act="close-category"><i class="ph ph-caret-left"></i>回工作區</span></div>
    <div class="sub">這個分類的規矩：寫在這裡的，這類流程每一條、每一步都會帶著，交貨查核也會對。</div>`;
  const sharedSecs = sharedSectionHtml(cp, 'rule') + sharedSectionHtml(cp, 'ref');
  if (company) return `${head}<div class="catpage" data-company-page>${sharedSecs}</div>`;
  // 群組圈讀不到／讀取中：只換掉守則兩格，共用檔兩區與流程卡照常（U2b 覆核該修）
  if (cp.err) {
    return `${head}<div class="catpage"><div class="card err" style="grid-column:1/-1"><h3><i class="ph-fill ph-warning"></i> 這個分類的規矩讀不到</h3>
      <p class="sub" style="margin:8px 0">${esc(cp.err)}</p>
      <div class="btns"><button class="btn btn-secondary" data-act="reload-category">再讀一次</button></div></div>
      ${sharedSecs}
      ${sharedFlowsHtml(cp.category)}
    </div>`;
  }
  if (!cp.data) return `${head}<div class="empty-c"><div class="ic"><i class="ph ph-circle-notch"></i></div><h3>讀取中⋯</h3></div>`;
  const rules = cp.data.rules.filter((r) => r.status === 'active');
  const ruleRows = rules.map((r) => (r.field
    ? `<li><span class="chip gfield">${esc(r.field)}</span><span class="gval">${esc(r.value)}</span></li>`
    : `<li><i class="ph ph-dot-outline"></i><span>${esc(r.text)}</span></li>`)).join('');
  const text = kept('group-text') ?? cp.data.text ?? '';
  return `${head}<div class="catpage">
      <div class="params"><h5>分類守則（一行一條）</h5>
        <textarea id="group-text" class="feedbackin autogrow" data-keep placeholder="例：&#10;語氣：輕鬆&#10;不提競品">${esc(text)}</textarea>
        <div class="btns" style="margin-top:var(--s3);align-items:center">
          <button class="btn btn-primary" data-act="save-group" ${cp.saving ? 'disabled' : ''}><i class="ph ph-check"></i>${cp.saving ? '存檔中⋯' : '存'}</button>
          ${cp.saveErr ? `<span class="note" style="margin:0;color:var(--red-text)">${esc(cp.saveErr)}</span>` : ''}
        </div>
        <p class="note">有名字的欄位寫「欄位：值」（像「語氣：輕鬆」），其他一行一條。${cp.data.updated_at ? `上次存：${esc(new Date(cp.data.updated_at).toLocaleString('zh-TW'))}。` : '還沒存過。'}</p>
      </div>
      <div class="params"><h5>拆好的規矩 · ${rules.length} 條</h5>
        ${ruleRows ? `<ul class="grules">${ruleRows}</ul>` : '<p class="note" style="margin:0">還沒有。左邊寫幾條存起來，這裡會拆成一條一條。</p>'}
        <p class="note"><i class="ph ph-cards"></i> 這個分類共用 ${cp.cards.length} 張習慣卡</p>
      </div>
      ${sharedSecs}
      ${sharedFlowsHtml(cp.category)}
    </div>`;
}

// ---------- 記憶輪（M5a）：設定頁——整頁模式（同儀表板／行事曆），左導覽六組＋右子分頁；本段只做「記憶」「素材庫」，其餘四組佔位 ----------
const SET_GROUPS = [['記憶', 'ph-cards'], ['素材庫', 'ph-user'], ['連線', 'ph-plugs'], ['新流程的預設', 'ph-sliders-horizontal'], ['執行與排程', 'ph-clock'], ['資料', 'ph-database']];
const SET_TABS = {
  記憶: ['記憶總覽', '關於你', '連接器與金鑰'], 素材庫: ['角色情境', '常用片段'], 連線: ['Claude', 'Google 行事曆'],
  新流程的預設: ['權限與查核', 'AI 步驟', '停點'], 執行與排程: ['常駐', '排程', 'AI 工人'], 資料: ['位置與備份', '清理', '關於'],
};
const SET_LEAD = {
  記憶: '它記得你的，都在這裡。平常不用進來。', 素材庫: '各流程一鍵帶入的東西。', 連線: '剝繭不自帶 AI，掛在你自己的 Claude 上；行事曆用你自己的 Google 授權。',
  新流程的預設: '只管「新建的流程長什麼樣」。每條流程自己的開關留在流程頁。', 執行與排程: '剝繭什麼時候在、錯過了怎麼辦、AI 工人能做什麼。', 資料: '資料在哪、備份、清理。',
};
const FIELD_KIND_TXT = { appearance: '產出的樣子', audience: '對象', time: '時間', range: '範圍', limits: '資源與限制', method: '做法' }; // 與後端 FIELD_KINDS 同一份
const SENSITIVE_TXT = { health: '健康', politics: '政治', religion: '宗教', finance: '財務' }; // 與後端 SENSITIVE_LABELS 同一份
const setTab = (g) => state.settings?.tab?.[g] ?? SET_TABS[g][0];

// 離開設定頁的唯一出口（照 closeDash／closeCalendar 的規矩）：任何切去別的畫面的動作都要走這裡
function closeSettings() {
  if (!state.settings) return;
  state.settings = null;
  delete state.keep[keepKey('mem-replace-text')];
}
async function openSettings(group = '記憶', tab = null) {
  if (canvasLeaveBlocked()) return;
  clearTimeout(state.pollTimer);
  closeCalendar();
  closeDash();
  closeCategory();
  closeLibrary();
  state.run = null;
  state.showTrash = false;
  state.corrupt = null;
  state.importPreview = null;
  state.drawerOpen = false;
  state.settings = { group, tab: tab ? { [group]: tab } : {}, data: null, err: null, idEdit: null, presetEdit: null, merge: null, confirm: null, msg: null, busy: null };
  render();
  await loadSettings();
  render();
}
// 六組要的資料一次抓齊；讀到一半已離開就不寫。identities／presets 也同步到全域（開跑表單的下拉、抽屜的常用列讀它們）；
// 後四組（M5b）：開機自啟、備份清單、兩個垃圾桶（流程＋卡）、Google 快照時間——讀不到的（autostart／backup／calendar）當沒有，不擋整頁
async function loadSettings() {
  const s = state.settings;
  if (!s) return;
  try {
    const [summary, cards, groups, dict, cfg, identities, presets, autostart, backups, trashWf, trashCards, cal] = await Promise.all([
      api('GET', '/api/memory/summary'), api('GET', '/api/memory/cards'), api('GET', '/api/memory/groups'),
      api('GET', '/api/memory/dict?usage=1'), api('GET', '/api/settings'), api('GET', '/api/memory/identities'), api('GET', '/api/presets'),
      api('GET', '/api/autostart').catch(() => null), api('GET', '/api/backup').catch(() => []), api('GET', '/api/trash').catch(() => []), api('GET', '/api/memory/trash').catch(() => []),
      api('GET', '/api/calendar').catch(() => null),
    ]);
    if (state.settings !== s) return;
    s.data = { summary, cards, groups, dict, cfg, identities, autostart, backups, trash: { wf: trashWf, cards: trashCards }, snapshot: cal?.snapshot ?? null };
    s.err = null;
    state.identities = Array.isArray(identities) ? identities : [];
    state.presets = presets;
    state.trash = trashWf; // 側欄「垃圾桶（N）」同一份
  } catch (e) {
    if (state.settings === s) s.err = e.message;
  }
}
// 設定頁的開關即 PUT（部分送也行，伺服器合到現況再逐欄驗）；失敗一句原因、畫面重讀撥回
async function setPut(patch) {
  try { await api('PUT', '/api/settings', patch); } catch (e) { window.alert(e.message); }
  await afterMemChange(); // 整層開關會動到 summary.paused 與流程頁兩格
  render();
}
// 記憶頁列上的動作（退休／刪／喚醒／延長）：呼叫既有卡 API，成功後重抓
async function setCardAct(act, id) {
  const p = `/api/memory/cards/${encodeURIComponent(id)}`;
  try {
    if (act === 'set-del') { if (!window.confirm('把這張卡移到記憶垃圾桶？30 天內都能復原。')) return; await api('DELETE', p, undefined); }
    else if (act === 'set-retire') await api('POST', `${p}/retire`, {});
    else if (act === 'set-revive') await api('POST', `${p}/revive`, {});
    else if (act === 'set-extend-forever') await api('POST', `${p}/extend`, { expires: null });
    else await api('POST', `${p}/extend`, { expires: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) });
  } catch (e) { window.alert(e.message); }
  await afterMemChange();
  render();
}

function settingsHtml() {
  const s = state.settings;
  const d = s.data;
  const exN = d ? Object.values(d.summary.exceptions).reduce((a, v) => a + v.length, 0) : 0;
  const trashN = d ? d.trash.wf.length + d.trash.cards.length : 0;
  const hints = {
    記憶: !d ? '' : d.summary.paused ? '整層暫停' : exN ? `${exN} 例外` : `${d.summary.counts.profile + d.summary.counts.habit} 張卡`,
    素材庫: !d ? '' : `${(state.presets.role_context ?? []).length} 角色・${(state.presets.snippet ?? []).length} 片段`,
    連線: state.claude === false ? 'Claude 連不上' : state.claude ? 'Claude 已連上' : '',
    執行與排程: !d ? '' : [d.autostart?.enabled ? '開機自啟' : '', d.cfg.exec?.web === false ? '不查網' : ''].filter(Boolean).join('・'),
    資料: trashN ? `垃圾桶 ${trashN} 項` : '',
  };
  const warn = (g) => (g === '記憶' && d && !d.summary.paused && exN) || (g === '連線' && state.claude === false);
  const nav = SET_GROUPS.map(([g, icon]) => `<div class="it ${s.group === g ? 'on' : ''}" data-act="set-group" data-g="${esc(g)}"><i class="ph ${icon}"></i>${esc(g)}<span class="h ${warn(g) ? 'warn' : ''}">${esc(hints[g] ?? '')}</span></div>`).join('');
  let body;
  if (s.err) {
    body = `<div class="card err"><h3><i class="ph-fill ph-warning"></i> 設定讀不到</h3><p class="sub" style="margin:8px 0">${esc(s.err)}</p>
      <div class="btns"><button class="btn btn-secondary" data-act="set-reload">再讀一次</button></div></div>`;
  } else if (!d) body = '<div class="empty-c"><div class="skel" style="height:200px"></div></div>';
  else if (s.group === '記憶') body = setMemoryHtml(d);
  else if (s.group === '素材庫') body = setAssetsHtml(d);
  else if (s.group === '連線') body = setConnHtml(d);
  else if (s.group === '新流程的預設') body = setDefaultsHtml(d);
  else if (s.group === '執行與排程') body = setExecHtml(d);
  else body = setDataHtml(d);
  return `<div class="tophead"><h3><i class="ph ph-gear"></i> 設定</h3><span class="sub" style="margin:0;color:var(--ink-400)">這裡放預設值與一次性設定。每次開跑會變的、每條流程各自不同的，在流程頁。</span></div>
    <div class="setwrap" data-settings><nav class="setnav">${nav}</nav><div class="setbody" data-group="${esc(s.group)}">${body}</div></div>`;
}
const setTabsHtml = (g) => `<div class="memtabs"><div class="seg sm">${SET_TABS[g].map((k) => `<span class="${setTab(g) === k ? 'on' : ''}" data-act="set-tab" data-g="${esc(g)}" data-k="${esc(k)}">${esc(k)}</span>`).join('')}</div></div>`;
const setHead = (g) => `<h4>${esc(g)}</h4><div class="lead">${esc(SET_LEAD[g])}</div>${setTabsHtml(g)}`;
const setRow = (l, d, c, stack = false) => `<div class="row${stack ? ' stack' : ''}"><div class="l">${l}</div>${d ? `<div class="d">${d}</div>` : ''}<div class="c">${c}</div></div>`;
const setSw = (on, act, extra = '') => `<span class="sw ${on ? 'on' : ''}" data-act="${act}" ${extra} role="switch" aria-checked="${on}">${on ? '開' : '關'}<i></i></span>`;
const setLater = (l, dsc) => setRow(l, dsc, '<span class="chip">下一輪</span>'); // 續票項：只留一行說去哪
// 設定頁一句結果／錯誤（快照、備份、垃圾桶、清空）：state.settings.msg={key,text,err}，換組／換子分頁就清
const setMsgHtml = (key) => { const m = state.settings?.msg; return m?.key === key ? `<div class="setmsg ${m.err ? 'err' : ''}" data-setmsg="${key}"><i class="ph ${m.err ? 'ph-warning-circle' : 'ph-check-circle'}"></i>${esc(m.text)}</div>` : ''; };

// ---- 連線：Claude／Google 行事曆（M5b；連接器與金鑰 T8 搬到記憶）----
// Claude 狀態＝頂欄小點同一份（state.claude：GET /api/health 只看得到 Claude 指令在不在，看不出登入過期）；「重新連線」＝既有 refreshHealth。
// Google 快照時間讀 GET /api/calendar 的 snapshot；「重新整理快照」＝既有 POST /api/calendar/refresh（行事曆頁那顆同一支）
function setConnHtml(d) {
  const tab = setTab('連線');
  let body;
  if (tab === 'Google 行事曆') {
    const snap = d.snapshot;
    const ok = snap?.status === 'ok';
    const desc = !snap ? '還沒抓過快照：行事曆上只有剝繭自己的排程。' : ok ? `上次快照：${esc(memAt(snap.fetched_at))}。按「重新整理快照」才抓，不即時。` : `上次抓不到${snap.reason ? `：${esc(snap.reason)}` : ''}。剝繭自己的排程不受影響。`;
    body = `<div class="group">
      ${setRow('Google 快照', desc, `<span class="chip" data-snap="${!snap ? 'none' : ok ? 'ok' : 'failed'}">${!snap ? '還沒抓過' : ok ? '有快照' : '抓不到'}</span><button class="btn sm2" data-act="set-cal-refresh" ${state.settings.busy ? 'disabled' : ''}><i class="ph ph-arrows-clockwise"></i>${state.settings.busy === 'cal' ? '抓取中⋯' : '重新整理快照'}</button>`)}
      ${setRow('授權', '行事曆走你 Claude 裡的 Google 行事曆連接器；剝繭不另外存授權，也拿不到你的密碼。要解除，在 Claude 那邊解除。', '')}</div>${setMsgHtml('cal')}`;
  } else {
    const on = state.claude === true;
    body = `<div class="group">
      ${setRow('狀態', on ? '找得到 Claude 指令。用量在儀表板。' : '找不到 Claude 指令：Claude Code 沒裝，或不在路徑上。你的流程庫都在，不會不見。', `<span class="chip ${on ? '' : 'red'}" data-claude="${on ? 'on' : 'off'}"><i class="${on ? 'ph-fill ph-plugs-connected' : 'ph ph-plugs'}"></i>${on ? '已連上' : '連不上'}</span><button class="btn sm2" data-act="reconnect"><i class="ph ph-arrows-clockwise"></i>重新連線</button>`)}
      ${setRow('登入過期怎麼辦', '這裡只看得到 Claude 指令在不在，看不出登入有沒有過期。步驟一直失敗、訊息說登入過期時：開終端機跑 <span style="font-family:var(--mono)">claude</span>，照它的指示登入，回來按那一步的「重試」。', '')}
      ${setRow('模型檔位對照', '步驟抽屜與「新流程的預設」選的檔位，各對到哪個模型。', '<span class="sub" style="margin:0">快而省 Haiku・均衡 Sonnet・深而慢 Opus</span>')}</div>`;
  }
  return `${setHead('連線')}${body}`;
}

// ---- 新流程的預設：權限與查核／AI 步驟／停點（M5b）——讀寫 settings.defaults（applyDefaults 只在新建時吃它）；每個開關即 PUT ----
function setDefaultsHtml(d) {
  const tab = setTab('新流程的預設');
  const df = d.cfg.defaults ?? {};
  const seg = (k, cur, opts) => `<div class="seg sm" data-def="${k}">${opts.map(([v, t]) => `<span class="${String(cur) === v ? 'on' : ''}" data-act="set-def-val" data-k="${k}" data-v="${v}">${t}</span>`).join('')}</div>`;
  let body;
  const fl = df.supervisor_flags ?? {};
  if (tab === 'AI 步驟') {
    body = `<div class="group"><h5>模型與重試</h5>
      ${setRow('模型檔位', '步驟沒自己選檔位時用哪一檔；「不設」＝交給 Claude 的預設。', seg('model_tier', df.model_tier ?? 'null', [['null', '不設'], ['fast', '快而省'], ['balanced', '均衡'], ['deep', '深而慢']]))}
      ${setRow('出錯自動重試', '步驟沒自己設時，失敗了自動再試幾次；「不設」＝不重試。', seg('retry', df.retry ?? 'null', [['null', '不設'], ['0', '0 次'], ['1', '1 次'], ['2', '2 次']]))}
      ${setLater('產出語言', '現在跟指示的語言一樣。')}</div>`;
  } else if (tab === '停點') {
    body = `<div class="group">${setRow('停點', '在每個步驟的「停點」設定。', '')}${setLater('停著沒處理多久提醒', '停點提醒間隔下一輪。')}</div>`;
  } else {
    body = `<div class="group"><h5>產出檔案的權限</h5>
      ${setRow('親手建的流程', '預設允不允許 AI 工人在該趟的產出資料夾寫檔（Word、Excel）與執行程式；流程頁可以個別改。', setSw(df.permissions_files !== false, 'set-def-sw', 'data-k="permissions_files"'))}
      ${setRow('匯入的流程', '一律不允許，不是設定：別人流程裡藏的指示不可信，不能讓它在你電腦上寫檔。要開，進那條流程的流程頁自己打開。', '<span class="chip">固定關</span>')}</div>
    <div class="group"><h5>交貨查核</h5>
      ${setRow('每步都查', '每個 AI 步驟做完先對照原始資料與你的要求查一次；攔到會自動重做一次，還錯才停下問你。流程頁可以個別關。', setSw(df.check_enabled !== false, 'set-def-sw', 'data-k="check_enabled"'))}
      ${setRow('數字對原始資料', '「看流程」＝這條流程有必填的資料欄位才對原始資料；固定開／固定關＝不看流程。', seg('check_facts', df.check_facts ?? 'auto', [['auto', '看流程'], ['on', '固定開'], ['off', '固定關']]))}</div>
    <div class="group"><h5>監工</h5>
      ${setRow('監工：開場備註、每步交接、跑完紀錄', '新流程預設開不開；流程頁可以個別關。', setSw(df.supervisor_enabled !== false, 'set-def-sw', 'data-k="supervisor_enabled"'))}
      ${setRow('每步「監工可以」的預設', '新流程每個 AI 步驟預設打開哪幾個；步驟抽屜可以個別改。', `<div class="pills">${SUP_CHK.map(([, k, t]) => `<span class="pill ${fl[k] ? 'on' : ''}" data-act="set-def-flag" data-k="${k}">${t}</span>`).join('')}</div>`)}</div>`;
  }
  return `${setHead('新流程的預設')}<p class="note" style="margin:0 0 var(--s2)" data-def-note>只影響之後新建的流程；已經存好的流程不變，各自在流程頁改。</p>${body}`;
}

// ---- 執行與排程：常駐／排程／AI 工人（M5b）——開機自啟從行事曆頁底搬來（GET/POST /api/autostart）；其餘讀寫 settings.exec ----
const LEAD_TXT = { '10m': '10 分鐘前', '30m': '30 分鐘前', '1h': '1 小時前', '2h': '2 小時前', '3h': '3 小時前', '6h': '6 小時前', '12h': '12 小時前', '1d': '1 天前', '2d': '2 天前' }; // 與後端 LEAD_MS 九檔同一份
const LEAD_ORDER = Object.keys(LEAD_TXT);
// 設定裡提前提醒預設的首檔（新增排程視窗的初值；沒有就「先不提醒」）
const execLead0 = () => { const l = state.calendar?.exec?.remind_leads ?? []; return typeof l[0] === 'string' ? l[0] : ''; };
function setExecHtml(d) {
  const tab = setTab('執行與排程');
  const ex = d.cfg.exec ?? {};
  let body;
  if (tab === '排程') {
    const leads = Array.isArray(ex.remind_leads) ? ex.remind_leads : [];
    body = `<div class="group">
      ${setRow('錯過時', '剝繭沒開著、排程到點沒跑成：新排程預設問你補不補，還是直接補跑。每條排程建立後可以自己改；已有的排程不受影響。', `<div class="seg sm" data-exec="auto_makeup"><span class="${ex.auto_makeup ? '' : 'on'}" data-act="set-exec-val" data-k="auto_makeup" data-v="false">先詢問</span><span class="${ex.auto_makeup ? 'on' : ''}" data-act="set-exec-val" data-k="auto_makeup" data-v="true">自動補</span></div>`)}
      ${setRow('提醒預設時間點', '新排程預設提早幾次提醒（可多選）；每條排程建立後可以自己改。', `<div class="pills" data-exec="remind_leads">${LEAD_ORDER.map((k) => `<span class="pill ${leads.includes(k) ? 'on' : ''}" data-act="set-exec-lead" data-k="${k}">${LEAD_TXT[k]}</span>`).join('')}</div>`, true)}</div>`;
  } else if (tab === 'AI 工人') {
    body = `<div class="group">
      ${setRow('允許查網路', ex.web === false ? '關著：AI 工人每一步都不上網，只用你給的資料；監工建議開也不會開。' : '開著：步驟需要查資料時，AI 工人可以上網查。', setSw(ex.web !== false, 'set-exec-sw', 'data-k="web"'))}
      ${setRow('連接器', '只有唯讀；工人環境裡沒有金鑰，呼叫由剝繭本體執行。', '<span class="chip">輪 2</span>')}</div>`;
  } else {
    const a = d.autostart;
    const on = a?.enabled === true;
    const unsupported = !a || a.supported === false;
    body = `<div class="group">
      ${setRow('開機自動啟動', unsupported ? '這個平台不支援：請自行把「node src/server.js」加進開機項目。' : on ? '電腦一開，剝繭就在背景待命；排程到點會跑。' : '現在是手動：你打開它才會跑，關掉就停。排程到點時如果沒開著，會記成「錯過」，下次打開時問你要不要補。', unsupported ? '<span class="chip">這個平台不支援</span>' : setSw(on, 'autostart-toggle', 'data-autostart'))}
      ${setLater('同時最多跑幾趟', '現在到點全發、不限流。')}</div>`;
  }
  return `${setHead('執行與排程')}${body}`;
}

// ---- 資料：位置與備份／清理／關於（M5b）——位置唯讀；立即備份＋清單；垃圾桶合併表（流程＋卡各自復原）；清空記憶二次確認；版本 ----
// 還原、匯出全部、清空全部、換位置、每天自動備份＝續票（上桌題 3）
function setDataHtml(d) {
  const tab = setTab('資料');
  const s = state.settings;
  let body;
  if (tab === '清理') {
    const rows = [
      ...d.trash.wf.map((t) => ({ kind: 'wf', key: t.key, at: t.trashed_at, label: '流程', text: t.name, extra: t.category })),
      ...d.trash.cards.map((t) => ({ kind: 'card', key: t.key, at: t.trashed_at, label: t.bucket === 'profile' ? '認識卡' : '習慣卡', text: t.text, extra: '' })),
    ].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
    const tr = (r) => `<tr data-trash="${esc(r.kind)}:${esc(r.key)}"><td><span class="chip">${esc(r.label)}</span></td><td><b>${esc(r.text)}</b>${r.extra ? `<span class="syn" style="margin-left:6px">${esc(r.extra)}</span>` : ''}</td><td class="syn">${esc(memAt(r.at))}</td><td class="acts"><button class="mini" data-act="set-trash-restore" data-kind="${esc(r.kind)}" data-key="${esc(r.key)}">復原</button></td></tr>`;
    body = `<div class="group" style="padding:8px 14px"><h5>垃圾桶・${rows.length} 項<span class="sub">刪掉的流程與記憶卡放 30 天，期限內都能復原；到期自動清。</span></h5>
      ${rows.length ? `<div style="overflow-x:auto"><table class="dict" data-trashtable><thead><tr><th>是什麼</th><th>名字</th><th>刪掉時間</th><th></th></tr></thead><tbody>${rows.map(tr).join('')}</tbody></table></div>` : '<div class="none">垃圾桶是空的</div>'}${setMsgHtml('trash')}</div>
    <div class="group">
      ${setRow('清空記憶', '所有習慣卡與認識卡進記憶垃圾桶（30 天內可逐張復原）；欄位詞典、分類的規矩、身分、流程都不動。', '<button class="btn sm2 btn-danger" data-act="set-clear-mem-open">清空記憶</button>')}
      ${setLater('匯出全部、清空全部', '')}${setMsgHtml('clear')}</div>`;
  } else if (tab === '關於') {
    body = `<div class="group">${setRow(`剝繭 ${esc(d.cfg.version ?? '')}`, 'MIT 授權。你的資料不經過任何人的伺服器，全在你電腦和你自己的 Claude 帳號裡。', '')}</div>`;
  } else {
    const bk = [...d.backups].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    // 公司（移植合併輪 U3）：名稱 change／Enter 即 PUT（處理在 app 的 change 監聽）；規範上限唯讀（三層 §三固定值，後端 checkRuleLimits 同一份）
    body = `<div class="group"><h5>公司</h5>
      ${setRow('公司名稱', '側欄最上層、麵包屑、公司頁標題跟著改；清空顯示「公司」。', `<input class="notein" id="set-company-name" type="text" maxlength="60" placeholder="公司" value="${esc(d.cfg.company_name ?? '')}" style="margin:0;max-width:260px">`)}
      ${setRow('規範上限', '單檔 4,000 字・每層合計 8,000 字', '<span class="chip">固定</span>')}${setMsgHtml('company')}</div>
    <div class="group"><h5>位置</h5>
      ${setRow('資料夾', `<span class="path" data-datadir>${esc(d.cfg.data_dir ?? '')}</span>`, '<span class="chip">換位置下一輪</span>')}</div>
    <div class="group"><h5>備份</h5>
      ${setRow('立即備份', '整個資料夾複製一份到同層的「資料夾名-backups」；剝繭不存金鑰，備份裡也沒有。', `<button class="btn sm2" data-act="set-backup-now" ${s.busy ? 'disabled' : ''}><i class="ph ph-copy"></i>${s.busy === 'backup' ? '備份中⋯' : '立即備份'}</button>`)}
      ${setLater('每天自動備份、還原', '要還原，先把備份夾整個複製回資料夾位置。')}${setMsgHtml('backup')}
      <h5>備份清單・${bk.length} 份</h5>
      ${bk.length ? `<div style="overflow-x:auto"><table class="dict" data-backuptable><thead><tr><th>備份</th><th>時間</th></tr></thead><tbody>${bk.map((b) => `<tr data-backup="${esc(b.name)}"><td><b>${esc(b.name)}</b></td><td class="syn">${esc(memAt(b.at))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="none">還沒備份過</div>'}</div>`;
  }
  return `${setHead('資料')}${body}`;
}
// 清空記憶的二次確認浮窗（放 .layout 外，同卡片浮窗）：確定才 POST /api/memory/clear；Esc、背景、取消都關
function setConfirmModalHtml() {
  const s = state.settings;
  if (!s?.confirm) return '';
  const n = s.data ? s.data.summary.counts.profile + s.data.summary.counts.habit : 0;
  return `<div class="pvback memmodal" data-act="set-clear-mem-back" data-confirm="memory"><div class="modal" role="dialog" aria-label="清空記憶">
    <div class="cvdhead" style="margin-bottom:var(--s2)"><span class="overline">清空記憶</span><button class="btn btn-ghost iconb" data-act="set-clear-mem-cancel" style="margin-left:auto" title="關閉（Esc）"><i class="ph ph-x"></i></button></div>
    <h3>把 ${n} 張記憶卡全部移到垃圾桶？</h3>
    <p class="sub" style="margin:8px 0">習慣卡與認識卡都會進記憶垃圾桶，30 天內可以在「資料→清理」逐張復原；欄位詞典、分類的規矩、身分、流程都不動。清空之後每步指示不再附「關於你」，開跑表單也不再有習慣選項，直到你重新記。</p>
    <div class="btns"><button class="btn btn-danger" data-act="set-clear-mem-go" ${s.busy ? 'disabled' : ''}><i class="ph ph-trash"></i>${s.busy === 'clear' ? '清空中⋯' : '確定清空'}</button><button class="btn btn-ghost" data-act="set-clear-mem-cancel" ${s.busy ? 'disabled' : ''}>取消</button></div>
  </div></div>`;
}

// ---- 記憶：記憶總覽（地圖＋欄位詞典收摺）／關於你／連接器與金鑰（移植第一批 T8：三分頁改名；欄位詞典摺進總覽底部，功能不減）----
// 前端版 coversWorkflow（與後端同規則）：全部永遠涵蓋；分類只比分類；流程要分類與流程都對
const memCovers = (c, cat, wfId) => (c.scope?.level === 'all' ? true : c.scope?.level === 'category' ? c.scope.category === cat : c.scope?.category === cat && c.scope?.workflow === wfId);
const memExpired = (c) => c.expires != null && String(c.expires) < new Date().toISOString().slice(0, 10);
const memLive = (c) => c.status === 'active' && !memExpired(c);
const byCreatedAt = (a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
function setMemoryHtml(d) {
  const tab = setTab('記憶');
  const body = tab === '關於你' ? setKnowHtml(d) : tab === '連接器與金鑰' ? setKeysHtml(d) : `${setMapHtml(d)}${setDictFoldHtml(d)}`;
  return `${setHead('記憶')}${body}`;
}
// 欄位詞典摺在記憶總覽底部（demo 08：總覽＝卡片＋詞典 details）；點開不重繪，表格與併入照舊
const setDictFoldHtml = (d) => `<details data-fold="dict" ${state.settings?.merge ? 'open' : ''}><summary style="cursor:pointer;padding:10px 2px;font-weight:600">欄位詞典<span class="sub">相同的欄位名稱，沿用同一個意思。</span></summary>${setDictHtml(d)}</details>`;
// 連接器與金鑰：從「連線」搬來（demo 08 放記憶底下）；輪 2 才做，兩列都「尚未提供」
function setKeysHtml() {
  return `<div class="group">
      ${setRow('連接器與金鑰', 'AI 永遠看不到金鑰：金鑰放作業系統的認證管理員，不進剝繭的任何檔案、備份、匯出、卷宗；AI 工人拿到的是連接器的名字與它能讀什麼，呼叫由剝繭本體執行。第一版只有讀，沒有寫。', '<span class="chip">尚未提供</span>')}
      ${setRow('雲端硬碟、信箱', '接上之後，流程可以讀你的雲端檔案當資料來源。', '<span class="chip">尚未提供</span>')}</div>`;
}
// 內容層按場合帶幾張：後端 memory.js CONTENT_TOP 的複本（那邊改了要跟）
const MEM_CONTENT_TOP = 3;
// 地圖＝分類→流程→卡（讀全部卡＋群組圈＋側欄的分類／流程清單，前端自己歸位）：每條流程「每步帶 N（表達層全部＋場合對上的內容層前 MEM_CONTENT_TOP 張，
// 依 last_used_at ?? created_at 新→舊，與後端 selectCore 同規則；不算身分限縮）・選項 自己 a＋繼承 b」；場合對上但排不進前幾張的仍列出、另標；
// 分類層列規矩與分類共用的習慣卡；最後一塊「全部流程」＝表達層認識卡＋全部尺度的習慣卡。每條都可點開既有卡片浮窗
function setMapHtml(d) {
  const live = d.cards.filter(memLive);
  const profiles = live.filter((c) => c.bucket === 'profile');
  const habits = live.filter((c) => c.bucket === 'habit');
  const exp = profiles.filter((c) => c.layer === 'expression').sort(byCreatedAt);
  const recent = (c) => String(c.last_used_at ?? c.created_at ?? '');
  const byRecentDesc = (a, b) => recent(b).localeCompare(recent(a)) || byCreatedAt(b, a);
  const byCat = {};
  for (const c of state.categories) byCat[c] = [];
  for (const w of state.workflows) (byCat[w.category] ??= []).push(w);
  const catBlock = (cat, wfs) => {
    const rules = (d.groups.find((g) => g.category === cat)?.rules ?? []).filter((r) => r.status === 'active');
    const catHabits = habits.filter((c) => c.scope?.level === 'category' && c.scope.category === cat);
    const flowBlock = (w) => {
      const matched = profiles.filter((c) => c.layer === 'content' && memCovers(c, cat, w.id)).sort(byRecentDesc);
      const ctx = matched.slice(0, MEM_CONTENT_TOP);
      const rest = matched.slice(MEM_CONTENT_TOP);
      const own = habits.filter((c) => c.scope?.level === 'workflow' && c.scope.category === cat && c.scope.workflow === w.id);
      const inh = habits.filter((c) => c.scope?.level !== 'workflow' && memCovers(c, cat, w.id));
      const items = [...ctx.map((c) => memCardLi(c, '按場合帶')), ...rest.map((c) => memCardLi(c, `場合對上，排在前 ${MEM_CONTENT_TOP} 張之外`)), ...own.map((c) => memCardLi(c, '生在這條')), ...inh.map((c) => memCardLi(c, `繼承自${memScopeText(c.scope)}`))].join('');
      return `<div class="mflow" data-mapflow="${esc(w.id)}"><div class="fh"><i class="ph ph-flow-arrow"></i>${esc(w.name)}<span class="cnts">每步帶 ${exp.length + ctx.length}・選項 自己 ${own.length}＋繼承 ${inh.length}</span></div>
        ${items ? `<ul>${items}</ul>` : '<div class="none">只帶全部流程共用的</div>'}</div>`;
    };
    return `<div class="mcat" data-mapcat="${esc(cat)}"><div class="mh"><i class="ph ph-folder"></i>${esc(cat)}<span class="sub">規矩 ${rules.length} 條・共用 ${catHabits.length} 張習慣卡</span><span class="chip">${wfs.length} 條流程</span></div>
      ${rules.length ? `<ul>${rules.map((r) => memCardLi({ ...r, bucket: 'group' }, `${cat}的規矩`, cat)).join('')}</ul>` : ''}
      ${wfs.map(flowBlock).join('') || '<div class="none">這個分類還沒有流程</div>'}</div>`;
  };
  const allHabits = habits.filter((c) => c.scope?.level === 'all');
  const allBlock = `<div class="mcat" data-mapcat="*"><div class="mh"><i class="ph ph-globe-simple"></i>全部流程<span class="sub">到哪都帶</span><span class="chip">${exp.length} 條認識卡・${allHabits.length} 張習慣卡</span></div>
    ${exp.length || allHabits.length ? `<ul>${exp.map((c) => memCardLi(c, '每步帶')).join('')}${allHabits.map((c) => memCardLi(c, '全部流程的選項')).join('')}</ul>` : '<div class="none">還沒有</div>'}</div>`;
  return `<p class="note" style="margin:0 0 var(--s2)" data-map-note>「每步帶 N」是不指定身分時的口徑（表達層全部＋場合對上的事實最近用過的前 ${MEM_CONTENT_TOP} 張）；指定身分的流程實際帶的會更少。</p>
    <div class="map">${Object.entries(byCat).map(([cat, wfs]) => catBlock(cat, wfs)).join('')}${allBlock}</div>
    <h5 class="sech"><i class="ph ph-info"></i>需要你看一眼的</h5>${setExcHtml(d)}
    <p class="note">需要你看一眼的例外，也會出現在儀表板「要你處理」。點任何一條可以看出處原話。</p>`;
}
// 例外四格：到期待答／休眠／退休與被取代／選了又改掉（前三格讀 summary.exceptions；退休從全部卡撈）
function setExcHtml(d) {
  const ex = d.summary.exceptions;
  const retired = d.cards.filter((c) => c.status === 'retired');
  const mini = (act, c, label, cls = '') => `<button class="mini ${cls}" data-act="${act}" data-id="${esc(c.id)}" data-bucket="${esc(c.bucket)}" data-text="${esc(c.text)}">${label}</button>`;
  const row = (c, extra, acts) => `<li><span class="cardlnk" data-act="mem-card" data-id="${esc(c.id)}" data-bucket="${esc(c.bucket)}" data-text="${esc(c.text)}" title="點開看出處原話">${memTagHtml(c)}<span class="t">${esc(c.text)}</span></span>${extra ? `<span class="m">${extra}</span>` : ''}<span class="acts">${acts}</span></li>`;
  const box = (key, title, icon, items, hint) => `<div class="box" data-exc="${key}"><h6><i class="ph ${icon}"></i>${title}<span class="chip">${items.length}</span></h6><div class="d">${hint}</div><ul>${items.join('') || '<li class="empty">現在沒有</li>'}</ul></div>`;
  const nameOf = (id) => d.cards.find((x) => x.id === id)?.text ?? id ?? '';
  return `<div class="exc">
    ${box('expired', '到期待答', 'ph-clock', ex.expired.map((c) => row(c, `到期 ${esc(c.expires)}`, mini('set-extend', c, '再 30 天') + mini('set-extend-forever', c, '改永久') + mini('set-retire', c, '退休', 'no'))), '有效期到了：還算不算數？沒答之前不帶。')}
    ${box('dormant', '休眠', 'ph-moon', ex.dormant.map((c) => row(c, '連續五次當選項沒被選', mini('set-revive', c, '喚醒'))), '當選項出現五次都沒被選，先收起來；喚醒就回到選項裡。')}
    ${box('gone', '退休與被取代', 'ph-archive', [
    ...retired.map((c) => row(c, '退休', mini('set-revive', c, '復活') + mini('set-del', c, '刪', 'no'))),
    ...ex.replaced.map((c) => row(c, `被「${esc(nameOf(c.replaced_by))}」取代`, mini('set-del', c, '刪', 'no'))),
  ], '留著當紀錄，不帶也不當選項。')}
    ${box('changed', '選了又改掉', 'ph-arrow-u-up-left', ex.changed.map((c) => row(c, `改掉 ${c.changed_count} 次`, mini('set-replace', c, '改') + mini('set-retire', c, '退休', 'no'))), '點了又當場改掉兩次以上：也許它該改了。')}
  </div>`;
}
// 認識你：整層開關、敏感四類、「每步指示現在附的關於你」原文（＝表達層活著沒過期的卡依 created_at 串起來，跟後端 selectCore 同一規則；沒身分限縮）、兩層清單各列改／退休／刪
// 兩層的「N 條」只數活著沒過期的（與預覽同口徑）；過期卡仍列在清單、標「（已到期，不帶）」
function setKnowHtml(d) {
  const paused = d.cfg.memory?.paused === true;
  const sens = d.cfg.memory?.sensitive ?? {};
  const act = d.cards.filter((c) => c.bucket === 'profile' && c.status === 'active').sort(byCreatedAt);
  const exp = act.filter((c) => c.layer === 'expression');
  const ctx = act.filter((c) => c.layer !== 'expression');
  const expLive = exp.filter(memLive);
  const ctxLive = ctx.filter(memLive);
  const crow = (c) => `<div class="crow" data-crow="${esc(c.id)}"><div class="c"><span class="cardlnk" data-act="mem-card" data-id="${esc(c.id)}" data-bucket="profile" data-text="${esc(c.text)}" title="點開看出處原話">${esc(c.text)}</span></div>
    <div class="m">${esc(MEM_SOURCE_TXT[c.source?.kind] ?? '你說的')}・用在：${esc(memScopeText(c.scope))}・有效期：${c.expires ? esc(c.expires) : '永久'}${memExpired(c) ? '（已到期，不帶）' : ''}${c.last_used_at ? `・上次帶：${esc(memAt(c.last_used_at))}` : ''}</div>
    <div class="acts"><button class="mini" data-act="set-replace" data-id="${esc(c.id)}" data-bucket="profile" data-text="${esc(c.text)}" title="開一張新卡取代這張">改</button><button class="mini" data-act="set-retire" data-id="${esc(c.id)}">退休</button><button class="mini no" data-act="set-del" data-id="${esc(c.id)}">刪</button></div></div>`;
  // 介紹你自己三題（demo 08 關於你頂部）：answer 卡＝出處 intro；第三題是表達層、前兩題是內容層，依 created_at 對回題目；「修改」＝開那張卡
  const introCards = act.filter((c) => c.source?.kind === 'intro');
  const introCtx = introCards.filter((c) => c.layer !== 'expression');
  const introExp = introCards.filter((c) => c.layer === 'expression');
  const introRows = INTRO_QUESTIONS.map((q, i) => { const c = q.layer === 'expression' ? introExp[0] : introCtx[i]; return setRow(esc(q.label), c ? esc(c.text) : '<span class="none">還沒答</span>', c ? `<button class="mini" data-act="mem-card" data-id="${esc(c.id)}" data-bucket="profile" data-text="${esc(c.text)}" title="點開卡片改">修改</button>` : ''); }).join('');
  const introBlock = `<div class="group" data-intro><h5>介紹你自己<span class="sub">三題各是一張認識卡；改＝開那張卡。</span></h5>${introCards.length ? introRows : `<div class="none">還沒介紹過</div><div class="btns" style="margin-top:8px"><button class="btn sm2" data-act="intro-open"><i class="ph ph-hand-waving"></i>介紹你自己</button></div>`}</div>`;
  const injText = paused ? '（整層暫停中）' : expLive.length ? expLive.map((c) => `· ${c.text}`).join('\n') : '（還沒有每步帶的卡：介紹自己時答第三題，或在停點註記寫「以後都⋯」）';
  return `${introBlock}<div class="group">
      ${setRow('關於你', paused ? '暫停期間每步指示不附「關於你」，卡都還在；分類的規矩與習慣選項照舊。' : '每步帶的每一步都帶；按場合帶的只在場合對上的流程帶；交貨查核與監工一律不帶。', setSw(!paused, 'set-pause', 'data-paused'))}
      ${Object.keys(SENSITIVE_TXT).map((k) => setRow(`記${SENSITIVE_TXT[k]}`, '預設不記。打開＝只記你親口說的。', setSw(!!sens[k], 'set-sens', `data-k="${k}"`))).join('')}</div>
    <div class="injected ${paused ? 'paused' : ''}" data-injected><div class="overline">每步指示現在附的「關於你」（從卡直接串出來，AI 不改寫）</div><div class="note" style="margin:2px 0 0">（不含身分限縮；綁了身分的分類實際附的會更少）</div><pre>${esc(injText)}</pre></div>
    <div class="group" data-layer="expression"><h5>每步帶・${expLive.length} 條<span class="sub">怎麼講：語氣、長度、格式、禁忌。</span></h5>${exp.map(crow).join('') || '<div class="none">還沒有</div>'}</div>
    <div class="group" data-layer="content"><h5>按場合帶・${ctxLive.length} 條<span class="sub">關於你的事實：讀者、公司、進行中的事。</span></h5>${ctx.map(crow).join('') || '<div class="none">還沒有</div>'}</div>
    <details data-fold="identity" ${state.settings?.idEdit ? 'open' : ''}><summary style="cursor:pointer;padding:10px 2px;font-weight:600">身分<span class="sub">一疊認識卡的封套，開跑時可換。</span></summary>${setIdentitiesHtml(d)}</details>`;
}
// 欄位詞典：六類分節表——欄位／同義詞／用在哪些流程（後端 ?usage=1 掃全部流程算的）／掛的習慣卡（活著的）／改性質下拉＋「併入⋯」
function setDictHtml(d) {
  const dict = d.dict;
  const usage = dict.usage ?? {};
  const habitsOf = (name) => d.cards.filter((c) => c.bucket === 'habit' && c.status === 'active' && c.field === name).length;
  const m = state.settings.merge;
  const kindSel = (f) => `<select class="moveselect" data-dict-kind="${esc(f.name)}" title="改性質">${Object.entries(FIELD_KIND_TXT).map(([k, t]) => `<option value="${k}" ${(f.kind ?? 'method') === k ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  const mergeRow = (f) => (m?.drop === f.name
    ? `<tr class="mergerow"><td colspan="5"><div class="mergebox"><span>把「${esc(f.name)}」併進</span>
        <select class="moveselect" data-merge-keep>${dict.fields.filter((x) => x.name !== f.name).map((x) => `<option value="${esc(x.name)}" ${m.keep === x.name ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <span class="sub" style="margin:0">同義詞併過去、掛在它上面的習慣卡與分類規矩改掛過去；之後詞典裡就沒有「${esc(f.name)}」了。</span>
        <button class="btn sm2 btn-primary" data-act="dict-merge-go">併</button><button class="btn sm2 btn-ghost" data-act="dict-merge-cancel">取消</button>
        ${m.err ? `<span class="sub" style="margin:0;color:var(--red-text)">${esc(m.err)}</span>` : ''}</div></td></tr>` : '');
  const rows = Object.entries(FIELD_KIND_TXT).map(([k, t]) => {
    const items = dict.fields.filter((f) => (f.kind ?? 'method') === k);
    if (!items.length) return '';
    return `<tr class="kind"><th colspan="5">${t}</th></tr>` + items.map((f) => `<tr data-dict="${esc(f.name)}"><td><b>${esc(f.name)}</b>${f.origin === 'factory' ? '' : '<span class="chip" style="margin-left:5px" title="你的流程長出來的">自己長的</span>'}</td>
      <td class="syn">${(f.synonyms ?? []).map(esc).join('、') || '—'}</td><td class="syn">${(usage[f.name] ?? []).map((u) => esc(u.name)).join('、') || '還沒有流程用到'}</td>
      <td class="num">${habitsOf(f.name)}</td><td class="acts">${kindSel(f)}<button class="mini" data-act="dict-merge-start" data-name="${esc(f.name)}" title="把這個欄位併進別的欄位">併入⋯</button></td></tr>${mergeRow(f)}`).join('');
  }).join('');
  return `<div class="group" style="padding:8px 14px"><div style="overflow-x:auto"><table class="dict"><thead><tr><th>欄位</th><th>同義詞</th><th>用在哪些流程</th><th>掛的習慣卡</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">按性質分六類，不按來源。出廠 7 條，其他是你的流程長出來的；性質在右邊改，兩個欄位其實是同一件事就「併入」。</p></div>`;
}

// ---- 素材庫：角色情境／常用片段（身分 T8 搬到記憶→關於你）----
function setAssetsHtml(d) {
  const tab = setTab('素材庫');
  const body = tab === '常用片段' ? setPresetListHtml('snippet', '常用片段', '抽屜「背景資料」「範例」兩格的常用列帶入', '片段的名字，例：公司一句話簡介')
    : setPresetListHtml('role_context', '角色情境', '抽屜裡「角色情境」的常用列帶入的長文', '新角色的名字，例：行銷主管視角');
  return `${setHead('素材庫')}${body}`;
}
// 身分＝一疊認識卡的封套：勾哪些卡、預設綁哪些分類（開那些分類的流程時開跑表單自動選它，可換）。編輯表單的值都在 state.settings.idEdit，重繪從它還原
function setIdentitiesHtml(d) {
  const s = state.settings;
  const profiles = d.cards.filter((c) => c.bucket === 'profile' && c.status === 'active').sort(byCreatedAt);
  const textOf = (id) => d.cards.find((c) => c.id === id)?.text ?? id;
  const item = (i) => {
    const e = s.idEdit;
    if (e?.id === i.id) {
      return `<div class="asset editing" data-idedit="${esc(i.id)}"><div class="ih"><input class="notein" id="id-name" data-idf="name" value="${esc(e.name)}" placeholder="身分的名字" style="margin:0;max-width:260px"></div>
        <div class="ib">這個身分帶哪些認識卡：</div>
        ${profiles.length ? `<ul class="ck">${profiles.map((c) => `<li><label><input type="checkbox" data-idc="${esc(c.id)}" ${e.cards.has(c.id) ? 'checked' : ''}>${memTagHtml(c)}<span>${esc(c.text)}</span></label></li>`).join('')}</ul>` : '<div class="none">還沒有認識卡——介紹你自己、聊天或停點註記寫「以後都⋯」都會生出來</div>'}
        <div class="ib">預設綁哪些分類（開這些分類的流程時自動選它，開跑時可換）：</div>
        <div class="pills">${state.categories.map((c) => `<span class="pill ${e.categories.has(c) ? 'on' : ''}" data-act="id-bind" data-c="${esc(c)}">${esc(c)}</span>`).join('') || '<span class="none">還沒有分類</span>'}</div>
        <div class="btns" style="margin-top:8px"><button class="btn sm2 btn-primary" data-act="id-save">存</button><button class="btn sm2 btn-ghost" data-act="id-cancel">取消</button>${e.err ? `<span class="sub" style="margin:0;color:var(--red-text)">${esc(e.err)}</span>` : ''}</div></div>`;
    }
    return `<div class="asset" data-identity="${esc(i.id)}"><div class="ih"><b>${esc(i.name)}</b><span class="meta">${i.cards.length} 條認識卡・預設綁 ${i.categories.length ? esc(i.categories.join('、')) : '沒有'}・開跑時可換</span>
      <span class="acts"><button class="mini" data-act="id-edit" data-id="${esc(i.id)}">改</button><button class="mini no" data-act="id-del" data-id="${esc(i.id)}">刪</button></span></div>
      <div class="ib">${i.cards.map((c) => esc(textOf(c))).join('　·　') || '沒勾任何認識卡：用它開跑＝關於你一條都不帶'}</div></div>`;
  };
  return `<div class="group"><h5>身分・一疊認識卡的封套，開跑時可換<span class="sub">只限縮「關於你」帶哪些卡；習慣選項與分類的規矩不受它影響。</span></h5>
    <div class="list">${d.identities.map(item).join('') || '<div class="none">還沒有身分</div>'}</div>
    <div class="addrow"><input class="notein" id="id-new" placeholder="新身分的名字，例：跟客戶開會的我" style="margin:0"><button class="btn sm2" data-act="id-add"><i class="ph ph-plus"></i>新增身分</button></div></div>`;
}
// 角色情境／常用片段＝常用預設庫（presets.json）的 role_context／snippet 欄：列表改刪；抽屜的常用列讀同一份。編輯中的值在 state.settings.presetEdit
function setPresetListHtml(field, title, sub, ph) {
  const s = state.settings;
  const list = state.presets[field] ?? [];
  const e = s.presetEdit?.field === field ? s.presetEdit : null;
  const editor = () => `<div class="asset editing" data-presetedit="${field}"><div class="ih"><input class="notein" data-pf="name" value="${esc(e.name)}" placeholder="名字" style="margin:0;max-width:260px"></div>
    <textarea class="feedbackin autogrow" data-pf="text" placeholder="內容">${esc(e.text)}</textarea>
    <div class="btns" style="margin-top:8px"><button class="btn sm2 btn-primary" data-act="asset-save">存</button><button class="btn sm2 btn-ghost" data-act="asset-cancel">取消</button>${e.err ? `<span class="sub" style="margin:0;color:var(--red-text)">${esc(e.err)}</span>` : ''}</div></div>`;
  const item = (p) => (e && e.orig === p.name ? editor()
    : `<div class="asset" data-preset="${esc(p.name)}"><div class="ih"><b>${esc(p.name)}</b><span class="acts"><button class="mini" data-act="asset-edit" data-field="${field}" data-name="${esc(p.name)}">改</button><button class="mini no" data-act="asset-del" data-field="${field}" data-name="${esc(p.name)}">刪</button></span></div><div class="ib pre">${esc(p.text)}</div></div>`);
  return `<div class="group" data-presets="${field}"><h5>${esc(title)}<span class="sub">${esc(sub)}。複製式：帶進步驟後各改各的，改這裡不影響已經帶進去的。</span></h5>
    <div class="list">${list.map(item).join('')}${e && e.orig === null ? editor() : ''}${!list.length && !e ? '<div class="none">還沒有</div>' : ''}</div>
    <div class="addrow"><input class="notein" id="asset-new" placeholder="${esc(ph)}" style="margin:0"><button class="btn sm2" data-act="asset-add" data-field="${field}"><i class="ph ph-plus"></i>新增</button></div></div>`;
}

// ---------- render 與輪詢 ----------
let drawerWasOpen = false; // 上一次 render 時步驟抽屜是否開著（剛打開才捲進視野）
function render() {
  let inner;
  if (state.intro) inner = introHtml(); // 記憶輪（M2）：第一次打開先讓它認識你——蓋在儀表板前，答了或跳過才看得到別的
  else if (state.dash) inner = dashHtml();
  else if (state.calendar) inner = calendarHtml();
  else if (state.settings) inner = settingsHtml(); // 記憶輪（M5a）：設定頁，蓋在工作區上的整頁（同儀表板／行事曆）
  else if (state.library) inner = libraryHtml(); // 移植第一批 T9：流程庫頁（同上，整頁）
  else if (state.categoryPage) inner = categoryPageHtml();
  else if (state.run) inner = runHtml();
  else if (state.importScanning) {
    inner = `<div class="empty-c"><div class="ic"><i class="ph ph-magnifying-glass"></i></div>
      <h3>正在掃描這份流程檔⋯</h3><p>AI 在逐句檢查有沒有夾帶可疑指示，等它一下。</p></div>`;
  } else if (state.importPreview) inner = importPreviewHtml();
  else if (state.corrupt) inner = corruptCardHtml();
  else if (state.showTrash) inner = trashViewHtml();
  else {
    const body = state.wf && !subjectIsDraft() && state.flowTab === 'data' ? dataTabHtml() // 移植第一批 T10：本次資料分頁蓋過四種模式
      : state.mode === 'chat' ? chatModeHtml()
      : state.mode === 'canvas' ? canvasModeHtml()
        : state.mode === 'history' ? historyModeHtml()
          : listModeHtml();
    // 移植合併輪 U4b：已存流程兩個分頁都帶右側「流程資料夾」（草稿沒有側欄就不包 grid）
    const aside = flowAsideHtml();
    inner = workHeadHtml() + (aside ? `<div class="flowlayout"><section class="flowmain">${body}</section>${aside}</div>` : body);
  }
  // 預覽浮窗放在 .layout 外（.work 有 backdrop-filter，會把 fixed 定位框在自己裡面）；重繪前記住它捲到哪，重繪後放回
  const pvScroll = app.querySelector('.pvbody')?.scrollTop ?? 0;
  app.innerHTML = hostAlert() + `<div class="layout">${sideHtml()}<div class="work">${inner}${drawerHtml()}${state.calendar ? calDrawerHtml() + calModalsHtml() : ''}</div></div>` + previewHtml() + memCardModalHtml() + flowSettingsModalHtml() + flowMemModalHtml() + sharedModalHtml() + setConfirmModalHtml() + promptModalHtml(state.run ? state.promptView : state.dash?.promptView);
  if (pvScroll) { const b = app.querySelector('.pvbody'); if (b) b.scrollTop = pvScroll; }
  document.body.classList.toggle('previewing', !!state.preview); // print CSS 只印浮窗內容
  // 健檢「修這裡」亮著的期間，每次重繪都把（新的）權限列捲進視野中央——同步做（不用 rAF，分頁在背景時 rAF 不跑）；
  // 不管捲動容器是 document 還是 .work，scrollIntoView 都找得到
  if (state.permFlashUntil > Date.now()) document.getElementById('perm-files')?.scrollIntoView({ block: 'center', behavior: 'auto' });
  const cvw = app.querySelector('.cvwrap');
  if (cvw) window.BJCanvas.bind(cvw, cvHandlers);
  const log = document.getElementById('chatlog');
  if (log) log.scrollTop = log.scrollHeight; // 聊天永遠停在最新一則
  autoGrowAll();
  // 步驟抽屜剛打開：它釘在工作區頂端、高度＝一個視窗——頁面捲在別處時把它捲進來
  const dr = app.querySelector('.cvdrawer.full');
  if (dr && !drawerWasOpen) {
    const top = dr.getBoundingClientRect().top;
    if (top < 56 || top > window.innerHeight * 0.4) window.scrollBy({ top: top - 76, behavior: 'smooth' });
  }
  drawerWasOpen = !!dr;
}

function pollProposalsSoon(w) {
  for (const ms of [800, 3000, 8000, 20000, 45000]) {
    setTimeout(async () => {
      try {
        const before = state.proposals.pending.length;
        await refreshProposals(w);
        const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && document.activeElement.value;
        if (state.proposals.pending.length !== before && !typing) render();
      } catch { /* 靜候下次 */ }
    }, ms);
  }
}

function schedulePoll(recordDelay) {
  clearTimeout(state.pollTimer);
  const run = state.run;
  const running = run?.status === 'running';
  // running 照舊每秒輪詢；跑完後只在「監工開、紀錄還沒到手、還在等待窗內」時續輪詢，其餘（含舊 run 永遠沒有 record）就停
  if (!running && !recordPending(run)) return;
  const delay = running ? 1000 : (recordDelay || 2000);
  state.pollTimer = setTimeout(async () => {
    try {
      const before = state.run.status;
      const w = state.run.workflow;
      const fresh = await api('GET', `${wfPath(w)}/runs/${state.run.run_id}`);
      const json = JSON.stringify(fresh);
      const changed = json !== state.runJson; // 沒變就不重繪——並行支線等你貼內容時，另一支跑著也不會每秒洗掉你的字
      state.runJson = json;
      state.run = { ...fresh, workflow: w };
      if (before !== 'done' && state.run.status === 'done') pollProposalsSoon(w);
      if (changed) render();
    } catch { /* 下一輪再試 */ }
    schedulePoll(running ? undefined : 5000); // 跑完等紀錄：第一次 2 秒，之後退避到 5 秒
  }, delay);
}

async function refreshRun() {
  const w = state.run.workflow;
  const before = state.run.status;
  const fresh = await api('GET', `${wfPath(w)}/runs/${state.run.run_id}`);
  state.runJson = JSON.stringify(fresh);
  state.run = { ...fresh, workflow: w };
  if (before !== 'done' && state.run.status === 'done') pollProposalsSoon(w);
  render();
  schedulePoll();
}

// 聊天：對草稿講＝改草稿；對已存流程講＝直接改它（走版本履歷，可退回）
async function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input?.value.trim();
  if (!text || state.chat.busy) return;
  state.chat.messages.push({ role: 'user', text });
  state.chat.busy = true;
  render();
  try {
    const current = subjectDef();
    const out = await api('POST', '/api/compose', {
      messages: state.chat.messages.filter((m) => m.role === 'user' || m.role === 'ai'), // 錯誤氣泡與記憶通知行不是對話
      current_draft: current,
      // 記憶輪（M1c）：已存流程＝它所在的分類；草稿＝拆解器問過後寫在頂層的 category——伺服器拿它讀群組規矩
      category: subjectIsDraft() ? (state.chat.draft?.category ?? null) : (state.wf?.category ?? null),
    });
    if (state.wf && !subjectIsDraft()) {
      delete out.draft.category; // 分類是路徑，不進 workflow.yaml；PUT 不會替你剝（新建那條路在 confirm-save-draft 剝）
      await api('PUT', wfPath(state.wf), { def: out.draft });
      state.wf.def = out.draft;
      state.chat.messages.push({ role: 'ai', text: (out.reply || '改好了。') + '\n（已存檔＋記進履歷，改壞了到「履歷」退回）' });
    } else {
      state.chat.draft = out.draft;
      state.chat.messages.push({ role: 'ai', text: out.reply || '拆好了，切到「清單」或「畫布」看草稿。' });
    }
    if (out.memory_notice) state.chat.messages.push({ role: 'memnotice', notice: out.memory_notice }); // 記憶輪（M2）記路④：這句被記成什麼
  } catch (e) {
    state.chat.messages.push({ role: 'error', text: e.message });
  }
  state.chat.busy = false;
  render();
}

// ---------- 畫布編輯操作 ----------
async function saveDef(def) {
  if (subjectIsDraft()) {
    state.chat.draft = def; // 草稿只留在本地，存庫時才驗
    return;
  }
  await api('PUT', wfPath(state.wf), { def });
  state.wf.def = def;
}

const makeTask = (title) => ({ id: newNodeId(), title, executor: 'ai', stop_point: 'never', instruction: '（描述這一步要做什麼）', next: [] });

// 拆掉一個節點：前驅直接接到它的全部下游——分岔點拆掉＝各路變成同時做、多出線 task 拆掉＝前驅接手全部出線。
// 前驅若是分岔的一條路，一條路只能指一步：接第一個下游（其餘下游成自由步驟，離開畫布才查）
function removeNodeSimple(def, id) {
  const n = def.nodes.find((x) => x.id === id);
  if (!n) return;
  const targets = outgoingOf(n).filter((t) => def.nodes.some((x) => x.id === t));
  for (const p of def.nodes) {
    if (p.id === id) continue;
    if (kindOf(p) === 'branch') {
      for (const b of p.branches) if (b.next === id) b.next = targets[0] ?? null;
      p.branches = p.branches.filter((b) => b.next);
    } else if ((p.next ?? []).includes(id)) {
      p.next = [...new Set(p.next.flatMap((t) => (t === id ? targets : [t])))];
    }
  }
  def.nodes = def.nodes.filter((x) => x.id !== id);
  if (state.canvasSel === id) { state.canvasSel = null; state.drawerOpen = false; }
}

// 拆掉一個舊式 fork/join：同 removeNodeSimple，但「分岔路接進多目標 fork」的形狀會遺失路徑資訊
// （一條路只能指一步）→ 回 false 留著不拆，執行不受影響
function dissolveStructural(def, node) {
  const targets = outgoingOf(node).filter((t) => def.nodes.some((x) => x.id === t));
  const hasBranchPred = def.nodes.some((p) => kindOf(p) === 'branch' && (p.branches ?? []).some((b) => b.next === node.id));
  if (hasBranchPred && targets.length > 1) return false;
  removeNodeSimple(def, node.id);
  return true;
}

// 收整結構：每次編輯順手把舊式 join 拆成直接連線（會合=多入線；進履歷，可退回）。
// 並行點（fork）與分岔是調色盤的正式元件，不自動拆——線夠不夠由離開畫布檢查把關
function normalize(def) {
  const keep = new Set(); // 拆不動的舊結構（見 dissolveStructural）
  for (let guard = 0; guard < 60; guard++) {
    const s = def.nodes.find((n) => !keep.has(n.id) && kindOf(n) === 'join');
    if (!s) return;
    if (!dissolveStructural(def, s)) keep.add(s.id);
  }
}

// 畫布上一步／重做（畫布回饋輪）：每次成功的畫布編輯先照快照；換流程（或草稿）自動歸零
const cvHistory = { key: null, undo: [], redo: [] };
function cvHistoryFor() {
  const k = subjectIsDraft() ? 'draft' : state.wf ? `${state.wf.category}/${state.wf.id}` : null;
  if (cvHistory.key !== k) { cvHistory.key = k; cvHistory.undo = []; cvHistory.redo = []; }
  return cvHistory;
}
// 套用一份快照：畫布模式的已存流程只進工作本（未存檔）；草稿與清單模式照舊直寫
async function cvApplySnapshot(snap) {
  if (!subjectIsDraft() && state.mode === 'canvas') {
    state.cvWork = structuredClone(snap);
    state.cvDirty = true;
  } else {
    await saveDef(structuredClone(snap));
  }
  if (state.canvasSel && !snap.nodes.some((n) => n.id === state.canvasSel)) { state.canvasSel = null; state.drawerOpen = false; }
  render();
}
async function cvUndo() {
  const h = cvHistoryFor();
  if (!h.undo.length) return;
  const cur = structuredClone(cvDef());
  const prev = h.undo.pop();
  h.redo.push(cur); // 先進堆疊再套用——套用尾端的 render 才畫得出正確的鈕態
  try { await cvApplySnapshot(prev); } catch (e) { h.undo.push(prev); h.redo.pop(); window.alert(e.message); render(); }
}
async function cvRedo() {
  const h = cvHistoryFor();
  if (!h.redo.length) return;
  const cur = structuredClone(cvDef());
  const nxt = h.redo.pop();
  h.undo.push(cur);
  try { await cvApplySnapshot(nxt); } catch (e) { h.redo.push(nxt); h.undo.pop(); window.alert(e.message); render(); }
}

async function canvasOp(fn) {
  const before = structuredClone(cvDef());
  const def = structuredClone(before);
  fn(def);
  normalize(def);
  if (def.canvas?.positions) { // 已刪節點的座標不留死資料
    for (const id of Object.keys(def.canvas.positions)) {
      if (!def.nodes.some((n) => n.id === id)) delete def.canvas.positions[id];
    }
  }
  if (!subjectIsDraft() && state.mode === 'canvas') {
    // v0.18：畫布改動先進工作本，按「存檔」才落地（清單模式的編輯抽屜照舊即改即存）
    state.cvWork = def;
    state.cvDirty = true;
  } else {
    await saveDef(def);
  }
  const h = cvHistoryFor();
  h.undo.push(before);
  if (h.undo.length > 50) h.undo.shift();
  h.redo = [];
  render();
}

// 存檔（v0.18）：工作本落地＋連接檢查——照存不擋，但沒接好會標紅並講明「開始不了」
async function cvSave() {
  if (subjectIsDraft() || !state.cvDirty || !state.cvWork) return;
  const def = state.cvWork;
  const issues = canvasIssues(def);
  try {
    await saveDef(structuredClone(def));
  } catch (e) {
    window.alert(e.message);
    render();
    return;
  }
  state.cvWork = null;
  state.cvDirty = false;
  state.cvShowIssues = issues.length > 0;
  if (issues.length) window.alert(`已存檔。注意：有 ${issues.length} 處還沒接好（已標紅）——接好並存檔之前，這個流程按「開始」不會跑。`);
  render();
}

// ---------- 畫布自由化（F5）：拖擺存座標、拉線接人、剪線、線上插步 ----------
const gsnap = (v) => Math.max(0, Math.round(v / 16) * 16);
function setPos(def, id, x, y) {
  ((def.canvas ??= {}).positions ??= {})[id] = { x, y };
}
// from 出發沿出邊走不走得到 to（接線前的繞圈檢查）
function canReach(def, from, to) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop();
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = def.nodes.find((x) => x.id === id);
    if (n) stack.push(...outgoingOf(n));
  }
  return false;
}
// 接一條線：branch=多一條路（給預設條件名）、其他=多接一條出線（並行）；重複的線不重加
function doConnect(def, from, to) {
  if (from === to) throw new Error('自己接自己會原地打轉——接別的節點');
  const f = def.nodes.find((n) => n.id === from);
  if (canReach(def, to, from)) throw new Error('這樣會繞圈圈——流程只能一路往前');
  if (kindOf(f) === 'branch') { if (!f.branches.some((b) => b.next === to)) f.branches.push({ label: `情況${f.branches.length + 1}`, next: to }); }
  else if (!(f.next ?? []).includes(to)) (f.next ??= []).push(to);
}

// 畫布問題清單：未接進流程的步驟 ＋ 線不足兩條的並行／分岔點（離開畫布前標紅擋下）
function canvasIssues(def) {
  const thin = def.nodes
    .filter((n) => (kindOf(n) === 'fork' && (n.next ?? []).length < 2) || (kindOf(n) === 'branch' && (n.branches ?? []).length < 2))
    .map((n) => n.id);
  return [...new Set([...unconnectedIds(def), ...thin])];
}

// 離開畫布前的接線檢查（D17）：還沒接進流程的步驟要標紅、擋下切換。
// 接進流程＝與第一顆節點連在同一張圖（不分方向）——多起點平行流程合法（與後端 schema.js 同規則）
function unconnectedIds(def) {
  if (!def || def.nodes.length < 2) return [];
  const adj = new Map(def.nodes.map((n) => [n.id, new Set()]));
  for (const n of def.nodes) {
    for (const t of outgoingOf(n)) {
      if (!adj.has(t)) continue;
      adj.get(n.id).add(t);
      adj.get(t).add(n.id);
    }
  }
  const seen = new Set([def.nodes[0].id]);
  const stack = [def.nodes[0].id];
  while (stack.length) {
    for (const t of adj.get(stack.pop()) ?? []) if (!seen.has(t)) { seen.add(t); stack.push(t); }
  }
  return def.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
}
// 離開畫布（v0.18 定案）：接線問題不擋離開（存檔時警告、開跑時才真擋），只顧未存檔的改動
function canvasLeaveBlocked() {
  if (state.mode !== 'canvas' || state.run) return false;
  if (!subjectIsDraft() && state.cvDirty) {
    const ok = window.confirm('畫布的改動還沒存檔——直接離開會丟掉這些改動。\n要丟掉並離開按「確定」；要回去按「存檔」請按「取消」。');
    if (!ok) return true;
    const h = cvHistoryFor(); // 丟棄工作本：上一步串一併清掉，免得退回到已丟棄的狀態
    h.undo = [];
    h.redo = [];
  }
  state.cvWork = null;
  state.cvDirty = false;
  state.cvShowIssues = false;
  return false;
}
// 打開一條流程（側欄點選、監工紀錄的「改這裡」共用）：讀定義＋執行清單＋提議＋參考檔，工作區狀態歸零。
// 不自己 render()——呼叫端可能還要接著切畫布、開抽屜，一次畫完就好。壞檔回 false（畫面已切到「讀不懂」卡）。
async function openWorkflow(category, id) {
  closeCalendar();
  closeDash();
  closeCategory();
  closeSettings(); closeLibrary();
  let def;
  try {
    def = await api('GET', wfPath({ category, id }));
  } catch (err) {
    if (err.message.includes('讀不懂')) {
      state.corrupt = { category, id, message: err.message };
      state.showTrash = false;
      return false;
    }
    throw err;
  }
  const runs = await api('GET', `${wfPath({ category, id })}/runs`);
  if (state.wf && !subjectIsDraft()) chatByFlow.set(flowKey(state.wf), state.chat);
  state.wf = { category, id, def, runs };
  state.run = null;
  state.chat = chatByFlow.get(flowKey({ category, id })) ?? { messages: [], draft: null, busy: false };
  state.paramNow = {};
  state.editingParam = null;
  state.editingNode = null;
  state.drawerOpen = false;
  state.cvShowIssues = false;
  state.addingParam = false;
  state.expanded = new Set();
  state.mode = 'list';
  state.flowTab = 'design'; // 移植第一批 T10：換流程回設計分頁、關兩浮窗
  state.flowSettingsOpen = false;
  state.flowMemOpen = false;
  state.sharedOpen = false; // 移植合併輪 U4b：換流程關共用檔浮窗、資料夾兩塊回預設展開、「查看全部」收回
  state.folderOpen = { refs: true, runs: true, optional: null, refsAll: false, runsAll: false };
  state.wfRuns = [];
  state.shared = { company: null, dept: null, err: null };
  state.feedbackSent = false;
  state.showTrash = false;
  state.corrupt = null;
  state.canvasSel = null;
  window.BJCanvas.resetView();
  state.versions = await api('GET', `${wfPath(state.wf)}/versions`);
  await refreshProposals(state.wf);
  state.wfFiles = await api('GET', `${wfPath(state.wf)}/files`);
  await refreshFolder(); // 右側資料夾：歷次執行摘要＋兩層共用檔（任一讀不到＝該塊印讀不到，流程照開）
  // 記憶輪（M3b）：開跑表單的習慣選項與身分——換流程即歸零（點過的卡、改掉的、展開的、身分都只屬於這條流程這一次）
  state.wfMemory = null;
  state.memPicks = {};
  state.memChanged = [];
  state.memMore = {};
  state.memIdentity = '';
  state.memIdentitySet = false; // 沒動過下拉＝用後端回的預設（綁這個分類的身分）
  await refreshWfMemory();
  return true;
}

// 「改這裡」：回工作區打開那條流程，切到畫布並開那一步的抽屜（清單視圖看不到抽屜）。
// 監工紀錄的建議列與「接受監工建議」的提議卡共用這一段。
async function gotoNode(category, id, nodeId) {
  clearTimeout(state.pollTimer);
  if (!await openWorkflow(category, id)) { render(); return; }
  state.mode = 'canvas';
  state.canvasSel = nodeId;
  state.drawerOpen = true;
  render();
}

async function cvEdit(fn) {
  try {
    await canvasOp(fn);
  } catch (e) {
    window.alert(e.message);
    render(); // 畫面可能已被拖歪，照存檔狀態畫回來
  }
}
const cvHandlers = {
  onMove: (id, x, y) => cvEdit((def) => setPos(def, id, x, y)),
  // 雙擊節點 → 右側抽屜
  onOpen: (id) => { state.canvasSel = id; state.drawerOpen = true; render(); },
  // 雙擊空白 → 自由步驟（不強迫接線），順手開抽屜讓他命名
  onNewAt: (x, y) => cvEdit((def) => {
    const t = makeTask('新步驟');
    def.nodes.push(t);
    setPos(def, t.id, x, y);
    state.canvasSel = t.id;
    state.drawerOpen = true;
  }),
  onConnect: (from, to) => {
    const def = cvDef();
    if (canReach(def, to, from)) { window.alert('這樣會繞圈圈——流程只能一路往前'); return; }
    const f = def.nodes.find((n) => n.id === from);
    if (kindOf(f) === 'task' && (f.next ?? []).length && !f.next.includes(to)) {
      window.alert('一個步驟只接一條出線。要同時做幾件事：按下方「並行」放一顆並行點再拉線；要依情況走不同路：放「分岔」。');
      return;
    }
    cvEdit((d) => doConnect(d, from, to));
  },
  onNewFrom: (from, x, y) => {
    const f = cvDef().nodes.find((n) => n.id === from);
    if (kindOf(f) === 'task' && (f.next ?? []).length) {
      window.alert('一個步驟只接一條出線。要同時做幾件事：按下方「並行」放一顆並行點再拉線；要依情況走不同路：放「分岔」。');
      return;
    }
    cvEdit((d) => {
      const t = makeTask('新步驟');
      d.nodes.push(t);
      setPos(d, t.id, x, y);
      state.canvasSel = t.id;
      doConnect(d, from, t.id);
      state.drawerOpen = true;
    });
  },
  // 調色盤：點圖示＝在視野中央生一顆該型態的節點，接線自己拉
  onAdd: (kind, x, y) => cvEdit((def) => {
    const n = kind === 'fork' ? { id: newNodeId(), title: '並行', kind: 'fork', next: [] }
      : kind === 'branch' ? { id: newNodeId(), title: '分岔', kind: 'branch', instruction: '（寫人話判斷依據，例如：金額超過五千）', branches: [], next: [] }
        : makeTask('新步驟');
    def.nodes.push(n);
    setPos(def, n.id, x, y);
    state.canvasSel = n.id;
    state.drawerOpen = true;
  }),
  onCut: (edge) => cvEdit((def) => {
    const f = def.nodes.find((n) => n.id === edge.from);
    if (kindOf(f) === 'branch') f.branches.splice(edge.arm, 1);
    else f.next = (f.next ?? []).filter((t) => t !== edge.to);
    // 剪到剩一條＝自動拉直（D17 慣例）；剪到零條就留著點，讓使用者重拉或刪
    if (['branch', 'fork'].includes(kindOf(f)) && outgoingOf(f).length === 1) removeNodeSimple(def, f.id);
  }),
  onInsert: (edge, mid) => cvEdit((def) => {
    const f = def.nodes.find((n) => n.id === edge.from);
    const t = makeTask('新步驟');
    def.nodes.push(t);
    t.next = [edge.to];
    setPos(def, t.id, gsnap(mid.x - 88), gsnap(mid.y - 38));
    if (kindOf(f) === 'branch') f.branches[edge.arm].next = t.id;
    else f.next = (f.next ?? []).map((x) => (x === edge.to ? t.id : x)); // 只改這一條線，其他出線不動
    state.canvasSel = t.id;
    state.drawerOpen = true;
  }),
};

// ---------- 事件 ----------
app.addEventListener('keydown', (e) => {
  if (e.target.id === 'chat-input' && e.key === 'Enter') sendChat();
  if (e.target.matches?.('[data-pedit]') && e.key === 'Enter') commitParamEdit(e.target);
  if (e.target.id === 'set-company-name' && e.key === 'Enter') e.target.blur(); // 設定→資料 公司名稱（U3）：Enter＝失焦，交給 change 存
});

// 畫布快捷鍵：Ctrl+Z 上一步、Ctrl+Shift+Z / Ctrl+Y 重做、Ctrl+S 存檔（打字中不攔，交還瀏覽器原生行為）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.memModal) { state.memModal = null; render(); return; } // 卡片浮窗（記憶輪 M4）：Esc 關
  if (e.key === 'Escape' && state.flowMemOpen) { state.flowMemOpen = false; render(); return; } // 記憶浮窗（T10）：Esc 關
  if (e.key === 'Escape' && state.flowSettingsOpen) { state.flowSettingsOpen = false; render(); return; } // 流程設定浮窗（T10）：Esc 關
  if (e.key === 'Escape' && state.sharedOpen) { state.sharedOpen = false; render(); return; } // 共用檔浮窗（U4b）：Esc 關
  if (e.key === 'Escape' && state.dash?.usageOpen) { state.dash.usageOpen = false; render(); return; } // 用量明細浮窗（U5）：Esc 關
  if (e.key === 'Escape' && state.promptView) { state.promptView = null; render(); return; } // 執行頁卷宗浮窗（U6b）：Esc 關
  if (e.key === 'Escape' && state.settings?.confirm && !state.settings.busy) { state.settings.confirm = null; render(); return; } // 清空記憶的二次確認（M5b）：Esc 關
  if (e.key === 'Escape' && state.preview) { state.preview = null; render(); return; } // 成品預覽浮窗：Esc 關
  if (e.key === 'Escape' && state.calPicker) { state.calPicker = null; render(); return; } // 快速跳月浮層：Esc 關
  if (state.mode !== 'canvas' || state.run || state.dash || state.calendar || state.categoryPage || state.settings) return; // 儀表板/行事曆/分類頁/設定頁蓋在上面時畫布不收快捷鍵
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.target.matches?.('input, textarea, select, [contenteditable]')) return;
  const k = e.key.toLowerCase();
  if (k === 'z') { e.preventDefault(); if (e.shiftKey) cvRedo(); else cvUndo(); }
  else if (k === 'y') { e.preventDefault(); cvRedo(); }
  else if (k === 's') { e.preventDefault(); cvSave(); }
});

// 關頁前的最後防線：畫布還有未存檔改動時，瀏覽器會攔一下
window.addEventListener('beforeunload', (e) => {
  if (state.cvDirty) { e.preventDefault(); e.returnValue = ''; }
});

app.addEventListener('focusout', (e) => {
  if (e.target.matches?.('[data-pedit]') && state.editingParam) commitParamEdit(e.target);
});

// 權限列亮框動畫一跑完就收（比 1.5 秒的計時器準；計時器留著兜底，例如系統關掉動畫時）
app.addEventListener('animationend', (e) => {
  if (e.target.id === 'perm-files' && e.animationName === 'permflash') {
    state.permFlashUntil = 0;
    e.target.classList.remove('flash');
  }
});

// 多行框（T5）：邊打邊存進 state.keep（重繪後放回）＋自動長高
app.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches?.('[data-keep]')) state.keep[keepKey(t.id)] = t.value;
  if (t.matches?.('textarea.autogrow')) autoGrow(t);
  if (t.dataset?.param !== undefined) { // 「本次資料」邊打邊存＋句內膠囊就地同步（不等 change、不重繪）；點過的卡被改字＝取消核可
    state.paramNow[t.dataset.param] = t.value;
    syncParamChips(t.dataset.param, t.value);
    memParamEdited(t.dataset.param, t.value);
  }
  if (t.id === 'cal-pick-year' && state.calPicker && /^\d{4}$/.test(t.value)) { // 年份直接打：存進 state、月格就地更新
    state.calPicker.year = Number(t.value);
    patchCalPickerGrid();
  }
  // 設定頁的編輯表單（記憶輪 M5a）：身分名字、角色／片段的名字與內容每打一字寫進 state，重繪從它還原
  if (t.id === 'lib-search' && state.library) { // 流程庫頁搜尋：只換卡片格，不整頁重繪
    state.library.q = t.value;
    const g = document.getElementById('lib-grid');
    if (g) g.innerHTML = libraryCardsHtml();
  }
  if (t.dataset?.idf && state.settings?.idEdit) state.settings.idEdit[t.dataset.idf] = t.value;
  if (t.dataset?.pf && state.settings?.presetEdit) state.settings.presetEdit[t.dataset.pf] = t.value;
  keepModalField(t);
});

// 行事曆浮窗表單暫存（T3）：排程視窗 sc-*／步驟浮窗 sm-* 每個欄位一改就寫進各自的 form——
// 整頁重繪（calendarPoll 每 5 秒）照 form 還原，值不會丟
const MODAL_FIELDS = {
  'sc-wf': ['schedModal', 'wf'], 'sc-freq': ['schedModal', 'freq'], 'sc-weekday': ['schedModal', 'weekday'], 'sc-day': ['schedModal', 'day'],
  'sc-time': ['schedModal', 'time'], 'sc-at': ['schedModal', 'at'], 'sc-lead': ['schedModal', 'lead'], 'sc-makeup': ['schedModal', 'makeup'], 'sc-enabled': ['schedModal', 'enabled'],
  'sm-instruction': ['stepModal', 'instruction'], 'sm-review': ['stepModal', 'review'], 'sm-tier': ['stepModal', 'tier'], 'sm-retry': ['stepModal', 'retry'],
};
function keepModalField(t) {
  const hit = MODAL_FIELDS[t.id];
  const form = hit && state[hit[0]]?.form;
  if (!form) return false;
  form[hit[1]] = t.type === 'checkbox' ? t.checked : t.value;
  return true;
}

app.addEventListener('change', async (e) => {
  if (keepModalField(e.target) && e.target.id === 'sc-freq') { render(); return; } // 換頻率＝換露出的欄位，重繪（值都在 form 裡）
  if (e.target.id === 'move-select') {
    const to = e.target.value;
    if (to === state.wf.category) return;
    try {
      await api('POST', `${wfPath(state.wf)}/move`, { to });
      state.wf.category = to;
      await refreshLibrary();
      render();
    } catch (err) {
      window.alert(err.message);
      render();
    }
  }
  if (e.target.id === 'save-category') {
    const newInput = document.getElementById('save-new-category');
    if (newInput) newInput.style.display = e.target.value === '__new__' ? '' : 'none';
  }
  if (e.target.id === 'mem-identity') { // 這次以哪個身分跑（記憶輪 M3b）：隨「開始」送出；換了身分重抓這條流程會帶什麼（兩格、抽屜一列跟著變，M5a）
    state.memIdentity = e.target.value;
    state.memIdentitySet = true;
    await refreshWfMemory();
    render();
  }
  if (e.target.id === 'set-company-name' && state.settings?.data) { // 設定→資料 公司名稱（移植合併輪 U3）：change 即 PUT；成功同步側欄／麵包屑／公司頁用的 state.companyName；失敗一句＋重繪撥回現值
    const s = state.settings;
    const name = e.target.value.trim();
    try {
      await api('PUT', '/api/settings', { company_name: name });
      s.data.cfg.company_name = name;
      state.companyName = name;
      s.msg = { key: 'company', text: name ? `改好了，側欄與麵包屑現在叫「${name}」。` : '清空了，改顯示「公司」。' };
    } catch (err) { s.msg = { key: 'company', text: err.message, err: true }; }
    render();
  }
  // 設定頁（記憶輪 M5a）：身分編輯的勾選寫進 state（不重繪）；詞典改性質即 PUT；合併的「併進哪個」記住
  if (e.target.dataset?.idc !== undefined && state.settings?.idEdit) {
    if (e.target.checked) state.settings.idEdit.cards.add(e.target.dataset.idc); else state.settings.idEdit.cards.delete(e.target.dataset.idc);
  }
  if (e.target.dataset?.dictKind !== undefined && state.settings) {
    try { await api('PUT', `/api/memory/dict/${encodeURIComponent(e.target.dataset.dictKind)}`, { kind: e.target.value }); } catch (err) { window.alert(err.message); }
    await loadSettings();
    render();
  }
  if (e.target.dataset?.mergeKeep !== undefined && state.settings?.merge) state.settings.merge.keep = e.target.value;
  // [data-param] 的 change 不再整頁重繪：值與句內膠囊已在 input 事件同步；blur 重繪會吃掉正要按下的「開始」
  if (e.target.dataset?.req !== undefined && state.wf && !subjectIsDraft()) { // 欄位「必填」勾選：直接存進流程定義
    const def = structuredClone(state.wf.def);
    const p = def.params.find((x) => x.key === e.target.dataset.req);
    if (!p) return;
    if (e.target.checked) p.required = true; else delete p.required;
    await api('PUT', wfPath(state.wf), { def });
    state.wf.def = def;
    render();
  }
  if (e.target.dataset?.presetFor && e.target.value) {
    const p = (state.presets[e.target.dataset.presetField] ?? []).find((x) => x.name === e.target.value);
    const target = document.getElementById(e.target.dataset.presetFor);
    if (p && target) target.value = p.text; // 複製式：填入後各改各的
    e.target.value = '';
  }
});

// 參考檔上傳：讀檔→base64→上傳→只重畫檔案區（不洗抽屜）
document.getElementById('ref-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.wf) return;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    await api('POST', `${wfPath(state.wf)}/files`, { name: file.name, content_b64: btoa(bin) });
    await refreshRefSection();
    repaintAside(); // 移植合併輪 U4b：側欄「流程參考檔」也從這顆「上傳參考檔」進來——只換側欄，抽屜開著時不整頁重繪
  } catch (err) {
    window.alert(err.message);
  }
});

// 移植合併輪 U2b：公司頁／部門頁共用檔上傳——層與區看 state.sharedUpload；規範區前端先擋副檔名（句子同伺服器），伺服器再擋一次；
// 成功＝POST 回的就是最新清單，直接換上；失敗一句紅字印在該區標題下（伺服器訊息原句：413 太長／409 同名／400 格式）
document.getElementById('shared-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const up = state.sharedUpload;
  const cp = state.categoryPage;
  if (!file || !up || !cp || cp.category !== up.scope) return;
  cp.uploadErr = null;
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? '').toLowerCase();
  if (up.kind === 'rule' && !/^(md|txt|docx)$/.test(ext)) {
    cp.uploadErr = { kind: 'rule', text: ext === 'xlsx' ? '表格不是規範，請放參考' : ext === 'pdf' ? 'PDF 還轉不了文字，請改上傳 docx 或貼文字' : '規範只收 md、txt、docx' };
    render();
    return;
  }
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const shared = await api('POST', sharedPath(up.scope), { name: file.name, kind: up.kind, content_b64: btoa(bin) });
    if (state.categoryPage !== cp) return;
    cp.shared = shared;
  } catch (err) {
    cp.uploadErr = { kind: up.kind, text: err.message };
  }
  render();
});

app.addEventListener('click', async (e) => {
  const pv = e.target.closest('.pchip.pv');
  if (pv) {
    state.editingParam = pv.dataset.pkey;
    render();
    const ed = document.querySelector('[data-pedit]');
    if (ed) { ed.focus(); ed.select(); }
    return;
  }
  const lbl = e.target.closest('.edgelbl');
  if (lbl && state.mode === 'canvas' && !state.run) { // 點路條件小標 → 開該分岔的抽屜
    state.canvasSel = lbl.dataset.from;
    state.drawerOpen = true;
    render();
    return;
  }
  const nodeEl = e.target.closest('[data-node]');
  if (nodeEl && state.mode === 'canvas' && !state.run && !nodeEl.dataset.act) {
    state.canvasSel = nodeEl.dataset.node;
    render();
    return;
  }
  // 快速跳月浮層：點浮層外就關（點的若是別的動作，關掉後照常執行；el 已從 closest 取得，重繪不影響）
  if (state.calPicker && !e.target.closest('#cal-picker') && !e.target.closest('[data-act="cal-pick"]')) {
    state.calPicker = null;
    render();
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  try {
    if (act === 'reconnect') { await refreshHealth(); render(); }
    // ===== 儀表板（儀表板輪）=====
    else if (act === 'open-dash') {
      if (canvasLeaveBlocked()) return;
      clearTimeout(state.pollTimer);
      closeCalendar();
      closeCategory();
      closeSettings(); closeLibrary();
      state.run = null;
      state.showTrash = false;
      state.importPreview = null;
      state.dash = { data: null, usageView: 'flow', open: {}, promptView: null, usageOpen: false, showAll: false, calendar: null };
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {}); // 通知住在這頁——授權一次；被拒頁內照常
      }
      render();
      await loadDash();
      render();
      dashPoll();
    } else if (act === 'dash-usage-view') { state.dash.usageView = el.dataset.view; render(); }
    else if (act === 'dash-usage-open') { state.dash.usageOpen = true; render(); }
    else if (act === 'dash-usage-close' || (act === 'dash-usage-back' && e.target === el)) { state.dash.usageOpen = false; render(); }
    else if (act === 'dash-show-all') { state.dash.showAll = !state.dash.showAll; render(); }
    else if (act === 'dash-expand') {
      const key = el.dataset.key;
      if (key in state.dash.open) { delete state.dash.open[key]; render(); return; }
      state.dash.open[key] = null; // 先開骨架（讀取中）
      render();
      const { cat, id, rid } = el.dataset;
      const base = `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}/runs/${rid}`;
      const [run, prompts] = await Promise.all([api('GET', base), api('GET', `${base}/prompts`).catch(() => [])]);
      if (state.dash && key in state.dash.open) {
        state.dash.open[key] = { run, prompts, cat, id, rid };
        render();
      }
    } else if (act === 'dash-prompt') {
      const { cat, id, rid, pname, ptitle } = el.dataset;
      const rec = await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}/runs/${rid}/prompts/${encodeURIComponent(pname)}`);
      state.dash.promptView = { title: ptitle, text: rec.text };
      render();
    } else if (act === 'dash-prompt-close' || act === 'prompt-close' || ((act === 'dash-prompt-back' || act === 'prompt-back') && e.target === el)) {
      // 卷宗浮窗關閉（U6b 起儀表板與執行頁同一張 promptModalHtml；舊鍵留著，兩邊都清）
      if (state.dash) state.dash.promptView = null;
      state.promptView = null;
      render();
    } else if (act === 'run-prompt') {
      // 執行頁右欄「當時指示」（U6b）：抓這一步的卷宗全文→state.promptView→重繪（浮窗掛 .layout 外，輪詢重繪不會關）
      const w = state.run.workflow;
      let text;
      try { text = (await api('GET', `/api/workflows/${encodeURIComponent(w.category)}/${encodeURIComponent(w.id)}/runs/${state.run.run_id}/prompts/${encodeURIComponent(el.dataset.pname)}`)).text; }
      catch { text = '讀不到這一步的指示——這步可能還沒送出過工作單'; }
      state.promptView = { title: el.dataset.ptitle, text };
      render();
    }
    // ===== 成品預覽浮窗＋文字成品排版（產檔輪）=====
    else if (act === 'preview-file') {
      e.preventDefault(); // chip 在 <summary> 裡時，別順手把成品收起來
      const { cat, id, rid, fname } = el.dataset;
      await openPreview(cat, id, rid, fname);
    } else if (act === 'preview-close' || (act === 'preview-back' && e.target === el)) { state.preview = null; render(); }
    else if (act === 'preview-sheet') { state.preview.sheet = Number(el.dataset.i); render(); }
    else if (act === 'preview-print') window.print();
    else if (act === 'md-toggle') {
      e.preventDefault();
      const k = el.dataset.key;
      if (state.rawView.has(k)) state.rawView.delete(k); else state.rawView.add(k);
      applyMdView(k);
    } else if (act === 'perm-files-toggle') {
      // 產檔權限開關：切換即 PUT 定義；沒存成就把開關撥回去、在列上講一句
      const def = structuredClone(state.wf.def);
      def.permissions = { ...(def.permissions ?? {}), files: el.checked };
      state.permErr = null;
      try {
        await api('PUT', wfPath(state.wf), { def });
      } catch (err) {
        state.permErr = `沒存成：${err.message}`;
        render();
        return;
      }
      state.wf.def = def;
      if (state.cvWork) state.cvWork.permissions = def.permissions; // 畫布工作本同步，之後存檔不會把開關蓋回去
      render();
    }
    // ===== 交貨查核（交貨查核輪）=====
    else if (act === 'check-toggle' || act === 'facts-toggle' || act === 'supervisor-toggle') {
      // 三個流程層開關：切換即 PUT 定義；沒存成就講一句並把開關撥回原樣（重繪照定義畫）。
      // check 兩個開關一律展開既有值再改——整張換掉會把旁邊那個靜默撥回缺省
      const def = structuredClone(state.wf.def);
      if (act === 'supervisor-toggle') def.supervisor = { ...(def.supervisor ?? {}), enabled: el.checked };
      else def.check = { ...(def.check ?? {}), [act === 'check-toggle' ? 'enabled' : 'facts']: el.checked };
      try {
        await api('PUT', wfPath(state.wf), { def });
      } catch (err) {
        window.alert(`沒存成：${err.message}`);
        render();
        return;
      }
      state.wf.def = def;
      // 畫布工作本同步，之後存檔不會把開關蓋回去
      if (state.cvWork) {
        if (act === 'supervisor-toggle') state.cvWork.supervisor = def.supervisor;
        else state.cvWork.check = def.check;
      }
      render();
    } else if (act === 'check-retry') {
      const node = el.dataset.node;
      const note = document.getElementById(`check-note-${node}`)?.value.trim() ?? '';
      await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/check-retry`, { node, note: note || null });
      delete state.keep[keepKey(`check-note-${node}`)];
      await refreshRun();
    } else if (act === 'check-accept') {
      const node = el.dataset.node;
      await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/check-accept`, { node });
      delete state.keep[keepKey(`check-note-${node}`)];
      await refreshRun();
    } else if (act === 'edit-rules-open') {
      delete state.keep[keepKey('edit-rules-text')]; // 別的步驟沒送出的草稿不准帶進這一步
      state.editRulesOpen = el.dataset.node;
      render();
    } else if (act === 'edit-rules-cancel') {
      state.editRulesOpen = null;
      delete state.keep[keepKey('edit-rules-text')];
      render();
    } else if (act === 'edit-rules-save') {
      const node = el.dataset.node;
      const was = state.run.steps[node]?.edit_rules ?? [];
      const scopeOf = new Map(was.map((r) => [r.text.trim(), r.scope])); // 沒改動的那幾條保住原本的範圍，新寫的一律往下游帶
      const rules = (document.getElementById('edit-rules-text')?.value ?? '')
        .split('\n').map((s) => s.trim()).filter(Boolean)
        .map((text) => ({ text, scope: scopeOf.get(text) ?? 'all' }));
      await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/edit-rules`, { node, rules });
      state.editRulesOpen = null;
      delete state.keep[keepKey('edit-rules-text')];
      await refreshRun();
    }
    // ===== 行事曆（D20）=====
    else if (act === 'open-calendar') {
      if (canvasLeaveBlocked()) return;
      clearTimeout(state.pollTimer);
      closeDash();
      closeCategory();
      closeSettings(); closeLibrary();
      state.run = null;
      state.showTrash = false;
      state.importPreview = null;
      const p = (n) => String(n).padStart(2, '0');
      const t = new Date();
      state.calendar = { month: `${t.getFullYear()}-${p(t.getMonth() + 1)}`, data: null, snapErr: null };
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {}); // 授權一次；被拒頁內照常
      }
      render();
      await loadCalendar();
      render();
      calendarPoll();
    } else if (act === 'cal-pick') {
      state.calPicker = state.calPicker ? null : { year: Number(state.calendar.month.slice(0, 4)) };
      render();
    } else if (act === 'cal-pick-year') {
      state.calPicker.year += Number(el.dataset.delta);
      render();
    } else if (act === 'cal-pick-month' || act === 'cal-pick-today') {
      state.calendar.month = act === 'cal-pick-today' ? ymOf(new Date()) : el.dataset.month;
      state.calPicker = null;
      state.calDrawer = null;
      await loadCalendar();
      render();
    } else if (act === 'cal-prev' || act === 'cal-next' || act === 'cal-today') {
      const p = (n) => String(n).padStart(2, '0');
      const t = new Date();
      state.calendar.month = act === 'cal-today' ? `${t.getFullYear()}-${p(t.getMonth() + 1)}` : calMonthShift(state.calendar.month, act === 'cal-prev' ? -1 : 1);
      state.calDrawer = null;
      await loadCalendar();
      render();
    } else if (act === 'cal-refresh') {
      const out = await api('POST', '/api/calendar/refresh', { month: state.calendar.month });
      state.calendar.snapErr = out.ok ? null : out.reason;
      await loadCalendar();
      render();
    } else if (act === 'cal-ev') {
      const kind = el.dataset.kind;
      if (el.dataset.runCat) { // 等時刻步驟 → 直接進那個 run
        const cat = el.dataset.runCat;
        const id = el.dataset.runId;
        closeCalendar();
        closeCategory();
        closeSettings(); closeLibrary();
        state.wf = { category: cat, id, def: await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}`), runs: [] };
        state.run = { ...(await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}/runs/${el.dataset.runRid}`)), workflow: { category: cat, id } };
        state.runInspect = null; // U6a：打開別的 run 重設左軌
        render();
        schedulePoll();
      } else if (kind === 'goog') {
        state.calDrawer = { kind: 'goog', title: el.dataset.title, time: el.dataset.time };
        render();
      } else if (el.dataset.sid) {
        state.calDrawer = { kind: 'sched', sid: el.dataset.sid, occ: el.dataset.occ };
        state.calDrawerDef = null;
        render();
        const sched = state.calendar.scheds.find((s) => s.id === el.dataset.sid);
        if (sched) {
          const [wc, ...wr] = sched.workflow_id.split('/');
          state.calDrawerDef = await api('GET', `/api/workflows/${encodeURIComponent(wc)}/${encodeURIComponent(wr.join('/'))}`);
          render();
        }
      }
    } else if (act === 'cal-ev-del') {
      if (!window.confirm(`取消這一次的「${el.dataset.title}」？（只影響這一次，排程照常）`)) return;
      await api('POST', `/api/schedules/${encodeURIComponent(el.dataset.sid)}/occurrence`, { occ: el.dataset.occ, action: 'skip' });
      await loadCalendar();
      render();
    } else if (act === 'cal-drawer-close') { state.calDrawer = null; render(); }
    else if (act === 'cal-run-now') {
      await api('POST', `/api/schedules/${encodeURIComponent(state.calDrawer.sid)}/run-now`, {});
      state.calDrawer = null;
      await loadCalendar();
      render();
    } else if (act === 'cal-pause') {
      const sched = state.calendar.scheds.find((s) => s.id === state.calDrawer.sid);
      await api('PUT', `/api/schedules/${encodeURIComponent(sched.id)}`, { enabled: sched.enabled === false });
      await loadCalendar();
      render();
    } else if (act === 'cal-lead-add' || act === 'cal-lead-del') {
      const sched = state.calendar.scheds.find((s) => s.id === state.calDrawer.sid);
      const leads = [...(sched.remind_leads ?? [])];
      if (act === 'cal-lead-del') leads.splice(Number(el.dataset.i), 1);
      else {
        const pick = window.prompt('提前多久提醒？輸入 10m／30m／1h／2h／3h／6h／12h／1d／2d，或自訂時刻（例 2026-08-23T20:00）', '1d');
        if (!pick) return;
        leads.push(/^\d{4}-/.test(pick.trim()) ? { at: pick.trim() } : pick.trim());
      }
      await api('PUT', `/api/schedules/${encodeURIComponent(sched.id)}`, { remind_leads: leads });
      await loadCalendar();
      render();
    } else if (act === 'cal-step') { state.stepModal = { nodeId: el.dataset.node }; render(); }
    else if (act === 'sm-close' || (act === 'sm-back' && e.target === el)) { state.stepModal = null; render(); }
    else if (act === 'sm-save') {
      const sched = state.calendar.scheds.find((s) => s.id === state.calDrawer.sid);
      const [wc, ...wr] = sched.workflow_id.split('/');
      const def = structuredClone(state.calDrawerDef);
      const n = def.nodes.find((x) => x.id === state.stepModal.nodeId);
      const f = state.stepModal.form; // 送 form（唯一真相），不讀 DOM
      n.instruction = f.instruction;
      const review = f.review.trim();
      if (review) n.review_focus = review; else delete n.review_focus;
      const tier = f.tier;
      if (tier) n.model_tier = tier; else delete n.model_tier;
      const retry = Number(f.retry);
      if (retry) n.retry = retry; else delete n.retry;
      await api('PUT', `/api/workflows/${encodeURIComponent(wc)}/${encodeURIComponent(wr.join('/'))}`, { def });
      state.calDrawerDef = def;
      state.stepModal = null;
      render();
    } else if (act === 'cal-add-sched') { state.schedModal = { sid: null }; render(); }
    else if (act === 'cal-manage') { state.schedManage = true; render(); }
    else if (act === 'smgr-close' || (act === 'smgr-back' && e.target === el)) { state.schedManage = false; render(); }
    else if (act === 'smgr-edit') { state.schedManage = false; state.schedModal = { sid: el.dataset.sid }; render(); }
    else if (act === 'smgr-toggle') {
      const s = state.calendar.scheds.find((x) => x.id === el.dataset.sid);
      await api('PUT', `/api/schedules/${encodeURIComponent(s.id)}`, { enabled: s.enabled === false });
      await loadCalendar();
      render();
    }
    else if (act === 'cal-open-sched-setting') { state.schedModal = { sid: state.calDrawer.sid }; render(); }
    else if (act === 'sc-close' || (act === 'sc-back' && e.target === el)) { state.schedModal = null; render(); }
    else if (act === 'sc-save') {
      const f = state.schedModal.form; // 送 form（唯一真相），不讀 DOM
      const lead = f.lead;
      const body = {
        freq: f.freq,
        time: f.time.trim() || '08:00',
        at: f.freq === 'once' ? (f.at.trim() || null) : null,
        auto_makeup: f.makeup,
        enabled: f.enabled,
      };
      if (f.freq === 'weekly') body.weekday = Number(f.weekday);
      if (f.freq === 'monthly') body.day = Number(f.day);
      // 提醒：新增時首檔沒改就不送、讓伺服器套設定→執行與排程的整份預設（M5b）；改了才帶一檔。編輯只在首檔真的改了才動（免得洗掉抽屜裡加的其餘幾筆）
      if (!state.schedModal.sid) { if (lead !== execLead0()) body.remind_leads = lead ? [lead] : []; }
      else {
        const cur = state.calendar.scheds.find((s) => s.id === state.schedModal.sid)?.remind_leads ?? [];
        const cur0 = typeof cur[0] === 'string' ? cur[0] : '';
        if (lead !== cur0) body.remind_leads = lead ? [lead, ...cur.slice(1)] : cur.slice(1);
      }
      if (state.schedModal.sid) await api('PUT', `/api/schedules/${encodeURIComponent(state.schedModal.sid)}`, body);
      else await api('POST', '/api/schedules', { ...body, workflow_id: f.wf });
      state.schedModal = null;
      await loadCalendar();
      render();
    } else if (act === 'autostart-toggle') {
      // 開機自啟開關搬到設定→執行與排程→常駐（記憶輪 M5b）；狀態在 state.settings.data.autostart，失敗一句原因、畫面不假成功
      const s = state.settings;
      try { s.data.autostart = await api('POST', '/api/autostart', { enabled: !(s.data.autostart?.enabled === true) }); } catch (err) { window.alert(err.message); }
      render();
    } else if (act === 'open-settings-exec') { await openSettings('執行與排程', '常駐'); }
    else if (act === 'notices-toggle-done') { state.noticesOpen = !state.noticesOpen; render(); }
    else if (act === 'notice-act') {
      await api('POST', `/api/notices/${encodeURIComponent(el.dataset.nid)}/act`, { action: el.dataset.do });
      await reloadPageData();
      render();
    } else if (act === 'todo-shift') {
      const shift = JSON.parse(el.dataset.shift);
      await api('POST', '/api/todos/google-shift/act', { action: el.dataset.do, run: shift.run, to: shift.to });
      await reloadPageData();
      render();
    } else if (act === 'todo-go') {
      const { cat, id, rid } = el.dataset;
      closeCalendar();
      closeDash();
      closeCategory();
      closeSettings(); closeLibrary();
      state.wf = { category: cat, id, def: await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}`), runs: [] };
      state.run = { ...(await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}/runs/${rid}`)), workflow: { category: cat, id } };
      state.dataSupplyOpen = null;
      state.editRulesOpen = null;
      state.runInspect = null; // U6a：打開別的 run 重設左軌
      render();
      schedulePoll();
    } else if (act === 'todo-open-wf') {
      closeCalendar();
      closeDash();
      closeCategory();
      closeSettings(); closeLibrary();
      const cat = el.dataset.cat;
      const id = el.dataset.id;
      state.wf = { category: cat, id, def: await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}`), runs: await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}/runs`) };
      state.mode = 'list';
      await refreshProposals(state.wf);
      state.wfFiles = await api('GET', `${wfPath(state.wf)}/files`); // U4b：這條路不走 openWorkflow，側欄的參考檔與資料夾要是這條流程的（原本 wfFiles 會留上一條的）
      await refreshFolder();
      render();
    }
    // ===== 群組圈分類頁（記憶輪 M1c）=====
    else if (act === 'open-category') {
      e.preventDefault(); // 移植第一批 T9：summary 上的文字＝開分類頁，不讓 details 原生收合（樹不跳動）
      if (canvasLeaveBlocked()) return;
      clearTimeout(state.pollTimer);
      closeCalendar();
      closeDash();
      closeCategory();
      closeSettings(); closeLibrary();
      state.run = null;
      state.showTrash = false;
      state.corrupt = null;
      state.importPreview = null;
      state.sharedOpen = false; // U4b：從共用檔浮窗「去部門頁管理」進來的，回流程頁時浮窗不該還開著
      state.categoryPage = { category: el.dataset.cat, data: null, cards: [], err: null, saving: false, saveErr: null };
      render();
      await loadCategoryPage();
      render();
    } else if (act === 'open-company') { // 移植合併輪 U2a：側欄公司節點／麵包屑第一節→公司頁（分類頁特例）
      if (canvasLeaveBlocked()) return;
      clearTimeout(state.pollTimer);
      closeCalendar();
      closeDash();
      closeCategory();
      closeSettings(); closeLibrary();
      state.run = null;
      state.showTrash = false;
      state.corrupt = null;
      state.importPreview = null;
      state.sharedOpen = false; // U4b：同 open-category
      state.categoryPage = { category: '_company', data: null, cards: [], err: null, saving: false, saveErr: null };
      render();
      await loadCategoryPage();
      render();
    } else if (act === 'reload-category') {
      const cp = state.categoryPage;
      cp.err = null;
      cp.data = null;
      cp.sharedErr = null; // 共用檔區的「重試」也走這裡：兩邊一起重讀
      cp.shared = null;
      render();
      await loadCategoryPage();
      render();
    } else if (act === 'close-category') {
      closeCategory();
      closeSettings(); closeLibrary();
      render();
    } else if (act === 'save-group') {
      const cp = state.categoryPage;
      const text = document.getElementById('group-text')?.value ?? '';
      cp.saving = true;
      cp.saveErr = null;
      render();
      try {
        cp.data = await api('PUT', `/api/memory/groups/${encodeURIComponent(cp.category)}`, { text });
        delete state.keep[keepKey('group-text')]; // 存好了，畫面改讀存下的原文
      } catch (err) {
        cp.saveErr = err.message; // 沒存成：字留在框裡（data-keep），一句原因在按鈕旁
      }
      cp.saving = false;
      render();
    } else if (act === 'shared-upload') { // 移植合併輪 U2b：記下層與區，再開檔案選擇（規範區只列 md／txt／docx，參考區任何檔）
      const cp = state.categoryPage;
      state.sharedUpload = { scope: cp.category, kind: el.dataset.kind };
      const input = document.getElementById('shared-file');
      input.accept = el.dataset.kind === 'rule' ? '.md,.txt,.docx' : '';
      input.click();
    } else if (act === 'shared-del') { // 移植合併輪 U2b：刪共用檔不進垃圾桶；參考類會順帶取消步驟裡的勾選（伺服器回 unlinked_steps）
      const cp = state.categoryPage;
      const { kind, name } = el.dataset;
      const layer = cp.category === '_company' ? '全公司每一條流程' : `「${cp.category}」部門的每一條流程`;
      const ask = kind === 'rule'
        ? `刪掉規範「${name}」？${layer}之後每一步都不再照它。不進垃圾桶，刪了就沒了。`
        : `刪掉參考「${name}」？${layer}裡勾了它的步驟會一併取消勾選。不進垃圾桶，刪了就沒了。`;
      if (!window.confirm(ask)) return;
      cp.uploadErr = null;
      try {
        const r = await api('DELETE', `${sharedPath(cp.category)}/${encodeURIComponent(name)}`, undefined);
        const shared = await api('GET', sharedPath(cp.category));
        if (state.categoryPage !== cp) return;
        cp.shared = shared;
        cp.msg = { kind, text: r.unlinked_steps ? `已刪除，並從 ${r.unlinked_steps} 個步驟取消勾選` : '已刪除' };
        clearTimeout(cp.msgTimer);
        cp.msgTimer = setTimeout(() => { if (state.categoryPage === cp) { cp.msg = null; render(); } }, 3000);
      } catch (err) {
        cp.uploadErr = { kind, text: err.message };
      }
      render();
    }
    else if (act === 'new-flow') {
      if (canvasLeaveBlocked()) return;
      closeCalendar();
      closeDash();
      closeCategory();
      closeSettings(); closeLibrary();
      if (state.wf && !subjectIsDraft()) chatByFlow.set(flowKey(state.wf), state.chat);
      state.wf = null;
      state.run = null;
      state.chat = { messages: [], draft: null, busy: false };
      state.paramNow = {};
      state.editingParam = null;
      state.canvasSel = null;
      state.drawerOpen = false;
      state.cvShowIssues = false;
      state.mode = 'chat';
      render();
    } else if (act === 'del-wf-row') {
      const { cat, id, name } = el.dataset;
      if (!window.confirm(`把「${name}」移到垃圾桶？30 天內都能復原。`)) return;
      await api('DELETE', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}`, undefined);
      chatByFlow.delete(`${cat}/${id}`);
      if (state.wf && state.wf.category === cat && state.wf.id === id) {
        state.wf = null;
        state.run = null;
        state.chat = { messages: [], draft: null, busy: false };
        state.mode = 'chat';
      }
      await refreshLibrary();
      render();
    } else if (act === 'mode-chat') { if (canvasLeaveBlocked()) return; state.mode = 'chat'; render(); }
    else if (act === 'mode-list') { if (canvasLeaveBlocked()) return; state.mode = 'list'; render(); }
    else if (act === 'mode-canvas') { state.mode = 'canvas'; render(); }
    else if (act === 'mode-history') {
      if (canvasLeaveBlocked()) return;
      if (state.wf && !subjectIsDraft()) state.versions = await api('GET', `${wfPath(state.wf)}/versions`);
      state.mode = 'history';
      render();
    } else if (act === 'edit-step') {
      state.canvasSel = el.dataset.node;
      state.drawerOpen = true;
      render();
    } else if (act === 'send-chat') await sendChat();
    else if (act === 'clear-draft') {
      state.chat = { messages: [], draft: null, busy: false };
      state.savingDraft = false;
      render();
    } else if (act === 'save-draft') {
      state.savingDraft = true;
      state.mode = 'list';
      render();
    } else if (act === 'cancel-save-draft') {
      state.savingDraft = false;
      render();
    } else if (act === 'confirm-save-draft') {
      let category = document.getElementById('save-category').value;
      if (category === '__new__') {
        category = document.getElementById('save-new-category').value.trim();
        if (!category) return;
      }
      // 新分類、或第一次選「不分類」（未分類是一般分類）：先建目錄
      if (!state.categories.includes(category)) await api('POST', '/api/categories', { name: category });
      const def = structuredClone(state.chat.draft);
      delete def.category; // 分類是路徑，不進 workflow.yaml（改稿那條路在 sendChat 剝）
      const saved = await api('POST', '/api/workflows', { category, def });
      state.chat = { messages: [], draft: null, busy: false };
      state.savingDraft = false;
      await refreshLibrary();
      // dict_similar（記憶輪）：欄位名跟詞典裡的很像——只提醒不擋，掛在這條流程上，換流程就消失
      state.wf = { category: saved.category, id: saved.id, def, runs: [], dictSimilar: saved.dict_similar ?? [] };
      state.versions = await api('GET', `${wfPath(state.wf)}/versions`);
      await refreshProposals(state.wf);
      state.wfFiles = [];
      state.mode = 'list';
      render();
    } else if (act === 'cv-new-blank') {
      state.chat.draft = { format: 1, name: '新流程', params: [], nodes: [makeTask('第一步')] };
      state.canvasSel = state.chat.draft.nodes[0].id;
      window.BJCanvas.resetView();
      render();
    } else if (act === 'add-category') {
      state.addingCategory = true;
      render();
    } else if (act === 'confirm-category') {
      const name = document.getElementById('new-category').value.trim();
      if (!name) return;
      await api('POST', '/api/categories', { name });
      state.addingCategory = false;
      await refreshLibrary();
      render();
    } else if (act === 'add-param') {
      state.addingParam = true;
      render();
    } else if (act === 'cancel-param') {
      state.addingParam = false;
      render();
    } else if (act === 'confirm-param') {
      const label = document.getElementById('new-param-label').value.trim();
      const dft = document.getElementById('new-param-default').value.trim();
      if (!label) return;
      const def = structuredClone(state.wf.def);
      let n = def.params.length + 1;
      while (def.params.some((p) => p.key === `p${n}`)) n++;
      // 預設留空＝純資料欄位＝必填（開跑前健檢沒填不給跑）；有值照舊
      def.params.push(dft ? { key: `p${n}`, label, default: dft } : { key: `p${n}`, label, default: '', required: true });
      await api('PUT', wfPath(state.wf), { def });
      state.wf.def = def;
      state.addingParam = false;
      render();
    } else if (act === 'open') {
      if (canvasLeaveBlocked()) return;
      await openWorkflow(el.dataset.cat, el.dataset.id);
      render();
    } else if (act === 'del-run') {
      if (!window.confirm('這一趟不用跑完了？會連同它的紀錄、產出檔、指示卷宗一起刪掉，救不回來。')) return;
      await api('DELETE', `${wfPath(state.wf)}/runs/${el.dataset.rid}`, undefined);
      state.wf.runs = await api('GET', `${wfPath(state.wf)}/runs`);
      await refreshFolder(); // U4b：側欄「每次執行」少一筆
      render();
    } else if (act === 'resume') {
      state.run = await api('GET', `${wfPath(state.wf)}/runs/${el.dataset.rid}`);
      state.run.workflow = { category: state.wf.category, id: state.wf.id };
      state.editingNode = null;
      state.dataSupplyOpen = null;
      state.editRulesOpen = null;
      state.runInspect = null; // U6a：續跑＝打開別的 run，重設左軌
      render();
      schedulePoll();
    } else if (act === 'start' || act === 'start-force') {
      // 一律讀當下 DOM 的值（游標還在欄位裡、change 還沒發也算數），同時收進 state.paramNow——健檢卡一出來會整頁重繪，打好的值不能掉
      const overrides = {};
      for (const input of app.querySelectorAll('[data-param]')) overrides[input.dataset.param] = state.paramNow[input.dataset.param] = input.value;
      const defKey = JSON.stringify(state.wf.def);
      if (act === 'start') {
        let pf = null;
        try { pf = await preflightNow(state.wf.def, overrides); } catch { /* 健檢端點讀不到：交給 POST /runs 的 409 兜底 */ }
        if (pf?.issues?.length) {
          state.startCheck = { key: defKey, level: pf.issues.some((i) => i.level === 'block') ? 'block' : 'warn', issues: pf.issues };
          render();
          return;
        }
      }
      state.startCheck = null;
      let run;
      try {
        // 記憶輪（M3b）：點了的習慣卡＝核可、點了又改掉的、身分，隨開跑一起送
        run = await api('POST', `${wfPath(state.wf)}/runs`, { overrides, ...memStartFields(overrides) });
      } catch (err) {
        if (err.status === 409 && Array.isArray(err.body?.issues)) { // 後端兜底擋下：用同一張卡顯示
          state.startCheck = { key: defKey, level: 'block', issues: err.body.issues };
          render();
          return;
        }
        throw err;
      }
      state.run = run;
      state.run.workflow = { category: state.wf.category, id: state.wf.id };
      state.runJson = null;
      state.runInspect = null; // U6a：新的一趟從目前這步看起
      state.keep = {};
      state.dataSupplyOpen = null;
      state.editRulesOpen = null;
      state.feedbackSent = false;
      render();
      schedulePoll();
    } else if (act === 'start-check-close') {
      state.startCheck = null;
      render();
    } else if (act === 'mem-pick') {
      // 習慣選項 chip（記憶輪 M3b）：點了＝把卡的內容填進那一格、記成核可；再點同一張＝取消（值留著）；換一張＝換核可
      const key = el.dataset.key;
      const id = el.dataset.id;
      if (state.memPicks[key] === id) {
        delete state.memPicks[key];
      } else {
        const card = memOptionCard(key, id);
        if (!card) return;
        state.memPicks[key] = id;
        state.memChanged = state.memChanged.filter((x) => x !== id);
        state.paramNow[key] = card.text;
        syncParamChips(key, card.text);
      }
      render();
    } else if (act === 'mem-more') {
      state.memMore[el.dataset.key] = !state.memMore[el.dataset.key];
      render();
    } else if (act === 'pf-fix') {
      if (el.dataset.kind === 'node') { // 開那一步的抽屜
        state.canvasSel = el.dataset.id;
        state.drawerOpen = true;
        render();
      } else if (el.dataset.kind === 'flow') {
        // 流程層設定（目前只有產檔權限開關）：亮 1.5 秒＋捲到它。狀態驅動——class 由 permRowHtml 依 permFlashUntil 帶、
        // 捲動在 render() 尾端對新元素做，中途任何整頁重繪（通知輪詢等）都不會把亮框和捲動弄丟
        state.flowSettingsOpen = true; // 移植第一批 T10：三開關在浮窗裡，先開浮窗再亮、再捲
        state.permFlashUntil = Date.now() + 1500;
        render();
        setTimeout(() => {
          state.permFlashUntil = 0;
          const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && document.activeElement.value;
          if (!typing) render(); // 到期拿掉 class（動畫本身已跑完，打字中就留到下次重繪）
        }, 1500);
      } else { // 捲到那個欄位並聚焦
        const t = app.querySelector(`[data-param="${CSS.escape(el.dataset.id)}"]`);
        if (t) { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); t.focus(); }
      }
    } else if (act === 'back') {
      clearTimeout(state.pollTimer);
      state.run = null;
      state.editingNode = null;
      state.dataSupplyOpen = null;
      state.editRulesOpen = null;
      state.runInspect = null; // U6a：離開 run 就忘掉左軌看的那步
      state.promptView = null; // U6b：卷宗浮窗跟著關
      if (state.wf) state.wf.runs = await api('GET', `${wfPath(state.wf)}/runs`);
      await refreshWfMemory(); // 剛跑的那趟可能把卡的範圍擴大了：回表單的 chip 要是新的
      await refreshFolder(); // U4b：剛跑的那趟要出現在側欄「每次執行」
      render();
    } else if (act === 'data-fix-node') {
      // run 頁不顯示抽屜：先回工作區（同 back），再開那一步的抽屜
      clearTimeout(state.pollTimer);
      state.run = null;
      state.editingNode = null;
      state.dataSupplyOpen = null;
      if (state.wf) state.wf.runs = await api('GET', `${wfPath(state.wf)}/runs`);
      await refreshFolder(); // U4b：同 back
      state.mode = 'list';
      state.canvasSel = el.dataset.node;
      state.drawerOpen = true;
      render();
    } else if (act === 'sup-toggle') {
      // 「監工交代」展開／收合：狀態在 state，打到一半的插話由 data-keep 帶回來
      const nid = el.dataset.node;
      state.supOpen[nid] = !state.supOpen[nid];
      render();
    }
    // ===== 就地看（記憶輪 M4）：「這步用了 N 條」展開、卡片浮窗、儀表板第一列 =====
    else if (act === 'mem-toggle') {
      state.memOpen[el.dataset.node] = !state.memOpen[el.dataset.node];
      render();
    } else if (act === 'mem-card') { await openMemCard(el); }
    else if (act === 'mem-modal-close' || (act === 'mem-modal-back' && e.target === el)) { state.memModal = null; render(); }
    else if (act === 'mem-retire' || act === 'mem-del') { await memCardAction(act === 'mem-retire' ? 'retire' : 'del'); }
    else if (act === 'open-settings-memory') { await openSettings('記憶', '記憶總覽'); }
    // ===== 設定頁（記憶輪 M5a）：容器、記憶三頁、素材庫三頁、卡片浮窗的「改」 =====
    else if (act === 'open-settings') { await openSettings(state.settings?.group ?? '記憶'); }
    else if (act === 'open-library') { openLibrary(); }
    else if (act === 'cv-more') { e.preventDefault(); const d = el.closest('details'); if (d) { d.open = !d.open; state.cvMore = d.open; } } // 抽屜收摺：只動 DOM 與 state，不 render（打到一半的字不洗掉）
    else if (act === 'flow-tab') { state.flowTab = el.dataset.tab === 'data' ? 'data' : 'design'; render(); } // 移植第一批 T10
    else if (act === 'flow-settings') { state.flowSettingsOpen = true; render(); }
    else if (act === 'flow-settings-close') { if (!el.classList.contains('pvback') || e.target === el) { state.flowSettingsOpen = false; render(); } }
    else if (act === 'flowmem-open') { state.flowMemOpen = true; render(); }
    else if (act === 'flowmem-close') { if (!el.classList.contains('pvback') || e.target === el) { state.flowMemOpen = false; render(); } }
    // ===== 移植合併輪 U4b：流程頁右側資料夾、共用檔浮窗、本次資料收摺 =====
    else if (act === 'folder-toggle') {
      // details 的開合：讓瀏覽器原生切換，只把「切換後」的值記進 state（下次重繪讀回）；不整頁 render——本次資料打到一半的值不洗
      const d = el.closest('details');
      if (d) state.folderOpen[el.dataset.k] = !d.open;
    }
    // ===== 移植合併輪 U6a：執行頁三欄 =====
    else if (act === 'run-inspect') {
      // 移植合併輪 U6c：左軌點步驟＝切成那一步的歷史視圖（demo runPage 的 inspect）；點目前這步存 null 不存它的 id——不然跑到下一步時會彈成歷史
      const node = el.dataset.node;
      state.runInspect = node === currentNodeOf(state.run) ? null : node;
      render();
    }
    else if (act === 'run-current') {
      state.runInspect = null;
      render();
    }
    else if (act === 'side-toggle') {
      // 右欄四格：讓瀏覽器原生切換 details，只把「切換後」的值記進 state.sideOpen（下次重繪讀回）；不整頁 render——卡片上打到一半的插話不洗
      const d = el.closest('details');
      if (d) state.sideOpen[el.dataset.k] = !d.open;
    }
    else if (act === 'refs-all') { state.folderOpen.refsAll = true; repaintAside(); }
    else if (act === 'runs-all') { state.folderOpen.runsAll = true; repaintAside(); }
    else if (act === 'shared-open') { state.sharedOpen = true; render(); }
    else if (act === 'shared-close') { if (!el.classList.contains('pvback') || e.target === el) { state.sharedOpen = false; render(); } }
    else if (act === 'lib-cat') { if (state.library) { state.library.cat = el.dataset.cat; render(); } }
    else if (act === 'cat-toggle') { // 側欄分類箭頭：只收合／展開，不開頁；擋掉 summary 的原生切換，狀態走 state.catClosed
      e.preventDefault();
      const c = el.dataset.cat;
      if (state.catClosed.has(c)) state.catClosed.delete(c); else state.catClosed.add(c);
      render();
    }
    else if (act === 'set-group') { state.settings.group = el.dataset.g; state.settings.merge = null; state.settings.msg = null; render(); }
    else if (act === 'set-tab') { state.settings.tab[el.dataset.g] = el.dataset.k; state.settings.merge = null; state.settings.msg = null; render(); }
    // ===== 設定頁後四組（記憶輪 M5b）：新流程的預設／執行與排程的開關即 PUT；連線、資料的動作走既有 API =====
    else if (act === 'set-def-sw') { const k = el.dataset.k; await setPut({ defaults: { [k]: state.settings.data.cfg.defaults?.[k] === false } }); }
    else if (act === 'set-def-flag') { const k = el.dataset.k; await setPut({ defaults: { supervisor_flags: { [k]: !state.settings.data.cfg.defaults?.supervisor_flags?.[k] } } }); }
    else if (act === 'set-def-val') { const v = el.dataset.v; await setPut({ defaults: { [el.dataset.k]: v === 'null' ? null : /^\d+$/.test(v) ? Number(v) : v } }); }
    else if (act === 'set-exec-sw') { const k = el.dataset.k; await setPut({ exec: { [k]: state.settings.data.cfg.exec?.[k] === false } }); }
    else if (act === 'set-exec-val') { await setPut({ exec: { [el.dataset.k]: el.dataset.v === 'true' } }); }
    else if (act === 'set-exec-lead') {
      // 九檔提前量多選；設定裡若有 {at} 這種自訂時刻（只能從 API 來）原樣保留、排在後面
      const cur = state.settings.data.cfg.exec?.remind_leads ?? [];
      const k = el.dataset.k;
      const strs = cur.filter((x) => typeof x === 'string');
      const nextStrs = (strs.includes(k) ? strs.filter((x) => x !== k) : [...strs, k]).sort((a, b) => LEAD_ORDER.indexOf(a) - LEAD_ORDER.indexOf(b));
      await setPut({ exec: { remind_leads: [...nextStrs, ...cur.filter((x) => typeof x !== 'string')] } });
    } else if (act === 'set-cal-refresh') {
      const s = state.settings;
      s.busy = 'cal';
      render();
      try {
        const out = await api('POST', '/api/calendar/refresh', {});
        s.msg = out.ok ? { key: 'cal', text: '快照抓好了。' } : { key: 'cal', text: `快照抓不到：${out.reason}`, err: true };
      } catch (err) { s.msg = { key: 'cal', text: err.message, err: true }; }
      s.busy = null;
      await loadSettings();
      render();
    } else if (act === 'set-backup-now') {
      const s = state.settings;
      s.busy = 'backup';
      render();
      try {
        const out = await api('POST', '/api/backup', {});
        s.msg = { key: 'backup', text: `備份好了：${String(out.path).split(/[\\/]/).pop()}` };
      } catch (err) { s.msg = { key: 'backup', text: err.message, err: true }; }
      s.busy = null;
      await loadSettings();
      render();
    } else if (act === 'set-trash-restore') {
      const s = state.settings;
      try {
        if (el.dataset.kind === 'wf') {
          const back = await api('POST', `/api/trash/${encodeURIComponent(el.dataset.key)}/restore`, {});
          await refreshLibrary();
          s.msg = { key: 'trash', text: `復原了，回到流程庫的「${back.category}」。` };
        } else {
          const card = await api('POST', `/api/memory/trash/${encodeURIComponent(el.dataset.key)}/restore`, {});
          s.msg = { key: 'trash', text: `「${card.text}」復原了。` };
        }
      } catch (err) { s.msg = { key: 'trash', text: err.message, err: true }; }
      await afterMemChange();
      render();
    } else if (act === 'set-clear-mem-open') { state.settings.confirm = 'memory'; render(); }
    else if (act === 'set-clear-mem-cancel' || (act === 'set-clear-mem-back' && e.target === el)) { if (!state.settings?.busy) { state.settings.confirm = null; render(); } }
    else if (act === 'set-clear-mem-go') {
      const s = state.settings;
      s.busy = 'clear';
      render();
      try {
        const out = await api('POST', '/api/memory/clear', {});
        s.msg = { key: 'clear', text: `已把 ${out.moved} 張卡移到記憶垃圾桶，30 天內可以在上面的垃圾桶逐張復原。` };
      } catch (err) { s.msg = { key: 'clear', text: err.message, err: true }; }
      s.busy = null;
      s.confirm = null;
      await afterMemChange();
      render();
    }
    else if (act === 'set-reload') { state.settings.err = null; render(); await loadSettings(); render(); }
    else if (act === 'intro-open') { state.intro = { saving: false, err: null }; closeSettings(); closeLibrary(); render(); } // 關於你頁還沒介紹過→重開三題（答完 POST /api/memory/intro 照舊）
    else if (act === 'set-pause') { await setPut({ memory: { paused: !(state.settings.data.cfg.memory?.paused === true) } }); }
    else if (act === 'set-sens') { const k = el.dataset.k; await setPut({ memory: { sensitive: { [k]: !state.settings.data.cfg.memory?.sensitive?.[k] } } }); }
    else if (act === 'set-retire' || act === 'set-del' || act === 'set-revive' || act === 'set-extend' || act === 'set-extend-forever') { await setCardAct(act, el.dataset.id); }
    else if (act === 'set-replace') { await openMemCard(el, { replacing: true }); }
    else if (act === 'dict-merge-start') {
      const others = state.settings.data.dict.fields.filter((f) => f.name !== el.dataset.name);
      state.settings.merge = { drop: el.dataset.name, keep: others[0]?.name ?? '', err: null };
      render();
    } else if (act === 'dict-merge-cancel') { state.settings.merge = null; render(); }
    else if (act === 'dict-merge-go') {
      const m = state.settings.merge;
      try {
        await api('POST', '/api/memory/dict/merge', { keep: m.keep, drop: m.drop });
        state.settings.merge = null;
        await afterMemChange();
      } catch (err) { m.err = err.message; }
      render();
    } else if (act === 'id-add') {
      const box = document.getElementById('id-new');
      const name = box?.value.trim();
      if (!name) { box?.focus(); return; }
      const idn = await api('POST', '/api/memory/identities', { name, cards: [], categories: [] });
      await afterMemChange();
      state.settings.idEdit = { id: idn.id, name: idn.name, cards: new Set(), categories: new Set(), err: null }; // 新增完直接進編輯：勾卡、綁分類
      render();
    } else if (act === 'id-edit') {
      const i = state.settings.data.identities.find((x) => x.id === el.dataset.id);
      state.settings.idEdit = { id: i.id, name: i.name, cards: new Set(i.cards ?? []), categories: new Set(i.categories ?? []), err: null };
      render();
    } else if (act === 'id-cancel') { state.settings.idEdit = null; render(); }
    else if (act === 'id-bind') {
      const e2 = state.settings.idEdit;
      if (e2.categories.has(el.dataset.c)) e2.categories.delete(el.dataset.c); else e2.categories.add(el.dataset.c);
      render();
    } else if (act === 'id-save') {
      const e2 = state.settings.idEdit;
      try {
        await api('PUT', `/api/memory/identities/${encodeURIComponent(e2.id)}`, { name: e2.name.trim(), cards: [...e2.cards], categories: [...e2.categories] });
        state.settings.idEdit = null;
        await afterMemChange();
      } catch (err) { e2.err = err.message; }
      render();
    } else if (act === 'id-del') {
      if (!window.confirm('刪掉這個身分？認識卡都還在，只是這個封套沒了。')) return;
      await api('DELETE', `/api/memory/identities/${encodeURIComponent(el.dataset.id)}`, undefined);
      await afterMemChange();
      render();
    } else if (act === 'asset-add') {
      const box = document.getElementById('asset-new');
      const name = box?.value.trim();
      if (!name) { box?.focus(); return; }
      state.settings.presetEdit = { field: el.dataset.field, orig: null, name, text: '', err: null };
      render();
    } else if (act === 'asset-edit') {
      const p = (state.presets[el.dataset.field] ?? []).find((x) => x.name === el.dataset.name);
      state.settings.presetEdit = { field: el.dataset.field, orig: p.name, name: p.name, text: p.text, err: null };
      render();
    } else if (act === 'asset-cancel') { state.settings.presetEdit = null; render(); }
    else if (act === 'asset-save') {
      const e2 = state.settings.presetEdit;
      try {
        if (!e2.name.trim() || !e2.text.trim()) throw new Error('要有名字和內容才能存');
        await api('POST', '/api/presets', { field: e2.field, name: e2.name.trim(), text: e2.text });
        if (e2.orig && e2.orig !== e2.name.trim()) await api('DELETE', `/api/presets/${encodeURIComponent(e2.field)}/${encodeURIComponent(e2.orig)}`, undefined); // 改名＝存新的、刪舊名
        state.settings.presetEdit = null;
        state.presets = await api('GET', '/api/presets');
      } catch (err) { e2.err = err.message; }
      render();
    } else if (act === 'asset-del') {
      if (!window.confirm(`刪掉「${el.dataset.name}」？已經帶進步驟的不受影響。`)) return;
      await api('DELETE', `/api/presets/${encodeURIComponent(el.dataset.field)}/${encodeURIComponent(el.dataset.name)}`, undefined);
      state.presets = await api('GET', '/api/presets');
      render();
    } else if (act === 'mem-replace-open') { state.memModal.replacing = true; state.memModal.err = null; render(); }
    else if (act === 'mem-replace-cancel') { state.memModal.replacing = false; state.memModal.err = null; delete state.keep[keepKey('mem-replace-text')]; render(); }
    else if (act === 'mem-replace-save') { await memCardAction('replace'); }
    else if (act === 'interject') {
      const box = document.getElementById(`interject-${el.dataset.node}`);
      const text = box?.value.trim() ?? '';
      if (!text) { box?.focus(); return; } // 沒寫字就當沒按
      await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/interject`, { node: el.dataset.node, text });
      delete state.keep[keepKey(`interject-${el.dataset.node}`)];
      await refreshRun();
    } else if (act === 'record-goto') {
      await gotoNode(state.run.workflow.category, state.run.workflow.id, el.dataset.node);
    } else if (act === 'start-edit') {
      state.editingNode = el.dataset.node;
      render();
    } else if (act === 'cancel-edit') {
      state.editingNode = null;
      render();
    } else if (act === 'approve') {
      await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/approve`, { node: el.dataset.node });
      await refreshRun();
    } else if (act === 'edit') {
      await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/edit`, {
        node: el.dataset.node,
        output: document.getElementById('edit-output').value,
        note: document.getElementById('edit-note').value || null,
      });
      state.editingNode = null;
      await refreshRun();
    } else if (act === 'human-done') {
      await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/human-done`, {
        node: el.dataset.node,
        content: document.getElementById('human-content')?.value ?? '',
        feedback: document.getElementById('human-feedback').value || null,
      });
      delete state.keep[keepKey('human-content')];
      await refreshRun();
    } else if (act === 'data-supply-open') {
      state.dataSupplyOpen = el.dataset.node;
      render();
      document.getElementById('data-supply-text')?.focus();
    } else if (act === 'data-supply-cancel') {
      state.dataSupplyOpen = null;
      delete state.keep[keepKey('data-supply-text')];
      render();
    } else if (act === 'data-supply') {
      const box = document.getElementById('data-supply-text');
      const text = box?.value.trim() ?? '';
      if (!text) { box?.focus(); return; } // 空的沒東西可補
      await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/data-supply`, { node: el.dataset.node, text });
      state.dataSupplyOpen = null;
      delete state.keep[keepKey('data-supply-text')];
      await refreshRun();
    } else if (act === 'retry') {
      await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/retry`, { node: el.dataset.node });
      await refreshRun();
    } else if (act === 'data-retry') {
      await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/data-retry`, { node: el.dataset.node });
      await refreshRun();
    } else if (act === 'data-accept') {
      await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/data-accept`, { node: el.dataset.node });
      await refreshRun();
    } else if (act === 'choose-branch') {
      await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/choose-branch`, {
        node: el.dataset.node,
        target: el.dataset.target,
      });
      await refreshRun();
    } else if (act === 'accept-proposal') {
      const res = await api('POST', `/api/proposals/${el.dataset.pid}/accept`, {});
      // 監工建議（訊號 D）：伺服器不改定義，回「去哪裡改」——走「改這裡」同一段，把抽屜開給使用者自己改
      if (res?.open) { await gotoNode(res.open.category, res.open.id, res.open.node_id); return; }
      const w = state.run ? state.run.workflow : state.wf;
      if (state.wf && (!state.run || (w.category === state.wf.category && w.id === state.wf.id))) {
        state.wf.def = await api('GET', wfPath(w));
        state.versions = await api('GET', `${wfPath(w)}/versions`);
      }
      await refreshProposals(w);
      render();
    } else if (act === 'reject-proposal') {
      await api('POST', `/api/proposals/${el.dataset.pid}/reject`, {});
      await refreshProposals(state.run ? state.run.workflow : state.wf);
      render();
    } else if (act === 'send-run-feedback') {
      const text = document.getElementById('run-feedback-input')?.value.trim();
      if (!text) return;
      const out = await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/run-feedback`, { text });
      state.feedbackSent = out.memory_notice ?? true; // 記憶輪（M2）：回覆照它講記成什麼；舊伺服器沒回就照舊「收到」
      pollProposalsSoon(state.run.workflow);
      await refreshRun(); // 頁頂那一行「記下來了…不要記」從 run 讀，剛寫進去的要重抓才看得到
    }
    // ===== 記憶輪（M2）：首次三題介紹、通知「不要記」=====
    else if (act === 'intro-save' || act === 'intro-skip') {
      const body = act === 'intro-skip' ? { skip: true } : { answers: introAnswers() };
      state.intro = { saving: true, err: null };
      render();
      try {
        await api('POST', '/api/memory/intro', body);
        state.intro = null;
        for (const q of INTRO_QUESTIONS) delete state.keep[keepKey(introInputId(q.key))];
      } catch (err) {
        state.intro = { saving: false, err: `沒存成：${err.message}` };
      }
      render();
    } else if (act === 'mem-undo') {
      // run 頁頂的一行：卡進記憶垃圾桶＋這一趟的通知標「不記了」；重抓 run 讓頁頂照最新的畫
      const card = el.dataset.card;
      if (state.memUndoing[card]) return;
      state.memUndoing[card] = true;
      render();
      try {
        const w = state.run.workflow;
        await api('POST', `/api/memory/notices/${encodeURIComponent(card)}/undo`, { category: w.category, id: w.id, run: state.run.run_id });
        if (state.feedbackSent?.card === card) state.feedbackSent = { ...state.feedbackSent, undone: true };
        await refreshRun();
      } finally {
        delete state.memUndoing[card];
        render();
      }
    } else if (act === 'mem-undo-chat') {
      // 聊天氣泡下的一行：沒有趟可標，只丟卡；這一行就地改成「不記了」
      const card = el.dataset.card;
      const msg = state.chat.messages[Number(el.dataset.idx)];
      if (!msg?.notice || state.memUndoing[card]) return;
      state.memUndoing[card] = true;
      render();
      try {
        await api('POST', `/api/memory/notices/${encodeURIComponent(card)}/undo`, {});
        msg.notice = { ...msg.notice, undone: true };
      } finally {
        delete state.memUndoing[card];
        render();
      }
    } else if (act === 'rollback-version') {
      await api('POST', `${wfPath(state.wf)}/rollback`, { version: Number(el.dataset.version) });
      state.wf.def = await api('GET', wfPath(state.wf));
      state.versions = await api('GET', `${wfPath(state.wf)}/versions`);
      render();
    } else if (act === 'cv-close-drawer') {
      state.drawerOpen = false;
      state.drawerTabFor = null; // 重開同一顆也回預設頁
      state.cvMore = null;
      render();
    } else if (act === 'cv-tab') {
      // 子頁切換走 DOM 顯隱不 render——別洗掉打到一半的字
      state.drawerTab = el.dataset.tab;
      document.getElementById('cv-page-content')?.classList.toggle('off', state.drawerTab !== 'content');
      document.getElementById('cv-page-spec')?.classList.toggle('off', state.drawerTab !== 'spec');
      for (const s of document.querySelectorAll('#cv-tabs [data-tab]')) s.classList.toggle('on', s.dataset.tab === state.drawerTab);
    } else if (act === 'preset-save') {
      const src = document.getElementById(el.dataset.target);
      const text = src?.value.trim();
      if (!text) { window.alert('欄位是空的——先填內容再存成常用'); return; }
      const name = window.prompt('給這個常用內容取個名字（例：資深客服主管）');
      if (!name?.trim()) return;
      await api('POST', '/api/presets', { field: el.dataset.field, name: name.trim(), text });
      state.presets = await api('GET', '/api/presets');
      const sel = el.parentElement.querySelector('[data-preset-field]'); // 只補選單、不 render——別洗掉抽屜裡的字
      if (sel) sel.innerHTML = `<option value="">常用片段⋯</option>${(state.presets[el.dataset.field] ?? []).map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')}`;
    } else if (act === 'preset-del') {
      const sel = el.parentElement.querySelector('[data-preset-field]');
      const name = sel?.value;
      if (!name) { window.alert('先在「常用片段⋯」裡選一個要刪的'); return; }
      if (!window.confirm(`把常用「${name}」刪掉？（已填進各步驟的內容不受影響）`)) return;
      await api('DELETE', `/api/presets/${encodeURIComponent(el.dataset.field)}/${encodeURIComponent(name)}`, undefined);
      state.presets = await api('GET', '/api/presets');
      sel.innerHTML = `<option value="">常用片段⋯</option>${(state.presets[el.dataset.field] ?? []).map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')}`;
    } else if (act === 'ref-upload') {
      document.getElementById('ref-file').click();
    } else if (act === 'ref-del') {
      if (!window.confirm(`刪掉參考檔「${el.dataset.name}」？有步驟正在用的話會讀不到。`)) return;
      await api('DELETE', `${wfPath(state.wf)}/files/${encodeURIComponent(el.dataset.name)}`, undefined);
      await refreshRefSection();
    } else if (act === 'cv-branch-to-par') {
      // 分岔→並行點：去掉條件判斷，各路照原目標同時做
      await canvasOp((def) => {
        const n = def.nodes.find((x) => x.id === state.canvasSel);
        if (!n || kindOf(n) !== 'branch') return;
        n.kind = 'fork';
        n.next = [...new Set((n.branches ?? []).map((b) => b.next))];
        delete n.branches;
        delete n.instruction;
        if (['分岔', '依情況'].includes(n.title)) n.title = '並行';
      });
    } else if (act === 'cv-apply') {
      await canvasOp((def) => {
        const n = def.nodes.find((x) => x.id === state.canvasSel);
        if (!n) return;
        n.title = document.getElementById('cv-title')?.value.trim() || n.title;
        const instr = document.getElementById('cv-instruction')?.value;
        if (instr !== undefined) n.instruction = instr;
        if (kindOf(n) === 'task') {
          n.executor = document.getElementById('cv-executor').value;
          n.stop_point = document.getElementById('cv-stop').checked ? 'always' : 'never';
          const optText = [['cv-output-format', 'output_format'], ['cv-role', 'role_context'], ['cv-bg', 'background'],
            ['cv-constraints', 'constraints'], ['cv-examples', 'examples'], ['cv-review', 'review_focus'],
            ['cv-otype', 'output_type'], ['cv-ostructure', 'output_structure'], ['cv-olength', 'output_length'], ['cv-otone', 'output_tone'],
            ['cv-handoff', 'handoff']];
          for (const [id, key] of optText) {
            const elmt = document.getElementById(id);
            if (!elmt) continue; // 人做步驟沒渲染的欄位不動原值
            const v = elmt.value.trim();
            if (v) n[key] = v; else delete n[key];
          }
          if (n.executor === 'ai') delete n.handoff; // 「完成時交出什麼」只屬於人做步驟
          for (const [id, key] of [['cv-model', 'model_tier'], ['cv-creativity', 'creativity'], ['cv-file', 'output_file'], ['cv-template', 'template_file']]) {
            const elmt = document.getElementById(id);
            if (!elmt) continue;
            if (elmt.value) n[key] = elmt.value; else delete n[key];
          }
          const rt = document.getElementById('cv-retry');
          if (rt) { const v = Number(rt.value); if (v) n.retry = v; else delete n.retry; }
          // 監工三個勾：三個都等於缺省就不寫這欄位（流程檔乾淨；缺省語意由 supervisorFlags 給）
          const supBox = SUP_CHK.map(([id]) => document.getElementById(id));
          if (supBox[0] && n.executor === 'ai') {
            const sv = { note: supBox[0].checked, tier: supBox[1].checked, tools: supBox[2].checked };
            if (sv.note && !sv.tier && !sv.tools) delete n.supervisor; else n.supervisor = sv;
          }
          const attBoxes = [...document.querySelectorAll('[data-att]')];
          if (attBoxes.length || document.getElementById('ref-section')) {
            // U4c：流程層存字串（舊流程原樣）、上層存 {scope,name}（後端 U1b 兩型都收）
            const picked = attBoxes.filter((c) => c.checked).map((c) => { const scope = c.dataset.attScope ?? 'flow', name = c.dataset.att; return scope === 'flow' ? name : { scope, name }; });
            if (picked.length) n.attachments = picked; else delete n.attachments;
          }
        }
        if (kindOf(n) === 'branch') {
          for (const inp of app.querySelectorAll('[data-branch-label]')) {
            const b = n.branches[Number(inp.dataset.branchLabel)];
            if (b && inp.value.trim()) b.label = inp.value.trim();
          }
        }
      });
    } else if (act === 'cv-delete') {
      await canvasOp((def) => {
        removeNodeSimple(def, state.canvasSel);
      });
    } else if (act === 'cv-dissolve') {
      await canvasOp(() => {}); // 空編輯：normalize 會把舊式 fork/join 拆直
    } else if (act === 'cv-undo') {
      await cvUndo();
    } else if (act === 'cv-redo') {
      await cvRedo();
    } else if (act === 'cv-save') {
      await cvSave();
    } else if (act === 'export-wf') {
      window.location.href = `${wfPath(state.wf)}/export`;
    } else if (act === 'pick-import') {
      closeCalendar(); // 匯入預覽畫面在儀表板／行事曆／分類頁／設定頁之下，開著時選檔會看不到
      closeDash();
      closeCategory();
      closeSettings(); closeLibrary();
      document.getElementById('import-file').click();
    } else if (act === 'cancel-import') {
      state.importPreview = null;
      render();
    } else if (act === 'confirm-import') {
      if (canvasLeaveBlocked()) return; // 匯入完會切到新流程——畫布未存檔先問
      const saved = await api('POST', '/api/import/confirm', { def: state.importPreview.def, schedule: state.importPreview.schedule ?? null });
      state.importPreview = null;
      await refreshLibrary();
      const def = await api('GET', wfPath(saved));
      state.wf = { ...saved, def, runs: [] };
      state.versions = await api('GET', `${wfPath(saved)}/versions`);
      await refreshProposals(state.wf);
      state.mode = 'list';
      render();
    } else if (act === 'view-trash') {
      closeCalendar();
      closeDash();
      closeCategory();
      closeSettings(); closeLibrary();
      state.showTrash = true;
      state.corrupt = null;
      render();
    } else if (act === 'close-trash') {
      state.showTrash = false;
      state.corrupt = null;
      render();
    } else if (act === 'restore-trash') {
      const back = await api('POST', `/api/trash/${encodeURIComponent(el.dataset.key)}/restore`, {});
      await refreshLibrary();
      state.showTrash = false;
      const def = await api('GET', wfPath(back));
      state.wf = { ...back, def, runs: await api('GET', `${wfPath(back)}/runs`) };
      state.versions = await api('GET', `${wfPath(back)}/versions`);
      await refreshProposals(state.wf);
      state.mode = 'list';
      render();
    } else if (act === 'delete-wf') {
      if (!window.confirm(`把「${state.wf.def.name}」移到垃圾桶？30 天內都能復原。`)) return;
      await api('DELETE', wfPath(state.wf), undefined);
      chatByFlow.delete(flowKey(state.wf));
      state.chat = { messages: [], draft: null, busy: false };
      state.wf = null;
      state.mode = 'chat';
      await refreshLibrary();
      render();
    } else if (act === 'restore-corrupt') {
      const w = state.corrupt;
      await api('POST', `${wfPath(w)}/restore`, {});
      state.corrupt = null;
      const def = await api('GET', wfPath(w));
      state.wf = { category: w.category, id: w.id, def, runs: await api('GET', `${wfPath(w)}/runs`) };
      state.versions = await api('GET', `${wfPath(w)}/versions`);
      state.mode = 'list';
      render();
    }
  } catch (err) {
    window.alert(err.message); // 精簡: 動作層錯誤先用原生 alert，之後換 Toast
  }
});

// 匯入選檔 → 讀內容 → 送掃描
document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  state.importScanning = true;
  state.showTrash = false;
  render();
  try {
    const content = await file.text();
    state.importPreview = await api('POST', '/api/import/scan', { content });
  } catch (err) {
    window.alert(err.message);
  }
  state.importScanning = false;
  render();
});

// 行事曆拖拉改時間（D20）：拖排程事件到別的日期格＝單次覆寫 move（保留原時分）
app.addEventListener('dragstart', (e) => {
  const ev = e.target.closest('.cev[draggable="true"]');
  if (!ev) return;
  e.dataTransfer.setData('text/plain', JSON.stringify({ sid: ev.dataset.sid, occ: ev.dataset.occ, time: ev.dataset.time }));
});
app.addEventListener('dragover', (e) => {
  if (state.calendar && e.target.closest('.mcell')) e.preventDefault();
});
app.addEventListener('drop', async (e) => {
  const cell = e.target.closest('.mcell');
  if (!cell || !state.calendar) return;
  e.preventDefault();
  try {
    const d = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
    if (!d.sid || !cell.dataset.date) return;
    await api('POST', `/api/schedules/${encodeURIComponent(d.sid)}/occurrence`, { occ: d.occ, action: 'move', to: `${cell.dataset.date}T${d.time || '08:00'}` });
    await loadCalendar();
    render();
  } catch (err) { window.alert(err.message); }
});

// 全域輕輪詢（30 秒）：紅點與桌面通知在沒開儀表板／行事曆時也活著（開著時各自的輪詢負責）
async function noticePollGlobal() {
  try {
    if (!state.calendar && !state.dash) {
      const before = state.notices.unread.length;
      applyNotices(await api('GET', '/api/notices'));
      const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && document.activeElement.value;
      if (before !== state.notices.unread.length && !typing && !state.run) render();
    }
  } catch { /* 下一輪再試 */ }
  setTimeout(noticePollGlobal, 30000);
}

// ---------- 啟動 ----------
(async function init() {
  await refreshHealth();
  await refreshCompanyName(); // 移植合併輪 U2a：側欄根節點的名字
  await refreshLibrary();
  try {
    state.presets = await api('GET', '/api/presets');
  } catch { /* 常用庫讀不到就先空著 */ }
  try {
    applyNotices(await api('GET', '/api/notices'));
  } catch { /* 通知讀不到就先空著 */ }
  // 記憶輪（M2）：還沒介紹過自己（也沒跳過）→三題先蓋在儀表板前；摘要讀不到就不問，照開儀表板
  try {
    if (!(await api('GET', '/api/memory/summary')).intro_done) state.intro = { saving: false, err: null };
  } catch { /* 讀不到就當問過了 */ }
  // 預設首頁＝儀表板（儀表板輪定案第 5 點）：有事先看到事
  state.dash = { data: null, usageView: 'flow', open: {}, promptView: null, usageOpen: false, showAll: false, calendar: null };
  render();
  try {
    await loadDash();
  } catch { /* 首屏載不到照開，各區顯示空狀態 */ }
  render();
  dashPoll();
  setTimeout(noticePollGlobal, 30000);
})();
