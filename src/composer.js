// composer — 用講的建流程：對話紀錄（＋現有草稿）→ 一句話回覆＋整份流程草稿。
// 業務 prompt 在此；宿主呼叫一律走 host-adapter。
import yaml from 'js-yaml';
import { validateWorkflow, SchemaError, nodeKind } from './schema.js';
import { FIELD_KINDS } from './memory.js';

export class ComposeError extends Error {}

const RULES = `你是「剝繭」的流程設計師。使用者描述一件日常工作，你把它拆成節點化流程草稿。
輸出規則（嚴格遵守）：
1. 先寫一段給使用者的口語回覆（一兩句，講你拆了什麼、哪幾步會停下來給他看；不要解釋格式）。
2. 接著輸出一個 \`\`\`yaml 圍欄，內含完整流程定義，欄位如下：
   format: 1
   name: 流程名稱（中文）
   params: 清單，每項 {key: 英文snake_case, label: 中文, default: 預設值}——把使用者可能想每次微調的量抓成參數
   nodes: 清單，每項 {id: 英文kebab-case, title: 中文步驟名, executor: ai 或 human, stop_point: always 或 never, instruction: 給執行者的具體要求（可用 {{參數key}}）, output_format: 選填字串，這一步產出的格式要求（例「Markdown 表格，欄位=日期/標題/連結」「Email 草稿」；可用 {{參數key}}；沒有格式要求就整個省略）, next: [下一步id]}
   節點另有選填欄位（有明確需要才填，否則省略）：role_context 角色情境、background 背景資料、constraints 限制條件、examples 範例（皆字串，可用 {{參數key}}）、model_tier（fast/balanced/deep）、creativity（strict/open）、retry（0/1/2 失敗自動重試次數）、review_focus 驗收重點、output_file（md/txt/csv/html/json/docx/xlsx/pptx/pdf 產出檔）、output_type/output_structure/output_length/output_tone 輸出規格面向、attachments 參考檔名清單、template_file 範本檔名、connectors 這一步要讀的已連上外部服務（服務全名清單，只准能耐表上列為已連上的，例 ["claude.ai Gmail"]）。
   修改現有草稿時，未被要求變動的欄位（含上述全部選填欄位與頂層 canvas 欄位）原值照抄，不得擅自刪除。
3. 流程預設直線（一般節點 next 恰一個，最後一個節點 next 為 []）。工作本身有「幾件事可同時做」或「依情況走不同路」時：
   - 並行點：{id, title, kind: fork, next: [兩個以上的支線起點id]}——幾支同時進行；要會合就讓各支最後一步的 next 指向同一個步驟（它會自動收齊全部產出），不要造會合節點。
   - 分岔：{id, title, kind: branch, instruction: 人話判斷依據, branches: [{label: 人話條件, next: 目標id}, …可兩條以上], next: []}——各條路直接接各自的後續步驟，殊途同歸時指向同一個步驟即可。
   不要使用 kind: join（舊格式，已退場）。除非使用者的事情確實需要，不要硬加分岔或並行。
   顆粒跟著成品走：成品分幾段（下方「已確認的成品格子」的「分段」）就決定蒐集端拆幾支——分段 3 段以上：一個並行點分成同樣數量的蒐集步（每支各做一段、各自寫明查哪一段的什麼），再接一步彙整（挑題、合併、去重）；不到 3 段：一步蒐集就好。不要為了看起來細而多拆。停點：彙整那一步與最後交付前那一步 stop_point 設 always，其餘 never，除非使用者明說要看。執行時每一步都看得到前面全部步驟的產出，不必為了「拿得到資料」多接線。
4. 使用者口述自己的做法時，照他的步驟順序建，不要自作主張重新設計。
5. 關鍵產出步驟 stop_point 設 always；AI 代替不了的實體動作 executor 設 human。
6. 若下方附有現有草稿：在其基礎上按最新要求修改；使用者明說重拆才整份重來。
7. 指示及格線（每一步都要過）：instruction 必須讓執行者一看就知道三件事——吃什麼輸入（來自哪一步的什麼產出）、要做什麼加工或判斷（含判斷標準）、交出什麼樣的成品（長相／欄位／份量）。「整理資料」這種不及格；「把上一步的新聞池整成表格，欄位=標題/日期/來源/三句摘要」及格。輸出草稿前逐步自檢，不及格的自己改寫到及格再交。
8. 資料通道（2026-09-16 改；連線輪加 c 例外）：資料分兩種。(a) AI 上網查得到的（新聞、公開資訊、網頁、公開報告、公開行情）：讓 AI 步驟自己查，instruction 寫明查哪裡（網站或來源類型）、範圍多久（例「近 7 天」）、要幾則、挑選標準；不要做成欄位叫使用者貼。(b) 只有使用者才拿得到的（來信、內部名單、上週紀錄、營收數字、客戶資料）：一律做成 params，並在用到它的每個 AI 步驟 instruction 裡寫 {{key}} 引用——不要拆成「請使用者貼上」的 human 步驟；human 步驟只留 AI 代替不了的實體動作（開會、寄出、簽名、錄製）。human 步驟後面接 AI 步驟時，必填 handoff（字串：完成時要交出什麼，例「會議結論三條」），且下游 AI 的 instruction 明寫吃的是它交出的內容。純資料欄位一律 {key, label, default: ''（留空）, required: true, hint: 使用者該貼什麼（例「上個月每篇貼文的日期／讚數／留言數」）}——不要把提示文字塞進 default；其他可調欄位（份量、語氣、數量）照舊給實際預設值。(c) 例外——(b) 那類資料若放在使用者 Claude 已連上的外部服務裡（只算能耐表上列為已連上的，例 Gmail 的來信、雲端硬碟的檔案、行事曆的行程）：讓讀它的 AI 步驟寫 connectors: [服務全名] 自己讀，instruction 寫明讀什麼、範圍多久、挑選標準；只能讀，不要排寄出、建立、修改、刪除的動作；不要做成欄位叫使用者貼。
9. 產檔：使用者要「做成 Word／Excel／簡報／PDF 交出去」時，該步 output_file 用 docx、xlsx、pptx 或 pdf（都是真檔，由工人在產出資料夾用內建套件做；需流程開產檔權限，你不用管權限）。成品是簡報時，output_length 用張數（例「12 張」）不要用頁數。產檔步驟的 instruction 要寫明檔案裡放什麼（章節／表頭／份量）與檔名用途；使用者提到有公司範本／設計規範（Word 範本、Excel 範本、色票字型）時，在該步 template_file 指定範本檔名並在 instruction 說明「套用範本、只填內容不改版型」。
10. 交貨查核：使用者在對話裡講到的具體要求（數字、時限、格式、口味、禁忌、對象）一律寫進對應步驟的 review_focus（必守，交貨查核逐條對）或 constraints，不准只留在對話裡。
12. 分類與欄位名：分類由使用者在成品卡的下拉決定並隨第二趟送來（見「# 已確認的成品格子」），yaml 頂層寫 category: <那個分類>（只准現有的，或「未分類」）；不要在口語回覆裡問分類。params 的 label 先看「欄位詞典」——同一件事就沿用詞典裡的正式名；沒有才取新名並給 kind（appearance/audience/time/range/limits/method 六選一，寫在該 param 的 kind 欄）。「分類守則」列出的規矩，拆步驟時當成已知條件，寫進對應步驟的 review_focus 或 constraints，不要另外問。
13. 兩趟輸出：下方「# 這一趟」會標明是第一趟還是第二趟。第一趟（定成品）：不要輸出 yaml。輸出一句口語回覆（講你猜的成品長什麼樣、哪裡不確定），接一個 \`\`\`json 圍欄：{"shape":{"deliverable":{"value","basis"},"type":…,"audience":…,"style":…,"length":…,"sections":…,"range":…},"sources":[{"name","from","note"}],"category":"…"}。七格＝成品（一句話講交出什麼）／型態（文章、表格、簡報稿、Excel、Word、講稿…）／對象（給誰看或聽）／段子或風格（語氣、口吻）／長度（字數、頁數、分鐘）／分段（成品分哪幾段，用「、」隔開）／範圍（時間範圍或涵蓋範圍）；每格答案要先填好——依序從「關於你」「你說的（對話紀錄）」「分類守則」「公司規範」推，推不出來給合理預設；basis 只能寫 自我介紹、你說的、分類守則、公司規範、預設 五選一，用不到的格 value 空字串、basis 寫 預設；不要反問。sources 的 from 只能是 web（AI 上網查）、paste（使用者貼，AI 拿不到的）、upload（使用者上傳檔案）、shared（公司或部門參考檔，note 寫檔名）、upstream（前一步產出）、later（從使用者 Claude 已連上的外部服務讀，note 寫服務全名；只准能耐表上列為已連上的，沒列的改用 paste）。category 只准選現有分類，沒有合適的寫「未分類」。第二趟（落地）：下方會附「# 已確認的成品格子」與「# 資料來源」，照著做——每格變一個 param（label 對詞典正式名：對象→讀者、長度→長度、段子或風格→語氣、型態→型態、分段→分段、範圍→範圍；成品那格不做欄位，當流程 name 與交付步 instruction 的主詞），default＝確認過的值，用不到的格不做欄位；最後交付那一步的 output_type／output_structure／output_length／output_tone 分別填型態／分段／長度／段子或風格的值，instruction 用 {{key}} 引用；來源清單逐條落地：web→負責蒐集的 AI 步驟 instruction 寫明查哪裡與範圍（第 8 條 a）；paste→params required: true＋hint（第 8 條 b）；upload→該步 attachments 寫那個檔名，或做成 human 步驟交出（handoff 寫明交什麼）；shared→attachments 寫 {scope: company 或 category, name: 檔名}；upstream→接線；later→讀它的 AI 步驟寫 connectors: [note 裡的服務全名]、instruction 寫明讀什麼與範圍（第 8 條 c）；note 的服務不在已連上清單就改做成 paste 欄位。`;

