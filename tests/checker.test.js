// checker 測試（交貨查核輪）：算式驗算、JSON 解析、分類、查核 prompt、原始資料組裝、成品檔文字、查核與擬規則
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import {
  buildCheckPrompt, parseCheckResult, verifyArithmetic, classify, extractFileText,
  runCheck, buildEditRulesPrompt, deriveEditRules, buildSources, CheckParseError,
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
  assert.equal(verifyArithmetic('總數 13 件'), null, '沒有等號＝不表態');
  assert.equal(verifyArithmetic(''), null);
  assert.equal(verifyArithmetic('100/3=33.33'), true, '除不盡：截到右邊寫的位數就算成立');
});

// 裁定 20：查核員照規則第 2 條把算式寫進 calc，除不盡的佔比（6÷14）一定是四捨五入或截斷過的商——
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

// 裁定 24（a）：查核員照第 2 條把成品的「43%」搬到等號右邊，左邊卻沒乘 100——
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

// 裁定 24（b）：兩邊都沒寫百分號，一邊是比例、一邊是百分數（6/14=43）——小的乘 100 對得上也算成立
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

// 裁定 26：比對的位數要取自「寫成純數字」的那一側。之前一律取右邊的位數，百分號寫在左邊、右邊是算式或整數時
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

// 裁定 29：恰一側寫百分號、嚴格比對不成立時，退一步用兩側「剝掉百分號的原始值」再比一次。
// 查核員把佔比乘完 100 又補百分號（6/14*100=42.9%）是最自然的寫法，硬判不成立會假攔。
test('算式驗算：兩邊其實都在講百分數時退一步用原始值再比一次', () => {
  assert.equal(verifyArithmetic('6/14*100=42.9%'), true, '42.857 對 42.9，比到寫出來的一位');
  assert.equal(verifyArithmetic('6/14*100=43%'), true, '四捨五入到整數');

  assert.equal(verifyArithmetic('6/14*100=50%'), false, '退一步比也對不上');
  assert.equal(verifyArithmetic('50%=6/14'), false, '原始值 50 對 0.43，恆真洞沒有被重新打開');
  assert.equal(verifyArithmetic('6/14=99%'), false);
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
  assert.equal(verifyArithmetic('6+3+4+1=14%'), true, '裁定 29 的機械後果：剝掉百分號的原始值兩邊都是 14 → 放行（巧合放行比假攔便宜）');
  assert.equal(verifyArithmetic('大約一半'), null);
  assert.equal(verifyArithmetic('一半的28=14'), null, '數字前面掛中文＝看不懂，不猜');
});

test('算式驗算：不准用 eval／Function 執行查核員給的算式', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'checker.js'), 'utf8');
  assert.ok(!/\beval\s*\(/.test(src), 'checker.js 不得出現 eval(');
  assert.ok(!/\bnew\s+Function\b/.test(src), 'checker.js 不得出現 new Function');
});

// ---- JSON 解析 ----

const RESULT_JSON = '{"items":[{"claim":"總數 13 件","source":"明細原文","scope":"全月","calc":"6+3+4+1=14","verdict":"mismatch"}],"must_violations":[{"rule":"每段不超過三句","where":"第二段有五句"}],"flags":[{"kind":"format","detail":"沒用表格"}],"summary":"數字對不上"}';

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

  const bareArray = parseCheckResult('[{"claim":"總數 13 件","source":"明細原文","scope":"全月","calc":"","verdict":"mismatch"}]');
  assert.equal(bareArray.items.length, 1, '裸陣列＝逐項表');
  assert.equal(bareArray.items[0].verdict, 'mismatch');
  const c = classify(bareArray, { editRules: [] });
  assert.equal(c.status, 'blocked', '裸陣列裡的 mismatch 不准被吞掉');
  assert.deepEqual(c.blocks.map((b) => b.kind), ['number-mismatch']);

  const fencedArray = parseCheckResult(['```json', '[{"claim":"總數 13 件","verdict":"mismatch"}]', '```'].join('\n'));
  assert.equal(fencedArray.items.length, 1, '圍欄裡的裸陣列也收');
});

