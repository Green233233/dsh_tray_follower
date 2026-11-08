#!/usr/bin/env node
// dsh-tray-follower bridge installer (user level, no admin, no DSH file changes).
//
// What it installs:
//   %LOCALAPPDATA%\dsh-tray-follower\app\{shell-hook,injector,launcher,install.json}
//   - rewrites the DeepSeek Harness Start-Menu / Desktop / pinned-taskbar shortcut
//     target to the hidden bridge launcher (launch-bridge.vbs), byte-backing-up
//     every original .lnk under %LOCALAPPDATA%\dsh-tray-follower\backup\shortcuts
//
// What it never does: modify the DSH install directory, write global environment
// variables, edit user profile package.json / cordis.patch.yml.
//
// Default is a dry run; pass --apply to execute. Uninstall restores the original
// shortcuts byte-for-byte (see tools/uninstall-bridge.mjs).
//
// Usage:
//   node tools/install-bridge.mjs [--apply] [--data-dir <path>] [--exe <path>] [--no-shortcuts]
//
// Exit codes: 0 ok / dry-run, 1 error.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultDataDir, defaultDshExe, normalizePathForCompare } from '../bridge/injector/lib/env.mjs'
import {
  isDshShortcut,
  launcherShortcutFields,
  readShortcut,
  shortcutCandidates,
  writeShortcut
} from '../bridge/injector/lib/shortcuts.mjs'

const VERSION = '0.1.0'
const EXIT_OK = 0
const EXIT_ERROR = 1

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.dirname(here)

const PAYLOAD_DIRECTORIES = [
  { source: path.join(repoRoot, 'bridge', 'shell-hook'), targetRelative: 'app/shell-hook' },
  { source: path.join(repoRoot, 'bridge', 'injector'), targetRelative: 'app/injector' },
  { source: path.join(repoRoot, 'bridge', 'launcher'), targetRelative: 'app/launcher' }
]

function parseArgs(argv) {
  const options = {
    apply: false,
    dataDir: '',
    exe: '',
    noShortcuts: false,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      return argv[index] === undefined ? '' : argv[index]
    }
    switch (arg) {
      case '--apply':
        options.apply = true
        break
      case '--dry-run':
        options.apply = false
        break
      case '--data-dir':
        options.dataDir = next()
        break
      case '--exe':
        options.exe = next()
        break
      case '--no-shortcuts':
        options.noShortcuts = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        break
    }
  }
  return options
}

function usage() {
  return [
    'dsh-tray-follower bridge installer (user level)',
    '',
    '  node tools/install-bridge.mjs [--apply] [--data-dir <path>] [--exe <path>] [--no-shortcuts]',
    '',
    '  --apply          execute (default: dry run, only prints the plan)',
    '  --data-dir       bridge data dir (default %LOCALAPPDATA%\\dsh-tray-follower)',
    '  --exe            DSH Desktop executable (default: standard install path)',
    '  --no-shortcuts   copy the payload only; do not touch shortcuts',
    '',
    'Uninstall: node tools/uninstall-bridge.mjs --apply'
  ].join('\n')
}

function printLine(line = '') {
  try {
    console.log(line)
  } catch (_error) {
    /* ignore */
  }
}

function sanitizeFileStem(name) {
  return String(name || 'shortcut')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, '_')
    .slice(0, 80)
}

function readInstallRecord(installFile) {
  try {
    const decoded = JSON.parse(fs.readFileSync(installFile, 'utf8'))
    return decoded && typeof decoded === 'object' ? decoded : null
  } catch (_error) {
    return null
  }
}

