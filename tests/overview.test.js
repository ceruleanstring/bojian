// 總覽規格單（US-104／ADR-007）：一趟跑完多發一次呼叫拿重點句＋圖表規格。
// 真 AI 不進測試——全部用假回傳打。把關的七件事各一題：數字對不上、kind 認不得、≤2 筆不給 bar、
// HTML 被跳脫、cite 對不上丟句、設定關掉零呼叫、解不出 JSON 不擋收工。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createRunner } from '../src/runner.js';
import {
  sanitizeOverview, numberIndex, hasNumber, buildStats, buildOverviewPrompt, parseOverview, overviewEnabled, OVERVIEW_RULES,
} from '../src/overview.js';

// 假 adapter：只回錄呼叫與注入總覽回覆（監工與查核在測試流程裡都關掉，不會被問到）
function fakeAdapter(overviewReply = '{"summary":[],"charts":[]}') {
  const outputs = {};
  return {
    calls: [],
    outputs,
    setOverview(x) { overviewReply = x; },
    setOutput(nodeId, text) { outputs[nodeId] = text; },
    renderPrompt: (f) => `PROMPT:${f.nodeId}`,
    async complete({ prompt, meta }) {
      this.calls.push({ prompt, meta });
      if (meta?.kind === 'overview') {
        if (typeof overviewReply === 'function') return overviewReply(meta, prompt);
        return String(overviewReply ?? '');
      }
      return '';
    },
    async executeNode({ nodeId }) {
      this.calls.push({ nodeId });
      return outputs[nodeId] ?? `產出:${nodeId}`;
    },
  };
}

// 兩步直線；查核與監工關掉——這張單只驗總覽那一次呼叫
const DEF = {
  format: 1,
  name: '月報流程',
  params: [],
  check: { enabled: false },
  supervisor: { enabled: false },
  nodes: [
    { id: 'a', title: '抓數字', executor: 'ai', stop_point: 'never', instruction: '抓數字', next: ['b'] },
    { id: 'b', title: '寫結論', executor: 'ai', stop_point: 'never', instruction: '寫結論', next: [] },
  ],
};

const MONTHS = '一月 12,000 元、二月 9,500 元、三月 15,250 元';
const AVG = '全月平均 12,250 元，三月比平均高出 24.5%';

function setup(overviewReply) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-overview-'));
  const store = createStore(dir);
  store.writeWorkflow('測試', 'wf', DEF);
  const adapter = fakeAdapter(overviewReply);
  adapter.setOutput('a', MONTHS);
  adapter.setOutput('b', AVG);
  const runner = createRunner({ store, adapter });
  return { dir, store, adapter, runner };
}

async function runOnce(ctx) {
  const run = ctx.runner.startRun('測試', 'wf', {});
  await ctx.runner.runUntilPause('測試', 'wf', run.run_id);
  return ctx.store.readRun('測試', 'wf', run.run_id);
}

const overviewCalls = (adapter) => adapter.calls.filter((c) => c.meta?.kind === 'overview');

const BAR = {
  kind: 'bar',
  title: '月營收',
  series: [{ label: '一月', value: 12000 }, { label: '二月', value: 9500 }, { label: '三月', value: 15250 }],
};

// ---- 一趟跑完真的會拿到規格單 ----

test('一趟跑完：發一次總覽呼叫，規格單與頁尾數字存進這趟卷宗', async () => {
  const ctx = setup(JSON.stringify({
    summary: [{ text: '三個月營收逐月變動', cite: 'a' }, { text: '三月高於全月平均', cite: 'b' }],
    charts: [{ ...BAR, note: '單位：元', baseline: { label: '全月平均', value: 12250 } }],
  }));
  const r = await runOnce(ctx);
  assert.equal(r.status, 'done');
  assert.equal(overviewCalls(ctx.adapter).length, 1); // 一趟只多一次呼叫
  assert.deepEqual(r.overview.summary, [
    { text: '三個月營收逐月變動', cite: 'a' },
    { text: '三月高於全月平均', cite: 'b' },
  ]);
  assert.equal(r.overview.charts.length, 1);
  assert.equal(r.overview.charts[0].kind, 'bar');
  assert.deepEqual(r.overview.charts[0].baseline, { label: '全月平均', value: 12250 });
  assert.deepEqual(r.overview.dropped, []);
  // stats 由程式算，不問 AI
  assert.equal(r.overview.stats.steps_total, 2);
  assert.equal(r.overview.stats.steps_passed, 2);
  assert.equal(r.overview.stats.check_blocked, 0);
  assert.ok(Number.isFinite(r.overview.stats.duration_ms));
  // 送出去的指示全文進卷宗
  assert.ok(ctx.store.readPromptRecord('測試', 'wf', r.run_id, '_overview.txt').includes(OVERVIEW_RULES.slice(0, 20)));
});

