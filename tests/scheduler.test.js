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
  return { store, runner, scheduler, clock, kicks };
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
    { id: 'a', title: '審簡報', executor: 'ai', stop_point: 'always', instruction: '審', next: ['b'] },
    { id: 'b', title: '開會', executor: 'human', stop_point: 'never', instruction: '出席', next: [], wait_until: '2026-08-27T14:00', remind_leads: ['1h', '30m'] },
  ];
  const { store, runner, scheduler, clock } = setup('2026-08-27T10:00');
  store.writeWorkflow('工作', 'meet', def);
  const run = runner.startRun('工作', 'meet', {});
  await runner.runUntilPause('工作', 'meet', run.run_id); // a 停在 waiting_review、b 尚未就緒
  // 手動把 b 排上等待（模擬 a 核可後 b 進 waiting_time 的狀態）
  const r0 = store.readRun('工作', 'meet', run.run_id);
  r0.steps.b.status = 'waiting_time';
  r0.steps.b.wake_at = new Date('2026-08-27T14:00').toISOString();
  store.writeRun('工作', 'meet', run.run_id, r0);
  clock.t = new Date('2026-08-27T13:45').getTime(); // 1h 與 30m 兩檔都已逾（離線補發）
  scheduler.tickOnce();
  const rem = store.readNotices().filter((n) => n.type === 'reminder');
  assert.equal(rem.length, 2, '兩檔一次補發');
  assert.ok(rem[0].desc.includes('審簡報'), '卡住的步驟寫進描述');
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
