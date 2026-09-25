import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { createStore } from '../src/store.js';
import { createRunner, parseWhen } from '../src/runner.js';
import { createHostAdapter } from '../src/host-adapter.js';
import { createMemory, makeCard, parseGroupText } from '../src/memory.js';

// 假 adapter：回錄呼叫、可注入失敗／延遲／監工答案／查核答案
function fakeAdapter() {
  const calls = [];
  const spans = []; // {nodeId, start, end} 併發驗證用
  let failOn = null;
  let delay = 0;
  const delayFor = {}; // 單一步驟的延遲（任一條到要一快一慢）
  let seq = 0;
  let failTimes = Infinity;
  const outputs = {}; // 指定某步下一次的回覆（模擬【資料不全】，用一次即清）
  let fileWriter = null;
  let checkReply = null; // kind='check' 的回覆（字串，或 (第幾次查, meta)=>字串／丟錯）
  let editRulesReply = null; // kind='edit-rules' 的回覆
  // kind='supervisor' 依 meta.phase 分三種回覆，缺省都是合法 JSON（監工缺省是開，每趟都會被問到）
  let briefReply = '{"note":"（測試）開場備註"}';
  let handoffReply = '{"note":"（測試）交接","tier":null,"web":null,"route":null}';
  let recordReply = '{"text":"（測試）這趟的紀錄","suggestions":[]}';
  let routeReply = '{"cards":[]}'; // kind='memory'（三問路由）的回覆
  const checkSeq = {}; // nodeId → 這一步查到第幾次
  const reply = (x, meta, prompt) => (typeof x === 'function' ? x(meta, prompt) : x);
  return {
    calls,
    spans,
    setFailOn(nodeId, times = Infinity) { failOn = nodeId; failTimes = times; },
    setOutput(nodeId, text) { outputs[nodeId] = text; },
    setFileWriter(fn) { fileWriter = fn; }, // 模擬工人在 fileMode.cwd 寫出檔案（回 true＝寫預設文字、回內容＝寫那份內容）
    setDelay(ms) { delay = ms; },
    setDelayFor(nodeId, ms) { delayFor[nodeId] = ms; },
    setBriefReply(x) { briefReply = x; }, // 字串，或 (meta, prompt)=>字串／丟錯
    setHandoffReply(x) { handoffReply = x; },
    setRecordReply(x) { recordReply = x; },
    setRouteReply(x) { routeReply = x; },
    setCheckResponse(x) { checkReply = x; },
    setEditRulesResponse(x) { editRulesReply = x; },
    renderPrompt: (f) => `PROMPT:${f.nodeId}`, // 卷宗協定：runner 存的全文＝這個函式的輸出
    async complete({ prompt, meta }) {
      const kind = meta?.kind;
      calls.push({ prompt, meta, ...(kind === 'check' ? { checkPrompt: prompt } : {}) });
      if (kind === 'check') {
        const n = (checkSeq[meta.node] = (checkSeq[meta.node] ?? 0) + 1);
        return typeof checkReply === 'function' ? checkReply(n, meta, prompt) : (checkReply ?? '');
      }
      if (kind === 'edit-rules') return typeof editRulesReply === 'function' ? editRulesReply(meta) : (editRulesReply ?? '');
      if (kind === 'supervisor') {
        if (meta.phase === 'brief') return reply(briefReply, meta, prompt);
        if (meta.phase === 'record') return reply(recordReply, meta, prompt);
        return reply(handoffReply, meta, prompt);
      }
      if (kind === 'memory') return reply(routeReply, meta, prompt);
      return '';
    },
    async executeNode({ nodeId, title, instruction, outputFormat, upstream, model, web, supervisorNotes, roleContext, background, constraints, examples, creativity, reviewFocus, meta, fileMode, paramBlocks, editRules, redo, checkNote, coreNotes, groupRules, groupName, companyRules, deptRules, attachments, connectors, exec }) {
      const start = seq++;
      calls.push({ nodeId, title, instruction, outputFormat, upstream, model, web, supervisorNotes, roleContext, background, constraints, examples, creativity, reviewFocus, meta, fileMode, paramBlocks, editRules, redo, checkNote, coreNotes, groupRules, groupName, companyRules, deptRules, attachments, connectors, exec });
      if (fileMode && fileWriter) {
        const written = fileWriter(fileMode);
        if (written) fs.writeFileSync(path.join(fileMode.cwd, fileMode.fileName), written === true ? `FILE:${fileMode.fileName}` : written);
      }
      const ms = delayFor[nodeId] ?? delay;
      if (ms) await new Promise((r) => setTimeout(r, ms));
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
  assert.throws(() => runner.startRun('測試', 'wf', {}), (e) => e.message.includes('孤島步驟') && e.message.includes('還沒接進 Workflow'));
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

test('降級只剩一種情況：沒開產檔權限（2026-09-22 起四種格式全接完，OUTPUT_TIER2 空了）', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].output_file = 'pdf'; // 現在 pdf 也是真檔——這一步沒開權限，照樣降級
  def.nodes[1].output_file = 'docx';
  const { runner, store, adapter } = setup(def);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.deepEqual(store.listArtifacts('測試', 'wf', run.run_id), ['A.md', 'B.md']);
  const r = store.readRun('測試', 'wf', run.run_id);
  assert.ok(r.steps.a.file_note.includes('產檔權限'), '沒開權限＝降級，理由講權限不講工具鏈');
  assert.ok(r.steps.b.file_note.includes('產檔權限'));
  assert.equal(r.steps.b.file_note, '這條 Workflow 沒開產檔權限——.docx 先存成 .md；Workflow 頁打開「允許這條 Workflow 產出檔案」就會產真檔');
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
  runner.resume('測試', 'wf', run.run_id); //：edit 不再自己翻狀態，放行是獨立動作
  assert.equal(r.steps.a.edited_output, '改過的摘要');
  assert.equal(store.readArtifact('測試', 'wf', run.run_id, 'A.docx').toString('utf8'), 'FILE:A.docx');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  assert.equal(r.steps.b.file, 'B.md', '工人沒交出 .xlsx → 文字產出存 .md');
  assert.ok(r.steps.b.file_note.includes('沒交出'));
  assert.deepEqual(store.listArtifacts('測試', 'wf', run.run_id), ['A.docx', 'B.md']);
});

test('成品格式輪：流程開產檔權限＋pptx → 進產檔模式產真檔，不再降級成 .md', async () => {
  const def = structuredClone(LINEAR3);
  def.permissions = { files: true };
  def.nodes[0].output_file = 'pptx';
  const { runner, store, adapter } = setup(def);
  adapter.setFileWriter((fm) => fm.fileName.endsWith('.pptx'));
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const a = adapter.calls.find((c) => c.nodeId === 'a');
  assert.ok(a.fileMode, 'pptx 要進產檔模式（以前會被降級掉）');
  assert.ok(a.fileMode.fileName.endsWith('.pptx'), a.fileMode?.fileName);
  assert.ok(store.listArtifacts('測試', 'wf', run.run_id).some((f) => f.endsWith('.pptx')), '產出資料夾要有真的 .pptx');
  const r = store.readRun('測試', 'wf', run.run_id);
  assert.ok(!r.steps.a.file_note, '沒降級就不該有降級說明');
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
  const steps = adapter.calls.filter((c) => c.nodeId); // 查核員的呼叫也記在 calls 裡，工人的用 nodeId 篩
  assert.equal(steps.length, 3);
  assert.ok(steps[0].instruction.includes('本季'), '參數預設值要注入指示');
  assert.equal(steps[1].upstream, '產出:a', '下游輸入=上游產出');
  // 第三步拿沿路全部產出（最近在前、多段加標頭）
  assert.equal(steps[2].upstream, '（沿路全部產出，最近的在前）\n【B】\n產出:b\n\n【A】\n產出:a');
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
  assert.equal(r.status, 'paused', '裁定 28：改完先停著，等擬規則那段做完才放行');
  r = runner.resume('測試', 'wf', run.run_id);
  assert.equal(r.status, 'running');
  assert.equal(r.steps.organize.edited_output, '改過的彙總');
  assert.equal(r.steps.organize.edit_note, '金額改千元');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.compose.status, 'waiting_review', '第二停：做成報告＋講稿');
  const analyzeCall = adapter.calls.find((c) => c.nodeId === 'analyze');
  // 沿路全帶——修改後版本排最前（最近在前），更早的抓資料產出跟在後面
  assert.ok(analyzeCall.upstream.startsWith('（沿路全部產出，最近的在前）\n【整理歸納】\n改過的彙總\n\n【'), `下游吃修改後版本：${analyzeCall.upstream}`);
  assert.ok(!analyzeCall.upstream.includes('產出:organize'), '原版不進下游');
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

// fork/join 退場後的直連寫法——多出線同時跑、多入線自動匯流（含來源標頭）
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

// 遷移：判路併進監工的交接——分岔節點的選路由 handoff 的 route 欄（選項編號字串）決定
test('分岔：AI 依條件選路→未選支跳過；選到人做步驟則停等', async () => {
  const { adapter, runner } = setup(DAG_DEF);
  adapter.setHandoffReply('{"route":"2"}'); // 2＝五千以下
  const run = runner.startRun('測試', 'wf', {});
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.steps['boss-sign'].status, 'skipped', '未選的簽核路要跳過');
  assert.equal(done.steps['amount-check'].choice, 'merge');
  assert.equal(done.steps['amount-check'].choice_by, 'ai');
  assert.equal(done.status, 'done');
  // 走簽核路：人做步驟停等
  const { adapter: ad2, runner: r2 } = setup(DAG_DEF);
  ad2.setHandoffReply('{"route":"1"}'); // 1＝金額五千以上
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
  adapter.setHandoffReply('{"route":null}'); // 監工判斷不了
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

test('資料不全「就這樣繼續」不吃停點：標了做完給我看的步驟照樣停下來給人看', async () => {
  // 2026-09-19 真 AI 補驗輪實走抓到：dataAccept 無條件把步驟標 done，stop_point: always
  // 的那一步被直接跳過往下跑——使用者選的是「用現有資料做」，不是「不用給我看」
  const def = structuredClone(LINEAR3);
  def.nodes[0].stop_point = 'always';
  const { adapter, runner } = setup(def);
  adapter.executeNode = async ({ nodeId }) => (nodeId === 'a' ? '【資料不全】缺 7 月\n（部分資料表）' : `產出:${nodeId}`);
  const run = runner.startRun('測試', 'wf', {});
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.status, 'waiting_data');
  runner.dataAccept('測試', 'wf', run.run_id, 'a');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.status, 'waiting_review', '停點還在：帶標注續跑也要先給人過目');
  assert.ok(r.steps.a.output.includes('已標注'), '成品仍留標注');
  assert.equal(r.steps.b.status, 'pending', '人還沒核可，下游不准先跑');
  runner.approve('測試', 'wf', run.run_id, 'a');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
});

test('資料不全「就這樣繼續」：沒設停點的步驟照舊直接往下跑', async () => {
  const { adapter, runner } = setup(LINEAR3); // a 的 stop_point 是 never
  adapter.executeNode = async ({ nodeId }) => (nodeId === 'a' ? '【資料不全】缺 7 月\n（部分資料表）' : `產出:${nodeId}`);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  runner.dataAccept('測試', 'wf', run.run_id, 'a');
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  assert.equal(r.steps.a.status, 'done');
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
  assert.deepEqual(adapter2.calls.filter((c) => c.nodeId).map((c) => c.nodeId), ['b', 'c'], 'a 不重跑，b 重新執行');
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

// ===== prompt 卷宗＋用量帳 meta 歸戶 =====

test('儀表板輪：每步執行前存卷宗（renderPrompt 全文）；executeNode 帶 meta 歸戶', async () => {
  const { runner, adapter, store } = setup();
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  // 查核員的指示也進卷宗（每步一份 checkN），所以清單裡工人與查核員各一份
  // 再加開場（_brief）、收尾（_record）、總覽（_overview，US-104）與每個非第一層步驟的交接，各存指示與回覆原文兩份
  assert.deepEqual(store.listPromptRecords('測試', 'wf', run.run_id), [
    '_brief.reply.txt', '_brief.txt', '_overview.reply.txt', '_overview.txt', '_record.reply.txt', '_record.txt',
    'a.check1.txt', 'a.txt',
    'b.check1.txt', 'b.handoff.reply.txt', 'b.handoff.txt', 'b.txt',
    'c.check1.txt', 'c.handoff.reply.txt', 'c.handoff.txt', 'c.txt',
  ]);
  assert.equal(store.readPromptRecord('測試', 'wf', run.run_id, 'a.txt'), 'PROMPT:a');
  const a = adapter.calls.find((c) => c.nodeId === 'a');
  assert.deepEqual(a.meta, { kind: 'step', category: '測試', workflow: 'wf', run: run.run_id, node: 'a' });
});

test('儀表板輪：分岔判路的 prompt 也入卷宗（.handoff.txt），meta kind=supervisor', async () => {
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
  adapter.setHandoffReply('{"route":"1"}');
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const records = store.listPromptRecords('測試', 'wf', run.run_id);
  assert.ok(records.includes('j.handoff.txt'), `卷宗要含判路 prompt：${records}`);
  assert.ok(store.readPromptRecord('測試', 'wf', run.run_id, 'j.handoff.txt').includes('超過五千走高'));
  const bc = adapter.calls.find((c) => c.meta?.phase === 'handoff' && c.meta.node === 'j');
  assert.ok(bc.prompt.includes('# 判路題'), '分岔節點的交接要帶判路題');
  assert.equal(bc.meta.kind, 'supervisor');
  assert.equal(bc.meta.node, 'j');
  assert.equal(bc.meta.run, run.run_id);
});

// ---- 人做步驟交出內容、補資料、資料不全診斷 ----
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

// ===== 長欄位不代進句子（runner injectParams sink）=====
const FIELD_DEF = {
  format: 1,
  name: '長欄位測試',
  params: [
    { key: 'email', label: '來信', default: '' },
    { key: 'nickname', label: '暱稱', default: '' },
  ],
  nodes: [
    { id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '請摘要來信：{{email}}，稱呼用 {{nickname}}', next: [] },
  ],
};

test('長欄位不代進句子：含換行的欄位值 → instruction 裡的 {{key}} 換成「見下方欄位內容」提示、值收進 paramBlocks；短值照舊直代', async () => {
  const longValue = '寄件人：林小姐\n主旨：刮傷\n內文：上週買的包包提把斷了，希望能換貨或退款，附件是照片。';
  const { runner, adapter } = setup(FIELD_DEF);
  const run = runner.startRun('測試', 'wf', { email: longValue, nickname: '林小姐' });
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const a = adapter.calls.find((c) => c.nodeId === 'a');
  assert.ok(a.instruction.includes('（見下方「欄位內容」的「來信」）'), `instruction 應含提示語：${a.instruction}`);
  assert.ok(!a.instruction.includes(longValue), '長值不該直接代進 instruction');
  assert.ok(a.instruction.includes('稱呼用 林小姐'), '短值照舊直代');
  assert.deepEqual(a.paramBlocks, [{ label: '來信', value: longValue }], 'paramBlocks 只收長值，不收短值');
});

test('長欄位不代進句子：純文字超過 200 字（沒有換行）也算長，一樣換成提示語', async () => {
  const longNoNewline = 'A'.repeat(201);
  const { runner, adapter } = setup(FIELD_DEF);
  const run = runner.startRun('測試', 'wf', { email: longNoNewline, nickname: '陳先生' });
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const a = adapter.calls.find((c) => c.nodeId === 'a');
  assert.ok(a.instruction.includes('（見下方「欄位內容」的「來信」）'));
  assert.deepEqual(a.paramBlocks, [{ label: '來信', value: longNoNewline }]);
});

test('長欄位不代進句子：卷宗（renderPrompt 存的 prompt）含「# 欄位內容（原文）」段（真實 host-adapter 端到端驗證）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-runner-'));
  const store = createStore(dir);
  store.writeWorkflow('測試', 'wf', FIELD_DEF);
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdin = { write() {}, end() {}, on() {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', '產出文字');
      child.emit('close', 0);
    });
    return child;
  };
  const realAdapter = createHostAdapter({ spawnFn });
  const runner = createRunner({ store, adapter: realAdapter });
  const longValue = '寄件人：林小姐\n主旨：刮傷';
  const run = runner.startRun('測試', 'wf', { email: longValue, nickname: '林小姐' });
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const prompt = store.readPromptRecord('測試', 'wf', run.run_id, 'a.txt');
  assert.ok(prompt.includes('# 欄位內容（原文）'), `卷宗應含欄位內容段：${prompt}`);
  assert.ok(prompt.includes('【欄位：來信】'));
  assert.ok(prompt.includes(longValue));
  assert.ok(prompt.includes('（見下方「欄位內容」的「來信」）'), '指示裡的 {{email}} 要換成提示語，不是原文');
});

const FIELD_DEF2 = {
  format: 1,
  name: '長欄位測試二：所有代入欄位',
  params: [{ key: 'notes', label: '備註', default: '' }],
  nodes: [
    {
      id: 'a', title: 'A', executor: 'ai', stop_point: 'never',
      instruction: '請處理：{{notes}}',
      background: '背景：{{notes}}',
      examples: '範例：{{notes}}',
      next: [],
    },
  ],
};

test('長欄位保護涵蓋所有代入欄位：background／examples 等欄位的長值一樣不代進句子，且同一 key 跨欄位只收一次 paramBlocks', async () => {
  const longValue = '第一行\n第二行：這是一段很長的備註內容，用來確保超過門檻觸發保護機制，內容要夠長才行。';
  const { runner, adapter } = setup(FIELD_DEF2);
  const run = runner.startRun('測試', 'wf', { notes: longValue });
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const a = adapter.calls.find((c) => c.nodeId === 'a');
  assert.ok(a.instruction.includes('（見下方「欄位內容」的「備註」）'), `instruction: ${a.instruction}`);
  assert.ok(a.background.includes('（見下方「欄位內容」的「備註」）'), `background: ${a.background}`);
  assert.ok(a.examples.includes('（見下方「欄位內容」的「備註」）'), `examples: ${a.examples}`);
  assert.ok(!a.background.includes(longValue), '長值不該直接代進 background');
  assert.ok(!a.examples.includes(longValue), '長值不該直接代進 examples');
  assert.equal(a.paramBlocks.filter((b) => b.label === '備註').length, 1, '同一 key 跨欄位共用同一 sink，只收一次');
});

// ===== 查核接線、重做一次、waiting_check、三個動作、停點規則往下游 =====

const CHECK_PASS = JSON.stringify({
  items: [{ claim: '總數 14 件', source: '明細共 14 件', scope: '全月', calc: '6+3+4+1=14', verdict: 'ok' }],
  must_violations: [], flags: [], summary: '對得上',
});
const CHECK_BLOCKED = JSON.stringify({
  items: [{ claim: '總數十三件', source: '明細共 14 件', scope: '全月', calc: '', verdict: 'mismatch' }],
  must_violations: [], flags: [], summary: '數字對不上',
});
const CHECK_MISSING = JSON.stringify({
  items: [{ claim: '退貨率 3%', source: '', scope: '全月', calc: '', verdict: 'missing' }],
  must_violations: [], flags: [], summary: '原始資料沒有退貨率',
});
const checkCalls = (adapter, nodeId) => adapter.calls.filter((c) => c.meta?.kind === 'check' && (!nodeId || c.meta.node === nodeId));
const workerCalls = (adapter, nodeId) => adapter.calls.filter((c) => c.nodeId === nodeId);
// 舊趟相容（ADR-010 決策 3）：改版前的趟會停在「查核攔下」（waiting_check）；新趟永遠不再進這個狀態，
// 測 checkRetry／checkAccept／edit 這幾個舊出口時，直接把紀錄改成舊趟停下時的樣子
function ageIntoWaitingCheck(store, runId, nodeId) {
  const r = store.readRun('測試', 'wf', runId);
  const s = r.steps[nodeId];
  s.status = 'waiting_check';
  s.check = { ...s.check, status: 'blocked', blocks: s.check.first_blocks ?? s.check.blocks, attempts: 2 };
  const order = r.def.nodes.map((n) => n.id);
  for (const [id, other] of Object.entries(r.steps)) { // 舊趟停下時，下游（定義順序在它之後的）還沒跑
    if (order.indexOf(id) <= order.indexOf(nodeId)) continue;
    other.status = 'pending';
    other.output = null;
    delete other.check;
    delete other.attempts;
  }
  r.status = 'paused';
  store.writeRun('測試', 'wf', runId, r);
}

test('查核輪：流程把查核關掉 → 一次都不問查核員，每步記 check off', async () => {
  const def = structuredClone(LINEAR3);
  def.check = { enabled: false };
  const { runner, adapter } = setup(def);
  adapter.setCheckResponse(CHECK_BLOCKED); // 就算注入了攔下的答案，也不該有人去問
  const run = runner.startRun('測試', 'wf', {});
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(checkCalls(adapter).length, 0, '關掉就不呼叫查核員');
  assert.equal(r.status, 'done');
  for (const nid of ['a', 'b', 'c']) assert.equal(r.steps[nid].check.status, 'off', nid);
});

test('查核輪：查核過 → check pass、attempts 記一筆、停點步驟照樣停在等過目', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].stop_point = 'always';
  const { runner, adapter } = setup(def);
  adapter.setCheckResponse(CHECK_PASS);
  const run = runner.startRun('測試', 'wf', {});
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.status, 'waiting_review', '查過了照樣進停點');
  assert.equal(r.steps.a.check.status, 'pass');
  assert.equal(r.steps.a.check.attempts, 1);
  assert.equal(r.steps.a.check.summary, '對得上');
  assert.equal(workerCalls(adapter, 'a').length, 1, '過了就不重做');
  assert.equal(r.steps.a.attempts.length, 1);
  assert.equal(r.steps.a.attempts[0].reason, 'first');
  assert.equal(r.steps.a.attempts[0].output, '產出:a');
  assert.equal(r.steps.a.attempts[0].check.status, 'pass');
  assert.ok(r.steps.a.attempts[0].at, '每一筆要有時間');
});

