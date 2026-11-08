'use strict'

const { describeError } = require('./util.cjs')

/**
 * Main-window discovery / focus helpers.
 *
 * The DSH shell window loads the internal `dsh-app://app/` scheme (the renderer
 * proxies the Host's 127.0.0.1 web server), and the welcome window uses the same
 * custom scheme. Electron dialogs / platform views may also be BrowserWindows, so
 * windows are scored rather than blindly picked by index.
 */

/** Session ids come from the host plugin (`session-<uuid>`); accept any sane token. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId)
}

/** DOM event dispatched in the DSH renderer; the client half listens and navigates. */
const OPEN_SESSION_EVENT = 'dsh-tray-follower:open-session'

/** Build the renderer script that hands the session id to the DSH client half. */
function buildOpenSessionScript(sessionId) {
  return `window.dispatchEvent(new CustomEvent('${OPEN_SESSION_EVENT}', { detail: ${JSON.stringify(sessionId)} }))`
}

/**
 * Score a window URL; higher means "more likely the main application window".
 */
function scoreWindowUrl(url) {
  if (typeof url !== 'string' || url === '') return 0
  if (url.startsWith('dsh-app://')) return 30
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?(\/|$)/u.test(url)) return 20
  if (/^https?:\/\/localhost(:\d+)?(\/|$)/u.test(url)) return 10
  if (url.startsWith('file:')) return 5
  return 1
}

function safeCall(target, method, fallback) {
  try {
    if (target && typeof target[method] === 'function') return target[method]()
  } catch (_error) {
    /* ignore */
  }
  return fallback
}

/**
 * Pick the primary application window from a list of Electron BrowserWindows.
 *
 * @param {object[]} windows
 * @param {{webOrigin?: string}} [options]
 * @returns {{window: object, url: string, score: number, focused: boolean, visible: boolean, minimized: boolean}|null}
 */
function pickPrimaryWindow(windows, options = {}) {
  const list = Array.isArray(windows) ? windows : []
  let origin = ''
  if (typeof options.webOrigin === 'string' && options.webOrigin) {
    try {
      origin = new URL(options.webOrigin).origin
    } catch (_error) {
      origin = ''
    }
  }

  const candidates = []
  for (const window of list) {
    if (!window || typeof window !== 'object') continue
    if (safeCall(window, 'isDestroyed', false) === true) continue
    let url = ''
    try {
      const webContents = window.webContents
      if (webContents && typeof webContents.getURL === 'function') url = String(webContents.getURL() || '')
    } catch (_error) {
      url = ''
    }
    let score = scoreWindowUrl(url)
    if (origin && url.startsWith(`${origin}/`)) score = Math.max(score, 25)
    const focused = safeCall(window, 'isFocused', false) === true
    const minimized = safeCall(window, 'isMinimized', false) === true
    const visible = safeCall(window, 'isVisible', false) === true && !minimized
    if (visible) score += 2
    if (focused) score += 1
    candidates.push({ window, url, score, focused, visible, minimized })
  }
  candidates.sort((left, right) => right.score - left.score)
  return candidates.length > 0 ? candidates[0] : null
}

/**
 * Create helpers bound to the live Electron APIs.
 *
 * @param {object} options
 * @param {object} [options.BrowserWindow] Electron BrowserWindow
 * @param {object} [options.app] Electron app
 * @param {() => string} [options.getWebOrigin] current state webOrigin getter
 * @param {(message: string, data?: object) => void} [options.log]
 */
