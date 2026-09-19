import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHostAdapter, HostError, LEAN_WORKER_SYSTEM, LEAN_GENERIC_SYSTEM, CALENDAR_TOOLS } from '../src/host-adapter.js';

// 假子行程：可控 stdout／stderr／結束碼／不結束
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // 真 stream 有這兩支，假的也要有：stdout／stderr 要能定編碼（不然跨塊中文會被切壞），
  // stdin 要能掛 'error'（EPIPE 沒人接會炸掉整個行程）
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = { written: '', write(s) { this.written += s; }, end() {}, on() {} };
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

const NODE_ARGS = { nodeId: 'x', title: '整理歸納', instruction: '整理成表', upstream: '原始資料' };

test('成功：prompt 含步驟要求與上游產出、經 stdin 餵入；回傳 stdout 文字', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.executeNode(NODE_ARGS);
  child.stdout.emit('data', '整理好的表格');
  child.emit('close', 0);
  assert.equal(await p, '整理好的表格');
  assert.ok(child.stdin.written.includes('整理歸納'));
  assert.ok(child.stdin.written.includes('整理成表'));
  assert.ok(child.stdin.written.includes('原始資料'));
  assert.ok(child.stdin.written.includes('不要反問'), '停點不是對話：prompt 要禁止反問使用者');
  assert.ok(child.stdin.written.includes('不提工具、連線、指令或系統名稱'), '缺什麼要說人話（排程與健檢輪）');
  assert.ok(child.stdin.written.includes('相同的語言'), '全篇語言跟指示一致（排程與健檢輪）');
});

test('產檔輪：fileMode → 加放行 Write/Edit/Bash(node *)、cwd＝產出夾、NODE_PATH 指自帶套件、prompt 帶產檔規則與檔名；沒 fileMode 一概不放', async () => {
  let child;
  let spawnArgs;
  let spawnExtra;
  const adapter = createHostAdapter({ spawnFn: (a, extra) => { spawnArgs = a; spawnExtra = extra; return (child = fakeChild()); } });
  const p = adapter.executeNode({ ...NODE_ARGS, fileMode: { cwd: 'C:/tmp/run-out', fileName: '報告.docx', templatePath: 'C:/tmp/files/範本.docx' } });
  child.stdout.emit('data', 'ok');
  child.emit('close', 0);
  await p;
  assert.ok(spawnArgs.includes('Write') && spawnArgs.includes('Edit') && spawnArgs.includes('Bash(node *)'));
  assert.equal(spawnExtra.cwd, 'C:/tmp/run-out');
  assert.ok(spawnExtra.env.NODE_PATH.endsWith('node_modules'));
  assert.ok(child.stdin.written.includes('# 產檔規則') && child.stdin.written.includes('報告.docx') && child.stdin.written.includes('範本.docx'));
  assert.ok(child.stdin.written.includes('不准安裝任何套件'));
  const plain = adapter.renderPrompt(NODE_ARGS);
  assert.ok(!plain.includes('# 產檔規則'), '一般步驟沒有產檔規則段');
});

test('成品格式輪：檔名是 .pptx → 產檔規則段改教 pptxgenjs，並擋掉簡報的兩個翻車點', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.executeNode({ ...NODE_ARGS, fileMode: { cwd: 'C:/tmp/run-out', fileName: '月報.pptx' } });
  child.stdout.emit('data', 'ok');
  child.emit('close', 0);
  await p;
  const w = child.stdin.written;
  assert.ok(w.includes('pptxgenjs') && w.includes('月報.pptx'), w);
  assert.ok(!w.includes('exceljs') && !w.includes('docxtemplater'), '別把其他格式的套件也塞給它');
  assert.ok(w.includes('一張投影片只放一個重點'), '擋「整段文章塞一張」');
  assert.ok(w.includes('中文不必嵌字型'), '擋「為了字型去連網或讀系統檔」');
});

test('步驟呼叫放行讀類工具（WebSearch/WebFetch/Read），不放行寫檔與執行；complete 不帶工具旗標', async () => {
  let child;
  let spawnArgs;
  const adapter = createHostAdapter({ spawnFn: (a) => { spawnArgs = a; return (child = fakeChild()); } });
  const p = adapter.executeNode(NODE_ARGS);
  child.stdout.emit('data', 'ok');
  child.emit('close', 0);
  await p;
  assert.ok(spawnArgs.includes('--allowedTools'));
  for (const t of ['WebSearch', 'WebFetch', 'Read']) assert.ok(spawnArgs.includes(t), `缺 ${t}`);
  for (const t of ['Write', 'Edit', 'Bash']) assert.ok(!spawnArgs.includes(t), `不准放行 ${t}`);
  let args2;
  const adapter2 = createHostAdapter({ spawnFn: (a) => { args2 = a; const c = fakeChild(); setTimeout(() => { c.stdout.emit('data', 'ok'); c.emit('close', 0); }, 0); return c; } });
  await adapter2.complete({ prompt: '掃描這份匯入內容' });
  assert.ok(!args2.includes('--allowedTools'), '匯入掃描等通用補全不放行工具（防外洩誘導）');
});

