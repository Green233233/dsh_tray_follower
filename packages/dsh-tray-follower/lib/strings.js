/**
 * Runtime strings for status details and notifications.
 *
 * The bundle keeps `locale/en.json` / `locale/zh.json` for plugin metadata
 * (`meta.title`, `meta.description`), which the plugin manager reads without
 * activating the plugin. The Host runtime strings live here instead: the Host
 * cannot query the Web GUI language and must resolve a language on its own.
 *
 * Language resolution order (see index.js):
 *   DSH_TRAY_FOLLOWER_LANG → DSH_LOCALE → LC_ALL/LC_MESSAGES/LANG →
 *   Intl resolved locale → 'en'.
 */

/** @typedef {'en' | 'zh'} Language */

const EN = {
  detailThinking: 'Thinking',
  detailTool: 'Running {tool}',
  detailGoalActive: 'Working on goal',
  detailCompleted: 'Completed',
  detailFailed: 'Failed',
  detailIdle: 'Idle',
  waitApproval: 'Waiting for approval: {tool}',
  waitChoice: 'Waiting for your choice: {text}',
  waitInput: 'Waiting for your input: {text}',
  waitGeneric: 'Waiting for you',
  completedTitle: 'Task completed',
  failedTitle: 'Task failed',
  attentionTitle: 'Action needed',
  goalCompletedTitle: 'Goal completed',
  goalBlockedTitle: 'Goal blocked',
  otherConversations: 'Other conversations',
  untitledSession: 'Untitled conversation',
  runningTool: 'Running {tool}',
  errorFallback: 'The conversation stopped with an error',
}

const ZH = {
  detailThinking: '正在思考',
  detailTool: '正在执行 {tool}',
  detailGoalActive: '目标执行中',
  detailCompleted: '已完成',
  detailFailed: '已失败',
  detailIdle: '空闲',
  waitApproval: '等待批准：{tool}',
  waitChoice: '等待你的选择：{text}',
  waitInput: '等待你的输入：{text}',
  waitGeneric: '等待你的操作',
  completedTitle: '任务完成',
  failedTitle: '任务失败',
  attentionTitle: '需要你的操作',
  goalCompletedTitle: '目标完成',
  goalBlockedTitle: '目标受阻',
  otherConversations: '其他会话',
  untitledSession: '未命名会话',
  runningTool: '正在执行 {tool}',
  errorFallback: '对话因错误而停止',
}

const TABLES = { en: EN, zh: ZH }

/** Supported runtime languages. */
export const LANGUAGES = Object.freeze(['en', 'zh'])

/**
 * Normalize an arbitrary locale tag to a supported language.
 * @param {unknown} value raw tag such as `zh-CN`, `en_US`, `zh`.
 * @returns {'en' | 'zh'}
 */
export function normalizeLanguage(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return text.startsWith('zh') ? 'zh' : 'en'
}

/**
 * Replace `{name}` placeholders; unknown placeholders are left as written.
 * @param {string} template
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function format(template, params) {
  if (params === undefined || params === null) return String(template)
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ))
}

/**
 * Build the string table used by the tracker and notifications.
 * @param {string} [language]
 * @returns {{ lang: 'en' | 'zh', text: (key: string, params?: Record<string, unknown>) => string }}
 */
export function createStrings(language) {
  const lang = normalizeLanguage(language)
  const table = TABLES[lang]
  return {
    lang,
    text(key, params) {
      const template = table[key] ?? TABLES.en[key] ?? key
      return format(template, params)
    },
  }
}
