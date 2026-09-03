// host-adapter — 與宿主（Claude）的一切接點（ADR-001：宿主知識只准存在這裡）。
// AI 呼叫走 `claude -p` headless 子行程，prompt 由 stdin 餵入。
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 產檔輪：工人產檔用剝繭自帶的 Node 套件（docx／exceljs／docxtemplater／pizzip），NODE_PATH 指過去，工人不用自己裝
export const BUNDLED_NODE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');

export class HostError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const UNAVAILABLE_MSG = '連不上 Claude——請確認 Claude Code 已安裝、指令列打 claude 打得開。你的流程庫都在，不會不見。';

function defaultSpawn(args, extra = {}) {
  // 工人在中立目錄開工（2026-09-02 定案）：繼承伺服器 cwd 會吃到使用者本地的專案
  // CLAUDE.md 與 hooks——實案：工作區的收工門禁把步驟最後一句換成「本次無入庫項」，成品被調包。
  // 本專案會公開，任何使用者的本地規矩都不該套在步驟工人頭上；附件走絕對路徑，不受 cwd 影響。
  // 產檔模式（產檔輪）例外：cwd 改成這趟執行的產出資料夾（extra.cwd），env 帶 NODE_PATH 給自帶套件。
  const opts = { cwd: extra.cwd ?? os.tmpdir(), windowsHide: true, ...(extra.env ? { env: extra.env } : {}) };
  // Windows 下 claude 是 .cmd，直接 spawn 會 EINVAL——走 cmd /c
  return process.platform === 'win32'
    ? spawn('cmd', ['/c', 'claude', ...args], opts)
    : spawn('claude', args, opts);
}

const CREATIVITY_TEXT = {
  strict: '嚴謹精確——照資料與要求寫，不自行發揮、不添加未經證實的內容。',
  open: '可以自由發想——提出多元角度與有創意的選項，不要保守。',
};

// 產檔規則段（產檔輪）：只在產檔模式加——工人在產出資料夾用自帶套件寫真檔，文字產出改交摘要
function fileRulesSection(fileMode) {
  if (!fileMode) return [];
  const lib = fileMode.fileName.endsWith('.xlsx') ? 'exceljs（開新檔或 workbook.xlsx.readFile 開範本再寫格）' : 'docx（從零建檔）或 docxtemplater＋pizzip（套範本填欄）';
  return [
    '',
    '# 產檔規則（嚴格遵守）',
    `目前工作目錄就是這一步的產出資料夾。用 node 腳本把成品寫成「${fileMode.fileName}」（就放在目前目錄，檔名一個字都不能改）。可用套件：${lib}；NODE_PATH 已設好，直接 require，不准安裝任何套件。`,
    '只准在目前目錄寫檔與執行 node；不准讀寫目前目錄以外的任何路徑（參考檔除外）、不准連網做產檔以外的事。',
    ...(fileMode.fileName.endsWith('.xlsx') ? ['Excel 公式格要同時寫入算好的結果（exceljs：cell.value = { formula, result }），預覽與不重算的閱讀器才看得到數字。'] : []),
    ...(fileMode.templatePath ? [`範本在「${fileMode.templatePath}」：套用它、只填內容不改版型（Word 用 docxtemplater 填欄或以其樣式為準；Excel 用 exceljs 開範本寫格）。`] : []),
    '檔案寫好後，你的文字產出＝檔案內容的重點摘要（下一步要用它），不要貼程式碼、不要解釋怎麼做的。檔案沒寫成功就在第一行輸出「【資料不全】」加原因。',
  ];
}

function buildPrompt({ title, instruction, roleContext, background, constraints, examples, outputFormat, creativity, reviewFocus, attachments, upstream, fileMode }) {
  return [
    '你是「剝繭」流程裡的一個步驟執行者。只輸出這一步的產出內容本身——不要開場白、不要收尾語、不要解釋你做了什麼。',
    '這不是對話：沒有人會回覆你，你的產出會直接交給下一步（或給使用者過目，他只能核可或動手修改）。不要反問、不要邀請回覆、不要用「要哪個再說」收尾。任務要你提供多個選項時，自己選定一個推薦，讓產出以推薦版本為主體、備選附在後面標明。',
    '特例：如果要求裡指定的資料你拿不齊或拿不到——缺月份、缺欄位、少一段、工具不可用、搜尋無結果、上游沒交貨都算——第一行輸出「【資料不全】」加一句缺什麼，換行後再給你能給的部分。不准把「無項目」「找不到」這類空話當正式產出交出去。',
    // 排程與健檢輪（新使用者實測）：缺什麼要用使用者的話講、不夾雜他語
    '說明缺什麼時用使用者聽得懂的話講——只講「缺哪些資料、從哪裡拿得到」，不提工具、連線、指令或系統名稱。',
    '全篇使用與「要求」相同的語言，不夾雜其他語言的字詞（專有名詞照原文除外）。',
    ...(roleContext ? ['', '# 角色與情境', roleContext] : []),
    '',
    `# 這一步：${title}`,
    '',
    '# 要求',
    instruction,
    ...(background ? ['', '# 背景資料', background] : []),
    ...(constraints ? ['', '# 限制條件（不可違反）', constraints] : []),
    ...(examples ? ['', '# 範例（照這個樣子）', examples] : []),
    ...(attachments?.length ? ['', '# 參考檔案（先用你的檔案讀取能力逐一打開看，照裡面的規格與風格做）', ...attachments.map((p) => `- ${p}`)] : []),
    ...(outputFormat ? ['', '# 產出格式要求（嚴格遵守）', outputFormat] : []),
    ...(creativity && CREATIVITY_TEXT[creativity] ? ['', '# 風格', CREATIVITY_TEXT[creativity]] : []),
    ...(reviewFocus ? ['', '# 交件前自我檢查（使用者也會用同一標準驗收）', reviewFocus] : []),
    ...fileRulesSection(fileMode),
    '',
    '# 上一步的產出（你的輸入）',
    upstream || '（這是第一步，沒有上游輸入）',
  ].join('\n');
}

