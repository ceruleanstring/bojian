// 自起一份剝繭分身：node src/server.js，env BOJIAN_PORT＋BOJIAN_DATA_DIR（%TEMP% 新資料夾）；等 HTTP 200 才算起好；跑完 taskkill 整棵
// 不准打 8787、不准動 bojian/data——資料夾一律新開在暫存區
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeApi } from './api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BOJIAN_ROOT = path.resolve(HERE, '..', '..', '..'); // bojian/
export const NODE_MODULES = path.join(BOJIAN_ROOT, 'node_modules');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* 已經死了 */ }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

export async function spawnServer({ port, dataDir, log = () => {} } = {}) {
  const p = port ?? await freePort();
  if (p === 8787) throw new Error('不准打 8787（正式台）');
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-canary-data-'));
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [path.join(BOJIAN_ROOT, 'src', 'server.js')], {
    cwd: BOJIAN_ROOT, windowsHide: true,
    // 分身的環境要像使用者自己在終端機起的：從 Claude 對話裡起分身時會繼承一整包 CLAUDE_CODE_* 變數，
    // 工人跟著被帶進「scratchpad」那類慣例（2026-09-24 q5 實測有一趟先把腳本寫到 scratchpad、被籠子拒跑再重寫）。清掉。
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE')), BOJIAN_PORT: String(p), BOJIAN_DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logText = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { logText += d; });
  child.stderr.on('data', (d) => { logText += d; });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const client = makeApi(p);
  const t0 = Date.now();
  while (!(await client.alive())) {
    if (exited) throw new Error(`分身沒起來：\n${logText.slice(-1500)}`);
    if (Date.now() - t0 > 60e3) { killTree(child.pid); throw new Error(`分身 60 秒內沒回 200：\n${logText.slice(-1500)}`); }
    await sleep(500);
  }
  log(`分身起好：http://127.0.0.1:${p}（資料：${dir}）`);
  return {
    port: p, dataDir: dir, pid: child.pid,
    logText: () => logText,
    kill() { killTree(child.pid); },
  };
}
