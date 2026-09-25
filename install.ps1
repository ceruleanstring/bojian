<#
  剝繭 Windows 安裝腳本（PowerShell 5.1 以上）

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-InstallRoot 路徑] [-Port 8787] [-SkipNodeInstall]
    只裝不啟動；裝完另外執行 <InstallRoot>\start-bojian.cmd 開剝繭（-NoStart 保留相容，已無作用）

  裝完的樣子：
    <InstallRoot>\app               程式（更新＝整夾換掉，裡面不放你的資料）
    <InstallRoot>\data              你的資料（流程、執行紀錄、產出）
    <InstallRoot>\start-bojian.cmd  之後要開剝繭就執行它

  結束碼：0 成功；2 Node.js 不合格；3 找不到 Claude Code；4 下載失敗；5 解壓失敗；
          6 套件安裝失敗；7 換新版失敗；1 其他沒預料到的錯誤（8 已不用：本腳本不再啟動）
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'bojian'),
  [int]$Port = 8787,
  [switch]$NoStart,
  [switch]$SkipNodeInstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ZipUrl = 'https://github.com/ceruleanstring/bojian/archive/refs/heads/main.zip'
$NodeDownloadUrl = 'https://nodejs.org'
$NodeMin = 20
$TotalSteps = 8
$Url = 'http://127.0.0.1:' + $Port
$script:Temps = @()

# 訊息一律用 UTF-8 印，讓讀這段輸出的 Claude 或終端機看得到中文；結束時換回原本的設定
$script:PrevOutEnc = $null
try {
  $script:PrevOutEnc = [Console]::OutputEncoding
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch { }

function Restore-Encoding {
  if ($null -ne $script:PrevOutEnc) {
    try { [Console]::OutputEncoding = $script:PrevOutEnc } catch { }
  }
}

function Say-Step([int]$n, [string]$text) {
  Write-Host ('[{0}/{1}] {2}' -f $n, $TotalSteps, $text)
}

function Say([string]$text) {
  Write-Host ('      ' + $text)
}

function Remove-Dir([string]$p) {
  if (-not (Test-Path -LiteralPath $p)) { return }
  try {
    Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop
  } catch {
    # 路徑太長時 Remove-Item 會失敗，改用 rd 再試一次
    $ErrorActionPreference = 'Continue'
    & cmd.exe /d /c ('rd /s /q "' + $p + '"') | Out-Null
  }
}

function Clean-Temps {
  foreach ($t in $script:Temps) {
    try {
      if (Test-Path -LiteralPath $t) {
        if ((Get-Item -LiteralPath $t -Force).PSIsContainer) { Remove-Dir $t } else { Remove-Item -LiteralPath $t -Force }
      }
    } catch { }
  }
}

function Fail([string]$step, [string]$why, [string]$next, [int]$code) {
  Write-Host ''
  Write-Host ('安裝沒完成——卡在「' + $step + '」這一步。')
  Write-Host ('為什麼：' + $why)
  Write-Host ('下一步：' + $next)
  Clean-Temps
  Restore-Encoding
  exit $code
}

function Get-NodeVersion {
  $ErrorActionPreference = 'Continue'
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $cmd) { return $null }
  $v = ''
  try { $v = & node --version 2>$null | Select-Object -First 1 } catch { $v = '' }
  return ('' + $v).Trim()
}

function Get-Major([string]$ver) {
  if ([string]::IsNullOrEmpty($ver)) { return -1 }
  if ($ver -match '^v?(\d+)\.') { return [int]$Matches[1] }
  return 0
}

# 跑 <exe> --version；印得出版本號（開頭是 數字.數字）就算跑得動，回版本字串；不然回 $null
# （不看 $LASTEXITCODE：主控台切成 UTF-8 後，5.1 跑 .cmd 檔的 $LASTEXITCODE 會是 -1，實測踩到）
function Test-ClaudeExe([string]$exe) {
  $ErrorActionPreference = 'Continue'
  $v = $null
  try {
    $out = ('' + (& $exe --version 2>$null | Select-Object -First 1)).Trim()
    if ($out -match '^v?\d+\.\d+') { $v = $out }
  } catch { $v = $null }
  $ErrorActionPreference = 'Stop'
  return $v
}

