---
name: bojian
description: 啟動「剝繭」——把日常工作拆成愈用愈聰明的流程工具。當使用者說「開剝繭」「啟動剝繭」「開流程工具」「bojian」時觸發。啟動本地伺服器並回報網址；使用者說「關掉剝繭」時停止。
---

# 剝繭啟動器

照下面步驟逐條做，不要自己換做法。對使用者只講結果，不講過程。

## 名詞（先記住）

- **外掛根目錄**：本 SKILL.md 所在資料夾往上兩層（載入本 skill 時顯示的 Base directory 是 `…\skills\bojian`，外掛根目錄＝它的 `..\..`）。以下寫作 `<外掛根>`，執行時換成實際絕對路徑。
- **安裝位置約定（Windows）**：
  - 程式：`%LOCALAPPDATA%\bojian\app`（PowerShell：`Join-Path $env:LOCALAPPDATA 'bojian\app'`）。更新時整夾換掉，裡面沒有使用者資料。
  - 資料：`%LOCALAPPDATA%\bojian\data`，一律用環境變數 `BOJIAN_DATA_DIR` 指過去。
  - 安裝腳本：`<外掛根>\install.ps1`（只裝不開）。
  - 啟動檔：`%LOCALAPPDATA%\bojian\start-bojian.cmd`（安裝腳本寫的，資料夾、埠、Claude 路徑都在裡面）。
- **網址**：`http://127.0.0.1:8787`（埠預設 8787；若目前環境變數 `BOJIAN_PORT` 有值，以下的 8787 全換成那個值）。

## 開剝繭

### 步驟 1：找 claude、查 node

**1a. 找 claude 執行檔**（只裝 Claude 桌面版的人，終端機叫不到 `claude`，桌面版自己的 claude.exe 在 `%APPDATA%\Claude\claude-code\<版本>\claude.exe`）。解析順序固定三段，Windows 用這一整段 PowerShell：

```powershell
$claude = $null
if ($env:BOJIAN_CLAUDE_BIN) { $claude = $env:BOJIAN_CLAUDE_BIN }
elseif (Get-Command claude -ErrorAction SilentlyContinue) { $claude = 'claude' }
else {
  $dir = Get-ChildItem (Join-Path $env:APPDATA 'Claude\claude-code') -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+(\.\d+)+$' -and (Test-Path (Join-Path $_.FullName 'claude.exe')) } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
  if ($dir) { $claude = Join-Path $dir.FullName 'claude.exe' }
}
if ($claude) { "CLAUDE=$claude"; & $claude --version } else { 'NO_CLAUDE' }
```

Mac／Linux 只有前兩段（Bash）：

```bash
if [ -n "$BOJIAN_CLAUDE_BIN" ]; then c="$BOJIAN_CLAUDE_BIN"; elif command -v claude >/dev/null 2>&1; then c=claude; else c=; fi
if [ -n "$c" ]; then echo "CLAUDE=$c"; "$c" --version; else echo NO_CLAUDE; fi
```

記住印出的 `CLAUDE=…`：
- 是 `claude`（PATH 上找得到）→ 啟動時不用多做事。
- 是一條完整路徑（桌面版內建，或使用者自己指定）→ 步驟 3 啟動時**要在同一個指令裡**先設 `$env:BOJIAN_CLAUDE_BIN = '<那條路徑>'`（Bash：`BOJIAN_CLAUDE_BIN='<路徑>'` 放在啟動指令前面）。以下寫作「**帶 CLAUDE_BIN**」。
- `NO_CLAUDE` → 見下面「缺 claude」。

**1b. 查 node**：

```
node --version
```

- claude 有找到、node 也有且版本 ≥ 20 → 進步驟 2。
- 缺 `node`（或版本 < 20）：
  - Windows 且 `<外掛根>\install.ps1` 存在 → 照常往下走，安裝腳本會補裝 Node；先跟使用者講一句「這台電腦還沒有 Node，我順便裝」。
  - 其他情況 → 停下，跟使用者講「剝繭需要 Node 20 以上，這台電腦找不到（或版本太舊），請先到 https://nodejs.org 裝好再叫我」。
- 缺 claude（`NO_CLAUDE`）→ 跟使用者講一句「找不到 Claude Code 的執行檔（終端機沒有 claude，桌面版資料夾裡也沒有）；剝繭可以開，但流程裡的 AI 步驟跑不了」，然後照常往下走。

缺哪個講哪個，一句話講完，不要貼指令輸出。

### 步驟 2：已經開著就直接回網址

PowerShell：

