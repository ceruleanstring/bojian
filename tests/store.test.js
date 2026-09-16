import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, StoreError, DEFAULT_SETTINGS } from '../src/store.js';

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

// ===== 記憶輪 M1a：兩本帳（卡）＋詞典＋群組圈＋身分＋設定＋記憶垃圾桶＋備份 =====

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

test('詞典：缺檔回出廠七條（version 1、語氣含口吻、created_at 有值）；寫後讀回；壞檔明確報錯', () => {
  const { store, dir } = tmpStore();
  const dict = store.readDict();
  assert.equal(dict.version, 1);
  assert.equal(dict.fields.length, 7);
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
  assert.deepEqual(s.exec, { auto_makeup: false, remind_leads: [], web: true });
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

// ---- 移植合併輪 U1a：共用檔儲存（data/shared/<scope>/{index.yaml,files/}）----
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
