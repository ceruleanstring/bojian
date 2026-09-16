import test from 'node:test';
import assert from 'node:assert/strict';

// —— D19 新端點：常用預設庫、參考檔、產出物下載 ——
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { makeCard } from '../src/memory.js';

function fakeAdapter() {
  const calls = [];
  let completeResponses = [];
  let checkResponses = [];
  let editRulesResponses = [];
  let editRulesDelay = 0; // 真 AI 擬規則要 10–60 秒，這裡用毫秒模擬那段空窗
  let routeResponses = []; // 記憶輪 M2：三問路由（kind='memory'）自己一條隊列；缺省 ''＝路由解析失敗＝「這句沒記成」，不擋任何流程
  let available = true;
  const completes = []; // 監工輪 K5：通用補全的 meta（連接器例外要看得到 mcp）
  return {
    calls,
    completes,
    setCompleteResponses(rs) { completeResponses = rs; },
    // 交貨查核輪：查核／擬規則各自一條隊列，跟一般 complete()（分岔、compose…）分開——kind 對不上就照舊
    setCheckResponses(rs) { checkResponses = rs; },
    setEditRulesResponses(rs) { editRulesResponses = rs; },
    setEditRulesDelay(ms) { editRulesDelay = ms; },
    setRouteResponses(rs) { routeResponses = rs; }, // 字串，或 (meta, prompt)=>字串／丟錯
    setAvailable(v) { available = v; },
    async complete({ meta, prompt } = {}) {
      completes.push({ meta, prompt });
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
    async executeNode({ nodeId, instruction, upstream, editRules, meta }) {
      calls.push({ nodeId, instruction, upstream, editRules, meta });
      return `產出:${nodeId}`;
    },
  };
}

async function startApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-server-'));
  const adapter = fakeAdapter();
  const app = createApp({ dataDir, adapter });
  await app.start(0); // 動態埠
  const base = `http://127.0.0.1:${app.port()}`;
  return { app, base, adapter, dataDir };
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
    // 播種：啟動時逐檔補種內建範例（US-011：2–3 個）
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
    const res = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '訂餐廳' }] });
    assert.equal(res.status, 200);
    assert.equal(res.json.draft.name, '訂餐廳');
    assert.ok(res.json.reply.includes('拆好了'));
    adapter.setCompleteResponses(['亂七八糟']);
    const bad = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '拆' }] });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.error.includes('換個說法'));
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
    assert.ok(bad.json.error.includes('不是剝繭流程檔'));
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
    assert.ok(acc.json.error.includes('已經不在'), `要人話：${JSON.stringify(acc.json)}`);
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

// ===== 儀表板輪：/api/dashboard＋卷宗端點 =====

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

// ---- 資料通道輪：健檢端點、開跑擋門、人做交出內容、補資料、儀表板成品回退 ----
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
    assert.equal(pf.json.inputs.classify[0].kind, 'human');
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

// ---- 產檔輪：預覽端點、排版端點、權限預設 ----
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
    assert.deepEqual(saved.permissions, { files: true });
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
    // 監工輪遷移：新建一律補齊子開關「數字對原始資料」（這份沒有必填欄位→關）；enabled 照送來的原樣
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

// ===== 交貨查核輪：三條路由、edit 先擬規則、待辦、用量彙總 =====

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

// 裁定 28：擬規則要 10–60 秒，這段時間 run 不准是 running——否則 UI 每秒的 GET 就會把下游放出去，
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

// ===== 監工輪 K5：工作單留存、連接器例外、監工建議接受 =====

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
    await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '訂餐廳' }] });
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

