import test from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { compose, ComposeError } from '../src/composer.js';

const VALID_DEF = {
  format: 1,
  name: '訂團隊聚餐餐廳',
  params: [{ key: 'people_count', label: '人數', default: '8 人' }],
  nodes: [
    { id: 'find', title: '找候選餐廳', executor: 'ai', stop_point: 'always', instruction: '列 3 家，人數 {{people_count}}', next: ['book'] },
    { id: 'book', title: '打電話訂位', executor: 'human', stop_point: 'always', instruction: '照選定的打去訂', next: [] },
  ],
};

function fakeAdapter(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async complete({ prompt }) {
      calls.push(prompt);
      return responses[Math.min(i++, responses.length - 1)];
    },
  };
}

const ok = (reply, def) => `${reply}\n\`\`\`yaml\n${yaml.dump(def)}\`\`\``;

test('首拆：回覆＋合法草稿；prompt 帶到使用者的話', async () => {
  const adapter = fakeAdapter([ok('拆好了，五步在右邊', VALID_DEF)]);
  const out = await compose({ adapter, messages: [{ role: 'user', text: '我要訂團隊聚餐的餐廳' }] });
  assert.ok(out.reply.includes('拆好了'));
  assert.equal(out.draft.name, '訂團隊聚餐餐廳');
  assert.ok(adapter.calls[0].includes('我要訂團隊聚餐的餐廳'));
});

test('續聊：帶現有草稿，prompt 含草稿內容', async () => {
  const adapter = fakeAdapter([ok('加好了', VALID_DEF)]);
  await compose({
    adapter,
    messages: [{ role: 'user', text: '人數欄預設改 10 人' }],
    currentDraft: VALID_DEF,
  });
  assert.ok(adapter.calls[0].includes('訂團隊聚餐餐廳'), 'prompt 要帶現有草稿');
  assert.ok(adapter.calls[0].includes('現有草稿'));
});

test('AI 回壞草稿：自動帶問題重試一次後成功', async () => {
  const adapter = fakeAdapter(['亂講一通沒有 yaml', ok('修好了', VALID_DEF)]);
  const out = await compose({ adapter, messages: [{ role: 'user', text: '拆' }] });
  assert.equal(adapter.calls.length, 2);
  assert.ok(adapter.calls[1].includes('有問題'), '重試 prompt 要講哪裡壞');
  assert.equal(out.draft.name, '訂團隊聚餐餐廳');
});

test('拆出含分岔＋平行的草稿也能過（S3）', async () => {
  const { DAG_DEF } = await import('./fixtures.js');
  const adapter = fakeAdapter([ok('拆好了，金額大的會多一步簽核', DAG_DEF)]);
  const out = await compose({ adapter, messages: [{ role: 'user', text: '幫我拆報帳流程' }] });
  assert.equal(out.draft.nodes.find((n) => n.kind === 'branch').branches.length, 2);
  assert.ok(adapter.calls[0].includes('分岔'), 'prompt 要教它分岔怎麼寫');
  assert.ok(adapter.calls[0].includes('指示及格線'), 'prompt 要帶指示品質三要件（吃什麼輸入/做什麼判斷/交什麼成品）');
  assert.ok(adapter.calls[0].includes('handoff') && adapter.calls[0].includes('一律做成 params'), 'prompt 要教它純資料一律做欄位、人做步驟寫明完成時交出什麼（資料通道輪）');
  assert.ok(adapter.calls[0].includes('required: true') && adapter.calls[0].includes('hint'), 'prompt 要教它純資料欄位標必填＋hint、default 留空（排程與健檢輪）');
  assert.ok(adapter.calls[0].includes('output_file 用 docx 或 xlsx') && adapter.calls[0].includes('template_file'), 'prompt 要教它 Word／Excel 是真檔、有範本就套（產檔輪）');
});

