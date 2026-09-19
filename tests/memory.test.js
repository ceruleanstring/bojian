// memory — 記憶模組：卡的結構、詞典、群組拆條、範圍擴大、選項計數（純函式，零 AI、零檔案）
// M3b 起多一段門面 onRunStart 的檔案測試（臨時資料夾，跑完不留）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FIELD_KINDS, FACTORY_DICT, DORMANT_STREAK,
  newId, newCardId, makeCard, validateCard,
  matchField, ensureFields, similarFields, mergeFields,
  parseGroupText, coversWorkflow, widenScope, tickShown,
  MEMORY_ROUTE_RULES, buildRoutePrompt, parseRoute, route, paramSignal, stopEditSignal,
  selectCore, resolveOverrides, habitOptions, createMemory,
} from '../src/memory.js';
import { CheckParseError } from '../src/checker.js';
import { createStore } from '../src/store.js';

const HABIT_INPUT = {
  bucket: 'habit',
  text: '一天 3 個點',
  field: '旅行節奏',
  scope: { level: 'workflow', category: '旅遊', workflow: 'wf-1' },
  source: { kind: 'run-params', quote: '（開跑表單）旅行節奏：一天 3 個點' },
};

const PROFILE_INPUT = {
  bucket: 'profile',
  text: '不要客套',
  layer: 'expression',
  scope: { level: 'all' },
  source: { kind: 'chat', quote: '以後都不要客套' },
};

// ---- 詞典常數 ----

test('詞典常數：六類封閉、出廠十條（拆法輪加型態／分段／範圍）、語氣的同義詞含口吻', () => {
  assert.deepEqual(FIELD_KINDS, { appearance: '產出的樣子', audience: '對象', time: '時間', range: '範圍', limits: '資源與限制', method: '做法' });
  assert.equal(FACTORY_DICT.version, 1);
  assert.equal(FACTORY_DICT.fields.length, 10);
  assert.deepEqual(FACTORY_DICT.fields.map((f) => f.name), ['語氣', '長度', '格式', '讀者', '語言', '截止日', '產出檔類型', '型態', '分段', '範圍']);
  assert.ok(FACTORY_DICT.fields.every((f) => f.origin === 'factory' && Object.keys(FIELD_KINDS).includes(f.kind)));
  assert.ok(FACTORY_DICT.fields[0].synonyms.includes('口吻'));
  // ⑥／：三條的 kind 與同義詞（型態／分段歸「產出的樣子」、範圍歸「範圍」，六類不加新類）
  const byName = Object.fromEntries(FACTORY_DICT.fields.map((f) => [f.name, f]));
  assert.deepEqual([byName['型態'].kind, byName['型態'].synonyms], ['appearance', ['成品類型', '做成什麼']]);
  assert.deepEqual([byName['分段'].kind, byName['分段'].synonyms], ['appearance', ['段落', '章節']]);
  assert.deepEqual([byName['範圍'].kind, byName['範圍'].synonyms], ['range', ['期間', '涵蓋']]);
  assert.equal(DORMANT_STREAK, 5);
});

// ---- 卡的結構 ----

test('newCardId：習慣卡 h-、認識卡 p-，形如 <前綴>-<時間36進位>-<4碼>，連叫不重複', () => {
  const h = newCardId('habit');
  const p = newCardId('profile');
  assert.match(h, /^h-[0-9a-z]+-[0-9a-z]{4}$/);
  assert.match(p, /^p-[0-9a-z]+-[0-9a-z]{4}$/);
  const ids = new Set(Array.from({ length: 50 }, () => newCardId('habit')));
  assert.equal(ids.size, 50);
});

test('newId：任意前綴（身分 i-、群組條 g-），連叫不重複', () => {
  assert.match(newId('i'), /^i-[0-9a-z]+-[0-9a-z]{4}$/);
  const ids = new Set(Array.from({ length: 50 }, () => newId('i')));
  assert.equal(ids.size, 50);
});

test('makeCard：習慣卡正面五行＋背面缺省全補齊，id 以 h- 開頭', () => {
  const card = makeCard(HABIT_INPUT);
  assert.ok(card.id.startsWith('h-'));
  assert.equal(card.bucket, 'habit');
  assert.equal(card.text, '一天 3 個點');
  assert.equal(card.who, 'you');
  assert.equal(card.field, '旅行節奏');
  assert.equal('layer' in card, false, '習慣卡沒有 layer');
  assert.deepEqual(card.scope, { level: 'workflow', category: '旅遊', workflow: 'wf-1' });
  assert.equal(card.source.kind, 'run-params');
  assert.equal(card.source.quote, '（開跑表單）旅行節奏：一天 3 個點');
  assert.equal(card.expires, null);
  assert.equal(card.status, 'active');
  assert.equal(card.replaces, null);
  assert.equal(card.replaced_by, null);
  assert.equal(typeof card.created_at, 'string');
  assert.ok(!Number.isNaN(Date.parse(card.created_at)), 'created_at 要是 ISO 字串');
  assert.equal(card.last_used_at, null);
  assert.equal(card.shown_count, 0);
  assert.equal(card.picked_count, 0);
  assert.equal(card.changed_count, 0);
  assert.equal(card.unpicked_streak, 0);
  assert.deepEqual(card.scope_log, []);
  assert.equal(card.route_reason, '');
});

test('makeCard：認識卡 id 以 p- 開頭、帶 layer、不適用的 scope 鍵補 null、source 缺的鍵補 null', () => {
  const card = makeCard(PROFILE_INPUT);
  assert.ok(card.id.startsWith('p-'));
  assert.equal(card.layer, 'expression');
  assert.equal('field' in card, false, '認識卡沒給 field 就不帶');
  assert.deepEqual(card.scope, { level: 'all', category: null, workflow: null });
  assert.deepEqual(card.source, { kind: 'chat', category: null, workflow: null, run: null, node: null, at: card.created_at, quote: '以後都不要客套' });
  const withField = makeCard({ ...PROFILE_INPUT, field: '讀者', layer: 'content', expires: '2026-12-31', route_reason: '對人' });
  assert.equal(withField.field, '讀者');
  assert.equal(withField.layer, 'content');
  assert.equal(withField.expires, '2026-12-31');
  assert.equal(withField.route_reason, '對人');
});

