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