function createWindowHelper(options = {}) {
  const BrowserWindow = options.BrowserWindow
  const app = options.app
  const log = typeof options.log === 'function' ? options.log : () => {}
  const getWebOrigin = typeof options.getWebOrigin === 'function' ? options.getWebOrigin : () => ''

  function listWindows() {
    try {
      if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return []
      const all = BrowserWindow.getAllWindows()
      if (!Array.isArray(all)) return []
      return all.filter((window) => window && typeof window === 'object' && safeCall(window, 'isDestroyed', false) !== true)
    } catch (error) {
      log('window-list-failed', { error: describeError(error) })
      return []
    }
  }

  /** Current attention state of the application window. */
  function state() {
    const picked = pickPrimaryWindow(listWindows(), { webOrigin: getWebOrigin() })
    if (!picked) return { found: false, focused: false, visible: false, minimized: false, url: '' }
    return {
      found: true,
      focused: picked.focused === true,
      visible: picked.visible === true,
      minimized: picked.minimized === true,
      url: picked.url
    }
  }

  /** Restore (if minimized) -> show (if hidden) -> focus the primary window. */
  function focus() {
    try {
      const picked = pickPrimaryWindow(listWindows(), { webOrigin: getWebOrigin() })
      if (!picked) {
        try {
          if (app && typeof app.focus === 'function') app.focus({ steal: true })
        } catch (_error) {
          /* app.focus may be macOS-only */
        }
        log('window-focus-no-window')
        return { ok: false, reason: 'no-window' }
      }
      const window = picked.window
      const actions = []
      try {
        if (typeof window.isMinimized === 'function' && window.isMinimized() === true) {
          window.restore()
          actions.push('restore')
        }
      } catch (_error) {
        /* ignore */
      }
      try {
        if (typeof window.isVisible === 'function' && window.isVisible() !== true) {
          window.show()
          actions.push('show')
        }
      } catch (_error) {
        /* ignore */
      }
      try {
        window.focus()
        actions.push('focus')
      } catch (_error) {
        /* ignore */
      }
      log('window-focused', { actions, url: picked.url })
      return { ok: true, actions, url: picked.url }
    } catch (error) {
      log('window-focus-failed', { error: describeError(error) })
      return { ok: false, error: describeError(error) }
    }
  }

  /**
   * Open one conversation: restore/focus the primary window, then dispatch the
   * `dsh-tray-follower:open-session` DOM event with the session id. The DSH client
   * half listens for that event and navigates to the conversation.
   *
   * Never throws (it runs from a tray menu callback); invalid ids and missing
   * windows are reported as `{ok:false, reason}` and logged.
   *
   * @param {string} sessionId
   * @returns {{ok: boolean, sessionId?: string, reason?: string, error?: object}}
   */
  function openSession(sessionId) {
    try {
      if (!isValidSessionId(sessionId)) {
        log('window-session-open', { ok: false, reason: 'invalid-session-id', sessionId: String(sessionId) })
        return { ok: false, reason: 'invalid-session-id' }
      }
      const focusResult = focus()
      const picked = pickPrimaryWindow(listWindows(), { webOrigin: getWebOrigin() })
      if (!picked) {
        log('window-session-open', { ok: false, reason: 'no-window', sessionId })
        return { ok: false, reason: 'no-window' }
      }
      const webContents = picked.window.webContents
      if (!webContents || typeof webContents.executeJavaScript !== 'function') {
        log('window-session-open', { ok: false, reason: 'no-web-contents', sessionId, url: picked.url })
        return { ok: false, reason: 'no-web-contents' }
      }
      const script = buildOpenSessionScript(sessionId)
      try {
        const execution = webContents.executeJavaScript(script)
        if (execution && typeof execution.catch === 'function') {
          execution.catch((error) => log('window-session-open-failed', { sessionId, error: describeError(error) }))
        }
      } catch (error) {
        log('window-session-open-failed', { sessionId, error: describeError(error) })
        return { ok: false, reason: 'execute-failed', error: describeError(error) }
      }
      log('window-session-open', {
        ok: true,
        sessionId,
        focused: focusResult.ok === true,
        url: picked.url
      })
      return { ok: true, sessionId }
    } catch (error) {
      log('window-session-open-failed', { sessionId: String(sessionId), error: describeError(error) })
      return { ok: false, reason: 'error', error: describeError(error) }
    }
  }

  return { state, focus, openSession, listWindows, pickPrimaryWindow }
}

module.exports = {
  OPEN_SESSION_EVENT,
  SESSION_ID_PATTERN,
  isValidSessionId,
  buildOpenSessionScript,
  scoreWindowUrl,
  pickPrimaryWindow,
  createWindowHelper
}
