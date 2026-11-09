#!/usr/bin/env node
// Pure-Node self test for the dsh-tray-follower shell bridge.
//
// Does NOT launch Electron / DSH and never reads the real state directory: all
// filesystem tests use throwaway temp dirs and a fake `electron` API object.
//
// Usage: node tools/bridge-selftest.mjs
// Exit code 0 = all tests pass, 1 = failures.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { buildBootstrapExpression, buildDiagnosticsExpression, buildFinalizeExpression, buildQuitExpression } from '../bridge/injector/lib/bootstrap.mjs'
import { pickInspectorTarget, READINESS_EXPRESSION } from '../bridge/injector/lib/cdp.mjs'
import {
  defaultDataDir,
  defaultDshExe,
  inspectPortFromEnv,
  normalizePathForCompare,
  sanitizeDshEnv,
  SANITIZED_ENV_KEYS
} from '../bridge/injector/lib/env.mjs'
import { isDshBrowserCommandLine } from '../bridge/injector/lib/processes.mjs'
import { isPortFree, pickFreePort } from '../bridge/injector/lib/ports.mjs'
import { isDshShortcut, launcherShortcutFields, shortcutCandidates } from '../bridge/injector/lib/shortcuts.mjs'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shellHookRoot = path.join(repoRoot, 'bridge', 'shell-hook')
const loadLib = (name) => require(path.join(shellHookRoot, 'lib', name))

const constants = loadLib('constants.cjs')
const util = loadLib('util.cjs')
const logModule = loadLib('log.cjs')
const stateModule = loadLib('state.cjs')
const menuModel = loadLib('menu-model.cjs')
const notifyPolicy = loadLib('notify-policy.cjs')
const cursorModule = loadLib('cursor.cjs')
const trayPatch = loadLib('tray-patch.cjs')
const windowsModule = loadLib('windows.cjs')
const heartbeatModule = loadLib('heartbeat.cjs')
const bridgeModule = loadLib('bridge.cjs')
const extensionHostModule = loadLib('extension-host.cjs')
const hookModule = require(path.join(shellHookRoot, 'hook.cjs'))

// --- tiny harness -----------------------------------------------------------

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tray-follower-selftest-'))
  try {
    return await fn(dir)
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (_error) {
      /* ignore */
    }
  }
}

function writeStateFile(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8')
}

function sampleState(overrides = {}) {
  return {
    schemaVersion: 1,
    updatedAt: 1730000000000,
    hostPid: 4242,
    webOrigin: 'http://127.0.0.1:61983',
    workspaces: [
      {
        id: 'ws_a',
        title: 'dsh_tray_follower',
        path: 'C:\\repo\\dsh_tray_follower',
        sessions: [
          { id: 's_1', title: '配置 Git 等工程管理', status: 'running', detail: '正在执行 bash', updatedAt: 1730000000000 },
          { id: 's_2', title: '等待批准', status: 'waiting-approval', detail: '', updatedAt: 1730000000000 },
          { id: 's_3', title: '已完成的对话', status: 'completed', detail: '', updatedAt: 1730000000000 }
        ]
      },
      {
        id: 'ws_b',
        title: '第二工作区',
        sessions: [{ id: 's_4', title: '等待选择', status: 'waiting-choice' }]
      }
    ],
    unreadEvents: [],
    ...overrides
  }
}

// --- fake Electron -----------------------------------------------------------

function createFakeElectron(options = {}) {
  const fake = {
    shownNotifications: [],
    quitCalls: 0,
    exitCalls: 0,
    listeners: new Map()
  }
  const windows = Array.isArray(options.windows) ? options.windows : []

  class FakeMenu {
    constructor(items) {
      this.items = items
    }
  }
  FakeMenu.buildFromTemplate = (template) => new FakeMenu(Array.isArray(template) ? template : [])

  class FakeTray {
    constructor() {
      this.menu = null
      this.menuSets = []
      this.destroyed = false
      this.tooltip = 'DeepSeek Harness'
    }

    setContextMenu(menu) {
      this.menu = menu
      this.menuSets.push(menu)
    }

    getToolTip() {
      return this.tooltip
    }

    isDestroyed() {
      return this.destroyed
    }

    destroy() {
      this.destroyed = true
    }
  }

  class FakeNotification {
    static isSupported() {
      return options.notificationSupported !== false
    }

    constructor(notificationOptions) {
      this.options = notificationOptions
      this.handlers = new Map()
      fake.shownNotifications.push(notificationOptions)
    }

    on(event, handler) {
      this.handlers.set(event, handler)
      return this
    }

    show() {
      this.shown = true
    }
  }

  const app = {
    whenReady: () => Promise.resolve(),
    on(event, handler) {
      if (!fake.listeners.has(event)) fake.listeners.set(event, new Set())
      fake.listeners.get(event).add(handler)
    },
    removeListener(event, handler) {
      const set = fake.listeners.get(event)
      if (set) set.delete(handler)
    },
    getName: () => options.appName || 'DeepSeek Harness',
    getLocale: () => options.locale || 'zh-CN',
    getPath: (name) => path.join(options.userDataDir || os.tmpdir(), String(name || 'path')),
    getVersion: () => '0.2.2-rc.1',
    isPackaged: true,
    isReady: () => true,
    quit() {
      fake.quitCalls += 1
    },
    exit() {
      fake.exitCalls += 1
    },
    focus() {}
  }

  const electron = {
    app,
    Tray: FakeTray,
    Menu: FakeMenu,
    Notification: FakeNotification,
    BrowserWindow: { getAllWindows: () => windows.slice() },
    nativeImage: { createFromPath: () => ({}) },
    shell: { openExternal: () => {} }
  }
  return { electron, fake, windows }
}

function createFakeWindow(options = {}) {
  const record = { restored: 0, shown: 0, focused: 0, scripts: [] }
  const window = {
    record,
    webContents: {
      getURL: () => options.url || 'dsh-app://app/',
      executeJavaScript: (script) => {
        record.scripts.push(script)
        return Promise.resolve(true)
      }
    },
    isDestroyed: () => options.destroyed === true,
    isVisible: () => options.visible !== false,
    isMinimized: () => options.minimized === true,
    isFocused: () => options.focused === true,
    restore() {
      record.restored += 1
    },
    show() {
      record.shown += 1
    },
    focus() {
      record.focused += 1
    }
  }
  return window
}

function flattenLabels(items) {
  const labels = []
  for (const item of Array.isArray(items) ? items : []) {
    if (item && typeof item.label === 'string') labels.push(item.label)
    if (item && Array.isArray(item.submenu)) labels.push(...flattenLabels(item.submenu))
  }
  return labels
}

// --- util --------------------------------------------------------------------

test('util: sanitizeLabel strips control characters, collapses whitespace, truncates', () => {
  assert.equal(util.sanitizeLabel('  a\n\tb  ', 20), 'a b')
  assert.equal(util.sanitizeLabel('x'.repeat(10), 5), 'xxxx…')
  assert.equal(util.sanitizeLabel('', 10, 'fallback'), 'fallback')
  assert.equal(util.sanitizeLabel('\u0000\u0007', 10, 'fb'), 'fb')
})

test('util: env parsers are total', () => {
  assert.equal(util.parseEnvFlag('1'), true)
  assert.equal(util.parseEnvFlag('off'), false)
  assert.equal(util.parseEnvFlag(undefined, true), true)
  assert.equal(util.parseEnvFlag('garbage', false), false)
  assert.equal(util.parseEnvInt('250', 10), 250)
  assert.equal(util.parseEnvInt('abc', 10), 10)
  assert.equal(util.parseEnvInt('-5', 10, 1, 100), 1)
  assert.equal(util.parseEnvInt('5000', 10, 1, 100), 100)
})

test('util: toJsonSafe / safeJsonStringify never throw on cycles and functions', () => {
  const cycle = { name: 'x' }
  cycle.self = cycle
  cycle.fn = () => {}
  cycle.undef = undefined
  const safe = util.toJsonSafe(cycle)
  assert.equal(safe.name, 'x')
  assert.equal(safe.self, '[circular]')
  assert.equal('fn' in safe, false)
  assert.equal('undef' in safe, false)
  assert.equal(typeof util.safeJsonStringify(cycle), 'string')
})

test('util: countStatuses counts known and unknown statuses', () => {
  const counts = util.countStatuses([{ status: 'running' }, { status: 'running' }, { status: 'bogus' }], constants.STATUS_GLYPHS)
  assert.equal(counts.running, 2)
  assert.equal(counts.bogus, 1)
  assert.equal(counts.all, 3)
})

// --- state -------------------------------------------------------------------

test('state: missing file is reported without throwing', async () => {
  await withTempDir((dir) => {
    const read = stateModule.readStateFile(dir)
    assert.equal(read.ok, false)
    assert.equal(read.missing, true)
    assert.match(read.error, /missing/i)
  })
})

test('state: malformed JSON / non-object are rejected', async () => {
  await withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'state.json'), '{not json', 'utf8')
    assert.equal(stateModule.readStateFile(dir).ok, false)
    fs.writeFileSync(path.join(dir, 'state.json'), '[1,2,3]', 'utf8')
    const read = stateModule.readStateFile(dir)
    assert.equal(read.ok, false)
    assert.match(read.error, /not a JSON object/i)
  })
})

test('state: valid document is normalized with stats', () => {
  const read = stateModule.normalizeState(sampleState())
  assert.equal(read.ok, true)
  assert.equal(read.state.stats.running, 1)
  assert.equal(read.state.stats.pending, 2)
  assert.equal(read.state.stats.sessions, 4)
  assert.equal(read.state.stats.workspaces, 2)
  assert.equal(read.state.workspaces[0].sessions[0].title, '配置 Git 等工程管理')
})

