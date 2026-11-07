#!/usr/bin/env node
// Feasibility probe: attach to a *separate* paused DSH Desktop instance through
// its Node inspector (--inspect-brk) and check that we can evaluate in the
// Electron main process, reach the `electron` module, and patch Tray.prototype.
//
// Safe by construction: launches DSH with an isolated --user-data-dir and no
// ELECTRON_RUN_AS_NODE, checks `--inspect-brk` is honored, then kills the probe
// instance. It never touches the running DSH instance.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EXE = 'C:\\Users\\Green\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'
const PORT = 9451
const TIMEOUT_MS = 60_000

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inspector-probe-'))
const results = []
function log(step, data) {
  const line = `[${new Date().toISOString()}] ${step} ${data === undefined ? '' : JSON.stringify(data)}`
  results.push(line)
  console.log(line)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.ELECTRON_NO_ATTACH_CONSOLE

const child = spawn(EXE, [`--inspect-brk=127.0.0.1:${PORT}`, `--user-data-dir=${path.join(tmp, 'userdata')}`], {
  env,
  stdio: 'ignore',
  windowsHide: false,
  detached: false,
})
log('spawn', { pid: child.pid, tmp })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTarget() {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`probe instance exited early: ${child.exitCode}`)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      if (Array.isArray(list) && list[0]?.webSocketDebuggerUrl) return list[0].webSocketDebuggerUrl
    } catch {}
    await sleep(150)
  }
  throw new Error('inspector endpoint never appeared')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    })
  }
  call(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`))
      }, 15_000)
    })
  }
  async evaluate(expression) {
    const res = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    })
    if (res.exceptionDetails) return { error: res.exceptionDetails.text ?? 'evaluation threw', detail: res.exceptionDetails.exception?.description }
    return { value: res.result?.value }
  }
}

async function main() {
  const wsUrl = await findTarget()
  log('inspector-target', { wsUrl })
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const cdp = new Cdp(ws)
  await cdp.call('Runtime.enable')

  const ping = await cdp.evaluate('({ pid: process.pid, electron: process.versions.electron, node: process.versions.node, mainScript: process.argv[1], hasRequire: typeof require })')
  log('runtime', ping)

  const electronProbe = await cdp.evaluate(`(() => {
    try {
      const e = require('electron')
      return { via: 'require', app: typeof e.app, tray: typeof e.Tray, menu: typeof e.Menu, notification: typeof e.Notification, browserWindow: typeof e.BrowserWindow, packaged: e.app ? e.app.isPackaged : 'n/a' }
    } catch (err) {
      return { via: 'require', error: String(err && err.message) }
    }
  })()`)
  log('electron-module', electronProbe)

  const patchProbe = await cdp.evaluate(`(() => {
    try {
      const e = require('electron')
      const d = Object.getOwnPropertyDescriptor(e.Tray.prototype, 'setContextMenu')
      const original = e.Tray.prototype.setContextMenu
      let patched = false
      try {
        e.Tray.prototype.setContextMenu = function (...args) { globalThis.__dshTrayPatched = (globalThis.__dshTrayPatched ?? 0) + 1; return original.apply(this, args) }
        patched = e.Tray.prototype.setContextMenu !== original
        e.Tray.prototype.setContextMenu = original
      } catch (err) { return { patched: false, error: String(err && err.message) } }
      return { descriptor: d ? { writable: d.writable, configurable: d.configurable, kind: d.value ? 'value' : 'accessor' } : null, patched }
    } catch (err) {
      return { error: String(err && err.message) }
    }
  })()`)
  log('tray-patch', patchProbe)

  const externalRequire = await cdp.evaluate(`(async () => {
    try {
      const { createRequire } = await import('node:module')
      const req = createRequire('file:///${tmp.replace(/\\\\/g, '/').replace(/\\/g, '/')}/probe.cjs')
      const e = req('electron')
      return { ok: true, app: typeof e.app, tray: typeof e.Tray }
    } catch (err) {
      return { ok: false, error: String(err && err.message) }
    }
  })()`)
  log('createRequire-electron', externalRequire)

  // Release the paused main process so it can initialize; then quit it.
  await cdp.call('Runtime.runIfWaitingForDebugger').catch((err) => log('runIfWaitingForDebugger', String(err)))
  await sleep(500)
  const quit = await cdp.evaluate(`(() => { try { require('electron').app.exit(0); return 'exit-requested' } catch (err) { return 'exit-failed: ' + String(err && err.message) } })()`)
  log('quit', quit)
  try { ws.close() } catch {}
}

main()
  .catch((error) => log('probe-failed', String((error && error.stack) || error)))
  .finally(async () => {
    await sleep(1500)
    try { if (child.exitCode === null) child.kill() } catch {}
    fs.writeFileSync(path.join(tmp, 'probe-results.log'), results.join('\n') + '\n')
    console.log(`# probe log dir: ${tmp}`)
  })
