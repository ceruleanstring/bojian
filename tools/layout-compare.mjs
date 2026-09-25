// 排版輪 並排驗收（契約 L）：8788 分身 vs 樣稿，同 1440×900 截圖＋DOM 量測＋差異表。
// 用法：node bojian/tools/layout-compare.mjs --data <資料副本> --out <輸出資料夾> [--screens all|01,02] [--src <bojian 目錄>] [--proto <PROTO 目錄>]
// 自起：8788 分身（--src 的 server.js、BOJIAN_DATA_DIR=--data）、8791 靜態伺服器（PROTO）、headless Chromium（CDP 9335）；結束全關。
// 每畫面輸出 <id>-now.png、<id>-demo.png、<id>.json；另寫 summary.json。差異表出現白名單（layout-allow.json）外的欄位＝結束碼 1。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  return o;
}
const a = args(process.argv.slice(2));
if (!a.data || !a.out) { console.error('要 --data <資料副本> 與 --out <輸出資料夾>'); process.exit(2); }
const SRC = path.resolve(a.src ?? path.join(HERE, '..'));
const DATA = path.resolve(a.data);
if (DATA.toLowerCase().startsWith(path.join(SRC, 'data').toLowerCase())) { console.error('不准用 bojian/data'); process.exit(2); }
const PROTO = path.resolve(a.proto ?? path.join(SRC, '..', 'PROTO'));
const OUT = path.resolve(a.out);
const CHROME = a.chrome ?? path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
const recipes = JSON.parse(fs.readFileSync(path.join(HERE, 'layout-recipes.json'), 'utf8'));
const allow = JSON.parse(fs.readFileSync(path.join(HERE, 'layout-allow.json'), 'utf8'));
const MEASURE = fs.readFileSync(path.join(HERE, 'layout-measure.js'), 'utf8');
const want = !a.screens || a.screens === 'all' || a.screens === true ? null : String(a.screens).split(',');
const screens = recipes.screens.filter((s) => !want || want.includes(s.id));
if (!screens.length) { console.error('沒有符合的畫面'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 程序 ——
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const stat = http.createServer((req, res) => {
  const p = path.join(PROTO, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(PROTO) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => stat.listen(8791, '127.0.0.1', r));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-layout-'));
const srv = spawn(process.execPath, [path.join(SRC, 'src', 'server.js')], { env: { ...process.env, BOJIAN_PORT: '8788', BOJIAN_DATA_DIR: DATA }, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9335', `--user-data-dir=${prof}`, '--window-size=1440,900', '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let closed = false;
async function cleanup() {
  if (closed) return; closed = true;
  try { srv.kill(); } catch {}
  try { chrome.kill(); } catch {}
  await new Promise((r) => stat.close(r));
  await sleep(800);
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}
process.on('exit', () => { try { srv.kill(); } catch {} try { chrome.kill(); } catch {} });

async function waitHttp(url, n = 80) { for (let i = 0; i < n; i++) { try { const r = await fetch(url); if (r.ok) return r; } catch {} await sleep(250); } throw new Error('timeout ' + url); }

// —— 差異 ——
function flat(o, pre = '', acc = {}) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) { acc[pre] = o; return acc; }
  for (const [k, v] of Object.entries(o)) flat(v, pre ? `${pre}.${k}` : k, acc);
  return acc;
}
const TOL = /(width|left|cardW|columns)$/i; // 寬度類 ±2px，其餘完全相等
function same(field, x, y) {
  if (TOL.test(field)) {
    if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) <= 2);
    if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) <= 2;
  }
  return JSON.stringify(x) === JSON.stringify(y);
}
function allowedBy(id, field) {
  for (const [w, rule] of Object.entries(allow)) {
    if (!w.startsWith('W')) continue;
    if (rule.screens && !rule.screens.includes(id)) continue;
    if ((rule.fields ?? []).some((f) => (f.endsWith('*') ? field.startsWith(f.slice(0, -1)) : field === f))) return w;
  }
  return null;
}
function diff(id, now, demo) {
  const fn = flat(now ?? {}), fd = flat(demo ?? {});
  const rows = [];
  for (const k of [...new Set([...Object.keys(fd), ...Object.keys(fn)])]) {
    if (same(k, fn[k], fd[k])) continue;
    rows.push({ field: k, now: fn[k] ?? null, demo: fd[k] ?? null, allowed: allowedBy(id, k) });
  }
  return rows;
}

const summary = { when: new Date().toISOString(), src: SRC, data: DATA, proto: PROTO, screens: [] };
let bad = 0;
try {
  await waitHttp('http://127.0.0.1:8788/api/health');
  const targets = await (await waitHttp('http://127.0.0.1:9335/json/list')).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0; const pend = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++seq; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); r({ timeout: method }); } }, 30000); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); const ex = r.result?.exceptionDetails; return ex ? { error: ex.exception?.description ?? ex.text } : { value: r.result?.result?.value }; };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  async function side(id, which, steps) {
    const log = [];
    const url = which === 'demo' ? `http://127.0.0.1:8791/${encodeURI(recipes.demoPage)}` : 'http://127.0.0.1:8788/';
    await send('Page.navigate', { url });
    await sleep(which === 'demo' ? 1500 : 3000);
    const hide = `(() => { const s = document.createElement('style'); s.textContent = '.demo,.mobile-nav{display:none!important}'; document.head.appendChild(s); return 'ok'; })()`;
    if (which === 'demo') log.push({ step: 'hide .demo,.mobile-nav', ...(await ev(hide)) });
    await ev(`window.__screen = ${JSON.stringify(id)}; window.alert = () => {}; true`);
    for (const st of steps) {
      let expr = st.eval;
      if (st.click) expr = `(() => { const els = [...document.querySelectorAll(${JSON.stringify(st.click)})]${st.text ? `.filter((e) => e.textContent.includes(${JSON.stringify(st.text)}))` : ''}; const e = els[${st.index ?? 0}]; if (!e) return 'MISSING'; e.click(); return 'ok'; })()`;
      else expr = `(async () => { ${expr}; return 'ok'; })()`;
      const r = await ev(expr);
      log.push({ step: st.click ? `click ${st.click}${st.index ? `[${st.index}]` : ''}${st.text ? ` 含「${st.text}」` : ''}` : `eval ${st.eval.slice(0, 60)}`, ...r });
      await sleep(st.after ?? (which === 'demo' ? 1200 : 1800));
    }
    const m = await ev(MEASURE);
    let shot = await send('Page.captureScreenshot', { format: 'png' });
    if (!shot.result) shot = await send('Page.captureScreenshot', { format: 'png' });
    const png = path.join(OUT, `${id}-${which}.png`);
    if (shot.result) fs.writeFileSync(png, Buffer.from(shot.result.data, 'base64'));
    const measured = m.value ? JSON.parse(m.value) : { cmp: null, info: { error: m.error } };
    return { steps: log, shot: shot.result ? path.basename(png) : null, ...measured };
  }

  for (const sc of screens) {
    const now = await side(sc.id, 'now', sc.now);
    const demo = await side(sc.id, 'demo', sc.demo);
    const rows = diff(sc.id, now.cmp, demo.cmp);
    const unallowed = rows.filter((r) => !r.allowed);
    const stepFail = [...now.steps, ...demo.steps].filter((s) => s.error || s.value === 'MISSING');
    const res = { id: sc.id, name: sc.name, now, demo, diffs: rows, unallowed: unallowed.length, stepFailures: stepFail.length };
    fs.writeFileSync(path.join(OUT, `${sc.id}.json`), JSON.stringify(res, null, 1));
    summary.screens.push({ id: sc.id, name: sc.name, diffs: rows.length, unallowed: unallowed.length, stepFailures: stepFail.length, shots: [now.shot, demo.shot] });
    bad += unallowed.length + stepFail.length;
    console.log(`\n[${sc.id} ${sc.name}] 差異 ${rows.length}（白名單外 ${unallowed.length}）${stepFail.length ? `；步驟失敗 ${stepFail.length}` : ''}`);
    for (const r of rows) console.log(`  ${r.allowed ? `(${r.allowed})` : '  ✗ '} ${r.field}: now=${JSON.stringify(r.now)} demo=${JSON.stringify(r.demo)}`);
    for (const s of stepFail) console.log(`  步驟失敗：${s.step} → ${s.error ?? s.value}`);
  }
  ws.close();
} finally {
  summary.exit = bad ? 1 : 0;
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  await cleanup();
}
process.exit(bad ? 1 : 0);