test('查核輪（ADR-010 決策 3）：攔到自動重做一次、不再查第二次 → check.status=redone、attempts 2（交了兩份）、first_blocks 留著第一次的攔；重做帶退回清單、meta.attempt=2、卷宗多一份 redo1', async () => {
  const { runner, adapter, store } = setup();
  adapter.setCheckResponse((n, meta) => (meta.node === 'a' && n === 1 ? CHECK_BLOCKED : CHECK_PASS));
  const run = runner.startRun('測試', 'wf', {});
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  const aCalls = workerCalls(adapter, 'a');
  assert.equal(aCalls.length, 2, '攔下就重做一次');
  assert.equal(aCalls[0].redo, undefined, '第一次沒有退回清單');
  assert.equal(aCalls[1].redo.blocks[0].kind, 'number-mismatch');
  assert.equal(aCalls[1].redo.blocks[0].claim, '總數十三件');
  assert.equal(aCalls[1].meta.attempt, 2);
  assert.ok(store.listPromptRecords('測試', 'wf', run.run_id).includes('a.redo1.txt'), '重做的指示也要進卷宗');
  assert.equal(checkCalls(adapter, 'a').length, 1, '每步最多查一次：重做那份不再問查核員');
  assert.deepEqual(r.steps.a.check, {
    status: 'redone', blocks: [], flags: [], missing: [], items: [], summary: '數字對不上', attempts: 2, // L084③：交卷次數的真值——第一份被攔、重做那份是第二份
    first_blocks: [{ kind: 'number-mismatch', claim: '總數十三件', source: '明細共 14 件', detail: '跟原始資料對不上' }],
    recheck_blocks: [], // US-112：重寫那份再由程式對一次數字（「產出:a」沒數字＝全對上）
  });
  assert.equal(r.steps.a.status, 'done', '重做完直接放行');
  assert.equal(r.status, 'done');
  assert.deepEqual(r.steps.a.attempts.map((x) => x.reason), ['first', 'redo']);
  assert.equal(r.steps.a.attempts[0].check.status, 'blocked', '第一份的查核結果留著');
  assert.deepEqual(r.steps.a.attempts[1].check, { status: 'redone', blocks: [], flags: [], recheck_blocks: [] });
});

test('查核輪（ADR-010 決策 3）：就算查核員每次都會攔，也只查一次、重做一次就放行——永遠不再進 waiting_check；停點步驟重做完照樣停在等過目', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[1].stop_point = 'always';
  const { runner, adapter } = setup(def);
  adapter.setCheckResponse(CHECK_BLOCKED); // 三步全攔
  const run = runner.startRun('測試', 'wf', {});
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.check.status, 'redone');
  assert.equal(r.steps.a.status, 'done');
  assert.equal(r.steps.b.check.status, 'redone');
  assert.equal(r.steps.b.status, 'waiting_review', '停點照舊：重做完進等過目，不是查核攔下');
  assert.equal(r.status, 'paused');
  assert.equal(workerCalls(adapter, 'a').length, 2);
  assert.equal(checkCalls(adapter, 'a').length, 1);
  assert.throws(() => runner.checkRetry('測試', 'wf', run.run_id, 'a', '亂改'), /查核攔下/, '新趟沒有查核攔下的步驟可回話重做');
  runner.approve('測試', 'wf', run.run_id, 'b');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  for (const nid of ['a', 'b', 'c']) {
    assert.equal(r.steps[nid].check.status, 'redone', nid);
    assert.notEqual(r.steps[nid].status, 'waiting_check', nid);
    assert.equal(r.steps[nid].attempts.length, 2, nid);
  }
});

test('查核輪（舊趟相容）：改版前停在「查核攔下」的趟——「回話重做」照舊能用：話與退回清單一起帶給工人，這次照新規矩查一次就放行', async () => {
  const { runner, adapter, store } = setup();
  adapter.setCheckResponse((n, meta) => (meta.node === 'a' && n === 1 ? CHECK_BLOCKED : CHECK_PASS));
  const run = runner.startRun('測試', 'wf', {});
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  ageIntoWaitingCheck(store, run.run_id, 'a'); // 假裝是改版前停下的趟
  assert.throws(() => runner.checkRetry('測試', 'wf', run.run_id, 'b', '亂改'), /查核攔下/, '不在查核攔下的步驟不能回話重做');
  r = runner.checkRetry('測試', 'wf', run.run_id, 'a', '總數請照明細重算');
  assert.equal(r.steps.a.status, 'pending');
  assert.equal(r.steps.a.check_note, '總數請照明細重算');
  assert.equal(r.steps.a.attempts.length, 2, 'attempts 保留');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  const third = workerCalls(adapter, 'a')[2];
  assert.equal(third.checkNote, '總數請照明細重算');
  assert.ok(third.redo.blocks.length > 0, '回話重做也帶上一次的退回清單');
  assert.equal(r.steps.a.attempts[2].reason, 'retry-note');
  assert.equal(r.steps.a.status, 'done');
  assert.equal(r.steps.a.check.status, 'pass');
  assert.equal(r.steps.a.check.attempts, 3, 'L084③：第一份、重做那份、回話重做這份＝第三次交卷');
  assert.equal(r.status, 'done');
});

// L084③：check.attempts 以前永遠寫 1；改成真值＝這一步到目前為止交卷（查核）的次數
test('查核輪（L084③）：check.attempts 記真值——第一次查是 1；被攔一次、回話重做後第二次查，check.attempts 為 2', async () => {
  const { runner, adapter, store } = setup();
  adapter.setCheckResponse(CHECK_PASS);
  const run = runner.startRun('測試', 'wf', {});
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.check.attempts, 1, '第一次交卷');
  assert.equal(r.steps.a.attempts.length, 1);
  ageIntoWaitingCheck(store, run.run_id, 'a'); // 當成舊趟停在「查核攔下」（第一份被攔）
  runner.checkRetry('測試', 'wf', run.run_id, 'a', '總數請照明細重算');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.attempts[1].reason, 'retry-note');
  assert.equal(r.steps.a.check.status, 'pass');
  assert.equal(r.steps.a.check.attempts, 2, '回話重做後第二次查');
  assert.equal(r.steps.a.check_note, '總數請照明細重算');
  assert.equal(r.status, 'done');
});

test('查核輪（舊趟相容）：回話只生效那一次——之後為別的原因重跑，不再把上次的話與退回清單餵給工人', async () => {
  const { runner, adapter, store } = setup();
  // a：第一次攔下 → 重做放行（新規矩）；把它改成舊趟停在查核攔下 → 回話重做那次查核說原始資料本來就缺 → 資料不全卡；補完資料再跑就過
  adapter.setCheckResponse((n, meta) => {
    if (meta.node !== 'a') return CHECK_PASS;
    if (n === 1) return CHECK_BLOCKED;
    return n === 2 ? CHECK_MISSING : CHECK_PASS;
  });
  const run = runner.startRun('測試', 'wf', {});
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.check.status, 'redone');
  ageIntoWaitingCheck(store, run.run_id, 'a');
  runner.checkRetry('測試', 'wf', run.run_id, 'a', '改用明細表');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  const third = workerCalls(adapter, 'a')[2];
  assert.equal(third.checkNote, '改用明細表', '回話那次要帶到');
  assert.ok(third.redo.blocks.length > 0, '回話那次也帶上一次的退回清單');
  assert.equal(r.steps.a.attempts[2].reason, 'retry-note');
  assert.equal(r.steps.a.status, 'waiting_data', '這次查核說原始資料本來就沒有');

  runner.dataSupply('測試', 'wf', run.run_id, 'a', '退貨率 3%：明細如下');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  const fourth = workerCalls(adapter, 'a')[3];
  assert.equal(fourth.checkNote, undefined, '補完資料的重跑不該再收到上次那句話');
  assert.equal(fourth.redo, undefined, '也不該再收到上次的退回清單');
  assert.equal(r.steps.a.attempts[3].reason, 'first', '這次不是回話重做');
  assert.equal(r.steps.a.check_note, '改用明細表', '他講過的話留著當紀錄');
  assert.equal(r.steps.a.check_note_pending, false, '用過就不再生效');
  assert.equal(r.steps.a.status, 'done');
});

test('查核輪（ADR-010 決策 3）：重做那份不再問查核員——查核員第二次會出事也無所謂；用第二份成品往下', async () => {
  const { runner, adapter } = setup();
  adapter.setCheckResponse((n, meta) => {
    if (meta.node !== 'a') return CHECK_PASS;
    if (n === 1) return CHECK_BLOCKED;
    throw new Error('連不上 Claude（測試注入）');
  });
  adapter.setOutput('a', '第一份'); // 只用一次，重做那次回預設的「產出:a」
  const run = runner.startRun('測試', 'wf', {});
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(workerCalls(adapter, 'a').length, 2);
  assert.equal(checkCalls(adapter, 'a').length, 1, '查核員只被叫一次');
  assert.equal(r.steps.a.check.status, 'redone');
  assert.equal(r.steps.a.check.attempts, 2, 'L084③：第一份被攔、重做那份是第二份');
  assert.equal(r.steps.a.output, '產出:a', '第二份成品往下走，不是退回第一份');
  assert.equal(r.steps.a.status, 'done');
  assert.equal(workerCalls(adapter, 'b')[0].upstream, '產出:a');
});

test('查核輪（舊趟相容）：查核攔下的兩個出口——「就這樣過」直接完成、「我改一下」也能改，兩者都記 accepted', async () => {
  const { runner, adapter, store } = setup();
  adapter.setCheckResponse(CHECK_BLOCKED);
  const run1 = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run1.run_id);
  assert.throws(() => runner.checkAccept('測試', 'wf', run1.run_id, 'a'), /查核攔下/, '新趟不會停在查核攔下，沒有東西可接受');
  ageIntoWaitingCheck(store, run1.run_id, 'a');
  let r = runner.checkAccept('測試', 'wf', run1.run_id, 'a');
  assert.equal(r.steps.a.status, 'done', '他已經在卡上看過成品，不再進停點');
  assert.equal(r.steps.a.check.status, 'accepted');
  assert.ok(r.steps.a.check.blocks.length > 0, '接受了也留著查核發現');
  assert.throws(() => runner.checkAccept('測試', 'wf', run1.run_id, 'a'), /查核攔下/, '同一步不能重複接受');

  const run2 = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run2.run_id);
  ageIntoWaitingCheck(store, run2.run_id, 'a');
  r = runner.edit('測試', 'wf', run2.run_id, 'a', '改過的產出', '總數改成 14');
  runner.resume('測試', 'wf', run2.run_id);
  assert.equal(r.steps.a.status, 'done');
  assert.equal(r.steps.a.check.status, 'accepted');
  assert.equal(r.steps.a.edited_output, '改過的產出');
  await runner.runUntilPause('測試', 'wf', run2.run_id);
  assert.equal(workerCalls(adapter, 'b').at(-1).upstream, '改過的產出', '改過的版本進下游');
});

test('查核輪：查核說原始資料本來就沒有 → 不重做，走資料不全卡', async () => {
  const { runner, adapter } = setup();
  adapter.setCheckResponse((n, meta) => (meta.node === 'a' ? CHECK_MISSING : CHECK_PASS));
  const run = runner.startRun('測試', 'wf', {});
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.status, 'waiting_data');
  assert.ok(r.steps.a.data_note.includes('原始資料裡沒有'), r.steps.a.data_note);
  assert.ok(r.steps.a.data_note.includes('退貨率 3%'), r.steps.a.data_note);
  assert.ok(r.steps.a.data_diagnosis, '資料不全診斷照舊算');
  assert.equal(r.steps.a.check.status, 'missing');
  assert.equal(workerCalls(adapter, 'a').length, 1, '缺原始資料不是工人的錯，不重做');
});

test('查核輪：查核員自己出事 → 標未完成查核、步驟照常往下、原因寫人話', async () => {
  const { runner, adapter } = setup();
  adapter.setCheckResponse(() => { throw new Error('連不上 Claude（測試注入）'); });
  const run = runner.startRun('測試', 'wf', {});
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  assert.equal(r.steps.a.status, 'done');
  assert.equal(r.steps.a.check.status, 'incomplete');
  assert.ok(r.steps.a.check.note.includes('這次沒查成'), r.steps.a.check.note);
  assert.equal(workerCalls(adapter, 'a').length, 1, '查核失敗不重做');
});

test('查核輪：查核看到的原始資料含全部欄位、所有祖先步驟的產出、你補的資料；自報資料不全的那次不查', async () => {
  const { runner, adapter } = setup();
  adapter.setCheckResponse(CHECK_PASS);
  adapter.setOutput('c', '【資料不全】少了明細。\n（骨架）');
  const run = runner.startRun('測試', 'wf', {});
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.c.status, 'waiting_data');
  assert.equal(checkCalls(adapter, 'c').length, 0, '工人自報資料不全就不查');
  assert.equal(r.steps.c.check.status, 'skipped');
  runner.dataSupply('測試', 'wf', run.run_id, 'c', '明細如下：帽子 6 件');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  const p = checkCalls(adapter, 'c')[0].checkPrompt;
  assert.ok(p.includes('【欄位：範圍】\n本季'), `查核要看到全部欄位：${p}`);
  assert.ok(p.includes('【步驟：A】\n產出:a'), '隔兩步的祖先 A 也要在');
  assert.ok(p.includes('【步驟：B】\n產出:b'), '祖先 B');
  assert.ok(p.indexOf('【步驟：A】') < p.indexOf('【步驟：B】'), '祖先照拓樸序');
  assert.ok(p.includes('【你補的資料】\n明細如下：帽子 6 件'));
  assert.ok(p.includes('# 成品'), '成品也在查核指示裡');
});

// ===== facts 開關與監工備註進查核 =====

test('監工輪：流程關掉「數字對原始資料」→ 查核指示講明沒開、一份原始資料都不組', async () => {
  const def = structuredClone(LINEAR3);
  def.check = { enabled: true, facts: false };
  const { runner, adapter } = setup(def);
  adapter.setCheckResponse(CHECK_PASS);
  const run = runner.startRun('測試', 'wf', {});
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  const p = checkCalls(adapter, 'a')[0].checkPrompt;
  assert.ok(p.includes('沒開數字對原始資料'), `要講明沒開：${p}`);
  assert.ok(!p.includes('【欄位：'), `關掉就不組原始資料：${p}`);
  assert.ok(p.includes('成品裡的事實不對照原始資料'), '判定規則換成只對必守與格式');
});

test('監工輪：facts 缺省 → 照舊把欄位當原始資料組給查核員', async () => {
  const { runner, adapter } = setup();
  adapter.setCheckResponse(CHECK_PASS);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const p = checkCalls(adapter, 'a')[0].checkPrompt;
  assert.ok(p.includes('【欄位：範圍】\n本季'), `缺省要照舊組原始資料：${p}`);
  assert.ok(!p.includes('沒開數字對原始資料'));
});

test('監工輪：有交接的步驟 → 查核指示帶「# 監工備註」，內容就是工人收到的那幾條', async () => {
  const { runner, adapter } = setup();
  adapter.setCheckResponse(CHECK_PASS);
  adapter.setHandoffReply('{"note":"按三類分節","tier":null,"web":null,"route":null}');
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const worker = workerCalls(adapter, 'b')[0];
  assert.ok(worker.supervisorNotes.includes('交接：按三類分節'), `工人先收到交接：${JSON.stringify(worker.supervisorNotes)}`);
  const p = checkCalls(adapter, 'b')[0].checkPrompt;
  assert.ok(p.includes('# 監工備註（參考，不是必守）'), `查核員也要看到同一份：${p}`);
  assert.ok(p.includes('- 交接：按三類分節'));
  const musts = p.slice(p.indexOf('# 必守（逐條對）'), p.indexOf('# 格式要求'));
  assert.ok(!musts.includes('按三類分節'), '監工備註不進必守');
});

test('查核輪：停點改過 → 擬成規則寫進 edit_rules，下游每一步（含隔兩步）都帶 scope=all 的那條，查核的必守也含它', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].stop_point = 'always';
  const { runner, adapter } = setup(def);
  adapter.setCheckResponse(CHECK_PASS);
  adapter.setEditRulesResponse(JSON.stringify({ rules: [
    { text: '金額一律用千元', scope: 'all' },
    { text: '這一步的標題改成第三季', scope: 'this-step' },
  ] }));
  const run = runner.startRun('測試', 'wf', {});
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.status, 'waiting_review');
  runner.edit('測試', 'wf', run.run_id, 'a', '改過的彙總', '金額改千元');
  r = await runner.deriveEditRules('測試', 'wf', run.run_id, 'a'); // 伺服器的順序：改→擬規則→放行
  runner.resume('測試', 'wf', run.run_id);
  assert.deepEqual(r.steps.a.edit_rules, [
    { text: '金額一律用千元', scope: 'all' },
    { text: '這一步的標題改成第三季', scope: 'this-step' },
  ]);
  const rulesCall = adapter.calls.find((c) => c.meta?.kind === 'edit-rules');
  assert.equal(rulesCall.meta.node, 'a');
  assert.ok(rulesCall.prompt.includes('改過的彙總'), '擬規則要看得到改過的版本');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  for (const nid of ['b', 'c']) {
    assert.deepEqual(workerCalls(adapter, nid)[0].editRules, ['金額一律用千元'], `${nid} 只吃 scope=all 的那條`);
    assert.ok(checkCalls(adapter, nid)[0].checkPrompt.includes('- 金額一律用千元'), `${nid} 的查核必守也要有這條`);
  }
  assert.deepEqual(workerCalls(adapter, 'a')[0].editRules, [], '規則是給下游的，自己那一步不吃');
});

test('查核輪：產檔步驟拿真檔裡的字去查，attempt 記檔名與大小；檔案讀不出來＝這次沒查', async () => {
  const def = structuredClone(LINEAR3);
  def.permissions = { files: true };
  def.nodes[0].output_file = 'docx';
  const { runner, adapter } = setup(def);
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('成品全文：總數 14 件')] })] }] });
  const buf = await Packer.toBuffer(doc);
  adapter.setFileWriter((fm) => (fm.fileName.endsWith('.docx') ? buf : false));
  adapter.setCheckResponse(CHECK_PASS);
  const run = runner.startRun('測試', 'wf', {});
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  const p = checkCalls(adapter, 'a')[0].checkPrompt;
  assert.ok(p.includes('成品全文：總數 14 件'), '查核看的是 Word 檔裡的字，不是工人的文字摘要');
  assert.equal(r.steps.a.file, 'A.docx');
  assert.deepEqual(r.steps.a.attempts[0].file, { name: 'A.docx', size: buf.length });

  adapter.setFileWriter(() => Buffer.from('不是真的 docx'));
  const run2 = runner.startRun('測試', 'wf', {});
  const r2 = await runner.runUntilPause('測試', 'wf', run2.run_id);
  assert.equal(checkCalls(adapter, 'a').length, 1, '檔案讀不出來就不必問查核員');
  assert.equal(r2.steps.a.check.status, 'incomplete');
  assert.equal(r2.steps.a.check.note, '成品檔讀不出來，這次沒查');
  assert.equal(r2.steps.a.status, 'done', '查不成不擋交貨');
});

test('查核輪：重做那次沒重寫產檔 → 不拿上一輪的舊檔當這次的成品；重做不再查，記 redone、檔走既有退路存成 .md', async () => {
  const def = structuredClone(LINEAR3);
  def.permissions = { files: true };
  def.nodes[0].output_file = 'docx';
  const { runner, adapter } = setup(def);
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('檔裡的字：總數 14 件')] })] }] });
  const buf = await Packer.toBuffer(doc);
  let wrote = 0;
  adapter.setFileWriter(() => (wrote++ === 0 ? buf : false)); // 只有第一次交卷寫檔，重做那次只回文字、不碰檔
  adapter.setOutput('a', '第一份文字'); // 用一次即清，重做那次回預設的「產出:a」
  adapter.setCheckResponse((n, meta) => (meta.node === 'a' ? CHECK_BLOCKED : CHECK_PASS));
  const run = runner.startRun('測試', 'wf', {});
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(checkCalls(adapter, 'a').length, 1, '重做那份不再查');
  assert.ok(checkCalls(adapter, 'a')[0].checkPrompt.includes('檔裡的字：總數 14 件'), '第一次查的是檔裡的字');
  assert.equal(r.steps.a.check.status, 'redone');
  assert.equal(r.steps.a.status, 'done');
  assert.deepEqual(r.steps.a.attempts[0].file, { name: 'A.docx', size: buf.length }, '第一次那份是真的交出來的');
  assert.equal(r.steps.a.attempts[1].file, undefined, '重做那次沒交出檔');
  assert.equal(r.steps.a.file, 'A.md', '走既有退路：文字產出先存成 .md');
  assert.ok(r.steps.a.file_note.includes('工人沒交出'), r.steps.a.file_note);
});

const MIXED_CHECK = {
  format: 1,
  name: '結構節點混合',
  params: [],
  nodes: [
    { id: 'f', title: '分頭做', kind: 'fork', next: ['p1', 'p2'] },
    { id: 'p1', title: 'P1', executor: 'ai', stop_point: 'never', instruction: '做 P1', next: ['j'] },
    { id: 'p2', title: 'P2', executor: 'ai', stop_point: 'never', instruction: '做 P2', next: ['j'] },
    { id: 'j', title: '會合', kind: 'join', next: ['br'] },
    { id: 'br', title: '判路', kind: 'branch', instruction: '選一條', branches: [{ label: '高', next: 'man' }, { label: '低', next: 'man2' }], next: [] },
    { id: 'man', title: '人做收尾', executor: 'human', stop_point: 'always', instruction: '你來收尾', next: [] },
    { id: 'man2', title: '人做收尾二', executor: 'human', stop_point: 'always', instruction: '你來收尾', next: [] },
  ],
};

// ---- （補件）：查核員與擬規則的指示也進卷宗，存的全文＝送出的全文 ----

