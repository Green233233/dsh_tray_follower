#!/usr/bin/env node
// Isolated end-to-end probe for the dsh-tray-follower shell bridge.
//
// SAFETY: this launches a SECOND DeepSeek Harness Desktop instance with an
// isolated --user-data-dir and an isolated DSH_HOME, attaches to its loopback
// Node inspector, injects the hook, verifies the tray menu / notification
// evidence, then quits that instance. The already-running DSH instance is never
// touched (a different user-data-dir means a different Electron single-instance
// lock; a different DSH_HOME means a different profile lock).
//
// The instance is started with `--inspect=127.0.0.1:<port>` only. Child env has
// ELECTRON_RUN_AS_NODE / NODE_OPTIONS removed (the DSH host exports
// ELECTRON_RUN_AS_NODE to tool shells, which would turn the exe into plain Node).
//
// Runs are DISABLED by default: pass --execute to actually launch DSH.
//
// Usage:
//   node tools/probe-electron-hook.mjs --execute [--port 9541] [--keep] [--no-notification]
//
// Evidence: bridge.log diagnostics (state-loaded / tray-captured / tray-adopted /
// menu-rebuilt / notification-shown) plus the JSON returned by the hook.
//
// Cleanup: quits the instance via its own API, kills the whole process tree of
// exactly the spawned PID (never by image name), removes the temp dirs unless
// --keep, and reports the temp dir path on failure.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { INSPECT_DEFAULT_PORT, defaultDshExe, sanitizeDshEnv } from '../bridge/injector/lib/env.mjs'
import { buildQuitExpression } from '../bridge/injector/lib/bootstrap.mjs'
import { CdpClient, waitForInspectorTarget, waitForMainModule, sleep } from '../bridge/injector/lib/cdp.mjs'
import { injectIntoTarget } from '../bridge/injector/lib/injector.mjs'
import {
  findProcessesByToken,
  isProcessAlive,
  killProcessTree,
  killProcesses,
  listDshBrowserPids,
  waitForProcessExit
} from '../bridge/injector/lib/processes.mjs'

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.dirname(here)

const EXPECTED_HEADER = '对话：1 运行 / 1 待处理'
const EXPECTED_LABELS = [
  '📁 探针工作区 A  运行 1 · 待处理 1',
  '⏸ 等待批准的对话',
  '▶ 运行中的对话',
  '✓ 已完成的对话',
  '📁 Probe Workspace B  运行 0 · 待处理 0',
  '空闲会话 (1)',
  '○ 空闲对话',
  'dsh-tray-follower v0.1.0'
]

function parseArgs(argv) {
  const options = {
    execute: false,
    keep: false,
    showNotification: true,
    port: INSPECT_DEFAULT_PORT + 10,
    timeoutMs: 120000,
    adoptTimeoutMs: 45000,
    exe: '',
    hook: '',
    dataDir: '',
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      return argv[index] === undefined ? '' : argv[index]
    }
    switch (arg) {
      case '--execute':
        options.execute = true
        break
      case '--keep':
        options.keep = true
        break
      case '--no-notification':
        options.showNotification = false
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
      case '--exe':
        options.exe = next()
        break
      case '--hook':
        options.hook = next()
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
  if (!Number.isFinite(options.port) || options.port < 1 || options.port > 65535) options.port = INSPECT_DEFAULT_PORT + 10
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10000) options.timeoutMs = 120000
  if (!Number.isFinite(options.adoptTimeoutMs) || options.adoptTimeoutMs < 5000) options.adoptTimeoutMs = 45000
  return options
}

function usage() {
  return [
    'dsh-tray-follower isolated E2E probe',
    '',
    '  node tools/probe-electron-hook.mjs --execute [--port <n>] [--keep] [--no-notification]',
    '',
    '  --execute          actually launch an isolated DSH Desktop instance (required)',
    '  --keep             keep the temp dirs/logs for inspection',
    '  --no-notification  do not show the self-test notification (diag evidence only)',
    '  --port <n>         inspector port (default 9541)',
    '  --timeout-ms <n>   overall evidence timeout (default 120000)',
    '  --adopt-timeout-ms <n> tray adoption timeout (default 45000)',
    '  --exe <path>       DSH executable override',
    '  --hook <path>      hook.cjs override',
    '  --data-dir <path>  bridge data dir for injected logs (default: temp dir)',
    '',
    'Exit code 0 = PASS, 1 = FAIL, 2 = usage.'
  ].join('\n')
}

