import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateWriter } from '../lib/state-writer.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tray-writer-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('schedule coalesces writes and flush writes the newest document', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const file = join(dir, 'state.json')
    const writer = new StateWriter({ filePath: file, debounceMs: 10 })
    writer.schedule({ value: 1 })
    writer.schedule({ value: 2 })
    writer.schedule({ value: 3 })
    assert.equal(existsSync(file), false)
    await sleep(40)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { value: 3 })
    assert.equal(writer.writes, 1)
    assert.equal(writer.failures, 0)
    writer.dispose()
  } finally {
    cleanup()
  }
})

test('writeNow bypasses the debounce and dispose refuses later writes', () => {
  const { dir, cleanup } = tempDir()
  try {
    const file = join(dir, 'state.json')
    const writer = new StateWriter({ filePath: file, debounceMs: 5_000 })
    writer.writeNow({ value: 'now' })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { value: 'now' })
    writer.dispose()
    writer.schedule({ value: 'late' })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { value: 'now' })
  } finally {
    cleanup()
  }
})

test('flush writes a queued document synchronously', () => {
  const { dir, cleanup } = tempDir()
  try {
    const file = join(dir, 'state.json')
    const writer = new StateWriter({ filePath: file, debounceMs: 60_000 })
    writer.schedule({ value: 'queued' })
    assert.equal(writer.flush(), true)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { value: 'queued' })
    assert.equal(writer.flush(), false)
    writer.dispose()
  } finally {
    cleanup()
  }
})

test('write failures are logged and swallowed (never thrown into the event loop)', () => {
  const warnings = []
  const writer = new StateWriter({
    filePath: 'unused',
    debounceMs: 0,
    write: () => {
      throw new Error('disk full')
    },
    logger: { warn: (...args) => warnings.push(args) },
  })
  writer.schedule({ value: 1 })
  assert.equal(writer.flush(), false)
  assert.equal(writer.failures, 1)
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0][0]), /state write failed/)
  writer.dispose()
})