test('查核輪：查核員的指示進卷宗（check1），全文＝送給查核員的那份、含成品', async () => {
  const { runner, adapter, store } = setup();
  adapter.setCheckResponse(CHECK_PASS);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const records = store.listPromptRecords('測試', 'wf', run.run_id);
  assert.ok(records.includes('a.check1.txt'), `卷宗要有查核指示：${records}`);
  const text = store.readPromptRecord('測試', 'wf', run.run_id, 'a.check1.txt');
  assert.ok(text.includes('# 成品'), `查核指示要有成品段：${text}`);
  assert.ok(text.includes('產出:a'), '成品全文要看得到');
  assert.equal(text, checkCalls(adapter, 'a')[0].checkPrompt, '卷宗存的全文＝送出的全文');
  assert.ok(!records.includes('a.check2.txt'), '一次就過，沒有第二份查核');
});

test('查核輪：重做那份不再查，卷宗只有 check1（沒有 check2）；舊趟回話重做的重跑照工人卷宗同一套編號原地覆蓋', async () => {
  const { runner, adapter, store } = setup();
  adapter.setCheckResponse((n, meta) => (meta.node === 'a' && n === 1 ? CHECK_BLOCKED : CHECK_PASS));
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.deepEqual(
    store.listPromptRecords('測試', 'wf', run.run_id).filter((x) => x.startsWith('a.')),
    ['a.check1.txt', 'a.redo1.txt', 'a.txt'],
    '工人兩份（第一次＋重做）、查核一份（只查第一份成品）',
  );
  assert.equal(store.readPromptRecord('測試', 'wf', run.run_id, 'a.check1.txt'), checkCalls(adapter, 'a')[0].checkPrompt);

  // 舊趟的「回話重做」重跑：工人卷宗本來就是 a.txt／a.redo1.txt 原地覆蓋，查核卷宗照同一套編號，不另開 check2
  ageIntoWaitingCheck(store, run.run_id, 'a');
  runner.checkRetry('測試', 'wf', run.run_id, 'a', '總數請照明細重算');
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.deepEqual(
    store.listPromptRecords('測試', 'wf', run.run_id).filter((x) => x.startsWith('a.')),
    ['a.check1.txt', 'a.redo1.txt', 'a.txt'],
    '重跑不新增編號',
  );
  assert.equal(
    store.readPromptRecord('測試', 'wf', run.run_id, 'a.check1.txt'),
    checkCalls(adapter, 'a')[1].checkPrompt,
    '重跑的第一次查核覆蓋 check1，與工人的 a.txt 同一套編號',
  );
});

//：卷宗只存指示不存回覆，真跑遇到一次「查核員交了不只一份結果」就再也查不出為什麼
test('查核輪：查核沒查成時回覆原文另存 check1.reply.txt；查成了就不留', async () => {
  const { runner, adapter, store } = setup();
  adapter.setCheckResponse('我看不懂這一步要查什麼');
  const run = runner.startRun('測試', 'wf', {});
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.check.status, 'incomplete');
  const records = store.listPromptRecords('測試', 'wf', run.run_id).filter((x) => x.startsWith('a.'));
  assert.deepEqual(records, ['a.check1.reply.txt', 'a.check1.txt', 'a.txt'], `卷宗要多一份回覆原文：${records}`);
  assert.equal(store.readPromptRecord('測試', 'wf', run.run_id, 'a.check1.reply.txt'), '我看不懂這一步要查什麼');
  assert.equal(r.steps.a.check.raw, undefined, '原文只進卷宗，不塞進執行紀錄');

  const clean = setup();
  clean.adapter.setCheckResponse(CHECK_PASS);
  const run2 = clean.runner.startRun('測試', 'wf', {});
  await clean.runner.runUntilPause('測試', 'wf', run2.run_id);
  const kept = clean.store.listPromptRecords('測試', 'wf', run2.run_id);
  // 監工的回覆原文一律留（_brief／_record／*.handoff），這裡只管查核員那幾份
  assert.ok(!kept.some((x) => x.includes('.check') && x.endsWith('.reply.txt')), `查成了就沒有查核回覆原文檔：${kept}`);
});

test('查核輪：擬規則的指示進卷宗（edit-rules.txt），全文＝送出的那份', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].stop_point = 'always';
  const { runner, adapter, store } = setup(def);
  adapter.setCheckResponse(CHECK_PASS);
  adapter.setEditRulesResponse(JSON.stringify({ rules: [{ text: '金額一律用千元', scope: 'all' }] }));
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  runner.edit('測試', 'wf', run.run_id, 'a', '改過的彙總', '金額改千元');
  await runner.deriveEditRules('測試', 'wf', run.run_id, 'a');
  runner.resume('測試', 'wf', run.run_id);
  const records = store.listPromptRecords('測試', 'wf', run.run_id);
  assert.ok(records.includes('a.edit-rules.txt'), `卷宗要有擬規則指示：${records}`);
  const text = store.readPromptRecord('測試', 'wf', run.run_id, 'a.edit-rules.txt');
  assert.equal(text, adapter.calls.find((c) => c.meta?.kind === 'edit-rules').prompt, '卷宗存的全文＝送出的全文');
  assert.ok(text.includes('改過的彙總'), '改過的版本要在卷宗裡');
});

test('查核輪：並行點、會合、分岔、人做步驟一律不查（記 skipped）；並行支上的 AI 步驟照查', async () => {
  const { runner, adapter } = setup(MIXED_CHECK);
  adapter.setCheckResponse(CHECK_PASS);
  adapter.setHandoffReply('{"route":"1"}');
  const run = runner.startRun('測試', 'wf', {});
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.man.status, 'waiting_human');
  for (const nid of ['f', 'j', 'br', 'man']) assert.equal(r.steps[nid].check.status, 'skipped', nid);
  assert.deepEqual(checkCalls(adapter).map((c) => c.meta.node).sort(), ['p1', 'p2'], '只查真的做出東西的 AI 步驟');
});

test('查核輪：setEditRules 整份覆寫——丟掉空文字、scope 看不懂就退成 all；格式不對／步驟不存在 400 人話', async () => {
  const { runner } = setup();
  const run = runner.startRun('測試', 'wf', {});
  const r = runner.setEditRules('測試', 'wf', run.run_id, 'a', [
    { text: '  金額用千元  ', scope: 'this-step' },
    { text: '   ', scope: 'all' }, // 空文字丟掉
    { text: '語氣正式', scope: '亂寫的' }, // 看不懂的 scope 退成 all
  ]);
  assert.deepEqual(r.steps.a.edit_rules, [
    { text: '金額用千元', scope: 'this-step' },
    { text: '語氣正式', scope: 'all' },
  ]);
  assert.throws(() => runner.setEditRules('測試', 'wf', run.run_id, 'a', '不是陣列'), /格式不對/);
  assert.throws(() => runner.setEditRules('測試', 'wf', run.run_id, '沒這步', []), /找不到步驟/);
});

// ===== 三個接線點（開場、交接、收尾）＋派工覆寫＋插話 =====

const supCalls = (adapter, phase, nodeId) =>
  adapter.calls.filter((c) => c.meta?.kind === 'supervisor' && c.meta.phase === phase && (!nodeId || c.meta.node === nodeId));

test('監工開場：開跑前先寫開場備註，卷宗存指示與回覆兩份，用量歸戶 _brief', async () => {
  const { runner, adapter, store } = setup();
  adapter.setBriefReply('{"note":"總表 14 件"}');
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const r = store.readRun('測試', 'wf', run.run_id);
  assert.equal(r.brief.text, '總表 14 件');
  assert.ok(r.brief.at, '開場備註要記時間');
  const records = store.listPromptRecords('測試', 'wf', run.run_id);
  assert.ok(records.includes('_brief.txt') && records.includes('_brief.reply.txt'), `${records}`);
  const bc = supCalls(adapter, 'brief')[0];
  assert.equal(bc.meta.node, '_brief');
  assert.equal(bc.meta.run, run.run_id);
  assert.equal(store.readPromptRecord('測試', 'wf', run.run_id, '_brief.txt'), bc.prompt, '卷宗存的全文＝送出的全文');
  assert.equal(store.readPromptRecord('測試', 'wf', run.run_id, '_brief.reply.txt'), '{"note":"總表 14 件"}');
});

test('監工開場：流程把監工關掉 → 沒有開場備註、一次都不問監工', async () => {
  const def = structuredClone(LINEAR3);
  def.supervisor = { enabled: false };
  const { runner, adapter, store } = setup(def);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(store.readRun('測試', 'wf', run.run_id).brief, undefined);
  assert.equal(supCalls(adapter, 'brief').length, 0);
});

test('監工開場：監工沒寫成 → 備註留空、原因講人話，流程照跑到停點', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].stop_point = 'always';
  const { runner, adapter, store } = setup(def);
  adapter.setBriefReply(() => { throw new Error('連不上 Claude（測試注入）'); });
  const run = runner.startRun('測試', 'wf', {});
  const paused = await runner.runUntilPause('測試', 'wf', run.run_id);
  const r = store.readRun('測試', 'wf', run.run_id);
  assert.equal(r.brief.text, '');
  assert.ok(r.brief.fail_note.includes('監工這次沒寫成'), r.brief.fail_note);
  assert.equal(paused.status, 'paused');
  assert.equal(r.steps.a.status, 'waiting_review', '監工掛掉不擋流程');
});

test('監工開場：已經跑完的 run 被再推一次，不會補問一次開場備註', async () => {
  const { runner, adapter, store } = setup();
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  // 本功能上線前跑完的舊 run：狀態是 done、身上沒有開場備註。
  // 被 resume 或 GET 的自癒路徑再 kick 一次時，不該白問監工一次、多寫一份 _brief 卷宗
  const done = store.readRun('測試', 'wf', run.run_id);
  assert.equal(done.status, 'done');
  delete done.brief;
  store.writeRun('測試', 'wf', run.run_id, done);
  const before = supCalls(adapter, 'brief').length;
  const again = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(again.brief, undefined, '已完成的 run 不補寫開場備註');
  assert.equal(store.readRun('測試', 'wf', run.run_id).brief, undefined);
  assert.equal(supCalls(adapter, 'brief').length, before, '不會多問監工一次');
});

test('監工交接：第一層步驟不問、後面每步問一次；工人拿到開場＋交接兩條', async () => {
  const { runner, adapter, store } = setup();
  adapter.setBriefReply('{"note":"總表 14 件"}');
  adapter.setHandoffReply('{"note":"按三類分節","tier":null,"web":null,"route":null}');
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(supCalls(adapter, 'handoff', 'a').length, 0, '第一步沒有上游，只帶開場備註');
  assert.deepEqual(workerCalls(adapter, 'a')[0].supervisorNotes, ['開場：總表 14 件']);
  assert.deepEqual(workerCalls(adapter, 'b')[0].supervisorNotes, ['開場：總表 14 件', '交接：按三類分節']);
  const r = store.readRun('測試', 'wf', run.run_id);
  assert.equal(r.steps.b.handoff.text, '按三類分節');
  assert.equal(r.steps.b.handoff.route, null, 'task 節點不吃 route');
  const records = store.listPromptRecords('測試', 'wf', run.run_id);
  assert.ok(records.includes('b.handoff.txt') && records.includes('b.handoff.reply.txt'), `${records}`);
});

test('監工交接：三個勾全關的步驟不問監工，工人只拿到開場備註', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[1].supervisor = { note: false, tier: false, tools: false };
  const { runner, adapter, store } = setup(def);
  adapter.setBriefReply('{"note":"總表 14 件"}');
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(supCalls(adapter, 'handoff', 'b').length, 0);
  assert.deepEqual(workerCalls(adapter, 'b')[0].supervisorNotes, ['開場：總表 14 件']);
  assert.equal(store.readRun('測試', 'wf', run.run_id).steps.b.handoff, undefined);
});

test('監工交接：上游停點擬出來的規則原文進「生效的規矩」段', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].stop_point = 'always';
  const { runner, adapter } = setup(def);
  adapter.setCheckResponse(CHECK_PASS);
  adapter.setEditRulesResponse(JSON.stringify({ rules: [{ text: '金額一律用千元', scope: 'all' }] }));
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  runner.edit('測試', 'wf', run.run_id, 'a', '改過的彙總', '金額改千元');
  await runner.deriveEditRules('測試', 'wf', run.run_id, 'a');
  runner.resume('測試', 'wf', run.run_id);
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const hb = supCalls(adapter, 'handoff', 'b')[0];
  assert.ok(hb.prompt.includes('# 生效的規矩'), hb.prompt);
  assert.ok(hb.prompt.includes('- 金額一律用千元'), hb.prompt);
});

test('監工派工：勾了才算數——調檔位換模型、關查網；沒勾的照節點原設定，交接欄位強制留空', async () => {
  const withFlags = async (supervisor) => {
    const def = structuredClone(LINEAR3);
    def.nodes[1].model_tier = 'fast';
    def.nodes[1].supervisor = supervisor;
    const { runner, adapter, store } = setup(def);
    adapter.setHandoffReply('{"note":"x","tier":"deep","web":false,"route":null}');
    const run = runner.startRun('測試', 'wf', {});
    await runner.runUntilPause('測試', 'wf', run.run_id);
    return { call: workerCalls(adapter, 'b')[0], run: store.readRun('測試', 'wf', run.run_id) };
  };
  const on = await withFlags({ tier: true, tools: true });
  assert.equal(on.call.model, 'opus', '勾了調檔位＝聽監工的');
  assert.equal(on.call.web, false);
  assert.equal(on.run.steps.b.handoff.tier, 'deep');
  assert.equal(on.run.steps.b.handoff.web, false);

  const off = await withFlags({ tier: false, tools: false });
  assert.equal(off.call.model, 'haiku', '沒勾＝照節點自己的檔位');
  assert.equal(off.call.web, true);
  assert.equal(off.run.steps.b.handoff.tier, null);
  assert.equal(off.run.steps.b.handoff.web, null);
});

test('監工關掉：分岔照樣判路（判路不歸監工開關管），選不出來仍停下問人', async () => {
  const def = {
    format: 1,
    name: '關監工的分岔',
    params: [],
    supervisor: { enabled: false },
    nodes: [
      { id: 's', title: '起步', executor: 'ai', stop_point: 'never', instruction: '算金額', next: ['br'] },
      { id: 'br', title: '判金額', kind: 'branch', instruction: '超過五千走高', branches: [{ label: '高', next: 'h' }, { label: '低', next: 'l' }], next: [] },
      { id: 'h', title: '高路', executor: 'ai', stop_point: 'never', instruction: '走高', next: [] },
      { id: 'l', title: '低路', executor: 'ai', stop_point: 'never', instruction: '走低', next: [] },
    ],
  };
  const { runner, adapter, store } = setup(def);
  adapter.setHandoffReply('{"route":"2"}');
  const done = await (async () => {
    const run = runner.startRun('測試', 'wf', {});
    const d = await runner.runUntilPause('測試', 'wf', run.run_id);
    return { d, r: store.readRun('測試', 'wf', run.run_id) };
  })();
  assert.equal(done.d.steps.br.choice, 'l', 'route 2＝第二條路');
  assert.equal(done.d.steps.br.choice_by, 'ai');
  assert.equal(done.r.steps.br.handoff.route, '2');
  assert.equal(done.r.steps.br.handoff.only_route, true, '監工關掉時分岔只寫 route');
  assert.equal(done.r.brief, undefined);
  assert.equal(done.r.record, undefined);

  const s2 = setup(def);
  s2.adapter.setHandoffReply('{"route":null}');
  const run2 = s2.runner.startRun('測試', 'wf', {});
  const paused = await s2.runner.runUntilPause('測試', 'wf', run2.run_id);
  assert.equal(paused.steps.br.status, 'waiting_branch');
  s2.runner.chooseBranch('測試', 'wf', run2.run_id, 'br', 'h');
  const done2 = await s2.runner.runUntilPause('測試', 'wf', run2.run_id);
  assert.equal(done2.status, 'done');
  assert.equal(done2.steps.br.choice_by, 'user');
});

test('監工插話：停點交代的話進下一步的交接，消化後標 consumed；空話擋下', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].stop_point = 'always';
  const { runner, adapter, store } = setup(def);
  adapter.setCheckResponse(CHECK_PASS);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const after = runner.interject('測試', 'wf', run.run_id, 'a', '報告也要提退貨');
  assert.equal(after.interjections[0].consumed, false);
  assert.equal(after.interjections[0].node, 'a');
  assert.throws(() => runner.interject('測試', 'wf', run.run_id, 'a', '   '), /要先寫一句要交代的話/);
  runner.approve('測試', 'wf', run.run_id, 'a');
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const hb = supCalls(adapter, 'handoff', 'b')[0];
  assert.ok(hb.prompt.includes('# 使用者剛交代的話'), hb.prompt);
  assert.ok(hb.prompt.includes('報告也要提退貨'), hb.prompt);
  assert.equal(store.readRun('測試', 'wf', run.run_id).interjections[0].consumed, true);
});

test('監工插話：中間卡著分岔也不會被吃掉——分岔看得到但不算消化，真正做事的下一步才收', async () => {
  const def = {
    format: 1,
    name: '停點後接分岔',
    params: [],
    nodes: [
      { id: 'a', title: '整理', executor: 'ai', stop_point: 'always', instruction: '整理', next: ['br'] },
      { id: 'br', title: '判量', kind: 'branch', instruction: '超過十件走詳版', branches: [{ label: '詳版', next: 'b' }, { label: '簡版', next: 'c' }], next: [] },
      { id: 'b', title: '詳版', executor: 'ai', stop_point: 'never', instruction: '寫詳版', next: [] },
      { id: 'c', title: '簡版', executor: 'ai', stop_point: 'never', instruction: '寫簡版', next: [] },
    ],
  };
  const { runner, adapter, store } = setup(def);
  adapter.setCheckResponse(CHECK_PASS);
  adapter.setHandoffReply('{"note":"照三類分節","tier":null,"web":null,"route":"1"}');
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  runner.interject('測試', 'wf', run.run_id, 'a', '報告也要提退貨');
  runner.approve('測試', 'wf', run.run_id, 'a');
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.ok(supCalls(adapter, 'handoff', 'br')[0].prompt.includes('報告也要提退貨'), '分岔選路時看得到');
  assert.ok(supCalls(adapter, 'handoff', 'b')[0].prompt.includes('報告也要提退貨'), '真正做事的下一步才是要收到的人');
  assert.equal(store.readRun('測試', 'wf', run.run_id).interjections[0].consumed, true);
});

test('監工收尾：跑完寫執行紀錄——對應表、用量、建議都在；回傳值就是寫完紀錄的那份', async () => {
  const { runner, adapter, store } = setup();
  const run = runner.startRun('測試', 'wf', {});
  adapter.setHandoffReply('{"note":"按三類分節","tier":null,"web":null,"route":null}');
  const at = new Date().toISOString();
  const row = { at, category: '測試', workflow: 'wf', run: run.run_id };
  // 真 adapter 的用量 sink 在 complete() resolve 之前就同步把這一筆 append 進帳本，假的照做
  adapter.setRecordReply(() => {
    store.appendUsage({ ...row, kind: 'supervisor', node: '_record', input_tokens: 7, output_tokens: 3 });
    return JSON.stringify({
      text: '三步都跑完了',
      suggestions: [{ node: 'b', where: 'instruction', text: '把分節寫進指示' }],
    });
  });
  store.appendUsage({ ...row, kind: 'supervisor', node: '_brief', input_tokens: 30, output_tokens: 3 });
  store.appendUsage({ ...row, kind: 'step', node: 'b', input_tokens: 100, output_tokens: 10 });
  store.appendUsage({ ...row, kind: 'check', node: 'b', input_tokens: 50, output_tokens: 5 });
  const final = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.ok(final.record, 'runUntilPause 要回傳寫完紀錄的那份');
  const r = store.readRun('測試', 'wf', run.run_id);
  assert.equal(r.record.table.length, 3);
  assert.deepEqual(r.record.table[1].upstream, ['a']);
  assert.equal(r.record.table[1].handoff, '按三類分節');
  assert.equal(r.record.table[1].usage.calls, 2, '這一步的工人＋查核兩筆');
  assert.deepEqual(r.record.usage.brief, { input: 30, output: 3, calls: 1 });
  // 收尾這次呼叫自己的用量也要算進去——先算後問會漏掉整趟最貴的一筆，使用者看到的數字就偏低
  assert.deepEqual(r.record.usage.record, { input: 7, output: 3, calls: 1 });
  assert.deepEqual(r.record.usage.total, { input: 187, output: 21, calls: 4 }, '總計含收尾自己那筆');
  assert.equal(r.record.text, '三步都跑完了');
  assert.equal(r.record.suggestions[0].where, 'instruction');
  const sc = supCalls(adapter, 'record')[0];
  assert.equal(sc.meta.node, '_record');
  const records = store.listPromptRecords('測試', 'wf', run.run_id);
  assert.ok(records.includes('_record.txt') && records.includes('_record.reply.txt'), `${records}`);
});

test('監工收尾：跑到停點時還沒有紀錄；監工關掉時永遠不寫紀錄', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].stop_point = 'always';
  const { runner, store } = setup(def);
  const run = runner.startRun('測試', 'wf', {});
  const paused = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.record, undefined, '停點不寫紀錄');
  assert.equal(store.readRun('測試', 'wf', run.run_id).record, undefined);

  const def2 = structuredClone(LINEAR3);
  def2.supervisor = { enabled: false };
  const s2 = setup(def2);
  const run2 = s2.runner.startRun('測試', 'wf', {});
  const done = await s2.runner.runUntilPause('測試', 'wf', run2.run_id);
  assert.equal(done.status, 'done');
  assert.equal(s2.store.readRun('測試', 'wf', run2.run_id).record, undefined);
});