test('輸出格式：有給時 prompt 帶「產出格式要求」段落，沒給時不出現', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.executeNode({ ...NODE_ARGS, outputFormat: 'Markdown 表格，欄位=日期/標題' });
  child.stdout.emit('data', 'ok');
  child.emit('close', 0);
  await p;
  assert.ok(child.stdin.written.includes('產出格式要求'));
  assert.ok(child.stdin.written.includes('Markdown 表格，欄位=日期/標題'));

  let child2;
  const adapter2 = createHostAdapter({ spawnFn: () => (child2 = fakeChild()) });
  const p2 = adapter2.executeNode(NODE_ARGS);
  child2.stdout.emit('data', 'ok');
  child2.emit('close', 0);
  await p2;
  assert.ok(!child2.stdin.written.includes('產出格式要求'));
});

test('進階欄位＋模型：prompt 帶角色/限制/風格/自檢段落，spawn 帶 --model', async () => {
  let child;
  let spawnArgs;
  const adapter = createHostAdapter({ spawnFn: (a) => { spawnArgs = a; return (child = fakeChild()); } });
  const p = adapter.executeNode({ ...NODE_ARGS, roleContext: '你是客服主管', constraints: '不承諾賠償金額', creativity: 'strict', reviewFocus: '數字要對得上', model: 'opus' });
  child.stdout.emit('data', 'ok');
  child.emit('close', 0);
  await p;
  assert.ok(spawnArgs.includes('--model') && spawnArgs.includes('opus'));
  for (const s of ['角色與情境', '你是客服主管', '限制條件', '不承諾賠償金額', '風格', '嚴謹精確', '自我檢查', '數字要對得上']) {
    assert.ok(child.stdin.written.includes(s), `prompt 缺「${s}」`);
  }
  // 沒給 model 時不帶 --model
  let child2;
  let args2;
  const adapter2 = createHostAdapter({ spawnFn: (a) => { args2 = a; return (child2 = fakeChild()); } });
  const p2 = adapter2.executeNode(NODE_ARGS);
  child2.stdout.emit('data', 'ok');
  child2.emit('close', 0);
  await p2;
  assert.ok(!args2.includes('--model'));
});

test('claude 不存在（spawn error）→ HostError UNAVAILABLE，訊息是人話', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.executeNode(NODE_ARGS);
  child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(p, (e) => e instanceof HostError && e.code === 'UNAVAILABLE' && e.message.includes('連不上 Claude') && e.message.includes('你的 Workflow 庫都在，不會不見。'));
});

test('結束碼非 0 → HostError FAILED，附 stderr 摘要', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.executeNode(NODE_ARGS);
  child.stderr.emit('data', 'quota exceeded');
  child.emit('close', 1);
  await assert.rejects(p, (e) => e instanceof HostError && e.code === 'FAILED');
});

test('登入過期（訊息走 stdout、結束碼 1）→ HostError UNAVAILABLE，叫使用者去登入', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.executeNode(NODE_ARGS);
  child.stdout.emit('data', 'Failed to authenticate: OAuth session expired and could not be refreshed');
  child.emit('close', 1);
  await assert.rejects(p, (e) => e instanceof HostError && e.code === 'UNAVAILABLE' && e.message.includes('登入') && e.message.includes('你的 Workflow 庫都在，不會不見。'));
});

test('逾時 → HostError TIMEOUT 並砍掉子行程', async () => {
  let child;
  const adapter = createHostAdapter({ timeoutMs: 30, spawnFn: () => (child = fakeChild()) });
  await assert.rejects(adapter.executeNode(NODE_ARGS), (e) => e instanceof HostError && e.code === 'TIMEOUT');
  assert.ok(child.killed, '逾時要砍子行程');
});

test('complete：原文 prompt 直送 stdin、回 stdout 文字', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.complete({ prompt: '把這件事拆成流程：訂餐廳' });
  child.stdout.emit('data', '好的\n```yaml\nname: x\n```');
  child.emit('close', 0);
  assert.ok((await p).includes('```yaml'));
  assert.equal(child.stdin.written, '把這件事拆成流程：訂餐廳');
});

// ===== --output-format json 解析＋用量帳本＋卷宗協定 =====
const jsonReply = (over = {}) => JSON.stringify({
  type: 'result', is_error: false, result: '整理好的表格', total_cost_usd: 0.0123,
  usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
  modelUsage: { 'claude-haiku-4-5': {} },
  ...over,
});

test('JSON 回覆：spawn 帶 json 格式、回 result 文字、usage 連同 meta 進帳本', async () => {
  let child;
  let spawnArgs;
  const adapter = createHostAdapter({ spawnFn: (a) => { spawnArgs = a; return (child = fakeChild()); } });
  const entries = [];
  adapter.setUsageSink((u) => entries.push(u));
  const p = adapter.executeNode({ ...NODE_ARGS, meta: { kind: 'step', run: 'r-1', node: 'x' } });
  child.stdout.emit('data', jsonReply());
  child.emit('close', 0);
  assert.equal(await p, '整理好的表格');
  assert.ok(spawnArgs.includes('json'), 'spawn 要帶 --output-format json');
  assert.equal(entries.length, 1);
  const u = entries[0];
  assert.equal(u.kind, 'step');
  assert.equal(u.run, 'r-1');
  assert.equal(u.input_tokens, 10);
  assert.equal(u.output_tokens, 20);
  assert.equal(u.cache_creation_input_tokens, 30);
  assert.equal(u.cache_read_input_tokens, 40);
  assert.equal(u.cost_usd, 0.0123);
  assert.equal(u.model, 'claude-haiku-4-5');
  assert.ok(u.at, '帳目要有時間戳');
});