function copyPayload(directories) {
  for (const entry of directories) {
    fs.cpSync(entry.source, entry.target, {
      recursive: true,
      force: true,
      filter: (source) => {
        const name = path.basename(source)
        return !name.endsWith('.log') && !name.endsWith('.tmp')
      }
    })
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(1))
  if (options.help) {
    printLine(usage())
    return EXIT_OK
  }

  const dataDir = path.resolve(options.dataDir || defaultDataDir(process.env))
  const dshExe = path.resolve(options.exe || defaultDshExe(process.env))
  const appDir = path.join(dataDir, 'app')
  const installFile = path.join(appDir, 'install.json')
  const backupDir = path.join(dataDir, 'backup', 'shortcuts')

  printLine('== dsh-tray-follower bridge installer ==')
  printLine(`repo:      ${repoRoot}`)
  printLine(`data dir:  ${dataDir}`)
  printLine(`DSH exe:   ${dshExe}`)
  printLine(`mode:      ${options.apply ? 'APPLY' : 'dry run (pass --apply to execute)'}`)
  printLine()

  if (!fs.existsSync(dshExe)) {
    printLine(`ERROR: DeepSeek Harness executable not found: ${dshExe}`)
    printLine('       Pass --exe <path> when DSH is installed elsewhere.')
    return EXIT_ERROR
  }
  for (const entry of PAYLOAD_DIRECTORIES) {
    if (!fs.existsSync(entry.source)) {
      printLine(`ERROR: missing payload source: ${entry.source}`)
      return EXIT_ERROR
    }
  }
  const hookSource = path.join(repoRoot, 'bridge', 'shell-hook', 'hook.cjs')
  if (!fs.existsSync(hookSource)) {
    printLine(`ERROR: missing hook: ${hookSource}`)
    return EXIT_ERROR
  }

  const payload = PAYLOAD_DIRECTORIES.map((entry) => ({
    source: entry.source,
    target: path.join(dataDir, entry.targetRelative),
    targetRelative: entry.targetRelative
  }))

  const existingInstall = readInstallRecord(installFile)
  const previousShortcuts = existingInstall && Array.isArray(existingInstall.shortcuts) ? existingInstall.shortcuts : []
  const previousByPath = new Map(previousShortcuts.map((record) => [path.resolve(record.path || ''), record]))

  const launcherFields = launcherShortcutFields({ dataDir, dshExe, env: process.env })
  const launcherVbsPath = path.join(dataDir, 'app', 'launcher', 'launch-bridge.vbs')
  const shortcutPlan = []

  if (!options.noShortcuts) {
    const candidates = shortcutCandidates(process.env)
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue
      const current = readShortcut(candidate)
      if (!current.ok) {
        shortcutPlan.push({ path: candidate, action: 'skip', reason: `unreadable shortcut: ${current.error}` })
        continue
      }
      const shortcut = current.shortcut
      const previous = previousByPath.get(path.resolve(candidate))
      const alreadyLauncher =
        normalizePathForCompare(shortcut.targetPath) === normalizePathForCompare(launcherFields.targetPath) &&
        shortcut.arguments.includes(launcherVbsPath)
      if (isDshShortcut(shortcut, dshExe)) {
        shortcutPlan.push({
          path: candidate,
          action: 'replace',
          original: previous && previous.original ? previous.original : shortcut,
          backup: previous && previous.backup ? previous.backup : '',
          current: shortcut
        })
      } else if (alreadyLauncher) {
        shortcutPlan.push({
          path: candidate,
          action: 'already-installed',
          original: previous && previous.original ? previous.original : null,
          backup: previous && previous.backup ? previous.backup : '',
          current: shortcut
        })
      } else {
        shortcutPlan.push({ path: candidate, action: 'skip', reason: `not a DSH Desktop launcher (target: ${shortcut.targetPath})` })
      }
    }
    const hasDshShortcut = shortcutPlan.some(
      (item) => item.action === 'replace' || item.action === 'already-installed' || item.action === 'create'
    )
    if (!hasDshShortcut) {
      const appData = process.env.APPDATA || ''
      if (!appData) {
        shortcutPlan.push({ path: '', action: 'skip', reason: 'APPDATA unavailable; cannot create a Start Menu shortcut' })
      } else {
        const target = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DeepSeek Harness (Tray Follower).lnk')
        shortcutPlan.push({ path: target, action: 'create', original: null, backup: '', current: null })
      }
    }
  }

  printLine('planned payload:')
  for (const entry of payload) printLine(`  copy ${entry.source} -> ${entry.target}`)
  printLine('planned shortcuts:')
  if (options.noShortcuts) {
    printLine('  (skipped via --no-shortcuts)')
  } else if (shortcutPlan.length === 0) {
    printLine('  (no matching DSH shortcut found)')
  } else {
    for (const item of shortcutPlan) {
      if (item.action === 'replace') printLine(`  replace  ${item.path}`)
      else if (item.action === 'create') printLine(`  create   ${item.path}`)
      else if (item.action === 'already-installed') printLine(`  already  ${item.path}`)
      else printLine(`  skip     ${item.path} (${item.reason})`)
    }
  }
  printLine()
  printLine('manual steps (equivalent to --apply):')
  printLine(`  1. install payload under ${appDir}`)
  printLine('  2. point the DSH shortcut at wscript.exe with:')
  printLine(`       ${launcherFields.targetPath} ${launcherFields.arguments}`)
  printLine('  3. restart DeepSeek Harness from that shortcut')
  printLine()

  if (!options.apply) {
    printLine('Dry run complete. Re-run with --apply to install.')
    printLine(`Uninstall later with: node "${path.join(repoRoot, 'tools', 'uninstall-bridge.mjs')}" --apply`)
    return EXIT_OK
  }

  // --- apply -----------------------------------------------------------------
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(appDir, { recursive: true })
    fs.mkdirSync(backupDir, { recursive: true })
  } catch (error) {
    printLine(`ERROR: cannot create ${dataDir}: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_ERROR
  }

  const records = []
  let shortcutFailures = 0
  try {
    let backupIndex = 0
    for (const item of shortcutPlan) {
      if (item.action === 'skip') {
        printLine(`skip shortcut: ${item.path} (${item.reason})`)
        continue
      }
      if (item.action === 'already-installed') {
        printLine(`shortcut already installed: ${item.path}`)
        records.push({
          path: item.path,
          created: false,
          backup: item.backup || '',
          original: item.original || null,
          launcher: launcherFields
        })
        continue
      }

      let backupPath = item.backup || ''
      if (item.action === 'replace') {
        if (!backupPath) {
          backupIndex += 1
          backupPath = path.join(backupDir, `${String(backupIndex).padStart(2, '0')}-${sanitizeFileStem(path.basename(item.path))}`)
        }
        if (!fs.existsSync(backupPath)) {
          fs.copyFileSync(item.path, backupPath)
          printLine(`backed up shortcut: ${item.path} -> ${backupPath}`)
        }
      }

      const written = writeShortcut(item.path, launcherFields)
      if (!written.ok) {
        shortcutFailures += 1
        printLine(`ERROR: failed to write shortcut ${item.path}: ${written.error}`)
        continue
      }
      const verify = readShortcut(item.path)
      if (!verify.ok || verify.shortcut.targetPath.toLowerCase() !== launcherFields.targetPath.toLowerCase()) {
        shortcutFailures += 1
        printLine(`ERROR: shortcut verification failed: ${item.path}`)
        continue
      }
      printLine(`${item.action === 'create' ? 'created' : 'replaced'} shortcut: ${item.path}`)
      records.push({
        path: item.path,
        created: item.action === 'create',
        backup: backupPath,
        original: item.original || item.current,
        launcher: launcherFields
      })
    }
  } catch (error) {
    printLine(`ERROR: shortcut installation failed: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_ERROR
  }

  let payloadCopied = false
  try {
    copyPayload(payload)
    payloadCopied = true
    printLine(`payload installed under ${appDir}`)
  } catch (error) {
    printLine(`ERROR: payload copy failed: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_ERROR
  }

  const installRecord = {
    schemaVersion: 1,
    version: VERSION,
    installedAt: new Date().toISOString(),
    repoRoot,
    dataDir,
    dshExe,
    payload: payload.map((entry) => entry.targetRelative),
    shortcuts: records,
    previousVersion: existingInstall && existingInstall.version ? existingInstall.version : null
  }
  try {
    fs.writeFileSync(installFile, `${JSON.stringify(installRecord, null, 2)}\n`, 'utf8')
    printLine(`manifest written: ${installFile}`)
  } catch (error) {
    printLine(`ERROR: cannot write manifest ${installFile}: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_ERROR
  }

  printLine()
  if (shortcutFailures > 0) {
    printLine(`WARNING: ${String(shortcutFailures)} shortcut(s) failed; bridge payload is installed but DSH may launch without it.`)
  }
  printLine('INSTALLED.')
  printLine('Next: fully quit DeepSeek Harness (tray icon -> 退出), then launch it from the DeepSeek Harness shortcut.')
  printLine('Verify: right-click the tray icon; the menu should list 对话（N 运行 / M 待处理）.')
  printLine(`Logs:   ${path.join(dataDir, 'bridge.log')} and ${path.join(dataDir, 'injector.log')}`)
  printLine(`Uninstall: node "${path.join(repoRoot, 'tools', 'uninstall-bridge.mjs')}" --apply`)
  return payloadCopied ? EXIT_OK : EXIT_ERROR
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    try {
      console.error(error)
    } catch (_error) {
      /* ignore */
    }
    process.exitCode = EXIT_ERROR
  })
