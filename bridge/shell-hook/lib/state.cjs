'use strict'

const fs = require('node:fs')
const path = require('node:path')

const {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  DEFAULT_OPTIONS,
  STATUS_GLYPHS,
  PENDING_STATUSES,
  DEFAULT_STATUS,
  EVENT_KINDS,
  EVENT_KIND_TITLES,
  LIMITS
} = require('./constants.cjs')
const { isPlainObject, cleanText, finiteNumber, nonNegativeInt, countStatuses, describeError } = require('./util.cjs')

const STATE_FILE_NAME = 'state.json'

function pushWarning(warnings, message) {
  if (warnings.length < 20) warnings.push(message)
}

function normalizeStatus(value, warnings, where) {
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(STATUS_GLYPHS, value)) return value
  if (value !== undefined) pushWarning(warnings, `${where}: unknown status ${JSON.stringify(value)} -> ${DEFAULT_STATUS}`)
  return DEFAULT_STATUS
}

function normalizeBooleanOption(value, fallback, warnings, where) {
  if (typeof value === 'boolean') return value
  if (value !== undefined) {
    pushWarning(warnings, `${where}: expected boolean, got ${JSON.stringify(value)} -> ${String(fallback)}`)
  }
  return fallback
}

/**
 * Normalize the contract-v2 settings block.
 *
 * Missing / invalid values always fall back to the strict defaults so an older
 * v1 state file (no `options` at all) behaves exactly like "settings never
 * touched": idle hidden, 6 rows, header counts on, footer on, all notifications on,
 * focused suppression on, sound on.
 *
 * @returns {{tray: object, notifications: object}}
 */
function normalizeOptions(raw, warnings, schemaVersion) {
  const defaults = DEFAULT_OPTIONS
  const options = {
    tray: { ...defaults.tray },
    notifications: { ...defaults.notifications }
  }
  if (!isPlainObject(raw)) {
    if (raw !== undefined || schemaVersion >= 2) {
      pushWarning(warnings, `options missing or invalid for schemaVersion ${String(schemaVersion)}; using defaults`)
    }
    return options
  }
  const traySource = isPlainObject(raw.tray) ? raw.tray : null
  const notificationSource = isPlainObject(raw.notifications) ? raw.notifications : null
  if (!traySource && raw.tray !== undefined) pushWarning(warnings, 'options.tray is not an object; using defaults')
  if (!notificationSource && raw.notifications !== undefined) {
    pushWarning(warnings, 'options.notifications is not an object; using defaults')
  }

  if (traySource) {
    options.tray.showIdle = normalizeBooleanOption(
      traySource.showIdle,
      defaults.tray.showIdle,
      warnings,
      'options.tray.showIdle'
    )
    options.tray.showHeaderCounts = normalizeBooleanOption(
      traySource.showHeaderCounts,
      defaults.tray.showHeaderCounts,
      warnings,
      'options.tray.showHeaderCounts'
    )
    options.tray.showFooter = normalizeBooleanOption(
      traySource.showFooter,
      defaults.tray.showFooter,
      warnings,
      'options.tray.showFooter'
    )
    const rawMax = traySource.maxSessionsPerWorkspace
    if (rawMax !== undefined) {
      const parsed = finiteNumber(rawMax, Number.NaN)
      if (!Number.isFinite(parsed)) {
        pushWarning(
          warnings,
          `options.tray.maxSessionsPerWorkspace: expected number, got ${JSON.stringify(rawMax)} -> ${defaults.tray.maxSessionsPerWorkspace}`
        )
      } else {
        const rounded = Math.round(parsed)
        const clamped = Math.min(
          LIMITS.maxSessionsPerWorkspaceOption,
          Math.max(LIMITS.minSessionsPerWorkspaceOption, rounded)
        )
        if (clamped !== rounded) {
          pushWarning(
            warnings,
            `options.tray.maxSessionsPerWorkspace: clamped ${String(rounded)} -> ${String(clamped)}`
          )
        }
        options.tray.maxSessionsPerWorkspace = clamped
      }
    }
  }

  if (notificationSource) {
    options.notifications.notifyOnCompleted = normalizeBooleanOption(
      notificationSource.notifyOnCompleted,
      defaults.notifications.notifyOnCompleted,
      warnings,
      'options.notifications.notifyOnCompleted'
    )
    options.notifications.notifyOnFailed = normalizeBooleanOption(
      notificationSource.notifyOnFailed,
      defaults.notifications.notifyOnFailed,
      warnings,
      'options.notifications.notifyOnFailed'
    )
    options.notifications.notifyOnAttention = normalizeBooleanOption(
      notificationSource.notifyOnAttention,
      defaults.notifications.notifyOnAttention,
      warnings,
      'options.notifications.notifyOnAttention'
    )
    options.notifications.suppressWhenFocused = normalizeBooleanOption(
      notificationSource.suppressWhenFocused,
      defaults.notifications.suppressWhenFocused,
      warnings,
      'options.notifications.suppressWhenFocused'
    )
    options.notifications.notificationSound = normalizeBooleanOption(
      notificationSource.notificationSound,
      defaults.notifications.notificationSound,
      warnings,
      'options.notifications.notificationSound'
    )
  }

  return options
}

