import test from 'node:test'
import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import { homedir } from 'node:os'
import { resolveDataDir, stateFilePath, DATA_DIR_ENV } from '../lib/paths.js'

const pjoin = posix.join
const wjoin = win32.join

test('resolveDataDir prefers DSH_TRAY_FOLLOWER_DIR', () => {
  const dir = resolveDataDir({
    env: { [DATA_DIR_ENV]: ' D:\\custom\\dir ' },
    platform: 'win32',
    homedir,
  })
  assert.equal(dir, 'D:\\custom\\dir')
})

test('resolveDataDir uses %LOCALAPPDATA%\\dsh-tray-follower on Windows', () => {
  const dir = resolveDataDir({
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    platform: 'win32',
    homedir,
  })
  assert.equal(dir, wjoin('C:\\Users\\u\\AppData\\Local', 'dsh-tray-follower'))
})

test('resolveDataDir falls back to the home AppData directory on Windows', () => {
  const dir = resolveDataDir({ env: {}, platform: 'win32', homedir: () => 'C:\\Users\\u' })
  assert.equal(dir, wjoin('C:\\Users\\u', 'AppData', 'Local', 'dsh-tray-follower'))
})

test('resolveDataDir uses XDG_STATE_HOME on POSIX platforms', () => {
  const dir = resolveDataDir({ env: { XDG_STATE_HOME: '/var/state' }, platform: 'linux', homedir: () => '/home/u' })
  assert.equal(dir, '/var/state/dsh-tray-follower')
  const fallback = resolveDataDir({ env: {}, platform: 'linux', homedir: () => '/home/u' })
  assert.equal(fallback, '/home/u/.local/state/dsh-tray-follower')
  const mac = resolveDataDir({ env: {}, platform: 'darwin', homedir: () => '/Users/u' })
  assert.equal(mac, '/Users/u/Library/Application Support/dsh-tray-follower')
})

test('the state file lives in the resolved directory', () => {
  const dir = resolveDataDir({ env: { [DATA_DIR_ENV]: '/tmp/tray' }, platform: 'linux', homedir: () => '/home/u' })
  assert.equal(stateFilePath(dir), pjoin('/tmp/tray', 'state.json'))

  const winDir = resolveDataDir({ env: { [DATA_DIR_ENV]: 'C:\\tray' }, platform: 'win32', homedir })
  assert.equal(stateFilePath(winDir), 'C:\\tray\\state.json')
})
