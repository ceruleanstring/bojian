// preflight — 開跑前健檢（資料通道輪）：每一步「開跑時會拿到什麼」＋固定規則（不花 AI）。
// 規則只擋一種：AI 步驟根本沒有內容來源（上游只有沒宣告交出內容的人做步驟、或什麼都沒有）且指示明說要吃上一步。
// 其餘一律提醒（可照跑）。前端抽屜預覽與 POST /runs 擋門走同一份結果——單一真相。
import { nodeKind, outgoing, OUTPUT_OFFICE } from './schema.js';
import { predecessors } from './graph.js';
import { attName, attKey } from './shared.js';

const PARAM_RE = /\{\{\s*([\w-]+)\s*\}\}/g;
// 節點裡會被代入參數、送給執行者的欄位（與 runner 的 inj() 對齊）
const PARAM_FIELDS = ['instruction', 'role_context', 'background', 'constraints', 'examples', 'review_focus', 'output_format', 'output_type', 'output_structure', 'output_length', 'output_tone'];
// 指示明說要吃上一步／輸入（R1 擋門的第二個條件；自足指示只提醒）
const UPSTREAM_HINT_RE = /上一步|前一步|上游|上述|以上|前面(的|步驟)|輸入[:：]|讀取|依據上|根據上/;