function normalizeSession(raw, workspaceIndex, sessionIndex, warnings) {
  const where = `workspaces[${workspaceIndex}].sessions[${sessionIndex}]`
  if (!isPlainObject(raw)) {
    pushWarning(warnings, `${where}: not an object, skipped`)
    return null
  }
  const idSource = cleanText(raw.id, LIMITS.titleChars * 2)
  const id = idSource || `session-unknown-${workspaceIndex}-${sessionIndex}`
  if (!idSource) pushWarning(warnings, `${where}: missing id, synthesized ${id}`)
  const title = cleanText(raw.title, LIMITS.titleChars * 4)
  return {
    id,
    title,
    status: normalizeStatus(raw.status, warnings, where),
    detail: cleanText(raw.detail, 200),
    updatedAt: finiteNumber(raw.updatedAt, 0),
    startedAt: finiteNumber(raw.startedAt, 0)
  }
}

function normalizeWorkspace(raw, workspaceIndex, warnings) {
  const where = `workspaces[${workspaceIndex}]`
  if (!isPlainObject(raw)) {
    pushWarning(warnings, `${where}: not an object, skipped`)
    return null
  }
  const idSource = cleanText(raw.id, LIMITS.titleChars * 2)
  const id = idSource || `ws-unknown-${workspaceIndex}`
  if (!idSource) pushWarning(warnings, `${where}: missing id, synthesized ${id}`)
  const sessionSource = Array.isArray(raw.sessions) ? raw.sessions : []
  if (!Array.isArray(raw.sessions) && raw.sessions !== undefined) pushWarning(warnings, `${where}: sessions is not an array`)
  const sessions = []
  for (let index = 0; index < Math.min(sessionSource.length, LIMITS.maxSessionsPerWorkspace); index += 1) {
    const session = normalizeSession(sessionSource[index], workspaceIndex, index, warnings)
    if (session) sessions.push(session)
  }
  if (sessionSource.length > LIMITS.maxSessionsPerWorkspace) {
    pushWarning(warnings, `${where}: sessions truncated to ${LIMITS.maxSessionsPerWorkspace}`)
  }
  return {
    id,
    title: cleanText(raw.title, LIMITS.titleChars * 4),
    path: cleanText(raw.path, 512),
    sessions
  }
}

function normalizeEvent(raw, index, warnings) {
  const where = `unreadEvents[${index}]`
  if (!isPlainObject(raw)) {
    pushWarning(warnings, `${where}: not an object, skipped`)
    return null
  }
  const id = cleanText(raw.id, 200)
  if (!id) {
    pushWarning(warnings, `${where}: missing id, skipped`)
    return null
  }
  let kind = typeof raw.kind === 'string' && EVENT_KINDS.includes(raw.kind) ? raw.kind : ''
  if (!kind) {
    kind = 'needs-attention'
    if (raw.kind !== undefined) pushWarning(warnings, `${where}: unknown kind ${JSON.stringify(raw.kind)} -> ${kind}`)
  }
  const title = cleanText(raw.title, LIMITS.titleChars * 2) || EVENT_KIND_TITLES[kind]
  const body = cleanText(raw.body, 300)
  return {
    id,
    kind,
    sessionId: cleanText(raw.sessionId, 200),
    workspaceId: cleanText(raw.workspaceId, 200),
    title,
    body,
    createdAt: finiteNumber(raw.createdAt, 0)
  }
}

/**
 * Validate and normalize a decoded state document.
 *
 * The plugin half owns the contract; this bridge consumes it defensively so a
 * partially written or older/newer state file can never break the tray.
 *
 * @returns {{ok: boolean, state?: object, error?: string, warnings: string[]}}
 */