test('validateCard：合法卡回空清單；七種錯各自一句人話', () => {
  assert.deepEqual(validateCard(makeCard(HABIT_INPUT)), []);
  assert.deepEqual(validateCard(makeCard(PROFILE_INPUT)), []);
  assert.ok(validateCard(makeCard({ ...HABIT_INPUT, text: '  ' })).includes('卡要有內容'));
  assert.ok(validateCard(makeCard({ ...HABIT_INPUT, field: null })).includes('習慣卡要對到詞典裡的欄位'));
  assert.ok(validateCard(makeCard({ ...HABIT_INPUT, scope: { level: 'team' } })).includes('用在哪只能是全部、分類、Workflow'));
  assert.ok(validateCard(makeCard({ ...HABIT_INPUT, scope: { level: 'workflow', category: '旅遊' } })).includes('用在 Workflow 時要指定分類和 Workflow'));
  assert.ok(validateCard(makeCard({ ...HABIT_INPUT, scope: { level: 'category' } })).includes('用在分類時要指定分類'));
  assert.throws(() => widenScope(makeCard(HABIT_INPUT), { level: 'workflow' }), /範圍只能往外擴（分類、全部）/);
  assert.ok(validateCard(makeCard({ ...HABIT_INPUT, source: { kind: 'run-params' } })).includes('沒有出處的卡不存在'));
  assert.ok(validateCard(makeCard({ ...HABIT_INPUT, expires: '明天' })).includes('有效期要是 YYYY-MM-DD'));
  // 反例要用「不是他自己打的字」那種出處：feedback（跑完丟的一句）2026-09-19 起是合法的認識卡來源
  assert.ok(validateCard(makeCard({ ...PROFILE_INPUT, source: { kind: 'run-params', quote: '一天 3 個點' } })).includes('認識卡的來源只限你打的字'));
  assert.deepEqual(validateCard(makeCard({ ...PROFILE_INPUT, source: { kind: 'feedback', quote: '民宿太遠' } })), [], 'feedback 也是他自己打的字');
  // 認識卡的層級只准 expression／content；habit 沒有 layer 不驗
  const LAYER_MSG = '認識卡的層級只能是表達層或內容層';
  assert.ok(validateCard(makeCard({ ...PROFILE_INPUT, layer: 'x' })).includes(LAYER_MSG));
  assert.ok(!validateCard(makeCard({ ...PROFILE_INPUT, layer: 'content' })).includes(LAYER_MSG));
  assert.ok(validateCard({ ...makeCard(PROFILE_INPUT), layer: undefined }).includes(LAYER_MSG), '手組的認識卡沒 layer 也擋');
  assert.ok(!validateCard(makeCard(HABIT_INPUT)).includes(LAYER_MSG));
  // 給了詞典：習慣卡的 field 要對得到（同義詞也算）
  assert.deepEqual(validateCard(makeCard({ ...HABIT_INPUT, field: '口吻' }), FACTORY_DICT), []);
  assert.ok(validateCard(makeCard(HABIT_INPUT), FACTORY_DICT).includes('習慣卡要對到詞典裡的欄位'), '旅行節奏不在出廠詞典');
  // 錯不只一處＝一次全列
  const many = validateCard(makeCard({ ...HABIT_INPUT, text: '', field: '', expires: 'x' }));
  assert.ok(many.length >= 3);
});

// ---- 詞典 ----

test('matchField：名字或同義詞相等（兩側 trim）→回該條；對不上回 null', () => {
  assert.equal(matchField(FACTORY_DICT, '口吻').name, '語氣');
  assert.equal(matchField(FACTORY_DICT, ' 語氣 ').name, '語氣');
  assert.equal(matchField(FACTORY_DICT, '什麼時候要').name, '截止日');
  assert.equal(matchField(FACTORY_DICT, '旅行節奏'), null);
  assert.equal(matchField(FACTORY_DICT, ''), null);
  assert.equal(matchField(FACTORY_DICT, null), null);
});

test('ensureFields：對不上的 label 新建一條（kind 沒給＝method、origin 帶分類與流程）；同義詞不新建；不動原詞典', () => {
  const dict = structuredClone(FACTORY_DICT);
  const { dict: next, added } = ensureFields(dict, [{ label: '旅行節奏', kind: 'method' }, { label: '篇幅' }], { category: '旅遊', workflow: 'wf-1' });
  assert.equal(added.length, 1);
  assert.equal(added[0].name, '旅行節奏');
  assert.equal(next.fields.length, 11);
  assert.equal(dict.fields.length, 10, '原詞典不被改');
  const f = matchField(next, '旅行節奏');
  assert.equal(f.kind, 'method');
  assert.deepEqual(f.synonyms, []);
  assert.deepEqual(f.origin, { category: '旅遊', workflow: 'wf-1' });
  assert.equal(typeof f.created_at, 'string');
  // kind 不在六類＝method；同一批重複 label 只建一條；沒 label 的跳過
  const r2 = ensureFields(dict, [{ label: '住宿', kind: '色彩' }, { label: '住宿' }, { key: 'x' }]);
  assert.equal(r2.added.length, 1);
  assert.equal(r2.added[0].kind, 'method');
  assert.deepEqual(r2.added[0].origin, { category: null, workflow: null });
});

test('similarFields：與既有名字或同義詞互為子字串（至少兩字）的名字清單；完全相同不算', () => {
  const { dict } = ensureFields(FACTORY_DICT, [{ label: '出發日', kind: 'time' }]);
  assert.ok(similarFields(dict, '出發日期').includes('出發日'));
  assert.ok(similarFields(dict, '發日').includes('出發日'), '反向子字串也算');
  assert.deepEqual(similarFields(dict, '出發日'), [], '完全相同走 matchField，不算像');
  assert.deepEqual(similarFields(dict, '日'), [], '一個字不算');
  assert.ok(similarFields(dict, '口吻與用字').includes('語氣'), '同義詞也比');
});

test('mergeFields：drop 的名字與同義詞併進 keep、drop 從詞典移除、掛在 drop 的卡改掛 keep 並回傳', () => {
  const { dict } = ensureFields(FACTORY_DICT, [{ label: '出發日', kind: 'time' }]);
  const c1 = makeCard({ ...HABIT_INPUT, field: '出發日', text: '週五' });
  const c2 = makeCard({ ...HABIT_INPUT, field: '語氣', text: '輕鬆' });
  const r = mergeFields(dict, [c1, c2], '截止日', '出發日');
  assert.equal(matchField(r.dict, '出發日').name, '截止日');
  assert.equal(r.dict.fields.some((f) => f.name === '出發日'), false);
  assert.ok(r.dict.fields.find((f) => f.name === '截止日').synonyms.includes('出發日'));
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].id, c1.id);
  assert.equal(r.cards[0].field, '截止日');
  assert.equal(c1.field, '出發日', '不改原卡物件');
  assert.throws(() => mergeFields(dict, [], '截止日', '沒這條'), /沒這條/);
});

// ---- 群組圈 ----

test('parseGroupText：一行一條、空行略過；「詞典名或同義詞：值」全形半形冒號都認；其餘是自由規矩', () => {
  const rules = parseGroupText('語氣：輕鬆\n\n不提競品\n口吻: 直白', FACTORY_DICT);
  assert.equal(rules.length, 3);
  assert.equal(rules[0].text, '語氣：輕鬆');
  assert.equal(rules[0].field, '語氣');
  assert.equal(rules[0].value, '輕鬆');
  assert.equal(rules[1].text, '不提競品');
  assert.equal(rules[1].field, null);
  assert.equal(rules[1].value, null);
  assert.equal(rules[2].field, '語氣');
  assert.equal(rules[2].value, '直白');
  for (const r of rules) {
    assert.match(r.id, /^g-[0-9a-z]+-[0-9a-z]{4}$/);
    assert.equal(r.status, 'active');
    assert.equal(typeof r.created_at, 'string');
  }
  // 詞典裡沒有的名字＝自由規矩；名字對到但值空＝自由規矩
  const other = parseGroupText('住宿：市區優先\n語氣：', FACTORY_DICT);
  assert.equal(other[0].field, null);
  assert.equal(other[1].field, null);
});

test('parseGroupText：再存一次同文字保留原 id；少掉的行標 retired 留著；重新出現的行拿回原 id', () => {
  const first = parseGroupText('語氣：輕鬆\n不提競品', FACTORY_DICT);
  const second = parseGroupText('不提競品\n多用表格', FACTORY_DICT, first);
  const byText = Object.fromEntries(second.map((r) => [r.text, r]));
  assert.equal(byText['不提競品'].id, first[1].id);
  assert.equal(byText['不提競品'].status, 'active');
  assert.equal(byText['語氣：輕鬆'].id, first[0].id);
  assert.equal(byText['語氣：輕鬆'].status, 'retired');
  assert.equal(byText['多用表格'].status, 'active');
  assert.notEqual(byText['多用表格'].id, first[0].id);
  assert.equal(second.filter((r) => r.status === 'active').length, 2);
  const third = parseGroupText('語氣：輕鬆', FACTORY_DICT, second);
  assert.equal(third.find((r) => r.text === '語氣：輕鬆').id, first[0].id, '重新出現拿回原 id');
  assert.equal(third.find((r) => r.text === '語氣：輕鬆').status, 'active');
  assert.deepEqual(parseGroupText('', FACTORY_DICT), []);
});

