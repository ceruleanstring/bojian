// Windows 一句話安裝：install.ps1 的測試。
// 連網那兩條（真的下載 main.zip、真的 npm install）沒網路就 skip 並印原因，不假綠。
// 暫存位置：環境變數 BOJIAN_INSTALL_TEST_TMP（有設就用），不然用系統暫存夾；絕不碰真的 %LOCALAPPDATA%\bojian。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'install.ps1');
const INSTALL_MD = path.join(HERE, '..', 'INSTALL.md');
const IS_WIN = process.platform === 'win32';
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const PS = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const ZIP_URL = 'https://github.com/ceruleanstring/bojian/archive/refs/heads/main.zip';
const NOT_WIN = !IS_WIN && '安裝腳本只給 Windows，這台不是 Windows';

function tmpBase() {
  const base = process.env.BOJIAN_INSTALL_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'bojian-install-'));
}

// 換掉 PATH：Windows 上 env 物件的鍵不分大小寫，先把所有叫 path 的鍵清掉，不然會出現兩個 PATH
function envWithPath(newPath) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== 'path') env[k] = v;
  env.Path = newPath;
  return env;
}

function runPs(args, env) {
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8', env: env ?? process.env, timeout: 15 * 60 * 1000, windowsHide: true,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error };
}

function runInstall(args, env) {
  return runPs(['-File', SCRIPT, ...args], env);
}

// 題目指定的解析法：[scriptblock]::Create((Get-Content -Raw))，語法錯就非零退出
function parseCheck(file) {
  const env = { ...process.env, BOJIAN_PS1_UNDER_TEST: file };
  return runPs(['-Command',
    "try { [void][scriptblock]::Create((Get-Content -LiteralPath $env:BOJIAN_PS1_UNDER_TEST -Raw -Encoding UTF8)); 'PARSE_OK' } catch { $_.Exception.Message; exit 9 }"], env);
}

