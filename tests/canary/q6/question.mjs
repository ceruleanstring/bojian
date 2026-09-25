// q6 — 六步長流程（結構題，只跑剝繭）：算數字 → 分岔 → 兩條路（只走一條）→ 你來做（停下等人）→ 依人補的內容調整 → 寫報告（停點等核可）
// 驗的是剝繭獨有的機制：分岔自動選路、人做步驟會停、人補的內容往下傳、原始檔每步可見（ADR-009）、停點會停且能核可。
import fs from 'node:fs';
import path from 'node:path';

export const id = 'q6';
export const title = '六步長流程：分岔＋你來做＋停點';
export const kind = 'structural';
export const anomalies = ['官網佔比 55%→走官網深挖那條路', '主管口頭指示「預算上限 8 萬」要傳到第五步'];

// ---------- 資料：固定種子 60 筆訂單，官網佔比落在 50%～60%（答案確定：超過四成） ----------
const SEED = 20260924;
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CHANNELS = ['官網', '門市', '電商平台'];
const PRODUCTS = [['羊毛圍巾', 1280], ['帆布托特包', 890], ['真皮短夾', 1580], ['棉麻襯衫', 1690], ['陶瓷馬克杯', 420]];
export const CSV_NAME = 'orders.csv';
export const HUMAN_NUMBER = '8 萬';
export const HUMAN_CONTENT = [
  '一、下季行銷預算上限 8 萬，超過要先回報。',
  '二、優先顧好官網老客回購，不要再開新通路。',
  '三、下週一之前給我一頁版就好。',
].join('\n');

export function buildOrders() {
  const rnd = mulberry32(SEED);
  const rows = [];
  for (let i = 0; i < 60; i++) {
    // 通路配比：官網 55%、門市 27%、電商平台 18%（用亂數但固定種子，最後再驗佔比落在 50～60%）
    const r = rnd();
    const channel = r < 0.55 ? '官網' : r < 0.82 ? '門市' : '電商平台';
    const [product, price] = PRODUCTS[Math.floor(rnd() * PRODUCTS.length)];
    const qty = 1 + Math.floor(rnd() * 3);
    const day = 1 + Math.floor(rnd() * 28);
    rows.push({ no: `O-2026-08-${String(i + 1).padStart(3, '0')}`, date: `2026-08-${String(day).padStart(2, '0')}`, channel, product, qty, price, amount: qty * price });
  }
  return rows;
}

export function truthOf(rows) {
  const byChannel = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
  for (const r of rows) byChannel[r.channel] += r.amount;
  const total = Object.values(byChannel).reduce((a, b) => a + b, 0);
  const share = byChannel['官網'] / total;
  return {
    revenue_by_channel: byChannel,
    total,
    official_share: Math.round(share * 1000) / 10, // 百分比，一位小數
    branch_expected: 'web_deep',
    branch_wrong: 'store_deep',
    human_number: HUMAN_NUMBER,
    human_content: HUMAN_CONTENT,
    csv: CSV_NAME,
  };
}

export async function generate(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const rows = buildOrders();
  const truth = truthOf(rows);
  if (truth.official_share < 50 || truth.official_share > 60) {
    throw new Error(`q6 資料設計失敗：官網佔比 ${truth.official_share}% 不在 50～60%（換種子）`);
  }
  const csv = ['訂單編號,日期,通路,商品,數量,單價,金額', ...rows.map((r) => [r.no, r.date, r.channel, r.product, r.qty, r.price, r.amount].join(','))].join('\n') + '\n';
  const p = path.join(dataDir, CSV_NAME);
  fs.writeFileSync(p, csv, 'utf8');
  fs.writeFileSync(path.join(dataDir, 'truth.json'), JSON.stringify(truth, null, 2), 'utf8');
  return { files: [{ name: CSV_NAME, path: p }], truth };
}

// ---------- 流程定義 ----------
const ai = (nid, ttl, instruction, next, extra = {}) => ({
  id: nid, title: ttl, kind: 'task', executor: 'ai', stop_point: 'never', model_tier: 'balanced', instruction, next, ...extra,
});

