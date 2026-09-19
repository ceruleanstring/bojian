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
  const metas = [];
  let i = 0;
  return {
    calls,
    metas,
    async complete({ prompt, meta }) {
      calls.push(prompt);
      metas.push(meta);
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
  assert.ok(adapter.calls[0].includes('output_file 用 docx、xlsx 或 pptx') && adapter.calls[0].includes('template_file'), 'prompt 要教它 Word／Excel／簡報是真檔、有範本就套（產檔輪＋成品格式輪）');
});

test('資料通道輪：草稿裡人做步驟帶 handoff 欄位能過驗證', async () => {
  const def = structuredClone(VALID_DEF);
  def.nodes[1].handoff = '訂位結果與時間';
  const adapter = fakeAdapter([ok('拆好了', def)]);
  const out = await compose({ adapter, messages: [{ role: 'user', text: '拆聚餐' }] });
  assert.equal(out.draft.nodes[1].handoff, '訂位結果與時間');
});

test('交貨查核輪→拆法輪 B3：prompt 的 RULES 含第 10 條（具體要求進 review_focus）；第 11 條（最後一步要拿得到原始資料）已刪、0 命中', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter, messages: [{ role: 'user', text: '拆聚餐' }] });
  assert.ok(adapter.calls[0].includes('review_focus（必守'), 'RULES 要教它具體要求寫進 review_focus（必守…）');
  assert.equal((adapter.calls[0].match(/最後交付成品的那一步必須直接拿得到原始資料/g) ?? []).length, 0, '第 11 條整行刪（執行時每一步都看得到全部產出，不必再接線）');
});

test('連兩次都壞：ComposeError 人話', async () => {
  const bad = ok('看起來像對的', { format: 1, name: '', params: [], nodes: [] });
  const adapter = fakeAdapter([bad, bad]);
  await assert.rejects(
    compose({ adapter, messages: [{ role: 'user', text: '拆' }] }),
    (e) => e instanceof ComposeError && e.message.includes('換個說法'),
  );
});

// ---- 拆解器多三段參考（你的分類／欄位詞典／分類守則）＋第 12 條 ----

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

test('M1c→B3：RULES 第 12 條新文逐字（契約 E）；第 11 條刪行留缺，第 10 條原文緊接在前、不重編', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter, messages: [{ role: 'user', text: '拆' }] });
  const p = adapter.calls[0];
  assert.ok(p.includes(RULE12), '第 12 條要逐字照契約 E');
  assert.ok(p.includes(`${RULE10}\n${RULE12}`), '第 10 條原文不動，第 12 條緊接其後（11 留缺）');
  assert.equal((p.match(/^11\./gm) ?? []).length, 0, '沒有任何一行以 11. 開頭');
  assert.equal((p.match(/這條流程要放在哪個分類/g) ?? []).length, 0, '第 12 條問句退場');
});

test('M1c：AI 回的 yaml 頂層帶 category → 草稿保留它（存檔時前端才剝）', async () => {
  const adapter = fakeAdapter([ok('放旅遊了', { ...VALID_DEF, category: '旅遊' })]);
  const out = await compose({ adapter, messages: [{ role: 'user', text: '放旅遊' }] });
  assert.equal(out.draft.category, '旅遊');
  assert.equal(out.draft.name, '訂團隊聚餐餐廳');
});

// ---- 拆解器帶公司／部門規範當已知條件（兩段，在分類守則之前） ----

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

test('U1b 覆核該修＋B2 ③：拆解器 context 裡規範內文行首 # 降一級（###### 封頂），^# 開頭的行只剩系統段標題，順序照契約 D（關於你→你的分類→欄位詞典→公司規範→部門規範→分類守則→你能派工人做什麼→對話紀錄）', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({
    adapter,
    messages: [{ role: 'user', text: '拆' }],
    context: {
      categories: [], dict: null, groupRules: [], coreNotes: ['偏好先結論'],
      capabilities: { web: true, files_default: true, office: ['docx', 'xlsx'], downgrade: ['pptx', 'pdf'], refs: true, connectors: [] },
      companyRules: [{ name: '員工手冊.md', text: '# 員工手冊\n語氣要親切。\n## 請假\n前一天說。\n###### 六級' }],
    },
  });
  const p = adapter.calls[0];
  assert.ok(p.includes('## 員工手冊.md\n## 員工手冊\n語氣要親切。\n### 請假\n前一天說。\n###### 六級'), p);
  const h1 = p.split('\n').filter((l) => /^# /.test(l));
  assert.deepEqual(h1, [
    '# 關於你（拆的時候把這些當已知；不用問）', '# 你的分類', '# 欄位詞典', '# 公司規範（跟分類守則一樣當已知條件）', '# 部門規範（同上）',
    '# 分類守則', '# 你能派工人做什麼（拆步驟時照這張表安排誰做）', '# 這一趟', '# 對話紀錄',
  ]);
});

