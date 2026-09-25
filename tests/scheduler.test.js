import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createRunner } from '../src/runner.js';
import { createScheduler, nextDue, prevDue, fmtLocal, isOccurrence } from '../src/scheduler.js';

const DEF = {
  format: 1,
  name: '例行週會',
  params: [],
  nodes: [{ id: 'a', title: '整理議程', executor: 'ai', stop_point: 'never', instruction: '整理', next: [] }],
};

function setup(nowIso) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-sched-'));
  const store = createStore(dir);
  store.writeWorkflow('工作', 'meet', DEF);
  const clock = { t: new Date(nowIso).getTime() };
  const adapter = { async executeNode() { return 'x'; }, async complete() { return ''; } };
  const runner = createRunner({ store, adapter, now: () => clock.t });
  const kicks = [];
  const scheduler = createScheduler({ store, runner, kick: (...a) => kicks.push(a), now: () => clock.t });
  return { dir, store, runner, scheduler, clock, kicks };
}

// 把某一趟的 run.yaml 弄壞（手動改壞／寫到一半斷電）。先斷言檔案真的在那裡——
// store 沒有對外暴露 run 目錄，路徑是自己組的，組錯就會靜靜地寫到別的地方、測試假通過
function corruptRun(dir, category, id, runId) {
  const f = path.join(dir, 'workflows', category, id, 'runs', runId, 'run.yaml');
  assert.ok(fs.existsSync(f), `run.yaml 不在假設的路徑上：${f}`);
  fs.writeFileSync(f, 'a: [這不是合法 yaml\n  b: "', 'utf8');
  return f;
}

const WEEKLY = { id: 's1', name: '例行週會', workflow_id: '工作/meet', freq: 'weekly', weekday: 1, time: '08:00', enabled: true, auto_makeup: false, remind_leads: [], overrides: {} };

test('D20：nextDue/prevDue 各頻率正確（2026-08-24 是週一）', () => {
  const mon0800 = new Date('2026-08-24T08:00').getTime();
  const before = new Date('2026-08-24T07:00').getTime();
  assert.equal(nextDue(WEEKLY, before), mon0800);
  assert.equal(prevDue(WEEKLY, mon0800 + 1), mon0800);
  assert.equal(prevDue(WEEKLY, mon0800 + 3 * 86400e3), mon0800);
  const daily = { ...WEEKLY, freq: 'daily', time: '09:30' };
  assert.equal(fmtLocal(nextDue(daily, new Date('2026-08-24T10:00').getTime())), '2026-08-25T09:30');
  const monthly = { ...WEEKLY, freq: 'monthly', day: 5, time: '12:00' };
  assert.equal(fmtLocal(nextDue(monthly, new Date('2026-08-24T10:00').getTime())), '2026-09-05T12:00');
  const once = { ...WEEKLY, freq: 'once', at: '2026-08-30T15:00' };
  assert.equal(fmtLocal(nextDue(once, new Date('2026-08-24T10:00').getTime())), '2026-08-30T15:00');
  assert.equal(nextDue(once, new Date('2026-08-31T10:00').getTime()), null);
});

test('D20：到點觸發一次，指紋防重（tick 兩次只有一個 run）；run 標 source/schedule_id', () => {
  const { store, scheduler } = setup('2026-08-24T08:00:30');
  store.writeSchedules([structuredClone(WEEKLY)]);
  scheduler.tickOnce();
  scheduler.tickOnce();
  const runs = store.listRuns('工作', 'meet');
  assert.equal(runs.length, 1);
  const r = store.readRun('工作', 'meet', runs[0]);
  assert.equal(r.source, 'schedule');
  assert.equal(r.schedule_id, 's1');
  assert.ok(store.readNotices().some((n) => n.type === 'trigger' && n.fingerprint === `s1@2026-08-24T08:00`));
});

test('D20：錯過（到點時沒開著）→ 不自動補、發通知含補跑/跳過', () => {
  const { store, scheduler } = setup('2026-08-24T10:00');
  store.writeSchedules([structuredClone(WEEKLY)]);
  scheduler.tickOnce();
  assert.equal(store.listRuns('工作', 'meet').length, 0);
  const miss = store.readNotices().find((n) => n.type === 'missed');
  assert.ok(miss && miss.desc.includes('沒開著'));
  assert.deepEqual(miss.actions, ['makeup', 'skip']);
  scheduler.tickOnce();
  assert.equal(store.readNotices().filter((n) => n.type === 'missed').length, 1, '指紋防重發');
});

test('D20：auto_makeup 開啟 → 錯過直接補跑並標「補」', () => {
  const { store, scheduler } = setup('2026-08-24T10:00');
  store.writeSchedules([{ ...structuredClone(WEEKLY), auto_makeup: true }]);
  scheduler.tickOnce();
  const runs = store.listRuns('工作', 'meet');
  assert.equal(runs.length, 1);
  assert.equal(store.readRun('工作', 'meet', runs[0]).makeup, true);
});