test('監工收尾：監工沒寫成 → 紀錄講人話原因，對應表與用量照樣留著', async () => {
  const { runner, adapter, store } = setup();
  const run = runner.startRun('測試', 'wf', {});
  const row = { at: new Date().toISOString(), category: '測試', workflow: 'wf', run: run.run_id };
  store.appendUsage({ ...row, kind: 'step', node: 'b', input_tokens: 100, output_tokens: 10 });
  // 回覆解析不出來也是一次真的呼叫，token 照花——帳照記，紀錄格的數字要含它
  adapter.setRecordReply(() => {
    store.appendUsage({ ...row, kind: 'supervisor', node: '_record', input_tokens: 7, output_tokens: 3 });
    return '我不知道要寫什麼';
  });
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const r = store.readRun('測試', 'wf', run.run_id);
  assert.ok(r.record.text.includes('監工這次沒寫成'), r.record.text);
  assert.ok(r.record.fail_note.includes('監工這次沒寫成'));
  assert.deepEqual(r.record.suggestions, []);
  assert.equal(r.record.table.length, 3);
  assert.deepEqual(r.record.usage.record, { input: 7, output: 3, calls: 1 });
  assert.deepEqual(r.record.usage.total, { input: 107, output: 13, calls: 2 });
});

test('監工交接一步只問一次：被查核退回重做、舊趟的回話重做都沿用同一份交接', async () => {
  const { runner, adapter, store } = setup();
  adapter.setCheckResponse((n, meta) => (meta.node === 'b' ? CHECK_BLOCKED : CHECK_PASS));
  const run = runner.startRun('測試', 'wf', {});
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.steps.b.check.status, 'redone');
  assert.equal(done.status, 'done');
  assert.equal(workerCalls(adapter, 'b').length, 2, '攔下重做一次');
  assert.equal(supCalls(adapter, 'handoff', 'b').length, 1, '重做不重問監工');
  ageIntoWaitingCheck(store, run.run_id, 'b');
  runner.checkRetry('測試', 'wf', run.run_id, 'b', '這次要照三類分');
  adapter.setCheckResponse(CHECK_PASS);
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(store.readRun('測試', 'wf', run.run_id).status, 'done');
  assert.equal(supCalls(adapter, 'handoff', 'b').length, 1, '回話重做也不重問監工');
});

// ---- 開跑收三個記憶欄位寫 run.memory；記路①（開跑同值連兩趟）在 startRun 後由門面判 ----

test('M2 startRun：memoryPicks／memoryChanged／memoryIdentity 寫進 run.memory；沒給＝空殼；memory 省略照舊', () => {
  const { runner, store } = setup();
  const run = runner.startRun('測試', 'wf', {}, { memoryPicks: { range: 'h-1' }, memoryChanged: ['h-2'], memoryIdentity: 'i-1' });
  assert.equal(run.memory.picks.range, 'h-1');
  assert.equal(run.memory.identity, 'i-1');
  assert.deepEqual(run.memory.changed, ['h-2']);
  assert.deepEqual(run.memory.notices, []);
  assert.deepEqual(store.readRun('測試', 'wf', run.run_id).memory, run.memory, '落地的跟回傳的一樣');
  assert.equal(run.memory.prev_run, null, '第一趟沒有前一趟');
  const bare = runner.startRun('測試', 'wf', {});
  assert.deepEqual(bare.memory, { identity: null, picks: {}, changed: [], prev_run: run.run_id, notices: [] });
});

test('M2 記路①：同一個值非預設連兩趟開跑→一張習慣卡（用在這條流程、出處 run-params）＋通知 card；第一趟、等於預設、已有同卡都不記', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-runner-'));
  const store = createStore(dir);
  store.writeWorkflow('測試', 'wf', { ...LINEAR3, params: [{ key: 'range', label: '年度區間', default: '本季' }] }); // 刻意用出廠詞典沒有的欄位名，才驗得到「不在詞典就先長出來」
  const adapter = fakeAdapter();
  const memory = createMemory({ store, adapter });
  const runner = createRunner({ store, adapter, memory });
  const r1 = runner.startRun('測試', 'wf', { range: '今年' });
  assert.deepEqual(store.listCards('habit'), [], '第一趟沒有前一趟可比');
  assert.deepEqual(r1.memory.notices, []);
  const r2 = runner.startRun('測試', 'wf', { range: '今年' });
  const cards = store.listCards('habit');
  assert.equal(cards.length, 1, '連兩趟同值→一張');
  const c = cards[0];
  assert.equal(c.field, '年度區間');
  assert.equal(c.text, '今年');
  assert.deepEqual(c.scope, { level: 'workflow', category: '測試', workflow: 'wf' });
  assert.equal(c.source.kind, 'run-params');
  assert.equal(c.source.run, r2.run_id);
  assert.equal(c.source.quote, '（開跑表單）年度區間：今年');
  assert.ok(c.route_reason, '程式判的寫固定句');
  assert.deepEqual(store.readDict().fields.find((f) => f.name === c.field)?.origin, { category: '測試', workflow: 'wf' }, '欄位不在出廠詞典就先長出來，origin 記它從哪條流程長的');
  assert.equal(r2.memory.notices.length, 1);
  assert.equal(r2.memory.notices[0].kind, 'card');
  assert.equal(r2.memory.notices[0].card, c.id);
  assert.equal(r2.memory.notices[0].undone, false);
  assert.ok(r2.memory.notices[0].text.includes('今年'));
  assert.deepEqual(store.readRun('測試', 'wf', r2.run_id).memory.notices, r2.memory.notices, '回傳的 run 含門面剛寫的通知');
  // 第三趟：已有同欄位同內容的卡→不再記
  const r3 = runner.startRun('測試', 'wf', { range: '今年' });
  assert.equal(store.listCards('habit').length, 1);
  assert.deepEqual(r3.memory.notices, []);
  // 等於預設的值不記（兩趟都退回預設「本季」）
  runner.startRun('測試', 'wf', {});
  runner.startRun('測試', 'wf', {});
  assert.equal(store.listCards('habit').length, 1);
  // 這趟從卡點來的（picks）不記
  runner.startRun('測試', 'wf', { range: '去年' });
  runner.startRun('測試', 'wf', { range: '去年' }, { memoryPicks: { range: 'h-x' } });
  assert.equal(store.listCards('habit').length, 1);
});

test('M2 startRun：前一趟依 started_at 判——同秒兩趟 id 字典序與開跑時間相反，prev_run 取開跑較晚那筆；壞掉的 run.yaml 跳過', () => {
  const { dir, runner, store } = setup();
  // 同一秒兩趟（放在過去，讓真時鐘開的第三趟一定比它們晚）：id 亂數尾碼 aaaa < zzzz，但 aaaa 開得比較晚（清單尾端 .at(-1) 會選錯成 zzzz）
  const early = { run_id: 'r-20260101-120000-zzzz', status: 'done', params: { range: '去年' }, started_at: '2026-01-01T04:00:00.100Z', steps: {} };
  const late = { run_id: 'r-20260101-120000-aaaa', status: 'done', params: { range: '今年' }, started_at: '2026-01-01T04:00:00.900Z', steps: {} };
  store.writeRun('測試', 'wf', early.run_id, early);
  store.writeRun('測試', 'wf', late.run_id, late);
  const r3 = runner.startRun('測試', 'wf', {});
  assert.equal(r3.memory.prev_run, 'r-20260101-120000-aaaa', '選 started_at 最大的，不是 id 字典序最後的');
  // 清單尾端有讀不出來的 run.yaml（壞檔、id 排最後）→跳過，取其餘裡開跑最晚的（＝第三趟）
  const badDir = path.join(dir, 'workflows', '測試', 'wf', 'runs', 'r-99999999-000000-bad');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'run.yaml'), ':\n  - [broken', 'utf8');
  const r4 = runner.startRun('測試', 'wf', {});
  assert.equal(r4.memory.prev_run, r3.run_id, '第四趟的前一趟＝第三趟，壞檔不算');
});

test('M2 startRun：memory.onRunStart 丟錯→run 照樣建立、照樣回傳', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-runner-'));
  const store = createStore(dir);
  store.writeWorkflow('測試', 'wf', LINEAR3);
  const runner = createRunner({ store, adapter: fakeAdapter(), memory: { onRunStart() { throw new Error('記憶炸了（測試注入）'); } } });
  const run = runner.startRun('測試', 'wf', { range: '今年' });
  assert.ok(run.run_id);
  assert.equal(store.readRun('測試', 'wf', run.run_id).status, 'running');
  assert.deepEqual(run.memory.notices, []);
});

// ---- 每步工作單帶「關於你」與群組規矩、查核必守含群組規矩、steps[n].memory、設定缺省接線 ----

function setupMemory(def = LINEAR3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-runner-'));
  const store = createStore(dir);
  store.writeWorkflow('測試', 'wf', def);
  const adapter = fakeAdapter();
  const memory = createMemory({ store, adapter });
  const runner = createRunner({ store, adapter, memory });
  return { dir, store, adapter, memory, runner };
}
const PROFILE = (over) => makeCard({ bucket: 'profile', text: 'x', layer: 'expression', scope: { level: 'all' }, source: { kind: 'manual', quote: 'x' }, ...over });
const HABIT = (over) => makeCard({ bucket: 'habit', text: 'x', field: '範圍', scope: { level: 'workflow', category: '測試', workflow: 'wf' }, source: { kind: 'manual', quote: 'x' }, ...over });
// 塞兩張認識卡（一表達、一內容 scope=分類）＋群組檔一條
function seedMemory(store) {
  store.writeCard(PROFILE({ text: '不要恭維' }));
  store.writeCard(PROFILE({ text: '我是這家公司的負責人', layer: 'content', scope: { level: 'category', category: '測試' } }));
  store.writeGroup('測試', { text: '不提競品', rules: parseGroupText('不提競品', store.readDict()) });
}
const mustsOf = (p) => p.slice(p.indexOf('# 必守（逐條對）'), p.indexOf('# 格式要求'));

test('M3a 注入：兩張認識卡＋群組一條→工人收到 coreNotes 兩句、groupRules 一條、groupName＝分類；steps.a.memory 三張、overridden 空；查核必守含群組規矩；分岔不寫 memory', async () => {
  const def = {
    format: 1,
    name: '帶分岔',
    params: [],
    nodes: [
      { id: 'a', title: '起步', executor: 'ai', stop_point: 'never', instruction: '算金額', role_context: '你是分析師', next: ['br'] },
      { id: 'br', title: '判金額', kind: 'branch', instruction: '超過五千走高', branches: [{ label: '高', next: 'h' }, { label: '低', next: 'l' }], next: [] },
      { id: 'h', title: '高路', executor: 'ai', stop_point: 'never', instruction: '走高', next: [] },
      { id: 'l', title: '低路', executor: 'human', stop_point: 'never', instruction: '你來走低', next: [] },
    ],
  };
  const { runner, adapter, store } = setupMemory(def);
  seedMemory(store);
  adapter.setHandoffReply('{"note":"x","tier":null,"web":null,"route":"1"}');
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const a = workerCalls(adapter, 'a')[0];
  assert.deepEqual(a.coreNotes, ['不要恭維', '我是這家公司的負責人']);
  assert.deepEqual(a.groupRules, ['不提競品']);
  assert.equal(a.groupName, '測試');
  const h = workerCalls(adapter, 'h')[0];
  assert.deepEqual(h.coreNotes, ['不要恭維', '我是這家公司的負責人'], '每一步都帶');
  assert.deepEqual(h.groupRules, ['不提競品']);
  const r = store.readRun('測試', 'wf', run.run_id);
  const m = r.steps.a.memory;
  assert.ok(m.at && !Number.isNaN(Date.parse(m.at)));
  assert.equal(m.cards.length, 3);
  assert.deepEqual(m.cards.map((c) => c.bucket), ['profile', 'profile', 'group']);
  assert.deepEqual(m.cards.map((c) => c.text), ['不要恭維', '我是這家公司的負責人', '不提競品']);
  assert.deepEqual(m.cards.map((c) => c.level), ['all', 'category', 'category']);
  assert.equal(m.cards[0].layer, 'expression');
  assert.equal(m.cards[1].layer, 'content');
  assert.equal(m.cards[2].field, null);
  assert.deepEqual(m.overridden, []);
  assert.equal(m.paused, false);
  assert.equal(r.steps.h.memory.cards.length, 3);
  assert.equal(r.steps.br.memory, undefined, '分岔節點不寫 memory');
  assert.equal(r.steps.l.memory, undefined, '人做步驟不寫 memory（沒跑到也沒有）');
  // 查核員：必守含群組規矩，不帶「關於你」
  const ck = checkCalls(adapter, 'a')[0].checkPrompt;
  assert.ok(mustsOf(ck).includes('- 不提競品'), mustsOf(ck));
  assert.ok(!ck.includes('不要恭維') && !ck.includes('關於你'), '查核員不帶關於你');
});

test('M3a 蓋掉：核心的有名字卡被群組蓋、群組條被流程欄位值蓋→工作單不帶、steps[n].memory.overridden 記誰蓋的；被選的習慣卡只進引用它的那一步的 cards', async () => {
  const def = structuredClone(LINEAR3);
  def.params.push({ key: 'tone', label: '語氣', default: '' });
  def.nodes[1].instruction = '做B，語氣 {{tone}}';
  const { runner, adapter, store } = setupMemory(def);
  const namedCore = PROFILE({ text: '講話直接', field: '語氣' });
  store.writeCard(namedCore);
  store.writeCard(PROFILE({ text: '不要恭維' }));
  store.writeGroup('測試', { text: '語氣：輕鬆\n不提競品', rules: parseGroupText('語氣：輕鬆\n不提競品', store.readDict()) });
  const habit = HABIT({ text: '今年' });
  store.writeCard(habit);
  // 沒填 tone：群組的「語氣：輕鬆」蓋掉核心的「講話直接」
  const r1 = runner.startRun('測試', 'wf', { range: '今年' }, { memoryPicks: { range: habit.id } });
  await runner.runUntilPause('測試', 'wf', r1.run_id);
  const a = workerCalls(adapter, 'a')[0];
  assert.deepEqual(a.coreNotes, ['不要恭維']);
  assert.deepEqual(a.groupRules, ['語氣：輕鬆', '不提競品']);
  const s1 = store.readRun('測試', 'wf', r1.run_id).steps;
  assert.deepEqual(s1.a.memory.overridden, [{ id: namedCore.id, text: '講話直接', by: 'group', by_text: '輕鬆' }]);
  assert.deepEqual(s1.a.memory.cards.map((c) => c.id).includes(habit.id), true, 'a 引用 {{range}}：被選的習慣卡算進這一步');
  const pick = s1.a.memory.cards.find((c) => c.id === habit.id);
  assert.deepEqual(pick, { id: habit.id, bucket: 'habit', text: '今年', field: '範圍', level: 'workflow' });
  assert.equal(s1.b.memory.cards.some((c) => c.id === habit.id), false, 'b 沒引用 {{range}}：不算');
  assert.equal(s1.b.memory.cards.length, 3, '兩條群組＋一張自由核心');
  // 這一次填了 tone：流程這一圈的值蓋掉群組的「語氣：輕鬆」與核心的「講話直接」
  const r2 = runner.startRun('測試', 'wf', { tone: '正式' });
  await runner.runUntilPause('測試', 'wf', r2.run_id);
  const a2 = workerCalls(adapter, 'a')[1];
  assert.deepEqual(a2.groupRules, ['不提競品']);
  assert.deepEqual(a2.coreNotes, ['不要恭維']);
  const m2 = store.readRun('測試', 'wf', r2.run_id).steps.a.memory;
  assert.deepEqual(m2.overridden.map((o) => [o.text, o.by, o.by_text]), [['講話直接', 'run', '正式'], ['語氣：輕鬆', 'run', '正式']]);
  assert.equal(m2.cards.length, 2);
});

test('M3a 整層暫停：settings.memory.paused → coreNotes 空、steps.a.memory.paused=true、群組規矩照帶', async () => {
  const { runner, adapter, store } = setupMemory();
  seedMemory(store);
  store.writeSettings({ memory: { paused: true } });
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const a = workerCalls(adapter, 'a')[0];
  assert.deepEqual(a.coreNotes, []);
  assert.deepEqual(a.groupRules, ['不提競品']);
  const m = store.readRun('測試', 'wf', run.run_id).steps.a.memory;
  assert.equal(m.paused, true);
  assert.deepEqual(m.cards.map((c) => c.bucket), ['group'], '暫停只擋關於你，群組條照記');
});

test('M3a 身分：run.memory.identity 指到的身分→只帶它列的認識卡；找不到的身分＝不限縮', async () => {
  const { runner, adapter, store } = setupMemory();
  const p1 = PROFILE({ text: '不要恭維' });
  const p2 = PROFILE({ text: '用詞白話' });
  store.writeCard(p1);
  store.writeCard(p2);
  store.writeIdentities([{ id: 'i-1', name: '工作的我', cards: [p2.id], categories: [], created_at: '2026-09-09T00:00:00.000Z' }]);
  const r1 = runner.startRun('測試', 'wf', {}, { memoryIdentity: 'i-1' });
  await runner.runUntilPause('測試', 'wf', r1.run_id);
  assert.deepEqual(workerCalls(adapter, 'a')[0].coreNotes, ['用詞白話']);
  const r2 = runner.startRun('測試', 'wf', {}, { memoryIdentity: 'i-nope' });
  await runner.runUntilPause('測試', 'wf', r2.run_id);
  assert.deepEqual(workerCalls(adapter, 'a')[1].coreNotes, ['不要恭維', '用詞白話']);
});

test('M3a 記憶失敗不擋流程：contextFor 丟錯→工人照跑、兩段空、不寫 steps[n].memory；memory 省略→coreNotes／groupRules 是空清單', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-runner-'));
  const store = createStore(dir);
  store.writeWorkflow('測試', 'wf', LINEAR3);
  const adapter = fakeAdapter();
  const runner = createRunner({ store, adapter, memory: { onRunStart() {}, contextFor() { throw new Error('卡讀不到（測試注入）'); } } });
  const run = runner.startRun('測試', 'wf', {});
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  assert.deepEqual(workerCalls(adapter, 'a')[0].coreNotes, []);
  assert.deepEqual(workerCalls(adapter, 'a')[0].groupRules, []);
  assert.equal(r.steps.a.memory, undefined);
  const plain = setup();
  const run2 = plain.runner.startRun('測試', 'wf', {});
  await plain.runner.runUntilPause('測試', 'wf', run2.run_id);
  assert.deepEqual(workerCalls(plain.adapter, 'a')[0].coreNotes, []);
  assert.deepEqual(workerCalls(plain.adapter, 'a')[0].groupRules, []);
  assert.equal(plain.store.readRun('測試', 'wf', run2.run_id).steps.a.memory, undefined);
});

test('M3a 修正輪：真門面 contextFor 讀認識卡失敗→不 throw、coreNotes 空、群組規矩照帶、console.error 一句人話；接上 runner 工人只收群組條、steps.a.memory 只記群組條', async () => {
  const { store, adapter } = setupMemory();
  seedMemory(store);
  // 只有認識卡那本帳讀不到（習慣卡照舊，讓 onRunStart 的記路①不受影響）
  const broken = Object.assign(Object.create(store), {
    listCards(bucket, ...rest) { if (bucket === 'profile') throw new Error('磁碟炸了（測試注入）'); return store.listCards(bucket, ...rest); },
  });
  const memory = createMemory({ store: broken, adapter });
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  let ctx;
  try { ctx = memory.contextFor({ category: '測試', id: 'wf', def: LINEAR3, params: {} }); } finally { console.error = orig; }
  assert.deepEqual(ctx.coreNotes, []);
  assert.deepEqual(ctx.groupRules, ['不提競品']);
  assert.deepEqual(ctx.cards.map((c) => c.bucket), ['group']);
  assert.equal(ctx.paused, false, '不是暫停，是讀不到');
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('記憶卡讀不到') && logs[0].includes('磁碟炸了'), logs[0]);
  // 接上 runner（runner 用好的 store、記憶用壞的）：流程照跑、工人只收群組條
  const r2 = createRunner({ store, adapter, memory });
  const run = r2.startRun('測試', 'wf', {});
  await r2.runUntilPause('測試', 'wf', run.run_id);
  assert.deepEqual(workerCalls(adapter, 'a')[0].coreNotes, []);
  assert.deepEqual(workerCalls(adapter, 'a')[0].groupRules, ['不提競品']);
  const m = store.readRun('測試', 'wf', run.run_id).steps.a.memory;
  assert.deepEqual(m.cards.map((c) => c.bucket), ['group'], '群組條照記，關於你一張都沒有');
  assert.equal(m.paused, false);
});

test('M3a 設定缺省：節點沒設檔位→用 settings.defaults.model_tier；exec.web=false→工人不查網；defaults.retry 補節點沒設的重試；節點自己設的優先', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[1].model_tier = 'fast';
  def.nodes[2].retry = 0;
  const { runner, adapter, store } = setup(def);
  store.writeSettings({ defaults: { model_tier: 'deep', retry: 1 }, exec: { web: false } });
  adapter.setFailOn('a', 1); // a 壞一次：靠設定的 retry 自動重來
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const aCalls = workerCalls(adapter, 'a');
  assert.equal(aCalls.length, 2, '節點沒設 retry → 用設定的 1');
  assert.equal(aCalls[0].model, 'opus', '節點沒設檔位 → 用設定的 deep');
  assert.equal(aCalls[0].web, false, '設定關查網 → 工人不查網');
  assert.equal(workerCalls(adapter, 'b')[0].model, 'haiku', '節點自己的檔位優先');
  assert.equal(workerCalls(adapter, 'b')[0].web, false);
  const r = store.readRun('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  // 節點明寫 retry: 0 → 不吃設定的 1
  const s2 = setup(def);
  s2.store.writeSettings({ defaults: { retry: 1 } });
  s2.adapter.setFailOn('c');
  const run2 = s2.runner.startRun('測試', 'wf', {});
  await s2.runner.runUntilPause('測試', 'wf', run2.run_id);
  assert.equal(workerCalls(s2.adapter, 'c').length, 1, 'retry: 0 是節點自己寫的，不補');
  assert.equal(s2.store.readRun('測試', 'wf', run2.run_id).steps.c.status, 'failed');
  // 設定全缺省：行為同現況（沒 --model、查網開、不重試）
  const s3 = setup();
  s3.adapter.setFailOn('a');
  const run3 = s3.runner.startRun('測試', 'wf', {});
  await s3.runner.runUntilPause('測試', 'wf', run3.run_id);
  assert.equal(workerCalls(s3.adapter, 'a').length, 1);
  assert.equal(workerCalls(s3.adapter, 'a')[0].model, '');
  assert.equal(workerCalls(s3.adapter, 'a')[0].web, true);
});