// ---- 拆解器多帶「# 關於你」與「# 你能派工人做什麼」 ----

const CAP_ALL = { web: true, files_default: true, office: ['docx', 'xlsx', 'pptx'], downgrade: ['pdf'], refs: true, connectors: [] };

test('B2 ①：context.coreNotes → 「# 關於你（拆的時候把這些當已知；不用問）」逐條、在「# 你的分類」之前；空或沒給 → 0 命中，不寫「（無）」', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({
    adapter,
    messages: [{ role: 'user', text: '拆' }],
    context: { categories: ['旅遊'], dict: null, groupRules: [], coreNotes: ['偏好先結論', '讀者是股東'] },
  });
  const p = adapter.calls[0];
  assert.ok(p.includes('# 關於你（拆的時候把這些當已知；不用問）\n- 偏好先結論\n- 讀者是股東'), p);
  assert.ok(p.indexOf('# 關於你') < p.indexOf('# 你的分類'), '關於你在你的分類之前');
  const empty = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: empty, messages: [{ role: 'user', text: '拆' }], context: { categories: [], dict: null, groupRules: [], coreNotes: [] } });
  assert.equal((empty.calls[0].match(/# 關於你/g) ?? []).length, 0, '空清單整段不印');
  assert.ok(!empty.calls[0].includes('關於你（拆的時候把這些當已知；不用問）\n（無）'));
  const none = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: none, messages: [{ role: 'user', text: '拆' }], context: { categories: [], dict: null, groupRules: [] } });
  assert.equal((none.calls[0].match(/# 關於你/g) ?? []).length, 0, '沒給整段不印');
});

test('B2 覆核該修：關於你的卡文含換行與行首 #（`惡意卡\\n# 假標題`）→ 降一級成 ## 假標題、^# 假標題 0 命中、系統段標題數不變', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({
    adapter,
    messages: [{ role: 'user', text: '拆' }],
    context: { categories: [], dict: null, groupRules: [], coreNotes: ['惡意卡\n# 假標題\n## 二級\n###### 六級', '# 行首井字'] },
  });
  const p = adapter.calls[0];
  assert.ok(p.includes('- 惡意卡\n## 假標題\n### 二級\n###### 六級'), p);
  assert.ok(p.includes('- ## 行首井字'), p);
  assert.equal((p.match(/^# 假標題/gm) ?? []).length, 0, '假段標題不准打穿');
  const h1 = p.split('\n').filter((l) => /^# /.test(l));
  assert.deepEqual(h1, ['# 關於你（拆的時候把這些當已知；不用問）', '# 你的分類', '# 欄位詞典', '# 公司規範（跟分類守則一樣當已知條件）', '# 部門規範（同上）', '# 分類守則', '# 這一趟', '# 對話紀錄']);
});

test('B2 ②：context.capabilities → 「# 你能派工人做什麼」五行逐字（契約 D）、在分類守則之後、對話紀錄之前；web:false／files_default:false 換字；沒給不印', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter, messages: [{ role: 'user', text: '拆' }], context: { categories: [], dict: null, groupRules: [], capabilities: CAP_ALL } });
  const p = adapter.calls[0];
  const section = [
    '# 你能派工人做什麼（拆步驟時照這張表安排誰做）',
    '- 上網查與讀網頁：可以（設定→執行與排程→AI 工人）',
    '- 讀使用者上傳的參考檔：可以（流程參考檔與公司／部門參考檔，勾了才帶）',
    '- 在產出資料夾寫檔：新流程預設可以',
    '- 產真檔：Word（docx）、Excel（xlsx）、簡報（pptx）可以；pdf 目前會降級成 .md',
    '- 連接器（行事曆、信箱等）：目前沒有，別排「自動從 X 抓」的步驟',
  ].join('\n');
  assert.ok(p.includes(section), p);
  assert.ok(p.indexOf('# 分類守則') < p.indexOf('# 你能派工人做什麼') && p.indexOf('# 你能派工人做什麼') < p.indexOf('# 對話紀錄'), '段位：分類守則之後、對話紀錄之前');
  const off = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: off, messages: [{ role: 'user', text: '拆' }], context: { categories: [], dict: null, groupRules: [], capabilities: { ...CAP_ALL, web: false, files_default: false } } });
  assert.ok(off.calls[0].includes('- 上網查與讀網頁：不可以（設定關了；資料要做成欄位讓使用者貼）'), off.calls[0]);
  assert.ok(off.calls[0].includes('- 在產出資料夾寫檔：預設不可以（設定→新流程的預設）'), off.calls[0]);
  assert.ok(!off.calls[0].includes('：可以（設定→執行與排程'));
  const none = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: none, messages: [{ role: 'user', text: '拆' }], context: { categories: [], dict: null, groupRules: [] } });
  assert.equal((none.calls[0].match(/你能派工人做什麼/g) ?? []).length, 0, '沒給 capabilities 不印');
  const bare = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: bare, messages: [{ role: 'user', text: '拆' }] });
  assert.equal((bare.calls[0].match(/你能派工人做什麼|# 關於你/g) ?? []).length, 0, '舊呼叫端零變化');
});

// ---- （ composer 側：兩趟 phase＋第一趟 JSON 解析） ----
// 四個常數逐字照；第 10 條原文照 HEAD（不動），用來釘「10 之後緊接 12」。

const RULE3_TAIL = '   顆粒跟著成品走：成品分幾段（下方「已確認的成品格子」的「分段」）就決定蒐集端拆幾支——分段 3 段以上：一個並行點分成同樣數量的蒐集步（每支各做一段、各自寫明查哪一段的什麼），再接一步彙整（挑題、合併、去重）；不到 3 段：一步蒐集就好。不要為了看起來細而多拆。停點：彙整那一步與最後交付前那一步 stop_point 設 always，其餘 never，除非使用者明說要看。執行時每一步都看得到前面全部步驟的產出，不必為了「拿得到資料」多接線。';
const RULE8 = '8. 資料通道（2026-09-16 改）：資料分兩種。(a) AI 上網查得到的（新聞、公開資訊、網頁、公開報告、公開行情）：讓 AI 步驟自己查，instruction 寫明查哪裡（網站或來源類型）、範圍多久（例「近 7 天」）、要幾則、挑選標準；不要做成欄位叫使用者貼。(b) 只有使用者才拿得到的（來信、內部名單、上週紀錄、營收數字、客戶資料）：一律做成 params，並在用到它的每個 AI 步驟 instruction 裡寫 {{key}} 引用——不要拆成「請使用者貼上」的 human 步驟；human 步驟只留 AI 代替不了的實體動作（開會、寄出、簽名、錄製）。human 步驟後面接 AI 步驟時，必填 handoff（字串：完成時要交出什麼，例「會議結論三條」），且下游 AI 的 instruction 明寫吃的是它交出的內容。純資料欄位一律 {key, label, default: \'\'（留空）, required: true, hint: 使用者該貼什麼（例「上個月每篇貼文的日期／讚數／留言數」）}——不要把提示文字塞進 default；其他可調欄位（份量、語氣、數量）照舊給實際預設值。';
const RULE10 = '10. 交貨查核：使用者在對話裡講到的具體要求（數字、時限、格式、口味、禁忌、對象）一律寫進對應步驟的 review_focus（必守，交貨查核逐條對）或 constraints，不准只留在對話裡。';
const RULE12 = '12. 分類與欄位名：分類由使用者在成品卡的下拉決定並隨第二趟送來（見「# 已確認的成品格子」），yaml 頂層寫 category: <那個分類>（只准現有的，或「未分類」）；不要在口語回覆裡問分類。params 的 label 先看「欄位詞典」——同一件事就沿用詞典裡的正式名；沒有才取新名並給 kind（appearance/audience/time/range/limits/method 六選一，寫在該 param 的 kind 欄）。「分類守則」列出的規矩，拆步驟時當成已知條件，寫進對應步驟的 review_focus 或 constraints，不要另外問。';
const RULE13 = `13. 兩趟輸出：下方「# 這一趟」會標明是第一趟還是第二趟。第一趟（定成品）：不要輸出 yaml。輸出一句口語回覆（講你猜的成品長什麼樣、哪裡不確定），接一個 \`\`\`json 圍欄：{"shape":{"deliverable":{"value","basis"},"type":…,"audience":…,"style":…,"length":…,"sections":…,"range":…},"sources":[{"name","from","note"}],"category":"…"}。七格＝成品（一句話講交出什麼）／型態（文章、表格、簡報稿、Excel、Word、講稿…）／對象（給誰看或聽）／段子或風格（語氣、口吻）／長度（字數、頁數、分鐘）／分段（成品分哪幾段，用「、」隔開）／範圍（時間範圍或涵蓋範圍）；每格答案要先填好——依序從「關於你」「你說的（對話紀錄）」「分類守則」「公司規範」推，推不出來給合理預設；basis 只能寫 自我介紹、你說的、分類守則、公司規範、預設 五選一，用不到的格 value 空字串、basis 寫 預設；不要反問。sources 的 from 只能是 web（AI 上網查）、paste（使用者貼，AI 拿不到的）、upload（使用者上傳檔案）、shared（公司或部門參考檔，note 寫檔名）、upstream（前一步產出）、later（要連接器才拿得到，目前沒有）。category 只准選現有分類，沒有合適的寫「未分類」。第二趟（落地）：下方會附「# 已確認的成品格子」與「# 資料來源」，照著做——每格變一個 param（label 對詞典正式名：對象→讀者、長度→長度、段子或風格→語氣、型態→型態、分段→分段、範圍→範圍；成品那格不做欄位，當流程 name 與交付步 instruction 的主詞），default＝確認過的值，用不到的格不做欄位；最後交付那一步的 output_type／output_structure／output_length／output_tone 分別填型態／分段／長度／段子或風格的值，instruction 用 {{key}} 引用；來源清單逐條落地：web→負責蒐集的 AI 步驟 instruction 寫明查哪裡與範圍（第 8 條 a）；paste→params required: true＋hint（第 8 條 b）；upload→該步 attachments 寫那個檔名，或做成 human 步驟交出（handoff 寫明交什麼）；shared→attachments 寫 {scope: company 或 category, name: 檔名}；upstream→接線；later→先做成 paste 欄位、hint 註明「連接器接上後可自動取得」。`;

const SHAPE = {
  deliverable: { value: '週報', basis: '你說的' },
  type: { value: '文章', basis: '預設' },
  audience: { value: '股東', basis: '自我介紹' },
  style: { value: '正式', basis: '公司規範' },
  length: { value: '800 字', basis: '預設' },
  sections: { value: '國內、國際、產業', basis: '分類守則' },
  range: { value: '近 7 天', basis: '你說的' },
};
const SOURCES = [{ name: '本週新聞', from: 'web', note: '近 7 天' }, { name: '上週紀錄', from: 'paste', note: '' }];
const shapeReply = (obj, reply = '先猜是週報') => `${reply}\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const MSGS = [{ role: 'user', text: '我每周要整理新聞大事來做 VTuber 節目播報' }];

test('B3 ①：RULES 第 3 條尾段／第 8／12／13 條逐字（契約 E）；「交接鐵則」0 命中；「11. 交貨查核」0 命中；10. 之後緊接 12. 再接 13.', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter, messages: MSGS });
  const p = adapter.calls[0];
  assert.ok(p.includes(`不要硬加分岔或並行。\n${RULE3_TAIL}\n4. `), '第 3 條：join 句原文之後緊接顆粒段，再接第 4 條');
  assert.ok(p.includes(`${RULE8}\n9. `), '第 8 條整條換新，緊接第 9 條');
  assert.ok(p.includes(`${RULE10}\n${RULE12}\n${RULE13}`), '10 之後緊接 12（11 留缺），再接新 13');
  assert.equal((p.match(/交接鐵則/g) ?? []).length, 0, '交接鐵則整段刪');
  assert.equal((p.match(/11\. 交貨查核/g) ?? []).length, 0, '第 11 條整行刪');
  assert.equal((p.match(/^1[0-3]\. /gm) ?? []).length, 3, '只剩 10／12／13 三條兩位數規矩');
});

test('B3 ②：第 8 條新文仍含「一律做成 params」「required: true」「hint」「handoff」四個字面；第 10 條「review_focus（必守」仍在；第 1／2／4–7／9 條原句抽樣不動', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter, messages: MSGS });
  const p = adapter.calls[0];
  for (const s of ['一律做成 params', 'required: true', 'hint', 'handoff', 'review_focus（必守']) assert.ok(p.includes(s), `要有「${s}」`);
  assert.ok(p.includes('(a) AI 上網查得到的') && p.includes('(b) 只有使用者才拿得到的'), '第 8 條分 (a)(b) 兩種');
  for (const s of [
    '1. 先寫一段給使用者的口語回覆', '2. 接著輸出一個 ```yaml 圍欄', '4. 使用者口述自己的做法時', '5. 關鍵產出步驟 stop_point 設 always',
    '6. 若下方附有現有草稿', '7. 指示及格線（每一步都要過）', '9. 產檔：',
  ]) assert.ok(p.includes(s), `第 ${s.slice(0, 1)} 條原句要在`);
});

