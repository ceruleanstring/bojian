import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, StoreError, DEFAULT_SETTINGS, safeFileName, dedupeFileName } from '../src/store.js';
import { mergeFields } from '../src/memory.js';

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

test('排版輪 L5 ⑥：listWorkflows 每筆多 steps／human_steps（只數一般步驟；壞檔＝null）；舊欄位原樣、存檔格式不變', () => {
  const { store, dir } = tmpStore();
  const def = {
    ...DEF,
    nodes: [
      { id: 'a', title: 'A', executor: 'ai', stop_point: 'never', instruction: '做A', next: ['b'] },
      { id: 'b', kind: 'branch', title: '分岔', instruction: '看狀況', branches: [{ label: 'x', next: 'c' }, { label: 'y', next: 'd' }], next: [] },
      { id: 'c', kind: 'task', title: 'C', executor: 'human', stop_point: 'never', instruction: '你做', next: [] },
      { id: 'd', title: 'D', executor: 'ai', stop_point: 'never', instruction: '做D', next: [] },
    ],
  };
  store.writeWorkflow('範例', 'wf1', def);
  store.writeWorkflow('範例', 'old', DEF); // 舊資料（只有一步、沒有任何新欄位）照樣列
  store.writeWorkflow('範例', 'bad', DEF);
  const yamlBefore = fs.readFileSync(path.join(dir, 'workflows', '範例', 'old', 'workflow.yaml'), 'utf8');
  fs.writeFileSync(path.join(dir, 'workflows', '範例', 'bad', 'workflow.yaml'), 'a: [沒關括號', 'utf8');
  const byId = Object.fromEntries(store.listWorkflows().map((w) => [w.id, w]));
  assert.deepEqual(byId.wf1, { category: '範例', id: 'wf1', name: '測試流程', steps: 3, human_steps: 1 });
  assert.deepEqual(byId.old, { category: '範例', id: 'old', name: '測試流程', steps: 1, human_steps: 0 });
  assert.deepEqual(byId.bad, { category: '範例', id: 'bad', name: 'bad', steps: null, human_steps: null }, '壞檔仍列出，步數 null');
  assert.equal(fs.readFileSync(path.join(dir, 'workflows', '範例', 'old', 'workflow.yaml'), 'utf8'), yamlBefore, '列清單不改檔');
  assert.deepEqual(store.readWorkflow('範例', 'old'), DEF, '定義檔讀回原樣（沒被塞步數欄位）');
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

// ===== 用量帳本＋prompt 卷宗＋跨流程最近執行 =====

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

test('卷宗路徑（ADR-009 ④）：promptRecordPath 回 prompts/<name> 的絕對路徑、先建好目錄但不建檔；名字經 safeFileName；與 writePromptRecord 寫出的檔同一個位置', () => {
  const { store, dir } = tmpStore();
  store.writeWorkflow('範例', 'wf1', DEF);
  const p = store.promptRecordPath('範例', 'wf1', 'r-1', 'a.exec.log');
  assert.ok(path.isAbsolute(p));
  assert.equal(p, path.join(dir, 'workflows', '範例', 'wf1', 'runs', 'r-1', 'prompts', 'a.exec.log'));
  assert.ok(fs.existsSync(path.dirname(p)), 'prompts 目錄要先建好（籠子直接 append）');
  assert.ok(!fs.existsSync(p), '只回路徑，不建檔');
  assert.deepEqual(store.listPromptRecords('範例', 'wf1', 'r-1'), [], '沒建檔＝卷宗清單還是空的');
  fs.appendFileSync(p, 'x.mjs\t0\t1.2s\n', 'utf8');
  assert.deepEqual(store.listPromptRecords('範例', 'wf1', 'r-1'), ['a.exec.log']);
  assert.equal(store.readPromptRecord('範例', 'wf1', 'r-1', 'a.exec.log'), 'x.mjs\t0\t1.2s\n');
  store.writePromptRecord('範例', 'wf1', 'r-1', 'b.txt', '卷宗');
  assert.equal(fs.readFileSync(store.promptRecordPath('範例', 'wf1', 'r-1', 'b.txt'), 'utf8'), '卷宗', '與 writePromptRecord 同一個位置');
  assert.throws(() => store.promptRecordPath('範例', 'wf1', 'r-1', '../../逃.log'),
    (e) => e instanceof StoreError && e.code === 'BAD_NAME', '帶路徑符號的名字被 safeFileName 擋下，跳不出 prompts/');
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

test('工作單留存（監工輪）：寫→列→讀一致；沒寫過的種類＝空清單；名字帶路徑符號不跳出 logs/<種類>/也不炸', () => {
  const { store, dir } = tmpStore();
  store.writeLog('compose', '2026-09-09T10-00-00', 'x');
  store.writeLog('compose', '2026-09-09T10-00-00.reply', '回覆全文');
  assert.deepEqual(store.listLogs('compose'), ['2026-09-09T10-00-00.reply.txt', '2026-09-09T10-00-00.txt']);
  assert.equal(store.readLog('compose', '2026-09-09T10-00-00'), 'x');
  assert.equal(store.readLog('compose', '2026-09-09T10-00-00.reply'), '回覆全文');
  assert.deepEqual(store.listLogs('optimize'), [], '沒寫過的種類回空清單');
  store.writeLog('compose', '../../跑掉', '不該寫出去'); // 寫不進不擋（不 throw）
  assert.deepEqual(store.listLogs('compose'), ['2026-09-09T10-00-00.reply.txt', '2026-09-09T10-00-00.txt']);
  assert.ok(!fs.existsSync(path.join(dir, '跑掉.txt')) && !fs.existsSync(path.join(dir, 'logs', '跑掉.txt')), '不准跳出 logs/compose/');
  assert.throws(() => store.readLog('compose', '沒這份'), (e) => e instanceof StoreError && e.code === 'NOT_FOUND');
});

// ===== 兩本帳（卡）＋詞典＋群組圈＋身分＋設定＋記憶垃圾桶＋備份 =====

const HABIT = {
  id: 'h-test0001-ab12', bucket: 'habit', text: '一天 3 個點', who: 'you', field: '旅行節奏',
  scope: { level: 'workflow', category: '旅遊', workflow: 'wf-1' },
  source: { kind: 'run-params', category: '旅遊', workflow: 'wf-1', run: 'r-1', node: null, at: '2026-09-09T00:00:00.000Z', quote: '（開跑表單）旅行節奏：一天 3 個點' },
  expires: null, status: 'active', replaces: null, replaced_by: null,
  created_at: '2026-09-09T00:00:00.000Z', last_used_at: null,
  shown_count: 0, picked_count: 0, changed_count: 0, unpicked_streak: 0, scope_log: [], route_reason: '',
};
const { field: _habitField, ...HABIT_NO_FIELD } = HABIT;
const PROFILE = { ...HABIT_NO_FIELD, id: 'p-test0001-cd34', bucket: 'profile', text: '不要客套', layer: 'expression', source: { ...HABIT.source, kind: 'chat', quote: '以後不要客套' } };

test('記憶卡：寫後讀回一致、無暫存檔殘留；兩本帳各自一個資料夾；listCards 只列合法 YAML、可按 status 篩', () => {
  const { store, dir } = tmpStore();
  store.writeCard(HABIT);
  store.writeCard(PROFILE);
  assert.deepEqual(store.readCard('habit', HABIT.id), HABIT);
  assert.deepEqual(store.readCard('profile', PROFILE.id), PROFILE);
  assert.ok(fs.existsSync(path.join(dir, 'memory', 'habits', `${HABIT.id}.yaml`)));
  assert.ok(fs.existsSync(path.join(dir, 'memory', 'profile', `${PROFILE.id}.yaml`)));
  const files = fs.readdirSync(path.join(dir, 'memory', 'habits'));
  assert.ok(!files.some((f) => f.includes('.tmp')), `不應殘留暫存檔：${files}`);
  fs.writeFileSync(path.join(dir, 'memory', 'habits', 'bad.yaml'), 'a: [沒關括號', 'utf8');
  fs.writeFileSync(path.join(dir, 'memory', 'habits', 'note.txt'), '不是卡', 'utf8');
  store.writeCard({ ...HABIT, id: 'h-test0002-ef56', status: 'dormant' });
  assert.deepEqual(store.listCards('habit').map((c) => c.id), [HABIT.id, 'h-test0002-ef56']);
  assert.deepEqual(store.listCards('habit', { status: 'dormant' }).map((c) => c.id), ['h-test0002-ef56']);
  assert.deepEqual(store.listCards('profile').map((c) => c.id), [PROFILE.id]);
  assert.equal(store.listCards().length, 3, '不給 bucket＝兩本帳都列');
  assert.throws(() => store.readCard('habit', '沒這張'), (e) => e instanceof StoreError && e.code === 'NOT_FOUND' && e.message.includes('找不到這張卡'));
  assert.throws(() => store.readCard('team', HABIT.id), (e) => e instanceof StoreError && e.message.includes('沒有這種卡'));
  assert.throws(() => store.writeCard({ ...HABIT, id: '../跑掉' }), (e) => e instanceof StoreError && e.code === 'BAD_NAME');
  assert.deepEqual(store.listCards('habit').length, 2, '壞檔不列、也不炸');
});

test('詞典：缺檔回出廠十條（version 1、語氣含口吻、created_at 有值）；寫後讀回；壞檔明確報錯', () => {
  const { store, dir } = tmpStore();
  const dict = store.readDict();
  assert.equal(dict.version, 1);
  assert.equal(dict.fields.length, 10);
  assert.ok(dict.fields.find((f) => f.name === '語氣').synonyms.includes('口吻'));
  assert.ok(dict.fields.every((f) => typeof f.created_at === 'string'));
  assert.equal(fs.existsSync(path.join(dir, 'memory', 'dict.yaml')), false, '只讀不落地');
  dict.fields.push({ name: '旅行節奏', kind: 'method', synonyms: [], origin: { category: '旅遊', workflow: 'wf-1' }, created_at: '2026-09-09T00:00:00.000Z' });
  store.writeDict(dict);
  assert.deepEqual(store.readDict(), dict);
  fs.writeFileSync(path.join(dir, 'memory', 'dict.yaml'), 'fields: [沒關', 'utf8');
  assert.throws(() => store.readDict(), (e) => e instanceof StoreError && e.code === 'CORRUPT');
});

test('群組圈：缺檔回 null；寫後讀回 updated_at 非空、files 深等於 []；listGroups 列全部；分類名經路徑護欄', () => {
  const { store } = tmpStore();
  assert.equal(store.readGroup('旅遊'), null);
  assert.deepEqual(store.listGroups(), []);
  const rules = [{ id: 'g-1', text: '語氣：輕鬆', field: '語氣', value: '輕鬆', status: 'active', created_at: '2026-09-09T00:00:00.000Z' }];
  const written = store.writeGroup('旅遊', { category: '旅遊', text: '語氣：輕鬆', rules });
  assert.ok(written.updated_at);
  const back = store.readGroup('旅遊');
  assert.equal(back.category, '旅遊');
  assert.equal(back.text, '語氣：輕鬆');
  assert.deepEqual(back.rules, rules);
  assert.deepEqual(back.files, []);
  assert.ok(back.updated_at, 'updated_at 非空');
  store.writeGroup('工作', { category: '工作', text: '', rules: [] });
  assert.deepEqual(store.listGroups().map((g) => g.category).sort(), ['工作', '旅遊']);
  assert.throws(() => store.readGroup('../外面'), (e) => e instanceof StoreError && e.code === 'BAD_NAME');
});

test('身分：缺檔回空清單；寫後讀回一致', () => {
  const { store } = tmpStore();
  assert.deepEqual(store.readIdentities(), []);
  const list = [{ id: 'i-1', name: '我', cards: ['p-1'], categories: ['旅遊'], created_at: '2026-09-09T00:00:00.000Z' }];
  store.writeIdentities(list);
  assert.deepEqual(store.readIdentities(), list);
});

test('全域設定：缺檔回缺省（memory.paused 假、check_facts auto）；寫入部分鍵後讀回深合併缺省；壞檔明確報錯', () => {
  const { store, dir } = tmpStore();
  const s = store.readSettings();
  assert.equal(s.version, 1);
  assert.equal(s.memory.paused, false);
  assert.deepEqual(s.memory.sensitive, { health: false, politics: false, religion: false, finance: false });
  assert.equal(s.memory.intro_done_at, null);
  assert.equal(s.defaults.check_facts, 'auto');
  assert.deepEqual(s.defaults.supervisor_flags, { note: true, tier: false, tools: false });
  assert.equal(s.defaults.model_tier, null);
  assert.deepEqual(s.exec, { auto_makeup: false, remind_leads: [], web: true, overview_enabled: true }); // overview_enabled＝跑完出總覽，ADR-007 第 5 條預設開
  store.writeSettings({ version: 1, memory: { paused: true, sensitive: { health: true } }, exec: { remind_leads: ['1d'] } });
  const back = store.readSettings();
  assert.equal(back.memory.paused, true);
  assert.deepEqual(back.memory.sensitive, { health: true, politics: false, religion: false, finance: false }, '沒寫的鍵補缺省');
  assert.equal(back.defaults.check_enabled, true);
  assert.deepEqual(back.exec.remind_leads, ['1d'], '陣列整個取代不合併');
  assert.equal(back.exec.web, true);
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
  fs.writeFileSync(path.join(dir, 'settings.json'), '{壞', 'utf8');
  assert.throws(() => store.readSettings(), (e) => e instanceof StoreError && e.code === 'CORRUPT' && e.message.includes('settings.json'));
});

test('記憶垃圾桶：丟→列→復原原位；獨立於流程垃圾桶；過期清除；工作流垃圾桶的 key 不互通', () => {
  const { store, dir } = tmpStore();
  store.writeCard(HABIT);
  const key = store.trashCard('habit', HABIT.id);
  assert.equal(fs.existsSync(path.join(dir, 'memory', 'habits', `${HABIT.id}.yaml`)), false, '原位清空');
  assert.equal(fs.existsSync(path.join(dir, 'trash')), false, '不進流程垃圾桶');
  assert.deepEqual(store.listTrash(), [], '流程垃圾桶看不到卡');
  const list = store.listMemoryTrash();
  assert.equal(list.length, 1);
  assert.equal(list[0].key, key);
  assert.equal(list[0].bucket, 'habit');
  assert.equal(list[0].id, HABIT.id);
  assert.equal(list[0].text, HABIT.text);
  assert.ok(list[0].trashed_at);
  assert.ok(fs.existsSync(path.join(dir, 'memory', 'trash', key, 'card.yaml')));
  assert.ok(fs.existsSync(path.join(dir, 'memory', 'trash', key, 'meta.yaml')));
  const restored = store.restoreCard(key);
  assert.deepEqual(restored, HABIT);
  assert.deepEqual(store.readCard('habit', HABIT.id), HABIT, '原位重現');
  assert.deepEqual(store.listMemoryTrash(), []);
  assert.throws(() => store.restoreCard(key), (e) => e instanceof StoreError && e.code === 'NOT_FOUND' && e.message.includes('垃圾桶裡沒有這張卡'));
  assert.throws(() => store.trashCard('habit', '沒這張'), (e) => e instanceof StoreError && e.code === 'NOT_FOUND');
  // 過期清除：31 天前的清掉、1 天前的留著
  const old = store.trashCard('habit', HABIT.id);
  store.writeCard({ ...HABIT, id: 'h-test0002-ef56' });
  const fresh = store.trashCard('habit', 'h-test0002-ef56');
  const stamp = (k, daysAgo) => {
    const p = path.join(dir, 'memory', 'trash', k, 'meta.yaml');
    const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/trashed_at: .*/, `trashed_at: '${at}'`), 'utf8');
  };
  stamp(old, 31);
  stamp(fresh, 1);
  store.purgeMemoryTrash(30);
  assert.deepEqual(store.listMemoryTrash().map((t) => t.key), [fresh]);
  // 兩個垃圾桶不互通
  store.writeWorkflow('工作', 'wf1', DEF);
  const wfKey = store.trashWorkflow('工作', 'wf1');
  assert.throws(() => store.restoreCard(wfKey), (e) => e instanceof StoreError && e.code === 'NOT_FOUND' && e.message.includes('垃圾桶裡沒有這張卡'));
  assert.throws(() => store.restoreTrash(fresh), (e) => e instanceof StoreError && e.code === 'NOT_FOUND');
  assert.throws(() => store.restoreCard('../別人的'), (e) => e.code === 'BAD_NAME');
});

test('備份：同層 <basename>-backups/<ts>/ 整份複製、含 memory/、不含 backups 自己；listBackups 列得出來', () => {
  const { store, dir } = tmpStore();
  const backupsRoot = path.join(path.dirname(dir), `${path.basename(dir)}-backups`);
  try {
    store.writeCard(HABIT);
    store.writeWorkflow('範例', 'wf1', DEF);
    const { path: dest, at } = store.backup();
    assert.equal(path.dirname(dest), backupsRoot);
    assert.ok(at);
    assert.ok(fs.existsSync(path.join(dest, 'memory', 'habits', `${HABIT.id}.yaml`)), '含 memory/');
    assert.ok(fs.existsSync(path.join(dest, 'workflows', '範例', 'wf1', 'workflow.yaml')));
    assert.equal(fs.existsSync(path.join(dest, path.basename(backupsRoot))), false, '不含 backups 自己');
    assert.equal(fs.existsSync(path.join(dest, 'backups')), false);
    const list = store.listBackups();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, path.basename(dest));
    assert.ok(list[0].at);
  } finally {
    fs.rmSync(backupsRoot, { recursive: true, force: true });
  }
});

// 多組織：造一個資料根（orgs.json＋orgs/main＋orgs/org-x），回 { rootDir, orgDir }
function tmpOrgRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-root-'));
  fs.mkdirSync(path.join(rootDir, 'orgs', 'main'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'orgs', 'org-x'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'orgs.json'), JSON.stringify({ orgs: [{ id: 'main' }, { id: 'org-x' }] }));
  fs.writeFileSync(path.join(rootDir, 'orgs', 'org-x', 'mark.txt'), 'x');
  return { rootDir, orgDir: path.join(rootDir, 'orgs', 'main') };
}