// （／E）：七格固定鍵與中文格名（第二趟印「# 已確認的成品格子」用）、basis／from 白名單、from 人話
const SHAPE_KEYS = ['deliverable', 'type', 'audience', 'style', 'length', 'sections', 'range'];
const SHAPE_LABELS = { deliverable: '成品', type: '型態', audience: '對象', style: '段子或風格', length: '長度', sections: '分段', range: '範圍' };
const BASES = ['自我介紹', '你說的', '分類守則', '公司規範', '預設'];
const FROMS = { web: 'AI 上網查', paste: '使用者貼', upload: '使用者上傳', shared: '公司／部門參考檔', upstream: '前一步產出', later: '從已連上的服務讀' };

// 能耐表五行固定字——伺服器只給布林／清單，字在這裡組；office／downgrade／refs 目前都是固定值，先不接字。
// 第五行（連線輪）：列使用者 Claude 已連上的服務（伺服器給快取清單，只列 connected）＋只讀
const connectedOf = (list) => (Array.isArray(list) ? list : [])
  .filter((c) => c && typeof c.name === 'string' && (c.status === undefined || c.status === 'connected'))
  .map((c) => ({ name: c.name, label: c.label || c.name.replace(/^claude\.ai\s+/i, '') }));
function connectorLine(list) {
  const on = connectedOf(list);
  if (!on.length) return '- 外部服務（信箱、雲端硬碟、行事曆等）：目前沒有連上的，別排「自動從 X 讀」的步驟';
  return `- 已連上的外部服務（只能讀：搜尋、讀取、列出、下載；不能寄出、建立、修改、刪除）：${on.map((c) => `${c.label}（connectors 寫 "${c.name}"）`).join('、')}——要讀就在那一步寫 connectors`;
}
function capabilityLines(cap) {
  return [
    `- 上網查與讀網頁：${cap.web !== false ? '可以（設定→執行與排程→AI 工人）' : '不可以（設定關了；資料要做成欄位讓使用者貼）'}`,
    '- 讀使用者上傳的參考檔：可以（流程參考檔與公司／部門參考檔，勾了才帶）',
    `- 在產出資料夾寫檔：${cap.files_default !== false ? '新流程預設可以' : '預設不可以（設定→新流程的預設）'}`,
    '- 產真檔：Word（docx）、Excel（xlsx）、簡報（pptx）、PDF（pdf）都可以',
    connectorLine(cap.connectors),
  ];
}

