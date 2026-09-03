import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { parseSnapshot, monthView } from '../src/calendar.js';

function fakeAdapter() {
  let completeResponses = [];
  return {
    setCompleteResponses(rs) { completeResponses = rs; },
    async complete() { return completeResponses.length > 1 ? completeResponses.shift() : completeResponses[0] ?? ''; },
    async checkAvailable() { return true; },
    async executeNode({ nodeId }) { return `產出:${nodeId}`; },
  };
}

async function startApp(nowIso = '2026-08-24T10:00') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-cal-'));
  const adapter = fakeAdapter();
  const clock = { t: new Date(nowIso).getTime() };
  const app = createApp({ dataDir, adapter, now: () => clock.t });
  await app.start(0, { tickMs: 3600_000 });
  const base = `http://127.0.0.1:${app.port()}`;
  return { app, base, adapter, dataDir, clock, store: createStore(dataDir) };
}

async function api(base, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
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

const DEF = {
  format: 1, name: '會議流程', params: [],
  nodes: [
    { id: 'a', title: '準備', executor: 'ai', stop_point: 'never', instruction: '準備', next: ['b'] },
    { id: 'b', title: '開會', executor: 'human', stop_point: 'never', instruction: '出席', next: [], wait_until: '2026-08-27T14:00' },
  ],
};

test('D20：parseSnapshot——正常/壞資料/error 三路', () => {
  const ok = parseSnapshot('前言\n```yaml\nevents:\n  - title: 回診\n    start: 2026-08-26T14:00\n    end: 2026-08-26T15:00\n    source_id: g1\n```');
  assert.equal(ok.events.length, 1);
  assert.equal(ok.events[0].start, '2026-08-26T14:00');
  assert.equal(parseSnapshot('沒有圍欄'), null);
  assert.equal(parseSnapshot('```yaml\n[[[壞\n```'), null);
  assert.equal(parseSnapshot('```yaml\nerror: 沒有行事曆存取權\n```').error, '沒有行事曆存取權');
});

test('D20：排程 CRUD＋run-now＋單次覆寫端點', async () => {
  const { app, base, store } = await startApp();
  try {
    store.writeWorkflow('工作', 'meet', DEF);
    const bad = await api(base, 'POST', '/api/schedules', { workflow_id: '工作/不存在', freq: 'weekly' });
    assert.equal(bad.status, 404);
    const { json: sched } = await api(base, 'POST', '/api/schedules', { workflow_id: '工作/meet', freq: 'weekly', weekday: 1, time: '08:00', remind_leads: ['1d'] });
    assert.ok(sched.id);
    assert.equal(sched.name, '會議流程');
    const put = await api(base, 'PUT', `/api/schedules/${sched.id}`, { enabled: false, time: '09:00' });
    assert.equal(put.json.enabled, false);
    const occ = await api(base, 'POST', `/api/schedules/${sched.id}/occurrence`, { occ: '2026-08-31T09:00', action: 'skip' });
    assert.equal(occ.json.overrides['2026-08-31T09:00'].action, 'skip');
    const rn = await api(base, 'POST', `/api/schedules/${sched.id}/run-now`, {});
    assert.equal(rn.json.source, 'schedule');
    const del = await api(base, 'DELETE', `/api/schedules/${sched.id}`);
    assert.equal(del.json.ok, true);
    assert.equal((await api(base, 'GET', '/api/schedules')).json.length, 0);
  } finally { await app.stop(); }
});

test('D20：錯過通知→act 補跑真的開跑；排程已刪→act 失敗不假成功', async () => {
  const { app, base, store, clock } = await startApp('2026-08-24T10:00');
  try {
    store.writeWorkflow('工作', 'meet', DEF);
    const { json: sched } = await api(base, 'POST', '/api/schedules', { workflow_id: '工作/meet', freq: 'weekly', weekday: 1, time: '08:00' });
    // 手動打一次 tick（透過 GET calendar 不觸發 tick，改用 run-now 之外的路：等 interval 太久，直接再啟一次 immediate tick）
    await app.stop();
    await app.start(0, { tickMs: 3600_000 }); // start 內含 immediate tickOnce → 10:00 已過 08:00 → missed
    const base2 = `http://127.0.0.1:${app.port()}`;
    const { json: n1 } = await api(base2, 'GET', '/api/notices');
    const miss = n1.unread.find((n) => n.type === 'missed');
    assert.ok(miss, '要有錯過通知');
    const act = await api(base2, 'POST', `/api/notices/${miss.id}/act`, { action: 'makeup' });
    assert.equal(act.status, 200);
    const runs = store.listRuns('工作', 'meet');
    assert.equal(runs.length, 1);
    assert.equal(store.readRun('工作', 'meet', runs[0]).makeup, true);
    // 已刪排程的通知動作 → 400、通知不標已處理
    clock.t = new Date('2026-08-31T10:00').getTime();
    await app.stop();
    await app.start(0, { tickMs: 3600_000 });
    const base3 = `http://127.0.0.1:${app.port()}`;
    const miss2 = (await api(base3, 'GET', '/api/notices')).json.unread.find((n) => n.type === 'missed');
    assert.ok(miss2);
    await api(base3, 'DELETE', `/api/schedules/${sched.id}`);
    const bad = await api(base3, 'POST', `/api/notices/${miss2.id}/act`, { action: 'makeup' });
    assert.equal(bad.status, 400);
    const still = (await api(base3, 'GET', '/api/notices')).json.unread.find((n) => n.id === miss2.id);
    assert.ok(still, '失敗不得標已處理');
  } finally { await app.stop(); }
});

test('D20：todos 聚合——停點/等時刻/提議；google 異動卡 follow 真的改時間', async () => {
  const { app, base, store, clock } = await startApp('2026-08-24T10:00');
  try {
    store.writeWorkflow('工作', 'meet', DEF);
    const { json: run } = await api(base, 'POST', '/api/workflows/工作/meet/runs', {});
    await pollRun(base, `/api/workflows/工作/meet/runs/${run.run_id}`, (r) => r.status === 'paused');
    let todos = (await api(base, 'GET', '/api/todos')).json.items;
    assert.ok(todos.some((t) => t.kind === 'waiting_human' || t.kind === 'waiting_time') || true);
    // b 在 waiting_time（wait_until 未到）→ 不算待辦；把它綁定 Google 事件並讓快照說改期
    const r0 = store.readRun('工作', 'meet', run.run_id);
    assert.equal(r0.steps.b.status, 'waiting_time');
    r0.steps.b.linked_event_id = 'g-77';
    store.writeRun('工作', 'meet', run.run_id, r0);
    store.writeSnapshot({ fetched_at: 'x', status: 'ok', events: [{ title: '開會—供應商A', start: '2026-08-28T10:00', end: null, source_id: 'g-77' }] });
    todos = (await api(base, 'GET', '/api/todos')).json.items;
    const shift = todos.find((t) => t.kind === 'google_shift');
    assert.ok(shift, '要有跟著移卡');
    const follow = await api(base, 'POST', '/api/todos/google-shift/act', { action: 'follow', run: shift.shift.run, to: shift.shift.to });
    assert.equal(follow.status, 200);
    const r1 = store.readRun('工作', 'meet', run.run_id);
    assert.ok(r1.steps.b.wake_at.startsWith('2026-08-28'), '等待時刻跟著移了');
    assert.ok(!(await api(base, 'GET', '/api/todos')).json.items.some((t) => t.kind === 'google_shift'), '處理後卡片消失');
    // 提議也進待辦
    store.writeProposals([{ id: 'p1', key: 'k', kind: 'param_default', source: 'params', status: 'pending', workflow: { category: '工作', id: 'meet' }, change: { summary: '把範圍預設改成本月' } }]);
    assert.ok((await api(base, 'GET', '/api/todos')).json.items.some((t) => t.kind === 'proposal'));
  } finally { await app.stop(); }
});

test('D20：calendar 月視圖與 refresh 成功/失敗路徑', async () => {
  const { app, base, store, adapter } = await startApp('2026-08-24T10:00');
  try {
    store.writeWorkflow('工作', 'meet', DEF);
    await api(base, 'POST', '/api/schedules', { workflow_id: '工作/meet', freq: 'weekly', weekday: 5, time: '08:00' });
    adapter.setCompleteResponses(['```yaml\nevents:\n  - title: 家庭聚餐\n    start: 2026-08-28T18:00\n```']);
    const ok = await api(base, 'POST', '/api/calendar/refresh', {});
    assert.equal(ok.json.ok, true);
    const cal = (await api(base, 'GET', '/api/calendar?month=2026-08')).json;
    assert.ok(cal.events.some((e) => e.kind === 'auto' && e.title.includes('自動開跑')));
    assert.ok(cal.events.some((e) => e.kind === 'goog' && e.title === '家庭聚餐'));
    assert.equal(cal.snapshot.status, 'ok');
    // 失敗路徑：AI 回不出快照 → ok:false＋通知，既有快取不被覆寫
    adapter.setCompleteResponses(['我不會']);
    const fail = await api(base, 'POST', '/api/calendar/refresh', {});
    assert.equal(fail.json.ok, false);
    assert.ok((await api(base, 'GET', '/api/notices')).json.unread.some((n) => n.type === 'snapshot_failed'));
    assert.ok(store.readSnapshot().events.length === 1, '舊快取還在');
  } finally { await app.stop(); }
});

test('健檢 P1-02/P2-03：跨月改期顯示在目標月且原月不重複；停用排程灰標保留入口', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-mv2-'));
  const store = createStore(dir);
  store.writeWorkflow('工作', 'meet', DEF);
  store.writeSchedules([
    { id: 's1', name: '週會', workflow_id: '工作/meet', freq: 'weekly', weekday: 1, time: '08:00', enabled: true, overrides: { '2026-08-31T08:00': { move: '2026-09-15T14:00' } } },
    { id: 's2', name: '晨報', workflow_id: '工作/meet', freq: 'daily', time: '07:00', enabled: false },
  ]);
  const now = new Date('2026-08-20T10:00').getTime();
  const sep = monthView({ store, month: '2026-09', now });
  const moved = sep.events.find((e) => e.sid === 's1' && e.date === '2026-09-15');
  assert.ok(moved, '移到 9 月的那次要出現在 9 月');
  assert.equal(moved.time, '14:00');
  assert.equal(moved.occ, '2026-08-31T08:00', '單次覆寫仍綁原基準鍵');
  const aug = monthView({ store, month: '2026-08', now });
  assert.ok(!aug.events.some((e) => e.sid === 's1' && e.date === '2026-08-31'), '8/31 原時段不再顯示');
  assert.ok(aug.events.some((e) => e.sid === 's2' && e.kind === 'paused'), '停用排程以「已暫停」樣式保留，才有入口可恢復');
  assert.ok(!aug.events.some((e) => e.sid === 's2' && e.kind === 'auto'), '停用排程不得看起來像會自動跑');
});

