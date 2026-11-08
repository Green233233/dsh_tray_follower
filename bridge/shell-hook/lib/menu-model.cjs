'use strict'

const { STATUS_GLYPHS, PENDING_STATUSES, DEFAULT_OPTIONS, LIMITS, stringsFor } = require('./constants.cjs')
const { sanitizeLabel, isPlainObject } = require('./util.cjs')

/**
 * Build the "conversation status" menu section as plain, JSON-serializable
 * descriptors. Keeping the model free of Electron objects makes the tray menu
 * unit-testable without launching the GUI.
 *
 * Behavior is driven by the contract-v2 `options.tray` settings published by the
 * host plugin (v1 state files without `options` behave like the defaults):
 *   - `showIdle === false` (default): idle conversations are NOT rendered at all —
 *     no idle rows and no "空闲会话 (N)" submenu;
 *   - `showIdle === true`: idle sessions are collapsed into one submenu (up to
 *     LIMITS.maxIdleSessionsPerWorkspace rows) instead of inline rows;
 *   - `maxSessionsPerWorkspace` (1..20, default 6) caps the inline active rows
 *     (waiting / running / completed / failed), followed by a disabled
 *     "… 还有 N 个会话" overflow row;
 *   - `showHeaderCounts === false`: the global header omits the counts (`对话`);
 *   - `showFooter === false`: no version footer row.
 *
 * Descriptor shapes:
 *   { kind: 'header', label, enabled: false }
 *   { kind: 'workspace', label, enabled: true, submenu: [descriptor...] }
 *   { kind: 'session', label, enabled: true, focus: true }
 *   { kind: 'idle-group', label, enabled: true, submenu: [descriptor...] }
 *   { kind: 'placeholder', label, enabled: false }
 *   { kind: 'footer', label, enabled: false }
 */

function clampMaxSessionsPerWorkspace(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_OPTIONS.tray.maxSessionsPerWorkspace
  return Math.min(
    LIMITS.maxSessionsPerWorkspaceOption,
    Math.max(LIMITS.minSessionsPerWorkspaceOption, Math.round(parsed))
  )
}

/**
 * Resolve the effective tray settings for this render.
 *
 * `buildStatusSection` options may override the state-published settings (`options.tray`),
 * which keeps the unit tests self-contained; production always uses the state file.
 *
 * @param {object|null} state normalized state
 * @param {object} [options] buildStatusSection options
 * @returns {{showIdle: boolean, maxSessionsPerWorkspace: number, showHeaderCounts: boolean, showFooter: boolean}}
 */
function resolveTraySettings(state, options = {}) {
  const defaults = DEFAULT_OPTIONS.tray
  const published = state && isPlainObject(state.options) && isPlainObject(state.options.tray) ? state.options.tray : null
  const overrides = isPlainObject(options.tray) ? options.tray : null
  const readBoolean = (key) => {
    if (overrides && typeof overrides[key] === 'boolean') return overrides[key]
    if (published && typeof published[key] === 'boolean') return published[key]
    return defaults[key]
  }
  let maxSessionsPerWorkspace = defaults.maxSessionsPerWorkspace
  if (overrides && overrides.maxSessionsPerWorkspace !== undefined) {
    maxSessionsPerWorkspace = clampMaxSessionsPerWorkspace(overrides.maxSessionsPerWorkspace)
  } else if (published && published.maxSessionsPerWorkspace !== undefined) {
    maxSessionsPerWorkspace = clampMaxSessionsPerWorkspace(published.maxSessionsPerWorkspace)
  }
  return {
    showIdle: readBoolean('showIdle'),
    maxSessionsPerWorkspace,
    showHeaderCounts: readBoolean('showHeaderCounts'),
    showFooter: readBoolean('showFooter')
  }
}

/**
 * @param {object|null} state normalized state (see lib/state.cjs) or null when unavailable
 * @param {object} [options]
 * @param {string} [options.version]
 * @param {string} [options.locale] Electron locale (zh* -> Chinese, else English)
 * @param {boolean} [options.asciiFallback] use "workspace " instead of "📁 "
 * @param {boolean} [options.unavailable]
 * @param {object} [options.tray] tray-setting overrides (tests; production reads state)
 * @returns {object[]}
 */
