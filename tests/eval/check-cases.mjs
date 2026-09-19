// 真 AI 案例集：拿真的 claude 當查核員，逐案跑 checker.runCheck，看它攔不攔得到。
// 這不是 node --test 的一員（副檔名 .mjs、放在 tests/eval/，不符合預設 test glob）——它會花錢、要連宿主，
// 是量測工具不是門禁，所以結束碼永遠 0：報表歸報表，不擋 CI。
//
//   用法（在 bojian/ 底下）：
//     node tests/eval/check-cases.mjs               全部八案
//     node tests/eval/check-cases.mjs --only 03     只跑檔名開頭是 03 的那案
//     node tests/eval/check-cases.mjs --out <資料夾>  查核員回覆原文往哪存（預設系統暫存區）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostAdapter } from '../../src/host-adapter.js';
import { runCheck, extractFileText } from '../../src/checker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASE_DIR = path.join(HERE, 'cases');

function parseArgs(argv) {
  const out = { only: null, outDir: path.join(os.tmpdir(), 'bojian-check-eval') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') out.only = argv[++i] ?? null;
    else if (argv[i] === '--out') out.outDir = argv[++i] ?? out.outDir;
  }
  return out;
}

// 表格對齊：中日韓字與全形標點在終端機佔兩格，用字元數對齊會歪掉
const wide = (c) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(c);
const width = (s) => [...String(s)].reduce((n, c) => n + (wide(c) ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));

function table(rows, headers) {
  const all = [headers, ...rows];
  const w = headers.map((_, i) => Math.max(...all.map((r) => width(r[i] ?? ''))));
  const line = (r) => r.map((c, i) => pad(c ?? '', w[i])).join('  ').trimEnd();
  return [line(headers), w.map((n) => '-'.repeat(n)).join('  '), ...rows.map(line)].join('\n');
}

// 成品：檔案案例（productDocx）當場用 docx 造真檔，再走 extractFileText——查的是抽出來的文字，跟 runner 同一條路
async function productOf(c) {
  if (!c.productDocx) return { product: String(c.product ?? ''), via: '文字' };
  const { Document, Packer, Paragraph } = await import('docx');
  const doc = new Document({ sections: [{ children: c.productDocx.paragraphs.map((t) => new Paragraph(String(t))) }] });
  const buf = await Packer.toBuffer(doc);
  const name = c.productDocx.fileName ?? '成品.docx';
  const text = await extractFileText(buf, name);
  if (text === null) throw new Error(`造出來的 ${name} 抽不到文字`);
  return { product: text, via: `docx ${buf.length}B` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outDir, { recursive: true });
  const files = fs.readdirSync(CASE_DIR).filter((f) => f.endsWith('.json')).sort()
    .filter((f) => !args.only || f.startsWith(args.only));
  if (!files.length) {
    console.log(`沒有符合的案例（--only ${args.only}）`);
    return;
  }

  const adapter = createHostAdapter();
  const usage = [];
  adapter.setUsageSink((u) => usage.push(u));
  const tokensOf = (caseId) => usage.filter((u) => u.node === caseId && u.kind === 'check')
    .reduce((a, u) => ({
      input: a.input + (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      output: a.output + (u.output_tokens ?? 0),
    }), { input: 0, output: 0 });

  const rows = [];
  const summaries = [];
  let miss = 0; // 漏抓：該攔沒攔
  let falseBlock = 0; // 誤攔：不該攔卻攔了
  let incomplete = 0;
  let odd = 0; // 其他不對盤（該攔卻走成 missing 之類）
  let totalIn = 0;
  let totalOut = 0;

  for (const file of files) {
    const caseId = file.replace(/\.json$/, '');
    const c = JSON.parse(fs.readFileSync(path.join(CASE_DIR, file), 'utf8'));
    const { product, via } = await productOf(c);

    // runCheck 只吃 adapter.complete——包一層把查核員的回覆原文留下來，好在報告裡逐字引用
    let raw = '';
    const spy = {
      complete: async (a) => {
        try {
          raw = await adapter.complete(a);
          return raw;
        } catch (e) {
          raw = `【呼叫失敗】${e?.message ?? e}`;
          throw e;
        }
      },
    };

    const t0 = Date.now();
    const res = await runCheck({
      adapter: spy,
      meta: { run: 'eval', node: caseId },
      title: c.title,
      requirements: c.requirements,
      sources: c.sources,
      product,
      onPrompt: (p) => fs.writeFileSync(path.join(args.outDir, `${caseId}.prompt.txt`), p, 'utf8'),
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    fs.writeFileSync(path.join(args.outDir, `${caseId}.reply.txt`), raw, 'utf8');
    fs.writeFileSync(path.join(args.outDir, `${caseId}.result.json`), JSON.stringify(res, null, 2), 'utf8');

    const tok = tokensOf(caseId);
    totalIn += tok.input;
    totalOut += tok.output;
    const blocked = res.status === 'blocked';
    if (res.status === 'incomplete') incomplete++;
    else if (c.expect === 'block' && res.status === 'pass') miss++;
    else if (c.expect === 'pass' && blocked) falseBlock++;
    else if (c.expect === 'block' && !blocked) odd++;
    else if (c.expect === 'pass' && res.status !== 'pass') odd++;

    const kinds = [...new Set(res.blocks.map((b) => b.kind))].join(',') || '－';
    const ok = res.status === 'incomplete' ? '？'
      : (c.expect === 'block' ? blocked : res.status === 'pass') ? '✓' : '✗';
    rows.push([
      `${caseId}`,
      c.title,
      c.expect === 'block' ? '攔' : '過',
      res.status,
      ok,
      kinds,
      res.flags.map((f) => f.kind).join(',') || '－',
      `${tok.input}+${tok.output}`,
      `${secs}s`,
      via,
    ]);
    summaries.push([caseId, res.summary || res.note || '（沒有一句話）', res.blocks.map((b) => `${b.kind}：${b.detail}`)]);
  }

  console.log('');
  console.log(table(rows, ['案例', '案名', '預期', '實得', '對', 'blocks', 'flags', 'token(入+出)', '耗時', '成品']));
  console.log('');
  for (const [id, s, blocks] of summaries) {
    console.log(`${id}｜${s}`);
    for (const b of blocks) console.log(`      └ ${b}`);
  }
  console.log('');
  console.log(`漏抓 ${miss}／誤攔 ${falseBlock}／incomplete ${incomplete}／其他不對盤 ${odd}／token 合計 入 ${totalIn} 出 ${totalOut}（共 ${totalIn + totalOut}）`);
  console.log(`回覆原文與結果：${args.outDir}`);
}

main().catch((e) => {
  console.error('案例集跑不完：', e?.stack ?? e);
}); // 結束碼永遠 0：這是報表不是門禁