test('JSON is_error → HostError FAILED 附宿主說明；帳照記（失敗的呼叫也花了 token）', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const entries = [];
  adapter.setUsageSink((u) => entries.push(u));
  const p = adapter.executeNode(NODE_ARGS);
  child.stdout.emit('data', jsonReply({ is_error: true, result: '模型過載，稍後再試' }));
  child.emit('close', 0);
  await assert.rejects(p, (e) => e instanceof HostError && e.code === 'FAILED' && e.message.includes('模型過載'));
  assert.equal(entries.length, 1, 'is_error 也要記帳');
});

test('非 JSON 回覆（宿主版本差異防呆）→ 整段當純文字用、不記帳、不炸', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const entries = [];
  adapter.setUsageSink((u) => entries.push(u));
  const p = adapter.complete({ prompt: '測', meta: { kind: 'compose' } });
  child.stdout.emit('data', '純文字回覆，不是 JSON');
  child.emit('close', 0);
  assert.equal(await p, '純文字回覆，不是 JSON');
  assert.equal(entries.length, 0);
});

test('complete 帶 meta：帳目 kind 歸戶正確', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const entries = [];
  adapter.setUsageSink((u) => entries.push(u));
  const p = adapter.complete({ prompt: '測', meta: { kind: 'branch', run: 'r-2' } });
  child.stdout.emit('data', jsonReply({ result: '1. 走 A' }));
  child.emit('close', 0);
  assert.equal(await p, '1. 走 A');
  assert.equal(entries[0].kind, 'branch');
  assert.equal(entries[0].run, 'r-2');
});

test('卷宗協定：renderPrompt 與實際送進 stdin 的 prompt 一字不差', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const args = { ...NODE_ARGS, roleContext: '你是客服主管', meta: { kind: 'step' }, model: 'opus' };
  const p = adapter.executeNode(args);
  child.stdout.emit('data', jsonReply());
  child.emit('close', 0);
  await p;
  assert.equal(adapter.renderPrompt(args), child.stdin.written);
});

// ===== buildPrompt 四新段 =====

test('buildPrompt：paramBlocks → 「# 欄位內容（原文）」段出現在「# 上一步的產出」之前，每塊帶 label 與原文', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({
    ...NODE_ARGS,
    paramBlocks: [{ label: '來信', value: '寄件人：林小姐\n主旨：刮傷' }],
  });
  assert.ok(prompt.includes('# 欄位內容（原文）'));
  assert.ok(prompt.includes('【欄位：來信】'));
  assert.ok(prompt.includes('寄件人：林小姐\n主旨：刮傷'));
  assert.ok(prompt.indexOf('# 欄位內容（原文）') < prompt.indexOf('# 上一步的產出'), '欄位內容段要在上一步的產出之前');
});

test('buildPrompt：editRules → 「# 使用者在停點改過的要求（後面每一步都要守）」出現在「# 限制條件」之後，逐條列點', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({
    ...NODE_ARGS,
    constraints: '不承諾賠償金額',
    editRules: ['每段不超過三句', '不用「親愛的」開頭'],
  });
  assert.ok(prompt.includes('# 使用者在停點改過的要求（後面每一步都要守）'));
  assert.ok(prompt.includes('- 每段不超過三句'));
  assert.ok(prompt.includes('- 不用「親愛的」開頭'));
  assert.ok(prompt.indexOf('# 限制條件') < prompt.indexOf('# 使用者在停點改過的要求'), '要在限制條件之後');
});

test('buildPrompt：redo → 「# 上一次交貨被查核退回（必須逐條修正，其餘保持）」出現在「# 交件前自我檢查」之後，blocks／missing 各一行', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({
    ...NODE_ARGS,
    reviewFocus: '數字要對得上',
    redo: {
      blocks: [{ kind: 'number-mismatch', claim: '總數 13 件', source: '共 14 件', detail: '算式不成立：6+3+4+1=14' }],
      missing: [{ claim: '客戶滿意度', detail: '原始資料沒有調查結果' }],
    },
  });
  assert.ok(prompt.includes('# 上一次交貨被查核退回（必須逐條修正，其餘保持）'));
  assert.ok(prompt.includes('- 錯在哪：算式不成立：6+3+4+1=14｜成品寫：總數 13 件｜原始資料：共 14 件'));
  assert.ok(prompt.includes('- 原始資料沒有「客戶滿意度」，明寫未知或估計，不准編'));
  assert.ok(prompt.indexOf('# 交件前自我檢查') < prompt.indexOf('# 上一次交貨被查核退回'), '要在交件前自我檢查之後');
});

test('buildPrompt：checkNote → 「# 使用者的回話（這次必須照做）」緊接查核退回段之後；沒有 redo 也照樣出現在同一位置', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({ ...NODE_ARGS, reviewFocus: '數字要對得上', checkNote: '這次要用千元為單位' });
  assert.ok(prompt.includes('# 使用者的回話（這次必須照做）'));
  assert.ok(prompt.includes('這次要用千元為單位'));
  assert.ok(prompt.indexOf('# 交件前自我檢查') < prompt.indexOf('# 使用者的回話'), '要在交件前自我檢查之後（沒有 redo 時緊接在同一位置）');
});

