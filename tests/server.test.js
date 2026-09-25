import test from 'node:test';
import assert from 'node:assert/strict';

// —— D19 新端點：常用預設庫、參考檔、產出物下載 ——
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import yaml from 'js-yaml';
import { createApp, freeOrgId, previewArtifact } from '../src/server.js';
import { createStore } from '../src/store.js';
import { makeCard, ensureFields } from '../src/memory.js';

function fakeAdapter() {
  const calls = [];
  let completeResponses = [];
  let checkResponses = [];
  let editRulesResponses = [];
  let editRulesDelay = 0; // 真 AI 擬規則要 10–60 秒，這裡用毫秒模擬那段空窗
  let routeResponses = []; // 三問路由（kind='memory'）自己一條隊列；缺省 ''＝路由解析失敗＝「這句沒記成」，不擋任何流程
  let available = true;
  const completes = []; // 通用補全的 meta（連接器例外要看得到 mcp）
  let usageSink = null; // ⑦：比照 host-adapter.settleParsed 記帳（at＋meta 展開）；只在測試明叫 enableUsage() 才記，別的測試帳本照舊空
  let usageOn = false;
  return {
    calls,
    completes,
    setUsageSink(fn) { usageSink = fn; },
    enableUsage() { usageOn = true; },
    setCompleteResponses(rs) { completeResponses = rs; },
    // 查核／擬規則各自一條隊列，跟一般 complete()（分岔、compose…）分開——kind 對不上就照舊
    setCheckResponses(rs) { checkResponses = rs; },
    setEditRulesResponses(rs) { editRulesResponses = rs; },
    setEditRulesDelay(ms) { editRulesDelay = ms; },
    setRouteResponses(rs) { routeResponses = rs; }, // 字串，或 (meta, prompt)=>字串／丟錯
    setAvailable(v) { available = v; },
    async complete({ meta, prompt } = {}) {
      completes.push({ meta, prompt });
      if (usageOn && usageSink) usageSink({ at: new Date().toISOString(), ...(meta ?? {}), input_tokens: 1, output_tokens: 1 });
      if (meta?.kind === 'memory') {
        const r = routeResponses.length > 1 ? routeResponses.shift() : routeResponses[0] ?? '';
        return typeof r === 'function' ? r(meta, prompt) : r;
      }
      if (meta?.kind === 'check') return checkResponses.length > 1 ? checkResponses.shift() : checkResponses[0] ?? '';
      if (meta?.kind === 'edit-rules') {
        if (editRulesDelay) await new Promise((r) => setTimeout(r, editRulesDelay));
        return editRulesResponses.length > 1 ? editRulesResponses.shift() : editRulesResponses[0] ?? '';
      }
      return completeResponses.length > 1 ? completeResponses.shift() : completeResponses[0] ?? '';
    },
    async checkAvailable() { return available; },
    async executeNode({ nodeId, instruction, upstream, editRules, meta, attachments }) {
      calls.push({ nodeId, instruction, upstream, editRules, meta, attachments }); // 多記 attachments（本次上傳掛在哪一步）
      return `產出:${nodeId}`;
    },
  };
}

async function startApp() {
  // 多組織：createApp 收的是「資料根」，各組織的一整套資料在 root/orgs/<id>/。
  // 底下所有測試的 dataDir 一律指預設組織夾（main），路徑斷言完全不用改。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-server-'));
  const adapter = fakeAdapter();
  const app = createApp({ dataDir: root, adapter });
  await app.start(0); // 動態埠
  const base = `http://127.0.0.1:${app.port()}`;
  return { app, base, adapter, dataDir: path.join(root, 'orgs', 'main'), root };
}

async function api(base, method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

async function pollRun(base, runPath, until, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const { json } = await api(base, 'GET', runPath);
    if (until(json)) return json;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等不到 run 進入預期狀態');
}

test('server：播種範例→清單→詳情→開跑→兩停點→人步→收尾（API 全鏈）', async () => {
  const { app, base, adapter } = await startApp();
  try {
    // 播種：啟動時逐檔補種內建範例
    const list = (await api(base, 'GET', '/api/workflows')).json;
    assert.equal(list.length, 2);
    assert.ok(list.every((w) => w.category === '範例'));
    assert.deepEqual(list.map((w) => w.name).sort(), ['寫週報', '跟主管報告季度業績']);

    const wfPath = `/api/workflows/${encodeURIComponent('範例')}/quarterly-report`;
    const def = (await api(base, 'GET', wfPath)).json;
    assert.equal(def.nodes.length, 5);

    // 開跑，帶一個覆寫
    const started = await api(base, 'POST', `${wfPath}/runs`, { overrides: { script_length: '5 分鐘' } });
    assert.equal(started.status, 200);
    const runPath = `${wfPath}/runs/${started.json.run_id}`;

    let run = await pollRun(base, runPath, (r) => r.status === 'paused');
    assert.equal(run.steps.organize.status, 'waiting_review');
    assert.ok(adapter.calls.find((c) => c.nodeId === 'compose') === undefined, 'compose 還沒跑');

    await api(base, 'POST', `${runPath}/approve`, { node: 'organize' });
    run = await pollRun(base, runPath, (r) => r.status === 'paused' && r.steps.compose.status === 'waiting_review');
    assert.ok(adapter.calls.find((c) => c.nodeId === 'compose').instruction.includes('5 分鐘'), '覆寫值注入');

    await api(base, 'POST', `${runPath}/edit`, { node: 'compose', output: '改過的講稿', note: '口氣改輕鬆' });
    run = await pollRun(base, runPath, (r) => r.steps.present.status === 'waiting_human');
    assert.equal(run.steps.compose.edited_output, '改過的講稿');

    await api(base, 'POST', `${runPath}/human-done`, { node: 'present', feedback: '主管說不錯' });
    run = await pollRun(base, runPath, (r) => r.status === 'done');
    assert.equal(run.steps.present.feedback, '主管說不錯');
  } finally {
    await app.stop();
  }
});

test('server：對已完成節點 retry → 400 人話錯誤，不准假裝成功', async () => {
  const { app, base } = await startApp();
  try {
    const wfPath = `/api/workflows/${encodeURIComponent('範例')}/quarterly-report`;
    const started = await api(base, 'POST', `${wfPath}/runs`, {});
    const runPath = `${wfPath}/runs/${started.json.run_id}`;
    await pollRun(base, runPath, (r) => r.steps['fetch-data'].status === 'done');
    const res = await api(base, 'POST', `${runPath}/retry`, { node: 'fetch-data' });
    assert.equal(res.status, 400);
    assert.ok(res.json.error.includes('不是失敗狀態'), `要人話錯誤，拿到：${JSON.stringify(res.json)}`);
  } finally {
    await app.stop();
  }
});

test('server：重啟後卡在「執行中」的 run，被查看狀態時自動接回續跑', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    const wfPath = `/api/workflows/${encodeURIComponent('範例')}/quarterly-report`;
    const started = await api(base, 'POST', `${wfPath}/runs`, {});
    const runPath = `${wfPath}/runs/${started.json.run_id}`;
    await pollRun(base, runPath, (r) => r.status === 'paused');
    // 偽造崩潰現場：第一步卡 running、run 卡 running（模擬跑到一半伺服器死掉重啟）
    const store2 = createStore(dataDir);
    const crashed = store2.readRun('範例', 'quarterly-report', started.json.run_id);
    crashed.status = 'running';
    crashed.steps['fetch-data'] = { ...crashed.steps['fetch-data'], status: 'running', output: null };
    crashed.steps.organize = { ...crashed.steps.organize, status: 'pending', output: null };
    store2.writeRun('範例', 'quarterly-report', started.json.run_id, crashed);
    const callsBefore = adapter.calls.filter((c) => c.nodeId === 'fetch-data').length;
    // 查看狀態（UI 每秒都在做的事）應觸發自動接回
    await api(base, 'GET', runPath);
    const healed = await pollRun(base, runPath, (r) => r.status === 'paused' && r.steps.organize.status === 'waiting_review');
    assert.equal(healed.steps['fetch-data'].status, 'done', '卡住的步驟要被重新執行到完成');
    assert.equal(adapter.calls.filter((c) => c.nodeId === 'fetch-data').length, callsBefore + 1, 'fetch-data 要真的重跑一次');
  } finally {
    await app.stop();
  }
});

test('server：run 清單列出進行中的跑，附狀態與開跑時間', async () => {
  const { app, base } = await startApp();
  try {
    const wfPath = `/api/workflows/${encodeURIComponent('範例')}/quarterly-report`;
    assert.deepEqual((await api(base, 'GET', `${wfPath}/runs`)).json, []);
    const started = await api(base, 'POST', `${wfPath}/runs`, {});
    await pollRun(base, `${wfPath}/runs/${started.json.run_id}`, (r) => r.status === 'paused');
    const list = (await api(base, 'GET', `${wfPath}/runs`)).json;
    assert.equal(list.length, 1);
    assert.equal(list[0].run_id, started.json.run_id);
    assert.equal(list[0].status, 'paused');
    assert.ok(list[0].started_at);
  } finally {
    await app.stop();
  }
});

test('server：compose 端點回覆＋草稿；連兩次壞 → 400 人話', async () => {
  const { app, base, adapter } = await startApp();
  try {
    const def = { format: 1, name: '訂餐廳', params: [], nodes: [{ id: 'a', title: '找店', executor: 'ai', stop_point: 'always', instruction: '列三家', next: [] }] };
    adapter.setCompleteResponses([`拆好了\n\`\`\`yaml\n${JSON.stringify(def)}\n\`\`\``]);
    // ⑧：沒帶 phase＝第一趟（出格子），舊測改成明帶 phase:'draft' 續綠
    const res = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '訂餐廳' }], phase: 'draft' });
    assert.equal(res.status, 200);
    assert.equal(res.json.draft.name, '訂餐廳');
    assert.ok(res.json.reply.includes('拆好了'));
    adapter.setCompleteResponses(['亂七八糟']);
    const bad = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '拆' }], phase: 'draft' });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.error.includes('換個說法'));
  } finally {
    await app.stop();
  }
});

// —— /api/compose 兩趟——
const B4_DEF = { format: 1, name: '週報', params: [], nodes: [{ id: 'a', title: '查新聞', executor: 'ai', stop_point: 'always', instruction: '查近 7 天', next: [] }] };
const B4_SHAPE_REPLY = '先猜是週報\n```json\n{"shape":{"deliverable":{"value":"週報","basis":"你說的"},"type":{"value":"文章","basis":"預設"}},"sources":[{"name":"本週新聞","from":"web","note":"近 7 天"}],"category":"旅遊"}\n```';
const B4_DRAFT_REPLY = `落地了\n\`\`\`yaml\n${JSON.stringify(B4_DEF)}\n\`\`\``;
const composeCalls = (adapter) => adapter.completes.filter((c) => c.meta?.kind === 'compose');

test('B4 ①：POST /api/compose {messages}（無 phase、無 draft）→第一趟：宿主收到「第一趟」prompt、回 phase shape 含 shape／sources／category、無 draft、不記路', async () => {
  const { app, base, adapter } = await startApp();
  try {
    await api(base, 'POST', '/api/categories', { name: '旅遊' });
    adapter.setCompleteResponses([B4_SHAPE_REPLY]);
    const res = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '每週整理新聞' }] });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.phase, 'shape');
    assert.equal(res.json.reply, '先猜是週報');
    assert.equal(res.json.shape.deliverable.value, '週報');
    assert.deepEqual(res.json.shape.range, { value: '', basis: '預設' }, '缺格補齊');
    assert.deepEqual(res.json.sources, [{ name: '本週新聞', from: 'web', note: '近 7 天' }]);
    assert.equal(res.json.category, '旅遊');
    assert.equal('draft' in res.json, false);
    assert.equal('memory_notice' in res.json, false, '第一趟不記路');
    const calls = composeCalls(adapter);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].meta.phase, 'shape');
    assert.ok(calls[0].prompt.includes('# 這一趟\n第一趟：定成品。'));
    assert.ok(!calls[0].prompt.includes('\n# 已確認的成品格子\n'), '規矩 13 條文提到那段名字，只驗段標題行不在');
    assert.ok(!adapter.completes.some((c) => c.meta?.kind === 'memory'), 'memory.onChat 第一趟不叫');
    // 拆解器建議的分類不存在→null
    adapter.setCompleteResponses([B4_SHAPE_REPLY.replace('"category":"旅遊"', '"category":"火星"')]);
    const r2 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '每週整理新聞' }] });
    assert.equal(r2.json.category, null);
    // 「未分類」合法
    adapter.setCompleteResponses([B4_SHAPE_REPLY.replace('"category":"旅遊"', '"category":"未分類"')]);
    const r3 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '每週整理新聞' }] });
    assert.equal(r3.json.category, '未分類');
  } finally {
    await app.stop();
  }
});

test('B4 ②：第二趟 {phase:draft, shape, sources, category:旅遊}→draft.category 覆寫、phase draft、memory_notice 有鍵；category 不存在→draft.category 無', async () => {
  const { app, base, adapter } = await startApp();
  try {
    await api(base, 'POST', '/api/categories', { name: '旅遊' });
    adapter.setCompleteResponses([B4_DRAFT_REPLY]);
    const shape = { deliverable: { value: '週報', basis: '你說的' } };
    const sources = [{ name: '本週新聞', from: 'web', note: '近 7 天' }];
    const res = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '每週整理新聞' }], phase: 'draft', shape, sources, category: '旅遊' });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.phase, 'draft');
    assert.equal(res.json.draft.category, '旅遊');
    assert.equal(res.json.draft.name, '週報');
    assert.equal(res.json.reply, '落地了');
    assert.ok('memory_notice' in res.json);
    const calls = composeCalls(adapter);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].meta.phase, 'draft');
    assert.ok(calls[0].prompt.includes('# 已確認的成品格子\n- 成品：週報（你說的）'));
    assert.ok(calls[0].prompt.includes('# 資料來源\n- 本週新聞：AI 上網查（近 7 天）'));
    assert.ok(calls[0].prompt.includes('- 分類：旅遊'));
    assert.ok(adapter.completes.some((c) => c.meta?.kind === 'memory'), 'memory.onChat 第二趟才叫');
    // 拆解器自己在 yaml 寫了 category（亂寫）——body 分類不合法→鍵刪掉（不漏 AI 髒值、也不寫 null，validateWorkflow 對 null 會報「要是文字」）；合法→蓋成 body 的
    const DIRTY_REPLY = `落地了\n\`\`\`yaml\n${JSON.stringify({ ...B4_DEF, category: '亂寫' })}\n\`\`\``;
    adapter.setCompleteResponses([DIRTY_REPLY]);
    const bad = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '每週整理新聞' }], phase: 'draft', shape, sources, category: '不存在' });
    assert.equal(bad.status, 200);
    assert.equal('category' in bad.json.draft, false, '不合法的分類→AI 自寫的也不採，鍵刪掉');
    adapter.setCompleteResponses([DIRTY_REPLY]);
    const over = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '每週整理新聞' }], phase: 'draft', shape, sources, category: '旅遊' });
    assert.equal(over.json.draft.category, '旅遊', 'AI 寫錯也不採，蓋成 body 的');
    // 對話修改（current_draft 帶已存在的分類、body 沒帶）：退到 current_draft 驗過的分類，不吃 AI 亂寫
    adapter.setCompleteResponses([DIRTY_REPLY]);
    const edit = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '改一下' }], current_draft: { ...B4_DEF, category: '旅遊' } });
    assert.equal(edit.json.draft.category, '旅遊', '對話修改沿用 current_draft 的分類');
    adapter.setCompleteResponses([DIRTY_REPLY]);
    const editNone = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '改一下' }], current_draft: B4_DEF });
    assert.equal('category' in editNone.json.draft, false, '草稿沒分類、body 沒帶→鍵刪掉');
    // 「未分類」合法
    adapter.setCompleteResponses([B4_DRAFT_REPLY]);
    const un = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '每週整理新聞' }], phase: 'draft', shape, sources, category: '未分類' });
    assert.equal(un.json.draft.category, '未分類');
  } finally {
    await app.stop();
  }
});

test('B4 ③：PUT settings compose.confirm_shape=false→POST {messages} 一次回 draft＋shape＋auto:true；宿主叫兩次；卷宗 -shape／-draft 各一對', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    await api(base, 'POST', '/api/categories', { name: '旅遊' });
    const put = await api(base, 'PUT', '/api/settings', { compose: { confirm_shape: false } });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(put.json.compose.confirm_shape, false);
    adapter.setCompleteResponses([B4_SHAPE_REPLY, B4_DRAFT_REPLY]);
    const res = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '每週整理新聞' }] });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.phase, 'draft');
    assert.equal(res.json.auto, true);
    assert.equal(res.json.draft.name, '週報');
    assert.equal(res.json.draft.category, '旅遊', '第一趟建議的分類進第二趟');
    assert.equal(res.json.shape.deliverable.value, '週報');
    assert.equal(res.json.sources[0].from, 'web');
    assert.ok('memory_notice' in res.json);
    const calls = composeCalls(adapter);
    assert.deepEqual(calls.map((c) => c.meta.phase), ['shape', 'draft']);
    assert.ok(calls[1].prompt.includes('# 已確認的成品格子\n- 成品：週報（你說的）'), '第二趟用第一趟結果');
    const logs = fs.readdirSync(path.join(dataDir, 'logs', 'compose')).sort();
    assert.equal(logs.length, 4, logs.join(','));
    assert.equal(logs.filter((f) => /-shape\.txt$/.test(f)).length, 1);
    assert.equal(logs.filter((f) => /-shape\.reply\.txt$/.test(f)).length, 1);
    assert.equal(logs.filter((f) => /-draft\.txt$/.test(f)).length, 1);
    assert.equal(logs.filter((f) => /-draft\.reply\.txt$/.test(f)).length, 1);
    // 明帶 phase:'shape' 時開關不管用（前端「重擬」）：只跑第一趟
    adapter.setCompleteResponses([B4_SHAPE_REPLY]);
    const re = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '每週整理新聞' }], phase: 'shape' });
    assert.equal(re.json.phase, 'shape');
    assert.equal('draft' in re.json, false);
    assert.equal(composeCalls(adapter).length, 3);
  } finally {
    await app.stop();
  }
});

test('B4 ④：{current_draft} 無 phase→直接第二趟：宿主一次、prompt 含「# 現有草稿」不含「已確認的成品格子」、meta.phase draft', async () => {
  const { app, base, adapter } = await startApp();
  try {
    adapter.setCompleteResponses([B4_DRAFT_REPLY]);
    const res = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '第一步改成查三天' }], current_draft: B4_DEF });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.phase, 'draft');
    assert.equal(res.json.draft.name, '週報');
    assert.equal('auto' in res.json, false);
    const calls = composeCalls(adapter);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].meta.phase, 'draft');
    assert.ok(calls[0].prompt.includes('# 現有草稿'));
    assert.ok(!calls[0].prompt.includes('\n# 已確認的成品格子\n'), '規矩 13 條文提到那段名字，只驗段標題行不在');
  } finally {
    await app.stop();
  }
});

test('B4 ⑤：GET /api/settings 舊檔（沒 compose）回 compose.confirm_shape:true；PUT {compose:{confirm_shape:"x"}} 400 人話', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, memory: { paused: false } }), 'utf8');
    const got = (await api(base, 'GET', '/api/settings')).json;
    assert.deepEqual(got.compose, { confirm_shape: true });
    const bad = await api(base, 'PUT', '/api/settings', { compose: { confirm_shape: 'x' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.error.includes('拆之前先確認成品長相要是開或關'), bad.json.error);
    assert.equal((await api(base, 'GET', '/api/settings')).json.compose.confirm_shape, true, '錯的不落地');
  } finally {
    await app.stop();
  }
});

test('B4 ⑦：usage.jsonl 兩趟各一行 kind compose、phase 各異', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    adapter.enableUsage();
    await api(base, 'POST', '/api/categories', { name: '旅遊' });
    adapter.setCompleteResponses([B4_SHAPE_REPLY]);
    const first = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '每週整理新聞' }] });
    assert.equal(first.status, 200);
    adapter.setCompleteResponses([B4_DRAFT_REPLY]);
    const second = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '每週整理新聞' }], phase: 'draft', shape: first.json.shape, sources: first.json.sources, category: first.json.category });
    assert.equal(second.status, 200);
    const rows = fs.readFileSync(path.join(dataDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((u) => u.kind === 'compose');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((u) => u.phase), ['shape', 'draft']);
  } finally {
    await app.stop();
  }
});

test('server：存新流程（自動配 id）、改定義（壞的擋下）、新增分類、搬移', async () => {
  const { app, base } = await startApp();
  try {
    const def = { format: 1, name: '訂餐廳', params: [], nodes: [{ id: 'a', title: '找店', executor: 'ai', stop_point: 'always', instruction: '列三家', next: [] }] };
    // 建
    const created = await api(base, 'POST', '/api/workflows', { category: '生活', def });
    assert.equal(created.status, 200);
    const { category, id } = created.json;
    assert.equal(category, '生活');
    const got = await api(base, 'GET', `/api/workflows/${encodeURIComponent(category)}/${encodeURIComponent(id)}`);
    assert.equal(got.json.name, '訂餐廳');
    // 改定義：壞的擋下、好的存入
    const badPut = await api(base, 'PUT', `/api/workflows/${encodeURIComponent(category)}/${encodeURIComponent(id)}`, { def: { ...def, nodes: [] } });
    assert.equal(badPut.status, 400);
    def.params = [{ key: 'people', label: '人數', default: '8 人' }];
    const okPut = await api(base, 'PUT', `/api/workflows/${encodeURIComponent(category)}/${encodeURIComponent(id)}`, { def });
    assert.equal(okPut.status, 200);
    // 分類
    assert.equal((await api(base, 'POST', '/api/categories', { name: '行銷' })).status, 200);
    assert.equal((await api(base, 'POST', '/api/categories', { name: '壞/名' })).status, 400);
    const cats = (await api(base, 'GET', '/api/categories')).json;
    assert.ok(cats.includes('行銷') && cats.includes('生活'));
    // 搬移
    const moved = await api(base, 'POST', `/api/workflows/${encodeURIComponent(category)}/${encodeURIComponent(id)}/move`, { to: '行銷' });
    assert.equal(moved.status, 200);
    assert.equal((await api(base, 'GET', `/api/workflows/${encodeURIComponent('行銷')}/${encodeURIComponent(id)}`)).json.name, '訂餐廳');
  } finally {
    await app.stop();
  }
});

test('server：分岔判不出→choose-branch 選路續跑到完成；非等待選路時 400', async () => {
  const { app, base, adapter } = await startApp();
  try {
    const { DAG_DEF } = await import('./fixtures.js');
    adapter.setCompleteResponses(['這要看情況耶']);
    const created = await api(base, 'POST', '/api/workflows', { category: '測試', def: DAG_DEF });
    const wfP = `/api/workflows/${encodeURIComponent('測試')}/${created.json.id}`;
    const started = await api(base, 'POST', `${wfP}/runs`, {});
    const runPath = `${wfP}/runs/${started.json.run_id}`;
    let run = await pollRun(base, runPath, (r) => r.status === 'paused');
    assert.equal(run.steps['amount-check'].status, 'waiting_branch');
    const early = await api(base, 'POST', `${runPath}/choose-branch`, { node: 'fill', target: 'merge' });
    assert.equal(early.status, 400);
    await api(base, 'POST', `${runPath}/choose-branch`, { node: 'amount-check', target: 'merge' });
    run = await pollRun(base, runPath, (r) => r.status === 'done');
    assert.equal(run.steps['amount-check'].choice_by, 'user');
    assert.equal(run.steps['boss-sign'].status, 'skipped');
  } finally {
    await app.stop();
  }
});

test('server：run 完成自動出參數提議→接受改預設＋版本+1→退回；拒 2 次靜音', async () => {
  const { app, base } = await startApp();
  try {
    const wfP = `/api/workflows/${encodeURIComponent('範例')}/quarterly-report`;
    // 連兩次覆寫同參數並跑完（fake adapter 秒跑；停點逐一放行）
    for (let i = 0; i < 2; i++) {
      const started = await api(base, 'POST', `${wfP}/runs`, { overrides: { script_length: '5 分鐘' } });
      const runPath = `${wfP}/runs/${started.json.run_id}`;
      for (;;) {
        const r = (await api(base, 'GET', runPath)).json;
        if (r.status === 'done') break;
        if (r.status === 'paused') {
          const [nid, st] = Object.entries(r.steps).find(([, v]) => v.status.startsWith('waiting')) ?? [];
          if (st?.status === 'waiting_review') await api(base, 'POST', `${runPath}/approve`, { node: nid });
          else if (st?.status === 'waiting_human') await api(base, 'POST', `${runPath}/human-done`, { node: nid });
        }
        await new Promise((r2) => setTimeout(r2, 15));
      }
    }
    // run done 觸發背景分析 → 輪詢提議
    let props;
    for (let i = 0; i < 100; i++) {
      props = (await api(base, 'GET', `${wfP}/proposals`)).json;
      if (props.pending.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(props.pending.length, 1);
    const p = props.pending[0];
    assert.equal(p.kind, 'param_default');
    // 接受 → 預設值變＋版本+1
    const acc = await api(base, 'POST', `/api/proposals/${p.id}/accept`, {});
    assert.equal(acc.status, 200);
    const def = (await api(base, 'GET', wfP)).json;
    assert.equal(def.params.find((x) => x.key === 'script_length').default, '5 分鐘');
    const versions = (await api(base, 'GET', `${wfP}/versions`)).json;
    assert.equal(versions.at(-1).version, 2);
    // 退回 v1
    await api(base, 'POST', `${wfP}/rollback`, { version: 1 });
    const def2 = (await api(base, 'GET', wfP)).json;
    assert.equal(def2.params.find((x) => x.key === 'script_length').default, '3 分鐘');
    assert.equal((await api(base, 'GET', `${wfP}/versions`)).json.length, 3);
  } finally {
    await app.stop();
  }
});

test('server：事後回饋端點→轉提議；reject 兩次→靜音', async () => {
  const { app, base, adapter } = await startApp();
  try {
    const wfP = `/api/workflows/${encodeURIComponent('範例')}/quarterly-report`;
    const started = await api(base, 'POST', `${wfP}/runs`, {});
    const runPath = `${wfP}/runs/${started.json.run_id}`;
    await pollRun(base, runPath, (r) => r.status === 'paused');
    adapter.setCompleteResponses(['了解\n```yaml\nnode_id: organize\nsummary: 數據太細，先聚合？\nnew_instruction: 整理時只列月彙總\n```']);
    const fb = await api(base, 'POST', `${runPath}/run-feedback`, { text: '主管說數據太細' });
    assert.equal(fb.status, 200);
    let props;
    for (let i = 0; i < 100; i++) {
      props = (await api(base, 'GET', `${wfP}/proposals`)).json;
      if (props.pending.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const p = props.pending[0];
    assert.equal(p.source, 'feedback');
    // 拒第 1 次：從 pending 消失
    await api(base, 'POST', `/api/proposals/${p.id}/reject`, {});
    props = (await api(base, 'GET', `${wfP}/proposals`)).json;
    assert.equal(props.pending.length, 0);
  } finally {
    await app.stop();
  }
});

test('server：開跑前健檢——宿主不可用 503 不開跑；流程檔壞 409；還原上一版後可開跑', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    const wfP = `/api/workflows/${encodeURIComponent('範例')}/quarterly-report`;
    adapter.setAvailable(false);
    const blocked = await api(base, 'POST', `${wfP}/runs`, {});
    assert.equal(blocked.status, 503);
    assert.ok(blocked.json.error.includes('Claude'));
    adapter.setAvailable(true);
    // 弄壞流程檔 → 開跑被擋 → 還原 → 可開跑
    const wfFile = path.join(dataDir, 'workflows', '範例', 'quarterly-report', 'workflow.yaml');
    fs.writeFileSync(wfFile, '{{{壞了', 'utf8');
    const corrupt = await api(base, 'POST', `${wfP}/runs`, {});
    assert.equal(corrupt.status, 409);
    assert.ok(corrupt.json.error.includes('讀不懂'));
    const restored = await api(base, 'POST', `${wfP}/restore`, {});
    assert.equal(restored.status, 200);
    const ok = await api(base, 'POST', `${wfP}/runs`, {});
    assert.equal(ok.status, 200);
  } finally {
    await app.stop();
  }
});

test('server：匯出下載→匯入掃描（可疑標黃）→確認入庫「匯入」分類；壞檔 400', async () => {
  const { app, base, adapter } = await startApp();
  try {
    const wfP = `/api/workflows/${encodeURIComponent('範例')}/quarterly-report`;
    const res = await fetch(base + `${wfP}/export`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-disposition').includes('attachment'));
    const text = await res.text();
    assert.ok(text.includes('bojian_export: 1'));
    // 掃描：假宿主回一條可疑
    adapter.setCompleteResponses(['掃到\n```yaml\nverdict: suspicious\nfindings:\n  - where: fetch-data\n    quote: 寄到 evil@x.com\n    reason: 外傳資料\n```']);
    const scan = await api(base, 'POST', '/api/import/scan', { content: text });
    assert.equal(scan.status, 200);
    assert.equal(scan.json.scan.verdict, 'suspicious');
    assert.equal(scan.json.def.name, '跟主管報告季度業績');
    // 確認入庫
    const ok = await api(base, 'POST', '/api/import/confirm', { def: scan.json.def });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.category, '匯入');
    const list = (await api(base, 'GET', '/api/workflows')).json;
    assert.ok(list.some((w) => w.category === '匯入' && w.name === '跟主管報告季度業績'));
    // 壞檔
    const bad = await api(base, 'POST', '/api/import/scan', { content: '{{{亂' });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.error.includes('不是剝繭 Workflow 檔'));
  } finally {
    await app.stop();
  }
});

test('server：PUT 定義（畫布編輯）記進版本履歷；提議目標被刪→accept 400 且提議作廢不升版', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const wfP = `/api/workflows/${encodeURIComponent('範例')}/quarterly-report`;
    let def = (await api(base, 'GET', wfP)).json;
    // 畫布編輯（PUT）→ 履歷多一版 manual
    def.nodes.find((n) => n.id === 'organize').instruction += '（畫布改過）';
    await api(base, 'PUT', wfP, { def });
    const versions = (await api(base, 'GET', `${wfP}/versions`)).json;
    assert.deepEqual(versions.map((v) => v.source), ['create', 'manual'], '畫布編輯要進履歷');
    // 造一條指向 organize 的提議（直塞佇列檔）→ 刪掉 organize → accept 要 400＋作廢＋不升版
    createStore(dataDir).writeProposals([{
      id: 'p-test-1', key: 'instr:organize:v2', kind: 'node_instruction', source: 'edits',
      evidence: '測試', change: { node_id: 'organize', node_title: '整理歸納', new_instruction: '新指示' },
      workflow: { category: '範例', id: 'quarterly-report' }, status: 'pending', reject_count: 0,
    }]);
    // 刪掉 organize（改接 fetch-data → analyze）
    def = (await api(base, 'GET', wfP)).json;
    def.nodes.find((n) => n.id === 'fetch-data').next = ['analyze'];
    def.nodes = def.nodes.filter((n) => n.id !== 'organize');
    await api(base, 'PUT', wfP, { def });
    const before = (await api(base, 'GET', `${wfP}/versions`)).json.length;
    const acc = await api(base, 'POST', '/api/proposals/p-test-1/accept', {});
    assert.equal(acc.status, 400);
    assert.ok(acc.json.error.includes('已經不在') && acc.json.error.includes('（Workflow 後來改過）'), `要人話：${JSON.stringify(acc.json)}`);
    assert.equal((await api(base, 'GET', `${wfP}/versions`)).json.length, before, '失敗不准升版');
    assert.deepEqual((await api(base, 'GET', `${wfP}/proposals`)).json.pending, [], '作廢的提議不再出現');
  } finally {
    await app.stop();
  }
});

test('server：health 回報宿主狀態；不存在的流程 404 且訊息人話', async () => {
  const { app, base } = await startApp();
  try {
    const health = await api(base, 'GET', '/api/health');
    assert.deepEqual(health.json, { claude: true });
    const miss = await api(base, 'GET', `/api/workflows/${encodeURIComponent('範例')}/沒這個`);
    assert.equal(miss.status, 404);
    assert.ok(miss.json.error.includes('找不到'));
  } finally {
    await app.stop();
  }
});

test('D19 常用預設庫：存→列→刪 全鏈；空內容擋下', async () => {
  const { app, base } = await startApp();
  try {
    const bad = await api(base, 'POST', '/api/presets', { field: 'role_context', name: '空的', text: ' ' });
    assert.equal(bad.status, 400);
    await api(base, 'POST', '/api/presets', { field: 'role_context', name: '資深客服主管', text: '你是資深客服主管' });
    let all = (await api(base, 'GET', '/api/presets')).json;
    assert.deepEqual(all.role_context, [{ name: '資深客服主管', text: '你是資深客服主管' }]);
    await api(base, 'DELETE', `/api/presets/role_context/${encodeURIComponent('資深客服主管')}`);
    all = (await api(base, 'GET', '/api/presets')).json;
    assert.deepEqual(all.role_context ?? [], []);
  } finally {
    await app.stop();
  }
});

test('D19 參考檔：上傳→列→刪；壞檔名擋下', async () => {
  const { app, base } = await startApp();
  try {
    const def = { format: 1, name: '訂餐廳', params: [], nodes: [{ id: 'a', title: '找店', executor: 'ai', stop_point: 'never', instruction: '列三家', next: [] }] };
    const { id } = (await api(base, 'POST', '/api/workflows', { category: '測試', def })).json;
    const wfP = `/api/workflows/${encodeURIComponent('測試')}/${id}`;
    const b64 = Buffer.from('品牌語彙：藍白、圓角', 'utf8').toString('base64');
    const up = await api(base, 'POST', `${wfP}/files`, { name: '品牌手冊.txt', content_b64: b64 });
    assert.deepEqual(up.json.files, ['品牌手冊.txt']);
    const evil = await api(base, 'POST', `${wfP}/files`, { name: '../外面.txt', content_b64: b64 });
    assert.equal(evil.status, 400);
    const del = await api(base, 'DELETE', `${wfP}/files/${encodeURIComponent('品牌手冊.txt')}`);
    assert.deepEqual(del.json.files, []);
  } finally {
    await app.stop();
  }
});

test('D19 產出物：開跑後步驟存檔、清單列得到、可下載且內容正確', async () => {
  const { app, base, adapter } = await startApp();
  try {
    const def = { format: 1, name: '出檔', params: [], nodes: [{ id: 'a', title: '整理清單', executor: 'ai', stop_point: 'never', instruction: '整理', output_file: 'md', next: [] }] };
    const { id } = (await api(base, 'POST', '/api/workflows', { category: '測試', def })).json;
    const wfP = `/api/workflows/${encodeURIComponent('測試')}/${id}`;
    const run = (await api(base, 'POST', `${wfP}/runs`, { overrides: {} })).json;
    await new Promise((r) => setTimeout(r, 300)); // 假 adapter 立即回，等 kick 跑完
    const files = (await api(base, 'GET', `${wfP}/runs/${run.run_id}/files`)).json;
    assert.deepEqual(files, ['整理清單.md']);
    const dl = await fetch(`${base}${wfP}/runs/${run.run_id}/files/${encodeURIComponent('整理清單.md')}`);
    assert.equal(await dl.text(), '產出:a');
    void adapter;
  } finally {
    await app.stop();
  }
});

