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
  dataSupplyOpen: null, // 資料不全卡「我補給你」展開中的節點 id
  editRulesOpen: null,  // 「後面每步會守」清單改寫中的節點 id（交貨查核輪）
  keep: {},            // 打字中的多行內容（run_id:元素id → 文字）——整頁重繪後放回，不被輪詢吃掉
  runJson: null,       // 上次抓到的 run 原文——輪詢只在真的變了才重繪
  // ---- 產檔輪（T5）----
  preview: null,       // 成品預覽浮窗 {cat,id,rid,name,data,err,sheet}——狀態在這，輪詢重繪不會關掉它
  rendered: {},        // 文字成品排版快取：內容雜湊 → html（false＝這段排不出來，顯示原文）
  rawView: new Set(),  // 停點卡／成品區按了「看原文」的鍵
  permErr: null,       // 產檔權限開關沒存成的一句話
  permFlashUntil: 0,   // 健檢「修這裡」把權限列亮到幾點（毫秒）——狀態驅動，中途整頁重繪也不會掉 class
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
  const ta = app.querySelector(`[data-param="${CSS.escape(key)}"]`);
  if (ta && ta.value !== val) { ta.value = val; autoGrow(ta); }
}

// ---------- 宿主狀態 ----------
async function refreshHealth() {
  try {
    state.claude = (await api('GET', '/api/health')).claude;
  } catch {
    state.claude = false;
  }
  hostdot.hidden = false;
  hostdot.className = `chip ${state.claude ? 'green' : 'red'}`;
  hostdot.innerHTML = state.claude
    ? '<i class="ph-fill ph-plugs-connected"></i>Claude 已連上'
    : '<i class="ph ph-plugs"></i>Claude 連不上';
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
function sideHtml() {
  const byCat = {};
  for (const c of state.categories) byCat[c] = [];
  for (const w of state.workflows) (byCat[w.category] ??= []).push(w);
  const catHtml = Object.entries(byCat).map(([cat, wfs]) => `
    <div class="cat"><div class="nm">${esc(cat)}</div>
      ${wfs.map((w) => `<div class="wf ${state.wf && !state.calendar && !subjectIsDraft() && w.id === state.wf.id && w.category === state.wf.category ? 'now' : ''}"
        data-act="open" data-cat="${esc(w.category)}" data-id="${esc(w.id)}">
        <i class="${state.wf && w.id === state.wf.id && w.category === state.wf.category ? 'ph-fill' : 'ph'} ph-flow-arrow"></i><span class="wfname">${esc(w.name)}</span>
        <i class="ph ph-trash wfdel" data-act="del-wf-row" data-cat="${esc(w.category)}" data-id="${esc(w.id)}" data-name="${esc(w.name)}" title="移到垃圾桶"></i></div>`).join('')}
    </div>`).join('');
  const adder = state.addingCategory
    ? `<div style="display:flex;gap:4px;margin-top:4px"><input id="new-category" class="notein" style="margin:0" placeholder="分類名稱">
       <button class="btn btn-primary" style="padding:6px 10px" data-act="confirm-category">建立</button></div>`
    : `<div class="addcat" data-act="add-category"><i class="ph ph-plus"></i>新增分類</div>`;
  return `<aside class="side"><h4>我的流程庫</h4>
    <div class="wf calentry ${state.dash ? 'now' : ''}" data-act="open-dash">
      <i class="${state.dash ? 'ph-fill' : 'ph'} ph-gauge"></i><span class="wfname">儀表板</span>
      ${state.notices.unread.length ? '<span class="reddot" title="有新通知"></span>' : ''}</div>
    <div class="wf calentry ${state.calendar ? 'now' : ''}" data-act="open-calendar">
      <i class="${state.calendar ? 'ph-fill' : 'ph'} ph-calendar-blank"></i><span class="wfname">行事曆</span></div>
    <div class="newflow" data-act="new-flow"><i class="ph ph-plus-circle"></i>建立新流程</div>
    ${catHtml}${adder}
    <div class="addcat" data-act="pick-import"><i class="ph ph-upload-simple"></i>匯入別人的流程檔</div>
    <div class="wf" style="margin-top:var(--s3);color:var(--ink-400)" data-act="view-trash"><i class="ph ph-trash"></i>垃圾桶（${state.trash.length}）</div>
  </aside>`;
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
    ? `<span class="chip green"><i class="ph-fill ph-seal-check"></i>v${state.versions.at(-1).version} · 現行</span>` : '';
  const catOptions = state.categories.map((c) =>
    `<option value="${esc(c)}" ${state.wf && c === state.wf.category ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const wfCtrls = !subjectIsDraft() && state.wf ? `
      <select id="move-select" class="moveselect" title="搬到別的分類">${catOptions}</select>
      <span class="btn iconb" data-act="export-wf" title="匯出成單一檔案"><i class="ph ph-export"></i></span>
      <span class="btn iconb btn-danger" data-act="delete-wf" title="移到垃圾桶，30 天內可復原"><i class="ph ph-trash"></i></span>` : '';
  return `<div class="tophead"><h3>${esc(title)}</h3>${draftChip}${verChip}</div>
    <div class="headrow">${modeSeg()}<span class="right">${wfCtrls}</span></div>${permRowHtml()}${checkRowHtml()}`;
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
function checkRowHtml() {
  if (subjectIsDraft() || !state.wf) return '';
  const on = state.wf.def.check?.enabled !== false;
  return `<div class="permrow checkrow ${on ? 'on' : ''}" id="check-delivery">
    <label class="switch" title="${on ? '點一下關掉' : '點一下打開'}"><input type="checkbox" data-act="check-toggle" ${on ? 'checked' : ''} aria-label="每步交貨先查"><span class="knob"></span></label>
    <span class="permtxt"><b>每步交貨先查</b>
      <span class="permnote">每個 AI 步驟做完先對照原始資料與你的要求；攔到會自動重做一次，還錯才停下問你。關掉就不查、也不多花 token。</span></span>
  </div>`;
}

// ---------- 聊天模式 ----------
function chatModeHtml() {
  const bubbles = state.chat.messages.map((m) => {
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
        <button class="btn btn-ghost" data-act="clear-draft">清掉重來</button>
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
      <span class="chip ${n.executor === 'human' ? 'violet' : 'blue'}">${n.executor === 'human' ? '你來' : 'AI'}</span>
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
  return `更新「${p.change.node_title}」這步的做法？`;
}

function proposalsHtml() {
  const { pending, more } = state.proposals;
  if (!pending.length || subjectIsDraft()) return '';
  const cards = pending.map((p) => `<div class="card proposal" style="margin-bottom:var(--s3)">
    <div class="overline" style="margin-bottom:4px">它想學一招 · 依據：${esc(p.evidence)}</div>
    <b>${esc(proposalText(p))}</b>
    <div class="btns" style="margin-top:10px">
      <button class="btn btn-primary" data-act="accept-proposal" data-pid="${esc(p.id)}">好，以後都這樣</button>
      <button class="btn btn-ghost" data-act="reject-proposal" data-pid="${esc(p.id)}">不用，我看情況</button>
    </div>
  </div>`).join('');
  const moreNote = more ? `<p class="note" style="margin:0 0 8px">還有 ${more} 條想法，處理完這些再給你看。</p>` : '';
  return cards + moreNote;
}

function listModeHtml() {
  const def = subjectDef();
  if (!def) {
    return `<div class="empty-c"><div class="ic"><i class="ph ph-list-checks"></i></div>
      <h3>還沒選流程</h3><p>左邊挑一個打開，或切到「聊天」講一件你的事拆一個新的。</p>
      <button class="btn btn-primary" data-act="open" data-cat="範例" data-id="quarterly-report"><i class="ph ph-play"></i>跑跑看範例</button></div>`;
  }
  // 欄位值改多行框（T5）：單行時跟原本一樣高，貼一封信也放得下；「沒有步驟用到」chip 由健檢結果決定顯隱
  const unused = subjectIsDraft() ? [] : (preflightFor(def)?.unused_params ?? []);
  // 值列：placeholder＝該欄位的 hint（要貼什麼）；required 的標「必填」chip
  const paramRows = def.params.map((p) => `
    <div class="param"><span>${esc(p.label)}${p.required ? '<span class="chip req" title="開跑前健檢：這欄沒填不給跑">必填</span>' : ''}<span class="chip unusedchip" data-unused="${esc(p.key)}" ${unused.includes(p.key) ? '' : 'hidden'} title="這個欄位沒有任何步驟的指示引用到——填了也沒人看">沒有步驟用到</span></span>
      <textarea class="autogrow" rows="1" data-param="${esc(p.key)}" placeholder="${esc(p.hint ?? '')}">${esc(state.paramNow[p.key] ?? p.default)}</textarea></div>`).join('');
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
    const catOptions = state.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    const saveRow = state.savingDraft
      ? `<div class="saverow">
          <select id="save-category">${catOptions}<option value="__new__">＋ 新分類⋯</option></select>
          <input id="save-new-category" class="notein" style="margin:0;display:none;width:130px" placeholder="新分類名稱">
          <button class="btn btn-primary" data-act="confirm-save-draft">存進去</button>
          <button class="btn btn-ghost" data-act="cancel-save-draft">取消</button>
        </div>`
      : `<div class="saverow">
          <button class="btn btn-primary" data-act="save-draft"><i class="ph ph-tray-arrow-down"></i>存進流程庫</button>
          <button class="btn btn-ghost" data-act="clear-draft">清掉重來</button>
        </div>`;
    return `<div class="sub">草稿——想調哪裡切「聊天」用講的，或切「畫布」直接拉。</div>
      ${stepListHtml(def)}
      ${def.params.length ? `<div class="params"><h5>可調欄位 · 每次開跑前能微調</h5>${def.params.map((p) => `<div class="param"><span>${esc(p.label)}</span><span class="chip">${esc(p.default)}</span></div>`).join('')}</div>` : ''}
      ${saveRow}`;
  }
  return `<div class="sub">這份流程會存起來，愈用愈準。</div>
    ${resumeHtml()}
    ${proposalsHtml()}
    ${stepListHtml(def)}
    <div class="params"><h5>這次的設定 · 只影響這一次</h5>${paramRows || '<p class="note" style="margin:0">這份流程沒有可調欄位。</p>'}</div>
    <div class="params"><h5>欄位 · 會存進流程</h5>${fieldRows}${addParam}</div>
    ${startCheckHtml()}
    <div class="runbtn"><button class="btn btn-primary" style="padding:11px 44px" data-act="start" ${state.claude === false ? 'disabled title="先把 Claude 連上"' : ''}><i class="ph-fill ph-play"></i>開始</button></div>`;
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
      <option value="">常用⋯</option>
      ${list.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')}
    </select>
    <span class="pbtn" data-act="preset-save" data-field="${field}" data-target="${targetId}" title="把目前欄位內容存成常用"><i class="ph ph-star"></i>存常用</span>
    <span class="pbtn" data-act="preset-del" data-field="${field}" data-target="${targetId}" title="刪掉上面選中的常用"><i class="ph ph-minus-circle"></i></span>
  </div>`;
}

function textFieldHtml(id, label, val, ph, presetField) {
  return `<div class="flabel">${label}</div>
    ${presetField ? presetRowHtml(presetField, id) : ''}
    <textarea id="${id}" class="feedbackin advarea" placeholder="${esc(ph)}">${esc(val ?? '')}</textarea>`;
}

// 參考檔區（D19）：勾選＝這一步的附件；範本填空選一檔
function refFilesInner(n, checkedOverride) {
  const files = state.wfFiles ?? [];
  const att = checkedOverride ?? new Set(n.attachments ?? []);
  // .docx／.xlsx 參考檔＝產檔範本（產檔輪）：檔名旁標「範本」，產出規格頁「範本填空」選它就叫工人套用
  const rows = files.map((f) => `<label class="refrow"><input type="checkbox" data-att="${esc(f)}" ${att.has(f) ? 'checked' : ''}><span class="wfname">${esc(f)}${/\.(docx|xlsx)$/i.test(f) ? '<span class="tplchip" title="Word／Excel 範本：在「產出規格」頁選為範本，工人會照它產檔">範本</span>' : ''}</span>
    <i class="ph ph-trash wfdel2" data-act="ref-del" data-name="${esc(f)}" title="刪掉這個參考檔"></i></label>`).join('');
  return `<div class="flabel">參考檔（勾＝這一步會看）</div>
    <div class="reflist">${rows || '<p class="note" style="margin:0 0 4px">還沒有參考檔。</p>'}</div>
    <span class="pbtn" data-act="ref-upload"><i class="ph ph-upload-simple"></i>上傳參考檔</span>`;
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
  const checked = new Set([...document.querySelectorAll('[data-att]')].filter((c) => c.checked).map((c) => c.dataset.att));
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
// 版面（排程與健檢輪 T4）：頂部固定列（標題／誰來做／做完給你看／交出什麼／開跑時會拿到）＋中段（子頁內兩欄 grid）＋底部固定列（套用／刪除／關閉）
function canvasEditorHtml(n, def) {
  const kind = kindOf(n);
  const titleRow = `<input id="cv-title" class="notein" style="margin:0;flex:1;min-width:160px" value="${esc(n.title)}" placeholder="這一步叫什麼">`;
  const closeBtn = '<button class="btn" data-act="cv-close-drawer" style="margin-left:auto">關閉</button>';
  if (kind === 'task') {
    const isAI = n.executor === 'ai';
    // 頂部固定列：標題、誰來做、做完給你看、（人做）完成時要交出什麼、（AI）開跑時會拿到
    const head = `<div class="cvdtop">
      <div class="cvdrow">${titleRow}
        <select id="cv-executor" class="moveselect"><option value="ai" ${isAI ? 'selected' : ''}>AI 來做</option><option value="human" ${!isAI ? 'selected' : ''}>你來做</option></select>
        <label style="font-size:12.5px;display:flex;gap:4px;align-items:center;white-space:nowrap"><input type="checkbox" id="cv-stop" ${n.stop_point === 'always' ? 'checked' : ''}> 做完給你看</label>
      </div>
      ${isAI ? drawerInputsHtml(n, def) : `<div class="cvdrow"><span class="flabel" style="margin:0;white-space:nowrap">完成時要交出什麼</span>
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
    return `${head}
      <div class="seg segtabs" id="cv-tabs">
        <span class="${tab === 'content' ? 'on' : ''}" data-act="cv-tab" data-tab="content"><i class="ph ph-article"></i>任務內容</span>
        <span class="${tab === 'spec' ? 'on' : ''}" data-act="cv-tab" data-tab="spec"><i class="ph ph-sliders-horizontal"></i>產出規格</span>
      </div>
      <div class="cvpage cvdbody ${tab === 'content' ? '' : 'off'}" id="cv-page-content">
        <div class="cvcol">
          ${textFieldHtml('cv-instruction', '任務——這一步要做什麼', n.instruction, '這一步要做什麼', null)}
          ${textFieldHtml('cv-role', '角色情境', n.role_context, '例：你是資深客服主管，語氣專業溫和', 'role_context')}
          ${textFieldHtml('cv-bg', '背景資料', n.background, '這一步需要知道的固定背景', null)}
        </div>
        <div class="cvcol">
          ${textFieldHtml('cv-constraints', '限制條件', n.constraints, '不可違反的規則，例：不承諾具體賠償金額', 'constraints')}
          ${textFieldHtml('cv-examples', '範例', n.examples, '貼一段理想產出的樣子，AI 會照著寫', null)}
          ${reviewHtml}
          ${refFilesSectionHtml(n)}
        </div>
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
  if (!state.drawerOpen || state.run || !(state.mode === 'list' || state.mode === 'canvas')) return '';
  const def = cvDef();
  const n = def?.nodes.find((x) => x.id === state.canvasSel);
  if (!n) return '';
  if (state.drawerTabFor !== n.id) { state.drawerTab = 'content'; state.drawerTabFor = n.id; } // 換節點回預設頁
  // 刻意簡化（T4）：原本頂部的「指示句人話預覽」拿掉——整幅雙欄要把垂直空間留給欄位；句子在清單／畫布上本來就看得到
  return `<div class="cvdrawer full"><div class="cvdhead"><span class="overline">步驟細節</span>
      <button class="btn btn-ghost iconb" data-act="cv-close-drawer"><i class="ph ph-x"></i></button></div>
    ${canvasEditorHtml(n, def)}</div>`;
}

// 抽屜頂部「開跑時會拿到」（T5）：只給 AI 步驟；清單來自 /api/preflight 的 inputs，空的標紅
function drawerInputsHtml(n, def) {
  if (kindOf(n) !== 'task' || n.executor !== 'ai') return '';
  const pf = preflightFor(def);
  if (!pf) {
    if (preflightCache.failed && preflightCache.key === JSON.stringify(def)) return '<div id="drawer-inputs"></div>'; // 健檢讀不到就不佔位
    return '<div id="drawer-inputs" class="dinputs"><div class="overline">開跑時會拿到</div><div class="note" style="margin:2px 0 0">檢查中⋯</div></div>';
  }
  const ICON = { upstream: 'ph-arrow-bend-down-right', human: 'ph-user', param: 'ph-sliders-horizontal', attachment: 'ph-paperclip' };
  const WRAP = {
    upstream: (x) => `上一步《${x}》的產出`,
    human: (x) => `《${x}》（你來做）交出的內容`,
    param: (x) => `設定欄位：${x}`,
    attachment: (x) => `參考檔：${x}`,
  };
  const items = (pf.inputs?.[n.id] ?? []).map((s) => {
    const raw = String(s.label ?? s.id);
    // 後端的 label 已是整句（含《》／「設定欄位：」）就照用；只給名字才由這裡包句子
    const txt = /《|^設定欄位：|^參考檔：/.test(raw) ? raw : (WRAP[s.kind] ?? ((x) => x))(raw);
    return `<li><i class="ph ${ICON[s.kind] ?? 'ph-dot'}"></i>${esc(txt)}</li>`;
  }).join('');
  return `<div id="drawer-inputs" class="dinputs"><div class="overline">開跑時會拿到</div>
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
      ${v.version === cur ? '<span class="chip green">現行版</span>' : `<span class="backb" data-act="rollback-version" data-version="${v.version}"><i class="ph ph-arrow-counter-clockwise"></i>退回這版</span>`}
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
    case 'done': return `<span class="chip green"><i class="ph-fill ph-check-circle"></i>完成${step.edited_output != null ? ' · 你改過' : ''}</span>`;
    case 'running': return '<span class="chip blue"><span class="thinking">進行中⋯</span></span>';
    case 'waiting_review': return '<span class="chip amber"><i class="ph-fill ph-hand-pointing"></i>等你過目</span>';
    case 'waiting_human': return '<span class="chip violet"><i class="ph-fill ph-user"></i>這步你來</span>';
    case 'waiting_branch': return '<span class="chip amber"><i class="ph ph-arrows-split"></i>等你選路</span>';
    case 'waiting_data': return '<span class="chip red"><i class="ph-fill ph-warning"></i>資料不全停住</span>';
    case 'failed': return '<span class="chip red"><i class="ph-fill ph-warning"></i>出狀況停住</span>';
    case 'skipped': return '<span class="chip" style="opacity:.6">跳過</span>';
    default: return '<span class="chip">等待</span>';
  }
}

// 查核結果 chip（交貨查核輪）：missing 由資料不全卡呈現、off／skipped 不標；usage＝這一步的查核用量 {input,output}
const CHECK_CHIP = {
  pass: ['green', 'ph-fill ph-shield-check', '查過'],
  'redo-pass': ['green', 'ph-fill ph-arrows-clockwise', '重做過一次'],
  blocked: ['red', 'ph-fill ph-hand-palm', '查核攔下'],
  incomplete: ['amber', 'ph-fill ph-warning', '未完成查核'],
  accepted: ['', 'ph ph-check', '你說就這樣過'],
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
  return `<span class="chip green expander filechip" data-act="preview-file" data-cat="${esc(cat)}" data-id="${esc(id)}" data-rid="${esc(rid)}" data-fname="${esc(name)}" title="${esc(note ?? '點開看內容，浮窗裡可下載')}"><i class="ph ${FILE_ICON[ext] ?? 'ph-file-text'}"></i>${esc(name)}</span>`;
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

function stopCardHtml(node, step) {
  if (state.editingNode === node.id) {
    return `<div class="card hold" style="margin:10px 0">
      <b>「${esc(node.title)}」——直接在下面這格改，改完往下</b>
      <textarea id="edit-output" class="output-edit">${esc(step.output)}</textarea>
      <input id="edit-note" class="notein" placeholder="（選填）一句話說你改了什麼——它之後會來問你要不要學起來">
      <div class="btns" style="margin-top:8px">
        <button class="btn btn-primary" data-act="edit" data-node="${esc(node.id)}">用改過的版本往下</button>
        <button class="btn btn-ghost" data-act="cancel-edit">取消，不改了</button>
      </div>
    </div>`;
  }
  // 成品排版（產檔輪）：預設看排版、可切原文；有產出檔就給 chip 點開預覽。「我改一下」的框仍用原文
  const w = state.run.workflow;
  const key = `stop:${node.id}`;
  const fileChip = step.file ? fileChipHtml(w.category, w.id, state.run.run_id, step.file, step.file_note) : '';
  return `<div class="card hold" style="margin:10px 0">
    <b>「${esc(node.title)}」做好了，給你過目</b>
    ${node.review_focus ? `<div class="sub" style="margin:6px 0"><i class="ph ph-list-magnifying-glass"></i> 檢查重點：${esc(node.review_focus)}</div>` : ''}
    <div class="outbar">${fileChip}${mdToggleHtml(key)}</div>
    ${mdBlock(step.output, key)}
    <div class="btns">
      <button class="btn btn-primary" data-act="approve" data-node="${esc(node.id)}">往下</button>
      <button class="btn btn-secondary" data-act="start-edit" data-node="${esc(node.id)}">我改一下再往下</button>
      <button class="btn btn-ghost" data-act="back">先放著，晚點回來</button>
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
      <button class="btn btn-primary" data-act="human-done" data-node="${esc(node.id)}"><i class="ph ph-check"></i>完成了</button>
      <button class="btn btn-ghost" data-act="back">先放著，晚點回來</button>
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
    <div class="btns" style="margin-top:6px"><button class="btn btn-ghost" data-act="back">先放著，晚點回來</button></div>
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
      <button class="btn btn-primary" data-act="data-retry" data-node="${esc(node.id)}">我處理好了，重抓一次</button>
      <button class="btn btn-secondary" data-act="data-accept" data-node="${esc(node.id)}">就用現有的做，成品標注</button>
      ${supplyOpen ? '' : `<button class="btn btn-secondary" data-act="data-supply-open" data-node="${esc(node.id)}"><i class="ph ph-clipboard-text"></i>我補給你</button>`}
      <button class="btn btn-ghost" data-act="back">先放著，晚點回來</button>
    </div>
  </div>`;
}

// 查核卡（交貨查核輪）：重做一次仍被攔下——把原始資料那句與成品那句並排，三個出口＋先放著
function checkCardHtml(node, step) {
  if (state.editingNode === node.id) return stopCardHtml(node, step); // 「我改一下」沿用停點卡的編輯框
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
    <textarea id="check-note-${esc(node.id)}" class="feedbackin autogrow" data-keep placeholder="跟它講哪裡不對、要怎麼改；留空就是照查核結果重做">${esc(kept(`check-note-${node.id}`) ?? '')}</textarea>
    <div class="btns" style="margin-top:8px">
      <button class="btn btn-primary" data-act="check-retry" data-node="${esc(node.id)}"><i class="ph ph-arrows-clockwise"></i>回話重做</button>
      <button class="btn btn-secondary" data-act="check-accept" data-node="${esc(node.id)}">就這樣過</button>
      <button class="btn btn-secondary" data-act="start-edit" data-node="${esc(node.id)}">我改一下</button>
      <button class="btn btn-ghost" data-act="back">先放著，晚點回來</button>
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
        <button class="btn btn-primary" data-act="edit-rules-save" data-node="${esc(node.id)}">存起來</button>
        <button class="btn btn-ghost" data-act="edit-rules-cancel">取消</button>
      </div>
    </div>`;
  }
  const items = rules.map((r) => `<li>${esc(r.text)}${r.scope === 'this-step' ? '<span class="chip">只有這一步</span>' : ''}</li>`).join('');
  return `<div class="rules"><div class="rhead"><b>後面每步會守：</b>
      <span class="pbtn" data-act="edit-rules-open" data-node="${esc(node.id)}"><i class="ph ph-pencil-simple"></i>改一下</span></div>
    <ul>${items}</ul></div>`;
}

function failCardHtml(node, step) {
  return `<div class="alert red">
    <b><i class="ph-fill ph-warning"></i> 這一步出狀況，先停在這裡</b>
    <div class="why">${esc(step.error)}</div>
    <div class="btns"><button class="btn btn-primary" data-act="retry" data-node="${esc(node.id)}"><i class="ph ph-arrows-clockwise"></i>重試這步</button>
    <button class="btn btn-ghost" data-act="back">先放著，晚點回來</button></div>
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

  let rows = '';
  let seq = 0;
  for (const node of topoNodes(def)) {
    const step = run.steps[node.id];
    const kind = kindOf(node);
    if (kind === 'fork') continue;
    if (kind === 'join') {
      if (!isDone && !['done', 'skipped'].includes(step.status)) rows += joinBlockedCardHtml(node, run);
      continue;
    }
    seq++;
    if (kind === 'branch') {
      const chosenNote = step.choice
        ? `<span class="chip">走了「${esc(step.choice_label)}」${step.choice_by === 'user' ? '（你選的）' : ''}</span>` : '';
      const cls = step.status === 'done' ? 'done' : step.status === 'waiting_branch' ? 'halt' : step.status === 'running' ? 'running' : '';
      rows += `<div class="step ${cls}"><span class="n"><i class="ph ph-arrows-split"></i></span><b>${esc(node.title)}</b>
        <span class="chip amber">分岔</span>${chosenNote}<span class="pillslot">${stepPill(step)}</span></div>`;
      if (step.status === 'waiting_branch') rows += branchChoiceCardHtml(node);
      if (step.status === 'failed') rows += failCardHtml(node, step);
      continue;
    }
    const cls = step.status === 'done' ? 'done' : step.status === 'failed' ? 'errstep' : step.status.startsWith('waiting') ? 'halt' : step.status === 'running' ? 'running' : '';
    const dim = step.status === 'skipped' ? 'style="opacity:.55"' : '';
    const fileChip = step.file ? fileChipHtml(run.workflow.category, run.workflow.id, run.run_id, step.file, step.file_note) : '';
    rows += `<div class="step ${cls}" ${dim}><span class="n">${step.status === 'done' ? '<i class="ph ph-check"></i>' : step.status === 'skipped' ? '—' : seq}</span><b>${esc(node.title)}</b>
      <span class="chip ${node.executor === 'human' ? 'violet' : 'blue'}">${node.executor === 'human' ? '你來' : 'AI'}</span>
      <span class="pillslot">${fileChip}${checkChip(step, run.usage_by_node?.[node.id]?.check)}${stepPill(step)}</span></div>`;
    if (step.file_note && step.file) rows += `<p class="note" style="margin:2px 0 6px 20px">${esc(step.file_note)}</p>`;
    rows += flagsHtml(step);
    if (step.status === 'waiting_review') rows += stopCardHtml(node, step);
    if (step.status === 'waiting_check') rows += checkCardHtml(node, step);
    if (step.status === 'waiting_human') rows += humanCardHtml(node);
    if (step.status === 'waiting_data') rows += dataCardHtml(node, step);
    if (step.status === 'failed') rows += failCardHtml(node, step);
    if (step.status === 'done') rows += editRulesHtml(node, step);
  }

  let tail = '';
  if (isDone) {
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
      ? '<div class="card proposal"><b>收到。</b><span class="sub" style="margin:0">它會想想怎麼學起來——之後打開這個流程就會看到提議。</span></div>'
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
  const pill = isDone ? '<span class="chip green"><i class="ph-fill ph-check-circle"></i>全部完成</span>'
    : run.status === 'paused' ? '<span class="chip amber"><i class="ph-fill ph-hourglass-medium"></i>停著等你</span>'
      : `<span class="chip blue">第 ${Math.min(doneCount + 1, def.nodes.length)} 步</span>`;
  return `<div class="tophead"><h3>${title}</h3>${pill}<span class="backb" style="margin-left:auto" data-act="back"><i class="ph ph-caret-left"></i>回工作區</span></div>
    <div class="sub">${meta}</div>${rows}${tail}`;
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
  const [data, todos, notices] = await Promise.all([
    api('GET', '/api/dashboard?limit=12&days=30'),
    api('GET', '/api/todos'),
    api('GET', '/api/notices'),
  ]);
  if (!state.dash) return; // 載入途中已離開
  d.data = data;
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
      if (!typing && !state.preview) render(); // 預覽浮窗開著時不重繪（重繪會把浮窗捲回頂、pdf 重載）；關掉下一輪就補上
    } catch { /* 下一輪再試 */ }
    dashPoll();
  }, 5000);
}

// 待辦/通知動作後重載目前開著的頁面（儀表板或行事曆）
async function reloadPageData() {
  if (state.dash) await loadDash();
  else if (state.calendar) await loadCalendar();
}

// 待辦與通知的列（原行事曆側欄，儀表板輪搬家至此）
function todoRowsHtml() {
  return state.todos.map((t) => {
    let actions = '';
    if (t.kind === 'google_shift') {
      actions = `<button class="btn sm2 btn-primary" data-act="todo-shift" data-do="follow" data-shift='${esc(JSON.stringify(t.shift))}'>跟著移</button>
        <button class="btn sm2" data-act="todo-shift" data-do="keep" data-shift='${esc(JSON.stringify(t.shift))}'>保持原時間</button>`;
    } else if (t.kind === 'proposal') {
      actions = `<button class="btn sm2 btn-primary" data-act="todo-open-wf" data-cat="${esc(t.workflow.category)}" data-id="${esc(t.workflow.id)}">去看提議</button>`;
    } else {
      actions = `<button class="btn sm2 btn-primary" data-act="todo-go" data-cat="${esc(t.run.category)}" data-id="${esc(t.run.id)}" data-rid="${esc(t.run.run_id)}">去處理</button>`;
    }
    return `<div class="item ${t.tone}"><div class="ti">${esc(t.title)}</div><div class="de">${esc(t.desc)}</div><div class="acts">${actions}</div></div>`;
  }).join('');
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

// 最近完成卡：成品打頭；展開看整條步驟的中間產物與當時指示（卷宗）
function dashRunCard(r) {
  const key = `${r.category}/${r.id}/${r.run_id}`;
  const chip = r.status === 'done' ? '<span class="chip green"><i class="ph-fill ph-check-circle"></i>完成</span>'
    : r.status === 'running' ? '<span class="chip blue"><i class="ph ph-circle-notch"></i>進行中</span>'
      : r.steps.failed > 0 ? '<span class="chip red"><i class="ph ph-warning-circle"></i>有步驟失敗</span>'
        : '<span class="chip amber"><i class="ph ph-hand-palm"></i>等你處理</span>';
  const src = `${r.source === 'schedule' ? '排程自動' : '手動開跑'}${r.makeup ? '・補跑' : ''}`;
  const checkTok = (r.usage?.check?.input ?? 0) + (r.usage?.check?.output ?? 0);
  const usage = r.usage ? `<span class="chip" title="輸入 ${fmtInt(r.usage.input)}／輸出 ${fmtInt(r.usage.output)} tokens">${fmtInt(r.usage.input + r.usage.output)} tokens</span>${checkTok ? `<span class="chip" title="其中交貨查核花掉的">查核 ${fmtInt(checkTok)} token</span>` : ''}` : '';
  // 成品預覽走排版（產檔輪）；檔案 chip 點開預覽浮窗
  const finals = r.finals.map((f, i) => `<div class="final"><span class="ftitle"><i class="ph-fill ph-flag-checkered"></i> 成品・${esc(f.title)}${f.file ? `　${fileChipHtml(r.category, r.id, r.run_id, f.file)}` : ''}</span>
    ${mdBlock(`${f.preview}${f.preview.length >= 400 ? '⋯' : ''}`, `dash:${key}:${f.node ?? i}`, 'fprev')}</div>`).join('');
  const open = key in (state.dash.open ?? {});
  return `<div class="runcard">
    <div class="rchead"><b>${esc(r.name)}</b>${chip}
      <span class="rtime">${fmtWhen(r.finished_at ?? r.started_at)}・${src}・${r.steps.done}/${r.steps.total} 步</span>
      <span class="right">${usage}
        <button class="btn sm2" data-act="dash-expand" data-key="${esc(key)}" data-cat="${esc(r.category)}" data-id="${esc(r.id)}" data-rid="${esc(r.run_id)}">${open ? '收合' : '展開每一步'}</button>
        <button class="btn sm2 btn-primary" data-act="todo-go" data-cat="${esc(r.category)}" data-id="${esc(r.id)}" data-rid="${esc(r.run_id)}">打開</button></span></div>
    ${finals || (r.status === 'done' ? '<div class="railempty">這次執行沒有留下成品文字</div>' : '')}
    ${open ? dashStepRows(key) : ''}
  </div>`;
}

function dashStepRows(key) {
  const o = state.dash.open[key];
  if (!o) return '<div class="railempty">讀取中⋯</div>';
  const STEP_TXT = {
    done: ['green', '完成'], failed: ['red', '失敗'], skipped: ['', '略過'], pending: ['', '還沒跑'], running: ['blue', '進行中'],
    waiting_review: ['amber', '等你過目'], waiting_human: ['amber', '等你做'], waiting_branch: ['amber', '等你選路'],
    waiting_data: ['amber', '等補資料'], waiting_time: ['blue', '等時間到'], time_pending: ['amber', '時間未定'],
    waiting_check: ['red', '查核攔下'],
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

// 用量監控：近 30 天帳本，按流程或按日彙總
function usageSectionHtml(d) {
  const entries = d.data.usage ?? [];
  const KIND_TXT = { compose: '聊天建流程', scan: '匯入掃描', snapshot: 'Google 快照', optimize: '優化提議' };
  const inOf = (u) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const tot = entries.reduce((a, u) => ({ calls: a.calls + 1, input: a.input + inOf(u), output: a.output + (u.output_tokens ?? 0), cost: a.cost + (u.cost_usd ?? 0) }), { calls: 0, input: 0, output: 0, cost: 0 });
  const groups = new Map();
  for (const u of entries) {
    const gk = d.usageView === 'day'
      ? String(u.at ?? '').slice(0, 10)
      : (u.workflow ? wfNameOf(u.category, u.workflow) : (KIND_TXT[u.kind] ?? '其他'));
    const g = groups.get(gk) ?? { calls: 0, input: 0, output: 0, cost: 0 };
    g.calls += 1; g.input += inOf(u); g.output += u.output_tokens ?? 0; g.cost += u.cost_usd ?? 0;
    groups.set(gk, g);
  }
  const rows = [...groups.entries()]
    .sort((a, b) => (d.usageView === 'day' ? b[0].localeCompare(a[0]) : b[1].cost - a[1].cost))
    .map(([gk, g]) => `<tr><td>${esc(gk)}</td><td>${g.calls}</td><td>${fmtInt(g.input)}</td><td>${fmtInt(g.output)}</td><td>$${g.cost.toFixed(3)}</td></tr>`)
    .join('');
  const seg = `<span class="seg" style="margin-left:auto">
    <span class="${d.usageView === 'flow' ? 'on' : ''}" data-act="dash-usage-view" data-view="flow">按流程</span>
    <span class="${d.usageView === 'day' ? 'on' : ''}" data-act="dash-usage-view" data-view="day">按日</span></span>`;
  const body = entries.length
    ? `<div class="sub" style="margin-bottom:var(--s2)">近 ${d.data.usage_days ?? 30} 天：呼叫 ${tot.calls} 次・輸入 ${fmtInt(tot.input)}・輸出 ${fmtInt(tot.output)} tokens・約 $${tot.cost.toFixed(2)} 美元</div>
      <table class="usagetbl"><thead><tr><th>${d.usageView === 'day' ? '日期' : '流程／用途'}</th><th>次數</th><th>輸入 tokens</th><th>輸出 tokens</th><th>花費</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="railempty">還沒有用量紀錄——這次改版之後跑的才會記帳，舊紀錄沒有數字</div>';
  return `<section class="dashsec"><h4><i class="ph ph-chart-bar"></i>用量監控${seg}</h4>${body}</section>`;
}

function dashHtml() {
  const d = state.dash;
  if (!d.data) return '<div class="empty-c"><div class="skel" style="height:200px"></div></div>';
  const todoRows = todoRowsHtml();
  const cards = d.data.recent.map(dashRunCard).join('')
    || '<div class="railempty">還沒有任何執行紀錄——從左邊點開一條流程按「開始」</div>';
  const promptModal = d.promptView ? `<div class="modalback" data-act="dash-prompt-back"><div class="modal" style="max-width:680px">
      <div class="cvdhead"><b style="font-size:15px">當時送出的指示——${esc(d.promptView.title)}</b>
        <span class="btn btn-ghost iconb" data-act="dash-prompt-close" style="margin-left:auto"><i class="ph ph-x"></i></span></div>
      <pre class="promptpre">${esc(d.promptView.text)}</pre>
      <div class="saverow"><button class="btn" data-act="dash-prompt-close">關閉</button></div>
    </div></div>` : '';
  return `<div class="dashpage">
    <div class="dashhead"><h3 style="margin:0;font-size:17px;font-weight:800"><i class="ph ph-gauge"></i> 儀表板</h3>
      <span class="sub">任務有沒有正常進行，這一頁講完</span></div>
    <div class="dashtop">
      <section class="crs">
        <h4><i class="ph ph-check-square"></i>要你處理 <span class="cnt ${state.todos.length ? 'hot' : 'zero'}">${state.todos.length}</span></h4>
        <div class="crlist">${todoRows || '<div class="railempty">現在沒有等你的事</div>'}</div>
      </section>
      <section class="crs">
        <h4><i class="ph ph-bell"></i>系統通知 <span class="cnt ${state.notices.unread.length ? 'hotred' : 'zero'}">${state.notices.unread.length}</span></h4>
        <div class="crlist">${noticeSectionHtml()}</div>
      </section>
    </div>
    <section class="dashsec"><h4><i class="ph ph-flag-checkered"></i>最近完成的事</h4>${cards}</section>
    ${usageSectionHtml(d)}
    ${promptModal}
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
  const [data, notices, scheds, auto] = await Promise.all([
    api('GET', `/api/calendar?month=${c.month}`),
    api('GET', '/api/notices'), // 通知照抓：排程清單浮窗要標「設定有誤」＋側欄紅點
    api('GET', '/api/schedules'),
    api('GET', '/api/autostart').catch(() => null),
  ]);
  c.data = data;
  c.scheds = scheds;
  c.autostart = auto;
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
    <span class="t">${esc(e.time)}${badge ? `・${badge}` : ''}</span> ${esc(e.title)}${del}</div>`;
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
      <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" data-act="autostart-toggle" ${c.autostart?.enabled ? 'checked' : ''} ${c.autostart?.supported === false ? 'disabled' : ''}>
        開機自動啟動剝繭</label>
      <span>剝繭沒開著時排程不會跑；錯過的會在下次打開時問你要不要補。${c.autostart?.supported === false ? '（這個平台請自行手動啟動）' : ''}</span>
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
        : (s.enabled === false ? '<span class="chip amber">已暫停</span>' : '<span class="chip green">啟用中</span>');
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
      lead: typeof (sched?.remind_leads ?? [])[0] === 'string' ? sched.remind_leads[0] : '',
      makeup: !!sched?.auto_makeup,
      enabled: sched?.enabled !== false,
    });
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
        <span style="font-size:11.5px;color:var(--ink-400)">要加更多或自訂時刻，建立後點事件開抽屜</span></div>
      <div class="frow2"><span class="lb2">錯過的時候</span><label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px">
        <input type="checkbox" id="sc-makeup" ${f.makeup ? 'checked' : ''}>自動補跑（不勾＝先問我）</label></div>
      <div class="frow2"><span class="lb2">狀態</span><label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px">
        <input type="checkbox" id="sc-enabled" ${f.enabled ? 'checked' : ''}>啟用中（取消勾選＝暫停整條排程）</label></div>
      <p class="note">提前提醒在點開單次事件的抽屜裡設定；建立後會直接出現在行事曆上。</p>
      <div class="saverow"><button class="btn" data-act="sc-close">取消</button><button class="btn btn-primary" data-act="sc-save">${sched ? '儲存' : '建立排程'}</button></div>
    </div></div>`;
  }
  return html;
}

// ---------- render 與輪詢 ----------
let drawerWasOpen = false; // 上一次 render 時步驟抽屜是否開著（剛打開才捲進視野）
function render() {
  let inner;
  if (state.dash) inner = dashHtml();
  else if (state.calendar) inner = calendarHtml();
  else if (state.run) inner = runHtml();
  else if (state.importScanning) {
    inner = `<div class="empty-c"><div class="ic"><i class="ph ph-magnifying-glass"></i></div>
      <h3>正在掃描這份流程檔⋯</h3><p>AI 在逐句檢查有沒有夾帶可疑指示，等它一下。</p></div>`;
  } else if (state.importPreview) inner = importPreviewHtml();
  else if (state.corrupt) inner = corruptCardHtml();
  else if (state.showTrash) inner = trashViewHtml();
  else {
    const body = state.mode === 'chat' ? chatModeHtml()
      : state.mode === 'canvas' ? canvasModeHtml()
        : state.mode === 'history' ? historyModeHtml()
          : listModeHtml();
    inner = workHeadHtml() + body;
  }
  // 預覽浮窗放在 .layout 外（.work 有 backdrop-filter，會把 fixed 定位框在自己裡面）；重繪前記住它捲到哪，重繪後放回
  const pvScroll = app.querySelector('.pvbody')?.scrollTop ?? 0;
  app.innerHTML = hostAlert() + `<div class="layout">${sideHtml()}<div class="work">${inner}${drawerHtml()}${state.calendar ? calDrawerHtml() + calModalsHtml() : ''}</div></div>` + previewHtml();
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

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!state.run || state.run.status !== 'running') return;
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
    schedulePoll();
  }, 1000);
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
      messages: state.chat.messages.filter((m) => m.role !== 'error'),
      current_draft: current,
    });
    if (state.wf && !subjectIsDraft()) {
      await api('PUT', wfPath(state.wf), { def: out.draft });
      state.wf.def = out.draft;
      state.chat.messages.push({ role: 'ai', text: (out.reply || '改好了。') + '\n（已存檔＋記進履歷，改壞了到「履歷」退回）' });
    } else {
      state.chat.draft = out.draft;
      state.chat.messages.push({ role: 'ai', text: out.reply || '拆好了，切到「清單」或「畫布」看草稿。' });
    }
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
});