test('buildPrompt：四個新段都不給 → 輸出與現況逐字相同（固定樣本比對）', () => {
  const adapter = createHostAdapter({});
  const SAMPLE_ARGS = {
    nodeId: 'x', title: '整理歸納', instruction: '整理成表',
    roleContext: '你是客服主管', background: '過去三個月的客訴紀錄',
    constraints: '不承諾賠償金額', examples: '範例：客戶A 退貨 500 元',
    outputFormat: 'Markdown 表格，欄位=日期/標題', creativity: 'strict',
    reviewFocus: '數字要對得上', attachments: ['C:/tmp/files/範本.docx'],
    upstream: '原始資料',
  };
  const FIXED_SAMPLE = "你是「剝繭」流程裡的一個步驟執行者。只輸出這一步的產出內容本身——不要開場白、不要收尾語、不要解釋你做了什麼。\n這不是對話：沒有人會回覆你，你的產出會直接交給下一步（或給使用者過目，他只能核可或動手修改）。不要反問、不要邀請回覆、不要用「要哪個再說」收尾。任務要你提供多個選項時，自己選定一個推薦，讓產出以推薦版本為主體、備選附在後面標明。\n特例：如果要求裡指定的資料你拿不齊或拿不到——缺月份、缺欄位、少一段、工具不可用、搜尋無結果、上游沒交貨都算——第一行輸出「【資料不全】」加一句缺什麼，換行後再給你能給的部分。不准把「無項目」「找不到」這類空話當正式產出交出去。\n說明缺什麼時用使用者聽得懂的話講——只講「缺哪些資料、從哪裡拿得到」，不提工具、連線、指令或系統名稱。\n全篇使用與「要求」相同的語言，不夾雜其他語言的字詞（專有名詞照原文除外）。\n\n# 角色與情境\n你是客服主管\n\n# 這一步：整理歸納\n\n# 要求\n整理成表\n\n# 背景資料\n過去三個月的客訴紀錄\n\n# 限制條件（不可違反）\n不承諾賠償金額\n\n# 範例（照這個樣子）\n範例：客戶A 退貨 500 元\n\n# 參考檔案（先用你的檔案讀取能力逐一打開看，照裡面的規格與風格做）\n- C:/tmp/files/範本.docx\n\n# 產出格式要求（嚴格遵守）\nMarkdown 表格，欄位=日期/標題\n\n# 風格\n嚴謹精確——照資料與要求寫，不自行發揮、不添加未經證實的內容。\n\n# 交件前自我檢查（使用者也會用同一標準驗收）\n數字要對得上\n\n# 上一步的產出（你的輸入）\n原始資料";
  assert.equal(adapter.renderPrompt(SAMPLE_ARGS), FIXED_SAMPLE);
});

// ===== 工作單的「關於你」與「分類守則」兩段 =====

test('buildPrompt：coreNotes → 「# 關於你」段在「# 角色與情境」之前；groupRules → 「# 分類守則」段在「# 限制條件」之後、「# 使用者在停點改過的要求」之前；逐條列點', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({
    ...NODE_ARGS,
    roleContext: '你是客服主管',
    constraints: '不承諾賠償金額',
    editRules: ['每段不超過三句'],
    coreNotes: ['不要恭維', '數字附來源'],
    groupRules: ['不提競品', '語氣：輕鬆'],
    groupName: '旅遊',
  });
  assert.ok(prompt.includes('# 關於你（每一步都照這些做；跟「要求」衝突時以「要求」為準）'));
  assert.ok(prompt.includes('- 不要恭維') && prompt.includes('- 數字附來源'));
  assert.ok(prompt.indexOf('# 關於你') < prompt.indexOf('# 角色與情境'), '關於你要在角色與情境之前');
  assert.ok(prompt.indexOf('# 關於你') > prompt.indexOf('不夾雜其他語言'), '關於你在開場五句之後');
  assert.ok(prompt.includes('# 分類守則（分類「旅遊」，一定要守）'));
  assert.ok(prompt.includes('- 不提競品') && prompt.includes('- 語氣：輕鬆'), '有名字的條原樣列');
  assert.ok(prompt.indexOf('# 限制條件') < prompt.indexOf('# 分類守則'), '群組段要在限制條件之後');
  assert.ok(prompt.indexOf('# 分類守則') < prompt.indexOf('# 使用者在停點改過的要求'), '群組段要在停點改過的要求之前');
  // 沒有角色與情境時，關於你段仍在「# 這一步」之前
  const noRole = adapter.renderPrompt({ ...NODE_ARGS, coreNotes: ['不要恭維'] });
  assert.ok(noRole.indexOf('# 關於你') < noRole.indexOf('# 這一步'));
});

test('buildPrompt：coreNotes／groupRules 空或沒給 → 兩段都不出現，輸出與現況逐字相同', () => {
  const adapter = createHostAdapter({});
  const base = adapter.renderPrompt({ ...NODE_ARGS, roleContext: '你是客服主管', constraints: '不承諾賠償金額' });
  assert.ok(!base.includes('# 關於你') && !base.includes('# 分類守則'));
  assert.equal(adapter.renderPrompt({ ...NODE_ARGS, roleContext: '你是客服主管', constraints: '不承諾賠償金額', coreNotes: [], groupRules: [], groupName: '旅遊' }), base);
});