function printLine(line = '') {
  try {
    console.log(line)
  } catch (_error) {
    /* ignore */
  }
}

function readBridgeLog(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (_error) {
    return { ok: false, text: '', lines: [], diags: [], logLines: [] }
  }
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0)
  const diags = []
  const logLines = []
  for (const line of lines) {
    if (line.startsWith('{')) {
      try {
        const decoded = JSON.parse(line)
        if (decoded && decoded.type === 'diag') {
          diags.push(decoded)
          continue
        }
      } catch (_error) {
        /* fall through to plain log line */
      }
    }
    logLines.push(line)
  }
  return { ok: true, text, lines, diags, logLines }
}

function flattenLabels(items) {
  const labels = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue
    if (typeof item.label === 'string') labels.push(item.label)
    if (Array.isArray(item.submenu)) labels.push(...flattenLabels(item.submenu))
  }
  return labels
}

function findLastDiag(diags, event) {
  let found = null
  for (const diag of diags) {
    if (diag && diag.event === event) found = diag
  }
  return found
}

function menuEvidenceReady(snapshot) {
  if (!snapshot.ok) return false
  const menuDiag = findLastDiag(snapshot.diags, 'menu-rebuilt')
  if (!menuDiag || !menuDiag.data) return false
  const labels = flattenLabels(menuDiag.data.section)
  const hasHeader = labels.includes(EXPECTED_HEADER)
  const hasAllExpected = EXPECTED_LABELS.every((label) => labels.includes(label))
  const notificationDiag = findLastDiag(snapshot.diags, 'notification-shown')
  const notificationTest = findLastDiag(snapshot.diags, 'notification-test')
  const hasNotification = Boolean(notificationTest && notificationTest.data && notificationTest.data.shown === true) || Boolean(notificationDiag)
  const trayDiag = findLastDiag(snapshot.diags, 'tray-adopted')
  return hasHeader && hasAllExpected && hasNotification && Boolean(trayDiag)
}

function buildFixtureState() {
  const now = Date.now()
  return {
    schemaVersion: 1,
    updatedAt: now,
    hostPid: 0,
    webOrigin: 'http://127.0.0.1:1',
    workspaces: [
      {
        id: 'ws_probe_a',
        title: '探针工作区 A',
        path: 'C:\\probe\\workspace-a',
        sessions: [
          { id: 's_probe_running', title: '运行中的对话', status: 'running', detail: '探针', updatedAt: now, startedAt: now },
          { id: 's_probe_waiting', title: '等待批准的对话', status: 'waiting-approval', detail: '', updatedAt: now },
          { id: 's_probe_done', title: '已完成的对话', status: 'completed', detail: '', updatedAt: now }
        ]
      },
      {
        id: 'ws_probe_b',
        title: 'Probe Workspace B',
        path: 'C:\\probe\\workspace-b',
        sessions: [{ id: 's_probe_idle', title: '空闲对话', status: 'idle', detail: '', updatedAt: now }]
      }
    ],
    unreadEvents: [
      {
        id: 'evt_probe_completed',
        kind: 'completed',
        sessionId: 's_probe_running',
        workspaceId: 'ws_probe_a',
        title: '任务完成',
        body: '探针工作区 A • 运行中的对话',
        createdAt: now
      }
    ]
  }
}

async function waitForEvidence(logFile, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 250
  const predicate = typeof options.predicate === 'function' ? options.predicate : () => true
  const started = Date.now()
  let snapshot = readBridgeLog(logFile)
  while (Date.now() - started < timeoutMs) {
    snapshot = readBridgeLog(logFile)
    if (predicate(snapshot)) return { ok: true, snapshot, elapsedMs: Date.now() - started }
    await sleep(intervalMs)
  }
  return { ok: false, snapshot, elapsedMs: Date.now() - started }
}

