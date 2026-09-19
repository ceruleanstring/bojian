// 連接器探針：問真宿主三次「你現在看得到哪些工具」，看行事曆連接器在輕裝旗標下還在不在。
// 這不是 node --test 的一員（副檔名 .mjs、放在 tests/eval/，不符合預設 test glob）——它要連宿主、會花 token，
// 是一次性的量測工具不是門禁，所以結束碼永遠 0。
//
//   用法（在 bojian/ 底下）：
//     node tests/eval/probe-mcp.mjs                  三次都跑
//     node tests/eval/probe-mcp.mjs --out <資料夾>    回覆原文往哪存（預設系統暫存區）
//
// 三次的差別（判定規則見 K5 工作包）：
//   ① 輕裝旗標照推，但不推 --strict-mcp-config
//   ② ① 再加 --strict-mcp-config（＝現況產品的輕裝呼叫）
//   ③ ① 再拿掉 --tools ""
// ①列出行事曆工具且②沒列出 → 第一層（--strict-mcp-config 是兇手）
// ①沒列但③有                → 第二層（--tools 是兇手）
// ①②都列出                  → 原因不明，照第三層處理
// 都沒有                      → 第三層（連接器根本掛不進 headless）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const QUESTION = '只列出你目前可用的工具名稱，一行一個';
const BASE = ['-p', '--output-format', 'json', '--disable-slash-commands', '--system-prompt', '只照指示做'];

// 問句一律走 stdin（跟 host-adapter 一樣）：`--tools` 是可變長參數，把問句擺在它後面會被當成工具名吃掉，
// 宿主就回「Input must be provided either through stdin or as a prompt argument」（第一次實跑踩到）。
const CASES = [
  { id: '1', desc: '輕裝旗標照推，不帶 --strict-mcp-config', args: [...BASE, '--tools', ''] },
  { id: '2', desc: '①＋--strict-mcp-config（＝現況輕裝呼叫）', args: [...BASE, '--strict-mcp-config', '--tools', ''] },
  { id: '3', desc: '①拿掉 --tools ""', args: [...BASE] },
];

function parseArgs(argv) {
  const out = { outDir: path.join(os.tmpdir(), 'bojian-probe-mcp'), only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.outDir = argv[++i] ?? out.outDir;
    else if (argv[i] === '--only') out.only = argv[++i] ?? null; // 花真 token，允許補跑單一次
  }
  return out;
}

// 直接 spawn claude（本機是 claude.exe，中文參數走 CreateProcessW 不會被主控台編碼吃掉）；
// ENOENT 才退回 cmd /c（.cmd 安裝法，host-adapter 走的那條）——只退一次，不遞迴。
function runClaude(args, { timeoutMs = 300_000, viaCmd = false, input = '' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let err = '';
    const child = viaCmd
      ? spawn('cmd', ['/c', 'claude', ...args], { windowsHide: true })
      : spawn('claude', args, { windowsHide: true });
    const timer = setTimeout(() => { child.kill(); done({ code: -1, out, err: `${err}\n（超時 ${timeoutMs}ms）` }); }, timeoutMs);
    function done(v) { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (e.code === 'ENOENT' && !viaCmd && process.platform === 'win32') {
        settled = true;
        clearTimeout(timer);
        return runClaude(args, { timeoutMs, viaCmd: true, input }).then(resolve);
      }
      done({ code: -1, out, err: String(e.message) });
    });
    child.on('close', (code) => done({ code, out: out.trim(), err: err.trim() }));
    child.stdin?.write?.(input);
    child.stdin?.end?.();
  });
}

function parseJson(raw) {
  try {
    const j = JSON.parse(raw);
    return {
      text: String(j.result ?? ''),
      isError: j.is_error === true,
      input: j.usage?.input_tokens ?? 0,
      cacheCreate: j.usage?.cache_creation_input_tokens ?? 0,
      cacheRead: j.usage?.cache_read_input_tokens ?? 0,
      output: j.usage?.output_tokens ?? 0,
    };
  } catch {
    return { text: raw, isError: true, input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
  }
}

// 回覆裡的 MCP 工具名（連接器工具一律 mcp__<server>__<tool>）
function mcpNames(text) {
  return [...new Set(String(text).match(/mcp__[A-Za-z0-9_-]+/g) ?? [])].sort();
}

const CAL_HINT = /calendar|行事曆|gcal/i;

async function main() {
  const { outDir, only } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const c of CASES) {
    if (only && c.id !== only) continue;
    process.stdout.write(`\n=== 第 ${c.id} 次：${c.desc} ===\n`);
    const started = Date.now();
    const r = await runClaude(c.args, { input: QUESTION });
    const p = parseJson(r.out);
    const names = mcpNames(p.text);
    const cal = names.filter((n) => CAL_HINT.test(n));
    const calProse = CAL_HINT.test(p.text); // 宿主可能只用人話講「Google Calendar」而不列 mcp__ 全名
    fs.writeFileSync(path.join(outDir, `probe-${c.id}.json`), r.out || r.err, 'utf8');
    fs.writeFileSync(path.join(outDir, `probe-${c.id}.txt`), p.text, 'utf8');
    results.push({ ...c, ...p, names, cal, calProse, code: r.code, ms: Date.now() - started });
    process.stdout.write(`結束碼 ${r.code}｜入量 ${p.input}（快取建 ${p.cacheCreate}／讀 ${p.cacheRead}）｜出量 ${p.output}｜${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    process.stdout.write(`MCP 工具全名：${names.length ? names.join(' ') : '（一個都沒有）'}\n`);
    process.stdout.write(`回覆裡提到行事曆：${calProse ? '有' : '沒有'}\n`);
    process.stdout.write(`回覆全文：\n${p.text}\n`);
  }

  if (results.length < CASES.length) { // 補跑單一次：不作判定，人自己對照三份原文
    process.stdout.write(`\n原文存在：${outDir}\n`);
    return;
  }
  const [a, b, c] = results;
  const has = (r) => r.cal.length > 0 || r.calProse;
  let verdict;
  if (has(a) && !has(b)) verdict = '第一層：--strict-mcp-config 是兇手，改成不推它＋--allowedTools 加 CALENDAR_TOOLS';
  else if (has(a) && has(b)) verdict = '原因不明（①②都列出來了）：照第三層處理，STATE 列管';
  else if (!has(a) && has(c)) verdict = '第二層：--tools 是兇手，再拿掉 --tools 旗標';
  else verdict = '第三層：連接器在 headless 掛不進來，這類呼叫整批帶行李';

  process.stdout.write('\n=== 判定 ===\n');
  process.stdout.write(`${verdict}\n`);
  process.stdout.write(`三次入量：① ${a.input}／② ${b.input}／③ ${c.input}（合計 ${a.input + b.input + c.input}）\n`);
  process.stdout.write(`三次入量含快取：① ${a.input + a.cacheCreate + a.cacheRead}／② ${b.input + b.cacheCreate + b.cacheRead}／③ ${c.input + c.cacheCreate + c.cacheRead}\n`);
  process.stdout.write(`原文存在：${outDir}\n`);
}

main().catch((e) => { console.error('探針自己爆了：', e); });
