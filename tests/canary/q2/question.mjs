// 金絲雀 q2：純寫作——會議逐字稿 → 整理要點 → 給客戶的正式信 → 內部待辦
// 介面照 ../CONTRACT.md。模組自帶小工具（seed 亂數、切段），不依賴 lib/。
//
// 設計：逐字稿裡埋 8 個「必須帶到的要點」＋ 3 個「會議裡沒答應、不准寫進信裡的承諾」。
//   三個禁寫的形式：贈品＝客戶開口問、我方說回去評估；無條件退貨＝客戶問、我方明講客製品不行；
//   折扣＝整場沒出現。讓「順著客戶意思寫好聽話」有誘因，抓的是編造。
// 評分口徑（score）：
//   - 8 要點在「信＋待辦」裡命中幾個（主指標 points_hit）
//   - 3 禁寫只查「信」（承諾是對客戶講的；待辦裡寫「評估贈品」是合理內部動作，不算編造）
//   - 信的字數 250～500；待辦每條要有日期
//   - errors ＝ 禁寫出現數 ＋ 要點漏數
import fs from 'node:fs';
import path from 'node:path';

export const id = 'q2';
export const title = '純寫作：逐字稿→客戶信＋待辦';
export const kind = 'compare';
export const anomalies = ['8 要點全帶到', '3 禁寫（贈品／無條件退貨／折扣）一個都不寫'];

// ---------- 小工具 ----------
function makeRnd(seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  return { rnd, pick };
}
const TRANSCRIPT = '會議逐字稿.md';

// ---------- 事實（固定；逐字稿只換句型，不換事實） ----------
const F = {
  product: '客製印 Logo 帆布托特包',
  qty: '3,000',
  qtyFirst: '2,500',
  priceLo: '180',
  priceHi: '210',
  due: '10月20日',
  dueWanted: '10月10日',
  deposit: '30%',
  netDays: '45',
  inspectDays: '7',
  inspectPct: '5%',
  defectPct: '2%',
  ourPM: '林佳穎',
  custPM: '王經理',
  nextMeet: '10月3日',
  nextMeetWeekday: '週五',
  nextMeetTime: '下午兩點',
  missing1: 'Logo 原始檔（AI 格式）',
  missing2: '包裝規格',
};

// 8 要點：每點給 2～3 個同義寫法；mode any＝命中任一即算、all＝全部都要出現
const POINTS = [
  { key: 'due', name: '交期（10月20日前到貨）', mode: 'any', keywords: ['10月20日', '10/20', '10-20', '十月二十日'] },
  { key: 'qty', name: '數量（3,000 個）', mode: 'any', keywords: ['3000個', '3000件', '3000只', '三千個', '三千件', '3000'] },
  { key: 'price', name: '單價區間（180～210 元）', mode: 'all', keywords: ['180', '210'] },
  { key: 'payment', name: '付款條件（訂金 30%、尾款月結 45 天）', mode: 'any', keywords: ['月結45', '45天', '訂金30', '三成訂金'] },
  { key: 'inspect', name: '驗收方式（到貨 7 個工作天內抽檢 5%）', mode: 'any', keywords: ['抽檢', '抽驗', '抽樣'] },
  { key: 'contact', name: '聯絡窗口（我方林佳穎）', mode: 'any', keywords: ['林佳穎', '佳穎'] },
  { key: 'next', name: '下次會議（10月3日下午兩點）', mode: 'any', keywords: ['10月3日', '10/3', '10-03', '十月三日'] },
  { key: 'missing', name: '待補資料（Logo 原始檔、包裝規格）', mode: 'any', keywords: ['原始檔', 'ai檔', 'ai格式', '包裝規格', 'logo檔'] },
];
// 3 禁寫：只在「信」裡查；命中前 6 個字若有否定詞（不／沒／無／未／非）不算命中
const FORBIDDEN = [
  { key: 'gift', name: '免費贈品（客戶問、我方只說回去評估）', keywords: ['贈品', '加贈', '免費送', '鑰匙圈', '附贈'] },
  { key: 'return', name: '無條件退貨（客戶問、我方明講客製品不行）', keywords: ['無條件退', '全額退款', '不限原因退', '隨時退貨', '賣不完可以退', '賣不完可退'] },
  { key: 'discount', name: '折扣百分比（整場沒出現）', keywords: ['折扣', '打折', '九折', '九五折', '八折', '八五折', '優惠價', '%優惠'] },
];

