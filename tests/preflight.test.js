import test from 'node:test';
import assert from 'node:assert/strict';
import { inputSources, preflight } from '../src/preflight.js';

// C 趟的形狀：人做步驟貼信 → AI 判類（指示說「讀上一步」但沒引用欄位）
const HUMAN_THEN_AI = {
  format: 1,
  name: '客戶來信',
  params: [{ key: 'incoming_email', label: '來信全文', default: '（貼信）' }, { key: 'tone', label: '語氣', default: '正式' }],
  nodes: [
    { id: 'paste', title: '貼上客戶來信', executor: 'human', stop_point: 'always', instruction: '把來信貼進來 {{incoming_email}}', next: ['classify'] },
    { id: 'classify', title: '判斷來信類型', executor: 'ai', stop_point: 'always', instruction: '讀取上一步貼上的來信全文，判斷類型', next: ['reply'] },
    { id: 'reply', title: '回信', executor: 'ai', stop_point: 'never', instruction: '依上一步的判斷寫回信，語氣 {{tone}}', next: [] },
  ],
};

test('inputSources：AI 上游＝upstream；人做上游＝human；引用欄位＝param；參考檔＝attachment', () => {
  const def = structuredClone(HUMAN_THEN_AI);
  def.nodes[2].attachments = ['品牌手冊.txt'];
  const src = inputSources(def);
  assert.deepEqual(src.classify.map((s) => s.kind), ['human']);
  assert.equal(src.classify[0].id, 'paste');
  assert.deepEqual(src.reply.map((s) => [s.kind, s.id]), [['upstream', 'classify'], ['param', 'tone'], ['attachment', '品牌手冊.txt']]);
  assert.deepEqual(src.paste.map((s) => [s.kind, s.id]), [['param', 'incoming_email']]);
});

