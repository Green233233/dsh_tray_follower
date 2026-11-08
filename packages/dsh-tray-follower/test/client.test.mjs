/**
 * Unit tests for the dsh-tray-follower Client half (Settings page).
 *
 * The browser artifact is a plain script for the Harness module loader, so it
 * is executed in a `node:vm` context with a fake `window.__ModuleLoader__`, a
 * minimal fake React, and fake Cordis services. No browser, bundler, or React
 * installation is required.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))
const CLIENT_SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

const MODULE_ID = 'dsh-tray-follower'
const ENTRY_ID = 'dsh-tray-follower'
const NS = 'settings.trayFollower'
const SLOT = 'settings.section'

/** Field names fixed by the Host contract, in page order. */
const TOGGLE_FIELDS = [
  'showIdle',
  'showHeaderCounts',
  'showFooter',
  'notifyOnCompleted',
  'notifyOnFailed',
  'notifyOnAttention',
  'suppressWhenFocused',
  'notificationSound',
]
const NUMBER_FIELD = 'maxSessionsPerWorkspace'
const ALL_FIELDS = [
  'showIdle',
  'maxSessionsPerWorkspace',
  'showHeaderCounts',
  'showFooter',
  'notifyOnCompleted',
  'notifyOnFailed',
  'notifyOnAttention',
  'suppressWhenFocused',
  'notificationSound',
]