// ---- 用在哪 ----

test('coversWorkflow：全部→都涵蓋；分類→同分類；流程→同分類同流程（分類 null 不當萬用）', () => {
  const here = { category: '旅遊', workflow: 'wf-1' };
  assert.equal(coversWorkflow({ level: 'all', category: null, workflow: null }, here), true);
  assert.equal(coversWorkflow({ level: 'category', category: '旅遊', workflow: null }, here), true);
  assert.equal(coversWorkflow({ level: 'category', category: '工作', workflow: null }, here), false);
  assert.equal(coversWorkflow({ level: 'workflow', category: '旅遊', workflow: 'wf-1' }, here), true);
  assert.equal(coversWorkflow({ level: 'workflow', category: '旅遊', workflow: 'wf-2' }, here), false);
  assert.equal(coversWorkflow({ level: 'workflow', category: null, workflow: 'wf-1' }, here), false, '分類 null 不是萬用');
  assert.equal(coversWorkflow({ level: 'workflow', category: '工作', workflow: 'wf-1' }, here), false, '同流程 id 但分類不同');
  assert.equal(coversWorkflow({ level: 'all', category: '旅遊', workflow: 'wf-9' }, here), true, 'all 不看其他鍵');
  assert.equal(coversWorkflow(makeCard(HABIT_INPUT), here), true, '直接給卡也行');
  assert.equal(coversWorkflow({ level: 'team' }, here), false);
});

test('widenScope：流程→分類、分類→全部，scope_log 記 from/to/why；不改原卡', () => {
  const card = makeCard(HABIT_INPUT);
  const wider = widenScope(card, { category: '旅遊' });
  assert.equal(wider.scope.level, 'category');
  assert.equal(wider.scope.category, '旅遊');
  assert.equal(wider.scope.workflow, null);
  assert.equal(wider.scope_log.length, 1);
  assert.equal(wider.scope_log[0].from.level, 'workflow');
  assert.equal(wider.scope_log[0].from.workflow, 'wf-1');
  assert.equal(wider.scope_log[0].to.level, 'category');
  assert.equal(typeof wider.scope_log[0].at, 'string');
  assert.ok(wider.scope_log[0].why);
  assert.equal(card.scope.level, 'workflow', '原卡不動');
  const all = widenScope(wider, { level: 'all', why: '跨分類也選了' });
  assert.deepEqual(all.scope, { level: 'all', category: null, workflow: null });
  assert.equal(all.scope_log.length, 2);
  assert.equal(all.scope_log[1].why, '跨分類也選了');
  assert.equal(widenScope(wider, {}).scope.level, 'all', '沒給分類＝再往外一圈');
  assert.throws(() => widenScope(card, { level: 'team' }), /用在哪只能是全部、分類、Workflow/);
});

test('tickShown：沒被選五次→休眠；被選→連續未選歸零、被選次數加一、last_used_at 更新；不改原卡', () => {
  let card = makeCard(HABIT_INPUT);
  for (let i = 0; i < DORMANT_STREAK - 1; i += 1) card = tickShown(card, false);
  assert.equal(card.status, 'active');
  assert.equal(card.unpicked_streak, 4);
  card = tickShown(card, false);
  assert.equal(card.status, 'dormant');
  assert.equal(card.unpicked_streak, 5);
  assert.equal(card.shown_count, 5);
  assert.equal(card.picked_count, 0);
  const original = makeCard(HABIT_INPUT);
  const picked = tickShown(original, true);
  assert.equal(picked.unpicked_streak, 0);
  assert.equal(picked.picked_count, 1);
  assert.equal(picked.shown_count, 1, '被選的也算出現過一次');
  assert.equal(typeof picked.last_used_at, 'string');
  assert.equal(original.picked_count, 0, '原卡不動');
  // 休眠後被選＝回到 active
  const revived = tickShown(card, true);
  assert.equal(revived.status, 'active');
  assert.equal(revived.unpicked_streak, 0);
});

// ---- M2：三問路由（純函式）＋兩條程式判的記路 ----

const ROUTE_ARGS = () => ({
  text: '民宿太遠了，以後選市區的',
  dict: FACTORY_DICT,
  categories: ['旅遊', '工作'],
  category: '旅遊',
  workflowName: '東京行程',
  paramLabels: ['旅行節奏', '住宿'],
  sensitive: { health: false, politics: false, religion: false, finance: false },
});

test('MEMORY_ROUTE_RULES：首句與三問、敏感四類、只輸出一個 JSON 物件（逐字）', () => {
  assert.ok(MEMORY_ROUTE_RULES.startsWith('你是「剝繭」的記憶整理員。使用者剛說了一句話，請照三個問題判它該記成什麼：'));
  assert.ok(MEMORY_ROUTE_RULES.includes('1. 它是不是「欄位詞典」裡某一格的答案？是→第 2 問；不是→第 3 問。'));
  assert.ok(MEMORY_ROUTE_RULES.includes('2. 換個場合他會不會填別的？會→對事，記成習慣卡（bucket 寫 habit，field 寫詞典裡那一格的正式名；詞典裡沒有但確實是某一格的答案，field 寫新名字並給 kind）；不會→對人，記成認識卡表達層（bucket 寫 profile，layer 寫 expression）。'));
  assert.ok(MEMORY_ROUTE_RULES.includes('3. 講的是他和他的世界（他、他的人、他的處境），還是這一趟的內容？他的世界→認識卡內容層（bucket 寫 profile，layer 寫 content）；這一趟的內容→不記（bucket 寫 none）。'));
  assert.ok(MEMORY_ROUTE_RULES.includes('複句拆成多張。不記觀點與立場；健康、政治、宗教、財務四類一律不記，除了「允許的敏感類別」列出的。text 用他的原意改寫成一句可以直接照做的話，不加東西。'));
  assert.ok(MEMORY_ROUTE_RULES.endsWith('只輸出一個 JSON 物件，前後不要任何其他文字：{"cards":[{"bucket":"habit","field":"…","kind":null,"layer":null,"text":"…","reason":"…"}]}'));
  // 六句以換行相接（給模型好讀）；剝除換行後與計畫契約 (c) 的原文逐字元相同（原文直接從計畫檔複製）
  assert.equal(
    MEMORY_ROUTE_RULES.replace(/\n/g, ''),
    '你是「剝繭」的記憶整理員。使用者剛說了一句話，請照三個問題判它該記成什麼：1. 它是不是「欄位詞典」裡某一格的答案？是→第 2 問；不是→第 3 問。2. 換個場合他會不會填別的？會→對事，記成習慣卡（bucket 寫 habit，field 寫詞典裡那一格的正式名；詞典裡沒有但確實是某一格的答案，field 寫新名字並給 kind）；不會→對人，記成認識卡表達層（bucket 寫 profile，layer 寫 expression）。3. 講的是他和他的世界（他、他的人、他的處境），還是這一趟的內容？他的世界→認識卡內容層（bucket 寫 profile，layer 寫 content）；這一趟的內容→不記（bucket 寫 none）。複句拆成多張。不記觀點與立場；健康、政治、宗教、財務四類一律不記，除了「允許的敏感類別」列出的。text 用他的原意改寫成一句可以直接照做的話，不加東西。只輸出一個 JSON 物件，前後不要任何其他文字：{"cards":[{"bucket":"habit","field":"…","kind":null,"layer":null,"text":"…","reason":"…"}]}',
  );
});

