// preflight — 開跑前健檢（資料通道輪）：每一步「開跑時會拿到什麼」＋固定規則（不花 AI）。
// 規則只擋一種：AI 步驟根本沒有內容來源（上游只有沒宣告交出內容的人做步驟、或什麼都沒有）且指示明說要吃上一步。
// 其餘一律提醒（可照跑）。前端抽屜預覽與 POST /runs 擋門走同一份結果——單一真相。
import { nodeKind, outgoing, OUTPUT_OFFICE } from './schema.js';
import { predecessors, ancestorIds } from './graph.js';
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

// 沿路全部內容來源（拆法輪，契約 C，與 runner.upstreamText 同一套）：所有祖先裡的 task（AI／人做），最近在前；
// 並行點與分岔只是結構不算來源、同一步只出現一次。ancestorIds 第一參數是 run，preflight 只有 def，包一層（地雷 4）
function contentSources(def, nodeId, predMap, byId) {
  return ancestorIds({ def }, nodeId, predMap)
    .map((p) => byId.get(p))
    .filter((n) => n && nodeKind(n) === 'task')
    .reverse();
}

// 最近的內容來源：沿入邊往上、只穿透並行點與分岔——標籤上「上一步」與「更早的步驟」的分界
function nearestSources(nodeId, predMap, byId, seen = new Set()) {
  const out = [];
  for (const p of predMap.get(nodeId) ?? []) {
    if (seen.has(p)) continue;
    seen.add(p);
    const n = byId.get(p);
    if (!n) continue;
    if (nodeKind(n) === 'task') out.push(n.id);
    else out.push(...nearestSources(p, predMap, byId, seen));
  }
  return out;
}

// 排版輪 L11（題 2 A）：每次上傳的檔由誰讀——沒有 AI 祖先的 AI 步驟（通常就是第一個 AI 步驟）；後面的步驟靠沿路全帶拿它的產出
// 排版輪 L13（題 1 A）：任一條到的卡只收先到的那條線——只要有一條線（連同它的祖先）沒有 AI，就可能沒 AI 讀過檔，算「可能沒有 AI 祖先」。
// 沒有任一條到的定義：等於「全部祖先都不是 AI」，與原寫法同一結果
export function uploadReaders(def) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const predMap = predecessors(def);
  const isAi = (n) => n && nodeKind(n) === 'task' && n.executor === 'ai';
  const memo = new Map();
  const mayBeAiFree = (id) => { // 這一步開始時，可能一個 AI 祖先都沒有
    if (memo.has(id)) return memo.get(id);
    memo.set(id, false); // schema 已擋繞圈，這裡防禦
    const clean = (p) => !isAi(byId.get(p)) && mayBeAiFree(p);
    const ps = predMap.get(id) ?? [];
    const v = !ps.length || (byId.get(id)?.merge === 'any' ? ps.some(clean) : ps.every(clean));
    memo.set(id, v);
    return v;
  };
  return def.nodes.filter((n) => isAi(n) && mayBeAiFree(n.id)).map((n) => n.id);
}
const fileParams = (def) => (def.params ?? []).filter((p) => p.input === 'file');

