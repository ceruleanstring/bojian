import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createRunner, parseWhen } from '../src/runner.js';

// 假 adapter：回錄呼叫、可注入失敗／延遲／分岔答案
function fakeAdapter() {
  const calls = [];
  const spans = []; // {nodeId, start, end} 併發驗證用
  let failOn = null;
  let delay = 0;
  let branchAnswer = null;
  let seq = 0;
  let failTimes = Infinity;
  const outputs = {}; // 指定某步下一次的回覆（資料通道輪：模擬【資料不全】，用一次即清）
  let fileWriter = null;
  return {
    calls,
    spans,
    setFailOn(nodeId, times = Infinity) { failOn = nodeId; failTimes = times; },
    setOutput(nodeId, text) { outputs[nodeId] = text; },
    setFileWriter(fn) { fileWriter = fn; }, // 產檔輪：模擬工人在 fileMode.cwd 寫出檔案（回 true 才寫）
    setDelay(ms) { delay = ms; },
    setBranchAnswer(a) { branchAnswer = a; },
    renderPrompt: (f) => `PROMPT:${f.nodeId}`, // 卷宗協定：runner 存的全文＝這個函式的輸出
    async complete({ prompt, meta }) {
      calls.push({ branchPrompt: prompt, meta });
      return branchAnswer ?? '';
    },
    async executeNode({ nodeId, title, instruction, outputFormat, upstream, model, roleContext, constraints, creativity, reviewFocus, meta, fileMode }) {
      const start = seq++;
      calls.push({ nodeId, title, instruction, outputFormat, upstream, model, roleContext, constraints, creativity, reviewFocus, meta, fileMode });
      if (fileMode && fileWriter && fileWriter(fileMode)) fs.writeFileSync(path.join(fileMode.cwd, fileMode.fileName), `FILE:${fileMode.fileName}`);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const end = seq++;
      spans.push({ nodeId, start, end });
      if (failOn === nodeId && failTimes > 0) { failTimes--; throw new Error('連不上 Claude（測試注入）'); }
      if (outputs[nodeId] !== undefined) { const t = outputs[nodeId]; delete outputs[nodeId]; return t; }
      return `產出:${nodeId}`;
    },
  };
}

const LINEAR3 = {
  format: 1,
  name: '三步直線',
  params: [{ key: 'range', label: '範圍', default: '本季' }],
  nodes: [
    { id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做A，範圍 {{range}}', next: ['b'] },
    { id: 'b', title: 'B', executor: 'ai', stop_point: 'never', instruction: '做B', next: ['c'] },
    { id: 'c', title: 'C', executor: 'ai', stop_point: 'never', instruction: '做C', next: [] },
  ],
};

function setup(def = LINEAR3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-runner-'));
  const store = createStore(dir);
  store.writeWorkflow('測試', 'wf', def);
  const adapter = fakeAdapter();
  const runner = createRunner({ store, adapter });
  return { dir, store, adapter, runner };
}

test('輸出格式：有設的節點連同參數注入傳給宿主，沒設的傳空字串', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].output_format = '表格，範圍 {{range}}';
  const { runner, adapter } = setup(def);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const a = adapter.calls.find((c) => c.nodeId === 'a');
  const b = adapter.calls.find((c) => c.nodeId === 'b');
  assert.equal(a.outputFormat, '表格，範圍 本季');
  assert.equal(b.outputFormat, '');
});

test('開跑嚴格：定義裡有還沒接上的步驟 → startRun 擋下並點名', () => {
  const def = structuredClone(LINEAR3);
  def.nodes.push({ id: 'float', title: '孤島步驟', executor: 'ai', stop_point: 'never', instruction: '沒人接', next: [] });
  const { runner } = setup(def);
  assert.throws(() => runner.startRun('測試', 'wf', {}), (e) => e.message.includes('孤島步驟') && e.message.includes('還沒接進流程'));
});

