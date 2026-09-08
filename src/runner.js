// runner — run 生命週期（有向圖版，D14）：就緒集推進、平行併發、分岔判路、停點/人步暫停、checkpoint。
// 寫入紀律：所有狀態變更走 update()（讀最新→改→原子存），跨 await 不持有舊物件——平行支不互相蓋寫。
import fs from 'node:fs';
import { validateWorkflow, nodeKind, outgoing, OUTPUT_TIER2, OUTPUT_OFFICE } from './schema.js';
import { predecessors, computeSkipped } from './graph.js';
import { inputSources } from './preflight.js';
import { buildSources, extractFileText, runCheck, deriveEditRules as deriveRules } from './checker.js';

// 查核輪：長欄位值不代進句子——給了 sink 時，換行或超過 200 字的值不直接代入，
// 改留一句指向「欄位內容」段的提示，原文收進 sink（Map，同一 key 只收一次）；不給 sink＝舊行為。
function injectParams(instruction, params, { labels, sink } = {}) {
  return instruction.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, key) => {
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

// 工人自報「這步的資料不夠」的協定（US-012）：標頭那行是缺什麼，其餘是骨架
const SHORTFALL = /^【資料不全】(.*)\n?([\s\S]*)$/;

// 沒有查核結果的紀錄：off＝流程關掉查核，skipped＝不適用（人做、分岔、並行點、自報資料不全）
const noCheck = (status) => ({ status, blocks: [], flags: [], missing: [], items: [], summary: '', note: '', attempts: 0 });

// 等時刻（D20）：時刻文字→Date；解析不出回 null（不排幽靈時間）。
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

export function createRunner({ store, adapter, now = () => Date.now() }) {
  const load = (c, i, r) => store.readRun(c, i, r);

  // D19：步驟輸出存成檔案。TIER2 未接工具鏈→降級 .md 並在 step.file_note 講明；有範本先填範本（{{參數}}＋{{output}}）
  function saveArtifact(category, id, runId, node, params, step, output, opts = {}) {
    if (!node.output_file && !node.template_file) return;
    let ext = node.output_file ?? (node.template_file.includes('.') ? node.template_file.split('.').pop() : 'md');
    if (OUTPUT_OFFICE.includes(ext)) {
      // 產檔輪：Word／Excel 真檔由工人在產出資料夾做；走到這裡＝流程沒開產檔權限、或工人沒交出檔案 → 文字產出先存成 .md
      step.file_note = opts.officeNote ?? `這條流程沒開產檔權限——.${ext} 先存成 .md；流程頁打開「允許這條流程產出檔案」就會產真檔`;
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
    const fname = `${node.title.replace(/[\\/:*?"<>|]/g, '_')}.${ext}`;
    step.file = store.writeArtifact(category, id, runId, fname, content);
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

  // 節點的上游輸入：非跳過且完成的前驅之有效產出；多個時加標頭併排
  function upstreamText(run, nodeId, skipped, predMap) {
    const byId = new Map(run.def.nodes.map((n) => [n.id, n]));
    const parts = (predMap.get(nodeId) ?? [])
      .filter((p) => !skipped.has(p) && run.steps[p].status === 'done')
      .map((p) => ({ title: byId.get(p).title, text: effectiveOutput(run.steps[p]) }))
      .filter((x) => x.text);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0].text;
    return parts.map((x) => `【${x.title}】\n${x.text}`).join('\n\n');
  }

  // 這一步的全部祖先（BFS 走前驅），深度優先後序＝拓樸序（祖先排在自己前面）
  function ancestorIds(run, nodeId, predMap = predecessors(run.def)) {
    const seen = new Set();
    const order = [];
    const walk = (id) => {
      for (const p of predMap.get(id) ?? []) {
        if (seen.has(p)) continue;
        seen.add(p);
        walk(p);
        order.push(p);
      }
    };
    walk(nodeId);
    return order;
  }

  // 查核輪：查核要看的原始資料之一——所有祖先任務步驟的有效產出（拓樸序；結構節點與空產出不列）
  function ancestorsOf(run, nodeId, predMap) {
    const byId = new Map(run.def.nodes.map((n) => [n.id, n]));
    return ancestorIds(run, nodeId, predMap)
      .filter((p) => byId.has(p) && nodeKind(byId.get(p)) === 'task')
      .map((p) => ({ title: byId.get(p).title, text: effectiveOutput(run.steps[p] ?? {}) }))
      .filter((x) => x.text);
  }

  // 查核輪：上游停點改過後擬出來的規則，只有 scope='all' 的往下游帶（自己那一步不吃自己的）
  function editRulesFor(run, nodeId, predMap) {
    return ancestorIds(run, nodeId, predMap)
      .flatMap((p) => run.steps[p]?.edit_rules ?? [])
      .filter((rule) => rule && rule.scope === 'all');
  }

  // 資料不全診斷（資料通道輪）：缺口從接線與各步現況算出來，不猜——給卡片指名「該去改哪一步」
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

  async function judgeBranch(node, upstream, ctx) {
    const options = node.branches.map((b, i) => `${i + 1}. ${b.label}`).join('\n');
    const prompt = [
      '你是流程分岔的判路員。根據「判斷依據」與「上游內容」，從選項中選一條路。',
      '只輸出選中的那一條的編號與原文（例如「1. 金額五千以上」），一個字都不要多。判斷不了就輸出「無法判定」。',
      '',
      `# 判斷依據`,
      node.instruction,
      '',
      '# 選項',
      options,
      '',
      '# 上游內容',
      upstream || '（無）',
    ].join('\n');
    try { store.writePromptRecord(ctx.category, ctx.id, ctx.runId, `${node.id}-判路.txt`, prompt); } catch { /* 卷宗寫不進不擋執行 */ }
    const ans = (await adapter.complete({ prompt, meta: { kind: 'branch', category: ctx.category, workflow: ctx.id, run: ctx.runId, node: node.id } })).trim();
    const hits = node.branches.filter((b) => ans.includes(b.label));
    if (hits.length === 1) return hits[0];
    const num = /^(\d+)/.exec(ans);
    if (num && node.branches[Number(num[1]) - 1]) return node.branches[Number(num[1]) - 1];
    return null;
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
    // 綁定事件（US-039）：來源步若標了 EVENT_ID（它建立的 Google 事件），一併帶回給等時刻步
    const ev = [...text.matchAll(/EVENT_ID[:：]\s*(\S+)/gi)].at(-1);
    return { ok: true, at: d, linkedEventId: ev ? ev[1] : null };
  }

  return {
    startRun(category, id, overrides = {}, opts = {}) {
      const def = store.readWorkflow(category, id);
      validateWorkflow(def);
      const params = {};
      for (const p of def.params) {
        const v = overrides[p.key];
        params[p.key] = v === undefined || v === null || String(v).trim() === '' ? p.default : v;
      }
      const run = {
        run_id: store.newRunId(),
        workflow: { category, id, name: def.name },
        def, // 定義快照：退版時進行中的 run 用舊版跑完（Error Map）
        status: 'running',
        source: opts.source ?? 'manual', // manual｜schedule（D20）
        makeup: opts.makeup === true || undefined, // 錯過補跑標記（行事曆標「補」）
        params,
        started_at: new Date().toISOString(),
        finished_at: null,
        steps: Object.fromEntries(
          def.nodes.map((n) => [n.id, {
            status: 'pending', output: null, edited_output: null, edit_note: null,
            feedback: null, error: null, choice: null, choice_by: null, choice_label: null,
            supplied_input: null, data_diagnosis: null, // 資料通道輪：補資料／資料不全診斷
          }]),
        ),
      };
      store.writeRun(category, id, run.run_id, run);
      return run;
    },

    // 推進到「沒有可自動前進的事」為止：全完→done、有等待/失敗→paused
    async runUntilPause(category, id, runId) {
      const inflight = new Map(); // nodeId → promise（本次呼叫內的併發登記）

      const launch = (node, kind, upstream, params, labels, needsWhen = false, filePermitted = false) => {
        const p = (async () => {
          const started = update(category, id, runId, (r) => { r.steps[node.id].status = 'running'; r.steps[node.id].error = null; });
          try {
            if (kind === 'branch') {
              const hit = await judgeBranch(node, upstream, { category, id, runId });
              update(category, id, runId, (r) => {
                const s = r.steps[node.id];
                s.check = noCheck('skipped'); // 分岔只選路、不產內容，沒東西可查
                if (hit) {
                  s.status = 'done';
                  s.choice = hit.next;
                  s.choice_by = 'ai';
                  s.choice_label = hit.label;
                  s.output = upstream; // 傳遞內容給選中的下游
                } else {
                  s.status = 'waiting_branch';
                }
              });
            } else {
              const TIER_MODEL = { fast: 'haiku', balanced: 'sonnet', deep: 'opus' }; // 檔位→宿主型號別名
              const sink = new Map(); // 查核輪：本次呼叫收集到的長欄位值，交給 buildPrompt 的「欄位內容」段（同一 key 跨欄位共用，只收一次）
              const injLong = (s) => (s ? injectParams(s, params, { labels, sink }) : '');
              const editRules = editRulesFor(started, node.id).map((rule) => rule.text); // 查核輪：上游停點改過後留給後面每一步的要求
              const checkOn = started.def.check?.enabled !== false; // 缺省＝開（跨 await 前先取值，不留著整份 run）
              // 輸出規格四面向＋補充＋檔案格式（D19）合成一段格式要求
              const fmtParts = [];
              if (node.output_type) fmtParts.push(`類型：${injLong(node.output_type)}`);
              if (node.output_structure) fmtParts.push(`結構：${injLong(node.output_structure)}`);
              if (node.output_length) fmtParts.push(`份量：${injLong(node.output_length)}`);
              if (node.output_tone) fmtParts.push(`語言與語氣：${injLong(node.output_tone)}`);
              if (node.output_format) fmtParts.push(injLong(node.output_format));
              // 產檔輪：Word／Excel 且流程開了產檔權限 → 工人在產出資料夾產真檔（fileMode）；沒開或 pptx/pdf → 文字產出降級 .md
              const officeExt = OUTPUT_OFFICE.includes(node.output_file) ? node.output_file : null;
              const makesFile = !!(officeExt && filePermitted);
              if (node.output_file) {
                const eff = OUTPUT_TIER2.includes(node.output_file) || (officeExt && !filePermitted) ? 'md' : node.output_file;
                const extNote = { csv: '內容必須是合法 CSV 純文字', json: '內容必須是合法 JSON', html: '輸出一份完整可直接開啟的 HTML' }[eff];
                fmtParts.push(makesFile ? `成品是 .${eff} 真檔（照下方「產檔規則」寫檔）；這裡的文字產出＝檔案內容摘要` : `最終會存成 .${eff} 檔${extNote ? `——${extNote}` : ''}`);
              }
              // 有下游步驟等這一步的時間（wait_until.from，D20）→ 要求末行標 WHEN；建了行事曆事件另標 EVENT_ID（US-039 綁定）
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
                model: TIER_MODEL[node.model_tier] ?? '',
                attachments: (node.attachments ?? []).map((a) => store.refFilePath(category, id, a)).filter(Boolean),
                upstream,
                paramBlocks: [...sink.values()], // 查核輪：長欄位值原文，buildPrompt 另開「欄位內容」段
                editRules, // 查核輪：上游停點改出來的規則，工人與查核員都當必守
                meta: { kind: 'step', category, workflow: id, run: runId, node: node.id }, // 用量帳本的歸戶欄位
              };
              // 回話重做（查核輪）：使用者在查核卡寫的話＋上一次的退回清單，一起帶回給工人。
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
                  fileName: `${node.title.replace(/[\\/:*?"<>|]/g, '_')}.${officeExt}`,
                  templatePath: node.template_file ? (store.refFilePath(category, id, node.template_file) ?? null) : null,
                };
              }
              // 卷宗（儀表板輪）：送出前把指示全文存進本次執行資料夾——renderPrompt 與實際送出走同一函式
              try { if (adapter.renderPrompt) store.writePromptRecord(category, id, runId, `${node.id}.txt`, adapter.renderPrompt(callArgs)); } catch { /* 卷宗寫不進不擋執行 */ }
              // 單步自動重試（D18）：失敗先自動重來 retry 次，用盡才停下問人
              const deliver = async (args) => {
                const tries = 1 + (node.retry ?? 0);
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
                for (const name of node.attachments ?? []) {
                  const fp = store.refFilePath(category, id, name);
                  if (!fp) continue;
                  try {
                    const text = await extractFileText(fs.readFileSync(fp), name);
                    if (text) refTexts.push({ name, text });
                  } catch { /* 讀不到的參考檔跳過，不擋查核 */ }
                }
                return refTexts;
              };
              // 交貨查核（查核輪）：拿原始資料、使用者的要求、停點規則對照成品；查核本身失敗不擋交貨
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
                  },
                  sources: buildSources({
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
                // 沒查成時連查核員的回覆原文一起進卷宗（查核輪補件）：只存指示的話，「這次沒查成」事後查不出為什麼。
                // raw 不進 run 紀錄——那份回覆可能好幾萬字，卷宗才是放全文的地方
                const { raw, ...kept } = res;
                if (kept.status === 'incomplete' && raw) {
                  try { store.writePromptRecord(category, id, runId, `${node.id}.check${nth}.reply.txt`, raw); } catch { /* 卷宗寫不進不擋查核 */ }
                }
                return { ...kept, attempts: 1 };
              };
              // 每次交卷都推一筆（查核輪）：永不覆蓋，重做與回話重做都看得到
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
                  // 自報協定（US-012）：停該步、記缺什麼，等使用者三選一
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
                    saveArtifact(category, id, runId, node, r.params, s, output, { officeNote: `工人沒交出 .${officeExt} 檔——先把它的文字產出存成 .md，可按「重試這步」再來一次` });
                  } else {
                    saveArtifact(category, id, runId, node, r.params, s, output);
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
        let run = load(category, id, runId);
        if (run.status === 'done') return run;
        const def = run.def;
        const labels = Object.fromEntries((def.params ?? []).map((p) => [p.key, p.label])); // 查核輪：長欄位提示語要用的欄位標籤
        const predMap = predecessors(def);
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
          return (predMap.get(n.id) ?? []).every((p) => skipped.has(p) || ['done', 'skipped'].includes(run.steps[p].status));
        });

        if (ready.length === 0) {
          if (inflight.size > 0) {
            await Promise.race(inflight.values());
            continue;
          }
          return update(category, id, runId, (r) => {
            if (r.status !== 'running') return;
            const allSettled = def.nodes.every((n) => ['done', 'skipped'].includes(r.steps[n.id].status));
            if (allSettled) {
              r.status = 'done';
              r.finished_at = new Date().toISOString();
            } else {
              r.status = 'paused';
            }
          });
        }

        for (const node of ready) {
          const kind = nodeKind(node);
          // 等時刻（D20）：時間也是停點——到了才往下；動態時刻解析不出＝time_pending 轉待辦問人
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
                if (res.linkedEventId) r.steps[node.id].linked_event_id = res.linkedEventId; // Google 側改期比對用（US-039）
              });
              continue;
            }
            run = update(category, id, runId, (r) => { r.steps[node.id].time_ok = true; });
          }
          const baseUpstream = upstreamText(run, node.id, skipped, predMap);
          // 補資料（資料通道輪）：使用者在資料不全卡貼的內容排在前面，原本的上游照給——都給才是完整輸入
          const supplied = run.steps[node.id]?.supplied_input;
          const upstream = supplied
            ? `【你補的資料】\n${supplied}${baseUpstream ? `\n\n【上一步的產出】\n${baseUpstream}` : ''}`
            : baseUpstream;
          if (kind === 'fork' || kind === 'join') {
            // 結構節點即時完成：產出=上游內容（fork 傳遞、join 匯流）
            run = update(category, id, runId, (r) => {
              r.steps[node.id].status = 'done';
              r.steps[node.id].output = upstream;
              r.steps[node.id].check = noCheck('skipped'); // 並行點只搬運上游內容，沒有新東西可查
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
    // 這裡不動 run 的狀態（裁定 28）：改完還要擬「後面每步要守的規則」，那段時間 run 要繼續停著——
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
        if (node && !isOffice) saveArtifact(category, id, runId, node, r.params, step, editedOutput); // 改過的版本蓋回檔案（Word／Excel 真檔不覆蓋——改的是摘要）
      });
    },

    // 停點處理完、該準備的都備妥了才放行（裁定 28）：把「這步做完」跟「可以往下跑」分成兩個動作
    resume(category, id, runId) {
      return update(category, id, runId, (r) => { r.status = 'running'; });
    },

    // 人做步驟：標記完成，可附一句心得；content＝交給下一步的內容（資料通道輪）——成為這步的產出往下傳，留空就是 null
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

    // 分岔判不出時由使用者選路（US-023）
    chooseBranch(category, id, runId, nodeId, target) {
      return update(category, id, runId, (r) => {
        const node = r.def.nodes.find((n) => n.id === nodeId);
        const step = r.steps[nodeId];
        if (!node || nodeKind(node) !== 'branch' || !step || step.status !== 'waiting_branch') {
          throw new Error(`步驟「${nodeId}」不在等待選路`);
        }
        const hit = node.branches.find((b) => b.next === target);
        if (!hit) throw new Error(`「${target}」不是這個分岔的選項`);
        const predMap = predecessors(r.def);
        step.status = 'done';
        step.choice = hit.next;
        step.choice_by = 'user';
        step.choice_label = hit.label;
        step.output = upstreamText(r, nodeId, computeSkipped(r.def, choicesOf(r)), predMap);
        r.status = 'running';
      });
    },

    // 資料不全：重抓一次（US-012 選項一）
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

    // 資料不全：就用現有的做，成品標注（US-012 選項二）
    dataAccept(category, id, runId, nodeId) {
      return update(category, id, runId, (r) => {
        const step = r.steps[nodeId];
        if (!step || step.status !== 'waiting_data') throw new Error(`步驟「${nodeId}」不在等待補資料`);
        step.output = `【已標注資料不全：${step.data_note}】\n${step.output ?? ''}`;
        step.status = 'done';
        r.status = 'running';
      });
    },

    // 資料不全：我補給你（資料通道輪，US-012 第四選項）——貼的內容當這步的輸入重跑（與原上游合併，見 runUntilPause）
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

    // 等時刻喚醒（D20）：到點（scheduler tick）或人工「現在就繼續」；at 給了且在未來＝改排到那個時刻
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

    // 查核攔下：回話重做（查核輪）——把話與上一次的退回清單一起帶回給工人；attempts 一律保留
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

    // 查核攔下：就這樣過（查核輪）——他已經在卡上看過成品，不再進停點
    checkAccept(category, id, runId, nodeId) {
      return update(category, id, runId, (r) => {
        const step = r.steps[nodeId];
        if (!step || step.status !== 'waiting_check') throw new Error(`步驟「${nodeId}」不在「查核攔下」狀態，無法直接放行`);
        step.check = { ...step.check, status: 'accepted' };
        step.status = 'done';
        r.status = 'running';
      });
    },

    // 停點修改後擬「後面每一步都要守的規則」（查核輪）：擬不出來 checker 會退成一條預設，不擋停點
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

    // 查核卡上使用者自己改停點規則（查核輪 edit-rules 路由）：整份覆寫，格式不對就 400 人話
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
