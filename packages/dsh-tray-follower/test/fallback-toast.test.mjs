import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  POWERSHELL_AUMID,
  TOAST_GROUP,
  buildToastScript,
  buildToastXml,
  chooseLaunch,
  encodePowerShell,
  escapeXml,
  isDesktopHosted,
  powershellPath,
  sendToast,
  toastTag,
} from '../lib/fallback-toast.js'

test('escapeXml escapes every XML-significant character', () => {
  assert.equal(escapeXml(`<a & "b" 'c'>`), '&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;')
})

test('buildToastXml produces a ToastGeneric document with optional protocol launch', () => {
  const xml = buildToastXml({ title: '任务完成', body: '工作区 • 会话', launch: 'dsh://open', silent: true })
  assert.match(xml, /^<toast activationType="protocol" launch="dsh:\/\/open">/)
  assert.match(xml, /<binding template="ToastGeneric">/)
  assert.match(xml, /<text>任务完成<\/text>/)
  assert.match(xml, /<text>工作区 • 会话<\/text>/)
  assert.match(xml, /<audio silent="true"\/>/)
  assert.match(xml, /<\/toast>$/)

  const inert = buildToastXml({ title: 't', body: 'b' })
  assert.ok(!inert.includes('activationType'))
  assert.match(inert, /ms-winsoundevent:Notification.Default/)
})

test('buildToastScript targets WinRT with tag/group and encodes safely', () => {
  const script = buildToastScript({
    title: `Quote ' and "`,
    body: 'Line',
    tag: 'abc123',
    group: TOAST_GROUP,
    launch: 'dsh://open',
  })
  assert.ok(script.includes('[Windows.UI.Notifications.ToastNotificationManager'))
  assert.ok(script.includes('[Windows.Data.Xml.Dom.XmlDocument'))
  assert.ok(script.includes('$toast.Tag = \'abc123\''))
  assert.ok(script.includes(`$toast.Group = '${TOAST_GROUP}'`))
  assert.ok(script.includes(POWERSHELL_AUMID))
  // The XML body escapes the quote glyphs, so the PowerShell single-quoted
  // literal has no internal quotes left to double.
  assert.ok(script.includes('Quote &apos; and &quot;'))

  const encoded = encodePowerShell(script)
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script)
})

test('toastTag is short, stable and per-event unique', () => {
  const tag = toastTag('evt_abc')
  assert.equal(tag, toastTag('evt_abc'))
  assert.ok(tag.length <= 16)
  assert.notEqual(tag, toastTag('evt_abd'))
})

test('isDesktopHosted and chooseLaunch pick protocol → origin → inert', () => {
  assert.equal(isDesktopHosted({ ELECTRON_RUN_AS_NODE: '1' }, { electron: '35.0.0' }), true)
  assert.equal(isDesktopHosted({}, { electron: '35.0.0' }), false)
  assert.equal(isDesktopHosted({ ELECTRON_RUN_AS_NODE: '1' }, {}), false)

  assert.equal(chooseLaunch({ env: { ELECTRON_RUN_AS_NODE: '1' }, versions: { electron: '1' }, webOrigin: 'http://127.0.0.1:1' }), 'dsh://open')
  assert.equal(chooseLaunch({ env: {}, versions: {}, webOrigin: 'http://127.0.0.1:61983' }), 'http://127.0.0.1:61983')
  assert.equal(chooseLaunch({ env: {}, versions: {}, webOrigin: 'not a url' }), undefined)
  assert.equal(chooseLaunch({ env: {}, versions: {} }), undefined)
})

test('powershellPath uses %SystemRoot%', () => {
  assert.equal(
    powershellPath({ SystemRoot: 'D:\\Windows' }),
    'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  )
})

test('sendToast is a silent no-op off Windows', async () => {
  let spawned = false
  const result = await sendToast({
    title: 't',
    body: 'b',
    platform: 'linux',
    spawnFn: () => {
      spawned = true
      throw new Error('must not spawn')
    },
  })
  assert.equal(result, false)
  assert.equal(spawned, false)
})

test('sendToast spawns Windows PowerShell with -EncodedCommand and resolves on exit 0', async () => {
  const calls = []
  const spawnFn = (file, args) => {
    calls.push({ file, args })
    const child = new EventEmitter()
    child.unref = () => {}
    setImmediate(() => child.emit('exit', 0))
    return child
  }
  const result = await sendToast({
    title: 'Task completed',
    body: 'dsh_tray_follower • Configure Git',
    eventId: 'evt_123',
    webOrigin: 'http://127.0.0.1:61983',
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    versions: {},
    spawnFn,
  })
  assert.equal(result, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.ok(calls[0].args.includes('-EncodedCommand'))
  assert.ok(calls[0].args.includes('-NoProfile'))
  const encoded = calls[0].args[calls[0].args.indexOf('-EncodedCommand') + 1]
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
  assert.ok(decoded.includes('Task completed'))
  assert.ok(decoded.includes('dsh_tray_follower • Configure Git'))
  assert.ok(decoded.includes('evt_123') === false) // only the tag goes into the script
  assert.ok(decoded.includes('launch="http://127.0.0.1:61983"'))
})

test('sendToast returns false on spawn error or a non-zero exit', async () => {
  const spawnError = () => {
    const child = new EventEmitter()
    child.unref = () => {}
    setImmediate(() => child.emit('error', new Error('ENOENT')))
    return child
  }
  assert.equal(await sendToast({ title: 't', platform: 'win32', env: {}, spawnFn: spawnError }), false)

  const spawnNonZero = () => {
    const child = new EventEmitter()
    child.unref = () => {}
    setImmediate(() => child.emit('exit', 1))
    return child
  }
  assert.equal(await sendToast({ title: 't', platform: 'win32', env: {}, spawnFn: spawnNonZero }), false)

  const spawnThrows = () => {
    throw new Error('no spawn')
  }
  assert.equal(await sendToast({ title: 't', platform: 'win32', env: {}, spawnFn: spawnThrows }), false)
})