# Claude 桌面版自帶的 Claude Code：%APPDATA%\Claude\claude-code\<版本>\claude.exe，取版本號最大的；沒有回 $null
function Find-DesktopClaude {
  if ([string]::IsNullOrEmpty($env:APPDATA)) { return $null }
  $base = Join-Path $env:APPDATA 'Claude\claude-code'
  if (-not (Test-Path -LiteralPath $base)) { return $null }
  $best = $null
  $bestVer = $null
  foreach ($d in @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue)) {
    $exe = Join-Path $d.FullName 'claude.exe'
    if (-not (Test-Path -LiteralPath $exe)) { $exe = Join-Path $d.FullName 'claude.cmd' }
    if (-not (Test-Path -LiteralPath $exe)) { continue }
    $ver = $null
    if ($d.Name -match '^(\d+)\.(\d+)\.(\d+)') {
      $ver = New-Object System.Version ([int]$Matches[1]), ([int]$Matches[2]), ([int]$Matches[3])
    } else {
      $ver = New-Object System.Version 0, 0, 0
    }
    if (($null -eq $bestVer) -or ($ver -gt $bestVer)) {
      $bestVer = $ver
      $best = @{ Exe = $exe; Version = $d.Name; File = (Split-Path -Leaf $exe) }
    }
  }
  return $best
}

function Update-PathFromRegistry {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = $machine + ';' + $user
}

function Invoke-Winget {
  $ErrorActionPreference = 'Continue'
  & winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  return $LASTEXITCODE
}

