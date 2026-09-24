// 剝繭 API 客戶端（fetch）——路由與欄位名對 bojian/src/server.js 的 /api/workflows/:cat/:id/... 查過
import fs from 'node:fs';

export function makeApi(port, { host = '127.0.0.1' } = {}) {
  const root = `http://${host}:${port}/api`;
  const api = async (method, p, body) => {
    const r = await fetch(`${root}${p}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch { j = txt; }
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${typeof j === 'string' ? j.slice(0, 300) : JSON.stringify(j).slice(0, 300)}`);
    return j;
  };
  const enc = encodeURIComponent;
  return {
    api,
    root,
    // 活著沒：GET /api/workflows 回 200 即可（不打 /api/health，它會 spawn claude --version）
    async alive() {
      try { const r = await fetch(`${root}/workflows`); return r.ok; } catch { return false; }
    },
    // 建流程：POST /workflows { category, def } → { id }
    async createWorkflow(category, def) {
      const r = await api('POST', '/workflows', { category, def });
      return { cat: category, id: r.id, base: `/workflows/${enc(category)}/${enc(r.id)}` };
    },
    // 參考檔：POST /workflows/:cat/:id/files { name, content_b64 }
    async uploadFile(wf, name, filePath) {
      return api('POST', `${wf.base}/files`, { name, content_b64: fs.readFileSync(filePath).toString('base64') });
    },
    // 開跑：POST /workflows/:cat/:id/runs {} → run（run_id）
    async startRun(wf, body = {}) {
      return api('POST', `${wf.base}/runs`, body);
    },
    getRun(wf, rid) { return api('GET', `${wf.base}/runs/${enc(rid)}`); },
    // 動作：POST /runs/:rid/<action> { node, ...body }
    act(wf, rid, action, body) { return api('POST', `${wf.base}/runs/${enc(rid)}/${action}`, body); },
    listFiles(wf, rid) { return api('GET', `${wf.base}/runs/${enc(rid)}/files`); },
    async downloadFile(wf, rid, name, dest) {
      const r = await fetch(`${root}${wf.base}/runs/${enc(rid)}/files/${enc(name)}`);
      if (!r.ok) throw new Error(`下載 ${name} → ${r.status}`);
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      return dest;
    },
    listPrompts(wf, rid) { return api('GET', `${wf.base}/runs/${enc(rid)}/prompts`); },
    readPrompt(wf, rid, name) { return api('GET', `${wf.base}/runs/${enc(rid)}/prompts/${enc(name)}`); },
  };
}