test('單步自動重試：retry=1 首次失敗自動重來成功，模型檔位對映一併傳宿主', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].retry = 1;
  def.nodes[0].model_tier = 'deep';
  def.nodes[0].role_context = '你是分析師';
  const { runner, adapter, store } = setup(def);
  adapter.setFailOn('a', 1); // 只壞一次
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const aCalls = adapter.calls.filter((c) => c.nodeId === 'a');
  assert.equal(aCalls.length, 2); // 失敗一次＋重試成功
  assert.equal(aCalls[0].model, 'opus');
  assert.equal(aCalls[0].roleContext, '你是分析師');
  const r = store.readRun('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.status, 'done');
  assert.equal(r.status, 'done');
});

test('單步自動重試：重試用盡仍失敗 → 標失敗停下', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].retry = 1;
  const { runner, adapter, store } = setup(def);
  adapter.setFailOn('a'); // 一直壞
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(adapter.calls.filter((c) => c.nodeId === 'a').length, 2);
  const r = store.readRun('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.status, 'failed');
  assert.equal(r.status, 'paused');
});

test('D19 降級：output_file=pptx 未接工具鏈 → 存 .md＋file_note 講明；docx 沒開產檔權限 → 存 .md＋講明要開權限', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].output_file = 'pptx';
  def.nodes[1].output_file = 'docx';
  const { runner, store, adapter } = setup(def);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.deepEqual(store.listArtifacts('測試', 'wf', run.run_id), ['A.md', 'B.md']);
  const r = store.readRun('測試', 'wf', run.run_id);
  assert.ok(r.steps.a.file_note.includes('工具鏈'));
  assert.ok(r.steps.b.file_note.includes('產檔權限'));
  assert.equal(adapter.calls.find((c) => c.nodeId === 'b').fileMode, undefined, '沒權限就不進產檔模式');
  assert.equal(store.readArtifact('測試', 'wf', run.run_id, 'A.md').toString('utf8'), '產出:a');
});

test('產檔輪：流程開產檔權限＋docx → 工人收到 fileMode（產出夾、檔名、範本路徑），交出檔案就登記；沒交出就存 .md 講明', async () => {
  const def = structuredClone(LINEAR3);
  def.permissions = { files: true };
  def.nodes[0].output_file = 'docx';
  def.nodes[0].stop_point = 'always';
  def.nodes[0].template_file = '公司範本.docx';
  def.nodes[1].output_file = 'xlsx';
  const { runner, store, adapter } = setup(def);
  store.writeRefFile('測試', 'wf', '公司範本.docx', Buffer.from('tpl'));
  adapter.setFileWriter((fm) => fm.fileName.endsWith('.docx')); // 只有 docx 那步真的寫檔
  const run = runner.startRun('測試', 'wf', {});
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  const a = adapter.calls.find((c) => c.nodeId === 'a');
  assert.equal(a.fileMode.fileName, 'A.docx');
  assert.ok(a.fileMode.cwd.endsWith('out'), `工作目錄＝這趟的 out：${a.fileMode.cwd}`);
  assert.ok(a.fileMode.templatePath.endsWith('公司範本.docx'));
  assert.ok(a.outputFormat.includes('真檔'));
  assert.equal(r.steps.a.status, 'waiting_review');
  assert.equal(r.steps.a.file, 'A.docx');
  assert.equal(r.steps.a.file_note, null);
  // 停點修改的是摘要，不覆蓋真檔、也不多存一份 .md
  r = runner.edit('測試', 'wf', run.run_id, 'a', '改過的摘要', null);
  assert.equal(r.steps.a.edited_output, '改過的摘要');
  assert.equal(store.readArtifact('測試', 'wf', run.run_id, 'A.docx').toString('utf8'), 'FILE:A.docx');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  assert.equal(r.steps.b.file, 'B.md', '工人沒交出 .xlsx → 文字產出存 .md');
  assert.ok(r.steps.b.file_note.includes('沒交出'));
  assert.deepEqual(store.listArtifacts('測試', 'wf', run.run_id), ['A.docx', 'B.md']);
});

test('D19 範本填空：{{參數}} 與 {{output}} 都代入，存成範本的格式', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].template_file = 'tpl.md';
  def.nodes[0].output_file = 'md';
  const { runner, store } = setup(def);
  store.writeRefFile('測試', 'wf', 'tpl.md', Buffer.from('# 範圍：{{range}}\n\n{{output}}\n（完）', 'utf8'));
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const text = store.readArtifact('測試', 'wf', run.run_id, 'A.md').toString('utf8');
  assert.equal(text, '# 範圍：本季\n\n產出:a\n（完）');
});