// US-117 ①③：使用者說明書五段（契約：context.manual＝{who,talk,ask,show,redline}，各為字串陣列；缺席或全空＝逐字同舊）。
// 五段標題與順序跟工作單（runner）同一份，前端與文件對齊用這五個字串
const MANUAL_SECTIONS = [
  ['who', '我是誰'], ['talk', '怎麼跟我講話'], ['ask', '什麼事要問我、什麼事自己決定'], ['show', '什麼時候叫我看'], ['redline', '紅線'],
];
const manualOf = (raw) => Object.fromEntries(MANUAL_SECTIONS.map(([k]) => [k,
  (raw && typeof raw === 'object' && Array.isArray(raw[k]) ? raw[k] : []).map((x) => String(x ?? '').trim()).filter(Boolean)]));
const ABOUT_HEADING = '# 關於你（拆的時候把這些當已知；不用問）';
// 五段對系統怎麼用（US-117 ③）：「什麼時候叫我看」定停點預設、「什麼事要問我」照抄進每個 AI 步驟末尾一行「遇到岔路：」
const GUIDE_HEADING = '## 拆的時候照上面的段落做';
const STOP_GUIDE = '- 停點預設照「什麼時候叫我看」那段定：他只看做完的成品→只有最後交付那一步 stop_point 設 always、其餘 never；他每一步都看→每一步都 always；他只有出問題才叫他→全部 never；那段寫不出對應的，照第 3、5 條的預設。';
const ASK_GUIDE = '- 每個 AI 步驟的 instruction 末尾另起一行「遇到岔路：」，後面照抄「什麼事要問我、什麼事自己決定」那段的原句；工人遇到指示沒講清楚的地方就照那行決定停下來問還是自己定，自己定的在產出裡報備一句。';