function normalizeState(raw) {
  const warnings = []
  try {
    if (!isPlainObject(raw)) {
      return { ok: false, error: 'state document is not a JSON object', warnings: ['state document is not a JSON object'] }
    }
    const rawSchemaVersion = raw.schemaVersion
    let schemaVersion = SCHEMA_VERSION
    if (typeof rawSchemaVersion === 'number' && Number.isFinite(rawSchemaVersion)) {
      schemaVersion = Math.floor(rawSchemaVersion)
      if (!SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
        pushWarning(
          warnings,
          `schemaVersion ${String(schemaVersion)} is not one of ${SUPPORTED_SCHEMA_VERSIONS.join('/')}; parsed best-effort with v${SCHEMA_VERSION} defaults`
        )
      }
    } else if (rawSchemaVersion !== undefined) {
      pushWarning(warnings, `schemaVersion ${JSON.stringify(rawSchemaVersion)} is not a number; parsed best-effort`)
    }

    const options = normalizeOptions(raw.options, warnings, schemaVersion)

    const workspaceSource = Array.isArray(raw.workspaces) ? raw.workspaces : []
    if (!Array.isArray(raw.workspaces)) pushWarning(warnings, 'workspaces is not an array')
    const workspaces = []
    for (let index = 0; index < Math.min(workspaceSource.length, LIMITS.maxWorkspaces); index += 1) {
      const workspace = normalizeWorkspace(workspaceSource[index], index, warnings)
      if (workspace) workspaces.push(workspace)
    }
    if (workspaceSource.length > LIMITS.maxWorkspaces) {
      pushWarning(warnings, `workspaces truncated to ${LIMITS.maxWorkspaces}`)
    }

    const eventSource = Array.isArray(raw.unreadEvents) ? raw.unreadEvents : []
    if (!Array.isArray(raw.unreadEvents)) pushWarning(warnings, 'unreadEvents is not an array')
    const trimmedEvents = eventSource.length > LIMITS.maxUnreadEvents ? eventSource.slice(-LIMITS.maxUnreadEvents) : eventSource
    if (eventSource.length > LIMITS.maxUnreadEvents) pushWarning(warnings, `unreadEvents truncated to last ${LIMITS.maxUnreadEvents}`)
    const unreadEvents = []
    for (let index = 0; index < trimmedEvents.length; index += 1) {
      const event = normalizeEvent(trimmedEvents[index], index, warnings)
      if (event) unreadEvents.push(event)
    }

    const allSessions = []
    for (const workspace of workspaces) {
      for (const session of workspace.sessions) allSessions.push(session)
    }
    const statusCounts = countStatuses(allSessions, STATUS_GLYPHS)
    let running = 0
    let pending = 0
    for (const status of Object.keys(STATUS_GLYPHS)) {
      const count = statusCounts[status] || 0
      if (status === 'running') running += count
      if (PENDING_STATUSES.includes(status)) pending += count
    }
    const stats = {
      running,
      pending,
      sessions: allSessions.length,
      workspaces: workspaces.length,
      statusCounts
    }

    return {
      ok: true,
      warnings,
      state: {
        schemaVersion,
        updatedAt: finiteNumber(raw.updatedAt, 0),
        hostPid: nonNegativeInt(raw.hostPid, 0),
        webOrigin: cleanText(raw.webOrigin, 200),
        options,
        workspaces,
        unreadEvents,
        stats
      }
    }
  } catch (error) {
    return { ok: false, error: `state normalization failed: ${describeError(error).message}`, warnings }
  }
}

/** Parse a state document from raw text. */
function parseStateText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: 'state file is empty', warnings: [] }
  }
  let decoded
  try {
    decoded = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `state file is not valid JSON: ${describeError(error).message}`, warnings: [] }
  }
  return normalizeState(decoded)
}

/**
 * Read `<dataDir>/state.json` defensively (missing / oversized / malformed files
 * are reported, never thrown).
 *
 * @returns {{ok: boolean, state?: object, error?: string, missing?: boolean, path: string, bytes?: number, warnings?: string[]}}
 */
function readStateFile(dataDir, fileName = STATE_FILE_NAME) {
  const file = path.join(dataDir, fileName)
  let stat
  try {
    stat = fs.statSync(file)
  } catch (error) {
    const missing = error && error.code === 'ENOENT'
    return { ok: false, missing, error: missing ? 'state file missing' : `state file unreadable: ${describeError(error).message}`, path: file }
  }
  try {
    if (!stat.isFile()) return { ok: false, error: 'state path is not a file', path: file }
    if (stat.size > LIMITS.stateBytes) {
      return { ok: false, error: `state file too large (${stat.size} bytes)`, path: file, bytes: stat.size }
    }
    const text = fs.readFileSync(file, 'utf8')
    const parsed = parseStateText(text)
    return { ...parsed, path: file, bytes: stat.size, mtimeMs: stat.mtimeMs }
  } catch (error) {
    return { ok: false, error: `state file read failed: ${describeError(error).message}`, path: file }
  }
}

module.exports = {
  STATE_FILE_NAME,
  normalizeOptions,
  normalizeState,
  parseStateText,
  readStateFile
}