test('startRun：run 落盤、步驟全 pending、定義快照與參數合併', () => {
  const { store, runner } = setup();
  const run = runner.startRun('測試', 'wf', { range: '上半年' });
  const saved = store.readRun('測試', 'wf', run.run_id);
  assert.equal(saved.status, 'running');
  assert.equal(saved.params.range, '上半年');
  assert.deepEqual(Object.keys(saved.steps), ['a', 'b', 'c']);
  for (const s of Object.values(saved.steps)) assert.equal(s.status, 'pending');
  assert.equal(saved.def.name, '三步直線', 'run 內要有定義快照（退版時舊 run 用舊版跑完）');
});

test('空字串／空白參數值回退預設，明確值照用', () => {
  const { runner } = setup();
  const run = runner.startRun('測試', 'wf', { range: '   ' });
  assert.equal(run.params.range, '本季', '空白值不覆蓋預設');
  const run2 = runner.startRun('測試', 'wf', { range: '上半年' });
  assert.equal(run2.params.range, '上半年');
});

test('runUntilPause：無停點流程一路跑完；產出串鏈、參數注入、checkpoint 逐步落盤', async () => {
  const { store, adapter, runner } = setup();
  const run = runner.startRun('測試', 'wf', {});
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.status, 'done');
  assert.ok(done.finished_at);
  assert.equal(adapter.calls.length, 3);
  assert.ok(adapter.calls[0].instruction.includes('本季'), '參數預設值要注入指示');
  assert.equal(adapter.calls[1].upstream, '產出:a', '下游輸入=上游產出');
  assert.equal(adapter.calls[2].upstream, '產出:b');
  const saved = store.readRun('測試', 'wf', run.run_id);
  for (const s of Object.values(saved.steps)) assert.equal(s.status, 'done');
});

// ---- T5：停點／修改／人步／重試（用內建範例：5 步、2 停點、末步人做）----
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
const EXAMPLE = yaml.load(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'quarterly-report.yaml'), 'utf8'));

test('停點核可→續跑；停點修改→改過的版本進下游；人步完成＋心得→run 收尾', async () => {
  const { adapter, runner } = setup(EXAMPLE);
  const run = runner.startRun('測試', 'wf', {});
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'paused');
  assert.equal(r.steps.organize.status, 'waiting_review', '第一停：整理歸納');
  r = runner.edit('測試', 'wf', run.run_id, 'organize', '改過的彙總', '金額改千元');
  assert.equal(r.steps.organize.edited_output, '改過的彙總');
  assert.equal(r.steps.organize.edit_note, '金額改千元');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.compose.status, 'waiting_review', '第二停：做成報告＋講稿');
  const analyzeCall = adapter.calls.find((c) => c.nodeId === 'analyze');
  assert.equal(analyzeCall.upstream, '改過的彙總', '下游吃修改後版本');
  r = runner.approve('測試', 'wf', run.run_id, 'compose');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.present.status, 'waiting_human', '人做步驟停著等');
  r = runner.completeHuman('測試', 'wf', run.run_id, 'present', '主管說不錯');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  assert.equal(r.steps.present.feedback, '主管說不錯');
});

test('單步失敗：標失敗＋人話原因，其餘產物不丟；修好後單步重試續跑', async () => {
  const { adapter, runner } = setup(EXAMPLE);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  runner.approve('測試', 'wf', run.run_id, 'organize');
  adapter.setFailOn('analyze');
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'paused');
  assert.equal(r.steps.analyze.status, 'failed');
  assert.ok(r.steps.analyze.error.includes('連不上'), '錯誤是人話');
  assert.equal(r.steps['fetch-data'].status, 'done', '已完成步驟不受影響');
  adapter.setFailOn(null);
  r = await runner.retry('測試', 'wf', run.run_id, 'analyze');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.analyze.status, 'done');
  assert.equal(r.steps.compose.status, 'waiting_review', '重試後繼續往下');
});

