// composer — 用講的建流程：對話紀錄（＋現有草稿）→ 一句話回覆＋整份流程草稿。
// 業務 prompt 在此；宿主呼叫一律走 host-adapter。
import yaml from 'js-yaml';
import { validateWorkflow, SchemaError } from './schema.js';

export class ComposeError extends Error {}

const RULES = `你是「剝繭」的流程設計師。使用者描述一件日常工作，你把它拆成節點化流程草稿。
輸出規則（嚴格遵守）：
1. 先寫一段給使用者的口語回覆（一兩句，講你拆了什麼、哪幾步會停下來給他看；不要解釋格式）。
2. 接著輸出一個 \`\`\`yaml 圍欄，內含完整流程定義，欄位如下：
   format: 1
   name: 流程名稱（中文）
   params: 清單，每項 {key: 英文snake_case, label: 中文, default: 預設值}——把使用者可能想每次微調的量抓成參數
   nodes: 清單，每項 {id: 英文kebab-case, title: 中文步驟名, executor: ai 或 human, stop_point: always 或 never, instruction: 給執行者的具體要求（可用 {{參數key}}）, output_format: 選填字串，這一步產出的格式要求（例「Markdown 表格，欄位=日期/標題/連結」「Email 草稿」；可用 {{參數key}}；沒有格式要求就整個省略）, next: [下一步id]}
   節點另有選填欄位（有明確需要才填，否則省略）：role_context 角色情境、background 背景資料、constraints 限制條件、examples 範例（皆字串，可用 {{參數key}}）、model_tier（fast/balanced/deep）、creativity（strict/open）、retry（0/1/2 失敗自動重試次數）、review_focus 驗收重點、output_file（md/txt/csv/html/json/docx/xlsx/pptx/pdf 產出檔）、output_type/output_structure/output_length/output_tone 輸出規格面向、attachments 參考檔名清單、template_file 範本檔名。
   修改現有草稿時，未被要求變動的欄位（含上述全部選填欄位與頂層 canvas 欄位）原值照抄，不得擅自刪除。
3. 流程預設直線（一般節點 next 恰一個，最後一個節點 next 為 []）。工作本身有「幾件事可同時做」或「依情況走不同路」時：
   - 並行點：{id, title, kind: fork, next: [兩個以上的支線起點id]}——幾支同時進行；要會合就讓各支最後一步的 next 指向同一個步驟（它會自動收齊全部產出），不要造會合節點。
   - 分岔：{id, title, kind: branch, instruction: 人話判斷依據, branches: [{label: 人話條件, next: 目標id}, …可兩條以上], next: []}——各條路直接接各自的後續步驟，殊途同歸時指向同一個步驟即可。
   不要使用 kind: join（舊格式，已退場）。除非使用者的事情確實需要，不要硬加分岔或並行。
   交接鐵則：每一步執行時只看得到「直接連進來那幾步」的產出，不會自動看到更早的步驟。所以某步需要用到更早步驟的產出時（例：寫稿要用三步前排好的清單），必須讓那份產出也接一條線過去——把早步驟的 next 指向一個並行點，由並行點分送給原下一步與需要它的那一步；不接線就等於那一步拿不到資料。
4. 使用者口述自己的做法時，照他的步驟順序建，不要自作主張重新設計。
5. 關鍵產出步驟 stop_point 設 always；AI 代替不了的實體動作 executor 設 human。
6. 若下方附有現有草稿：在其基礎上按最新要求修改；使用者明說重拆才整份重來。
7. 指示及格線（每一步都要過）：instruction 必須讓執行者一看就知道三件事——吃什麼輸入（來自哪一步的什麼產出）、要做什麼加工或判斷（含判斷標準）、交出什麼樣的成品（長相／欄位／份量）。「整理資料」這種不及格；「把上一步的新聞池整成表格，欄位=標題/日期/來源/三句摘要」及格。輸出草稿前逐步自檢，不及格的自己改寫到及格再交。
8. 資料通道：純資料輸入（來信、名單、上週紀錄這類要餵給 AI 的內容）一律做成 params，並在用到它的每個 AI 步驟 instruction 裡寫 {{key}} 引用——不要拆成「請使用者貼上」的 human 步驟；human 步驟只留 AI 代替不了的實體動作（開會、寄出、簽名）。human 步驟後面接 AI 步驟時，必填 handoff（字串：完成時要交出什麼，例「會議結論三條」），且下游 AI 的 instruction 明寫吃的是它交出的內容。純資料欄位一律 {key, label, default: ''（留空）, required: true, hint: 使用者該貼什麼（例「上個月每篇貼文的日期／讚數／留言數」）}——不要把提示文字塞進 default；其他可調欄位（份量、語氣、數量）照舊給實際預設值。
9. 產檔（產檔輪）：使用者要「做成 Word／Excel 交出去」時，該步 output_file 用 docx 或 xlsx（真檔，由工人在產出資料夾用內建套件做；需流程開產檔權限，你不用管權限）；pptx／pdf 目前會降級成 .md，除非使用者明說否則不用。產檔步驟的 instruction 要寫明檔案裡放什麼（章節／表頭／份量）與檔名用途；使用者提到有公司範本／設計規範（Word 範本、Excel 範本、色票字型）時，在該步 template_file 指定範本檔名並在 instruction 說明「套用範本、只填內容不改版型」。`;

function buildPrompt(messages, currentDraft, problem) {
  const parts = [RULES, '', '# 對話紀錄'];
  for (const m of messages) parts.push(`${m.role === 'user' ? '使用者' : '你'}：${m.text}`);
  if (currentDraft) parts.push('', '# 現有草稿', '```yaml', yaml.dump(currentDraft, { lineWidth: -1 }).trim(), '```');
  if (problem) parts.push('', `# 你上次輸出的草稿有問題，修正後重新完整輸出：${problem}`);
  return parts.join('\n');
}

function parse(text) {
  const m = /```yaml\s*\n([\s\S]*?)```/.exec(text);
  if (!m) throw new SchemaError(['回覆裡沒有 yaml 圍欄的流程草稿']);
  const draft = yaml.load(m[1]);
  validateWorkflow(draft, { allowFloating: true }); // 編輯中的定義可有未接上的步驟；開跑才嚴格

  return { reply: text.slice(0, m.index).trim(), draft };
}

export async function compose({ adapter, messages, currentDraft = null }) {
  let problem = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await adapter.complete({ prompt: buildPrompt(messages, currentDraft, problem), meta: { kind: 'compose' } });
    try {
      return parse(text);
    } catch (e) {
      problem = e instanceof SchemaError ? (e.problems ?? [e.message]).join('；') : e.message;
    }
  }
  throw new ComposeError('AI 這次拆得不成形（連兩次都沒給出完整草稿）——換個說法再試一次，或把事情講具體一點。');
}
