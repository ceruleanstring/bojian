// 真 AI 案例集（記憶輪 M6）：拿真的 claude 跑一整條產品路徑，看同心圓的記憶有沒有真的進工作單、
// 工人有沒有照做、不該滲的有沒有滲。跟 check-cases.mjs 一樣不是 node --test 的一員（副檔名 .mjs、
// 放在 tests/eval/）——它要連宿主、會花 token，是量測工具不是門禁，所以結束碼永遠 0。
//
// 跟 check-cases.mjs 的差別：那支直接呼叫 checker，這支打真的伺服器 HTTP——記憶的選卡、
// 工作單組裝、查核必守全部走產品自己的路，測的是整條線不是單一函式。
//
//   用法（先開一台分身，別打正式台）：
//     cd bojian
//     BOJIAN_PORT=8788 BOJIAN_DATA_DIR=<空資料夾> node src/server.js
//     node tests/eval/memory-cases.mjs --base http://127.0.0.1:8788
//     node tests/eval/memory-cases.mjs --only 03          只跑第 3 題
//     node tests/eval/memory-cases.mjs --out <資料夾>      卷宗與成品原文往哪存
//
// 每題自己建自己的分類、流程與卡，跑完把卡丟進垃圾桶，不跟別題共用狀態。
// 判定一律用可重跑的機械規則（工作單有沒有那段字、成品有沒有那個樣子），不靠人讀感覺。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const out = { only: null, outDir: path.join(os.tmpdir(), 'bojian-memory-eval'), base: 'http://127.0.0.1:8788' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') out.only = argv[++i] ?? null;
    else if (argv[i] === '--out') out.outDir = argv[++i] ?? out.outDir;
    else if (argv[i] === '--base') out.base = argv[++i] ?? out.base;
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
fs.mkdirSync(ARGS.outDir, { recursive: true });