test('多組織備份：帶 root 時備的是整個資料根（含 orgs.json 與全部組織夾），不含 .tmp- 與備份夾自己', () => {
  const { rootDir, orgDir } = tmpOrgRoot();
  const backupsRoot = `${rootDir}-backups`;
  try {
    const store = createStore(orgDir, { root: rootDir });
    store.writeWorkflow('範例', 'wf1', DEF);
    fs.writeFileSync(path.join(rootDir, 'orgs.json.tmp-999'), 'half');
    const { path: dest } = store.backup();
    assert.equal(path.dirname(dest), backupsRoot);
    assert.ok(fs.existsSync(path.join(dest, 'orgs.json')), '含 orgs.json');
    assert.ok(fs.existsSync(path.join(dest, 'orgs', 'main', 'workflows', '範例', 'wf1', 'workflow.yaml')), '含 main 組織');
    assert.ok(fs.existsSync(path.join(dest, 'orgs', 'org-x', 'mark.txt')), '含其他組織');
    assert.equal(fs.existsSync(path.join(dest, 'orgs.json.tmp-999')), false, '不含暫存檔');
    assert.equal(fs.existsSync(path.join(dest, path.basename(backupsRoot))), false, '不含備份夾自己');
    assert.equal(store.listBackups().length, 1);
  } finally {
    fs.rmSync(backupsRoot, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('多組織備份：不帶 root 時 root＝dataDir，備份仍只備那一夾、落在 <dataDir>-backups/（舊行為不變）', () => {
  const { rootDir, orgDir } = tmpOrgRoot();
  const backupsRoot = `${orgDir}-backups`;
  try {
    const store = createStore(orgDir);
    store.writeWorkflow('範例', 'wf1', DEF);
    const { path: dest } = store.backup();
    assert.equal(path.dirname(dest), backupsRoot);
    assert.ok(fs.existsSync(path.join(dest, 'workflows', '範例', 'wf1', 'workflow.yaml')));
    assert.equal(fs.existsSync(path.join(dest, 'orgs.json')), false, '備的是組織夾、不是資料根');
  } finally {
    fs.rmSync(backupsRoot, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---- 共用檔儲存（data/shared/<scope>/{index.yaml,files/}）----
test('U1a 共用檔：沒有夾＝空索引；加規範存 text_cache、加參考不存；同名 DUP；列表分兩類；刪除連檔帶索引；路徑與規範全文', () => {
  const { store, dir } = tmpStore();
  assert.deepEqual(store.readSharedIndex('_company'), { version: 1, files: [] });
  assert.deepEqual(store.listShared('_company'), { rules: [], refs: [], rule_chars: 0 });
  assert.equal(store.sharedFilePath('_company', '沒有.md'), null);
  assert.deepEqual(store.readSharedRuleTexts('行銷'), []);

  store.addShared('_company', { name: '手冊.md', kind: 'rule', buf: Buffer.from('語氣親切', 'utf8'), text: '語氣親切' });
  store.addShared('_company', { name: '範本.docx', kind: 'ref', buf: Buffer.from('binary-ish'), text: null });
  const idx = store.readSharedIndex('_company');
  assert.equal(idx.version, 1);
  assert.equal(idx.files.length, 2);
  const rule = idx.files.find((f) => f.name === '手冊.md');
  assert.equal(rule.kind, 'rule');
  assert.equal(rule.chars, 4);
  assert.equal(rule.text_cache, '語氣親切');
  assert.ok(rule.uploaded_at);
  const ref = idx.files.find((f) => f.name === '範本.docx');
  assert.equal(ref.kind, 'ref');
  assert.equal(ref.text_cache, undefined, '參考類不存轉好的文字');
  assert.ok(fs.existsSync(path.join(dir, 'shared', '_company', 'files', '手冊.md')));
  assert.ok(fs.existsSync(path.join(dir, 'shared', '_company', 'index.yaml')));

  assert.throws(() => store.addShared('_company', { name: '手冊.md', kind: 'rule', buf: Buffer.from('x'), text: 'x' }),
    (e) => e instanceof StoreError && e.code === 'DUP' && e.message === '已有同名檔，先刪再傳');
  assert.throws(() => store.addShared('_company', { name: '../x.md', kind: 'rule', buf: Buffer.from('x'), text: 'x' }), (e) => e instanceof StoreError && e.code === 'BAD_NAME');
  assert.throws(() => store.addShared('_company', { name: 'y.md', kind: 'other', buf: Buffer.from('x'), text: 'x' }), (e) => e instanceof StoreError && e.code === 'BAD_NAME');

  const listed = store.listShared('_company');
  assert.deepEqual(listed.rules.map((f) => ({ name: f.name, chars: f.chars })), [{ name: '手冊.md', chars: 4 }]);
  assert.equal(listed.refs.length, 1);
  assert.equal(listed.refs[0].name, '範本.docx');
  assert.equal(listed.rule_chars, 4);
  assert.equal(listed.rules[0].text_cache, undefined, '列表不帶全文');
  assert.deepEqual(store.readSharedRuleTexts('_company'), [{ name: '手冊.md', chars: 4, text: '語氣親切' }]);
  assert.equal(store.sharedFilePath('_company', '手冊.md'), path.join(dir, 'shared', '_company', 'files', '手冊.md'));

  // 跨層同名各存各的
  store.addShared('行銷', { name: '手冊.md', kind: 'rule', buf: Buffer.from('部門版', 'utf8'), text: '部門版' });
  assert.equal(store.readSharedRuleTexts('行銷')[0].text, '部門版');
  assert.equal(store.readSharedRuleTexts('_company')[0].text, '語氣親切');

  store.deleteShared('_company', '手冊.md');
  assert.equal(fs.existsSync(path.join(dir, 'shared', '_company', 'files', '手冊.md')), false);
  assert.deepEqual(store.listShared('_company').rules, []);
  assert.equal(store.listShared('_company').refs.length, 1);
  assert.throws(() => store.deleteShared('_company', '手冊.md'), (e) => e instanceof StoreError && e.code === 'NOT_FOUND');
});

// ——  ⑥／：詞典補缺三條、settings.compose 缺省 ——
test('B4 ⑥：舊 dict.yaml 只有七條→readDict() 十條、既有條 created_at 不變、新三條 origin factory 且 kind 對；已有同名「範圍」自訂條→不重複也不動；不落地', () => {
  const { store, dir } = tmpStore();
  const OLD = ['語氣', '長度', '格式', '讀者', '語言', '截止日', '產出檔類型'];
  const oldFields = OLD.map((name) => ({ name, kind: 'appearance', synonyms: [], origin: 'factory', created_at: '2026-09-09T00:00:00.000Z' }));
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  const yamlText = ['version: 1', 'fields:', ...oldFields.map((f) => `  - {name: ${f.name}, kind: ${f.kind}, synonyms: [], origin: factory, created_at: '${f.created_at}'}`)].join('\n');
  fs.writeFileSync(path.join(dir, 'memory', 'dict.yaml'), yamlText, 'utf8');
  const dict = store.readDict();
  assert.equal(dict.fields.length, 10);
  assert.deepEqual(dict.fields.slice(0, 7).map((f) => [f.name, f.created_at]), oldFields.map((f) => [f.name, f.created_at]), '既有條原樣、順序不變');
  const added = dict.fields.slice(7);
  assert.deepEqual(added.map((f) => [f.name, f.kind]), [['型態', 'appearance'], ['分段', 'appearance'], ['範圍', 'range']]);
  assert.ok(added.every((f) => f.origin === 'factory' && typeof f.created_at === 'string' && f.created_at > '2026-09-10'));
  assert.ok(added.find((f) => f.name === '型態').synonyms.includes('成品類型'));
  assert.ok(added.find((f) => f.name === '範圍').synonyms.includes('期間'));
  assert.equal(fs.readFileSync(path.join(dir, 'memory', 'dict.yaml'), 'utf8'), yamlText, '補缺只在讀出來的那份，不改檔');
  // 已有同名自訂條：不重複、不動
  const custom = { name: '範圍', kind: 'method', synonyms: ['哪一段'], origin: { category: '旅遊', workflow: 'wf-1' }, created_at: '2026-09-01T00:00:00.000Z' };
  store.writeDict({ version: 1, fields: [...oldFields, custom] });
  const d2 = store.readDict();
  assert.equal(d2.fields.length, 10);
  assert.equal(d2.fields.filter((f) => f.name === '範圍').length, 1);
  assert.deepEqual(d2.fields.find((f) => f.name === '範圍'), custom);
  assert.deepEqual(d2.fields.slice(8).map((f) => f.name), ['型態', '分段']);
});

test('B4 契約 F：DEFAULT_SETTINGS.compose 深等於 {confirm_shape:true}；舊 settings.json 沒 compose 讀回補上；寫 false 讀回 false', () => {
  const { store, dir } = tmpStore();
  assert.deepEqual(DEFAULT_SETTINGS.compose, { confirm_shape: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, memory: { paused: true } }), 'utf8');
  assert.deepEqual(store.readSettings().compose, { confirm_shape: true }, '舊設定檔沒這鍵也補缺省');
  store.writeSettings({ version: 1, compose: { confirm_shape: false } });
  assert.equal(store.readSettings().compose.confirm_shape, false);
});

test('U1a 設定與分類：DEFAULT_SETTINGS 有 company_name 空字串、舊 settings.json 讀回補上；分類名不能是 _company', () => {
  const { store, dir } = tmpStore();
  assert.equal(DEFAULT_SETTINGS.company_name, '');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, memory: { paused: true } }), 'utf8');
  assert.equal(store.readSettings().company_name, '', '舊設定檔沒這鍵也補缺省');
  assert.throws(() => store.createCategory('_company'), (e) => e instanceof StoreError && e.code === 'BAD_NAME' && e.message.includes('_company'));
  assert.equal(fs.existsSync(path.join(dir, 'workflows', '_company')), false);
});

// U1a 覆核該修 ①④：字數語意（規範＝字元；參考 md／txt＝字元、二進位 chars=null）＋ bytes；檔名擋 Windows 保留字
test('U1a 修正：參考 txt 的 chars 是字元數不是位元組、docx 參考 chars=null 且 bytes>0；規範也給 bytes；rule_chars 只算規範', () => {
  const { store } = tmpStore();
  store.addShared('_company', { name: '手冊.md', kind: 'rule', buf: Buffer.from('語氣親切', 'utf8'), text: '語氣親切' });
  store.addShared('_company', { name: '備註.txt', kind: 'ref', buf: Buffer.from('中文五個字', 'utf8'), text: null });
  store.addShared('_company', { name: '範本.docx', kind: 'ref', buf: Buffer.from([0x50, 0x4b, 0x03, 0x04]), text: null });
  const { rules, refs, rule_chars } = store.listShared('_company');
  assert.deepEqual(rules.map(({ name, chars, bytes }) => ({ name, chars, bytes })), [{ name: '手冊.md', chars: 4, bytes: 12 }]);
  const txt = refs.find((f) => f.name === '備註.txt');
  assert.equal(txt.chars, 5, '中文 txt 參考檔：字元數');
  assert.equal(txt.bytes, 15);
  const docx = refs.find((f) => f.name === '範本.docx');
  assert.equal(docx.chars, null, '二進位不記字數');
  assert.equal(docx.bytes, 4);
  assert.equal(rule_chars, 4);
  for (const f of [...rules, ...refs]) assert.deepEqual(Object.keys(f).sort(), ['bytes', 'chars', 'name', 'uploaded_at']);
});

test('U1a 修正：safeFileName 擋 Windows 保留字（CON／PRN／AUX／NUL／COM1–9／LPT1–9，不分大小寫、帶副檔名也擋）', () => {
  const { store, dir } = tmpStore();
  for (const bad of ['CON', 'con.md', 'Nul.txt', 'COM1.md', 'lpt9', 'PRN.docx', 'AUX']) {
    assert.throws(() => store.addShared('_company', { name: bad, kind: 'ref', buf: Buffer.from('x'), text: null }),
      (e) => e instanceof StoreError && e.code === 'BAD_NAME' && e.message.includes('保留字'), bad);
  }
  assert.equal(fs.existsSync(path.join(dir, 'shared')), false, '一個都沒落地');
  for (const ok of ['CONTRACT.md', 'console.txt', 'COM10.md', 'lpt.md']) store.addShared('_company', { name: ok, kind: 'ref', buf: Buffer.from('x'), text: null });
  assert.equal(store.listShared('_company').refs.length, 4);
});

// —— 分類改名（八處同步：流程夾／群組 yaml／共用夾／排程／提議／習慣卡與認識卡／身分／垃圾桶）＋復原擋門 ——
function seedRename(store) {
  store.writeWorkflow('旅遊', 'a', { ...DEF, name: '訂機票' });
  store.writeWorkflow('工作', 'b', { ...DEF, name: '寫週報' });
  const rid = store.newRunId();
  store.writeRun('旅遊', 'a', rid, { run_id: rid, status: 'done', workflow: { category: '旅遊', id: 'a', name: '訂機票' } });
  store.writeGroup('旅遊', { text: '旅遊守則' });
  store.addShared('旅遊', { name: '規範.md', kind: 'rule', buf: Buffer.from('x'), text: '規範' });
  store.writeSchedules([
    { id: 's1', workflow_id: '旅遊/a', freq: 'daily', time: '08:00' },
    { id: 's2', workflow_id: '工作/b', freq: 'daily', time: '09:00' },
  ]);
  store.writeProposals([
    { id: 'p1', workflow: { category: '旅遊', id: 'a' }, status: 'pending' },
    { id: 'p2', workflow: { category: '工作', id: 'b' }, status: 'pending' },
  ]);
  store.writeCard({ bucket: 'habit', id: 'h1', text: '簡短', scope: { level: 'category', category: '旅遊', workflow: null }, status: 'active' });
  store.writeCard({ bucket: 'profile', id: 'pf1', text: '我是誰', scope: { level: 'workflow', category: '旅遊', workflow: 'a' }, status: 'active' });
  // level:all 的卡就算 category 欄位殘留舊名也不動（只認 category／workflow 兩層）
  store.writeCard({ bucket: 'habit', id: 'h2', text: '全域', scope: { level: 'all', category: '旅遊', workflow: null }, status: 'active' });
  store.writeIdentities([{ id: 'i1', name: '業務', categories: ['旅遊', '工作'] }, { id: 'i2', name: '工程', categories: ['工作'] }]);
  store.writeNotices([
    { id: 'n1', type: 'step_failed', status: 'unread', run: { category: '旅遊', id: 'a', run_id: rid, node: 'n1' } },
    { id: 'n2', type: 'step_failed', status: 'done', run: { category: '旅遊', id: 'a', run_id: rid, node: 'n1' } },
    { id: 'n3', type: 'step_failed', status: 'unread', run: { category: '工作', id: 'b', run_id: 'r-x', node: 'n1' } },
  ]);
  return { rid };
}

test('B0 ①：renameCategory 搬流程夾、群組 yaml、共用夾到新名；舊名消失；listCategories 含新不含舊', () => {
  const { store, dir } = tmpStore();
  seedRename(store);
  const moved = store.renameCategory('旅遊', '出差');
  assert.equal(moved.workflows, 1);
  assert.ok(fs.existsSync(path.join(dir, 'workflows', '出差', 'a', 'workflow.yaml')), '流程夾搬到新名');
  assert.ok(!fs.existsSync(path.join(dir, 'workflows', '旅遊')), '舊流程夾不存在');
  assert.ok(fs.existsSync(path.join(dir, 'memory', 'groups', '出差.yaml')), '群組 yaml 搬到新名');
  assert.ok(!fs.existsSync(path.join(dir, 'memory', 'groups', '旅遊.yaml')));
  const g = store.readGroup('出差');
  assert.equal(g.text, '旅遊守則');
  assert.equal(g.category, '出差', '群組檔內的 category 欄位也要改（server 詞典合併會拿它回寫檔名）');
  assert.equal(store.readGroup('旅遊'), null);
  assert.ok(fs.existsSync(path.join(dir, 'shared', '出差', 'index.yaml')), '共用夾搬到新名');
  assert.ok(!fs.existsSync(path.join(dir, 'shared', '旅遊')));
  assert.equal(store.listShared('出差').rules.length, 1);
  const cats = store.listCategories();
  assert.ok(cats.includes('出差') && !cats.includes('旅遊'), `listCategories=${cats}`);
  assert.equal(store.readWorkflow('出差', 'a').name, '訂機票');
  assert.equal(store.readWorkflow('工作', 'b').name, '寫週報', '別的分類不動');
});

test('B0 ②：排程 workflow_id 前綴、提議 workflow.category、習慣卡與認識卡 scope.category（level all 不動）、身分 categories 全同步；回各處筆數', () => {
  const { store } = tmpStore();
  seedRename(store);
  const moved = store.renameCategory('旅遊', '出差');
  assert.deepEqual(moved, { workflows: 1, schedules: 1, proposals: 1, cards: 2, identities: 1, notices: 1, trash: 0 });
  const scheds = store.readSchedules();
  assert.equal(scheds.find((s) => s.id === 's1').workflow_id, '出差/a');
  assert.equal(scheds.find((s) => s.id === 's2').workflow_id, '工作/b', '其他分類的排程不動');
  const props = store.readProposals();
  assert.equal(props.find((p) => p.id === 'p1').workflow.category, '出差');
  assert.equal(props.find((p) => p.id === 'p2').workflow.category, '工作');
  assert.equal(store.readCard('habit', 'h1').scope.category, '出差', '習慣卡（分類層）');
  assert.deepEqual(store.readCard('profile', 'pf1').scope, { level: 'workflow', category: '出差', workflow: 'a' }, '認識卡（流程層）');
  assert.equal(store.readCard('habit', 'h2').scope.category, '旅遊', 'level:all 不動');
  assert.deepEqual(store.readIdentities().map((i) => i.categories), [['出差', '工作'], ['工作']]);
});

test('B0 修正輪（第九處）：改名後未讀通知的 run.category 是新名（不然點「重試」拿舊分類找 run 回莫名的 404）；已處理的留痕不動、別的分類不動', () => {
  const { store } = tmpStore();
  seedRename(store);
  assert.equal(store.renameCategory('旅遊', '出差').notices, 1);
  const notices = store.readNotices();
  assert.equal(notices.find((n) => n.id === 'n1').run.category, '出差', '未讀通知指到新分類');
  assert.equal(notices.find((n) => n.id === 'n2').run.category, '旅遊', '已處理的通知是留痕，不動');
  assert.equal(notices.find((n) => n.id === 'n3').run.category, '工作', '別的分類的通知不動');
  assert.deepEqual(notices.map((n) => n.status), ['unread', 'done', 'unread'], '狀態不動');
});

test('B0 ③：歷史留舊名——run.yaml 的 workflow.category 與 history/v1.yaml 一字不動、不升版；readRun 從新路徑讀得到、舊路徑 NOT_FOUND', () => {
  const { store, dir } = tmpStore();
  const { rid } = seedRename(store);
  const v1Before = fs.readFileSync(path.join(dir, 'workflows', '旅遊', 'a', 'history', 'v1.yaml'), 'utf8');
  store.renameCategory('旅遊', '出差');
  assert.equal(store.readRun('出差', 'a', rid).workflow.category, '旅遊', 'run.yaml 留舊名');
  assert.equal(fs.readFileSync(path.join(dir, 'workflows', '出差', 'a', 'history', 'v1.yaml'), 'utf8'), v1Before, '履歷快照不動');
  assert.deepEqual(store.listVersions('出差', 'a').map((v) => v.version), [1], '改分類名不升版');
  assert.deepEqual(store.listRuns('出差', 'a'), [rid]);
  assert.throws(() => store.readRun('旅遊', 'a', rid), (e) => e instanceof StoreError && e.code === 'NOT_FOUND');
});

test('B0 ④：擋門——空名、同名、_company、「未分類」（新或舊）、已存在、找不到舊分類、路徑符號各自 code；一個都沒落地', () => {
  const { store, dir } = tmpStore();
  seedRename(store);
  store.createCategory('未分類');
  const codeOf = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof StoreError, `要是 StoreError：${e.message}`); return e.code; } return null; };
  assert.equal(codeOf(() => store.renameCategory('旅遊', '')), 'BAD_NAME');
  assert.equal(codeOf(() => store.renameCategory('旅遊', '   ')), 'BAD_NAME');
  assert.equal(codeOf(() => store.renameCategory('旅遊', undefined)), 'BAD_NAME');
  assert.equal(codeOf(() => store.renameCategory('旅遊', '旅遊')), 'BAD_NAME');
  assert.equal(codeOf(() => store.renameCategory('旅遊', '_company')), 'BAD_NAME');
  assert.equal(codeOf(() => store.renameCategory('_company', '出差')), 'BAD_NAME');
  assert.equal(codeOf(() => store.renameCategory('旅遊', '未分類')), 'BAD_NAME');
  assert.equal(codeOf(() => store.renameCategory('未分類', '出差')), 'BAD_NAME');
  assert.equal(codeOf(() => store.renameCategory('旅遊', '工作')), 'CONFLICT');
  assert.equal(codeOf(() => store.renameCategory('沒有的', '出差')), 'NOT_FOUND');
  assert.equal(codeOf(() => store.renameCategory('旅遊', '壞/名')), 'BAD_NAME');
  assert.equal(codeOf(() => store.renameCategory('旅遊', '..')), 'BAD_NAME');
  assert.throws(() => store.renameCategory('旅遊', ''), /名稱不可留空/);
  assert.throws(() => store.renameCategory('旅遊', '旅遊'), /新舊名稱相同/);
  assert.throws(() => store.renameCategory('旅遊', '_company'), /_company/);
  assert.throws(() => store.renameCategory('旅遊', '未分類'), /「未分類」不能改名/);
  assert.throws(() => store.renameCategory('未分類', '出差'), /「未分類」不能改名/);
  assert.throws(() => store.renameCategory('旅遊', '工作'), /已有同名分類/);
  assert.deepEqual(store.listCategories().sort(), ['工作', '旅遊', '未分類']);
  assert.ok(!fs.existsSync(path.join(dir, 'workflows', '出差')));
  assert.equal(store.readSchedules()[0].workflow_id, '旅遊/a');
  assert.deepEqual(store.readIdentities()[0].categories, ['旅遊', '工作']);
});

test('B0 ⑤：中途失敗回滾——群組 yaml 搬不動（目標被資料夾佔住）→ 流程夾搬回舊名、新名不留、其他檔一字不動、丟 StoreError；讀壞檔在驗證階段就擋、什麼都沒搬', () => {
  const { store, dir } = tmpStore();
  seedRename(store);
  fs.mkdirSync(path.join(dir, 'memory', 'groups', '出差.yaml', '占位'), { recursive: true });
  const before = { scheds: JSON.stringify(store.readSchedules()), props: JSON.stringify(store.readProposals()), cards: JSON.stringify(store.listCards()), idn: JSON.stringify(store.readIdentities()), notices: JSON.stringify(store.readNotices()) };
  assert.throws(() => store.renameCategory('旅遊', '出差'), (e) => e instanceof StoreError && e.code === 'RENAME_FAILED' && e.message.includes('放回'));
  assert.ok(fs.existsSync(path.join(dir, 'workflows', '旅遊', 'a', 'workflow.yaml')), '流程夾回到舊名');
  assert.ok(!fs.existsSync(path.join(dir, 'workflows', '出差')), '新名不留');
  assert.ok(fs.existsSync(path.join(dir, 'memory', 'groups', '旅遊.yaml')), '群組 yaml 還在舊名');
  assert.ok(fs.existsSync(path.join(dir, 'shared', '旅遊', 'index.yaml')), '共用夾沒動');
  assert.equal(JSON.stringify(store.readSchedules()), before.scheds);
  assert.equal(JSON.stringify(store.readProposals()), before.props);
  assert.equal(JSON.stringify(store.listCards()), before.cards);
  assert.equal(JSON.stringify(store.readIdentities()), before.idn);
  assert.equal(JSON.stringify(store.readNotices()), before.notices);
  assert.ok(store.listCategories().includes('旅遊'));
  // 驗證階段：提議檔壞 → CORRUPT，三個目錄都沒搬
  fs.rmSync(path.join(dir, 'memory', 'groups', '出差.yaml'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'proposals', 'queue.yaml'), 'a: [壞掉', 'utf8');
  assert.throws(() => store.renameCategory('旅遊', '出差'), (e) => e instanceof StoreError && e.code === 'CORRUPT');
  assert.ok(fs.existsSync(path.join(dir, 'workflows', '旅遊')) && !fs.existsSync(path.join(dir, 'workflows', '出差')));
  assert.ok(fs.existsSync(path.join(dir, 'memory', 'groups', '旅遊.yaml')) && fs.existsSync(path.join(dir, 'shared', '旅遊')));
});

test('B0 ⑧：舊資料相容——沒有 schedules.json／提議檔／memory/／shared/／trash/／notices.json 時照樣改名，且不會把那些檔建出來', () => {
  const { store, dir } = tmpStore();
  store.writeWorkflow('旅遊', 'a', DEF);
  const moved = store.renameCategory('旅遊', '出差');
  assert.deepEqual(moved, { workflows: 1, schedules: 0, proposals: 0, cards: 0, identities: 0, notices: 0, trash: 0 });
  assert.equal(store.readWorkflow('出差', 'a').name, DEF.name);
  for (const p of ['schedules.json', 'notices.json', 'proposals', 'memory', 'shared', 'trash']) assert.ok(!fs.existsSync(path.join(dir, p)), `${p} 不該被建出來`);
  // 空分類（沒有任何流程）也能改名
  store.createCategory('空的');
  assert.equal(store.renameCategory('空的', '還是空的').workflows, 0);
  assert.ok(store.listCategories().includes('還是空的') && !store.listCategories().includes('空的'));
});

test('B0 ⑨：垃圾桶——改名後 meta.category 跟著改、復原落在新名底下；原分類消失的那筆 restoreTrash 丟 NO_CATEGORY、不新建分類、那筆還在；分類建回來就能復原', () => {
  const { store, dir } = tmpStore();
  store.writeWorkflow('旅遊', 'a', DEF);
  const key = store.trashWorkflow('旅遊', 'a');
  const moved = store.renameCategory('旅遊', '出差');
  assert.equal(moved.trash, 1);
  assert.equal(store.listTrash()[0].category, '出差', '垃圾桶列顯示新名');
  const restored = store.restoreTrash(key);
  assert.equal(restored.category, '出差');
  assert.equal(store.readWorkflow('出差', restored.id).name, DEF.name);
  assert.ok(!fs.existsSync(path.join(dir, 'workflows', '旅遊')), '舊分類沒被復活');
  // 手寫一筆原分類已不存在的
  const key2 = 'zz-消失的-x';
  fs.mkdirSync(path.join(dir, 'trash', key2), { recursive: true });
  fs.writeFileSync(path.join(dir, 'trash', key2, 'workflow.yaml'), 'format: 1\nname: 舊的\nparams: []\nnodes: []\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'trash', key2, 'meta.yaml'), 'category: 消失的\nid: x\nname: 舊的\ntrashed_at: 2026-09-01T00:00:00.000Z\n', 'utf8');
  assert.throws(() => store.restoreTrash(key2),
    (e) => e instanceof StoreError && e.code === 'NO_CATEGORY' && e.message.includes('已經不在了') && e.message.includes('消失的'));
  assert.ok(!fs.existsSync(path.join(dir, 'workflows', '消失的')), '不靜默新建分類');
  assert.deepEqual(store.listTrash().map((t) => t.key), [key2], '那筆還在垃圾桶');
  store.createCategory('消失的');
  assert.deepEqual(store.restoreTrash(key2), { category: '消失的', id: 'x' });
  assert.deepEqual(store.listTrash(), []);
});

test('B0 修正輪：改名版之後十分鐘內的畫布編輯不併入改名版——另記新版、改名版的 note 與 def 一字不動（「共用檔已刪除」那種註記版同理）', () => {
  const { store } = tmpStore();
  store.writeWorkflow('旅遊', 'a', DEF);
  const renamed = { ...DEF, name: '新名' };
  const vRename = store.saveRename('旅遊', 'a', renamed, DEF.name);
  assert.equal(vRename, 2);
  const edited = { ...renamed, nodes: [{ ...DEF.nodes[0], instruction: '做A（畫布改過）' }] };
  const vEdit = store.saveManualEdit('旅遊', 'a', edited);
  assert.equal(vEdit, 3, '改名版不准被併掉');
  const snapRename = store.readVersion('旅遊', 'a', 2);
  assert.equal(snapRename.diff_note, `改名：「${DEF.name}」→「新名」`);
  assert.deepEqual(snapRename.def, renamed, '改名版的 def 還是改名當時那份');
  assert.equal(store.readVersion('旅遊', 'a', 3).diff_note, '手動編輯（畫布／欄位）');
  assert.deepEqual(store.readWorkflow('旅遊', 'a'), edited);
  // 「手動編輯」之間照舊十分鐘合併（既有行為不變）
  const again = { ...edited, nodes: [{ ...edited.nodes[0], instruction: '做A（又改）' }] };
  assert.equal(store.saveManualEdit('旅遊', 'a', again), 3, '手動編輯之間仍合併同版');
  assert.deepEqual(store.listVersions('旅遊', 'a').map((v) => v.diff_note), ['建立', `改名：「${DEF.name}」→「新名」`, '手動編輯（畫布／欄位）']);
});

// ---- 本次上傳暫存區 data/uploads/<token>/<檔名>，開跑時搬進 runs/<rid>/in/ ----
test('排版輪 L11 ②③⑦：暫存上傳——writeUpload 回 token、檔名護欄、readUpload、claimUpload 搬進該趟 in/ 並刪暫存、壞 token 讀不到、sweepUploads 清 24 小時沒用掉的', () => {
  const { store, dir } = tmpStore();
  store.writeWorkflow('旅遊', 'a', DEF);
  for (const bad of ['../x.csv', 'a/b.csv', 'CON.csv', '']) assert.throws(() => store.writeUpload(bad, Buffer.from('x')), (e) => e.code === 'BAD_NAME', bad);
  assert.equal(fs.existsSync(path.join(dir, 'uploads')) ? fs.readdirSync(path.join(dir, 'uploads')).length : 0, 0, '擋下的不落地');
  const up = store.writeUpload('  三月.csv ', Buffer.from('a,b\n1,2'));
  assert.match(up.token, /^[0-9a-f]{24}$/);
  assert.equal(up.name, '三月.csv', '頭尾空白修掉');
  assert.deepEqual({ ...store.readUpload(up.token), path: undefined }, { token: up.token, name: '三月.csv', size: 7, path: undefined });
  assert.ok(store.readUpload(up.token).path.startsWith(path.join(dir, 'uploads', up.token)));
  for (const t of ['..', '../uploads', 'zz', up.token.toUpperCase(), '0'.repeat(24)]) assert.equal(store.readUpload(t), null, t);
  store.writeRun('旅遊', 'a', 'r-1', { run_id: 'r-1', status: 'running', steps: {} });
  assert.equal(store.claimUpload(up.token, '旅遊', 'a', 'r-1'), '三月.csv');
  const moved = path.join(dir, 'workflows', '旅遊', 'a', 'runs', 'r-1', 'in', '三月.csv');
  assert.equal(fs.readFileSync(moved, 'utf8'), 'a,b\n1,2');
  assert.equal(store.runInputPath('旅遊', 'a', 'r-1', '三月.csv'), moved);
  assert.equal(store.runInputPath('旅遊', 'a', 'r-1', '沒有.csv'), null);
  assert.equal(store.readUpload(up.token), null, 'token 用過即刪');
  assert.ok(!fs.existsSync(path.join(dir, 'uploads', up.token)));
  assert.throws(() => store.claimUpload(up.token, '旅遊', 'a', 'r-1'), (e) => e.code === 'NOT_FOUND');
  // 24 小時沒用掉的清掉；新的留著
  const old = store.writeUpload('舊.csv', Buffer.from('1'));
  const fresh = store.writeUpload('新.csv', Buffer.from('2'));
  const past = new Date(Date.now() - 25 * 3600e3);
  fs.utimesSync(path.join(dir, 'uploads', old.token), past, past);
  assert.equal(store.sweepUploads(), 1);
  assert.equal(store.readUpload(old.token), null);
  assert.ok(store.readUpload(fresh.token));
});

// ---- 修：暫存代碼綁定發放的 Workflow；檔名含控制字元（NUL 等）走人話擋下 ----
test('排版輪 L13 附帶①：writeUpload 帶發放對象→readUpload／claimUpload 對象不符＝找不到；不帶對象讀照舊；舊暫存（沒有綁定記號）照舊可用', () => {
  const { store, dir } = tmpStore();
  const up = store.writeUpload('三月.csv', Buffer.from('1,2'), { category: '旅遊', id: 'a' });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'uploads', up.token)).filter((n) => n !== 'owner..json'), ['三月.csv'], '暫存夾只多一個綁定記號');
  assert.equal(store.readUpload(up.token).name, '三月.csv', '綁定記號不會被當成上傳檔');
  assert.equal(store.readUpload(up.token, { category: '旅遊', id: 'a' }).name, '三月.csv');
  assert.equal(store.readUpload(up.token, { category: '旅遊', id: 'b' }), null, '別條 Workflow 拿不到');
  assert.equal(store.readUpload(up.token, { category: '別的', id: 'a' }), null, '別的分類同名 Workflow 也拿不到');
  store.writeRun('旅遊', 'b', 'r-1', { run_id: 'r-1', status: 'running', steps: {} });
  assert.throws(() => store.claimUpload(up.token, '旅遊', 'b', 'r-1'), (e) => e.code === 'NOT_FOUND', '挪用擋下');
  assert.ok(store.readUpload(up.token), '擋下的不刪暫存');
  store.writeRun('旅遊', 'a', 'r-2', { run_id: 'r-2', status: 'running', steps: {} });
  assert.equal(store.claimUpload(up.token, '旅遊', 'a', 'r-2'), '三月.csv');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'workflows', '旅遊', 'a', 'runs', 'r-2', 'in')), ['三月.csv'], '綁定記號不跟著搬進該趟');
  const legacy = store.writeUpload('舊.csv', Buffer.from('1'));
  assert.equal(store.readUpload(legacy.token, { category: '旅遊', id: 'b' }).name, '舊.csv', '沒有綁定記號的舊暫存照舊');
});

