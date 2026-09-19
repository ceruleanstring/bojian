// runner — run 生命週期（有向圖版，D14）：就緒集推進、平行併發、分岔判路、停點/人步暫停、checkpoint。
// 寫入紀律：所有狀態變更走 update()（讀最新→改→原子存），跨 await 不持有舊物件——平行支不互相蓋寫。
import fs from 'node:fs';
import path from 'node:path';
import { validateWorkflow, nodeKind, outgoing, OUTPUT_TIER2, OUTPUT_OFFICE } from './schema.js';
import { predecessors, computeSkipped, ancestorIds } from './graph.js';
import { inputSources, uploadReaders } from './preflight.js';
import { buildSources, extractFileText, runCheck, deriveEditRules as deriveRules } from './checker.js';
import {
  supervisorFlags, buildRecordTable,
  brief as supervisorBrief, handoff as supervisorHandoff, record as supervisorRecord,
} from './supervisor.js';
import { scopeKey, attName } from './shared.js';

// 監工開場看得到的參考檔：純文字類讀原文（截字由 prompt 那邊統一做），Word／Excel 這種只列名字——
// 監工沒有開檔案的工具，給它檔名至少它知道有這份東西存在
const REF_TEXT_EXTS = ['md', 'txt', 'csv', 'json', 'html'];
// 分岔節點的交接只做一件事：選路。三個勾對它沒有意義（沒有檔位、沒有查網、備註沒有下一個工人會讀）
const BRANCH_FLAGS = { note: false, tier: false, tools: false };
// {{欄位}} 引用；會代入欄位值的節點欄位（這一步引用到的欄位，其被選的習慣卡才算「這步用了」）
const PARAM_REF = /\{\{\s*([\w-]+)\s*\}\}/g;
const INJECTED_FIELDS = ['instruction', 'role_context', 'background', 'constraints', 'examples', 'review_focus', 'output_type', 'output_structure', 'output_length', 'output_tone', 'output_format'];

// 每一步的輸入＝沿路全部祖先 task 的產出，總量上限 80,000 字（只借查核員的數字，不借它的切法）
export const UPSTREAM_CAP = 80000;
const UPSTREAM_PREFACE = '（沿路全部產出，最近的在前）';

// 沿路產出的截斷（純函式）：parts＝[{title,text}] 最近在前。從最遠那段開始整段丟，丟到放得下為止；
// 最近那段永遠留著（整段丟的政策不切半段，單段超量交給宿主）；丟過就在尾巴記名，工人知道少了哪幾步。
export function capUpstream(parts, cap = UPSTREAM_CAP) {
  const seg = (x) => `【${x.title}】\n${x.text}`;
  const kept = parts.map(seg);
  const dropped = [];
  let total = kept.reduce((n, s) => n + s.length, 0);
  while (total > cap && kept.length > 1) {
    total -= kept.pop().length;
    dropped.unshift(parts[kept.length].title);
  }
  const body = `${UPSTREAM_PREFACE}\n${kept.join('\n\n')}`;
  return dropped.length ? `${body}\n（更早的產出已截斷：${dropped.join('、')}）` : body;
}

// 長欄位值不代進句子——給了 sink 時，換行或超過 200 字的值不直接代入，
// 改留一句指向「欄位內容」段的提示，原文收進 sink（Map，同一 key 只收一次）；不給 sink＝舊行為。
function injectParams(instruction, params, { labels, sink } = {}) {
  return instruction.replace(PARAM_REF, (_, key) => {
    const value = String(params[key] ?? '');
    if (sink && (value.includes('\n') || value.length > 200)) {
      const label = labels?.[key] ?? key;
      if (!sink.has(key)) sink.set(key, { label, value });
      return `（見下方「欄位內容」的「${label}」）`;
    }
    return value;
  });
}

function effectiveOutput(step) {
  return step.edited_output ?? step.output ?? '';
}

// 工人自報「這步的資料不夠」的協定：標頭那行是缺什麼，其餘是骨架
const SHORTFALL = /^【資料不全】(.*)\n?([\s\S]*)$/;

// 沒有查核結果的紀錄：off＝流程關掉查核，skipped＝不適用（人做、分岔、並行點、自報資料不全）
const noCheck = (status) => ({ status, blocks: [], flags: [], missing: [], items: [], summary: '', note: '', attempts: 0 });

