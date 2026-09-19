// canvas v6 — （畫布款 A）：由上往下大卡、上緣入口／下緣出口接點、出口膠囊「同時做／擇一」、入口膠囊「等全部／任一條到」、
// 擇一虛線＋線中條件格（空＝琥珀「點此寫條件」，點了原地改）；整張自由拖拉、放開不吸附不跳位；雙擊空白加步驟、拉到空白長出下一步。
// 效能：拖卡／拉線／平移以 requestAnimationFrame 合批（一幀最多處理一次）、拖卡用 transform、放開才寫 left/top；
// 卡片 id → 相連線索引，拖曳只改相關的線；結構改動走 update() 逐項比對、只換有變的元素（不整頁重繪）。
// 資料改動一律回呼 app.js 的 handlers（onMove/onSelect/onConnect/onNewFrom/onCut/onInsert/onPill/onCond/onEdgeSel）——本檔只管畫與互動。
/* global window, document, requestAnimationFrame, cancelAnimationFrame */
(function () {
  const kindOf = (n) => n.kind ?? 'task';

  // 沒拿到 app.js 的 cvModel 時的退路：每個節點一張卡、原樣的線（分岔的路畫虛線帶條件）
  function plainModel(def) {
    const edges = [];
    for (const n of def.nodes) {
      if (kindOf(n) === 'branch') (n.branches ?? []).forEach((b, i) => edges.push({ from: n.id, to: b.next, dashed: true, cond: b.label ?? '', arm: i }));
      else for (const t of n.next ?? []) edges.push({ from: n.id, to: t });
    }
    return { cards: def.nodes, edges, exits: {}, entries: {}, legacy: def.nodes.filter((n) => kindOf(n) !== 'task').map((n) => n.id) };
  }

  // 卡 210×105、舊寫法小圓點 34；由上往下——層＝列（最長路徑）、列距 155、同列水平置中、欄距 250
  const NW = 210; const NH = 105; const JS = 34; const ROW = 155; const COL = 250; const PAD = 40;
  const PILL_OUT = 27; const PILL_IN = 28; // 有出口／入口膠囊時線從膠囊外緣出入（款 A）
  // 拖曳中的東西（相連的線、幽靈線、拖著的卡的替身）都畫在上層小 SVG，SVG 裡常駐一塊固定大小、幾乎透明的底：
  // 每幀只有 SVG 內容在變、繪製區塊範圍不變，瀏覽器不必每幀重新分層（L14 實測：HTML 卡用 transform／left／邊距移動，每幀都要重新分層，縮到 25％ 時最貴）。
  // 底常駐不切換：切換一次＝整個看得到的畫布重畫一遍（25％ 時 x1 也要 30ms 以上）
  const DRAGB = 6000;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sizeOf = (n) => (kindOf(n) === 'task' ? { w: NW, h: NH } : { w: JS, h: JS });

  // 自動排版打底（依 cvModel 的卡與線），canvas.layout==='tb' 時存的座標蓋過去（新卡沒座標也有地方站）；
  // 舊流程（沒有 tb 記號）的由左往右座標不沿用。
  // ①跨好幾列的線在中間每列佔一個空格（替它讓出通道）；②同層順序照上下層位置來回做重心排序、留交叉最少的那次；
  // ③列距依這兩列之間有沒有出口膠囊（＋27）、入口膠囊（＋28）、擇一條件格（＋60）加大，都沒有維持 155
  const COND_ROOM = 60;
  function layout(model, canvas) {
    const cards = model.cards;
    const ids = new Set(cards.map((n) => n.id));
    const edges = model.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const preds = new Map(cards.map((n) => [n.id, []]));
    const outN = new Map();
    for (const e of edges) { preds.get(e.to).push(e.from); outN.set(e.from, (outN.get(e.from) ?? 0) + 1); }
    const exits = model.exits ?? {};
    const entries = model.entries ?? {};
    const pillOut = new Set(cards.filter((n) => kindOf(n) === 'task' && exits[n.id] && (outN.get(n.id) ?? 0) >= 2).map((n) => n.id));
    const pillIn = new Set(cards.filter((n) => kindOf(n) === 'task' && entries[n.id]).map((n) => n.id));
    const depth = new Map();
    const visit = (id) => {
      if (depth.has(id)) return depth.get(id);
      depth.set(id, 0); // 佔位防繞圈
      const ps = preds.get(id);
      const d = ps.length ? Math.max(...ps.map(visit)) + 1 : 0;
      depth.set(id, d);
      return d;
    };
    for (const n of cards) visit(n.id);
    const rows = [];
    cards.forEach((n) => (rows[depth.get(n.id)] ??= []).push(n.id));
    for (let d = 0; d < rows.length; d++) rows[d] ??= [];
    // 上下相鄰的連接（跨列的線拆成經過空格的幾段）；空格 key 以 \u0002 開頭
    const up = new Map(); const down = new Map();
    const link = (a, b) => { (down.get(a) ?? down.set(a, []).get(a)).push(b); (up.get(b) ?? up.set(b, []).get(b)).push(a); };
    const condRow = new Set(); // 這一列往下一列有擇一條件格
    edges.forEach((e, i) => {
      const da = depth.get(e.from); const db = depth.get(e.to);
      if (db === da + 1 && e.dashed) condRow.add(da);
      let prev = e.from;
      for (let d = da + 1; d < db; d++) { const k = `\u0002${i}:${d}`; rows[d].push(k); link(prev, k); prev = k; }
      link(prev, e.to);
    });
    const idx = new Map();
    const setIdx = (row) => row.forEach((k, i) => idx.set(k, i));
    rows.forEach(setIdx);
    const bary = (row, nb) => {
      const keyed = row.map((k, i) => { const ns = nb.get(k) ?? []; return { k, i, v: ns.length ? ns.reduce((s, x) => s + idx.get(x), 0) / ns.length : i }; });
      keyed.sort((a, b) => a.v - b.v || a.i - b.i);
      keyed.forEach((o, i) => { row[i] = o.k; });
      setIdx(row);
    };
    const crossings = () => {
      let c = 0;
      for (let d = 0; d + 1 < rows.length; d++) {
        const es = [];
        for (const k of rows[d]) for (const t of down.get(k) ?? []) es.push([idx.get(k), idx.get(t)]);
        for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) if ((es[i][0] - es[j][0]) * (es[i][1] - es[j][1]) < 0) c++;
      }
      return c;
    };
    for (let d = 1; d < rows.length; d++) bary(rows[d], up);
    let best = crossings();
    let bestRows = rows.map((r) => [...r]);
    for (let it = 0; it < 4 && best > 0; it++) {
      for (let d = rows.length - 2; d >= 0; d--) bary(rows[d], down);
      for (let d = 1; d < rows.length; d++) bary(rows[d], up);
      const c = crossings();
      if (c < best) { best = c; bestRows = rows.map((r) => [...r]); }
    }
    const widest = Math.max(1, ...bestRows.map((r) => r.length));
    const span = (k) => (k - 1) * COL + NW;
    const pos = new Map();
    const sz = new Map(cards.map((n) => [n.id, sizeOf(n)]));
    let y = PAD;
    bestRows.forEach((row, d) => {
      const x0 = PAD + (span(widest) - span(row.length)) / 2;
      row.forEach((k, i) => {
        if (!sz.has(k)) return; // 空格
        const s = sz.get(k);
        pos.set(k, { x: x0 + i * COL + (NW - s.w) / 2, y: y + (NH - s.h) / 2 });
      });
      const next = bestRows[d + 1] ?? [];
      y += ROW + (row.some((k) => pillOut.has(k)) ? PILL_OUT : 0) + (next.some((k) => pillIn.has(k)) ? PILL_IN : 0) + (condRow.has(d) ? COND_ROOM : 0);
    });
    if (canvas?.layout === 'tb') {
      for (const [id, p] of Object.entries(canvas.positions ?? {})) {
        if (pos.has(id) && p && Number.isFinite(p.x) && Number.isFinite(p.y)) pos.set(id, { x: p.x, y: p.y });
      }
    }
    let maxX = 0; let maxY = 0;
    for (const [id, p] of pos) { const s = sz.get(id); maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h); }
    return { pos, sz, width: Math.max(maxX + PAD, 400), height: Math.max(maxY + PAD, 260), edges, pillOut, pillIn };
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ekey = (e) => `${e.from}>${e.to}>${e.arm ?? ''}`;
  const YOU = '<i class="ph ph-user"></i>你來';
  const SEQ = '\u0001'; // 卡片 HTML 裡序號的佔位：序號另外比對、只改那幾個字（加一張卡後面幾十張的序號都會變，不必整張換）

  // 一條線的幾何（由上往下）：出口（下緣中點；有出口膠囊從膠囊下緣）→ 入口（上緣中點；有入口膠囊到膠囊上緣），直向三次貝茲
  function geo(L, e) {
    const a = L.pos.get(e.from); const b = L.pos.get(e.to);
    if (!a || !b) return null;
    const sa = L.sz.get(e.from); const sb = L.sz.get(e.to);
    const x1 = a.x + sa.w / 2; const y1 = a.y + sa.h + (L.pillOut.has(e.from) ? PILL_OUT : 0);
    const x2 = b.x + sb.w / 2; const y2 = b.y - (L.pillIn.has(e.to) ? PILL_IN : 0);
    const dy = Math.max(40, (y2 - y1) / 2);
    const g = { x1, y1, x2, y2, dy };
    const lane = laneOf(L, e, g);
    return lane ? Object.assign(g, lane) : g;
  }
  const bezAt = (g, t) => { const m = 1 - t; return { x: m * m * m * g.x1 + 3 * m * m * t * g.x1 + 3 * m * t * t * g.x2 + t * t * t * g.x2, y: m * m * m * g.y1 + 3 * m * m * t * (g.y1 + g.dy) + 3 * m * t * t * (g.y2 - g.dy) + t * t * t * g.y2 }; };
  // 條件格的位置——兩列之間夠高（≥90，自動排版有條件格時列距加大）釘在線的七成處（幾條擇一線在這裡分得比中點開，格子可到 180 寬、又不碰下一張卡）；不夠高照舊釘中點、最寬 116
  const roomy = (g) => g.lx !== undefined || g.y2 - g.y1 >= 90;
  const geoCond = (g) => (g.lx !== undefined ? { x: g.lx, y: (g.ya + g.yb) / 2 } : bezAt(g, roomy(g) ? 0.7 : 0.5));
  // 條件格寬度照字數估（中文 12px、其他 7px，左右留白 20），64〜116（夠高時 180）：用 left/top 置中，不掛 transform（每格掛 transform 會變成獨立繪製層，拖卡時整頁要重新分層）
  const condWidth = (t, max = 116) => { let px = 20; for (const ch of t) px += ch.charCodeAt(0) > 255 ? 12 : 7; return Math.max(64, Math.min(max, Math.ceil(px))); };
  const condW = (g, e) => condWidth(String(e.cond ?? '').trim() || '點此寫條件', roomy(g) ? 180 : 116);
  // 線會從別張卡下面穿過（或條件格壓到卡）時改走通道——找一條上下都沒有卡的直線（擇一線要容得下條件格），
  // 出口→通道上端、直下、通道下端→入口。只看跟這條線上下範圍重疊的卡；沒擋到就照原本一條貝茲
  function laneOf(L, e, g) {
    if (g.y2 - g.y1 < 60) return null;
    const near = [];
    for (const [id, p] of L.pos) {
      if (id === e.from || id === e.to) continue;
      const s = L.sz.get(id);
      if (p.y + s.h > g.y1 + 4 && p.y < g.y2 - 4) near.push({ x: p.x, y: p.y, w: s.w, h: s.h });
    }
    if (!near.length) return null;
    const over = (x, y, w, h) => near.some((r) => r.x < x + w && x < r.x + r.w && r.y < y + h && y < r.y + r.h);
    let blocked = false;
    for (let t = 0.1; t < 0.95 && !blocked; t += 0.1) { const q = bezAt(g, t); blocked = over(q.x - 6, q.y - 6, 12, 12); }
    if (!blocked && e.dashed) { const c = geoCond(g); const w = condW(g, e); blocked = over(c.x - w / 2 - 4, c.y - 16, w + 8, 32); }
    if (!blocked) return null;
    const hw = e.dashed ? 92 : 14;
    let top = Infinity; let bot = -Infinity;
    for (const r of near) { top = Math.min(top, r.y); bot = Math.max(bot, r.y + r.h); }
    const ya = Math.max(g.y1 + 24, top - 20); const yb = Math.min(g.y2 - 24, bot + 20);
    if (yb <= ya) return null;
    const mid = (g.x1 + g.x2) / 2;
    const cands = [mid, g.x1, g.x2];
    for (const r of near) cands.push(r.x - 16 - hw, r.x + r.w + 16 + hw);
    cands.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    for (const x of cands) if (!over(x - hw, ya, hw * 2, yb - ya)) return { lx: x, ya, yb };
    return null;
  }
  const geoPath = (g) => (g.lx === undefined
    ? `M${g.x1},${g.y1} C${g.x1},${g.y1 + g.dy} ${g.x2},${g.y2 - g.dy} ${g.x2},${g.y2}`
    : `M${g.x1},${g.y1} C${g.x1},${(g.y1 + g.ya) / 2} ${g.lx},${(g.y1 + g.ya) / 2} ${g.lx},${g.ya} L${g.lx},${g.yb} C${g.lx},${(g.yb + g.y2) / 2} ${g.x2},${(g.yb + g.y2) / 2} ${g.x2},${g.y2}`);
  // 對稱控制點的貝茲 t=0.5 恰為兩端中點——線上小工具釘在這，貼著線（走通道的線釘在通道中間）
  const geoMid = (g) => (g.lx !== undefined ? { x: g.lx, y: (g.ya + g.yb) / 2 } : { x: (g.x1 + g.x2) / 2, y: (g.y1 + g.y2) / 2 });
  const outText = (n) => (n.executor === 'human' ? (n.handoff || '你交出的內容') : ([n.output_type, n.output_file && `.${n.output_file} 檔`].filter(Boolean).join('・') || '文字產出'));

  function nodeHtml(L, n, o) {
    const p = L.pos.get(n.id);
    const kind = kindOf(n);
    const sel = (o.sel === n.id ? ' sel' : '') + (o.issues?.has(n.id) ? ' issue' : '');
    const at = `style="left:${p.x}px;top:${p.y}px"`;
    // 畫面上還看得到的分岔／並行點／會合點＝新畫法表達不了的舊寫法，照樣能跑能改
    const old = '<span class="legacytag">舊寫法</span>';
    const pin = '<span class="port in"></span>';
    const pout = `<span class="port out" data-out="${esc(n.id)}" title="從這裡拉線接下一步"></span>`;
    if (kind === 'branch') {
      return `<div class="junction branch${sel}" data-node="${esc(n.id)}" ${at} title="分岔：${esc(n.title)}——${esc(n.instruction ?? '')}（舊寫法：雙擊改判斷依據；拉出埠＝多一條路）">${pin}${pout}<i class="ph ph-arrows-split"></i>${old}</div>`;
    }
    if (kind === 'fork') {
      return `<div class="junction fork${sel}" data-node="${esc(n.id)}" ${at} title="並行點：${esc(n.title)}（舊寫法）——從下緣圓點拉幾條線＝同時做幾件事">${pin}${pout}<i class="ph ph-git-branch"></i>${old}</div>`;
    }
    if (kind === 'join') {
      return `<div class="junction${sel}" data-node="${esc(n.id)}" ${at} title="${esc(n.title)}（舊式會合點，設了任一條到——照樣能跑）">${pin}${pout}<i class="ph ph-git-merge"></i>${old}</div>`;
    }
    const human = n.executor === 'human';
    const hold = n.stop_point === 'always';
    const cls = (human ? ' human' : '') + (hold ? ' hold' : '');
    const exit = L.pillOut.has(n.id) ? `<span class="pill pout" data-pill="exit" data-id="${esc(n.id)}" data-mode="${L.exits[n.id]}" title="點一下切換：同時做／擇一">${L.exits[n.id] === 'one' ? '擇一' : '同時做'}<i class="ph ph-caret-down"></i></span>` : '';
    const entry = L.pillIn.has(n.id) ? `<span class="pill pin" data-pill="entry" data-id="${esc(n.id)}" data-mode="${L.entries[n.id]}" title="點一下切換：等全部／任一條到">${L.entries[n.id] === 'any' ? '任一條到' : '等全部'}<i class="ph ph-caret-down"></i></span>` : '';
    return `<div class="node${cls}${sel}" data-node="${esc(n.id)}" ${at}>${entry}${pin}${human ? `<span class="chip you">${YOU}</span>` : ''}<div class="nstep">STEP <span class="sq">${SEQ}</span>${hold ? '<i class="ph-fill ph-hand-palm" title="停點：做完停下來等你看"></i>' : ''}</div><b class="nname" title="${esc(n.title)}">${esc(n.title)}</b><div class="nout">產出：${esc(outText(n))}</div>${pout}${exit}</div>`;
  }

  function edgeHtml(L, e, k, o) {
    const g = geo(L, e);
    if (!g) return '';
    const d = geoPath(g);
    const on = o.edgeSel === k;
    return `<g data-k="${esc(k)}"${on ? ' class="esel"' : ''}><path class="ln" d="${d}"${e.dashed ? ' stroke-dasharray="6 5"' : ''} marker-end="url(#${on ? 'bj-arB' : 'bj-ar'})"/><path class="hit" data-hit="${esc(k)}" d="${d}"/></g>`;
  }

  function condHtml(L, e, k, o) {
    const g = geo(L, e);
    if (!g) return '';
    const m = geoCond(g);
    const ce = o.condEdit;
    if (ce && ce.from === e.from && ce.to === e.to && (ce.arm ?? null) === (e.arm ?? null)) {
      return `<input id="cvcond-edit" class="cond editing" data-cond="${esc(k)}" data-w="180" data-keep style="left:${m.x - 90}px;top:${m.y - 12}px" value="${esc(ce.text ?? e.cond ?? '')}" placeholder="寫條件，Enter 存、Esc 放棄" autocomplete="off">`;
    }
    const text = String(e.cond ?? '').trim();
    const w = condW(g, e);
    const at = `data-w="${w}" style="left:${m.x - w / 2}px;top:${m.y - 12}px;width:${w}px"`;
    const issue = (o.condIssues ?? []).some((x) => x.from === e.from && x.to === e.to && (x.arm == null || e.arm == null || x.arm === e.arm));
    return `<span class="cond${text ? '' : ' empty'}${issue ? ' issue' : ''}" data-cond="${esc(k)}" ${at} title="點一下改條件">${text ? esc(text) : '點此寫條件'}</span>`;
  }

  // 一次排版快照：位置、線、膠囊、每個元素的 HTML（key → 字串，update() 拿來逐項比對）
  function build(def, sel, issues, model, o) {
    const L = layout(model, def.canvas);
    L.model = model;
    L.def = def;
    L.exits = model.exits ?? {};
    L.entries = model.entries ?? {};
    L.order = new Map(model.cards.filter((n) => kindOf(n) === 'task').map((n, i) => [n.id, i + 1]));
    L.byNode = new Map(model.cards.map((n) => [n.id, []]));
    L.edgeByKey = new Map();
    for (const e of L.edges) {
      const k = ekey(e);
      L.edgeByKey.set(k, e);
      L.byNode.get(e.from).push(k);
      if (e.to !== e.from) L.byNode.get(e.to).push(k);
    }
    // 出口／入口膠囊（L.pillOut／L.pillIn）由 layout 算好（列距要用）
    const oo = { ...o, sel, issues };
    L.sel = sel;
    L.edgeSel = o.edgeSel ?? null;
    L.nodeHtml = new Map(model.cards.map((n) => [n.id, nodeHtml(L, n, oo)]));
    L.seq = new Map(model.cards.map((n) => [n.id, String(o.seq?.get(n.id) ?? L.order.get(n.id) ?? 0).padStart(2, '0')]));
    L.edgeHtml = new Map();
    L.condHtml = new Map();
    for (const [k, e] of L.edgeByKey) {
      L.edgeHtml.set(k, edgeHtml(L, e, k, oo));
      if (e.dashed) L.condHtml.set(k, condHtml(L, e, k, oo));
    }
    return L;
  }

  // 視圖狀態跨 render 保留（切 Workflow 時 resetView）；last＝目前畫面的排版快照（拖曳時即時改），dom＝元素索引
  const view = { z: 1, px: 0, py: 0, home: true };
  let last = null;
  let dom = null;
  const bindState = { lastTap: null }; // 雙擊偵測要跨 render 存活，放模組層

  const joinVals = (m) => { let s = ''; for (const v of m.values()) s += v; return s; };
  const pendingSeq = new Map(); // 卡片 id → 還沒寫上畫面的序號（卡在畫面外）
  // 畫面上（含外擴一圈）看得到的卡，把欠著的序號寫上去；平移、縮放、結構改動後都叫
  function flushSeq() {
    if (!pendingSeq.size || !dom || !last) return;
    const pad = 300;
    const x0 = (-view.px - pad) / view.z; const x1 = (dom.bw - view.px + pad) / view.z;
    const y0 = (-view.py - pad) / view.z; const y1 = (dom.bh - view.py + pad) / view.z;
    for (const [id, s] of pendingSeq) {
      const p = last.pos.get(id);
      if (p && (p.x + NW < x0 || p.x > x1 || p.y + NH < y0 || p.y > y1)) continue;
      const sq = dom.nodes.get(id)?.querySelector('.sq');
      if (sq) sq.textContent = s;
      pendingSeq.delete(id);
    }
  }
  const joinNodes = (L) => { let s = ''; for (const [id, v] of L.nodeHtml) s += v.replace(SEQ, L.seq.get(id)); return s; };

  // model＝app.js 的 cvModel(def)；opts＝{ seq, condEdit, condIssues, edgeSel, chrome（右上工具列、左下提示、「？」浮層） }
  function html(def, selected, issues, model = plainModel(def), opts = {}) {
    last = build(def, selected, issues, model, opts);
    pendingSeq.clear();
    dom = null;
    const { width, height } = last;
    return `<div class="cvwrap" data-cvw="${width}" data-cvh="${height}">
      <div class="cvscroll"><div class="cvspace"><div class="cv-inner" style="transform:scale(${view.z})">
        <svg class="wire" width="${width}" height="${height}">
          <defs><marker id="bj-ar" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#8e9ab3"/></marker><marker id="bj-arB" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#445bc4"/></marker></defs>
          <g class="edges">${joinVals(last.edgeHtml)}</g>
        </svg>
        <div class="cvnodes">${joinNodes(last)}</div>
        <div class="cvconds">${joinVals(last.condHtml)}</div>
        <svg class="wire live" width="${width}" height="${height}"><rect class="lvb" x="${-DRAGB}" y="${-DRAGB}" width="${DRAGB * 10}" height="${DRAGB * 20}"/><g class="liveedges"></g><path class="ghost" d="" style="display:none"/></svg>
        <div class="edgetools" hidden>
          <span class="etbtn" data-et="insert" title="在這條線中間插一步"><i class="ph ph-plus"></i></span>
          <span class="etbtn danger" data-et="cut" title="剪掉這條線"><i class="ph ph-x"></i></span>
        </div>
      </div></div></div>${opts.chrome ?? ''}
    </div>`;
  }

  // 元素索引（bind 時建一次、update 時跟著增刪）：拖曳與重畫線只查表，不 querySelector
  function index(wrap) {
    const inner = wrap.querySelector('.cv-inner');
    const d = { wrap, inner, tools: wrap.querySelector('.edgetools'), scroll: wrap.querySelector('.cvscroll'), space: wrap.querySelector('.cvspace'), edgesBox: inner.querySelector('g.edges'), live: inner.querySelector('g.liveedges'), nodesBox: inner.querySelector('.cvnodes'), condsBox: inner.querySelector('.cvconds'), ghost: inner.querySelector('.ghost'), svg: inner.querySelector('svg.wire'), nodes: new Map(), edges: new Map(), conds: new Map() };
    for (const el of d.nodesBox?.children ?? []) d.nodes.set(el.dataset.node, el);
    for (const el of d.edgesBox?.children ?? []) d.edges.set(el.dataset.k, el);
    for (const el of d.condsBox?.children ?? []) d.conds.set(el.dataset.cond, el);
    return d;
  }

  // 平移＝原生捲動（合成器直接搬畫面，不重繪、不重排）：畫布四周各留 MARGIN 的空地讓人往外拖；view.px／py＝畫布原點在框內的位置
  const MARGIN = 3000;
  function scrollTo(d) {
    const bw = d.bw; const bh = d.bh;
    view.px = Math.min(MARGIN, Math.max(bw - d.sw + MARGIN, view.px));
    view.py = Math.min(MARGIN, Math.max(bh - d.sh + MARGIN, view.py));
    d.scroll.scrollLeft = MARGIN - view.px;
    d.scroll.scrollTop = MARGIN - view.py;
    d.sx = MARGIN - view.px; d.sy = MARGIN - view.py;
  }
  // 捲動空間大小（取整到 800px：加一張卡通常不用改大小，改了才會逼瀏覽器當場重排）；回傳有沒有變小
  function size(d) {
    const sw = Math.ceil((Number(d.wrap.dataset.cvw) * view.z + MARGIN * 2) / 800) * 800;
    const sh = Math.ceil((Number(d.wrap.dataset.cvh) * view.z + MARGIN * 2) / 800) * 800;
    const shrink = sw < d.sw || sh < d.sh;
    if (sw !== d.sw) { d.sw = sw; d.space.style.width = `${sw}px`; }
    if (sh !== d.sh) { d.sh = sh; d.space.style.height = `${sh}px`; }
    return shrink;
  }
  function apply(wrap) {
    const d = dom?.wrap === wrap ? dom : index(wrap);
    d.bw = wrap.clientWidth; d.bh = wrap.clientHeight;
    size(d);
    d.inner.style.transform = `scale(${view.z})`;
    scrollTo(d);
    if (d === dom) flushSeq();
    const pct = wrap.querySelector('.pct');
    if (pct) pct.textContent = `${Math.round(view.z * 100)}%`;
  }

  function fit(wrap) {
    const w = Number(wrap.dataset.cvw); const h = Number(wrap.dataset.cvh);
    const bw = wrap.clientWidth; const bh = wrap.clientHeight;
    if (!bw || !bh) return;
    view.z = Math.min(1.4, Math.max(.2, Math.min((bw - 20) / w, (bh - 20) / h)));
    view.px = (bw - w * view.z) / 2;
    view.py = Math.max(10, (bh - h * view.z) / 2);
    apply(wrap);
  }

  // 第一次打開：100%、第一列水平置中、上緣留 24px——不 fit
  function home(wrap) {
    const bw = wrap.clientWidth;
    if (!bw || !last) { apply(wrap); return false; }
    let top = Infinity;
    for (const p of last.pos.values()) top = Math.min(top, p.y);
    let l = Infinity; let r = -Infinity;
    for (const [id, p] of last.pos) {
      if (p.y > top + 1) continue;
      l = Math.min(l, p.x); r = Math.max(r, p.x + last.sz.get(id).w);
    }
    view.z = 1;
    view.px = Number.isFinite(l) ? Math.round(bw / 2 - (l + r) / 2) : 0;
    view.py = Number.isFinite(top) ? Math.round(24 - top) : 0;
    apply(wrap);
    return true;
  }

  // 螢幕座標 → 畫布座標（r＝按下時記的外框位置，拖曳中不再量，免得逼瀏覽器重排）
  const toCanvas = (r, clientX, clientY) => ({ x: (clientX - r.left - view.px) / view.z, y: (clientY - r.top - view.py) / view.z });

  // 拖曳中即時重畫與某卡相連的線（查索引；hits＝連命中用的粗線一起，放開才做）
  function redrawEdges(id, hits) {
    for (const k of last.byNode.get(id) ?? []) {
      const g = geo(last, last.edgeByKey.get(k));
      if (!g) continue;
      const d = geoPath(g);
      const el = dom.edges.get(k);
      if (el) { el.firstChild.setAttribute('d', d); if (hits) el.lastChild.setAttribute('d', d); }
      const c = dom.conds.get(k);
      if (!c) continue;
      const m = geoCond(g);
      if (c.proxy) moveProxy(c.proxy, m.x - Number(c.dataset.w) / 2, m.y - 12);
      else { c.style.left = `${m.x - Number(c.dataset.w) / 2}px`; c.style.top = `${m.y - 12}px`; }
    }
  }

  // 拖曳替身：照原元素畫面上的樣子（框、接點、膠囊、你來、文字）在上層 SVG 畫一份，之後每幀只改座標屬性。原元素藏起來，放開再換回
  function makeProxy(el) {
    const z = view.z;
    const box = el.getBoundingClientRect();
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'proxy');
    const parts = [];
    const rel = (e) => { const r = e.getBoundingClientRect(); return { x: (r.left - box.left) / z, y: (r.top - box.top) / z, w: r.width / z, h: r.height / z }; };
    const add = (tag, attrs, dx, dy, text = null, ax = 'x', ay = 'y') => {
      const e = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      if (text !== null) e.textContent = text;
      g.appendChild(e);
      parts.push([e, dx, dy, ax, ay]);
    };
    const fit = (t, e) => { // 跟原字一樣會被截斷：照原框寬量字
      const cs = getComputedStyle(e);
      const ctx = (makeProxy.ctx ??= document.createElement('canvas').getContext('2d'));
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const max = e.clientWidth;
      if (ctx.measureText(t).width <= max) return t;
      let s = t;
      while (s && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
      return `${s}…`;
    };
    const cls = el.classList;
    if (cls.contains('cond')) {
      const w = Number(el.dataset.w);
      add('rect', { class: `p-cond${cls.contains('empty') ? ' empty' : ''}`, width: w, height: 24, rx: 7 }, 0, 0);
      add('text', { class: `p-condtxt${cls.contains('empty') ? ' empty' : ''}` }, w / 2, 12, fit(el.textContent, el));
      return { g, parts };
    }
    const task = cls.contains('node');
    const b = rel(el);
    add('rect', { class: `p-card${task ? '' : ' junction'}${cls.contains('human') ? ' human' : ''}${cls.contains('sel') ? ' sel' : ''}`, width: b.w, height: b.h, rx: task ? 16 : b.w / 2 }, 0, 0);
    for (const p of el.querySelectorAll('.port')) { const r = rel(p); add('circle', { class: 'p-port', r: 4.5 }, r.x + r.w / 2, r.y + r.h / 2, null, 'cx', 'cy'); }
    for (const p of el.querySelectorAll('.pill')) { const r = rel(p); add('rect', { class: 'p-pill', width: r.w, height: r.h, rx: 12 }, r.x, r.y); add('text', { class: 'p-pilltxt' }, r.x + r.w / 2, r.y + r.h / 2, p.textContent); }
    const you = el.querySelector('.chip.you');
    if (you) { const r = rel(you); add('rect', { class: 'p-chip', width: r.w, height: r.h, rx: 10 }, r.x, r.y); add('text', { class: 'p-chiptxt' }, r.x + r.w / 2, r.y + r.h / 2, '你來'); }
    const step = el.querySelector('.sq')?.parentNode;
    if (step) { const r = rel(step); add('text', { class: 'p-step' }, r.x, r.y + r.h / 2, step.firstChild.textContent + step.querySelector('.sq').textContent); }
    const hand = el.querySelector('.nstep i');
    if (hand) { const r = rel(hand); add('text', { class: 'p-icon' }, r.x, r.y + r.h / 2, getComputedStyle(hand, '::before').content.replace(/^"|"$/g, '')); }
    for (const sel of ['.nname', '.nout']) { const t = el.querySelector(sel); if (t) { const r = rel(t); add('text', { class: `p-${sel.slice(2)}${cls.contains('human') ? ' human' : ''}` }, r.x, r.y + r.h / 2, fit(t.textContent, t)); } }
    return { g, parts };
  }
  function moveProxy(P, x, y) { for (const [e, dx, dy, ax, ay] of P.parts) { e.setAttribute(ax, x + dx); e.setAttribute(ay, y + dy); } }

  // 換掉一個元素（insertAdjacentHTML 以父層為語境，SVG 裡的 <g> 也對）；html 空＝刪掉
  function swap(el, h) {
    if (!h) { el.remove(); return null; }
    el.insertAdjacentHTML('afterend', h);
    const nu = el.nextElementSibling;
    el.remove();
    return nu;
  }
  // fill＝把 HTML 裡的佔位換成真值（卡片序號）；回傳換新或新加的 key
  function patch(box, map, prevHtml, nextHtml, keyOf, fill = (k, h) => h) {
    const fresh = new Set();
    for (const [k, el] of map) {
      if (nextHtml.has(k)) continue;
      el.remove();
      map.delete(k);
    }
    for (const [k, h] of nextHtml) {
      const el = map.get(k);
      if (el) { if (prevHtml.get(k) !== h) { const nu = swap(el, fill(k, h)); if (nu) { map.set(keyOf(nu), nu); fresh.add(k); } else map.delete(k); } }
      else if (h) { box.insertAdjacentHTML('beforeend', fill(k, h)); map.set(k, box.lastElementChild); fresh.add(k); }
    }
    return fresh;
  }

  // 結構改動（接線、新卡、剪線、切膠囊、寫條件、復原）：只換有變的卡／線／條件格，不整頁重繪。畫面不在（被重繪換掉）回 false，交給呼叫端 render
  function update(def, selected, issues, model = plainModel(def), opts = {}) {
    if (!dom || !dom.wrap.isConnected || !last) return false;
    const prev = last;
    const next = build(def, selected, issues, model, opts);
    // 拖曳時 DOM 已經跟著走，舊字串的位置可能過期：位置不同就一律換
    const fresh = patch(dom.nodesBox, dom.nodes, prev.nodeHtml, next.nodeHtml, (el) => el.dataset.node, (id, h) => h.replace(SEQ, next.seq.get(id)));
    last = next;
    for (const [id, s] of next.seq) { // 只有序號變了：看得到的卡當場改那兩個字，畫面外的等捲進來再改（加一張卡後面上百張序號都會動）
      if (fresh.has(id)) { pendingSeq.delete(id); continue; }
      if (prev.seq.get(id) === s && !pendingSeq.has(id)) continue;
      pendingSeq.set(id, s);
    }
    for (const id of [...pendingSeq.keys()]) if (!next.seq.has(id)) pendingSeq.delete(id);
    flushSeq();
    patch(dom.edgesBox, dom.edges, prev.edgeHtml, next.edgeHtml, (el) => el.dataset.k);
    patch(dom.condsBox, dom.conds, prev.condHtml, next.condHtml, (el) => el.dataset.cond);
    if (dom.tools) dom.tools.hidden = true; // 線上小工具指著的線可能換掉了
    if (prev.width !== next.width || prev.height !== next.height) {
      dom.svg.setAttribute('width', next.width); dom.svg.setAttribute('height', next.height);
      dom.live.parentNode.setAttribute('width', next.width); dom.live.parentNode.setAttribute('height', next.height);
      dom.wrap.dataset.cvw = next.width; dom.wrap.dataset.cvh = next.height;
      if (size(dom)) scrollTo(dom); // 變大不影響目前捲動位置，不必當場重排
    }
    last = next;
    return true;
  }

  // 單擊選卡：只換 .sel（右欄由 app.js 補）
  function select(id) {
    if (!dom || !last) return;
    dom.nodes.get(last.sel)?.classList.remove('sel');
    if (id) dom.nodes.get(id)?.classList.add('sel');
    last.sel = id;
  }
  // 點線選取（按 Delete 剪）
  function selectEdge(edge) {
    if (!dom || !last) return;
    const k = edge ? ekey(edge) : null;
    const mark = (key, on) => { const el = dom.edges.get(key); if (!el) return; el.classList.toggle('esel', on); el.firstChild.setAttribute('marker-end', `url(#${on ? 'bj-arB' : 'bj-ar'})`); };
    if (last.edgeSel) mark(last.edgeSel, false);
    if (k) mark(k, true);
    last.edgeSel = k;
  }

  // 目前畫面上的卡片座標（新物件，app.js 存檔用）；只認同一份定義，不是就回 null 讓呼叫端自己排
  function shown(def) {
    if (!last || last.def !== def) return null;
    const out = {};
    for (const [id, p] of last.pos) out[id] = { x: p.x, y: p.y };
    return out;
  }
  // 只改座標的存檔（工作本換了一份新物件、畫面不用動）：快照認這份新定義
  function adopt(def) { if (last) last.def = def; }

  function bind(wrap, handlers = {}) {
    if (!wrap || wrap.dataset.bound) return;
    wrap.dataset.bound = '1';
    dom = index(wrap);
    const sc = dom.scroll;
    sc.addEventListener('scroll', () => { // 別的原因捲動了（例：輸入框捲進視野）：視角跟著對
      if (sc.scrollLeft === dom.sx && sc.scrollTop === dom.sy) return;
      dom.sx = sc.scrollLeft; dom.sy = sc.scrollTop;
      view.px = MARGIN - sc.scrollLeft; view.py = MARGIN - sc.scrollTop;
      flushSeq();
    }, { passive: true });
    if (view.home) { if (home(wrap)) view.home = false; } else apply(wrap);
    const tools = wrap.querySelector('.edgetools');
    let toolsEdge = null;
    let hideTimer = null;

    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const cx = e.clientX - rect.left; const cy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nz = Math.min(2.5, Math.max(.2, view.z * factor));
      view.px = cx - ((cx - view.px) * nz) / view.z;
      view.py = cy - ((cy - view.py) * nz) / view.z;
      view.z = nz;
      apply(wrap);
    }, { passive: false });

    // 三種拖曳：pan（空白）｜move（卡）｜link（出口圓點拉線）；pointermove 只記座標，一幀處理一次
    let drag = null;
    let raf = 0;
    let suppressClick = false;

    const frame = () => {
      raf = 0;
      const d = drag;
      if (!d) return;
      if (d.kind === 'pan') {
        view.px = d.px + (d.cx - d.x);
        view.py = d.py + (d.cy - d.y);
        scrollTo(dom);
        flushSeq();
        return;
      }
      const c = toCanvas(d.r, d.cx, d.cy);
      if (d.kind === 'move') {
        const nx = c.x - d.ox; const ny = c.y - d.oy;
        if (!d.moved && Math.hypot(nx - d.bx, ny - d.by) < 4) return; // 沒動夠遠＝當作點選
        if (!d.moved) { // 第一次真的動：線的命中區不收指標（少了幾百塊命中資料）；相連的線搬到上層小 SVG；卡與條件格換成 SVG 替身（見 DRAGB）
          wrap.classList.add('dragging');
          d.proxy = makeProxy(d.el);
          dom.live.appendChild(d.proxy.g);
          d.hidden = [d.el];
          for (const k of last.byNode.get(d.id) ?? []) {
            const el = dom.edges.get(k); if (el) dom.live.parentNode.insertBefore(el, dom.live);
            const c = dom.conds.get(k);
            if (c && !c.matches('input')) { c.proxy = makeProxy(c); dom.live.appendChild(c.proxy.g); d.hidden.push(c); }
          }
          for (const h of d.hidden) h.style.visibility = 'hidden';
        }
        d.moved = true;
        const p = last.pos.get(d.id);
        p.x = nx; p.y = ny;
        moveProxy(d.proxy, nx, ny);
        redrawEdges(d.id, false);
        return;
      }
      // link：先命中測試（版面還是乾淨的）再動幽靈線；只記上一個高亮目標
      const hit = document.elementFromPoint(d.cx, d.cy)?.closest('[data-node]');
      const over = hit && hit.dataset.node !== d.from ? hit : null;
      if (over !== d.over) { d.over?.classList.remove('droptgt'); over?.classList.add('droptgt'); d.over = over; }
      const dy = Math.max(40, (c.y - d.start.y) / 2);
      dom.ghost.setAttribute('d', `M${d.start.x},${d.start.y} C${d.start.x},${d.start.y + dy} ${c.x},${c.y - dy} ${c.x},${c.y}`);
    };

    wrap.addEventListener('pointerdown', (e) => {
      suppressClick = false;
      if (e.button > 0) return;
      if (e.target.closest('.cvtools, .cvhint, .cvhelp, .edgetools, .cond, .pill') || e.target.dataset?.hit) return;
      tools.hidden = true; toolsEdge = null;
      const port = e.target.closest('.port.out');
      const nodeEl = e.target.closest('[data-node]');
      // 自製雙擊偵測（開彈窗會重繪換掉 DOM，原生 dblclick 不可靠）：雙擊卡＝開步驟彈窗、雙擊空白＝原地加一步
      if (!port) {
        const now = Date.now();
        const tap = { t: now, x: e.clientX, y: e.clientY, node: nodeEl?.dataset.node ?? null };
        const prev = bindState.lastTap;
        bindState.lastTap = tap;
        if (prev && now - prev.t < 450 && Math.hypot(tap.x - prev.x, tap.y - prev.y) < 8 && prev.node === tap.node) {
          bindState.lastTap = null;
          suppressClick = true;
          drag = null;
          if (tap.node) handlers.onOpen?.(tap.node);
          else {
            const c = toCanvas(wrap.getBoundingClientRect(), e.clientX, e.clientY);
            handlers.onNewAt?.(Math.round(c.x - NW / 2), Math.round(c.y - NH / 2));
          }
          return;
        }
      }
      const r = wrap.getBoundingClientRect();
      if (port) {
        const from = port.dataset.out;
        const a = last.pos.get(from);
        const s = last.sz.get(from);
        drag = { kind: 'link', from, r, cx: e.clientX, cy: e.clientY, over: null, start: { x: a.x + s.w / 2, y: a.y + s.h + (last.pillOut.has(from) ? PILL_OUT : 0) } };
        dom.ghost.setAttribute('d', '');
        dom.ghost.style.display = '';
        wrap.classList.add('dragging');
      } else if (nodeEl) {
        const id = nodeEl.dataset.node;
        const p = last.pos.get(id);
        const c = toCanvas(r, e.clientX, e.clientY);
        drag = { kind: 'move', id, el: nodeEl, r, cx: e.clientX, cy: e.clientY, ox: c.x - p.x, oy: c.y - p.y, bx: p.x, by: p.y, moved: false };
      } else {
        drag = { kind: 'pan', x: e.clientX, y: e.clientY, cx: e.clientX, cy: e.clientY, px: view.px, py: view.py };
      }
      try { wrap.setPointerCapture(e.pointerId); } catch { /* 合成事件沒有真 pointer，抓不到就算了 */ }
    });

    wrap.addEventListener('pointermove', (e) => {
      if (!drag) return;
      drag.cx = e.clientX; drag.cy = e.clientY;
      if (!raf) raf = requestAnimationFrame(frame);
    });

    const end = (e, cancel) => {
      if (!drag) return;
      if (!cancel) { drag.cx = e.clientX; drag.cy = e.clientY; }
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (!cancel) frame(); // 放開那一刻的位置也算進去，免得少走最後一段
      const d = drag; drag = null;
      if (d.kind === 'pan') {
        if (!cancel && Math.hypot(d.cx - d.x, d.cy - d.y) < 4 && last.edgeSel) handlers.onEdgeSel?.(null); // 點空白＝取消選線
        return;
      }
      if (d.kind === 'move') {
        suppressClick = true;
        if (!d.moved) { if (!cancel) handlers.onSelect?.(d.id); return; }
        const p = last.pos.get(d.id);
        d.el.style.left = `${p.x}px`; d.el.style.top = `${p.y}px`; // 放開才寫 left/top，替身收掉、原卡現身
        for (const h of d.hidden) { h.style.visibility = ''; h.proxy = null; }
        d.proxy.g.remove();
        dom.live.textContent = '';
        for (const k of last.byNode.get(d.id) ?? []) { const el = dom.edges.get(k); if (el) dom.edgesBox.appendChild(el); }
        redrawEdges(d.id, true);
        wrap.classList.remove('dragging');
        if (!cancel) handlers.onMove?.(d.id, p.x, p.y);
        return;
      }
      dom.ghost.style.display = 'none';
      d.over?.classList.remove('droptgt');
      if (cancel) { wrap.classList.remove('dragging'); return; }
      suppressClick = true;
      const c = toCanvas(d.r, d.cx, d.cy);
      const hit = document.elementFromPoint(d.cx, d.cy);
      const over = hit?.closest('[data-node]');
      wrap.classList.remove('dragging');
      if (over && over.dataset.node !== d.from) handlers.onConnect?.(d.from, over.dataset.node, { x: c.x, y: c.y });
      else if (!over && hit && wrap.contains(hit) && !hit.closest('.cvtools, .cvhint, .cvhelp')) handlers.onNewFrom?.(d.from, Math.round(c.x - NW / 2), Math.round(c.y));
    };
    wrap.addEventListener('pointerup', (e) => end(e, false));
    wrap.addEventListener('pointercancel', (e) => end(e, true));

    // 真拖曳後吃掉那一下 click；膠囊、條件格、線、縮放在這裡分派
    wrap.addEventListener('click', (e) => {
      if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); return; }
      const pill = e.target.closest('[data-pill]');
      if (pill) { e.stopPropagation(); handlers.onPill?.(pill.dataset.id, pill.dataset.pill, pill.dataset.mode); return; }
      const cond = e.target.closest('[data-cond]');
      if (cond) { e.stopPropagation(); if (!cond.matches('input')) handlers.onCond?.(last.edgeByKey.get(cond.dataset.cond)); return; }
      const hit = e.target.dataset?.hit;
      if (hit !== undefined) { e.stopPropagation(); handlers.onEdgeSel?.(last.edgeByKey.get(hit)); return; }
      const z = e.target.closest('[data-cv-zoom]');
      if (!z) return;
      e.stopPropagation();
      const rect = wrap.getBoundingClientRect();
      const cx = rect.width / 2; const cy = rect.height / 2;
      if (z.dataset.cvZoom === 'fit') return fit(wrap);
      const factor = z.dataset.cvZoom === 'in' ? 1.25 : 1 / 1.25;
      const nz = Math.min(2.5, Math.max(.2, view.z * factor));
      view.px = cx - ((cx - view.px) * nz) / view.z;
      view.py = cy - ((cy - view.py) * nz) / view.z;
      view.z = nz;
      apply(wrap);
    }, true);

    // 線上滑過 →「＋／×」小工具浮在線中點（擇一線中點有條件格，工具往上讓一格）
    const showTools = (k) => {
      clearTimeout(hideTimer);
      const edge = last.edgeByKey.get(k);
      const g = edge && geo(last, edge);
      if (!g) return;
      toolsEdge = edge;
      const m = geoMid(g);
      // 浮在線中點右邊：線本身要點得到（點線選取、Delete 剪）、上下兩張卡的接點不被蓋住；擇一線中點有條件格，再往右讓
      tools.style.left = `${m.x + (edge.dashed ? (g.lx !== undefined ? 98 : 64) : 14)}px`; // 走通道的擇一線條件格在通道中間（最寬 180），再往右讓
      tools.style.top = `${m.y - 12}px`;
      tools.hidden = false;
    };
    const hideToolsSoon = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { tools.hidden = true; toolsEdge = null; }, 350);
    };
    wrap.addEventListener('pointerover', (e) => {
      if (drag) return;
      const hit = e.target.dataset?.hit;
      if (hit !== undefined) showTools(hit);
      else if (e.target.closest('.edgetools')) clearTimeout(hideTimer);
    });
    wrap.addEventListener('pointerout', (e) => {
      if (e.target.dataset?.hit !== undefined || e.target.closest('.edgetools')) hideToolsSoon();
    });
    tools.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-et]');
      if (!btn || !toolsEdge) return;
      e.stopPropagation();
      const edge = toolsEdge;
      tools.hidden = true; toolsEdge = null;
      if (btn.dataset.et === 'cut') handlers.onCut?.(edge);
      else {
        const g = geo(last, edge);
        handlers.onInsert?.(edge, g ? geoMid(g) : { x: 0, y: 0 });
      }
    });
  }

  function resetView() { view.z = 1; view.px = 0; view.py = 0; view.home = true; }

  window.BJCanvas = { html, bind, update, select, selectEdge, shown, adopt, resetView, layout, view: () => ({ ...view }) };
})();
