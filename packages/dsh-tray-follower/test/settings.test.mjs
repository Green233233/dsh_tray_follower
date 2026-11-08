import test from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../index.js'
import { SCHEMA_VERSION } from '../lib/constants.js'
import {
  DEFAULT_OPTIONS,
  MAX_SESSIONS_PER_WORKSPACE_MAX,
  MAX_SESSIONS_PER_WORKSPACE_MIN,
  NOTIFICATION_DEFAULTS,
  OPTION_FIELDS,
  TRAY_DEFAULTS,
  defaultOptions,
  normalizeMaxSessionsPerWorkspace,
  normalizeOptions,
  readConfigValue,
  resolveSettings,
  sameOptions,
} from '../lib/settings.js'
import { buildStateDocument, validateStateDocument } from '../lib/state.js'

/** The v2 `options` defaults, spelled out so a contract change is visible here. */
const CONTRACT_DEFAULTS = {
  tray: { showIdle: false, maxSessionsPerWorkspace: 6, showHeaderCounts: true, showFooter: true },
  notifications: {
    notifyOnCompleted: true,
    notifyOnFailed: true,
    notifyOnAttention: true,
    suppressWhenFocused: true,
    notificationSound: true,
  },
}

/** The fixed Config field contract (name → schema type + default). */
const CONFIG_FIELDS = {
  showIdle: { type: 'boolean', default: false },
  maxSessionsPerWorkspace: { type: 'number', default: 6 },
  showHeaderCounts: { type: 'boolean', default: true },
  showFooter: { type: 'boolean', default: true },
  notifyOnCompleted: { type: 'boolean', default: true },
  notifyOnFailed: { type: 'boolean', default: true },
  notifyOnAttention: { type: 'boolean', default: true },
  suppressWhenFocused: { type: 'boolean', default: true },
  notificationSound: { type: 'boolean', default: true },
}

function trackerStub() {
  return { snapshot: () => [], unreadEvents: () => [] }
}

test('DEFAULT_OPTIONS pins the v2 contract defaults', () => {
  assert.deepEqual(DEFAULT_OPTIONS, CONTRACT_DEFAULTS)
  assert.deepEqual(TRAY_DEFAULTS, CONTRACT_DEFAULTS.tray)
  assert.deepEqual(NOTIFICATION_DEFAULTS, CONTRACT_DEFAULTS.notifications)
  assert.ok(Object.isFrozen(DEFAULT_OPTIONS))
  assert.ok(Object.isFrozen(DEFAULT_OPTIONS.tray))
  assert.ok(Object.isFrozen(DEFAULT_OPTIONS.notifications))
  assert.deepEqual(OPTION_FIELDS, {
    tray: ['showIdle', 'maxSessionsPerWorkspace', 'showHeaderCounts', 'showFooter'],
    notifications: [
      'notifyOnCompleted',
      'notifyOnFailed',
      'notifyOnAttention',
      'suppressWhenFocused',
      'notificationSound',
    ],
  })
  assert.equal(MAX_SESSIONS_PER_WORKSPACE_MIN, 1)
  assert.equal(MAX_SESSIONS_PER_WORKSPACE_MAX, 20)
})

test('resolveSettings returns the defaults when no Config is available', () => {
  for (const config of [undefined, null, {}, 0, 'x', [], new Map()]) {
    assert.deepEqual(resolveSettings(config), CONTRACT_DEFAULTS, `config: ${String(config)}`)
  }
})

test('resolveSettings accepts plain (non-volatile) values', () => {
  const options = resolveSettings({
    showIdle: true,
    maxSessionsPerWorkspace: 9,
    showHeaderCounts: false,
    showFooter: false,
    notifyOnCompleted: false,
    notifyOnFailed: false,
    notifyOnAttention: false,
    suppressWhenFocused: false,
    notificationSound: false,
  })
  assert.deepEqual(options, {
    tray: { showIdle: true, maxSessionsPerWorkspace: 9, showHeaderCounts: false, showFooter: false },
    notifications: {
      notifyOnCompleted: false,
      notifyOnFailed: false,
      notifyOnAttention: false,
      suppressWhenFocused: false,
      notificationSound: false,
    },
  })
})

