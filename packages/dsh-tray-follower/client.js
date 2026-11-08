/**
 * dsh-tray-follower — Client half.
 *
 * Adds two "settings.section" pages to DSH Settings — the preferences page for
 * the Host Config of the `dsh-tray-follower` Loader entry, and an About page —
 * and forwards the bridge's session deep link into the workspace service.
 *
 * The browser artifact is a plain script registered with the Harness module
 * loader: no JSX and no bundler. React and the app-native UI primitives come
 * from the loader's baseline module table. Styling uses only `--dsw-alias-*`
 * theme tokens and inline style objects.
 *
 * Interaction model:
 * - The config snapshot is read through a small stable store hook (`useState`
 *   + `useEffect` subscribe), the same pattern as the official
 *   `createSnapshotStore`, so every Host revision re-renders reliably.
 * - A switch flips immediately in local `pending` state, then submits
 *   `form.set(field, value)`. The pending value survives until the snapshot
 *   reflects it; a refusal or rejection reverts the switch and shows the
 *   save-failed notice.
 * - The switch control itself is the app's own `ui.Switch`, so it matches the
 *   rest of the Settings UI; a compact button fallback stays if that baseline
 *   primitive is missing.
 *
 * Host contract (owned by the Host half, fixed field names):
 *   showIdle, maxSessionsPerWorkspace, showHeaderCounts, showFooter,
 *   notifyOnCompleted, notifyOnFailed, notifyOnAttention,
 *   suppressWhenFocused, notificationSound
 */
