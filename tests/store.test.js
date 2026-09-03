import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, StoreError } from '../src/store.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-store-'));
  return { store: createStore(dir), dir };
}

const DEF = {
  format: 1,
  name: '測試流程',
  params: [],
  nodes: [{ id: 'a', title: '步驟A', executor: 'ai', stop_point: 'never', instruction: '做A', next: [] }],
};

test('workflow 寫入後讀回一致，且不殘留暫存檔', () => {
  const { store, dir } = tmpStore();
  store.writeWorkflow('範例', 'wf1', DEF);
  const back = store.readWorkflow('範例', 'wf1');
  assert.deepEqual(back, DEF);
  const files = fs.readdirSync(path.join(dir, 'workflows', '範例', 'wf1'));
  assert.ok(!files.some((f) => f.includes('.tmp')), `不應殘留暫存檔：${files}`);
});

test('listWorkflows 列出分類與名稱', () => {
  const { store } = tmpStore();
  assert.deepEqual(store.listWorkflows(), []);
  store.writeWorkflow('範例', 'wf1', DEF);
  const list = store.listWorkflows();
  assert.equal(list.length, 1);
  assert.equal(list[0].category, '範例');
  assert.equal(list[0].id, 'wf1');
  assert.equal(list[0].name, '測試流程');
});

test('損壞的 workflow.yaml → StoreError CORRUPT，訊息是人話', () => {
  const { store, dir } = tmpStore();
  store.writeWorkflow('範例', 'wf1', DEF);
  fs.writeFileSync(path.join(dir, 'workflows', '範例', 'wf1', 'workflow.yaml'), 'a: [沒關括號', 'utf8');
  assert.throws(
    () => store.readWorkflow('範例', 'wf1'),
    (e) => e instanceof StoreError && e.code === 'CORRUPT' && e.message.includes('讀不懂'),
  );
});

test('首次寫入建立 history/v1 快照；restoreLatest 能救回改壞的檔', () => {
  const { store, dir } = tmpStore();
  store.writeWorkflow('範例', 'wf1', DEF);
  const v1 = path.join(dir, 'workflows', '範例', 'wf1', 'history', 'v1.yaml');
  assert.ok(fs.existsSync(v1), 'history/v1.yaml 應存在');
  fs.writeFileSync(path.join(dir, 'workflows', '範例', 'wf1', 'workflow.yaml'), '{{{壞掉', 'utf8');
  store.restoreLatest('範例', 'wf1');
  assert.deepEqual(store.readWorkflow('範例', 'wf1'), DEF);
});

test('run 紀錄寫入讀回一致，listRuns 依開跑先後', () => {
  const { store } = tmpStore();
  store.writeWorkflow('範例', 'wf1', DEF);
  const id1 = store.newRunId();
  const run = { run_id: id1, status: 'running', overrides: {}, steps: {} };
  store.writeRun('範例', 'wf1', id1, run);
  assert.deepEqual(store.readRun('範例', 'wf1', id1), run);
  assert.deepEqual(store.listRuns('範例', 'wf1'), [id1]);
});

test('新增分類：空分類列得出來；含路徑字元的名稱擋下', () => {
  const { store } = tmpStore();
  store.writeWorkflow('工作回報', 'wf1', DEF);
  store.createCategory('行銷');
  assert.deepEqual(store.listCategories().sort(), ['工作回報', '行銷']);
  assert.throws(() => store.createCategory('壞/名'), (e) => e instanceof StoreError && e.code === 'BAD_NAME');
  assert.throws(() => store.createCategory('..'), StoreError);
});

test('搬移流程：履歷與 run 紀錄一起搬、原位清空', () => {
  const { store } = tmpStore();
  store.writeWorkflow('工作回報', 'wf1', DEF);
  const rid = store.newRunId();
  store.writeRun('工作回報', 'wf1', rid, { run_id: rid, status: 'done' });
  store.createCategory('行銷');
  store.moveWorkflow('工作回報', 'wf1', '行銷');
  assert.deepEqual(store.readWorkflow('行銷', 'wf1'), DEF);
  assert.deepEqual(store.listRuns('行銷', 'wf1'), [rid]);
  assert.throws(() => store.readWorkflow('工作回報', 'wf1'), (e) => e.code === 'NOT_FOUND');
});

