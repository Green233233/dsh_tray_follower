'use strict'

const { LIMITS, DEFAULT_NOTIFICATION_OPTIONS } = require('./constants.cjs')

/**
 * Notification policy for unread conversation events.
 *
 * Requirements (docs/DESIGN.md + task contract v2):
 *  - only events that have never been notified/observed are considered;
 *  - contract-v2 `options.notifications` drives behavior:
 *      · `notifyOnCompleted` / `notifyOnFailed` / `notifyOnAttention` filter event
 *        kinds; filtered events are marked seen (a settings toggle must not replay
 *        old history);
 *      · `suppressWhenFocused` (default true) suppresses notifications while the
 *        DSH window is focused; when false the user gets notified even then;
 *      · `notificationSound` maps to `silent: !notificationSound` on the
 *        Electron notification;
 *  - multiple events observed in the same poll are coalesced into one summary
 *    notification ("N 个对话需要关注");
 *  - rate limit: at most one notification per `minIntervalMs`; events that arrive
 *    inside the interval are deferred (NOT marked seen) and retried on the next
 *    poll so they are not lost;
 *  - first ever run (no cursor file) baselines all current events silently to
 *    avoid spamming on install;
 *  - replay guard: events older than `maxEventAgeMs` (default 10 minutes) are
 *    ignored and only marked as seen — a persisted `unreadEvents` backlog from a
 *    previous run must never produce stale toast bursts after a restart.
 *
 * The policy is pure: persistence happens in the caller (lib/cursor.cjs).
 */

/** De-duplicate and bound an ordered list of event ids (oldest dropped first). */
function capSeenIds(ids, cap = LIMITS.seenCap) {
  const out = []
  const seen = new Set()
  if (!Array.isArray(ids)) return out
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  const limit = Number.isFinite(cap) && cap > 0 ? cap : LIMITS.seenCap
  while (out.length > limit) out.shift()
  return out
}

/**
 * Merge contract-v2 notification settings over the strict defaults.
 * Missing/invalid values fall back to defaults (v1 state files have no options).
 */
function resolveNotificationSettings(raw) {
  const defaults = DEFAULT_NOTIFICATION_OPTIONS
  const source = raw && typeof raw === 'object' ? raw : {}
  const read = (key) => (typeof source[key] === 'boolean' ? source[key] : defaults[key])
  return {
    notifyOnCompleted: read('notifyOnCompleted'),
    notifyOnFailed: read('notifyOnFailed'),
    notifyOnAttention: read('notifyOnAttention'),
    suppressWhenFocused: read('suppressWhenFocused'),
    notificationSound: read('notificationSound')
  }
}

const KIND_TO_SETTING = Object.freeze({
  completed: 'notifyOnCompleted',
  failed: 'notifyOnFailed',
  'needs-attention': 'notifyOnAttention'
})

/** True when the event kind is enabled by the notification settings. */
function isKindAllowed(kind, settings) {
  const key = KIND_TO_SETTING[kind]
  if (!key) return true
  return settings[key] !== false
}

/**
 * @param {object[]} events normalized unread events
 * @param {object} context
 * @param {number} [context.now]
 * @param {boolean} [context.focused] main window currently focused
 * @param {boolean} [context.visible] main window currently visible (diagnostics only)
 * @param {string[]} [context.seenIds]
 * @param {number} [context.lastNotifyAt]
 * @param {boolean} [context.baseline] first-run silent baseline
 * @param {object} [context.options] contract-v2 `options.notifications`
 * @param {object} [context.config] policy tuning (rate limit/coalescing/replay window)
 * @returns {{
 *   notifications: {kind: string, title: string, body: string, eventIds: string[], silent: boolean}[],
 *   seenIdsToAdd: string[],
 *   expiredIds: string[],
 *   filteredIds: string[],
 *   deferredIds: string[],
 *   baselineApplied: boolean,
 *   suppressed: boolean,
 *   silent: boolean,
 *   settings: object,
 *   lastNotifyAt: number,
 *   now: number,
 *   candidates: number
 * }}
 */