// ---- 規範開跑鎖版本（run.shared）、參考檔跨層（attachments 混型）、查核第四路、舊 run 相容 ----

const seedShared = (store) => {
  store.addShared('_company', { name: '手冊.md', kind: 'rule', buf: Buffer.from('語氣要親切。'), text: '語氣要親切。' });
  store.addShared('測試', { name: '部門.md', kind: 'rule', buf: Buffer.from('報價含稅。'), text: '報價含稅。' });
};

test('U1b ③：開跑鎖版本——startRun 把兩層規範全文快照進 run.shared；硬碟上的規範換了，續跑仍用開跑那份；steps[n].memory.shared 記份數與字數；查核員收到第四路', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].stop_point = 'always';
  const { runner, adapter, store } = setup(def);
  seedShared(store);
  const run = runner.startRun('測試', 'wf', {});
  assert.ok(run.shared.at && !Number.isNaN(Date.parse(run.shared.at)));
  assert.deepEqual(run.shared.company, [{ name: '手冊.md', chars: 6, text: '語氣要親切。' }]);
  assert.deepEqual(run.shared.dept, [{ name: '部門.md', chars: 5, text: '報價含稅。' }]);
  assert.deepEqual(store.readRun('測試', 'wf', run.run_id).shared, run.shared, '落地的跟回傳的一樣');
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.a.status, 'waiting_review');
  const a = workerCalls(adapter, 'a')[0];
  assert.deepEqual(a.companyRules, [{ name: '手冊.md', text: '語氣要親切。' }]);
  assert.deepEqual(a.deptRules, [{ name: '部門.md', text: '報價含稅。' }]);
  assert.deepEqual(r.steps.a.memory.shared, { company: [{ name: '手冊.md', chars: 6 }], dept: [{ name: '部門.md', chars: 5 }], refs: [] });
  assert.deepEqual(r.steps.a.memory.cards, [], '沒接記憶門面：卡空、只有 shared');
  const ck = checkCalls(adapter, 'a')[0].checkPrompt;
  assert.ok(ck.includes('# 公司／部門規範（一定要守）') && ck.includes('## 公司規範：手冊.md\n語氣要親切。') && ck.includes('## 部門規範：部門.md\n報價含稅。'), ck);
  // 換掉硬碟上的手冊、多放一份分類規範，再續跑 → 下一步仍是開跑那份
  store.deleteShared('_company', '手冊.md');
  store.addShared('_company', { name: '手冊.md', kind: 'rule', buf: Buffer.from('改版：語氣要嚴肅。'), text: '改版：語氣要嚴肅。' });
  store.addShared('測試', { name: '新增.md', kind: 'rule', buf: Buffer.from('新規'), text: '新規' });
  runner.approve('測試', 'wf', run.run_id, 'a');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  const b = workerCalls(adapter, 'b')[0];
  assert.deepEqual(b.companyRules, [{ name: '手冊.md', text: '語氣要親切。' }], '鎖版本：續跑不重讀硬碟');
  assert.deepEqual(b.deptRules, [{ name: '部門.md', text: '報價含稅。' }], '鎖版本：續跑後新增的不帶');
  assert.equal(r.shared.company[0].text, '語氣要親切。');
  assert.deepEqual(r.steps.c.memory.shared.dept, [{ name: '部門.md', chars: 5 }]);
});

test('U1b ③：舊 run（run.yaml 沒有 shared）續跑不炸、工人不帶規範、查核無規範段、不寫 memory；沒有共用檔的新流程照舊（run.shared 兩層空、steps.a.memory 仍 undefined）', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].stop_point = 'always';
  const { runner, adapter, store } = setup(def);
  seedShared(store);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const raw = store.readRun('測試', 'wf', run.run_id);
  delete raw.shared; // 模擬本功能上線前的舊 run
  store.writeRun('測試', 'wf', run.run_id, raw);
  runner.approve('測試', 'wf', run.run_id, 'a');
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  const b = workerCalls(adapter, 'b')[0];
  assert.deepEqual(b.companyRules, []);
  assert.deepEqual(b.deptRules, []);
  assert.equal(r.steps.b.memory, undefined, '舊 run 不寫 memory.shared');
  assert.equal((checkCalls(adapter, 'b')[0].checkPrompt.match(/規範/g) ?? []).length, 0);
  // 沒有共用檔（連 data/shared/ 都沒有）的流程
  const plain = setup();
  const run2 = plain.runner.startRun('測試', 'wf', {});
  assert.deepEqual([run2.shared.company, run2.shared.dept], [[], []]);
  const r2 = await plain.runner.runUntilPause('測試', 'wf', run2.run_id);
  assert.equal(r2.status, 'done');
  assert.deepEqual(workerCalls(plain.adapter, 'a')[0].companyRules, []);
  assert.equal(r2.steps.a.memory, undefined, '沒有規範沒有共用參考＝不多寫 memory（舊行為）');
});

test('U1b ④：attachments 混型——字串走流程參考檔、{scope} 走公司／部門共用夾：工作單路徑各對各層、查核原始資料與監工開場用「名稱（公司）」當鍵、memory.shared.refs 記層與字數', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].attachments = ['a.txt', { scope: 'company', name: 'b.md' }, { scope: 'category', name: 'c.md' }, { scope: 'company', name: '沒有的.md' }];
  const { runner, adapter, store } = setup(def);
  store.writeRefFile('測試', 'wf', 'a.txt', Buffer.from('流程層內容'));
  store.addShared('_company', { name: 'b.md', kind: 'ref', buf: Buffer.from('公司層內容') });
  store.addShared('測試', { name: 'c.md', kind: 'ref', buf: Buffer.from('部門層內容') });
  const run = runner.startRun('測試', 'wf', {});
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  const a = workerCalls(adapter, 'a')[0];
  const tail = (p) => p.replace(/\\/g, '/').split('/').slice(-4).join('/');
  assert.deepEqual(a.attachments.map(tail), ['測試/wf/files/a.txt', 'shared/_company/files/b.md', 'shared/測試/files/c.md'], '各對各層；不存在的不列');
  const ck = checkCalls(adapter, 'a')[0].checkPrompt;
  assert.ok(ck.includes('【參考檔：a.txt】\n流程層內容') && ck.includes('【參考檔：b.md（組織）】\n公司層內容') && ck.includes('【參考檔：c.md（分類）】\n部門層內容'), ck);
  assert.ok(!ck.includes('[object Object]'));
  const brief = adapter.calls.find((c) => c.meta?.kind === 'supervisor' && c.meta.phase === 'brief').prompt;
  // US-111：監工開場只列名稱／掛在哪步／行數／欄位，不附內文（L068：讀了截斷節錄就寫收窄規定）
  assert.ok(brief.includes('【參考檔：a.txt】（掛在：A）｜行數 1') && brief.includes('【參考檔：b.md（組織）】（掛在：A）｜行數 1') && brief.includes('【參考檔：c.md（分類）】（掛在：A）｜行數 1'), brief);
  for (const w of ['流程層內容', '公司層內容', '部門層內容']) assert.ok(!brief.includes(w), `開場不附參考檔內文：${w}`);
  assert.ok(brief.includes('【參考檔：沒有的.md（組織）】') && !brief.includes('[object Object]'), '讀不到的只列名字');
  assert.deepEqual(r.steps.a.memory.shared, {
    company: [], dept: [],
    refs: [{ scope: 'company', name: 'b.md', chars: '公司層內容'.length }, { scope: 'category', name: 'c.md', chars: '部門層內容'.length }], // U1a md／txt 參考的 chars＝字元數（5），不是位元組
  });
  assert.equal(r.steps.b.memory, undefined, '沒勾共用檔、沒規範的步驟不多寫');
});

test('U1b ⑧：settings.memory.paused 不影響規範——關於你空、companyRules 照帶、memory.shared 照記', async () => {
  const { runner, adapter, store } = setupMemory();
  seedMemory(store);
  seedShared(store);
  store.writeSettings({ memory: { paused: true } });
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const a = workerCalls(adapter, 'a')[0];
  assert.deepEqual(a.coreNotes, []);
  assert.deepEqual(a.groupRules, ['不提競品']);
  assert.deepEqual(a.companyRules, [{ name: '手冊.md', text: '語氣要親切。' }]);
  assert.deepEqual(a.deptRules, [{ name: '部門.md', text: '報價含稅。' }]);
  const m = store.readRun('測試', 'wf', run.run_id).steps.a.memory;
  assert.equal(m.paused, true);
  assert.deepEqual(m.cards.map((c) => c.bucket), ['group']);
  assert.deepEqual(m.shared, { company: [{ name: '手冊.md', chars: 6 }], dept: [{ name: '部門.md', chars: 5 }], refs: [] });
});

test('U1b 卷宗：真 host-adapter → prompts/a.txt 有「# 公司規範」「# 部門規範」段（含全文）、在「# 分類守則」之前；a.check1.txt 有第四路段', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-runner-'));
  const store = createStore(dir);
  store.writeWorkflow('測試', 'wf', LINEAR3);
  seedShared(store);
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdin = { write() {}, end() {}, on() {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', '產出文字');
      child.emit('close', 0);
    });
    return child;
  };
  const memory = { onRunStart() {}, contextFor: () => ({ coreNotes: ['不要恭維'], groupRules: ['不提競品'], groupName: '測試', cards: [], overridden: [], picks: {}, paused: false }) };
  const runner = createRunner({ store, adapter: createHostAdapter({ spawnFn }), memory });
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const p = store.readPromptRecord('測試', 'wf', run.run_id, 'a.txt');
  const at = (h) => p.indexOf(h);
  assert.ok(p.includes('# 公司規範（每一步都照做；查核員也會對）\n## 手冊.md\n語氣要親切。'), p);
  assert.ok(p.includes('# 部門規範（分類「測試」，同上）\n## 部門.md\n報價含稅。'), p);
  assert.ok(at('# 關於你') < at('# 公司規範') && at('# 公司規範') < at('# 部門規範') && at('# 部門規範') < at('# 分類守則（分類「測試」，一定要守）'), '順序：關於你→…→公司→部門→分類守則');
  const ck = store.readPromptRecord('測試', 'wf', run.run_id, 'a.check1.txt');
  assert.ok(ck.includes('# 公司／部門規範（一定要守）\n## 公司規範：手冊.md\n語氣要親切。') && ck.includes('違反規範歸 must'), ck);
});

// ===== 執行端沿路全帶——每一步的輸入＝全部祖先 task 的產出，最近在前、80,000 整段截斷、並行點不轉運 =====
import { capUpstream, UPSTREAM_CAP } from '../src/runner.js';

const PREFACE = '（沿路全部產出，最近的在前）';

test('B1 ①：三步直線 a→b→c——c 的 upstream 含【A】【B】兩段、B 在前 A 在後、首行前言；b 只拿 a 原文不加標頭', async () => {
  const { runner, adapter } = setup(LINEAR3);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const b = workerCalls(adapter, 'b')[0].upstream;
  const c = workerCalls(adapter, 'c')[0].upstream;
  assert.equal(b, '產出:a', '一個祖先＝原文不加標頭（現況不變）');
  assert.ok(c.startsWith(PREFACE + '\n'), `首行前言：${c}`);
  assert.ok(c.includes('【B】\n產出:b') && c.includes('【A】\n產出:a'), c);
  assert.ok(c.indexOf('【B】') < c.indexOf('【A】'), '最近的在前');
  assert.ok(!c.includes('已截斷'), '沒超量就沒有截斷句');
});

test('B1 ②：a→fork→{b,c}→d——d 的 upstream 含 a、b、c 各一次、無【並行】、a 只出現一次；fork 步的 output 為空字串', async () => {
  const def = {
    format: 1, name: 'fk', params: [],
    nodes: [
      { id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做', next: ['fk'] },
      { id: 'fk', title: '並行', kind: 'fork', next: ['b', 'c'] },
      { id: 'b', title: 'B', executor: 'ai', stop_point: 'never', instruction: '做', next: ['d'] },
      { id: 'c', title: 'C', executor: 'ai', stop_point: 'never', instruction: '做', next: ['d'] },
      { id: 'd', title: 'D', executor: 'ai', stop_point: 'never', instruction: '做', next: [] },
    ],
  };
  const { runner, adapter } = setup(def);
  const run = runner.startRun('測試', 'wf', {});
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.status, 'done');
  assert.equal(r.steps.fk.status, 'done');
  assert.equal(r.steps.fk.output, '', '並行點不再轉運：產出記空字串');
  assert.equal(r.steps.fk.check.status, 'skipped');
  const d = workerCalls(adapter, 'd')[0].upstream;
  for (const id of ['a', 'b', 'c']) assert.equal(d.split(`產出:${id}`).length - 1, 1, `${id} 恰出現一次：${d}`);
  assert.ok(!d.includes('【並行】'), `並行點不算祖先：${d}`);
  assert.ok(d.startsWith(PREFACE), d);
  assert.ok(d.indexOf('【A】') > d.indexOf('【B】') && d.indexOf('【A】') > d.indexOf('【C】'), '最遠的 A 在最後');
  // b 的輸入不經並行點轉手：就是 a 原文（一個祖先不加標頭）
  assert.equal(workerCalls(adapter, 'b')[0].upstream, '產出:a');
});

test('B1 ③：截斷——a 產出 70,000 字、b 產出 20,000 字 → c 的 upstream 含 b 全文、不含 a 正文、尾句「更早的產出已截斷：A」、總長 ≤ 80,000＋前後言', async () => {
  const { runner, adapter } = setup(LINEAR3);
  const bigA = 'A'.repeat(70000);
  const bigB = 'B'.repeat(20000);
  adapter.setOutput('a', bigA);
  adapter.setOutput('b', bigB);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const c = workerCalls(adapter, 'c')[0].upstream;
  assert.ok(c.includes('【B】\n' + bigB), 'b 全文在');
  assert.ok(!c.includes('AAAAAAAAAA'), 'a 正文整段丟');
  assert.ok(c.endsWith('（更早的產出已截斷：A）'), `尾句記名：${c.slice(-60)}`);
  assert.ok(c.startsWith(PREFACE), c.slice(0, 40));
  assert.ok(c.length <= UPSTREAM_CAP + PREFACE.length + '（更早的產出已截斷：A）'.length + 4, `總長 ${c.length}`);
  assert.equal(UPSTREAM_CAP, 80000);
  // 純函式直測：由遠而近整段丟、多個被丟的一起記名；沒超量原樣、最近那段永遠留著
  const parts = [{ title: '近', text: 'x'.repeat(50) }, { title: '中', text: 'y'.repeat(50) }, { title: '遠', text: 'z'.repeat(50) }];
  const capped = capUpstream(parts, 120);
  assert.ok(capped.includes('【近】') && capped.includes('【中】') && !capped.includes('zzz'), capped);
  assert.ok(capped.endsWith('（更早的產出已截斷：遠）'), capped);
  assert.ok(capUpstream(parts, 60).endsWith('（更早的產出已截斷：中、遠）'), '多個被丟的一起記名');
  assert.ok(capUpstream(parts, 1).includes('【近】\n' + 'x'.repeat(50)), '最近那段再大也留著');
  assert.ok(!capUpstream(parts, 100000).includes('已截斷'), '沒超量沒有截斷句');
});

test('B1 ④：跳過的分岔支線（status skipped）與空產出的祖先不進 upstream；走到的人做步驟產出照帶', async () => {
  // 路 2（五千以下）：boss-sign 跳過 → scan 只拿 fill；路 1：boss-sign 人做交出內容 → scan 含【主管簽核】＋【填報帳單】
  const { adapter, runner } = setup(DAG_DEF);
  adapter.setHandoffReply('{"route":"2"}');
  const run = runner.startRun('測試', 'wf', {});
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.steps['boss-sign'].status, 'skipped');
  assert.equal(done.steps['amount-check'].output, '', '分岔也不轉運');
  const scan = workerCalls(adapter, 'scan')[0].upstream;
  assert.equal(scan, '產出:fill', `跳過的支線不進、單一祖先不加標頭：${scan}`);
  const { adapter: ad2, runner: r2 } = setup(DAG_DEF);
  ad2.setHandoffReply('{"route":"1"}');
  const run2 = r2.startRun('測試', 'wf', {});
  await r2.runUntilPause('測試', 'wf', run2.run_id);
  r2.completeHuman('測試', 'wf', run2.run_id, 'boss-sign', null, '簽好了');
  const done2 = await r2.runUntilPause('測試', 'wf', run2.run_id);
  assert.equal(done2.status, 'done');
  const scan2 = workerCalls(ad2, 'scan')[0].upstream;
  assert.ok(scan2.includes('【主管簽核】\n簽好了') && scan2.includes('【填報帳單】\n產出:fill'), scan2);
  assert.ok(scan2.indexOf('【主管簽核】') < scan2.indexOf('【填報帳單】'), '最近在前');
  assert.ok(!scan2.includes('【簽核匯合】') && !scan2.includes('【同時進行】') && !scan2.includes('【金額分流】'), '結構節點不算祖先');
  // 空產出的祖先不進：a 交白卷 → b 沒輸入、c 只拿 b
  const { adapter: ad3, runner: r3 } = setup(LINEAR3);
  ad3.setOutput('a', '');
  const run3 = r3.startRun('測試', 'wf', {});
  await r3.runUntilPause('測試', 'wf', run3.run_id);
  assert.equal(workerCalls(ad3, 'b')[0].upstream, '');
  assert.equal(workerCalls(ad3, 'c')[0].upstream, '產出:b');
});

test('B1 ⑤：supplied_input 仍排最前「【你補的資料】」，沿路全帶的段落跟在「【上一步的產出】」後', async () => {
  const { runner, adapter } = setup(LINEAR3);
  adapter.setCheckResponse(CHECK_PASS);
  adapter.setOutput('c', '【資料不全】少了明細。\n（骨架）');
  const run = runner.startRun('測試', 'wf', {});
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps.c.status, 'waiting_data');
  runner.dataSupply('測試', 'wf', run.run_id, 'c', '明細如下：帽子 6 件');
  r = await runner.runUntilPause('測試', 'wf', run.run_id);
  const c2 = workerCalls(adapter, 'c')[1].upstream;
  assert.ok(c2.startsWith('【你補的資料】\n明細如下：帽子 6 件\n\n【上一步的產出】\n' + PREFACE), c2);
  assert.ok(c2.includes('【B】\n產出:b') && c2.includes('【A】\n產出:a'), c2);
});

test('B1 ⑧：舊 run（並行點產出仍是舊式轉運文字、run.yaml 無新欄位）續跑不炸；並行點的舊產出不進下游、上游步驟只出現一次', async () => {
  const def = structuredClone(PAR_DEF);
  def.nodes[2].stop_point = 'always'; // t-a 停一下，好在中途改 run.yaml
  const { runner, adapter, store } = setup(def);
  const run = runner.startRun('測試', 'wf', {});
  let r = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(r.steps['t-a'].status, 'waiting_review');
  // 模擬舊版 runner 寫的 run.yaml：並行點 output＝上游原樣（舊式轉運）
  r.steps.fk.output = '產出:start';
  store.writeRun('測試', 'wf', run.run_id, r);
  runner.approve('測試', 'wf', run.run_id, 't-a');
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.status, 'done');
  assert.equal(done.steps.fk.output, '產出:start', '舊 run 的並行點產出保持原樣不回改（報備 4）');
  const fin = workerCalls(adapter, 'final')[0].upstream;
  assert.equal(fin.split('產出:start').length - 1, 1, `起步只出現一次：${fin}`);
  assert.ok(!fin.includes('【同時做】') && !fin.includes('【會合】'), fin);
  assert.ok(fin.includes('【做A】\n產出:t-a') && fin.includes('【做B】\n產出:t-b') && fin.includes('【起步】\n產出:start'), fin);
});

// ---- 本次補充f）與本次上傳 A） ----
const UPLOAD_RUN_DEF = {
  format: 1, name: '上傳月報',
  params: [{ key: 'src', label: '原始資料', default: '', input: 'file', required: true }, { key: 'range', label: '範圍', default: '本季' }],
  nodes: [
    { id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '整理上傳的資料，範圍 {{range}}', next: ['b'] },
    { id: 'b', title: 'B', executor: 'ai', stop_point: 'never', instruction: '做B', next: [] },
  ],
};
test('排版輪 L11 ③④⑤：run.note 存下、每個 AI 步驟 upstream 接「【你這次的補充】」；上傳檔每個 AI 步驟都掛（ADR-009 ①；工作單路徑＝該趟 in/）', async () => {
  const { runner, adapter, store } = setup(UPLOAD_RUN_DEF);
  const run = runner.startRun('測試', 'wf', { src: '三月.csv' }, { note: '留意新品類' });
  assert.equal(run.note, '留意新品類');
  assert.equal(run.params.src, '三月.csv');
  const inDir = store.runInDir('測試', 'wf', run.run_id);
  fs.writeFileSync(path.join(inDir, '三月.csv'), 'a,b\n1,2');
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const a = adapter.calls.find((c) => c.nodeId === 'a');
  const b = adapter.calls.find((c) => c.nodeId === 'b');
  assert.equal(a.upstream, '【你這次的補充】\n留意新品類', '第一步沒有上游：只有補充');
  assert.equal(b.upstream, '產出:a\n\n【你這次的補充】\n留意新品類', '補充接在上游之後');
  assert.deepEqual(a.attachments, [path.join(inDir, '三月.csv')], '第一個 AI 步驟讀檔');
  assert.deepEqual(b.attachments, [path.join(inDir, '三月.csv')], 'ADR-009 ①：後面的步驟也看得到原始檔（以前只靠沿路全帶的整理）');
  assert.equal(store.readRun('測試', 'wf', run.run_id).note, '留意新品類');
});