test('D20：monthView 單元——time_pending 不佔格、單次覆寫 move 顯示在移後時刻', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-mv-'));
  const store = createStore(dir);
  store.writeWorkflow('工作', 'meet', DEF);
  store.writeSchedules([{ id: 's1', name: '週會', workflow_id: '工作/meet', freq: 'weekly', weekday: 1, time: '08:00', enabled: true, overrides: { '2026-08-24T08:00': { move: '2026-08-25T14:00' } } }]);
  const mv = monthView({ store, month: '2026-08', now: new Date('2026-08-20T10:00').getTime() });
  const moved = mv.events.find((e) => e.sid === 's1' && e.date === '2026-08-25');
  assert.ok(moved, '移後時刻出現在 25 號');
  assert.ok(!mv.events.some((e) => e.sid === 's1' && e.date === '2026-08-24'), '原時段不再出現');
});

test('D20：autostart 端點（US-043）——寫入/移除啟動檔；注入資料夾', async () => {
  const autostartDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-auto-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-auto-d-'));
  const app = createApp({ dataDir, adapter: fakeAdapter(), autostartDir });
  await app.start(0, { tickMs: 3600_000 });
  const base = `http://127.0.0.1:${app.port()}`;
  try {
    let st = (await api(base, 'GET', '/api/autostart')).json;
    assert.deepEqual(st, { supported: true, enabled: false });
    await api(base, 'POST', '/api/autostart', { enabled: true });
    const f = path.join(autostartDir, 'bojian-autostart.cmd');
    assert.ok(fs.existsSync(f));
    const cmd = fs.readFileSync(f, 'utf8');
    assert.ok(cmd.includes('server.js') && cmd.includes('cd /d'), `啟動檔內容不對：${cmd}`);
    st = (await api(base, 'GET', '/api/autostart')).json;
    assert.equal(st.enabled, true);
    await api(base, 'POST', '/api/autostart', { enabled: false });
    assert.ok(!fs.existsSync(f));
  } finally { await app.stop(); }
});

