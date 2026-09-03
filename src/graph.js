// graph — 有向圖工具：前驅表、拓撲深度、分岔跳過傳染（runner 與畫布共用邏輯的後端版）
import { outgoing, nodeKind } from './schema.js';

export function predecessors(def) {
  const preds = new Map(def.nodes.map((n) => [n.id, []]));
  for (const n of def.nodes) {
    for (const t of outgoing(n)) preds.get(t)?.push(n.id);
  }
  return preds;
}

// 拓撲深度（最長路徑）：畫布排版的欄位、清單排序用
export function layers(def) {
  const predMap = predecessors(def);
  const depth = new Map();
  const visit = (id) => {
    if (depth.has(id)) return depth.get(id);
    depth.set(id, 0); // 佔位（schema 已擋循環，這裡防禦性避免無窮遞迴）
    const preds = predMap.get(id) ?? [];
    const d = preds.length ? Math.max(...preds.map(visit)) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  for (const n of def.nodes) visit(n.id);
  return depth;
}

// 分岔選路後的跳過集合：一個節點的所有入邊都死了（來自被跳過的節點、或分岔選了別條路）→ 跳過
// choices = { 分岔節點id: 選中的目標id }；未決定的分岔視為每條路都活著
export function computeSkipped(def, choices) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const skipped = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of def.nodes) {
      if (skipped.has(n.id)) continue;
      const edges = [];
      for (const p of def.nodes) {
        if (nodeKind(p) === 'branch') {
          const chosen = choices[p.id];
          for (const b of p.branches) {
            if (b.next !== n.id) continue;
            edges.push({ from: p.id, dead: skipped.has(p.id) || (chosen !== undefined && chosen !== n.id) });
          }
        } else {
          for (const t of p.next ?? []) {
            if (t !== n.id) continue;
            edges.push({ from: p.id, dead: skipped.has(p.id) });
          }
        }
      }
      if (edges.length && edges.every((e) => e.dead)) {
        skipped.add(n.id);
        changed = true;
      }
    }
  }
  return skipped;
}