test('資料通道輪：草稿裡人做步驟帶 handoff 欄位能過驗證', async () => {
  const def = structuredClone(VALID_DEF);
  def.nodes[1].handoff = '訂位結果與時間';
  const adapter = fakeAdapter([ok('拆好了', def)]);
  const out = await compose({ adapter, messages: [{ role: 'user', text: '拆聚餐' }] });
  assert.equal(out.draft.nodes[1].handoff, '訂位結果與時間');
});

test('交貨查核輪：prompt 的 RULES 含第 10／11 條（具體要求進 review_focus／最後一步要拿得到原始資料）', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter, messages: [{ role: 'user', text: '拆聚餐' }] });
  assert.ok(adapter.calls[0].includes('review_focus（必守'), 'RULES 要教它具體要求寫進 review_focus（必守…）');
  assert.ok(adapter.calls[0].includes('最後交付成品的那一步必須直接拿得到原始資料'), 'RULES 要教它最後一步要接得到原始資料');
});

test('連兩次都壞：ComposeError 人話', async () => {
  const bad = ok('看起來像對的', { format: 1, name: '', params: [], nodes: [] });
  const adapter = fakeAdapter([bad, bad]);
  await assert.rejects(
    compose({ adapter, messages: [{ role: 'user', text: '拆' }] }),
    (e) => e instanceof ComposeError && e.message.includes('換個說法'),
  );
});

// ---- 記憶輪 M1c：拆解器多三段參考（你的分類／欄位詞典／分類守則）＋第 12 條 ----

test('M1c：context 三段——你的分類、欄位詞典、分類守則；放在對話紀錄之前；沒給 context 的舊呼叫不多段', async () => {
  const { FACTORY_DICT } = await import('../src/memory.js');
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({
    adapter,
    messages: [{ role: 'user', text: '拆旅遊' }],
    context: { categories: ['旅遊', '工作'], dict: FACTORY_DICT, groupRules: ['不提競品'], category: '旅遊' },
  });
  const p = adapter.calls[0];
  assert.ok(p.includes('# 你的分類\n- 旅遊\n- 工作'), p);
  assert.ok(p.includes('# 欄位詞典') && p.includes('- 語氣（產出的樣子；同義：口吻、風格）'), p);
  assert.ok(p.includes('# 分類守則\n- 不提競品'), p);
  assert.ok(p.includes('這條流程已經放在「旅遊」'), '已知分類要告訴它，免得第一句又問一次');
  assert.ok(p.indexOf('# 分類守則') < p.indexOf('# 對話紀錄'), '三段是參考資料，放在對話紀錄之前');
  const bare = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: bare, messages: [{ role: 'user', text: '拆' }] });
  for (const h of ['# 你的分類', '# 欄位詞典', '# 分類守則']) assert.ok(!bare.calls[0].includes(h), `沒給 context 不該有 ${h}`);
});

test('M1c：context 給了但空的，各段寫「（無）」；沒指定分類就不寫「已經放在」', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter, messages: [{ role: 'user', text: '拆' }], context: { categories: [], dict: null, groupRules: [] } });
  const p = adapter.calls[0];
  assert.ok(p.includes('# 你的分類\n（無）'), p);
  assert.ok(p.includes('# 欄位詞典\n（無）'), p);
  assert.ok(p.includes('# 分類守則\n（無）'), p);
  assert.ok(!p.includes('已經放在'));
});

