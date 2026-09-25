# 金絲雀測試（canary）——怎麼跑、怎麼讀結果

> 十題金絲雀：七題「剝繭 vs Claude Code」比賽題（compare）＋三題剝繭獨有機制的結構題（structural）。兩邊都用 Sonnet。（原七題＋2026-09-24 第二批 q8～q10）
> 放版前必跑、封測期間每週一次。**不進 `node --test`**（會燒額度），手動跑。介面約定見 [CONTRACT.md](CONTRACT.md)。

## 怎麼跑

```powershell
cd <剝繭資料夾>\bojian
node tests/canary/run.mjs                         # 全部題、兩邊、各 1 趟、Sonnet、三題並行
node tests/canary/run.mjs --q q1,q3,q5 --reps 1   # 只跑數字家族
node tests/canary/run.mjs --arms bojian --q q6    # 只跑剝繭那一邊
node tests/canary/score.mjs                       # 只重算最新一次結果的 summary.md
node tests/canary/score.mjs tests/canary/results/20260924-1530
node tests/canary/score.mjs --rescore                     # 計分規則改了：用存下的成品與產出檔重算 score，不重跑 Claude
```

選項：`--q q1,q2`（預設全部有 question.mjs 的題）、`--arms bojian,cc`、`--reps 1`、`--model sonnet`（Claude Code 那邊的 `--model`；剝繭那邊靠 flowDef 的 `model_tier: 'balanced'`）、`--parallel 3`（題與題並行；同一題的兩邊一律並行）、`--port`＋`--data`（接一份已經跑著的分身；不給就自己起）、`--timeout 45`（每趟上限，分鐘）、`--force`（分身比程式舊仍照跑）。

- 沒給 `--port`：跑手自己 `node src/server.js`，`BOJIAN_PORT` 隨機空埠、`BOJIAN_DATA_DIR` 是 %TEMP% 新資料夾，等 HTTP 200 才開始，跑完 `taskkill /T` 整棵。**不打 8787、不動 bojian/data**。
- 給了 `--port`（接既有分身）：開跑前先比「分身行程的啟動時間」（從埠找到監聽的 pid，再問作業系統它幾點起的）與 `bojian/src` 底下最新的檔案修改時間——分身比程式舊＝跑的是舊碼（2026-09-24 白燒 3 趟），印醒目警告並停下（exit 2），重起分身再來；真的要照跑帶 `--force`。拿不到 pid 或啟動時間就印一行提醒、照跑。
- 缺的題目（資料夾沒有 `question.mjs`、或載入失敗）印一行跳過，不炸。
- 剝繭那邊的預設駕駛：`waiting_check→check-accept`、`waiting_data→data-accept`、`failed→retry`（≤2 次，再失敗＝give-up）、`waiting_human→human-done`（content 取 `question.humanContent?.(nodeId)`）、`waiting_review→approve`、`waiting_time→resume-time`、`waiting_branch→choose-branch`（第一條路）。題目自己有 `drive` 就用題目的（會拿到 `{ api, wf, base, rid, poll, log, deadline, defaultDrive }`）。
- Claude Code 那邊：`claude -p --output-format json --model sonnet --allowedTools Read Write Edit Bash Glob Grep`，cwd＝複製了題目檔案的暫存夾，env 帶 `NODE_PATH=bojian/node_modules`（產檔題公平）。成品讀 cwd 的 `report.md`（題目可用 `export const ccReportName` 換檔名），沒有就取回傳 JSON 的 `result`。

## 結果在哪

`results/<YYYYMMDD-HHmm>/`：

| 檔 | 內容 |
|---|---|
| `summary.md` | 第一行「金絲雀：活／死（哪幾題、為什麼）」＋一張表；每題底下列狀態、要人出手幾次、沒命中的項目 |
| `summary.json` | 同一份判定的機器版 |
| `<q>-<arm>-<rep>.json` | arm、rep、ms、status、tokens、weighted、interventions、steps、artifacts、score |
| `<q>-<arm>-<rep>.md` | 最終文字成品 |
| `files/<q>-<arm>-<rep>/` | 產出檔（docx／xlsx／report.md…）＋ `prompts/`（剝繭卷宗或 cc 的一句話） |
| `run-info.json` | 這次跑的參數、分身埠、資料夾、總時間 |

