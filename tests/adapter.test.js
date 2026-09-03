import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHostAdapter, HostError } from '../src/host-adapter.js';

// 假子行程：可控 stdout／stderr／結束碼／不結束
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { written: '', write(s) { this.written += s; }, end() {} };
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
  await assert.rejects(p, (e) => e instanceof HostError && e.code === 'UNAVAILABLE' && e.message.includes('連不上 Claude'));
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
  await assert.rejects(p, (e) => e instanceof HostError && e.code === 'UNAVAILABLE' && e.message.includes('登入'));
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

// ===== 儀表板輪：--output-format json 解析＋用量帳本＋卷宗協定 =====
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