// `--output-format json` 的回覆解析：result=產出文字、usage=用量、is_error=宿主層失敗。
// 防呆：宿主版本差異解析不出 JSON 時，整段當純文字產出用（寧可少記一筆帳，不准炸掉執行）。
function parseHostResult(raw) {
  try {
    const j = JSON.parse(raw);
    if (j && j.type === 'result') {
      const u = j.usage ?? {};
      return {
        text: String(j.result ?? '').trim(),
        isError: j.is_error === true,
        usage: {
          model: j.modelUsage ? (Object.keys(j.modelUsage)[0] ?? null) : null,
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          cost_usd: j.total_cost_usd ?? null,
        },
      };
    }
  } catch { /* 落到純文字模式 */ }
  return { text: String(raw).trim(), isError: false, usage: null };
}

export function createHostAdapter({ timeoutMs = 300_000, spawnFn = defaultSpawn } = {}) {
  let usageSink = null; // 每次宿主呼叫的用量帳（儀表板輪）——server 接進 usage ledger
  function collect(child, timeout, onDone, onFail) {
    let out = '';
    let err = '';
    let settled = false;
    const timer = timeout
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          onFail(new HostError('這一步等太久沒有回應，已先停下。可以按「重試這步」再來一次。', 'TIMEOUT'));
        }, timeout)
      : null;
    const settle = (fn, v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(v);
    };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => settle(onFail, new HostError(UNAVAILABLE_MSG, 'UNAVAILABLE')));
    child.on('close', (code) => {
      if (code === 0) return settle(onDone, String(out).trim());
      const detail = `${err}\n${out}`.trim(); // claude 的錯誤有時走 stdout
      if (/authenticat|oauth|login/i.test(detail)) {
        return settle(onFail, new HostError('Claude 的登入過期了——請開終端機執行 claude 重新登入，回來按「重試這步」。你的流程庫都在，不會不見。', 'UNAVAILABLE'));
      }
      settle(onFail, new HostError(`這一步執行失敗（Claude 回報：${detail.slice(0, 200) || `結束碼 ${code}`}）。可以按「重試這步」。`, 'FAILED'));
    });
  }

  // 收到宿主回覆：記帳（有帳必記，失敗的呼叫也花了 token）→ is_error 轉人話錯誤 → 回產出文字
  function settleParsed(raw, meta, model, onDone, onFail) {
    const r = parseHostResult(raw);
    if (r.usage && usageSink) {
      const u = r.usage;
      try {
        usageSink({
          at: new Date().toISOString(),
          ...(meta ?? {}),
          model: u.model ?? model ?? null,
          input_tokens: u.input_tokens,
          output_tokens: u.output_tokens,
          cache_creation_input_tokens: u.cache_creation_input_tokens,
          cache_read_input_tokens: u.cache_read_input_tokens,
          cost_usd: u.cost_usd,
        });
      } catch { /* 記帳失敗不擋執行 */ }
    }
    if (r.isError) return onFail(new HostError(`這一步執行失敗（Claude 回報：${r.text.slice(0, 200) || '（沒有說明）'}）。可以按「重試這步」。`, 'FAILED'));
    onDone(r.text);
  }

  return {
    // 卷宗（儀表板輪）：組 prompt 的唯一函式導出——執行前存檔的全文＝實際送出的全文
    renderPrompt: (fields) => buildPrompt(fields),

    setUsageSink(fn) { usageSink = fn; },

    async executeNode({ model, meta, ...fields }) {
      return new Promise((resolve, reject) => {
        // 步驟要能自己抓資料：headless 預設不授權工具，蒐集類步驟會空手而回（2026-09-02 實測踩到）。
        // 只放行讀類工具（搜尋／抓網頁／讀檔=附件功能要用）；寫檔與執行指令不放行——匯入的流程指示不可信任。
        const args = ['-p', '--output-format', 'json', '--allowedTools', 'WebSearch', 'WebFetch', 'Read'];
        // 產檔模式（產檔輪定案）：只在流程開了產檔權限時，加放行寫檔與 node 執行，工作目錄鎖在這趟的產出資料夾
        const fm = fields.fileMode;
        if (fm) args.push('Write', 'Edit', 'Bash(node *)');
        if (model) args.push('--model', model);
        const child = spawnFn(args, fm ? { cwd: fm.cwd, env: { ...process.env, NODE_PATH: fm.nodePath ?? BUNDLED_NODE_PATH } } : {});
        collect(child, timeoutMs, (raw) => settleParsed(raw, meta, model, resolve, reject), reject);
        child.stdin.write(buildPrompt(fields));
        child.stdin.end();
      });
    },

    // 通用補全：原文 prompt 直送宿主（業務 prompt 由呼叫端組，本殼不加料）
    async complete({ prompt, timeoutMs: t, meta } = {}) {
      return new Promise((resolve, reject) => {
        const child = spawnFn(['-p', '--output-format', 'json']);
        collect(child, t ?? timeoutMs, (raw) => settleParsed(raw, meta, null, resolve, reject), reject);
        child.stdin.write(prompt);
        child.stdin.end();
      });
    },

    async checkAvailable() {
      return new Promise((resolve) => {
        let child;
        try {
          child = spawnFn(['--version']);
        } catch {
          return resolve(false);
        }
        collect(child, 15_000, () => resolve(true), () => resolve(false));
        child.stdin?.end?.();
      });
    },
  };
}
