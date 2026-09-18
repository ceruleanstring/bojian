// supervisor — 監工模組（監工輪 K1）：三份固定交代、三個 prompt 組裝、三個解析、三個呼叫、對應表、相似度
import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckParseError } from '../src/checker.js';
import {
  BRIEF_RULES, HANDOFF_RULES, RECORD_RULES, WHERE_LABELS,
  supervisorFlags, buildBriefPrompt, buildHandoffPrompt, buildRecordPrompt,
  parseBrief, parseHandoff, parseRecord,
  brief, handoff, record, buildRecordTable, bigramJaccard,
} from '../src/supervisor.js';

// prompt 的某一段（段與段之間是空行＋「# 標題」）
function section(prompt, title) {
  const parts = prompt.split(`\n# ${title}\n`);
  return parts.length > 1 ? parts[1].split('\n# ')[0].trim() : '';
}

const DEF = {
  format: 1,
  name: '季度報告',
  params: [{ key: 'src', label: '總表', default: '', required: true }],
  nodes: [
    { id: 'a', title: '看資料', executor: 'ai', stop_point: 'never', instruction: '看 {{src}}', constraints: '不編造', review_focus: '數字對得上', next: ['b'] },
    { id: 'b', title: '寫初稿', executor: 'ai', stop_point: 'always', instruction: '寫初稿', output_format: 'Markdown', attachments: ['規格.md'], next: ['c'] },
    { id: 'c', title: '收尾', executor: 'ai', stop_point: 'never', instruction: '收尾', next: [] },
  ],
};

// ---- 三份固定交代逐字 ----

test('監工：三份固定交代逐字（改動＝改契約，測試要一起改）', () => {
  assert.equal(BRIEF_RULES, '你是「剝繭」流程的監工。這趟流程要開跑了，你先通盤看一次這條流程的全部設定與這次帶進來的資料，寫一份給每一步工人的開場備註：這趟的資料長什麼樣（件數、類別、期間、缺什麼）、哪幾步要特別注意什麼、成品一定要有什麼。只寫從設定與資料看得出來的事，不編、不加新要求、不改任何步驟的指示；最多八條，一條一句。全篇使用與流程相同的語言。只輸出一個 JSON 物件，前後不要任何其他文字：{"note":"…"}');
  assert.equal(HANDOFF_RULES, '你是「剝繭」流程的監工。上一步剛做完，下一步要開始。請讀上一步的成品、這趟的開場備註、之前的交接、下一步的設定、使用者剛交代的話，寫一段給下一步工人的交接：上一步成品裡哪些東西下一步要用、要照什麼分法或順序、有什麼要避開。只寫從成品與設定看得出來的事，不編、不新增使用者沒提的要求、不改下一步的指示；最多五條，一條一句。「允許你調的」列出的欄位才能給值（tier 只能是 fast、balanced、deep 之一；web 是要不要開查網，true 或 false），沒列的一律 null。有「判路題」時從選項裡選一條，route 寫該選項的編號（字串），判斷不了寫 null；沒有判路題 route 一律 null。全篇使用與流程相同的語言。只輸出一個 JSON 物件，前後不要任何其他文字：{"note":"…","tier":null,"web":null,"route":null}');
  assert.equal(RECORD_RULES, '你是「剝繭」流程的監工。這趟已經跑完。下面是程式整理的對應表（每一步用了哪些設定、規則、備註，查核結果，使用者改了什麼）與各步成品。請用使用者聽得懂的話寫這趟的執行紀錄：發生了什麼、哪裡被攔或被改、原因最可能在哪個設定或哪條規則；然後列「建議改哪裡」，每條指到一個具體位置與改法一句。where 只能是這五個字之一：instruction（那一步的指示）、constraints（限制條件）、review_focus（驗收重點）、params（某個欄位）、rule（某條規則）；node 只能是「可用的步驟 id」裡的一個。不評論好壞、不編沒發生的事；紀錄六句內，建議最多三條，沒有就給空清單。只輸出一個 JSON 物件，前後不要任何其他文字：{"text":"…","suggestions":[{"node":"步驟id","where":"instruction","text":"…"}]}');
  assert.deepEqual(WHERE_LABELS, { instruction: '指示', constraints: '限制條件', review_focus: '驗收重點', params: '欄位', rule: '規則' });
});

// ---- 三個勾 ----