test('B3 ③：phase shape——reply＝圍欄前的字、shape／sources／category 回齊、沒有 draft；缺 range 補 {value:\'\',basis:\'預設\'}、basis 亂→預設、from 亂→paste、category 非字串→null、sources 非陣列→[]；壞 JSON→重試 prompt 含「不是合法 JSON」；prompt 含「# 這一趟\\n第一趟：定成品。」且不含「# 已確認的成品格子」', async () => {
  const adapter = fakeAdapter([shapeReply({ shape: SHAPE, sources: SOURCES, category: '旅遊' })]);
  const out = await compose({ adapter, messages: MSGS, phase: 'shape' });
  assert.equal(out.reply, '先猜是週報');
  assert.deepEqual(out.shape, SHAPE);
  assert.deepEqual(out.sources, SOURCES);
  assert.equal(out.category, '旅遊');
  assert.equal(out.draft, undefined);
  const p = adapter.calls[0];
  assert.ok(p.includes('# 這一趟\n第一趟：定成品。只回格子與來源，不出 yaml。'), p);
  // 規矩 12／13 原文引到「# 已確認的成品格子」「# 資料來源」字樣，所以段標題只認行首
  assert.equal((p.match(/^# (已確認的成品格子|資料來源)$/gm) ?? []).length, 0, '第一趟沒有第二趟的兩段');
  assert.ok(p.indexOf('# 這一趟') < p.indexOf('# 對話紀錄'), '這一趟在對話紀錄之前');
  assert.ok(p.includes('VTuber 節目播報'), '對話紀錄照帶');
  // 補齊
  const { range, ...six } = SHAPE;
  const fix = fakeAdapter([shapeReply({ shape: { ...six, type: { value: '表格', basis: '亂' } }, sources: [{ name: 'x', from: '亂', note: 'n' }], category: 7 })]);
  const o2 = await compose({ adapter: fix, messages: MSGS, phase: 'shape' });
  assert.deepEqual(o2.shape.range, { value: '', basis: '預設' });
  assert.deepEqual(o2.shape.type, { value: '表格', basis: '預設' });
  assert.deepEqual(o2.sources, [{ name: 'x', from: 'paste', note: 'n' }]);
  assert.equal(o2.category, null);
  assert.deepEqual(Object.keys(o2.shape), ['deliverable', 'type', 'audience', 'style', 'length', 'sections', 'range'], '七格固定鍵、固定順序');
  const noSrc = fakeAdapter([shapeReply({ shape: SHAPE, sources: 'x' })]);
  const o3 = await compose({ adapter: noSrc, messages: MSGS, phase: 'shape' });
  assert.deepEqual(o3.sources, []);
  assert.equal(o3.category, null);
  // 圍欄內壞 JSON→帶問題重試一次
  const bad = fakeAdapter(['猜\n```json\n{"shape": nope}\n```', shapeReply({ shape: SHAPE, sources: [], category: null })]);
  const o4 = await compose({ adapter: bad, messages: MSGS, phase: 'shape' });
  assert.equal(bad.calls.length, 2);
  assert.ok(bad.calls[1].includes('不是合法 JSON'), bad.calls[1]);
  assert.equal(o4.reply, '先猜是週報');
});

test('B3 ④：phase shape 假宿主回 yaml 沒 json→重試 prompt 含「有問題」；兩次都壞→ComposeError 同一句；shape 不是物件也算壞', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF), shapeReply({ shape: SHAPE, sources: [], category: null })]);
  const out = await compose({ adapter, messages: MSGS, phase: 'shape' });
  assert.equal(adapter.calls.length, 2);
  assert.ok(adapter.calls[1].includes('有問題') && adapter.calls[1].includes('沒有 json 圍欄'), adapter.calls[1]);
  assert.equal(out.shape.deliverable.value, '週報');
  const twice = fakeAdapter([ok('拆好了', VALID_DEF), '還是 yaml\n```yaml\nname: x\n```']);
  await assert.rejects(
    compose({ adapter: twice, messages: MSGS, phase: 'shape' }),
    (e) => e instanceof ComposeError && e.message.includes('換個說法'),
  );
  assert.equal(twice.calls.length, 2);
  const notObj = fakeAdapter([shapeReply({ shape: '週報' }), shapeReply({ shape: [] })]);
  await assert.rejects(compose({ adapter: notObj, messages: MSGS, phase: 'shape' }), ComposeError);
});

