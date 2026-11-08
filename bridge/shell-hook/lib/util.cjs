'use strict'

/**
 * Small defensive helpers shared by the shell bridge. Every helper is total:
 * unexpected input yields a documented fallback instead of throwing, because the
 * bridge runs inside the DSH Desktop Electron main process and must never crash it.
 */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Collapse control characters / newlines and trim; always returns a string. */
function cleanText(value, maxChars) {
  let text = ''
  if (typeof value === 'string') text = value
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value)
  else text = ''
  text = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return truncate(text, maxChars)
}

/** Cut a string to `maxChars`, appending an ellipsis when truncated. */
function truncate(value, maxChars) {
  if (typeof value !== 'string') return ''
  if (!Number.isFinite(maxChars) || maxChars <= 0) return ''
  if (value.length <= maxChars) return value
  if (maxChars === 1) return '…'
  return `${value.slice(0, maxChars - 1)}…`
}

/** Label-safe text with a fallback when the value is empty after cleaning. */
function sanitizeLabel(value, maxChars, fallback = '') {
  const cleaned = cleanText(value, maxChars)
  if (cleaned) return cleaned
  return cleanText(fallback, maxChars)
}

function finiteNumber(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

function nonNegativeInt(value, fallback = 0) {
  const number = Math.floor(finiteNumber(value, fallback))
  return number >= 0 ? number : fallback
}

/** Parse an env string into a bounded integer (never throws). */
function parseEnvInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number.parseInt(String(value).trim(), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Parse a boolean-ish env string (1/true/yes/on and 0/false/no/off). */
function parseEnvFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return fallback
}

/** Stable, bounded description of an error for logs. */
function describeError(error) {
  try {
    if (error instanceof Error) {
      const stack = typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 4).join('\n') : ''
      return { name: error.name || 'Error', message: error.message || String(error), code: error.code, stack }
    }
    if (typeof error === 'string') return { name: 'Error', message: error }
    return { name: 'Error', message: safeJsonStringify(error) }
  } catch (_error) {
    return { name: 'Error', message: 'unserializable error' }
  }
}

/** JSON.stringify that never throws; functions/undefined are dropped, cycles marked. */
function safeJsonStringify(value) {
  const seen = new WeakSet()
  const serialized = JSON.stringify(value, function replacer(key, current) {
    try {
      if (typeof current === 'bigint') return String(current)
      if (typeof current === 'function') return undefined
      if (current instanceof Error) return describeError(current)
      if (typeof current === 'object' && current !== null) {
        if (seen.has(current)) return '[circular]'
        seen.add(current)
      }
      return current
    } catch (_error) {
      return '[unserializable]'
    }
  })
  return serialized === undefined ? 'null' : serialized
}

/**
 * Convert an arbitrary value into a plain JSON-safe structure (used for test
 * diagnostics): functions and undefined are dropped, errors become descriptions,
 * cycles become the string "[circular]".
 */
function toJsonSafe(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return undefined
  if (value instanceof Error) return describeError(value)
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]'
    if (depth > 6) return '[depth-limit]'
    seen.add(value)
    if (Array.isArray(value)) {
      return value.map((entry) => toJsonSafe(entry, depth + 1, seen)).filter((entry) => entry !== undefined)
    }
    const result = {}
    for (const key of Object.keys(value)) {
      let entry
      try {
        entry = toJsonSafe(value[key], depth + 1, seen)
      } catch (_error) {
        entry = '[unserializable]'
      }
      if (entry !== undefined) result[key] = entry
    }
    return result
  }
  return String(value)
}

/** Count sessions by status (name kept for menu/notification consumers). */
function countStatuses(sessions, statuses) {
  const counts = { all: 0 }
  if (statuses && typeof statuses === 'object') {
    for (const status of Object.keys(statuses)) counts[status] = 0
  }
  if (!Array.isArray(sessions)) return counts
  for (const session of sessions) {
    if (!session || typeof session !== 'object') continue
    counts.all += 1
    const status = session.status
    if (typeof status === 'string') counts[status] = (counts[status] || 0) + 1
  }
  return counts
}

/** Sum a numeric property across an array of records. */
function sumBy(records, selector) {
  if (!Array.isArray(records) || typeof selector !== 'function') return 0
  let total = 0
  for (const record of records) {
    try {
      const value = selector(record)
      if (Number.isFinite(value)) total += value
    } catch (_error) {
      /* ignore a single bad record */
    }
  }
  return total
}

module.exports = {
  isPlainObject,
  cleanText,
  truncate,
  sanitizeLabel,
  finiteNumber,
  nonNegativeInt,
  parseEnvInt,
  parseEnvFlag,
  describeError,
  safeJsonStringify,
  toJsonSafe,
  countStatuses,
  sumBy
}
