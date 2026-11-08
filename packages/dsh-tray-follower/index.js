/**
 * dsh-tray-follower — Host half.
 *
 * Tracks every top-level DSH conversation (per workspace) and publishes the
 * state contract from docs/DESIGN.md §4 to
 * `<DSH_TRAY_FOLLOWER_DIR or %LOCALAPPDATA%\dsh-tray-follower>\state.json`.
 * The DSH Desktop shell bridge is the ONLY consumer that shows notifications:
 * it reads this file, builds the tray menu, and raises native Electron
 * notifications in DSH's own name while the window is hidden or unfocused.
 *
 * This plugin never shows an OS notification itself. Without the bridge it
 * still publishes state (the tray/notification feature needs the bridge); no
 * external helper process or shell command is used here.
 *
 * Design rules enforced here:
 * - every DSH listener body is wrapped: a plugin bug must never escape into the
 *   DSH event loop;
 * - state writes are atomic (tmp + rename) and coalesced for ≤250 ms;
 * - nothing here depends on `@deepseek-ai/*`: only node builtins and the
 *   injected Cordis services;
 * - on unload the last state is flushed and the file is left in place (the
 *   bridge decides how to treat a stale `updatedAt`).
 */
import {
  ATTENTION_NOTIFY_DELAY_MS,
  STATE_DEBOUNCE_MS,
  TICK_INTERVAL_MS,
} from './lib/constants.js'
import { resolveDataDir, stateFilePath } from './lib/paths.js'
import { buildStateDocument } from './lib/state.js'
import { StateWriter } from './lib/state-writer.js'
import { createStrings, normalizeLanguage } from './lib/strings.js'
import { SessionTracker } from './lib/tracker.js'

/** Plugin identity used by the Loader row. */
export const name = 'dsh-tray-follower'

/** Hard dependency: without the agent registry nothing can be tracked. */
export const inject = ['agents']

const LOG_PREFIX = '[dsh-tray-follower]'

/**
 * Plugin entry. Never throws: a failure to start is logged and the row stays
 * inert instead of breaking the Host boot.
 * @param {any} ctx Cordis plugin context
 */
export function apply(ctx) {
  let logger
  try {
    logger = createLogger(ctx)
  } catch {
    logger = console
  }
  try {
    activate(ctx, logger)
  } catch (error) {
    safeWarn(logger, `${LOG_PREFIX} activation failed:`, error)
  }
}

/**
 * Wire services, events, timers and the state writer.
 * @param {any} ctx
 * @param {{ warn: (...args: any[]) => void, info: (...args: any[]) => void }} logger
 */