describe('install.ps1 靜態檢查', { skip: NOT_WIN }, () => {
  test('存成 UTF-8 帶 BOM（PowerShell 5.1 才讀得對中文）', () => {
    const b = fs.readFileSync(SCRIPT);
    assert.deepEqual([...b.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });

  test('PowerShell 5.1 解析得過', () => {
    const r = parseCheck(SCRIPT);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /PARSE_OK/);
  });

  test('解析檢查本身會紅：故意寫壞的腳本要被抓到', () => {
    const dir = tmpBase();
    try {
      const bad = path.join(dir, 'bad.ps1');
      fs.writeFileSync(bad, '\ufeffif ($true) { Write-Host "少一個括號"\n', 'utf8');
      const r = parseCheck(bad);
      assert.notEqual(r.code, 0, r.out);
      assert.doesNotMatch(r.out, /PARSE_OK/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('腳本與 INSTALL.md 都不教「遠端腳本直接餵給直譯器」', () => {
    const ps1 = fs.readFileSync(SCRIPT, 'utf8');
    const md = fs.readFileSync(INSTALL_MD, 'utf8');
    for (const text of [ps1, md]) {
      assert.doesNotMatch(text, /\|\s*iex\b/i);
      assert.doesNotMatch(text, /Invoke-Expression/i);
    }
    assert.match(md, /https:\/\/raw\.githubusercontent\.com\/ceruleanstring\/bojian\/main\/install\.ps1/);
    assert.match(md, /-ExecutionPolicy Bypass -File/);
  });

  test('只裝不開：腳本裡不起任何行程、不開隱藏視窗（防毒會凍住「下載完又開隱藏視窗」的同一支 PowerShell，2026-09-25 實測）；INSTALL.md 把啟動寫成另一步', () => {
    const ps1 = fs.readFileSync(SCRIPT, 'utf8').replace(/^\s*#.*$/gm, '');
    assert.doesNotMatch(ps1, /Start-Process/i);
    assert.doesNotMatch(ps1, /-WindowStyle\s+Hidden/i);
    assert.doesNotMatch(ps1, /Win32_Process|Invoke-CimMethod|\[Diagnostics\.Process\]/i);
    assert.match(ps1, /剝繭裝好了/);
    const md = fs.readFileSync(INSTALL_MD, 'utf8');
    assert.match(md, /Start-Process \(Join-Path \$env:LOCALAPPDATA 'bojian\\start-bojian\.cmd'\)/);
    assert.match(md, /api\/health/);
  });
});

describe('install.ps1 缺 Node 分支（-SkipNodeInstall）', { skip: NOT_WIN }, () => {
  let dir;
  before(() => { dir = tmpBase(); });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test('Node 太舊（假 node 回 v18.0.0）：exit 2、訊息帶 nodejs.org、沒開始下載', () => {
    const fake = path.join(dir, 'fakebin');
    fs.mkdirSync(fake);
    fs.writeFileSync(path.join(fake, 'node.cmd'), '@echo v18.0.0\r\n');
    const root = path.join(dir, 'root-old');
    const r = runInstall(['-InstallRoot', root, '-Port', '8799', '-SkipNodeInstall', '-NoStart'],
      envWithPath(`${fake};${SYS32}`));
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /nodejs\.org/);
    assert.match(r.out, /v18\.0\.0/);
    assert.equal(fs.existsSync(path.join(root, 'app')), false);
  });

  test('完全沒 Node：exit 2、訊息帶 nodejs.org', () => {
    const empty = path.join(dir, 'emptybin');
    fs.mkdirSync(empty);
    const r = runInstall(['-InstallRoot', path.join(dir, 'root-none'), '-SkipNodeInstall', '-NoStart'],
      envWithPath(`${empty};${SYS32}`));
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /nodejs\.org/);
    assert.match(r.out, /還沒裝 Node\.js/);
  });
});

// 第二層：真的連網下載、npm install、起伺服器。只在 BOJIAN_INSTALL_E2E=1 時跑，平常 skip 並印一行原因。
const E2E_ON = process.env.BOJIAN_INSTALL_E2E === '1';
const E2E_SKIP = NOT_WIN || (!E2E_ON && '完整安裝測試（會連網下載與 npm install）要設 BOJIAN_INSTALL_E2E=1 才跑');

describe('install.ps1 實裝（會連網下載 main.zip 並 npm install；BOJIAN_INSTALL_E2E=1 才跑）', { skip: E2E_SKIP }, () => {
  let dir;
  let root;
  let skipReason = '';
  before(async () => {
    dir = tmpBase();
    // 資料夾名稱故意帶中文：模擬 Windows 帳號名是中文、%LOCALAPPDATA% 含中文的情況
    root = path.join(dir, '中文使用者', 'bojian');
    try {
      const res = await fetch(ZIP_URL, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (!res.ok) skipReason = `GitHub 壓縮包回 HTTP ${res.status}`;
    } catch (e) {
      skipReason = `沒網路或連不上 GitHub：${e?.message ?? e}`;
    }
    if (!skipReason) {
      const c = spawnSync('claude --version', { shell: true, encoding: 'utf8', windowsHide: true });
      if (c.status !== 0) skipReason = '這台電腦沒有 claude 指令，安裝腳本會在「檢查 Claude Code」停下';
    }
    if (skipReason) console.log(`[install.test] 跳過連網測試：${skipReason}`);
  });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  const app = () => path.join(root, 'app');
  const data = () => path.join(root, 'data');
  const launcher = () => path.join(root, 'start-bojian.cmd');
  const args = () => ['-InstallRoot', root, '-Port', '8799', '-SkipNodeInstall', '-NoStart'];

  test('第一次裝：程式、套件、資料夾、啟動檔都到位', { timeout: 15 * 60 * 1000 }, (t) => {
    if (skipReason) return t.skip(skipReason);
    const r = runInstall(args());
    assert.equal(r.code, 0, r.out);
    assert.ok(fs.existsSync(path.join(app(), 'src', 'server.js')), 'app\\src\\server.js 不在');
    assert.ok(fs.existsSync(path.join(app(), 'node_modules')), 'app\\node_modules 不在');
    assert.ok(fs.statSync(data()).isDirectory(), 'data 夾不在');
    const cmd = fs.readFileSync(launcher());
    const text = cmd.toString('latin1');
    assert.match(text, /BOJIAN_DATA_DIR/);
    assert.match(text, /8799/);
    assert.ok([...cmd].every((c) => c < 0x80), '啟動檔要全英數字，使用者名稱有中文才不會亂碼');
    assert.match(text, /^@chcp 65001>nul\r\n/, '啟動檔第一行要切到 UTF-8 碼頁');
    assert.notDeepEqual([...cmd.subarray(0, 3)], [0xef, 0xbb, 0xbf], '啟動檔不能帶 BOM（cmd 會把 BOM 當成指令）');
    assert.equal(fs.existsSync(path.join(root, 'app.bak')), false);
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('_staging-')), []);
    assert.match(r.out, /剝繭裝好了/);
  });

  test('再裝一次＝更新：app 整夾換新、舊版放在 app\\data 的資料搬到 data 不刪', { timeout: 15 * 60 * 1000 }, (t) => {
    if (skipReason) return t.skip(skipReason);
    if (!fs.existsSync(path.join(app(), 'src', 'server.js'))) return t.skip('第一次安裝沒成功，更新路徑無從測起');
    const marker = path.join(app(), '記號-舊版.txt');
    fs.writeFileSync(marker, 'old app');
    fs.mkdirSync(path.join(app(), 'data'), { recursive: true });
    fs.writeFileSync(path.join(app(), 'data', '假資料-舊版.yaml'), 'keep: me\n');
    const r = runInstall(args());
    assert.equal(r.code, 0, r.out);
    assert.equal(fs.existsSync(marker), false, '記號檔還在＝app 沒被換新');
    assert.equal(fs.readFileSync(path.join(data(), '假資料-舊版.yaml'), 'utf8'), 'keep: me\n');
    assert.equal(fs.existsSync(path.join(app(), 'data', '假資料-舊版.yaml')), false);
    assert.ok(fs.existsSync(path.join(app(), 'node_modules')));
    assert.equal(fs.existsSync(path.join(root, 'app.bak')), false, 'app.bak 沒清');
  });

  test('只有 Claude 桌面版：PATH 沒 claude、%APPDATA% 有 2.1.279 與 2.1.281 → 啟動檔含 BOJIAN_CLAUDE_BIN 指到 281', { timeout: 15 * 60 * 1000 }, (t) => {
    if (skipReason) return t.skip(skipReason);
    const fakeAppData = path.join(dir, 'fake-appdata');
    for (const v of ['2.1.279', '2.1.281']) {
      const d = path.join(fakeAppData, 'Claude', 'claude-code', v);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'claude.cmd'), `@echo ${v} (Claude Code)\r\n`);
    }
    const root2 = path.join(dir, '桌面版使用者', 'bojian');
    const nodeDir = path.dirname(process.execPath);
    const env = envWithPath(`${nodeDir};${SYS32}`);
    env.APPDATA = fakeAppData;
    const r = runInstall(['-InstallRoot', root2, '-Port', '8799', '-SkipNodeInstall', '-NoStart'], env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /桌面版/);
    assert.match(r.out, /2\.1\.281/);
    const text = fs.readFileSync(path.join(root2, 'start-bojian.cmd'), 'utf8');
    assert.match(text, /^set "BOJIAN_CLAUDE_BIN=%APPDATA%\\Claude\\claude-code\\2\.1\.281\\claude\.cmd"\r?$/m);
    assert.doesNotMatch(text, /2\.1\.279/);
  });

  test('中文路徑下實際執行 start-bojian.cmd：剝繭起得來、health 回 200（只關自己起的那支）', { timeout: 5 * 60 * 1000 }, async (t) => {
    if (skipReason) return t.skip(skipReason);
    const port = 8796;
    const base = `http://127.0.0.1:${port}`;
    if (listenerPid(port) || await healthOk(base)) return t.skip(`埠 ${port} 已經有東西在跑，不去動它`);
    const r = runInstall(['-InstallRoot', root, '-Port', String(port), '-SkipNodeInstall', '-NoStart']);
    assert.equal(r.code, 0, r.out);
    let pid = null;
    try {
      const run = spawnSync('cmd.exe', ['/d', '/c', launcher()], {
        stdio: 'ignore', timeout: 90 * 1000, windowsHide: true, env: { ...process.env, BOJIAN_NO_BROWSER: '1' },
      });
      // stdio 一定要 ignore：起來的伺服器會繼承管線，用 pipe 的話 spawnSync 要等到伺服器關掉才回來
      assert.equal(run.status, 0, `啟動檔結束碼 ${run.status}`);
      pid = listenerPid(port);
      assert.ok(pid, `埠 ${port} 沒有人在聽`);
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(15000) });
      assert.equal(res.status, 200);
    } finally {
      pid = pid ?? listenerPid(port);
      if (pid) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        for (let i = 0; i < 20 && listenerPid(port); i++) await new Promise((ok) => setTimeout(ok, 250));
      }
    }
  });
});

async function healthOk(base) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

// 查某個埠是誰在聽（只用來關測試自己起的那支；測試開始前已確認這個埠原本沒人用）
function listenerPid(port) {
  const r = runPs(['-Command',
    `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $c.OwningProcess }`]);
  const n = Number.parseInt((r.out || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