test('監工三個勾：沒寫＝只有寫備註開、調檔位關、開關查網關（09-09 改關：真 AI 對照監工四次把 opus 工人降 sonnet）；寫了照寫的算', () => {
  assert.deepEqual(supervisorFlags({}), { note: true, tier: false, tools: false });
  assert.deepEqual(supervisorFlags({ supervisor: { tools: true } }), { note: true, tier: false, tools: true });
  assert.deepEqual(supervisorFlags({ supervisor: { tier: true } }), { note: true, tier: true, tools: false });
  assert.deepEqual(supervisorFlags({ supervisor: { note: false, tier: false } }), { note: false, tier: false, tools: false });
  assert.deepEqual(supervisorFlags(undefined), { note: true, tier: false, tools: false });
});

test('監工三個勾：節點沒寫 supervisor 時，交接 prompt 的「允許你調的」不出現 tier（缺省關＝監工動不了檔位）', () => {
  const node = { id: 'b', title: '寫初稿', executor: 'ai', stop_point: 'always', instruction: '寫初稿', model_tier: 'deep' };
  const allow = section(buildHandoffPrompt({ node }), '允許你調的');
  assert.ok(!allow.includes('- tier'), `缺省不准監工調檔位，允許清單卻有 tier：${allow}`);
  assert.ok(!allow.includes('- web'), '缺省也不准開關查網');
});

// ---- prompt 組裝 ----

test('開場 prompt：固定交代＋步驟一行＋欄位值（超過 2,000 字截）＋參考檔（前 500 字）', () => {
  const long = 'x'.repeat(2500);
  const p = buildBriefPrompt({
    def: DEF,
    params: { src: long },
    paramLabels: { src: '總表' },
    refTexts: { '規格.md': 'y'.repeat(600) },
  });
  assert.ok(p.startsWith(BRIEF_RULES), '固定交代在最前面');
  assert.ok(p.includes('# 流程：季度報告'));
  assert.ok(p.includes('- 看資料｜ai｜停點 never｜要求：看 {{src}}｜限制：不編造｜驗收：數字對得上'));
  assert.ok(p.includes('｜限制：（無）｜驗收：（無）'), '沒寫限制／驗收的步驟寫（無）');
  // 步驟行不給 id：使用者看不懂 slug，開場也用不到
  const steps = section(p, '步驟');
  for (const id of ['a', 'b', 'c']) assert.ok(!steps.includes(`- ${id}｜`), `步驟段不該出現步驟 id「${id}」`);
  for (const t of ['看資料', '寫初稿', '收尾']) assert.ok(steps.includes(`- ${t}｜`), `步驟段要有標題「${t}」`);
  assert.ok(p.includes('【欄位：總表】'));
  assert.ok(p.includes(`${'x'.repeat(2000)}（截）`), '單欄截到 2,000 字並標（截）');
  assert.ok(!p.includes('x'.repeat(2001)), '截了就不能還留 2,001 字');
  assert.ok(p.includes('【參考檔：規格.md】'));
  assert.ok(p.includes('y'.repeat(500)) && !p.includes('y'.repeat(501)), '參考檔只留前 500 字');
});

test('開場 prompt：讀不出文字的參考檔只列名字；沒欄位沒參考檔寫（無）', () => {
  const p = buildBriefPrompt({ def: DEF, params: {}, paramLabels: {}, refTexts: {} });
  assert.equal(section(p, '這次的欄位值'), '（無）');
  assert.equal(section(p, '參考檔'), '【參考檔：規格.md】');
});

