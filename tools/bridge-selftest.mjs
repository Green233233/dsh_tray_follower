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
  const record = { restored: 0, shown: 0, focused: 0 }
  const window = {
    record,
    webContents: { getURL: () => options.url || 'dsh-app://app/' },
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

// --- menu model --------------------------------------------------------------

test('menu: header counts running and pending only', () => {
  const read = stateModule.normalizeState(sampleState())
  const section = menuModel.buildStatusSection(read.state, { version: '9.9.9', locale: 'zh-CN' })
  assert.equal(section[0].kind, 'header')
  assert.equal(section[0].label, '对话：1 运行 / 2 待处理')
  assert.equal(section[0].enabled, false)
})

test('menu: sessions are sorted by attention priority with glyphs', () => {
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
  const section = menuModel.buildStatusSection(read.state, { version: '0.1.0', locale: 'zh-CN' })
  const workspace = section.find((item) => item.kind === 'workspace')
  assert.ok(workspace)
  assert.equal(workspace.label, '📁 WS  运行 1 · 待处理 3')
  const activeLabels = workspace.submenu.filter((item) => item.kind === 'session').map((item) => item.label)
  assert.deepEqual(activeLabels, ['⏸ a', '❓ c', '⌨ i', '▶ r', '✓ d', '✖ f'])
  const idleGroup = workspace.submenu.find((item) => item.kind === 'idle-group')
  assert.ok(idleGroup)
  assert.equal(idleGroup.label, '空闲会话 (1)')
  assert.deepEqual(idleGroup.submenu.map((item) => item.label), ['○ x'])
})

test('menu: at most 6 active rows plus overflow row', () => {
  const sessions = []
  for (let index = 0; index < 9; index += 1) sessions.push({ id: `r${index}`, title: `run ${index}`, status: 'running' })
  const read = stateModule.normalizeState(sampleState({ workspaces: [{ id: 'w', title: 'W', sessions }] }))
  const section = menuModel.buildStatusSection(read.state, { version: '0.1.0', locale: 'zh-CN' })
  const workspace = section.find((item) => item.kind === 'workspace')
  const active = workspace.submenu.filter((item) => item.kind === 'session')
  assert.equal(active.length, 6)
  const overflow = workspace.submenu.find((item) => item.kind === 'placeholder')
  assert.ok(overflow)
  assert.equal(overflow.label, '… 还有 3 个会话')
})

test('menu: idle sessions are collapsed into a bounded submenu', () => {
  const sessions = []
  for (let index = 0; index < 13; index += 1) sessions.push({ id: `i${index}`, title: `idle ${index}`, status: 'idle' })
  sessions.push({ id: 'run', title: 'run', status: 'running' })
  const read = stateModule.normalizeState(sampleState({ workspaces: [{ id: 'w', title: 'W', sessions }] }))
  const section = menuModel.buildStatusSection(read.state, { version: '0.1.0', locale: 'zh-CN' })
  const workspace = section.find((item) => item.kind === 'workspace')
  assert.equal(workspace.label, '📁 W  运行 1 · 待处理 0')
  assert.equal(workspace.submenu.filter((item) => item.kind === 'session').length, 1, 'idle rows must not be inline')
  const idleGroup = workspace.submenu.find((item) => item.kind === 'idle-group')
  assert.equal(idleGroup.label, '空闲会话 (13)')
  assert.equal(idleGroup.submenu.filter((item) => item.kind === 'session').length, 10)
  assert.equal(idleGroup.submenu[idleGroup.submenu.length - 1].label, '… 还有 3 个会话')
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
    assert.ok(labels.includes('dsh-tray-follower v0.1.0'))
    assert.equal(bridge.diagnostics().capturedItemCount, 3, 'captured template must be the shell menu, not the merged menu')

    // The captured original click handler still works after the rebuild.
    const rebuiltOpen = lastMenu.items.find((item) => item.label === '打开 DeepSeek Harness')
    rebuiltOpen.click()
    assert.equal(openClicks, 1)

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
    assert.ok(fake.shownNotifications.some((item) => item.title === 'DSH 托盘跟随（自检）'))
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