// 「# 關於你」段：manual 有內容→沒 section 的舊卡（coreNotes 裡不屬於任何段的）先平列在段首、再五段 ## 小標（空段不印）、末尾兩條規則；
// manual 缺席／全空→coreNotes 平列（逐字同舊）；兩邊都空→整段不印
function aboutSection(ctx, demote) {
  const notes = Array.isArray(ctx.coreNotes) ? ctx.coreNotes : [];
  const manual = manualOf(ctx.manual);
  const sectioned = new Set(MANUAL_SECTIONS.flatMap(([k]) => manual[k]));
  if (!sectioned.size) return notes.length ? ['', ABOUT_HEADING, ...notes.map((x) => `- ${demote(x)}`)] : [];
  const legacy = notes.filter((x) => !sectioned.has(String(x ?? '').trim()));
  const guides = [...(manual.show.length ? [STOP_GUIDE] : []), ...(manual.ask.length ? [ASK_GUIDE] : [])];
  return [
    '', ABOUT_HEADING,
    ...legacy.map((x) => `- ${demote(x)}`),
    ...MANUAL_SECTIONS.flatMap(([k, label]) => (manual[k].length ? [`## ${label}`, ...manual[k].map((x) => `- ${demote(x)}`)] : [])),
    ...(guides.length ? [GUIDE_HEADING, ...guides] : []),
  ];
}