export function flowDef({ files } = {}) {
  const csv = files?.[0]?.name ?? CSV_NAME;
  return {
    format: 1,
    name: '金絲雀 q6：八月通路營收六步流程',
    params: [],
    permissions: { files: true, connectors: false },
    check: { enabled: false },
    supervisor: { enabled: false }, // 分岔的判路不受這個開關影響（判路永遠跑）
    nodes: [
      ai('calc', '算各通路營收',
        `附件 ${csv} 是八月的訂單明細（每列一筆，金額欄已是數量×單價）。請算出三個通路（官網、門市、電商平台）各自的營收合計、總營收，以及每個通路的佔比（百分比、一位小數）。第一行明確寫「官網佔比：xx.x%」。`,
        ['gate'], { attachments: [csv] }),
      {
        id: 'gate', title: '官網佔比是否超過四成', kind: 'branch', next: [],
        instruction: '看上一步算出的「官網佔比」：超過 40% 走第一條路，不到（含剛好 40%）走第二條路。',
        branches: [
          { label: '官網佔比超過四成', next: 'web_deep' },
          { label: '官網佔比不到四成（含剛好四成）', next: 'store_deep' },
        ],
      },
      ai('web_deep', '寫官網深挖分析',
        '官網是最大的通路。請根據上一步的數字，寫一段 150～250 字的官網深挖分析：官網賣得最好的商品是哪一個、平均每單金額、下個月可以怎麼把官網做得更好（兩點建議）。',
        ['human_note']),
      ai('store_deep', '寫門市分析',
        '官網佔比不到四成，門市仍是重心。請根據上一步的數字，寫一段 150～250 字的門市分析：門市賣得最好的商品、平均每單金額、下個月門市可以怎麼做（兩點建議）。',
        ['human_note']),
      {
        id: 'human_note', title: '補上主管的口頭指示', kind: 'task', executor: 'human', stop_point: 'always',
        instruction: '主管剛在會議上講了三句話，還沒寫進任何文件。請把那三句口頭指示原文補進來，交給下一步。',
        handoff: '補上主管的三句口頭指示',
        next: ['adjust'],
      },
      ai('adjust', '依主管指示調整建議',
        `上一步「補上主管的口頭指示」交出的是主管的三句話。請把前面分析裡的建議照這三句話調整：每一條建議都要說明它符合哪一句指示；主管提到的數字（例如金額上限）要原文照抄寫進去，不准改寫成別的寫法。需要核對數字時回附件 ${csv} 查。`,
        ['report'], { attachments: [csv] }),
      ai('report', '寫成報告',
        '把前面的數字、分析與調整後的建議整理成一頁報告給主管：標題、三個通路營收與佔比（一張小表）、分析重點三條、建議三條（含主管指示的數字）。不要提到「上一步」「流程」這類字眼。',
        [], { stop_point: 'always' }),
    ],
  };
}

// 預設駕駛會用它：人做步驟的 content
export function humanContent() { return HUMAN_CONTENT; }

// ---------- 自訂駕駛：輪詢 GET /runs/:rid，人做→human-done（固定三句）、停點→approve、其餘照預設 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const driveRecords = []; // score 拿不到 drive 的回傳，先在同一個行程裡記著（FIFO，跟 run.mjs 的順序一致時剛好對上）

export async function drive({ api, base, rid, poll, log } = {}) {
  const say = (m) => (typeof log === 'function' ? log(m) : console.log(`[q6] ${m}`));
  const interventions = [];
  const seen = new Set(); // 看到過的狀態（節點:狀態）
  const t0 = Date.now();
  let r = null;
  for (;;) {
    await sleep(typeof poll === 'number' && poll > 0 ? poll : 3000);
    r = await api('GET', `${base}/${rid}`);
    for (const [nid, s] of Object.entries(r.steps ?? {})) seen.add(`${nid}:${s.status}`);
    if (r.status === 'done') break;
    if (Date.now() - t0 > 40 * 60e3) { interventions.push({ kind: 'timeout' }); break; }
    let gaveUp = false;
    for (const [nid, s] of Object.entries(r.steps ?? {})) {
      let act = null;
      let body = { node: nid };
      if (s.status === 'waiting_human') { act = 'human-done'; body = { node: nid, content: HUMAN_CONTENT }; }
      else if (s.status === 'waiting_review') act = 'approve';
      else if (s.status === 'waiting_check') act = 'check-accept';
      else if (s.status === 'waiting_data') act = 'data-accept';
      else if (s.status === 'waiting_branch') { act = 'choose-branch'; body = { node: nid, target: 'store_deep' }; } // 判不出路才會走到這裡：故意選錯的那條，讓 score 抓到
      else if (s.status === 'failed') act = 'retry';
      if (!act) continue;
      const retries = interventions.filter((x) => x.node === nid && x.act === 'retry').length;
      if (act === 'retry' && retries >= 2) { interventions.push({ node: nid, act: 'give-up', error: s.error ?? null }); gaveUp = true; break; }
      interventions.push({ node: nid, act, status: s.status, at: new Date().toISOString(), ...(s.error ? { error: s.error } : {}) });
      say(`${nid} ${s.status} → ${act}`);
      await api('POST', `${base}/${rid}/${act}`, body);
    }
    if (gaveUp) break;
  }
  const rec = {
    rid, run_status: r?.status ?? null, ms: Date.now() - t0, interventions, seen: [...seen],
    choice: r?.steps?.gate?.choice ?? null, choice_by: r?.steps?.gate?.choice_by ?? null,
  };
  driveRecords.push(rec);
  return { interventions, q6: rec };
}

// ---------- 評分：六項全真才 pass ----------
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const NUMBER_RE = /8\s*萬|80,?000|八萬/;