// L13b：代碼綁的是「這條 Workflow」，不是它當時所在的分類——移分類／分類改名後照常能用；
// id 不保證跨分類唯一（範例補種只看「範例」分類，移出去的範例下次開機會再種一份同 id），所以不能只比 id，改成搬家時把記號跟著改
test('L13b：移分類、分類改名後綁定記號跟著走——自己照常能用、舊位置同 id 的別條拿不到；uploadProblem 分清「別條的」與「找不到」', () => {
  const { store } = tmpStore();
  store.writeWorkflow('旅遊', 'a', DEF);
  store.writeWorkflow('旅遊', 'b', DEF);
  const up = store.writeUpload('三月.csv', Buffer.from('1,2'), { category: '旅遊', id: 'a' });
  const other = store.writeUpload('別條.csv', Buffer.from('1'), { category: '旅遊', id: 'b' });
  store.moveWorkflow('旅遊', 'a', '行銷');
  assert.equal(store.readUpload(up.token, { category: '行銷', id: 'a' })?.name, '三月.csv', '移分類後自己照常能用');
  assert.equal(store.readUpload(other.token, { category: '旅遊', id: 'b' })?.name, '別條.csv', '沒搬的那條記號不動');
  store.writeWorkflow('旅遊', 'a', DEF); // 舊位置又冒出同 id 的另一條（範例補種的情況）
  assert.equal(store.readUpload(up.token, { category: '旅遊', id: 'a' }), null, '舊位置同 id 的別條拿不到');
  store.renameCategory('行銷', '行銷部');
  assert.equal(store.readUpload(up.token, { category: '行銷部', id: 'a' })?.name, '三月.csv', '分類改名後照常能用');
  assert.equal(store.readUpload(up.token, { category: '行銷', id: 'a' }), null, '舊分類名不再認');
  assert.equal(store.readUpload(other.token, { category: '旅遊', id: 'b' })?.name, '別條.csv', '別的分類的記號不動');
  // 人話分兩種
  assert.equal(store.uploadProblem(up.token, { category: '行銷部', id: 'a' }), null);
  assert.match(store.uploadProblem(up.token, { category: '旅遊', id: 'b' }), /別條 Workflow/);
  assert.match(store.uploadProblem('0'.repeat(24), { category: '旅遊', id: 'b' }), /找不到了（可能超過 24 小時被清掉）/);
  store.writeRun('旅遊', 'b', 'r-1', { run_id: 'r-1', status: 'running', steps: {} });
  assert.throws(() => store.claimUpload(up.token, '旅遊', 'b', 'r-1'), (e) => e.code === 'NOT_FOUND' && /別條 Workflow/.test(e.message), '挪用的訊息講「別條」');
  store.writeRun('行銷部', 'a', 'r-2', { run_id: 'r-2', status: 'running', steps: {} });
  assert.equal(store.claimUpload(up.token, '行銷部', 'a', 'r-2'), '三月.csv');
});