test('查核結果解析：正文裡的中括號不准劫走抽取——要繼續往後找真正的查核結果', () => {
  const result = '{"items":[{"claim":"總數 13 件","source":"明細原文","scope":"全月","calc":"6+3+4+1=14","verdict":"mismatch"}],"must_violations":[],"flags":[],"summary":"數字對不上"}';
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
  const bare = parseCheckResult('先講結論[]。[{"claim":"總數 13 件","verdict":"mismatch"}]');
  assert.equal(bare.items.length, 1, '前面的空陣列不算逐項表');
  assert.equal(bare.items[0].verdict, 'mismatch');

  // 但查核員自己交出完整的空結果物件（真的全過）照收
  const clean = parseCheckResult('{"items":[],"must_violations":[],"flags":[],"summary":"都對"}');
  assert.deepEqual(clean.items, []);
  assert.equal(classify(clean, { editRules: [] }).status, 'pass');

  // 包在外層物件裡也挖得到（外層過不了關就往內找）
  const nested = parseCheckResult('{"note":"見下","result":{"items":[{"claim":"總數 13 件","verdict":"mismatch"}],"summary":"對不上"}}');
  assert.equal(nested.items.length, 1, '外層不是查核表就往裡面找');
  assert.equal(nested.summary, '對不上');
});