test('卷宗協定：帶兩新段的 renderPrompt 與實際送進 stdin 的 prompt 一字不差', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const args = { ...NODE_ARGS, roleContext: '你是客服主管', coreNotes: ['不要恭維'], groupRules: ['不提競品'], groupName: '旅遊', meta: { kind: 'step' } };
  const p = adapter.executeNode(args);
  child.stdout.emit('data', jsonReply());
  child.emit('close', 0);
  await p;
  assert.equal(adapter.renderPrompt(args), child.stdin.written);
  assert.ok(child.stdin.written.includes('# 關於你') && child.stdin.written.includes('# 分類守則'));
});

// ===== 工作單的監工交接段＋查網開關 =====

test('buildPrompt：supervisorNotes → 「# 監工交接」段出現在「# 上一步的產出」之前，逐條列點；空清單不出現', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({ ...NODE_ARGS, supervisorNotes: ['開場：總表 14 件', '交接：按三類分節'] });
  assert.ok(prompt.includes('# 監工交接（這趟的備註，照做；跟「要求」衝突時以「要求」為準）'));
  assert.ok(prompt.includes('- 開場：總表 14 件'));
  assert.ok(prompt.includes('- 交接：按三類分節'));
  assert.ok(prompt.indexOf('# 監工交接') < prompt.indexOf('# 上一步的產出'), '要在上一步的產出之前');
  assert.ok(!adapter.renderPrompt({ ...NODE_ARGS, supervisorNotes: [] }).includes('# 監工交接'));
  assert.ok(!adapter.renderPrompt(NODE_ARGS).includes('# 監工交接'));
});

test('監工輪：web=false → --tools 與 --allowedTools 都不放行查網；缺省照舊放行', async () => {
  const spawnFor = async (args) => {
    let child;
    let spawnArgs;
    const adapter = createHostAdapter({ spawnFn: (a) => { spawnArgs = a; return (child = fakeChild()); } });
    const p = adapter.executeNode(args);
    child.stdout.emit('data', 'ok');
    child.emit('close', 0);
    await p;
    return spawnArgs;
  };
  const off = await spawnFor({ ...NODE_ARGS, web: false });
  assert.equal(off[off.indexOf('--tools') + 1], 'Read');
  assert.ok(!off.includes('WebSearch') && !off.includes('WebFetch'), `關了查網就一個都不准出現：${off}`);
  const on = await spawnFor(NODE_ARGS);
  assert.equal(on[on.indexOf('--tools') + 1], 'WebSearch,WebFetch,Read');
  assert.deepEqual(on.slice(on.indexOf('--allowedTools')), ['--allowedTools', 'WebSearch', 'WebFetch', 'Read']);
  const offFile = await spawnFor({ ...NODE_ARGS, web: false, fileMode: { cwd: 'C:/tmp/o', fileName: '報告.docx', templatePath: null } });
  assert.equal(offFile[offFile.indexOf('--tools') + 1], 'Read,Write,Edit,Bash', '產檔工具照放，只拿掉查網');
  assert.deepEqual(offFile.slice(offFile.indexOf('--allowedTools')), ['--allowedTools', 'Read', 'Write', 'Edit', 'Bash(node *)']);
});

test('checkAvailable：結束碼 0 → true；spawn error → false', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p = adapter.checkAvailable();
  child.emit('close', 0);
  assert.equal(await p, true);
  const adapter2 = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const p2 = adapter2.checkAvailable();
  child.emit('error', new Error('ENOENT'));
  assert.equal(await p2, false);
});

// ===== 不帶行李模式（BOJIAN_LEAN）：預設關；開了才換系統提示、只送用得到的工具定義 =====

// 自動應答的假子行程：spawn 參數留底，下一個 tick 回一筆 JSON 讓 promise 收斂
function capture(reply = jsonReply()) {
  const rec = {};
  rec.spawnFn = (a, extra) => {
    rec.args = a;
    rec.extra = extra;
    const c = fakeChild();
    setTimeout(() => { c.stdout.emit('data', reply); c.emit('close', 0); }, 0);
    return c;
  };
  return rec;
}

// 環境變數在測試間會互相污染：明確設定／清掉，跑完還原
async function withLeanEnv(value, fn) {
  const saved = process.env.BOJIAN_LEAN;
  if (value === undefined) delete process.env.BOJIAN_LEAN;
  else process.env.BOJIAN_LEAN = value;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.BOJIAN_LEAN;
    else process.env.BOJIAN_LEAN = saved;
  }
}

const FM = { cwd: 'C:/tmp/run-out', fileName: '報告.docx' };

test('帶行李：明講關閉（lean:false）——executeNode／complete 的 spawn 參數與現況逐字相同', async () => {
  await withLeanEnv(undefined, async () => {
    const a = capture();
    const adapter = createHostAdapter({ spawnFn: a.spawnFn, lean: false });
    await adapter.executeNode(NODE_ARGS);
    assert.deepEqual(a.args, ['-p', '--output-format', 'json', '--allowedTools', 'WebSearch', 'WebFetch', 'Read']);
    assert.equal(adapter.isLean(), false);

    const b = capture();
    await createHostAdapter({ spawnFn: b.spawnFn, lean: false }).executeNode({ ...NODE_ARGS, model: 'opus', fileMode: FM });
    assert.deepEqual(b.args, ['-p', '--output-format', 'json', '--allowedTools', 'WebSearch', 'WebFetch', 'Read', 'Write', 'Edit', 'Bash(node *)', '--model', 'opus']);

    const c = capture();
    await createHostAdapter({ spawnFn: c.spawnFn, lean: false }).complete({ prompt: '測' });
    assert.deepEqual(c.args, ['-p', '--output-format', 'json']);
  });
});

