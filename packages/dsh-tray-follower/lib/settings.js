/**
 * Live settings → state-contract `options` (docs/DESIGN.md §4.1, schema v2).
 *
 * The Host declares its Config fields `.volatile()`, so a parsed row hands the
 * plugin references that expose `.get()`; saving an edit in the settings page
 * updates the referenced value in place instead of restarting the plugin. A
 * plain value is accepted too (older row without a Config, unit tests, or a
 * hand-edited composition), which is what `readConfigValue` normalizes.
 *
 * `resolveSettings()` is the single place that turns that live Config into the
 * `options` object the desktop bridge consumes. It never throws: a broken or
 * stale value falls back to the schema default, and
 * `maxSessionsPerWorkspace` is clamped to its schema range so a bad config can
 * never corrupt the state file.
 *
 * Everything here is pure data / pure functions so it is unit-testable with
 * `node --test` and no DSH runtime.
 */

/** Smallest accepted `maxSessionsPerWorkspace` (schema `.min(1)`). */
export const MAX_SESSIONS_PER_WORKSPACE_MIN = 1

/** Largest accepted `maxSessionsPerWorkspace` (schema `.max(20)`). */
export const MAX_SESSIONS_PER_WORKSPACE_MAX = 20

/** Defaults of the tray section (must mirror the Config schema). */
export const TRAY_DEFAULTS = Object.freeze({
  showIdle: false,
  maxSessionsPerWorkspace: 6,
  showHeaderCounts: true,
  showFooter: true,
})

/** Defaults of the notifications section (must mirror the Config schema). */
export const NOTIFICATION_DEFAULTS = Object.freeze({
  notifyOnCompleted: true,
  notifyOnFailed: true,
  notifyOnAttention: true,
  suppressWhenFocused: true,
  notificationSound: true,
})

/** Defaults published when no Config is available at all. */
export const DEFAULT_OPTIONS = Object.freeze({
  tray: TRAY_DEFAULTS,
  notifications: NOTIFICATION_DEFAULTS,
})

/** Contract field names, grouped as they are published. */
export const OPTION_FIELDS = Object.freeze({
  tray: Object.freeze([
    'showIdle',
    'maxSessionsPerWorkspace',
    'showHeaderCounts',
    'showFooter',
  ]),
  notifications: Object.freeze([
    'notifyOnCompleted',
    'notifyOnFailed',
    'notifyOnAttention',
    'suppressWhenFocused',
    'notificationSound',
  ]),
})

/** Option section names in contract order. */
export const OPTION_SECTIONS = Object.freeze(['tray', 'notifications'])

/**
 * Read one live Config field. Volatile fields are references (`.get()`), plain
 * values are returned as-is, and any read failure is reported as `undefined`
 * so `normalizeOptions` can fall back to the default.
 * @param {any} config parsed row Config (or undefined)
 * @param {string} key
 * @returns {unknown}
 */
export function readConfigValue(config, key) {
  try {
    if (config === null || config === undefined) return undefined
    const value = config[key]
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
      return value.get()
    }
    return value
  } catch {
    return undefined
  }
}

/** @param {unknown} value @param {boolean} fallback */
function pickBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Clamp `maxSessionsPerWorkspace` into its schema range; a non-number falls
 * back to the default and a fractional number is rounded to the nearest row
 * count (the tray lists whole conversations).
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeMaxSessionsPerWorkspace(value) {
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(number)) return TRAY_DEFAULTS.maxSessionsPerWorkspace
  const rounded = Math.round(number)
  return Math.min(MAX_SESSIONS_PER_WORKSPACE_MAX, Math.max(MAX_SESSIONS_PER_WORKSPACE_MIN, rounded))
}

/**
 * Coerce an `options`-shaped object (the published contract shape) into a
 * fresh defaults-complete object. Unknown/malformed input and individual
 * malformed fields are replaced by their defaults.
 * @param {any} candidate
 * @returns {{ tray: { showIdle: boolean, maxSessionsPerWorkspace: number, showHeaderCounts: boolean, showFooter: boolean }, notifications: { notifyOnCompleted: boolean, notifyOnFailed: boolean, notifyOnAttention: boolean, suppressWhenFocused: boolean, notificationSound: boolean } }}
 */
export function normalizeOptions(candidate) {
  const source = candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate
    : {}
  const tray = source.tray !== null && typeof source.tray === 'object' && !Array.isArray(source.tray)
    ? source.tray
    : {}
  const notifications = source.notifications !== null
    && typeof source.notifications === 'object'
    && !Array.isArray(source.notifications)
    ? source.notifications
    : {}
  return {
    tray: {
      showIdle: pickBoolean(tray.showIdle, TRAY_DEFAULTS.showIdle),
      maxSessionsPerWorkspace: normalizeMaxSessionsPerWorkspace(tray.maxSessionsPerWorkspace),
      showHeaderCounts: pickBoolean(tray.showHeaderCounts, TRAY_DEFAULTS.showHeaderCounts),
      showFooter: pickBoolean(tray.showFooter, TRAY_DEFAULTS.showFooter),
    },
    notifications: {
      notifyOnCompleted: pickBoolean(notifications.notifyOnCompleted, NOTIFICATION_DEFAULTS.notifyOnCompleted),
      notifyOnFailed: pickBoolean(notifications.notifyOnFailed, NOTIFICATION_DEFAULTS.notifyOnFailed),
      notifyOnAttention: pickBoolean(notifications.notifyOnAttention, NOTIFICATION_DEFAULTS.notifyOnAttention),
      suppressWhenFocused: pickBoolean(notifications.suppressWhenFocused, NOTIFICATION_DEFAULTS.suppressWhenFocused),
      notificationSound: pickBoolean(notifications.notificationSound, NOTIFICATION_DEFAULTS.notificationSound),
    },
  }
}

/** @returns a fresh defaults `options` object (safe to mutate by the caller). */
export function defaultOptions() {
  return normalizeOptions(undefined)
}

/**
 * Read the current `options` object from the live plugin Config.
 * @param {any} [config] the second argument of `apply(ctx, config)`
 * @returns same shape as {@link normalizeOptions}
 */
export function resolveSettings(config) {
  return normalizeOptions({
    tray: {
      showIdle: readConfigValue(config, 'showIdle'),
      maxSessionsPerWorkspace: readConfigValue(config, 'maxSessionsPerWorkspace'),
      showHeaderCounts: readConfigValue(config, 'showHeaderCounts'),
      showFooter: readConfigValue(config, 'showFooter'),
    },
    notifications: {
      notifyOnCompleted: readConfigValue(config, 'notifyOnCompleted'),
      notifyOnFailed: readConfigValue(config, 'notifyOnFailed'),
      notifyOnAttention: readConfigValue(config, 'notifyOnAttention'),
      suppressWhenFocused: readConfigValue(config, 'suppressWhenFocused'),
      notificationSound: readConfigValue(config, 'notificationSound'),
    },
  })
}

/**
 * Compare two `options` objects field by field (normalized first, so defaults
 * and malformed values compare meaningfully).
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
export function sameOptions(left, right) {
  const a = normalizeOptions(left)
  const b = normalizeOptions(right)
  for (const section of OPTION_SECTIONS) {
    for (const field of OPTION_FIELDS[section]) {
      if (!Object.is(a[section][field], b[section][field])) return false
    }
  }
  return true
}
