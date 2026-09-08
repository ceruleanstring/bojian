// server — 本地 API＋靜態 UI 服務。只轉接 store／runner／adapter，不含業務邏輯。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { createStore, StoreError } from './store.js';
import { createRunner } from './runner.js';
import { createHostAdapter } from './host-adapter.js';
import { compose, ComposeError } from './composer.js';
import { validateWorkflow, outgoing } from './schema.js';
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

// 交貨查核輪：run 詳情頁的用量彙總——依 node＋kind 彙總這個 run 的帳；擬規則（edit-rules）兩邊都不算，
// 它不是工人的一步也不是查核的一次，只在儀表板／帳本總量裡算（既有邏輯不動）。沒有任何紀錄的節點不出現在結果裡。
function usageByNode(allUsage, runId) {
  const out = {};
  for (const u of allUsage) {
    if (u.run !== runId || !u.node) continue;
    const bucket = u.kind === 'check' ? 'check' : u.kind === 'step' ? 'step' : null;
    if (!bucket) continue;
    const n = (out[u.node] ??= { step: { input: 0, output: 0, calls: 0 }, check: { input: 0, output: 0, calls: 0 } });
    const b = n[bucket];
    b.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    b.output += u.output_tokens ?? 0;
    b.calls += 1;
  }
  return out;
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
  const runner = createRunner({ store, adapter, now });
  const optimizer = createOptimizer({ store, adapter });
  const inflight = new Set();

  function kick(category, id, runId) {
    const key = `${category}/${id}/${runId}`;
    if (inflight.has(key)) return;
    inflight.add(key);
    runner.runUntilPause(category, id, runId)
      .then((run) => {
        // run 跑完＝優化引擎的進場時機（US-007：run 結束後出提議）
        if (run?.status === 'done') {
          optimizer.analyze(category, id).catch((e) => console.error('[bojian] 提議產生失敗（下次一起看）：', e.message));
        }
      })
      .catch((e) => console.error('[bojian] run 推進失敗：', e.message))
      .finally(() => inflight.delete(key));
  }

  const scheduler = createScheduler({ store, runner, kick, now });

  // Google 快照抓取（US-034）：任何失敗都不覆寫既有快取，回人話原因（Error Map）
  async function refreshSnapshot(month) {
    let out;
    try {
      out = await adapter.complete({ prompt: snapshotPrompt(month), meta: { kind: 'snapshot' } });
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
        const out = await compose({ adapter, messages: body.messages ?? [], currentDraft: body.current_draft ?? null });
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
          const scan = await scanImport({ adapter, def });
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
          const sched = {
            id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            name: b.name === undefined ? def.name : (typeof b.name === 'string' && b.name.trim() ? b.name.trim() : b.name),
            workflow_id: b.workflow_id, freq: b.freq,
            weekday: b.weekday ?? 1, day: b.day ?? 1, time: b.time ?? '08:00', at: b.at ?? null,
            enabled: b.enabled === undefined ? true : b.enabled,
            auto_makeup: b.auto_makeup === undefined ? false : b.auto_makeup,
            remind_leads: b.remind_leads === undefined ? [] : b.remind_leads,
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
        for (const u of allUsage) {
          if (!u.run) continue;
          const b = (byRun[u.run] ??= { input: 0, output: 0, cost: 0 });
          b.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          b.output += u.output_tokens ?? 0;
          b.cost += u.cost_usd ?? 0;
          if (u.kind === 'check') {
            const c = (byRunCheck[u.run] ??= { input: 0, output: 0 });
            c.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
            c.output += u.output_tokens ?? 0;
          }
        }
        const recent = store.listRecentRuns(limit).map((r) => {
          let run;
          try { run = store.readRun(r.category, r.id, r.runId); } catch { return null; } // 壞 run 檔不擋整頁
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
          const steps = Object.values(run.steps ?? {}).reduce(
            (a, s) => ({ total: a.total + 1, done: a.done + (s.status === 'done' ? 1 : 0), failed: a.failed + (s.status === 'failed' ? 1 : 0) }),
            { total: 0, done: 0, failed: 0 },
          );
          const usage = byRun[r.runId] ? { ...byRun[r.runId], check: byRunCheck[r.runId] ?? { input: 0, output: 0 } } : null;
          return {
            category: r.category, id: r.id, name: run.workflow?.name ?? r.name, run_id: r.runId,
            status: run.status, source: run.source ?? 'manual', makeup: run.makeup === true,
            started_at: run.started_at, finished_at: run.finished_at, finals, steps,
            usage,
          };
        }).filter(Boolean);
        const sinceMs = now() - days * 86_400_000;
        return json(200, { recent, usage: allUsage.filter((u) => new Date(u.at).getTime() >= sinceMs), usage_days: days });
      }

      if (segs[1] !== 'workflows') return json(404, { error: '找不到這個位址' });

      // /api/workflows：清單／存新流程
      if (segs.length === 2) {
        if (req.method === 'POST') {
          const body = await readBody(req);
          // 產檔輪：親手建的流程預設開產檔權限（匯入走 /api/import/confirm，那邊一律關）
          if (body.def && typeof body.def === 'object' && body.def.permissions === undefined) body.def.permissions = { files: true };
          // 交貨查核輪：新建流程預設開查核（匯入不動，沿用缺省＝開）
          if (body.def && typeof body.def === 'object' && body.def.check === undefined) body.def.check = { enabled: true };
          validateWorkflow(body.def, { allowFloating: true });
          const id = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          store.writeWorkflow(body.category, id, body.def); // 分類名過 store 護欄，`../x` 這類直接 400
          return json(200, { category: body.category, id });
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
          validateWorkflow(body.def, { allowFloating: true });
          const version = store.saveManualEdit(category, id, body.def); // 畫布／欄位編輯也進履歷（US-010）
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
        // GET /runs 清單（接回進行中用）
        if (segs.length === 5 && req.method === 'GET') {
          return json(200, store.listRuns(category, id).map((rid) => {
            const r = store.readRun(category, id, rid);
            return { run_id: rid, status: r.status, started_at: r.started_at };
          }));
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
          const run = runner.startRun(category, id, body.overrides ?? {}); // 讀檔＋驗定義，壞檔在這裡被擋
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
          else if (action === 'run-feedback') {
            const run = store.readRun(category, id, runId);
            run.feedback = body.text;
            store.writeRun(category, id, runId, run);
            optimizer.analyze(category, id, { feedback: body.text })
              .catch((e) => console.error('[bojian] 提議產生失敗（下次一起看）：', e.message));
            return json(200, { ok: true });
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