test('buildRoutePrompt：規則→他說的話→提示→欄位詞典→這條流程的欄位→允許的敏感類別；全關＝（無）', () => {
  const p = buildRoutePrompt({ ...ROUTE_ARGS(), hint: 'feedback' });
  assert.ok(p.startsWith(MEMORY_ROUTE_RULES), '規則全文打頭');
  const order = ['# 他說的話', '民宿太遠了，以後選市區的', '# 提示', '這句是跑完的回饋，通常記成習慣卡；判斷仍照三問', '# 欄位詞典', '- 語氣（產出的樣子；同義：口吻、風格）', '- 截止日（時間；同義：交期、什麼時候要）', '# 這條流程的欄位', '- 旅行節奏', '- 住宿', '# 允許的敏感類別\n（無）'];
  let last = -1;
  for (const s of order) {
    const i = p.indexOf(s);
    assert.ok(i > last, `「${s}」要在對的位置：${p}`);
    last = i;
  }
  assert.ok(p.includes('分類「旅遊」') && p.includes('流程「東京行程」'), '場合寫在提示段');
  // 沒提示、沒流程欄位、開了兩類敏感
  const q = buildRoutePrompt({ ...ROUTE_ARGS(), category: null, workflowName: null, paramLabels: [], sensitive: { health: true, finance: true } });
  assert.ok(!q.includes('# 提示'), '沒提示也沒場合＝沒有提示段');
  assert.ok(q.includes('# 這條流程的欄位\n（無）'));
  assert.ok(q.includes('# 允許的敏感類別\n- 健康\n- 財務'));
  assert.ok(buildRoutePrompt({ ...ROUTE_ARGS(), hint: 'chat' }).includes('這句是聊天，通常記成認識卡'));
  assert.ok(buildRoutePrompt({ ...ROUTE_ARGS(), hint: 'stop-note' }).includes('這句是停點註記，通常記成認識卡'));
  assert.ok(buildRoutePrompt({ ...ROUTE_ARGS(), hint: 'stop-edit' }).includes('這句是停點註記，通常記成習慣卡'));
});

test('parseRoute：一張合法習慣卡；habit 沒 field、profile 沒 layer、text 空、bucket 怪的都過濾；kind 只認六類；最多三張', () => {
  const one = parseRoute('{"cards":[{"bucket":"habit","field":"住宿","text":"市區優先"}]}');
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], { bucket: 'habit', field: '住宿', kind: null, layer: null, text: '市區優先', reason: '' });
  const mixed = parseRoute(JSON.stringify({ cards: [
    { bucket: 'habit', text: '沒欄位' },
    { bucket: 'profile', text: '沒層' },
    { bucket: 'profile', layer: 'content', text: '  ' },
    { bucket: 'team', text: '怪桶' },
    { bucket: 'profile', layer: 'expression', text: ' 不要客套 ', reason: '對人', kind: '色彩', field: '語氣' },
    { bucket: 'habit', field: '節奏', kind: 'method', text: '一天三個點', reason: '對事' },
    { bucket: 'none', text: '', reason: '這一趟的內容' },
    { bucket: 'habit', field: '第四張', text: '超過三張要截' },
  ] }));
  assert.equal(mixed.length, 3);
  assert.deepEqual(mixed[0], { bucket: 'profile', field: '語氣', kind: null, layer: 'expression', text: '不要客套', reason: '對人' });
  assert.deepEqual(mixed[1], { bucket: 'habit', field: '節奏', kind: 'method', layer: null, text: '一天三個點', reason: '對事' });
  assert.equal(mixed[2].bucket, 'none');
  // 圍欄與前後文都吃得下；兩份內容不同的候選＝含糊丟 CheckParseError；純文字＝沒結果也丟
  assert.equal(parseRoute('好的：\n```json\n{"cards":[{"bucket":"none","text":""}]}\n```').length, 1);
  assert.throws(() => parseRoute('{"cards":[{"bucket":"habit","field":"a","text":"x"}]}\n{"cards":[{"bucket":"habit","field":"b","text":"y"}]}'), CheckParseError);
  assert.throws(() => parseRoute('這句我覺得不用記'), CheckParseError);
  assert.throws(() => parseRoute('{"note":"沒有 cards"}'), CheckParseError);
});

test('route：meta.kind=memory、phase=route；onPrompt／onReply 各一次且存的＝送的；純文字→{ok:false, fail_note} 不 throw；空句不呼叫', async () => {
  const calls = [];
  const notes = [];
  const adapter = { async complete({ prompt, meta }) { calls.push({ prompt, meta }); return '{"cards":[{"bucket":"habit","field":"住宿","text":"市區優先","reason":"換個場合會填別的"}]}'; } };
  const res = await route({ adapter, meta: { category: '旅遊', workflow: 'wf-1', run: 'r-1', node: 'a' }, onPrompt: (t) => notes.push(['p', t]), onReply: (t) => notes.push(['r', t]), ...ROUTE_ARGS(), hint: 'feedback' });
  assert.equal(res.ok, true);
  assert.equal(res.cards.length, 1);
  assert.equal(res.cards[0].field, '住宿');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].meta, { category: '旅遊', workflow: 'wf-1', run: 'r-1', node: 'a', kind: 'memory', phase: 'route' });
  assert.equal(notes.length, 2);
  assert.equal(notes[0][0], 'p');
  assert.equal(notes[0][1], calls[0].prompt, '卷宗存的全文＝送出的全文');
  assert.equal(notes[1][0], 'r');
  assert.ok(notes[1][1].includes('市區優先'));
  const bad = await route({ adapter: { async complete() { return '這句我覺得不用記'; } }, ...ROUTE_ARGS() });
  assert.equal(bad.ok, false);
  assert.ok(bad.fail_note.startsWith('這句沒記成：'), bad.fail_note);
  const boom = await route({ adapter: { async complete() { throw new Error('連不上 Claude'); } }, ...ROUTE_ARGS() });
  assert.equal(boom.ok, false);
  assert.ok(boom.fail_note.includes('連不上 Claude'));
  let called = 0;
  const empty = await route({ adapter: { async complete() { called += 1; return ''; } }, ...ROUTE_ARGS(), text: '  ' });
  assert.equal(empty.ok, false);
  assert.equal(called, 0, '空句不打 AI');
  assert.ok(empty.fail_note.includes('沒有句子'));
});

test('paramSignal：兩趟同值非預設且沒點卡→一張草稿；等於預設、有 picks、已有同欄位同內容的 active 卡、沒有前一趟、長段落→無', () => {
  const def = { name: '東京行程', params: [{ key: 'pace', label: '旅行節奏', default: '一天 5 個點' }, { key: 'stay', label: '住宿', default: '' }, { key: 'memo', label: '備註', default: '' }] };
  const prevRun = { params: { pace: '一天 3 個點', stay: '市區', memo: '很長\n兩行' }, steps: {} };
  const run = { params: { pace: '一天 3 個點', stay: '市區', memo: '很長\n兩行' }, memory: { picks: {} } };
  const out = paramSignal({ def, prevRun, run });
  assert.deepEqual(out.map((s) => s.label), ['旅行節奏', '住宿'], '多行的值不成卡');
  assert.deepEqual(out[0], { key: 'pace', label: '旅行節奏', text: '一天 3 個點', quote: '（開跑表單）旅行節奏：一天 3 個點' });
  // 等於預設→無
  assert.deepEqual(paramSignal({ def, prevRun: { params: { pace: '一天 5 個點' } }, run: { params: { pace: '一天 5 個點' } } }), []);
  // 這趟從卡點來的→無（picks 從 run.memory.picks 讀，也可直接給）
  assert.deepEqual(paramSignal({ def, prevRun, run: { ...run, memory: { picks: { pace: 'h-1', stay: 'h-2' } } } }), []);
  assert.deepEqual(paramSignal({ def, prevRun, run, picks: { pace: 'h-1' } }).map((s) => s.key), ['stay']);
  // 已有同 field 同 text 的 active 習慣卡→無；退休的不算
  const have = makeCard({ bucket: 'habit', text: '一天 3 個點', field: '旅行節奏', scope: { level: 'all' }, source: { kind: 'manual', quote: 'x' } });
  assert.deepEqual(paramSignal({ def, prevRun, run, cards: [have] }).map((s) => s.key), ['stay']);
  assert.deepEqual(paramSignal({ def, prevRun, run, cards: [{ ...have, status: 'retired' }] }).map((s) => s.key), ['pace', 'stay']);
  // 前一趟值不同、或沒有前一趟→無
  assert.deepEqual(paramSignal({ def, prevRun: { params: { pace: '一天 4 個點', stay: '郊區' } }, run }), []);
  assert.deepEqual(paramSignal({ def, prevRun: null, run }), []);
});

