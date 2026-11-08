// Environment helpers for the DSH tray-follower inspector injector.
//
// The injector is a plain Node process (bundled DSH node or system node). Its
// children must never inherit `ELECTRON_RUN_AS_NODE` (the DSH host exports it to
// its tool shells, which would turn DeepSeek Harness.exe into plain Node) nor
// `NODE_OPTIONS` (packaged Electron rejects/ignores it).

import path from 'node:path'

export const SANITIZED_ENV_KEYS = Object.freeze([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'ELECTRON_NO_ATTACH_CONSOLE'
])

export const INSPECT_DEFAULT_PORT = 9531

/**
 * Copy an environment while removing Electron/Node injection variables.
 * `null`/`undefined` override values delete the key.
 */
export function sanitizeDshEnv(base = process.env, overrides = {}) {
  const output = {}
  for (const [key, value] of Object.entries(base || {})) {
    if (SANITIZED_ENV_KEYS.includes(key)) continue
    if (typeof value === 'string') output[key] = value
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === null || value === undefined) {
      delete output[key]
    } else {
      output[key] = String(value)
    }
  }
  return output
}

export function localAppDataDir(env = process.env) {
  if (env && typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA) return env.LOCALAPPDATA
  if (env && typeof env.USERPROFILE === 'string' && env.USERPROFILE) {
    return path.join(env.USERPROFILE, 'AppData', 'Local')
  }
  return ''
}

export function defaultDataDir(env = process.env) {
  if (env && typeof env.DSH_TRAY_FOLLOWER_DIR === 'string' && env.DSH_TRAY_FOLLOWER_DIR.trim()) {
    return path.resolve(env.DSH_TRAY_FOLLOWER_DIR.trim())
  }
  const localAppData = localAppDataDir(env)
  return localAppData ? path.join(localAppData, 'dsh-tray-follower') : path.join(process.cwd(), 'dsh-tray-follower')
}

export function defaultDshExe(env = process.env) {
  if (env && typeof env.DSH_DESKTOP_EXE === 'string' && env.DSH_DESKTOP_EXE.trim()) {
    return path.resolve(env.DSH_DESKTOP_EXE.trim())
  }
  const localAppData = localAppDataDir(env)
  if (!localAppData) return 'DeepSeek Harness.exe'
  return path.join(localAppData, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
}

export function dshInstallDir(exePath) {
  try {
    return path.dirname(exePath)
  } catch (_error) {
    return ''
  }
}

/** Node executable candidates for running the injector (bundled DSH node first). */
export function nodeCandidates(env = process.env, exePath = '') {
  const candidates = []
  const installDir = exePath ? dshInstallDir(exePath) : path.join(localAppDataDir(env), 'Programs', 'DeepSeek Harness')
  if (installDir) {
    candidates.push(
      path.join(installDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
    )
  }
  candidates.push(process.execPath)
  return candidates.filter((value, index) => typeof value === 'string' && value && candidates.indexOf(value) === index)
}

export function inspectPortFromEnv(env = process.env, fallback = INSPECT_DEFAULT_PORT) {
  const raw = env && typeof env.DSH_TRAY_FOLLOWER_INSPECT_PORT === 'string' ? env.DSH_TRAY_FOLLOWER_INSPECT_PORT.trim() : ''
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return fallback
  return parsed
}

export function normalizePathForCompare(value) {
  if (typeof value !== 'string' || !value) return ''
  try {
    return path.resolve(value).replaceAll('/', '\\').toLowerCase()
  } catch (_error) {
    return value.replaceAll('/', '\\').toLowerCase()
  }
}