test('state: unknown status falls back to idle with a warning', () => {
  const read = stateModule.normalizeState(
    sampleState({ workspaces: [{ id: 'w', title: 'w', sessions: [{ id: 's', title: 't', status: 'flying' }] }] })
  )
  assert.equal(read.ok, true)
  assert.equal(read.state.workspaces[0].sessions[0].status, constants.DEFAULT_STATUS)
  assert.ok(read.warnings.some((warning) => warning.includes('unknown status')))
})

test('state: missing titles/ids are synthesized and control characters cleaned', () => {
  const read = stateModule.normalizeState({
    workspaces: [
      {
        sessions: [
          { status: 'running', title: 'line1\nline2\u0007' },
          { status: 'running', title: 'ok', id: 's_ok' }
        ]
      }
    ]
  })
  assert.equal(read.ok, true)
  const workspace = read.state.workspaces[0]
  assert.match(workspace.id, /^ws-unknown-/)
  assert.match(workspace.sessions[0].id, /^session-unknown-/)
  assert.equal(workspace.sessions[0].title, 'line1 line2')
})

test('state: invalid unread events are dropped, valid ones normalized', () => {
  const read = stateModule.normalizeState(
    sampleState({
      unreadEvents: [
        null,
        { id: '' },
        { id: 'e1', kind: 'completed', title: '任务完成', body: 'x', sessionId: 's1', workspaceId: 'w1', createdAt: 1 },
        { id: 'e2', kind: 'unknown-kind', body: 'y' }
      ]
    })
  )
  assert.equal(read.ok, true)
  assert.equal(read.state.unreadEvents.length, 2)
  assert.equal(read.state.unreadEvents[0].id, 'e1')
  assert.equal(read.state.unreadEvents[1].kind, 'needs-attention')
  assert.ok(read.warnings.some((warning) => warning.includes('unreadEvents[0]')))
})

test('state: oversized arrays are truncated and warned', () => {
  const sessions = []
  for (let index = 0; index < 150; index += 1) sessions.push({ id: `s${index}`, title: `t${index}`, status: 'running' })
  const read = stateModule.normalizeState(sampleState({ workspaces: [{ id: 'w', title: 'w', sessions }] }))
  assert.equal(read.ok, true)
  assert.equal(read.state.workspaces[0].sessions.length, constants.LIMITS.maxSessionsPerWorkspace)
  assert.ok(read.warnings.some((warning) => warning.includes('truncated')))
})

test('state: contract v1 files keep working with v2 option defaults and no warnings', () => {
  const read = stateModule.normalizeState(sampleState())
  assert.equal(read.ok, true)
  assert.equal(read.state.schemaVersion, 1)
  assert.deepEqual(read.state.options, {
    tray: { showIdle: false, maxSessionsPerWorkspace: 6, showHeaderCounts: true, showFooter: true },
    notifications: {
      notifyOnCompleted: true,
      notifyOnFailed: true,
      notifyOnAttention: true,
      suppressWhenFocused: true,
      notificationSound: true
    }
  })
  assert.deepEqual(read.warnings, [])
})

test('state: contract v2 options normalize, clamp and fall back for invalid values', () => {
  const read = stateModule.normalizeState(
    sampleState({
      schemaVersion: 2,
      options: {
        tray: { showIdle: true, maxSessionsPerWorkspace: 99, showHeaderCounts: 'yes', showFooter: false },
        notifications: { notifyOnCompleted: false, suppressWhenFocused: false, notificationSound: false }
      }
    })
  )
  assert.equal(read.ok, true)
  assert.equal(read.state.schemaVersion, 2)
  assert.equal(read.state.options.tray.showIdle, true)
  assert.equal(read.state.options.tray.maxSessionsPerWorkspace, constants.LIMITS.maxSessionsPerWorkspaceOption)
  assert.equal(read.state.options.tray.showHeaderCounts, true, 'invalid boolean falls back to default')
  assert.equal(read.state.options.tray.showFooter, false)
  assert.equal(read.state.options.notifications.notifyOnCompleted, false)
  assert.equal(read.state.options.notifications.notifyOnFailed, true)
  assert.equal(read.state.options.notifications.suppressWhenFocused, false)
  assert.equal(read.state.options.notifications.notificationSound, false)
  assert.ok(read.warnings.length > 0)
})

test('state: v2 without options warns and uses defaults; unsupported schema parses best-effort', () => {
  const missing = stateModule.normalizeState(sampleState({ schemaVersion: 2 }))
  assert.equal(missing.ok, true)
  assert.deepEqual(missing.state.options, constants.DEFAULT_OPTIONS)
  assert.ok(missing.warnings.some((warning) => warning.includes('options')))

  const future = stateModule.normalizeState(sampleState({ schemaVersion: 9 }))
  assert.equal(future.ok, true)
  assert.ok(future.warnings.some((warning) => warning.includes('schemaVersion')))
})

test('constants: version 0.2.3 and contract schema v2', () => {
  assert.equal(constants.VERSION, '0.2.3')
  assert.equal(constants.SCHEMA_VERSION, 2)
  assert.deepEqual([...constants.SUPPORTED_SCHEMA_VERSIONS], [1, 2])
})

// --- menu model --------------------------------------------------------------

test('menu: header counts running and pending only', () => {
  const read = stateModule.normalizeState(sampleState())
  const section = menuModel.buildStatusSection(read.state, { version: '9.9.9', locale: 'zh-CN' })
  assert.equal(section[0].kind, 'header')
  assert.equal(section[0].label, '对话：1 运行 / 2 待处理')
  assert.equal(section[0].enabled, false)
})

test('menu: sessions sorted by attention priority and idle hidden by default', () => {
  const read = stateModule.normalizeState(
    sampleState({
      workspaces: [
        {
          id: 'w',
          title: 'WS',
          sessions: [
            { id: 's1', title: 'r', status: 'running' },
            { id: 's2', title: 'a', status: 'waiting-approval' },
            { id: 's3', title: 'c', status: 'waiting-choice' },
            { id: 's4', title: 'i', status: 'waiting-input' },
            { id: 's5', title: 'd', status: 'completed' },
            { id: 's6', title: 'f', status: 'failed' },
            { id: 's7', title: 'x', status: 'idle' }
          ]
        }
      ]
    })
  )
  assert.equal(read.state.options.tray.showIdle, false, 'contract default hides idle')
  const section = menuModel.buildStatusSection(read.state, { version: '0.2.0', locale: 'zh-CN' })
  const workspace = section.find((item) => item.kind === 'workspace')
  assert.ok(workspace)
  assert.equal(workspace.label, '📁 WS  运行 1 · 待处理 3')
  const activeLabels = workspace.submenu.filter((item) => item.kind === 'session').map((item) => item.label)
  assert.deepEqual(activeLabels, ['⏸ a', '❓ c', '⌨ i', '▶ r', '✓ d', '✖ f'])
  assert.equal(workspace.submenu.some((item) => item.kind === 'idle-group'), false, 'no idle submenu by default')
  assert.equal(activeLabels.some((label) => label.startsWith('○')), false, 'no idle rows by default')

  const shown = menuModel.buildStatusSection(read.state, {
    version: '0.2.0',
    locale: 'zh-CN',
    tray: { showIdle: true }
  })
  const shownWorkspace = shown.find((item) => item.kind === 'workspace')
  const idleGroup = shownWorkspace.submenu.find((item) => item.kind === 'idle-group')
  assert.ok(idleGroup, 'idle submenu expected when showIdle=true')
  assert.equal(idleGroup.label, '空闲会话 (1)')
  assert.deepEqual(idleGroup.submenu.map((item) => item.label), ['○ x'])
})

test('menu: at most 6 active rows plus overflow row (default maxSessionsPerWorkspace)', () => {
  const sessions = []
  for (let index = 0; index < 9; index += 1) sessions.push({ id: `r${index}`, title: `run ${index}`, status: 'running' })
  const read = stateModule.normalizeState(sampleState({ workspaces: [{ id: 'w', title: 'W', sessions }] }))
  const section = menuModel.buildStatusSection(read.state, { version: '0.2.0', locale: 'zh-CN' })
  const workspace = section.find((item) => item.kind === 'workspace')
  const active = workspace.submenu.filter((item) => item.kind === 'session')
  assert.equal(active.length, 6)
  const overflow = workspace.submenu.find((item) => item.kind === 'placeholder')
  assert.ok(overflow)
  assert.equal(overflow.label, '… 还有 3 个会话')
})

test('menu: options.tray.maxSessionsPerWorkspace drives the inline row limit', () => {
  const sessions = []
  for (let index = 0; index < 5; index += 1) sessions.push({ id: `r${index}`, title: `run ${index}`, status: 'running' })
  const published = stateModule.normalizeState(
    sampleState({
      schemaVersion: 2,
      options: { tray: { maxSessionsPerWorkspace: 2 } },
      workspaces: [{ id: 'w', title: 'W', sessions }]
    })
  )
  const section = menuModel.buildStatusSection(published.state, { version: '0.2.0', locale: 'zh-CN' })
  const workspace = section.find((item) => item.kind === 'workspace')
  assert.equal(workspace.submenu.filter((item) => item.kind === 'session').length, 2)
  assert.ok(workspace.submenu.some((item) => item.label === '… 还有 3 个会话'))

  // Out-of-range published values are clamped to 1..20 by state normalization.
  const clamped = stateModule.normalizeState(
    sampleState({ schemaVersion: 2, options: { tray: { maxSessionsPerWorkspace: 99 } }, workspaces: [{ id: 'w', title: 'W', sessions }] })
  )
  assert.equal(clamped.state.options.tray.maxSessionsPerWorkspace, 20)
})