export async function score({ finalText = '', steps = {}, prompts = [], truth = {}, drive = null } = {}) {
  const rec = drive?.q6 ?? driveRecords.shift() ?? null; // 跑手有傳 drive 回傳就用它（契約 2026-09-24 補）；沒有就退回同行程 FIFO，再沒有只靠 steps 推
  const misses = [];
  const notes = [];
  const st = (nid) => steps[nid]?.status ?? null;
  const out = (nid) => String(steps[nid]?.output ?? '');
  const nodes = ['calc', 'gate', 'web_deep', 'store_deep', 'human_note', 'adjust', 'report'];

  // ① 流程最終 done：drive 有記 run.status 就看它；沒有就看每步都 done／skipped 且 report done
  const allSettled = nodes.every((n) => ['done', 'skipped'].includes(st(n)));
  const flowDone = rec ? rec.run_status === 'done' : (allSettled && st('report') === 'done');
  if (!flowDone) misses.push(`流程沒有跑完（run.status=${rec?.run_status ?? '未知'}；各步：${nodes.map((n) => `${n}=${st(n)}`).join(' ')}）`);

  // ② 分岔走了官網那條：web_deep 有產出且 done、store_deep 被跳過
  const expected = truth.branch_expected ?? 'web_deep';
  const wrong = truth.branch_wrong ?? 'store_deep';
  const branchRight = st(expected) === 'done' && out(expected).trim().length > 0 && st(wrong) === 'skipped';
  if (!branchRight) misses.push(`分岔沒走「官網」那條（${expected}=${st(expected)}、${wrong}=${st(wrong)}${rec?.choice ? `、選路=${rec.choice}/${rec.choice_by}` : ''}）`);
  if (rec?.choice_by && rec.choice_by !== 'ai') notes.push(`選路不是 AI 自己判的（choice_by=${rec.choice_by}）`);

  // ③ 人做步驟真的停過：drive 紀錄裡看到 waiting_human；沒紀錄就看 human_note 的產出＝我們補的三句（只有從 waiting_human 走 human-done 才會有）
  const humanStopped = rec
    ? rec.seen.includes('human_note:waiting_human') && rec.interventions.some((x) => x.node === 'human_note' && x.act === 'human-done')
    : out('human_note').includes('預算上限');
  if (!humanStopped) misses.push('人做步驟沒有停下等人（drive 沒看到 waiting_human）');
  if (!rec) notes.push('score 拿不到 drive 紀錄（不同行程），③⑥ 改用步驟狀態推斷');

  // ④ 第⑤步產出含人補的那個數字
  const numberCarried = NUMBER_RE.test(out('adjust'));
  if (!numberCarried) misses.push(`第五步產出沒有主管講的數字「${truth.human_number ?? HUMAN_NUMBER}」`);

  // ⑤ 第⑤⑥步卷宗的參考檔清單含原始 CSV
  const csv = truth.csv ?? CSV_NAME;
  const promptOf = (nid) => prompts.find((p) => p.name === `${nid}.txt`);
  const hasCsv = (nid) => { const p = promptOf(nid); return !!p && readText(p.path).includes(csv); };
  const csvVisible = hasCsv('adjust') && hasCsv('report');
  if (!csvVisible) misses.push(`卷宗參考檔清單缺原始 CSV（adjust=${hasCsv('adjust')}、report=${hasCsv('report')}；卷宗清單：${prompts.map((p) => p.name).join(',') || '空'}）`);

  // ⑥ 停點真的停過並被 approve：drive 紀錄有 report:waiting_review＋approve；沒紀錄就看 report done（stop_point always 只有 approve／edit 才會 done）
  const stopApproved = rec
    ? rec.seen.includes('report:waiting_review') && rec.interventions.some((x) => x.node === 'report' && x.act === 'approve')
    : st('report') === 'done';
  if (!stopApproved) misses.push('停點沒有停下等核可（drive 沒看到 report:waiting_review／approve）');

  const metrics = {
    flow_done: flowDone,
    branch_web_deep: branchRight,
    human_stopped: humanStopped,
    number_carried: numberCarried,
    csv_visible_step5_6: csvVisible,
    stop_point_approved: stopApproved,
    interventions: rec?.interventions?.length ?? null,
    final_text_chars: String(finalText ?? '').length,
  };
  // 契約 metrics.primary／errors：六項全真＝6；錯誤數＝沒成立的項數
  const checks6 = [flowDone, branchRight, humanStopped, numberCarried, csvVisible, stopApproved];
  metrics.primary = checks6.filter(Boolean).length; metrics.primary_label = '六項成立（/6）'; metrics.errors = checks6.length - metrics.primary;
  const pass = flowDone && branchRight && humanStopped && numberCarried && csvVisible && stopApproved;
  if (rec) notes.push(`drive 介入：${rec.interventions.map((x) => `${x.node}:${x.act}`).join(' ') || '無'}；用時 ${Math.round(rec.ms / 1000)} 秒`);
  return { pass, metrics, misses, notes };
}