function activate(ctx, logger) {
  const now = () => Date.now()
  const language = resolveLanguage()
  const strings = createStrings(language)
  const dataDir = resolveDataDir()
  const writer = new StateWriter({
    filePath: stateFilePath(dataDir),
    debounceMs: STATE_DEBOUNCE_MS,
    logger,
  })

  const tracker = new SessionTracker({
    now,
    strings,
    workspaceOf: (sessionId) => resolveWorkspaceOf(ctx, sessionId),
  })

  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const attentionTimers = new Set()
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let tickTimer

  /** Read the published state document from live services. @returns {any} */
  function currentDocument() {
    return buildStateDocument({
      tracker,
      workspaces: readWorkspaces(ctx),
      webOrigin: readWebOrigin(ctx),
      hostPid: process.pid,
      now: now(),
      strings,
    })
  }

  /** Coalesced write, triggered by any projection change. */
  function scheduleWrite() {
    try {
      writer.schedule(currentDocument())
    } catch (error) {
      safeWarn(logger, `${LOG_PREFIX} state snapshot failed:`, error)
    }
  }

  /** Immediate write (initial + final snapshot). */
  function buildStateNow() {
    try {
      writer.writeNow(currentDocument())
    } catch (error) {
      safeWarn(logger, `${LOG_PREFIX} initial state write failed:`, error)
    }
  }

  /**
   * Arm the delayed "needs attention" unread-event publication for waits
   * created by the waterfall listeners. The delay keeps an instantly answered
   * approval or an auto-answered question from becoming a bridge notification.
   */
  function flushPublications() {
    let queued
    try {
      queued = tracker.takePublications()
    } catch {
      return
    }
    for (const publication of queued) {
      const timer = setTimeout(() => {
        attentionTimers.delete(timer)
        try {
          tracker.publishAttention(publication.sessionId, publication.key)
        } catch (error) {
          safeWarn(logger, `${LOG_PREFIX} attention publication failed:`, error)
        }
      }, ATTENTION_NOTIFY_DELAY_MS)
      unrefTimer(timer)
      attentionTimers.add(timer)
    }
  }

  // ---- projection → state file -------------------------------------------
  // Unread events are published for the desktop bridge, which owns the actual
  // notification. The plugin itself has no OS-notification path.
  tracker.onChange(scheduleWrite)
  tracker.onUnread(() => {
    try {
      scheduleWrite()
    } catch {
      // scheduleWrite already guards.
    }
  })

  // ---- DSH subscriptions --------------------------------------------------
  /** Register a synchronous listener; failures are contained. */
  const on = (eventName, handler) => {
    try {
      ctx.on(eventName, (...args) => {
        try {
          handler(...args)
        } catch (error) {
          safeWarn(logger, `${LOG_PREFIX} ${eventName} listener failed:`, error)
        }
      })
    } catch (error) {
      safeWarn(logger, `${LOG_PREFIX} cannot subscribe to ${eventName}:`, error)
    }
  }

  /**
   * Register a waterfall listener. It always delegates with `next()`, and
   * settles its soft wait in `finally` whatever the answerers decide.
   */
  const waterfall = (eventName, beginWait) => {
    try {
      ctx.on(eventName, async (payload, next) => {
        let wait
        try {
          wait = beginWait(payload)
          if (wait !== undefined) flushPublications()
        } catch (error) {
          safeWarn(logger, `${LOG_PREFIX} ${eventName} wait failed:`, error)
        }
        try {
          return await next()
        } finally {
          try {
            if (wait !== undefined) tracker.endWait(wait.sessionId, wait.key)
          } catch (error) {
            safeWarn(logger, `${LOG_PREFIX} ${eventName} settle failed:`, error)
          }
        }
      })
    } catch (error) {
      safeWarn(logger, `${LOG_PREFIX} cannot subscribe to ${eventName}:`, error)
    }
  }

  on('agent/status', (payload) => {
    const agent = payload?.agent
    tracker.agentStatus({ id: agent?.id, session: agent?.session, status: payload?.status })
  })

  on('agent/created', (payload) => {
    const agent = payload?.agent
    tracker.observeAgent({
      id: agent?.id,
      session: agent?.session,
      status: agent?.status,
      live: true,
      title: readSessionTitle(ctx, agent?.session),
      goal: readGoal(ctx, agent),
    })
  })

  on('agent/disposed', (payload) => {
    const agent = payload?.agent
    tracker.agentDisposed({ id: agent?.id, session: agent?.session })
  })

  on('agent/error', (payload) => {
    const agent = payload?.agent
    tracker.agentError({
      id: agent?.id,
      session: agent?.session,
      turn: payload?.turn,
      step: payload?.step,
      error: payload?.error,
    })
  })

  on('session/event', (session, event) => {
    tracker.sessionEvent(session, event)
    flushPublications()
  })

  on('goal/changed', (payload) => {
    tracker.goalChanged(payload)
  })

  on('goal/activation-changed', (payload) => {
    tracker.goalActivationChanged(payload)
  })

  waterfall('approval/request', (request) => tracker.beginApprovalWait(request))
  waterfall('user-questions/request', (request) => tracker.beginQuestionWait(request))

  // ---- startup seed -------------------------------------------------------
  seedFromLiveAgents()
  // Publish the first snapshot immediately so the bridge sees live state at
  // activation even before the first event arrives.
  buildStateNow()

  // ---- periodic maintenance ----------------------------------------------
  tickTimer = setInterval(() => {
    try {
      tracker.tick()
      scheduleWrite()
    } catch (error) {
      safeWarn(logger, `${LOG_PREFIX} tick failed:`, error)
    }
  }, TICK_INTERVAL_MS)
  unrefTimer(tickTimer)

  // ---- teardown -----------------------------------------------------------
  const dispose = () => {
    try {
      if (tickTimer !== undefined) clearInterval(tickTimer)
    } catch {
      // Ignore.
    }
    for (const timer of attentionTimers) {
      try {
        clearTimeout(timer)
      } catch {
        // Ignore.
      }
    }
    attentionTimers.clear()
    try {
      writer.writeNow(currentDocument())
    } catch {
      // The state file is best-effort on unload.
    }
    try {
      writer.dispose()
    } catch {
      // Ignore.
    }
  }

  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-tray-follower: teardown')
    else if (typeof ctx.on === 'function') ctx.on('dispose', dispose)
  } catch (error) {
    safeWarn(logger, `${LOG_PREFIX} teardown registration failed:`, error)
  }

  /**
   * Seed the projection from agents that are already live when the plugin
   * activates (plugin installed/reloaded while conversations are running).
   */
  function seedFromLiveAgents() {
    let agents = []
    try {
      // `inject: ['agents']` guarantees the hard dependency; read it through
      // `ctx.get` as well so a stub context in tests/edge loaders still works.
      let service
      try {
        service = ctx.get('agents')
      } catch {
        service = undefined
      }
      if (service === undefined || service === null) service = ctx.agents
      agents = service?.list?.() ?? []
    } catch (error) {
      safeWarn(logger, `${LOG_PREFIX} cannot list live agents:`, error)
      return
    }
    for (const agent of agents) {
      try {
        tracker.observeAgent({
          id: agent?.id,
          session: agent?.session,
          status: agent?.status,
          live: true,
          title: readSessionTitle(ctx, agent?.session),
          goal: readGoal(ctx, agent),
        })
      } catch (error) {
        safeWarn(logger, `${LOG_PREFIX} cannot seed agent:`, error)
      }
    }
  }
}

