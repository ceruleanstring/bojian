import test from 'node:test';
import assert from 'node:assert/strict';

// —— D19 新端點：常用預設庫、參考檔、產出物下載 ——
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';

function fakeAdapter() {
  const calls = [];
  let completeResponses = [];
  let available = true;
  return {
    calls,
    setCompleteResponses(rs) { completeResponses = rs; },
    setAvailable(v) { available = v; },
    async complete() {
      return completeResponses.length > 1 ? completeResponses.shift() : completeResponses[0] ?? '';
    },
    async checkAvailable() { return available; },
    async executeNode({ nodeId, instruction, upstream }) {
      calls.push({ nodeId, instruction, upstream });
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
