// host-adapter — 與宿主（Claude）的一切接點（ADR-001：宿主知識只准存在這裡）。
// AI 呼叫走 `claude -p` headless 子行程，prompt 由 stdin 餵入。
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 工人產檔用剝繭自帶的 Node 套件（docx／exceljs／docxtemplater／pizzip），NODE_PATH 指過去，工人不用自己裝
export const BUNDLED_NODE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');

export class HostError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const UNAVAILABLE_MSG = '連不上 Claude——請確認 Claude Code 已安裝、指令列打 claude 打得開。你的 Workflow 庫都在，不會不見。';

// 不帶行李模式（BOJIAN_LEAN，2026-09-08 起預設開，A／B 測試後定案）：宿主每次呼叫都會自帶一整包
// 預設脈絡（系統提示、外掛、斜線指令、全部工具定義），一句話的 prompt 也要送近六萬 token。輕裝＝自己給
// 系統提示、不載外掛與斜線指令、--tools 只送這一步用得到的工具定義。--allowedTools（權限閘）不動，兩種
// 模式一樣嚴。要退回帶行李：環境變數 BOJIAN_LEAN 設成 `0`／`false`／`off`，或呼叫端明寫 `lean: false`。
// 工人提示要自帶「怎麼做事」的規矩：預設脈絡拿掉之後，工人不會自己補——A／B 第一回合輕裝五步喊了四次
// 資料不全（帶行李零次），還寫出沒有輸入依據的「約 14 件」。所以判斷該做、資料不全的門檻、數字不准編，全寫進來。
export const LEAN_WORKER_SYSTEM = '你是剝繭流程裡的一名工人。只照接下來訊息裡的指示與規則做事，訊息沒要求的不要做；全篇語言跟指示一致。被要求做判斷、評分、排序或建議時，就用手上的資料判斷，估計的地方標明「估計」；只有這一步必要的原始資料真的沒給才回報資料不全，不要因為資料不完整就停下。數字只寫原始資料或上一步裡有的，沒有的寫「未知」，不准編。';
export const LEAN_GENERIC_SYSTEM = '只照接下來訊息裡的指示做事，不做別的；只輸出訊息要求的格式；語言跟訊息一致。';
const LEAN_FLAGS = ['--strict-mcp-config', '--disable-slash-commands'];

// 輕裝連接器例外：輕裝的 --strict-mcp-config 會把使用者掛在宿主上的連接器整批擋掉——
// 探針實測（reviews/-實走-2026-09-09/連接器探針.md）：不推它，行事曆的九個工具就回來了；
// --tools "" 不是兇手（照推也看得到連接器）。所以 meta.mcp 的呼叫只少推這一個旗標，其餘輕裝照舊，
// 並把行事曆工具加進權限閘（只送定義不放行＝工人一直撞牆）。代價是那一次呼叫多約 7 萬 token，
// 所以只給真的要碰行事曆的呼叫（快照抓取、下游要等它敲時間的步驟）。
export const CALENDAR_TOOLS = 'mcp__claude_ai_Google_Calendar__*';
const leanFlagsFor = (meta) => (meta?.mcp ? LEAN_FLAGS.filter((f) => f !== '--strict-mcp-config') : LEAN_FLAGS);