test('排版輪 L13 附帶②：safeFileName 擋控制字元（NUL、換行、tab 等）＝BAD_NAME 人話；一般中文與空白照收', () => {
  const ctl = (c) => String.fromCharCode(c);
  for (const bad of [`a${ctl(0)}.pdf`, `a${ctl(10)}.csv`, `a${ctl(9)}.txt`, `${ctl(31)}.md`, `x${ctl(127)}.csv`]) {
    assert.throws(() => safeFileName(bad), (e) => e.code === 'BAD_NAME' && e.message.includes('看不見的控制字元'), JSON.stringify(bad));
  }
  assert.equal(safeFileName('三月 報表.csv'), '三月 報表.csv');
  const { store, dir } = tmpStore();
  assert.throws(() => store.writeUpload(`a${ctl(0)}.pdf`, Buffer.from('x')), (e) => e.code === 'BAD_NAME' && !e.message.includes(dir));
});

// ── 2026-09-18  ──────────────────────────────────────────────

test('搬分類：握著「分類/id」這把鍵的東西要跟著走（排程／提議／未讀通知）', () => {
  const { store } = tmpStore();
  store.writeWorkflow('行銷', 'wf-a', { format: 1, name: '週報', nodes: [] });
  store.writeSchedules([
    { id: 's1', workflow_id: '行銷/wf-a', enabled: true },
    { id: 's2', workflow_id: '行銷/wf-b', enabled: true }, // 別條流程的排程不准動
  ]);
  store.writeProposals([{ id: 'p1', workflow: { category: '行銷', id: 'wf-a' }, status: 'pending' }]);
  store.writeNotices([
    { id: 'n1', status: 'unread', run: { category: '行銷', id: 'wf-a', run_id: 'r1' } },
    { id: 'n2', status: 'done', run: { category: '行銷', id: 'wf-a', run_id: 'r0' } },
  ]);

  const counts = store.moveWorkflow('行銷', 'wf-a', '業務');

  assert.equal(store.readWorkflow('業務', 'wf-a').name, '週報');
  const scheds = store.readSchedules();
  assert.equal(scheds.find((s) => s.id === 's1').workflow_id, '業務/wf-a', '排程沒跟著走＝每次到點都 start_failed');
  assert.equal(scheds.find((s) => s.id === 's2').workflow_id, '行銷/wf-b', '別條流程的排程不准動');
  assert.equal(store.readProposals()[0].workflow.category, '業務');
  const nt = store.readNotices();
  assert.equal(nt.find((x) => x.id === 'n1').run.category, '業務', '未讀通知要指得到現況');
  assert.equal(nt.find((x) => x.id === 'n2').run.category, '行銷', '已處理的留痕不動');
  assert.deepEqual(counts, { schedules: 1, proposals: 1, cards: 0, notices: 1 });
});

