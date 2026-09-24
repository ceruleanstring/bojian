// checker 測試：算式驗算、JSON 解析、分類、查核 prompt、原始資料組裝、成品檔文字、查核與擬規則
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import {
  buildCheckPrompt, parseCheckResult, verifyArithmetic, classify, extractFileText,
  runCheck, buildEditRulesPrompt, deriveEditRules, buildSources, CheckParseError, pptxSlides, UPSTREAM_HEADING,
  extractNumbers, checkNumbers,
} from '../src/checker.js';

// 假 adapter：回錄呼叫；reply 是 Error 就丟出來（style 同 runner.test.js）
function fakeAdapter(reply) {
  const calls = [];
  return {
    calls,
    async complete({ prompt, meta }) {
      calls.push({ prompt, meta });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

const REQ = {
  instruction: '把明細寫成八月月報',
  constraints: '不超過一頁',
  reviewFocus: '數字要對\n每段不超過三句',
  outputFormat: 'Markdown 表格',
  editRules: ['保留 120 分鐘'],
};

// ---- 算式驗算 ----

test('算式驗算：對的 true、錯的 false、看不懂 null；千分位、括號、全形都算得出來', () => {
  assert.equal(verifyArithmetic('6+3+4+1=14'), true);
  assert.equal(verifyArithmetic('6+3+2+1=14'), false);
  assert.equal(verifyArithmetic('1,200+300=1,500'), true);
  assert.equal(verifyArithmetic('約 20%'), null);
  assert.equal(verifyArithmetic('(2+3)*4=20'), true);
  assert.equal(verifyArithmetic('12×2＝24'), true, '全形等號與乘號');
  assert.equal(verifyArithmetic('960÷4=240'), true);
  assert.equal(verifyArithmetic('總數十三件'), null, '沒有等號＝不表態');
  assert.equal(verifyArithmetic(''), null);
  assert.equal(verifyArithmetic('100/3=33.33'), true, '除不盡：截到右邊寫的位數就算成立');
});

//：查核員照規則第 2 條把算式寫進 calc，除不盡的佔比（6÷14）一定是四捨五入或截斷過的商——
// 用固定容差比一定判不成立，查核員說 ok 會被程式翻成攔。真跑一趟九次誤攔全出在這裡。
test('算式驗算：右邊寫到第幾位就比到第幾位——四捨五入或截斷都算成立，真的算錯照樣抓', () => {
  assert.equal(verifyArithmetic('6/14=0.428'), true, '截斷到三位');
  assert.equal(verifyArithmetic('6/14=0.43'), true, '四捨五入到兩位');
  assert.equal(verifyArithmetic('6/14=0.4285'), true, '截斷到四位');
  assert.equal(verifyArithmetic('1/14=0.071'), true);
  assert.equal(verifyArithmetic('6/(6+3+4+1)=0.4285'), true, '先加總再除也一樣');
  assert.equal(verifyArithmetic('100/3=33'), true, '右邊寫整數就比到整數');
  assert.equal(verifyArithmetic('0.1+0.2=0.3'), true, '浮點雜訊不算對不上');

  assert.equal(verifyArithmetic('6+3+4+2=14'), false, '整數加錯照樣抓');
  assert.equal(verifyArithmetic('28/2=15'), false, '除得盡但寫錯照樣抓');
  assert.equal(verifyArithmetic('6+3+2+1=14'), false);
});

//（a）：查核員照第 2 條把成品的「43%」搬到等號右邊，左邊卻沒乘 100——
// 百分號是「除以 100」不是雜訊，任一邊寫了就先換算成同一個單位再比。
test('算式驗算：等號任一邊寫百分號就先除以 100 再比', () => {
  assert.equal(verifyArithmetic('6/14=42.9%'), true, '寫到小數一位');
  assert.equal(verifyArithmetic('6/14=43%'), true, '四捨五入到整數');
  assert.equal(verifyArithmetic('6/14=42%'), true, '截斷到整數');
  assert.equal(verifyArithmetic('14/14=100%'), true);
  assert.equal(verifyArithmetic('42.9%=6/14'), true, '百分比寫在左邊也一樣');
  assert.equal(verifyArithmetic('6/14=42.9％'), true, '全形百分號');

  assert.equal(verifyArithmetic('6/14=50%'), false, '差真的大照樣抓');
  assert.equal(verifyArithmetic('6/14*100=42.9%'), true, '左邊乘過 100 右邊又寫百分號＝兩邊都在講百分數（裁定 29）');
  assert.equal(verifyArithmetic('約 20%'), null, '沒有等號就不是算式');
});

//（b）：兩邊都沒寫百分號，一邊是比例、一邊是百分數（6/14=43）——小的乘 100 對得上也算成立
test('算式驗算：一邊小於 1、一邊不小於 1 時，小的乘 100 對得上也算成立', () => {
  assert.equal(verifyArithmetic('6/14=43'), true);
  assert.equal(verifyArithmetic('1/14=7'), true);
  assert.equal(verifyArithmetic('3/14=21'), true);
  assert.equal(verifyArithmetic('4/14=29'), true);
  assert.equal(verifyArithmetic('6/14=42.9'), true, '比到右邊寫的位數');
  assert.equal(verifyArithmetic('0.5=50'), true);
  assert.equal(verifyArithmetic('50=0.5'), true, '大的寫在左邊也一樣');
  assert.equal(verifyArithmetic('2/4=0.5'), true, '本來就對得上的不受影響');

  assert.equal(verifyArithmetic('6/14=50'), false, '乘 100 還是對不上');
  assert.equal(verifyArithmetic('10*4=4000'), false, '兩邊都不小於 1＝不套這條');
  assert.equal(verifyArithmetic('28/2=15'), false);
});

//：比對的位數要取自「寫成純數字」的那一側。之前一律取右邊的位數，百分號寫在左邊、右邊是算式或整數時
// 位數退化成 0，等於整數比——0% 到 100% 之間隨便寫什麼都判成立（50%=6/14、50%=0 都被放行）。
test('算式驗算：位數取自寫成純數字的那一側，百分號在左邊不會恆真', () => {
  assert.equal(verifyArithmetic('50%=6/14'), false, '6/14 是 42.9%，不是 50%');
  assert.equal(verifyArithmetic('99%=6/14'), false);
  assert.equal(verifyArithmetic('1%=6/14'), false);
  assert.equal(verifyArithmetic('99%=1/14'), false);
  assert.equal(verifyArithmetic('80%=3/14'), false);
  assert.equal(verifyArithmetic('50%=0'), false, '右邊是整數也不准退化成整數比');
  assert.equal(verifyArithmetic('1%=0'), false);
  assert.equal(verifyArithmetic('43%=0.40'), false);
  assert.equal(verifyArithmetic('6/14=99%'), false, '百分號寫在右邊照舊');

  assert.equal(verifyArithmetic('43%=6/14'), true, '四捨五入到整數');
  assert.equal(verifyArithmetic('42.9%=6/14'), true, '寫到小數一位');
  assert.equal(verifyArithmetic('42%=6/14'), true, '截斷到整數');
  assert.equal(verifyArithmetic('6/14=42.9%'), true);
  assert.equal(verifyArithmetic('7/100=7%'), true);
  assert.equal(verifyArithmetic('50%=0.5'), true);
  assert.equal(verifyArithmetic('100%=1'), true);
  assert.equal(verifyArithmetic('3=300%'), true);
  assert.equal(verifyArithmetic('6/14=43'), true, '沒寫百分號的百分數，不受影響');
  assert.equal(verifyArithmetic('43=6/14'), true, '沒寫百分號、寫在左邊');
  assert.equal(verifyArithmetic('0.5=50'), true);
  assert.equal(verifyArithmetic('50=0.5'), true);
});

// 最終覆核②：純數字認不認前導正負號與外層括號。認不出來就退回「照右邊取位數」，
// 右邊是算式時位數退化成 0＝整數比，-50%／(50)% 這些寫法又變回恆真。
test('算式驗算：帶正負號或外層括號的純數字也算「寫出來的那一側」', () => {
  assert.equal(verifyArithmetic('-50%=6/14'), false, '負百分比不准退化成整數比');
  assert.equal(verifyArithmetic('+50%=6/14'), false);
  assert.equal(verifyArithmetic('(50)%=6/14'), false);
  assert.equal(verifyArithmetic('-20%=(14-11.2)/14'), false, '左邊是負的、右邊是正的＝不成立');

  assert.equal(verifyArithmetic('-20%=-0.2'), true, '負號要跟著值走');
  assert.equal(verifyArithmetic('(43)%=6/14'), true, '括號包住的數字照樣算位數');
});

//：恰一側寫百分號、嚴格比對不成立時，退一步用兩側「剝掉百分號的原始值」再比一次。
// 查核員把佔比乘完 100 又補百分號（6/14*100=42.9%）是最自然的寫法，硬判不成立會假攔。
test('算式驗算：兩邊其實都在講百分數時退一步用原始值再比一次', () => {
  assert.equal(verifyArithmetic('6/14*100=42.9%'), true, '42.857 對 42.9，比到寫出來的一位');
  assert.equal(verifyArithmetic('6/14*100=43%'), true, '四捨五入到整數');

  assert.equal(verifyArithmetic('6/14*100=50%'), false, '退一步比也對不上');
  assert.equal(verifyArithmetic('50%=6/14'), false, '原始值 50 對 0.43，恆真洞沒有被重新打開');
  assert.equal(verifyArithmetic('6/14=99%'), false);
});

//（a）： 的退路沒有門檻，就等於「剝掉百分號、拿兩側原始值比整數位」——
// 6/14=0%（0.43 對 0）、6+3+4+1=14%（14 對 14）一比就成立，假放行比假攔更難被發現。
// 門檻＝非字面的那一側真的乘過 100（6/14*100=42.9%），退路才開。
test('算式驗算：沒乘過 100 就不准退到原始值比', () => {
  assert.equal(verifyArithmetic('6/14=0%'), false, '6/14 是 42.9%，不是 0%');
  assert.equal(verifyArithmetic('6+3+4+1=14%'), false, '左邊是 14、右邊是 0.14，不是同一個單位');
  assert.equal(verifyArithmetic('14%=6+3+4+1'), false, '寫在左邊也一樣');
  assert.equal(verifyArithmetic('100/3=33%'), false, '33.3 不是 0.33');
  assert.equal(verifyArithmetic('6/14=1%'), false);

  // 沒有新假攔：本來就該成立的照樣成立
  assert.equal(verifyArithmetic('6/14*100=42.9%'), true, '乘過 100＝退路照開');
  assert.equal(verifyArithmetic('100*6/14=42.9%'), true, '100 寫在乘號前面也算乘過');
  assert.equal(verifyArithmetic('42.9%=6/14*100'), true, '百分比寫在左邊也一樣');
  assert.equal(verifyArithmetic('(6/14)*100=42.9%'), true, '括號包住比例再乘 100');
  assert.equal(verifyArithmetic('6/14=42.9%'), true, '嚴格比就過得了的，本來就不靠退路');
  assert.equal(verifyArithmetic('6/14=43%'), true);
  assert.equal(verifyArithmetic('14/14=100%'), true);
  assert.equal(verifyArithmetic('7/100=7%'), true);
  assert.equal(verifyArithmetic('50%=0.5'), true);
  assert.equal(verifyArithmetic('42.9%=6/14'), true);
});

//（b）：decimalsOf 直接對原字串找小數點，(42.0)% 的小數點後面跟著「0)」不是純數字，
// 位數退化成 0＝整數比，寫錯的小數位被放行。先剝掉括號再判位數。
test('算式驗算：括號包住的小數照小數位比，不退化成整數比', () => {
  assert.equal(verifyArithmetic('6/14=(42.0)%'), false, '寫到一位就比到一位：42.857 不是 42.0');
  assert.equal(verifyArithmetic('(42.0)%=6/14'), false, '寫在左邊也一樣');
  assert.equal(verifyArithmetic('100/3=(33.0)'), false, '33.333 不是 33.0');

  assert.equal(verifyArithmetic('6/14=(42.9)%'), true, '四捨五入到一位');
  assert.equal(verifyArithmetic('6/14=(42.8)%'), true, '截斷到一位');
  assert.equal(verifyArithmetic('100/3=(33.3)'), true);
  assert.equal(verifyArithmetic('(43)%=6/14'), true, '沒有小數點的括號寫法不受影響');
});

test('算式驗算：帶單位、貨幣符號、標籤、句號的算式照樣算得出來', () => {
  assert.equal(verifyArithmetic('6+3+2+1=14 件'), false, '單位前有空白');
  assert.equal(verifyArithmetic('6+3+2+1=14件'), false, '單位直接黏著');
  assert.equal(verifyArithmetic('總計：6+3+2+1=14'), false, '前面掛標籤');
  assert.equal(verifyArithmetic('6+3+2+1=14。'), false, '結尾句號');
  assert.equal(verifyArithmetic('$1,200+$300=$1,600'), false, '貨幣符號');
  assert.equal(verifyArithmetic('NT$1,200+NT$300=NT$1,500'), true, '對的也要算得出來');
  assert.equal(verifyArithmetic('6+3+4+1=14 件'), true);
  assert.equal(verifyArithmetic('約 20%'), null, '百分比不是算式');
  assert.equal(verifyArithmetic('6+3+4+1=14%'), false, '裁定 31 補了門檻：左邊沒乘過 100 就不退到原始值比，14 對 0.14 照樣不成立');
  assert.equal(verifyArithmetic('大約一半'), null);
  assert.equal(verifyArithmetic('一半的28=14'), null, '數字前面掛中文＝看不懂，不猜');
});

test('算式驗算：不准用 eval／Function 執行查核員給的算式', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'checker.js'), 'utf8');
  assert.ok(!/\beval\s*\(/.test(src), 'checker.js 不得出現 eval(');
  assert.ok(!/\bnew\s+Function\b/.test(src), 'checker.js 不得出現 new Function');
});

// ---- 成品數字對出處（ADR-010 決策 1）----

const vals = (text) => extractNumbers(text).map((n) => n.value);

test('抓數字：千分位、小數、百分號（半形／全形）、七種負數寫法（L061）、萬／億／千倍數；value／decimals／percent／raw／index 齊', () => {
  const [a] = extractNumbers('8 月營收 258,450 元');
  assert.deepEqual(a, { value: 258450, decimals: 0, percent: false, raw: '258,450', index: 6 });
  const [b] = extractNumbers('客單價 2,840.5 元');
  assert.deepEqual([b.value, b.decimals], [2840.5, 1]);
  assert.deepEqual(extractNumbers('成長 14.4%，佔比 15.2％').map((n) => [n.value, n.decimals, n.percent]), [[14.4, 1, true], [15.2, 1, true]]);
  // 七種負數寫法：半形減號、全形減號、Unicode hyphen、en dash、em dash、minus sign、空白分隔、會計括號
  for (const s of ['-15', '－15', '‐15', '–15', '—15', '−15', '差額為 - 15']) assert.deepEqual(vals(s), [-15], `負數寫法：${s}`);
  assert.deepEqual(vals('本月 (5,000) 元'), [-5000], '會計括號');
  assert.equal(extractNumbers('本月 (5,000) 元')[0].raw, '(5,000)');
  assert.deepEqual(vals('官網 121,600 元（47.0%）'), [121600, 47], '括號裡帶百分號不是會計負數');
  // 倍數：value 乘上去、decimals 照寫的位數
  const [w] = extractNumbers('營收 25.8 萬元');
  assert.deepEqual([w.value, w.decimals, w.raw], [258000, 1, '25.8 萬']);
  assert.deepEqual(vals('1.2 億、3 千'), [120000000, 3000]);
  // 金絲雀 q1 真成品的寫法：「25萬8,450元」是一個數，不是 25 萬加 8,450 兩個數
  const [mixed] = extractNumbers('營收25萬8,450元，比7月的22萬5,960元');
  assert.deepEqual([mixed.value, mixed.decimals, mixed.raw], [258450, 0, '25萬8,450']);
  assert.deepEqual(vals('營收25萬8,450元，比7月的22万5,960元'), [258450, 225960], '簡體 万 也認');
  // 來源側：CSV 的「數量,單價」相鄰＝「1,1980」是 1 與 1980，不是千分位的 1,198 加 0
  assert.deepEqual(checkNumbers({ product: '單價 1,980 元', raw: ['數量,單價,金額\n1,1980,1980\n'] }).blocks, [], 'CSV 相鄰欄位不當千分位');
  assert.deepEqual(extractNumbers('1,1980,3960', { all: true }).map((n) => n.value), [1, 1980, 3960]);
  assert.deepEqual(checkNumbers({ product: '營收25萬8,450元', printed: '八月營收: 258450' }).blocks, [], '合成數整個比');
  assert.deepEqual(vals('10-20 件'), [10, 20], '範圍的連字號不是負號');
  assert.deepEqual(vals('- 15 件'), [15], '行首的「- 」是清單符號，不是負號');
});

test('不抓：年份、日期、時間、第 N、行首清單編號、Q1～Q4、電話／編號樣式；但同樣的四位數不接「年」就抓', () => {
  assert.deepEqual(vals('2026 年 7、8 月的訂單'), [7], '年份與「8 月」不抓，孤零零的 7 照抓');
  assert.deepEqual(vals('2026-08-15 與 2026/8/15 各一筆'), [], 'YYYY-MM-DD／YYYY/MM/DD');
  assert.deepEqual(vals('8 月 15 日下單，8/15 出貨'), [], 'M月D日、M/D');
  assert.deepEqual(vals('09:30 開會、14:05 結束'), [], 'HH:mm');
  assert.deepEqual(vals('第 3 名、第3步、第 2 季、第 5 頁'), [], '第 N');
  assert.deepEqual(vals('1. 羊毛圍巾 65,340 元\n2、後背包 59,500 元\n3) 漁夫帽 32,560 元\n(4) 短夾 12,000 元'), [65340, 59500, 32560, 12000], '行首清單編號');
  // 金絲雀 q1 真成品的寫法：粗體編號「**1. 」、表格第一格的名次「| 1 |」都是編號；表格裡的量照抓
  assert.deepEqual(vals('**1. 官網衝上第一**\n- 2. 門市少了 39,280 元\n| 1 | 羊毛圍巾 | 65,340元 |\n| 2 | 後背包 | 59,500元 |'), [39280, 65340, 59500], '粗體編號、子彈下的編號、表格名次');
  assert.deepEqual(vals('| 退貨 | 17 筆 | 超過 2 倍 |'), [17, 2], '表格裡不是第一格的數照抓');
  assert.deepEqual(vals('Q1～Q4 與 SO00001 的編號'), [], 'Q1～Q4、字母接數字的編號');
  assert.deepEqual(vals('電話 02-2345-6789、0912-345-678'), [], '連字號串起的長數字');
  assert.deepEqual(vals('共 2026 件'), [2026], '不接「年」的四位數是量');
  assert.deepEqual(vals('版本 1.2.3'), [1.2], '版本號後段不再當數字');
  assert.deepEqual(extractNumbers(''), []);
  assert.deepEqual(extractNumbers(null), []);
});

test('對出處：程式輸出、數字檔（遞迴、數字字串也算）、上游、原始資料四路都算來源；四捨五入／截斷／%／0.43→43%／25.8 萬都對得上', () => {
  const ok = checkNumbers({
    product: '8 月營收 258,450 元（約 25.8 萬），較 7 月成長 14.4%；官網佔 47%、蝦皮 0.38；客單價 2,840 元；退貨 17 筆',
    printed: '八月營收: 258450\n增減百分比: 14.43\n客單價: 2840.7\n',
    numberFiles: [{ name: '數字-a.json', json: { 通路: { 官網: 0.4705, 蝦皮: '0.378' } } }],
    upstream: ['上一步：退貨 17 筆'],
    raw: [],
  });
  assert.deepEqual(ok.blocks, []);
  assert.equal(ok.checked, 7, '成品裡七個量（7、8 月不算）');
  // 四捨五入與截斷各一
  assert.deepEqual(checkNumbers({ product: '增 14.5%', printed: '增: 14.47' }).blocks, [], '四捨五入');
  assert.deepEqual(checkNumbers({ product: '增 14.4%', printed: '增: 14.47' }).blocks, [], '截斷');
  assert.deepEqual(checkNumbers({ product: '差額 -5,000 元', printed: '差額: 5000' }).blocks, [], '正負不計較');
  assert.deepEqual(checkNumbers({ product: '總數 999,123', raw: ['總數 999123'] }).blocks, [], '原始資料也是來源');
});

test('對不上：找不到出處的數字一條 number-unsourced（claim＝含它的句子、最多 80 字；source 空；detail 固定），同一個數字只記一次', () => {
  const r = checkNumbers({
    product: '8 月退貨率 15.7%，比 7 月高。退貨率 15.7% 是警訊。營收 258,450 元。',
    printed: '八月營收: 258450',
  });
  assert.equal(r.checked, 2);
  assert.equal(r.blocks.length, 1, '15.7% 出現兩次只記一次');
  assert.equal(r.blocks[0].kind, 'number-unsourced');
  assert.equal(r.blocks[0].claim, '8 月退貨率 15.7%，比 7 月高');
  assert.equal(r.blocks[0].source, '');
  assert.equal(r.blocks[0].detail, '這個數字在程式輸出、數字檔、前面步驟與原始資料裡都找不到（可能是順口算的）；要用就讓程式印出來或寫進數字檔');
  const long = checkNumbers({ product: `${'甲'.repeat(60)}退貨率 15.7%${'乙'.repeat(60)}`, printed: '營收: 1' });
  assert.ok(long.blocks[0].claim.length <= 80 && long.blocks[0].claim.includes('15.7%'), long.blocks[0].claim);
  const two = checkNumbers({ product: '退貨率 15.7%、成長 60.9%', printed: '營收: 1' });
  assert.deepEqual(two.blocks.map((b) => b.kind), ['number-unsourced', 'number-unsourced']);
});

test('對出處：來源一個數字都沒有＝不對（空 blocks、checked 0）；成品沒數字＝checked 0；數字檔壞掉的由呼叫端過濾', () => {
  assert.deepEqual(checkNumbers({ product: '退貨率 15.7%' }), { blocks: [], checked: 0 });
  assert.deepEqual(checkNumbers({ product: '退貨率 15.7%', printed: '', numberFiles: [], upstream: ['沒有數字的上游'], raw: ['本季'] }), { blocks: [], checked: 0 });
  assert.deepEqual(checkNumbers({ product: '沒有數字的成品', printed: '營收: 1' }), { blocks: [], checked: 0 });
  assert.deepEqual(checkNumbers({ product: '', printed: '營收: 1' }), { blocks: [], checked: 0 });
});

test('抓數字：合成數的尾數再接單位——「2萬5千」＝25,000、「3億2千萬」＝320,000,000；對出處時整個比（來源 25 對不上 2萬5千）', () => {
  const [a] = extractNumbers('目標 2萬5千 元');
  assert.deepEqual([a.value, a.decimals, a.raw], [25000, 0, '2萬5千']);
  const [b] = extractNumbers('市值 3億2千萬');
  assert.deepEqual([b.value, b.decimals, b.raw], [320000000, 0, '3億2千萬']);
  assert.deepEqual(vals('2萬5千 與 3億2千萬'), [25000, 320000000], '尾數與它的單位不再各自成一個數');
  assert.deepEqual(vals('營收25萬8,450元'), [258450], '尾數後面不接單位的合成數照舊');
  assert.deepEqual(checkNumbers({ product: '目標 2萬5千', printed: '目標: 25000' }).blocks, [], '程式印 25000 對得上');
  assert.deepEqual(checkNumbers({ product: '市值 3億2千萬', printed: '市值: 320000000' }).blocks, [], '程式印 320000000 對得上');
  assert.equal(checkNumbers({ product: '目標 2萬5千', printed: '目標: 25' }).blocks.length, 1, '合成數整個比，不把尾端的「千」當倍數');
});

test('抓數字：單位後面有一個空白的合成數——「25 萬 8,450」＝258,450（金絲雀 q10 真趟原文）；小數開頭照舊不合成；「25 萬」單獨仍是倍數寫法', () => {
  // 金絲雀 q10 真趟（results/20260924-2144/q10-bojian-1.json）first_blocks 的三句 claim 原文：數字全對卻被攔，只差單位前後的空白
  const c1 = '8月營收 25 萬 8,450 元，比 7 月（22 万 5,960 元）成長 14.4%';
  const c2 = '- 退貨：17 筆，退貨金額 5 萬 4,230 元';
  const c3 = '8月營收：25 萬 8,450 元';
  assert.deepEqual(vals(c1), [258450, 225960, 14.4], '整句抽三個數，不多不少（簡體 万 前後有空白也合成）');
  assert.deepEqual(vals(c2), [17, 54230]);
  assert.deepEqual(vals(c3), [258450]);
  const [a] = extractNumbers(c3);
  assert.deepEqual([a.value, a.decimals, a.raw], [258450, 0, '25 萬 8,450'], 'raw 含空白與尾數');
  assert.deepEqual(vals('22 萬 5,960 元'), [225960]);
  assert.deepEqual(vals('營收 25　萬　8,450 元'), [258450], '全形空白也准');
  assert.deepEqual(vals('目標 2 萬 5 千 元'), [25000], '尾數再接單位那段也准空白');
  assert.deepEqual(vals('25.8 萬 8,450'), [258000, 8450], '小數開頭的照舊不合成');
  assert.deepEqual(vals('營收 25 萬 元'), [250000], '「25 萬」單獨仍是 250,000 的倍數寫法');
  assert.deepEqual(vals('營收25萬8,450元，比7月的22万5,960元'), [258450, 225960], '沒空白的既有寫法一個不改壞');
  const printed = '八月營收: 258450\n七月營收: 225960\n退貨筆數: 17\n退貨金額: 54230\n增減百分比: 14.43\n';
  assert.deepEqual(checkNumbers({ product: c1, printed }).blocks, [], '真趟 c1：來源印 258450／225960 → 0 攔');
  assert.deepEqual(checkNumbers({ product: c2, printed }).blocks, [], '真趟 c2：來源印 54230 → 0 攔');
  assert.deepEqual(checkNumbers({ product: c3, printed }).blocks, [], '真趟 c3 → 0 攔');
  assert.deepEqual(checkNumbers({ product: '營收 25 萬 元', printed: '營收: 250000' }).blocks, [], '「25 萬」單獨仍照倍數寫法對 250000');
  assert.equal(checkNumbers({ product: '營收 25 萬 8,450 元', printed: '營收: 25.845' }).blocks.length, 1, '有空白的合成數整個比，不再除倍數');
});

test('抓數字：線性——5,000 列 CSV（30,000 個數字）來源側與成品側各在 1 秒內；找不到出處的 block 帶 number＝原文寫法', () => {
  const rows = [];
  for (let i = 0; i < 5000; i++) rows.push(`SO${String(i).padStart(5, '0')},${i},${1000 + i},${(i * 1.5).toFixed(1)},${i % 7},${2000 + i}`);
  const text = `編號,數量,單價,金額,折扣,總計\n${rows.join('\n')}\n`;
  let t0 = performance.now();
  assert.equal(extractNumbers(text, { all: true }).length, 30000);
  const srcMs = performance.now() - t0;
  assert.ok(srcMs < 1000, `來源側 30,000 個數字要在 1 秒內：${srcMs.toFixed(0)} ms`);
  t0 = performance.now();
  assert.equal(extractNumbers(text).length, 25000, '成品側：SO 編號那欄是字母接數字，不抓');
  const prodMs = performance.now() - t0;
  assert.ok(prodMs < 1000, `成品側 25,000 個數字要在 1 秒內：${prodMs.toFixed(0)} ms`);
  const r = checkNumbers({ product: '退貨率 15.7%、差額 -5,000 元', printed: '營收: 1' });
  assert.deepEqual(r.blocks.map((b) => b.number), ['15.7%', '-5,000'], 'block.number＝成品裡的原文寫法（沒程式權限時拿來標黃）');
});

test('分類：flags 認得 number-unsourced（沒程式權限時程式對數字只標不攔）；不認得的 kind 照舊丟掉', () => {
  const r = classify({ items: [], must_violations: [], flags: [{ kind: 'number-unsourced', detail: '有 2 個數字找不到出處' }, { kind: 'weird', detail: 'x' }], summary: '' });
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.flags, [{ kind: 'number-unsourced', detail: '有 2 個數字找不到出處' }]);
});

