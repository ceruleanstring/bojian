// 用量換算——公式與 reviews/對照測試-2026-09-23/score.mjs 相同：新讀 + 1.25×快取寫入 + 0.1×重複讀 + 5×寫出
import fs from 'node:fs';
import path from 'node:path';

export const ZERO = Object.freeze({ fresh: 0, cache_write: 0, cache_read: 0, output: 0 });

// 宿主回傳的 usage（claude -p 的 JSON、或剝繭 usage.jsonl 的一行）→ 四欄
export const tokOf = (u) => ({
  fresh: u?.input_tokens ?? 0,
  cache_write: u?.cache_creation_input_tokens ?? 0,
  cache_read: u?.cache_read_input_tokens ?? 0,
  output: u?.output_tokens ?? 0,
});
export const addTok = (a, b) => ({ fresh: a.fresh + b.fresh, cache_write: a.cache_write + b.cache_write, cache_read: a.cache_read + b.cache_read, output: a.output + b.output });
export const weighted = (t) => Math.round((t?.fresh ?? 0) + 1.25 * (t?.cache_write ?? 0) + 0.1 * (t?.cache_read ?? 0) + 5 * (t?.output ?? 0));

// 剝繭資料夾裡全部 usage.jsonl（多組織＝好幾本）——逐行解析，壞行跳過（照 對照測試 run.mjs 的 readUsageFiles）
export function readUsageFiles(dataDir) {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name === 'usage.jsonl') {
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { out.push(JSON.parse(line)); } catch { /* 壞行跳過 */ }
        }
      }
    }
  };
  walk(dataDir);
  return out;
}

// 某一趟（run id）的用量加總＋按 kind 分（step／check／supervisor／overview…）
export function usageOfRun(dataDir, rid) {
  const mine = readUsageFiles(dataDir).filter((u) => u.run === rid);
  let tokens = { ...ZERO };
  const byKind = {};
  for (const u of mine) {
    const k = u.kind ?? u.node ?? 'step';
    byKind[k] ??= { calls: 0, tokens: { ...ZERO } };
    byKind[k].calls += 1;
    byKind[k].tokens = addTok(byKind[k].tokens, tokOf(u));
    tokens = addTok(tokens, tokOf(u));
  }
  return { tokens, calls: mine.length, by_kind: byKind, models: [...new Set(mine.map((u) => u.model).filter(Boolean))] };
}
