// q9 自檢：不打 Claude、不打 8787、不動 bojian/data。資料寫到 %TEMP%，跑完刪。
// 驗三件事：(1) 四個異常真的埋進 CSV（用 lib/csv 讀回、獨立重算，不信 generate 回傳的 rows）；
//          (2) 兩次 generate 產出逐位元相同；(3) 計分器對假成品的判定：全寫＝4/4、寫兩個＋編一個＝2/4・誤報 1，另加幾個邊界成品。
// exit 0＝全過；任何一條不過印出哪條，exit 1。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCsv } from '../lib/csv.mjs';
import * as q from './question.mjs';
import { BOJIAN_REPORT_20260924, CC_REPORT_20260924 } from './fixtures.mjs';

const fails = [];
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}`); fails.push(msg); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-canary-q9-selfcheck-'));
try {
  // ---- (1) 造資料，讀回 CSV 獨立驗 ----
  console.log('1. generate → 讀回 CSV 驗四個異常');
  const gen = await q.generate(tmp);
  const csvPath = gen.files[0].path;
  const rows = readCsv(csvPath).map((r) => ({ ...r, qty: Number(r['數量']), price: Number(r['單價']), amt: Number(r['金額']) }));
  const T = gen.truth; const A = T.anomalies;
  check(fs.existsSync(path.join(tmp, 'truth.json')), 'truth.json 落地');
  check(rows.length >= 1500 && rows.length <= 3000, `筆數 ${rows.length} 在 1,500～3,000 之間`);
  check(rows.length === T.rows, `truth.rows（${T.rows}）＝CSV 筆數`);
  check(fs.readFileSync(csvPath, 'utf8').split(/\r?\n/)[0] === q.HEADERS.join(','), '欄位＝HEADERS');
  const monthOf = (r) => Number(r['日期'].slice(5, 7));
  const sum = (xs) => xs.reduce((a, r) => a + r.amt, 0);

  // ① 類別最後一月合計 0、前兩個月都 > 0
  const Z = A.zero_category;
  const zc = (m) => rows.filter((r) => r['商品類別'] === Z.category && monthOf(r) === m);
  check(zc(8).length === 0 && sum(zc(8)) === 0, `① ${Z.category} 8 月 0 筆、合計 0`);
  check(zc(6).length > 20 && zc(7).length > 20 && sum(zc(6)) > 0 && sum(zc(7)) > 0, `① ${Z.category} 6 月 ${zc(6).length} 筆、7 月 ${zc(7).length} 筆都正常`);
  check(Object.keys(q.CATEGORIES).filter((c) => c !== Z.category).every((c) => rows.some((r) => r['商品類別'] === c && monthOf(r) === 8)), '① 其他類別 8 月都有資料（歸零只有一個類別）');

  // ② 缺週那七天一筆都沒有；其他每一天都有資料（缺口只有那一週）
  const W = A.missing_week;
  const inWeek = rows.filter((r) => r['日期'] >= W.start && r['日期'] <= W.end);
  check(inWeek.length === 0, `② ${W.start}～${W.end} 一筆都沒有`);
  check(W.days.length === 7 && new Date(`${W.start}T00:00:00Z`).getUTCDay() === 1 && new Date(`${W.end}T00:00:00Z`).getUTCDay() === 0, '② 缺週是週一到週日整整七天');
  const allDays = [];
  for (const [m, n] of [[6, 30], [7, 31], [8, 31]]) for (let d = 1; d <= n; d++) allDays.push(`2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  const haveDay = new Set(rows.map((r) => r['日期']));
  const emptyDays = allDays.filter((d) => !haveDay.has(d));
  check(emptyDays.length === 7 && emptyDays.every((d) => W.days.includes(d)), `② 三個月裡沒資料的日子只有那七天（實際 ${emptyDays.length} 天）`);
  check(T.weekly_orders[W.start] === 0, '② truth.weekly_orders 那週＝0');

  // ③ 同一客戶同日 6 張一模一樣；其他任何簽名都只出現一次
  const D = A.duplicate_orders;
  const sigOf = (r) => [r['客戶編號'], r['日期'], r['通路'], r['商品類別'], r['商品'], r.qty, r.price, r.amt].join('|');
  const groups = new Map();
  for (const r of rows) { const s = sigOf(r); groups.set(s, [...(groups.get(s) ?? []), r]); }
  const multi = [...groups.values()].filter((g) => g.length > 1);
  check(multi.length === 1 && multi[0].length === 6, `③ 一模一樣的單只有一組、且正好 6 張（實際 ${multi.length} 組）`);
  const g6 = multi[0] ?? [];
  check(g6.every((r) => r['客戶編號'] === D.customer && r['日期'] === D.date && r['商品'] === D.product), `③ 那組是 ${D.customer} 在 ${D.date} 買 ${D.product}`);
  check(D.count === 6 && D.order_ids.length === 6 && D.order_ids.every((oid) => g6.some((r) => r['訂單編號'] === oid)), '③ truth 的 6 個訂單編號都在 CSV 裡');
  check(new Set(g6.map((r) => r['訂單編號'])).size === 6, '③ 6 張單的訂單編號各不相同');

  // ④ 負數只有一筆、金額 -58,000、訂單編號對得上
  const G = A.negative_amount;
  const negs = rows.filter((r) => r.amt < 0);
  check(negs.length === 1 && negs[0].amt === -58000 && negs[0]['訂單編號'] === G.order_id, `④ 負數金額只有一筆、${G.order_id} 金額 -58,000`);
  check(rows.filter((r) => r.price < 0).length === 1, '④ 單價為負的也只有那一筆');
  check(rows.every((r) => r.qty >= 1 && r.qty <= 3), '其餘欄位正常：數量都在 1～3');

  // 四個異常彼此不重疊
  check(!W.days.includes(D.date) && !W.days.includes(G.date), '不重疊：③④ 的日期不在缺週');
  check(D.category !== Z.category && G.category !== Z.category, '不重疊：③④ 的商品不在歸零類別');
  check(D.customer !== G.customer && D.date !== G.date, '不重疊：③④ 不同客戶、不同天');
  check(g6.every((r) => r.amt > 0), '不重疊：重複單金額為正');

  // truth 的數字對得上 CSV
  check([6, 7, 8].every((m) => T.month_revenue[m] === sum(rows.filter((r) => monthOf(r) === m))), 'truth.month_revenue＝CSV 重算');
  check([6, 7, 8].every((m) => T.month_orders[m] === rows.filter((r) => monthOf(r) === m).length), 'truth.month_orders＝CSV 重算');
  check(['zero_category', 'missing_week', 'duplicate_orders', 'negative_amount'].every((k) => typeof A[k].hit_rule === 'string' && A[k].hit_rule.length > 10) && typeof T.false_alarm_rule === 'string', 'truth 帶四條命中規則＋誤報規則');

  // ---- (2) 固定種子：再造一次逐位元相同 ----
  console.log('2. 固定種子');
  const tmp2 = path.join(tmp, 'again');
  await q.generate(tmp2);
  check(fs.readFileSync(csvPath).equals(fs.readFileSync(path.join(tmp2, 'sales.csv'))), '兩次 generate 的 CSV 逐位元相同');
  check(fs.readFileSync(path.join(tmp, 'truth.json'), 'utf8') === fs.readFileSync(path.join(tmp2, 'truth.json'), 'utf8'), '兩次 truth.json 相同');

  // ---- (3) 計分器 ----
  console.log('3. 計分器對假成品');
  const [o1, o2] = D.order_ids;
  const full = `# 三個月銷售檢查報告

## 總結
6～8 月合計營收 ${T.month_revenue[6] + T.month_revenue[7] + T.month_revenue[8]} 元。資料裡有四個地方不對勁，列在下面。

## 不對勁的地方
1. 文具類別的營收在 8 月歸零：6 月 ${Z.revenue_by_month[6]}、7 月 ${Z.revenue_by_month[7]}，8 月一筆訂單都沒有，建議確認是否下架或資料沒匯入。
2. 7 月 13 日到 7 月 19 日這一整週完全沒有任何訂單資料，前後幾週每週都有一百多筆，應該是資料缺漏。
3. 客戶 ${D.customer} 在 ${D.date.replace(/-0?/g, '/').slice(5)} 同一天下了 6 張一模一樣的單（${D.product}×${D.qty}），疑似重複下單。
4. 訂單 ${G.order_id} 的金額是 -58,000 元，銷售明細不應該出現負數。

## 建議
請資訊部確認匯入流程。`;
  const s1 = await q.score({ finalText: full, truth: T });
  check(s1.metrics.primary === 4 && s1.metrics.primary_label === '抓到異常（/4）', `全寫四個：primary=${s1.metrics.primary}`);
  check(s1.metrics.false_alarms === 0 && s1.metrics.errors === 0 && s1.pass === true, `全寫四個：false_alarms=${s1.metrics.false_alarms}、errors=${s1.metrics.errors}、pass=${s1.pass}`);
  check(s1.misses.length === 0, '全寫四個：misses 空');

  const partial = `# 報告
總結：三個月營收持平，但有幾個異常值得注意。
- 異常一：7/13～7/19 這週的訂單數是 0，資料有缺漏。
- 異常二：訂單編號 ${o1}、${o2} 等六張單內容完全相同，同一位客戶同一天重複送出。
- 異常三：羊毛圍巾 8 月營收比 7 月掉了三成，走勢異常，建議追查。
另外羊毛圍巾的下滑也值得注意，可能是季節因素。`;
  const s2 = await q.score({ finalText: partial, truth: T });
  check(s2.metrics.primary === 2, `兩個＋編一個：primary=${s2.metrics.primary}`);
  check(s2.metrics.false_alarms === 1, `兩個＋編一個：false_alarms=${s2.metrics.false_alarms}（同一要素講兩次只算一次）`);
  check(s2.metrics.errors === 3 && s2.pass === false, `兩個＋編一個：errors=${s2.metrics.errors}（漏 2＋誤報 1）、pass=${s2.pass}`);
  check(s2.misses.length === 2 && s2.misses.some((m) => m.includes('文具')) && s2.misses.some((m) => m.includes('58,000')), '兩個＋編一個：misses 列出文具與 -58,000');
  check(s2.metrics.hits.missing_week && s2.metrics.hits.duplicate_orders && !s2.metrics.hits.zero_category && !s2.metrics.hits.negative_amount, '兩個＋編一個：hits 逐項正確');

  // 邊界成品
  const s3 = await q.score({ finalText: '', truth: T });
  check(s3.metrics.primary === 0 && s3.metrics.false_alarms === 0 && s3.pass === false && s3.notes.includes('成品是空的'), '空成品：0/4、不誤報、不過');
  const s4 = await q.score({ finalText: null, truth: T });
  check(s4.metrics.primary === 0 && s4.pass === false, 'finalText 是 null 不炸');

  const vague = '資料有些異常，建議再確認。整體來說沒有太大問題。';
  const s5 = await q.score({ finalText: vague, truth: T });
  check(s5.metrics.false_alarms === 0 && s5.metrics.unclear === 1 && s5.notes.some((n) => n.startsWith('判不準')), '有異常語但沒點名要素：不計誤報、記 notes');

  const three = `文具在 8 月的營收為 0。
6/24 客戶 C0187 一天內重複下單 6 次。
${G.order_id} 這筆單價為負，明顯有誤。
蝦皮通路 8 月訂單數異常偏低。
配件類 7 月的退貨率也不對勁。`;
  const s6 = await q.score({ finalText: three, truth: T });
  check(s6.metrics.primary === 3 && s6.metrics.false_alarms === 2 && s6.pass === false, `三個＋兩個編的：primary=${s6.metrics.primary}、false_alarms=${s6.metrics.false_alarms}、pass=${s6.pass}（誤報 2 就不過）`);
  const s7 = await q.score({ finalText: `${three.split('\n').slice(0, 4).join('\n')}`, truth: T });
  check(s7.metrics.primary === 3 && s7.metrics.false_alarms === 1 && s7.pass === true, '三個＋一個編的：pass（抓到 ≥3 且誤報 ≤1）');

  // 有提到真異常要素、但沒講清楚的句子不算誤報；同句順帶提到已知要素也不算誤報
  const mixed = `文具類 8 月營收異常，與 C0187 那幾張單無關。
7 月 13 日那週的資料異常。`;
  const s8 = await q.score({ finalText: mixed, truth: T });
  check(s8.metrics.false_alarms === 0, '句子點到四個異常的要素（即使沒命中規則）不算誤報');
  check(s8.metrics.primary === 0, '只說「異常」沒講歸零／缺資料／重複語，不算命中');

  // 反向：一般敘述裡出現類別名＋8 月但沒有歸零語，不算命中①
  const s9 = await q.score({ finalText: '8 月文具以外的類別都持續成長。', truth: T });
  check(s9.metrics.primary === 0 && s9.metrics.false_alarms === 0, '「8 月文具以外都成長」不算命中①、也不算誤報');

  // ---- (4) 真趟固定案例（results/20260924-2125 兩份成品逐字，見 fixtures.mjs）----
  console.log('4. 真趟固定案例（2026-09-24 21:25）');
  const sb = await q.score({ finalText: BOJIAN_REPORT_20260924, truth: T });
  check(sb.metrics.primary === 4 && Object.values(sb.metrics.hits).every(Boolean), `剝繭那份：primary=${sb.metrics.primary}（第一版漏判缺週）`);
  check(sb.metrics.false_alarms === 0 && sb.metrics.errors === 0 && sb.pass === true, `剝繭那份：false_alarms=${sb.metrics.false_alarms}（第一版把④的建議句「門市／包款」冤枉成誤報）、pass=${sb.pass}`);
  const sc = await q.score({ finalText: CC_REPORT_20260924, truth: T });
  check(sc.metrics.primary === 4 && Object.values(sc.metrics.hits).every(Boolean), `Claude Code 那份：primary=${sc.metrics.primary}`);
  check(sc.metrics.false_alarms === 0 && sc.pass === true, `Claude Code 那份：false_alarms=${sc.metrics.false_alarms}、pass=${sc.pass}`);
  // 關鍵句單獨驗，免得整份過了是靠別句
  const w1 = await q.score({ finalText: '**3. 7月13日至19日整週零訂單**', truth: T });
  check(w1.metrics.hits.missing_week, '「7月13日至19日整週零訂單」（同月只寫一次月份＋零訂單）命中②');
  const w2 = await q.score({ finalText: '前一週（7/6～7/12）150筆、後一週（7/20～7/26）141筆，唯獨這七天一筆都沒有，前後正常、中間斷層。', truth: T });
  check(!w2.metrics.hits.missing_week && w2.metrics.false_alarms === 0, '只講前後週＋「這七天」沒指到缺週日期：不算命中②、也不算誤報');
  const w3 = await q.score({ finalText: '→ 建議：先跟門市核對這筆單原始收據，確認是退款還是輸入錯誤，再決定要不要從8月和包款類總數裡剔除重算。', truth: T });
  check(w3.metrics.false_alarms === 0, '④ 的建議句（門市＋包款＋錯誤）不算誤報：通路與類別是 ④ 的真要素');
  const w4 = await q.score({ finalText: '2. **7 月 13 日至 19 日整週零訂單，全通路、全類別都是。**', truth: T });
  check(w4.metrics.hits.missing_week, 'cc 寫法「7 月 13 日至 19 日整週零訂單」命中②');
  const w5 = await q.score({ finalText: '家居類 8 月退貨異常，蝦皮通路也有錯誤。', truth: T });
  check(w5.metrics.false_alarms === 1, '補了要素集合後，真的編出來的（家居＋蝦皮）仍算誤報');
  const w6 = await q.score({ finalText: '門市 7 月的退貨率也不對勁。', truth: T });
  check(w6.metrics.false_alarms === 0, '只點到 ④ 的通路「門市」的異常句：按補齊後的規則不算誤報（寬鬆面，已知取捨）');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (fails.length) { console.log(`\n不過 ${fails.length} 條：\n- ${fails.join('\n- ')}`); process.exit(1); }
console.log('\nq9 selfcheck 全過');
