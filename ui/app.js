// 剝繭 UI — 白澤皮 · D15 雙區版型：左=流程庫邊欄；右=工作區（聊天｜清單｜畫布｜履歷 一鍵切換）。
// 聊天、清單、畫布是同一份定義的三種建立／編輯方式；run 執行畫面整區接管。
/* global document, fetch, window, BJCanvas */
const app = document.getElementById('app');

// 聊天窗的空狀態：shape＝拆解器第一趟回的七格 {value,basis}、sources＝來源表、
// category＝卡上分類下拉的值、shapeBase＝七格拆解器原樣快照（常駐輸入框改回原樣＝依據回原樣；出新卡清掉）。放在 state 之前：uiFn 逐條載入不跨句提升
// fileKind＝卡上「交出什麼檔」選的（預設 md），sample＝「照著像的舊作品」（草稿還沒入庫，
// 檔案先擱在前端，存進 Workflow 庫那一刻才真的上傳成流程參考檔）
function emptyChat() { return { messages: [], draft: null, busy: false, shape: null, sources: [], category: null, shapeBase: null, autoShape: null, refs: null, fileKind: null, sample: null }; }

const state = {
  workflows: [],
  categories: [],
  wf: null,          // 已存流程 {category, id, def, runs}
  run: null,         // 開著的 run 紀錄
  mode: 'chat',      // 工作區分頁：chat｜list｜canvas｜history
  editingNode: null, // 停點卡原地編輯中的節點 id
  expanded: new Set(), // 清單模式展開指示的節點
  chat: emptyChat(), // 多 shape／sources／category（成品卡）；shapeBase
  paramNow: {},      // 這次開跑要用的欄位值（僅本次，開別的流程即清）
  runUploads: {},    // 本次上傳 欄位 key→{token,name,size}｜{busy,name}｜{err}；開跑成功才清
  runNote: '',       // 本次補充
  health: null,      // 常駐開跑健檢 {key:定義＋這次的值, result, err}
  editingParam: null, // 指示句內正在點改的欄位 key
  canvasSel: null,
  presets: {},       // 常用預設庫
  wfFiles: [],       // 當前流程的參考檔清單
  drawerOpen: false, // 畫布右側抽屜（雙擊節點打開，D17）
  drawerTabFor: null,   // 步驟彈窗目前畫的是哪顆節點——換節點清暫存字、「更多設定」收摺回自動（子頁退場）
  cvMore: null,         // 抽屜「背景、限制與參考資料」收摺（移植第一批 T11）：null＝照有沒有值決定、true/false＝使用者點過
  stepSnap: null,       // 步驟彈窗開窗時的欄位值（stepFormValues）；比對它判「有改動還沒套用」
  stepSnapFor: null,    // stepSnap 記的是哪顆節點
  stepAsk: false,       // 「有改動還沒套用：套用／丟掉／繼續編輯」詢問列開著
  cvShowIssues: false, // 存檔查出接線問題後，紅標未接上／線不足的步驟
  cvWork: null,      // 畫布工作本（v0.18）：已存流程的未存檔改動
  cvDirty: false,    // 畫布有未存檔改動
  cvHelp: false,     // 畫布「？」操作說明浮層開著
  cvCondEdit: null,  // 畫布上正在原地寫條件的那條擇一線 {from,to,arm}
  cvEdgeSel: null,   // 畫布上點選中的線 {from,to,arm}（按 Delete 剪）
  cvCondIssues: null, // 存檔攔下的空條件線
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
  // ---- 行事曆----
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
  // ---- 儀表板----
  dash: null,          // 開啟時 {data, usageView:'flow'|'day', open:{run鍵→細節}, promptView}
  dashPollTimer: null,
  // ---- ----
  startCheck: null,    // 開跑前健檢卡 {key:定義JSON, level:'block'|'warn', issues}；定義一變就作廢
  dataSupplyOpen: null, // 資料不全卡「補資料」展開中的節點 id
  editRulesOpen: null,  // 「後面每步會守」清單改寫中的節點 id
  supOpen: {},          // 停點卡／查核卡「監工交代」展開中的節點——狀態在這，輪詢重繪不會收合
  keep: {},            // 打字中的多行內容（run_id:元素id → 文字）——整頁重繪後放回，不被輪詢吃掉
  runJson: null,       // 上次抓到的 run 原文——輪詢只在真的變了才重繪
  // ---- ----
  preview: null,       // 成品預覽浮窗 {cat,id,rid,name,data,err,sheet}——狀態在這，輪詢重繪不會關掉它
  rendered: {},        // 文字成品排版快取：內容雜湊 → html（false＝這段排不出來，顯示原文）
  rawView: new Set(),  // 停點卡／成品區按了「看原文」的鍵
  permErr: null,       // 產檔權限開關沒存成的一句話
  permFlashUntil: 0,   // 健檢「修這裡」把權限列亮到幾點（毫秒）——狀態驅動，中途整頁重繪也不會掉 class
  // ---- （M1c）----
  categoryPage: null,  // 群組圈分類頁（側欄分類標題點開）：{category, data:群組圈|null, cards:分類層習慣卡, err, saving, saveErr}
  // ---- 移植第一批 T9：側欄四全域項＋流程庫頁 ----
  library: null,       // 流程庫頁 {q, cat}；null＝沒開
  catClosed: new Set(), // 側欄收合中的分類（只在這個 session，不存）
  // ---- 移植第一批 T10：流程頁兩分頁＋兩浮窗 ----
  flowTab: 'design',   // 流程頁上層分頁：design＝設計流程（聊天／清單／畫布／履歷）、data＝本次資料（開跑表單）
  dataCard: 'data',    // 本次資料哪一張任務卡展開著（resume｜data｜auto｜execution；null＝全收起）
  flowSettingsOpen: false, // 「流程設定」浮窗（產出檔案／交貨查核／監工三開關）
  flowMemOpen: false,  // 記憶一行「查看」浮窗（兩格）
  // ---- （M2）----
  intro: null,         // 首次三題介紹（開站蓋在儀表板前）：{saving, err}；null＝答過或跳過了
  memUndoing: {},      // 通知「不要記」按下去到回來之間（卡 id→true），輪詢重繪不會把按鈕復活
  // ---- （M3b）：開跑表單的習慣選項、點了即核可、身分 ----
  wfMemory: null,      // GET /api/memory/for-workflow 的回應（options＝每個欄位旁的習慣選項）；讀不到＝null：沒有 chip，流程照開
  memPicks: {},        // 這次開跑點了哪些習慣卡（欄位 key→卡 id）——點了即核可，隨「開始」送出
  memChanged: [],      // 點了又改掉的卡 id（後端只記數）
  memMore: {},         // 欄位 key→true：那格的「更多」展開中
  memIdentity: '',     // 這次以哪個身分跑（身分 id；空＝不限縮）
  identities: [],      // 身分清單（有才顯示下拉）
  // ---- （M4）：就地看 ----
  memOpen: {},         // 停點卡／查核卡「這步用了 N 條記憶」展開中的節點（不共用 supOpen）——狀態在這，輪詢重繪不會收合
  memModal: null,      // 卡片浮窗 {id, bucket, card, err, busy, replacing}：card＝GET /api/memory/cards/:id 讀回的整張卡（群組條沒有 API，直接帶 text）；replacing＝「改」展開新內容框
  // ---- （M5a）：設定頁（整頁模式，同儀表板／行事曆）----
  settings: null,      // 開啟時 {group, tab:{組→子分頁}, data, err, idEdit, merge}（素材編輯 搬到 state.assets.edit）：data＝summary／cards／groups／dict／cfg／identities；idEdit／presetEdit＝編輯中的表單（單一真相，重繪從它還原）
  memIdentitySet: false, // 開跑表單的身分下拉被人動過：沒動＝用 for-workflow 回的預設（綁這個分類的身分）
  // ---- 三層樹的根＝公司 ----
  companyName: '',     // 設定的公司名稱（GET /api/settings 的 company_name；空＝側欄印「公司」）
  // ---- 多組織：GET /api/orgs 的一份；orgs 少於 2 筆＝側欄不印切換器（單組織的畫面跟以前一模一樣）----
  orgs: [],            // [{id, name, created_at, workflows}]
  orgId: '',           // 目前組織 id（＝GET /api/orgs 的 current）
  orgMenu: false,      // 側欄組織切換浮層開著（輪詢重繪讀回）
  orgKill: null,       // 設定頁正在確認「移出」的組織 id（要打對名字才解鎖那顆鈕）
  sharedUpload: null,  // 公司頁／部門頁按「上傳」後記 {scope, kind}，#shared-file 的 change 事件讀它決定傳到哪一層哪一區
  // ---- 流程頁右側「流程資料夾」＋共用檔浮窗＋本次資料收摺（狀態都在這，重繪讀回，不靠 DOM 的 open） ----
  wfRuns: [],          // GET …/runs?detail=1 的歷次執行摘要（started_at 倒序）；null＝讀不到。state.wf.runs 仍是原三欄形狀給 resumeHtml
  shared: { company: null, dept: null, err: null }, // 兩層共用檔清單（GET /api/shared/:scope/files）；null＝還沒讀到；err＝哪一支讀不到的一句
  sharedOpen: false,   // 「公司 N 份・部門 M 份共用檔 → 查看」浮窗
  folderOpen: { refs: true, runs: true, optional: null, refsAll: false, runsAll: false }, // 側欄兩塊 details、本次資料「其他資料（選填）」（null＝照有沒有值決定）、兩個「查看全部」
  // ---- 執行頁三欄（狀態都在這，輪詢重繪讀回，不靠 DOM 的 open）----
  sideOpen: { sup: true, data: true, focus: false, attempts: false }, // 右欄四格開合：監工交代／這步會用到的資料／驗收重點／每次交卷
  runInspect: null,    // 左軌點了哪一步＝歷史視圖（U6c；null＝看目前這步）。開跑／打開別的 run／節點消失重設，輪詢不碰，不進 keep
  runInspectLive: null, // ／L12b：左軌點進來看的等你支線是哪一步（還看著它、它處理完就回目前這步）
  promptView: null,    // 執行頁「當時指示」卷宗浮窗 {title, text}（U6b 接；與儀表板的 promptModalHtml 共用）
  // ---- 三層改名浮窗（公司／部門／流程）——狀態在這，輪詢重繪讀回；null＝沒開 ----
  rename: null,        // {type:'company'|'category'|'flow', cat, id, value, err, busy}
  inspectorTab: 'step', // 右欄檢視器分頁 step｜data（Workflow 資料）
  historyTab: 'runs',   // 履歷分頁 runs（執行紀錄）｜versions（Workflow 版本）
  rowMenu: null,       // Workflow 列「⋯」選單 {cat, id, name, x, y, sub}（sub＝「移至部門」子清單展開）
  calMore: false,      // 行事曆右上「⋯」（重新整理 Google 快照）開著沒
  assets: null,        // 共用素材整頁 {tab:'全部'|'角色情境'|'常用片段', edit:{field, orig, name, text, err}|null, err}
  trashFromLib: false, // 垃圾桶是從 Workflow 庫進來的（「回 Workflow 庫」回庫頁）
  importFromLib: false, // 匯入是從 Workflow 庫發起的（預覽頁「不匯入」回庫頁）
};
const seenNotices = new Set(); // 桌面通知去重（本次開頁期間）

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// （09-19 裁示方案 C）：說明收進問號——說明文字不印在畫面上，收進標題旁這顆鈕，
// 滑過就出現、點一下釘住。空字串回空字串，所以「這裡本來就沒說明」跟「說明還沒寫」長得一樣（都不出現）。
// r=true 讓氣泡靠右對齊，給貼在右邊緣的那幾顆用。
const hint = (t, r = false) => (t ? `<button type="button" class="hint${r ? ' r' : ''}" aria-expanded="false" aria-label="說明" data-hint="${esc(t)}">?</button>` : '');
const wfPath = (w) => `/api/workflows/${encodeURIComponent(w.category)}/${encodeURIComponent(w.id)}`;
// 輪詢重繪前的守衛：原本四處各抄一次、而且只認 INPUT／TEXTAREA——
// 下拉展開中被重繪會把選單關掉，可編輯區塊打到一半也會被洗掉。改成一顆共用的。
const isTyping = () => {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'SELECT') return true;          // 展開中沒有「有沒有值」可判，聚焦就算
  return ['INPUT', 'TEXTAREA'].includes(el.tagName) && !!el.value;
};
// 輪詢失敗不該整段靜音：不打擾使用者，但 F12 看得到是哪一路在掉。
const pollFailed = (where, e) => console.error(`[剝繭] ${where} 這一輪沒拿到，下一輪再試`, e);
// 成品檔位址：不帶 sub＝下載；'/preview'＝頁內預覽形態；'/inline'＝內嵌回檔（pdf iframe）
const runFileUrl = (cat, id, rid, name, sub = '') => `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}/runs/${encodeURIComponent(rid)}/files/${encodeURIComponent(name)}${sub}`;

// 成品卡七格：鍵順序＝、中文照設計 §五-1
const SHAPE_LABELS = [['deliverable', '成品'], ['type', '型態'], ['audience', '對象'], ['style', '段子或風格'], ['length', '長度'], ['sections', '分段'], ['range', '範圍']];
// 成品卡來源表的膠囊：六種 from → [人話, chip class]
// 成品卡依據 basis 是拆解器回的資料值，顯示時換字。
// （09-18 選項 B）：中間層改回「分類」，拆解器回的 '分類守則' 與資料值 '未分類' 都跟畫面同字，
// 兩張顯示層表因此只剩「公司規範→組織規範」一條；catLabel 留著當唯一出口（之後要換分類名只動這裡）。
const BASIS_TXT = { '公司規範': '組織規範' };
function catLabel(c) { return c; }
const SOURCE_CHIP = { web: ['AI 上網查', 'chip'], paste: ['你貼・必填', 'chip wait'], upload: ['你上傳', 'chip'], shared: ['組織／分類參考檔', 'chip'], upstream: ['前一步', 'chip'], later: ['連接器・未接', 'chip quiet'] };

// 目前工作區的主體：草稿優先，其次已存流程
const subjectDef = () => state.chat.draft ?? state.wf?.def ?? null;
const subjectIsDraft = () => !!state.chat.draft;
// 「有沒存的東西」＝還沒進庫的草稿（含只有成品卡、只有對話、第一趟還在等）。
// stashWorkspace／dsSnapshot（存進瀏覽器）與側欄草稿列共用這一式，三邊不會再各判各的。
const draftLive = () => !state.wf && !!(state.chat.draft || state.chat.shape || state.chat.busy || state.chat.messages.length);
// 畫布工作本（v0.18）：已存流程在畫布的改動先進本地緩衝，按「存檔」才落地；離開畫布即清
const cvDef = () => (!subjectIsDraft() && state.cvWork ? state.cvWork : subjectDef());

// （DEMO commitActiveFlow／openFlow）：每條流程各自的工作區狀態，離開時打包、回來時讀回（僅存於本次開啟期間；重開頁面歸零）。
// 鍵＝「分類/流程 id」；新流程草稿＝'__draft__'。run／versions／wfRuns／wfFiles／shared 不暫存（每次重抓，資料才對）。
const wsByFlow = new Map();
const flowKey = (w) => `${w.category}/${w.id}`;
const WS_KEYS = ['chat', 'mode', 'flowTab', 'canvasSel', 'drawerOpen', 'paramNow', 'runUploads', 'runNote', 'memPicks', 'memChanged', 'memIdentity', 'memIdentitySet', 'folderOpen', 'expanded', 'cvWork', 'cvDirty'];
// 離開工作區前呼叫：已存流程存在自己的鍵下；新流程草稿存 __draft__；wf 開著但主體是草稿（或 wf null 沒草稿）不存（同舊聊天暫存規則）
function stashWorkspace() {
  const key = state.wf && !subjectIsDraft() ? flowKey(state.wf) : draftLive() ? '__draft__' : null; // 成品卡（還沒有草稿）也算一份沒存的東西，跟著 __draft__ 走；第一趟還在等（busy）或只有對話也算
  if (!key || wsByFlow.has(key)) return; // 已經打包過（去了儀表板等頁還沒回來）就不再蓋——那些頁會順手把 drawerOpen 之類關掉，蓋了會洗掉包裡的值
  wsByFlow.set(key, Object.fromEntries(WS_KEYS.map((k) => [k, state[k]])));
}
// 打開流程／草稿時呼叫：有包＝讀回（包從 Map 取走，不留過期副本；缺的鍵補預設）、沒包＝現況預設；回有沒有包
function restoreWorkspace(key) {
  const p = wsByFlow.get(key);
  wsByFlow.delete(key);
  Object.assign(state, {
    chat: emptyChat(), mode: key === '__draft__' ? 'chat' : 'list', flowTab: 'design', canvasSel: null, drawerOpen: false, paramNow: {}, runUploads: {}, runNote: '',
    memPicks: {}, memChanged: [], memIdentity: '', memIdentitySet: false, folderOpen: { refs: true, runs: true, optional: null, refsAll: false, runsAll: false }, expanded: new Set(), cvWork: null, cvDirty: false,
  }, p ?? {});
  return !!p;
}

// ---------- （09-18「草稿被 F5 弄掉不能接受」）：沒存的東西隨打隨存進瀏覽器，重新整理還原 ----------
// 存什麼：wsByFlow 的暫存包＋正在看的那一份（鍵規則同 stashWorkspace）＋打到一半還沒送出的字（state.keep）。
// 不存畫布工作本（cvWork／cvDirty，量太大）——它照舊「離開前警告、存檔才寫回」。
// 鍵綁目前的資料夾（GET /api/settings 的 data_dir 雜湊）：換資料夾＝另一個鍵，不同資料庫不互串；
// 開站只清「已經不在的組織」留下的殘骸鍵——還在的組織那把是人家沒存的草稿，不准清（見 dsLiveKeys）。
const DS_V = 1;             // 版本欄位：格式對不上一律丟棄，不硬還原
const DS_PREFIX = 'bojian.ws.';
const DS_MAX = 1024 * 1024; // 總量上限 1MB：超過只留正在編輯的那一份
const DS_KEYS = WS_KEYS.filter((k) => k !== 'cvWork' && k !== 'cvDirty');
let dsKey = null;     // localStorage 的鍵；null＝還認不得資料夾（設定讀不到）＝不讀也不存
let dsTimer = null;
let dsAt = {};        // 每份包的最後編輯時間（側欄草稿列印相對時間）
let dsSeen = {};      // 上次存下去的內容：一模一樣就不動時間（輪詢重繪不算編輯）
let dsFailed = false; // 存不進去（隱私模式、配額滿）或超量丟掉了東西
const dsHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
function dsStore() { try { return window.localStorage; } catch { return null; } } // 隱私模式連讀 localStorage 都會炸
let dsDir = '';       // 目前資料夾的原字串（推算別的組織那把鍵用）
function dsBind(dir) { dsDir = String(dir ?? ''); dsKey = DS_PREFIX + dsHash(dsDir); }
// 哪些鍵還是活的＝目前這把＋現存每個組織那把。切組織是整頁重載換資料夾，別的組織的鍵是人家沒存的草稿，不是殘骸。
// 別的組織的資料夾＝把 data_dir 結尾的組織 id 換成它的 id（直接換字串，不猜路徑分隔符號）；認不出組織（單組織、清單讀不到）就只認得目前這把，照舊清。
function dsLiveKeys() {
  const live = new Set(dsKey ? [dsKey] : []);
  const id = state.orgId;
  if (id && dsDir.endsWith(id)) {
    const base = dsDir.slice(0, dsDir.length - id.length);
    for (const o of state.orgs ?? []) if (o?.id) live.add(DS_PREFIX + dsHash(base + o.id));
  }
  return live;
}
// 一份工作區包 與 存得進 JSON 的形狀 互轉（expanded 是 Set）
// 舊作品的 base64 不能進 localStorage——一份 3MB 的簡報就會吃掉整個 1MB 額度，
// 把別的草稿擠掉、甚至讓整包存不進去（ 承諾的「F5 不掉草稿」會無聲失效）。只留檔名。
const dsChat = (c) => (c?.sample?.b64 ? { ...c, sample: { name: c.sample.name } } : c);
const dsPack = (src) => Object.fromEntries(DS_KEYS.map((k) => [k, k === 'expanded' ? [...(src[k] ?? [])] : (k === 'chat' ? dsChat(src[k]) : src[k])]));
const dsUnpack = (o) => Object.fromEntries(DS_KEYS.filter((k) => k in o).map((k) => [k, k === 'expanded' ? new Set(o[k] ?? []) : o[k]]));
// 這一份包裡有沒有「沒存的東西」：空包（只是逛過去、剛存進庫）不占位，localStorage 才不留殘骸
const dsWorth = (p) => !!(p.chat?.draft || p.chat?.shape || p.chat?.busy || p.chat?.messages?.length
  || Object.keys(p.paramNow ?? {}).length || Object.keys(p.runUploads ?? {}).length || p.runNote);
// 現在有哪些沒存的東西：暫存包＋正在看的那一份（live＝正在看的那個鍵，超量時留它）
function dsSnapshot() {
  const packs = {};
  for (const [k, p] of wsByFlow) if (dsWorth(p)) packs[k] = dsPack(p);
  const liveKey = state.wf && !subjectIsDraft() ? flowKey(state.wf) : draftLive() ? '__draft__' : null;
  const live = liveKey && dsWorth(state) ? liveKey : null;
  if (live) packs[live] = dsPack(state);
  return { packs, live };
}
function dsSave() {
  dsTimer = null;
  const ls = dsKey && dsStore();
  if (!ls) { dsFailed = !!dsKey; return; } // 排版輪 F3b：隱私模式連讀 localStorage 都炸＝也是「存不進去」，要讓 dsAtRisk 抓得到（有沒存的東西才會攔）
  const { packs, live } = dsSnapshot();
  const keep = Object.fromEntries(Object.entries(state.keep).filter(([, v]) => typeof v === 'string' && v));
  const now = Date.now();
  const at = {};
  for (const [k, p] of Object.entries(packs)) {
    const s = JSON.stringify(p);
    at[k] = s === dsSeen[k] ? (dsAt[k] ?? now) : now;
    dsSeen[k] = s;
  }
  for (const k of Object.keys(dsSeen)) if (!(k in packs)) delete dsSeen[k]; // 存進庫／丟掉的那份不留殘骸
  dsAt = at;
  if (!Object.keys(packs).length && !Object.keys(keep).length) { try { ls.removeItem(dsKey); } catch { /* 清不掉就算了 */ } dsFailed = false; return; }
  let body = { v: DS_V, folder: dsKey, at, packs, keep };
  let text = JSON.stringify(body);
  let dropped = false;
  if (text.length > DS_MAX) { // 太大（多半是對話很長）：只留正在編輯的那一份，其餘丟掉
    const one = live ?? Object.keys(packs).sort((a, b) => (at[b] ?? 0) - (at[a] ?? 0))[0];
    body = { v: DS_V, folder: dsKey, at: { [one]: at[one] }, packs: { [one]: packs[one] }, keep: {} };
    text = JSON.stringify(body);
    dropped = true;
  }
  try { ls.setItem(dsKey, text); dsFailed = dropped; }
  catch { dsFailed = true; } // 配額滿或不給寫：畫面照常，只有關頁前多問一句
}
const dsSchedule = () => { if (dsKey && !dsTimer) dsTimer = setTimeout(dsSave, 500); }; // 節流 500ms
const dsSaveNow = () => { clearTimeout(dsTimer); dsTimer = null; dsSave(); };
// 關頁前要不要攔一句：只在「沒存的東西真的沒存進瀏覽器」時（存不進去，或認不得資料夾）；存得進去就不囉嗦
const dsAtRisk = () => (!dsKey || dsFailed) && !!Object.keys(dsSnapshot().packs).length;
// 開站讀回（init 在 refreshLibrary 之後叫）：已經不在的資料夾留下的先清掉（現存組織的那幾把留著）；版本、資料夾、形狀任一對不上就整份丟棄
function dsLoad() {
  const ls = dsKey && dsStore();
  if (!ls) return;
  const live = dsLiveKeys();
  try { for (let i = ls.length - 1; i >= 0; i--) { const k = ls.key(i); if (k && k.startsWith(DS_PREFIX) && !live.has(k)) ls.removeItem(k); } } catch { /* 清不掉不影響讀回 */ }
  let body = null;
  try { body = JSON.parse(ls.getItem(dsKey) ?? 'null'); } catch { body = null; }
  if (!body || body.v !== DS_V || body.folder !== dsKey || !body.packs || typeof body.packs !== 'object') { try { ls.removeItem(dsKey); } catch { /* 同上 */ } return; }
  for (const [k, p] of Object.entries(body.packs)) {
    if (!p || typeof p !== 'object' || !p.chat || typeof p.chat !== 'object' || !Array.isArray(p.chat.messages)) continue; // 這一份形狀不對＝只跳過它
    if (k !== '__draft__' && !state.workflows.some((w) => flowKey(w) === k)) continue; // 已經不在庫裡的（刪了、搬走了）不還原
    wsByFlow.set(k, dsUnpack(p));
    dsAt[k] = Number(body.at?.[k]) || Date.now();
  }
  if (body.keep && typeof body.keep === 'object') for (const [k, v] of Object.entries(body.keep)) if (typeof v === 'string') state.keep[k] = v;
}
// 側欄草稿列的「最後編輯」相對時間
function agoText(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return '剛剛編輯';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分鐘前編輯`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} 小時前編輯` : `${Math.round(h / 24)} 天前編輯`;
}

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

// ---- 開跑前健檢：結果按定義 JSON 字串快取，抽屜／清單每次 render 不重打 ----
const preflightCache = { key: null, result: null, failed: false, pending: null };
// values＝這次的欄位值（只有按「開始」才帶）：帶值的結果隨值而變，不進快取
async function preflightNow(def, values) {
  const key = JSON.stringify(def);
  if (!values && preflightCache.key === key && preflightCache.result) return preflightCache.result;
  const r = await api('POST', '/api/preflight', values ? { def, values } : { def });
  if (!values) Object.assign(preflightCache, { key, result: r, failed: false, pending: null });
  return r;
}
// 健檢回應的輸入來源（src/preflight packInputs）展開成某一步的清單 [{kind,id,label}]——與 inputSources(def)[id] 逐項相同
function pfInputs(pf, id) {
  const x = pf?.inputs;
  const me = x?.at?.[id];
  if (!me) return [];
  const order = [];
  const walk = (k) => { const e = x.pred?.[k]; if (!e) return; walk(e[0]); order.push(...e); };
  walk(id);
  const near = new Set(me.near ?? []);
  const tag = (k) => (me.any && near.has(k) ? '（任一條到）' : '');
  const list = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const k = order[i];
    const s = x.src?.[k];
    if (!s) continue;
    list.push(s.h ? { kind: 'human', id: k, label: `《${s.t}》（你來做）交出的內容${s.o ? `：${s.o}` : ''}${tag(k)}` }
      : { kind: 'upstream', id: k, label: `${near.has(k) ? '上一步' : '更早的步驟'}《${s.t}》的產出${tag(k)}` });
  }
  return [...list, ...(me.own ?? [])];
}
// render 途中用：有快取就回，沒有就背景打一次、回來只補 DOM（不整頁 render，免得洗掉抽屜裡的字）
// 畫布連續編排中（上次改動 2 秒內）先不送、停手 2 秒補一次。
// L14b：健檢回應改不重複的寫法（200 步 1,191,259→16,307 字元）後試過縮成 0.4 秒——回應變小了，但回來後右欄輸入來源（深的步驟上百行）重畫會落進拉線放開後，
// x4 同時段交錯各量三次、放開後中位數 25％ 98→114、100％ 37→98、200％ 78→89 ms，所以維持 2 秒
let cvEditAt = 0;
let cvPfTimer = null;
const CV_PF_QUIET = 2000;
function preflightFor(def) {
  if (!def) return null;
  const key = JSON.stringify(def);
  if (preflightCache.key === key) return preflightCache.result;
  const quiet = CV_PF_QUIET - (Date.now() - cvEditAt);
  if (quiet > 0 && state.mode === 'canvas' && !state.run) {
    clearTimeout(cvPfTimer);
    cvPfTimer = setTimeout(() => { if (state.mode === 'canvas' && cvDef()) preflightFor(cvDef()); }, quiet + 20);
    return null;
  }
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
  const ins = document.querySelector('[data-insp-inputs]'); // 右欄檢視器的輸入來源同樣只補這一塊
  if (ins && !state.run) {
    const def = cvDef();
    const n = def?.nodes.find((x) => x.id === state.canvasSel);
    if (n) ins.outerHTML = inspInputsHtml(n, def);
  }
  const unused = preflightCache.result?.unused_params ?? [];
  for (const c of document.querySelectorAll('[data-unused]')) c.hidden = !unused.includes(c.dataset.unused);
  const src = document.querySelector('[data-srcline]'); // 執行頁右欄「來源：」：健檢回來只補這一行，不整頁重繪
  if (src && state.run) src.outerHTML = sideSourceHtml(state.run, sideNodeOf(state.run));
}

// ---- 本次資料的常駐開跑健檢——打開分頁就跑、欄位停 600ms 自己重算，只補畫這張卡（不整頁重繪，打到一半的字不受影響）----
// 這次的值：文字欄位＝輸入中或預設（同按開始那一刻）；上傳欄位＝上傳好的檔名，沒上傳／還在傳／傳失敗＝空
function healthValues(def) {
  return Object.fromEntries((def.params ?? []).map((p) => [p.key, p.input === 'file'
    ? (state.runUploads?.[p.key]?.token ? state.runUploads[p.key].name : '')
    : (state.paramNow[p.key] ?? p.default)]));
}
const healthKey = (def) => JSON.stringify([def, healthValues(def)]);
let healthTimer = null;
let healthPending = null;
async function recheckHealth() {
  const def = subjectDef();
  if (!def || subjectIsDraft()) return;
  const values = healthValues(def);
  const key = JSON.stringify([def, values]);
  let result = null;
  let err = null;
  try { result = await preflightNow(def, values); } catch (e) { err = e.message; }
  if (healthKey(subjectDef() ?? def) !== key) return; // 等的時候值又變了：這份丟掉（下一次重算已排上）
  state.health = { key, defKey: JSON.stringify(def), result, err };
  patchHealthCard();
}
// render 途中用：這組值還沒查過就背景查一次（同一組只打一次）；先回同一份定義的上一份結果（別條 Workflow 的不拿來充數）
function healthFor(def) {
  const key = healthKey(def);
  if (state.health?.key !== key && healthPending !== key) {
    healthPending = key;
    recheckHealth().finally(() => { if (healthPending === key) healthPending = null; });
  }
  return state.health?.defKey === JSON.stringify(def) ? state.health : null;
}
function scheduleHealth() {
  clearTimeout(healthTimer);
  healthTimer = setTimeout(recheckHealth, 600);
}
function patchHealthCard() {
  const box = document.querySelector('[data-healthcard]');
  if (box) box.outerHTML = healthCardHtml();
  const card = document.querySelector('[data-startcard]'); // 右欄摘要卡（必填 x/y、健檢、進度條）跟著補畫，一樣不整頁重繪
  if (card) card.outerHTML = startCardHtml();
}
function healthCardHtml() {
  const def = subjectDef();
  if (!def || subjectIsDraft()) return '';
  const h = healthFor(def);
  const card = (cls, body) => `<div class="healthcard${cls ? ` ${cls}` : ''}" data-healthcard><div class="heading"><h3>開跑健檢</h3><button class="btn sm2" data-act="pf-recheck">重新檢查</button></div>${body}</div>`;
  if (!h?.result) return card('', h?.err ? `<p class="note">健檢暫時讀不到（${esc(h.err)}）；按開始時會再檢查一次。</p>` : '<p class="note">檢查中⋯</p>');
  const row = (i) => `<div class="pfrow ${i.level === 'block' ? 'block' : 'warn'}">
      <span class="pfic"><i class="ph-fill ${i.level === 'block' ? 'ph-x-circle' : 'ph-warning'}"></i></span>
      <div class="pftext"><span class="pft">${esc(i.title)}</span><div class="pfdetail">${esc(i.detail ?? '')}</div></div>
      ${i.fix ? `<button class="btn sm2" data-act="pf-fix" data-kind="${esc(i.fix.kind)}" data-id="${esc(i.fix.id)}">修這裡</button>` : ''}
    </div>`;
  const issues = h.result.issues ?? [];
  const blocks = issues.filter((i) => i.level === 'block');
  const warns = issues.filter((i) => i.level !== 'block');
  const steps = def.nodes.filter((x) => kindOf(x) === 'task').length;
  if (blocks.length) {
    return card('block', `<p class="hsum">有 ${blocks.length} 處要先修，修好才能開始。</p>${blocks.map(row).join('')}${warns.length ? `<div class="pfsub">另外 ${warns.length} 則提醒，不擋跑</div>${warns.map(row).join('')}` : ''}`);
  }
  if (warns.length) return card('warn', `<p class="hsum">資料已備齊・${steps} 個步驟已準備；${warns.length} 則提醒，不擋跑</p>${warns.map(row).join('')}`);
  return card('ok', `<p class="hsum">資料已備齊・${steps} 個步驟已準備</p><p class="note">開始時用目前已儲存的 Workflow 版本。</p>`);
}

// ---- 打字中的多行框：input 事件存進 state.keep，重繪後放回 ----
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
  const at = new Map(def.nodes.map((n, i) => [n, i])); // 原本比較函式裡 indexOf（200 步排序要掃上萬次），順序不變
  return [...def.nodes].sort((a, b) => depth.get(a.id) - depth.get(b.id) || at.get(a) - at.get(b));
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

// ---- （M3b）：開跑表單的習慣選項 ----
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
    : c.scope?.level === 'all' ? '全部 Workflow 共用的習慣' : c.scope?.level === 'category' ? '這個分類共用的習慣' : '這條 Workflow 的習慣');
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
// 原本整段印在開跑表單裡，改成併進「填寫這次的值」的標題說明（同一個區塊不講兩次）
const habitsNoteText = () => (Object.keys(state.wfMemory?.options ?? {}).length
  ? '習慣選項只是選項：沒點就不套用；點了就是核可，不另外問。虛線的來自別條 Workflow，點了範圍才擴大。' : '');
const habitsNoteHtml = () => '';
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

// ---- （M4）：就地看——流程頁兩格、停點卡「這步用了 N 條」、抽屜一列、卡片浮窗、儀表板一行 ----
// 卡上的小標籤：認識卡照層、群組條照來源、習慣卡照欄位（都用既有 .chip 淺底墨字，不另配色）
function memTagHtml(c) {
  if (c.bucket === 'group') return '<span class="chip">分類守則</span>';
  if (c.bucket === 'profile') return `<span class="chip">${c.layer === 'content' ? '按場合帶' : '每步帶'}</span>`;
  return `<span class="chip">${c.field ? `欄位：${esc(c.field)}` : '開跑選項'}</span>`;
}
// 「用在哪」人話：全部流程／<分類>這個分類／只有「<流程名>」（流程名對不到側欄清單就退回「分類/id」）
function memScopeText(s) {
  if (!s?.level) return '（沒寫）';
  if (s.level === 'all') return '全部 Workflow';
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
const MEM_OVER_BY = { group: '分類的規矩', workflow: '這條 Workflow', run: '這一次的設定' };
function memoryUsedHtml(node, step) {
  const mem = step?.memory;
  if (!mem) return '';
  const cards = mem.cards ?? [];
  const open = !!state.memOpen[node.id];
  const cat = state.run?.workflow?.category ?? '';
  // 沒記憶卡但這步帶了規範／共用檔（沒接記憶門面時 cards 是空殼）——別說「沒帶任何記憶」，指去右欄
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
  // 公司／部門規範每步自動帶（讀 state.shared 的 rules 數）；記憶讀不到但有規範仍印規範那兩段
  const cRules = state.shared?.company?.rules?.length ?? 0;
  const dRules = state.shared?.dept?.rules?.length ?? 0;
  if ((!m && !cRules && !dRules) || subjectIsDraft() || kindOf(n) !== 'task' || n.executor !== 'ai') return '';
  const core = (m?.core?.expression?.length ?? 0) + (m?.core?.content?.length ?? 0);
  const rules = m?.group?.rules?.length ?? 0;
  const keys = new Set([...MEM_REF_FIELDS.map((f) => String(n[f] ?? '')).join('\n').matchAll(MEM_PARAM_REF)].map((x) => x[1]));
  const opts = [...keys].reduce((a, k) => a + (m?.options?.[k]?.covers?.length ?? 0), 0);
  // 移植第一批 T11（-2）：一行分開數，不加「條」；U4c（-2）：四段 關於你・分類守則・公司規範・部門規範，0 的段省略、全 0 印「沒有記憶與規範」
  const parts = [m?.paused ? '關於你 暫停中' : `關於你 ${core}`, `分類守則 ${rules}`, `組織規範 ${cRules}`, `分類規範 ${dRules}`, ...(opts ? [`習慣選項 ${opts}`] : [])].filter((p) => !/ 0$/.test(p));
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
    body = `<h3>${esc(c.text)}${hint(`分類「${catLabel(c.category)}」的規矩：每一步都帶，交貨查核也會對。要改或刪，去側欄點分類名，改那段文字就好。`)}</h3>
      <div class="face">
        <div class="k">來自</div><div class="v">分類・${esc(catLabel(c.category))}</div>
        <div class="k">用法</div><div class="v">${c.field ? `有名字的欄位「${esc(c.field)}」＝「${esc(c.value ?? '')}」：這條 Workflow 或這一次另有值時，以外圈為準` : '自由規矩：不管外圈怎麼寫都疊加'}</div>
        <div class="k">範圍</div><div class="v">${esc(catLabel(c.category))}這個分類的每一條 Workflow</div>
        <div class="k">來源</div><div class="v">你在分類頁「分類守則」文字框打的</div>
      </div>
`;
  } else {
    const isP = c.bucket === 'profile';
    title = isP ? '認識卡' : '習慣卡';
    const how = isP ? `${c.layer === 'content' ? '按場合帶：這條 Workflow 的場合對上才附在每步指示裡' : '每步帶：每一步的指示都附上'}${c.field ? `　欄位：${esc(c.field)}` : ''}`
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
  // 頂欄退場，狀態只寫 state.claude，由側欄底部（sideHtml 的 .sidefoot）讀；呼叫端自己 render
}

// （驗收第 3 條）：鍵盤操作——側欄那些 div／i 做的可點元素帶 tabindex，Enter／空白鍵轉成 click；原生按鈕與輸入框不經這裡
function keyActivate(e) {
  if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.matches?.('[data-act][tabindex]')) return false;
  e.preventDefault(); // 擋 summary 原生收合、空白鍵捲頁
  const t = e.target;
  t.click();
  if (t.isConnected === false) { // 同步重繪換掉了：焦點放回新畫出來的同一顆（同 data-act／cat／id），不用從頭 Tab
    const d = t.dataset;
    [...document.querySelectorAll(`[data-act="${d.act}"][tabindex]`)].find((x) => x.dataset.cat === d.cat && x.dataset.id === d.id)?.focus();
  }
  return true;
}

// 頁標題元件（樣稿 uxHead）——大標＋一行灰字說明＋右側動作鈕；標題與說明 escape，動作是呼叫端組好的 HTML
function pageHeadHtml(title, sub, actions) {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
}

// 公司名稱——側欄根節點、麵包屑、公司頁標題共用；空白退回「公司」（-8）
const companyName = () => (state.companyName ?? '').trim() || '組織';
async function refreshCompanyName() {
  try {
    const s = await api('GET', '/api/settings');
    state.companyName = s.company_name ?? '';
    dsBind(s.data_dir); // 瀏覽器暫存綁這個資料夾（換資料夾＝另一個鍵）
  } catch {
    state.companyName = ''; // 讀不到＝未設（也認不得資料夾：這一輪不存，關頁前改用警告兜底）
  }
  // 多組織：組織清單＋目前是哪個，側欄切換器與設定頁組織管理共用這一份。
  // 刻意跟著這支一起抓（不另外加 init 步驟）：兩支都是「我現在在哪個組織」的同一件事，錯開抓會出現名字與清單對不上的空窗
  try {
    const o = await api('GET', '/api/orgs');
    state.orgs = Array.isArray(o.orgs) ? o.orgs : [];
    state.orgId = o.current ?? '';
  } catch {
    state.orgs = []; // 讀不到＝當成單組織：側欄不印切換器，設定頁組織清單空著，其餘照舊
    state.orgId = '';
  }
}

// ---------- 三層改名浮窗（DEMO uxRename／uxRenameSave）——掛 .layout 外的 .pvback.memmodal；狀態全在 state.rename，輪詢重繪讀回 ----------
function renameModalHtml() {
  const r = state.rename;
  if (!r) return '';
  const label = r.type === 'company' ? '組織' : r.type === 'category' ? '分類' : ' Workflow '; // 中文與 Workflow 之間半形空白
  const note = r.type === 'flow' ? '名稱會同步顯示於工作空間；既有執行與版本快照保留原名。' : '名稱會同步到工作空間及相關 Workflow。';
  const dis = r.busy ? ' disabled' : '';
  return `<div class="pvback memmodal renamemodal" data-act="rename-close"><div class="modal" role="dialog" aria-label="修改${label}名稱">
    <div class="cvdhead" style="margin-bottom:var(--s2)"><span class="overline">修改${label}名稱</span>
      <button class="btn btn-ghost iconb" data-act="rename-close" style="margin-left:auto" title="關閉（Esc）"${dis}><i class="ph ph-x"></i></button></div>
    <p class="note" style="margin:0 0 var(--s2)">${note}</p>
    <label class="label" for="rename-name">${label.trimStart()}名稱</label>
    <input id="rename-name" value="${esc(r.value ?? '')}" maxlength="60" class="notein" data-keep autocomplete="off"${dis}>
    <p id="rename-error" class="form-error" role="alert">${r.err ? esc(r.err) : ''}</p>
    <div class="btns"><button class="btn btn-ghost" data-act="rename-close"${dis}>取消</button><button class="btn btn-primary" data-act="rename-save"${dis}><i class="ph ph-check"></i>儲存</button></div>
  </div></div>`;
}
// 存：公司→既有 PUT /api/settings（company_name）；部門→PUT /api/categories/:name；流程→既有存新版本（PUT def，後端註記「改名：舊→新」）。
// 存成後照「同步」列改 state，再 refreshLibrary()＋render()；失敗（400／404／409）一句留在浮窗紅字，不關窗
async function renameSave() {
  const r = state.rename;
  if (!r || r.busy) return;
  const name = (r.value ?? '').trim();
  if (!name) { r.err = '名稱不可留空，請填寫名稱。'; render(); document.getElementById('rename-name')?.focus(); return; }
  const old = r.type === 'company' ? (state.companyName ?? '').trim() : r.type === 'category' ? r.cat : (state.workflows.find((w) => w.category === r.cat && w.id === r.id)?.name ?? '');
  if (name === old) { state.rename = null; render(); return; } // 沒改＝當取消
  r.err = null;
  r.busy = true;
  render();
  try {
    if (r.type === 'company') {
      await api('PUT', '/api/settings', { company_name: name });
      state.companyName = name;
      if (state.settings?.data?.cfg) state.settings.data.cfg.company_name = name; // 設定→資料的欄位若開著也跟著
    } else if (r.type === 'category') {
      await api('PUT', `/api/categories/${encodeURIComponent(r.cat)}`, { name });
      if (state.wf?.category === r.cat) state.wf.category = name;
      if (state.run?.workflow?.category === r.cat) state.run.workflow.category = name; // 執行頁輪詢用 run.workflow 組路徑，不改會 404
      if (state.categoryPage?.category === r.cat) state.categoryPage.category = name;
      if (state.library?.cat === r.cat) state.library.cat = name;
      if (state.catClosed.has(r.cat)) { state.catClosed.delete(r.cat); state.catClosed.add(name); }
      for (const [k, v] of [...wsByFlow]) if (k.startsWith(`${r.cat}/`)) { wsByFlow.delete(k); wsByFlow.set(`${name}/${k.slice(r.cat.length + 1)}`, v); } // 暫存包跟著換鍵
      await refreshLibrary();
    } else {
      const w = { category: r.cat, id: r.id };
      const opened = state.wf && state.wf.category === r.cat && state.wf.id === r.id;
      const def = structuredClone(opened ? state.wf.def : await api('GET', wfPath(w)));
      def.name = name;
      await api('PUT', wfPath(w), { def });
      if (opened) {
        state.wf.def = def;
        if (state.cvWork) state.cvWork.name = name; // 畫布工作本若開著，下次「存檔」不能把名字改回去
        state.versions = await api('GET', `${wfPath(state.wf)}/versions`);
      }
      const stashed = wsByFlow.get(flowKey(w));
      if (stashed?.cvWork) stashed.cvWork.name = name; // 暫存包裡的畫布工作本也跟著改名
      await refreshLibrary();
    }
    state.rename = null;
    render();
  } catch (err) {
    r.busy = false;
    r.err = err.message;
    render();
    document.getElementById('rename-name')?.focus();
  }
}


// ---------- 流程庫邊欄 ----------
// 三層樹的根節點（公司）——不是第五個全域項（不用 .calentry，T9① 只認四個）；點了開公司頁（分類頁特例 _company）
// DEMO 版型 .company-row（小字「公司」＋粗體名＋鉛筆）；點名字仍走 open-company（語意不變）
function companyNodeHtml() {
  const now = state.categoryPage?.category === '_company';
  return `<div class="company-row${now ? ' active' : ''}"><div class="wf companynode${now ? ' now' : ''}"${now ? ' aria-current="page"' : ''} data-act="open-company" tabindex="0" role="button" title="組織層共用檔"><span class="company-icon"><i class="ph ph-buildings"></i></span><span class="tree-name"><small>組織</small><strong>${esc(companyName())}</strong></span></div>${renameBtnHtml('company', '', '', companyName())}</div>`;
}
// 多組織：側欄組織切換器——只有兩個以上組織才印出來（一個組織時側欄完全不變，畫面不多一列）。
// 名字已經在上面的 .company-row 印過了，這一列只講「換一個」；點開沿用「⋯」選單的 .rowmenu 浮層樣式，目前那個打勾。
function orgSwitchHtml() {
  const list = state.orgs ?? [];
  if (list.length < 2) return '';
  const item = (o) => `<button type="button" role="menuitem" data-act="org-go" data-id="${esc(o.id)}"${o.id === state.orgId ? ' aria-current="true" class="on"' : ''}><i class="ph ${o.id === state.orgId ? 'ph-check' : 'ph-buildings'}"></i>${esc(o.id === state.orgId ? companyName() : (o.name || '組織'))}</button>`;
  const menu = !state.orgMenu ? '' : `<div class="rowmenu org-menu" role="menu" aria-label="切換組織">${list.map(item).join('')}
    <div class="org-menu-rule"></div>
    <button type="button" role="menuitem" data-act="org-manage"><i class="ph ph-gear"></i>管理組織</button></div>`;
  return `<div class="org-switch"><button type="button" class="org-switch-btn" data-act="org-menu" aria-haspopup="menu" aria-expanded="${!!state.orgMenu}" title="切換組織（共 ${list.length} 個）"><i class="ph ph-arrows-left-right"></i><span class="tree-name">切換組織</span><span class="org-count">${list.length}</span><i class="ph ph-caret-down"></i></button>${menu}</div>`;
}
// 三層鉛筆（DEMO uxRenameButton）——滑過該列才顯示（同 .wfdel 手勢）；點了開改名浮窗（rename-open）
function renameBtnHtml(type, cat, id, name) {
  const label = type === 'company' ? '組織' : type === 'category' ? '分類' : ' Workflow';
  return `<button type="button" class="tree-rename" data-act="rename-open" data-type="${type}"${cat ? ` data-cat="${esc(cat)}"` : ''}${id ? ` data-id="${esc(id)}"` : ''} title="修改名稱" aria-label="修改${label}「${esc(name)}」名稱"><i class="ph ph-pencil-simple"></i></button>`;
}
function sideHtml() {
  const byCat = {};
  for (const c of state.categories) byCat[c] = [];
  for (const w of state.workflows) (byCat[w.category] ??= []).push(w);
  // 移植第一批 T9：分類樹＝<details>；點文字開分類頁（click 處理器 preventDefault 不讓 summary 原生切換）、點箭頭收合；
  // 收合狀態在 state.catClosed（重繪照它還原）；正在看的分類強制展開
  // summary 內是 DEMO 的 .dept-row（方塊＋名＋流程數＋鉛筆），流程列包 .flow-branches／.flow-row（圓點＋名＋垃圾桶＋鉛筆）；
  // details.cat 本身就是 DEMO 的 .dept-group（T9① 釘住 <details class="cat"> 字面，不另加 class）；「未分類」不能改名，沒有鉛筆
  // 新流程草稿（暫存在 wsByFlow 的 __draft__，或正在看的）在「未分類」群組多一列；沒有「未分類」就放樹底
  const onPage = state.calendar || state.categoryPage || state.settings || state.library || state.dash || state.assets; // 同下方 nowFlow 的整頁條件（ 加共用素材）（ 補儀表板：開著儀表板時 state.wf 還在，流程列不該仍標選中）
  const draftNow = !onPage && draftLive(); // 只有成品卡、只有對話也算正在看的草稿（跟還原行為一致）
  // （09-18）：草稿列挪到「＋ 建立新 Workflow」下方（本來沒有「未分類」部門時會掉到整棵樹最底端當灰字斜體，看不到）；
  // 印最後編輯時間（存進瀏覽器那一刻記的），旁邊一顆「丟掉」要二次確認
  const draftAgo = dsAt['__draft__'];
  const draftRow = wsByFlow.has('__draft__') || draftNow
    ? `<div class="flow-row draftrow${draftNow ? ' active' : ''}"><div class="wf${draftNow ? ' now' : ''}" data-act="open-draft" tabindex="0" role="button" title="還沒存進 Workflow 庫的草稿"><span class="flow-dot" aria-hidden="true"></span><span class="tree-name">草稿・還沒存</span>${draftAgo ? `<span class="draftago">${esc(agoText(draftAgo))}</span>` : ''}</div><button type="button" class="draftdrop" data-act="drop-draft" title="丟掉這份還沒存的草稿" aria-label="丟掉這份還沒存的草稿"><i class="ph ph-x"></i></button></div>` : '';
  // （驗收第 3 條）：收合箭頭常駐在部門列最前；Workflow 列滑過／聚焦才出鉛筆與「⋯」，刪除收進「⋯」（rowMenuHtml）；
  // div／i 做的可點元素帶 tabindex＋role，Enter／空白鍵由 keyActivate 轉 click
  const catHtml = Object.entries(byCat).map(([cat, wfs]) => {
    const now = state.categoryPage?.category === cat;
    const open = now || !state.catClosed.has(cat);
    const rows = wfs.map((w) => {
      const nowFlow = !!(state.wf && !onPage && !subjectIsDraft() && w.id === state.wf.id && w.category === state.wf.category);
      return `<div class="flow-row${nowFlow ? ' active' : ''}"><div class="wf${nowFlow ? ' now' : ''}" data-act="open" data-cat="${esc(w.category)}" data-id="${esc(w.id)}" tabindex="0" role="button"${nowFlow ? ' aria-current="page"' : ''}><span class="flow-dot" aria-hidden="true"></span><span class="tree-name">${esc(w.name)}</span></div>${renameBtnHtml('flow', w.category, w.id, w.name)}<button type="button" class="rowmore" data-act="row-menu" data-cat="${esc(w.category)}" data-id="${esc(w.id)}" data-name="${esc(w.name)}" title="更多" aria-haspopup="menu" aria-label="「${esc(w.name)}」更多動作"><i class="ph ph-dots-three"></i></button></div>`;
    }).join('') || '<span class="tree-empty">尚無 Workflow</span>';
    return `
    <details class="cat" data-cat="${esc(cat)}" ${open ? 'open' : ''}><summary class="nm ${now ? 'now' : ''}" ${now ? 'aria-current="page"' : ''} data-act="open-category" data-cat="${esc(cat)}" title="分類守則"><span class="dept-row${now ? ' active' : ''}"><i class="ph ph-caret-down catcaret" data-act="cat-toggle" data-cat="${esc(cat)}" tabindex="0" role="button" aria-expanded="${open}" aria-label="${open ? '收起' : '展開'}「${esc(catLabel(cat))}」" title="${open ? '收起' : '展開'}"></i><span class="dept-mark" aria-hidden="true"></span><span class="tree-name">${esc(catLabel(cat))}</span><span class="dept-count" title="${wfs.length} 條 Workflow">${wfs.length}</span>${cat === '未分類' ? '' : renameBtnHtml('category', cat, '', cat)}</span></summary>
      <div class="flow-branches">${rows}</div>
    </details>`;
  }).join('');
  const entry = (on, act, icon, label, title = '') => `<div class="wf calentry ${on ? 'now' : ''}" data-act="${act}" tabindex="0" role="button"${on ? ' aria-current="page"' : ''}${title ? ` title="${title}"` : ''}>
      <i class="${on ? 'ph-fill' : 'ph'} ${icon}"></i><span class="wfname">${label}</span>`;
  // 「新增部門」「匯入」「垃圾桶」三列退場（驗收第 2 條：新增部門→組織頁 L7；匯入與垃圾桶→Workflow 庫 L5）；組織切換位 .org-switch 只在組織 >1 時輸出，恆 1 不印
  return `<aside class="side">
    <div class="brand">剝繭<span>MAKE WORK CLEAR</span></div>
    <nav class="nav" aria-label="主要導覽">
    ${entry(state.dash, 'open-dash', 'ph-gauge', '儀表板')}
      ${state.notices.unread.length ? '<span class="reddot" title="有新通知"></span>' : ''}</div>
    ${entry(state.library, 'open-library', 'ph-books', 'Workflow 庫', '全部 Workflow 的卡片格，可搜尋、按分類看')}</div>
    ${entry(state.calendar, 'open-calendar', 'ph-calendar-blank', '行事曆')}</div>
    ${entry(state.settings, 'open-settings', 'ph-gear', '設定', '預設值、記憶、連線、備份都在這')}</div>
    </nav>
    <div class="newflow" data-act="new-flow" tabindex="0" role="button">＋ 建立新 Workflow</div>
    ${draftRow}
    <div class="rule"></div>
    <div class="tree"><div class="caption">工作空間</div>${companyNodeHtml()}${orgSwitchHtml()}<div class="company-children">${catHtml}</div>
    <div class="asset-entry${state.assets ? ' active' : ''}" data-act="open-assets" tabindex="0" role="button"${state.assets ? ' aria-current="page"' : ''}><i class="ph ph-files"></i>共用素材</div></div>
    ${state.claude === true ? '<div class="sidefoot" data-claude="ok"><span class="claudedot"></span>Claude 已連上</div>'
    : state.claude === false ? '<div class="sidefoot" data-claude="down"><span class="claudedot"></span>Claude 連不上<button type="button" class="linkbtn" data-act="reconnect">重新連線</button></div>' : ''}
  </aside>`;
}

// ---------- Workflow 列「⋯」選單（共用元件，L5 Workflow 庫卡片、L8 標題旁同用）——掛 render 浮窗串尾；
// 狀態全在 state.rowMenu {cat, id, name, x, y, sub}，輪詢重繪讀回；Esc、點選單外面關 ----------
function rowMenuHtml() {
  const m = state.rowMenu;
  if (!m) return '';
  const others = state.categories.filter((c) => c !== m.cat);
  const sub = !m.sub ? '' : `<div class="rowmenu-sub" role="group" aria-label="移至哪個分類">${others.map((c) => `<button type="button" role="menuitem" data-act="row-move" data-to="${esc(c)}">${esc(catLabel(c))}</button>`).join('') || '<span class="note">沒有別的分類</span>'}</div>`;
  return `<div class="rowmenu" role="menu" aria-label="「${esc(m.name)}」更多動作" style="left:${m.x}px;top:${m.y}px">
    <button type="button" role="menuitem" data-act="row-move-open" aria-expanded="${!!m.sub}"><i class="ph ph-folder-simple"></i>移至分類<i class="ph ph-caret-${m.sub ? 'down' : 'right'} rowmenu-caret"></i></button>${sub}
    <button type="button" role="menuitem" data-act="row-copy"><i class="ph ph-copy"></i>複製</button>
    <button type="button" role="menuitem" data-act="row-export"><i class="ph ph-export"></i>匯出</button>
    <button type="button" role="menuitem" class="danger" data-act="del-wf-row" data-cat="${esc(m.cat)}" data-id="${esc(m.id)}" data-name="${esc(m.name)}"><i class="ph ph-trash"></i>移到垃圾桶</button>
  </div>`;
}
// 選單位置：預設開在「⋯」右邊 6px；右邊放不下（Workflow 庫靠右的卡片）改開在左邊；靠底往上收
function rowMenuPos(r, vw, vh) {
  const w = 190; // 選單約寬（min-width 176＋框與子清單縮排）
  const x = r.right + 6 + w <= vw ? r.right + 6 : Math.max(8, r.left - 6 - w);
  return { x: Math.round(x), y: Math.round(Math.max(8, Math.min(r.top, vh - 190))) };
}
// 複製（上桌a）：讀定義另存一份，名字加「（副本）」，同部門；不帶執行紀錄與版本（新 id 由後端配）
async function copyWorkflow(cat, id) {
  const def = await api('GET', wfPath({ category: cat, id })); // 剛讀回的新物件，直接改名送出
  def.name = `${def.name}（副本）`;
  await api('POST', '/api/workflows', { category: cat, def });
  await refreshLibrary();
}
// 移至部門：既有搬移 API；正在看的那條（state.wf／執行頁 state.run）跟著換部門，暫存包換鍵（同部門改名的同步）
async function moveWorkflowTo(cat, id, to) {
  await api('POST', `${wfPath({ category: cat, id })}/move`, { to });
  if (state.wf?.category === cat && state.wf.id === id) state.wf.category = to;
  if (state.run?.workflow?.category === cat && state.run.workflow.id === id) state.run.workflow.category = to;
  const pkg = wsByFlow.get(`${cat}/${id}`);
  if (pkg) { wsByFlow.delete(`${cat}/${id}`); wsByFlow.set(`${to}/${id}`, pkg); }
  await refreshLibrary();
}

// ---------- 移植第一批 T9：流程庫頁（側欄第二個全域項）——全部流程的卡片格＋搜尋＋分類過濾；只讀 state.workflows，不叫 API ----------
function closeLibrary() {
  if (!state.library) return;
  state.library = null;
}
function openLibrary() {
  clearTimeout(state.pollTimer);
  closeCalendar();
  closeDash();
  closeCategory();
  closeSettings();
  closeAssets();
  stashWorkspace(); // 離開工作區先打包（畫布未存改動也帶著，不再問「丟掉？」）
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
  if (!list.length) return `<div class="none library-empty" data-lib-empty>${q || l.cat ? '沒有符合的 Workflow' : '還沒有 Workflow：按右上「＋ 建立新 Workflow」或「匯入」'}</div>`;
  return flowCardsHtml(list);
}
// 流程卡（ 抽出； 照樣稿 uxFlowCards）：Workflow 庫與部門頁共用；「打開」走既有 open，「⋯」共用 rowMenuHtml
// 步數＝GET /api/workflows 的 steps／human_steps（壞檔 null、舊回應沒有欄位＝讀不到；W7：定義檔沒有描述，這行取代描述）
function flowCardsHtml(list) {
  return list.map((w) => `<article class="flowcard" data-lib-card="${esc(w.id)}"><span class="caption">${esc(catLabel(w.category))}</span><h2>${esc(w.name)}</h2>
      <div class="row"><span class="flowmeta">${w.steps == null ? '步數讀不到' : `${w.steps} 步驟・${w.human_steps ?? 0} 步你來`}</span>
        <button class="btn sm2" data-act="open" data-cat="${esc(w.category)}" data-id="${esc(w.id)}">打開</button>
        <button class="btn sm2 more" data-act="row-menu" data-cat="${esc(w.category)}" data-id="${esc(w.id)}" data-name="${esc(w.name)}" aria-haspopup="menu" aria-label="「${esc(w.name)}」更多動作"><i class="ph ph-dots-three"></i></button></div></article>`).join('');
}
function libraryHtml() {
  const l = state.library;
  const actions = '<button class="btn" data-act="pick-import"><i class="ph ph-upload-simple"></i>匯入</button><button class="btn btn-primary" data-act="new-flow">＋ 建立新 Workflow</button>';
  const opts = [['', '全部'], ...state.categories.map((c) => [c, catLabel(c)])].map(([v, t]) => `<option value="${esc(v)}" ${(l.cat ?? '') === v ? 'selected' : ''}>${esc(t)}</option>`).join('');
  return `<div class="libpage" data-library>${pageHeadHtml('Workflow 庫', '把重複的工作整理成可以再次執行的 Workflow。', actions)}
    <div class="libtools"><input id="lib-search" placeholder="搜尋 Workflow 名稱" aria-label="搜尋 Workflow" value="${esc(l.q ?? '')}"><select id="lib-dept" aria-label="篩選分類">${opts}</select><button class="btn" data-act="view-trash"><i class="ph ph-trash"></i>垃圾桶（${state.trash.length}）</button></div>
    <div class="libgrid" id="lib-grid">${libraryCardsHtml()}</div></div>`;
}

// ---------- 麵包屑（公司 › 分類 › 流程名［› extra］）——流程頁與執行頁標題上方；頂欄品牌塊不動（契約 §三） ----------
// 草稿（含還沒拆出草稿的「開始一件事」）只印「公司 › 草稿」。末節 aria-current 不可點，前面每節都是 data-act 可點
function crumbsHtml(extra) {
  const items = [{ label: companyName(), act: 'open-company' }];
  const wf = state.wf ?? (state.run?.workflow ? { ...state.run.workflow, def: state.run.def } : null);
  if (state.chat?.draft || !wf) items.push({ label: '草稿' });
  else items.push({ label: catLabel(wf.category), act: 'open-category', cat: wf.category }, { label: wf.def?.name ?? '' });
  if (extra) items.push({ label: extra });
  const last = items.length - 1;
  return `<nav class="crumbs" aria-label="資料夾路徑">${items.map((x, i) => `${i ? '<i class="ph ph-caret-right"></i>' : ''}${i === last
    ? `<span aria-current="page">${esc(x.label)}</span>`
    : `<span data-act="${x.act}"${x.cat ? ` data-cat="${esc(x.cat)}"` : ''}>${esc(x.label)}</span>`}`).join('')}</nav>`;
}

// ---------- 工作區標題區（樣稿 uxFlowHead／uxDesignTabs）：麵包屑 → 標題列 → 步數一行 → 底線分頁 → 工具列 ----------
function modeSeg() {
  const m = state.mode;
  const b = (k, t) => `<span class="${m === k ? 'on' : ''}" data-act="mode-${k}" tabindex="0" role="button">${t}</span>`;
  return `<div class="seg">${b('chat', '聊天')}${b('list', '清單')}${b('canvas', '畫布')}${b('history', '履歷')}</div>`;
}

function workHeadHtml() {
  const def = subjectDef();
  // （樣稿 uxChatPage newFlow）：還沒拆出草稿＝建立新 Workflow 頁——麵包屑回 Workflow 庫＋頁標題；沒東西可看，不印四模式
  if (!def) return `<nav class="crumbs" aria-label="資料夾路徑"><span data-act="open-library" tabindex="0" role="button">Workflow 庫</span><i class="ph ph-caret-right"></i><span aria-current="page">建立新 Workflow</span></nav>${pageHeadHtml('把工作說清楚', '先確認成品長相，再拆成可以逐步驗收的 Workflow。', '<button class="btn" data-act="open-library">回 Workflow 庫</button>')}`;
  const title = def.name;
  const saved = !subjectIsDraft() && !!state.wf;
  // 版本標籤（驗收第 4 條）：標題旁、點了開履歷；有未存改動時「未儲存」取代版本號（ 的暫存包會帶著它跨 Workflow）
  const verTag = subjectIsDraft() ? '<span class="chip wait"><i class="ph ph-pencil-simple-line"></i>草稿・還沒存</span>'
    : !saved ? ''
      : state.cvDirty ? '<span class="chip wait vertag" data-act="mode-history" tabindex="0" role="button" title="有改動還沒存檔；點了看版本履歷"><i class="ph ph-pencil-simple-line"></i>未儲存</span>'
        : state.versions.length ? `<span class="chip vertag" data-act="mode-history" tabindex="0" role="button" title="點了看版本履歷"><i class="ph-fill ph-seal-check"></i>v${state.versions.at(-1).version}・現行</span>` : '';
  // 已存流程標題旁「修改名稱」（改名走存新版本，履歷多一版）；草稿沒有（名字在草稿裡改）
  const renameBtn = saved ? `<span class="btn sm2 btn-ghost" data-act="rename-open" data-type="flow" data-cat="${esc(state.wf.category)}" data-id="${esc(state.wf.id)}" tabindex="0" role="button" title="修改名稱"><i class="ph ph-pencil-simple"></i>修改名稱</span>` : '';
  // 驗收第 5 條：保留「Workflow 設定」，旁邊「⋯」（移至部門／複製／匯出／移到垃圾桶，共用 rowMenuHtml）；部門歸屬由麵包屑交代
  const actions = saved ? `<div class="actions"><button class="btn flowsetbtn" data-act="flow-settings" title="Workflow 設定：產出檔案、交貨查核、監工"><i class="ph ph-sliders-horizontal"></i>Workflow 設定</button><button class="btn iconb more" data-act="row-menu" data-cat="${esc(state.wf.category)}" data-id="${esc(state.wf.id)}" data-name="${esc(def.name)}" aria-haspopup="menu" aria-label="「${esc(def.name)}」更多動作"><i class="ph ph-dots-three"></i></button></div>` : '';
  const tasks = (def?.nodes ?? []).filter((n) => kindOf(n) === 'task');
  const sub = def ? `<p class="sub flowsub">${tasks.length} 個步驟・${tasks.filter((n) => n.stop_point === 'always').length} 個停點</p>` : '';
  const onData = saved && state.flowTab === 'data';
  const tab = (k, t) => `<span class="${(k === 'data') === onData ? 'on' : ''}" data-act="flow-tab" data-tab="${k}" tabindex="0" role="button">${t}</span>`;
  const flowTabs = saved ? `<div class="flowtabs" data-flowtabs>${tab('design', '設計 Workflow')}${tab('data', '本次資料')}</div>` : '';
  const tools = saved ? `<div class="actions"><span class="saved">${state.cvDirty ? '有改動未存檔' : '所有變更已儲存'}</span><button class="btn" data-act="cv-save"${state.cvDirty ? '' : ' disabled'}>存檔</button><button class="btn btn-primary" data-act="flow-tab" data-tab="data">準備執行</button></div>` : '';
  return `${crumbsHtml()}<div class="heading"><div class="titlerow"><h1>${esc(title)}</h1>${renameBtn}${verTag}</div>${actions}</div>${sub}
    ${flowTabs}${onData ? '' : `<div class="flowtool">${modeSeg()}${tools}</div>`}`;
}

// 產檔權限列：已存流程才有，草稿不顯示；開關即 PUT 定義（permissions.files）。健檢「修這裡」會捲到這列並亮 1.5 秒
function permRowHtml() {
  if (subjectIsDraft() || !state.wf) return '';
  const on = state.wf.def.permissions?.files === true;
  const flash = state.permFlashUntil > Date.now();
  return `<div class="permrow ${on ? 'on' : ''} ${flash ? 'flash' : ''}" id="perm-files">
    <label class="switch" title="${on ? '點一下關掉' : '點一下打開'}"><input type="checkbox" data-act="perm-files-toggle" ${on ? 'checked' : ''} aria-label="允許這條 Workflow 產出檔案"><span class="knob"></span></label>
    <span class="permtxt"><b>允許這條 Workflow 產出檔案</b>
      <span class="permnote">開了會讓 AI 工人在這趟的產出資料夾裡寫檔與執行程式；匯入別人的 Workflow 預設關。</span>
      ${state.permErr ? `<span class="permerr"><i class="ph-fill ph-warning"></i>${esc(state.permErr)}</span>` : ''}</span>
  </div>`;
}

// 交貨查核開關：已存流程才有，草稿不顯示；缺省＝開。切換即 PUT 定義（def.check.enabled）
// 加兩個：查核列右邊的子開關「數字對原始資料」（def.check.facts）、下一列的監工總開關（def.supervisor.enabled）
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
  return `<div class="pvback memmodal flowsettings" data-act="flow-settings-close"><div class="modal" role="dialog" aria-label="Workflow 設定">
    <div class="cvdhead" style="margin-bottom:var(--s2)"><span class="overline">Workflow 設定・${esc(state.wf.def.name)}${hint('只管這條 Workflow；點了就存。新 Workflow 的預設在「設定」。')}</span>
      <button class="btn btn-ghost iconb" data-act="flow-settings-close" style="margin-left:auto" title="關閉（Esc）"><i class="ph ph-x"></i></button></div>
    ${permRowHtml()}${checkRowHtml()}
  </div></div>`;
}
// ---------- 「本次資料」分頁（核可的任務卡版，原型 PROTO/設定與本次資料-任務卡-demo.html）----------
// 主欄＝四張準備工作卡（繼續上次執行／填寫這次的值／查看這次會帶入／確認執行選項），點一張在主欄內嵌展開（.focus-editor）；
// 右欄＝「開始這次執行」摘要卡（必填 x/y、開跑健檢、交貨查核、進度條、開始）。常駐開跑健檢卡留在主欄最後，「修這裡」照舊。
const openRunsNow = () => (state.wf?.runs ?? []).filter((r) => r.status === 'paused' || r.status === 'running');
// 必填進度：上傳欄位算「上傳好的檔名」——跟健檢看的是同一份值（healthValues）；
// 「填好了沒」也照健檢 R7 param-unfilled 的判法（必填欄位還停在預設值＝還沒填），卡上的數字才不會跟健檢卡打架
function requiredNow(def) {
  const vals = healthValues(def);
  const req = (def.params ?? []).filter((p) => p.required);
  const filled = (p) => {
    const v = String(vals[p.key] ?? '').trim();
    return !!v && (p.input === 'file' || v !== String(p.default ?? '').trim());
  };
  return { total: req.length, done: req.filter(filled).length };
}
// 這次會帶入的份數（兩層規範＋Workflow 參考檔）；規範還沒讀到＝null
function bringCount() {
  const sh = state.shared ?? {};
  if (!sh.company && !sh.dept) return null;
  return (sh.company?.rules?.length ?? 0) + (sh.dept?.rules?.length ?? 0) + (state.wfFiles ?? []).length;
}
// 兩層規範與參考檔的真數字（原右欄「這次會帶入」原樣，搬進任務卡展開區）
function bringInHtml() {
  const sh = state.shared ?? {};
  const n = (layer) => (sh[layer] ? `${sh[layer].rules?.length ?? 0} 份` : sh.err ? '讀不到' : '讀取中⋯');
  return `<div class="bringrow">組織規範 ${n('company')}</div><div class="bringrow">分類規範 ${n('dept')}</div><div class="bringrow">Workflow 參考檔 ${(state.wfFiles ?? []).length} 份</div>
`;
}
function dataCardsHtml(def, open) {
  const card = (id, cls, mark, title, status, btn) => `<article class="prep-card ${cls}" data-prep="${id}"><span class="mark">${mark}</span>
    <div><b>${title}</b><p>${status}</p></div>
    ${btn ?? `<button class="btn" data-act="data-card" data-card="${id}" aria-expanded="${open === id}">${open === id ? '收起' : '查看'}</button>`}</article>`;
  const runs = openRunsNow();
  const { total, done } = requiredNow(def);
  const bring = bringCount();
  const on = (b) => (b ? '開啟' : '關閉');
  return `<div class="prep-list">
    ${card('resume', runs.length ? 'warn' : 'done', runs.length ? String(runs.length) : '✓', '繼續上次執行',
    runs.length ? `有 ${runs.length} 趟跑到一半，接回去就從停的地方繼續。` : '沒有跑到一半的；這次是全新一趟。', runs.length ? null : '')}
    ${card('data', done < total ? 'warn' : 'done', done < total ? String(total - done) : '✓', '填寫這次的值',
    total === 0 ? '這份 Workflow 沒有必填資料。' : done < total ? `還差 ${total - done} 項必填資料。` : `${total} 項必填資料已完成。`)}
    ${card('auto', 'done', '✓', '查看這次會帶入', bring === null ? '規範讀取中⋯' : `${bring} 份規範與參考資料。`)}
    ${card('execution', 'done', '✓', '確認執行選項', `產出檔案 ${on(def.permissions?.files === true)}・交貨查核 ${on(def.check?.enabled !== false)}・監工 ${on(def.supervisor?.enabled !== false)}`)}
  </div>`;
}
// 展開區：一次只開一張（state.dataCard，沒動過＝填值那張）
function dataDetailHtml(def, open) {
  const box = (title, sub, body, chip = '') => `<section class="focus-editor" data-focus="${open}"><header><div><h3>${title}${hint(sub)}</h3></div>${chip}</header>${body}</section>`;  // 四個分頁的說明收進標題旁
  if (open === 'resume') return box('繼續上次執行', '接回去就從停的地方繼續；這一趟不用跑完的整筆刪掉。', resumeHtml() || '<p class="note">目前沒有跑到一半的執行。</p>');
  if (open === 'data') {
    const { total, done } = requiredNow(def);
    return box('填寫這次的值', `只調整這一趟要使用的值；欄位本身要改，回「設計 Workflow」。${habitsNoteText() ? `\n\n${habitsNoteText()}` : ''}`,
      `${identityRowHtml()}${paramRowsHtml(def) || '<p class="note">這份 Workflow 沒有可調欄位。</p>'}
    ${habitsNoteHtml()}
    <label class="label" for="run-note">本次補充${hint('這一趟每個 AI 步驟都看得到這段話。')}</label><textarea id="run-note" class="runnote" data-keep maxlength="2000" placeholder="例如：這次特別留意新品類的表現（選填）">${esc(state.runNote ?? '')}</textarea>
    ${runAttachBoxHtml()}`,
      total ? `<span class="chip${done < total ? ' wait' : ''}">${done} / ${total} 必填</span>` : '');
  }
  if (open === 'auto') return box('查看這次會帶入', '系統加入的背景資料，不含你填的欄位。開始時會鎖定這次的值與 Workflow 版本，跑到一半改設計不影響這一趟。', bringInHtml());
  // 驗收第 3 條：三個開關在這裡仍然可改、即點即存（原型畫成唯讀，照抄就是把能力做丟）
  if (open === 'execution') return box('確認執行選項', '這些設定屬於整條 Workflow，不是本次覆寫；點了就存。', `${permRowHtml()}${checkRowHtml()}`);
  return '';
}
function dataTabHtml() {
  const def = subjectDef();
  if (!def || subjectIsDraft()) return '';
  const open = state.dataCard === undefined ? 'data' : state.dataCard;
  return `<section class="dataform">${startCheckHtml()}
    ${dataCardsHtml(def, open)}
    ${dataDetailHtml(def, open)}
    ${healthCardHtml()}
  </section>`;
}
// 右欄＝「開始這次執行」摘要卡（原型 .sticky-start）：必填 x/y、開跑健檢、交貨查核、進度條、Claude 連不上紅卡、開始
function startCardHtml() {
  const def = subjectDef();
  if (!def) return '';
  const { total, done } = requiredNow(def);
  const partial = done < total;
  const h = state.health;
  const issues = h?.result?.issues ?? null;
  const blocks = issues ? issues.filter((i) => i.level === 'block').length : 0;
  const warns = issues ? issues.length - blocks : 0;
  const hl = h?.err ? '讀不到' : !issues ? '檢查中⋯' : blocks ? `${blocks} 處要修` : warns ? `${warns} 則提醒` : '通過';
  // 驗收第 1 條：Claude 連不上且影響執行時，「開始」附近明確提示（樣式同聊天送出旁那張 .claudecard）
  const down = state.claude === false ? '<div class="claudecard runclaude" data-claude-card><i class="ph-fill ph-warning-circle"></i><span>Claude 連不上，現在按開始會失敗。</span><button type="button" class="btn sm2" data-act="reconnect">重新連線</button></div>' : '';
  return `<section class="panel sticky-start" data-startcard><h3>開始這次執行</h3>
    <div class="summary-line"><span>必填資料</span><strong>${done} / ${total}</strong></div>
    <div class="summary-line"><span>開跑健檢</span><strong>${hl}</strong></div>
    <div class="summary-line"><span>交貨查核</span><strong>${def.check?.enabled !== false ? '開啟' : '關閉'}</strong></div>
    <div class="meter${partial || blocks ? ' partial' : ''}"><i style="width:${total ? Math.round((done / total) * 100) : 100}%"></i></div>
    ${down}
    <button class="btn btn-primary" data-act="start" ${state.claude === false ? 'disabled title="先把 Claude 連上"' : ''}><i class="ph-fill ph-play"></i>開始</button>
    <div class="startfoot"><span class="note">只用於本次</span><button class="btn btn-ghost sm2" data-act="pf-recheck">重新檢查</button><button class="btn btn-ghost sm2" data-act="flow-tab" data-tab="design">回設計</button></div>
  </section>`;
}
function dataAsideHtml() {
  return `<aside class="right dataside">${startCardHtml()}</aside>`;
}
// 排版輪 L11（題 2 A）：上傳框（樣稿 .ux-upload）——選檔／上傳中／檔名＋大小＋移除／錯誤一句；檔只在暫存區，開跑才跟著這一趟存
// 大跑輪：hint＝還沒選檔時那句（本次附件用自己的句子，欄位上傳框逐字照舊）
function uploadBoxHtml(p, hint = '每次開跑上傳一個檔，只給這一趟用。') {
  const u = state.runUploads?.[p.key] ?? null;
  const chip = p.required ? ' <span class="chip wait req" title="開跑前健檢：沒上傳不給跑">必填</span>' : '';
  const kb = (n) => `${Math.max(1, Math.ceil((n ?? 0) / 1024))} KB`;
  const body = u?.token ? `<strong>${esc(u.name)}</strong><p class="note">${kb(u.size)}・只給這一趟用，下次不留。</p>`
    : u?.busy ? `<strong>${esc(u.name)}</strong><p class="note">上傳中⋯</p>`
      : `<strong>尚未選擇檔案</strong><p class="note${u?.err ? ' bad' : ''}">${u?.err ? esc(u.err) : hint}</p>`;
  const btn = u?.token ? `<button class="btn" data-act="run-upload-del" data-key="${esc(p.key)}">移除</button>`
    : `<button class="btn" data-act="run-upload" data-key="${esc(p.key)}" ${u?.busy ? 'disabled' : ''}>選檔</button>`;
  return `<label class="label">${esc(p.label)}${chip}</label><div class="upload" data-upload-box="${esc(p.key)}"><div>${body}</div>${btn}</div>`;
}
async function uploadRunFile(key, file) {
  const wf = state.wf;
  state.runUploads[key] = { busy: true, name: file.name };
  render();
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const up = await api('POST', `${wfPath(wf)}/run-uploads`, { name: file.name, content_b64: btoa(bin) });
    state.runUploads[key] = { token: up.token, name: up.name, size: up.size };
  } catch (err) {
    state.runUploads[key] = { err: err.message };
  }
  render();
  recheckHealth();
}
const RUN_UPLOAD_ACCEPT = '.docx,.xlsx,.pdf,.md,.txt,.csv,.json,.html'; // 同參考檔選檔框（index.html #ref-file）；後端 RUN_UPLOAD_EXTS 再擋一次
// 本次附件＝檔案版的本次補充，不綁欄位（保留鍵同伺服器 RUN_ATTACH_KEY）；走同一個上傳框與同一條 run-uploads 通道
const RUN_ATTACH_KEY = '__run__';
const runAttachBoxHtml = () => uploadBoxHtml({ key: RUN_ATTACH_KEY, label: '本次附件' }, '這一趟每個 AI 步驟都看得到這個檔；只給這一趟用，下次不留。');
// 開始時多帶的兩欄：上傳好的 token、本次補充；都沒有＝不帶（body 與現況逐字相同）
function runStartExtras() {
  const uploads = Object.fromEntries(Object.entries(state.runUploads ?? {}).filter(([, u]) => u?.token).map(([k, u]) => [k, u.token]));
  const note = String(state.runNote ?? '').trim();
  return { ...(Object.keys(uploads).length ? { uploads } : {}), ...(note ? { note } : {}) };
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
  return `<div class="pvback memmodal flowmemmodal" data-act="flowmem-close"><div class="modal" role="dialog" aria-label="這條 Workflow 會帶的記憶">
    <div class="cvdhead" style="margin-bottom:var(--s2)"><span class="overline">這條 Workflow 會帶的記憶・${esc(state.wf.def.name)}</span>
      <button class="btn btn-ghost iconb" data-act="flowmem-close" style="margin-left:auto" title="關閉（Esc）"><i class="ph ph-x"></i></button></div>
    ${flowMemHtml() || '<div class="none">還沒有</div>'}
  </div></div>`;
}

// ---------- 流程頁右側「流程資料夾」（demo workflowFolderAside）——父層兩鈕→目前流程→流程參考檔→每次執行→上層共用檔一行 ----------
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
// 一趟執行一列（右欄「Workflow 資料」與履歷「執行紀錄」共用， 從 flowAsideHtml 抽出）
function folderRunHtml(wf, r) {
  const finalFiles = [...new Set(r.finals.map((f) => f.file).filter(Boolean))];
  const others = r.files.filter((n) => !finalFiles.includes(n)).length;
  const bad = r.status === 'unreadable';
  return `<div class="folderrun" data-run="${esc(r.run_id)}"><div class="frhead"><span class="rtime">${esc(bad ? r.run_id : fmtWhen(r.started_at))}</span>${runStatusChip(r)}
      ${bad ? '' : `<button class="btn sm2" data-act="todo-go" data-cat="${esc(wf.category)}" data-id="${esc(wf.id)}" data-rid="${esc(r.run_id)}">打開</button>`}</div>
    ${bad ? `<p class="note">${esc(r.error ?? '')}</p>` : ''}
    ${finalFiles.length || others ? `<div class="frfiles">${finalFiles.map((n) => fileChipHtml(wf.category, wf.id, r.run_id, n)).join('')}${others ? `<span class="meta">其他產出 ${others} 份</span>` : ''}</div>` : ''}
  </div>`;
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
  const runsBody = runs === null ? '<p class="note">讀不到歷次執行。</p>'
    : !runs.length ? '<p class="note">還沒開跑過。</p>'
      : `${(fo.runsAll ? runs : runs.slice(0, FOLDER_MAX)).map((r) => folderRunHtml(wf, r)).join('')}
      ${runs.length > FOLDER_MAX && !fo.runsAll ? `<span class="pbtn" data-act="runs-all"><i class="ph ph-caret-down"></i>查看全部 ${runs.length} 趟</span>` : ''}`;
  // 上層共用檔一行：兩層都讀到才算數；任一讀不到印「讀不到」
  const sh = state.shared ?? {};
  const cn = sh.company ? (sh.company.rules?.length ?? 0) + (sh.company.refs?.length ?? 0) : null;
  const dn = sh.dept ? (sh.dept.rules?.length ?? 0) + (sh.dept.refs?.length ?? 0) : null;
  const sharedLine = cn === null || dn === null ? (sh.err ? '共用檔讀不到。' : '讀取中⋯')
    : cn + dn === 0 ? '上層還沒有共用檔'
      : `組織 ${cn} 份・分類 ${dn} 份共用檔 <span data-act="shared-open"><i class="ph ph-arrow-up-right"></i>查看</span>`;
  return `<aside class="flowaside" aria-label="Workflow 資料夾"><h5>Workflow 資料夾</h5>
    <div class="folderparents"><span class="btn sm2 btn-ghost" data-act="open-company" title="組織頁：全組織共用的規範與參考"><i class="ph ph-buildings"></i>${esc(companyName())}</span><i class="ph ph-caret-right"></i><span class="btn sm2 btn-ghost" data-act="open-category" data-cat="${esc(wf.category)}" title="分類頁：這個分類共用的守則、規範與參考"><i class="ph ph-folder"></i>${esc(catLabel(wf.category))}</span></div>
    <div class="foldernow" data-folder-now><i class="ph ph-folder-open"></i><span class="wfname" title="${esc(wf.def.name)}">${esc(wf.def.name)}</span></div>
    ${fold('refs', 'Workflow 參考檔', 'ph-files', files.length, refsBody)}
    ${fold('runs', '每次執行', 'ph-clock-counter-clockwise', runs ? runs.length : '', runsBody)}
    <p class="sharedline">${sharedLine}</p>
  </aside>`;
}
// ---------- 右欄步驟檢視器（五題第 1 題 A；樣稿 inspector）——步驟｜Workflow 資料兩分頁 ----------
// 步驟＝state.canvasSel 那一步（清單「查看」、畫布點卡都寫它）；Workflow 資料＝原資料夾（flowAsideHtml）＋每步會帶入一行。草稿只有步驟頁
function inspectorHtml() {
  const def = cvDef();
  if (!def || state.run) return '';
  const saved = !subjectIsDraft() && !!state.wf;
  const tab = saved && state.inspectorTab === 'data' ? 'data' : 'step';
  const t = (k, label) => `<span class="${tab === k ? 'on' : ''}" data-act="inspector-tab" data-tab="${k}" tabindex="0" role="button">${label}</span>`;
  const seg = saved ? `<div class="seg insptabs">${t('step', '步驟')}${t('data', 'Workflow 資料')}</div>` : '';
  return `<aside class="right"><div class="panel inspector" data-inspector>${seg}${tab === 'data' ? flowAsideHtml() + flowMemLineHtml() : inspectorStepHtml(def)}</div></aside>`;
}
// 步驟序號（畫布、清單卡、檢視器、執行頁同一套：拓樸序、task 與畫面上看得到的分岔各佔一號）
// 藏在卡片出口的擇一分岔（cvAbsorbable）畫面上沒有卡，不佔號——否則畫布 STEP 01 之後直接跳 03
function stepSeqMap(def) {
  const seq = new Map();
  const preds = cvPreds(def);
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  for (const n of topoNodes(def)) {
    const k = kindOf(n);
    if (k === 'task' || (k === 'branch' && !cvAbsorbable(def, n, preds, byId))) seq.set(n.id, seq.size + 1);
  }
  return seq;
}
const seqTxt = (i) => String(i ?? 0).padStart(2, '0');
// 直接上游的步驟（跨過並行點／會合點／分岔找到 task）：清單卡「來源」與人做步驟的輸入來源用
function upstreamTasks(def, id) {
  const preds = new Map();
  for (const m of def.nodes) for (const to of [...(m.next ?? []), ...(m.branches ?? []).map((b) => b.next)]) (preds.get(to) ?? preds.set(to, []).get(to)).push(m);
  const out = [];
  const seen = new Set();
  const walk = (x) => { for (const p of preds.get(x) ?? []) { if (seen.has(p.id)) continue; seen.add(p.id); if (kindOf(p) === 'task') out.push(p); else walk(p.id); } };
  walk(id);
  return { list: out, preds };
}
function upstreamLine(def, id, seq = stepSeqMap(def)) {
  const { list } = upstreamTasks(def, id);
  return list.length ? list.map((p) => `${seqTxt(seq.get(p.id))} ${p.title}`).join('、') : '本次資料';
}
// 檢視器「輸入來源・沿路產出」：AI 步驟讀健檢 inputs（同抽屜那份，回來 patchPreflightDom 只補這塊）；人做步驟列直接上游
function inspInputsHtml(n, def) {
  let body;
  if (kindOf(n) === 'task' && n.executor === 'ai') {
    const pf = preflightFor(def);
    const items = pfInputs(pf, n.id);
    body = pf ? (items.length ? items.map((s) => `<p>${esc(inputSourceText(s))}</p>`).join('') : '<p class="err">開跑時什麼都拿不到</p>')
      : preflightCache.failed && preflightCache.key === JSON.stringify(def) ? `<p>${esc(upstreamLine(def, n.id))}</p>` : '<p class="note">檢查中⋯</p>';
  } else body = `<p>${esc(upstreamLine(def, n.id))}</p>`;
  return `<div data-insp-inputs>${body}</div>`;
}
function inspectorStepHtml(def) {
  const n = def.nodes.find((x) => x.id === state.canvasSel);
  if (!n) return '<p class="note inspempty">點一張步驟卡看細節</p>';
  const lb = (s) => `<span class="label">${s}</span>`;
  const head = `<span class="caption">STEP ${seqTxt(stepSeqMap(def).get(n.id))}</span><h3 class="insptitle">${esc(n.title)}</h3>`;
  const edit = `<button class="btn btn-primary inspedit" data-act="edit-step" data-node="${esc(n.id)}">完整編輯</button>`;
  if (kindOf(n) !== 'task') return `${head}<span class="chip quiet">舊寫法：${kindOf(n) === 'branch' ? '分岔' : kindOf(n) === 'fork' ? '並行點' : '會合點'}</span>${n.instruction ? `${lb('判斷依據')}<p>${esc(n.instruction)}</p>` : ''}${edit}`;
  const ai = n.executor === 'ai';
  const spec = ai
    ? [['類型', n.output_type], ['結構', n.output_structure], ['份量', n.output_length], ['語氣', n.output_tone], ['檔案', n.output_file && `.${n.output_file}`]].filter(([, v]) => v).map(([k, v]) => `<p>${k}：${esc(v)}</p>`).join('') || '<p class="note">沒設（照任務寫的交）</p>'
    : `<p>${n.handoff ? esc(n.handoff) : '<span class="note">沒設「完成時要交出什麼」</span>'}</p>`;
  return `${head}<div class="inspchips">${execChipHtml(n)}${n.stop_point === 'always' ? '<span class="chip wait"><i class="ph-fill ph-hand-palm"></i>停點</span>' : ''}</div>
    ${lb('任務')}<p>${n.instruction ? humanize(n.instruction, def, null, false) : '<span class="note">沒寫</span>'}</p>
    ${lb('輸入來源・沿路產出')}${inspInputsHtml(n, def)}${drawerMemoryHtml(n)}
    ${lb('交付內容')}${spec}
    ${lb('驗收重點')}<p>${n.review_focus ? esc(n.review_focus) : '<span class="note">沒設</span>'}</p>
    ${edit}`;
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
    <div class="cvdhead" style="margin-bottom:var(--s2)"><span class="overline">上層共用檔・${esc(wf.def.name)}${hint('規範每一步都帶；參考在步驟裡勾了才帶。要上傳或刪除，去組織頁／分類頁。')}</span>
      <button class="btn btn-ghost iconb" data-act="shared-close" style="margin-left:auto" title="關閉（Esc）"><i class="ph ph-x"></i></button></div>
    ${layer('company', companyName(), sh.company, `<span class="btn sm2 btn-ghost" data-act="open-company"><i class="ph ph-arrow-up-right"></i>去組織頁管理</span>`)}
    ${layer('dept', catLabel(wf.category), sh.dept, `<span class="btn sm2 btn-ghost" data-act="open-category" data-cat="${esc(wf.category)}"><i class="ph ph-arrow-up-right"></i>去分類頁管理</span>`)}
  </div></div>`;
}

// ---------- 聊天模式 ----------
// （樣稿 uxChatPage）：表單卡在上（caption＋h3＋多行框＋右下送出）→對話紀錄一則一張 .msg 卡→成品卡在最後；右欄 chatAsideHtml
function chatModeHtml() {
  const c = state.chat;
  const saved = !!state.wf && !subjectIsDraft();
  const fresh = !subjectDef(); // 還沒拆出草稿＝建立新 Workflow
  const msgs = c.messages.map((m, i) => {
    if (m.role === 'memnotice') return memNoticeLine(m.notice, { where: 'chat', idx: i }); // （M2）：訊息下的一行「記下來了…不要記」
    const [cls, who] = m.role === 'user' ? ['me', '<span class="chip">你</span>'] : m.role === 'error' ? ['err', '<span class="chip bad">剝繭</span>'] : ['ai', '<span class="chip quiet">剝繭</span>'];
    return `<div class="msg ${cls}">${who}<p>${esc(m.text)}</p></div>`;
  }).join('');
  const busy = c.busy ? '<div class="msg ai"><span class="chip quiet">剝繭</span><p><span class="thinking">在想了，等我一下⋯</span></p></div>' : '';
  const intro = saved ? `這裡講的話會直接改「${esc(state.wf.def.name)}」——例如「第 2 步幫我加停點」「多加一步寄給主管」。改壞了到「履歷」退回就好。`
    : fresh ? '跟我講一件你常做的事（例如「我每週要整理競品動態寄給團隊」），我幫你拆成 Workflow；或口述你平常怎麼做，我照建。'
      : '這裡講的話會改這份草稿；滿意了按「存進 Workflow 庫」。';
  const disabled = state.claude === false || c.busy ? ' disabled' : '';
  // 驗收第 1 條：連不上且影響操作時講明白——拆解與修改都要 Claude，紅卡放送出鈕旁
  const down = state.claude === false ? '<div class="claudecard" data-claude-card><i class="ph-fill ph-warning-circle"></i><span>Claude 連不上：拆解與修改都要用到它。</span><button type="button" class="btn sm2" data-act="reconnect">重新連線</button></div>' : '';
  const savedDraftRow = subjectIsDraft() && !c.shape // 成品卡在時還沒有草稿可存
    ? `<div class="btns draftrow">
        <button class="btn btn-primary" data-act="save-draft"><i class="ph ph-tray-arrow-down"></i>存進 Workflow 庫</button>
        <button class="btn btn-ghost" data-act="clear-draft">清空</button>
        <span class="chip expander" data-act="mode-list" tabindex="0" role="button"><i class="ph ph-list-checks"></i>到清單看草稿</span></div>` : '';
  // 驗收第 12 條：新 Workflow 表單下方一行「先試一個範例」——開範例不執行（取代舊「跑跑看範例」chip）
  const sample = fresh ? '<p class="trysample"><span data-act="open" data-cat="範例" data-id="quarterly-report" tabindex="0" role="button">先試一個範例</span></p>' : '';
  return `<div class="chatpane"><div class="panel chatform">
    <span class="caption">${saved ? '調整目前 Workflow' : fresh ? '建立 Workflow' : '調整草稿'}</span>
    <h3>${fresh ? '你想完成什麼工作？' : '告訴我想改哪裡'}</h3>
    <p class="note">${intro}</p>
    <label class="label" for="chat-input">${fresh ? '工作描述' : '想改的地方'}</label>
    <textarea id="chat-input" data-keep placeholder="${saved ? '跟它講怎麼改這個 Workflow⋯' : '跟它用講的就好⋯'}（Ctrl+Enter 送出）"${disabled}>${esc(kept('chat-input') ?? '')}</textarea>
    <div class="chatacts">${down}<button class="btn btn-primary" data-act="send-chat"${disabled}>${fresh ? '確認成品' : '送出修改'}</button></div>
    ${sample}${savedDraftRow}</div>
    <div class="chatlog" id="chatlog">${msgs}${busy}${shapeCardHtml()}</div></div>`;
}
// 聊天右欄：「這次拆解會參考」逐項（真數字，原成品卡底一行搬來）＋「你保有最後決定」（樣稿原句）
function chatAsideHtml() {
  const rows = shapeRefsItems(state.chat.refs).map((t) => `<div class="refrow">${esc(t)}</div>`).join('');
  return `<aside class="right chatside"><div class="panel"><h3>這次拆解會參考</h3>${rows}</div>
    <div class="panel"><h3>你保有最後決定${hint('先填好的答案都有依據。改掉不符合的地方，再按「照這樣拆」。')}</h3></div></aside>`;
}

// 成品長相卡（樣稿 uxProductCard）：拆解器第一趟回的七格＋資料從哪來＋部門＋兩鈕。
// 七格一直是輸入框，打字即寫回 state.chat.shape（shapeInput），輪詢整頁重繪讀 state 不洗字。
function shapeCardHtml() {
  const c = state.chat;
  if (!c.shape) return '';
  const dis = c.busy ? ' disabled' : '';
  const cells = SHAPE_LABELS.map(([k, label]) => {
    const cell = c.shape[k] ?? { value: '', basis: '預設' };
    // 選了簡報，「長度」問的就不是頁數而是張數——只換提示字，不動你打的值
    const unit = k === 'length' ? `<span class="unit" id="shape-len-unit">${lenUnit(c.fileKind)}</span>` : '';
    return `<label><span class="label">${label}<span class="basis">${esc(BASIS_TXT[cell.basis] ?? cell.basis)}</span>${unit}</span><input class="shapein" id="shape-in-${k}" data-keep data-shape-input="${k}" value="${esc(cell.value)}"${cell.value ? '' : ' placeholder="（空）"'} autocomplete="off"${dis}></label>`;
  }).join('');
  const srcRows = (c.sources ?? []).map((s) => {
    const [txt, cls] = SOURCE_CHIP[s.from] ?? SOURCE_CHIP.paste;
    return `<div class="srcrow"><span class="srcname">${esc(s.name)}</span><span class="${cls}">${txt}</span>${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}</div>`;
  }).join('') || '<p class="note">（拆解器沒列——它會照你說的直接做）</p>';
  const cur = c.category ?? '未分類';
  const opt = (v, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const cats = state.categories.filter((x) => x !== '未分類').map((x) => opt(x, x)).join('') + opt('未分類', '不分類');
  return `<div class="panel shapecard" data-shapecard>
    <div class="shapehead"><h3>成品長相</h3><span class="chip wait">待你確認</span></div>
    <div class="shapegrid">${cells}</div>
    <h3>資料從哪來</h3>
    <div class="srclist">${srcRows}</div>
    <label class="label" for="shape-category">分類</label><select id="shape-category">${cats}</select>
    ${shapeMakeHtml(c, dis)}
    <div class="shapeacts">
      <button class="btn" data-act="shape-redo"${dis}><i class="ph ph-arrow-counter-clockwise"></i>重擬</button>
      <button class="btn btn-primary" data-act="shape-confirm"${dis}><i class="ph ph-check"></i>照這樣拆</button></div></div>`;
}

// （已定案三案草稿選 C）：卡從中間切開——上半「成品長相」是你要什麼，
// 下半「怎麼做出來」是系統要交代給你的三件：交出什麼檔、會照哪些規範、有沒有舊作品照著像。
// 三件都放在拆之前，因為拆完才發現格式不對＝整條流程要重拆。
const FILE_KINDS = [['md', '文字檔'], ['docx', 'Word'], ['xlsx', 'Excel'], ['pptx', '簡報']];
// 後端 store.safeFileName 的規矩，前端先講一次（同一套字面：控制字元、路徑符號、..、系統保留字）
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function badSampleName(name) {
  const n = String(name ?? '').trim();
  if (!n) return '這個檔沒有名字，換一份再選。';
  if (/[\x00-\x1f\x7f]/.test(n)) return '檔名裡有看不見的控制字元，先把檔案改名再選。';
  if (/[\\/:*?"<>|]/.test(n) || n.includes('..')) return `檔名「${n}」不能用（有路徑符號），先把檔案改名再選。`;
  if (WIN_RESERVED.test(n)) return `檔名「${n}」是系統保留字，先把檔案改名再選。`;
  return null;
}
// 簡報論張、其他論頁字分鐘——只是提示，值一律照你打的
const lenUnit = (kind) => (kind === 'pptx' ? '幾張' : '字數／頁數');
function shapeMakeHtml(c, dis) {
  const kind = c.fileKind ?? 'md';
  const chips = FILE_KINDS.map(([v, label]) =>
    `<button class="fkind${v === kind ? ' on' : ''}" data-act="shape-kind" data-kind="${v}"${dis} aria-pressed="${v === kind}">${label}</button>`).join('')
    // PDF 還沒接（要嵌中文字型，與離線化衝突；已定案延後）——出現但點不下去，比整個藏起來誠實
    + '<span class="fkind off" title="還沒好：PDF 要把中文字型嵌進檔案裡，那件事跟「完全離線」衝突，還沒決定怎麼做">PDF・還沒好</span>';
  const r = c.refs;
  const n = (v, unit) => (v === null || v === undefined ? '讀不到' : `${v} ${unit}`);
  const rules = !r ? '<p class="note">讀取中⋯</p>' : [
    ['組織規範', n(r.company, '份')], ['分類守則', n(r.dept, '份')],
    ['你的習慣（關於你）', r.paused ? '暫停中' : n(r.core, '條')],
  ].map(([k, v]) => `<div class="rrow"><span class="rnm">${k}</span><span class="rsz">${esc(v)}</span></div>`).join('');
  // class 名不能叫 .rules——聊天步驟卡的「後面每步會守」早就佔了這個名字，
  // 而且它的規則寫在後面、權重相同＝它會贏，這框會被畫成左縮 20px 的靛藍直條。
  const sample = c.sample
    ? `<div class="smpfile"><span>${esc(c.sample.name)}</span><button class="btn btn-mini" data-act="shape-sample-del"${dis}>移除</button></div>`
    : `<button class="btn btn-mini" data-act="shape-sample"${dis}><i class="ph ph-paperclip"></i>選一份舊作品</button>`;
  return `<div class="shapemake">
    <div class="shapehead"><h3>怎麼做出來</h3></div>
    <label class="label">交出什麼檔</label>
    <div class="fkinds">${chips}</div>
    <label class="label">會照這些規範${hint('這三樣會原封不動放進每一步交給 AI 的工作單，交貨查核也拿它們逐條對。要改內容：組織規範在組織頁、分類守則在分類頁、關於你在設定→個人與記憶。')}</label>
    <div class="shaperules">${rules}</div>
    <label class="label">照著像的舊作品<span class="opt">選填</span>${hint('丟一份你以前做過、樣子對的東西上來。AI 會照它的結構、章節順序與語氣做這一份，但數字一律用這次的資料，不會抄舊的。')}</label>
    ${sample}
  </div>`;
}
// 「這次拆解會參考」（純顯示；數字不進第二趟 body）。卡底一行改聊天右欄逐項。
// null＝還在讀；某段 null＝那段印「讀不到」。「工人能」照 composer 的能耐表：查網總開關關了就不印「上網查」；讀參考檔與產 Word、Excel 目前是固定能力
function shapeRefsItems(r) {
  if (!r) return ['讀取中⋯'];
  const n = (v, unit) => (v === null ? '讀不到' : `${v} ${unit}`);
  const can = [...(r.web ? ['上網查'] : []), '讀參考檔', '產 Word、Excel、簡報'].join('／');
  return [r.paused ? '關於你 暫停中' : `關於你 ${n(r.core, '條')}`, `組織規範 ${n(r.company, '份')}`, `分類規範 ${n(r.dept, '份')}`, `工人能：${can}`];
}
// 拆解器第一趟會帶什麼（同 server /api/compose 組 ctx 的四樣：關於你 selectCore、公司規範、部門規範、能耐表）。
// 已存流程（重拆）：關於你／公司／部門直接讀開流程時抓好的 state.wfMemory／state.shared；草稿沒有這兩包→自己打
// GET /api/shared/_company/files（卡上分類不是「未分類」再多打那層）與 GET /api/memory/cards?bucket=profile 照 selectCore 算
//（表達層全帶＋內容層場合對上的前 3）；查網開關兩邊都讀 GET /api/settings。換了流程就不寫回。
// 聊天右欄常駐，沒卡也抓（草稿聊天由 render 補抓；refsFor＝正在抓的那份 chat，抓的中途不重複打）
let refsFor = null;
async function refreshShapeRefs() {
  const c = state.chat;
  refsFor = c;
  const saved = !!state.wf && !subjectIsDraft();
  const cat = saved ? state.wf.category : (c.category ?? '未分類');
  const settle = (p) => p.then((value) => ({ value }), () => ({ value: null }));
  const [cfg, company, dept, cards] = await Promise.all([
    settle(api('GET', '/api/settings')),
    saved ? { value: state.shared?.company ?? null } : settle(api('GET', sharedPath('_company'))),
    saved ? { value: state.shared?.dept ?? null } : cat === '未分類' ? { value: { rules: [] } } : settle(api('GET', sharedPath(cat))),
    saved ? { value: null } : settle(api('GET', '/api/memory/cards?bucket=profile&status=active')),
  ]);
  if (refsFor === c) refsFor = null;
  if (state.chat !== c || (!saved && (c.category ?? '未分類') !== cat)) return; // 換了流程、或分類又改了（新的一趟會再寫）
  const m = state.wfMemory;
  const core = saved ? (m ? (m.core?.expression?.length ?? 0) + (m.core?.content?.length ?? 0) : null)
    : Array.isArray(cards.value) ? countCore(cards.value, cat) : null;
  c.refs = {
    core,
    company: company.value ? (company.value.rules?.length ?? 0) : null,
    dept: dept.value ? (dept.value.rules?.length ?? 0) : null,
    web: cfg.value ? cfg.value.exec?.web !== false : true,
    paused: cfg.value?.memory?.paused === true,
  };
  render();
}
// 前端版 selectCore（只算張數）：active 未過期；表達層全算、內容層只算「全部」或同分類的，最多 3 張
function countCore(cards, cat) {
  const today = new Date().toISOString().slice(0, 10);
  const live = cards.filter((k) => k && k.status === 'active' && (k.expires == null || String(k.expires) >= today));
  const content = live.filter((k) => k.layer === 'content' && (k.scope?.level === 'all' || (k.scope?.level === 'category' && k.scope.category === cat))).length;
  return live.filter((k) => k.layer === 'expression').length + Math.min(content, 3);
}
// 成品卡格子打字（取代點改收尾）：寫回 state.chat.shape；跟拆解器原樣不同＝依據改「你說的」，
// 改回原樣＝依據回拆解器給的（自我介紹／分類守則…），不假冒成使用者說的。原樣快照第一次打字時取、出新卡時 sendChat 清掉
function shapeInput(k, v) {
  const c = state.chat;
  if (!c.shape) return;
  c.shapeBase ??= Object.fromEntries(Object.entries(c.shape).map(([key, cell]) => [key, { ...cell }]));
  const base = c.shapeBase[k] ?? { value: '', basis: '預設' };
  c.shape[k] = v === base.value ? { ...base } : { value: v, basis: '你說的' };
}

// ---------- 清單模式 ----------
// 停點標示（定案方案一）：小圖標＋懸停說明；「直接往下」是預設、不標示
function stopMark(n) {
  if (n.executor === 'human') return '<span class="mkic you" title="這步你來做，完成後回報一句"><i class="ph-fill ph-user"></i></span>';
  return n.stop_point === 'always'
    ? '<span class="mkic stop" title="做完會停下來給你看"><i class="ph-fill ph-hand-palm"></i></span>'
    : '';
}

function execChipHtml(n) {
  return `<span class="chip">${n.executor === 'human' ? '<i class="ph ph-user"></i>你來' : 'AI'}</span>`;
}
// 清單大卡：序號＋名稱＋執行者／停點＋查看（只選取，右欄檢視器顯示）＋編輯；產出／來源、出口入口小 chip。
// 09-18：卡上不再印任務指示（中間那行）——卡片變細，指示看右欄檢視器；分岔卡的一行說明保留（它沒有產出／來源）。
// 出口入口先照定義檔現況判斷（多條 next／接並行點＝同時做、接分岔＝擇一、兩條以上進來＝等全部）；畫布資料模型 cvModel 是 L13
function stepListHtml(def) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const seq = stepSeqMap(def);
  // 09-18 驗收第 12 條：「查看」鈕退場——整張卡就是「選這一步」（右欄檢視器換成這一步）；卡上只留「編輯」。
  // 鍵盤可達：tabindex＋role=button（keyActivate 的 Enter／空白鍵）；data-id 讓重繪後焦點回到同一張卡。
  const btns = (n) => `<button class="btn btn-ghost sm2" data-act="edit-step" data-node="${esc(n.id)}"><i class="ph ph-pencil-simple"></i>編輯</button>`;
  const pick = (n) => ` data-step="${esc(n.id)}" data-act="step-pick" data-node="${esc(n.id)}" data-id="${esc(n.id)}" tabindex="0" role="button"`;
  const sel = (n) => (state.canvasSel === n.id ? ' sel' : '');
  const model = cvModel(def);
  return topoNodes(def).map((n) => {
    const kind = kindOf(n);
    if (kind === 'fork') return '<div class="sub" style="margin:2px 0 6px"><i class="ph ph-git-branch"></i> 以下幾步同時進行</div>';
    if (kind === 'join') return '<div class="sub" style="margin:2px 0 6px"><i class="ph ph-git-merge"></i> 會合——等上面全部完成</div>';
    if (kind === 'branch') {
      const arms = n.branches.map((b) => `<div class="meta">↳ ${esc(b.label)} → 「${esc(byId.get(b.next)?.title ?? '')}」</div>`).join('');
      return `<article class="step stopmarked${sel(n)}"${pick(n)}><div class="stephead"><span class="num">${seq.has(n.id) ? seqTxt(seq.get(n.id)) : '<i class="ph ph-arrows-split"></i>'}</span><h3>${esc(n.title)}</h3><span class="chip amber">分岔</span>${btns(n)}</div>
        ${n.instruction ? `<p>${esc(n.instruction)}</p>` : ''}${arms}</article>`;
    }
    const cls = n.executor === 'human' ? ' humanmarked' : n.stop_point === 'always' ? ' stopmarked' : '';
    const out = n.executor === 'human' ? (n.handoff || '你交出的內容') : ([n.output_type, n.output_file && `.${n.output_file} 檔`].filter(Boolean).join('・') || '文字產出');
    // 出口入口 chip 讀畫布同一份模型（cvModel）——同時做／擇一 N 條、等全部／任一條到
    const lines = model.edges.filter((e) => e.from === n.id).length;
    const marks = [
      model.exits[n.id] === 'all' ? `同時做 ${lines} 條` : model.exits[n.id] === 'one' ? `擇一 ${lines} 條` : '',
      model.entries[n.id] === 'any' ? '任一條到' : model.entries[n.id] === 'all' ? '等全部' : '',
    ].filter(Boolean).map((t) => `<span class="chip quiet">${t}</span>`).join('');
    return `<article class="step${cls}${sel(n)}"${pick(n)}><div class="stephead"><span class="num">${seqTxt(seq.get(n.id))}</span><h3>${esc(n.title)}</h3>
      ${execChipHtml(n)}${stopMark(n)}${btns(n)}</div>
      <div class="meta">產出：${esc(out)}<br>來源：${esc(upstreamLine(def, n.id, seq))}</div>${marks ? `<div class="flowmarks">${marks}</div>` : ''}</article>`;
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
  // 欄位值改多行框：單行時跟原本一樣高，貼一封信也放得下；「沒有步驟用到」chip 由健檢結果決定顯隱
  const unused = subjectIsDraft() ? [] : (preflightFor(def)?.unused_params ?? []);
  // 值列：placeholder＝該欄位的 hint（要貼什麼）；required 的標「必填」chip；值框下方＝習慣選項 chip
  const row = (p) => `
    <div class="param"><span>${esc(p.label)}${p.required ? '<span class="chip wait req" title="開跑前健檢：這欄沒填不給跑">必填</span>' : ''}<span class="chip unusedchip" data-unused="${esc(p.key)}" ${unused.includes(p.key) ? '' : 'hidden'} title="這個欄位沒有任何步驟的指示引用到——填了也沒人看">沒有步驟用到</span></span>
      <div class="val"><textarea class="autogrow" rows="1" data-param="${esc(p.key)}" placeholder="${esc(p.hint ?? '')}">${esc(state.paramNow[p.key] ?? p.default)}</textarea>${habitChipsHtml(p)}</div></div>`;
  // 必填在前、選填收進「其他資料（選填）」；每列 markup 原樣（data-param／必填 chip／習慣 chip 一個不少，地雷 8）。
  // 收摺開合＝state.folderOpen.optional（使用者點過），沒點過＝這次有填到選填欄位就開
  // 上傳欄位不是文字框——必填文字欄位之後一排上傳框（必填與選填都在這，選填不收進 details）
  const text = def.params.filter((p) => p.input !== 'file');
  const uploads = def.params.filter((p) => p.input === 'file').map(uploadBoxHtml).join('');
  const required = text.filter((p) => p.required);
  const optional = text.filter((p) => !p.required);
  if (!optional.length) return required.map(row).join('') + uploads;
  const open = state.folderOpen?.optional ?? optional.some((p) => String(state.paramNow[p.key] ?? '').trim() !== '');
  return `${required.map(row).join('')}${uploads}
    <details class="formdetails" ${open ? 'open' : ''}><summary data-act="folder-toggle" data-k="optional"><i class="ph ph-caret-down"></i>其他資料（選填）<span class="meta">${optional.length} 欄</span></summary>${optional.map(row).join('')}</details>`;
}
function listModeHtml() {
  const def = subjectDef();
  if (!def) {
    return `<div class="empty-c"><div class="ic"><i class="ph ph-list-checks"></i></div>
      <h3>還沒選 Workflow</h3><p>左邊挑一個打開，或切到「聊天」講一件你的事拆一個新的。</p>
      <button class="btn btn-primary" data-act="open" data-cat="範例" data-id="quarterly-report"><i class="ph ph-play"></i>跑跑看範例</button></div>`;
  }
  // 執行需要的資料（驗收第 8 條）：欄位名稱改了 change 即 PUT 定義（param-label）、必填勾選即 PUT（data-req）；打到一半輪詢重繪由 data-keep 放回
  const fieldRows = def.params.map((p) => `
    <div class="param fieldrow"><input id="param-label-${esc(p.key)}" class="notein" data-act="param-label" data-key="${esc(p.key)}" data-keep aria-label="欄位名稱" value="${esc(kept(`param-label-${p.key}`) ?? p.label)}">
      <label class="reqtoggle"><input type="checkbox" data-req="${esc(p.key)}" ${p.required ? 'checked' : ''}>必填</label>
      <label class="reqtoggle"><input type="checkbox" data-upload="${esc(p.key)}" ${p.input === 'file' ? 'checked' : ''}>每次上傳檔案</label></div>`).join('');
  const addParam = state.addingParam
    ? `<div class="saverow" style="justify-content:flex-start">
        <input id="new-param-label" class="notein" style="margin:0;width:120px" placeholder="欄位名稱">
        <input id="new-param-default" class="notein" style="margin:0;width:150px" placeholder="預設值（留空＝必填）">
        <button class="btn btn-primary" data-act="confirm-param">加入</button>
        <button class="btn btn-ghost" data-act="cancel-param">取消</button>
      </div>`
    : `<div class="param expander" style="justify-content:flex-start;color:var(--ink-400);font-size:12px" data-act="add-param"><i class="ph ph-plus"></i> 新增欄位</div>`;
  if (subjectIsDraft()) {
    // 存檔下拉：拆解器問過分類、草稿頂層有 category 就預選；「不分類」＝存進「未分類」（它是一般分類，先建目錄）
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
          <button class="btn btn-primary" data-act="save-draft"><i class="ph ph-tray-arrow-down"></i>存進 Workflow 庫</button>
          <button class="btn btn-ghost" data-act="clear-draft">清空</button>
        </div>`;
    // （「開關關掉」）：連跑拆出來的草稿沒讓你確認過成品卡→頂端一行灰字印拆解器自己定的長相（只印有值的格子，不可改）
    const a = state.chat.autoShape;
    const autoLine = a ? `<p class="note" data-autoshape>成品長相：${esc(SHAPE_LABELS.filter(([k]) => a[k]?.value).map(([k, l]) => `${l} ${a[k].value}`).join('・'))}（自動確認）</p>` : '';
    return `${autoLine}<div class="sub">草稿——想調哪裡切「聊天」用講的，或切「畫布」直接拉。</div>
      ${stepListHtml(def)}
      ${def.params.length ? `<div class="params"><h5>可調欄位 · 每次開跑前能微調</h5>${def.params.map((p) => `<div class="param"><span>${esc(p.label)}</span><span class="chip">${esc(p.default)}</span></div>`).join('')}</div>` : ''}
      ${saveRow}`;
  }
  // 移植第一批 T10：開跑表單搬到「本次資料」分頁（dataTabHtml）；兩格記憶收成一行＋查看。
  // 開跑提示句退場（工具列「準備執行」取代）；欄位定義收進清單底可收合卡「執行需要的資料」（開合 state.folderOpen.fields，新增中強制開）
  const open = state.addingParam || state.folderOpen?.fields;
  return `<div class="steplist">
    ${resumeHtml()}
    ${proposalsHtml()}
    ${stepListHtml(def)}
    ${flowMemLineHtml()}
    <details class="panel fieldsfold" data-fields${open ? ' open' : ''}><summary data-act="folder-toggle" data-k="fields"><i class="ph ph-caret-down"></i>執行需要的資料<span class="meta">・${def.params.length} 欄</span>${hint('欄位屬於這條 Workflow；這一次要填的值在「本次資料」。')}</summary>${fieldRows}${addParam}
      ${state.wf?.dictSimilar?.length ? `<p class="note"><i class="ph ph-info"></i> 這幾個欄位名跟詞典裡的很像：${esc(state.wf.dictSimilar.join('、'))}——已經照存，沒擋你。</p>` : ''}</details></div>`;
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
// 常用預設列：選了＝把內容複製進欄位；☆＝把目前欄位內容存成常用；－＝刪掉選中的常用
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
  return `<label class="label" for="${id}">${label}</label>
    ${presetField ? presetRowHtml(presetField, id) : ''}
    <textarea id="${id}" class="feedbackin advarea" data-keep placeholder="${esc(ph)}">${esc(kept(id) ?? val ?? '')}</textarea>`;
}

// 參考檔區：勾選＝這一步的附件；範本填空選一檔
// 三段「這條流程／部門／公司」各自勾（demo v8RefSections）。勾選鍵＝`scope:name`（同名兩層不撞，壓測 A3）；
// 流程段存字串（舊流程原樣）、上層存 {scope,name}（scope＝company｜category，同 U1b 後端）；規範類每步自動帶，不進勾選
const attKey = (a) => (typeof a === 'string' ? `flow:${a}` : `${a?.scope}:${a?.name}`);
function refFilesInner(n, checkedOverride) {
  const att = checkedOverride ?? new Set((n.attachments ?? []).map(attKey));
  const sh = state.shared ?? {};
  const box = (scope, name) => `<input type="checkbox" id="ref-${scope}-${esc(name)}" name="ref-${scope}-${esc(name)}" data-att="${esc(name)}" data-att-scope="${scope}" ${att.has(`${scope}:${name}`) ? 'checked' : ''}>`;
  // .docx／.xlsx 參考檔＝產檔範本：檔名旁標「範本」，產出規格頁「範本填空」選它就叫工人套用；刪除鈕只有流程層
  const flowRows = (state.wfFiles ?? []).map((f) => `<label class="refrow">${box('flow', f)}<span class="wfname">${esc(f)}${/\.(docx|xlsx)$/i.test(f) ? '<span class="tplchip" title="Word／Excel 範本：在「產出規格」頁選為範本，工人會照它產檔">範本</span>' : ''}</span>
    <i class="ph ph-trash wfdel2" data-act="ref-del" data-name="${esc(f)}" title="刪掉這個參考檔"></i></label>`).join('');
  const sharedRows = (scope, d) => (d ? (d.refs ?? []).map((f) => `<label class="refrow">${box(scope, f.name)}<span class="wfname" title="${esc(f.name)}">${esc(f.name)}</span></label>`).join('') || '<p class="note">尚無參考</p>'
    : `<p class="note">${sh.err ? '共用檔讀不到' : '讀取中⋯'}</p>`);
  const seg = (scope, label, body) => `<div class="refseg" data-refseg="${scope}"><div class="refseghead">${label}</div>${body}</div>`;
  return `<div class="flabel">參考檔（勾＝這一步會看）</div>
    <div class="reflist">
      ${seg('flow', '這條 Workflow', `${flowRows || '<p class="note">尚無參考</p>'}<span class="pbtn" data-act="ref-upload"><i class="ph ph-upload-simple"></i>上傳參考檔</span>`)}
      ${seg('category', '分類', sharedRows('category', sh.dept))}
      ${seg('company', '組織', sharedRows('company', sh.company))}
    </div>`;
}
// 範本填空（D21 起與參考檔分家：勾選住「任務內容」頁、範本住「產出規格」頁）
function templateInner(n, keepVal) {
  const files = state.wfFiles ?? [];
  const sel = keepVal !== undefined ? keepVal : (n.template_file ?? '');
  return `<div class="flabel">範本填空（選填）${hint('範本裡的 {{output}} 會被這步產出取代，{{參數}} 照常代入。')}</div>
    <select id="cv-template" class="moveselect wfull">
      <option value="">不用範本</option>
      ${files.map((f) => `<option value="${esc(f)}" ${sel === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}
    </select>
`;
}
function refFilesSectionHtml(n) {
  if (subjectIsDraft()) {
    return `<div class="flabel">參考檔${hint('存進 Workflow 庫後才能掛參考檔。')}</div>`;
  }
  return `<div id="ref-section">${refFilesInner(n)}</div>`;
}
function templateSectionHtml(n) {
  if (subjectIsDraft()) {
    return `<div class="flabel">範本填空${hint('存進 Workflow 庫後才能用範本填空。')}</div>`;
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
// 版面（ 起）：置中彈窗一頁到底（輸入來源→這一步會帶→名稱→你來處理／停點→任務｜驗收→交付→更多設定→刪除／取消／套用）
// 監工三個勾：監工「可以」改這一步的什麼。缺省與後端 supervisor.supervisorFlags 同一組值
const supFlags = (n) => {
  const sv = n && typeof n.supervisor === 'object' && n.supervisor && !Array.isArray(n.supervisor) ? n.supervisor : {};
  const pick = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
  return { note: pick(sv.note, true), tier: pick(sv.tier, false), tools: pick(sv.tools, false) }; // 缺省與 src/supervisor.js supervisorFlags 同步（調檔位 09-09 改關）
};
const SUP_CHK =[['cv-sup-note', 'note', '寫交接備註'], ['cv-sup-tier', 'tier', '調檔位'], ['cv-sup-tools', 'tools', '開關查網']];
function supChecksHtml(n) {
  const f = supFlags(n);
  const boxes = SUP_CHK.map(([id, key, label]) => `<label class="chk"><input type="checkbox" id="${id}" ${f[key] ? 'checked' : ''}>${label}</label>`).join('');
  return `<div class="flabel">監工可以：${hint('勾了才會動；備註永遠只是加上去，不改你的指示。')}</div>
    <div class="chkrow">${boxes}</div>`;
}

function canvasEditorHtml(n, def) {
  // （樣稿 edit(i)）：置中彈窗一頁到底——子頁退場；文字欄 data-keep，輪詢重繪讀回打到一半的字（換節點／套用／關窗由 dropStepKeep 清）
  const kind = kindOf(n);
  const kv = (id, v) => esc(kept(id) ?? v ?? '');
  const lb = (id, s) => `<label class="label" for="${id}">${s}</label>`;
  const txt = (id, ph, v) => `<input id="${id}" class="notein" data-keep placeholder="${ph}" value="${kv(id, v)}">`;
  const titleRow = `${lb('cv-title', '步驟名稱')}<input id="cv-title" class="notein" data-keep value="${kv('cv-title', n.title)}" placeholder="這一步叫什麼" autocomplete="off">`;
  const apply = '<button class="btn btn-primary" data-act="cv-apply">套用</button>';
  const foot = (left, right = apply) => `<div class="dialog-foot">${left}<button class="btn" data-act="cv-close-drawer">取消</button>${right}</div>`;
  if (kind === 'task') {
    const isAI = n.executor === 'ai';
    const head = `${isAI ? drawerInputsHtml(n, def) + drawerMemoryHtml(n) : ''}${titleRow}
      <div class="formline"><label class="chk"><input type="checkbox" id="cv-human" ${!isAI ? 'checked' : ''}>你來處理</label><label class="chk"><input type="checkbox" id="cv-stop" ${n.stop_point === 'always' ? 'checked' : ''}>完成後停點</label></div>
      <div class="cvgrid2">
        <div class="cvcol">${textFieldHtml('cv-instruction', '任務', n.instruction, '這一步要做什麼', null)}</div>
        <div class="cvcol">${lb('cv-review', '驗收重點（選填）')}<textarea id="cv-review" class="feedbackin advarea" data-keep placeholder="你檢查時要看什麼；AI 交件前也會照它自檢">${kv('cv-review', n.review_focus)}</textarea></div>
      </div>`;
    const tfoot = foot('<button class="btn btn-ghost btn-danger" data-act="cv-delete">刪除這步</button><span class="note grow">這裡是後台原文，{{欄位}} 代碼在前台會自動變成欄位值。</span>');
    // 出口擇一＝怎麼挑＋每條線的條件；兩條以上線進來＝等全部／任一條到（欄位 cv- 開頭、data-keep，換節點由 dropStepKeep 清）
    const model = cvModel({ nodes: def?.nodes ?? [] });
    const byId = new Map((def?.nodes ?? []).map((x) => [x.id, x]));
    const choose = model.exits[n.id] === 'one' ? `${lb('cv-choose', '擇一：怎麼挑')}<textarea id="cv-choose" class="feedbackin advarea" data-keep placeholder="例：看報帳金額決定走哪條">${kv('cv-choose', model.choose[n.id])}</textarea>
      ${model.edges.filter((e) => e.from === n.id && e.dashed).map((e) => `${lb(`cv-cond-${e.arm}`, `走「${esc(byId.get(e.to)?.title ?? e.to)}」這條的條件`)}<input id="cv-cond-${e.arm}" class="notein" data-keep data-cond-arm="${e.arm}" data-cond-to="${esc(e.to)}" placeholder="例：金額超過五千" value="${kv(`cv-cond-${e.arm}`, e.cond)}">`).join('')}` : '';
    const entryNow = kept('cv-merge') ?? model.entries[n.id];
    const entry = model.entries[n.id] ? `${lb('cv-merge', '幾條線接進來時')}<select id="cv-merge" class="moveselect" data-keep>
        <option value="all"${entryNow === 'any' ? '' : ' selected'}>等全部做完才開始</option>
        <option value="any"${entryNow === 'any' ? ' selected' : ''}>任一條到就開始（其他線照跑，產出不再送進這一步）</option>
      </select>` : '';
    if (!isAI) {
      return `${head}
        ${lb('cv-handoff', '完成時要交出什麼')}<input id="cv-handoff" class="notein" data-keep placeholder="例：來信全文、整理好的名單——後面的 AI 步驟靠這份內容往下做" value="${kv('cv-handoff', n.handoff)}">
        ${choose}${entry}
        ${tfoot}`;
    }
    // 「更多設定」有值就預設展開，使用者點過就照他的（state.cvMore；移植第一批 T11 規則沿用，計數多收進來的產出／執行設定）
    const moreN = ['role_context', 'background', 'constraints', 'examples', 'output_format', 'template_file', 'model_tier', 'creativity', 'retry', 'supervisor'].filter((k) => String(n[k] ?? '').trim()).length + (n.attachments?.length ? 1 : 0);
    const moreOpen = state.cvMore ?? moreN > 0;
    return `${head}
      ${lb('cv-file', '交付內容')}
      <select id="cv-file" class="moveselect">
        <option value="">產出檔案：不存檔（只顯示在畫面）</option>
        <optgroup label="直接存">
          ${['md', 'txt', 'csv', 'html', 'json'].map((x) => `<option value="${x}" ${n.output_file === x ? 'selected' : ''}>.${x}</option>`).join('')}
        </optgroup>
        <optgroup label="產真檔（需開產檔權限）">
          <option value="docx" ${n.output_file === 'docx' ? 'selected' : ''}>Word .docx</option>
          <option value="xlsx" ${n.output_file === 'xlsx' ? 'selected' : ''}>Excel .xlsx</option>
          <option value="pptx" ${n.output_file === 'pptx' ? 'selected' : ''}>簡報 .pptx</option>
        </optgroup>
        <optgroup label="還沒接（先降級存 .md）">
          <option value="pdf" ${n.output_file === 'pdf' ? 'selected' : ''}>PDF .pdf</option>
        </optgroup>
      </select>
      <div class="cvgrid2 outgrid">
        ${txt('cv-otype', '類型：表格／條列／一段文字／Email 草稿⋯', n.output_type)}
        ${txt('cv-ostructure', '結構：例 欄位=日期/標題/連結；或段落大綱', n.output_structure)}
        ${txt('cv-olength', '份量：例 500 字內、最多 10 列', n.output_length)}
        ${txt('cv-otone', '語言與語氣：例 中文、正式對外', n.output_tone)}
      </div>
      ${choose}${entry}
      <details class="cvmore" id="cv-more" ${moreOpen ? 'open' : ''}>
        <summary data-act="cv-more"><i class="ph ph-caret-down"></i>更多設定${moreN ? `<span class="chip">${moreN} 項有內容</span>` : ''}</summary>
        <div class="cvgrid2">
          <div class="cvcol">
            ${textFieldHtml('cv-role', '角色情境', n.role_context, '例：你是資深客服主管，語氣專業溫和', 'role_context')}
            ${textFieldHtml('cv-bg', '背景資料', n.background, '這一步需要知道的固定背景', 'snippet')}
          </div>
          <div class="cvcol">
            ${textFieldHtml('cv-constraints', '限制條件', n.constraints, '不可違反的規則，例：不承諾具體賠償金額', 'constraints')}
            ${textFieldHtml('cv-examples', '範例', n.examples, '貼一段理想產出的樣子，AI 會照著寫', 'snippet')}
          </div>
        </div>
        ${refFilesSectionHtml(n)}
        <div class="cvgrid2">
          <div class="cvcol">
            ${lb('cv-output-format', '格式補充')}${presetRowHtml('output_format', 'cv-output-format')}
            ${txt('cv-output-format', '規格外的特殊要求', n.output_format)}
            ${templateSectionHtml(n)}
          </div>
          <div class="cvcol">
            ${lb('cv-model', '模型檔位與創意度')}
            <div class="selrow">
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
            ${lb('cv-retry', '出錯時')}
            <select id="cv-retry" class="moveselect" title="這一步出錯時怎麼辦">
              <option value="" ${n.retry === undefined ? 'selected' : ''}>出錯：照設定裡的預設</option>
              <option value="0" ${n.retry === 0 ? 'selected' : ''}>出錯：馬上停下來問我</option>
              <option value="1" ${n.retry === 1 ? 'selected' : ''}>出錯：先自動重試 1 次</option>
              <option value="2" ${n.retry === 2 ? 'selected' : ''}>出錯：先自動重試 2 次</option>
            </select>
          </div>
        </div>
      </details>
      ${tfoot}`;
  }
  if (kind === 'branch') {
    const arms = n.branches.map((b, i) => `<input class="notein" style="margin:0 0 6px" data-branch-label="${i}" value="${esc(b.label)}">`).join('');
    return `${titleRow}
      ${lb('cv-instruction', '判斷依據（人話）')}<textarea id="cv-instruction" class="feedbackin advarea" data-keep>${kv('cv-instruction', n.instruction)}</textarea>
      <span class="label">每條路的條件</span>${arms}
      <p class="note"><span class="chip quiet">舊寫法</span> 這顆分岔接的方式新畫法表達不了（放在第一步、接在並行點後、或跟一般線混接），照樣能跑能改。要多一條路：從這顆小圓點再拉一條線出去，條件標籤釘在各自的線上。「變並行點」＝去掉條件判斷，各條路改成同時做。</p>
      ${foot('<button class="btn btn-ghost btn-danger" data-act="cv-delete">刪掉這個點</button><button class="btn btn-secondary" data-act="cv-branch-to-par">變並行點</button><span class="grow"></span>')}`;
  }
  if (kind === 'fork') {
    return `${titleRow}
      <p class="sub" style="margin:14px 0 0"><i class="ph ph-git-branch"></i> <span class="chip quiet">舊寫法</span> 並行點：從它拉出去的幾條線同時進行。現在同時做＝從步驟直接拉幾條線，不需要這顆點${cvCanConvert(def, n.id) ? '——按「轉成新寫法」把點拆掉、線直接相連（跑起來一樣）' : ''}。</p>
      ${foot(`${cvCanConvert(def, n.id) ? '<button class="btn btn-secondary" data-act="cv-convert">轉成新寫法</button>' : ''}<button class="btn btn-ghost btn-danger" data-act="cv-delete">刪掉這個點</button><span class="grow"></span>`)}`;
  }
  // 舊式 join（新流程不再產生）：說明＋一鍵拆直
  return `${titleRow}
    <p class="sub" style="margin:14px 0 0"><i class="ph ph-git-merge"></i> 這是舊式會合點——現在會合＝多條線直接接進同一步，不需要這顆點。下次任何畫布編輯它會自動拆掉，線直接相連；也可以現在就拆。</p>
    ${foot('<span class="grow"></span>', '<button class="btn btn-secondary" data-act="cv-dissolve">現在拆直</button>')}`;
}

function canvasModeHtml() {
  const def = cvDef();
  if (!def) {
    return `<div class="empty-c"><div class="ic"><i class="ph ph-tree-structure"></i></div>
      <h3>還沒有 Workflow 可以畫</h3><p>左邊挑一個 Workflow，或切到「聊天」講一件事——也可以雙擊下面空白處直接開始拉。</p>
      <button class="btn btn-primary" data-act="cv-new-blank"><i class="ph ph-plus"></i>從一個空白步驟開始拉</button></div>`;
  }
  const issues = cvIssueSet(def);
  // 「存檔」與「有改動未存檔」搬到頁面工具列（workHeadHtml），這裡不重複。
  // （款 A）：頂上工具列列、整行長說明、調色盤退場——復原／重做／縮放／全覽／「？」在畫布右上，基本提示常駐左下（驗收第 6 條）
  return `<div class="cvstage">${window.BJCanvas.html(def, state.canvasSel, issues, cvModel(def), cvCanvasOpts(def))}</div>`;
}
function cvIssueSet(def) {
  const issues = state.cvShowIssues ? new Set(canvasIssues(def)) : new Set();
  if (!issues.size) state.cvShowIssues = false;
  return issues;
}
// 畫布右上工具列＋左下一行提示＋「？」浮層（款 A 七行；state.cvHelp 切換不整頁重繪）
function cvChromeHtml() {
  const h = cvHistoryFor();
  const pct = Math.round((window.BJCanvas.view?.().z ?? 1) * 100);
  return `<div class="cvtools" role="toolbar" aria-label="畫布工具">
      <button class="cvtool" data-act="cv-undo" title="復原（Ctrl+Z）" aria-label="復原"${h.undo.length ? '' : ' disabled'}><i class="ph ph-arrow-counter-clockwise"></i></button>
      <button class="cvtool" data-act="cv-redo" title="重做（Ctrl+Y）" aria-label="重做"${h.redo.length ? '' : ' disabled'}><i class="ph ph-arrow-clockwise"></i></button>
      <span class="sep"></span>
      <button class="cvtool" data-cv-zoom="out" title="縮小" aria-label="縮小"><i class="ph ph-minus"></i></button>
      <span class="pct">${pct}%</span>
      <button class="cvtool" data-cv-zoom="in" title="放大" aria-label="放大"><i class="ph ph-plus"></i></button>
      <button class="cvtool" data-cv-zoom="fit" title="全覽：縮放到剛好全看見" aria-label="全覽"><i class="ph ph-corners-out"></i></button>
      <span class="sep"></span>
      <button class="cvtool" data-act="cv-tidy" title="整理排列：照步驟順序把圖重新排好（會蓋掉你拖過的位置）" aria-label="整理排列"><i class="ph ph-tree-structure"></i></button>
      <span class="sep"></span>
      <button class="cvtool q" data-act="cv-help" title="操作說明" aria-label="操作說明" aria-expanded="${state.cvHelp ? 'true' : 'false'}">?</button>
    </div>
    <div class="cvhint">雙擊空白處新增步驟　·　從卡片圓點拉線到下一步</div>
    <div class="cvhelp"${state.cvHelp ? '' : ' hidden'}><b>操作說明</b>雙擊空白處：新增步驟<br>拖卡片：移動位置<br>從圓點拉線：接到下一步<br>一張卡拉出兩條以上的線：決定同時做或擇一<br>點線、按 Delete：刪掉這條線<br>Ctrl+Z／Ctrl+Y：復原／重做<br>滾輪＋Ctrl：縮放</div>`;
}
// 交給 canvas.js 的畫面選項：步驟序號、正在寫的條件格（打到一半的字由 data-keep 讀回）、存檔攔下的空條件、選中的線、工具列
function cvCanvasOpts(def) {
  const ce = state.cvCondEdit;
  return { seq: stepSeqMap(def), condEdit: ce ? { ...ce, text: kept('cvcond-edit') } : null, condIssues: state.cvCondIssues ?? [], edgeSel: state.cvEdgeSel ? cvEdgeKey(state.cvEdgeSel) : null, chrome: cvChromeHtml() };
}
const cvEdgeKey = (e) => `${e.from}>${e.to}>${e.arm ?? ''}`;

// 步驟編輯（D18；清單「編輯」、檢視器「完整編輯」、畫布雙擊都開這一個——畫面正中彈窗、背景霧化，掛 render 浮窗串尾（地雷 5）
function drawerHtml() {
  if (!state.drawerOpen || state.run || !(state.mode === 'list' || state.mode === 'canvas') || !(state.flowTab === 'design')) return (state.drawerTabFor = null, ''); // T10：本次資料分頁不開；沒畫出來＝忘記節點（下次打開不放回舊暫存字）
  const def = cvDef();
  const n = def?.nodes.find((x) => x.id === state.canvasSel);
  if (!n) return (state.drawerTabFor = null, '');
  if (state.drawerTabFor !== n.id) { dropStepKeep(); state.drawerTabFor = n.id; state.cvMore = null; } // 換節點：清暫存字、收摺回自動
  const kind = kindOf(n);
  const title = kind === 'fork' ? '並行點' : kind === 'join' ? '舊式會合點' : `編輯步驟 ${seqTxt(stepSeqMap(def).get(n.id))}`;
  return `<div class="pvback stepmodal" data-act="cv-close-drawer"><div class="modal stepdlg" role="dialog" aria-label="編輯步驟">
    <div class="heading"><h2>${title}</h2><button class="btn btn-ghost iconb" data-act="cv-close-drawer" aria-label="關閉"><i class="ph ph-x"></i></button></div>${state.stepAsk ? stepAskHtml() : ''}
    ${canvasEditorHtml(n, def)}</div></div>`;
}
// 彈窗文字欄暫存字（state.keep 的 cv-* 鍵）——換節點、套用、關窗就清，別讓上一次沒套用的字跑進下一次
function dropStepKeep() { for (const k of Object.keys(state.keep)) if (k.startsWith(keepKey('cv-'))) delete state.keep[k]; }
function closeStepModal() { state.drawerOpen = false; state.drawerTabFor = null; state.cvMore = null; state.stepAsk = false; dropStepKeep(); } // 未套用的改動丟掉（同原抽屜「關閉」）

// ---------- 有未套用改動時，背景點一下不關（閃框）、Esc／✕／取消先問 ----------
// 彈窗欄位值：有 id 的輸入框／選單／勾選＋參考檔勾選（data-att，鍵 att:層:檔名）；「常用片段⋯」選單只是帶入器，不算
function stepFormValues(dlg) {
  const out = {};
  for (const f of dlg.querySelectorAll('input, select, textarea')) {
    if (f.matches('[data-preset-field]')) continue;
    const key = f.dataset.att != null ? `att:${f.dataset.attScope ?? 'flow'}:${f.dataset.att}` : f.id;
    if (!key) continue;
    out[key] = f.type === 'checkbox' || f.type === 'radio' ? !!f.checked : f.value;
  }
  return out;
}
// render 後呼叫：開窗（或換節點）記下欄位值；之後才長出來的欄位（參考檔清單載入完）用它第一次出現的值補進去；沒開窗清掉
function syncStepSnap() {
  const dlg = document.querySelector('.stepdlg');
  if (!dlg) { state.stepSnap = null; state.stepSnapFor = null; return; }
  const cur = stepFormValues(dlg);
  if (!state.stepSnap || state.stepSnapFor !== state.drawerTabFor) { state.stepSnap = cur; state.stepSnapFor = state.drawerTabFor; return; }
  for (const k of Object.keys(cur)) if (!(k in state.stepSnap)) state.stepSnap[k] = cur[k];
}
function stepModalDirty() {
  if (!state.stepSnap) return false;
  const dlg = document.querySelector('.stepdlg');
  if (!dlg) return false;
  const cur = stepFormValues(dlg);
  return Object.keys(cur).some((k) => k in state.stepSnap && cur[k] !== state.stepSnap[k]);
}
function stepAskHtml() {
  return `<div class="stepask" role="alertdialog" aria-label="有改動還沒套用"><span>有改動還沒套用</span><button class="btn btn-primary" data-act="cv-apply">套用</button><button class="btn" data-act="cv-close-drawer" data-discard="1">丟掉</button><button class="btn btn-ghost" data-act="step-ask-cancel">繼續編輯</button></div>`;
}
// 詢問列只補畫不整頁重繪（勾選與選單沒進暫存字，重繪會洗掉沒套用的勾）
function showStepAsk() {
  state.stepAsk = true;
  const dlg = document.querySelector('.stepdlg');
  if (!dlg) return;
  if (!dlg.querySelector('.stepask')) dlg.querySelector('.heading')?.insertAdjacentHTML('afterend', stepAskHtml());
  const ask = dlg.querySelector('.stepask');
  dlg.scrollTop = 0;
  ask?.querySelector('[data-act="cv-apply"]')?.focus();
}
function hideStepAsk() { state.stepAsk = false; document.querySelector('.stepask')?.remove(); document.querySelector('.stepdlg')?.focus?.(); }
function nudgeStepModal() {
  const dlg = document.querySelector('.stepdlg');
  if (!dlg) return;
  dlg.classList.remove('nudge');
  void dlg.offsetWidth; // 重播動畫
  dlg.classList.add('nudge');
  setTimeout(() => dlg.classList.remove('nudge'), 500);
}

// 彈窗「輸入來源」（T5； 改一行灰字，樣稿「輸入來源：…」）：只給 AI 步驟；清單來自 /api/preflight 的 inputs，空的標紅
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
    return '<div id="drawer-inputs" class="dinputs"><span class="lb">輸入來源：</span><span>檢查中⋯</span></div>';
  }
  const items = pfInputs(pf, n.id).map((s) => esc(inputSourceText(s))).join('、');
  return `<div id="drawer-inputs" class="dinputs"><span class="lb">輸入來源：</span>${items ? `<span>${items}</span>` : '<span class="none"><i class="ph-fill ph-warning"></i>開跑時什麼都拿不到</span>'}</div>`;
}

// ---------- 履歷模式 ----------
function historyModeHtml() {
  if (!state.wf || subjectIsDraft()) {
    return `<div class="empty-c"><div class="ic"><i class="ph ph-clock-counter-clockwise"></i></div>
      <h3>草稿還沒有履歷</h3><p>存進 Workflow 庫之後，每次它學新招或你動手改都會留一版，隨時退回。</p></div>`;
  }
  // （樣稿 uxHistoryPage）：執行紀錄｜Workflow 版本兩分頁（state.historyTab），各一張白卡；執行紀錄＝原資料夾「每次執行」列（全列不收）
  const tab = state.historyTab === 'versions' ? 'versions' : 'runs';
  const t = (k, label) => `<span class="${tab === k ? 'on' : ''}" data-act="history-tab" data-tab="${k}" tabindex="0" role="button">${label}</span>`;
  const seg = `<div class="seg histtabs">${t('runs', '執行紀錄')}${t('versions', 'Workflow 版本')}</div>`;
  if (tab === 'runs') {
    const runs = state.wfRuns;
    const body = runs === null ? '<p class="note">讀不到歷次執行。</p>'
      : !runs.length ? '<p class="note">這條 Workflow 還沒開跑過。</p><button class="btn btn-primary" data-act="flow-tab" data-tab="data">準備執行</button>'
        : runs.map((r) => folderRunHtml(state.wf, r)).join('');
    return `${seg}<div class="panel histpanel">${body}</div>`;
  }
  const cur = state.versions.at(-1)?.version;
  const srcLabel = { create: '建立', params: '參數習慣', edits: '停點修改', feedback: '事後回饋', rollback: '退回', manual: '手動編輯' };
  const rows = [...state.versions].reverse().map((v) => `
    <div class="ver ${v.version === cur ? 'now' : ''}">
      <b>v${v.version}</b>
      <span style="flex:1">${esc(v.diff_note)}<span class="meta">${esc(srcLabel[v.source] ?? v.source)}${v.at ? ' · ' + esc(new Date(v.at).toLocaleString('zh-TW', { hour12: false })) : ''}</span></span>
      ${v.version === cur ? '<span class="chip">現行版</span>' : `<span class="backb" data-act="rollback-version" data-version="${v.version}" tabindex="0" role="button"><i class="ph ph-arrow-counter-clockwise"></i>退回這版</span>`}
    </div>`).join('');
  return `${seg}<div class="panel histpanel"><p class="note histnote">每次它學新招、或你動手改（畫布／聊天）都留一版；改壞了退回就好，進行中的那趟會用當時的版本跑完。</p>
    ${rows || '<p class="note">還沒有版本紀錄。</p>'}</div>`;
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
  // 頁標題元件＋白卡（按鈕與 data-act 不變）
  return `${pageHeadHtml(`匯入預覽：${def.name}`, `共 ${def.nodes.length} 步。匯入後放在「匯入」分類，資料來源要在你自己這邊重新接（別人的連線不會跟過來）。`)}
    ${banner}
    <div class="panel importpanel">${steps}
    <div class="btns" style="margin-top:var(--s4);justify-content:center">${confirmBtn}</div></div>`;
}

function trashViewHtml() {
  const rows = state.trash.map((t) => `<div class="step">
    <span class="n"><i class="ph ph-trash"></i></span><b>${esc(t.name)}</b>
    <span class="chip">${esc(catLabel(t.category))}</span>
    <span class="sub" style="margin:0">${esc(new Date(t.trashed_at).toLocaleDateString('zh-TW'))} 刪除</span>
    <span class="pillslot"><button class="btn btn-secondary" style="padding:5px 13px" data-act="restore-trash" data-key="${esc(t.key)}">復原</button></span>
  </div>`).join('');
  return `${pageHeadHtml('垃圾桶', '刪掉的 Workflow 放 30 天，期限內都能整個復原（含履歷和跑過的紀錄）。', `<button class="btn" data-act="close-trash"><i class="ph ph-caret-left"></i>${state.trashFromLib ? '回 Workflow 庫' : '回工作區'}</button>`)}
    <div class="panel trashpanel">${rows || '<div class="empty-c"><div class="ic"><i class="ph ph-trash"></i></div><h3>垃圾桶是空的</h3></div>'}</div>`;
}

function corruptCardHtml() {
  return `${pageHeadHtml('這個 Workflow 的檔案讀不懂', '清單和其他 Workflow 都沒事。')}<div class="panel corruptpanel">
    <p class="sub" style="margin:0 0 12px"><i class="ph-fill ph-warning"></i> ${esc(state.corrupt.message)}（可能被手動改壞）。</p>
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
    case 'waiting_check': return '<span class="chip wait"><i class="ph-fill ph-hand-palm"></i>等你</span>'; // 三欄化後左軌也用這顆，被攔的步不能灰成「等待」（地雷 3）；U6b：字用「等你」——「查核攔下」留給同列的 checkChip，不印兩顆同字
    case 'failed': return '<span class="chip bad"><i class="ph-fill ph-warning"></i>出錯</span>';
    case 'skipped': return '<span class="chip quiet" style="opacity:.6">跳過</span>';
    default: return '<span class="chip quiet">等待</span>';
  }
}

// 查核結果 chip：missing 由資料不全卡呈現、off／skipped 不標；usage＝這一步的查核用量 {input,output}
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

// 標黃行：查核沒攔下、但值得你看一眼的兩種情形
const FLAG_TXT = { 'conclusion-changed': '這一步把結論或排序改了', format: '格式跟要求不同' };
function flagsHtml(step) {
  return (step?.check?.flags ?? [])
    .filter((f) => FLAG_TXT[f.kind])
    .map((f) => `<div class="flagline"><i class="ph-fill ph-flag"></i><span>${esc(FLAG_TXT[f.kind])}：${esc(f.detail)}</span></div>`)
    .join('');
}

// ---------- 文字成品真排版：POST /api/render 按內容雜湊快取；拿到前先顯示原文，回來只補該區塊不整頁重繪 ----------
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

// 成品檔 chip：點開頁內預覽浮窗，下載在浮窗裡
const FILE_ICON = { docx: 'ph-file-doc', xlsx: 'ph-file-xls', pdf: 'ph-file-pdf', csv: 'ph-file-csv', pptx: 'ph-file-ppt', txt: 'ph-file-txt', html: 'ph-file-html' };
function fileChipHtml(cat, id, rid, name, note) {
  const ext = String(name).split('.').pop().toLowerCase();
  return `<span class="chip expander filechip" data-act="preview-file" data-cat="${esc(cat)}" data-id="${esc(id)}" data-rid="${esc(rid)}" data-fname="${esc(name)}" title="${esc(note ?? '點開看內容，浮窗裡可下載')}"><i class="ph ${FILE_ICON[ext] ?? 'ph-file-text'}"></i>${esc(name)}</span>`;
}

// ---------- 成品預覽浮窗：GET …/files/:name/preview 依 kind 渲染；狀態在 state.preview，輪詢重繪不會關掉 ----------
async function openPreview(cat, id, rid, name) {
  const pv = { cat, id, rid, name, data: null, err: null, sheet: 0 };
  state.preview = pv;
  render();
  try { pv.data = await api('GET', runFileUrl(cat, id, rid, name, '/preview')); }
  catch (e) { pv.err = e.message; }
  if (state.preview === pv) render();
}
// 共用檔查看共用同一個浮窗——pv.shared＝層（_company｜部門名）；GET …/files/:name/view（md／txt 原文、docx 排版）
async function openSharedPreview(scope, name) {
  const pv = { shared: scope, name, data: null, err: null, sheet: 0 };
  state.preview = pv;
  render();
  try { pv.data = await api('GET', `${sharedPath(scope)}/${encodeURIComponent(name)}/view`); }
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
  return `<div class="pvback" data-act="preview-back"><div class="pvmodal" role="dialog" aria-label="${pv.shared != null ? '共用檔內容' : '成品預覽'}">
    <div class="pvhead"><i class="ph ${FILE_ICON[String(pv.name).split('.').pop().toLowerCase()] ?? 'ph-file-text'}"></i><b title="${esc(pv.name)}">${esc(pv.name)}</b>${kindChip}
      <button class="btn btn-ghost iconb" data-act="preview-close" style="margin-left:auto" title="關閉（Esc）"><i class="ph ph-x"></i></button></div>
    ${tabs}
    <div class="pvbody ${d?.kind ?? 'wait'}">${body}</div>
    <div class="pvfoot">
      <a class="btn btn-primary" href="${esc(pv.shared != null ? `${sharedPath(pv.shared)}/${encodeURIComponent(pv.name)}` : runFileUrl(pv.cat, pv.id, pv.rid, pv.name))}" download="${esc(pv.name)}"><i class="ph ph-download-simple"></i>下載</a>
      ${printBtn}
      <span class="note">${note}</span>
      <button class="btn" data-act="preview-close">關閉</button>
    </div>
  </div></div>`;
}

// 監工交代＋插話：停點卡與查核卡共用。
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
    <div class="sub" style="margin:6px 0">Workflow 會停在這裡等你，不趕時間。順手留一句現場狀況更好（選填）。</div>
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
    return '<div class="card" style="margin:10px 0"><b>這趟的紀錄</b><div class="sub" style="margin:6px 0 0">這條 Workflow 沒開監工。</div></div>';
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
  // 欄位值可多行了：摘要列只露第一行前 40 字，整份放 title
  const brief = (v) => { const s = String(v ?? '').split('\n')[0]; return s.length > 40 ? `${s.slice(0, 40)}⋯` : s; };
  const meta = `${started.toLocaleString('zh-TW', { hour12: false })} 開跑 · 這次設定：${def.params.map((p) => `<span title="${esc(run.params[p.key])}">${esc(brief(run.params[p.key]))}</span>`).join('・') || '（無）'}`;

  // 中欄只放一步——看的那步＝state.runInspect ?? 目前這步。
  // 左軌點到做完／還沒跑的步＝歷史視圖；點到等你／出錯的步（並行支線不是目前這步的）＝同目前這步的畫法、可操作（報備 9）
  let histNode = historyNodeOf(run);
  // 在支線上處理完（還看著同一步、那步不再等你）＝回到目前這步；改點別的步／看做完的步則一直留在歷史（L12b：記住看的是哪一步，不然看過支線後第一次點別步會被彈回）
  if (histNode && state.runInspectLive === histNode.id && !isLiveStep(run.steps[histNode.id])) { state.runInspect = null; histNode = null; }
  state.runInspectLive = histNode && isLiveStep(run.steps[histNode.id]) ? histNode.id : null;
  const live = !histNode || !!state.runInspectLive;
  let main;
  if (!live) main = runHistoryHtml(run, histNode);
  else if (isDone) main = runCompleteHtml(run);
  else {
    const node = histNode ?? def.nodes.find((n) => n.id === currentNodeOf(run));
    main = node ? runStepHtml(run, node, !!histNode) : '';
  }

  const pill = isDone ? '<span class="chip quiet"><i class="ph-fill ph-check-circle"></i>全部完成</span>'
    : run.status === 'paused' ? '<span class="chip wait"><i class="ph-fill ph-hourglass-medium"></i>停著等你</span>'
      : `<span class="chip quiet">第 ${Math.min(doneCount + 1, def.nodes.length)} 步</span>`;
  // 頁標題（樣稿 uxRunPage .heading）：同 pageHeadHtml 的結構，但說明行帶欄位值的 title 提示（pageHeadHtml 會把 HTML escape 掉）
  const head = `<div class="page-head"><div><h1>${esc(def.name)}</h1><p>${meta}</p></div><div class="actions">${pill}<button class="btn" data-act="back"><i class="ph ph-caret-left"></i>回 Workflow</button></div></div>`;
  return `${crumbsHtml('這次的執行')}${head}${memoryNoticeHtml(run)}<div class="runlayout">${progressRailHtml(run)}<section class="runmain">${main}</section>${sideInfoHtml(run)}</div>`;
}

// 等你（waiting_*）或出錯的步＝要你動手，左軌點進來就能操作
// time_pending＝「時間沒解析出來、等你定時刻」，跟 waiting_* 一樣是等你處理，只是名字沒有 waiting 前綴——
// 漏掉它，執行頁就不把那步當活的，左軌不亮、中欄也不指過去（2026-09-18 審查）
function isLiveStep(step) { const s = String(step?.status ?? ''); return s.startsWith('waiting') || s === 'time_pending' || s === 'failed'; }
// 與畫布同一套號碼（stepSeqMap）；藏在卡片出口的擇一分岔沒有自己的號碼，標它那張卡的號碼
function stepSeqOf(run, node) {
  const seq = stepSeqMap(run.def);
  return seq.get(node.id) ?? seq.get(cvPreds(run.def).get(node.id)?.[0]) ?? 0;
}
// 產出框（樣稿 uxRunOutput）：「看原文」貼在產出框右上（驗收第 11 條）；成品檔 chip 在步驟列上已有，不重複
function runOutHtml(step, key) {
  return `<div class="runout"><div class="outbar">${step.edited_output != null ? '<span class="chip">你改過的版本</span>' : ''}${mdToggleHtml(key)}</div>${mdBlock(step.edited_output ?? step.output, key)}</div>`;
}
// 中欄那一步（樣稿 .panel：STEP NN＋第 N 次交卷→步名→狀態列→產出框→卡片原文→本步監工交代→後面每步會守）；other＝從左軌點進來的另一條支線
function runStepHtml(run, node, other) {
  const step = run.steps[node.id] ?? { status: 'pending' };
  const isBranch = kindOf(node) === 'branch';
  const seq = stepSeqOf(run, node);
  const tries = Array.isArray(step.attempts) ? step.attempts.length : 0;
  const card = stepCardHtml(node, step);
  // 停點卡／查核卡／資料不全卡自己印產出（卡片函式一字不動），沒有卡時才另印產出框
  const out = !card && !isBranch && (step.edited_output != null || step.output) ? runOutHtml(step, `out:${node.id}`) : '';
  const hand = step.handoff?.text && !step.handoff.only_route ? `<div class="stephandoff"><div class="flabel">這一步的監工交代</div><p>${esc(step.handoff.text)}</p></div>` : '';
  // 舊會合點（原本夾在步驟清單裡）：只在接在這一步後面、還在等的時候提
  const joins = run.def.nodes.filter((j) => kindOf(j) === 'join' && outgoingOf(node).includes(j.id) && !['done', 'skipped'].includes(run.steps[j.id]?.status)).map((j) => joinBlockedCardHtml(j, run)).join('');
  const banner = other ? '<div class="runbanner branch"><i class="ph ph-arrows-split"></i><span>同時進行的另一條支線，這一步也在等你——可以直接在這裡處理</span><button class="btn btn-secondary sm2" data-act="run-current"><i class="ph ph-arrow-bend-up-left"></i>回到目前</button></div>' : '';
  const row = isBranch ? branchRowHtml(run, node, step) : taskRowHtml(run, node, step, seq) + flagsHtml(step);
  return `${banner}<div class="panel runstep-now"><div class="stephead"><span class="caption">STEP ${String(seq).padStart(2, '0')}</span>${tries ? `<span class="chip">第 ${tries} 次交卷</span>` : ''}</div><h2>${esc(node.title)}</h2>${row}${out}${card}${hand}${step.status === 'done' ? editRulesHtml(node, step) : ''}${joins}</div>`;
}
// 跑完（樣稿 uxRunComplete）：一張白卡——成品列（旁邊看原文、可展開）→這趟的紀錄（整趟監工總結）→提議→回饋
function runCompleteHtml(run) {
  const def = run.def;
  // 人做步驟有交出內容的也列，標「（你交出的）」
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
    ? feedbackReplyHtml(state.feedbackSent) // （M2）：回覆照 memory_notice 講記成卡了／沒記成
    : `<div class="card proposal">
          回來丟一句結果吧——「主管說哪裡好、哪裡不行」，它會學起來。
          <div class="chatin" style="margin-top:8px"><input id="run-feedback-input" placeholder="例：主管說數據太細了⋯">
          <button class="btn btn-primary" data-act="send-run-feedback"><i class="ph-fill ph-paper-plane-tilt"></i></button></div>
        </div>`;
  return `<div class="panel runcomplete"><div class="stephead"><span class="chip quiet"><i class="ph-fill ph-check-circle"></i>完成</span></div><h2>這次的成品已備妥</h2>
    <div class="artifacts">${artifacts || '<p class="note">這趟沒有留下成品</p>'}</div>
    ${recordHtml(run)}${proposalsHtml()}${feedbackBox}</div>`;
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
// 本機時區的「YYYY-MM-DDTHH:mm」（datetime-local 的值格式；後端 scheduler.fmtLocal 同一式）
// 精簡: 本檔另有數處手寫的日期字串組法，之後一起收斂到這一支；不順手改既有呼叫點
const localStamp = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const atHourFrom = (base, days, hour) => { const x = new Date(base); x.setDate(x.getDate() + days); x.setHours(hour, 0, 0, 0); return x; };
const nextMondayAt = (hour) => { const x = new Date(); const dow = x.getDay() || 7; return atHourFrom(x, (8 - dow) % 7 || 7, hour); };

// 等時刻的兩個出口都走這裡——差別只有帶不帶時刻，而那正是後端 resumeTime 的兩條路：
// 帶 at＝排到那個時刻自動往下；不帶＝現在就放行往下跑。「不等了」誤帶 at 會變成排到那個時刻，
// 是看不出來的錯（畫面一樣是離開卡片），所以收斂成一支好測的函式，別讓兩個呼叫點各寫各的。
async function resumeTimeCall(node, at) {
  await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/resume-time`, at ? { node, at } : { node });
  delete state.keep[keepKey('time-at')];
  await refreshRun();
}

// 時間未定（time_pending）：wait_until 指的那一步沒交出看得懂的時刻，等你定。
// 出口是後端的 resume-time：給時刻＝排到那時候自動往下；不給＝現在就往下走。
// 沒有這張卡的話，run 會永久卡住，而且一直被算成「上一輪還沒跑完」在每次到點發重疊警示。
// 時間定好之後狀態轉 waiting_time，但中欄本來什麼都不印——
// 使用者剛按完「就排這個時間」，畫面一空，不知道到底排到了沒、排到幾點。
function waitingTimeCardHtml(node, step) {
  const at = step.wake_at ? new Date(step.wake_at) : null;
  const when = at && !Number.isNaN(at.getTime())
    ? at.toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : '';
  return `<div class="alert"><b><i class="ph-fill ph-clock"></i> ${when ? `已排到 ${esc(when)}` : '已排好時間'}，到點自動往下跑</b>
    <p class="note">這中間你不用守著。剝繭沒開著的話，下次開起來會接著處理。</p></div>`;
}

function timeCardHtml(node, step) {
  const raw = String(step.time_note ?? '').trim();
  const note = !raw || /[。.!?！？]$/.test(raw) ? raw : `${raw}。`; // 結尾沒標點就補一個，免得跟下一句黏成一長串
  const now = new Date();
  const quick = [
    ['明天早上 9 點', localStamp(atHourFrom(now, 1, 9))],
    ['下週一 9 點', localStamp(nextMondayAt(9))],
    ['三天後', localStamp(atHourFrom(now, 3, 9))],
  ];
  return `<div class="alert">
    <b><i class="ph-fill ph-clock"></i> 時間還沒定出來，先停在這裡</b>
    <div class="why">${note ? esc(note) : `「${esc(node.title)}」要等前一步敲定的時間才能開始，但那一步沒給出明確的日期時間。`}要幾號幾點繼續？</div>
    <div class="supplybox">
      <div class="flabel">到這個時間就自動往下跑</div>
      <div class="btns" style="margin-bottom:6px">
        ${quick.map(([label, at]) => `<button class="btn sm2" data-act="time-quick" data-at="${esc(at)}">${esc(label)}</button>`).join('')}
      </div>
      <div class="btns">
        <input type="datetime-local" id="time-at" class="moveselect" data-keep value="${esc(kept('time-at') ?? localStamp(atHourFrom(now, 1, 9)))}">
        <button class="btn btn-primary" data-act="time-set" data-node="${esc(node.id)}"><i class="ph ph-calendar-check"></i>就定這個</button>
      </div>
    </div>
    <div class="btns">
      <button class="btn" data-act="time-now" data-node="${esc(node.id)}"><i class="ph ph-arrow-right"></i>不等了，現在就往下跑</button>
    </div>
  </div>`;
}

// 停著／出錯那步的卡：中欄那一步直接印（卡片函式與 data-act 一字不動； 起支線也可操作）
function stepCardHtml(node, step) {
  if (kindOf(node) === 'branch') return step.status === 'waiting_branch' ? branchChoiceCardHtml(node) : step.status === 'failed' ? failCardHtml(node, step) : '';
  switch (step.status) {
    case 'waiting_review': return stopCardHtml(node, step);
    case 'waiting_check': return checkCardHtml(node, step);
    case 'waiting_human': return humanCardHtml(node);
    case 'waiting_data': return dataCardHtml(node, step);
    case 'time_pending': return timeCardHtml(node, step);
    case 'waiting_time': return waitingTimeCardHtml(node, step);
    case 'failed': return failCardHtml(node, step);
    default: return '';
  }
}

// ---------- 歷史視圖（demo runPage 的 inspect／historical）——左軌點了做過的一步，中欄只剩那一步 ----------
// 看的那步：state.runInspect 指到的節點；＝目前這步（currentNodeOf）不算歷史；指到不存在／fork／join（輪詢中被刪）退回 null
function historyNodeOf(run) {
  const id = state.runInspect;
  if (id == null) return null;
  const node = run.def.nodes.find((n) => n.id === id);
  if (!node || ['fork', 'join'].includes(kindOf(node))) { state.runInspect = null; return null; }
  return id === currentNodeOf(run) && run.status !== 'done' ? null : node; // 跑完的 run 中欄是成品，點最後一步也要看得到它的歷史
}
// 橫幅「你在看…回到目前」＋一張白卡（STEP NN・歷史→步名→那一步的列→產出框（edited_output 優先並標「你改過的版本」）→後面每步會守）；
// 等你／出錯的步不走這裡（runHtml 交給 runStepHtml 可操作，inert 唯讀退場）；recordHtml／成品／回饋框不印
function runHistoryHtml(run, node) {
  const step = run.steps[node.id] ?? { status: 'pending' };
  const isBranch = kindOf(node) === 'branch';
  const seq = stepSeqOf(run, node);
  const banner = `<div class="runbanner hist"><i class="ph ph-clock-counter-clockwise"></i><span>你在看「${esc(node.title)}」這一步的歷史</span><button class="btn btn-secondary sm2" data-act="run-current"><i class="ph ph-arrow-bend-up-left"></i>回到目前</button></div>`;
  const row = isBranch ? branchRowHtml(run, node, step) : taskRowHtml(run, node, step, seq) + flagsHtml(step);
  let body;
  if (step.status === 'done' && !isBranch && (step.edited_output != null || step.output)) body = runOutHtml(step, `hist:${node.id}`);
  else if (step.status === 'done') body = isBranch ? '' : '<p class="note">這一步沒有留下產出</p>';
  else if (step.status === 'pending') body = '<p class="note">這一步還沒開始</p>';
  else if (step.status === 'running') body = '<p class="note">這一步進行中</p>';
  else body = '<p class="note">這一步沒走到</p>'; // skipped
  return `${banner}<div class="panel runstep-now hist"><div class="stephead"><span class="caption">STEP ${String(seq).padStart(2, '0')}</span><span class="chip">歷史</span></div><h2>${esc(node.title)}</h2>${row}${body}${step.status === 'done' ? editRulesHtml(node, step) : ''}</div>`;
}

// ---------- 執行頁三欄——左軌（這次的進度）、中欄（只放一步）、右欄（四格摺疊）；demo runPage() ----------
// 「目前這步」：第一個停著等你的（waiting_*），否則出錯的（中欄只放一步，出錯卡要看得到），否則進行中的，否則最後一個做完的，否則第一步
function currentNodeOf(run) {
  const nodes = topoNodes(run.def).filter((n) => !['fork', 'join'].includes(kindOf(n)));
  const st = (n) => run.steps?.[n.id]?.status ?? '';
  const waits = (n) => st(n).startsWith('waiting') || st(n) === 'time_pending'; // time_pending 同樣是等你，見 isLiveStep
  return (nodes.find(waits) ?? nodes.find((n) => st(n) === 'failed') ?? nodes.find((n) => st(n) === 'running') ?? [...nodes].reverse().find((n) => st(n) === 'done') ?? nodes[0])?.id ?? null;
}

// 左軌：每個非 fork／join 節點一顆鈕；點了＝切成那一步的歷史視圖；active＝看的那步（沒點就是目前這步）
function progressRailHtml(run) {
  const currentId = currentNodeOf(run);
  const activeId = state.runInspect ?? (run.status === 'done' ? null : currentId); // 跑完中欄是成品，沒有哪一步亮著
  const seqMap = stepSeqMap(run.def); // 與畫布同一套號碼
  const items = topoNodes(run.def).filter((n) => !['fork', 'join'].includes(kindOf(n))).map((node) => {
    const step = run.steps?.[node.id] ?? { status: 'pending' };
    const n = step.status === 'done' ? '<i class="ph ph-check"></i>' : step.status === 'skipped' ? '—' : kindOf(node) === 'branch' ? '<i class="ph ph-arrows-split"></i>' : seqMap.get(node.id);
    // 還沒跑到的步（pending／skipped 且不是目前這步）照 demo 灰掉不可點；running／done／failed／waiting 都可點
    const future = ['pending', 'skipped'].includes(step.status) && node.id !== currentId;
    // 並行兩支同時等你時，currentNodeOf 只挑得出第一支，左軌就只有那一顆亮。
    // 每一顆自己看自己的狀態，等你的全部標起來；active（＝現在看的那步）照舊只有一顆。
    const waiting = String(step.status).startsWith('waiting') || step.status === 'time_pending';
    return `<button class="runstep${node.id === activeId ? ' active' : ''}" data-act="run-inspect" data-node="${esc(node.id)}" title="${future ? '還沒跑到' : esc(node.title)}"${future ? ' disabled' : ''}${waiting ? ' data-waiting' : ''}><span class="n">${n}</span><span class="t">${esc(node.title)}</span>${stepPill(step)}</button>`;
  }).join('');
  return `<aside class="panel progressrail"><h3>這次的進度</h3>${items}</aside>`;
}

// 右欄看的那一步：state.runInspect（歷史視圖，U6c）優先，否則 currentNodeOf
function sideNodeOf(run) {
  const curId = state.runInspect ?? currentNodeOf(run);
  return run.def.nodes.find((n) => n.id === curId) ?? run.def.nodes[0] ?? {};
}

// 右欄「這步會用到的資料」：共用檔行讀 step.memory.shared（runner 送工作單前寫的快照＝開跑鎖的那版）＋「哪幾份」＋來源一行；
// 不重印 memoryUsedHtml（會共用 memOpen 雙開）——記憶卡看卡片上那行
function sideDataHtml(run, node, step) {
  if (kindOf(node) !== 'task') return '<p class="note">分岔不帶資料，只照 Workflow 判路</p>';
  if (node.executor === 'human') return '<p class="note">這步由你處理，不帶共用檔</p>';
  const sh = step.memory?.shared;
  const arr = (k) => (Array.isArray(sh?.[k]) ? sh[k] : []);
  let shared;
  if (!sh) shared = '<p class="note">這趟沒有共用檔紀錄</p>'; // 舊 run／還沒送出工作單的步
  else {
    const rows = [...arr('company').map((r) => ['組織規範', r]), ...arr('dept').map((r) => ['分類規範', r]), ...arr('refs').map((r) => [r.scope === 'company' ? '組織參考' : '分類參考', r])];
    const counts = [['組織規範', arr('company').length], ['分類規範', arr('dept').length], ['參考', arr('refs').length]].filter(([, k]) => k);
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
  const list = pfInputs(pf, node.id).map(inputSourceText);
  return `<p class="note" data-srcline>來源：${list.length ? esc(list.join('、')) : '沒有指定輸入'}</p>`;
}

// 右欄：「目前這步」＋四格 <details>（開合狀態在 state.sideOpen，summary 走 side-toggle；重繪讀回）＋底部「當時指示」
function sideInfoHtml(run) {
  const node = sideNodeOf(run);
  const step = run.steps?.[node.id] ?? {};
  const fold = (k, title, body) => `<details class="sidefold"${state.sideOpen?.[k] ? ' open' : ''}><summary data-act="side-toggle" data-k="${k}"><i class="ph ph-caret-down"></i>${title}</summary><div class="sidebody">${body}</div></details>`;
  // 監工交代：唯讀摘要（開場備註＋各步交接）；插話框留在卡片上
  let sup;
  if (run.def?.supervisor?.enabled === false) sup = '<p class="note">這條 Workflow 沒開監工</p>';
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
  // 第二塊「本次補充」只在開跑時有寫才出
  const note = String(run.note ?? '').trim() ? `<div class="panel sidenote"><h3>本次補充</h3><p class="note">${esc(run.note)}</p></div>` : '';
  return `<aside class="sideinfo"><div class="panel"><h3>目前這步</h3><div class="curstep"><b>${esc(node.title ?? '')}</b>${stepPill(step)}</div>
    ${fold('sup', '監工交代', sup)}
    ${fold('data', '這步會用到的資料', sideDataHtml(run, node, step))}
    ${fold('focus', '驗收重點', focus)}
    ${fold('attempts', '每次交卷', attempts)}${promptBtn}</div>${note}</aside>`;
}

// 「當時指示」卷宗浮窗：儀表板每步列與執行頁右欄共用同一張；掛 .layout 外（地雷 5）；view＝{title, text}
function promptModalHtml(view) {
  if (!view) return '';
  return `<div class="modalback" data-act="prompt-back"><div class="modal" style="max-width:680px">
      <div class="cvdhead"><b style="font-size:15px">當時送出的指示——${esc(view.title)}</b>
        <span class="btn btn-ghost iconb" data-act="prompt-close" style="margin-left:auto"><i class="ph ph-x"></i></span></div>
      <pre class="promptpre">${esc(view.text)}</pre>
      <div class="saverow"><button class="btn" data-act="prompt-close">關閉</button></div>
    </div></div>`;
}

// ---------- 儀表板：要你處理／系統通知／最近完成／用量監控 ----------
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
      if (!isTyping() && !state.preview && !state.dash?.usageOpen) render(); // 預覽／用量浮窗開著時不重繪（重繪會把浮窗捲回頂、pdf 重載）；關掉下一輪就補上
    } catch (e) { pollFailed('儀表板', e); }
    dashPoll();
  }, 5000);
}

// 待辦/通知動作後重載目前開著的頁面（儀表板或行事曆）
async function reloadPageData() {
  if (state.dash) await loadDash();
  else if (state.calendar) await loadCalendar();
}

// 待辦與通知的列（原行事曆側欄，搬家至此）；提議列拆去右欄「流程提議」（proposalRowsHtml），每列右側琥珀「等你」
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
// 接下來的安排：本月行事曆裡還沒到的剝繭排程與等時刻步驟，前兩筆；Google 快照、錯過、已跳過、暫停不算（工程報備 7）
function upcomingHtml(d) {
  if (!d.calendar) return '<div class="railempty">讀不到接下來的安排</div>';
  const p = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const nowKey = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}`;
  const next = (d.calendar.events ?? []).filter((e) => ['auto', 'human', 'makeup'].includes(e.kind) && `${e.date}T${e.time}` >= nowKey).slice(0, 2);
  const rows = next.map((e) => `<div class="upcoming"><span class="uptime">${Number(e.date.slice(5, 7))}/${Number(e.date.slice(8, 10))} ${esc(e.time)}</span>
      <div class="upbody"><b>${esc(e.title)}</b><span class="meta">${e.kind === 'human' ? '你出面' : 'AI 自動'}</span></div></div>`).join('');
  return rows || '<div class="railempty">這個月沒有安排</div>'; // 「查看」在卡片右上
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
  const doneRows = `<div class="donelist">${state.notices.done.map((n) =>
    `<div class="item"><div class="ti">${esc(n.title)}</div><div class="de">${esc(n.result ?? '')}・${new Date(n.resolved_at ?? n.created_at).toLocaleString('zh-TW', { hour12: false })}</div></div>`).join('') || '<div class="railempty">還沒有已處理的通知</div>'}</div>`;
  // （驗收第 9 條）：已處理收進 <details>「已處理（N）」；開關由 state.noticesOpen 控（summary 點擊擋原生切換），輪詢重繪讀回
  return `${nRows || '<div class="railempty">沒有新通知</div>'}
    <details class="donefold"${state.noticesOpen ? ' open' : ''}><summary data-act="notices-toggle-done"><i class="ph ph-caret-right"></i>已處理（${state.notices.done.length}）</summary>${doneRows}</details>`;
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

// 用量：帳本一筆的輸入 tokens（含快取兩桶）；日期鍵＝本機日期（表格與小圖同一把尺，晚上跑的不會被 UTC 切到隔天）
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
    <span class="${d.usageView === 'flow' ? 'on' : ''}" data-act="dash-usage-view" data-view="flow">按 Workflow</span>
    <span class="${d.usageView === 'day' ? 'on' : ''}" data-act="dash-usage-view" data-view="day">按日</span></span>`;
  return `<div class="modalback" data-act="dash-usage-back"><div class="modal usagemodal" role="dialog" aria-label="用量明細">
      <div class="cvdhead"><b style="font-size:15px"><i class="ph ph-chart-bar"></i> 用量明細${d.usageView === 'day' ? hint('30 根＝近 30 天，最右是今天。') : ''}</b>${seg}
        <span class="btn btn-ghost iconb" data-act="dash-usage-close" style="margin-left:auto" title="關閉（Esc）"><i class="ph ph-x"></i></span></div>
      ${d.usageView === 'day' ? usageChartHtml(d.data.usage, true) : ''}
      ${usageSectionHtml(d)}
      <div class="saverow"><button class="btn" data-act="dash-usage-close">關閉</button></div>
    </div></div>`;
}
// 用量數字表：近 30 天帳本，按流程或按日彙總（U5 起住在浮窗裡；seg 搬到浮窗標題列）
function usageSectionHtml(d) {
  const entries = d.data.usage ?? [];
  const KIND_TXT = { compose: '聊天建 Workflow', scan: '匯入掃描', snapshot: 'Google 快照', optimize: '優化提議' };
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
      <table class="usagetbl"><thead><tr><th>${d.usageView === 'day' ? '日期' : 'Workflow／用途'}</th><th>次數</th><th>輸入 tokens</th><th>輸出 tokens</th><th>花費</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="railempty">還沒有用量紀錄——這次改版之後跑的才會記帳，舊紀錄沒有數字</div>';
}

// 儀表板（ 照 demo home()）：左欄 要你處理＋最近完成（預設 3 張、查看全部）；右欄 接下來的安排／系統通知／流程提議／用量
function dashHtml() {
  const d = state.dash;
  if (!d.data) return '<div class="empty-c"><div class="skel" style="height:200px"></div></div>';
  const memRow = memExceptionRowHtml(); // （M4）：第一列＝記憶例外，算進「要你處理」的數
  const todoRows = memRow + todoRowsHtml();
  const todoCount = todoItems().length + (memRow ? 1 : 0); // 提議另成一塊（ 左欄第三塊），不算進「要你處理」
  const recent = d.data.recent;
  const cards = (d.showAll ? recent : recent.slice(0, 3)).map(dashRunCard).join('')
    || '<div class="railempty">還沒有任何執行紀錄——從左邊點開一條 Workflow 按「開始」</div>';
  const showAll = recent.length > 3 ? `<span class="pbtn" data-act="dash-show-all"><i class="ph ph-caret-${d.showAll ? 'up' : 'down'}"></i>${d.showAll ? '收起' : `查看全部（${recent.length}）`}</span>` : '';
  const entries = d.data.usage ?? [];
  const usageTot = entries.reduce((a, u) => a + usageIn(u) + (u.output_tokens ?? 0), 0);
  // （樣稿 uxDashboardV2）：大標＋日期件數；左三塊 要你處理／最近完成／Workflow 提議，右三塊 接下來／系統通知／用量（用量與通知位置不改，驗收第 9 條）
  const now = new Date();
  const sub = `${now.getMonth() + 1} 月 ${now.getDate()} 日，星期${'日一二三四五六'[now.getDay()]}・${todoCount ? `有 ${todoCount} 件事情需要你處理。` : '目前沒有待處理事項。'}`;
  const head = (title, right = '') => `<div class="section-head"><h2>${title}</h2>${right}</div>`;
  return `<div class="dashpage">
    ${pageHeadHtml('工作，逐件有進展。', sub, '<button class="btn" data-act="new-flow">＋ 建立新 Workflow</button>')}
    <div class="homegrid">
    <section class="homemain">
      <section class="panel panel-wait">
        ${head('要你處理', `<span class="chip${todoCount ? ' wait' : ''}">${todoCount} 件</span>`)}
        <div class="crlist">${todoRows || '<div class="railempty">現在沒有等你的事</div>'}</div>
      </section>
      <section class="panel panel-done">
        ${head('最近完成', `<span class="headright"><span class="chip">${recent.length} 次</span>${showAll}</span>`)}${cards}
      </section>
      <section class="panel panel-blue">
        ${head('Workflow 提議')}${proposalRowsHtml()}
      </section>
    </section>
    <aside class="homeaside">
      <section class="panel asideblock">
        ${head('接下來', '<button class="btn sm2 btn-ghost" data-act="open-calendar">查看</button>')}${upcomingHtml(d)}
      </section>
      <section class="panel asideblock">
        ${head('系統通知', state.notices.unread.length ? `<span class="chip bad">${state.notices.unread.length}</span>` : '')}
        <div class="crlist">${noticeSectionHtml()}</div>
      </section>
      <section class="panel asideblock">
        ${head('用量', `<span class="chip">近 ${d.data.usage_days ?? 30} 天</span>`)}
        ${usageChartHtml(entries)}
        ${entries.length ? `<div class="usagetot"><b>${fmtInt(usageTot)}</b> tokens・${entries.length} 次呼叫</div>` : '<div class="railempty">還沒有用量紀錄</div>'}
        <span class="pbtn" data-act="dash-usage-open"><i class="ph ph-list-numbers"></i>用量明細 →</span>
      </section>
    </aside>
    </div>
    ${usageModalHtml(d)}
  </div>`;
}

// ---------- 行事曆：月視圖＋待辦/通知＋單次抽屜＋浮窗 ----------
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
    api('GET', '/api/settings').catch(() => null), // （M5b）：新增排程視窗的初值讀設定的 exec；讀不到就用程式缺省
  ]);
  c.data = data;
  c.scheds = scheds;
  c.exec = cfg?.exec ?? null;
  applyNotices(notices);
}

// 桌面通知：授權一次；新的未讀通知彈桌面
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
  state.calMore = false;
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
      if (!isTyping()) render();
    } catch (e) { pollFailed('行事曆', e); }
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

// （樣稿 uxCalendar＋驗收第 10 條）：週日開頭、依月份 4／5／6 週的一整張月曆；Google 更新收「⋯」，快照時間／失敗句常駐在月份列；
// 圖例在月曆下方；排程清單白卡（名稱・頻率・下次）＋「管理」開既有浮窗；頁底「沒開著不會跑」提醒。整頁可捲（原固定高度退場）
function calendarHtml() {
  const c = state.calendar;
  const [y, m] = c.month.split('-').map(Number);
  const moreOpen = !!state.calMore;
  const actions = `<button class="btn btn-primary" data-act="cal-add-sched">＋ 新增排程</button><span class="calmore-wrap"><button type="button" class="btn iconb" data-act="cal-more" title="更多" aria-label="更多動作" aria-haspopup="menu" aria-expanded="${moreOpen}"><i class="ph ph-dots-three"></i></button>${moreOpen ? '<div class="calmore" role="menu"><button type="button" role="menuitem" data-act="cal-refresh"><i class="ph ph-arrows-clockwise"></i>重新整理 Google 快照</button></div>' : ''}</span>`;
  const head = pageHeadHtml('行事曆', '工作排程與 Google 唯讀快照，一眼看清安排。', actions);
  if (!c.data) return `<div class="calpage">${head}<div class="skel" style="height:200px"></div></div>`;
  const snap = c.data.snapshot;
  const failWhy = c.snapErr ?? (snap && snap.status !== 'ok' ? (snap.reason ?? '原因不明') : null);
  const snapNote = failWhy != null ? `<span class="snapnote err" data-snap="failed">Google 快照抓不到：${esc(failWhy)}（剝繭自己的排程照常）</span>`
    : snap ? `<span class="snapnote" data-snap="ok">Google 快照：${esc(new Date(snap.fetched_at).toLocaleString('zh-TW', { hour12: false }))}</span>`
      : '<span class="snapnote" data-snap="none">Google 快照：還沒抓過</span>';
  const byDate = {};
  for (const e of c.data.events) (byDate[e.date] ??= []).push(e);
  const offset = new Date(y, m - 1, 1).getDay(); // 週日＝0
  const total = Math.ceil((offset + new Date(y, m, 0).getDate()) / 7) * 7;
  let cells = '';
  for (let i = 0; i < total; i++) {
    const d = new Date(y, m - 1, i - offset + 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cls = ['mcell', d.getMonth() !== m - 1 ? 'dim' : '', key === c.data.today ? 'today' : ''].filter(Boolean).join(' ');
    cells += `<div class="${cls}" data-date="${key}"><span class="d">${d.getDate()}</span>${(byDate[key] ?? []).map(calEvChip).join('')}</div>`;
  }
  const scheds = c.scheds ?? [];
  const nextOf = (s) => {
    const n = c.data.events.filter((e) => e.sid === s.id && e.date >= c.data.today && !['skipped', 'missed'].includes(e.kind)).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))[0];
    if (s.enabled === false) return '已暫停';
    return n ? `下次 ${Number(n.date.slice(5, 7))}/${Number(n.date.slice(8))} ${n.time}` : '這個月沒有場次'; // 只看本月事件（排程 API 沒有下次時間）
  };
  const rows = scheds.map((s) => `<div class="schedrow"><b>${esc(s.name ?? s.workflow_id)}</b><span>${esc(schedFreqText(s))}</span><span class="next">${esc(nextOf(s))}</span></div>`).join('');
  return `<div class="calpage">${head}
    <div class="caltools"><h2><span class="calmonthwrap"><button type="button" class="calmonth" data-act="cal-pick" aria-haspopup="dialog" aria-expanded="${state.calPicker ? 'true' : 'false'}" title="點一下快速跳到別的年月">${y} 年 ${m} 月<i class="ph ph-caret-down"></i></button>${calPickerHtml()}</span></h2>
      <div class="calnav"><button class="btn" data-act="cal-prev" aria-label="上個月">←</button><button class="btn" data-act="cal-today">今天</button><button class="btn" data-act="cal-next" aria-label="下個月">→</button></div>
      ${snapNote}</div>
    <div class="mdays">${['日', '一', '二', '三', '四', '五', '六'].map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="mgrid">${cells}</div>
    <div class="callegend">
      <span><b style="background:var(--ink-300)"></b>AI 自動</span><span><b style="background:#7088c8"></b>你出面</span>
      <span><b style="background:#c9cfdb"></b>Google 快照（唯讀）</span><span><b style="background:var(--amber)"></b>補跑</span>
      <span><b style="background:var(--red)"></b>錯過</span><span><b class="dash"></b>已跳過</span>
      <span class="hint">拖拉事件＝改那一次的時間｜滑過按垃圾桶＝取消該次</span>
    </div>
    <section class="panel schedlist"><div class="section-head"><h2>排程清單（${scheds.length}）</h2><button class="btn" data-act="cal-manage">管理</button></div>
      ${rows || '<p class="note">還沒有任何排程</p>'}</section>
    <div class="calfoot">
      <span>剝繭沒開著時排程不會跑；錯過的會在下次打開時問你要不要補。</span>
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
    <h3 style="margin:6px 0">${esc(sched.name)}${hint('改這次時間＝直接在行事曆上把它拖到別格；取消這一次＝滑過事件按垃圾桶。')}</h3><div class="sub">${esc(d.occ ? d.occ.replace('T', ' ') : '')}${sched.enabled === false ? '・<b style="color:var(--amber-text)">已暫停</b>' : ''}</div>
    <div class="frow2"><span class="lb2">提前提醒</span><span class="rchips">${chips}<button class="raddbtn" data-act="cal-lead-add">＋ 加一次提醒</button></span></div>
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
      <div class="cvdhead"><b style="font-size:15px">排程清單${hint('所有排程都在這裡——包含已暫停、過期、或本月沒有場次的。月曆上看不到的，也能從這裡進設定。')}</b>
        <span class="btn btn-ghost iconb" data-act="smgr-close" style="margin-left:auto"><i class="ph ph-x"></i></span></div>
      ${rows || '<div class="railempty">還沒有任何排程</div>'}
      <div class="saverow"><button class="btn" data-act="smgr-close">關閉</button></div>
    </div></div>`;
  }
  if (state.stepModal) {
    const n = (state.calDrawerDef?.nodes ?? []).find((x) => x.id === state.stepModal.nodeId);
    if (n) {
      // 表單暫存：第一次打開才從步驟初始化，之後每個欄位一改就寫進 form，calendarPoll 重繪照 form 還原
      const f = (state.stepModal.form ??= { instruction: n.instruction ?? '', review: n.review_focus ?? '', tier: n.model_tier ?? '', retry: n.retry === undefined ? '' : String(n.retry) });
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
          <option value="" ${f.retry === '' ? 'selected' : ''}>照設定</option><option value="0" ${f.retry === '0' ? 'selected' : ''}>不重試</option><option value="1" ${f.retry === '1' ? 'selected' : ''}>1 次</option><option value="2" ${f.retry === '2' ? 'selected' : ''}>2 次</option></select></div>
        <div class="saverow"><button class="btn" data-act="sm-close">關閉</button><button class="btn btn-primary" data-act="sm-save">儲存</button></div>
      </div></div>`;
    }
  }
  if (state.schedModal) {
    const m = state.schedModal;
    const sched = m.sid ? (state.calendar?.scheds ?? []).find((s) => s.id === m.sid) : null;
    // 表單暫存：form 是唯一真相——第一次打開才從排程既有值／預設值初始化，之後每個欄位 input/change 即寫入，
    // calendarPoll 的重繪照 form 還原，慢慢填也不會被打回
    const f = (m.form ??= {
      wf: sched?.workflow_id ?? (state.workflows[0] ? `${state.workflows[0].category}/${state.workflows[0].id}` : ''),
      freq: sched?.freq ?? 'weekly',
      weekday: String(sched?.weekday ?? 1),
      day: String(sched?.day ?? 1),
      time: sched?.time ?? '08:00',
      at: sched?.at ?? '',
      // 新增的初值讀設定→執行與排程的預設；編輯讀那條排程自己的
      lead: sched ? (typeof (sched.remind_leads ?? [])[0] === 'string' ? sched.remind_leads[0] : '') : execLead0(),
      makeup: sched ? !!sched.auto_makeup : state.calendar?.exec?.auto_makeup === true,
      enabled: sched?.enabled !== false,
    });
    const execMore = !sched && (state.calendar?.exec?.remind_leads ?? []).length > 1 ? (state.calendar.exec.remind_leads.length - 1) : 0;
    const wfOptions = state.workflows.map((w) => {
      const v = `${w.category}/${w.id}`;
      return `<option value="${esc(v)}" ${f.wf === v ? 'selected' : ''}>${esc(w.name)}（${esc(catLabel(w.category))}）</option>`;
    }).join('');
    // 頻率決定哪些欄位露出：每週=星期、每月=幾號、每天=只有時刻、單次=只有單次時刻
    const show = { weekday: f.freq === 'weekly', day: f.freq === 'monthly', time: f.freq !== 'once', at: f.freq === 'once' };
    html += `<div class="modalback" data-act="sc-back"><div class="modal">
      <div class="cvdhead"><b style="font-size:15px">${sched ? '整條排程設定' : '新增排程'}</b>
        <span class="btn btn-ghost iconb" data-act="sc-close" style="margin-left:auto"><i class="ph ph-x"></i></span></div>
      <div class="frow2"><span class="lb2">Workflow</span><select id="sc-wf" class="moveselect" ${sched ? 'disabled' : ''}>${wfOptions}</select></div>
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

// ---------- 群組圈分類頁：側欄分類標題點開——「分類守則」文字框＋拆好的條＋分類共用幾張習慣卡 ----------
// 離開分類頁的唯一出口（同 closeDash／closeCalendar）：任何切去別的畫面的動作都要走這裡
function closeCategory() {
  if (!state.categoryPage) return;
  clearTimeout(state.categoryPage.msgTimer);
  state.categoryPage = null;
  state.sharedUpload = null;
  state.addingCategory = false; // 離開組織頁收起「新增部門」表單
  delete state.keep[keepKey('group-text')];
}
const sharedPath = (scope) => `/api/shared/${encodeURIComponent(scope)}/files`;

async function loadCategoryPage() {
  const cp = state.categoryPage;
  if (!cp) return;
  // 群組圈＋習慣卡（cp.data／cp.err）與共用檔（cp.shared／cp.sharedErr）各自容錯——一方讀不到不蓋另一方
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

// ---------- （M2）：首次三題介紹、一行通知 ----------
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
    <div class="sub">答了直接成三張「認識卡」，之後每次拆 Workflow、每一步指示都帶著。之後在設定的記憶頁隨時可以改、可以刪，不會再問你一次。</div>
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
  return `<div class="card proposal"><b>${lead}</b><span class="sub" style="margin:0"> 它也會想想怎麼學起來——之後打開這個 Workflow 就會看到提議。${n && n.kind === 'card' ? '不想記的話，頁面最上面那一行按「不要記」。' : ''}</span></div>`;
}

// ---------- 公司頁／部門頁的共用檔兩區——規範（每步都帶）／參考（勾了才帶）；每檔一列 檔名・字數（二進位印 KB）・時間・刪除 ----------
// 字數：規範與 md／txt 參考有 chars；docx／xlsx 等二進位參考 chars 為 null → 只印大小
// （樣稿 uxOrgFiles）：每區一張 .panel.org-files——section-head h2＋上傳、灰字「每一步都帶・已 N／8,000 字」｜「勾選才帶」、每檔 .file 列＋查看b）＋刪除
const sharedWhen = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const sharedSizeText = (f) => (f.chars != null ? `${fmtInt(f.chars)} 字` : `${Math.max(1, Math.ceil((f.bytes ?? 0) / 1024))} KB`);
function sharedSectionHtml(cp, kind) {
  const rule = kind === 'rule';
  const sh = cp.shared;
  const list = sh ? (rule ? sh.rules : sh.refs) ?? [] : null;
  const rows = (list ?? []).map((f) => `<div class="file"><div class="grow"><h3><i class="ph ${rule ? 'ph-file-text' : 'ph-file'}"></i>${esc(f.name)}</h3><small>${sharedSizeText(f)}・${esc(sharedWhen(f.uploaded_at))}</small></div>
      <button class="btn sm2" data-act="shared-view" data-kind="${kind}" data-name="${esc(f.name)}">查看</button><button class="btn sm2" data-act="shared-del" data-kind="${kind}" data-name="${esc(f.name)}" title="刪掉這份（不進垃圾桶）">刪除</button></div>`).join('');
  // 共用檔那支讀不到：只有這兩區印一句＋重試（走 reload-category 整頁重讀），部門守則卡照常
  const body = cp.sharedErr ? `<p class="note err" role="alert">共用檔讀不到：${esc(cp.sharedErr)}</p><button class="btn sm2" data-act="reload-category"><i class="ph ph-arrow-clockwise"></i>重試</button>`
    : !list ? '<p class="note">讀取中⋯</p>'
    : rows || `<p class="note">${rule ? '還沒有規範。放進來的內容，AI 每一步都照著。' : '還沒有參考。步驟裡勾了才給 AI。'}</p>`;
  return `<section class="panel org-files sharedsec" data-shared-kind="${kind}"><div class="section-head"><h2>${rule ? '規範' : '參考'}</h2><button class="btn sm2" data-act="shared-upload" data-kind="${kind}"><i class="ph ph-upload-simple"></i>上傳</button></div>
    <p class="note">${rule ? `每一步都帶・已 ${fmtInt(sh?.rule_chars ?? 0)}／${fmtInt(sh?.limits?.per_layer ?? 8000)} 字` : '勾選才帶'}</p>
    ${cp.uploadErr?.kind === kind ? `<p class="note err" role="alert">${esc(cp.uploadErr.text)}</p>` : ''}
    ${body}
    ${cp.msg?.kind === kind ? `<p class="note ok">${esc(cp.msg.text)}</p>` : ''}
  </section>`;
}
// 部門頁最下面：該部門的 Workflow 卡（與 Workflow 庫同一張卡；樣稿 h2.section-title「部門流程」＋.libgrid）
function sharedFlowsHtml(category) {
  const list = (state.workflows ?? []).filter((w) => w.category === category);
  return `<h2 class="section-title">分類 Workflow</h2>
    <div class="libgrid">${flowCardsHtml(list) || '<p class="note" style="margin:0">這個分類還沒有 Workflow。</p>'}</div>`;
}

// （樣稿 uxOrgPage）：組織頁＝麵包屑「工作空間」→ page-head（修改名稱、＋ 新增部門）→ 部門捷徑 → 兩張檔案卡；
// 部門頁＝麵包屑「工作空間 › 組織名」→ page-head（修改名稱）→ 整寬守則卡（拆好的規矩收在卡內 <details>，驗收第 7 條）→ 兩張檔案卡 → 部門 Workflow
function categoryPageHtml() {
  const cp = state.categoryPage;
  const company = cp.category === '_company'; // 公司頁＝分類頁特例（標題＝公司名，沒有守則卡、沒有 Workflow 區）
  // 「修改名稱」（公司→設定的 company_name；部門→PUT /api/categories/:name）；「未分類」不能改名，沒有鈕
  const renameBtn = company
    ? '<button class="btn" data-act="rename-open" data-type="company" title="修改名稱"><i class="ph ph-pencil-simple"></i>修改名稱</button>'
    : cp.category === '未分類' ? '' : `<button class="btn" data-act="rename-open" data-type="category" data-cat="${esc(cp.category)}" title="修改名稱"><i class="ph ph-pencil-simple"></i>修改名稱</button>`;
  // W11：有打開中的工作區（已存 Workflow、草稿或聊天）才給「回工作區」
  const back = state.wf || state.chat?.draft || state.chat?.messages?.length ? '<button class="btn" data-act="close-category"><i class="ph ph-caret-left"></i>回工作區</button>' : '';
  const sharedGrid = `<div class="orggrid">${sharedSectionHtml(cp, 'rule')}${sharedSectionHtml(cp, 'ref')}</div>`;
  if (company) {
    // 驗收第 2 條：「新增部門」放組織頁（原側欄行內表單搬來，confirm-category 語意不變）
    const adder = state.addingCategory ? `<div class="newdeptform"><input id="new-category" class="notein" data-keep value="${esc(kept('new-category') ?? '')}" placeholder="分類名稱" aria-label="新分類名稱" autocomplete="off">
      <button class="btn btn-primary" data-act="confirm-category">建立</button><button class="btn btn-ghost" data-act="cancel-category">取消</button></div>` : '';
    const pills = (state.categories ?? []).map((c) => `<button class="btn" data-act="open-category" data-cat="${esc(c)}">${esc(catLabel(c))} →</button>`).join('');
    return `<div class="catpage" data-company-page><nav class="breadcrumb">工作空間</nav>${pageHeadHtml(companyName(), '組織規範會帶進每一條 Workflow；參考按需選用。', `${renameBtn}<button class="btn" data-act="add-category">＋ 新增分類</button>${back}`)}
      ${adder}${pills ? `<div class="pillnav">${pills}</div>` : ''}${sharedGrid}</div>`;
  }
  const head = `<nav class="breadcrumb">工作空間 › <span data-act="open-company" tabindex="0" role="button">${esc(companyName())}</span></nav>${pageHeadHtml(catLabel(cp.category), '分類守則與資料，讓同一團隊的工作保持一致。', renameBtn + back)}`;
  // 群組圈讀不到：守則卡換錯誤卡，檔案卡與 Workflow 區照常
  if (cp.err) {
    return `<div class="catpage">${head}<section class="panel guidelines err"><h3><i class="ph-fill ph-warning"></i> 這個分類的規矩讀不到</h3>
      <p class="note">${esc(cp.err)}</p>
      <div class="btns"><button class="btn btn-secondary" data-act="reload-category">再讀一次</button></div></section>
      ${sharedGrid}
      ${sharedFlowsHtml(cp.category)}
    </div>`;
  }
  if (!cp.data) return `<div class="catpage">${head}<div class="empty-c"><div class="ic"><i class="ph ph-circle-notch"></i></div><h3>讀取中⋯</h3></div></div>`;
  const rules = cp.data.rules.filter((r) => r.status === 'active');
  const ruleRows = rules.map((r) => (r.field
    ? `<li><span class="chip gfield">${esc(r.field)}</span><span class="gval">${esc(r.value)}</span></li>`
    : `<li><i class="ph ph-dot-outline"></i><span>${esc(r.text)}</span></li>`)).join('');
  const text = kept('group-text') ?? cp.data.text ?? '';
  return `<div class="catpage">${head}
      <section class="panel guidelines"><h3>分類守則</h3><p class="note">這個分類的每一步都會帶入。</p>
        <textarea id="group-text" class="autogrow" data-keep aria-label="分類守則" placeholder="例：&#10;語氣：輕鬆&#10;不提競品">${esc(text)}</textarea>
        <div class="btns" style="align-items:center">
          <button class="btn" data-act="save-group" ${cp.saving ? 'disabled' : ''}><i class="ph ph-check"></i>${cp.saving ? '存檔中⋯' : '儲存'}</button>
          ${cp.saveErr ? `<span class="note" style="margin:0;color:var(--red-text)">${esc(cp.saveErr)}</span>` : ''}
        </div>
        <p class="note">一行一條；有名字的欄位寫「欄位：值」（像「語氣：輕鬆」）。${cp.data.updated_at ? `上次存：${esc(new Date(cp.data.updated_at).toLocaleString('zh-TW'))}。` : '還沒存過。'}</p>
        <details class="rulefold"><summary>拆好的規矩・${rules.length} 條</summary>
          ${ruleRows ? `<ul class="grules">${ruleRows}</ul>` : '<p class="note" style="margin:0">還沒有。上面寫幾條存起來，這裡會拆成一條一條。</p>'}
          <p class="note"><i class="ph ph-cards"></i> 這個分類共用 ${cp.cards.length} 張習慣卡</p>
        </details>
      </section>
      ${sharedGrid}
      ${sharedFlowsHtml(cp.category)}
    </div>`;
}

// ---------- （M5a）：設定頁——整頁模式（同儀表板／行事曆） ----------
// （樣稿 uxSettings）：五組兩行選單（名稱＋說明）；素材庫組退場（驗收第 13 條，搬到側欄「共用素材」整頁）；
// 只有「個人與記憶」留四個分頁，其餘各組改同一張白卡內分段（h3），內容一項不少
const SET_GROUPS = [['個人與記憶', '偏好、身分與資訊範圍'], ['Workflow 預設', '只影響新建的 Workflow'], ['連線', 'AI 與行事曆快照'], ['執行與排程', '啟動、提醒與補跑'], ['資料管理', '備份、垃圾桶與版本']];
const SET_TABS = { 個人與記憶: ['關於你', '身分', '記憶總覽', '欄位詞典'] };
const SET_LEAD = {
  個人與記憶: '這裡的每一張卡，都會跟著每一次執行送給 AI。', 連線: '剝繭不自帶 AI，掛在你自己的 Claude 上；行事曆用你自己的 Google 授權。',
  'Workflow 預設': '只管「新建的 Workflow 長什麼樣」。每條 Workflow 自己的開關留在 Workflow 頁。', 執行與排程: '剝繭什麼時候在、錯過了怎麼辦、AI 工人能做什麼。', 資料管理: '資料在哪、備份、清理。',
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
async function openSettings(group = '個人與記憶', tab = null) {
  clearTimeout(state.pollTimer);
  closeCalendar();
  closeDash();
  closeCategory();
  closeLibrary();
  closeAssets();
  stashWorkspace(); //
  state.run = null;
  state.showTrash = false;
  state.corrupt = null;
  state.importPreview = null;
  state.drawerOpen = false;
  state.settings = { group, tab: tab ? { [group]: tab } : {}, data: null, err: null, idEdit: null, merge: null, confirm: null, msg: null, busy: null };
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
  // 第二行平常是說明；記憶有例外、Claude 連不上時改成琥珀字提醒
  const warn = {
    個人與記憶: d && !d.summary.paused && exN ? `${exN} 條例外要看` : '',
    連線: state.claude === false ? 'Claude 連不上' : '',
  };
  const nav = SET_GROUPS.map(([g, desc]) => `<button type="button" class="it${s.group === g ? ' on' : ''}" data-act="set-group" data-g="${esc(g)}"${s.group === g ? ' aria-current="page"' : ''}>${esc(g)}<small${warn[g] ? ' class="warn"' : ''}>${esc(warn[g] || desc)}</small></button>`).join('');
  let body;
  if (s.err) {
    body = `<div class="card err"><h3><i class="ph-fill ph-warning"></i> 設定讀不到</h3><p class="sub" style="margin:8px 0">${esc(s.err)}</p>
      <div class="btns"><button class="btn btn-secondary" data-act="set-reload">再讀一次</button></div></div>`;
  } else if (!d) body = '<div class="skel" style="height:200px"></div>';
  else if (s.group === '個人與記憶') body = setMemoryHtml(d);
  else if (s.group === '連線') body = setConnHtml(d);
  else if (s.group === 'Workflow 預設') body = setDefaultsHtml(d);
  else if (s.group === '執行與排程') body = setExecHtml(d);
  else body = setDataHtml(d);
  return `${pageHeadHtml('設定', '個人偏好、Workflow 預設與系統執行，各有明確範圍。')}
    <div class="setwrap" data-settings><nav class="setnav" aria-label="設定項目">${nav}</nav><section class="setbody" data-group="${esc(s.group)}"><h2>${esc(s.group)}${hint(SET_LEAD[s.group] ?? '')}</h2>${body}</section></div>`;
}
// 組內分段小標（原子分頁改同一張卡分段）
const setSec = (t) => `<h3>${esc(t)}</h3>`;
const setRow = (l, d, c, stack = false) => `<div class="row${stack ? ' stack' : ''}"><div class="l">${l}</div>${d ? `<div class="d">${d}</div>` : ''}<div class="c">${c}</div></div>`;
const setSw = (on, act, extra = '') => `<span class="sw ${on ? 'on' : ''}" data-act="${act}" ${extra} role="switch" aria-checked="${on}">${on ? '開' : '關'}<i></i></span>`;
const setLater = (l, dsc) => setRow(`${l}${hint(dsc)}`, '', '<span class="chip">下一輪</span>'); // 續票項：「下一輪」膠囊已經說了還沒做，現在是什麼行為收進問號
// 設定頁一句結果／錯誤（快照、備份、垃圾桶、清空）：state.settings.msg={key,text,err}，換組／換子分頁就清
const setMsgHtml = (key) => { const m = state.settings?.msg; return m?.key === key ? `<div class="setmsg ${m.err ? 'err' : ''}" data-setmsg="${key}"><i class="ph ${m.err ? 'ph-warning-circle' : 'ph-check-circle'}"></i>${esc(m.text)}</div>` : ''; };

// ---- 連線：Claude／Google 行事曆（M5b；連接器與金鑰 T8 搬到記憶）----
// Claude 狀態＝側欄底部同一份（state.claude：GET /api/health 只看得到 Claude 指令在不在，看不出登入過期）；「重新連線」＝既有 refreshHealth。
// Google 快照時間讀 GET /api/calendar 的 snapshot；「重新整理快照」＝既有 POST /api/calendar/refresh（行事曆頁那顆同一支）
function setConnHtml(d) {
  const snap = d.snapshot;
  const ok = snap?.status === 'ok';
  const desc = !snap ? '還沒抓過快照：行事曆上只有剝繭自己的排程。' : ok ? `上次快照：${esc(memAt(snap.fetched_at))}。按「重新整理快照」才抓，不即時。` : `上次抓不到${snap.reason ? `：${esc(snap.reason)}` : ''}。剝繭自己的排程不受影響。`;
  const on = state.claude === true;
  return `${setSec('Claude')}<div class="group">
      ${setRow('狀態', on ? '找得到 Claude 指令。用量在儀表板。' : '找不到 Claude 指令：Claude Code 沒裝，或不在路徑上。你的 Workflow 庫都在，不會不見。', `<span class="chip ${on ? '' : 'red'}" data-claude="${on ? 'on' : 'off'}"><i class="${on ? 'ph-fill ph-plugs-connected' : 'ph ph-plugs'}"></i>${on ? '已連上' : '連不上'}</span><button class="btn sm2" data-act="reconnect"><i class="ph ph-arrows-clockwise"></i>重新連線</button>`)}
      ${setRow(`登入過期怎麼辦${hint('這裡只看得到 Claude 指令在不在，看不出登入有沒有過期。步驟一直失敗、訊息說登入過期時：開終端機跑「claude」，照它的指示登入，回來按那一步的「重試」。')}`, '', '')}
      ${setRow(`模型檔位對照${hint('步驟抽屜與「Workflow 預設」選的檔位，各對到哪個模型。')}`, '', '<span class="sub" style="margin:0">快而省 Haiku・均衡 Sonnet・深而慢 Opus</span>')}</div>
    ${setSec('Google 行事曆')}<div class="group">
      ${setRow('Google 快照', desc, `<span class="chip" data-snap="${!snap ? 'none' : ok ? 'ok' : 'failed'}">${!snap ? '還沒抓過' : ok ? '有快照' : '抓不到'}</span><button class="btn sm2" data-act="set-cal-refresh" ${state.settings.busy ? 'disabled' : ''}><i class="ph ph-arrows-clockwise"></i>${state.settings.busy === 'cal' ? '抓取中⋯' : '重新整理快照'}</button>`)}
      ${setRow(`授權${hint('行事曆走你 Claude 裡的 Google 行事曆連接器；剝繭不另外存授權，也拿不到你的密碼。要解除，在 Claude 那邊解除。')}`, '', '')}</div>${setMsgHtml('cal')}
    ${setSec('連接器與金鑰')}${setKeysHtml()}`;
}

// ---- 新流程的預設：權限與查核／AI 步驟／停點（M5b）——讀寫 settings.defaults（applyDefaults 只在新建時吃它）；每個開關即 PUT ----
function setDefaultsHtml(d) {
  const df = d.cfg.defaults ?? {};
  const seg = (k, cur, opts) => `<div class="seg sm" data-def="${k}">${opts.map(([v, t]) => `<span class="${String(cur) === v ? 'on' : ''}" data-act="set-def-val" data-k="${k}" data-v="${v}">${t}</span>`).join('')}</div>`;
  const fl = df.supervisor_flags ?? {};
  const aiSec = `${setSec('AI 步驟')}<div class="group"><h5>模型與重試</h5>
      ${setRow(`模型檔位${hint('步驟沒自己選檔位時用哪一檔；「不設」＝交給 Claude 的預設。')}`, '', seg('model_tier', df.model_tier ?? 'null', [['null', '不設'], ['fast', '快而省'], ['balanced', '均衡'], ['deep', '深而慢']]))}
      ${setRow(`出錯自動重試${hint('步驟沒自己設時，失敗了自動再試幾次；「不設」＝不重試。')}`, '', seg('retry', df.retry ?? 'null', [['null', '不設'], ['0', '0 次'], ['1', '1 次'], ['2', '2 次']]))}
      ${setLater('產出語言', '現在跟指示的語言一樣。')}</div>`;
  // 拆之前先出成品卡讓你確認（預設開）；關掉＝一句話直接出草稿，清單頂端印拆解器自己定的長相對照
  const stopSec = `${setSec('停點')}<div class="group">${setRow(`拆之前先確認成品長相${hint('關掉＝一句話直接出草稿；等分類拆法偏好學會了再關比較保險。')}`, '', setSw(d.cfg.compose?.confirm_shape !== false, 'set-compose-sw', 'data-k="confirm_shape"'))}</div>
    <div class="group">${setRow('停點', '哪幾步要停下來等你，在每個步驟自己的設定裡改，不在這一頁。', '')}${setLater('停著沒處理多久提醒', '停點提醒間隔下一輪。')}</div>`;
  const permSec = `${setSec('權限與查核')}<div class="group"><h5>產出檔案的權限</h5>
      ${setRow(`親手建的 Workflow${hint('預設允不允許 AI 工人在該趟的產出資料夾寫檔（Word、Excel、簡報）與執行程式；Workflow 頁可以個別改。')}`, '', setSw(df.permissions_files !== false, 'set-def-sw', 'data-k="permissions_files"'))}
      ${setRow(`匯入的 Workflow${hint('一律不允許，不是設定：別人 Workflow 裡藏的指示不可信，不能讓它在你電腦上寫檔。要開，進那條 Workflow 的頁面自己打開。')}`, '', '<span class="chip">固定關</span>')}</div>
    <div class="group"><h5>交貨查核</h5>
      ${setRow(`每步都查${hint('每個 AI 步驟做完先對照原始資料與你的要求查一次；攔到會自動重做一次，還錯才停下問你。Workflow 頁可以個別關。')}`, '', setSw(df.check_enabled !== false, 'set-def-sw', 'data-k="check_enabled"'))}
      ${setRow(`數字對原始資料${hint('「看 Workflow」＝這條 Workflow 有必填的資料欄位才對原始資料；固定開／固定關＝不看 Workflow。')}`, '', seg('check_facts', df.check_facts ?? 'auto', [['auto', '看 Workflow'], ['on', '固定開'], ['off', '固定關']]))}</div>
    <div class="group"><h5>監工</h5>
      ${setRow(`監工：開場備註、每步交接、跑完紀錄${hint('新 Workflow 預設開不開；Workflow 頁可以個別關。')}`, '', setSw(df.supervisor_enabled !== false, 'set-def-sw', 'data-k="supervisor_enabled"'))}
      ${setRow(`每步「監工可以」的預設${hint('新 Workflow 每個 AI 步驟預設打開哪幾個；步驟抽屜可以個別改。')}`, '', `<div class="pills">${SUP_CHK.map(([, k, t]) => `<span class="pill ${fl[k] ? 'on' : ''}" data-act="set-def-flag" data-k="${k}">${t}</span>`).join('')}</div>`)}</div>`;
  // 這行跟 h2 旁邊 SET_LEAD[「Workflow 預設」] 講的是同一件事（只差幾個字）——畫面上只留一份
  return `${permSec}${aiSec}${stopSec}`;
}

// ---- 執行與排程：常駐／排程／AI 工人（M5b）——開機自啟從行事曆頁底搬來（GET/POST /api/autostart）；其餘讀寫 settings.exec ----
const LEAD_TXT = { '10m': '10 分鐘前', '30m': '30 分鐘前', '1h': '1 小時前', '2h': '2 小時前', '3h': '3 小時前', '6h': '6 小時前', '12h': '12 小時前', '1d': '1 天前', '2d': '2 天前' }; // 與後端 LEAD_MS 九檔同一份
const LEAD_ORDER = Object.keys(LEAD_TXT);
// 設定裡提前提醒預設的首檔（新增排程視窗的初值；沒有就「先不提醒」）
const execLead0 = () => { const l = state.calendar?.exec?.remind_leads ?? []; return typeof l[0] === 'string' ? l[0] : ''; };
function setExecHtml(d) {
  const ex = d.cfg.exec ?? {};
  const leads = Array.isArray(ex.remind_leads) ? ex.remind_leads : [];
  const a = d.autostart;
  const on = a?.enabled === true;
  const unsupported = !a || a.supported === false;
  return `${setSec('常駐')}<div class="group">
      ${setRow('開機自動啟動', unsupported ? '這個平台不支援：請自行把「node src/server.js」加進開機項目。' : on ? '電腦一開，剝繭就在背景待命；排程到點會跑。' : '現在是手動：你打開它才會跑，關掉就停。排程到點時如果沒開著，會記成「錯過」，下次打開時問你要不要補。', unsupported ? '<span class="chip">這個平台不支援</span>' : setSw(on, 'autostart-toggle', 'data-autostart'))}
      ${setLater('同時最多跑幾趟', '現在到點全發、不限流。')}</div>
    ${setSec('排程')}<div class="group">
      ${setRow(`錯過時${hint('剝繭沒開著、排程到點沒跑成：新排程預設問你補不補，還是直接補跑。每條排程建立後可以自己改；已有的排程不受影響。')}`, '', `<div class="seg sm" data-exec="auto_makeup"><span class="${ex.auto_makeup ? '' : 'on'}" data-act="set-exec-val" data-k="auto_makeup" data-v="false">先詢問</span><span class="${ex.auto_makeup ? 'on' : ''}" data-act="set-exec-val" data-k="auto_makeup" data-v="true">自動補</span></div>`)}
      ${setRow(`提醒預設時間點${hint('新排程預設提早幾次提醒（可多選）；每條排程建立後可以自己改。')}`, '', `<div class="pills" data-exec="remind_leads">${LEAD_ORDER.map((k) => `<span class="pill ${leads.includes(k) ? 'on' : ''}" data-act="set-exec-lead" data-k="${k}">${LEAD_TXT[k]}</span>`).join('')}</div>`, true)}</div>
    ${setSec('AI 工人')}<div class="group">
      ${setRow('允許查網路', ex.web === false ? '關著：AI 工人每一步都不上網，只用你給的資料；監工建議開也不會開。' : '開著：步驟需要查資料時，AI 工人可以上網查。', setSw(ex.web !== false, 'set-exec-sw', 'data-k="web"'))}
      ${setRow(`連接器${hint('只有唯讀；工人環境裡沒有金鑰，呼叫由剝繭本體執行。')}`, '', '<span class="chip">輪 2</span>')}</div>`;
}

// ---- 多組織：設定→資料管理「組織」段的組織清單／新增／移出 ----
// 三道閘與後端同一份：目前組織不能移出、最後一個不能移出、還要打對名字才解鎖那顆鈕（後端一樣會擋，這裡只是別讓人白按）。
// 改名沿用上面那格「組織名稱」＝改目前組織；別的組織要改名先切過去（不為此多開一支路由）。
function orgManageHtml() {
  const list = state.orgs ?? [];
  if (!list.length) return '';
  const last = list.length <= 1;
  const row = (o) => {
    const now = o.id === state.orgId;
    const name = now ? companyName() : (o.name || '組織'); // 目前這個的名字以 state.companyName 為準（就地改名後立刻同步）
    const why = now ? '正在用的組織不能移出：先切到別的組織再回來' : last ? '至少要留一個組織，這是最後一個' : `把「${name}」移出`;
    const acts = `${now ? '<span class="chip">目前</span>' : `<button class="mini" data-act="org-go" data-id="${esc(o.id)}">切換</button>`}<button class="mini no" data-act="org-kill" data-id="${esc(o.id)}" title="${esc(why)}"${now || last ? ' disabled' : ''}>移出</button>`;
    const typed = (kept('org-kill-name') ?? '').trim();
    const ask = state.orgKill !== o.id ? '' : `<div class="orgkill">
      <p class="note">移出＝把這個組織的整個資料夾搬到 <span class="path">data/orgs-trash/</span>，<b>資料不會真的消失</b>。要救回來，把那個資料夾搬回 data/orgs/ 就好。</p>
      <p class="note">確定要移出的話，請把「<b>${esc(name)}</b>」打一次：</p>
      <input id="org-kill-name" class="notein" data-keep data-org-kill="${esc(name)}" autocomplete="off" placeholder="${esc(name)}" value="${esc(kept('org-kill-name') ?? '')}" style="margin:0;max-width:260px">
      <div class="btns"><button class="btn sm2" data-act="org-kill-cancel">取消</button><button class="btn sm2 btn-danger" id="org-kill-go" data-act="org-kill-go" data-id="${esc(o.id)}"${typed === name ? '' : ' disabled'}>移出這個組織</button></div></div>`;
    return `<div class="orgrow${now ? ' now' : ''}" data-org="${esc(o.id)}"><div class="orgmeta"><b>${esc(name)}</b><span class="syn">${o.workflows ?? 0} 條 Workflow</span></div><div class="orgacts">${acts}</div>${ask}</div>`;
  };
  const busy = state.settings?.busy === 'org';
  return `<div class="group" data-orgs><h5>全部組織・${list.length} 個${hint('每個組織一整套資料——Workflow、記憶、行事曆都各自分開，不互看。切換會重新載入畫面。')}</h5>
      <div class="orglist">${list.map(row).join('')}</div>
      <div class="orgadd"><input id="org-new-name" class="notein" data-keep maxlength="60" autocomplete="off" placeholder="新組織的名字" value="${esc(kept('org-new-name') ?? '')}" style="margin:0;max-width:260px"><button class="btn sm2" data-act="org-add"${busy ? ' disabled' : ''}><i class="ph ph-plus"></i>${busy ? '建立中⋯' : '新增組織'}</button></div>
      ${setRow('改別的組織的名字', '上面那格改的是你現在待著的這個組織；要改別的，先切過去。', '')}${setMsgHtml('org')}</div>`;
}

// ---- 資料：位置與備份／清理／關於（M5b）——位置唯讀；立即備份＋清單；垃圾桶合併表（流程＋卡各自復原）；清空記憶二次確認；版本 ----
// 還原、匯出全部、清空全部、換位置、每天自動備份＝續票（上桌
function setDataHtml(d) {
  const s = state.settings;
  const rows = [
      ...d.trash.wf.map((t) => ({ kind: 'wf', key: t.key, at: t.trashed_at, label: 'Workflow', text: t.name, extra: catLabel(t.category) })),
      ...d.trash.cards.map((t) => ({ kind: 'card', key: t.key, at: t.trashed_at, label: t.bucket === 'profile' ? '認識卡' : '習慣卡', text: t.text, extra: '' })),
    ].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
    const tr = (r) => `<tr data-trash="${esc(r.kind)}:${esc(r.key)}"><td><span class="chip">${esc(r.label)}</span></td><td><b>${esc(r.text)}</b>${r.extra ? `<span class="syn" style="margin-left:6px">${esc(r.extra)}</span>` : ''}</td><td class="syn">${esc(memAt(r.at))}</td><td class="acts"><button class="mini" data-act="set-trash-restore" data-kind="${esc(r.kind)}" data-key="${esc(r.key)}">復原</button></td></tr>`;
  const cleanSec = `${setSec('清理')}<div class="group"><h5>垃圾桶・${rows.length} 項${hint('刪掉的 Workflow 與記憶卡放 30 天，期限內都能復原；到期自動清。')}</h5>
      ${rows.length ? `<div style="overflow-x:auto"><table class="dict" data-trashtable><thead><tr><th>是什麼</th><th>名字</th><th>刪掉時間</th><th></th></tr></thead><tbody>${rows.map(tr).join('')}</tbody></table></div>` : '<div class="none">垃圾桶是空的</div>'}${setMsgHtml('trash')}</div>
    <div class="group">
      ${setRow(`清空記憶${hint('所有習慣卡與認識卡進記憶垃圾桶（30 天內可逐張復原）；欄位詞典、分類的規矩、身分、Workflow 都不動。')}`, '', '<button class="btn sm2 btn-danger" data-act="set-clear-mem-open">清空記憶</button>')}
      ${setLater('匯出全部、清空全部', '')}${setMsgHtml('clear')}</div>`;
  const aboutSec = `${setSec('關於')}<div class="group">${setRow(`剝繭 ${esc(d.cfg.version ?? '')}${hint('MIT 授權。你的資料不經過任何人的伺服器，全在你電腦和你自己的 Claude 帳號裡。')}`, '', '')}</div>`;
  const bk = [...d.backups].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    // 公司：名稱 change／Enter 即 PUT（處理在 app 的 change 監聽）；規範上限唯讀（三層 §三固定值，後端 checkRuleLimits 同一份）
  const orgSec = `${setSec('組織')}<div class="group">
      ${setRow(`組織名稱${hint('側欄最上層、麵包屑、組織頁標題跟著改；清空顯示「組織」。')}`, '', `<input class="notein" id="set-company-name" type="text" maxlength="60" placeholder="組織" value="${esc(d.cfg.company_name ?? '')}" style="margin:0;max-width:260px">`)}
      ${setRow('規範上限', '單檔 4,000 字・每層合計 8,000 字', '<span class="chip">固定</span>')}${setMsgHtml('company')}</div>
    ${orgManageHtml()}
    ${setSec('位置與備份')}<div class="group"><h5>位置</h5>
      ${setRow('資料夾', `<span class="path" data-datadir>${esc(d.cfg.data_dir ?? '')}</span>`, '<span class="chip">換位置下一輪</span>')}</div>
    <div class="group"><h5>備份</h5>
      ${setRow(`立即備份${hint('整個資料夾複製一份到同層的「資料夾名-backups」；剝繭不存金鑰，備份裡也沒有。')}`, '', `<button class="btn sm2" data-act="set-backup-now" ${s.busy ? 'disabled' : ''}><i class="ph ph-copy"></i>${s.busy === 'backup' ? '備份中⋯' : '立即備份'}</button>`)}
      ${setLater('每天自動備份、還原', '要還原，先把備份夾整個複製回資料夾位置。')}${setMsgHtml('backup')}
      <h5>備份清單・${bk.length} 份</h5>
      ${bk.length ? `<div style="overflow-x:auto"><table class="dict" data-backuptable><thead><tr><th>備份</th><th>時間</th></tr></thead><tbody>${bk.map((b) => `<tr data-backup="${esc(b.name)}"><td><b>${esc(b.name)}</b></td><td class="syn">${esc(memAt(b.at))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="none">還沒備份過</div>'}</div>`;
  return `${orgSec}${cleanSec}${aboutSec}`;
}
// 清空記憶的二次確認浮窗（放 .layout 外，同卡片浮窗）：確定才 POST /api/memory/clear；Esc、背景、取消都關
function setConfirmModalHtml() {
  const s = state.settings;
  if (!s?.confirm) return '';
  const n = s.data ? s.data.summary.counts.profile + s.data.summary.counts.habit : 0;
  return `<div class="pvback memmodal" data-act="set-clear-mem-back" data-confirm="memory"><div class="modal" role="dialog" aria-label="清空記憶">
    <div class="cvdhead" style="margin-bottom:var(--s2)"><span class="overline">清空記憶</span><button class="btn btn-ghost iconb" data-act="set-clear-mem-cancel" style="margin-left:auto" title="關閉（Esc）"><i class="ph ph-x"></i></button></div>
    <h3>把 ${n} 張記憶卡全部移到垃圾桶？</h3>
    <p class="sub" style="margin:8px 0">習慣卡與認識卡都會進記憶垃圾桶，30 天內可以在「資料管理→清理」逐張復原；欄位詞典、分類的規矩、身分、Workflow 都不動。清空之後每步指示不再附「關於你」，開跑表單也不再有習慣選項，直到你重新記。</p>
    <div class="btns"><button class="btn btn-danger" data-act="set-clear-mem-go" ${s.busy ? 'disabled' : ''}><i class="ph ph-trash"></i>${s.busy === 'clear' ? '清空中⋯' : '確定清空'}</button><button class="btn btn-ghost" data-act="set-clear-mem-cancel" ${s.busy ? 'disabled' : ''}>取消</button></div>
  </div></div>`;
}

// ---- 記憶：記憶總覽（地圖＋欄位詞典收摺）／關於你／連接器與金鑰（移植第一批 T8：三分頁改名；欄位詞典摺進總覽底部，功能不減）----
// 前端版 coversWorkflow（與後端同規則）：全部永遠涵蓋；分類只比分類；流程要分類與流程都對
const memCovers = (c, cat, wfId) => (c.scope?.level === 'all' ? true : c.scope?.level === 'category' ? c.scope.category === cat : c.scope?.category === cat && c.scope?.workflow === wfId);
const memExpired = (c) => c.expires != null && String(c.expires) < new Date().toISOString().slice(0, 10);
const memLive = (c) => c.status === 'active' && !memExpired(c);
const byCreatedAt = (a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
// （樣稿 uxSettingContent memory）：四個有框分頁鈕；身分從「關於你」拆出、欄位詞典從總覽底部收摺改成自己的分頁（內容照舊，W10）
function setMemoryHtml(d) {
  const tab = setTab('個人與記憶');
  const tabs = `<div class="settabs" role="tablist">${SET_TABS.個人與記憶.map((k) => `<button type="button" class="${tab === k ? 'on' : ''}" data-act="set-tab" data-g="個人與記憶" data-k="${esc(k)}">${esc(k)}</button>`).join('')}</div>`;
  const body = tab === '身分' ? setIdentitiesHtml(d) : tab === '記憶總覽' ? setMapHtml(d) : tab === '欄位詞典' ? setDictHtml(d) : setKnowHtml(d);
  return `${tabs}${body}`;
}
// 連接器與金鑰： 從記憶搬到「連線」分段；輪 2 才做，兩列都「尚未提供」
function setKeysHtml() {
  return `<div class="group">
      ${setRow(`連接器與金鑰${hint('AI 永遠看不到金鑰：金鑰放作業系統的認證管理員，不進剝繭的任何檔案、備份、匯出、卷宗；AI 工人拿到的是連接器的名字與它能讀什麼，呼叫由剝繭本體執行。第一版只有讀，沒有寫。')}`, '', '<span class="chip">尚未提供</span>')}
      ${setRow(`雲端硬碟、信箱${hint('接上之後，Workflow 可以讀你的雲端檔案當資料來源。')}`, '', '<span class="chip">尚未提供</span>')}</div>`;
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
        ${items ? `<ul>${items}</ul>` : '<div class="none">只帶全部 Workflow 共用的</div>'}</div>`;
    };
    return `<div class="mcat" data-mapcat="${esc(cat)}"><div class="mh"><i class="ph ph-folder"></i>${esc(catLabel(cat))}<span class="sub">規矩 ${rules.length} 條・共用 ${catHabits.length} 張習慣卡</span><span class="chip">${wfs.length} 條 Workflow</span></div>
      ${rules.length ? `<ul>${rules.map((r) => memCardLi({ ...r, bucket: 'group' }, `${cat}的規矩`, cat)).join('')}</ul>` : ''}
      ${wfs.map(flowBlock).join('') || '<div class="none">這個分類還沒有 Workflow</div>'}</div>`;
  };
  const allHabits = habits.filter((c) => c.scope?.level === 'all');
  const allBlock = `<div class="mcat" data-mapcat="*"><div class="mh"><i class="ph ph-globe-simple"></i>全部 Workflow<span class="sub">到哪都帶</span><span class="chip">${exp.length} 條認識卡・${allHabits.length} 張習慣卡</span></div>
    ${exp.length || allHabits.length ? `<ul>${exp.map((c) => memCardLi(c, '每步帶')).join('')}${allHabits.map((c) => memCardLi(c, '全部 Workflow 的選項')).join('')}</ul>` : '<div class="none">還沒有</div>'}</div>`;
  return `<p class="note" style="margin:0 0 var(--s2)" data-map-note>「每步帶 N」是不指定身分時的口徑（表達層全部＋場合對上的事實最近用過的前 ${MEM_CONTENT_TOP} 張）；指定身分的 Workflow 實際帶的會更少。</p>
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
  const introBlock = `<div class="group" data-intro><h5>介紹你自己${hint('三題，每題存成一張卡。答過之後在這裡改。')}</h5>${introCards.length ? introRows : `<div class="none">還沒介紹過</div><div class="btns" style="margin-top:8px"><button class="btn sm2" data-act="intro-open"><i class="ph ph-hand-waving"></i>介紹你自己</button></div>`}</div>`;
  const injText = paused ? '（整層暫停中）' : expLive.length ? expLive.map((c) => `· ${c.text}`).join('\n') : '（還沒有每步帶的卡：介紹自己時答第三題，或在停點註記寫「以後都⋯」）';
  return `${introBlock}<div class="group">
      ${setRow(`關於你${hint(paused ? '暫停期間每一步都不附「關於你」，卡片留著；分類的規矩與習慣選項照舊。' : '關掉＝每一步都不帶，卡片留著。交貨查核與監工本來就不帶。')}`, '', setSw(!paused, 'set-pause', 'data-paused'))}
      ${setRow(`記敏感資訊${hint('這四類預設都不記。打開之後，也只記你親口說過的——步驟產出永遠不是來源。')}`, '', `<div class="pills">${Object.keys(SENSITIVE_TXT).map((k) => `<button type="button" class="pill${sens[k] ? ' on' : ''}" data-act="set-sens" data-k="${k}" aria-pressed="${!!sens[k]}">${SENSITIVE_TXT[k]}</button>`).join('')}</div>`, true)}</div>
    <div class="injected ${paused ? 'paused' : ''}" data-injected><div class="overline">每一步實際會附上這段${hint('從卡直接串出來，AI 不改寫。這裡不含身分限縮——綁了身分的分類，實際附的會比這裡少。')}</div><pre>${esc(injText)}</pre></div>
    <div class="group" data-layer="expression"><h5>每步帶・${expLive.length} 條${hint('怎麼講：語氣、長度、格式、禁忌。每一步都會附上。')}</h5>${exp.map(crow).join('') || '<div class="none">還沒有</div>'}</div>
    <div class="group" data-layer="content"><h5>按場合帶・${ctxLive.length} 條${hint('關於你的事實：讀者、公司、進行中的事。只有場合對上的 Workflow 才附上。')}</h5>${ctx.map(crow).join('') || '<div class="none">還沒有</div>'}</div>`;
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
    return `<tr class="kind"><th colspan="5">${t}</th></tr>` + items.map((f) => `<tr data-dict="${esc(f.name)}"><td><b>${esc(f.name)}</b>${f.origin === 'factory' ? '' : '<span class="chip" style="margin-left:5px" title="你的 Workflow 長出來的">自己長的</span>'}</td>
      <td class="syn">${(f.synonyms ?? []).map(esc).join('、') || '—'}</td><td class="syn">${(usage[f.name] ?? []).map((u) => esc(u.name)).join('、') || '還沒有 Workflow 用到'}</td>
      <td class="num">${habitsOf(f.name)}</td><td class="acts">${kindSel(f)}<button class="mini" data-act="dict-merge-start" data-name="${esc(f.name)}" title="把這個欄位併進別的欄位">併入⋯</button></td></tr>${mergeRow(f)}`).join('');
  }).join('');
  return `<div class="group"><div style="overflow-x:auto"><table class="dict"><thead><tr><th>欄位</th><th>同義詞</th><th>用在哪些 Workflow</th><th>掛的習慣卡</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">按性質分六類，不按來源。出廠 7 條，其他是你的 Workflow 長出來的；性質在右邊改，兩個欄位其實是同一件事就「併入」。</p></div>`;
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
        <div class="ib">預設綁哪些分類（開這些分類的 Workflow 時自動選它，開跑時可換）：</div>
        <div class="pills">${state.categories.map((c) => `<span class="pill ${e.categories.has(c) ? 'on' : ''}" data-act="id-bind" data-c="${esc(c)}">${esc(catLabel(c))}</span>`).join('') || '<span class="none">還沒有分類</span>'}</div>
        <div class="btns" style="margin-top:8px"><button class="btn sm2 btn-primary" data-act="id-save">存</button><button class="btn sm2 btn-ghost" data-act="id-cancel">取消</button>${e.err ? `<span class="sub" style="margin:0;color:var(--red-text)">${esc(e.err)}</span>` : ''}</div></div>`;
    }
    return `<div class="asset" data-identity="${esc(i.id)}"><div class="ih"><b>${esc(i.name)}</b><span class="meta">${i.cards.length} 條認識卡・預設綁 ${i.categories.length ? esc(i.categories.join('、')) : '沒有'}・開跑時可換</span>
      <span class="acts"><button class="mini" data-act="id-edit" data-id="${esc(i.id)}">改</button><button class="mini no" data-act="id-del" data-id="${esc(i.id)}">刪</button></span></div>
      <div class="ib">${i.cards.map((c) => esc(textOf(c))).join('　·　') || '沒勾任何認識卡：用它開跑＝關於你一條都不帶'}</div></div>`;
  };
  return `<div class="group"><h5>身分${hint('一疊認識卡的封套，開跑時可以換。只限縮「關於你」帶哪些卡；習慣選項與分類的規矩不受它影響。')}</h5>
    <div class="list">${d.identities.map(item).join('') || '<div class="none">還沒有身分</div>'}</div>
    <div class="addrow"><input class="notein" id="id-new" placeholder="新身分的名字，例：跟客戶開會的我" style="margin:0"><button class="btn sm2" data-act="id-add"><i class="ph ph-plus"></i>新增身分</button></div></div>`;
}
// ---------- 共用素材整頁（樣稿 uxAssets；驗收第 13 條入口在側欄）——角色情境／常用片段＝常用預設庫（presets.json），
// 編輯／刪除沿用 /api/presets；步驟編輯的常用列讀同一份（複製式）。編輯中的值在 state.assets.edit，輪詢重繪從它還原 ----------
const ASSET_FIELDS = [['role_context', '角色情境'], ['snippet', '常用片段']];
function closeAssets() {
  if (!state.assets) return;
  state.assets = null;
}
async function openAssets() {
  clearTimeout(state.pollTimer);
  closeCalendar();
  closeDash();
  closeCategory();
  closeSettings(); closeLibrary(); closeAssets();
  stashWorkspace(); // 同 openLibrary：離開工作區先打包
  state.run = null;
  state.showTrash = false;
  state.corrupt = null;
  state.importPreview = null;
  state.assets = { tab: '全部', edit: null, err: null };
  render();
  const a = state.assets;
  try { state.presets = await api('GET', '/api/presets'); } catch (e) { a.err = e.message; }
  if (state.assets === a) render();
}
function assetsHtml() {
  const a = state.assets;
  const e = a.edit;
  const label = (f) => ASSET_FIELDS.find(([k]) => k === f)?.[1] ?? f;
  const editor = () => `<article class="assetcard editing" data-edit="${esc(e.field)}">
    ${e.orig === null ? `<select class="moveselect" data-pf="field" aria-label="素材類型">${ASSET_FIELDS.map(([k, t]) => `<option value="${k}" ${e.field === k ? 'selected' : ''}>${t}</option>`).join('')}</select>` : `<span class="chip">${esc(label(e.field))}</span>`}
    <input class="notein" data-pf="name" value="${esc(e.name)}" placeholder="名字，例：行銷主管視角" aria-label="素材名稱">
    <textarea class="feedbackin autogrow" data-pf="text" placeholder="內容" aria-label="素材內容">${esc(e.text)}</textarea>
    ${e.err ? `<p class="note err">${esc(e.err)}</p>` : ''}
    <div class="line-actions"><button class="btn sm2 btn-primary" data-act="asset-save">儲存</button><button class="btn sm2" data-act="asset-cancel">取消</button></div></article>`;
  const cards = ASSET_FIELDS.filter(([, t]) => a.tab === '全部' || a.tab === t).flatMap(([field, t]) => (state.presets[field] ?? []).map((p) => (e && e.orig === p.name && e.field === field ? editor()
    : `<article class="assetcard" data-field="${field}" data-preset="${esc(p.name)}"><span class="chip">${t}</span><h3>${esc(p.name)}</h3><p>${esc(p.text)}</p>
    <div class="line-actions"><button class="btn sm2" data-act="asset-edit" data-field="${field}" data-name="${esc(p.name)}">編輯</button><button class="btn sm2" data-act="asset-del" data-field="${field}" data-name="${esc(p.name)}">刪除</button></div></article>`))).join('');
  const tabs = ['全部', '角色情境', '常用片段'].map((t) => `<button type="button" class="${a.tab === t ? 'on' : ''}" data-act="assets-tab" data-t="${t}">${t}</button>`).join('');
  return `${pageHeadHtml('共用素材', '把好用的角色情境與指示片段整理起來，編輯步驟時隨手取用。', '<button class="btn btn-primary" data-act="asset-new">＋ 新增素材</button>')}
    <div class="assettabs">${tabs}</div>
    ${a.err ? `<p class="note err">素材讀不到：${esc(a.err)}</p>` : ''}
    <div class="assetgrid">${e && e.orig === null ? editor() : ''}${cards || (e ? '' : '<p class="note">還沒有素材。新增第一份常用的角色情境或指示片段；複製式：帶進步驟後各改各的。</p>')}</div>`;
}

// ---------- render 與輪詢 ----------
let rendering = false; // render 正在換 DOM（分辨重繪拔掉輸入框的 blur 與使用者真的離開）
let chatSeen = { chat: null, sig: null }; // 上次畫的對話紀錄（哪份 chat、幾則／有沒有卡／在不在等），有變化才捲到最新
function render() {
  let inner;
  if (state.intro) inner = introHtml(); // （M2）：第一次打開先讓它認識你——蓋在儀表板前，答了或跳過才看得到別的
  else if (state.dash) inner = dashHtml();
  else if (state.calendar) inner = calendarHtml();
  else if (state.settings) inner = settingsHtml(); // （M5a）：設定頁，蓋在工作區上的整頁（同儀表板／行事曆）
  else if (state.assets) inner = assetsHtml(); // 共用素材頁（側欄入口，整頁）
  else if (state.library) inner = libraryHtml(); // 移植第一批 T9：流程庫頁（同上，整頁）
  else if (state.categoryPage) inner = categoryPageHtml();
  else if (state.run) inner = runHtml();
  else if (state.importScanning) {
    inner = `<div class="empty-c"><div class="ic"><i class="ph ph-magnifying-glass"></i></div>
      <h3>正在掃描這份 Workflow 檔⋯</h3><p>AI 在逐句檢查有沒有夾帶可疑指示，等它一下。</p></div>`;
  } else if (state.importPreview) inner = importPreviewHtml();
  else if (state.corrupt) inner = corruptCardHtml();
  else if (state.showTrash) inner = trashViewHtml();
  else {
    const body = state.wf && !subjectIsDraft() && state.flowTab === 'data' ? dataTabHtml() // 移植第一批 T10：本次資料分頁蓋過四種模式
      : state.mode === 'chat' ? chatModeHtml()
      : state.mode === 'canvas' ? canvasModeHtml()
        : state.mode === 'history' ? historyModeHtml()
          : listModeHtml();
    // 右側欄（沒有就不包 grid）。清單／畫布＝步驟檢視器；聊天（已存與草稿）＝；
    // 本次資料分頁右欄＝這次會帶入／執行選項（資料夾在檢視器「Workflow 資料」與履歷「執行紀錄」）；履歷單欄
    const onDataTab = state.wf && !subjectIsDraft() && state.flowTab === 'data';
    const aside = onDataTab ? dataAsideHtml()
      : state.mode === 'chat' ? chatAsideHtml() : state.mode === 'list' || state.mode === 'canvas' ? inspectorHtml() : '';
    if (state.mode === 'chat' && !state.wf && !state.chat.refs && refsFor !== state.chat) refreshShapeRefs(); // 草稿聊天右欄沒數字＝補抓一次（已存 Workflow 由 openWorkflow 抓）
    inner = workHeadHtml() + (aside ? `<div class="flowlayout"><section class="flowmain">${body}</section>${aside}</div>` : body);
  }
  // 預覽浮窗放在 .layout 外（.work 有 backdrop-filter，會把 fixed 定位框在自己裡面）；重繪前記住它捲到哪，重繪後放回
  const pvScroll = app.querySelector('.pvbody')?.scrollTop ?? 0;
  // 換 DOM 時正在打字的輸入框會被拔掉→瀏覽器同步發 blur；focusout 那邊看這個旗標分辨「重繪拔掉的」與「使用者離開的」（成品卡格子）
  // （驗收第 3 條）：鍵盤停在側欄或「⋯」選單時，輪詢重繪換掉 DOM 會把焦點丟回 body——記住是哪一顆，重繪後放回
  const fa = document.activeElement;
  const keepFocus = fa?.dataset?.act && fa.closest('.side, .rowmenu') && fa.matches(':focus-visible') ? { ...fa.dataset } : null;
  // 打字中的輸入框（data-keep，例：聊天多行框、成品卡七格）被輪詢重繪換掉——字由 state 放回，焦點與游標也放回，像沒重繪過
  const typing = fa?.matches?.('[data-keep][id]') ? { id: fa.id, s: fa.selectionStart, e: fa.selectionEnd } : null;
  cvChromeSeen = { head: null, insp: null }; // 整頁換過，畫布補畫面時標題區／右欄要重新比
  rendering = true;
  try { app.innerHTML = `<div class="layout">${sideHtml()}<div class="work">${inner}${state.calendar ? calDrawerHtml() + calModalsHtml() : ''}</div></div>` + previewHtml() + memCardModalHtml() + flowSettingsModalHtml() + flowMemModalHtml() + sharedModalHtml() + setConfirmModalHtml() + promptModalHtml(state.run ? state.promptView : state.dash?.promptView) + renameModalHtml() + rowMenuHtml() + drawerHtml(); }
  finally { rendering = false; }
  if (keepFocus && document.activeElement === document.body) {
    const again = [...app.querySelectorAll(`[data-act="${keepFocus.act}"]`)].find((x) => x.dataset.cat === keepFocus.cat && x.dataset.id === keepFocus.id && x.dataset.to === keepFocus.to && x.dataset.type === keepFocus.type);
    if (again?.matches('.rowmore, .tree-rename')) (again.closest('summary') ?? again.parentElement.querySelector('.wf'))?.focus(); // 收著的鈕（display:none）先讓同列 :focus-within 亮出來才叫得動 focus
    again?.focus();
  }
  if (pvScroll) { const b = app.querySelector('.pvbody'); if (b) b.scrollTop = pvScroll; }
  syncStepSnap(); // 步驟彈窗開窗值（判有沒有未套用的改動）
  if (typing && document.activeElement === document.body) {
    const ed = document.getElementById(typing.id);
    if (ed && !ed.disabled) { ed.focus(); if (typing.s !== null && ed.setSelectionRange) ed.setSelectionRange(typing.s, typing.e); }
  }
  document.body.classList.toggle('previewing', !!state.preview); // print CSS 只印浮窗內容
  // 健檢「修這裡」亮著的期間，每次重繪都把（新的）權限列捲進視野中央——同步做（不用 rAF，分頁在背景時 rAF 不跑）；
  // 不管捲動容器是 document 還是 .work，scrollIntoView 都找得到
  if (state.permFlashUntil > Date.now()) document.getElementById('perm-files')?.scrollIntoView({ block: 'center', behavior: 'auto' });
  const cvw = app.querySelector('.cvwrap');
  if (cvw) window.BJCanvas.bind(cvw, cvHandlers);
  // 對話紀錄在表單卡下方往下長（整頁捲）——多了一則、出卡、開始等回覆時，把最新那張捲進視野；輪詢重繪沒變化就不動捲軸
  const log = document.getElementById('chatlog');
  const sig = log ? `${state.chat.messages.length}|${!!state.chat.shape}|${state.chat.busy}` : null;
  if (log && chatSeen.chat === state.chat && chatSeen.sig !== sig) log.lastElementChild?.scrollIntoView({ block: 'nearest' });
  chatSeen = { chat: log ? state.chat : null, sig };
  autoGrowAll();
  // 畫完就把「沒存的東西」排進瀏覽器暫存（節流 500ms）
  dsSchedule();
}

function pollProposalsSoon(w) {
  for (const ms of [800, 3000, 8000, 20000, 45000]) {
    setTimeout(async () => {
      try {
        const before = state.proposals.pending.length;
        await refreshProposals(w);
        if (state.proposals.pending.length !== before && !isTyping()) render();
      } catch (e) { pollFailed('Workflow 提議', e); }
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
      // 跑步中打字（停點回話、人做步驟要交出的內容）本來會被每秒重繪打斷。
      // 打字時先記帳不重繪，手停了下一輪補畫——不是丟掉，不然畫面會停在舊狀態。
      if (changed || state.pollDirty) {
        if (isTyping()) state.pollDirty = true;
        else { state.pollDirty = false; render(); }
      }
    } catch (e) { pollFailed('執行狀態', e); }
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
// 拆解器兩趟——第一趟（phase:'shape'）回成品卡、第二趟（phase:'draft' 帶卡上確認過的格子）回草稿。
// round 沒給＝使用者按送出（讀輸入框、決定趟別）；成品卡兩鈕給 round（「照這樣拆」／「重擬」）＝重送已在對話裡的最後一句。
async function sendChat(round = null) {
  // 發問當下一次抓住工作區——等待中切去別條 Workflow／草稿，回覆照樣寫回這裡，不寫當下的 state.chat／state.wf
  const chat = state.chat;
  if (chat.busy) return;
  const current = subjectDef();
  const target = state.wf && !subjectIsDraft() ? { category: state.wf.category, id: state.wf.id } : null;
  const category = subjectIsDraft() ? (chat.draft?.category ?? null) : (state.wf?.category ?? null);
  if (!round) {
    const input = document.getElementById('chat-input');
    const text = input?.value.trim();
    if (!text) return;
    input.value = ''; // 多行框帶 data-keep，送出後清框與暫存字（否則重繪放回剛送出的句子）
    delete state.keep[keepKey('chat-input')];
    chat.messages.push({ role: 'user', text });
    // 句子含「重拆」且已有草稿（或已存流程）→明帶 phase:'shape' 出卡，草稿照帶當背景。
    // 其餘不帶 phase、交伺服器缺省解析：沒草稿→第一趟出卡；有草稿→對話修改不出卡。
    // 第一趟刻意不明帶 'shape'：B4 定案「明帶 shape 永遠只跑一趟」，只有缺省解析出來的 shape 才會在開關關掉時連跑成草稿（auto:true）
    round = current && /重拆/.test(text) ? { phase: 'shape' } : {};
  }
  chat.busy = true;
  render();
  try {
    const out = await api('POST', '/api/compose', {
      messages: chat.messages.filter((m) => m.role === 'user' || m.role === 'ai'), // 錯誤氣泡與記憶通知行不是對話
      current_draft: current,
      // （M1c）：已存流程＝它所在的分類；草稿＝拆解器問過後寫在頂層的 category——伺服器拿它讀群組規矩
      category,
      ...round, // phase／shape／sources／category（第二趟的卡上分類蓋過上面那個）
    });
    if (out.phase === 'shape' && !out.auto) {
      // 第一趟：只出卡、還沒有草稿。分類空（拆解器沒建議或不合法）→預選第一個分類，沒有分類就「未分類」
      chat.shape = out.shape;
      chat.sources = out.sources ?? []; // 伺服器已補齊成陣列
      chat.category = out.category ?? state.categories.find((c) => c !== '未分類') ?? '未分類';
      chat.shapeBase = null;
      chat.refs = null;
      if (state.chat === chat) refreshShapeRefs(); // 卡底數字另外抓、不等它；已切走＝讀回時補抓（open-draft／openWorkflow）
      chat.messages.push({ role: 'ai', text: out.reply || '先看成品長相對不對——格子點一下可以改，沒問題就按「照這樣拆」。' });
    } else if (target) {
      delete out.draft.category; // 分類是路徑，不進 workflow.yaml；PUT 不會替你剝（新建那條路在 confirm-save-draft 剝）
      // 等待中它的部門被改名或搬走＝路徑換了（舊路徑 PUT 會 404、改動丟掉）；原鍵不在最新清單時，
      // 照 id 找回現在的部門——同 id 恰好一條才認（範例檔 id 可能在兩個部門重複，認不準就照舊路徑、寧可報錯不寫錯條）
      const lib = state.workflows ?? [];
      const sameId = lib.filter((w) => w.id === target.id);
      if (!sameId.some((w) => w.category === target.category) && sameId.length === 1) target.category = sameId[0].category;
      await api('PUT', wfPath(target), { def: out.draft });
      if (state.wf && flowKey(state.wf) === flowKey(target)) state.wf.def = out.draft; // 切走了＝開回來會重抓
      chat.messages.push({ role: 'ai', text: (out.reply || '改好了。') + '\n（已存檔＋記進履歷，改壞了到「履歷」退回）' });
    } else {
      chat.draft = out.draft;
      chat.messages.push({ role: 'ai', text: out.reply || '拆好了，切到「清單」或「畫布」看草稿。' });
    }
    if (out.draft) {
      // 第二趟（或開關關掉的連跑、或對話修改）拆出草稿了：卡收掉、不再出（設計 §九-3 卡不存檔）；
      // 連跑（auto:true）沒讓你確認過→把拆解器自己定的格子留在 autoShape，清單頂端印一行灰字對照
      chat.shape = null;
      chat.shapeBase = null;
      if (out.auto) chat.autoShape = out.shape ?? null;
    }
    if (out.memory_notice) chat.messages.push({ role: 'memnotice', notice: out.memory_notice }); // （M2）記路④：這句被記成什麼
  } catch (e) {
    chat.messages.push({ role: 'error', text: e.message });
  } finally {
    chat.busy = false;
  }
  render(); // 已切走也重繪：側欄「草稿・還沒存」列跟著更新
}

// ---------- 畫布編輯操作 ----------
async function saveDef(def) {
  if (subjectIsDraft()) {
    state.chat.draft = def; // 草稿只留在本地，存庫時才驗
    return;
  }
  const empty = cvEmptyConds(def); // （地雷 9）：空條件送出去會 400——先攔、講人話
  if (empty.length) throw new Error(`還有 ${empty.length} 條擇一的線沒寫條件——寫好條件再存檔`);
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
//（一條路只能指一步）→ 回 false 留著不拆，執行不受影響
function dissolveStructural(def, node) {
  const targets = outgoingOf(node).filter((t) => def.nodes.some((x) => x.id === t));
  const hasBranchPred = def.nodes.some((p) => kindOf(p) === 'branch' && (p.branches ?? []).some((b) => b.next === node.id));
  if (hasBranchPred && targets.length > 1) return false;
  removeNodeSimple(def, node.id);
  return true;
}

// 收整結構：每次編輯順手把舊式 join 拆成直接連線（會合=多入線；進履歷，可退回）。
// 可吸收的並行點（唯一前驅是 task、那張卡只接它）也拆成卡的多條出線（語意相同）；帶 merge 的舊 join 不拆（拆了會丟掉任一條到）
function normalize(def) {
  const keep = new Set(); // 拆不動的舊結構（見 dissolveStructural）
  for (let guard = 0; guard < def.nodes.length + 5; guard++) {
    const preds = cvPreds(def);
    const s = def.nodes.find((n) => !keep.has(n.id) && ((kindOf(n) === 'join' && n.merge !== 'any') || (kindOf(n) === 'fork' && cvAbsorbable(def, n, preds))));
    if (!s) return;
    if (!dissolveStructural(def, s)) keep.add(s.id);
  }
}

// ---------- 畫布款 A 資料模型：定義檔格式不改 ----------
// 「同時做」＝卡片多條 next；「擇一」＝卡片唯一 next 指向的分岔（畫面藏起來、線畫虛線、條件在線上）；舊 join 畫成直連；
// 轉不過的 fork／branch＝舊寫法小圓點 A：照樣能跑能改，轉得過的由使用者按「轉成新寫法」，不自動改寫）。寫回一律先 normalize。
const CV_CHOOSE_DEFAULT = '依每條線上的條件，挑符合的一條走';
function cvPreds(def) {
  const m = new Map(def.nodes.map((n) => [n.id, []]));
  for (const n of def.nodes) for (const t of outgoingOf(n)) m.get(t)?.push(n.id);
  return m;
}
// 這顆結構節點畫面上藏得起來嗎：join（沒帶 merge）一律；fork／branch＝唯一前驅是 task、那張卡的 next 只有它、線夠（fork ≥2、branch ≥1）
function cvAbsorbable(def, n, preds = cvPreds(def), byId = null) {
  const k = kindOf(n);
  if (k === 'join') return n.merge !== 'any' && (n.next ?? []).length <= 1;
  if (k !== 'fork' && k !== 'branch') return false;
  const ps = preds.get(n.id) ?? [];
  const t = ps.length === 1 ? (byId ? byId.get(ps[0]) : def.nodes.find((x) => x.id === ps[0])) : null;
  if (!t || kindOf(t) !== 'task' || (t.next ?? []).length !== 1 || t.next[0] !== n.id) return false;
  return k === 'fork' ? (n.next ?? []).length >= 2 : (n.branches ?? []).length >= 1;
}
// 卡片出口藏著的分岔（擇一）；沒有＝null
function cvHiddenBranch(def, t) {
  if (!t || kindOf(t) !== 'task' || (t.next ?? []).length !== 1) return null;
  const b = def.nodes.find((x) => x.id === t.next[0]);
  return b && kindOf(b) === 'branch' && cvAbsorbable(def, b) ? b : null;
}
function cvModel(def) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const preds = cvPreds(def);
  const hidden = new Set(def.nodes.filter((n) => cvAbsorbable(def, n, preds, byId)).map((n) => n.id));
  const cards = def.nodes.filter((n) => !hidden.has(n.id));
  const legacy = cards.filter((n) => kindOf(n) !== 'task').map((n) => n.id);
  const exits = {};
  const entries = {};
  const choose = {};
  const edges = [];
  // 線的終點穿過藏起來的 join；藏起來的 fork／branch 只會從它那張卡走到，不會被別人指到
  const resolve = (t, seen = new Set()) => {
    const n = byId.get(t);
    if (!n || seen.has(t)) return [];
    if (!hidden.has(t)) return [t];
    seen.add(t);
    return kindOf(n) === 'join' ? (n.next ?? []).flatMap((x) => resolve(x, seen)) : [];
  };
  // 去重與計數改查表（200 步的畫布每次改動都算一次，原本逐條掃是 O(線²)）——結果與逐條掃相同
  const seenE = new Set();
  const outN = new Map();
  const push = (e) => { const k = `${e.from}\u0000${e.to}\u0000${e.arm}`; if (seenE.has(k)) return; seenE.add(k); edges.push(e); outN.set(e.from, (outN.get(e.from) ?? 0) + 1); };
  for (const c of cards) {
    if (kindOf(c) === 'branch') {
      (c.branches ?? []).forEach((b, i) => resolve(b.next).forEach((to) => push({ from: c.id, to, dashed: true, cond: b.label ?? '', arm: i })));
      continue;
    }
    for (const t of c.next ?? []) {
      const n = byId.get(t);
      if (n && hidden.has(t) && kindOf(n) === 'fork') {
        exits[c.id] = 'all';
        (n.next ?? []).forEach((x) => resolve(x).forEach((to) => push({ from: c.id, to, via: t })));
      } else if (n && hidden.has(t) && kindOf(n) === 'branch') {
        exits[c.id] = 'one';
        choose[c.id] = n.instruction ?? '';
        (n.branches ?? []).forEach((b, i) => resolve(b.next).forEach((to) => push({ from: c.id, to, dashed: true, cond: b.label ?? '', arm: i, via: t })));
      } else resolve(t).forEach((to) => push({ from: c.id, to }));
    }
    if (kindOf(c) === 'task' && !exits[c.id] && (outN.get(c.id) ?? 0) >= 2) exits[c.id] = 'all';
  }
  const inFrom = new Map();
  for (const e of edges) (inFrom.get(e.to) ?? inFrom.set(e.to, new Set()).get(e.to)).add(e.from);
  for (const c of cards) {
    if ((inFrom.get(c.id)?.size ?? 0) >= 2) entries[c.id] = c.merge === 'any' ? 'any' : 'all';
  }
  return { cards, edges, exits, entries, choose, hidden: [...hidden], legacy };
}
const cvNode = (def, id) => def.nodes.find((n) => n.id === id);
// 線接到的分岔：卡片藏著的（擇一）或舊寫法分岔本身
const cvBranchOf = (def, f) => cvHiddenBranch(def, f) ?? (f && kindOf(f) === 'branch' ? f : null);
const cvArmIndex = (br, to, arm) => (arm != null && br.branches[arm]?.next === to ? arm : br.branches.findIndex((b) => b.next === to));
function cvDropNode(def, id) {
  def.nodes = def.nodes.filter((n) => n.id !== id);
  if (def.canvas?.positions) delete def.canvas.positions[id];
}
// 接線：擇一出口＝藏起來的分岔多一條空條件路；其他＝多一個 next（拿掉「一步只接一條出線」）；成環照擋
function cvConnect(def, from, to) {
  normalize(def);
  const f = cvNode(def, from);
  if (!f || !cvNode(def, to)) return;
  const hb = cvHiddenBranch(def, f);
  if (!hb) return doConnect(def, from, to);
  if (from === to) throw new Error('自己接自己會原地打轉——接別的節點');
  if (canReach(def, to, from)) throw new Error('這樣會繞圈圈——Workflow 只能一路往前');
  if (!hb.branches.some((b) => b.next === to)) hb.branches.push({ label: '', next: to });
}
// 剪線：擇一剪到剩一條＝拆掉藏起來的分岔；舊寫法分岔／並行點剪到剩一條照舊拉直
function cvCut(def, from, to, arm = null) {
  normalize(def);
  const f = cvNode(def, from);
  if (!f) return;
  const hb = cvHiddenBranch(def, f);
  const br = cvBranchOf(def, f);
  if (br) {
    const i = cvArmIndex(br, to, arm);
    if (i < 0) return;
    br.branches.splice(i, 1);
    if (hb && br.branches.length <= 1) {
      f.next = br.branches.map((b) => b.next);
      cvDropNode(def, br.id);
    } else if (!hb && br.branches.length === 1) removeNodeSimple(def, br.id);
    return;
  }
  f.next = (f.next ?? []).filter((t) => t !== to);
  if (kindOf(f) === 'fork' && f.next.length === 1) removeNodeSimple(def, f.id);
}
// 線上插一步：那一條線改指新卡、新卡接原終點（擇一路的條件留在原路上）
function cvInsert(def, edge, t) {
  normalize(def);
  const f = cvNode(def, edge.from);
  if (!f) return;
  const br = cvBranchOf(def, f);
  t.next = [edge.to];
  if (br) {
    const i = cvArmIndex(br, edge.to, edge.arm);
    if (i >= 0) br.branches[i].next = t.id;
  } else f.next = (f.next ?? []).map((x) => (x === edge.to ? t.id : x));
}
// 出口膠囊：all→one 建藏起來的分岔（每條原線一條空條件路）；one→all 拆掉分岔、原線照舊（條件丟掉，要回來按復原）
function cvSetExit(def, id, mode) {
  normalize(def);
  const t = cvNode(def, id);
  if (!t || kindOf(t) !== 'task') return;
  const hb = cvHiddenBranch(def, t);
  if (mode === 'one' && !hb && (t.next ?? []).length) {
    const b = { id: newNodeId(), kind: 'branch', title: `${t.title}・擇一`, instruction: CV_CHOOSE_DEFAULT, branches: t.next.map((next) => ({ label: '', next })), next: [] };
    t.next = [b.id];
    def.nodes.splice(def.nodes.indexOf(t) + 1, 0, b);
  } else if (mode === 'all' && hb) {
    t.next = [...new Set(hb.branches.map((b) => b.next))];
    cvDropNode(def, hb.id);
  }
}
function cvSetCond(def, from, to, text, arm = null) {
  normalize(def);
  const br = cvBranchOf(def, cvNode(def, from));
  const i = br ? cvArmIndex(br, to, arm) : -1;
  if (i >= 0) br.branches[i].label = String(text ?? '').trim();
}
function cvSetChoose(def, id, text) {
  normalize(def);
  const hb = cvHiddenBranch(def, cvNode(def, id));
  if (hb) hb.instruction = String(text ?? '').trim() || CV_CHOOSE_DEFAULT; // 定義檔不准空的判斷依據
}
// 入口膠囊：任一條到＝merge:'any'；等全部＝刪鍵（舊檔形狀）
function cvSetEntry(def, id, mode) {
  const n = cvNode(def, id);
  if (!n) return;
  if (mode === 'any') n.merge = 'any'; else delete n.merge;
}
// 條件空白的擇一線（地雷 9：定義檔不准空條件）：藏起來的分岔記在卡上、舊寫法分岔記在分岔上
function cvEmptyConds(def) {
  const out = [];
  const preds = cvPreds(def);
  for (const b of def.nodes) {
    if (kindOf(b) !== 'branch') continue;
    const from = cvAbsorbable(def, b, preds) ? preds.get(b.id)[0] : b.id;
    (b.branches ?? []).forEach((x, arm) => { if (!String(x.label ?? '').trim()) out.push({ from, to: x.next, arm }); });
  }
  return out;
}
// 舊寫法「轉成新寫法」：目前只有並行點轉得過（拆掉點、前驅直接接全部下游，語意相同）；分岔在第一步、接在並行點後、跟一般線混接的分岔轉不過
// 判斷在收整過的副本上做：舊 join 先拆直，才看得到並行點真正的前驅（例：分岔的路經舊 join 接進並行點＝轉不過）
function cvCanConvert(def, id) {
  const d = JSON.parse(JSON.stringify(def));
  normalize(d);
  const n = cvNode(d, id);
  if (!n || kindOf(n) !== 'fork' || cvAbsorbable(d, n)) return false;
  const targets = outgoingOf(n).filter((t) => cvNode(d, t));
  return !(targets.length > 1 && d.nodes.some((p) => kindOf(p) === 'branch' && (p.branches ?? []).some((b) => b.next === id)));
}
function cvConvert(def, id) {
  normalize(def);
  if (cvCanConvert(def, id)) dissolveStructural(def, cvNode(def, id));
  normalize(def);
}
// 座標：畫面上看到的全部卡片座標一次寫進 def.canvas＋layout:'tb'（舊的由左往右座標不沿用）；藏起來的節點不存座標
function cvShownPositions(def) {
  const pos = window.BJCanvas.layout(cvModel(def), def.canvas).pos;
  return Object.fromEntries([...pos].map(([id, p]) => [id, { x: p.x, y: p.y }]));
}

// 畫布上一步／重做：每次成功的畫布編輯先照快照；換流程（或草稿）自動歸零
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
  if (state.mode === 'canvas' && !state.drawerOpen) cvRefresh(); else render(); // 畫布上復原／重做只補畫布
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

// （①）：畫布上的改動＝改工作本（草稿直接改草稿）＋cvHistory＋cvDirty，不重繪；回傳新定義、有沒有動到結構、新模型
// 先把畫面上看到的座標全部定下來（fn 裡 setPos 再蓋過），做完補新卡座標、只留卡片的——之後加卡別張不跳。
// 畫面上的座標直接跟 canvas.js 拿（同一份定義才給），拿不到才重排一次
function canvasCommit(fn) {
  const cur = cvDef();
  const before = structuredClone(cur);
  const def = structuredClone(cur);
  def.canvas = { ...(def.canvas ?? {}), layout: 'tb', positions: window.BJCanvas.shown?.(cur) ?? cvShownPositions(before) };
  const sig = JSON.stringify(def.nodes);
  fn(def);
  normalize(def);
  const structural = JSON.stringify(def.nodes) !== sig;
  let model = null;
  if (structural) { // 只搬位置不用重算模型；結構動了才補新卡座標、清掉不是卡片的座標
    model = cvModel(def);
    const cards = model.cards.map((n) => n.id);
    const pos = cards.every((id) => def.canvas.positions[id]) ? def.canvas.positions : cvShownPositions(def);
    def.canvas.positions = Object.fromEntries(cards.map((id) => [id, pos[id]]));
  }
  cvEditAt = Date.now(); // 健檢等停手再送（見 preflightFor）
  if (subjectIsDraft()) state.chat.draft = def;
  else {
    // v0.18：畫布改動先進工作本，按「存檔」才落地（清單模式的編輯抽屜照舊即改即存）
    state.cvWork = def;
    state.cvDirty = true;
  }
  const h = cvHistoryFor();
  h.undo.push(before);
  if (h.undo.length > 50) h.undo.shift();
  h.redo = [];
  return { def, structural, model };
}

async function canvasOp(fn) {
  if (state.mode === 'canvas') { canvasCommit(fn); render(); return; } // 彈窗套用、刪除等：窗要關／換，整頁畫
  const before = structuredClone(cvDef());
  const def = structuredClone(before);
  fn(def);
  normalize(def);
  if (def.canvas?.positions) { // 已刪節點的座標不留死資料
    for (const id of Object.keys(def.canvas.positions)) {
      if (!def.nodes.some((n) => n.id === id)) delete def.canvas.positions[id];
    }
  }
  await saveDef(def); // 清單模式（與清單裡的彈窗）即改即存
  const h = cvHistoryFor();
  h.undo.push(before);
  if (h.undo.length > 50) h.undo.shift();
  h.redo = [];
  render();
}

// 畫布改完只補畫面——結構動了換 .cvwrap 裡有變的元素，只搬位置什麼都不用換；再補頁面工具列、復原鈕、右欄。畫布不在畫面上才整頁畫
function cvRefresh(r = null) {
  const def = cvDef();
  if (!def || !app.querySelector('.cvwrap')) { render(); return; }
  if (r && !r.structural) {
    window.BJCanvas.adopt(def);
    patchCanvasChrome({ inspector: false });
    return;
  }
  if (!window.BJCanvas.update(def, state.canvasSel, cvIssueSet(def), r?.model ?? cvModel(def), cvCanvasOpts(def))) { render(); return; }
  patchCanvasChrome();
}
// 頁面標題區（「未儲存」chip、存檔鈕、已儲存字）整塊換新；畫布復原／重做鈕態；右欄檢視器（inspector=false 不動）
let cvChromeSeen = { head: null, insp: null }; // 上次補上的標題區／右欄 HTML：一樣就不換（換了會讓整個工作區重排）
function patchCanvasChrome({ inspector = true } = {}) {
  const fl = app.querySelector('.work > .flowlayout');
  if (!fl) return;
  const head = workHeadHtml();
  if (head !== cvChromeSeen.head) {
    while (fl.previousSibling) fl.previousSibling.remove();
    fl.insertAdjacentHTML('beforebegin', head);
    cvChromeSeen.head = head;
  }
  const h = cvHistoryFor();
  const undo = fl.querySelector('.cvtools [data-act="cv-undo"]');
  if (undo) undo.disabled = !h.undo.length;
  const redo = fl.querySelector('.cvtools [data-act="cv-redo"]');
  if (redo) redo.disabled = !h.redo.length;
  const box = inspector ? app.querySelector('.work .right') : null;
  if (!box) return;
  const insp = inspectorHtml();
  if (insp !== cvChromeSeen.insp) { box.outerHTML = insp; cvChromeSeen.insp = insp; }
}
// 單擊卡：只換 .sel 與右欄（不整頁重繪）
function cvSelect(id) {
  state.canvasSel = id;
  window.BJCanvas.select(id);
  const box = app.querySelector('.work .right');
  if (box) box.outerHTML = inspectorHtml();
  cvChromeSeen.insp = null; // 右欄換過，下次補畫面重新比
}
// 點線選取／取消（Delete 剪選中的線）
function cvEdgeSelect(edge) {
  state.cvEdgeSel = edge ? { from: edge.from, to: edge.to, arm: edge.arm ?? null } : null;
  window.BJCanvas.selectEdge(state.cvEdgeSel);
}
function cvKeyDelete(e) {
  if (e.key !== 'Delete' || !state.cvEdgeSel || e.target.matches?.('input, textarea, select, [contenteditable]')) return false;
  e.preventDefault();
  const s = state.cvEdgeSel;
  state.cvEdgeSel = null;
  cvEdit((d) => cvCut(d, s.from, s.to, s.arm));
  return true;
}
// 擇一條件格：點了原地變輸入框（state.cvCondEdit＋data-keep），Enter 存（cvSetCond）、Esc 放棄
function cvCondStart(edge) {
  if (!edge) return;
  state.cvCondEdit = { from: edge.from, to: edge.to, arm: edge.arm ?? null };
  delete state.keep[keepKey('cvcond-edit')];
  cvRefresh();
  const ed = document.getElementById('cvcond-edit');
  if (ed) { ed.focus(); ed.select(); }
}
function cvCondKey(e) {
  const ce = state.cvCondEdit;
  if (!ce || e.isComposing) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    cvCondFinish(e.target.value, true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cvCondFinish(null, false);
  }
}
function cvCondFinish(text, save) {
  const ce = state.cvCondEdit;
  if (!ce) return;
  state.cvCondEdit = null; // 先清：換掉輸入框時的失焦不再進來
  delete state.keep[keepKey('cvcond-edit')];
  if (save && String(text ?? '').trim()) state.cvCondIssues = (state.cvCondIssues ?? []).filter((x) => !(x.from === ce.from && x.to === ce.to));
  if (save) cvEdit((d) => cvSetCond(d, ce.from, ce.to, text, ce.arm));
  if (document.getElementById('cvcond-edit')) cvRefresh(); // 沒改字（沒動到結構）或放棄：輸入框換回條件格
}

// 存檔（v0.18）：工作本落地＋連接檢查——照存不擋，但沒接好會標紅並講明「開始不了」
async function cvSave() {
  if (subjectIsDraft() || !state.cvDirty || !state.cvWork) return;
  const def = state.cvWork;
  const issues = canvasIssues(def);
  const empty = cvEmptyConds(def); // （地雷 9）：擇一條件有空的不送出，標出那幾條線（L14 畫琥珀「點此寫條件」）
  state.cvCondIssues = empty.length ? empty : null;
  if (empty.length) {
    window.alert(`還有 ${empty.length} 條擇一的線沒寫條件——點線上的條件格寫好再存檔`);
    render();
    return;
  }
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
  if (issues.length) window.alert(`已存檔。注意：有 ${issues.length} 處還沒接好（已標紅）——接好並存檔之前，這個 Workflow 按「開始」不會跑。`);
  render();
}

// ---------- 畫布自由化：拖擺存座標、拉線接人、剪線、線上插步 ----------
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
  if (canReach(def, to, from)) throw new Error('這樣會繞圈圈——Workflow 只能一路往前');
  if (kindOf(f) === 'branch') { if (!f.branches.some((b) => b.next === to)) f.branches.push({ label: `情況${f.branches.length + 1}`, next: to }); }
  else if (!(f.next ?? []).includes(to)) (f.next ??= []).push(to);
}

// 畫布問題清單：未接進流程的步驟 ＋ 線不足兩條的並行／分岔點（離開畫布前標紅擋下）
function canvasIssues(def) {
  const hidden = new Set(cvModel(def).hidden); // 藏起來的擇一分岔一條線也合法（卡上只剩一條線），不標
  const thin = def.nodes
    .filter((n) => !hidden.has(n.id))
    .filter((n) => (kindOf(n) === 'fork' && (n.next ?? []).length < 2) || (kindOf(n) === 'branch' && (n.branches ?? []).length < 2))
    .map((n) => n.id);
  return [...new Set([...unconnectedIds(def), ...thin])];
}

// 離開畫布前的接線檢查：還沒接進流程的步驟要標紅、擋下切換。
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
  closeSettings(); closeLibrary(); closeAssets();
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
  stashWorkspace(); // 離開的那條先打包
  state.wf = { category, id, def, runs };
  state.run = null;
  // 有暫存包＝讀回（草稿、聊天、本次資料、分頁、選取、畫布工作本）；沒有才重設成預設（mode list、flowTab design、paramNow {}…）
  restoreWorkspace(flowKey({ category, id }));
  state.editingParam = null;
  state.editingNode = null;
  state.cvShowIssues = false;
  state.cvCondEdit = null; // 畫布條件格編輯、選中的線不跨 Workflow
  state.cvEdgeSel = null;
  state.cvCondIssues = null;
  state.addingParam = false;
  state.dataCard = 'data'; // 換流程回到預設展開「填寫這次的值」
  state.flowSettingsOpen = false; // 移植第一批 T10：換流程關兩浮窗
  state.flowMemOpen = false;
  state.sharedOpen = false; // 換流程關共用檔浮窗、「查看全部」收回
  state.wfRuns = [];
  state.shared = { company: null, dept: null, err: null };
  state.feedbackSent = false;
  state.showTrash = false;
  state.corrupt = null;
  window.BJCanvas.resetView();
  state.versions = await api('GET', `${wfPath(state.wf)}/versions`);
  await refreshProposals(state.wf);
  state.wfFiles = await api('GET', `${wfPath(state.wf)}/files`);
  await refreshFolder(); // 右側資料夾：歷次執行摘要＋兩層共用檔（任一讀不到＝該塊印讀不到，流程照開）
  // （M3b）：開跑表單的習慣選項——每次重抓；點過的卡、改掉的、身分在暫存包裡，沒包才歸零
  state.wfMemory = null;
  state.memMore = {};
  await refreshWfMemory();
  if (!state.chat.refs) refreshShapeRefs(); // wfMemory／shared 抓好了再抓；聊天右欄常駐「這次拆解會參考」，沒卡也抓
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

// 畫布手勢的改動——canvasCommit 改工作本、cvRefresh 只補畫面（不整頁重繪）；丟錯（例：繞圈）講人話、畫面照工作本補回。
// 這次改動打開了步驟彈窗（雙擊空白加步驟、線上插一步）才整頁畫（彈窗要掛上）
function cvEdit(fn) {
  const opened = state.drawerOpen;
  let r;
  try {
    r = canvasCommit(fn);
  } catch (e) {
    window.alert(e.message);
    cvRefresh();
    return;
  }
  if (state.drawerOpen && !opened) { render(); return; }
  cvRefresh(r);
}
// 09-18 驗收第 5 條：「整理排列」——丟掉存過的座標，照自動排版（L13 的列＝最長路徑、L14b 的新列距與同層排序）重排。
// 存過的座標不帶進去（layout 第二個參數給 null＝不套用），排完進工作本＋cvHistory（Ctrl+Z 復原）、標「有改動未存」，按存檔才寫回。
function cvAutoPositions(def) {
  const pos = window.BJCanvas.layout(cvModel(def), null).pos;
  return Object.fromEntries([...pos].map(([id, p]) => [id, { x: p.x, y: p.y }]));
}
function cvTidy() {
  if (!cvDef()) return;
  if (!window.confirm('整理排列會照步驟順序把圖重新排好——你自己拖過的位置會被蓋掉。\n排完可以按 Ctrl+Z 復原；沒按存檔就不會寫回去。')) return;
  try {
    canvasCommit((def) => { def.canvas = { ...(def.canvas ?? {}), layout: 'tb', positions: cvAutoPositions(def) }; });
  } catch (e) {
    window.alert(e.message);
    cvRefresh();
    return;
  }
  cvRefresh(); // 只動座標：走完整比對把每張卡搬到新位置（cvRefresh(r) 的 structural=false 捷徑不畫位置）
}

const cvHandlers = {
  onMove: (id, x, y) => cvEdit((def) => setPos(def, id, x, y)),
  // 單擊卡 → 選取（只換 .sel 與右欄）
  onSelect: (id) => cvSelect(id),
  // 雙擊卡 → 步驟彈窗
  onOpen: (id) => { state.canvasSel = id; state.drawerOpen = true; render(); },
  // 雙擊空白 → 原地一張新卡（不強迫接線），順手開彈窗讓他命名
  onNewAt: (x, y) => cvEdit((def) => {
    const t = makeTask('新步驟');
    def.nodes.push(t);
    setPos(def, t.id, x, y);
    state.canvasSel = t.id;
    state.drawerOpen = true;
  }),
  // 拿掉「一步只接一條出線」——第二條線起出口就是同時做（或擇一），成環由 cvConnect 擋、cvEdit 講人話
  onConnect: (from, to) => cvEdit((d) => cvConnect(d, from, to)),
  // 拉到空白 → 原地長出下一步並接上、選中它（不自動開彈窗，連拉幾步不被打斷；雙擊卡再命名）
  onNewFrom: (from, x, y) => cvEdit((d) => {
    const t = makeTask('新步驟');
    d.nodes.push(t);
    setPos(d, t.id, x, y);
    state.canvasSel = t.id;
    cvConnect(d, from, t.id);
  }),
  // edge 是 cvModel 的線（from＝卡片；擇一線帶 arm）：剪到剩一條＝自動拉直
  onCut: (edge) => cvEdit((def) => cvCut(def, edge.from, edge.to, edge.arm)),
  onInsert: (edge, mid) => cvEdit((def) => {
    const t = makeTask('新步驟');
    def.nodes.push(t);
    setPos(def, t.id, Math.round(mid.x - 105), Math.round(mid.y - 52));
    cvInsert(def, edge, t); // 只改這一條線，其他出線不動
    state.canvasSel = t.id;
    state.drawerOpen = true;
  }),
  // 出口膠囊「同時做⇄擇一」、入口膠囊「等全部⇄任一條到」
  onPill: (id, kind, mode) => cvEdit((d) => (kind === 'exit' ? cvSetExit(d, id, mode === 'one' ? 'all' : 'one') : cvSetEntry(d, id, mode === 'any' ? 'all' : 'any'))),
  onCond: (edge) => cvCondStart(edge),
  onEdgeSel: (edge) => cvEdgeSelect(edge),
};

// ---------- 事件 ----------
app.addEventListener('keydown', (e) => {
  if (keyActivate(e)) return;
  if (e.target.id === 'chat-input' && e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); sendChat(); } // 多行框 Ctrl+Enter 送出、Enter 換行
  if (e.target.matches?.('[data-pedit]') && e.key === 'Enter') commitParamEdit(e.target);
  if (e.target.id === 'set-company-name' && e.key === 'Enter') e.target.blur(); // 設定→資料 公司名稱：Enter＝失焦，交給 change 存
  if (e.target.dataset?.act === 'param-label' && e.key === 'Enter') e.target.blur(); // 欄位名稱 Enter＝失焦，交給 change 存
  if (e.target.id === 'rename-name' && e.key === 'Enter') { e.preventDefault(); renameSave(); } // 改名浮窗：Enter＝儲存
  if (e.target.id === 'cvcond-edit') cvCondKey(e); // 畫布條件格 Enter 存、Esc 放棄
});

// 畫布快捷鍵：Ctrl+Z 上一步、Ctrl+Shift+Z / Ctrl+Y 重做、Ctrl+S 存檔（打字中不攔，交還瀏覽器原生行為）
document.addEventListener('keydown', (e) => {
  // 釘住的說明鈕 Esc 關，焦點留在那顆鈕上（就地改，不重繪）
  if (e.key === 'Escape') {
    const open = document.querySelector('.hint[aria-expanded="true"]');
    if (open) { open.setAttribute('aria-expanded', 'false'); open.focus(); return; }
  }
  if (e.key === 'Escape' && state.rowMenu) { // 「⋯」選單 Esc 關，焦點回那顆「⋯」
    const { cat, id } = state.rowMenu;
    state.rowMenu = null;
    render();
    const more = [...document.querySelectorAll('.rowmore')].find((x) => x.dataset.cat === cat && x.dataset.id === id);
    more?.parentElement.querySelector('.wf')?.focus(); // 「⋯」平常收著（display:none 叫不動 focus）：先聚焦同列讓 :focus-within 亮出來
    more?.focus();
    // 註：滑鼠點開再按 Esc 也會把焦點放回「⋯」（該列鉛筆與「⋯」留著顯示到焦點移走），刻意不分鍵盤／滑鼠
    return;
  }
  if (e.key === 'Escape' && state.rename) { if (!state.rename.busy) { state.rename = null; render(); } return; } // 改名浮窗：Esc 關；存到一半不關
  if (e.key === 'Escape' && state.memModal) { state.memModal = null; render(); return; } // 卡片浮窗：Esc 關
  if (e.key === 'Escape' && state.flowMemOpen) { state.flowMemOpen = false; render(); return; } // 記憶浮窗：Esc 關
  if (e.key === 'Escape' && state.flowSettingsOpen) { state.flowSettingsOpen = false; render(); return; } // 流程設定浮窗：Esc 關
  if (e.key === 'Escape' && state.sharedOpen) { state.sharedOpen = false; render(); return; } // 共用檔浮窗：Esc 關
  if (e.key === 'Escape' && state.dash?.usageOpen) { state.dash.usageOpen = false; render(); return; } // 用量明細浮窗：Esc 關
  if (e.key === 'Escape' && state.promptView) { state.promptView = null; render(); return; } // 執行頁卷宗浮窗：Esc 關
  if (e.key === 'Escape' && state.settings?.confirm && !state.settings.busy) { state.settings.confirm = null; render(); return; } // 清空記憶的二次確認（M5b）：Esc 關
  if (e.key === 'Escape' && state.preview) { state.preview = null; render(); return; } // 成品預覽浮窗：Esc 關
  if (e.key === 'Escape' && state.calPicker) { state.calPicker = null; render(); return; } // 快速跳月浮層：Esc 關
  if (e.key === 'Escape' && state.calMore) { state.calMore = false; render(); return; } // 行事曆「⋯」Esc 關
  if (e.key === 'Escape' && !e.isComposing && state.drawerOpen && document.querySelector('.stepmodal')) { if (state.stepAsk) hideStepAsk(); else if (stepModalDirty()) showStepAsk(); else { closeStepModal(); render(); } return; } // 步驟彈窗 Esc 關；L12：有未套用改動先問（詢問開著再按 Esc＝繼續編輯）
  if (state.mode !== 'canvas' || state.run || state.dash || state.calendar || state.categoryPage || state.settings) return; // 儀表板/行事曆/分類頁/設定頁蓋在上面時畫布不收快捷鍵
  if (document.querySelector('.stepmodal')) return; // 彈窗開著，復原／重做／存檔不動到後面的畫布
  if (cvKeyDelete(e)) return; // 點線選取後 Delete＝剪線
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.target.matches?.('input, textarea, select, [contenteditable]')) return;
  const k = e.key.toLowerCase();
  if (k === 'z') { e.preventDefault(); if (e.shiftKey) cvRedo(); else cvUndo(); }
  else if (k === 'y') { e.preventDefault(); cvRedo(); }
  else if (k === 's') { e.preventDefault(); cvSave(); }
});

// 關頁前的最後防線。聊天草稿與成品卡已經隨打隨存進瀏覽器，重新整理不會丟——所以「只在真的會丟東西時」才攔：
// ①畫布還有未存檔改動（工作本沒進瀏覽器，照舊一律攔）②沒存的東西存不進瀏覽器（隱私模式、配額滿、認不得資料夾）
window.addEventListener('beforeunload', (e) => {
  dsSaveNow(); // 節流還沒到期的那一次，關頁前補寫進去
  if (state.cvDirty || dsAtRisk() || [...wsByFlow.values()].some((p) => p.cvDirty)) { e.preventDefault(); e.returnValue = ''; } // 別條流程暫存包裡的未存改動也算
});

app.addEventListener('focusout', (e) => {
  if (e.target.matches?.('[data-pedit]') && state.editingParam) commitParamEdit(e.target);
  if (e.target.id === 'cvcond-edit' && state.cvCondEdit && !rendering) cvCondFinish(e.target.value, true); // 條件格點到別處＝存（重繪換掉的不算）
});

// 權限列亮框動畫一跑完就收（比 1.5 秒的計時器準；計時器留著兜底，例如系統關掉動畫時）
app.addEventListener('animationend', (e) => {
  if (e.target.id === 'perm-files' && e.animationName === 'permflash') {
    state.permFlashUntil = 0;
    e.target.classList.remove('flash');
  }
});

// 多行框：邊打邊存進 state.keep（重繪後放回）＋自動長高
app.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches?.('[data-keep]')) state.keep[keepKey(t.id)] = t.value;
  if (t.matches?.('[data-shape-input]')) { // 成品卡七格常駐輸入框——打字寫回 state（輪詢重繪讀 state 不洗字），依據小字就地換、不整頁重繪
    shapeInput(t.dataset.shapeInput, t.value);
    const b = t.closest('label')?.querySelector('.basis');
    const cell = state.chat.shape?.[t.dataset.shapeInput];
    if (b && cell) b.textContent = BASIS_TXT[cell.basis] ?? cell.basis;
  }
  if (t.id === 'rename-name' && state.rename) state.rename.value = t.value; // 改名浮窗：打字寫回 state，輪詢重繪讀回、錯了紅字也不洗字
  if (t.matches?.('textarea.autogrow')) autoGrow(t);
  if (t.dataset?.param !== undefined) { // 「本次資料」邊打邊存＋句內膠囊就地同步（不等 change、不重繪）；點過的卡被改字＝取消核可
    state.paramNow[t.dataset.param] = t.value;
    syncParamChips(t.dataset.param, t.value);
    memParamEdited(t.dataset.param, t.value);
    scheduleHealth(); // 停 600ms 重算健檢，只補畫健檢卡
  }
  if (t.id === 'run-note') state.runNote = t.value; // 本次補充寫回 state（跟著這條 Workflow 的暫存包走）
  if (t.id === 'cal-pick-year' && state.calPicker && /^\d{4}$/.test(t.value)) { // 年份直接打：存進 state、月格就地更新
    state.calPicker.year = Number(t.value);
    patchCalPickerGrid();
  }
  // 設定頁的編輯表單：身分名字、角色／片段的名字與內容每打一字寫進 state，重繪從它還原
  if (t.id === 'lib-search' && state.library) { // 流程庫頁搜尋：只換卡片格，不整頁重繪
    state.library.q = t.value;
    const g = document.getElementById('lib-grid');
    if (g) g.innerHTML = libraryCardsHtml();
  }
  if (t.dataset?.idf && state.settings?.idEdit) state.settings.idEdit[t.dataset.idf] = t.value;
  if (t.dataset?.pf && state.assets?.edit) state.assets.edit[t.dataset.pf] = t.value;
  // 多組織：移出確認——打對名字才解鎖那顆鈕。就地改 disabled、不整頁重繪，字才不會被輪詢洗掉
  if (t.dataset?.orgKill !== undefined) {
    const go = document.getElementById('org-kill-go');
    if (go) go.disabled = t.value.trim() !== t.dataset.orgKill;
  }
  keepModalField(t);
  dsSchedule(); // 打字（聊天框、成品卡七格、本次資料）不一定重繪，這裡也排一次寫入
});

// 行事曆浮窗表單暫存：排程視窗 sc-*／步驟浮窗 sm-* 每個欄位一改就寫進各自的 form——
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
  if (e.target.id === 'lib-dept' && state.library) { // Workflow 庫部門下拉（ 取代膠囊 lib-cat）：同搜尋只換卡片格
    state.library.cat = e.target.value;
    const g = document.getElementById('lib-grid');
    if (g) g.innerHTML = libraryCardsHtml();
  }
  // 標題列「搬到別的部門」下拉退場（驗收第 5 條：移至部門在「⋯」選單，走 moveWorkflowTo）
  if (e.target.dataset?.act === 'param-label' && state.wf && !subjectIsDraft()) { // 執行需要的資料：欄位名稱改完即 PUT 定義（key 不變，只改 label）
    const label = e.target.value.trim();
    delete state.keep[keepKey(e.target.id)];
    const def = structuredClone(state.wf.def);
    const p = def.params.find((x) => x.key === e.target.dataset.key);
    if (p && label && label !== p.label) {
      p.label = label;
      try {
        await api('PUT', wfPath(state.wf), { def });
        state.wf.def = def;
      } catch (err) { window.alert(err.message); }
    }
    render(); // 空白或沒改＝撥回原名
  }
  if (e.target.id === 'shape-category') { // 成品卡分類下拉：只進 state，W1 第二趟 body 帶它；W2：部門規範數跟著分類換，再讀一遍
    state.chat.category = e.target.value;
    state.chat.refs = null;
    refreshShapeRefs();
  }
  if (e.target.id === 'save-category') {
    const newInput = document.getElementById('save-new-category');
    if (newInput) newInput.style.display = e.target.value === '__new__' ? '' : 'none';
  }
  if (e.target.id === 'mem-identity') { // 這次以哪個身分跑：隨「開始」送出；換了身分重抓這條流程會帶什麼（兩格、抽屜一列跟著變，M5a）
    state.memIdentity = e.target.value;
    state.memIdentitySet = true;
    await refreshWfMemory();
    render();
  }
  if (e.target.id === 'set-company-name' && state.settings?.data) { // 設定→資料 公司名稱：change 即 PUT；成功同步側欄／麵包屑／公司頁用的 state.companyName；失敗一句＋重繪撥回現值
    const s = state.settings;
    const name = e.target.value.trim();
    try {
      await api('PUT', '/api/settings', { company_name: name });
      s.data.cfg.company_name = name;
      state.companyName = name;
      s.msg = { key: 'company', text: name ? `改好了，側欄與麵包屑現在叫「${name}」。` : '清空了，改顯示「組織」。' };
    } catch (err) { s.msg = { key: 'company', text: err.message, err: true }; }
    render();
  }
  // 設定頁：身分編輯的勾選寫進 state（不重繪）；詞典改性質即 PUT；合併的「併進哪個」記住
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
  if (e.target.dataset?.upload !== undefined && state.wf && !subjectIsDraft()) { // 欄位「每次上傳檔案」勾選：直接存進定義（input:'file'，取消＝拿掉鍵）
    const def = structuredClone(state.wf.def);
    const p = def.params.find((x) => x.key === e.target.dataset.upload);
    if (!p) return;
    if (e.target.checked) p.input = 'file'; else delete p.input;
    await api('PUT', wfPath(state.wf), { def });
    state.wf.def = def;
    render();
  }
  if (e.target.dataset?.presetFor && e.target.value) {
    const p = (state.presets[e.target.dataset.presetField] ?? []).find((x) => x.name === e.target.value);
    const target = document.getElementById(e.target.dataset.presetFor);
    if (p && target) { target.value = p.text; target.dispatchEvent(new Event('input', { bubbles: true })); } // 複製式：填入後各改各的；走 input 存進暫存字，輪詢重繪不洗掉
    e.target.value = '';
  }
});

// 成品卡的「照著像的舊作品」。草稿這時還沒進 Workflow 庫（沒有可以掛檔案的地方），
// 所以先擱在 state.chat.sample，存進庫那一刻才真的上傳成流程參考檔。
document.getElementById('sample-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.chat.shape) return;
  try {
    // 檔名與大小在這裡就擋掉。等到按儲存才炸的話，流程已經存好、
    // 拆解器也已經把這個檔名寫進 attachments，留下一個永遠找不到檔的設定。
    const bad = badSampleName(file.name);
    if (bad) { window.alert(bad); return; }
    if (file.size > 10 * 1024 * 1024) { window.alert('這份檔案超過 10MB，剝繭存不下——換一份小一點的，或把它放進 Workflow 的參考檔。'); return; }
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    state.chat.sample = { name: file.name, b64: btoa(bin) };
    render();
  } catch (err) {
    window.alert(err.message);
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
    repaintAside(); // 側欄「流程參考檔」也從這顆「上傳參考檔」進來——只換側欄，抽屜開著時不整頁重繪
  } catch (err) {
    window.alert(err.message);
  }
});

// 公司頁／部門頁共用檔上傳——層與區看 state.sharedUpload；規範區前端先擋副檔名（句子同伺服器），伺服器再擋一次；
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

let backDown = null; // 步驟彈窗背景點一下才關——記住按下點（框內選字拖到遮罩放開，click 目標也是遮罩）
app.addEventListener('pointerdown', (e) => { backDown = e.target; }, true);
app.addEventListener('click', async (e) => {
  // 說明鈕就地開合——不進 state 也不重繪（重繪會搶輸入焦點、也拖慢），
  // 點任何地方都先把已經釘住的關掉，再決定要不要開自己這一顆。
  const hintBtn = e.target.closest('.hint');
  document.querySelectorAll('.hint[aria-expanded="true"]').forEach((h) => { if (h !== hintBtn) h.setAttribute('aria-expanded', 'false'); });
  if (hintBtn) {
    hintBtn.setAttribute('aria-expanded', hintBtn.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
    return;
  }
  const pv = e.target.closest('.pchip.pv');
  if (pv) {
    state.editingParam = pv.dataset.pkey;
    render();
    const ed = document.querySelector('[data-pedit]');
    if (ed) { ed.focus(); ed.select(); }
    return;
  }
  // 快速跳月浮層：點浮層外就關（點的若是別的動作，關掉後照常執行；el 已從 closest 取得，重繪不影響）
  if (state.calPicker && !e.target.closest('#cal-picker') && !e.target.closest('[data-act="cal-pick"]')) {
    state.calPicker = null;
    render();
  }
  // 行事曆「⋯」點外面就關（同上）
  if (state.calMore && !e.target.closest('.calmore') && !e.target.closest('[data-act="cal-more"]')) {
    state.calMore = false;
    render();
  }
  // 「⋯」選單點外面就關（點的若是別的動作，關掉後照常執行）
  if (state.rowMenu && !e.target.closest('.rowmenu') && !e.target.closest('[data-act="row-menu"]')) {
    state.rowMenu = null;
    render();
  }
  // 多組織：側欄組織切換浮層點外面就關（同上）
  if (state.orgMenu && !e.target.closest('.org-menu') && !e.target.closest('[data-act="org-menu"]')) {
    state.orgMenu = false;
    render();
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  try {
    if (act === 'reconnect') { await refreshHealth(); render(); }
    // ===== 側欄 Workflow 列「⋯」選單與共用素材入口 =====
    else if (act === 'row-menu') {
      const { cat, id, name } = el.dataset;
      if (state.rowMenu?.cat === cat && state.rowMenu.id === id) { state.rowMenu = null; render(); return; } // 再點同一顆＝關
      state.rowMenu = { cat, id, name, ...rowMenuPos(el.getBoundingClientRect(), window.innerWidth, window.innerHeight), sub: false };
      render();
      document.querySelector('.rowmenu [data-act]')?.focus(); // 鍵盤開的也能接著 Tab／Enter
    } else if (act === 'row-move-open') {
      state.rowMenu.sub = !state.rowMenu.sub;
      render();
      document.querySelector(state.rowMenu.sub ? '.rowmenu [data-act="row-move"]' : '.rowmenu [data-act="row-move-open"]')?.focus();
    } else if (act === 'row-move') {
      const { cat, id } = state.rowMenu;
      state.rowMenu = null;
      await moveWorkflowTo(cat, id, el.dataset.to);
      render();
    } else if (act === 'row-copy') {
      const { cat, id } = state.rowMenu;
      state.rowMenu = null;
      await copyWorkflow(cat, id);
      render();
    } else if (act === 'row-export') {
      const { cat, id } = state.rowMenu;
      state.rowMenu = null;
      render();
      window.location.href = `${wfPath({ category: cat, id })}/export`; // 同 export-wf 語意（附件下載，不離開頁面）
    } else if (act === 'open-assets') { await openAssets(); } // 共用素材整頁
    // ===== 儀表板=====
    else if (act === 'open-dash') {
      clearTimeout(state.pollTimer);
      closeCalendar();
      closeCategory();
      closeSettings(); closeLibrary(); closeAssets();
      stashWorkspace(); // 離開工作區先打包（畫布未存改動也帶著，不再問「丟掉？」）
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
      // 執行頁右欄「當時指示」：抓這一步的卷宗全文→state.promptView→重繪（浮窗掛 .layout 外，輪詢重繪不會關）
      const w = state.run.workflow;
      let text;
      try { text = (await api('GET', `/api/workflows/${encodeURIComponent(w.category)}/${encodeURIComponent(w.id)}/runs/${state.run.run_id}/prompts/${encodeURIComponent(el.dataset.pname)}`)).text; }
      // 兩種情況都會讀不到，講清楚是哪一種，不要讓人以為是壞了
      catch (err) { text = `讀不到這一步的指示。可能是這一步還沒送出過工作單，也可能這一趟是「每步留存指示」上線前跑的——那時候沒有存。\n\n（${err?.message ?? err}）`; }
      state.promptView = { title: el.dataset.ptitle, text };
      render();
    }
    // ===== 成品預覽浮窗＋文字成品排版=====
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
    // ===== 交貨查核=====
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
    // ===== 行事曆=====
    else if (act === 'open-calendar') {
      clearTimeout(state.pollTimer);
      closeDash();
      closeCategory();
      closeSettings(); closeLibrary(); closeAssets();
      stashWorkspace(); //
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
    } else if (act === 'cal-more') {
      state.calMore = !state.calMore;
      render();
    } else if (act === 'cal-refresh') {
      state.calMore = false;
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
        closeSettings(); closeLibrary(); closeAssets();
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
      if (f.retry === '') delete n.retry; else n.retry = Number(f.retry); // 0＝明確選「不重試」，不是沒設
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
      // 開機自啟開關搬到設定→執行與排程→常駐；狀態在 state.settings.data.autostart，失敗一句原因、畫面不假成功
      const s = state.settings;
      try { s.data.autostart = await api('POST', '/api/autostart', { enabled: !(s.data.autostart?.enabled === true) }); } catch (err) { window.alert(err.message); }
      render();
    } else if (act === 'open-settings-exec') { await openSettings('執行與排程'); }
    else if (act === 'notices-toggle-done') { e.preventDefault(); state.noticesOpen = !state.noticesOpen; render(); }
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
      closeSettings(); closeLibrary(); closeAssets();
      stashWorkspace(); // 離開的那條先打包，換到這條的包（沒有＝預設），免得前一條的聊天／欄位值黏到這條
      state.wf = { category: cat, id, def: await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}`), runs: [] };
      restoreWorkspace(`${cat}/${id}`);
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
      closeSettings(); closeLibrary(); closeAssets();
      const cat = el.dataset.cat;
      const id = el.dataset.id;
      stashWorkspace(); // 同 todo-go
      state.wf = { category: cat, id, def: await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}`), runs: await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}/runs`) };
      restoreWorkspace(`${cat}/${id}`);
      state.mode = 'list';
      await refreshProposals(state.wf);
      state.wfFiles = await api('GET', `${wfPath(state.wf)}/files`); // U4b：這條路不走 openWorkflow，側欄的參考檔與資料夾要是這條流程的（原本 wfFiles 會留上一條的）
      await refreshFolder();
      render();
    }
    // ===== 群組圈分類頁=====
    else if (act === 'open-category') {
      e.preventDefault(); // 移植第一批 T9：summary 上的文字＝開分類頁，不讓 details 原生收合（樹不跳動）
      clearTimeout(state.pollTimer);
      closeCalendar();
      closeDash();
      closeCategory();
      closeSettings(); closeLibrary(); closeAssets();
      stashWorkspace(); //
      state.run = null;
      state.showTrash = false;
      state.corrupt = null;
      state.importPreview = null;
      state.sharedOpen = false; // U4b：從共用檔浮窗「去部門頁管理」進來的，回流程頁時浮窗不該還開著
      state.categoryPage = { category: el.dataset.cat, data: null, cards: [], err: null, saving: false, saveErr: null };
      render();
      await loadCategoryPage();
      render();
    } else if (act === 'open-company') { // 側欄公司節點／麵包屑第一節→公司頁（分類頁特例）
      clearTimeout(state.pollTimer);
      closeCalendar();
      closeDash();
      closeCategory();
      closeSettings(); closeLibrary(); closeAssets();
      stashWorkspace(); //
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
      closeSettings(); closeLibrary(); closeAssets();
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
    } else if (act === 'shared-upload') { // 記下層與區，再開檔案選擇（規範區只列 md／txt／docx，參考區任何檔）
      const cp = state.categoryPage;
      state.sharedUpload = { scope: cp.category, kind: el.dataset.kind };
      const input = document.getElementById('shared-file');
      input.accept = el.dataset.kind === 'rule' ? '.md,.txt,.docx' : '';
      input.click();
    } else if (act === 'shared-view') { // 組織頁／部門頁共用檔「查看」——開既有預覽浮窗
      await openSharedPreview(state.categoryPage.category, el.dataset.name);
    } else if (act === 'shared-del') { // 刪共用檔不進垃圾桶；參考類會順帶取消步驟裡的勾選（伺服器回 unlinked_steps）
      const cp = state.categoryPage;
      const { kind, name } = el.dataset;
      const layer = cp.category === '_company' ? '全組織每一條 Workflow' : `「${catLabel(cp.category)}」分類的每一條 Workflow`;
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
      // 已有一份沒存的草稿（暫存的，或正在看的）→先問；丟掉＝不進暫存
      const onDraft = !state.wf && subjectIsDraft();
      if ((onDraft || wsByFlow.has('__draft__')) && !window.confirm('已有一份沒存的草稿，要丟掉重來嗎？')) return;
      closeCalendar();
      closeDash();
      closeCategory();
      closeSettings(); closeLibrary(); closeAssets();
      if (onDraft) state.chat = emptyChat();
      stashWorkspace();
      wsByFlow.delete('__draft__');
      state.wf = null;
      state.run = null;
      state.chat = emptyChat();
      state.paramNow = {};
      state.editingParam = null;
      state.canvasSel = null;
      state.drawerOpen = false;
      state.cvShowIssues = false;
      state.cvWork = null;
      state.cvDirty = false;
      state.mode = 'chat';
      render();
    } else if (act === 'open-draft') { // 側欄「草稿・還沒存」列→讀回暫存的新流程草稿
      clearTimeout(state.pollTimer);
      closeCalendar();
      closeDash();
      closeCategory();
      closeSettings(); closeLibrary(); closeAssets();
      stashWorkspace();
      state.wf = null;
      state.run = null;
      state.showTrash = false;
      state.corrupt = null;
      state.importPreview = null;
      state.editingParam = null;
      state.cvShowIssues = false;
      restoreWorkspace('__draft__');
      if (state.chat.shape && !state.chat.refs) refreshShapeRefs(); // 卡是離開後才回來的→補抓卡底數字
      render();
    } else if (act === 'drop-draft') { // 側欄草稿列旁的「丟掉」——問一次，連瀏覽器裡存的那份一起清掉
      if (!window.confirm('丟掉這份還沒存的草稿？裡面的對話與成品卡都會不見，救不回來。')) return;
      wsByFlow.delete('__draft__');
      if (!state.wf) { state.chat = emptyChat(); state.savingDraft = false; }
      dsSaveNow();
      render();
    } else if (act === 'del-wf-row') {
      const { cat, id, name } = el.dataset;
      if (state.rowMenu) { state.rowMenu = null; render(); } // 從「⋯」選單點的，先收選單再問
      if (!window.confirm(`把「${name}」移到垃圾桶？30 天內都能復原。`)) return;
      await api('DELETE', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}`, undefined);
      wsByFlow.delete(`${cat}/${id}`);
      if (state.wf && state.wf.category === cat && state.wf.id === id) {
        state.wf = null;
        state.run = null;
        state.chat = emptyChat();
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
    } else if (act === 'step-pick') { // 清單卡「查看」＝只選取，右欄檢視器換成這一步（不開編輯）
      state.canvasSel = el.dataset.node;
      state.inspectorTab = 'step';
      render();
    } else if (act === 'inspector-tab') { // 右欄檢視器分頁：只換右欄，不整頁重繪
      state.inspectorTab = el.dataset.tab === 'data' ? 'data' : 'step';
      const box = app.querySelector('.work .right');
      if (box) box.outerHTML = inspectorHtml(); else render();
    } else if (act === 'history-tab') {
      state.historyTab = el.dataset.tab === 'versions' ? 'versions' : 'runs';
      render();
    } else if (act === 'send-chat') await sendChat();
    else if (act === 'shape-confirm') {
      // 「照這樣拆」＝第二趟——卡上確認過的七格、來源、分類下拉帶回去拆；拆好 sendChat 會清卡
      // 檔案種類與參考作品跟著第二趟下去——拆解器要照它定最後一步的 output_file 與 attachments
      await sendChat({
        phase: 'draft', shape: state.chat.shape, sources: state.chat.sources, category: state.chat.category,
        // 沒動過就不要送——硬塞 md 會把「最後一步是寄信」這種流程也逼著掛檔案屬性
        output_file: state.chat.fileKind, sample_name: state.chat.sample?.name ?? null,
      });
    } else if (act === 'shape-kind') {
      // 就地改（不整頁重繪，重繪會把七格打字中的焦點搶掉）
      state.chat.fileKind = el.dataset.kind;
      for (const b of document.querySelectorAll('[data-act="shape-kind"]')) {
        const on = b.dataset.kind === state.chat.fileKind;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      }
      const unit = document.getElementById('shape-len-unit');
      if (unit) unit.textContent = lenUnit(state.chat.fileKind);
    } else if (act === 'shape-sample') {
      document.getElementById('sample-file').click();
    } else if (act === 'shape-sample-del') {
      state.chat.sample = null;
      render();
    } else if (act === 'shape-redo') {
      // 「重擬」＝同一句重送第一趟；明帶 phase 伺服器永遠只跑一趟（開關關掉也不連跑），卡上改的格子不帶回去
      await sendChat({ phase: 'shape' });
    }
    else if (act === 'clear-draft') {
      state.chat = emptyChat();
      state.savingDraft = false;
      dsSaveNow(); // 清掉的東西不留在瀏覽器裡
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
      // 卡上選的舊作品現在才有地方放——存進庫之後補上傳成這條 Workflow 的參考檔。
      // 上傳失敗不擋存檔（流程本身已經存好了），只講一句；檔案沒上去＝拆解器寫進 attachments 的名字會找不到檔。
      const sample = state.chat.sample;
      let uploadedFiles = null;
      if (sample) {
        try {
          // 回應本來就帶最新的檔案清單——接住它，不然剛存好的 Workflow 頁會說「還沒有參考檔」
          const up = await api('POST', `${wfPath({ category: saved.category, id: saved.id })}/files`, { name: sample.name, content_b64: sample.b64 });
          uploadedFiles = up?.files ?? null;
        } catch (err) {
          window.alert(`Workflow 存好了，但那份舊作品沒上傳成功：${err.message}\n到 Workflow 頁的參考檔再上傳一次就好。`);
        }
      }
      state.chat = emptyChat();
      state.savingDraft = false;
      await refreshLibrary();
      // dict_similar：欄位名跟詞典裡的很像——只提醒不擋，掛在這條流程上，換流程就消失
      state.wf = { category: saved.category, id: saved.id, def, runs: [], dictSimilar: saved.dict_similar ?? [] };
      state.versions = await api('GET', `${wfPath(state.wf)}/versions`);
      await refreshProposals(state.wf);
      state.wfFiles = uploadedFiles ?? [];
      state.mode = 'list';
      dsSaveNow(); // 已經存進 Workflow 庫了，瀏覽器裡那份草稿同時清掉
      render();
    } else if (act === 'cv-new-blank') {
      state.chat.draft = { format: 1, name: '新 Workflow', params: [], nodes: [makeTask('第一步')] };
      state.canvasSel = state.chat.draft.nodes[0].id;
      window.BJCanvas.resetView();
      render();
    } else if (act === 'add-category') {
      state.addingCategory = true;
      render();
      document.getElementById('new-category')?.focus();
    } else if (act === 'cancel-category') { // 組織頁行內表單的取消
      state.addingCategory = false;
      delete state.keep[keepKey('new-category')];
      render();
    } else if (act === 'confirm-category') {
      const name = document.getElementById('new-category').value.trim();
      if (!name) return;
      await api('POST', '/api/categories', { name });
      state.addingCategory = false;
      delete state.keep[keepKey('new-category')];
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
      await openWorkflow(el.dataset.cat, el.dataset.id); // 畫布未存改動進暫存包，不再問「丟掉？」
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
        try { pf = await preflightNow(state.wf.def, { ...healthValues(state.wf.def), ...overrides }); } catch { /* 健檢端點讀不到：交給 POST /runs 的 409 兜底 */ } // 上傳欄位的值＝上傳好的檔名
        if (pf?.issues?.length) {
          state.startCheck = { key: defKey, level: pf.issues.some((i) => i.level === 'block') ? 'block' : 'warn', issues: pf.issues };
          render();
          return;
        }
      }
      state.startCheck = null;
      let run;
      try {
        // （M3b）：點了的習慣卡＝核可、點了又改掉的、身分，隨開跑一起送
        run = await api('POST', `${wfPath(state.wf)}/runs`, { overrides, ...memStartFields(overrides), ...runStartExtras() }); // ＋本次上傳與本次補充
      } catch (err) {
        if (err.status === 409 && Array.isArray(err.body?.issues)) { // 後端兜底擋下：用同一張卡顯示
          state.startCheck = { key: defKey, level: 'block', issues: err.body.issues };
          render();
          return;
        }
        throw err;
      }
      state.run = run;
      state.runUploads = {}; // token 已用掉（檔跟著這一趟存）；補充也只給這一趟
      state.runNote = '';
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
      // 習慣選項 chip：點了＝把卡的內容填進那一格、記成核可；再點同一張＝取消（值留著）；換一張＝換核可
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
    } else if (act === 'pf-recheck') { // 健檢卡「重新檢查」
      recheckHealth();
    } else if (act === 'run-upload') { // 選檔→上傳進暫存區
      const key = el.dataset.key;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = RUN_UPLOAD_ACCEPT;
      input.addEventListener('change', () => { if (input.files[0]) uploadRunFile(key, input.files[0]); });
      input.click();
    } else if (act === 'run-upload-del') {
      delete state.runUploads[el.dataset.key];
      render();
      recheckHealth();
    } else if (act === 'pf-fix') {
      if (el.dataset.kind === 'node') { // 開那一步的抽屜
        state.flowTab = 'design'; // 健檢卡常駐在本次資料，步驟彈窗只在設計分頁畫得出來
        state.canvasSel = el.dataset.id;
        state.drawerOpen = true;
        render();
      } else if (el.dataset.kind === 'flow') {
        // 流程層設定（目前只有產檔權限開關）：亮 1.5 秒＋捲到它。狀態驅動——class 由 permRowHtml 依 permFlashUntil 帶、
        // 捲動在 render() 尾端對新元素做，中途任何整頁重繪（通知輪詢等）都不會把亮框和捲動弄丟
        if (state.flowTab === 'data') state.dataCard = 'execution'; // 本次資料分頁的三開關在任務卡裡，展開它再亮、再捲
        else state.flowSettingsOpen = true; // 移植第一批 T10：三開關在浮窗裡，先開浮窗再亮、再捲
        state.permFlashUntil = Date.now() + 1500;
        render();
        setTimeout(() => {
          state.permFlashUntil = 0;
          if (!isTyping()) render(); // 到期拿掉 class（動畫本身已跑完，打字中就留到下次重繪）
        }, 1500);
      } else { // 捲到那個欄位並聚焦
        if (state.flowTab === 'data' && state.dataCard !== 'data') { state.dataCard = 'data'; render(); } // 欄位與上傳框在「填寫這次的值」卡裡，先展開它才找得到
        const t = app.querySelector(`[data-param="${CSS.escape(el.dataset.id)}"], [data-upload-box="${CSS.escape(el.dataset.id)}"] button`); // 上傳欄位捲到上傳框
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
    // ===== 就地看：「這步用了 N 條」展開、卡片浮窗、儀表板第一列 =====
    else if (act === 'mem-toggle') {
      state.memOpen[el.dataset.node] = !state.memOpen[el.dataset.node];
      render();
    } else if (act === 'mem-card') { await openMemCard(el); }
    else if (act === 'mem-modal-close' || (act === 'mem-modal-back' && e.target === el)) { state.memModal = null; render(); }
    else if (act === 'mem-retire' || act === 'mem-del') { await memCardAction(act === 'mem-retire' ? 'retire' : 'del'); }
    else if (act === 'open-settings-memory') { await openSettings('個人與記憶', '記憶總覽'); }
    // ===== 設定頁：容器、個人與記憶分頁、卡片浮窗的「改」 =====
    else if (act === 'open-settings') { await openSettings(state.settings?.group ?? '個人與記憶'); }
    else if (act === 'open-library') { openLibrary(); }
    else if (act === 'cv-more') { e.preventDefault(); const d = el.closest('details'); if (d) { d.open = !d.open; state.cvMore = d.open; } } // 抽屜收摺：只動 DOM 與 state，不 render（打到一半的字不洗掉）
    else if (act === 'flow-tab') { state.flowTab = el.dataset.tab === 'data' ? 'data' : 'design'; render(); } // 移植第一批 T10
    // 在本次資料分頁，三開關就在「確認執行選項」任務卡裡（展開它，不開浮窗——同一組 id 不重複出現在 DOM）
    else if (act === 'flow-settings') { if (state.flowTab === 'data') state.dataCard = 'execution'; else state.flowSettingsOpen = true; render(); }
    else if (act === 'data-card') { const c = el.dataset.card; state.dataCard = state.dataCard === c ? null : c; render(); }
    else if (act === 'flow-settings-close') { if (!el.classList.contains('pvback') || e.target === el) { state.flowSettingsOpen = false; render(); } }
    else if (act === 'flowmem-open') { state.flowMemOpen = true; render(); }
    else if (act === 'flowmem-close') { if (!el.classList.contains('pvback') || e.target === el) { state.flowMemOpen = false; render(); } }
    // ===== 流程頁右側資料夾、共用檔浮窗、本次資料收摺 =====
    else if (act === 'folder-toggle') {
      // details 的開合：讓瀏覽器原生切換，只把「切換後」的值記進 state（下次重繪讀回）；不整頁 render——本次資料打到一半的值不洗
      const d = el.closest('details');
      if (d) state.folderOpen[el.dataset.k] = !d.open;
    }
    // ===== 執行頁三欄 =====
    else if (act === 'run-inspect') {
      // 左軌點步驟＝切成那一步的歷史視圖（demo runPage 的 inspect）；點目前這步存 null 不存它的 id——不然跑到下一步時會彈成歷史
      const node = el.dataset.node;
      state.runInspect = node === currentNodeOf(state.run) && state.run.status !== 'done' ? null : node; // 跑完的 run 點最後一步＝看它的歷史
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
    // ===== 三層改名浮窗（公司／部門／流程）=====
    else if (act === 'rename-open') {
      e.preventDefault(); // summary 內的鉛筆：不讓 details 原生切換
      const type = el.dataset.type;
      const cat = el.dataset.cat ?? '';
      const id = el.dataset.id ?? '';
      const value = type === 'company' ? (state.companyName ?? '') : type === 'category' ? cat : (state.workflows.find((w) => w.category === cat && w.id === id)?.name ?? state.wf?.def?.name ?? '');
      state.rename = { type, cat, id, value, err: null, busy: false };
      render();
      const inp = document.getElementById('rename-name');
      if (inp) { inp.focus(); inp.select(); }
    }
    else if (act === 'rename-close') { if ((!el.classList.contains('pvback') || e.target === el) && !state.rename?.busy) { state.rename = null; render(); } }
    else if (act === 'rename-save') { await renameSave(); }
    else if (act === 'cat-toggle') { // 側欄分類箭頭：只收合／展開，不開頁；擋掉 summary 的原生切換，狀態走 state.catClosed
      e.preventDefault();
      const c = el.dataset.cat;
      if (state.catClosed.has(c)) state.catClosed.delete(c); else state.catClosed.add(c);
      render();
    }
    else if (act === 'set-group') { state.settings.group = el.dataset.g; state.settings.merge = null; state.settings.msg = null; render(); }
    else if (act === 'set-tab') { state.settings.tab[el.dataset.g] = el.dataset.k; state.settings.merge = null; state.settings.msg = null; render(); }
    // ===== 設定頁後四組：新流程的預設／執行與排程的開關即 PUT；連線、資料的動作走既有 API =====
    else if (act === 'set-def-sw') { const k = el.dataset.k; await setPut({ defaults: { [k]: state.settings.data.cfg.defaults?.[k] === false } }); }
    else if (act === 'set-compose-sw') { await setPut({ compose: { confirm_shape: state.settings.data.cfg.compose?.confirm_shape === false } }); } // 缺值視為開，反轉
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
          s.msg = { key: 'trash', text: `復原了，回到 Workflow 庫的「${catLabel(back.category)}」。` };
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
    else if (act === 'intro-open') { state.intro = { saving: false, err: null }; closeSettings(); closeLibrary(); closeAssets(); render(); } // 關於你頁還沒介紹過→重開三題（答完 POST /api/memory/intro 照舊）
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
    } else if (act === 'assets-tab') { state.assets.tab = el.dataset.t; render(); } // 共用素材頁（原設定→素材庫的列表改刪，搬成整頁卡片）
    else if (act === 'asset-new') {
      state.assets.edit = { field: state.assets.tab === '常用片段' ? 'snippet' : 'role_context', orig: null, name: '', text: '', err: null };
      render();
      document.querySelector('.assetcard.editing [data-pf="name"]')?.focus();
    } else if (act === 'asset-edit') {
      const p = (state.presets[el.dataset.field] ?? []).find((x) => x.name === el.dataset.name);
      state.assets.edit = { field: el.dataset.field, orig: p.name, name: p.name, text: p.text, err: null };
      render();
    } else if (act === 'asset-cancel') { state.assets.edit = null; render(); }
    else if (act === 'asset-save') {
      const e2 = state.assets.edit;
      try {
        if (!e2.name.trim() || !e2.text.trim()) throw new Error('要有名字和內容才能存');
        await api('POST', '/api/presets', { field: e2.field, name: e2.name.trim(), text: e2.text });
        if (e2.orig && e2.orig !== e2.name.trim()) await api('DELETE', `/api/presets/${encodeURIComponent(e2.field)}/${encodeURIComponent(e2.orig)}`, undefined); // 改名＝存新的、刪舊名
        state.assets.edit = null;
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
    } else if (act === 'time-quick') {
      const box = document.getElementById('time-at');
      if (box) { box.value = el.dataset.at; state.keep[keepKey('time-at')] = box.value; box.focus(); }
    } else if (act === 'time-set') {
      const at = document.getElementById('time-at')?.value ?? '';
      if (!at) { document.getElementById('time-at')?.focus(); return; }
      await resumeTimeCall(el.dataset.node, at);
    } else if (act === 'time-now') {
      await resumeTimeCall(el.dataset.node, null); // 不帶時刻＝現在就放行往下跑
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
      state.feedbackSent = out.memory_notice ?? true; // （M2）：回覆照它講記成什麼；舊伺服器沒回就照舊「收到」
      pollProposalsSoon(state.run.workflow);
      await refreshRun(); // 頁頂那一行「記下來了…不要記」從 run 讀，剛寫進去的要重抓才看得到
    }
    // ===== （M2）：首次三題介紹、通知「不要記」=====
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
      if (el.classList.contains('pvback') && (e.target !== el || backDown !== el)) return; // 背景點一下＝關——只認按下與放開都在遮罩本身（框內點冒泡上來、框內選字拖到外面放開都不算）
      // 有未套用改動——背景不關只閃框；✕／取消先問；詢問列的「丟掉」（data-discard）才真的丟
      if (!el.dataset?.discard && stepModalDirty()) { if (el.classList.contains('pvback')) nudgeStepModal(); else showStepAsk(); return; }
      closeStepModal(); // 重開同一顆也回預設；未套用的改動丟掉（同原抽屜「關閉」）
      render();
    } else if (act === 'step-ask-cancel') {
      hideStepAsk();
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
      state.stepAsk = false; // 詢問列的「套用」也走這裡
      let flip = false; // 換了「你來處理」＝窗留著（重繪換出對應欄位）；其餘套用成功就關窗（樣稿 applyEdit）
      await canvasOp((def) => {
        const n = def.nodes.find((x) => x.id === state.canvasSel);
        if (!n) return;
        n.title = document.getElementById('cv-title')?.value.trim() || n.title;
        const instr = document.getElementById('cv-instruction')?.value;
        if (instr !== undefined) n.instruction = instr;
        if (kindOf(n) === 'task') {
          const ex = document.getElementById('cv-human').checked ? 'human' : 'ai';
          flip = ex !== n.executor;
          if (flip) state.stepSnap = null; // 換執行者留窗——canvasOp 重繪後重記開窗值（欄位換了一批）
          n.executor = ex;
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
          // 0 是「馬上停下來問我」這個明確選擇，不是「沒設」——當成假值刪掉的話，執行時
          // node.retry ?? settings.defaults.retry 會去吃全域預設，變成自動重試，正好跟使用者選的相反
          const rt = document.getElementById('cv-retry');
          if (rt) { if (rt.value === '') delete n.retry; else n.retry = Number(rt.value); }
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
          // 擇一怎麼挑、每條線的條件、入口（等全部／任一條到）——欄位有畫出來才寫
          const chooseEl = document.getElementById('cv-choose');
          if (chooseEl) cvSetChoose(def, n.id, chooseEl.value);
          for (const inp of document.querySelectorAll('[data-cond-arm]')) cvSetCond(def, n.id, inp.dataset.condTo, inp.value, Number(inp.dataset.condArm));
          const mergeEl = document.getElementById('cv-merge');
          if (mergeEl) cvSetEntry(def, n.id, mergeEl.value);
        }
        if (kindOf(n) === 'branch') {
          for (const inp of app.querySelectorAll('[data-branch-label]')) {
            const b = n.branches[Number(inp.dataset.branchLabel)];
            if (b && inp.value.trim()) b.label = inp.value.trim();
          }
        }
      });
      if (flip) dropStepKeep(); else { closeStepModal(); render(); } // 沒存成（canvasOp 丟錯）走不到這裡：窗與打到一半的字都留著
    } else if (act === 'cv-delete') {
      await canvasOp((def) => {
        removeNodeSimple(def, state.canvasSel);
      });
    } else if (act === 'cv-convert') {
      await canvasOp((def) => cvConvert(def, state.canvasSel)); // 使用者按了才轉舊寫法，不自動改寫
      closeStepModal();
      render();
    } else if (act === 'cv-dissolve') {
      await canvasOp(() => {}); // 空編輯：normalize 會把舊式 fork/join 拆直
    } else if (act === 'cv-help') { // 「？」操作說明浮層，只切 hidden 不重繪
      state.cvHelp = !state.cvHelp;
      const hp = app.querySelector('.cvhelp');
      if (hp) hp.hidden = !state.cvHelp;
      el.setAttribute('aria-expanded', state.cvHelp ? 'true' : 'false');
    } else if (act === 'cv-tidy') { // 09-18 第 5 條：畫布工具列「整理排列」
      cvTidy();
    } else if (act === 'cv-undo') {
      await cvUndo();
    } else if (act === 'cv-redo') {
      await cvRedo();
    } else if (act === 'cv-save') {
      await cvSave();
    } else if (act === 'export-wf') {
      window.location.href = `${wfPath(state.wf)}/export`;
    } else if (act === 'pick-import') {
      // 只開選檔；選到檔才關頁（在 import-file 的 change 裡）——取消選檔＝留在 Workflow 庫
      document.getElementById('import-file').click();
    } else if (act === 'cancel-import') { // 從 Workflow 庫發起的匯入，「不匯入」回 Workflow 庫
      const back = state.importFromLib;
      state.importFromLib = false;
      state.importPreview = null;
      if (back) openLibrary();
      else render();
    } else if (act === 'confirm-import') {
      if (canvasLeaveBlocked()) return; // 匯入完會切到新流程——畫布未存檔先問
      const saved = await api('POST', '/api/import/confirm', { def: state.importPreview.def, schedule: state.importPreview.schedule ?? null });
      state.importPreview = null;
      state.importFromLib = false;
      await refreshLibrary();
      const def = await api('GET', wfPath(saved));
      state.wf = { ...saved, def, runs: [] };
      state.versions = await api('GET', `${wfPath(saved)}/versions`);
      await refreshProposals(state.wf);
      state.mode = 'list';
      render();
    } else if (act === 'view-trash') {
      state.trashFromLib = !!state.library; // 從 Workflow 庫進來的，「回 Workflow 庫」回庫頁
      closeCalendar();
      closeDash();
      closeCategory();
      closeSettings(); closeLibrary(); closeAssets();
      state.showTrash = true;
      state.corrupt = null;
      render();
    } else if (act === 'close-trash') {
      const back = state.showTrash && state.trashFromLib;
      state.showTrash = false;
      state.corrupt = null;
      state.trashFromLib = false;
      if (back) openLibrary();
      else render();
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
      wsByFlow.delete(flowKey(state.wf));
      state.chat = emptyChat();
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
    // ===== 多組織：側欄切換器＋設定頁組織管理。一律追加在鏈尾，不動上面任何一支 =====
    else if (act === 'org-menu') {
      state.orgMenu = !state.orgMenu;
      render();
      if (state.orgMenu) document.querySelector('.org-menu [data-act]')?.focus(); // 鍵盤開的也能接著 Tab／Enter
    } else if (act === 'org-manage') {
      state.orgMenu = false;
      await openSettings('資料管理');
    } else if (act === 'org-go') {
      const { id } = el.dataset;
      state.orgMenu = false;
      if (id === state.orgId) { render(); return; } // 點的是現在這個＝只關浮層
      dsSaveNow(); // 等下要整頁重載，節流（500ms）還沒到期的那次先補寫進去，免得剛打的字跟著重載沒了
      await api('PUT', '/api/orgs/current', { id });
      // 整頁重載，不逐一清 state：state 有 40+ 欄位（開著的流程、畫布工作本、暫存包、輪詢計時器），漏一個就串到別的組織。
      // 重載走既有 init()，本機 <100ms；順帶讓 dsBind 換成新組織的資料夾＝沒存的草稿也跟著各歸各的
      //（各組織的鍵在開站清殘骸時互不相清，見 dsLiveKeys：切走再切回來，這邊沒存的字還在）
      location.reload();
    } else if (act === 'org-add') {
      const s = state.settings;
      const name = (kept('org-new-name') ?? '').trim();
      s.busy = 'org';
      s.msg = null;
      render();
      try {
        const made = await api('POST', '/api/orgs', { name });
        delete state.keep[keepKey('org-new-name')];
        await refreshCompanyName(); // 清單多一個（側欄切換器也是這一下才出現）
        s.busy = null;
        // 後端 seedExamples 對每個新組織都種 2 條「範例」Workflow，訊息不能說「它現在是空的」
        s.msg = { key: 'org', text: `建好了：「${made.name}」。裡面附了 2 條「範例」Workflow（週報、季報）可以直接看，不想要就刪掉；切過去就能開始建自己的。` };
        if (window.confirm(`「${made.name}」建好了。要現在切過去嗎？`)) {
          await api('PUT', '/api/orgs/current', { id: made.id });
          location.reload();
          return;
        }
      } catch (err) {
        s.busy = null;
        s.msg = { key: 'org', text: err.message, err: true };
      }
      render();
    } else if (act === 'org-kill') {
      state.orgKill = el.dataset.id;
      delete state.keep[keepKey('org-kill-name')]; // 換一個組織要移出：上一次打的字不算數
      render();
      document.getElementById('org-kill-name')?.focus();
    } else if (act === 'org-kill-cancel') {
      state.orgKill = null;
      delete state.keep[keepKey('org-kill-name')];
      render();
    } else if (act === 'org-kill-go') {
      const s = state.settings;
      try {
        const r = await api('DELETE', `/api/orgs/${encodeURIComponent(el.dataset.id)}`, undefined);
        state.orgKill = null;
        delete state.keep[keepKey('org-kill-name')];
        await refreshCompanyName();
        s.msg = { key: 'org', text: `移出了。整個資料夾搬到「${r.moved_to}」，沒有刪掉；要救回來把它搬回 data/orgs/ 就好。` };
      } catch (err) {
        s.msg = { key: 'org', text: err.message, err: true };
      }
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
  state.importFromLib = !!state.library; // 記住從 Workflow 庫發起（「不匯入」與掃描失敗回庫頁）
  closeCalendar(); // 匯入預覽畫面在儀表板／行事曆／分類頁／設定頁／Workflow 庫之下，開著時會看不到
  closeDash();
  closeCategory();
  closeSettings(); closeLibrary(); closeAssets();
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
  if (!state.importPreview && state.importFromLib) { state.importFromLib = false; openLibrary(); return; }
  render();
});

// 行事曆拖拉改時間：拖排程事件到別的日期格＝單次覆寫 move（保留原時分）
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
      if (before !== state.notices.unread.length && !isTyping() && !state.run) render();
    }
  } catch (e) { pollFailed('通知', e); }
  setTimeout(noticePollGlobal, 30000);
}

// ---------- 啟動 ----------
(async function init() {
  await refreshHealth();
  await refreshCompanyName(); // 側欄根節點的名字
  await refreshLibrary();
  dsLoad(); // 上次沒存完的草稿讀回來（側欄「草稿・還沒存」那列）；要在 refreshLibrary 之後，已經不在庫裡的那份才判得掉
  try {
    state.presets = await api('GET', '/api/presets');
  } catch { /* 常用庫讀不到就先空著 */ }
  try {
    applyNotices(await api('GET', '/api/notices'));
  } catch { /* 通知讀不到就先空著 */ }
  // （M2）：還沒介紹過自己（也沒跳過）→三題先蓋在儀表板前；摘要讀不到就不問，照開儀表板
  try {
    if (!(await api('GET', '/api/memory/summary')).intro_done) state.intro = { saving: false, err: null };
  } catch { /* 讀不到就當問過了 */ }
  // 預設首頁＝儀表板（定案第 5 點）：有事先看到事
  state.dash = { data: null, usageView: 'flow', open: {}, promptView: null, usageOpen: false, showAll: false, calendar: null };
  render();
  try {
    await loadDash();
  } catch { /* 首屏載不到照開，各區顯示空狀態 */ }
  render();
  dashPoll();
  setTimeout(noticePollGlobal, 30000);
})();