// （M1c）：三段參考——你的分類、欄位詞典、分類守則。沒給 context（舊呼叫端）就一段都不多；給了但空的寫「（無）」。
// context.category＝已定的分類（伺服器確認存在才給）：明講「已經放在」，免得第 12 條在已存流程上又問一次。
// 最前多「# 關於你」（coreNotes 空或暫停＝整段不印，它是人不是參考資料表）、分類守則後多「# 你能派工人做什麼」（capabilities 沒給＝不印）。
function contextSections(ctx) {
  if (!ctx) return [];
  const list = (arr) => (arr.length ? arr.map((x) => `- ${x}`) : ['（無）']);
  // 規範內文與卡文行首 # 降一級、###### 封頂（同 host-adapter，手冊標題不與段標題同級）；卡文多行時第二行起同樣降級
  const demote = (text) => String(text ?? '').replace(/^(#{1,6})(?=\s)/gm, (m) => (m.length < 6 ? `#${m}` : m));
  const about = aboutSection(ctx, demote);
  const can = ctx.capabilities ? ['', '# 你能派工人做什麼（拆步驟時照這張表安排誰做）', ...capabilityLines(ctx.capabilities)] : [];
  const dictLines = (ctx.dict?.fields ?? []).map((f) => {
    const syn = f.synonyms?.length ? `；同義：${f.synonyms.join('、')}` : '';
    return `${f.name}（${FIELD_KINDS[f.kind] ?? FIELD_KINDS.method}${syn}）`;
  });
  const placed = ctx.category ? [`這條流程已經放在「${ctx.category}」，不用再問分類。`] : [];
  // 三層共用檔：組織／分類規範整份給拆解器當已知條件（跟第 12 條的分類守則同一待遇）；外圈在前
  const files = (rules) => (rules?.length ? rules.flatMap((f) => [`## ${f.name}`, demote(f.text)]) : ['（無）']);
  return [
    ...about,
    '', '# 你的分類', ...list(ctx.categories ?? []), ...placed,
    '', '# 欄位詞典', ...list(dictLines),
    '', '# 公司規範（跟分類守則一樣當已知條件）', ...files(ctx.companyRules),
    '', '# 部門規範（同上）', ...files(ctx.deptRules),
    '', '# 分類守則', ...list(ctx.groupRules ?? []),
    ...can,
  ];
}

// 兩趟共用——RULES→context→「# 這一趟」→（第二趟且有確認過的格子）「# 已確認的成品格子」＋「# 資料來源」＋分類→對話紀錄→現有草稿→問題句。
// 第二趟沒帶 shape（對話修改、舊呼叫端）就不印那兩段；分類只跟著格子印（沒帶＝未分類）。
// 第二趟多一段「# 使用者已經選好的交付方式」——卡上選的檔案種類與舊作品。
// 這兩件是使用者在拆之前就決定的，不是讓拆解器猜的；沒選＝維持舊行為（不印這一段）。
const FILE_KIND_TXT = { md: '文字檔（.md）', docx: 'Word（.docx）', xlsx: 'Excel（.xlsx）', pptx: '簡報（.pptx）' };
function shapeSections(phase, shape, sources, category, currentDraft = null, outputFile = null, sampleName = null) {
  const parts = ['', '# 這一趟', phase === 'shape' ? '第一趟：定成品。只回格子與來源，不出 yaml。' : '第二趟：落地成完整流程草稿。'];
  // 舊呼叫端真首拆（第二趟、沒格子、也沒草稿）——規矩 13 承諾的格子不在，明講照對話直接拆，免得它等格子或反問分類
  if (phase === 'draft' && !shape && !currentDraft) parts.push('（本趟沒有成品格子，照對話紀錄直接拆；分類照第 12 條可先寫「未分類」）');
  if (phase !== 'draft' || !shape) return parts;
  parts.push('', '# 已確認的成品格子');
  for (const k of SHAPE_KEYS) {
    const c = shape[k] ?? {};
    parts.push(`- ${SHAPE_LABELS[k]}：${c.value || '（空，不做欄位）'}（${c.basis || '預設'}）`);
  }
  parts.push('', '# 資料來源');
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length) parts.push('（無）');
  for (const s of list) parts.push(`- ${s.name}：${Object.hasOwn(FROMS, s.from) ? FROMS[s.from] : FROMS.paste}${s.note ? `（${s.note}）` : ''}`);
  parts.push(`- 分類：${category || '未分類'}`);
  const kind = Object.hasOwn(FILE_KIND_TXT, outputFile) ? outputFile : null;
  if (kind || sampleName) {
    parts.push('', '# 使用者已經選好的交付方式（不要改、不要問）');
    if (kind) {
      parts.push(`- 交出什麼檔：${FILE_KIND_TXT[kind]}——最後交付那一步的 output_file 就寫 ${kind}${kind === 'md' ? '' : '（真檔，照第 9 條）'}，中間步驟不要跟著設。`);
      if (kind === 'pptx') parts.push('- 成品是簡報：長度用張數（例「12 張」），不要用頁數或字數。');
    }
    if (sampleName) {
      parts.push(`- 照著像的舊作品：「${sampleName}」——已經是這條流程的參考檔。把它寫進最後交付那一步的 attachments，`
        + '並在該步 instruction 寫明「參考這份舊作品的結構、章節順序與語氣，內容照本次資料重寫，不要抄它的數字」。');
    }
  }
  return parts;
}

function buildPrompt(messages, currentDraft, problem, context = null, phase = 'draft', shape = null, sources = null, category = null, outputFile = null, sampleName = null) {
  const parts = [RULES, ...contextSections(context), ...shapeSections(phase, shape, sources, category, currentDraft, outputFile, sampleName), '', '# 對話紀錄'];
  for (const m of messages) parts.push(`${m.role === 'user' ? '使用者' : '你'}：${m.text}`);
  if (currentDraft) parts.push('', '# 現有草稿', '```yaml', yaml.dump(currentDraft, { lineWidth: -1 }).trim(), '```');
  if (problem) parts.push('', `# 你上次輸出的${phase === 'shape' ? '成品格子' : '草稿'}有問題，修正後重新完整輸出：${problem}`);
  return parts.join('\n');
}

// 第一趟：同 parse() 對 yaml 的做法——自己抓 ```json 圍欄的位置切口語回覆，不走 checker.extractJson（它只回值不回位置）。
// 解析成功後補齊：缺格補 {value:'', basis:'預設'}、basis／from 不在白名單改預設／paste、sources 非陣列改 []、category 非字串改 null。
function parseShape(text) {
  const m = /```json\s*\n([\s\S]*?)```/.exec(text);
  if (!m) throw new SchemaError(['回覆裡沒有 json 圍欄的成品格子']);
  let raw;
  try { raw = JSON.parse(m[1]); } catch (e) { throw new SchemaError([`成品格子不是合法 JSON：${e.message}`]); }
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(raw) || !isObj(raw.shape)) throw new SchemaError(['成品格子要是 {"shape": {…}} 物件']);
  const shape = {};
  for (const k of SHAPE_KEYS) {
    const c = raw.shape[k];
    const value = typeof c === 'string' ? c : isObj(c) && c.value != null ? String(c.value) : '';
    shape[k] = { value, basis: isObj(c) && BASES.includes(c.basis) ? c.basis : '預設' };
  }
  const sources = (Array.isArray(raw.sources) ? raw.sources : []).filter(isObj).map((s) => ({
    name: String(s.name ?? ''), from: Object.hasOwn(FROMS, s.from) ? s.from : 'paste', note: String(s.note ?? ''),
  }));
  const category = typeof raw.category === 'string' ? raw.category : null;
  return { reply: text.slice(0, m.index).trim(), shape, sources, category };
}

