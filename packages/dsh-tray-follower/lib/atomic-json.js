/**
 * Atomic JSON writes: serialise to a sibling temp file, then rename over the
 * destination so a reader (the desktop bridge polls once per second) never
 * observes a half-written document.
 */
import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

let tempCounter = 0

/**
 * Serialize a value the way the contract expects (pretty JSON, trailing LF).
 * @param {unknown} value
 * @returns {string}
 */
export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Write `value` as JSON to `filePath` atomically.
 *
 * `fs` is injectable so tests can simulate a failing rename without touching
 * the real filesystem; production always uses node:fs synchronously (writes
 * happen on a short debounce and stay well under a millisecond for this file).
 * @param {string} filePath
 * @param {unknown} value
 * @param {{
 *   fs?: {
 *     existsSync: typeof existsSync,
 *     mkdirSync: typeof mkdirSync,
 *     renameSync: typeof renameSync,
 *     unlinkSync: typeof unlinkSync,
 *     writeFileSync: typeof writeFileSync,
 *   },
 *   pid?: number,
 * }} [options]
 * @returns {string} the file path written
 */
export function writeJsonAtomic(filePath, value, options = {}) {
  const fs = options.fs ?? { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync }
  const pid = Number.isInteger(options.pid) ? options.pid : process.pid
  const directory = dirname(filePath)
  fs.mkdirSync(directory, { recursive: true })
  tempCounter += 1
  const tempPath = `${filePath}.${pid}.${process.hrtime.bigint()}.${tempCounter}.tmp`
  const payload = serializeJson(value)
  try {
    fs.writeFileSync(tempPath, payload, 'utf8')
    try {
      fs.renameSync(tempPath, filePath)
    } catch (renameError) {
      // Windows may refuse the replace while another process holds the target
      // open; drop the (stale) destination once and retry before giving up.
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
        fs.renameSync(tempPath, filePath)
      } catch {
        throw renameError
      }
    }
    return filePath
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    } catch {
      // Best effort cleanup only.
    }
    throw error
  }
}
