// 排版輪 並排量測（在頁面裡 eval；分身與樣稿共用同一套啟發式，回 JSON 字串）
// cmp＝契約 L 要比的欄位（layout-compare 逐欄比）；info＝只記不比（W5 真資料不同的寬高、字型、文字）。
// 由 scratchpad measure.js 搬入；補：內容區上內距、標題距內容區頂端、前三張白卡、畫面專屬欄位（window.__screen）。
(() => {
  const cs = (e) => getComputedStyle(e);
  const R = (e) => e.getBoundingClientRect();
  const px = (v) => Math.round(parseFloat(v) * 10) / 10;
  const vis = (e) => { const r = R(e); const s = cs(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < 900; };
  const hasText = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const tag = (e) => e.tagName + '.' + String(e.className).slice(0, 40);
  const solidBg = (s) => s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';
  const screen = window.__screen ?? '';
  const cmp = {}; const info = { url: location.href, bodyFont: cs(document.body).fontFamily, bodyBg: cs(document.body).backgroundColor };
  const all = [...document.querySelectorAll('body *')];

  // 頂欄：貼頂、滿寬、矮
  const top = all.find((e) => { if (!vis(e)) return false; const r = R(e); return r.top <= 1 && r.left <= 1 && r.width >= 1400 && r.height >= 30 && r.height <= 90; });
  cmp.topbar = { present: !!top, height: top ? Math.round(R(top).height) : 0 };
  if (top) info.topbar = { tag: tag(top), text: top.innerText.replace(/\s+/g, ' ').slice(0, 60) };

  // 側欄：最左邊、高、窄
  const side = [...document.querySelectorAll('aside, nav'), ...all].find((e) => { if (!vis(e)) return false; const r = R(e); return r.left <= 40 && r.top <= 130 && r.width >= 150 && r.width <= 380 && r.height >= 600; });
  if (side) {
    const nav = [...side.querySelectorAll('button, a, [data-act]')].filter(vis).find((x) => /^\s*(儀表板|總覽)/.test(x.textContent));
    cmp.sidebar = { width: Math.round(R(side).width), left: Math.round(R(side).left), navFontSize: nav ? px(cs(nav).fontSize) : null, navHeight: nav ? Math.round(R(nav).height) : null };
    const texts = [...side.querySelectorAll('*')].filter((x) => vis(x) && hasText(x));
    info.sidebar = { tag: tag(side), top: Math.round(R(side).top), bg: cs(side).backgroundColor, firstText: texts[0]?.textContent.trim().slice(0, 30) ?? null, visibleTextLines: texts.length, navPadding: nav ? cs(nav).padding : null };
  } else cmp.sidebar = null;
  const leftEdge = side ? R(side).right : 0;

  // 對話框（彈窗／抽屜）：fixed/absolute、中寬、實底、圓角——先找，下面的白卡要排除它
  const dialog = all.find((e) => { if (!vis(e)) return false; const s = cs(e); const r = R(e); return (s.position === 'fixed' || s.position === 'absolute') && r.width >= 400 && r.width < 1300 && r.height >= 300 && solidBg(s) && parseFloat(s.borderTopLeftRadius) > 0 && !(side && e.contains(side)); });

  // 頁標題：內容區上方 320px 內字最大的字；dialog 開著時不算 dialog 裡的
  let best = null;
  for (const e of all) {
    if (!vis(e) || !hasText(e) || (dialog && dialog.contains(e)) || (side && side.contains(e))) continue;
    const r = R(e);
    if (r.left < leftEdge || r.top > 320) continue;
    const f = parseFloat(cs(e).fontSize);
    if (!best || f > best.f) best = { f, e };
  }
  // 內容區：標題往上最外層、不含側欄、左緣在側欄右邊的祖先
  let box = null;
  for (let p = best?.e.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    if (side && p.contains(side)) break;
    if (R(p).left >= leftEdge - 2) box = p;
  }
  const boxTop = box ? R(box).top : 0;
  cmp.content = { left: Math.round(leftEdge), padTop: box ? px(cs(box).paddingTop) : null };
  info.content = box ? { tag: tag(box), top: Math.round(boxTop), left: Math.round(R(box).left), width: Math.round(R(box).width) } : null;
  cmp.title = best ? { fontSize: px(best.f), weight: cs(best.e).fontWeight, top: Math.round(R(best.e).top - boxTop) } : null;
  if (best) info.title = { text: best.e.textContent.trim().replace(/\s+/g, ' ').slice(0, 40), font: cs(best.e).fontFamily.slice(0, 60), absTop: Math.round(R(best.e).top) };

  // 白卡：內容區裡有圓角、有框或陰影、有底色；整塊工作區大白卡（>900×600）另記 info.workPanel
  const cards = [];
  for (const e of all) {
    if (cards.length >= 3) break;
    if ((side && side.contains(e)) || (dialog && (dialog === e || dialog.contains(e))) || !vis(e)) continue;
    const r = R(e); const s = cs(e);
    if (r.left < leftEdge || r.width < 220 || r.height < 60 || r.top > 850) continue;
    const rad = parseFloat(s.borderTopLeftRadius); const bw = parseFloat(s.borderTopWidth);
    if (!(rad >= 4 && (bw > 0 || s.boxShadow !== 'none') && solidBg(s))) continue;
    if (r.width > 900 && r.height > 600) { info.workPanel ??= { tag: tag(e), radius: s.borderTopLeftRadius, padding: s.padding, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; continue; }
    if (cards.some((c) => c.el.contains(e))) continue;
    cards.push({ el: e, radius: px(s.borderTopLeftRadius), padding: s.padding, fontSize: px(s.fontSize) });
  }
  cards.forEach((c, i) => { cmp[`card${i + 1}`] = { radius: c.radius, padding: c.padding, fontSize: c.fontSize }; });
  info.cards = cards.map((c) => { const r = R(c.el); return { tag: tag(c.el), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }; });

  // —— 畫面專屬 ——
  const inContent = (e) => vis(e) && !(side && side.contains(e)) && R(e).left >= leftEdge - 2;
  // 重複卡群：同一父層下 ≥2 個同 class、寬≥200 高≥90 的兄弟，取張數最多的一群
  const repeatGroup = () => {
    let g = null;
    for (const p of all) {
      if (!inContent(p) || p.children.length < 2) continue;
      const by = new Map();
      for (const c of p.children) { if (!vis(c) || !c.className) continue; const r = R(c); if (r.width < 200 || r.height < 90) continue; const k = String(c.className); by.set(k, [...(by.get(k) ?? []), c]); }
      for (const list of by.values()) if (list.length >= 2 && (!g || list.length > g.length)) g = list;
    }
    return g;
  };
  // 右欄：貼右、夠高、中寬
  const rightCol = () => { let w = null; for (const e of all) { if (!inContent(e)) continue; const r = R(e); if (r.left >= 900 && r.right >= 1370 && r.height >= 400 && r.width >= 200 && r.width <= 520 && (!w || r.width > R(w).width)) w = e; } return w; };
  const s = {};
  if (screen === '02' || screen === '08') {
    const g = repeatGroup();
    if (g) {
      const r0 = R(g[0]); const st = cs(g[0]);
      if (screen === '02') Object.assign(s, { cardW: Math.round(r0.width), cardH: Math.round(r0.height), perRow: g.filter((c) => Math.abs(R(c).top - r0.top) < 2).length });
      else Object.assign(s, { stepRadius: px(st.borderTopLeftRadius), stepPadding: st.padding, stepFontSize: px(st.fontSize) });
      info.group = { tag: tag(g[0]), count: g.length };
    }
    if (screen === '08') { const rc = rightCol(); s.rightWidth = rc ? Math.round(R(rc).width) : null; if (rc) info.right = tag(rc); }
  }
  if (screen === '04') {
    let big = null;
    for (const e of all) { if (!inContent(e)) continue; const st = cs(e); const r = R(e); if (parseFloat(st.borderTopLeftRadius) >= 4 && solidBg(st) && r.width >= 400 && (!big || r.width * r.height > R(big).width * R(big).height)) big = e; }
    if (big) { s.settingsWidth = Math.round(R(big).width); s.settingsPadding = cs(big).padding; info.settings = tag(big); }
  }
  if (screen === '09') {
    let fr = null;
    for (const e of all) { if (!inContent(e) || !e.querySelector('svg')) continue; const r = R(e); const st = cs(e); if (r.width >= 500 && r.height >= 300 && parseFloat(st.borderTopLeftRadius) >= 4 && (!fr || r.width * r.height < R(fr).width * R(fr).height)) fr = e; }
    if (fr) { s.canvasRadius = px(cs(fr).borderTopLeftRadius); s.canvasHeight = Math.round(R(fr).height); info.canvas = tag(fr); }
    const rc = rightCol(); s.rightWidth = rc ? Math.round(R(rc).width) : null; if (rc) info.right = tag(rc);
  }
  if (screen === '11') {
    if (dialog) { s.dialogWidth = Math.round(R(dialog).width); s.dialogRadius = px(cs(dialog).borderTopLeftRadius); info.dialog = { tag: tag(dialog), x: Math.round(R(dialog).left), y: Math.round(R(dialog).top), h: Math.round(R(dialog).height), position: cs(dialog).position }; }
    else s.dialogWidth = null;
  }
  if (screen === '12') {
    let cols = null;
    for (const p of all) {
      if (!inContent(p)) continue;
      const kids = [...p.children].filter((c) => vis(c) && R(c).height >= 150 && R(c).width >= 150);
      if (kids.length < 3) continue;
      const lefts = new Set(kids.map((c) => Math.round(R(c).left)));
      if (lefts.size < 3) continue;
      const sum = kids.reduce((t, c) => t + R(c).width, 0);
      if (!cols || sum > cols.sum) cols = { sum, kids, p };
    }
    s.columns = cols ? cols.kids.slice(0, 3).map((c) => Math.round(R(c).width)) : null;
    if (cols) info.columns = { tag: tag(cols.p), kids: cols.kids.slice(0, 3).map(tag) };
  }
  if (Object.keys(s).length) cmp.s = s;
  return JSON.stringify({ cmp, info });
})()