test('搬分類：目的地已有同名就整個不動（不做半套）', () => {
  const { store } = tmpStore();
  store.writeWorkflow('行銷', 'wf-a', { format: 1, name: '週報', nodes: [] });
  store.writeWorkflow('業務', 'wf-a', { format: 1, name: '別人', nodes: [] });
  store.writeSchedules([{ id: 's1', workflow_id: '行銷/wf-a', enabled: true }]);
  assert.throws(() => store.moveWorkflow('行銷', 'wf-a', '業務'), (e) => e.code === 'CONFLICT');
  assert.equal(store.readSchedules()[0].workflow_id, '行銷/wf-a', '擋下來時排程要原封不動');
  assert.equal(store.readWorkflow('行銷', 'wf-a').name, '週報');
});

test('US-107 狀態點：lastRunOf 回每條流程自己的最近一趟——沒跑過＝null、正常＝{run_id, status}、那一趟 run.yaml 讀不到＝{run_id, status:unreadable}；不受跨流程趟數上限影響', () => {
  const { store, dir } = tmpStore();
  store.writeWorkflow('範例', 'wf1', DEF);
  store.writeWorkflow('範例', 'wf2', DEF);
  store.writeWorkflow('範例', 'wf3', DEF);
  assert.equal(store.lastRunOf('範例', 'wf1'), null, '沒跑過＝null');
  store.writeRun('範例', 'wf1', 'r-20260810-090000-aaaa', { status: 'done' });
  store.writeRun('範例', 'wf1', 'r-20260901-100000-bbbb', { status: 'paused' });
  assert.deepEqual(store.lastRunOf('範例', 'wf1'), { run_id: 'r-20260901-100000-bbbb', status: 'paused' }, '只看最新那一趟（runId 字典序＝時間序）');
  store.writeRun('範例', 'wf2', 'r-20260902-100000-cccc', { status: 'done' });
  fs.writeFileSync(path.join(dir, 'workflows', '範例', 'wf2', 'runs', 'r-20260902-100000-cccc', 'run.yaml'), 'status: [壞掉', 'utf8');
  assert.deepEqual(store.lastRunOf('範例', 'wf2'), { run_id: 'r-20260902-100000-cccc', status: 'unreadable' }, '讀不到＝unreadable，不冒充停在半路');
  store.writeRun('範例', 'wf3', 'r-20260903-100000-dddd', { steps: {} });
  assert.deepEqual(store.lastRunOf('範例', 'wf3'), { run_id: 'r-20260903-100000-dddd', status: 'unreadable' }, '讀得開但沒有狀態＝也算讀不到');
  // 60 趟擠在別條流程，冷門那條仍讀得到自己的最近一趟（不再有 50 趟上限）
  store.writeWorkflow('範例', 'cold', DEF);
  store.writeRun('範例', 'cold', 'r-20250101-000000-0000', { status: 'done' });
  for (let i = 0; i < 60; i++) store.writeRun('範例', 'wf1', `r-20261001-${String(i).padStart(6, '0')}-hot`, { status: 'done' });
  assert.deepEqual(store.lastRunOf('範例', 'cold'), { run_id: 'r-20250101-000000-0000', status: 'done' });
});