// ---- JSON 解析 ----

const RESULT_JSON = '{"items":[{"claim":"總數十三件","source":"明細原文","scope":"全月","calc":"6+3+4+1=14","verdict":"mismatch"}],"must_violations":[{"rule":"每段不超過三句","where":"第二段有五句"}],"flags":[{"kind":"format","detail":"沒用表格"}],"summary":"數字對不上"}';

test('查核結果解析：```json 圍欄、裸 JSON、前後夾雜文字三種都解得出來', () => {
  const fenced = ['我查完了：', '```json', RESULT_JSON, '```'].join('\n');
  const wrapped = ['以下是結果', RESULT_JSON, '有問題再說'].join('\n');
  for (const [name, text] of [['圍欄', fenced], ['裸 JSON', RESULT_JSON], ['夾雜文字', wrapped]]) {
    const r = parseCheckResult(text);
    assert.equal(r.items.length, 1, name);
    assert.equal(r.items[0].verdict, 'mismatch', name);
    assert.equal(r.must_violations[0].rule, '每段不超過三句', name);
    assert.equal(r.flags[0].kind, 'format', name);
    assert.equal(r.summary, '數字對不上', name);
  }
});

test('查核結果解析：完全沒有 JSON → CheckParseError；缺欄位補空陣列與空字串', () => {
  assert.throws(() => parseCheckResult('我看不懂這一步要查什麼'), CheckParseError);
  assert.throws(() => parseCheckResult(''), (e) => e.name === 'CheckParseError');
  const r = parseCheckResult('{"summary":"都對"}');
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.must_violations, []);
  assert.deepEqual(r.flags, []);
  assert.equal(r.summary, '都對');
  const bad = parseCheckResult('{"items":[],"flags":null,"summary":""}');
  assert.deepEqual(bad.items, []);
  assert.deepEqual(bad.must_violations, [], '沒寫的欄位補空陣列');
  assert.deepEqual(bad.flags, [], '值不是陣列也補空陣列');
  assert.equal(bad.summary, '');
  // 每個欄位的型別都不對＝看不出這是查核表，當沒查成（不是「查過且全過」）
  assert.throws(() => parseCheckResult('{"items":"不是陣列","must_violations":null}'), CheckParseError);
});

