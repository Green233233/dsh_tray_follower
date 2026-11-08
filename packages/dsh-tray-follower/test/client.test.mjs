/**
 * Unit tests for the dsh-tray-follower Client half.
 *
 * The browser artifact is a plain script for the Harness module loader, so it
 * is executed in a `node:vm` context with a fake `window.__ModuleLoader__`, a
 * minimal fake React with a tiny render loop (hooks persist across renders),
 * a stubbed app-native primitives module, and fake Cordis services. No
 * browser, bundler, or React installation is required.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))
const CLIENT_SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')
const ZH_LOCALE = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const EN_LOCALE = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
const MANIFEST = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const MODULE_ID = 'dsh-tray-follower'
const PRIMITIVES_ID = '@deepseek-ai/dsh-client-ui-primitives'
const ENTRY_ID = 'dsh-tray-follower'
const NS = 'settings.trayFollower'
const SLOT = 'settings.section'
const SETTINGS_SECTION_ID = 'tray-follower'
const ABOUT_SECTION_ID = 'tray-follower-about'
const SESSION_EVENT = 'dsh-tray-follower:open-session'

const AUTHOR_URL = 'https://github.com/Green233233'
const REPOSITORY_URL = 'https://github.com/Green233233/dsh_tray_follower'
const ACKNOWLEDGEMENT_URL = 'https://github.com/DuoZhao2026'
const ACKNOWLEDGEMENT_ZH =
  '感谢@DuoZhao2026（https://github.com/DuoZhao2026）提供的情感支持。谢谢小不点er ✧٩(ˊᗜˋ*)و✧'
const ACKNOWLEDGEMENT_EN =
  'Thanks to @DuoZhao2026 (https://github.com/DuoZhao2026) for the emotional support. 谢谢小不点er ✧٩(ˊᗜˋ*)و✧'

/** Field names fixed by the Host contract; also the switch render order. */
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

/** Resolve after pending promise callbacks and timers have run. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Fake React with a minimal render loop: `useState` persists per hook index,
 * `useEffect` honors deps, and a setState marks the tree dirty so the next
 * `renderPage` renders again. Function components inside the returned tree
 * (the `ui.Switch` stub) are expanded once, like React would render them.
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
  const expand = (node) => {
    if (node === null || node === undefined) return node
    if (Array.isArray(node)) return node.map(expand)
    if (typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    if (node.props === undefined || node.props === null) return node
    return { type: node.type, props: Object.assign({}, node.props, { children: expand(node.props.children) }) }
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
      return expand(tree)
    },
  }
}

/** Stub for the app-native `ui.Switch`: records props, renders a real switch. */
function createSwitchStub(react, calls) {
  return function Switch(props) {
    calls.push(props)
    return react.createElement('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': props.checked === true,
      'aria-label': props.label,
      disabled: props.disabled === true,
      onClick: () => {
        if (typeof props.onChange === 'function') props.onChange(!(props.checked === true))
      },
    })
  }
}

/** Minimal window with the DOM event API the deep link listener uses. */
function createWindow(loaded) {
  const listeners = new Map()
  const focusCalls = { count: 0 }
  const window = {
    __ModuleLoader__: {
      load(definition) {
        loaded.push(definition)
      },
    },
    focus() {
      focusCalls.count += 1
    },
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type, listener) {
      const set = listeners.get(type)
      if (set !== undefined) set.delete(listener)
    },
    dispatch(type, detail) {
      for (const listener of Array.from(listeners.get(type) ?? [])) listener({ type, detail })
    },
    listenerCount(type) {
      return (listeners.get(type) ?? new Set()).size
    },
    focusCalls,
  }
  return window
}

