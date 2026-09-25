import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildNodeArgs, minimalEnv, resolveScript, ENV_KEEP, DEFAULT_TIMEOUT_MS, configFromEnv, OUT_CAP, OUT_TRIM_NOTE } from '../src/cage.mjs';

// 籠子（ADR-009 第 3 點）：真的起 cage.mjs 跑探針，照 raw 探針那 14 項斷言——不是假子行程。
const CAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cage.mjs');

// 探針腳本：每項印 OK 或 BLOCKED <code>；參考檔／外面檔的路徑從 cwd 裡的 probe-config.json 讀（環境變數被籠子清掉，帶不進來）
const PROBE = `
const fs = require('fs'); const path = require('path'); const os = require('os');
const cfg = JSON.parse(fs.readFileSync('probe-config.json', 'utf8'));
const r = {};
const t = (n, f) => { try { const v = f(); r[n] = 'OK' + (v !== undefined ? ' ' + v : ''); } catch (e) { r[n] = 'BLOCKED ' + (e.code || e.message); } };
const ta = async (n, f) => { try { const v = await f(); r[n] = 'OK' + (v !== undefined ? ' ' + v : ''); } catch (e) { r[n] = 'BLOCKED ' + (e.code || e.message); } };
(async () => {
  t('read_cwd', () => fs.readdirSync('.').length);
  t('write_cwd', () => { fs.writeFileSync('probe-out.txt', 'x'); return 1; });
  t('read_ref', () => fs.readFileSync(cfg.ref, 'utf8').trim());
  t('read_outside', () => fs.readFileSync(cfg.outside, 'utf8').length);
  t('write_outside', () => { fs.writeFileSync(cfg.escape, 'x'); return 1; });
  t('list_home', () => fs.readdirSync(os.homedir()).length);
  t('child_process', () => require('child_process').execSync('whoami').toString().trim());
  t('worker', () => { new (require('worker_threads').Worker)('process.exit(0)', { eval: true }); return 1; });
  await ta('fetch', () => fetch('https://example.com'));
  t('https', () => { require('https').request('https://example.com').end(); return 1; });
  t('net', () => { require('net').connect(80, 'example.com'); return 1; });
  t('dns', () => { require('dns').lookup('example.com', () => {}); return 1; });
  t('binding', () => { process.binding('tcp_wrap'); return 1; });
  t('require_exceljs', () => typeof require('exceljs').Workbook);
  r.env_keys = Object.keys(process.env);
  console.log(JSON.stringify(r));
})();
`;

function tmpTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-cage-'));
  const cwd = path.join(root, '本趟 產出'); // 中文＋空格：探針 B 的情境
  const refDir = path.join(root, 'ref');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(refDir);
  const ref = path.join(refDir, '資料.csv');
  fs.writeFileSync(ref, '商品,金額\nA,100\n', 'utf8');
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'secret', 'utf8');
  const escape = path.join(root, 'escape.txt');
  const log = path.join(root, 'dossier', 'n1.exec.log');
  return { root, cwd, ref, outside, escape, log };
}

