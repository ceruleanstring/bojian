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
  const metas = [];
  return {
    calls,
    metas,
    setResponse(r) { response = r; },
    async complete({ prompt, meta }) { calls.push(prompt); metas.push(meta); return response; },
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-opt-'));
  const store = createStore(dir);
  store.writeWorkflow('工作', 'wf', DEF);
  const adapter = fakeAdapter();
  const opt = createOptimizer({ store, adapter });
  return { dir, store, adapter, opt };
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
  assert.throws(() => applyProposal(structuredClone(DEF), gone), /已經不在了（Workflow 後來改過）/);
  const goneParam = { kind: 'param_default', change: { key: 'no_such', param_label: '講稿長度', new_default: 'x' } };
  assert.throws(() => applyProposal(structuredClone(DEF), goneParam), /已經不在了（Workflow 後來改過）/);
});

// ===== 監工輪 K5：訊號 D（監工建議）與 E（連兩趟同款交接） =====

// 帶監工欄位（record／handoff）的一趟：跑完的 run 才進得了訊號池
function doneRunWith(store, { record = undefined, handoff = undefined } = {}) {
  const id = store.newRunId();
  store.writeRun('工作', 'wf', id, {
    run_id: id,
    status: 'done',
    params: { script_length: '3 分鐘' },
    ...(record ? { record } : {}),
    steps: {
      organize: { status: 'done', output: '原表', edited_output: null, edit_note: null, ...(handoff ? { handoff } : {}) },
      present: { status: 'done' },
    },
  });
  return id;
}

test('訊號 D：最近一趟監工的建議→supervisor_hint 提議；不呼叫 AI；重跑不重複；接受不動流程定義', async () => {
  const { store, adapter, opt } = setup();
  doneRunWith(store, {
    record: { at: '2026-09-09T10:00:00Z', text: '第二步被攔一次', suggestions: [{ node: 'organize', where: 'constraints', text: '加上件數' }] },
  });
  assert.equal((await opt.analyze('工作', 'wf')).created, 1);
  const p = store.readProposals().at(-1);
  assert.equal(p.kind, 'supervisor_hint');
  assert.equal(p.key, 'hint:organize:constraints:加上件數');
  assert.deepEqual(p.change, { node_id: 'organize', field: 'constraints' });
  assert.equal(p.evidence, '加上件數');
  assert.equal(adapter.calls.length, 0, '訊號 D 是照抄監工的建議，不再問一次 AI');
  assert.equal((await opt.analyze('工作', 'wf')).created, 0, '同鍵不重複');
  const def = store.readWorkflow('工作', 'wf');
  assert.deepEqual(applyProposal(structuredClone(def), p), def, '監工建議只是指路，不改定義');
});

test('訊號 E：連兩趟同款交接（Jaccard ≥ 0.5）→ AI 改寫成指示提議；差很多不呼叫 AI', async () => {
  const { store, adapter, opt } = setup();
  adapter.setResponse('學到了\n```yaml\nsummary: 以後整理都按三類分節、先列件數，要不要寫進指示？\nnew_instruction: 整理成表，按三類分節，先列件數\n```');
  doneRunWith(store, { handoff: { text: '按三類分節，先寫件數' } });
  doneRunWith(store, { handoff: { text: '按三類分節，先列件數' } });
  const asked = [];
  const replied = [];
  assert.equal((await opt.analyze('工作', 'wf', { onPrompt: (t) => asked.push(t), onReply: (t) => replied.push(t) })).created, 1);
  assert.equal(asked.length, 1, '送出前要把指示全文交出來留工作單');
  assert.ok(replied[0].includes('new_instruction'), '回覆原文也要交出來');
  const p = store.readProposals().at(-1);
  assert.equal(p.kind, 'node_instruction');
  assert.ok(p.key.startsWith('handoff:organize:'), `key 要以 handoff:organize: 開頭：${p.key}`);
  assert.equal(p.change.node_id, 'organize');
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.metas[0].kind, 'optimize');
  assert.ok(adapter.calls[0].includes('連續兩趟監工都給了類似的交接'), '首句換成監工版');
  assert.ok(adapter.calls[0].includes('按三類分節，先寫件數') && adapter.calls[0].includes('按三類分節，先列件數'), '兩趟交接原文都要給 AI');

  const two = setup();
  two.adapter.setResponse('學到了\n```yaml\nsummary: x\nnew_instruction: y\n```');
  doneRunWith(two.store, { handoff: { text: '按三類分節，先列件數' } });
  doneRunWith(two.store, { handoff: { text: '通通不要管，隨便寫一寫就好' } });
  assert.equal((await two.opt.analyze('工作', 'wf')).created, 0);
  assert.equal(two.adapter.calls.length, 0, '兩趟差很多＝不是習慣，不花 token 問 AI');
});

