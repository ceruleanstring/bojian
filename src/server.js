// server — 本地 API＋靜態 UI 服務。只轉接 store／runner／adapter，不含業務邏輯。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { createStore, StoreError, deepMerge, DEFAULT_SETTINGS, safeFileName } from './store.js';
import { extractRuleText, checkRuleLimits, SharedError, LIMITS, viewKind, normName } from './shared.js';
import { createRunner } from './runner.js';
import { createHostAdapter } from './host-adapter.js';
import { compose, ComposeError } from './composer.js';
import { validateWorkflow, outgoing, nodeKind, applyDefaults, validateSettings } from './schema.js';
import { layers } from './graph.js';
import {
  createMemory, makeCard, validateCard, matchField, ensureFields, similarFields, mergeFields, parseGroupText,
  newId, bucketOfId, selectCore, FIELD_KINDS, SCOPE_LEVELS,
} from './memory.js';
import { preflight, packInputs } from './preflight.js';
import { pptxSlides } from './checker.js';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { marked } from 'marked';
import { createOptimizer, applyProposal } from './optimizer.js';
import { exportText, parseImport, scanImport, PorterError } from './porter.js';
import { createScheduler, fmtLocal, validateSchedule, isOccurrence } from './scheduler.js';
import { parseWhen } from './runner.js';
import { pushNotice, resolveNotice } from './notices.js';
import { monthView, linkedShifts, snapshotPrompt, parseSnapshot } from './calendar.js';
import { ensureOrgLayout, writeOrgs, orgDir, newOrgId } from './orgs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
// 本次上傳副檔名白名單＝參考檔選檔框 index.html #ref-file 的 accept 那張
export const RUN_UPLOAD_EXTS = ['docx', 'xlsx', 'pdf', 'md', 'txt', 'csv', 'json', 'html'];
// 本次附件：uploads 裡不綁任何欄位的保留鍵——檔案版的「本次補充」，這一趟每個 AI 步驟都看得到。
// 走同一條 run-uploads 暫存通道（副檔名／大小／一鍵一檔的規則完全沿用），差別只在開跑時不寫進 run.params
export const RUN_ATTACH_KEY = '__run__';
// 剝繭版本（設定頁「關於」用）：讀不到就不顯示，不擋啟動
let PKG_VERSION = null;
try { PKG_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version ?? null; } catch { /* 沒版本可顯示而已 */ }
// 備份失敗的人話對照（依 err.code）；對不上的一律「請再試一次」，原始錯誤只進 console
const BACKUP_ERRORS = {
  ENOENT: '備份沒做成：找不到備份位置',
  EACCES: '備份沒做成：沒有權限寫入備份位置',
  EPERM: '備份沒做成：沒有權限寫入備份位置',
  ENOSPC: '備份沒做成：磁碟空間不足',
};

function seedExamples(store, examplesDir) {
  if (!fs.existsSync(examplesDir)) return;
  // 逐檔補種：缺哪個補哪個，既有庫升級也拿得到新範例。// 精簡: 尚無刪流程 UI，不處理「使用者刻意刪掉範例」的情況（垃圾桶做完再議）
  const existing = new Set(store.listWorkflows().filter((w) => w.category === '範例').map((w) => w.id));
  for (const f of fs.readdirSync(examplesDir).filter((f) => f.endsWith('.yaml'))) {
    const id = path.basename(f, '.yaml');
    if (existing.has(id)) continue;
    store.writeWorkflow('範例', id, yaml.load(fs.readFileSync(path.join(examplesDir, f), 'utf8')));
  }
}

// ---- 成品頁內預覽與文字排版 ----
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Markdown → HTML：GFM 表格＋換行；AI 產出裡的原生 HTML 一律跳脫（不信任成品裡的標籤）
marked.use({ gfm: true, breaks: true, renderer: { html(token) { return escHtml(typeof token === 'string' ? token : (token.text ?? token.raw ?? '')); } } });
export function renderMarkdown(text) {
  return String(marked.parse(String(text ?? '')));
}
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.result !== undefined && v.result !== null) return cellText(v.result);
    if (v.formula !== undefined || v.sharedFormula !== undefined) return `=${v.formula ?? v.sharedFormula}`; // 沒算過結果的公式格：顯示公式本身，不印原始物件
    if (v.text !== undefined) return String(v.text);
    if (v.hyperlink !== undefined) return String(v.text ?? v.hyperlink);
    return JSON.stringify(v);
  }
  return String(v);
}
function csvTable(text) {
  const rows = String(text).split(/\r?\n/).filter((r) => r.trim()).slice(0, 500);
  return `<table>${rows.map((r) => `<tr>${r.split(',').map((c) => `<td>${escHtml(c.trim())}</td>`).join('')}</tr>`).join('')}</table>`;
}
// 依副檔名轉成頁內能顯示的形態：docx→HTML（mammoth）、xlsx→每表一張表格（exceljs，最多 500 列）、pdf→內嵌網址、文字→Markdown 排版
export async function previewArtifact(buf, name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (ext === 'docx') {
    const { value } = await mammoth.convertToHtml({ buffer: buf });
    return { kind: 'html', html: value };
  }
  if (ext === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheets = [];
    wb.eachSheet((ws) => {
      let n = 0;
      let html = '<table>';
      ws.eachRow({ includeEmpty: false }, (row) => {
        if (n++ >= 500) return;
        // row.values 是稀疏陣列，.map 會跳過空洞＝空白格整個消失、後面的值往左位移，
        // 於是數字排到錯的欄名底下（而查核員走 checker 的 eachCell 是對齊的，兩邊看到不同的表）
        const cells = [];
        row.eachCell({ includeEmpty: true }, (cell) => { cells.push(cellText(cell.value)); });
        html += `<tr>${cells.map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`;
      });
      sheets.push({ name: ws.name, html: `${html}</table>` });
    });
    return { kind: 'sheets', sheets };
  }
  // pptx 不處理的話會掉到最後的 buf.toString('utf8')，
  // 浮窗會印出一整片 ZIP 位元組還標「純文字」。一張一段排出來，跟查核員讀到的是同一份字。
  if (ext === 'pptx') {
    const slides = pptxSlides(buf);
    const html = slides
      .map((s) => `<section class="slidepv"><h3>第 ${s.n} 張</h3>${s.texts.map((t) => `<p>${escHtml(t)}</p>`).join('') || '<p class="quiet">（這張沒有文字）</p>'}</section>`)
      .join('');
    return { kind: 'html', html: html || '<p>（這份簡報讀不到任何文字）</p>' };
  }
  if (ext === 'pdf') return { kind: 'pdf' };
  const text = buf.toString('utf8');
  if (ext === 'md' || ext === 'txt') return { kind: 'html', html: renderMarkdown(text) };
  if (ext === 'csv') return { kind: 'html', html: csvTable(text) };
  return { kind: 'text', text };
}

// run 詳情頁的用量彙總——依 node＋kind 彙總這個 run 的帳；擬規則（edit-rules）三格都不算，
// 它不是工人的一步也不是查核的一次，只在儀表板／帳本總量裡算（既有邏輯不動）。沒有任何紀錄的節點不出現在結果裡。
// 第三格 supervisor（開場、交接、收尾）；開場與收尾的 node 是 _brief／_record 兩個偽節點，一樣算得到。
const USAGE_BUCKETS = { step: 'step', check: 'check', supervisor: 'supervisor' };
function usageByNode(allUsage, runId) {
  const out = {};
  for (const u of allUsage) {
    if (u.run !== runId || !u.node) continue;
    const bucket = USAGE_BUCKETS[u.kind] ?? null;
    if (!bucket) continue;
    const n = (out[u.node] ??= {
      step: { input: 0, output: 0, calls: 0 },
      check: { input: 0, output: 0, calls: 0 },
      supervisor: { input: 0, output: 0, calls: 0 },
    });
    const b = n[bucket];
    b.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    b.output += u.output_tokens ?? 0;
    b.calls += 1;
  }
  return out;
}

// 終點 task：順著出線只穿過結構節點（並行點／會合／分岔）都到不了別的 task 的那一步。
// 後結構節點的 output 一律空字串（不再轉運），終點恰好是 next:[] 的 join 時，
// 成品＝匯進它的那幾支 task（並行兩支都算），不是 join 本身、也不是備援隨手挑一支。
function isTerminalTask(n, byId) {
  if (nodeKind(n) !== 'task') return false;
  const seen = new Set();
  const reachesTask = (id) => {
    for (const t of outgoing(byId.get(id) ?? {})) {
      if (seen.has(t)) continue;
      seen.add(t);
      const m = byId.get(t);
      if (!m) continue;
      if (nodeKind(m) === 'task' || reachesTask(t)) return true;
    }
    return false;
  };
  return !reachesTask(n.id);
}

// ／一趟執行的「成品」——終點 task（見 isTerminalTask）且已完成、有內容或有檔的那些。
// 儀表板 recent[] 與 GET /runs?detail=1 共用這一支，兩邊看到的成品永遠一致。
function finalsOf(run) {
  const nodes = run.def?.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const finals = [];
  for (const n of nodes) {
    if (!isTerminalTask(n, byId)) continue;
    const s = run.steps?.[n.id];
    if (!s || s.status !== 'done') continue;
    const text = String(s.edited_output ?? s.output ?? '');
    if (!text && !s.file) continue;
    finals.push({ node: n.id, title: n.title, preview: text.slice(0, 400), file: s.file ?? null });
  }
  // 終點是人做步驟（沒交內容）→ 成品回退到最後一個完成的 AI 步驟（拓樸序最深的那步，不是陣列序），別顯示「沒有成品」
  if (!finals.length && run.status === 'done') {
    const depth = layers({ nodes });
    const last = [...nodes].sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0)).reverse().find((n) => {
      const s = run.steps?.[n.id];
      return (n.kind ?? 'task') === 'task' && n.executor === 'ai' && s?.status === 'done' && (String(s.edited_output ?? s.output ?? '') || s.file);
    });
    if (last) {
      const s = run.steps[last.id];
      finals.push({ node: last.id, title: last.title, preview: String(s.edited_output ?? s.output ?? '').slice(0, 400), file: s.file ?? null });
    }
  }
  return finals;
}

function stepCountsOf(run) {
  return Object.values(run.steps ?? {}).reduce(
    (a, s) => ({ total: a.total + 1, done: a.done + (s.status === 'done' ? 1 : 0), failed: a.failed + (s.status === 'failed' ? 1 : 0) }),
    { total: 0, done: 0, failed: 0 },
  );
}

// 新組織的代號：撞到登錄簿既有（NTFS 不分大小寫，Main 與 main 同一夾）或夾已經在了就重抽——絕不沿用別人的夾。
// gen 可換是為了測得到「撞了會重抽」；正常呼叫不帶。
export function freeOrgId(root, taken = [], gen = newOrgId) {
  const used = new Set([...taken].map((s) => String(s).toLowerCase()));
  for (let i = 0; i < 50; i += 1) {
    const id = gen();
    if (used.has(String(id).toLowerCase())) continue;
    if (fs.existsSync(orgDir(root, id))) continue;
    return id;
  }
  throw new Error('抽不出新的組織代號，請稍後再試一次');
}

