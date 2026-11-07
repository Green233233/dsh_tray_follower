/**
 * The pure conversation-state machine.
 *
 * Consumes normalized DSH facts (agent status events, session log events,
 * approval/question waits, goal changes) and produces the session projection
 * published in the state file. No DSH imports and no I/O: `node --test` can
 * drive it with plain objects.
 */
import {
  ASK_USER_TOOL,
  MAX_SEEN_UNREAD_IDS,
  MAX_TRACKED_SESSIONS,
  MAX_UNREAD_EVENTS,
  RETENTION_MS,
} from './constants.js'
import {
  approvalReason,
  classifyQuestionArguments,
  classifyQuestionItems,
  clip,
  isTopLevelSession,
  outcomeOfTurnEnd,
  waitText,
} from './classify.js'
import { stableEventId } from './ids.js'
import { createStrings } from './strings.js'
import { describeEntry, displayTitle, resolveStatus } from './status.js'

/** Statuses that are retained briefly after the live agent disappears. */
const OUTCOME_STATUSES = new Set(['completed', 'failed'])

/**
 * Compose the notification body used by the design contract:
 * `"<workspace> • <conversation>"` (the workspace part is omitted when the
 * conversation is not grouped).
 * @param {string | undefined} workspaceTitle
 * @param {string} sessionTitle
 * @returns {string}
 */
export function composeBody(workspaceTitle, sessionTitle) {
  const workspace = typeof workspaceTitle === 'string' ? workspaceTitle.trim() : ''
  const session = typeof sessionTitle === 'string' ? sessionTitle.trim() : ''
  if (workspace !== '' && session !== '') return `${workspace} • ${session}`
  return session || workspace
}

export class SessionTracker {
  /**
   * @param {{
   *   now?: () => number,
   *   strings?: { lang?: string, text: (key: string, params?: Record<string, unknown>) => string },
   *   language?: string,
   *   workspaceOf?: (sessionId: string) => { id?: string, title?: string } | undefined,
   *   maxUnread?: number,
   *   retentionMs?: number,
   *   maxSessions?: number,
   * }} [options]
   */
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.strings = options.strings ?? createStrings(options.language ?? 'en')
    this.workspaceOf = typeof options.workspaceOf === 'function' ? options.workspaceOf : () => undefined
    this.maxUnread = Number.isInteger(options.maxUnread) && options.maxUnread > 0
      ? options.maxUnread
      : MAX_UNREAD_EVENTS
    this.retentionMs = Number.isInteger(options.retentionMs) && options.retentionMs >= 0
      ? options.retentionMs
      : RETENTION_MS
    this.maxSessions = Number.isInteger(options.maxSessions) && options.maxSessions > 0
      ? options.maxSessions
      : MAX_TRACKED_SESSIONS

