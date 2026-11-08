/**
 * dsh-tray-follower — Client half.
 *
 * Adds a "Tray follower" page to DSH Settings that edits the Host Config
 * fields of the `dsh-tray-follower` Loader entry through the shared
 * `ctx.configForms` service, so tray-menu and notification behaviour can be
 * tuned without restarting DSH.
 *
 * The browser artifact is a plain script registered with the Harness module
 * loader: no JSX, no bundler, no import of any Harness Client package. React
 * comes from the loader's module table. Styling uses only `--dsw-alias-*`
 * theme tokens and inline style objects.
 *
 * Interaction model:
 * - The snapshot is read through a small stable store hook (`useState` +
 *   `useEffect` subscribe), the same pattern as the official
 *   `createSnapshotStore`, so every Host revision re-renders reliably.
 * - A switch flips immediately in local `pending` state, then submits
 *   `form.set(field, value)`. The pending value survives until the snapshot
 *   reflects it; a refusal or rejection reverts the switch and shows the
 *   save-failed notice.
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

    /** Dictionary namespace owned by this plugin. */
    const NS = 'settings.trayFollower'
    /** Host Config entry id: the Loader row and settings namespace. */
    const ENTRY_ID = 'dsh-tray-follower'
    /** Settings navigation slot this page fills. */
    const SLOT = 'settings.section'
    /** Navigation order; sits after the built-in sections. */
    const ORDER = 30
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

    /** English copy, complete for every key used by the page. */
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
      showFooterHint: 'Show the DSH tray-follower version line at the bottom of the menu.',
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
    }

    /** Simplified Chinese copy; same keys as `en`. */
    const zh = {
      nav: '托盘跟随',
      title: '托盘跟随',
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
      showFooterHint: '在菜单底部显示托盘跟随的版本信息。',
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
      switchTrack: {
        position: 'relative',
        flex: 'none',
        width: '40px',
        height: '22px',
        padding: 0,
        boxSizing: 'border-box',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        cursor: 'pointer',
        transition: 'background-color 150ms ease, border-color 150ms ease',
      },
      switchTrackOn: {
        background: 'var(--dsw-alias-brand-primary)',
        borderColor: 'transparent',
      },
      switchFocus: {
        outline: '2px solid var(--dsw-alias-brand-primary)',
        outlineOffset: '2px',
      },
      switchKnob: {
        position: 'absolute',
        top: '2px',
        left: '2px',
        display: 'block',
        width: '18px',
        height: '18px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-base)',
        boxSizing: 'border-box',
        transition: 'transform 150ms ease',
      },
      switchKnobOn: {
        transform: 'translateX(16px)',
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

    /** True when focus arrived from the keyboard, so only then show the ring. */
    function isKeyboardFocus(event) {
      try {
        const target = event !== undefined && event !== null ? event.currentTarget : undefined
        return typeof target?.matches === 'function' ? target.matches(':focus-visible') : true
      } catch {
        return true
      }
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
     * A settings switch: a real button with `role="switch"` and
     * `aria-checked`, matching how the Harness exposes binary preferences.
     */
    function switchControl(options) {
      const { field, checked, disabled, focusRing, label, onToggle, onFocus, onBlur } = options
      const track = disabled
        ? Object.assign({}, styles.switchTrack, checked ? styles.switchTrackOn : null, styles.disabled)
        : Object.assign({}, styles.switchTrack, checked ? styles.switchTrackOn : null)
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
          onClick: () => onToggle(field),
          onFocus,
          onBlur,
          style: focusRing ? Object.assign({}, track, styles.switchFocus) : track,
        },
        h(
          'span',
          {
            'aria-hidden': true,
            style: checked
              ? Object.assign({}, styles.switchKnob, styles.switchKnobOn)
              : styles.switchKnob,
          },
        ),
      )
    }

    /** One labelled preference row with its control on the trailing edge. */
    function toggleRow(options) {
      const { t, field, checked, disabled, focusRing, onToggle, onFocus, onBlur, divider } = options
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
            focusRing,
            label: t(field),
            onToggle,
            onFocus,
            onBlur,
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

    /**
     * The Settings page. It reads the shared Host Config form, optimistically
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
      const [focusRing, setFocusRing] = React.useState(null)

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
      const onToggle = (field) => {
        if (disabled) return
        write(field, !readToggle(values, field))
      }

      /** Show the keyboard focus ring on the switch that owns focus. */
      const onFocus = (field) => (event) => {
        if (isKeyboardFocus(event)) setFocusRing(field)
      }
      const onBlur = () => {
        setFocusRing(null)
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
                focusRing: focusRing === row.field,
                onToggle,
                onFocus: onFocus(row.field),
                onBlur,
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

    return {
      /** Required client services: slots, dictionaries, and the config forms. */
      inject: ['slots', 'locale', 'configForms'],
      /**
       * Register the dictionaries and the Settings page against the live Host
       * Config form. Everything is owned by `ctx.effect` / `ctx.slots.inject`,
       * so unloading the plugin removes both.
       * @param {any} ctx browser plugin context
       */
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tray-follower: dictionaries')
        const form = ctx.configForms.get(ENTRY_ID)
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: 'tray-follower',
              order: ORDER,
              label: () => t('nav'),
              locale: NS,
              inject: () => ({ form }),
            },
            SettingsPage,
          ),
        )
      },
    }
  },
})