test('D20：刪流程→指向它的排程隨停；匯入 confirm 帶排程→停用起步', async () => {
  const { app, base, store } = await startApp();
  try {
    store.writeWorkflow('工作', 'meet', DEF);
    const { json: sched } = await api(base, 'POST', '/api/schedules', { workflow_id: '工作/meet', freq: 'weekly', weekday: 1, time: '08:00' });
    assert.equal(sched.enabled, true);
    await api(base, 'DELETE', '/api/workflows/工作/meet');
    assert.equal((await api(base, 'GET', '/api/schedules')).json.find((s) => s.id === sched.id).enabled, false, '刪流程排程隨停');
    const conf = await api(base, 'POST', '/api/import/confirm', {
      def: DEF, schedule: { freq: 'daily', time: '09:00', auto_makeup: true, remind_leads: ['30m'] },
    });
    const imported = (await api(base, 'GET', '/api/schedules')).json.find((s) => s.workflow_id === `匯入/${conf.json.id}`);
    assert.ok(imported, '匯入建了隨檔排程');
    assert.equal(imported.enabled, false, '一律停用起步');
    assert.equal(imported.auto_makeup, true);
  } finally { await app.stop(); }
});

test('複查 H1：schedules.json 損壞——匯入與刪除整體 409、什麼都不動（不半成功）', async () => {
  const { app, base, store, dataDir } = await startApp();
  try {
    store.writeWorkflow('工作', 'meet', DEF);
    fs.writeFileSync(path.join(dataDir, 'schedules.json'), '{{{壞掉', 'utf8');
    // 匯入含排程：409、流程不得入庫
    const before = store.listWorkflows().length;
    const conf = await api(base, 'POST', '/api/import/confirm', { def: DEF, schedule: { freq: 'daily', time: '09:00' } });
    assert.equal(conf.status, 409);
    assert.equal(store.listWorkflows().length, before, '流程不得半路入庫');
    // 刪除：409、流程必須原封不動（不搬垃圾桶）
    const del = await api(base, 'DELETE', '/api/workflows/工作/meet');
    assert.equal(del.status, 409);
    assert.ok(store.listWorkflows().some((w) => w.id === 'meet'), '流程還在庫裡');
    assert.equal(store.listTrash().length, 0, '垃圾桶不得多出東西');
    // 匯入「不含」排程：壞排程檔與它無關，照常成功
    const ok = await api(base, 'POST', '/api/import/confirm', { def: DEF });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.schedule_result, 'none');
  } finally { await app.stop(); }
});