test('resolveSettings reads volatile references live', () => {
  const current = {
    showIdle: false,
    maxSessionsPerWorkspace: 6,
    notifyOnCompleted: true,
  }
  const config = {
    showIdle: { get: () => current.showIdle },
    maxSessionsPerWorkspace: { get: () => current.maxSessionsPerWorkspace },
    notifyOnCompleted: { get: () => current.notifyOnCompleted },
  }
  assert.equal(resolveSettings(config).tray.showIdle, false)
  assert.equal(resolveSettings(config).tray.maxSessionsPerWorkspace, 6)
  assert.equal(resolveSettings(config).notifications.notifyOnCompleted, true)

  // An edit in the settings page writes through the reference; the next read
  // (the periodic publication) must observe the new value.
  current.showIdle = true
  current.maxSessionsPerWorkspace = 15
  current.notifyOnCompleted = false
  const updated = resolveSettings(config)
  assert.equal(updated.tray.showIdle, true)
  assert.equal(updated.tray.maxSessionsPerWorkspace, 15)
  assert.equal(updated.notifications.notifyOnCompleted, false)
})

test('resolveSettings never throws when a getter or the proxy fails', () => {
  const throwingGetter = { showIdle: { get() { throw new Error('boom') } } }
  assert.deepEqual(resolveSettings(throwingGetter), CONTRACT_DEFAULTS)

  const throwingProxy = new Proxy({}, {
    get() {
      throw new Error('denied')
    },
  })
  assert.deepEqual(resolveSettings(throwingProxy), CONTRACT_DEFAULTS)
  assert.equal(readConfigValue(throwingProxy, 'showIdle'), undefined)
})

test('resolveSettings clamps maxSessionsPerWorkspace into 1..20', () => {
  const cases = [
    [0, 1],
    [-5, 1],
    [1, 1],
    [20, 20],
    [21, 20],
    [99, 20],
    [7.6, 8],
    [7.4, 7],
    [Number.NaN, 6],
    [Number.POSITIVE_INFINITY, 6],
    ['8', 6],
    [null, 6],
    [undefined, 6],
    [true, 6],
  ]
  for (const [raw, expected] of cases) {
    assert.equal(normalizeMaxSessionsPerWorkspace(raw), expected, `raw: ${String(raw)}`)
    assert.equal(resolveSettings({ maxSessionsPerWorkspace: raw }).tray.maxSessionsPerWorkspace, expected)
  }
})

test('resolveSettings treats non-boolean values as missing', () => {
  const options = resolveSettings({
    showIdle: 'yes',
    showHeaderCounts: 1,
    showFooter: 0,
    notifyOnCompleted: null,
    notifyOnFailed: {},
    notifyOnAttention: [],
    suppressWhenFocused: 'true',
    notificationSound: Number.NaN,
  })
  assert.deepEqual(options.tray, {
    showIdle: false,
    maxSessionsPerWorkspace: 6,
    showHeaderCounts: true,
    showFooter: true,
  })
  assert.deepEqual(options.notifications, CONTRACT_DEFAULTS.notifications)
})

test('normalizeOptions tolerates malformed shapes', () => {
  for (const candidate of [undefined, null, 'x', 42, [], { tray: 'x' }, { notifications: 1 }]) {
    assert.deepEqual(normalizeOptions(candidate), CONTRACT_DEFAULTS)
  }
  // Individual malformed fields fall back; valid siblings survive.
  assert.deepEqual(
    normalizeOptions({ tray: { showIdle: true, maxSessionsPerWorkspace: 'many' }, notifications: { notifyOnFailed: false } }),
    {
      tray: { showIdle: true, maxSessionsPerWorkspace: 6, showHeaderCounts: true, showFooter: true },
      notifications: {
        notifyOnCompleted: true,
        notifyOnFailed: false,
        notifyOnAttention: true,
        suppressWhenFocused: true,
        notificationSound: true,
      },
    },
  )
})

