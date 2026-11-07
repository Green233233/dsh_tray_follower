import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeJson, writeJsonAtomic } from '../lib/atomic-json.js'

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('serializeJson is pretty JSON with a trailing newline', () => {
  assert.equal(serializeJson({ a: 1 }), '{\n  "a": 1\n}\n')
})

test('writeJsonAtomic creates the directory, writes and replaces atomically', () => {
  const { dir, cleanup } = tempDir('dsh-tray-atomic-')
  try {
    const file = join(dir, 'nested', 'state.json')
    writeJsonAtomic(file, { schemaVersion: 1, value: 'first' })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { schemaVersion: 1, value: 'first' })
    writeJsonAtomic(file, { schemaVersion: 1, value: 'second' })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { schemaVersion: 1, value: 'second' })
    const leftovers = readdirSync(join(dir, 'nested')).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    cleanup()
  }
})

test('writeJsonAtomic retries the rename once before failing', () => {
  const { dir, cleanup } = tempDir('dsh-tray-atomic-')
  try {
    const file = join(dir, 'state.json')
    let renames = 0
    const written = new Map()
    const fakeFs = {
      existsSync: (path) => written.has(path) || existsSync(path),
      mkdirSync: () => {},
      writeFileSync: (path, data) => {
        written.set(path, data)
      },
      renameSync: (from, to) => {
        renames += 1
        if (renames === 1) {
          const error = new Error('EPERM')
          error.code = 'EPERM'
          throw error
        }
        written.set(to, written.get(from))
      },
      unlinkSync: (path) => {
        written.delete(path)
      },
    }
    writeJsonAtomic(file, { ok: true }, { fs: fakeFs })
    assert.equal(renames, 2)
    assert.ok(written.has(file))
  } finally {
    cleanup()
  }
})

test('writeJsonAtomic cleans the temp file and rethrows when writing fails', () => {
  const { dir, cleanup } = tempDir('dsh-tray-atomic-')
  try {
    const file = join(dir, 'state.json')
    const removed = []
    const fakeFs = {
      existsSync: (path) => path.endsWith('.tmp') || removed.includes(path) === false,
      mkdirSync: () => {},
      writeFileSync: () => {},
      renameSync: () => {
        throw new Error('boom')
      },
      unlinkSync: (path) => {
        removed.push(path)
      },
    }
    assert.throws(() => writeJsonAtomic(file, { ok: true }, { fs: fakeFs }), /boom/)
    assert.ok(removed.some((path) => path.endsWith('.tmp')))
    assert.equal(existsSync(file), false)
  } finally {
    cleanup()
  }
})
