import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { validateWorkflow, SchemaError, applyDefaults, validateSettings } from '../src/schema.js';
import { DEFAULT_SETTINGS } from '../src/store.js';

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
  assert.throws(() => validateWorkflow(def), (e) => e instanceof SchemaError && e.message.includes('還沒接進 Workflow'));
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
  assert.throws(() => validateWorkflow(def), (e) => e instanceof SchemaError && e.message.includes('缺 name（Workflow 名稱）'));
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

test('交貨查核輪：check.enabled 合法；check 非物件／enabled 非布林 → 擋下且訊息點名', () => {
  const def = loadExample();
  def.check = { enabled: false };
  validateWorkflow(def); // 不丟例外即通過
  def.check = 'yes';
  assert.throws(() => validateWorkflow(def), (e) => e instanceof SchemaError && e.message.includes('check 要是物件'));
  def.check = { enabled: 'no' };
  assert.throws(() => validateWorkflow(def), (e) => e instanceof SchemaError && e.message.includes('check.enabled 要是開或關'));
});

// ---- S3：有向圖（分岔＋平行）----
import { DAG_DEF } from './fixtures.js';

test('合法分岔＋平行定義通過驗證', () => {
  validateWorkflow(DAG_DEF);
});

test('循環 → 擋（訊息含繞圈）', () => {
  const def = structuredClone(DAG_DEF);
  def.nodes.find((n) => n.id === 'done-join').next = ['fill'];
  assert.throws(() => validateWorkflow(def), (e) => e instanceof SchemaError && e.message.includes('繞圈') && e.message.startsWith('Workflow 定義有問題：Workflow 有繞圈'));
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
  assert.throws(() => validateWorkflow(island), (e) => e.message.includes('還沒接進 Workflow'));
  validateWorkflow(island, { allowFloating: true }); // 編輯中照舊放行
  const cycle = {
    format: 1, name: '他支繞圈', params: [],
    nodes: [task('a', ['j']), { id: 'y', title: 'Y', kind: 'fork', next: ['x', 'j'] }, task('x', ['y']), { id: 'j', title: '會合', kind: 'join', next: [] }],
  };
  assert.throws(() => validateWorkflow(cycle), (e) => e.message.includes('繞圈'), '圈不在第一顆可達範圍也要抓到');
});

// —— 監工輪：流程層監工開關、數字對原始資料子開關、步驟三個勾、保留 id ——