// ---- ① 數字對不上原文就不畫 ----

test('數字對不上：整張圖不畫，理由進 dropped', async () => {
  const ctx = setup(JSON.stringify({
    summary: [],
    charts: [{ ...BAR, series: [...BAR.series.slice(0, 2), { label: '三月', value: 99999 }] }],
  }));
  const r = await runOnce(ctx);
  assert.deepEqual(r.overview.charts, []);
  assert.equal(r.overview.dropped.length, 1);
  assert.match(r.overview.dropped[0], /月營收/);
  assert.match(r.overview.dropped[0], /找不到一模一樣/);
});

test('數字對不上：總覽自己算出來的合計也不准畫', () => {
  const out = sanitizeOverview({
    charts: [{ kind: 'kpi', title: '三個月合計', series: [{ label: '合計', value: 36750 }] }],
  }, { nodeIds: ['a'], sourceText: MONTHS });
  assert.deepEqual(out.charts, []);
  assert.equal(out.dropped.length, 1);
});

test('數字比對：容許千分位逗號與百分號，去尾零的小數算同一個', () => {
  const index = numberIndex('營收 12,000 元，成長 24.5%，毛利率 30.50%');
  assert.equal(hasNumber(index, 12000), true); // 千分位
  assert.equal(hasNumber(index, 24.5), true); // 百分號
  assert.equal(hasNumber(index, 30.5), true); // 30.50 與 30.5 是同一個數字
  assert.equal(hasNumber(index, 12), false); // 不是原文寫過的數字
  assert.equal(hasNumber(index, '12000'), false); // 字串不是數字，不替 AI 轉型
});

test('數字比對：日期裡的開頭零不算寫過那個數字', () => {
  assert.equal(hasNumber(numberIndex('2026-09-05 出貨'), 5), false);
});

// 連字號不是負號：原文裡的電話、頁碼、編號不准被讀成負數——不然 AI 憑空生一個負數洞見就騙得過逐字比對
test('數字比對：連字號接在數字或英數字後面時不算負號', () => {
  const phone = numberIndex('客服專線 02-2345');
  assert.equal(hasNumber(phone, -2345), false);
  assert.equal(hasNumber(phone, 2345), true); // 2345 本身確實逐字寫在原文裡
  const pages = numberIndex('頁碼 12-15');
  assert.equal(hasNumber(pages, -15), false);
  assert.equal(hasNumber(pages, 15), true);
  const sku = numberIndex('訂單編號 A-99');
  assert.equal(hasNumber(sku, -99), false);
  assert.equal(hasNumber(sku, 99), true);
  const range = numberIndex('區間 1,200-1,500 元');
  assert.equal(hasNumber(range, -1500), false);
  assert.equal(hasNumber(range, 1500), true);
});

// 中文前綴也要擋：\w 只認 ASCII，剝繭的成品幾乎全是中文，「忠-15」「甲-99」這種店號型號才是最常出現的寫法
test('數字比對：中文字後面的連字號也不算負號', () => {
  const phone = numberIndex('客服專線-2345');
  assert.equal(hasNumber(phone, -2345), false);
  assert.equal(hasNumber(phone, 2345), true);
  const sku = numberIndex('商品編號甲-99');
  assert.equal(hasNumber(sku, -99), false);
  assert.equal(hasNumber(sku, 99), true);
  const shop = numberIndex('分店代號忠-15');
  assert.equal(hasNumber(shop, -15), false);
  assert.equal(hasNumber(shop, 15), true);
});

test('數字比對：真的寫成負數時照樣算找得到', () => {
  assert.equal(hasNumber(numberIndex('本月毛利 -15,000 元'), -15000), true);
  assert.equal(hasNumber(numberIndex('溫差（-3.5 度）'), -3.5), true);
  assert.equal(hasNumber(numberIndex('-5 度以下停工'), -5), true); // 句首
});

test('連字號當負號：AI 拿中文店號變出來的負數，整張圖不畫', async () => {
  const ctx = setup(JSON.stringify({
    summary: [],
    charts: [{ kind: 'kpi', title: '分店淨損', series: [{ label: '忠孝店', value: -15 }] }],
  }));
  ctx.adapter.setOutput('a', '分店代號忠-15，本月來客 300 人');
  const r = await runOnce(ctx);
  assert.deepEqual(r.overview.charts, []);
  assert.match(r.overview.dropped[0], /找不到一模一樣/);
});