test('交接 prompt：允許調的只列勾起來的；判路題、規矩、之前的交接、插話、上一步成品各就各位', () => {
  const node = { id: 'b', title: '寫初稿', executor: 'ai', stop_point: 'always', instruction: '寫初稿', constraints: '每段三句', review_focus: '有結論', output_format: 'Markdown' };
  const p = buildHandoffPrompt({
    node,
    flags: { note: true, tier: false, tools: true },
    routeOptions: [{ label: '金額五千以上' }, { label: '五千以下' }],
    brief: '這趟資料只有兩個月',
    priorHandoffs: [{ title: '看資料', text: '先數件數' }],
    rules: ['每段三句'],
    interjections: ['這次只要看北區'],
    upstream: [{ title: '看資料', text: '共 14 件' }],
  });
  assert.ok(p.startsWith(HANDOFF_RULES));
  assert.ok(p.includes('# 下一步：寫初稿'));
  assert.ok(p.includes('要求：寫初稿'));
  assert.ok(p.includes('產出格式：Markdown'));
  const allow = section(p, '允許你調的');
  assert.ok(!allow.includes('- tier'), '沒勾調檔位就不能出現在允許清單');
  assert.ok(allow.includes('- web'));
  // 允許調的要附現值：真 AI 對照發現不講現在的檔位，監工四次交接全回 balanced，把 deep 的工人降級
  const onTier = section(buildHandoffPrompt({ node: { ...node, model_tier: 'deep' }, flags: { note: true, tier: true, tools: true } }), '允許你調的');
  assert.ok(onTier.includes('- tier（現在：deep；沒必要改就寫 null）'), '勾了調檔位就要附現值與「沒必要改就寫 null」');
  assert.ok(onTier.includes('- web（現在：開；沒必要改就寫 null）'));
  const noTierSet = section(buildHandoffPrompt({ node, flags: { note: true, tier: true, tools: false } }), '允許你調的');
  assert.ok(noTierSet.includes('- tier（現在：balanced；沒必要改就寫 null）'), '節點沒設檔位就寫 balanced');
  assert.ok(p.includes('# 判路題'));
  assert.ok(p.includes('1. 金額五千以上') && p.includes('2. 五千以下'));
  assert.ok(section(p, '生效的規矩').includes('每段三句'));
  assert.ok(section(p, '開場備註').includes('這趟資料只有兩個月'));
  assert.ok(section(p, '之前的交接').includes('看資料：先數件數'));
  assert.ok(section(p, '使用者剛交代的話').includes('這次只要看北區'));
  assert.ok(p.includes('【步驟：看資料】\n共 14 件'));
});

test('交接 prompt：沒判路題不出現該段；三個勾全關時允許清單寫（無）；空的段落一律（無）；上一步成品超過 8,000 字截', () => {
  const node = { id: 'b', title: '寫初稿', instruction: '寫初稿' };
  const p = buildHandoffPrompt({
    node,
    flags: { note: true, tier: false, tools: false },
    routeOptions: null,
    brief: '',
    priorHandoffs: [],
    rules: [],
    interjections: [],
    upstream: [{ title: '看資料', text: 'z'.repeat(8500) }],
  });
  assert.ok(!p.includes('# 判路題'));
  assert.equal(section(p, '允許你調的'), '（無）');
  assert.equal(section(p, '生效的規矩'), '（無）');
  assert.equal(section(p, '開場備註'), '（無）');
  assert.equal(section(p, '之前的交接'), '（無）');
  assert.equal(section(p, '使用者剛交代的話'), '（無）');
  assert.ok(p.includes(`${'z'.repeat(8000)}（截）`) && !p.includes('z'.repeat(8001)));
});

test('收尾 prompt：可用的步驟 id、對應表 JSON、各步成品（前 1,500 字）', () => {
  const table = [{ node: 'a', title: '看資料', kind: 'task' }];
  const p = buildRecordPrompt({ def: DEF, table, outputs: [{ title: '看資料', text: 'w'.repeat(1600) }] });
  assert.ok(p.startsWith(RECORD_RULES));
  assert.ok(p.includes('# 可用的步驟 id'));
  assert.ok(p.includes('- a：看資料') && p.includes('- b：寫初稿') && p.includes('- c：收尾'));
  assert.ok(p.includes(JSON.stringify(table)));
  assert.ok(p.includes('【步驟：看資料】'));
  assert.ok(p.includes('w'.repeat(1500)) && !p.includes('w'.repeat(1501)));
});

// ---- 解析 ----

test('解析交接：四欄都在；tier 只認三檔；route 一律字串；沒寫 note 就是空字串', () => {
  assert.deepEqual(parseHandoff('{"note":"按三類分節","tier":"deep","web":null,"route":null}'),
    { note: '按三類分節', tier: 'deep', web: null, route: null });
  assert.equal(parseHandoff('{"note":"x","tier":"ultra"}').tier, null);
  assert.equal(parseHandoff('{"note":"x","route": 2}').route, '2');
  assert.equal(parseHandoff('{"route":"1"}').note, '');
  assert.equal(parseHandoff('{"note":"x","web":true}').web, true);
});

test('解析：兩份內容不同的結果＝含糊，丟 CheckParseError；一字不差的重複收成一份', () => {
  assert.throws(() => parseHandoff('{"note":"甲案"}\n{"note":"乙案"}'), CheckParseError);
  assert.equal(parseHandoff('{"note":"甲案"}\n{"note":"甲案"}').note, '甲案');
});

