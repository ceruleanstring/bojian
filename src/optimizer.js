// optimizer — 五類回饋訊號 → 提議（ADR-003 縮限）。一律出提議待核可，絕不直接改流程。
// 純代碼偵測：參數反覆同向調整（A）、監工的建議（D）。AI 摘要：停點修改連 2 次同節點（B）、
// 事後回饋（C）、連 2 趟監工給同款交接（E）。
import yaml from 'js-yaml';
import { bigramJaccard } from './supervisor.js';

export function applyProposal(def, p) {
  // 監工建議（訊號 D）只是指路——按「好」是把使用者帶去那一步的抽屜自己改，定義一個字都不動
  if (p.kind === 'supervisor_hint') return def;
  // 目標不見了（流程後來改過）→ 明講，不准靜默沒事（零靜默失敗）
  if (p.kind === 'param_default') {
    const param = def.params.find((x) => x.key === p.change.key);
    if (!param) throw new Error(`這條提議指的欄位「${p.change.param_label ?? p.change.key}」已經不在了（Workflow 後來改過）——這條作廢`);
    param.default = p.change.new_default;
  } else if (p.kind === 'node_instruction') {
    const node = def.nodes.find((n) => n.id === p.change.node_id);
    if (!node) throw new Error(`這條提議指的步驟「${p.change.node_title ?? p.change.node_id}」已經不在了（Workflow 後來改過）——這條作廢`);
    node.instruction = p.change.new_instruction;
  }
  return def;
}

function parseYamlBlock(text) {
  const m = /```yaml\s*\n([\s\S]*?)```/.exec(text);
  if (!m) return null;
  try { return yaml.load(m[1]); } catch { return null; }
}

// 改寫指示的 prompt（訊號 B 與 E 共用）：差別只有第一句（為什麼要改）與材料段，
// 輸出格式與「目前的指示」一模一樣，兩個訊號回來的東西才對得上同一個 node_instruction 提議。
const EDITS_LEAD = '你是「剝繭」的流程優化員。使用者連續兩次在同一步驟的停點修改了產出，請把他的習慣整併進該步驟的指示。';
const HANDOFF_LEAD = '你是「剝繭」的流程優化員。連續兩趟監工都給了類似的交接，請把它整併進該步驟的指示。';
function rewritePrompt(lead, node, material) {
  return [
    lead,
    '輸出：先一句話說學到什麼，然後 ```yaml 圍欄含兩欄：summary（給使用者看的提議一句話，問句收尾）、new_instruction（改寫後的完整指示全文）。',
    '', `# 步驟「${node.title}」目前的指示`, node.instruction,
    ...material,
  ].join('\n');
}

// 工作單回呼（比照 checker.notePrompt）：寫不進工作單只是少一份紀錄，不該讓提議整個不見
async function note(fn, value) {
  if (typeof fn !== 'function') return;
  try { await fn(value); } catch { /* 工作單寫不進不擋優化 */ }
}