test('連字號當負號：AI 拿電話號碼變出來的負數，整張圖不畫', async () => {
  const ctx = setup(JSON.stringify({
    summary: [],
    charts: [{ kind: 'kpi', title: '客訴淨值', series: [{ label: '淨值', value: -2345 }] }],
  }));
  ctx.adapter.setOutput('a', '客服專線 02-2345，本月客訴 3 件');
  const r = await runOnce(ctx);
  assert.deepEqual(r.overview.charts, []);
  assert.match(r.overview.dropped[0], /找不到一模一樣/);
});

test('比較基準對不上原文：整張圖不畫', () => {
  const out = sanitizeOverview({
    charts: [{ ...BAR, baseline: { label: '去年同期', value: 8888 } }],
  }, { nodeIds: ['a'], sourceText: MONTHS });
  assert.deepEqual(out.charts, []);
  assert.match(out.dropped[0], /比較基準/);
});

// ---- ② kind 認不得就不畫 ----

test('kind 亂寫：不猜版型，整張圖不畫並記原因', async () => {
  const ctx = setup(JSON.stringify({
    summary: [],
    charts: [{ ...BAR, kind: 'pie', title: '佔比' }, { ...BAR, kind: '堆疊長條', title: '疊起來' }],
  }));
  const r = await runOnce(ctx);
  assert.deepEqual(r.overview.charts, []);
  assert.equal(r.overview.dropped.length, 2);
  assert.match(r.overview.dropped[0], /認不得/);
  assert.match(r.overview.dropped[1], /認不得/);
});

// ---- ③ 出圖門檻：≤2 筆不給 bar／line ----

test('只有兩筆數字：bar 與 line 都不畫，kpi 照畫', () => {
  const src = '一月 12,000 元、二月 9,500 元';
  const two = [{ label: '一月', value: 12000 }, { label: '二月', value: 9500 }];
  const out = sanitizeOverview({
    charts: [
      { kind: 'bar', title: '兩個月', series: two },
      { kind: 'line', title: '兩個月趨勢', series: two },
      { kind: 'kpi', title: '一月營收', series: [{ label: '一月', value: 12000 }] },
    ],
  }, { nodeIds: ['a'], sourceText: src });
  assert.equal(out.charts.length, 1);
  assert.equal(out.charts[0].kind, 'kpi');
  assert.equal(out.dropped.length, 2);
  assert.match(out.dropped[0], /三筆以上/);
});

// ---- 單位：規格單只收數字，單位另外用一個純文字欄位帶，畫面才不會把 13.28% 顯示成 13.28 ----

test('unit：照原文的單位留著，沒寫就不留這個鍵', async () => {
  const ctx = setup(JSON.stringify({
    summary: [],
    charts: [
      { kind: 'kpi', title: '三月增幅', unit: '%', series: [{ label: '三月', value: 24.5 }] },
      { kind: 'kpi', title: '三月營收', unit: '', series: [{ label: '三月', value: 15250 }] },
    ],
  }));
  const r = await runOnce(ctx);
  assert.equal(r.overview.charts[0].unit, '%');
  assert.equal('unit' in r.overview.charts[1], false);
});

test('unit：超過 6 字截掉，標記一樣跳脫，數字比對不受它影響', () => {
  const out = sanitizeOverview({
    charts: [
      { kind: 'kpi', title: '長單位', unit: '新台幣元整每個月', series: [{ label: '一月', value: 12000 }] },
      { kind: 'kpi', title: '壞單位', unit: '<script>x</script>', series: [{ label: '二月', value: 9500 }] },
    ],
  }, { nodeIds: ['a'], sourceText: MONTHS });
  assert.equal(out.charts[0].unit, '新台幣元整每');
  assert.ok(!out.charts[1].unit.includes('<script>'));
  assert.deepEqual(out.dropped, []); // 單位寫壞不影響畫不畫，只有數字對不上才擋
});

test('滿三筆才畫：三筆的 bar 放行', () => {
  const out = sanitizeOverview({ charts: [BAR] }, { nodeIds: ['a'], sourceText: MONTHS });
  assert.equal(out.charts.length, 1);
  assert.equal(out.charts[0].series.length, 3);
  assert.deepEqual(out.dropped, []);
});

// ---- ④ HTML／SVG／script 當純文字跳脫 ----