const soloDef = (extra = {}, node = {}) => ({
  format: 1,
  name: '一步流程',
  params: [],
  nodes: [{ id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做', next: [], ...node }],
  ...extra,
});

test('監工輪：流程層 supervisor 與 check.facts 型別驗證', () => {
  validateWorkflow(soloDef({ supervisor: { enabled: false } })); // 不丟例外即通過
  validateWorkflow(soloDef({ supervisor: {} }));
  assert.throws(() => validateWorkflow(soloDef({ supervisor: 'on' })), (e) => e.message.includes('supervisor 要是物件'));
  assert.throws(() => validateWorkflow(soloDef({ supervisor: { enabled: '開' } })), (e) => e.message.includes('supervisor.enabled 要是開或關'));
  validateWorkflow(soloDef({ check: { enabled: true, facts: false } }));
  assert.throws(() => validateWorkflow(soloDef({ check: { enabled: true, facts: 'yes' } })), (e) => e.message.includes('check.facts 要是開或關'));
});

test('監工輪：步驟三個勾型別驗證；步驟 id 不能以 _ 開頭（保留給開場／收尾偽節點）', () => {
  validateWorkflow(soloDef({}, { supervisor: { note: true, tier: false, tools: false } })); // 不丟例外即通過
  assert.throws(() => validateWorkflow(soloDef({}, { supervisor: 'yes' })), (e) => e.message.includes('supervisor 要是物件'));
  assert.throws(() => validateWorkflow(soloDef({}, { supervisor: { tier: 'deep' } })), (e) => e.message.includes('supervisor.tier 要是開或關'));
  assert.throws(() => validateWorkflow(soloDef({}, { supervisor: { note: 1 } })), (e) => e.message.includes('supervisor.note 要是開或關'));
  assert.throws(() => validateWorkflow(soloDef({}, { supervisor: { tools: 'on' } })), (e) => e.message.includes('supervisor.tools 要是開或關'));
  assert.throws(() => validateWorkflow(soloDef({}, { id: '_x' })), (e) => e.message.includes('步驟 id 不能以 _ 開頭'));
});

test('預設補值 create：補監工、補查核，數字對原始資料看有沒有必填欄位', () => {
  const withRequired = applyDefaults(soloDef({ params: [{ key: 'src', label: '總表', default: '', required: true }] }), { mode: 'create' });
  assert.equal(withRequired.check.facts, true);
  assert.equal(withRequired.check.enabled, true);
  assert.equal(withRequired.supervisor.enabled, true);

  const noRequired = applyDefaults(soloDef({ params: [{ key: 'src', label: '總表', default: '' }] }), { mode: 'create' });
  assert.equal(noRequired.check.facts, false);

  const bad = applyDefaults(soloDef({ params: 'oops' }), { mode: 'create' }); // 型別錯交給 validateWorkflow 報人話，這裡不 throw
  assert.equal(bad.check.facts, false);

  const already = applyDefaults(soloDef({ check: { enabled: false, facts: true } }), { mode: 'create' });
  assert.deepEqual(already.check, { enabled: false, facts: true }, '已經有的值原樣不動');
});

test('預設補值 save：補監工與查核，但永遠不碰數字對原始資料（不把缺省開靜默翻成關）', () => {
  const src = soloDef({ check: { enabled: true } });
  const out = applyDefaults(src, { mode: 'save' });
  assert.equal(out.supervisor.enabled, true);
  assert.equal(out.check.facts, undefined);
  assert.equal(src.supervisor, undefined, '純函式：不改原物件');
  assert.deepEqual(applyDefaults(soloDef(), { mode: 'save' }).check, { enabled: true });
});

// —— 記憶輪 M1b：params[].kind 六類、頂層 category 型別、applyDefaults 第三參數 defaults、全域設定逐欄驗證 ——

test('記憶輪：params[].kind 只准六類；頂層 category 只驗型別（存檔時由 server 剝掉）', () => {
  validateWorkflow(soloDef({ params: [{ key: 'a', label: 'A', default: '', kind: 'time' }] })); // 不丟例外即通過
  assert.throws(() => validateWorkflow(soloDef({ params: [{ key: 'a', label: 'A', default: '', kind: '色彩' }] })),
    (e) => e.message.includes('params[0] kind 必須是 appearance/audience/time/range/limits/method'));
  validateWorkflow(soloDef({ category: '旅遊' }));
  assert.throws(() => validateWorkflow(soloDef({ category: 3 })), (e) => e.message.includes('category 要是文字'));
});

test('預設補值 create 帶 defaults：查核、數字對原始資料、監工、產檔權限、每個 task 節點的三個勾都照設定', () => {
  const defaults = { check_enabled: false, check_facts: 'off', supervisor_enabled: false, supervisor_flags: { note: true, tier: true, tools: false }, permissions_files: false };
  const def = soloDef({ params: [{ key: 'src', label: '總表', default: '', required: true }] });
  def.nodes.push(
    { id: 'b', title: 'B', executor: 'ai', stop_point: 'never', instruction: '做', next: [] },
    { id: 'br', title: '分', kind: 'branch', instruction: '看', branches: [{ label: '一', next: 'a' }, { label: '二', next: 'b' }], next: [] },
  );
  const out = applyDefaults(def, { mode: 'create', defaults });
  assert.equal(out.check.enabled, false);
  assert.equal(out.check.facts, false, 'off＝固定關，就算有必填欄位');
  assert.equal(out.supervisor.enabled, false);
  assert.deepEqual(out.permissions, { files: false });
  for (const n of out.nodes.filter((n) => (n.kind ?? 'task') === 'task')) assert.deepEqual(n.supervisor, { note: true, tier: true, tools: false });
  assert.equal(out.nodes.find((n) => n.id === 'br').supervisor, undefined, '分岔不補三個勾');
  assert.equal(def.nodes[0].supervisor, undefined, '純函式：不改原物件');
  assert.equal(def.permissions, undefined);
  // on＝固定開（沒有必填欄位也開）；auto＝現行規則（看有沒有必填欄位）
  assert.equal(applyDefaults(soloDef(), { mode: 'create', defaults: { check_facts: 'on' } }).check.facts, true);
  assert.equal(applyDefaults(soloDef(), { mode: 'create', defaults: { check_facts: 'auto' } }).check.facts, false);
  // 節點已有三個勾＝不動；三個勾等於程式缺省＝不寫進節點
  const kept = applyDefaults(soloDef({}, { supervisor: { note: false } }), { mode: 'create', defaults });
  assert.deepEqual(kept.nodes[0].supervisor, { note: false });
  const same = applyDefaults(soloDef(), { mode: 'create', defaults: { supervisor_flags: { note: true, tier: false, tools: false } } });
  assert.equal(same.nodes[0].supervisor, undefined);
});

test('預設補值：defaults 省略＝程式缺省（產檔權限開、不補節點三個勾）；save 模式不碰 facts、不補節點、不補權限、不吃 defaults', () => {
  const plain = applyDefaults(soloDef(), { mode: 'create' });
  assert.deepEqual(plain.permissions, { files: true });
  assert.equal(plain.nodes[0].supervisor, undefined);
  const defaults = { check_enabled: false, check_facts: 'on', supervisor_enabled: false, supervisor_flags: { note: true, tier: true, tools: false }, permissions_files: false };
  const saved = applyDefaults(soloDef(), { mode: 'save', defaults });
  assert.equal(saved.check.facts, undefined);
  assert.equal(saved.nodes[0].supervisor, undefined);
  assert.equal(saved.permissions, undefined);
  assert.deepEqual(saved.supervisor, { enabled: true }, '既有流程的缺省語意＝開，不吃新流程的預設');
  assert.deepEqual(saved.check, { enabled: true });
});

test('全域設定逐欄驗證：合法回空；錯的每欄一句人話', () => {
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), []);
  const withDefaults = (d) => ({ ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults, ...d } });
  assert.ok(validateSettings(withDefaults({ check_facts: 'maybe' })).includes('數字對原始資料的預設只能是 auto、on、off'));
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, exec: { ...DEFAULT_SETTINGS.exec, web: 'yes' } }).includes('允許查網路要是開或關'));
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, memory: { ...DEFAULT_SETTINGS.memory, paused: 'no' } }).includes('記憶整層暫停要是開或關'));
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, memory: { ...DEFAULT_SETTINGS.memory, sensitive: { health: 1 } } }).some((m) => m.includes('健康')));
  assert.ok(validateSettings(withDefaults({ model_tier: 'ultra' })).some((m) => m.includes('fast、balanced、deep')));
  assert.deepEqual(validateSettings(withDefaults({ model_tier: 'deep', retry: 2 })), []);
  assert.ok(validateSettings(withDefaults({ retry: 5 })).some((m) => m.includes('0、1、2')));
  assert.ok(validateSettings(withDefaults({ supervisor_flags: { note: 'y' } })).some((m) => m.includes('監工三個勾')));
  assert.ok(validateSettings(withDefaults({ permissions_files: 'yes' })).some((m) => m.includes('產檔權限')));
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, exec: { ...DEFAULT_SETTINGS.exec, remind_leads: ['9h'] } }).some((m) => m.includes('提前提醒')));
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS, exec: { ...DEFAULT_SETTINGS.exec, remind_leads: ['30m', { at: '2026-10-01T09:00' }] } }), []);
  // 區塊整個不是物件：講「格式不對」，不講「物件」這種術語（M1b 修正輪）
  assert.deepEqual(validateSettings('oops'), ['設定格式不對']);
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, memory: 'x' }).includes('設定的記憶格式不對'));
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, memory: { ...DEFAULT_SETTINGS.memory, sensitive: [] } }).includes('設定的敏感類別格式不對'));
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, defaults: null }).includes('設定的新 Workflow 預設格式不對'));
  assert.ok(validateSettings(withDefaults({ supervisor_flags: 1 })).includes('設定的監工三個勾預設格式不對'));
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, exec: 'x' }).includes('設定的執行與排程格式不對'));
  const allBad = validateSettings({ version: 1, memory: 'x', defaults: 'x', exec: 'x' });
  assert.ok(allBad.length === 3 && allBad.every((m) => !m.includes('物件')), allBad.join('；'));
});