test('menu: showHeaderCounts=false renders the global header without counts', () => {
  const read = stateModule.normalizeState(
    sampleState({ schemaVersion: 2, options: { tray: { showHeaderCounts: false } } })
  )
  const zh = menuModel.buildStatusSection(read.state, { version: '0.2.0', locale: 'zh-CN' })
  assert.equal(zh[0].label, '对话')
  const en = menuModel.buildStatusSection(read.state, { version: '0.2.0', locale: 'en-US' })
  assert.equal(en[0].label, 'Conversations')
})

test('menu: showFooter=false removes the version footer', () => {
  const read = stateModule.normalizeState(sampleState({ schemaVersion: 2, options: { tray: { showFooter: false } } }))
  const section = menuModel.buildStatusSection(read.state, { version: '0.2.0', locale: 'zh-CN' })
  assert.equal(section.some((item) => item.kind === 'footer'), false)
  assert.equal(section[section.length - 1].kind, 'workspace')
})

test('menu: all idle sessions are listed newest-first (no 10-row cap)', () => {
  const sessions = []
  for (let index = 0; index < 25; index += 1) {
    sessions.push({ id: `idle-${index}`, title: `idle ${index}`, status: 'idle', updatedAt: 1000 + index })
  }
  sessions.push({ id: 'run', title: 'run', status: 'running' })
  const read = stateModule.normalizeState(
    sampleState({
      schemaVersion: 2,
      options: { tray: { showIdle: true } },
      workspaces: [{ id: 'w', title: 'W', sessions }]
    })
  )
  const section = menuModel.buildStatusSection(read.state, { version: '0.2.3', locale: 'zh-CN' })
  const workspace = section.find((item) => item.kind === 'workspace')
  assert.equal(workspace.label, '📁 W  运行 1 · 待处理 0')
  assert.equal(workspace.submenu.filter((item) => item.kind === 'session').length, 1, 'idle rows must not be inline')
  const idleGroup = workspace.submenu.find((item) => item.kind === 'idle-group')
  assert.equal(idleGroup.label, '空闲会话 (25)', 'group label keeps the full count')
  const idleRows = idleGroup.submenu.filter((item) => item.kind === 'session')
  assert.equal(idleRows.length, 25, 'all idle sessions must be listed (old cap was 10)')
  assert.equal(idleGroup.submenu.some((item) => item.kind === 'placeholder'), false, 'no overflow below the hard cap')
  assert.equal(idleRows[0].label, '○ idle 24', 'newest updatedAt first')
  assert.equal(idleRows[idleRows.length - 1].label, '○ idle 0', 'oldest last')
  assert.equal(idleRows[0].sessionId, 'idle-24')
  assert.equal(idleRows[0].workspaceId, 'w')
})

test('menu: idle submenu truncates only past the hard cap (100)', () => {
  const sessions = []
  for (let index = 0; index < 105; index += 1) {
    sessions.push({ id: `idle-${index}`, title: `idle ${index}`, status: 'idle', updatedAt: 1000 + index })
  }
  // Raw state object (bypasses normalization) to prove the menu-model hard cap.
  const rawState = {
    schemaVersion: 2,
    options: { tray: { showIdle: true } },
    stats: { running: 0, pending: 0 },
    workspaces: [{ id: 'w', title: 'W', sessions }]
  }
  const section = menuModel.buildStatusSection(rawState, { version: '0.2.3', locale: 'zh-CN' })
  const workspace = section.find((item) => item.kind === 'workspace')
  const idleGroup = workspace.submenu.find((item) => item.kind === 'idle-group')
  assert.equal(idleGroup.label, '空闲会话 (105)')
  const idleRows = idleGroup.submenu.filter((item) => item.kind === 'session')
  assert.equal(idleRows.length, constants.LIMITS.maxSessionsPerWorkspace)
  assert.equal(idleGroup.submenu[idleGroup.submenu.length - 1].label, '… 还有 5 个会话')
})

test('menu: English strings for non-zh locales', () => {
  const read = stateModule.normalizeState(
    sampleState({ workspaces: [{ id: 'w', title: 'WS', sessions: [{ id: 's', title: 'run', status: 'running' }] }] })
  )
  const section = menuModel.buildStatusSection(read.state, { version: '0.1.0', locale: 'en-US' })
  assert.equal(section[0].label, 'Conversations: 1 running / 0 pending')
  const workspace = section.find((item) => item.kind === 'workspace')
  assert.equal(workspace.label, '📁 WS  running 1 · pending 0')
  const empty = menuModel.buildStatusSection(stateModule.normalizeState(sampleState({ workspaces: [] })).state, { version: '1', locale: 'en-US' })
  assert.ok(empty.some((item) => item.label === '(no workspaces)'))
})

test('menu: workspace without sessions and unavailable state placeholders', () => {
  const empty = menuModel.buildStatusSection(
    stateModule.normalizeState(sampleState({ workspaces: [{ id: 'w', title: 'empty', sessions: [] }] })).state,
    { version: '0.1.0', locale: 'zh-CN' }
  )
  const workspace = empty.find((item) => item.kind === 'workspace')
  assert.equal(workspace.submenu.length, 1)
  assert.equal(workspace.submenu[0].kind, 'placeholder')
  assert.equal(workspace.submenu[0].label, '（无对话）')

  const unavailable = menuModel.buildStatusSection(null, { version: '0.1.0', locale: 'zh-CN' })
  assert.equal(unavailable[0].label, '对话：0 运行 / 0 待处理')
  assert.ok(unavailable.some((item) => item.kind === 'placeholder' && item.label === '（等待插件数据…）'))
})

test('menu: no workspaces placeholder, footer item, ascii fallback', () => {
  const read = stateModule.normalizeState(sampleState({ workspaces: [] }))
  const section = menuModel.buildStatusSection(read.state, { version: '0.1.0', locale: 'zh-CN' })
  assert.ok(section.some((item) => item.label === '（暂无工作区）'))
  assert.equal(section[section.length - 1].label, 'dsh-tray-follower v0.1.0')
  assert.equal(section[section.length - 1].enabled, false)

  const ascii = menuModel.buildStatusSection(read.state, { version: '0.1.0', asciiFallback: true, locale: 'zh-CN' })
  assert.equal(ascii[0].kind, 'header')
})

test('menu: signature ignores timestamps but changes with status', () => {
  const base = stateModule.normalizeState(sampleState()).state
  const same = stateModule.normalizeState(sampleState({ updatedAt: 1730000009999 })).state
  const changed = stateModule.normalizeState(
    sampleState({ workspaces: [{ id: 'w', title: 'w', sessions: [{ id: 's', title: 't', status: 'failed' }] }] })
  ).state
  const signatureBase = menuModel.menuSignature(menuModel.buildStatusSection(base, { version: '1' }))
  const signatureSame = menuModel.menuSignature(menuModel.buildStatusSection(same, { version: '1' }))
  const signatureChanged = menuModel.menuSignature(menuModel.buildStatusSection(changed, { version: '1' }))
  assert.equal(signatureBase, signatureSame)
  assert.notEqual(signatureBase, signatureChanged)
})

test('menu: toElectronTemplate maps descriptors and click focuses', () => {
  let focused = 0
  const section = [
    { kind: 'header', label: 'h', enabled: false },
    { kind: 'workspace', label: 'w', enabled: true, submenu: [{ kind: 'session', label: 's', enabled: true }] },
    { kind: 'footer', label: 'f', enabled: false }
  ]
  const template = menuModel.toElectronTemplate(section, { focus: () => (focused += 1) })
  assert.equal(template[0].enabled, false)
  assert.equal(template[1].submenu[0].label, 's')
  template[1].submenu[0].click()
  assert.equal(focused, 1)
  assert.equal(template[2].enabled, false)
})

test('menu: session nodes carry sessionId/workspaceId (active and idle)', () => {
  const read = stateModule.normalizeState(
    sampleState({
      schemaVersion: 2,
      options: { tray: { showIdle: true } },
      workspaces: [
        {
          id: 'ws-1',
          title: 'W',
          sessions: [
            { id: 'session-active-1', title: 'active', status: 'running' },
            { id: 'session-idle-1', title: 'idle', status: 'idle', updatedAt: 5 }
          ]
        }
      ]
    })
  )
  const section = menuModel.buildStatusSection(read.state, { version: '0.2.3', locale: 'zh-CN' })
  const workspace = section.find((item) => item.kind === 'workspace')
  const active = workspace.submenu.find((item) => item.kind === 'session')
  assert.equal(active.sessionId, 'session-active-1')
  assert.equal(active.workspaceId, 'ws-1')
  const idleGroup = workspace.submenu.find((item) => item.kind === 'idle-group')
  const idle = idleGroup.submenu.find((item) => item.kind === 'session')
  assert.equal(idle.sessionId, 'session-idle-1')
  assert.equal(idle.workspaceId, 'ws-1')
})

test('menu: session click calls openSession with the session id (focus fallback)', () => {
  const read = stateModule.normalizeState(sampleState())
  const section = menuModel.buildStatusSection(read.state, { version: '0.2.3', locale: 'zh-CN' })
  const opened = []
  let focused = 0
  const template = menuModel.toElectronTemplate(section, {
    focus: () => (focused += 1),
    openSession: (sessionId) => opened.push(sessionId)
  })
  const workspace = template.find((item) => Array.isArray(item.submenu))
  const sessionItem = workspace.submenu.find((item) => typeof item.click === 'function')
  assert.ok(sessionItem, 'session rows must be clickable')
  sessionItem.click()
  assert.equal(opened.length, 1)
  assert.match(opened[0], /^s_/)
  assert.equal(focused, 0, 'openSession takes precedence over plain focus')

  // No openSession provided -> legacy focus fallback.
  const fallbackTemplate = menuModel.toElectronTemplate(section, { focus: () => (focused += 1) })
  fallbackTemplate
    .find((item) => Array.isArray(item.submenu))
    .submenu.find((item) => typeof item.click === 'function')
    .click()
  assert.equal(focused, 1)
})