test('inputSources：穿透並行點與分岔往上找真正的內容來源', () => {
  const def = {
    format: 1, name: 'x', params: [],
    nodes: [
      { id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做', next: ['fk'] },
      { id: 'fk', title: '並行', kind: 'fork', next: ['b', 'br'] },
      { id: 'b', title: 'B', executor: 'ai', stop_point: 'never', instruction: '做', next: [] },
      { id: 'br', title: '分', kind: 'branch', instruction: '看', branches: [{ label: '一', next: 'c' }, { label: '二', next: 'd' }], next: [] },
      { id: 'c', title: 'C', executor: 'ai', stop_point: 'never', instruction: '做', next: [] },
      { id: 'd', title: 'D', executor: 'ai', stop_point: 'never', instruction: '做', next: [] },
    ],
  };
  const src = inputSources(def);
  assert.deepEqual(src.b.map((s) => s.id), ['a']);
  assert.deepEqual(src.c.map((s) => s.id), ['a']);
  assert.deepEqual(src.d.map((s) => s.id), ['a']);
});

test('preflight R1：AI 步驟的來源只有沒宣告交出內容的人做步驟、指示又提到上一步 → block 並指名修哪一步', () => {
  const r = preflight(HUMAN_THEN_AI);
  const b = r.issues.filter((i) => i.level === 'block');
  assert.equal(b.length, 1);
  assert.equal(b[0].code, 'no-input');
  assert.equal(b[0].node, 'classify');
  assert.deepEqual(b[0].fix, { kind: 'node', id: 'paste' });
  assert.ok(b[0].detail.includes('貼上客戶來信'));
});

test('preflight：人做步驟寫了 handoff（完成時交出什麼）→ 不再擋，只留提醒以外的靜默', () => {
  const def = structuredClone(HUMAN_THEN_AI);
  def.nodes[0].handoff = '來信全文';
  const r = preflight(def);
  assert.equal(r.issues.filter((i) => i.level === 'block').length, 0);
  assert.ok(!r.issues.some((i) => i.code === 'human-empty-handoff'));
});

test('preflight：AI 步驟指示引用了欄位 → 不擋（C 的正確寫法）', () => {
  const def = structuredClone(HUMAN_THEN_AI);
  def.nodes[1].instruction = '讀 {{incoming_email}} 判斷類型';
  const r = preflight(def);
  assert.equal(r.issues.filter((i) => i.level === 'block').length, 0);
});

test('preflight R1w：沒上游沒欄位沒參考檔、指示自足的第一步 → 只提醒不擋', () => {
  const def = {
    format: 1, name: 'poem', params: [],
    nodes: [{ id: 'p', title: '寫詩', executor: 'ai', stop_point: 'never', instruction: '寫一首關於秋天的詩', next: [] }],
  };
  const r = preflight(def);
  assert.equal(r.issues.filter((i) => i.level === 'block').length, 0);
  assert.ok(r.issues.some((i) => i.code === 'self-contained' && i.level === 'warn' && i.node === 'p'));
});

test('preflight R2：欄位沒被任何步驟引用 → warn＋unused_params', () => {
  const def = structuredClone(HUMAN_THEN_AI);
  def.params.push({ key: 'p4', label: '品牌語氣', default: '親切' });
  const r = preflight(def);
  assert.deepEqual(r.unused_params, ['p4']);
  const w = r.issues.find((i) => i.code === 'unused-param');
  assert.equal(w.level, 'warn');
  assert.equal(w.param, 'p4');
  assert.ok(w.title.includes('品牌語氣'));
});

test('preflight R3：人做步驟後接 AI 但沒寫 handoff → warn（R1 已擋的那一步不重複報）', () => {
  const def = structuredClone(HUMAN_THEN_AI);
  def.nodes[1].instruction = '讀 {{incoming_email}} 判斷類型'; // classify 不再被擋
  const r = preflight(def);
  const w = r.issues.find((i) => i.code === 'human-empty-handoff');
  assert.equal(w.level, 'warn');
  assert.equal(w.node, 'paste');
  assert.deepEqual(w.fix, { kind: 'node', id: 'paste' });
});

// ---- 排程與健檢輪 R4：欄位還沒填 ----
const IG_DEF = {
  format: 1, name: 'IG 月報',
  params: [
    { key: 'post_data', label: '上月貼文數據', default: '（貼上每篇貼文的讚數／留言）' },
    { key: 'top_count', label: '要挑幾篇', default: '5' },
    { key: 'notes', label: '備註', default: '', required: true, hint: '老闆特別交代的事' },
    { key: 'unused', label: '沒人用', default: '（貼上）' },
  ],
  nodes: [{ id: 'pick', title: '挑熱門貼文', executor: 'ai', stop_point: 'never', instruction: '從 {{post_data}} 挑 {{top_count}} 篇，注意 {{notes}}', next: [] }],
};

test('R4：不給 values（抽屜預覽）就不查欄位值', () => {
  assert.ok(!preflight(IG_DEF).issues.some((i) => i.code === 'param-unfilled'));
});

test('R4：值還是像佔位文字的預設 → 擋並指到欄位；填了真內容就放行', () => {
  const r = preflight(IG_DEF, { post_data: '（貼上每篇貼文的讚數／留言）', top_count: '5', notes: '無' });
  const b = r.issues.filter((i) => i.code === 'param-unfilled');
  assert.equal(b.length, 1);
  assert.equal(b[0].level, 'block');
  assert.equal(b[0].param, 'post_data');
  assert.deepEqual(b[0].fix, { kind: 'param', id: 'post_data' });
  assert.ok(b[0].detail.includes('提示文字'));
  const ok = preflight(IG_DEF, { post_data: '9/1 貼文 A：讚 120 留言 8', top_count: '5', notes: '無' });
  assert.ok(!ok.issues.some((i) => i.code === 'param-unfilled'));
});

test('R4：必填欄位空白 → 擋，detail 帶 hint；非佔位預設沒改（top_count=5）不擋；沒被 AI 引用的欄位不查', () => {
  const r = preflight(IG_DEF, { post_data: '真資料', top_count: '5', notes: '' });
  const b = r.issues.filter((i) => i.code === 'param-unfilled');
  assert.equal(b.length, 1);
  assert.equal(b[0].param, 'notes');
  assert.ok(b[0].detail.includes('老闆特別交代的事'));
  assert.ok(!r.issues.some((i) => i.code === 'param-unfilled' && i.param === 'unused'));
});

test('R5 file-permission：步驟要產 docx／xlsx 但流程沒開產檔權限 → 擋並指到 flow；開了就放行；pptx 不歸這條', () => {
  const def = structuredClone(IG_DEF);
  def.nodes[0].output_file = 'docx';
  def.nodes.push({ id: 'deck', title: '簡報', executor: 'ai', stop_point: 'never', instruction: '做簡報 {{top_count}}', output_file: 'pptx', next: [] });
  const r = preflight(def);
  const b = r.issues.filter((i) => i.code === 'file-permission');
  assert.equal(b.length, 1);
  assert.equal(b[0].level, 'block');
  assert.equal(b[0].node, 'pick');
  assert.deepEqual(b[0].fix, { kind: 'flow', id: 'permissions.files' });
  def.permissions = { files: true };
  assert.ok(!preflight(def).issues.some((i) => i.code === 'file-permission'));
});

test('preflight：inputs 回傳每一步的來源清單（給抽屜預覽用）', () => {
  const r = preflight(HUMAN_THEN_AI);
  assert.deepEqual(Object.keys(r.inputs).sort(), ['classify', 'paste', 'reply']);
  assert.equal(r.inputs.classify[0].kind, 'human');
  assert.ok(r.inputs.classify[0].label.includes('貼上客戶來信'));
});

// ---- 移植合併輪 U1b：attachments 混型——共用層的 {scope,name} 也算 attachment（健檢標籤標層、不誤判） ----

test('U1b ⑤：inputSources attachments 混型 → 字串與 {scope,name} 各一條 attachment，id 用 scope:名稱、label 標「（公司）」「（部門）」、無 [object Object]；只掛共用層參考檔的 AI 步驟不被健檢擋', () => {
  const def = structuredClone(HUMAN_THEN_AI);
  def.nodes[2].attachments = ['品牌手冊.txt', { scope: 'company', name: '範本.docx' }, { scope: 'category', name: '往期.md' }];
  const src = inputSources(def);
  const atts = src.reply.filter((s) => s.kind === 'attachment');
  assert.deepEqual(atts.map((s) => [s.id, s.label]), [
    ['品牌手冊.txt', '參考檔：品牌手冊.txt'],
    ['company:範本.docx', '參考檔：範本.docx（公司）'],
    ['category:往期.md', '參考檔：往期.md（部門）'],
  ]);
  assert.ok(!JSON.stringify(src).includes('[object Object]'));
  // 只有共用層參考檔＋指示說要讀輸入 → 有內容來源（跟流程參考檔一樣算 solid），不擋、不警告沒輸入
  const lone = {
    format: 1, name: 'x', params: [],
    nodes: [{ id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '讀取上一步的範本照做', attachments: [{ scope: 'company', name: '範本.docx' }], next: [] }],
  };
  const pf = preflight(lone);
  assert.deepEqual(pf.issues.filter((i) => i.code === 'no-input' || i.code === 'self-contained'), [], JSON.stringify(pf.issues));
  assert.deepEqual(pf.inputs.a.map((s) => s.id), ['company:範本.docx']);
});