test('數字檔約定（US-110）：listArtifacts 列本趟產出夾時排除工人的腳本 .js 與數字檔 數字-*.json——成品、.md、其他 json 照列（排序不變）', () => {
  const { store } = tmpStore();
  store.writeWorkflow('範例', 'wf1', DEF);
  const dir = store.runOutDir('範例', 'wf1', 'r-1');
  for (const f of ['報告.docx', '整理清單.md', '數字-a.json', '數字-算數字.json', 'gen.js', 'verify.js', '結果.json', '數字.json']) fs.writeFileSync(path.join(dir, f), 'x');
  assert.deepEqual(store.listArtifacts('範例', 'wf1', 'r-1'), ['報告.docx', '整理清單.md', '結果.json', '數字.json'].sort());
  assert.ok(store.readArtifact('範例', 'wf1', 'r-1', '數字-a.json'), '按名字還是拿得到（清單不列、不等於檔不在）');
});

// ===== L065 清單效能：lastRunOf 只 readdir 一次、由新往舊找第一個有 run.yaml 的就停 =====
test('L065 清單效能：lastRunOf 最新那幾趟資料夾沒有 run.yaml（沒寫完／被清掉）時回上一趟有 run.yaml 的；listRuns 照舊只列有 run.yaml 的趟、排序不變', () => {
  const { store, dir } = tmpStore();
  store.writeWorkflow('範例', 'wf1', DEF);
  const runsDir = path.join(dir, 'workflows', '範例', 'wf1', 'runs');
  store.writeRun('範例', 'wf1', 'r-20260810-090000-aaaa', { status: 'done' });
  store.writeRun('範例', 'wf1', 'r-20260901-100000-bbbb', { status: 'paused' });
  // 兩個更新的趟：一個空夾、一個只有 out/ 沒有 run.yaml
  fs.mkdirSync(path.join(runsDir, 'r-20260902-100000-cccc'), { recursive: true });
  fs.mkdirSync(path.join(runsDir, 'r-20260903-100000-dddd', 'out'), { recursive: true });
  assert.deepEqual(store.lastRunOf('範例', 'wf1'), { run_id: 'r-20260901-100000-bbbb', status: 'paused' }, '跳過沒 run.yaml 的最新趟，回上一趟');
  assert.deepEqual(store.listRuns('範例', 'wf1'), ['r-20260810-090000-aaaa', 'r-20260901-100000-bbbb'], 'listRuns 行為不變：只列有 run.yaml 的、字典序');
  // 全部趟都沒 run.yaml ＝ 等於沒跑過
  fs.rmSync(path.join(runsDir, 'r-20260810-090000-aaaa', 'run.yaml'));
  fs.rmSync(path.join(runsDir, 'r-20260901-100000-bbbb', 'run.yaml'));
  assert.equal(store.lastRunOf('範例', 'wf1'), null, '一趟 run.yaml 都沒有＝null');
  assert.deepEqual(store.listRuns('範例', 'wf1'), []);
  // runs/ 夾根本不存在
  assert.equal(store.lastRunOf('範例', 'wf-none'), null);
});