// 這支是公開庫，別人會 clone 回自己的機器上跑，所以兩道最低防線要有：
// 上限——本來完全沒有，對方送一個永遠不結束的 body 進來就會一直吃記憶體直到整支掛掉。
// 16MB 是照「本次附件」的 10MB 上限回推的：base64 之後約 13.4MB，再留一點給 JSON 的外框。
const BODY_LIMIT_BYTES = 16 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    // 型別——瀏覽器跨站送 application/json 會先打一次 preflight（被 CORS 擋掉），
    // 但 text/plain 這種「簡單請求」不會。不檢查的話，Origin 那道防線等於多一條繞道。
    // 沒帶 content-type 的放行：CLI 與測試不一定帶，而它們本來就不經過瀏覽器。
    const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ct && ct !== 'application/json') {
      const e = new Error(`請求內容要是 application/json，收到的是 ${ct}`);
      e.status = 415;
      reject(e);
      return;
    }
    let data = '';
    let bytes = 0;
    let done = false;
    // 先定編碼：不設就是每塊各自解碼，跨塊的中文會被切成兩個 U+FFFD，而 JSON.parse 照樣成功——
    // 亂碼會無聲無息存進 workflow.yaml（長指示／長對話史的 body 超過 64KB 就會踩到，2026-09-18 審查實測）
    req.setEncoding('utf8');
    req.on('data', (c) => {
      if (done) return;
      bytes += Buffer.byteLength(c, 'utf8');
      if (bytes > BODY_LIMIT_BYTES) {
        done = true;
        const e = new Error(`請求內容太大（上限 ${Math.round(BODY_LIMIT_BYTES / 1024 / 1024)}MB）`);
        e.status = 413;
        reject(e);
        req.resume();  // 剩下的直接丟掉不再累積；不能 destroy——連線斷了對方就收不到那句 413
        return;
      }
      data += c;
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('請求內容不是合法 JSON')); }
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

// 本機服務的最低防線（2026-09-18 審查）：綁 127.0.0.1 擋不住瀏覽器——使用者隨便逛到的網頁都能對
// 127.0.0.1 發跨站請求，沒有來源檢查就等於任何網站都能驅動這支 API（建一條流程→開跑→工人帶著
// Write／Edit／Bash 權限在這台機器上執行對方寫的指示；也能打 /api/autostart 種開機常駐）。
// 兩道：①Host 必須是本機名字——擋「把別的網域指到 127.0.0.1」的 DNS rebinding；
// ②帶了 Origin 就必須是自己這個 origin——瀏覽器的跨站請求一定帶 Origin，CLI 與測試不帶。
// 「沒帶 Origin」才是 CLI。字串 'null' 不是沒帶——那是瀏覽器給不透明來源（sandbox iframe、
// data: 頁）的 Origin，放行它等於留一道任何網站都做得出來的後門：頁面塞一個
// <iframe sandbox="allow-scripts"> 在裡面 fetch，content-type 用 text/plain 免預檢，
// 請求就帶著 Origin: null 抵達（2026-09-18 二次審查實測：打到 200、真的建出一條 Workflow）。
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function fromOwnUi(req) {
  const host = req.headers.host ?? '';
  let self;
  try { self = new URL(`http://${host}`); } catch { return false; }
  if (!LOCAL_HOSTS.has(self.hostname)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return LOCAL_HOSTS.has(u.hostname) && (u.port || '80') === (self.port || '80');
  } catch { return false; }
}

