'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { LIMITS, SCHEMA_VERSION } = require('./constants.cjs')
const { isPlainObject, finiteNumber, describeError } = require('./util.cjs')
const { capSeenIds } = require('./notify-policy.cjs')

const CURSOR_FILE_NAME = 'cursor.json'

function defaultCursor() {
  return { schemaVersion: SCHEMA_VERSION, seenEventIds: [], lastNotifyAt: 0 }
}

/** Validate a decoded cursor document; corrupt/foreign shapes fall back to defaults. */
function normalizeCursor(raw) {
  const cursor = defaultCursor()
  if (!isPlainObject(raw)) return cursor
  if (Array.isArray(raw.seenEventIds)) {
    cursor.seenEventIds = capSeenIds(
      raw.seenEventIds.filter((id) => typeof id === 'string' && id.length > 0),
      LIMITS.seenCap
    )
  }
  cursor.lastNotifyAt = Math.max(0, finiteNumber(raw.lastNotifyAt, 0))
  return cursor
}

/**
 * Load the persisted notification cursor.
 * @returns {{cursor: object, loaded: boolean, error?: string, path: string}}
 */
function loadCursor(dataDir, fileName = CURSOR_FILE_NAME) {
  const file = path.join(dataDir, fileName)
  let stat
  try {
    stat = fs.statSync(file)
  } catch (error) {
    const missing = error && error.code === 'ENOENT'
    return { cursor: defaultCursor(), loaded: false, error: missing ? 'cursor file missing' : describeError(error).message, path: file }
  }
  try {
    if (!stat.isFile()) return { cursor: defaultCursor(), loaded: false, error: 'cursor path is not a file', path: file }
    if (stat.size > LIMITS.cursorBytes) {
      return { cursor: defaultCursor(), loaded: false, error: 'cursor file too large', path: file }
    }
    const decoded = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { cursor: normalizeCursor(decoded), loaded: true, path: file }
  } catch (error) {
    return { cursor: defaultCursor(), loaded: false, error: `cursor read failed: ${describeError(error).message}`, path: file }
  }
}

/**
 * Atomically persist the notification cursor (tmp + rename). Never throws.
 * @returns {{ok: boolean, path: string, error?: string}}
 */
function saveCursor(dataDir, cursor, fileName = CURSOR_FILE_NAME) {
  const file = path.join(dataDir, fileName)
  const normalized = normalizeCursor(cursor)
  const temporary = `${file}.tmp`
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(temporary, `${JSON.stringify(normalized)}\n`, 'utf8')
    fs.renameSync(temporary, file)
    return { ok: true, path: file }
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch (_cleanupError) {
      /* ignore */
    }
    return { ok: false, path: file, error: describeError(error).message }
  }
}

/** Return a new cursor with `ids` appended (deduped, capped) and a new timestamp. */
function withSeen(cursor, ids, now = Date.now(), cap = LIMITS.seenCap) {
  const base = normalizeCursor(cursor)
  const next = capSeenIds([...base.seenEventIds, ...(Array.isArray(ids) ? ids : [])], cap)
  return { ...base, seenEventIds: next, lastNotifyAt: base.lastNotifyAt, updatedAt: finiteNumber(now, Date.now()) }
}

/** Return a new cursor with an updated last-notification timestamp. */
function withLastNotifyAt(cursor, lastNotifyAt) {
  const base = normalizeCursor(cursor)
  return { ...base, lastNotifyAt: Math.max(0, finiteNumber(lastNotifyAt, 0)) }
}

module.exports = {
  CURSOR_FILE_NAME,
  defaultCursor,
  normalizeCursor,
  loadCursor,
  saveCursor,
  withSeen,
  withLastNotifyAt
}