test('版本機制：bump 記一版、rollback 以舊版為現行並再記一版（歷史完整）', () => {
  const { store } = tmpStore();
  store.writeWorkflow('範例', 'wf1', DEF);
  const v2def = structuredClone(DEF);
  v2def.nodes[0].instruction = '做A（表格千分位）';
  store.bumpVersion('範例', 'wf1', v2def, '表格改千分位', 'edits');
  assert.deepEqual(store.readWorkflow('範例', 'wf1'), v2def, '現行版=新版');
  let versions = store.listVersions('範例', 'wf1');
  assert.deepEqual(versions.map((v) => [v.version, v.source]), [[1, 'create'], [2, 'edits']]);
  assert.equal(versions[1].diff_note, '表格改千分位');
  assert.deepEqual(store.readVersion('範例', 'wf1', 1).def, DEF);
  // 退回 v1
  store.rollback('範例', 'wf1', 1);
  assert.deepEqual(store.readWorkflow('範例', 'wf1'), DEF, '退回後現行=v1 內容');
  versions = store.listVersions('範例', 'wf1');
  assert.equal(versions.length, 3, '退回也記一版，歷史不刪');
  assert.equal(versions[2].source, 'rollback');
});

test('手動編輯進履歷：首改記新版；十分鐘內連續改動合併同版；隔久了再記新版', () => {
  const { store } = tmpStore();
  store.writeWorkflow('範例', 'wf1', DEF);
  const e1 = structuredClone(DEF);
  e1.nodes[0].title = '步驟A改';
  store.saveManualEdit('範例', 'wf1', e1);
  let versions = store.listVersions('範例', 'wf1');
  assert.deepEqual(versions.map((v) => v.source), ['create', 'manual'], '手動編輯要記版');
  const e2 = structuredClone(e1);
  e2.nodes[0].title = '步驟A再改';
  store.saveManualEdit('範例', 'wf1', e2);
  versions = store.listVersions('範例', 'wf1');
  assert.equal(versions.length, 2, '連續編輯合併同一版，不灌版本');
  assert.deepEqual(store.readVersion('範例', 'wf1', 2).def, e2, '合併版內容=最新');
  // 把 v2 的時間改老 → 再編輯要開新版
  const v2path = path.join(store.dataDir, 'workflows', '範例', 'wf1', 'history', 'v2.yaml');
  const old = fs.readFileSync(v2path, 'utf8').replace(/at: .*/, 'at: 2026-08-01T00:00:00.000Z');
  fs.writeFileSync(v2path, old, 'utf8');
  const e3 = structuredClone(e2);
  e3.nodes[0].title = '步驟A三改';
  store.saveManualEdit('範例', 'wf1', e3);
  assert.equal(store.listVersions('範例', 'wf1').length, 3, '隔久了要開新版');
});

test('提議佇列：讀寫 roundtrip、無檔回空', () => {
  const { store } = tmpStore();
  assert.deepEqual(store.readProposals(), []);
  const ps = [{ id: 'p1', status: 'pending', kind: 'param_default', evidence: '連兩次改 5 分鐘' }];
  store.writeProposals(ps);
  assert.deepEqual(store.readProposals(), ps);
});

test('垃圾桶：刪→列→復原（含 runs）；撞名加尾綴；過期清除', () => {
  const { store } = tmpStore();
  store.writeWorkflow('工作', 'wf1', DEF);
  const rid = store.newRunId();
  store.writeRun('工作', 'wf1', rid, { run_id: rid, status: 'done' });
  const key = store.trashWorkflow('工作', 'wf1');
  assert.deepEqual(store.listWorkflows(), []);
  const trash = store.listTrash();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].name, '測試流程');
  // 撞名：原位置又建了一個同 id
  store.writeWorkflow('工作', 'wf1', { ...DEF, name: '新的同名' });
  const restored = store.restoreTrash(key);
  assert.notEqual(restored.id, 'wf1', '撞名要換 id 不覆蓋');
  assert.deepEqual(store.readWorkflow('工作', restored.id), DEF);
  assert.deepEqual(store.listRuns('工作', restored.id), [rid], 'runs 一起回來');
  assert.deepEqual(store.listTrash(), []);
  // 過期清除
  const key2 = store.trashWorkflow('工作', 'wf1');
  const metaPath = path.join(store.dataDir, 'trash', key2, 'meta.yaml');
  fs.writeFileSync(metaPath, `category: 工作\nid: wf1\nname: 新的同名\ntrashed_at: 2026-07-01T00:00:00.000Z\n`, 'utf8');
  store.purgeTrash(30);
  assert.deepEqual(store.listTrash(), [], '超過 30 天的清掉');
});

