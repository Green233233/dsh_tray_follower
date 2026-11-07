/**
 * Fallback Windows toast sender (used only when the desktop bridge heartbeat
 * is missing or older than 15 s).
 *
 * This is an independent WinRT implementation: build a ToastGeneric XML
 * document, hand it to Windows.UI.Notifications from a short-lived
 * `powershell.exe -EncodedCommand` process (encoded command sidesteps every
 * command-line quoting rule, including CJK text and quotes). No-ops on
 * non-Windows and never throws into the DSH event loop.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

/**
 * AppUserModelID of the Start-menu Windows PowerShell shortcut, registered on
 * every Windows 10/11 install, so a helper without its own shortcut can still
 * raise a toast. The desktop app's own AUMID is not reachable from a foreign
 * process, which is exactly why the bridge (in-process `Notification`) is
 * preferred and this is documented as a degraded channel.
 */
export const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Toast group this plugin files its notifications under. */
export const TOAST_GROUP = 'dsh-tray-follower'

/**
 * Escape text for XML attribute/text nodes.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&apos;'
    }
  })
}

/**
 * Windows caps toast tags at 16 characters; derive a stable one per event.
 * @param {unknown} key
 * @returns {string}
 */
export function toastTag(key) {
  return createHash('sha1').update(String(key ?? '')).digest('base64url').slice(0, 16)
}

/**
 * Build the ToastGeneric payload. `launch` makes the toast clickable through a
 * protocol activation (`dsh://open` focuses the desktop app).
 * @param {{ title?: string, body?: string, launch?: string, silent?: boolean }} input
 * @returns {string}
 */
export function buildToastXml(input = {}) {
  const activation = typeof input.launch === 'string' && input.launch !== ''
    ? ` activationType="protocol" launch="${escapeXml(input.launch)}"`
    : ''
  const audio = input.silent === true
    ? '<audio silent="true"/>'
    : '<audio src="ms-winsoundevent:Notification.Default"/>'
  return '<toast' + activation + '><visual><binding template="ToastGeneric">'
    + `<text>${escapeXml(input.title ?? '')}</text>`
    + `<text>${escapeXml(input.body ?? '')}</text>`
    + `</binding></visual>${audio}</toast>`
}

/**
 * Build the PowerShell program executed through `-EncodedCommand`.
 * Kept as a string builder (no execution) so it is unit-testable.
 * @param {{ title?: string, body?: string, launch?: string, tag?: string, group?: string, silent?: boolean }} input
 * @returns {string}
 */
export function buildToastScript(input = {}) {
  const xml = buildToastXml(input)
  const literal = (value) => `'${String(value).replace(/'/gu, "''")}'`
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
    '$document = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$document.LoadXml(${literal(xml)})`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $document',
  ]
  if (typeof input.tag === 'string' && input.tag !== '') lines.push(`$toast.Tag = ${literal(input.tag)}`)
  if (typeof input.group === 'string' && input.group !== '') lines.push(`$toast.Group = ${literal(input.group)}`)
  lines.push(
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${literal(POWERSHELL_AUMID)}).Show($toast)`,
  )
  return lines.join('; ')
}

/**
 * Encode a PowerShell program for `-EncodedCommand` (UTF-16LE base64).
 * @param {string} script
 * @returns {string}
 */
export function encodePowerShell(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64')
}

/**
 * Was the Host started by the DSH desktop shell? Desktop starts it as Electron
 * in Node mode (`ELECTRON_RUN_AS_NODE=1` plus `process.versions.electron`),
 * which is also when `dsh://` protocol activation is registered.
 * @param {Record<string, string | undefined>} [env]
 * @param {Record<string, string | undefined>} [versions]
 * @returns {boolean}
 */
export function isDesktopHosted(env = process.env, versions = process.versions) {
  return Boolean(env && env.ELECTRON_RUN_AS_NODE && versions && versions.electron)
}

/**
 * Pick the click target for a fallback toast: the desktop protocol when it is
 * registered, otherwise the Web GUI origin; `undefined` leaves the toast inert.
 * @param {{ env?: Record<string, string | undefined>, versions?: Record<string, string | undefined>, webOrigin?: string }} [input]
 * @returns {string | undefined}
 */
export function chooseLaunch(input = {}) {
  if (isDesktopHosted(input.env, input.versions)) return 'dsh://open'
  const origin = typeof input.webOrigin === 'string' ? input.webOrigin.trim() : ''
  if (/^https?:\/\//u.test(origin)) return origin
  return undefined
}

/**
 * Locate Windows PowerShell without relying on PATH.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function powershellPath(env = process.env) {
  const root = typeof env.SystemRoot === 'string' && env.SystemRoot !== '' ? env.SystemRoot : 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/**
 * Show one toast. Resolves `false` instead of throwing on every failure path.
 * @param {{
 *   title?: string,
 *   body?: string,
 *   eventId?: string,
 *   webOrigin?: string,
 *   silent?: boolean,
 *   env?: Record<string, string | undefined>,
 *   versions?: Record<string, string | undefined>,
 *   platform?: string,
 *   spawnFn?: typeof spawn,
 * }} [input]
 * @returns {Promise<boolean>}
 */
export function sendToast(input = {}) {
  const platform = input.platform ?? process.platform
  if (platform !== 'win32') return Promise.resolve(false)
  const env = input.env ?? process.env
  const eventId = typeof input.eventId === 'string' && input.eventId !== ''
    ? input.eventId
    : `${input.title ?? ''}|${input.body ?? ''}`
  const script = buildToastScript({
    title: input.title,
    body: input.body,
    launch: chooseLaunch({ env, versions: input.versions ?? process.versions, webOrigin: input.webOrigin }),
    tag: toastTag(eventId),
    group: TOAST_GROUP,
    silent: input.silent === true,
  })
  const encoded = encodePowerShell(script)
  const spawnFn = typeof input.spawnFn === 'function' ? input.spawnFn : spawn
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(powershellPath(env), [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        encoded,
      ], { stdio: 'ignore', windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    if (!child || typeof child.on !== 'function') {
      resolve(false)
      return
    }
    if (typeof child.unref === 'function') child.unref()
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.on('error', () => settle(false))
    child.on('exit', (code) => settle(code === 0))
    // Never hold the Host process open for a toast child.
    const timer = setTimeout(() => settle(false), 4_000)
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
  })
}