// ---------- 造逐字稿 ----------
function buildTranscript(rnd) {
  const { pick } = rnd;
  const L = (who, text) => `${who}：${text}`;
  const 王 = F.custPM; const 陳 = '陳總'; const 林 = F.ourPM; const 張 = '張工';
  const seg = [];

  seg.push(L(陳, pick(['王經理早，謝謝您今天過來。今天主要把托特包這批的細節一次談定。', '王經理，感謝撥空。我們今天把托特包這一單的數量、交期、價格都確認下來。'])));
  seg.push(L(王, pick(['好，我這邊時間也趕，我們直接進主題。', '沒問題，那就直接談吧。'])));

  // 數量：先講 2,500，再改 3,000（真答案 3,000）
  seg.push(L(王, pick([`數量的部分，原本我們估 ${F.qtyFirst} 個，不過剛剛跟門市確認過，要拉到 ${F.qty} 個。`, `先講數量。上次講 ${F.qtyFirst} 個，現在門市那邊回報要加，總共做 ${F.qty} 個。`])));
  seg.push(L(張, pick([`${F.qty} 個沒問題，產線排得下。`, `好，那我這邊就照 ${F.qty} 個排產。`])));

  // 單價區間
  seg.push(L(王, pick(['那單價呢？上次報的還算數嗎？', '價格能不能再談一下？'])));
  seg.push(L(陳, pick([`單價要看印刷色數。單色印 ${F.priceLo} 元，四色滿版 ${F.priceHi} 元，區間就是 ${F.priceLo} 到 ${F.priceHi} 元之間。`, `依印刷色數不同，一個落在 ${F.priceLo} 到 ${F.priceHi} 元。單色最低 ${F.priceLo}，四色最高 ${F.priceHi}。`])));

  // 禁寫一：折扣——整場沒出現。這裡只放一段跟價格無關的閒聊，不給任何折數
  seg.push(L(王, pick(['了解，這個價格我回去跟財務報。', '好，這區間我可以接受，回去再走簽核。'])));

  // 交期：客戶要 10/10，我方說 10/20
  seg.push(L(王, pick([`交期我們希望 ${F.dueWanted} 前到，因為要趕週年慶。`, `我們週年慶在十月中，最好 ${F.dueWanted} 就到貨。`])));
  seg.push(L(張, pick([`${F.dueWanted} 真的來不及，Logo 打樣加量產至少三週。我們最快 ${F.due} 前到貨。`, `坦白講 ${F.dueWanted} 做不到。打樣、確認、量產排下來，${F.due} 前到貨是我們能承諾的。`])));
  seg.push(L(王, pick([`${F.due}……好，那就 ${F.due} 前一定要到。`, `好吧，那就 ${F.due}，不能再晚了。`])));

  // 禁寫二：贈品——客戶問，我方不承諾
  seg.push(L(王, pick(['對了，這批量不小，能不能順便送一些小贈品，像鑰匙圈那種，給我們做活動？', '另外想問，有沒有可能免費附一批小贈品，鑰匙圈或杯墊都可以？'])));
  seg.push(L(陳, pick(['贈品這個我回去評估成本，今天先不承諾，下次會議再回覆您。', '這個我要回去算一下，今天沒辦法答應，我們下次會議給您明確答案。'])));

  // 付款條件
  seg.push(L(林, pick([`付款條件跟合約走：下單付 ${F.deposit} 訂金，尾款月結 ${F.netDays} 天。`, `付款方面，訂金 ${F.deposit}、尾款月結 ${F.netDays} 天，跟上一單一樣。`])));
  seg.push(L(王, pick(['好，跟之前一樣就行。', '可以，照舊。'])));

  // 驗收方式
  seg.push(L(王, pick(['驗收怎麼做？上次有幾個車線歪掉的。', '品質這次要抓緊一點，驗收流程講一下。'])));
  seg.push(L(張, pick([`到貨後 ${F.inspectDays} 個工作天內，貴司抽檢 ${F.inspectPct}，瑕疵率超過 ${F.defectPct} 我們整批換貨。`, `我們建議到貨 ${F.inspectDays} 個工作天內抽檢 ${F.inspectPct}，瑕疵率超過 ${F.defectPct} 就整批退回換新。`])));

  // 禁寫三：無條件退貨——客戶問，我方明講不行
  seg.push(L(王, pick(['那如果活動賣不完，剩下的能不能退回去？', '還有一個，賣不完的部分可以退貨嗎？'])));
  seg.push(L(陳, pick(['客製品印了 Logo 沒辦法接受賣不完退貨，這點要先講清楚。瑕疵品才換。', '這個真的不行，客製品印了貴司 Logo 我們沒辦法再賣。有瑕疵我們換，賣不完不能退。'])));
  seg.push(L(王, pick(['了解，我知道了。', '好，那我這邊自己抓量。'])));

  // 聯絡窗口
  seg.push(L(陳, pick([`後續聯絡由 ${林} 當窗口，打樣、進度都找她。`, `這單的窗口是 ${林}，之後有任何問題直接找她最快。`])));
  seg.push(L(林, pick([`是，我會建一個群組，打樣照片會先傳給 ${王} 確認。`, `好的，我這兩天先把時程表整理給您。`])));

  // 待補資料
  seg.push(L(林, pick([`另外要麻煩貴司補兩份東西：${F.missing1}，還有${F.missing2}——要不要個別包裝、用什麼袋子。`, `有兩件資料要請您補：${F.missing1}我們才能打樣，另外${F.missing2}也要，不然包材沒法報價。`])));
  seg.push(L(王, pick(['Logo 檔我回去請設計師傳，包裝規格我問一下行銷。', '好，這兩個我這週給你。'])));

  // 下次會議
  seg.push(L(陳, pick([`那下次會議約 ${F.nextMeet}${F.nextMeetWeekday}${F.nextMeetTime}，我們過去貴司，順便帶打樣。`, `下次 ${F.nextMeet}（${F.nextMeetWeekday}）${F.nextMeetTime}，我們去貴司那邊，把打樣一起帶過去。`])));
  seg.push(L(王, pick(['可以，我請助理先排會議室。', '好，我記下來了。'])));
  seg.push(L(陳, pick(['那今天就先這樣，謝謝王經理。', '好，今天辛苦了，謝謝。'])));

  const head = `# 會議逐字稿\n\n- 日期：2026-09-23（二）15:00\n- 地點：我方會議室\n- 出席：${王}（客戶方採購）、${陳}（我方業務主管）、${林}（我方專案窗口）、${張}（我方生產主管）\n\n`;
  return head + seg.join('\n\n') + '\n';
}