// 連線預勾的收尾（ADR-006／US-101）：拆解器寫的 connectors 只留已連上的（寫短名也認），其他丟掉，留下的標 set_by:'ai'；
// 現有草稿裡使用者改過的步驟（connectors_set_by==='user'）原樣保留——重拆不准把使用者的勾選改回去。
// 只有 AI 步驟能讀服務；人做步驟與分岔／並行點上的一律拿掉。在驗證之前做：模型寫歪的 connectors 不該害整份草稿重拆
export function settleConnectors(draft, currentDraft, connected) {
  if (!draft || typeof draft !== 'object' || !Array.isArray(draft.nodes)) return draft;
  const on = connectedOf(connected);
  const byAny = new Map([...on.map((c) => [c.label, c.name]), ...on.map((c) => [c.name, c.name])]);
  const prev = new Map((Array.isArray(currentDraft?.nodes) ? currentDraft.nodes : []).filter((n) => n && n.id).map((n) => [n.id, n]));
  for (const n of draft.nodes) {
    if (!n || typeof n !== 'object') continue;
    const old = prev.get(n.id);
    if (old?.connectors_set_by === 'user') {
      if (Array.isArray(old.connectors)) n.connectors = [...old.connectors]; else delete n.connectors;
      n.connectors_set_by = 'user';
      continue;
    }
    const aiTask = nodeKind(n) === 'task' && n.executor === 'ai';
    const kept = aiTask && Array.isArray(n.connectors)
      ? [...new Set(n.connectors.map((c) => (typeof c === 'string' ? byAny.get(c.trim()) : null)).filter(Boolean))] : [];
    if (kept.length) { n.connectors = kept; n.connectors_set_by = 'ai'; } else { delete n.connectors; delete n.connectors_set_by; }
  }
  return draft;
}