window.__ModuleLoader__.load({
  id: 'dsh-tray-follower',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    /** App-native primitives; the Switch falls back if this baseline is absent. */
    let ui
    try {
      ui = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      ui = undefined
    }
    const NativeSwitch = ui !== undefined && ui !== null && typeof ui.Switch === 'function' ? ui.Switch : undefined

    /** Dictionary namespace owned by these pages. */
    const NS = 'settings.trayFollower'
    /** Host Config entry id: the Loader row and settings namespace. */
    const ENTRY_ID = 'dsh-tray-follower'
    /** Settings navigation slot both pages fill. */
    const SLOT = 'settings.section'
    /** Bridge → Web page deep link event; `event.detail` is the session id. */
    const SESSION_EVENT = 'dsh-tray-follower:open-session'
    /** Author, repository and acknowledgement targets shown on the About page. */
    const AUTHOR_URL = 'https://github.com/Green233233'
    const REPOSITORY_URL = 'https://github.com/Green233233/dsh_tray_follower'
    const ACKNOWLEDGEMENT_URL = 'https://github.com/DuoZhao2026'
    const LICENSE = 'MIT'
    /** Bounds of the one numeric field. */
    const MAX_SESSIONS_MIN = 1
    const MAX_SESSIONS_MAX = 20

    /**
     * Defaults shown before the Host answers. The Host Config owns the real
     * defaults; these only keep the first paint stable while `status` is
     * still `loading` and mirror the documented contract.
     */
    const DEFAULTS = {
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

    /**
     * Rows in render order. `kind` decides the control; every `field` must be
     * a Host Config field name above.
     */
    const GROUPS = [
      {
        titleKey: 'trayGroup',
        rows: [
          { field: 'showIdle', kind: 'toggle' },
          { field: 'maxSessionsPerWorkspace', kind: 'number' },
          { field: 'showHeaderCounts', kind: 'toggle' },
          { field: 'showFooter', kind: 'toggle' },
        ],
      },
      {
        titleKey: 'notifyGroup',
        rows: [
          { field: 'notifyOnCompleted', kind: 'toggle' },
          { field: 'notifyOnFailed', kind: 'toggle' },
          { field: 'notifyOnAttention', kind: 'toggle' },
          { field: 'suppressWhenFocused', kind: 'toggle' },
          { field: 'notificationSound', kind: 'toggle' },
        ],
      },
    ]

    /** English copy, complete for every key used by both pages. */
    const en = {
      nav: 'Tray follower',
      title: 'Tray follower',
      description:
        'Control how conversations are grouped in the desktop tray menu, and when DSH raises native notifications. Changes apply immediately.',
      trayGroup: 'Tray context menu',
      notifyGroup: 'Notifications',
      showIdle: 'Show idle conversations',
      showIdleHint: 'Also list conversations that are not running. Off by default.',
      maxSessionsPerWorkspace: 'Conversations per workspace',
      maxSessionsPerWorkspaceHint: 'How many conversations each workspace lists.',
      showHeaderCounts: 'Show counts in the header',
      showHeaderCountsHint: 'Append running and waiting counts to the conversation header.',
      showFooter: 'Show the footer',
      showFooterHint: 'Show the Tray follower version line at the bottom of the menu.',
      notifyOnCompleted: 'Notify when a conversation completes',
      notifyOnCompletedHint: 'Raise a system notification when a conversation finishes successfully.',
      notifyOnFailed: 'Notify when a conversation fails',
      notifyOnFailedHint: 'Raise a system notification when a conversation ends with an error.',
      notifyOnAttention: 'Notify when attention is needed',
      notifyOnAttentionHint: 'Notify about pending approvals and questions that wait for an answer.',
      suppressWhenFocused: 'Stay quiet while DSH is focused',
      suppressWhenFocusedHint: 'Skip notifications while the DSH window is in the foreground.',
      notificationSound: 'Play the notification sound',
      notificationSoundHint: 'Play the system alert sound with each notification.',
      loading: 'Reading settings…',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      saveFailed: 'The settings were not saved. Please try again.',
      aboutNav: 'About',
      aboutIntro: 'Version, repository, and acknowledgements.',
      aboutGroup: 'Plugin details',
      aboutAuthor: 'Author',
      aboutRepository: 'Repository',
      aboutLicense: 'License',
      ackGroup: 'Acknowledgements',
      ackPrefix: 'Thanks to ',
      ackSuffix:
        ' (https://github.com/DuoZhao2026) for the emotional support. 谢谢小不点er ✧٩(ˊᗜˋ*)و✧',
    }

    /** Simplified Chinese copy; same keys as `en`. */
    const zh = {
      nav: '托盘随航',
      title: '托盘随航',
      description:
        '控制桌面托盘右键菜单里对话的分组方式，以及 DSH 在对话状态变化时发出系统通知的时机。修改立即生效，无需重启。',
      trayGroup: '托盘右键菜单',
      notifyGroup: '通知',
      showIdle: '显示空闲对话',
      showIdleHint: '打开后，托盘菜单也会列出没有在运行的对话。默认关闭。',
      maxSessionsPerWorkspace: '每个工作区显示的对话数',
      maxSessionsPerWorkspaceHint: '每个工作区最多列出多少个对话。',
      showHeaderCounts: '标题显示数量',
      showHeaderCountsHint: '在“对话状态”标题后显示运行中与等待中的数量。',
      showFooter: '显示页脚',
      showFooterHint: '在菜单底部显示托盘随航的版本信息。',
      notifyOnCompleted: '对话完成时通知',
      notifyOnCompletedHint: '对话成功结束时发送系统通知。',
      notifyOnFailed: '对话失败时通知',
      notifyOnFailedHint: '对话因错误结束时发送系统通知。',
      notifyOnAttention: '需要处理时通知',
      notifyOnAttentionHint: '出现待批准的权限请求或待回答的问题时发送通知。',
      suppressWhenFocused: '窗口聚焦时不通知',
      suppressWhenFocusedHint: 'DSH 窗口在前台时不再发送系统通知。',
      notificationSound: '播放通知声音',
      notificationSoundHint: '发送通知时播放系统提示音。',
      loading: '正在读取设置…',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      saveFailed: '设置没有保存成功，请重试。',
      aboutNav: '关于',
      aboutIntro: '版本信息、代码仓库与致谢。',
      aboutGroup: '插件信息',
      aboutAuthor: '作者',
      aboutRepository: '仓库',
      aboutLicense: '许可证',
      ackGroup: '致谢',
      ackPrefix: '感谢',
      ackSuffix: '（https://github.com/DuoZhao2026）提供的情感支持。谢谢小不点er ✧٩(ˊᗜˋ*)و✧',
    }

    /** Inline styles; every color is a DSH theme token, never a literal. */
    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        maxWidth: '720px',
        minWidth: 0,
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: '20px',
      },
      heading: {
        margin: 0,
        fontSize: '17px',
        lineHeight: '24px',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
      },
      intro: {
        margin: 0,
        fontSize: '13px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      notice: {
        margin: '12px 0 0',
        fontSize: '12.5px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      noticeError: {
        color: 'var(--dsw-alias-state-error-primary)',
      },
      group: {
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      },
      groupTitle: {
        margin: 0,
        padding: '12px 0',
        fontSize: '13px',
        lineHeight: '18px',
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        padding: '4px 16px',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '12px',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        minHeight: '44px',
        padding: '10px 0',
        boxSizing: 'border-box',
      },
      rowDivider: {
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      rowCopy: {
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      },
      rowLabel: {
        fontSize: '14px',
        lineHeight: '20px',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-primary)',
      },
      rowHint: {
        marginTop: '2px',
        fontSize: '12.5px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      controlColumn: {
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: '8px',
        minWidth: '120px',
      },
      disabled: {
        opacity: 0.5,
        cursor: 'not-allowed',
      },
      numberInput: {
        width: '84px',
        boxSizing: 'border-box',
        padding: '6px 10px',
        fontSize: '13.5px',
        lineHeight: '20px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
      },
      rangeHint: {
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      fallbackSwitch: {
        minWidth: '64px',
        boxSizing: 'border-box',
        padding: '4px 10px',
        fontSize: '12px',
        lineHeight: '18px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      link: {
        color: 'var(--dsw-alias-brand-primary)',
        textDecoration: 'underline',
        textUnderlineOffset: '2px',
        fontSize: '13px',
        lineHeight: '20px',
        wordBreak: 'break-all',
        textAlign: 'right',
      },
      licenseValue: {
        fontSize: '13px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-primary)',
      },
      acknowledgement: {
        margin: 0,
        padding: '14px 0',
        fontSize: '13.5px',
        lineHeight: '22px',
        color: 'var(--dsw-alias-label-primary)',
      },
    }

    /** Stable snapshot of the placeholder store below. */
    const MISSING_SNAPSHOT = { status: 'unavailable', writable: false, revision: undefined, value: {} }

    /**
     * Placeholder store used only if the slot delivers no form; keeps the
     * component renderable instead of crashing the slot entry.
     */
    const MISSING_FORM = {
      getSnapshot() {
        return MISSING_SNAPSHOT
      },
      subscribe() {
        return () => {}
      },
      set() {
        return Promise.resolve(false)
      },
      unset() {
        return Promise.resolve(false)
      },
    }

    /** Resolve a boolean preference, falling back to the documented default. */
    function readToggle(values, field) {
      const value = values[field]
      return typeof value === 'boolean' ? value : DEFAULTS[field] === true
    }

    /** Resolve the numeric preference, falling back to the documented default. */
    function readNumber(values, field) {
      const value = values[field]
      return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULTS[field]
    }

    /** Clamp the session cap to the range the Host schema accepts. */
    function clampSessions(value) {
      if (!Number.isFinite(value)) return DEFAULTS.maxSessionsPerWorkspace
      const rounded = Math.round(value)
      if (rounded < MAX_SESSIONS_MIN) return MAX_SESSIONS_MIN
      if (rounded > MAX_SESSIONS_MAX) return MAX_SESSIONS_MAX
      return rounded
    }

    /**
     * Read the shared Host Config form as a stable React store: one snapshot
     * state, one subscription effect. This is the `useState` + `useEffect`
     * shape of the official `createSnapshotStore`, and avoids relying on a
     * fresh `getSnapshot` closure for every render.
     * @param {any} form the shared config form for this Host entry
     * @returns the current form snapshot
     */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
      React.useEffect(() => {
        let active = true
        const sync = () => {
          if (!active) return
          setSnapshot(() => form.getSnapshot())
        }
        sync()
        let dispose
        try {
          dispose = form.subscribe(sync)
        } catch {
          dispose = undefined
        }
        return () => {
          active = false
          if (typeof dispose === 'function') {
            try {
              dispose()
            } catch {
              // The owning form already settled the subscription.
            }
          }
        }
      }, [form])
      return snapshot
    }

    /**
     * A switch control: the app-native `ui.Switch` when the baseline module
     * provides it, otherwise a compact labelled button with the same
     * `role="switch"` / `aria-checked` semantics.
     */
    function switchControl(options) {
      const { field, checked, disabled, label, onChange } = options
      if (NativeSwitch !== undefined) {
        return h(NativeSwitch, {
          key: field,
          checked,
          disabled,
          label,
          onChange: (next) => onChange(typeof next === 'boolean' ? next : !checked),
        })
      }
      return h(
        'button',
        {
          key: field,
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          'data-field': field,
          disabled,
          onClick: () => onChange(!checked),
          style: disabled ? Object.assign({}, styles.fallbackSwitch, styles.disabled) : styles.fallbackSwitch,
        },
        checked ? '✓' : '—',
      )
    }

    /** One labelled preference row with its control on the trailing edge. */
    function toggleRow(options) {
      const { t, field, checked, disabled, onToggle, divider } = options
      return h(
        'div',
        {
          key: field,
          style: divider ? Object.assign({}, styles.row, styles.rowDivider) : styles.row,
        },
        h(
          'div',
          { style: styles.rowCopy },
          h('div', { style: styles.rowLabel }, t(field)),
          h('div', { style: styles.rowHint }, t(`${field}Hint`)),
        ),
        h(
          'div',
          { style: styles.controlColumn },
          switchControl({
            field,
            checked,
            disabled,
            label: t(field),
            onChange: (next) => onToggle(field, next),
          }),
        ),
      )
    }

    /** The numeric session-cap row: a native number input, written on blur. */
    function numberRow(options) {
      const { t, field, value, disabled, onBlur, onKeyDown, divider } = options
      const inputId = `dsh-tray-follower-${field}`
      return h(
        'div',
        {
          key: field,
          style: divider ? Object.assign({}, styles.row, styles.rowDivider) : styles.row,
        },
        h(
          'div',
          { style: styles.rowCopy },
          h('label', { style: styles.rowLabel, htmlFor: inputId }, t(field)),
          h('div', { style: styles.rowHint }, t(`${field}Hint`)),
        ),
        h(
          'div',
          { style: styles.controlColumn },
          h('input', {
            id: inputId,
            type: 'number',
            inputMode: 'numeric',
            min: MAX_SESSIONS_MIN,
            max: MAX_SESSIONS_MAX,
            step: 1,
            defaultValue: String(value),
            'aria-label': t(field),
            'data-field': field,
            disabled,
            onBlur,
            onKeyDown,
            style: disabled
              ? Object.assign({}, styles.numberInput, styles.disabled)
              : styles.numberInput,
          }),
          h('span', { style: styles.rangeHint, 'aria-hidden': true }, '1–20'),
        ),
      )
    }

    /** External link opening in a new tab without a referrer. */
    function externalLink(options) {
      const { href, style, children } = options
      return h(
        'a',
        { href, target: '_blank', rel: 'noreferrer noopener', style: style ?? styles.link },
        children,
      )
    }

    /**
     * The settings page. It reads the shared Host Config form, optimistically
     * reflects each switch while the Host round-trip is in flight, and shows
     * the refusal notice when a write comes back rejected.
     * @param {{ t: (key: string) => string, form?: any }} props slot props
     * @returns the rendered React element tree
     */
    function SettingsPage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const form =
        props.form !== undefined &&
        props.form !== null &&
        typeof props.form.getSnapshot === 'function'
          ? props.form
          : MISSING_FORM
      const snapshot = useFormSnapshot(form)
      const [pending, setPending] = React.useState({})
      const [failed, setFailed] = React.useState(false)

      const status = snapshot !== undefined && snapshot !== null ? snapshot.status : 'loading'
      const writable = snapshot !== undefined && snapshot !== null && snapshot.writable === true
      const ready = status === 'ready'
      const disabled = !ready || !writable
      const snapshotValues =
        ready && snapshot.value !== undefined && snapshot.value !== null && typeof snapshot.value === 'object'
          ? snapshot.value
          : {}

      // Drop an optimistic value once the accepted snapshot carries it.
      React.useEffect(() => {
        if (snapshot === undefined || snapshot === null || snapshot.status !== 'ready') return
        const values = snapshot.value
        if (values === undefined || values === null || typeof values !== 'object') return
        setPending((current) => {
          let changed = false
          const next = {}
          for (const field of Object.keys(current)) {
            if (Object.prototype.hasOwnProperty.call(values, field) && values[field] === current[field]) {
              changed = true
              continue
            }
            next[field] = current[field]
          }
          return changed ? next : current
        })
      }, [snapshot])

      // Optimistic values win until the Host snapshot catches up.
      const values = Object.assign({}, snapshotValues, pending)

      /** Forget one optimistic value, restoring the snapshot value. */
      const clearPending = (field) => {
        setPending((current) => {
          if (!Object.prototype.hasOwnProperty.call(current, field)) return current
          const next = Object.assign({}, current)
          delete next[field]
          return next
        })
      }

      /**
       * Flip one switch immediately in local state, then persist it. A
       * refusal or rejection reverts the optimistic value and shows the
       * save-failed notice.
       */
      const write = (field, value) => {
        setPending((current) => Object.assign({}, current, { [field]: value }))
        let result
        try {
          result = form.set(field, value)
        } catch {
          clearPending(field)
          setFailed(true)
          return
        }
        if (result === undefined || result === null || typeof result.then !== 'function') return
        result.then(
          (accepted) => {
            if (accepted === false) {
              clearPending(field)
              setFailed(true)
            } else {
              setFailed(false)
            }
          },
          () => {
            clearPending(field)
            setFailed(true)
          },
        )
      }

      /** Flip one switch. Disabled rows never reach here. */
      const onToggle = (field, next) => {
        if (disabled) return
        write(field, typeof next === 'boolean' ? next : !readToggle(values, field))
      }

      /** Clamp and persist the session cap when the field loses focus. */
      const onNumberBlur = (event) => {
        const input = event !== undefined && event !== null ? event.currentTarget : undefined
        const raw = input !== undefined && input !== null ? String(input.value) : ''
        if (disabled) {
          if (input !== undefined && input !== null) input.value = String(readNumber(values, 'maxSessionsPerWorkspace'))
          return
        }
        const text = raw.trim()
        if (text === '') {
          if (input !== undefined && input !== null) input.value = String(readNumber(values, 'maxSessionsPerWorkspace'))
          return
        }
        const parsed = Number(text)
        if (!Number.isFinite(parsed)) {
          if (input !== undefined && input !== null) input.value = String(readNumber(values, 'maxSessionsPerWorkspace'))
          return
        }
        const clamped = clampSessions(parsed)
        if (input !== undefined && input !== null) input.value = String(clamped)
        const current = readNumber(values, 'maxSessionsPerWorkspace')
        if (clamped === current) return
        write('maxSessionsPerWorkspace', clamped)
      }

      /** Enter commits the number field through the same blur path. */
      const onNumberKeyDown = (event) => {
        if (event !== undefined && event !== null && event.key === 'Enter' && event.currentTarget !== null) {
          event.currentTarget.blur()
        }
      }

      const noticeKey =
        status !== 'ready'
          ? status === 'unavailable'
            ? 'unavailable'
            : 'loading'
          : !writable
            ? 'readOnly'
            : failed
              ? 'saveFailed'
              : undefined

      const children = [
        h('h2', { key: 'heading', style: styles.heading }, t('title')),
        h('p', { key: 'intro', style: styles.intro }, t('description')),
      ]
      if (noticeKey !== undefined) {
        children.push(
          h(
            'p',
            {
              key: 'notice',
              role: 'status',
              style:
                noticeKey === 'saveFailed'
                  ? Object.assign({}, styles.notice, styles.noticeError)
                  : styles.notice,
            },
            t(noticeKey),
          ),
        )
      }

      for (const group of GROUPS) {
        const rows = []
        for (const row of group.rows) {
          const divider = rows.length > 0
          if (row.kind === 'number') {
            rows.push(
              numberRow({
                t,
                field: row.field,
                value: readNumber(values, row.field),
                disabled,
                onBlur: onNumberBlur,
                onKeyDown: onNumberKeyDown,
                divider,
              }),
            )
          } else {
            rows.push(
              toggleRow({
                t,
                field: row.field,
                checked: readToggle(values, row.field),
                disabled,
                onToggle,
                divider,
              }),
            )
          }
        }
        children.push(
          h(
            'section',
            { key: group.titleKey, style: styles.group },
            h('h3', { style: styles.groupTitle }, t(group.titleKey)),
            h('div', { style: styles.card }, rows),
          ),
        )
      }

      return h('div', { style: styles.page }, children)
    }

    /**
     * The About page: plugin identity, author, repository, license, and the
     * acknowledgement line with the contributor's profile linked.
     * @param {{ t: (key: string) => string }} props slot props
     * @returns the rendered React element tree
     */
    function AboutPage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const acknowledgement = h(
        'p',
        { style: styles.acknowledgement },
        t('ackPrefix'),
        externalLink({ href: ACKNOWLEDGEMENT_URL, style: styles.link, children: '@DuoZhao2026' }),
        t('ackSuffix'),
      )
      return h(
        'div',
        { style: styles.page },
        h('h2', { key: 'heading', style: styles.heading }, t('title')),
        h('p', { key: 'intro', style: styles.intro }, t('aboutIntro')),
        h(
          'section',
          { key: 'details', style: styles.group },
          h('h3', { style: styles.groupTitle }, t('aboutGroup')),
          h(
            'div',
            { style: styles.card },
            h(
              'div',
              { key: 'author', style: styles.row },
              h('div', { style: styles.rowCopy }, h('div', { style: styles.rowLabel }, t('aboutAuthor'))),
              h(
                'div',
                { style: styles.controlColumn },
                externalLink({ href: AUTHOR_URL, children: 'Green233233' }),
              ),
            ),
            h(
              'div',
              { key: 'repository', style: Object.assign({}, styles.row, styles.rowDivider) },
              h('div', { style: styles.rowCopy }, h('div', { style: styles.rowLabel }, t('aboutRepository'))),
              h(
                'div',
                { style: styles.controlColumn },
                externalLink({ href: REPOSITORY_URL, children: REPOSITORY_URL }),
              ),
            ),
            h(
              'div',
              { key: 'license', style: Object.assign({}, styles.row, styles.rowDivider) },
              h('div', { style: styles.rowCopy }, h('div', { style: styles.rowLabel }, t('aboutLicense'))),
              h('div', { style: styles.controlColumn }, h('span', { style: styles.licenseValue }, LICENSE)),
            ),
          ),
        ),
        h(
          'section',
          { key: 'acknowledgements', style: styles.group },
          h('h3', { style: styles.groupTitle }, t('ackGroup')),
          h('div', { style: styles.card }, acknowledgement),
        ),
      )
    }

    return {
      /** Required client services: workspace deep links, slots, locale and forms. */
      inject: ['uiWorkspace', 'slots', 'locale', 'configForms'],
      /**
       * Register dictionaries, the bridge session deep link, and both Settings
       * pages. Everything is owned by `ctx.effect` / `ctx.slots.inject`, so
       * unloading the plugin removes all of it.
       * @param {any} ctx browser plugin context
       */
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tray-follower: dictionaries')

        // The desktop bridge cannot navigate the Web page itself; it dispatches
        // this window event and the page opens the session in the workspace.
        ctx.effect(() => {
          const target = typeof window !== 'undefined' ? window : undefined
          if (target === undefined || target === null || typeof target.addEventListener !== 'function') {
            return () => {}
          }
          const onOpenSession = (event) => {
            const sessionId = event !== undefined && event !== null ? event.detail : undefined
            if (typeof sessionId !== 'string' || sessionId === '') return
            try {
              target.focus()
            } catch {
              // Focusing the window is best effort.
            }
            try {
              ctx.uiWorkspace.openSession(sessionId)
            } catch (error) {
              try {
                console.warn('[dsh-tray-follower] open session failed:', error)
              } catch {
                // Diagnostics are best effort.
              }
            }
          }
          target.addEventListener(SESSION_EVENT, onOpenSession)
          return () => {
            try {
              target.removeEventListener(SESSION_EVENT, onOpenSession)
            } catch {
              // The page is going away; nothing to clean up.
            }
          }
        }, 'tray-follower: session deep link')

        const form = ctx.configForms.get(ENTRY_ID)
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: 'tray-follower',
              order: 30,
              label: () => t('nav'),
              locale: NS,
              inject: () => ({ form }),
            },
            SettingsPage,
          ),
        )
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: 'tray-follower-about',
              order: 31,
              label: () => t('aboutNav'),
              locale: NS,
            },
            AboutPage,
          ),
        )
      },
    }
  },
})