export function createApp({ dataDir, adapter, uiDir = path.join(HERE, '..', 'ui'), examplesDir = path.join(HERE, '..', 'examples'), now = () => Date.now(), autostartDir } = {}) {
  // 開機自動啟動：Windows＝啟動資料夾放一支 .cmd；其他平台誠實說不支援
  const startupDir = autostartDir ?? (process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : null);
  const autostartFile = startupDir ? path.join(startupDir, 'bojian-autostart.cmd') : null;
  const nowIso = () => new Date(now()).toISOString();

  // 多組織：一個組織一套 store／memory／runner／optimizer／scheduler，路徑全由 orgDir 推導。
  // store 帶 root＝資料根：備份備的是整根（全部組織一起備），不是單一組織夾。
  function makeOrg(id, dir) {
    const store = createStore(dir, { root: dataDir });
    // 用量歸戶：adapter 的 usage sink 是全域單一支，第二個組織建起來就會蓋掉第一個。
    // 改成每組織一層薄包裝，只在 meta 上蓋 org 章；sink 統一裝在 createApp，按 org 分流進各自的帳本。
    const orgAdapter = {
      ...adapter,
      complete: (o) => adapter.complete({ ...o, meta: { ...(o?.meta ?? {}), org: id } }),
      executeNode: (o) => adapter.executeNode({ ...o, meta: { ...(o?.meta ?? {}), org: id } }),
    };
    const memory = createMemory({ store, adapter: orgAdapter, now }); // 四條記路的落地（M2）；runner 開跑後叫它判「同值連兩趟」
    const runner = createRunner({ store, adapter: orgAdapter, now, memory });
    const optimizer = createOptimizer({ store, adapter: orgAdapter });
    const inflight = new Set();

    // 工作單留存：不屬於任何一次執行的四種呼叫（建流程、匯入掃描、優化、行事曆快照）沒有 run 卷宗可存，
    // 改留在 dataDir/logs/<種類>/。一次呼叫配一組回呼：指示與回覆共用同一個檔名，回覆多一個 .reply。
    function logPair(kind, tail = '') {
      let name = null;
      return {
        onPrompt: (text) => { name = `${new Date(now()).toISOString().replace(/:/g, '-')}${tail}`; store.writeLog(kind, name, text); },
        onReply: (text) => { if (name) store.writeLog(kind, `${name}.reply`, text); },
      };
    }

    // （M1c）：拆解器的三段參考——分類清單、詞典、所在分類的群組條（只取 active）。
    // 分類依 body.category，沒有才看草稿頂層的 category；存在的分類才算「已定」。讀不到＝當沒有，不擋建流程。
    // 多 capabilities（設定組布林，字由 composer 組）與 coreNotes（表達層＋內容層認識卡文，同開跑 selectCore；暫停或讀不到＝[]）。
    function composeContext(body) {
      const ctx = { categories: [], dict: null, groupRules: [], category: null, companyRules: [], deptRules: [], capabilities: null, coreNotes: [] };
      try {
        const settings = store.readSettings();
        ctx.capabilities = { web: settings.exec?.web !== false, files_default: settings.defaults?.permissions_files !== false, office: ['docx', 'xlsx', 'pptx'], downgrade: ['pdf'], refs: true, connectors: [] };
        ctx.categories = store.listCategories();
        ctx.dict = store.readDict();
        ctx.companyRules = store.readSharedRuleTexts('_company'); // 三層共用檔：公司規範當已知條件（沒有夾＝空）
        const want = typeof body.category === 'string' && body.category ? body.category
          : (typeof body.current_draft?.category === 'string' ? body.current_draft.category : '');
        if (want && (ctx.categories.includes(want) || want === '未分類')) {
          ctx.category = want;
          ctx.groupRules = (store.readGroup(want)?.rules ?? []).filter((r) => r.status === 'active').map((r) => r.text);
          if (want !== '未分類') ctx.deptRules = store.readSharedRuleTexts(want);
        }
        try {
          ctx.coreNotes = selectCore({ profileCards: store.listCards('profile'), category: ctx.category, paused: settings.memory?.paused === true }).map((c) => c.text);
        } catch (e) {
          console.error('[bojian] 記憶卡讀不到，這趟拆解不帶關於你：', e.message);
        }
      } catch (e) {
        console.error('[bojian] 建流程的記憶參考讀不到，照樣拆：', e.message);
      }
      return ctx;
    }

    function kick(category, id, runId) {
      const key = `${category}/${id}/${runId}`;
      if (inflight.has(key)) return;
      inflight.add(key);
      runner.runUntilPause(category, id, runId)
        .then((run) => {
          // run 跑完＝優化引擎的進場時機（US-007：run 結束後出提議）
          if (run?.status === 'done') {
            optimizer.analyze(category, id, logPair('optimize', `-${category}-${id}`))
              .catch((e) => console.error('[bojian] 提議產生失敗（下次一起看）：', e.message));
          }
        })
        .catch((e) => console.error('[bojian] run 推進失敗：', e.message))
        .finally(() => inflight.delete(key));
    }

    const scheduler = createScheduler({ store, runner, kick, now });

    // Google 快照抓取：任何失敗都不覆寫既有快取，回人話原因（Error Map）
    async function refreshSnapshot(month) {
      let out;
      const log = logPair('snapshot', `-${month}`);
      try {
        const prompt = snapshotPrompt(month);
        log.onPrompt(prompt); // store.writeLog 自己吞例外：工作單寫不進不擋抓快照
        // 輕裝連接器例外：這一次呼叫要看得到使用者掛的行事曆，不推 --strict-mcp-config
        out = await orgAdapter.complete({ prompt, meta: { kind: 'snapshot', mcp: 'calendar' } });
        log.onReply(String(out ?? ''));
      } catch (e) {
        return { ok: false, reason: e.message };
      }
      const parsed = parseSnapshot(out);
      if (!parsed) return { ok: false, reason: '快照回覆讀不懂——再試一次，或確認你的 Claude 掛了行事曆存取' };
      if (parsed.error) return { ok: false, reason: parsed.error };
      const fetched_at = new Date(now()).toISOString();
      store.writeSnapshot({ fetched_at, status: 'ok', events: parsed.events });
      return { ok: true, fetched_at, count: parsed.events.length };
    }

    // 待辦聚合：等人狀態五種＋時間未定＋待核可提議＋Google 異動卡——server 一次算好，前端不做 N+1
    function todoItems() {
      const items = [];
      const KINDMAP = {
        waiting_review: ['hold', '停點：看過再往下'],
        waiting_human: ['you', '你做的步驟——做完回來標完成'],
        waiting_branch: ['hold', 'AI 判不出走哪條路，等你選'],
        waiting_data: ['hold', '資料不全——重抓／續跑／擱置'],
        time_pending: ['hold', '時間未定——等你定時刻'],
        waiting_check: ['hold', '查核攔下——看原始資料 vs 成品再決定'],
      };
      for (const { category, id } of store.listWorkflows()) {
        for (const rid of store.listRuns(category, id)) {
          let r;
          try { r = store.readRun(category, id, rid); } catch { continue; }
          if (r.status === 'done') continue;
          for (const [nodeId, step] of Object.entries(r.steps ?? {})) {
            const km = KINDMAP[step.status];
            if (!km) continue;
            const node = r.def.nodes.find((n) => n.id === nodeId);
            items.push({
              kind: step.status, tone: km[0],
              title: `${node?.title ?? nodeId}（${r.workflow.name}）`,
              desc: step.status === 'time_pending' ? (step.time_note ?? km[1])
                : step.status === 'waiting_data' ? (step.data_note ?? km[1])
                : step.status === 'waiting_check' ? (step.check?.blocks?.[0]?.detail ?? km[1])
                : km[1],
              run: { category, id, run_id: rid, node: nodeId },
            });
          }
        }
      }
      for (const p of store.readProposals().filter((x) => x.status === 'pending')) {
        items.push({
          kind: 'proposal', tone: 'prop',
          title: `優化提議：${p.workflow.category}/${p.workflow.id}`,
          desc: p.change?.summary ?? '有一條提議等你看',
          proposal_id: p.id, workflow: p.workflow,
        });
      }
      for (const s of linkedShifts(store)) {
        items.push({ kind: 'google_shift', tone: 'prop', title: s.title, desc: s.desc, shift: { run: s.run, to: s.to } });
      }
      return items;
    }

    // 刪共用檔順帶清勾選：掃所有流程步驟的 attachments，拿掉指向這份檔的 {scope,name}；
    // 公司檔＝全部流程都看，部門檔＝只看該分類；有變的流程升一版（履歷寫原因），回被清掉的步驟數。壞檔跳過不擋刪除。
    function unlinkSharedAttachments(scope, name) {
      const tag = scope === '_company' ? 'company' : 'category';
      let steps = 0;
      for (const w of store.listWorkflows()) {
        if (tag === 'category' && w.category !== scope) continue;
        let def;
        try { def = store.readWorkflow(w.category, w.id); } catch { continue; }
        let touched = 0;
        for (const n of def.nodes ?? []) {
          if (!Array.isArray(n.attachments)) continue;
          const kept = n.attachments.filter((a) => !(a && typeof a === 'object' && a.scope === tag && a.name === name));
          if (kept.length !== n.attachments.length) { n.attachments = kept; touched += 1; }
        }
        if (!touched) continue;
        steps += touched;
        store.bumpVersion(w.category, w.id, def, `共用檔「${name}」已刪除，${touched} 步的勾選一併取消`, 'manual'); // 精簡：不走 saveManualEdit 的十分鐘合併，讓履歷留下原因
      }
      return steps;
    }

    // 開機三件事（原本在 start()）搬進來：新建的組織一樣拿得到範例與垃圾桶清理
    seedExamples(store, examplesDir);
    try { store.purgeTrash(30); } catch (e) { console.error('[bojian] 垃圾桶清理失敗：', e.message); }
    try { store.purgeMemoryTrash(30); } catch (e) { console.error('[bojian] 記憶垃圾桶清理失敗：', e.message); }
    return {
      id, store, memory, runner, optimizer, scheduler, kick, logPair, adapter: orgAdapter,
      composeContext, refreshSnapshot, todoItems, unlinkSharedAttachments,
    };
  }

  // ---- 組織登錄：orgs.json 是清單的真相（在記憶體裡，寫時同步落地），名字的真相在各組織 settings.json ----
  let state = ensureOrgLayout(dataDir); // { version, current, orgs:[{id, created_at}] }
  const built = new Map(); // 一個組織只 makeOrg 一次（種範例／清垃圾桶都在裡面，不能每次請求重跑）
  const orgs = {
    currentId: () => state.current,
    list: () => state.orgs, // 登錄簿原始列（id／created_at），不含名字
    has: (id) => state.orgs.some((o) => o.id === id),
    get(id) {
      if (!orgs.has(id)) return null;
      if (!built.has(id)) built.set(id, makeOrg(id, orgDir(dataDir, id)));
      return built.get(id);
    },
    current: () => orgs.get(state.current),
    all: () => state.orgs.map((o) => orgs.get(o.id)).filter(Boolean),
    // 組織頁清單：名字與流程數逐組織現算（讀不到就給空值，不擋整份清單）
    snapshot: () => ({
      current: state.current,
      orgs: state.orgs.map((o) => {
        const org = orgs.get(o.id);
        let name = '';
        let workflows = 0;
        try { name = org.store.readSettings().company_name ?? ''; } catch { /* 設定壞掉照樣列得出來 */ }
        try { workflows = org.store.listWorkflows().length; } catch { /* 同上 */ }
        return { id: o.id, name: name || '組織', created_at: o.created_at ?? null, workflows };
      }),
    }),
    create(name) {
      const id = freeOrgId(dataDir, state.orgs.map((o) => o.id));
      fs.mkdirSync(orgDir(dataDir, id), { recursive: true });
      state = { ...state, orgs: [...state.orgs, { id, created_at: nowIso() }] };
      writeOrgs(dataDir, state);
      const org = orgs.get(id); // 這一下才 makeOrg：種範例、建目錄
      const clean = String(name ?? '').trim();
      if (clean) org.store.writeSettings({ ...org.store.readSettings(), company_name: clean });
      return { id, name: clean || '組織' };
    },
    setCurrent(id) {
      state = { ...state, current: id };
      writeOrgs(dataDir, state);
      return state.current;
    },
    // 「移出」不是真刪：整夾改名進 orgs-trash/，登錄簿拿掉。要救回來自己搬回 orgs/ 就好
    remove(id) {
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      const trash = path.join(dataDir, 'orgs-trash', `${id}-${stamp}`);
      fs.mkdirSync(path.dirname(trash), { recursive: true });
      fs.renameSync(orgDir(dataDir, id), trash);
      built.delete(id);
      state = { ...state, orgs: state.orgs.filter((o) => o.id !== id) };
      writeOrgs(dataDir, state);
      return { id, moved_to: trash };
    },
  };

  // 用量分流：整個程序只裝一支 sink（adapter 的 sink 是全域單一支，每個組織各裝一次會互相蓋掉），
  // 依 meta 蓋的 org 章送進該組織的帳本；沒章的算目前組織。org 只是路由用的章，不進帳本
  //（帳本在哪個組織夾底下，已經說明了它是誰的）。
  adapter.setUsageSink?.((u) => {
    const { org, ...row } = u ?? {};
    const target = orgs.get(org ?? state.current) ?? orgs.get(state.current);
    if (!target) return;
    try { target.store.appendUsage(row); } catch (e) { console.error('[bojian] 用量記帳失敗：', e.message); }
  });

  async function handleApi(req, res, segs) {
    // adapter 也從組織拿：這一趟的呼叫都蓋上這個組織的章（外層的 adapter 被遮住是故意的）
    const { store, memory, runner, optimizer, scheduler, kick, logPair, adapter,
      composeContext, refreshSnapshot, todoItems, unlinkSharedAttachments } = orgs.current();
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    try {
      // 路由紀律（健檢 P2-05）：每條路要同時對上方法＋段數，對不上就落到最後的 404——拼錯不准回 200
      // /api/health
      if (segs[1] === 'health' && req.method === 'GET' && segs.length === 2) return json(200, { claude: await adapter.checkAvailable() });
      // /api/compose 用講的建流程
      if (segs[1] === 'compose' && req.method === 'POST' && segs.length === 2) {
        const body = await readBody(req);
        const ctx = composeContext(body);
        const messages = body.messages ?? [];
        const currentDraft = body.current_draft ?? null;
        // phase 缺省＝有草稿→draft（對話修改不出卡），沒有→shape（第一趟先出成品卡）。伺服器不存中間態：格子由前端帶回來
        const phase = body.phase === 'shape' || body.phase === 'draft' ? body.phase : (currentDraft ? 'draft' : 'shape');
        const legalCat = (c) => (typeof c === 'string' && (c === '未分類' || ctx.categories.includes(c)) ? c : null);
        // 卡上選的檔案種類與舊作品檔名跟著第二趟下去（連跑那條路沒有卡，兩個都是 null）
        const outputFile = typeof body.output_file === 'string' ? body.output_file : null;
        const sampleName = typeof body.sample_name === 'string' && body.sample_name ? body.sample_name : null;
        const draftRound = async (shape, sources, category) => {
          const out = await compose({ adapter, messages, currentDraft, context: ctx, phase: 'draft', shape, sources, category, outputFile, sampleName, ...logPair('compose', '-draft') });
          // 分類由前端下拉（或第一趟建議）決定，拆解器寫錯也不採：無條件蓋——沒帶或不合法就退到 ctx.category（對話修改時
          // current_draft 驗過存在的分類），再沒有就把鍵刪掉（validateWorkflow 對 category:null 會報「要是文字」，不能寫 null）
          const cat = category ?? ctx.category ?? null;
          if (cat) out.draft.category = cat; else delete out.draft.category;
          // 檔案種類跟分類一樣是使用者在卡上定的，不能全憑模型自律——
          // 它漏寫或寫到中間步驟，使用者的選擇就無聲消失。這裡無條件蓋到「最後交付那一步」
          //（沒有下一步的 AI 步驟；分岔殊途同歸時可能有好幾個，都蓋）。中間步驟的 output_file 不動，
          // 那可能是流程自己真的需要的中繼檔。沒選＝不動（連跑那條路沒有卡）。
          if (outputFile) {
            const nodes = Array.isArray(out.draft?.nodes) ? out.draft.nodes : [];
            for (const n of nodes) {
              if (n && (n.executor ?? 'ai') === 'ai' && nodeKind(n) === 'task' && !(n.next ?? []).length) n.output_file = outputFile;
            }
          }
          // （M2）記路④：拆好了才路由最後一句使用者話——已存流程在哪個分類就用在那個分類（ctx.category 是驗過存在的），
          // 新草稿用在全部。路由失敗只多一句 memory_notice，拆好的草稿照回。第一趟還沒拆好，不記
          const lastSaid = [...messages].reverse().find((m) => m?.role === 'user')?.text ?? '';
          out.memory_notice = await memory.onChat({ text: lastSaid, category: ctx.category, def: currentDraft });
          return { ...out, phase: 'draft' };
        };
        if (phase === 'draft') return json(200, await draftRound(body.shape ?? null, body.sources ?? null, legalCat(body.category)));
        const first = await compose({ adapter, messages, currentDraft, context: ctx, phase: 'shape', ...logPair('compose', '-shape') });
        first.category = legalCat(first.category);
        // 開關關掉且沒明帶 phase（明帶 'shape'＝前端「重擬」，永遠只跑一趟）→連跑第二趟，前端不出卡直接出草稿
        let confirmShape = true; // 設定讀不到＝照預設先出卡（不擋建流程，同 composeContext 的規矩）
        try { confirmShape = store.readSettings().compose?.confirm_shape !== false; } catch { /* 走預設 */ }
        if (body.phase !== 'shape' && !confirmShape) {
          const second = await draftRound(first.shape, first.sources, first.category);
          return json(200, { ...second, shape: first.shape, sources: first.sources, auto: true });
        }
        return json(200, { ...first, phase: 'shape' });
      }
      // /api/preflight 開跑前健檢：任何定義（草稿／畫布工作本／已存）都能查——抽屜預覽與開跑擋門同一份規則
      if (segs[1] === 'preflight' && req.method === 'POST' && segs.length === 2) {
        const body = await readBody(req);
        try {
          validateWorkflow(body.def, { allowFloating: true });
        } catch (e) {
          return json(400, { error: e.message });
        }
        // values＝這次的值（開跑前才給）；輸入來源改不重複的寫法（前端 pfInputs 展開）
        return json(200, { ...preflight(body.def, body.values ?? null), inputs: packInputs(body.def) });
      }
      // /api/render 文字成品排版：停點卡／成品區／儀表板預覽用，原生 HTML 一律跳脫
      if (segs[1] === 'render' && req.method === 'POST' && segs.length === 2) {
        const body = await readBody(req);
        return json(200, { html: renderMarkdown(body.text ?? '') });
      }
      // /api/categories
      if (segs[1] === 'categories' && segs.length === 2) {
        if (req.method === 'GET') return json(200, store.listCategories());
        if (req.method === 'POST') {
          store.createCategory((await readBody(req)).name);
          return json(200, { ok: true });
        }
      }
      // PUT /api/categories/:name {name}：分類改名——八處同步、歷史留舊名；StoreError code 對 400／404／409
      if (segs[1] === 'categories' && segs.length === 3 && req.method === 'PUT') {
        const moved = store.renameCategory(decodeURIComponent(segs[2]), (await readBody(req)).name);
        return json(200, { ok: true, moved });
      }
      // /api/proposals/:pid/accept|reject
      if (segs[1] === 'proposals' && req.method === 'POST' && segs.length === 4) {
        const queue = store.readProposals();
        const p = queue.find((x) => x.id === segs[2]);
        if (!p) return json(404, { error: '找不到這條提議' });
        if (segs[3] === 'accept') {
          if (p.status !== 'pending') return json(400, { error: '這條提議已處理過' });
          // 監工建議（訊號 D）不是改法、是指路：不動定義、不升版，只回「去哪裡改」讓前端把抽屜開給使用者
          if (p.kind === 'supervisor_hint') {
            p.status = 'accepted';
            store.writeProposals(queue);
            return json(200, { ok: true, open: { category: p.workflow.category, id: p.workflow.id, node_id: p.change.node_id, field: p.change.field } });
          }
          try {
            const def = store.readWorkflow(p.workflow.category, p.workflow.id);
            applyProposal(def, p);
            validateWorkflow(def, { allowFloating: true });
            const note = p.change.summary || (p.kind === 'param_default'
              ? `「${p.change.param_label}」預設改為「${p.change.new_default}」` : `更新「${p.change.node_title}」的指示`);
            const version = store.bumpVersion(p.workflow.category, p.workflow.id, def, note, p.source);
            p.status = 'accepted';
            store.writeProposals(queue);
            return json(200, { ok: true, version });
          } catch (e) {
            // 套不上去（目標被刪／套上後定義不合法）→ 提議作廢＋人話，絕不假成功升版
            p.status = 'stale';
            store.writeProposals(queue);
            return json(400, { error: e.message });
          }
        }
        if (segs[3] === 'reject') {
          p.reject_count = (p.reject_count ?? 0) + 1;
          p.status = p.reject_count >= 2 ? 'muted' : 'rejected'; // 拒 2 次靜音（ADR-003）
          store.writeProposals(queue);
          return json(200, { ok: true, status: p.status });
        }
        return json(404, { error: '找不到這個動作' });
      }
      // /api/import：掃描（ADR-004 先掃再過目）／確認入庫
      if (segs[1] === 'import' && req.method === 'POST' && segs.length === 3) {
        if (segs[2] === 'scan') {
          const { def, schedule } = parseImport((await readBody(req)).content ?? '');
          const scan = await scanImport({ adapter, def, ...logPair('scan') });
          return json(200, { def, schedule, scan });
        }
        if (segs[2] === 'confirm') {
          const body = await readBody(req);
          // 定案：匯入的流程一律關產檔權限——伺服器端再鎖一次，不信任前端送來的旗標
          body.def = { ...body.def, permissions: { ...(body.def?.permissions ?? {}), files: false } };
          validateWorkflow(body.def, { allowFloating: true });
          // 隨檔排程：只有帶明確合法 freq 的才算有排程（健檢 M5：空物件≠預設週排程）；
          // 欄位非法＝略過排程、流程照常匯入，但回應講明（健檢 H1：不默默半成功）。
          let schedResult = 'none';
          let cand = null;
          if (body.schedule && typeof body.schedule === 'object' && body.schedule.freq !== undefined) {
            cand = {
              id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              name: body.def.name, workflow_id: null, // 入庫後補
              freq: body.schedule.freq, weekday: body.schedule.weekday ?? 1, day: body.schedule.day ?? 1,
              time: body.schedule.time ?? '08:00', at: body.schedule.at ?? null,
              enabled: false, auto_makeup: body.schedule.auto_makeup === true,
              remind_leads: Array.isArray(body.schedule.remind_leads) ? body.schedule.remind_leads : [],
              overrides: {},
            };
            try {
              validateSchedule(cand);
              schedResult = 'created';
            } catch {
              cand = null;
              schedResult = 'skipped_invalid';
            }
          }
          // 排程檔先讀（壞檔在寫任何東西之前就擋下＝整體 409，不做半套——健檢 H1）
          const scheds = cand ? store.readSchedules() : null;
          const id = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          store.writeWorkflow('匯入', id, body.def);
          if (cand) {
            cand.workflow_id = `匯入/${id}`;
            store.writeSchedules([...scheds, cand]);
          }
          return json(200, { category: '匯入', id, schedule_result: schedResult });
        }
      }

      // ===== 記憶卡／記憶垃圾桶／通知撤回／清空／介紹／詞典／群組圈／這條流程會帶什麼／身分（契約 (h)；錯誤一律人話）=====
      if (segs[1] === 'memory') {
        const sub = segs[2];
        const at = nowIso();
        if (sub === 'summary' && req.method === 'GET' && segs.length === 3) return json(200, memory.summary());
        if (sub === 'cards') {
          if (req.method === 'GET' && segs.length === 3) {
            const q = new URL(req.url, 'http://localhost').searchParams;
            const bucket = q.get('bucket') || undefined;
            if (bucket && !['habit', 'profile'].includes(bucket)) return json(400, { error: '沒有這種卡' });
            return json(200, store.listCards(bucket, { status: q.get('status') || undefined }));
          }
          if (req.method === 'POST' && segs.length === 3) {
            // 手動新增（記憶頁「＋」）：出處＝manual、原話＝內容本身；習慣卡的欄位可用同義詞進來，存正式名
            const b = await readBody(req);
            const dict = store.readDict();
            const field = b.field == null ? undefined : (matchField(dict, b.field)?.name ?? b.field);
            const text = String(b.text ?? '').trim();
            const card = makeCard({ bucket: b.bucket, text, layer: b.layer, field, scope: b.scope, expires: b.expires ?? null, source: { kind: 'manual', at, quote: text } }, at);
            const problems = validateCard(card, dict);
            if (problems.length) return json(400, { error: problems.join('；') });
            store.writeCard(card);
            return json(200, card);
          }
          const cardId = decodeURIComponent(segs[3] ?? '');
          const readCard = () => store.readCard(bucketOfId(cardId), cardId); // 不存在→404「找不到這張卡」
          if (req.method === 'GET' && segs.length === 4) return json(200, readCard());
          if (req.method === 'DELETE' && segs.length === 4) return json(200, { ok: true, key: store.trashCard(bucketOfId(cardId), cardId) });
          if (req.method === 'POST' && segs.length === 5) {
            const card = readCard();
            const b = await readBody(req);
            const save = (out) => { store.writeCard(out); return json(200, out); };
            if (segs[4] === 'replace') {
              // 鐵則：text 不可改，改＝新卡取代舊卡（計數歸零、狀態重新 active）；舊卡標 replaced 並記被誰取代
              const text = String(b.text ?? '').trim();
              if (!text) return json(400, { error: '要先寫新的內容' });
              const next = makeCard({ ...card, id: undefined, text, status: 'active', replaces: card.id, source: { ...card.source, kind: 'replace', at, quote: text } }, at);
              store.writeCard(next);
              store.writeCard({ ...card, status: 'replaced', replaced_by: next.id });
              return json(200, next);
            }
            if (segs[4] === 'retire') return save({ ...card, status: 'retired' });
            if (segs[4] === 'revive') {
              if (!['dormant', 'retired'].includes(card.status)) return json(400, { error: '這張卡不是休眠或退休，不用復活' });
              return save({ ...card, status: 'active', unpicked_streak: 0 });
            }
            if (segs[4] === 'extend') {
              const out = { ...card, expires: b.expires ?? null };
              const problems = validateCard(out);
              if (problems.length) return json(400, { error: problems.join('；') });
              return save(out);
            }
            if (segs[4] === 'scope') {
              // 記憶頁直接設範圍（縮也可以；靠證據往外擴才走 widenScope）
              if (!SCOPE_LEVELS.includes(b.level)) return json(400, { error: '用在哪只能是全部、分類、Workflow' });
              const scope = {
                level: b.level,
                category: b.level === 'all' ? null : (b.category ?? card.scope?.category ?? null),
                workflow: b.level === 'workflow' ? (b.workflow ?? card.scope?.workflow ?? null) : null,
              };
              const out = { ...card, scope, scope_log: [...(card.scope_log ?? []), { at, from: { ...(card.scope ?? {}) }, to: { ...scope }, why: '你在記憶頁改的' }] };
              const problems = validateCard(out); // 流程層缺分類／流程、分類層缺分類→400，不落地
              if (problems.length) return json(400, { error: problems.join('；') });
              return save(out);
            }
            return json(404, { error: '找不到這個動作' });
          }
        }
        if (sub === 'trash') {
          if (req.method === 'GET' && segs.length === 3) return json(200, store.listMemoryTrash());
          if (req.method === 'POST' && segs[4] === 'restore' && segs.length === 5) return json(200, store.restoreCard(decodeURIComponent(segs[3])));
        }
        if (sub === 'notices' && req.method === 'POST' && segs[4] === 'undo' && segs.length === 5) {
          const b = await readBody(req);
          return json(200, memory.undo({ cardId: decodeURIComponent(segs[3]), category: b.category, id: b.id, run: b.run }));
        }
        if (sub === 'clear' && req.method === 'POST' && segs.length === 3) {
          // 清空記憶＝全部卡進記憶垃圾桶（30 天內可復原）；詞典、群組圈、設定不動
          let moved = 0;
          for (const c of store.listCards()) { store.trashCard(c.bucket, c.id); moved += 1; }
          return json(200, { ok: true, moved });
        }
        if (sub === 'intro' && segs.length === 3) {
          if (req.method === 'GET') return json(200, { done_at: store.readSettings().memory.intro_done_at });
          if (req.method === 'POST') {
            const b = await readBody(req);
            return json(200, memory.intro({ answers: b.answers ?? {}, skip: b.skip === true }));
          }
        }
        if (sub === 'dict') {
          if (req.method === 'GET' && segs.length === 3) {
            const dict = store.readDict();
            if (new URL(req.url, 'http://localhost').searchParams.get('usage') !== '1') return json(200, dict);
            // 設定頁詞典表的「用在哪些流程」（M5a）：掃全部流程的 params[].label 對詞典（同義詞也算）；壞檔跳過、每條流程每欄位只算一次
            const usage = Object.fromEntries(dict.fields.map((f) => [f.name, []]));
            for (const w of store.listWorkflows()) {
              let def;
              try { def = store.readWorkflow(w.category, w.id); } catch { continue; }
              const seen = new Set();
              for (const p of def?.params ?? []) {
                const hit = matchField(dict, p?.label);
                if (!hit || seen.has(hit.name)) continue;
                seen.add(hit.name);
                usage[hit.name].push({ category: w.category, id: w.id, name: def.name ?? w.name });
              }
            }
            return json(200, { ...dict, usage });
          }
          if (req.method === 'POST' && segs[3] === 'merge' && segs.length === 4) {
            const b = await readBody(req);
            if (!String(b.keep ?? '').trim() || !String(b.drop ?? '').trim()) return json(400, { error: '要指定留下哪個、併掉哪個' });
            const { dict, cards } = mergeFields(store.readDict(), store.listCards(), b.keep, b.drop); // 詞典裡沒有→Error 人話→400
            store.writeDict(dict);
            for (const c of cards) store.writeCard(c);
            // 群組條的 field 是存死的字串（M1a 差異 ③）：每個群組用新詞典重拆，掛到留下的欄位；id 與 created_at 照舊
            for (const g of store.listGroups()) store.writeGroup(g.category, { ...g, rules: parseGroupText(g.text, dict, g.rules, at) });
            return json(200, { dict, changed: cards.length });
          }
          if (req.method === 'PUT' && segs.length === 4) {
            const name = decodeURIComponent(segs[3]);
            const b = await readBody(req);
            const dict = store.readDict();
            const f = dict.fields.find((x) => x.name === name);
            if (!f) return json(404, { error: '詞典裡沒有這個欄位' });
            if (b.kind !== undefined && !Object.hasOwn(FIELD_KINDS, b.kind)) return json(400, { error: '性質只能是六類之一' });
            if (b.synonyms !== undefined && !(Array.isArray(b.synonyms) && b.synonyms.every((s) => typeof s === 'string'))) return json(400, { error: '同義詞要是文字清單' });
            if (b.kind !== undefined) f.kind = b.kind;
            if (b.synonyms !== undefined) f.synonyms = [...new Set(b.synonyms.map((s) => s.trim()).filter((s) => s && s !== f.name))];
            store.writeDict(dict);
            return json(200, dict);
          }
        }
        if (sub === 'groups') {
          if (req.method === 'GET' && segs.length === 3) return json(200, store.listGroups());
          if (segs.length === 4) {
            const category = decodeURIComponent(segs[3]);
            if (!store.listCategories().includes(category)) return json(404, { error: '沒有這個分類' });
            const prev = store.readGroup(category);
            // 沒有檔＝沒有群組圈：回空殼給前端畫文字框，不落地
            if (req.method === 'GET') return json(200, prev ?? { category, text: '', rules: [], files: [], updated_at: null });
            if (req.method === 'PUT') {
              const b = await readBody(req);
              if (typeof b.text !== 'string') return json(400, { error: '規矩要是文字（一行一條）' });
              const rules = parseGroupText(b.text, store.readDict(), prev?.rules ?? [], at);
              return json(200, store.writeGroup(category, { ...(prev ?? {}), text: b.text, rules }));
            }
          }
        }
        if (sub === 'for-workflow' && req.method === 'GET' && segs.length === 5) {
          const category = decodeURIComponent(segs[3]);
          const wfId = decodeURIComponent(segs[4]);
          const out = memory.forWorkflow(category, wfId);
          // 身分（M5a）：?identity=<id> 照指定；沒給＝預設綁這個分類的第一個身分；空字串＝不限縮；找不到＝不限縮（跟 runner 的 contextFor 一樣）。
          // 有身分時 core 用同一支 selectCore 重算（身分限縮後再取內容層前幾張，跟開跑時帶的一致）；身分檔讀不到＝當沒有
          const q = new URL(req.url, 'http://localhost').searchParams;
          let idn = null;
          try {
            const list = store.readIdentities();
            idn = q.has('identity') ? (list.find((i) => i?.id === q.get('identity')) ?? null) : (list.find((i) => (i?.categories ?? []).includes(category)) ?? null);
          } catch (e) { console.error('[bojian] 身分讀不到，這條流程不限縮：', e.message); }
          if (idn) {
            const core = selectCore({ profileCards: store.listCards('profile'), category, workflowId: wfId, paused: out.paused, identity: idn });
            out.core = { expression: core.filter((c) => c.layer === 'expression'), content: core.filter((c) => c.layer === 'content') };
          }
          return json(200, { ...out, identity: idn?.id ?? null });
        }
        if (sub === 'identities') {
          const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
          if (req.method === 'GET' && segs.length === 3) return json(200, store.readIdentities());
          if (req.method === 'POST' && segs.length === 3) {
            const b = await readBody(req);
            const name = String(b.name ?? '').trim();
            if (!name) return json(400, { error: '先取個名字' });
            const idn = { id: newId('i'), name, cards: strList(b.cards), categories: strList(b.categories), created_at: at };
            store.writeIdentities([...store.readIdentities(), idn]);
            return json(200, idn);
          }
          if (segs.length === 4) {
            const list = store.readIdentities();
            const idn = list.find((x) => x.id === decodeURIComponent(segs[3]));
            if (!idn) return json(404, { error: '找不到這個身分' });
            if (req.method === 'PUT') {
              const b = await readBody(req);
              if (b.name !== undefined) {
                const name = String(b.name ?? '').trim();
                if (!name) return json(400, { error: '先取個名字' });
                idn.name = name;
              }
              if (b.cards !== undefined) idn.cards = strList(b.cards);
              if (b.categories !== undefined) idn.categories = strList(b.categories);
              store.writeIdentities(list);
              return json(200, idn);
            }
            if (req.method === 'DELETE') {
              store.writeIdentities(list.filter((x) => x !== idn));
              return json(200, { ok: true });
            }
          }
        }
      }
      // ===== 三層共用檔：/api/shared/:scope/files（scope＝_company｜現有分類名）=====
      // 規範類（rule）上傳時轉純文字存 text_cache、擋格式與字數（單檔 4,000／每層 8,000→413）；參考類（ref）任何副檔名、10MB 封頂（同流程參考檔）；
      // 同名 409（換版＝先刪再傳）；刪除不進垃圾桶，順帶把所有流程步驟裡指向它的勾選拿掉（進履歷，看得到為什麼勾選不見了）
      if (segs[1] === 'shared' && segs[3] === 'files' && (segs.length === 4 || segs.length === 5 || (segs.length === 6 && segs[5] === 'view'))) {
        const scope = decodeURIComponent(segs[2]);
        if (scope !== '_company' && !store.listCategories().includes(scope)) return json(404, { error: '沒有這個分類' });
        // （上桌b）：GET …/files/:name/view 唯讀查看——md／txt 回原文、docx 等回成品預覽排版；
        // 路徑防護：壞編碼 400、檔名過 safeFileName（路徑符號／保留字 400）、NFC 正規化後只准讀清單裡登記的檔（夾裡野檔、結尾點 404）
        if (segs.length === 6) {
          if (req.method !== 'GET') return json(405, { error: '查看只能讀' });
          let raw;
          try { raw = decodeURIComponent(segs[4]); } catch { return json(400, { error: '檔名編碼不對' }); }
          const name = safeFileName(normName(raw));
          const entry = store.readSharedIndex(scope).files.find((f) => normName(f.name) === name);
          const p = entry && store.sharedFilePath(scope, entry.name);
          if (!p) return json(404, { error: `共用檔「${name}」不存在` });
          const kind = viewKind(entry.name);
          if (!kind) return json(415, { error: '這種檔不能在頁內看，請按「下載」開原檔' });
          const buf = fs.readFileSync(p);
          if (kind === 'text') return json(200, { name: entry.name, kind: 'text', text: buf.toString('utf8') });
          return json(200, { name: entry.name, ...(await previewArtifact(buf, entry.name)) });
        }
        const view = () => json(200, { scope, ...store.listShared(scope), limits: { ...LIMITS } });
        if (req.method === 'GET' && segs.length === 4) return view();
        if (req.method === 'POST' && segs.length === 4) {
          const b = await readBody(req);
          if (typeof b.name !== 'string') return json(400, { error: '檔名要是文字' });
          const name = safeFileName(b.name); // 不合法／保留字直接 400（StoreError BAD_NAME）
          if (b.kind !== 'rule' && b.kind !== 'ref') return json(400, { error: '要說明這份是規範還是參考' });
          // content_b64 嚴格驗證：Buffer.from 對壞 base64 寬鬆解碼不報錯，會把亂碼當內容存進去；型別錯也走同一句人話
          if (typeof b.content_b64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.content_b64) || b.content_b64.length % 4 !== 0) {
            return json(400, { error: '檔案內容沒讀到，請重新選檔上傳' });
          }
          const buf = Buffer.from(b.content_b64, 'base64');
          if (!buf.length) return json(400, { error: '檔案是空的' });
          if (buf.length > 10 * 1024 * 1024) return json(400, { error: '檔案太大（上限 10MB）' });
          const current = store.listShared(scope);
          if ([...current.rules, ...current.refs].some((f) => f.name === name)) return json(409, { error: '已有同名檔，先刪再傳' });
          let text = null;
          if (b.kind === 'rule') {
            try { text = await extractRuleText(buf, name); } catch (e) {
              if (e instanceof SharedError) return json(400, { error: e.message });
              throw e;
            }
            const problem = checkRuleLimits(text.length, current.rule_chars);
            if (problem) return json(413, { error: problem });
          }
          store.addShared(scope, { name, kind: b.kind, buf, text });
          return view();
        }
        if (segs.length === 5) {
          const name = decodeURIComponent(segs[4]);
          if (req.method === 'GET') {
            const p = store.sharedFilePath(scope, name);
            if (!p) return json(404, { error: `共用檔「${name}」不存在` });
            res.writeHead(200, {
              'content-type': 'application/octet-stream',
              'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            });
            return res.end(fs.readFileSync(p));
          }
          if (req.method === 'DELETE') {
            store.deleteShared(scope, name); // 不存在 → 404
            return json(200, { ok: true, unlinked_steps: unlinkSharedAttachments(scope, name) });
          }
        }
      }
      // ===== 多組織：清單／新增／切換／移出。既有路由一律不加 /o/:org 前綴——「目前組織」就是全部路由的預設對象 =====
      if (segs[1] === 'orgs' && segs.length === 2) {
        if (req.method === 'GET') return json(200, orgs.snapshot());
        if (req.method === 'POST') {
          const name = String((await readBody(req)).name ?? '').trim();
          // 名字就是該組織的 company_name，用同一條規則驗（60 字內），免得建得出來卻改不動
          const problems = validateSettings({ ...DEFAULT_SETTINGS, company_name: name });
          if (problems.length) return json(400, { error: problems.join('；') });
          return json(200, orgs.create(name)); // 建完不切換：使用者自己決定什麼時候過去
        }
      }
      if (segs[1] === 'orgs' && segs[2] === 'current' && segs.length === 3 && req.method === 'PUT') {
        const { id } = await readBody(req);
        if (!orgs.has(id)) return json(404, { error: '找不到這個組織' });
        return json(200, { ok: true, current: orgs.setCurrent(id) });
      }
      if (segs[1] === 'orgs' && segs.length === 3 && req.method === 'DELETE') {
        const id = decodeURIComponent(segs[2]);
        if (!orgs.has(id)) return json(404, { error: '找不到這個組織' });
        if (orgs.list().length <= 1) return json(400, { error: '至少要留一個組織，這是最後一個' });
        if (id === orgs.currentId()) return json(400, { error: '這是你正在用的組織，先切到別的組織再移出它' });
        return json(200, { ok: true, ...orgs.remove(id) });
      }
      // ===== 全域設定（設定頁六組的資料源）與備份 =====
      if (segs[1] === 'settings' && segs.length === 2) {
        if (req.method === 'GET') return json(200, { ...store.readSettings(), data_dir: store.dataDir, version: PKG_VERSION });
        if (req.method === 'PUT') {
          // 部分送也行：合到現況上再逐欄驗，一欄錯整份不落地。data_dir／version 是 GET 附帶的唯讀資訊，送回來也不收
          const { data_dir: _d, version: _v, ...b } = await readBody(req);
          const merged = deepMerge(store.readSettings(), b);
          const problems = validateSettings(merged);
          if (problems.length) return json(400, { error: problems.join('；') });
          store.writeSettings(merged);
          return json(200, merged);
        }
      }
      if (segs[1] === 'backup' && segs.length === 2) {
        if (req.method === 'GET') return json(200, store.listBackups());
        if (req.method === 'POST') {
          // 失敗只回人話（不透傳原始錯誤與本機路徑）；原始錯誤進 console
          try { return json(200, store.backup()); } catch (e) {
            console.error('[bojian] 備份失敗：', e.message);
            return json(500, { error: BACKUP_ERRORS[e.code] ?? '備份沒做成，請再試一次' });
          }
        }
      }

      // /api/trash：列垃圾桶／復原
      if (segs[1] === 'trash') {
        if (req.method === 'GET' && segs.length === 2) return json(200, store.listTrash());
        if (req.method === 'POST' && segs[3] === 'restore' && segs.length === 4) {
          return json(200, store.restoreTrash(decodeURIComponent(segs[2])));
        }
      }
      // 常用預設庫
      if (segs[1] === 'presets') {
        if (req.method === 'GET' && segs.length === 2) return json(200, store.listPresets());
        if (req.method === 'POST' && segs.length === 2) {
          const b = await readBody(req);
          if (!b.field || !b.name?.trim() || !b.text?.trim()) return json(400, { error: '要有欄位、名稱、內容才能存' });
          store.savePreset(b.field, b.name.trim(), b.text);
          return json(200, { ok: true });
        }
        if (req.method === 'DELETE' && segs.length === 4) {
          store.deletePreset(decodeURIComponent(segs[2]), decodeURIComponent(segs[3]));
          return json(200, { ok: true });
        }
      }
      // ===== D20：開機自動啟動=====
      if (segs[1] === 'autostart' && segs.length === 2) {
        if (req.method === 'GET') {
          return json(200, { supported: !!autostartFile, enabled: !!(autostartFile && fs.existsSync(autostartFile)) });
        }
        if (req.method === 'POST') {
          if (!autostartFile) return json(400, { error: '這個平台不支援開機自動啟動——請自行把「node src/server.js」加進開機項目' });
          const { enabled } = await readBody(req);
          if (enabled) {
            const root = path.join(HERE, '..');
            fs.mkdirSync(startupDir, { recursive: true });
            fs.writeFileSync(autostartFile, `@echo off\r\ncd /d "${root}"\r\nstart "bojian" /min cmd /c "node src\\server.js"\r\n`, 'utf8');
          } else if (fs.existsSync(autostartFile)) fs.unlinkSync(autostartFile);
          return json(200, { supported: true, enabled: !!enabled });
        }
      }

      // ===== D20：排程 =====
      if (segs[1] === 'schedules') {
        if (req.method === 'GET' && segs.length === 2) return json(200, store.readSchedules());
        if (req.method === 'POST' && segs.length === 2) {
          const b = await readBody(req);
          if (!b.workflow_id || !String(b.workflow_id).includes('/')) return json(400, { error: '要指定掛哪一條 Workflow' });
          const [wc, ...wr] = String(b.workflow_id).split('/');
          const def = store.readWorkflow(wc, wr.join('/')); // 不存在 → 404
          // 有填的欄位保留原值交給 validator（健檢 M1：錯誤型別要被打回 400，不准被靜默改成別的設定）
          // （M5b）：沒帶「錯過自動補」「提前提醒」就用設定頁「執行與排程」的預設（settings.exec）；設定讀不到→程式缺省，不擋建排程
          let exec = DEFAULT_SETTINGS.exec;
          try { exec = store.readSettings().exec; } catch (e) { console.error('[bojian] 設定檔讀不到，新排程用程式缺省：', e.message); }
          const sched = {
            id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            name: b.name === undefined ? def.name : (typeof b.name === 'string' && b.name.trim() ? b.name.trim() : b.name),
            workflow_id: b.workflow_id, freq: b.freq,
            weekday: b.weekday ?? 1, day: b.day ?? 1, time: b.time ?? '08:00', at: b.at ?? null,
            enabled: b.enabled === undefined ? true : b.enabled,
            auto_makeup: b.auto_makeup === undefined ? exec.auto_makeup === true : b.auto_makeup,
            remind_leads: b.remind_leads === undefined ? structuredClone(Array.isArray(exec.remind_leads) ? exec.remind_leads : []) : b.remind_leads,
            overrides: {},
          };
          validateSchedule(sched); // 建立／更新共用同一套（健檢 P2-02）；錯 → 400 人話
          store.writeSchedules([...store.readSchedules(), sched]);
          return json(200, sched);
        }
        const sid = decodeURIComponent(segs[2] ?? '');
        const list = store.readSchedules();
        const sched = list.find((s) => s.id === sid);
        if (!sched) return json(404, { error: '找不到這條排程（可能已被刪除）' });
        if (req.method === 'PUT' && segs.length === 3) {
          const b = await readBody(req);
          const merged = { ...sched };
          for (const f of ['name', 'freq', 'weekday', 'day', 'time', 'at', 'enabled', 'auto_makeup', 'remind_leads']) {
            if (b[f] !== undefined) merged[f] = b[f];
          }
          try {
            validateSchedule(merged); // 先驗合併後整體，過了才落檔——非法值不准寫進 schedules.json
          } catch (e) {
            // 例外：純「停用」永遠放行（安全方向）——設定有誤的舊排程也要能先按暫停
            const onlyDisable = Object.keys(b).every((k) => k === 'enabled') && b.enabled === false;
            if (!onlyDisable) throw e;
          }
          Object.assign(sched, merged);
          store.writeSchedules(list);
          return json(200, sched);
        }
        if (req.method === 'DELETE' && segs.length === 3) {
          store.writeSchedules(list.filter((s) => s.id !== sid));
          return json(200, { ok: true });
        }
        if (req.method === 'POST' && segs[3] === 'run-now' && segs.length === 4) {
          const run = scheduler.fire(sched);
          return json(200, run);
        }
        if (req.method === 'POST' && segs[3] === 'occurrence' && segs.length === 4) {
          const b = await readBody(req);
          // 健檢 H2：occ 必須是這條排程「真實的一次」——任意合法日期不准冒充，否則 move 會憑空多跑一份
          if (!b.occ || !isOccurrence(sched, b.occ)) return json(400, { error: '這個時刻不是這條排程的任何一次——檢查日期是否符合它的頻率設定' });
          sched.overrides ??= {};
          if (b.action === 'skip') sched.overrides[b.occ] = { action: 'skip' };
          else if (b.action === 'move') {
            if (!b.to || !parseWhen(b.to)) return json(400, { error: '要指定移到什麼時候（看得懂的時刻）' });
            sched.overrides[b.occ] = { move: b.to };
          } else if (b.action === 'remind') sched.overrides[b.occ] = { remind_leads: b.remind_leads ?? [] };
          else if (b.action === 'clear') delete sched.overrides[b.occ];
          else return json(400, { error: '找不到這個動作' });
          store.writeSchedules(list);
          return json(200, sched);
        }
      }

      // ===== D20：行事曆 =====
      if (segs[1] === 'calendar') {
        if (req.method === 'GET' && segs.length === 2) {
          const month = new URL(req.url, 'http://localhost').searchParams.get('month') ?? fmtLocal(now()).slice(0, 7);
          return json(200, monthView({ store, month, now: now() }));
        }
        if (req.method === 'POST' && segs[2] === 'refresh' && segs.length === 3) {
          const month = (await readBody(req)).month ?? fmtLocal(now()).slice(0, 7);
          const out = await refreshSnapshot(month);
          if (!out.ok) {
            pushNotice(store, {
              type: 'snapshot_failed', title: 'Google 行事曆快照抓不到', desc: out.reason,
              actions: ['retry'], fingerprint: `snap@${fmtLocal(now()).slice(0, 10)}`,
            }, now());
            return json(200, out); // 抓不到是合法狀態，不是 HTTP 錯誤——剝繭排程照常
          }
          return json(200, out);
        }
      }

      // ===== D20：通知 =====
      if (segs[1] === 'notices') {
        if (req.method === 'GET' && segs.length === 2) {
          const all = store.readNotices().filter((n) => n.type !== 'trigger');
          return json(200, {
            unread: all.filter((n) => n.status === 'unread'),
            done: all.filter((n) => n.status === 'done').slice(-20).reverse(),
          });
        }
        if (req.method === 'POST' && segs[3] === 'act' && segs.length === 4) {
          const nid = decodeURIComponent(segs[2]);
          const n = store.readNotices().find((x) => x.id === nid);
          if (!n) return json(404, { error: '這則通知不存在' });
          const { action } = await readBody(req);
          const schedOf = () => {
            const s = store.readSchedules().find((x) => x.id === n.schedule_id);
            if (!s) throw new Error('這條排程已不存在，無法執行');
            return s;
          };
          // 每個動作走真實路徑，失敗就丟——不吞錯假成功
          if (action === 'makeup') scheduler.fire(schedOf(), { makeup: true });
          else if (action === 'force-run') scheduler.fire(schedOf());
          else if (action === 'retry' && n.type === 'snapshot_failed') {
            const out = await refreshSnapshot(fmtLocal(now()).slice(0, 7));
            if (!out.ok) return json(400, { error: out.reason });
          } else if (action === 'retry' && n.run) {
            runner.retry(n.run.category, n.run.id, n.run.run_id, n.run.node);
            kick(n.run.category, n.run.id, n.run.run_id);
          } else if (action !== 'skip' && action !== 'dismiss') return json(404, { error: '找不到這個動作' });
          const label = { makeup: '已補跑', 'force-run': '已照跑', retry: '已重試', skip: '已跳過這次', dismiss: '已知悉' }[action];
          resolveNotice(store, nid, label);
          return json(200, { ok: true });
        }
      }

      // ===== D20：待辦聚合 =====
      if (segs[1] === 'todos') {
        if (req.method === 'GET' && segs.length === 2) return json(200, { items: todoItems() });
        if (req.method === 'POST' && segs[2] === 'google-shift' && segs[3] === 'act' && segs.length === 4) {
          const b = await readBody(req);
          const { category, id, run_id, node } = b.run ?? {};
          if (!category) return json(400, { error: '缺少要處理的那場會' });
          if (b.action === 'follow') {
            runner.resumeTime(category, id, run_id, node, b.to); // 未來時刻→改排；失敗丟人話
            kick(category, id, run_id);
          } else if (b.action === 'keep') {
            const r = store.readRun(category, id, run_id);
            r.steps[node].linked_keep = b.to; // 同一次異動不再吵
            store.writeRun(category, id, run_id, r);
          } else return json(404, { error: '找不到這個動作' });
          return json(200, { ok: true });
        }
      }

      // ===== 儀表板：最近執行卡＋用量帳——server 一次算好，前端不做 N+1 =====
      if (segs[1] === 'dashboard' && req.method === 'GET' && segs.length === 2) {
        const q = new URL(req.url, 'http://localhost').searchParams;
        const limit = Math.min(50, Number(q.get('limit')) || 12);
        const days = Math.min(365, Number(q.get('days')) || 30);
        const allUsage = store.readUsage();
        const byRun = {};
        const byRunCheck = {}; // run 卡片附「查核 N token」，只算 kind==='check' 那幾筆
        const byRunSup = {}; // 同上，只算 kind==='supervisor'（開場、交接、收尾三種都在裡面）
        for (const u of allUsage) {
          if (!u.run) continue;
          const inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          const b = (byRun[u.run] ??= { input: 0, output: 0, cost: 0 });
          b.input += inTok;
          b.output += u.output_tokens ?? 0;
          b.cost += u.cost_usd ?? 0;
          const sub = u.kind === 'check' ? (byRunCheck[u.run] ??= { input: 0, output: 0 })
            : u.kind === 'supervisor' ? (byRunSup[u.run] ??= { input: 0, output: 0 }) : null;
          if (sub) {
            sub.input += inTok;
            sub.output += u.output_tokens ?? 0;
          }
        }
        const recent = store.listRecentRuns(limit).map((r) => {
          let run;
          try { run = store.readRun(r.category, r.id, r.runId); } catch { return null; } // 壞 run 檔不擋整頁
          const finals = finalsOf(run);
          const steps = stepCountsOf(run);
          const usage = byRun[r.runId]
            ? { ...byRun[r.runId], check: byRunCheck[r.runId] ?? { input: 0, output: 0 }, supervisor: byRunSup[r.runId] ?? { input: 0, output: 0 } }
            : null;
          return {
            category: r.category, id: r.id, name: run.workflow?.name ?? r.name, run_id: r.runId,
            status: run.status, source: run.source ?? 'manual', makeup: run.makeup === true,
            started_at: run.started_at, finished_at: run.finished_at, finals, steps,
            usage,
          };
        }).filter(Boolean);
        const sinceMs = now() - days * 86_400_000;
        // （M4）：「要你處理」第一列的數——到期＋休眠＋被取代（summary 的例外三格各數幾張；卡讀不到＝全 0，不擋儀表板）
        let memoryEx = { expired: 0, dormant: 0, replaced: 0, total: 0 };
        try {
          const ex = memory.summary().exceptions;
          memoryEx = { expired: ex.expired.length, dormant: ex.dormant.length, replaced: ex.replaced.length, total: ex.expired.length + ex.dormant.length + ex.replaced.length };
        } catch (e) { console.error('[bojian] 儀表板的記憶例外數算不出來：', e.message); }
        return json(200, { recent, usage: allUsage.filter((u) => new Date(u.at).getTime() >= sinceMs), usage_days: days, memory: { exceptions: memoryEx } });
      }

      if (segs[1] !== 'workflows') return json(404, { error: '找不到這個位址' });

      // /api/workflows：清單／存新流程
      if (segs.length === 2) {
        if (req.method === 'POST') {
          const body = await readBody(req);
          // 新建流程一次補齊缺省（產檔權限、監工、查核、數字對原始資料、每步三個勾）——照設定頁「新流程的預設」；
          // 設定檔讀不到就用程式缺省，不擋存檔（匯入走 /api/import/confirm，不套、產檔一律關）
          let defaults;
          try { defaults = store.readSettings().defaults; } catch (e) { console.error('[bojian] 設定檔讀不到，新流程用程式缺省：', e.message); }
          const newDef = applyDefaults(body.def, { mode: 'create', defaults });
          validateWorkflow(newDef, { allowFloating: true });
          delete newDef.category; // 拆解器草稿的頂層 category 只是「放哪」：分類是路徑，不進 workflow.yaml
          const id = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          store.writeWorkflow(body.category, id, newDef); // 分類名過 store 護欄，`../x` 這類直接 400
          // 詞典自己長：欄位名對不上詞典就新建一條（記從哪條流程長出來）；像同一件事的提醒一句，不擋、不寫
          let dict_similar = [];
          try {
            const dict = store.readDict();
            const { dict: next, added } = ensureFields(dict, newDef.params, { category: body.category, workflow: id }, nowIso());
            dict_similar = [...new Set(added.flatMap((f) => similarFields(dict, f.name)))];
            if (added.length) store.writeDict(next);
          } catch (e) { console.error('[bojian] 詞典沒更新（不擋存檔）：', e.message); }
          return json(200, { category: body.category, id, dict_similar });
        }
        if (req.method === 'GET') return json(200, store.listWorkflows());
      }
      const [category, id] = [segs[2], segs[3]].map((s) => decodeURIComponent(s ?? ''));

      // /api/workflows/:cat/:id：讀／改定義／刪（進垃圾桶）
      if (segs.length === 4) {
        if (req.method === 'DELETE') {
          // 排程檔先讀（健檢 H1：壞檔要在搬任何東西之前擋下——報 409 時流程必須還原封不動，不做半套）
          const scheds = store.readSchedules();
          const key = store.trashWorkflow(category, id);
          // 排程隨葬（D20 challenge 條款 6）：停用不刪；復原後保持停用、需手動重開
          let touched = false;
          for (const s of scheds) {
            if (s.workflow_id === `${category}/${id}` && s.enabled !== false) { s.enabled = false; touched = true; }
          }
          if (touched) store.writeSchedules(scheds);
          return json(200, { ok: true, key });
        }
        if (req.method === 'PUT') {
          const current = store.readWorkflow(category, id); // 不存在 → 404
          const body = await readBody(req);
          // 存檔只補監工與查核兩個主開關，不碰 check.facts——沒有那個欄位的既有流程缺省是開，
          // 補一個 false 進去等於使用者沒動手就被關掉（save 模式的定義見 schema.applyDefaults）
          const saveDef = applyDefaults(body.def, { mode: 'save' });
          validateWorkflow(saveDef, { allowFloating: true });
          // 改名走 saveRename（履歷固定句「改名：「舊」→「新」」）；其餘照舊進手動編輯
          const version = saveDef.name !== current.name
            ? store.saveRename(category, id, saveDef, current.name)
            : store.saveManualEdit(category, id, saveDef);
          return json(200, { ok: true, version });
        }
        if (req.method === 'GET') return json(200, store.readWorkflow(category, id));
      }

      // /api/workflows/:cat/:id/move 搬分類
      if (segs[4] === 'move' && req.method === 'POST' && segs.length === 5) {
        store.moveWorkflow(category, id, (await readBody(req)).to);
        return json(200, { ok: true });
      }

      // 提議清單（節流：一次最多呈現 2 條——US-015）
      if (segs[4] === 'proposals' && req.method === 'GET' && segs.length === 5) {
        const mine = store.readProposals().filter((p) =>
          p.status === 'pending' && p.workflow.category === category && p.workflow.id === id);
        return json(200, { pending: mine.slice(0, 2), more: Math.max(0, mine.length - 2) });
      }

      // 匯出單檔（US-019；D20：排程節奏隨檔、匯入端停用起步）
      if (segs[4] === 'export' && req.method === 'GET' && segs.length === 5) {
        const def = store.readWorkflow(category, id);
        const sched = store.readSchedules().find((s) => s.workflow_id === `${category}/${id}`) ?? null;
        const filename = encodeURIComponent(`${def.name}.bojian.yaml`);
        res.writeHead(200, {
          'content-type': 'application/yaml; charset=utf-8',
          'content-disposition': `attachment; filename*=UTF-8''${filename}`,
        });
        return res.end(exportText(def, sched));
      }

      // 壞檔還原上一版（Error Map：流程檔手動改壞）
      if (segs[4] === 'restore' && req.method === 'POST' && segs.length === 5) {
        store.restoreLatest(category, id);
        return json(200, { ok: true });
      }

      // 版本履歷與退回
      if (segs[4] === 'versions' && req.method === 'GET' && segs.length === 5) return json(200, store.listVersions(category, id));
      if (segs[4] === 'rollback' && req.method === 'POST' && segs.length === 5) {
        store.rollback(category, id, (await readBody(req)).version);
        return json(200, { ok: true });
      }

      // 參考檔：上傳走 base64 JSON，10MB 封頂
      if (segs[4] === 'files') {
        if (req.method === 'GET' && segs.length === 5) return json(200, store.listRefFiles(category, id));
        if (req.method === 'POST' && segs.length === 5) {
          const b = await readBody(req);
          const buf = Buffer.from(b.content_b64 ?? '', 'base64');
          if (!buf.length) return json(400, { error: '檔案是空的' });
          if (buf.length > 10 * 1024 * 1024) return json(400, { error: '檔案太大（上限 10MB）' });
          store.writeRefFile(category, id, b.name, buf);
          return json(200, { ok: true, files: store.listRefFiles(category, id) });
        }
        if (req.method === 'DELETE' && segs.length === 6) {
          store.deleteRefFile(category, id, decodeURIComponent(segs[5]));
          return json(200, { ok: true, files: store.listRefFiles(category, id) });
        }
      }

      // 本次上傳：開跑前先傳進暫存區拿 token，開跑時才搬進該趟 runs/<rid>/in/——不進 Workflow 參考檔。
      // 護欄同參考檔：檔名不准路徑符號、副檔名白名單＝參考檔選檔框那張、10MB 封頂（超過 413）；每次上傳順手清 24 小時沒用掉的
      if (segs[4] === 'run-uploads' && req.method === 'POST' && segs.length === 5) {
        store.readWorkflow(category, id); // 沒有這條 Workflow＝404
        store.sweepUploads(24 * 3600e3, now());
        const b = await readBody(req);
        const name = safeFileName(String(b.name ?? '').normalize('NFC'));
        const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
        if (!RUN_UPLOAD_EXTS.includes(ext)) return json(400, { error: `這裡只收 ${RUN_UPLOAD_EXTS.join('、')} 檔` });
        const buf = Buffer.from(String(b.content_b64 ?? ''), 'base64');
        if (!buf.length) return json(400, { error: '檔案是空的' });
        if (buf.length > 10 * 1024 * 1024) return json(413, { error: '檔案太大（上限 10MB）' });
        const up = store.writeUpload(name, buf, { category, id }); // 代碼綁定這條 Workflow
        return json(200, up);
      }

      if (segs[4] === 'runs') {
        // GET /runs 清單（接回進行中用）；?detail=1每筆補 finished_at／steps／finals／files、started_at 倒序——流程頁右側「每次執行」用。
        // 壞掉的 run.yaml：不帶 detail 跳過（三欄形狀不變、舊讀者不炸）；帶 detail 照列、標 status:'unreadable'＋人話 error、排最後
        if (segs.length === 5 && req.method === 'GET') {
          const detail = new URL(req.url, 'http://localhost').searchParams.get('detail') === '1';
          const rows = [];
          for (const rid of store.listRuns(category, id)) {
            let r;
            try {
              r = store.readRun(category, id, rid);
              if (!r || typeof r !== 'object') throw new Error(`執行紀錄「${rid}」的檔案讀不懂（內容是空的或不是紀錄）`);
            } catch (e) {
              if (detail) rows.push({ run_id: rid, status: 'unreadable', error: e.message, started_at: null, finished_at: null, steps: { total: 0, done: 0, failed: 0 }, finals: [], files: store.listArtifacts(category, id, rid) });
              continue;
            }
            rows.push(detail
              ? { run_id: rid, status: r.status, started_at: r.started_at, finished_at: r.finished_at ?? null, steps: stepCountsOf(r), finals: finalsOf(r), files: store.listArtifacts(category, id, rid) }
              : { run_id: rid, status: r.status, started_at: r.started_at });
          }
          if (detail) rows.sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
          return json(200, rows);
        }
        // POST /runs 開跑（開跑前健檢：宿主可用？流程檔讀得懂？——US-013／Error Map）
        if (segs.length === 5 && req.method === 'POST') {
          if (!(await adapter.checkAvailable())) {
            return json(503, { error: '連不上 Claude——先把 Claude 開起來（或重新登入）再按開始。你的 Workflow 庫都在，不會不見。' });
          }
          const body = await readBody(req);
          // 固定規則擋門——AI 步驟開跑時什麼都拿不到就不開跑（提醒類不擋），UI 端先查過，這裡是兜底
          const defForRun = store.readWorkflow(category, id);
          // 這次的值照 runner 的解法算（空白退預設）——健檢看值與實際開跑吃同一份
          const overrides = { ...(body.overrides ?? {}) };
          // 本次補充（≤2,000 字）與本次上傳 {欄位 key: token}——token 要真的在暫存區、欄位要是上傳欄位；
          // 上傳欄位的值只認上傳檔名（文字覆寫不能冒充），沒傳＝空（必填的由健檢擋）
          const note = body.note ?? '';
          if (typeof note !== 'string' || note.length > 2000) return json(400, { error: '本次補充要是文字、2,000 字以內' });
          const uploads = body.uploads ?? {};
          if (typeof uploads !== 'object' || Array.isArray(uploads)) return json(400, { error: '上傳資料格式不對' });
          const fileKeys = new Set((defForRun.params ?? []).filter((p) => p.input === 'file').map((p) => p.key));
          for (const k of fileKeys) delete overrides[k];
          const claimed = {};
          const attachNames = []; // 本次附件：不綁欄位，不進 overrides／run.params，改交給 runner 當趟級附件
          for (const [k, token] of Object.entries(uploads)) {
            if (k !== RUN_ATTACH_KEY && !fileKeys.has(k)) return json(400, { error: `「${k}」不是上傳欄位` });
            const up = store.readUpload(token, { category, id }); // 別條 Workflow 發的代碼拿不到（移部門／改名時記號已跟著改，L13b）
            if (!up) return json(400, { error: store.uploadProblem(token, { category, id }) });
            if (k === RUN_ATTACH_KEY) attachNames.push(up.name);
            else overrides[k] = up.name;
            claimed[k] = token;
          }
          const values = Object.fromEntries((defForRun.params ?? []).map((p) => {
            const v = overrides[p.key];
            return [p.key, v === undefined || v === null || String(v).trim() === '' ? (fileKeys.has(p.key) ? '' : p.default) : v];
          }));
          const pf = preflight(defForRun, values);
          const blocks = pf.issues.filter((i) => i.level === 'block');
          if (blocks.length) {
            return json(409, { error: `開跑前健檢：有 ${blocks.length} 處要先修，修好再按開始`, issues: [...blocks, ...pf.issues.filter((i) => i.level !== 'block')] });
          }
          // （M2）：開跑表單點的習慣卡、點了又改掉的、帶的身分，原樣進 run.memory（M3b 才有介面送這三欄）
          const run = runner.startRun(category, id, overrides, {
            memoryPicks: body.memory_picks ?? {}, memoryChanged: body.memory_changed ?? [], memoryIdentity: body.memory_identity ?? null,
            ...(note.trim() ? { note } : {}),
            ...(attachNames.length ? { runFiles: attachNames } : {}), // 本次附件
          }); // 讀檔＋驗定義，壞檔在這裡被擋
          for (const token of Object.values(claimed)) store.claimUpload(token, category, id, run.run_id); // 檔跟著這一趟存，暫存即刪
          kick(category, id, run.run_id);
          return json(200, run);
        }
        const runId = decodeURIComponent(segs[5] ?? '');
        // DELETE /runs/:rid：不用跑完的執行整筆刪（含產出與卷宗），不可復原——UI 端先 confirm
        if (segs.length === 6 && req.method === 'DELETE') {
          store.deleteRun(category, id, runId);
          return json(200, { ok: true });
        }
        // GET /runs/:rid 狀態。卡在 running（如伺服器重啟殘留）就順手接回續跑——UI 每秒輪詢，等於自癒
        if (segs.length === 6 && req.method === 'GET') {
          const run = store.readRun(category, id, runId);
          if (run.status === 'running') kick(category, id, runId);
          run.usage_by_node = usageByNode(store.readUsage(), runId); // 這一步花了多少（工人／查核分開）
          return json(200, run);
        }
        // /runs/:rid/files/:name/preview（頁內預覽形態）與 /inline（以正確 content-type 內嵌回檔，給 pdf iframe）
        if (req.method === 'GET' && segs[6] === 'files' && segs.length === 9) {
          const fname = decodeURIComponent(segs[7]);
          const buf = store.readArtifact(category, id, runId, fname);
          if (segs[8] === 'inline') {
            const ext = fname.split('.').pop().toLowerCase();
            const type = { pdf: 'application/pdf', html: 'text/html; charset=utf-8', json: 'application/json; charset=utf-8' }[ext] ?? 'text/plain; charset=utf-8';
            res.writeHead(200, { 'content-type': type });
            return res.end(buf);
          }
          if (segs[8] === 'preview') {
            const out = await previewArtifact(buf, fname);
            if (out.kind === 'pdf') out.url = `/api/workflows/${encodeURIComponent(category)}/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(fname)}/inline`;
            return json(200, out);
          }
        }
        // GET /runs/:rid/files（產出物清單）與 /runs/:rid/files/:name（下載）
        if (req.method === 'GET' && segs[6] === 'files') {
          if (segs.length === 7) return json(200, store.listArtifacts(category, id, runId));
          if (segs.length === 8) {
            const fname = decodeURIComponent(segs[7]);
            const buf = store.readArtifact(category, id, runId, fname);
            res.writeHead(200, {
              'content-type': 'application/octet-stream',
              'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
            });
            return res.end(buf);
          }
        }
        // GET /runs/:rid/prompts（卷宗清單）與 /runs/:rid/prompts/:name（單步指示全文）
        if (req.method === 'GET' && segs[6] === 'prompts') {
          if (segs.length === 7) return json(200, store.listPromptRecords(category, id, runId));
          if (segs.length === 8) {
            const name = decodeURIComponent(segs[7]);
            return json(200, { name, text: store.readPromptRecord(category, id, runId, name) });
          }
        }
        // POST /runs/:rid/<action>
        const action = segs[6];
        if (req.method === 'POST' && action && segs.length === 7) {
          const body = await readBody(req);
          if (action === 'approve') runner.approve(category, id, runId, body.node);
          else if (action === 'edit') {
            runner.edit(category, id, runId, body.node, body.output, body.note ?? null); // 這一步標完成，但 run 還停著
            // 停點改過就順手擬「後面每步要守的規則」；擬不出來 deriveEditRules 自己退成預設，這裡只防萬一丟錯，不擋這次修改
            try { await runner.deriveEditRules(category, id, runId, body.node); } catch (e) { console.error('[bojian] 擬規則失敗（不擋修改）：', e.message); }
            runner.resume(category, id, runId); // 規則寫進檔案了才放行——在這之前 GET run 看到的是 paused，不會把下游先放出去
            // （M2）記路②：放行後另起一條，不等它（optimizer 的訊號 B 是另一回事，各記各的）；門面自己接住錯，這裡只防萬一
            memory.onStopEdit({ category, id, runId, node: body.node, note: body.note ?? null })
              .catch((e) => console.error('[bojian] 記憶（停點）沒記成：', e.message));
          }
          else if (action === 'human-done') runner.completeHuman(category, id, runId, body.node, body.feedback ?? null, body.content ?? null); // content＝交給下一步的內容
          else if (action === 'retry') runner.retry(category, id, runId, body.node);
          else if (action === 'choose-branch') runner.chooseBranch(category, id, runId, body.node, body.target);
          else if (action === 'data-retry') runner.dataRetry(category, id, runId, body.node);
          else if (action === 'data-accept') runner.dataAccept(category, id, runId, body.node);
          else if (action === 'data-supply') runner.dataSupply(category, id, runId, body.node, body.text); // 我補給你
          else if (action === 'resume-time') runner.resumeTime(category, id, runId, body.node, body.at ?? null); // 等時刻：現在就繼續／改排時刻
          else if (action === 'check-retry') runner.checkRetry(category, id, runId, body.node, body.note ?? null); // 查核攔下：回話重做
          else if (action === 'check-accept') runner.checkAccept(category, id, runId, body.node); // 查核攔下：就這樣過
          else if (action === 'edit-rules') runner.setEditRules(category, id, runId, body.node, body.rules); // 查核卡上使用者自己改規則
          else if (action === 'interject') {
            // 插話：只把話留下來等下一次交接消化——不推進流程，所以不 kick()，自己 return
            if (typeof body.text !== 'string' || !body.text.trim()) return json(400, { error: '要先寫一句要交代的話' });
            runner.interject(category, id, runId, body.node, body.text);
            return json(200, store.readRun(category, id, runId));
          }
          else if (action === 'run-feedback') {
            const run = store.readRun(category, id, runId);
            run.feedback = body.text;
            store.writeRun(category, id, runId, run);
            optimizer.analyze(category, id, { feedback: body.text, ...logPair('optimize', `-${category}-${id}`) })
              .catch((e) => console.error('[bojian] 提議產生失敗（下次一起看）：', e.message));
            // （M2）記路③：另起一條、等它回一句通知隨 200 回去（optimizer 那條不等、也不知道它）；門面失敗只回 fail 通知
            const memory_notice = await memory.onFeedback({ category, id, runId, text: body.text });
            return json(200, { ok: true, memory_notice });
          }
          else return json(404, { error: '找不到這個動作' });
          kick(category, id, runId);
          return json(200, store.readRun(category, id, runId));
        }
      }
      return json(404, { error: '找不到這個位址' });
    } catch (e) {
      if (e instanceof StoreError) {
        const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'BAD_NAME' ? 400 : 409;
        return json(status, { error: e.message });
      }
      if (e instanceof ComposeError || e instanceof PorterError) return json(400, { error: e.message });
      if (e && Number.isInteger(e.status)) return json(e.status, { error: e.message }); // readBody 的 413／415
      // 系統層讀寫例外（帶 syscall／path）的原文含伺服器絕對路徑——記 log，回人話
      if (e && (e.syscall || e.path)) {
        console.error('[bojian] 讀寫檔案出錯：', e.message);
        return json(500, { error: '伺服器讀寫檔案時出了問題，再試一次；一直這樣請重開剝繭' });
      }
      return json(400, { error: e.message });
    }
  }

  function handleStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.join(uiDir, path.normalize(rel));
    if (!file.startsWith(uiDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    // no-cache：介面更新後重新整理即生效，不讓瀏覽器留舊版（曾造成「找不到新按鈕」）
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(fs.readFileSync(file));
  }

  const server = http.createServer((req, res) => {
    if (!fromOwnUi(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('這個要求不是從剝繭自己的畫面來的，已經擋下來了。');
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    const segs = pathname.split('/').filter(Boolean);
    if (segs[0] === 'api') return handleApi(req, res, segs);
    return handleStatic(req, res, pathname);
  });

  let timer = null;
  return {
    // 排程器 tick（ADR-005：server 內建、每分鐘、冪等）。多組織＝一個時鐘、逐組織敲一遍：
    // 排程不跟著「目前組織」走，B 的排程在你看 A 的時候照樣到點開跑。一個組織炸了不影響下一個。
    start(port, { tickMs = 60_000 } = {}) {
      const tickAll = () => {
        for (const o of orgs.all()) {
          try { o.scheduler.tickOnce(); } catch { /* 這個組織這一分鐘跳過，下一分鐘再來 */ }
        }
      };
      timer = setInterval(tickAll, tickMs);
      timer.unref?.();
      tickAll();
      return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      return new Promise((resolve) => server.close(resolve));
    },
    port() {
      return server.address().port;
    },
  };
}

// CLI 進入點：node src/server.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = process.env.BOJIAN_DATA_DIR ?? path.join(HERE, '..', 'data');
  const app = createApp({ dataDir, adapter: createHostAdapter() });
  const port = Number(process.env.BOJIAN_PORT ?? 8787);
  app.start(port).then(() => console.log(`剝繭在 http://127.0.0.1:${app.port()}（資料目錄：${dataDir}）`));
}
