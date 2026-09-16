// server — 本地 API＋靜態 UI 服務。只轉接 store／runner／adapter，不含業務邏輯。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { createStore, StoreError, deepMerge, DEFAULT_SETTINGS, safeFileName } from './store.js';
import { extractRuleText, checkRuleLimits, SharedError, LIMITS } from './shared.js';
import { createRunner } from './runner.js';
import { createHostAdapter } from './host-adapter.js';
import { compose, ComposeError } from './composer.js';
import { validateWorkflow, outgoing, applyDefaults, validateSettings } from './schema.js';
import {
  createMemory, makeCard, validateCard, matchField, ensureFields, similarFields, mergeFields, parseGroupText,
  newId, bucketOfId, selectCore, FIELD_KINDS, SCOPE_LEVELS,
} from './memory.js';
import { preflight } from './preflight.js';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { marked } from 'marked';
import { createOptimizer, applyProposal } from './optimizer.js';
import { exportText, parseImport, scanImport, PorterError } from './porter.js';
import { createScheduler, fmtLocal, validateSchedule, isOccurrence } from './scheduler.js';
import { parseWhen } from './runner.js';
import { pushNotice, resolveNotice } from './notices.js';
import { monthView, linkedShifts, snapshotPrompt, parseSnapshot } from './calendar.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
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

// ---- 產檔輪：成品頁內預覽與文字排版 ----
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
        html += `<tr>${row.values.slice(1).map((v) => `<td>${escHtml(cellText(v))}</td>`).join('')}</tr>`;
      });
      sheets.push({ name: ws.name, html: `${html}</table>` });
    });
    return { kind: 'sheets', sheets };
  }
  if (ext === 'pdf') return { kind: 'pdf' };
  const text = buf.toString('utf8');
  if (ext === 'md' || ext === 'txt') return { kind: 'html', html: renderMarkdown(text) };
  if (ext === 'csv') return { kind: 'html', html: csvTable(text) };
  return { kind: 'text', text };
}

// 交貨查核輪：run 詳情頁的用量彙總——依 node＋kind 彙總這個 run 的帳；擬規則（edit-rules）三格都不算，
// 它不是工人的一步也不是查核的一次，只在儀表板／帳本總量裡算（既有邏輯不動）。沒有任何紀錄的節點不出現在結果裡。
// 監工輪：第三格 supervisor（開場、交接、收尾）；開場與收尾的 node 是 _brief／_record 兩個偽節點，一樣算得到。
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

