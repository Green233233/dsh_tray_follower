/**
 * Status resolution and menu description for one tracked conversation.
 *
 * The seven contract statuses are derived from a small internal entry shaped
 * by lib/tracker.js:
 *
 *   {
 *     id, title, cwd, createdAt,
 *     live, running, runStartedAt, startedAt,
 *     lastTool,
 *     waits: Map<key, { kind: 'approval'|'choice'|'input', text, toolName?, callId?, at }>,
 *     lastOutcome: 'completed' | 'failed' | null,
 *     lastError,
 *     goal: { id, phase: 'active'|'paused'|'blocked'|'complete', activation } | undefined,
 *     updatedAt,
 *   }
 */
import { clip } from './classify.js'

/**
 * Wait kinds in the order they win over one another.
 * @type {ReadonlyArray<'approval' | 'choice' | 'input'>}
 */
export const WAIT_PRIORITY = Object.freeze(['approval', 'choice', 'input'])

/**
 * Locate the highest-priority pending wait of an entry.
 * @param {{ waits: Map<string, any> }} entry
 * @returns {{ kind: string, text?: string, toolName?: string } | undefined}
 */
export function topWait(entry) {
  const waits = entry?.waits
  if (!(waits instanceof Map) || waits.size === 0) return undefined
  for (const kind of WAIT_PRIORITY) {
    for (const wait of waits.values()) {
      if (wait?.kind === kind) return wait
    }
  }
  // Unknown kind: still counts as waiting for the user.
  return waits.values().next().value
}

/**
 * Is the conversation currently following an armed, active goal? A goal-driven
 * turn closes between rounds; the conversation is not "finished" then.
 * @param {any} entry
 * @returns {boolean}
 */
export function goalRunning(entry) {
  return Boolean(
    entry?.live
    && entry?.goal
    && entry.goal.phase === 'active'
    && entry.goal.activation === 'armed',
  )
}

/**
 * Derive one of `SESSION_STATUSES` from an internal entry.
 * @param {any} entry
 * @returns {'running' | 'waiting-approval' | 'waiting-choice' | 'waiting-input' | 'completed' | 'failed' | 'idle'}
 */
export function resolveStatus(entry) {
  if (!entry) return 'idle'
  const wait = topWait(entry)
  if (wait !== undefined) {
    if (wait.kind === 'approval') return 'waiting-approval'
    if (wait.kind === 'choice') return 'waiting-choice'
    if (wait.kind === 'input') return 'waiting-input'
  }
  if (entry.running) return 'running'
  if (goalRunning(entry)) return 'running'
  if (entry.lastOutcome === 'completed') return 'completed'
  if (entry.lastOutcome === 'failed') return 'failed'
  return 'idle'
}

/**
 * Display title for one entry: the folded session title, else the working
 * directory's last segment, else a neutral placeholder.
 * @param {any} entry
 * @param {{ text: (key: string, params?: Record<string, unknown>) => string }} strings
 * @returns {string}
 */
export function displayTitle(entry, strings) {
  const title = typeof entry?.title === 'string' ? entry.title.trim() : ''
  if (title !== '') return title
  const cwd = typeof entry?.cwd === 'string' ? entry.cwd.trim() : ''
  if (cwd !== '') {
    const segment = cwd.split(/[\\/]+/u).filter(Boolean).pop()
    if (segment) return segment
  }
  return strings.text('untitledSession')
}

/**
 * Human-readable `detail` for a status, shown under the session title.
 * @param {any} entry
 * @param {{ text: (key: string, params?: Record<string, unknown>) => string }} strings
 * @returns {string}
 */
export function describeEntry(entry, strings) {
  const status = resolveStatus(entry)
  switch (status) {
    case 'waiting-approval': {
      const wait = topWait(entry)
      const text = typeof wait?.text === 'string' && wait.text.trim() !== ''
        ? wait.text
        : (wait?.toolName ?? 'tool')
      return strings.text('waitApproval', { tool: clip(text, 60) })
    }
    case 'waiting-choice':
    case 'waiting-input': {
      const wait = topWait(entry)
      const text = typeof wait?.text === 'string' ? wait.text.trim() : ''
      const template = status === 'waiting-choice' ? 'waitChoice' : 'waitInput'
      return text === ''
        ? strings.text('waitGeneric')
        : strings.text(template, { text: clip(text, 60) })
    }
    case 'running':
      if (!entry.running && goalRunning(entry)) return strings.text('detailGoalActive')
      return typeof entry.lastTool === 'string' && entry.lastTool !== ''
        ? strings.text('detailTool', { tool: entry.lastTool })
        : strings.text('detailThinking')
    case 'completed':
      return strings.text('detailCompleted')
    case 'failed':
      return typeof entry.lastError === 'string' && entry.lastError !== ''
        ? clip(entry.lastError, 80)
        : strings.text('detailFailed')
    case 'idle':
    default:
      return strings.text('detailIdle')
  }
}