test('L065 清單效能：lastRunOf 的檔案系統呼叫次數不隨趟數線性成長（100 趟時 ≤ 8 次，且與 10 趟時相差 ≤ 2 次）', () => {
  const { store } = tmpStore();
  store.writeWorkflow('範例', 'wf1', DEF);
  // store.js 與本檔拿到的是同一個 node:fs 物件，包一層計數即可（結束後還原）
  const countFsCalls = (fn) => {
    const names = ['existsSync', 'readdirSync', 'statSync', 'readFileSync', 'accessSync', 'openSync'];
    const orig = Object.fromEntries(names.map((n) => [n, fs[n]]));
    let calls = 0;
    for (const n of names) fs[n] = (...a) => { calls += 1; return orig[n](...a); };
    try { fn(); } finally { for (const n of names) fs[n] = orig[n]; }
    return calls;
  };
  const writeRuns = (from, to) => { for (let i = from; i < to; i++) store.writeRun('範例', 'wf1', `r-20260901-${String(i).padStart(6, '0')}-x`, { status: 'done' }); };
  writeRuns(0, 10);
  const at10 = countFsCalls(() => assert.equal(store.lastRunOf('範例', 'wf1').run_id, 'r-20260901-000009-x'));
  writeRuns(10, 100);
  const at100 = countFsCalls(() => assert.equal(store.lastRunOf('範例', 'wf1').run_id, 'r-20260901-000099-x'));
  assert.equal(store.listRuns('範例', 'wf1').length, 100, 'listRuns 仍回全部 100 趟');
  assert.ok(at100 <= 8, `100 趟時 lastRunOf 只該摸常數次檔案系統，實測 ${at100} 次`);
  assert.ok(at100 - at10 <= 2, `趟數從 10 到 100，呼叫次數不該跟著長：10 趟 ${at10} 次、100 趟 ${at100} 次`);
});

