/**
 * Unit tests for the dsh-tray-follower Client half (Settings page).
 *
 * The browser artifact is a plain script for the Harness module loader, so it
 * is executed in a `node:vm` context with a fake `window.__ModuleLoader__`, a
 * minimal fake React with a tiny render loop (hooks persist across renders),
 * and fake Cordis services. No browser, bundler, or React installation is
 * required. The render loop is what proves the optimistic switch behaviour.
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

/** Resolve after pending promise callbacks and timers have run. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Fake React with a minimal render loop: `useState` persists per hook index,
 * `useEffect` honors deps, and a setState marks the tree dirty so the next
 * `renderPage` renders again. Only what the Settings page uses is implemented.
 */
function createRuntime() {
  const hooks = []
  const effectRecords = new Map()
  const state = { cursor: 0, dirty: false, pendingEffects: [] }
  const react = {
    createElement(type, props, ...children) {
      const next = Object.assign({}, props ?? {})
      if (children.length === 1) next.children = children[0]
      else if (children.length > 1) next.children = children
      return { type, props: next }
    },
    useState(initial) {
      const index = state.cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      const setState = (next) => {
        const previous = hooks[index]
        const value = typeof next === 'function' ? next(previous) : next
        if (Object.is(value, previous)) return
        hooks[index] = value
        state.dirty = true
      }
      return [hooks[index], setState]
    },
    useEffect(effect, deps) {
      const index = state.cursor++
      state.pendingEffects.push({ index, effect, deps })
    },
  }
  const depsEqual = (previous, next) => {
    if (previous === undefined || next === undefined) return false
    if (previous.length !== next.length) return false
    return previous.every((value, index) => Object.is(value, next[index]))
  }
  return {
    react,
    renderPage(component, getProps) {
      let tree
      let cycles = 0
      do {
        state.dirty = false
        state.cursor = 0
        state.pendingEffects = []
        tree = component(getProps())
        const active = new Set()
        for (const record of state.pendingEffects) {
          active.add(record.index)
          const previous = effectRecords.get(record.index)
          if (previous !== undefined && depsEqual(previous.deps, record.deps)) continue
          if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
          const cleanup = record.effect()
          effectRecords.set(record.index, { deps: record.deps, cleanup })
        }
        for (const [index, previous] of effectRecords) {
          if (active.has(index)) continue
          if (typeof previous.cleanup === 'function') previous.cleanup()
          effectRecords.delete(index)
        }
        cycles += 1
        if (cycles > 20) throw new Error('component did not settle')
      } while (state.dirty)
      return tree
    },
  }
}