test('查核結果解析：回覆裡隨便一個大括號不算查過；整份逐項表是裸陣列也收得下', () => {
  assert.throws(() => parseCheckResult('{"error":"我沒有收到成品，無法查核"}'), CheckParseError, '查核員說他查不了＝沒查過，不是全過');
  assert.throws(() => parseCheckResult('我沒辦法查。設定看起來是 {"enabled": true} 這樣。'), CheckParseError, '夾雜的無關物件不算查核結果');
  assert.throws(() => parseCheckResult('{}'), CheckParseError, '空物件不算查過');

  const bareArray = parseCheckResult('[{"claim":"總數十三件","source":"明細原文","scope":"全月","calc":"","verdict":"mismatch"}]');
  assert.equal(bareArray.items.length, 1, '裸陣列＝逐項表');
  assert.equal(bareArray.items[0].verdict, 'mismatch');
  const c = classify(bareArray, { editRules: [] });
  assert.equal(c.status, 'blocked', '裸陣列裡的 mismatch 不准被吞掉');
  assert.deepEqual(c.blocks.map((b) => b.kind), ['number-mismatch']);

  const fencedArray = parseCheckResult(['```json', '[{"claim":"總數十三件","verdict":"mismatch"}]', '```'].join('\n'));
  assert.equal(fencedArray.items.length, 1, '圍欄裡的裸陣列也收');
});

test('查核結果解析：正文裡的中括號不准劫走抽取——要繼續往後找真正的查核結果', () => {
  const result = '{"items":[{"claim":"總數十三件","source":"明細原文","scope":"全月","calc":"6+3+4+1=14","verdict":"mismatch"}],"must_violations":[],"flags":[],"summary":"數字對不上"}';
  const cases = [
    ['空中括號在前', `本步驟沒有格式問題[]。\n${result}`],
    ['引用標記在前', `根据资料[来源1]，查核结果如下：${result}`],
    ['數字引用在前、後面還有話', `依照原始資料[1] 與明細[2]，${result}\n以上，若有疑問再說。`],
  ];
  for (const [name, text] of cases) {
    const r = parseCheckResult(text);
    assert.equal(r.items.length, 1, name);
    assert.equal(r.items[0].verdict, 'mismatch', name);
    assert.equal(r.summary, '數字對不上', name);
    assert.equal(classify(r, { editRules: [] }).status, 'blocked', `${name}：真的對不上不准被吞成 pass`);
  }

  // 空陣列不是逐項表——不能拿它當「查過且全過」交差，要繼續往後找
  const bare = parseCheckResult('先講結論[]。[{"claim":"總數十三件","verdict":"mismatch"}]');
  assert.equal(bare.items.length, 1, '前面的空陣列不算逐項表');
  assert.equal(bare.items[0].verdict, 'mismatch');

  // 但查核員自己交出完整的空結果物件（真的全過）照收
  const clean = parseCheckResult('{"items":[],"must_violations":[],"flags":[],"summary":"都對"}');
  assert.deepEqual(clean.items, []);
  assert.equal(classify(clean, { editRules: [] }).status, 'pass');

  // 包在外層物件裡也挖得到（外層過不了關就往內找）
  const nested = parseCheckResult('{"note":"見下","result":{"items":[{"claim":"總數十三件","verdict":"mismatch"}],"summary":"對不上"}}');
  assert.equal(nested.items.length, 1, '外層不是查核表就往裡面找');
  assert.equal(nested.summary, '對不上');
});

test('查核結果解析：誘餌物件不准劫走——候選計分擇優，有內容的贏過只有一句話的', () => {
  // 只帶一個 summary 的草稿在前、完整查核表在後：草稿不能贏
  const nested = parseCheckResult('{"draft":{"summary":"草稿別看這個"},"final":{"items":[{"claim":"總數十三件","source":"明細原文","scope":"全月","calc":"6+3+4+1=14","verdict":"mismatch"}],"must_violations":[],"flags":[],"summary":"數字對不上"}}');
  assert.equal(nested.items.length, 1, '巢狀誘餌不准吞掉真的查核表');
  assert.equal(nested.items[0].verdict, 'mismatch');
  assert.equal(nested.summary, '數字對不上');
  assert.equal(classify(nested, { editRules: [] }).status, 'blocked', '真的對不上不准被吞成 pass');

  // 頂層誘餌：查核員先貼一段「輸出格式範例」再貼真結果
  const decoy = parseCheckResult(`輸出格式範例：{"summary":"這只是範例"} 實際查核結果如下：${RESULT_JSON}`);
  assert.equal(decoy.items.length, 1, '範例物件不算查核結果');
  assert.equal(decoy.items[0].verdict, 'mismatch');
  assert.equal(decoy.summary, '數字對不上');
});

//：查核員被要求「只輸出一個 JSON 物件」，回覆裡有好幾份一樣像的結果＝交件不合格，誠實說沒查成，不准靠位置猜
const OTHER_JSON = '{"items":[{"claim":"總數 14 件","source":"明細原文","scope":"全月","calc":"6+3+4+1=14","verdict":"ok"}],"must_violations":[],"flags":[],"summary":"都對"}';

test('查核結果解析：候選政策——有內容優先、外層優先、兩份不同的結果＝含糊就丟錯、一字不差的重複不算含糊', () => {
  // 欄位數不對稱：範例四個欄位齊全但全空、真結果少寫一個 flags——比欄位數會讓範例贏，有內容的要贏
  const real = '{"items":[{"claim":"總數十三件","source":"明細原文","scope":"全月","calc":"6+3+4+1=14","verdict":"mismatch"}],"must_violations":[],"summary":"數字對不上"}';
  const asym = parseCheckResult(`輸出格式範例：{"items":[],"must_violations":[],"flags":[],"summary":"這只是範例"} 實際查核結果如下：${real}`);
  assert.equal(asym.items.length, 1, '有內容的贏過欄位齊全但全空的範例');
  assert.equal(asym.items[0].verdict, 'mismatch');
  assert.equal(asym.summary, '數字對不上');
  assert.equal(classify(asym, { editRules: [] }).status, 'blocked', '真的對不上不准被吞成 pass');

  // 外層優先：真結果裡多塞了一個 meta 子物件、長得跟查核表一模一樣——被包住的不算
  const outer = parseCheckResult('{"items":[{"claim":"A項","verdict":"mismatch"}],"must_violations":[],"flags":[],"summary":"外層","meta":{"items":[{"claim":"B項","verdict":"ok"}],"must_violations":[],"flags":[],"summary":"內層"}}');
  assert.equal(outer.items[0].claim, 'A項', '被包住的子物件不准贏過它的外層');
  assert.equal(outer.summary, '外層');

  // 兩份都完整、都有內容、內容不同——分不出哪份是真的，不准靠位置猜，丟錯
  assert.throws(() => parseCheckResult(`${RESULT_JSON}\n${OTHER_JSON}`), (e) => e instanceof CheckParseError && /不只一份/.test(e.message), '兩份不同結果＝含糊');
  assert.throws(() => parseCheckResult(`${OTHER_JSON}\n${RESULT_JSON}`), CheckParseError, '順序反過來也一樣——沒有位置裁判');
  assert.throws(() => parseCheckResult('{"summary":"前面這句是鋪陳"}\n{"summary":"最後這句才是結論"}'), CheckParseError, '兩句不同的 summary 也是含糊（舊的「取最後出現」裁判已移除）');

  // 同一份寫了兩次＝重複，不是含糊
  const dup = parseCheckResult(`${RESULT_JSON}\n${RESULT_JSON}`);
  assert.equal(dup.items.length, 1);
  assert.equal(dup.summary, '數字對不上');
  const dup2 = parseCheckResult('{"summary":"都對"}\n{"summary":"都對","note":"再說一次"}');
  assert.equal(dup2.summary, '都對', '多了無關欄位、正規化後一樣＝同一份');
});