test('讀不存在的流程 → StoreError NOT_FOUND', () => {
  const { store } = tmpStore();
  assert.throws(
    () => store.readWorkflow('範例', '不存在'),
    (e) => e instanceof StoreError && e.code === 'NOT_FOUND',
  );
});

test('D20：schedules/notices/snapshot 讀不到＝空狀態，寫後讀回一致', () => {
  const { store, dir } = tmpStore();
  assert.deepEqual(store.readSchedules(), []);
  assert.deepEqual(store.readNotices(), []);
  assert.equal(store.readSnapshot(), null);
  const scheds = [{ id: 's1', workflow_id: '範例/wf1', freq: 'weekly', weekday: 1, time: '08:00', enabled: true, auto_makeup: false, remind_leads: ['1d', '30m'], overrides: {} }];
  store.writeSchedules(scheds);
  assert.deepEqual(store.readSchedules(), scheds);
  const notices = [{ id: 'n1', type: 'missed', fingerprint: 's1@2026-08-24T08:00', status: 'unread' }];
  store.writeNotices(notices);
  assert.deepEqual(store.readNotices(), notices);
  store.writeSnapshot({ fetched_at: 'x', events: [] });
  assert.equal(store.readSnapshot().fetched_at, 'x');
  const files = fs.readdirSync(dir);
  assert.ok(!files.some((f) => f.includes('.tmp')), `不應殘留暫存檔：${files}`);
});

test('健檢 P1-01：頂層 JSON 損壞 → 明確報錯不當空資料；刪檔仍回空；快照壞了視為沒有', () => {
  const { store, dir } = tmpStore();
  store.writeSchedules([{ id: 's1' }]);
  fs.writeFileSync(path.join(dir, 'schedules.json'), '{壞掉的JSON', 'utf8');
  assert.throws(() => store.readSchedules(), (e) => e instanceof StoreError && e.code === 'CORRUPT' && e.message.includes('schedules.json'));
  assert.equal(fs.readFileSync(path.join(dir, 'schedules.json'), 'utf8'), '{壞掉的JSON', '壞檔原文必須原封不動');
  fs.rmSync(path.join(dir, 'schedules.json'));
  assert.deepEqual(store.readSchedules(), [], 'ADR-005：刪檔＝回無排程狀態');
  fs.writeFileSync(path.join(dir, 'notices.json'), '[[', 'utf8');
  assert.throws(() => store.readNotices(), (e) => e.code === 'CORRUPT');
  fs.writeFileSync(path.join(dir, 'presets.json'), '{{', 'utf8');
  assert.throws(() => store.listPresets(), (e) => e.code === 'CORRUPT');
  fs.writeFileSync(path.join(dir, 'calendar-snapshot.json'), '{壞', 'utf8');
  assert.equal(store.readSnapshot(), null, '快照是可重抓的快取，壞了視為沒有');
});

test('健檢 P2-01：分類／流程／run id／垃圾桶鍵含路徑符號 → BAD_NAME，不落地', () => {
  const { store, dir } = tmpStore();
  assert.throws(() => store.writeWorkflow('../orphan', 'x', DEF), (e) => e instanceof StoreError && e.code === 'BAD_NAME');
  assert.throws(() => store.readWorkflow('範例', '..'), (e) => e.code === 'BAD_NAME');
  store.writeWorkflow('範例', 'wf1', DEF);
  assert.throws(() => store.moveWorkflow('範例', 'wf1', '../外面'), (e) => e.code === 'BAD_NAME');
  assert.throws(() => store.readRun('範例', 'wf1', '../../wf1'), (e) => e.code === 'BAD_NAME');
  assert.throws(() => store.restoreTrash('../別人的'), (e) => e.code === 'BAD_NAME');
  assert.ok(!fs.existsSync(path.join(dir, 'orphan')), '不得在資料根外建目錄');
  store.readWorkflow('範例', 'wf1'); // 合法中文分類照常
});