// 畫布快捷鍵：Ctrl+Z 上一步、Ctrl+Shift+Z / Ctrl+Y 重做、Ctrl+S 存檔（打字中不攔，交還瀏覽器原生行為）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.preview) { state.preview = null; render(); return; } // 成品預覽浮窗：Esc 關
  if (e.key === 'Escape' && state.calPicker) { state.calPicker = null; render(); return; } // 快速跳月浮層：Esc 關
  if (state.mode !== 'canvas' || state.run || state.dash || state.calendar) return; // 儀表板/行事曆蓋在上面時畫布不收快捷鍵
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
  if (t.dataset?.param !== undefined) { // 「這次的設定」邊打邊存＋句內膠囊就地同步（不等 change、不重繪）
    state.paramNow[t.dataset.param] = t.value;
    syncParamChips(t.dataset.param, t.value);
  }
  if (t.id === 'cal-pick-year' && state.calPicker && /^\d{4}$/.test(t.value)) { // 年份直接打：存進 state、月格就地更新
    state.calPicker.year = Number(t.value);
    patchCalPickerGrid();
  }
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
  } catch (err) {
    window.alert(err.message);
  }
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
      state.run = null;
      state.showTrash = false;
      state.importPreview = null;
      state.dash = { data: null, usageView: 'flow', open: {}, promptView: null };
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {}); // 通知住在這頁——授權一次；被拒頁內照常
      }
      render();
      await loadDash();
      render();
      dashPoll();
    } else if (act === 'dash-usage-view') { state.dash.usageView = el.dataset.view; render(); }
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
    } else if (act === 'dash-prompt-close' || (act === 'dash-prompt-back' && e.target === el)) {
      state.dash.promptView = null;
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
    else if (act === 'check-toggle') {
      // 每步交貨先查：切換即 PUT 定義；沒存成就講一句並把開關撥回原樣（重繪照定義畫）
      const def = structuredClone(state.wf.def);
      def.check = { enabled: el.checked };
      try {
        await api('PUT', wfPath(state.wf), { def });
      } catch (err) {
        window.alert(`沒存成：${err.message}`);
        render();
        return;
      }
      state.wf.def = def;
      if (state.cvWork) state.cvWork.check = def.check; // 畫布工作本同步，之後存檔不會把開關蓋回去
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
        state.wf = { category: cat, id, def: await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}`), runs: [] };
        state.run = { ...(await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}/runs/${el.dataset.runRid}`)), workflow: { category: cat, id } };
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
      // 提醒：新增帶初始一檔；編輯只在首檔真的改了才動（免得洗掉抽屜裡加的其餘幾筆）
      if (!state.schedModal.sid) body.remind_leads = lead ? [lead] : [];
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
      try {
        state.calendar.autostart = await api('POST', '/api/autostart', { enabled: el.checked });
      } catch (err) {
        el.checked = !el.checked; // 失敗還原勾選，不假成功
        throw err;
      }
    } else if (act === 'notices-toggle-done') { state.noticesOpen = !state.noticesOpen; render(); }
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
      state.wf = { category: cat, id, def: await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}`), runs: [] };
      state.run = { ...(await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}/runs/${rid}`)), workflow: { category: cat, id } };
      state.dataSupplyOpen = null;
      state.editRulesOpen = null;
      render();
      schedulePoll();
    } else if (act === 'todo-open-wf') {
      closeCalendar();
      closeDash();
      const cat = el.dataset.cat;
      const id = el.dataset.id;
      state.wf = { category: cat, id, def: await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}`), runs: await api('GET', `/api/workflows/${encodeURIComponent(cat)}/${encodeURIComponent(id)}/runs`) };
      state.mode = 'list';
      await refreshProposals(state.wf);
      render();
    }
    else if (act === 'new-flow') {
      if (canvasLeaveBlocked()) return;
      closeCalendar();
      closeDash();
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
        const name = document.getElementById('save-new-category').value.trim();
        if (!name) return;
        await api('POST', '/api/categories', { name });
        category = name;
      }
      const saved = await api('POST', '/api/workflows', { category, def: state.chat.draft });
      const def = state.chat.draft;
      state.chat = { messages: [], draft: null, busy: false };
      state.savingDraft = false;
      await refreshLibrary();
      state.wf = { category: saved.category, id: saved.id, def, runs: [] };
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
      closeCalendar();
      closeDash();
      const category = el.dataset.cat;
      const id = el.dataset.id;
      let def;
      try {
        def = await api('GET', wfPath({ category, id }));
      } catch (err) {
        if (err.message.includes('讀不懂')) {
          state.corrupt = { category, id, message: err.message };
          state.showTrash = false;
          render();
          return;
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
      state.feedbackSent = false;
      state.showTrash = false;
      state.corrupt = null;
      state.canvasSel = null;
      window.BJCanvas.resetView();
      state.versions = await api('GET', `${wfPath(state.wf)}/versions`);
      await refreshProposals(state.wf);
      state.wfFiles = await api('GET', `${wfPath(state.wf)}/files`);
      render();
    } else if (act === 'del-run') {
      if (!window.confirm('這一趟不用跑完了？會連同它的紀錄、產出檔、指示卷宗一起刪掉，救不回來。')) return;
      await api('DELETE', `${wfPath(state.wf)}/runs/${el.dataset.rid}`, undefined);
      state.wf.runs = await api('GET', `${wfPath(state.wf)}/runs`);
      render();
    } else if (act === 'resume') {
      state.run = await api('GET', `${wfPath(state.wf)}/runs/${el.dataset.rid}`);
      state.run.workflow = { category: state.wf.category, id: state.wf.id };
      state.editingNode = null;
      state.dataSupplyOpen = null;
      state.editRulesOpen = null;
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
        run = await api('POST', `${wfPath(state.wf)}/runs`, { overrides });
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
      state.keep = {};
      state.dataSupplyOpen = null;
      state.editRulesOpen = null;
      state.feedbackSent = false;
      render();
      schedulePoll();
    } else if (act === 'start-check-close') {
      state.startCheck = null;
      render();
    } else if (act === 'pf-fix') {
      if (el.dataset.kind === 'node') { // 開那一步的抽屜
        state.canvasSel = el.dataset.id;
        state.drawerOpen = true;
        render();
      } else if (el.dataset.kind === 'flow') {
        // 流程層設定（目前只有產檔權限開關）：亮 1.5 秒＋捲到它。狀態驅動——class 由 permRowHtml 依 permFlashUntil 帶、
        // 捲動在 render() 尾端對新元素做，中途任何整頁重繪（通知輪詢等）都不會把亮框和捲動弄丟
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
      if (state.wf) state.wf.runs = await api('GET', `${wfPath(state.wf)}/runs`);
      render();
    } else if (act === 'data-fix-node') {
      // run 頁不顯示抽屜：先回工作區（同 back），再開那一步的抽屜
      clearTimeout(state.pollTimer);
      state.run = null;
      state.editingNode = null;
      state.dataSupplyOpen = null;
      if (state.wf) state.wf.runs = await api('GET', `${wfPath(state.wf)}/runs`);
      state.mode = 'list';
      state.canvasSel = el.dataset.node;
      state.drawerOpen = true;
      render();
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
      await api('POST', `/api/proposals/${el.dataset.pid}/accept`, {});
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
      await api('POST', `${wfPath(state.run.workflow)}/runs/${state.run.run_id}/run-feedback`, { text });
      state.feedbackSent = true;
      pollProposalsSoon(state.run.workflow);
      render();
    } else if (act === 'rollback-version') {
      await api('POST', `${wfPath(state.wf)}/rollback`, { version: Number(el.dataset.version) });
      state.wf.def = await api('GET', wfPath(state.wf));
      state.versions = await api('GET', `${wfPath(state.wf)}/versions`);
      render();
    } else if (act === 'cv-close-drawer') {
      state.drawerOpen = false;
      state.drawerTabFor = null; // 重開同一顆也回預設頁
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
      if (sel) sel.innerHTML = `<option value="">常用⋯</option>${(state.presets[el.dataset.field] ?? []).map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')}`;
    } else if (act === 'preset-del') {
      const sel = el.parentElement.querySelector('[data-preset-field]');
      const name = sel?.value;
      if (!name) { window.alert('先在「常用⋯」裡選一個要刪的'); return; }
      if (!window.confirm(`把常用「${name}」刪掉？（已填進各步驟的內容不受影響）`)) return;
      await api('DELETE', `/api/presets/${encodeURIComponent(el.dataset.field)}/${encodeURIComponent(name)}`, undefined);
      state.presets = await api('GET', '/api/presets');
      sel.innerHTML = `<option value="">常用⋯</option>${(state.presets[el.dataset.field] ?? []).map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')}`;
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
          const attBoxes = [...document.querySelectorAll('[data-att]')];
          if (attBoxes.length || document.getElementById('ref-section')) {
            const picked = attBoxes.filter((c) => c.checked).map((c) => c.dataset.att);
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
      closeCalendar(); // 匯入預覽畫面在儀表板／行事曆之下，開著時選檔會看不到
      closeDash();
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
  await refreshLibrary();
  try {
    state.presets = await api('GET', '/api/presets');
  } catch { /* 常用庫讀不到就先空著 */ }
  try {
    applyNotices(await api('GET', '/api/notices'));
  } catch { /* 通知讀不到就先空著 */ }
  // 預設首頁＝儀表板（儀表板輪定案第 5 點）：有事先看到事
  state.dash = { data: null, usageView: 'flow', open: {}, promptView: null };
  render();
  try {
    await loadDash();
  } catch { /* 首屏載不到照開，各區顯示空狀態 */ }
  render();
  dashPoll();
  setTimeout(noticePollGlobal, 30000);
})();