test('不帶行李：沒給 option、沒設環境變數——預設就是輕裝', async () => {
  await withLeanEnv(undefined, async () => {
    const a = capture();
    const adapter = createHostAdapter({ spawnFn: a.spawnFn });
    assert.equal(adapter.isLean(), true);
    await adapter.executeNode(NODE_ARGS);
    assert.deepEqual(a.args, [
      '-p', '--output-format', 'json',
      '--strict-mcp-config', '--disable-slash-commands',
      '--system-prompt', LEAN_WORKER_SYSTEM,
      '--tools', 'WebSearch,WebFetch,Read',
      '--allowedTools', 'WebSearch', 'WebFetch', 'Read',
    ]);

    const c = capture();
    await createHostAdapter({ spawnFn: c.spawnFn }).complete({ prompt: '測' });
    assert.deepEqual(c.args, [
      '-p', '--output-format', 'json',
      '--strict-mcp-config', '--disable-slash-commands',
      '--system-prompt', LEAN_GENERIC_SYSTEM,
      '--tools', '',
    ]);
  });
});

test('不帶行李：option 明寫開啟——executeNode 依序帶六個輕裝旗標，--tools 只列用得到的，--allowedTools 清單原封不動接在後面', async () => {
  await withLeanEnv(undefined, async () => {
    const a = capture();
    const adapter = createHostAdapter({ spawnFn: a.spawnFn, lean: true });
    await adapter.executeNode(NODE_ARGS);
    assert.equal(adapter.isLean(), true);
    assert.deepEqual(a.args, [
      '-p', '--output-format', 'json',
      '--strict-mcp-config', '--disable-slash-commands',
      '--system-prompt', LEAN_WORKER_SYSTEM,
      '--tools', 'WebSearch,WebFetch,Read',
      '--allowedTools', 'WebSearch', 'WebFetch', 'Read',
    ]);

    const b = capture();
    await createHostAdapter({ spawnFn: b.spawnFn, lean: true }).executeNode({ ...NODE_ARGS, model: 'opus', fileMode: FM });
    assert.deepEqual(b.args, [
      '-p', '--output-format', 'json',
      '--strict-mcp-config', '--disable-slash-commands',
      '--system-prompt', LEAN_WORKER_SYSTEM,
      '--tools', 'WebSearch,WebFetch,Read,Write,Edit,Bash',
      '--allowedTools', 'WebSearch', 'WebFetch', 'Read', 'Write', 'Edit', 'Bash(node *)',
      '--model', 'opus',
    ]);
    assert.equal(b.extra.cwd, 'C:/tmp/run-out', '產檔模式的工作目錄與 NODE_PATH 不受輕裝影響');
    assert.ok(b.extra.env.NODE_PATH.endsWith('node_modules'));

    const c = capture();
    await createHostAdapter({ spawnFn: c.spawnFn, lean: true }).complete({ prompt: '測' });
    assert.deepEqual(c.args, [
      '-p', '--output-format', 'json',
      '--strict-mcp-config', '--disable-slash-commands',
      '--system-prompt', LEAN_GENERIC_SYSTEM,
      '--tools', '',
    ]);
    assert.ok(!c.args.includes('--allowedTools'), '通用補全照樣不放行工具');
  });
});

test('不帶行李：兩段系統提示是導出的常數（A/B 報告要引用原文）', () => {
  assert.match(LEAN_WORKER_SYSTEM, /^你是剝繭流程裡的一名工人。/);
  assert.ok(LEAN_WORKER_SYSTEM.includes('訊息沒要求的不要做'));
  // A／B 第二回合：輕裝工人每一步都自報資料不全、還編了沒有依據的數字，工人提示補三條規則
  assert.ok(LEAN_WORKER_SYSTEM.includes('就用手上的資料判斷'), '被要求判斷／評分／排序時要自己判斷');
  assert.ok(LEAN_WORKER_SYSTEM.includes('不要因為資料不完整就停下'), '只有必要原始資料真的沒給才回報資料不全');
  assert.ok(LEAN_WORKER_SYSTEM.includes('不准編'), '沒有的數字要寫未知，不准編');
  assert.match(LEAN_GENERIC_SYSTEM, /^只照接下來訊息裡的指示做事/);
  assert.ok(LEAN_GENERIC_SYSTEM.includes('只輸出訊息要求的格式'));
});

test('不帶行李：每筆用量帳都帶 lean 欄位（A/B 才分得出哪些呼叫是輕裝）', async () => {
  await withLeanEnv(undefined, async () => {
    for (const lean of [false, true]) {
      const a = capture();
      const adapter = createHostAdapter({ spawnFn: a.spawnFn, lean });
      const entries = [];
      adapter.setUsageSink((u) => entries.push(u));
      await adapter.executeNode({ ...NODE_ARGS, meta: { kind: 'step', run: 'r-1' } });
      await adapter.complete({ prompt: '測', meta: { kind: 'checker' } });
      assert.equal(entries.length, 2);
      for (const u of entries) assert.equal(u.lean, lean, `lean=${lean} 的帳目要標 lean`);
      assert.equal(entries[0].kind, 'step', '其他欄位照舊');
      assert.equal(entries[0].input_tokens, 10);
    }
  });
});