test('健檢 P2-05：拼錯路徑／用錯方法不准回 200', async () => {
  const { app, base } = await startApp();
  try {
    const cases = [
      ['POST', '/api/health'],
      ['GET', '/api/health/ghost'],
      ['GET', '/api/categories/ghost'],
      ['DELETE', '/api/workflows'],
      ['POST', `/api/workflows/${encodeURIComponent('範例')}/ghost-id`],
      ['GET', '/api/presets/ghost'],
      ['PUT', '/api/todos'],
      ['GET', '/api/calendar/refresh/extra'],
    ];
    for (const [method, p] of cases) {
      const { status } = await api(base, method, p, method === 'GET' ? undefined : {});
      assert.equal(status, 404, `${method} ${p} 應回 404，實得 ${status}`);
    }
  } finally { await app.stop(); }
});

test('健檢 P2-01/P2-02（HTTP 層）：分類跳脫 400 不落地；排程建立與更新的非法值 400 不落檔', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const def = {
      format: 1, name: '測試', params: [],
      nodes: [{ id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做', next: [] }],
    };
    const esc1 = await api(base, 'POST', '/api/workflows', { category: '../orphan', def });
    assert.equal(esc1.status, 400);
    assert.ok(!fs.existsSync(path.join(dataDir, 'orphan')), '跳脫目錄不得出現');
    const okWf = await api(base, 'POST', '/api/workflows', { category: '測試', def });
    assert.equal(okWf.status, 200);
    const wfid = `測試/${okWf.json.id}`;
    // 建立：非法時間擋下
    const badPost = await api(base, 'POST', '/api/schedules', { workflow_id: wfid, freq: 'daily', time: '99:99' });
    assert.equal(badPost.status, 400);
    // 建立合法 → 更新塞爛值全擋、原值不動
    const { json: sched } = await api(base, 'POST', '/api/schedules', { workflow_id: wfid, freq: 'weekly', weekday: 1, time: '08:00' });
    for (const patch of [{ freq: 'not-a-frequency' }, { time: '99:99' }, { remind_leads: ['bogus'] }, { weekday: 0 }]) {
      const r = await api(base, 'PUT', `/api/schedules/${sched.id}`, patch);
      assert.equal(r.status, 400, `${JSON.stringify(patch)} 應 400`);
    }
    const back = (await api(base, 'GET', '/api/schedules')).json.find((s) => s.id === sched.id);
    assert.equal(back.freq, 'weekly');
    assert.equal(back.time, '08:00');
    // 單次覆寫：occ／to 要是看得懂的時刻
    const badOcc = await api(base, 'POST', `/api/schedules/${sched.id}/occurrence`, { occ: '亂寫', action: 'skip' });
    assert.equal(badOcc.status, 400);
    const badTo = await api(base, 'POST', `/api/schedules/${sched.id}/occurrence`, { occ: '2026-08-31T08:00', action: 'move', to: '亂寫' });
    assert.equal(badTo.status, 400);
  } finally { await app.stop(); }
});

// ===== /api/dashboard＋卷宗端點 =====

test('儀表板：最近執行卡（終點成品／步數／用量歸戶）＋帳本窗口＋卷宗可列可讀', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1,
      name: '儀表板測試',
      params: [],
      nodes: [
        { id: 'a', title: '起步', executor: 'ai', stop_point: 'never', instruction: '做A', next: ['b'] },
        { id: 'b', title: '收尾步', executor: 'ai', stop_point: 'never', instruction: '做B', next: [] },
      ],
    };
    store.writeWorkflow('測試', 'dash-wf', def);
    const rid = 'r-20260901-120000-test';
    store.writeRun('測試', 'dash-wf', rid, {
      run_id: rid, workflow: { category: '測試', id: 'dash-wf', name: '儀表板測試' }, def,
      status: 'done', source: 'manual', started_at: '2026-09-01T12:00:00.000Z', finished_at: '2026-09-01T12:05:00.000Z',
      steps: { a: { status: 'done', output: 'A產出' }, b: { status: 'done', output: 'B成品全文' } },
    });
    const nowIso = new Date().toISOString();
    store.appendUsage({ at: nowIso, kind: 'step', category: '測試', workflow: 'dash-wf', run: rid, node: 'a', input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, cost_usd: 0.01 });
    store.appendUsage({ at: nowIso, kind: 'compose', input_tokens: 7, output_tokens: 3, cost_usd: 0.001 });
    store.writePromptRecord('測試', 'dash-wf', rid, 'a.txt', '卷宗全文A');

    const dash = (await api(base, 'GET', '/api/dashboard?limit=5&days=30')).json;
    const card = dash.recent.find((r) => r.run_id === rid);
    assert.ok(card, '最近執行要含這筆 run');
    assert.equal(card.status, 'done');
    assert.equal(card.name, '儀表板測試');
    assert.equal(card.finals.length, 1, '只有沒出線的終點步算成品');
    assert.equal(card.finals[0].title, '收尾步');
    assert.equal(card.finals[0].preview, 'B成品全文');
    assert.deepEqual(card.steps, { total: 2, done: 2, failed: 0 });
    assert.equal(card.usage.input, 115, 'run 用量=輸入+快取建立+快取讀取');
    assert.equal(card.usage.output, 50);
    assert.ok(dash.usage.some((u) => u.kind === 'compose'), '帳本含非執行類呼叫');

    const wfp = `/api/workflows/${encodeURIComponent('測試')}/dash-wf/runs/${rid}`;
    assert.deepEqual((await api(base, 'GET', `${wfp}/prompts`)).json, ['a.txt']);
    assert.equal((await api(base, 'GET', `${wfp}/prompts/a.txt`)).json.text, '卷宗全文A');
    const missing = await api(base, 'GET', `${wfp}/prompts/z.txt`);
    assert.equal(missing.status, 404, '舊紀錄沒卷宗要回 404 人話');
  } finally {
    await app.stop();
  }
});

test('DELETE /runs/:rid：沒跑完的執行整筆刪、清單消失；再刪回 404', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1,
      name: '刪執行測試',
      params: [],
      nodes: [{ id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做A', next: [] }],
    };
    store.writeWorkflow('測試', 'del-wf', def);
    store.writeRun('測試', 'del-wf', 'r-x', { run_id: 'r-x', status: 'paused', def, steps: {} });
    const p = `/api/workflows/${encodeURIComponent('測試')}/del-wf/runs/r-x`;
    assert.equal((await api(base, 'DELETE', p)).status, 200);
    assert.deepEqual((await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/del-wf/runs`)).json, []);
    assert.equal((await api(base, 'DELETE', p)).status, 404);
  } finally {
    await app.stop();
  }
});

// ---- 健檢端點、開跑擋門、人做交出內容、補資料、儀表板成品回退 ----
const MAIL_DEF = () => ({
  format: 1,
  name: '來信處理',
  params: [{ key: 'incoming_email', label: '來信全文', default: '（貼信）' }],
  nodes: [
    { id: 'paste', title: '貼上來信', executor: 'human', stop_point: 'always', instruction: '把信貼進來 {{incoming_email}}', next: ['classify'] },
    { id: 'classify', title: '判斷類型', executor: 'ai', stop_point: 'never', instruction: '讀取上一步貼上的來信全文，判斷類型', next: [] },
  ],
});

test('資料通道輪：POST /api/preflight 回 issues/inputs/unused_params；POST /runs 有 block → 409 附 issues；修好後放行且人做交出內容傳下去', async () => {
  const { app, base, dataDir, adapter } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = MAIL_DEF();
    const pf = await api(base, 'POST', '/api/preflight', { def });
    assert.equal(pf.status, 200);
    assert.ok(pf.json.issues.some((i) => i.level === 'block' && i.code === 'no-input' && i.node === 'classify'));
    assert.equal(pf.json.inputs.src[pf.json.inputs.pred.classify[0]].h, 1); // L14b：不重複的寫法——classify 的來源是人做步驟
    assert.deepEqual(pf.json.unused_params, []);
    const bad = await api(base, 'POST', '/api/preflight', { def: { nope: true } });
    assert.equal(bad.status, 400, '壞定義回 400 人話');

    store.writeWorkflow('測試', 'mail', def);
    const wfp = `/api/workflows/${encodeURIComponent('測試')}/mail`;
    const blocked = await api(base, 'POST', `${wfp}/runs`, {});
    assert.equal(blocked.status, 409);
    assert.ok(blocked.json.error.includes('健檢'));
    assert.equal(blocked.json.issues[0].node, 'classify');
    assert.deepEqual((await api(base, 'GET', `${wfp}/runs`)).json, [], '被擋就不留執行紀錄');

    def.nodes[0].handoff = '來信全文';
    store.writeWorkflow('測試', 'mail', def);
    const ok = await api(base, 'POST', `${wfp}/runs`, {});
    assert.equal(ok.status, 200);
    const runPath = `${wfp}/runs/${ok.json.run_id}`;
    let run = await pollRun(base, runPath, (r) => r.steps.paste.status === 'waiting_human');
    await api(base, 'POST', `${runPath}/human-done`, { node: 'paste', content: '寄件人：林小姐\n主旨：刮傷', feedback: '已貼' });
    run = await pollRun(base, runPath, (r) => r.status === 'done');
    assert.equal(run.steps.paste.output, '寄件人：林小姐\n主旨：刮傷');
    assert.equal(run.steps.paste.feedback, '已貼');
    assert.equal(adapter.calls.find((c) => c.nodeId === 'classify').upstream, '寄件人：林小姐\n主旨：刮傷');
  } finally {
    await app.stop();
  }
});

test('資料通道輪：POST /runs/:rid/data-supply 補資料重跑（空內容 400）；儀表板成品在終點是人做步驟時回退到最後 AI 產出', async () => {
  const { app, base, dataDir, adapter } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = MAIL_DEF();
    def.nodes[0].handoff = '來信全文';
    store.writeWorkflow('測試', 'mail2', def);
    const mk = (s) => ({ status: s, output: null, edited_output: null, edit_note: null, feedback: null, error: null, choice: null, choice_by: null, choice_label: null, supplied_input: null, data_diagnosis: null });
    store.writeRun('測試', 'mail2', 'r-d', {
      run_id: 'r-d', workflow: { category: '測試', id: 'mail2', name: def.name }, def, status: 'paused', source: 'manual', params: { incoming_email: 'x' },
      started_at: new Date().toISOString(), finished_at: null,
      steps: { paste: { ...mk('done'), output: null }, classify: { ...mk('waiting_data'), data_note: '沒有信' } },
    });
    const wfp = `/api/workflows/${encodeURIComponent('測試')}/mail2`;
    const empty = await api(base, 'POST', `${wfp}/runs/r-d/data-supply`, { node: 'classify', text: ' ' });
    assert.equal(empty.status, 400);
    const okr = await api(base, 'POST', `${wfp}/runs/r-d/data-supply`, { node: 'classify', text: '信件全文' });
    assert.equal(okr.status, 200);
    const run = await pollRun(base, `${wfp}/runs/r-d`, (r) => r.status === 'done');
    assert.equal(run.steps.classify.supplied_input, '信件全文');
    assert.equal(adapter.calls.find((c) => c.nodeId === 'classify').upstream, '【你補的資料】\n信件全文');

    // 儀表板成品回退：終點是人做步驟（沒交內容）→ 拿最後一個完成的 AI 步驟
    const def2 = {
      format: 1, name: '成信寄出', params: [],
      nodes: [
        { id: 'write', title: '寫信', executor: 'ai', stop_point: 'never', instruction: '寫', next: ['send'] },
        { id: 'send', title: '你寄出', executor: 'human', stop_point: 'always', instruction: '寄', next: [] },
      ],
    };
    store.writeWorkflow('測試', 'send-wf', def2);
    store.writeRun('測試', 'send-wf', 'r-s', {
      run_id: 'r-s', workflow: { category: '測試', id: 'send-wf', name: def2.name }, def: def2, status: 'done', source: 'manual', params: {},
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      steps: { write: { ...mk('done'), output: '成品信' }, send: { ...mk('done'), feedback: '寄了' } },
    });
    const dash = (await api(base, 'GET', '/api/dashboard')).json;
    const card = dash.recent.find((r) => r.run_id === 'r-s');
    assert.equal(card.finals.length, 1);
    assert.equal(card.finals[0].title, '寫信');
    assert.equal(card.finals[0].preview, '成品信');
  } finally {
    await app.stop();
  }
});

// ---- 預覽端點、排版端點、權限預設 ----
import { Document, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';

test('產檔輪：docx／xlsx／md／csv／pdf 預覽端點各回對的形態；inline 帶正確 content-type；render 跳脫原生 HTML', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = { format: 1, name: '產檔', params: [], nodes: [{ id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做', next: [] }] };
    store.writeWorkflow('測試', 'pv', def);
    const rid = 'r-pv';
    store.writeRun('測試', 'pv', rid, { run_id: rid, workflow: { category: '測試', id: 'pv', name: def.name }, def, status: 'done', params: {}, started_at: new Date().toISOString(), finished_at: null, steps: {} });
    const out = store.runOutDir('測試', 'pv', rid);
    const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('季度報告標題')] })] }] });
    fs.writeFileSync(path.join(out, '報告.docx'), await Packer.toBuffer(doc));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('明細');
    ws.addRow(['品名', '金額']);
    ws.addRow(['杯子', 120]);
    ws.addRow(['合計', { formula: 'SUM(B2:B2)', result: 120 }]);
    ws.addRow(['倍數', { formula: 'B2*2' }]); // 沒算結果的公式格 → 顯示公式本身
    await wb.xlsx.writeFile(path.join(out, '明細.xlsx'));
    fs.writeFileSync(path.join(out, '摘要.md'), '# 標題\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>', 'utf8');
    fs.writeFileSync(path.join(out, '表.csv'), 'x,y\n1,2\n', 'utf8');
    fs.writeFileSync(path.join(out, '文件.pdf'), Buffer.from('%PDF-1.4 fake'));
    const fp = (n, tail) => `/api/workflows/${encodeURIComponent('測試')}/pv/runs/${rid}/files/${encodeURIComponent(n)}/${tail}`;

    const d = (await api(base, 'GET', fp('報告.docx', 'preview'))).json;
    assert.equal(d.kind, 'html');
    assert.ok(d.html.includes('季度報告標題'));
    const x = (await api(base, 'GET', fp('明細.xlsx', 'preview'))).json;
    assert.equal(x.kind, 'sheets');
    assert.equal(x.sheets[0].name, '明細');
    assert.ok(x.sheets[0].html.includes('<td>杯子</td>') && x.sheets[0].html.includes('<td>120</td>'));
    assert.ok(x.sheets[0].html.includes('<td>=B2*2</td>'), '沒算結果的公式格顯示公式');
    assert.ok(!x.sheets[0].html.includes('formula'), '不准把原始物件印出來');
    const m = (await api(base, 'GET', fp('摘要.md', 'preview'))).json;
    assert.equal(m.kind, 'html');
    assert.ok(m.html.includes('<table>') && m.html.includes('<h1>'), 'Markdown 表格與標題有排版');
    assert.ok(!m.html.includes('<script>'), '原生 HTML 要跳脫');
    const c = (await api(base, 'GET', fp('表.csv', 'preview'))).json;
    assert.ok(c.html.includes('<td>x</td>'));
    const p = (await api(base, 'GET', fp('文件.pdf', 'preview'))).json;
    assert.equal(p.kind, 'pdf');
    assert.ok(p.url.endsWith('/inline'));
    const inl = await fetch(base + p.url);
    assert.equal(inl.headers.get('content-type'), 'application/pdf');
    assert.equal(inl.headers.get('content-disposition'), null, '內嵌不帶下載標頭');
    const miss = await api(base, 'GET', fp('沒有.docx', 'preview'));
    assert.equal(miss.status, 404);

    const r = (await api(base, 'POST', '/api/render', { text: '**粗** <b>x</b>\n\n| h |\n|---|\n| v |' })).json;
    assert.ok(r.html.includes('<strong>粗</strong>') && r.html.includes('<table>') && !r.html.includes('<b>x</b>'));
  } finally {
    await app.stop();
  }
});

test('產檔輪：親手存的新流程預設開產檔權限；匯入確認一律關（就算送來的是開）', async () => {
  const { app, base, adapter } = await startApp();
  try {
    const def = { format: 1, name: '自建', params: [], nodes: [{ id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做', next: [] }] };
    const made = (await api(base, 'POST', '/api/workflows', { category: '測試', def })).json;
    const saved = (await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/${made.id}`)).json;
    assert.deepEqual(saved.permissions, { files: true, connectors: true });
    adapter.setCompleteResponses(['沒有可疑指示']);
    const conf = await api(base, 'POST', '/api/import/confirm', { category: '測試', def: { ...def, name: '匯入的', permissions: { files: true } } });
    assert.equal(conf.status, 200);
    const list = (await api(base, 'GET', '/api/workflows')).json;
    const imp = list.find((w) => w.name === '匯入的');
    const impDef = (await api(base, 'GET', `/api/workflows/${encodeURIComponent(imp.category)}/${imp.id}`)).json;
    assert.equal(impDef.permissions.files, false);
  } finally {
    await app.stop();
  }
});

test('交貨查核輪：新建流程不帶 check → 預設開；帶 check 原樣保存', async () => {
  const { app, base } = await startApp();
  try {
    const def = { format: 1, name: '不帶check', params: [], nodes: [{ id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做', next: [] }] };
    const made = (await api(base, 'POST', '/api/workflows', { category: '測試', def })).json;
    const saved = (await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/${made.id}`)).json;
    assert.equal(saved.check.enabled, true);

    const def2 = { ...def, name: '帶check關', check: { enabled: false } };
    const made2 = (await api(base, 'POST', '/api/workflows', { category: '測試', def: def2 })).json;
    const saved2 = (await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/${made2.id}`)).json;
    // 遷移：新建一律補齊子開關「數字對原始資料」（這份沒有必填欄位→關）；enabled 照送來的原樣
    assert.deepEqual(saved2.check, { enabled: false, facts: false });
  } finally {
    await app.stop();
  }
});

test('排程與健檢輪：欄位還是佔位文字／必填空白 → POST /runs 409 param-unfilled；填了就開跑；preflight 帶 values 也查', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: 'IG 月報',
      params: [
        { key: 'post_data', label: '上月貼文數據', default: '（貼上每篇貼文的讚數）' },
        { key: 'notes', label: '備註', default: '', required: true, hint: '老闆交代' },
      ],
      nodes: [{ id: 'pick', title: '挑貼文', executor: 'ai', stop_point: 'never', instruction: '從 {{post_data}} 挑，注意 {{notes}}', next: [] }],
    };
    store.writeWorkflow('測試', 'ig', def);
    const wfp = `/api/workflows/${encodeURIComponent('測試')}/ig`;
    const blocked = await api(base, 'POST', `${wfp}/runs`, { overrides: {} });
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.json.issues.filter((i) => i.level === 'block').map((i) => i.param).sort(), ['notes', 'post_data']);
    const pf = await api(base, 'POST', '/api/preflight', { def, values: { post_data: '真資料', notes: '' } });
    assert.deepEqual(pf.json.issues.filter((i) => i.code === 'param-unfilled').map((i) => i.param), ['notes']);
    const ok = await api(base, 'POST', `${wfp}/runs`, { overrides: { post_data: '9/1 貼文 A 讚 120', notes: '無' } });
    assert.equal(ok.status, 200);
  } finally {
    await app.stop();
  }
});

// ===== 三條路由、edit 先擬規則、待辦、用量彙總 =====

test('交貨查核輪：check-retry／check-accept／edit-rules——狀態不符 400 人話，成功寫回 run', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: '查核路由測試', params: [],
      nodes: [{ id: 'a', title: '步驟A', executor: 'ai', stop_point: 'never', instruction: '做A', next: [] }],
      check: { enabled: false }, // 這條測試只驗路由接線，不需要真的問查核員
    };
    store.writeWorkflow('測試', 'check-routes', def);
    const wfp = `/api/workflows/${encodeURIComponent('測試')}/check-routes`;
    const blocks = [{ kind: 'number-mismatch', claim: '總數 13 件', source: '明細共 14 件', detail: '算式不成立：6+3+4=13' }];
    const mkStep = (status, extra = {}) => ({ status, output: '產出:a', edited_output: null, edit_note: null, check_note: null, ...extra });
    const mkRun = (rid, step) => store.writeRun('測試', 'check-routes', rid, {
      run_id: rid, workflow: { category: '測試', id: 'check-routes', name: def.name }, def,
      status: 'paused', source: 'manual', params: {}, started_at: new Date().toISOString(), finished_at: null,
      steps: { a: step },
    });

    // 狀態不符（不是「查核攔下」）→ 400 人話
    mkRun('r-mismatch', mkStep('waiting_review'));
    const badRetry = await api(base, 'POST', `${wfp}/runs/r-mismatch/check-retry`, { node: 'a', note: '亂改' });
    assert.equal(badRetry.status, 400);
    assert.ok(badRetry.json.error.includes('查核攔下'), badRetry.json.error);
    const badAccept = await api(base, 'POST', `${wfp}/runs/r-mismatch/check-accept`, { node: 'a' });
    assert.equal(badAccept.status, 400);
    assert.ok(badAccept.json.error.includes('查核攔下'), badAccept.json.error);

    // check-retry 成功：check_note 記下（永久紀錄，重跑不會清掉）；重跑到底後多一筆 retry-note attempt、check_note_pending 用過就清
    mkRun('r-retry', mkStep('waiting_check', {
      check: { status: 'blocked', blocks, flags: [], missing: [], items: [], summary: '數字對不上', note: '', attempts: 2 },
      attempts: [{ at: '2026-09-08T00:00:00.000Z', reason: 'first', output: '產出:a', check: { status: 'blocked', blocks, flags: [] } }],
    }));
    const retryRes = await api(base, 'POST', `${wfp}/runs/r-retry/check-retry`, { node: 'a', note: '總數請照明細重算' });
    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.json.steps.a.check_note, '總數請照明細重算');
    assert.notEqual(retryRes.json.steps.a.status, 'waiting_check', '要離開查核攔下狀態');
    const settled = await pollRun(base, `${wfp}/runs/r-retry`, (r) => r.status === 'done');
    assert.equal(settled.steps.a.attempts.length, 2, '重跑多一筆 attempt');
    assert.equal(settled.steps.a.attempts[1].reason, 'retry-note');
    assert.equal(settled.steps.a.check_note_pending, false, '吃過就清');

    // check-accept 成功：直接放行，不再進停點
    mkRun('r-accept', mkStep('waiting_check', {
      check: { status: 'blocked', blocks, flags: [], missing: [], items: [], summary: '數字對不上', note: '', attempts: 2 },
    }));
    const acceptRes = await api(base, 'POST', `${wfp}/runs/r-accept/check-accept`, { node: 'a' });
    assert.equal(acceptRes.status, 200);
    assert.equal(acceptRes.json.steps.a.check.status, 'accepted');
    assert.equal(acceptRes.json.steps.a.status, 'done');

    // edit-rules：整份覆寫（空文字丟掉）；壞格式 400
    mkRun('r-rules', mkStep('done', { edit_rules: [{ text: '舊規則', scope: 'all' }] }));
    const rulesRes = await api(base, 'POST', `${wfp}/runs/r-rules/edit-rules`, {
      node: 'a', rules: [{ text: '金額用千元', scope: 'this-step' }, { text: '  ', scope: 'all' }],
    });
    assert.equal(rulesRes.status, 200);
    assert.deepEqual(rulesRes.json.steps.a.edit_rules, [{ text: '金額用千元', scope: 'this-step' }]);
    const badRules = await api(base, 'POST', `${wfp}/runs/r-rules/edit-rules`, { node: 'a', rules: '不是陣列' });
    assert.equal(badRules.status, 400);
  } finally {
    await app.stop();
  }
});

test('交貨查核輪：edit 路由在回應前已含 deriveEditRules 擬出的規則', async () => {
  const { app, base, adapter } = await startApp();
  try {
    const def = {
      format: 1, name: '擬規則測試', params: [],
      nodes: [{ id: 'a', title: '步驟A', executor: 'ai', stop_point: 'always', instruction: '做A', next: [] }],
      check: { enabled: false },
    };
    const { id } = (await api(base, 'POST', '/api/workflows', { category: '測試', def })).json;
    const wfp = `/api/workflows/${encodeURIComponent('測試')}/${id}`;
    const started = await api(base, 'POST', `${wfp}/runs`, {});
    const runPath = `${wfp}/runs/${started.json.run_id}`;
    await pollRun(base, runPath, (r) => r.steps.a.status === 'waiting_review');
    adapter.setEditRulesResponses([JSON.stringify({ rules: [{ text: '金額一律用千元', scope: 'all' }] })]);
    const editRes = await api(base, 'POST', `${runPath}/edit`, { node: 'a', output: '改過的內容', note: '金額改千元' });
    assert.equal(editRes.status, 200);
    assert.equal(editRes.json.steps.a.edited_output, '改過的內容');
    assert.deepEqual(editRes.json.steps.a.edit_rules, [{ text: '金額一律用千元', scope: 'all' }], 'edit 回應要已經含擬好的規則');
  } finally {
    await app.stop();
  }
});

//：擬規則要 10–60 秒，這段時間 run 不准是 running——否則 UI 每秒的 GET 就會把下游放出去，
// 下游在規則寫進檔案之前開跑＝停點改的東西沒帶到，而且沒有任何錯誤訊息。
test('交貨查核輪：擬規則那段時間 GET run 不會先把下游放出去，規則擬完才續跑', async () => {
  const { app, base, adapter } = await startApp();
  try {
    const def = {
      format: 1, name: '擬規則競態', params: [],
      nodes: [
        { id: 'a', title: '步驟A', executor: 'ai', stop_point: 'always', instruction: '做A', next: ['b'] },
        { id: 'b', title: '步驟B', executor: 'ai', stop_point: 'never', instruction: '做B', next: [] },
      ],
      check: { enabled: false },
    };
    const { id } = (await api(base, 'POST', '/api/workflows', { category: '測試', def })).json;
    const wfp = `/api/workflows/${encodeURIComponent('測試')}/${id}`;
    const started = await api(base, 'POST', `${wfp}/runs`, {});
    const runPath = `${wfp}/runs/${started.json.run_id}`;
    await pollRun(base, runPath, (r) => r.steps.a.status === 'waiting_review');

    adapter.setEditRulesResponses([JSON.stringify({ rules: [{ text: '金額一律用千元', scope: 'all' }] })]);
    adapter.setEditRulesDelay(200);
    const editing = api(base, 'POST', `${runPath}/edit`, { node: 'a', output: '改過的內容', note: '金額改千元' });
    for (let i = 0; i < 5; i++) { // UI 每秒輪詢：擬規則還沒回來時連問五次
      await api(base, 'GET', runPath);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(adapter.calls.filter((c) => c.nodeId === 'b').length, 0, '規則還沒擬好，下游不准開跑');

    const editRes = await editing;
    assert.equal(editRes.status, 200);
    await pollRun(base, runPath, (r) => r.status === 'done');
    const bCall = adapter.calls.find((c) => c.nodeId === 'b');
    assert.deepEqual(bCall.editRules, ['金額一律用千元'], '放行後下游要帶著擬好的規則跑');
  } finally {
    await app.stop();
  }
});

test('交貨查核輪：GET run 帶 usage_by_node——依 node／kind 彙總；edit-rules 不算進 step 或 check', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: '用量彙總測試', params: [],
      nodes: [{ id: 'a', title: '步驟A', executor: 'ai', stop_point: 'never', instruction: '做A', next: [] }],
    };
    store.writeWorkflow('測試', 'usage-wf', def);
    const rid = 'r-usage';
    store.writeRun('測試', 'usage-wf', rid, {
      run_id: rid, workflow: { category: '測試', id: 'usage-wf', name: def.name }, def,
      status: 'done', source: 'manual', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      steps: { a: { status: 'done', output: '產出' } },
    });
    const nowIso = new Date().toISOString();
    store.appendUsage({ at: nowIso, kind: 'step', category: '測試', workflow: 'usage-wf', run: rid, node: 'a', input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 3 });
    store.appendUsage({ at: nowIso, kind: 'check', category: '測試', workflow: 'usage-wf', run: rid, node: 'a', input_tokens: 50, output_tokens: 10 });
    store.appendUsage({ at: nowIso, kind: 'edit-rules', category: '測試', workflow: 'usage-wf', run: rid, node: 'a', input_tokens: 999, output_tokens: 999 });

    const wfp = `/api/workflows/${encodeURIComponent('測試')}/usage-wf`;
    const run = (await api(base, 'GET', `${wfp}/runs/${rid}`)).json;
    assert.deepEqual(run.usage_by_node.a.step, { input: 108, output: 20, calls: 1 }, 'input=input+快取建立+快取讀取');
    assert.deepEqual(run.usage_by_node.a.check, { input: 50, output: 10, calls: 1 });
  } finally {
    await app.stop();
  }
});

test('監工輪：usage_by_node 第三格 supervisor——_brief／_record 也是合法的步驟鍵', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: '監工用量測試', params: [],
      nodes: [
        { id: 'a', title: '步驟A', executor: 'ai', stop_point: 'never', instruction: '做A', next: ['b'] },
        { id: 'b', title: '步驟B', executor: 'ai', stop_point: 'never', instruction: '做B', next: [] },
      ],
    };
    store.writeWorkflow('測試', 'sup-wf', def);
    const rid = 'r-sup';
    store.writeRun('測試', 'sup-wf', rid, {
      run_id: rid, workflow: { category: '測試', id: 'sup-wf', name: def.name }, def,
      status: 'done', source: 'manual', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      steps: { a: { status: 'done', output: '產出' }, b: { status: 'done', output: '產出' } },
    });
    const at = new Date().toISOString();
    const row = { at, category: '測試', workflow: 'sup-wf', run: rid };
    store.appendUsage({ ...row, kind: 'supervisor', node: 'b', input_tokens: 5, output_tokens: 1 });
    store.appendUsage({ ...row, kind: 'supervisor', node: '_brief', input_tokens: 7, output_tokens: 2 });
    store.appendUsage({ ...row, kind: 'supervisor', node: '_record', input_tokens: 9, output_tokens: 4 });
    store.appendUsage({ ...row, kind: 'step', node: 'b', input_tokens: 100, output_tokens: 20 });

    const wfp = `/api/workflows/${encodeURIComponent('測試')}/sup-wf`;
    const run = (await api(base, 'GET', `${wfp}/runs/${rid}`)).json;
    assert.deepEqual(run.usage_by_node.b.supervisor, { input: 5, output: 1, calls: 1 });
    assert.deepEqual(run.usage_by_node.b.step, { input: 100, output: 20, calls: 1 }, '既有兩格不受影響');
    assert.deepEqual(run.usage_by_node._brief.supervisor, { input: 7, output: 2, calls: 1 });
    assert.deepEqual(run.usage_by_node._record.supervisor, { input: 9, output: 4, calls: 1 });
  } finally {
    await app.stop();
  }
});

test('交貨查核輪：GET /api/dashboard 的 recent[].usage.check 正確彙總；既有欄位不變', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: '儀表板查核測試', params: [],
      nodes: [{ id: 'a', title: '步驟A', executor: 'ai', stop_point: 'never', instruction: '做A', next: [] }],
    };
    store.writeWorkflow('測試', 'dash-check', def);
    const rid = 'r-dash-check';
    store.writeRun('測試', 'dash-check', rid, {
      run_id: rid, workflow: { category: '測試', id: 'dash-check', name: def.name }, def,
      status: 'done', source: 'manual', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      steps: { a: { status: 'done', output: '產出' } },
    });
    const nowIso = new Date().toISOString();
    store.appendUsage({ at: nowIso, kind: 'step', run: rid, node: 'a', input_tokens: 100, output_tokens: 20 });
    store.appendUsage({ at: nowIso, kind: 'check', run: rid, node: 'a', input_tokens: 30, output_tokens: 8, cache_creation_input_tokens: 2 });

    const dash = (await api(base, 'GET', '/api/dashboard?limit=5&days=30')).json;
    const card = dash.recent.find((r) => r.run_id === rid);
    assert.ok(card, '要有這張卡');
    assert.deepEqual(card.usage.check, { input: 32, output: 8 });
    assert.equal(card.usage.input, 132, '既有欄位不變（總量含 check 那筆：100 ＋ 30 ＋ 2 快取建立）');
  } finally {
    await app.stop();
  }
});

test('交貨查核輪：GET /api/todos 對 waiting_check 出一條 tone hold，desc 是第一條 block 的 detail', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: '待辦查核測試', params: [],
      nodes: [{ id: 'a', title: '步驟A', executor: 'ai', stop_point: 'never', instruction: '做A', next: [] }],
    };
    store.writeWorkflow('測試', 'todo-check', def);
    const rid = 'r-todo-check';
    store.writeRun('測試', 'todo-check', rid, {
      run_id: rid, workflow: { category: '測試', id: 'todo-check', name: def.name }, def,
      status: 'paused', source: 'manual', started_at: new Date().toISOString(), finished_at: null,
      steps: {
        a: {
          status: 'waiting_check',
          check: {
            status: 'blocked',
            blocks: [{ kind: 'number-mismatch', claim: '總數 13 件', source: '明細共 14 件', detail: '算式不成立：6+3+4=13' }],
            flags: [], missing: [], items: [], summary: '數字對不上', note: '', attempts: 2,
          },
        },
      },
    });
    const todos = (await api(base, 'GET', '/api/todos')).json.items;
    const item = todos.find((x) => x.run?.run_id === rid);
    assert.ok(item, '要有這條待辦');
    assert.equal(item.kind, 'waiting_check');
    assert.equal(item.tone, 'hold');
    assert.equal(item.desc, '算式不成立：6+3+4=13');
  } finally {
    await app.stop();
  }
});

