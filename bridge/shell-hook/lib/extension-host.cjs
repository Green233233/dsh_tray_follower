'use strict'

/**
 * dsh-tray-follower extension host (CommonJS, Electron main process only).
 *
 * The shell bridge already runs inside the DSH Desktop Electron main process
 * (injected through the Node inspector, see `hook.cjs`). This module turns that
 * bridge into a small, safe extension host so other local projects — e.g.
 * `dsh-topbar` — can ship their own main-process hooks without re-implementing
 * the inspector injection/launcher machinery.
 *
 * Extension layout (all under `%LOCALAPPDATA%\dsh-tray-follower\extensions\`):
 *
 *   extensions/
 *     my-extension.cjs                 # loose CommonJS file
 *     dsh-topbar/
 *       manifest.json                  # { "name": "dsh-topbar", "main": "hook.cjs" }
 *       hook.cjs
 *
 * Every extension must export `activate(context)`; it may export
 * `deactivate()`. The context is:
 *
 *   {
 *     api,      // `require('electron')` (Electron main-process API)
 *     app,      // api.app
 *     dataDir,  // %LOCALAPPDATA%\dsh-tray-follower
 *     log(level, event, data), // writes to bridge.log, never throws
 *     now()     // monotonic-enough clock used by the host
 *   }
 *
 * Trust model: extensions are arbitrary local CommonJS code running inside the
 * DSH Electron main process with the user's full privileges. Only install
 * extensions you trust. The bridge never downloads or auto-updates extension
 * code.
 *
 * Failure containment: a broken extension (unreadable manifest, syntax error,
 * throwing `activate`, rejected async `activate`) is reported as
 * `extension-error` and never breaks DSH or the other extensions. `deactivate`
 * runs in reverse load order on `app` `before-quit` and on bridge stop.
 */

const fs = require('node:fs')
const path = require('node:path')

const { describeError, toJsonSafe } = require('./util.cjs')

/** Current extension API version understood by this host. */
const EXTENSION_API_VERSION = 1

/** Directory (inside the bridge data dir) scanned for extensions. */
const EXTENSIONS_DIR_NAME = 'extensions'

/** Manifest file read from extension subdirectories. */
const MANIFEST_FILE = 'manifest.json'

/** Entry point used when a directory manifest does not declare `main`. */
const DEFAULT_ENTRY = 'hook.cjs'

/** Hard cap so a pathological directory cannot slow down DSH startup. */
const MAX_EXTENSIONS = 32

/** Cap for the retained diagnostic error list (the total counter is unbounded). */
const MAX_ERRORS = 20

const MAX_NAME_CHARS = 64

const ENV = Object.freeze({ dataDir: 'DSH_TRAY_FOLLOWER_DIR' })

/** Data directory resolution shared with the bridge (`lib/bridge.cjs`). */
function resolveDataDir(env = process.env) {
  const source = env && typeof env === 'object' ? env : {}
  const override = typeof source[ENV.dataDir] === 'string' ? source[ENV.dataDir].trim() : ''
  if (override) return path.resolve(override)
  const localAppData =
    (typeof source.LOCALAPPDATA === 'string' && source.LOCALAPPDATA) ||
    (typeof source.USERPROFILE === 'string' && source.USERPROFILE
      ? path.join(source.USERPROFILE, 'AppData', 'Local')
      : '')
  if (localAppData) return path.join(localAppData, 'dsh-tray-follower')
  return path.join(require('node:os').tmpdir(), 'dsh-tray-follower')
}

/** Turn an arbitrary manifest/file name into a bounded, log-safe extension id. */
function sanitizeExtensionName(value, fallback = 'extension') {
  const text = typeof value === 'string' ? value.trim() : ''
  const cleaned = text
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+/u, '')
    .replace(/-+$/u, '')
    .slice(0, MAX_NAME_CHARS)
  return cleaned || fallback
}

