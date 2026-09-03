import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { validateWorkflow, SchemaError } from '../src/schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(HERE, '..', 'examples', 'quarterly-report.yaml');

function loadExample() {
  return yaml.load(fs.readFileSync(EXAMPLE, 'utf8'));
}

test('內建範例流程通過驗證：5 步直線、2 停點、第 5 步人做、3 參數', () => {
  const def = loadExample();
  validateWorkflow(def); // 不丟例外即通過
  assert.equal(def.nodes.length, 5);
  assert.equal(def.params.length, 3);
  assert.equal(def.nodes.at(-1).executor, 'human');
  const stops = def.nodes.filter((n) => n.executor === 'ai' && n.stop_point === 'always');
  assert.equal(stops.length, 2);
  for (const n of def.nodes.slice(0, -1)) assert.equal(n.next.length, 1, '直線：每節點單一 next');
  assert.equal(def.nodes.at(-1).next.length, 0, '最後一步無 next');
});

test('examples/ 內每一個內建範例都通過驗證，且數量符合 US-011（2–3 個）', () => {
  const dir = path.join(HERE, '..', 'examples');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 2 && files.length <= 3, `US-011 要 2–3 個內建範例，現有 ${files.length}`);
  for (const f of files) validateWorkflow(yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')));
});

test('未接上的步驟：預設擋（開跑用）；allowFloating 放行（編輯中存檔用）', () => {
  const def = loadExample();
  def.nodes.push({ id: 'floating', title: '還沒接的一步', executor: 'ai', stop_point: 'never', instruction: '待接', next: [] });
  assert.throws(() => validateWorkflow(def), (e) => e instanceof SchemaError && e.message.includes('還沒接進流程'));
  validateWorkflow(def, { allowFloating: true }); // 不丟例外即通過
});

test('步驟進階欄位（D18）：合法值通過；壞值逐項擋下點名', () => {
  const def = loadExample();
  Object.assign(def.nodes[0], { role_context: '你是分析師', constraints: '不編造', model_tier: 'deep', creativity: 'strict', retry: 1, review_focus: '數字對得上' });
  validateWorkflow(def); // 不丟例外即通過
  def.nodes[0].model_tier = 'ultra';
  assert.throws(() => validateWorkflow(def), (e) => e.message.includes('model_tier'));
  def.nodes[0].model_tier = 'deep';
  def.nodes[0].retry = 5;
  assert.throws(() => validateWorkflow(def), (e) => e.message.includes('retry'));
  def.nodes[0].retry = 1;
  def.nodes[0].role_context = 123;
  assert.throws(() => validateWorkflow(def), (e) => e.message.includes('role_context'));
});

test('輸出格式：文字通過；非文字擋下且訊息點名', () => {
  const def = loadExample();
  def.nodes[0].output_format = 'Markdown 表格';
  validateWorkflow(def); // 不丟例外即通過
  def.nodes[0].output_format = 123;
  assert.throws(() => validateWorkflow(def), (e) => e instanceof SchemaError && e.message.includes('output_format'));
});

test('缺 name → 擋下且訊息點名', () => {
  const def = loadExample();
  delete def.name;
  assert.throws(() => validateWorkflow(def), (e) => e instanceof SchemaError && e.message.includes('name'));
});

test('executor 亂寫 → 擋下', () => {
  const def = loadExample();
  def.nodes[0].executor = 'robot';
  assert.throws(() => validateWorkflow(def), SchemaError);
});

test('next 指向不存在的節點 → 擋下', () => {
  const def = loadExample();
  def.nodes[0].next = ['沒這個節點'];
  assert.throws(() => validateWorkflow(def), (e) => e instanceof SchemaError && e.message.includes('沒這個節點'));
});

test('節點 id 重複 → 擋下', () => {
  const def = loadExample();
  def.nodes[1].id = def.nodes[0].id;
  assert.throws(() => validateWorkflow(def), SchemaError);
});

// ---- S3：有向圖（分岔＋平行）----
import { DAG_DEF } from './fixtures.js';

test('合法分岔＋平行定義通過驗證', () => {
  validateWorkflow(DAG_DEF);
});

test('循環 → 擋（訊息含繞圈）', () => {
  const def = structuredClone(DAG_DEF);
  def.nodes.find((n) => n.id === 'done-join').next = ['fill'];
  assert.throws(() => validateWorkflow(def), (e) => e instanceof SchemaError && e.message.includes('繞圈'));
});

test('分岔少於 2 支、fork 單支、branch 指向不存在 → 全擋', () => {
  const one = structuredClone(DAG_DEF);
  one.nodes.find((n) => n.id === 'amount-check').branches.pop();
  assert.throws(() => validateWorkflow(one), SchemaError);
  const fork1 = structuredClone(DAG_DEF);
  fork1.nodes.find((n) => n.id === 'par').next = ['scan'];
  assert.throws(() => validateWorkflow(fork1), SchemaError);
  const ghost = structuredClone(DAG_DEF);
  ghost.nodes.find((n) => n.id === 'amount-check').branches[0].next = '幽靈';
  assert.throws(() => validateWorkflow(ghost), (e) => e.message.includes('幽靈'));
});