test('監工輪：新建流程補監工＋數字對原始資料；存檔只補監工不碰 facts；匯入一律不補', async () => {
  const { app, base, adapter } = await startApp();
  try {
    const cat = encodeURIComponent('測試');
    const base0 = { format: 1, name: '不帶監工', params: [], nodes: [{ id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做', next: [] }] };

    // 新建：監工缺省開
    const made = (await api(base, 'POST', '/api/workflows', { category: '測試', def: base0 })).json;
    const saved = (await api(base, 'GET', `/api/workflows/${cat}/${made.id}`)).json;
    assert.equal(saved.supervisor.enabled, true);
    assert.equal(saved.check.facts, false, '沒有必填欄位＝沒有資料要對');

    // 新建：有必填資料欄位→數字對原始資料開
    const withParam = { ...base0, name: '帶必填欄位', params: [{ key: 'src', label: '總表', default: '', required: true }] };
    const made2 = (await api(base, 'POST', '/api/workflows', { category: '測試', def: withParam })).json;
    const saved2 = (await api(base, 'GET', `/api/workflows/${cat}/${made2.id}`)).json;
    assert.equal(saved2.check.facts, true);

    // 存檔（PUT）：補監工，但不碰 facts——既有流程的「數字對原始資料」缺省是開，手改存檔不能靜默翻成關
    const put = await api(base, 'PUT', `/api/workflows/${cat}/${made.id}`, { def: { ...base0, name: '改過', check: { enabled: true } } });
    assert.equal(put.status, 200);
    const saved3 = (await api(base, 'GET', `/api/workflows/${cat}/${made.id}`)).json;
    assert.equal(saved3.supervisor.enabled, true);
    assert.equal(saved3.check.facts, undefined);

    // 匯入：沿用缺省語意，不寫任何開關
    adapter.setCompleteResponses(['沒有可疑指示']);
    const conf = await api(base, 'POST', '/api/import/confirm', { category: '測試', def: { ...base0, name: '匯入的監工' } });
    assert.equal(conf.status, 200);
    const list = (await api(base, 'GET', '/api/workflows')).json;
    const imp = list.find((w) => w.name === '匯入的監工');
    const impDef = (await api(base, 'GET', `/api/workflows/${encodeURIComponent(imp.category)}/${imp.id}`)).json;
    assert.equal(impDef.supervisor, undefined);
  } finally {
    await app.stop();
  }
});

test('監工輪：POST /runs/:rid/interject 把話記下來；空白→400 人話', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: '插話測試', params: [],
      nodes: [{ id: 'a', title: '步驟A', executor: 'ai', stop_point: 'always', instruction: '做A', next: [] }],
    };
    store.writeWorkflow('測試', 'interject-wf', def);
    const rid = 'r-interject';
    store.writeRun('測試', 'interject-wf', rid, {
      run_id: rid, workflow: { category: '測試', id: 'interject-wf', name: def.name }, def,
      status: 'paused', source: 'manual', started_at: new Date().toISOString(),
      steps: { a: { status: 'waiting_review', output: '產出' } },
    });
    const runPath = `/api/workflows/${encodeURIComponent('測試')}/interject-wf/runs/${rid}`;

    const ok = await api(base, 'POST', `${runPath}/interject`, { node: 'a', text: '報告也要提退貨' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.interjections.length, 1);
    assert.equal(ok.json.interjections[0].node, 'a');
    assert.equal(ok.json.interjections[0].text, '報告也要提退貨');
    assert.equal(ok.json.interjections[0].consumed, false);
    assert.equal(ok.json.status, 'paused', '插話不推進流程——原本停著就還停著');

    const bad = await api(base, 'POST', `${runPath}/interject`, { node: 'a', text: '  ' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /要先寫一句/);
    assert.equal(store.readRun('測試', 'interject-wf', rid).interjections.length, 1, '空白那次沒寫進去');
  } finally {
    await app.stop();
  }
});

test('監工輪：GET /api/dashboard 的 recent[].usage.supervisor 正確彙總', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: '儀表板監工測試', params: [],
      nodes: [{ id: 'a', title: '步驟A', executor: 'ai', stop_point: 'never', instruction: '做A', next: [] }],
    };
    store.writeWorkflow('測試', 'dash-sup', def);
    const rid = 'r-dash-sup';
    store.writeRun('測試', 'dash-sup', rid, {
      run_id: rid, workflow: { category: '測試', id: 'dash-sup', name: def.name }, def,
      status: 'done', source: 'manual', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      steps: { a: { status: 'done', output: '產出' } },
    });
    const nowIso = new Date().toISOString();
    store.appendUsage({ at: nowIso, kind: 'step', run: rid, node: 'a', input_tokens: 100, output_tokens: 20 });
    store.appendUsage({ at: nowIso, kind: 'supervisor', run: rid, node: '_brief', input_tokens: 30, output_tokens: 8, cache_read_input_tokens: 2 });
    store.appendUsage({ at: nowIso, kind: 'supervisor', run: rid, node: '_record', input_tokens: 10, output_tokens: 4 });

    const dash = (await api(base, 'GET', '/api/dashboard?limit=5&days=30')).json;
    const card = dash.recent.find((r) => r.run_id === rid);
    assert.ok(card, '要有這張卡');
    assert.deepEqual(card.usage.supervisor, { input: 42, output: 12 });
    assert.deepEqual(card.usage.check, { input: 0, output: 0 }, '既有格不受影響');
    assert.equal(card.usage.input, 142, '總量含監工那兩筆');
  } finally {
    await app.stop();
  }
});

// ===== 工作單留存、連接器例外、監工建議接受 =====

function logFiles(dataDir, kind) {
  try { return fs.readdirSync(path.join(dataDir, 'logs', kind)).sort(); } catch { return []; }
}
function logPair(dataDir, kind) {
  const all = logFiles(dataDir, kind);
  return { asked: all.filter((f) => !f.endsWith('.reply.txt')), replied: all.filter((f) => f.endsWith('.reply.txt')) };
}
const readLogFile = (dataDir, kind, name) => fs.readFileSync(path.join(dataDir, 'logs', kind, name), 'utf8');

test('K5：用講的建流程／匯入掃描／行事曆快照都留工作單（指示＋回覆），快照呼叫帶連接器例外', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    const draft = { format: 1, name: '訂餐廳', params: [], nodes: [{ id: 'a', title: '找店', executor: 'ai', stop_point: 'always', instruction: '列三家', next: [] }] };
    adapter.setCompleteResponses([`拆好了\n\`\`\`yaml\n${JSON.stringify(draft)}\n\`\`\``]);
    await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '訂餐廳' }], phase: 'draft' });
    let p = logPair(dataDir, 'compose');
    assert.equal(p.asked.length, 1, `建流程的指示要留一份：${JSON.stringify(logFiles(dataDir, 'compose'))}`);
    assert.equal(p.replied.length, 1, '回覆也要留一份');
    assert.ok(readLogFile(dataDir, 'compose', p.asked[0]).includes('訂餐廳'), '存的全文＝送出的全文');
    assert.ok(readLogFile(dataDir, 'compose', p.replied[0]).includes('拆好了'));

    const wfP = `/api/workflows/${encodeURIComponent('範例')}/quarterly-report`;
    const exported = await (await fetch(base + `${wfP}/export`)).text();
    adapter.setCompleteResponses(['沒問題\n```yaml\nverdict: clean\nfindings: []\n```']);
    await api(base, 'POST', '/api/import/scan', { content: exported });
    p = logPair(dataDir, 'scan');
    assert.equal(p.asked.length, 1, '匯入掃描要留工作單');
    assert.equal(p.replied.length, 1);
    assert.ok(readLogFile(dataDir, 'scan', p.replied[0]).includes('verdict: clean'));

    adapter.setCompleteResponses(['抓好了\n```yaml\nevents: []\n```']);
    const snap = await api(base, 'POST', '/api/calendar/refresh', { month: '2026-09' });
    assert.equal(snap.json.ok, true);
    p = logPair(dataDir, 'snapshot');
    assert.equal(p.asked.length, 1, '快照要留工作單');
    assert.equal(p.replied.length, 1);
    const snapCall = adapter.completes.filter((c) => c.meta?.kind === 'snapshot').at(-1);
    assert.equal(snapCall.meta.mcp, 'calendar', '快照要走連接器例外');
    assert.equal(adapter.completes.find((c) => c.meta?.kind === 'compose').meta.mcp, undefined, '其餘呼叫不帶例外');
  } finally {
    await app.stop();
  }
});

test('K5：下游要等這步敲的時間 → 這步的呼叫帶連接器例外；事後回饋的優化呼叫留工作單', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    createStore(dataDir).writeWorkflow('測試', 'when-wf', {
      format: 1,
      name: '約時間',
      params: [],
      nodes: [
        { id: 'ask', title: '敲時間', executor: 'ai', stop_point: 'never', instruction: '跟客戶敲一個時間', next: ['go'] },
        { id: 'go', title: '出席', executor: 'human', stop_point: 'never', instruction: '去開會', next: [], wait_until: { from: 'ask' } },
      ],
    });
    const wfp = `/api/workflows/${encodeURIComponent('測試')}/when-wf`;
    const started = await api(base, 'POST', `${wfp}/runs`, {});
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const runPath = `${wfp}/runs/${started.json.run_id}`;
    await pollRun(base, runPath, (r) => r.steps.ask.status === 'done');
    assert.equal(adapter.calls.find((c) => c.nodeId === 'ask').meta.mcp, 'calendar', '要敲時間的步驟才開連接器');

    adapter.setCompleteResponses(['好\n```yaml\nnode_id: ask\nsummary: 要不要先問預算？\nnew_instruction: 敲時間前先問預算\n```']);
    await api(base, 'POST', `${runPath}/run-feedback`, { text: '客戶說太趕' });
    for (let i = 0; i < 100 && logPair(dataDir, 'optimize').replied.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const p = logPair(dataDir, 'optimize');
    assert.equal(p.asked.length, 1, '優化員的指示要留工作單');
    assert.equal(p.replied.length, 1, '回覆也要留');
    assert.ok(p.asked[0].includes('測試') && p.asked[0].includes('when-wf'), `工作單名字要標到是哪條流程：${p.asked[0]}`);
  } finally {
    await app.stop();
  }
});

test('K5：接受監工建議＝只開抽屜，不改定義也不升版', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    store.writeProposals([{
      id: 'p-hint-1', key: 'hint:organize:constraints:加上件數', kind: 'supervisor_hint', source: 'supervisor',
      evidence: '加上件數', change: { node_id: 'organize', field: 'constraints' },
      workflow: { category: '範例', id: 'quarterly-report' }, status: 'pending', reject_count: 0,
    }]);
    const wfP = `/api/workflows/${encodeURIComponent('範例')}/quarterly-report`;
    const before = (await api(base, 'GET', `${wfP}/versions`)).json.length;
    const defBefore = (await api(base, 'GET', wfP)).json;
    const acc = await api(base, 'POST', '/api/proposals/p-hint-1/accept', {});
    assert.equal(acc.status, 200);
    assert.deepEqual(acc.json.open, { category: '範例', id: 'quarterly-report', node_id: 'organize', field: 'constraints' });
    assert.equal((await api(base, 'GET', `${wfP}/versions`)).json.length, before, '監工建議不升版');
    assert.deepEqual((await api(base, 'GET', wfP)).json, defBefore, '定義一個字都不能動');
    assert.equal(store.readProposals()[0].status, 'accepted');
    assert.deepEqual((await api(base, 'GET', `${wfP}/proposals`)).json.pending, [], '處理過就不再出現');
    const again = await api(base, 'POST', '/api/proposals/p-hint-1/accept', {});
    assert.equal(again.status, 400, '同一條不能接受兩次');
  } finally {
    await app.stop();
  }
});

// ===== 定義層與存檔接線——詞典自己長、群組圈、記憶卡、設定、備份 =====

const M1B_DEF = (extra = {}) => ({
  format: 1, name: '一步流程', params: [],
  nodes: [{ id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做', next: [] }],
  ...extra,
});
const enc = encodeURIComponent;
const manual = (o) => makeCard({ ...o, source: { kind: 'manual', quote: o.text } });

test('M1b：存新流程→詞典長出新欄位（origin 記流程）、頂層 category 存檔前剝掉、像的欄位回 dict_similar 不擋；kind 壞的 400；匯入不動詞典', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const made = await api(base, 'POST', '/api/workflows', {
      category: '測試',
      def: M1B_DEF({ category: '旅遊', params: [{ key: 'pace', label: '旅行節奏', default: '', kind: 'method' }, { key: 'tone', label: '口吻', default: '' }] }),
    });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.deepEqual(made.json.dict_similar, []);
    const dict = (await api(base, 'GET', '/api/memory/dict')).json;
    assert.equal(dict.fields.length, 11, '口吻是語氣的同義詞，不長；旅行節奏長一條（出廠十條＋一）');
    const f = dict.fields.find((x) => x.name === '旅行節奏');
    assert.equal(f.kind, 'method');
    assert.deepEqual(f.origin, { category: '測試', workflow: made.json.id });
    const saved = store.readWorkflow('測試', made.json.id);
    assert.equal('category' in saved, false, '分類是路徑，不進 workflow.yaml');
    assert.equal(saved.params[0].kind, 'method');
    // 像同一件事：先塞「出發日」，再存帶「出發日期」的流程→回提醒但照存
    const d2 = store.readDict();
    d2.fields.push({ name: '出發日', kind: 'time', synonyms: [], origin: { category: '測試', workflow: 'wf-x' }, created_at: '2026-09-09T00:00:00.000Z' });
    store.writeDict(d2);
    const made2 = await api(base, 'POST', '/api/workflows', { category: '測試', def: M1B_DEF({ params: [{ key: 'd', label: '出發日期', default: '' }] }) });
    assert.equal(made2.status, 200);
    assert.deepEqual(made2.json.dict_similar, ['出發日']);
    assert.equal(store.readDict().fields.find((x) => x.name === '出發日期').kind, 'method', '提醒歸提醒，欄位照長；沒給 kind＝做法');
    // kind 壞的擋下
    const bad = await api(base, 'POST', '/api/workflows', { category: '測試', def: M1B_DEF({ params: [{ key: 'c', label: '色彩', default: '', kind: '色彩' }] }) });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.error.includes('kind 必須是 appearance/audience/time/range/limits/method'), bad.json.error);
    // 匯入不動詞典
    const before = store.readDict().fields.length;
    const conf = await api(base, 'POST', '/api/import/confirm', { def: M1B_DEF({ name: '匯入的', params: [{ key: 'x', label: '匯入欄位', default: '' }] }) });
    assert.equal(conf.status, 200);
    assert.equal(store.readDict().fields.length, before);
  } finally {
    await app.stop();
  }
});

test('M1b：群組圈——PUT 文字框重拆、分類不存在 404、沒檔回空殼、GET 列全部、再存一次保留 id 並標 retired；分類清單不變', async () => {
  const { app, base } = await startApp();
  try {
    await api(base, 'POST', '/api/categories', { name: '旅遊' });
    const miss = await api(base, 'PUT', `/api/memory/groups/${enc('沒有的')}`, { text: '不提競品' });
    assert.equal(miss.status, 404);
    assert.equal(miss.json.error, '沒有這個分類');
    assert.equal((await api(base, 'GET', `/api/memory/groups/${enc('沒有的')}`)).status, 404);
    const empty = await api(base, 'GET', `/api/memory/groups/${enc('旅遊')}`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.rules, [], '沒檔＝沒有群組圈，回空殼給前端畫文字框');
    assert.equal(empty.json.text, '');
    assert.deepEqual((await api(base, 'GET', '/api/memory/groups')).json, []);
    const put = await api(base, 'PUT', `/api/memory/groups/${enc('旅遊')}`, { text: '語氣：輕鬆\n不提競品' });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(put.json.rules.length, 2);
    assert.equal(put.json.rules[0].field, '語氣');
    assert.equal(put.json.rules[0].value, '輕鬆');
    assert.equal(put.json.rules[1].field, null);
    assert.equal(put.json.category, '旅遊');
    assert.deepEqual(put.json.files, []);
    assert.ok(put.json.updated_at);
    assert.deepEqual((await api(base, 'GET', '/api/memory/groups')).json.map((g) => g.category), ['旅遊']);
    const again = await api(base, 'PUT', `/api/memory/groups/${enc('旅遊')}`, { text: '不提競品' });
    assert.equal(again.json.rules.find((r) => r.text === '不提競品').id, put.json.rules[1].id, '同文字保留原 id');
    assert.equal(again.json.rules.find((r) => r.text === '語氣：輕鬆').status, 'retired');
    assert.equal((await api(base, 'GET', `/api/memory/groups/${enc('旅遊')}`)).json.text, '不提競品');
    assert.equal((await api(base, 'PUT', `/api/memory/groups/${enc('旅遊')}`, { text: 3 })).status, 400);
    const cats = (await api(base, 'GET', '/api/categories')).json;
    assert.ok(Array.isArray(cats) && cats.includes('旅遊') && cats.every((c) => typeof c === 'string'), '分類清單仍是字串陣列，群組圈另查');
  } finally {
    await app.stop();
  }
});

test('M1b：記憶卡 API——手動新增與人話驗證、取代鏈、退休／復活／延期／改範圍、垃圾桶來回、摘要例外、清空', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const bad = await api(base, 'POST', '/api/memory/cards', { bucket: 'habit', field: '語氣', scope: { level: 'all' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.error.includes('卡要有內容'), bad.json.error);
    const badField = await api(base, 'POST', '/api/memory/cards', { bucket: 'habit', text: 'x', field: '沒這格', scope: { level: 'all' } });
    assert.equal(badField.status, 400);
    assert.ok(badField.json.error.includes('習慣卡要對到詞典裡的欄位'), badField.json.error);
    const badBucket = await api(base, 'GET', '/api/memory/cards?bucket=team');
    assert.equal(badBucket.status, 400);
    assert.equal(badBucket.json.error, '沒有這種卡');
    const none = await api(base, 'GET', '/api/memory/cards/h-nope');
    assert.equal(none.status, 404);
    assert.equal(none.json.error, '找不到這張卡');

    const made = await api(base, 'POST', '/api/memory/cards', { bucket: 'habit', text: '輕鬆', field: '口吻', scope: { level: 'all' } });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const h = made.json;
    assert.ok(h.id.startsWith('h-'));
    assert.equal(h.source.kind, 'manual');
    assert.equal(h.source.quote, '輕鬆');
    assert.equal(h.field, '語氣', '同義詞進來、存正式名');
    assert.equal(h.status, 'active');
    const p = await api(base, 'POST', '/api/memory/cards', { bucket: 'profile', text: '不要客套', layer: 'expression', scope: { level: 'category', category: '工作' }, expires: '2030-01-01' });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.ok(p.json.id.startsWith('p-'));
    assert.deepEqual(p.json.scope, { level: 'category', category: '工作', workflow: null });
    assert.equal(p.json.expires, '2030-01-01');
    assert.deepEqual((await api(base, 'GET', '/api/memory/cards?bucket=habit')).json.map((c) => c.id), [h.id]);
    assert.equal((await api(base, 'GET', '/api/memory/cards')).json.length, 2, '不給 bucket＝兩本帳都列');
    assert.deepEqual((await api(base, 'GET', `/api/memory/cards/${h.id}`)).json, h);
    // 取代：內容不改，新卡取代舊卡
    const noText = await api(base, 'POST', `/api/memory/cards/${h.id}/replace`, { text: ' ' });
    assert.equal(noText.status, 400);
    assert.equal(noText.json.error, '要先寫新的內容');
    const rep = await api(base, 'POST', `/api/memory/cards/${h.id}/replace`, { text: '輕鬆但不油' });
    assert.equal(rep.status, 200, JSON.stringify(rep.json));
    assert.equal(rep.json.replaces, h.id);
    assert.equal(rep.json.source.kind, 'replace');
    assert.equal(rep.json.source.quote, '輕鬆但不油');
    assert.equal(rep.json.field, '語氣');
    assert.equal(rep.json.text, '輕鬆但不油');
    assert.equal(rep.json.status, 'active');
    const old = (await api(base, 'GET', `/api/memory/cards/${h.id}`)).json;
    assert.equal(old.status, 'replaced');
    assert.equal(old.replaced_by, rep.json.id);
    assert.equal(old.text, '輕鬆', '舊卡內容不動');
    assert.deepEqual((await api(base, 'GET', '/api/memory/cards?bucket=habit&status=active')).json.map((c) => c.id), [rep.json.id]);
    // 退休／復活／延期／改範圍
    assert.equal((await api(base, 'POST', `/api/memory/cards/${p.json.id}/retire`, {})).json.status, 'retired');
    assert.equal((await api(base, 'POST', `/api/memory/cards/${p.json.id}/revive`, {})).json.status, 'active');
    const badDate = await api(base, 'POST', `/api/memory/cards/${p.json.id}/extend`, { expires: '明天' });
    assert.equal(badDate.status, 400);
    assert.ok(badDate.json.error.includes('有效期要是 YYYY-MM-DD'), badDate.json.error);
    assert.equal((await api(base, 'POST', `/api/memory/cards/${p.json.id}/extend`, { expires: '2031-12-31' })).json.expires, '2031-12-31');
    assert.equal((await api(base, 'POST', `/api/memory/cards/${p.json.id}/extend`, { expires: null })).json.expires, null, '空＝永久');
    const badScope = await api(base, 'POST', `/api/memory/cards/${p.json.id}/scope`, { level: 'team' });
    assert.equal(badScope.status, 400);
    assert.equal(badScope.json.error, '用在哪只能是全部、分類、Workflow');
    const scoped = (await api(base, 'POST', `/api/memory/cards/${p.json.id}/scope`, { level: 'all' })).json;
    assert.deepEqual(scoped.scope, { level: 'all', category: null, workflow: null });
    assert.equal(scoped.scope_log.at(-1).from.level, 'category');
    assert.equal(scoped.scope_log.at(-1).to.level, 'all');
    const narrowed = (await api(base, 'POST', `/api/memory/cards/${p.json.id}/scope`, { level: 'workflow', category: '工作', workflow: 'wf-1' })).json;
    assert.deepEqual(narrowed.scope, { level: 'workflow', category: '工作', workflow: 'wf-1' }, '縮範圍直接設，不經 widenScope');
    assert.equal((await api(base, 'POST', '/api/memory/cards/h-nope/retire', {})).status, 404);
    // 垃圾桶來回
    const del = await api(base, 'DELETE', `/api/memory/cards/${p.json.id}`);
    assert.equal(del.status, 200);
    assert.ok(del.json.ok && del.json.key);
    assert.equal((await api(base, 'DELETE', `/api/memory/cards/${p.json.id}`)).status, 404);
    assert.equal((await api(base, 'GET', `/api/memory/cards/${p.json.id}`)).status, 404);
    const trash = (await api(base, 'GET', '/api/memory/trash')).json;
    assert.equal(trash.length, 1);
    assert.equal(trash[0].key, del.json.key);
    assert.equal(trash[0].bucket, 'profile');
    assert.equal(trash[0].id, p.json.id);
    assert.equal(trash[0].text, '不要客套');
    assert.ok(trash[0].trashed_at);
    const gone = await api(base, 'POST', '/api/memory/trash/nokey/restore', {});
    assert.equal(gone.status, 404);
    assert.equal(gone.json.error, '垃圾桶裡沒有這張卡');
    const back = await api(base, 'POST', `/api/memory/trash/${del.json.key}/restore`, {});
    assert.equal(back.status, 200, JSON.stringify(back.json));
    assert.equal(back.json.id, p.json.id);
    assert.equal((await api(base, 'GET', `/api/memory/cards/${p.json.id}`)).status, 200);
    assert.deepEqual((await api(base, 'GET', '/api/memory/trash')).json, []);
    // 摘要：到期／休眠／被取代各列在例外
    const store = createStore(dataDir);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    store.writeCard({ ...(await api(base, 'GET', `/api/memory/cards/${p.json.id}`)).json, id: 'p-old00000-aaaa', expires: yesterday });
    store.writeCard({ ...h, id: 'h-dorm0000-aaaa', status: 'dormant', text: '休眠的' });
    const sum = (await api(base, 'GET', '/api/memory/summary')).json;
    assert.equal(sum.intro_done, false);
    assert.equal(sum.paused, false);
    assert.deepEqual(sum.sensitive, { health: false, politics: false, religion: false, finance: false });
    assert.deepEqual(sum.counts, { profile: 2, habit: 3, groups: 0, dict: 10 });
    assert.ok(sum.exceptions.expired.some((c) => c.id === 'p-old00000-aaaa'), JSON.stringify(sum.exceptions));
    assert.equal(sum.exceptions.expired.some((c) => c.id === p.json.id), false, '還沒到期的不算');
    assert.deepEqual(sum.exceptions.dormant.map((c) => c.id), ['h-dorm0000-aaaa']);
    assert.deepEqual(sum.exceptions.replaced.map((c) => c.id), [h.id]);
    assert.deepEqual(sum.exceptions.changed, []);
    // 清空：全部進垃圾桶
    const cleared = await api(base, 'POST', '/api/memory/clear', {});
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.moved, 5);
    assert.deepEqual((await api(base, 'GET', '/api/memory/summary')).json.counts, { profile: 0, habit: 0, groups: 0, dict: 10 });
    assert.equal((await api(base, 'GET', '/api/memory/trash')).json.length, 5);
  } finally {
    await app.stop();
  }
});