export function createOptimizer({ store, adapter }) {
  function lastDoneRuns(category, id, n = 5) {
    const out = [];
    for (const rid of store.listRuns(category, id)) {
      // 壞掉的 run.yaml 只跳過這一筆：不擋的話 analyze 會整支 reject，兩個呼叫點都只印一行
      // 「下次一起看」就吞掉——而壞檔一直在，這條流程從此再也不會有任何提議（同 scheduler 那條同型病）
      let r;
      try { r = store.readRun(category, id, rid); } catch { continue; }
      if (r.status === 'done') out.push(r);
    }
    return out.slice(-n);
  }

  return {
    // 分析一個流程的訊號，把新提議加進佇列。回 {created}
    async analyze(category, id, { feedback = null, onPrompt = null, onReply = null } = {}) {
      const def = store.readWorkflow(category, id);
      const version = store.listVersions(category, id).at(-1)?.version ?? 1;
      const runs = lastDoneRuns(category, id);
      const queue = store.readProposals();
      // stale（套用失敗作廢）也算存在——同 key 不重生，否則變打不死的殭屍提議
      const hasKey = (key) => queue.some((p) => p.key === key && ['pending', 'muted', 'accepted', 'stale'].includes(p.status));
      const fresh = [];
      const push = (p) => { if (!hasKey(p.key)) fresh.push(p); };
      const base = (key, kind, source, evidence, change) => ({
        id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        key, kind, source, evidence, change,
        workflow: { category, id },
        status: 'pending', reject_count: 0, created_at: new Date().toISOString(),
      });
      // 送出→收回，兩邊都留工作單（存的全文＝送出的全文）
      const ask = async (prompt) => {
        await note(onPrompt, prompt);
        const raw = await adapter.complete({ prompt, meta: { kind: 'optimize', category, workflow: id } });
        await note(onReply, String(raw ?? ''));
        return raw;
      };

      // A) 參數反覆同向：最近連續 2 次 run 都把同參數覆寫成同一個值
      if (runs.length >= 2) {
        const [a, b] = runs.slice(-2);
        for (const p of def.params) {
          const va = a.params?.[p.key];
          const vb = b.params?.[p.key];
          if (va !== undefined && String(va) === String(vb) && String(va) !== String(p.default)) {
            push(base(`param:${p.key}:${va}`, 'param_default', 'params',
              `你連續 2 次開跑都把「${p.label}」改成「${va}」`,
              { key: p.key, param_label: p.label, new_default: va }));
          }
        }
        // B) 停點修改：連 2 次改同節點 → AI 摘要新指示
        for (const node of def.nodes) {
          const ea = a.steps?.[node.id]?.edited_output;
          const eb = b.steps?.[node.id]?.edited_output;
          if (ea == null || eb == null) continue;
          const key = `instr:${node.id}:v${version}`;
          if (hasKey(key)) continue;
          const step = b.steps[node.id];
          const out = parseYamlBlock(await ask(rewritePrompt(EDITS_LEAD, node, [
            '', '# 這次修改前的產出（節錄）', String(step.output ?? '').slice(0, 800),
            '', '# 使用者改成（節錄）', String(step.edited_output ?? '').slice(0, 800),
            '', '# 使用者註記', step.edit_note ?? '（無）',
          ])));
          if (out?.summary && out?.new_instruction) {
            push(base(key, 'node_instruction', 'edits',
              `你連續 2 次都改了「${node.title}」的產出${step.edit_note ? `（${step.edit_note}）` : ''}`,
              { node_id: node.id, node_title: node.title, new_instruction: String(out.new_instruction), summary: String(out.summary) }));
          } // AI 摘要失敗：略過，訊號還在下次補算（Error Map）
        }

        // E) 連 2 趟監工都對同一步交代類似的話 → 那已經是這一步的規矩，該寫進指示。
        // 差得多（Jaccard < 0.5）＝兩趟情況不同，不是習慣，連 AI 都不必問（不花冤枉 token）
        // 只看工作步驟：分岔節點的 handoff 是判路用的 only_route 交接（監工關掉時也會寫），
        // 使用者根本沒看過，不是監工建議，不能拿來當「該寫進指示」的證據。
        for (const node of def.nodes) {
          if ((node.kind ?? 'task') !== 'task') continue;
          const ha = a.steps?.[node.id]?.handoff?.text;
          const hb = b.steps?.[node.id]?.handoff?.text;
          if (!ha || !hb || bigramJaccard(ha, hb) < 0.5) continue;
          const key = `handoff:${node.id}:v${version}`;
          if (hasKey(key)) continue;
          const out = parseYamlBlock(await ask(rewritePrompt(HANDOFF_LEAD, node, [
            '', '# 上一趟監工的交接', ha,
            '', '# 這一趟監工的交接', hb,
          ])));
          if (out?.summary && out?.new_instruction) {
            push(base(key, 'node_instruction', 'supervisor',
              `監工連續 2 趟都對「${node.title}」交代了類似的事`,
              { node_id: node.id, node_title: node.title, new_instruction: String(out.new_instruction), summary: String(out.summary) }));
          }
        }
      }

      // D) 監工的建議：最近一趟跑完的紀錄裡監工指名要改哪裡——照抄成提議，不再問一次 AI。
      // 按「好」不改定義，只把使用者帶到那一步的抽屜自己改（見 applyProposal 與伺服器的 accept）。
      // 流程後來刪掉的步驟不提：帶過去也只會開到一個不存在的抽屜。
      for (const s of runs.at(-1)?.record?.suggestions ?? []) {
        const text = String(s?.text ?? '').trim();
        if (!text || !def.nodes.some((n) => n.id === s.node)) continue;
        push(base(`hint:${s.node}:${s.where}:${text.slice(0, 40)}`, 'supervisor_hint', 'supervisor',
          text, { node_id: s.node, field: s.where }));
      }

      // C) 事後回饋：即時轉提議
      if (feedback) {
        const nodeList = def.nodes.filter((n) => (n.kind ?? 'task') === 'task')
          .map((n) => `- ${n.id}：${n.title}——${String(n.instruction).slice(0, 60)}`).join('\n');
        const out = parseYamlBlock(await ask([
          '你是「剝繭」的流程優化員。使用者跑完流程後丟回一句戰果回饋，請判斷該改哪個步驟的指示。',
          '輸出：先一句話回應，然後 ```yaml 圍欄含三欄：node_id（要改的步驟 id，從下列清單選）、summary（提議一句話，問句收尾）、new_instruction（改寫後完整指示）。',
          '', '# 流程步驟清單', nodeList,
          '', '# 使用者的回饋', feedback,
        ].join('\n')));
        const node = def.nodes.find((n) => n.id === out?.node_id);
        if (node && out?.new_instruction) {
          push(base(`fb:${node.id}:${Date.now().toString(36)}`, 'node_instruction', 'feedback',
            `你回報：「${feedback}」`,
            { node_id: node.id, node_title: node.title, new_instruction: String(out.new_instruction), summary: String(out.summary ?? '') }));
        }
      }

      if (!fresh.length) return { created: 0 };
      // 跨 await 不准持有舊物件（runner.js 開頭那條寫入紀律）：analyze 中間是好幾趟數分鐘的 AI 呼叫，
      // 而使用者這時正在剛跑完的畫面上按「好／不要」。把 await 之前的整包佇列寫回去會洗掉他的決定——
      // 已接受的提議變回 pending、被再套用一次、版本多升一版；拒兩次靜音的規則也被打回（2026-09-18 審查）。
      // 改成寫入時重讀最新、只插不蓋，順手擋掉這段期間別人已經加過的同 key。
      const latest = store.readProposals();
      const alive = new Set(latest.filter((p) => ['pending', 'muted', 'accepted', 'stale'].includes(p.status)).map((p) => p.key));
      const ids = new Set(latest.map((p) => p.id));
      const add = fresh.filter((p) => !ids.has(p.id) && !alive.has(p.key));
      if (add.length) store.writeProposals([...latest, ...add]);
      return { created: add.length };
    },
  };
}