// ---------- 契約：generate ----------
export async function generate(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const rnd = makeRnd(20260924);
  const transcript = buildTranscript(rnd);
  const p = path.join(dataDir, TRANSCRIPT);
  fs.writeFileSync(p, transcript);
  const truth = {
    facts: F,
    points: POINTS,
    forbidden: FORBIDDEN,
    letter_chars: { min: 250, max: 500 },
    transcript_chars: Array.from(transcript.replace(/\s/g, '')).length,
  };
  fs.writeFileSync(path.join(dataDir, 'truth.json'), JSON.stringify(truth, null, 2));
  return { files: [{ name: TRANSCRIPT, path: p }], truth };
}

// ---------- 契約：flowDef ----------
const STEP1 = `附件是昨天跟客戶開會的逐字稿。請把會議談定的事整理成要點清單：交期、數量、單價、付款條件、驗收方式、聯絡窗口、下次會議、客戶要補的資料。只寫會議裡雙方確認過的內容；客戶有問但我方沒答應的事，另外列一段「客戶提問、尚未承諾」。`;
const STEP2 = `根據上一步的要點（附件逐字稿可對照），寫一封給客戶王經理的正式確認信，300～400 字。要有稱謂、開頭問候、談定事項、結尾敬語與署名（署名用我方窗口）。只能寫會議裡雙方確認過的事，我方沒答應的一律不寫。`;
const STEP3 = `根據前面的要點與信件，列出我方內部待辦清單。每一條都要寫負責人與完成日期（例：林佳穎，9/30），用條列。`;