test('解析：回覆裡沒有可用的結果＝丟 CheckParseError（不猜、不當成空備註）', () => {
  assert.throws(() => parseHandoff('我覺得應該按三類分節'), (e) => e instanceof CheckParseError && e.message.includes('監工回覆裡沒有可用的結果'));
  assert.throws(() => parseBrief('{"note":123}'), CheckParseError);
  assert.equal(parseBrief('{"note":"  先數件數  "}').note, '先數件數');
});

test('解析紀錄：where 不合法與不存在的步驟丟掉，最多留三條；建議物件本身不會被當成候選', () => {
  const raw = JSON.stringify({
    text: '這趟第二步被攔了一次',
    suggestions: [
      { node: 'b', where: 'instruction', text: '講清楚要幾段' },
      { node: 'b', where: 'style', text: '不合法的 where' },
      { node: 'zz', where: 'rule', text: '不存在的步驟' },
      { node: 'a', where: 'constraints', text: '一' },
      { node: 'a', where: 'params', text: '二' },
      { node: 'c', where: 'rule', text: '三' },
    ],
  });
  const v = parseRecord(raw, ['a', 'b', 'c']);
  assert.equal(v.text, '這趟第二步被攔了一次');
  assert.deepEqual(v.suggestions, [
    { node: 'b', where: 'instruction', text: '講清楚要幾段' },
    { node: 'a', where: 'constraints', text: '一' },
    { node: 'a', where: 'params', text: '二' },
  ]);
  assert.deepEqual(parseRecord('{"text":"沒建議","suggestions":[]}', ['a']).suggestions, []);
});

// ---- 呼叫 ----

