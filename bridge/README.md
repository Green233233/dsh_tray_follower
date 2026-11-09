# dsh-tray-follower — DSH Desktop shell bridge (v0.2.3)

This is the **optional native desktop half** of `dsh-tray-follower`. It runs inside
the DSH Desktop Electron **main process**, extends the Windows system-tray menu
with per-workspace conversation status, and raises native Electron notifications
when a conversation needs attention while DSH is hidden/unfocused.

Since **v0.2.0** the bridge is settings-driven through the state contract v2
(`options` block published by the host plugin): idle conversations are hidden from
the tray menu by default, and row counts / header counts / footer as well as the
notification kind filters, focus suppression and sound are controlled by the DSH
settings page. Older v1 state files keep working with exactly these defaults.
**v0.2.2** adds tray-row deep links (clicking a conversation opens it in DSH via
the `dsh-tray-follower:open-session` renderer event) and lists the complete idle
history (newest first).

The other half is the DSH plugin bundle in `packages/dsh-tray-follower/`, which
tracks conversations and publishes `%LOCALAPPDATA%\dsh-tray-follower\state.json`
(contract: `docs/DESIGN.md` §4). The bridge only reads that state file — the two
halves never talk over IPC.

> **Updated architecture (2026-11-08):** the original `NODE_OPTIONS=--require`
> plan is dead. Packaged Electron 44 rejects preload injection:
> `ERROR:electron\shell\common\node_bindings.cc Most NODE_OPTIONs are not supported
> in packaged apps.` The bridge is now injected through the **Node inspector**:
> DSH is launched with `--inspect=127.0.0.1:<port>`, a small Node injector attaches
> over CDP, evaluates the hook inside the Electron main process, adopts the Tray
> instance from the V8 heap, then closes the inspector and exits. See
> `docs/recon/NOTES.md` for the evidence trail.

---

## 1. What gets installed (all user-level, reversible)

`tools/install-bridge.mjs --apply` installs:

| Path | Purpose |
| --- | --- |
| `%LOCALAPPDATA%\dsh-tray-follower\app\shell-hook\` | `hook.cjs` + `lib/*.cjs` (menu/notifications/heartbeat/state) |
| `%LOCALAPPDATA%\dsh-tray-follower\app\injector\` | Node inspector injector + launcher logic (`launch.mjs`, `inject.mjs`, `lib/*.mjs`) |
| `%LOCALAPPDATA%\dsh-tray-follower\app\launcher\` | hidden `launch-bridge.vbs` + `launch-bridge.ps1` (and dev `launch-once.ps1`) |
| `%LOCALAPPDATA%\dsh-tray-follower\app\install.json` | install manifest (payload list, shortcut backups, DSH exe path) |
| `%LOCALAPPDATA%\dsh-tray-follower\backup\shortcuts\` | byte-for-byte backups of every replaced `.lnk` |
| `state.json` | written by the DSH plugin half (not by the bridge) |
| `bridge.json` | bridge heartbeat `{pid, ts, version}` every 5 s (plugin fallback detection) |
| `bridge.log` | bridge log, rotated at 1 MiB (`bridge.log.1`) |
| `cursor.json` | notification dedupe cursor (seen event ids + last notify time) |
| `injector.log` | launcher/injector log (rotated at 512 KiB) |
| `extensions\` | user-owned Electron-main extension hooks (see §3 “Extension hooks”; not created by the installer) |

The installer rewrites the **DeepSeek Harness shortcuts** (Start Menu, Desktop,
Public Desktop, pinned taskbar — only shortcuts whose target is
`DeepSeek Harness.exe`) so they start the hidden launcher instead. Every original
`.lnk` is copied to the backup directory first; `tools/uninstall-bridge.mjs
--apply` restores it byte-for-byte.

It **never** modifies the DSH install directory, never writes global environment
variables, and never edits the DSH profile.

Runtime data dir override: `DSH_TRAY_FOLLOWER_DIR`.

---

## 2. Install / uninstall

Prerequisites: Windows 10/11, Node.js ≥ 20 (DSH's bundled Node at
`resources\runtime\primary-runtime\dependencies\node\bin\node.exe` is used
preferentially by the launcher, so a system Node is optional).

```powershell
# from the repository root
node tools/install-bridge.mjs            # dry run: prints what would change
node tools/install-bridge.mjs --apply    # perform the installation

# completely quit DSH (tray icon -> Quit), then start DSH from its
# DeepSeek Harness shortcut again (the shortcut now starts the hidden launcher)
```

Uninstall:

```powershell
node tools/uninstall-bridge.mjs          # dry run
node tools/uninstall-bridge.mjs --apply  # restore shortcuts, remove payload
node tools/uninstall-bridge.mjs --apply --purge   # also delete logs/state/cursor
```

After install/uninstall, quit DSH completely before the next launch (the bridge
can only be injected at DSH **startup**; a running instance cannot be patched).

### Manual / development usage (no shortcut changes)

```powershell
# launch once from the repo (never touches shortcuts or env vars)
powershell -ExecutionPolicy Bypass -File bridge\launcher\launch-once.ps1

# or attach manually to a DSH you started with the inspector yourself:
#   "…\DeepSeek Harness.exe" --inspect=127.0.0.1:9531
node bridge/injector/inject.mjs --port 9531
```

### Launch flow

```
DeepSeek Harness shortcut
  └─ wscript.exe  bridge\launcher\launch-bridge.vbs  "%LOCALAPPDATA%\dsh-tray-follower"
      └─ powershell.exe -WindowStyle Hidden -File launch-bridge.ps1
          └─ node app\injector\launch.mjs
              ├─ already running? -> focus existing DSH, explain restart needed (exit 4)
              ├─ spawn DeepSeek Harness.exe --inspect=127.0.0.1:<free port>
              ├─ poll http://127.0.0.1:<port>/json/list, connect CDP websocket
              ├─ wait until process.mainModule.require is available (Electron main)
              ├─ evaluate the hook source (CJS module shim + hookDir-aware require)
              ├─ adopt Tray objects via Runtime.queryObjects(Tray.prototype)
              ├─ hook.finalize() -> inspector.close() (port closed, app keeps running)
              └─ exit; DSH keeps running with the bridge active
```

If injection fails, the launcher **kills only the paused child process tree** and
relaunches DSH normally (so the user still gets the app); the PowerShell launcher
shows a message box with the log tail. `--no-fallback` disables that relaunch.

---

## 3. What the bridge does at runtime

### Tray menu

`Tray.prototype.setContextMenu` is patched before the shell creates its tray, so
the shell's original `Open`/`Quit` items are captured and re-used (their click
handlers preserved). On every state change the bridge rebuilds:

```
<shell Open item>                        (captured, e.g. 打开应用)
──────────────
<shell Quit item>                        (captured, e.g. 退出应用)
──────────────
对话：1 运行 / 2 待处理                    (disabled header; settings: showHeaderCounts)
📁 dsh_tray_follower  运行 1 · 待处理 1    (submenu)
   ⏸ 等待批准的对话
   ▶ 配置 Git 等工程管理
   … 还有 3 个会话                         (disabled overflow, only if > maxSessionsPerWorkspace)
📁 default-workspace  运行 1 · 待处理 0
   …
dsh-tray-follower v0.2.2                 (disabled footer; settings: showFooter)
```

- **Idle conversations are hidden by default** (`options.tray.showIdle=false`,
  contract v2). Only when the user enables “also list idle conversations” in DSH
  settings do they appear, and then they are collapsed into one
  `空闲会话 (N)` / `Idle sessions (N)` submenu **listing the complete idle
  history, newest first** (`updatedAt` desc, then title). A work of up to 100 idle
  conversations is listed in full (only pathological counts beyond that hard cap
  get an overflow row). Idle sessions are never listed inline.
- Session order per workspace: `waiting-approval` / `waiting-choice` /
  `waiting-input` first, then `running`, then `completed` / `failed`.
- At most `options.tray.maxSessionsPerWorkspace` active rows (1..20, default 6)
  are rendered inline, followed by a disabled `… 还有 N 个会话` overflow row.
- `options.tray.showHeaderCounts=false` renders the global header as `对话` /
  `Conversations` (without counts); `options.tray.showFooter=false` removes the
  version footer.
- Rows use the status glyphs `▶ ⏸ ❓ ⌨ ✓ ✖ ○`. **Clicking any session row (active
  or idle) opens that conversation in DSH**: the bridge focuses/restores the
  window, then dispatches
  `window.dispatchEvent(new CustomEvent('dsh-tray-follower:open-session', { detail: "<sessionId>" }))`
  in the DSH renderer; the plugin's Client half listens for that event and calls
  its session-navigation API. Session ids are validated as
  `^[A-Za-z0-9._:-]{1,128}$` before being embedded (JSON-quoted) in the script.
  If the renderer event cannot be delivered the click still focuses the window
  (legacy behaviour), and a menu callback never throws.
- Chinese labels when Electron's locale starts with `zh`, English otherwise.
- Late injection (manual `inject.mjs` into an already-running DSH) is supported:
  the bridge adopts the existing Tray from the V8 heap and reconstructs equivalent
  localized `Open`/`Quit` items (focus window / `app.quit()`); the next shell
  `relabel()` upgrades them to the real captured items.

### Settings published by the host (contract v2)

`state.json` carries a top-level `options` object (schemaVersion `2`). The bridge
normalizes it defensively: missing files (v1) or invalid values fall back to these
defaults, and `maxSessionsPerWorkspace` is clamped to 1..20.

| Field | Default | Effect |
| --- | --- | --- |
| `options.tray.showIdle` | `false` | also list the complete idle history (collapsed submenu, newest first) |
| `options.tray.maxSessionsPerWorkspace` | `6` | max inline session rows per workspace |
| `options.tray.showHeaderCounts` | `true` | global header shows `对话：N 运行 / M 待处理` |
| `options.tray.showFooter` | `true` | show the `dsh-tray-follower vX.Y.Z` footer |
| `options.notifications.notifyOnCompleted` | `true` | notify for `completed` events |
| `options.notifications.notifyOnFailed` | `true` | notify for `failed` events |
| `options.notifications.notifyOnAttention` | `true` | notify for `needs-attention` events |
| `options.notifications.suppressWhenFocused` | `true` | stay silent while the DSH window is focused |
| `options.notifications.notificationSound` | `true` | sound on (`silent: !notificationSound`) |

Settings are read from every state poll (1 s), so a change in the DSH settings page
applies to the tray menu / notifications without restarting DSH. The bridge also
exposes the effective values in its diagnostics (`options` field) for tests and
troubleshooting.

### Native notifications

**Attribution (product requirement):** notifications are created by Electron's
main-process `new Notification({ title, body })` **inside DeepSeek Harness**, so
Windows attributes them to the DSH application (the app's own AUMID) — they are
sent "in DSH's name", not by an external program. The bridge deliberately has
**no PowerShell / WinRT / external-process notifier fallback**: if
`Notification.isSupported()` is false or the API is unavailable, the hook logs
`notification-unsupported` and continues (never spawns a notifier, never crashes
DSH). PowerShell in `bridge/injector/` is used only for process enumeration and
`.lnk` editing — never for notifications.

- Polls `state.json`'s `unreadEvents` every second.
- **Settings-driven filtering (contract v2):** only event kinds enabled by
  `notifyOnCompleted` / `notifyOnFailed` / `notifyOnAttention` are notified; a
  disabled kind is consumed silently (marked seen) so toggling it back on cannot
  replay old history.
- **Focus suppression:** with `suppressWhenFocused=true` (default) nothing is
  notified while the DSH window is focused; set it to `false` in the settings page
  to be notified even then. Hidden/minimized windows always notify
  (docs/DESIGN.md R2/R3).
- **Sound:** `notificationSound=true` (default) keeps the toast audible; `false`
  maps to `silent: !notificationSound` on the Electron notification.
- Dedupe by event id in `cursor.json` (capped at 500 ids).
- Bursts observed in one poll collapse into a summary
  (`N 个对话需要关注`), rate limited to one notification per 2 s.
- **Replay guard:** events older than 10 minutes are marked seen and never
  notified; a missing/corrupt cursor baselines all currently present events
  silently (a persisted 50-event backlog can never produce an install-time toast
  storm).
- Clicking a notification restores/shows/focuses the DSH window.
- Heartbeat `bridge.json` is written every 5 s; the plugin half uses its staleness
  (>15 s) to fall back to its own PowerShell WinRT toasts when the bridge is not
  running.

### Extension hooks (other local Electron-main helpers)

The injected bridge is also a small **extension host**: after it starts it loads
user-owned CommonJS hooks from the bridge data directory so companion projects —
e.g. [`dsh-topbar`](https://github.com/Green233233/dsh_topbar) — can add
main-process behaviour without duplicating the `--inspect` injector/launcher.

Scanned location (`dataDir` is `%LOCALAPPDATA%\dsh-tray-follower`, override with
`DSH_TRAY_FOLLOWER_DIR`):

```
%LOCALAPPDATA%\dsh-tray-follower\extensions\
  my-helper.cjs                 # loose CommonJS file (extension name = file name)
  dsh-topbar\                   # directory extension (installed by its own installer)
    manifest.json               # { "name": "dsh-topbar", "main": "hook.cjs" }
    hook.cjs
```

Contract (extension API version **1**):

```js
// module.exports.activate(context) is required; deactivate() is optional.
module.exports = {
  /**
   * @param {object} context
   * @param {object} context.api      Electron module (`require('electron')`, main process)
   * @param {object} context.app      context.api.app
   * @param {string} context.dataDir  %LOCALAPPDATA%\dsh-tray-follower
   * @param {(level: string, event: string, data?: object) => void} context.log
   *                                  writes `extension:<name>:<event>` to bridge.log, never throws
   * @param {() => number} context.now  clock used by the host
   */
  activate(context) {
    context.log('info', 'my-helper-activated', { pid: process.pid })
  },
  /** Called on app `before-quit` and on bridge stop, in reverse load order. */
  deactivate() {}
}
```

Directory manifests are optional in the sense that only a directory **with**
`manifest.json` is treated as an extension; `manifest.main` defaults to
`hook.cjs`, `manifest.name` defaults to the directory name, and `manifest.version`
is reported in diagnostics. Loose `<name>.cjs` files at the top level are loaded
directly. Entries are capped at 32 per start, names are deduplicated, and a
manifest `main` that escapes the extension directory is rejected.

Containment and lifecycle (all verified by `node tools/bridge-selftest.mjs`):

- `activate()` runs inside try/catch; a missing/throwing/rejected activation is
  recorded as an `extension-error` entry in `bridge.log` and never blocks the
  tray bridge or other extensions.
- `deactivate()` runs in reverse load order on `app` `before-quit` (before the
  bridge's own `will-quit` stop) and on `bridge.stop()`; errors are contained.
- `globalThis.__DSHTF.diagnostics()` (and the injector's diagnostics expression)
  now carries `extensions: { loaded: [names], errorCount, errors, scanned, ... }`.
- Extension `context.log(level, event, data)` lines appear in `bridge.log` as
  `extension:<name>:<event>` and in test-mode diagnostics as `extension-log`.

Trust model: an extension is arbitrary Node/Electron-main code running with the
user's full privileges inside DeepSeek Harness. The bridge only loads files that
already exist below `<dataDir>\extensions\` — it never downloads, auto-updates
or verifies signatures of extension code. Install only extensions you trust, and
prefer installing/removing them while DSH is fully quit (extensions are loaded
once at DSH startup).

### Failure containment

Everything is try/caught and logged; broken/missing/partial state files render a
`（等待插件数据…）` placeholder instead of throwing. A bridge problem must never
crash DSH; the plugin half still works without the bridge (fallback toasts).

### Test diagnostics

- `DSH_TRAY_FOLLOWER_TEST=1` — writes JSON-line diagnostics to `bridge.log`
  (`hook-loaded`, `tray-patched`, `state-loaded`, `tray-captured`, `tray-adopted`,
  `menu-rebuilt` with the final template, `notification-shown`, `self-test`,
  `test-exit`) and shows one self-test notification
  (`DSH_TRAY_FOLLOWER_TEST_SHOW_NOTIFICATION=0` disables the toast).
- `DSH_TRAY_FOLLOWER_TEST_EXIT_MS=<n>` — `app.exit(0)` after n ms (isolated runs
  exit by themselves).
- `DSH_TRAY_FOLLOWER_KEEP_INSPECTOR=1` — keep the inspector open (E2E probe).
- `DSH_TRAY_FOLLOWER_DIR=<path>` — alternative data directory.

---

## 4. Verification

### Unit tests (no GUI)

```powershell
node tools/bridge-selftest.mjs
```

75 tests cover state parsing/normalization (contract v1 **and** v2 options with
clamping/fallbacks), menu model (priority order, idle hidden by default /
optional idle submenu, settings-driven row limit, header counts / footer toggles,
overflow, zh/en labels, placeholders), notification policy (dedupe, baseline,
kind filters, `suppressWhenFocused`, `notificationSound`→`silent`, coalescing,
rate limit, stale-event replay guard), cursor persistence, tray patch
capture/adoption/no-recursion, window focus helpers, heartbeat contract, log
rotation, the full bridge core with a fake `electron` API (including v2 settings
end-to-end), the **extension host** (loose-file and manifest-directory fixtures,
`activate(context)` contract, broken-extension containment, `deactivate()` on
`before-quit`/stop), and the injector pure helpers (env sanitization, bootstrap
escaping, DSH process detection, shortcut classification).

### Isolated end-to-end probe (launches a *second* DSH instance)

This is safe for a running DSH: the probe starts the same exe with an isolated
`--user-data-dir` (separate Electron single-instance lock), an isolated
`DSH_HOME` (separate profile lock) and an isolated `DSH_TRAY_FOLLOWER_DIR`, with
`ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` removed from the child environment.

```powershell
# dry run: prints the exact plan, launches nothing
node tools/probe-electron-hook.mjs

