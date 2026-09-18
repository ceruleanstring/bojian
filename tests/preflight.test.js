import test from 'node:test';
import assert from 'node:assert/strict';
import { inputSources, packInputs, preflight, uploadReaders } from '../src/preflight.js';
import { ancestorIds } from '../src/graph.js';

// ---- 排版輪 L14b：/api/preflight 的輸入來源不重複傳——原本每步列全部祖先（200 步 119 萬字元，隨步數平方成長） ----
test('排版輪 L14b ④：packInputs——每個步驟名稱只傳一次、祖先用「前一步＋多出來的」表示；200→400 步回應約兩倍（不再平方成長）；祖先順序可還原', () => {
  const chain = (n) => ({ format: 1, name: '鏈', params: [], nodes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `第 ${i} 步整理資料並寫成摘要`, executor: 'ai', stop_point: 'never', instruction: '依上一步', next: i < n - 1 ? [`s${i + 1}`] : [] })) });
  const size = (n) => JSON.stringify(packInputs(chain(n))).length;
  const full200 = JSON.stringify(inputSources(chain(200))).length;
  assert.ok(size(200) * 20 < full200, `200 步：${size(200)} 對原本 ${full200}`);
  assert.ok(size(400) / size(200) < 2.2, `400 步 ${size(400)}／200 步 ${size(200)}`);
  assert.equal(JSON.stringify(packInputs(chain(200))).split('第 7 步整理資料').length - 1, 1, '名稱只出現一次');
  // 祖先順序還原（order(id)＝order(第一個前驅)＋[第一個前驅]＋多出來的）與 ancestorIds 相同
  const diamond = { format: 1, name: '菱', params: [], nodes: [
    { id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: 'x', next: ['F'] },
    { id: 'F', title: '並行', kind: 'fork', next: ['b', 'c'] },
    { id: 'b', title: 'B', executor: 'ai', stop_point: 'never', instruction: 'x', next: ['d'] },
    { id: 'c', title: 'C', executor: 'human', stop_point: 'never', instruction: 'x', handoff: '表', next: ['d'] },
    { id: 'd', title: 'D', executor: 'ai', stop_point: 'never', instruction: 'x', next: [] },
  ] };
  const pk = packInputs(diamond);
  const order = (id) => { const e = pk.pred[id]; return e ? [...order(e[0]), e[0], ...e.slice(1)] : []; };
  for (const n of diamond.nodes) assert.deepEqual(order(n.id), ancestorIds({ def: diamond }, n.id), n.id);
  assert.deepEqual(pk.src.c, { t: 'C', h: 1, o: '表' });
  assert.deepEqual(pk.at.d.near.sort(), ['b', 'c']);
  assert.equal('F' in pk.at, false, '只有 task 有 at');
});

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
  // 拆法輪 B1：沿路全帶——隔一步的人做步驟 paste 也是 reply 的來源（最近在前）
  assert.deepEqual(src.reply.map((s) => [s.kind, s.id]), [['upstream', 'classify'], ['human', 'paste'], ['param', 'tone'], ['attachment', '品牌手冊.txt']]);
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
  // B1 ⑦：穿透結構節點到的最近來源仍叫「上一步」；再接一步 e←c → e 的清單最近在前：c 上一步、a 更早
  assert.equal(src.b[0].label, '上一步《A》的產出');
  def.nodes[4].next = ['e'];
  def.nodes.push({ id: 'e', title: 'E', executor: 'ai', stop_point: 'never', instruction: '做', next: [] });
  const src2 = inputSources(def);
  assert.deepEqual(src2.e.map((s) => [s.id, s.label]), [['c', '上一步《C》的產出'], ['a', '更早的步驟《A》的產出']]);
});

// ---- 拆法輪 B1（契約 C）：健檢的輸入來源與執行端同步——沿路全部祖先 task、最近在前 ----