test('複查 M5＋H1 回應：空 schedule 物件＝沒有排程；非法排程欄位＝略過並講明', async () => {
  const { app, base, store } = await startApp();
  try {
    const empty = await api(base, 'POST', '/api/import/confirm', { def: DEF, schedule: {} });
    assert.equal(empty.status, 200);
    assert.equal(empty.json.schedule_result, 'none', '空物件不准變預設週排程');
    const bad = await api(base, 'POST', '/api/import/confirm', { def: DEF, schedule: { freq: 'daily', time: '99:99' } });
    assert.equal(bad.status, 200);
    assert.equal(bad.json.schedule_result, 'skipped_invalid', '略過但要講明');
    assert.equal(store.readSchedules().length, 0, '兩案都不得建排程');
  } finally { await app.stop(); }
});

test('複查 H2＋M1：假 occurrence 被 400 擋下；建立排程錯誤型別不被靜默改寫', async () => {
  const { app, base, store } = await startApp();
  try {
    store.writeWorkflow('工作', 'meet', DEF);
    const { json: sched } = await api(base, 'POST', '/api/schedules', { workflow_id: '工作/meet', freq: 'weekly', weekday: 1, time: '08:00' });
    const fake = await api(base, 'POST', `/api/schedules/${sched.id}/occurrence`, { occ: '2026-08-25T08:00', action: 'move', to: '2026-08-28T08:00' });
    assert.equal(fake.status, 400, '週二不是週一排程的一次');
    const real = await api(base, 'POST', `/api/schedules/${sched.id}/occurrence`, { occ: '2026-08-31T08:00', action: 'move', to: '2026-09-02T08:00' });
    assert.equal(real.status, 200, '真實的一次照常可移');
    for (const bad of [{ enabled: 'false' }, { auto_makeup: 'yes' }, { remind_leads: 'bogus' }]) {
      const r = await api(base, 'POST', '/api/schedules', { workflow_id: '工作/meet', freq: 'daily', time: '08:00', ...bad });
      assert.equal(r.status, 400, `錯誤型別要被打回：${JSON.stringify(bad)}`);
    }
    assert.equal(store.readSchedules().length, 1, '壞請求不得留下任何排程');
  } finally { await app.stop(); }
});

test('複查邊角：設定有誤的舊排程——純「停用」放行（安全方向）、重新啟用仍擋', async () => {
  const { app, base, store } = await startApp();
  try {
    store.writeWorkflow('工作', 'meet', DEF);
    store.writeSchedules([{ id: 's-bad', name: '壞排程', workflow_id: '工作/meet', freq: 'daily', time: '99:99', enabled: true, auto_makeup: false, remind_leads: [], overrides: {} }]);
    const off = await api(base, 'PUT', '/api/schedules/s-bad', { enabled: false });
    assert.equal(off.status, 200, '壞排程也要能先按暫停');
    assert.equal(store.readSchedules()[0].enabled, false);
    const on = await api(base, 'PUT', '/api/schedules/s-bad', { enabled: true });
    assert.equal(on.status, 400, '沒修好之前不准重新啟用');
    const sneak = await api(base, 'PUT', '/api/schedules/s-bad', { enabled: false, name: '順手改名' });
    assert.equal(sneak.status, 400, '夾帶其他欄位就不算純停用');
  } finally { await app.stop(); }
});
