// host-adapter — 與宿主（Claude）的一切接點（ADR-001：宿主知識只准存在這裡）。
// AI 呼叫走 `claude -p` headless 子行程，prompt 由 stdin 餵入。
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 工人產檔用剝繭自帶的 Node 套件（docx／exceljs／docxtemplater／pizzip），NODE_PATH 指過去，工人不用自己裝
// 內建的中文字型（產 PDF 用）：PDF 的中文一定要嵌字型，不嵌整份是空白或豆腐格
export const CJK_FONT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts', 'NotoSansTC-Regular.otf');
export const BUNDLED_NODE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');

// 籠子（ADR-009 第 3 點）：工人的程式只能經 `node <cage.mjs> <腳本>` 執行，權限閘只放行這一條。
// 給工人照抄的寫法用正斜線＋雙引號（Git Bash 會吃反斜線；路徑含中文，加引號最保險）。
export const CAGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cage.mjs');
const fwd = (p) => p.split('\\').join('/');
export const CAGE_CMD = `node "${fwd(CAGE_PATH)}"`;
// 權限規則要涵蓋工人可能打出的寫法：正斜線／反斜線、不加引號／雙引號／單引號（Claude Code 的規則對引號逐字比對——
// 文件例：`git 'push' origin main` 不命中 `Bash(git push *)`）。實測（2026-09-23）：正斜線加不加雙引號都命中；
// 規則對 &&／;／| 逐段比對，接 `node -e` 這類別的指令整句被拒；接 echo 這類內建唯讀指令會放（本來就放行）。
function cageBashRules(cagePath) {
  const forms = [...new Set([fwd(cagePath), cagePath.split('/').join('\\')])];
  return forms.flatMap((f) => [`Bash(node ${f} *)`, `Bash(node "${f}" *)`, `Bash(node '${f}' *)`]);
}
export const CAGE_BASH_RULES = Object.freeze(cageBashRules(CAGE_PATH));
// 寫檔限制在本趟資料夾：Claude Code 只看 Edit(<pattern>)（Write 也歸它管，Write(<pattern>) 會被忽略——文件 permissions.md）；
// 絕對路徑用 `//` 開頭，Windows 的 `C:\x` 要寫成 `//c/x`；gitignore 特殊字元逐字跳脫。實測（2026-09-23，含空格路徑）：
// cwd 內 Write 放行、上一層 Write 被拒。
export function editRuleFor(cwd) {
  let p = fwd(String(cwd)).replace(/\/+$/, '');
  const m = /^([A-Za-z]):(\/.*)?$/.exec(p);
  if (m) p = `/${m[1].toLowerCase()}${m[2] ?? ''}`;
  p = p.replace(/[[\]*?]/g, (c) => `\\${c}`);
  return `Edit(/${p}/**)`;
}

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
// 工人不繼承使用者的輸出風格（2026-09-24 修少給輪驗收時抓到）：headless 子行程就算給了 --system-prompt，宿主仍會把
// 使用者自己設的 output style 疊上去——月報成品裡冒出「壹、貳、」這種使用者跟 Claude 對話用的編號。--settings 內嵌 JSON
// 把 outputStyle 釘回 default，工人與查核員等通用補全一律帶。實測：同一份卷宗指示重送，不帶＝出現，帶＝消失。
export const WORKER_SETTINGS = JSON.stringify({ outputStyle: 'default' });

