import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createOptimizer, applyProposal } from '../src/optimizer.js';

const DEF = {
  format: 1,
  name: '報告',
  params: [{ key: 'script_length', label: '講稿長度', default: '3 分鐘' }],
  nodes: [
    { id: 'organize', title: '整理', executor: 'ai', stop_point: 'always', instruction: '整理成表', next: ['present'] },
    { id: 'present', title: '上台', executor: 'human', stop_point: 'always', instruction: '上台講', next: [] },
  ],
};

function fakeAdapter(response = '') {
  const calls = [];
  return {
    calls,
    setResponse(r) { response = r; },
    async complete({ prompt }) { calls.push(prompt); return response; },
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-opt-'));
  const store = createStore(dir);
  store.writeWorkflow('工作', 'wf', DEF);
  const adapter = fakeAdapter();
  const opt = createOptimizer({ store, adapter });
  return { store, adapter, opt };
}

function doneRun(store, params = {}, steps = {}) {
  const id = store.newRunId();
  store.writeRun('工作', 'wf', id, {
    run_id: id, status: 'done', params: { script_length: '3 分鐘', ...params },
    steps: {
      organize: { status: 'done', output: '原表', edited_output: null, edit_note: null, feedback: null },
      present: { status: 'done', feedback: null },
      ...steps,
    },
  });
  return id;
}

test('參數訊號：連 2 次覆寫同值→提議改預設；只 1 次不提；重跑不重複提', async () => {
  const { store, opt } = setup();
  doneRun(store, { script_length: '5 分鐘' });
  assert.equal((await opt.analyze('工作', 'wf')).created, 0, '一次不夠');
  doneRun(store, { script_length: '5 分鐘' });
  assert.equal((await opt.analyze('工作', 'wf')).created, 1);
  const p = store.readProposals()[0];
  assert.equal(p.kind, 'param_default');
  assert.equal(p.change.new_default, '5 分鐘');
  assert.ok(p.evidence.includes('2 次'));
  assert.equal((await opt.analyze('工作', 'wf')).created, 0, '同鍵不重複');
});

test('靜音／作廢：同鍵 muted 或 stale 後都不再產生（防殭屍提議）', async () => {
  const { store, opt } = setup();
  doneRun(store, { script_length: '5 分鐘' });
  doneRun(store, { script_length: '5 分鐘' });
  await opt.analyze('工作', 'wf');
  const q = store.readProposals();
  q[0].status = 'muted';
  q[0].reject_count = 2;
  store.writeProposals(q);
  assert.equal((await opt.analyze('工作', 'wf')).created, 0);
  q[0].status = 'stale';
  store.writeProposals(q);
  assert.equal((await opt.analyze('工作', 'wf')).created, 0, '作廢的同鍵不准重生');
});

test('編輯訊號：連 2 次改同節點→AI 摘要出新指示提議；AI 回垃圾→本輪略過不炸', async () => {
  const { store, adapter, opt } = setup();
  const edited = { organize: { status: 'done', output: '原表', edited_output: '千分位表', edit_note: '金額加千分位', feedback: null } };
  doneRun(store, {}, edited);
  doneRun(store, {}, edited);
  adapter.setResponse('學到了\n```yaml\nsummary: 你連兩次都把金額改千分位，以後直接這樣做？\nnew_instruction: 整理成表（金額一律加千分位）\n```');
  assert.equal((await opt.analyze('工作', 'wf')).created, 1);
  const p = store.readProposals().find((x) => x.kind === 'node_instruction');
  assert.equal(p.change.node_id, 'organize');
  assert.ok(p.change.new_instruction.includes('千分位'));
  // AI 回垃圾：不再新增、不丟例外
  store.writeProposals([]);
  adapter.setResponse('呃我不知道');
  assert.equal((await opt.analyze('工作', 'wf')).created, 0);
});

test('事後回饋：即時轉提議（AI 指認節點）；節點亂指→略過', async () => {
  const { store, adapter, opt } = setup();
  doneRun(store);
  adapter.setResponse('了解\n```yaml\nnode_id: organize\nsummary: 主管嫌數據太細，整理時先聚合\nnew_instruction: 整理成表（只列月彙總，不列明細）\n```');
  const r = await opt.analyze('工作', 'wf', { feedback: '主管說數據太細' });
  assert.equal(r.created, 1);
  assert.equal(store.readProposals()[0].source, 'feedback');
  store.writeProposals([]);
  adapter.setResponse('好\n```yaml\nnode_id: 沒這節點\nsummary: x\nnew_instruction: y\n```');
  assert.equal((await opt.analyze('工作', 'wf', { feedback: '再來一次' })).created, 0);
});

test('applyProposal：目標節點／參數已不存在 → 丟人話錯誤，不准靜默沒事', () => {
  const gone = { kind: 'node_instruction', change: { node_id: '沒這節點', node_title: '整理', new_instruction: 'x' } };
  assert.throws(() => applyProposal(structuredClone(DEF), gone), /已經不在/);
  const goneParam = { kind: 'param_default', change: { key: 'no_such', param_label: '講稿長度', new_default: 'x' } };
  assert.throws(() => applyProposal(structuredClone(DEF), goneParam), /已經不在/);
});

test('applyProposal：參數改預設／節點換指示', () => {
  const p1 = { kind: 'param_default', change: { key: 'script_length', new_default: '5 分鐘' } };
  const d1 = applyProposal(structuredClone(DEF), p1);
  assert.equal(d1.params[0].default, '5 分鐘');
  const p2 = { kind: 'node_instruction', change: { node_id: 'organize', new_instruction: '新指示' } };
  const d2 = applyProposal(structuredClone(DEF), p2);
  assert.equal(d2.nodes[0].instruction, '新指示');
});
