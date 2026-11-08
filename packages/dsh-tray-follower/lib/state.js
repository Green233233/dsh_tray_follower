/**
 * State-file contract v2 (docs/DESIGN.md §4): grouping, document building and
 * a strict validator used by the tests (and available to the Host for
 * defensive checks before writing).
 *
 * v2 adds the top-level `options` object: the live settings snapshot the
 * desktop bridge uses to render the tray menu and suppress notifications.
 */
import {
  SCHEMA_VERSION,
  SESSION_STATUSES,
  STATUS_RANK,
  UNASSIGNED_WORKSPACE_ID,
  UNREAD_KINDS,
} from './constants.js'
import {
  MAX_SESSIONS_PER_WORKSPACE_MAX,
  MAX_SESSIONS_PER_WORKSPACE_MIN,
  OPTION_FIELDS,
  OPTION_SECTIONS,
  defaultOptions,
  normalizeOptions,
} from './settings.js'
import { createStrings } from './strings.js'

/**
 * @typedef {{ id: string, title: string, path: string, sessions: any[] }} WorkspaceSection
 * @typedef {{ tray: Record<string, boolean | number>, notifications: Record<string, boolean> }} StateOptions
 * @typedef {{
 *   schemaVersion: number,
 *   updatedAt: number,
 *   hostPid: number,
 *   webOrigin: string,
 *   options: StateOptions,
 *   workspaces: WorkspaceSection[],
 *   unreadEvents: any[],
 * }} StateDocument
 */

/**
 * Group the flat session projection into the per-workspace sections the tray
 * bridge renders. Workspaces keep the registry's durable order; sessions are
 * ordered by urgency then recency.
 * @param {Array<any>} sessions tracker.snapshot() output
 * @param {Array<{ id: string, title?: string, path?: string, sessionIds?: Array<string> }>} workspaces
 * @param {{ text: (key: string, params?: Record<string, unknown>) => string }} [strings]
 * @returns {WorkspaceSection[]}
 */
export function groupSessions(sessions, workspaces, strings = createStrings('en')) {
  const sections = []
  /** @type {Map<string, { id: string, title: string, path: string, sessions: any[] }>} */
  const byWorkspace = new Map()
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    if (!workspace || workspace.id === undefined || workspace.id === null) continue
    const id = String(workspace.id)
    if (byWorkspace.has(id)) continue
    const section = {
      id,
      title: typeof workspace.title === 'string' && workspace.title !== ''
        ? workspace.title
        : (typeof workspace.path === 'string' ? workspace.path : id),
      path: typeof workspace.path === 'string' ? workspace.path : '',
      sessions: [],
    }
    byWorkspace.set(id, section)
    sections.push(section)
  }

  /** @type {Map<string, string>} sessionId -> workspaceId */
  const owner = new Map()
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    if (!workspace || workspace.id === undefined || workspace.id === null) continue
    const workspaceId = String(workspace.id)
    for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
      if (sessionId === undefined || sessionId === null) continue
      if (!owner.has(String(sessionId))) owner.set(String(sessionId), workspaceId)
    }
  }

  const orphaned = []
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || session.id === undefined) continue
    const workspaceId = owner.get(String(session.id))
    const section = workspaceId === undefined ? undefined : byWorkspace.get(workspaceId)
    if (section === undefined) orphaned.push(session)
    else section.sessions.push(session)
  }

  for (const section of sections) section.sessions.sort(compareSessions)
  const populated = sections.filter((section) => section.sessions.length > 0)
  if (orphaned.length > 0) {
    populated.push({
      id: UNASSIGNED_WORKSPACE_ID,
      title: strings.text('otherConversations'),
      path: '',
      sessions: orphaned.sort(compareSessions),
    })
  }
  return populated
}

/**
 * Menu order: waiting > running > failed > completed > idle, then newest.
 * @param {any} left
 * @param {any} right
 * @returns {number}
 */
export function compareSessions(left, right) {
  const rankLeft = STATUS_RANK[left?.status] ?? 99
  const rankRight = STATUS_RANK[right?.status] ?? 99
  if (rankLeft !== rankRight) return rankLeft - rankRight
  const updatedLeft = Number.isFinite(left?.updatedAt) ? left.updatedAt : 0
  const updatedRight = Number.isFinite(right?.updatedAt) ? right.updatedAt : 0
  if (updatedLeft !== updatedRight) return updatedRight - updatedLeft
  return String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
}

/**
 * Build the complete state document written to `<dataDir>/state.json`.
 * @param {{
 *   tracker: { snapshot: () => any[], unreadEvents: () => any[] },
 *   workspaces?: Array<{ id: string, title?: string, path?: string, sessionIds?: Array<string> }>,
 *   webOrigin?: string,
 *   hostPid?: number,
 *   now?: number,
 *   strings?: { text: (key: string, params?: Record<string, unknown>) => string },
 *   options?: StateOptions,
 * }} input
 * @returns {StateDocument}
 */
export function buildStateDocument(input) {
  const now = Number.isFinite(input?.now) ? input.now : Date.now()
  const sessions = input?.tracker?.snapshot?.() ?? []
  const unreadEvents = input?.tracker?.unreadEvents?.() ?? []
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now,
    hostPid: Number.isInteger(input?.hostPid) ? input.hostPid : process.pid,
    webOrigin: typeof input?.webOrigin === 'string' ? input.webOrigin : '',
    options: input?.options === undefined ? defaultOptions() : normalizeOptions(input.options),
    workspaces: groupSessions(sessions, input?.workspaces ?? [], input?.strings),
    unreadEvents: unreadEvents.map((event) => ({
      id: event.id,
      kind: event.kind,
      sessionId: event.sessionId,
      workspaceId: event.workspaceId,
      title: event.title,
      body: event.body,
      createdAt: event.createdAt,
    })),
  }
}

