#!/usr/bin/env node
// dsh-tray-follower bridge uninstaller (user level, no admin, no DSH file changes).
//
// Restores every shortcut rewritten by tools/install-bridge.mjs from its byte
// backup (or deletes shortcuts the installer created), removes the payload under
// %LOCALAPPDATA%\dsh-tray-follower\app and the install manifest. Logs / state /
// cursor are kept unless --purge is passed.
//
// Default is a dry run; pass --apply to execute.
//
// Usage:
//   node tools/uninstall-bridge.mjs [--apply] [--data-dir <path>] [--purge]
//
// Exit codes: 0 ok / dry-run / nothing installed, 1 error.

import fs from 'node:fs'
import path from 'node:path'

import { defaultDataDir } from '../bridge/injector/lib/env.mjs'
import { readShortcut, writeShortcut } from '../bridge/injector/lib/shortcuts.mjs'

const EXIT_OK = 0
const EXIT_ERROR = 1

function parseArgs(argv) {
  const options = { apply: false, purge: false, dataDir: '', help: false }
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
      case '--purge':
        options.purge = true
        break
      case '--data-dir':
        options.dataDir = next()
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
    'dsh-tray-follower bridge uninstaller (user level)',
    '',
    '  node tools/uninstall-bridge.mjs [--apply] [--data-dir <path>] [--purge]',
    '',
    '  --apply     execute (default: dry run, only prints the plan)',
    '  --purge     also delete logs / state / cursor (the whole data dir)',
    '  --data-dir  bridge data dir (default %LOCALAPPDATA%\\dsh-tray-follower)'
  ].join('\n')
}

