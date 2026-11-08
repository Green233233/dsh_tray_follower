// Windows shortcut helpers for install/uninstall.
//
// The installer replaces the DSH Start-Menu / Desktop shortcut target with the
// hidden bridge launcher and byte-backs-up the original .lnk so uninstall can
// restore it exactly. Shortcut editing goes through WScript.Shell COM in
// Windows PowerShell 5.1; content backup/restore is plain file copying.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { normalizePathForCompare } from './env.mjs'

function runPowerShell(script, extraEnv = {}, options = {}) {
  const env = { ...process.env, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20000,
      env,
      maxBuffer: 4 * 1024 * 1024
    }
  )
  if (result.error) return { ok: false, error: result.error.message }
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || '').trim() || `powershell exited with ${String(result.status)}` }
  }
  return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' }
}

const READ_SHORTCUT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$shortcutPath = [string]$env:DSHTF_SHORTCUT',
  '$shell = New-Object -ComObject WScript.Shell',
  '$shortcut = $shell.CreateShortcut($shortcutPath)',
  '$payload = [pscustomobject]@{',
  '  TargetPath = [string]$shortcut.TargetPath',
  '  Arguments = [string]$shortcut.Arguments',
  '  WorkingDirectory = [string]$shortcut.WorkingDirectory',
  '  IconLocation = [string]$shortcut.IconLocation',
  '  Description = [string]$shortcut.Description',
  '}',
  '$payload | ConvertTo-Json -Compress'
].join('\n')

/** Read the fields of an existing .lnk (never creates it). */
export function readShortcut(shortcutPath) {
  if (typeof shortcutPath !== 'string' || !shortcutPath) return { ok: false, error: 'shortcutPath required' }
  if (!fs.existsSync(shortcutPath)) return { ok: false, error: 'shortcut does not exist', missing: true }
  const result = runPowerShell(READ_SHORTCUT_SCRIPT, { DSHTF_SHORTCUT: shortcutPath })
  if (!result.ok) return { ok: false, error: result.error }
  try {
    const parsed = JSON.parse(result.stdout.trim())
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'invalid shortcut payload' }
    return {
      ok: true,
      shortcut: {
        targetPath: String(parsed.TargetPath || ''),
        arguments: String(parsed.Arguments || ''),
        workingDirectory: String(parsed.WorkingDirectory || ''),
        iconLocation: String(parsed.IconLocation || ''),
        description: String(parsed.Description || '')
      }
    }
  } catch (error) {
    return { ok: false, error: `invalid shortcut JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const WRITE_SHORTCUT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$shortcutPath = [string]$env:DSHTF_SHORTCUT',
  '$shell = New-Object -ComObject WScript.Shell',
  '$shortcut = $shell.CreateShortcut($shortcutPath)',
  '$shortcut.TargetPath = [string]$env:DSHTF_TARGET',
  '$shortcut.Arguments = [string]$env:DSHTF_ARGS',
  '$shortcut.WorkingDirectory = [string]$env:DSHTF_CWD',
  '$shortcut.IconLocation = [string]$env:DSHTF_ICON',
  '$shortcut.Description = [string]$env:DSHTF_DESC',
  '$shortcut.Save()',
  'Write-Output "saved"'
].join('\n')

/** Create or rewrite a .lnk from explicit fields. */
export function writeShortcut(shortcutPath, fields = {}) {
  if (typeof shortcutPath !== 'string' || !shortcutPath) return { ok: false, error: 'shortcutPath required' }
  try {
    fs.mkdirSync(path.dirname(shortcutPath), { recursive: true })
  } catch (error) {
    return { ok: false, error: `cannot create shortcut directory: ${error instanceof Error ? error.message : String(error)}` }
  }
  const result = runPowerShell(WRITE_SHORTCUT_SCRIPT, {
    DSHTF_SHORTCUT: shortcutPath,
    DSHTF_TARGET: String(fields.targetPath || ''),
    DSHTF_ARGS: String(fields.arguments || ''),
    DSHTF_CWD: String(fields.workingDirectory || ''),
    DSHTF_ICON: String(fields.iconLocation || ''),
    DSHTF_DESC: String(fields.description || '')
  })
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, saved: result.stdout.includes('saved') }
}

/** True when a shortcut is a direct DSH Desktop launcher (optionally with args). */
export function isDshShortcut(shortcut, exePath) {
  if (!shortcut || typeof shortcut !== 'object') return false
  const target = normalizePathForCompare(shortcut.targetPath)
  const expected = normalizePathForCompare(exePath)
  if (!target || !expected) return false
  return target === expected
}

/** Standard per-user shortcut locations that may launch DSH Desktop. */
export function shortcutCandidates(env = process.env) {
  const candidates = []
  const appData = env && typeof env.APPDATA === 'string' ? env.APPDATA : ''
  const localAppData = env && typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA : ''
  const userProfile = env && typeof env.USERPROFILE === 'string' ? env.USERPROFILE : ''
  const programData = env && typeof env.ProgramData === 'string' ? env.ProgramData : ''
  if (appData) {
    candidates.push(path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DeepSeek Harness.lnk'))
    candidates.push(
      path.join(
        appData,
        'Microsoft',
        'Internet Explorer',
        'Quick Launch',
        'User Pinned',
        'TaskBar',
        'DeepSeek Harness.lnk'
      )
    )
  }
  if (userProfile) candidates.push(path.join(userProfile, 'Desktop', 'DeepSeek Harness.lnk'))
  if (programData) candidates.push(path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DeepSeek Harness.lnk'))
  if (userProfile) candidates.push(path.join(userProfile, 'OneDrive', 'Desktop', 'DeepSeek Harness.lnk'))
  if (localAppData) candidates.push(path.join(localAppData, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.lnk'))
  return candidates.filter((value, index) => candidates.indexOf(value) === index)
}

/** Fields for the launcher shortcut (wscript -> hidden PowerShell -> launch.mjs). */
export function launcherShortcutFields(options = {}) {
  const dataDir = typeof options.dataDir === 'string' ? options.dataDir : ''
  const dshExe = typeof options.dshExe === 'string' ? options.dshExe : ''
  const systemRoot = (options.env && options.env.SystemRoot) || 'C:\\Windows'
  const vbs = path.join(dataDir, 'app', 'launcher', 'launch-bridge.vbs')
  return {
    targetPath: path.join(systemRoot, 'System32', 'wscript.exe'),
    arguments: `"${vbs}" "${dataDir}"`,
    workingDirectory: dshExe ? path.dirname(dshExe) : dataDir,
    iconLocation: dshExe ? `${dshExe},0` : '',
    description: 'DeepSeek Harness (dsh-tray-follower 托盘跟随模式)'
  }
}