test('排版輪 L11 ⑥：不帶 note／上傳的 run 沒有新鍵、upstream 與現況逐字相同；必填上傳欄位沒檔（排程觸發）→ startRun 擋下並說明，不靜默跑', async () => {
  const { runner, adapter } = setup();
  const run = runner.startRun('測試', 'wf', {});
  assert.ok(!('note' in run), 'run 沒有 note 鍵');
  await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(adapter.calls.find((c) => c.nodeId === 'a').upstream, '');
  assert.equal(adapter.calls.find((c) => c.nodeId === 'b').upstream, '產出:a');
  const up = setup(UPLOAD_RUN_DEF);
  assert.throws(() => up.runner.startRun('測試', 'wf', {}, { source: 'schedule' }),
    (e) => e.message.includes('原始資料') && e.message.includes('上傳') && e.message.includes('本次資料'));
  assert.equal(up.store.listRuns('測試', 'wf').length, 0, '擋下的不落地');
});

// ===== 入口「任一條到」＝nodes[].merge:'any'——第一條線做完就開始，其他線照跑完但產出不再送進這張卡（與它的下游） =====
import { exportText, parseImport } from '../src/porter.js';

const ANY_DEF = {
  format: 1, name: '誰先好用誰', params: [],
  check: { enabled: false }, supervisor: { enabled: false },
  nodes: [
    { id: 'a', title: '起頭', executor: 'ai', stop_point: 'never', instruction: '起', next: ['b', 'c'] },
    { id: 'b', title: '快的', executor: 'ai', stop_point: 'never', instruction: '快', next: ['d'] },
    { id: 'c', title: '慢的', executor: 'ai', stop_point: 'never', instruction: '慢', next: ['d'] },
    { id: 'd', title: '會合', executor: 'ai', stop_point: 'never', instruction: '合', next: ['e'], merge: 'any' },
    { id: 'e', title: '收尾', executor: 'ai', stop_point: 'never', instruction: '收', next: [] },
  ],
};
const callsOf = (adapter, id) => adapter.calls.filter((c) => c.nodeId === id);
const spanOf = (adapter, id) => adapter.spans.find((s) => s.nodeId === id);
// 快的先到：d 在 c 還沒做完時就開始、只吃 b（與更早的 a）；c 照跑完、不再觸發 d；e 也看不到 c
function assertFastWins(adapter, done, { fast = 'b', slow = 'c' } = {}) {
  assert.equal(done.status, 'done', JSON.stringify(Object.fromEntries(Object.entries(done.steps).map(([k, v]) => [k, v.status]))));
  assert.equal(done.steps[slow].status, 'done', '慢的那條照跑完');
  assert.equal(callsOf(adapter, 'd').length, 1, 'd 只開始一次（慢的做完不再觸發）');
  assert.ok(spanOf(adapter, 'd').start < spanOf(adapter, slow).end, `d 要在慢的做完之前開始：${JSON.stringify(adapter.spans)}`);
  const d = callsOf(adapter, 'd')[0].upstream;
  assert.ok(d.includes(`產出:${fast}`) && d.includes('產出:a') && !d.includes(`產出:${slow}`), `d 工作單只含先到的線與更早祖先：${d}`);
  assert.deepEqual(done.steps.d.merge_from, [fast], '記下開始當下已到的線');
  const e = callsOf(adapter, 'e')[0].upstream;
  assert.ok(!e.includes(`產出:${slow}`) && e.includes('產出:d'), `下游也不收沒趕上的線：${e}`);
}

test('排版輪 L13 引擎②：a→{b,c}→d（任一條到，b 快 c 慢）→b 完成即開 d、d 只吃 b 與 a、c 之後完成不再觸發 d、run 正常結束', async () => {
  const { adapter, runner } = setup(ANY_DEF);
  adapter.setDelayFor('b', 5);
  adapter.setDelayFor('c', 120);
  const run = runner.startRun('測試', 'wf', {});
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assertFastWins(adapter, done);
});

test('排版輪 L13 引擎③：缺省（等全部）行為與現況相同——d 等兩條都完成才開、吃兩條、步驟不多 merge_from 鍵', async () => {
  const def = structuredClone(ANY_DEF);
  delete def.nodes[3].merge;
  const { adapter, runner } = setup(def);
  adapter.setDelayFor('b', 5);
  adapter.setDelayFor('c', 60);
  const run = runner.startRun('測試', 'wf', {});
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.status, 'done');
  assert.ok(spanOf(adapter, 'd').start > spanOf(adapter, 'c').end, 'd 等 c 做完');
  const d = callsOf(adapter, 'd')[0].upstream;
  assert.ok(d.includes('產出:b') && d.includes('產出:c') && d.includes('產出:a'), d);
  for (const s of Object.values(done.steps)) assert.ok(!('merge_from' in s), '等全部不寫 merge_from');
});

test('排版輪 L13 引擎④：擇一（藏起來的分岔）後會合——沒走的線 skipped，會合卡等全部與任一條到都只跑一次、吃走到的那條', async () => {
  for (const merge of [undefined, 'any']) {
    const def = {
      format: 1, name: '擇一會合', params: [], check: { enabled: false },
      nodes: [
        { id: 'a', title: '看', executor: 'ai', stop_point: 'never', instruction: '看', next: ['B'] },
        { id: 'B', title: '看・擇一', kind: 'branch', instruction: '依每條線上的條件，挑符合的一條走', next: [], branches: [{ label: '大', next: 'x' }, { label: '小', next: 'y' }] },
        { id: 'x', title: 'X', executor: 'ai', stop_point: 'never', instruction: 'x', next: ['m'] },
        { id: 'y', title: 'Y', executor: 'ai', stop_point: 'never', instruction: 'y', next: ['m'] },
        { id: 'm', title: 'M', executor: 'ai', stop_point: 'never', instruction: 'm', next: [], ...(merge ? { merge } : {}) },
      ],
    };
    const { adapter, runner } = setup(def);
    adapter.setHandoffReply('{"note":"","tier":null,"web":null,"route":"1"}');
    const run = runner.startRun('測試', 'wf', {});
    const done = await runner.runUntilPause('測試', 'wf', run.run_id);
    assert.equal(done.status, 'done', String(merge));
    assert.equal(done.steps.y.status, 'skipped', String(merge));
    assert.equal(callsOf(adapter, 'm').length, 1, String(merge));
    assert.ok(callsOf(adapter, 'm')[0].upstream.includes('產出:x') && !callsOf(adapter, 'm')[0].upstream.includes('產出:y'), String(merge));
    if (merge) assert.deepEqual(done.steps.m.merge_from, ['x']);
  }
});

test('排版輪 L13 引擎⑦：舊 fork／join 檔——join 帶 merge:any 也照「任一條到」；不帶的舊檔照舊等全部', async () => {
  const def = structuredClone(PAR_DEF);
  def.check = { enabled: false };
  def.supervisor = { enabled: false };
  def.nodes.find((n) => n.id === 'jn').merge = 'any';
  const { adapter, runner } = setup(def);
  adapter.setDelayFor('t-a', 5);
  adapter.setDelayFor('t-b', 120);
  const run = runner.startRun('測試', 'wf', {});
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.steps.jn.merge_from, ['t-a']);
  const fin = callsOf(adapter, 'final')[0];
  assert.ok(fin.upstream.includes('產出:t-a') && !fin.upstream.includes('產出:t-b'), fin.upstream);
  assert.ok(spanOf(adapter, 'final').start < spanOf(adapter, 't-b').end);
  const old = setup(PAR_DEF);
  old.adapter.setDelayFor('t-b', 40);
  const r2 = old.runner.startRun('測試', 'wf', {});
  const d2 = await old.runner.runUntilPause('測試', 'wf', r2.run_id);
  assert.ok(callsOf(old.adapter, 'final')[0].upstream.includes('產出:t-b'), '舊檔照等全部');
  assert.ok(!('merge_from' in d2.steps.jn));
});

test('排版輪 L13 引擎⑧：匯入檔（匯出→解析）保留 merge 並照任一條到跑；排程開跑與補跑（source／makeup）同一套', async () => {
  const back = parseImport(exportText(ANY_DEF)).def;
  assert.equal(back.nodes.find((n) => n.id === 'd').merge, 'any', '匯出檔帶著 merge');
  const imp = setup(back);
  imp.adapter.setDelayFor('b', 5);
  imp.adapter.setDelayFor('c', 120);
  const r1 = imp.runner.startRun('測試', 'wf', {});
  assertFastWins(imp.adapter, await imp.runner.runUntilPause('測試', 'wf', r1.run_id));
  const sch = setup(ANY_DEF);
  sch.adapter.setDelayFor('b', 120);
  sch.adapter.setDelayFor('c', 5);
  const r2 = sch.runner.startRun('測試', 'wf', {}, { source: 'schedule', makeup: true });
  const d2 = await sch.runner.runUntilPause('測試', 'wf', r2.run_id);
  assert.equal(d2.source, 'schedule');
  assert.equal(d2.makeup, true);
  assertFastWins(sch.adapter, d2, { fast: 'c', slow: 'b' });
});

test('排版輪 L13 引擎⑨：重跑——會合卡出錯後「重試這步」沿用開始當下那條線（慢的早已做完也不加進來）', async () => {
  const { adapter, runner } = setup(ANY_DEF);
  adapter.setDelayFor('b', 5);
  adapter.setDelayFor('c', 120);
  adapter.setFailOn('d', 1);
  const run = runner.startRun('測試', 'wf', {});
  const paused = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.steps.d.status, 'failed');
  assert.equal(paused.steps.c.status, 'done', '慢的那條照跑完');
  runner.retry('測試', 'wf', run.run_id, 'd');
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.status, 'done');
  const calls = callsOf(adapter, 'd');
  assert.equal(calls.length, 2);
  assert.ok(!calls[1].upstream.includes('產出:c') && calls[1].upstream.includes('產出:b'), calls[1].upstream);
  assert.deepEqual(done.steps.d.merge_from, ['b']);
});

test('排版輪 L13 引擎⑩：停點中的並行支線——快的那條停在等你過目（不算到），慢的做完就開 d；之後核可快的不再觸發 d', async () => {
  const def = structuredClone(ANY_DEF);
  def.nodes[1].stop_point = 'always';
  const { adapter, runner } = setup(def);
  adapter.setDelayFor('b', 5);
  adapter.setDelayFor('c', 60);
  const run = runner.startRun('測試', 'wf', {});
  const paused = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.steps.b.status, 'waiting_review');
  assert.equal(paused.steps.d.status, 'done', '等你過目的不算到，另一條到了就開');
  assert.deepEqual(paused.steps.d.merge_from, ['c']);
  runner.approve('測試', 'wf', run.run_id, 'b');
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.status, 'done');
  assert.equal(callsOf(adapter, 'd').length, 1);
  assert.ok(!callsOf(adapter, 'd')[0].upstream.includes('產出:b'));
});

test('排版輪 L13 引擎⑥：舊 run 續跑不炸——伺服器重啟時 d 卡在 running（已記 merge_from）只吃那條；沒記過的照開始當下已到的算', async () => {
  const { dir, store, runner } = setup(ANY_DEF);
  const run = runner.startRun('測試', 'wf', {});
  const crashed = store.readRun('測試', 'wf', run.run_id);
  crashed.steps.a = { ...crashed.steps.a, status: 'done', output: '產出:a' };
  crashed.steps.b = { ...crashed.steps.b, status: 'done', output: '產出:b' };
  crashed.steps.c = { ...crashed.steps.c, status: 'running' };
  crashed.steps.d = { ...crashed.steps.d, status: 'running', merge_from: ['b'] };
  store.writeRun('測試', 'wf', run.run_id, crashed);
  const adapter2 = fakeAdapter();
  adapter2.setDelayFor('c', 5);
  adapter2.setDelayFor('d', 60);
  const done = await createRunner({ store: createStore(dir), adapter: adapter2 }).runUntilPause('測試', 'wf', run.run_id);
  assert.equal(done.status, 'done');
  assert.ok(!callsOf(adapter2, 'd')[0].upstream.includes('產出:c'), callsOf(adapter2, 'd')[0].upstream);
  // 沒記過 merge_from（兩條都已做完才重啟）→ 兩條都算到
  const again = runner.startRun('測試', 'wf', {});
  const st = store.readRun('測試', 'wf', again.run_id);
  for (const k of ['a', 'b', 'c']) st.steps[k] = { ...st.steps[k], status: 'done', output: `產出:${k}` };
  store.writeRun('測試', 'wf', again.run_id, st);
  const adapter3 = fakeAdapter();
  const done3 = await createRunner({ store: createStore(dir), adapter: adapter3 }).runUntilPause('測試', 'wf', again.run_id);
  assert.deepEqual(done3.steps.d.merge_from, ['b', 'c']);
  assert.ok(callsOf(adapter3, 'd')[0].upstream.includes('產出:c'));
});

// ── 2026-09-18  ──────────────────────────────────────────────

test('必填上傳欄位：留著舊的預設文字也不算有檔，開跑要直接擋下來', () => {
  const { runner, store } = setup({
    format: 1,
    name: '月報',
    // 原本是文字欄位、後來勾成「每次上傳檔案」——default 的說明文字還留著（UI 不會清）
    params: [{ key: 'data', label: '銷售明細', default: '貼上上個月的明細', required: true, input: 'file' }],
    nodes: [{ id: 'a', title: '整理', executor: 'ai', stop_point: 'never', instruction: '整理 {{data}}', next: [] }],
  });
  assert.throws(
    () => runner.startRun('測試', 'wf', {}),
    (e) => e.message.includes('上傳'),
    '退回 default 文字＝守門打不到＝AI 拿零資料還報完成',
  );
  assert.equal(store.listRuns('測試', 'wf').length, 0);
});

test('同名步驟的產出不准寫進同一個檔；標題結尾的句點不准算出「..」', async () => {
  const { runner, store, adapter } = setup({
    format: 1,
    name: '兩份報告',
    params: [],
    nodes: [
      { id: 'n1', title: '報告', executor: 'ai', stop_point: 'never', instruction: '一', output_file: 'md', next: ['n2'] },
      { id: 'n2', title: '報告', executor: 'ai', stop_point: 'never', instruction: '二', output_file: 'md', next: ['n3'] },
      { id: 'n3', title: '整理資料.', executor: 'ai', stop_point: 'never', instruction: '三', output_file: 'md', next: [] },
    ],
  });
  adapter.setOutput('n1', '第一份');
  adapter.setOutput('n2', '第二份');
  const run = runner.startRun('測試', 'wf', {});
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);

  assert.equal(done.steps.n3.status, 'done', '標題結尾句點不該讓這步失敗：' + (done.steps.n3.error ?? ''));
  const files = [done.steps.n1.file, done.steps.n2.file, done.steps.n3.file];
  assert.equal(new Set(files).size, 3, `三步要有三個不同的檔：${JSON.stringify(files)}`);
  assert.ok(!files.some((f) => String(f).includes('..')), `檔名不能含「..」：${JSON.stringify(files)}`);
  // 各自的內容要是自己的，不是對方的
  assert.equal(store.readArtifact('測試', 'wf', run.run_id, path.basename(done.steps.n1.file)).toString('utf8'), '第一份');
  assert.equal(store.readArtifact('測試', 'wf', run.run_id, path.basename(done.steps.n2.file)).toString('utf8'), '第二份');
});

// 2026-09-18 二次審查：撞名判斷原本比「標題」，但檔名是淨化過的——標題不同、檔名同樣會撞
test('淨化之後才同名的標題也算撞名：「月報/初稿」與「月報_初稿」、「結案.」與「結案」', async () => {
  const { runner, store, adapter } = setup({
    format: 1,
    name: '月報',
    params: [],
    nodes: [
      { id: 'n1', title: '月報/初稿', executor: 'ai', stop_point: 'never', instruction: '一', output_file: 'md', next: ['n2'] },
      { id: 'n2', title: '月報_初稿', executor: 'ai', stop_point: 'never', instruction: '二', output_file: 'md', next: ['n3'] },
      { id: 'n3', title: '結案.', executor: 'ai', stop_point: 'never', instruction: '三', output_file: 'md', next: ['n4'] },
      { id: 'n4', title: '結案', executor: 'ai', stop_point: 'never', instruction: '四', output_file: 'md', next: [] },
    ],
  });
  adapter.setOutput('n1', '第一份');
  adapter.setOutput('n2', '第二份');
  adapter.setOutput('n3', '第三份');
  adapter.setOutput('n4', '第四份');
  const run = runner.startRun('測試', 'wf', {});
  const done = await runner.runUntilPause('測試', 'wf', run.run_id);

  const files = [done.steps.n1.file, done.steps.n2.file, done.steps.n3.file, done.steps.n4.file];
  assert.equal(new Set(files).size, 4, `四步要有四個不同的檔：${JSON.stringify(files)}`);
  const read = (f) => store.readArtifact('測試', 'wf', run.run_id, path.basename(f)).toString('utf8');
  assert.equal(read(done.steps.n1.file), '第一份');
  assert.equal(read(done.steps.n2.file), '第二份', '後一步不准蓋掉前一步的檔');
  assert.equal(read(done.steps.n3.file), '第三份');
  assert.equal(read(done.steps.n4.file), '第四份', '只差一個結尾句點同樣是撞名');
});

test('L005／L006：本次附件與流程參考檔都進得了交給工人的清單——產檔模式也一樣', async () => {
  const def = structuredClone(LINEAR3);
  def.permissions = { files: true };
  def.nodes[0].output_file = 'docx'; // 產檔模式：工具旗標整組換過，附件靠 Read 進去
  def.nodes[0].attachments = ['範本說明.md'];
  const { runner, store, adapter } = setup(def);
  store.writeRefFile('測試', 'wf', '範本說明.md', Buffer.from('照這個格式', 'utf8'));
  const run = runner.startRun('測試', 'wf', {}, { runFiles: ['這趟的.md'] });
  // 本次附件的實體檔放進那一趟的 in/（正式路徑是 claimUpload 從暫存區搬過來）
  const inDir = path.join(store.dataDir, 'workflows', '測試', 'wf', 'runs', run.run_id, 'in');
  fs.mkdirSync(inDir, { recursive: true });
  fs.writeFileSync(path.join(inDir, '這趟的.md'), '這一趟的補充');

  await runner.runUntilPause('測試', 'wf', run.run_id);
  const call = adapter.calls.find((c) => c.nodeId === 'a');
  assert.ok(call?.fileMode, '產檔模式（要驗的就是這個模式下附件照樣帶得進去）');
  const atts = (call.attachments ?? []).map(String);
  assert.ok(atts.some((a) => a.includes('範本說明.md')), `流程參考檔要帶：${JSON.stringify(atts)}`);
  assert.ok(atts.some((a) => a.includes('這趟的.md')), `本次附件也要帶：${JSON.stringify(atts)}`);

  const r = store.readRun('測試', 'wf', run.run_id);
  assert.deepEqual(r.run_files, ['這趟的.md'], '附件名字記在這一趟上（換新碼續跑時靠它找回檔案）');
});

test('L005：查核員拿到的原始資料也會帶上本次附件與參考檔（行為層級：查核 prompt 裡兩者都在，附件標「這次附件」）', async () => {
  const def = structuredClone(LINEAR3);
  def.nodes[0].attachments = ['範本說明.md'];
  const { runner, store, adapter } = setup(def);
  store.writeRefFile('測試', 'wf', '範本說明.md', Buffer.from('照這個格式', 'utf8'));
  const run = runner.startRun('測試', 'wf', {}, { runFiles: ['這趟的.md'] });
  fs.writeFileSync(path.join(store.runInDir('測試', 'wf', run.run_id), '這趟的.md'), '這一趟的補充');
  await runner.runUntilPause('測試', 'wf', run.run_id);
  for (const id of ['a', 'b', 'c']) {
    const ck = checkCalls(adapter, id)[0]?.checkPrompt;
    assert.ok(ck, `${id} 步有查核`);
    assert.ok(ck.includes('【參考檔：範本說明.md】\n照這個格式'), `${id} 步查核員看得到參考檔：${ck.slice(-300)}`);
    assert.ok(ck.includes('【參考檔：這趟的.md（這次附件）】\n這一趟的補充'), `${id} 步查核員看得到本次附件、標得出來源：${ck.slice(-300)}`);
  }
});

// ---- ADR-009 ①③④：原始檔每個 AI 步驟都看得到（聯集）＋流程開了寫檔權限就每步帶 exec ----
const UNION_DEF = {
  format: 1, name: '三步月報',
  params: [{ key: 'src', label: '明細', default: '', input: 'file', required: true }, { key: 'range', label: '範圍', default: '八月' }],
  nodes: [
    { id: 'a', title: '讀資料', executor: 'ai', stop_point: 'never', instruction: '讀 sales.csv，範圍 {{range}}', attachments: ['sales.csv'], next: ['b'] },
    { id: 'b', title: '算數字', executor: 'ai', stop_point: 'never', instruction: '用 {{src}} 算', next: ['c'] },
    { id: 'c', title: '寫報告', executor: 'ai', stop_point: 'never', instruction: '寫月報', next: [] },
  ],
};
// 上傳欄位原本只給「沒有 AI 祖先的步驟」（uploadReaders＝第一步 a），第二步雖然引用 {{src}} 卻拿不到檔、第三步更沒有；
// 現在聯集讓三步都看得到。順序規則：本步自己掛的在前（參考檔→上傳）、其他步驟的照 def.nodes 順序接後面、本次附件最後、同一路徑只出現一次
async function runUnion(def) {
  const { runner, adapter, store } = setup(def);
  store.writeRefFile('測試', 'wf', 'sales.csv', Buffer.from('date,item,qty\n2026-08-01,帽子,6\n', 'utf8'));
  const run = runner.startRun('測試', 'wf', { src: '明細.csv' }, { runFiles: ['附件.md'] });
  const inDir = store.runInDir('測試', 'wf', run.run_id);
  fs.writeFileSync(path.join(inDir, '明細.csv'), 'item,qty\n帽子,6');
  fs.writeFileSync(path.join(inDir, '附件.md'), '這趟的附件');
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  const sales = store.refFilePath('測試', 'wf', 'sales.csv');
  return { runner, adapter, store, run, r, sales, upload: path.join(inDir, '明細.csv'), att: path.join(inDir, '附件.md') };
}

