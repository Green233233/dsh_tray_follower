'use strict'

/**
 * dsh-tray-follower shell bridge hook (CommonJS, Electron main process only).
 *
 * This file is NOT loaded through `NODE_OPTIONS=--require`: packaged Electron
 * rejects NODE_OPTIONS preloads ("Most NODE_OPTIONs are not supported in packaged
 * apps"). It is injected through the Node inspector by `bridge/injector/`:
 *
 *   1. the launcher starts DSH Desktop with `--inspect=127.0.0.1:<port>`;
 *   2. the injector attaches over CDP, evaluates this file's source inside the
 *      Electron main process, and calls `start({ api, env, dataDir, hookDir })`;
 *   3. the returned bridge handle is stored as `globalThis.__DSHTF`, which the
 *      injector uses to adopt the already-created Tray instance and to read
 *      diagnostics.
 *
 * The hook patch is installed as early as possible (before the shell creates its
 * tray), so the shell's original context-menu items are captured from
 * `Tray.prototype.setContextMenu`. Late injection is supported too: the injector
 * adopts the existing tray and the bridge reconstructs equivalent Open/Quit items.
 *
 * Everything is defensive: the hook must never crash DSH.
 */

const path = require('node:path')

const VERSION = '0.1.0'

let cachedElectron = undefined

function loadElectronFromEnvironment() {
  if (cachedElectron !== undefined) return cachedElectron
  let api = null
  try {
    api = require('electron')
  } catch (_error) {
    api = null
  }
  if (!api || typeof api !== 'object' || !api.app) {
    // Defensive fallback: some injection contexts leave `require` on globalThis.
    try {
      const globalRequire = typeof globalThis !== 'undefined' ? globalThis.require : undefined
      if (typeof globalRequire === 'function') {
        const candidate = globalRequire('electron')
        if (candidate && typeof candidate === 'object' && candidate.app) api = candidate
      }
    } catch (_error) {
      /* ignore */
    }
  }
  cachedElectron = api && typeof api === 'object' && api.app ? api : null
  return cachedElectron
}

function failedHandle(error) {
  const message = error instanceof Error ? error.message : String(error)
  const handle = {
    version: VERSION,
    ok: false,
    error: message,
    started: false,
    start: () => handle,
    adopt: () => ({ adopted: false, error: message }),
    diagnostics: () => ({ ok: false, started: false, version: VERSION, error: message }),
    finalize: () => ({ closed: false, error: message }),
    stop: () => ({ ok: false, stopped: false, error: message }),
    pollNow: () => ({ ok: false, error: message }),
    rebuildNow: () => ({ ok: false, error: message })
  }
  try {
    globalThis.__DSHTF = handle
  } catch (_error) {
    /* ignore */
  }
  return handle
}

/**
 * Start the bridge inside the Electron main process.
 *
 * @param {object} [options]
 * @param {object} [options.api] Electron API (normally injected by the injector)
 * @param {object} [options.env] environment (defaults to process.env)
 * @param {string} [options.dataDir] state/log directory override
 * @param {string} [options.hookDir] directory of this hook (for `lib/` resolution)
 * @param {string} [options.version]
 * @param {object} [options.logger]
 * @param {boolean} [options.timers]
 * @returns {object} bridge handle (also stored as `globalThis.__DSHTF`)
 */
function start(options = {}) {
  try {
    const existing = globalThis.__DSHTF
    if (existing && typeof existing.diagnostics === 'function') {
      const diagnostics = existing.diagnostics()
      if (diagnostics && diagnostics.started === true) return existing
    }

    const api =
      options.api && typeof options.api === 'object' && options.api.app ? options.api : loadElectronFromEnvironment()
    if (!api) return failedHandle(new Error('electron API unavailable: not the Electron main process'))
    if (!api.Tray || typeof api.Tray !== 'function') {
      return failedHandle(new Error('electron Tray API unavailable'))
    }
    if (!api.Menu || typeof api.Menu.buildFromTemplate !== 'function') {
      return failedHandle(new Error('electron Menu API unavailable'))
    }

    const env = options.env && typeof options.env === 'object' ? options.env : process.env
    const hookDir = typeof options.hookDir === 'string' && options.hookDir ? options.hookDir : __dirname
    const dataDir = typeof options.dataDir === 'string' && options.dataDir ? options.dataDir : undefined

    const bridgeModule = require(path.join(hookDir, 'lib', 'bridge.cjs'))
    const bridge = bridgeModule.createBridge({
      api,
      env,
      dataDir,
      hookDir,
      version: typeof options.version === 'string' && options.version ? options.version : VERSION,
      testMode: options.testMode,
      timers: options.timers,
      logger: options.logger
    })
    bridge.start()
    try {
      globalThis.__DSHTF = bridge
    } catch (_error) {
      /* ignore */
    }
    return bridge
  } catch (error) {
    return failedHandle(error)
  }
}

module.exports = {
  version: VERSION,
  start,
  diagnostics() {
    try {
      const handle = globalThis.__DSHTF
      return handle && typeof handle.diagnostics === 'function' ? handle.diagnostics() : null
    } catch (_error) {
      return null
    }
  }
}