```powershell
try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:8787/).StatusCode } catch { 'DOWN' }
```

印出 `200` → 已經開著，跳到步驟 5 回網址。印出 `DOWN` → 進步驟 3。

### 步驟 3：看在哪台、裝了沒，選一條路啟動

先判斷作業系統：Windows 走 3A；Mac／Linux 直接走 3C。

**3A. Windows：已安裝就從安裝位置啟動。** 檢查：

```powershell
Test-Path (Join-Path $env:LOCALAPPDATA 'bojian\start-bojian.cmd')
```

- `True` → 用安裝時產生的啟動檔開（資料夾、埠、找不到終端機 claude 時的桌面版路徑，都已寫在裡面；它也會自己打開瀏覽器）：

  ```powershell
  Start-Process (Join-Path $env:LOCALAPPDATA 'bojian\start-bojian.cmd')
  ```

  然後進步驟 4。
- `False` → 走 3B。

**3B. Windows：還沒安裝就跑安裝腳本。** 檢查 `Test-Path '<外掛根>\install.ps1'`：

- `True` → 執行（參數全用預設，不要加任何參數）：

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File '<外掛根>\install.ps1'
  ```

  結束碼不是 0 → 停下，把腳本最後印的中文錯誤訊息原樣轉給使用者，不要自己亂修。
  結束碼是 0 → 安裝腳本只裝不開（防毒會凍住「下載完又開隱藏視窗」的同一支 PowerShell，所以刻意拆開），回 3A 的 `True` 那段啟動一次，再進步驟 4。
- `False` → 走 3C。

**3C. 退回舊做法（Mac／Linux，或外掛裡沒有 install.ps1）。**

- 若是 Mac／Linux，先跟使用者講一句：「Mac 目前還沒有一句話安裝，我先直接從外掛資料夾開。」
- 若 `<外掛根>/node_modules` 不存在，在 `<外掛根>` 執行一次 `npm install`（Windows 用 `cmd /c npm install`）。
- 以背景程序在 `<外掛根>` 執行 `node src/server.js`（資料會放在 `<外掛根>/data/`，不要另外設 `BOJIAN_DATA_DIR`；步驟 1a 要「帶 CLAUDE_BIN」的話照下面寫法帶，否則拿掉那段）：
  - Mac／Linux（Bash）：`cd '<外掛根>' && BOJIAN_CLAUDE_BIN='<路徑>' nohup node src/server.js > /dev/null 2>&1 &`
  - Windows（PowerShell）：`$env:BOJIAN_CLAUDE_BIN = '<路徑>'; Start-Process -FilePath node -ArgumentList 'src\server.js' -WorkingDirectory '<外掛根>' -WindowStyle Hidden`

然後進步驟 4。

### 步驟 4：等它起來

每 1 秒重做一次步驟 2 的檢查，最多 20 次：

- 出現 `200` → 步驟 5。
- 20 次都 `DOWN` → 跟使用者講「剝繭沒開起來」，並在前景重跑一次看錯誤（3A：`cmd /c "%LOCALAPPDATA%\bojian\start-bojian.cmd"` 之後看工作列最小化的「bojian」視窗；3C：在 `<外掛根>` 前景跑 `node src/server.js`），把第一段錯誤訊息轉給使用者，然後停。

### 步驟 5：回報

只講一句：「剝繭開好了 → http://127.0.0.1:8787」。不要贅述。

## 關掉剝繭

使用者說「關掉剝繭」時，停掉佔著 8787 埠的程序，然後回報一句「剝繭關了」：

- Windows（PowerShell）：

  ```powershell
  Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
  ```

- Mac／Linux（Bash）：`lsof -ti tcp:8787 -sTCP:LISTEN | xargs kill`

本來就沒開著，也回「剝繭本來就沒開」一句即可。

## 注意

- 伺服器會自己處理範例播種、垃圾桶與記憶垃圾桶清理，不需要你做任何資料操作。
- 第一次打開會問三題「介紹你自己」（可跳過）；之後它默默記下使用者的習慣與偏好（資料夾裡的 `memory/`），設定頁看得到、可撤。這些都在網頁裡發生，不經過本對話。
- 流程執行中的 AI 呼叫由剝繭經 `claude -p` 自行發起，不經過本對話。
- 不要替使用者改動資料夾（`%LOCALAPPDATA%\bojian\data` 或 `<外掛根>/data/`）裡的任何檔案。
- 不要改 `%LOCALAPPDATA%\bojian\app` 裡的檔案：更新時整夾會被換掉，改了也會消失。