function parse(text, settle = (d) => d) {
  const m = /```yaml\s*\n([\s\S]*?)```/.exec(text);
  if (!m) throw new SchemaError(['回覆裡沒有 yaml 圍欄的流程草稿']);
  const draft = settle(yaml.load(m[1]));
  validateWorkflow(draft, { allowFloating: true }); // 編輯中的定義可有未接上的步驟；開跑才嚴格

  return { reply: text.slice(0, m.index).trim(), draft };
}

// 工作單回呼（比照 checker.notePrompt）：寫不進工作單只是少一份紀錄，不該讓建流程整個失敗
const note = async (fn, v) => { try { await fn?.(v); } catch { /* 工作單寫不進不擋建流程 */ } };

// phase 'shape'＝第一趟回 {reply, shape, sources, category}；'draft'（預設＝舊呼叫端現況）＝回 {reply, draft}。
// shape／sources／category 只在第二趟印進 prompt；兩趟都走同一個「壞了帶問題重試一次」機制。
export async function compose({ adapter, messages, currentDraft = null, context = null, phase = 'draft', shape = null, sources = null, category = null, outputFile = null, sampleName = null, onPrompt = null, onReply = null }) {
  const p = phase === 'shape' ? 'shape' : 'draft';
  let problem = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = buildPrompt(messages, currentDraft, problem, context, p, shape, sources, category, outputFile, sampleName);
    await note(onPrompt, prompt);
    const text = await adapter.complete({ prompt, meta: { kind: 'compose', phase: p } });
    await note(onReply, String(text ?? ''));
    try {
      return p === 'shape' ? parseShape(text) : parse(text, (d) => settleConnectors(d, currentDraft, context?.capabilities?.connectors));
    } catch (e) {
      problem = e instanceof SchemaError ? (e.problems ?? [e.message]).join('；') : e.message;
    }
  }
  throw new ComposeError('AI 這次拆得不成形（連兩次都沒給出完整草稿）——換個說法再試一次，或把事情講具體一點。');
}