test('B1 ⑥：a→b→c、c 指示「依據上一步」→ inputSources(def).c 兩條 upstream（b 上一步、a 更早的步驟）、不 block；隔兩步的產出算有輸入', () => {
  const def = {
    format: 1, name: 'x', params: [],
    nodes: [
      { id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '寫一段', next: ['b'] },
      { id: 'b', title: 'B', executor: 'human', stop_point: 'always', instruction: '看一下', next: ['c'] },
      { id: 'c', title: 'C', executor: 'ai', stop_point: 'never', instruction: '依據上一步整理', next: [] },
    ],
  };
  // 人做步驟 b 沒寫 handoff：舊版只看最近一步會擋 c；沿路全帶後 a 的產出隔兩步也算輸入 → 不擋
  const src = inputSources(def);
  assert.deepEqual(src.c.map((s) => [s.kind, s.id]), [['human', 'b'], ['upstream', 'a']]);
  assert.equal(src.c[1].label, '更早的步驟《A》的產出');
  assert.equal(preflight(def).issues.filter((i) => i.level === 'block').length, 0, '隔兩步的產出算有輸入（接點 §八-2）');
  // 三步全 AI：c 兩條 upstream，b 上一步、a 更早
  def.nodes[1].executor = 'ai';
  const s2 = inputSources(def);
  assert.deepEqual(s2.c.map((s) => [s.kind, s.id, s.label]), [['upstream', 'b', '上一步《B》的產出'], ['upstream', 'a', '更早的步驟《A》的產出']]);
  assert.deepEqual(s2.b.map((s) => s.label), ['上一步《A》的產出']);
  assert.deepEqual(preflight(def).issues.filter((i) => i.level === 'block'), []);
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
  assert.equal(b[0].title, '「挑熱門貼文」要產出 .docx 檔，但這條 Workflow 沒開產檔權限');
  assert.equal(b[0].detail, '打開 Workflow 頁的「允許這條 Workflow 產出檔案」再按開始；不開的話會改存成 .md 文字檔。');
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

test('U1b ⑤：inputSources attachments 混型 → 字串與 {scope,name} 各一條 attachment，id 用 scope:名稱、label 標「（公司）」「（分類）」、無 [object Object]；只掛共用層參考檔的 AI 步驟不被健檢擋', () => {
  const def = structuredClone(HUMAN_THEN_AI);
  def.nodes[2].attachments = ['品牌手冊.txt', { scope: 'company', name: '範本.docx' }, { scope: 'category', name: '往期.md' }];
  const src = inputSources(def);
  const atts = src.reply.filter((s) => s.kind === 'attachment');
  assert.deepEqual(atts.map((s) => [s.id, s.label]), [
    ['品牌手冊.txt', '參考檔：品牌手冊.txt'],
    ['company:範本.docx', '參考檔：範本.docx（組織）'],
    ['category:往期.md', '參考檔：往期.md（分類）'],
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

// ---- 排版輪 L11（題 2 A）：每次上傳的欄位——必填沒給檔＝擋；讀檔的是「沒有 AI 祖先的 AI 步驟」 ----
const UPLOAD_DEF = {
  format: 1, name: '月報',
  params: [
    { key: 'src', label: '原始資料', default: '', input: 'file', required: true },
    { key: 'extra', label: '附件', default: '', input: 'file' },
  ],
  nodes: [
    { id: 'h', title: '確認月份', executor: 'human', stop_point: 'always', instruction: '確認', handoff: '月份', next: ['a1'] },
    { id: 'a1', title: '整理資料', executor: 'ai', stop_point: 'never', instruction: '讀取上傳的資料整理', next: ['a2'] },
    { id: 'a2', title: '寫報告', executor: 'ai', stop_point: 'never', instruction: '依上一步寫報告', next: [] },
  ],
};
test('排版輪 L11 ⑧：input:file 必填沒給檔＝block upload-missing（選填不擋、預覽不查）；上傳欄位不報「沒有步驟用到」；uploadReaders＝沒有 AI 祖先的 AI 步驟、輸入來源多「這次上傳」', () => {
  const miss = preflight(UPLOAD_DEF, { src: '', extra: '' });
  const blocks = miss.issues.filter((i) => i.level === 'block');
  assert.deepEqual(blocks.map((i) => [i.code, i.param]), [['upload-missing', 'src']], JSON.stringify(miss.issues));
  assert.ok(blocks[0].title.includes('原始資料') && blocks[0].fix.kind === 'param' && blocks[0].fix.id === 'src', JSON.stringify(blocks[0]));
  assert.deepEqual(preflight(UPLOAD_DEF, { src: '三月.csv', extra: '' }).issues.filter((i) => i.level === 'block'), [], '給了檔名放行');
  assert.deepEqual(preflight(UPLOAD_DEF).issues.filter((i) => i.code === 'upload-missing'), [], '沒帶值（抽屜預覽）不查');
  assert.deepEqual(miss.unused_params, [], '上傳欄位靠檔案讀，不算沒人用');
  assert.equal(miss.issues.filter((i) => i.code === 'param-unfilled').length, 0, '上傳欄位不走文字欄位的空白規則');
  assert.deepEqual(uploadReaders(UPLOAD_DEF), ['a1']);
  const src = inputSources(UPLOAD_DEF);
  assert.deepEqual(src.a1.filter((s) => s.kind === 'upload').map((s) => [s.id, s.label]), [['src', '這次上傳：原始資料'], ['extra', '這次上傳：附件']]);
  assert.equal(src.a2.filter((s) => s.kind === 'upload').length, 0, '後面的步驟靠沿路全帶');
  // 舊定義（沒有上傳欄位）：來源與規則原樣
  assert.deepEqual(uploadReaders(HUMAN_THEN_AI), ['classify']);
  assert.equal(Object.values(inputSources(HUMAN_THEN_AI)).flat().filter((s) => s.kind === 'upload').length, 0);
});

// ---- 排版輪 L13（題 1 A）：任一條到——輸入來源照列全部前驅並標「任一條到」；誰讀上傳檔跟著改（有一條線沒有 AI 祖先就算） ----
test('排版輪 L13 引擎⑤：preflight 輸入來源列全部前驅，直接接進來的線標「任一條到」、更早的步驟不標；缺省（等全部）字面照舊', () => {
  const def = {
    format: 1, name: '任一條到', params: [],
    nodes: [
      { id: 'a', title: '起頭', executor: 'ai', stop_point: 'never', instruction: '起', next: ['b', 'c'] },
      { id: 'b', title: '快的', executor: 'ai', stop_point: 'never', instruction: '快', next: ['d'] },
      { id: 'c', title: '人工核', executor: 'human', stop_point: 'never', instruction: '核', handoff: '核對表', next: ['d'] },
      { id: 'd', title: '會合', executor: 'ai', stop_point: 'never', instruction: '依上一步合', next: [], merge: 'any' },
    ],
  };
  const src = inputSources(def).d;
  assert.deepEqual(src.map((s) => [s.kind, s.id]), [['human', 'c'], ['upstream', 'b'], ['upstream', 'a']]);
  assert.equal(src[0].label, '《人工核》（你來做）交出的內容：核對表（任一條到）');
  assert.equal(src[1].label, '上一步《快的》的產出（任一條到）');
  assert.equal(src[2].label, '更早的步驟《起頭》的產出', '更早的祖先一定會到，不標');
  const plain = structuredClone(def);
  delete plain.nodes[3].merge;
  assert.deepEqual(inputSources(plain).d.map((s) => s.label), ['《人工核》（你來做）交出的內容：核對表', '上一步《快的》的產出', '更早的步驟《起頭》的產出']);
  assert.deepEqual(preflight(def).issues.filter((i) => i.level === 'block'), [], '有來源不擋');
});

test('排版輪 L13 引擎⑤：uploadReaders——任一條到的卡只要有一條線上沒有 AI，就可能先由那條到，它也讀上傳檔；等全部照舊', () => {
  const def = {
    format: 1, name: '月報', params: [{ key: 'src', label: '原始資料', default: '', input: 'file' }],
    nodes: [
      { id: 'h', title: '確認', executor: 'human', stop_point: 'never', instruction: '確認', handoff: '月份', next: ['x', 'y'] },
      { id: 'x', title: '人工整理', executor: 'human', stop_point: 'never', instruction: '整理', handoff: '表', next: ['z'] },
      { id: 'y', title: 'AI 整理', executor: 'ai', stop_point: 'never', instruction: '讀取上傳的資料整理', next: ['z'] },
      { id: 'z', title: '寫報告', executor: 'ai', stop_point: 'never', instruction: '依上一步寫', next: ['w'], merge: 'any' },
      { id: 'w', title: '潤稿', executor: 'ai', stop_point: 'never', instruction: '潤', next: [] },
    ],
  };
  assert.deepEqual(uploadReaders(def), ['y', 'z']);
  const plain = structuredClone(def);
  delete plain.nodes[3].merge;
  assert.deepEqual(uploadReaders(plain), ['y']);
  assert.deepEqual(uploadReaders(UPLOAD_DEF), ['a1'], '舊定義照舊');
});

// ── 2026-09-18 審查修正輪 ──────────────────────────────────────────────

test('必填欄位的預設值本來就是答案：不准因為「值等於預設」就永遠擋著不給開跑', () => {
  const mk = (dft) => ({
    format: 1,
    name: '講稿',
    params: [{ key: 'len', label: '長度', default: dft, required: true }],
    nodes: [{ id: 'a', title: '寫', executor: 'ai', stop_point: 'never', instruction: '寫成 {{len}}', next: [] }],
  });
  const codes = (def, values) => preflight(def, values).issues.filter((i) => i.code === 'param-unfilled').map((i) => i.param);

  // 預設就是使用者要的值——必填不等於「不准等於預設」
  assert.deepEqual(codes(mk('800 字'), { len: '800 字' }), [], '正常的預設值不該擋');
  // 預設是佔位文字——照舊要擋
  assert.deepEqual(codes(mk('請填長度'), { len: '請填長度' }), ['len'], '佔位文字照舊擋');
  assert.deepEqual(codes(mk('（例如 800 字）'), { len: '（例如 800 字）' }), ['len'], '括號開頭的佔位文字照舊擋');
  // 留空照舊擋
  assert.deepEqual(codes(mk('800 字'), { len: '' }), ['len'], '空的照舊擋');

  // 2026-09-18 二次審查：放寬之後守門只剩這條規則，常見的佔位寫法要擋得到
  for (const dft of ['例：2026 春季新品', '例:台北三日遊', '待填', '此處填寫本月主題', '此處放你要的主題', 'XXXX']) {
    assert.deepEqual(codes(mk(dft), { len: dft }), ['len'], `佔位寫法沒擋到：${dft}`);
  }
  // 誤擋比漏擋嚴重（誤擋＝那個欄位永遠開不了跑，正是本測試上半段要拆的病）。
  // 以下每條都貼著本輪新加的四段（此處填／放／寫／貼、例：、待填、XXX）的邊界，一個都不准擋——
  // 覆核兩輪退回的反例都在這裡：句中的「此處填」、字首不是「例」的「案例：」、帶其他字的「待填」。
  for (const dft of [
    '例行週會紀錄', '條列重點', '3 項', '本季', '5 頁內', '親切但不裝熟',
    '由此處理即可', '依此處理方式辦理',
    '待填人力需求評估表', '本月缺料狀態：待填',
    '案例：A公司違約', '前例：無', '慣例：週五收單',
    '會議紀錄請於此處填寫收件地址', '文案：請於此處寫下您的祝福語', '退貨標籤請貼此處放置點：倉庫 B 區',
  ]) {
    assert.deepEqual(codes(mk(dft), { len: dft }), [], `真答案被誤擋：${dft}`);
  }
});
