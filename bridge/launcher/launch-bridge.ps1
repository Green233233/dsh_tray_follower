# Hidden launcher for the dsh-tray-follower bridge (Windows PowerShell 5.1).
#
# Invoked by launch-bridge.vbs (window style 0), so no console is shown. It:
#   1. locates a Node runtime (DSH's bundled node first, then PATH);
#   2. clears ELECTRON_RUN_AS_NODE / NODE_OPTIONS from its own environment;
#   3. runs the injector launcher (bridge/injector/launch.mjs), which starts DSH
#      with a loopback-only inspector, injects the hook and exits;
#   4. shows a WScript popup with the log tail when something fails.
#
# After a successful launch DSH keeps running in tray-follower mode; subsequent
# launches while DSH is running print "already running" guidance and focus the
# existing window (a DSH process cannot be injected after it already started
# without the inspector).

param([string]$DataDir = '')

$ErrorActionPreference = 'Stop'

function Show-Message([string]$Text, [int]$Icon) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($Text, 30, 'DSH 托盘跟随', $Icon)
  } catch {
    # No UI available: silently continue.
  }
}

try {
  if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Join-Path $env:LOCALAPPDATA 'dsh-tray-follower'
  }
  $appRoot = Join-Path $DataDir 'app'
  $launchScript = Join-Path $appRoot 'injector\launch.mjs'
  if (-not (Test-Path -LiteralPath $launchScript)) {
    Show-Message ("找不到注入器：" + $launchScript + "`r`n`r`n请重新运行 node tools\install-bridge.mjs --apply。") 16
    exit 3
  }

  # Installer records the DSH executable; fall back to the default install path.
  $dshExe = ''
  $installFile = Join-Path $appRoot 'install.json'
  if (Test-Path -LiteralPath $installFile) {
    try {
      $install = Get-Content -LiteralPath $installFile -Raw | ConvertFrom-Json
      if ($install.dshExe) { $dshExe = [string]$install.dshExe }
    } catch {
      $dshExe = ''
    }
  }
  if ([string]::IsNullOrWhiteSpace($dshExe)) {
    $dshExe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
  }

  # Prefer the Node runtime bundled with DSH Desktop, then PATH.
  $nodeExe = ''
  $dshDir = Split-Path -Parent $dshExe
  if (-not [string]::IsNullOrWhiteSpace($dshDir)) {
    $bundledNode = Join-Path $dshDir 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundledNode) { $nodeExe = $bundledNode }
  }
  if ([string]::IsNullOrWhiteSpace($nodeExe)) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodeExe = $nodeCommand.Source }
  }
  if ([string]::IsNullOrWhiteSpace($nodeExe)) {
    Show-Message '找不到 Node.js 运行时（DSH 内置 node 与 PATH 中的 node 都不可用）。' 16
    exit 3
  }

  # The DSH host exports ELECTRON_RUN_AS_NODE to tool shells; DeepSeek Harness.exe
  # would then run as plain Node instead of Electron. NODE_OPTIONS is ignored by
  # packaged Electron and must not be inherited either.
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  Remove-Item Env:ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue

  $output = & $nodeExe $launchScript --data-dir $DataDir --exe $dshExe 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) { exit 0 }

  $lines = @()
  if (-not [string]::IsNullOrWhiteSpace($output)) {
    $lines = $output.Trim() -split "`r?`n" | Select-Object -Last 12
  }
  $detail = ($lines -join "`r`n")

  if ($exitCode -eq 4) {
    Show-Message ("DeepSeek Harness 已在运行。`r`n`r`n托盘跟随桥接只能在 DSH 启动时注入；请先完全退出 DSH" +
      "（右键托盘图标 → 退出），再从本快捷方式启动。`r`n`r`n" + $detail) 48
    exit 4
  }

  Show-Message ("托盘跟随桥接启动失败（退出码 " + [string]$exitCode + "）。`r`n`r`n" + $detail) 16
  exit $exitCode
} catch {
  Show-Message ("托盘跟随启动脚本异常：" + $_.Exception.Message) 16
  exit 1
}