// 等時刻：時刻文字→Date；解析不出回 null（不排幽靈時間）。
// 嚴格逐欄比對（健檢 M2）：不存在的日期（如 2/30）會被 JS 捲到下一月——捲動＝輸入不合法，回 null 不猜。
export function parseWhen(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
  if (m) {
    const [y, mo, da, h, mi] = m.slice(1).map(Number);
    const d = new Date(y, mo - 1, da, h, mi);
    if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da || d.getHours() !== h || d.getMinutes() !== mi) return null;
    return d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// 任一條到。「到了」＝前驅沒被跳過、已完成，而且那條線是活的（前驅是分岔的話要選中這張卡）
function arrivedPreds(run, nodeId, preds, skipped) {
  const byId = new Map(run.def.nodes.map((n) => [n.id, n]));
  return preds.filter((p) => !skipped.has(p) && run.steps[p]?.status === 'done'
    && (nodeKind(byId.get(p) ?? {}) !== 'branch' || run.steps[p].choice === nodeId));
}
// 沿路全帶用的前驅表：開始過的任一條到卡只認 merge_from——沒趕上的線不進這張卡，也不經由它流進下游。沒有這種卡＝原表照用
function livePreds(run, predMap = predecessors(run.def)) {
  let out = predMap;
  for (const [nid, s] of Object.entries(run.steps ?? {})) {
    if (!Array.isArray(s?.merge_from) || !predMap.has(nid)) continue;
    if (out === predMap) out = new Map(predMap);
    out.set(nid, predMap.get(nid).filter((p) => s.merge_from.includes(p)));
  }
  return out;
}

// memory＝createMemory 門面：開跑後判「同值連兩趟」記習慣卡。門面炸了只留一句，run 照建
export function createRunner({ store, adapter, now = () => Date.now(), memory = null }) {
  const load = (c, i, r) => store.readRun(c, i, r);

  // 產出檔名：以步驟標題為主（使用者下載時看得懂），但標題既不保證唯一也不保證合法——
  // ① schema 只驗標題非空、不驗重複，兩個同名步驟並行時會算出同一個絕對路徑，
  //    後一步的 artifactOf 只比 {size, mtimeMs}，會把前一步剛寫好的檔案認成自己的成品送去查核；
  // ② 標題結尾有句點會算出「名字..副檔名」，被 safeFileName 的 '..' 檢查擋掉，而且是在 AI 已經跑完、
  //    錢已經花掉之後才炸，重試永遠失敗到使用者自己去改標題為止（2026-09-18 審查）。
  // 只有真的撞名才加 id 後綴，單獨的標題維持原本的檔名，不動既有紀錄。
  // 撞名要比「算出來的檔名」不是比標題：淨化會把 / : ? * 換成底線、砍掉結尾句點，
  // 所以「月報/初稿」與「月報_初稿」、「月報.」與「月報」標題不同卻算出同一個檔名——
  // 比標題的話 dup 是 false、不加後綴，上面 ① 那個病原封不動（2026-09-18 二次審查）。
  const artifactBase = (node) => String(node.title ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/[.\s]+$/, '')
    .trim() || node.id;
  function artifactName(nodes, node, ext) {
    const base = artifactBase(node);
    const dup = (nodes ?? []).some((n) => n.id !== node.id && artifactBase(n) === base);
    return `${dup ? `${base}-${node.id}` : base}.${ext}`;
  }

  // D19：步驟輸出存成檔案。TIER2 未接工具鏈→降級 .md 並在 step.file_note 講明；有範本先填範本（{{參數}}＋{{output}}）
  function saveArtifact(category, id, runId, node, params, step, output, opts = {}) {
    if (!node.output_file && !node.template_file) return;
    let ext = node.output_file ?? (node.template_file.includes('.') ? node.template_file.split('.').pop() : 'md');
    if (OUTPUT_OFFICE.includes(ext)) {
      // Word／Excel 真檔由工人在產出資料夾做；走到這裡＝流程沒開產檔權限、或工人沒交出檔案 → 文字產出先存成 .md
      step.file_note = opts.officeNote ?? `這條 Workflow 沒開產檔權限——.${ext} 先存成 .md；Workflow 頁打開「允許這條 Workflow 產出檔案」就會產真檔`;
      ext = 'md';
    } else if (OUTPUT_TIER2.includes(ext)) {
      step.file_note = `.${ext} 的工具鏈這台還沒接——先存成 .md，內容已照你的格式要求`;
      ext = 'md';
    }
    let content = output ?? '';
    if (node.template_file) {
      try {
        const tpl = store.readRefText(category, id, node.template_file);
        // {{output}} 先換成佔位符，免得被參數代入當成不存在的參數吃掉
        content = injectParams(tpl.replaceAll('{{output}}', '\\u0000OUT\\u0000'), params).replaceAll('\\u0000OUT\\u0000', content);
      } catch {
        step.file_note = `範本「${node.template_file}」讀不到——先存原始產出`;
      }
    }
    step.file = store.writeArtifact(category, id, runId, artifactName(opts.nodes, node, ext), content);
  }
  function update(c, i, r, fn) {
    const run = load(c, i, r);
    fn(run);
    store.writeRun(c, i, r, run);
    return run;
  }

  const choicesOf = (run) => {
    const m = {};
    for (const n of run.def.nodes) {
      if (nodeKind(n) === 'branch' && run.steps[n.id].choice) m[n.id] = run.steps[n.id].choice;
    }
    return m;
  };

  // 節點的上游輸入：沿路全部祖先 task（非跳過、完成、有效產出非空）的產出，最近在前；
  // 並行點／分岔天生不在清單（過濾 task）、同一步只出現一次（ancestorIds 的 seen）。
  // 一個祖先＝原文不加標頭（現況）；兩個以上＝前言＋每段【步驟名】，超過 UPSTREAM_CAP 由遠而近整段丟、記名。
  function upstreamText(run, nodeId, skipped, predMap) {
    const byId = new Map(run.def.nodes.map((n) => [n.id, n]));
    const parts = ancestorIds(run, nodeId, livePreds(run, predMap))
      .filter((p) => byId.has(p) && nodeKind(byId.get(p)) === 'task' && !skipped.has(p) && run.steps[p]?.status === 'done')
      .map((p) => ({ title: byId.get(p).title, text: effectiveOutput(run.steps[p]) }))
      .filter((x) => x.text)
      .reverse();
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0].text;
    return capUpstream(parts, UPSTREAM_CAP);
  }

  // 查核要看的原始資料之一——所有祖先任務步驟的有效產出（拓樸序；結構節點與空產出不列）
  function ancestorsOf(run, nodeId, predMap) {
    const byId = new Map(run.def.nodes.map((n) => [n.id, n]));
    return ancestorIds(run, nodeId, livePreds(run, predMap))
      .filter((p) => byId.has(p) && nodeKind(byId.get(p)) === 'task')
      .map((p) => ({ title: byId.get(p).title, text: effectiveOutput(run.steps[p] ?? {}) }))
      .filter((x) => x.text);
  }

  // 上游停點改過後擬出來的規則，只有 scope='all' 的往下游帶（自己那一步不吃自己的）
  function editRulesFor(run, nodeId, predMap) {
    return ancestorIds(run, nodeId, livePreds(run, predMap))
      .flatMap((p) => run.steps[p]?.edit_rules ?? [])
      .filter((rule) => rule && rule.scope === 'all');
  }

  // 資料不全診斷：缺口從接線與各步現況算出來，不猜——給卡片指名「該去改哪一步」
  function diagnoseData(run, node) {
    const src = inputSources(run.def)[node.id] ?? [];
    const byId = new Map(run.def.nodes.map((n) => [n.id, n]));
    const emptyHuman = src.find((s) => s.kind === 'human' && !effectiveOutput(run.steps[s.id] ?? {}));
    if (emptyHuman) {
      const h = byId.get(emptyHuman.id);
      return {
        reason: `缺的資料應該來自「${h.title}」（你來做）——它交出的內容是空的`,
        suggestion: `在「${h.title}」完成時交出內容；或把資料做成設定欄位，在「${node.title}」的指示裡引用`,
        fix: { kind: 'node', id: h.id },
      };
    }
    const skeleton = src.find((s) => s.kind === 'upstream' && /^【已標注資料不全/.test(effectiveOutput(run.steps[s.id] ?? {})));
    if (skeleton) {
      const u = byId.get(skeleton.id);
      return {
        reason: `上一步「${u.title}」本身是帶「資料不全」標注的骨架，缺口在更前面`,
        suggestion: `回到「${u.title}」補資料重跑，不要在這一步硬補`,
        fix: { kind: 'node', id: u.id },
      };
    }
    if (!src.length) {
      return {
        reason: '這是第一步，沒有任何輸入來源',
        suggestion: `把資料做成設定欄位並在「${node.title}」的指示裡引用，或掛參考檔`,
        fix: { kind: 'node', id: node.id },
      };
    }
    return {
      reason: `上一步有交，但 AI 認為不夠：${run.steps[node.id]?.data_note ?? ''}`,
      suggestion: '按「我補給你」貼上缺的那部分重跑；常缺的就把它做成設定欄位',
      fix: null,
    };
  }

  // 判路（原 judgeBranch）：分岔的選路併進監工的交接——route＝選項編號字串，
  // 對不到或監工判斷不了就回 null，由 launch 轉 waiting_branch 停下問人
  function routeViaHandoff(node, afterHandoff) {
    const route = afterHandoff.steps[node.id].handoff?.route ?? null;
    return route === null ? null : (node.branches[Number(route) - 1] ?? null);
  }

  // 參考檔（三層共用檔）：attachments 元素＝字串（流程層 files/）｜{scope, name}（公司／部門共用夾 files/）；
  // 路徑各對各層、顯示名與鍵一律 attName（「名稱（公司）」）——同名檔各層各存各的，鍵不能撞
  const rawName = (a) => (typeof a === 'string' ? a : String(a?.name ?? ''));
  const attPath = (category, id, a) => (typeof a === 'string' ? store.refFilePath(category, id, a) : store.sharedFilePath(scopeKey(a.scope, category), a.name));

  // 監工開場要看的參考檔：全部節點 attachments 的聯集，讀得出純文字的給原文，其餘只留檔名
  function briefRefTexts(category, id, def) {
    const out = {};
    const seen = new Set();
    for (const a of def.nodes.flatMap((n) => n.attachments ?? [])) {
      const key = attName(a);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!REF_TEXT_EXTS.includes(rawName(a).split('.').pop()?.toLowerCase())) continue;
      try {
        const fp = attPath(category, id, a);
        if (fp) out[key] = fs.readFileSync(fp, 'utf8');
      } catch { /* 讀不到就只列名字 */ }
    }
    return out;
  }

  // （三層共用檔）：開跑時鎖版本——把公司與部門的規範全文快照進 run.shared（每層上傳時已擋 8,000 字），
  // 整趟每一步都讀這份、續跑不重算；跑到一半有人換了手冊，這一趟仍用開跑那份。某層讀不到＝那層不帶（留一句），run 照建
  function sharedSnapshot(category) {
    const read = (scope) => {
      try { return store.readSharedRuleTexts(scope).map(({ name, chars, text }) => ({ name, chars, text })); } catch (e) {
        console.error(`[bojian] 共用夾「${scope}」的規範讀不到，這趟不帶：`, e.message);
        return [];
      }
    };
    return { at: new Date().toISOString(), company: read('_company'), dept: read(category) };
  }

  // 等時刻解析：固定字串直接解；{from} 讀上游步驟產出的「WHEN: 時刻」行（動態時刻，D20）
  function resolveWaitUntil(node, run) {
    const w = node.wait_until;
    if (typeof w === 'string') {
      const d = parseWhen(w);
      return d ? { ok: true, at: d } : { ok: false, reason: `時刻「${w}」看不懂` };
    }
    const src = run.steps[w.from];
    const srcNode = run.def.nodes.find((n) => n.id === w.from);
    if (!src || src.status !== 'done') return { ok: false, reason: `要等「${srcNode?.title ?? w.from}」先完成才知道時間` };
    const text = effectiveOutput(src);
    const matches = [...text.matchAll(/WHEN[:：]\s*(.+)/gi)];
    const line = matches.at(-1); // 取最後一個匹配（協定要求標在末行；中段舉例出現的不作數）
    const d = parseWhen(line ? line[1] : text);
    if (!d) return { ok: false, reason: `「${srcNode?.title ?? w.from}」的產出裡找不到確定的時間` };
    if (d.getTime() < now()) return { ok: false, reason: `解析出的時間（${line ? line[1].trim() : ''}）已經過去了——請確認` };
    // 綁定事件：來源步若標了 EVENT_ID（它建立的 Google 事件），一併帶回給等時刻步
    const ev = [...text.matchAll(/EVENT_ID[:：]\s*(\S+)/gi)].at(-1);
    return { ok: true, at: d, linkedEventId: ev ? ev[1] : null };
  }

  // 前一趟的 id：清單尾端最多 5 筆逐一讀 started_at，取最晚的（同時刻取 id 字典序較後者）；讀不到的跳過、本趟排除
  function latestRunId(category, id, selfId) {
    let best = null;
    for (const rid of store.listRuns(category, id).slice(-5)) {
      if (rid === selfId) continue;
      let at;
      try { at = String(store.readRun(category, id, rid)?.started_at ?? ''); } catch { continue; }
      if (!best || at >= best.at) best = { rid, at };
    }
    return best?.rid ?? null;
  }

  return {
    startRun(category, id, overrides = {}, opts = {}) {
      const def = store.readWorkflow(category, id);
      validateWorkflow(def);
      const params = {};
      for (const p of def.params) {
        const v = overrides[p.key];
        const empty = v === undefined || v === null || String(v).trim() === '';
        // 上傳欄位不准退回 default：default 常是「轉成上傳欄位之前」留下的說明文字（schema 不禁止非空 default，
        // UI 勾「每次上傳檔案」也不清空它）。一退回，下面那道必填檔守門就永遠打不到——排程照跑、
        // runInputPath 找不到檔靜默回 null 被濾掉，AI 在零資料下寫出一份標著「完成」的報告（2026-09-18 審查）
        params[p.key] = empty ? (p.input === 'file' ? '' : p.default) : v;
      }
      // 必填的上傳欄位沒有檔＝不開跑（排程／通知「照跑」沒辦法替你上傳；呼叫端把這句發成通知）
      const noFile = def.params.find((p) => p.input === 'file' && p.required === true && !String(params[p.key] ?? '').trim());
      if (noFile) throw new Error(`「${noFile.label}」每次開跑都要上傳一個檔，這一趟沒有檔——排程沒辦法替你上傳，請到 Workflow 的「本次資料」選檔後按開始`);
      // 前一趟（記路①「開跑同值連兩趟」與記路②「停點連兩趟」都對它比）——不限狀態，依 started_at 判：
      // run id 同秒只差亂數尾碼，字典序不等於先後，所以尾端幾筆逐一讀開跑時間取最晚的
      const runId = store.newRunId();
      const prevId = latestRunId(category, id, runId);
      const picks = opts.memoryPicks && typeof opts.memoryPicks === 'object' ? opts.memoryPicks : {};
      const run = {
        run_id: runId,
        workflow: { category, id, name: def.name },
        def, // 定義快照：退版時進行中的 run 用舊版跑完（Error Map）
        status: 'running',
        source: opts.source ?? 'manual', // manual｜schedule
        makeup: opts.makeup === true || undefined, // 錯過補跑標記（行事曆標「補」）
        params,
        ...(typeof opts.note === 'string' && opts.note.trim() ? { note: opts.note } : {}), // 本次補充；沒有＝不加鍵（舊 run 形狀不變）
        // 本次附件＝檔案版的本次補充（不綁欄位，這一趟每個 AI 步驟都看得到）；檔名由 store.claimUpload 洗過，這裡只記名
        ...(Array.isArray(opts.runFiles) && opts.runFiles.some((x) => typeof x === 'string' && x)
          ? { run_files: opts.runFiles.filter((x) => typeof x === 'string' && x) } : {}),
        started_at: new Date().toISOString(),
        finished_at: null,
        shared: sharedSnapshot(category), // 三層共用檔：兩層規範的開跑快照（鎖版本）；舊 run 沒有這欄＝不帶
        // （M2）：開跑表單點了哪些習慣卡（欄位 key→卡 id）、點了又改掉的、帶哪個身分；通知由門面寫
        memory: {
          identity: typeof opts.memoryIdentity === 'string' && opts.memoryIdentity ? opts.memoryIdentity : null,
          picks: Object.fromEntries(Object.entries(picks).filter(([, v]) => typeof v === 'string' && v)),
          changed: Array.isArray(opts.memoryChanged) ? opts.memoryChanged.filter((x) => typeof x === 'string' && x) : [],
          prev_run: prevId,
          notices: [],
        },
        steps: Object.fromEntries(
          def.nodes.map((n) => [n.id, {
            status: 'pending', output: null, edited_output: null, edit_note: null,
            feedback: null, error: null, choice: null, choice_by: null, choice_label: null,
            supplied_input: null, data_diagnosis: null, // 補資料／資料不全診斷
          }]),
        ),
      };
      store.writeRun(category, id, run.run_id, run);
      if (!memory) return run;
      // 記路①：門面自己讀寫卡與通知（同步）；炸了只留一句，run 照建。回存好的那份——門面可能剛加了通知
      try {
        memory.onRunStart({ category, id, run, prevRun: prevId ? load(category, id, prevId) : null });
      } catch (e) {
        console.error('[bojian] 記憶（開跑）沒記成：', e.message);
      }
      return load(category, id, run.run_id);
    },

    // 推進到「沒有可自動前進的事」為止：全完→done、有等待/失敗→paused
    async runUntilPause(category, id, runId) {
      const inflight = new Map(); // nodeId → promise（本次呼叫內的併發登記）
      let run = load(category, id, runId);
      const def = run.def; // 定義快照，整趟不變——labels／predMap／監工開關都只算一次
      const labels = Object.fromEntries((def.params ?? []).map((p) => [p.key, p.label])); // 長欄位提示語要用的欄位標籤
      const predMap = predecessors(def);
      // 本次上傳的檔（runs/<rid>/in/）只掛給沒有 AI 祖先的 AI 步驟；舊 run／沒有上傳欄位＝空
      const uploadFiles = def.params?.some((p) => p.input === 'file') ? def.params.filter((p) => p.input === 'file').map((p) => {
        try { return run.params?.[p.key] ? store.runInputPath(category, id, runId, run.params[p.key]) : null; } catch { return null; }
      }).filter(Boolean) : [];
      const uploadReaderIds = new Set(uploadFiles.length ? uploadReaders(def) : []);
      const uploadsFor = (node) => (uploadReaderIds.has(node.id) ? uploadFiles : []);
      // 本次附件（run.run_files）不綁欄位，比照「本次補充」每個 AI 步驟都看得到；舊 run 沒這欄＝空
      const runFiles = (run.run_files ?? []).map((n) => {
        try { return store.runInputPath(category, id, runId, n); } catch { return null; }
      }).filter(Boolean);
      const supervisorOn = def.supervisor?.enabled !== false; // 監工缺省＝開（只管備註、派工、紀錄；判路不歸它管）
      // 全域設定：節點沒設的檔位／重試／查網用它補；讀不到＝程式缺省
      let settings = {};
      try { settings = store.readSettings(); } catch (e) { console.error('[bojian] 設定檔讀不到，用程式缺省：', e.message); }
      // （M3a）：這趟每一步要帶的關於你、群組規矩、被選的習慣卡——整趟算一次（卡、群組、欄位值都是趟級的）；
      // 讀不到＝當沒有卡：工作單不多段、不寫 steps[].memory，流程照跑
      let memoryCtx = null;
      try {
        if (memory?.contextFor) memoryCtx = memory.contextFor({ category, id, def, params: run.params, identity: run.memory?.identity ?? null, picks: run.memory?.picks ?? {}, settings });
      } catch (e) { console.error('[bojian] 記憶（每步要帶的）讀不到，這趟不帶：', e.message); }
      // 三層共用檔：規範只從 run.shared（開跑快照）拿，不從硬碟、不從 memory.contextFor——續跑也鎖在開跑那版；
      // 舊 run 沒有 shared＝不帶、工作單不多段。給工人與查核員 [{name,text}]，給 steps[].memory.shared 記 [{name,chars}]。
      // 「關於你」暫停（settings.memory.paused）不影響規範：暫停關的是個人記憶，公司規範照帶
      const sharedRules = { company: run.shared?.company ?? [], dept: run.shared?.dept ?? [] };
      const ruleArgs = (list) => list.map(({ name, text }) => ({ name, text: String(text ?? '') }));
      const ruleMeta = (list) => list.map(({ name, chars }) => ({ name, chars }));
      // 這一步勾的公司／部門參考檔（讀 index 取字數；不在共用夾的不算帶了）；讀不到＝當沒勾
      const sharedRefsOf = (node) => (node.attachments ?? []).filter((a) => a && typeof a === 'object').map((a) => {
        try {
          const f = store.readSharedIndex(scopeKey(a.scope, category)).files.find((x) => x.name === a.name);
          return f ? { scope: a.scope, name: a.name, chars: f.chars } : null;
        } catch { return null; }
      }).filter(Boolean);

      // 監工的歸戶欄位：kind 由 supervisor 強制成 'supervisor'，phase 與 node 由這裡給（帳本與卷宗都用 node 當鍵）
      const supMeta = (phase, node) => ({ phase, category, workflow: id, run: runId, node });
      const supNote = (name) => (text) => store.writePromptRecord(category, id, runId, name, text);

      // 接線點一（開場）：整趟只寫一次，第一步開跑前就位。監工掛掉＝備註留空、原因記人話，流程照跑。
      // 已經跑完的 run 一律不補寫——本功能上線前的舊 run 被 resume 或自癒路徑再 kick 一次時，
      // 沒有任何工人還會讀這份備註，白問一次監工、多寫一份卷宗而已
      if (supervisorOn && run.status !== 'done' && run.brief === undefined
        && def.nodes.some((n) => nodeKind(n) === 'task' && n.executor === 'ai')) {
        const res = await supervisorBrief({
          adapter,
          meta: supMeta('brief', '_brief'),
          onPrompt: supNote('_brief.txt'),
          onReply: supNote('_brief.reply.txt'),
          def,
          params: run.params,
          paramLabels: labels,
          refTexts: briefRefTexts(category, id, def),
        });
        const at = new Date().toISOString();
        run = update(category, id, runId, (r) => {
          r.brief = res.ok ? { text: res.text, at } : { text: '', at, fail_note: res.fail_note };
        });
      }

      // 接線點二（交接）：這一步開跑前，監工讀上一步成品與這一步設定寫一段交接；分岔節點的判路也走這條。
      // 一步只問一次——handoff 已經寫過（不管成不成）就沿用：回話重做、自動重試、補資料重跑都不重問。
      // 回傳「寫完交接的最新 run」：派工覆寫要讀它，讀 started（寫交接之前的快照）會讓覆寫只在重做時生效。
      const writeHandoff = async (node, kind, started) => {
        if (started.steps[node.id].handoff !== undefined) return started;
        const isBranch = kind === 'branch';
        const flags = isBranch ? BRANCH_FLAGS : supervisorFlags(node);
        const hasUpstream = (predMap.get(node.id) ?? []).length > 0; // 第一層步驟沒有上一步的成品可交接
        if (!isBranch && !(supervisorOn && hasUpstream && (flags.note || flags.tier || flags.tools))) return started;
        // 跨 await 前先取值——await 期間平行支會改寫同一份 run
        const byId = new Map(def.nodes.map((n) => [n.id, n]));
        const ups = (livePreds(started, predMap).get(node.id) ?? [])
          .filter((p) => started.steps[p]?.status === 'done')
          .map((p) => ({ title: byId.get(p)?.title ?? p, text: effectiveOutput(started.steps[p]) }))
          .filter((u) => u.text);
        const priors = def.nodes
          .filter((n) => n.id !== node.id && started.steps[n.id]?.handoff?.text)
          .map((n) => ({ title: n.title, text: started.steps[n.id].handoff.text }));
        const pending = []; // 未消化的插話：連位置一起記，寫回時才標得準（await 期間可能又多了新的）
        (started.interjections ?? []).forEach((x, i) => { if (!x.consumed) pending.push({ i, text: x.text }); });
        const res = await supervisorHandoff({
          adapter,
          meta: supMeta('handoff', node.id),
          onPrompt: supNote(`${node.id}.handoff.txt`),
          onReply: supNote(`${node.id}.handoff.reply.txt`),
          node,
          flags,
          routeOptions: isBranch ? node.branches.map((b) => ({ label: b.label })) : [],
          brief: started.brief?.text ?? '',
          priorHandoffs: priors,
          rules: editRulesFor(started, node.id, predMap).map((rule) => rule.text),
          interjections: pending.map((x) => x.text),
          upstream: ups,
        });
        const at = new Date().toISOString();
        return update(category, id, runId, (r) => {
          r.steps[node.id].handoff = {
            text: res.ok ? res.text : '',
            tier: res.ok ? res.tier : null,
            web: res.ok ? res.web : null,
            route: isBranch && res.ok ? res.route : null, // task 節點沒有路可選，route 一律不收
            at,
            ...(res.ok ? {} : { fail_note: res.fail_note }),
            ...(isBranch && !supervisorOn ? { only_route: true } : {}), // 監工關掉時分岔只剩判路，介面不顯示
          };
          // 分岔只選路，沒有工人會讀它的交接——插話給它看（可能影響選路），但不算已經交代出去；
          // 算掉的話，使用者在停點講的話會被中間的分岔吃掉，真正做事的下一步反而看不到
          if (!isBranch) for (const x of pending) { if (r.interjections?.[x.i]) r.interjections[x.i].consumed = true; }
        });
      };

      const launch = (node, kind, upstream, params, labels, needsWhen = false, filePermitted = false) => {
        const p = (async () => {
          const started = update(category, id, runId, (r) => { r.steps[node.id].status = 'running'; r.steps[node.id].error = null; });
          try {
            const afterHandoff = await writeHandoff(node, kind, started); // 監工交接／判路：一步只問一次
            if (kind === 'branch') {
              const hit = routeViaHandoff(node, afterHandoff);
              update(category, id, runId, (r) => {
                const s = r.steps[node.id];
                s.check = noCheck('skipped'); // 分岔只選路、不產內容，沒東西可查
                if (hit) {
                  s.status = 'done';
                  s.choice = hit.next;
                  s.choice_by = 'ai';
                  s.choice_label = hit.label;
                  s.output = ''; // 分岔只選路不轉運：下游直接拿祖先 task 的產出
                } else {
                  s.status = 'waiting_branch';
                }
              });
            } else {
              const TIER_MODEL = { fast: 'haiku', balanced: 'sonnet', deep: 'opus' }; // 檔位→宿主型號別名
              // 派工覆寫：三個勾是授權——沒勾的欄位監工就算寫了值也不算數，一律回節點自己的設定
              const flags = supervisorFlags(node);
              const h = afterHandoff.steps[node.id].handoff ?? {};
              const sink = new Map(); // 本次呼叫收集到的長欄位值，交給 buildPrompt 的「欄位內容」段（同一 key 跨欄位共用，只收一次）
              const injLong = (s) => (s ? injectParams(s, params, { labels, sink }) : '');
              const editRules = editRulesFor(started, node.id).map((rule) => rule.text); // 上游停點改過後留給後面每一步的要求
              const checkOn = started.def.check?.enabled !== false; // 缺省＝開（跨 await 前先取值，不留著整份 run）
              const factsOff = started.def.check?.facts === false; // 流程關掉「數字對原始資料」→ 不組原始資料，只對必守與格式
              // 輸出規格四面向＋補充＋檔案格式合成一段格式要求
              const fmtParts = [];
              if (node.output_type) fmtParts.push(`類型：${injLong(node.output_type)}`);
              if (node.output_structure) fmtParts.push(`結構：${injLong(node.output_structure)}`);
              if (node.output_length) fmtParts.push(`份量：${injLong(node.output_length)}`);
              if (node.output_tone) fmtParts.push(`語言與語氣：${injLong(node.output_tone)}`);
              if (node.output_format) fmtParts.push(injLong(node.output_format));
              // Word／Excel／簡報且流程開了產檔權限 → 工人在產出資料夾產真檔（fileMode）；沒開或 pdf → 文字產出降級 .md
              const officeExt = OUTPUT_OFFICE.includes(node.output_file) ? node.output_file : null;
              const makesFile = !!(officeExt && filePermitted);
              if (node.output_file) {
                const eff = OUTPUT_TIER2.includes(node.output_file) || (officeExt && !filePermitted) ? 'md' : node.output_file;
                const extNote = { csv: '內容必須是合法 CSV 純文字', json: '內容必須是合法 JSON', html: '輸出一份完整可直接開啟的 HTML' }[eff];
                fmtParts.push(makesFile ? `成品是 .${eff} 真檔（照下方「產檔規則」寫檔）；這裡的文字產出＝檔案內容摘要` : `最終會存成 .${eff} 檔${extNote ? `——${extNote}` : ''}`);
              }
              // 有下游步驟等這一步的時間（wait_until.from，D20）→ 要求末行標 WHEN；建了行事曆事件另標 EVENT_ID
              if (needsWhen) fmtParts.push('若內容包含敲定的日期時間，最後一行必須單獨寫「WHEN: YYYY-MM-DDTHH:mm」標出那個時間；若你有建立 Google 行事曆事件，另起一行寫「EVENT_ID: 事件的唯一識別」');
              const callArgs = {
                nodeId: node.id,
                title: node.title,
                instruction: injLong(node.instruction),
                roleContext: injLong(node.role_context),
                background: injLong(node.background),
                constraints: injLong(node.constraints),
                examples: injLong(node.examples),
                outputFormat: fmtParts.join('\n'),
                creativity: node.creativity ?? '',
                reviewFocus: injLong(node.review_focus),
                model: TIER_MODEL[(flags.tier && h.tier) || node.model_tier || settings.defaults?.model_tier] ?? '', // 節點沒設檔位→全域設定的預設
                web: settings.exec?.web === false ? false : (flags.tools ? (h.web ?? true) : true), // 設定關了查網＝一律關；否則沒勾開關查網＝照舊開著
                supervisorNotes: [
                  started.brief?.text ? `開場：${started.brief.text}` : null,
                  h.text ? `交接：${h.text}` : null,
                ].filter(Boolean),
                // 同心圓的核心圈與群組圈（外圈蓋內圈已算完）；被選的習慣卡不另成段——值已在 run.params 裡代進句子
                coreNotes: memoryCtx?.coreNotes ?? [],
                groupRules: memoryCtx?.groupRules ?? [],
                groupName: memoryCtx?.groupName ?? category,
                // 三層共用檔：公司／部門規範（開跑快照，每步都帶）；參考檔路徑各對各層（字串＝流程層、{scope}＝共用夾）
                companyRules: ruleArgs(sharedRules.company),
                deptRules: ruleArgs(sharedRules.dept),
                // 本次附件併進檔案清單（每步都在），逐欄上傳照舊只給引用該欄位的步驟
                attachments: [...(node.attachments ?? []).map((a) => attPath(category, id, a)).filter(Boolean), ...uploadsFor(node), ...runFiles],
                upstream,
                paramBlocks: [...sink.values()], // 長欄位值原文，buildPrompt 另開「欄位內容」段
                editRules, // 上游停點改出來的規則，工人與查核員都當必守
                // 用量帳本的歸戶欄位；mcp＝輕裝連接器例外：下游要等這步敲的時間，這步就得看得到行事曆
                meta: { kind: 'step', category, workflow: id, run: runId, node: node.id, ...(needsWhen ? { mcp: 'calendar' } : {}) },
              };
              // 回話重做：使用者在查核卡寫的話＋上一次的退回清單，一起帶回給工人。
              // 只在「他剛回完話」且「上一次真的被攔下」時生效——check_note 是永久紀錄，
              // 之後為別的原因重跑（例如補完資料）不能再拿那句話與舊的退回清單去指揮工人
              const retryNote = started.steps[node.id].check_note_pending === true && started.steps[node.id].check?.status === 'blocked';
              if (retryNote) {
                const last = started.steps[node.id].check ?? {};
                callArgs.checkNote = started.steps[node.id].check_note;
                if (last.blocks?.length || last.missing?.length) callArgs.redo = { blocks: last.blocks ?? [], missing: last.missing ?? [] };
              }
              if (makesFile) {
                callArgs.fileMode = {
                  cwd: store.runOutDir(category, id, runId),
                  fileName: artifactName(started.def.nodes, node, officeExt),
                  templatePath: node.template_file ? (store.refFilePath(category, id, node.template_file) ?? null) : null,
                };
              }
              // （M3a）：這一步實際帶進工作單的＝關於你＋群組條（蓋掉的不算）＋這一步引用到的欄位所選的習慣卡。
              // 寫在 deliver 之前——停點卡在跑到一半就要顯示「這步用了 N 條」；分岔、人做、並行點不走這裡，天生沒有
              // 三層共用檔：memory.shared＝這步帶了哪幾份規範與共用參考（執行頁「帶了公司規範 N 份…」）；沒接記憶門面、
              // 也沒任何規範或共用參考＝不多寫（舊行為、舊 run 原樣）
              const sharedRefs = sharedRefsOf(node);
              const hasShared = sharedRules.company.length > 0 || sharedRules.dept.length > 0 || sharedRefs.length > 0;
              if (memoryCtx || hasShared) {
                const keys = new Set([...INJECTED_FIELDS.map((f) => String(node[f] ?? '')).join('\n').matchAll(PARAM_REF)].map((m) => m[1]));
                const picked = memoryCtx ? Object.entries(memoryCtx.picks ?? {}).filter(([k]) => keys.has(k)).map(([, c]) => c) : [];
                const snap = memoryCtx
                  ? { at: new Date().toISOString(), cards: [...memoryCtx.cards, ...picked], overridden: memoryCtx.overridden, paused: memoryCtx.paused }
                  : { at: new Date().toISOString(), cards: [], overridden: [], paused: false };
                if (run.shared) snap.shared = { company: ruleMeta(sharedRules.company), dept: ruleMeta(sharedRules.dept), refs: sharedRefs };
                update(category, id, runId, (r) => {
                  r.steps[node.id].memory = structuredClone(snap);
                });
              }
              // 卷宗：送出前把指示全文存進本次執行資料夾——renderPrompt 與實際送出走同一函式
              try { if (adapter.renderPrompt) store.writePromptRecord(category, id, runId, `${node.id}.txt`, adapter.renderPrompt(callArgs)); } catch { /* 卷宗寫不進不擋執行 */ }
              // 單步自動重試：失敗先自動重來 retry 次，用盡才停下問人；節點沒設→全域設定的預設（只認 1、2）
              const deliver = async (args) => {
                const extra = node.retry ?? settings.defaults?.retry;
                const tries = 1 + (Number.isInteger(extra) && extra > 0 ? extra : 0);
                for (let attempt = 1; ; attempt++) {
                  try {
                    return await adapter.executeNode(args);
                  } catch (e) {
                    if (attempt >= tries) throw e;
                  }
                }
              };
              // 產檔步驟交出的真檔：查核要它的文字、attempts 要它的大小；沒交出＝null
              // 重做／回話重做時上一輪的舊檔還躺在產出夾——交卷前先記下它的 {size, mtimeMs}，
              // 交卷後沒變＝這次的工人根本沒重寫，那份不算這次的成品（不然會拿舊檔去查、還記成 redo-pass）
              const artifactSnap = () => {
                const name = callArgs.fileMode?.fileName;
                return name ? store.artifactStat(category, id, runId, name) : null;
              };
              const artifactOf = (before) => {
                const name = callArgs.fileMode?.fileName;
                if (!name) return null;
                const after = store.artifactStat(category, id, runId, name);
                if (!after) return null;
                if (before && after.size === before.size && after.mtimeMs === before.mtimeMs) return null;
                try {
                  const buf = store.readArtifact(category, id, runId, name);
                  return { name, size: buf.length, buf };
                } catch { return null; }
              };
              let refTexts = null; // 參考檔文字只抽一次，重做時重用
              const attachmentTexts = async () => {
                if (refTexts) return refTexts;
                refTexts = [];
                for (const a of node.attachments ?? []) {
                  const fp = attPath(category, id, a); // 三層共用檔：字串＝流程層、{scope}＝共用夾；鍵標層（「名稱（公司）」）
                  if (!fp) continue;
                  try {
                    const text = await extractFileText(fs.readFileSync(fp), rawName(a));
                    if (text) refTexts.push({ name: attName(a), text });
                  } catch { /* 讀不到的參考檔跳過，不擋查核 */ }
                }
                // 本次上傳也是查核的原始資料；本次附件同理（每步都查得到）
                for (const [fp, tag] of [...uploadsFor(node).map((f) => [f, '這次上傳']), ...runFiles.map((f) => [f, '這次附件'])]) {
                  try {
                    const name = path.basename(fp);
                    const text = await extractFileText(fs.readFileSync(fp), name);
                    if (text) refTexts.push({ name: `${name}（${tag}）`, text });
                  } catch { /* 讀不到跳過 */ }
                }
                return refTexts;
              };
              // 交貨查核：拿原始資料、使用者的要求、停點規則對照成品；查核本身失敗不擋交貨
              // nth＝這一步查的第幾份成品（1＝第一次、2＝重做那份），卷宗編號與工人那兩份（.txt／.redo1.txt）一一對應
              const checkDelivery = async (out, art, nth) => {
                if (!checkOn) return noCheck('off');
                if (SHORTFALL.test(out ?? '')) return noCheck('skipped'); // 自報資料不全已經走資料不全卡，不重複問
                let product = out ?? '';
                if (art && OUTPUT_OFFICE.some((e) => art.name.toLowerCase().endsWith(`.${e}`))) {
                  const text = await extractFileText(art.buf, art.name);
                  if (!text) return { ...noCheck('incomplete'), note: '成品檔讀不出來，這次沒查', attempts: 1 };
                  product = text;
                }
                const snap = load(category, id, runId);
                const res = await runCheck({
                  adapter,
                  meta: callArgs.meta,
                  title: node.title,
                  requirements: {
                    instruction: callArgs.instruction,
                    constraints: callArgs.constraints,
                    reviewFocus: callArgs.reviewFocus,
                    outputFormat: callArgs.outputFormat,
                    editRules,
                    groupRules: callArgs.groupRules, // 群組規矩也是必守（同一份，不重組）
                    companyRules: callArgs.companyRules, // 三層共用檔：必守第四路（同一份開跑快照，不重組）
                    deptRules: callArgs.deptRules,
                    supervisorNotes: callArgs.supervisorNotes, // 開場＋交接，查核員當參考不當必守（同一份，不重組）
                    factsOff,
                  },
                  // 沒開「數字對原始資料」就整段不組——連參考檔都不讀
                  sources: factsOff ? '' : buildSources({
                    params,
                    paramLabels: labels,
                    ancestors: ancestorsOf(snap, node.id),
                    supplied: snap.steps[node.id]?.supplied_input ?? '',
                    attachments: await attachmentTexts(),
                  }),
                  product,
                  // 卷宗：查核員的指示也存全文（存的＝送出的）；寫不進由 checker 吞掉，不擋查核
                  onPrompt: (prompt) => store.writePromptRecord(category, id, runId, `${node.id}.check${nth}.txt`, prompt),
                });
                // 沒查成時連查核員的回覆原文一起進卷宗（補件）：只存指示的話，「這次沒查成」事後查不出為什麼。
                // raw 不進 run 紀錄——那份回覆可能好幾萬字，卷宗才是放全文的地方
                const { raw, ...kept } = res;
                if (kept.status === 'incomplete' && raw) {
                  try { store.writePromptRecord(category, id, runId, `${node.id}.check${nth}.reply.txt`, raw); } catch { /* 卷宗寫不進不擋查核 */ }
                }
                return { ...kept, attempts: 1 };
              };
              // 每次交卷都推一筆：永不覆蓋，重做與回話重做都看得到
              const pushAttempt = (reason, out, art, ck) => update(category, id, runId, (r) => {
                const s = r.steps[node.id];
                if (reason === 'retry-note') s.check_note_pending = false; // 話帶到了就用掉，話本身留著當紀錄
                (s.attempts ??= []).push({
                  at: new Date().toISOString(),
                  reason,
                  output: out ?? null,
                  ...(art ? { file: { name: art.name, size: art.size } } : {}),
                  check: { status: ck.status, blocks: ck.blocks, flags: ck.flags },
                });
              });

              let before = artifactSnap();
              let output = await deliver(callArgs);
              let art = artifactOf(before);
              let check = await checkDelivery(output, art, 1);
              pushAttempt(retryNote ? 'retry-note' : 'first', output, art, check);
              // 攔到就自動退回重做一次再查；仍攔下才停下問人
              if (check.status === 'blocked') {
                const redoArgs = { ...callArgs, redo: { blocks: check.blocks, missing: check.missing }, meta: { ...callArgs.meta, attempt: 2 } };
                try { if (adapter.renderPrompt) store.writePromptRecord(category, id, runId, `${node.id}.redo1.txt`, adapter.renderPrompt(redoArgs)); } catch { /* 卷宗寫不進不擋執行 */ }
                before = artifactSnap();
                output = await deliver(redoArgs);
                art = artifactOf(before);
                const again = await checkDelivery(output, art, 2);
                check = { ...again, status: again.status === 'pass' ? 'redo-pass' : again.status, attempts: 2 };
                pushAttempt('redo', output, art, check);
              }
              update(category, id, runId, (r) => {
                const s = r.steps[node.id];
                const m = SHORTFALL.exec(output ?? '');
                s.check = check;
                if (m) {
                  // 自報協定：停該步、記缺什麼，等使用者三選一
                  s.data_note = m[1].trim();
                  s.output = m[2].trim() || null;
                  s.status = 'waiting_data';
                  s.data_diagnosis = diagnoseData(r, node);
                } else if (check.status === 'missing') {
                  // 查核發現缺的是原始資料本身（不是工人做壞）：不重做，走同一張資料不全卡
                  s.output = output;
                  s.data_note = `查核發現原始資料裡沒有：${check.missing.map((x) => x.claim).join('、')}`;
                  s.status = 'waiting_data';
                  s.data_diagnosis = diagnoseData(r, node);
                } else {
                  s.output = output;
                  s.status = check.status === 'blocked' ? 'waiting_check' : (node.stop_point === 'always' ? 'waiting_review' : 'done');
                  if (art) {
                    s.file = art.name; // 工人交出真檔
                    s.file_note = null;
                  } else if (callArgs.fileMode) {
                    saveArtifact(category, id, runId, node, r.params, s, output, { nodes: r.def.nodes, officeNote: `工人沒交出 .${officeExt} 檔——先把它的文字產出存成 .md，可按「重試這步」再來一次` });
                  } else {
                    saveArtifact(category, id, runId, node, r.params, s, output, { nodes: r.def.nodes });
                  }
                }
              });
            }
          } catch (e) {
            update(category, id, runId, (r) => {
              r.steps[node.id].status = 'failed';
              r.steps[node.id].error = e.message;
            });
          }
        })().finally(() => inflight.delete(node.id));
        inflight.set(node.id, p);
      };

      for (;;) {
        run = load(category, id, runId);
        if (run.status === 'done') return run;
        const skipped = computeSkipped(def, choicesOf(run));

        // 分岔選定後，未選支（含其下游）標 skipped
        if ([...skipped].some((s) => ['pending', 'running'].includes(run.steps[s].status))) {
          run = update(category, id, runId, (r) => {
            for (const s of skipped) {
              if (['pending', 'running'].includes(r.steps[s].status)) r.steps[s].status = 'skipped';
            }
          });
        }

        const ready = def.nodes.filter((n) => {
          const st = run.steps[n.id].status;
          if (skipped.has(n.id) || inflight.has(n.id)) return false;
          if (st !== 'pending' && st !== 'running') return false;
          const preds = predMap.get(n.id) ?? [];
          const settled = preds.every((p) => skipped.has(p) || ['done', 'skipped'].includes(run.steps[p].status));
          if (n.merge !== 'any') return settled;
          // 任一條到——開始過（記了 merge_from）就照舊可續跑；否則有一條線到了、或全部都已了結
          return Array.isArray(run.steps[n.id].merge_from) || settled || arrivedPreds(run, n.id, preds, skipped).length > 0;
        });
        // 任一條到的卡：開始當下已到的線記進 merge_from（只記一次）——之後才做完的線不再送進這張卡與它的下游，重試／續跑沿用
        const toMark = ready.filter((n) => n.merge === 'any' && !Array.isArray(run.steps[n.id].merge_from));
        if (toMark.length) {
          run = update(category, id, runId, (r) => {
            for (const n of toMark) r.steps[n.id].merge_from = arrivedPreds(r, n.id, predMap.get(n.id) ?? [], skipped);
          });
        }

        if (ready.length === 0) {
          if (inflight.size > 0) {
            await Promise.race(inflight.values());
            continue;
          }
          let final = update(category, id, runId, (r) => {
            if (r.status !== 'running') return;
            const allSettled = def.nodes.every((n) => ['done', 'skipped'].includes(r.steps[n.id].status));
            if (allSettled) {
              r.status = 'done';
              r.finished_at = new Date().toISOString();
            } else {
              r.status = 'paused';
            }
          });
          // 接線點三（收尾）：整趟跑完才寫執行紀錄，停點出口不碰。
          // 對應表與用量由程式從 run 與帳本整理（事實由程式給，監工才不會編），監工只負責翻人話＋指建議
          if (final.status === 'done' && supervisorOn && final.record === undefined) {
            const { table } = buildRecordTable({ run: final, usageRows: store.readUsage() });
            const outputs = def.nodes.map((n) => ({ title: n.title, text: effectiveOutput(final.steps[n.id] ?? {}) }));
            const res = await supervisorRecord({
              adapter,
              meta: supMeta('record', '_record'),
              onPrompt: supNote('_record.txt'),
              onReply: supNote('_record.reply.txt'),
              def,
              table,
              outputs,
            });
            // 用量重算一次：收尾這次呼叫自己的 token 在上面 await resolve 之前就進帳本了
            //（host-adapter 的 usageSink 在 resolve 前同步 append），先算會漏掉整趟最貴的一筆。
            // table 沿用送出去的那份——run 早就 done，內容不會變
            const { usage } = buildRecordTable({ run: final, usageRows: store.readUsage() });
            const at = new Date().toISOString();
            final = update(category, id, runId, (r) => {
              r.record = {
                at,
                table,
                text: res.ok ? res.text : `（${res.fail_note}）`,
                suggestions: res.ok ? res.suggestions : [],
                usage,
                ...(res.ok ? {} : { fail_note: res.fail_note }),
              };
            });
          }
          return final;
        }

        for (const node of ready) {
          const kind = nodeKind(node);
          // 等時刻：時間也是停點——到了才往下；動態時刻解析不出＝time_pending 轉待辦問人
          if (kind === 'task' && node.wait_until && !run.steps[node.id].time_ok) {
            const res = resolveWaitUntil(node, run);
            if (!res.ok) {
              run = update(category, id, runId, (r) => {
                r.steps[node.id].status = 'time_pending';
                r.steps[node.id].time_note = res.reason;
              });
              continue;
            }
            if (res.at.getTime() > now()) {
              run = update(category, id, runId, (r) => {
                r.steps[node.id].status = 'waiting_time';
                r.steps[node.id].wake_at = res.at.toISOString();
                if (res.linkedEventId) r.steps[node.id].linked_event_id = res.linkedEventId; // Google 側改期比對用
              });
              continue;
            }
            run = update(category, id, runId, (r) => { r.steps[node.id].time_ok = true; });
          }
          const baseUpstream = upstreamText(run, node.id, skipped, predMap);
          // 補資料：使用者在資料不全卡貼的內容排在前面，原本的上游照給——都給才是完整輸入
          const supplied = run.steps[node.id]?.supplied_input;
          const withSupplied = supplied
            ? `【你補的資料】\n${supplied}${baseUpstream ? `\n\n【上一步的產出】\n${baseUpstream}` : ''}`
            : baseUpstream;
          // 本次補充接在最後，每個 AI 步驟都看得到；adapter 段標題不動，寫在 upstream 字串裡；沒有補充＝逐字照舊
          const withNote = run.note ? `${withSupplied ? `${withSupplied}\n\n` : ''}【你這次的補充】\n${run.note}` : withSupplied;
          // 本次附件跟在補充後面，同樣每個 AI 步驟都看得到；沒有附件＝逐字照舊
          const upstream = runFiles.length
            ? `${withNote ? `${withNote}\n\n` : ''}【你這次的附件】\n這一趟另外上傳的檔（已在上面的參考檔案清單裡，逐一打開看）：\n${runFiles.map((p) => `- ${path.basename(p)}`).join('\n')}`
            : withNote;
          if (kind === 'fork' || kind === 'join') {
            // 結構節點即時完成：產出記空字串——沿路全帶後它不再是轉運站，下游直接拿祖先 task 的產出
            run = update(category, id, runId, (r) => {
              r.steps[node.id].status = 'done';
              r.steps[node.id].output = '';
              r.steps[node.id].check = noCheck('skipped'); // 並行點只是結構，沒有新東西可查
            });
          } else if (kind === 'task' && node.executor === 'human') {
            run = update(category, id, runId, (r) => {
              r.steps[node.id].status = 'waiting_human';
              r.steps[node.id].check = noCheck('skipped'); // 人做的東西不查
            });
          } else {
            const needsWhen = def.nodes.some((o) => o.wait_until && typeof o.wait_until === 'object' && o.wait_until.from === node.id);
            launch(node, kind, upstream, run.params, labels, needsWhen, run.def.permissions?.files === true); // task-ai 與 branch 併發跑
          }
        }
      }
    },

    // 停點核可：這步用原產出，繼續往下
    approve(category, id, runId, nodeId) {
      return update(category, id, runId, (r) => {
        const step = r.steps[nodeId];
        if (!step || step.status !== 'waiting_review') throw new Error(`步驟「${nodeId}」不在等待過目，無法核可`);
        step.status = 'done';
        r.status = 'running';
      });
    },

    // 停點修改：改過的版本進下游，並記下改了什麼（供之後優化引擎讀）。查核攔下時也能直接改（等於接受這份成品）
    // 這裡不動 run 的狀態：改完還要擬「後面每步要守的規則」，那段時間 run 要繼續停著——
    // 一翻成 running，UI 每秒的 GET 就會把下游放出去，下游在規則寫進檔案前開跑＝這次改的東西沒帶到。放行由 resume() 做。
    edit(category, id, runId, nodeId, editedOutput, note = null) {
      return update(category, id, runId, (r) => {
        const step = r.steps[nodeId];
        if (!step || !['waiting_review', 'waiting_check'].includes(step.status)) throw new Error(`步驟「${nodeId}」不在等待過目或查核攔下，無法修改`);
        if (step.status === 'waiting_check') step.check = { ...step.check, status: 'accepted' };
        step.edited_output = editedOutput;
        step.edit_note = note;
        step.status = 'done';
        const node = r.def.nodes.find((n) => n.id === nodeId);
        const isOffice = typeof step.file === 'string' && OUTPUT_OFFICE.some((e) => step.file.endsWith(`.${e}`));
        if (node && !isOffice) saveArtifact(category, id, runId, node, r.params, step, editedOutput, { nodes: r.def.nodes }); // 改過的版本蓋回檔案（Word／Excel 真檔不覆蓋——改的是摘要）
      });
    },

    // 停點處理完、該準備的都備妥了才放行：把「這步做完」跟「可以往下跑」分成兩個動作
    resume(category, id, runId) {
      return update(category, id, runId, (r) => { r.status = 'running'; });
    },

    // 插話：使用者在停點卡或查核卡交代的一句話，記著等下一次交接時交給監工消化。
    // 不推進流程——放行照樣走 resume／approve，這裡只負責把話留下來
    interject(category, id, runId, nodeId, text) {
      const said = typeof text === 'string' ? text.trim() : '';
      if (!said) throw new Error('要先寫一句要交代的話');
      return update(category, id, runId, (r) => {
        (r.interjections ??= []).push({ at: new Date().toISOString(), node: nodeId, text: said, consumed: false });
      });
    },

    // 人做步驟：標記完成，可附一句心得；content＝交給下一步的內容——成為這步的產出往下傳，留空就是 null
    completeHuman(category, id, runId, nodeId, feedback = null, content = null) {
      return update(category, id, runId, (r) => {
        const step = r.steps[nodeId];
        if (!step || step.status !== 'waiting_human') throw new Error(`步驟「${nodeId}」不是等待中的人做步驟`);
        step.feedback = feedback;
        step.output = typeof content === 'string' && content.trim() ? content : null;
        step.status = 'done';
        r.status = 'running';
      });
    },

    // 分岔判不出時由使用者選路
    chooseBranch(category, id, runId, nodeId, target) {
      return update(category, id, runId, (r) => {
        const node = r.def.nodes.find((n) => n.id === nodeId);
        const step = r.steps[nodeId];
        if (!node || nodeKind(node) !== 'branch' || !step || step.status !== 'waiting_branch') {
          throw new Error(`步驟「${nodeId}」不在等待選路`);
        }
        const hit = node.branches.find((b) => b.next === target);
        if (!hit) throw new Error(`「${target}」不是這個分岔的選項`);
        step.status = 'done';
        step.choice = hit.next;
        step.choice_by = 'user';
        step.choice_label = hit.label;
        step.output = ''; // 同 AI 選路：分岔不轉運
        r.status = 'running';
      });
    },

    // 資料不全：重抓一次
    dataRetry(category, id, runId, nodeId) {
      return update(category, id, runId, (r) => {
        const step = r.steps[nodeId];
        if (!step || step.status !== 'waiting_data') throw new Error(`步驟「${nodeId}」不在等待補資料`);
        step.status = 'pending';
        step.data_note = null;
        step.output = null;
        r.status = 'running';
      });
    },

    // 資料不全：就用現有的做，成品標注
    dataAccept(category, id, runId, nodeId) {
      return update(category, id, runId, (r) => {
        const step = r.steps[nodeId];
        if (!step || step.status !== 'waiting_data') throw new Error(`步驟「${nodeId}」不在等待補資料`);
        step.output = `【已標注資料不全：${step.data_note}】\n${step.output ?? ''}`;
        // 停點照舊生效（2026-09-19 真 AI 補驗輪實走抓到）：使用者按的是「用現有資料做」，
        // 不是「不用給我看」——這裡無條件標 done 會把 stop_point: always 的那一步整個跳過
        const node = (r.def?.nodes ?? []).find((n) => n.id === nodeId);
        step.status = node?.stop_point === 'always' ? 'waiting_review' : 'done';
        r.status = 'running';
      });
    },

    // 資料不全：我補給你——貼的內容當這步的輸入重跑（與原上游合併，見 runUntilPause）
    dataSupply(category, id, runId, nodeId, text) {
      if (typeof text !== 'string' || !text.trim()) throw new Error('要補的內容是空的——貼上缺的資料再重跑');
      return update(category, id, runId, (r) => {
        const step = r.steps[nodeId];
        if (!step || step.status !== 'waiting_data') throw new Error(`步驟「${nodeId}」不在等待補資料`);
        step.supplied_input = text;
        step.status = 'pending';
        step.data_note = null;
        step.output = null;
        r.status = 'running';
      });
    },

    // 等時刻喚醒：到點（scheduler tick）或人工「現在就繼續」；at 給了且在未來＝改排到那個時刻
    resumeTime(category, id, runId, nodeId, at = null) {
      return update(category, id, runId, (r) => {
        const step = r.steps[nodeId];
        if (!step || !['waiting_time', 'time_pending'].includes(step.status)) throw new Error(`步驟「${nodeId}」不在等待時間`);
        if (at) {
          const d = parseWhen(at);
          if (!d) throw new Error(`時刻「${at}」看不懂`);
          if (d.getTime() > now()) {
            step.status = 'waiting_time';
            step.wake_at = d.toISOString();
            step.time_note = null;
            r.status = 'running';
            return;
          }
        }
        step.status = 'pending';
        step.time_ok = true;
        step.wake_at = null;
        step.time_note = null;
        r.status = 'running';
      });
    },

    // 查核攔下：回話重做——把話與上一次的退回清單一起帶回給工人；attempts 一律保留
    checkRetry(category, id, runId, nodeId, note = null) {
      return update(category, id, runId, (r) => {
        const step = r.steps[nodeId];
        if (!step || step.status !== 'waiting_check') throw new Error(`步驟「${nodeId}」不在「查核攔下」狀態，無法回話重做`);
        step.check_note = typeof note === 'string' ? note : ''; // 紀錄：他講過的話一直留著
        step.check_note_pending = true; // 只有下一次交卷吃得到；交完就清（見 launch 的 retryNote）
        step.status = 'pending';
        r.status = 'running';
      });
    },

    // 查核攔下：就這樣過——他已經在卡上看過成品，不再進停點
    checkAccept(category, id, runId, nodeId) {
      return update(category, id, runId, (r) => {
        const step = r.steps[nodeId];
        if (!step || step.status !== 'waiting_check') throw new Error(`步驟「${nodeId}」不在「查核攔下」狀態，無法直接放行`);
        step.check = { ...step.check, status: 'accepted' };
        step.status = 'done';
        r.status = 'running';
      });
    },

    // 停點修改後擬「後面每一步都要守的規則」：擬不出來 checker 會退成一條預設，不擋停點
    async deriveEditRules(category, id, runId, nodeId) {
      const run = load(category, id, runId);
      const step = run.steps[nodeId];
      const node = run.def.nodes.find((n) => n.id === nodeId);
      if (!step || !node) throw new Error(`找不到步驟「${nodeId}」`);
      const rules = await deriveRules({
        adapter,
        meta: { category, workflow: id, run: runId, node: nodeId },
        title: node.title,
        original: step.output ?? '',
        edited: step.edited_output ?? '',
        note: step.edit_note ?? '',
        // 卷宗：擬規則的指示也存全文（存的＝送出的）
        onPrompt: (prompt) => store.writePromptRecord(category, id, runId, `${nodeId}.edit-rules.txt`, prompt),
      });
      return update(category, id, runId, (r) => { r.steps[nodeId].edit_rules = rules; });
    },

    // 查核卡上使用者自己改停點規則（ edit-rules 路由）：整份覆寫，格式不對就 400 人話
    setEditRules(category, id, runId, nodeId, rules) {
      if (!Array.isArray(rules)) throw new Error('規則清單格式不對——要是一份陣列');
      const cleaned = [];
      for (const r of rules) {
        const text = typeof r?.text === 'string' ? r.text.trim() : '';
        if (!text) continue; // 空文字的規則不算數，丟掉
        cleaned.push({ text, scope: r?.scope === 'this-step' ? 'this-step' : 'all' });
      }
      return update(category, id, runId, (r) => {
        const step = r.steps[nodeId];
        if (!step) throw new Error(`找不到步驟「${nodeId}」`);
        step.edit_rules = cleaned;
      });
    },

    // 失敗單步重試：不整流程重跑。只重設狀態，實際執行由呼叫端接續推進
    retry(category, id, runId, nodeId) {
      return update(category, id, runId, (r) => {
        const step = r.steps[nodeId];
        if (!step || step.status !== 'failed') throw new Error(`步驟「${nodeId}」不是失敗狀態，無法重試`);
        step.status = 'pending';
        step.error = null;
        r.status = 'running';
      });
    },
  };
}
