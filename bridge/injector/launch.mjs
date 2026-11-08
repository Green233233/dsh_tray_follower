#!/usr/bin/env node
// Production bridge launcher.
//
// Starts DSH Desktop with a loopback-only Node inspector, injects the shell hook
// through CDP, then lets DSH keep running (the injector process exits). If the
// bridge cannot be injected, the paused instance is killed and DSH is relaunched
// normally so the user still gets the application, with a clear error message.
//
// Usage (installed layout):
//   node "%LOCALAPPDATA%\dsh-tray-follower\app\injector\launch.mjs"
// Usage (repo dev):
//   node bridge/injector/launch.mjs
//
// Options:
//   --data-dir <path>        bridge data dir (default: %LOCALAPPDATA%\dsh-tray-follower)
//   --exe <path>             DSH Desktop exe (default: %LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe)
//   --hook <path>            hook.cjs path (default: <app>/shell-hook/hook.cjs)
//   --port <n>               preferred inspector port (default 9531, falls back to a free port)
//   --timeout-ms <n>         inspector/main-module wait budget (default 30000)
//   --adopt-timeout-ms <n>   tray adoption wait budget (default 15000)
//   --keep-inspector         keep the inspector open after injection (debugging only)
//   --no-fallback            do not relaunch DSH when injection fails
//   --dry-run                print the plan and exit without launching anything
//   --help

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { injectIntoTarget } from './lib/injector.mjs'
import { createFileLogger } from './lib/log.mjs'
import {
  defaultDataDir,
  defaultDshExe,
  inspectPortFromEnv,
  sanitizeDshEnv,
  SANITIZED_ENV_KEYS
} from './lib/env.mjs'
import { pickFreePort } from './lib/ports.mjs'
import { isProcessAlive, killProcessTree, listDshBrowserPids } from './lib/processes.mjs'

const EXIT_OK = 0
const EXIT_ERROR = 2
const EXIT_ALREADY_RUNNING = 4

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.dirname(here) // installed: <dataDir>\app ; dev: <repo>\bridge

function parseArgs(argv) {
  const options = {
    dataDir: '',
    exe: '',
    hookPath: '',
    port: 0,
    timeoutMs: 30000,
    adoptTimeoutMs: 15000,
    keepInspector: false,
    noFallback: false,
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
      case '--data-dir':
        options.dataDir = next()
        break
      case '--exe':
        options.exe = next()
        break
      case '--hook':
        options.hookPath = next()
        break
      case '--port':
        options.port = Number.parseInt(next(), 10)
        break
      case '--timeout-ms':
        options.timeoutMs = Number.parseInt(next(), 10)
        break
      case '--adopt-timeout-ms':
        options.adoptTimeoutMs = Number.parseInt(next(), 10)
        break
      case '--keep-inspector':
        options.keepInspector = true
        break
      case '--no-fallback':
        options.noFallback = true
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
  if (!Number.isFinite(options.port) || options.port < 1 || options.port > 65535) options.port = 0
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) options.timeoutMs = 30000
  if (!Number.isFinite(options.adoptTimeoutMs) || options.adoptTimeoutMs < 1000) options.adoptTimeoutMs = 15000
  return options
}

function usage() {
  return [
    'dsh-tray-follower bridge launcher',
    '',
    '  node launch.mjs [--data-dir <path>] [--exe <path>] [--hook <path>] [--port <n>]',
    '                 [--timeout-ms <n>] [--adopt-timeout-ms <n>] [--keep-inspector]',
    '                 [--no-fallback] [--dry-run] [--help]'
  ].join('\n')
}

function resolveLayout(options) {
  const env = process.env
  const installed = path.basename(appRoot) === 'app'
  const dataDir = path.resolve(
    options.dataDir || env.DSH_TRAY_FOLLOWER_DIR || (installed ? path.dirname(appRoot) : defaultDataDir(env))
  )
  const hookPath = path.resolve(options.hookPath || path.join(appRoot, 'shell-hook', 'hook.cjs'))
  const hookDir = path.dirname(hookPath)
  const exePath = path.resolve(options.exe || defaultDshExe(env))
  return { dataDir, hookPath, hookDir, exePath, installed }
}

function buildChildEnv(overrides = {}) {
  const env = sanitizeDshEnv(process.env)
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === null || overrides[key] === undefined) delete env[key]
    else env[key] = String(overrides[key])
  }
  return env
}