async function quitInstance(port) {
  const inspector = await waitForInspectorTarget({ port, timeoutMs: 8000, intervalMs: 100 })
  if (!inspector.ok) return { ok: false, error: inspector.error }
  let client
  try {
    client = await CdpClient.connect(inspector.url, { timeoutMs: 8000 })
    await client.call('Runtime.enable', {}, { timeoutMs: 5000 })
    const ready = await waitForMainModule(client, { timeoutMs: 8000, intervalMs: 100 })
    if (!ready.ok) return { ok: false, error: ready.error }
    const result = await client.evaluate(buildQuitExpression())
    return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      if (client) client.close()
    } catch (_error) {
      /* ignore */
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(1))
  if (options.help) {
    printLine(usage())
    return EXIT_OK
  }

  const exePath = path.resolve(options.exe || defaultDshExe(process.env))
  const hookPath = path.resolve(options.hook || path.join(repoRoot, 'bridge', 'shell-hook', 'hook.cjs'))
  const runToken = `dsh-tray-follower-e2e-${Date.now().toString(36)}`
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${runToken}-`))
  const userDataDir = path.join(tempRoot, 'userdata')
  const dshHomeDir = path.join(tempRoot, 'dsh-home')
  const stateDir = path.resolve(options.dataDir || path.join(tempRoot, 'state'))
  const logsDir = path.join(tempRoot, 'logs')
  const bridgeLogFile = path.join(stateDir, 'bridge.log')
  const probeLogFile = path.join(logsDir, 'probe-evidence.log')
  const dshStderrFile = path.join(logsDir, 'dsh-stderr.log')
  for (const dir of [userDataDir, dshHomeDir, stateDir, logsDir]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'state.json'), `${JSON.stringify(buildFixtureState(), null, 2)}\n`, 'utf8')

  const evidence = []
  const record = (state, message) => {
    const line = `${state} ${message}`
    evidence.push(line)
    printLine(line)
  }

  const plan = {
    exePath,
    hookPath,
    tempRoot,
    userDataDir,
    dshHomeDir,
    stateDir,
    logsDir,
    inspectorPort: options.port,
    execute: options.execute,
    isolation: ['--user-data-dir=<temp>', 'DSH_HOME=<temp>', 'DSH_TRAY_FOLLOWER_DIR=<temp>'],
    envSanitized: ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE'],
    hookTestEnv: {
      DSH_TRAY_FOLLOWER_TEST: '1',
      DSH_TRAY_FOLLOWER_KEEP_INSPECTOR: '1',
      DSH_TRAY_FOLLOWER_TEST_SHOW_NOTIFICATION: options.showNotification ? '1' : '0'
    },
    expectedEvidence: [
      'injectIntoTarget ok with diagnostics.patched=true',
      'tray adopted (diagnostics.trayAdopted=true)',
      `menu-rebuilt diag contains header "${EXPECTED_HEADER}" plus workspace/session rows`,
      'notification-shown diag (self-test notification, kind "test")',
      `bridge.log: ${bridgeLogFile}`
    ]
  }
  printLine('== dsh-tray-follower isolated E2E probe ==')
  printLine(JSON.stringify(plan, null, 2))
  printLine('')

  if (!fs.existsSync(exePath)) {
    record('FAIL', `DSH executable not found: ${exePath}`)
    return EXIT_FAIL
  }
  if (!fs.existsSync(hookPath)) {
    record('FAIL', `hook not found: ${hookPath} (run tools/install-bridge.mjs first or pass --hook)`)
    return EXIT_FAIL
  }
  if (!options.execute) {
    record('DRY-RUN', 'no instance was launched. Re-run with --execute (requires Lead approval) to run the E2E probe.')
    if (!options.keep) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true })
        record('INFO', `removed dry-run temp dir ${tempRoot}`)
      } catch (_error) {
        /* ignore */
      }
    }
    printLine('')
    printLine('Cleanup: dry run leaves nothing behind.')
    return EXIT_OK
  }

  const running = listDshBrowserPids({ exeName: path.basename(exePath) })
  if (running.ok && running.pids.length > 0) {
    record('INFO', `a DSH instance is already running (pids ${running.pids.join(', ')}); the probe uses isolated profiles and will not touch it`)
  }

  let child = null
  let childPid = null
  let exitCode = EXIT_FAIL
  let dshStderrFd = null

  try {
    const env = sanitizeDshEnv(process.env, {
      DSH_HOME: dshHomeDir,
      DSH_TRAY_FOLLOWER_DIR: stateDir,
      DSH_TRAY_FOLLOWER_TEST: '1',
      DSH_TRAY_FOLLOWER_KEEP_INSPECTOR: '1',
      DSH_TRAY_FOLLOWER_TEST_SHOW_NOTIFICATION: options.showNotification ? '1' : '0',
      DSH_TRAY_FOLLOWER_TEST_EXIT_MS: String(Math.max(60000, options.timeoutMs + 30000)),
      DSH_TRAY_FOLLOWER_INSPECT_PORT: String(options.port)
    })
    dshStderrFd = fs.openSync(dshStderrFile, 'a')
    child = spawn(exePath, [`--inspect=127.0.0.1:${options.port}`, `--user-data-dir=${userDataDir}`], {
      env,
      detached: true,
      stdio: ['ignore', dshStderrFd, dshStderrFd],
      windowsHide: false
    })
    childPid = child.pid
    child.unref()
    record('INFO', `spawned isolated DSH (pid ${childPid}) inspector=127.0.0.1:${options.port}`)

    const injection = await injectIntoTarget({
      port: options.port,
      hookPath,
      dataDir: stateDir,
      timeoutMs: Math.min(options.timeoutMs, 45000),
      adoptTimeoutMs: options.adoptTimeoutMs,
      intervalMs: 100,
      keepInspector: true,
      isProcessAlive: () => isProcessAlive(childPid),
      log: (message, data) => record('LOG', `${message} ${data === undefined ? '' : JSON.stringify(data)}`)
    })
    if (!injection.ok) {
      record('FAIL', `injection failed at stage ${injection.stage}: ${injection.errors.join('; ') || 'unknown error'}`)
      return EXIT_FAIL
    }
    const diagnostics = injection.diagnostics || {}
    record('PASS', `hook injected (patched=${String(diagnostics.patched)}, adoptedTrays=${String(diagnostics.adoptedTrayCount)})`)
    if (injection.trays && injection.trays.ok === false) {
      record('WARN', `tray adoption poll did not report success: ${injection.trays.error || 'timeout'}`)
    }
    if (injection.trays && injection.trays.diagnostics && injection.trays.diagnostics.trayAdopted === true) {
      record('PASS', `tray adopted (count=${String(injection.trays.diagnostics.adoptedTrayCount)})`)
    }

    const evidenceWait = await waitForEvidence(bridgeLogFile, {
      timeoutMs: options.timeoutMs,
      intervalMs: 250,
      predicate: menuEvidenceReady
    })
    const snapshot = evidenceWait.snapshot
    const menuDiag = findLastDiag(snapshot.diags, 'menu-rebuilt')
    const menuLabels = menuDiag && menuDiag.data ? flattenLabels(menuDiag.data.section) : []
    const menuOk =
      Boolean(menuDiag) &&
      menuDiag.data &&
      menuDiag.data.unavailable === false &&
      menuLabels.includes(EXPECTED_HEADER) &&
      EXPECTED_LABELS.every((label) => menuLabels.includes(label))
    const originalItems = menuDiag && menuDiag.data && Array.isArray(menuDiag.data.original) ? menuDiag.data.original : []
    const originalOk =
      originalItems.length >= 3 &&
      originalItems.some((item) => typeof item.label === 'string' && /打开|Open/u.test(item.label)) &&
      originalItems.some((item) => typeof item.label === 'string' && /退出|Quit/u.test(item.label))
    const notificationDiag = findLastDiag(snapshot.diags, 'notification-shown')
    const notificationTestDiag = findLastDiag(snapshot.diags, 'notification-test')
    const notificationOk =
      Boolean(notificationTestDiag && notificationTestDiag.data && notificationTestDiag.data.shown === true) ||
      Boolean(notificationDiag)
    const notificationsInfo = diagnostics.notifications && typeof diagnostics.notifications === 'object' ? diagnostics.notifications : {}
    const notificationApiOk = notificationsInfo.provider === 'electron-main-process' && notificationsInfo.supported === true
    const trayDiag = findLastDiag(snapshot.diags, 'tray-adopted')
    const trayOk = Boolean(trayDiag) || Boolean(snapshot.diags.find((diag) => diag.event === 'tray-captured'))

    if (evidenceWait.ok) record('PASS', `bridge.log evidence observed after ${String(evidenceWait.elapsedMs)} ms`)
    else record('FAIL', `bridge.log evidence incomplete after ${String(evidenceWait.elapsedMs)} ms`)

    if (menuOk) record('PASS', `menu rebuilt with header "${EXPECTED_HEADER}"; labels: ${menuLabels.join(' | ')}`)
    else record('FAIL', `menu evidence mismatch; labels: ${menuLabels.join(' | ') || '(none)'}`)

    if (originalOk) record('PASS', `original menu items present: ${originalItems.map((item) => item.label || `[${item.type}]`).join(' | ')}`)
    else record('FAIL', `original Open/Quit items not evidenced: ${JSON.stringify(originalItems)}`)

    if (trayOk) record('PASS', 'tray capture/adoption evidenced')
    else record('FAIL', 'no tray capture/adoption evidence')

    if (notificationApiOk) {
      record(
        'PASS',
        `notification API is in-process Electron Notification (provider=${String(notificationsInfo.provider)}, isSupported=${String(notificationsInfo.supported)}) — attributed to DeepSeek Harness, no external notifier process`
      )
    } else {
      record(
        'FAIL',
        `notification API evidence missing/unsupported: ${JSON.stringify(notificationsInfo)} (bridge must use in-process Electron Notification only)`
      )
    }

    if (notificationOk) {
      record(
        'PASS',
        `native notification evidenced (${notificationDiag ? String(notificationDiag.data.kind) : 'test'}): ` +
          `${notificationDiag && notificationDiag.data ? String(notificationDiag.data.title || '') : ''}`
      )
    } else {
      record('FAIL', 'no notification evidence in bridge.log')
    }

    const diagEvents = snapshot.diags.map((diag) => diag.event).join(', ')
    record('INFO', `diag events seen: ${diagEvents || '(none)'}`)
    record('INFO', `hook diagnostics: ${JSON.stringify(diagnostics)}`)

    const pass = menuOk && originalOk && trayOk && notificationOk && notificationApiOk
    if (pass) {
      record('PASS', 'isolated E2E probe completed successfully')
      exitCode = EXIT_OK
    } else {
      record('FAIL', 'isolated E2E probe did not meet all acceptance checks')
      exitCode = EXIT_FAIL
    }
  } catch (error) {
    record('FAIL', `probe threw: ${error instanceof Error ? (error.stack || error.message) : String(error)}`)
    exitCode = EXIT_FAIL
  } finally {
    // 1. Ask the test instance to quit through its own API (best effort).
    if (childPid && isProcessAlive(childPid)) {
      const quit = await quitInstance(options.port)
      record(quit.ok ? 'INFO' : 'WARN', `quit requested via inspector: ${JSON.stringify(quit)}`)
      await waitForProcessExit(childPid, { timeoutMs: 10000, intervalMs: 150 })
    }
    // 2. Kill exactly the spawned process tree if it is still alive.
    if (childPid && isProcessAlive(childPid)) {
      const killed = killProcessTree(childPid)
      record(killed.ok ? 'INFO' : 'WARN', `killed leftover probe instance tree ${String(childPid)}: ${killed.ok}`)
      await waitForProcessExit(childPid, { timeoutMs: 5000, intervalMs: 150 })
    }
    // 3. Kill leftover Host child processes of this probe (identified by our
    //    unique temp token in their command line / environment).
    const leftovers = findProcessesByToken(runToken)
    if (leftovers.ok && leftovers.pids.length > 0) {
      const killed = killProcesses(leftovers.pids)
      record('WARN', `killed leftover probe processes: ${killed.map((entry) => entry.pid).join(', ')}`)
    }
    try {
      if (dshStderrFd !== null) fs.closeSync(dshStderrFd)
    } catch (_error) {
      /* ignore */
    }
    try {
      fs.writeFileSync(probeLogFile, `${evidence.join('\n')}\n`, 'utf8')
      record('INFO', `probe evidence written to ${probeLogFile}`)
    } catch (_error) {
      /* ignore */
    }
    if (!options.keep) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true })
        record('INFO', `removed temp dir ${tempRoot}`)
      } catch (error) {
        record('WARN', `could not remove temp dir ${tempRoot}: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      record('INFO', `kept temp dir (--keep): ${tempRoot}`)
    }
  }

  printLine('')
  printLine(exitCode === EXIT_OK ? 'PROBE RESULT: PASS' : 'PROBE RESULT: FAIL')
  if (exitCode !== EXIT_OK) {
    try {
      const tail = readBridgeLog(bridgeLogFile)
      if (tail.logLines.length > 0) {
        printLine('--- bridge.log tail ---')
        for (const line of tail.logLines.slice(-25)) printLine(line)
      }
    } catch (_error) {
      /* ignore */
    }
  }
  return exitCode
}

main()
  .then((code) => {
    process.exitCode = Number.isFinite(code) ? code : EXIT_USAGE
  })
  .catch((error) => {
    try {
      console.error(error)
    } catch (_error) {
      /* ignore */
    }
    process.exitCode = EXIT_FAIL
  })