test('查核結果解析：圍欄不優先——圍欄內外同一個池；兩個圍欄各一份不同結果是含糊；圍欄裡沒像樣的就看正文', () => {
  const fence = (s) => `\`\`\`json\n${s}\n\`\`\``;
  // 圍欄裡一份、正文另有一份完整的不同結果：圍欄不是護身符，兩份不同＝含糊（ 移除「圍欄優先」）
  assert.throws(() => parseCheckResult(`草稿：${OTHER_JSON}\n最後結果：\n${fence(RESULT_JSON)}`), CheckParseError, '圍欄內外各一份不同');
  // 兩個圍欄、兩份不同結果：沒有「第一個圍欄贏」這種位置裁判
  assert.throws(() => parseCheckResult(`${fence(OTHER_JSON)}\n\n${fence(RESULT_JSON)}`), CheckParseError, '兩個圍欄');
  // 圍欄裡兩份不同、正文再一份：一樣含糊
  assert.throws(() => parseCheckResult(`${fence(`${OTHER_JSON}\n${RESULT_JSON}`)}\n正文：${RESULT_JSON}`), CheckParseError, '圍欄裡含糊');
  // 圍欄裡沒有像樣的東西，正文那份照收
  assert.equal(parseCheckResult(`${fence('{"note":"沒東西"}')}\n${RESULT_JSON}`).summary, '數字對不上');
  // 同一份在兩個圍欄各寫一次＝重複
  assert.equal(parseCheckResult(`${fence(RESULT_JSON)}\n${fence(RESULT_JSON)}`).summary, '數字對不上');
});

//：被包住的候選只有名次不高於外層才丟——空殼包著真結果、裸陣列包著真結果物件，內層更像就留下來贏
test('查核結果解析：裁定 9——包住真結果的空殼不准贏、裸陣列裡的結果物件贏過陣列、圍欄裡的範例不再優先', () => {
  const real = '{"items":[{"claim":"總數十三件","source":"明細原文","scope":"全月","calc":"6+3+4+1=14","verdict":"mismatch"}],"must_violations":[],"flags":[],"summary":"數字對不上"}';
  const expectReal = (r, name) => {
    assert.equal(r.items.length, 1, name);
    assert.equal(r.items[0].claim, '總數十三件', name);
    assert.equal(r.summary, '數字對不上', name);
    const c = classify(r, { editRules: [] });
    assert.equal(c.status, 'blocked', `${name}：真的對不上不准被吞成 pass`);
    assert.deepEqual(c.blocks.map((b) => b.kind), ['number-mismatch'], name);
  };
  // 覆核 Critical：欄位齊全但全空的殼，把真結果包在自己裡面——殼的名次低於內層，內層要留下來贏
  expectReal(parseCheckResult(`{"items":[],"must_violations":[],"flags":[],"summary":"以下是查核結果","結果":${real}}`), '空殼包著真結果');
  // 覆核 Important：整份是裸陣列、唯一元素就是完整結果物件——物件（層級 2）贏過陣列（層級 1），不准降級成逐項表
  expectReal(parseCheckResult(`[${real}]`), '裸陣列包著結果物件');
  // 覆核 (a)：範例放在圍欄裡、真結果在正文——圍欄不再優先，有內容的贏
  expectReal(parseCheckResult(`格式範例：\n\`\`\`json\n{"items":[],"must_violations":[],"flags":[],"summary":"這只是範例"}\n\`\`\`\n實際查核結果：${real}`), '圍欄裡的範例');
  // 空殼包著兩份不同的真結果：兩份都留下來、同名次不一樣＝含糊
  assert.throws(() => parseCheckResult(`{"items":[],"must_violations":[],"flags":[],"summary":"兩份","a":${real},"b":${OTHER_JSON}}`), (e) => e instanceof CheckParseError && /不只一份/.test(e.message), '殼裡兩份不同');
});

test('查核結果解析：裸陣列只是退路——挑得出像樣的物件就不准讓陣列贏', () => {
  // 查核員只交必守違規：物件裡那個非空陣列不准被當成逐項表讀走（違規會變成 verdict 空的 unsupported）
  for (const [name, text] of [
    ['帶 summary', '{"must_violations":[{"rule":"每段不超過三句","where":"第二段"}],"summary":"違反必守"}'],
    ['不帶 summary', '{"must_violations":[{"rule":"每段不超過三句","where":"第二段"}]}'],
  ]) {
    const r = parseCheckResult(text);
    assert.deepEqual(r.items, [], `${name}：違規條目不是逐項表`);
    assert.equal(r.must_violations.length, 1, name);
    const c = classify(r, { editRules: [] });
    assert.deepEqual(c.blocks.map((b) => b.kind), ['must'], `${name}：要當必守違規攔，不是 unsupported`);
    assert.equal(c.items.length, 0, name);
  }
  assert.equal(parseCheckResult('{"must_violations":[{"rule":"每段不超過三句","where":"第二段"}],"summary":"違反必守"}').summary, '違反必守');

  // 沒有任何像樣的物件時，裸陣列仍是退路（同分取最後出現的）
  const only = parseCheckResult('[{"claim":"總數十三件","verdict":"mismatch"}]');
  assert.equal(only.items.length, 1, '整份只有裸陣列時照收');
  const behind = parseCheckResult('先講結論[]。[{"claim":"總數十三件","verdict":"mismatch"}]');
  assert.equal(behind.items[0].claim, '總數十三件', '正文括號在前仍找得到裸陣列');
});

// ---- 分類 ----

test('分類：mismatch→number-mismatch、unsupported→unsupported；查核員說 ok 就是 ok——不再用 calc 翻案（ADR-010：數字由程式對）', () => {
  const r = classify({
    items: [
      { claim: '總數十三件', source: '明細原文', scope: '全月', calc: '6+3+4+1=14', verdict: 'mismatch' },
      { claim: '成長最快是 C', source: '', scope: '', calc: '', verdict: 'UNSUPPORTED' },
      { claim: '合計 14 件', source: '明細原文', scope: '全月', calc: '6+3+2+1=14', verdict: 'ok' },
      { claim: '毛利率 30%', source: '明細原文', scope: '全月', calc: '', verdict: 'ok' },
    ],
    must_violations: [],
    flags: [],
    summary: '一句話',
  }, { editRules: [] });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.blocks.map((b) => b.kind), ['number-mismatch', 'unsupported'], 'ok 但算式假的那條不再被程式翻成攔');
  assert.equal(r.blocks[0].claim, '總數十三件');
  assert.equal(r.blocks[0].source, '明細原文');
  assert.equal(r.blocks[0].detail, '6+3+4+1=14', '舊趟查核員填的 calc 還是當說明帶著');
  assert.equal(r.items.length, 4, '逐項表原樣帶回');
  assert.equal(r.items[1].verdict, 'unsupported', 'verdict 轉小寫');
  assert.equal(r.summary, '一句話');
});

test('分類：查核員說 ok 但算式不成立（含帶單位的）→ 照 ok 放行；verifyArithmetic 本身還在、只是 classify 不再用它', () => {
  const r = classify({
    items: [
      { claim: '合計 14 件', source: '明細原文', scope: '全月', calc: '6+3+2+1=14 件', verdict: 'ok' },
      { claim: '合計 14 件', source: '明細原文', scope: '全月', calc: '6+3+2+1=14', verdict: 'ok' },
    ],
    must_violations: [], flags: [], summary: '都對',
  }, { editRules: [] });
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.blocks, []);
  assert.equal(verifyArithmetic('6+3+2+1=14'), false, '驗算函式留著給別處用');
});

test('分類：must_violation 撞停點規則→stop-edit，其餘→must；未知 flag 丟掉', () => {
  const r = classify({
    items: [],
    must_violations: [
      { rule: '每段不超過三句', where: '第二段有五句' },
      { rule: '保留120分鐘', where: '寫成 90 分鐘' },
    ],
    flags: [
      { kind: 'conclusion-changed', detail: '上游排 D 第一，成品改成 C 第一' },
      { kind: '自己發明的', detail: '不算' },
    ],
    summary: '',
  }, { editRules: ['保留 120 分鐘'] });
  assert.deepEqual(r.blocks.map((b) => b.kind), ['must', 'stop-edit']);
  assert.equal(r.blocks[1].claim, '保留120分鐘', 'block 的 claim＝被違反的那條規則');
  assert.equal(r.blocks[1].detail, '寫成 90 分鐘');
  assert.equal(r.blocks[1].source, '');
  assert.deepEqual(r.flags, [{ kind: 'conclusion-changed', detail: '上游排 D 第一，成品改成 C 第一' }]);
  assert.equal(r.status, 'blocked');
});

test('分類：只有 missing→status missing；全乾淨→pass', () => {
  const m = classify({
    items: [
      { claim: '九月的客戶名單', source: '', scope: '', calc: '', verdict: 'missing' },
      { claim: '總數 14 件', source: '明細原文', scope: '全月', calc: '6+3+4+1=14', verdict: 'ok' },
    ],
    must_violations: [], flags: [], summary: '缺一份名單',
  }, { editRules: [] });
  assert.equal(m.status, 'missing');
  assert.deepEqual(m.blocks, []);
  assert.equal(m.missing.length, 1);
  assert.equal(m.missing[0].claim, '九月的客戶名單');

  const ok = classify({ items: [{ claim: '總數 14 件', source: '明細原文', scope: '全月', calc: '6+3+4+1=14', verdict: 'ok' }], must_violations: [], flags: [], summary: '都對' }, { editRules: [] });
  assert.equal(ok.status, 'pass');
  assert.deepEqual(ok.blocks, []);
  assert.deepEqual(ok.missing, []);
});

// ---- 查核 prompt ----