test('D20：疊發偵測——上一輪未完又到點 → 通知不疊發', () => {
  const { store, scheduler, clock } = setup('2026-08-24T08:00:30');
  store.writeSchedules([structuredClone(WEEKLY)]);
  scheduler.tickOnce(); // 第一發（run 停在 running）
  clock.t = new Date('2026-08-31T08:00:30').getTime();
  scheduler.tickOnce();
  assert.equal(store.listRuns('工作', 'meet').length, 1, '不疊發');
  const ov = store.readNotices().find((n) => n.type === 'overlap');
  assert.ok(ov && ov.actions.includes('force-run'));
});

test('D20：單次覆寫——skip 該次不跑；move 到未來不跑、到了才跑', () => {
  const s = structuredClone(WEEKLY);
  s.overrides = { '2026-08-24T08:00': { action: 'skip' } };
  const a = setup('2026-08-24T08:00:30');
  a.store.writeSchedules([s]);
  a.scheduler.tickOnce();
  assert.equal(a.store.listRuns('工作', 'meet').length, 0);
  assert.ok(a.store.readNotices().some((n) => n.type === 'trigger' && n.note === 'skipped'));

  const s2 = structuredClone(WEEKLY);
  s2.overrides = { '2026-08-24T08:00': { move: '2026-08-24T14:00' } };
  const b = setup('2026-08-24T08:00:30');
  b.store.writeSchedules([s2]);
  b.scheduler.tickOnce();
  assert.equal(b.store.listRuns('工作', 'meet').length, 0, '移到未來，還不跑');
  b.clock.t = new Date('2026-08-24T14:00:20').getTime();
  b.scheduler.tickOnce();
  assert.equal(b.store.listRuns('工作', 'meet').length, 1, '移後時刻到了');
});

