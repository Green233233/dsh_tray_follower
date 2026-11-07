/**
 * Debounced, atomic state-file writer.
 *
 * The contract asks for a ≤250 ms coalescing window. `schedule()` stores the
 * newest document and arms one timer; a flush writes with tmp+rename. Failures
 * are logged and swallowed — a write error must never surface in a DSH event
 * listener.
 */
import { writeJsonAtomic } from './atomic-json.js'
import { STATE_DEBOUNCE_MS } from './constants.js'

export class StateWriter {
  /**
   * @param {{
   *   filePath: string,
   *   debounceMs?: number,
   *   write?: (filePath: string, value: unknown) => string,
   *   logger?: { warn?: (...args: any[]) => void },
   *   setTimeoutFn?: typeof setTimeout,
   *   clearTimeoutFn?: typeof clearTimeout,
   * }} options
   */
  constructor(options) {
    if (!options || typeof options.filePath !== 'string' || options.filePath === '') {
      throw new TypeError('StateWriter requires a filePath')
    }
    this.filePath = options.filePath
    this.debounceMs = Number.isFinite(options.debounceMs) && options.debounceMs >= 0
      ? options.debounceMs
      : STATE_DEBOUNCE_MS
    this.write = typeof options.write === 'function' ? options.write : writeJsonAtomic
    this.logger = options.logger
    this.setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : setTimeout
    this.clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : clearTimeout
    /** @type {unknown} */
    this.pending = undefined
    this.hasPending = false
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.timer = undefined
    this.writes = 0
    this.failures = 0
    this.closed = false
  }

  /**
   * Queue one document; repeated calls within the window keep only the newest.
   * @param {unknown} document
   */
  schedule(document) {
    if (this.closed) return
    this.pending = document
    this.hasPending = true
    if (this.timer !== undefined) return
    this.timer = this.setTimeoutFn(() => {
      this.timer = undefined
      this.flush()
    }, this.debounceMs)
    if (typeof this.timer === 'object' && this.timer !== null && typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  /**
   * Write the pending document now (no-op when nothing is queued).
   * @returns {boolean} whether a document was written
   */
  flush() {
    if (this.timer !== undefined) {
      this.clearTimeoutFn(this.timer)
      this.timer = undefined
    }
    if (!this.hasPending) return false
    const document = this.pending
    this.pending = undefined
    this.hasPending = false
    return this._write(document)
  }

  /**
   * Write one document immediately, bypassing (and replacing) the queue.
   * Used for the initial snapshot and the final flush on unload.
   * @param {unknown} document
   * @returns {boolean}
   */
  writeNow(document) {
    if (this.timer !== undefined) {
      this.clearTimeoutFn(this.timer)
      this.timer = undefined
    }
    this.pending = undefined
    this.hasPending = false
    return this._write(document)
  }

  /**
   * Flush anything queued and refuse future writes.
   * @returns {boolean}
   */
  dispose() {
    const written = this.flush()
    this.closed = true
    return written
  }

  /** @private */
  _write(document) {
    try {
      this.write(this.filePath, document)
      this.writes += 1
      return true
    } catch (error) {
      this.failures += 1
      try {
        this.logger?.warn?.('[dsh-tray-follower] state write failed:', error)
      } catch {
        // Logging must not escape either.
      }
      return false
    }
  }
}
