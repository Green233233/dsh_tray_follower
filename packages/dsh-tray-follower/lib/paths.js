/**
 * Filesystem locations for the state contract.
 *
 * Default data directory:
 *   Windows: %LOCALAPPDATA%\dsh-tray-follower
 *   other:   $XDG_STATE_HOME/dsh-tray-follower (or ~/.local/state/...)
 * Overridden by DSH_TRAY_FOLLOWER_DIR.
 */
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'

/** Environment variable documented in docs/DESIGN.md §4. */
export const DATA_DIR_ENV = 'DSH_TRAY_FOLLOWER_DIR'

/** File the Host writes and the desktop bridge reads. */
export const STATE_FILE_NAME = 'state.json'

/** Heartbeat file the desktop bridge owns (`{ pid, ts, version }`). */
export const BRIDGE_FILE_NAME = 'bridge.json'

/**
 * Resolve the data directory without touching the filesystem.
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   homedir?: () => string,
 * }} [options]
 * @returns {string}
 */
export function resolveDataDir(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const homedir = typeof options.homedir === 'function' ? options.homedir : osHomedir

  const override = typeof env[DATA_DIR_ENV] === 'string' ? env[DATA_DIR_ENV].trim() : ''
  if (override !== '') return override

  if (platform === 'win32') {
    const localAppData = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : ''
    const base = localAppData !== '' ? localAppData : join(homedir(), 'AppData', 'Local')
    return join(base, 'dsh-tray-follower')
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'dsh-tray-follower')
  }
  const stateHome = typeof env.XDG_STATE_HOME === 'string' && env.XDG_STATE_HOME.trim() !== ''
    ? env.XDG_STATE_HOME.trim()
    : join(homedir(), '.local', 'state')
  return join(stateHome, 'dsh-tray-follower')
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function stateFilePath(dataDir) {
  return join(dataDir, STATE_FILE_NAME)
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function bridgeHeartbeatPath(dataDir) {
  return join(dataDir, BRIDGE_FILE_NAME)
}