test('B3 ⑤：phase draft 帶 shape／sources／category→prompt 含「# 這一趟\\n第二趟」「# 已確認的成品格子」七行「# 資料來源」逐條與「- 分類：旅遊」，在「# 對話紀錄」之前；沒帶 shape 的 draft（對話修改）→兩段不印', async () => {
  const adapter = fakeAdapter([ok('拆好了', VALID_DEF)]);
  const out = await compose({ adapter, messages: MSGS, phase: 'draft', shape: SHAPE, sources: SOURCES, category: '旅遊' });
  assert.equal(out.draft.name, '訂團隊聚餐餐廳');
  const p = adapter.calls[0];
  const block = [
    '# 這一趟', '第二趟：落地成完整流程草稿。', '',
    '# 已確認的成品格子',
    '- 成品：週報（你說的）', '- 型態：文章（預設）', '- 對象：股東（自我介紹）', '- 段子或風格：正式（公司規範）',
    '- 長度：800 字（預設）', '- 分段：國內、國際、產業（分類守則）', '- 範圍：近 7 天（你說的）', '',
    '# 資料來源', '- 本週新聞：AI 上網查（近 7 天）', '- 上週紀錄：使用者貼', '- 分類：旅遊',
  ].join('\n');
  assert.ok(p.includes(block), p);
  // 規矩 13 原文引到這些段標題字樣，位置只認行首的段標題行
  const line = (h) => p.search(new RegExp(`^${h}$`, 'm'));
  assert.ok(line('# 這一趟') < line('# 已確認的成品格子') && line('# 已確認的成品格子') < line('# 資料來源') && line('# 資料來源') < line('# 對話紀錄'), '段位：這一趟→格子→來源→對話紀錄');
  assert.equal((p.match(/^第一趟：定成品/gm) ?? []).length, 0);
  // 對話修改：有草稿、沒 shape → 兩段不印，但這一趟仍標第二趟
  const mod = fakeAdapter([ok('改好了', VALID_DEF)]);
  await compose({ adapter: mod, messages: [{ role: 'user', text: '人數改 10' }], currentDraft: VALID_DEF, phase: 'draft' });
  assert.ok(mod.calls[0].includes('# 這一趟\n第二趟：落地成完整流程草稿。'));
  assert.equal((mod.calls[0].match(/^(# 已確認的成品格子|# 資料來源|- 分類：.*)$/gm) ?? []).length, 0);
  assert.ok(mod.calls[0].includes('# 現有草稿'));
});

test('B3 ⑥：舊呼叫端 compose({adapter, messages}) 無 phase→行為＝現況（回 reply＋draft、沒 shape），prompt 標第二趟', async () => {
  const adapter = fakeAdapter([ok('拆好了，五步在右邊', VALID_DEF)]);
  const out = await compose({ adapter, messages: MSGS });
  assert.equal(out.reply, '拆好了，五步在右邊');
  assert.equal(out.draft.name, '訂團隊聚餐餐廳');
  assert.equal(out.shape, undefined);
  assert.ok(adapter.calls[0].includes('# 這一趟\n第二趟：落地成完整流程草稿。'));
  assert.equal((adapter.calls[0].match(/^# 已確認的成品格子$/gm) ?? []).length, 0);
});

test('B3 覆核該修：舊呼叫端真首拆（draft、沒 shape、沒 currentDraft）→「# 這一趟」段下印「（本趟沒有成品格子，照對話紀錄直接拆；分類照第 12 條可先寫「未分類」）」；帶 shape／帶 currentDraft／第一趟都不印', async () => {
  const NOTE = '（本趟沒有成品格子，照對話紀錄直接拆；分類照第 12 條可先寫「未分類」）';
  const bare = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: bare, messages: MSGS });
  assert.ok(bare.calls[0].includes(`# 這一趟\n第二趟：落地成完整流程草稿。\n${NOTE}\n`), bare.calls[0]);
  assert.equal((bare.calls[0].match(/本趟沒有成品格子/g) ?? []).length, 1);
  const withShape = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: withShape, messages: MSGS, phase: 'draft', shape: SHAPE, sources: SOURCES, category: '旅遊' });
  assert.equal((withShape.calls[0].match(/本趟沒有成品格子/g) ?? []).length, 0, '帶 shape 不印');
  const withDraft = fakeAdapter([ok('改好了', VALID_DEF)]);
  await compose({ adapter: withDraft, messages: MSGS, currentDraft: VALID_DEF });
  assert.equal((withDraft.calls[0].match(/本趟沒有成品格子/g) ?? []).length, 0, '對話修改（帶 currentDraft）不印');
  const first = fakeAdapter([shapeReply({ shape: SHAPE, sources: [], category: null })]);
  await compose({ adapter: first, messages: MSGS, phase: 'shape' });
  assert.equal((first.calls[0].match(/本趟沒有成品格子/g) ?? []).length, 0, '第一趟不印');
});

test('B3 ⑦：adapter.complete 的 meta＝{kind:\'compose\', phase}——shape／draft／無 phase（＝draft）三種', async () => {
  const s = fakeAdapter([shapeReply({ shape: SHAPE, sources: [], category: null })]);
  await compose({ adapter: s, messages: MSGS, phase: 'shape' });
  assert.deepEqual(s.metas[0], { kind: 'compose', phase: 'shape' });
  const d = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: d, messages: MSGS, phase: 'draft', shape: SHAPE, sources: SOURCES, category: '旅遊' });
  assert.deepEqual(d.metas[0], { kind: 'compose', phase: 'draft' });
  const old = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: old, messages: MSGS });
  assert.deepEqual(old.metas[0], { kind: 'compose', phase: 'draft' });
});
const count = (s, n) => s.split(n).length - 1;

