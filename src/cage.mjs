#!/usr/bin/env node
// 籠子（ADR-009 第 3 點）：工人寫的程式只能經這支包裝執行。用法 `node cage.mjs <腳本> [參數…]`。
// 包裝用 Node 內建權限鎖（--permission）起子行程：只准讀本趟資料夾＋這條流程的參考檔＋剝繭自帶套件＋內建字型；
// 只准寫本趟資料夾；不開子行程／執行緒／原生模組／WASI；預載 cage-preload.cjs 把連網入口全換成丟錯；
// 環境變數只留必需的幾個；逾時砍整棵；每次執行留一行紀錄到卷宗（BOJIAN_CAGE_LOG）。
// 設定全走環境變數（由 host-adapter 在起工人時帶進來；工人的 Bash 再繼承給這裡）：
//   BOJIAN_CAGE_DIR  本趟產出資料夾（籠子範圍；沒設＝process.cwd()）
//   BOJIAN_CAGE_READ 參考檔路徑，用 path.delimiter 分隔
//   BOJIAN_CAGE_LOG  卷宗 <nodeId>.exec.log 的絕對路徑（有設才寫）
//   BOJIAN_CAGE_OUT  卷宗 <nodeId>.exec.out 的絕對路徑（有設才寫）：每次執行的完整 stdout（ADR-010 決策 1，程式對數字的來源之一）
//   BOJIAN_CAGE_TIMEOUT_MS 逾時毫秒（預設 120000；測試用）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PRELOAD_PATH = path.join(HERE, 'cage-preload.cjs');
export const BUNDLED_NODE_MODULES = path.join(HERE, '..', 'node_modules');
export const BUNDLED_ASSETS = path.join(HERE, '..', 'assets');
export const DEFAULT_TIMEOUT_MS = 120_000;
// 環境變數白名單（比對不分大小寫——Windows 的 Path／SystemRoot 大小寫不一）
export const ENV_KEEP = Object.freeze(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'NODE_PATH']);
const HEAD = 500; // 紀錄裡 stdout／stderr 各留前 500 字
export const OUT_CAP = 2 * 1024 * 1024; // exec.out 單檔上限（位元組）：工人把整份資料印出來也不會把磁碟吃光
export const OUT_TRIM_NOTE = '（輸出超過上限，前面最舊的已截掉，只保留最近的）'; // L084②：滾動保留時寫在檔頭的一句（永遠只一句）

// 權限鎖的路徑寫法：資料夾用 `<dir>/*`（實測 Windows 下 / 與 \ 都收），檔案給原路徑
const dirGlob = (d) => path.join(d, '*');

// 組出 node 的參數列（純函式，測試直接斷言）
export function buildNodeArgs({ cwd, reads = [], script, args = [], preload = PRELOAD_PATH, nodeModules = BUNDLED_NODE_MODULES, assets = BUNDLED_ASSETS }) {
  const readFlags = [dirGlob(cwd), dirGlob(nodeModules), dirGlob(assets), preload];
  for (const r of reads) {
    if (!r) continue;
    let isDir = false;
    try { isDir = fs.statSync(r).isDirectory(); } catch { /* 不存在＝當檔案給原路徑，子行程讀不到自己會報 */ }
    readFlags.push(isDir ? dirGlob(r) : r);
  }
  return [
    '--permission',
    ...readFlags.map((p) => `--allow-fs-read=${p}`),
    `--allow-fs-write=${dirGlob(cwd)}`,
    '-r', preload,
    script,
    ...args,
  ];
}

// 環境變數：只留白名單；NODE_PATH 沒帶就指自帶套件
export function minimalEnv(src = process.env, nodeModules = BUNDLED_NODE_MODULES) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (ENV_KEEP.includes(k.toUpperCase()) && v !== undefined) out[k] = v;
  }
  if (!Object.keys(out).some((k) => k.toUpperCase() === 'NODE_PATH')) out.NODE_PATH = nodeModules;
  return out;
}