function paramsUsedBy(node) {
  const keys = [];
  for (const f of PARAM_FIELDS) {
    for (const m of String(node[f] ?? '').matchAll(PARAM_RE)) if (!keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

// 沿入邊往上找「真正的內容來源」：並行點與分岔只是轉運，穿透；task（AI／人做）才是來源
function contentSources(def, nodeId, predMap, byId, seen = new Set()) {
  const out = [];
  for (const p of predMap.get(nodeId) ?? []) {
    if (seen.has(p)) continue;
    seen.add(p);
    const n = byId.get(p);
    if (!n) continue;
    if (nodeKind(n) === 'task') out.push(n);
    else out.push(...contentSources(def, p, predMap, byId, seen));
  }
  return out;
}

// 每一步的輸入來源清單（給抽屜「開跑時會拿到」與健檢共用）
export function inputSources(def) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const predMap = predecessors(def);
  const labels = Object.fromEntries((def.params ?? []).map((p) => [p.key, p.label]));
  const result = {};
  for (const n of def.nodes) {
    if (nodeKind(n) !== 'task') continue;
    const list = [];
    for (const s of contentSources(def, n.id, predMap, byId)) {
      list.push(s.executor === 'human'
        ? { kind: 'human', id: s.id, label: `《${s.title}》（你來做）交出的內容${s.handoff ? `：${s.handoff}` : ''}` }
        : { kind: 'upstream', id: s.id, label: `上一步《${s.title}》的產出` });
    }
    for (const k of paramsUsedBy(n)) list.push({ kind: 'param', id: k, label: `設定欄位：${labels[k] ?? k}` });
    // 參考檔（三層共用檔）：流程層字串與公司／部門層 {scope,name} 都算「這一步有輸入」；規範類不走 attachments，健檢不受影響
    for (const a of n.attachments ?? []) list.push({ kind: 'attachment', id: attKey(a), label: `參考檔：${attName(a)}` });
    result[n.id] = list;
  }
  return result;
}

// 欄位預設值長得像「提示你要貼什麼」而不是真正的內容（排程與健檢輪：新使用者沒填照樣開跑）
const PLACEHOLDER_RE = /貼上|請填|填入|輸入|範例|^\s*[（(\[]/;

// 固定規則 → { issues, inputs, unused_params }；values＝這次的值（開跑前才給；抽屜預覽不給就不查欄位值）
export function preflight(def, values = null) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const inputs = inputSources(def);
  const issues = [];
  const blockedNodes = new Set();

  for (const n of def.nodes) {
    if (nodeKind(n) !== 'task' || n.executor !== 'ai') continue;
    const src = inputs[n.id] ?? [];
    const solid = src.filter((s) => s.kind === 'upstream' || s.kind === 'param' || s.kind === 'attachment');
    const humansNoHandoff = src.filter((s) => s.kind === 'human' && !byId.get(s.id)?.handoff);
    const humansWithHandoff = src.filter((s) => s.kind === 'human' && byId.get(s.id)?.handoff);
    if (solid.length || humansWithHandoff.length) continue;
    const wantsUpstream = UPSTREAM_HINT_RE.test(String(n.instruction ?? ''));
    if (humansNoHandoff.length && wantsUpstream) {
      const h = byId.get(humansNoHandoff[0].id);
      blockedNodes.add(n.id);
      issues.push({
        level: 'block', code: 'no-input', node: n.id,
        title: `「${n.title}」開跑時什麼都拿不到`,
        detail: `它的輸入只來自「${h.title}」（你來做），但那一步沒寫「完成時要交出什麼」——完成時沒交內容它就空手。修法：在「${h.title}」寫明要交出什麼，或把資料做成設定欄位並在「${n.title}」的指示裡引用。`,
        fix: { kind: 'node', id: h.id },
      });
    } else if (!src.length && wantsUpstream) {
      blockedNodes.add(n.id);
      issues.push({
        level: 'block', code: 'no-input', node: n.id,
        title: `「${n.title}」開跑時什麼都拿不到`,
        detail: '指示裡要它讀上一步或輸入，但這一步沒有接任何上游、沒引用設定欄位、也沒掛參考檔。修法：把資料做成設定欄位並在指示裡引用，或接一條線把產出資料的步驟接過來。',
        fix: { kind: 'node', id: n.id },
      });
    } else if (!src.length) {
      issues.push({
        level: 'warn', code: 'self-contained', node: n.id,
        title: `「${n.title}」沒有任何輸入來源`,
        detail: 'AI 只靠指示本身做這一步。指示自足就沒問題；要用到資料就把它做成設定欄位並在指示裡引用。',
        fix: { kind: 'node', id: n.id },
      });
    } else if (humansNoHandoff.length) {
      issues.push({
        level: 'warn', code: 'self-contained', node: n.id,
        title: `「${n.title}」的輸入全靠你來做的步驟交出內容`,
        detail: `上游「${byId.get(humansNoHandoff[0].id).title}」是你來做的步驟，沒寫要交出什麼；完成時沒交內容，這一步就只剩指示本身。`,
        fix: { kind: 'node', id: humansNoHandoff[0].id },
      });
    }
  }

  // R3：人做步驟後面接 AI，卻沒寫「完成時要交出什麼」（下游已被 R1 擋的不重複報）
  for (const n of def.nodes) {
    if (nodeKind(n) !== 'task' || n.executor !== 'human' || n.handoff) continue;
    const aiNext = outgoing(n).map((t) => byId.get(t)).filter((t) => t && nodeKind(t) === 'task' && t.executor === 'ai' && !blockedNodes.has(t.id));
    if (!aiNext.length) continue;
    issues.push({
      level: 'warn', code: 'human-empty-handoff', node: n.id,
      title: `「${n.title}」後面接的是 AI，但沒寫完成時要交出什麼`,
      detail: `下一步「${aiNext[0].title}」會用你交出的內容；寫明要交什麼，完成時的輸入框會照著提示你。`,
      fix: { kind: 'node', id: n.id },
    });
  }

  // R5 file-permission（擋，產檔輪）：步驟要產 Word／Excel 真檔，但這條流程沒開產檔權限
  if (def.permissions?.files !== true) {
    for (const n of def.nodes) {
      if (nodeKind(n) !== 'task' || n.executor !== 'ai' || !OUTPUT_OFFICE.includes(n.output_file)) continue;
      issues.push({
        level: 'block', code: 'file-permission', node: n.id,
        title: `「${n.title}」要產出 .${n.output_file} 檔，但這條流程沒開產檔權限`,
        detail: '打開流程頁的「允許這條流程產出檔案」再按開始；不開的話會改存成 .md 文字檔。',
        fix: { kind: 'flow', id: 'permissions.files' },
      });
    }
  }

  // R2：設定欄位沒被任何步驟引用
  const used = new Set();
  for (const n of def.nodes) for (const k of paramsUsedBy(n)) used.add(k);
  const unused_params = (def.params ?? []).map((p) => p.key).filter((k) => !used.has(k));
  for (const k of unused_params) {
    const p = def.params.find((x) => x.key === k);
    issues.push({
      level: 'warn', code: 'unused-param', param: k,
      title: `欄位「${p.label}」沒有步驟用到`,
      detail: `開跑前改它不會影響任何一步。要用的話，在那一步的指示裡寫 {{${k}}}。`,
      fix: { kind: 'param', id: k },
    });
  }

  // R4 param-unfilled（擋）：被 AI 步驟引用的欄位，這次的值空白、或還是預設且（必填 或 預設像佔位文字）
  if (values) {
    const usedByAi = new Set();
    for (const n of def.nodes) if (nodeKind(n) === 'task' && n.executor === 'ai') for (const k of paramsUsedBy(n)) usedByAi.add(k);
    for (const p of def.params ?? []) {
      if (!usedByAi.has(p.key)) continue;
      const raw = values[p.key];
      const val = raw === undefined || raw === null ? '' : String(raw);
      const dft = String(p.default ?? '');
      const empty = !val.trim();
      const stillDefault = !empty && val.trim() === dft.trim();
      if (!empty && !(stillDefault && (p.required === true || PLACEHOLDER_RE.test(dft)))) continue;
      issues.push({
        level: 'block', code: 'param-unfilled', param: p.key,
        title: `欄位「${p.label}」還沒填`,
        detail: empty
          ? `有步驟要用它，現在是空的。${p.hint ? `要貼的是：${p.hint}。` : ''}填好再按開始。`
          : `現在還是預設的提示文字「${dft.trim().slice(0, 40)}」——把真正的內容貼進去再按開始。`,
        fix: { kind: 'param', id: p.key },
      });
    }
  }

  return { issues, inputs, unused_params };
}
