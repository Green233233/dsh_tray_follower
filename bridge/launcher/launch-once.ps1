# Developer convenience: launch DSH once in tray-follower mode from the repo,
# without installing shortcuts or copying the payload.
#
# Usage (from the repo root, in a normal terminal):
#   powershell -ExecutionPolicy Bypass -File bridge\launcher\launch-once.ps1
#   powershell -ExecutionPolicy Bypass -File bridge\launcher\launch-once.ps1 -KeepInspector
#
# The script starts DSH detached and exits; the window may take a few seconds.
# Logs: %LOCALAPPDATA%\dsh-tray-follower\injector.log and bridge.log

param(
  [switch]$KeepInspector,
  [string]$DataDir = '',
  [string]$Exe = ''
)

$ErrorActionPreference = 'Stop'

try {
  # <repo>\bridge\launcher -> <repo>
  $bridgeRoot = Split-Path -Parent $PSScriptRoot
  $repoRoot = Split-Path -Parent $bridgeRoot
  $launchScript = Join-Path $bridgeRoot 'injector\launch.mjs'
  if (-not (Test-Path -LiteralPath $launchScript)) {
    throw "找不到 $launchScript（请在仓库内运行）"
  }

  $nodeExe = ''
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) { $nodeExe = $nodeCommand.Source }
  if ([string]::IsNullOrWhiteSpace($nodeExe)) {
    $dshExeCandidate = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
    $bundledNode = Join-Path (Split-Path -Parent $dshExeCandidate) 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundledNode) { $nodeExe = $bundledNode }
  }
  if ([string]::IsNullOrWhiteSpace($nodeExe)) { throw '找不到 node.exe（PATH 或 DSH 内置 node）' }

  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue

  $arguments = @($launchScript)
  if (-not [string]::IsNullOrWhiteSpace($DataDir)) { $arguments += @('--data-dir', $DataDir) }
  if (-not [string]::IsNullOrWhiteSpace($Exe)) { $arguments += @('--exe', $Exe) }
  if ($KeepInspector) { $arguments += '--keep-inspector' }

  Write-Host "repo: $repoRoot"
  Write-Host "node: $nodeExe"
  & $nodeExe @arguments
  exit $LASTEXITCODE
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