test('M1b：設定——PUT 逐欄人話、部分送只改送的鍵、GET 帶 data_dir 與 app_version、新流程吃 defaults；備份 POST／GET', async () => {
  const { app, base, dataDir, root } = await startApp();
  // 多組織：備份備的是整個資料根（全部組織一起），所以備份夾在 root 旁邊、內容多一層 orgs/main/
  const backupsRoot = path.join(path.dirname(root), `${path.basename(root)}-backups`);
  try {
    const bad = await api(base, 'PUT', '/api/settings', { defaults: { check_facts: 'maybe' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.error.includes('auto、on、off'), bad.json.error);
    const bad2 = await api(base, 'PUT', '/api/settings', { exec: { web: 'yes' } });
    assert.equal(bad2.status, 400);
    assert.ok(bad2.json.error.includes('允許查網路要是開或關'), bad2.json.error);
    assert.equal(createStore(dataDir).readSettings().defaults.check_facts, 'auto', '錯的一欄都不落地');
    const ok = await api(base, 'PUT', '/api/settings', { memory: { paused: true }, defaults: { check_facts: 'on', check_enabled: false, supervisor_flags: { tier: true } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.defaults.check_facts, 'on');
    const got = (await api(base, 'GET', '/api/settings')).json;
    assert.equal(got.memory.paused, true);
    assert.equal(got.defaults.check_facts, 'on');
    assert.equal(got.defaults.check_enabled, false);
    assert.deepEqual(got.defaults.supervisor_flags, { note: true, tier: true, tools: false }, '沒送的鍵保留原值');
    assert.equal(got.exec.web, true);
    assert.equal(got.data_dir, dataDir);
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(got.app_version, pkg.version, '剝繭版號走 app_version');
    assert.equal(got.version, 1, '設定檔自己的格式版本不被套件版號蓋掉');
    // 新流程吃 defaults：查核關、數字對原始資料固定開、每個 task 節點三個勾照設定；PUT 存檔不吃
    const made = await api(base, 'POST', '/api/workflows', { category: '測試', def: M1B_DEF() });
    const wfP = `/api/workflows/${enc('測試')}/${made.json.id}`;
    const saved = (await api(base, 'GET', wfP)).json;
    assert.deepEqual(saved.check, { enabled: false, facts: true });
    assert.deepEqual(saved.nodes[0].supervisor, { note: true, tier: true, tools: false });
    assert.deepEqual(saved.permissions, { files: true, connectors: true });
    await api(base, 'PUT', wfP, { def: M1B_DEF({ name: '改過' }) });
    const saved2 = (await api(base, 'GET', wfP)).json;
    assert.deepEqual(saved2.check, { enabled: true });
    assert.equal(saved2.nodes[0].supervisor, undefined);
    // 備份
    const bk = await api(base, 'POST', '/api/backup', {});
    assert.equal(bk.status, 200, JSON.stringify(bk.json));
    assert.ok(fs.existsSync(bk.json.path));
    assert.ok(bk.json.at);
    assert.ok(fs.existsSync(path.join(bk.json.path, 'orgs', 'main', 'settings.json')), '備份含設定檔');
    const list = (await api(base, 'GET', '/api/backup')).json;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, path.basename(bk.json.path));
  } finally {
    await app.stop();
    fs.rmSync(backupsRoot, { recursive: true, force: true });
  }
});

test('M1b 修正輪：備份失敗只回人話——不透傳原始錯誤碼與本機路徑', async () => {
  const { app, base, dataDir, root } = await startApp();
  const backupsRoot = path.join(path.dirname(root), `${path.basename(root)}-backups`); // 多組織：備份夾跟著資料根
  try {
    fs.writeFileSync(backupsRoot, 'x'); // 備份夾的位置先被一個檔案佔住→複製一定失敗
    const res = await api(base, 'POST', '/api/backup', {});
    assert.equal(res.status, 500);
    assert.ok(res.json.error.startsWith('備份沒做成'), res.json.error);
    for (const leak of ['\\', ':\\', 'ENOENT', 'EEXIST', dataDir]) assert.ok(!res.json.error.includes(leak), `錯誤訊息不該露出 ${leak}：${res.json.error}`);
  } finally {
    await app.stop();
    fs.rmSync(backupsRoot, { recursive: true, force: true });
  }
});

test('M5b：新增排程缺 auto_makeup／remind_leads 用設定 exec 缺省、帶了照帶；exec.web 非布林 400 人話；GET /api/settings.app_version 等於 package.json', async () => {
  const { app, base } = await startApp();
  try {
    const wf = await api(base, 'POST', '/api/workflows', { category: '測試', def: M1B_DEF() });
    const workflow_id = `測試/${wf.json.id}`;
    // 缺省前：程式缺省＝不自動補、不提醒
    const s0 = await api(base, 'POST', '/api/schedules', { workflow_id, freq: 'daily', time: '08:00' });
    assert.equal(s0.status, 200, JSON.stringify(s0.json));
    assert.equal(s0.json.auto_makeup, false);
    assert.deepEqual(s0.json.remind_leads, []);
    // 設定頁「執行與排程」改了預設 → 新排程不帶兩欄就吃它
    const put = await api(base, 'PUT', '/api/settings', { exec: { auto_makeup: true, remind_leads: ['30m'] } });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const s1 = await api(base, 'POST', '/api/schedules', { workflow_id, freq: 'daily', time: '09:00' });
    assert.equal(s1.status, 200, JSON.stringify(s1.json));
    assert.equal(s1.json.auto_makeup, true);
    assert.deepEqual(s1.json.remind_leads, ['30m']);
    const back = (await api(base, 'GET', '/api/schedules')).json.find((s) => s.id === s1.json.id);
    assert.equal(back.auto_makeup, true, '落地的也是缺省值');
    assert.deepEqual(back.remind_leads, ['30m']);
    // 帶了就照帶的（含明確關掉）
    const s2 = await api(base, 'POST', '/api/schedules', { workflow_id, freq: 'daily', time: '10:00', auto_makeup: false, remind_leads: ['1h', '1d'] });
    assert.equal(s2.status, 200, JSON.stringify(s2.json));
    assert.equal(s2.json.auto_makeup, false);
    assert.deepEqual(s2.json.remind_leads, ['1h', '1d']);
    // exec.web 非布林 → 400 人話；version＝套件版本
    const bad = await api(base, 'PUT', '/api/settings', { exec: { web: 'yes' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.error.includes('允許查網路要是開或關'), bad.json.error);
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal((await api(base, 'GET', '/api/settings')).json.app_version, pkg.version);
  } finally { await app.stop(); }
});

test('M1b 修正輪：scope 路由存檔前驗卡——流程層缺分類或流程 400 且卡不動；分類層帶分類 200', async () => {
  const { app, base } = await startApp();
  try {
    const made = await api(base, 'POST', '/api/memory/cards', { bucket: 'profile', text: '我常去日本', layer: 'content', scope: { level: 'all' } });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const p = `/api/memory/cards/${made.json.id}`;
    const bad = await api(base, 'POST', `${p}/scope`, { level: 'workflow' });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.error.includes('用在 Workflow 時要指定分類和 Workflow'), bad.json.error);
    const after = (await api(base, 'GET', p)).json;
    assert.deepEqual(after.scope, { level: 'all', category: null, workflow: null }, '沒過驗證的不落地');
    assert.deepEqual(after.scope_log ?? [], [], '沒過驗證也不記 scope_log');
    const bad2 = await api(base, 'POST', `${p}/scope`, { level: 'category' });
    assert.equal(bad2.status, 400);
    assert.ok(bad2.json.error.includes('用在分類時要指定分類'), bad2.json.error);
    const ok = await api(base, 'POST', `${p}/scope`, { level: 'category', category: '旅遊' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const got = (await api(base, 'GET', p)).json;
    assert.equal(got.scope.level, 'category');
    assert.equal(got.scope.category, '旅遊');
  } finally {
    await app.stop();
  }
});

test('M1b：詞典 API——改性質與同義詞、六類之外擋、合併把同義詞併入並改掛卡與群組條', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    assert.equal((await api(base, 'GET', '/api/memory/dict')).json.fields.length, 10);
    const badKind = await api(base, 'PUT', `/api/memory/dict/${enc('語氣')}`, { kind: '色彩' });
    assert.equal(badKind.status, 400);
    assert.equal(badKind.json.error, '性質只能是六類之一');
    assert.equal((await api(base, 'PUT', `/api/memory/dict/${enc('沒有')}`, { kind: 'time' })).status, 404);
    const put = await api(base, 'PUT', `/api/memory/dict/${enc('語氣')}`, { kind: 'method', synonyms: ['口吻', '調性'] });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const tone = put.json.fields.find((f) => f.name === '語氣');
    assert.equal(tone.kind, 'method');
    assert.deepEqual(tone.synonyms, ['口吻', '調性']);
    assert.deepEqual(store.readDict().fields.find((f) => f.name === '語氣').synonyms, ['口吻', '調性']);
    // 合併：drop 的名字與同義詞併進 keep；掛在 drop 的卡改掛 keep；群組條重拆
    const d = store.readDict();
    d.fields.push({ name: '出發日', kind: 'time', synonyms: ['出發'], origin: { category: '測試', workflow: 'wf-1' }, created_at: 'x' });
    store.writeDict(d);
    store.writeCard(manual({ id: 'h-dd', bucket: 'habit', text: '週五', field: '出發日', scope: { level: 'all' } }));
    await api(base, 'POST', '/api/categories', { name: '旅遊' });
    await api(base, 'PUT', `/api/memory/groups/${enc('旅遊')}`, { text: '出發：週六' });
    assert.equal(store.readGroup('旅遊').rules[0].field, '出發日');
    const noArgs = await api(base, 'POST', '/api/memory/dict/merge', { keep: '截止日' });
    assert.equal(noArgs.status, 400);
    assert.equal(noArgs.json.error, '要指定留下哪個、併掉哪個');
    const noSuch = await api(base, 'POST', '/api/memory/dict/merge', { keep: '截止日', drop: '沒有' });
    assert.equal(noSuch.status, 400);
    assert.ok(noSuch.json.error.includes('沒有'), noSuch.json.error);
    const merged = await api(base, 'POST', '/api/memory/dict/merge', { keep: '截止日', drop: '出發日' });
    assert.equal(merged.status, 200, JSON.stringify(merged.json));
    assert.equal(merged.json.changed, 1);
    const keep = merged.json.dict.fields.find((f) => f.name === '截止日');
    assert.ok(keep.synonyms.includes('出發日') && keep.synonyms.includes('出發'));
    assert.equal(merged.json.dict.fields.find((f) => f.name === '出發日'), undefined);
    assert.equal(store.readCard('habit', 'h-dd').field, '截止日');
    const g = store.readGroup('旅遊');
    assert.equal(g.rules[0].field, '截止日', '群組條重拆後掛到留下的欄位');
    assert.equal(g.rules[0].text, '出發：週六');
  } finally {
    await app.stop();
  }
});

test('M1b：身分 CRUD、for-workflow 形狀與 404、介紹三題成三張認識卡／跳過只記時間、通知撤回把卡丟進垃圾桶', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const noName = await api(base, 'POST', '/api/memory/identities', { name: ' ', cards: [] });
    assert.equal(noName.status, 400);
    assert.equal(noName.json.error, '先取個名字');
    const idn = await api(base, 'POST', '/api/memory/identities', { name: '工作的我', cards: ['p-1'], categories: ['工作'] });
    assert.equal(idn.status, 200, JSON.stringify(idn.json));
    assert.ok(idn.json.id.startsWith('i-'));
    assert.ok(idn.json.created_at);
    assert.equal((await api(base, 'GET', '/api/memory/identities')).json.length, 1);
    const up = await api(base, 'PUT', `/api/memory/identities/${idn.json.id}`, { name: '上班的我', categories: ['工作', '行銷'] });
    assert.equal(up.status, 200);
    assert.equal(up.json.name, '上班的我');
    assert.deepEqual(up.json.cards, ['p-1'], '沒送的欄位不動');
    assert.deepEqual(up.json.categories, ['工作', '行銷']);
    assert.equal((await api(base, 'PUT', `/api/memory/identities/${idn.json.id}`, { name: '' })).status, 400);
    assert.equal((await api(base, 'PUT', '/api/memory/identities/i-nope', { name: 'x' })).status, 404);
    assert.equal((await api(base, 'DELETE', `/api/memory/identities/${idn.json.id}`)).status, 200);
    assert.equal((await api(base, 'DELETE', '/api/memory/identities/i-nope')).status, 404);
    assert.deepEqual((await api(base, 'GET', '/api/memory/identities')).json, []);

    // for-workflow：不存在 404；形狀＝core／group／habits／options／paused
    assert.equal((await api(base, 'GET', `/api/memory/for-workflow/${enc('範例')}/nope`)).status, 404);
    await api(base, 'POST', '/api/categories', { name: '旅遊' });
    const mkWf = async (name) => (await api(base, 'POST', '/api/workflows', { category: '旅遊', def: M1B_DEF({ name, params: [{ key: 'pace', label: '旅行節奏', default: '' }] }) })).json;
    const wfA = await mkWf('A');
    const wfB = await mkWf('B');
    await api(base, 'PUT', `/api/memory/groups/${enc('旅遊')}`, { text: '不提競品\n語氣：輕鬆' });
    const cards = [
      manual({ id: 'h-own', bucket: 'habit', text: '一天 3 個點', field: '旅行節奏', scope: { level: 'workflow', category: '旅遊', workflow: wfA.id } }),
      manual({ id: 'h-other', bucket: 'habit', text: '一天 5 個點', field: '旅行節奏', scope: { level: 'workflow', category: '旅遊', workflow: wfB.id } }),
      manual({ id: 'h-inh', bucket: 'habit', text: '市區優先', field: '語氣', scope: { level: 'category', category: '旅遊' } }),
      manual({ id: 'h-all', bucket: 'habit', text: '短一點', field: '長度', scope: { level: 'all' } }),
      manual({ id: 'h-elsewhere', bucket: 'habit', text: '別分類的', field: '長度', scope: { level: 'category', category: '工作' } }),
      manual({ id: 'h-dead', bucket: 'habit', text: '退休的', field: '長度', scope: { level: 'all' }, status: 'retired' }),
      manual({ id: 'p-exp', bucket: 'profile', text: '不要客套', layer: 'expression', scope: { level: 'all' } }),
      manual({ id: 'p-ctx', bucket: 'profile', text: '我常去日本', layer: 'content', scope: { level: 'category', category: '旅遊' } }),
      manual({ id: 'p-out', bucket: 'profile', text: '公司在台北', layer: 'content', scope: { level: 'category', category: '工作' } }),
      manual({ id: 'p-gone', bucket: 'profile', text: '過期的', layer: 'expression', scope: { level: 'all' }, expires: '2000-01-01' }),
    ];
    for (const c of cards) store.writeCard(c);
    const fw = await api(base, 'GET', `/api/memory/for-workflow/${enc('旅遊')}/${wfA.id}`);
    assert.equal(fw.status, 200, JSON.stringify(fw.json));
    assert.deepEqual(fw.json.core.expression.map((c) => c.id), ['p-exp'], '過期的不帶');
    assert.deepEqual(fw.json.core.content.map((c) => c.id), ['p-ctx'], '內容層只留場合對上的');
    assert.deepEqual(fw.json.group.rules.map((r) => r.text), ['不提競品', '語氣：輕鬆']);
    assert.deepEqual(fw.json.habits.own.map((c) => c.id), ['h-own']);
    assert.deepEqual(fw.json.habits.inherited.map((c) => c.id).sort(), ['h-all', 'h-inh'], '分類與全部尺度的都算繼承；退休的不列');
    assert.deepEqual(fw.json.habits.probes.map((c) => c.id), ['h-other'], '同分類別條流程的 workflow 尺度卡');
    // 開跑選項（M3b 起）：本流程涵蓋的進 covers、同分類別條流程的進 probes；欄位只有旅行節奏一格
    assert.deepEqual(Object.keys(fw.json.options), ['pace']);
    assert.deepEqual(fw.json.options.pace.covers.map((c) => c.id), ['h-own']);
    assert.deepEqual(fw.json.options.pace.probes.map((c) => c.id), ['h-other']);
    assert.equal(fw.json.paused, false);
    await api(base, 'PUT', '/api/settings', { memory: { paused: true } });
    const fw2 = (await api(base, 'GET', `/api/memory/for-workflow/${enc('旅遊')}/${wfA.id}`)).json;
    assert.equal(fw2.paused, true);
    assert.deepEqual(fw2.core, { expression: [], content: [] }, '整層暫停＝關於你不帶');
    assert.equal(fw2.group.rules.length, 2, '群組規矩照帶');
    assert.equal(fw2.habits.own.length, 1, '習慣選項照給');
    await api(base, 'PUT', '/api/settings', { memory: { paused: false } });

    // 介紹：三題→三張認識卡（前兩張內容層、第三張表達層）；跳過→零張但記時間
    assert.equal((await api(base, 'GET', '/api/memory/intro')).json.done_at, null);
    const intro = await api(base, 'POST', '/api/memory/intro', { answers: { who: '負責人', audience: '主管', dislike: '術語' } });
    assert.equal(intro.status, 200, JSON.stringify(intro.json));
    assert.equal(intro.json.created.length, 3);
    const made = intro.json.created.map((id) => store.readCard('profile', id));
    assert.deepEqual(made.map((c) => c.layer), ['content', 'content', 'expression']);
    assert.ok(made.every((c) => c.source.kind === 'intro' && c.scope.level === 'all' && c.source.quote && c.text));
    assert.ok((await api(base, 'GET', '/api/memory/intro')).json.done_at);
    assert.ok(store.readSettings().memory.intro_done_at);
    assert.equal((await api(base, 'GET', '/api/memory/summary')).json.intro_done, true);
    await api(base, 'PUT', '/api/settings', { memory: { intro_done_at: null } });
    const partial = await api(base, 'POST', '/api/memory/intro', { answers: { who: '', audience: ' ', dislike: '長篇鋪陳' } });
    assert.equal(partial.json.created.length, 1, '空的題不成卡');
    await api(base, 'PUT', '/api/settings', { memory: { intro_done_at: null } });
    const skip = await api(base, 'POST', '/api/memory/intro', { skip: true });
    assert.equal(skip.status, 200);
    assert.deepEqual(skip.json.created, []);
    assert.ok(store.readSettings().memory.intro_done_at);

    // 通知撤回：卡進垃圾桶＋只改那一趟的通知
    const runBody = { status: 'done', memory: { identity: null, picks: {}, notices: [{ at: 'x', kind: 'card', card: 'h-own', text: '記下來了', undone: false }, { at: 'x', kind: 'card', card: 'h-inh', text: '另一張', undone: false }] } };
    store.writeRun('旅遊', wfA.id, 'r-1', runBody);
    store.writeRun('旅遊', wfA.id, 'r-2', structuredClone(runBody));
    const undo = await api(base, 'POST', '/api/memory/notices/h-own/undo', { category: '旅遊', id: wfA.id, run: 'r-1' });
    assert.equal(undo.status, 200, JSON.stringify(undo.json));
    assert.ok(undo.json.key);
    assert.equal((await api(base, 'GET', '/api/memory/cards/h-own')).status, 404);
    assert.ok((await api(base, 'GET', '/api/memory/trash')).json.some((t) => t.id === 'h-own'));
    assert.deepEqual(store.readRun('旅遊', wfA.id, 'r-1').memory.notices.map((n) => n.undone), [true, false]);
    assert.deepEqual(store.readRun('旅遊', wfA.id, 'r-2').memory.notices.map((n) => n.undone), [false, false], '別趟不動');
    const noCard = await api(base, 'POST', '/api/memory/notices/h-nope/undo', { category: '旅遊', id: wfA.id, run: 'r-1' });
    assert.equal(noCard.status, 404);
    const noRun = await api(base, 'POST', '/api/memory/notices/h-inh/undo', {});
    assert.equal(noRun.status, 200, '沒帶 run＝只丟卡');
    assert.equal((await api(base, 'GET', '/api/memory/cards/h-inh')).status, 404);
  } finally {
    await app.stop();
  }
});

test('M1b：伺服器啟動時清 30 天前的記憶垃圾桶（跟流程垃圾桶一樣只在啟動時跑一次）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-server-'));
  const store = createStore(dataDir);
  store.writeCard(manual({ id: 'h-old', bucket: 'habit', text: '舊', field: '語氣', scope: { level: 'all' } }));
  store.writeCard(manual({ id: 'h-new', bucket: 'habit', text: '新', field: '語氣', scope: { level: 'all' } }));
  const oldKey = store.trashCard('habit', 'h-old');
  const newKey = store.trashCard('habit', 'h-new');
  const metaPath = path.join(dataDir, 'memory', 'trash', oldKey, 'meta.yaml');
  const at = new Date(Date.now() - 31 * 86_400_000).toISOString();
  fs.writeFileSync(metaPath, fs.readFileSync(metaPath, 'utf8').replace(/trashed_at: .*/, `trashed_at: '${at}'`), 'utf8');
  const app = createApp({ dataDir, adapter: fakeAdapter() });
  await app.start(0);
  try {
    // 多組織：createApp 會把舊扁平版面搬進 orgs/main/，所以要從搬完的位置看（順帶證明搬家沒掉東西）
    assert.deepEqual(createStore(path.join(dataDir, 'orgs', 'main')).listMemoryTrash().map((t) => t.key), [newKey]);
  } finally {
    await app.stop();
  }
});

test('M1c：compose 帶分類→指示含分類清單、欄位詞典、該分類的群組條（只取 active）；沒群組檔→「（無）」；current_draft.category 也認、body.category 優先；分類不存在不出錯', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    const def = { format: 1, name: '訂餐廳', params: [], nodes: [{ id: 'a', title: '找店', executor: 'ai', stop_point: 'always', instruction: '列三家', next: [] }] };
    adapter.setCompleteResponses([`拆好了\n\`\`\`yaml\n${JSON.stringify(def)}\n\`\`\``]);
    await api(base, 'POST', '/api/categories', { name: '旅遊' });
    await api(base, 'POST', '/api/categories', { name: '工作' });
    await api(base, 'PUT', `/api/memory/groups/${enc('旅遊')}`, { text: '語氣：輕鬆\n不提競品' });
    const prompt = (i) => readLogFile(dataDir, 'compose', logPair(dataDir, 'compose').asked[i]);
    const r1 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '訂餐廳' }], category: '旅遊', phase: 'draft' });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    const p1 = prompt(0);
    assert.ok(p1.includes('# 分類守則\n- 語氣：輕鬆\n- 不提競品'), p1);
    assert.ok(p1.includes('# 你的分類') && p1.includes('- 旅遊') && p1.includes('- 工作'), '分類清單');
    assert.ok(p1.includes('這條流程已經放在「旅遊」'), '已知分類要講');
    assert.ok(p1.includes('# 欄位詞典') && p1.includes('- 語氣（產出的樣子；同義：口吻、風格）'), '詞典');
    assert.ok(p1.includes('12. 分類與欄位名'), '第 12 條');
    // 分類來自 current_draft.category；「工作」沒群組檔 →（無）
    const r2 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '改一下' }], current_draft: { ...def, category: '工作' } });
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    const p2 = prompt(1);
    assert.ok(p2.includes('# 分類守則\n（無）'), p2);
    assert.ok(p2.includes('這條流程已經放在「工作」'));
    // body.category 優先於 current_draft.category
    const r3 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '再改' }], category: '旅遊', current_draft: { ...def, category: '工作' } });
    assert.equal(r3.status, 200);
    assert.ok(prompt(2).includes('- 不提競品'));
    // 再存一次少一行 → 退休的條不進指示
    await api(base, 'PUT', `/api/memory/groups/${enc('旅遊')}`, { text: '不提競品' });
    const r4 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '再來' }], category: '旅遊', phase: 'draft' });
    assert.equal(r4.status, 200);
    const p4 = prompt(3);
    assert.ok(p4.includes('# 分類守則\n- 不提競品') && !p4.includes('語氣：輕鬆'), p4);
    // 分類不存在／沒給分類 →（無）且不寫「已經放在」，照樣拆
    const r5 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '拆' }], category: '沒有的', phase: 'draft' });
    assert.equal(r5.status, 200);
    const p5 = prompt(4);
    assert.ok(p5.includes('# 分類守則\n（無）') && !p5.includes('已經放在'), p5);
    const r6 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '拆' }], phase: 'draft' });
    assert.equal(r6.status, 200);
    assert.ok(prompt(5).includes('# 你的分類') && !prompt(5).includes('已經放在'));
  } finally {
    await app.stop();
  }
});

// ---- compose 帶「# 關於你」（表達層認識卡）與「# 你能派工人做什麼」（設定組字） ----

test('B2 ④：表達層認識卡→compose 指示含「# 關於你」與卡文；memory.paused 後不含；exec.web:false 後能耐表寫「不可以」；舊資料（沒 memory/）照拆', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    const def = { format: 1, name: '訂餐廳', params: [], nodes: [{ id: 'a', title: '找店', executor: 'ai', stop_point: 'always', instruction: '列三家', next: [] }] };
    adapter.setCompleteResponses([`拆好了\n\`\`\`yaml\n${JSON.stringify(def)}\n\`\`\``]);
    const prompt = (i) => readLogFile(dataDir, 'compose', logPair(dataDir, 'compose').asked[i]);
    // 舊資料：還沒有任何記憶卡 → 沒有「# 關於你」、能耐表照印（預設可查網、預設可寫檔）
    const r0 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '訂餐廳' }], phase: 'draft' });
    assert.equal(r0.status, 200, JSON.stringify(r0.json));
    const p0 = prompt(0);
    assert.ok(!p0.includes('# 關於你'), p0);
    assert.ok(p0.includes('# 你能派工人做什麼（拆步驟時照這張表安排誰做）\n- 上網查與讀網頁：可以（設定→執行與排程→AI 工人）'), p0);
    assert.ok(p0.includes('- 在產出資料夾寫檔：新流程預設可以'), p0);
    // 放一張表達層認識卡
    const made = await api(base, 'POST', '/api/memory/cards', { bucket: 'profile', text: '偏好先結論再細節', layer: 'expression', scope: { level: 'all' } });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const r1 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '訂餐廳' }], phase: 'draft' });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    const p1 = prompt(1);
    assert.ok(p1.includes('# 關於你（拆的時候把這些當已知；不用問）\n- 偏好先結論再細節'), p1);
    assert.ok(p1.indexOf('# 關於你') < p1.indexOf('# 你的分類'), '關於你在你的分類之前');
    // 暫停記憶 → 整段不印
    const paused = await api(base, 'PUT', '/api/settings', { memory: { paused: true } });
    assert.equal(paused.status, 200, JSON.stringify(paused.json));
    const r2 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '訂餐廳' }], phase: 'draft' });
    assert.equal(r2.status, 200);
    assert.ok(!prompt(2).includes('# 關於你') && !prompt(2).includes('偏好先結論'), prompt(2));
    // 關查網 → 能耐表第一行換字
    const web = await api(base, 'PUT', '/api/settings', { exec: { web: false } });
    assert.equal(web.status, 200, JSON.stringify(web.json));
    const r3 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '訂餐廳' }], phase: 'draft' });
    assert.equal(r3.status, 200);
    assert.ok(prompt(3).includes('- 上網查與讀網頁：不可以（設定關了；資料要做成欄位讓使用者貼）'), prompt(3));
    assert.ok(!prompt(3).includes('：可以（設定→執行與排程'));
  } finally {
    await app.stop();
  }
});

// ---- 四條記路接線（開跑同值／停點／回饋／聊天）、路由卷宗、通知隨回應、通知可撤 ----

const ROUTE_HABIT = '{"cards":[{"bucket":"habit","field":"住宿","kind":"method","text":"市區優先，走路到得了夜市","reason":"換個場合會填別的"}]}';
const ROUTE_PROFILE_EXP = '{"cards":[{"bucket":"profile","layer":"expression","text":"不要客套","reason":"換個場合也一樣"}]}';
const ROUTE_PROFILE_CTX = '{"cards":[{"bucket":"profile","layer":"content","text":"我常去日本","reason":"他的世界"}]}';
const ROUTE_NONE = '{"cards":[{"bucket":"none","text":"","reason":"這一趟的內容"}]}';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const memoryCalls = (adapter) => adapter.completes.filter((c) => c.meta?.kind === 'memory');

function seedFlow(dataDir, { category = '旅遊', id = 'tokyo', stop = 'never', name = '東京行程' } = {}) {
  createStore(dataDir).writeWorkflow(category, id, {
    format: 1, name, params: [{ key: 'pace', label: '旅行節奏', default: '' }],
    nodes: [{ id: 'a', title: '排行程', executor: 'ai', stop_point: stop, instruction: '排 {{pace}}', next: [] }],
  });
  return `/api/workflows/${enc(category)}/${enc(id)}`;
}

// 讓某一格「有家」：習慣卡只在對得上的欄位底下出 chip，所以要驗「照舊成習慣卡」的案例，
// 必須真的有一條流程的開跑表單有這個欄位（光把詞典撐出那一格不算——那正是 2026-09-19 修掉的後門）
function seedFieldHome(dataDir, label, { category = '旅遊', id = 'has-field', kind = 'method' } = {}) {
  const store = createStore(dataDir);
  store.writeWorkflow(category, id, {
    format: 1, name: `有「${label}」欄位的流程`, params: [{ key: 'f', label, kind, default: '' }],
    nodes: [{ id: 'a', title: '一步', executor: 'ai', stop_point: 'never', instruction: '做 {{f}}', next: [] }],
  });
  store.writeDict(ensureFields(store.readDict(), [{ label, kind }], { category, workflow: id }).dict);
}

test('M2 記路③：跑完回饋→路由成習慣卡（出處 feedback、用在這條流程、route_reason）＋memory_notice card＋run 通知＋logs/memory 兩檔；詞典長出新欄位；判 none 不成卡', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    const wfP = seedFlow(dataDir);
    const started = await api(base, 'POST', `${wfP}/runs`, { overrides: { pace: '一天 3 個點' } });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const runPath = `${wfP}/runs/${started.json.run_id}`;
    await pollRun(base, runPath, (r) => r.status === 'done');
    seedFieldHome(dataDir, '住宿');
    adapter.setRouteResponses([ROUTE_HABIT]);
    const fb = await api(base, 'POST', `${runPath}/run-feedback`, { text: '民宿太遠了，以後選市區的' });
    assert.equal(fb.status, 200, JSON.stringify(fb.json));
    assert.equal(fb.json.ok, true);
    const n = fb.json.memory_notice;
    assert.equal(n.kind, 'card');
    assert.ok(n.card.startsWith('h-'));
    assert.equal(n.undone, false);
    assert.ok(n.at);
    assert.ok(n.text.includes('市區優先'), n.text);
    const cards = (await api(base, 'GET', '/api/memory/cards?bucket=habit')).json;
    assert.equal(cards.length, 1);
    const c = cards[0];
    assert.equal(c.id, n.card);
    assert.equal(c.field, '住宿');
    assert.equal(c.text, '市區優先，走路到得了夜市');
    assert.equal(c.source.kind, 'feedback');
    assert.equal(c.source.quote, '民宿太遠了，以後選市區的');
    assert.equal(c.source.run, started.json.run_id);
    assert.deepEqual(c.scope, { level: 'workflow', category: '旅遊', workflow: 'tokyo' });
    assert.equal(c.route_reason, '換個場合會填別的');
    assert.equal((await api(base, 'GET', '/api/memory/dict')).json.fields.find((f) => f.name === '住宿')?.kind, 'method', '詞典有這一格，所以照舊成習慣卡');
    const run = (await api(base, 'GET', runPath)).json;
    assert.equal(run.feedback, '民宿太遠了，以後選市區的', '回饋本身照舊存');
    assert.deepEqual(run.memory.notices.map((x) => x.kind), ['card']);
    const logs = logPair(dataDir, 'memory');
    assert.equal(logs.asked.length, 1, '路由指示留卷宗');
    assert.equal(logs.replied.length, 1, '回覆也留');
    assert.ok(logs.asked[0].includes('旅遊') && logs.asked[0].includes('tokyo'), `卷宗名標到流程：${logs.asked[0]}`);
    const routePrompt = readLogFile(dataDir, 'memory', logs.asked[0]);
    assert.ok(routePrompt.includes('# 他說的話\n民宿太遠了，以後選市區的'));
    assert.ok(routePrompt.includes('這句是跑完的回饋，通常記成習慣卡'));
    assert.ok(routePrompt.includes('# 這條流程的欄位\n- 旅行節奏'));
    const routeCall = memoryCalls(adapter)[0];
    assert.equal(routeCall.prompt, routePrompt, '存的全文＝送出的全文');
    assert.deepEqual(routeCall.meta, { kind: 'memory', phase: 'route', category: '旅遊', workflow: 'tokyo', run: started.json.run_id, node: '_memory', org: 'main' });
    // 路由判 none → 通知 none、不成卡
    adapter.setRouteResponses([ROUTE_NONE]);
    const fb2 = await api(base, 'POST', `${runPath}/run-feedback`, { text: '這趟還不錯' });
    assert.equal(fb2.status, 200);
    assert.equal(fb2.json.memory_notice.kind, 'none');
    assert.equal(fb2.json.memory_notice.card, null);
    assert.equal((await api(base, 'GET', '/api/memory/cards?bucket=habit')).json.length, 1);
  } finally {
    await app.stop();
  }
});

test('M2 記路③：回饋路由成認識卡→200、memory_notice card、卡落 profile/、出處 feedback、用在這個分類、route_reason 非空；habit 一張都不長', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    const wfP = seedFlow(dataDir);
    const started = await api(base, 'POST', `${wfP}/runs`, { overrides: { pace: '一天 3 個點' } });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const runPath = `${wfP}/runs/${started.json.run_id}`;
    await pollRun(base, runPath, (r) => r.status === 'done');
    adapter.setRouteResponses([ROUTE_PROFILE_CTX]);
    const fb = await api(base, 'POST', `${runPath}/run-feedback`, { text: '我常去日本' });
    assert.equal(fb.status, 200, JSON.stringify(fb.json));
    const n = fb.json.memory_notice;
    assert.equal(n.kind, 'card');
    assert.ok(n.card.startsWith('p-'), `認識卡 id：${n.card}`);
    const profile = (await api(base, 'GET', '/api/memory/cards?bucket=profile')).json;
    assert.equal(profile.length, 1);
    const c = profile[0];
    assert.equal(c.id, n.card);
    assert.equal(c.layer, 'content');
    assert.equal(c.text, '我常去日本');
    assert.equal(c.source.kind, 'feedback', '這句話是跑完丟的一句結果，出處就寫 feedback，不要標成聊天');
    assert.equal(c.source.run, started.json.run_id);
    assert.equal(c.source.quote, '我常去日本');
    assert.deepEqual(c.scope, { level: 'category', category: '旅遊', workflow: null }, '有分類＝用在這個分類');
    assert.ok(typeof c.route_reason === 'string' && c.route_reason.trim(), 'route_reason 非空');
    assert.ok(fs.existsSync(path.join(dataDir, 'memory', 'profile', `${c.id}.yaml`)), '卡檔落在 memory/profile/');
    assert.deepEqual((await api(base, 'GET', '/api/memory/cards?bucket=habit')).json, [], '習慣卡一張都不長');
    assert.deepEqual((await api(base, 'GET', runPath)).json.memory.notices.map((x) => x.kind), ['card']);
  } finally {
    await app.stop();
  }
});

test('M2 記路③：路由丟錯或回純文字→200 且 memory_notice.kind=fail（人話）、卡不長、run 留 fail 通知；優化員照樣被叫', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    const wfP = seedFlow(dataDir);
    const started = await api(base, 'POST', `${wfP}/runs`, { overrides: { pace: '一天 3 個點' } });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const runPath = `${wfP}/runs/${started.json.run_id}`;
    await pollRun(base, runPath, (r) => r.status === 'done');
    adapter.setRouteResponses([() => { throw new Error('連不上 Claude（測試注入）'); }]);
    adapter.setCompleteResponses(['了解\n```yaml\nnode_id: a\nsummary: 要不要先問住宿？\nnew_instruction: 先問住宿再排\n```']);
    const fb = await api(base, 'POST', `${runPath}/run-feedback`, { text: '民宿太遠' });
    assert.equal(fb.status, 200, JSON.stringify(fb.json));
    assert.equal(fb.json.ok, true);
    assert.equal(fb.json.memory_notice.kind, 'fail');
    assert.equal(fb.json.memory_notice.card, null);
    assert.ok(fb.json.memory_notice.text.startsWith('這句沒記成：'), fb.json.memory_notice.text);
    assert.deepEqual((await api(base, 'GET', '/api/memory/cards')).json, []);
    for (let i = 0; i < 100 && !adapter.completes.some((c) => c.meta?.kind === 'optimize'); i++) await sleep(20);
    assert.ok(adapter.completes.some((c) => c.meta?.kind === 'optimize'), '優化員照樣被叫（兩邊互不等待）');
    assert.equal((await api(base, 'GET', runPath)).json.memory.notices[0].kind, 'fail');
    // 登入過期時宿主回的是純文字→一樣是 fail，不 throw
    adapter.setRouteResponses(['請先登入 Claude']);
    const fb2 = await api(base, 'POST', `${runPath}/run-feedback`, { text: '再一句' });
    assert.equal(fb2.status, 200);
    assert.equal(fb2.json.memory_notice.kind, 'fail');
  } finally {
    await app.stop();
  }
});

test('M2 記路②：停點第一趟改→first-edit 通知不記不問；第二趟改＋註記→路由成習慣卡（出處 stop-edit）；第二趟註記空→不記；註記含「以後都」→第一趟就成認識卡表達層（出處 stop-note）', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    const wfP = seedFlow(dataDir, { stop: 'always' });
    let trip = 0; // 每趟填不同的值：這個測試只看記路②，不讓記路①（同值連兩趟）也記一張
    const runOnce = async (wf, note, routeReply) => {
      const started = await api(base, 'POST', `${wf}/runs`, { overrides: { pace: `一天 ${++trip} 個點` } });
      assert.equal(started.status, 200, JSON.stringify(started.json));
      const runPath = `${wf}/runs/${started.json.run_id}`;
      await pollRun(base, runPath, (r) => r.steps.a.status === 'waiting_review');
      adapter.setRouteResponses([routeReply]);
      const res = await api(base, 'POST', `${runPath}/edit`, { node: 'a', output: '改過的行程', note });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      await pollRun(base, runPath, (r) => r.status === 'done');
      return { runPath, run_id: started.json.run_id };
    };
    seedFieldHome(dataDir, '住宿');
    // 第一趟：first-edit 通知（門面另起一條，稍後才寫）
    const r1 = await runOnce(wfP, '', ROUTE_HABIT);
    const run1 = await pollRun(base, r1.runPath, (r) => (r.memory?.notices ?? []).length > 0);
    assert.equal(run1.memory.notices[0].kind, 'first-edit');
    assert.equal(run1.memory.notices[0].card, null);
    assert.ok(run1.memory.notices[0].text.includes('「排行程」') && run1.memory.notices[0].text.includes('第一次'), run1.memory.notices[0].text);
    assert.deepEqual((await api(base, 'GET', '/api/memory/cards')).json, [], '第一趟不記');
    assert.equal(memoryCalls(adapter).length, 0, '第一趟不打路由');
    // 第二趟：連兩趟改同一步＋有註記→路由（提示＝停點註記、通常習慣卡）
    const r2 = await runOnce(wfP, '住宿選市區的', ROUTE_HABIT);
    const run2 = await pollRun(base, r2.runPath, (r) => (r.memory?.notices ?? []).length > 0);
    assert.equal(run2.memory.notices[0].kind, 'card');
    const h = (await api(base, 'GET', '/api/memory/cards?bucket=habit')).json;
    assert.equal(h.length, 1);
    assert.equal(h[0].id, run2.memory.notices[0].card);
    assert.equal(h[0].source.kind, 'stop-edit');
    assert.equal(h[0].source.node, 'a');
    assert.equal(h[0].source.run, r2.run_id);
    assert.equal(h[0].source.quote, '住宿選市區的');
    assert.deepEqual(h[0].scope, { level: 'workflow', category: '旅遊', workflow: 'tokyo' });
    const routeCall = memoryCalls(adapter)[0];
    assert.equal(routeCall.meta.node, 'a');
    assert.equal(routeCall.meta.run, r2.run_id);
    assert.ok(routeCall.prompt.includes('這句是停點註記，通常記成習慣卡'));
    // 第三趟：改了但註記空→沒句子可記：不打路由、沒通知
    const before = memoryCalls(adapter).length;
    const r3 = await runOnce(wfP, '', ROUTE_HABIT);
    await sleep(100);
    assert.deepEqual((await api(base, 'GET', r3.runPath)).json.memory.notices, []);
    assert.equal(memoryCalls(adapter).length, before);
    // 「以後都」：另一條流程第一趟就走路由，且不管路由怎麼判都強制成認識卡（表達層、出處 stop-note、用在全部）
    const wfQ = seedFlow(dataDir, { id: 'osaka', name: '大阪行程', stop: 'always' });
    const started = await api(base, 'POST', `${wfQ}/runs`, { overrides: { pace: '一天 9 個點' } });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const runPath = `${wfQ}/runs/${started.json.run_id}`;
    await pollRun(base, runPath, (r) => r.steps.a.status === 'waiting_review');
    adapter.setRouteResponses([ROUTE_HABIT]);
    await api(base, 'POST', `${runPath}/edit`, { node: 'a', output: '改過', note: '以後都這樣，不要客套' });
    const runQ = await pollRun(base, runPath, (r) => (r.memory?.notices ?? []).length > 0);
    assert.equal(runQ.memory.notices[0].kind, 'card');
    assert.ok(runQ.memory.notices[0].card.startsWith('p-'), runQ.memory.notices[0].card);
    const p = (await api(base, 'GET', `/api/memory/cards/${runQ.memory.notices[0].card}`)).json;
    assert.equal(p.bucket, 'profile');
    assert.equal(p.layer, 'expression');
    assert.equal(p.source.kind, 'stop-note');
    assert.equal(p.source.quote, '以後都這樣，不要客套');
    assert.equal(p.scope.level, 'all');
    assert.ok(fs.existsSync(path.join(dataDir, 'memory', 'profile', `${p.id}.yaml`)));
    assert.ok(memoryCalls(adapter).at(-1).prompt.includes('這句是停點註記，通常記成認識卡'));
  } finally {
    await app.stop();
  }
});

test('M2 記路④：聊天→compose 成功後只路由最後一句使用者話；回應多 memory_notice；新草稿 scope=all、有分類 scope=category；判 none→null；路由壞→fail 不擋拆流程；拆流程失敗不路由', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    const def = { format: 1, name: '訂餐廳', params: [], nodes: [{ id: 'a', title: '找店', executor: 'ai', stop_point: 'always', instruction: '列三家', next: [] }] };
    adapter.setCompleteResponses([`拆好了\n\`\`\`yaml\n${JSON.stringify(def)}\n\`\`\``]);
    adapter.setRouteResponses([ROUTE_PROFILE_CTX]);
    const r1 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '我常去日本，幫我排行程' }], phase: 'draft' });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.equal(r1.json.draft.name, '訂餐廳');
    const n1 = r1.json.memory_notice;
    assert.equal(n1.kind, 'card');
    assert.ok(n1.card.startsWith('p-'));
    const c1 = (await api(base, 'GET', `/api/memory/cards/${n1.card}`)).json;
    assert.equal(c1.layer, 'content');
    assert.equal(c1.text, '我常去日本');
    assert.equal(c1.source.kind, 'chat');
    assert.equal(c1.source.quote, '我常去日本，幫我排行程');
    assert.deepEqual(c1.scope, { level: 'all', category: null, workflow: null }, '新草稿＝全部');
    const call = memoryCalls(adapter)[0];
    assert.deepEqual(call.meta, { kind: 'memory', phase: 'route', category: null, workflow: null, run: null, node: '_memory', org: 'main' });
    assert.ok(call.prompt.includes('# 他說的話\n我常去日本，幫我排行程') && call.prompt.includes('這句是聊天，通常記成認識卡'));
    assert.equal(logPair(dataDir, 'memory').asked.length, 1);
    // 已存流程所在分類：scope=category；只路由最後一句使用者話
    await api(base, 'POST', '/api/categories', { name: '旅遊' });
    adapter.setRouteResponses([ROUTE_PROFILE_EXP]);
    const r2 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '第一句' }, { role: 'ai', text: '好' }, { role: 'user', text: '以後不要客套' }], category: '旅遊', phase: 'draft' });
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    assert.equal(r2.json.memory_notice.kind, 'card');
    const c2 = (await api(base, 'GET', `/api/memory/cards/${r2.json.memory_notice.card}`)).json;
    assert.equal(c2.layer, 'expression');
    assert.deepEqual(c2.scope, { level: 'category', category: '旅遊', workflow: null });
    assert.equal(c2.source.quote, '以後不要客套');
    const call2 = memoryCalls(adapter).at(-1);
    assert.equal(call2.meta.category, '旅遊');
    assert.ok(call2.prompt.includes('# 他說的話\n以後不要客套') && !call2.prompt.includes('第一句'));
    // none → null；路由壞 → fail 但拆流程照樣 200
    adapter.setRouteResponses([ROUTE_NONE]);
    const r3 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '第 2 步加停點' }], phase: 'draft' });
    assert.equal(r3.status, 200);
    assert.equal(r3.json.memory_notice, null);
    adapter.setRouteResponses([() => { throw new Error('連不上 Claude（測試注入）'); }]);
    const r4 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '再改' }], phase: 'draft' });
    assert.equal(r4.status, 200, JSON.stringify(r4.json));
    assert.equal(r4.json.draft.name, '訂餐廳');
    assert.equal(r4.json.memory_notice.kind, 'fail');
    assert.ok(r4.json.memory_notice.text.startsWith('這句沒記成：'));
    assert.equal((await api(base, 'GET', '/api/memory/cards')).json.length, 2);
    // 拆流程本身失敗→不路由（沒有回應可掛通知）
    const before = memoryCalls(adapter).length;
    adapter.setCompleteResponses(['亂七八糟']);
    assert.equal((await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '拆' }], phase: 'draft' })).status, 400);
    assert.equal(memoryCalls(adapter).length, before);
  } finally {
    await app.stop();
  }
});