// --- notification policy -----------------------------------------------------

const event = (id, extra = {}) => ({ id, kind: 'completed', title: `title-${id}`, body: `body-${id}`, ...extra })

test('notify: unseen events while hidden produce one notification each batch', () => {
  const plan = notifyPolicy.planNotifications([event('e1')], { now: 10000, focused: false, visible: false, seenIds: [], lastNotifyAt: 0 })
  assert.equal(plan.notifications.length, 1)
  assert.equal(plan.notifications[0].kind, 'single')
  assert.equal(plan.notifications[0].title, 'title-e1')
  assert.deepEqual(plan.seenIdsToAdd, ['e1'])
  assert.equal(plan.lastNotifyAt, 10000)
})

test('notify: burst is coalesced into one summary', () => {
  const plan = notifyPolicy.planNotifications([event('e1'), event('e2'), event('e3')], {
    now: 10000,
    focused: false,
    seenIds: [],
    lastNotifyAt: 0
  })
  assert.equal(plan.notifications.length, 1)
  assert.equal(plan.notifications[0].kind, 'summary')
  assert.equal(plan.notifications[0].title, '3 个对话需要关注')
  assert.equal(plan.notifications[0].eventIds.length, 3)
  assert.match(plan.notifications[0].body, /• body-e1/)
})

test('notify: already-seen ids never re-notify', () => {
  const plan = notifyPolicy.planNotifications([event('e1')], { now: 20000, focused: false, seenIds: ['e1'], lastNotifyAt: 0 })
  assert.equal(plan.notifications.length, 0)
  assert.equal(plan.candidates, 0)
})

test('notify: focused window marks events seen without notifying', () => {
  const plan = notifyPolicy.planNotifications([event('e1'), event('e2')], {
    now: 20000,
    focused: true,
    visible: true,
    seenIds: [],
    lastNotifyAt: 0
  })
  assert.equal(plan.suppressed, true)
  assert.equal(plan.notifications.length, 0)
  assert.deepEqual(plan.seenIdsToAdd, ['e1', 'e2'])
})

test('notify: first run baseline is silent', () => {
  const plan = notifyPolicy.planNotifications([event('e1')], { now: 20000, focused: false, seenIds: [], baseline: true })
  assert.equal(plan.baselineApplied, true)
  assert.equal(plan.notifications.length, 0)
  assert.deepEqual(plan.seenIdsToAdd, ['e1'])
})

test('notify: rate limit defers events without marking them seen', () => {
  const plan = notifyPolicy.planNotifications([event('e1')], {
    now: 1000,
    focused: false,
    seenIds: [],
    lastNotifyAt: 999
  })
  assert.equal(plan.notifications.length, 0)
  assert.deepEqual(plan.deferredIds, ['e1'])
  assert.deepEqual(plan.seenIdsToAdd, [])
})

test('notify: capSeenIds dedupes and keeps the newest ids', () => {
  const capped = notifyPolicy.capSeenIds(['a', 'b', 'a', '', null, 'c', 'd'], 3)
  assert.deepEqual(capped, ['b', 'c', 'd'])
})

test('notify: stale events (older than 10 min) are marked seen but never notified', () => {
  const now = 1730000000000
  const plan = notifyPolicy.planNotifications(
    [
      event('old', { createdAt: now - 11 * 60 * 1000 }),
      event('fresh', { createdAt: now - 1000 })
    ],
    { now, focused: false, seenIds: [], lastNotifyAt: 0 }
  )
  assert.deepEqual(plan.expiredIds, ['old'])
  assert.ok(plan.seenIdsToAdd.includes('old'))
  assert.equal(plan.candidates, 1)
  assert.equal(plan.notifications.length, 1)
  assert.equal(plan.notifications[0].title, 'title-fresh')
})

test('notify: contract v2 kind filters consume disabled kinds silently', () => {
  const events = [
    event('c1', { kind: 'completed' }),
    event('f1', { kind: 'failed' }),
    event('a1', { kind: 'needs-attention' })
  ]
  const plan = notifyPolicy.planNotifications(events, {
    now: 10000,
    focused: false,
    seenIds: [],
    lastNotifyAt: 0,
    options: { notifyOnCompleted: false, notifyOnFailed: true, notifyOnAttention: false }
  })
  assert.deepEqual(plan.filteredIds, ['c1', 'a1'])
  assert.ok(plan.seenIdsToAdd.includes('c1'))
  assert.ok(plan.seenIdsToAdd.includes('a1'))
  assert.equal(plan.notifications.length, 1)
  assert.deepEqual(plan.notifications[0].eventIds, ['f1'])
})

test('notify: suppressWhenFocused=false notifies even while focused', () => {
  const plan = notifyPolicy.planNotifications([event('e1')], {
    now: 10000,
    focused: true,
    visible: true,
    seenIds: [],
    lastNotifyAt: 0,
    options: { suppressWhenFocused: false }
  })
  assert.equal(plan.suppressed, false)
  assert.equal(plan.notifications.length, 1)

  const defaultSettings = notifyPolicy.planNotifications([event('e1')], {
    now: 10000,
    focused: true,
    seenIds: [],
    lastNotifyAt: 0
  })
  assert.equal(defaultSettings.suppressed, true)
})

test('notify: notificationSound maps to silent flag', () => {
  const withSound = notifyPolicy.planNotifications([event('e1')], { now: 10000, focused: false, seenIds: [], lastNotifyAt: 0 })
  assert.equal(withSound.silent, false)
  assert.equal(withSound.notifications[0].silent, false)

  const silentPlan = notifyPolicy.planNotifications([event('e1')], {
    now: 10000,
    focused: false,
    seenIds: [],
    lastNotifyAt: 0,
    options: { notificationSound: false }
  })
  assert.equal(silentPlan.silent, true)
  assert.equal(silentPlan.notifications[0].silent, true)
})

// --- cursor ------------------------------------------------------------------

test('cursor: save/load round trip and corrupt file fallback', async () => {
  await withTempDir((dir) => {
    const saved = cursorModule.saveCursor(dir, {
      schemaVersion: 1,
      seenEventIds: ['e1', 'e2'],
      lastNotifyAt: 1234
    })
    assert.equal(saved.ok, true)
    const loaded = cursorModule.loadCursor(dir)
    assert.equal(loaded.loaded, true)
    assert.deepEqual(loaded.cursor.seenEventIds, ['e1', 'e2'])
    assert.equal(loaded.cursor.lastNotifyAt, 1234)

    fs.writeFileSync(path.join(dir, 'cursor.json'), '{broken', 'utf8')
    const corrupt = cursorModule.loadCursor(dir)
    assert.equal(corrupt.loaded, false)
    assert.deepEqual(corrupt.cursor.seenEventIds, [])
  })
})

test('cursor: withSeen dedupes and caps', () => {
  const cursor = cursorModule.withSeen({ seenEventIds: ['a'], lastNotifyAt: 5 }, ['b', 'a', 'c'], 100, 2)
  assert.deepEqual(cursor.seenEventIds, ['b', 'c'])
  assert.equal(cursor.lastNotifyAt, 5)
})

// --- heartbeat ---------------------------------------------------------------

test('heartbeat: writes exactly the plugin contract fields', async () => {
  await withTempDir((dir) => {
    const result = heartbeatModule.writeHeartbeat({ dataDir: dir, version: '0.1.0', pid: 123, now: 999 })
    assert.equal(result.ok, true)
    const decoded = JSON.parse(fs.readFileSync(result.path, 'utf8'))
    assert.deepEqual(Object.keys(decoded).sort(), ['pid', 'ts', 'version'])
    assert.equal(decoded.pid, 123)
    assert.equal(decoded.ts, 999)
    assert.equal(decoded.version, '0.1.0')
  })
})

// --- logger ------------------------------------------------------------------

test('logger: rotates at maxBytes and writes JSON diagnostics in test mode', async () => {
  await withTempDir((dir) => {
    const logger = logModule.createLogger({ file: path.join(dir, 'bridge.log'), maxBytes: 200, testMode: true })
    logger.init()
    for (let index = 0; index < 40; index += 1) logger.log(`line ${index} ${'x'.repeat(30)}`)
    logger.diag('unit-test-event', { value: 42 })
    assert.ok(fs.existsSync(path.join(dir, 'bridge.log.1')), 'rotated file expected')
    const content = fs.readFileSync(path.join(dir, 'bridge.log'), 'utf8')
    assert.match(content, /"type":"diag"/)
    assert.match(content, /"event":"unit-test-event"/)
  })
})

// --- tray patch --------------------------------------------------------------

function createPatchFakes() {
  class FakeTray {
    constructor() {
      this.menu = null
      this.menuSets = []
    }

    setContextMenu(menu) {
      this.menu = menu
      this.menuSets.push(menu)
    }

    isDestroyed() {
      return false
    }

    getToolTip() {
      return 'tooltip'
    }
  }
  class FakeMenu {
    constructor(items) {
      this.items = items
    }
  }
  FakeMenu.buildFromTemplate = (template) => new FakeMenu(template)
  return { FakeTray, FakeMenu }
}

