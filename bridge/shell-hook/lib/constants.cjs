'use strict'

/**
 * Shared constants for the dsh-tray-follower shell bridge.
 *
 * The bridge is injected into the DSH Desktop Electron *main process* through the
 * Node inspector (see bridge/injector/). It reads the state file written by the
 * DSH host plugin (docs/DESIGN.md §4), extends the system tray context menu and
 * raises native Electron notifications.
 */

const VERSION = '0.1.0'

/** State contract version owned by the plugin half (docs/DESIGN.md §4). */
const SCHEMA_VERSION = 1

/** Data directory name under %LOCALAPPDATA%. */
const DATA_DIR_NAME = 'dsh-tray-follower'

/** Environment variables understood by the hook. */
const ENV = Object.freeze({
  dataDir: 'DSH_TRAY_FOLLOWER_DIR',
  test: 'DSH_TRAY_FOLLOWER_TEST',
  testExitMs: 'DSH_TRAY_FOLLOWER_TEST_EXIT_MS',
  testShowNotification: 'DSH_TRAY_FOLLOWER_TEST_SHOW_NOTIFICATION',
  keepInspector: 'DSH_TRAY_FOLLOWER_KEEP_INSPECTOR',
  inspectPort: 'DSH_TRAY_FOLLOWER_INSPECT_PORT',
  desktopExe: 'DSH_DESKTOP_EXE'
})

/** Every status the host plugin may publish. Unknown values fall back to `idle`. */
const STATUS_GLYPHS = Object.freeze({
  running: '▶',
  'waiting-approval': '⏸',
  'waiting-choice': '❓',
  'waiting-input': '⌨',
  completed: '✓',
  failed: '✖',
  idle: '○'
})

/** Statuses that mean "a human is needed". */
const PENDING_STATUSES = Object.freeze(['waiting-approval', 'waiting-choice', 'waiting-input'])

const DEFAULT_STATUS = 'idle'

/** Unread event kinds from the state contract. */
const EVENT_KINDS = Object.freeze(['completed', 'failed', 'needs-attention'])

const EVENT_KIND_TITLES = Object.freeze({
  completed: '任务完成',
  failed: '任务失败',
  'needs-attention': '需要关注'
})

const LIMITS = Object.freeze({
  logBytes: 1024 * 1024,
  stateBytes: 2 * 1024 * 1024,
  cursorBytes: 256 * 1024,
  pollMs: 1000,
  heartbeatMs: 5000,
  menuDebounceMs: 80,
  notifyMinIntervalMs: 2000,
  notifyMaxBodyLines: 5,
  seenCap: 500,
  maxWorkspaces: 50,
  maxSessionsPerWorkspace: 100,
  /** Inline "active" rows (waiting/running/completed/failed) per workspace. */
  maxActiveSessionsPerWorkspace: 6,
  /** Idle sessions listed inside the per-workspace "空闲会话 (N)" submenu. */
  maxIdleSessionsPerWorkspace: 10,
  maxUnreadEvents: 200,
  titleChars: 48,
  sessionTitleChars: 40,
  workspaceTitleChars: 40,
  footerChars: 80,
  recentErrors: 10,
  notificationsKept: 10
})

/**
 * Localized menu strings. `zh` is used when Electron's locale starts with "zh",
 * `en` otherwise. Keep the menu brief: per workspace at most
 * `LIMITS.maxActiveSessionsPerWorkspace` active rows plus one collapsed
 * "idle sessions (N)" submenu for the (usually numerous) idle history.
 */
const UI_STRINGS = Object.freeze({
  zh: Object.freeze({
    header: (running, pending) => `对话：${running} 运行 / ${pending} 待处理`,
    workspace: (prefix, title, running, pending) => `${prefix}${title}  运行 ${running} · 待处理 ${pending}`,
    idleGroup: (count) => `空闲会话 (${count})`,
    overflow: (count) => `… 还有 ${count} 个会话`,
    noSessions: '（无对话）',
    noWorkspaces: '（暂无工作区）',
    waitingState: '（等待插件数据…）',
    footer: (version) => `dsh-tray-follower v${version}`,
    unknownSession: '未命名对话',
    unknownWorkspace: '未命名工作区'
  }),
  en: Object.freeze({
    header: (running, pending) => `Conversations: ${running} running / ${pending} pending`,
    workspace: (prefix, title, running, pending) => `${prefix}${title}  running ${running} · pending ${pending}`,
    idleGroup: (count) => `Idle sessions (${count})`,
    overflow: (count) => `… ${count} more sessions`,
    noSessions: '(no conversations)',
    noWorkspaces: '(no workspaces)',
    waitingState: '(waiting for plugin data…)',
    footer: (version) => `dsh-tray-follower v${version}`,
    unknownSession: 'Untitled conversation',
    unknownWorkspace: 'Untitled workspace'
  })
})

/** Backwards-compatible alias for the Chinese menu strings. */
const LABELS = UI_STRINGS.zh

/**
 * Labels used when the shell's own tray menu was never captured (late injection /
 * adoption): the original items cannot be recovered, so equivalents are built.
 */
const RECONSTRUCTED_ITEM_LABELS = Object.freeze({
  zh: Object.freeze({
    open: (appName) => `打开 ${appName}`,
    quit: (appName) => `退出 ${appName}`
  }),
  en: Object.freeze({
    open: (appName) => `Open ${appName}`,
    quit: (appName) => `Quit ${appName}`
  })
})

/** Reduce an Electron locale ("zh-CN", "en-US", ...) to a label family. */
function localeFamily(locale) {
  const value = typeof locale === 'string' ? locale.toLowerCase() : ''
  return value.startsWith('zh') ? 'zh' : 'en'
}

/** Localized menu strings for a locale (Chinese for zh*, English otherwise). */
function stringsFor(locale) {
  return UI_STRINGS[localeFamily(locale)] || UI_STRINGS.en
}

module.exports = {
  VERSION,
  SCHEMA_VERSION,
  DATA_DIR_NAME,
  ENV,
  STATUS_GLYPHS,
  PENDING_STATUSES,
  DEFAULT_STATUS,
  EVENT_KINDS,
  EVENT_KIND_TITLES,
  LIMITS,
  LABELS,
  UI_STRINGS,
  stringsFor,
  RECONSTRUCTED_ITEM_LABELS,
  localeFamily
}