test('M2 開跑：POST /runs 的 memory_picks／memory_changed／memory_identity 進 run.memory；記路①同值連兩趟→回的 run 帶 card 通知；undo 後該趟通知 undone、卡進垃圾桶', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const wfP = seedFlow(dataDir);
    const s1 = await api(base, 'POST', `${wfP}/runs`, { overrides: { pace: '一天 3 個點' }, memory_picks: { pace: 'h-1' }, memory_changed: ['h-2'], memory_identity: 'i-1' });
    assert.equal(s1.status, 200, JSON.stringify(s1.json));
    assert.deepEqual(s1.json.memory, { identity: 'i-1', picks: { pace: 'h-1' }, changed: ['h-2'], prev_run: null, notices: [] });
    await pollRun(base, `${wfP}/runs/${s1.json.run_id}`, (r) => r.status === 'done');
    const s2 = await api(base, 'POST', `${wfP}/runs`, { overrides: { pace: '一天 3 個點' } });
    assert.equal(s2.status, 200, JSON.stringify(s2.json));
    assert.deepEqual(s2.json.memory.picks, {});
    assert.equal(s2.json.memory.identity, null);
    assert.equal(s2.json.memory.prev_run, s1.json.run_id, '前一趟＝開跑前清單的最後一筆');
    assert.equal(s2.json.memory.notices.length, 1, '同值連兩趟＝一張卡一行通知');
    const n = s2.json.memory.notices[0];
    assert.equal(n.kind, 'card');
    assert.ok(n.card.startsWith('h-'));
    assert.equal(n.undone, false);
    assert.ok(n.text.includes('一天 3 個點'), n.text);
    const card = (await api(base, 'GET', `/api/memory/cards/${n.card}`)).json;
    assert.equal(card.source.kind, 'run-params');
    assert.equal(card.field, '旅行節奏');
    assert.equal(card.text, '一天 3 個點');
    assert.deepEqual(card.scope, { level: 'workflow', category: '旅遊', workflow: 'tokyo' });
    const runPath2 = `${wfP}/runs/${s2.json.run_id}`;
    await pollRun(base, runPath2, (r) => r.status === 'done');
    assert.equal((await api(base, 'GET', runPath2)).json.memory.notices[0].kind, 'card', '跑完通知還在（runner 的寫入沒蓋掉）');
    const undo = await api(base, 'POST', `/api/memory/notices/${n.card}/undo`, { category: '旅遊', id: 'tokyo', run: s2.json.run_id });
    assert.equal(undo.status, 200, JSON.stringify(undo.json));
    assert.equal((await api(base, 'GET', runPath2)).json.memory.notices[0].undone, true);
    assert.equal((await api(base, 'GET', `/api/memory/cards/${n.card}`)).status, 404);
    assert.ok((await api(base, 'GET', '/api/memory/trash')).json.some((t) => t.id === n.card));
  } finally {
    await app.stop();
  }
});

// ---- 開跑表單的習慣選項（for-workflow.options）、點了即核可（計數）、範圍靠證據擴大（widen 通知）、身分限縮 ----

test('M3b for-workflow.options：同分類另一條流程的 workflow 尺度卡進 probes（帶來源流程名）、本流程的進 covers；沒卡的欄位沒有鍵', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    await api(base, 'POST', '/api/categories', { name: '旅遊' });
    const mkWf = async (name) => (await api(base, 'POST', '/api/workflows', { category: '旅遊', def: M1B_DEF({ name, params: [{ key: 'pace', label: '旅行節奏', default: '' }, { key: 'len', label: '長度', default: '' }] }) })).json;
    const wfA = await mkWf('東京行程');
    const wfB = await mkWf('大阪行程');
    store.writeCard(manual({ id: 'h-a', bucket: 'habit', text: '一天 3 個點', field: '旅行節奏', scope: { level: 'workflow', category: '旅遊', workflow: wfA.id } }));
    store.writeCard(manual({ id: 'h-b', bucket: 'habit', text: '一天 5 個點', field: '旅行節奏', scope: { level: 'workflow', category: '旅遊', workflow: wfB.id } }));
    store.writeCard(manual({ id: 'h-dormant', bucket: 'habit', text: '休眠的', field: '旅行節奏', scope: { level: 'workflow', category: '旅遊', workflow: wfB.id }, status: 'dormant' }));
    const fw = await api(base, 'GET', `/api/memory/for-workflow/${enc('旅遊')}/${wfB.id}`);
    assert.equal(fw.status, 200, JSON.stringify(fw.json));
    assert.equal(fw.json.options.pace.probes[0].id, 'h-a', '別條流程（A）生的卡在 B 的開跑表單是虛線選項');
    assert.equal(fw.json.options.pace.probes[0].from, '東京行程');
    assert.deepEqual(fw.json.options.pace.covers.map((c) => c.id), ['h-b']);
    assert.ok(!('len' in fw.json.options), '沒卡的欄位不出現');
    const fwA = (await api(base, 'GET', `/api/memory/for-workflow/${enc('旅遊')}/${wfA.id}`)).json;
    assert.deepEqual(fwA.options.pace.covers.map((c) => c.id), ['h-a']);
    assert.deepEqual(fwA.options.pace.probes.map((c) => c.id), ['h-b'], '休眠的不列');
  } finally {
    await app.stop();
  }
});

test('M3b POST /runs：memory_picks→run.memory.picks＋picked_count；memory_changed→changed_count；probes 被選→範圍擴到分類＋widen 通知；memory_identity→steps.a.memory.cards 只含該身分的認識卡', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const wfP = seedFlow(dataDir); // 旅遊／tokyo，欄位 pace＝旅行節奏，步驟 a 引用 {{pace}}
    store.writeWorkflow('旅遊', 'osaka', { format: 1, name: '大阪行程', params: [{ key: 'pace', label: '旅行節奏', default: '' }], nodes: [{ id: 'a', title: '排', executor: 'ai', stop_point: 'never', instruction: '排 {{pace}}', next: [] }] });
    store.writeCard(manual({ id: 'h-1', bucket: 'habit', text: '一天 3 個點', field: '旅行節奏', scope: { level: 'workflow', category: '旅遊', workflow: 'tokyo' } }));
    store.writeCard(manual({ id: 'h-2', bucket: 'habit', text: '一天 5 個點', field: '旅行節奏', scope: { level: 'workflow', category: '旅遊', workflow: 'tokyo' } }));
    store.writeCard(manual({ id: 'h-osaka', bucket: 'habit', text: '一天 8 個點', field: '旅行節奏', scope: { level: 'workflow', category: '旅遊', workflow: 'osaka' } }));
    store.writeCard(manual({ id: 'p-1', bucket: 'profile', text: '不要客套', layer: 'expression', scope: { level: 'all' } }));
    store.writeCard(manual({ id: 'p-2', bucket: 'profile', text: '用詞白話', layer: 'expression', scope: { level: 'all' } }));
    store.writeIdentities([{ id: 'i-1', name: '工作的我', cards: ['p-2'], categories: [], created_at: '2026-09-09T00:00:00.000Z' }]);

    const s1 = await api(base, 'POST', `${wfP}/runs`, { overrides: { pace: '一天 3 個點' }, memory_picks: { pace: 'h-1' }, memory_changed: ['h-2'] });
    assert.equal(s1.status, 200, JSON.stringify(s1.json));
    assert.equal(s1.json.memory.picks.pace, 'h-1');
    assert.deepEqual(s1.json.memory.changed, ['h-2']);
    assert.deepEqual(s1.json.memory.notices, [], '本流程的卡：沒有擴大通知');
    const h1 = (await api(base, 'GET', '/api/memory/cards/h-1')).json;
    assert.equal(h1.picked_count, 1);
    assert.equal(h1.shown_count, 1);
    assert.equal(typeof h1.last_used_at, 'string');
    const h2 = (await api(base, 'GET', '/api/memory/cards/h-2')).json;
    assert.equal(h2.changed_count, 1);
    assert.equal(h2.picked_count, 0);
    assert.equal(h2.shown_count, 1);
    const hO = (await api(base, 'GET', '/api/memory/cards/h-osaka')).json;
    assert.equal(hO.shown_count, 1, '虛線選項也算出現過');
    assert.equal(hO.unpicked_streak, 1);
    assert.equal(hO.scope.level, 'workflow', '沒點就不擴');
    await pollRun(base, `${wfP}/runs/${s1.json.run_id}`, (r) => r.status === 'done');

    // 虛線（別條流程的）被選→擴到分類＋一行 widen 通知
    const s2 = await api(base, 'POST', `${wfP}/runs`, { overrides: { pace: '一天 8 個點' }, memory_picks: { pace: 'h-osaka' } });
    assert.equal(s2.status, 200, JSON.stringify(s2.json));
    const widen = s2.json.memory.notices.filter((n) => n.kind === 'widen');
    assert.equal(widen.length, 1, JSON.stringify(s2.json.memory.notices));
    assert.equal(widen[0].card, 'h-osaka');
    assert.equal(widen[0].text, '「一天 8 個點」的範圍從「大阪行程」擴大到旅遊分類：你在第二條 Workflow 也選了它。仍是選項，沒有升格');
    const hO2 = (await api(base, 'GET', '/api/memory/cards/h-osaka')).json;
    assert.deepEqual(hO2.scope, { level: 'category', category: '旅遊', workflow: null });
    assert.equal(hO2.scope_log.length, 1);
    assert.equal(hO2.picked_count, 1);
    await pollRun(base, `${wfP}/runs/${s2.json.run_id}`, (r) => r.status === 'done');
    const fw = (await api(base, 'GET', `/api/memory/for-workflow/${enc('旅遊')}/tokyo`)).json;
    assert.ok(fw.options.pace.covers.some((c) => c.id === 'h-osaka'), '擴到分類後在本流程變實線');
    assert.ok(!fw.options.pace.probes.some((c) => c.id === 'h-osaka'));

    // 身分：只帶它列的認識卡（前兩趟沒帶身分，p-1／p-2 都被帶過、都有 last_used_at；這趟只有 p-2 會再更新）
    const p1Before = (await api(base, 'GET', '/api/memory/cards/p-1')).json.last_used_at;
    assert.equal(typeof p1Before, 'string', '前兩趟帶進工作單的認識卡寫了 last_used_at');
    await new Promise((r) => setTimeout(r, 5));
    const s3 = await api(base, 'POST', `${wfP}/runs`, { overrides: { pace: '一天 3 個點' }, memory_picks: { pace: 'h-1' }, memory_identity: 'i-1' });
    assert.equal(s3.status, 200, JSON.stringify(s3.json));
    assert.equal(s3.json.memory.identity, 'i-1');
    const done = await pollRun(base, `${wfP}/runs/${s3.json.run_id}`, (r) => r.status === 'done');
    const cards = done.steps.a.memory.cards;
    assert.deepEqual(cards.filter((c) => c.bucket === 'profile').map((c) => c.id), ['p-2'], '身分沒列的 p-1 不帶');
    assert.deepEqual(cards.filter((c) => c.bucket === 'habit').map((c) => c.id), ['h-1'], '被選的習慣卡進引用它那一步');
    assert.ok((await api(base, 'GET', '/api/memory/cards/p-2')).json.last_used_at > p1Before, '這趟帶了 p-2：last_used_at 往後推');
    assert.equal((await api(base, 'GET', '/api/memory/cards/p-1')).json.last_used_at, p1Before, '這趟沒帶 p-1：不動');
  } finally {
    await app.stop();
  }
});

test('M4：GET /api/dashboard 多 memory.exceptions＝到期＋休眠＋被取代的數（各塞一張）；沒卡時全 0', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const empty = (await api(base, 'GET', '/api/dashboard')).json;
    assert.deepEqual(empty.memory, { exceptions: { expired: 0, dormant: 0, replaced: 0, total: 0 } });
    const store = createStore(dataDir);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    store.writeCard(manual({ id: 'p-exp', bucket: 'profile', text: '到期的', layer: 'expression', scope: { level: 'all' }, expires: yesterday }));
    store.writeCard(manual({ id: 'p-live', bucket: 'profile', text: '還沒到期', layer: 'expression', scope: { level: 'all' }, expires: '2099-01-01' }));
    store.writeCard({ ...manual({ id: 'h-dorm', bucket: 'habit', text: '休眠的', field: '語氣', scope: { level: 'all' } }), status: 'dormant' });
    store.writeCard({ ...manual({ id: 'h-old', bucket: 'habit', text: '舊的', field: '語氣', scope: { level: 'all' } }), status: 'replaced', replaced_by: 'h-new' });
    store.writeCard(manual({ id: 'h-new', bucket: 'habit', text: '新的', field: '語氣', scope: { level: 'all' } }));
    store.writeCard({ ...manual({ id: 'h-ret', bucket: 'habit', text: '退休的', field: '語氣', scope: { level: 'all' } }), status: 'retired' });
    const dash = (await api(base, 'GET', '/api/dashboard')).json;
    assert.deepEqual(dash.memory, { exceptions: { expired: 1, dormant: 1, replaced: 1, total: 3 } }, '退休、還沒到期的、活著的都不算');
    assert.ok(Array.isArray(dash.recent) && Array.isArray(dash.usage), '既有欄位不變');
  } finally {
    await app.stop();
  }
});

// ---- 設定頁的資料源——身分預設綁分類（for-workflow 的 core 只含該身分的卡）、身分改了讀回一致、詞典「用在哪些流程」算出來 ----

test('M5a for-workflow：綁了這個分類的身分＝預設只帶它列的認識卡並回 identity；?identity= 指定別的或空＝照指定／不限縮；找不到的身分＝不限縮；PUT 身分後讀回一致', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const wfP = seedFlow(dataDir); // 旅遊／tokyo
    store.writeCard(manual({ id: 'p-1', bucket: 'profile', text: '不要客套', layer: 'expression', scope: { level: 'all' } }));
    store.writeCard(manual({ id: 'p-2', bucket: 'profile', text: '用詞白話', layer: 'expression', scope: { level: 'all' } }));
    store.writeCard(manual({ id: 'p-3', bucket: 'profile', text: '我常去日本', layer: 'content', scope: { level: 'category', category: '旅遊' } }));
    const fwPath = `/api/memory/for-workflow/${enc('旅遊')}/tokyo`;
    const none = (await api(base, 'GET', fwPath)).json;
    assert.deepEqual(none.core.expression.map((c) => c.id), ['p-1', 'p-2'], '沒有身分：全部都帶');
    assert.equal(none.identity, null);

    const trip = await api(base, 'POST', '/api/memory/identities', { name: '旅遊的我', cards: ['p-2', 'p-3'], categories: ['旅遊'] });
    assert.equal(trip.status, 200, JSON.stringify(trip.json));
    const work = await api(base, 'POST', '/api/memory/identities', { name: '工作的我', cards: ['p-1'], categories: ['工作'] });
    assert.equal(work.status, 200);

    const bound = (await api(base, 'GET', fwPath)).json;
    assert.equal(bound.identity, trip.json.id, '綁了旅遊分類的身分＝預設');
    assert.deepEqual(bound.core.expression.map((c) => c.id), ['p-2'], 'core 只含該身分列的卡');
    assert.deepEqual(bound.core.content.map((c) => c.id), ['p-3']);
    assert.deepEqual(bound.group.rules, [], '其他欄位形狀不變');
    assert.equal(bound.paused, false);

    const other = (await api(base, 'GET', `${fwPath}?identity=${enc(work.json.id)}`)).json;
    assert.equal(other.identity, work.json.id, '指定別的身分就用它');
    assert.deepEqual(other.core.expression.map((c) => c.id), ['p-1']);
    assert.deepEqual(other.core.content, []);

    const unlimited = (await api(base, 'GET', `${fwPath}?identity=`)).json;
    assert.equal(unlimited.identity, null, '空字串＝不指定');
    assert.deepEqual(unlimited.core.expression.map((c) => c.id), ['p-1', 'p-2']);

    const missing = (await api(base, 'GET', `${fwPath}?identity=i-nope`)).json;
    assert.equal(missing.identity, null, '找不到的身分＝不限縮（跟 runner 一樣）');
    assert.deepEqual(missing.core.expression.map((c) => c.id), ['p-1', 'p-2']);

    // 素材庫「身分」頁：改卡勾選、綁分類、改名後讀回一致；刪了預設就沒了
    const up = await api(base, 'PUT', `/api/memory/identities/${trip.json.id}`, { name: '週末旅人的我', cards: ['p-1'], categories: ['旅遊', '生活'] });
    assert.equal(up.status, 200);
    const list = (await api(base, 'GET', '/api/memory/identities')).json;
    assert.deepEqual(list.map((i) => [i.id, i.name, i.cards, i.categories]), [
      [trip.json.id, '週末旅人的我', ['p-1'], ['旅遊', '生活']],
      [work.json.id, '工作的我', ['p-1'], ['工作']],
    ]);
    assert.deepEqual((await api(base, 'GET', fwPath)).json.core.expression.map((c) => c.id), ['p-1'], '改了勾選，預設帶的跟著變');
    await api(base, 'DELETE', `/api/memory/identities/${trip.json.id}`);
    const after = (await api(base, 'GET', fwPath)).json;
    assert.equal(after.identity, null);
    assert.deepEqual(after.core.expression.map((c) => c.id), ['p-1', 'p-2']);
  } finally {
    await app.stop();
  }
});

test('M5a 詞典：GET /api/memory/dict?usage=1 多 usage＝每個欄位用在哪些流程（同義詞也對得到、壞檔跳過）；不帶 ?usage 形狀不變', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    seedFlow(dataDir); // 旅遊／tokyo：欄位「旅行節奏」（詞典要先長出來——seedFlow 直接寫檔不經 POST，這裡用手動卡的路補）
    store.writeDict({ ...store.readDict(), fields: [...store.readDict().fields, { name: '旅行節奏', kind: 'method', synonyms: [], origin: { category: '旅遊', workflow: 'tokyo' }, created_at: '2026-09-09T00:00:00.000Z' }] });
    store.writeWorkflow('工作', 'weekly', { format: 1, name: '週報', params: [{ key: 'tone', label: '口吻', default: '' }, { key: 'len', label: '篇幅', default: '' }], nodes: [{ id: 'a', title: '寫', executor: 'ai', stop_point: 'never', instruction: '寫 {{tone}} {{len}}', next: [] }] });
    fs.mkdirSync(path.join(dataDir, 'workflows', '工作', 'broken'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'workflows', '工作', 'broken', 'workflow.yaml'), 'name: [壞的\n', 'utf8');
    const plain = (await api(base, 'GET', '/api/memory/dict')).json;
    assert.equal(plain.usage, undefined, '沒要 usage 就不算');
    const withUsage = (await api(base, 'GET', '/api/memory/dict?usage=1')).json;
    assert.equal(withUsage.fields.length, plain.fields.length);
    assert.deepEqual(withUsage.usage['旅行節奏'], [{ category: '旅遊', id: 'tokyo', name: '東京行程' }]);
    // 開站播種的範例流程「寫週報」也用「語氣」，所以用 some 而不是整條 deepEqual
    const weekly = { category: '工作', id: 'weekly', name: '週報' };
    assert.ok(withUsage.usage['語氣'].some((u) => u.category === weekly.category && u.id === weekly.id && u.name === weekly.name), '「口吻」是「語氣」的同義詞');
    assert.deepEqual(withUsage.usage['長度'], [weekly], '「篇幅」是「長度」的同義詞（範例的「講稿長度」不是同義詞，不算）');
    assert.deepEqual(withUsage.usage['讀者'], [], '沒流程用到＝空陣列（不是缺鍵）');
    assert.equal(withUsage.usage['語氣'].filter((u) => u.id === 'weekly').length, 1, '同一條流程只算一次');
  } finally {
    await app.stop();
  }
});

// ---- 共用檔 API（/api/shared/:scope/files）、公司名稱設定、分類名禁 _company ----
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const sharedPath = (scope, name) => `/api/shared/${enc(scope)}/files${name ? `/${enc(name)}` : ''}`;

test('U1a ③：共用檔 API——空夾不是 404；規範三份 2000／3000／3001 第三份 413；單檔 4001 413；參考任何副檔名；規範 xlsx／pdf 400；同名 409；沒有的分類 404；跨層同名各列各的；下載', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    assert.equal(fs.existsSync(path.join(dataDir, 'shared')), false, '舊資料：沒有 data/shared/ 目錄');
    const empty = await api(base, 'GET', sharedPath('_company'));
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { scope: '_company', rules: [], refs: [], rule_chars: 0, limits: { per_file: 4000, per_layer: 8000 } });
    assert.equal((await api(base, 'GET', sharedPath('沒有的分類'))).status, 404);
    assert.equal((await api(base, 'POST', sharedPath('沒有的分類'), { name: 'a.md', kind: 'rule', content_b64: b64('x') })).status, 404);

    const r1 = await api(base, 'POST', sharedPath('_company'), { name: '手冊.md', kind: 'rule', content_b64: b64('甲'.repeat(2000)) });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.equal(r1.json.rule_chars, 2000);
    assert.deepEqual(r1.json.rules.map((f) => [f.name, f.chars]), [['手冊.md', 2000]]);
    assert.ok(r1.json.rules[0].uploaded_at);
    const r2 = await api(base, 'POST', sharedPath('_company'), { name: '語氣.txt', kind: 'rule', content_b64: b64('乙'.repeat(3000)) });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.rule_chars, 5000);
    const r3 = await api(base, 'POST', sharedPath('_company'), { name: '第三.md', kind: 'rule', content_b64: b64('丙'.repeat(3001)) });
    assert.equal(r3.status, 413);
    assert.equal(r3.json.error, '太長，請精簡或改放參考');
    assert.equal((await api(base, 'GET', sharedPath('_company'))).json.rules.length, 2, '被擋的沒落地');
    const big = await api(base, 'POST', sharedPath('行銷'), { name: '大.md', kind: 'rule', content_b64: b64('丁'.repeat(4001)) });
    assert.equal(big.status, 404, '分類還不存在');
    await api(base, 'POST', '/api/categories', { name: '行銷' });
    const big2 = await api(base, 'POST', sharedPath('行銷'), { name: '大.md', kind: 'rule', content_b64: b64('丁'.repeat(4001)) });
    assert.equal(big2.status, 413);
    assert.equal((await api(base, 'POST', sharedPath('行銷'), { name: '剛好.md', kind: 'rule', content_b64: b64('丁'.repeat(4000)) })).status, 200);

    // 參考類：任何副檔名、不限字數
    for (const name of ['範本.docx', '報告.pdf', '表.xlsx', '圖.png']) {
      const r = await api(base, 'POST', sharedPath('_company'), { name, kind: 'ref', content_b64: b64('內容'.repeat(3000)) });
      assert.equal(r.status, 200, `${name}：${JSON.stringify(r.json)}`);
    }
    const listed = (await api(base, 'GET', sharedPath('_company'))).json;
    assert.deepEqual(listed.refs.map((f) => f.name).sort(), ['圖.png', '報告.pdf', '範本.docx', '表.xlsx'].sort());
    assert.equal(listed.rule_chars, 5000, '參考不算進規範字數');
    assert.ok(listed.refs.every((f) => f.text_cache === undefined && f.uploaded_at));

    // 規範類擋格式
    const xlsx = await api(base, 'POST', sharedPath('_company'), { name: '表2.xlsx', kind: 'rule', content_b64: b64('x') });
    assert.equal(xlsx.status, 400);
    assert.equal(xlsx.json.error, '表格不是規範，請放參考');
    const pdf = await api(base, 'POST', sharedPath('_company'), { name: '文.pdf', kind: 'rule', content_b64: b64('x') });
    assert.equal(pdf.status, 400);
    assert.equal(pdf.json.error, 'PDF 還轉不了文字，請改上傳 docx 或貼文字');
    assert.equal((await api(base, 'POST', sharedPath('_company'), { name: '空.md', kind: 'rule', content_b64: '' })).status, 400);
    assert.equal((await api(base, 'POST', sharedPath('_company'), { name: '沒說.md', content_b64: b64('x') })).status, 400, '沒說規範還是參考');
    assert.equal((await api(base, 'POST', sharedPath('_company'), { name: '../跳.md', kind: 'rule', content_b64: b64('x') })).status, 400);

    // 同層同名 409；跨層同名各存各的
    const dup = await api(base, 'POST', sharedPath('_company'), { name: '手冊.md', kind: 'rule', content_b64: b64('新版') });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error, '已有同名檔，先刪再傳');
    const dupRef = await api(base, 'POST', sharedPath('_company'), { name: '範本.docx', kind: 'ref', content_b64: b64('x') });
    assert.equal(dupRef.status, 409);
    assert.equal((await api(base, 'POST', sharedPath('行銷'), { name: '手冊.md', kind: 'rule', content_b64: b64('部門版') })).status, 200);
    assert.deepEqual((await api(base, 'GET', sharedPath('行銷'))).json.rules.map((f) => f.name).sort(), ['剛好.md', '手冊.md']);
    assert.equal((await api(base, 'GET', sharedPath('_company'))).json.rules.find((f) => f.name === '手冊.md').chars, 2000, '公司那份沒被分類覆蓋');

    // index.yaml 落地形狀
    const idx = yaml.load(fs.readFileSync(path.join(dataDir, 'shared', '_company', 'index.yaml'), 'utf8'));
    assert.equal(idx.version, 1);
    const rule = idx.files.find((f) => f.name === '手冊.md');
    assert.equal(rule.kind, 'rule');
    assert.equal(rule.text_cache, '甲'.repeat(2000));
    assert.equal(idx.files.find((f) => f.name === '範本.docx').text_cache, undefined);

    // 下載
    const dl = await fetch(base + sharedPath('行銷', '手冊.md'));
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), '部門版');
    assert.ok(dl.headers.get('content-disposition').includes(enc('手冊.md')));
    assert.equal((await fetch(base + sharedPath('行銷', '沒有.md'))).status, 404);

    // 刪除：不進垃圾桶，直接沒了；再刪 404
    const del = await api(base, 'DELETE', sharedPath('_company', '報告.pdf'));
    assert.equal(del.status, 200);
    assert.deepEqual(del.json, { ok: true, unlinked_steps: 0 });
    assert.equal(fs.existsSync(path.join(dataDir, 'shared', '_company', 'files', '報告.pdf')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'trash')), false);
    assert.equal((await api(base, 'DELETE', sharedPath('_company', '報告.pdf'))).status, 404);
  } finally {
    await app.stop();
  }
});

test('U1a ④：刪共用檔順帶清掉步驟勾選——unlinked_steps＝2、定義無該物件、其他勾選不動、版本 +1 且履歷寫得出原因', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const node = (id, attachments) => ({ id, title: id, executor: 'ai', stop_point: 'never', instruction: '做', next: [], attachments });
    const def = {
      format: 1, name: '勾選流程', params: [],
      nodes: [
        node('a', ['a.txt', { scope: 'category', name: '範本.docx' }, { scope: 'company', name: '範本.docx' }]),
        node('b', [{ scope: 'category', name: '範本.docx' }]),
        node('c', ['b.txt']),
      ],
    };
    def.nodes[0].next = ['b'];
    def.nodes[1].next = ['c'];
    store.writeWorkflow('行銷', 'wf1', def);
    store.writeWorkflow('客服', 'wf2', { ...def, nodes: [node('a', [{ scope: 'category', name: '範本.docx' }])] }); // 別的分類的同名分類檔，不該被動到
    await api(base, 'POST', sharedPath('行銷'), { name: '範本.docx', kind: 'ref', content_b64: b64('x') });
    await api(base, 'POST', sharedPath('_company'), { name: '範本.docx', kind: 'ref', content_b64: b64('x') });
    assert.equal((await api(base, 'GET', `/api/workflows/${enc('行銷')}/wf1/versions`)).json.length, 1);

    const del = await api(base, 'DELETE', sharedPath('行銷', '範本.docx'));
    assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.deepEqual(del.json, { ok: true, unlinked_steps: 2 });
    const after = (await api(base, 'GET', `/api/workflows/${enc('行銷')}/wf1`)).json;
    assert.deepEqual(after.nodes[0].attachments, ['a.txt', { scope: 'company', name: '範本.docx' }], '同名的公司檔與流程層字串留著');
    assert.deepEqual(after.nodes[1].attachments, []);
    assert.deepEqual(after.nodes[2].attachments, ['b.txt']);
    const versions = (await api(base, 'GET', `/api/workflows/${enc('行銷')}/wf1/versions`)).json;
    assert.equal(versions.length, 2, '版本 +1');
    assert.ok(versions[1].diff_note.includes('範本.docx'), versions[1].diff_note);
    assert.deepEqual(store.readWorkflow('客服', 'wf2').nodes[0].attachments, [{ scope: 'category', name: '範本.docx' }], '別的分類不動');

    const delCo = await api(base, 'DELETE', sharedPath('_company', '範本.docx'));
    assert.deepEqual(delCo.json, { ok: true, unlinked_steps: 1 });
    assert.deepEqual((await api(base, 'GET', `/api/workflows/${enc('行銷')}/wf1`)).json.nodes[0].attachments, ['a.txt']);
  } finally {
    await app.stop();
  }
});

test('U1a ⑥⑦：PUT /api/settings company_name 存得進、GET 回、61 字 400；舊設定檔補 company_name 空字串；POST /api/categories _company 400', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, memory: { paused: true } }), 'utf8');
    const old = (await api(base, 'GET', '/api/settings')).json;
    assert.equal(old.company_name, '', '舊設定檔沒這鍵也回空字串');
    assert.equal(old.memory.paused, true);
    const ok = await api(base, 'PUT', '/api/settings', { company_name: '赫' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.company_name, '赫');
    assert.equal((await api(base, 'GET', '/api/settings')).json.company_name, '赫');
    assert.equal(createStore(dataDir).readSettings().company_name, '赫');
    const bad = await api(base, 'PUT', '/api/settings', { company_name: '赫'.repeat(61) });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, '組織名稱要是文字、60 字內');
    assert.equal((await api(base, 'GET', '/api/settings')).json.company_name, '赫', '錯的不落地');
    assert.equal((await api(base, 'PUT', '/api/settings', { company_name: '' })).status, 200, '清空退回缺省');
    assert.equal((await api(base, 'GET', '/api/settings')).json.company_name, '', '清空後 GET 回空字串');
    assert.equal(createStore(dataDir).readSettings().company_name, '', '清空真的落地');
    const cat = await api(base, 'POST', '/api/categories', { name: '_company' });
    assert.equal(cat.status, 400);
    assert.ok(cat.json.error.includes('_company'), cat.json.error);
    assert.ok(!(await api(base, 'GET', '/api/categories')).json.includes('_company'));
  } finally {
    await app.stop();
  }
});

// U1a 覆核該修 ①②③④：API 回 {name, chars, bytes, uploaded_at}；content_b64 嚴格驗證；型別錯同一句中文；保留字 400
test('U1a 修正：中文 txt 參考 chars＝字元；docx 參考 chars=null、bytes>0；壞 base64／非字串／檔名非文字 → 400 同一句人話且不落地；CON.md 400', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const txt = await api(base, 'POST', sharedPath('_company'), { name: '備註.txt', kind: 'ref', content_b64: b64('中文五個字') });
    assert.equal(txt.status, 200, JSON.stringify(txt.json));
    const t = txt.json.refs.find((f) => f.name === '備註.txt');
    assert.equal(t.chars, 5, '字元數不是位元組');
    assert.equal(t.bytes, 15);
    const docx = await api(base, 'POST', sharedPath('_company'), { name: '範本.docx', kind: 'ref', content_b64: Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString('base64') });
    const d = docx.json.refs.find((f) => f.name === '範本.docx');
    assert.equal(d.chars, null);
    assert.equal(d.bytes, 4);
    const rule = await api(base, 'POST', sharedPath('_company'), { name: '手冊.md', kind: 'rule', content_b64: b64('語氣親切') });
    assert.deepEqual(rule.json.rules.map(({ name, chars, bytes }) => ({ name, chars, bytes })), [{ name: '手冊.md', chars: 4, bytes: 12 }]);
    assert.equal(rule.json.rule_chars, 4, '參考不算進規範字數');
    for (const f of [...rule.json.rules, ...rule.json.refs]) assert.deepEqual(Object.keys(f).sort(), ['bytes', 'chars', 'name', 'uploaded_at']);

    const msg = '檔案內容沒讀到，請重新選檔上傳';
    const filesDir = path.join(dataDir, 'shared', '_company', 'files');
    const before = fs.readdirSync(filesDir).sort();
    for (const [label, body] of [
      ['非法字元', { name: '壞1.md', kind: 'rule', content_b64: '!!!not-base64!!!' }],
      ['長度不是 4 的倍數', { name: '壞2.md', kind: 'rule', content_b64: 'abcde' }],
      ['數字', { name: '壞3.md', kind: 'rule', content_b64: 12345 }],
      ['物件', { name: '壞4.txt', kind: 'ref', content_b64: { a: 1 } }],
      ['沒給', { name: '壞5.txt', kind: 'ref' }],
    ]) {
      const r = await api(base, 'POST', sharedPath('_company'), body);
      assert.equal(r.status, 400, label);
      assert.equal(r.json.error, msg, label);
    }
    assert.deepEqual(fs.readdirSync(filesDir).sort(), before, '壞的一個都沒落地');
    assert.equal(yaml.load(fs.readFileSync(path.join(dataDir, 'shared', '_company', 'index.yaml'), 'utf8')).files.length, 3);
    const badName = await api(base, 'POST', sharedPath('_company'), { name: { x: 1 }, kind: 'ref', content_b64: b64('x') });
    assert.equal(badName.status, 400);
    assert.equal(badName.json.error, '檔名要是文字');
    const con = await api(base, 'POST', sharedPath('_company'), { name: 'CON.md', kind: 'ref', content_b64: b64('x') });
    assert.equal(con.status, 400);
    assert.ok(con.json.error.includes('保留字'), con.json.error);
    assert.deepEqual(fs.readdirSync(filesDir).sort(), before);
  } finally {
    await app.stop();
  }
});

// ---- 拆解器（/api/compose）帶組織／分類規範——composeContext 讀 data/shared 的規範全文 ----