test('ADR-009 ①：三步流程只有第一步掛 sales.csv、第二步引用上傳欄位 → 三步的 attachments 都含 sales.csv、那份上傳與本次附件；本步自己掛的在前、去重、附件最後', async () => {
  const { adapter, r, sales, upload, att } = await runUnion(UNION_DEF);
  assert.equal(r.status, 'done');
  const atts = (id) => workerCalls(adapter, id)[0].attachments;
  assert.deepEqual(atts('a'), [sales, upload, att], '第一步：自己掛的 sales.csv 在前，第二步的上傳接後面，附件最後');
  assert.deepEqual(atts('b'), [sales, upload, att], '第二步：自己沒掛參考檔也沒被算成上傳讀者（有 AI 祖先），全部來自其他步驟，照 def.nodes 順序');
  assert.deepEqual(atts('c'), [sales, upload, att], '第三步：什麼都沒掛也看得到全部原始檔');
  for (const id of ['a', 'b', 'c']) {
    assert.equal(new Set(atts(id)).size, atts(id).length, `${id} 步沒有重複路徑`);
    assert.ok(atts(id).every((p) => fs.existsSync(p)), `${id} 步的每一條路徑都是真的檔`);
  }
  // memory.shared.refs 是「這步自己勾的共用參考」，不因聯集而變：流程層字串不算、沒勾的步驟不多寫
  assert.equal(r.steps.a.memory, undefined);
  assert.equal(r.steps.c.memory, undefined);
});

test('ADR-009 ①：同一份參考檔掛在兩步、上傳欄位由沒有 AI 祖先的第一步引用 → 順序＝本步自己的（參考檔→上傳）、其他步的、附件；同路徵只列一次', async () => {
  const def = structuredClone(UNION_DEF);
  def.nodes[0].instruction = '讀 {{src}} 與 sales.csv';
  def.nodes[1].instruction = '算數字';
  def.nodes[2].attachments = ['sales.csv', 'rules.md'];
  const { adapter, store, sales, upload, att } = await runUnion(def);
  const rules = store.refFilePath('測試', 'wf', 'rules.md'); // 沒上傳這個檔＝路徑解不出來，不列
  assert.equal(rules, null);
  const atts = (id) => workerCalls(adapter, id)[0].attachments;
  assert.deepEqual(atts('a'), [sales, upload, att], '第一步自己掛的參考檔、自己引用的上傳、再附件；c 步的 sales.csv 同路徑不重複');
  assert.deepEqual(atts('b'), [sales, upload, att], '第二步全部來自別步：a 的參考檔與上傳（照 def.nodes 順序）、c 的 sales.csv 去重');
  assert.deepEqual(atts('c'), [sales, upload, att], '第三步自己掛的 sales.csv 在前（rules.md 不存在不列），a 的上傳接後面');
});

test('ADR-009 ②：查核員的原始資料＝同一份聯集——第三步沒掛的 CSV（第一步掛的）與第二步引用的上傳都在它的查核 prompt 裡、標題分清「這次上傳」', async () => {
  const { adapter } = await runUnion(UNION_DEF);
  for (const id of ['a', 'b', 'c']) {
    const ck = checkCalls(adapter, id)[0]?.checkPrompt;
    assert.ok(ck, `${id} 步有查核`);
    assert.ok(ck.includes('【參考檔：sales.csv】\ndate,item,qty\n2026-08-01,帽子,6'), `${id} 步查核員看得到第一步掛的 CSV：${ck.slice(ck.indexOf('# 原始資料'))}`);
    assert.ok(ck.includes('【參考檔：明細.csv（這次上傳）】\nitem,qty\n帽子,6'), `${id} 步查核員看得到第二步引用的上傳`);
    assert.ok(ck.includes('【參考檔：附件.md（這次附件）】\n這趟的附件'), `${id} 步查核員看得到本次附件`);
    assert.ok(ck.includes('# 原始資料（使用者給的檔與欄位）'), '前段標題');
  }
  const c = checkCalls(adapter, 'c')[0].checkPrompt;
  const i = (t) => { const k = c.indexOf(t); assert.notEqual(k, -1, `缺 ${t}`); return k; };
  assert.ok(i('【參考檔：sales.csv】') < i('# 前面步驟的整理（不是原始資料；跟原始資料衝突時以原始資料為準）'), '參考檔在前段');
  assert.ok(i('# 前面步驟的整理') < i('【步驟：讀資料】\n產出:a') && i('# 前面步驟的整理') < i('【步驟：算數字】\n產出:b'), '祖先產出在後段');
  assert.ok(i('【步驟：算數字】') < i('# 成品'));
});

test('ADR-009 ③④：permissions.files=true → 三步（含沒有 output_file 的）都帶 exec（cwd＝這趟 out、logPath＝prompts/<node.id>.exec.log 且目錄已建）；沒開或 false → 一律沒有 exec；fileMode 照舊只在產檔步', async () => {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  def.nodes[2].output_file = 'docx';
  const { adapter, store, run } = await runUnion(def);
  const outDir = store.runOutDir('測試', 'wf', run.run_id);
  const promptsDir = path.dirname(store.promptRecordPath('測試', 'wf', run.run_id, 'x'));
  for (const id of ['a', 'b', 'c']) {
    const call = workerCalls(adapter, id)[0];
    assert.ok(call.exec, `${id} 步要帶 exec`);
    assert.equal(call.exec.cwd, outDir, `${id} 步 cwd＝這趟的產出夾`);
    assert.equal(call.exec.logPath, path.join(promptsDir, `${id}.exec.log`), `${id} 步 logPath 落在卷宗目錄、檔名 <node.id>.exec.log`);
    assert.ok(path.isAbsolute(call.exec.logPath));
    assert.ok(fs.existsSync(path.dirname(call.exec.logPath)), 'prompts 目錄先建好，籠子才能直接 append');
    assert.ok(!fs.existsSync(call.exec.logPath), 'runner 只給路徑不建檔（有沒有執行由籠子寫）');
    assert.equal(call.exec.outPath, path.join(promptsDir, `${id}.exec.out`), `${id} 步 outPath 落在卷宗目錄、檔名 <node.id>.exec.out（ADR-010 完整輸出）`);
    assert.ok(!fs.existsSync(call.exec.outPath), 'exec.out 也是籠子寫，runner 不建檔');
    assert.deepEqual(Object.keys(call.exec).sort(), ['cwd', 'logPath', 'numbersFile', 'outPath', 'priorNumbersFiles'], '數字檔約定（US-110）兩個欄位＋完整輸出路徑（US-109）');
  }
  assert.equal(workerCalls(adapter, 'a')[0].fileMode, undefined, '沒 output_file 的步不進產檔模式（exec 與 fileMode 各自獨立）');
  assert.ok(workerCalls(adapter, 'c')[0].fileMode?.fileName.endsWith('.docx'), '產檔步 fileMode 照舊、與 exec 並存');

  const off = await runUnion(structuredClone(UNION_DEF)); // 沒有 permissions
  for (const id of ['a', 'b', 'c']) assert.equal(off.adapter.calls.find((c) => c.nodeId === id).exec, undefined, `${id} 步沒開權限不帶 exec`);
  const falsy = structuredClone(UNION_DEF);
  falsy.permissions = { files: false };
  const no = await runUnion(falsy);
  for (const id of ['a', 'b', 'c']) assert.equal(no.adapter.calls.find((c) => c.nodeId === id).exec, undefined, `${id} 步權限 false 不帶 exec`);
});

// ---- 連線輪（ADR-006）：勾了服務的步驟把那幾家的讀／寫工具名帶給 adapter；沒勾、權限關、清單沒有＝不帶 ----
test('連線：步驟勾了服務且流程權限沒關 → adapter 拿到勾的那幾家（只算已連上的）的讀類放行與寫類擋；沒勾的步驟什麼都不帶；權限關＝不帶', async () => {
  const { classifyInit } = await import('../src/connectors.js');
  const { CONNECTOR_INIT } = await import('./fixtures.js');
  const def = structuredClone(LINEAR3);
  def.nodes[0].connectors = ['claude.ai Gmail', 'claude.ai Notion'];
  def.nodes[2].connectors = ['claude.ai Google Drive'];
  const { runner, adapter, store } = setup(def);
  store.writeConnectors(classifyInit(CONNECTOR_INIT, '2026-09-22T10:00:00.000Z'));
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const a = adapter.calls.find((c) => c.nodeId === 'a');
  assert.deepEqual(a.connectors.names, ['claude.ai Gmail'], 'Notion 還沒授權，不給');
  assert.ok(a.connectors.read.includes('mcp__claude_ai_Gmail__search_threads'));
  assert.ok(!a.connectors.read.includes('mcp__claude_ai_Gmail__send_message') && a.connectors.blocked.includes('mcp__claude_ai_Gmail__send_message'));
  assert.ok(a.connectors.others.includes('mcp__claude_ai_Google_Drive__*'));
  assert.equal(adapter.calls.find((c) => c.nodeId === 'b').connectors, undefined, '沒勾的步驟不帶');
  assert.deepEqual(adapter.calls.find((c) => c.nodeId === 'c').connectors.names, ['claude.ai Google Drive']);

  const off = structuredClone(def);
  off.permissions = { connectors: false };
  const s2 = setup(off);
  s2.store.writeConnectors(classifyInit(CONNECTOR_INIT, '2026-09-22T10:00:00.000Z'));
  const r2 = s2.runner.startRun('測試', 'wf', {});
  await s2.runner.runUntilPause('測試', 'wf', r2.run_id);
  assert.ok(s2.adapter.calls.filter((c) => c.nodeId).every((c) => c.connectors === undefined), '權限關＝一家都不給');

  const s3 = setup(def); // 從沒抓過清單
  const r3 = s3.runner.startRun('測試', 'wf', {});
  await s3.runner.runUntilPause('測試', 'wf', r3.run_id);
  assert.equal(s3.adapter.calls.find((c) => c.nodeId === 'a').connectors, undefined, '清單沒有＝不給');
});

// L053：勾了「已連上但零個讀類動作」的服務，不能為它拔嚴格模式、也不能多載其他服務的說明——沒有一個能讀的動作＝跟沒勾一樣
test('連線（L053）：勾的服務已連上但零個讀類動作 → 不帶 connectors（照舊輕裝嚴格）；跟有讀類動作的一起勾，只帶有讀類動作的那家', async () => {
  const cache = {
    checked_at: '2026-09-22T10:00:00.000Z',
    servers: [
      { name: 'claude.ai Slack', label: 'Slack', status: 'connected', source: 'claudeai', summary: '沒有只讀的動作可用；會改東西的 2 種動作擋著', read_tools: [], blocked_tools: ['mcp__claude_ai_Slack__send_message', 'mcp__claude_ai_Slack__delete_message'] },
      { name: 'claude.ai Gmail', label: 'Gmail', status: 'connected', source: 'claudeai', summary: '可讀信、搜信', read_tools: ['mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread'], blocked_tools: ['mcp__claude_ai_Gmail__send_message'] },
      { name: 'my-crm', label: 'my-crm', status: 'connected', source: 'user', summary: '可以讀 1 種資料', read_tools: ['mcp__my_crm__getCustomer'], blocked_tools: ['mcp__my_crm__syncAll'] },
    ],
  };
  const def = structuredClone(LINEAR3);
  def.nodes[0].connectors = ['claude.ai Slack']; // 只勾零讀類的
  def.nodes[1].connectors = ['claude.ai Slack', 'claude.ai Gmail']; // 混勾
  def.nodes[2].connectors = ['claude.ai Gmail'];
  const { runner, adapter, store } = setup(def);
  store.writeConnectors(cache);
  const run = runner.startRun('測試', 'wf', {});
  await runner.runUntilPause('測試', 'wf', run.run_id);
  const a = adapter.calls.find((c) => c.nodeId === 'a');
  assert.equal(a.connectors, undefined, '零個讀類動作的服務＝跟沒勾一樣，不拔嚴格模式');
  const b = adapter.calls.find((c) => c.nodeId === 'b');
  assert.deepEqual(b.connectors.names, ['claude.ai Gmail'], '混勾只帶有讀類動作的那家');
  assert.deepEqual(b.connectors.labels, ['Gmail']);
  assert.deepEqual(b.connectors.read, ['mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread']);
  assert.ok(b.connectors.others.includes('mcp__claude_ai_Slack__*'), '零讀類那家整家當沒勾的擋掉');
  assert.ok(b.connectors.others.includes('mcp__my_crm__*'));
  assert.deepEqual(adapter.calls.find((c) => c.nodeId === 'c').connectors.names, ['claude.ai Gmail'], '正常勾法逐字不變');
});

// ---- 數字檔約定（US-110）：流程開了寫檔 → 每個 AI 步驟帶 numbersFile（數字-<步驟id>.json）與 priorNumbersFiles（祖先 task 步驟裡此刻真的在本趟資料夾的數字檔）----
// 三步 a→b→c，c 產 docx；用 executeNode 包一層模擬 a 寫出自己的數字檔、b 沒寫（工人可以不寫）
async function runNumbers(def, { writers = ['a'], onCheck = null } = {}) {
  const { runner, adapter, store } = setup(def);
  const orig = adapter.executeNode;
  adapter.executeNode = async (args) => {
    if (writers.includes(args.nodeId) && args.exec?.numbersFile) fs.writeFileSync(path.join(args.exec.cwd, args.exec.numbersFile), JSON.stringify({ total: 6 }));
    return orig(args);
  };
  if (onCheck) adapter.setCheckResponse(onCheck);
  const run = runner.startRun('測試', 'wf', { src: '明細.csv' });
  fs.writeFileSync(path.join(store.runInDir('測試', 'wf', run.run_id), '明細.csv'), 'item,qty\n帽子,6');
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  return { runner, adapter, store, run, r };
}

test('數字檔：permissions.files=true → 每步 exec 帶 numbersFile＝數字-<node.id>.json；priorNumbersFiles 只列祖先裡真的存在的（a 寫了、b 沒寫 → c 只看到 a 的）；產檔步驟 fileMode 也帶同一組', async () => {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  def.nodes[2].output_file = 'docx';
  const { adapter, store, run, r } = await runNumbers(def);
  assert.equal(r.status, 'done');
  const a = workerCalls(adapter, 'a')[0];
  const b = workerCalls(adapter, 'b')[0];
  const c = workerCalls(adapter, 'c')[0];
  assert.equal(a.exec.numbersFile, '數字-a.json');
  assert.deepEqual(a.exec.priorNumbersFiles, [], '第一步沒有前面的數字檔');
  assert.equal(b.exec.numbersFile, '數字-b.json');
  assert.deepEqual(b.exec.priorNumbersFiles, ['數字-a.json'], 'a 真的寫了才列');
  assert.equal(c.exec.numbersFile, '數字-c.json');
  assert.deepEqual(c.exec.priorNumbersFiles, ['數字-a.json'], 'b 沒寫＝不列（工人沒東西可讀就不提）');
  assert.equal(c.fileMode.numbersFile, '數字-c.json', '產檔步驟走 fileMode 欄位');
  assert.deepEqual(c.fileMode.priorNumbersFiles, ['數字-a.json']);
  assert.deepEqual(Object.keys(c.fileMode).sort(), ['cwd', 'fileName', 'numbersFile', 'priorNumbersFiles', 'templatePath']);
  assert.ok(fs.existsSync(path.join(store.runOutDir('測試', 'wf', run.run_id), '數字-a.json')), '數字檔就躺在本趟資料夾');
  assert.equal(r.steps.a.file, undefined, '數字檔不是成品，不登記成 step.file');
});

test('數字檔：流程沒開寫檔 → exec 不存在、產檔步驟降級也沒有 fileMode，兩個欄位哪裡都不出現', async () => {
  const def = structuredClone(UNION_DEF);
  def.nodes[2].output_file = 'docx';
  const { adapter } = await runNumbers(def);
  for (const id of ['a', 'b', 'c']) {
    const call = workerCalls(adapter, id)[0];
    assert.equal(call.exec, undefined, `${id} 步沒開權限不帶 exec`);
    assert.equal(call.fileMode, undefined, `${id} 步沒開權限不進產檔模式`);
    assert.ok(!('numbersFile' in call) && !('priorNumbersFiles' in call), '欄位不會漏到頂層');
  }
});

test('數字檔：查核攔下自動重做 → 重做那次的 numbersFile／priorNumbersFiles 與第一次同一組值', async () => {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  const { adapter } = await runNumbers(def, { onCheck: (n, meta) => (meta.node === 'b' && n === 1 ? CHECK_BLOCKED : CHECK_PASS) });
  const bCalls = workerCalls(adapter, 'b');
  assert.equal(bCalls.length, 2, '攔下就重做一次');
  assert.ok(bCalls[1].redo, '第二次是重做');
  assert.equal(bCalls[1].exec.numbersFile, bCalls[0].exec.numbersFile);
  assert.deepEqual(bCalls[1].exec.priorNumbersFiles, bCalls[0].exec.priorNumbersFiles);
  assert.deepEqual(bCalls[1].exec.priorNumbersFiles, ['數字-a.json']);
});

// ---- ADR-010 決策 1（US-109）：成品裡的數字由程式對出處——exec.out（籠子另存的完整輸出）＋數字檔＋祖先成品＋原始資料 ----
// 用 executeNode 包一層模擬工人：a 印了 exec.out、寫了數字檔；b 只交文字
async function runSourced(def, { outputs = {}, execOut = null, numbers = null, onCheck = CHECK_PASS, note = undefined } = {}) {
  const { runner, adapter, store } = setup(def);
  const orig = adapter.executeNode;
  adapter.executeNode = async (args) => {
    if (args.nodeId === 'a' && args.exec) {
      if (execOut) fs.writeFileSync(args.exec.outPath, execOut, 'utf8');
      if (numbers) fs.writeFileSync(path.join(args.exec.cwd, args.exec.numbersFile), numbers, 'utf8');
    }
    return orig(args);
  };
  for (const [nid, text] of Object.entries(outputs)) adapter.setOutput(nid, text);
  adapter.setCheckResponse(onCheck);
  const run = runner.startRun('測試', 'wf', { src: '明細.csv' }, note === undefined ? {} : { note });
  fs.writeFileSync(path.join(store.runInDir('測試', 'wf', run.run_id), '明細.csv'), 'item,qty\n帽子,6');
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  return { runner, adapter, store, run, r };
}

test('程式對數字：成品的數字在 exec.out、數字檔、祖先成品、原始資料任一裡找得到 → 過；都找不到 → 攔一條 number-unsourced、重做一次記 redone、first_blocks 留著；查核員照樣只被問一次', async () => {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  const outputs = {
    a: '8 月營收 258,450 元，成長 14.4%；帽子 6 件；範圍八月',
    b: '營收 258,450 元（來自上一步），退貨率 15.7%',
    c: '沿用：258,450 元',
  };
  // 258450 在 exec.out、14.4 在數字檔、6 在原始資料（明細.csv）、b 的 258,450 在祖先 a 的成品；b 的 15.7% 哪裡都沒有
  const { r, adapter } = await runSourced(def, { outputs, execOut: '### calc.js 2026-09-24T00:00:00.000Z code=0\n八月營收: 258450\n\n', numbers: JSON.stringify({ 增減百分比: 14.43 }) });
  assert.equal(r.status, 'done');
  assert.equal(r.steps.a.check.status, 'pass', `a 的數字都有出處：${JSON.stringify(r.steps.a.check.blocks)}`);
  assert.equal(r.steps.a.check.numbers_checked, 3, '258,450、14.4%、6 三個量（8 月不算）');
  assert.equal(workerCalls(adapter, 'a').length, 1);
  assert.equal(r.steps.b.check.status, 'redone', '15.7% 沒出處 → 攔 → 重做一次 → 直接放行');
  assert.equal(r.steps.b.status, 'done');
  assert.equal(r.steps.b.check.first_blocks.length, 1);
  assert.equal(r.steps.b.check.first_blocks[0].kind, 'number-unsourced');
  assert.equal(r.steps.b.check.first_blocks[0].claim, '營收 258,450 元（來自上一步），退貨率 15.7%');
  assert.equal(r.steps.b.check.first_blocks[0].source, '');
  assert.equal(workerCalls(adapter, 'b').length, 2, '攔下重做一次');
  assert.equal(workerCalls(adapter, 'b')[1].redo.blocks[0].kind, 'number-unsourced', '退回清單帶給工人');
  assert.equal(checkCalls(adapter, 'b').length, 1, '程式攔的那次查核員也只被問一次');
  assert.equal(r.steps.c.check.status, 'pass', 'c 的 258,450 在祖先 a 的成品裡（b 重做後的成品是「產出:b」）');
  assert.equal(r.steps.a.attempts[0].check.status, 'pass');
  assert.deepEqual(r.steps.b.attempts.map((x) => x.check.status), ['blocked', 'redone']);
});

test('程式對數字：exec.out 不存在＝當空、數字檔壞 JSON＝當沒有——只剩原始資料當來源；程式攔的 blocks 與查核員的 blocks 合併進同一個 check', async () => {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  const { r } = await runSourced(def, {
    outputs: { a: '帽子 6 件，退貨率 15.7%' },
    numbers: '{壞掉的 json',
    onCheck: (n, meta) => (meta.node === 'a' && n === 1 ? CHECK_BLOCKED : CHECK_PASS),
  });
  assert.equal(r.steps.a.check.status, 'redone');
  assert.deepEqual(r.steps.a.check.first_blocks.map((b) => b.kind), ['number-unsourced', 'number-mismatch'], '程式的攔在前、查核員的攔在後，合併在同一份');
  assert.equal(r.steps.a.attempts[0].check.status, 'blocked');
  assert.equal(r.steps.a.attempts[0].check.blocks.length, 2);
  assert.equal(r.steps.a.check.summary, '數字對不上', 'summary 沿用查核員第一次的');
});