    /** @type {Map<string, any>} */
    this.entries = new Map()
    /** @type {Array<any>} */
    this.unread = []
    /** @type {Set<string>} */
    this.seenUnread = new Set()
    /** @type {Array<{ sessionId: string, key: string }>} */
    this.publicationQueue = []
    this.changeListeners = new Set()
    this.unreadListeners = new Set()
  }

  /**
   * Subscribe to any projection change (state file should be re-written).
   * @param {() => void} listener
   * @returns {() => void}
   */
  onChange(listener) {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  /**
   * Subscribe to newly appended unread events.
   * @param {(event: any) => void} listener
   * @returns {() => void}
   */
  onUnread(listener) {
    this.unreadListeners.add(listener)
    return () => this.unreadListeners.delete(listener)
  }

  /** @private */
  _changed() {
    for (const listener of this.changeListeners) {
      try {
        listener()
      } catch {
        // A projection listener must never break the machine.
      }
    }
  }

  /**
   * Ensure a top-level entry exists for a session.
   * @private
   * @param {any} session Session-like object (`{ id, header }`); may be undefined.
   * @param {string | number | undefined} [id]
   * @returns {any | undefined}
   */
  _ensure(session, id) {
    const sessionId = id ?? session?.id
    if (sessionId === undefined || sessionId === null) return undefined
    if (!isTopLevelSession(session)) return undefined
    const key = String(sessionId)
    let entry = this.entries.get(key)
    if (entry === undefined) {
      const createdAt = typeof session?.header?.createdAt === 'number'
        ? session.header.createdAt
        : this.now()
      entry = {
        id: key,
        title: undefined,
        cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined,
        createdAt,
        live: false,
        running: false,
        runStartedAt: undefined,
        startedAt: createdAt,
        lastTool: undefined,
        waits: new Map(),
        lastOutcome: null,
        lastError: undefined,
        goal: undefined,
        updatedAt: createdAt,
      }
      this.entries.set(key, entry)
      this._evictOverflow()
    } else {
      if (entry.title === undefined && typeof session?.header?.cwd === 'string') entry.cwd = session.header.cwd
      if (typeof session?.header?.createdAt === 'number') entry.createdAt = session.header.createdAt
    }
    return entry
  }

  /** @private */
  _evictOverflow() {
    if (this.entries.size <= this.maxSessions) return
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxSessions) break
      if (!entry.live) this.entries.delete(key)
    }
  }

  /**
   * Seed or refresh one live agent (used at activation and on `agent/created`).
   * @param {{ id?: string | number, session?: any, status?: string, title?: string, goal?: any, live?: boolean }} agent
   * @returns {boolean} whether the projection changed
   */
  observeAgent(agent) {
    const entry = this._ensure(agent?.session, agent?.id)
    if (entry === undefined) return false
    const now = this.now()
    const running = agent.status === 'running'
    if (typeof agent.title === 'string' && agent.title.trim() !== '') entry.title = agent.title.trim()
    if (agent.goal !== undefined) entry.goal = normalizeGoal(agent.goal)
    if (agent.live !== false) entry.live = true
    if (running && !entry.running) {
      entry.running = true
      entry.runStartedAt = now
    } else if (!running) {
      entry.running = false
    }
    entry.updatedAt = now
    this._changed()
    return true
  }

  /**
   * `agent/status` payload.
   * @param {{ id?: string | number, session?: any, status?: string }} payload
   * @returns {boolean}
   */
  agentStatus(payload) {
    const entry = this._ensure(payload?.session, payload?.id)
    if (entry === undefined) return false
    const now = this.now()
    const running = payload?.status === 'running'
    if (running) {
      entry.running = true
      entry.runStartedAt = entry.runStartedAt ?? now
      entry.lastOutcome = null
      entry.lastError = undefined
    } else {
      entry.running = false
      entry.lastTool = undefined
    }
    entry.live = true
    entry.updatedAt = now
    this._changed()
    return true
  }

  /**
   * `agent/disposed`: the agent left the registry. The conversation stays in
   * the published state for a short retention window so a completion is still
   * visible, but it is never reported as running again.
   * @param {{ id?: string | number, session?: any }} payload
   * @returns {boolean}
   */
  agentDisposed(payload) {
    const entry = this._ensure(payload?.session, payload?.id)
    if (entry === undefined) return false
    const now = this.now()
    entry.live = false
    entry.running = false
    entry.lastTool = undefined
    entry.waits.clear()
    entry.updatedAt = now
    if (!OUTCOME_STATUSES.has(entry.lastOutcome) && entry.goal?.phase !== 'complete' && entry.goal?.phase !== 'blocked') {
      entry.goal = undefined
    }
    this._changed()
    return true
  }

  /**
   * `agent/error`: a step or turn errored outside a completed turn/end.
   * @param {{ id?: string | number, session?: any, turn?: number, step?: number, error?: any }} payload
   * @returns {boolean}
   */
  agentError(payload) {
    const entry = this._ensure(payload?.session, payload?.id)
    if (entry === undefined) return false
    const now = this.now()
    entry.lastOutcome = 'failed'
    entry.lastError = errorText(payload?.error) || this.strings.text('errorFallback')
    entry.updatedAt = now
    const turn = Number.isInteger(payload?.turn) ? payload.turn : 'unknown'
    this._addUnread(entry, 'failed', {
      id: stableEventId('failed', entry.id, turn),
      title: this.strings.text('failedTitle'),
    })
    this._changed()
    return true
  }

  /**
   * Route one `session/event` payload.
   * @param {any} session live Session object
   * @param {{ type?: string, seq?: number, time?: number, data?: any }} event
   * @returns {boolean}
   */
  sessionEvent(session, event) {
    const entry = this._ensure(session, session?.id)
    if (entry === undefined) return false
    const type = event?.type
    const data = event?.data ?? {}
    const now = this.now()
    let changed = true
    switch (type) {
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.trim() !== '') entry.title = data.title.trim()
        else changed = false
        break
      }
      case 'turn/start': {
        entry.running = true
        entry.lastTool = undefined
        entry.lastOutcome = null
        entry.lastError = undefined
        entry.runStartedAt = typeof event.time === 'number' ? event.time : now
        break
      }
      case 'step/start': {
        entry.lastTool = undefined
        break
      }
      case 'tool/call': {
        const toolName = typeof data.name === 'string' ? data.name : ''
        entry.lastTool = toolName || undefined
        if (toolName === ASK_USER_TOOL) {
          const { kind, text } = classifyQuestionArguments(data.arguments)
          this._beginWait(entry, {
            key: `question:${data.callId ?? stableEventId('question', entry.id, text)}`,
            kind,
            text,
            callId: data.callId,
          })
        }
        break
      }
      case 'tool/result': {
        const callId = data?.message?.toolCallId ?? data?.message?.source?.callId
        if (callId !== undefined && callId !== null) this._endWaitsForCall(entry, callId)
        entry.lastTool = undefined
        break
      }
      case 'approval/asked': {
        this._beginWait(entry, {
          key: `approval:${data.callId ?? data.toolName ?? 'tool'}`,
          kind: 'approval',
          text: typeof data.reason === 'string' ? data.reason : '',
          toolName: typeof data.toolName === 'string' ? data.toolName : undefined,
          callId: data.callId,
          approvalId: data.id,
        })
        break
      }
      case 'approval/decided': {
        this._endApproval(entry, data)
        break
      }
      case 'turn/end': {
        entry.running = false
        entry.lastTool = undefined
        entry.waits.clear()
        const { outcome, error } = outcomeOfTurnEnd(data.reason)
        if (outcome === 'completed') {
          const goalHolds = entry.goal?.phase === 'active' && entry.goal?.activation === 'armed'
          if (!goalHolds) {
            entry.lastOutcome = 'completed'
            entry.lastError = undefined
            this._addUnread(entry, 'completed', {
              id: stableEventId('completed', entry.id, Number.isInteger(data.turn) ? data.turn : 'turn'),
              title: this.strings.text('completedTitle'),
            })
          }
        } else if (outcome === 'failed') {
          entry.lastOutcome = 'failed'
          entry.lastError = error || this.strings.text('failedTitle')
          this._addUnread(entry, 'failed', {
            id: stableEventId('failed', entry.id, Number.isInteger(data.turn) ? data.turn : 'turn'),
            title: this.strings.text('failedTitle'),
          })
        } else {
          entry.lastOutcome = null
          entry.lastError = undefined
        }
        break
      }
      case 'goal/change': {
        // Newer builds also emit the live `goal/changed` host event; accepting
        // the session event keeps the projection correct if that is missed.
        if (data?.operation !== undefined || data?.goal !== undefined) this.goalChanged({ agent: { id: entry.id, session }, change: data })
        changed = false
        break
      }
      default:
        changed = false
    }
    if (changed) {
      entry.updatedAt = now
      this._changed()
    }
    return changed
  }

  /**
   * `goal/changed` payload: `{ agent, change: { operation, ref, goal? } }`.
   * Goal phases decide whether a between-rounds `turn/end` means "finished":
   * an active goal keeps the conversation running; completion or blockage is
   * itself the user-relevant stop.
   * @param {{ agent?: { id?: any, session?: any }, change?: any }} payload
   * @returns {boolean}
   */
  goalChanged(payload) {
    const agent = payload?.agent
    const change = payload?.change
    const entry = this._ensure(agent?.session, agent?.id ?? payload?.sessionId)
    if (entry === undefined || change === undefined) return false
    const now = this.now()
    entry.live = true
    entry.goal = normalizeGoal(change.goal)
    const goal = entry.goal
    switch (change.operation) {
      case 'complete': {
        entry.lastOutcome = 'completed'
        entry.lastError = undefined
        this._addUnread(entry, 'completed', {
          id: stableEventId('goal-completed', entry.id, goal?.id ?? '', goal?.revision ?? ''),
          title: this.strings.text('goalCompletedTitle'),
        })
        break
      }
      case 'block': {
        entry.lastOutcome = 'failed'
        entry.lastError = typeof goal?.blockedReason === 'string' && goal.blockedReason !== ''
          ? goal.blockedReason
          : this.strings.text('goalBlockedTitle')
        this._addUnread(entry, 'failed', {
          id: stableEventId('goal-blocked', entry.id, goal?.id ?? '', goal?.revision ?? ''),
          title: this.strings.text('goalBlockedTitle'),
        })
        break
      }
      case 'pause': {
        entry.lastOutcome = null
        entry.lastError = undefined
        break
      }
      case 'clear': {
        entry.goal = undefined
        break
      }
      default:
        break
    }
    entry.updatedAt = now
    this._changed()
    return true
  }

  /**
   * A `user-questions/request` waterfall listener wants a wait and a possible
   * notification for it.
   * @param {{ agent?: { id?: any, session?: any }, questions?: any[], wait?: { callId?: string } }} request
   * @returns {{ sessionId: string, key: string } | undefined}
   */
  beginQuestionWait(request) {
    const session = request?.agent?.session
    const entry = this._ensure(session, request?.agent?.id)
    if (entry === undefined) return undefined
    const questions = Array.isArray(request?.questions) ? request.questions : []
    const { kind, text } = classifyQuestionItems(questions)
    const callId = request?.wait?.callId
    const key = callId !== undefined && callId !== null
      ? `question:${callId}`
      : `question:${stableEventId('question', entry.id, text)}`
    return this._beginWait(entry, { key, kind, text, callId })
  }

  /**
   * An `approval/request` waterfall listener wants a wait.
   * @param {{ agent?: { id?: any, session?: any }, toolName?: string, callId?: string, reason?: string, displayReason?: Record<string, string> }} request
   * @returns {{ sessionId: string, key: string } | undefined}
   */
  beginApprovalWait(request) {
    const session = request?.agent?.session
    const entry = this._ensure(session, request?.agent?.id)
    if (entry === undefined) return undefined
    const toolName = typeof request?.toolName === 'string' && request.toolName !== '' ? request.toolName : 'tool'
    const key = `approval:${request?.callId ?? toolName}`
    return this._beginWait(entry, {
      key,
      kind: 'approval',
      text: approvalReason(request, this.strings.lang),
      toolName,
      callId: request?.callId,
    })
  }

  /**
   * Settle one wait (idempotent; unknown ids are a no-op).
   * @param {string | number} sessionId
   * @param {string | undefined} key
   * @returns {boolean}
   */
  endWait(sessionId, key) {
    if (sessionId === undefined || sessionId === null || key === undefined) return false
    const entry = this.entries.get(String(sessionId))
    if (entry === undefined || !entry.waits.has(key)) return false
    entry.waits.delete(key)
    entry.updatedAt = this.now()
    this._changed()
    return true
  }

  /**
   * Hand one already-created wait to the caller for delayed publication.
   * Returns the wait identity even when it already existed, so the waterfall
   * listener's `finally` can always settle exactly the wait it observed.
   * @private
   * @returns {{ sessionId: string, key: string } | undefined}
   */
  _beginWait(entry, wait) {
    const now = this.now()
    const existing = entry.waits.get(wait.key)
    if (existing !== undefined) {
      // The same logical wait can be observed twice (e.g. `approval/asked` and
      // the `approval/request` waterfall): upgrade the record, publish once.
      if (typeof wait.text === 'string' && wait.text !== '') existing.text = wait.text
      if (wait.toolName !== undefined) existing.toolName = wait.toolName
      if (wait.callId !== undefined) existing.callId = wait.callId
      if (wait.approvalId !== undefined) existing.approvalId = wait.approvalId
      entry.updatedAt = now
      this._changed()
      return { sessionId: entry.id, key: wait.key }
    }
    for (const other of entry.waits.values()) {
      if (wait.callId !== undefined && other.callId === wait.callId) {
        return { sessionId: entry.id, key: other.key }
      }
    }
    entry.waits.set(wait.key, {
      key: wait.key,
      kind: wait.kind,
      text: typeof wait.text === 'string' ? wait.text : '',
      toolName: wait.toolName,
      callId: wait.callId,
      approvalId: wait.approvalId,
      at: now,
    })
    entry.lastOutcome = null
    entry.lastError = undefined
    entry.updatedAt = now
    const queued = { sessionId: entry.id, key: wait.key }
    this.publicationQueue.push(queued)
    this._changed()
    return queued
  }

  /** @private */
  _endWaitsForCall(entry, callId) {
    let removed = false
    for (const [key, wait] of entry.waits) {
      if (wait.callId === callId) {
        entry.waits.delete(key)
        removed = true
      }
    }
    return removed
  }

  /** @private */
  _endApproval(entry, data) {
    let removed = false
    for (const [key, wait] of entry.waits) {
      if (wait.kind !== 'approval') continue
      const matchId = data?.id !== undefined && wait.approvalId === data.id
      const matchCall = data?.callId !== undefined && wait.callId === data.callId
      const matchTool = data?.callId === undefined && data?.id === undefined
      if (matchId || matchCall || matchTool) {
        entry.waits.delete(key)
        removed = true
      }
    }
    return removed
  }

  /**
   * Publish the delayed "needs attention" notification for a still-pending
   * wait. Called by the Host after ATTENTION_NOTIFY_DELAY_MS so an instantly
   * answered approval/question does not notify.
   * @param {string | number} sessionId
   * @param {string} key
   * @returns {boolean} whether an unread event was added
   */
  publishAttention(sessionId, key) {
    if (sessionId === undefined || sessionId === null) return false
    const entry = this.entries.get(String(sessionId))
    if (entry === undefined) return false
    const wait = entry.waits.get(key)
    if (wait === undefined) return false
    const id = stableEventId('attention', entry.id, wait.kind, key)
    const added = this._addUnread(entry, 'needs-attention', {
      id,
      title: this.strings.text('attentionTitle'),
      createdAt: this.now(),
    })
    if (added) this._changed()
    return added
  }

  /**
   * Drain the queue of waits that the Host should schedule publication for.
   * @returns {Array<{ sessionId: string, key: string }>}
   */
  takePublications() {
    if (this.publicationQueue.length === 0) return []
    const queued = this.publicationQueue
    this.publicationQueue = []
    return queued
  }

  /**
   * Append one unread event (deduplicated by stable id), keeping the ring.
   * @private
   * @returns {boolean}
   */
  _addUnread(entry, kind, options) {
    const id = options?.id
    if (typeof id !== 'string' || id === '' || this.seenUnread.has(id)) return false
    const workspace = safeWorkspace(this.workspaceOf, entry.id)
    const sessionTitle = displayTitle(entry, this.strings)
    const event = {
      id,
      kind,
      sessionId: entry.id,
      workspaceId: typeof workspace?.id === 'string' ? workspace.id : '',
      title: typeof options.title === 'string' ? options.title : '',
      body: composeBody(workspace?.title, sessionTitle),
      createdAt: Number.isFinite(options.createdAt) ? options.createdAt : this.now(),
    }
    this.unread.push(event)
    while (this.unread.length > this.maxUnread) this.unread.shift()
    this.seenUnread.add(id)
    while (this.seenUnread.size > MAX_SEEN_UNREAD_IDS) {
      const oldest = this.seenUnread.values().next().value
      if (oldest === undefined) break
      this.seenUnread.delete(oldest)
    }
    for (const listener of this.unreadListeners) {
      try {
        listener(event)
      } catch {
        // A notification listener must never break the machine.
      }
    }
    return true
  }

  /**
   * Periodic maintenance: drop conversations that are no longer live and no
   * longer interesting. Never removes a live conversation.
   * @returns {boolean} whether anything was removed
   */
  tick() {
    const now = this.now()
    let removed = false
    for (const [key, entry] of this.entries) {
      if (entry.live) continue
      const age = now - (Number.isFinite(entry.updatedAt) ? entry.updatedAt : now)
      const finished = OUTCOME_STATUSES.has(entry.lastOutcome)
      if (finished && age <= this.retentionMs) continue
      // Never-lived entries vanish after one retention window too.
      if (!finished && age <= Math.min(this.retentionMs, 60_000)) continue
      this.entries.delete(key)
      removed = true
    }
    if (removed) this._changed()
    return removed
  }

  /**
   * Projection published in the state file.
   * @returns {Array<{ id: string, title: string, status: string, detail: string, updatedAt: number, startedAt: number }>}
   */
  snapshot() {
    const sessions = []
    for (const entry of this.entries.values()) {
      sessions.push({
        id: entry.id,
        title: displayTitle(entry, this.strings),
        status: resolveStatus(entry),
        detail: describeEntry(entry, this.strings),
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : this.now(),
        startedAt: Number.isFinite(entry.runStartedAt)
          ? entry.runStartedAt
          : (Number.isFinite(entry.startedAt) ? entry.startedAt : entry.createdAt),
      })
    }
    return sessions
  }

  /**
   * Published unread events (newest last).
   * @returns {Array<any>}
   */
  unreadEvents() {
    return this.unread.slice()
  }

  /**
   * Number of tracked conversations (test/diagnostic helper).
   * @returns {number}
   */
  size() {
    return this.entries.size
  }
}

