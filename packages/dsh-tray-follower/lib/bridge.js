/**
 * Desktop-bridge heartbeat (`<dataDir>/bridge.json`, `{ pid, ts, version }`).
 *
 * The Host only falls back to its own PowerShell toast when this heartbeat is
 * missing or stale, so the bridge — which knows whether the DSH window is
 * visible/focused — owns notification delivery whenever it is installed.
 * All reads are defensive: a malformed file is "bridge absent", never a crash.
 */
import { readFileSync } from 'node:fs'
import { BRIDGE_STALE_MS } from './constants.js'

/**
 * Parse the heartbeat text.
 * @param {string | Buffer | undefined | null} raw
 * @returns {{ pid?: number, ts: number, version?: string } | undefined}
 */
export function parseHeartbeat(raw) {
  if (raw === undefined || raw === null) return undefined
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')
  if (text.trim() === '') return undefined
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const ts = parsed.ts
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return undefined
  const heartbeat = { ts }
  if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) heartbeat.pid = parsed.pid
  if (typeof parsed.version === 'string') heartbeat.version = parsed.version
  return heartbeat
}

/**
 * Read the heartbeat text, tolerating a missing file.
 * @param {string} filePath
 * @param {{ readFile?: typeof readFileSync }} [options]
 * @returns {string | undefined}
 */
export function readHeartbeatText(filePath, options = {}) {
  const readFile = typeof options.readFile === 'function' ? options.readFile : readFileSync
  try {
    return readFile(filePath, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Is a process with this id alive? `EPERM` proves existence (the process is
 * just owned by someone else); unknown errors are treated as alive so a
 * permission quirk never suppresses bridge delivery.
 * @param {number} pid
 * @returns {boolean}
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) return true
    return false
  }
}

/**
 * Decide whether the bridge is present and fresh.
 * @param {{
 *   raw?: string,
 *   now?: number,
 *   maxAgeMs?: number,
 *   checkPid?: boolean,
 *   pidAlive?: (pid: number) => boolean,
 * }} input
 * @returns {{ available: boolean, reason: string, heartbeat?: { pid?: number, ts: number, version?: string } }}
 */
export function evaluateHeartbeat(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const maxAgeMs = Number.isFinite(input.maxAgeMs) ? input.maxAgeMs : BRIDGE_STALE_MS
  const heartbeat = parseHeartbeat(input.raw)
  if (heartbeat === undefined) return { available: false, reason: 'missing-or-invalid' }
  if (heartbeat.ts > now + 60_000) return { available: false, reason: 'clock-skew', heartbeat }
  if (now - heartbeat.ts > maxAgeMs) return { available: false, reason: 'stale', heartbeat }
  if (input.checkPid === true && heartbeat.pid !== undefined) {
    const alive = typeof input.pidAlive === 'function' ? input.pidAlive : pidAlive
    let running = true
    try {
      running = alive(heartbeat.pid)
    } catch {
      running = true
    }
    if (!running) return { available: false, reason: 'dead-pid', heartbeat }
  }
  return { available: true, reason: 'fresh', heartbeat }
}

/**
 * End-to-end read + evaluation used by the Host.
 * @param {string} heartbeatPath
 * @param {{ now?: number, maxAgeMs?: number, checkPid?: boolean, readFile?: typeof readFileSync, pidAlive?: (pid: number) => boolean }} [options]
 * @returns {{ available: boolean, reason: string, heartbeat?: any }}
 */
export function bridgeAvailable(heartbeatPath, options = {}) {
  return evaluateHeartbeat({
    raw: readHeartbeatText(heartbeatPath, options),
    now: options.now,
    maxAgeMs: options.maxAgeMs,
    checkPid: options.checkPid,
    pidAlive: options.pidAlive,
  })
}
