import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name, resolveLanguage, sanitizeOrigin } from '../index.js'
import { validateStateDocument } from '../lib/state.js'

const NOW = () => Date.now()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeCtx {
  constructor({ agents = [], workspaces = [], webApp } = {}) {
    this.handlers = new Map()
    this.services = new Map([
      ['agents', { list: () => agents }],
      ['workspaceRegistry', { list: () => workspaces }],
    ])
    if (webApp !== undefined) this.services.set('webApp', webApp)
    this.logs = []
    this.effects = []
  }

  on(eventName, handler) {
    const list = this.handlers.get(eventName) ?? []
    list.push(handler)
    this.handlers.set(eventName, list)
    return () => {
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    }
  }

  get(serviceName) {
    return this.services.get(serviceName)
  }

  logger() {
    return {
      info: (...args) => this.logs.push(['info', ...args]),
      warn: (...args) => this.logs.push(['warn', ...args]),
    }
  }

  effect(factory) {
    this.effects.push(factory)
    return () => {}
  }

  emit(eventName, ...args) {
    const results = []
    for (const handler of this.handlers.get(eventName) ?? []) results.push(handler(...args))
    return results
  }

  async emitWaterfall(eventName, payload, terminalNext) {
    const handlers = [...(this.handlers.get(eventName) ?? [])]
    let index = 0
    const run = async () => {
      if (index < handlers.length) {
        const handler = handlers[index]
        index += 1
        return handler(payload, run)
      }
      return terminalNext()
    }
    return run()
  }

  dispose() {
    for (const factory of this.effects) {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanup()
    }
    this.effects = []
  }

  warnings() {
    return this.logs.filter((entry) => entry[0] === 'warn')
  }
}

function makeSession(id) {
  return {
    id,
    header: { id, createdAt: NOW(), cwd: 'C:\\demo\\dsh_tray_follower' },
  }
}

function readState(dir) {
  return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
}

test('bundle identity exports', () => {
  assert.equal(name, 'dsh-tray-follower')
  assert.deepEqual(inject, ['agents'])
  assert.equal(typeof apply, 'function')
})

test('resolveLanguage and sanitizeOrigin', () => {
  assert.equal(resolveLanguage({ DSH_TRAY_FOLLOWER_LANG: 'zh-CN' }), 'zh')
  assert.equal(resolveLanguage({ DSH_TRAY_FOLLOWER_LANG: 'en-US' }), 'en')
  assert.equal(resolveLanguage({ DSH_LOCALE: 'zh-Hans' }), 'zh')
  assert.equal(resolveLanguage({ LANG: 'de_DE.UTF-8' }), 'en')
  assert.equal(sanitizeOrigin('http://127.0.0.1:61983/'), 'http://127.0.0.1:61983')
  assert.equal(sanitizeOrigin('http://user:pass@host:1/api?x=1'), 'http://host:1')
  assert.equal(sanitizeOrigin('file:///tmp/x'), '')
  assert.equal(sanitizeOrigin('garbage'), '')
  assert.equal(sanitizeOrigin(undefined), '')
})

