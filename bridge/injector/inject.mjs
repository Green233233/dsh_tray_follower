#!/usr/bin/env node
// Manual injector: attach to an ALREADY running DSH Desktop instance that was
// started by hand with the loopback inspector enabled, e.g.
//
//   "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" --inspect=127.0.0.1:9531
//   node bridge/injector/inject.mjs --port 9531
//
// This does not launch or quit DSH. It is useful for development and for the E2E
// probe; the production path is bridge/injector/launch.mjs (used by the shortcut).
//
// Options:
//   --port <n>               inspector port (default 9531 / DSH_TRAY_FOLLOWER_INSPECT_PORT)
//   --hook <path>            hook.cjs path (default <repo>/bridge/shell-hook/hook.cjs)
//   --data-dir <path>        bridge data dir (default %LOCALAPPDATA%\dsh-tray-follower)
//   --timeout-ms <n>         inspector/main-module wait budget (default 30000)
//   --adopt-timeout-ms <n>   tray adoption wait budget (default 15000)
//   --inject-only            patch only, skip tray adoption / finalize
//   --keep-inspector         keep the inspector open after injection
//   --dry-run                print the plan and exit
//   --help

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { injectIntoTarget } from './lib/injector.mjs'
import { createFileLogger } from './lib/log.mjs'
import { defaultDataDir, defaultDshExe, inspectPortFromEnv } from './lib/env.mjs'

const EXIT_OK = 0
const EXIT_ERROR = 1

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.dirname(here) // installed: <dataDir>\app ; dev: <repo>\bridge

function parseArgs(argv) {
  const options = {
    port: inspectPortFromEnv(process.env),
    hookPath: '',
    dataDir: '',
    timeoutMs: 30000,
    adoptTimeoutMs: 15000,
    injectOnly: false,
    keepInspector: false,
    dryRun: false,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      return argv[index] === undefined ? '' : argv[index]
    }
    switch (arg) {
      case '--port':
        options.port = Number.parseInt(next(), 10)
        break
      case '--hook':
        options.hookPath = next()
        break
      case '--data-dir':
        options.dataDir = next()
        break
      case '--timeout-ms':
        options.timeoutMs = Number.parseInt(next(), 10)
        break
      case '--adopt-timeout-ms':
        options.adoptTimeoutMs = Number.parseInt(next(), 10)
        break
      case '--inject-only':
        options.injectOnly = true
        break
      case '--keep-inspector':
        options.keepInspector = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        break
    }
  }
  if (!Number.isFinite(options.port) || options.port < 1 || options.port > 65535) options.port = 9531
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) options.timeoutMs = 30000
  if (!Number.isFinite(options.adoptTimeoutMs) || options.adoptTimeoutMs < 1000) options.adoptTimeoutMs = 15000
  return options
}

function usage() {
  return [
    'dsh-tray-follower manual injector',
    '',
    '  node inject.mjs [--port <n>] [--hook <path>] [--data-dir <path>]',
    '                  [--timeout-ms <n>] [--adopt-timeout-ms <n>]',
    '                  [--inject-only] [--keep-inspector] [--dry-run] [--help]',
    '',
    'Start DSH Desktop with --inspect=127.0.0.1:<port> before running this.'
  ].join('\n')
}

function printLine(line) {
  try {
    console.log(line)
  } catch (_error) {
    /* ignore */
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(1))
  if (options.help) {
    printLine(usage())
    return EXIT_OK
  }
  const installed = path.basename(appRoot) === 'app'
  const dataDir = path.resolve(options.dataDir || process.env.DSH_TRAY_FOLLOWER_DIR || (installed ? path.dirname(appRoot) : defaultDataDir(process.env)))
  const hookPath = path.resolve(options.hookPath || path.join(appRoot, 'shell-hook', 'hook.cjs'))
  const hookDir = path.dirname(hookPath)
  const plan = {
    port: options.port,
    hookPath,
    hookDir,
    dataDir,
    exePath: defaultDshExe(process.env),
    timeoutMs: options.timeoutMs,
    adoptTimeoutMs: options.adoptTimeoutMs,
    injectOnly: options.injectOnly,
    keepInspector: options.keepInspector
  }

  if (options.dryRun) {
    printLine(JSON.stringify({ dryRun: true, plan, hookExists: fs.existsSync(hookPath) }, null, 2))
    return EXIT_OK
  }
  if (!fs.existsSync(hookPath)) {
    printLine(`ERROR: bridge hook not found: ${hookPath}`)
    printLine('       Run tools/install-bridge.mjs first, or pass --hook <path>.')
    return EXIT_ERROR
  }

  const logger = createFileLogger({ file: path.join(dataDir, 'injector.log'), maxBytes: 512 * 1024 })
  logger.log('manual-inject-plan', plan)

  const result = await injectIntoTarget({
    port: options.port,
    hookPath,
    hookDir,
    dataDir,
    timeoutMs: options.timeoutMs,
    adoptTimeoutMs: options.adoptTimeoutMs,
    intervalMs: 100,
    injectOnly: options.injectOnly,
    keepInspector: options.keepInspector,
    log: (message, data) => logger.log(message, data)
  })
  logger.log('manual-inject-result', result)
  printLine(JSON.stringify(result, null, 2))
  if (!result.ok) {
    printLine(`ERROR: injection failed at stage ${result.stage}`)
    printLine(`       日志: ${path.join(dataDir, 'injector.log')}`)
    return EXIT_ERROR
  }
  const diagnostics = result.diagnostics || {}
  printLine(
    `BRIDGE_OK: patched=${String(diagnostics.patched)} trayAdopted=${String(diagnostics.trayAdopted)} ` +
      `menuRebuilds=${String(diagnostics.menuRebuilds || 0)} inspector=${options.keepInspector ? 'kept' : 'closing'}`
  )
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