test('斷鏈（起點走不到的節點）→ 擋', () => {
  const def = structuredClone(DAG_DEF);
  def.nodes.push({ id: 'orphan', title: '孤兒', executor: 'ai', stop_point: 'never', instruction: '沒人連我', next: [] });
  assert.throws(() => validateWorkflow(def), (e) => e.message.includes('斷鏈') || e.message.includes('orphan'));
});

test('指示裡用了不存在的參數佔位 → 擋下', () => {
  const def = loadExample();
  def.nodes[0].instruction += '（範圍：{{no_such_param}}）';
  assert.throws(() => validateWorkflow(def), (e) => e instanceof SchemaError && e.message.includes('no_such_param'));
});

test('D20：wait_until 固定時刻與 {from} 合法；壞型態與幽靈引用擋下', () => {
  const ok = loadExample();
  ok.nodes[0].wait_until = '2026-08-27T14:00';
  validateWorkflow(ok);
  ok.nodes[1].wait_until = { from: ok.nodes[0].id };
  validateWorkflow(ok);
  const bad = loadExample();
  bad.nodes[0].wait_until = 123;
  assert.throws(() => validateWorkflow(bad), (e) => e.message.includes('wait_until'));
  const ghost = loadExample();
  ghost.nodes[0].wait_until = { from: '不存在的步' };
  assert.throws(() => validateWorkflow(ghost), (e) => e.message.includes('不存在的步'));
});

test('D20：節點層 remind_leads——九檔與 {at} 合法、壞值擋下', () => {
  const ok = loadExample();
  ok.nodes[0].remind_leads = ['1h', { at: '2026-01-01T00:00' }];
  validateWorkflow(ok);
  const bad = loadExample();
  bad.nodes[0].remind_leads = ['bogus'];
  assert.throws(() => validateWorkflow(bad), (e) => e.message.includes('remind_leads'));
});

// 調色盤（畫布回饋輪二）：剛放上畫布、線還沒拉滿的並行／分岔點，編輯中可存；開跑嚴格仍擋
test('編輯中（allowFloating）：空並行點與單路分岔放行；嚴格模式照擋', () => {
  const task = (id, next) => ({ id, title: id, executor: 'ai', stop_point: 'never', instruction: '做', next });
  const wip = {
    format: 1, name: '施工中', params: [],
    nodes: [task('s', ['fk']), { id: 'fk', title: '並行', kind: 'fork', next: [] },
      { id: 'br', title: '分岔', kind: 'branch', instruction: '看情況', branches: [{ label: '一', next: 's' }], next: [] }],
  };
  assert.throws(() => validateWorkflow(wip), SchemaError); // 嚴格：線不滿＋分岔繞回會另擋——只驗「有擋」
  const wip2 = {
    format: 1, name: '施工中2', params: [],
    nodes: [task('s', ['fk']), { id: 'fk', title: '並行', kind: 'fork', next: [] }],
  };
  validateWorkflow(wip2, { allowFloating: true }); // 編輯中：空並行點放行
  assert.throws(() => validateWorkflow(wip2), (e) => e.message.includes('至少要兩支'), '嚴格模式擋空並行點');
});

// 畫布回饋輪：fork/join 退場——一般節點多出線＝並行、多入線＝會合，不再需要結構節點
test('直連並行／會合：task 多個 next 合法；分岔可超過兩條路', () => {
  const task = (id, next) => ({ id, title: id, executor: 'ai', stop_point: 'never', instruction: '做', next });
  const direct = {
    format: 1, name: '直連並行', params: [],
    nodes: [task('s', ['a', 'b']), task('a', ['f']), task('b', ['f']), task('f', [])],
  };
  validateWorkflow(direct); // 舊規則「一般節點只能有一個 next」已移除
  const wide = {
    format: 1, name: '三路分岔', params: [],
    nodes: [
      task('s', ['br']),
      { id: 'br', title: '分', kind: 'branch', instruction: '看情況', branches: [
        { label: '一', next: 'a' }, { label: '二', next: 'b' }, { label: '三', next: 'c' },
      ], next: [] },
      task('a', []), task('b', []), task('c', []),
    ],
  };
  validateWorkflow(wide);
});

test('健檢 P2-04：多起點會合＝合法；孤島步驟仍算斷鏈；別支上的繞圈也抓得到', () => {
  const task = (id, next) => ({ id, title: id, executor: 'ai', stop_point: 'never', instruction: '做', next });
  const multiRoot = {
    format: 1, name: '多起點', params: [],
    nodes: [task('a', ['j']), task('b', ['j']), { id: 'j', title: '會合', kind: 'join', next: [] }],
  };
  validateWorkflow(multiRoot); // 兩顆入度 0 的起點、最後會合——嚴格模式也放行
  const island = { ...multiRoot, nodes: [...multiRoot.nodes, task('孤', [])] };
  assert.throws(() => validateWorkflow(island), (e) => e.message.includes('還沒接進流程'));
  validateWorkflow(island, { allowFloating: true }); // 編輯中照舊放行
  const cycle = {
    format: 1, name: '他支繞圈', params: [],
    nodes: [task('a', ['j']), { id: 'y', title: 'Y', kind: 'fork', next: ['x', 'j'] }, task('x', ['y']), { id: 'j', title: '會合', kind: 'join', next: [] }],
  };
  assert.throws(() => validateWorkflow(cycle), (e) => e.message.includes('繞圈'), '圈不在第一顆可達範圍也要抓到');
});
