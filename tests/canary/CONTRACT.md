# 金絲雀測試（canary）——題目模組契約

> 使用者 2026-09-24 拍板：七題金絲雀，五題「剝繭 vs Claude Code」比賽題＋兩題剝繭獨有機制的結構題；兩邊都用 Sonnet；放版前必跑、封測期間每週一次。同日第二批加三題：q8 髒資料（compare）、q9 漏報（compare）、q10 誤攔率（structural）。
> 不進 `node --test`（會燒額度）；用 `node tests/canary/run.mjs` 手動跑。三位工人並行建，本檔是唯一的介面約定，改動先改本檔。

## 目錄

```
bojian/tests/canary/
├── CONTRACT.md          本檔
├── README.md            怎麼跑、怎麼讀結果（框架工人寫）
├── run.mjs              跑手：起分身、建流程、兩邊各跑、收結果（框架工人寫）
├── score.mjs            彙總 results/ 成一張表＋金絲雀生死判定（框架工人寫）
├── lib/                 共用：seed 亂數、CSV/xlsx 讀寫、claude 呼叫器、剝繭 API 客戶端、用量換算
├── q1/ … q10/           每題一個資料夾，內含 question.mjs（本契約）＋ gen 用到的常數；不放結果（q8～q10 為 2026-09-24 第二批）
└── results/<YYYYMMDD-HHmm>/   每次跑的結果（json＋md＋summary.md），可提交
```

## `qN/question.mjs` 必須匯出

```js
export const id = 'q1';                 // 資料夾名
export const title = '數字分析＋找異常';   // 表格用
export const kind = 'compare' | 'structural';  // compare＝兩邊都跑；structural＝只跑剝繭、不比用量
export const anomalies = ['羊毛圍巾退貨集中'];  // 植入的異常／必中要點（表格用；score 決定怎麼判）

// 造資料：固定種子，每次產出一模一樣。把檔案寫進 dataDir，回傳檔名清單與標準答案（truth 也要落成 dataDir/truth.json）
export async function generate(dataDir) → { files: [{ name, path }], truth }

// 剝繭流程定義（POST /api/workflows 的 def）。規則：
//  - 每個 AI 節點 model_tier: 'balanced'（＝Sonnet）；permissions: { files: true, connectors: false }
//  - compare 題：check: { enabled: false }, supervisor: { enabled: false }（跟 Claude Code 比的是工人本體）
//  - 參考檔用 attachments: ['檔名']（跑手會把 files 逐一 POST 到 /workflows/:cat/:id/files）
export function flowDef({ files, truth }) → def

// Claude Code 直接做的一句話（compare 題必填；structural 題可省）。跑手會把 files 複製進 cwd，並要求成品寫進 report.md（或題目指定的檔名）
export function ccPrompt({ files, truth }) → string

// 結構題／要人互動的題：自訂駕駛（可省）。預設駕駛處理：waiting_check→check-accept、waiting_data→data-accept、
// failed→retry（≤2）、waiting_human→human-done（content 取 question.humanContent?.(nodeId) ?? ''）、停點→approve
export async function drive?({ api, apiClient, base, rid, poll, log }) → { interventions: [...] }
//   api＝函式 api(method, path, body)，path 相對 /api；apiClient＝lib/api.mjs 的物件（getRun／act…）；base＝`/workflows/:cat/:id/runs`。2026-09-24 補。

// 評分：兩邊共用同一支。輸入是「最終文字成品」＋「產出檔清單」＋「每步狀態與產出」＋卷宗；輸出 pass 與明細。
// 不准採信成品自報的數字，一律對 truth。
export async function score({ arm, finalText, artifacts: [{ name, path }], steps: { [nodeId]: { status, output, check } }, prompts: [{ name, path }], truth, runDir, drive, runStatus })
// drive＝這題 drive() 的回傳原物（沒自訂駕駛時＝{ interventions }）；runStatus＝GET /runs/:rid 最後的 status。2026-09-24 補（q6/q7 的閘全在 drive 裡驗）。
  → { pass: boolean, metrics: { primary: 數字, primary_label: '表格欄名（含滿分，如「抓到異常（/2）」）', errors: 數字, ...其他自訂 }, misses: [字串], notes: [字串] }
// metrics.primary＝這題的主指標（數字，越大越好），score.mjs 用它比兩邊；metrics.errors＝錯誤數（越小越好）。2026-09-24 統一。
// 選填（2026-09-24 第二批）：
//   metrics.false_claims＝假話句數：truth.forbidden 列「從 truth 推得出、資料明確否定的主張」（{ id, type, claim, …要素 }），
//     判法＝要素共現（同一句／同一子句短距離同時出現要素），不整句比對；每句「假話：id」列進 misses、算進 errors（q1／q3／q10）
//   metrics.blocks／wrongful_blocks／recheck_blocks＝查核攔的條數／其中冤枉的（被攔的數字在 truth 裡、容差到成品寫的位數）／重寫後仍沒出處的（q10）
//     從 steps[nodeId].check 讀：{ status, blocks, flags, missing, first_blocks?, recheck_blocks? }——status='redone' 時第一次攔的在 first_blocks、blocks 已清空；
//     recheck_blocks 由 US-112 加，沒有欄位就當 [] 並在 notes 註明。
//   metrics.missing／wrongful_missing＝查核員判 missing（停下走資料不全卡）的條數／其中 claim 裡數字其實在 truth 的（從 check.missing 與 drive.interventions 的 waiting_data 讀）；
//     metrics.stops＝blocks＋missing、metrics.wrongful＝兩種冤枉加總、metrics.interventions＝要人出手次數（q10）。
//     score.mjs 的 summary 表在結果裡有 stops（或 blocks）時多印一欄「攔／冤枉」＝stops／wrongful；--rescore 會把結果檔的 interventions 當 drive 傳回 score
//   q8 metrics.trap_hits、q9 metrics.false_alarms：見各自 question.mjs
```

