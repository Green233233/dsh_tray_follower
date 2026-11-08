import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionTracker } from '../lib/tracker.js'
import { createStrings } from '../lib/strings.js'
import { describeEntry, resolveStatus } from '../lib/status.js'
import { RETENTION_MS } from '../lib/constants.js'

const NOW = 1_730_000_000_000
const strings = createStrings('en')

/**
 * @param {{ workspaceOf?: (id: string) => any, retentionMs?: number }} [options]
 */
function makeTracker(options = {}) {
  let clock = NOW
  const tracker = new SessionTracker({
    now: () => clock,
    strings,
    workspaceOf: options.workspaceOf ?? ((id) => (id === 'session-1'
      ? { id: 'ws_1', title: 'dsh_tray_follower' }
      : undefined)),
    retentionMs: options.retentionMs,
  })
  return {
    tracker,
    advance(ms) {
      clock += ms
    },
    setClock(value) {
      clock = value
    },
    now: () => clock,
  }
}

function makeSession(id = 'session-1', header = {}) {
  return { id, header: { id, createdAt: NOW, cwd: 'C:\\demo\\project', ...header } }
}

function makeEvent(type, data = {}, seq = 1) {
  return { type, seq, time: NOW, data }
}

function statusOf(tracker, id = 'session-1') {
  const session = tracker.snapshot().find((entry) => entry.id === id)
  return session ? session.status : undefined
}

test('idle → running → completed with unread notification and workspace body', () => {
  const { tracker, advance } = makeTracker()
  const session = makeSession()
  const agent = { id: session.id, session }

  tracker.observeAgent({ id: agent.id, session, status: 'idle' })
  assert.equal(statusOf(tracker), 'idle')

  tracker.sessionEvent(session, makeEvent('session/title', { title: '配置 Git 等工程管理' }))
  tracker.agentStatus({ id: agent.id, session, status: 'running' })
  assert.equal(statusOf(tracker), 'running')
  assert.equal(tracker.snapshot()[0].detail, 'Thinking')
  assert.equal(tracker.snapshot()[0].title, '配置 Git 等工程管理')

  tracker.sessionEvent(session, makeEvent('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' }))
  assert.equal(tracker.snapshot()[0].detail, 'Running bash')

  advance(500)
  tracker.sessionEvent(session, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5))
  assert.equal(statusOf(tracker), 'completed')
  assert.equal(tracker.snapshot()[0].detail, 'Completed')

  const unread = tracker.unreadEvents()
  assert.equal(unread.length, 1)
  assert.equal(unread[0].kind, 'completed')
  assert.equal(unread[0].sessionId, 'session-1')
  assert.equal(unread[0].workspaceId, 'ws_1')
  assert.equal(unread[0].title, 'Task completed')
  assert.equal(unread[0].body, 'dsh_tray_follower • 配置 Git 等工程管理')
  assert.ok(unread[0].id.startsWith('evt_'))
  assert.equal(unread[0].createdAt, NOW + 500)
})

