'use strict'

const os = require('node:os')
const path = require('node:path')

const {
  VERSION,
  DATA_DIR_NAME,
  ENV,
  DEFAULT_OPTIONS,
  LIMITS,
  RECONSTRUCTED_ITEM_LABELS,
  localeFamily
} = require('./constants.cjs')
const { describeError, parseEnvFlag, parseEnvInt, safeJsonStringify, toJsonSafe } = require('./util.cjs')
const { createLogger } = require('./log.cjs')
const { readStateFile } = require('./state.cjs')
const { buildStatusSection, menuSignature, toElectronTemplate, describeSection, resolveTraySettings } = require('./menu-model.cjs')
const { planNotifications } = require('./notify-policy.cjs')
const { loadCursor, saveCursor, withSeen, withLastNotifyAt } = require('./cursor.cjs')
const { createTrayPatcher, describeTemplate, isUsableTray, safeTooltip } = require('./tray-patch.cjs')
const { createWindowHelper } = require('./windows.cjs')
const { writeHeartbeat } = require('./heartbeat.cjs')

/**
 * Resolve the bridge data directory.
 * Precedence: `DSH_TRAY_FOLLOWER_DIR` > %LOCALAPPDATA%\dsh-tray-follower > temp.
 */
function resolveDataDir(env = process.env) {
  const source = env && typeof env === 'object' ? env : {}
  const override = typeof source[ENV.dataDir] === 'string' ? source[ENV.dataDir].trim() : ''
  if (override) return path.resolve(override)
  const localAppData =
    (typeof source.LOCALAPPDATA === 'string' && source.LOCALAPPDATA) ||
    (typeof source.USERPROFILE === 'string' && source.USERPROFILE ? path.join(source.USERPROFILE, 'AppData', 'Local') : '')
  if (localAppData) return path.join(localAppData, DATA_DIR_NAME)
  return path.join(os.tmpdir(), DATA_DIR_NAME)
}

/**
 * Create the shell bridge.
 *
 * The bridge never throws into DSH: every lifecycle step is guarded and failures
 * are collected in `diagnostics().recentErrors` and the log file.
 *
 * @param {object} options
 * @param {object} options.api Electron module (`require('electron')` in the main process)
 * @param {object} [options.env] environment (defaults to process.env)
 * @param {string} [options.dataDir]
 * @param {string} [options.hookDir]
 * @param {string} [options.version]
 * @param {boolean} [options.testMode]
 * @param {object} [options.logger] injected logger (tests)
 * @param {boolean} [options.timers] set false to disable background timers (tests)
 * @param {() => number} [options.now]
 */