test('U1b ⑦ server：compose 帶分類 → 指示含「# 公司規範」「# 部門規範」全文；沒分類 → 部門（無）；沒有共用夾 → 兩段（無）、照樣拆', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    const def = { format: 1, name: '訂餐廳', params: [], nodes: [{ id: 'a', title: '找店', executor: 'ai', stop_point: 'always', instruction: '列三家', next: [] }] };
    adapter.setCompleteResponses([`拆好了\n\`\`\`yaml\n${JSON.stringify(def)}\n\`\`\``]);
    const prompt = (i) => readLogFile(dataDir, 'compose', logPair(dataDir, 'compose').asked[i]);
    // 沒有 data/shared/ → 兩段（無）
    const r0 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '拆' }], phase: 'draft' });
    assert.equal(r0.status, 200, JSON.stringify(r0.json));
    assert.ok(prompt(0).includes('# 公司規範（跟分類守則一樣當已知條件）\n（無）') && prompt(0).includes('# 部門規範（同上）\n（無）'), prompt(0));
    await api(base, 'POST', '/api/categories', { name: '旅遊' });
    assert.equal((await api(base, 'POST', sharedPath('_company'), { name: '手冊.md', kind: 'rule', content_b64: b64('語氣要親切。') })).status, 200);
    assert.equal((await api(base, 'POST', sharedPath('旅遊'), { name: '部門.md', kind: 'rule', content_b64: b64('報價含稅。') })).status, 200);
    assert.equal((await api(base, 'POST', sharedPath('旅遊'), { name: '範本.docx', kind: 'ref', content_b64: b64('x') })).status, 200, '參考類不進規範段');
    const r1 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '訂餐廳' }], category: '旅遊', phase: 'draft' });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    const p1 = prompt(1);
    assert.ok(p1.includes('# 公司規範（跟分類守則一樣當已知條件）\n## 手冊.md\n語氣要親切。'), p1);
    assert.ok(p1.includes('# 部門規範（同上）\n## 部門.md\n報價含稅。'), p1);
    assert.ok(!p1.includes('範本.docx'), '參考類不帶');
    assert.ok(p1.indexOf('# 部門規範') < p1.indexOf('# 分類守則'), '外圈在前');
    const r2 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '拆' }], phase: 'draft' });
    assert.equal(r2.status, 200);
    assert.ok(prompt(2).includes('## 手冊.md') && prompt(2).includes('# 部門規範（同上）\n（無）'), prompt(2));
  } finally {
    await app.stop();
  }
});

// ===== GET /runs?detail=1 歷次執行摘要（finals 與儀表板共用） =====

test('U4a ①：GET /runs 不帶 detail 回應形狀不變——每筆恰好 run_id／status／started_at 三欄', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = { format: 1, name: '摘要舊形', params: [], nodes: [{ id: 'a', title: '一步', executor: 'ai', stop_point: 'never', instruction: '做', next: [] }] };
    store.writeWorkflow('測試', 'runs-plain', def);
    store.writeRun('測試', 'runs-plain', 'r-20260901-100000-p', {
      run_id: 'r-20260901-100000-p', workflow: { category: '測試', id: 'runs-plain', name: def.name }, def,
      status: 'done', started_at: '2026-09-01T10:00:00.000Z', finished_at: '2026-09-01T10:01:00.000Z',
      steps: { a: { status: 'done', output: '成品' } },
    });
    const list = (await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/runs-plain/runs`)).json;
    assert.deepEqual(list, [{ run_id: 'r-20260901-100000-p', status: 'done', started_at: '2026-09-01T10:00:00.000Z' }]);
    assert.deepEqual(Object.keys(list[0]).sort(), ['run_id', 'started_at', 'status'], '舊讀者（續跑卡）只認這三欄，不准多');
  } finally {
    await app.stop();
  }
});

test('U4a ②：GET /runs?detail=1 跑完一趟後含 finals[0].title／steps.done／files 陣列／finished_at', async () => {
  const { app, base } = await startApp();
  try {
    const def = { format: 1, name: '出檔摘要', params: [], nodes: [{ id: 'a', title: '整理清單', executor: 'ai', stop_point: 'never', instruction: '整理', output_file: 'md', next: [] }] };
    const { id } = (await api(base, 'POST', '/api/workflows', { category: '測試', def })).json;
    const wfP = `/api/workflows/${encodeURIComponent('測試')}/${id}`;
    const run = (await api(base, 'POST', `${wfP}/runs`, { overrides: {} })).json;
    await pollRun(base, `${wfP}/runs/${run.run_id}`, (r) => r.status === 'done');
    const res = await api(base, 'GET', `${wfP}/runs?detail=1`);
    assert.equal(res.status, 200);
    const [item] = res.json;
    assert.equal(item.run_id, run.run_id);
    assert.equal(item.status, 'done');
    assert.ok(item.started_at && item.finished_at, '跑完要有開跑與結束時間');
    assert.equal(item.finals[0].title, '整理清單');
    assert.equal(item.finals[0].node, 'a');
    assert.equal(item.finals[0].file, '整理清單.md');
    assert.deepEqual(item.steps, { total: 1, done: 1, failed: 0 });
    assert.deepEqual(item.files, ['整理清單.md'], 'files 直接列產出資料夾（既有成品路由可下載）');
  } finally {
    await app.stop();
  }
});

test('U4a ③：GET /runs?detail=1 兩趟依 started_at 倒序（新的在前）', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = { format: 1, name: '倒序', params: [], nodes: [{ id: 'a', title: '一步', executor: 'ai', stop_point: 'never', instruction: '做', next: [] }] };
    store.writeWorkflow('測試', 'runs-order', def);
    const mk = (rid, at) => store.writeRun('測試', 'runs-order', rid, {
      run_id: rid, workflow: { category: '測試', id: 'runs-order', name: def.name }, def,
      status: 'done', started_at: at, finished_at: at, steps: { a: { status: 'done', output: '成品' } },
    });
    mk('r-20260901-100000-old', '2026-09-01T10:00:00.000Z');
    mk('r-20260902-100000-new', '2026-09-02T10:00:00.000Z');
    const list = (await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/runs-order/runs?detail=1`)).json;
    assert.deepEqual(list.map((r) => r.run_id), ['r-20260902-100000-new', 'r-20260901-100000-old']);
    const plain = (await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/runs-order/runs`)).json;
    assert.deepEqual(plain.map((r) => r.run_id), ['r-20260901-100000-old', 'r-20260902-100000-new'], '不帶 detail 的順序照舊（listRuns 字典序）');
  } finally {
    await app.stop();
  }
});

test('U4a ④：儀表板 recent[0].finals 與 detail=1 的 finals 深相等（同一支 finalsOf）——含終點人做回退', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: '共用成品', params: [],
      nodes: [
        { id: 'a', title: '起步', executor: 'ai', stop_point: 'never', instruction: '做A', next: ['b'] },
        { id: 'b', title: '寫信', executor: 'ai', stop_point: 'never', instruction: '做B', next: ['c'] },
        { id: 'c', title: '寄出', executor: 'human', stop_point: 'never', instruction: '寄', next: [] },
      ],
    };
    store.writeWorkflow('測試', 'runs-finals', def);
    const rid = 'r-20260903-100000-f';
    store.writeRun('測試', 'runs-finals', rid, {
      run_id: rid, workflow: { category: '測試', id: 'runs-finals', name: def.name }, def,
      status: 'done', started_at: '2026-09-03T10:00:00.000Z', finished_at: '2026-09-03T10:05:00.000Z',
      steps: { a: { status: 'done', output: 'A產出' }, b: { status: 'done', output: '成品信' }, c: { status: 'done', output: '' } },
    });
    const dash = (await api(base, 'GET', '/api/dashboard?limit=5&days=30')).json;
    const card = dash.recent.find((r) => r.run_id === rid);
    const [item] = (await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/runs-finals/runs?detail=1`)).json;
    assert.equal(card.finals[0].title, '寫信', '終點是人做→回退到最後 AI 步');
    assert.deepEqual(item.finals, card.finals);
    assert.deepEqual(item.steps, card.steps);
  } finally {
    await app.stop();
  }
});

test('U4a ⑤：一個 run.yaml 壞掉→detail=1 那筆標讀不到（不炸整支 200）；不帶 detail 也不炸', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = { format: 1, name: '壞檔', params: [], nodes: [{ id: 'a', title: '一步', executor: 'ai', stop_point: 'never', instruction: '做', next: [] }] };
    store.writeWorkflow('測試', 'runs-broken', def);
    store.writeRun('測試', 'runs-broken', 'r-20260904-100000-ok', {
      run_id: 'r-20260904-100000-ok', workflow: { category: '測試', id: 'runs-broken', name: def.name }, def,
      status: 'done', started_at: '2026-09-04T10:00:00.000Z', finished_at: '2026-09-04T10:01:00.000Z', steps: { a: { status: 'done', output: '成品' } },
    });
    const badDir = path.join(dataDir, 'workflows', '測試', 'runs-broken', 'runs', 'r-20260905-100000-bad');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'run.yaml'), '{{{壞了: [', 'utf8');
    const res = await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/runs-broken/runs?detail=1`);
    assert.equal(res.status, 200);
    assert.equal(res.json.length, 2, '壞的那筆照列，不消失');
    const bad = res.json.find((r) => r.run_id === 'r-20260905-100000-bad');
    assert.equal(bad.status, 'unreadable');
    assert.ok(bad.error && /讀不懂|讀不到/.test(bad.error), `要有中文人話：${bad.error}`);
    assert.deepEqual(bad.finals, []);
    assert.deepEqual(bad.files, []);
    assert.equal(res.json[0].run_id, 'r-20260904-100000-ok', '讀不到的沒有 started_at，排最後');
    const plain = await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/runs-broken/runs`);
    assert.equal(plain.status, 200, '舊路徑碰到壞檔也不准 500');
    assert.equal(plain.json.length, 1, '舊形狀只回讀得到的（三欄形狀不變）');
  } finally {
    await app.stop();
  }
});

test('US-099：GET /runs/stats 回近 30 天四個數字＋最常出事的步驟；壞檔跳過不擋（200）；不影響 GET /runs/:rid', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = { format: 1, name: '成效', params: [], nodes: [
      { id: 'a', title: '抓來源', executor: 'ai', stop_point: 'never', instruction: '抓', next: ['b'] },
      { id: 'b', title: '寫摘要', executor: 'ai', stop_point: 'never', instruction: '寫', next: [] }] };
    store.writeWorkflow('測試', 'runs-stats', def);
    const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
    const mk = (rid, status, startAgo, durMs, steps) => store.writeRun('測試', 'runs-stats', rid, {
      run_id: rid, workflow: { category: '測試', id: 'runs-stats', name: def.name }, def, status,
      started_at: iso(startAgo), finished_at: status === 'running' ? null : iso(startAgo - durMs), steps,
    });
    const H = 3600000;
    mk('r-1', 'done', 2 * H, 6 * 60000, { a: { status: 'done' }, b: { status: 'done', edited_output: '改過' } });
    mk('r-2', 'done', 5 * H, 10 * 60000, { a: { status: 'failed', error: 'x' }, b: { status: 'done', edited_output: null } });
    mk('r-3', 'running', 1 * H, 0, { a: { status: 'running' } });
    mk('r-old', 'done', 40 * 24 * H, 60000, { a: { status: 'done' } }); // 前 30 天
    const badDir = path.join(dataDir, 'workflows', '測試', 'runs-stats', 'runs', 'r-bad');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'run.yaml'), '{{{壞了: [', 'utf8');
    const res = await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/runs-stats/runs/stats`);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.days, 30);
    assert.deepEqual(res.json.window, { runs: 3, rate: 0.5, median_ms: 8 * 60000, edited_avg: 0.5 });
    assert.equal(res.json.prev_rate, 1);
    assert.deepEqual(res.json.top_steps, [{ node: 'a', title: '抓來源', failed: 1, edited: 0 }, { node: 'b', title: '寫摘要', failed: 0, edited: 1 }]);
    const one = await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/runs-stats/runs/r-1`);
    assert.equal(one.status, 200);
    assert.equal(one.json.run_id, 'r-1', '單趟路由不受影響');
    const empty = await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/runs-none/runs/stats`);
    assert.equal(empty.status, 200, '還沒開跑過的 Workflow 也回 200');
    assert.equal(empty.json.window.runs, 0);
  } finally {
    await app.stop();
  }
});

// —— PUT /api/categories/:name 改名（八處同步、歷史留舊名）＋復原擋門＋流程改名版本註記 ——
const B0_DEF = { format: 1, name: '訂機票', params: [], nodes: [{ id: 'a', title: '查航班', executor: 'ai', stop_point: 'never', instruction: '查', next: [] }] };

test('B0 ⑥：PUT /api/categories/:name → 200 含 moved；新路徑讀得到、舊路徑 404；儀表板與行事曆的 category 來自路徑（run.yaml 留舊名）；排程跟著改；未分類 400、沒有的 404、撞名 409、空名／同名／_company 400', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    store.writeWorkflow('旅遊', 'a', B0_DEF);
    store.createCategory('工作');
    store.createCategory('未分類');
    const rid = 'r-20260910-090000-b0';
    store.writeRun('旅遊', 'a', rid, {
      run_id: rid, workflow: { category: '旅遊', id: 'a', name: '訂機票' }, def: B0_DEF,
      status: 'paused', source: 'manual', started_at: '2026-09-10T09:00:00.000Z',
      steps: { a: { status: 'waiting_time', wake_at: '2099-01-15T09:00:00.000Z' } },
    });
    const sched = await api(base, 'POST', '/api/schedules', { workflow_id: '旅遊/a', freq: 'daily', time: '08:00' });
    assert.equal(sched.status, 200, JSON.stringify(sched.json));
    // 第九處：未讀通知的 run.category 要跟著改，否則「重試」拿舊分類找 run 回莫名的 404
    store.writeNotices([
      { id: 'n1', type: 'step_failed', status: 'unread', title: '這步失敗了', actions: ['retry'], run: { category: '旅遊', id: 'a', run_id: rid, node: 'a' } },
      { id: 'n2', type: 'step_failed', status: 'done', title: '處理過了', actions: [], run: { category: '旅遊', id: 'a', run_id: rid, node: 'a' } },
    ]);

    const ok = await api(base, 'PUT', `/api/categories/${encodeURIComponent('旅遊')}`, { name: '出差' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.ok, true);
    assert.deepEqual(ok.json.moved, { workflows: 1, schedules: 1, proposals: 0, cards: 0, identities: 0, notices: 1, trash: 0 });
    assert.equal((await api(base, 'GET', `/api/workflows/${encodeURIComponent('出差')}/a`)).json.name, '訂機票');
    assert.equal((await api(base, 'GET', `/api/workflows/${encodeURIComponent('旅遊')}/a`)).status, 404);
    const cats = (await api(base, 'GET', '/api/categories')).json;
    assert.ok(cats.includes('出差') && !cats.includes('旅遊'), `categories=${cats}`);
    // 儀表板／行事曆的 category 來自路徑，不是 run.yaml
    assert.equal(store.readRun('出差', 'a', rid).workflow.category, '旅遊', 'run.yaml 留舊名');
    const card = (await api(base, 'GET', '/api/dashboard?limit=5')).json.recent.find((r) => r.run_id === rid);
    assert.ok(card, '儀表板要列到這筆 run');
    assert.equal(card.category, '出差');
    const cal = (await api(base, 'GET', '/api/calendar?month=2099-01')).json;
    const ev = cal.events.find((e) => e.run?.run_id === rid);
    assert.ok(ev, '等時刻步驟要出現在行事曆');
    assert.equal(ev.run.category, '出差');
    assert.ok(cal.events.some((e) => e.sid === sched.json.id), '排程場次仍在行事曆');
    const back = (await api(base, 'GET', '/api/schedules')).json.find((s) => s.id === sched.json.id);
    assert.equal(back.workflow_id, '出差/a');
    // 擋門
    const cases = [
      [encodeURIComponent('未分類'), { name: 'x' }, 400, '「未分類」不能改名'],
      [encodeURIComponent('沒有的'), { name: 'x' }, 404, null],
      [encodeURIComponent('出差'), { name: '工作' }, 409, '已有同名分類'],
      [encodeURIComponent('出差'), { name: '' }, 400, '名稱不可留空'],
      [encodeURIComponent('出差'), {}, 400, '名稱不可留空'],
      [encodeURIComponent('出差'), { name: '出差' }, 400, '新舊名稱相同'],
      [encodeURIComponent('出差'), { name: '_company' }, 400, '_company'],
      [encodeURIComponent('出差'), { name: '未分類' }, 400, '「未分類」不能改名'],
    ];
    for (const [seg, body, status, msg] of cases) {
      const r = await api(base, 'PUT', `/api/categories/${seg}`, body);
      assert.equal(r.status, status, `${seg} ${JSON.stringify(body)} → ${JSON.stringify(r.json)}`);
      if (msg) assert.ok(r.json.error.includes(msg), `${seg} ${JSON.stringify(body)}：${r.json.error}`);
    }
    assert.equal((await api(base, 'GET', '/api/categories/ghost')).status, 404, 'GET 單一分類仍 404');
    assert.deepEqual((await api(base, 'GET', '/api/categories')).json.sort(), ['出差', '工作', '未分類', '範例'], '擋下的一個都沒落地（範例＝啟動播種）');
  } finally {
    await app.stop();
  }
});

test('B0 ⑦：PUT /api/workflows/:cat/:id 改 def.name → 履歷新一版 note「改名：「舊」→「新」」（不併入十分鐘合併）；只改指示不改名 → 仍「手動編輯（畫布／欄位）」', async () => {
  const { app, base } = await startApp();
  try {
    const wfP = `/api/workflows/${encodeURIComponent('範例')}/quarterly-report`;
    let def = (await api(base, 'GET', wfP)).json;
    const oldName = def.name;
    def.nodes[0].instruction += '（改指示）';
    assert.equal((await api(base, 'PUT', wfP, { def })).status, 200);
    let versions = (await api(base, 'GET', `${wfP}/versions`)).json;
    assert.equal(versions.at(-1).diff_note, '手動編輯（畫布／欄位）');
    const r1 = await api(base, 'PUT', wfP, { def: { ...def, name: '季報新名' } });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    versions = (await api(base, 'GET', `${wfP}/versions`)).json;
    assert.equal(versions.length, 3, '改名一定另記一版，不併入十分鐘內的手動編輯');
    assert.equal(versions.at(-1).diff_note, `改名：「${oldName}」→「季報新名」`);
    assert.equal(versions.at(-1).source, 'manual');
    assert.equal((await api(base, 'GET', wfP)).json.name, '季報新名');
    assert.equal((await api(base, 'GET', '/api/workflows')).json.find((w) => w.id === 'quarterly-report').name, '季報新名', '清單同步');
    def = (await api(base, 'GET', wfP)).json;
    assert.equal((await api(base, 'PUT', wfP, { def: { ...def, name: '季報二' } })).status, 200);
    versions = (await api(base, 'GET', `${wfP}/versions`)).json;
    assert.equal(versions.length, 4);
    assert.equal(versions.at(-1).diff_note, '改名：「季報新名」→「季報二」');
    assert.equal(r1.json.version, 3);
  } finally {
    await app.stop();
  }
});

test('B0 修正輪 server（第九處）：moved.notices 數到未讀通知；GET /api/notices 的 unread 那筆 run.category 是新名、已處理的留痕不動', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    store.writeWorkflow('旅遊', 'a', B0_DEF);
    const rid = 'r-20260910-093000-b0n';
    store.writeRun('旅遊', 'a', rid, { run_id: rid, workflow: { category: '旅遊', id: 'a', name: '訂機票' }, def: B0_DEF, status: 'paused', steps: {} });
    store.writeNotices([
      { id: 'n1', type: 'step_failed', status: 'unread', title: '這步失敗了', actions: ['retry'], run: { category: '旅遊', id: 'a', run_id: rid, node: 'a' } },
      { id: 'n2', type: 'step_failed', status: 'done', title: '處理過了', actions: [], run: { category: '旅遊', id: 'a', run_id: rid, node: 'a' } },
      { id: 'n3', type: 'snapshot_failed', status: 'unread', title: '快照抓不到', actions: ['retry'] },
    ]);
    const ok = await api(base, 'PUT', `/api/categories/${encodeURIComponent('旅遊')}`, { name: '出差' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.moved.notices, 1, '只數未讀且指到這個分類的');
    const got = (await api(base, 'GET', '/api/notices')).json;
    assert.equal(got.unread.find((n) => n.id === 'n1').run.category, '出差', '未讀通知指到新分類');
    assert.equal(got.done.find((n) => n.id === 'n2').run.category, '旅遊', '已處理的通知留痕不動');
    assert.ok(got.unread.some((n) => n.id === 'n3'), '沒有 run 欄位的通知不受影響');
    assert.equal(createStore(dataDir).readNotices().find((n) => n.id === 'n1').run.category, '出差', '真的落地');
  } finally {
    await app.stop();
  }
});

test('B0 ⑨ server：改名後垃圾桶列顯示新分類、復原落在新分類底下；原分類已不在的那筆 POST /api/trash/:key/restore → 409 且 error 含「已經不在了」、那筆還在', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    createStore(dataDir).writeWorkflow('旅遊', 'a', B0_DEF);
    const del = await api(base, 'DELETE', `/api/workflows/${encodeURIComponent('旅遊')}/a`);
    assert.equal(del.status, 200);
    const { key } = del.json;
    const ren = await api(base, 'PUT', `/api/categories/${encodeURIComponent('旅遊')}`, { name: '出差' });
    assert.equal(ren.status, 200, JSON.stringify(ren.json));
    assert.equal(ren.json.moved.trash, 1);
    assert.equal((await api(base, 'GET', '/api/trash')).json.find((t) => t.key === key).category, '出差');
    const key2 = 'zz-消失的-x';
    fs.mkdirSync(path.join(dataDir, 'trash', key2), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'trash', key2, 'workflow.yaml'), 'format: 1\nname: 舊的\nparams: []\nnodes: []\n', 'utf8');
    fs.writeFileSync(path.join(dataDir, 'trash', key2, 'meta.yaml'), 'category: 消失的\nid: x\nname: 舊的\ntrashed_at: 2026-09-01T00:00:00.000Z\n', 'utf8');
    const bad = await api(base, 'POST', `/api/trash/${encodeURIComponent(key2)}/restore`, {});
    assert.equal(bad.status, 409, JSON.stringify(bad.json));
    assert.ok(bad.json.error.includes('已經不在了') && bad.json.error.includes('消失的'), bad.json.error);
    assert.ok(!fs.existsSync(path.join(dataDir, 'workflows', '消失的')), '不靜默新建分類');
    assert.ok((await api(base, 'GET', '/api/trash')).json.some((t) => t.key === key2), '那筆還在');
    const good = await api(base, 'POST', `/api/trash/${encodeURIComponent(key)}/restore`, {});
    assert.equal(good.status, 200, JSON.stringify(good.json));
    assert.equal(good.json.category, '出差');
    assert.equal((await api(base, 'GET', `/api/workflows/${encodeURIComponent('出差')}/${encodeURIComponent(good.json.id)}`)).json.name, '訂機票');
    assert.ok(!fs.existsSync(path.join(dataDir, 'workflows', '旅遊')), '舊分類沒復活');
  } finally {
    await app.stop();
  }
});

// ===== 終點是 next:[] 的 join（並行點產出改空字串後）成品要含匯進它的每一支 task =====

test('B1 修正：a→fork→{scan,mail}→join(next:[]) 跑完 → GET /api/dashboard recent 該趟 finals 含 scan 與 mail 兩支、無 join；GET /runs?detail=1 同一份；終點人做回退走拓樸序', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: '會合收尾', params: [], check: { enabled: false },
      nodes: [
        { id: 'a', title: '起步', executor: 'ai', stop_point: 'never', instruction: '起', next: ['fk'] },
        { id: 'fk', title: '同時做', kind: 'fork', next: ['scan', 'mail'] },
        { id: 'scan', title: '掃描存檔', executor: 'ai', stop_point: 'never', instruction: '掃', next: ['jn'] },
        { id: 'mail', title: '寄出正本', executor: 'ai', stop_point: 'never', instruction: '寄', next: ['jn'] },
        { id: 'jn', title: '收齊', kind: 'join', next: [] },
      ],
    };
    store.writeWorkflow('測試', 'join-end', def);
    const wf = `/api/workflows/${encodeURIComponent('測試')}/join-end`;
    const started = await api(base, 'POST', `${wf}/runs`, {});
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const rid = started.json.run_id;
    const run = await pollRun(base, `${wf}/runs/${rid}`, (r) => r.status === 'done');
    assert.equal(run.steps.jn.output, '', '並行點／會合點不轉運（B1）');
    const dash = (await api(base, 'GET', '/api/dashboard?limit=5&days=30')).json;
    const card = dash.recent.find((r) => r.run_id === rid);
    assert.ok(card, '最近完成要有這趟');
    assert.deepEqual(card.finals.map((f) => [f.node, f.title, f.preview]), [['scan', '掃描存檔', '產出:scan'], ['mail', '寄出正本', '產出:mail']], JSON.stringify(card.finals));
    assert.ok(!card.finals.some((f) => f.node === 'jn' || f.node === 'a'), '會合點與起步都不是成品');
    const [item] = (await api(base, 'GET', `${wf}/runs?detail=1`)).json;
    assert.equal(item.run_id, rid);
    assert.deepEqual(item.finals, card.finals, 'detail=1 與儀表板同一份');
    // 備援走拓樸序：終點是人做（沒交內容）、def.nodes 陣列序故意把最深的 AI 步排前面 → 仍回退到拓樸最深的那步
    const def2 = {
      format: 1, name: '人做收尾', params: [],
      nodes: [
        { id: 'b', title: '寫信', executor: 'ai', stop_point: 'never', instruction: '寫', next: ['c'] },
        { id: 'a', title: '起步', executor: 'ai', stop_point: 'never', instruction: '起', next: ['b'] },
        { id: 'c', title: '寄出', executor: 'human', stop_point: 'never', instruction: '寄', next: [] },
      ],
    };
    store.writeWorkflow('測試', 'human-end', def2);
    const rid2 = 'r-20260917-100000-h';
    store.writeRun('測試', 'human-end', rid2, {
      run_id: rid2, workflow: { category: '測試', id: 'human-end', name: def2.name }, def: def2,
      status: 'done', started_at: '2026-09-17T10:00:00.000Z', finished_at: '2026-09-17T10:05:00.000Z',
      steps: { a: { status: 'done', output: 'A產出' }, b: { status: 'done', output: '成品信' }, c: { status: 'done', output: '' } },
    });
    const [item2] = (await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/human-end/runs?detail=1`)).json;
    assert.deepEqual(item2.finals.map((f) => [f.node, f.preview]), [['b', '成品信']], JSON.stringify(item2.finals));
  } finally {
    await app.stop();
  }
});

test('排版輪 L5 ⑥：GET /api/workflows 每筆帶 steps／human_steps（照定義數一般步驟與你來）；category／id／name 原樣；壞檔 null 不擋清單', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const list = (await api(base, 'GET', '/api/workflows')).json;
    for (const w of list) {
      assert.deepEqual(Object.keys(w), ['category', 'id', 'name', 'steps', 'human_steps', 'last_run'], `欄位只加不改（US-107 多 last_run）：${JSON.stringify(w)}`);
      assert.equal(w.last_run, null, `剛種好的範例沒跑過＝last_run null：${JSON.stringify(w)}`);
      const def = (await api(base, 'GET', `/api/workflows/${encodeURIComponent(w.category)}/${w.id}`)).json;
      const tasks = def.nodes.filter((n) => (n.kind ?? 'task') === 'task');
      assert.equal(w.steps, tasks.length, `${w.id} 步數`);
      assert.equal(w.human_steps, tasks.filter((n) => n.executor === 'human').length, `${w.id} 你來步數`);
    }
    assert.ok(list.some((w) => w.steps > 0 && w.human_steps > 0), '範例至少一條有你來的步驟');
    fs.writeFileSync(path.join(dataDir, 'workflows', '範例', 'quarterly-report', 'workflow.yaml'), 'a: [壞', 'utf8');
    const res = await api(base, 'GET', '/api/workflows');
    assert.equal(res.status, 200);
    const bad = res.json.find((w) => w.id === 'quarterly-report');
    assert.equal(bad.steps, null); assert.equal(bad.human_steps, null);
  } finally {
    await app.stop();
  }
});

// ---- （上桌b）：共用檔唯讀查看 GET /api/shared/:scope/files/:name/view ----
test('L7 ⑤：共用檔查看——md／txt 回原文、docx 回排版 HTML、pdf 等 415；不存在 404；路徑穿越／反斜線／壞編碼 400；只准讀清單裡的檔（夾裡野檔、結尾點 404）；檔名 NFC 正規化；舊資料沒有共用夾＝404 且不建夾；既有下載不變', async () => {
  const { app, base, dataDir } = await startApp();
  const view = (scope, rawName) => fetch(`${base}/api/shared/${encodeURIComponent(scope)}/files/${rawName}/view`).then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    const old = await view('_company', enc('手冊.md'));
    assert.equal(old.status, 404, '舊資料沒有共用夾');
    assert.equal(fs.existsSync(path.join(dataDir, 'shared')), false, '查看不建夾');

    await api(base, 'POST', sharedPath('_company'), { name: '手冊.md', kind: 'rule', content_b64: b64('# 手冊\n<b>語氣</b>要親切') });
    await api(base, 'POST', sharedPath('_company'), { name: '說明.txt', kind: 'ref', content_b64: b64('純文字參考') });
    const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('員工手冊第一章')] })] }] });
    await api(base, 'POST', sharedPath('_company'), { name: '範本.docx', kind: 'ref', content_b64: (await Packer.toBuffer(doc)).toString('base64') });
    await api(base, 'POST', sharedPath('_company'), { name: '報告.pdf', kind: 'ref', content_b64: b64('%PDF-1.4') });
    await api(base, 'POST', sharedPath('_company'), { name: 'café.md', kind: 'ref', content_b64: b64('NFC 名') }); // 'café' NFC

    const md = await view('_company', enc('手冊.md'));
    assert.equal(md.status, 200);
    assert.deepEqual(md.json, { name: '手冊.md', kind: 'text', text: '# 手冊\n<b>語氣</b>要親切' }, 'md 回原文（不轉 HTML，前端 <pre> 跳脫顯示）');
    assert.deepEqual((await view('_company', enc('說明.txt'))).json, { name: '說明.txt', kind: 'text', text: '純文字參考' });
    const docx = await view('_company', enc('範本.docx'));
    assert.equal(docx.status, 200);
    assert.equal(docx.json.kind, 'html');
    assert.ok(docx.json.html.includes('<p>員工手冊第一章</p>'), docx.json.html);
    const pdf = await view('_company', enc('報告.pdf'));
    assert.equal(pdf.status, 415);
    assert.ok(pdf.json.error.includes('下載'), pdf.json.error);
    assert.equal((await view('_company', enc('沒有.md'))).status, 404);

    // 路徑穿越與名稱正規化
    fs.writeFileSync(path.join(dataDir, 'secret.md'), '不該被讀到');
    fs.writeFileSync(path.join(dataDir, 'shared', '_company', 'files', '野檔.md'), '沒登記在清單');
    for (const raw of [enc('../../secret.md'), enc('..\\..\\secret.md'), enc('..x'), '%E0%A4', enc('a:b.md'), enc('CON.md')]) {
      const r = await view('_company', raw);
      assert.equal(r.status, 400, `${raw} 該 400：${JSON.stringify(r.json)}`);
      assert.ok(!JSON.stringify(r.json).includes('不該被讀到'));
    }
    assert.equal((await view('..', enc('secret.md'))).status, 404, 'scope 不是組織也不是現有分類');
    assert.equal((await view('_company', enc('野檔.md'))).status, 404, '只准讀清單裡登記的檔');
    assert.equal((await view('_company', enc('手冊.md.'))).status, 404, '結尾點（Windows 會對到手冊.md）不算同名');
    const nfd = await view('_company', enc('café.md'.normalize('NFD')));
    assert.equal(nfd.status, 200, '檔名 NFD 送來也對得到');
    assert.equal(nfd.json.text, 'NFC 名');

    const dl = await fetch(base + sharedPath('_company', '手冊.md'));
    assert.equal(dl.headers.get('content-type'), 'application/octet-stream', '既有下載原樣');
  } finally {
    await app.stop();
  }
});

// ---- ／3f）：本次上傳暫存端點、開跑收 uploads 與 note ----
test('排版輪 L11 ②③④⑤：run-uploads 檔名／副檔名／大小護欄；開跑缺必填檔 409；uploads 搬進 runs/<rid>/in/、run.params＝檔名、token 用過即失效；note 進 run.note 與每步 upstream、超過 2,000 字 400', async () => {
  const { app, base, dataDir, adapter } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: '上傳月報',
      params: [{ key: 'src', label: '原始資料', default: '', input: 'file', required: true }, { key: 'range', label: '範圍', default: '本季' }],
      nodes: [
        { id: 'a', title: '整理', executor: 'ai', stop_point: 'never', instruction: '整理上傳的資料，範圍 {{range}}', next: ['b'] },
        { id: 'b', title: '寫報告', executor: 'ai', stop_point: 'never', instruction: '依上一步寫報告', next: [] },
      ],
      check: { enabled: false }, supervisor: { enabled: false },
    };
    store.writeWorkflow('測試', 'up', def);
    const wfp = `/api/workflows/${encodeURIComponent('測試')}/up`;
    const b64 = (s) => Buffer.from(s).toString('base64');
    const upload = (name, content_b64) => api(base, 'POST', `${wfp}/run-uploads`, { name, content_b64 });
    // 護欄：路徑符號／保留字 400、副檔名白名單（沿用參考檔 accept）400、空檔 400、超過 10MB 413；擋下的不落地
    for (const bad of ['../x.csv', '..\\x.csv', 'a/b.csv', 'CON.csv']) assert.equal((await upload(bad, b64('1'))).status, 400, bad);
    const exe = await upload('病毒.exe', b64('1'));
    assert.equal(exe.status, 400);
    assert.ok(exe.json.error.includes('csv'), exe.json.error);
    assert.equal((await upload('空.csv', '')).status, 400);
    assert.equal((await upload('大.csv', Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'))).status, 413);
    assert.ok(!fs.existsSync(path.join(dataDir, 'uploads')) || fs.readdirSync(path.join(dataDir, 'uploads')).length === 0, '擋下的不落地');
    assert.equal((await api(base, 'POST', `/api/workflows/${encodeURIComponent('測試')}/沒有/run-uploads`, { name: 'a.csv', content_b64: b64('1') })).status, 404, '沒有的 Workflow');
    const ok = await upload('三月.csv', b64('a,b\n1,2'));
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.name, '三月.csv');
    assert.equal(ok.json.size, 7);
    const { token } = ok.json;
    // 開跑：沒給必填檔＝409 健檢句；token 不存在／放到文字欄位＝400；補充超過 2,000 字＝400
    const miss = await api(base, 'POST', `${wfp}/runs`, { overrides: { src: '假裝有.csv' } });
    assert.equal(miss.status, 409, '文字覆寫不能冒充上傳');
    assert.deepEqual(miss.json.issues.filter((i) => i.level === 'block').map((i) => i.code), ['upload-missing']);
    assert.equal((await api(base, 'POST', `${wfp}/runs`, { uploads: { src: 'f'.repeat(24) } })).status, 400, 'token 不存在');
    assert.equal((await api(base, 'POST', `${wfp}/runs`, { uploads: { src: '../x' } })).status, 400, 'token 路徑符號');
    assert.equal((await api(base, 'POST', `${wfp}/runs`, { uploads: { src: token, range: token } })).status, 400, '不是上傳欄位');
    assert.equal((await api(base, 'POST', `${wfp}/runs`, { uploads: { src: token }, note: '字'.repeat(2001) })).status, 400, '補充太長');
    assert.equal((await api(base, 'POST', `${wfp}/runs`, { uploads: { src: token }, note: 3 })).status, 400, '補充要是文字');
    assert.equal(store.listRuns('測試', 'up').length, 0, '擋下的都沒開跑');
    const started = await api(base, 'POST', `${wfp}/runs`, { overrides: { range: 'Q3' }, uploads: { src: token }, note: '字'.repeat(1999) + '尾' });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const rid = started.json.run_id;
    assert.equal(started.json.params.src, '三月.csv');
    assert.equal(started.json.note.length, 2000);
    const inFile = path.join(dataDir, 'workflows', '測試', 'up', 'runs', rid, 'in', '三月.csv');
    assert.equal(fs.readFileSync(inFile, 'utf8'), 'a,b\n1,2', '檔跟著這一趟存');
    assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', token)), '暫存用過即刪');
    assert.equal((await api(base, 'POST', `${wfp}/runs`, { uploads: { src: token } })).status, 400, '同一個 token 不能再用');
    assert.deepEqual(store.listRefFiles('測試', 'up'), [], '不進 Workflow 參考檔');
    const run = await pollRun(base, `${wfp}/runs/${rid}`, (r) => r.status === 'done');
    assert.ok(run.note.endsWith('尾'));
    const a = adapter.calls.find((c) => c.nodeId === 'a');
    const bb = adapter.calls.find((c) => c.nodeId === 'b');
    assert.ok(a.upstream.startsWith('【你這次的補充】\n') && bb.upstream.startsWith('產出:a\n\n【你這次的補充】\n'), `${a.upstream.slice(0, 30)}｜${bb.upstream.slice(0, 30)}`);
    assert.deepEqual(a.attachments, [inFile], '第一個 AI 步驟讀檔');
    assert.deepEqual(bb.attachments, [inFile], '原始檔每步都看得到（US-108）：第二步也拿到第一步掛的檔');
  } finally {
    await app.stop();
  }
});