test('核可只在等你過目時有效：對非停點步驟 approve → 擋下', async () => {
  const { runner } = setup(EXAMPLE);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.throws(() => runner.approve('測試', 'wf', run.run_id, 'fetch-data'), /不在等待過目/);
});

// ---- S3：有向圖（平行／分岔）----
import { DAG_DEF, PAR_DEF, PAR_DIRECT_DEF } from './fixtures.js';

// 畫布回饋輪：fork/join 退場後的直連寫法——多出線同時跑、多入線自動匯流（含來源標頭）
test('直連並行：task 多出線兩支同時執行、多入線匯流兩支產出', async () => {
  const { adapter, runner } = setup(PAR_DIRECT_DEF);
  adapter.setDelay(20);
  const run = runner.startRun('測試', 'wf', {});
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.status, 'done');
  const a = adapter.spans.find((s) => s.nodeId === 't-a');
  const b = adapter.spans.find((s) => s.nodeId === 't-b');
  assert.ok(a.start < b.end && b.start < a.end, `兩支要重疊執行：${JSON.stringify(adapter.spans)}`);
  const finalCall = adapter.calls.find((c) => c.nodeId === 'final');
  assert.ok(finalCall.upstream.includes('產出:t-a') && finalCall.upstream.includes('產出:t-b'), '收尾要吃到兩支產出');
  assert.ok(finalCall.upstream.includes('【做A】') && finalCall.upstream.includes('【做B】'), '多入線匯流要帶來源標頭');
});

test('平行段：兩支同時執行、join 匯流兩支產出、收尾吃 join 合體', async () => {
  const { adapter, runner } = setup(PAR_DEF);
  adapter.setDelay(20);
  const run = runner.startRun('測試', 'wf', {});
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.status, 'done');
  const a = adapter.spans.find((s) => s.nodeId === 't-a');
  const b = adapter.spans.find((s) => s.nodeId === 't-b');
  assert.ok(a.start < b.end && b.start < a.end, `兩支要重疊執行：${JSON.stringify(adapter.spans)}`);
  const finalCall = adapter.calls.find((c) => c.nodeId === 'final');
  assert.ok(finalCall.upstream.includes('產出:t-a') && finalCall.upstream.includes('產出:t-b'), 'join 匯流要含兩支產出');
});

test('分岔：AI 依條件選路→未選支跳過；選到人做步驟則停等', async () => {
  const { adapter, runner } = setup(DAG_DEF);
  adapter.setBranchAnswer('五千以下');
  const run = runner.startRun('測試', 'wf', {});
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.steps['boss-sign'].status, 'skipped', '未選的簽核路要跳過');
  assert.equal(done.steps['amount-check'].choice, 'merge');
  assert.equal(done.steps['amount-check'].choice_by, 'ai');
  assert.equal(done.status, 'done');
  // 走簽核路：人做步驟停等
  const { adapter: ad2, runner: r2 } = setup(DAG_DEF);
  ad2.setBranchAnswer('金額五千以上');
  const run2 = r2.startRun('測試', 'wf', {});
  const paused = await r2.runUntilPause('測試', 'wf', run2.run_id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.steps['boss-sign'].status, 'waiting_human');
  r2.completeHuman('測試', 'wf', run2.run_id, 'boss-sign', '簽好了');
  const done2 = await r2.runUntilPause('測試', 'wf', run2.run_id);
  assert.equal(done2.status, 'done');
});

test('分岔：AI 答不清 → 停下問人；chooseBranch 續跑並記 choice_by=user', async () => {
  const { adapter, runner } = setup(DAG_DEF);
  adapter.setBranchAnswer('這要看情況耶');
  const run = runner.startRun('測試', 'wf', {});
  const paused = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.steps['amount-check'].status, 'waiting_branch');
  runner.chooseBranch('測試', 'wf', run.run_id, 'amount-check', 'merge');
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.status, 'done');
  assert.equal(done.steps['amount-check'].choice_by, 'user');
  assert.equal(done.steps['boss-sign'].status, 'skipped');
});