function spawnDsh(exePath, args, options = {}) {
  const child = spawn(exePath, args, {
    env: buildChildEnv(),
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
  return child
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
  const layout = resolveLayout(options)
  const plan = {
    mode: layout.installed ? 'installed' : 'dev',
    exePath: layout.exePath,
    hookPath: layout.hookPath,
    hookDir: layout.hookDir,
    dataDir: layout.dataDir,
    preferredPort: options.port || inspectPortFromEnv(process.env),
    keepInspector: options.keepInspector,
    noFallback: options.noFallback,
    sanitizedEnvKeys: SANITIZED_ENV_KEYS
  }

  if (!fs.existsSync(layout.exePath)) {
    printLine(`ERROR: DSH Desktop executable not found: ${layout.exePath}`)
    return EXIT_ERROR
  }
  if (!fs.existsSync(layout.hookPath)) {
    printLine(`ERROR: bridge hook not found: ${layout.hookPath} (run tools/install-bridge.mjs first)`)
    return EXIT_ERROR
  }

  if (options.dryRun) {
    // Dry run must not touch the data dir: print the plan and exit before logging.
    printLine(JSON.stringify({ dryRun: true, plan }, null, 2))
    return EXIT_OK
  }

  const logger = createFileLogger({ file: path.join(layout.dataDir, 'injector.log'), maxBytes: 512 * 1024 })
  logger.log('launch-plan', plan)

  // Never disturb an already running DSH: a second instance would be rejected by
  // the single-instance lock, and we cannot inject into the already running one.
  const running = listDshBrowserPids({ exeName: path.basename(layout.exePath) })
  if (running.ok && running.pids.length > 0) {
    logger.log('already-running', { pids: running.pids })
    printLine(
      `ALREADY_RUNNING: DeepSeek Harness 正在运行 (PID ${running.pids.join(', ')})。` +
        ' 本次将以普通模式启动（只聚焦已有窗口）；如需托盘跟随，请先完全退出 DSH，再从本快捷方式启动。'
    )
    if (!options.noFallback) {
      try {
        spawnDsh(layout.exePath, [], {})
        logger.log('relaunched-normal-already-running')
      } catch (error) {
        logger.error('relaunch-normal-failed', error)
      }
    }
    return EXIT_ALREADY_RUNNING
  }

  let port
  try {
    port = await pickFreePort(options.port || inspectPortFromEnv(process.env))
  } catch (error) {
    logger.error('port-allocation-failed', error)
    printLine(`ERROR: 无法分配本地 inspector 端口: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_ERROR
  }
  plan.port = port
  logger.log('spawning-dsh', { exePath: layout.exePath, port })

  let child
  try {
    child = spawnDsh(layout.exePath, [`--inspect=127.0.0.1:${port}`], {})
  } catch (error) {
    logger.error('spawn-failed', error)
    printLine(`ERROR: 无法启动 DeepSeek Harness: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_ERROR
  }
  const pid = child.pid
  logger.log('dsh-spawned', { pid, port })

  const result = await injectIntoTarget({
    port,
    hookPath: layout.hookPath,
    hookDir: layout.hookDir,
    dataDir: layout.dataDir,
    timeoutMs: options.timeoutMs,
    adoptTimeoutMs: options.adoptTimeoutMs,
    intervalMs: 100,
    keepInspector: options.keepInspector,
    isProcessAlive: () => isProcessAlive(pid),
    log: (message, data) => logger.log(message, data)
  })
  result.pid = pid
  result.port = port
  logger.log('inject-result', result)

  if (result.ok) {
    const diagnostics = result.diagnostics || {}
    printLine(
      `BRIDGE_OK: injected into DeepSeek Harness (pid ${pid}); ` +
        `patched=${String(diagnostics.patched)} trayAdopted=${String(diagnostics.trayAdopted)} ` +
        `menuRebuilds=${String(diagnostics.menuRebuilds || 0)} inspector=${options.keepInspector ? 'kept' : 'closing'}`
    )
    return EXIT_OK
  }

  logger.error('inject-failed', { stage: result.stage, errors: result.errors })
  // Avoid leaving a paused / inspector-only DSH instance around.
  try {
    killProcessTree(pid)
  } catch (error) {
    logger.error('kill-failed-instance', error)
  }
  if (!options.noFallback) {
    try {
      spawnDsh(layout.exePath, [], {})
      logger.log('relaunched-normal-after-failure')
    } catch (error) {
      logger.error('relaunch-normal-failed', error)
    }
  }
  const detail =
    result.errors && result.errors.length > 0 ? result.errors[result.errors.length - 1] : `injection failed at stage ${result.stage}`
  printLine(`ERROR: 托盘跟随桥接注入失败（阶段: ${result.stage}）。${detail}`)
  printLine(`       日志: ${path.join(layout.dataDir, 'injector.log')}`)
  if (!options.noFallback) printLine('       已以普通模式重新启动 DeepSeek Harness。')
  return EXIT_ERROR
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