test('排版輪 L13 附帶：暫存代碼綁定發放的 Workflow——拿 A 的代碼去開 B 擋 400、檔還在 A 可用；檔名含 NUL 400 人話；伺服器讀寫檔的例外不把絕對路徑透給前端', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const mk = (name) => ({
      format: 1, name, params: [{ key: 'src', label: '原始資料', default: '', input: 'file', required: true }],
      nodes: [{ id: 'a', title: '整理', executor: 'ai', stop_point: 'never', instruction: '整理上傳的資料', next: [] }],
      check: { enabled: false }, supervisor: { enabled: false },
    });
    store.writeWorkflow('測試', 'wa', mk('A'));
    store.writeWorkflow('測試', 'wb', mk('B'));
    const pa = `/api/workflows/${encodeURIComponent('測試')}/wa`;
    const pb = `/api/workflows/${encodeURIComponent('測試')}/wb`;
    const b64 = (s) => Buffer.from(s).toString('base64');
    const up = await api(base, 'POST', `${pa}/run-uploads`, { name: '三月.csv', content_b64: b64('1,2') });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    const steal = await api(base, 'POST', `${pb}/runs`, { uploads: { src: up.json.token } });
    assert.equal(steal.status, 400, '跨 Workflow 挪用擋下');
    assert.ok(steal.json.error.includes('別條 Workflow'), steal.json.error);
    assert.equal(store.listRuns('測試', 'wb').length, 0);
    const own = await api(base, 'POST', `${pa}/runs`, { uploads: { src: up.json.token } });
    assert.equal(own.status, 200, '發放的那條照用');
    // 檔名含 NUL：人話 400、不帶伺服器路徑
    const nul = await api(base, 'POST', `${pa}/run-uploads`, { name: `a${String.fromCharCode(0)}.pdf`, content_b64: b64('1') });
    assert.equal(nul.status, 400);
    assert.ok(nul.json.error.includes('控制字元') && !nul.json.error.includes(dataDir) && !/[A-Za-z]:\\/.test(nul.json.error), nul.json.error);
    // 系統層讀寫例外（暫存根被一個檔佔住，清暫存時 readdir 炸 ENOTDIR）：回人話，不透出絕對路徑
    fs.rmSync(path.join(dataDir, 'uploads'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dataDir, 'uploads'), 'x');
    const sys = await api(base, 'POST', `${pa}/run-uploads`, { name: 'b.csv', content_b64: b64('1') });
    assert.ok(sys.status >= 400, String(sys.status));
    assert.ok(!sys.json.error.includes(dataDir) && !/[A-Za-z]:\\/.test(sys.json.error) && !sys.json.error.includes('ENOTDIR'), sys.json.error);
    assert.ok(sys.json.error.includes('讀寫檔案'), sys.json.error);
  } finally {
    await app.stop();
  }
});

test('L13b：上傳後把 Workflow 移到別分類、或分類改名，用同一代碼開跑照常 200；跨 Workflow 仍 400「別條」；過期被清掉仍原訊息', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: 'A', params: [{ key: 'src', label: '原始資料', default: '', input: 'file', required: true }],
      nodes: [{ id: 'a', title: '整理', executor: 'ai', stop_point: 'never', instruction: '整理上傳的資料', next: [] }],
      check: { enabled: false }, supervisor: { enabled: false },
    };
    store.writeWorkflow('部門A', 'wa', def);
    store.writeWorkflow('部門A', 'wb', { ...def, name: 'B' });
    const p = (cat, id) => `/api/workflows/${encodeURIComponent(cat)}/${id}`;
    const b64 = (s) => Buffer.from(s).toString('base64');
    const upload = async (cat, id) => (await api(base, 'POST', `${p(cat, id)}/run-uploads`, { name: '三月.csv', content_b64: b64('1,2') })).json.token;
    // 移分類
    const t1 = await upload('部門A', 'wa');
    assert.equal((await api(base, 'POST', `${p('部門A', 'wa')}/move`, { to: '部門B' })).status, 200);
    const r1 = await api(base, 'POST', `${p('部門B', 'wa')}/runs`, { uploads: { src: t1 } });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    // 分類改名
    const t2 = await upload('部門B', 'wa');
    assert.equal((await api(base, 'PUT', `/api/categories/${encodeURIComponent('部門B')}`, { name: '部門C' })).status, 200);
    const r2 = await api(base, 'POST', `${p('部門C', 'wa')}/runs`, { uploads: { src: t2 } });
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    // 跨 Workflow 挪用
    const t3 = await upload('部門C', 'wa');
    const steal = await api(base, 'POST', `${p('部門A', 'wb')}/runs`, { uploads: { src: t3 } });
    assert.equal(steal.status, 400);
    assert.ok(steal.json.error.includes('別條 Workflow') && !steal.json.error.includes('24 小時'), steal.json.error);
    // 過期被清掉
    const t4 = await upload('部門A', 'wb');
    fs.rmSync(path.join(dataDir, 'uploads', t4), { recursive: true, force: true });
    const gone = await api(base, 'POST', `${p('部門A', 'wb')}/runs`, { uploads: { src: t4 } });
    assert.equal(gone.status, 400);
    assert.equal(gone.json.error, '上傳的檔案找不到了（可能超過 24 小時被清掉），請重新選檔');
  } finally {
    await app.stop();
  }
});

test('排版輪 L11 ⑥⑦：舊定義不帶 uploads／note 開跑照舊（run 沒有新鍵）；24 小時沒用掉的暫存上傳在下次上傳時清掉', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = { format: 1, name: '舊', params: [], nodes: [{ id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '寫一句問候', next: [] }] };
    store.writeWorkflow('測試', 'old', def);
    const wfp = `/api/workflows/${encodeURIComponent('測試')}/old`;
    const started = await api(base, 'POST', `${wfp}/runs`, {});
    assert.equal(started.status, 200);
    assert.ok(!('note' in started.json), 'run 沒有 note');
    assert.ok(!fs.existsSync(path.join(dataDir, 'workflows', '測試', 'old', 'runs', started.json.run_id, 'in')), '沒有 in/ 夾');
    const b64 = Buffer.from('1').toString('base64');
    const first = await api(base, 'POST', `${wfp}/run-uploads`, { name: 'a.txt', content_b64: b64 });
    const past = new Date(Date.now() - 25 * 3600e3);
    fs.utimesSync(path.join(dataDir, 'uploads', first.json.token), past, past);
    const second = await api(base, 'POST', `${wfp}/run-uploads`, { name: 'b.txt', content_b64: b64 });
    assert.equal(second.status, 200);
    assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', first.json.token)), '過期的清掉');
    assert.ok(fs.existsSync(path.join(dataDir, 'uploads', second.json.token)), '新的留著');
  } finally {
    await app.stop();
  }
});

// ---- 本次附件（保留鍵 __run__）＝檔案版的「本次補充」，不綁欄位、每個 AI 步驟都看得到 ----
test('大跑輪 ①：本次附件走同一條 run-uploads 通道——檔搬進 runs/<rid>/in/、記在 run.run_files、不進 run.params；每個 AI 步驟的輸入都有「【你這次的附件】」＋檔名，跟「【你這次的補充】」成對；逐欄上傳照舊只餵給引用那個欄位的步驟', async () => {
  const { app, base, dataDir, adapter } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: '附件月報',
      params: [{ key: 'src', label: '原始資料', default: '', input: 'file', required: true }],
      nodes: [
        { id: 'a', title: '整理', executor: 'ai', stop_point: 'never', instruction: '整理 {{src}} 的內容', next: ['b'] },
        { id: 'b', title: '寫報告', executor: 'ai', stop_point: 'never', instruction: '依上一步寫報告', next: [] },
      ],
      check: { enabled: false }, supervisor: { enabled: false },
    };
    store.writeWorkflow('測試', 'att', def);
    const wfp = `/api/workflows/${encodeURIComponent('測試')}/att`;
    const b64 = (s) => Buffer.from(s).toString('base64');
    const upload = async (name, text) => (await api(base, 'POST', `${wfp}/run-uploads`, { name, content_b64: b64(text) })).json.token;
    const fieldTok = await upload('欄位檔.csv', 'a,b\n1,2');
    const attTok = await upload('這趟附件.md', '# 這一趟的附件');
    const started = await api(base, 'POST', `${wfp}/runs`, { uploads: { src: fieldTok, __run__: attTok }, note: '這次特別留意新品類' });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const rid = started.json.run_id;
    assert.equal(started.json.params.src, '欄位檔.csv', '逐欄上傳照舊寫進 run.params');
    assert.ok(!('__run__' in started.json.params), '本次附件不是欄位，不進 run.params');
    assert.deepEqual(started.json.run_files, ['這趟附件.md'], '本次附件記在 run.run_files');
    const inDir = path.join(dataDir, 'workflows', '測試', 'att', 'runs', rid, 'in');
    const attPath = path.join(inDir, '這趟附件.md');
    assert.equal(fs.readFileSync(attPath, 'utf8'), '# 這一趟的附件', '附件跟著這一趟存');
    assert.deepEqual(fs.readdirSync(inDir).sort(), ['欄位檔.csv', '這趟附件.md'].sort(), 'in/ 只有這兩個檔');
    assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', attTok)), '暫存用過即刪');
    assert.deepEqual(store.listRefFiles('測試', 'att'), [], '不進 Workflow 參考檔');
    await pollRun(base, `${wfp}/runs/${rid}`, (r) => r.status === 'done');
    const a = adapter.calls.find((c) => c.nodeId === 'a');
    const bb = adapter.calls.find((c) => c.nodeId === 'b');
    for (const [id, c] of [['a', a], ['b', bb]]) {
      assert.ok(c.upstream.includes('【你這次的附件】'), `${id} 步看得到本次附件：${c.upstream}`);
      assert.ok(c.upstream.includes('這趟附件.md'), `${id} 步拿得到附件檔名：${c.upstream}`);
      assert.ok(c.upstream.indexOf('【你這次的補充】') < c.upstream.indexOf('【你這次的附件】'), `${id} 步附件接在補充後面`);
      assert.ok(c.attachments.includes(attPath), `${id} 步的檔案清單裡有本次附件（真的讀得到那個檔）`);
    }
    // 逐欄上傳不受污染：只有引用 {{src}} 的第一步拿得到那個檔，下游照舊靠沿路全帶
    assert.deepEqual(a.attachments, [path.join(inDir, '欄位檔.csv'), attPath], '逐欄上傳只餵給引用該欄位的步驟（附件跟在後面）');
    assert.deepEqual(bb.attachments, [path.join(inDir, '欄位檔.csv'), attPath], '原始檔每步都看得到（US-108）：沒引用該欄位的步驟也拿到那份上傳，本次附件跟在後面');
    assert.ok(!a.upstream.includes('欄位檔.csv') && !bb.upstream.includes('欄位檔.csv'), '逐欄上傳不會混進本次附件那一段');
  } finally {
    await app.stop();
  }
});

test('大跑輪 ②：本次附件的護欄逐條沿用現行規則——副檔名白名單、10MB、空檔、檔名路徑符號、token 路徑穿越、代碼用過即失效、跨 Workflow 挪用；一鍵一檔，寫不到 uploads 目錄以外', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const mk = (name) => ({
      format: 1, name, params: [],
      nodes: [{ id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '寫一句問候', next: [] }],
      check: { enabled: false }, supervisor: { enabled: false },
    });
    store.writeWorkflow('測試', 'g1', mk('G1'));
    store.writeWorkflow('測試', 'g2', mk('G2'));
    const p1 = `/api/workflows/${encodeURIComponent('測試')}/g1`;
    const p2 = `/api/workflows/${encodeURIComponent('測試')}/g2`;
    const b64 = (s) => Buffer.from(s).toString('base64');
    // 上傳端點的護欄與逐欄上傳同一套（同一條通道，沒有另立一套）
    for (const bad of ['../外面.md', '..\\外面.md', 'a/b.md', 'CON.md']) {
      assert.equal((await api(base, 'POST', `${p1}/run-uploads`, { name: bad, content_b64: b64('x') })).status, 400, bad);
    }
    assert.equal((await api(base, 'POST', `${p1}/run-uploads`, { name: '殼.exe', content_b64: b64('x') })).status, 400, '副檔名白名單');
    assert.equal((await api(base, 'POST', `${p1}/run-uploads`, { name: '空.md', content_b64: '' })).status, 400, '空檔');
    assert.equal((await api(base, 'POST', `${p1}/run-uploads`, { name: '大.md', content_b64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') })).status, 413, '10MB 封頂');
    // 開跑端：保留鍵不能拿來做路徑穿越，也不能撿別條 Workflow 的代碼
    for (const bad of ['../x', '..\\x', '/etc/passwd', 'f'.repeat(23), 'F'.repeat(24), 'g'.repeat(24)]) {
      const r = await api(base, 'POST', `${p1}/runs`, { uploads: { __run__: bad } });
      assert.equal(r.status, 400, `token「${bad}」該擋下`);
      assert.ok(!r.json.error.includes(dataDir), '錯誤訊息不透絕對路徑');
    }
    assert.equal(store.listRuns('測試', 'g1').length, 0, '擋下的都沒開跑');
    const tok = (await api(base, 'POST', `${p2}/run-uploads`, { name: '別條的.md', content_b64: b64('x') })).json.token;
    const steal = await api(base, 'POST', `${p1}/runs`, { uploads: { __run__: tok } });
    assert.equal(steal.status, 400, '別條 Workflow 發的代碼不能拿來當這條的附件');
    assert.ok(steal.json.error.includes('別條 Workflow'), steal.json.error);
    const own = await api(base, 'POST', `${p2}/runs`, { uploads: { __run__: tok } });
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal((await api(base, 'POST', `${p2}/runs`, { uploads: { __run__: tok } })).status, 400, '同一個代碼不能再用');
    // 落地的檔一律在這一趟的 in/ 底下，名字洗過（一鍵一檔：uploads 是物件，同鍵只會有一個）
    const inDir = path.join(dataDir, 'workflows', '測試', 'g2', 'runs', own.json.run_id, 'in');
    assert.deepEqual(fs.readdirSync(inDir), ['別條的.md']);
    assert.deepEqual(own.json.run_files, ['別條的.md']);
  } finally {
    await app.stop();
  }
});

test('大跑輪 ③：舊 run 與沒帶附件的 run 形狀一字不動——沒有 run_files 鍵、輸入逐字照舊；run_files 被手動塞了路徑符號也只會落在這一趟的 in/（讀不到＝當沒有）', async () => {
  const { app, base, dataDir, adapter } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: '無附件', params: [],
      nodes: [{ id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '寫一句問候', next: [] }],
      check: { enabled: false }, supervisor: { enabled: false },
    };
    store.writeWorkflow('測試', 'plain', def);
    const wfp = `/api/workflows/${encodeURIComponent('測試')}/plain`;
    const started = await api(base, 'POST', `${wfp}/runs`, {});
    assert.equal(started.status, 200);
    assert.ok(!('run_files' in started.json), '沒帶附件＝不加鍵');
    await pollRun(base, `${wfp}/runs/${started.json.run_id}`, (r) => r.status === 'done');
    const a = adapter.calls.find((c) => c.nodeId === 'a');
    assert.equal(a.upstream, '', '沒有附件時輸入逐字照舊（第一步空字串）');
    // 手改壞的 run.yaml：run_files 塞路徑符號——runInputPath 會洗名，撈不到就當沒有，不會讀到 in/ 以外的東西
    const rid2 = (await api(base, 'POST', `${wfp}/runs`, {})).json.run_id;
    await pollRun(base, `${wfp}/runs/${rid2}`, (r) => r.status === 'done');
    const run = store.readRun('測試', 'plain', rid2);
    run.run_files = ['../../../../etc/passwd', '..\\..\\秘密.md'];
    run.status = 'running';
    run.steps.a = { ...run.steps.a, status: 'pending', output: null };
    store.writeRun('測試', 'plain', rid2, run);
    await api(base, 'GET', `${wfp}/runs/${rid2}`); // 卡在 running＝伺服器順手接回續跑
    await pollRun(base, `${wfp}/runs/${rid2}`, (r) => r.status === 'done');
    const a2 = adapter.calls.filter((c) => c.nodeId === 'a').at(-1);
    assert.ok(!a2.upstream.includes('passwd') && !a2.upstream.includes('秘密'), `撈不到的附件當沒有：${a2.upstream}`);
  } finally {
    await app.stop();
  }
});

// ================= 多組織真隔離：組織登錄＋四條路由＋單一時鐘＋用量歸戶 =================
// 每個組織各自一整套資料（data/orgs/<id>/），切過去看到的 Workflow 與記憶完全不同；
// 既有路由一律不加前綴，「目前組織」就是全部路由的預設對象。

const orgDirOf = (root, id) => path.join(root, 'orgs', id);
const orgWait = (ms) => new Promise((r) => setTimeout(r, ms));

// 帶時鐘的啟動（排程測試要推時間）；base 每次重啟都會換埠，所以用函式取
async function startOrgApp(nowIso = '2026-09-01T07:00', tickMs = 3600_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-orgs-'));
  const adapter = fakeAdapter();
  const clock = { t: new Date(nowIso).getTime() };
  const app = createApp({ dataDir: root, adapter, now: () => clock.t });
  await app.start(0, { tickMs });
  return { app, adapter, clock, root, base: () => `http://127.0.0.1:${app.port()}` };
}

test('多組織①：GET /api/orgs 回目前組織、清單與各組織的 Workflow 數（名字來自各自的 settings.json）', async () => {
  const { app, base, root } = await startApp();
  try {
    const first = (await api(base, 'GET', '/api/orgs')).json;
    assert.equal(first.current, 'main', '全新安裝＝一個 main');
    assert.equal(first.orgs.length, 1);
    assert.equal(first.orgs[0].id, 'main');
    assert.equal(first.orgs[0].name, '組織', '沒取名字＝「組織」');
    assert.equal(first.orgs[0].workflows, 2, '種了兩個範例');
    assert.ok(first.orgs[0].created_at, '有建立時間');

    await api(base, 'PUT', '/api/settings', { company_name: '明遠' });
    await api(base, 'POST', '/api/workflows', { category: '測試', def: M1B_DEF() });
    const made = await api(base, 'POST', '/api/orgs', { name: '第二間' });
    const list = (await api(base, 'GET', '/api/orgs')).json;
    assert.equal(list.current, 'main', '建完不切換');
    assert.deepEqual(list.orgs.map((o) => o.name).sort(), ['明遠', '第二間']);
    assert.equal(list.orgs.find((o) => o.id === 'main').workflows, 3, '主組織多了一條');
    assert.equal(list.orgs.find((o) => o.id === made.json.id).workflows, 2, '新組織只有範例');
    assert.ok(fs.existsSync(path.join(root, 'orgs.json')), '登錄簿落地在資料根');
  } finally { await app.stop(); }
});

test('多組織②：POST /api/orgs 建夾＋種範例＋寫名字，不切換；名字太長 400', async () => {
  const { app, base, root } = await startApp();
  try {
    const made = await api(base, 'POST', '/api/orgs', { name: '第二間' });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const id = made.json.id;
    assert.equal(made.json.name, '第二間');
    assert.ok(/^org-[a-z0-9]+-[a-z0-9]{4}$/.test(id), `新代號是 org-…：${id}`);
    const dir = orgDirOf(root, id);
    assert.ok(fs.existsSync(dir), '組織夾建出來了');
    const store = createStore(dir);
    assert.deepEqual(store.listWorkflows().map((w) => w.category), ['範例', '範例'], '新組織也有範例分類');
    assert.equal(store.readSettings().company_name, '第二間', '名字寫進該組織的 settings.json');
    assert.equal((await api(base, 'GET', '/api/orgs')).json.current, 'main', '目前組織沒被換掉');
    assert.equal((await api(base, 'GET', '/api/settings')).json.company_name, '', '主組織的名字沒被寫到');

    const long = await api(base, 'POST', '/api/orgs', { name: '赫'.repeat(61) });
    assert.equal(long.status, 400);
    assert.ok(long.json.error.includes('60 字內'), long.json.error);
    assert.equal((await api(base, 'GET', '/api/orgs')).json.orgs.length, 2, '擋下來就不留半個夾');
    const noName = await api(base, 'POST', '/api/orgs', {});
    assert.equal(noName.status, 200);
    assert.equal(noName.json.name, '組織', '沒給名字＝「組織」');
  } finally { await app.stop(); }
});

test('多組織③：PUT /api/orgs/current 切過去，Workflow／記憶／通知／排程／設定全換一套；id 不存在 404', async () => {
  const { app, base, root } = await startApp();
  try {
    // 主組織塞滿五種資料
    const wf = await api(base, 'POST', '/api/workflows', { category: '測試', def: M1B_DEF() });
    await api(base, 'POST', '/api/schedules', { workflow_id: `測試/${wf.json.id}`, freq: 'daily', time: '08:00' });
    await api(base, 'PUT', '/api/settings', { company_name: '明遠' });
    const mainStore = createStore(orgDirOf(root, 'main'));
    mainStore.writeCard(manual({ id: 'h-main', bucket: 'habit', text: '主組織的習慣', field: '語氣', scope: { level: 'all' } }));
    mainStore.writeNotices([{ id: 'n-main', type: 'missed', title: '主組織的通知', status: 'unread', at: '2026-09-01T00:00' }]);

    const id = (await api(base, 'POST', '/api/orgs', { name: '第二間' })).json.id;
    const missing = await api(base, 'PUT', '/api/orgs/current', { id: 'org-nope' });
    assert.equal(missing.status, 404);
    assert.equal((await api(base, 'GET', '/api/orgs')).json.current, 'main', '切失敗不動目前組織');

    const sw = await api(base, 'PUT', '/api/orgs/current', { id });
    assert.equal(sw.status, 200);
    assert.deepEqual(sw.json, { ok: true, current: id });
    assert.equal((await api(base, 'GET', '/api/workflows')).json.length, 2, '只剩範例');
    assert.ok(!(await api(base, 'GET', '/api/workflows')).json.some((w) => w.category === '測試'));
    assert.equal((await api(base, 'GET', '/api/memory/cards?bucket=habit')).json.length, 0, '記憶卡不跟過來');
    assert.deepEqual((await api(base, 'GET', '/api/notices')).json.unread, [], '通知不跟過來');
    assert.equal((await api(base, 'GET', '/api/schedules')).json.length, 0, '排程不跟過來');
    const s = (await api(base, 'GET', '/api/settings')).json;
    assert.equal(s.company_name, '第二間');
    assert.equal(s.data_dir, orgDirOf(root, id), 'data_dir 指到新組織夾');

    // 切回去＝原封不動
    await api(base, 'PUT', '/api/orgs/current', { id: 'main' });
    assert.equal((await api(base, 'GET', '/api/workflows')).json.length, 3);
    assert.equal((await api(base, 'GET', '/api/memory/cards?bucket=habit')).json.length, 1);
    assert.equal((await api(base, 'GET', '/api/notices')).json.unread.length, 1);
    assert.equal((await api(base, 'GET', '/api/schedules')).json.length, 1);
    assert.equal((await api(base, 'GET', '/api/settings')).json.company_name, '明遠');
    assert.equal((await api(base, 'GET', '/api/settings')).json.data_dir, orgDirOf(root, 'main'));
  } finally { await app.stop(); }
});

test('多組織④：切換之後既有路由寫進去的東西落在新組織夾，PUT /api/settings 改的是目前組織的名字', async () => {
  const { app, base, root } = await startApp();
  try {
    const id = (await api(base, 'POST', '/api/orgs', { name: '第二間' })).json.id;
    await api(base, 'PUT', '/api/orgs/current', { id });
    const made = await api(base, 'POST', '/api/workflows', { category: '新的', def: M1B_DEF({ name: '只在第二間' }) });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.ok(fs.existsSync(path.join(orgDirOf(root, id), 'workflows', '新的', made.json.id)), '檔案落在第二間的夾裡');
    assert.ok(!fs.existsSync(path.join(orgDirOf(root, 'main'), 'workflows', '新的')), '主組織夾沒被碰到');
    await api(base, 'PUT', '/api/settings', { company_name: '改過的名字' });
    const list = (await api(base, 'GET', '/api/orgs')).json;
    assert.equal(list.orgs.find((o) => o.id === id).name, '改過的名字', '組織清單的名字跟著改');
    assert.equal(list.orgs.find((o) => o.id === 'main').name, '組織', '主組織的名字不受影響');
  } finally { await app.stop(); }
});

test('多組織⑤：DELETE /api/orgs/:id 是「移出」——夾搬到 orgs-trash/；目前組織 400、最後一個 400、不存在 404', async () => {
  const { app, base, root } = await startApp();
  try {
    const nope = await api(base, 'DELETE', '/api/orgs/org-nope');
    assert.equal(nope.status, 404);
    const last = await api(base, 'DELETE', '/api/orgs/main');
    assert.equal(last.status, 400);
    assert.ok(last.json.error.includes('最後一個'), last.json.error);

    const id = (await api(base, 'POST', '/api/orgs', { name: '第二間' })).json.id;
    await api(base, 'PUT', '/api/orgs/current', { id });
    const self = await api(base, 'DELETE', `/api/orgs/${id}`);
    assert.equal(self.status, 400);
    assert.ok(self.json.error.includes('正在用'), self.json.error);
    assert.ok(fs.existsSync(orgDirOf(root, id)), '擋下來就不准動夾');

    await api(base, 'PUT', '/api/orgs/current', { id: 'main' });
    const out = await api(base, 'DELETE', `/api/orgs/${id}`);
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.ok(!fs.existsSync(orgDirOf(root, id)), '原位置沒了');
    const trash = fs.readdirSync(path.join(root, 'orgs-trash'));
    assert.equal(trash.length, 1);
    assert.ok(trash[0].startsWith(`${id}-`), '搬進 orgs-trash/<id>-<時間戳>');
    assert.ok(fs.existsSync(path.join(root, 'orgs-trash', trash[0], 'settings.json')), '資料整套跟著搬，沒被刪');
    const after = (await api(base, 'GET', '/api/orgs')).json;
    assert.deepEqual(after.orgs.map((o) => o.id), ['main'], '登錄簿也拿掉了');
    assert.equal((await api(base, 'DELETE', `/api/orgs/${id}`)).status, 404, '再刪一次＝找不到');
  } finally { await app.stop(); }
});

test('多組織⑥：新組織代號撞到既有（大小寫不分）或夾已經在了就重抽，不覆蓋別人的夾', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-orgid-'));
  fs.mkdirSync(path.join(root, 'orgs'), { recursive: true });
  const gen = (...ids) => { const q = [...ids]; return () => q.shift(); };
  assert.equal(freeOrgId(root, [], gen('org-aaaa')), 'org-aaaa', '沒撞就用第一支');
  assert.equal(freeOrgId(root, ['org-aaaa'], gen('org-aaaa', 'org-bbbb')), 'org-bbbb', '撞登錄簿→重抽');
  assert.equal(freeOrgId(root, ['ORG-AAAA'], gen('org-aaaa', 'org-bbbb')), 'org-bbbb', 'NTFS 不分大小寫，也算撞到');
  fs.mkdirSync(path.join(root, 'orgs', 'org-cccc'), { recursive: true });
  fs.writeFileSync(path.join(root, 'orgs', 'org-cccc', 'settings.json'), '{"company_name":"別人的"}');
  assert.equal(freeOrgId(root, [], gen('org-cccc', 'org-dddd')), 'org-dddd', '夾已經在了→重抽，不沿用');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'orgs', 'org-cccc', 'settings.json'), 'utf8')).company_name, '別人的', '別人的資料原封不動');
});

test('多組織⑦：一個時鐘逐組織敲——B 的排程在目前組織＝A 的時候照樣到點開跑', async () => {
  const ctx = await startOrgApp('2026-09-01T07:00');
  const { app, clock, root } = ctx;
  try {
    // 在 B 建流程與排程，然後切回 A
    const id = (await api(ctx.base(), 'POST', '/api/orgs', { name: 'B 公司' })).json.id;
    await api(ctx.base(), 'PUT', '/api/orgs/current', { id });
    const wf = await api(ctx.base(), 'POST', '/api/workflows', { category: '測試', def: M1B_DEF() });
    const sched = await api(ctx.base(), 'POST', '/api/schedules', { workflow_id: `測試/${wf.json.id}`, freq: 'daily', time: '08:00' });
    assert.equal(sched.status, 200, JSON.stringify(sched.json));
    await api(ctx.base(), 'PUT', '/api/orgs/current', { id: 'main' });

    clock.t = new Date('2026-09-01T08:00').getTime();
    await app.stop();
    await app.start(0, { tickMs: 3600_000 }); // start 內含立刻敲一輪＝逐組織 tickOnce
    assert.equal((await api(ctx.base(), 'GET', '/api/orgs')).json.current, 'main', '目前組織還是 A');

    const storeB = createStore(orgDirOf(root, id));
    for (let i = 0; i < 100 && storeB.listRuns('測試', wf.json.id).length === 0; i += 1) await orgWait(20);
    const runs = storeB.listRuns('測試', wf.json.id);
    assert.equal(runs.length, 1, 'B 的排程到點自己開跑了');
    assert.equal(storeB.readRun('測試', wf.json.id, runs[0]).source, 'schedule');
    const storeA = createStore(orgDirOf(root, 'main'));
    assert.deepEqual(storeA.readSchedules(), [], 'A 沒有這條排程');
    assert.ok(!storeA.listWorkflows().some((w) => w.category === '測試'), 'A 也沒有這條流程');
  } finally { await app.stop(); }
});

test('多組織⑧：用量各歸各的帳本——A 跑一趟、B 跑一趟，兩本 usage.jsonl 只含自己的列', async () => {
  const { app, base, adapter, root } = await startApp();
  try {
    adapter.enableUsage();
    const reply = (name) => `拆好了\n\`\`\`yaml\n${JSON.stringify({ format: 1, name, params: [], nodes: [{ id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做', next: [] }] })}\n\`\`\``;
    adapter.setCompleteResponses([reply('A 的流程')]);
    const rA = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: 'A 這邊' }], phase: 'draft' });
    assert.equal(rA.status, 200, JSON.stringify(rA.json));

    const id = (await api(base, 'POST', '/api/orgs', { name: 'B 公司' })).json.id;
    await api(base, 'PUT', '/api/orgs/current', { id });
    adapter.setCompleteResponses([reply('B 的流程')]);
    const rB = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: 'B 這邊' }], phase: 'draft' });
    assert.equal(rB.status, 200, JSON.stringify(rB.json));

    const rows = (org) => createStore(orgDirOf(root, org)).readUsage();
    const composeOf = (org) => rows(org).filter((u) => u.kind === 'compose');
    assert.equal(composeOf('main').length, 1, 'A 的帳本只有 A 那一趟');
    assert.equal(composeOf(id).length, 1, 'B 的帳本只有 B 那一趟');
    assert.ok(rows('main').every((u) => u.org === undefined), '帳本裡不留 org 章（在誰的夾裡就是誰的）');
    assert.ok(rows(id).every((u) => u.org === undefined));
    // 蓋章確實有蓋：兩趟的 meta 分別標到自己的組織
    const composeCalls = adapter.completes.filter((c) => c.meta?.kind === 'compose');
    assert.deepEqual(composeCalls.map((c) => c.meta.org), ['main', id], '每次呼叫都蓋上所屬組織');
  } finally { await app.stop(); }
});

test('多組織⑨：路由紀律——方法／段數對不上一律 404，不准拼錯還回 200', async () => {
  const { app, base } = await startApp();
  try {
    for (const [method, p] of [['GET', '/api/orgs/main'], ['POST', '/api/orgs/current'], ['PUT', '/api/orgs'], ['DELETE', '/api/orgs'], ['GET', '/api/orgs/main/workflows']]) {
      const r = await api(base, method, p, method === 'GET' ? undefined : {});
      assert.equal(r.status, 404, `${method} ${p} 應該 404，實際 ${r.status}`);
    }
    // 既有路由沒被加上 /o/:org 前綴——多一段就是找不到
    assert.equal((await api(base, 'GET', '/api/o/main/workflows')).status, 404);
    assert.equal((await api(base, 'GET', '/api/workflows')).status, 200, '既有路由照舊');
  } finally { await app.stop(); }
});