test('平行一支失敗：他支照跑完、run 停住、單支重試後會合續跑', async () => {
  const { adapter, runner } = setup(PAR_DEF);
  adapter.setFailOn('t-a');
  const run = runner.startRun('測試', 'wf', {});
  const paused = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.steps['t-a'].status, 'failed');
  assert.equal(paused.steps['t-b'].status, 'done', '另一支不受影響照跑完');
  assert.equal(paused.steps.jn.status, 'pending', '會合點等著缺的那支');
  adapter.setFailOn(null);
  runner.retry('測試', 'wf', run.run_id, 't-a');
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.status, 'done');
});

test('資料不全自報：【資料不全】開頭→停該步＋缺什麼入紀錄；重抓重跑；帶標注續跑下游看得到', async () => {
  const { adapter, runner } = setup(LINEAR3);
  let incomplete = true;
  adapter.executeNode = async ({ nodeId, upstream }) => {
    adapter.calls.push({ nodeId, upstream });
    if (nodeId === 'a' && incomplete) return '【資料不全】只給了 5、6 月，缺 7 月\n（部分資料表）';
    return `產出:${nodeId}`;
  };
  const run = runner.startRun('測試', 'wf', {});
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'paused');
  assert.equal(r.steps.a.status, 'waiting_data');
  assert.equal(r.steps.a.data_note, '只給了 5、6 月，缺 7 月');
  // 重抓一次（資料修好了）
  incomplete = false;
  runner.dataRetry('測試', 'wf', run.run_id, 'a');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  assert.equal(r.steps.a.output, '產出:a');
  // 帶標注續跑：另開一趟
  incomplete = true;
  const run2 = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run2.run_id);
  runner.dataAccept('測試', 'wf', run2.run_id, 'a');
  const r2 = await runner.runUntilPause('測試', 'wf', run2.run_id);
  assert.equal(r2.status, 'done');
  const bCall = adapter.calls.filter((c) => c.nodeId === 'b').at(-1);
  assert.ok(bCall.upstream.includes('缺 7 月'), '下游輸入要帶著標注');
  assert.ok(r2.steps.a.output.includes('已標注'), '成品留標注');
});

test('中斷恢復：模擬跑到一半掛掉（步驟卡在 running），新 runner 從 checkpoint 續跑', async () => {
  const { dir, store, runner } = setup();
  const run = runner.startRun('測試', 'wf', {});
  // 模擬崩潰現場：a 已完成、b 卡在 running
  const crashed = store.readRun('測試', 'wf', run.run_id);
  crashed.steps.a = { ...crashed.steps.a, status: 'done', output: '產出:a' };
  crashed.steps.b = { ...crashed.steps.b, status: 'running' };
  store.writeRun('測試', 'wf', run.run_id, crashed);
  // 全新 store＋runner（同資料目錄）＝重啟
  const store2 = createStore(dir);
  const adapter2 = fakeAdapter();
  const runner2 = createRunner({ store: store2, adapter: adapter2 });
  const done = await runner2.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.status, 'done');
  assert.deepEqual(adapter2.calls.map((c) => c.nodeId), ['b', 'c'], 'a 不重跑，b 重新執行');
  assert.equal(done.steps.a.output, '產出:a', '已完成產物不遺失');
});

// ===== D20：等時刻（wait_until）＋觸發來源 =====

function setupClock(def, nowMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-runner-'));
  const store = createStore(dir);
  store.writeWorkflow('測試', 'wf', def);
  const adapter = fakeAdapter();
  const clock = { t: nowMs };
  const runner = createRunner({ store, adapter, now: () => clock.t });
  return { store, adapter, runner, clock };
}

test('D20：固定 wait_until 未到點 → waiting_time＋wake_at，run 暫停；到點 resumeTime 續跑', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[1].wait_until = '2026-09-01T10:00';
  const { runner, store, clock } = setupClock(def, new Date('2026-08-28T08:00').getTime());
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  let r = store.readRun('測試', 'wf', run.run_id);
  assert.equal(r.steps.b.status, 'waiting_time');
  assert.equal(new Date(r.steps.b.wake_at).getTime(), new Date('2026-09-01T10:00').getTime());
  assert.equal(r.status, 'paused');
  clock.t = new Date('2026-09-01T10:00').getTime() + 1000;
  runner.resumeTime('測試', 'wf', run.run_id, 'b');
  await runner.runUntilPause('測試', 'wf', run.run_id);
  r = store.readRun('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
});