// 腳本必須落在籠子（cwd）底下——回絕對路徑；不在就丟錯
export function resolveScript(cwd, script) {
  if (!script) throw new Error('沒有給要執行的腳本：用法 node cage.mjs <腳本.js> [參數…]');
  const abs = path.resolve(cwd, script);
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const rel = path.relative(real(cwd), real(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒絕執行：腳本「${script}」不在這一步的資料夾底下（${cwd}）。程式一律寫在目前目錄再執行。`);
  }
  return abs;
}

// 殺整棵（比照 host-adapter.killTree）：Windows 先 taskkill /T /F 再補 kill()
function killTree(child) {
  const fallback = () => { try { child?.kill?.(); } catch { /* 已經結束 */ } };
  if (process.platform === 'win32' && Number.isInteger(child?.pid)) {
    try {
      const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      tk.on('error', fallback);
      tk.on('exit', fallback);
      return;
    } catch { /* 起不來就退回 kill() */ }
  }
  fallback();
}

function appendLog(logPath, entry) {
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch { /* 卷宗寫不進不擋執行 */ }
}

// 完整 stdout 另存（ADR-010 決策 1）：每次執行追加「### <腳本> <ISO 時間> code=<結束碼>」＋全文＋空行。
// L084②：檔案超過 OUT_CAP 改「滾動保留最近的」——丟最舊的、留最新的（內容本身不超過上限），檔頭補一句 OUT_TRIM_NOTE 讓讀的人知道前面被截掉；
// 以前是滿了就截在上限、之後一個字都不再追加，同一步後面程式印的數字進不了卷宗、程式對數字找不到出處就攔——無謂的攔。
// 截點：先不切半個 UTF-8 字，再把開頭那半行丟掉（從行中間開始的那行）；整段只剩一行時留半行不留空。
// exec.log 那 500 字紀錄不動；寫不進不擋執行（跟 appendLog 同一條規矩）。
const NOTE_BUF = Buffer.from(`${OUT_TRIM_NOTE}\n`, 'utf8');
function appendOut(outPath, { script, at, code, stdout }) {
  if (!outPath) return;
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const block = Buffer.from(`### ${script} ${at} code=${code}\n${stdout}${stdout.endsWith('\n') ? '' : '\n'}\n`, 'utf8'); // 全文＋一個空行（全文本來就以換行收尾的不再多加）
    let size = 0;
    try { size = fs.statSync(outPath).size; } catch { /* 還沒有檔 */ }
    if (size + block.length <= OUT_CAP) { fs.appendFileSync(outPath, block); return; } // 沒超過就純追加（檔頭若已有提示，留著）
    let existing = Buffer.alloc(0);
    try { existing = fs.readFileSync(outPath); } catch { /* 還沒有檔 */ }
    if (existing.subarray(0, NOTE_BUF.length).equals(NOTE_BUF)) existing = existing.subarray(NOTE_BUF.length); // 上次截過的提示先拿掉，等下重寫在檔頭
    const all = Buffer.concat([existing, block]);
    let start = Math.max(0, all.length - OUT_CAP);
    while (start < all.length && (all[start] & 0xc0) === 0x80) start++; // 不切半個字：跳過 UTF-8 的接續位元組
    if (start > 0 && all[start - 1] !== 0x0a) { // 從行中間開始 → 那半行丟掉；但整段只剩這一行（換行只剩在結尾）就留半行
      const nl = all.indexOf(0x0a, start);
      if (nl >= 0 && nl + 1 < all.length - 1) start = nl + 1;
    }
    fs.writeFileSync(outPath, Buffer.concat([NOTE_BUF, all.subarray(start)]));
  } catch { /* 卷宗寫不進不擋執行 */ }
}

// 起籠子跑一支腳本；stdout／stderr 原樣轉出、回傳結束碼；逾時砍整棵回 124
export function runCaged({ cwd, reads, script, args, logPath, outPath, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env, stdout = process.stdout, stderr = process.stderr }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const abs = resolveScript(cwd, script);
    const nodeArgs = buildNodeArgs({ cwd, reads, script: abs, args });
    const child = spawn(process.execPath, nodeArgs, { cwd, env: minimalEnv(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; stdout.write(d); });
    child.stderr.on('data', (d) => { err += d; stderr.write(d); });
    const timer = setTimeout(() => {
      timedOut = true;
      stderr.write(`\n[剝繭籠子] 程式跑超過 ${Math.round(timeoutMs / 1000)} 秒，已停止。\n`);
      killTree(child);
    }, timeoutMs);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = timedOut ? 124 : (code ?? 1);
      const at = new Date(started).toISOString();
      appendLog(logPath, {
        at,
        script: path.basename(abs),
        code: exitCode,
        ms: Date.now() - started,
        stdout: out.slice(0, HEAD),
        stderr: err.slice(0, HEAD),
        timed_out: timedOut,
      });
      appendOut(outPath, { script: path.basename(abs), at, code: exitCode, stdout: out });
      resolve(exitCode);
    };
    child.on('error', (e) => { err += String(e?.message ?? e); stderr.write(`[剝繭籠子] 起不來：${e?.message ?? e}\n`); finish(1); });
    child.on('close', (code) => finish(code));
  });
}

// 從環境變數讀設定（host-adapter 帶進來的）
export function configFromEnv(env = process.env) {
  const cwd = env.BOJIAN_CAGE_DIR ? path.resolve(env.BOJIAN_CAGE_DIR) : process.cwd();
  const reads = String(env.BOJIAN_CAGE_READ ?? '').split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  const t = Number(env.BOJIAN_CAGE_TIMEOUT_MS);
  return { cwd, reads, logPath: env.BOJIAN_CAGE_LOG || null, outPath: env.BOJIAN_CAGE_OUT || null, timeoutMs: Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS };
}

// 當主程式跑（被 import 時不動）
const isMain = (() => {
  try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const [script, ...args] = process.argv.slice(2);
  const cfg = configFromEnv();
  try {
    const code = await runCaged({ ...cfg, script, args });
    process.exitCode = code;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    appendLog(cfg.logPath, { at: new Date().toISOString(), script: String(script ?? ''), code: 126, ms: 0, stdout: '', stderr: String(e.message).slice(0, HEAD), timed_out: false, refused: true });
    process.exitCode = 126;
  }
}