test('查核 prompt：段標題齊、必守逐條列、判定規則六條與輸出格式範例、成品放最後', () => {
  const p = buildCheckPrompt({
    title: '寫八月月報',
    requirements: REQ,
    sources: '【欄位：月份】\n八月',
    product: '八月共 14 件',
  });
  for (const h of ['# 這一步', '# 必守（逐條對）', '# 格式要求', '# 判定規則', '# 輸出格式', '# 原始資料', '# 成品']) {
    assert.ok(p.includes(h), `缺段落 ${h}`);
  }
  assert.ok(p.includes('寫八月月報') && p.includes('把明細寫成八月月報'));
  assert.ok(p.includes('- 數字要對') && p.includes('- 每段不超過三句'), '驗收重點逐條列');
  assert.ok(p.includes('- 保留 120 分鐘'), '停點改過的要求也是必守');
  assert.ok(p.includes('不超過一頁') && p.includes('Markdown 表格'));
  const rulesSection = p.slice(p.indexOf('# 判定規則'), p.indexOf('# 輸出格式'));
  assert.equal((rulesSection.match(/^\d\. /gm) ?? []).length, 6, '判定規則要六條');
  assert.ok(/mismatch/.test(rulesSection) && /unsupported/.test(rulesSection) && /missing/.test(rulesSection), 'verdict 定義');
  assert.ok(rulesSection.includes('conclusion-changed') && rulesSection.includes('format'), 'flags 只有兩種');
  // ADR-010 決策 2：查核員只查文字事實——第 1～3 條逐字；不再教算式、不再有 calc
  assert.equal(
    rulesSection.match(/^1\. .*$/m)[0],
    '1. 把成品裡每一個原始資料裡查得到的文字主張（名稱、事件、排序、引用、時程、規格）列成一項，逐項回到原始資料裡找根據。數字一律不列、不驗算——成品裡的數字已由程式對過，不是你的工作。需要自己加總、排序、統計整張表才能判斷的主張（例如誰是第一名、哪個通路最多）也不列——那些數字由程式對過。只列能在原始資料裡直接找到對應句子或欄位值的主張。',
  );
  assert.equal(
    rulesSection.match(/^2\. .*$/m)[0],
    '2. verdict 只有四種：ok＝原始資料撐得住；mismatch＝跟原始資料對不上；unsupported＝原始資料裡找不到根據；missing＝指示要這一項但原始資料本來就沒有。unsupported 只用在事實性主張（事件、引用、名稱、時程、規格）；這一步被指示要做的判斷、評分、排序、建議本身不需要出處，但它引用的事實要有。source 抄原始資料的逐字原文，不准改寫或轉述；scope 寫清楚這個主張涵蓋的範圍（期間、類別、對象）。',
  );
  assert.equal(
    rulesSection.match(/^3\. .*$/m)[0],
    '3. 成品裡標「推測」「估計」「可能」「約」的句子不列。一句話裡除了數字沒有別的主張，整句跳過。',
  );
  assert.ok(!rulesSection.includes('算式') && !rulesSection.includes('calc'), `判定規則不再提算式與 calc：${rulesSection}`);
  assert.ok(p.includes('"must_violations"') && p.includes('"verdict"') && p.includes('"scope"'), '輸出格式範例');
  const example = p.slice(p.indexOf('# 輸出格式'), p.indexOf('# 原始資料'));
  assert.ok(!example.includes('calc'), `輸出範例沒有 calc 欄位：${example}`);
  assert.ok(!/\d/.test(example.match(/"claim":"([^"]*)"/)[1]), '範例的 claim 是文字主張，不是數字');
  assert.ok(p.indexOf('# 原始資料') < p.indexOf('# 成品'), '原始資料在成品前');
  assert.ok(p.includes('【欄位：月份】'));
  assert.ok(p.trimEnd().endsWith('八月共 14 件'), '成品放最後');

  const bare = buildCheckPrompt({ title: '無要求', requirements: { instruction: '做', constraints: '', reviewFocus: '', outputFormat: '', editRules: [] }, sources: '', product: '成品' });
  assert.ok(bare.slice(bare.indexOf('# 必守（逐條對）'), bare.indexOf('# 格式要求')).includes('（無）'));
  assert.ok(bare.slice(bare.indexOf('# 格式要求'), bare.indexOf('# 判定規則')).includes('（無）'));
});

// ---- facts 開關與監工備註 ----

test('查核 prompt：流程沒開「數字對原始資料」→ 判定規則換成只對必守與格式四條、原始資料段講明沒開', () => {
  const p = buildCheckPrompt({
    title: '寫八月月報',
    requirements: { ...REQ, factsOff: true },
    sources: '',
    product: '八月共 14 件',
  });
  const rules = p.slice(p.indexOf('# 判定規則'), p.indexOf('# 輸出格式'));
  assert.ok(
    rules.includes('1. 這一步的主要工作是：使用者要求一定要有的東西，成品裡有沒有對應內容——逐條找。成品裡的事實不對照原始資料，items 給空清單。'),
    `第一條要逐字：${rules}`,
  );
  assert.ok(!rules.includes('逐項回到原始資料裡找根據'), '不再逐項對原始資料');
  assert.equal((rules.match(/^\d\. /gm) ?? []).length, 4, '只剩四條');
  assert.ok(rules.includes('「必守」逐條檢查') && rules.includes('conclusion-changed') && rules.includes('只輸出一個 JSON 物件'), '原第 4、5、6 條重新編號留著');
  const src = p.slice(p.indexOf('# 原始資料'), p.indexOf('# 成品'));
  assert.ok(src.includes('（本流程沒開數字對原始資料，只對必守與格式）'), `原始資料段：${src}`);
  assert.ok(p.includes('- 數字要對') && p.includes('不超過一頁'), '必守與格式要求照舊');
});

test('查核 prompt：factsOff 缺省 → 還是原來的六條，照樣對原始資料', () => {
  const p = buildCheckPrompt({ title: '寫八月月報', requirements: REQ, sources: '【欄位：月份】\n八月', product: '成品' });
  const rules = p.slice(p.indexOf('# 判定規則'), p.indexOf('# 輸出格式'));
  assert.equal((rules.match(/^\d\. /gm) ?? []).length, 6, '缺省六條');
  assert.ok(rules.includes('逐項回到原始資料裡找根據'));
  assert.ok(!rules.includes('成品裡的事實不對照原始資料'));
  assert.ok(p.includes('【欄位：月份】\n八月') && !p.includes('沒開數字對原始資料'));
});

test('查核 prompt：監工備註自成一段（參考，不是必守），不混進必守', () => {
  const p = buildCheckPrompt({
    title: '寫八月月報',
    requirements: { ...REQ, supervisorNotes: ['交接：按三類分節'] },
    sources: '',
    product: '成品',
  });
  assert.ok(p.includes('# 監工備註（參考，不是必守）'), '要有監工備註段');
  assert.ok(p.includes('- 交接：按三類分節'), '備註逐條列');
  const musts = p.slice(p.indexOf('# 必守（逐條對）'), p.indexOf('# 格式要求'));
  assert.ok(!musts.includes('按三類分節'), `監工備註不准進必守：${musts}`);
  assert.ok(p.indexOf('# 格式要求') < p.indexOf('# 監工備註'), '監工備註在格式要求之後');
  assert.ok(p.indexOf('# 監工備註') < p.indexOf('# 判定規則'), '監工備註在判定規則之前');

  const none = buildCheckPrompt({ title: 'x', requirements: REQ, sources: '', product: '成品' });
  assert.ok(!none.includes('# 監工備註'), '沒備註就不出這一段');
});

// ---- 群組規矩併進必守 ----

test('查核 prompt：群組規矩是必守第三路（驗收重點→停點規則→群組規矩）；違反歸既有 must 攔；省略時逐字不變', () => {
  const p = buildCheckPrompt({
    title: '寫八月月報',
    requirements: { ...REQ, groupRules: ['不提競品', '語氣：輕鬆'] },
    sources: '',
    product: '成品',
  });
  const musts = p.slice(p.indexOf('# 必守（逐條對）'), p.indexOf('# 格式要求'));
  assert.ok(musts.includes('- 不提競品') && musts.includes('- 語氣：輕鬆'), `群組規矩要進必守：${musts}`);
  assert.ok(musts.indexOf('- 保留 120 分鐘') < musts.indexOf('- 不提競品'), '排在停點規則之後');
  assert.ok(!p.includes('關於你'), '查核員不帶「關於你」');
  // 空白條與空清單都不出現；省略＝現況
  const same = buildCheckPrompt({ title: '寫八月月報', requirements: { ...REQ, groupRules: ['  ', ''] }, sources: 'x', product: 'y' });
  assert.equal(same, buildCheckPrompt({ title: '寫八月月報', requirements: REQ, sources: 'x', product: 'y' }));
  // 查核員說違反了群組規矩→既有的 must 類攔下（不是 stop-edit）
  const r = classify({ items: [], must_violations: [{ rule: '不提競品', where: '第二段提到對手' }], flags: [], summary: '' }, { editRules: REQ.editRules });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.blocks.map((b) => b.kind), ['must']);
});

// factsOff 缺省（未改動前）的完整輸出——快照，鎖住預設路徑一個字都不准變
const SNAPSHOT_DEFAULT_PROMPT = "你是「剝繭」流程的交貨查核員。這一步的成品已經做好，你的工作是拿原始資料與使用者的要求逐條對它，把對不上的地方挑出來。\n你不改成品、不補內容、不評論好不好——只回報事實對不對、要求有沒有守。原始資料裡沒有的東西，一律不准當成常識自己補。\n全篇使用與「這一步」相同的語言。\n\n# 這一步：寫八月月報\n把明細寫成八月月報\n\n# 必守（逐條對）\n- 數字要對\n- 每段不超過三句\n- 保留 120 分鐘\n\n# 格式要求\n不超過一頁\nMarkdown 表格\n\n# 判定規則\n1. 把成品裡每一個原始資料裡查得到的文字主張（名稱、事件、排序、引用、時程、規格）列成一項，逐項回到原始資料裡找根據。數字一律不列、不驗算——成品裡的數字已由程式對過，不是你的工作。需要自己加總、排序、統計整張表才能判斷的主張（例如誰是第一名、哪個通路最多）也不列——那些數字由程式對過。只列能在原始資料裡直接找到對應句子或欄位值的主張。\n2. verdict 只有四種：ok＝原始資料撐得住；mismatch＝跟原始資料對不上；unsupported＝原始資料裡找不到根據；missing＝指示要這一項但原始資料本來就沒有。unsupported 只用在事實性主張（事件、引用、名稱、時程、規格）；這一步被指示要做的判斷、評分、排序、建議本身不需要出處，但它引用的事實要有。source 抄原始資料的逐字原文，不准改寫或轉述；scope 寫清楚這個主張涵蓋的範圍（期間、類別、對象）。\n3. 成品裡標「推測」「估計」「可能」「約」的句子不列。一句話裡除了數字沒有別的主張，整句跳過。\n4. 「必守」逐條檢查，違反的寫進 must_violations：rule 抄那一條原文，where 寫成品哪裡違反。\n5. flags 只有兩種：conclusion-changed＝成品改了上游的結論或排序；format＝格式跟要求不同。其他一律不要寫。\n6. 只輸出一個 JSON 物件，前後不要任何其他文字。\n\n# 輸出格式\n{\"items\":[{\"claim\":\"退貨最多的是羊毛圍巾\",\"source\":\"…原文逐字…\",\"scope\":\"8 月、全部通路\",\"verdict\":\"mismatch\"}],\n \"must_violations\":[{\"rule\":\"每段不超過三句\",\"where\":\"第二段有五句\"}],\n \"flags\":[{\"kind\":\"conclusion-changed\",\"detail\":\"上游排 D 第一，成品改成 C 第一，理由是…\"}],\n \"summary\":\"一句話\"}\n\n# 原始資料（使用者給的檔與欄位）\n【欄位：月份】\n八月\n\n# 成品\n八月共 14 件";

test('查核 prompt：factsOff 缺省時逐字不變（回歸快照，鎖住預設路徑）', () => {
  const p = buildCheckPrompt({
    title: '寫八月月報',
    requirements: REQ,
    sources: '【欄位：月份】\n八月',
    product: '八月共 14 件',
  });
  assert.equal(p, SNAPSHOT_DEFAULT_PROMPT, 'factsOff 缺省時，開場白與輸出範例都不准跟著 factsOff 分支一起被改壞');
});

test('查核 prompt：factsOff 時開場白與輸出範例不再教查核員對原始資料', () => {
  const p = buildCheckPrompt({
    title: '寫八月月報',
    requirements: { ...REQ, factsOff: true },
    sources: '',
    product: '八月共 14 件',
  });
  assert.ok(!p.includes('拿原始資料'), `factsOff 時不該再叫查核員拿原始資料：${p.slice(0, 160)}`);
  assert.ok(!p.includes('一律不准當成常識自己補'), '這句話預設沒有原始資料可查時不成立，factsOff 不該出現');
  assert.ok(p.includes('"items":[]'), '輸出範例的 items 該換成空清單');
  assert.ok(!p.includes('"verdict":"mismatch"'), '不該再示範一個填滿的 mismatch item，會誤導模型自己找數字來對');
});

// ---- 原始資料組裝 ----

