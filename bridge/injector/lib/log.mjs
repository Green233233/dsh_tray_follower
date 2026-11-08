// Small bounded file logger for the injector / launcher processes.
//
// The injector runs for a couple of seconds and logs to
// `<dataDir>/injector.log`; the launcher surfaces a message box on failures.

import fs from 'node:fs'
import path from 'node:path'

function safeJson(value) {
  try {
    const seen = new WeakSet()
    const result = JSON.stringify(value, (_key, current) => {
      if (typeof current === 'function') return undefined
      if (typeof current === 'bigint') return String(current)
      if (current instanceof Error) return { message: current.message }
      if (typeof current === 'object' && current !== null) {
        if (seen.has(current)) return '[circular]'
        seen.add(current)
      }
      return current
    })
    return result === undefined ? 'null' : result
  } catch (_error) {
    return '"<unserializable>"'
  }
}

/**
 * @param {{ file: string, maxBytes?: number, echo?: boolean, prefix?: string }} options
 */
export function createFileLogger(options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : ''
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 512 * 1024
  const echo = options.echo === true
  const prefix = typeof options.prefix === 'string' ? options.prefix : ''
  let bytes = -1

  function write(line) {
    if (echo) {
      try {
        console.log(`${prefix}${line}`)
      } catch (_error) {
        /* ignore */
      }
    }
    if (!file) return
    try {
      if (bytes < 0) {
        try {
          bytes = fs.statSync(file).size
        } catch (_error) {
          bytes = 0
        }
      }
      if (bytes > maxBytes) {
        try {
          fs.rmSync(`${file}.1`, { force: true })
        } catch (_error) {
          /* ignore */
        }
        try {
          fs.renameSync(file, `${file}.1`)
        } catch (_error) {
          /* ignore */
        }
        bytes = 0
      }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `${line}\n`, 'utf8')
      bytes += Buffer.byteLength(line) + 1
    } catch (_error) {
      /* logging must never fail the injector */
    }
  }

  return {
    file,
    log(message, data) {
      write(`${new Date().toISOString()} [${process.pid}] ${message}${data === undefined ? '' : ` ${safeJson(data)}`}`)
    },
    error(message, error) {
      write(
        `${new Date().toISOString()} [${process.pid}] ERROR ${message} ${
          error === undefined ? '' : safeJson(error instanceof Error ? { message: error.message, stack: String(error.stack || '').split('\n').slice(0, 5).join('\n') } : error)
        }`.trim()
      )
    }
  }
}
