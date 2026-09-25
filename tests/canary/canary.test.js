// 金絲雀「量尺」的單元測試（不打 AI、不起分身、不碰 results/）——量的是 score.mjs 的生死判定與 q10 的 pass 條件本身。
// 出處：Codex 2026-09-25 審查 E1（缺趟／空集報活）、E2（q10 查核沒跑、成品夾假話仍 pass），工單 CHG-2026-09-25-金絲雀量尺-…-E1-E2。
// 假結果夾一律開在 %TEMP%（mkdtemp），跑完刪；q10 的 truth 用 generate 造（固定種子，與真跑同一份）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scoreDir } from './score.mjs';
import { generate, score, CHECKED_STEPS } from './q10/question.mjs';
import { BOJIAN_REPORT_20260924_2144 } from './q10/fixtures.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-canary-test-'));
after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 留著也無妨 */ } });

const mkdir = (name) => { const d = path.join(tmpRoot, name); fs.mkdirSync(d, { recursive: true }); return d; };
const writeJson = (dir, name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
const readSummary = (dir) => ({
  json: JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')),
  firstLine: fs.readFileSync(path.join(dir, 'summary.md'), 'utf8').split('\n')[0],
});
// 一趟合格的結果列（structural 或 compare 都能用）
const row = (q, arm, rep, extra = {}) => ({
  q, title: '測試', kind: 'structural', arm, rep, status: 'done', weighted: 1000, ms: 1000,
  interventions: [], score: { pass: true, metrics: { primary: 1, errors: 0 }, misses: [], notes: [] }, ...extra,
});

describe('E1 score.mjs：缺趟／空集／壞檔不得報活', () => {
  test('空集：沒有任何結果 → alive:false，Markdown 第一行也說無結果', () => {
    const dir = mkdir('empty');
    scoreDir(dir);
    const { json, firstLine } = readSummary(dir);
    assert.equal(json.alive, false);
    assert.match(firstLine, /無結果/);
  });

  test('宣告 q6／q7 各兩趟、只有 q6 一趟 → alive:false 並列出缺的三格', () => {
    const dir = mkdir('partial');
    writeJson(dir, 'run-info.json', { questions: ['q6', 'q7'], arms: ['bojian'], reps: 2 });
    writeJson(dir, 'q6-bojian-1.json', row('q6', 'bojian', 1));
    scoreDir(dir);
    const { json, firstLine } = readSummary(dir);
    assert.equal(json.alive, false);
    assert.deepEqual(json.complete.missing, ['q6-bojian-2', 'q7-bojian-1', 'q7-bojian-2']);
    assert.match(firstLine, /^金絲雀：死/);
    for (const cell of ['q6-bojian-2', 'q7-bojian-1', 'q7-bojian-2']) assert.ok(firstLine.includes(cell), `第一行要列出 ${cell}：${firstLine}`);
  });

  test('壞 JSON 要列名，不能靜默跳過；那一格同時算缺', () => {
    const dir = mkdir('broken');
    writeJson(dir, 'run-info.json', { questions: ['q6'], arms: ['bojian'], reps: 1 });
    fs.writeFileSync(path.join(dir, 'q6-bojian-1.json'), '{"q":"q6", 壞掉的');
    scoreDir(dir);
    const { json, firstLine } = readSummary(dir);
    assert.equal(json.alive, false);
    assert.deepEqual(json.complete.broken, ['q6-bojian-1.json']);
    assert.deepEqual(json.complete.missing, ['q6-bojian-1']);
    assert.ok(firstLine.includes('q6-bojian-1.json'), `第一行要點名壞檔：${firstLine}`);
  });

  test('compare 題只宣告 bojian 一邊但 cc 沒跑 → 照舊判死（比不了），且缺格清單只按宣告的邊算', () => {
    const dir = mkdir('compare-one-arm');
    writeJson(dir, 'run-info.json', { questions: ['q1'], arms: ['bojian'], reps: 1 });
    writeJson(dir, 'q1-bojian-1.json', row('q1', 'bojian', 1, { kind: 'compare' }));
    scoreDir(dir);
    const { json } = readSummary(dir);
    assert.equal(json.alive, false);
    assert.deepEqual(json.complete.missing, []); // 宣告只有 bojian，沒缺格；死是因為 compare 題比不了
    assert.ok(json.questions[0].reasons.some((r) => r.includes('比不了')));
  });

  test('正向：宣告的矩陣全到齊且每題都過 → alive:true（structural 一題、compare 一題）', () => {
    const dir = mkdir('full');
    writeJson(dir, 'run-info.json', { questions: ['q1', 'q6'], arms: ['bojian', 'cc'], reps: 2 });
    for (const rep of [1, 2]) {
      writeJson(dir, `q1-bojian-${rep}.json`, row('q1', 'bojian', rep, { kind: 'compare' }));
      writeJson(dir, `q1-cc-${rep}.json`, row('q1', 'cc', rep, { kind: 'compare' }));
      writeJson(dir, `q6-bojian-${rep}.json`, row('q6', 'bojian', rep)); // structural 只跑剝繭，cc 那格不算缺
    }
    scoreDir(dir);
    const { json, firstLine } = readSummary(dir);
    assert.equal(json.alive, true);
    assert.deepEqual(json.complete.missing, []);
    assert.deepEqual(json.complete.broken, []);
    assert.match(firstLine, /^金絲雀：活/);
  });

  test('CLI 退出碼：判死（缺趟）exit 2、活 exit 0、找不到結果夾 exit 1', () => {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'score.mjs');
    const run = (dir) => spawnSync(process.execPath, [cli, dir], { encoding: 'utf8', windowsHide: true });
    const dead = mkdir('cli-dead');
    writeJson(dead, 'run-info.json', { questions: ['q6'], arms: ['bojian'], reps: 2 });
    writeJson(dead, 'q6-bojian-1.json', row('q6', 'bojian', 1));
    const rd = run(dead);
    assert.equal(rd.status, 2, rd.stderr);
    assert.match(rd.stdout.split('\n')[0], /^金絲雀：死/);
    const alive = mkdir('cli-alive');
    writeJson(alive, 'run-info.json', { questions: ['q6'], arms: ['bojian'], reps: 1 });
    writeJson(alive, 'q6-bojian-1.json', row('q6', 'bojian', 1));
    const ra = run(alive);
    assert.equal(ra.status, 0, ra.stderr);
    assert.match(ra.stdout.split('\n')[0], /^金絲雀：活/);
    assert.equal(run(path.join(tmpRoot, 'no-such-dir')).status, 1);
  });

  test('沒有 run-info.json → 核對不了矩陣，不得 alive，理由寫明', () => {
    const dir = mkdir('no-run-info');
    writeJson(dir, 'q6-bojian-1.json', row('q6', 'bojian', 1));
    scoreDir(dir);
    const { json, firstLine } = readSummary(dir);
    assert.equal(json.alive, false);
    assert.ok(json.complete.reasons.some((r) => r.includes('run-info.json')));
    assert.ok(firstLine.includes('run-info.json'), firstLine);
  });
});