test('原始資料組裝（ADR-009 ⑤）：前段＝欄位→補的資料→參考檔（每檔截 perFile）；祖先步驟產出另立「# 前面步驟的整理」段接在後面、依給定順序', () => {
  const s = buildSources({
    params: { month: '八月', tone: '輕鬆' },
    paramLabels: { month: '月份' },
    ancestors: [{ title: '收集資料', text: 'AAA' }, { title: '整理表格', text: 'BBB' }],
    supplied: '我補的名單',
    attachments: [{ name: '規範.md', text: 'x'.repeat(50) }],
  }, { perFile: 10 });
  const at = (t) => { const i = s.indexOf(t); assert.notEqual(i, -1, `缺 ${t}`); return i; };
  assert.ok(at('【欄位：月份】') < at('【欄位：tone】'), '欄位照插入順序，沒 label 就用 key');
  assert.ok(at('【欄位：tone】') < at('【你補的資料】'), '補的資料緊接欄位（都是使用者給的）');
  assert.ok(at('【你補的資料】') < at('【參考檔：規範.md】'));
  assert.ok(at('【參考檔：規範.md】') < at(UPSTREAM_HEADING), '祖先產出的段標題在使用者給的東西之後');
  assert.ok(at(UPSTREAM_HEADING) < at('【步驟：收集資料】') && at('【步驟：收集資料】') < at('【步驟：整理表格】'), '祖先照給定順序、都在後段');
  assert.equal(UPSTREAM_HEADING, '# 前面步驟的整理（不是原始資料；跟原始資料衝突時以原始資料為準）');
  assert.equal((s.match(/^# /gm) ?? []).length, 1, '只有一個段標題（前段的標題由 buildCheckPrompt 給）');
  assert.ok(s.includes('【欄位：月份】\n八月') && s.includes('【步驟：收集資料】\nAAA'));
  assert.ok(s.includes(`【參考檔：規範.md】\n${'x'.repeat(10)}\n\n${UPSTREAM_HEADING}`), `參考檔截到 perFile：${JSON.stringify(s)}`);
  assert.ok(s.endsWith('【步驟：整理表格】\nBBB'), '祖先產出收尾');

  const none = buildSources({ params: {}, paramLabels: {}, ancestors: [{ title: '只有這步', text: 'A' }], supplied: '', attachments: [] });
  assert.ok(!none.includes('【你補的資料】'), '沒補資料就不出這一段');
  assert.ok(none.startsWith(`（無）\n\n${UPSTREAM_HEADING}\n【步驟：只有這步】\nA`), `前段空著要寫（無），標題底下不能直接接另一個標題：${none}`);

  const noUp = buildSources({ params: { a: '甲' }, ancestors: [], attachments: [{ name: 'r.md', text: 'R' }] });
  assert.equal(noUp, '【欄位：a】\n甲\n\n【參考檔：r.md】\nR', '沒有祖先產出＝沒有後段、沒有那個標題');
});

test('原始資料組裝（ADR-009 ⑤）：兩段進查核 prompt——「# 原始資料（使用者給的檔與欄位）」底下是欄位與參考檔、「# 前面步驟的整理」底下是祖先產出，都在成品之前', () => {
  const sources = buildSources({
    params: { month: '八月' }, paramLabels: { month: '月份' },
    ancestors: [{ title: '算數字', text: '總數 14 件' }],
    attachments: [{ name: 'sales.csv（這次上傳）', text: 'a,b\n1,2' }],
  });
  const p = buildCheckPrompt({ title: '寫八月月報', requirements: REQ, sources, product: '八月共 14 件' });
  const i = (t) => { const k = p.indexOf(t); assert.notEqual(k, -1, `缺 ${t}`); return k; };
  assert.ok(i('# 原始資料（使用者給的檔與欄位）') < i('【欄位：月份】\n八月'));
  assert.ok(i('【欄位：月份】') < i('【參考檔：sales.csv（這次上傳）】\na,b\n1,2'));
  assert.ok(i('【參考檔：sales.csv（這次上傳）】') < i(UPSTREAM_HEADING));
  assert.ok(i(UPSTREAM_HEADING) < i('【步驟：算數字】\n總數 14 件'));
  assert.ok(i('【步驟：算數字】') < i('# 成品'));
  const h1 = p.split('\n').filter((l) => /^# /.test(l));
  assert.deepEqual(h1, ['# 這一步：寫八月月報', '# 必守（逐條對）', '# 格式要求', '# 判定規則', '# 輸出格式', '# 原始資料（使用者給的檔與欄位）', UPSTREAM_HEADING, '# 成品']);
  // 開場白與判定規則裡的「原始資料」照舊指前段
  assert.ok(p.startsWith('你是「剝繭」流程的交貨查核員。這一步的成品已經做好，你的工作是拿原始資料與使用者的要求逐條對它'));
  assert.ok(p.includes('逐項回到原始資料裡找根據'));
});

test('原始資料組裝：總量超過上限從最前面截，開頭標明已截斷', () => {
  const s = buildSources({
    params: { a: 'A'.repeat(100) },
    paramLabels: { a: '甲' },
    ancestors: [{ title: '尾', text: 'Z'.repeat(60) }],
    supplied: '',
    attachments: [],
  }, { cap: 60 });
  assert.ok(s.startsWith('（前面已截斷，只保留最近的資料）'), s.slice(0, 40));
  assert.ok(s.length <= 60, `總量要壓在 cap 內，實際 ${s.length}`);
  // 原始資料自己就超過上限：後段（上游整理）整段讓路，原始資料從最前面截、留最後面的
  assert.ok(s.endsWith('A'.repeat(20)) && !s.includes('【步驟：尾】'), `留下的是原始資料的最後面，上游整理讓路：${s}`);
  assert.ok(!s.includes('【欄位：甲】'), '最前面的欄位標題被截掉');
  // 兩段之後（ADR-009「原始資料為準」）：超過上限先砍後段（前面步驟的整理，從它最前面截、留最近的步驟），
  // 原始資料整段留著；後段砍光還不夠才輪到原始資料
  const two = buildSources({
    params: { a: 'A'.repeat(100) }, paramLabels: { a: '甲' },
    ancestors: [{ title: '頭', text: 'Y'.repeat(200) }, { title: '尾', text: 'Z'.repeat(20) }],
    attachments: [{ name: 'r.md', text: 'R'.repeat(20) }],
  }, { cap: 260 });
  assert.ok(two.startsWith('【欄位：甲】'), `原始資料整段留在最前面：${two.slice(0, 40)}`);
  assert.ok(two.includes('【參考檔：r.md】'), '參考檔也留著');
  assert.ok(two.length <= 260, `總量要壓在 cap 內，實際 ${two.length}`);
  assert.ok(two.includes(`${UPSTREAM_HEADING}\n（前面已截斷，只保留最近的資料）`), `後段標題留著、標題底下標明截過：${two}`);
  assert.ok(two.endsWith(`【步驟：尾】\n${'Z'.repeat(20)}`) && !two.includes('【步驟：頭】'), '後段留的是最近的步驟');
  // 後段砍光還不夠 → 才砍原始資料（從最前面截），行為同單段時
  const three = buildSources({
    params: { a: 'A'.repeat(300) }, paramLabels: { a: '甲' },
    ancestors: [{ title: '尾', text: 'Z'.repeat(20) }],
  }, { cap: 100 });
  assert.ok(three.startsWith('（前面已截斷，只保留最近的資料）') && three.length <= 100 && !three.includes(UPSTREAM_HEADING), `原始資料自己就超過上限：${three.slice(0, 60)}`);
});

// L070：總量上限比提示語「（前面已截斷，只保留最近的資料）」本身還短 → 連提示語都塞不下，直接回空字串（回傳永遠不超過 cap）
test('原始資料組裝：上限小於提示語長度 → 回空字串，不會回一句比上限還長的提示語', () => {
  const args = { params: { a: 'A'.repeat(100) }, paramLabels: { a: '甲' }, ancestors: [{ title: '尾', text: 'Z'.repeat(60) }], supplied: '', attachments: [] };
  for (const cap of [0, 1, 5, 16]) { // 提示語含換行共 17 字，這幾個都塞不下
    const s = buildSources(args, { cap });
    assert.equal(s, '', `cap=${cap} 要回空字串，實際：${JSON.stringify(s)}`);
    assert.ok(s.length <= cap, `cap=${cap} 回傳不得超過上限`);
  }
  // 只有原始資料、沒有上游整理也一樣
  assert.equal(buildSources({ params: { a: 'A'.repeat(100) }, paramLabels: { a: '甲' } }, { cap: 5 }), '');
  // 上限剛好等於提示語長度＝提示語本身（長度＝cap，沒超過）
  const head = '（前面已截斷，只保留最近的資料）\n';
  const exact = buildSources(args, { cap: head.length });
  assert.ok(exact.length <= head.length, `cap=提示語長度時回傳不得超過上限，實際 ${exact.length}`);
  // 沒超過上限的照舊逐字回
  assert.equal(buildSources({ params: { a: '甲' }, paramLabels: { a: 'A' } }, { cap: 5 }), '', '就算內容短，上限小於提示語且內容超過上限也回空');
  assert.equal(buildSources({ params: { a: '甲' }, paramLabels: { a: 'A' } }, { cap: 80 }), '【欄位：A】\n甲');
});

// ---- 成品檔文字 ----

test('成品檔文字：docx 抽得到內文、xlsx 帶表名與 \\t 分隔、.pdf 回 null', async () => {
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('總數 14 件')] })] }] });
  const docxText = await extractFileText(await Packer.toBuffer(doc), '八月月報.docx');
  assert.ok(docxText.includes('總數 14 件'), docxText);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('明細');
  ws.addRow(['項目', '件數']);
  ws.addRow(['帽子', 6]);
  const xlsxText = await extractFileText(Buffer.from(await wb.xlsx.writeBuffer()), '明細.xlsx');
  assert.ok(xlsxText.includes('【表：明細】'), xlsxText);
  assert.ok(xlsxText.includes('項目\t件數'), xlsxText);
  assert.ok(xlsxText.includes('帽子\t6'), xlsxText);

  assert.equal(await extractFileText(Buffer.from('%PDF-1.4 fake'), '文件.pdf'), null);
  assert.equal(await extractFileText(Buffer.from('# 標題', 'utf8'), '說明.MD'), '# 標題', '純文字類直讀、副檔名不分大小寫');
  assert.equal(await extractFileText(Buffer.from('不是真的 docx'), '壞檔.docx'), null, '讀不出來回 null，不炸掉');
});

test('成品檔文字：抽出來是空的就回 null（呼叫端一個判斷就夠）', async () => {
  assert.equal(await extractFileText(Buffer.from('', 'utf8'), '空的.txt'), null, '空檔');
  assert.equal(await extractFileText(Buffer.from('   \n\t  \n', 'utf8'), '只有空白.txt'), null, '只有空白');

  const empty = new Document({ sections: [{ children: [new Paragraph({})] }] });
  assert.equal(await extractFileText(await Packer.toBuffer(empty), '空白月報.docx'), null, '空 docx');
});

// ---- runCheck ----

test('查核：假 adapter 回 JSON → 分類結果對；停點規則被違反算 stop-edit；meta.kind 是 check', async () => {
  const reply = ['查完了：', '```json', '{"items":[{"claim":"總數十三件","source":"明細原文","scope":"全月","calc":"6+3+4+1=14","verdict":"mismatch"}],"must_violations":[{"rule":"保留120分鐘","where":"寫成 90 分鐘"}],"flags":[],"summary":"數字對不上"}', '```'].join('\n');
  const adapter = fakeAdapter(reply);
  const r = await runCheck({
    adapter,
    meta: { category: '測試', workflow: 'wf', run: 'r-1', node: 'a' },
    title: '寫八月月報',
    requirements: REQ,
    sources: '【欄位：月份】\n八月',
    product: '八月共 13 件',
  });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.blocks.map((b) => b.kind), ['number-mismatch', 'stop-edit']);
  assert.equal(r.summary, '數字對不上');
  assert.equal(r.note, '');
  assert.deepEqual(r.missing, []);
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].meta.kind, 'check');
  assert.equal(adapter.calls[0].meta.node, 'a');
  assert.equal(adapter.calls[0].meta.run, 'r-1');
  assert.ok(adapter.calls[0].prompt.includes('八月共 13 件'), '成品要進 prompt');
});

test('查核：adapter 丟錯或回不成形的東西 → incomplete，note 是人話，其餘欄位空著', async () => {
  const args = { meta: { node: 'a' }, title: '寫八月月報', requirements: REQ, sources: '八月', product: '成品' };
  const failed = await runCheck({ adapter: fakeAdapter(new Error('連不上 Claude（測試注入）')), ...args });
  assert.equal(failed.status, 'incomplete');
  assert.ok(failed.note.startsWith('這次沒查成：'), failed.note);
  assert.ok(failed.note.includes('連不上 Claude（測試注入）'), failed.note);
  assert.deepEqual(failed.blocks, []);
  assert.deepEqual(failed.flags, []);
  assert.deepEqual(failed.missing, []);
  assert.deepEqual(failed.items, []);
  assert.equal(failed.summary, '');

  // 宿主的原話常常掛著一句「可以按…」的操作指示——那是卡片上的按鈕在講的，不該重複推到使用者面前
  const withHint = await runCheck({ adapter: fakeAdapter(new Error('額度用完了，等一下再試。可以按「重試這步」。')), ...args });
  assert.equal(withHint.note, '這次沒查成：額度用完了，等一下再試。');
  assert.ok(!withHint.note.includes('重試這步'), withHint.note);

  const noMessage = await runCheck({ adapter: fakeAdapter(new Error('')), ...args });
  assert.equal(noMessage.note, '這次沒查成：原因不明');

  const garbage = await runCheck({ adapter: fakeAdapter('我不知道'), ...args });
  assert.equal(garbage.status, 'incomplete');
  assert.ok(garbage.note.startsWith('這次沒查成：') && garbage.note.length > '這次沒查成：'.length, '解析失敗也要留原因');
});