// 輕裝連接器例外：輕裝的 --strict-mcp-config 會把使用者掛在宿主上的連接器整批擋掉——
// 探針實測（reviews/-實走-2026-09-09/連接器探針.md）：不推它，行事曆的九個工具就回來了；
// --tools "" 不是兇手（照推也看得到連接器）。所以 meta.mcp 的呼叫只少推這一個旗標，其餘輕裝照舊，
// 並把行事曆工具加進權限閘（只送定義不放行＝工人一直撞牆）。代價是那一次呼叫多約 7 萬 token，
// 所以只給真的要碰行事曆的呼叫（快照抓取、下游要等它敲時間的步驟）。
// 連線輪（ADR-006 第 5 點）：原本是 mcp__claude_ai_Google_Calendar__*（連建立／刪除行程都放行），
// 收窄成行事曆的讀類工具逐一列名；寫類另列進 --disallowedTools 當第二道保險。
const CAL_PREFIX = 'mcp__claude_ai_Google_Calendar__';
export const CALENDAR_TOOLS = Object.freeze(['list_calendars', 'list_events', 'get_event', 'search_events', 'suggest_time'].map((t) => CAL_PREFIX + t));
export const CALENDAR_BLOCKED = Object.freeze(['create_event', 'update_event', 'delete_event', 'respond_to_event'].map((t) => CAL_PREFIX + t));
// 看得到外部服務的呼叫：行事曆例外（meta.mcp）或這一步勾了服務（connectors）——只有這兩種不推 --strict-mcp-config
const leanFlagsFor = (open) => (open ? LEAN_FLAGS.filter((f) => f !== '--strict-mcp-config') : LEAN_FLAGS);

// 這一步勾的服務（runner 用 connectors.toolsFor 算好）→ 權限閘：讀類逐一放行、寫類與沒勾的服務整家擋。
// 行事曆例外同時開著時，行事曆不能被「沒勾的服務」那道擋掉（擋優先於放行）
function connectorGates(conn, calendar) {
  if (!conn || !Array.isArray(conn.names) || !conn.names.length) {
    return calendar ? { allow: [...CALENDAR_TOOLS], deny: [...CALENDAR_BLOCKED] } : { allow: [], deny: [] };
  }
  const allow = [...new Set([...(conn.read ?? []), ...(calendar ? CALENDAR_TOOLS : [])])];
  const others = (conn.others ?? []).filter((d) => !(calendar && d === `${CAL_PREFIX}*`));
  const deny = [...new Set([...(conn.blocked ?? []), ...(calendar ? CALENDAR_BLOCKED : []), ...others])];
  return { allow, deny };
}

// 殺整棵：Windows 下子行程是 cmd /c claude，只殺 cmd 的話底下的 claude 照跑（照樣去打模型花額度）
// 順序要緊（2026-09-22 實測）：先 kill() 掉 cmd 的話，taskkill 找不到根就沿不下去，底下的 claude 變孤兒照跑——
// 所以 Windows 等 taskkill 做完才補一刀 kill()；taskkill 起不來才直接 kill()。
// spawnFn／platform 只為了回歸測試能注入假的（L052：不准真的殺行程），預設＝真 spawn＋本機平台，對外行為不變。
export function killTree(child, { spawnFn = spawn, platform = process.platform } = {}) {
  const fallback = () => { try { child?.kill?.(); } catch { /* 已經結束 */ } };
  if (platform === 'win32' && Number.isInteger(child?.pid)) {
    try {
      const tk = spawnFn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      tk.on('error', fallback);
      tk.on('exit', fallback);
      return;
    } catch { /* 起不來就退回 kill() */ }
  }
  fallback();
}