test('複查 L1：schedules.json 存在但讀不到（是資料夾）→ 明確報錯，不偽裝成沒排程', () => {
  const { store, dir } = tmpStore();
  fs.mkdirSync(path.join(dir, 'schedules.json'));
  assert.throws(() => store.readSchedules(), (e) => e instanceof StoreError && e.message.includes('schedules.json'));
});

// ===== 儀表板輪：用量帳本＋prompt 卷宗＋跨流程最近執行 =====

test('用量帳本：append 後讀回一致；殘行跳過；sinceMs 過濾', () => {
  const { store, dir } = tmpStore();
  assert.deepEqual(store.readUsage(), []); // 沒記過帳＝空帳本
  store.appendUsage({ at: '2026-08-01T10:00:00.000Z', kind: 'step', run: 'r-1', input_tokens: 10, output_tokens: 5 });
  store.appendUsage({ at: '2026-09-01T10:00:00.000Z', kind: 'compose', input_tokens: 3, output_tokens: 2 });
  fs.appendFileSync(path.join(dir, 'usage.jsonl'), '{"at":"殘行沒寫完', 'utf8'); // append 中斷模擬
  const all = store.readUsage();
  assert.equal(all.length, 2, '殘行要跳過、好行都在');
  assert.equal(all[0].run, 'r-1');
  const recent = store.readUsage({ sinceMs: new Date('2026-08-15').getTime() });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].kind, 'compose');
});

test('prompt 卷宗：寫→列→讀一致；讀不存在的卷宗＝人話 NOT_FOUND（舊紀錄沒卷宗）', () => {
  const { store } = tmpStore();
  store.writeWorkflow('範例', 'wf1', DEF);
  store.writePromptRecord('範例', 'wf1', 'r-1', 'a.txt', '# 這一步：步驟A\n做A');
  store.writePromptRecord('範例', 'wf1', 'r-1', 'b-判路.txt', '判路 prompt');
  assert.deepEqual(store.listPromptRecords('範例', 'wf1', 'r-1'), ['a.txt', 'b-判路.txt']);
  assert.ok(store.readPromptRecord('範例', 'wf1', 'r-1', 'a.txt').includes('步驟A'));
  assert.deepEqual(store.listPromptRecords('範例', 'wf1', 'r-沒有'), []);
  assert.throws(() => store.readPromptRecord('範例', 'wf1', 'r-1', 'c.txt'),
    (e) => e instanceof StoreError && e.code === 'NOT_FOUND' && e.message.includes('卷宗'));
});

test('listRecentRuns：跨流程合併、新的在前、limit 生效', () => {
  const { store } = tmpStore();
  store.writeWorkflow('範例', 'wf1', DEF);
  store.writeWorkflow('工作', 'wf2', { ...DEF, name: '另一條' });
  store.writeRun('範例', 'wf1', 'r-20260810-090000-aaaa', { status: 'done' });
  store.writeRun('工作', 'wf2', 'r-20260901-100000-bbbb', { status: 'paused' });
  store.writeRun('範例', 'wf1', 'r-20260830-120000-cccc', { status: 'done' });
  const recent = store.listRecentRuns(2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].runId, 'r-20260901-100000-bbbb');
  assert.equal(recent[0].id, 'wf2');
  assert.equal(recent[1].runId, 'r-20260830-120000-cccc');
});

test('刪一次執行：整夾（含產出與卷宗）移除；刪不存在的回 NOT_FOUND 人話', () => {
  const { store } = tmpStore();
  store.writeWorkflow('範例', 'wf1', DEF);
  store.writeRun('範例', 'wf1', 'r-1', { status: 'paused' });
  store.writeArtifact('範例', 'wf1', 'r-1', 'a.md', '產出');
  store.writePromptRecord('範例', 'wf1', 'r-1', 'a.txt', '卷宗');
  store.deleteRun('範例', 'wf1', 'r-1');
  assert.deepEqual(store.listRuns('範例', 'wf1'), []);
  assert.deepEqual(store.listPromptRecords('範例', 'wf1', 'r-1'), []);
  assert.throws(() => store.deleteRun('範例', 'wf1', 'r-1'), (e) => e instanceof StoreError && e.code === 'NOT_FOUND');
});