test('a re-delivered turn/end cannot duplicate the completion notification', () => {
  const { tracker } = makeTracker()
  const session = makeSession()
  tracker.observeAgent({ id: session.id, session, status: 'running' })
  tracker.sessionEvent(session, makeEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  tracker.sessionEvent(session, makeEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  assert.equal(tracker.unreadEvents().length, 1)
})

test('repeated approvals for the same tool each notify once', () => {
  const { tracker } = makeTracker()
  const session = makeSession()
  const agent = { id: session.id, session }
  tracker.observeAgent({ id: agent.id, session, status: 'running' })
  tracker.beginApprovalWait({ agent, toolName: 'bash', reason: 'first?' })
  tracker.takePublications()
  assert.equal(tracker.publishAttention('session-1', 'approval:bash'), true)
  assert.equal(tracker.endWait('session-1', 'approval:bash'), true)

  tracker.beginApprovalWait({ agent, toolName: 'bash', reason: 'second?' })
  tracker.takePublications()
  assert.equal(tracker.publishAttention('session-1', 'approval:bash'), true)
  assert.equal(tracker.unreadEvents().length, 2)
  assert.notEqual(tracker.unreadEvents()[0].id, tracker.unreadEvents()[1].id)
})

test('attention ids stay unique across a Host restart (occurrence counter resets)', () => {
  const first = makeTracker()
  const firstSession = makeSession()
  first.tracker.observeAgent({ id: firstSession.id, session: firstSession, status: 'running' })
  first.tracker.beginApprovalWait({ agent: { id: firstSession.id, session: firstSession }, toolName: 'bash', reason: 'first?' })
  first.tracker.takePublications()
  assert.equal(first.tracker.publishAttention('session-1', 'approval:bash'), true)
  const firstId = first.tracker.unreadEvents()[0].id

  // Simulate a Host restart / plugin reload: the fresh tracker's per-process
  // occurrence counter starts at 1 again, but the wait happens at a later ms.
  const second = makeTracker()
  second.advance(5_000)
  const secondSession = makeSession()
  second.tracker.observeAgent({ id: secondSession.id, session: secondSession, status: 'running' })
  second.tracker.beginApprovalWait({ agent: { id: secondSession.id, session: secondSession }, toolName: 'bash', reason: 'second?' })
  second.tracker.takePublications()
  assert.equal(second.tracker.publishAttention('session-1', 'approval:bash'), true)
  const secondId = second.tracker.unreadEvents()[0].id

  // The bridge persists seen ids across DSH restarts; a collision here means a
  // real "action needed" notification is silently dropped after a restart.
  assert.notEqual(firstId, secondId)
})

test('turn/start clears a completed status back to running', () => {
  const { tracker } = makeTracker()
  const session = makeSession()
  tracker.observeAgent({ id: session.id, session, status: 'running' })
  tracker.sessionEvent(session, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(statusOf(tracker), 'completed')
  tracker.sessionEvent(session, makeEvent('turn/start', { turn: 2 }))
  assert.equal(statusOf(tracker), 'running')
})

test('approval wait: status, delayed publication, settle', () => {
  const { tracker } = makeTracker()
  const session = makeSession()
  const agent = { id: session.id, session }
  tracker.observeAgent({ id: agent.id, session, status: 'running' })

  tracker.sessionEvent(session, makeEvent('approval/asked', {
    id: 'approval-1',
    toolName: 'bash',
    callId: 'call-9',
    reason: 'Run rm -rf?',
  }))
  assert.equal(statusOf(tracker), 'waiting-approval')
  assert.equal(tracker.snapshot()[0].detail, 'Waiting for approval: Run rm -rf?')

  const publications = tracker.takePublications()
  assert.deepEqual(publications, [{ sessionId: 'session-1', key: 'approval:call-9' }])
  assert.equal(tracker.publishAttention('session-1', 'approval:call-9'), true)
  assert.equal(tracker.unreadEvents().length, 1)
  assert.equal(tracker.unreadEvents()[0].kind, 'needs-attention')
  assert.equal(tracker.unreadEvents()[0].title, 'Action needed')
  // Publishing twice for the same wait never duplicates the event.
  assert.equal(tracker.publishAttention('session-1', 'approval:call-9'), false)

  tracker.sessionEvent(session, makeEvent('approval/decided', { id: 'approval-1', outcome: 'rejected' }))
  assert.equal(statusOf(tracker), 'running')
})

test('waterfall approval wait: duplicate observation of the same call shares one wait', () => {
  const { tracker } = makeTracker()
  const session = makeSession()
  const agent = { id: session.id, session }
  tracker.observeAgent({ id: agent.id, session, status: 'running' })

  const first = tracker.beginApprovalWait({ agent, toolName: 'bash', callId: 'call-1', reason: 'run?' })
  assert.deepEqual(first, { sessionId: 'session-1', key: 'approval:call-1' })
  assert.equal(tracker.takePublications().length, 1)

  // The window between the audit event and the waterfall may deliver both.
  tracker.sessionEvent(session, makeEvent('approval/asked', { id: 'approval-1', toolName: 'bash', callId: 'call-1', reason: 'run?' }))
  assert.equal(tracker.takePublications().length, 0)
  assert.equal(statusOf(tracker), 'waiting-approval')

  assert.equal(tracker.endWait('session-1', 'approval:call-1'), true)
  assert.equal(statusOf(tracker), 'running')
})

test('questions: options → waiting-choice, free text → waiting-input, settle on result', () => {
  const { tracker } = makeTracker()
  const session = makeSession()
  const agent = { id: session.id, session }
  tracker.observeAgent({ id: agent.id, session, status: 'running' })

  tracker.sessionEvent(session, makeEvent('tool/call', {
    turn: 1,
    step: 1,
    callId: 'ask-1',
    name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ id: 'q1', question: 'Choose mode', options: [{ label: 'a' }, { label: 'b' }] }] }),
  }))
  assert.equal(statusOf(tracker), 'waiting-choice')
  assert.equal(tracker.snapshot()[0].detail, 'Waiting for your choice: Choose mode')
  // The tool/call observation already queued the delayed publication.
  assert.deepEqual(tracker.takePublications(), [{ sessionId: 'session-1', key: 'question:ask-1' }])

  const wait = tracker.beginQuestionWait({ agent, questions: [{ id: 'q1', question: 'Choose mode', options: [{ label: 'a' }] }], wait: { callId: 'ask-1' } })
  assert.deepEqual(wait, { sessionId: 'session-1', key: 'question:ask-1' })
  // The waterfall observation of the same call does not queue a second toast.
  assert.equal(tracker.takePublications().length, 0)

  tracker.sessionEvent(session, makeEvent('tool/result', { turn: 1, step: 1, message: { toolCallId: 'ask-1' } }, 3))
  assert.equal(statusOf(tracker), 'running')

  tracker.sessionEvent(session, makeEvent('tool/call', {
    turn: 1,
    step: 2,
    callId: 'ask-2',
    name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ id: 'q2', question: 'Type your name' }] }),
  }))
  assert.equal(statusOf(tracker), 'waiting-input')
  assert.equal(tracker.snapshot()[0].detail, 'Waiting for your input: Type your name')
})