造出來的考題資料在 %TEMP%/bojian-canary-*/<q>/（含 truth.json），不進 results。

## 怎麼讀表

| 欄 | 意思 |
|---|---|
| 抓到異常／主指標 | 題目的 `score.metrics.primary`（數字，越大越好）；q1＝抓到異常 1/0、q3＝兩個異常抓到幾個、q5＝兩個真檔合格幾個 |
| 錯誤數 | `score.metrics.errors`（沒給就用 `misses.length`）；數字題＝關鍵數字沒命中的項數＋假話句數（q1／q3／q10 的 `metrics.false_claims`，見下） |
| 攔／冤枉 | `score.metrics.stops`／`score.metrics.wrongful`（每趟平均；舊結果沒有就退回 `blocks`／`wrongful_blocks`）；只有 q10 給，這欄只在結果裡有 q10 時才印，別的題印「—」。攔＝查核停下的次數（程式攔的數字 `blocks`＋查核員判 missing 的 `missing`）；冤枉＝其中對 truth 其實是對的（`wrongful_blocks` 誤攔＋`wrongful_missing` 誤判 missing）。要人出手次數在該題備註 |
| 用量倍數 | 剝繭換算用量 ÷ Claude Code 換算用量；換算＝新讀＋1.25×快取寫入＋0.1×重複讀＋5×寫出（與 reviews/對照測試 同一把尺）。括號內是換算用量（千） |
| pass | 題目自己的 `score.pass`（多趟＝全過才算過，括號內 過的趟數/趟數） |

生死（CONTRACT）：compare 題要「剝繭 pass ＋ 用量 ≤ 1.5 倍 ＋ 主指標不輸 cc」；structural 題要 pass；任何一題死＝金絲雀死。compare 題若 cc 那邊沒跑（`--arms bojian`）判「比不了」＝死。

- **alive**（`summary.json.alive`、第一行「活」）＝ `run-info.json` 宣告的題×邊×趟每一格都有讀得懂的結果、沒有壞 JSON、且每題都活；少任何一趟、空夾、壞檔、沒有 run-info.json 都是「死」或「無結果」，缺哪幾格印在第一行（2026-09-25 起，之前缺趟會被算成活）。
- **pass**（每題的 `score.pass`）＝ 那趟先過完整性閘（`status` 是 done、預期會查核的步驟都有查核紀錄、假話 0 句），再過題目自己的品質條件；不過的原因在 `score.reasons`。目前只有 q10 接了完整性閘。
- `score.mjs` 直接跑的退出碼：活 0、死（含缺趟／空集／壞檔／沒有 run-info.json）2、找不到結果夾 1——排程或 CI 接它就靠這個，不用再讀第一行。
- 量尺自己的單元測試在 `canary.test.js`（`node --test bojian/tests/canary/canary.test.js`，不打 AI、不起分身，會被 `node --test` 一起撿到）。

## 題目給計分器的約定（給寫題目的人）

`score()` 回 `{ pass, metrics, misses, notes }`，其中建議放：
- `metrics.primary`：主指標數字（越大越好）；`metrics.primary_label`：表格顯示的名字
- `metrics.errors`：錯誤數（越小越好）
- `metrics.false_claims`：假話句數——成品出現 `truth.forbidden` 列的「資料明確否定的主張」幾句（要素共現判，不是整句比對）；每句也以「假話：…」列進 `misses`、算進 `errors`（q1／q3／q10）
- `metrics.blocks`／`metrics.wrongful_blocks`／`metrics.recheck_blocks`：查核攔的條數／其中冤枉的／重寫後仍沒出處的（只有 q10 給；從 `steps[nodeId].check` 的 `first_blocks`、`recheck_blocks` 讀）
- `metrics.missing`／`metrics.wrongful_missing`：查核員判 missing（走資料不全卡、停下叫人）的條數／其中 claim 裡的數字其實在 truth 的（從 `steps[nodeId].check.missing` 與 `drive.interventions` 裡 waiting_data 帶的 `check.missing` 讀，同一 claim 只算一次）；`metrics.stops`＝blocks＋missing、`metrics.wrongful`＝兩種冤枉加總（表格印這兩個）；`metrics.interventions`＝要人出手次數（`drive.interventions.length`；`--rescore` 從結果檔的 `interventions` 傳）
沒放的話 score.mjs 用 `pass ? 1 : 0` 當主指標、`misses.length` 當錯誤數。