// 起真的 cage.mjs；env 從測試行程的 env 出發、加上籠子設定與一個不該被子行程看到的變數
function runCage(cwd, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CAGE, ...args], { cwd, env: { ...process.env, PROBE_SECRET: 'leak?', ...env }, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('籠子：14 項探針——cwd 內讀寫、參考檔、自帶套件放行；cwd 外讀寫、家目錄、子行程、執行緒、fetch／https／net／dns、process.binding 全擋；環境變數只剩白名單；exec.log 一行 JSON', async () => {
  const t = tmpTree();
  fs.writeFileSync(path.join(t.cwd, 'probe.js'), PROBE, 'utf8');
  fs.writeFileSync(path.join(t.cwd, 'probe-config.json'), JSON.stringify({ ref: t.ref, outside: t.outside, escape: t.escape }), 'utf8');
  const r = await runCage(t.cwd, ['probe.js'], { BOJIAN_CAGE_DIR: t.cwd, BOJIAN_CAGE_READ: t.ref, BOJIAN_CAGE_LOG: t.log });
  assert.equal(r.code, 0, `探針本身要跑完：${r.err}`);
  const line = r.out.trim().split('\n').pop();
  const res = JSON.parse(line);
  // 放行 4
  assert.match(res.read_cwd, /^OK/);
  assert.equal(res.write_cwd, 'OK 1');
  assert.equal(res.read_ref, 'OK 商品,金額\nA,100', '參考檔要讀得到（BOJIAN_CAGE_READ）');
  assert.equal(res.require_exceljs, 'OK function', '自帶套件要 require 得到（NODE_PATH）');
  // 擋下 10
  assert.equal(res.read_outside, 'BLOCKED ERR_ACCESS_DENIED');
  assert.equal(res.write_outside, 'BLOCKED ERR_ACCESS_DENIED');
  assert.equal(res.list_home, 'BLOCKED ERR_ACCESS_DENIED');
  assert.equal(res.child_process, 'BLOCKED ERR_ACCESS_DENIED');
  assert.equal(res.worker, 'BLOCKED ERR_ACCESS_DENIED');
  assert.equal(res.fetch, 'BLOCKED BOJIAN_CAGE_NO_NET');
  assert.equal(res.https, 'BLOCKED BOJIAN_CAGE_NO_NET');
  assert.equal(res.net, 'BLOCKED BOJIAN_CAGE_NO_NET');
  assert.equal(res.dns, 'BLOCKED BOJIAN_CAGE_NO_NET');
  assert.equal(res.binding, 'BLOCKED ERR_ACCESS_DENIED');
  assert.ok(!fs.existsSync(t.escape), 'cwd 外真的沒被寫出檔案');
  // 環境變數：白名單以外只准 Windows 起行程時系統自己補的那幾個；測試塞的 PROBE_SECRET 與 BOJIAN_CAGE_* 都不能漏進去
  const SYSTEM_INJECTED = new Set(['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'WINDIR']);
  const extra = res.env_keys.filter((k) => !ENV_KEEP.includes(k.toUpperCase()) && !SYSTEM_INJECTED.has(k.toUpperCase()));
  assert.deepEqual(extra, [], `環境變數漏了：${extra}`);
  assert.ok(res.env_keys.some((k) => k.toUpperCase() === 'NODE_PATH'));
  // exec.log：一行 JSON，欄位齊
  const lines = fs.readFileSync(t.log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.script, 'probe.js');
  assert.equal(entry.code, 0);
  assert.equal(entry.timed_out, false);
  assert.ok(Number.isInteger(entry.ms) && entry.ms >= 0);
  assert.ok(typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at)));
  assert.ok(entry.stdout.length <= 500 && entry.stdout.startsWith('{"read_cwd"'));
  assert.equal(typeof entry.stderr, 'string');
  fs.rmSync(t.root, { recursive: true, force: true });
});

test('籠子：stdout／stderr 原樣轉出、結束碼原樣回傳', async () => {
  const t = tmpTree();
  fs.writeFileSync(path.join(t.cwd, 'exit.js'), 'console.log("嗨"); console.error("警告"); process.exit(3);', 'utf8');
  const r = await runCage(t.cwd, ['exit.js'], { BOJIAN_CAGE_DIR: t.cwd });
  assert.equal(r.code, 3);
  assert.equal(r.out.trim(), '嗨');
  assert.equal(r.err.trim(), '警告');
  fs.rmSync(t.root, { recursive: true, force: true });
});

test('籠子：腳本不在 cwd 底下 → 拒跑、印原因、結束碼 126、exec.log 記 refused', async () => {
  const t = tmpTree();
  fs.writeFileSync(path.join(t.root, 'evil.js'), 'console.log("跑起來了")', 'utf8');
  const r = await runCage(t.cwd, ['../evil.js'], { BOJIAN_CAGE_DIR: t.cwd, BOJIAN_CAGE_LOG: t.log });
  assert.equal(r.code, 126);
  assert.ok(!r.out.includes('跑起來了'));
  assert.ok(r.err.includes('拒絕執行') && r.err.includes('不在這一步的資料夾底下'), r.err);
  const abs = await runCage(t.cwd, [path.join(t.root, 'evil.js')], { BOJIAN_CAGE_DIR: t.cwd });
  assert.equal(abs.code, 126, '絕對路徑指到外面也一樣拒');
  const entry = JSON.parse(fs.readFileSync(t.log, 'utf8').trim());
  assert.equal(entry.refused, true);
  assert.equal(entry.code, 126);
  fs.rmSync(t.root, { recursive: true, force: true });
});

test('籠子：BOJIAN_CAGE_DIR 沒設 → 以 process.cwd() 為籠子；沒設 BOJIAN_CAGE_LOG 就不寫紀錄', async () => {
  const t = tmpTree();
  fs.writeFileSync(path.join(t.cwd, 'ok.js'), 'require("fs").writeFileSync("here.txt","1"); console.log("done")', 'utf8');
  const r = await runCage(t.cwd, ['ok.js']);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'done');
  assert.ok(fs.existsSync(path.join(t.cwd, 'here.txt')));
  assert.ok(!fs.existsSync(t.log));
  fs.rmSync(t.root, { recursive: true, force: true });
});