// 監工關掉時，分岔節點仍會寫 only_route 的 handoff（route 有值、文字是判斷依據本身）；
// 訊號 E 若不排除分岔，會把「使用者根本沒看過的判路交接」誤當成監工建議，白花一次 AI 呼叫。
const BRANCH_DEF = {
  format: 1,
  name: '報告',
  supervisor: { enabled: false },
  params: [{ key: 'script_length', label: '講稿長度', default: '3 分鐘' }],
  nodes: [
    {
      id: 'fork', title: '判斷', kind: 'branch', instruction: '看件數與期間決定', next: [],
      branches: [{ label: '少量', next: 'present' }, { label: '大量', next: 'present' }],
    },
    { id: 'present', title: '上台', executor: 'human', stop_point: 'always', instruction: '上台講', next: [] },
  ],
};

function doneRunWithBranchHandoff(store, text) {
  const id = store.newRunId();
  store.writeRun('工作', 'wf', id, {
    run_id: id,
    status: 'done',
    params: { script_length: '3 分鐘' },
    steps: {
      fork: {
        status: 'done', choice: 'present', choice_by: 'ai', choice_label: '少量',
        handoff: { text, tier: null, web: null, route: '1', at: '2026-09-09T10:00:00Z', only_route: true },
      },
      present: { status: 'done' },
    },
  });
  return id;
}

test('訊號 E：分岔節點的 only_route 判路交接不算監工建議（監工關掉時也不吃）', async () => {
  const { store, adapter, opt } = setup();
  store.writeWorkflow('工作', 'wf', BRANCH_DEF);
  doneRunWithBranchHandoff(store, '看件數與期間決定');
  doneRunWithBranchHandoff(store, '看件數與期間決定');
  assert.equal((await opt.analyze('工作', 'wf')).created, 0, '分岔節點不該產生提議');
  assert.equal(adapter.calls.length, 0, '分岔節點的判路交接不該問 AI');
  assert.ok(!store.readProposals().some((p) => p.key.startsWith('handoff:')), '佇列不該有分岔節點的 handoff 提議');
});

test('applyProposal：參數改預設／節點換指示', () => {
  const p1 = { kind: 'param_default', change: { key: 'script_length', new_default: '5 分鐘' } };
  const d1 = applyProposal(structuredClone(DEF), p1);
  assert.equal(d1.params[0].default, '5 分鐘');
  const p2 = { kind: 'node_instruction', change: { node_id: 'organize', new_instruction: '新指示' } };
  const d2 = applyProposal(structuredClone(DEF), p2);
  assert.equal(d2.nodes[0].instruction, '新指示');
});

// ── 2026-09-18 審查修正輪 ──────────────────────────────────────────────

test('一個壞掉的 run.yaml 不准讓這條流程從此再也沒有提議', async () => {
  const { dir, store, opt } = setup();
  // 連續兩趟都把同一個欄位改成同一個值＝訊號 A，正常情況下會產生一條提議
  doneRun(store, { script_length: '5 分鐘' });
  doneRun(store, { script_length: '5 分鐘' });
  // 另有一趟的檔案壞掉（id 取字典序最前，確保掃描時先碰到它）
  store.writeRun('工作', 'wf', 'aaa-bad', { run_id: 'aaa-bad', status: 'done', params: {}, steps: {} });
  // store 沒有對外暴露 run 目錄，路徑是自己組的——先斷言檔案真的在那裡，組錯就不會靜靜地假通過
  const f = path.join(dir, 'workflows', '工作', 'wf', 'runs', 'aaa-bad', 'run.yaml');
  assert.ok(fs.existsSync(f), `run.yaml 不在假設的路徑上：${f}`);
  fs.writeFileSync(f, 'a: [這不是合法 yaml\n  b: "', 'utf8');

  const res = await opt.analyze('工作', 'wf');

  assert.equal(res.created, 1, '壞檔讓 analyze 整支炸掉——兩個呼叫端都只印一行「下次一起看」就吞掉，等於這條流程從此不再有提議');
  assert.equal(store.readProposals()[0].kind, 'param_default');
});

test('跨 await 不准蓋掉使用者剛按的決定：analyze 寫回時要重讀最新佇列', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-opt-'));
  const store = createStore(dir);
  store.writeWorkflow('工作', 'wf', DEF);
  // 佇列裡本來有一筆待決提議
  store.writeProposals([{
    id: 'p-old', key: 'k-old', kind: 'node_instruction', status: 'pending', reject_count: 0,
    workflow: { category: '工作', id: 'wf' }, change: { node_id: 'organize', new_instruction: '舊的' },
  }]);

  let acted = false;
  const adapter = {
    async complete() {
      // AI 還在跑的這幾分鐘，使用者正在剛跑完的畫面上按「好」
      if (!acted) {
        acted = true;
        const q = store.readProposals();
        q[0].status = 'accepted';
        store.writeProposals(q);
      }
      return ['好的。', '```yaml', 'node_id: organize', 'summary: 要不要短一點？', 'new_instruction: 照回饋改', '```'].join('\n');
    },
  };

  const res = await createOptimizer({ store, adapter }).analyze('工作', 'wf', { feedback: '太長了' });

  const after = store.readProposals();
  assert.equal(after.find((p) => p.id === 'p-old').status, 'accepted', '使用者按過的決定被舊快照洗掉了');
  assert.equal(res.created, 1, '新提議照樣要加進去');
  assert.equal(after.length, 2, '只插不蓋：舊的留著、新的加上');
});
