/**
 * Pure classification helpers: top-level detection, question classification,
 * approval text, and turn-end outcomes.
 */

const BODY_MAX = 90
const WAIT_TEXT_MAX = 60

/**
 * Flatten whitespace and truncate a string for menu / notification display.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function clip(value, max = BODY_MAX) {
  const flat = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * True for the conversations the tray should show: a session without a header
 * is an independent/in-test Session and counts as top level; subagent children
 * (`delegationDepth > 0` or `origin === 'subagent'`) never do.
 * @param {{ header?: { delegationDepth?: number, origin?: string } } | undefined} session
 * @returns {boolean}
 */
export function isTopLevelSession(session) {
  const header = session?.header
  if (header === undefined || header === null) return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false
  return header.origin !== 'subagent'
}

/**
 * Short human-readable text for one AskUserQuestion item.
 * @param {Array<Record<string, any>>} questions
 * @returns {string}
 */
export function firstQuestionText(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return ''
  const first = questions[0] ?? {}
  const question = typeof first.question === 'string' ? first.question : ''
  const header = typeof first.header === 'string' ? first.header : ''
  if (header && question) return `${header}: ${question}`
  return question || header
}

/**
 * Classify a batch of questions: any options, multi-select, or plan review
 * needs a choice; a free-text-only batch needs typed input.
 * @param {Array<Record<string, any>>} questions
 * @returns {{ kind: 'choice' | 'input', text: string }}
 */
export function classifyQuestionItems(questions) {
  const text = firstQuestionText(questions)
  if (!Array.isArray(questions) || questions.length === 0) return { kind: 'input', text }
  const needsChoice = questions.some((question) => {
    if (!question || typeof question !== 'object') return false
    if (question.intent && typeof question.intent === 'object') return true
    if (question.multiSelect === true) return true
    return Array.isArray(question.options) && question.options.length > 0
  })
  return { kind: needsChoice ? 'choice' : 'input', text }
}

/**
 * Classify the raw `arguments` JSON string of an `ask_user_question` tool call.
 * @param {unknown} argumentsJson
 * @returns {{ kind: 'choice' | 'input', text: string }}
 */
export function classifyQuestionArguments(argumentsJson) {
  if (typeof argumentsJson !== 'string') {
    if (argumentsJson && typeof argumentsJson === 'object') {
      return classifyQuestionItems(/** @type {any} */ (argumentsJson).questions)
    }
    return { kind: 'input', text: '' }
  }
  try {
    const parsed = JSON.parse(argumentsJson)
    return classifyQuestionItems(parsed?.questions)
  } catch {
    return { kind: 'input', text: '' }
  }
}

/**
 * Approval text for a pending request: the localized `displayReason` when the
 * requester supplied one, else the plain reason, else the tool name.
 * @param {{ toolName?: string, reason?: string, displayReason?: Record<string, string> } } request
 * @param {string} [language]
 * @returns {string}
 */
export function approvalReason(request, language = 'en') {
  const display = request?.displayReason
  if (display && typeof display === 'object') {
    const localized = display[language]
    if (typeof localized === 'string' && localized.trim() !== '') return localized
    if (typeof display.en === 'string' && display.en.trim() !== '') return display.en
  }
  const reason = typeof request?.reason === 'string' ? request.reason.trim() : ''
  if (reason !== '') return reason
  const tool = typeof request?.toolName === 'string' && request.toolName !== '' ? request.toolName : 'tool'
  return tool
}

/**
 * Map a `turn/end` reason onto the outcome the tray cares about.
 *
 * `completed` closes one assistant turn: the conversation stopped working.
 * `error` / `max-tokens` / `blocked` are failures. `aborted` is a deliberate
 * user/parent cancellation and `interrupted` is a crash-recovery marker: both
 * return `idle` so they neither notify nor color the tray as a failure.
 * @param {unknown} reason
 * @returns {{ outcome: 'completed' | 'failed' | 'idle', error?: string }}
 */
export function outcomeOfTurnEnd(reason) {
  const kind = reason && typeof reason === 'object' ? reason.kind : undefined
  switch (kind) {
    case 'completed':
      return { outcome: 'completed' }
    case 'error':
      return { outcome: 'failed', error: clip(reason?.error?.message ?? '', 120) }
    case 'max-tokens':
      return { outcome: 'failed', error: 'max-tokens' }
    case 'blocked':
      return { outcome: 'failed', error: 'blocked' }
    case 'aborted':
      return { outcome: 'idle' }
    default:
      return { outcome: 'idle' }
  }
}

/**
 * Clip a wait text for the `detail` field.
 * @param {string} text
 * @returns {string}
 */
export function waitText(text) {
  return clip(text, WAIT_TEXT_MAX)
}

export { BODY_MAX, WAIT_TEXT_MAX }
