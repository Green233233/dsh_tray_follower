import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bridgeAvailable,
  evaluateHeartbeat,
  parseHeartbeat,
  pidAlive,
} from '../lib/bridge.js'

const NOW = 1_730_000_000_000

test('parseHeartbeat validates the documented { pid, ts, version } shape', () => {
  assert.deepEqual(parseHeartbeat('{"pid":42,"ts":1730000000000,"version":"0.1.0"}'), {
    ts: 1730000000000,
    pid: 42,
    version: '0.1.0',
  })
  assert.deepEqual(parseHeartbeat(Buffer.from('{"ts":123}')), { ts: 123 })
  for (const raw of [undefined, null, '', 'not json', '[]', '{"ts":"x"}', '{"ts":-1}', '{"ts":0}', '{"pid":1}']) {
    assert.equal(parseHeartbeat(raw), undefined, `should reject ${String(raw)}`)
  }
})

test('evaluateHeartbeat: fresh, stale, missing, clock skew, dead pid', () => {
  const fresh = evaluateHeartbeat({ raw: `{"pid":1,"ts":${NOW - 1000}}`, now: NOW })
  assert.equal(fresh.available, true)
  assert.equal(fresh.reason, 'fresh')

  const stale = evaluateHeartbeat({ raw: `{"ts":${NOW - 15_001}}`, now: NOW })
  assert.equal(stale.available, false)
  assert.equal(stale.reason, 'stale')

  const boundary = evaluateHeartbeat({ raw: `{"ts":${NOW - 15_000}}`, now: NOW })
  assert.equal(boundary.available, true)

  assert.equal(evaluateHeartbeat({ raw: undefined, now: NOW }).reason, 'missing-or-invalid')
  assert.equal(evaluateHeartbeat({ raw: '{"ts":1}', now: NOW }).reason, 'stale')

  const skewed = evaluateHeartbeat({ raw: `{"ts":${NOW + 120_000}}`, now: NOW })
  assert.equal(skewed.reason, 'clock-skew')

  const dead = evaluateHeartbeat({ raw: `{"pid":99,"ts":${NOW}}`, now: NOW, checkPid: true, pidAlive: () => false })
  assert.equal(dead.available, false)
  assert.equal(dead.reason, 'dead-pid')

  const alive = evaluateHeartbeat({ raw: `{"pid":99,"ts":${NOW}}`, now: NOW, checkPid: true, pidAlive: () => true })
  assert.equal(alive.available, true)
})

test('pidAlive reports the current process as alive', () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(0), false)
  assert.equal(pidAlive(-1), false)

  assert.equal(pidAlive(999_999_999), false)
})

test('bridgeAvailable reads the heartbeat file and tolerates a missing file', () => {
  const readOk = () => `{"pid":${process.pid},"ts":${NOW},"version":"1"}`
  const result = bridgeAvailable('/tmp/bridge.json', { now: NOW, readFile: readOk })
  assert.equal(result.available, true)

  const readMissing = () => {
    const error = new Error('ENOENT')
    error.code = 'ENOENT'
    throw error
  }
  const absent = bridgeAvailable('/tmp/bridge.json', { now: NOW, readFile: readMissing })
  assert.equal(absent.available, false)
  assert.equal(absent.reason, 'missing-or-invalid')
})
