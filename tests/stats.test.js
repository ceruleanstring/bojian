// US-099 成效統計：runStats 純函式各邊界
import test from 'node:test';
import assert from 'node:assert/strict';
import { runStats } from '../src/stats.js';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const DAY = 86400000;
const at = (daysAgo, mins = 0) => new Date(NOW - daysAgo * DAY + mins * 60000).toISOString();
const def = (...ids) => ({ nodes: ids.map(([id, title]) => ({ id, title })) });
// 一趟：started daysAgo 天前，跑 dur 分鐘
const run = (daysAgo, status, steps = {}, { dur = 6, d = def(['a', '抓來源'], ['b', '寫摘要'], ['c', '排版']) } = {}) => ({
  status, started_at: at(daysAgo), finished_at: status === 'running' ? null : at(daysAgo, dur), steps, def: d,
});

test('US-099 ①：空陣列／非陣列 → 趟數 0、其餘 null、top 空', () => {
  for (const input of [[], undefined, null, 'x']) {
    const s = runStats(input, NOW);
    assert.deepEqual(s.window, { runs: 0, rate: null, median_ms: null, edited_avg: null });
    assert.equal(s.prev_rate, null);
    assert.deepEqual(s.top_steps, []);
    assert.equal(s.days, 30);
  }
});

test('US-099 ②：全部進行中 → 趟數照算、比例／時間／改幾處都是 null', () => {
  const s = runStats([run(1, 'running'), run(2, 'running')], NOW);
  assert.equal(s.window.runs, 2);
  assert.equal(s.window.rate, null);
  assert.equal(s.window.median_ms, null);
  assert.equal(s.window.edited_avg, null);
});

test('US-099 ③：壞／缺欄的那趟不算（null、字串、缺 started_at、日期亂寫、steps 不是物件）且不炸', () => {
  const s = runStats([null, 'x', 42, [], { status: 'done' }, { status: 'done', started_at: '不是日期' },
    { status: 'done', started_at: at(1), finished_at: 'x', steps: 'x' },
    { status: 'paused', started_at: at(1), steps: { a: null, b: 'x' } }], NOW);
  assert.equal(s.window.runs, 2, '只算有 started_at 的兩趟');
  assert.equal(s.window.rate, 0.5, 'done 無失敗步驟＝1、paused＝0');
  assert.equal(s.window.median_ms, null, 'finished_at 讀不懂不算時間');
  assert.equal(s.window.edited_avg, 0);
  assert.deepEqual(s.top_steps, []);
});

test('US-099 ④：一路跑完比例——done 但有 failed 步驟不算跑完；running 不進分母；paused 進分母', () => {
  const s = runStats([
    run(1, 'done'), run(2, 'done'), run(3, 'done', { a: { status: 'failed' } }), run(4, 'paused'), run(5, 'running'),
  ], NOW);
  assert.equal(s.window.runs, 5);
  assert.equal(s.window.rate, 2 / 4);
});

test('US-099 ⑤：窗外排除——30 天前以前、未來的都不算；邊界 30 天整不算、29.99 天算', () => {
  const s = runStats([run(0.5, 'done'), run(29.99, 'done'), run(30, 'done'), run(45, 'failed'), run(-1, 'done')], NOW);
  assert.equal(s.window.runs, 2);
  const s7 = runStats([run(1, 'done'), run(10, 'done')], NOW, 7);
  assert.equal(s7.window.runs, 1, 'days 參數有作用');
  assert.equal(s7.days, 7);
});

test('US-099 ⑥：前期比——前一個 30 天同法算；前期沒趟→null；前期全 running→null', () => {
  const s = runStats([run(1, 'done'), run(2, 'done'), run(35, 'done'), run(40, 'paused'), run(59, 'running'), run(61, 'done')], NOW);
  assert.equal(s.window.rate, 1);
  assert.equal(s.prev_rate, 1 / 2, '35 done、40 paused 進分母，59 running 不進，61 在前期外');
  assert.equal(runStats([run(1, 'done')], NOW).prev_rate, null);
  assert.equal(runStats([run(1, 'done'), run(40, 'running')], NOW).prev_rate, null);
});

test('US-099 ⑦：中位數——奇數取中間、偶數取中間兩個平均；只看 done', () => {
  const odd = runStats([run(1, 'done', {}, { dur: 2 }), run(2, 'done', {}, { dur: 10 }), run(3, 'done', {}, { dur: 6 }), run(4, 'paused', {}, { dur: 999 })], NOW);
  assert.equal(odd.window.median_ms, 6 * 60000);
  const even = runStats([run(1, 'done', {}, { dur: 2 }), run(2, 'done', {}, { dur: 10 }), run(3, 'done', {}, { dur: 6 }), run(4, 'done', {}, { dur: 80 })], NOW);
  assert.equal(even.window.median_ms, 8 * 60000);
});

test('US-099 ⑧：平均每趟被你改幾處——edited_output 非 null 才算（空字串也算改過）；running 不算', () => {
  const s = runStats([
    run(1, 'done', { a: { status: 'done', edited_output: '改' }, b: { status: 'done', edited_output: '' } }),
    run(2, 'done', { a: { status: 'done', edited_output: null } }),
    run(3, 'running', { a: { status: 'done', edited_output: '改' }, b: { status: 'done', edited_output: '改' } }),
  ], NOW);
  assert.equal(s.window.edited_avg, 1, '(2+0)/2');
});

test('US-099 ⑨：最常出事的步驟——failed+edited 由大到小、同分 failed 多者先、前 3、0 不列、標題取最近一趟快照', () => {
  const oldDef = def(['a', '舊名抓來源'], ['b', '寫摘要'], ['c', '排版'], ['d', '寄出'], ['e', '沒事']);
  const newDef = def(['a', '抓新聞來源'], ['b', '寫摘要'], ['c', '排版成 PDF'], ['d', '寄出'], ['e', '沒事']);
  const s = runStats([
    run(10, 'done', { a: { status: 'failed' }, b: { status: 'done', edited_output: 'x' }, c: { status: 'done', edited_output: 'x' }, d: { status: 'done', edited_output: 'x' }, e: { status: 'done' } }, { d: oldDef }),
    run(2, 'done', { a: { status: 'done' }, b: { status: 'done', edited_output: 'x' }, c: { status: 'failed' }, d: { status: 'done' }, e: { status: 'done' } }, { d: newDef }),
    run(40, 'done', { d: { status: 'failed' } }, { d: newDef }), // 窗外，不算
  ], NOW);
  assert.deepEqual(s.top_steps, [
    { node: 'c', title: '排版成 PDF', failed: 1, edited: 1 },
    { node: 'b', title: '寫摘要', failed: 0, edited: 2 },
    { node: 'a', title: '抓新聞來源', failed: 1, edited: 0 },
  ], 'c(2,failed1) 先於 b(2,failed0)；a(1,failed1) 先於 d(1,failed0)；e 為 0 不列；只取 3');
  assert.ok(!s.top_steps.some((x) => x.node === 'e'));
});

test('US-099 ⑩：快照裡找不到該節點的標題 → title 退成節點 id', () => {
  const s = runStats([{ status: 'done', started_at: at(1), finished_at: at(1, 1), steps: { ghost: { status: 'failed' } } }], NOW);
  assert.deepEqual(s.top_steps, [{ node: 'ghost', title: 'ghost', failed: 1, edited: 0 }]);
});