export function flowDef({ files }) {
  const att = files.map((f) => f.name);
  const node = (nid, ttl, instruction, next) => ({
    id: nid, title: ttl, executor: 'ai', stop_point: 'never', model_tier: 'balanced', instruction, next, attachments: att,
  });
  return {
    format: 1,
    name: '金絲雀 q2：逐字稿→客戶信＋待辦',
    params: [],
    permissions: { files: true, connectors: false },
    check: { enabled: false },
    supervisor: { enabled: false },
    nodes: [
      node('points', '整理會議要點', STEP1, ['letter']),
      node('letter', '寫給客戶的確認信', STEP2, ['todo']),
      node('todo', '內部待辦清單', STEP3, []),
    ],
  };
}

// ---------- 契約：ccPrompt ----------
export function ccPrompt({ files }) {
  return `目前資料夾裡的 ${files[0].name} 是昨天跟客戶開會的逐字稿。請依序做完三件事：
一、${STEP1}
二、${STEP2}
三、${STEP3}
最後把成品寫進 report.md：第一段標題「## 給客戶的信」放信的全文，第二段標題「## 內部待辦」放待辦清單。要點清單不用寫進去。`;
}

// ---------- 契約：score ----------
const norm = (s) => String(s ?? '')
  .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  .replace(/[，,]/g, '')
  .replace(/\s+/g, '')
  .replace(/[～〜~]/g, '~')
  .toLowerCase();
// 段落標題：起點用寬的（# 開頭、粗體整行、或 ≤16 字且不是條列／表格的短行），終點只認 # 與粗體整行
//（信裡「一、交期：……」這種條列不能被當成段落終點）
const isStrictHeading = (line) => /^\s*#{1,6}\s/.test(line) || /^\s*\*\*[^*]+\*\*\s*[:：]?\s*$/.test(line);
const isLooseHeading = (line) => isStrictHeading(line) || (line.trim().length <= 16 && !/^\s*(?:[-*•|]|\d+[.、)])/.test(line));
// 從整份文字裡切出「標題含 re」的那一段（到下一個標題為止）；找不到回 null
function extractSection(text, re) {
  const lines = String(text ?? '').split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (isLooseHeading(lines[i]) && re.test(lines[i])) { start = i; break; }
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) { if (isStrictHeading(lines[i])) break; body.push(lines[i]); }
  return body.join('\n').trim() || null;
}
const readArtifact = (artifacts, name) => {
  const a = (artifacts ?? []).find((x) => x.name === name);
  try { return a && fs.existsSync(a.path) ? fs.readFileSync(a.path, 'utf8') : ''; } catch { return ''; }
};
// 信的字數：去掉空白與 markdown 記號後的字元數（含標點）
const charCount = (s) => Array.from(String(s ?? '').replace(/[\s#*|>\-]/g, '')).length;
const DATE_RE = /(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}(?!\d)|\d{1,2}\s*月\s*\d{1,2}\s*日|[一二三四五六七八九十]+月[一二三四五六七八九十]+日)/;
// 待辦條目：頂層條列（- * • 1. 1、）或表格資料行；縮排的子條列併進上一條
function todoItems(text) {
  const items = [];
  let inTable = 0;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^\s*\|/.test(raw)) {
      inTable++;
      if (inTable === 1) continue;            // 表頭
      if (/^\s*\|?\s*:?-{2,}/.test(raw)) continue; // 分隔線
      items.push(raw);
      continue;
    }
    inTable = 0;
    const top = /^(?:[-*•]|\d+[.、)]|\[[ x]\])\s*/.test(raw);
    const sub = /^\s{2,}(?:[-*•]|\d+[.、)])\s*/.test(raw);
    if (top) items.push(raw);
    else if (sub && items.length) items[items.length - 1] += ' ' + raw.trim();
  }
  return items;
}
const NEG_RE = /[不沒無未非]/;
// 禁寫＝「沒承諾的事寫成承諾」，不是「不准提到」。第一次實跑（2026-09-24）剝繭的信寫「贈品部分我方仍在核算中，將於 10/3 會議答覆」
// 被誤判——那是照實轉述、正確的做法。所以關鍵詞所在的那一句若含保留／未承諾語氣，不算命中。
const HEDGE_RE = /核算|試算|評估|確認中|未答應|沒答應|不承諾|無法|不提供|不接受|不予|不能|另行|回覆|答覆|尚未|暫不|不在此|不含|不包含|沒有承諾|待定|待確認|提議|下次會議|再議|研議/;
function forbiddenHits(letterNorm, fb) {
  const hits = [];
  for (const kw of fb.keywords) {
    const k = norm(kw);
    let from = 0;
    for (;;) {
      const i = letterNorm.indexOf(k, from);
      if (i < 0) break;
      const before = letterNorm.slice(Math.max(0, i - 6), i);
      const BREAKS = ['。', '！', '？', String.fromCharCode(10)];
      const sStart = Math.max(...BREAKS.map((c) => letterNorm.lastIndexOf(c, i))) + 1;
      const sEndCands = BREAKS.map((c) => letterNorm.indexOf(c, i)).filter((x) => x >= 0);
      const sentence = letterNorm.slice(sStart, sEndCands.length ? Math.min(...sEndCands) : undefined);
      if (!NEG_RE.test(before) && !HEDGE_RE.test(sentence)) { hits.push(kw); break; }
      from = i + k.length;
    }
    if (hits.length) break;
  }
  return hits;
}