// 連線清單（ADR-006 第 2 點）：起一個子行程讀宿主的啟動訊息，第一筆 system/init 帶 mcp_servers 與全部工具名；
// 讀到就殺整棵，不讓它進到模型呼叫（init 在模型呼叫前送出＝不花額度）。沒讀到 init 就結束／逾時＝HostError。
// 不推 --strict-mcp-config（要看得到使用者的服務）；--tools "" 不送內建工具。
// 實測（2026-09-22）：init 一送出，模型請求幾乎同時發出，殺得再快也來不及（收手後照樣收到 assistant／result，
// 一次約 8 萬 token）。所以這支子行程把模型 API 位址指到本機一個沒人聽的埠——init（含 claude.ai 連接器清單，
// 走的不是這個位址）照常送出，模型請求連不上、不花額度；讀到 init 就收手，不等它重試。
export const LIST_ONLY_API_URL = 'http://127.0.0.1:9';
export function readHostInit({ spawnFn = defaultSpawn, killFn = killTree, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--disable-slash-commands', '--system-prompt', 'x'],
        { env: { ...process.env, ANTHROPIC_BASE_URL: LIST_ONLY_API_URL } });
    } catch {
      return reject(new HostError(UNAVAILABLE_MSG, 'UNAVAILABLE'));
    }
    let buf = '';
    let err = '';
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { killFn(child); } catch { /* 盡力 */ }
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new HostError('等 Claude 回報已連服務等太久，已先停下——稍後再按「重新檢查」。', 'TIMEOUT')), timeoutMs);
    child.stdout.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j && j.type === 'system' && j.subtype === 'init') return finish(resolve, j);
      }
    });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', () => finish(reject, new HostError(UNAVAILABLE_MSG, 'UNAVAILABLE')));
    child.on('close', () => {
      if (/authenticat|oauth|login/i.test(err)) return finish(reject, new HostError('Claude 的登入過期了——請開終端機執行 claude 重新登入，再按「重新檢查」。', 'UNAVAILABLE'));
      finish(reject, new HostError(`Claude 沒回報已連的服務（${err.trim().slice(0, 120) || '結束前沒有啟動訊息'}）——稍後再按「重新檢查」。`, 'FAILED'));
    });
    child.stdin?.on?.('error', () => {});
    try { child.stdin?.write?.('ok'); child.stdin?.end?.(); } catch { /* 管線已關：close 會回報 */ }
  });
}

function defaultSpawn(args, extra = {}) {
  // 工人在中立目錄開工（已定案）：繼承伺服器 cwd 會吃到使用者本地的專案
  // CLAUDE.md 與 hooks——實案：工作區的收工門禁把步驟最後一句換成「本次無入庫項」，成品被調包。
  // 本專案會公開，任何使用者的本地規矩都不該套在步驟工人頭上；附件走絕對路徑，不受 cwd 影響。
  // 程式／產檔模式例外：cwd 改成這趟執行的產出資料夾（extra.cwd），env 帶 NODE_PATH 給自帶套件與籠子設定（BOJIAN_CAGE_*）。
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
    pdf: 'pdfkit（const d = new PDFDocument({ size: "A4", margin: 50 }); d.pipe(fs.createWriteStream(檔名)); … d.end()）',
  }[ext] ?? 'docx（從零建檔）或 docxtemplater＋pizzip（套範本填欄）';
  return [
    '',
    '# 產檔規則（嚴格遵守）',
    `目前工作目錄就是這一步的產出資料夾。寫一支 node 腳本（.js，放在目前目錄）把成品寫成「${fileMode.fileName}」（就放在目前目錄，檔名一個字都不能改）。可用套件：${lib}；NODE_PATH 已設好，直接 require，不准安裝任何套件。`,
    `執行腳本一律照這個寫法：${CAGE_CMD} 檔名.js ——只有這種寫法會被放行，直接打 node 或接其他指令一律被拒。`,
    '只准在目前目錄寫檔、只准用上面的包裝指令執行程式；不准讀寫目前目錄以外的任何路徑（參考檔除外）、不准連網做產檔以外的事。腳本一律放目前目錄——不要用任何 scratchpad、暫存或別的資料夾，放別處會被拒跑。',
    // 瘦身（2026-09-24 金絲雀 q5：產檔比 Claude Code 貴 1.5～3.2 倍，一步跑了 verify／cleanup／cleanup2／gen 五支程式）：
    // 一支短程式只負責寫檔；數字沿用上一步，不重算；不寫驗證、清理、預覽腳本；寫成功就結束
    // 數字檔約定（US-110）：前面步驟已把指標寫成 數字-<步驟id>.json（runner 只列此刻真的在的）→ 先讀檔；沒有數字檔＝原句逐字不變
    `只寫一支短程式、只做一件事：把上一步算好的數字與內容寫進檔案。${fileMode.priorNumbersFiles?.length
      ? `數字先讀目前目錄的數字檔：${numbersList(fileMode.priorNumbersFiles)}（Read 打開、或在腳本裡 readFileSync）；數字檔裡有的直接用，沒有的才沿用上一步產出裡的數字；不要重讀原始資料重算；`
      : '數字直接沿用上一步的產出，不要重讀資料重算；'}不要另外寫驗證、清理、預覽、比對的腳本；檔案寫出來就結束，不要反覆改版。`,
    ...(ext === 'xlsx' ? ['Excel 公式格要同時寫入算好的結果（exceljs：cell.value = { formula, result }），預覽與不重算的閱讀器才看得到數字。'] : []),
    // 簡報的兩個常見翻車點——把整段文章塞進一張，以及為了中文字型去連網或讀系統檔（都不必，開啟端自己有字型）
    // PDF 的中文要自己嵌字型，不然整份是空白或豆腐格。字型檔跟著剝繭一起帶，給絕對路徑。
    ...(ext === 'pdf' ? [`PDF 的中文一定要先註冊字型再寫字：d.registerFont('tc', ${JSON.stringify(CJK_FONT)}); d.font('tc');`
      + '不註冊的話整份會是空白或方格。字型檔已經在那個位置，不要去下載、也不要改用系統字型。'] : []),
    ...(ext === 'pptx' ? ['簡報一張投影片只放一個重點，標題與內文分開加；條列用 addText 的 bullet、比較用 addTable，不要把整段文章塞進一個文字框。'
      + '字型不要指定成某個作業系統專有的（例如 Microsoft JhengHei）——換一台電腦開就會跑掉；不寫 fontFace，讓開啟的人用自己的預設中文字型。'] : []),
    ...(fileMode.templatePath ? [ext === 'pptx'
      ? `範本在「${fileMode.templatePath}」：照它的版面配置與色調自己排（簡報套件不吃 pptx 範本檔，不要嘗試讀它當範本）。`
      : `範本在「${fileMode.templatePath}」：套用它、只填內容不改版型（Word 用 docxtemplater 填欄或以其樣式為準；Excel 用 exceljs 開範本寫格）。`] : []),
    '檔案寫好後，你的文字產出＝檔案內容的重點摘要（下一步要用它），不要貼程式碼、不要解釋怎麼做的。檔案沒寫成功就在第一行輸出「【資料不全】」加原因。',
  ];
}

