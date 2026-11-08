// Windows process helpers for the injector / launcher.
//
// Only PowerShell built-ins (Get-CimInstance, ConvertTo-Json) and taskkill are
// used; nothing is installed and no DSH file is touched. Every helper reports
// failures instead of throwing so the launcher can fall back gracefully.

import { spawnSync } from 'node:child_process'

import { sanitizeDshEnv } from './env.mjs'

function runPowerShell(script, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
  const env = options.env || sanitizeDshEnv(process.env)
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env, maxBuffer: 4 * 1024 * 1024 }
  )
  if (result.error) return { ok: false, error: result.error.message, stdout: '', stderr: '' }
  if (result.status !== 0) {
    return {
      ok: false,
      error: (result.stderr || '').trim() || `powershell exited with ${String(result.status)}`,
      stdout: result.stdout || '',
      stderr: result.stderr || ''
    }
  }
  return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' }
}

/**
 * True when a command line looks like the DSH Desktop *main* process.
 *
 * Electron helper processes carry `--type=`; DSH additionally spawns two
 * Electron-as-Node children that share the same executable name and must not be
 * mistaken for the running desktop: the desktop Host
 * (`--expose-internals ... dsh-desktop-host/lib/index.js`) and tool subprocess
 * runners (`--expose-internals ... dsh-subprocess-local/lib/runner.js`).
 */
export function isDshBrowserCommandLine(commandLine) {
  const text = typeof commandLine === 'string' ? commandLine : ''
  if (/--type=/u.test(text)) return false
  if (/--expose-internals/u.test(text)) return false
  if (/runner\.js/u.test(text)) return false
  if (/dsh-desktop-host/u.test(text)) return false
  return true
}

/**
 * List running "DeepSeek Harness.exe" processes with their command lines.
 * Only the entry without helper switches is the actual browser/main process.
 *
 * @param {{ exeName?: string }} [options]
 */
export function listDshProcesses(options = {}) {
  const exeName = options.exeName || 'DeepSeek Harness.exe'
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$name = [string]$env:DSHTF_EXE_NAME',
    `Get-CimInstance Win32_Process -Filter ("Name='" + $name + "'") | ForEach-Object { ([string]$_.ProcessId) + '|' + ([string]$_.CommandLine) }`
  ].join('\n')
  const env = { ...sanitizeDshEnv(process.env), DSHTF_EXE_NAME: exeName }
  const result = runPowerShell(script, { env })
  if (!result.ok) return { ok: false, error: result.error, processes: [] }
  const processes = []
  for (const line of result.stdout.split(/\r?\n/u)) {
    const separator = line.indexOf('|')
    if (separator <= 0) continue
    const pid = Number.parseInt(line.slice(0, separator), 10)
    if (!Number.isInteger(pid) || pid <= 0) continue
    const commandLine = line.slice(separator + 1)
    processes.push({
      pid,
      commandLine,
      isBrowserProcess: isDshBrowserCommandLine(commandLine)
    })
  }
  return { ok: true, processes }
}

/** Return PIDs of the real (non-helper) DSH Desktop process, if running. */
export function listDshBrowserPids(options = {}) {
  const listed = listDshProcesses(options)
  if (!listed.ok) return { ok: false, error: listed.error, pids: [] }
  return { ok: true, pids: listed.processes.filter((entry) => entry.isBrowserProcess).map((entry) => entry.pid) }
}

/** True when a process with `pid` exists. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

/** Kill one process tree (taskkill /PID <pid> /T /F); PID only, never by image name. */
export function killProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, error: 'invalid pid' }
  if (pid === process.pid) return { ok: false, error: 'refusing to kill the current process' }
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
  })
  if (result.error) return { ok: false, error: result.error.message, status: null }
  return { ok: result.status === 0, status: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.trim() }
}

/** Kill a list of PIDs, returning per-PID results. */
export function killProcesses(pids, options = {}) {
  const results = []
  for (const pid of Array.isArray(pids) ? pids : []) {
    results.push({ pid, ...killProcessTree(pid, options) })
  }
  return results
}

/**
 * Find processes whose command line contains `token` (used to clean up an
 * isolated probe instance's Host child process). The token is passed through the
 * environment so no quoting rules apply.
 */
export function findProcessesByToken(token, options = {}) {
  if (typeof token !== 'string' || !token) return { ok: false, error: 'token required', pids: [] }
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$token = [string]$env:DSHTF_PROCESS_TOKEN',
    'if (-not $token) { return }',
    'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -ne $null -and $_.CommandLine.Contains($token) } | ForEach-Object { [string]$_.ProcessId }'
  ].join('\n')
  const env = { ...sanitizeDshEnv(process.env), DSHTF_PROCESS_TOKEN: token }
  const result = runPowerShell(script, { env, timeoutMs: options.timeoutMs })
  if (!result.ok) return { ok: false, error: result.error, pids: [] }
  const pids = []
  for (const line of result.stdout.split(/\r?\n/u)) {
    const pid = Number.parseInt(line.trim(), 10)
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.push(pid)
  }
  return { ok: true, pids }
}

/** Wait until `pid` is gone (or the timeout elapses). */
export async function waitForProcessExit(pid, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 100
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(pid)) return { ok: true, exited: true, elapsedMs: Date.now() - started }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return { ok: false, exited: false, elapsedMs: Date.now() - started, stillAlive: true }
}