// ===== 記憶輪 M1b：定義層與存檔接線——詞典自己長、群組圈、記憶卡、設定、備份 =====

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
    assert.equal(dict.fields.length, 8, '口吻是語氣的同義詞，不長；旅行節奏長一條');
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
    assert.equal(badScope.json.error, '用在哪只能是全部、分類、流程');
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
    assert.deepEqual(sum.counts, { profile: 2, habit: 3, groups: 0, dict: 7 });
    assert.ok(sum.exceptions.expired.some((c) => c.id === 'p-old00000-aaaa'), JSON.stringify(sum.exceptions));
    assert.equal(sum.exceptions.expired.some((c) => c.id === p.json.id), false, '還沒到期的不算');
    assert.deepEqual(sum.exceptions.dormant.map((c) => c.id), ['h-dorm0000-aaaa']);
    assert.deepEqual(sum.exceptions.replaced.map((c) => c.id), [h.id]);
    assert.deepEqual(sum.exceptions.changed, []);
    // 清空：全部進垃圾桶
    const cleared = await api(base, 'POST', '/api/memory/clear', {});
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.moved, 5);
    assert.deepEqual((await api(base, 'GET', '/api/memory/summary')).json.counts, { profile: 0, habit: 0, groups: 0, dict: 7 });
    assert.equal((await api(base, 'GET', '/api/memory/trash')).json.length, 5);
  } finally {
    await app.stop();
  }
});

test('M1b：設定——PUT 逐欄人話、部分送只改送的鍵、GET 帶 data_dir 與 version、新流程吃 defaults；備份 POST／GET', async () => {
  const { app, base, dataDir } = await startApp();
  const backupsRoot = path.join(path.dirname(dataDir), `${path.basename(dataDir)}-backups`);
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
    assert.equal(got.version, pkg.version);
    // 新流程吃 defaults：查核關、數字對原始資料固定開、每個 task 節點三個勾照設定；PUT 存檔不吃
    const made = await api(base, 'POST', '/api/workflows', { category: '測試', def: M1B_DEF() });
    const wfP = `/api/workflows/${enc('測試')}/${made.json.id}`;
    const saved = (await api(base, 'GET', wfP)).json;
    assert.deepEqual(saved.check, { enabled: false, facts: true });
    assert.deepEqual(saved.nodes[0].supervisor, { note: true, tier: true, tools: false });
    assert.deepEqual(saved.permissions, { files: true });
    await api(base, 'PUT', wfP, { def: M1B_DEF({ name: '改過' }) });
    const saved2 = (await api(base, 'GET', wfP)).json;
    assert.deepEqual(saved2.check, { enabled: true });
    assert.equal(saved2.nodes[0].supervisor, undefined);
    // 備份
    const bk = await api(base, 'POST', '/api/backup', {});
    assert.equal(bk.status, 200, JSON.stringify(bk.json));
    assert.ok(fs.existsSync(bk.json.path));
    assert.ok(bk.json.at);
    assert.ok(fs.existsSync(path.join(bk.json.path, 'settings.json')), '備份含設定檔');
    const list = (await api(base, 'GET', '/api/backup')).json;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, path.basename(bk.json.path));
  } finally {
    await app.stop();
    fs.rmSync(backupsRoot, { recursive: true, force: true });
  }
});

test('M1b 修正輪：備份失敗只回人話——不透傳原始錯誤碼與本機路徑', async () => {
  const { app, base, dataDir } = await startApp();
  const backupsRoot = path.join(path.dirname(dataDir), `${path.basename(dataDir)}-backups`);
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

test('M5b：新增排程缺 auto_makeup／remind_leads 用設定 exec 缺省、帶了照帶；exec.web 非布林 400 人話；GET /api/settings.version 等於 package.json', async () => {
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
    assert.equal((await api(base, 'GET', '/api/settings')).json.version, pkg.version);
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
    assert.ok(bad.json.error.includes('用在流程時要指定分類和流程'), bad.json.error);
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
    assert.equal((await api(base, 'GET', '/api/memory/dict')).json.fields.length, 7);
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
    assert.deepEqual(store.listMemoryTrash().map((t) => t.key), [newKey]);
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
    const r1 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '訂餐廳' }], category: '旅遊' });
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
    const r4 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '再來' }], category: '旅遊' });
    assert.equal(r4.status, 200);
    const p4 = prompt(3);
    assert.ok(p4.includes('# 分類守則\n- 不提競品') && !p4.includes('語氣：輕鬆'), p4);
    // 分類不存在／沒給分類 →（無）且不寫「已經放在」，照樣拆
    const r5 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '拆' }], category: '沒有的' });
    assert.equal(r5.status, 200);
    const p5 = prompt(4);
    assert.ok(p5.includes('# 分類守則\n（無）') && !p5.includes('已經放在'), p5);
    const r6 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '拆' }] });
    assert.equal(r6.status, 200);
    assert.ok(prompt(5).includes('# 你的分類') && !prompt(5).includes('已經放在'));
  } finally {
    await app.stop();
  }
});

