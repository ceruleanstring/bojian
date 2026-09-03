// optimizer — 三類回饋訊號 → 提議（ADR-003 縮限）。一律出提議待核可，絕不直接改流程。
// 純代碼偵測：參數反覆同向調整。AI 摘要：停點修改（連 2 次同節點）、事後回饋。
import yaml from 'js-yaml';

export function applyProposal(def, p) {
  // 目標不見了（流程後來改過）→ 明講，不准靜默沒事（零靜默失敗）
  if (p.kind === 'param_default') {
    const param = def.params.find((x) => x.key === p.change.key);
    if (!param) throw new Error(`這條提議指的欄位「${p.change.param_label ?? p.change.key}」已經不在了（流程後來改過）——這條作廢`);
    param.default = p.change.new_default;
  } else if (p.kind === 'node_instruction') {
    const node = def.nodes.find((n) => n.id === p.change.node_id);
    if (!node) throw new Error(`這條提議指的步驟「${p.change.node_title ?? p.change.node_id}」已經不在了（流程後來改過）——這條作廢`);
    node.instruction = p.change.new_instruction;
  }
  return def;
}

function parseYamlBlock(text) {
  const m = /```yaml\s*\n([\s\S]*?)```/.exec(text);
  if (!m) return null;
  try { return yaml.load(m[1]); } catch { return null; }
}

export function createOptimizer({ store, adapter }) {
  function lastDoneRuns(category, id, n = 5) {
    return store.listRuns(category, id)
      .map((rid) => store.readRun(category, id, rid))
      .filter((r) => r.status === 'done')
      .slice(-n);
  }

  return {
    // 分析一個流程的訊號，把新提議加進佇列。回 {created}
    async analyze(category, id, { feedback = null } = {}) {
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
          const out = parseYamlBlock(await adapter.complete({ prompt: [
            '你是「剝繭」的流程優化員。使用者連續兩次在同一步驟的停點修改了產出，請把他的習慣整併進該步驟的指示。',
            '輸出：先一句話說學到什麼，然後 ```yaml 圍欄含兩欄：summary（給使用者看的提議一句話，問句收尾）、new_instruction（改寫後的完整指示全文）。',
            '', `# 步驟「${node.title}」目前的指示`, node.instruction,
            '', '# 這次修改前的產出（節錄）', String(step.output ?? '').slice(0, 800),
            '', '# 使用者改成（節錄）', String(step.edited_output ?? '').slice(0, 800),
            '', `# 使用者註記`, step.edit_note ?? '（無）',
          ].join('\n'), meta: { kind: 'optimize', category, workflow: id } }));
          if (out?.summary && out?.new_instruction) {
            push(base(key, 'node_instruction', 'edits',
              `你連續 2 次都改了「${node.title}」的產出${step.edit_note ? `（${step.edit_note}）` : ''}`,
              { node_id: node.id, node_title: node.title, new_instruction: String(out.new_instruction), summary: String(out.summary) }));
          } // AI 摘要失敗：本輪略過，訊號還在下次補算（Error Map）
        }
      }

      // C) 事後回饋：即時轉提議
      if (feedback) {
        const nodeList = def.nodes.filter((n) => (n.kind ?? 'task') === 'task')
          .map((n) => `- ${n.id}：${n.title}——${String(n.instruction).slice(0, 60)}`).join('\n');
        const out = parseYamlBlock(await adapter.complete({ prompt: [
          '你是「剝繭」的流程優化員。使用者跑完流程後丟回一句戰果回饋，請判斷該改哪個步驟的指示。',
          '輸出：先一句話回應，然後 ```yaml 圍欄含三欄：node_id（要改的步驟 id，從下列清單選）、summary（提議一句話，問句收尾）、new_instruction（改寫後完整指示）。',
          '', '# 流程步驟清單', nodeList,
          '', '# 使用者的回饋', feedback,
        ].join('\n'), meta: { kind: 'optimize', category, workflow: id } }));
        const node = def.nodes.find((n) => n.id === out?.node_id);
        if (node && out?.new_instruction) {
          push(base(`fb:${node.id}:${Date.now().toString(36)}`, 'node_instruction', 'feedback',
            `你回報：「${feedback}」`,
            { node_id: node.id, node_title: node.title, new_instruction: String(out.new_instruction), summary: String(out.summary ?? '') }));
        }
      }

      if (fresh.length) store.writeProposals([...queue, ...fresh]);
      return { created: fresh.length };
    },
  };
}