# real E2E (requires explicit --execute; shows isolated DSH UI for a few seconds)
node tools/probe-electron-hook.mjs --execute
```

Expected evidence (printed as `PASS …` lines, exit code 0):

- `hook injected (patched=true, adoptedTrays≥1)`
- `tray adopted`
- `contract-v2 tray defaults applied (showIdle=false, maxSessionsPerWorkspace=6, showHeaderCounts=true, showFooter=true)`
- `menu rebuilt with header "对话：1 运行 / 1 待处理"` and the fixture's
  workspace/session rows (`📁 探针工作区 A  运行 1 · 待处理 1`,
  `⏸ 等待批准的对话`, `▶ 运行中的对话`, `✓ 已完成的对话`,
  `📁 Probe Workspace B  运行 0 · 待处理 0`, `（无对话）`; the fixture includes
  idle sessions in both workspaces and they must NOT appear)
- `idle conversations hidden by default (no idle rows, no 空闲会话 submenu)`
- `original menu items present: …` (shell-captured Open/Quit, or the localized
  reconstructed items when adoption happened first)
- `notification API is in-process Electron Notification (provider=electron-main-process, isSupported=true) — attributed to DeepSeek Harness, no external notifier process`
- `native notification evidenced (test): DSH 托盘随航（自检）`
- `PROBE RESULT: PASS`

Cleanup: the probe quits the isolated instance through its own API
(`app.exit(0)`), kills the process tree of exactly the spawned PID if needed,
removes leftover Host children matched by the run's unique temp token, and deletes
the temp dirs (unless `--keep`). It never kills or restarts the already-running
DSH instance.

### Manual verification in the real app

1. Install, fully quit DSH, relaunch from the DeepSeek Harness shortcut.
2. Watch `%LOCALAPPDATA%\dsh-tray-follower\injector.log` for `BRIDGE_OK`.
3. Right-click the tray icon: `对话：N 运行 / M 待处理` + workspace submenus
   (idle conversations are hidden by default until enabled in DSH settings).
4. Hide/minimize DSH, trigger an approval request in a conversation: a native DSH
   notification appears; clicking it focuses DSH.
5. Change settings in DSH (e.g. “also list idle conversations”, disable a
   notification kind): the tray menu / notifications update within ~1 s without a
   DSH restart.
6. `node tools/uninstall-bridge.mjs --apply`, relaunch: the tray menu is back to
   the shell's original `Open`/`Quit`.

---

## 5. Risks and limitations

- **Inspector port.** DSH is launched with `--inspect=127.0.0.1:<port>` (loopback
  only). The hook closes the inspector via `node:inspector.close()` right after
  injection (verified working: the port closes while the app keeps running). If
  that ever fails, the port stays loopback-only and is logged as
  `inspector-close error`; `DSH_TRAY_FOLLOWER_KEEP_INSPECTOR` deliberately keeps it
  open for debugging. Any local process could attach while it is open — do not set
  `--keep-inspector` in production.
- **Injection only at startup.** A DSH instance already running without
  `--inspect` cannot be patched; the launcher detects this and explains that DSH
  must be fully quit first. Opening DeepSeek Harness directly (not via the
  rewritten shortcut) runs without the bridge; the plugin half's PowerShell toast
  fallback still applies after the heartbeat goes stale.
- **Shortcut replacement.** The installer changes user shortcuts, not DSH files.
  A DSH update may recreate the Start-Menu shortcut, so re-run
  `node tools/install-bridge.mjs --apply` after a DSH update. Uninstall restores
  the byte-saved originals.
- **Antivirus/EDR.** Hidden PowerShell + `--inspect` + `Node inspector` patterns
  may attract heuristics on locked-down machines. Everything is user-level and
  reversible; no binaries are downloaded.
- **Notification policy (v1).** Notifications are suppressed only when the main
  window is *focused*; a visible-but-unfocused DSH window still notifies (matches
  the "hidden OR not focused" requirement). Windows Focus Assist / notification
  settings can suppress toasts; check `bridge.log` for `notification-shown`.
  Notifications are always in-process Electron notifications attributed to
  DeepSeek Harness — the bridge never delegates to a PowerShell/WinRT sender.
  (The plugin half's documented PowerShell WinRT fallback is a *separate*
  degradation path that should stay disabled/removed per the same product
  requirement; when the bridge is alive its `bridge.json` heartbeat keeps that
  fallback off.)
- **Menu rebuild frequency.** State is polled once per second and the menu is only
  rebuilt when the rendered signature changes (plus whenever the shell
  relabels/rebuilds its own menu); toast/menu flicker is therefore avoided.
- **No conversation deep-link.** Clicking a session row only focuses the DSH
  window (v1). `dsh://open` / per-session routing is a possible follow-up.