test('解析順序：option 明寫優先，其次環境變數 BOJIAN_LEAN，都沒有才落到預設輕裝', async () => {
  await withLeanEnv('1', async () => {
    const a = capture();
    const adapter = createHostAdapter({ spawnFn: a.spawnFn });
    assert.equal(adapter.isLean(), true);
    await adapter.executeNode(NODE_ARGS);
    assert.ok(a.args.includes('--strict-mcp-config') && a.args.includes('--tools'));
    assert.equal(createHostAdapter({ spawnFn: capture().spawnFn, lean: false }).isLean(), false, 'option 明寫 false 要蓋過環境變數');
    assert.equal(createHostAdapter({ spawnFn: capture().spawnFn, lean: true }).isLean(), true, 'option 明寫 true 也蓋過環境變數');
  });
  for (const legacyVal of ['0', 'false', 'off']) {
    await withLeanEnv(legacyVal, async () => {
      assert.equal(createHostAdapter({ spawnFn: capture().spawnFn }).isLean(), false, `BOJIAN_LEAN=${legacyVal} 要退回帶行李`);
    });
  }
});

test('BOJIAN_LEAN=0：退回帶行李——spawn 參數與帶行李版本逐字相同', async () => {
  await withLeanEnv('0', async () => {
    const a = capture();
    const adapter = createHostAdapter({ spawnFn: a.spawnFn });
    assert.equal(adapter.isLean(), false);
    await adapter.executeNode(NODE_ARGS);
    assert.deepEqual(a.args, ['-p', '--output-format', 'json', '--allowedTools', 'WebSearch', 'WebFetch', 'Read']);
  });
});

// 連接器例外——探針（reviews/-實走-2026-09-09/連接器探針.md）判定停在第一層，
// 兇手是 --strict-mcp-config：不推它連接器就回來了，其餘輕裝旗標照推。
test('連接器例外：meta.mcp 的呼叫不推 --strict-mcp-config、--allowedTools 加行事曆工具；其餘呼叫照舊嚴格', async () => {
  const a = capture();
  const adapter = createHostAdapter({ spawnFn: a.spawnFn });
  await adapter.complete({ prompt: '抓快照', meta: { kind: 'snapshot', mcp: 'calendar' } });
  assert.ok(!a.args.includes('--strict-mcp-config'), '行事曆呼叫不能推 --strict-mcp-config');
  assert.ok(a.args.includes('--disable-slash-commands'), '其餘輕裝旗標照推');
  assert.ok(a.args.includes('--tools'), '--tools 照推（探針證實它不擋連接器）');
  assert.ok(a.args.includes('--allowedTools') && a.args.includes(CALENDAR_TOOLS), '權限閘要放行行事曆工具');

  const b = capture();
  await createHostAdapter({ spawnFn: b.spawnFn }).complete({ prompt: '查核', meta: { kind: 'check' } });
  assert.ok(b.args.includes('--strict-mcp-config'), '一般通用補全照舊嚴格');
  assert.ok(!b.args.includes(CALENDAR_TOOLS), '一般呼叫不放行行事曆工具');

  const c = capture();
  await createHostAdapter({ spawnFn: c.spawnFn }).executeNode({ ...NODE_ARGS, meta: { kind: 'step', mcp: 'calendar' } });
  assert.ok(!c.args.includes('--strict-mcp-config'));
  assert.ok(c.args.includes(CALENDAR_TOOLS) && c.args.includes('Read') && c.args.includes('WebSearch'), '行事曆工具是加上去的，讀類工具照舊');

  const d = capture();
  await createHostAdapter({ spawnFn: d.spawnFn }).executeNode({ ...NODE_ARGS, meta: { kind: 'step' } });
  assert.ok(d.args.includes('--strict-mcp-config') && !d.args.includes(CALENDAR_TOOLS), '沒有 mcp 的步驟照舊輕裝');
});

// ===== 工作單的「公司規範」與「部門規範」兩段（規範類每步都帶、全文貼進去；外圈在前：公司→部門→分類守則） =====

test('U1b ①：companyRules／deptRules → 「# 公司規範」「# 部門規範」在「# 限制條件」之後、「# 分類守則」之前；每檔「## 檔名」＋全文；空層不印段', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({
    ...NODE_ARGS,
    roleContext: '你是客服主管',
    constraints: '不承諾賠償金額',
    editRules: ['每段不超過三句'],
    coreNotes: ['不要恭維'],
    groupRules: ['不提競品'],
    groupName: '旅遊',
    companyRules: [{ name: '員工手冊.md', text: '語氣要親切，不用敬語堆疊。' }, { name: '品牌語氣.txt', text: '不說「尊榮」。' }],
    deptRules: [{ name: '部門規範.docx', text: '報價一律含稅。' }],
  });
  assert.ok(prompt.includes('# 公司規範（每一步都照做；查核員也會對）'), prompt);
  assert.ok(prompt.includes('## 員工手冊.md\n語氣要親切，不用敬語堆疊。'));
  assert.ok(prompt.includes('## 品牌語氣.txt\n不說「尊榮」。'));
  assert.ok(prompt.includes('# 部門規範（分類「旅遊」，同上）'), prompt);
  assert.ok(prompt.includes('## 部門規範.docx\n報價一律含稅。'));
  const at = (h) => prompt.indexOf(h);
  assert.ok(at('# 關於你') < at('# 限制條件') && at('# 限制條件') < at('# 公司規範'), '公司規範在限制條件之後');
  assert.ok(at('# 公司規範') < at('# 部門規範') && at('# 部門規範') < at('# 分類守則'), '外圈在前：公司→部門→分類守則');
  assert.ok(at('# 分類守則') < at('# 使用者在停點改過的要求'), '分類守則仍在停點改過的要求之前');
  const onlyDept = adapter.renderPrompt({ ...NODE_ARGS, groupName: '旅遊', companyRules: [], deptRules: [{ name: 'd.md', text: 'x' }] });
  assert.ok(!onlyDept.includes('# 公司規範') && onlyDept.includes('# 部門規範（分類「旅遊」，同上）\n## d.md\nx'), '空層不印段');
});