/**
 * Strict validator for the published contract. Returns every problem instead of
 * throwing so a test can report all of them at once.
 * @param {unknown} document
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateStateDocument(document) {
  /** @type {string[]} */
  const errors = []
  const push = (message) => errors.push(message)
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, errors: ['document must be an object'] }
  }
  const doc = /** @type {any} */ (document)
  if (doc.schemaVersion !== SCHEMA_VERSION) push(`schemaVersion must be ${SCHEMA_VERSION}`)
  if (!Number.isFinite(doc.updatedAt)) push('updatedAt must be a finite number')
  if (!Number.isInteger(doc.hostPid) || doc.hostPid <= 0) push('hostPid must be a positive integer')
  if (typeof doc.webOrigin !== 'string') push('webOrigin must be a string')
  else if (doc.webOrigin !== '' && !/^https?:\/\//u.test(doc.webOrigin)) push('webOrigin must be empty or an http(s) URL')
  if (doc.options === null || typeof doc.options !== 'object' || Array.isArray(doc.options)) {
    push('options must be an object')
  } else {
    for (const section of OPTION_SECTIONS) {
      const values = doc.options[section]
      if (values === null || typeof values !== 'object' || Array.isArray(values)) {
        push(`options.${section} must be an object`)
        continue
      }
      for (const field of OPTION_FIELDS[section]) {
        const value = values[field]
        if (field === 'maxSessionsPerWorkspace') {
          if (!Number.isInteger(value)
            || value < MAX_SESSIONS_PER_WORKSPACE_MIN
            || value > MAX_SESSIONS_PER_WORKSPACE_MAX) {
            push(`options.${section}.${field} must be an integer between ${MAX_SESSIONS_PER_WORKSPACE_MIN} and ${MAX_SESSIONS_PER_WORKSPACE_MAX}`)
          }
        } else if (typeof value !== 'boolean') {
          push(`options.${section}.${field} must be a boolean`)
        }
      }
    }
  }
  if (!Array.isArray(doc.workspaces)) {
    push('workspaces must be an array')
    return { ok: errors.length === 0, errors }
  }
  const seenWorkspaceIds = new Set()
  for (const [index, workspace] of doc.workspaces.entries()) {
    const where = `workspaces[${index}]`
    if (workspace === null || typeof workspace !== 'object') {
      push(`${where} must be an object`)
      continue
    }
    if (typeof workspace.id !== 'string' || workspace.id === '') push(`${where}.id must be a non-empty string`)
    else if (seenWorkspaceIds.has(workspace.id)) push(`${where}.id duplicated: ${workspace.id}`)
    else seenWorkspaceIds.add(workspace.id)
    if (typeof workspace.title !== 'string') push(`${where}.title must be a string`)
    if (typeof workspace.path !== 'string') push(`${where}.path must be a string`)
    if (!Array.isArray(workspace.sessions)) {
      push(`${where}.sessions must be an array`)
      continue
    }
    const seenSessionIds = new Set()
    for (const [sessionIndex, session] of workspace.sessions.entries()) {
      const sessionWhere = `${where}.sessions[${sessionIndex}]`
      if (session === null || typeof session !== 'object') {
        push(`${sessionWhere} must be an object`)
        continue
      }
      if (typeof session.id !== 'string' || session.id === '') push(`${sessionWhere}.id must be a non-empty string`)
      else if (seenSessionIds.has(session.id)) push(`${sessionWhere}.id duplicated: ${session.id}`)
      else seenSessionIds.add(session.id)
      if (typeof session.title !== 'string') push(`${sessionWhere}.title must be a string`)
      if (!SESSION_STATUSES.includes(session.status)) push(`${sessionWhere}.status is not a contract status: ${String(session.status)}`)
      if (typeof session.detail !== 'string') push(`${sessionWhere}.detail must be a string`)
      if (!Number.isFinite(session.updatedAt)) push(`${sessionWhere}.updatedAt must be a finite number`)
      if (!Number.isFinite(session.startedAt)) push(`${sessionWhere}.startedAt must be a finite number`)
    }
  }
  if (!Array.isArray(doc.unreadEvents)) {
    push('unreadEvents must be an array')
    return { ok: errors.length === 0, errors }
  }
  const seenEventIds = new Set()
  for (const [index, event] of doc.unreadEvents.entries()) {
    const where = `unreadEvents[${index}]`
    if (event === null || typeof event !== 'object') {
      push(`${where} must be an object`)
      continue
    }
    if (typeof event.id !== 'string' || !event.id.startsWith('evt_')) push(`${where}.id must be an evt_* string`)
    else if (seenEventIds.has(event.id)) push(`${where}.id duplicated: ${event.id}`)
    else seenEventIds.add(event.id)
    if (!UNREAD_KINDS.includes(event.kind)) push(`${where}.kind is not a contract kind: ${String(event.kind)}`)
    if (typeof event.sessionId !== 'string') push(`${where}.sessionId must be a string`)
    if (typeof event.workspaceId !== 'string') push(`${where}.workspaceId must be a string`)
    if (typeof event.title !== 'string') push(`${where}.title must be a string`)
    if (typeof event.body !== 'string') push(`${where}.body must be a string`)
    if (!Number.isFinite(event.createdAt)) push(`${where}.createdAt must be a finite number`)
  }
  return { ok: errors.length === 0, errors }
}
