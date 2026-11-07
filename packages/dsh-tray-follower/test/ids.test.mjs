import test from 'node:test'
import assert from 'node:assert/strict'
import { stableEventId } from '../lib/ids.js'

test('stableEventId is deterministic for the same logical occurrence', () => {
  const first = stableEventId('completed', 'session-1', 3)
  const second = stableEventId('completed', 'session-1', 3)
  assert.equal(first, second)
  assert.ok(first.startsWith('evt_'))
  assert.equal(first.length, 'evt_'.length + 20)
})

test('stableEventId separates different occurrences', () => {
  const ids = new Set([
    stableEventId('completed', 'session-1', 3),
    stableEventId('completed', 'session-1', 4),
    stableEventId('failed', 'session-1', 3),
    stableEventId('completed', 'session-2', 3),
    stableEventId('attention', 'session-1', 'approval', 'approval:tool'),
  ])
  assert.equal(ids.size, 5)
})

test('stableEventId tolerates empty parts', () => {
  assert.equal(stableEventId(), stableEventId('', '', null, undefined))
})
