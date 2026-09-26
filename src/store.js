// store — 流程庫檔案樹讀寫（ADR-002：YAML＋版本快照＋原子寫入）。不管執行、不管 UI。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import { FACTORY_DICT } from './memory.js';

export class StoreError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function atomicWrite(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath); // 先寫暫存檔再改名，避免半套
}

function readYaml(filePath, subject) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new StoreError(`找不到${subject}`, 'NOT_FOUND');
  }
  try {
    return yaml.load(text);
  } catch {
    throw new StoreError(`${subject}的檔案讀不懂（可能被手動改壞）`, 'CORRUPT');
  }
}

// 檔名護欄：擋路徑跳脫與 Windows 禁字（參考檔與產出物共用）
// Windows 保留裝置名（CON／PRN／AUX／NUL／COM1–9／LPT1–9）：不分大小寫、帶副檔名也算（CON.md 一樣寫不進 NTFS）
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const UPLOAD_OWNER = 'owner..json'; // 本次上傳暫存夾的綁定記號
// 工人在產出夾留下的工作痕跡：腳本 .js、數字檔 數字-<步驟id>.json（US-110）——清單不列、成品不算
export const isWorkScrap = (name) => /\.js$/i.test(name) || /^數字-.+\.json$/i.test(name);

export function safeFileName(name) {
  const n = String(name ?? '').trim();
  // 控制字元（NUL 等）先擋——落到寫檔才炸的話，系統錯誤訊息會帶出伺服器絕對路徑
  if (/[\x00-\x1f\x7f]/.test(n)) throw new StoreError('檔名裡有看不見的控制字元，換個名字再傳', 'BAD_NAME');
  if (!n || /[\\/:*?"<>|]/.test(n) || n.includes('..')) throw new StoreError(`檔名「${name}」不合法（不能含路徑符號）`, 'BAD_NAME');
  if (RESERVED_NAMES.test(n)) throw new StoreError(`檔名「${name}」是系統保留字，換個名字`, 'BAD_NAME');
  return n;
}

// 落盤名防撞（B02，Codex 2026-09-25）：跟 taken 裡任一名字撞到（不分大小寫——NTFS 把 Case.txt／case.txt 當同一個檔）
// 就在副檔名前加 -2、-3…直到沒撞；先傳的一律不動，回給呼叫端的是實際落盤名。沒撞＝原名照回
export function dedupeFileName(name, taken = []) {
  const used = new Set([...taken].map((t) => String(t).toLowerCase()));
  if (!used.has(String(name).toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

// 路徑段護欄（健檢 P2-01）：分類／流程 id／run id／垃圾桶鍵組路徑前必過，擋 ..、斜線與 Windows 禁字
function safeSegment(value, subject) {
  const n = String(value ?? '').trim();
  if (!n || /[\\/:*?"<>|]/.test(n) || n === '.' || n.includes('..')) {
    throw new StoreError(`${subject}「${value}」不合法（不能含路徑符號）`, 'BAD_NAME');
  }
  return n;
}

// 全域設定缺省：缺檔＝全部缺省；readSettings 深合併（物件逐鍵補、陣列整個取代）
export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  memory: { paused: false, sensitive: { health: false, politics: false, religion: false, finance: false }, intro_done_at: null },
  defaults: {
    permissions_files: true, check_enabled: true, check_facts: 'auto', supervisor_enabled: true,
    supervisor_flags: { note: true, tier: false, tools: false }, model_tier: null, retry: null,
  },
  // overview_enabled（ADR-007 第 5 條）：跑完出總覽，預設開；關掉＝那趟不發總覽那次呼叫（overviewEnabled 只認明寫的 false）
  exec: { auto_makeup: false, remind_leads: [], web: true, overview_enabled: true },
  company_name: '', // 三層共用檔：側欄最上層節點的名字，空＝「公司」
  compose: { confirm_shape: true }, // 一句話進來先出成品卡再拆；關掉＝伺服器連跑兩趟直接出草稿
  report_optin: false, // US-120／ADR-013：「回傳使用計數」開關，預設關；關著程式不建立任何對外連線
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export function deepMerge(base, over) {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

// 多組織：dataDir＝單一組織夾（data/orgs/<org>/），root＝資料根（data/，含 orgs.json 與所有組織）。
// 備份備的是 root，不帶 root 時 root＝dataDir，行為與單組織時代完全相同。
export function createStore(dataDir, { root: backupRoot = dataDir } = {}) {
  const wfDir = (category, id) => path.join(dataDir, 'workflows', safeSegment(category, '分類'), safeSegment(id, 'Workflow'));
  const wfFile = (category, id) => path.join(wfDir(category, id), 'workflow.yaml');
  const historyDir = (category, id) => path.join(wfDir(category, id), 'history');
  const runDir = (category, id, runId) => path.join(wfDir(category, id), 'runs', safeSegment(runId, '執行紀錄'));
  const refDir = (category, id) => path.join(wfDir(category, id), 'files');
  const outDir = (category, id, runId) => path.join(runDir(category, id, runId), 'out');
  const promptDir = (category, id, runId) => path.join(runDir(category, id, runId), 'prompts');
  const logDir = (kind) => path.join(dataDir, 'logs', safeSegment(kind, '工作單種類'));
  const presetsFile = path.join(dataDir, 'presets.json');
  const usageFile = path.join(dataDir, 'usage.jsonl');
  const schedulesFile = path.join(dataDir, 'schedules.json');
  const noticesFile = path.join(dataDir, 'notices.json');
  const snapshotFile = path.join(dataDir, 'calendar-snapshot.json');
  // 連線清單快取（ADR-006）：宿主連了哪些服務是整台電腦共用的，放資料根（不分組織）；刪檔＝回到沒抓過
  const connectorsFile = path.join(backupRoot, 'connectors.json');
  // 兩本帳（habits/、profile/）、詞典、群組圈、身分、記憶垃圾桶都在 memory/ 底下；設定檔在資料根
  const memoryDir = path.join(dataDir, 'memory');
  const CARD_DIRS = { habit: 'habits', profile: 'profile' };
  const bucketDir = (bucket) => {
    if (!Object.hasOwn(CARD_DIRS, bucket)) throw new StoreError(`沒有這種卡（${bucket}）`, 'BAD_NAME');
    return path.join(memoryDir, CARD_DIRS[bucket]);
  };
  const cardFile = (bucket, id) => path.join(bucketDir(bucket), `${safeFileName(id)}.yaml`);
  const groupFile = (category) => path.join(memoryDir, 'groups', `${safeSegment(category, '分類')}.yaml`);
  const dictFile = path.join(memoryDir, 'dict.yaml');
  const identitiesFile = path.join(memoryDir, 'identities.yaml');
  // L13b：Workflow 換了分類（移分類／分類改名），已發出的本次上傳代碼記號跟著改——id 不保證跨分類唯一（範例補種只看「範例」分類），
  // 所以綁定仍比 {category, id}，改成搬家時同步記號。回 [[記號檔, 原文]] 給改名失敗時寫回；讀不到／壞記號跳過（最壞是使用者重選檔）
  const retagUploads = (fromCat, toCat, id = null) => {
    const done = [];
    let tokens = [];
    try { tokens = fs.readdirSync(path.join(dataDir, 'uploads')); } catch { return done; }
    for (const t of tokens) {
      const f = path.join(dataDir, 'uploads', t, UPLOAD_OWNER);
      try {
        const text = fs.readFileSync(f, 'utf8');
        const o = JSON.parse(text);
        if (o?.category !== fromCat || (id !== null && o.id !== id)) continue;
        fs.writeFileSync(f, JSON.stringify({ ...o, category: toCat })); // 不用 atomicWrite：不在暫存夾多建檔、不延長 24 小時清理
        done.push([f, text]);
      } catch { /* 沒記號或壞記號：不動 */ }
    }
    return done;
  };
  const settingsFile = path.join(dataDir, 'settings.json');
  const memoryTrashDir = path.join(memoryDir, 'trash');
  const backupsRoot = path.join(path.dirname(backupRoot), `${path.basename(backupRoot)}-backups`);

  // 頂層 JSON 檔共用小工具：檔案不存在＝空狀態（刪檔即回滾——ADR-005）；
  // 檔案存在但讀不懂＝明確報錯擋住後續寫入，不准把壞檔當空資料再覆蓋掉（健檢 P1-01）。
  // 快照類（可重抓的快取）例外走 lenient：壞了視為沒有，重抓即復原。
  function readJsonOr(file, fallback, { lenient = false } = {}) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      // 只有「檔案不存在」才算空狀態；其他讀取錯誤（是資料夾、權限）不准偽裝成沒資料（健檢 L1）
      if (e.code === 'ENOENT' || lenient) return fallback;
      throw new StoreError(`「${path.basename(file)}」讀不到（${e.code ?? '未知原因'}）——檢查這個檔案的狀態再繼續`, 'CORRUPT');
    }
    try {
      return JSON.parse(text);
    } catch {
      if (lenient) return fallback;
      throw new StoreError(`「${path.basename(file)}」讀不懂（可能被改壞）——把它修好或刪掉再繼續；剝繭不會動這個壞檔`, 'CORRUPT');
    }
  }

  function listHistoryVersions(category, id) {
    const dir = historyDir(category, id);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .map((f) => /^v(\d+)\.yaml$/.exec(f))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  }

  return {
    dataDir,

    listWorkflows() {
      const root = path.join(dataDir, 'workflows');
      if (!fs.existsSync(root)) return [];
      const out = [];
      for (const category of fs.readdirSync(root)) {
        const catPath = path.join(root, category);
        if (!fs.statSync(catPath).isDirectory()) continue;
        for (const id of fs.readdirSync(catPath)) {
          if (!fs.existsSync(path.join(catPath, id, 'workflow.yaml'))) continue;
          let name = id;
          let steps = null; // Workflow 庫卡片「N 步驟・M 步你來」——只加回應欄位，定義檔不動；壞檔＝null
          let human_steps = null;
          try {
            const def = readYaml(path.join(catPath, id, 'workflow.yaml'), 'Workflow');
            name = def.name ?? id;
            if (Array.isArray(def.nodes)) {
              const tasks = def.nodes.filter((n) => n && (n.kind ?? 'task') === 'task'); // 分岔／並行點不算步驟
              steps = tasks.length;
              human_steps = tasks.filter((n) => n.executor === 'human').length;
            }
          } catch {
            // 壞檔仍列出（讀取時才報錯），名字先用 id
          }
          out.push({ category, id, name, steps, human_steps });
        }
      }
      return out;
    },

    readWorkflow(category, id) {
      return readYaml(wfFile(category, id), `Workflow「${id}」`);
    },

    // 新建（檔還不在）補 created_at（US-119 ⑧：建流程到第一次跑的間隔要有起點）；帶著來的（匯入／複製）照存；
    // 既有檔沒有就維持沒有，不回填。不動呼叫者的物件
    writeWorkflow(category, id, defIn) {
      const isNew = !fs.existsSync(wfFile(category, id));
      const def = isNew && defIn && typeof defIn === 'object' && !Array.isArray(defIn) && defIn.created_at === undefined
        ? { ...defIn, created_at: new Date().toISOString() } : defIn;
      atomicWrite(wfFile(category, id), yaml.dump(def, { lineWidth: -1 }));
      if (listHistoryVersions(category, id).length === 0) {
        const snapshot = { diff_note: '建立', source: 'create', def };
        atomicWrite(path.join(historyDir(category, id), 'v1.yaml'), yaml.dump(snapshot, { lineWidth: -1 }));
      }
    },

    listCategories() {
      const root = path.join(dataDir, 'workflows');
      if (!fs.existsSync(root)) return [];
      return fs.readdirSync(root).filter((c) => fs.statSync(path.join(root, c)).isDirectory());
    },

    createCategory(name) {
      const n = safeSegment(name, '分類名稱');
      if (n === '_company') throw new StoreError('分類名不能是 _company（那是組織共用夾的名字）', 'BAD_NAME');
      fs.mkdirSync(path.join(dataDir, 'workflows', n), { recursive: true });
    },

    // 分類改名：分類名＝目錄名＝到處的鑰匙，九處一起搬——流程夾、群組 yaml、共用夾（三者缺哪個就跳）、
    // schedules.json 的 workflow_id 前綴、提議隊列 workflow.category、習慣卡與認識卡 scope.category（只認 category／workflow 兩層）、
    // 身分 categories、垃圾桶 meta.yaml 的 category、未讀通知的 run.category（第九處，B0 未讀通知是要點來操作的佇列，
    // 不是被動歷史；不改的話「重試」會拿舊分類去找 run 回一個莫名其妙的 404）。run.yaml／history/vN.yaml／用量帳本不動（歷史留舊名）。
    // 先全部讀進記憶體（壞檔在這裡就擋、什麼都沒搬），再搬目錄、再改檔；中途丟錯＝把已搬的目錄搬回、已改的檔寫回原文。
    renameCategory(oldName, nextName) {
      if (!String(nextName ?? '').trim()) throw new StoreError('名稱不可留空', 'BAD_NAME');
      const from = safeSegment(oldName, '分類名稱');
      const to = safeSegment(nextName, '分類名稱');
      if (from === '未分類' || to === '未分類') throw new StoreError('「未分類」不能改名', 'BAD_NAME');
      if (from === '_company' || to === '_company') throw new StoreError('分類名不能是 _company（那是組織共用夾的名字）', 'BAD_NAME');
      if (from === to) throw new StoreError('新舊名稱相同', 'BAD_NAME');
      const root = path.join(dataDir, 'workflows');
      if (!fs.existsSync(path.join(root, from))) throw new StoreError(`找不到分類「${from}」`, 'NOT_FOUND');
      if (fs.existsSync(path.join(root, to))) throw new StoreError('已有同名分類', 'CONFLICT');

      // 1) 全部先讀（讀不到／讀不懂在這裡就丟，還沒動任何東西）
      const workflows = this.listWorkflows().filter((w) => w.category === from).length;
      const scheds = this.readSchedules();
      const props = this.readProposals();
      const cards = this.listCards().filter((c) => ['category', 'workflow'].includes(c.scope?.level) && c.scope.category === from);
      const idns = this.readIdentities();
      const notices = this.readNotices();
      const trash = this.listTrash().filter((t) => t.category === from);
      const groupText = fs.existsSync(groupFile(from)) ? fs.readFileSync(groupFile(from), 'utf8') : null;
      const dirs = [
        [path.join(root, from), path.join(root, to)],
        [groupFile(from), groupFile(to)],
        [this.sharedDir(from), this.sharedDir(to)],
      ].filter(([a]) => fs.existsSync(a));

      // 2) 搬目錄（記下搬過的，失敗搬回）；3) 改檔（記下原文，失敗寫回）
      const movedDirs = [];
      const written = []; // [filePath, 原文或 null（原本沒這個檔）]
      const rewrite = (file, text) => {
        written.push([file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null]);
        atomicWrite(file, text);
      };
      try {
        for (const [a, b] of dirs) { fs.renameSync(a, b); movedDirs.push([a, b]); }
        written.push(...retagUploads(from, to)); // 第十處：未送出的本次上傳代碼；不計入 counts
        const counts = { workflows, schedules: 0, proposals: 0, cards: 0, identities: 0, notices: 0, trash: 0 };
        if (groupText !== null) {
          const g = yaml.load(groupText);
          if (isPlainObject(g) && g.category === from) rewrite(groupFile(to), yaml.dump({ ...g, category: to }, { lineWidth: -1 }));
        }
        const prefix = `${from}/`;
        for (const s of scheds) if (typeof s.workflow_id === 'string' && s.workflow_id.startsWith(prefix)) { s.workflow_id = `${to}/${s.workflow_id.slice(prefix.length)}`; counts.schedules += 1; }
        if (counts.schedules) rewrite(schedulesFile, JSON.stringify(scheds, null, 2));
        for (const p of props) if (p?.workflow?.category === from) { p.workflow.category = to; counts.proposals += 1; }
        if (counts.proposals) rewrite(path.join(dataDir, 'proposals', 'queue.yaml'), yaml.dump(props, { lineWidth: -1 }));
        for (const c of cards) { c.scope.category = to; rewrite(cardFile(c.bucket, c.id), yaml.dump(c, { lineWidth: -1 })); counts.cards += 1; }
        for (const i of idns) {
          if (!Array.isArray(i?.categories) || !i.categories.includes(from)) continue;
          i.categories = i.categories.map((c) => (c === from ? to : c));
          counts.identities += 1;
        }
        if (counts.identities) rewrite(identitiesFile, yaml.dump(idns, { lineWidth: -1 }));
        // 第九處：只改未讀通知（還沒處理的才要指得到現況；已處理的留痕不動）
        for (const n of notices) if (n?.status === 'unread' && n.run?.category === from) { n.run.category = to; counts.notices += 1; }
        if (counts.notices) rewrite(noticesFile, JSON.stringify(notices, null, 2));
        for (const { key, ...meta } of trash) { rewrite(path.join(dataDir, 'trash', key, 'meta.yaml'), yaml.dump({ ...meta, category: to })); counts.trash += 1; }
        return counts;
      } catch (e) {
        for (const [file, text] of written.reverse()) {
          try { if (text === null) fs.rmSync(file, { force: true }); else atomicWrite(file, text); } catch { /* 盡力寫回 */ }
        }
        for (const [a, b] of movedDirs.reverse()) {
          try { fs.renameSync(b, a); } catch { /* 盡力搬回 */ }
        }
        if (e instanceof StoreError) throw e;
        throw new StoreError(`分類改名做到一半失敗（${e.code ?? e.message}），已把搬過的東西放回原位；檢查資料夾狀態再試一次`, 'RENAME_FAILED');
      }
    },

    // 搬分類＝把「分類/id」這把鍵換掉。除了目錄，排程的 workflow_id、提議的 workflow.category、
    // 流程層卡片的 scope.category、未讀通知的 run.category 都握著同一把鍵——不一起改，排程每次到點
    // 都拿舊分類去找、永遠 start_failed，而且每天發一則新通知，沒有任何線索指向那次搬動（2026-09-18 審查）。
    // 紀律同 renameCategory：先全部讀進記憶體（壞檔在這裡就擋、什麼都沒搬），再搬目錄、再改檔，中途失敗全部放回。
    moveWorkflow(category, id, toCategory) {
      const from = wfDir(category, id);
      if (!fs.existsSync(path.join(from, 'workflow.yaml'))) throw new StoreError(`找不到 Workflow「${id}」`, 'NOT_FOUND');
      const to = wfDir(toCategory, id);
      if (fs.existsSync(to)) throw new StoreError(`「${toCategory}」分類裡已有同名 Workflow`, 'CONFLICT');

      // 1) 全部先讀（讀不到／讀不懂在這裡就丟，還沒動任何東西）
      const scheds = this.readSchedules();
      const props = this.readProposals();
      const cards = this.listCards().filter((c) => c.scope?.level === 'workflow'
        && c.scope.category === category && c.scope.workflow === id);
      const notices = this.readNotices();
      const oldKey = `${category}/${id}`;

      // 2) 搬目錄（失敗搬回）；3) 改檔（記下原文，失敗寫回）
      const movedDirs = [];
      const written = [];
      const rewrite = (file, text) => {
        written.push([file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null]);
        atomicWrite(file, text);
      };
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to); // 整個資料夾搬——履歷、run 紀錄一起走
        movedDirs.push([from, to]);
        written.push(...retagUploads(category, toCategory, id)); // L13b：還沒送出的本次上傳跟著走
        const counts = { schedules: 0, proposals: 0, cards: 0, notices: 0 };
        for (const s of scheds) if (s.workflow_id === oldKey) { s.workflow_id = `${toCategory}/${id}`; counts.schedules += 1; }
        if (counts.schedules) rewrite(schedulesFile, JSON.stringify(scheds, null, 2));
        for (const p of props) if (p?.workflow?.category === category && p.workflow.id === id) { p.workflow.category = toCategory; counts.proposals += 1; }
        if (counts.proposals) rewrite(path.join(dataDir, 'proposals', 'queue.yaml'), yaml.dump(props, { lineWidth: -1 }));
        for (const c of cards) { c.scope.category = toCategory; rewrite(cardFile(c.bucket, c.id), yaml.dump(c, { lineWidth: -1 })); counts.cards += 1; }
        // 只改未讀通知（還沒處理的才要指得到現況；已處理的留痕不動，同 renameCategory 第九處）
        for (const n of notices) if (n?.status === 'unread' && n.run?.category === category && n.run?.id === id) { n.run.category = toCategory; counts.notices += 1; }
        if (counts.notices) rewrite(noticesFile, JSON.stringify(notices, null, 2));
        return counts;
      } catch (e) {
        for (const [file, text] of written.reverse()) {
          try { if (text === null) fs.rmSync(file, { force: true }); else atomicWrite(file, text); } catch { /* 盡力寫回 */ }
        }
        for (const [a, b] of movedDirs.reverse()) {
          try { fs.renameSync(b, a); } catch { /* 盡力搬回 */ }
        }
        if (e instanceof StoreError) throw e;
        throw new StoreError(`搬分類做到一半失敗（${e.code ?? e.message}），已把搬過的東西放回原位；檢查資料夾狀態再試一次`, 'MOVE_FAILED');
      }
    },

    restoreLatest(category, id) {
      const versions = listHistoryVersions(category, id);
      if (versions.length === 0) throw new StoreError(`Workflow「${id}」沒有可還原的版本`, 'NOT_FOUND');
      const latest = readYaml(path.join(historyDir(category, id), `v${versions.at(-1)}.yaml`), '版本快照');
      atomicWrite(wfFile(category, id), yaml.dump(latest.def, { lineWidth: -1 }));
      return latest.def;
    },

    listVersions(category, id) {
      return listHistoryVersions(category, id).map((v) => {
        const snap = readYaml(path.join(historyDir(category, id), `v${v}.yaml`), '版本快照');
        return { version: v, diff_note: snap.diff_note, source: snap.source, at: snap.at ?? null };
      });
    },

    readVersion(category, id, version) {
      return readYaml(path.join(historyDir(category, id), `v${version}.yaml`), `版本 v${version}`);
    },

    // 核可提議／退回時升版：現行檔與快照一起寫
    bumpVersion(category, id, defIn, diffNote, source) {
      const versions = listHistoryVersions(category, id);
      const n = (versions.at(-1) ?? 0) + 1;
      // 升版沿用建立時間：前端送回的定義（或退回的舊快照）可能沒帶 created_at，檔上有就補回；檔上本來沒有就不回填
      let def = defIn;
      if (def && typeof def === 'object' && !Array.isArray(def) && def.created_at === undefined) {
        try {
          const cur = readYaml(wfFile(category, id), `Workflow「${id}」`);
          if (typeof cur?.created_at === 'string') def = { ...def, created_at: cur.created_at };
        } catch { /* 現行檔讀不到就照原樣寫 */ }
      }
      atomicWrite(path.join(historyDir(category, id), `v${n}.yaml`),
        yaml.dump({ diff_note: diffNote, source, at: new Date().toISOString(), def }, { lineWidth: -1 }));
      atomicWrite(wfFile(category, id), yaml.dump(def, { lineWidth: -1 }));
      return n;
    },

    // 手動編輯（畫布／欄位）存檔：進履歷。十分鐘內的連續編輯合併成同一版，免得灌版本
    saveManualEdit(category, id, def) {
      const versions = this.listVersions(category, id);
      const last = versions.at(-1);
      // 只跟「手動編輯」那種版本合併：改名、共用檔已刪除這類有固定註記的版本不准被後續編輯併掉
      //（否則 note 說改名、內容卻是之後的畫布編輯）
      const recent = last && last.source === 'manual' && last.at && last.diff_note === '手動編輯（畫布／欄位）'
        && Date.now() - new Date(last.at).getTime() < 10 * 60_000;
      if (recent) {
        atomicWrite(path.join(historyDir(category, id), `v${last.version}.yaml`),
          yaml.dump({ diff_note: last.diff_note, source: 'manual', at: last.at, def }, { lineWidth: -1 }));
        atomicWrite(wfFile(category, id), yaml.dump(def, { lineWidth: -1 }));
        return last.version;
      }
      return this.bumpVersion(category, id, def, '手動編輯（畫布／欄位）', 'manual');
    },

    // 流程改名：一定另記一版、註記固定句，不走十分鐘合併；run.yaml 與履歷快照留舊名
    saveRename(category, id, def, oldName) {
      return this.bumpVersion(category, id, def, `改名：「${oldName}」→「${def.name}」`, 'manual');
    },

    // 退回：以舊版為現行版，並再記一版（歷史完整，不刪不改舊快照）
    rollback(category, id, version) {
      const snap = this.readVersion(category, id, version);
      this.bumpVersion(category, id, snap.def, `退回 v${version}`, 'rollback');
      return snap.def;
    },

    readProposals() {
      const f = path.join(dataDir, 'proposals', 'queue.yaml');
      if (!fs.existsSync(f)) return [];
      return readYaml(f, '提議佇列') ?? [];
    },

    writeProposals(list) {
      atomicWrite(path.join(dataDir, 'proposals', 'queue.yaml'), yaml.dump(list, { lineWidth: -1 }));
    },

    // 垃圾桶：整資料夾搬走，30 天內可復原
    trashWorkflow(category, id) {
      const from = wfDir(category, id);
      if (!fs.existsSync(path.join(from, 'workflow.yaml'))) throw new StoreError(`找不到 Workflow「${id}」`, 'NOT_FOUND');
      let name = id;
      try { name = readYaml(path.join(from, 'workflow.yaml'), 'Workflow').name ?? id; } catch { /* 壞檔也可丟 */ }
      const key = `${Date.now().toString(36)}-${category}-${id}`;
      const dest = path.join(dataDir, 'trash', key);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(from, dest);
      atomicWrite(path.join(dest, 'meta.yaml'), yaml.dump({ category, id, name, trashed_at: new Date().toISOString() }));
      return key;
    },

    listTrash() {
      const root = path.join(dataDir, 'trash');
      if (!fs.existsSync(root)) return [];
      return fs.readdirSync(root)
        .filter((k) => fs.existsSync(path.join(root, k, 'meta.yaml')))
        .map((k) => ({ key: k, ...readYaml(path.join(root, k, 'meta.yaml'), '垃圾桶紀錄') }));
    },

    restoreTrash(key) {
      const src = path.join(dataDir, 'trash', safeSegment(key, '垃圾桶紀錄'));
      const meta = readYaml(path.join(src, 'meta.yaml'), '垃圾桶紀錄');
      // 擋門（ 地雷 17）：原分類已不在（被改名或刪掉）→ 不靜默新建舊分類
      if (!this.listCategories().includes(meta.category)) {
        throw new StoreError(`這條 Workflow 原本的分類「${meta.category}」已經不在了，先在側欄建回那個分類，或改名回來再復原`, 'NO_CATEGORY');
      }
      let id = meta.id;
      while (fs.existsSync(wfDir(meta.category, id))) id = `${meta.id}-復原${Math.random().toString(36).slice(2, 5)}`;
      // 先搬再刪 meta（B06，Codex 2026-09-25）：搬失敗（Windows 分享鎖／權限）meta 還在，垃圾桶清單照列、可以重試；
      // 搬成了才清目的地的 meta.yaml——清不掉只是多一個殘檔，復原本身已完成，不能誤報失敗誘發重試
      const dest = wfDir(meta.category, id);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      try { fs.rmSync(path.join(dest, 'meta.yaml'), { force: true }); } catch { /* 已復原；殘留的 meta.yaml 不影響流程讀取 */ }
      return { category: meta.category, id };
    },

    purgeTrash(maxAgeDays = 30) {
      const cutoff = Date.now() - maxAgeDays * 86_400_000;
      for (const t of this.listTrash()) {
        if (new Date(t.trashed_at).getTime() < cutoff) {
          fs.rmSync(path.join(dataDir, 'trash', t.key), { recursive: true, force: true });
        }
      }
    },

    // ---- 記憶垃圾桶：獨立目錄 memory/trash/<key>/{card,meta}.yaml，跟流程垃圾桶不互通
    //（restoreTrash 寫死還原成流程，卡走這四支）；30 天，清理跟流程垃圾桶一樣只在伺服器啟動時跑一次 ----
    trashCard(bucket, id) {
      const from = cardFile(bucket, id);
      if (!fs.existsSync(from)) throw new StoreError('找不到這張卡', 'NOT_FOUND');
      let text = '';
      try { text = readYaml(from, '這張卡')?.text ?? ''; } catch { /* 壞檔也可丟 */ }
      const key = `${Date.now().toString(36)}-${bucket}-${safeFileName(id)}`;
      const dest = path.join(memoryTrashDir, key);
      fs.mkdirSync(dest, { recursive: true });
      fs.renameSync(from, path.join(dest, 'card.yaml'));
      atomicWrite(path.join(dest, 'meta.yaml'), yaml.dump({ bucket, id, text, trashed_at: new Date().toISOString() }));
      return key;
    },

    listMemoryTrash() {
      if (!fs.existsSync(memoryTrashDir)) return [];
      return fs.readdirSync(memoryTrashDir).sort()
        .filter((k) => fs.existsSync(path.join(memoryTrashDir, k, 'meta.yaml')))
        .map((k) => ({ key: k, ...readYaml(path.join(memoryTrashDir, k, 'meta.yaml'), '記憶垃圾桶紀錄') }));
    },

    // 原位重現（id 唯一，不會撞）；回那張卡
    restoreCard(key) {
      const src = path.join(memoryTrashDir, safeSegment(key, '記憶垃圾桶紀錄'));
      if (!fs.existsSync(path.join(src, 'meta.yaml')) || !fs.existsSync(path.join(src, 'card.yaml'))) {
        throw new StoreError('垃圾桶裡沒有這張卡', 'NOT_FOUND');
      }
      const meta = readYaml(path.join(src, 'meta.yaml'), '記憶垃圾桶紀錄');
      const card = readYaml(path.join(src, 'card.yaml'), '這張卡');
      const dest = cardFile(meta.bucket, meta.id);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(path.join(src, 'card.yaml'), dest);
      fs.rmSync(src, { recursive: true, force: true });
      return card;
    },

    purgeMemoryTrash(maxAgeDays = 30) {
      const cutoff = Date.now() - maxAgeDays * 86_400_000;
      for (const t of this.listMemoryTrash()) {
        if (new Date(t.trashed_at).getTime() < cutoff) {
          fs.rmSync(path.join(memoryTrashDir, t.key), { recursive: true, force: true });
        }
      }
    },

    newRunId() {
      const t = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
      return `r-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    },

    // ---- 參考檔----
    writeRefFile(category, id, name, buf) {
      const p = path.join(refDir(category, id), safeFileName(name));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
    },
    listRefFiles(category, id) {
      const dir = refDir(category, id);
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    },
    deleteRefFile(category, id, name) {
      fs.rmSync(path.join(refDir(category, id), safeFileName(name)), { force: true });
    },
    refFilePath(category, id, name) {
      const p = path.join(refDir(category, id), safeFileName(name));
      return fs.existsSync(p) ? p : null;
    },
    // ---- 本次上傳：先進暫存 data/uploads/<token>/<檔名>，開跑時搬進 runs/<rid>/in/；24 小時沒用掉清 ----
    // owner＝{category, id} 發放給哪條 Workflow，記在同夾 owner..json（檔名含 ..，safeFileName 擋掉，不會跟上傳檔撞名）；
    // 讀取帶 owner 時對象不符＝找不到（跨 Workflow 挪用擋下）。沒有綁定記號的舊暫存照舊可用（24 小時內自然清掉）
    writeUpload(name, buf, owner = null) {
      const n = safeFileName(String(name ?? '').normalize('NFC'));
      const token = crypto.randomBytes(12).toString('hex');
      const p = path.join(dataDir, 'uploads', token, n);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
      if (owner) fs.writeFileSync(path.join(dataDir, 'uploads', token, UPLOAD_OWNER), JSON.stringify({ category: owner.category, id: owner.id }));
      return { token, name: n, size: buf.length };
    },
    readUpload(token, owner = null) {
      if (!/^[0-9a-f]{24}$/.test(String(token ?? ''))) return null; // token 只准 24 位小寫十六進位：擋路徑符號
      const dir = path.join(dataDir, 'uploads', token);
      const name = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f !== UPLOAD_OWNER)[0] : null;
      if (!name) return null;
      if (owner && fs.existsSync(path.join(dir, UPLOAD_OWNER))) {
        let o = null;
        try { o = JSON.parse(fs.readFileSync(path.join(dir, UPLOAD_OWNER), 'utf8')); } catch { /* 記號壞了＝當作不符 */ }
        if (!o || o.category !== owner.category || o.id !== owner.id) return null;
      }
      const p = path.join(dir, name);
      return { token, name, size: fs.statSync(p).size, path: p };
    },
    runInDir(category, id, runId) {
      const dir = path.join(runDir(category, id, runId), 'in');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    runInputPath(category, id, runId, name) {
      const p = path.join(runDir(category, id, runId), 'in', safeFileName(name));
      return fs.existsSync(p) ? p : null;
    },
    // L13b：開跑拿不到上傳檔時分清兩種人話——代碼是別條 Workflow 發的 vs 真的不在了；拿得到回 null
    uploadProblem(token, owner) {
      if (this.readUpload(token, owner)) return null;
      return this.readUpload(token)
        ? '這個檔案是在別條 Workflow 選的，不能拿來跑這條，請在這裡重新選檔'
        : '上傳的檔案找不到了（可能超過 24 小時被清掉），請重新選檔';
    },
    // asName＝呼叫端先算好的落盤名（開跑要先寫進 run.yaml 再搬檔）；不給＝用上傳時的顯示名。
    // 兩種都再跟 in/ 裡既有的檔防撞（B02，Codex 2026-09-25）：同名或只差大小寫就改名 -2、-3，先搬進來的不動；回實際落盤名
    claimUpload(token, category, id, runId, asName = null) {
      const up = this.readUpload(token, { category, id });
      if (!up) throw new StoreError(this.uploadProblem(token, { category, id }), 'NOT_FOUND');
      const inDir = this.runInDir(category, id, runId);
      const name = dedupeFileName(asName ? safeFileName(asName) : up.name, fs.readdirSync(inDir));
      const dest = path.join(inDir, name);
      fs.copyFileSync(up.path, dest, fs.constants.COPYFILE_EXCL); // 不用 rename：暫存與資料夾可能不在同一顆磁碟；排他建檔＝絕不蓋掉別人
      fs.rmSync(path.dirname(up.path), { recursive: true, force: true });
      return name;
    },
    sweepUploads(maxAgeMs = 24 * 3600e3, nowMs = Date.now()) {
      const root = path.join(dataDir, 'uploads');
      if (!fs.existsSync(root)) return 0;
      let n = 0;
      for (const t of fs.readdirSync(root)) {
        const dir = path.join(root, t);
        try {
          if (nowMs - fs.statSync(dir).mtimeMs <= maxAgeMs) continue;
          fs.rmSync(dir, { recursive: true, force: true });
          n++;
        } catch { /* 清不掉的下次再清 */ }
      }
      return n;
    },

    readRefText(category, id, name) {
      const p = this.refFilePath(category, id, name);
      if (!p) throw new StoreError(`參考檔「${name}」不見了`, 'NOT_FOUND');
      return fs.readFileSync(p, 'utf8');
    },

    // ---- 三層共用檔：data/shared/<scope>/{index.yaml,files/}，scope＝_company｜分類名；
    // index.yaml 每檔 {name, kind: rule|ref, chars, text_cache?, uploaded_at}（text_cache 只有規範有＝上傳時轉好的純文字，之後不重算）；
    // 沒有夾＝空索引（舊資料照樣讀）；刪不進垃圾桶（定案）；同名 DUP（換版＝先刪再傳）----
    sharedDir(scope) {
      return path.join(dataDir, 'shared', safeSegment(scope, '共用夾'));
    },
    readSharedIndex(scope) {
      const f = path.join(this.sharedDir(scope), 'index.yaml');
      if (!fs.existsSync(f)) return { version: 1, files: [] };
      const idx = readYaml(f, `「${scope}」的共用檔清單`);
      return { version: 1, ...idx, files: Array.isArray(idx?.files) ? idx.files : [] };
    },
    listShared(scope) {
      const pub = ({ name, chars, bytes, uploaded_at }) => ({ name, chars: chars ?? null, bytes: bytes ?? null, uploaded_at }); // 列表不帶 text_cache
      const files = this.readSharedIndex(scope).files;
      const rules = files.filter((f) => f.kind === 'rule').map(pub);
      return { rules, refs: files.filter((f) => f.kind === 'ref').map(pub), rule_chars: rules.reduce((s, f) => s + (f.chars ?? 0), 0) };
    },
    // 字數語意：規範類 chars＝轉純文字後的字元數；參考類 md／txt＝讀成 utf-8 的字元數、其他（docx 等二進位）chars=null；
    // 兩類都另記 bytes＝檔案大小，UI 印「N 字」只看 chars、二進位印大小看 bytes
    addShared(scope, { name, kind, buf, text }) {
      const requested = safeFileName(name);
      if (kind !== 'rule' && kind !== 'ref') throw new StoreError('共用檔只有規範與參考兩種', 'BAD_NAME');
      const idx = this.readSharedIndex(scope);
      if (idx.files.some((f) => f.name === requested)) throw new StoreError('已有同名檔，先刪再傳', 'DUP');
      // 只差大小寫的（Case.txt／case.txt）NTFS 當同一個檔，寫下去會無聲蓋掉先傳的（B02，Codex 2026-09-25）：
      // 自動改名 -2、-3 並以實際落盤名入清單；一模一樣的名字照舊 DUP（換版＝先刪再傳）
      const filesDir = path.join(this.sharedDir(scope), 'files');
      fs.mkdirSync(filesDir, { recursive: true });
      const n = dedupeFileName(requested, [...idx.files.map((f) => f.name), ...fs.readdirSync(filesDir)]);
      const p = path.join(filesDir, n);
      fs.writeFileSync(p, buf, { flag: 'wx' }); // 排他建檔：絕不蓋掉別人
      const isText = /\.(md|txt)$/i.test(n);
      const chars = kind === 'rule' ? String(text ?? '').length : isText ? buf.toString('utf8').length : null;
      const entry = { name: n, kind, chars, bytes: buf.length, uploaded_at: new Date().toISOString() };
      if (kind === 'rule') entry.text_cache = String(text ?? '');
      idx.files.push(entry);
      atomicWrite(path.join(this.sharedDir(scope), 'index.yaml'), yaml.dump(idx, { lineWidth: -1 }));
      return entry;
    },
    deleteShared(scope, name) {
      const n = safeFileName(name);
      const idx = this.readSharedIndex(scope);
      if (!idx.files.some((f) => f.name === n)) throw new StoreError(`共用檔「${n}」不存在`, 'NOT_FOUND');
      fs.rmSync(path.join(this.sharedDir(scope), 'files', n), { force: true });
      idx.files = idx.files.filter((f) => f.name !== n);
      atomicWrite(path.join(this.sharedDir(scope), 'index.yaml'), yaml.dump(idx, { lineWidth: -1 }));
    },
    sharedFilePath(scope, name) {
      const p = path.join(this.sharedDir(scope), 'files', safeFileName(name));
      return fs.existsSync(p) ? p : null;
    },
    readSharedRuleTexts(scope) {
      return this.readSharedIndex(scope).files.filter((f) => f.kind === 'rule').map((f) => ({ name: f.name, chars: f.chars, text: f.text_cache ?? '' }));
    },

    // ---- 產出物----
    writeArtifact(category, id, runId, name, text) {
      const p = path.join(outDir(category, id, runId), safeFileName(name));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text, 'utf8');
      return name;
    },
    // 產出夾清單（執行紀錄的 files／GET /runs/:rid/files）：工人的腳本 .js 與數字檔 數字-<步驟id>.json（US-110）是工作痕跡不是成品，
    // 不列（成品清單 finalsOf 只看 step.file，本來就不會撈到它們；這裡是唯一掃資料夾的地方）。按名字讀（readArtifact）不受影響
    listArtifacts(category, id, runId) {
      const dir = outDir(category, id, runId);
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !isWorkScrap(f)).sort() : [];
    },
    // 工人在這趟的產出資料夾開工——確保存在並回絕對路徑；產完由 runner 確認檔案真的在
    runOutDir(category, id, runId) {
      const dir = outDir(category, id, runId);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    // 這一輪有沒有真的重寫成品檔——比對 {size, mtimeMs}；檔不在（或檔名不合法）回 null
    artifactStat(category, id, runId, name) {
      try {
        const st = fs.statSync(path.join(outDir(category, id, runId), safeFileName(name)));
        return { size: st.size, mtimeMs: st.mtimeMs };
      } catch { return null; }
    },
    readArtifact(category, id, runId, name) {
      const p = path.join(outDir(category, id, runId), safeFileName(name));
      if (!fs.existsSync(p)) throw new StoreError(`產出檔「${name}」不見了`, 'NOT_FOUND');
      return fs.readFileSync(p);
    },

    // ---- 常用預設庫（D19：複製式——選用＝把內容複製進步驟）----
    listPresets() {
      return readJsonOr(presetsFile, {});
    },
    savePreset(field, name, text) {
      const all = this.listPresets();
      (all[field] ??= []);
      const hit = all[field].find((p) => p.name === name);
      if (hit) hit.text = text;
      else all[field].push({ name, text });
      atomicWrite(presetsFile, JSON.stringify(all, null, 2));
    },
    deletePreset(field, name) {
      const all = this.listPresets();
      all[field] = (all[field] ?? []).filter((p) => p.name !== name);
      atomicWrite(presetsFile, JSON.stringify(all, null, 2));
    },

    // ---- 排程／通知／Google 快照----
    readSchedules() {
      return readJsonOr(schedulesFile, []);
    },
    writeSchedules(list) {
      atomicWrite(schedulesFile, JSON.stringify(list, null, 2));
    },
    readNotices() {
      return readJsonOr(noticesFile, []);
    },
    writeNotices(list) {
      atomicWrite(noticesFile, JSON.stringify(list, null, 2));
    },
    readSnapshot() {
      return readJsonOr(snapshotFile, null, { lenient: true }); // 快照是快取，壞了重抓即可
    },
    writeSnapshot(snap) {
      atomicWrite(snapshotFile, JSON.stringify(snap, null, 2));
    },
    readConnectors() {
      return readJsonOr(connectorsFile, null, { lenient: true }); // 快取，壞了當沒抓過、重抓即可
    },
    writeConnectors(cache) {
      atomicWrite(connectorsFile, JSON.stringify(cache, null, 2));
    },

    // ---- 記憶兩本帳：一卡一檔 memory/<habits|profile>/<id>.yaml，跟流程一樣原子寫 ----
    readCard(bucket, id) {
      return readYaml(cardFile(bucket, id), '這張卡');
    },
    writeCard(card) {
      atomicWrite(cardFile(card.bucket, card.id), yaml.dump(card, { lineWidth: -1 }));
    },
    // 不給 bucket＝兩本帳都列；只列讀得懂的 YAML（壞檔跳過，讀單張時才報錯）；可按 status 篩
    listCards(bucket, { status } = {}) {
      const out = [];
      for (const b of bucket ? [bucket] : Object.keys(CARD_DIRS)) {
        const dir = bucketDir(b);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).sort()) {
          if (!f.endsWith('.yaml')) continue;
          let card;
          try { card = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
          if (!isPlainObject(card) || !card.id) continue;
          if (status && card.status !== status) continue;
          out.push(card);
        }
      }
      return out;
    },

    // ---- 詞典：缺檔＝出廠十條（不落地，寫入時才建檔）----
    // 既有 dict.yaml 按名字補出廠缺的條（舊檔只有七條→讀出來十條），已有同名（含自訂）不動；同樣只補在讀出來的那份，寫入時才落地
    // 記憶自己的小狀態檔（memory/state/<名稱>.json）：目前只有聊天記路的去重指紋。
    // 讀不到一律回空陣列——這種檔壞掉不該擋任何流程，最多就是多記一次。
    readMemoryState(name) {
      try {
        const f = path.join(memoryDir, 'state', safeSegment(name, '狀態') + '.json');
        return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
      } catch { return []; }
    },
    writeMemoryState(name, value) {
      const f = path.join(memoryDir, 'state', safeSegment(name, '狀態') + '.json');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(value));
    },
    readDict() {
      const now = new Date().toISOString();
      const stamp = (f) => ({ ...f, synonyms: [...f.synonyms], created_at: now });
      if (!fs.existsSync(dictFile)) return { ...FACTORY_DICT, fields: FACTORY_DICT.fields.map(stamp) };
      const dict = readYaml(dictFile, '欄位詞典');
      if (!Array.isArray(dict?.fields)) return dict;
      // 「已存在」＝名字是某欄位，或已是任一欄位的同義詞（使用者手動把「語氣」併進「格式」後，下次讀取不能又冒出獨立的「語氣」；B09，Codex 2026-09-25）
      const have = new Set(dict.fields.flatMap((f) => [f?.name, ...(Array.isArray(f?.synonyms) ? f.synonyms : [])]));
      const missing = FACTORY_DICT.fields.filter((f) => !have.has(f.name));
      return missing.length ? { ...dict, fields: [...dict.fields, ...missing.map(stamp)] } : dict;
    },
    writeDict(dict) {
      atomicWrite(dictFile, yaml.dump(dict, { lineWidth: -1 }));
    },

    // ---- 群組圈：一分類一檔 memory/groups/<分類>.yaml；沒有檔＝沒有群組圈 ----
    readGroup(category) {
      const f = groupFile(category);
      if (!fs.existsSync(f)) return null;
      return readYaml(f, `分類「${category}」的群組圈`);
    },
    writeGroup(category, group) {
      const full = { ...group, category, text: group?.text ?? '', rules: group?.rules ?? [], files: group?.files ?? [], updated_at: new Date().toISOString() };
      atomicWrite(groupFile(category), yaml.dump(full, { lineWidth: -1 }));
      return full;
    },
    listGroups() {
      const dir = path.join(memoryDir, 'groups');
      if (!fs.existsSync(dir)) return [];
      const out = [];
      for (const f of fs.readdirSync(dir).sort()) {
        if (!f.endsWith('.yaml')) continue;
        try {
          const g = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (isPlainObject(g)) out.push(g);
        } catch { /* 壞檔不列，讀單一分類時才報錯 */ }
      }
      return out;
    },

    // ---- 身分（素材庫用）：一份清單 ----
    readIdentities() {
      return fs.existsSync(identitiesFile) ? (readYaml(identitiesFile, '身分') ?? []) : [];
    },
    writeIdentities(list) {
      atomicWrite(identitiesFile, yaml.dump(list, { lineWidth: -1 }));
    },

    // ---- 全域設定 settings.json：缺檔＝缺省；有檔＝缺省逐鍵補上（壞檔明確報錯，同 readJsonOr 規矩）----
    readSettings() {
      return deepMerge(structuredClone(DEFAULT_SETTINGS), readJsonOr(settingsFile, {}));
    },
    writeSettings(settings) {
      atomicWrite(settingsFile, JSON.stringify(settings, null, 2));
    },

    // ---- 備份：整個資料夾複製到同層 <basename>-backups/<時間戳>/（不含備份夾自己、不含寫到一半的暫存檔）----
    backup() {
      const at = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
      let dest = path.join(backupsRoot, stamp);
      for (let i = 2; fs.existsSync(dest); i += 1) dest = path.join(backupsRoot, `${stamp}-${i}`);
      const root = path.resolve(backupsRoot);
      const dataRoot = path.resolve(backupRoot);
      fs.cpSync(backupRoot, dest, {
        recursive: true,
        filter: (src) => {
          const r = path.resolve(src);
          if (r === root || r.startsWith(root + path.sep)) return false;
          if (path.dirname(r) === dataRoot && path.basename(r) === 'backups') return false;
          return !path.basename(r).includes('.tmp-');
        },
      });
      return { path: dest, at: at.toISOString() };
    },
    listBackups() {
      if (!fs.existsSync(backupsRoot)) return [];
      return fs.readdirSync(backupsRoot)
        .filter((n) => fs.statSync(path.join(backupsRoot, n)).isDirectory())
        .sort()
        .map((name) => ({ name, at: fs.statSync(path.join(backupsRoot, name)).mtime.toISOString() }));
    },

    writeRun(category, id, runId, run) {
      atomicWrite(path.join(runDir(category, id, runId), 'run.yaml'), yaml.dump(run, { lineWidth: -1 }));
    },

    readRun(category, id, runId) {
      return readYaml(path.join(runDir(category, id, runId), 'run.yaml'), `執行紀錄「${runId}」`);
    },

    listRuns(category, id) {
      const dir = path.join(wfDir(category, id), 'runs');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => fs.existsSync(path.join(dir, f, 'run.yaml'))).sort();
    },

    // 這條流程自己的最近一趟（US-107 樹上狀態點）：沒跑過＝null；那一趟 run.yaml 讀不到或沒有狀態＝unreadable（不猜）。
    // 每條只讀自己最新那一份，不受跨流程趟數上限影響
    // L065：GET /api/workflows 每條流程都叫這支、又掛在 30 秒輪詢上——只 readdir 一次、由新往舊找到第一個有 run.yaml 的就停，
    // 不走 listRuns（那支會把每一趟都 existsSync 一遍：50 條 × 100 趟 ≈ 五千次檔案呼叫）
    lastRunOf(category, id) {
      const dir = path.join(wfDir(category, id), 'runs');
      let names;
      try { names = fs.readdirSync(dir); } catch { return null; }
      names.sort();
      let runId = null;
      for (let i = names.length - 1; i >= 0; i -= 1) {
        if (fs.existsSync(path.join(dir, names[i], 'run.yaml'))) { runId = names[i]; break; }
      }
      if (!runId) return null;
      try {
        const run = this.readRun(category, id, runId);
        return { run_id: runId, status: typeof run?.status === 'string' ? run.status : 'unreadable' };
      } catch {
        return { run_id: runId, status: 'unreadable' };
      }
    },

    // 刪一次執行（已定案：跑到一半不想跑完的要能清）：連 run.yaml、產出檔、卷宗整夾刪除，不進垃圾桶
    deleteRun(category, id, runId) {
      const dir = runDir(category, id, runId);
      if (!fs.existsSync(path.join(dir, 'run.yaml'))) throw new StoreError(`找不到執行紀錄「${runId}」`, 'NOT_FOUND');
      fs.rmSync(dir, { recursive: true, force: true });
    },

    // 跨流程最近執行：runId 以時間戳開頭，字典序＝時間序
    listRecentRuns(limit = 20) {
      const all = [];
      for (const w of this.listWorkflows()) {
        for (const runId of this.listRuns(w.category, w.id)) all.push({ ...w, runId });
      }
      all.sort((a, b) => b.runId.localeCompare(a.runId));
      return all.slice(0, limit);
    },

    // ---- prompt 卷宗：每步送出宿主的指示全文，存進該次執行資料夾 ----
    writePromptRecord(category, id, runId, name, text) {
      const p = path.join(promptDir(category, id, runId), safeFileName(name));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text, 'utf8');
    },
    // 卷宗檔的絕對路徑（不建檔、只回路徑；prompts 目錄先建好，讓籠子 cage.mjs 能直接 append <步驟>.exec.log）
    promptRecordPath(category, id, runId, name) {
      const dir = promptDir(category, id, runId);
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, safeFileName(name));
    },
    listPromptRecords(category, id, runId) {
      const dir = promptDir(category, id, runId);
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    },
    readPromptRecord(category, id, runId, name) {
      const p = path.join(promptDir(category, id, runId), safeFileName(name));
      if (!fs.existsSync(p)) throw new StoreError(`這一步的指示卷宗「${name}」不存在（改版前跑的舊紀錄沒有卷宗）`, 'NOT_FOUND');
      return fs.readFileSync(p, 'utf8');
    },

    // ---- 工作單留存：不屬於任何一次執行的呼叫（建流程、匯入掃描、優化、行事曆快照）也要留全文 ----
    // 卷宗存在 run 資料夾底下，這四種沒有 run，所以另開 dataDir/logs/<種類>/。寫不進不擋（跟卷宗同一條規矩）：
    // 少一份紀錄不該讓建流程或抓快照整個失敗。名字經 safeFileName，跳脫路徑的名字寫不出去（丟出去被這裡吃掉）。
    writeLog(kind, name, text) {
      try {
        const p = path.join(logDir(kind), `${safeFileName(name)}.txt`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text, 'utf8');
      } catch { /* 工作單寫不進不擋呼叫 */ }
    },
    listLogs(kind) {
      const dir = logDir(kind);
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    },
    readLog(kind, name) {
      const p = path.join(logDir(kind), `${safeFileName(name)}.txt`);
      if (!fs.existsSync(p)) throw new StoreError(`工作單「${name}」不存在`, 'NOT_FOUND');
      return fs.readFileSync(p, 'utf8');
    },

    // ---- 用量帳本：append-only JSONL，一次宿主呼叫一行 ----
    appendUsage(entry) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(usageFile, `${JSON.stringify(entry)}\n`, 'utf8');
    },
    readUsage({ sinceMs = null } = {}) {
      let text;
      try {
        text = fs.readFileSync(usageFile, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return []; // 還沒記過帳＝空帳本
        throw new StoreError(`用量帳本讀不到（${e.code ?? '未知原因'}）`, 'CORRUPT');
      }
      const out = [];
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const entry = JSON.parse(s);
          if (!sinceMs || new Date(entry.at).getTime() >= sinceMs) out.push(entry);
        } catch { /* append 中斷的殘行跳過，不擋整本帳 */ }
      }
      return out;
    },
  };
}
