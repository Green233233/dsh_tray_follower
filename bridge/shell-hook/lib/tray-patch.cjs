'use strict'

const { safeJsonStringify, toJsonSafe } = require('./util.cjs')

/**
 * Tray patcher for the DSH Desktop Electron main process.
 *
 * The DSH shell creates one `Tray` and rebuilds its context menu inside
 * `DesktopTray.relabel()` (see docs/recon/NOTES.md §2). There is no extension API,
 * so the bridge monkey-patches `Tray.prototype.setContextMenu`:
 *
 *  - every *external* call captures the tray instance plus the original menu items
 *    (labels/types/clicks/roles) into a plain rebuildable template;
 *  - the bridge itself rebuilds the menu through `applyMenu()`, which calls the
 *    original method directly so it can never recurse into the capture path.
 *
 * The module is intentionally Electron-instance agnostic: `Tray` and the original
 * method are injected, which lets the self-test exercise it with fakes.
 */

const PATCH_MARKER = '__dshTrayFollowerPatched'
const ORIGINAL_MARKER = '__dshTrayFollowerOriginal'

/** Describe one Electron `MenuItem` as a plain template object (JSON-safe). */
function menuItemToTemplate(item, log) {
  if (!item || typeof item !== 'object') return null
  if (item.type === 'separator') return { type: 'separator' }

  const template = {}
  if (typeof item.type === 'string' && item.type !== 'normal') template.type = item.type
  if (typeof item.label === 'string') template.label = item.label
  if (typeof item.role === 'string') template.role = item.role
  if (typeof item.accelerator === 'string' && item.accelerator) template.accelerator = item.accelerator
  if (typeof item.enabled === 'boolean') template.enabled = item.enabled
  if (typeof item.visible === 'boolean') template.visible = item.visible
  if (typeof item.checked === 'boolean') template.checked = item.checked
  if (typeof item.click === 'function') {
    const originalClick = item.click
    const capturedItem = item
    template.click = function bridgedClick(menuItem, browserWindow, event) {
      try {
        return originalClick(capturedItem, browserWindow, event)
      } catch (error) {
        if (typeof log === 'function') log('menu-click-failed', { error: toJsonSafe(error) })
        return undefined
      }
    }
  }
  if (item.submenu && Array.isArray(item.submenu.items)) {
    const submenu = []
    for (const child of item.submenu.items) {
      const childTemplate = menuItemToTemplate(child, log)
      if (childTemplate) submenu.push(childTemplate)
    }
    if (submenu.length > 0) template.submenu = submenu
  }
  return template
}

/** Convert an Electron `Menu` instance into a plain rebuildable template. */
function menuToTemplate(menu, log) {
  if (!menu || typeof menu !== 'object' || !Array.isArray(menu.items)) return []
  const template = []
  for (const item of menu.items) {
    const converted = menuItemToTemplate(item, log)
    if (converted) template.push(converted)
  }
  return template
}

/** Plain description of a template for logs/diagnostics. */
function describeTemplate(template) {
  if (!Array.isArray(template)) return []
  return template.map((item) => {
    if (!item || typeof item !== 'object') return { type: 'unknown' }
    const description = {
      type: typeof item.type === 'string' ? item.type : 'normal',
      label: typeof item.label === 'string' ? item.label : '',
      enabled: item.enabled !== false
    }
    if (typeof item.role === 'string') description.role = item.role
    if (Array.isArray(item.submenu)) description.submenu = describeTemplate(item.submenu)
    const sanitized = toJsonSafe(description)
    return sanitized === null ? { type: 'unknown' } : sanitized
  })
}

/** True when a captured/adopted object still looks like a usable Tray. */
function isUsableTray(tray) {
  if (!tray || typeof tray !== 'object') return false
  if (typeof tray.setContextMenu !== 'function') return false
  try {
    if (typeof tray.isDestroyed === 'function' && tray.isDestroyed() === true) return false
  } catch (_error) {
    return false
  }
  return true
}

/** Best-effort tooltip read (diagnostics only). */
function safeTooltip(tray) {
  try {
    if (tray && typeof tray.getToolTip === 'function') return String(tray.getToolTip() || '')
  } catch (_error) {
    /* ignore */
  }
  return ''
}

/**
 * Install the `Tray.prototype.setContextMenu` patch.
 *
 * @param {object} options
 * @param {Function} options.Tray Electron Tray constructor
 * @param {(message: string, data?: object) => void} [options.log]
 * @returns {object} patcher handle
 */