## 跑手（run.mjs）行為

- `node run.mjs [--q q1,q2] [--arms bojian,cc] [--reps 1] [--model sonnet] [--parallel 3] [--port 8797] [--data <dir>]`
- 沒給 `--port` 就自己起一份分身（`BOJIAN_PORT`＋`BOJIAN_DATA_DIR` 指到 %TEMP% 新資料夾），跑完關掉；**不准打 8787、不准動 bojian/data**。
- 每題：`generate` → 建流程（POST /workflows）＋上傳 files → 兩邊各跑 reps 趟；題與題之間可並行（`--parallel`），同一題的兩邊也可並行。
- 剝繭邊：用量從 `BOJIAN_DATA_DIR/**/usage.jsonl` 依 run id 加總（照 對照測試 run.mjs 的 readUsageFiles）；Claude Code 邊：`claude -p --output-format json --model sonnet --allowedTools Read Write Edit Bash Glob Grep`，env 帶 `NODE_PATH=bojian/node_modules`（產檔題公平），cwd＝複製了 files 的暫存夾，用量取回傳 JSON 的 usage。
- 換算用量公式與 對照測試 score.mjs 相同：`fresh + 1.25×cache_write + 0.1×cache_read + 5×output`。
- 結果：`results/<時間戳>/<q>-<arm>-<rep>.json`（arm、rep、ms、status、tokens、weighted、interventions、steps（每步 status／file／error／output／check 整份，含 first_blocks／recheck_blocks）、score）＋ `.md`（最終文字成品）；跑完呼叫 score.mjs 產 `summary.md`。

## 金絲雀生死（score.mjs）

- compare 題：剝繭 `score.pass` 為真、且 `weighted(剝繭) ≤ 1.5 × weighted(cc)`、且品質指標不輸 cc（各題在 metrics 裡定義「主指標」，score.mjs 比對）→ 該題活。
- structural 題：`score.pass` 為真 → 活。
- 任何一題死＝金絲雀死；summary.md 第一行寫「金絲雀：活／死（哪幾題）」。
- **alive 的定義**（2026-09-25，E1）：`summary.json.alive` 為真 ⇔ `run-info.json` 宣告的 questions×arms×reps 每一格都有一列讀得懂的結果（structural 題只算 bojian 那邊）、沒有壞 JSON、且每題都活；缺格、空集、壞檔、沒有 run-info.json 一律 `alive:false`，缺哪些寫在第一行與 `summary.json.complete.reasons`，Markdown 與 JSON 講同一件事。
- **pass 的定義**（2026-09-25，E2）：題目的 `score.pass` 只在那趟結果完整時才可為真——先過 `lib/gates.mjs` 的 `completenessGates`（`runStatus === 'done'`、預期會查核的步驟都有 `check` 紀錄、`metrics.false_claims` 為 0），再看題目自己的品質條件；不過的原因逐條寫在 `reasons` 與 `misses`。目前只有 q10 接了這層，其他題見各自 question.mjs。

## 共用規矩

- 資料全部程式生成、固定種子；truth.json 是唯一答案來源。
- 題目文字用使用者的口吻（一般上班族交代事情），不提工具名。
- 不改 `bojian/src/**`；發現產品 bug 記進工單「還沒做的」，不順手修。