test('D20：waiting_time 到點喚醒＋kick；未到點不動', async () => {
  const def = structuredClone(DEF);
  def.nodes = [
    { id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做A', next: ['b'] },
    { id: 'b', title: '開會', executor: 'human', stop_point: 'never', instruction: '出席', next: [], wait_until: '2026-08-27T14:00' },
  ];
  const { store, runner, scheduler, clock, kicks } = setup('2026-08-27T13:00');
  store.writeWorkflow('工作', 'meet', def);
  const run = runner.startRun('工作', 'meet', {});
  await runner.runUntilPause('工作', 'meet', run.run_id);
  assert.equal(store.readRun('工作', 'meet', run.run_id).steps.b.status, 'waiting_time');
  scheduler.tickOnce();
  assert.equal(store.readRun('工作', 'meet', run.run_id).steps.b.status, 'waiting_time', '未到點不動');
  clock.t = new Date('2026-08-27T14:00:10').getTime();
  scheduler.tickOnce();
  const r = store.readRun('工作', 'meet', run.run_id);
  assert.equal(r.steps.b.status, 'pending');
  assert.equal(r.status, 'running');
  assert.ok(kicks.length >= 1);
});

test('D20：提醒升級——提前量到點發通知（含卡住描述）、離線補發、去重', async () => {
  const def = structuredClone(DEF);
  def.nodes = [
    { id: 'a', title: '審簡報', executor: 'ai', stop_point: 'always', instruction: '審', next: ['b', 'c'] },
    { id: 'b', title: '開會', executor: 'human', stop_point: 'never', instruction: '出席', next: [], wait_until: '2026-08-27T14:00', remind_leads: ['1h', '30m'] },
    { id: 'c', title: '算業績', executor: 'ai', stop_point: 'never', instruction: '算', next: [] },
  ];
  const { store, runner, scheduler, clock } = setup('2026-08-27T10:00');
  store.writeWorkflow('工作', 'meet', def);
  const run = runner.startRun('工作', 'meet', {});
  await runner.runUntilPause('工作', 'meet', run.run_id); // a 停在 waiting_review、b 尚未就緒
  // 手動把 b 排上等待（模擬 a 核可後 b 進 waiting_time 的狀態）
  const r0 = store.readRun('工作', 'meet', run.run_id);
  r0.steps.b.status = 'waiting_time';
  r0.steps.b.wake_at = new Date('2026-08-27T14:00').toISOString();
  r0.steps.c.status = 'waiting_check'; // 查核攔下也是「卡著等人」，提醒要講得出來
  store.writeRun('工作', 'meet', run.run_id, r0);
  clock.t = new Date('2026-08-27T13:45').getTime(); // 1h 與 30m 兩檔都已逾（離線補發）
  scheduler.tickOnce();
  const rem = store.readNotices().filter((n) => n.type === 'reminder');
  assert.equal(rem.length, 2, '兩檔一次補發');
  assert.ok(rem[0].desc.includes('審簡報'), '卡住的步驟寫進描述');
  assert.ok(rem[0].desc.includes('算業績'), '查核攔下的步驟也要算卡住');
  scheduler.tickOnce();
  assert.equal(store.readNotices().filter((n) => n.type === 'reminder').length, 2, '去重不重發');
});

test('健檢 P1-02：跨週期往後改期——移後時刻準時開跑一次、tick 重跑不重發', () => {
  // 8/31（週一）那次移到 9/15 14:00（中間隔了 9/7、9/14 兩個原定週期）
  const { store, scheduler } = setup('2026-09-15T14:00:30');
  store.writeSchedules([{ ...structuredClone(WEEKLY), overrides: { '2026-08-31T08:00': { move: '2026-09-15T14:00' } } }]);
  scheduler.tickOnce();
  scheduler.tickOnce();
  const runs = store.listRuns('工作', 'meet');
  assert.equal(runs.length, 1, '移動的那次準時開跑、只跑一次');
  const trig = store.readNotices().filter((n) => n.type === 'trigger');
  assert.ok(trig.some((n) => n.fingerprint === 's1@2026-08-31T08:00' && n.note === 'fired'), '指紋仍是原基準鍵');
});

test('健檢 P1-02：往前改期（移到基準之前）——移後時刻就開跑，基準到點不再重跑', () => {
  const { store, scheduler, clock } = setup('2026-08-28T10:00:30');
  store.writeSchedules([{ ...structuredClone(WEEKLY), overrides: { '2026-08-31T08:00': { move: '2026-08-28T10:00' } } }]);
  scheduler.tickOnce();
  assert.equal(store.listRuns('工作', 'meet').length, 1, '移到提前的時刻照跑');
  clock.t = new Date('2026-08-31T08:00:30').getTime();
  scheduler.tickOnce();
  assert.equal(store.listRuns('工作', 'meet').length, 1, '原基準到點因指紋已存在不重跑');
});

test('健檢 P2-02：validateSchedule——非法頻率／時間／星期／提醒值全擋、合法值放行', async () => {
  const { validateSchedule } = await import('../src/scheduler.js');
  const ok = { freq: 'weekly', weekday: 5, time: '09:30', remind_leads: ['1d', { at: '2026-09-01T08:00' }], enabled: true, auto_makeup: false };
  validateSchedule(ok); // 不丟即通過
  validateSchedule({ freq: 'once', at: '2026-09-01T14:00' });
  assert.throws(() => validateSchedule({ freq: 'not-a-frequency' }), /頻率/);
  assert.throws(() => validateSchedule({ freq: 'daily', time: '99:99' }), /時間/);
  assert.throws(() => validateSchedule({ freq: 'weekly', weekday: 9 }), /星期/);
  assert.throws(() => validateSchedule({ freq: 'monthly', day: 42 }), /日期/);
  assert.throws(() => validateSchedule({ freq: 'once', at: '不是時刻' }), /單次/);
  assert.throws(() => validateSchedule({ freq: 'daily', remind_leads: ['bogus'] }), /提前提醒/);
  assert.throws(() => validateSchedule({ freq: 'daily', enabled: 'yes' }), /啟用/);
});

test('複查 H2：isOccurrence——只認排程真實的一次，任意日期與非規範鍵不算', () => {
  assert.equal(isOccurrence(WEEKLY, '2026-08-24T08:00'), true, '週一 08:00 是真的一次');
  assert.equal(isOccurrence(WEEKLY, '2026-08-25T08:00'), false, '週二不是週一排程的一次');
  assert.equal(isOccurrence(WEEKLY, '2026-08-24T09:00'), false, '時間不對也不算');
  assert.equal(isOccurrence(WEEKLY, '2026-8-24T08:00'), false, '非規範化鍵不算（指紋繞不過）');
  const once = { ...WEEKLY, freq: 'once', at: '2026-08-30T15:00' };
  assert.equal(isOccurrence(once, '2026-08-30T15:00'), true);
  assert.equal(isOccurrence(once, '2026-08-30T16:00'), false);
});

test('複查 M4：落盤的非法排程——隔離不跑、發一次修復提示、不猜時間', () => {
  const { store, scheduler } = setup('2026-08-24T08:00:30');
  store.writeSchedules([{ ...structuredClone(WEEKLY), time: '99:99' }]);
  scheduler.tickOnce();
  scheduler.tickOnce();
  assert.equal(store.listRuns('工作', 'meet').length, 0, '不准滾成別的時間繼續跑');
  const inv = store.readNotices().filter((n) => n.type === 'invalid_schedule');
  assert.equal(inv.length, 1, '修復提示一次、指紋去重');
  assert.ok(inv[0].desc.includes('時間'));
});

// ── 2026-09-18  ──────────────────────────────────────────────

test('每月 31 號：短月份夾到當月最後一天，不准整個月靜默不跑', () => {
  const m31 = { ...WEEKLY, freq: 'monthly', day: 31, time: '09:00' };
  // 2026 年 2 月只有 28 天：要在 2/28 觸發，而不是整個二月沒有 occurrence
  assert.equal(fmtLocal(nextDue(m31, new Date('2026-02-01T00:00').getTime())), '2026-02-28T09:00');
  assert.equal(fmtLocal(nextDue(m31, new Date('2026-04-01T00:00').getTime())), '2026-04-30T09:00', '4 月只有 30 天');
  assert.equal(fmtLocal(nextDue(m31, new Date('2026-03-01T00:00').getTime())), '2026-03-31T09:00', '長月份照原本的日子');
  // 夾出來的那一天要算「真實的一次」，否則指紋與覆寫都對不上
  assert.equal(isOccurrence(m31, '2026-02-28T09:00'), true);
  assert.equal(isOccurrence(m31, '2026-02-27T09:00'), false);
  // 30 號的排程在 2 月同樣夾到 28
  const m30 = { ...WEEKLY, freq: 'monthly', day: 30, time: '09:00' };
  assert.equal(fmtLocal(nextDue(m30, new Date('2026-02-01T00:00').getTime())), '2026-02-28T09:00');
});

test('一個壞掉的 run.yaml 不准癱瘓整輪 tick：等時刻步驟照樣醒', () => {
  const { dir, store, scheduler, clock, kicks } = setup('2026-08-24T08:00:30');
  // 先寫壞的那一趟（id 排在前面，掃描時會先碰到它），再寫等時刻、已經到點的那一趟
  store.writeRun('工作', 'meet', 'r-aaa-bad', { run_id: 'r-aaa-bad', status: 'paused', steps: {} });
  corruptRun(dir, '工作', 'meet', 'r-aaa-bad');
  store.writeRun('工作', 'meet', 'r-zzz-good', {
    run_id: 'r-zzz-good', status: 'paused', source: 'manual', workflow: { name: '例行週會' }, def: DEF,
    steps: { a: { status: 'waiting_time', wake_at: new Date(clock.t - 60e3).toISOString() } },
  });

  scheduler.tickOnce();

  const after = store.readRun('工作', 'meet', 'r-zzz-good');
  assert.notEqual(after.steps.a.status, 'waiting_time', '壞檔把整輪 tick 弄死了，到點的步驟沒醒');
  assert.ok(kicks.some(([, , rid]) => rid === 'r-zzz-good'), '醒來後要推進');
});

test('排程開跑也要過健檢：手動會被擋的流程，到點不准靜默跑掉', () => {
  const { store, scheduler } = setup('2026-08-24T08:00:30');
  // 必填的上傳欄位——排程沒辦法替你上傳，健檢 R6 要擋
  store.writeWorkflow('工作', 'meet', {
    ...DEF,
    params: [{ key: 'data', label: '銷售明細', default: '貼上上個月的明細', required: true, input: 'file' }],
    nodes: [{ id: 'a', title: '整理', executor: 'ai', stop_point: 'never', instruction: '整理 {{data}}', next: [] }],
  });
  store.writeSchedules([structuredClone(WEEKLY)]);

  scheduler.tickOnce();

  assert.equal(store.listRuns('工作', 'meet').length, 0, '健檢擋下的流程不准開跑');
  const failed = store.readNotices().filter((n) => n.type === 'start_failed');
  assert.equal(failed.length, 1, '要發通知說明為什麼沒跑，不是靜默跳過');
  assert.ok(failed[0].desc.includes('健檢'), failed[0].desc);
});

test('排程開跑也查服務授權：步驟要用的服務沒授權，到點不准跑、通知講得出原因（連線輪 US-102）', () => {
  const { store, scheduler } = setup('2026-08-24T08:00:30');
  store.writeWorkflow('工作', 'meet', {
    ...DEF,
    nodes: [{ id: 'a', title: '抓來信', executor: 'ai', stop_point: 'never', instruction: '抓這週客戶來信', connectors: ['claude.ai Notion'], next: [] }],
  });
  store.writeConnectors({ checked_at: '2026-08-24T07:00:00Z', servers: [{ name: 'claude.ai Notion', label: 'Notion', status: 'needs-auth', source: 'claudeai', summary: '', read_tools: [], blocked_tools: [] }] });
  store.writeSchedules([structuredClone(WEEKLY)]);

  scheduler.tickOnce();

  assert.equal(store.listRuns('工作', 'meet').length, 0, '服務沒授權不准開跑');
  const failed = store.readNotices().filter((n) => n.type === 'start_failed');
  assert.equal(failed.length, 1);
  assert.ok(failed[0].desc.includes('Notion'), failed[0].desc);
});
