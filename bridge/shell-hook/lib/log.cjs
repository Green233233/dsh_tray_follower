'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { describeError, safeJsonStringify, toJsonSafe } = require('./util.cjs')

/**
 * Bounded append-only logger for the bridge.
 *
 * The logger must never throw and never bring down the Electron main process, so
 * every filesystem interaction is guarded. When the log file grows beyond
 * `maxBytes` it is rotated to `<file>.1` (replacing any previous rotation).
 *
 * In test diagnostics mode (`testMode: true`) `diag(event, data)` writes one
 * JSON object per line, which the E2E probe asserts against.
 */
function createLogger(options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : null
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 1024 * 1024
  const testMode = options.testMode === true
  const echo = typeof options.echo === 'function' ? options.echo : null

  let bytes = -1
  let disabled = false
  let rotateCount = 0

  function ensureParent() {
    if (!file) return false
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      return true
    } catch (_error) {
      disabled = true
      return false
    }
  }

  function rotateIfNeeded() {
    if (!file) return
    if (bytes < 0) {
      try {
        bytes = fs.statSync(file).size
      } catch (_error) {
        bytes = 0
      }
    }
    if (bytes <= maxBytes) return
    try {
      const rotated = `${file}.1`
      try {
        fs.rmSync(rotated, { force: true })
      } catch (_error) {
        /* ignore */
      }
      try {
        fs.renameSync(file, rotated)
        rotateCount += 1
      } catch (_error) {
        /* the file may be locked; keep appending rather than losing the hook */
      }
      bytes = 0
    } catch (_error) {
      /* ignore */
    }
  }

  function writeLine(line) {
    if (!file || disabled) {
      if (echo) {
        try {
          echo(line)
        } catch (_error) {
          /* ignore */
        }
      }
      return
    }
    try {
      rotateIfNeeded()
      const payload = `${line}\n`
      fs.appendFileSync(file, payload)
      bytes += Buffer.byteLength(payload)
      if (echo) {
        try {
          echo(line)
        } catch (_error) {
          /* ignore */
        }
      }
    } catch (_error) {
      disabled = true
    }
  }

  function log(message, data) {
    try {
      const timestamp = new Date().toISOString()
      const suffix = data === undefined ? '' : ` ${safeJsonStringify(toJsonSafe(data))}`
      writeLine(`${timestamp} [${process.pid}] ${message}${suffix}`)
    } catch (_error) {
      /* never throw into DSH */
    }
  }

  function error(message, failure) {
    try {
      log(message, { error: describeError(failure) })
    } catch (_error) {
      /* ignore */
    }
  }

  function diag(event, data) {
    if (!testMode) return
    try {
      const payload = {
        ts: Date.now(),
        iso: new Date().toISOString(),
        type: 'diag',
        event: String(event),
        pid: process.pid,
        data: data === undefined ? null : toJsonSafe(data)
      }
      writeLine(JSON.stringify(payload))
    } catch (_error) {
      /* ignore */
    }
  }

  return {
    file,
    testMode,
    log,
    error,
    diag,
    get filePath() {
      return file
    },
    get rotateCount() {
      return rotateCount
    },
    get disabled() {
      return disabled
    },
    /** Ensure the directory exists (called once during bridge start). */
    init() {
      return file ? ensureParent() : false
    }
  }
}

module.exports = { createLogger }