// 儀表板輪／移植合併輪 U4a：一趟執行的「成品」——終點步（沒有出線）且已完成、有內容或有檔的那些。
// 儀表板 recent[] 與 GET /runs?detail=1 共用這一支，兩邊看到的成品永遠一致。
function finalsOf(run) {
  const finals = [];
  for (const n of run.def?.nodes ?? []) {
    if (outgoing(n).length) continue; // 終點步＝沒有出線的步
    const s = run.steps?.[n.id];
    if (!s || s.status !== 'done') continue;
    const text = String(s.edited_output ?? s.output ?? '');
    if (!text && !s.file) continue;
    finals.push({ node: n.id, title: n.title, preview: text.slice(0, 400), file: s.file ?? null });
  }
  // 資料通道輪：終點是人做步驟（沒交內容）→ 成品回退到最後一個完成的 AI 步驟，別顯示「沒有成品」
  if (!finals.length && run.status === 'done') {
    const last = [...(run.def?.nodes ?? [])].reverse().find((n) => {
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('請求內容不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

export function createApp({ dataDir, adapter, uiDir = path.join(HERE, '..', 'ui'), examplesDir = path.join(HERE, '..', 'examples'), now = () => Date.now(), autostartDir } = {}) {
  // 開機自動啟動（US-043，使用者自決）：Windows＝啟動資料夾放一支 .cmd；其他平台誠實說不支援
  const startupDir = autostartDir ?? (process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : null);
  const autostartFile = startupDir ? path.join(startupDir, 'bojian-autostart.cmd') : null;
  const store = createStore(dataDir);
  // 用量帳本（儀表板輪）：每次宿主呼叫記一行——記帳失敗只留 log，不擋任何功能
  adapter.setUsageSink?.((u) => {
    try { store.appendUsage(u); } catch (e) { console.error('[bojian] 用量記帳失敗：', e.message); }
  });
  const memory = createMemory({ store, adapter, now }); // 記憶輪：四條記路的落地（M2）；runner 開跑後叫它判「同值連兩趟」
  const runner = createRunner({ store, adapter, now, memory });
  const optimizer = createOptimizer({ store, adapter });
  const nowIso = () => new Date(now()).toISOString();
  const inflight = new Set();

  // 工作單留存（監工輪）：不屬於任何一次執行的四種呼叫（建流程、匯入掃描、優化、行事曆快照）沒有 run 卷宗可存，
  // 改留在 dataDir/logs/<種類>/。一次呼叫配一組回呼：指示與回覆共用同一個檔名，回覆多一個 .reply。
  function logPair(kind, tail = '') {
    let name = null;
    return {
      onPrompt: (text) => { name = `${new Date(now()).toISOString().replace(/:/g, '-')}${tail}`; store.writeLog(kind, name, text); },
      onReply: (text) => { if (name) store.writeLog(kind, `${name}.reply`, text); },
    };
  }

  // 記憶輪（M1c）：拆解器的三段參考——分類清單、詞典、所在分類的群組條（只取 active）。
  // 分類依 body.category，沒有才看草稿頂層的 category；存在的分類才算「已定」。讀不到＝當沒有，不擋建流程。
  function composeContext(body) {
    const ctx = { categories: [], dict: null, groupRules: [], category: null, companyRules: [], deptRules: [] };
    try {
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

  // Google 快照抓取（US-034）：任何失敗都不覆寫既有快取，回人話原因（Error Map）
  async function refreshSnapshot(month) {
    let out;
    const log = logPair('snapshot', `-${month}`);
    try {
      const prompt = snapshotPrompt(month);
      log.onPrompt(prompt); // store.writeLog 自己吞例外：工作單寫不進不擋抓快照
      // 輕裝連接器例外（監工輪）：這一次呼叫要看得到使用者掛的行事曆，不推 --strict-mcp-config
      out = await adapter.complete({ prompt, meta: { kind: 'snapshot', mcp: 'calendar' } });
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

  // 待辦聚合（US-035）：等人狀態五種＋時間未定＋待核可提議＋Google 異動卡——server 一次算好，前端不做 N+1
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

  // 刪共用檔順帶清勾選（移植合併輪 U1a）：掃所有流程步驟的 attachments，拿掉指向這份檔的 {scope,name}；
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

  async function handleApi(req, res, segs) {
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
        const out = await compose({ adapter, messages: body.messages ?? [], currentDraft: body.current_draft ?? null, context: ctx, ...logPair('compose') });
        // 記憶輪（M2）記路④：拆好了才路由最後一句使用者話——已存流程在哪個分類就用在那個分類（ctx.category 是驗過存在的），
        // 新草稿用在全部。路由失敗只多一句 memory_notice，拆好的草稿照回
        const lastSaid = [...(body.messages ?? [])].reverse().find((m) => m?.role === 'user')?.text ?? '';
        out.memory_notice = await memory.onChat({ text: lastSaid, category: ctx.category, def: body.current_draft ?? null });
        return json(200, out);
      }
      // /api/preflight 開跑前健檢（資料通道輪）：任何定義（草稿／畫布工作本／已存）都能查——抽屜預覽與開跑擋門同一份規則
      if (segs[1] === 'preflight' && req.method === 'POST' && segs.length === 2) {
        const body = await readBody(req);
        try {
          validateWorkflow(body.def, { allowFloating: true });
        } catch (e) {
          return json(400, { error: e.message });
        }
        return json(200, preflight(body.def, body.values ?? null)); // values＝這次的值（開跑前才給）
      }
      // /api/render 文字成品排版（產檔輪）：停點卡／成品區／儀表板預覽用，原生 HTML 一律跳脫
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
          // 產檔輪定案：匯入的流程一律關產檔權限——伺服器端再鎖一次，不信任前端送來的旗標
          body.def = { ...body.def, permissions: { ...(body.def?.permissions ?? {}), files: false } };
          validateWorkflow(body.def, { allowFloating: true });
          // 隨檔排程（D20）：只有帶明確合法 freq 的才算有排程（健檢 M5：空物件≠預設週排程）；
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

      // ===== 記憶輪：記憶卡／記憶垃圾桶／通知撤回／清空／介紹／詞典／群組圈／這條流程會帶什麼／身分（契約 (h)；錯誤一律人話）=====
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
              if (!SCOPE_LEVELS.includes(b.level)) return json(400, { error: '用在哪只能是全部、分類、流程' });
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
      // ===== 三層共用檔（移植合併輪 U1a）：/api/shared/:scope/files（scope＝_company｜現有分類名）=====
      // 規範類（rule）上傳時轉純文字存 text_cache、擋格式與字數（單檔 4,000／每層 8,000→413）；參考類（ref）任何副檔名、10MB 封頂（同流程參考檔）；
      // 同名 409（換版＝先刪再傳）；刪除不進垃圾桶，順帶把所有流程步驟裡指向它的勾選拿掉（進履歷，看得到為什麼勾選不見了）
      if (segs[1] === 'shared' && segs[3] === 'files' && (segs.length === 4 || segs.length === 5)) {
        const scope = decodeURIComponent(segs[2]);
        if (scope !== '_company' && !store.listCategories().includes(scope)) return json(404, { error: '沒有這個分類' });
        const view = () => json(200, { scope, ...store.listShared(scope), limits: { ...LIMITS } });
        if (req.method === 'GET' && segs.length === 4) return view();
        if (req.method === 'POST' && segs.length === 4) {
          const b = await readBody(req);
          if (typeof b.name !== 'string') return json(400, { error: '檔名要是文字' });
          const name = safeFileName(b.name); // 不合法／保留字直接 400（StoreError BAD_NAME）
          if (b.kind !== 'rule' && b.kind !== 'ref') return json(400, { error: '要說明這份是規範還是參考' });
          // content_b64 嚴格驗證（U1a 覆核）：Buffer.from 對壞 base64 寬鬆解碼不報錯，會把亂碼當內容存進去；型別錯也走同一句人話
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
      // ===== 記憶輪：全域設定（設定頁六組的資料源）與備份 =====
      if (segs[1] === 'settings' && segs.length === 2) {
        if (req.method === 'GET') return json(200, { ...store.readSettings(), data_dir: dataDir, version: PKG_VERSION });
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
      // 常用預設庫（D19，複製式）
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
      // ===== D20：開機自動啟動（US-043）=====
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
          if (!b.workflow_id || !String(b.workflow_id).includes('/')) return json(400, { error: '要指定掛哪一條流程' });
          const [wc, ...wr] = String(b.workflow_id).split('/');
          const def = store.readWorkflow(wc, wr.join('/')); // 不存在 → 404
          // 有填的欄位保留原值交給 validator（健檢 M1：錯誤型別要被打回 400，不准被靜默改成別的設定）
          // 記憶輪（M5b）：沒帶「錯過自動補」「提前提醒」就用設定頁「執行與排程」的預設（settings.exec）；設定讀不到→程式缺省，不擋建排程
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
            // 例外：純「停用」永遠放行（安全方向）——設定有誤的舊排程也要能先按暫停（複查覆核邊角）
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
          // 每個動作走真實路徑，失敗就丟——不吞錯假成功（S1 教訓）
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

      // ===== 儀表板（儀表板輪）：最近執行卡＋用量帳——server 一次算好，前端不做 N+1 =====
      if (segs[1] === 'dashboard' && req.method === 'GET' && segs.length === 2) {
        const q = new URL(req.url, 'http://localhost').searchParams;
        const limit = Math.min(50, Number(q.get('limit')) || 12);
        const days = Math.min(365, Number(q.get('days')) || 30);
        const allUsage = store.readUsage();
        const byRun = {};
        const byRunCheck = {}; // 交貨查核輪：run 卡片附「查核 N token」，只算 kind==='check' 那幾筆
        const byRunSup = {}; // 監工輪：同上，只算 kind==='supervisor'（開場、交接、收尾三種都在裡面）
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
        // 記憶輪（M4）：「要你處理」第一列的數——到期＋休眠＋被取代（summary 的例外三格各數幾張；卡讀不到＝全 0，不擋儀表板）
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
          // 詞典自己長（記憶輪）：欄位名對不上詞典就新建一條（記從哪條流程長出來）；像同一件事的提醒一句，不擋、不寫
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
          store.readWorkflow(category, id); // 不存在 → 404
          const body = await readBody(req);
          // 監工輪：存檔只補監工與查核兩個主開關，不碰 check.facts——沒有那個欄位的既有流程缺省是開，
          // 補一個 false 進去等於使用者沒動手就被關掉（save 模式的定義見 schema.applyDefaults）
          const saveDef = applyDefaults(body.def, { mode: 'save' });
          validateWorkflow(saveDef, { allowFloating: true });
          const version = store.saveManualEdit(category, id, saveDef); // 畫布／欄位編輯也進履歷（US-010）
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

      // 版本履歷與退回（US-010）
      if (segs[4] === 'versions' && req.method === 'GET' && segs.length === 5) return json(200, store.listVersions(category, id));
      if (segs[4] === 'rollback' && req.method === 'POST' && segs.length === 5) {
        store.rollback(category, id, (await readBody(req)).version);
        return json(200, { ok: true });
      }

      // 參考檔（D19：步驟掛附件／範本）：上傳走 base64 JSON，10MB 封頂
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

      if (segs[4] === 'runs') {
        // GET /runs 清單（接回進行中用）；?detail=1（移植合併輪 U4a）每筆補 finished_at／steps／finals／files、started_at 倒序——流程頁右側「每次執行」用。
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
            return json(503, { error: '連不上 Claude——先把 Claude 開起來（或重新登入）再按開始。你的流程庫都在，不會不見。' });
          }
          const body = await readBody(req);
          // 資料通道輪：固定規則擋門——AI 步驟開跑時什麼都拿不到就不開跑（提醒類不擋），UI 端先查過，這裡是兜底
          const defForRun = store.readWorkflow(category, id);
          // 這次的值照 runner 的解法算（空白退預設）——健檢看值（排程與健檢輪）與實際開跑吃同一份
          const overrides = body.overrides ?? {};
          const values = Object.fromEntries((defForRun.params ?? []).map((p) => {
            const v = overrides[p.key];
            return [p.key, v === undefined || v === null || String(v).trim() === '' ? p.default : v];
          }));
          const pf = preflight(defForRun, values);
          const blocks = pf.issues.filter((i) => i.level === 'block');
          if (blocks.length) {
            return json(409, { error: `開跑前健檢：有 ${blocks.length} 處要先修，修好再按開始`, issues: [...blocks, ...pf.issues.filter((i) => i.level !== 'block')] });
          }
          // 記憶輪（M2）：開跑表單點的習慣卡、點了又改掉的、帶的身分，原樣進 run.memory（M3b 才有介面送這三欄）
          const run = runner.startRun(category, id, body.overrides ?? {}, {
            memoryPicks: body.memory_picks ?? {}, memoryChanged: body.memory_changed ?? [], memoryIdentity: body.memory_identity ?? null,
          }); // 讀檔＋驗定義，壞檔在這裡被擋
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
          run.usage_by_node = usageByNode(store.readUsage(), runId); // 交貨查核輪：這一步花了多少（工人／查核分開）
          return json(200, run);
        }
        // 產檔輪：/runs/:rid/files/:name/preview（頁內預覽形態）與 /inline（以正確 content-type 內嵌回檔，給 pdf iframe）
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
            // 交貨查核輪：停點改過就順手擬「後面每步要守的規則」；擬不出來 deriveEditRules 自己退成預設，這裡只防萬一丟錯，不擋這次修改
            try { await runner.deriveEditRules(category, id, runId, body.node); } catch (e) { console.error('[bojian] 擬規則失敗（不擋修改）：', e.message); }
            runner.resume(category, id, runId); // 規則寫進檔案了才放行（裁定 28）——在這之前 GET run 看到的是 paused，不會把下游先放出去
            // 記憶輪（M2）記路②：放行後另起一條，不等它（optimizer 的訊號 B 是另一回事，各記各的）；門面自己接住錯，這裡只防萬一
            memory.onStopEdit({ category, id, runId, node: body.node, note: body.note ?? null })
              .catch((e) => console.error('[bojian] 記憶（停點）沒記成：', e.message));
          }
          else if (action === 'human-done') runner.completeHuman(category, id, runId, body.node, body.feedback ?? null, body.content ?? null); // content＝交給下一步的內容（資料通道輪）
          else if (action === 'retry') runner.retry(category, id, runId, body.node);
          else if (action === 'choose-branch') runner.chooseBranch(category, id, runId, body.node, body.target);
          else if (action === 'data-retry') runner.dataRetry(category, id, runId, body.node);
          else if (action === 'data-accept') runner.dataAccept(category, id, runId, body.node);
          else if (action === 'data-supply') runner.dataSupply(category, id, runId, body.node, body.text); // 我補給你（資料通道輪）
          else if (action === 'resume-time') runner.resumeTime(category, id, runId, body.node, body.at ?? null); // 等時刻：現在就繼續／改排時刻（D20）
          else if (action === 'check-retry') runner.checkRetry(category, id, runId, body.node, body.note ?? null); // 查核攔下：回話重做（查核輪）
          else if (action === 'check-accept') runner.checkAccept(category, id, runId, body.node); // 查核攔下：就這樣過（查核輪）
          else if (action === 'edit-rules') runner.setEditRules(category, id, runId, body.node, body.rules); // 查核卡上使用者自己改規則（查核輪）
          else if (action === 'interject') {
            // 插話（監工輪）：只把話留下來等下一次交接消化——不推進流程，所以不 kick()，自己 return
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
            // 記憶輪（M2）記路③：另起一條、等它回一句通知隨 200 回去（optimizer 那條不等、也不知道它）；門面失敗只回 fail 通知
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
    const { pathname } = new URL(req.url, 'http://localhost');
    const segs = pathname.split('/').filter(Boolean);
    if (segs[0] === 'api') return handleApi(req, res, segs);
    return handleStatic(req, res, pathname);
  });

  return {
    start(port, { tickMs = 60_000 } = {}) {
      seedExamples(store, examplesDir);
      try { store.purgeTrash(30); } catch (e) { console.error('[bojian] 垃圾桶清理失敗：', e.message); }
      try { store.purgeMemoryTrash(30); } catch (e) { console.error('[bojian] 記憶垃圾桶清理失敗：', e.message); }
      scheduler.start(tickMs); // 排程器 tick（ADR-005：server 內建、每分鐘、冪等）
      return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    },
    stop() {
      scheduler.stop();
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