test('resolveSettings and defaultOptions always return fresh objects', () => {
  const first = resolveSettings(undefined)
  assert.deepEqual(first, CONTRACT_DEFAULTS)
  first.tray.showIdle = true
  first.notifications.notificationSound = false
  assert.deepEqual(resolveSettings(undefined), CONTRACT_DEFAULTS)
  assert.deepEqual(defaultOptions(), CONTRACT_DEFAULTS)
  assert.notEqual(defaultOptions(), defaultOptions())
  assert.equal(DEFAULT_OPTIONS.tray.showIdle, false)
})

test('sameOptions compares normalized values', () => {
  assert.ok(sameOptions(undefined, defaultOptions()))
  assert.ok(sameOptions(CONTRACT_DEFAULTS, resolveSettings(undefined)))
  assert.ok(sameOptions({ tray: { showIdle: 'nonsense' } }, CONTRACT_DEFAULTS))
  assert.ok(!sameOptions({ tray: { showIdle: true } }, CONTRACT_DEFAULTS))
  assert.ok(!sameOptions({ notifications: { notificationSound: false } }, CONTRACT_DEFAULTS))
  assert.ok(!sameOptions({ tray: { maxSessionsPerWorkspace: 7 } }, CONTRACT_DEFAULTS))
  // Both clamp to the maximum, so they compare equal.
  assert.ok(sameOptions(
    { tray: { maxSessionsPerWorkspace: 99 } },
    { tray: { maxSessionsPerWorkspace: 20 } },
  ))
})

test('buildStateDocument publishes schemaVersion 2 with default options', () => {
  const document = buildStateDocument({
    tracker: trackerStub(),
    workspaces: [],
    webOrigin: 'http://127.0.0.1:61983',
    hostPid: 7,
    now: 1_730_000_000_000,
  })
  assert.equal(SCHEMA_VERSION, 2)
  assert.equal(document.schemaVersion, 2)
  assert.deepEqual(document.options, CONTRACT_DEFAULTS)
  assert.deepEqual(validateStateDocument(document), { ok: true, errors: [] })
  assert.deepEqual(JSON.parse(JSON.stringify(document)), document)
})

test('the exported Config declares the fixed volatile field contract', () => {
  assert.equal(typeof Config, 'function')
  assert.deepEqual(
    Object.keys(Config.dict).sort(),
    Object.keys(CONFIG_FIELDS).sort(),
    'the Config field set is part of the contract and must not drift',
  )
  for (const [field, expected] of Object.entries(CONFIG_FIELDS)) {
    const schema = Config.dict[field]
    assert.equal(schema.type, expected.type, `${field}.type`)
    assert.equal(schema.meta.default, expected.default, `${field}.default`)
    assert.equal(schema.meta.volatile, true, `${field} must be .volatile()`)
    assert.equal(typeof schema.meta.description, 'string', `${field}.description`)
    assert.match(schema.meta.description, /[\u4e00-\u9fff]/u, `${field} needs a Chinese description`)
    assert.match(schema.meta.description, /[A-Za-z]/u, `${field} needs an English description`)
    assert.ok(schema.meta.description.includes(' / '), `${field} description separates zh and en with " / "`)
  }
})

test('the exported Config rejects values outside the schema', () => {
  assert.throws(() => Config({ showIdle: 'yes' }))
  assert.throws(() => Config({ maxSessionsPerWorkspace: 0 }))
  assert.throws(() => Config({ maxSessionsPerWorkspace: 21 }))
  assert.throws(() => Config({ notifyOnCompleted: 1 }))
  // Valid values parse back through resolveSettings as live settings.
  const parsed = Config({ showIdle: true, maxSessionsPerWorkspace: 3 })
  assert.equal(typeof parsed.showIdle.get, 'function', 'parsed volatile field is a reference')
  assert.deepEqual(resolveSettings(parsed), {
    tray: { showIdle: true, maxSessionsPerWorkspace: 3, showHeaderCounts: true, showFooter: true },
    notifications: CONTRACT_DEFAULTS.notifications,
  })
})