// ---- 記憶輪 M2：四條記路接線（開跑同值／停點／回饋／聊天）、路由卷宗、通知隨回應、通知可撤 ----

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

test('M2 記路③：跑完回饋→路由成習慣卡（出處 feedback、用在這條流程、route_reason）＋memory_notice card＋run 通知＋logs/memory 兩檔；詞典長出新欄位；判 none 不成卡', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    const wfP = seedFlow(dataDir);
    const started = await api(base, 'POST', `${wfP}/runs`, { overrides: { pace: '一天 3 個點' } });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const runPath = `${wfP}/runs/${started.json.run_id}`;
    await pollRun(base, runPath, (r) => r.status === 'done');
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
    assert.equal((await api(base, 'GET', '/api/memory/dict')).json.fields.find((f) => f.name === '住宿')?.kind, 'method', '詞典沒有的欄位先長出來');
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
    assert.deepEqual(routeCall.meta, { kind: 'memory', phase: 'route', category: '旅遊', workflow: 'tokyo', run: started.json.run_id, node: '_memory' });
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

test('M2 記路③：回饋路由成認識卡→200、memory_notice card、卡落 profile/、出處 chat、用在這個分類、route_reason 非空；habit 一張都不長', async () => {
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
    assert.equal(c.source.kind, 'chat', '認識卡的來源只限你打的字，回饋路由出的寫 chat');
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
    const r1 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '我常去日本，幫我排行程' }] });
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
    assert.deepEqual(call.meta, { kind: 'memory', phase: 'route', category: null, workflow: null, run: null, node: '_memory' });
    assert.ok(call.prompt.includes('# 他說的話\n我常去日本，幫我排行程') && call.prompt.includes('這句是聊天，通常記成認識卡'));
    assert.equal(logPair(dataDir, 'memory').asked.length, 1);
    // 已存流程所在分類：scope=category；只路由最後一句使用者話
    await api(base, 'POST', '/api/categories', { name: '旅遊' });
    adapter.setRouteResponses([ROUTE_PROFILE_EXP]);
    const r2 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '第一句' }, { role: 'ai', text: '好' }, { role: 'user', text: '以後不要客套' }], category: '旅遊' });
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
    const r3 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '第 2 步加停點' }] });
    assert.equal(r3.status, 200);
    assert.equal(r3.json.memory_notice, null);
    adapter.setRouteResponses([() => { throw new Error('連不上 Claude（測試注入）'); }]);
    const r4 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '再改' }] });
    assert.equal(r4.status, 200, JSON.stringify(r4.json));
    assert.equal(r4.json.draft.name, '訂餐廳');
    assert.equal(r4.json.memory_notice.kind, 'fail');
    assert.ok(r4.json.memory_notice.text.startsWith('這句沒記成：'));
    assert.equal((await api(base, 'GET', '/api/memory/cards')).json.length, 2);
    // 拆流程本身失敗→不路由（沒有回應可掛通知）
    const before = memoryCalls(adapter).length;
    adapter.setCompleteResponses(['亂七八糟']);
    assert.equal((await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '拆' }] })).status, 400);
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