function fakeAdapter(reply) {
  const metas = [];
  return {
    metas,
    async complete({ meta }) {
      metas.push(meta);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

test('開場呼叫：回合法 JSON→ok；卷宗兩份各寫一次；meta 帶 kind supervisor', async () => {
  const adapter = fakeAdapter('好的：{"note":"先數件數"}');
  const prompts = [];
  const replies = [];
  const r = await brief({
    adapter,
    meta: { kind: 'supervisor', phase: 'brief', category: '測試', workflow: 'wf-1', run: 'r1', node: '_brief' },
    onPrompt: (p) => prompts.push(p),
    onReply: (x) => replies.push(x),
    def: DEF,
    params: {},
    paramLabels: {},
    refTexts: {},
  });
  assert.deepEqual(r, { ok: true, text: '先數件數' });
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].startsWith(BRIEF_RULES), '卷宗存的＝送出的全文');
  assert.deepEqual(replies, ['好的：{"note":"先數件數"}']);
  assert.equal(adapter.metas[0].kind, 'supervisor');
  assert.equal(adapter.metas[0].node, '_brief');
  assert.equal(adapter.metas[0].phase, 'brief');
});

test('監工失敗不擋流程：宿主錯與解析不出來都回 fail_note，不丟例外', async () => {
  const down = await brief({ adapter: fakeAdapter(new Error('宿主連不上')), def: DEF, params: {}, paramLabels: {}, refTexts: {} });
  assert.equal(down.ok, false);
  assert.ok(down.fail_note.startsWith('監工這次沒寫成：'), down.fail_note);
  assert.ok(down.fail_note.includes('宿主連不上'));

  const junk = await record({ adapter: fakeAdapter('我先想一下'), def: DEF, table: [], outputs: [] });
  assert.equal(junk.ok, false);
  assert.ok(junk.fail_note.includes('監工這次沒寫成：'), junk.fail_note);
});

test('交接呼叫：沒勾的欄位程式強制 null；勾了才吃監工給的值；route 照收', async () => {
  const args = {
    adapter: fakeAdapter('{"note":"按三類分節","tier":"deep","web":true,"route":"2"}'),
    node: { id: 'b', title: '寫初稿', instruction: '寫初稿' },
    routeOptions: [{ label: '一' }, { label: '二' }],
    brief: '', priorHandoffs: [], rules: [], interjections: [], upstream: [],
  };
  const off = await handoff({ ...args, flags: { note: true, tier: false, tools: false } });
  assert.deepEqual(off, { ok: true, text: '按三類分節', tier: null, web: null, route: '2' });
  const on = await handoff({ ...args, flags: { note: true, tier: true, tools: true } });
  assert.deepEqual(on, { ok: true, text: '按三類分節', tier: 'deep', web: true, route: '2' });
});

test('交接呼叫：沒勾「寫交接備註」時備註強制空字串（判路不受影響）', async () => {
  const args = {
    adapter: fakeAdapter('{"note":"按三類分節","tier":"deep","web":null,"route":"2"}'),
    node: { id: 'b', title: '寫初稿', instruction: '寫初稿' },
    routeOptions: [{ label: '一' }, { label: '二' }],
    brief: '', priorHandoffs: [], rules: [], interjections: [], upstream: [],
  };
  const off = await handoff({ ...args, flags: { note: false, tier: true, tools: false } });
  assert.equal(off.text, '', '取消勾選後備註不准回來');
  assert.equal(off.tier, 'deep');
  assert.equal(off.route, '2', '判路永遠可用，不受備註勾影響');
  const on = await handoff({ ...args, flags: { note: true, tier: true, tools: false } });
  assert.equal(on.text, '按三類分節');
});

test('收尾呼叫：回 text 與過濾後的建議', async () => {
  const reply = JSON.stringify({ text: '跑完三步', suggestions: [{ node: 'b', where: 'instruction', text: '寫清楚段數' }, { node: 'x', where: 'rule', text: '丟掉' }] });
  const r = await record({ adapter: fakeAdapter(reply), def: DEF, table: [], outputs: [] });
  assert.deepEqual(r, { ok: true, text: '跑完三步', suggestions: [{ node: 'b', where: 'instruction', text: '寫清楚段數' }] });
});

// ---- 對應表 ----

const RUN = {
  run_id: 'r1',
  def: DEF,
  params: { src: '總表內容' },
  steps: {
    a: { status: 'done', output: '共 14 件', edited_output: null, edit_note: null, edit_rules: [{ text: '每段三句', scope: 'all' }, { text: '這步用表', scope: 'this-step' }], check: { status: 'pass', blocks: [], flags: [], attempts: 1 } },
    b: { status: 'done', output: '初稿', edited_output: '我改過的初稿', edit_note: '太長', handoff: { text: '按三類分節', tier: null, web: null, route: null, at: '2026-09-09T01:00:00.000Z' }, check: { status: 'redo-pass', blocks: [{ kind: 'must' }], flags: [{ kind: 'format' }], attempts: 2 } },
    c: { status: 'done', output: '收尾', edited_output: null, edit_note: null },
  },
};

const USAGE = [
  { at: '2026-09-09T01:00:00.000Z', run: 'r1', node: '_brief', kind: 'supervisor', input_tokens: 100, output_tokens: 10 },
  { at: '2026-09-09T01:01:00.000Z', run: 'r1', node: 'b', kind: 'step', input_tokens: 200, cache_read_input_tokens: 50, output_tokens: 20 },
  { at: '2026-09-09T01:02:00.000Z', run: 'r1', node: 'b', kind: 'check', input_tokens: 300, output_tokens: 30 },
  { at: '2026-09-09T01:03:00.000Z', run: 'r1', node: 'b', kind: 'supervisor', input_tokens: 400, output_tokens: 40 },
  { at: '2026-09-09T01:04:00.000Z', run: 'r1', node: 'a', kind: 'edit-rules', input_tokens: 999, output_tokens: 99 },
  { at: '2026-09-09T01:05:00.000Z', run: 'r9', node: 'b', kind: 'step', input_tokens: 888, output_tokens: 88 },
];

test('對應表：每步的設定、上游、規則、交接、查核、改動、用量各一格', () => {
  const { table, usage } = buildRecordTable({ run: RUN, usageRows: USAGE });
  assert.equal(table.length, 3);
  const b = table[1];
  assert.equal(b.node, 'b');
  assert.equal(b.kind, 'task');
  assert.equal(b.executor, 'ai');
  assert.equal(b.status, 'done');
  assert.deepEqual(b.upstream, ['a']);
  assert.deepEqual(b.fields, ['output_format', 'attachments']);
  assert.deepEqual(b.edit_rules_in, ['每段三句'], '只有 scope=all 的上游規則往下帶');
  assert.equal(b.handoff, '按三類分節');
  assert.deepEqual(b.check, { status: 'redo-pass', blocks: 1, flags: 1, attempts: 2 });
  assert.equal(b.edited, true);
  assert.equal(b.edit_note, '太長');
  assert.deepEqual(b.usage, { input: 950, output: 90, calls: 3 }, '同一步的工人／查核／監工三筆都算，別的 run 不算');

  assert.deepEqual(table[0].params, ['總表'], '指示裡引用的欄位用 label');
  assert.deepEqual(table[0].fields, ['constraints', 'review_focus']);
  assert.deepEqual(table[0].upstream, []);
  assert.equal(table[0].handoff, null);
  assert.equal(table[2].check, null, '沒查核紀錄＝null');
  assert.equal(table[2].edited, false);
});

test('對應表：卡欄鏡像 steps[n].memory.cards 的 id（記憶輪）；沒有的回空清單', () => {
  const run = structuredClone(RUN);
  run.steps.a.memory = {
    at: '2026-09-09T01:00:00.000Z',
    cards: [{ id: 'p-1', bucket: 'profile', text: '不要恭維', layer: 'expression', level: 'all' }, { id: 'p-2', bucket: 'profile', text: '我是負責人', layer: 'content', level: 'category' }, { id: 'g-1', bucket: 'group', text: '不提競品', field: null, level: 'category' }],
    overridden: [],
    paused: false,
  };
  run.steps.b.memory = { at: '2026-09-09T01:01:00.000Z', cards: [], overridden: [], paused: true };
  const { table } = buildRecordTable({ run, usageRows: USAGE });
  assert.deepEqual(table[0].cards, ['p-1', 'p-2', 'g-1']);
  assert.equal(table[0].cards.length, 3);
  assert.deepEqual(table[1].cards, []);
  assert.deepEqual(table[2].cards, [], '沒寫 memory 的步驟＝空');
  assert.deepEqual(buildRecordTable({ run: RUN, usageRows: USAGE }).table.map((r) => r.cards), [[], [], []]);
});

test('對應表用量：開場、收尾各自一格；總計不算擬規則、不算別的 run', () => {
  const { usage } = buildRecordTable({ run: RUN, usageRows: USAGE });
  assert.deepEqual(usage.brief, { input: 100, output: 10, calls: 1 });
  assert.deepEqual(usage.record, { input: 0, output: 0, calls: 0 });
  assert.deepEqual(usage.total, { input: 1050, output: 100, calls: 4 });
});

// ---- 相似度 ----

test('二元組相似度：像的過半、不像的低、不足兩字回 0（永不 NaN）', () => {
  assert.ok(bigramJaccard('按三類分節', '按三類分節先列件數') >= 0.5);
  assert.ok(bigramJaccard('按三類分節', '完全不同') < 0.5);
  assert.equal(bigramJaccard('', 'x'), 0);
  assert.equal(bigramJaccard('', ''), 0);
  assert.equal(bigramJaccard('按三類分節', '按三類分節'), 1);
});

// ---- 移植合併輪 U1b：開場 prompt 的參考檔 attachments 混型（共用層 {scope,name} 用「名稱（公司）」當鍵與顯示名） ----

test('U1b ⑥：開場 prompt attachments 混型——{scope,name} 顯示「名稱（公司）」「名稱（分類）」並以此當 refTexts 的鍵；不炸、無 [object Object]', () => {
  const def = structuredClone(DEF);
  def.nodes[1].attachments = ['規格.md', { scope: 'company', name: '範本.md' }, { scope: 'category', name: '往期.xlsx' }];
  const p = buildBriefPrompt({ def, params: {}, paramLabels: {}, refTexts: { '規格.md': 'y', '範本.md（組織）': '公司範本內容' } });
  assert.ok(p.includes('【參考檔：規格.md】\ny'));
  assert.ok(p.includes('【參考檔：範本.md（組織）】\n公司範本內容'), p);
  assert.ok(p.includes('【參考檔：往期.xlsx（分類）】'), '讀不出文字的只列名字（標層）');
  assert.ok(!p.includes('[object Object]'));
});

// ---- 拆法輪 B2 ⑤（契約 D）：能耐表只給拆解器，監工三個 prompt 不帶 ----

test('B2 ⑤：監工開場／交接／收尾 prompt 0 命中「你能派工人做什麼」與「# 關於你」', () => {
  const brief = buildBriefPrompt({ def: DEF, params: {}, paramLabels: {}, refTexts: {} });
  const hand = buildHandoffPrompt({ node: DEF.nodes[1], flags: { note: true, tier: true, tools: true } });
  const rec = buildRecordPrompt({ def: DEF, table: [{ node: 'a', title: '看資料', kind: 'task' }], outputs: [] });
  for (const p of [brief, hand, rec]) {
    assert.equal((p.match(/你能派工人做什麼/g) ?? []).length, 0, p);
    assert.equal((p.match(/# 關於你/g) ?? []).length, 0, p);
  }
});
