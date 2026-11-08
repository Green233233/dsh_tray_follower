// Tray discovery / adoption through the Node inspector.
//
// Tray instances are not enumerable from JS, so the injector uses the V8 heap:
// evaluate `Tray.prototype` to an objectId, `Runtime.queryObjects` to get every
// object with that prototype, then `Runtime.callFunctionOn` on each objectId to
// hand it to the hook (`globalThis.__DSHTF.adopt(tray)`).

import {
  ADOPT_FUNCTION_DECLARATION,
  buildDiagnosticsExpression,
  buildFinalizeExpression,
  buildQuitExpression
} from './bootstrap.mjs'
import { sleep } from './cdp.mjs'

const DEFAULT_OBJECT_GROUP = 'dsh-tray-follower'

/** Read the bridge diagnostics from the injected hook. */
export async function readDiagnostics(client) {
  const result = await client.evaluate(buildDiagnosticsExpression())
  if (!result.ok) return null
  const value = result.value
  return value && typeof value === 'object' ? value : null
}

/**
 * Discover live Tray objects via `Runtime.queryObjects(Tray.prototype)`.
 *
 * @returns {{ok: boolean, count: number, objectIds: string[], error?: string}}
 */
export async function discoverTrays(client, options = {}) {
  const objectGroup = options.objectGroup || DEFAULT_OBJECT_GROUP
  const prototype = await client.evaluateObject("process.mainModule.require('electron').Tray.prototype", { objectGroup })
  if (!prototype.ok || !prototype.objectId) {
    return { ok: false, count: 0, objectIds: [], error: prototype.error || 'Tray.prototype unavailable' }
  }
  const queried = await client.queryObjects(prototype.objectId, objectGroup)
  if (!queried.ok || !queried.objectId) {
    return { ok: false, count: 0, objectIds: [], error: queried.error || 'Runtime.queryObjects failed' }
  }
  const properties = await client.getProperties(queried.objectId)
  if (!properties.ok) {
    return { ok: false, count: 0, objectIds: [], error: properties.error || 'Runtime.getProperties failed' }
  }
  const lengthProperty = properties.properties.find((property) => property && property.name === 'length')
  let count = lengthProperty && lengthProperty.value ? lengthProperty.value.value : 0
  if (!Number.isFinite(count)) {
    count = properties.properties.filter((property) => property && /^\d+$/u.test(property.name)).length
  }
  const objectIds = properties.properties
    .filter((property) => property && /^\d+$/u.test(property.name))
    .map((property) => property.value && property.value.objectId)
    .filter((objectId) => typeof objectId === 'string' && objectId.length > 0)
  return { ok: true, count: Number.isFinite(count) ? count : objectIds.length, objectIds }
}

/**
 * Adopt every discovered Tray into the hook, polling until the hook reports at
 * least one adopted tray (the shell may create the tray slightly after injection).
 *
 * @param {object} client CdpClient
 * @param {object} [options]
 * @returns {Promise<{ok: boolean, count: number, adopted: number, timedOut?: boolean, diagnostics: object|null, elapsedMs: number, error?: string}>}
 */
export async function adoptTrays(client, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 250
  const log = typeof options.log === 'function' ? options.log : () => {}
  const objectGroup = options.objectGroup || DEFAULT_OBJECT_GROUP
  const started = Date.now()
  let lastCount = 0
  let lastAdopted = 0
  let lastDiagnostics = null
  let lastError = null

  while (Date.now() - started < timeoutMs) {
    try {
      const discovery = await discoverTrays(client, { objectGroup })
      if (discovery.ok) {
        lastCount = discovery.count
        let adopted = 0
        for (const objectId of discovery.objectIds) {
          const response = await client.callFunctionOn(objectId, ADOPT_FUNCTION_DECLARATION, {
            returnByValue: true,
            objectGroup
          })
          if (response.ok && response.value && response.value.adopted === true) adopted += 1
        }
        lastAdopted = adopted
      } else {
        lastError = discovery.error || 'tray discovery failed'
      }
      lastDiagnostics = await readDiagnostics(client)
      if (lastDiagnostics && lastDiagnostics.trayAdopted === true) {
        log('trays-adopted', { count: lastCount, adopted: lastAdopted, elapsedMs: Date.now() - started })
        return {
          ok: true,
          count: lastCount,
          adopted: lastAdopted,
          diagnostics: lastDiagnostics,
          elapsedMs: Date.now() - started
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(intervalMs)
  }

  log('trays-adoption-timeout', { count: lastCount, adopted: lastAdopted, timeoutMs, error: lastError, elapsedMs: Date.now() - started })
  return {
    ok: false,
    count: lastCount,
    adopted: lastAdopted,
    timedOut: true,
    diagnostics: lastDiagnostics,
    error: lastError || `no Tray was adopted within ${timeoutMs} ms`,
    elapsedMs: Date.now() - started
  }
}

/** Ask the hook to close the inspector (unless kept). */
export async function finalizeHook(client, options = {}) {
  const result = await client.evaluate(buildFinalizeExpression({ keepInspector: options.keepInspector === true }))
  if (!result.ok) return { ok: false, error: result.error }
  const value = result.value && typeof result.value === 'object' ? result.value : { closed: false }
  return { ok: true, ...value }
}

/** Quit the inspected Electron application through its own API. */
export async function quitInspectedApplication(client) {
  const result = await client.evaluate(buildQuitExpression())
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error }
}