test('成品格式輪：第二趟多一段「使用者已經選好的交付方式」——檔案種類與舊作品；沒選就不印', async () => {
  const a1 = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: a1, messages: MSGS, phase: 'draft', shape: SHAPE, sources: SOURCES, category: '旅遊', outputFile: 'pptx', sampleName: '上季月報.pptx' });
  const p = a1.calls[0];
  assert.ok(p.includes('# 使用者已經選好的交付方式（不要改、不要問）'), p);
  assert.ok(p.includes('output_file 就寫 pptx'), '講明最後一步寫哪個值');
  assert.ok(p.includes('長度用張數'), '簡報要用張數不用頁數');
  assert.ok(p.includes('「上季月報.pptx」') && p.includes('attachments'), '舊作品要進 attachments');
  assert.ok(p.includes('不要抄它的數字'), '照樣子做、不照抄——不然會把舊數字寫進新報告');
  assert.ok(p.indexOf('# 已確認的成品格子') < p.indexOf('# 使用者已經選好的交付方式'), '接在格子與來源之後');

  const a2 = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: a2, messages: MSGS, phase: 'draft', shape: SHAPE, sources: SOURCES, category: '旅遊' });
  assert.equal(count(a2.calls[0], '使用者已經選好的交付方式'), 0, '沒選＝不印（連跑那條路沒有卡）');

  const a3 = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: a3, messages: MSGS, phase: 'draft', shape: SHAPE, sources: SOURCES, category: '旅遊', outputFile: 'md' });
  assert.ok(a3.calls[0].includes('output_file 就寫 md') && !a3.calls[0].includes('長度用張數'), '文字檔不講張數');

  const a4 = fakeAdapter([ok('拆好了', VALID_DEF)]);
  await compose({ adapter: a4, messages: MSGS, phase: 'draft', shape: SHAPE, sources: SOURCES, category: '旅遊', outputFile: '../evil' });
  assert.equal(count(a4.calls[0], '使用者已經選好的交付方式'), 0, '不認識的檔案種類一概不印');
});
