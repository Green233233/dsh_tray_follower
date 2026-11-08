'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { describeError } = require('./util.cjs')

const HEARTBEAT_FILE_NAME = 'bridge.json'

/**
 * Write the bridge heartbeat consumed by the host plugin to decide whether the
 * bridge is alive (docs/DESIGN.md §4: `{pid, ts, version}`).
 *
 * Atomic write (tmp + rename). Never throws; errors are reported to the caller.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.version
 * @param {number} [options.pid]
 * @param {number} [options.now]
 * @returns {{ok: boolean, path: string, payload?: object, error?: string}}
 */
function writeHeartbeat(options = {}) {
  const dataDir = typeof options.dataDir === 'string' && options.dataDir ? options.dataDir : ''
  if (!dataDir) return { ok: false, path: '', error: 'dataDir required' }
  const file = path.join(dataDir, HEARTBEAT_FILE_NAME)
  const payload = {
    pid: Number.isFinite(options.pid) ? options.pid : process.pid,
    ts: Number.isFinite(options.now) ? options.now : Date.now(),
    version: typeof options.version === 'string' && options.version ? options.version : '0.0.0'
  }
  const temporary = `${file}.tmp`
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, 'utf8')
    fs.renameSync(temporary, file)
    return { ok: true, path: file, payload }
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch (_cleanupError) {
      /* ignore */
    }
    return { ok: false, path: file, error: describeError(error).message }
  }
}

/** Read back the current heartbeat (diagnostics/tests). */
function readHeartbeat(dataDir) {
  const file = path.join(dataDir, HEARTBEAT_FILE_NAME)
  try {
    const decoded = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!decoded || typeof decoded !== 'object') return { ok: false, path: file, error: 'invalid heartbeat' }
    return { ok: true, path: file, payload: decoded }
  } catch (error) {
    return { ok: false, path: file, error: describeError(error).message }
  }
}

module.exports = {
  HEARTBEAT_FILE_NAME,
  writeHeartbeat,
  readHeartbeat
}