function buildStatusSection(state, options = {}) {
  const version = typeof options.version === 'string' && options.version ? options.version : '0.0.0'
  const strings = stringsFor(options.locale)
  const asciiFallback = options.asciiFallback === true
  const workspacePrefix = asciiFallback ? 'workspace ' : '📁 '
  const unavailable = options.unavailable === true || state === null || state === undefined
  const settings = resolveTraySettings(state, options)
  const stats = state && state.stats && typeof state.stats === 'object' ? state.stats : { running: 0, pending: 0 }
  const running = Number.isFinite(stats.running) ? stats.running : 0
  const pending = Number.isFinite(stats.pending) ? stats.pending : 0

  const headerLabel = settings.showHeaderCounts ? strings.header(running, pending) : strings.headerNoCounts
  const section = [{ kind: 'header', label: headerLabel, enabled: false }]

  if (unavailable) {
    section.push({ kind: 'placeholder', label: strings.waitingState, enabled: false })
  } else if (!Array.isArray(state.workspaces) || state.workspaces.length === 0) {
    section.push({ kind: 'placeholder', label: strings.noWorkspaces, enabled: false })
  } else {
    for (const workspace of state.workspaces) {
      const workspaceTitle = sanitizeLabel(
        workspace.title || workspace.path || workspace.id,
        LIMITS.workspaceTitleChars,
        strings.unknownWorkspace
      )
      const sessions = Array.isArray(workspace.sessions) ? workspace.sessions : []
      const counts = countWorkspaceSessions(sessions)
      const active = []
      const idle = []
      for (const session of sessions) {
        if (!session) continue
        if (session.status === 'idle') idle.push(session)
        else active.push(session)
      }
      active.sort((left, right) => sessionPriority(left.status) - sessionPriority(right.status))
      // Idle history is listed "all of it": newest first (updatedAt desc, then title)
      // and capped only by the hard limit (100), not by a small submenu window.
      idle.sort(compareIdleSessions)
      const visibleActive = active.slice(0, settings.maxSessionsPerWorkspace)
      const workspaceId = typeof workspace.id === 'string' ? workspace.id : ''

      const children = []
      for (const session of visibleActive) {
        const glyph = glyphFor(session.status)
        const sessionTitle = sanitizeLabel(session.title || session.id, LIMITS.sessionTitleChars, strings.unknownSession)
        children.push({
          kind: 'session',
          label: `${glyph} ${sessionTitle}`,
          enabled: true,
          focus: true,
          sessionId: session.id,
          workspaceId
        })
      }
      const hiddenActive = active.length - visibleActive.length
      if (hiddenActive > 0) {
        children.push({ kind: 'placeholder', label: strings.overflow(hiddenActive), enabled: false })
      }

      // Idle history is hidden unless the user explicitly enables it in settings.
      if (settings.showIdle === true && idle.length > 0) {
        const idleRows = []
        const visibleIdle = idle.slice(0, LIMITS.maxIdleSessionsPerWorkspace)
        for (const session of visibleIdle) {
          const idleTitle = sanitizeLabel(session.title || session.id, LIMITS.sessionTitleChars, strings.unknownSession)
          idleRows.push({
            kind: 'session',
            label: `${STATUS_GLYPHS.idle} ${idleTitle}`,
            enabled: true,
            focus: true,
            sessionId: session.id,
            workspaceId
          })
        }
        const hiddenIdle = idle.length - visibleIdle.length
        if (hiddenIdle > 0) {
          idleRows.push({ kind: 'placeholder', label: strings.overflow(hiddenIdle), enabled: false })
        }
        children.push({
          kind: 'idle-group',
          label: strings.idleGroup(idle.length),
          enabled: true,
          submenu: idleRows
        })
      }

      if (children.length === 0) {
        children.push({ kind: 'placeholder', label: strings.noSessions, enabled: false })
      }
      section.push({
        kind: 'workspace',
        label: strings.workspace(workspacePrefix, workspaceTitle, counts.running, counts.pending),
        enabled: true,
        submenu: children
      })
    }
  }

  if (settings.showFooter === true) {
    section.push({ kind: 'footer', label: strings.footer(version), enabled: false })
  }
  return section
}