describe('E2 q10：查核沒跑、流程沒 done、成品夾假話都不得 pass', () => {
  let truth;
  const passCheck = { status: 'pass', blocks: [], flags: [], missing: [], items: [], summary: '', attempts: 1 };
  const fullSteps = () => Object.fromEntries(CHECKED_STEPS.map((nid) => [nid, { status: 'done', output: 'x', check: { ...passCheck } }]));
  const good = () => ({ finalText: BOJIAN_REPORT_20260924_2144, truth, steps: fullSteps(), drive: { interventions: [] }, runStatus: 'done' });

  before(async () => { ({ truth } = await generate(mkdir('q10-data'))); });

  test('預期會查核的步驟＝流程裡的三個 AI 步', () => {
    assert.deepEqual(CHECKED_STEPS, ['numbers', 'points', 'report']);
  });

  test('正向：13 項全中、三步都有查核紀錄、status done、沒假話、沒叫人 → pass:true', async () => {
    const s = await score(good());
    assert.equal(s.metrics.keys_ok, 13);
    assert.equal(s.metrics.false_claims, 0);
    assert.equal(s.metrics.steps_checked, 3);
    assert.equal(s.pass, true, s.notes.join(' | '));
    assert.deepEqual(s.reasons, []);
  });

  test('steps={}（查核全沒跑）→ pass:false，reason 點名哪幾步沒有查核紀錄', async () => {
    const s = await score({ ...good(), steps: {} });
    assert.equal(s.pass, false);
    assert.ok(s.reasons.some((r) => r.includes('查核沒跑') && r.includes('numbers') && r.includes('points') && r.includes('report')), s.reasons.join(' | '));
  });

  test('只有一步缺查核紀錄 → 也不過，reason 只點名那一步', async () => {
    const steps = fullSteps(); steps.points.check = null;
    const s = await score({ ...good(), steps });
    assert.equal(s.pass, false);
    const r = s.reasons.find((x) => x.includes('查核沒跑'));
    assert.ok(r && r.includes('points') && !r.includes('numbers') && !r.includes('report'), s.reasons.join(' | '));
  });

  test('status 不是 done（failed）→ pass:false，reason 寫明流程沒跑完', async () => {
    const s = await score({ ...good(), runStatus: 'failed' });
    assert.equal(s.pass, false);
    assert.ok(s.reasons.some((r) => r.includes('沒跑完') && r.includes('failed')), s.reasons.join(' | '));
  });

  test('沒給 runStatus（舊呼叫形狀）→ 同樣不得 pass', async () => {
    const { runStatus, ...rest } = good();
    const s = await score(rest);
    assert.equal(s.pass, false);
    assert.ok(s.reasons.some((r) => r.includes('沒跑完')), s.reasons.join(' | '));
  });

  test('成品夾一句查無實據的假話 → pass:false，reason 寫明假話幾句', async () => {
    const s = await score({ ...good(), finalText: BOJIAN_REPORT_20260924_2144 + '\n8月退貨集中在防潑水後背包。' });
    assert.ok(s.metrics.false_claims > 0);
    assert.equal(s.pass, false);
    assert.ok(s.reasons.some((r) => r.includes('假話')), s.reasons.join(' | '));
  });

  test('Codex 探針原案：steps={}＋runStatus failed → pass:false（原本回 true）', async () => {
    const s = await score({ finalText: BOJIAN_REPORT_20260924_2144, truth, steps: {}, drive: { interventions: [] }, runStatus: 'failed' });
    assert.equal(s.pass, false);
    assert.equal(s.metrics.steps_checked, 0);
  });

  test('既有條件沒被拿掉：要人出手 1 次仍不過', async () => {
    const s = await score({ ...good(), drive: { interventions: [{ node: 'report', act: 'data-accept', status: 'waiting_data' }] } });
    assert.equal(s.pass, false);
    assert.equal(s.metrics.interventions, 1);
  });
});