// ---- 記憶輪 M3b：開跑表單的習慣選項（for-workflow.options）、點了即核可（計數）、範圍靠證據擴大（widen 通知）、身分限縮 ----

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
    assert.equal(widen[0].text, '「一天 8 個點」的範圍從「大阪行程」擴大到旅遊分類：你在第二條流程也選了它。仍是選項，沒有升格');
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

// ---- 記憶輪 M5a：設定頁的資料源——身分預設綁分類（for-workflow 的 core 只含該身分的卡）、身分改了讀回一致、詞典「用在哪些流程」算出來 ----

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

// ---- 移植合併輪 U1a：共用檔 API（/api/shared/:scope/files）、公司名稱設定、分類名禁 _company ----
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
    assert.equal((await api(base, 'GET', sharedPath('_company'))).json.rules.find((f) => f.name === '手冊.md').chars, 2000, '公司那份沒被部門覆蓋');

    // index.yaml 落地形狀（U1a 分身看的那份）
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
    store.writeWorkflow('客服', 'wf2', { ...def, nodes: [node('a', [{ scope: 'category', name: '範本.docx' }])] }); // 別的分類的同名部門檔，不該被動到
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
    assert.equal(bad.json.error, '公司名稱要是文字、60 字內');
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

// ---- 移植合併輪 U1b：拆解器（/api/compose）帶公司／部門規範——composeContext 讀 data/shared 的規範全文 ----

test('U1b ⑦ server：compose 帶分類 → 指示含「# 公司規範」「# 部門規範」全文；沒分類 → 部門（無）；沒有共用夾 → 兩段（無）、照樣拆', async () => {
  const { app, base, adapter, dataDir } = await startApp();
  try {
    const def = { format: 1, name: '訂餐廳', params: [], nodes: [{ id: 'a', title: '找店', executor: 'ai', stop_point: 'always', instruction: '列三家', next: [] }] };
    adapter.setCompleteResponses([`拆好了\n\`\`\`yaml\n${JSON.stringify(def)}\n\`\`\``]);
    const prompt = (i) => readLogFile(dataDir, 'compose', logPair(dataDir, 'compose').asked[i]);
    // 沒有 data/shared/ → 兩段（無）
    const r0 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '拆' }] });
    assert.equal(r0.status, 200, JSON.stringify(r0.json));
    assert.ok(prompt(0).includes('# 公司規範（跟分類守則一樣當已知條件）\n（無）') && prompt(0).includes('# 部門規範（同上）\n（無）'), prompt(0));
    await api(base, 'POST', '/api/categories', { name: '旅遊' });
    assert.equal((await api(base, 'POST', sharedPath('_company'), { name: '手冊.md', kind: 'rule', content_b64: b64('語氣要親切。') })).status, 200);
    assert.equal((await api(base, 'POST', sharedPath('旅遊'), { name: '部門.md', kind: 'rule', content_b64: b64('報價含稅。') })).status, 200);
    assert.equal((await api(base, 'POST', sharedPath('旅遊'), { name: '範本.docx', kind: 'ref', content_b64: b64('x') })).status, 200, '參考類不進規範段');
    const r1 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '訂餐廳' }], category: '旅遊' });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    const p1 = prompt(1);
    assert.ok(p1.includes('# 公司規範（跟分類守則一樣當已知條件）\n## 手冊.md\n語氣要親切。'), p1);
    assert.ok(p1.includes('# 部門規範（同上）\n## 部門.md\n報價含稅。'), p1);
    assert.ok(!p1.includes('範本.docx'), '參考類不帶');
    assert.ok(p1.indexOf('# 部門規範') < p1.indexOf('# 分類守則'), '外圈在前');
    const r2 = await api(base, 'POST', '/api/compose', { messages: [{ role: 'user', text: '拆' }] });
    assert.equal(r2.status, 200);
    assert.ok(prompt(2).includes('## 手冊.md') && prompt(2).includes('# 部門規範（同上）\n（無）'), prompt(2));
  } finally {
    await app.stop();
  }
});

// ===== 移植合併輪 U4a：GET /runs?detail=1 歷次執行摘要（finals 與儀表板共用） =====

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