/** Attention priority: lower first (waiting 0, running 1, completed/failed 2, idle 3). */
function sessionPriority(status) {
  switch (status) {
    case 'waiting-approval':
    case 'waiting-choice':
    case 'waiting-input':
      return 0
    case 'running':
      return 1
    case 'completed':
    case 'failed':
      return 2
    default:
      return 3
  }
}

function glyphFor(status) {
  return STATUS_GLYPHS[status] || STATUS_GLYPHS.idle
}

/** Idle ordering: newest `updatedAt` first, ties broken by title ascending. */
function compareIdleSessions(left, right) {
  const leftUpdated = left && Number.isFinite(left.updatedAt) ? left.updatedAt : 0
  const rightUpdated = right && Number.isFinite(right.updatedAt) ? right.updatedAt : 0
  if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated
  const leftTitle = left && typeof left.title === 'string' ? left.title : ''
  const rightTitle = right && typeof right.title === 'string' ? right.title : ''
  if (leftTitle === rightTitle) return 0
  return leftTitle < rightTitle ? -1 : 1
}

function countWorkspaceSessions(sessions) {
  let running = 0
  let pending = 0
  for (const session of sessions) {
    if (!session) continue
    if (session.status === 'running') running += 1
    else if (PENDING_STATUSES.includes(session.status)) pending += 1
  }
  return { running, pending }
}

/** Stable signature of a status section; used to avoid rebuilding an identical menu. */
function menuSignature(section) {
  try {
    return JSON.stringify(section)
  } catch (_error) {
    return ''
  }
}

/** Plain description of a section for diagnostics (never includes functions). */
function describeSection(section) {
  if (!Array.isArray(section)) return []
  return section.map((item) => {
    if (!item || typeof item !== 'object') return { kind: 'unknown' }
    const description = {
      kind: typeof item.kind === 'string' ? item.kind : 'unknown',
      label: typeof item.label === 'string' ? item.label : '',
      enabled: item.enabled !== false
    }
    if (Array.isArray(item.submenu)) description.submenu = describeSection(item.submenu)
    return description
  })
}

/**
 * Convert the plain status section into Electron `Menu.buildFromTemplate` items.
 * Session rows are clickable and open that conversation when `options.openSession`
 * is provided (falling back to focusing the window); headers, placeholders and the
 * footer stay disabled; workspace and idle-group rows become submenus.
 *
 * @param {object[]} section
 * @param {{focus?: () => void, openSession?: (sessionId: string) => void}} [options]
 */
function toElectronTemplate(section, options = {}) {
  const focus = typeof options.focus === 'function' ? options.focus : () => {}
  const openSession = typeof options.openSession === 'function' ? options.openSession : null
  const mapItem = (item) => {
    if (!item || typeof item !== 'object') return null
    if (item.kind === 'workspace' || item.kind === 'idle-group') {
      const submenu = Array.isArray(item.submenu) ? item.submenu.map(mapItem).filter(Boolean) : []
      return { label: item.label, enabled: item.enabled !== false, submenu }
    }
    if (item.kind === 'session') {
      return {
        label: item.label,
        enabled: item.enabled !== false,
        click: () => {
          try {
            if (openSession && typeof item.sessionId === 'string' && item.sessionId) openSession(item.sessionId)
            else focus()
          } catch (_error) {
            /* never throw from a menu callback */
          }
        }
      }
    }
    return { label: item.label, enabled: item.enabled === true }
  }
  if (!Array.isArray(section)) return []
  return section.map(mapItem).filter(Boolean)
}

module.exports = {
  buildStatusSection,
  menuSignature,
  describeSection,
  toElectronTemplate,
  resolveTraySettings,
  sessionPriority,
  countWorkspaceSessions
}