// ---- Codex 2026-09-25 審查第一批（恢復既有承諾）：B02 同名上傳、B06 垃圾桶復原順序、B09 詞典合併被讀取復原 ----
test('B02：同名上傳兩份都保留——claimUpload 落盤名碰撞（不分大小寫）自動改名 -2、-3，先傳的原封不動、回實際檔名；呼叫端指定落盤名也照樣防撞', () => {
  const { store, dir } = tmpStore();
  store.writeWorkflow('旅遊', 'a', DEF);
  store.writeRun('旅遊', 'a', 'r-1', { run_id: 'r-1', status: 'running', steps: {} });
  const t1 = store.writeUpload('source.csv', Buffer.from('FIRST')).token;
  const t2 = store.writeUpload('source.csv', Buffer.from('SECOND')).token;
  const t3 = store.writeUpload('SOURCE.csv', Buffer.from('THIRD')).token;
  assert.equal(store.claimUpload(t1, '旅遊', 'a', 'r-1'), 'source.csv');
  assert.equal(store.claimUpload(t2, '旅遊', 'a', 'r-1'), 'source-2.csv', '第二份改名，不蓋第一份');
  assert.equal(store.claimUpload(t3, '旅遊', 'a', 'r-1'), 'SOURCE-3.csv', '大小寫不同也算撞名（NTFS 是同一個檔）；改名保留上傳者的大小寫');
  const inDir = path.join(dir, 'workflows', '旅遊', 'a', 'runs', 'r-1', 'in');
  assert.deepEqual(fs.readdirSync(inDir).sort(), ['SOURCE-3.csv', 'source-2.csv', 'source.csv']);
  assert.equal(fs.readFileSync(path.join(inDir, 'source.csv'), 'utf8'), 'FIRST', '先傳的內容不動');
  assert.equal(fs.readFileSync(path.join(inDir, 'source-2.csv'), 'utf8'), 'SECOND');
  assert.equal(fs.readFileSync(path.join(inDir, 'SOURCE-3.csv'), 'utf8'), 'THIRD');
  assert.equal(store.runInputPath('旅遊', 'a', 'r-1', 'source-2.csv'), path.join(inDir, 'source-2.csv'));
  for (const t of [t1, t2, t3]) assert.equal(store.readUpload(t), null, '暫存照舊用過即刪');
  // 呼叫端先算好落盤名（開跑前要寫進 run.yaml）→ 照用；跟磁碟上既有的撞到仍再改名
  const t4 = store.writeUpload('other.csv', Buffer.from('FOURTH')).token;
  assert.equal(store.claimUpload(t4, '旅遊', 'a', 'r-1', 'Source.csv'), 'Source-4.csv');
  assert.equal(fs.readFileSync(path.join(inDir, 'Source-4.csv'), 'utf8'), 'FOURTH');
  const t5 = store.writeUpload('other.csv', Buffer.from('FIFTH')).token;
  assert.equal(store.claimUpload(t5, '旅遊', 'a', 'r-1', '改名.csv'), '改名.csv', '沒撞就照指定的名字');
  // 純函式：改名規則
  assert.equal(dedupeFileName('a.csv', []), 'a.csv');
  assert.equal(dedupeFileName('a.csv', ['A.CSV']), 'a-2.csv');
  assert.equal(dedupeFileName('a.csv', ['a.csv', 'a-2.csv']), 'a-3.csv');
  assert.equal(dedupeFileName('README', ['readme']), 'README-2');
  assert.equal(dedupeFileName('.env', ['.env']), '.env-2');
  assert.equal(dedupeFileName('a.tar.gz', ['a.tar.gz']), 'a.tar-2.gz');
});

test('B02：共用檔 Case.txt／case.txt 兩份都在——大小寫不同視為撞名自動改名、先傳的不動、清單記實際檔名；一模一樣的名字照舊 DUP', () => {
  const { store } = tmpStore();
  const a = store.addShared('_company', { name: 'Case.txt', kind: 'ref', buf: Buffer.from('ORIGINAL'), text: null });
  const b = store.addShared('_company', { name: 'case.txt', kind: 'ref', buf: Buffer.from('REPLACEMENT'), text: null });
  assert.equal(a.name, 'Case.txt');
  assert.equal(b.name, 'case-2.txt', '回給呼叫端的是實際落盤名');
  assert.deepEqual(store.readSharedIndex('_company').files.map((f) => f.name), ['Case.txt', 'case-2.txt']);
  assert.equal(fs.readFileSync(store.sharedFilePath('_company', 'Case.txt'), 'utf8'), 'ORIGINAL', '先傳的沒被蓋');
  assert.equal(fs.readFileSync(store.sharedFilePath('_company', 'case-2.txt'), 'utf8'), 'REPLACEMENT');
  assert.equal(b.chars, 'REPLACEMENT'.length, 'txt 字數照算');
  assert.throws(() => store.addShared('_company', { name: 'Case.txt', kind: 'ref', buf: Buffer.from('x'), text: null }), (e) => e instanceof StoreError && e.code === 'DUP', '一模一樣照舊 DUP（換版＝先刪再傳）');
  store.deleteShared('_company', 'case-2.txt');
  assert.deepEqual(store.readSharedIndex('_company').files.map((f) => f.name), ['Case.txt']);
  assert.equal(fs.readFileSync(store.sharedFilePath('_company', 'Case.txt'), 'utf8'), 'ORIGINAL', '刪第二份不影響第一份');
});

test('B09：手動把出廠欄位併進另一欄後，readDict 不再把它補回來——已是任一欄位同義詞的出廠名視為已存在；真正缺的出廠條照補', () => {
  const { store } = tmpStore();
  const merged = mergeFields(store.readDict(), [], '格式', '語氣');
  assert.equal(merged.dict.fields.length, 9);
  store.writeDict(merged.dict);
  const back = store.readDict();
  assert.equal(back.fields.length, 9, '不能又冒出獨立的「語氣」');
  assert.ok(!back.fields.some((f) => f.name === '語氣'));
  assert.ok(back.fields.find((f) => f.name === '格式').synonyms.includes('語氣'), '「語氣」只活在「格式」的同義詞裡');
  // 舊七條檔（缺新三條、且沒有誰把它們當同義詞）升級路徑不變：補三條、被合併的照樣不補
  store.writeDict({ ...back, fields: back.fields.filter((f) => !['型態', '分段', '範圍'].includes(f.name)) });
  const upgraded = store.readDict();
  assert.deepEqual(upgraded.fields.map((f) => f.name).filter((n) => ['型態', '分段', '範圍', '語氣'].includes(n)).sort(), ['分段', '型態', '範圍']);
  assert.equal(upgraded.fields.length, 9);
});

test('B06：垃圾桶復原先搬再刪 meta——搬失敗 meta 還在、垃圾桶清單仍列得到、本體沒少、可以重試；重試成功後復原位置沒有 meta.yaml 殘留', () => {
  const { store, dir } = tmpStore();
  store.writeWorkflow('工作', 'wf1', DEF);
  const key = store.trashWorkflow('工作', 'wf1');
  const src = path.join(dir, 'trash', key);
  const originalRename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (String(from) === src) { const e = new Error('simulated sharing violation'); e.code = 'EPERM'; throw e; }
    return originalRename.call(this, from, to);
  };
  try {
    assert.throws(() => store.restoreTrash(key), (e) => e.code === 'EPERM');
  } finally { fs.renameSync = originalRename; }
  assert.ok(fs.existsSync(path.join(src, 'meta.yaml')), 'meta 還在');
  assert.ok(fs.existsSync(path.join(src, 'workflow.yaml')), '本體還在');
  assert.ok(store.listTrash().some((t) => t.key === key), '垃圾桶還看得到，可以重試');
  assert.deepEqual(store.listWorkflows(), [], '沒有半吊子復原');
  const restored = store.restoreTrash(key);
  assert.equal(restored.id, 'wf1');
  assert.ok(!fs.existsSync(path.join(dir, 'workflows', '工作', 'wf1', 'meta.yaml')), '復原後沒有 meta.yaml 殘留');
  assert.deepEqual(store.readWorkflow('工作', 'wf1'), DEF);
  assert.deepEqual(store.listTrash(), []);
});
