# 安裝剝繭（Windows）

> 使用者只要在 Claude Code 貼這一句：
> **幫我安裝剝繭，照 https://github.com/ceruleanstring/bojian/blob/main/INSTALL.md 做**
> 其他都交給 Claude。

## 給 Claude：照這幾步做

1. **先跟使用者講一句**：「我要下載剝繭的安裝腳本並執行，會把程式裝到你的使用者資料夾（`%LOCALAPPDATA%\bojian`）。如果你電腦還沒裝 Node.js，等一下 Windows 會跳出一次確認視窗，請按『是』。」
2. **把安裝腳本下載到暫存夾**（原始網址 `https://raw.githubusercontent.com/ceruleanstring/bojian/main/install.ps1`）。PowerShell：

   ```powershell
   $f = Join-Path $env:TEMP 'bojian-install.ps1'
   Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/ceruleanstring/bojian/main/install.ps1' -OutFile $f
   ```

   用 Git Bash 的話：`curl -fsSL -o "$TEMP/bojian-install.ps1" https://raw.githubusercontent.com/ceruleanstring/bojian/main/install.ps1`
3. **執行它**（指令逾時給 10 分鐘以上，它會下載並安裝套件）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File $f
   ```

   Git Bash：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$TEMP/bojian-install.ps1")" < /dev/null`（接上 `< /dev/null`，別讓安裝腳本接到終端機的輸入）

   不要加 `-InstallRoot`（那是測試用的）；埠 8787 被佔用時才加 `-Port 8788`。
4. **看輸出最後幾行**：
   - 出現「**剝繭裝好了**」＝安裝成功，接第 5 步。
   - 出現「**安裝沒完成——卡在「…」這一步**」＝失敗。把下面「為什麼／下一步」兩行用白話轉告使用者，照「下一步」處理後再跑一次第 3 步。重跑不會弄壞東西，資料不會被刪。
5. **另外下一個指令把剝繭開起來**（安裝腳本刻意只裝不開，原因見「會卡在哪」的防毒那條）。PowerShell：

   ```powershell
   Start-Process (Join-Path $env:LOCALAPPDATA 'bojian\start-bojian.cmd')
   ```

   Git Bash：`cmd //c start "" //min "$(cygpath -w "$LOCALAPPDATA/bojian/start-bojian.cmd")"`

   啟動檔會自己打開瀏覽器。接著每 2 秒打一次 `http://127.0.0.1:8787/api/health`，最多 20 秒，回 200 就把網址告訴使用者，請他點「跑跑看範例」。20 秒還沒回應：請使用者看工作列上最小化的「bojian」視窗裡的錯誤訊息，照「會卡在哪」處理。
6. **告訴使用者之後怎麼開**：雙擊 `%LOCALAPPDATA%\bojian\start-bojian.cmd`（可以拉一個捷徑到桌面）；裝了剝繭的 Claude Code 外掛的話，在 Claude Code 說「開剝繭」也行。想要開機就自動開：剝繭網頁的「設定 › 執行與排程 › 開機自動啟動」打開。

不要用「把遠端腳本內容直接餵給 PowerShell 執行」的一行寫法；一律先存成檔案再用 `-File` 跑，出事才查得到跑的是什麼。

### 裝完的位置

| 東西 | 位置 |
|---|---|
| 程式（更新＝整夾換掉） | `%LOCALAPPDATA%\bojian\app` |
| 你的資料（流程、執行紀錄、產出） | `%LOCALAPPDATA%\bojian\data` |
| 啟動檔 | `%LOCALAPPDATA%\bojian\start-bojian.cmd` |
| 網址 | http://127.0.0.1:8787 |

要更新到最新版：再跑一次上面第 2、3 步。程式整夾換新，資料夾不動；舊版如果把資料放在程式資料夾裡，會自動搬到 `data`，一個檔都不刪。更新前先關掉剝繭（工作列上最小化的「bojian」視窗）。

### 結束碼對照

| 結束碼 | 意思 |
|---|---|
| 0 | 成功 |
| 2 | Node.js 沒裝好（沒有、太舊、或自動安裝沒成功） |
| 3 | 找不到 Claude（PATH 上沒有 `claude`，也沒有 Claude 桌面版自帶的那支） |
| 4 | 下載失敗（網路） |
| 5 | 壓縮包打不開或內容不對 |
| 6 | 套件安裝（npm install）失敗 |
| 7 | 換新版失敗（通常是剝繭還開著） |
| 1 | 其他沒預料到的狀況，訊息全文轉給使用者 |

## 會卡在哪

- **跳出「是否允許這個程式變更你的裝置」**：這是 Windows 在問要不要讓它裝 Node.js（剝繭需要的執行環境）。按「是」。按了「否」的話會停在結束碼 2，再跑一次、這次按「是」就好。
- **這台電腦沒有 winget**（舊版 Windows 或公司電腦拿掉了）：沒辦法自動裝 Node.js。請使用者到 https://nodejs.org 下載 LTS 版、一路按下一步裝完，**關掉 Claude Code 再重開**（讓它認得新裝的 Node.js），再說一次那句安裝的話。
- **找不到 Claude 或沒登入**：剝繭是掛在使用者自己的 Claude 上跑的。安裝腳本先找終端機叫得到的 `claude` 指令；沒有就找 Claude 桌面版自帶的那支（`%APPDATA%\Claude\claude-code\<版本>\claude.exe`，取最新版），找到會把路徑寫進啟動檔的 `BOJIAN_CLAUDE_BIN`，所以只裝了桌面版也能用。結束碼 3＝兩個都沒有，請使用者先裝 Claude 桌面版（https://claude.com/download）或 Claude Code（https://claude.com/claude-code）並登入。裝好了但沒登入的話，安裝會成功，但剝繭一跑流程就會報「連不上 Claude」——請使用者打開 Claude 登入一次（用命令列版就在終端機打 `claude`），再回剝繭按重試。
- **公司網路擋 GitHub**：結束碼 4。換個網路（例如手機熱點）再跑一次。
- **防毒軟體跳出警告或擋下**：「同一支 PowerShell 下載壓縮包、解開、再開一個隱藏視窗」是防毒最常盯的組合，實測會被整個凍住、永遠不結束。所以安裝腳本只下載和安裝，開剝繭是第 5 步另外做。如果防毒還是跳提示，請使用者選「允許」；安裝指令超過 10 分鐘沒有任何新輸出，就停掉它，請使用者在防毒的隔離區看有沒有 `bojian-install.ps1`，放行後再跑一次第 3 步。

## Mac／Linux

一句話安裝目前只做了 Windows。Mac 和 Linux 請照 [README](README.md#快速開始) 的「會用終端機」那四行。
