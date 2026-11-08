// Minimal Chrome DevTools Protocol client for the Node inspector.
//
// Uses Node 24's global `WebSocket`/`fetch` — no dependencies. Only the commands
// needed by the injector are wrapped; everything else goes through `call()`.

import { setTimeout as sleep } from 'node:timers/promises'

/** Fetch JSON with a hard timeout; never throws. */
export async function getJson(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 2000
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    return { ok: true, value: await response.json() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Pick the Node inspector target from a `/json/list` response. */
export function pickInspectorTarget(targets) {
  if (!Array.isArray(targets)) return null
  const candidates = targets.filter(
    (target) =>
      target &&
      typeof target === 'object' &&
      typeof target.webSocketDebuggerUrl === 'string' &&
      target.webSocketDebuggerUrl.startsWith('ws://')
  )
  return candidates.find((target) => target.type === 'node') || candidates[0] || null
}

/**
 * Poll the inspector endpoint until a target with a websocket URL appears.
 *
 * @param {object} options
 * @param {number} options.port
 * @param {string} [options.host]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.intervalMs]
 * @param {() => boolean} [options.isProcessAlive]
 * @param {(message: string, data?: object) => void} [options.log]
 */
export async function waitForInspectorTarget(options = {}) {
  const host = typeof options.host === 'string' && options.host ? options.host : '127.0.0.1'
  const port = options.port
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 100
  const isProcessAlive = typeof options.isProcessAlive === 'function' ? options.isProcessAlive : () => true
  const log = typeof options.log === 'function' ? options.log : () => {}
  const started = Date.now()
  let attempts = 0
  let lastError = null

  while (Date.now() - started < timeoutMs) {
    attempts += 1
    if (isProcessAlive() !== true) {
      return {
        ok: false,
        stage: 'inspector',
        error: 'DSH process exited before the inspector endpoint became available',
        attempts,
        elapsedMs: Date.now() - started
      }
    }
    const response = await getJson(`http://${host}:${port}/json/list`, { timeoutMs: 1000 })
    if (response.ok) {
      const target = pickInspectorTarget(response.value)
      if (target) {
        return {
          ok: true,
          target,
          url: target.webSocketDebuggerUrl,
          attempts,
          elapsedMs: Date.now() - started,
          port,
          host
        }
      }
      lastError = 'inspector listed no target with a webSocketDebuggerUrl'
    } else {
      lastError = response.error
    }
    await sleep(intervalMs)
  }
  const message = `inspector endpoint 127.0.0.1:${port} never appeared (${lastError || 'timeout'})`
  log('wait-for-inspector-timeout', { port, timeoutMs, attempts, error: message })
  return { ok: false, stage: 'inspector', error: message, attempts, elapsedMs: Date.now() - started }
}

/** Readiness probe evaluated in the target runtime. */
export const READINESS_EXPRESSION = `(() => {
  try {
    const p = typeof process !== 'undefined' ? process : null
    return {
      hasProcess: !!p,
      hasMainModule: !!(p && p.mainModule),
      hasRequire: !!(p && p.mainModule && typeof p.mainModule.require === 'function'),
      hasElectron: !!(p && p.versions && p.versions.electron),
      electron: p && p.versions ? (p.versions.electron || null) : null,
      node: p && p.versions ? (p.versions.node || null) : null,
      processType: p ? (p.type || null) : null,
      platform: p ? (p.platform || null) : null,
      pid: p ? (p.pid || null) : null
    }
  } catch (error) {
    return { error: String((error && error.message) || error) }
  }
})()`

/**
 * Wait until the evaluated runtime exposes `process.mainModule.require` (the only
 * bridge into the Electron API from the inspector evaluation context).
 */
export async function waitForMainModule(client, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 100
  const log = typeof options.log === 'function' ? options.log : () => {}
  const started = Date.now()
  let attempts = 0
  let lastValue = null

  while (Date.now() - started < timeoutMs) {
    attempts += 1
    const result = await client.evaluate(READINESS_EXPRESSION)
    if (result.ok) {
      lastValue = result.value
      if (
        lastValue &&
        lastValue.hasMainModule === true &&
        lastValue.hasRequire === true &&
        lastValue.hasElectron === true &&
        lastValue.processType === 'browser'
      ) {
        return { ok: true, value: lastValue, attempts, elapsedMs: Date.now() - started }
      }
    }
    await sleep(intervalMs)
  }
  log('wait-for-main-module-timeout', { timeoutMs, attempts, lastValue })
  return {
    ok: false,
    stage: 'ready',
    error: `process.mainModule.require never became available (${timeoutMs} ms)`,
    value: lastValue,
    attempts,
    elapsedMs: Date.now() - started
  }
}

/** Unwrap a `Runtime.evaluate` response. */
function unwrapEvaluate(response) {
  if (!response || typeof response !== 'object') return { ok: false, error: 'empty Runtime.evaluate response' }
  if (response.exceptionDetails) {
    return {
      ok: false,
      error: response.exceptionDetails.text || 'evaluation threw',
      detail: response.exceptionDetails.exception ? response.exceptionDetails.exception.description : undefined
    }
  }
  const result = response.result || {}
  return { ok: true, value: result.value, objectId: result.objectId, type: result.type }
}

/** Chrome DevTools Protocol websocket client. */
export class CdpClient {
  constructor(webSocket) {
    this.ws = webSocket
    this.nextId = 0
    this.pending = new Map()
    this.handlers = new Map()
    this.closed = false
    webSocket.addEventListener('message', (event) => this.#handleMessage(event))
    webSocket.addEventListener('close', () => {
      this.closed = true
      for (const entry of this.pending.values()) {
        try {
          entry.reject(new Error('CDP connection closed'))
        } catch (_error) {
          /* ignore */
        }
      }
      this.pending.clear()
    })
    webSocket.addEventListener('error', () => {
      // Errors surface through the pending call timeouts / close handler.
    })
  }

  static async connect(webSocketUrl, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000
    const ws = new WebSocket(webSocketUrl)
    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback(value)
      }
      const timer = setTimeout(() => finish(reject, new Error(`CDP connection timeout after ${timeoutMs} ms`)), timeoutMs)
      ws.addEventListener('open', () => finish(resolve), { once: true })
      ws.addEventListener('error', () => finish(reject, new Error('CDP websocket error')), { once: true })
    })
    return new CdpClient(ws)
  }

  on(method, handler) {
    if (typeof handler !== 'function') return () => {}
    if (!this.handlers.has(method)) this.handlers.set(method, new Set())
    this.handlers.get(method).add(handler)
    return () => {
      const set = this.handlers.get(method)
      if (set) set.delete(handler)
    }
  }

  #handleMessage(event) {
    let payload
    try {
      const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')
      payload = JSON.parse(raw)
    } catch (_error) {
      return
    }
    if (!payload || typeof payload !== 'object') return
    if (payload.id !== undefined) {
      const entry = this.pending.get(payload.id)
      if (!entry) return
      this.pending.delete(payload.id)
      if (payload.error) entry.reject(new Error(JSON.stringify(payload.error)))
      else entry.resolve(payload.result)
      return
    }
    if (typeof payload.method === 'string') {
      const handlers = this.handlers.get(payload.method)
      if (!handlers) return
      for (const handler of handlers) {
        try {
          handler(payload.params, payload)
        } catch (_error) {
          /* ignore handler failures */
        }
      }
    }
  }

  call(method, params = {}, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
    if (this.closed) return Promise.reject(new Error('CDP connection is closed'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Runtime.evaluate returning a by-value result (objectIds are dropped). */
  async evaluate(expression, params = {}, options = {}) {
    try {
      const response = await this.call(
        'Runtime.evaluate',
        {
          expression: String(expression),
          returnByValue: true,
          awaitPromise: false,
          includeCommandLineAPI: true,
          ...params
        },
        options
      )
      return unwrapEvaluate(response)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Runtime.evaluate keeping the result object alive (for queryObjects). */
  async evaluateObject(expression, params = {}, options = {}) {
    try {
      const response = await this.call(
        'Runtime.evaluate',
        {
          expression: String(expression),
          returnByValue: false,
          awaitPromise: false,
          includeCommandLineAPI: true,
          ...params
        },
        options
      )
      const unwrapped = unwrapEvaluate(response)
      return unwrapped
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async queryObjects(prototypeObjectId, objectGroup = 'dsh-tray-follower') {
    try {
      const response = await this.call('Runtime.queryObjects', { prototypeObjectId, objectGroup })
      return { ok: true, objectId: response && response.objects ? response.objects.objectId : undefined, result: response }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async getProperties(objectId, options = {}) {
    try {
      const response = await this.call('Runtime.getProperties', {
        objectId,
        ownProperties: true,
        accessorPropertiesOnly: false,
        generatePreview: false,
        ...options
      })
      return { ok: true, properties: Array.isArray(response && response.result) ? response.result : [] }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async callFunctionOn(objectId, functionDeclaration, options = {}) {
    try {
      const response = await this.call('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: String(functionDeclaration),
        returnByValue: options.returnByValue !== false,
        awaitPromise: false,
        objectGroup: options.objectGroup || 'dsh-tray-follower',
        silent: options.silent === true
      })
      return unwrapEvaluate(response)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async releaseObjectGroup(objectGroup = 'dsh-tray-follower') {
    try {
      await this.call('Runtime.releaseObjectGroup', { objectGroup })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  close() {
    try {
      if (!this.closed) this.ws.close()
    } catch (_error) {
      /* ignore */
    }
    this.closed = true
  }
}

export { sleep }
