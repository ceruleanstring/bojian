// 排版輪 畫布效能量測（headless Chromium＋CDP，真輸入管線 Input.dispatchMouseEvent）
// 用法：node bojian/tools/canvas-perf.mjs --data <效能資料夾> --out <結果.json> [--src <bojian 目錄>] [--wf 效能/w200] [--throttle 1]
// 自己起 8788 分身（--data）與 headless Chromium（CDP 9334），量完兩個都關。資料先用 perf-fixture.mjs 產生。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  return o;
}
const a = args(process.argv.slice(2));
if (!a.data || !a.out) { console.error('要 --data <效能資料夾> 與 --out <結果.json>'); process.exit(2); }
const BOJIAN = path.resolve(a.src ?? path.join(HERE, '..'));
const DATA = path.resolve(a.data);
if (DATA.toLowerCase().startsWith(path.join(BOJIAN, 'data').toLowerCase())) { console.error('不准用 bojian/data'); process.exit(2); }
const [cat, wid] = String(a.wf ?? '效能/w200').split('/');
const throttle = Number(a.throttle ?? 1);
const out = path.resolve(a.out);
const CHROME = a.chrome ?? path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-perf-'));
const srv = spawn(process.execPath, [path.join(BOJIAN, 'src', 'server.js')], { env: { ...process.env, BOJIAN_PORT: '8788', BOJIAN_DATA_DIR: DATA }, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${prof}`, '--window-size=1440,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { srv.kill(); } catch {} try { chrome.kill(); } catch {} };
process.on('exit', cleanup);

async function waitHttp(url, n = 60) { for (let i = 0; i < n; i++) { try { const r = await fetch(url); if (r.ok) return r; } catch {} await sleep(250); } throw new Error('timeout ' + url); }
await waitHttp('http://127.0.0.1:8788/api/health');
const targets = await (await waitHttp('http://127.0.0.1:9334/json/list')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse', ...extra });

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.enable');
await send('Performance.enable');
if (throttle > 1) await send('Emulation.setCPUThrottlingRate', { rate: throttle });
const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]));
const dm = (x, y, k) => +(((y[k] ?? 0) - (x[k] ?? 0)) * 1000).toFixed(1);
await send('Page.navigate', { url: 'http://127.0.0.1:8788/' });
await sleep(3000);
await ev(`window.alert = () => {}; window.confirm = () => true; state.intro = null; true`);

// 進畫布（計時：openWorkflow 後第一次畫整條畫布的 render 時間）
const openStats = await ev(`(async () => {
  await openWorkflow(${JSON.stringify(cat)}, ${JSON.stringify(wid)});
  state.mode = 'canvas';
  const t0 = performance.now(); render(); const t1 = performance.now();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { renderMs: +(t1 - t0).toFixed(1), toPaintMs: +(performance.now() - t0).toFixed(1), domNodes: document.querySelectorAll('*').length, cvNodes: document.querySelectorAll('.cvwrap [data-node]').length, pct: document.querySelector('.cvwrap .pct')?.textContent };
})()`);

// 頁內量測器：pointermove 處理時間（window capture→window bubble）、rAF 幀間隔、longtask、render 次數與耗時
await ev(`(() => {
  if (window.__perf) return true;
  const P = window.__perf = { mv: [], frames: [], long: [], renders: [], on: false };
  let s = 0;
  window.addEventListener('pointermove', () => { if (P.on) s = performance.now(); }, true);
  window.addEventListener('pointermove', () => { if (P.on && s) { P.mv.push(performance.now() - s); s = 0; } }, false);
  // 幀間隔只在手勢進行中量：量測用的 rAF 迴圈本身會逼出每一幀（headless 約 160 幀／秒），放開後還一直跑＝把量測器自己的主執行緒時間算進「放開後 1.5 秒」（排版輪 L14 修）
  const loop = (t) => { if (!P.frameOn) { P.looping = false; return; } P.frames.push(t); requestAnimationFrame(loop); };
  P.startFrames = () => { P.frameOn = true; if (!P.looping) { P.looping = true; requestAnimationFrame(loop); } };
  try { new PerformanceObserver((l) => { if (P.on) for (const e of l.getEntries()) P.long.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch {}
  const orig = render; window.render = function () { const t = performance.now(); try { return orig.apply(this, arguments); } finally { if (P.on) P.renders.push(performance.now() - t); } };
  return true;
})()`);

const pctNow = () => ev(`parseInt(document.querySelector('.cvwrap .pct')?.textContent ?? '0', 10)`);
const wrapBox = () => ev(`(() => { const r = document.querySelector('.cvwrap').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
async function setZoom(target) {
  const b = await wrapBox();
  const cx = Math.round(b.x + b.w / 2), cy = Math.round(b.y + b.h / 2);
  for (let i = 0; i < 40; i++) {
    const p = await pctNow();
    if (Math.abs(Math.log(p / target)) < Math.log(1.12) / 2) break;
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: p > target ? 100 : -100 });
    await sleep(40);
  }
  return pctNow();
}
// 找視野內一張完整可見的卡（中心點命中的是卡本身）；needPort＝還要出口接點也在視野內、命中得到
const pickNode = (needPort = false) => ev(`(() => { const w = document.querySelector('.cvwrap').getBoundingClientRect();
  const inView = (r) => r.left > w.left + 40 && r.right < w.right - 260 && r.top > w.top + 40 && r.bottom < w.bottom - 120;
  for (const el of document.querySelectorAll('.cvwrap .node')) { const r = el.getBoundingClientRect();
    if (!inView(r)) continue;
    const x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y)?.closest('[data-node]');
    if (hit !== el) continue;
    const pe = el.querySelector('.port.out'); const port = pe?.getBoundingClientRect();
    const px = port ? port.left + port.width / 2 : null, py = port ? port.top + port.height / 2 : null;
    if (${needPort} && (!port || px > w.right - 260 || py > w.bottom - 120 || !pe.contains(document.elementFromPoint(px, py)))) continue;
    return { x, y, id: el.dataset.node, px, py }; }
  return null; })()`);
const emptySpot = () => ev(`(() => { const w = document.querySelector('.cvwrap').getBoundingClientRect();
  for (let y = w.top + 30; y < w.bottom - 80; y += 17) for (let x = w.left + 30; x < w.right - 200; x += 23) { const el = document.elementFromPoint(x, y); if (el && el.closest('.cvwrap') && !el.closest('[data-node],.zoomer,.cvpalette,.edgelbl,.edgetools,.cvtools,.cvhelp,.cond,.pill') && !el.dataset?.hit) return { x, y }; }
  return null; })()`);

// 把離視野中央最近的卡平移到中央（200％ 時卡大、容易整張出界）
async function centerOn() {
  const d = await ev(`(() => { const w = document.querySelector('.cvwrap').getBoundingClientRect(); const cx = w.left + w.width / 2 - 120, cy = w.top + w.height / 2 - 40; let best = null;
    for (const el of document.querySelectorAll('.cvwrap .node')) { const r = el.getBoundingClientRect(); const dd = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy); if (!best || dd < best.dd) best = { dd, dx: cx - (r.left + r.width / 2), dy: cy - (r.top + r.height / 2) }; }
    return best; })()`);
  const e = await emptySpot();
  if (!d || !e) return;
  await mouse('mouseMoved', e.x, e.y, { buttons: 0 }); await mouse('mousePressed', e.x, e.y);
  for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', Math.round(e.x + d.dx * i / 10), Math.round(e.y + d.dy * i / 10)); await sleep(10); }
  await mouse('mouseReleased', Math.round(e.x + d.dx), Math.round(e.y + d.dy)); await sleep(300);
}
async function pick(needPort) {
  let n = await pickNode(needPort);
  if (!n) { await centerOn(); n = await pickNode(needPort); }
  return n;
}
const pct = (arr, q) => { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2); };
async function gesture(name, from, dx, dy, steps = 60, nodeId = null) {
  await ev(`(() => { const P = window.__perf; P.mv = []; P.frames = []; P.long = []; P.renders = []; P.on = true; P.startFrames(); return true; })()`);
  const m0 = await metrics();
  await mouse('mouseMoved', from.x, from.y, { buttons: 0 });
  await mouse('mousePressed', from.x, from.y);
  for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', Math.round(from.x + (dx * i) / steps), Math.round(from.y + (dy * i) / steps)); await sleep(16); }
  const m1 = await metrics();
  // 放開前後卡片在畫面上的位置：拖曳中看得到的是上層 SVG 的替身（排版輪 L14），原卡藏著——有替身就量替身
  const rectOf = () => ev(`(() => { const el = document.querySelector('.cvwrap .proxy .p-card') ?? document.querySelector('.cvwrap [data-node="${nodeId}"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  const before = nodeId ? await rectOf() : null;
  const tRel = await ev('(() => { window.__perf.frameOn = false; return performance.now(); })()');
  await mouse('mouseReleased', from.x + dx, from.y + dy);
  await sleep(1500);
  const m2 = await metrics();
  const after = nodeId ? await rectOf() : null;
  const P = await ev(`(() => { const P = window.__perf; P.on = false; return { mv: P.mv, frames: P.frames, long: P.long, renders: P.renders }; })()`);
  const iv = P.frames.slice(1).map((t, i) => t - P.frames[i]);
  return {
    name, moves: P.mv.length,
    moveHandlerMs: { p50: pct(P.mv, 0.5), p95: pct(P.mv, 0.95), max: pct(P.mv, 1) },
    frameIntervalMs: { p50: pct(iv, 0.5), p95: pct(iv, 0.95), max: pct(iv, 1), over16_7: iv.filter((x) => x > 16.7 * 1.5).length, frames: iv.length },
    longTasks: { count: P.long.length, maxMs: pct(P.long, 1) },
    fullRenders: { count: P.renders.length, totalMs: +P.renders.reduce((x, y) => x + y, 0).toFixed(1), maxMs: pct(P.renders, 1) },
    mainThreadPerMoveMs: { task: +(dm(m0, m1, 'TaskDuration') / steps).toFixed(2), script: +(dm(m0, m1, 'ScriptDuration') / steps).toFixed(2), layout: +(dm(m0, m1, 'LayoutDuration') / steps).toFixed(2), style: +(dm(m0, m1, 'RecalcStyleDuration') / steps).toFixed(2) },
    release: { taskMs: dm(m1, m2, 'TaskDuration'), scriptMs: dm(m1, m2, 'ScriptDuration'), layoutMs: dm(m1, m2, 'LayoutDuration'), styleMs: dm(m1, m2, 'RecalcStyleDuration'), jumpPx: before && after ? +Math.hypot(after.x - before.x, after.y - before.y).toFixed(1) : null },
    releaseAt: +tRel.toFixed(0),
  };
}

// 契約 I 門檻（排版輪 L14 完成定義）：x4 主判準、x1 另一欄；一項不過就記進 gate.fails
const GATE = {
  4: { moveMs: 6, handlerP95: 2, longTasks: 0, frameMax: 50, rafP95: 16.7, renders: 0, releaseMs: 60, jumpPx: 1, openMs: 233 },
  1: { moveMs: 2, handlerP95: 0.5, longTasks: 0, frameMax: 20, rafP95: 16.7, renders: 0, releaseMs: 25, jumpPx: 1, openMs: 50 },
};
function gateOf(r) {
  const g = GATE[r.throttle] ?? GATE[1];
  const fails = [];
  const chk = (label, v, max) => { if (v == null || !(v <= max)) fails.push(`${label}=${v}（門檻 ≤${max}）`); };
  chk('打開到畫出 ms', r.open?.toPaintMs, g.openMs);
  for (const z of r.zooms) for (const x of z.actions) {
    const at = `${z.target}% ${x.name}`;
    chk(`${at} 每次移動主執行緒 ms`, x.mainThreadPerMoveMs.task, g.moveMs);
    chk(`${at} pointermove 處理 p95 ms`, x.moveHandlerMs.p95, g.handlerP95);
    chk(`${at} 長任務數`, x.longTasks.count, g.longTasks);
    chk(`${at} 最大幀間隔 ms`, x.frameIntervalMs.max, g.frameMax);
    chk(`${at} rAF 幀間隔 p95 ms`, x.frameIntervalMs.p95, g.rafP95);
    chk(`${at} 整頁 render 次數`, x.fullRenders.count, g.renders);
    chk(`${at} 放開後 1.5 秒主執行緒 ms`, x.release.taskMs, g.releaseMs);
    if (x.name === '拖卡片') chk(`${at} 放開跳位 px`, x.release.jumpPx, g.jumpPx);
  }
  if (r.missing.length) fails.push(`沒量到：${r.missing.join('、')}`);
  return { pass: fails.length === 0, fails };
}

const result = { when: new Date().toISOString(), src: BOJIAN, workflow: `${cat}/${wid}`, throttle, open: openStats, zooms: [], missing: [] };
try {
  // 暖身（排版輪 L14）：打開後在 100％ 先各做一次三個手勢，量了照記（result.warmup）但不進門檻——
  // 第一次拉線長出新卡會觸發一次性的事（網路字型子集第一次載入、整頁文字重排；JS 第一次編譯），不是畫布每次操作的成本
  if (a.warmup !== 'off') {
    result.warmup = [];
    let n = await pick(false);
    if (n) result.warmup.push(await gesture('拖卡片', n, 240, 60, 60, n.id));
    n = await pick(true);
    if (n?.px) result.warmup.push(await gesture('拉線', { x: n.px, y: n.py }, 200, 90));
    const e = await emptySpot();
    if (e) result.warmup.push(await gesture('平移', e, -300, -120));
  }
  for (const target of [25, 100, 200]) {
    const got = await setZoom(target);
    const z = { target, actual: got, actions: [] };
    let n = await pick(false);
    if (n) z.actions.push(await gesture('拖卡片', n, 240, 60, 60, n.id)); else result.missing.push(`${target}% 拖卡片`);
    n = await pick(true);
    if (n?.px) z.actions.push(await gesture('拉線', { x: n.px, y: n.py }, 200, 90)); else result.missing.push(`${target}% 拉線`);
    const e = await emptySpot();
    if (e) z.actions.push(await gesture('平移', e, -300, -120)); else result.missing.push(`${target}% 平移`);
    z.domNodesAfter = await ev(`document.querySelectorAll('*').length`);
    result.zooms.push(z);
  }
} finally {
  result.gate = gateOf(result);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
  ws.close();
  cleanup();
  await sleep(800);
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}
console.log(JSON.stringify({ out, open: result.open, missing: result.missing, actions: result.zooms.map((z) => `${z.target}%:${z.actions.map((x) => x.name).join('/')}`), gate: result.gate }));
process.exit(result.missing.length || (a.gate && !result.gate.pass) ? 1 : 0);