test('stopEditSignal：前一趟那一步改過（且這趟也改了）→true；前趟沒改、沒前趟、這趟沒改→false', () => {
  const edited = { steps: { a: { edited_output: '改過' } } };
  const clean = { steps: { a: { edited_output: null } } };
  assert.equal(stopEditSignal({ prevRun: edited, run: edited, nodeId: 'a' }), true);
  assert.equal(stopEditSignal({ prevRun: edited, nodeId: 'a' }), true, '不給這趟＝只看前趟');
  assert.equal(stopEditSignal({ prevRun: clean, run: edited, nodeId: 'a' }), false);
  assert.equal(stopEditSignal({ prevRun: null, run: edited, nodeId: 'a' }), false);
  assert.equal(stopEditSignal({ prevRun: edited, run: clean, nodeId: 'a' }), false);
  assert.equal(stopEditSignal({ prevRun: edited, run: edited, nodeId: 'b' }), false, '別的步驟不算');
});

// ---- M3a：拿——選卡與外圈蓋內圈（純函式，零 AI）----

const TODAY = '2026-09-09';
// 認識卡：給 created_at 與可選的 last_used_at／狀態／範圍
const profile = (over, created = '2026-01-01T00:00:00.000Z', extra = {}) => ({ ...makeCard({ ...PROFILE_INPUT, ...over }, created), ...extra });

test('selectCore：表達層全帶（依 created_at）；內容層只留場合對上的、依 last_used_at 新→舊取前 3；暫停→空', () => {
  const here = { category: '旅遊', workflowId: 'wf-1', today: TODAY };
  const e3 = profile({ text: '表達3' }, '2026-01-03T00:00:00.000Z');
  const e1 = profile({ text: '表達1' }, '2026-01-01T00:00:00.000Z');
  const e4 = profile({ text: '表達4' }, '2026-01-04T00:00:00.000Z');
  const e2 = profile({ text: '表達2' }, '2026-01-02T00:00:00.000Z');
  const c1 = profile({ text: '全部・三月用過', layer: 'content' }, '2026-01-01T00:00:00.000Z', { last_used_at: '2026-03-01T00:00:00.000Z' });
  const c2 = profile({ text: '旅遊・五月用過', layer: 'content', scope: { level: 'category', category: '旅遊' } }, '2026-01-01T00:00:00.000Z', { last_used_at: '2026-05-01T00:00:00.000Z' });
  const c3 = profile({ text: '這條流程・四月用過', layer: 'content', scope: { level: 'workflow', category: '旅遊', workflow: 'wf-1' } }, '2026-01-01T00:00:00.000Z', { last_used_at: '2026-04-01T00:00:00.000Z' });
  const c4 = profile({ text: '全部・沒用過', layer: 'content' }, '2026-01-01T00:00:00.000Z');
  const c5 = profile({ text: '工作分類・六月用過', layer: 'content', scope: { level: 'category', category: '工作' } }, '2026-01-01T00:00:00.000Z', { last_used_at: '2026-06-01T00:00:00.000Z' });
  const all = [c5, e3, c1, e1, c4, e4, c2, e2, c3];
  const out = selectCore({ profileCards: all, ...here });
  assert.deepEqual(out.filter((c) => c.layer === 'expression').map((c) => c.text), ['表達1', '表達2', '表達3', '表達4'], '表達層全帶、依建立時間');
  assert.deepEqual(out.filter((c) => c.layer === 'content').map((c) => c.text), ['旅遊・五月用過', '這條流程・四月用過', '全部・三月用過'], '內容層場合對上的取最近用過三張；工作分類的不帶');
  assert.equal(out.length, 7);
  assert.deepEqual(out.slice(0, 4).map((c) => c.layer), ['expression', 'expression', 'expression', 'expression'], '表達層排前面');
  // 場合對上的不足三張＝有幾張帶幾張；沒用過的靠建立時間排
  const few = selectCore({ profileCards: [c4, c1], ...here });
  assert.deepEqual(few.map((c) => c.text), ['全部・三月用過', '全部・沒用過']);
  // 整層暫停→空
  assert.deepEqual(selectCore({ profileCards: all, ...here, paused: true }), []);
  // 身分限縮：只帶身分裡列的卡
  assert.deepEqual(selectCore({ profileCards: all, ...here, identity: { id: 'i-1', cards: [e2.id, c2.id, c5.id] } }).map((c) => c.text), ['表達2', '旅遊・五月用過']);
  // 沒給卡＝空
  assert.deepEqual(selectCore({ category: '旅遊', workflowId: 'wf-1' }), []);
});

test('selectCore：過期不帶（到期當天還算）；dormant／retired／replaced 不帶；習慣卡混進來也不帶', () => {
  const here = { category: '旅遊', workflowId: 'wf-1', today: TODAY };
  const expired = profile({ text: '昨天到期', expires: '2026-09-08' });
  const today = profile({ text: '今天到期' }, '2026-01-01T00:00:00.000Z', { expires: '2026-09-09' });
  const forever = profile({ text: '永久' });
  const dormant = profile({ text: '休眠' }, '2026-01-01T00:00:00.000Z', { status: 'dormant' });
  const retired = profile({ text: '退休' }, '2026-01-01T00:00:00.000Z', { status: 'retired' });
  const replaced = profile({ text: '被取代' }, '2026-01-01T00:00:00.000Z', { status: 'replaced' });
  const habit = makeCard(HABIT_INPUT);
  const out = selectCore({ profileCards: [expired, today, forever, dormant, retired, replaced, habit], ...here });
  assert.deepEqual(out.map((c) => c.text).sort(), ['今天到期', '永久']);
});

const OVERRIDE_DEF = () => ({ params: [{ key: 'tone', label: '語氣', default: '' }, { key: 'range', label: '範圍', default: '本季' }] });

