// canvas v5 — 畫布回饋輪：分岔/舊 fork/join 不再是大格子，改 34px 小接點（junction）；
// 條件標籤直接釘在線的中點上（貼線）；分岔補出埠＝拉線就多一條路。
// n8n 手感（F5）照舊：節點自由拖擺（16px 吸附、座標存 def.canvas.positions）、
// 出埠拉線（磁吸命中、拖到空白生新步驟）、連線懸停「＋插入／×刪除」、滾輪縮放、空白拖曳平移、fit。
// 資料改動一律回呼 app.js 的 handlers（onMove/onConnect/onNewFrom/onCut/onInsert）——本檔只管畫與互動。
/* global window, document */
(function () {
  const kindOf = (n) => n.kind ?? 'task';
  const outgoing = (n) => (kindOf(n) === 'branch' ? (n.branches ?? []).map((b) => b.next) : (n.next ?? []));

  function predecessors(def) {
    const preds = new Map(def.nodes.map((n) => [n.id, []]));
    for (const n of def.nodes) for (const t of outgoing(n)) preds.get(t)?.push(n.id);
    return preds;
  }

  function layers(def) {
    const predMap = predecessors(def);
    const depth = new Map();
    const visit = (id) => {
      if (depth.has(id)) return depth.get(id);
      depth.set(id, 0);
      const ps = predMap.get(id) ?? [];
      const d = ps.length ? Math.max(...ps.map(visit)) + 1 : 0;
      depth.set(id, d);
      return d;
    };
    for (const n of def.nodes) visit(n.id);
    return depth;
  }

  const NW = 176; const NH = 76; const JS = 34; const GX = 84; const GY = 30; const PAD = 30; const GRID = 16;
  const sizeOf = (n) => (kindOf(n) === 'task' ? { w: NW, h: NH } : { w: JS, h: JS });

  // 自動排版打底，def.canvas.positions 有存的蓋過去（新節點沒座標也有地方站）；小接點置中在格位裡。
  // 排（row）的挑法：分岔的第幾條路先站第幾排、其他節點跟第一個前驅同排——線才不會直直穿過中間欄的格子
  function layout(def) {
    const depth = layers(def);
    const predMap = predecessors(def);
    const armRow = new Map(); // nodeId → 它是某分岔的第幾條路
    for (const n of def.nodes) {
      if (kindOf(n) !== 'branch') continue;
      n.branches.forEach((b, i) => { if (!armRow.has(b.next)) armRow.set(b.next, i); });
    }
    const cols = new Map();
    for (const n of def.nodes) {
      const d = depth.get(n.id);
      if (!cols.has(d)) cols.set(d, []);
      cols.get(d).push(n);
    }
    const pos = new Map();
    const sz = new Map(def.nodes.map((n) => [n.id, sizeOf(n)]));
    const row = new Map();
    for (const [d, nodes] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
      const used = new Set();
      for (const n of nodes) {
        let want = armRow.get(n.id) ?? row.get((predMap.get(n.id) ?? [])[0]) ?? 0;
        while (used.has(want)) want++;
        used.add(want);
        row.set(n.id, want);
        const s = sz.get(n.id);
        pos.set(n.id, { x: PAD + d * (NW + GX) + (NW - s.w) / 2, y: PAD + want * (NH + GY) + (NH - s.h) / 2 });
      }
    }
    const stored = def.canvas?.positions ?? {};
    for (const [id, p] of Object.entries(stored)) {
      if (pos.has(id) && p && Number.isFinite(p.x) && Number.isFinite(p.y)) pos.set(id, { x: p.x, y: p.y });
    }
    let maxX = 0; let maxY = 0;
    for (const [id, p] of pos) { const s = sz.get(id); maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h); }
    const edges = [];
    for (const n of def.nodes) {
      if (kindOf(n) === 'branch') n.branches.forEach((b, i) => edges.push({ from: n.id, to: b.next, label: b.label, arm: i }));
      else for (const t of n.next ?? []) edges.push({ from: n.id, to: t });
    }
    return { pos, sz, width: Math.max(maxX + PAD, 400), height: Math.max(maxY + PAD, 260), edges };
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 一條邊的幾何：出埠（右緣中點）→ 入埠（左緣中點），三次貝茲曲線
  function edgeGeo(e) {
    const a = last.pos.get(e.from); const b = last.pos.get(e.to);
    if (!a || !b) return null;
    const sa = last.sz.get(e.from); const sb = last.sz.get(e.to);
    const x1 = a.x + sa.w; const y1 = a.y + sa.h / 2;
    const x2 = b.x; const y2 = b.y + sb.h / 2;
    const dx = Math.max(40, (x2 - x1) / 2);
    return { x1, y1, x2, y2, dx };
  }
  const geoPath = (g) => `M${g.x1},${g.y1} C${g.x1 + g.dx},${g.y1} ${g.x2 - g.dx},${g.y2} ${g.x2},${g.y2}`;
  // 貝茲 t=0.5 恰為兩埠中點（控制點與端點同高）——標籤與線上小工具都釘在這，貼著線
  const geoMid = (g) => ({ x: (g.x1 + g.x2) / 2, y: (g.y1 + g.y2) / 2 });

  function nodeHtml(n, p, selected, issues) {
    const kind = kindOf(n);
    const sel = (selected === n.id ? ' sel' : '') + (issues?.has(n.id) ? ' issue' : '');
    const at = `style="left:${p.x}px;top:${p.y}px"`;
    const pin = '<span class="port in"></span>';
    const pout = `<span class="port out" data-out="${esc(n.id)}" title="從這裡拉線接下一步"></span>`;
    if (kind === 'branch') {
      return `<div class="junction branch${sel}" data-node="${esc(n.id)}" ${at} title="分岔：${esc(n.title)}——${esc(n.instruction ?? '')}（雙擊改判斷依據；拉出埠＝多一條路）">${pin}${pout}<i class="ph ph-arrows-split"></i></div>`;
    }
    if (kind === 'fork') {
      return `<div class="junction fork${sel}" data-node="${esc(n.id)}" ${at} title="並行點：${esc(n.title)}——從右緣圓點拉幾條線＝同時做幾件事">${pin}${pout}<i class="ph ph-git-branch"></i></div>`;
    }
    if (kind === 'join') {
      return `<div class="junction${sel}" data-node="${esc(n.id)}" ${at} title="${esc(n.title)}（舊式會合點——下次編輯畫布時會自動拆掉，線直接接進下一步）">${pin}${pout}<i class="ph ph-git-merge"></i></div>`;
    }
    const cls = n.executor === 'human' ? ' human' : n.stop_point === 'always' ? ' hold' : '';
    const badges = [
      `<span class="chip" style="font-size:10px">${n.executor === 'human' ? '<i class="ph ph-user"></i>你來' : 'AI'}</span>`,
      n.stop_point === 'always' ? '<span class="chip amber" style="font-size:10px"><i class="ph-fill ph-hand-pointing"></i>停</span>' : '',
    ].join(' ');
    return `<div class="node${cls}${sel}" data-node="${esc(n.id)}" ${at}>${pin}${pout}<b>${esc(n.title)}</b><div class="badges">${badges}</div></div>`;
  }

  // 視圖狀態跨 render 保留（切流程時 resetView）；last=本次 render 的排版快照（拖曳時即時改）
  const view = { z: 1, px: 0, py: 0, fitPending: true };
  let last = null;
  const bindState = { lastTap: null }; // 雙擊偵測要跨 render 存活，放模組層

  function html(def, selected, issues) {
    last = layout(def);
    const { pos, width, height, edges } = last;
    const paths = edges.map((e, i) => {
      const g = edgeGeo(e);
      if (!g) return '';
      const d = geoPath(g);
      return `<path data-e="${i}" d="${d}" stroke="#b3b3bd" stroke-width="1.6" fill="none" marker-end="url(#bj-ar)"/>
        <path data-hit="${i}" d="${d}" stroke="transparent" stroke-width="18" fill="none" style="pointer-events:stroke;cursor:pointer"/>`;
    }).join('');
    const labels = edges.map((e, i) => {
      if (!e.label) return '';
      const g = edgeGeo(e);
      if (!g) return '';
      const m = geoMid(g);
      return `<span class="edgelbl" data-elbl="${i}" data-from="${esc(e.from)}" title="點一下改條件" style="left:${m.x}px;top:${m.y}px">${esc(e.label)}</span>`;
    }).join('');
    const nodes = def.nodes.map((n) => nodeHtml(n, pos.get(n.id), selected, issues)).join('');
    return `<div class="cvwrap" data-cvw="${width}" data-cvh="${height}">
      <div class="cv-inner" style="transform:translate(${view.px}px,${view.py}px) scale(${view.z})">
        <svg class="wire" width="${width}" height="${height}">
          <defs><marker id="bj-ar" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#b3b3bd"/></marker></defs>
          ${paths}
          <path class="ghost" d="" hidden/>
        </svg>
        ${labels}${nodes}
        <div class="edgetools" hidden>
          <span class="etbtn" data-et="insert" title="在這條線中間插一步"><i class="ph ph-plus"></i></span>
          <span class="etbtn danger" data-et="cut" title="剪掉這條線"><i class="ph ph-x"></i></span>
        </div>
      </div>
      <div class="cvpalette">
        <span class="palbtn" data-pal="task" title="加一個步驟框"><i class="ph ph-square"></i>框</span>
        <span class="palbtn" data-pal="fork" title="加一顆並行點：從它拉幾條線＝同時做幾件事"><i class="ph ph-git-branch"></i>並行</span>
        <span class="palbtn" data-pal="branch" title="加一顆分岔點：AI 依你寫的條件挑一條路走"><i class="ph ph-arrows-split"></i>分岔</span>
      </div>
      <div class="zoomer">
        <span class="zbtn" data-cv-zoom="out"><i class="ph ph-minus"></i></span>
        <span class="pct">${Math.round(view.z * 100)}%</span>
        <span class="zbtn" data-cv-zoom="in"><i class="ph ph-plus"></i></span>
        <span class="zbtn" data-cv-zoom="fit" title="縮放到剛好全看見"><i class="ph ph-corners-out"></i></span>
      </div>
    </div>`;
  }

  function apply(wrap) {
    const inner = wrap.querySelector('.cv-inner');
    inner.style.transform = `translate(${view.px}px,${view.py}px) scale(${view.z})`;
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

  // 螢幕座標 → 畫布座標
  function toCanvas(wrap, clientX, clientY) {
    const r = wrap.getBoundingClientRect();
    return { x: (clientX - r.left - view.px) / view.z, y: (clientY - r.top - view.py) / view.z };
  }
  const snap = (v) => Math.round(v / GRID) * GRID;

  // 拖曳中即時重畫與某節點相連的線與線標籤
  function redrawEdges(wrap, nodeId) {
    last.edges.forEach((e, i) => {
      if (e.from !== nodeId && e.to !== nodeId) return;
      const g = edgeGeo(e);
      if (!g) return;
      const d = geoPath(g);
      wrap.querySelector(`[data-e="${i}"]`)?.setAttribute('d', d);
      wrap.querySelector(`[data-hit="${i}"]`)?.setAttribute('d', d);
      const lbl = wrap.querySelector(`[data-elbl="${i}"]`);
      if (lbl) { const m = geoMid(g); lbl.style.left = `${m.x}px`; lbl.style.top = `${m.y}px`; }
    });
  }

  function bind(wrap, handlers = {}) {
    if (!wrap || wrap.dataset.bound) return;
    wrap.dataset.bound = '1';
    if (view.fitPending) { view.fitPending = false; fit(wrap); } else apply(wrap);
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

    // 三種拖曳：pan（空白）｜move（節點）｜link（出埠拉線）
    let drag = null;
    let suppressClick = false;

    wrap.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.zoomer') || e.target.closest('.cvpalette') || e.target.closest('.edgetools') || e.target.closest('.cvdrawer') || e.target.dataset?.hit) return;
      const port = e.target.closest('.port.out');
      const nodeEl = e.target.closest('[data-node]');
      // 自製雙擊偵測（render 會換掉 DOM，原生 dblclick 不可靠）：雙擊節點=開抽屜、雙擊空白=加自由步驟
      if (!port) {
        const now = Date.now();
        const tap = { t: now, x: e.clientX, y: e.clientY, node: nodeEl?.dataset.node ?? null };
        const prev = bindState.lastTap;
        bindState.lastTap = tap;
        if (prev && now - prev.t < 450 && Math.hypot(tap.x - prev.x, tap.y - prev.y) < 8 && prev.node === tap.node) {
          bindState.lastTap = null;
          suppressClick = true;
          if (tap.node) handlers.onOpen?.(tap.node);
          else {
            const c = toCanvas(wrap, e.clientX, e.clientY);
            handlers.onNewAt?.(snap(Math.max(0, c.x - NW / 2)), snap(Math.max(0, c.y - NH / 2)));
          }
          return;
        }
      }
      if (port) {
        const from = port.dataset.out;
        const a = last.pos.get(from);
        const s = last.sz.get(from);
        drag = { kind: 'link', from, start: { x: a.x + s.w, y: a.y + s.h / 2 } };
        wrap.querySelector('.ghost').hidden = false;
      } else if (nodeEl) {
        const id = nodeEl.dataset.node;
        const p = last.pos.get(id);
        const c = toCanvas(wrap, e.clientX, e.clientY);
        drag = { kind: 'move', id, el: nodeEl, ox: c.x - p.x, oy: c.y - p.y, moved: false };
      } else {
        drag = { kind: 'pan', x: e.clientX, y: e.clientY, px: view.px, py: view.py };
        wrap.classList.add('grabbing');
      }
      try { wrap.setPointerCapture(e.pointerId); } catch { /* 合成事件沒有真 pointer，抓不到就算了 */ }
    });

    wrap.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.kind === 'pan') {
        view.px = drag.px + (e.clientX - drag.x);
        view.py = drag.py + (e.clientY - drag.y);
        apply(wrap);
        return;
      }
      const c = toCanvas(wrap, e.clientX, e.clientY);
      if (drag.kind === 'move') {
        const nx = c.x - drag.ox; const ny = c.y - drag.oy;
        const p = last.pos.get(drag.id);
        if (!drag.moved && Math.hypot(nx - p.x, ny - p.y) < 4) return; // 沒動夠遠＝當作點選
        drag.moved = true;
        p.x = nx; p.y = ny;
        drag.el.style.left = `${nx}px`;
        drag.el.style.top = `${ny}px`;
        redrawEdges(wrap, drag.id);
        return;
      }
      // link：幽靈線跟游標，懸在節點上高亮（放上去就算接到）
      const g = wrap.querySelector('.ghost');
      const dx = Math.max(40, (c.x - drag.start.x) / 2);
      g.setAttribute('d', `M${drag.start.x},${drag.start.y} C${drag.start.x + dx},${drag.start.y} ${c.x - dx},${c.y} ${c.x},${c.y}`);
      wrap.querySelectorAll('.droptgt').forEach((n) => n.classList.remove('droptgt'));
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node]');
      if (over && over.dataset.node !== drag.from) over.classList.add('droptgt');
    });

    const end = (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      wrap.classList.remove('grabbing');
      if (d.kind === 'move' && d.moved) {
        suppressClick = true;
        const p = last.pos.get(d.id);
        p.x = snap(Math.max(0, p.x)); p.y = snap(Math.max(0, p.y));
        d.el.style.left = `${p.x}px`; d.el.style.top = `${p.y}px`;
        redrawEdges(wrap, d.id);
        handlers.onMove?.(d.id, p.x, p.y);
      } else if (d.kind === 'link') {
        wrap.querySelector('.ghost').hidden = true;
        wrap.querySelectorAll('.droptgt').forEach((n) => n.classList.remove('droptgt'));
        suppressClick = true;
        const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node]');
        const c = toCanvas(wrap, e.clientX, e.clientY);
        if (over && over.dataset.node !== d.from) handlers.onConnect?.(d.from, over.dataset.node, { x: c.x, y: c.y });
        else if (!over) handlers.onNewFrom?.(d.from, snap(Math.max(0, c.x)), snap(Math.max(0, c.y - NH / 2)));
      }
    };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', () => {
      if (drag?.kind === 'link') { wrap.querySelector('.ghost').hidden = true; wrap.querySelectorAll('.droptgt').forEach((n) => n.classList.remove('droptgt')); }
      drag = null;
      wrap.classList.remove('grabbing');
    });

    // 真拖曳後吃掉那一下 click，避免誤觸「選節點」
    wrap.addEventListener('click', (e) => {
      if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); return; }
      const pal = e.target.closest('[data-pal]');
      if (pal) {
        // 調色盤：點一下＝在目前視野中央生一顆該型態的節點，接線由使用者自己拉
        e.stopPropagation();
        const r = wrap.getBoundingClientRect();
        const c = toCanvas(wrap, r.left + r.width / 2, r.top + r.height * 0.4);
        handlers.onAdd?.(pal.dataset.pal, snap(Math.max(0, c.x - NW / 2)), snap(Math.max(0, c.y)));
        return;
      }
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

    // 連線懸停 →「＋／×」小工具浮在線中點
    const showTools = (i) => {
      clearTimeout(hideTimer);
      const g = edgeGeo(last.edges[i]);
      if (!g) return;
      toolsEdge = last.edges[i];
      const m = geoMid(g);
      tools.style.left = `${m.x - 26}px`;
      tools.style.top = `${m.y - 13}px`;
      tools.hidden = false;
    };
    const hideToolsSoon = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { tools.hidden = true; toolsEdge = null; }, 350);
    };
    wrap.addEventListener('pointerover', (e) => {
      const hit = e.target.dataset?.hit;
      if (hit !== undefined) showTools(Number(hit));
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
        const g = edgeGeo(edge);
        handlers.onInsert?.(edge, g ? geoMid(g) : { x: 0, y: 0 });
      }
    });
  }

  function resetView() { view.z = 1; view.px = 0; view.py = 0; view.fitPending = true; }

  window.BJCanvas = { html, bind, resetView };
})();
