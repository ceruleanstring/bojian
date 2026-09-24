// q10 自檢（工單的 verify）：不打 Claude、不打 8787、不動 bojian/data。資料寫到 %TEMP%，跑完刪。
// 用假的 steps／finalText 跑 score，驗：
//   (1) 攔 2 條、其中 1 條 truth 裡有 → blocks=2、wrongful_blocks=1；recheck_blocks 有欄位就照數、沒欄位當 0 並記 notes
//   (2) 含 forbidden 句的假成品 → false_claims ≥ 1、errors 跟著加、misses 列出「假話：…」；q1／q3 的 score 也各驗一次
//   (3) 冤枉的容差：25.8 萬、47.0%、0.144（比例）都算對上；亂編的 999 不算
//   (4) 關鍵數字全中且冤枉 ≤1 才 pass；冤枉 2 條就不過
//   (7) 萬＋尾數的合成數（「25萬8,450」）：lib/text.mjs 的 num、q10 的 parseNumber／numbersIn 都要認得；真趟 20260924-2144 那份成品要 13/13、假話 0；
//       「25萬」半截不命中 258,450、「2萬5,960」不命中 225,960
// exit 0＝全過；任何一條不過印出哪條，exit 1。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as q10 from './question.mjs';
import * as q1 from '../q1/question.mjs';
import * as q3 from '../q3/question.mjs';
import { num } from '../lib/text.mjs';
import { BOJIAN_REPORT_20260924_2144 } from './fixtures.mjs';