/** The smallest React the page renders against. */
function createReact() {
  return {
    createElement(type, props, ...children) {
      const next = Object.assign({}, props ?? {})
      if (children.length === 1) next.children = children[0]
      else if (children.length > 1) next.children = children
      return { type, props: next }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
}

/** Execute client.js in a sandbox and return the registered module. */
function loadModule() {
  const loaded = []
  const window = {
    __ModuleLoader__: {
      load(definition) {
        loaded.push(definition)
      },
    },
  }
  vm.runInContext(CLIENT_SOURCE, vm.createContext({ window, console }), { filename: CLIENT_PATH })
  assert.equal(loaded.length, 1, 'client.js registers exactly one module')
  const definition = loaded[0]
  const react = createReact()
  const module = definition.factory((id) => {
    assert.equal(id, 'react', 'the factory only requires React')
    return react
  })
  return { definition, module }
}

/** Fake locale service with live zh/en dictionaries, mirroring the real one. */
function createLocale() {
  const registered = []
  let language = 'zh'
  const translate = (namespace) => (key) => {
    const entry = registered.find((candidate) => candidate.ns === namespace)
    const dictionary = entry?.locales?.[language] ?? entry?.locales?.en
    return dictionary !== undefined && typeof dictionary[key] === 'string' ? dictionary[key] : key
  }
  return {
    registered,
    bind(namespace) {
      return translate(namespace)
    },
    register(namespace, locales) {
      registered.push({ ns: namespace, locales })
      return () => {}
    },
    use(languageId) {
      language = languageId
    },
  }
}

/** Fake slots service: keeps the injected callbacks and registrations. */
function createSlots() {
  const injected = []
  const registrations = []
  return {
    injected,
    registrations,
    inject(name, callback) {
      injected.push({ name, callback })
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
}

/** Fake Host Config form: live snapshot, listeners, recorded writes. */
function createForm(initialValue = {}) {
  const defaults = {
    showIdle: false,
    maxSessionsPerWorkspace: 6,
    showHeaderCounts: true,
    showFooter: true,
    notifyOnCompleted: true,
    notifyOnFailed: true,
    notifyOnAttention: true,
    suppressWhenFocused: true,
    notificationSound: true,
  }
  const value = Object.assign({}, defaults, initialValue)
  let snapshot = {
    status: 'ready',
    writable: true,
    revision: 4,
    value,
    base: Object.assign({}, value),
    user: {},
  }
  const writes = []
  const listeners = new Set()
  const form = {
    getSnapshot() {
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(field, next) {
      writes.push([field, next])
      return Promise.resolve(true)
    },
    unset(field) {
      writes.push([field, null])
      return Promise.resolve(true)
    },
  }
  return {
    form,
    defaults,
    writes,
    setSnapshot(next) {
      snapshot = next
    },
  }
}

/** Fake plugin context for `apply`. */
function createContext(locale, slots, form) {
  const effects = []
  const configFormsGets = []
  return {
    effects,
    configFormsGets,
    locale,
    slots,
    configForms: {
      get(entryId) {
        configFormsGets.push(entryId)
        return form
      },
    },
    effect(factory, label) {
      effects.push({ label, dispose: factory() })
      return () => {}
    },
  }
}

/** Boot the module exactly as the browser loader would. */
function setup(overrides = {}) {
  const { definition, module } = loadModule()
  const locale = createLocale()
  const slots = createSlots()
  const formHandle = createForm(overrides.value)
  if (overrides.snapshot !== undefined) {
    formHandle.setSnapshot(
      Object.assign({}, formHandle.form.getSnapshot(), overrides.snapshot),
    )
  }
  const ctx = createContext(locale, slots, formHandle.form)
  module.apply(ctx)
  const injected = slots.injected.find((candidate) => candidate.name === SLOT)
  assert.ok(injected, `apply() injects the ${SLOT} slot`)
  injected.callback()
  assert.equal(slots.registrations.length, 1, 'one settings registration')
  const entry = slots.registrations[0]
  const t = locale.bind(NS)
  const render = () => entry.component(Object.assign({ t }, entry.options.inject()))
  return { definition, module, locale, slots, ctx, formHandle, entry, t, render }
}

/** Visit every element object in a rendered tree. */
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  if (node.props !== undefined && node.props !== null) walk(node.props.children, visit)
}

/** Collect elements matching a predicate. */
function findAll(node, predicate) {
  const found = []
  walk(node, (element) => {
    if (predicate(element)) found.push(element)
  })
  return found
}

/** Concatenate the string children of a rendered tree. */
function textOf(node) {
  const parts = []
  walk(node, (element) => {
    const children = element.props?.children
    if (typeof children === 'string') parts.push(children)
  })
  return parts.join('')
}

test('client module uses the package id and requires the settings services', () => {
  const { definition, module } = loadModule()
  assert.equal(definition.id, MODULE_ID)
  // Values created inside the vm context are from another realm; copy before comparing.
  assert.deepEqual(Array.from(module.inject), ['slots', 'locale', 'configForms'])
})

test('apply registers dictionaries and the settings section against the Host entry', () => {
  const { module, locale, slots, ctx, entry, formHandle, t } = setup()

  // Dictionaries: namespace owned by this page, both baseline locales, same keys.
  assert.equal(locale.registered.length, 1)
  const dictionaries = locale.registered[0]
  assert.equal(dictionaries.ns, NS)
  assert.ok(dictionaries.locales.zh !== undefined, 'zh dictionary is registered')
  assert.ok(dictionaries.locales.en !== undefined, 'en dictionary is registered')
  const zhKeys = Object.keys(dictionaries.locales.zh).sort()
  const enKeys = Object.keys(dictionaries.locales.en).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh and en cover the same keys')
  assert.ok(zhKeys.includes('nav'))
  assert.equal(dictionaries.locales.zh.nav, '托盘跟随')
  assert.equal(dictionaries.locales.en.nav, 'Tray follower')

  // The shared Config form is resolved once by the Host entry id.
  assert.deepEqual(ctx.configFormsGets, [ENTRY_ID])

  // Slot registration shape consumed by the settings shell.
  assert.deepEqual(
    slots.injected.map((candidate) => candidate.name),
    [SLOT],
  )
  assert.equal(entry.options.name, SLOT)
  assert.equal(entry.options.id, 'tray-follower')
  assert.equal(entry.options.order, 30)
  assert.equal(entry.options.locale, NS)
  assert.equal(typeof entry.options.label, 'function')
  assert.equal(entry.options.label(), '托盘跟随')
  locale.use('en')
  assert.equal(entry.options.label(), 'Tray follower', 'label follows the active language')
  locale.use('zh')

  // The page receives the very form instance the plugin resolved.
  assert.equal(entry.options.inject().form, formHandle.form)
  assert.equal(typeof entry.component, 'function')
})

test('page renders the header, both groups and every fixed field once', () => {
  const { render } = setup()
  const page = render()
  const text = textOf(page)
  assert.ok(text.includes('托盘跟随'), 'page heading')
  assert.ok(text.includes('托盘右键菜单'), 'tray group heading')
  assert.ok(text.includes('通知'), 'notification group heading')

  const controls = findAll(
    page,
    (element) => element.props !== undefined && element.props !== null && element.props['data-field'] !== undefined,
  )
  const fields = controls.map((element) => element.props['data-field'])
  assert.deepEqual(fields.sort(), ALL_FIELDS.slice().sort(), 'every fixed field rendered once')

  for (const field of TOGGLE_FIELDS) {
    const toggle = controls.find((element) => element.props['data-field'] === field)
    assert.equal(toggle.type, 'button', `${field} is a button`)
    assert.equal(toggle.props.role, 'switch', `${field} has role=switch`)
    assert.equal(typeof toggle.props['aria-checked'], 'boolean', `${field} exposes aria-checked`)
  }

  const number = controls.find((element) => element.props['data-field'] === NUMBER_FIELD)
  assert.equal(number.type, 'input')
  assert.equal(number.props.type, 'number')
  assert.equal(number.props.min, 1)
  assert.equal(number.props.max, 20)
  assert.equal(number.props.defaultValue, '6', 'default value comes from the snapshot')
  assert.equal(number.props.disabled, false)
})

test('toggle clicks write the correct field and value through form.set', () => {
  const { render, formHandle } = setup()
  const page = render()
  const toggle = (field) =>
    findAll(
      page,
      (element) => element.props?.role === 'switch' && element.props['data-field'] === field,
    )[0]

  const showIdle = toggle('showIdle')
  assert.equal(showIdle.props['aria-checked'], false)
  showIdle.props.onClick()
  assert.deepEqual(formHandle.writes, [['showIdle', true]])

  const sound = toggle('notificationSound')
  assert.equal(sound.props['aria-checked'], true)
  sound.props.onClick()
  assert.deepEqual(formHandle.writes, [
    ['showIdle', true],
    ['notificationSound', false],
  ])
})

test('number input clamps to 1..20 on blur and skips unchanged values', () => {
  const { render, formHandle } = setup()
  const page = render()
  const input = findAll(
    page,
    (element) => element.props?.['data-field'] === NUMBER_FIELD,
  )[0]

  const blur = (value) => {
    const target = { value }
    input.props.onBlur({ currentTarget: target })
    return target.value
  }

  assert.equal(blur('99'), '20', 'upper bound clamps and rewrites the visible value')
  assert.equal(blur('0'), '1', 'lower bound clamps and rewrites the visible value')
  assert.equal(blur('2.6'), '3', 'fractional input rounds')
  assert.equal(blur('abc'), '6', 'invalid input restores the current value')
  assert.equal(blur('6'), '6', 'unchanged value stays as typed')

  assert.deepEqual(formHandle.writes, [
    [NUMBER_FIELD, 20],
    [NUMBER_FIELD, 1],
    [NUMBER_FIELD, 3],
  ])
})

test('page is disabled with a notice while the form is not ready or not writable', () => {
  const loading = setup({ snapshot: { status: 'loading', writable: false, revision: undefined, value: undefined } })
  const loadingPage = loading.render()
  let loadingNotice = findAll(loadingPage, (element) => element.props?.role === 'status')[0]
  assert.ok(loadingNotice, 'loading notice rendered')
  assert.equal(textOf(loadingNotice), '正在读取设置…')
  const loadingToggles = findAll(loadingPage, (element) => element.props?.role === 'switch')
  assert.ok(loadingToggles.length > 0)
  for (const toggle of loadingToggles) assert.equal(toggle.props.disabled, true)
  const loadingNumber = findAll(loadingPage, (element) => element.props?.['data-field'] === NUMBER_FIELD)[0]
  assert.equal(loadingNumber.props.disabled, true)
  loadingToggles[0].props.onClick()
  assert.deepEqual(loading.formHandle.writes, [], 'disabled toggles never write')

  const readOnly = setup({ snapshot: { status: 'ready', writable: false } })
  const readOnlyPage = readOnly.render()
  const readOnlyNotice = findAll(readOnlyPage, (element) => element.props?.role === 'status')[0]
  assert.ok(readOnlyNotice, 'read-only notice rendered')
  assert.equal(textOf(readOnlyNotice), '本部署的设置为只读。')
  const readOnlyToggles = findAll(readOnlyPage, (element) => element.props?.role === 'switch')
  for (const toggle of readOnlyToggles) assert.equal(toggle.props.disabled, true)
})