test('apply() publishes the contract and follows synthetic DSH events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tray-e2e-'))
  const previous = {
    dir: process.env.DSH_TRAY_FOLLOWER_DIR,
    lang: process.env.DSH_TRAY_FOLLOWER_LANG,
    notify: process.env.DSH_TRAY_FOLLOWER_NOTIFY,
  }
  process.env.DSH_TRAY_FOLLOWER_DIR = dir
  process.env.DSH_TRAY_FOLLOWER_LANG = 'en'
  process.env.DSH_TRAY_FOLLOWER_NOTIFY = '0'

  const session = makeSession('session-1')
  const agent = { id: session.id, session, status: 'running' }
  const ctx = new FakeCtx({
    agents: [agent],
    workspaces: [
      { id: 'ws_1', title: 'dsh_tray_follower', path: 'C:\\demo\\dsh_tray_follower', sessionIds: ['session-1'] },
    ],
    webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:61983/' },
  })

  try {
    apply(ctx)
    // The initial snapshot is written synchronously at activation.
    const initial = readState(dir)
    assert.ok(validateStateDocument(initial).ok, JSON.stringify(validateStateDocument(initial).errors))
    assert.equal(initial.schemaVersion, 1)
    assert.equal(initial.hostPid, process.pid)
    assert.equal(initial.webOrigin, 'http://127.0.0.1:61983')
    assert.equal(initial.workspaces.length, 1)
    assert.equal(initial.workspaces[0].id, 'ws_1')
    assert.equal(initial.workspaces[0].sessions[0].id, 'session-1')
    assert.equal(initial.workspaces[0].sessions[0].status, 'running')

    // Title folds from the session log; the turn then completes.
    ctx.emit('session/event', session, { type: 'session/title', seq: 1, time: NOW(), data: { title: '配置 Git 等工程管理' } })
    ctx.emit('session/event', session, {
      type: 'turn/end',
      seq: 2,
      time: NOW(),
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    await sleep(320)
    const completed = readState(dir)
    assert.ok(validateStateDocument(completed).ok)
    const completedSession = completed.workspaces[0].sessions[0]
    assert.equal(completedSession.status, 'completed')
    assert.equal(completedSession.title, '配置 Git 等工程管理')
    assert.equal(completedSession.detail, 'Completed')
    assert.equal(completed.unreadEvents.length, 1)
    assert.equal(completed.unreadEvents[0].kind, 'completed')
    assert.equal(completed.unreadEvents[0].body, 'dsh_tray_follower • 配置 Git 等工程管理')

    // A new turn starts, then an approval request parks the conversation in
    // waiting-approval until the waterfall settles; the delayed notification
    // timer must not fire because the request is answered.
    ctx.emit('session/event', session, { type: 'turn/start', seq: 3, time: NOW(), data: { turn: 2 } })
    await sleep(320)
    assert.equal(readState(dir).workspaces[0].sessions[0].status, 'running')

    let resolveApproval
    const pendingApproval = ctx.emitWaterfall('approval/request', {
      agent,
      toolName: 'bash',
      callId: 'call-1',
      reason: 'Run the build?',
    }, () => new Promise((resolve) => {
      resolveApproval = resolve
    }))
    await sleep(320)
    const waiting = readState(dir)
    assert.equal(waiting.workspaces[0].sessions[0].status, 'waiting-approval')
    assert.equal(waiting.unreadEvents.length, 1)
    resolveApproval('allowed-once')
    assert.equal(await pendingApproval, 'allowed-once')
    await sleep(320)
    const resumed = readState(dir)
    assert.equal(resumed.workspaces[0].sessions[0].status, 'running')
    assert.equal(resumed.unreadEvents.length, 1)

    // Unloading flushes a final state instead of clearing the file.
    ctx.dispose()
    const final = readState(dir)
    assert.ok(validateStateDocument(final).ok)
    assert.equal(final.workspaces.length, 1)
    assert.deepEqual(ctx.warnings(), [])
  } finally {
    if (previous.dir === undefined) delete process.env.DSH_TRAY_FOLLOWER_DIR
    else process.env.DSH_TRAY_FOLLOWER_DIR = previous.dir
    if (previous.lang === undefined) delete process.env.DSH_TRAY_FOLLOWER_LANG
    else process.env.DSH_TRAY_FOLLOWER_LANG = previous.lang
    if (previous.notify === undefined) delete process.env.DSH_TRAY_FOLLOWER_NOTIFY
    else process.env.DSH_TRAY_FOLLOWER_NOTIFY = previous.notify
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply() is inert and quiet when services are missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tray-e2e-min-'))
  const previous = {
    dir: process.env.DSH_TRAY_FOLLOWER_DIR,
    notify: process.env.DSH_TRAY_FOLLOWER_NOTIFY,
  }
  process.env.DSH_TRAY_FOLLOWER_DIR = dir
  process.env.DSH_TRAY_FOLLOWER_NOTIFY = '0'
  const ctx = new FakeCtx({ agents: [], workspaces: [] })
  try {
    apply(ctx)
    const state = readState(dir)
    assert.ok(validateStateDocument(state).ok)
    assert.deepEqual(state.workspaces, [])
    assert.deepEqual(state.unreadEvents, [])
    ctx.dispose()
    assert.deepEqual(ctx.warnings(), [])
  } finally {
    if (previous.dir === undefined) delete process.env.DSH_TRAY_FOLLOWER_DIR
    else process.env.DSH_TRAY_FOLLOWER_DIR = previous.dir
    if (previous.notify === undefined) delete process.env.DSH_TRAY_FOLLOWER_NOTIFY
    else process.env.DSH_TRAY_FOLLOWER_NOTIFY = previous.notify
    rmSync(dir, { recursive: true, force: true })
  }
})