test('tray-patch: captures tray, menu items and preserves original click behavior', () => {
  const { FakeTray, FakeMenu } = createPatchFakes()
  const original = FakeTray.prototype.setContextMenu
  let openClicks = 0
  let captured = null
  const patcher = trayPatch.createTrayPatcher({ Tray: FakeTray, log: () => {} })
  patcher.onCapture((record) => (captured = record))
  const install = patcher.install()
  assert.equal(install.ok, true)
  assert.equal(patcher.isInstalled(), true)

  const tray = new FakeTray()
  const openItem = { label: 'Open', click: () => (openClicks += 1) }
  tray.setContextMenu(new FakeMenu([openItem, { type: 'separator' }, { label: 'Quit', click: () => {} }]))
  assert.ok(captured)
  assert.equal(captured.tray, tray)
  assert.equal(captured.template.length, 3)
  assert.equal(captured.template[0].label, 'Open')
  assert.equal(captured.template[1].type, 'separator')
  captured.template[0].click({}, null, null)
  assert.equal(openClicks, 1)

  patcher.restore()
  assert.equal(FakeTray.prototype.setContextMenu, original)
})

test('tray-patch: applyMenu bypasses capture (no recursion)', () => {
  const { FakeTray, FakeMenu } = createPatchFakes()
  let captureCount = 0
  const patcher = trayPatch.createTrayPatcher({ Tray: FakeTray, log: () => {} })
  patcher.onCapture(() => (captureCount += 1))
  patcher.install()
  const tray = new FakeTray()
  tray.setContextMenu(new FakeMenu([{ label: 'A' }]))
  assert.equal(captureCount, 1)
  const applied = patcher.applyMenu(tray, new FakeMenu([{ label: 'B' }]))
  assert.equal(applied.ok, true)
  assert.equal(captureCount, 1)
  assert.equal(tray.menu.items[0].label, 'B')
  patcher.restore()
})

test('tray-patch: install is idempotent and restores the first original', () => {
  const { FakeTray } = createPatchFakes()
  const original = FakeTray.prototype.setContextMenu
  const first = trayPatch.createTrayPatcher({ Tray: FakeTray, log: () => {} })
  first.install()
  const second = trayPatch.createTrayPatcher({ Tray: FakeTray, log: () => {} })
  second.install()
  second.restore()
  // The first patch's original must survive the second patcher's restore chain.
  assert.equal(typeof FakeTray.prototype.setContextMenu, 'function')
  first.restore()
  assert.equal(FakeTray.prototype.setContextMenu, original)
})

test('tray-patch: isUsableTray rejects destroyed / non-trays', () => {
  assert.equal(trayPatch.isUsableTray(null), false)
  assert.equal(trayPatch.isUsableTray({}), false)
  assert.equal(trayPatch.isUsableTray({ setContextMenu() {}, isDestroyed: () => true }), false)
  assert.equal(trayPatch.isUsableTray({ setContextMenu() {}, isDestroyed: () => false }), true)
})

// --- windows -----------------------------------------------------------------

test('windows: URL scoring prefers dsh-app over localhost over file', () => {
  assert.ok(windowsModule.scoreWindowUrl('dsh-app://app/') > windowsModule.scoreWindowUrl('http://127.0.0.1:61983/'))
  assert.ok(windowsModule.scoreWindowUrl('http://127.0.0.1:61983/') > windowsModule.scoreWindowUrl('file:///x'))
  assert.ok(windowsModule.scoreWindowUrl('file:///x') > windowsModule.scoreWindowUrl(''))
})

test('windows: pickPrimaryWindow prefers focused/visible dsh-app window', () => {
  const dialog = createFakeWindow({ url: 'file:///dialog.html', visible: true, focused: true })
  const main = createFakeWindow({ url: 'dsh-app://app/', visible: true, focused: false })
  const picked = windowsModule.pickPrimaryWindow([dialog, main], { webOrigin: 'http://127.0.0.1:1' })
  assert.equal(picked.window, main)
})

test('windows: focus helper restores, shows and focuses', () => {
  const main = createFakeWindow({ url: 'dsh-app://app/', visible: false, minimized: true })
  const helper = windowsModule.createWindowHelper({ BrowserWindow: { getAllWindows: () => [main] }, app: {}, log: () => {} })
  const result = helper.focus()
  assert.equal(result.ok, true)
  assert.equal(main.record.restored, 1)
  assert.equal(main.record.shown, 1)
  assert.equal(main.record.focused, 1)
  const state = helper.state()
  assert.equal(state.found, true)
})

test('windows: openSession focuses and dispatches dsh-tray-follower:open-session with the JSON id', () => {
  const main = createFakeWindow({ url: 'dsh-app://app/', visible: true, focused: false })
  const logs = []
  const helper = windowsModule.createWindowHelper({
    BrowserWindow: { getAllWindows: () => [main] },
    app: {},
    log: (message, data) => logs.push({ message, data })
  })
  const result = helper.openSession('session-1234-abcd')
  assert.equal(result.ok, true)
  assert.equal(main.record.focused, 1, 'window is focused before dispatching')
  assert.equal(main.record.scripts.length, 1)
  const script = main.record.scripts[0]
  assert.ok(script.startsWith('window.dispatchEvent(new CustomEvent('))
  assert.ok(script.includes('dsh-tray-follower:open-session'), 'exact event name')
  assert.ok(script.includes('"session-1234-abcd"'), 'JSON-quoted session id')
  assert.ok(logs.some((entry) => entry.message === 'window-session-open' && entry.data.ok === true))

  // Invalid ids are rejected and never executed in the renderer.
  for (const invalid of ['', 'bad id!', null, 'x'.repeat(129)]) {
    const rejected = helper.openSession(invalid)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.reason, 'invalid-session-id')
  }
  assert.equal(main.record.scripts.length, 1)
})

test('windows: openSession cannot throw without a window or executeJavaScript', () => {
  const noWindowHelper = windowsModule.createWindowHelper({ BrowserWindow: { getAllWindows: () => [] }, app: {}, log: () => {} })
  assert.deepEqual(noWindowHelper.openSession('session-1'), { ok: false, reason: 'no-window' })

  const window = { webContents: { getURL: () => 'dsh-app://app/' }, isDestroyed: () => false, isVisible: () => true, isFocused: () => false, isMinimized: () => false, focus() {} }
  const helper = windowsModule.createWindowHelper({ BrowserWindow: { getAllWindows: () => [window] }, app: {}, log: () => {} })
  assert.equal(helper.openSession('session-1').ok, false)
})

// --- bridge core smoke -------------------------------------------------------

test('bridge: patch + adoption + menu rebuild from captured shell items', async () => {
  await withTempDir(async (dir) => {
    writeStateFile(dir, sampleState())
    const window = createFakeWindow({ url: 'dsh-app://app/', visible: false, focused: false })
    const { electron, fake } = createFakeElectron({ windows: [window], userDataDir: dir })
    const originalSetContextMenu = electron.Tray.prototype.setContextMenu
    const bridge = bridgeModule.createBridge({
      api: electron,
      env: { KEEP: '1' },
      dataDir: dir,
      hookDir: shellHookRoot,
      timers: false,
      testMode: false
    })
    bridge.start()
    const diagnostics = bridge.diagnostics()
    assert.equal(diagnostics.patched, true)
    assert.equal(diagnostics.started, true)

    const tray = new electron.Tray()
    let openClicks = 0
    const shellMenu = () =>
      new electron.Menu([
        { label: '打开 DeepSeek Harness', click: () => (openClicks += 1) },
        { type: 'separator' },
        { label: '退出 DeepSeek Harness', click: () => {} }
      ])
    tray.setContextMenu(shellMenu())
    assert.equal(bridge.diagnostics().trayAdopted, true)
    assert.equal(bridge.diagnostics().capturedOriginal, 'captured')
    let lastMenu = tray.menuSets[tray.menuSets.length - 1]
    let labels = flattenLabels(lastMenu.items)
    assert.ok(labels.includes('打开 DeepSeek Harness'), `missing original open item: ${labels.join(' | ')}`)
    assert.ok(labels.includes('退出 DeepSeek Harness'))
    assert.equal(labels.filter((label) => label.startsWith('对话：')).length, 1, `header duplicated: ${labels.join(' | ')}`)
    assert.ok(labels.includes('对话：1 运行 / 2 待处理'), `missing header: ${labels.join(' | ')}`)
    assert.ok(labels.includes('📁 dsh_tray_follower  运行 1 · 待处理 1'), `missing workspace row: ${labels.join(' | ')}`)
    assert.ok(labels.includes('▶ 配置 Git 等工程管理'))
    assert.ok(labels.includes('⏸ 等待批准'))
    assert.ok(labels.includes('dsh-tray-follower v0.2.3'))
    assert.equal(bridge.diagnostics().capturedItemCount, 3, 'captured template must be the shell menu, not the merged menu')

    // The captured original click handler still works after the rebuild.
    const rebuiltOpen = lastMenu.items.find((item) => item.label === '打开 DeepSeek Harness')
    rebuiltOpen.click()
    assert.equal(openClicks, 1)

    // A session row click deep-links: the renderer gets the open-session event with
    // the conversation id, instead of only focusing the window.
    const workspaceItem = lastMenu.items.find(
      (item) => Array.isArray(item.submenu) && item.submenu.some((child) => typeof child.click === 'function')
    )
    assert.ok(workspaceItem, 'workspace submenu with session rows expected')
    const sessionItem = workspaceItem.submenu.find(
      (child) => typeof child.click === 'function' && child.label.startsWith('▶')
    )
    assert.ok(sessionItem, 'running session row expected')
    sessionItem.click()
    assert.equal(window.record.scripts.length, 1)
    assert.ok(window.record.scripts[0].includes('dsh-tray-follower:open-session'))
    assert.ok(window.record.scripts[0].includes('"s_1"'), 'JSON-quoted session id must be dispatched')

    // Simulated shell relabel(): the patched method captures the shell menu again
    // and the bridge rebuilds without duplicating its own status section.
    tray.setContextMenu(shellMenu())
    lastMenu = tray.menuSets[tray.menuSets.length - 1]
    labels = flattenLabels(lastMenu.items)
    assert.equal(labels.filter((label) => label.startsWith('对话：')).length, 1, `header duplicated after relabel: ${labels.join(' | ')}`)
    assert.equal(labels.filter((label) => label.includes('dsh_tray_follower')).length, 1, 'workspace duplicated after relabel')
    assert.equal(labels.filter((label) => label === '打开 DeepSeek Harness').length, 1, 'original item duplicated after relabel')
    assert.equal(bridge.diagnostics().capturedItemCount, 3, 'relabel capture must stay the shell menu')

    // Heartbeat exists with the plugin contract fields.
    const heartbeat = JSON.parse(fs.readFileSync(path.join(dir, 'bridge.json'), 'utf8'))
    assert.deepEqual(Object.keys(heartbeat).sort(), ['pid', 'ts', 'version'])

    bridge.stop()
    assert.equal(fake.quitCalls, 0)
    assert.equal(electron.Tray.prototype.setContextMenu, originalSetContextMenu)
  })
})