// 程式規則段（ADR-009 第 2、3 點）：流程開了寫檔與執行程式、這一步不是產檔步驟（產檔步驟由產檔規則段講）——
// 有數字就寫程式算、不准心算；程式只能經包裝指令跑。對照測試：心算那一步 2.2～3.7 萬 token、6 趟錯 17 個；寫程式 0.4～0.8 萬、3 趟錯 1 個。
export const PROGRAM_LIBS = 'exceljs、docx、docxtemplater＋pizzip、pptxgenjs、pdfkit';
// 數字檔清單的寫法：「數字-a.json」、「數字-b.json」（程式規則段與產檔規則段共用）
const numbersList = (files) => files.map((f) => `「${f}」`).join('、');
function programRulesSection(exec, fileMode) {
  if (!exec || fileMode) return [];
  return [
    '',
    '# 程式規則（嚴格遵守）',
    '目前工作目錄就是這一步的資料夾。上一步已經算好的數字直接沿用，不要重算；只有這一步需要新的數字（算、統計、分組、排序、比對）而上一步沒給時，才寫一支短的 .js 放在目前目錄、用下面的包裝指令執行，程式只印你要用的那幾個數字，不要把整份資料印出來；不准心算、不准在腦中加總。',
    // 數字檔約定（US-110）：口頭「沿用不重算」管不住（金絲雀 q5 產檔步仍重算、用量 1.61 倍）→ 改成檔案約定：
    // 前面步驟寫好的數字檔（runner 只列此刻真的在本趟資料夾的）先讀；本步算出來的指標由同一支程式寫成 數字-<步驟id>.json 給後步讀
    ...(exec.priorNumbersFiles?.length ? [`目前目錄已有前面步驟算好的數字檔：${numbersList(exec.priorNumbersFiles)}——先用 Read 打開讀，裡面有的數字直接用、不重算；只有它們沒有的數字才寫程式算。`] : []),
    // 金絲雀 q2（2026-09-24）：純寫作步驟看到「還要寫成數字檔」就在客戶信開頭寫「無新增數字需計算，不需寫程式」——
    // 改成「有算才寫」，並明講這段規則不准滲進產出
    ...(exec.numbersFile ? [`如果這一步真的寫了程式算數字，算出來要用的數字除了印出來，還要由同一支程式寫成「${exec.numbersFile}」放目前目錄：JSON 物件，鍵＝指標名（用成品裡會出現的名稱），值＝數字（不是字串）。`, '這些規則只管你怎麼做事：產出裡不要提到程式、數字檔，也不要寫「不需計算」「無需寫程式」這類話。'] : []),
    `執行程式一律照這個寫法：${CAGE_CMD} 檔名.js ——只有這種寫法會被放行，直接打 node 或接其他指令一律被拒。`,
    `可用套件：${PROGRAM_LIBS}（NODE_PATH 已設好，直接 require）；不准安裝任何套件。`,
    '不准連網；不准讀寫目前目錄以外的路徑（參考檔除外）。',
    '程式碼不要貼進產出——產出只放結果。腳本一律放目前目錄——不要用任何 scratchpad、暫存或別的資料夾，放別處會被拒跑。',
    // 順口算的數字（2026-09-24 使用者問「為什麼數字會錯」）：幾十趟裡程式印出的數字沒錯過，錯的全是句子裡臨時冒出的比例、倍數、天數、差額。
    '產出裡出現的每一個比例、倍數、差額、天數，都必須是程式印出來的那一行（要用就讓程式多印一行）；程式沒印出來的數字不准寫，也不准在腦中換算。',
  ];
}