export async function score({ finalText, artifacts, steps, truth }) {
  const notes = [];
  const misses = [];
  let text = String(finalText ?? '').trim();
  if (!text) { text = readArtifact(artifacts, 'report.md').trim(); if (text) notes.push('finalText 空，改讀 report.md'); }

  let letter = String(steps?.letter?.output ?? '').trim();
  let todo = String(steps?.todo?.output ?? '').trim();
  if (!letter) letter = extractSection(text, /給客戶的信|客戶信|正式信|確認信|信件/) ?? '';
  if (!todo) todo = extractSection(text, /待辦/) ?? '';
  if (!letter && !todo) {
    letter = text; todo = text;
    notes.push('切不出「信」與「待辦」兩段，整份當成品評（信字數與禁寫會失準）');
  } else if (!letter) { letter = text; notes.push('切不出「信」，禁寫與字數以整份評'); }
  else if (!todo) { todo = text; notes.push('切不出「待辦」，日期以整份評'); }

  const product = norm(letter + '\n' + todo);
  const letterN = norm(letter);

  // 8 要點
  const pointHits = [];
  for (const p of truth.points) {
    const ks = p.keywords.map(norm);
    const ok = p.mode === 'all' ? ks.every((k) => product.includes(k)) : ks.some((k) => product.includes(k));
    if (ok) pointHits.push(p.key); else misses.push(`漏要點：${p.name}`);
  }
  // 3 禁寫（只查信）
  const forbiddenFound = [];
  for (const fb of truth.forbidden) {
    const h = forbiddenHits(letterN, fb);
    if (h.length) { forbiddenFound.push(fb.key); misses.push(`信裡出現禁寫：${fb.name}（命中「${h[0]}」）`); }
  }
  // 信字數
  const letterChars = charCount(letter);
  const lenOk = letterChars >= truth.letter_chars.min && letterChars <= truth.letter_chars.max;
  if (!lenOk) misses.push(`信字數 ${letterChars}，不在 ${truth.letter_chars.min}～${truth.letter_chars.max}`);
  // 待辦日期
  const items = todoItems(todo);
  const dated = items.filter((it) => DATE_RE.test(norm(it).replace(/月/g, ' 月 ').replace(/日/g, ' 日')) || DATE_RE.test(it));
  const todoOk = items.length > 0 && dated.length === items.length;
  if (!items.length) misses.push('待辦清單抓不到任何條目');
  else if (dated.length < items.length) misses.push(`待辦 ${items.length} 條，只有 ${dated.length} 條有日期`);

  const errors = forbiddenFound.length + (truth.points.length - pointHits.length);
  const pass = pointHits.length === truth.points.length && forbiddenFound.length === 0 && lenOk && todoOk;
  return {
    pass,
    metrics: {
      primary: pointHits.length, primary_label: `要點命中（/${truth.points.length}）`,
      points_hit: pointHits.length,
      points_total: truth.points.length,
      forbidden_hit: forbiddenFound.length,
      letter_chars: letterChars,
      todo_items: items.length,
      todo_dated: dated.length,
      errors,
    },
    misses,
    notes,
  };
}