test('D20：固定時刻已過 → 不等，直接跑', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[1].wait_until = '2026-08-01T10:00';
  const { runner, store } = setupClock(def, new Date('2026-08-28T08:00').getTime());
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(store.readRun('測試', 'wf', run.run_id).status, 'done');
});

test('D20：動態時刻 {from}——上游產出 WHEN 行被解析；解析出過去時刻 → time_pending 問人', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[1].wait_until = { from: 'a' };
  const { runner, store, adapter, clock } = setupClock(def, new Date('2026-08-28T08:00').getTime());
  adapter.executeNode = async ({ nodeId }) => (nodeId === 'a' ? '跟對方敲好了。\nWHEN: 2026-09-03T14:00' : `產出:${nodeId}`);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  let r = store.readRun('測試', 'wf', run.run_id);
  assert.equal(r.steps.b.status, 'waiting_time');
  assert.ok(r.steps.b.wake_at.startsWith('2026-09-03'));
  // 過去時刻案例
  const def2 = structuredClone(LINEAR3);
  def2.nodes[1].wait_until = { from: 'a' };
  const s2 = setupClock(def2, new Date('2026-08-28T08:00').getTime());
  s2.adapter.executeNode = async ({ nodeId }) => (nodeId === 'a' ? 'WHEN: 2026-08-01T14:00' : `產出:${nodeId}`);
  const run2 = s2.runner.startRun('測試', 'wf', {});
  await s2.runner.runUntilPause('測試', 'wf', run2.run_id);
  const r2 = s2.store.readRun('測試', 'wf', run2.run_id);
  assert.equal(r2.steps.b.status, 'time_pending');
  assert.ok(r2.steps.b.time_note.includes('過去'));
});

test('D20：上游產出沒有時間 → time_pending；resumeTime 給未來時刻 → 轉 waiting_time', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[1].wait_until = { from: 'a' };
  const { runner, store, adapter } = setupClock(def, new Date('2026-08-28T08:00').getTime());
  adapter.executeNode = async ({ nodeId }) => (nodeId === 'a' ? '對方還沒回。' : `產出:${nodeId}`);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(store.readRun('測試', 'wf', run.run_id).steps.b.status, 'time_pending');
  runner.resumeTime('測試', 'wf', run.run_id, 'b', '2026-09-05T09:00');
  const r = store.readRun('測試', 'wf', run.run_id);
  assert.equal(r.steps.b.status, 'waiting_time');
  assert.ok(r.steps.b.wake_at.startsWith('2026-09-05'));
});

test('D20：被 {from} 引用的步驟，格式要求含 WHEN 行指示；source/makeup 落盤', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[1].wait_until = { from: 'a' };
  const { runner, store, adapter, clock } = setupClock(def, new Date('2026-08-28T08:00').getTime());
  const run = runner.startRun('測試', 'wf', {}, { source: 'schedule', makeup: true });
  assert.equal(run.source, 'schedule');
  assert.equal(run.makeup, true);
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const a = adapter.calls.find((c) => c.nodeId === 'a');
  assert.ok(a.outputFormat.includes('WHEN'));
  const manual = runner.startRun('測試', 'wf', {});
  assert.equal(manual.source, 'manual');
});

test('D20：來源步產出含 EVENT_ID → 等時刻步記 linked_event_id（US-039 綁定）', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[1].wait_until = { from: 'a' };
  const { runner, store, adapter } = setupClock(def, new Date('2026-08-28T08:00').getTime());
  adapter.executeNode = async ({ nodeId, outputFormat }) => {
    if (nodeId === 'a') {
      if (!/EVENT_ID/.test(outputFormat)) throw new Error('格式要求應含 EVENT_ID 指示');
      return '已建立邀請。\nWHEN: 2026-09-03T14:00\nEVENT_ID: gcal-abc123';
    }
    return `產出:${nodeId}`;
  };
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const r = store.readRun('測試', 'wf', run.run_id);
  assert.equal(r.steps.b.status, 'waiting_time');
  assert.equal(r.steps.b.linked_event_id, 'gcal-abc123');
});