test('resolveOverrides：有名字的欄位外圈蓋內圈（核心＜群組＜流程＜這一次）、自由規矩疊加、used 含帶進去的每一條', () => {
  const dict = FACTORY_DICT;
  const named = profile({ text: '講話直接', field: '口吻' }); // 同義詞也對得到正式名
  const free = profile({ text: '不要恭維' });
  const core = [free, named];
  const group = parseGroupText('語氣：輕鬆\n不提競品', dict);
  // 只有群組：核心的語氣被群組蓋掉；自由規矩兩圈都留
  const a = resolveOverrides({ core, group, def: OVERRIDE_DEF(), params: {}, dict });
  assert.deepEqual(a.coreLines, ['不要恭維']);
  assert.deepEqual(a.groupLines, ['語氣：輕鬆', '不提競品']);
  assert.deepEqual(a.overridden, [{ id: named.id, text: '講話直接', by: 'group', by_text: '輕鬆' }]);
  assert.deepEqual(a.used.map((u) => u.id), [free.id, group[0].id, group[1].id], 'used＝真的帶進去的：核心在前、群組在後');
  assert.deepEqual(a.used[0], { id: free.id, bucket: 'profile', text: '不要恭維', layer: 'expression', level: 'all' });
  assert.deepEqual(a.used[1], { id: group[0].id, bucket: 'group', text: '語氣：輕鬆', field: '語氣', level: 'category' });
  assert.deepEqual(a.used[2], { id: group[1].id, bucket: 'group', text: '不提競品', field: null, level: 'category' });
  // 流程的預設值非空：群組條也被蓋，核心被蓋的那一圈是流程（最外圈贏）
  const def = OVERRIDE_DEF();
  def.params[0].default = '正式';
  const b = resolveOverrides({ core, group, def, params: {}, dict });
  assert.deepEqual(b.coreLines, ['不要恭維']);
  assert.deepEqual(b.groupLines, ['不提競品']);
  assert.deepEqual(b.overridden, [
    { id: named.id, text: '講話直接', by: 'workflow', by_text: '正式' },
    { id: group[0].id, text: '語氣：輕鬆', by: 'workflow', by_text: '正式' },
  ]);
  assert.deepEqual(b.used.map((u) => u.id), [free.id, group[1].id]);
  // 這一次的值：開跑表單填了跟預設不同的值→by run
  const c = resolveOverrides({ core, group, def, params: { tone: '隨便', range: '本季' }, dict });
  assert.deepEqual(c.overridden.map((o) => [o.by, o.by_text]), [['run', '隨便'], ['run', '隨便']]);
  // 這一次的值等於流程預設＝值是流程給的，算流程那一圈
  const d = resolveOverrides({ core, group, def, params: { tone: '正式' }, dict });
  assert.deepEqual(d.overridden.map((o) => o.by), ['workflow', 'workflow']);
  // 沒有任何外圈值、群組沒有同名條→核心的有名字卡照帶
  const e = resolveOverrides({ core, group: parseGroupText('不提競品', dict), def: OVERRIDE_DEF(), params: {}, dict });
  assert.deepEqual(e.coreLines, ['不要恭維', '講話直接']);
  assert.deepEqual(e.overridden, []);
  assert.equal(e.used.length, 3);
  // 空值不算這一次的值；空白也不算
  const f = resolveOverrides({ core, group: [], def: OVERRIDE_DEF(), params: { tone: '  ' }, dict });
  assert.deepEqual(f.overridden, []);
  // 群組裡退休的條不帶；什麼都沒給＝四個空
  assert.deepEqual(resolveOverrides({ core: [], group: [{ ...group[1], status: 'retired' }], def: null, params: null, dict }), { coreLines: [], groupLines: [], used: [], overridden: [] });
  assert.deepEqual(resolveOverrides(), { coreLines: [], groupLines: [], used: [], overridden: [] });
});

test('resolveOverrides：沒給詞典就照字面比欄位名；群組同一欄位兩條都帶（同圈矛盾不在這裡判）', () => {
  const named = profile({ text: '講話直接', field: '語氣' });
  const syn = profile({ text: '用詞白話', field: '口吻' });
  const group = parseGroupText('語氣：輕鬆\n口吻：直白', FACTORY_DICT);
  const r = resolveOverrides({ core: [named, syn], group, def: null, params: {} });
  assert.deepEqual(r.groupLines, ['語氣：輕鬆', '口吻：直白']);
  assert.deepEqual(r.overridden.map((o) => o.text), ['講話直接'], '沒詞典：口吻≠語氣，只有字面同名的被蓋');
  assert.deepEqual(r.coreLines, ['用詞白話']);
});

// ---- M3b：開跑表單的習慣選項（純函式）＋門面 onRunStart 的計數、範圍擴大、認識卡 last_used_at ----

const HERE = { category: '旅遊', workflowId: 'wf-a' };
const habitAt = (over) => makeCard({ bucket: 'habit', text: 'x', field: '旅行節奏', scope: { level: 'workflow', category: '旅遊', workflow: 'wf-a' }, source: { kind: 'manual', quote: 'x' }, ...over });
const OPT_DEF = {
  format: 1, name: '東京行程',
  params: [
    { key: 'pace', label: '旅行節奏', default: '' },
    { key: 'tone', label: '口吻', default: '' }, // 語氣的同義詞：卡上寫「語氣」也要對得到
    { key: 'len', label: '長度', default: '' },
    { key: 'none', label: '沒卡的欄位', default: '' },
  ],
  nodes: [{ id: 'a', title: '排', executor: 'ai', stop_point: 'never', instruction: '排 {{pace}}', next: [] }],
};

test('habitOptions：本流程涵蓋的進 covers、同分類別條流程的 workflow 尺度卡進 probes（帶來源流程名）；同義詞對得到；休眠不列；沒卡的欄位沒有鍵；每欄回全部不截', () => {
  const cards = [
    habitAt({ id: 'h-own', text: '一天 3 個點' }),
    habitAt({ id: 'h-other', text: '一天 5 個點', scope: { level: 'workflow', category: '旅遊', workflow: 'wf-b' } }),
    habitAt({ id: 'h-inh', text: '市區優先', scope: { level: 'category', category: '旅遊' } }),
    habitAt({ id: 'h-tone', text: '輕鬆', field: '語氣', scope: { level: 'all' } }),
    habitAt({ id: 'h-len', text: '短一點', field: '長度', scope: { level: 'all' } }),
    habitAt({ id: 'h-dormant', text: '休眠的', status: 'dormant' }),
    habitAt({ id: 'h-retired', text: '退休的', status: 'retired' }),
    habitAt({ id: 'h-gone', text: '過期的', expires: '2000-01-01' }),
    habitAt({ id: 'h-else', text: '別分類的', scope: { level: 'category', category: '工作' } }),
    habitAt({ id: 'h-else-wf', text: '別分類別條的', scope: { level: 'workflow', category: '工作', workflow: 'wf-c' } }),
    makeCard({ bucket: 'profile', text: '不要客套', layer: 'expression', scope: { level: 'all' }, source: { kind: 'manual', quote: 'x' } }),
  ];
  const o = habitOptions({ habitCards: cards, def: OPT_DEF, ...HERE, dict: FACTORY_DICT, workflowNames: { 'wf-b': '大阪行程' } });
  assert.deepEqual(Object.keys(o).sort(), ['len', 'pace', 'tone'], '沒卡的欄位不出現');
  assert.deepEqual(o.pace.covers.map((c) => c.id), ['h-own', 'h-inh'], '本流程的與分類繼承的都算涵蓋；休眠、退休、過期、別分類的不列');
  assert.deepEqual(o.pace.probes.map((c) => c.id), ['h-other'], '同分類別條流程的 workflow 尺度卡');
  assert.equal(o.pace.probes[0].from, '大阪行程', '虛線 chip 標「來自「流程名」」');
  assert.deepEqual(o.tone.covers.map((c) => c.id), ['h-tone'], '欄位「口吻」用同義詞對到卡上的「語氣」');
  assert.deepEqual(o.tone.probes, []);
  assert.deepEqual(o.len.covers.map((c) => c.id), ['h-len']);
  assert.ok(!('none' in o));
  // 每欄回全部（截 3 由前端做）
  const many = Array.from({ length: 6 }, (_, i) => habitAt({ id: `h-m${i}`, text: `第 ${i} 種` }));
  assert.equal(habitOptions({ habitCards: many, def: OPT_DEF, ...HERE }).pace.covers.length, 6);
  // 沒給流程名對照表＝用流程 id 當名字；沒詞典＝照字面比
  const bare = habitOptions({ habitCards: cards, def: OPT_DEF, ...HERE });
  assert.equal(bare.pace.probes[0].from, 'wf-b');
  assert.ok(!('tone' in bare), '沒詞典：口吻對不到語氣');
});