test('查核結果解析：誘餌物件不准劫走——候選計分擇優，有內容的贏過只有一句話的', () => {
  // 只帶一個 summary 的草稿在前、完整查核表在後：草稿不能贏
  const nested = parseCheckResult('{"draft":{"summary":"草稿別看這個"},"final":{"items":[{"claim":"總數 13 件","source":"明細原文","scope":"全月","calc":"6+3+4+1=14","verdict":"mismatch"}],"must_violations":[],"flags":[],"summary":"數字對不上"}}');
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

// 裁定 8：查核員被要求「只輸出一個 JSON 物件」，回覆裡有好幾份一樣像的結果＝交件不合格，誠實說沒查成，不准靠位置猜
const OTHER_JSON = '{"items":[{"claim":"總數 14 件","source":"明細原文","scope":"全月","calc":"6+3+4+1=14","verdict":"ok"}],"must_violations":[],"flags":[],"summary":"都對"}';

test('查核結果解析：候選政策——有內容優先、外層優先、兩份不同的結果＝含糊就丟錯、一字不差的重複不算含糊', () => {
  // 欄位數不對稱：範例四個欄位齊全但全空、真結果少寫一個 flags——比欄位數會讓範例贏，有內容的要贏
  const real = '{"items":[{"claim":"總數 13 件","source":"明細原文","scope":"全月","calc":"6+3+4+1=14","verdict":"mismatch"}],"must_violations":[],"summary":"數字對不上"}';
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
  // 圍欄裡一份、正文另有一份完整的不同結果：圍欄不是護身符，兩份不同＝含糊（裁定 9 移除「圍欄優先」）
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

// 裁定 9：被包住的候選只有名次不高於外層才丟——空殼包著真結果、裸陣列包著真結果物件，內層更像就留下來贏
test('查核結果解析：裁定 9——包住真結果的空殼不准贏、裸陣列裡的結果物件贏過陣列、圍欄裡的範例不再優先', () => {
  const real = '{"items":[{"claim":"總數 13 件","source":"明細原文","scope":"全月","calc":"6+3+4+1=14","verdict":"mismatch"}],"must_violations":[],"flags":[],"summary":"數字對不上"}';
  const expectReal = (r, name) => {
    assert.equal(r.items.length, 1, name);
    assert.equal(r.items[0].claim, '總數 13 件', name);
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
  const only = parseCheckResult('[{"claim":"總數 13 件","verdict":"mismatch"}]');
  assert.equal(only.items.length, 1, '整份只有裸陣列時照收');
  const behind = parseCheckResult('先講結論[]。[{"claim":"總數 13 件","verdict":"mismatch"}]');
  assert.equal(behind.items[0].claim, '總數 13 件', '正文括號在前仍找得到裸陣列');
});

// ---- 分類 ----

test('分類：mismatch→number-mismatch、unsupported→unsupported、ok 但算式假→number-mismatch 寫「算式不成立」', () => {
  const r = classify({
    items: [
      { claim: '總數 13 件', source: '明細原文', scope: '全月', calc: '6+3+4+1=14', verdict: 'mismatch' },
      { claim: '成長最快是 C', source: '', scope: '', calc: '', verdict: 'UNSUPPORTED' },
      { claim: '合計 14 件', source: '明細原文', scope: '全月', calc: '6+3+2+1=14', verdict: 'ok' },
      { claim: '毛利率 30%', source: '明細原文', scope: '全月', calc: '', verdict: 'ok' },
    ],
    must_violations: [],
    flags: [],
    summary: '一句話',
  }, { editRules: [] });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.blocks.map((b) => b.kind), ['number-mismatch', 'unsupported', 'number-mismatch']);
  assert.equal(r.blocks[0].claim, '總數 13 件');
  assert.equal(r.blocks[0].source, '明細原文');
  assert.equal(r.blocks[0].detail, '6+3+4+1=14');
  assert.ok(r.blocks[2].detail.includes('算式不成立'), '假算式要寫明算式不成立');
  assert.ok(r.blocks[2].detail.includes('6+3+2+1=14'));
  assert.equal(r.items.length, 4, '逐項表原樣帶回');
  assert.equal(r.items[1].verdict, 'unsupported', 'verdict 轉小寫');
  assert.equal(r.summary, '一句話');
});

test('分類：查核員說 ok 但算式帶單位——照樣算、照樣攔', () => {
  const r = classify({
    items: [{ claim: '合計 14 件', source: '明細原文', scope: '全月', calc: '6+3+2+1=14 件', verdict: 'ok' }],
    must_violations: [], flags: [], summary: '都對',
  }, { editRules: [] });
  assert.equal(r.status, 'blocked', '單位不能讓假算式溜過去');
  assert.equal(r.blocks[0].kind, 'number-mismatch');
  assert.ok(r.blocks[0].detail.includes('算式不成立'), r.blocks[0].detail);
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
  assert.ok(rulesSection.includes('calc 只寫數字與 + - * / ( ) ='), 'calc 要交代寫法，不要單位與文字');
  // 裁定 20＋24：等號右邊照成品的位數寫，程式就用同樣的位數比；百分比要寫全，別把 43% 寫成 6/14=43
  assert.ok(
    rulesSection.includes('百分比寫成 6/14*100=42.9 或 6/14=42.9%，等號右邊寫成品裡出現的數字（可四捨五入或截斷到成品的位數）。'),
    '算式右邊照成品的位數寫，百分比有寫法示範',
  );
  // 裁定 22：判斷型步驟（評分、排序、建議）第一次一定被整批判無據——unsupported 只留給事實性主張
  assert.ok(
    rulesSection.includes('unsupported 只用在事實性主張（數字、事件、引用、名稱、時程、規格）；這一步被指示要做的判斷、評分、排序、建議本身不需要出處，但它引用的事實要有。'),
    'unsupported 只針對事實性主張',
  );
  assert.ok(p.includes('"must_violations"') && p.includes('"verdict"') && p.includes('"scope"'), '輸出格式範例');
  assert.ok(p.indexOf('# 原始資料') < p.indexOf('# 成品'), '原始資料在成品前');
  assert.ok(p.includes('【欄位：月份】'));
  assert.ok(p.trimEnd().endsWith('八月共 14 件'), '成品放最後');

  const bare = buildCheckPrompt({ title: '無要求', requirements: { instruction: '做', constraints: '', reviewFocus: '', outputFormat: '', editRules: [] }, sources: '', product: '成品' });
  assert.ok(bare.slice(bare.indexOf('# 必守（逐條對）'), bare.indexOf('# 格式要求')).includes('（無）'));
  assert.ok(bare.slice(bare.indexOf('# 格式要求'), bare.indexOf('# 判定規則')).includes('（無）'));
});

// ---- 監工輪：facts 開關與監工備註 ----

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

// ---- 記憶輪 M3a：群組規矩併進必守 ----

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
const SNAPSHOT_DEFAULT_PROMPT = "你是「剝繭」流程的交貨查核員。這一步的成品已經做好，你的工作是拿原始資料與使用者的要求逐條對它，把對不上的地方挑出來。\n你不改成品、不補內容、不評論好不好——只回報事實對不對、要求有沒有守。原始資料裡沒有的東西，一律不准當成常識自己補。\n全篇使用與「這一步」相同的語言。\n\n# 這一步：寫八月月報\n把明細寫成八月月報\n\n# 必守（逐條對）\n- 數字要對\n- 每段不超過三句\n- 保留 120 分鐘\n\n# 格式要求\n不超過一頁\nMarkdown 表格\n\n# 判定規則\n1. 把成品裡每一個具體主張（數字、事實、引用、排序）列成一項，逐項回到原始資料裡找根據。\n2. verdict 只有四種：ok＝原始資料撐得住；mismatch＝跟原始資料對不上；unsupported＝原始資料裡找不到根據；missing＝指示要這一項但原始資料本來就沒有。unsupported 只用在事實性主張（數字、事件、引用、名稱、時程、規格）；這一步被指示要做的判斷、評分、排序、建議本身不需要出處，但它引用的事實要有。source 抄原始資料的逐字原文，不准改寫或轉述；scope 寫清楚這個數字涵蓋的範圍（期間、類別、對象）；有加總或換算就把算式寫進 calc，calc 只寫數字與 + - * / ( ) =，不要加單位、貨幣符號或文字。百分比寫成 6/14*100=42.9 或 6/14=42.9%，等號右邊寫成品裡出現的數字（可四捨五入或截斷到成品的位數）。\n3. 成品明白標成估計、約略、推測的數字不算 mismatch，除非原始資料有精確值而且差距明顯。\n4. 「必守」逐條檢查，違反的寫進 must_violations：rule 抄那一條原文，where 寫成品哪裡違反。\n5. flags 只有兩種：conclusion-changed＝成品改了上游的結論或排序；format＝格式跟要求不同。其他一律不要寫。\n6. 只輸出一個 JSON 物件，前後不要任何其他文字。\n\n# 輸出格式\n{\"items\":[{\"claim\":\"總數 13 件\",\"source\":\"…原文逐字…\",\"scope\":\"全月、全部類別\",\"calc\":\"6+3+4+1=14\",\"verdict\":\"mismatch\"}],\n \"must_violations\":[{\"rule\":\"每段不超過三句\",\"where\":\"第二段有五句\"}],\n \"flags\":[{\"kind\":\"conclusion-changed\",\"detail\":\"上游排 D 第一，成品改成 C 第一，理由是…\"}],\n \"summary\":\"一句話\"}\n\n# 原始資料\n【欄位：月份】\n八月\n\n# 成品\n八月共 14 件";

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

test('原始資料組裝：欄位在前、祖先依給定順序、補的資料與參考檔在後、每檔截 perFile', () => {
  const s = buildSources({
    params: { month: '八月', tone: '輕鬆' },
    paramLabels: { month: '月份' },
    ancestors: [{ title: '收集資料', text: 'AAA' }, { title: '整理表格', text: 'BBB' }],
    supplied: '我補的名單',
    attachments: [{ name: '規範.md', text: 'x'.repeat(50) }],
  }, { perFile: 10 });
  const at = (t) => { const i = s.indexOf(t); assert.notEqual(i, -1, `缺 ${t}`); return i; };
  assert.ok(at('【欄位：月份】') < at('【欄位：tone】'), '欄位照插入順序，沒 label 就用 key');
  assert.ok(at('【欄位：tone】') < at('【步驟：收集資料】'));
  assert.ok(at('【步驟：收集資料】') < at('【步驟：整理表格】'), '祖先照給定順序');
  assert.ok(at('【步驟：整理表格】') < at('【你補的資料】'));
  assert.ok(at('【你補的資料】') < at('【參考檔：規範.md】'));
  assert.ok(s.includes('【欄位：月份】\n八月') && s.includes('【步驟：收集資料】\nAAA'));
  assert.ok(/【參考檔：規範\.md】\nx{10}$/.test(s), `參考檔截到 perFile：${JSON.stringify(s.slice(-30))}`);

  const none = buildSources({ params: {}, paramLabels: {}, ancestors: [{ title: '只有這步', text: 'A' }], supplied: '', attachments: [] });
  assert.ok(!none.includes('【你補的資料】'), '沒補資料就不出這一段');
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
  assert.ok(s.endsWith('Z'.repeat(20)), '留下的是最後面的資料');
  assert.ok(!s.includes('【欄位：甲】'), '最前面的欄位被截掉');
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
  const reply = ['查完了：', '```json', '{"items":[{"claim":"總數 13 件","source":"明細原文","scope":"全月","calc":"6+3+4+1=14","verdict":"mismatch"}],"must_violations":[{"rule":"保留120分鐘","where":"寫成 90 分鐘"}],"flags":[],"summary":"數字對不上"}', '```'].join('\n');
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

// 裁定 21：卷宗只存指示不存回覆，「這次沒查成」事後永遠查不出為什麼——失敗時把查核員的回覆原文一起交出去
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
  // 包含依名次（裁定 9 的 meta 案）：規則物件裡包了一個長得一樣、同名次的子物件——被包住的不算，外層贏
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
  // 圍欄不優先：圍欄裡放範例、正文放真規則——兩組不同＝含糊，退成預設（裁定 9 移除「圍欄那組優先」）
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

// ---- 移植合併輪 U1b：查核第四路——公司／部門規範另成一段（整份貼，不拆成必守條列）、判定規則加一句「違反規範歸 must」 ----

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
  assert.deepEqual(h1, ['# 這一步：寫八月月報', '# 必守（逐條對）', '# 公司／部門規範（一定要守）', '# 格式要求', '# 判定規則', '# 輸出格式', '# 原始資料', '# 成品']);
});
