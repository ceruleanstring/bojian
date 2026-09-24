import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { extractRuleText, checkRuleLimits, scopeKey, attName, attKey, SharedError, RULE_EXTS, LIMITS, viewKind, normName } from '../src/shared.js';

test('L7 ⑤：查看形態——md／txt 原文、docx／xlsx／csv 走排版預覽、pdf 與圖等不能頁內看（null）；normName NFC＋去頭尾空白', () => {
  assert.equal(viewKind('a.md'), 'text');
  assert.equal(viewKind('b.TXT'), 'text');
  for (const n of ['c.docx', 'd.xlsx', 'e.csv']) assert.equal(viewKind(n), 'preview', n);
  for (const n of ['f.pdf', 'g.png', 'h', '']) assert.equal(viewKind(n), null, n);
  assert.equal(normName(' café.md '.normalize('NFD')), 'café.md'.normalize('NFC'));
  assert.equal(normName(undefined), '');
});

// ---- 共用檔純函式（規範轉文字、上限、跨層鍵）----

test('U1a ①：規範轉文字——md／txt 原文、docx 取得文字、xlsx／pdf／其他副檔名各回一句人話', async () => {
  assert.deepEqual(RULE_EXTS, ['md', 'txt', 'docx']);
  assert.equal(await extractRuleText(Buffer.from('# 手冊\n語氣要親切', 'utf8'), '手冊.md'), '# 手冊\n語氣要親切');
  assert.equal(await extractRuleText(Buffer.from('一行規範', 'utf8'), '規範.TXT'), '一行規範', '副檔名不分大小寫');
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('員工手冊第一章')] })] }] });
  const fromDocx = await extractRuleText(await Packer.toBuffer(doc), '手冊.docx');
  assert.ok(fromDocx.includes('員工手冊第一章'), fromDocx);
  await assert.rejects(() => extractRuleText(Buffer.from('x'), '表.xlsx'), (e) => e instanceof SharedError && e.code === 'BAD_KIND' && e.message === '表格不是規範，請放參考');
  await assert.rejects(() => extractRuleText(Buffer.from('x'), '文件.pdf'), (e) => e instanceof SharedError && e.code === 'BAD_KIND' && e.message === 'PDF 還轉不了文字，請改上傳 docx 或貼文字');
  await assert.rejects(() => extractRuleText(Buffer.from('x'), '圖.png'), (e) => e instanceof SharedError && e.code === 'BAD_KIND' && e.message.includes('md、txt、docx'));
});

test('U1a ②：字數上限——單檔 4,000、每層 8,000；剛好 8,000 放行', () => {
  assert.deepEqual(LIMITS, { per_file: 4000, per_layer: 8000 });
  assert.equal(checkRuleLimits(4001, 0), '太長，請精簡或改放參考');
  assert.equal(checkRuleLimits(100, 7950), '太長，請精簡或改放參考');
  assert.equal(checkRuleLimits(4000, 4000), null);
  assert.equal(checkRuleLimits(0, 0), null);
});

test('U1a：跨層鍵——scopeKey 公司→_company、分類→分類名；attName／attKey 字串原樣、物件標層', () => {
  assert.equal(scopeKey('company', '行銷'), '_company');
  assert.equal(scopeKey('category', '行銷'), '行銷');
  assert.equal(attName('a.txt'), 'a.txt');
  assert.equal(attName({ scope: 'company', name: 'b.md' }), 'b.md（組織）');
  assert.equal(attName({ scope: 'category', name: 'c.md' }), 'c.md（分類）');
  assert.equal(attKey('a.txt'), 'a.txt');
  assert.equal(attKey({ scope: 'company', name: 'b.md' }), 'company:b.md');
  assert.equal(attKey({ scope: 'category', name: 'c.md' }), 'category:c.md');
});