test('U1b ①：兩層皆空或沒給 → 「規範」零命中，輸出與現況逐字相同', () => {
  const adapter = createHostAdapter({});
  const args = { ...NODE_ARGS, roleContext: '你是客服主管', constraints: '不承諾賠償金額', groupRules: ['不提競品'], groupName: '旅遊' };
  const base = adapter.renderPrompt(args);
  assert.equal((base.match(/規範/g) ?? []).length, 0);
  assert.equal(adapter.renderPrompt({ ...args, companyRules: [], deptRules: [] }), base);
});

test('U1b 卷宗協定：帶規範兩段的 renderPrompt 與實際送進 stdin 的 prompt 一字不差', async () => {
  let child;
  const adapter = createHostAdapter({ spawnFn: () => (child = fakeChild()) });
  const args = { ...NODE_ARGS, companyRules: [{ name: '手冊.md', text: '語氣要親切。' }], deptRules: [{ name: '部門.md', text: '含稅。' }], groupName: '旅遊', meta: { kind: 'step' } };
  const p = adapter.executeNode(args);
  child.stdout.emit('data', jsonReply());
  child.emit('close', 0);
  await p;
  assert.equal(adapter.renderPrompt(args), child.stdin.written);
  assert.ok(child.stdin.written.includes('## 手冊.md\n語氣要親切。'));
});

test('U1b 覆核該修：規範內文行首 # 全部降一級（# → ##、###### 封頂）——全文 ^# 開頭的行只剩系統段標題', () => {
  const adapter = createHostAdapter({});
  const prompt = adapter.renderPrompt({
    ...NODE_ARGS,
    groupName: '旅遊',
    companyRules: [{ name: '員工手冊.md', text: '# 員工手冊\n語氣要親切。\n## 請假\n前一天說。\n###### 六級\n#不是標題\n  # 縮排不算' }],
    deptRules: [{ name: '部門.md', text: '# 部門規範\n含稅。' }],
  });
  assert.ok(prompt.includes('## 員工手冊.md\n## 員工手冊\n語氣要親切。\n### 請假\n前一天說。\n###### 六級\n#不是標題\n  # 縮排不算'), prompt);
  assert.ok(prompt.includes('## 部門.md\n## 部門規範\n含稅。'));
  const h1 = prompt.split('\n').filter((l) => /^# /.test(l));
  assert.deepEqual(h1, ['# 這一步：整理歸納', '# 要求', '# 公司規範（每一步都照做；查核員也會對）', '# 部門規範（分類「旅遊」，同上）', '# 上一步的產出（你的輸入）'], '一級標題只剩系統段');
});

// ── 2026-09-18 真子行程迴歸（假 stream 驗不到編碼，只有真的 pipe 才會分塊）──

test('長中文產出不被切壞：stdout 跨 64KB 塊界的中文要原樣回來', async () => {
  const { spawn } = await import('node:child_process');
  const N = 60_000; // 「繭」3 bytes × 60000 ＝ 180KB，必定跨好幾個 64KB 塊界
  // 真子行程：由它自己生字，避免把 180KB 塞進命令列（Windows 命令列有長度上限）
  const code = `process.stdout.write(JSON.stringify({ type: 'result', result: '繭'.repeat(${N}) }))`;
  const adapter = createHostAdapter({ spawnFn: () => spawn(process.execPath, ['-e', code]) });
  const out = await adapter.complete({ prompt: 'x' });
  assert.equal(out.includes('�'), false, 'stdout 出現 U+FFFD＝跨塊的中文被切壞了');
  assert.equal(out.length, N, `產出長度應為 ${N}，實得 ${out.length}`);
});

test('子行程在工作單寫完前就死掉：回人話錯誤，不把行程炸掉', async () => {
  const { spawn } = await import('node:child_process');
  // 立刻結束、完全不讀 stdin 的子行程；工作單夠大才會留下沒排空的 write（EPIPE 的必要條件）
  const adapter = createHostAdapter({ spawnFn: () => spawn(process.execPath, ['-e', 'process.exit(1)']) });
  await assert.rejects(
    () => adapter.complete({ prompt: 'x'.repeat(2_000_000) }),
    (e) => e instanceof HostError,
    '應回 HostError，而不是讓未捕捉的 stdin EPIPE 把整個行程帶走',
  );
});