/** Execute client.js in a sandbox and return the registered module. */
function loadModule(react) {
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
  return {
    registered,
    bind(namespace) {
      return (key) => {
        const entry = registered.find((candidate) => candidate.ns === namespace)
        const dictionary = entry?.locales?.[language] ?? entry?.locales?.en
        return dictionary !== undefined && typeof dictionary[key] === 'string' ? dictionary[key] : key
      }
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
function createForm(initialValue = {}, accept = () => true) {
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
  let subscribeCount = 0
  const form = {
    getSnapshot() {
      return snapshot
    },
    subscribe(listener) {
      subscribeCount += 1
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(field, next) {
      writes.push([field, next])
      return Promise.resolve(accept(field, next))
    },
    unset(field) {
      writes.push([field, null])
      return Promise.resolve(accept(field, null))
    },
  }
  return {
    form,
    defaults,
    writes,
    subscribeCount() {
      return subscribeCount
    },
    setSnapshot(next) {
      snapshot = next
    },
    /** Publish an accepted Host value, as the describe mirror would. */
    updateValue(partial) {
      const nextValue = Object.assign({}, snapshot.value, partial)
      snapshot = Object.assign({}, snapshot, {
        value: nextValue,
        revision: (snapshot.revision ?? 0) + 1,
      })
      for (const listener of Array.from(listeners)) listener()
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
  const runtime = createRuntime()
  const { definition, module } = loadModule(runtime.react)
  const locale = createLocale()
  const slots = createSlots()
  const formHandle = createForm(overrides.value, overrides.accept)
  if (overrides.snapshot !== undefined) {
    formHandle.setSnapshot(Object.assign({}, formHandle.form.getSnapshot(), overrides.snapshot))
  }
  const ctx = createContext(locale, slots, formHandle.form)
  module.apply(ctx)
  const injected = slots.injected.find((candidate) => candidate.name === SLOT)
  assert.ok(injected, `apply() injects the ${SLOT} slot`)
  injected.callback()
  assert.equal(slots.registrations.length, 1, 'one settings registration')
  const entry = slots.registrations[0]
  const t = locale.bind(NS)
  const props = Object.assign({ t }, entry.options.inject())
  const render = () => runtime.renderPage(entry.component, () => props)
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

/** Locate one switch by its config field. */
function findToggle(tree, field) {
  return findAll(
    tree,
    (element) => element.props?.role === 'switch' && element.props['data-field'] === field,
  )[0]
}

/** Locate one control (switch or number input) by its config field. */
function findControl(tree, field) {
  return findAll(tree, (element) => element.props?.['data-field'] === field)[0]
}

/** Locate the status/notice paragraph. */
function findNotice(tree) {
  return findAll(tree, (element) => element.props?.role === 'status')[0]
}

test('client module uses the package id and requires the settings services', () => {
  const runtime = createRuntime()
  const { definition, module } = loadModule(runtime.react)
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
  assert.equal(typeof t('title'), 'string')
})

test('page renders the header, both card groups and every fixed field once', () => {
  const { render, formHandle } = setup()
  const page = render()
  const text = textOf(page)
  assert.ok(text.includes('托盘跟随'), 'page heading')
  assert.ok(text.includes('托盘右键菜单'), 'tray group title')
  assert.ok(text.includes('通知'), 'notification group title')
  assert.ok(text.includes('1–20'), 'range suffix hint')

  const controls = findAll(
    page,
    (element) => element.props !== undefined && element.props !== null && element.props['data-field'] !== undefined,
  )
  const fields = controls.map((element) => element.props['data-field'])
  assert.deepEqual(fields.sort(), ALL_FIELDS.slice().sort(), 'every fixed field rendered once')

  for (const field of TOGGLE_FIELDS) {
    const toggle = findToggle(page, field)
    assert.equal(toggle.type, 'button', `${field} is a button`)
    assert.equal(toggle.props.role, 'switch', `${field} has role=switch`)
    assert.equal(typeof toggle.props['aria-checked'], 'boolean', `${field} exposes aria-checked`)
    assert.equal(toggle.props.disabled, false)
  }

  const number = findControl(page, NUMBER_FIELD)
  assert.equal(number.type, 'input')
  assert.equal(number.props.type, 'number')
  assert.equal(number.props.min, 1)
  assert.equal(number.props.max, 20)
  assert.equal(number.props.defaultValue, '6', 'default value comes from the snapshot')
  assert.equal(number.props.disabled, false)

  // One stable subscription, however many times React renders the page.
  assert.equal(formHandle.subscribeCount(), 1)
  render()
  render()
  assert.equal(formHandle.subscribeCount(), 1, 'the store hook keeps a single subscription')

  // A Host revision re-renders from the same subscription.
  formHandle.updateValue({ notifyOnCompleted: false })
  const updated = render()
  assert.equal(findToggle(updated, 'notifyOnCompleted').props['aria-checked'], false)
})

test('a switch flips immediately and keeps the optimistic value until the snapshot lands', async () => {
  const { render, formHandle } = setup()
  let page = render()
  assert.equal(findToggle(page, 'showIdle').props['aria-checked'], false)

  findToggle(page, 'showIdle').props.onClick()

  // The Host round-trip is still in flight: form.set was called once...
  assert.deepEqual(formHandle.writes, [['showIdle', true]])
  assert.equal(formHandle.form.getSnapshot().value.showIdle, false, 'snapshot is still old')
  // ...and the very next render already shows the flipped switch.
  page = render()
  assert.equal(findToggle(page, 'showIdle').props['aria-checked'], true, 'optimistic flip is immediate')

  // The accepted value lands in the shared snapshot.
  await flush()
  formHandle.updateValue({ showIdle: true })
  page = render()
  assert.equal(findToggle(page, 'showIdle').props['aria-checked'], true)
  assert.deepEqual(formHandle.writes, [['showIdle', true]], 'no duplicate write')

  // Pending state was cleared, so a later external change becomes visible.
  formHandle.updateValue({ showIdle: false })
  page = render()
  assert.equal(findToggle(page, 'showIdle').props['aria-checked'], false, 'optimistic value was released')
})

test('a refused write reverts the switch and shows the save-failed notice', async () => {
  const { render, formHandle } = setup({ accept: (field) => field !== 'notifyOnFailed' })
  let page = render()
  assert.equal(findToggle(page, 'notifyOnFailed').props['aria-checked'], true)

  findToggle(page, 'notifyOnFailed').props.onClick()
  page = render()
  assert.equal(findToggle(page, 'notifyOnFailed').props['aria-checked'], false, 'optimistic flip')

  await flush()
  page = render()
  assert.equal(findToggle(page, 'notifyOnFailed').props['aria-checked'], true, 'refusal reverts the switch')
  const notice = findNotice(page)
  assert.ok(notice, 'save-failed notice rendered')
  assert.equal(textOf(notice), '设置没有保存成功，请重试。')
})

test('number input clamps to 1..20 on blur and skips unchanged values', () => {
  const { render, formHandle } = setup()
  let page = render()

  const blur = (raw) => {
    const input = findControl(page, NUMBER_FIELD)
    const target = { value: raw }
    input.props.onBlur({ currentTarget: target })
    page = render()
    return target.value
  }

  assert.equal(blur('99'), '20', 'upper bound clamps and rewrites the visible value')
  assert.equal(blur('0'), '1', 'lower bound clamps and rewrites the visible value')
  assert.equal(blur('2.6'), '3', 'fractional input rounds')
  assert.equal(blur('abc'), '3', 'invalid input restores the optimistic current value')
  assert.equal(blur('3'), '3', 'unchanged value stays as typed')
  assert.equal(blur(''), '3', 'empty input restores the current value')

  assert.deepEqual(formHandle.writes, [
    [NUMBER_FIELD, 20],
    [NUMBER_FIELD, 1],
    [NUMBER_FIELD, 3],
  ])
})

test('page is disabled with a notice while the form is not ready or not writable', () => {
  const loading = setup({ snapshot: { status: 'loading', writable: false, revision: undefined, value: undefined } })
  const loadingPage = loading.render()
  const loadingNotice = findNotice(loadingPage)
  assert.ok(loadingNotice, 'loading notice rendered')
  assert.equal(textOf(loadingNotice), '正在读取设置…')
  for (const field of TOGGLE_FIELDS) {
    assert.equal(findToggle(loadingPage, field).props.disabled, true, `${field} disabled while loading`)
  }
  assert.equal(findControl(loadingPage, NUMBER_FIELD).props.disabled, true)
  findToggle(loadingPage, 'showIdle').props.onClick()
  assert.deepEqual(loading.formHandle.writes, [], 'disabled toggles never write')

  const readOnly = setup({ snapshot: { status: 'ready', writable: false } })
  const readOnlyPage = readOnly.render()
  const readOnlyNotice = findNotice(readOnlyPage)
  assert.ok(readOnlyNotice, 'read-only notice rendered')
  assert.equal(textOf(readOnlyNotice), '本部署的设置为只读。')
  for (const field of TOGGLE_FIELDS) {
    assert.equal(findToggle(readOnlyPage, field).props.disabled, true, `${field} disabled when read-only`)
  }
  assert.equal(findControl(readOnlyPage, NUMBER_FIELD).props.disabled, true)
})