test('M1c：RULES 第 12 條逐字；第 11 條原文不動、緊接在前', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter, messages: [{ role: 'user', text: '拆' }] });
  const p = adapter.calls[0];
  const rule12 = '12. 分類與欄位名（記憶輪）：第一次回覆時，若使用者沒說要放哪個分類，在口語回覆最後問一句「這條流程要放在哪個分類？（現有：…；也可以先不分類）」；他答了或一開始就說了，就在 yaml 頂層寫 category: <分類名>（只准選現有的，或寫「未分類」）。params 的 label 先看「欄位詞典」——同一件事就沿用詞典裡的正式名；沒有才取新名並給 kind（appearance/audience/time/range/limits/method 六選一，寫在該 param 的 kind 欄）。「分類守則」列出的規矩，拆步驟時當成已知條件，寫進對應步驟的 review_focus 或 constraints，不要另外問。';
  assert.ok(p.includes(rule12), '第 12 條要逐字照計畫');
  const rule11 = '11. 交貨查核：最後交付成品的那一步必須直接拿得到原始資料——引用原始資料欄位 {{key}}，或用並行點把原始資料步驟的產出接到它；中間步驟的摘要不算原始資料。';
  assert.ok(p.includes(`${rule11}\n${rule12}`), '第 11 條原文不動，第 12 條緊接其後');
});

test('M1c：AI 回的 yaml 頂層帶 category → 草稿保留它（存檔時前端才剝）', async () => {
  const adapter = fakeAdapter([ok('放旅遊了', { ...VALID_DEF, category: '旅遊' })]);
  const out = await compose({ adapter, messages: [{ role: 'user', text: '放旅遊' }] });
  assert.equal(out.draft.category, '旅遊');
  assert.equal(out.draft.name, '訂團隊聚餐餐廳');
});

// ---- 移植合併輪 U1b：拆解器帶公司／部門規範當已知條件（兩段，在分類守則之前） ----

test('U1b ⑦：context 帶 companyRules／deptRules → 多「# 公司規範」「# 部門規範」兩段（每檔 ## 檔名＋全文），順序 公司→部門→分類守則→對話紀錄；給了但空 →（無）；沒給 context 不多段', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({
    adapter,
    messages: [{ role: 'user', text: '拆' }],
    context: { categories: ['旅遊'], dict: null, groupRules: ['不提競品'], category: '旅遊', companyRules: [{ name: '手冊.md', text: '語氣要親切。' }], deptRules: [{ name: '部門.md', text: '報價含稅。' }] },
  });
  const p = adapter.calls[0];
  assert.ok(p.includes('# 公司規範（跟分類守則一樣當已知條件）\n## 手冊.md\n語氣要親切。'), p);
  assert.ok(p.includes('# 部門規範（同上）\n## 部門.md\n報價含稅。'), p);
  const at = (h) => p.indexOf(h);
  assert.ok(at('# 公司規範') < at('# 部門規範') && at('# 部門規範') < at('# 分類守則') && at('# 分類守則') < at('# 對話紀錄'));
  const empty = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: empty, messages: [{ role: 'user', text: '拆' }], context: { categories: [], dict: null, groupRules: [] } });
  assert.ok(empty.calls[0].includes('# 公司規範（跟分類守則一樣當已知條件）\n（無）') && empty.calls[0].includes('# 部門規範（同上）\n（無）'), empty.calls[0]);
  const bare = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: bare, messages: [{ role: 'user', text: '拆' }] });
  assert.ok(!bare.calls[0].includes('# 公司規範') && !bare.calls[0].includes('# 部門規範'));
});

test('U1b 覆核該修：拆解器 context 裡規範內文行首 # 降一級（###### 封頂），^# 開頭的行只剩系統段標題', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({
    adapter,
    messages: [{ role: 'user', text: '拆' }],
    context: { categories: [], dict: null, groupRules: [], companyRules: [{ name: '員工手冊.md', text: '# 員工手冊\n語氣要親切。\n## 請假\n前一天說。\n###### 六級' }] },
  });
  const p = adapter.calls[0];
  assert.ok(p.includes('## 員工手冊.md\n## 員工手冊\n語氣要親切。\n### 請假\n前一天說。\n###### 六級'), p);
  const h1 = p.split('\n').filter((l) => /^# /.test(l));
  assert.deepEqual(h1, ['# 你的分類', '# 欄位詞典', '# 公司規範（跟分類守則一樣當已知條件）', '# 部門規範（同上）', '# 分類守則', '# 對話紀錄']);
});