/** @param {any} ctx @returns {any} */
function createLogger(ctx) {
  let logger
  try {
    logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-tray-follower') : undefined
  } catch {
    logger = undefined
  }
  return {
    info: (...args) => {
      try {
        if (logger && typeof logger.info === 'function') logger.info(...args)
        else if (logger && typeof logger.debug === 'function') logger.debug(...args)
      } catch {
        // Logging is best effort.
      }
    },
    warn: (...args) => {
      try {
        if (logger && typeof logger.warn === 'function') logger.warn(...args)
        else if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(...args)
      } catch {
        // Logging is best effort.
      }
    },
  }
}

/** @param {{ warn: (...args: any[]) => void } | undefined} logger */
function safeWarn(logger, ...args) {
  try {
    if (logger && typeof logger.warn === 'function') logger.warn(...args)
  } catch {
    // Ignore.
  }
}

/**
 * Resolve the runtime language: explicit plugin override, then Harness/system
 * locale hints, then the JS engine locale.
 * @param {Record<string, string | undefined>} [env]
 * @returns {'en' | 'zh'}
 */
export function resolveLanguage(env = process.env) {
  const explicit = env.DSH_TRAY_FOLLOWER_LANG
  if (typeof explicit === 'string' && explicit.trim() !== '') return normalizeLanguage(explicit)
  for (const candidate of [env.DSH_LOCALE, env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return normalizeLanguage(candidate)
  }
  try {
    return normalizeLanguage(Intl.DateTimeFormat().resolvedOptions().locale)
  } catch {
    return 'en'
  }
}

/**
 * Read the workspace registry projection used for grouping.
 * @param {any} ctx
 * @returns {Array<{ id: string, title: string, path: string, sessionIds: string[] }>}
 */
function readWorkspaces(ctx) {
  let registry
  try {
    registry = ctx.get('workspaceRegistry')
  } catch {
    registry = undefined
  }
  if (registry === undefined || registry === null) return []
  let list
  try {
    list = registry.list()
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const workspaces = []
  for (const workspace of list) {
    try {
      if (workspace === undefined || workspace === null) continue
      let sessionIds = []
      try {
        sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : []
      } catch {
        sessionIds = []
      }
      workspaces.push({
        id: String(workspace.id),
        title: typeof workspace.title === 'string' ? workspace.title : '',
        path: typeof workspace.path === 'string' ? workspace.path : '',
        sessionIds,
      })
    } catch {
      // Skip a workspace projection that throws; the rest still render.
    }
  }
  return workspaces
}

/**
 * Which workspace owns one session (for notification bodies).
 * @param {any} ctx
 * @param {string} sessionId
 * @returns {{ id: string, title: string } | undefined}
 */
function resolveWorkspaceOf(ctx, sessionId) {
  const owned = String(sessionId)
  for (const workspace of readWorkspaces(ctx)) {
    if (workspace.sessionIds.includes(owned)) {
      return { id: workspace.id, title: workspace.title !== '' ? workspace.title : workspace.path }
    }
  }
  return undefined
}

/**
 * Folded session title, when the optional `sessionTitle` service is mounted.
 * @param {any} ctx
 * @param {any} session
 * @returns {string | undefined}
 */
function readSessionTitle(ctx, session) {
  if (session === undefined || session === null) return undefined
  let service
  try {
    service = ctx.get('sessionTitle')
  } catch {
    return undefined
  }
  if (service === undefined || service === null || typeof service.get !== 'function') return undefined
  try {
    const snapshot = service.get(session)
    return typeof snapshot?.title === 'string' ? snapshot.title : undefined
  } catch {
    return undefined
  }
}

/**
 * Current goal for one live agent, when the optional `goals` service is mounted.
 * @param {any} ctx
 * @param {any} agent
 * @returns {any | undefined}
 */
function readGoal(ctx, agent) {
  if (agent === undefined || agent === null) return undefined
  let service
  try {
    service = ctx.get('goals')
  } catch {
    return undefined
  }
  if (service === undefined || service === null || typeof service.get !== 'function') return undefined
  try {
    return service.get(agent)
  } catch {
    return undefined
  }
}

/**
 * The Web GUI origin advertised by the running Host. Published as `webOrigin`
 * in the state contract so the desktop bridge can open/focus the app.
 * @param {any} ctx
 * @returns {string}
 */
function readWebOrigin(ctx) {
  for (const serviceName of ['webApp', 'webServer']) {
    try {
      const service = ctx.get(serviceName)
      if (service === undefined || service === null) continue
      const raw = typeof service.getAdvertisedUrl === 'function'
        ? service.getAdvertisedUrl()
        : (typeof service.getOrigin === 'function' ? service.getOrigin() : undefined)
      const origin = sanitizeOrigin(raw)
      if (origin !== '') return origin
    } catch {
      // Try the next provider.
    }
  }
  return sanitizeOrigin(process.env.DSH_WEB_URL)
}

/**
 * Normalize a URL to its HTTP(S) origin, dropping credentials and paths.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.origin
  } catch {
    return ''
  }
}

/**
 * `timer.unref` exists for Node timers; guard so the code also runs under
 * exotic test doubles.
 * @param {any} timer
 */
function unrefTimer(timer) {
  try {
    if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  } catch {
    // Ignore.
  }
}