test('多組織⑩：重開還認得——orgs.json 記住目前組織與清單，範例不會再種一次', async () => {
  const { app, base, root } = await startApp();
  let id;
  try {
    id = (await api(base, 'POST', '/api/orgs', { name: '第二間' })).json.id;
    await api(base, 'PUT', '/api/orgs/current', { id });
    await api(base, 'POST', '/api/workflows', { category: '測試', def: M1B_DEF() });
  } finally { await app.stop(); }

  const again = createApp({ dataDir: root, adapter: fakeAdapter() });
  await again.start(0);
  const base2 = `http://127.0.0.1:${again.port()}`;
  try {
    const list = (await api(base2, 'GET', '/api/orgs')).json;
    assert.equal(list.current, id, '重開還停在第二間');
    assert.deepEqual(list.orgs.map((o) => o.id).sort(), ['main', id].sort());
    assert.equal(list.orgs.find((o) => o.id === id).name, '第二間');
    const wfs = (await api(base2, 'GET', '/api/workflows')).json;
    assert.equal(wfs.filter((w) => w.category === '範例').length, 2, '範例沒被種成四個');
    assert.equal(wfs.filter((w) => w.category === '測試').length, 1, '上次存的還在');
  } finally { await again.stop(); }
});

// ── 2026-09-18  ──────────────────────────────────────────────

test('來源檢查：別的網站打過來一律擋，自己的畫面與 CLI 照常', async () => {
  const { app, base } = await startApp();
  try {
    const port = app.port();
    const post = (headers) => fetch(`${base}/api/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ category: '測試', def: { format: 1, name: 'x', nodes: [] } }),
    });
    assert.equal((await post({ origin: 'https://evil.example' })).status, 403, '跨站 Origin 要擋');
    assert.equal((await post({ origin: `http://127.0.0.1:${port + 1}` })).status, 403, '本機別的埠也算跨站');
    assert.notEqual((await post({ origin: `http://127.0.0.1:${port}` })).status, 403, '自己的畫面要放行');
    assert.notEqual((await post({})).status, 403, '不帶 Origin 的 CLI／測試要放行');
    // 2026-09-18 二次審查：'null' 不是「沒帶」，是 sandbox iframe／data: 頁的不透明來源。
    // 放行它＝任何網站塞一個 <iframe sandbox="allow-scripts"> 就能打進來（實測打到 200 並建出 Workflow）
    assert.equal((await post({ origin: 'null' })).status, 403, '不透明來源（sandbox iframe）要擋');
    // DNS rebinding：把別的網域指到 127.0.0.1，Host 就不是本機名字。
    // 這裡得用 raw http——fetch 不讓你自己設 Host（forbidden header），設了會被丟掉。
    const rawGet = (host) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET', headers: { host } },
        (res) => { res.resume(); resolve(res.statusCode); });
      r.on('error', reject);
      r.end();
    });
    assert.equal(await rawGet('evil.example'), 403, 'Host 不是本機名字要擋');
    assert.equal(await rawGet(`127.0.0.1:${port}`), 200, '正常的 Host 要通');
  } finally {
    await app.stop();
  }
});

test('長中文存檔不被切壞：body 跨 64KB 塊界的字要原樣落地', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const long = `開頭${'繭'.repeat(40_000)}結尾`; // 120KB＞單塊 64KB，必定跨塊
    const def = {
      format: 1,
      name: '長指示',
      params: [],
      nodes: [{ id: 'n1', title: '一', executor: 'ai', stop_point: 'never', instruction: long, next: [] }],
    };
    const created = await api(base, 'POST', '/api/workflows', { category: '測試', def });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const back = await api(base, 'GET', `/api/workflows/${encodeURIComponent('測試')}/${created.json.id}`);
    const got = back.json.nodes[0].instruction;
    assert.equal(got.includes('�'), false, 'body 出現 U+FFFD＝跨塊的中文被切壞了');
    assert.equal(got, long);
    // 落地的檔案本身也要是原文，不是只有回應對
    const onDisk = fs.readFileSync(path.join(dataDir, 'workflows', '測試', created.json.id, 'workflow.yaml'), 'utf8');
    assert.equal(onDisk.includes('�'), false, 'workflow.yaml 裡存進了亂碼');
  } finally {
    await app.stop();
  }
});

test('xlsx 預覽：中間的空白格不會讓後面的數字往左位移', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('表1');
  ws.getCell('A1').value = '品名';
  ws.getCell('C1').value = '金額'; // B1 故意留空——標題列填滿、資料列留空是最常見的表格形狀
  ws.getCell('A2').value = '椅子';
  ws.getCell('B2').value = '黑';
  ws.getCell('C2').value = 1200;
  const out = await previewArtifact(Buffer.from(await wb.xlsx.writeBuffer()), '表.xlsx');
  const rows = out.sheets[0].html.match(/<tr>.*?<\/tr>/g);
  const tds = (r) => (r.match(/<td>/g) ?? []).length;
  assert.equal(tds(rows[0]), 3, '標題列要有三格（中間是空的），不能塌成兩格');
  assert.equal(tds(rows[1]), 3);
  assert.ok(rows[0].includes('<td></td>'), '空白格要留一個空的 td');
  assert.ok(rows[1].includes('<td>1200</td></tr>'), '金額要留在第三欄，不能被擠到「黑」的位置');
});

// ---------- 安全兩條（09-19 裁定：技術帳直接修）----------
// 這支是公開庫，別人會 clone 回自己的機器上跑，最低防線要有。

test('安全 ①（L010）：請求內容超過上限就擋下，不是一直吃記憶體', async () => {
  const { app, base } = await startApp();
  try {
    const res = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_name: 'x'.repeat(17 * 1024 * 1024) }),
    });
    assert.equal(res.status, 413, '超過 16MB 回 413');
    assert.match((await res.json()).error, /太大/, '訊息講人話');
  } finally { await app.stop(); }
});

test('安全 ②（L033）：帶了 content-type 就必須是 JSON；沒帶的放行（CLI 與測試不經過瀏覽器）', async () => {
  const { app, base } = await startApp();
  try {
    const bad = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },   // 瀏覽器的「簡單請求」用這個繞過 preflight
      body: JSON.stringify({ company_name: '繞道' }),
    });
    assert.equal(bad.status, 415, 'text/plain 擋下');
    // fetch 一定會自己補一個 content-type（沒設就是 text/plain），所以「完全不帶」要用原生 http 才送得出來——
    // 那正是 CLI／curl 的樣子，它們不經過瀏覽器，也就沒有跨站那回事。
    const none = await new Promise((resolve) => {
      const u = new URL(`${base}/api/settings`);
      const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'PUT' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      r.end(JSON.stringify({ company_name: '沒帶型別' }));
    });
    assert.equal(none, 200, '沒帶 content-type 照舊放行');
    assert.equal((await api(base, 'GET', '/api/settings')).json.company_name, '沒帶型別', '真的寫進去了');
  } finally { await app.stop(); }
});

test('安全 ③：上限是照「本次附件」的 10MB 回推的——正常大小的附件不能被自己的防線擋掉', async () => {
  const { app, base } = await startApp();
  try {
    const made = await api(base, 'POST', '/api/workflows', { category: '測試', def: { format: 1, name: '附件測試', params: [], nodes: [{ id: 'n1', title: '一', executor: 'ai', stop_point: 'never', instruction: '做', next: [] }] } });
    assert.equal(made.status, 200, `先建得起來才測得到附件：${JSON.stringify(made.json).slice(0, 160)}`);
    const wf = made.json;
    const content = Buffer.alloc(9 * 1024 * 1024, 0x41).toString('base64'); // 9MB 的檔，base64 後約 12MB
    const res = await api(base, 'POST', `/api/workflows/${encodeURIComponent(wf.category)}/${encodeURIComponent(wf.id)}/run-uploads`, { name: '大檔.txt', content_b64: content });
    assert.equal(res.status, 200, `9MB 的附件要進得來（base64 後約 12MB，上限 16MB）：${JSON.stringify(res.json).slice(0, 120)}`);
  } finally { await app.stop(); }
});

// 檔案種類跟分類一樣不能全憑模型自律——模型漏寫或寫到中間步驟，
// 使用者在卡上選的東西就無聲消失。伺服器要把它蓋回「最後交付那一步」。
const F_DEF = {
  format: 1,
  name: '月報',
  params: [],
  nodes: [
    { id: 'a', title: '查數字', executor: 'ai', stop_point: 'never', instruction: '查', next: ['b'] },
    { id: 'b', title: '寫月報', executor: 'ai', stop_point: 'always', instruction: '寫', next: [] },
  ],
};
const F_REPLY = (def) => `落地了\n\`\`\`yaml\n${JSON.stringify(def)}\n\`\`\``;

test('成品格式輪：使用者選的檔案種類無條件蓋到最後交付那一步——模型漏寫也補得回來；沒選就一個字都不動', async () => {
  const { app, base, adapter } = await startApp();
  try {
    adapter.setCompleteResponses([F_REPLY(F_DEF)]);
    const res = await api(base, 'POST', '/api/compose', {
      messages: [{ role: 'user', text: '做月報' }], phase: 'draft', shape: {}, sources: [], output_file: 'pptx',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const nodes = res.json.draft.nodes;
    assert.equal(nodes.find((n) => n.id === 'b').output_file, 'pptx', '模型沒寫，伺服器補上');
    assert.equal(nodes.find((n) => n.id === 'a').output_file, undefined, '中間步驟不動——那可能是流程自己要的中繼檔');
    assert.ok(adapter.completes.some((c) => c.prompt?.includes('# 使用者已經選好的交付方式')), '同一趟的 prompt 也要講');

    // 模型寫錯格式 → 照樣蓋回去
    adapter.setCompleteResponses([F_REPLY({ ...F_DEF, nodes: F_DEF.nodes.map((n) => (n.id === 'b' ? { ...n, output_file: 'md' } : n)) })]);
    const r2 = await api(base, 'POST', '/api/compose', {
      messages: [{ role: 'user', text: '做月報' }], phase: 'draft', shape: {}, sources: [], output_file: 'docx',
    });
    assert.equal(r2.json.draft.nodes.find((n) => n.id === 'b').output_file, 'docx', '模型寫別的也蓋回使用者選的');

    // 沒選 → 模型寫什麼就是什麼
    adapter.setCompleteResponses([F_REPLY({ ...F_DEF, nodes: F_DEF.nodes.map((n) => (n.id === 'b' ? { ...n, output_file: 'xlsx' } : n)) })]);
    const r3 = await api(base, 'POST', '/api/compose', {
      messages: [{ role: 'user', text: '做月報' }], phase: 'draft', shape: {}, sources: [],
    });
    assert.equal(r3.json.draft.nodes.find((n) => n.id === 'b').output_file, 'xlsx', '沒選＝不插手（連跑那條路沒有卡）');

    // 人做的末步不掛檔案屬性
    const humanEnd = { ...F_DEF, nodes: [F_DEF.nodes[0], { ...F_DEF.nodes[1], executor: 'human', handoff: '寄出後回報' }] };
    adapter.setCompleteResponses([F_REPLY(humanEnd)]);
    const r4 = await api(base, 'POST', '/api/compose', {
      messages: [{ role: 'user', text: '做月報' }], phase: 'draft', shape: {}, sources: [], output_file: 'pptx',
    });
    assert.equal(r4.json.draft.nodes.find((n) => n.id === 'b').output_file, undefined, '人做步驟不是產檔步驟');
  } finally { await app.stop(); }
});

// 會踩到的六條：參考檔下載路由與卡住自救
test('I5（L022）：GET 參考檔＝下載——帶 content-disposition 與原檔名；不存在回 404', async () => {
  const { app, base } = await startApp();
  try {
    await api(base, 'POST', '/api/categories', { name: 'c' });
    const made = await api(base, 'POST', '/api/workflows', { category: 'c', def: { format: 1, name: 'w', params: [], nodes: [{ id: 'a', title: 'x', executor: 'ai', stop_point: 'never', instruction: 'x', next: [] }] } });
    const id = made.json.id;
    await api(base, 'POST', `/api/workflows/c/${id}/files`, { name: '手冊.md', content_b64: Buffer.from('內容一二三', 'utf8').toString('base64') });
    const r = await fetch(`${base}/api/workflows/c/${id}/files/${encodeURIComponent('手冊.md')}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename\*=UTF-8''/, '瀏覽器要當成下載，不是直接開');
    assert.equal(await r.text(), '內容一二三', '拿回來的是原內容');
    const miss = await fetch(`${base}/api/workflows/c/${id}/files/${encodeURIComponent('沒有這個.md')}`);
    assert.equal(miss.status, 404);
  } finally { await app.stop(); }
});

test('I6（L040）：resume-stuck——沒人在等才放行，有人在等回 409', async () => {
  const { app, base, adapter } = await startApp();
  try {
    await api(base, 'POST', '/api/categories', { name: 'c' });
    const def = { format: 1, name: 'w', params: [], nodes: [
      { id: 'a', title: '一', executor: 'ai', stop_point: 'always', instruction: 'x', next: ['b'] },
      { id: 'b', title: '二', executor: 'ai', stop_point: 'never', instruction: 'y', next: [] },
    ] };
    const made = await api(base, 'POST', '/api/workflows', { category: 'c', def });
    const id = made.json.id;
    const run = await api(base, 'POST', `/api/workflows/c/${id}/runs`, {});
    const rid = run.json.run_id;
    // 這時 a 停在停點等你 → 有人在等，不准放行
    const busy = await api(base, 'POST', `/api/workflows/c/${id}/runs/${rid}/resume-stuck`, {});
    assert.equal(busy.status, 409, JSON.stringify(busy.json));
    assert.match(busy.json.error, /還有步驟在等你/);
  } finally { await app.stop(); }
});

test('J1（L023）：刪掉流程參考檔時，各步驟勾著它的 attachments 一起清掉', async () => {
  const { app, base } = await startApp();
  try {
    await api(base, 'POST', '/api/categories', { name: 'c' });
    const def = { format: 1, name: 'w', params: [], nodes: [
      { id: 'a', title: '一', executor: 'ai', stop_point: 'never', instruction: 'x', next: ['b'], attachments: ['手冊.md', '別的.md'] },
      { id: 'b', title: '二', executor: 'ai', stop_point: 'never', instruction: 'y', next: [], attachments: ['手冊.md', { scope: 'company', name: '手冊.md' }] },
    ] };
    const made = await api(base, 'POST', '/api/workflows', { category: 'c', def });
    const id = made.json.id;
    for (const n of ['手冊.md', '別的.md']) {
      await api(base, 'POST', `/api/workflows/c/${id}/files`, { name: n, content_b64: Buffer.from('x').toString('base64') });
    }
    const del = await api(base, 'DELETE', `/api/workflows/c/${id}/files/${encodeURIComponent('手冊.md')}`, undefined);
    assert.equal(del.status, 200);
    assert.equal(del.json.cleared, 2, '兩個步驟各清掉一個勾選');
    const after = (await api(base, 'GET', `/api/workflows/c/${id}`)).json;
    assert.deepEqual(after.nodes[0].attachments, ['別的.md'], '同一步的其他參考檔不動');
    assert.deepEqual(after.nodes[1].attachments, [{ scope: 'company', name: '手冊.md' }], '共用檔同名的不歸這條路刪');
  } finally { await app.stop(); }
});

test('J2（L024）：GET /api/settings 的 app_version 是剝繭版號，設定檔自己的 version 不被蓋掉', async () => {
  const { app, base } = await startApp();
  try {
    const got = (await api(base, 'GET', '/api/settings')).json;
    assert.equal(typeof got.app_version, 'string', '剝繭版號走 app_version');
    assert.equal(got.version, 1, '設定檔的格式版本原樣');
    assert.ok(got.data_dir, 'data_dir 照舊');
  } finally { await app.stop(); }
});

// ===== 連線輪（ADR-006／US-100〜102）：清單路由、健檢自動抓一次、兩條擋、匯入關權限、拆解器能耐表 =====
import { classifyInit } from '../src/connectors.js';
import { CONNECTOR_INIT } from './fixtures.js';

async function startConnApp(fetchImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-conn-'));
  const adapter = fakeAdapter();
  const calls = { n: 0 };
  const app = createApp({ dataDir: root, adapter, fetchConnectors: async () => { calls.n += 1; return fetchImpl(); } });
  await app.start(0);
  return { app, base: `http://127.0.0.1:${app.port()}`, adapter, root, calls };
}
const CONN_OK = () => classifyInit(CONNECTOR_INIT, '2026-09-22T10:00:00.000Z');
const connWf = (perm) => ({ format: 1, name: '讀信整理', params: [], ...(perm ? { permissions: perm } : {}), nodes: [
  { id: 'mail', title: '讀來信', executor: 'ai', stop_point: 'never', instruction: '讀近 7 天來信', next: ['note'], connectors: ['claude.ai Gmail'] },
  { id: 'note', title: '讀筆記', executor: 'ai', stop_point: 'never', instruction: '依上一步讀筆記', next: [], connectors: ['claude.ai Notion'] },
] });

test('連線：GET /api/connectors 從沒抓過＝{checked_at:null, servers:[]}；POST refresh 抓一次寫快取、回契約形狀；失敗 502 人話且不蓋舊快取', async () => {
  let fail = false;
  const { app, base, root, calls } = await startConnApp(() => { if (fail) throw new Error('連不上 Claude（測試）'); return CONN_OK(); });
  try {
    assert.deepEqual((await api(base, 'GET', '/api/connectors')).json, { checked_at: null, servers: [] });
    assert.equal(calls.n, 0, 'GET 只讀快取，不自己抓');
    const r = await api(base, 'POST', '/api/connectors/refresh');
    assert.equal(r.status, 200);
    assert.equal(r.json.checked_at, '2026-09-22T10:00:00.000Z');
    const gmail = r.json.servers.find((s) => s.name === 'claude.ai Gmail');
    assert.deepEqual(Object.keys(gmail).sort(), ['blocked_tools', 'label', 'name', 'read_tools', 'source', 'status', 'summary']);
    assert.equal(gmail.label, 'Gmail');
    assert.ok(!r.json.servers.some((s) => s.source === 'plugin'));
    assert.ok(fs.existsSync(path.join(root, 'connectors.json')), '快取在資料根');
    assert.deepEqual((await api(base, 'GET', '/api/connectors')).json, r.json);
    fail = true;
    const bad = await api(base, 'POST', '/api/connectors/refresh');
    assert.equal(bad.status, 502);
    assert.ok(bad.json.error.includes('連不上'));
    assert.deepEqual((await api(base, 'GET', '/api/connectors')).json, r.json, '失敗不蓋舊快取');
  } finally {
    await app.stop();
  }
});

test('連線：/api/preflight——有步驟勾了服務且從沒抓過才自動抓一次；回 connector-unavailable（Notion 沒授權）與 connector_reads；沒勾服務不抓', async () => {
  const { app, base, calls } = await startConnApp(CONN_OK);
  try {
    const plain = await api(base, 'POST', '/api/preflight', { def: { format: 1, name: 'x', params: [], nodes: [{ id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '寫詩', next: [] }] } });
    assert.equal(calls.n, 0, '沒勾服務不抓');
    assert.deepEqual(plain.json.connector_reads, []);
    const pf = await api(base, 'POST', '/api/preflight', { def: connWf() });
    assert.equal(calls.n, 1, '從沒抓過＋有勾＝自動抓一次');
    const un = pf.json.issues.find((i) => i.code === 'connector-unavailable');
    assert.equal(un.node, 'note');
    assert.equal(un.connector, 'claude.ai Notion');
    assert.equal(un.status, 'needs-auth');
    assert.equal(un.link, 'https://claude.ai/settings/connectors');
    assert.deepEqual(pf.json.connector_reads, [{ node: 'mail', index: 1, labels: ['Gmail'] }, { node: 'note', index: 2, labels: ['Notion'] }]);
    await api(base, 'POST', '/api/preflight', { def: connWf() });
    assert.equal(calls.n, 1, '抓過了就讀快取，不再自動抓');
  } finally {
    await app.stop();
  }
});

test('連線：匯入確認一律關連線權限；POST /runs 被 connector-permission 擋 409（附 connector_reads）；打開權限、服務都已連上就放行（工具名傳遞由 runner 測試釘）', async () => {
  const { app, base, adapter, calls } = await startConnApp(CONN_OK);
  try {
    const def = connWf({ files: true, connectors: true });
    def.nodes[1].connectors = ['claude.ai Google Drive'];
    const conf = await api(base, 'POST', '/api/import/confirm', { def });
    assert.equal(conf.status, 200);
    const wfp = `/api/workflows/${encodeURIComponent(conf.json.category)}/${conf.json.id}`;
    const saved = (await api(base, 'GET', wfp)).json;
    assert.equal(saved.permissions.connectors, false, '匯入一律關');
    assert.deepEqual(saved.nodes[0].connectors, ['claude.ai Gmail'], '勾的服務保留');
    const blocked = await api(base, 'POST', `${wfp}/runs`, {});
    assert.equal(blocked.status, 409);
    const perm = blocked.json.issues.find((i) => i.code === 'connector-permission');
    assert.deepEqual(perm.connectors, ['claude.ai Gmail', 'claude.ai Google Drive']);
    assert.deepEqual(perm.fix, { kind: 'flow', id: 'permissions.connectors' });
    assert.deepEqual(blocked.json.connector_reads.map((c) => c.labels), [['Gmail'], ['Google Drive']]);
    assert.equal(calls.n, 1, '開跑前健檢也會在從沒抓過時抓一次');
    const put = await api(base, 'PUT', wfp, { def: { ...saved, permissions: { ...saved.permissions, connectors: true } } });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const started = await api(base, 'POST', `${wfp}/runs`, {});
    assert.equal(started.status, 200, JSON.stringify(started.json));
    await pollRun(base, `${wfp}/runs/${started.json.run_id}`, (r) => r.status === 'done' || r.status === 'paused');
    assert.ok(adapter.calls.some((c) => c.nodeId === 'mail'), '步驟有跑');
  } finally {
    await app.stop();
  }
});

test('連線：拆解器能耐表第五行列已連上的服務（伺服器從快取給）；拆出來的 connectors 只留已連上的', async () => {
  const { app, base, adapter } = await startConnApp(CONN_OK);
  try {
    await api(base, 'POST', '/api/connectors/refresh');
    const draft = connWf();
    adapter.setCompleteResponses([`拆好了\n\`\`\`yaml\n${yaml.dump(draft)}\`\`\``]);
    const r = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '每週整理來信' }], phase: 'draft' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const prompt = adapter.completes.find((c) => c.meta?.kind === 'compose').prompt;
    assert.ok(prompt.includes('Gmail（connectors 寫 "claude.ai Gmail"）') && !prompt.includes('Notion（connectors'), '只列已連上的');
    const n = Object.fromEntries(r.json.draft.nodes.map((x) => [x.id, x]));
    assert.deepEqual(n.mail.connectors, ['claude.ai Gmail']);
    assert.equal(n.mail.connectors_set_by, 'ai');
    assert.equal(n.note.connectors, undefined, 'Notion 沒授權，拆解器預勾丟掉');
  } finally {
    await app.stop();
  }
});

test('連線輪覆核必修：已存流程 PUT 漏帶 permissions 時沿用舊值；聊天改流程（from: chat）一律用舊權限，AI 開不了鎖', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const wfP = seedFlow(dataDir);
    const store = createStore(dataDir);
    const locked = { ...store.readWorkflow('旅遊', 'tokyo'), permissions: { files: false, connectors: false } };
    store.writeWorkflow('旅遊', 'tokyo', locked);
    // ① AI 回的草稿整個沒寫 permissions → 存檔後鎖還在
    const { permissions, ...noPerm } = locked;
    assert.equal((await api(base, 'PUT', wfP, { def: { ...noPerm, name: '東京行程二' }, from: 'chat' })).status, 200);
    assert.deepEqual(store.readWorkflow('旅遊', 'tokyo').permissions, { files: false, connectors: false }, '漏寫不准等於打開');
    // ② AI 回的草稿自己寫了 connectors: true（例如被匯入流程裡的指示騙）→ 聊天路徑不准開鎖
    assert.equal((await api(base, 'PUT', wfP, { def: { ...locked, permissions: { files: true, connectors: true } }, from: 'chat' })).status, 200);
    assert.deepEqual(store.readWorkflow('旅遊', 'tokyo').permissions, { files: false, connectors: false }, '聊天改流程不准動權限');
    // ③ 一般存檔只帶一半 → 另一半沿用
    assert.equal((await api(base, 'PUT', wfP, { def: { ...locked, permissions: { connectors: true } } })).status, 200);
    assert.deepEqual(store.readWorkflow('旅遊', 'tokyo').permissions, { files: false, connectors: true }, '使用者親手開的開關照存，沒帶的沿用');
  } finally { await app.stop(); }
});

// ---- Codex 2026-09-25 審查第一批（恢復既有承諾）：B04 已處理通知不重複開跑、B02 同名附件不互蓋 ----
test('B04：已處理的通知再打一次不重複開跑——連按兩次 makeup 只建一個 run、第二次 409 帶 already_done；done 之後 skip 也 409；同時打兩發也只開一趟', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = { format: 1, name: '補跑', params: [], nodes: [{ id: 'h', title: '人', executor: 'human', instruction: '手動', stop_point: 'never', next: [] }], check: { enabled: false }, supervisor: { enabled: false } };
    store.writeWorkflow('測試', 'mk', def);
    store.writeSchedules([{ id: 's-one', name: '第一條', workflow_id: '測試/mk', freq: 'daily', time: '08:00', enabled: false, remind_leads: [], overrides: {} }]);
    store.writeNotices([{ id: 'n-replay', type: 'missed', status: 'unread', schedule_id: 's-one', actions: ['makeup', 'skip'] }]);
    const act = (nid, action) => api(base, 'POST', `/api/notices/${nid}/act`, { action });
    const first = await act('n-replay', 'makeup');
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(store.listRuns('測試', 'mk').length, 1);
    const second = await act('n-replay', 'makeup');
    assert.equal(second.status, 409, JSON.stringify(second.json));
    assert.equal(second.json.already_done, true);
    assert.ok(typeof second.json.error === 'string' && second.json.error, '帶人話');
    assert.equal(store.listRuns('測試', 'mk').length, 1, '絕不第二次開跑');
    assert.equal(store.readNotices().find((n) => n.id === 'n-replay').result, '已補跑', '第一次的留痕不被蓋掉');
    assert.equal((await act('n-replay', 'skip')).status, 409, 'done 之後任何動作都不再處理');
    // 同時打兩發（第二發在第一發讀 body 時就進來）也只開一趟
    store.writeNotices([{ id: 'n-race', type: 'missed', status: 'unread', schedule_id: 's-one', actions: ['makeup', 'skip'] }]);
    const both = await Promise.all([act('n-race', 'makeup'), act('n-race', 'makeup')]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], JSON.stringify(both.map((r) => r.json)));
    assert.equal(store.listRuns('測試', 'mk').length, 2, '兩發只多一趟');
    assert.equal(store.readNotices().find((n) => n.id === 'n-race').status, 'done');
  } finally { await app.stop(); }
});

test('B02：同一趟附兩份同名 source.csv 兩份都在——第二份落盤改名 source-2.csv、run.run_files／run.params 記實際檔名、內容各自正確；欄位上傳跟附件大小寫撞名也不互蓋', async () => {
  const { app, base, dataDir } = await startApp();
  try {
    const store = createStore(dataDir);
    const def = {
      format: 1, name: '同名附件',
      params: [{ key: 'src', label: '原始資料', default: '', input: 'file', required: false }],
      nodes: [{ id: 'h', title: '人', executor: 'human', instruction: '看檔', stop_point: 'never', next: [] }],
      check: { enabled: false }, supervisor: { enabled: false },
    };
    store.writeWorkflow('測試', 'dup', def);
    const wfp = `/api/workflows/${encodeURIComponent('測試')}/dup`;
    const b64 = (s) => Buffer.from(s).toString('base64');
    const upload = async (name, text) => (await api(base, 'POST', `${wfp}/run-uploads`, { name, content_b64: b64(text) })).json.token;
    const t1 = await upload('source.csv', 'FIRST');
    const t2 = await upload('source.csv', 'SECOND');
    const t3 = await upload('Source.csv', 'FIELD');
    const started = await api(base, 'POST', `${wfp}/runs`, { uploads: { __run__: [t1, t2], src: t3 } });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const rid = started.json.run_id;
    const inDir = path.join(dataDir, 'workflows', '測試', 'dup', 'runs', rid, 'in');
    assert.deepEqual(fs.readdirSync(inDir).sort(), ['Source-3.csv', 'source-2.csv', 'source.csv'], '三份都在，各有各的名字');
    const read = (n) => fs.readFileSync(path.join(inDir, n), 'utf8');
    assert.equal(read('source.csv'), 'FIRST', '先傳的內容不動');
    assert.equal(read('source-2.csv'), 'SECOND');
    assert.equal(read('Source-3.csv'), 'FIELD');
    assert.deepEqual(started.json.run_files, ['source.csv', 'source-2.csv'], 'run.run_files 記的是實際落盤名（欄位名不變、值＝真檔名）');
    assert.equal(started.json.params.src, 'Source-3.csv', 'run.params 記的是實際落盤名');
    const onDisk = store.readRun('測試', 'dup', rid);
    assert.deepEqual(onDisk.run_files, ['source.csv', 'source-2.csv']);
    assert.equal(onDisk.params.src, 'Source-3.csv');
    for (const t of [t1, t2, t3]) assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', t)), '暫存照舊用過即刪');
  } finally { await app.stop(); }
});

// —— 一句話安裝：開機自啟 .cmd 要把目前行程的資料夾／埠帶過去，不然裝到 %LOCALAPPDATA% 後開機會用錯資料夾 ——
test('server：開機自啟 .cmd——行程帶 BOJIAN_DATA_DIR／BOJIAN_PORT 就寫 set 行，不帶就照舊（API 形狀不變）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-autostart-'));
  const startup = path.join(root, 'Startup');
  const saved = { d: process.env.BOJIAN_DATA_DIR, p: process.env.BOJIAN_PORT, c: process.env.BOJIAN_CLAUDE_BIN };
  const restore = () => {
    if (saved.d === undefined) delete process.env.BOJIAN_DATA_DIR; else process.env.BOJIAN_DATA_DIR = saved.d;
    if (saved.p === undefined) delete process.env.BOJIAN_PORT; else process.env.BOJIAN_PORT = saved.p;
    if (saved.c === undefined) delete process.env.BOJIAN_CLAUDE_BIN; else process.env.BOJIAN_CLAUDE_BIN = saved.c;
  };
  delete process.env.BOJIAN_CLAUDE_BIN;
  const app = createApp({ dataDir: path.join(root, 'data'), adapter: fakeAdapter(), autostartDir: startup });
  await app.start(0);
  const base = `http://127.0.0.1:${app.port()}`;
  const cmdFile = path.join(startup, 'bojian-autostart.cmd');
  try {
    // 帶 env：set 行在、且在啟動那行之前
    const dataAbs = path.join(root, 'my data 100%');
    process.env.BOJIAN_DATA_DIR = dataAbs;
    process.env.BOJIAN_PORT = '8899';
    let r = await api(base, 'POST', '/api/autostart', { enabled: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { supported: true, enabled: true });
    let body = fs.readFileSync(cmdFile, 'utf8');
    const setData = `set "BOJIAN_DATA_DIR=${dataAbs.replace(/%/g, '%%')}"\r\n`;
    assert.ok(body.includes(setData), `.cmd 要有資料夾 set 行（% 要雙寫）：\n${body}`);
    assert.ok(body.includes('set "BOJIAN_PORT=8899"\r\n'), `.cmd 要有埠 set 行：\n${body}`);
    assert.ok(body.indexOf(setData) < body.indexOf('node src\\server.js'), 'set 行要在啟動之前');
    assert.ok(body.includes('start "bojian" /min cmd /c "node src\\server.js"'), '啟動那行照舊');

    // 相對路徑的資料夾：寫成絕對路徑（開機時 cwd 是程式夾，不是當初啟動的地方）
    process.env.BOJIAN_DATA_DIR = 'rel-data';
    delete process.env.BOJIAN_PORT;
    await api(base, 'POST', '/api/autostart', { enabled: true });
    body = fs.readFileSync(cmdFile, 'utf8');
    assert.ok(body.includes(`set "BOJIAN_DATA_DIR=${path.resolve('rel-data')}"\r\n`), `相對路徑要轉絕對：\n${body}`);
    assert.ok(!body.includes('BOJIAN_PORT'), '沒帶埠就不寫埠');
    assert.ok(!body.includes('BOJIAN_CLAUDE_BIN'), '沒帶 claude 路徑就不寫');

    // 桌面版內建的 claude（BOJIAN_CLAUDE_BIN）：跟 DATA_DIR 同一套，有就寫 set 行
    const claudeBin = 'C:\\Users\\王 小明\\AppData\\Roaming\\Claude\\claude-code\\2.1.281\\claude.exe';
    process.env.BOJIAN_CLAUDE_BIN = claudeBin;
    await api(base, 'POST', '/api/autostart', { enabled: true });
    body = fs.readFileSync(cmdFile, 'utf8');
    assert.ok(body.includes(`set "BOJIAN_CLAUDE_BIN=${claudeBin}"\r\n`), `.cmd 要有 claude 路徑 set 行：\n${body}`);
    assert.ok(body.indexOf('BOJIAN_CLAUDE_BIN') < body.indexOf('cd /d'), 'set 行在 cd 之前');
    delete process.env.BOJIAN_CLAUDE_BIN;

    // 不帶 env：跟以前一模一樣，沒有任何 set 行
    delete process.env.BOJIAN_DATA_DIR;
    delete process.env.BOJIAN_PORT;
    r = await api(base, 'POST', '/api/autostart', { enabled: true });
    assert.equal(r.status, 200);
    body = fs.readFileSync(cmdFile, 'utf8');
    assert.ok(!/\bset\b/i.test(body), `不帶 env 不該有 set 行：\n${body}`);
    const { fileURLToPath } = await import('node:url');
    const appRoot = path.join(fileURLToPath(new URL('../src/', import.meta.url)), '..');
    assert.equal(body, `@echo off\r\nchcp 65001>nul\r\ncd /d "${appRoot}"\r\nstart "bojian" /min cmd /c "node src\\server.js"\r\n`, '不帶 env＝只多一行 chcp，其餘與改之前逐字相同');
    // 中文路徑：cmd 用系統碼頁讀批次檔，檔案是 UTF-8 寫的 → 第一行（@echo off 之後）必須先切 65001，且不帶 BOM
    const lines = body.split('\r\n');
    assert.equal(lines[1], 'chcp 65001>nul', '第二行（@echo off 之後第一行）要是 chcp 65001>nul');
    assert.ok(!fs.readFileSync(cmdFile).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), '不帶 BOM');

    // GET 形狀不變；關掉＝刪檔
    assert.deepEqual((await api(base, 'GET', '/api/autostart')).json, { supported: true, enabled: true });
    r = await api(base, 'POST', '/api/autostart', { enabled: false });
    assert.deepEqual(r.json, { supported: true, enabled: false });
    assert.ok(!fs.existsSync(cmdFile));
  } finally {
    restore();
    await app.stop();
  }
});