test('bridge: adoption before any capture reconstructs localized Open/Quit and keeps the section', async () => {
  await withTempDir(async (dir) => {
    writeStateFile(dir, sampleState())
    const window = createFakeWindow({ url: 'dsh-app://app/', visible: false, focused: false })
    const { electron, fake } = createFakeElectron({ windows: [window], userDataDir: dir, locale: 'zh-CN' })
    const bridge = bridgeModule.createBridge({
      api: electron,
      env: {},
      dataDir: dir,
      hookDir: shellHookRoot,
      timers: false,
      testMode: false
    })
    bridge.start()
    const tray = new electron.Tray()
    bridge.adopt(tray)
    assert.equal(bridge.diagnostics().capturedOriginal, 'reconstructed')
    let lastMenu = tray.menuSets[tray.menuSets.length - 1]
    let labels = flattenLabels(lastMenu.items)
    assert.ok(labels.includes('打开 DeepSeek Harness'), `reconstructed zh open label missing: ${labels.join(' | ')}`)
    assert.ok(labels.includes('退出 DeepSeek Harness'), `reconstructed zh quit label missing: ${labels.join(' | ')}`)
    assert.equal(labels.filter((label) => label.startsWith('对话：')).length, 1)

    // The reconstructed quit item must call app.quit().
    const quitItem = lastMenu.items.find((item) => item.label === '退出 DeepSeek Harness')
    quitItem.click()
    assert.equal(fake.quitCalls, 1)

    // A later shell relabel() upgrades the originals to the captured shell menu
    // and must not duplicate the status section.
    tray.setContextMenu(
      new electron.Menu([
        { label: '打开应用', click: () => {} },
        { type: 'separator' },
        { label: '退出应用', click: () => {} }
      ])
    )
    lastMenu = tray.menuSets[tray.menuSets.length - 1]
    labels = flattenLabels(lastMenu.items)
    assert.equal(bridge.diagnostics().capturedOriginal, 'captured')
    assert.ok(labels.includes('打开应用'))
    assert.equal(labels.filter((label) => label.startsWith('对话：')).length, 1)
    assert.equal(labels.filter((label) => label.includes('dsh_tray_follower')).length, 1)
    bridge.stop()
  })
})

test('bridge: reconstructed items use English labels for non-zh locale', async () => {
  await withTempDir(async (dir) => {
    writeStateFile(dir, sampleState())
    const window = createFakeWindow({ url: 'dsh-app://app/', visible: false, focused: false })
    const { electron } = createFakeElectron({ windows: [window], userDataDir: dir, locale: 'en-US' })
    const bridge = bridgeModule.createBridge({
      api: electron,
      env: {},
      dataDir: dir,
      hookDir: shellHookRoot,
      timers: false,
      testMode: false
    })
    bridge.start()
    const tray = new electron.Tray()
    bridge.adopt(tray)
    const labels = flattenLabels(tray.menuSets[tray.menuSets.length - 1].items)
    assert.ok(labels.includes('Open DeepSeek Harness'), `English open label missing: ${labels.join(' | ')}`)
    assert.ok(labels.includes('Quit DeepSeek Harness'), `English quit label missing: ${labels.join(' | ')}`)
    assert.ok(labels.includes('Conversations: 1 running / 2 pending'))
    bridge.stop()
  })
})

test('bridge: notifications baseline, then unseen event while hidden notifies once', async () => {
  await withTempDir(async (dir) => {
    const window = createFakeWindow({ url: 'dsh-app://app/', visible: false, focused: false })
    const { electron, fake } = createFakeElectron({ windows: [window], userDataDir: dir })
    const bridge = bridgeModule.createBridge({
      api: electron,
      env: {},
      dataDir: dir,
      hookDir: shellHookRoot,
      timers: false,
      testMode: false
    })
    bridge.start()
    const tray = new electron.Tray()
    tray.setContextMenu(new electron.Menu([{ label: 'Open', click: () => {} }]))

    // First poll with one pre-existing event: silent baseline.
    writeStateFile(dir, sampleState({ unreadEvents: [event('e-old')] }))
    bridge.pollNow('test')
    assert.equal(fake.shownNotifications.length, 0, 'baseline must not notify')

    // New event while the window is hidden -> notification.
    writeStateFile(dir, sampleState({ unreadEvents: [event('e-old'), event('e-new', { title: '任务完成', body: 'ws • session' })] }))
    bridge.pollNow('test')
    assert.equal(fake.shownNotifications.length, 1)
    assert.equal(fake.shownNotifications[0].title, '任务完成')
    assert.equal(fake.shownNotifications[0].body, 'ws • session')

    // Same event again -> deduped.
    bridge.pollNow('test')
    assert.equal(fake.shownNotifications.length, 1)

    const cursor = JSON.parse(fs.readFileSync(path.join(dir, 'cursor.json'), 'utf8'))
    assert.deepEqual(cursor.seenEventIds, ['e-old', 'e-new'])
    bridge.stop()
  })
})

test('bridge: focused window suppresses notifications', async () => {
  await withTempDir(async (dir) => {
    const window = createFakeWindow({ url: 'dsh-app://app/', visible: true, focused: true })
    const { electron, fake } = createFakeElectron({ windows: [window], userDataDir: dir })
    const bridge = bridgeModule.createBridge({
      api: electron,
      env: {},
      dataDir: dir,
      hookDir: shellHookRoot,
      timers: false,
      testMode: false
    })
    bridge.start()
    bridge.pollNow('test') // baseline
    writeStateFile(dir, sampleState({ unreadEvents: [event('e1')] }))
    bridge.pollNow('test')
    assert.equal(fake.shownNotifications.length, 0)
    bridge.stop()
  })
})

test('bridge: v2 notification settings drive kind filters and silent flags', async () => {
  await withTempDir(async (dir) => {
    const window = createFakeWindow({ url: 'dsh-app://app/', visible: false, focused: false })
    const { electron, fake } = createFakeElectron({ windows: [window], userDataDir: dir })
    const bridge = bridgeModule.createBridge({
      api: electron,
      env: {},
      dataDir: dir,
      hookDir: shellHookRoot,
      timers: false,
      testMode: false
    })
    bridge.start()
    const tray = new electron.Tray()
    tray.setContextMenu(new electron.Menu([{ label: 'Open', click: () => {} }]))
    // First poll with one pre-existing event consumes the silent first-run baseline.
    writeStateFile(dir, sampleState({ unreadEvents: [event('priming')] }))
    bridge.pollNow('test')
    assert.equal(fake.shownNotifications.length, 0)

    writeStateFile(
      dir,
      sampleState({
        schemaVersion: 2,
        options: { notifications: { notifyOnCompleted: false, notificationSound: false } },
        unreadEvents: [
          event('priming'),
          event('done', { kind: 'completed', title: '任务完成', body: 'ws • done' }),
          event('fail', { kind: 'failed', title: '任务失败', body: 'ws • failed' })
        ]
      })
    )
    bridge.pollNow('test')
    assert.equal(fake.shownNotifications.length, 1, 'completed kind is disabled, failed kind notifies')
    assert.equal(fake.shownNotifications[0].title, '任务失败')
    assert.equal(fake.shownNotifications[0].silent, true, 'notificationSound=false must set silent:true')
    const cursor = JSON.parse(fs.readFileSync(path.join(dir, 'cursor.json'), 'utf8'))
    assert.deepEqual([...cursor.seenEventIds].sort(), ['done', 'fail', 'priming'])
    const logContent = fs.readFileSync(path.join(dir, 'bridge.log'), 'utf8')
    assert.match(logContent, /notification-filtered/)
    bridge.stop()
  })
})

test('bridge: v2 suppressWhenFocused=false notifies while focused', async () => {
  await withTempDir(async (dir) => {
    const window = createFakeWindow({ url: 'dsh-app://app/', visible: true, focused: true })
    const { electron, fake } = createFakeElectron({ windows: [window], userDataDir: dir })
    const bridge = bridgeModule.createBridge({
      api: electron,
      env: {},
      dataDir: dir,
      hookDir: shellHookRoot,
      timers: false,
      testMode: false
    })
    bridge.start()
    writeStateFile(dir, sampleState({ unreadEvents: [event('priming')] }))
    bridge.pollNow('test') // consume the silent first-run baseline
    assert.equal(fake.shownNotifications.length, 0)
    writeStateFile(
      dir,
      sampleState({
        schemaVersion: 2,
        options: { notifications: { suppressWhenFocused: false } },
        unreadEvents: [event('priming'), event('e-focused', { kind: 'failed', title: '任务失败', body: 'ws • focused' })]
      })
    )
    bridge.pollNow('test')
    assert.equal(fake.shownNotifications.length, 1)
    assert.equal(fake.shownNotifications[0].title, '任务失败')
    bridge.stop()
  })
})