---

## 6. Troubleshooting

| Symptom | Check / fix |
| --- | --- |
| No bridge log after launch | Shortcut not rewritten: `node tools/install-bridge.mjs --apply`, check `%LOCALAPPDATA%\dsh-tray-follower\app\install.json`. Or DSH was already running (launcher prints `ALREADY_RUNNING` / popup) — fully quit DSH first. |
| `injector.log` has `inspector endpoint … never appeared` | Port blocked/occupied or exe not the packaged app. Check the DSH exe path; try `--port` / remove other Node inspector on that port. |
| `hook injected` but no tray menu | Open `bridge.log`: `tray-patch` says `patched:false` (non-Windows or early quit) or `tray-adoption-timeout`. The tray is created after `app.whenReady`; if DSH quits immediately there is no menu to extend. |
| Menu missing the status section | Is DSH started from the rewritten shortcut? Direct launches have no bridge. Also check `state.json` exists and is valid (`（等待插件数据…）` means the plugin half has not written it yet). |
| No notifications | Confirm the window was hidden/unfocused (focused windows are intentionally silent) and that `bridge.log` shows `notification-shown`. Windows Focus Assist / "Do not disturb" can hide toasts. |
| Notifications duplicated / replayed | Delete `%LOCALAPPDATA%\dsh-tray-follower\cursor.json`; the next event baselines silently and stale (>10 min) events are ignored. |
| DSH won't start after install | Shortcut target broken: the VBS/PS1 launcher show a message box; uninstall (`--apply`) restores the original shortcut, then launch DSH normally. |
| Bridge active but plugin fallback toasts also appear | The plugin sees `bridge.json` heartbeat; if both appear, check that the heartbeat timestamp keeps updating (bridge polling/timers broken — inspect `bridge.log`). Note: the plugin's PowerShell WinRT fallback is not part of the bridge; per the product requirement notifications must come from DSH itself, so keep the bridge healthy (or have the plugin fallback disabled). |
| Everything broken | `node tools/uninstall-bridge.mjs --apply` (add `--purge` to delete all bridge data). No DSH files were modified, so uninstalling always restores the stock behavior. |

Useful files:

- `%LOCALAPPDATA%\dsh-tray-follower\bridge.log` (+ `.1`) — hook runtime log.
- `%LOCALAPPDATA%\dsh-tray-follower\injector.log` (+ `.1`) — launcher/injector log.
- `%LOCALAPPDATA%\dsh-tray-follower\state.json` — plugin-written contract input.
- `%LOCALAPPDATA%\dsh-tray-follower\bridge.json` — heartbeat.
- `%LOCALAPPDATA%\dsh-tray-follower\cursor.json` — notification cursor.
- `%LOCALAPPDATA%\dsh-tray-follower\backup\shortcuts\` — original shortcut backups.