test('turn/end clears waits (fail-safe when a settle event was missed)', () => {
  const { tracker } = makeTracker()
  const session = makeSession()
  const agent = { id: session.id, session }
  tracker.observeAgent({ id: agent.id, session, status: 'running' })
  tracker.beginQuestionWait({ agent, questions: [{ id: 'q', question: 'Pick' }], wait: { callId: 'c-9' } })
  assert.equal(statusOf(tracker), 'waiting-input')
  tracker.sessionEvent(session, makeEvent('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
  assert.equal(statusOf(tracker), 'idle')
})

test('failed turn and agent/error do not duplicate the failure notification', () => {
  const { tracker } = makeTracker()
  const session = makeSession()
  const agent = { id: session.id, session }
  tracker.observeAgent({ id: agent.id, session, status: 'running' })

  // A step error while the agent keeps running records the failure but does
  // not notify yet: the enclosing turn/end is the user-relevant stop.
  tracker.agentError({ id: agent.id, session, turn: 3, step: 2, error: { message: 'boom' } })
  assert.equal(statusOf(tracker), 'running')
  assert.equal(tracker.unreadEvents().length, 0)

  tracker.agentStatus({ id: agent.id, session, status: 'idle' })
  assert.equal(statusOf(tracker), 'failed')
  assert.equal(tracker.snapshot()[0].detail, 'boom')

  tracker.sessionEvent(session, makeEvent('turn/end', { turn: 3, reason: { kind: 'error', error: { message: 'boom' } } }, 9))
  assert.equal(tracker.unreadEvents().length, 1)
  assert.equal(tracker.unreadEvents()[0].kind, 'failed')
})

test('active goal suppresses between-round completion notifications', () => {
  const { tracker } = makeTracker()
  const session = makeSession()
  const agent = { id: session.id, session }
  tracker.observeAgent({
    id: agent.id,
    session,
    status: 'idle',
    title: 'Goal session',
    goal: { id: 'goal-1', revision: 1, phase: 'active', activation: 'armed' },
  })
  // Idle between rounds, but the goal is still armed: the tray keeps it running.
  assert.equal(statusOf(tracker), 'running')
  assert.equal(tracker.snapshot()[0].detail, 'Working on goal')

  tracker.agentStatus({ id: agent.id, session, status: 'running' })
  tracker.sessionEvent(session, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(tracker.unreadEvents().length, 0)
  assert.equal(statusOf(tracker), 'running')

  tracker.goalChanged({
    agent,
    change: {
      operation: 'complete',
      ref: { id: 'goal-1', revision: 2 },
      goal: { id: 'goal-1', revision: 2, phase: 'complete', activation: 'disarmed', roundsStarted: 2 },
    },
  })
  assert.equal(statusOf(tracker), 'completed')
  assert.equal(tracker.unreadEvents().length, 1)
  assert.equal(tracker.unreadEvents()[0].title, 'Goal completed')
})

test('goal completion followed by its closing turn/end notifies once', () => {
  const { tracker } = makeTracker()
  const session = makeSession()
  const agent = { id: session.id, session }
  tracker.observeAgent({
    id: agent.id,
    session,
    status: 'running',
    title: 'Goal session',
    goal: { id: 'g', revision: 1, phase: 'active', activation: 'armed' },
  })
  // The goal driver commits the completion first…
  tracker.goalChanged({
    agent,
    change: {
      operation: 'complete',
      ref: { id: 'g', revision: 2 },
      goal: { id: 'g', revision: 2, phase: 'complete', activation: 'disarmed' },
    },
  })
  assert.equal(tracker.unreadEvents().length, 1)
  // …then the closing turn/end arrives: no second notification.
  tracker.sessionEvent(session, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(tracker.unreadEvents().length, 1)
  assert.equal(tracker.unreadEvents()[0].title, 'Goal completed')
  assert.equal(statusOf(tracker), 'completed')
})

test('blocked goal becomes failed with its reason', () => {
  const { tracker } = makeTracker()
  const session = makeSession()
  const agent = { id: session.id, session }
  tracker.observeAgent({ id: agent.id, session, status: 'running', goal: { id: 'g', revision: 1, phase: 'active', activation: 'armed' } })
  tracker.goalChanged({
    agent,
    change: {
      operation: 'block',
      ref: { id: 'g', revision: 2 },
      goal: { id: 'g', revision: 2, phase: 'blocked', activation: 'disarmed', blockedReason: { code: 'x', message: 'needs input' } },
    },
  })
  assert.equal(statusOf(tracker), 'failed')
  assert.equal(tracker.snapshot()[0].detail, 'needs input')
  assert.equal(tracker.unreadEvents()[0].kind, 'failed')
})

test('subagent sessions are ignored entirely', () => {
  const { tracker } = makeTracker()
  const child = makeSession('session-child', { origin: 'subagent', delegationDepth: 1 })
  assert.equal(tracker.observeAgent({ id: 'session-child', session: child, status: 'running' }), false)
  assert.equal(tracker.sessionEvent(child, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })), false)
  assert.equal(tracker.snapshot().length, 0)
  assert.equal(tracker.unreadEvents().length, 0)
})

test('disposed conversations keep their final state for the retention window only', () => {
  const { tracker, advance } = makeTracker({ retentionMs: RETENTION_MS })
  const session = makeSession()
  tracker.observeAgent({ id: session.id, session, status: 'running' })
  tracker.sessionEvent(session, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  tracker.agentDisposed({ id: session.id, session })
  assert.equal(tracker.snapshot().length, 1)
  assert.equal(statusOf(tracker), 'completed')

  advance(RETENTION_MS - 1)
  assert.equal(tracker.tick(), false)
  assert.equal(tracker.snapshot().length, 1)

  advance(2)
  assert.equal(tracker.tick(), true)
  assert.equal(tracker.snapshot().length, 0)
})

test('waiting states outrank running and a topWait picks approval first', () => {
  const { tracker } = makeTracker()
  const session = makeSession()
  const agent = { id: session.id, session }
  tracker.observeAgent({ id: agent.id, session, status: 'running' })
  tracker.beginApprovalWait({ agent, toolName: 'bash', callId: 'c1', reason: 'need yes' })
  tracker.beginQuestionWait({ agent, questions: [{ id: 'q', question: 'Pick' }], wait: { callId: 'c2' } })
  assert.equal(statusOf(tracker), 'waiting-approval')
  assert.equal(describeEntry(tracker.entries.get('session-1'), strings), 'Waiting for approval: need yes')
  tracker.endWait('session-1', 'approval:c1')
  assert.equal(statusOf(tracker), 'waiting-input')
})

test('snapshot entries carry contract fields', () => {
  const { tracker } = makeTracker()
  const session = makeSession()
  tracker.observeAgent({ id: session.id, session, status: 'running' })
  const [entry] = tracker.snapshot()
  assert.deepEqual(Object.keys(entry).sort(), ['detail', 'id', 'startedAt', 'status', 'title', 'updatedAt'])
  assert.equal(typeof entry.id, 'string')
  assert.equal(typeof entry.title, 'string')
  assert.equal(typeof entry.status, 'string')
  assert.equal(typeof entry.detail, 'string')
  assert.equal(typeof entry.updatedAt, 'number')
  assert.equal(typeof entry.startedAt, 'number')
})

test('resolveStatus is total: unknown wait kinds still mean "waiting for you"', () => {
  const entry = {
    live: true,
    running: false,
    waits: new Map([['x', { kind: 'mystery', text: 'hi' }]]),
    lastOutcome: null,
    goal: undefined,
  }
  assert.equal(resolveStatus(entry), 'idle')
  entry.waits.clear()
  entry.lastOutcome = 'completed'
  assert.equal(resolveStatus(entry), 'completed')
  entry.lastOutcome = 'failed'
  assert.equal(resolveStatus(entry), 'failed')
})