test('bridge: v2 options.tray.showIdle toggles idle rows in the rebuilt menu', async () => {
  await withTempDir(async (dir) => {
    const window = createFakeWindow({ url: 'dsh-app://app/', visible: false, focused: false })
    const { electron } = createFakeElectron({ windows: [window], userDataDir: dir })
    const idleSession = { id: 'idle-1', title: '空闲历史对话', status: 'idle' }
    writeStateFile(
      dir,
      sampleState({
        schemaVersion: 2,
        options: { tray: { showIdle: true } },
        workspaces: [{ id: 'w', title: 'W', sessions: [idleSession] }]
      })
    )
    const bridge = bridgeModule.createBridge({
      api: electron,
      env: {},
      dataDir: dir,
      hookDir: shellHookRoot,
      timers: false,
      testMode: false
    })
    bridge.start()
    const tray = new electron.Tray()
    tray.setContextMenu(new electron.Menu([{ label: 'Open', click: () => {} }]))
    let labels = flattenLabels(tray.menuSets[tray.menuSets.length - 1].items)
    assert.ok(labels.includes('空闲会话 (1)'), `showIdle=true must render idle submenu: ${labels.join(' | ')}`)
    assert.ok(labels.includes('○ 空闲历史对话'))

    writeStateFile(
      dir,
      sampleState({
        schemaVersion: 2,
        options: { tray: { showIdle: false } },
        workspaces: [{ id: 'w', title: 'W', sessions: [idleSession] }]
      })
    )
    bridge.pollNow('test')
    labels = flattenLabels(tray.menuSets[tray.menuSets.length - 1].items)
    assert.equal(labels.some((label) => label.startsWith('空闲会话')), false, 'showIdle=false must hide the idle submenu')
    assert.equal(labels.some((label) => label.startsWith('○')), false, 'showIdle=false must hide idle rows')
    assert.ok(labels.includes('（无对话）'), 'workspace with only hidden idle sessions shows the empty placeholder')
    bridge.stop()
  })
})

test('bridge: test mode writes diagnostics and self-test notification; finalize keeps inspector', async () => {
  await withTempDir(async (dir) => {
    writeStateFile(dir, sampleState({ unreadEvents: [event('e1')] }))
    const window = createFakeWindow({ url: 'dsh-app://app/', visible: true, focused: true })
    const { electron, fake } = createFakeElectron({ windows: [window], userDataDir: dir })
    const bridge = bridgeModule.createBridge({
      api: electron,
      env: { DSH_TRAY_FOLLOWER_KEEP_INSPECTOR: '1' },
      dataDir: dir,
      hookDir: shellHookRoot,
      timers: false,
      testMode: true
    })
    bridge.start()
    await new Promise((resolve) => setImmediate(resolve))
    const tray = new electron.Tray()
    tray.setContextMenu(new electron.Menu([{ label: 'Open', click: () => {} }]))
    bridge.pollNow('test')
    assert.ok(fake.shownNotifications.some((item) => item.title === 'DSH 托盘随航（自检）'))
    const testDiagnostics = bridge.diagnostics()
    assert.equal(testDiagnostics.notifications.provider, 'electron-main-process')
    assert.equal(testDiagnostics.notifications.supported, true)
    const logContent = fs.readFileSync(path.join(dir, 'bridge.log'), 'utf8')
    assert.match(logContent, /"type":"diag"/)
    assert.match(logContent, /"event":"hook-loaded"/)
    assert.match(logContent, /"event":"tray-adopted"/)
    assert.match(logContent, /"event":"menu-rebuilt"/)
    const finalize = bridge.finalize()
    assert.equal(finalize.kept, true)
    bridge.stop()
  })
})

test('bridge: unavailable state renders placeholder menu', async () => {
  await withTempDir(async (dir) => {
    const window = createFakeWindow({ url: 'dsh-app://app/', visible: false, focused: false })
    const { electron } = createFakeElectron({ windows: [window], userDataDir: dir })
    const bridge = bridgeModule.createBridge({
      api: electron,
      env: {},
      dataDir: dir,
      hookDir: shellHookRoot,
      timers: false,
      testMode: false
    })
    bridge.start()
    const tray = new electron.Tray()
    tray.setContextMenu(new electron.Menu([{ label: 'Open', click: () => {} }]))
    const labels = flattenLabels(tray.menuSets[tray.menuSets.length - 1].items)
    assert.ok(labels.includes('对话：0 运行 / 0 待处理'))
    assert.ok(labels.includes('（等待插件数据…）'))
    bridge.stop()
  })
})

test('bridge: resolveDataDir honours DSH_TRAY_FOLLOWER_DIR', () => {
  const resolved = bridgeModule.resolveDataDir({ DSH_TRAY_FOLLOWER_DIR: path.join(os.tmpdir(), 'custom-dir') })
  assert.ok(resolved.endsWith('custom-dir'))
  const local = bridgeModule.resolveDataDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })
  assert.ok(local.endsWith(path.join('AppData', 'Local', 'dsh-tray-follower')))
})

// --- extension host ----------------------------------------------------------

test('extensions: loads file/directory extensions, contains errors, deactivates on before-quit', async () => {
  await withTempDir((dir) => {
    const extensionsDir = path.join(dir, 'extensions')
    fs.mkdirSync(extensionsDir, { recursive: true })

    const goodMarker = path.join(dir, 'good-activated.json')
    const goodDeactivated = path.join(dir, 'good-deactivated.txt')
    fs.writeFileSync(
      path.join(extensionsDir, 'good.cjs'),
      [
        "'use strict'",
        "const fs = require('node:fs')",
        'module.exports = {',
        '  activate(context) {',
        `    fs.writeFileSync(${JSON.stringify(goodMarker)}, JSON.stringify({`,
        '      hasApi: !!(context.api && context.api.app),',
        '      hasApp: !!context.app,',
        '      dataDir: context.dataDir,',
        "      extensionLog: typeof context.log === 'function',",
        "      now: typeof context.now() === 'number'",
        '    }))',
        "    context.log('info', 'good-activated', { marker: true })",
        '  },',
        '  deactivate() {',
        `    fs.appendFileSync(${JSON.stringify(goodDeactivated)}, 'deactivated\\n')`,
        '  }',
        '}',
        ''
      ].join('\n'),
      'utf8'
    )

    // Directory extension: manifest.json + declared main entry (the layout
    // `dsh-topbar` installers use).
    const directoryExtension = path.join(extensionsDir, 'directory-ext')
    fs.mkdirSync(directoryExtension, { recursive: true })
    fs.writeFileSync(
      path.join(directoryExtension, 'manifest.json'),
      JSON.stringify({ name: 'directory-ext', version: '0.0.1', main: 'hook.cjs' }),
      'utf8'
    )
    fs.writeFileSync(
      path.join(directoryExtension, 'hook.cjs'),
      ["'use strict'", 'module.exports = {', "  activate(context) { context.log('info', 'directory-activated') }", '}', ''].join(
        '\n'
      ),
      'utf8'
    )

    // Broken extension: throws while its module is required.
    fs.writeFileSync(path.join(extensionsDir, 'broken.cjs'), "'use strict'\nthrow new Error('broken-extension-load')\n", 'utf8')

    const logs = []
    const fakeLogger = {
      log: (message, data) => logs.push({ message, data }),
      error: (message, data) => logs.push({ message, data }),
      diag: () => {}
    }
    const listeners = new Map()
    const fakeApp = {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event).add(handler)
      },
      removeListener(event, handler) {
        const set = listeners.get(event)
        if (set) set.delete(handler)
      },
      emit(event, ...args) {
        for (const handler of [...(listeners.get(event) || [])]) handler(...args)
      }
    }
    const api = { app: fakeApp }
    const host = extensionHostModule.createExtensionHost({ api, app: fakeApp, dataDir: dir, logger: fakeLogger })

    assert.doesNotThrow(() => host.loadAll())
    const diagnostics = host.diagnostics()
    assert.equal(diagnostics.started, true)
    assert.equal(diagnostics.exists, true)
    assert.deepEqual([...diagnostics.loaded].sort(), ['directory-ext', 'good'])
    assert.equal(diagnostics.errorCount, 1, 'the broken extension must be contained as one extension-error')
    assert.equal(diagnostics.errors[0].name, 'broken')
    assert.ok(logs.some((entry) => entry.message === 'extension-loaded'))
    assert.ok(logs.some((entry) => entry.message === 'extension-error' && entry.data.phase === 'load'))

    const marker = JSON.parse(fs.readFileSync(goodMarker, 'utf8'))
    assert.equal(marker.hasApi, true)
    assert.equal(marker.hasApp, true)
    assert.equal(marker.dataDir, dir)
    assert.equal(marker.extensionLog, true)
    assert.equal(marker.now, true)
    assert.ok(logs.some((entry) => entry.message === 'extension:good:good-activated'))
    assert.ok(logs.some((entry) => entry.message === 'extension:directory-ext:directory-activated'))

    // A second loadAll must not activate extensions twice.
    host.loadAll()
    assert.equal(host.diagnostics().loaded.length, 2)

    // before-quit calls deactivate() without throwing and is idempotent.
    assert.doesNotThrow(() => fakeApp.emit('before-quit', {}))
    assert.match(fs.readFileSync(goodDeactivated, 'utf8'), /deactivated/)
    assert.equal(host.diagnostics().stopped, true)
    host.stop('test')
    assert.equal(fs.readFileSync(goodDeactivated, 'utf8').trim().split('\n').length, 1)
    assert.equal(listeners.get('before-quit').size, 0)
  })
})