## 數字家族三題

| 題 | 資料 | 剝繭流程 | 計分 |
|---|---|---|---|
| q1 月報＋找異常 | 200 筆 7、8 月（＝reviews/對照測試 同一份，種子 20260923） | 算數字 → 找三個重點 → 寫月報 | 13 項關鍵數字＋「羊毛圍巾」與「退貨」同句；反向：`truth.forbidden` 五句假話（退貨 0 筆的三個品項被寫成退貨集中／訂單數 86→91 被寫成沒增／退貨與成長動能寫成同一群品項），命中＝錯誤＋1；pass＝抓到異常且錯誤 ≤2 |
| q3 大資料量 | 5,000 筆 6～8 月、418KB；蝦皮 7/13–7/19 退貨 9.6 倍、手工陶瓷馬克杯 30 筆單價 5,600（十倍） | 同 q1 結構 | 11 項數字＋兩個異常各有沒有被點名（通路＋那週任一天／商品＋單價・十倍・錄錯任一）；反向：九句假話（前三名裡退貨最少的兩款寫成退貨集中／官網・門市那週寫成退貨暴增／8 月對 7 月全站與各通路都增卻寫成下滑／錄錯與蝦皮退貨潮寫成同一批），pass＝至少抓到一個異常且錯誤 ≤3 |

## 第二批三題（2026-09-24；q8／q9 的細節以各自 question.mjs 為準）

| 題 | 資料 | 剝繭流程 | 計分 |
|---|---|---|---|
| q8 髒資料月報（compare） | 246 張訂單攤成 358 列（種子 20260831）；五種陷阱：同一張訂單拆多列、已取消／已退款混在裡面、日期三種寫法＋8/31 23 時與 9/1 0 時跨月邊界、帶引號千分位金額、金額空白或「－」 | 同 q1 三步（算數字→找重點→寫月報） | 13 項對獨立算出的 truth（不採信工人程式）＋10 條「陷阱誘導的錯數字」反向計分（`metrics.trap_hits`）；pass＝13 全中且 trap_hits 0 |
| q9 漏報題（compare） | 6～8 月 1,744 筆（種子 20260924）；四種異常各一：文具類 8 月歸零、7/13–7/19 整週沒資料、C0187 同日 6 張一模一樣的單、SO01376 金額 -58,000 | 算數字→找異常→寫報告 | 抓到異常（/4，同一句要素共現）＋誤報（`metrics.false_alarms`：宣稱異常但點名的要素不在四個異常裡）；pass＝抓到 ≥3 且誤報 ≤1 |
| q10 誤攔率（structural） | q1 同一份（匯入 q1 的 generate，truth 多一段 `extra` 衍生數） | q1 的三步，但 `check: { enabled: true, facts: true }`、監工關、files 開 | 主指標＝13 項關鍵數字命中；`blocks`＝每步 `check.first_blocks` 條數加總、`recheck_blocks`＝重寫後仍沒出處的（欄位還沒有就當 0 並記 notes）、`wrongful_blocks`＝被攔的數字對 truth 其實對（容差到成品寫的位數）；查核員判 missing 的也逐條對 truth（`missing`／`wrongful_missing`）；pass＝13 項全中、冤枉（兩種加總）≤1、且要人出手 0 次（使用者 09-24 裁定不停下叫人；判 missing 停下＝不過）；假話沿用 q1。自檢 `node tests/canary/q10/selfcheck.mjs`（不打 Claude） |
| q5 產真檔 | q1 的資料 | 算數字 → 月報.docx → 明細.xlsx（兩分頁「按通路」「按商品」） | mammoth 抽 docx 對 13 項；exceljs 開 xlsx 查兩分頁存在、各分頁含全部金額與合計＝8 月營收；檔打不開＝不過 |