// 門面：臨時資料夾＋三條流程（旅遊 wf-a／wf-b、工作 wf-c）
function facadeSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-memory-'));
  const store = createStore(dir);
  store.writeWorkflow('旅遊', 'wf-a', OPT_DEF);
  store.writeWorkflow('旅遊', 'wf-b', { ...OPT_DEF, name: '大阪行程' });
  store.writeWorkflow('工作', 'wf-c', { ...OPT_DEF, name: '出差' });
  const memory = createMemory({ store });
  // 一趟開跑後的 run（runner.startRun 寫的形狀）：先落地，門面的通知才有地方寫
  const runOf = (category, id, { picks = {}, changed = [], identity = null, params = {} } = {}) => {
    const def = store.readWorkflow(category, id);
    const run = {
      run_id: newId('r'), workflow: { category, id, name: def.name }, def, status: 'running', params,
      started_at: new Date().toISOString(), finished_at: null,
      memory: { identity, picks, changed, prev_run: null, notices: [] },
      steps: { a: { status: 'pending', output: null } },
    };
    store.writeRun(category, id, run.run_id, run);
    return run;
  };
  const start = (category, id, opts) => {
    const run = runOf(category, id, opts);
    memory.onRunStart({ category, id, run, prevRun: null });
    return store.readRun(category, id, run.run_id);
  };
  return { store, memory, start };
}

test('onRunStart 計數：picks 內的卡 picked_count＋1、last_used_at 更新、連續未選歸零；出現在選項但沒被選的 shown_count＋1、unpicked_streak＋1；第五次沒選→dormant；changed 內的卡 changed_count＋1；點的卡不存在不炸', () => {
  const { store, start } = facadeSetup();
  store.writeCard(habitAt({ id: 'h-1', text: '一天 3 個點' }));
  store.writeCard(habitAt({ id: 'h-2', text: '一天 5 個點' }));
  store.writeCard(habitAt({ id: 'h-3', text: '一天 8 個點' }));
  const r = start('旅遊', 'wf-a', { picks: { pace: 'h-1' }, changed: ['h-3'], params: { pace: '一天 3 個點' } });
  const h1 = store.readCard('habit', 'h-1');
  assert.equal(h1.picked_count, 1);
  assert.equal(h1.shown_count, 1, '被選的也算出現過一次');
  assert.equal(h1.unpicked_streak, 0);
  assert.equal(typeof h1.last_used_at, 'string');
  assert.equal(h1.scope.level, 'workflow', '本流程的卡：範圍不動');
  const h2 = store.readCard('habit', 'h-2');
  assert.equal(h2.shown_count, 1);
  assert.equal(h2.picked_count, 0);
  assert.equal(h2.unpicked_streak, 1);
  assert.equal(h2.last_used_at, null);
  const h3 = store.readCard('habit', 'h-3');
  assert.equal(h3.changed_count, 1, '點了又改掉：只記數');
  assert.equal(h3.picked_count, 0, '改掉了就不算被選');
  assert.equal(h3.shown_count, 1);
  assert.deepEqual(r.memory.notices, [], '本流程的卡被選：沒有擴大、沒有通知');
  for (let i = 0; i < DORMANT_STREAK - 2; i += 1) start('旅遊', 'wf-a', { picks: { pace: 'h-1' } });
  assert.equal(store.readCard('habit', 'h-2').status, 'active');
  assert.equal(store.readCard('habit', 'h-2').unpicked_streak, DORMANT_STREAK - 1);
  start('旅遊', 'wf-a', { picks: { pace: 'h-1' } });
  assert.equal(store.readCard('habit', 'h-2').status, 'dormant', '連續五次當選項沒被選→休眠');
  assert.equal(store.readCard('habit', 'h-1').picked_count, DORMANT_STREAK);
  assert.doesNotThrow(() => start('旅遊', 'wf-a', { picks: { pace: 'h-nope' }, changed: ['h-nope'] }));
});

test('onRunStart 範圍靠證據擴大：probes 中被選→流程→分類、scope_log 一筆、通知 widen（原流程名、分類名、「仍是選項，沒有升格」）；跨分類再被選→全部；已涵蓋的不再擴', () => {
  const { store, start } = facadeSetup();
  store.writeCard(habitAt({ id: 'h-b', text: '一天 5 個點', scope: { level: 'workflow', category: '旅遊', workflow: 'wf-b' } }));
  const r1 = start('旅遊', 'wf-a', { picks: { pace: 'h-b' } });
  const c1 = store.readCard('habit', 'h-b');
  assert.deepEqual(c1.scope, { level: 'category', category: '旅遊', workflow: null });
  assert.equal(c1.scope_log.length, 1);
  assert.equal(c1.scope_log[0].from.workflow, 'wf-b');
  assert.equal(c1.scope_log[0].to.level, 'category');
  assert.equal(c1.picked_count, 1);
  assert.equal(r1.memory.notices.length, 1);
  const n1 = r1.memory.notices[0];
  assert.equal(n1.kind, 'widen');
  assert.equal(n1.card, 'h-b');
  assert.equal(n1.undone, false);
  assert.equal(n1.text, '「一天 5 個點」的範圍從「大阪行程」擴大到旅遊分類：你在第二條 Workflow 也選了它。仍是選項，沒有升格');
  // 同分類再選：已經涵蓋，不再擴、不再通知
  const r2 = start('旅遊', 'wf-a', { picks: { pace: 'h-b' } });
  assert.equal(store.readCard('habit', 'h-b').scope.level, 'category');
  assert.deepEqual(r2.memory.notices, []);
  // 跨分類被選→全部
  const r3 = start('工作', 'wf-c', { picks: { pace: 'h-b' } });
  const c3 = store.readCard('habit', 'h-b');
  assert.deepEqual(c3.scope, { level: 'all', category: null, workflow: null });
  assert.equal(c3.scope_log.length, 2);
  assert.equal(r3.memory.notices.length, 1);
  assert.equal(r3.memory.notices[0].kind, 'widen');
  assert.equal(r3.memory.notices[0].text, '「一天 5 個點」的範圍從旅遊分類擴大到全部 Workflow：你在別的分類也選了它。仍是選項，沒有升格');
  // 全部尺度的再選：沒得擴
  const r4 = start('工作', 'wf-c', { picks: { pace: 'h-b' } });
  assert.deepEqual(r4.memory.notices, []);
  assert.equal(store.readCard('habit', 'h-b').scope_log.length, 2);
});

test('onRunStart 同一張卡同時在 picks 與 changed：選了優先——picked_count＋1、連續未選歸零、changed_count 不加', () => {
  const { store, start } = facadeSetup();
  store.writeCard({ ...habitAt({ id: 'h-1', text: '一天 3 個點' }), unpicked_streak: 2 }); // makeCard 一律歸零，事後塞
  start('旅遊', 'wf-a', { picks: { pace: 'h-1' }, changed: ['h-1'] });
  const h1 = store.readCard('habit', 'h-1');
  assert.equal(h1.picked_count, 1);
  assert.equal(h1.shown_count, 1);
  assert.equal(h1.changed_count, 0, '選了優先：不算改掉');
  assert.equal(h1.unpicked_streak, 0);
  assert.equal(typeof h1.last_used_at, 'string');
});

test('onRunStart 點了又改掉不算「沒被選」：changed 內的卡 shown_count＋1、changed_count＋1、unpicked_streak 維持原值；連續五次改掉也不休眠', () => {
  const { store, start } = facadeSetup();
  store.writeCard({ ...habitAt({ id: 'h-3', text: '一天 8 個點' }), unpicked_streak: 3 });
  start('旅遊', 'wf-a', { changed: ['h-3'] });
  const h3 = store.readCard('habit', 'h-3');
  assert.equal(h3.shown_count, 1, '它確實出現過');
  assert.equal(h3.changed_count, 1);
  assert.equal(h3.picked_count, 0);
  assert.equal(h3.unpicked_streak, 3, '有互動：連續未選不加也不歸零');
  assert.equal(h3.last_used_at, null);
  for (let i = 0; i < DORMANT_STREAK - 1; i += 1) start('旅遊', 'wf-a', { changed: ['h-3'] });
  const after = store.readCard('habit', 'h-3');
  assert.equal(after.changed_count, DORMANT_STREAK);
  assert.equal(after.shown_count, DORMANT_STREAK);
  assert.equal(after.unpicked_streak, 3, '五次改掉：連續未選仍不動');
  assert.equal(after.status, 'active', '改掉的卡走 exceptions.changed 提醒，不進休眠');
});