test('extensions: missing extensions dir is a silent no-op; stop is idempotent', async () => {
  await withTempDir((dir) => {
    const host = extensionHostModule.createExtensionHost({
      api: { app: { on() {}, removeListener() {} } },
      dataDir: dir
    })
    assert.doesNotThrow(() => host.loadAll())
    const diagnostics = host.diagnostics()
    assert.equal(diagnostics.exists, false)
    assert.deepEqual(diagnostics.loaded, [])
    assert.equal(diagnostics.scanned, 0)
    assert.equal(diagnostics.errorCount, 0)
    assert.doesNotThrow(() => host.loadAll())
    assert.doesNotThrow(() => host.stop('test'))
    assert.doesNotThrow(() => host.stop('test'))
    assert.equal(host.diagnostics().stopped, true)
  })
})

test('hook: start wires the extension host into the bridge handle (diagnostics + stop)', async () => {
  await withTempDir((dir) => {
    writeStateFile(dir, sampleState())
    const extensionsDir = path.join(dir, 'extensions')
    fs.mkdirSync(extensionsDir, { recursive: true })
    const activatedMarker = path.join(dir, 'probe-activated.json')
    const deactivatedMarker = path.join(dir, 'probe-deactivated.txt')
    fs.writeFileSync(
      path.join(extensionsDir, 'probe.cjs'),
      [
        "'use strict'",
        "const fs = require('node:fs')",
        'module.exports = {',
        '  activate(context) {',
        `    fs.writeFileSync(${JSON.stringify(activatedMarker)}, JSON.stringify({ dataDir: context.dataDir }))`,
        '  },',
        '  deactivate() {',
        `    fs.appendFileSync(${JSON.stringify(deactivatedMarker)}, 'deactivated\\n')`,
        '  }',
        '}',
        ''
      ].join('\n'),
      'utf8'
    )
    const window = createFakeWindow({ url: 'dsh-app://app/', visible: false, focused: false })
    const { electron } = createFakeElectron({ windows: [window], userDataDir: dir })
    try {
      delete globalThis.__DSHTF
    } catch (_error) {
      /* ignore */
    }
    const handle = hookModule.start({
      api: electron,
      env: {},
      dataDir: dir,
      hookDir: shellHookRoot,
      timers: false
    })
    try {
      const diagnostics = handle.diagnostics()
      assert.equal(diagnostics.started, true)
      assert.ok(diagnostics.extensions, 'bridge diagnostics must expose the extension host')
      assert.deepEqual(diagnostics.extensions.loaded, ['probe'])
      assert.equal(diagnostics.extensions.errorCount, 0)
      assert.equal(JSON.parse(fs.readFileSync(activatedMarker, 'utf8')).dataDir, path.resolve(dir))
      assert.equal(globalThis.__DSHTF, handle)
    } finally {
      handle.stop('selftest')
      try {
        delete globalThis.__DSHTF
      } catch (_error) {
        /* ignore */
      }
    }
    assert.match(fs.readFileSync(deactivatedMarker, 'utf8'), /deactivated/)
  })
})

// --- injector pure helpers ---------------------------------------------------

test('injector: sanitizeDshEnv removes Electron/Node injection variables', () => {
  const env = sanitizeDshEnv(
    { PATH: 'C:\\x', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require x', ELECTRON_NO_ATTACH_CONSOLE: '1' },
    { DSH_HOME: 'C:\\home', EXTRA: null }
  )
  for (const key of SANITIZED_ENV_KEYS) assert.equal(key in env, false, `${key} must be removed`)
  assert.equal(env.PATH, 'C:\\x')
  assert.equal(env.DSH_HOME, 'C:\\home')
  assert.equal('EXTRA' in env, false)
})

test('injector: env default path helpers', () => {
  assert.equal(defaultDataDir({ LOCALAPPDATA: 'C:\\local' }).endsWith(path.join('C:\\local', 'dsh-tray-follower')), true)
  assert.equal(inspectPortFromEnv({ DSH_TRAY_FOLLOWER_INSPECT_PORT: '9600' }), 9600)
  assert.equal(inspectPortFromEnv({ DSH_TRAY_FOLLOWER_INSPECT_PORT: 'nope' }, 9531), 9531)
  assert.equal(defaultDshExe({ LOCALAPPDATA: 'C:\\local' }), path.join('C:\\local', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'))
  assert.equal(normalizePathForCompare('C:/A/b'), 'c:\\a\\b')
})

test('injector: bootstrap expressions compile and escape hook source', () => {
  const hookSource = `'use strict'\nmodule.exports = { start() { return { ok: true, marker: "a'b\\"c`+'`'+`d" } } }`
  const expression = buildBootstrapExpression({
    hookSource,
    hookPath: 'C:\\数据\\repo bridge\\bridge\\shell-hook\\hook.cjs',
    hookDir: 'C:\\数据\\repo bridge\\bridge\\shell-hook',
    dataDir: 'C:\\Users\\x\\AppData\\Local\\dsh-tray-follower',
    version: '0.1.0'
  })
  assert.doesNotThrow(() => new Function(expression))
  assert.match(expression, /process\.mainModule/)
  assert.match(expression, /createRequire|new Function/)
  const compiled = new Function(`return ${expression}`)
  assert.doesNotThrow(() => compiled)
  for (const expr of [buildDiagnosticsExpression(), buildFinalizeExpression({ keepInspector: true }), buildQuitExpression()]) {
    assert.doesNotThrow(() => new Function(expr))
  }
})

test('injector: pickInspectorTarget prefers node targets and ignores invalid entries', () => {
  assert.equal(pickInspectorTarget(null), null)
  assert.equal(pickInspectorTarget([{ type: 'node' }]), null)
  const target = pickInspectorTarget([
    { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:1/page' },
    { type: 'node', webSocketDebuggerUrl: 'ws://127.0.0.1:1/node' }
  ])
  assert.equal(target.webSocketDebuggerUrl, 'ws://127.0.0.1:1/node')
  assert.ok(READINESS_EXPRESSION.includes('mainModule'))
})

test('injector: port helpers pick a usable loopback port', async () => {
  const port = await pickFreePort(0)
  assert.ok(Number.isInteger(port) && port > 0)
  assert.equal(await isPortFree(port), true)
})

test('injector: shortcut helpers identify DSH shortcuts and build launcher fields', () => {
  assert.equal(
    isDshShortcut({ targetPath: 'C:\\Users\\x\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe' }, 'C:\\Users\\x\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'),
    true
  )
  assert.equal(isDshShortcut({ targetPath: 'C:\\other.exe' }, 'C:\\x.exe'), false)
  const fields = launcherShortcutFields({ dataDir: 'C:\\data\\dsh-tray-follower', dshExe: 'C:\\DSH\\DeepSeek Harness.exe', env: { SystemRoot: 'C:\\Windows' } })
  assert.ok(fields.targetPath.toLowerCase().endsWith('wscript.exe'))
  assert.match(fields.arguments, /launch-bridge\.vbs/)
  assert.match(fields.iconLocation, /DeepSeek Harness\.exe,0/)
  const candidates = shortcutCandidates({ APPDATA: 'C:\\APPDATA', LOCALAPPDATA: 'C:\\LAD', USERPROFILE: 'C:\\USER', ProgramData: 'C:\\PD' })
  assert.ok(candidates.some((entry) => entry.endsWith(path.join('Start Menu', 'Programs', 'DeepSeek Harness.lnk'))))
  assert.ok(candidates.some((entry) => entry.endsWith(path.join('Desktop', 'DeepSeek Harness.lnk'))))
})

test('injector: DSH main-process detection ignores Electron/DSH helper processes', () => {
  assert.equal(isDshBrowserCommandLine('"C:\\DSH\\DeepSeek Harness.exe"'), true)
  assert.equal(isDshBrowserCommandLine('"C:\\DSH\\DeepSeek Harness.exe" --updated'), true)
  assert.equal(isDshBrowserCommandLine('"C:\\DSH\\DeepSeek Harness.exe" --type=gpu-process --foo'), false)
  assert.equal(
    isDshBrowserCommandLine(
      '"C:\\DSH\\DeepSeek Harness.exe" --expose-internals C:\\DSH\\resources\\runtime\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js C:\\runtime C:\\profile'
    ),
    false
  )
  assert.equal(
    isDshBrowserCommandLine(
      '"C:\\DSH\\DeepSeek Harness.exe" --expose-internals C:\\runtime\\node_modules\\@deepseek-ai\\dsh-subprocess-local\\lib\\runner.js -- powershell'
    ),
    false
  )
})

// --- run ---------------------------------------------------------------------

async function main() {
  let passed = 0
  const failures = []
  console.log(`dsh-tray-follower bridge self-test (${tests.length} tests)`)
  console.log('')
  for (const entry of tests) {
    try {
      await entry.fn()
      passed += 1
      console.log(`PASS  ${entry.name}`)
    } catch (error) {
      failures.push({ name: entry.name, error })
      console.error(`FAIL  ${entry.name}`)
      const message = error instanceof Error ? (error.stack || error.message) : String(error)
      console.error(
        message
          .split('\n')
          .map((line) => `      ${line}`)
          .join('\n')
      )
    }
  }
  console.log('')
  console.log(`RESULT: ${String(passed)} passed, ${String(failures.length)} failed, ${String(tests.length)} total`)
  if (failures.length > 0) {
    console.log('FAILED TESTS:')
    for (const failure of failures) console.log(`  - ${failure.name}`)
    process.exitCode = 1
    return
  }
  console.log('ALL TESTS PASSED')
  process.exitCode = 0
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