function createTrayPatcher(options = {}) {
  const Tray = options.Tray
  const log = typeof options.log === 'function' ? options.log : () => {}
  const captureHandlers = []
  let captured = null
  let installed = false
  let original = null
  let patchInstalledAt = 0
  /** Re-entrancy guard: true while the bridge applies its own merged menu. */
  let applying = false
  /** The last menu instance the bridge applied (must never be captured as original). */
  let lastAppliedMenu = null

  function notifyCaptured(record) {
    for (const handler of captureHandlers) {
      try {
        handler(record)
      } catch (error) {
        log('tray-capture-handler-failed', { error: toJsonSafe(error) })
      }
    }
  }

  function patchedSetContextMenu(menu) {
    // Only external (shell) calls may become the "original" template. Calls made
    // by the bridge itself — via applyMenu below, or re-entrantly through this
    // patched prototype method — must never be captured, otherwise the merged
    // status section would be re-appended on every rebuild (duplicate growth).
    if (applying || (lastAppliedMenu !== null && menu === lastAppliedMenu)) {
      return original.call(this, menu)
    }
    // Apply the shell's menu first: when the bridge rebuilds synchronously (e.g.
    // in tests / immediate-adoption paths) the combined menu must win, not be
    // overwritten by the original call afterwards.
    let originalError = null
    let result
    try {
      result = original.call(this, menu)
    } catch (error) {
      originalError = error
    }
    try {
      const record = {
        tray: this,
        menu,
        template: menuToTemplate(menu, log),
        tooltip: safeTooltip(this),
        at: Date.now()
      }
      captured = record
      if (log) {
        log('tray-set-context-menu-captured', {
          items: record.template.length,
          tooltip: record.tooltip,
          labels: record.template.map((item) => (typeof item.label === 'string' ? item.label : `[${item.type || 'normal'}]`))
        })
      }
      notifyCaptured(record)
    } catch (error) {
      log('tray-capture-failed', { error: toJsonSafe(error) })
    }
    if (originalError) throw originalError
    return result
  }

  function install() {
    if (installed) return { ok: true, alreadyInstalled: true }
    if (!Tray || typeof Tray.prototype !== 'object' || !Tray.prototype) {
      return { ok: false, error: 'Tray.prototype unavailable' }
    }
    const current = Tray.prototype.setContextMenu
    if (typeof current !== 'function') {
      return { ok: false, error: 'Tray.prototype.setContextMenu is not a function' }
    }
    // Re-injection safety: reuse the previous original when already patched.
    original = typeof current[ORIGINAL_MARKER] === 'function' ? current[ORIGINAL_MARKER] : current
    patchedSetContextMenu[PATCH_MARKER] = true
    patchedSetContextMenu[ORIGINAL_MARKER] = original
    try {
      Tray.prototype.setContextMenu = patchedSetContextMenu
    } catch (error) {
      return { ok: false, error: `patch assignment failed: ${toJsonSafe(error)}` }
    }
    installed = Tray.prototype.setContextMenu === patchedSetContextMenu
    patchInstalledAt = Date.now()
    return { ok: installed, alreadyInstalled: false, patched: installed }
  }

  function restore() {
    if (!installed || !Tray) return { ok: false, restored: false }
    try {
      Tray.prototype.setContextMenu = original
      installed = false
      return { ok: true, restored: true }
    } catch (error) {
      log('tray-unpatch-failed', { error: toJsonSafe(error) })
      return { ok: false, restored: false }
    }
  }

  return {
    install,
    restore,
    onCapture(handler) {
      if (typeof handler === 'function') captureHandlers.push(handler)
    },
    captured() {
      return captured
    },
    isInstalled() {
      return installed
    },
    installedAt() {
      return patchInstalledAt
    },
    /** Apply a bridge-built menu without re-entering the capture path. */
    applyMenu(tray, menu) {
      if (typeof original !== 'function') return { ok: false, error: 'patcher not installed' }
      if (!isUsableTray(tray)) return { ok: false, error: 'tray unusable' }
      if (!menu || typeof menu !== 'object') return { ok: false, error: 'menu required' }
      applying = true
      try {
        original.call(tray, menu)
        lastAppliedMenu = menu
        return { ok: true, tooltip: safeTooltip(tray) }
      } catch (error) {
        return { ok: false, error: safeJsonStringify(toJsonSafe(error)) }
      } finally {
        applying = false
      }
    },
    menuToTemplate,
    describeTemplate
  }
}

module.exports = {
  PATCH_MARKER,
  ORIGINAL_MARKER,
  menuItemToTemplate,
  menuToTemplate,
  describeTemplate,
  isUsableTray,
  safeTooltip,
  createTrayPatcher
}