// 停點修改後 AI 擬的規則，往下游每一步的指示都要守
function editRulesSection(editRules) {
  if (!editRules?.length) return [];
  return ['', '# 使用者在停點改過的要求（後面每一步都要守）', ...editRules.map((r) => `- ${r}`)];
}

// 查核攔下重做——把上次錯在哪、原始資料寫什麼逐條列給工人修
// 沒有 source 的（程式對數字攔的 number-unsourced、必守）只印前兩段，不印空的「原始資料：」
function redoSection(redo) {
  if (!redo || (!redo.blocks?.length && !redo.missing?.length)) return [];
  const lines = [
    ...(redo.blocks ?? []).map((b) => `- 錯在哪：${b.detail}｜成品寫：${b.claim}${b.source ? `｜原始資料：${b.source}` : ''}`),
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

// （三層共用檔）：公司規範與分類規範——規範類每步都帶、全文貼進工作單（不是給路徑），查核員也拿同一份當必守。
// 插在「限制條件」之後、「分類守則」之前——外圈在前：公司→分類→分類守則；空層不印段。每檔 [{name, text}]
// 規範內文行首的 #（一到六個）一律降一級、###### 封頂——手冊自己的標題不能跟工作單的段標題同級
const demote = (text) => String(text ?? '').replace(/^(#{1,6})(?=\s)/gm, (m) => (m.length < 6 ? `#${m}` : m));
function sharedRulesSection(companyRules, deptRules, groupName) {
  const files = (list) => list.flatMap((f) => [`## ${f.name}`, demote(f.text)]);
  return [
    ...(companyRules?.length ? ['', '# 公司規範（每一步都照做；查核員也會對）', ...files(companyRules)] : []),
    ...(deptRules?.length ? ['', `# 部門規範（分類「${groupName ?? ''}」，同上）`, ...files(deptRules)] : []),
  ];
}

// 這一步勾的服務（連線輪）：只列名字＋只讀，工人才知道可以去哪裡讀；沒勾＝不印這段（舊工作單逐字不變）
function connectorSection(connectors) {
  const labels = connectors?.labels ?? [];
  if (!labels.length) return [];
  return ['', '# 這一步可以讀的外部服務（只能搜尋、讀取、列出、下載；不能寄出、建立、修改、刪除或分享任何東西）', ...labels.map((l) => `- ${l}`)];
}

function buildPrompt({ title, instruction, roleContext, background, constraints, examples, outputFormat, creativity, reviewFocus, attachments, upstream, fileMode, exec, paramBlocks, editRules, redo, checkNote, supervisorNotes, coreNotes, groupRules, groupName, companyRules, deptRules, connectors }) {
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
    ...connectorSection(connectors),
    // ADR-009 第 1 點：原始檔每一步都看得到——下判斷、找異常、算數字要回原始檔查，不准只靠上一步的整理
    ...(attachments?.length ? ['', '# 參考檔案／原始資料（先用你的檔案讀取能力逐一打開看；要下判斷、找異常、算數字時回這裡查，不要只靠上一步的整理）', ...attachments.map((p) => `- ${p}`)] : []),
    ...(outputFormat ? ['', '# 產出格式要求（嚴格遵守）', outputFormat] : []),
    ...(creativity && CREATIVITY_TEXT[creativity] ? ['', '# 風格', CREATIVITY_TEXT[creativity]] : []),
    ...(reviewFocus ? ['', '# 交件前自我檢查（使用者也會用同一標準驗收）', reviewFocus] : []),
    ...redoSection(redo),
    ...checkNoteSection(checkNote),
    ...fileRulesSection(fileMode),
    ...programRulesSection(exec, fileMode),
    ...paramBlocksSection(paramBlocks),
    ...supervisorSection(supervisorNotes),
    '',
    '# 上一步的產出（你的輸入）',
    // ADR-009 第 5 點：上游整理不再被當成原始資料（實案：AI 真心相信「原始資料沒有記載退貨品項」並寫進報告）
    '這是前面步驟整理過的內容，不是原始資料；跟原始資料衝突時以原始資料為準。',
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
          // 主模型＝寫出最多字的那個。宿主不在 Claude Code 對話裡起（使用者自己的終端機）時，每次呼叫會多一個小的 haiku 側呼叫，
          // modelUsage 會列兩個鍵、haiku 常排第一——2026-09-24 金絲雀被它騙成「Sonnet 跑成 Haiku」；取第一個鍵不對，取主力
          model: j.modelUsage ? (Object.entries(j.modelUsage).sort((a, b) => ((b[1]?.outputTokens ?? 0) - (a[1]?.outputTokens ?? 0)) || ((b[1]?.inputTokens ?? 0) - (a[1]?.inputTokens ?? 0)))[0]?.[0] ?? null) : null,
          models_all: j.modelUsage ? Object.keys(j.modelUsage) : [],
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

    async executeNode({ model, meta, web, connectors, ...fields }) {
      return new Promise((resolve, reject) => {
        // 連線（ADR-006 第 4 點）：這一步勾了服務才看得到外部服務，而且只放行勾的那幾家的讀類工具
        const gates = connectorGates(connectors, !!meta?.mcp);
        const open = !!meta?.mcp || gates.allow.length > 0 || !!connectors?.names?.length;
        // 程式模式（ADR-009）：流程開了「允許寫檔與執行程式」→ runner 帶 exec（每個 AI 步驟）或 fileMode（產檔步驟），
        // 任一存在＝開籠子：放行寫檔（只限本趟資料夾）與包裝指令（只限 node <cage.mjs>），工作目錄鎖在這趟的產出資料夾。
        // 沒有 exec（舊呼叫端、或 runner 那邊還沒落地）籠子照開，只是不寫 exec.log。
        const fm = fields.fileMode;
        const exec = fields.exec;
        const caged = !!(exec || fm);
        const cageCwd = exec?.cwd ?? fm?.cwd;
        // --permission-mode default 一定要明講：使用者全機設定若是 auto（分類器代為批准），headless 工人會把
        // --allowedTools 以外的工具也放過去——實測（2026-09-23）不帶這個旗標時 node -e、寫到 cwd 外全部成功。
        const args = ['-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', WORKER_SETTINGS];
        // 這一步關掉查網（節點勾了「監工可以開關查網」且監工說不用）→ 工具定義與權限閘兩邊都拿掉，
        // 只送定義不關權限＝工人還是查得到，只關權限不撤定義＝工人一直撞牆
        const readTools = web === false ? ['Read'] : ['WebSearch', 'WebFetch', 'Read'];
        // 輕裝：自己給系統提示、不載外掛與斜線指令、工具定義只送這一步用得到的
        //（放行了卻沒送定義＝工人根本看不到那個工具，所以產檔模式要把寫檔三件補進 --tools）
        if (leanMode) {
          args.push(...leanFlagsFor(open), '--system-prompt', LEAN_WORKER_SYSTEM,
            '--tools', [...readTools, ...(caged ? ['Write', 'Edit', 'Bash'] : [])].join(','));
        }
        // 步驟要能自己抓資料：headless 預設不授權工具，蒐集類步驟會空手而回（2026-09-02 實測踩到）。
        // 只放行讀類工具（搜尋／抓網頁／讀檔=附件功能要用）；寫檔與執行指令預設不放行——匯入的流程指示不可信任。
        // 籠子開著時：寫檔只限本趟資料夾（Edit 路徑規則，Write 同歸它管）、Bash 只放行包裝指令（不放 Bash(node *)）
        args.push('--allowedTools', ...readTools, ...gates.allow);
        if (caged) args.push(editRuleFor(cageCwd), ...CAGE_BASH_RULES);
        if (gates.deny.length) args.push('--disallowedTools', ...gates.deny);
        if (model) args.push('--model', model);
        // 籠子的設定走環境變數：工人的 Bash 繼承給 cage.mjs——籠子範圍＝本趟資料夾、可讀＝這一步的參考檔、紀錄＝卷宗 exec.log
        let extra = {};
        if (caged) {
          const reads = (fields.attachments ?? []).filter((a) => typeof a === 'string' && a);
          extra = {
            cwd: cageCwd,
            env: {
              ...process.env,
              NODE_PATH: fm?.nodePath ?? BUNDLED_NODE_PATH,
              BOJIAN_CAGE_DIR: cageCwd,
              BOJIAN_CAGE_READ: reads.join(path.delimiter),
              ...(exec?.logPath ? { BOJIAN_CAGE_LOG: exec.logPath } : {}),
              ...(exec?.outPath ? { BOJIAN_CAGE_OUT: exec.outPath } : {}), // ADR-010：完整 stdout 另存 <步驟>.exec.out（程式對數字的來源）
            },
          };
        }
        const child = spawnFn(args, extra);
        collect(child, timeoutMs, (raw) => settleParsed(raw, meta, model, resolve, reject), reject);
        sendPrompt(child, buildPrompt({ ...fields, connectors }));
      });
    },

    // 通用補全：原文 prompt 直送宿主（業務 prompt 由呼叫端組，本殼不加料）
    async complete({ prompt, timeoutMs: t, meta } = {}) {
      return new Promise((resolve, reject) => {
        // 查核、停點改規則等通用補全都不用工具，輕裝時工具定義一個都不送；權限模式同樣明講 default（見 executeNode）
        const args = ['-p', '--output-format', 'json', '--permission-mode', 'default', '--settings', WORKER_SETTINGS];
        if (leanMode) args.push(...leanFlagsFor(!!meta?.mcp), '--system-prompt', LEAN_GENERIC_SYSTEM, '--tools', '');
        // 連接器例外（快照抓取）：要用行事曆就得放行它的讀類工具（逐一列名），寫類擋掉；帶不帶行李都一樣
        if (meta?.mcp) args.push('--allowedTools', ...CALENDAR_TOOLS, '--disallowedTools', ...CALENDAR_BLOCKED);
        // 查核員關掉思考（2026-09-24 全開版月報題：一次查核輸出 8～13k token、九成是思考；同一份指示重送，關掉＝1.1k、16 秒，
        // 判定表照樣交得出來）。宿主環境變數 MAX_THINKING_TOKENS=0 實測有效；只對 kind='check'，監工、總覽、擬規則照舊
        const child = spawnFn(args, meta?.kind === 'check' ? { env: { ...process.env, MAX_THINKING_TOKENS: '0' } } : {});
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
