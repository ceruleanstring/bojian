// q8 自驗（＝工單 verify）：不打 Claude、不打 8787、不動 bojian/data。
//   node bojian/tests/canary/q8/selfcheck.mjs      exit 0＝過
// 驗五件事：
//   1. generate 到暫存夾，每次產出一模一樣；五種陷阱真的都埋進 CSV 裡
//   2. 用第三種寫法（自己切逗號、自己抓月份，不用 lib/csv.mjs 也不用 truth.mjs）把 CSV 讀回來，算出的關鍵數字＝truth
//   3. 逐筆手算前 5 張 8 月完成訂單：各列狀態一致、金額＝數量×單價、都在 truth 名單裡
//   4. 錯數字不撞正確數字（含「萬」寫法）；照 truth 寫的假成品 pass、trap_hits 0（千分位與「萬」兩種寫法都試）
//   5. 故意算錯的假成品：五種陷阱各至少命中一條 trap_hit、pass 為假；空成品不過
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as q8 from './question.mjs';

let failed = 0; let passed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ok   ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（${JSON.stringify(a)} vs ${JSON.stringify(b)}）`);

// ---- 1. 造資料 ----
console.log('1. generate 到暫存夾');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-q8-selfcheck-'));
const gen = await q8.generate(dir);
const T = gen.truth;
const csvPath = gen.files[0].path;
ok(gen.files.length === 1 && gen.files[0].name === q8.FILE && fs.existsSync(csvPath), `寫出 ${q8.FILE}`);
ok(fs.existsSync(path.join(dir, 'truth.json')), '寫出 truth.json');
const csv1 = fs.readFileSync(csvPath, 'utf8');
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-q8-selfcheck-'));
await q8.generate(dir2);
ok(fs.readFileSync(path.join(dir2, q8.FILE), 'utf8') === csv1, '固定種子：第二次產出逐位元相同');
ok(q8.kind === 'compare' && typeof q8.ccPrompt === 'function', 'kind=compare 且有 ccPrompt');
const def = q8.flowDef({ files: gen.files, truth: T });
ok(def.check?.enabled === false && def.supervisor?.enabled === false, 'flowDef：查核與監工關');
ok(def.nodes.every((n) => n.model_tier === 'balanced') && def.permissions?.files === true, 'flowDef：全部 balanced、可讀檔');
ok(q8.ccPrompt().includes('report.md') && q8.ccPrompt().includes(q8.STEP1), 'ccPrompt：同一句交代、成品寫 report.md');

// 五種陷阱都在
const S = T.trap_stats;
ok(S.multi_row_orders >= 20, `① 多列訂單 ${S.multi_row_orders} 張`);
ok(S.statuses['已取消'] >= 3 && S.statuses['已退款'] >= 3, `② 已取消 ${S.statuses['已取消']}、已退款 ${S.statuses['已退款']}`);
ok(S.formats.iso > 0 && S.formats.slash > 0 && S.formats.zh > 0, `③ 三種日期寫法 ${JSON.stringify(S.formats)}`);
ok(S.aug31_late >= 2 && S.sep1_early >= 2, `③ 邊界：8/31 23:xx ${S.aug31_late} 張、9/1 00:xx ${S.sep1_early} 張`);
ok(/,"\d{1,3},\d{3}",/.test(csv1), '④ CSV 裡真的有 "12,800" 這種帶引號千分位');
ok(S.comma_rows >= 10, `④ 千分位列 ${S.comma_rows}`);
ok(S.blank_rows === 2 && /,,完成\r?\n/.test(csv1) && /,－,完成\r?\n/.test(csv1), '⑤ 一列空白＋一列「－」（都是完成單）');

// ---- 2. 第三種讀法 ----
console.log('2. 第三種讀法對 truth');
function split3(line) { // 跟 lib/csv.mjs 不同寫法：用正規式吃「引號欄或無逗號欄」
  const out = []; const re = /"([^"]*)"|([^,]*)/g; let m;
  let pos = 0;
  while (pos <= line.length) {
    re.lastIndex = pos; m = re.exec(line);
    out.push(m[1] ?? m[2] ?? '');
    pos = re.lastIndex + 1;
    if (re.lastIndex === line.length) break;
  }
  return out;
}
function monthDay3(s) { // 只抓月、日、時，不管格式
  let m;
  if ((m = /^2026[-/](\d{1,2})[-/](\d{1,2}) (\d{1,2}):/.exec(s))) return { m: +m[1], d: +m[2], hh: +m[3] };
  if ((m = /^(\d{1,2})月(\d{1,2})日 (\d{1,2}):/.exec(s))) return { m: +m[1], d: +m[2], hh: +m[3] };
  throw new Error(`第三種讀法認不出「${s}」`);
}
const amount3 = (s, qty, price) => { const t = s.trim(); return t === '' || t === '－' ? qty * price : parseInt(t.replace(/,/g, ''), 10); };
const lines = csv1.split('\n').filter((l) => l.trim());
const H = split3(lines[0]);
eq(H, ['訂單編號', '下單時間', '通路', '商品', '數量', '單價', '金額', '狀態'], '欄名');
const R = lines.slice(1).map((l) => { const c = split3(l); return { id: c[0], when: monthDay3(c[1]), ch: c[2], name: c[3], qty: +c[4], price: +c[5], amt: amount3(c[6], +c[4], +c[5]), status: c[7] }; });
eq(R.length, T.rows, '列數');
const byOrder = new Map();
for (const r of R) { if (!byOrder.has(r.id)) byOrder.set(r.id, []); byOrder.get(r.id).push(r); }
const O = [...byOrder.entries()].map(([id, rs]) => ({ id, rs, m: rs[0].when.m, status: rs[0].status, ch: rs[0].ch, total: rs.reduce((a, r) => a + r.amt, 0) }));
eq(O.length, T.orders, '訂單張數');
const augDone3 = O.filter((o) => o.m === 8 && o.status === '完成');
const rev3 = augDone3.reduce((a, o) => a + o.total, 0);
eq(augDone3.length, T.aug_orders, '8 月完成訂單數');
eq(rev3, T.aug_revenue, '8 月營收');
eq(Math.round(rev3 / augDone3.length), T.aov, '客單價');
const jul3 = O.filter((o) => o.m === 7 && o.status === '完成').reduce((a, o) => a + o.total, 0);
eq(jul3, T.jul_revenue, '7 月營收');
eq(Math.round((rev3 - jul3) / jul3 * 1000) / 10, T.mom_pct, '月增減%');
const prod3 = {}; for (const o of augDone3) for (const r of o.rs) prod3[r.name] = (prod3[r.name] ?? 0) + r.amt;
eq(Object.entries(prod3).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, rev]) => ({ name, rev })), T.top3, '前三名商品');
const ch3 = {}; for (const o of augDone3) ch3[o.ch] = (ch3[o.ch] ?? 0) + o.total;
eq(Object.fromEntries(Object.keys(T.channel_rev).map((c) => [c, ch3[c] ?? 0])), T.channel_rev, '各通路營收');
eq(Object.fromEntries(Object.keys(T.channel_share).map((c) => [c, Math.round((ch3[c] ?? 0) / rev3 * 1000) / 10])), T.channel_share, '各通路佔比');
const ref3 = O.filter((o) => o.m === 8 && o.status === '已退款');
eq(ref3.length, T.aug_refund_orders, '8 月退款張數');
eq(ref3.reduce((a, o) => a + o.total, 0), T.aug_refund_amount, '8 月退款金額');
eq(Object.values(T.channel_share).reduce((a, b) => a + b, 0) > 99.5 && Object.values(T.channel_share).reduce((a, b) => a + b, 0) < 100.5, true, '通路佔比加總≈100');
ok(q8.keysOf(T).length >= 10, `關鍵數字 ${q8.keysOf(T).length} 項（≥10）`);
// 邊界：8/31 23:xx 在 8 月裡、9/1 00:xx 不在
const late = O.filter((o) => o.m === 8 && o.rs[0].when.d === 31 && o.rs[0].when.hh === 23 && o.status === '完成');
ok(late.length >= 1 && late.every((o) => T.aug_done_order_ids.includes(o.id)), `8/31 23:xx 完成單 ${late.length} 張都算進 8 月`);
const sep = O.filter((o) => o.m === 9);
ok(sep.length >= 2 && sep.every((o) => !T.aug_done_order_ids.includes(o.id)), `9/1 00:xx ${sep.length} 張都不算 8 月`);

// ---- 3. 逐筆手算前 5 張 8 月完成訂單 ----
console.log('3. 逐筆手算前 5 張 8 月完成訂單');
for (const o of augDone3.slice(0, 5)) {
  const consistent = o.rs.every((r) => r.status === '完成' && r.ch === o.ch && r.when.m === 8 && r.when.d === o.rs[0].when.d);
  const byQty = o.rs.reduce((a, r) => a + r.qty * r.price, 0);
  ok(consistent && byQty === o.total && T.aug_done_order_ids.includes(o.id), `${o.id}：${o.rs.length} 列、金額 ${o.total} ＝ Σ數量×單價 ${byQty}、在 truth 名單`);
}

// ---- 4. 錯數字不撞正確數字；照 truth 寫的假成品要 pass ----
console.log('4. 錯數字 vs 正確數字；好成品');
const decoys = T.decoys ?? [];
ok(decoys.length >= 8 && new Set(decoys.map((d) => d.trap)).size === 5, `錯數字 ${decoys.length} 條、涵蓋五種陷阱`);
const truthNums = [T.aug_orders, T.aug_revenue, T.aov, T.jul_revenue, ...T.top3.map((p) => p.rev), ...Object.values(T.channel_rev), T.aug_refund_orders, T.aug_refund_amount];
ok(decoys.every((d) => !truthNums.includes(d.value)), '沒有錯數字等於任何正確數字');
const comma = (n) => n.toLocaleString('en-US');
const wan = (n) => `${Math.round(n / 1000) / 10} 萬`;
const goodReport = (money) => `# 8 月銷售月報
總結：8 月完成訂單 ${T.aug_orders} 張，營收 ${money(T.aug_revenue)} 元，客單價 ${money(T.aov)} 元；7 月營收 ${money(T.jul_revenue)} 元，月增減 ${T.mom_pct}%。
| 項目 | 數字 |
|---|---|
${T.top3.map((p, i) => `| 第 ${i + 1} 名 ${p.name} | ${money(p.rev)} |`).join('\n')}
${Object.entries(T.channel_rev).map(([c, v]) => `| ${c} | ${money(v)}（${T.channel_share[c]}%） |`).join('\n')}
| 退款 | ${T.aug_refund_orders} 張，${money(T.aug_refund_amount)} 元 |
重點：資料裡日期寫法混用、有幾筆金額空白，已依數量×單價補上。下月建議：盯退款。`;
for (const [label, money] of [['千分位寫法', comma], ['「萬」寫法', (n) => (n >= 10000 ? wan(n) : comma(n))]]) {
  const s = await q8.score({ arm: 'selfcheck', finalText: goodReport(money), artifacts: [], steps: {}, prompts: [], truth: T });
  ok(s.pass === true && s.metrics.trap_hits === 0 && s.misses.length === 0 && s.metrics.primary === s.metrics.keys_total && s.metrics.errors === 0,
    `好成品（${label}）pass、trap_hits 0、${s.metrics.primary}/${s.metrics.keys_total} 全中${s.misses.length ? '——漏：' + s.misses.join('、') : ''}`);
}

// ---- 5. 故意算錯的假成品 ----
console.log('5. 壞成品');
const D = Object.fromEntries(decoys.map((d) => [d.key, d.value]));
const badReport = `# 8 月銷售月報
總結：8 月完成訂單 ${D.orders_as_rows} 張，營收 ${comma(D.rev_incl_refund)} 元，客單價 ${comma(D.aov_by_rows)} 元；7 月營收 ${comma(T.jul_revenue)} 元。
另一種算法營收為 ${comma(D.rev_with_sep1)} 元；只認標準日期是 ${comma(D.rev_no_zh)} 元；若不含千分位那幾筆為 ${comma(D.rev_no_comma)} 元；略過空白金額為 ${comma(D.rev_no_blank)} 元。
退款 ${D.refund_as_rows} 筆。`;
const bad = await q8.score({ arm: 'selfcheck', finalText: badReport, artifacts: [], steps: {}, prompts: [], truth: T });
const hitTraps = new Set(decoys.filter((d) => bad.metrics.traps.includes(d.label)).map((d) => d.trap));
ok(bad.pass === false, '壞成品 pass=false');
ok(bad.metrics.trap_hits >= 5 && hitTraps.size === 5, `壞成品 trap_hits ${bad.metrics.trap_hits} 條，五種陷阱各至少一條（${[...hitTraps].sort().join('')}）`);
ok(bad.metrics.errors === bad.misses.length && bad.metrics.errors === (bad.metrics.keys_total - bad.metrics.keys_ok) + bad.metrics.trap_hits, 'errors＝沒命中＋trap_hit');
// 每種陷阱單獨出現也抓得到
for (const d of decoys) {
  const txt = d.type === 'num' ? `8 月營收 ${comma(d.value)} 元` : d.type === 'countUnit' ? `退款 ${d.value} 筆` : `8 月完成訂單數 ${d.value}`;
  const s = await q8.score({ arm: 'selfcheck', finalText: txt, artifacts: [], steps: {}, prompts: [], truth: T });
  ok(s.metrics.traps.includes(d.label), `單獨出現「${d.label}」（${d.value}）→ trap_hit`);
}
const empty = await q8.score({ arm: 'selfcheck', finalText: '', artifacts: [], steps: {}, prompts: [], truth: T });
ok(empty.pass === false && empty.metrics.primary === 0 && empty.notes.includes('成品是空的'), '空成品不過');
// 只漏一項也不過（pass＝全中）
const s1 = await q8.score({ arm: 'selfcheck', finalText: goodReport(comma).replace(comma(T.aug_refund_amount), '0'), artifacts: [], steps: {}, prompts: [], truth: T });
ok(s1.pass === false && s1.misses.length === 1 && s1.metrics.trap_hits === 0, '漏一項關鍵數字＝不過');

for (const d of [dir, dir2]) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${failed ? 'FAIL' : 'PASS'}：${passed} 過、${failed} 不過`);
process.exit(failed ? 1 : 0);