// 每一步的輸入來源清單（給抽屜「開跑時會拿到」與健檢共用）
export function inputSources(def) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const predMap = predecessors(def);
  const labels = Object.fromEntries((def.params ?? []).map((p) => [p.key, p.label]));
  const readers = new Set(fileParams(def).length ? uploadReaders(def) : []);
  const result = {};
  for (const n of def.nodes) {
    if (nodeKind(n) !== 'task') continue;
    const list = [];
    const near = new Set(nearestSources(n.id, predMap, byId));
    // 排版輪 L13（題 1 A）：任一條到＝直接接進來的線不一定都趕得上，照列但標出來；更早的祖先一定到，不標
    const anyTag = (s) => (n.merge === 'any' && near.has(s.id) ? '（任一條到）' : '');
    for (const s of contentSources(def, n.id, predMap, byId)) {
      list.push(s.executor === 'human'
        ? { kind: 'human', id: s.id, label: `《${s.title}》（你來做）交出的內容${s.handoff ? `：${s.handoff}` : ''}${anyTag(s)}` }
        : { kind: 'upstream', id: s.id, label: `${near.has(s.id) ? '上一步' : '更早的步驟'}《${s.title}》的產出${anyTag(s)}` });
    }
    for (const k of paramsUsedBy(n)) list.push({ kind: 'param', id: k, label: `設定欄位：${labels[k] ?? k}` });
    // 參考檔（三層共用檔）：流程層字串與公司／部門層 {scope,name} 都算「這一步有輸入」；規範類不走 attachments，健檢不受影響
    for (const a of n.attachments ?? []) list.push({ kind: 'attachment', id: attKey(a), label: `參考檔：${attName(a)}` });
    if (readers.has(n.id)) for (const p of fileParams(def)) list.push({ kind: 'upload', id: p.key, label: `這次上傳：${p.label}` });
    result[n.id] = list;
  }
  return result;
}

// 排版輪 L14b：/api/preflight 傳給前端的輸入來源（不重複的寫法）——原本每步列全部祖先的整句，200 步 119 萬字元、隨步數平方成長。
// pred[id]＝[第一個前驅, ...之後多出來的祖先]：order(id)＝order(第一個前驅)＋[第一個前驅]＋多出來的（與 ancestorIds 同順序，單線時只有一個 id）；
// src[task]＝{t 名稱, h 人做, o 交出什麼} 只傳一次；at[task]＝{near 直接來源, any 任一條到, own 欄位／參考檔／上傳}。前端 pfInputs 展開，與 inputSources 逐項相同
export function packInputs(def) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const predMap = predecessors(def);
  const full = inputSources(def);
  const pred = {};
  const orderLen = new Map();
  for (const n of def.nodes) {
    const order = ancestorIds({ def }, n.id, predMap);
    orderLen.set(n.id, order.length);
    const first = (predMap.get(n.id) ?? [])[0];
    if (first === undefined) continue;
    pred[n.id] = [first, ...order.slice((orderLen.get(first) ?? ancestorIds({ def }, first, predMap).length) + 1)];
  }
  const src = {};
  const at = {};
  for (const n of def.nodes) {
    if (nodeKind(n) !== 'task') continue;
    src[n.id] = { t: n.title, ...(n.executor === 'human' ? { h: 1, ...(n.handoff ? { o: n.handoff } : {}) } : {}) };
    at[n.id] = { near: nearestSources(n.id, predMap, byId), ...(n.merge === 'any' ? { any: 1 } : {}), own: full[n.id].filter((s) => s.kind !== 'upstream' && s.kind !== 'human') };
  }
  return { pred, src, at };
}