function Invoke-NpmInstall([string]$dir) {
  $ErrorActionPreference = 'Continue'
  Push-Location -LiteralPath $dir
  try {
    $lines = & cmd.exe /d /c 'npm install --omit=dev --no-audit --no-fund 2>&1'
    $c = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($c -ne 0) {
    Write-Host '      npm 最後幾行訊息：'
    @($lines) | Select-Object -Last 15 | ForEach-Object { Write-Host ('        ' + $_) }
  }
  return $c
}

function Move-OldData([string]$from, [string]$to) {
  if (-not (Test-Path -LiteralPath $from)) { return }
  $items = @(Get-ChildItem -LiteralPath $from -Force)
  if ($items.Count -eq 0) { return }
  Say ('舊版把資料放在程式資料夾裡了，搬到 ' + $to + '（一個檔都不刪）')
  $conflictDir = $null
  foreach ($it in $items) {
    $target = Join-Path $to $it.Name
    if (Test-Path -LiteralPath $target) {
      if ($null -eq $conflictDir) {
        $conflictDir = Join-Path $to ('舊版資料-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        New-Item -ItemType Directory -Force -Path $conflictDir | Out-Null
      }
      Move-Item -LiteralPath $it.FullName -Destination (Join-Path $conflictDir $it.Name) -ErrorAction Stop
    } else {
      Move-Item -LiteralPath $it.FullName -Destination $target -ErrorAction Stop
    }
  }
  if ($null -ne $conflictDir) {
    Say ('有幾個同名的資料資料夾裡已經有了，舊的那份另外放在 ' + $conflictDir)
  }
  Remove-Dir $from
}

try {
  $App = Join-Path $InstallRoot 'app'
  $Bak = Join-Path $InstallRoot 'app.bak'
  $Data = Join-Path $InstallRoot 'data'
  $Launcher = Join-Path $InstallRoot 'start-bojian.cmd'

  Write-Host ('剝繭安裝：程式放 ' + $App + '，資料放 ' + $Data + '。需要網路，大約兩三分鐘。')

  # ① 查 Node.js
  Say-Step 1 '檢查 Node.js（剝繭要 20 版以上）'
  $nodeVer = Get-NodeVersion
  if ((Get-Major $nodeVer) -ge $NodeMin) {
    Say ('有了：Node.js ' + $nodeVer)
  } else {
    if ([string]::IsNullOrEmpty($nodeVer)) {
      $why = '這台電腦還沒裝 Node.js。'
    } else {
      $why = '這台電腦的 Node.js 是 ' + $nodeVer + '，太舊了（要 20 版以上）。'
    }
    $manual = '到 ' + $NodeDownloadUrl + ' 下載 LTS 版安裝，裝完關掉這個視窗、重開一個，再跑一次安裝。'
    if ($SkipNodeInstall) {
      Fail '檢查 Node.js' ($why + '這次指定了不自動安裝（-SkipNodeInstall）。') $manual 2
    }
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($null -eq $winget) {
      Fail '安裝 Node.js' ($why + '這台電腦沒有 winget（Windows 內建的安裝工具），沒辦法自動裝。') $manual 2
    }
    Say $why
    Say '現在用 winget 自動安裝 Node.js LTS。等一下 Windows 會跳出一次「是否允許這個程式變更你的裝置」，請按「是」。'
    $wingetCode = Invoke-Winget
    Update-PathFromRegistry
    $nodeVer = Get-NodeVersion
    if ((Get-Major $nodeVer) -lt $NodeMin) {
      Fail '安裝 Node.js' ('winget 跑完了（結束碼 ' + $wingetCode + '），但還是找不到 20 版以上的 Node.js。可能是確認視窗按了「否」。') $manual 2
    }
    Say ('裝好了：Node.js ' + $nodeVer)
  }

  # ② 查 Claude：PATH 上的 claude 優先；沒有就找 Claude 桌面版自帶的那支（%APPDATA%\Claude\claude-code\<版本>\claude.exe，取版本最大的）
  #    找到桌面版那支時，把路徑寫進啟動檔的 BOJIAN_CLAUDE_BIN（用 %APPDATA% 變數寫，檔案裡仍不含中文）；程式那邊會優先用它。
  Say-Step 2 '檢查 Claude Code'
  $claudeBinLine = $null
  $claudeWhere = ''
  $claudeVer = ''
  $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
  if ($null -ne $claudeCmd) {
    $claudeVer = Test-ClaudeExe $claudeCmd.Source
    if ($null -eq $claudeVer) {
      Fail '檢查 Claude Code' '找得到 claude 指令，但它跑不起來。' '先裝 Claude 桌面版或 Claude Code 並登入（https://claude.com/claude-code），確認在終端機打 claude 能開，再跑一次安裝。' 3
    }
    $claudeWhere = 'Claude Code'
  } else {
    $desktop = Find-DesktopClaude
    if ($null -ne $desktop) {
      $claudeVer = Test-ClaudeExe $desktop.Exe
      if ($null -ne $claudeVer) {
        $claudeWhere = 'Claude 桌面版自帶的 Claude Code（' + $desktop.Exe + '）'
        $claudeBinLine = 'set "BOJIAN_CLAUDE_BIN=%APPDATA%\Claude\claude-code\' + $desktop.Version + '\' + $desktop.File + '"'
      }
    }
  }
  if ([string]::IsNullOrEmpty($claudeWhere)) {
    Fail '檢查 Claude Code' '這台電腦找不到 Claude Code（PATH 上沒有 claude 指令，也沒有 Claude 桌面版自帶的那支），剝繭要掛在你自己的 Claude 上跑。' '請先安裝 Claude 桌面版或 Claude Code 並登入（https://claude.com/claude-code 或 https://claude.com/download），裝好後重開視窗再跑一次安裝。' 3
  }
  Say ('有了：' + $claudeWhere + ' ' + $claudeVer)

  # ③ 下載
  Say-Step 3 '從 GitHub 下載剝繭最新版'
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $PID
  $zipPath = Join-Path ([IO.Path]::GetTempPath()) ('bojian-main-' + $stamp + '.zip')
  $script:Temps += $zipPath
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }
  try {
    Invoke-WebRequest -Uri $ZipUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 300
  } catch {
    Fail '下載剝繭' ('連不上 GitHub 或下載中斷：' + $_.Exception.Message) '確認網路正常（公司網路可能擋 GitHub），再跑一次安裝。這次下載到一半的檔案已經清掉了。' 4
  }

  # ④ 解壓
  Say-Step 4 '解壓縮'
  $staging = Join-Path $InstallRoot ('_staging-' + $stamp)
  $script:Temps += $staging
  try {
    # 用 PowerShell 內建的 Expand-Archive（5.0 起就有）；不載入額外組件、不編譯任何東西
    Expand-Archive -LiteralPath $zipPath -DestinationPath $staging -Force -ErrorAction Stop
  } catch {
    Fail '解壓縮' ('壓縮包打不開：' + $_.Exception.Message) '再跑一次安裝（會重新下載）；還是一樣就是下載被中途改掉了，換個網路試試。' 5
  }
  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  $inner = @(Get-ChildItem -LiteralPath $staging -Directory)
  if (($inner.Count -ne 1) -or (-not (Test-Path -LiteralPath (Join-Path $inner[0].FullName 'src\server.js')))) {
    Fail '解壓縮' '下載到的壓縮包內容不對（找不到 src\server.js）。' '再跑一次安裝；還是一樣就是 GitHub 上的版本有問題，請回報。' 5
  }
  $newApp = $inner[0].FullName

  # ⑤ 裝套件（先在暫存夾裝好，成功才換上去；失敗的話舊版完全沒被動到）
  Say-Step 5 '安裝剝繭用到的套件（npm install，大約一兩分鐘）'
  $npmCode = Invoke-NpmInstall $newApp
  if ($npmCode -ne 0) {
    Fail '安裝套件' ('npm install 失敗（結束碼 ' + $npmCode + '）。') '確認網路正常後再跑一次安裝。舊版剝繭（如果有）沒被動到。' 6
  }

  # ⑥ 放到安裝位置；舊版先備份成 app.bak，舊版放錯位置的資料搬到 data
  Say-Step 6 ('放到安裝位置 ' + $App)
  New-Item -ItemType Directory -Force -Path $Data | Out-Null
  if (Test-Path -LiteralPath $Bak) {
    # 上一次安裝半路中斷留下的備份：先把裡面的資料救出來再清掉
    Move-OldData (Join-Path $Bak 'data') $Data
    Remove-Dir $Bak
  }
  $hadOld = Test-Path -LiteralPath $App
  if ($hadOld) {
    try {
      Rename-Item -LiteralPath $App -NewName 'app.bak' -ErrorAction Stop
    } catch {
      Fail '換新版' '舊版剝繭的資料夾正在被使用（剝繭可能還開著）。' '關掉工作列上名為「bojian」的視窗（或重開機），再跑一次安裝。你的資料沒被動到。' 7
    }
    Move-OldData (Join-Path $Bak 'data') $Data
  }
  try {
    Move-Item -LiteralPath $newApp -Destination $App -ErrorAction Stop
  } catch {
    if ($hadOld -and (-not (Test-Path -LiteralPath $App)) -and (Test-Path -LiteralPath $Bak)) {
      Rename-Item -LiteralPath $Bak -NewName 'app' -ErrorAction SilentlyContinue
    }
    Fail '換新版' ('新版搬不進 ' + $App + '：' + $_.Exception.Message) '關掉所有開著剝繭的視窗後再跑一次安裝。舊版已經放回原位，你的資料沒被動到。' 7
  }
  Remove-Dir $Bak
  Clean-Temps
  Say '好了。'

  # ⑦ 寫啟動檔 start-bojian.cmd（UTF-8 不帶 BOM；第一行切 65001 碼頁；
  #    路徑用 %~dp0 取啟動檔自己所在的資料夾，檔案內容只有英數字，使用者名稱有中文也不會亂碼）
  Say-Step 7 ('建立啟動檔 ' + $Launcher)
  $cmdLines = @(
    '@chcp 65001>nul',
    '@echo off',
    'rem bojian launcher, generated by install.ps1',
    'setlocal',
    'rem started from inside a Claude Code session: drop its session variables so bojian runs its own claude calls cleanly',
    'if defined CLAUDECODE (',
    '  set "CLAUDECODE="',
    '  for /f "delims==" %%v in (''set CLAUDE_CODE_ 2^>nul'') do set "%%v="',
    ')',
    'set "BOJIAN_DATA_DIR=%~dp0data"',
    ('set "BOJIAN_PORT=' + $Port + '"'),
    $claudeBinLine,
    'set "BOJIAN_URL=http://127.0.0.1:%BOJIAN_PORT%"',
    'cd /d "%~dp0app"',
    'curl -s -f -m 5 -o nul "%BOJIAN_URL%/api/health" >nul 2>&1 && goto open',
    'start "bojian" /min cmd /c "node src\server.js"',
    'set /a tries=0',
    ':wait',
    'curl -s -f -m 5 -o nul "%BOJIAN_URL%/api/health" >nul 2>&1 && goto open',
    'set /a tries+=1',
    'if %tries% geq 20 goto open',
    'ping -n 2 127.0.0.1 >nul',
    'goto wait',
    ':open',
    'if not defined BOJIAN_NO_BROWSER start "" "%BOJIAN_URL%"',
    'endlocal'
  )
  $cmdLines = @($cmdLines | Where-Object { $null -ne $_ })
  [IO.File]::WriteAllText($Launcher, (($cmdLines -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding $false))

  # ⑧ 收尾：本腳本只裝、不啟動（2026-09-25 發單者實測定案）。
  #   同一個 PowerShell 行程「從網路下載壓縮包＋解開＋再起一支隱藏視窗」是防毒行為偵測最典型的可疑組合：
  #   本機（Kaspersky）實測這樣跑，安裝行程在最後一步被整個凍結（全部執行緒 Suspended、殺不掉），呼叫端永遠等不到結束；
  #   同一份檔只拿掉啟動那一段，從 Git Bash 呼叫 5 秒跑完，另外執行啟動檔 4 秒就起來。
  #   所以啟動交給呼叫端另外做（INSTALL.md 第 3 步、外掛「開剝繭」）。-NoStart 參數保留相容，現在不帶也不啟動。
  Say-Step 8 '安裝完成'
  Write-Host ''
  Write-Host ('剝繭裝好了。要開的時候執行：' + $Launcher)
  Write-Host ('（開好之後的網址：' + $Url + '）')
  Restore-Encoding
  exit 0
} catch {
  Fail '（沒預料到的狀況）' $_.Exception.Message '把上面整段訊息複製給 Claude 或回報給我們，再跑一次安裝通常不會弄壞東西。' 1
}