test('回傳裡的 HTML 標記一律跳脫成純文字', async () => {
  const ctx = setup(JSON.stringify({
    summary: [{ text: '<b>重點</b><script>alert(1)</script>', cite: 'a' }],
    charts: [{
      kind: 'kpi',
      title: '<svg onload=alert(1)>',
      note: '<img src=x onerror=alert(1)>',
      series: [{ label: '<script>x</script>一月', value: 12000 }],
    }],
  }));
  const r = await runOnce(ctx);
  const blob = JSON.stringify(r.overview);
  assert.ok(!blob.includes('<script>'));
  assert.ok(!blob.includes('<svg'));
  assert.ok(!blob.includes('<img'));
  assert.equal(r.overview.summary[0].text, '&lt;b&gt;重點&lt;/b&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(r.overview.charts[0].title, '&lt;svg onload=alert(1)&gt;');
  assert.match(r.overview.charts[0].series[0].label, /^&lt;script&gt;/);
});

test('被擋掉的圖，理由裡的標記也跳脫', () => {
  const out = sanitizeOverview({
    charts: [{ kind: '<script>evil</script>', title: '<b>標題</b>', series: [{ label: 'x', value: 1 }] }],
  }, { nodeIds: ['a'], sourceText: '1' });
  assert.ok(!out.dropped[0].includes('<script>'));
  assert.ok(!out.dropped[0].includes('<b>'));
});

// ---- ⑤ cite 對不上就丟那一句 ----

test('cite 指到不存在的步驟：丟那一句，其餘照留', async () => {
  const ctx = setup(JSON.stringify({
    summary: [
      { text: '留下來的重點', cite: 'a' },
      { text: '指到不存在的步驟', cite: 'zzz' },
      { text: '出處空白', cite: '' },
      { text: '也留下來', cite: 'b' },
    ],
    charts: [],
  }));
  const r = await runOnce(ctx);
  assert.deepEqual(r.overview.summary.map((s) => s.cite), ['a', 'b']);
});

test('重點句超過五句只留前五句，每句 200 字內', () => {
  const long = 'x'.repeat(500);
  const out = sanitizeOverview({
    summary: Array.from({ length: 8 }, () => ({ text: long, cite: 'a' })),
  }, { nodeIds: ['a'], sourceText: '' });
  assert.equal(out.summary.length, 5);
  assert.equal(out.summary[0].text.length, 200);
});

// ---- ⑥ 設定關掉＝零呼叫 ----

test('overview_enabled=false：整趟不發總覽呼叫、不存規格單', async () => {
  const ctx = setup('{"summary":[{"text":"不該被問到","cite":"a"}],"charts":[]}');
  ctx.store.writeSettings({ exec: { overview_enabled: false } });
  const r = await runOnce(ctx);
  assert.equal(r.status, 'done');
  assert.equal(overviewCalls(ctx.adapter).length, 0);
  assert.equal(r.overview, undefined);
});

test('設定沒有這個鍵＝開著（舊設定檔照樣出總覽）', () => {
  assert.equal(overviewEnabled({}), true);
  assert.equal(overviewEnabled({ exec: {} }), true);
  assert.equal(overviewEnabled(null), true);
  assert.equal(overviewEnabled({ exec: { overview_enabled: false } }), false);
  assert.equal(overviewEnabled({ overview_enabled: false }), false);
});

// ---- ⑦ 失敗不擋收工、不重試 ----

test('解不出 JSON：不擋收工、不重試第二次，存一筆「這趟沒有總覽」與原因', async () => {
  const ctx = setup('我看不懂你要什麼');
  const r = await runOnce(ctx);
  assert.equal(r.status, 'done'); // 收工照舊
  assert.equal(overviewCalls(ctx.adapter).length, 1); // 只發一次，不重試
  assert.match(r.overview.fail_note, /^這趟沒有總覽/);
  assert.deepEqual(r.overview.summary, []);
  assert.deepEqual(r.overview.charts, []);
  assert.equal(r.overview.stats.steps_total, 2); // 頁尾那行照樣算得出來
});

test('呼叫本身炸掉：一樣不擋收工、不重試', async () => {
  const ctx = setup(() => { throw new Error('連不上 Claude（測試注入）'); });
  const r = await runOnce(ctx);
  assert.equal(r.status, 'done');
  assert.equal(overviewCalls(ctx.adapter).length, 1);
  assert.match(r.overview.fail_note, /連不上 Claude/);
});

test('交了兩份不一樣的規格單：當作沒寫成，不靠位置猜', async () => {
  const ctx = setup('{"summary":[{"text":"甲","cite":"a"}],"charts":[]}\n{"summary":[{"text":"乙","cite":"b"}],"charts":[]}');
  const r = await runOnce(ctx);
  assert.match(r.overview.fail_note, /分不出哪份是真的/);
});

// ---- 其他把關 ----

test('沒有任何成品：不發呼叫，只留空的規格單與頁尾數字', async () => {
  const ctx = setup('{"summary":[{"text":"不該被問到","cite":"a"}],"charts":[]}');
  ctx.adapter.setOutput('a', '');
  ctx.adapter.setOutput('b', '');
  const r = await runOnce(ctx);
  assert.equal(overviewCalls(ctx.adapter).length, 0);
  assert.deepEqual(r.overview.summary, []);
  assert.equal(r.overview.stats.steps_total, 2);
});

test('series 超過 12 筆：只留前 12 筆', () => {
  const src = Array.from({ length: 20 }, (_, i) => `第${i + 1}項 ${i + 1}00 元`).join('、');
  const series = Array.from({ length: 20 }, (_, i) => ({ label: `第${i + 1}項`, value: (i + 1) * 100 }));
  const out = sanitizeOverview({ charts: [{ kind: 'bar', title: '很多項', series }] }, { nodeIds: ['a'], sourceText: src });
  assert.equal(out.charts[0].series.length, 12);
});

test('空的 series：不畫，記一句原因', () => {
  const out = sanitizeOverview({ charts: [{ kind: 'kpi', title: '沒數字', series: [] }] }, { nodeIds: ['a'], sourceText: '' });
  assert.deepEqual(out.charts, []);
  assert.match(out.dropped[0], /沒有可用的數字/);
});

test('prompt 帶得出可用的步驟 id 與成品全文', () => {
  const p = buildOverviewPrompt({ def: DEF, outputs: [{ id: 'a', title: '抓數字', text: MONTHS }] });
  assert.ok(p.startsWith(OVERVIEW_RULES));
  assert.ok(p.includes('- a：抓數字'));
  assert.ok(p.includes(MONTHS));
});

test('parseOverview：圍欄與前後廢話裡挑得出規格單', () => {
  const v = parseOverview('好的：\n```json\n{"summary":[{"text":"甲","cite":"a"}],"charts":[]}\n```\n以上。');
  assert.equal(v.summary.length, 1);
});

test('buildStats：跳過的支不算一步，查核攔下的次數逐次算', () => {
  const s = buildStats({
    started_at: '2026-09-23T10:00:00.000Z',
    finished_at: '2026-09-23T10:12:08.000Z',
    def: {
      nodes: [
        { id: 'a', title: 'A', executor: 'ai' },
        { id: 'fk', title: '同時做', kind: 'fork' },
        { id: 'b', title: 'B', executor: 'ai' },
        { id: 'c', title: 'C', executor: 'ai' },
      ],
    },
    steps: {
      a: { status: 'done', attempts: [{ check: { status: 'blocked' } }, { check: { status: 'pass' } }] },
      fk: { status: 'done' },
      b: { status: 'skipped' },
      c: { status: 'done', check: { status: 'blocked' } },
    },
  });
  assert.deepEqual(s, { steps_total: 2, steps_passed: 2, check_blocked: 2, recheck_unresolved: 0, duration_ms: 728000 });
});

test('buildStats（US-112）：recheck_unresolved＝重寫後仍有數字沒出處的步數——只數 check.status=redone 且 recheck_blocks 非空的步；空陣列、欄位缺席（舊趟）、非陣列、跳過的步都不算', () => {
  const s = buildStats({
    started_at: '2026-09-24T10:00:00.000Z',
    finished_at: '2026-09-24T10:01:00.000Z',
    def: { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }] },
    steps: {
      a: { status: 'done', check: { status: 'redone', recheck_blocks: [{ kind: 'number-unsourced', number: '15.9%' }] }, attempts: [{ check: { status: 'blocked' } }, { check: { status: 'redone' } }] },
      b: { status: 'done', check: { status: 'redone', recheck_blocks: [] }, attempts: [{ check: { status: 'blocked' } }, { check: { status: 'redone' } }] },
      c: { status: 'done', check: { status: 'redone' }, attempts: [{ check: { status: 'blocked' } }, { check: { status: 'redone' } }] },
      d: { status: 'done', check: { status: 'redone', recheck_blocks: 'x' } },
      e: { status: 'skipped', check: { status: 'redone', recheck_blocks: [{ number: '1' }] } },
      f: { status: 'done', check: { status: 'pass', recheck_blocks: [{ number: '2' }] } },
    },
  });
  assert.equal(s.recheck_unresolved, 1, '只有 a 算');
  assert.equal(s.check_blocked, 3, '攔下次數照舊逐次算');
  assert.equal(buildStats({}).recheck_unresolved, 0, '舊趟／空趟回 0');
});