function defaultSpawn(args, extra = {}) {
  // 工人在中立目錄開工（已定案）：繼承伺服器 cwd 會吃到使用者本地的專案
  // CLAUDE.md 與 hooks——實案：工作區的收工門禁把步驟最後一句換成「本次無入庫項」，成品被調包。
  // 本專案會公開，任何使用者的本地規矩都不該套在步驟工人頭上；附件走絕對路徑，不受 cwd 影響。
  // 產檔模式例外：cwd 改成這趟執行的產出資料夾（extra.cwd），env 帶 NODE_PATH 給自帶套件。
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

// 產檔規則段：只在產檔模式加——工人在產出資料夾用自帶套件寫真檔，文字產出改交摘要
function fileRulesSection(fileMode) {
  if (!fileMode) return [];
  const ext = fileMode.fileName.slice(fileMode.fileName.lastIndexOf('.') + 1).toLowerCase();
  const lib = {
    xlsx: 'exceljs（開新檔或 workbook.xlsx.readFile 開範本再寫格）',
    pptx: "pptxgenjs（const p = new PptxGenJS(); p.layout = 'LAYOUT_16x9'; 每張 p.addSlide() 後用 addText／addTable 放內容；最後 await p.writeFile({ fileName })）",
  }[ext] ?? 'docx（從零建檔）或 docxtemplater＋pizzip（套範本填欄）';
  return [
    '',
    '# 產檔規則（嚴格遵守）',
    `目前工作目錄就是這一步的產出資料夾。用 node 腳本把成品寫成「${fileMode.fileName}」（就放在目前目錄，檔名一個字都不能改）。可用套件：${lib}；NODE_PATH 已設好，直接 require，不准安裝任何套件。`,
    '只准在目前目錄寫檔與執行 node；不准讀寫目前目錄以外的任何路徑（參考檔除外）、不准連網做產檔以外的事。',
    ...(ext === 'xlsx' ? ['Excel 公式格要同時寫入算好的結果（exceljs：cell.value = { formula, result }），預覽與不重算的閱讀器才看得到數字。'] : []),
    // 簡報的兩個常見翻車點——把整段文章塞進一張，以及為了中文字型去連網或讀系統檔（都不必，開啟端自己有字型）
    ...(ext === 'pptx' ? ['簡報一張投影片只放一個重點，標題與內文分開加；條列用 addText 的 bullet、比較用 addTable，不要把整段文章塞進一個文字框。中文不必嵌字型也不必連網抓字型，開啟的人電腦上有。'] : []),
    ...(fileMode.templatePath ? [ext === 'pptx'
      ? `範本在「${fileMode.templatePath}」：照它的版面配置與色調自己排（簡報套件不吃 pptx 範本檔，不要嘗試讀它當範本）。`
      : `範本在「${fileMode.templatePath}」：套用它、只填內容不改版型（Word 用 docxtemplater 填欄或以其樣式為準；Excel 用 exceljs 開範本寫格）。`] : []),
    '檔案寫好後，你的文字產出＝檔案內容的重點摘要（下一步要用它），不要貼程式碼、不要解釋怎麼做的。檔案沒寫成功就在第一行輸出「【資料不全】」加原因。',
  ];
}

// 停點修改後 AI 擬的規則，往下游每一步的指示都要守
function editRulesSection(editRules) {
  if (!editRules?.length) return [];
  return ['', '# 使用者在停點改過的要求（後面每一步都要守）', ...editRules.map((r) => `- ${r}`)];
}

// 查核攔下重做——把上次錯在哪、原始資料寫什麼逐條列給工人修
function redoSection(redo) {
  if (!redo || (!redo.blocks?.length && !redo.missing?.length)) return [];
  const lines = [
    ...(redo.blocks ?? []).map((b) => `- 錯在哪：${b.detail}｜成品寫：${b.claim}｜原始資料：${b.source}`),
    ...(redo.missing ?? []).map((m) => `- 原始資料沒有「${m.claim}」，明寫未知或估計，不准編`),
  ];
  return ['', '# 上一次交貨被查核退回（必須逐條修正，其餘保持）', ...lines];
}

// 使用者「回話重做」留的話，緊接在查核退回段之後（沒有 redo 也照樣出現在這個位置）
function checkNoteSection(checkNote) {
  return checkNote ? ['', '# 使用者的回話（這次必須照做）', checkNote] : [];
}

// 長欄位值不代進句子——原文另存這一段，指示裡只留一句指向它的提示（見 runner injectParams）
function paramBlocksSection(paramBlocks) {
  if (!paramBlocks?.length) return [];
  return ['', '# 欄位內容（原文）', ...paramBlocks.flatMap(({ label, value }) => [`【欄位：${label}】`, value])];
}

// 這趟的開場備註與這一步的交接。是「加上去的話」不是必守——跟使用者的要求衝突時以要求為準
function supervisorSection(supervisorNotes) {
  if (!supervisorNotes?.length) return [];
  return ['', '# 監工交接（這趟的備註，照做；跟「要求」衝突時以「要求」為準）', ...supervisorNotes.map((t) => `- ${t}`)];
}

// 同心圓的核心圈「關於你」（認識卡），每一步都帶；插在「角色與情境」之前——紙（開場五句）→核心→流程
function coreSection(coreNotes) {
  if (!coreNotes?.length) return [];
  return ['', '# 關於你（每一步都照這些做；跟「要求」衝突時以「要求」為準）', ...coreNotes.map((t) => `- ${t}`)];
}

// 群組圈「分類守則」（分類的規矩，查核員也當必守）；插在「限制條件」之後、「停點改過的要求」之前——群組→這一次
function groupRulesSection(groupRules, groupName) {
  if (!groupRules?.length) return [];
  return ['', `# 分類守則（分類「${groupName ?? ''}」，一定要守）`, ...groupRules.map((t) => `- ${t}`)];
}

// （三層共用檔）：公司規範與部門規範——規範類每步都帶、全文貼進工作單（不是給路徑），查核員也拿同一份當必守。
// 插在「限制條件」之後、「分類守則」之前——外圈在前：公司→部門→分類守則；空層不印段。每檔 [{name, text}]
// 規範內文行首的 #（一到六個）一律降一級、###### 封頂——手冊自己的標題不能跟工作單的段標題同級
const demote = (text) => String(text ?? '').replace(/^(#{1,6})(?=\s)/gm, (m) => (m.length < 6 ? `#${m}` : m));
function sharedRulesSection(companyRules, deptRules, groupName) {
  const files = (list) => list.flatMap((f) => [`## ${f.name}`, demote(f.text)]);
  return [
    ...(companyRules?.length ? ['', '# 公司規範（每一步都照做；查核員也會對）', ...files(companyRules)] : []),
    ...(deptRules?.length ? ['', `# 部門規範（分類「${groupName ?? ''}」，同上）`, ...files(deptRules)] : []),
  ];
}

function buildPrompt({ title, instruction, roleContext, background, constraints, examples, outputFormat, creativity, reviewFocus, attachments, upstream, fileMode, paramBlocks, editRules, redo, checkNote, supervisorNotes, coreNotes, groupRules, groupName, companyRules, deptRules }) {
  return [
    '你是「剝繭」流程裡的一個步驟執行者。只輸出這一步的產出內容本身——不要開場白、不要收尾語、不要解釋你做了什麼。',
    '這不是對話：沒有人會回覆你，你的產出會直接交給下一步（或給使用者過目，他只能核可或動手修改）。不要反問、不要邀請回覆、不要用「要哪個再說」收尾。任務要你提供多個選項時，自己選定一個推薦，讓產出以推薦版本為主體、備選附在後面標明。',
    '特例：如果要求裡指定的資料你拿不齊或拿不到——缺月份、缺欄位、少一段、工具不可用、搜尋無結果、上游沒交貨都算——第一行輸出「【資料不全】」加一句缺什麼，換行後再給你能給的部分。不准把「無項目」「找不到」這類空話當正式產出交出去。',
    // （新使用者實測）：缺什麼要用使用者的話講、不夾雜他語
    '說明缺什麼時用使用者聽得懂的話講——只講「缺哪些資料、從哪裡拿得到」，不提工具、連線、指令或系統名稱。',
    '全篇使用與「要求」相同的語言，不夾雜其他語言的字詞（專有名詞照原文除外）。',
    ...coreSection(coreNotes),
    ...(roleContext ? ['', '# 角色與情境', roleContext] : []),
    '',
    `# 這一步：${title}`,
    '',
    '# 要求',
    instruction,
    ...(background ? ['', '# 背景資料', background] : []),
    ...(constraints ? ['', '# 限制條件（不可違反）', constraints] : []),
    ...sharedRulesSection(companyRules, deptRules, groupName),
    ...groupRulesSection(groupRules, groupName),
    ...editRulesSection(editRules),
    ...(examples ? ['', '# 範例（照這個樣子）', examples] : []),
    ...(attachments?.length ? ['', '# 參考檔案（先用你的檔案讀取能力逐一打開看，照裡面的規格與風格做）', ...attachments.map((p) => `- ${p}`)] : []),
    ...(outputFormat ? ['', '# 產出格式要求（嚴格遵守）', outputFormat] : []),
    ...(creativity && CREATIVITY_TEXT[creativity] ? ['', '# 風格', CREATIVITY_TEXT[creativity]] : []),
    ...(reviewFocus ? ['', '# 交件前自我檢查（使用者也會用同一標準驗收）', reviewFocus] : []),
    ...redoSection(redo),
    ...checkNoteSection(checkNote),
    ...fileRulesSection(fileMode),
    ...paramBlocksSection(paramBlocks),
    ...supervisorSection(supervisorNotes),
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

// 輕裝與否解析：option 明寫優先；其次環境變數 BOJIAN_LEAN（`0`/`false`/`off` 退回帶行李，設別的值算輕裝）；
// 都沒給就預設輕裝。
const LEGACY_ENV_VALUES = new Set(['0', 'false', 'off']);
function resolveLean(explicit) {
  if (explicit !== undefined) return explicit;
  const envVal = process.env.BOJIAN_LEAN;
  if (envVal === undefined) return true;
  return !LEGACY_ENV_VALUES.has(envVal);
}

export function createHostAdapter({ timeoutMs = 300_000, spawnFn = defaultSpawn, lean } = {}) {
  // 輕裝與否開工時定一次
  const leanMode = resolveLean(lean);
  let usageSink = null; // 每次宿主呼叫的用量帳——server 接進 usage ledger
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
    // 先定編碼再累加：Buffer 直接 += 成字串＝每塊各自解碼，跨塊的中文會被切成兩個 U+FFFD。
    // Node 的 pipe 每 64KB 切一塊，長中文報告必中；JSON.parse 照樣成功所以全程無聲（2026-09-18 審查實測）
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => settle(onFail, new HostError(UNAVAILABLE_MSG, 'UNAVAILABLE')));
    child.on('close', (code) => {
      if (code === 0) return settle(onDone, String(out).trim());
      const detail = `${err}\n${out}`.trim(); // claude 的錯誤有時走 stdout
      if (/authenticat|oauth|login/i.test(detail)) {
        return settle(onFail, new HostError('Claude 的登入過期了——請開終端機執行 claude 重新登入，回來按「重試這步」。你的 Workflow 庫都在，不會不見。', 'UNAVAILABLE'));
      }
      settle(onFail, new HostError(`這一步執行失敗（Claude 回報：${detail.slice(0, 200) || `結束碼 ${code}`}）。可以按「重試這步」。`, 'FAILED'));
    });
  }

  // 送工作單：stdin 的 'error' 不歸 child.on('error') 管（那支只管 ChildProcess）。
  // 工作單常有數萬字、write 是非同步排空的，子行程先死（claude 沒裝／登入過期／cmd 立刻結束）
  // 就會在沒有監聽器的 stdin 上丟 EPIPE＝未捕捉例外＝整個伺服器連同所有進行中的 run 一起死。
  // 這裡只負責「不炸」；真正的錯誤訊息仍由 collect 的 close／error 那兩路給出人話。
  function sendPrompt(child, text) {
    child.stdin.on('error', () => {});
    try {
      child.stdin.write(text);
      child.stdin.end();
    } catch { /* 管線已經關了：collect 會收到 close／error 並回報 */ }
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
          lean: leanMode, // A/B 才分得出這筆是不是輕裝呼叫
        });
      } catch { /* 記帳失敗不擋執行 */ }
    }
    if (r.isError) return onFail(new HostError(`這一步執行失敗（Claude 回報：${r.text.slice(0, 200) || '（沒有說明）'}）。可以按「重試這步」。`, 'FAILED'));
    onDone(r.text);
  }

  return {
    // 卷宗：組 prompt 的唯一函式導出——執行前存檔的全文＝實際送出的全文
    renderPrompt: (fields) => buildPrompt(fields),

    setUsageSink(fn) { usageSink = fn; },

    isLean: () => leanMode,

    async executeNode({ model, meta, web, ...fields }) {
      return new Promise((resolve, reject) => {
        // 產檔模式（定案）：只在流程開了產檔權限時，加放行寫檔與 node 執行，工作目錄鎖在這趟的產出資料夾
        const fm = fields.fileMode;
        const args = ['-p', '--output-format', 'json'];
        // 這一步關掉查網（節點勾了「監工可以開關查網」且監工說不用）→ 工具定義與權限閘兩邊都拿掉，
        // 只送定義不關權限＝工人還是查得到，只關權限不撤定義＝工人一直撞牆
        const readTools = web === false ? ['Read'] : ['WebSearch', 'WebFetch', 'Read'];
        // 輕裝：自己給系統提示、不載外掛與斜線指令、工具定義只送這一步用得到的
        //（放行了卻沒送定義＝工人根本看不到那個工具，所以產檔模式要把寫檔三件補進 --tools）
        if (leanMode) {
          args.push(...leanFlagsFor(meta), '--system-prompt', LEAN_WORKER_SYSTEM,
            '--tools', [...readTools, ...(fm ? ['Write', 'Edit', 'Bash'] : [])].join(','));
        }
        // 步驟要能自己抓資料：headless 預設不授權工具，蒐集類步驟會空手而回（2026-09-02 實測踩到）。
        // 只放行讀類工具（搜尋／抓網頁／讀檔=附件功能要用）；寫檔與執行指令不放行——匯入的流程指示不可信任。
        args.push('--allowedTools', ...readTools, ...(meta?.mcp ? [CALENDAR_TOOLS] : []));
        if (fm) args.push('Write', 'Edit', 'Bash(node *)');
        if (model) args.push('--model', model);
        const child = spawnFn(args, fm ? { cwd: fm.cwd, env: { ...process.env, NODE_PATH: fm.nodePath ?? BUNDLED_NODE_PATH } } : {});
        collect(child, timeoutMs, (raw) => settleParsed(raw, meta, model, resolve, reject), reject);
        sendPrompt(child, buildPrompt(fields));
      });
    },

    // 通用補全：原文 prompt 直送宿主（業務 prompt 由呼叫端組，本殼不加料）
    async complete({ prompt, timeoutMs: t, meta } = {}) {
      return new Promise((resolve, reject) => {
        // 查核、停點改規則等通用補全都不用工具，輕裝時工具定義一個都不送
        const args = ['-p', '--output-format', 'json'];
        if (leanMode) args.push(...leanFlagsFor(meta), '--system-prompt', LEAN_GENERIC_SYSTEM, '--tools', '');
        // 連接器例外（快照抓取）：要用行事曆就得放行它的工具，帶不帶行李都一樣
        if (meta?.mcp) args.push('--allowedTools', CALENDAR_TOOLS);
        const child = spawnFn(args);
        collect(child, t ?? timeoutMs, (raw) => settleParsed(raw, meta, null, resolve, reject), reject);
        sendPrompt(child, prompt);
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