test('B4 契約 F：validateSettings 驗 compose.confirm_shape 布林（人話）；區塊不是物件講格式不對；沒給不報', () => {
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS, compose: { confirm_shape: false } }), []);
  assert.deepEqual(validateSettings({ version: 1 }), [], '缺鍵不報');
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS, compose: { confirm_shape: 'x' } }), ['拆之前先確認成品長相要是開或關']);
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS, compose: { confirm_shape: 1 } }), ['拆之前先確認成品長相要是開或關']);
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS, compose: 'x' }), ['設定的拆解格式不對']);
});

// ---- 移植合併輪 U1a：attachments 收 {scope, name}、設定收 company_name ----
test('U1a ⑤：attachments 元素＝檔名字串或 {scope: company|category, name}；scope 亂給、name 帶路徑符號都拒', () => {
  validateWorkflow(soloDef({}, { attachments: ['a.txt', { scope: 'company', name: 'b.md' }, { scope: 'category', name: 'c.docx' }] }));
  validateWorkflow(soloDef({}, { attachments: [] }));
  const msg = 'attachments 要是檔名清單或 {scope, name}（不含路徑符號）';
  for (const bad of [
    [{ scope: 'x', name: 'b.md' }],
    [{ scope: 'company', name: '../b' }],
    [{ scope: 'company', name: 'sub/b.md' }],
    [{ scope: 'company' }],
    [{ name: 'b.md' }],
    ['a/b.txt'],
    [42],
  ]) {
    assert.throws(() => validateWorkflow(soloDef({}, { attachments: bad })), (e) => e instanceof SchemaError && e.problems.some((p) => p.includes(msg)), JSON.stringify(bad));
  }
});