test('健檢 P2-04：多起點會合流程可以開跑並跑完（兩顆起點都執行、會合後收尾）', async () => {
  const def = {
    format: 1, name: '多起點', params: [],
    nodes: [
      { id: 'a', title: '客訴信整理', executor: 'ai', stop_point: 'never', instruction: '整理', next: ['j'] },
      { id: 'b', title: '電話紀錄整理', executor: 'ai', stop_point: 'never', instruction: '整理', next: ['j'] },
      { id: 'j', title: '會合', kind: 'join', next: ['c'] },
      { id: 'c', title: '彙整回覆', executor: 'ai', stop_point: 'never', instruction: '彙整', next: [] },
    ],
  };
  const { runner, store } = setup(def);
  const run = runner.startRun('測試', 'wf', {}); // 嚴格驗證這關要放行
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const r = store.readRun('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  for (const nid of ['a', 'b', 'c']) assert.equal(r.steps[nid].status, 'done');
});

test('複查 M2：parseWhen 嚴格——不存在的日期不准被捲到別日', () => {
  assert.equal(parseWhen('2026-02-30T14:00'), null, '2/30 不存在，不准變 3/2');
  assert.equal(parseWhen('2026-04-31T08:00'), null);
  assert.equal(parseWhen('2026-08-24T25:00'), null, '25 點不存在');
  assert.ok(parseWhen('2026-02-28T14:00'), '真實日期照常');
  assert.ok(parseWhen('2028-02-29T14:00'), '閏年 2/29 合法');
  assert.equal(parseWhen('2026-02-29T14:00'), null, '平年 2/29 不合法');
});

// ===== 儀表板輪：prompt 卷宗＋用量帳 meta 歸戶 =====

test('儀表板輪：每步執行前存卷宗（renderPrompt 全文）；executeNode 帶 meta 歸戶', async () => {
  const { runner, adapter, store } = setup();
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.deepEqual(store.listPromptRecords('測試', 'wf', run.run_id), ['a.txt', 'b.txt', 'c.txt']);
  assert.equal(store.readPromptRecord('測試', 'wf', run.run_id, 'a.txt'), 'PROMPT:a');
  const a = adapter.calls.find((c) => c.nodeId === 'a');
  assert.deepEqual(a.meta, { kind: 'step', category: '測試', workflow: 'wf', run: run.run_id, node: 'a' });
});

test('儀表板輪：分岔判路的 prompt 也入卷宗（-判路.txt），meta kind=branch', async () => {
  const def = {
    format: 1,
    name: '分岔卷宗',
    params: [],
    nodes: [
      { id: 's', title: '起步', executor: 'ai', stop_point: 'never', instruction: '算金額', next: ['j'] },
      { id: 'j', title: '判金額', kind: 'branch', instruction: '超過五千走高', branches: [{ label: '高', next: 'h' }, { label: '低', next: 'l' }], next: [] },
      { id: 'h', title: '高路', executor: 'ai', stop_point: 'never', instruction: '走高', next: [] },
      { id: 'l', title: '低路', executor: 'ai', stop_point: 'never', instruction: '走低', next: [] },
    ],
  };
  const { runner, adapter, store } = setup(def);
  adapter.setBranchAnswer('1. 高');
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const records = store.listPromptRecords('測試', 'wf', run.run_id);
  assert.ok(records.includes('j-判路.txt'), `卷宗要含判路 prompt：${records}`);
  assert.ok(store.readPromptRecord('測試', 'wf', run.run_id, 'j-判路.txt').includes('超過五千走高'));
  const bc = adapter.calls.find((c) => c.branchPrompt);
  assert.equal(bc.meta.kind, 'branch');
  assert.equal(bc.meta.node, 'j');
  assert.equal(bc.meta.run, run.run_id);
});

// ---- 資料通道輪：人做步驟交出內容、補資料、資料不全診斷 ----
const HUMAN_HANDOFF = {
  format: 1,
  name: '人做交接',
  params: [],
  nodes: [
    { id: 'paste', title: '貼上來信', executor: 'human', stop_point: 'always', instruction: '把來信貼進來', handoff: '來信全文', next: ['classify'] },
    { id: 'classify', title: '判類', executor: 'ai', stop_point: 'never', instruction: '讀上一步交出的來信判類', next: [] },
  ],
};

test('資料通道輪：人做步驟完成時交出的內容成為它的產出、下一步 AI 吃得到；心得另存', async () => {
  const { runner, adapter } = setup(HUMAN_HANDOFF);
  const run = runner.startRun('測試', 'wf', {});
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.paste.status, 'waiting_human');
  r = runner.completeHuman('測試', 'wf', run.run_id, 'paste', '已貼', '寄件人：林小姐\n主旨：刮傷');
  assert.equal(r.steps.paste.output, '寄件人：林小姐\n主旨：刮傷');
  assert.equal(r.steps.paste.feedback, '已貼');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(adapter.calls.find((c) => c.nodeId === 'classify').upstream, '寄件人：林小姐\n主旨：刮傷');
  assert.equal(r.status, 'done');
});