function createBridge(options = {}) {
  const api = options.api
  if (!api || typeof api !== 'object' || typeof api.app !== 'object' || api.app === null) {
    throw new Error('createBridge: an Electron api object with `app` is required')
  }
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const version = typeof options.version === 'string' && options.version ? options.version : VERSION
  const dataDir = path.resolve(options.dataDir || resolveDataDir(env))
  const hookDir = path.resolve(options.hookDir || __dirname)
  const testMode = options.testMode === undefined ? parseEnvFlag(env[ENV.test], false) : options.testMode === true
  const timersEnabled = options.timers !== false
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const testExitMs = parseEnvInt(env[ENV.testExitMs], 60000, 1, 24 * 60 * 60 * 1000)

  const logger =
    options.logger && typeof options.logger === 'object'
      ? options.logger
      : createLogger({ file: path.join(dataDir, 'bridge.log'), maxBytes: LIMITS.logBytes, testMode })
  try {
    if (typeof logger.init === 'function') logger.init()
  } catch (_error) {
    /* logger is already defensive */
  }

  const bridge = {
    started: false,
    stopped: false,
    startedAt: now(),
    version,
    dataDir,
    hookDir,
    testMode,
    patcher: null,
    windows: null,
    cursor: { schemaVersion: 1, seenEventIds: [], lastNotifyAt: 0 },
    cursorLoaded: false,
    baselinePending: true,
    adopted: [],
    originalTemplate: null,
    originalSource: 'none',
    lastMenuSignature: '',
    /** True when the shell replaced our menu and a rebuild is mandatory. */
    menuDirty: false,
    menuRebuilds: 0,
    lastState: null,
    lastStateError: null,
    lastPollAt: 0,
    heartbeatOk: false,
    heartbeatAt: 0,
    heartbeatPath: path.join(dataDir, 'bridge.json'),
    notificationsShown: 0,
    notifications: [],
    recentErrors: [],
    appReady: false,
    inspectorClose: 'not-requested',
    pollTimer: null,
    heartbeatTimer: null,
    menuTimer: null,
    exitTimer: null,
    selfTestTimer: null,
    watchdogTimer: null,
    stateDiagDone: false,
    willQuitHandler: null
  }

  function fail(where, error) {
    try {
      const description = describeError(error)
      bridge.recentErrors.push({ at: now(), where, error: description })
      if (bridge.recentErrors.length > LIMITS.recentErrors) bridge.recentErrors.shift()
      logger.error(`bridge-error:${where}`, error)
    } catch (_error) {
      /* never throw */
    }
  }

  function electronVersions() {
    try {
      const versions = process.versions || {}
      return {
        electron: typeof versions.electron === 'string' ? versions.electron : null,
        node: typeof versions.node === 'string' ? versions.node : null,
        chrome: typeof versions.chrome === 'string' ? versions.chrome : null
      }
    } catch (_error) {
      return { electron: null, node: null, chrome: null }
    }
  }

  function safeAppName() {
    try {
      const name = api.app.getName()
      if (typeof name === 'string' && name.trim()) return name.trim()
    } catch (_error) {
      /* ignore */
    }
    return 'DeepSeek Harness'
  }

  function safeLocale() {
    try {
      const locale = api.app.getLocale()
      if (typeof locale === 'string' && locale) return locale
    } catch (_error) {
      /* ignore */
    }
    return 'en'
  }

  function focusMainWindow(reason) {
    try {
      if (!bridge.windows) return { ok: false, reason: 'window-helper-unavailable' }
      const result = bridge.windows.focus()
      logger.log('focus-request', { reason, ok: result.ok === true, actions: result.actions, url: result.url })
      return result
    } catch (error) {
      fail('focus-main-window', error)
      return { ok: false, error: describeError(error) }
    }
  }

  function quitApplication() {
    try {
      api.app.quit()
      logger.log('quit-request')
      return { ok: true }
    } catch (error) {
      fail('quit-application', error)
      return { ok: false, error: describeError(error) }
    }
  }

  /**
   * Equivalents of the shell's own tray items, used when the original menu was
   * never captured (late injection / adoption). Once the shell relabels its tray,
   * the patched setContextMenu captures the real items and this fallback retires.
   */
  function reconstructOriginalTemplate() {
    const appName = safeAppName()
    const labels = RECONSTRUCTED_ITEM_LABELS[localeFamily(safeLocale())] || RECONSTRUCTED_ITEM_LABELS.en
    return [
      { label: labels.open(appName), click: () => focusMainWindow('tray-open') },
      { type: 'separator' },
      { label: labels.quit(appName), click: () => quitApplication() }
    ]
  }

  function originalSignaturePart() {
    const template = bridge.originalTemplate || []
    return template.map((item) => {
      if (!item || typeof item !== 'object') return '?'
      return `${typeof item.type === 'string' ? item.type : 'normal'}|${typeof item.label === 'string' ? item.label : ''}`
    })
  }

  function persistCursor(reason) {
    try {
      const result = saveCursor(dataDir, bridge.cursor)
      if (!result.ok) fail(`cursor-save:${reason}`, result.error)
      return result
    } catch (error) {
      fail(`cursor-save:${reason}`, error)
      return { ok: false }
    }
  }

  function applySeen(ids, lastNotifyAt, reason) {
    try {
      if (Array.isArray(ids) && ids.length > 0) {
        bridge.cursor = withSeen(bridge.cursor, ids, now(), LIMITS.seenCap)
      }
      if (Number.isFinite(lastNotifyAt)) bridge.cursor = withLastNotifyAt(bridge.cursor, lastNotifyAt)
      persistCursor(reason)
    } catch (error) {
      fail('cursor-apply', error)
    }
  }

  /**
   * Raise one native notification.
   *
   * Product requirement: notifications MUST be attributed to DeepSeek Harness
   * itself. This is achieved exclusively through Electron's main-process
   * `Notification` API: the OS attributes the toast to the DSH app (AUMID).
   * The bridge deliberately has NO PowerShell / WinRT / external-process
   * notifier fallback — when the API is unsupported we log and continue.
   */
  function showNotification(spec, options = {}) {
    try {
      const Notification = api.Notification
      if (!Notification || typeof Notification !== 'function') {
        logger.log('notification-unsupported', { reason: 'Notification API unavailable' })
        logger.diag('notification-unsupported', { reason: 'Notification API unavailable' })
        return false
      }
      try {
        if (typeof Notification.isSupported === 'function' && Notification.isSupported() !== true) {
          logger.log('notification-unsupported', { reason: 'Notification.isSupported() === false' })
          logger.diag('notification-unsupported', { reason: 'Notification.isSupported() === false' })
          return false
        }
      } catch (_error) {
        /* keep going: isSupported is best-effort */
      }
      const title = typeof spec.title === 'string' && spec.title ? spec.title : 'DSH 对话需要关注'
      const body = typeof spec.body === 'string' ? spec.body : ''
      // settings.notifications.notificationSound => silent: !notificationSound
      const silent = spec.silent === true
      const notification = new Notification({ title, body, silent })
      const record = {
        kind: spec.kind || 'event',
        title,
        silent,
        eventIds: Array.isArray(spec.eventIds) ? spec.eventIds : [],
        at: now()
      }
      try {
        notification.on('click', () => {
          logger.log('notification-click', { kind: record.kind })
          focusMainWindow('notification-click')
        })
        notification.on('failed', (_event, error) => {
          logger.log('notification-failed', { error: toJsonSafe(error) })
        })
      } catch (error) {
        fail('notification-listeners', error)
      }
      try {
        notification.show()
      } catch (error) {
        fail('notification-show', error)
        return false
      }
      bridge.notifications.push({ notification, record })
      while (bridge.notifications.length > LIMITS.notificationsKept) bridge.notifications.shift()
      bridge.notificationsShown += 1
      logger.log('notification-shown', { kind: record.kind, title, silent, count: record.eventIds.length })
      logger.diag('notification-shown', {
        kind: record.kind,
        title,
        body,
        silent,
        count: record.eventIds.length,
        eventIds: record.eventIds
      })
      if (options.trackPolicy !== false) {
        applySeen([], record.at, 'notification')
      }
      return true
    } catch (error) {
      fail('notification', error)
      return false
    }
  }

  function processNotifications() {
    try {
      const windowState = bridge.windows && typeof bridge.windows.state === 'function' ? bridge.windows.state() : null
      const events = bridge.lastState && Array.isArray(bridge.lastState.unreadEvents) ? bridge.lastState.unreadEvents : []
      const notificationOptions =
        bridge.lastState && bridge.lastState.options ? bridge.lastState.options.notifications : undefined
      const plan = planNotifications(events, {
        now: now(),
        focused: windowState ? windowState.focused === true : false,
        visible: windowState ? windowState.visible === true : false,
        seenIds: bridge.cursor.seenEventIds,
        lastNotifyAt: bridge.cursor.lastNotifyAt,
        baseline: bridge.baselinePending === true,
        options: notificationOptions,
        config: {
          minIntervalMs: LIMITS.notifyMinIntervalMs,
          maxBodyLines: LIMITS.notifyMaxBodyLines,
          seenCap: LIMITS.seenCap
        }
      })

      if (plan.baselineApplied) {
        bridge.baselinePending = false
        logger.log('notification-baseline', { count: plan.seenIdsToAdd.length })
        logger.diag('notification-baseline', { count: plan.seenIdsToAdd.length })
        applySeen(plan.seenIdsToAdd, undefined, 'baseline')
        return
      }
      if (plan.filteredIds.length > 0) {
        // Settings disabled these kinds: consume silently so toggling them on later
        // cannot replay history.
        logger.log('notification-filtered', { count: plan.filteredIds.length })
        logger.diag('notification-filtered', { count: plan.filteredIds.length, ids: plan.filteredIds })
      }
      if (plan.suppressed) {
        if (plan.seenIdsToAdd.length > 0) {
          logger.log('notification-suppressed', { reason: 'focused', count: plan.seenIdsToAdd.length })
          logger.diag('notification-suppressed', { reason: 'focused', count: plan.seenIdsToAdd.length })
          applySeen(plan.seenIdsToAdd, undefined, 'focused')
        }
        return
      }
      if (plan.deferredIds.length > 0) {
        // Rate-limited: persist only the filtered/expired ids, keep the notifications
        // pending for the next poll (they must not be marked seen yet).
        if (plan.seenIdsToAdd.length > 0) applySeen(plan.seenIdsToAdd, undefined, 'deferred')
        logger.log('notification-deferred', { count: plan.deferredIds.length, reason: 'rate-limit' })
        return
      }
      if (plan.notifications.length === 0) {
        if (plan.seenIdsToAdd.length > 0) applySeen(plan.seenIdsToAdd, undefined, 'filtered')
        return
      }
      for (const spec of plan.notifications) {
        showNotification(spec, { trackPolicy: false })
      }
      applySeen(plan.seenIdsToAdd, plan.lastNotifyAt, 'notification')
      logger.log('notification-batch', {
        shown: plan.notifications.length,
        events: plan.seenIdsToAdd.length,
        silent: plan.silent === true,
        focused: windowState ? windowState.focused === true : false,
        visible: windowState ? windowState.visible === true : false
      })
    } catch (error) {
      fail('process-notifications', error)
    }
  }

  /** Count rendered session rows (workspace and idle-group submenus included). */
  function countSessionRows(section) {
    let count = 0
    if (!Array.isArray(section)) return count
    for (const item of section) {
      if (!item || typeof item !== 'object') continue
      if (item.kind === 'session') count += 1
      else if (Array.isArray(item.submenu)) count += countSessionRows(item.submenu)
    }
    return count
  }

  function rebuildMenu(reason) {
    try {
      if (bridge.stopped) return { ok: false, reason: 'stopped' }
      const trays = bridge.adopted.filter(isUsableTray)
      if (trays.length === 0) return { ok: false, reason: 'no-tray' }
      if (!bridge.originalTemplate) {
        bridge.originalTemplate = reconstructOriginalTemplate()
        bridge.originalSource = 'reconstructed'
        logger.log('tray-menu-reconstructed', { labels: originalSignaturePart() })
      }
      const section = buildStatusSection(bridge.lastState, {
        version,
        unavailable: bridge.lastState === null,
        locale: safeLocale()
      })
      const signature = safeJsonStringify({
        originalSource: bridge.originalSource,
        original: originalSignaturePart(),
        section: menuSignature(section)
      })
      if (signature === bridge.lastMenuSignature && bridge.menuDirty !== true) return { ok: true, changed: false }
      const template = [
        ...bridge.originalTemplate,
        { type: 'separator' },
        ...toElectronTemplate(section, { focus: () => focusMainWindow('tray-session') })
      ]
      let applied = 0
      let buildError = null
      for (const tray of trays) {
        try {
          const menu = api.Menu.buildFromTemplate(template)
          const result = bridge.patcher.applyMenu(tray, menu)
          if (result.ok) applied += 1
          else buildError = result.error
        } catch (error) {
          buildError = describeError(error)
        }
      }
      if (applied === 0) {
        const failure = new Error(`menu rebuild applied to no tray: ${safeJsonStringify(buildError)}`)
        fail('menu-apply', failure)
        logger.diag('menu-rebuild-failed', { reason, error: toJsonSafe(buildError), trays: trays.length })
        return { ok: false, error: toJsonSafe(buildError) }
      }
      bridge.lastMenuSignature = signature
      bridge.menuDirty = false
      bridge.menuRebuilds += 1
      const stats = (bridge.lastState && bridge.lastState.stats) || { running: 0, pending: 0, sessions: 0 }
      const traySettings = resolveTraySettings(bridge.lastState)
      logger.log('menu-rebuilt', {
        reason,
        applied,
        originalSource: bridge.originalSource,
        workspaces: bridge.lastState ? bridge.lastState.workspaces.length : 0,
        sessions: stats.sessions || 0,
        running: stats.running || 0,
        pending: stats.pending || 0,
        // Settings-driven tray behaviour, so a live install can be verified from
        // the log alone: showIdle=false means idle conversations are not listed,
        // and displayedSessions counts the session rows actually rendered.
        showIdle: traySettings.showIdle === true,
        maxSessionsPerWorkspace: traySettings.maxSessionsPerWorkspace,
        displayedSessions: countSessionRows(section),
        unavailable: bridge.lastState === null
      })
      logger.diag('menu-rebuilt', {
        reason,
        applied,
        trayCount: trays.length,
        originalSource: bridge.originalSource,
        unavailable: bridge.lastState === null,
        header: section.length > 0 ? section[0].label : '',
        workspaces: bridge.lastState
          ? bridge.lastState.workspaces.map((workspace) => ({
              title: workspace.title,
              sessions: workspace.sessions.map((session) => ({ title: session.title, status: session.status }))
            }))
          : [],
        section: describeSection(section),
        original: describeTemplate(bridge.originalTemplate)
      })
      return { ok: true, changed: true, applied }
    } catch (error) {
      fail('menu-rebuild', error)
      return { ok: false, error: describeError(error) }
    }
  }

  function scheduleRebuild(reason, delayMs) {
    try {
      if (bridge.stopped) return
      if (!timersEnabled) {
        rebuildMenu(reason)
        return
      }
      if (bridge.menuTimer) return
      const delay = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : LIMITS.menuDebounceMs
      bridge.menuTimer = setTimeout(() => {
        bridge.menuTimer = null
        try {
          rebuildMenu(reason)
        } catch (error) {
          fail('menu-rebuild-timer', error)
        }
      }, delay)
      if (typeof bridge.menuTimer.unref === 'function') bridge.menuTimer.unref()
    } catch (error) {
      fail('menu-schedule', error)
    }
  }

  function readAndApplyState(reason) {
    try {
      bridge.lastPollAt = now()
      const read = readStateFile(dataDir)
      if (read.ok) {
        bridge.lastState = read.state
        bridge.lastStateError = null
        if (bridge.testMode && !bridge.stateDiagDone) {
          bridge.stateDiagDone = true
          logger.diag('state-loaded', {
            reason,
            path: read.path,
            bytes: read.bytes,
            workspaces: read.state.workspaces.length,
            sessions: read.state.stats.sessions,
            running: read.state.stats.running,
            pending: read.state.stats.pending,
            unreadEvents: read.state.unreadEvents.length,
            updatedAt: read.state.updatedAt,
            warnings: read.warnings
          })
        }
        if (Array.isArray(read.warnings) && read.warnings.length > 0) {
          logger.log('state-warnings', { count: read.warnings.length, warnings: read.warnings })
        }
      } else {
        bridge.lastState = null
        if (bridge.lastStateError !== read.error) {
          bridge.lastStateError = read.error
          logger.log('state-unavailable', { error: read.error, missing: read.missing === true, path: read.path })
        }
      }
    } catch (error) {
      fail('state-read', error)
    }
    scheduleRebuild(reason, 0)
    processNotifications()
  }

  function writeHeartbeatNow(reason) {
    try {
      const result = writeHeartbeat({ dataDir, version, pid: process.pid, now: now() })
      if (result.ok) {
        bridge.heartbeatOk = true
        bridge.heartbeatAt = now()
        bridge.heartbeatPath = result.path
      } else {
        bridge.heartbeatOk = false
        fail(`heartbeat:${reason}`, result.error)
      }
      return result
    } catch (error) {
      bridge.heartbeatOk = false
      fail(`heartbeat:${reason}`, error)
      return { ok: false, error: describeError(error) }
    }
  }

  function handleCapture(record) {
    try {
      if (!record || !Array.isArray(record.template) || record.template.length === 0) return
      bridge.originalTemplate = record.template
      bridge.originalSource = 'captured'
      // The shell just installed its own menu: our merged menu is gone, so the
      // next rebuild must re-apply even when the state signature is unchanged.
      bridge.menuDirty = true
      logger.log('tray-captured', {
        items: record.template.length,
        labels: originalSignaturePart(),
        tooltip: record.tooltip
      })
      logger.diag('tray-captured', {
        items: record.template.length,
        original: describeTemplate(record.template),
        tooltip: record.tooltip
      })
    } catch (error) {
      fail('tray-capture', error)
    }
    try {
      if (bridge.adopted.length === 0 && record.tray) adopt(record.tray, 'captured')
    } catch (error) {
      fail('tray-capture-adopt', error)
    }
    scheduleRebuild('capture', 0)
  }

  function adopt(tray, reason = 'external') {
    try {
      if (!isUsableTray(tray)) {
        return { adopted: false, reason: 'unusable-tray', trayCount: bridge.adopted.length }
      }
      if (!bridge.adopted.includes(tray)) bridge.adopted.push(tray)
      if (!bridge.originalTemplate) {
        bridge.originalTemplate = reconstructOriginalTemplate()
        bridge.originalSource = 'reconstructed'
      }
      logger.log('tray-adopted', {
        reason,
        trayCount: bridge.adopted.length,
        originalSource: bridge.originalSource,
        tooltip: safeTooltip(tray)
      })
      logger.diag('tray-adopted', {
        reason,
        trayCount: bridge.adopted.length,
        originalSource: bridge.originalSource,
        original: describeTemplate(bridge.originalTemplate),
        tooltip: safeTooltip(tray)
      })
      scheduleRebuild('adopt', 0)
      return { adopted: true, trayCount: bridge.adopted.length, originalSource: bridge.originalSource }
    } catch (error) {
      fail('tray-adopt', error)
      return { adopted: false, error: describeError(error) }
    }
  }

  function runSelfTest(reason) {
    try {
      if (bridge.stopped) return
      const diagnostics = handle.diagnostics()
      logger.diag('self-test', {
        reason,
        adoptedTrayCount: diagnostics.adoptedTrayCount,
        patched: diagnostics.patched,
        menuRebuilds: diagnostics.menuRebuilds,
        stateAvailable: diagnostics.state.available
      })
      const show = parseEnvFlag(env[ENV.testShowNotification], true)
      if (!show) {
        logger.diag('notification-test-skipped', { reason: 'DSH_TRAY_FOLLOWER_TEST_SHOW_NOTIFICATION=0' })
        return
      }
      const notificationOptions =
        bridge.lastState && bridge.lastState.options ? bridge.lastState.options.notifications : DEFAULT_OPTIONS.notifications
      const silent = notificationOptions.notificationSound === false
      const shown = showNotification(
        {
          kind: 'test',
          title: 'DSH 托盘跟随（自检）',
          body: `桥接已注入 Electron 主进程；托盘 ${diagnostics.adoptedTrayCount} 个，菜单重建 ${diagnostics.menuRebuilds} 次。`,
          eventIds: [],
          silent
        },
        { trackPolicy: false }
      )
      logger.diag('notification-test', { shown, silent })
    } catch (error) {
      fail('self-test', error)
    }
  }

  function onAppReady() {
    try {
      bridge.appReady = true
      logger.log('app-ready', electronVersions())
      logger.diag('app-ready', {
        electron: electronVersions(),
        appName: safeAppName(),
        locale: safeLocale(),
        platform: process.platform,
        isPackaged: api.app && typeof api.app.isPackaged === 'boolean' ? api.app.isPackaged : null,
        userData: safeAppPath('userData'),
        resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : null
      })
      if (bridge.testMode) {
        if (timersEnabled) {
          bridge.selfTestTimer = setTimeout(() => {
            bridge.selfTestTimer = null
            runSelfTest('app-ready')
          }, 1200)
          if (typeof bridge.selfTestTimer.unref === 'function') bridge.selfTestTimer.unref()
          bridge.watchdogTimer = setTimeout(() => {
            bridge.watchdogTimer = null
            if (bridge.adopted.length === 0) {
              logger.diag('tray-adoption-timeout', {
                trayCount: bridge.adopted.length,
                captured: bridge.originalSource,
                patched: bridge.patcher ? bridge.patcher.isInstalled() : false
              })
            }
          }, 15000)
          if (typeof bridge.watchdogTimer.unref === 'function') bridge.watchdogTimer.unref()
        } else {
          runSelfTest('app-ready')
        }
      }
    } catch (error) {
      fail('app-ready', error)
    }
  }

  function safeAppPath(name) {
    try {
      if (api.app && typeof api.app.getPath === 'function') return api.app.getPath(name)
    } catch (_error) {
      /* ignore */
    }
    return null
  }

  function onWillQuit() {
    try {
      bridge.stopped = false
      stop('will-quit')
    } catch (error) {
      fail('will-quit', error)
    }
  }

  function start() {
    if (bridge.started) return diagnostics()
    bridge.started = true
    logger.log('hook-loaded', {
      version,
      pid: process.pid,
      electron: electronVersions(),
      dataDir,
      hookDir,
      testMode,
      timersEnabled,
      platform: process.platform,
      appName: safeAppName(),
      argv: Array.isArray(process.argv) ? process.argv.slice(0, 3) : []
    })
    logger.diag('hook-loaded', {
      version,
      pid: process.pid,
      electron: electronVersions(),
      dataDir,
      hookDir,
      testMode,
      timersEnabled,
      platform: process.platform,
      appName: safeAppName()
    })

    try {
      bridge.patcher = createTrayPatcher({
        Tray: api.Tray,
        log: (message, data) => logger.log(message, data)
      })
      bridge.patcher.onCapture(handleCapture)
      const installed = bridge.patcher.install()
      logger.log('tray-patch', installed)
      logger.diag('tray-patch', installed)
    } catch (error) {
      fail('tray-patch-install', error)
      bridge.patcher = null
    }

    try {
      const loaded = loadCursor(dataDir)
      bridge.cursor = loaded.cursor
      bridge.cursorLoaded = loaded.loaded
      bridge.baselinePending = !loaded.loaded
      logger.log('cursor-loaded', {
        loaded: loaded.loaded,
        error: loaded.error || null,
        seen: loaded.cursor.seenEventIds.length,
        lastNotifyAt: loaded.cursor.lastNotifyAt
      })
    } catch (error) {
      fail('cursor-load', error)
      bridge.baselinePending = true
    }

    try {
      bridge.windows = createWindowHelper({
        BrowserWindow: api.BrowserWindow,
        app: api.app,
        log: (message, data) => logger.log(message, data),
        getWebOrigin: () => (bridge.lastState && bridge.lastState.webOrigin) || ''
      })
    } catch (error) {
      fail('window-helper', error)
    }

    try {
      bridge.willQuitHandler = onWillQuit
      if (api.app && typeof api.app.on === 'function') api.app.on('will-quit', bridge.willQuitHandler)
    } catch (error) {
      fail('will-quit-listener', error)
    }

    try {
      if (api.app && typeof api.app.whenReady === 'function') {
        const ready = api.app.whenReady()
        if (ready && typeof ready.then === 'function') {
          ready.then(onAppReady).catch((error) => fail('app-ready-promise', error))
        } else {
          onAppReady()
        }
      } else {
        onAppReady()
      }
    } catch (error) {
      fail('when-ready', error)
    }

    try {
      readAndApplyState('startup')
    } catch (error) {
      fail('startup-poll', error)
    }

    try {
      writeHeartbeatNow('startup')
    } catch (error) {
      fail('heartbeat-startup', error)
    }

    if (timersEnabled) {
      try {
        bridge.pollTimer = setInterval(() => {
          try {
            readAndApplyState('interval')
          } catch (error) {
            fail('poll-interval', error)
          }
        }, LIMITS.pollMs)
        if (typeof bridge.pollTimer.unref === 'function') bridge.pollTimer.unref()
      } catch (error) {
        fail('poll-timer', error)
      }
      try {
        bridge.heartbeatTimer = setInterval(() => {
          try {
            writeHeartbeatNow('interval')
          } catch (error) {
            fail('heartbeat-interval', error)
          }
        }, LIMITS.heartbeatMs)
        if (typeof bridge.heartbeatTimer.unref === 'function') bridge.heartbeatTimer.unref()
      } catch (error) {
        fail('heartbeat-timer', error)
      }
      if (bridge.testMode && Number.isFinite(testExitMs)) {
        try {
          bridge.exitTimer = setTimeout(() => {
            try {
              logger.diag('test-exit', { afterMs: testExitMs })
              try {
                api.app.exit(0)
              } catch (_error) {
                process.exit(0)
              }
            } catch (_error) {
              /* ignore */
            }
          }, testExitMs)
          logger.diag('test-exit-scheduled', { afterMs: testExitMs })
        } catch (error) {
          fail('test-exit-timer', error)
        }
      }
    }

    return diagnostics()
  }

  function stop(reason = 'stop') {
    try {
      if (bridge.stopped) return diagnostics()
      bridge.stopped = true
      for (const timer of [bridge.pollTimer, bridge.heartbeatTimer]) {
        if (timer) {
          try {
            clearInterval(timer)
          } catch (_error) {
            /* ignore */
          }
        }
      }
      for (const timer of [bridge.menuTimer, bridge.exitTimer, bridge.selfTestTimer, bridge.watchdogTimer]) {
        if (timer) {
          try {
            clearTimeout(timer)
          } catch (_error) {
            /* ignore */
          }
        }
      }
      persistCursor('stop')
      try {
        if (bridge.patcher) bridge.patcher.restore()
      } catch (_error) {
        /* ignore */
      }
      try {
        if (api.app && typeof api.app.removeListener === 'function' && bridge.willQuitHandler) {
          api.app.removeListener('will-quit', bridge.willQuitHandler)
        }
      } catch (_error) {
        /* ignore */
      }
      logger.log('hook-stopped', { reason })
      return diagnostics()
    } catch (error) {
      fail('stop', error)
      return diagnostics()
    }
  }

  /**
   * Ask the hook to close the Node inspector so the injected debugging port does
   * not stay open for the app lifetime. `inspector.close()` blocks until all CDP
   * clients disconnect, so it is scheduled shortly after the injector disconnects.
   */
  function finalize(options = {}) {
    try {
      const keep = options.keepInspector === true || parseEnvFlag(env[ENV.keepInspector], false)
      if (keep) {
        bridge.inspectorClose = 'kept'
        logger.log('inspector-kept', { reason: 'DSH_TRAY_FOLLOWER_KEEP_INSPECTOR or finalize option' })
        logger.diag('inspector-kept', {})
        return { closed: false, kept: true, inspectorClose: bridge.inspectorClose }
      }
      bridge.inspectorClose = 'scheduled'
      logger.log('inspector-close-scheduled')
      logger.diag('inspector-close-scheduled', {})
      const closeDelayMs = Number.isFinite(options.delayMs) ? Math.max(200, options.delayMs) : 1500
      const schedule = () => {
        try {
          const inspector = process.getBuiltinModule ? process.getBuiltinModule('node:inspector') : null
          if (!inspector || typeof inspector.close !== 'function') {
            bridge.inspectorClose = 'unsupported'
            logger.log('inspector-close-unsupported')
            return
          }
          inspector.close()
          bridge.inspectorClose = 'closed'
          logger.log('inspector-closed')
        } catch (error) {
          bridge.inspectorClose = 'error'
          fail('inspector-close', error)
        }
      }
      if (typeof setTimeout === 'function') setTimeout(schedule, closeDelayMs)
      return { closed: 'scheduled', delayMs: closeDelayMs, inspectorClose: bridge.inspectorClose }
    } catch (error) {
      fail('finalize', error)
      return { closed: false, error: describeError(error) }
    }
  }

  function diagnostics() {
    const state = bridge.lastState
    const stats = (state && state.stats) || {}
    const statusCounts = (stats && stats.statusCounts) || {}
    const captured = bridge.patcher && typeof bridge.patcher.captured === 'function' ? bridge.patcher.captured() : null
    return toJsonSafe({
      ok: true,
      version,
      started: bridge.started,
      stopped: bridge.stopped,
      startedAt: bridge.startedAt,
      now: now(),
      dataDir,
      hookDir,
      testMode,
      platform: process.platform,
      electron: electronVersions(),
      appReady: bridge.appReady,
      patched: bridge.patcher ? bridge.patcher.isInstalled() === true : false,
      patchedAt: bridge.patcher ? bridge.patcher.installedAt() : 0,
      trayAdopted: bridge.adopted.length > 0,
      adoptedTrayCount: bridge.adopted.length,
      capturedOriginal: bridge.originalSource,
      capturedItemCount: Array.isArray(bridge.originalTemplate) ? bridge.originalTemplate.length : 0,
      capturedAt: captured ? captured.at : 0,
      menuRebuilds: bridge.menuRebuilds,
      lastMenuSignatureLength: typeof bridge.lastMenuSignature === 'string' ? bridge.lastMenuSignature.length : 0,
      state: {
        available: state !== null,
        error: bridge.lastStateError,
        updatedAt: state ? state.updatedAt : 0,
        hostPid: state ? state.hostPid : 0,
        webOrigin: state ? state.webOrigin : '',
        workspaces: state ? state.workspaces.length : 0,
        sessions: stats.sessions || 0,
        running: stats.running || 0,
        pending: stats.pending || 0,
        unreadEvents: state ? state.unreadEvents.length : 0,
        statusCounts
      },
      cursor: {
        loaded: bridge.cursorLoaded,
        seen: bridge.cursor.seenEventIds.length,
        lastNotifyAt: bridge.cursor.lastNotifyAt
      },
      /** Effective contract-v2 settings (defaults when the state file is v1/absent). */
      options: {
        tray: state && state.options ? state.options.tray : DEFAULT_OPTIONS.tray,
        notifications: state && state.options ? state.options.notifications : DEFAULT_OPTIONS.notifications
      },
      notifications: {
        shown: bridge.notificationsShown,
        retained: bridge.notifications.length,
        /** Product requirement: attribution = DSH app, via in-process Electron API. */
        provider: 'electron-main-process',
        supported:
          api.Notification && typeof api.Notification.isSupported === 'function'
            ? (() => {
                try {
                  return api.Notification.isSupported() === true
                } catch (_error) {
                  return null
                }
              })()
            : null
      },
      heartbeat: {
        ok: bridge.heartbeatOk,
        at: bridge.heartbeatAt,
        path: bridge.heartbeatPath
      },
      inspectorClose: bridge.inspectorClose,
      lastPollAt: bridge.lastPollAt,
      recentErrors: bridge.recentErrors
    })
  }

  const handle = {
    version,
    start,
    adopt,
    diagnostics,
    finalize,
    stop,
    /** Force one state poll now (tests / manual probing). */
    pollNow(reason = 'manual') {
      try {
        readAndApplyState(reason)
        return diagnostics()
      } catch (error) {
        fail('poll-now', error)
        return diagnostics()
      }
    },
    /** Force a menu rebuild now (tests / manual probing). */
    rebuildNow(reason = 'manual') {
      return rebuildMenu(reason)
    },
    get logPath() {
      return logger && typeof logger.filePath === 'string' ? logger.filePath : path.join(dataDir, 'bridge.log')
    },
    get diagnosticsObject() {
      return diagnostics
    }
  }
  Object.defineProperty(handle, '__internal', {
    enumerable: false,
    configurable: false,
    value: {
      bridge,
      logger,
      get patcher() {
        return bridge.patcher
      },
      get windows() {
        return bridge.windows
      },
      fail
    }
  })
  return handle
}

module.exports = {
  VERSION,
  DATA_DIR_NAME,
  ENV,
  LIMITS,
  resolveDataDir,
  createBridge
}