test('U1a ⑥：company_name 要是文字、60 字內；缺省空字串合法', () => {
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS, company_name: '範例公司' }), []);
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS, company_name: '' }), []);
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS, company_name: '赫'.repeat(60) }), []);
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, company_name: '赫'.repeat(61) }).includes('組織名稱要是文字、60 字內'));
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, company_name: 12 }).includes('組織名稱要是文字、60 字內'));
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, company_name: null }).includes('組織名稱要是文字、60 字內'));
});

// ---- 排版輪 L11（題 2 A）：欄位可設「每次上傳一個檔」——params[].input 只准 'file'；舊檔沒有這個鍵照過 ----
test('排版輪 L11 ①：params[].input 只准 file、選填；舊定義沒有 input 照過', () => {
  validateWorkflow(soloDef({ params: [{ key: 'a', label: 'A', default: '' }] }));
  validateWorkflow(soloDef({ params: [{ key: 'src', label: '原始資料', default: '', input: 'file', required: true }] }));
  for (const bad of ['text', '', 1, null]) {
    assert.throws(() => validateWorkflow(soloDef({ params: [{ key: 'a', label: 'A', default: '', input: bad }] })),
      (e) => e.message.includes('params[0] input 只能是 file（每次上傳一個檔）'), String(bad));
  }
  validateWorkflow(loadExample()); // 內建範例（沒有 input）照過
});

// ---- 排版輪 L13（題 1 A）：卡片入口「任一條到」＝nodes[].merge:'any'（選填；缺省＝等全部） ----
test('排版輪 L13 引擎①：merge 只准 any、缺省通過（舊檔沒有這個鍵照過）', () => {
  const def = {
    format: 1, name: '任一條到', params: [],
    nodes: [
      { id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做', next: ['b', 'c'] },
      { id: 'b', title: 'B', executor: 'ai', stop_point: 'never', instruction: '做', next: ['d'] },
      { id: 'c', title: 'C', executor: 'ai', stop_point: 'never', instruction: '做', next: ['d'] },
      { id: 'd', title: 'D', executor: 'ai', stop_point: 'never', instruction: '做', next: [], merge: 'any' },
    ],
  };
  validateWorkflow(def);
  const plain = structuredClone(def);
  delete plain.nodes[3].merge;
  validateWorkflow(plain);
  for (const bad of ['all', 'ANY', '', true, 1, null]) {
    const d = structuredClone(def);
    d.nodes[3].merge = bad;
    assert.throws(() => validateWorkflow(d), (e) => e instanceof SchemaError && e.message.includes('節點「d」merge 只能是 any（任一條到）'), String(bad));
  }
  validateWorkflow(loadExample());
});
