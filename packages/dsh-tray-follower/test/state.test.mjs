import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStateDocument, compareSessions, groupSessions, validateStateDocument } from '../lib/state.js'
import { SessionTracker } from '../lib/tracker.js'
import { createStrings } from '../lib/strings.js'
import { SCHEMA_VERSION, SESSION_STATUSES } from '../lib/constants.js'

const NOW = 1_730_000_000_000
const strings = createStrings('en')

function makeSession(id, header = {}) {
  return { id, header: { id, createdAt: NOW, cwd: `C:\\work\\${id}`, ...header } }
}

function makeEvent(type, data = {}, seq = 1) {
  return { type, seq, time: NOW, data }
}

function seedTracker() {
  const tracker = new SessionTracker({
    now: () => NOW,
    strings,
    workspaceOf: (sessionId) => (sessionId.startsWith('session-a')
      ? { id: 'ws_alpha', title: 'alpha-project' }
      : undefined),
  })
  // Session A: completes → completed, workspace ws_alpha.
  const sessionA = makeSession('session-a1')
  tracker.observeAgent({ id: sessionA.id, session: sessionA, status: 'running' })
  tracker.sessionEvent(sessionA, makeEvent('session/title', { title: '配置 Git 等工程管理' }))
  tracker.sessionEvent(sessionA, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4))
  // Session B: waiting for approval → wait, then a published attention event.
  const sessionB = makeSession('session-b1')
  const agentB = { id: sessionB.id, session: sessionB }
  tracker.observeAgent({ id: agentB.id, session: sessionB, status: 'running' })
  tracker.sessionEvent(sessionB, makeEvent('session/title', { title: 'Bridge work' }))
  tracker.beginApprovalWait({ agent: agentB, toolName: 'bash', callId: 'c-1', reason: 'Run the build?' })
  tracker.takePublications()
  tracker.publishAttention(sessionB.id, 'approval:c-1')
  return tracker
}

const WORKSPACES = [
  { id: 'ws_alpha', title: 'alpha-project', path: 'C:\\work\\alpha-project', sessionIds: ['session-a1'] },
  { id: 'ws_empty', title: 'unused', path: 'C:\\work\\unused', sessionIds: [] },
]

test('buildStateDocument produces the docs/DESIGN.md §4 contract and validates', () => {
  const tracker = seedTracker()
  const document = buildStateDocument({
    tracker,
    workspaces: WORKSPACES,
    webOrigin: 'http://127.0.0.1:61983',
    hostPid: 4321,
    now: NOW + 10,
    strings,
  })

  // Contract v2: no Config passed → every option takes its schema default.
  assert.equal(SCHEMA_VERSION, 2)
  assert.equal(document.schemaVersion, SCHEMA_VERSION)
  assert.equal(document.updatedAt, NOW + 10)
  assert.equal(document.hostPid, 4321)
  assert.equal(document.webOrigin, 'http://127.0.0.1:61983')
  assert.deepEqual(document.options, {
    tray: { showIdle: false, maxSessionsPerWorkspace: 6, showHeaderCounts: true, showFooter: true },
    notifications: {
      notifyOnCompleted: true,
      notifyOnFailed: true,
      notifyOnAttention: true,
      suppressWhenFocused: true,
      notificationSound: true,
    },
  })

  // Only workspaces with conversations are published; empty ones are skipped.
  assert.deepEqual(document.workspaces.map((workspace) => workspace.id), ['ws_alpha', 'unassigned'])
  const alpha = document.workspaces[0]
  assert.equal(alpha.title, 'alpha-project')
  assert.equal(alpha.path, 'C:\\work\\alpha-project')
  assert.equal(alpha.sessions.length, 1)
  const session = alpha.sessions[0]
  assert.deepEqual(Object.keys(session).sort(), ['detail', 'id', 'startedAt', 'status', 'title', 'updatedAt'])
  assert.equal(session.id, 'session-a1')
  assert.equal(session.title, '配置 Git 等工程管理')
  assert.equal(session.status, 'completed')
  assert.ok(SESSION_STATUSES.includes(session.status))

  // The approval session has no workspace entry → the synthetic group.
  assert.equal(document.workspaces[1].sessions[0].id, 'session-b1')
  assert.equal(document.workspaces[1].sessions[0].status, 'waiting-approval')

  assert.equal(document.unreadEvents.length, 2)
  assert.deepEqual(Object.keys(document.unreadEvents[0]).sort(), [
    'body', 'createdAt', 'id', 'kind', 'sessionId', 'title', 'workspaceId',
  ])
  const validation = validateStateDocument(document)
  assert.deepEqual(validation, { ok: true, errors: [] })
  // Serialization stays JSON-safe.
  const roundTrip = JSON.parse(JSON.stringify(document))
  assert.deepEqual(roundTrip, document)
})

test('empty tracker still builds a valid document', () => {
  const tracker = new SessionTracker({ now: () => NOW, strings })
  const document = buildStateDocument({ tracker, workspaces: [], webOrigin: '', hostPid: 1, now: NOW, strings })
  assert.ok(validateStateDocument(document).ok)
  assert.deepEqual(document.workspaces, [])
  assert.deepEqual(document.unreadEvents, [])
  assert.equal(document.options.tray.showIdle, false)
  assert.equal(document.options.notifications.suppressWhenFocused, true)
})