/** True when `candidate` is a file below `base` (path traversal guard). */
function isInsideDirectory(base, candidate) {
  let relative
  try {
    relative = path.relative(base, candidate)
  } catch (_error) {
    return false
  }
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function safeStatFile(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch (_error) {
    return false
  }
}

/**
 * Create the extension host.
 *
 * @param {object} [options]
 * @param {object} [options.api] Electron module (defaults to `require('electron')`)
 * @param {object} [options.app] Electron app (defaults to `api.app`)
 * @param {string} [options.dataDir] bridge data dir (defaults to the bridge one)
 * @param {object} [options.env] environment for data-dir resolution
 * @param {object} [options.logger] bridge logger (`{log,error,diag}`)
 * @param {() => number} [options.now] clock used for diagnostics
 * @returns {{loadAll: Function, stop: Function, diagnostics: Function, dir: string, dataDir: string}}
 */
function createExtensionHost(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const dataDir = path.resolve(
    typeof options.dataDir === 'string' && options.dataDir ? options.dataDir : resolveDataDir(env)
  )
  let api = options.api && typeof options.api === 'object' ? options.api : null
  if (!api) {
    try {
      api = require('electron')
    } catch (_error) {
      api = null
    }
    if (!api || typeof api !== 'object' || !api.app) {
      // Same defensive fallback as hook.cjs: the inspector context may only
      // expose `process.mainModule.require`.
      try {
        const globalRequire = typeof globalThis !== 'undefined' ? globalThis.require : undefined
        const mainRequire =
          globalRequire && typeof globalRequire === 'function'
            ? globalRequire
            : typeof process !== 'undefined' && process.mainModule && typeof process.mainModule.require === 'function'
              ? process.mainModule.require.bind(process.mainModule)
              : null
        if (mainRequire) {
          const candidate = mainRequire('electron')
          if (candidate && typeof candidate === 'object' && candidate.app) api = candidate
        }
      } catch (_error) {
        api = null
      }
    }
  }
  const app = options.app && typeof options.app === 'object' ? options.app : api ? api.app : null
  const logger = options.logger && typeof options.logger === 'object' ? options.logger : null
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  const state = {
    dir: path.join(dataDir, EXTENSIONS_DIR_NAME),
    exists: false,
    started: false,
    stopped: false,
    scanned: 0,
    loaded: [],
    errors: [],
    errorCount: 0,
    beforeQuitHandler: null
  }

  function logEvent(level, event, data) {
    try {
      const payload = data === undefined ? undefined : toJsonSafe(data)
      if (!logger) return
      if (typeof logger.log === 'function') logger.log(event, payload)
      if (typeof logger.diag === 'function') logger.diag(event, payload)
    } catch (_error) {
      /* logging must never throw into DSH */
    }
  }

  function recordError(name, entry, phase, error) {
    const record = {
      name: name === null || name === undefined ? null : sanitizeExtensionName(name, 'extension'),
      entry: typeof entry === 'string' ? entry : null,
      phase: typeof phase === 'string' ? phase : 'unknown',
      at: now(),
      error: describeError(error)
    }
    state.errors.push(record)
    while (state.errors.length > MAX_ERRORS) state.errors.shift()
    state.errorCount += 1
    logEvent('error', 'extension-error', record)
    return record
  }

  /** `log(level, event, data)` handed to one extension. */
  function createExtensionLog(name) {
    return function extensionLog(level, event, data) {
      try {
        const safeLevel = typeof level === 'string' && level ? level.slice(0, 16) : 'info'
        const safeEvent = typeof event === 'string' && event ? event.slice(0, 64) : 'log'
        const payload = {
          extension: name,
          level: safeLevel,
          event: safeEvent,
          data: data === undefined ? undefined : toJsonSafe(data)
        }
        if (logger && typeof logger.log === 'function') logger.log(`extension:${name}:${safeEvent}`, payload)
        if (logger && typeof logger.diag === 'function') logger.diag('extension-log', payload)
      } catch (_error) {
        /* never throw into the extension caller */
      }
    }
  }

  /**
   * Enumerate loadable extensions. Returns candidates; invalid entries are
   * recorded as `extension-error` and skipped.
   *
   * @returns {Array<{name: string, entry: string, kind: string, manifest: object|null}>}
   */
  function scan() {
    state.dir = path.join(dataDir, EXTENSIONS_DIR_NAME)
    try {
      state.exists = fs.existsSync(state.dir)
    } catch (_error) {
      state.exists = false
    }
    if (!state.exists) return []

    let entries
    try {
      entries = fs.readdirSync(state.dir, { withFileTypes: true })
    } catch (error) {
      recordError(null, state.dir, 'scan', error)
      return []
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

    const candidates = []
    const seenNames = new Set()
    for (const entry of entries) {
      if (candidates.length >= MAX_EXTENSIONS) {
        logEvent('warn', 'extension-limit', { dir: state.dir, limit: MAX_EXTENSIONS })
        break
      }
      const full = path.join(state.dir, entry.name)
      try {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.cjs')) {
          const name = sanitizeExtensionName(entry.name.slice(0, -4), path.basename(entry.name))
          if (seenNames.has(name)) {
            recordError(name, full, 'scan', new Error(`duplicate extension name: ${name}`))
            continue
          }
          seenNames.add(name)
          candidates.push({ name, entry: full, kind: 'file', manifest: null })
          continue
        }
        if (!entry.isDirectory()) continue

        const manifestPath = path.join(full, MANIFEST_FILE)
        if (!fs.existsSync(manifestPath)) continue // not an extension directory
        let manifest
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        } catch (error) {
          recordError(sanitizeExtensionName(entry.name, entry.name), manifestPath, 'manifest', error)
          continue
        }
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
          recordError(
            sanitizeExtensionName(entry.name, entry.name),
            manifestPath,
            'manifest',
            new Error('manifest.json must contain a JSON object')
          )
          continue
        }
        const name = sanitizeExtensionName(manifest.name, sanitizeExtensionName(entry.name, entry.name))
        const main = typeof manifest.main === 'string' && manifest.main.trim() ? manifest.main.trim() : DEFAULT_ENTRY
        const entryPath = path.resolve(full, main)
        if (!isInsideDirectory(full, entryPath)) {
          recordError(name, entryPath, 'manifest', new Error('manifest main entry escapes the extension directory'))
          continue
        }
        if (!safeStatFile(entryPath)) {
          recordError(name, entryPath, 'manifest', new Error(`extension entry not found: ${main}`))
          continue
        }
        if (seenNames.has(name)) {
          recordError(name, full, 'scan', new Error(`duplicate extension name: ${name}`))
          continue
        }
        seenNames.add(name)
        candidates.push({ name, entry: entryPath, kind: 'directory', manifest })
      } catch (error) {
        recordError(sanitizeExtensionName(entry.name, entry.name), full, 'scan', error)
      }
    }
    return candidates
  }

  /** Load and activate one candidate. Never throws. */
  function loadCandidate(candidate, log) {
    try {
      const moduleExports = require(candidate.entry)
      const activateFunction =
        moduleExports && typeof moduleExports.activate === 'function'
          ? moduleExports.activate
          : typeof moduleExports === 'function'
            ? moduleExports
            : null
      if (typeof activateFunction !== 'function') {
        recordError(candidate.name, candidate.entry, 'load', new Error('module.exports.activate is not a function'))
        return
      }
      const context = {
        api,
        app,
        dataDir,
        log,
        now
      }
      let result
      try {
        result = activateFunction(context)
      } catch (error) {
        recordError(candidate.name, candidate.entry, 'activate', error)
        return
      }
      const record = {
        name: candidate.name,
        entry: candidate.entry,
        kind: candidate.kind,
        version:
          candidate.manifest && typeof candidate.manifest.version === 'string' ? candidate.manifest.version : null,
        loadedAt: now(),
        deactivated: false,
        module: moduleExports,
        log
      }
      state.loaded.push(record)
      logEvent('info', 'extension-loaded', {
        name: record.name,
        entry: record.entry,
        kind: record.kind,
        version: record.version,
        apiVersion: EXTENSION_API_VERSION
      })
      if (result && typeof result.then === 'function') {
        result.then(undefined, (error) => {
          recordError(candidate.name, candidate.entry, 'activate-async', error)
        })
      }
    } catch (error) {
      recordError(candidate.name, candidate.entry, 'load', error)
    }
  }

  function removeBeforeQuitListener() {
    try {
      if (state.beforeQuitHandler && app && typeof app.removeListener === 'function') {
        app.removeListener('before-quit', state.beforeQuitHandler)
      }
    } catch (_error) {
      /* ignore */
    }
    state.beforeQuitHandler = null
  }

  function registerBeforeQuitListener() {
    try {
      if (!app || typeof app.on !== 'function') return
      state.beforeQuitHandler = () => {
        try {
          deactivateAll('before-quit')
        } catch (_error) {
          /* never throw from an Electron event handler */
        }
      }
      app.on('before-quit', state.beforeQuitHandler)
    } catch (error) {
      state.beforeQuitHandler = null
      recordError(null, null, 'listener', error)
    }
  }

  /** Deactivate every loaded extension (reverse order). Idempotent. */
  function deactivateAll(reason = 'stop') {
    if (state.stopped) return diagnostics()
    state.stopped = true
    removeBeforeQuitListener()
    for (let index = state.loaded.length - 1; index >= 0; index -= 1) {
      const record = state.loaded[index]
      if (record.deactivated) continue
      record.deactivated = true
      try {
        const moduleExports = record.module
        if (moduleExports && typeof moduleExports.deactivate === 'function') {
          moduleExports.deactivate()
          logEvent('info', 'extension-deactivated', { name: record.name, reason })
        }
      } catch (error) {
        recordError(record.name, record.entry, 'deactivate', error)
      }
    }
    logEvent('info', 'extensions-stopped', {
      reason,
      loaded: state.loaded.length,
      errorCount: state.errorCount
    })
    return diagnostics()
  }

  /** Load every extension once. Idempotent (a second call returns diagnostics). */
  function loadAll() {
    if (state.started) return diagnostics()
    state.started = true
    registerBeforeQuitListener()
    const candidates = scan()
    state.scanned = candidates.length
    for (const candidate of candidates) {
      loadCandidate(candidate, createExtensionLog(candidate.name))
    }
    logEvent('info', 'extensions-scanned', {
      dir: state.dir,
      exists: state.exists,
      scanned: state.scanned,
      loaded: state.loaded.length,
      errorCount: state.errorCount
    })
    return diagnostics()
  }

  function diagnostics() {
    const result = {
      ok: true,
      apiVersion: EXTENSION_API_VERSION,
      dir: state.dir,
      exists: state.exists,
      started: state.started,
      stopped: state.stopped,
      scanned: state.scanned,
      loaded: state.loaded.map((record) => record.name),
      loadedDetails: state.loaded.map((record) => ({
        name: record.name,
        entry: record.entry,
        kind: record.kind,
        version: record.version,
        loadedAt: record.loadedAt,
        deactivated: record.deactivated === true
      })),
      errorCount: state.errorCount,
      errors: state.errors.slice(-5)
    }
    try {
      return toJsonSafe(result)
    } catch (_error) {
      return {
        ok: true,
        apiVersion: EXTENSION_API_VERSION,
        dir: state.dir,
        exists: state.exists,
        started: state.started,
        stopped: state.stopped,
        scanned: state.scanned,
        loaded: [],
        loadedDetails: [],
        errorCount: state.errorCount,
        errors: []
      }
    }
  }

  const handle = {
    loadAll,
    /** Alias named for the bridge lifecycle. */
    stop(reason = 'stop') {
      try {
        return deactivateAll(typeof reason === 'string' && reason ? reason : 'stop')
      } catch (error) {
        recordError(null, null, 'stop', error)
        return diagnostics()
      }
    },
    diagnostics,
    /** Absolute directory scanned for extensions (diagnostics/tests). */
    dir: state.dir,
    dataDir,
    get version() {
      return EXTENSION_API_VERSION
    }
  }
  return handle
}

module.exports = {
  EXTENSION_API_VERSION,
  EXTENSIONS_DIR_NAME,
  MANIFEST_FILE,
  DEFAULT_ENTRY,
  ENV,
  resolveDataDir,
  sanitizeExtensionName,
  isInsideDirectory,
  createExtensionHost
}