test('資料通道輪：人做步驟留空（或只有空白）→ 產出仍是 null，下一步空手', async () => {
  const { runner, adapter } = setup(HUMAN_HANDOFF);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const r = runner.completeHuman('測試', 'wf', run.run_id, 'paste', null, '   ');
  assert.equal(r.steps.paste.output, null);
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(adapter.calls.find((c) => c.nodeId === 'classify').upstream, '');
});

test('資料通道輪：資料不全附診斷（來源是空的人做步驟就指名它）；「我補給你」把貼的內容排在上游前面重跑', async () => {
  const { runner, adapter } = setup(HUMAN_HANDOFF);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  runner.completeHuman('測試', 'wf', run.run_id, 'paste', null, null); // 沒交內容
  adapter.setOutput('classify', '【資料不全】上一步沒有信可以判讀。\n（骨架）');
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.classify.status, 'waiting_data');
  assert.equal(r.steps.classify.data_note, '上一步沒有信可以判讀。');
  assert.ok(r.steps.classify.data_diagnosis.reason.includes('貼上來信'), '診斷要指名空的人做步驟');
  assert.deepEqual(r.steps.classify.data_diagnosis.fix, { kind: 'node', id: 'paste' });
  assert.throws(() => runner.dataSupply('測試', 'wf', run.run_id, 'classify', '  '), /空的/);
  r = runner.dataSupply('測試', 'wf', run.run_id, 'classify', '寄件人：林小姐');
  assert.equal(r.steps.classify.status, 'pending');
  assert.equal(r.steps.classify.supplied_input, '寄件人：林小姐');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  const calls = adapter.calls.filter((c) => c.nodeId === 'classify');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].upstream, '【你補的資料】\n寄件人：林小姐', '沒有原上游時只給補的');
  assert.equal(r.steps.classify.status, 'done');
  assert.equal(r.status, 'done');
});

test('資料通道輪：補資料時原上游也照給（補的在前、原上游在後）；第一步沒來源的診斷講明', async () => {
  const def = {
    format: 1,
    name: '兩步',
    params: [],
    nodes: [
      { id: 'a', title: '起步', executor: 'ai', stop_point: 'never', instruction: '寫一段', next: ['b'] },
      { id: 'b', title: '接手', executor: 'ai', stop_point: 'never', instruction: '整理上一步', next: [] },
    ],
  };
  const { runner, adapter } = setup(def);
  adapter.setOutput('a', '【資料不全】沒有資料。');
  const run = runner.startRun('測試', 'wf', {});
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.status, 'waiting_data');
  assert.ok(r.steps.a.data_diagnosis.reason.includes('沒有任何輸入來源'));
  runner.dataSupply('測試', 'wf', run.run_id, 'a', '資料甲');
  adapter.setOutput('b', '【資料不全】還缺乙。');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.status, 'done');
  assert.equal(r.steps.b.status, 'waiting_data');
  assert.ok(r.steps.b.data_diagnosis.reason.includes('AI 認為不夠'), '上游有交但不夠');
  runner.dataSupply('測試', 'wf', run.run_id, 'b', '資料乙');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  const bCalls = adapter.calls.filter((c) => c.nodeId === 'b');
  assert.equal(bCalls[1].upstream, '【你補的資料】\n資料乙\n\n【上一步的產出】\n產出:a');
  assert.equal(r.status, 'done');
});