function printLine(line = '') {
  try {
    console.log(line)
  } catch (_error) {
    /* ignore */
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (_error) {
    return null
  }
}

function isInside(parent, child) {
  const resolvedParent = path.resolve(parent)
  const resolvedChild = path.resolve(child)
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`)
}

async function main() {
  const options = parseArgs(process.argv.slice(1))
  if (options.help) {
    printLine(usage())
    return EXIT_OK
  }

  const dataDir = path.resolve(options.dataDir || defaultDataDir(process.env))
  const appDir = path.join(dataDir, 'app')
  const installFile = path.join(appDir, 'install.json')
  const backupDir = path.join(dataDir, 'backup', 'shortcuts')
  const dshExe = process.env.DSH_DESKTOP_EXE || ''

  printLine('== dsh-tray-follower bridge uninstaller ==')
  printLine(`data dir:  ${dataDir}`)
  printLine(`mode:      ${options.apply ? 'APPLY' : 'dry run (pass --apply to execute)'}`)
  printLine()

  const install = fs.existsSync(installFile) ? readJson(installFile) : null
  if (!install) {
    printLine('No install manifest found; nothing recorded to restore.')
    const leftovers = [appDir, path.join(dataDir, 'backup')].filter((entry) => fs.existsSync(entry))
    if (leftovers.length === 0) {
      printLine('Bridge is not installed.')
      return EXIT_OK
    }
    printLine('Leftover directories found:')
    for (const entry of leftovers) printLine(`  ${entry}`)
    printLine('They were not created by a recorded install; remove them manually if desired.')
    return EXIT_OK
  }

  printLine(`manifest version: ${String(install.version || 'unknown')} (installed ${String(install.installedAt || 'unknown')})`)

  const shortcuts = Array.isArray(install.shortcuts) ? install.shortcuts : []
  const plannedShortcuts = []
  for (const record of shortcuts) {
    const shortcutPath = typeof record.path === 'string' ? record.path : ''
    if (!shortcutPath) continue
    const exists = fs.existsSync(shortcutPath)
    if (record.created === true) {
      plannedShortcuts.push({ path: shortcutPath, action: exists ? 'delete-created' : 'missing', backup: '' })
      continue
    }
    const backupPath = typeof record.backup === 'string' ? record.backup : ''
    if (backupPath && fs.existsSync(backupPath)) {
      plannedShortcuts.push({ path: shortcutPath, action: 'restore-backup', backup: backupPath })
      continue
    }
    if (record.original && typeof record.original === 'object') {
      plannedShortcuts.push({ path: shortcutPath, action: 'rewrite-original', backup: '', original: record.original })
      continue
    }
    plannedShortcuts.push({ path: shortcutPath, action: 'skip', reason: 'no backup recorded', backup: '' })
  }

  printLine('planned shortcut changes:')
  if (plannedShortcuts.length === 0) printLine('  (none)')
  for (const item of plannedShortcuts) {
    if (item.action === 'restore-backup') printLine(`  restore  ${item.path}  <- ${item.backup}`)
    else if (item.action === 'delete-created') printLine(`  delete   ${item.path} (created by installer)`)
    else if (item.action === 'rewrite-original') printLine(`  rewrite  ${item.path} (from manifest fields; no byte backup)`)
    else printLine(`  skip     ${item.path} (${item.reason || item.action})`)
  }

  const payload = Array.isArray(install.payload) ? install.payload : ['app/shell-hook', 'app/injector', 'app/launcher']
  printLine('planned payload removal:')
  for (const relative of payload) printLine(`  remove   ${path.join(dataDir, relative)}`)
  printLine(`  remove   ${installFile}`)
  if (options.purge) printLine(`  purge    ${dataDir} (logs / state / cursor / backups)`)
  printLine()

  if (!options.apply) {
    printLine('Dry run complete. Re-run with --apply to uninstall.')
    return EXIT_OK
  }

  let errors = 0

  // 1. Restore / delete shortcuts.
  for (const item of plannedShortcuts) {
    try {
      if (item.action === 'restore-backup') {
        const current = fs.existsSync(item.path) ? readShortcut(item.path) : { ok: true, shortcut: null }
        if (current.ok) {
          fs.copyFileSync(item.backup, item.path)
          printLine(`restored shortcut from backup: ${item.path}`)
        }
      } else if (item.action === 'delete-created') {
        fs.rmSync(item.path, { force: true })
        printLine(`deleted created shortcut: ${item.path}`)
      } else if (item.action === 'rewrite-original') {
        const written = writeShortcut(item.path, {
          targetPath: item.original.targetPath,
          arguments: item.original.arguments,
          workingDirectory: item.original.workingDirectory,
          iconLocation: item.original.iconLocation,
          description: item.original.description
        })
        if (!written.ok) throw new Error(written.error)
        printLine(`rewrote shortcut from manifest fields: ${item.path}`)
      } else if (item.action === 'missing') {
        printLine(`shortcut already gone: ${item.path}`)
      }
    } catch (error) {
      errors += 1
      printLine(`ERROR: shortcut restore failed for ${item.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 2. Remove payload directories (guarded: must stay inside dataDir).
  for (const relative of payload) {
    const target = path.join(dataDir, relative)
    try {
      if (!isInside(dataDir, target)) {
        printLine(`skip payload outside data dir: ${target}`)
        continue
      }
      if (!fs.existsSync(target)) continue
      fs.rmSync(target, { recursive: true, force: true })
      printLine(`removed payload: ${target}`)
    } catch (error) {
      errors += 1
      printLine(`ERROR: cannot remove ${target}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    fs.rmSync(installFile, { force: true })
    printLine(`removed manifest: ${installFile}`)
  } catch (error) {
    errors += 1
    printLine(`ERROR: cannot remove ${installFile}: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 3. Remove now-empty backup directory unless purging everything.
  if (!options.purge) {
    try {
      const remaining = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : []
      if (remaining.length === 0) fs.rmSync(backupDir, { recursive: true, force: true })
    } catch (_error) {
      /* ignore */
    }
  }

  // 4. Optional full purge of the data dir.
  if (options.purge) {
    const resolved = path.resolve(dataDir)
    const looksLikeDataDir = path.basename(resolved) === 'dsh-tray-follower' || fs.existsSync(path.join(resolved, 'bridge.log'))
    if (!looksLikeDataDir) {
      printLine(`REFUSING to purge ${resolved}: does not look like the bridge data dir.`)
      errors += 1
    } else {
      try {
        fs.rmSync(resolved, { recursive: true, force: true })
        printLine(`purged data dir: ${resolved}`)
      } catch (error) {
        errors += 1
        printLine(`ERROR: cannot purge ${resolved}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  printLine()
  if (errors > 0) {
    printLine(`UNINSTALL finished with ${String(errors)} error(s); review the messages above.`)
    return EXIT_ERROR
  }
  printLine('UNINSTALLED.')
  printLine('The next DeepSeek Harness launch from the restored shortcut runs without the bridge.')
  if (!options.purge) {
    printLine(`Logs kept at ${path.join(dataDir, 'bridge.log')} (use --purge to delete all bridge data).`)
  }
  return EXIT_OK
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