test('buildStateDocument normalizes an explicit options object', () => {
  const tracker = new SessionTracker({ now: () => NOW, strings })
  const document = buildStateDocument({
    tracker,
    workspaces: [],
    hostPid: 1,
    now: NOW,
    strings,
    options: {
      tray: { showIdle: true, maxSessionsPerWorkspace: 99, showHeaderCounts: 'yes', showFooter: false },
      notifications: { notifyOnCompleted: false },
    },
  })
  assert.deepEqual(document.options, {
    tray: { showIdle: true, maxSessionsPerWorkspace: 20, showHeaderCounts: true, showFooter: false },
    notifications: {
      notifyOnCompleted: false,
      notifyOnFailed: true,
      notifyOnAttention: true,
      suppressWhenFocused: true,
      notificationSound: true,
    },
  })
  assert.ok(validateStateDocument(document).ok)
})

test('groupSessions keeps registry order and sorts sessions by urgency then recency', () => {
  const sessions = [
    { id: 's-idle', title: 'idle', status: 'idle', detail: '', updatedAt: 1, startedAt: 1 },
    { id: 's-running', title: 'running', status: 'running', detail: '', updatedAt: 1, startedAt: 1 },
    { id: 's-completed', title: 'completed', status: 'completed', detail: '', updatedAt: 9, startedAt: 1 },
    { id: 's-failed', title: 'failed', status: 'failed', detail: '', updatedAt: 9, startedAt: 1 },
  ]
  const grouped = groupSessions(sessions, [
    { id: 'ws_1', title: 'one', path: '/one', sessionIds: ['s-idle', 's-running', 's-completed', 's-failed'] },
  ], strings)
  assert.deepEqual(grouped[0].sessions.map((entry) => entry.id), [
    's-running', 's-failed', 's-completed', 's-idle',
  ])
})

test('compareSessions breaks ties by updatedAt then id', () => {
  const newer = { id: 'b', status: 'completed', updatedAt: 2 }
  const older = { id: 'a', status: 'completed', updatedAt: 1 }
  assert.ok(compareSessions(newer, older) < 0)
  assert.ok(compareSessions(older, newer) > 0)
  // Same rank and time: the id is the deterministic final tie-breaker.
  const tieA = { id: 'a', status: 'completed', updatedAt: 1 }
  const tieB = { id: 'b', status: 'completed', updatedAt: 1 }
  assert.ok(compareSessions(tieA, tieB) < 0)
  assert.equal(compareSessions(tieA, { ...tieA }), 0)
})

test('validator reports every contract violation', () => {
  const tracker = seedTracker()
  const document = buildStateDocument({ tracker, workspaces: WORKSPACES, hostPid: 1, now: NOW, strings })
  document.schemaVersion = 99
  document.hostPid = 'nope'
  document.webOrigin = 'not a url'
  document.options.tray.showIdle = 'yes'
  document.options.tray.maxSessionsPerWorkspace = 0
  document.options.notifications.notifyOnCompleted = 'sure'
  document.options.notifications.extra = true // unknown keys are tolerated
  document.workspaces[0].sessions[0].status = 'sleeping'
  document.workspaces[0].sessions[0].id = ''
  document.workspaces[1].id = 'ws_alpha' // duplicate workspace id
  document.unreadEvents[0].kind = 'surprise'
  document.unreadEvents[1].createdAt = 'yesterday'
  const validation = validateStateDocument(document)
  assert.equal(validation.ok, false)
  const joined = validation.errors.join('\n')
  for (const expected of [
    'schemaVersion must be 2',
    'hostPid must be a positive integer',
    'webOrigin must be empty or an http(s) URL',
    'options.tray.showIdle must be a boolean',
    'options.tray.maxSessionsPerWorkspace must be an integer between 1 and 20',
    'options.notifications.notifyOnCompleted must be a boolean',
    'is not a contract status',
    'id duplicated: ws_alpha',
    'is not a contract kind',
    'createdAt must be a finite number',
  ]) {
    assert.ok(joined.includes(expected), `missing: ${expected}\n${joined}`)
  }
  assert.ok(!joined.includes('options.notifications.extra'), 'unknown option keys must be tolerated')
})

test('validator rejects a missing or malformed options object', () => {
  const tracker = seedTracker()
  const base = buildStateDocument({ tracker, workspaces: WORKSPACES, hostPid: 1, now: NOW, strings })

  const missing = { ...base }
  delete missing.options
  assert.ok(validateStateDocument(missing).errors.includes('options must be an object'))

  const notAnObject = { ...base, options: [] }
  assert.ok(validateStateDocument(notAnObject).errors.includes('options must be an object'))

  const missingSection = { ...base, options: { tray: base.options.tray } }
  assert.ok(validateStateDocument(missingSection).errors.includes('options.notifications must be an object'))
})

test('validator rejects non-objects without throwing', () => {
  assert.equal(validateStateDocument(null).ok, false)
  assert.equal(validateStateDocument([]).ok, false)
  assert.equal(validateStateDocument('x').ok, false)
  assert.equal(validateStateDocument({}).ok, false)
})