test('籠子：逾時（BOJIAN_CAGE_TIMEOUT_MS=1000）→ 砍整棵、結束碼 124、stderr 說明、exec.log 標 timed_out', async () => {
  const t = tmpTree();
  fs.writeFileSync(path.join(t.cwd, 'spin.js'), 'setInterval(() => {}, 1000); console.log("spin")', 'utf8');
  const started = Date.now();
  const r = await runCage(t.cwd, ['spin.js'], { BOJIAN_CAGE_DIR: t.cwd, BOJIAN_CAGE_LOG: t.log, BOJIAN_CAGE_TIMEOUT_MS: '1000' });
  const elapsed = Date.now() - started;
  assert.equal(r.code, 124);
  assert.ok(elapsed < 15_000, `逾時後要很快結束，實際 ${elapsed}ms`);
  assert.ok(r.err.includes('跑超過 1 秒'), r.err);
  const entry = JSON.parse(fs.readFileSync(t.log, 'utf8').trim());
  assert.equal(entry.timed_out, true);
  assert.equal(entry.code, 124);
  assert.equal(entry.stdout.trim(), 'spin');
  fs.rmSync(t.root, { recursive: true, force: true });
});

// ADR-010 決策 1：籠子把每次執行的完整 stdout 另存 <步驟>.exec.out（BOJIAN_CAGE_OUT），程式對數字的來源之一；exec.log 那 500 字照舊
test('籠子：BOJIAN_CAGE_OUT → 每次執行把完整 stdout 追加進去（>500 字仍完整）、先一行「### 腳本 ISO時間 code=碼」再全文再空行；exec.log 照舊只留 500 字；沒設就不寫', async () => {
  const t = tmpTree();
  const outPath = path.join(t.root, 'dossier', 'n1.exec.out');
  fs.writeFileSync(path.join(t.cwd, 'big.js'), 'process.stdout.write("營收: 258450\\n" + "x".repeat(2000) + "\\n尾巴: 14.4\\n"); process.exit(0)', 'utf8');
  fs.writeFileSync(path.join(t.cwd, 'two.js'), 'console.log("第二支"); process.exit(3)', 'utf8');
  const r1 = await runCage(t.cwd, ['big.js'], { BOJIAN_CAGE_DIR: t.cwd, BOJIAN_CAGE_LOG: t.log, BOJIAN_CAGE_OUT: outPath });
  assert.equal(r1.code, 0, r1.err);
  const first = fs.readFileSync(outPath, 'utf8');
  const head = first.split('\n')[0];
  assert.match(head, /^### big\.js \d{4}-\d{2}-\d{2}T[\d:.]+Z code=0$/, `標頭行：${head}`);
  assert.equal(first, `${head}\n營收: 258450\n${'x'.repeat(2000)}\n尾巴: 14.4\n\n`, '標頭＋完整全文＋空行');
  const entry = JSON.parse(fs.readFileSync(t.log, 'utf8').trim());
  assert.ok(entry.stdout.length <= 500, 'exec.log 的 500 字紀錄不動');
  const r2 = await runCage(t.cwd, ['two.js'], { BOJIAN_CAGE_DIR: t.cwd, BOJIAN_CAGE_OUT: outPath });
  assert.equal(r2.code, 3);
  const both = fs.readFileSync(outPath, 'utf8');
  assert.ok(both.startsWith(first), '第二次是追加，不覆蓋');
  assert.match(both.slice(first.length), /^### two\.js [^\n]+ code=3\n第二支\n\n$/, `第二段：${both.slice(first.length)}`);
  // 沒設環境變數＝不寫
  const t2 = tmpTree();
  fs.writeFileSync(path.join(t2.cwd, 'ok.js'), 'console.log("done")', 'utf8');
  await runCage(t2.cwd, ['ok.js'], { BOJIAN_CAGE_DIR: t2.cwd, BOJIAN_CAGE_LOG: t2.log });
  assert.deepEqual(fs.readdirSync(path.join(t2.root, 'dossier')), ['n1.exec.log'], '沒設 BOJIAN_CAGE_OUT 就沒有 exec.out');
  fs.rmSync(t.root, { recursive: true, force: true });
  fs.rmSync(t2.root, { recursive: true, force: true });
});

// L084②：exec.out 滿了改「滾動保留最近的」——超過上限丟最舊的、留最新的，檔頭補一句提示；上限數字不變（2MB）
test('籠子：exec.out 單檔上限 2MB——超過上限丟最舊的、留最新的：最後寫的一定在、最早的不在、檔頭一句提示、大小不超過上限加提示語', async () => {
  const t = tmpTree();
  const outPath = path.join(t.root, 'dossier', 'n1.exec.out');
  // 每支印 1.2MB（純 ASCII，位元組＝字元）：第一支整段進去；第二支進來後超過 2MB → 第一支（最舊）被丟；第三支再擠掉第二支；最後一支小的照樣追加
  fs.writeFileSync(path.join(t.cwd, 'mb.js'), 'process.stdout.write("開頭:" + process.argv[2] + "\\n" + "y".repeat(1200 * 1024) + "\\n結尾:" + process.argv[2] + "\\n")', 'utf8');
  fs.writeFileSync(path.join(t.cwd, 'tail.js'), 'console.log("最後一支 14.4")', 'utf8');
  const env = { BOJIAN_CAGE_DIR: t.cwd, BOJIAN_CAGE_OUT: outPath };
  assert.equal((await runCage(t.cwd, ['mb.js', '一'], env)).code, 0);
  const text1 = fs.readFileSync(outPath, 'utf8');
  assert.ok(text1.length > 1200 * 1024 && text1.length < OUT_CAP, `第一支整段進去：${text1.length}`);
  assert.ok(!text1.includes(OUT_TRIM_NOTE), '沒超過上限就沒有提示');
  assert.equal((await runCage(t.cwd, ['mb.js', '二'], env)).code, 0);
  const text2 = fs.readFileSync(outPath, 'utf8');
  assert.ok(text2.startsWith(`${OUT_TRIM_NOTE}\n`), `超過上限後檔頭一句提示：${text2.slice(0, 60)}`);
  assert.equal(text2.split(OUT_TRIM_NOTE).length - 1, 1, '提示只有一句');
  assert.ok(Buffer.byteLength(text2, 'utf8') <= OUT_CAP + Buffer.byteLength(`${OUT_TRIM_NOTE}\n`, 'utf8'), '大小不超過上限加提示語');
  assert.ok(text2.includes('結尾:二\n'), '最後寫的一定在');
  assert.ok(!text2.includes('開頭:一'), '最早的被丟掉');
  assert.equal((await runCage(t.cwd, ['mb.js', '三'], env)).code, 0);
  const text3 = fs.readFileSync(outPath, 'utf8');
  assert.ok(text3.startsWith(`${OUT_TRIM_NOTE}\n`) && text3.split(OUT_TRIM_NOTE).length - 1 === 1, '再滿一次提示仍只有一句、仍在檔頭');
  assert.ok(Buffer.byteLength(text3, 'utf8') <= OUT_CAP + Buffer.byteLength(`${OUT_TRIM_NOTE}\n`, 'utf8'), '大小不超過上限加提示語');
  assert.ok(text3.includes('結尾:三\n') && !text3.includes('開頭:二') && !text3.includes('結尾:一'), '留最新的、丟最舊的（第二支只剩尾巴、第一支一個字都不剩）');
  // 已經滿過之後，小的輸出照樣追加得進去（這就是 L084② 要修的：以前滿了就一個字都不再存）
  assert.equal((await runCage(t.cwd, ['tail.js'], env)).code, 0);
  const text4 = fs.readFileSync(outPath, 'utf8');
  assert.match(text4.slice(text4.length - 80), /### tail\.js [^\n]+ code=0\n最後一支 14\.4\n\n$/, `滿過之後的執行還是追加得進去：${text4.slice(-80)}`);
  assert.ok(text4.includes('結尾:三\n'), '沒超過上限就不丟');
  assert.ok(Buffer.byteLength(text4, 'utf8') <= OUT_CAP + Buffer.byteLength(`${OUT_TRIM_NOTE}\n`, 'utf8'));
  fs.rmSync(t.root, { recursive: true, force: true });
});

test('籠子：exec.out 單支輸出就超過 2MB——只留最後 2MB、開頭對齊到整行；再來一支小的照樣追加', async () => {
  const t = tmpTree();
  const outPath = path.join(t.root, 'dossier', 'n1.exec.out');
  // 2.5MB、每行 100 字：留下來的第一行一定是完整的一行（不從行中間開始）、最後一行一定在
  fs.writeFileSync(path.join(t.cwd, 'huge.js'), 'const lines = []; for (let i = 0; i < 26214; i++) lines.push(String(i).padStart(6, "0") + "|" + "z".repeat(93)); process.stdout.write(lines.join("\\n") + "\\n")', 'utf8');
  fs.writeFileSync(path.join(t.cwd, 'tail.js'), 'console.log("最後一支")', 'utf8');
  const env = { BOJIAN_CAGE_DIR: t.cwd, BOJIAN_CAGE_OUT: outPath };
  assert.equal((await runCage(t.cwd, ['huge.js'], env)).code, 0);
  const text = fs.readFileSync(outPath, 'utf8');
  assert.ok(text.startsWith(`${OUT_TRIM_NOTE}\n`), '檔頭一句提示');
  const body = text.slice(`${OUT_TRIM_NOTE}\n`.length);
  assert.ok(Buffer.byteLength(body, 'utf8') <= OUT_CAP, `內容不超過上限：${Buffer.byteLength(body, 'utf8')}`);
  assert.match(body.split('\n')[0], /^\d{6}\|z{93}$/, `留下來的第一行是完整的一行：${body.split('\n')[0].slice(0, 40)}`);
  assert.ok(body.endsWith('026213|' + 'z'.repeat(93) + '\n\n'), '最後一行在');
  assert.ok(!body.includes('000000|'), '最前面的被丟掉');
  assert.equal((await runCage(t.cwd, ['tail.js'], env)).code, 0);
  const after = fs.readFileSync(outPath, 'utf8');
  assert.ok(after.endsWith('最後一支\n\n'), '之後的小輸出照樣追加');
  assert.equal(after.split(OUT_TRIM_NOTE).length - 1, 1, '提示仍只一句');
  fs.rmSync(t.root, { recursive: true, force: true });
});

test('籠子：exec.out 中文單行就超過 2MB——滾動截斷不切半個字（UTF-8 邊界）、整段只剩這一行時留半行不留空', async () => {
  const t = tmpTree();
  const outPath = path.join(t.root, 'dossier', 'n1.exec.out');
  // 70 萬個「營」＝210 萬位元組 > 2MB，整段就一行：留下來的開頭必須落在整個字上、行尾的數字一定在
  fs.writeFileSync(path.join(t.cwd, 'zh.js'), 'process.stdout.write("營".repeat(700000) + "收 258450\\n")', 'utf8');
  const env = { BOJIAN_CAGE_DIR: t.cwd, BOJIAN_CAGE_OUT: outPath };
  assert.equal((await runCage(t.cwd, ['zh.js'], env)).code, 0);
  const buf = fs.readFileSync(outPath);
  const text = buf.toString('utf8');
  assert.ok(!text.includes('�'), '沒有壞掉的半個字');
  assert.ok(text.startsWith(`${OUT_TRIM_NOTE}\n營`), `檔頭提示、接著就是完整的字：${JSON.stringify(text.slice(0, 40))}`);
  assert.ok(text.endsWith('收 258450\n\n'), '最後印的在');
  assert.ok(text.length > 600000, `只剩一行時留半行，不是留空：${text.length}`);
  assert.ok(buf.length <= OUT_CAP + Buffer.byteLength(`${OUT_TRIM_NOTE}\n`, 'utf8'));
  fs.rmSync(t.root, { recursive: true, force: true });
});

test('籠子：node 參數列——--permission、只讀 cwd／參考檔／自帶套件／字型／預載、只寫 cwd、-r 預載；不帶 child-process／worker／addons／wasi', () => {
  const args = buildNodeArgs({ cwd: 'C:\\run\\out', reads: ['C:\\ref\\a.csv'], script: 'C:\\run\\out\\x.js', args: ['1', '2'], preload: 'P.cjs', nodeModules: 'NM', assets: 'AS' });
  assert.deepEqual(args, [
    '--permission',
    `--allow-fs-read=${path.join('C:\\run\\out', '*')}`,
    `--allow-fs-read=${path.join('NM', '*')}`,
    `--allow-fs-read=${path.join('AS', '*')}`,
    '--allow-fs-read=P.cjs',
    '--allow-fs-read=C:\\ref\\a.csv',
    `--allow-fs-write=${path.join('C:\\run\\out', '*')}`,
    '-r', 'P.cjs',
    'C:\\run\\out\\x.js', '1', '2',
  ]);
  for (const bad of ['--allow-child-process', '--allow-worker', '--allow-addons', '--allow-wasi']) assert.ok(!args.includes(bad), `不准帶 ${bad}`);
  assert.equal(args.filter((a) => a.startsWith('--allow-fs-write=')).length, 1, '只准寫一個地方');
});

test('籠子：環境變數只留白名單（不分大小寫）、NODE_PATH 沒帶就指自帶套件；resolveScript 擋外面；configFromEnv 預設逾時 120 秒', () => {
  const env = minimalEnv({ Path: 'p', SystemRoot: 's', TEMP: 't', TMP: 't', USERPROFILE: 'u', HOME: 'h', ANTHROPIC_API_KEY: 'k', BOJIAN_CAGE_LOG: 'l' }, 'NM');
  assert.deepEqual(env, { Path: 'p', SystemRoot: 's', TEMP: 't', TMP: 't', USERPROFILE: 'u', NODE_PATH: 'NM' });
  assert.equal(minimalEnv({ NODE_PATH: 'X' }, 'NM').NODE_PATH, 'X');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-cage-'));
  fs.writeFileSync(path.join(cwd, 'a.js'), '', 'utf8');
  assert.equal(resolveScript(cwd, 'a.js'), path.join(cwd, 'a.js'));
  assert.equal(resolveScript(cwd, './sub/../a.js'), path.join(cwd, 'a.js'));
  assert.throws(() => resolveScript(cwd, '../a.js'), /拒絕執行/);
  assert.throws(() => resolveScript(cwd, path.join(os.tmpdir(), 'a.js')), /拒絕執行/);
  assert.throws(() => resolveScript(cwd, ''), /沒有給要執行的腳本/);
  fs.rmSync(cwd, { recursive: true, force: true });
  assert.equal(DEFAULT_TIMEOUT_MS, 120_000);
  assert.equal(configFromEnv({}).timeoutMs, 120_000);
  assert.equal(configFromEnv({ BOJIAN_CAGE_TIMEOUT_MS: '1000' }).timeoutMs, 1000);
  assert.equal(configFromEnv({ BOJIAN_CAGE_TIMEOUT_MS: 'abc' }).timeoutMs, 120_000);
  assert.deepEqual(configFromEnv({ BOJIAN_CAGE_READ: ['A', 'B'].join(path.delimiter) }).reads, ['A', 'B']);
  assert.equal(configFromEnv({}).logPath, null);
  assert.equal(configFromEnv({}).outPath, null);
  assert.equal(configFromEnv({ BOJIAN_CAGE_OUT: 'C:/x/n1.exec.out' }).outPath, 'C:/x/n1.exec.out');
  assert.ok(!ENV_KEEP.includes('BOJIAN_CAGE_OUT'), '籠子設定不漏給工人程式');
});