/** @private */
function normalizeGoal(goal) {
  if (goal === undefined || goal === null || typeof goal !== 'object') return undefined
  const phase = typeof goal.phase === 'string' ? goal.phase : 'active'
  const activation = typeof goal.activation === 'string' ? goal.activation : 'armed'
  return {
    id: goal.id === undefined ? '' : String(goal.id),
    revision: Number.isFinite(goal.revision) ? goal.revision : 0,
    phase,
    activation,
    blockedReason: typeof goal.blockedReason?.message === 'string'
      ? goal.blockedReason.message
      : (typeof goal.blockedReason === 'string' ? goal.blockedReason : undefined),
  }
}

/** @private */
function errorText(error) {
  if (error === undefined || error === null) return ''
  if (typeof error === 'string') return clip(error, 120)
  if (typeof error.message === 'string') return clip(error.message, 120)
  if (typeof error.code === 'string') return clip(error.code, 120)
  return ''
}

/** @private */
function safeWorkspace(workspaceOf, sessionId) {
  try {
    const workspace = workspaceOf(sessionId)
    if (workspace === undefined || workspace === null) return undefined
    return {
      id: workspace.id === undefined ? undefined : String(workspace.id),
      title: typeof workspace.title === 'string' ? workspace.title : undefined,
    }
  } catch {
    return undefined
  }
}

export { composeBody as composeNotificationBody }