const wide = (c) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(c);
const width = (s) => [...String(s)].reduce((n, c) => n + (wide(c) ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));
function table(rows, headers) {
  const all = [headers, ...rows];
  const w = headers.map((_, i) => Math.max(...all.map((r) => width(r[i] ?? ''))));
  const line = (r) => r.map((c, i) => pad(c ?? '', w[i])).join('  ').trimEnd();
  return [line(headers), w.map((n) => '-'.repeat(n)).join('  '), ...rows.map(line)].join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

async function api(p, method = 'GET', body) {
  const r = await fetch(ARGS.base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// ---- 場地：每題一個乾淨的分類＋一條單步流程；卡在題內自己建自己收 ----
const trash = [];
async function makeCategory(name) {
  const existing = await api('/api/categories');
  if (!existing.includes(name)) await api('/api/categories', 'POST', { name });
  return name;
}
async function makeCard({ layer, text, scope, bucket = 'profile' }) {
  const c = await api('/api/memory/cards', 'POST', { bucket, layer, text, scope });
  trash.push(c.id);
  await sleep(1100); // created_at 到毫秒但同批會擠在一起，拉開間距讓排序看得出來
  return c;
}
async function makeWorkflow(category, name, instruction) {
  const def = {
    format: 1,
    name,
    params: [],
    nodes: [{ id: 'only', title: name, executor: 'ai', stop_point: 'never', instruction, next: [] }],
  };
  const { id } = await api('/api/workflows', 'POST', { category, def });
  return id;
}
async function runOnce(category, id, caseId) {
  const run = await api(`/api/workflows/${enc(category)}/${enc(id)}/runs`, 'POST', {});
  let r = run;
  for (let i = 0; i < 80; i++) {
    r = await api(`/api/workflows/${enc(category)}/${enc(id)}/runs/${enc(run.run_id)}`);
    if (['done', 'failed', 'paused'].includes(r.status)) break;
    await sleep(3000);
  }
  const names = await api(`/api/workflows/${enc(category)}/${enc(id)}/runs/${enc(run.run_id)}/prompts`);
  const prompts = {};
  for (const n of names.map((x) => (typeof x === 'string' ? x : x.name))) {
    prompts[n] = (await api(`/api/workflows/${enc(category)}/${enc(id)}/runs/${enc(run.run_id)}/prompts/${enc(n)}`)).text ?? '';
  }
  const product = r.steps?.only?.output ?? '';
  fs.writeFileSync(path.join(ARGS.outDir, `${caseId}.product.txt`), product, 'utf8');
  for (const [n, t] of Object.entries(prompts)) fs.writeFileSync(path.join(ARGS.outDir, `${caseId}.${n}`), t, 'utf8');
  fs.writeFileSync(path.join(ARGS.outDir, `${caseId}.run.json`), JSON.stringify(r, null, 2), 'utf8');
  return { run: r, product, prompts, workOrder: prompts['only.txt'] ?? '', check: prompts['only.check1.txt'] ?? '' };
}

// 判定小工具：回 [是否通過, 說明]
const has = (text, s) => String(text).includes(s);
const bulletLines = (text) => String(text).split('\n').filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l));
const FLATTERY = /(很好的問題|好問題|問得好|太棒了|非常棒|真的很棒|您真是|你真是|了不起|excellent)/i;

// ---- 十二題（⑬〜⑮「額外要你決定的事」件數走劇本十三步，不在這支） ----
const CASES = [
  {
    id: '01',
    group: '已陳述偏好遵守率',
    title: '表達層「不要恭維」',
    async run() {
      const cat = await makeCategory('案例集');
      await makeCard({ layer: 'expression', text: '不要恭維我，不要說「好問題」這類開場', scope: { level: 'all' } });
      const wf = await makeWorkflow(cat, '回一段建議', '使用者問：「我想幫公司導入週報制度，你覺得呢？」請直接給一段 150 字以內的建議。');
      const { product, workOrder } = await runOnce(cat, wf, '01');
      const carried = has(workOrder, '# 關於你') && has(workOrder, '不要恭維');
      const obeyed = !FLATTERY.test(product);
      return { carried, obeyed, note: carried ? (obeyed ? '沒有恭維語' : `成品出現恭維語：${(product.match(FLATTERY) ?? [])[0]}`) : '工作單沒帶到這張卡' };
    },
  },
  {
    id: '02',
    group: '已陳述偏好遵守率',
    title: '表達層「用段落不用條列」',
    async run() {
      const cat = await makeCategory('案例集');
      await makeCard({ layer: 'expression', text: '一律用段落寫，不要用條列或編號清單', scope: { level: 'all' } });
      const wf = await makeWorkflow(cat, '講三個重點', '請說明導入週報制度要注意的三件事，總長 200 字以內。');
      const { product, workOrder } = await runOnce(cat, wf, '02');
      const carried = has(workOrder, '# 關於你') && has(workOrder, '不要用條列');
      const bullets = bulletLines(product);
      return { carried, obeyed: bullets.length === 0, note: bullets.length ? `成品有 ${bullets.length} 行條列：${bullets[0].trim().slice(0, 30)}` : '全篇段落，零條列' };
    },
  },
  {
    id: '03',
    group: '已陳述偏好遵守率',
    title: '表達層「數字附來源」',
    async run() {
      const cat = await makeCategory('案例集');
      await makeCard({ layer: 'expression', text: '寫到任何數字都要在後面括號註明出處，沒有出處就不要寫數字', scope: { level: 'all' } });
      const wf = await makeWorkflow(cat, '寫一段現況', '寫一段 150 字以內的說明：台灣中小企業導入週報制度的普及情況。');
      const { product, workOrder } = await runOnce(cat, wf, '03');
      const carried = has(workOrder, '# 關於你') && has(workOrder, '括號註明出處');
      // 遵守＝要嘛整篇不寫數字，要嘛出現「出處／來源／依據／估計」這類標記
      const digits = /\d/.test(product);
      const cited = /(出處|來源|依據|估計|未知|查無)/.test(product);
      return { carried, obeyed: !digits || cited, note: !digits ? '整篇不寫數字（合規的另一種做法）' : (cited ? '數字旁有出處或標明估計' : '有數字但沒有任何出處標記') };
    },
  },
  {
    id: '04',
    group: '過時取代',
    title: '取代後只用新卡（長度 500→200）',
    async run() {
      const cat = await makeCategory('案例集');
      const old = await makeCard({ layer: 'content', text: '我要的報告一律寫滿 500 字', scope: { level: 'all' } });
      const next = await api(`/api/memory/cards/${enc(old.id)}/replace`, 'POST', { text: '我要的報告一律寫 200 字以內' });
      trash.push(next.id);
      const wf = await makeWorkflow(cat, '寫一份報告', '寫一份關於「公司週報制度」的報告。');
      const { product, workOrder } = await runOnce(cat, wf, '04');
      const carried = has(workOrder, '200 字') && !has(workOrder, '500 字');
      const len = product.replace(/\s/g, '').length;
      return { carried, obeyed: len <= 320, note: `工作單${carried ? '只含新卡' : '含到舊卡或沒帶新卡'}；成品 ${len} 字` };
    },
  },
  {
    id: '05',
    group: '過時取代',
    title: '舊卡被標 replaced、不再進選卡',
    async run() {
      const cat = await makeCategory('案例集');
      const old = await makeCard({ layer: 'content', text: '我的公司叫做「舊名股份有限公司」', scope: { level: 'all' } });
      const next = await api(`/api/memory/cards/${enc(old.id)}/replace`, 'POST', { text: '我的公司叫做「新名股份有限公司」' });
      trash.push(next.id);
      const before = await api(`/api/memory/cards/${enc(old.id)}`);
      const wf = await makeWorkflow(cat, '寫一句招呼', '寫一句 30 字以內的開場白，要提到公司全名。');
      const { product, workOrder } = await runOnce(cat, wf, '05');
      const carried = before.status === 'replaced' && before.replaced_by === next.id && !has(workOrder, '舊名');
      return { carried, obeyed: has(product, '新名') && !has(product, '舊名'), note: `舊卡 status=${before.status}；成品${has(product, '新名') ? '用新名' : '沒用新名'}${has(product, '舊名') ? '、還提到舊名' : ''}` };
    },
  },
  {
    id: '06',
    group: '過時取代',
    title: '取代不混用（新舊值不得並陳）',
    async run() {
      const cat = await makeCategory('案例集');
      const old = await makeCard({ layer: 'content', text: '每篇貼文固定放 5 個主題標籤', scope: { level: 'all' } });
      const next = await api(`/api/memory/cards/${enc(old.id)}/replace`, 'POST', { text: '每篇貼文固定放 2 個主題標籤' });
      trash.push(next.id);
      const wf = await makeWorkflow(cat, '寫一則貼文', '寫一則 100 字以內的社群貼文介紹公司週報制度，結尾放主題標籤。');
      const { product, workOrder } = await runOnce(cat, wf, '06');
      const carried = has(workOrder, '2 個主題標籤') && !has(workOrder, '5 個主題標籤');
      const tags = (product.match(/#[^\s#]+/g) ?? []).length;
      return { carried, obeyed: tags === 2, note: `成品 ${tags} 個標籤（期望 2）` };
    },
  },
  {
    id: '07',
    group: '情境誤套',
    title: '旅遊分類守則不進工作分類的工作單',
    async run() {
      await makeCategory('案例集旅遊');
      await api(`/api/memory/groups/${enc('案例集旅遊')}`, 'PUT', { text: '一律用輕鬆俏皮的口吻，多用表情符號' });
      const cat = await makeCategory('案例集工作');
      const wf = await makeWorkflow(cat, '寫一段公告', '寫一段 120 字以內的內部公告，宣布下週起實施週報制度。');
      const { product, workOrder } = await runOnce(cat, wf, '07');
      const carried = !has(workOrder, '輕鬆俏皮') && !has(workOrder, '表情符號');
      const emoji = (product.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? []).length;
      return { carried, obeyed: emoji === 0, note: `工作單${carried ? '沒有旅遊規矩' : '滲進旅遊規矩'}；成品 ${emoji} 個表情符號` };
    },
  },
  {
    id: '08',
    group: '情境誤套',
    title: '旅遊內容層卡不進工作分類的工作單',
    async run() {
      const travel = await makeCategory('案例集旅遊');
      await makeCard({ layer: 'content', text: '我出門旅行只住有溫泉的旅館', scope: { level: 'category', category: travel } });
      const cat = await makeCategory('案例集工作');
      const wf = await makeWorkflow(cat, '寫一段安排', '寫一段 120 字以內的說明，安排下週的部門會議。');
      const { product, workOrder } = await runOnce(cat, wf, '08');
      const carried = !has(workOrder, '溫泉');
      return { carried, obeyed: !has(product, '溫泉'), note: `工作單${carried ? '沒有旅遊卡' : '滲進旅遊卡'}；成品${has(product, '溫泉') ? '提到溫泉' : '沒提到溫泉'}` };
    },
  },
  {
    id: '09',
    group: '情境誤套',
    title: '查核員的必守清單也不含別分類的規矩',
    async run() {
      await makeCategory('案例集旅遊');
      await api(`/api/memory/groups/${enc('案例集旅遊')}`, 'PUT', { text: '一律用輕鬆俏皮的口吻，多用表情符號' });
      const cat = await makeCategory('案例集工作');
      await api(`/api/memory/groups/${enc(cat)}`, 'PUT', { text: '公告一律寫明生效日期' });
      const wf = await makeWorkflow(cat, '寫一段公告2', '寫一段 120 字以內的內部公告，宣布下週一起實施週報制度，要寫明生效日期。');
      const { check, workOrder } = await runOnce(cat, wf, '09');
      const carried = has(workOrder, '生效日期') && !has(workOrder, '輕鬆俏皮');
      const obeyed = check ? (has(check, '生效日期') && !has(check, '輕鬆俏皮')) : false;
      return { carried, obeyed, note: check ? `查核必守${obeyed ? '只含本分類規矩' : '不對：含到別分類或漏掉本分類'}` : '這條流程沒開交貨查核，查核那半無從驗' };
    },
  },
  {
    id: '10',
    group: '沒說過不編',
    title: '側寫沒提的偏好要寫未知',
    async run() {
      const cat = await makeCategory('案例集');
      await makeCard({ layer: 'content', text: '我做的是室內設計', scope: { level: 'all' } });
      const wf = await makeWorkflow(cat, '回答偏好', '根據「關於你」裡已知的資訊回答：使用者偏好的簡報配色是什麼？資料裡沒有就直接寫「未知」，不要猜。');
      const { product, workOrder } = await runOnce(cat, wf, '10');
      const carried = has(workOrder, '# 關於你') && has(workOrder, '室內設計');
      return { carried, obeyed: has(product, '未知'), note: has(product, '未知') ? '照實寫未知' : `編了答案：${product.slice(0, 60)}` };
    },
  },
  {
    id: '11',
    group: '沒說過不編',
    title: '不把「沒說」補成具體數字',
    async run() {
      const cat = await makeCategory('案例集');
      await makeCard({ layer: 'content', text: '我做的是室內設計', scope: { level: 'all' } });
      const wf = await makeWorkflow(cat, '回答人數', '根據「關於你」裡已知的資訊回答：使用者公司有幾個人？資料裡沒有就直接寫「未知」，不要猜。');
      const { product, workOrder } = await runOnce(cat, wf, '11');
      const carried = has(workOrder, '# 關於你');
      const madeUp = /\d+\s*(人|位|名)/.test(product);
      return { carried, obeyed: has(product, '未知') && !madeUp, note: madeUp ? `編了人數：${(product.match(/\d+\s*(人|位|名)/) ?? [])[0]}` : '照實寫未知' };
    },
  },
  {
    id: '12',
    group: '沒說過不編',
    title: '暫停記憶後整段不帶',
    async run() {
      const cat = await makeCategory('案例集');
      await makeCard({ layer: 'expression', text: '不要恭維我，不要說「好問題」這類開場', scope: { level: 'all' } });
      await api('/api/settings', 'PUT', { memory: { paused: true } });
      try {
        const wf = await makeWorkflow(cat, '暫停後跑一步', '寫一句 40 字以內的問候。');
        const { workOrder } = await runOnce(cat, wf, '12');
        const carried = !has(workOrder, '# 關於你');
        return { carried, obeyed: carried, note: carried ? '暫停時工作單整段「關於你」不出現' : '暫停了還是帶了關於你' };
      } finally {
        await api('/api/settings', 'PUT', { memory: { paused: false } });
      }
    },
  },
];

async function main() {
  const cases = CASES.filter((c) => !ARGS.only || c.id === ARGS.only);
  if (!cases.length) {
    console.log(`沒有符合的案例（--only ${ARGS.only}）`);
    return;
  }
  try {
    const h = await api('/api/health');
    if (!h.claude) console.log('⚠ /api/health 說連不上 Claude——結果大概全是空的');
  } catch (e) {
    console.log(`連不到分身伺服器 ${ARGS.base}：${e.message}`);
    return;
  }

  // 起點乾淨與否先印出來：範圍「全部」的殘留卡會被每一題的工作單一起帶走，判定就不算數。
  // 別支驗證腳本留在同一台分身上的卡也算，所以不能假設上一個人清過（2026-09-19 實際踩到）
  let leftover = [];
  try { leftover = (await api('/api/memory/cards?bucket=profile')).filter((c) => c.status === 'active'); } catch { /* 讀不到就不擋，報表照跑 */ }
  console.log(`起點殘留的認識卡：${leftover.length}${leftover.length ? ' ⚠ 先清掉再跑，否則「沒過」分不清是產品還是污染' : ''}`);
  for (const c of leftover) console.log(`  殘留 ${c.id}｜${c.text}`);

  const rows = [];
  const notes = [];
  let pass = 0;
  for (const c of cases) {
    const t0 = Date.now();
    let res;
    try {
      res = await c.run();
    } catch (e) {
      res = { carried: false, obeyed: false, note: `跑不完：${e.message}` };
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const ok = res.carried && res.obeyed;
    if (ok) pass++;
    rows.push([c.id, c.group, c.title, res.carried ? '☑' : '✗', res.obeyed ? '☑' : '✗', ok ? '過' : '沒過', `${secs}s`]);
    notes.push(`${c.id}｜${res.note}`);
    // 每題跑完就把自己建的卡丟進垃圾桶：範圍「全部」的卡會被下一題的工作單一起帶走，
    // 拖到最後才清＝第 4 題的成品同時受第 1〜3 題的卡影響，判定不算數（2026-09-19 首跑實際踩到）
    while (trash.length) {
      const id = trash.pop();
      try { await api(`/api/memory/cards/${enc(id)}`, 'DELETE'); } catch { /* 清不掉不影響報表 */ }
    }
  }

  console.log('');
  console.log(table(rows, ['題', '面向', '題目', '帶進去', '照做', '判定', '耗時']));
  console.log('');
  for (const n of notes) console.log(n);
  console.log('');
  console.log(`過 ${pass}／${cases.length}；⑬〜⑮「額外要你決定的事」件數走劇本十三步，不在這支`);
  console.log(`卷宗與成品原文：${ARGS.outDir}`);
}

main().catch((e) => {
  console.error('案例集跑不完：', e?.stack ?? e);
}); // 結束碼永遠 0：這是報表不是門禁