test('查核：查核員交了兩份不同的結果 → incomplete，note 說分不出哪份是真的，不准猜一份當 pass', async () => {
  const r = await runCheck({
    adapter: fakeAdapter(`${RESULT_JSON}\n${OTHER_JSON}`),
    meta: { node: 'a' }, title: '寫八月月報', requirements: REQ, sources: '八月', product: '成品',
  });
  assert.equal(r.status, 'incomplete');
  assert.ok(r.note.startsWith('這次沒查成：'), r.note);
  assert.ok(r.note.includes('不只一份'), r.note);
  assert.deepEqual(r.blocks, []);
  assert.deepEqual(r.items, []);
});

//：卷宗只存指示不存回覆，「這次沒查成」事後永遠查不出為什麼——失敗時把查核員的回覆原文一起交出去
test('查核：沒查成時把查核員的回覆原文交出來（raw）；沒收到回覆就是空字串，查成了不用留', async () => {
  const args = { meta: { node: 'a' }, title: '寫八月月報', requirements: REQ, sources: '八月', product: '成品' };

  const two = `${RESULT_JSON}\n${OTHER_JSON}`;
  const ambiguous = await runCheck({ adapter: fakeAdapter(two), ...args });
  assert.equal(ambiguous.status, 'incomplete');
  assert.equal(ambiguous.raw, two, '兩份結果分不出真假時，原文要留著給事後看');

  const garbage = await runCheck({ adapter: fakeAdapter('我不知道'), ...args });
  assert.equal(garbage.status, 'incomplete');
  assert.equal(garbage.raw, '我不知道');

  const thrown = await runCheck({ adapter: fakeAdapter(new Error('連不上 Claude（測試注入）')), ...args });
  assert.equal(thrown.status, 'incomplete');
  assert.equal(thrown.raw, '', '根本沒收到回覆＝沒有原文可留');

  const done = await runCheck({ adapter: fakeAdapter(RESULT_JSON), ...args });
  assert.equal(done.status, 'blocked');
  assert.equal(done.raw, undefined, '查成了就不必留原文');
});

test('查核：onPrompt 拿到的就是送出去的那份指示（卷宗存的＝送出的）；不給也照跑', async () => {
  const args = { meta: { node: 'a' }, title: '寫八月月報', requirements: REQ, sources: '【欄位：月份】\n八月', product: '八月共 13 件' };
  const seen = [];
  const adapter = fakeAdapter(RESULT_JSON);
  const r = await runCheck({ adapter, ...args, onPrompt: (p) => { seen.push(p); } });
  assert.equal(seen.length, 1, '送一次就記一次');
  assert.equal(seen[0], buildCheckPrompt({ title: args.title, requirements: args.requirements, sources: args.sources, product: args.product }));
  assert.equal(seen[0], adapter.calls[0].prompt, '卷宗存的全文＝送出的全文');
  assert.equal(r.status, 'blocked', '記卷宗不影響查核結果');

  const plain = await runCheck({ adapter: fakeAdapter(RESULT_JSON), ...args }); // 不給 onPrompt
  assert.equal(plain.status, 'blocked');
});

test('查核：onPrompt 是先於送出、且會等它做完；它自己出事也不准把查核弄成沒查成', async () => {
  const args = { meta: { node: 'a' }, title: '寫八月月報', requirements: REQ, sources: '八月', product: '成品' };
  const order = [];
  const adapter = { calls: [], async complete() { order.push('送出'); return RESULT_JSON; } };
  await runCheck({ adapter, ...args, onPrompt: async () => { await new Promise((r) => setTimeout(r, 5)); order.push('進卷宗'); } });
  assert.deepEqual(order, ['進卷宗', '送出'], '先存卷宗、存完才送出');

  const broken = await runCheck({ adapter: fakeAdapter(RESULT_JSON), ...args, onPrompt: () => { throw new Error('磁碟滿了'); } });
  assert.equal(broken.status, 'blocked', '卷宗寫不進不擋查核');
  assert.equal(broken.note, '');
});

// ---- deriveEditRules ----

test('擬規則：AI 回合法 rules → 原樣帶回；meta.kind 是 edit-rules；prompt 帶原版與改過的版本', async () => {
  const adapter = fakeAdapter('```json\n{"rules":[{"text":"後面每步保留 120 分鐘","scope":"all"},{"text":"這張表照件數排","scope":"this-step"}]}\n```');
  const rules = await deriveEditRules({
    adapter, meta: { run: 'r-1', node: 'a' }, title: '寫八月月報',
    original: '原本寫 90 分鐘', edited: '改成 120 分鐘', note: '時間一律 120 分鐘',
  });
  assert.deepEqual(rules, [
    { text: '後面每步保留 120 分鐘', scope: 'all' },
    { text: '這張表照件數排', scope: 'this-step' },
  ]);
  assert.equal(adapter.calls[0].meta.kind, 'edit-rules');
  assert.equal(adapter.calls[0].meta.node, 'a');
  const p = adapter.calls[0].prompt;
  assert.ok(p.includes('原本寫 90 分鐘') && p.includes('改成 120 分鐘') && p.includes('時間一律 120 分鐘'));
  assert.ok(p.includes('this-step') && p.includes('"rules"'), '輸出格式要講清楚');
  assert.ok(p.includes('全篇使用與「這一步」相同的語言。'), '規則要跟指示同一種語言');
  assert.equal(p, buildEditRulesPrompt({ title: '寫八月月報', original: '原本寫 90 分鐘', edited: '改成 120 分鐘', note: '時間一律 120 分鐘' }));
});

test('擬規則：AI 回垃圾或丟錯 → 退成預設一條；scope 亂寫算 all', async () => {
  const args = { meta: { node: 'a' }, title: '寫八月月報', original: '原本', edited: '改過' };
  assert.deepEqual(
    await deriveEditRules({ adapter: fakeAdapter('我不知道要寫什麼'), ...args, note: '時間一律 120 分鐘' }),
    [{ text: '時間一律 120 分鐘', scope: 'all' }],
  );
  assert.deepEqual(
    await deriveEditRules({ adapter: fakeAdapter(new Error('連不上')), ...args, note: '' }),
    [{ text: '以改過的版本為準', scope: 'all' }],
  );
  assert.deepEqual(
    await deriveEditRules({ adapter: fakeAdapter('{"rules":[{"text":"照件數排","scope":"亂寫"},{"text":"","scope":"all"},"不是物件"]}'), ...args, note: '' }),
    [{ text: '照件數排', scope: 'all' }],
    'scope 不合法算 all；空 text 與非物件丟掉',
  );
  assert.deepEqual(
    await deriveEditRules({ adapter: fakeAdapter('{"rules":[]}'), ...args, note: '' }),
    [{ text: '以改過的版本為準', scope: 'all' }],
    '空陣列也退成預設',
  );
});

test('擬規則：兩組不同的規則＝分不出使用者要哪組 → 退成預設，不准靠位置猜；重複、外層、圍欄照政策', async () => {
  const args = { meta: { node: 'a' }, title: '寫八月月報', original: '原本寫 90 分鐘', edited: '改成 120 分鐘' };
  const real = '{"rules":[{"text":"後面每步保留 120 分鐘","scope":"all"}]}';
  const two = `範例格式：{"rules":[{"text":"範例規則","scope":"all"}]}\n實際規則：${real}`;
  assert.deepEqual(await deriveEditRules({ adapter: fakeAdapter(two), ...args, note: '' }), [{ text: '以改過的版本為準', scope: 'all' }], '兩組不同＝含糊，退成預設');
  assert.deepEqual(await deriveEditRules({ adapter: fakeAdapter(two), ...args, note: '時間一律 120 分鐘' }), [{ text: '時間一律 120 分鐘', scope: 'all' }], '有說明就退成說明那一條');
  const twoNoScope = `範例：{"rules":[{"text":"範例規則","scope":"all"}]} 實際：{"rules":[{"text":"後面每步保留 120 分鐘"}]}`;
  assert.deepEqual(await deriveEditRules({ adapter: fakeAdapter(twoNoScope), ...args, note: '' }), [{ text: '以改過的版本為準', scope: 'all' }], '沒寫 scope 的也是一組合格規則——兩組就是含糊');

  // 同一組寫兩次＝重複，不是含糊
  assert.deepEqual(await deriveEditRules({ adapter: fakeAdapter(`${real}\n再說一次：${real}`), ...args, note: '' }), [{ text: '後面每步保留 120 分鐘', scope: 'all' }]);
  // 只有一組、沒寫 scope：照樣是規則，補成 all
  assert.deepEqual(await deriveEditRules({ adapter: fakeAdapter('{"rules":[{"text":"後面每步保留 120 分鐘"}]}'), ...args, note: '' }), [{ text: '後面每步保留 120 分鐘', scope: 'all' }]);
  // 包含依名次（ 的 meta 案）：規則物件裡包了一個長得一樣、同名次的子物件——被包住的不算，外層贏
  assert.deepEqual(
    await deriveEditRules({ adapter: fakeAdapter('{"rules":[{"text":"後面每步保留 120 分鐘","scope":"all"}],"draft":{"rules":[{"text":"草稿規則","scope":"all"}]}}'), ...args, note: '' }),
    [{ text: '後面每步保留 120 分鐘', scope: 'all' }],
  );
  // 反過來「外層是範例、子物件才是真規則」結構上與上一條完全相同（兩層都有合格規則、同名次），解析器認不出哪層是範例；
  // 要讓內層贏只能靠內容去猜，裁定禁止——所以照樣外層贏。這是有意識釘住的行為，不是漏掉
  assert.deepEqual(
    await deriveEditRules({ adapter: fakeAdapter('{"rules":[{"text":"範例規則","scope":"all"}],"實際":{"rules":[{"text":"後面每步保留 120 分鐘","scope":"all"}]}}'), ...args, note: '' }),
    [{ text: '範例規則', scope: 'all' }],
    '同名次的子物件不算——與上一條同結構，外層贏',
  );
  // 圍欄不優先：圍欄裡放範例、正文放真規則——兩組不同＝含糊，退成預設（ 移除「圍欄那組優先」）
  assert.deepEqual(
    await deriveEditRules({ adapter: fakeAdapter(`\`\`\`json\n{"rules":[{"text":"範例規則","scope":"all"}]}\n\`\`\`\n實際規則：{"rules":[{"text":"後面每步保留 120 分鐘","scope":"all"}]}`), ...args, note: '' }),
    [{ text: '以改過的版本為準', scope: 'all' }],
    '圍欄不是護身符，兩組不同就是含糊',
  );
});

test('擬規則：onPrompt 拿到的就是送出去的那份指示；不給也照跑，它出事也不影響擬出來的規則', async () => {
  const args = { meta: { node: 'a' }, title: '寫八月月報', original: '原本寫 90 分鐘', edited: '改成 120 分鐘', note: '時間一律 120 分鐘' };
  const reply = '{"rules":[{"text":"後面每步保留 120 分鐘","scope":"all"}]}';
  const seen = [];
  const adapter = fakeAdapter(reply);
  const rules = await deriveEditRules({ adapter, ...args, onPrompt: (p) => { seen.push(p); } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0], buildEditRulesPrompt({ title: args.title, original: args.original, edited: args.edited, note: args.note }));
  assert.equal(seen[0], adapter.calls[0].prompt, '卷宗存的全文＝送出的全文');
  assert.deepEqual(rules, [{ text: '後面每步保留 120 分鐘', scope: 'all' }]);

  assert.deepEqual(await deriveEditRules({ adapter: fakeAdapter(reply), ...args }), [{ text: '後面每步保留 120 分鐘', scope: 'all' }], '不給 onPrompt 照跑');
  assert.deepEqual(
    await deriveEditRules({ adapter: fakeAdapter(reply), ...args, onPrompt: () => { throw new Error('磁碟滿了'); } }),
    [{ text: '後面每步保留 120 分鐘', scope: 'all' }],
    '卷宗寫不進不准把規則退成預設那一條',
  );
});

// ---- 查核第四路——組織／分類規範另成一段（整份貼，不拆成必守條列）、判定規則加一句「違反規範歸 must」 ----