/** Execute client.js in a sandbox and return the registered module. */
function loadModule(react, primitives) {
  const loaded = []
  const window = createWindow(loaded)
  vm.runInContext(CLIENT_SOURCE, vm.createContext({ window, console }), { filename: CLIENT_PATH })
  assert.equal(loaded.length, 1, 'client.js registers exactly one module')
  const definition = loaded[0]
  const modules = { react, [PRIMITIVES_ID]: primitives }
  const module = definition.factory((id) => {
    assert.ok(id in modules, `unexpected module request: ${id}`)
    return modules[id]
  })
  return { definition, module, window }
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

/** Fake plugin context for `apply`, including the workspace service. */
function createContext(locale, slots, form) {
  const effects = []
  const configFormsGets = []
  const openedSessions = []
  return {
    effects,
    configFormsGets,
    openedSessions,
    locale,
    slots,
    uiWorkspace: {
      openSession(sessionId) {
        openedSessions.push(sessionId)
      },
    },
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
  const switchCalls = []
  const primitives =
    overrides.nativeSwitch === false
      ? {}
      : { Switch: createSwitchStub(runtime.react, switchCalls) }
  const { definition, module, window } = loadModule(runtime.react, primitives)
  const locale = createLocale()
  const slots = createSlots()
  const formHandle = createForm(overrides.value, overrides.accept)
  if (overrides.snapshot !== undefined) {
    formHandle.setSnapshot(Object.assign({}, formHandle.form.getSnapshot(), overrides.snapshot))
  }
  const ctx = createContext(locale, slots, formHandle.form)
  module.apply(ctx)
  const injected = slots.injected.filter((candidate) => candidate.name === SLOT)
  assert.equal(injected.length, 1, 'one settings.section registration')
  injected[0].callback()
  assert.equal(slots.registrations.length, 1, 'one settings page registered')
  const entry = slots.registrations[0]
  if (overrides.language !== undefined) locale.use(overrides.language)
  const t = locale.bind(NS)
  const injectedProps = typeof entry.options.inject === 'function' ? entry.options.inject() : {}
  const props = Object.assign({ t }, injectedProps)
  const render = () => runtime.renderPage(entry.component, () => props)
  return { definition, module, window, locale, slots, ctx, formHandle, entry, t, render, switchCalls }
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

/** Concatenate every string in a rendered tree, including array children. */
function textOf(node) {
  const parts = []
  const visit = (current) => {
    if (current === null || current === undefined) return
    if (typeof current === 'string') {
      parts.push(current)
      return
    }
    if (Array.isArray(current)) {
      for (const child of current) visit(child)
      return
    }
    if (typeof current !== 'object') return
    visit(current.props?.children)
  }
  visit(node)
  return parts.join('')
}

/** All rendered switch buttons, in page order. */
function switchButtons(tree) {
  return findAll(tree, (element) => element.props?.role === 'switch')
}

/** The switch for one config field, resolved by its fixed render order. */
function toggleAt(tree, field) {
  const index = TOGGLE_FIELDS.indexOf(field)
  assert.ok(index >= 0, `unknown toggle field ${field}`)
  const button = switchButtons(tree)[index]
  assert.ok(button, `switch for ${field} rendered`)
  return button
}

/** Locate one control (number input) by its config field. */
function findControl(tree, field) {
  return findAll(tree, (element) => element.props?.['data-field'] === field)[0]
}

/** Locate the status/notice paragraph. */
function findNotice(tree) {
  return findAll(tree, (element) => element.props?.role === 'status')[0]
}

/** All in-page tab buttons, in render order. */
function tabButtons(tree) {
  return findAll(tree, (element) => element.props?.role === 'tab')
}

/** The in-page tab button carrying one label. */
function tabByLabel(tree, label) {
  return tabButtons(tree).find((button) => textOf(button) === label)
}

/** The active in-page tab panel. */
function tabPanel(tree) {
  return findAll(tree, (element) => element.props?.role === 'tabpanel')[0]
}

test('client module uses the package id and requires the workspace service', () => {
  const runtime = createRuntime()
  const { definition, module } = loadModule(runtime.react, {})
  assert.equal(definition.id, MODULE_ID)
  // Values created inside the vm context are from another realm; copy before comparing.
  assert.deepEqual(Array.from(module.inject), ['uiWorkspace', 'slots', 'locale', 'configForms'])
})

test('apply registers dictionaries and the single settings section', () => {
  const { locale, slots, ctx, entry, formHandle } = setup()

  // Dictionaries: one namespace, both baseline locales, same keys.
  assert.equal(locale.registered.length, 1)
  const dictionaries = locale.registered[0]
  assert.equal(dictionaries.ns, NS)
  const zhKeys = Object.keys(dictionaries.locales.zh).sort()
  const enKeys = Object.keys(dictionaries.locales.en).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh and en cover the same keys')
  assert.equal(dictionaries.locales.zh.nav, '托盘随航')
  assert.equal(dictionaries.locales.zh.title, '托盘随航')
  assert.equal(dictionaries.locales.en.nav, 'Tray follower')
  assert.equal(dictionaries.locales.en.title, 'Tray follower')
  assert.equal(dictionaries.locales.zh.settingsTab, '设置')
  assert.equal(dictionaries.locales.en.settingsTab, 'Settings')
  assert.equal(dictionaries.locales.zh.aboutNav, '关于')
  assert.equal(dictionaries.locales.en.aboutNav, 'About')

  // The acknowledgement text is composed exactly as requested.
  assert.equal(dictionaries.locales.zh.ackPrefix + '@DuoZhao2026' + dictionaries.locales.zh.ackSuffix, ACKNOWLEDGEMENT_ZH)
  assert.equal(dictionaries.locales.en.ackPrefix + '@DuoZhao2026' + dictionaries.locales.en.ackSuffix, ACKNOWLEDGEMENT_EN)

  // The shared Config form is resolved once by the Host entry id.
  assert.deepEqual(ctx.configFormsGets, [ENTRY_ID])

  // Exactly one `settings.section` registration remains: the About content is
  // an in-page tab, not a second Settings section.
  assert.deepEqual(
    slots.injected.map((candidate) => candidate.name),
    [SLOT],
  )
  assert.equal(slots.registrations.length, 1)
  assert.equal(entry.options.name, SLOT)
  assert.equal(entry.options.id, SETTINGS_SECTION_ID)
  assert.equal(entry.options.order, 30)
  assert.equal(entry.options.locale, NS)
  assert.equal(entry.options.label(), '托盘随航')
  assert.equal(
    slots.registrations.some((candidate) => candidate.options.id === ABOUT_SECTION_ID),
    false,
    'no separate About section is registered',
  )
  locale.use('en')
  assert.equal(entry.options.label(), 'Tray follower', 'settings label follows the active language')
  locale.use('zh')

  assert.equal(entry.options.inject().form, formHandle.form)
  assert.equal(typeof entry.component, 'function')
})

test('page renders through the native Switch, both card groups and every field', () => {
  const { render, formHandle, switchCalls } = setup()
  const page = render()
  const text = textOf(page)
  assert.ok(text.includes('托盘随航'), 'page heading')
  assert.ok(text.includes('托盘右键菜单'), 'tray group title')
  assert.ok(text.includes('通知'), 'notification group title')
  assert.ok(text.includes('1–20'), 'range suffix hint')

  // Eight switches, all rendered by the app-native `ui.Switch`.
  const buttons = switchButtons(page)
  assert.equal(buttons.length, TOGGLE_FIELDS.length)
  for (const field of TOGGLE_FIELDS) {
    const button = toggleAt(page, field)
    assert.equal(button.type, 'button')
    assert.equal(typeof button.props['aria-checked'], 'boolean')
    assert.equal(button.props.disabled, false)
  }
  const latest = switchCalls.slice(-TOGGLE_FIELDS.length)
  assert.equal(latest.length, TOGGLE_FIELDS.length, 'native Switch rendered for every toggle')
  latest.forEach((props, index) => {
    assert.equal(typeof props.checked, 'boolean', `Switch ${index} checked prop`)
    assert.equal(typeof props.disabled, 'boolean', `Switch ${index} disabled prop`)
    assert.equal(typeof props.onChange, 'function', `Switch ${index} onChange prop`)
    assert.equal(props.label.length > 0, true)
  })
  assert.equal(new Set(latest.map((props) => props.label)).size, TOGGLE_FIELDS.length, 'one label per toggle')

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
  assert.equal(toggleAt(updated, 'notifyOnCompleted').props['aria-checked'], false)
})

test('a switch flips immediately and keeps the optimistic value until the snapshot lands', async () => {
  const { render, formHandle } = setup()
  let page = render()
  assert.equal(toggleAt(page, 'showIdle').props['aria-checked'], false)

  toggleAt(page, 'showIdle').props.onClick()

  // The Host round-trip is still in flight: form.set was called once...
  assert.deepEqual(formHandle.writes, [['showIdle', true]])
  assert.equal(formHandle.form.getSnapshot().value.showIdle, false, 'snapshot is still old')
  // ...and the very next render already shows the flipped switch.
  page = render()
  assert.equal(toggleAt(page, 'showIdle').props['aria-checked'], true, 'optimistic flip is immediate')

  // The accepted value lands in the shared snapshot.
  await flush()
  formHandle.updateValue({ showIdle: true })
  page = render()
  assert.equal(toggleAt(page, 'showIdle').props['aria-checked'], true)
  assert.deepEqual(formHandle.writes, [['showIdle', true]], 'no duplicate write')

  // Pending state was cleared, so a later external change becomes visible.
  formHandle.updateValue({ showIdle: false })
  page = render()
  assert.equal(toggleAt(page, 'showIdle').props['aria-checked'], false, 'optimistic value was released')
})

test('a refused write reverts the switch and shows the save-failed notice', async () => {
  const { render, formHandle } = setup({ accept: (field) => field !== 'notifyOnFailed' })
  let page = render()
  assert.equal(toggleAt(page, 'notifyOnFailed').props['aria-checked'], true)

  toggleAt(page, 'notifyOnFailed').props.onClick()
  page = render()
  assert.equal(toggleAt(page, 'notifyOnFailed').props['aria-checked'], false, 'optimistic flip')

  await flush()
  page = render()
  assert.equal(toggleAt(page, 'notifyOnFailed').props['aria-checked'], true, 'refusal reverts the switch')
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
    assert.equal(toggleAt(loadingPage, field).props.disabled, true, `${field} disabled while loading`)
  }
  assert.equal(findControl(loadingPage, NUMBER_FIELD).props.disabled, true)
  toggleAt(loadingPage, 'showIdle').props.onClick()
  assert.deepEqual(loading.formHandle.writes, [], 'disabled toggles never write')

  const readOnly = setup({ snapshot: { status: 'ready', writable: false } })
  const readOnlyPage = readOnly.render()
  const readOnlyNotice = findNotice(readOnlyPage)
  assert.ok(readOnlyNotice, 'read-only notice rendered')
  assert.equal(textOf(readOnlyNotice), '本部署的设置为只读。')
  for (const field of TOGGLE_FIELDS) {
    assert.equal(toggleAt(readOnlyPage, field).props.disabled, true, `${field} disabled when read-only`)
  }
  assert.equal(findControl(readOnlyPage, NUMBER_FIELD).props.disabled, true)
})

test('the compact fallback switch is used only when ui.Switch is missing', () => {
  const { render, formHandle, switchCalls } = setup({ nativeSwitch: false })
  assert.equal(switchCalls.length, 0, 'native Switch is not required for the fallback')

  let page = render()
  const buttons = switchButtons(page)
  assert.equal(buttons.length, TOGGLE_FIELDS.length)
  for (const button of buttons) {
    assert.equal(button.type, 'button')
    assert.equal(typeof button.props['aria-checked'], 'boolean')
    assert.equal(button.props.disabled, false)
  }
  assert.equal(toggleAt(page, 'showIdle').props['aria-checked'], false)
  toggleAt(page, 'showIdle').props.onClick()
  assert.deepEqual(formHandle.writes, [['showIdle', true]])
  page = render()
  assert.equal(toggleAt(page, 'showIdle').props['aria-checked'], true, 'fallback also flips optimistically')
})

test('the About content is an in-page tab of the settings page, not a section', () => {
  const { render } = setup()
  let page = render()

  // Tab row: exactly two tabs, 设置 active by default, 关于 second.
  const tabs = tabButtons(page)
  assert.equal(tabs.length, 2)
  assert.deepEqual(tabs.map((tab) => textOf(tab)), ['设置', '关于'])
  assert.equal(tabs[0].props.role, 'tab')
  assert.equal(tabs[0].props['aria-selected'], true)
  assert.equal(tabs[1].props['aria-selected'], false)
  assert.equal(tabs[0].props.tabIndex, 0)
  assert.equal(tabs[1].props.tabIndex, -1)
  assert.equal(tabs[0].props['aria-controls'], 'tray-follower-panel-settings')

  // The default panel keeps the settings groups and shows no About content.
  const settingsPanel = tabPanel(page)
  assert.ok(settingsPanel, 'settings panel rendered')
  assert.equal(settingsPanel.props.id, 'tray-follower-panel-settings')
  assert.ok(textOf(page).includes('托盘右键菜单'))
  assert.ok(!textOf(page).includes('Green233233'))

  // Switching to 关于 renders the About content inside the same page.
  tabByLabel(page, '关于').props.onClick()
  page = render()
  const aboutPanel = tabPanel(page)
  assert.equal(aboutPanel.props.id, 'tray-follower-panel-about')
  assert.equal(aboutPanel.props['aria-labelledby'], 'tray-follower-tab-about')
  const aboutText = textOf(page)
  assert.ok(aboutText.includes('托盘随航'), 'plugin title stays visible')
  assert.ok(aboutText.includes('Green233233'), 'author name')
  assert.ok(aboutText.includes(REPOSITORY_URL), 'repository url')
  assert.ok(aboutText.includes('MIT'), 'license')
  assert.ok(aboutText.includes(ACKNOWLEDGEMENT_ZH), 'exact Chinese acknowledgement line')
  assert.ok(!aboutText.includes('托盘右键菜单'), 'settings groups are hidden on the About tab')
  assert.equal(tabByLabel(page, '关于').props['aria-selected'], true)
  assert.equal(tabByLabel(page, '设置').props['aria-selected'], false)

  const links = findAll(page, (element) => element.type === 'a')
  const byHref = new Map(links.map((link) => [link.props.href, link]))
  assert.ok(byHref.has(AUTHOR_URL), 'author link')
  assert.ok(byHref.has(REPOSITORY_URL), 'repository link')
  assert.ok(byHref.has(ACKNOWLEDGEMENT_URL), 'acknowledgement link')
  for (const href of [AUTHOR_URL, REPOSITORY_URL, ACKNOWLEDGEMENT_URL]) {
    const link = byHref.get(href)
    assert.equal(link.props.target, '_blank', `${href} opens externally`)
    assert.equal(link.props.rel, 'noreferrer noopener', `${href} drops the referrer`)
  }
  assert.equal(textOf(byHref.get(AUTHOR_URL)), 'Green233233')
  assert.equal(textOf(byHref.get(ACKNOWLEDGEMENT_URL)), '@DuoZhao2026', 'link text includes the @')

  // Switching back restores the settings groups.
  tabByLabel(page, '设置').props.onClick()
  page = render()
  assert.ok(textOf(page).includes('托盘右键菜单'))
  assert.ok(!textOf(page).includes('Green233233'))
  assert.equal(tabPanel(page).props.id, 'tray-follower-panel-settings')

  // The same tabs render in English, including the acknowledgement line.
  const englishHarness = setup({ language: 'en' })
  let english = englishHarness.render()
  assert.deepEqual(tabButtons(english).map((tab) => textOf(tab)), ['Settings', 'About'])
  tabByLabel(english, 'About').props.onClick()
  english = englishHarness.render()
  assert.ok(textOf(english).includes(ACKNOWLEDGEMENT_EN), 'exact English acknowledgement line')
})

test('the in-page tabs respond to keyboard navigation', () => {
  const { render } = setup()
  let page = render()
  let prevented = false

  const press = (label, key) => {
    tabByLabel(page, label).props.onKeyDown({
      key,
      preventDefault() {
        prevented = true
      },
      currentTarget: { parentElement: null },
    })
    page = render()
  }

  press('设置', 'ArrowRight')
  assert.equal(prevented, true, 'arrow key handling prevents the default')
  assert.equal(tabByLabel(page, '关于').props['aria-selected'], true)

  press('关于', 'ArrowLeft')
  assert.equal(tabByLabel(page, '设置').props['aria-selected'], true)

  press('设置', 'End')
  assert.equal(tabByLabel(page, '关于').props['aria-selected'], true)

  press('关于', 'Home')
  assert.equal(tabByLabel(page, '设置').props['aria-selected'], true)

  // Unhandled keys leave the active tab alone.
  press('设置', 'Tab')
  assert.equal(tabByLabel(page, '设置').props['aria-selected'], true)
})

test('window session event opens the session through uiWorkspace', () => {
  const { window, ctx } = setup()
  assert.equal(window.listenerCount(SESSION_EVENT), 1, 'deep link listener installed')

  window.dispatch(SESSION_EVENT, 'session-abc')
  assert.deepEqual(ctx.openedSessions, ['session-abc'])
  assert.equal(window.focusCalls.count, 1, 'window focused before opening')

  // Empty or non-string details are ignored.
  window.dispatch(SESSION_EVENT, '')
  window.dispatch(SESSION_EVENT, undefined)
  window.dispatch(SESSION_EVENT, 42)
  assert.deepEqual(ctx.openedSessions, ['session-abc'])

  // Unloading the plugin removes the listener.
  const effect = ctx.effects.find((candidate) => candidate.label.includes('session deep link'))
  assert.ok(effect, 'deep link is an owned effect')
  effect.dispose()
  assert.equal(window.listenerCount(SESSION_EVENT), 0)
  window.dispatch(SESSION_EVENT, 'session-later')
  assert.deepEqual(ctx.openedSessions, ['session-abc'])
})

test('manifest and locale resources carry the v0.2.2 rename and dependencies', () => {
  assert.equal(MANIFEST.version, '0.2.2')
  assert.equal(MANIFEST.exports['./client'], './client.js')
  assert.ok(MANIFEST.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'))
  assert.ok(MANIFEST.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'))
  assert.ok(MANIFEST.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
  assert.ok(MANIFEST.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))

  assert.equal(ZH_LOCALE.meta.title, '托盘随航')
  assert.equal(EN_LOCALE.meta.title, 'Tray follower')
  assert.ok(ZH_LOCALE.meta.description.includes('桥接'), 'zh description names the desktop bridge')
  assert.ok(!ZH_LOCALE.meta.description.includes('兜底'), 'zh description drops the stale fallback claim')
  assert.ok(!/fallback/iu.test(EN_LOCALE.meta.description), 'en description drops the stale fallback claim')
  assert.ok(EN_LOCALE.meta.description.includes('bridge'), 'en description names the desktop bridge')
})