// 欄位預設值長得像「提示你要貼什麼」而不是真正的內容（排程與健檢輪：新使用者沒填照樣開跑）
// 2026-09-18 二次審查補：R4 放寬成「只有預設像佔位文字才擋」之後，必填欄位的守門就只剩這條規則，
// 而它漏掉同樣常見的「例：…」「此處填…」「待填」「XXX」——漏掉的代價是 AI 拿那句範例當主題
// 花錢跑完一整趟，交出一份標著完成的報告。
// 取捨（覆核退回兩次後定）：誤擋的代價比漏擋大得多——漏擋只是回到補這條之前的狀態，誤擋卻讓
// 那個欄位永遠開不了跑（正是 R4 這次要拆掉的病）。所以本次新加的四段一律綁句首或整串：
//   「例：」限句首（不然「案例：A 公司違約」「前例：無」被擋）；「此處填／放／寫／貼」限句首
//   （不然「會議紀錄請於此處填寫收件地址」這種表單文案被擋）；「待填」限整串就這兩個字
//   （不然「待填人力需求評估表」被擋）；XXX 同樣限整串。
//   曾經加過的「填寫」「你的…」全數撤掉：「填寫月報」「你的訂單已成立」都是合理答案，字面分不開。
//   代價＝「填寫客戶名稱」「TBD」「N/A」「尚未填寫」這類佔位漏得掉，由必填欄位的 hint 與使用者把關。
// 【已知缺陷，本輪不動，記在 STATE 列管】前五段（貼上／請填／填入／輸入／範例）是排程與健檢輪就有的
// 舊規則，任何位置命中就擋，沒有邊界——「已貼上出貨憑證」「本月輸入項目共 12 筆」「以範例 A 版為準」
// 這類真答案會被誤擋（2026-09-18 覆核實測 24/27）。它不是本輪改出來的，且補邊界會同時放掉一批
// 原本擋得住的佔位，屬於要單獨開一輪、要先確認代價的改動，不在本輪順手動。
const PLACEHOLDER_RE = /貼上|請填|填入|輸入|範例|^\s*此處[填放寫貼]|^\s*例[：:]|^\s*待填\s*$|^\s*[xXｘＸ]{3,}\s*$|^\s*[（(\[]/;

// 固定規則 → { issues, inputs, unused_params }；values＝這次的值（開跑前才給；抽屜預覽不給就不查欄位值）
export function preflight(def, values = null) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const inputs = inputSources(def);
  const issues = [];
  const blockedNodes = new Set();

  for (const n of def.nodes) {
    if (nodeKind(n) !== 'task' || n.executor !== 'ai') continue;
    const src = inputs[n.id] ?? [];
    const solid = src.filter((s) => s.kind === 'upstream' || s.kind === 'param' || s.kind === 'attachment' || s.kind === 'upload');
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
        title: `「${n.title}」要產出 .${n.output_file} 檔，但這條 Workflow 沒開產檔權限`,
        detail: '打開 Workflow 頁的「允許這條 Workflow 產出檔案」再按開始；不開的話會改存成 .md 文字檔。',
        fix: { kind: 'flow', id: 'permissions.files' },
      });
    }
  }

  // R2：設定欄位沒被任何步驟引用
  const used = new Set();
  for (const n of def.nodes) for (const k of paramsUsedBy(n)) used.add(k);
  const unused_params = (def.params ?? []).filter((p) => p.input !== 'file').map((p) => p.key).filter((k) => !used.has(k)); // 上傳欄位靠檔案讀，不算沒人用
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
      // R6 upload-missing（擋，排版輪 L11）：必填的上傳欄位這一趟沒有檔（values 裡是上傳檔名，沒傳＝空）
      if (p.input === 'file') {
        if (p.required === true && !String(values[p.key] ?? '').trim()) {
          issues.push({
            level: 'block', code: 'upload-missing', param: p.key,
            title: `「${p.label}」還沒上傳檔案`,
            detail: '這個欄位每次開跑都要上傳一個檔（只給這一趟用，下次不留）。選好檔再按開始。',
            fix: { kind: 'param', id: p.key },
          });
        }
        continue;
      }
      if (!usedByAi.has(p.key)) continue;
      const raw = values[p.key];
      const val = raw === undefined || raw === null ? '' : String(raw);
      const dft = String(p.default ?? '');
      const empty = !val.trim();
      const stillDefault = !empty && val.trim() === dft.trim();
      // 「必填」的語意是不能留空，不是「不准等於預設值」。把 required 也當成擋的理由，會讓任何
      // 預設值就是正確答案的必填欄位（例如長度「800 字」）永遠開不了跑，使用者得改成「800字」之類的
      // 假動作騙過它，而卡片上還指控那是「預設的提示文字」（2026-09-18 審查）。只有預設真的像佔位文字才擋。
      if (!empty && !(stillDefault && PLACEHOLDER_RE.test(dft))) continue;
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