test('程式對數字：流程關掉「數字對原始資料」（facts:false）→ 只跑查核員的必守版，程式一個數字都不對（逐字舊行為）；查核關掉也不對', async () => {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  def.check = { enabled: true, facts: false };
  const { r, adapter } = await runSourced(def, { outputs: { a: '退貨率 15.7%，成長 60.9%' } });
  assert.equal(r.steps.a.check.status, 'pass');
  assert.equal(r.steps.a.check.numbers_checked, undefined, 'factsOff 連 checked 都不記');
  assert.equal(workerCalls(adapter, 'a').length, 1, '沒被攔、沒重做');
  const off = structuredClone(UNION_DEF);
  off.permissions = { files: true };
  off.check = { enabled: false };
  const o = await runSourced(off, { outputs: { a: '退貨率 15.7%' } });
  assert.equal(o.r.steps.a.check.status, 'off');
  assert.equal(workerCalls(o.adapter, 'a').length, 1);
});

test('程式對數字：原始資料不套查核員那個每檔 20,000／總量 80,000 字上限——參考檔尾端的數字被查核員的卷宗截掉，程式照樣找得到', async () => {
  const def = structuredClone(UNION_DEF);
  const { r, adapter, store } = await (async () => {
    const s = setup(def);
    s.store.writeRefFile('測試', 'wf', 'sales.csv', Buffer.from(`${'x,1\n'.repeat(30000)}總數,999123\n`, 'utf8'));
    s.adapter.setOutput('a', '總數 999,123');
    s.adapter.setCheckResponse(CHECK_PASS);
    const run = s.runner.startRun('測試', 'wf', { src: '明細.csv' });
    fs.writeFileSync(path.join(s.store.runInDir('測試', 'wf', run.run_id), '明細.csv'), 'item,qty\n帽子,6');
    const r = await s.runner.runUntilPause('測試', 'wf', run.run_id);
    return { ...s, r, run };
  })();
  assert.ok(!checkCalls(adapter, 'a')[0].checkPrompt.includes('999123'), '查核員的卷宗被截掉了開頭');
  assert.equal(r.steps.a.check.status, 'pass', `程式對數字看的是全文：${JSON.stringify(r.steps.a.check.blocks)}`);
  assert.equal(r.steps.a.check.numbers_checked, 1);
  assert.ok(store, '（store 只是為了拿路徑）');
});

test('程式對數字：沒開寫檔權限也照對（來源只有祖先成品與原始資料）、找得到出處＝pass；成品沒數字＝checked 0；沒開權限找不到出處＝只標一條 number-unsourced 黃旗、不攔不重做', async () => {
  const { r, adapter } = await runSourced(structuredClone(UNION_DEF), { outputs: { a: '帽子 6 件', b: '帽子 6 件，另外 3 件，退貨率 15.7%', c: '沒有數字' } });
  assert.equal(r.steps.a.check.status, 'pass');
  assert.equal(r.steps.a.check.numbers_checked, 1);
  assert.equal(r.steps.b.check.status, 'pass', '工人根本沒法印數字：找不到出處只標不攔');
  assert.equal(r.steps.b.status, 'done');
  assert.deepEqual(r.steps.b.check.blocks, []);
  assert.deepEqual(r.steps.b.check.flags, [{ kind: 'number-unsourced', detail: '有 2 個數字找不到出處（這條流程沒開「允許寫檔與執行程式」，無法由程式對）：3、15.7%' }]);
  assert.equal(r.steps.b.check.numbers_checked, 3);
  assert.equal(workerCalls(adapter, 'b').length, 1, '沒重做');
  assert.deepEqual(r.steps.b.attempts.map((x) => x.check.status), ['pass']);
  assert.equal(r.steps.c.check.numbers_checked, 0);
  assert.equal(r.status, 'done');
});

test('程式對數字：沒開寫檔權限的黃旗最多列前三個數字；開了權限＝照舊攔下重做', async () => {
  const off = await runSourced(structuredClone(UNION_DEF), { outputs: { a: '帽子 6 件', b: '另外 3 件、4 件、5 件、7 件', c: '沒有數字' } });
  assert.equal(off.r.steps.b.check.flags[0].detail, '有 4 個數字找不到出處（這條流程沒開「允許寫檔與執行程式」，無法由程式對）：3、4、5');
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  const on = await runSourced(def, { outputs: { a: '帽子 6 件', b: '帽子 6 件，另外 3 件', c: '沒有數字' } });
  assert.equal(on.r.steps.b.check.status, 'redone', '開了權限：找不到出處照舊攔、重做一次');
  assert.deepEqual(on.r.steps.b.check.flags, [], '攔了就不另標黃旗');
  assert.equal(on.r.steps.b.check.first_blocks[0].kind, 'number-unsourced');
  assert.equal(workerCalls(on.adapter, 'b').length, 2);
});

test('程式對數字：查核員判 missing 就維持 missing（走資料不全卡）——程式攔到的 blocks 只寫進 check.blocks 當紀錄，不觸發重做', async () => {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  const { r, adapter } = await runSourced(def, { outputs: { a: '帽子 6 件', b: '帽子 6 件，另外 3 件', c: '沒有數字' }, onCheck: (n, meta) => (meta.node === 'b' ? CHECK_MISSING : CHECK_PASS) });
  assert.equal(r.steps.b.check.status, 'missing', 'missing 不被程式的攔吞掉');
  assert.equal(r.steps.b.status, 'waiting_data');
  assert.equal(r.steps.b.data_note, '查核發現原始資料裡沒有：退貨率 3%');
  assert.equal(r.steps.b.check.blocks.length, 1, '程式攔到的留在 blocks 當紀錄');
  assert.equal(r.steps.b.check.blocks[0].kind, 'number-unsourced');
  assert.equal(r.steps.b.check.numbers_checked, 2);
  assert.equal(workerCalls(adapter, 'b').length, 1, '沒有第二次工人呼叫');
  assert.equal(r.status, 'paused', '停在資料不全卡等人');
});

// ---- 查核員判 missing 的數字主張若程式已對到出處就不停（US-109／ADR-010 決策 2 修 bug）----
// 真趟 q10：查核員違反「數字一律不列」列了「官網 7 月營收 75,590 元」判 missing，但那個數程式對得到（exec.out 有）——不准停下叫人
const missingClaim = (claim) => JSON.stringify({
  items: [{ claim, source: '', scope: '7 月', calc: '原始資料與前面步驟都沒有 7 月各通路營收數字', verdict: 'missing' }],
  must_violations: [], flags: [], summary: '缺 7 月營收',
});
const EXEC_75590 = '### calc.js 2026-09-24T00:00:00.000Z code=0\n官網7月營收: 75590\n\n';

test('missing 數字主張 (a)：查核員判 missing 的 claim 含 75,590、exec.out 有 75590 → 程式已對到出處 → 不是 missing、不產生 waiting_data、流程走到 done；那條留在 items 當紀錄', async () => {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  const { r, adapter } = await runSourced(def, {
    outputs: { a: '官網 7 月營收 75,590 元', b: '沒有數字', c: '沒有數字' },
    execOut: EXEC_75590,
    onCheck: (n, meta) => (meta.node === 'a' ? missingClaim('官網 7 月營收 75,590 元') : CHECK_PASS),
  });
  assert.equal(r.status, 'done', '不停下叫人');
  assert.equal(r.steps.a.status, 'done');
  assert.notEqual(r.steps.a.check.status, 'missing');
  assert.equal(r.steps.a.check.status, 'pass');
  assert.deepEqual(r.steps.a.check.missing, [], '程式對到出處的那條從 missing 拿掉');
  assert.equal(r.steps.a.check.items.length, 1, '留在 items 當紀錄');
  assert.equal(r.steps.a.check.items[0].verdict, 'missing', 'verdict 照舊');
  assert.equal(r.steps.a.data_note, undefined, '沒有資料不全卡');
  assert.equal(workerCalls(adapter, 'a').length, 1, '不重做');
  assert.deepEqual(r.steps.a.attempts.map((x) => x.check.status), ['pass']);
});

test('missing 數字主張 (a′)：數字在祖先成品裡（下游步驟的查核員判 missing）也算程式對到出處', async () => {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  const { r } = await runSourced(def, {
    outputs: { a: '官網 7 月營收 75,590 元', b: '官網 7 月營收 75,590 元（來自上一步）', c: '沒有數字' },
    execOut: EXEC_75590,
    onCheck: (n, meta) => (meta.node === 'b' ? missingClaim('官網 7 月營收 75,590 元') : CHECK_PASS),
  });
  assert.equal(r.status, 'done');
  assert.equal(r.steps.b.status, 'done');
  assert.equal(r.steps.b.check.status, 'pass');
});

test('missing 數字主張 (b)：同 claim 但來源沒有 75590 → 照舊 missing 停下', async () => {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  const { r, adapter } = await runSourced(def, {
    outputs: { a: '官網 7 月營收 75,590 元', b: '沒有數字', c: '沒有數字' },
    onCheck: (n, meta) => (meta.node === 'a' ? missingClaim('官網 7 月營收 75,590 元') : CHECK_PASS),
  });
  assert.equal(r.status, 'paused');
  assert.equal(r.steps.a.status, 'waiting_data');
  assert.equal(r.steps.a.check.status, 'missing');
  assert.equal(r.steps.a.check.missing.length, 1);
  assert.equal(r.steps.a.data_note, '查核發現原始資料裡沒有：官網 7 月營收 75,590 元');
  assert.equal(workerCalls(adapter, 'a').length, 1);
});

test('missing 數字主張 (c)：沒有量數字的 missing（「9 月資料沒有」「指示要的客戶名單原始資料沒有」）照舊停下——年月日不算量', async () => {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  const { r } = await runSourced(def, {
    outputs: { a: '9 月資料如下', b: '沒有數字', c: '沒有數字' },
    execOut: EXEC_75590,
    onCheck: (n, meta) => (meta.node === 'a' ? JSON.stringify({
      items: [
        { claim: '9 月資料沒有', source: '', scope: '9 月', calc: '', verdict: 'missing' },
        { claim: '指示要的客戶名單原始資料沒有（2026-09-01 起）', source: '', scope: '全部', calc: '', verdict: 'missing' },
      ],
      must_violations: [], flags: [], summary: '缺資料',
    }) : CHECK_PASS),
  });
  assert.equal(r.status, 'paused');
  assert.equal(r.steps.a.status, 'waiting_data');
  assert.equal(r.steps.a.check.status, 'missing');
  assert.equal(r.steps.a.check.missing.length, 2, '兩條都沒有量數字，都留著');
});

test('missing 數字主張 (d)：流程關掉「數字對原始資料」（facts:false）→ 程式沒對過，不能替查核員背書，照舊停下', async () => {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  def.check = { enabled: true, facts: false };
  const { r } = await runSourced(def, {
    outputs: { a: '官網 7 月營收 75,590 元', b: '沒有數字', c: '沒有數字' },
    execOut: EXEC_75590,
    onCheck: (n, meta) => (meta.node === 'a' ? missingClaim('官網 7 月營收 75,590 元') : CHECK_PASS),
  });
  assert.equal(r.status, 'paused');
  assert.equal(r.steps.a.status, 'waiting_data');
  assert.equal(r.steps.a.check.status, 'missing');
  assert.equal(r.steps.a.check.missing.length, 1);
});

test('missing 數字主張：混合清單——有出處的數字項拿掉、沒數字的留著 → 仍 missing、data_note 只列留著的那條', async () => {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  const { r } = await runSourced(def, {
    outputs: { a: '官網 7 月營收 75,590 元', b: '沒有數字', c: '沒有數字' },
    execOut: EXEC_75590,
    onCheck: (n, meta) => (meta.node === 'a' ? JSON.stringify({
      items: [
        { claim: '官網 7 月營收 75,590 元', source: '', scope: '7 月', calc: '', verdict: 'missing' },
        { claim: '指示要的客戶名單原始資料沒有', source: '', scope: '全部', calc: '', verdict: 'missing' },
      ],
      must_violations: [], flags: [], summary: '缺資料',
    }) : CHECK_PASS),
  });
  assert.equal(r.steps.a.status, 'waiting_data');
  assert.equal(r.steps.a.check.status, 'missing');
  assert.deepEqual(r.steps.a.check.missing.map((x) => x.claim), ['指示要的客戶名單原始資料沒有']);
  assert.equal(r.steps.a.data_note, '查核發現原始資料裡沒有：指示要的客戶名單原始資料沒有');
  assert.equal(r.steps.a.check.items.length, 2, 'items 兩條都留著當紀錄');
});

test('程式對數字：本次補充與這一步的要求文字也是來源——補充寫「目標 300 萬」、指示寫「前 5 名」，成品照寫不攔', async () => {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  def.nodes[1].instruction = '用 {{src}} 算，列出前 5 名';
  def.nodes[1].constraints = '只看 3 個通路';
  const { r, adapter } = await runSourced(def, { outputs: { a: '帽子 6 件', b: '目標 300 萬，前 5 名如下，3 個通路都有', c: '沒有數字' }, note: '這次目標 300 萬' });
  assert.equal(r.steps.b.check.status, 'pass', `補充與指示裡的數字都算有出處：${JSON.stringify(r.steps.b.check.blocks)}`);
  assert.equal(r.steps.b.check.numbers_checked, 3);
  assert.equal(workerCalls(adapter, 'b').length, 1);
  // 對照：拿掉補充與指示裡的數字就攔
  const bare = structuredClone(UNION_DEF);
  bare.permissions = { files: true };
  const b2 = await runSourced(bare, { outputs: { a: '帽子 6 件', b: '目標 300 萬，前 5 名如下', c: '沒有數字' } });
  assert.equal(b2.r.steps.b.check.status, 'redone');
  assert.deepEqual(b2.r.steps.b.check.first_blocks.map((x) => x.number), ['300 萬', '5']);
});

// ---- 重寫覆驗（US-112／ADR-011）：攔到重寫一次之後，重寫那份再由程式對一次數字（零額度、不叫查核員、不停下），結果記 check.recheck_blocks ----
// 重做那份的成品由 redo 決定：第一份帶 15.7%（哪裡都沒有 → 攔），重寫那份看測試給什麼
function redoAware(adapter, nodeId, firstText, redoText) {
  const orig = adapter.executeNode;
  adapter.executeNode = async (args) => {
    if (args.nodeId === nodeId) { await orig(args); return args.redo ? redoText : firstText; }
    return orig(args);
  };
}
// 三步：a 的 258,450 由 exec.out 印出（a 自己要過關，祖先成品才乾淨）、b 第一份帶沒出處的 15.7% 被攔、重寫那份看 redo；c 沒數字
async function runRecheck({ first, redo, prep = () => {} }) {
  const def = structuredClone(UNION_DEF);
  def.permissions = { files: true };
  const { runner, adapter, store } = setup(def);
  prep(store);
  const orig = adapter.executeNode;
  adapter.executeNode = async (args) => {
    if (args.nodeId === 'a' && args.exec) fs.writeFileSync(args.exec.outPath, '### calc.js 2026-09-24T00:00:00.000Z code=0\n八月營收: 258450\n\n', 'utf8');
    return orig(args);
  };
  redoAware(adapter, 'b', first, redo);
  adapter.setOutput('a', '8 月營收 258,450 元');
  adapter.setOutput('c', '沒有數字');
  adapter.setCheckResponse(CHECK_PASS); // 查核員都放行：攔不攔全看程式對數字
  const run = runner.startRun('測試', 'wf', { src: '明細.csv' });
  fs.writeFileSync(path.join(store.runInDir('測試', 'wf', run.run_id), '明細.csv'), 'item,qty\n帽子,6');
  const r = await runner.runUntilPause('測試', 'wf', run.run_id);
  return { runner, adapter, store, run, r };
}

test('US-112 (a)：攔到 → 重寫一次 → 重寫那份數字全對上 → check.recheck_blocks=[]、status 仍 redone、blocks 空、first_blocks 留著；attempts 的 redo 那筆也帶 recheck_blocks', async () => {
  const { r, adapter } = await runRecheck({ first: '營收 258,450 元，退貨率 15.7%', redo: '營收 258,450 元（來自上一步）' });
  assert.equal(r.status, 'done');
  assert.equal(r.steps.a.check.status, 'pass', 'a 的 258,450 在 exec.out 裡，一次過關');
  assert.equal(workerCalls(adapter, 'a').length, 1);
  const ck = r.steps.b.check;
  assert.equal(ck.status, 'redone');
  assert.deepEqual(ck.blocks, [], '沒有人在等：blocks 仍空');
  assert.deepEqual(ck.recheck_blocks, [], '重寫那份的 258,450 在祖先 a 的成品裡 → 全對上');
  assert.equal(ck.first_blocks.length, 1);
  assert.equal(ck.first_blocks[0].kind, 'number-unsourced');
  assert.equal(r.steps.b.attempts[1].reason, 'redo');
  assert.deepEqual(r.steps.b.attempts[1].check, { status: 'redone', blocks: [], flags: [], recheck_blocks: [] });
  assert.equal(r.steps.b.status, 'done');
});

test('US-112 (b)：重寫那份仍有找不到出處的數字 → recheck_blocks 列出它、status 仍 redone、不攔不停、流程往下走到底', async () => {
  const { r, adapter } = await runRecheck({ first: '營收 258,450 元，退貨率 15.7%', redo: '營收 258,450 元，退貨率改成 15.9%' });
  assert.equal(r.status, 'done', '不停下叫人');
  const ck = r.steps.b.check;
  assert.equal(ck.status, 'redone', '不論結果都放行，status 不變');
  assert.deepEqual(ck.blocks, []);
  assert.equal(ck.recheck_blocks.length, 1);
  assert.equal(ck.recheck_blocks[0].kind, 'number-unsourced');
  assert.equal(ck.recheck_blocks[0].number, '15.9%');
  assert.equal(ck.first_blocks[0].number, '15.7%', '第一次攔的照舊留著，不被重寫那份蓋掉');
  assert.equal(r.steps.b.attempts[1].check.recheck_blocks.length, 1);
  assert.equal(r.steps.b.status, 'done');
  assert.equal(r.steps.c.status, 'done', '下一步照跑');
  assert.equal(workerCalls(adapter, 'b').length, 2, '只重寫一次，不迴圈');
});

test('US-112 (c)：重寫時只多一次程式比對（b.exec.out 被讀兩次、沒被攔的 a 只讀一次），AI 查核員仍只被問一次', async () => {
  const reads = {};
  const prep = (store) => {
    const origRead = store.readPromptRecord;
    store.readPromptRecord = (...args) => { const name = args[3]; if (String(name).endsWith('.exec.out')) reads[name] = (reads[name] ?? 0) + 1; return origRead(...args); };
  };
  const { r, adapter } = await runRecheck({ first: '營收 258,450 元，退貨率 15.7%', redo: '營收 258,450 元', prep });
  assert.equal(r.steps.a.check.status, 'pass');
  assert.equal(r.steps.b.check.status, 'redone');
  assert.equal(reads['a.exec.out'], 1, '沒被攔的一步：程式只對一次');
  assert.equal(reads['b.exec.out'], 2, '被攔重寫的一步：第一份對一次、重寫那份再對一次');
  assert.equal(checkCalls(adapter, 'b').length, 1, 'AI 查核員仍只一次');
  assert.equal(checkCalls(adapter, 'a').length, 1);
});

test('US-112：沒開「允許寫檔與執行程式」比照第一層——重寫那份照樣對、recheck_blocks 一樣填（只標不攔）；關掉「數字對原始資料」（facts:false）＝程式沒對過，recheck_blocks 缺席', async () => {
  // 沒開寫檔：第一層由查核員攔（程式的只收黃旗），重寫那份的 15.9% 仍找不到出處 → recheck_blocks 有它，status 仍 redone
  const noFiles = structuredClone(UNION_DEF);
  const s1 = setup(noFiles);
  s1.adapter.setCheckResponse((n, meta) => (meta.node === 'b' && n === 1 ? CHECK_BLOCKED : CHECK_PASS));
  redoAware(s1.adapter, 'b', '退貨率 15.7%', '退貨率 15.9%');
  s1.adapter.setOutput('a', '帽子 6 件');
  s1.adapter.setOutput('c', '沒有數字');
  const run1 = s1.runner.startRun('測試', 'wf', { src: '明細.csv' });
  fs.writeFileSync(path.join(s1.store.runInDir('測試', 'wf', run1.run_id), '明細.csv'), 'item,qty\n帽子,6');
  const r1 = await s1.runner.runUntilPause('測試', 'wf', run1.run_id);
  assert.equal(r1.steps.b.check.status, 'redone');
  assert.deepEqual(r1.steps.b.check.recheck_blocks.map((b) => b.number), ['15.9%'], '沒程式權限也填，前端讀到就顯示');
  assert.equal(r1.status, 'done');
  // facts:false：程式從頭到尾沒對數字，重寫那份也不對 → 欄位缺席（前端退回「重寫一次」）
  const off = structuredClone(UNION_DEF);
  off.permissions = { files: true };
  off.check = { enabled: true, facts: false };
  const s2 = setup(off);
  s2.adapter.setCheckResponse((n, meta) => (meta.node === 'b' && n === 1 ? CHECK_BLOCKED : CHECK_PASS));
  redoAware(s2.adapter, 'b', '退貨率 15.7%', '退貨率 15.9%');
  s2.adapter.setOutput('a', '帽子 6 件');
  s2.adapter.setOutput('c', '沒有數字');
  const run2 = s2.runner.startRun('測試', 'wf', { src: '明細.csv' });
  fs.writeFileSync(path.join(s2.store.runInDir('測試', 'wf', run2.run_id), '明細.csv'), 'item,qty\n帽子,6');
  const r2 = await s2.runner.runUntilPause('測試', 'wf', run2.run_id);
  assert.equal(r2.steps.b.check.status, 'redone');
  assert.equal(r2.steps.b.check.recheck_blocks, undefined, 'facts:false＝沒對過就不假裝對過');
  assert.equal(Object.hasOwn(r2.steps.b.attempts[1].check, 'recheck_blocks'), false);
});
