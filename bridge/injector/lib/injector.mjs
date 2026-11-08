// Highest-level injector: attach to a DSH Desktop Electron main process that was
// launched with `--inspect=127.0.0.1:<port>` and install the shell hook.

import fs from 'node:fs'
import path from 'node:path'

import { buildBootstrapExpression } from './bootstrap.mjs'
import { adoptTrays, finalizeHook, readDiagnostics } from './trays.mjs'
import { waitForInspectorTarget, waitForMainModule, CdpClient } from './cdp.mjs'

/**
 * @param {object} options
 * @param {number} options.port inspector port
 * @param {string} options.hookPath absolute path of hook.cjs
 * @param {string} [options.hookDir] defaults to dirname(hookPath)
 * @param {string} [options.dataDir] bridge data dir (passed to the hook)
 * @param {string} [options.hookSource] preloaded hook source (read from disk when omitted)
 * @param {number} [options.timeoutMs] inspector/mainModule timeout
 * @param {number} [options.adoptTimeoutMs] tray adoption timeout
 * @param {number} [options.intervalMs] poll interval
 * @param {boolean} [options.keepInspector] keep the inspector open (test probes)
 * @param {boolean} [options.injectOnly] skip tray adoption/finalize
 * @param {() => boolean} [options.isProcessAlive]
 * @param {(message: string, data?: object) => void} [options.log]
 * @returns {Promise<object>} structured result (never throws)
 */
export async function injectIntoTarget(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const started = Date.now()
  const result = {
    ok: false,
    stage: 'init',
    port: options.port,
    hookPath: options.hookPath,
    dataDir: options.dataDir,
    target: null,
    readiness: null,
    injected: null,
    diagnostics: null,
    trays: null,
    finalized: null,
    timings: {},
    errors: []
  }
  const finish = (stage) => {
    result.stage = stage
    result.timings.totalMs = Date.now() - started
    return result
  }
  const failAt = (stage, error) => {
    result.errors.push(String(error || 'unknown error'))
    log(`${stage}-failed`, { error: String(error || 'unknown error') })
    return finish(stage)
  }

  let client = null
  try {
    result.stage = 'inspector'
    const inspector = await waitForInspectorTarget({
      port: options.port,
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
      isProcessAlive: options.isProcessAlive,
      log
    })
    result.timings.inspectorMs = inspector.elapsedMs
    if (!inspector.ok) return failAt('inspector', inspector.error)
    result.target = { url: inspector.url, attempts: inspector.attempts }
    log('inspector-target', { url: inspector.url, elapsedMs: inspector.elapsedMs })

    client = await CdpClient.connect(inspector.url, { timeoutMs: 8000 })
    await client.call('Runtime.enable', {}, { timeoutMs: 5000 })
    result.stage = 'ready'
    const ready = await waitForMainModule(client, {
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
      log
    })
    result.readiness = ready.value || null
    result.timings.readyMs = ready.elapsedMs
    if (!ready.ok) return failAt('ready', ready.error)
    log('target-ready', ready.value)

    result.stage = 'inject'
    let hookSource = options.hookSource
    if (typeof hookSource !== 'string' || hookSource === '') {
      hookSource = fs.readFileSync(options.hookPath, 'utf8')
    }
    const hookDir = options.hookDir || path.dirname(options.hookPath)
    const expression = buildBootstrapExpression({
      hookSource,
      hookPath: options.hookPath,
      hookDir,
      dataDir: options.dataDir,
      version: options.version
    })
    const injected = await client.evaluate(expression, {}, { timeoutMs: 30000 })
    result.injected = injected.ok ? injected.value : { ok: false, error: injected.error, detail: injected.detail }
    result.timings.injectMs = Date.now() - started - (result.timings.inspectorMs || 0) - (result.timings.readyMs || 0)
    if (!injected.ok || !result.injected || result.injected.ok !== true) {
      return failAt('inject', (result.injected && result.injected.error) || injected.error || 'bootstrap evaluation failed')
    }
    log('hook-injected', { hookPath: options.hookPath, result: result.injected })

    result.stage = 'diagnostics'
    result.diagnostics = await readDiagnostics(client)
    if (!result.diagnostics || result.diagnostics.patched !== true) {
      return failAt('diagnostics', 'hook did not report a patched Tray.prototype')
    }

    if (options.injectOnly === true) {
      result.ok = true
      return finish('injected')
    }

    result.stage = 'adopt-trays'
    result.trays = await adoptTrays(client, {
      timeoutMs: options.adoptTimeoutMs,
      intervalMs: options.intervalMs,
      log
    })
    result.timings.adoptMs = result.trays.elapsedMs
    if (result.trays.diagnostics) result.diagnostics = result.trays.diagnostics

    if (options.keepInspector !== true) {
      result.stage = 'finalize'
      result.finalized = await finalizeHook(client)
      log('hook-finalized', result.finalized)
    } else {
      result.finalized = { closed: false, kept: true }
    }

    result.ok = result.diagnostics ? result.diagnostics.patched === true : false
    return finish(result.ok ? 'done' : 'adopt-trays')
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error))
    log('injector-failed', { stage: result.stage, error: result.errors[result.errors.length - 1] })
    return finish(result.stage)
  } finally {
    try {
      if (client) {
        await client.releaseObjectGroup().catch(() => undefined)
        client.close()
      }
    } catch (_error) {
      /* ignore */
    }
    result.timings.totalMs = Date.now() - started
  }
}

/** Convenience wrapper for the E2E probe: also quits the target. */
export async function injectAndQuit(options = {}) {
  const result = await injectIntoTarget(options)
  if (!options.quitPort) return result
  try {
    const inspector = await waitForInspectorTarget({ port: options.quitPort, timeoutMs: 5000, intervalMs: 100 })
    if (!inspector.ok) return result
    const client = await CdpClient.connect(inspector.url, { timeoutMs: 5000 })
    try {
      await client.call('Runtime.enable', {}, { timeoutMs: 5000 })
      const ready = await waitForMainModule(client, { timeoutMs: 5000, intervalMs: 100 })
      if (ready.ok) {
        const { quitInspectedApplication } = await import('./trays.mjs')
        result.quit = await quitInspectedApplication(client)
      }
    } finally {
      client.close()
    }
  } catch (error) {
    result.quit = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return result
}