test('onRunStart 一開始就跨分類的 workflow 尺度卡被選：一步直達 all（不先到人家分類）、scope_log 一筆、通知一則「擴大到全部流程」', () => {
  const { store, start } = facadeSetup();
  store.writeCard(habitAt({ id: 'h-c', text: '一天 5 個點', scope: { level: 'workflow', category: '工作', workflow: 'wf-c' } }));
  const r = start('旅遊', 'wf-a', { picks: { pace: 'h-c' } });
  const c = store.readCard('habit', 'h-c');
  assert.deepEqual(c.scope, { level: 'all', category: null, workflow: null });
  assert.equal(c.scope_log.length, 1);
  assert.deepEqual(c.scope_log[0].from, { level: 'workflow', category: '工作', workflow: 'wf-c' });
  assert.equal(c.scope_log[0].to.level, 'all');
  assert.equal(c.picked_count, 1);
  assert.equal(r.memory.notices.length, 1);
  assert.equal(r.memory.notices[0].kind, 'widen');
  assert.equal(r.memory.notices[0].card, 'h-c');
  assert.equal(r.memory.notices[0].text, '「一天 5 個點」的範圍從「出差」擴大到全部 Workflow：你在別的分類也選了它。仍是選項，沒有升格');
});

test('onRunStart 認識卡：帶進工作單的寫 last_used_at；整層暫停或身分沒列的不寫；被外圈蓋掉的不寫', () => {
  const { store, memory, start } = facadeSetup();
  const profile = (over) => makeCard({ bucket: 'profile', text: 'x', layer: 'expression', scope: { level: 'all' }, source: { kind: 'manual', quote: 'x' }, ...over });
  store.writeCard(profile({ id: 'p-1', text: '不要客套' }));
  store.writeCard(profile({ id: 'p-2', text: '我常去日本', layer: 'content', scope: { level: 'category', category: '旅遊' } }));
  store.writeCard(profile({ id: 'p-3', text: '公司在台北', layer: 'content', scope: { level: 'category', category: '工作' } }));
  store.writeCard(profile({ id: 'p-4', text: '輕鬆', field: '語氣' }));
  store.writeGroup('旅遊', { text: '語氣：正式', rules: parseGroupText('語氣：正式', store.readDict()) });
  start('旅遊', 'wf-a', {});
  assert.equal(typeof store.readCard('profile', 'p-1').last_used_at, 'string', '表達層每步帶');
  assert.equal(typeof store.readCard('profile', 'p-2').last_used_at, 'string', '內容層場合對上');
  assert.equal(store.readCard('profile', 'p-3').last_used_at, null, '別分類的沒帶');
  assert.equal(store.readCard('profile', 'p-4').last_used_at, null, '被群組條蓋掉的沒進工作單');
  store.writeIdentities([{ id: 'i-1', name: '工作的我', cards: ['p-2'], categories: [], created_at: 'x' }]);
  store.writeCard(profile({ id: 'p-5', text: '用詞白話' }));
  start('旅遊', 'wf-a', { identity: 'i-1' });
  assert.equal(store.readCard('profile', 'p-5').last_used_at, null, '身分沒列的不帶、不寫');
  const settings = store.readSettings();
  settings.memory.paused = true;
  store.writeSettings(settings);
  start('旅遊', 'wf-a', {});
  assert.equal(store.readCard('profile', 'p-5').last_used_at, null, '整層暫停：關於你不帶');
  assert.ok(memory.forWorkflow('旅遊', 'wf-a').paused);
});

test('落地：路由發明出來的新欄位不做成習慣卡（沒有 chip 的位置），降成認識卡內容層；詞典照樣長那一格', async () => {
  // 2026-09-19 劇本實走抓到：跑完回報「民宿太遠」長出習慣卡、欄位「住宿位置」，
  // 但沒有任何流程有這個欄位＝開跑表單上沒有它的 chip，通知卻已經說「下次開跑當選項」。
  const { store, memory } = facadeSetup();
  const say = (json) => createMemory({ store, adapter: { async complete() { return json; } } });
  const m = say('{"cards":[{"bucket":"habit","field":"住宿位置","kind":"appearance","text":"住宿選靠市區的","reason":"換個場合會填別的"}]}');
  const def = store.readWorkflow('旅遊', 'wf-a');
  const run = {
    run_id: 'r-land-1', workflow: { category: '旅遊', id: 'wf-a', name: def.name }, def, status: 'done', params: {},
    started_at: new Date().toISOString(), finished_at: null,
    memory: { identity: null, picks: {}, changed: [], prev_run: null, notices: [] },
    steps: { a: { status: 'done', output: 'x' } },
  };
  store.writeRun('旅遊', 'wf-a', run.run_id, run);
  const notice = await m.onFeedback({ category: '旅遊', id: 'wf-a', runId: run.run_id, text: '民宿太遠了，下次找靠市區的' });

  const landed = store.listCards().filter((c) => c.source?.kind !== 'intro');
  assert.equal(landed.length, 1);
  assert.equal(landed[0].bucket, 'profile', '沒有欄位家的卡不做成習慣卡');
  assert.equal(landed[0].layer, 'content', '它講的是他的偏好，按場合帶');
  assert.equal(landed[0].field, '住宿位置', '對到哪一格還是留著，記憶頁看得到');
  assert.ok(notice.text.includes('認識卡'), `通知要講認識卡，不能說「下次開跑當選項」：${notice.text}`);
  assert.ok(!notice.text.includes('下次開跑當選項'));
  assert.ok((store.readDict().fields ?? []).some((f) => f.name === '住宿位置'), '詞典照樣長那一格，拆解器以後拆得出這個欄位');

  // 對照組：欄位詞典裡已經有的格（長度＝出廠詞典就有）照舊做成習慣卡
  const m2 = say('{"cards":[{"bucket":"habit","field":"長度","text":"寫 200 字以內","reason":"換個場合會填別的"}]}');
  const run2 = { ...run, run_id: 'r-land-2', memory: { ...run.memory, notices: [] } };
  store.writeRun('旅遊', 'wf-a', run2.run_id, run2);
  const n2 = await m2.onFeedback({ category: '旅遊', id: 'wf-a', runId: run2.run_id, text: '下次寫短一點，200 字以內' });
  const habit = store.listCards('habit').find((c) => c.text === '寫 200 字以內');
  assert.ok(habit, '詞典有這一格：照舊是習慣卡');
  assert.ok(n2.text.includes('下次開跑當選項'));
});

test('forWorkflow.options：跟 habitOptions 同一份（本流程 covers、同分類別條 probes 帶流程名）', () => {
  const { store, memory } = facadeSetup();
  store.writeCard(habitAt({ id: 'h-own', text: '一天 3 個點' }));
  store.writeCard(habitAt({ id: 'h-other', text: '一天 5 個點', scope: { level: 'workflow', category: '旅遊', workflow: 'wf-b' } }));
  const fw = memory.forWorkflow('旅遊', 'wf-a');
  assert.deepEqual(fw.options.pace.covers.map((c) => c.id), ['h-own']);
  assert.deepEqual(fw.options.pace.probes.map((c) => [c.id, c.from]), [['h-other', '大阪行程']]);
  assert.deepEqual(Object.keys(fw.options), ['pace']);
});
