// US-119／US-120：本機事件檔（只記次數與大小，不記內容）、彙總計數、封測報告
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { record, readEvents, summarize, buildReport, editSize, EVENTS } from '../src/metrics.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-metrics-'));

test('record：一行一事件，帶 at 與 event；資料夾不存在也能寫；readEvents 讀回同序', () => {
  const dir = path.join(tmp(), 'nested');
  record(dir, 'stop_pass', { run: 'r-1', node: 'a' });
  record(dir, 'stop_edit', { run: 'r-1', node: 'b', size: 3 });
  const lines = fs.readFileSync(path.join(dir, 'metrics.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.event, 'stop_pass');
  assert.equal(first.run, 'r-1');
  assert.ok(!Number.isNaN(Date.parse(first.at)), 'at 是 ISO 時刻');
  const back = readEvents(dir);
  assert.deepEqual(back.map((e) => e.event), ['stop_pass', 'stop_edit']);
  assert.equal(back[1].size, 3);
});

test('record：不認得的事件、文字內容欄位、非數字的 size 一律丟錯不落地', () => {
  const dir = tmp();
  assert.throws(() => record(dir, 'nope', {}), /事件/);
  assert.throws(() => record(dir, 'stop_edit', { run: 'r-1', node: 'a', size: 3, text: '成品內容' }), /欄位/);
  assert.throws(() => record(dir, 'stop_edit', { run: 'r-1', node: 'a', size: '很多' }), /欄位/);
  assert.throws(() => record(dir, 'artifact_open', { run: 'r-1', mode: 'zip' }), /欄位/);
  assert.throws(() => record(dir, 'stop_pass', { run: { id: 'r-1' }, node: 'a' }), /欄位/);
  assert.ok(!fs.existsSync(path.join(dir, 'metrics.jsonl')), '一個都沒寫');
});

test('readEvents：沒檔＝空；殘行跳過不擋整本', () => {
  const dir = tmp();
  assert.deepEqual(readEvents(dir), []);
  fs.writeFileSync(path.join(dir, 'metrics.jsonl'), '{"at":"2026-09-25T00:00:00.000Z","event":"memory_undo","card":"c-1"}\n{"broken\n\n', 'utf8');
  const back = readEvents(dir);
  assert.equal(back.length, 1);
  assert.equal(back[0].event, 'memory_undo');
});

test('summarize：空事件 → 全部 0／null', () => {
  const s = summarize([]);
  assert.deepEqual(s.stop, { pass: 0, edit: 0, edit_size_median: null });
  assert.deepEqual(s.artifact_open, { preview: 0, inline: 0, download: 0 });
  assert.deepEqual(s.abandon, { count: 0, by_step_done: {} });
  assert.deepEqual(s.workflows, { created: 0, never_run: 0, first_run_interval_median_ms: null });
  assert.deepEqual(s.proposals, { accept: 0, reject: 0, accept_rate: null });
  assert.equal(s.memory_undo, 0);
  assert.deepEqual(s.check, { block: 0, wrong: 0, wrong_rate: null });
});

test('summarize：各類計數與比率、中位數、放棄步數分布、建了沒跑', () => {
  const ev = (event, f) => ({ at: '2026-09-25T00:00:00.000Z', event, ...f });
  const events = [
    ev('stop_pass', { run: 'r-1', node: 'a' }), ev('stop_pass', { run: 'r-1', node: 'b' }),
    ev('stop_edit', { run: 'r-1', node: 'c', size: 2 }), ev('stop_edit', { run: 'r-2', node: 'c', size: 10 }), ev('stop_edit', { run: 'r-3', node: 'c', size: 4 }),
    ev('artifact_open', { run: 'r-1', mode: 'preview' }), ev('artifact_open', { run: 'r-1', mode: 'download' }), ev('artifact_open', { run: 'r-1', mode: 'download' }),
    ev('run_abandon', { run: 'r-4', step_done: 1, step_total: 3 }), ev('run_abandon', { run: 'r-5', step_done: 1, step_total: 3 }), ev('run_abandon', { run: 'r-6', step_done: 0, step_total: 2 }),
    ev('workflow_create', { workflow: 'wf-a' }), ev('workflow_create', { workflow: 'wf-b' }), ev('workflow_create', { workflow: 'wf-c' }),
    ev('workflow_first_run', { workflow: 'wf-a', interval_ms: 1000 }), ev('workflow_first_run', { workflow: 'wf-old', interval_ms: null }), ev('workflow_first_run', { workflow: 'wf-b', interval_ms: 5000 }),
    ev('proposal_accept', { proposal: 'p-1' }), ev('proposal_reject', { proposal: 'p-2' }), ev('proposal_reject', { proposal: 'p-3' }),
    ev('memory_undo', { card: 'c-1' }),
    ev('check_block', { run: 'r-1', node: 'a' }), ev('check_block', { run: 'r-1', node: 'b' }), ev('check_block', { run: 'r-2', node: 'a' }), ev('check_block', { run: 'r-2', node: 'b' }),
    ev('check_wrong', { run: 'r-1', node: 'a' }),
    { at: 'x', event: 'unknown_thing', run: 'r-9' }, null, 'junk', // 認不得的照跳
  ];
  const s = summarize(events);
  assert.deepEqual(s.stop, { pass: 2, edit: 3, edit_size_median: 4 });
  assert.deepEqual(s.artifact_open, { preview: 1, inline: 0, download: 2 });
  assert.deepEqual(s.abandon, { count: 3, by_step_done: { 0: 1, 1: 2 } });
  assert.deepEqual(s.workflows, { created: 3, never_run: 1, first_run_interval_median_ms: 3000 });
  assert.deepEqual(s.proposals, { accept: 1, reject: 2, accept_rate: 1 / 3 });
  assert.equal(s.memory_undo, 1);
  assert.deepEqual(s.check, { block: 4, wrong: 1, wrong_rate: 0.25 });
});

test('editSize：行級 LCS 差異＝新增＋刪除行數；相同＝0；空↔有＝行數；超過 2000 行退化成行數差', () => {
  assert.equal(editSize('a\nb\nc', 'a\nb\nc'), 0);
  assert.equal(editSize('a\nb\nc', 'a\nx\nc'), 2, '改一行＝刪一加一');
  assert.equal(editSize('a\nb\nc', 'a\nc'), 1, '刪一行');
  assert.equal(editSize('a\nc', 'a\nb\nc\nd'), 2, '加兩行');
  assert.equal(editSize('', 'a\nb'), 2);
  assert.equal(editSize(null, 'a\nb\nc'), 3);
  assert.equal(editSize('a\nb\nc', ''), 3);
  assert.equal(editSize('x\ny', 'p\nq\nr'), 5, '全換＝2 刪 3 加');
  const big = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n');
  const bigMod = Array.from({ length: 2600 }, (_, i) => `other ${i}`).join('\n');
  assert.equal(editSize(big, bigMod), 100, '大檔只算行數差');
});

test('buildReport：版本、時刻、計數、每條流程五個數；不帶任何 id／名稱／文字（葉子只准數字、null、布林；字串只在 version／generated_at）', () => {
  const dir = tmp();
  record(dir, 'stop_edit', { run: 'r-secret-run', node: 'node-secret', size: 3 });
  record(dir, 'workflow_create', { workflow: 'wf-secret' });
  record(dir, 'proposal_accept', { proposal: 'p-secret' });
  record(dir, 'memory_undo', { card: 'c-secret' });
  record(dir, 'artifact_open', { run: 'r-secret-run', mode: 'download' });
  const report = buildReport({
    dataDir: dir,
    version: '0.9.0',
    workflowsStats: [
      { runs: 3, rate: 0.5, median_ms: 1200, edited_avg: 1, series_len: 3, name: '偷渡的流程名', id: 'wf-secret', top_steps: [{ node: 'x', title: '偷渡的步驟名' }] },
      { runs: 0, rate: null, median_ms: null, edited_avg: null, series_len: 0 },
    ],
  });
  assert.equal(report.version, '0.9.0');
  assert.ok(!Number.isNaN(Date.parse(report.generated_at)));
  assert.deepEqual(report.counts, summarize(readEvents(dir)));
  assert.deepEqual(report.workflows, [
    { runs: 3, rate: 0.5, median_ms: 1200, edited_avg: 1, series_len: 3 },
    { runs: 0, rate: null, median_ms: null, edited_avg: null, series_len: 0 },
  ]);
  const text = JSON.stringify(report);
  for (const leak of ['r-secret-run', 'node-secret', 'wf-secret', 'p-secret', 'c-secret', '偷渡', 'top_steps']) {
    assert.ok(!text.includes(leak), `報告不得含「${leak}」`);
  }
  const walk = (v, key) => {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return;
    if (typeof v === 'string') { assert.ok(['version', 'generated_at'].includes(key), `字串只准在 version／generated_at，不准在 ${key}`); return; }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, key)); return; }
    for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(report, '');
});

test('EVENTS：清單固定，每種只准數字與 id 欄', () => {
  assert.deepEqual(Object.keys(EVENTS).sort(), ['artifact_open', 'check_block', 'check_wrong', 'memory_undo', 'proposal_accept', 'proposal_reject', 'run_abandon', 'stop_edit', 'stop_pass', 'workflow_create', 'workflow_first_run']);
});