test('U1b ②：companyRules／deptRules → 「# 公司／部門規範（一定要守）」段在必守清單後、格式要求前；每檔「## 公司規範：檔名」＋全文；判定規則多一句「違反規範歸 must」；factsOff 也一樣', () => {
  const rules = { companyRules: [{ name: '員工手冊.md', text: '語氣要親切。' }], deptRules: [{ name: '部門規範.docx', text: '報價一律含稅。' }] };
  const p = buildCheckPrompt({ title: '寫八月月報', requirements: { ...REQ, ...rules }, sources: '', product: '成品' });
  const at = (h) => p.indexOf(h);
  assert.ok(p.includes('# 公司／部門規範（一定要守）'), p);
  assert.ok(p.includes('## 公司規範：員工手冊.md\n語氣要親切。'));
  assert.ok(p.includes('## 部門規範：部門規範.docx\n報價一律含稅。'));
  assert.ok(at('# 必守（逐條對）') < at('# 公司／部門規範') && at('# 公司／部門規範') < at('# 格式要求'), '放在必守清單後、格式要求前');
  assert.ok(p.includes('- 數字要對') && p.includes('- 保留 120 分鐘'), '必守三路照舊');
  const judge = p.slice(at('# 判定規則'), at('# 輸出格式'));
  assert.ok(judge.includes('違反規範歸 must'), judge);
  assert.equal((judge.match(/^\d\. /gm) ?? []).length, 6, '六條編號不動，規範那句不編號');
  // 只有一層
  const onlyDept = buildCheckPrompt({ title: 'x', requirements: { ...REQ, deptRules: rules.deptRules }, sources: '', product: '成品' });
  assert.ok(onlyDept.includes('# 公司／部門規範（一定要守）') && !onlyDept.includes('## 公司規範：') && onlyDept.includes('## 部門規範：部門規範.docx'));
  // factsOff：段與那句照樣在
  const off = buildCheckPrompt({ title: 'x', requirements: { ...REQ, ...rules, factsOff: true }, sources: '', product: '成品' });
  assert.ok(off.includes('# 公司／部門規範（一定要守）') && off.slice(off.indexOf('# 判定規則'), off.indexOf('# 輸出格式')).includes('違反規範歸 must'));
});

test('U1b ②：requirements 沒給規範（或給空陣列）→ 「規範」零命中，輸出與現況逐字相同', () => {
  const base = buildCheckPrompt({ title: '寫八月月報', requirements: REQ, sources: '', product: '成品' });
  assert.equal((base.match(/規範/g) ?? []).length, 0);
  assert.equal(buildCheckPrompt({ title: '寫八月月報', requirements: { ...REQ, companyRules: [], deptRules: [] }, sources: '', product: '成品' }), base);
});

test('U1b 覆核該修：查核 prompt 裡規範內文行首 # 降一級（###### 封頂），^# 開頭的行只剩系統段標題', () => {
  const p = buildCheckPrompt({
    title: '寫八月月報',
    requirements: { ...REQ, companyRules: [{ name: '員工手冊.md', text: '# 員工手冊\n語氣要親切。\n## 請假\n前一天說。\n###### 六級' }] },
    sources: '',
    product: '成品',
  });
  assert.ok(p.includes('## 公司規範：員工手冊.md\n## 員工手冊\n語氣要親切。\n### 請假\n前一天說。\n###### 六級'), p);
  const h1 = p.split('\n').filter((l) => /^# /.test(l));
  assert.deepEqual(h1, ['# 這一步：寫八月月報', '# 必守（逐條對）', '# 公司／部門規範（一定要守）', '# 格式要求', '# 判定規則', '# 輸出格式', '# 原始資料（使用者給的檔與欄位）', '# 成品']);
});

// ----  ⑤：能耐表只給拆解器，查核員不帶 ----

test('B2 ⑤：查核 prompt 0 命中「你能派工人做什麼」與「# 關於你」（能耐表與關於你只給拆解器）', () => {
  const p = buildCheckPrompt({ title: '寫八月月報', requirements: { ...REQ, companyRules: [{ name: '手冊.md', text: '親切。' }] }, sources: '原始', product: '成品' });
  assert.equal((p.match(/你能派工人做什麼/g) ?? []).length, 0, p);
  assert.equal((p.match(/# 關於你/g) ?? []).length, 0, p);
  const rules = buildEditRulesPrompt({ title: '寫八月月報', original: '舊', edited: '新', note: '口氣改' });
  assert.equal((String(rules).match(/你能派工人做什麼/g) ?? []).length, 0);
});

// （US-096 的「封面／條列／表格三種版型至少可用」原本只靠工作單的文字提示，
// 沒有任何東西保證）：這一條真的呼叫 bundled 的 pptxgenjs 做出三種版型，再用查核員那支抽回文字。
// 三種都抽得到＝版型做得出來、且交貨查核與頁內預覽讀得到簡報（不再是「成品檔讀不出來」）。
test('成品格式輪：pptxgenjs 三種版型真的做得出來，且 pptxSlides／extractFileText 抽得回中文', async () => {
  const p = new PptxGenJS();
  p.layout = 'LAYOUT_16x9';
  p.addSlide().addText('九月社群成效月報', { x: 0.6, y: 2.2, fontSize: 40, bold: true });
  p.addSlide().addText(
    [{ text: '互動率 4.1%', options: { bullet: true } }, { text: '短影音帶動成長', options: { bullet: true } }],
    { x: 0.8, y: 1.4, fontSize: 18 },
  );
  p.addSlide().addTable([['要改的事', '為什麼'], ['短影音排期固定化', '發布時間不規律']], { x: 0.6, y: 1.4 });
  const buf = Buffer.from(await p.write({ outputType: 'nodebuffer' }));

  const slides = pptxSlides(buf);
  assert.equal(slides.length, 3, '三張投影片');
  assert.deepEqual(slides[0].texts, ['九月社群成效月報'], '封面：大標抽得回來');
  assert.deepEqual(slides[1].texts, ['互動率 4.1%', '短影音帶動成長'], '條列：每點各一行');
  assert.ok(slides[2].texts.includes('要改的事') && slides[2].texts.includes('短影音排期固定化'), '表格：表頭與內容都抽得到');

  const text = await extractFileText(buf, '月報.pptx');
  assert.ok(text, '查核員一定要讀得出簡報——讀不出就會判「這次沒查」，交貨查核對簡報整個失效');
  assert.ok(text.includes('【第 1 張】') && text.includes('九月社群成效月報') && text.includes('短影音排期固定化'), text);
});

// ---------- 查核帳本複查（2026-09-22）：補上帳本標「沒測」的那幾條 ----------

test('帳本 Task 7：k=0（整數位）邊界——round 與 trunc 差 1 都放行，是宣告過的代價不是漏洞', () => {
  // Ruling 20 的代價：右邊寫成整數時位數退化成 0，7/2 無論寫 3 或 4 都算對。
  assert.equal(verifyArithmetic('7/2=3'), true, '截斷寫法放行');
  assert.equal(verifyArithmetic('7/2=4'), true, '四捨五入寫法也放行（同一個代價）');
  assert.equal(verifyArithmetic('7/2=5'), false, '差得更多就不放行——放寬的是 1 以內');
  assert.equal(verifyArithmetic('10/4=3'), true, '2.5 → 2 或 3 都算');
  assert.equal(verifyArithmetic('10/4=2'), true);
  assert.equal(verifyArithmetic('10/4=1'), false);
});

test('帳本 Task 3：buildSources 的四個邊界——長值 200 字、同 key 重複、label 缺、空陣列', () => {
  const long = 'x'.repeat(200);
  const s1 = buildSources({ params: { a: long }, paramLabels: { a: '甲' } });
  assert.ok(s1.includes(long) || s1.includes('x'), '剛好 200 字要帶進去（不是被當成過長切掉）');
  const s2 = buildSources({ params: { a: `${long}x` }, paramLabels: { a: '甲' } });
  assert.ok(typeof s2 === 'string', '201 字照樣產得出來，不丟例外');
  const s3 = buildSources({ params: { b: '值' } });
  assert.ok(s3.includes('值'), 'label 缺就用 key 當名字，不能整段消失');
  assert.equal(typeof buildSources({}), 'string', '空的也要回字串');
  assert.equal(typeof buildSources({ params: {}, ancestors: [], attachments: [] }), 'string', '空陣列不炸');
});

test('帳本 Task 2：parseCheckResult 的三個邊界——未知 verdict、只有 summary、非物件', () => {
  const unknown = parseCheckResult('{"verdict":"外星文","summary":"x","items":[]}');
  assert.ok(unknown && typeof unknown === 'object', '認不得的 verdict 不能丟例外，要回得了東西');
  const onlySummary = parseCheckResult('{"summary":"我沒辦法查"}');
  assert.ok(onlySummary && typeof onlySummary === 'object', '只有 summary 也解析得出來（帳本 Task 2 記的既有政策）');
  assert.throws(() => parseCheckResult('這不是 JSON'), CheckParseError, '完全不是 JSON 才丟，而且丟的是自己的錯誤型別');
});

test('PDF 真檔：pdfkit 嵌內建中文字型做得出來，且 extractFileText 抽得回中文', async () => {
  const PDFDocument = (await import('pdfkit')).default;
  const { CJK_FONT } = await import('../src/host-adapter.js');
  assert.ok(fs.existsSync(CJK_FONT), '內建字型檔要在——不在的話 PDF 的中文會整份空白或豆腐格');
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => doc.on('end', r));
  doc.registerFont('tc', CJK_FONT);
  doc.font('tc').fontSize(24).text('九月社群成效月報');
  doc.moveDown().fontSize(12).text('貼文 24 篇（上月 21 篇），互動率 4.1%。');
  doc.end();
  await done;
  const buf = Buffer.concat(chunks);
  assert.ok(buf.length > 5000, `產出像一份真的 PDF：${buf.length}`);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-', 'PDF 檔頭');
  const text = await extractFileText(buf, '月報.pdf');
  assert.ok(text, '查核員一定要讀得出 PDF——讀不出就會判「這次沒查」');
  assert.ok(text.includes('九月社群成效月報') && text.includes('24 篇'), text?.slice(0, 80));
});

test('查核員規則：要統計整張表才能判斷的主張不列（由程式對），只列原始資料裡直接找得到的', () => {
  const p = buildCheckPrompt({ title: 't', requirements: { instruction: 'x' }, sources: '原', product: '品' });
  assert.ok(p.includes('需要自己加總、排序、統計整張表才能判斷的主張（例如誰是第一名、哪個通路最多）也不列——那些數字由程式對過。只列能在原始資料裡直接找到對應句子或欄位值的主張。'), '第 1 條要有這句');
  assert.ok(!p.includes('calc'), '不再要求 calc');
});

test('分類：帶阿拉伯數字的主張查核員說 mismatch／unsupported 都不攔（數字歸程式對）；純文字主張照攔；missing 不受影響', () => {
  const r = classify({ items: [
    { claim: '羊毛圍巾退貨金額37,620元', source: '', scope: '8月', verdict: 'unsupported' },
    { claim: '退貨金額54,230元，占8月完成營收21%', source: '', scope: '8月', verdict: 'mismatch' },
    { claim: '防潑水後背包為新品', source: '', scope: '8月', verdict: 'unsupported' },
    { claim: '9月退貨明細', source: '', scope: '', verdict: 'missing' },
  ] });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.blocks.map((b) => b.claim), ['防潑水後背包為新品'], '只有純文字那條進 blocks');
  assert.equal(r.items.length, 4, '四條判定都留在 items 當紀錄');
  assert.equal(r.missing.length, 1, 'missing 照舊');
  const clean = classify({ items: [{ claim: '客單價 2,840 元', source: '', scope: '', verdict: 'unsupported' }] });
  assert.equal(clean.status, 'pass', '只有帶數字的 unsupported＝不攔＝pass');
});

test('分類：成品自己標成推測的主張（可能／推測／估計／約）查核員說 unsupported 也不攔；「約定」不算', () => {
  const r = classify({ items: [
    { claim: '官網可能有優惠活動或流量集中', source: '', scope: '', verdict: 'unsupported' },
    { claim: '推測是入秋保暖需求帶動', source: '', scope: '', verdict: 'unsupported' },
    { claim: '雙方約定十月交貨', source: '', scope: '', verdict: 'unsupported' },
  ] });
  assert.deepEqual(r.blocks.map((b) => b.claim), ['雙方約定十月交貨'], '只有沒標推測的那條進 blocks');
  assert.equal(r.status, 'blocked');
});