function planNotifications(events, context = {}) {
  const config = Object.assign(
    {
      notifyWhileFocused: false,
      minIntervalMs: LIMITS.notifyMinIntervalMs,
      maxBodyLines: LIMITS.notifyMaxBodyLines,
      maxEventAgeMs: 10 * 60 * 1000,
      seenCap: LIMITS.seenCap
    },
    context.config && typeof context.config === 'object' ? context.config : {}
  )
  const settings = resolveNotificationSettings(context.options)
  const silent = settings.notificationSound !== true
  const now = Number.isFinite(context.now) ? context.now : Date.now()
  const lastNotifyAt = Number.isFinite(context.lastNotifyAt) ? context.lastNotifyAt : 0
  const seen = new Set(Array.isArray(context.seenIds) ? context.seenIds : [])

  const live = []
  const expiredIds = []
  if (Array.isArray(events)) {
    for (const event of events) {
      if (!event || typeof event.id !== 'string' || !event.id || seen.has(event.id)) continue
      const createdAt = Number.isFinite(event.createdAt) ? event.createdAt : 0
      if (createdAt > 0 && now - createdAt > config.maxEventAgeMs) {
        expiredIds.push(event.id)
        continue
      }
      live.push(event)
    }
  }

  const result = {
    notifications: [],
    seenIdsToAdd: expiredIds.slice(),
    expiredIds,
    filteredIds: [],
    deferredIds: [],
    baselineApplied: false,
    suppressed: false,
    silent,
    settings,
    lastNotifyAt,
    now,
    candidates: 0
  }
  if (live.length === 0) return result

  if (context.baseline === true) {
    // First-ever run: baseline everything silently (including disabled kinds).
    result.baselineApplied = true
    result.seenIdsToAdd.push(...live.map((event) => event.id))
    return result
  }

  // Settings-driven kind filters. Disabled kinds are consumed silently so a later
  // settings change cannot replay old history.
  const candidates = []
  for (const event of live) {
    if (isKindAllowed(event.kind, settings)) candidates.push(event)
    else result.filteredIds.push(event.id)
  }
  result.seenIdsToAdd.push(...result.filteredIds)
  result.candidates = candidates.length
  if (candidates.length === 0) return result

  const focused = context.focused === true
  const suppressWhenFocused =
    config.suppressWhenFocused !== undefined ? config.suppressWhenFocused !== false : settings.suppressWhenFocused !== false
  if (suppressWhenFocused && focused && config.notifyWhileFocused !== true) {
    result.suppressed = true
    result.seenIdsToAdd.push(...candidates.map((event) => event.id))
    return result
  }

  if (lastNotifyAt > 0 && now - lastNotifyAt < config.minIntervalMs) {
    result.deferredIds = candidates.map((event) => event.id)
    return result
  }

  if (candidates.length === 1) {
    const event = candidates[0]
    result.notifications.push({
      kind: 'single',
      title: event.title || 'DSH 对话需要关注',
      body: event.body || '',
      eventIds: [event.id],
      silent
    })
  } else {
    const lines = candidates.slice(0, config.maxBodyLines).map((event) => `• ${event.body || event.title || event.id}`)
    if (candidates.length > config.maxBodyLines) lines.push(`… 还有 ${candidates.length - config.maxBodyLines} 个对话`)
    result.notifications.push({
      kind: 'summary',
      title: `${candidates.length} 个对话需要关注`,
      body: lines.join('\n'),
      eventIds: candidates.map((event) => event.id),
      silent
    })
  }
  result.seenIdsToAdd.push(...candidates.map((event) => event.id))
  result.lastNotifyAt = now
  return result
}

module.exports = {
  capSeenIds,
  resolveNotificationSettings,
  isKindAllowed,
  planNotifications
}