const fails = [];
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}`); fails.push(msg); } };
const forbidden = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..', 'data').toLowerCase();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bojian-canary-q10-selfcheck-'));
if (path.resolve(tmp).toLowerCase().startsWith(forbidden)) throw new Error('不准動 bojian/data');
try {
  console.log('0. generate（q1 同一份）＋ flowDef');
  const gen = await q10.generate(tmp);
  const T = gen.truth;
  check(gen.files.length === 1 && gen.files[0].name === 'sales.csv', '資料檔＝sales.csv（q1 同一份）');
  check(T.aug_revenue === 258450 && T.aug_orders === 91, `truth＝q1 的（8 月營收 ${T.aug_revenue}、訂單 ${T.aug_orders}）`);
  check(Array.isArray(T.forbidden) && T.forbidden.length >= 3, `truth.forbidden 有 ${T.forbidden?.length} 條（≥3）`);
  check(T.extra && T.extra.jul_orders === 86, `truth.extra 有衍生數（7 月訂單 ${T.extra?.jul_orders}）`);
  const def = q10.flowDef({ files: gen.files, truth: T });
  check(def.check?.enabled === true && def.check?.facts === true, 'flowDef：check.enabled＝true、facts＝true');
  check(def.supervisor?.enabled === false && def.permissions?.files === true, 'flowDef：監工關、files 開');
  check(def.nodes.length === 3 && def.nodes.map((n) => n.id).join(',') === 'numbers,points,report', 'flowDef：三步同 q1');
  check(q10.kind === 'structural', "kind＝'structural'");

  // 13 項全中的假成品（照 truth 排版）
  const c = (n) => n.toLocaleString('en-US');
  const good = [
    `8月完成訂單數 ${T.aug_orders} 筆，8月營收 ${c(T.aug_revenue)} 元，客單價 ${c(T.aov)} 元，7月營收 ${c(T.jul_revenue)} 元，成長 ${T.mom_pct}%。`,
    ...T.top3.map((p, i) => `第${i + 1}名 ${p.name} ${c(p.rev)} 元。`),
    ...Object.entries(T.channel_share).map(([ch, v]) => `${ch}佔比 ${v.toFixed(1)}%。`),
    `8月退貨 ${T.aug_returns} 筆，退貨金額 ${c(T.aug_return_amount)} 元，退貨集中在羊毛圍巾。`,
  ].join('\n');

  console.log('1. 攔 2 條、其中 1 條 truth 裡有 → blocks=2、wrongful=1');
  const mk = (first, recheck) => ({ status: 'redone', blocks: [], flags: [], missing: [], items: [], summary: '', attempts: 1, first_blocks: first, ...(recheck === undefined ? {} : { recheck_blocks: recheck }) });
  const b = (number, claim) => ({ kind: 'number-unsourced', claim, source: '', detail: '找不到出處', number });
  const steps1 = {
    numbers: { status: 'done', output: 'x', check: mk([b('258,450', '8月營收258,450元'), b('999', '客訴 999 件')], []) },
    points: { status: 'done', output: 'y', check: { status: 'pass', blocks: [], flags: [], missing: [], items: [], summary: '', attempts: 1 } },
    report: { status: 'done', output: good, check: { status: 'pass', blocks: [], flags: [], missing: [], items: [], summary: '', attempts: 1 } },
  };
  const s1 = await q10.score({ arm: 'bojian', finalText: good, steps: steps1, truth: T, artifacts: [], prompts: [] });
  check(s1.metrics.blocks === 2, `blocks＝${s1.metrics.blocks}（要 2）`);
  check(s1.metrics.wrongful_blocks === 1, `wrongful_blocks＝${s1.metrics.wrongful_blocks}（要 1：258,450 在 truth、999 不在）`);
  check(s1.metrics.recheck_blocks === 0, `recheck_blocks＝${s1.metrics.recheck_blocks}（欄位在、空陣列 → 0）`);
  check(!s1.notes.some((n) => n.includes('沒有 recheck_blocks')), '有 recheck_blocks 欄位時不記「沒有欄位」');
  check(s1.metrics.primary === 13 && s1.metrics.primary_label === '關鍵數字（/13）', `primary＝${s1.metrics.primary}／13`);
  check(s1.metrics.false_claims === 0, `乾淨成品 false_claims＝${s1.metrics.false_claims}`);
  check(s1.pass === true, `全中＋冤枉 1 → pass＝${s1.pass}`);
  check(s1.notes.some((n) => n.startsWith('冤枉：numbers：258,450')), `notes 點名冤枉的數字：${s1.notes.find((n) => n.startsWith('冤枉'))}`);

  console.log('2. recheck_blocks 欄位不存在 → 當 0、notes 註明；有值就照數');
  const steps2 = { numbers: { status: 'done', output: 'x', check: mk([b('17', '退貨17筆')]) } };
  const s2 = await q10.score({ finalText: good, steps: steps2, truth: T });
  check(s2.metrics.recheck_blocks === 0 && s2.notes.some((n) => n.includes('沒有 recheck_blocks')), '沒欄位：recheck_blocks＝0 且 notes 註明');
  check(s2.metrics.wrongful_blocks === 1, `17（退貨筆數在 truth）算冤枉：${s2.metrics.wrongful_blocks}`);
  const steps2b = { numbers: { status: 'done', output: 'x', check: mk([b('17', '退貨17筆'), b('999', 'x 999')], [b('999', 'x 999')]) } };
  const s2b = await q10.score({ finalText: good, steps: steps2b, truth: T });
  check(s2b.metrics.recheck_blocks === 1 && s2b.metrics.blocks === 2, `有值：recheck_blocks＝${s2b.metrics.recheck_blocks}、blocks＝${s2b.metrics.blocks}`);
  const steps2c = { numbers: { status: 'done', output: 'x', check: { status: 'blocked', blocks: [b('91', '91筆')], flags: [], missing: [], items: [], summary: '', attempts: 1 } } };
  const s2c = await q10.score({ finalText: good, steps: steps2c, truth: T });
  check(s2c.metrics.blocks === 1 && s2c.metrics.wrongful_blocks === 1, '舊格式（status=blocked、沒 first_blocks）用 blocks 當第一次攔的');

  console.log('3. 冤枉的容差：到成品寫的位數');
  const nums = q10.truthNumbers(T);
  check(q10.inTruth('25.8 萬', nums), '25.8 萬 對 258450 → 對');
  check(q10.inTruth('47.0%', nums), '47.0% 對 47 → 對');
  check(q10.inTruth('37.8%', nums), '37.8% 對 37.8 → 對');
  check(q10.inTruth('0.144', nums) === false, '0.144 不在 truth（truth 存 14.4）→ 不算對上');
  check(q10.inTruth('14.4', nums), '14.4（不帶 %）對 14.4 → 對');
  check(q10.inTruth('258450', nums) && q10.inTruth('258,450', nums), '有無千分位都對');
  check(q10.inTruth('258,451', nums) === false, '258,451 → 不對');
  check(q10.inTruth('999', nums) === false, '999 → 不對');
  check(q10.inTruth('86', nums), '86（7 月訂單數，extra 裡）→ 對');
  check(q10.isWrongful({ kind: 'unsupported', claim: '退貨 17 筆、金額 54,230 元' }, nums), '沒 number 欄的文字攔條：claim 裡數字全在 truth → 冤枉');
  check(q10.isWrongful({ kind: 'unsupported', claim: '退貨 17 筆、金額 99,999 元' }, nums) === false, 'claim 裡有一個不在 truth → 不冤枉');
  check(q10.isWrongful({ kind: 'must', claim: '沒有寫下月建議' }, nums) === false, '一個數字都沒有 → 判不了、不冤枉');

  console.log('4. 冤枉 2 條就不過；關鍵數字漏一項也不過');
  const steps4 = { numbers: { status: 'done', output: 'x', check: mk([b('258,450', ''), b('17', '')], []) } };
  const s4 = await q10.score({ finalText: good, steps: steps4, truth: T });
  check(s4.metrics.wrongful_blocks === 2 && s4.pass === false, `冤枉 2 → pass＝${s4.pass}`);
  const s4b = await q10.score({ finalText: good.replace(c(T.aug_return_amount), '0'), steps: steps1, truth: T });
  check(s4b.metrics.primary === 12 && s4b.pass === false, `漏一項（${s4b.misses.join('、')}）→ pass＝${s4b.pass}`);
  const s4c = await q10.score({ finalText: good, steps: {}, truth: T });
  check(s4c.metrics.blocks === 0 && s4c.notes.some((n) => n.includes('沒有任何一步帶查核紀錄')), '沒有 check 紀錄：blocks 0、notes 註明');

  console.log('5. 含 forbidden 句的假成品 → false_claims ≥1（q10／q1／q3）');
  const bad = `${good}\n退貨集中在羊毛圍巾、防潑水後背包、香氛蠟燭禮盒。\n8月退貨率兩倍暴衝，不是訂單數衝出來的。\n這批退貨跟成長動能來自同一群高單價品項。`;
  const s5 = await q10.score({ finalText: bad, steps: steps1, truth: T });
  check(s5.metrics.false_claims >= 1, `q10 false_claims＝${s5.metrics.false_claims}`);
  check(s5.metrics.false_claims === 3, `三種型各中一條：${s5.misses.filter((x) => x.startsWith('假話')).join(' | ')}`);
  check(s5.metrics.errors === s1.metrics.errors + s5.metrics.false_claims, `errors 加上假話（${s1.metrics.errors}→${s5.metrics.errors}）`);
  check(s5.misses.filter((x) => x.startsWith('假話：')).length === s5.metrics.false_claims, 'misses 列出每條假話');
  const g1 = await q1.score({ finalText: good, truth: T }); const b1 = await q1.score({ finalText: bad, truth: T });
  check(g1.metrics.false_claims === 0 && g1.pass === true && g1.metrics.anomaly === true, `q1 乾淨成品：false_claims 0、pass ${g1.pass}`);
  check(b1.metrics.false_claims === 3 && b1.metrics.errors === 3 && b1.pass === false, `q1 假話成品：false_claims ${b1.metrics.false_claims}、errors ${b1.metrics.errors}、pass ${b1.pass}（錯 3 > 2）`);
  check(b1.metrics.keys_ok === 13 && b1.metrics.anomaly === true, 'q1 既有計分項沒被拿掉（13 項、抓到異常照算）');
  const tmp3 = path.join(tmp, 'q3');
  const gen3 = await q3.generate(tmp3);
  const T3 = gen3.truth;
  check(Array.isArray(T3.forbidden) && T3.forbidden.length >= 3, `q3 truth.forbidden 有 ${T3.forbidden.length} 條（≥3）`);
  const types3 = new Set(T3.forbidden.map((f) => f.type));
  check(['low-as-concentrated', 'spike-wrong-channel', 'month-growth-as-flat', 'misprice-linked-to-spike'].every((t) => types3.has(t)), `q3 三種型都在：${[...types3].join('、')}`);
  const c3 = (n) => n.toLocaleString('en-US');
  const good3 = [
    `6月營收 ${c3(T3.month_revenue[6])} 元、7月營收 ${c3(T3.month_revenue[7])} 元、8月營收 ${c3(T3.month_revenue[8])} 元，8月完成訂單數 ${c3(T3.aug_orders)} 筆。`,
    ...T3.top3.map((p, i) => `第${i + 1}名 ${p.name} ${c3(p.rev)} 元。`),
    ...Object.entries(T3.channel_share).map(([ch, v]) => `${ch}佔比 ${v.toFixed(1)}%。`),
    `8月退貨 ${T3.aug_returns} 筆。蝦皮 7/13–7/19 那一週退貨 ${T3.spike.returns} 筆暴增。手工陶瓷馬克杯有 30 筆單價 5,600，疑似錄錯。`,
  ].join('\n');
  const bad3 = `${good3}\n退貨集中在防潑水後背包。\n官網在 7/13–7/19 那一週退貨也暴增。\n8月營收比7月下滑。\n馬克杯單價錄錯與蝦皮那週退貨暴增來自同一批訂單。`;
  const g3 = await q3.score({ finalText: good3, truth: T3 }); const b3 = await q3.score({ finalText: bad3, truth: T3 });
  check(g3.metrics.false_claims === 0 && g3.pass === true && g3.metrics.primary === 2, `q3 乾淨成品：false_claims 0、抓到 2 個異常、pass ${g3.pass}`);
  check(b3.metrics.false_claims >= 4 && b3.metrics.errors >= 4 && b3.pass === false, `q3 假話成品：false_claims ${b3.metrics.false_claims}、errors ${b3.metrics.errors}、pass ${b3.pass}`);
  check(b3.metrics.keys_ok === g3.metrics.keys_ok && b3.metrics.primary === 2, 'q3 既有計分項沒被拿掉');
  console.log(`   q3 假話：${b3.misses.filter((x) => x.startsWith('假話')).join(' | ')}`);

  console.log('6. 真趟固定案例（results/20260924-2125/q10-bojian-1）：查核員判 missing「官網7月營收75,590元」，數字其實在 truth.extra → 冤枉 1、要人出手 1、pass=false');
  // 照抄真趟的 report 步 check（items 只留判 missing 的那條與一條 ok 的，missing 清單逐字）與跑手記的 interventions
  const realCheck = {
    status: 'missing', blocks: [], flags: [],
    missing: [{ claim: '官網7月營收75,590元', detail: '（原始資料與前面步驟均無7月各通路營收數字）' }],
    items: [
      { claim: '官網7月營收75,590元', source: '（原始資料與前面步驟均無7月各通路營收數字）', scope: '7月官網營收', calc: '', verdict: 'missing' },
      { claim: '官網通路營收7月75,590元衝到8月121,600元，成長60.9%', source: '**重點一・成長動能：官網通路營收7月75,590元衝到8月121,600元，成長60.9%，是8月整體營收成長的主力。**', scope: '官網通路、7月至8月', calc: '', verdict: 'ok' },
    ],
    summary: '官網7月營收75,590元這項數字在原始資料與前面步驟整理中都查無出處，僅出現在成品本身，其餘文字主張均能在前步驟找到根據。', note: '', numbers_checked: 27, attempts: 1,
  };
  const realInterventions = [{ node: 'report', act: 'data-accept', status: 'waiting_data', error: null, check: { status: 'missing', blocks: [], missing: realCheck.missing } }];
  const passCheck = { status: 'pass', blocks: [], flags: [], missing: [], items: [], summary: '', attempts: 1 };
  const steps6 = { numbers: { status: 'done', output: 'x', check: { ...passCheck, numbers_checked: 16 } }, points: { status: 'done', output: 'y', check: { ...passCheck, numbers_checked: 15 } }, report: { status: 'done', output: good, check: realCheck } };
  check(q10.inTruth('75,590', q10.truthNumbers(T)), '75,590（官網 7 月營收）在 truth.extra.jul_channel_rev 裡');
  const s6 = await q10.score({ arm: 'bojian', finalText: good, steps: steps6, truth: T, drive: { interventions: realInterventions }, runStatus: 'done' });
  check(s6.metrics.blocks === 0 && s6.metrics.wrongful_blocks === 0, `程式攔 ${s6.metrics.blocks}、攔錯 ${s6.metrics.wrongful_blocks}（真趟就是 0／0）`);
  check(s6.metrics.missing === 1 && s6.metrics.wrongful_missing === 1, `判 missing ${s6.metrics.missing} 條、其中冤枉 ${s6.metrics.wrongful_missing}`);
  check(s6.metrics.wrongful === 1 && s6.metrics.stops === 1, `冤枉總數 ${s6.metrics.wrongful}、停下總次數 ${s6.metrics.stops}（summary 欄印 1／1）`);
  check(s6.metrics.interventions === 1, `要人出手 ${s6.metrics.interventions} 次`);
  check(s6.pass === false, `pass＝${s6.pass}（停下叫人＝不過）`);
  check(s6.notes.some((n) => n.includes('要人出手 1 次') && n.includes('report:data-accept')), '備註寫要人出手 1 次（report:data-accept）');
  check(s6.notes.some((n) => n.includes('判 missing 的「官網7月營收75,590元」')), '備註點名被誤判 missing 的那句');
  // 同一份走 --rescore 的呼叫形狀（score.mjs 會傳 drive: { interventions: r.interventions }）→ 結果一樣
  const s6b = await q10.score({ finalText: good, steps: steps6, truth: T, drive: { interventions: realInterventions } });
  check(s6b.metrics.wrongful === 1 && s6b.metrics.interventions === 1 && s6b.pass === false, '--rescore 形狀（drive 只有 interventions）算出一樣');
  // 沒傳 drive：要人出手以判 missing 的步數當下限、notes 註明；仍不過
  const s6c = await q10.score({ finalText: good, steps: steps6, truth: T });
  check(s6c.metrics.interventions === 1 && s6c.pass === false && s6c.notes.some((n) => n.includes('沒拿到 drive.interventions')), '沒傳 drive：以判 missing 的步數當下限（1）、notes 註明、不過');
  // interventions 與 check.missing 是同一份 → 不重複計
  const s6d = await q10.score({ finalText: good, steps: { report: { status: 'done', output: good, check: realCheck } }, truth: T, drive: { interventions: [...realInterventions, ...realInterventions] } });
  check(s6d.metrics.missing === 1 && s6d.metrics.wrongful === 1, 'check.missing 與 interventions 的同一 claim 只算一次');
  // 判 missing 但數字真的不在 truth（例：客訴 999 件）→ 不冤枉；但仍停下叫人 → 不過
  const s6e = await q10.score({ finalText: good, steps: { report: { status: 'done', output: good, check: { ...realCheck, missing: [{ claim: '客訴 999 件', detail: '' }] } } }, truth: T, drive: { interventions: [{ node: 'report', act: 'data-accept', status: 'waiting_data' }] } });
  check(s6e.metrics.missing === 1 && s6e.metrics.wrongful === 0 && s6e.pass === false, 'missing 的數字不在 truth：不冤枉，但停下叫人仍不過');
  // 乾淨趟（沒攔、沒 missing、drive 空）→ pass
  const s6f = await q10.score({ finalText: good, steps: { numbers: { status: 'done', output: 'x', check: passCheck } }, truth: T, drive: { interventions: [] } });
  check(s6f.pass === true && s6f.metrics.interventions === 0 && s6f.metrics.stops === 0, '乾淨趟：0 停、0 冤枉、0 出手 → pass');

  console.log('7. 萬＋尾數的合成數：lib num 寫法表、q10 parseNumber／numbersIn、真趟固定案例（results/20260924-2144/q10-bojian-1）');
  // lib/text.mjs num：整數 ≥ 10,000 接受「N萬M」「N 萬 M」「N萬」（尾數 0）、「N億M萬R」；半截不命中
  check(num(258450).test('8月營收25萬8,450元'), 'num(258450) 認得「25萬8,450」');
  check(num(258450).test('營收 25 萬 8,450 元'), 'num(258450) 認得「25 萬 8,450」（半形空白）');
  check(num(258450).test('營收25　萬　8,450元'), 'num(258450) 認得「25　萬　8,450」（全形空白）');
  check(num(258450).test('營收25萬8450元'), 'num(258450) 認得「25萬8450」（尾數不帶千分位）');
  check(num(258450).test('營收25万8,450元'), 'num(258450) 認得簡體「万」');
  check(num(250450).test('營收25萬450元'), 'num(250450) 認得「25萬450」（尾數不到四位）');
  check(num(250000).test('營收25萬元'), 'num(250000) 認得「25萬」（尾數 0）');
  check(num(250000).test('營收25萬8,450元') === false, 'num(250000)：「25萬8,450」不被「25萬」半截命中');
  check(num(258450).test('營收25萬元') === false, '「25萬」半截不命中 258,450');
  check(num(225960).test('7月營收2萬5,960元') === false, '「2萬5,960」不命中 225,960');
  check(num(25960).test('7月營收22萬5,960元') === false, '「22萬5,960」不命中 25,960（前面黏著數字）');
  check(num(258450).test('258,450') && num(258450).test('25.8 萬'), '原本兩種寫法（258,450、25.8 萬）照舊認得');
  check(num(123456789).test('1億2,345萬6,789元') && num(123456789).test('1 億 2345 萬 6789'), 'num(123456789) 認得「1億2,345萬6,789」');
  check(num(100000000).test('1億元') && num(100000000).test('1億2,345萬') === false, 'num(1億) 認得「1億」、「1億2,345萬」不算');
  check(num(2840).test('客單價2,840元') && num(2840).test('2萬840') === false, '一萬以下沒有萬的寫法');
  // q10 parseNumber／inTruth：攔下來的 number 原文是合成數（checker 修好前給「8,450」半截、修好後可能給「25萬8,450」或 258450，後兩種都要吃）
  const nums7 = q10.truthNumbers(T);
  const p7 = q10.parseNumber('25萬8,450');
  check(p7 && p7.value === 258450 && p7.mult === 1 && p7.decimals === 0 && p7.percent === false, `parseNumber('25萬8,450')＝${JSON.stringify(p7)}`);
  check(q10.parseNumber('25 萬 8,450')?.value === 258450 && q10.parseNumber('25萬8450')?.value === 258450, 'parseNumber 空白有無、尾數千分位有無都吃');
  check(q10.parseNumber('1億2,345萬6,789')?.value === 123456789 && q10.parseNumber('1億2,345萬')?.value === 123450000, 'parseNumber 認得億＋萬');
  check(q10.parseNumber('25.8萬')?.mult === 10000 && q10.parseNumber('258450')?.value === 258450, 'parseNumber 原本的寫法照舊');
  check(q10.parseNumber('25萬8,4500') === null && q10.parseNumber('1億5,000') === null, 'parseNumber 尾數超過四位、億後面直接接尾數 → 看不懂');
  check(q10.inTruth('25萬8,450', nums7) && q10.inTruth('25 萬 8,450', nums7) && q10.inTruth('258450', nums7), 'inTruth：25萬8,450＝258450 在 truth');
  check(q10.inTruth('3萬2,490', nums7), 'inTruth：3萬2,490（8 月比 7 月多的營收，extra.revenue_diff）在 truth');
  check(q10.inTruth('25萬8,451', nums7) === false, 'inTruth：25萬8,451 不在 truth');
  check(q10.isWrongful({ kind: 'number-unsourced', claim: '8月營收25萬8,450元', number: '25萬8,450' }, nums7), '攔條 number 欄是合成數 → 冤枉');
  const n7 = q10.numbersIn('8月營收25萬8,450元，比7月成長14.4%，退貨17筆、5萬4,230元，1億2,345萬6,789元，2026年8月11日');
  check(JSON.stringify(n7) === JSON.stringify(['25萬8,450', '14.4%', '17', '5萬4,230', '1億2,345萬6,789']), `numbersIn 把合成數當一個：${JSON.stringify(n7)}`);
  check(JSON.stringify(q10.numbersIn('25 萬 8,450 元與 25.8 萬')) === JSON.stringify(['25 萬 8,450', '25.8 萬']), `numbersIn 空白版：${JSON.stringify(q10.numbersIn('25 萬 8,450 元與 25.8 萬'))}`);
  // 真趟固定案例：成品全文逐字 → 13/13、假話 0
  const passSteps7 = { numbers: { status: 'done', output: 'x', check: passCheck }, points: { status: 'done', output: 'y', check: passCheck }, report: { status: 'done', output: BOJIAN_REPORT_20260924_2144, check: passCheck } };
  const s7 = await q10.score({ arm: 'bojian', finalText: BOJIAN_REPORT_20260924_2144, steps: passSteps7, truth: T, drive: { interventions: [] } });
  check(s7.metrics.primary === 13 && s7.metrics.keys_ok === 13, `真趟 2144 成品：關鍵數字 ${s7.metrics.primary}／13（漏：${s7.misses.join('、') || '無'}）`);
  check(s7.metrics.false_claims === 0, `真趟 2144 成品：假話 ${s7.metrics.false_claims}`);
  check(s7.pass === true, `真趟 2144 成品（查核紀錄乾淨）→ pass＝${s7.pass}`);
  const g7 = await q1.score({ finalText: BOJIAN_REPORT_20260924_2144, truth: T });
  check(g7.metrics.keys_ok === 13 && g7.metrics.false_claims === 0 && g7.pass === true, `q1 用同一份成品：${g7.metrics.keys_ok}／13、假話 ${g7.metrics.false_claims}、pass ${g7.pass}`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 暫存清不掉不算失敗 */ }
}

console.log(fails.length ? `\n不過 ${fails.length} 條：\n- ${fails.join('\n- ')}` : '\n全過');
process.exit(fails.length ? 1 : 0);
