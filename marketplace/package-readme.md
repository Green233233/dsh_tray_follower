# dsh-tray-follower

Track every DeepSeek Harness (DSH) conversation from the **Windows system tray**
and get **native DSH notifications** when a conversation needs you — grouped by
workspace, without leaving the app in the foreground.

`dsh-tray-follower` is a single npm package that contains both halves of the
integration:

| Half | Where it runs | What it does |
| --- | --- | --- |
| **Host plugin** (`index.js`, `lib/`) | DSH Host process | Tracks conversations and publishes `%LOCALAPPDATA%\dsh-tray-follower\state.json` |
| **Client settings page** (`client.js`) | DSH Web GUI | Adds **Settings → Tray follower** with nine live options |
| **Desktop bridge** (`bridge/`) | DSH Desktop Electron main process | Extends the tray menu and raises native DSH notifications |

Notifications are created **inside DeepSeek Harness** (`new Notification(...)` in
the Electron main process), so Windows attributes them to the DSH application
itself. The plugin never starts an external PowerShell/WinRT/notify-send
notifier.

> **Status:** 0.2.3 — Windows 10/11, DSH Desktop 0.2.3-rc.1 or newer.

---

## Contents

- [What it does](#what-it-does)
- [Screenshots](#screenshots)
- [Requirements](#requirements)
- [Install](#install)
- [Enable the tray integration](#enable-the-tray-integration)
- [Settings reference](#settings-reference)
- [Notification semantics](#notification-semantics)
- [Privacy and security](#privacy-and-security)
- [Uninstall and rollback](#uninstall-and-rollback)
- [Troubleshooting](#troubleshooting)
- [Data and log files](#data-and-log-files)
- [中文说明](#中文说明)
- [License](#license)

---

## What it does

**Tray menu.** Right-clicking the DSH tray icon keeps the shell's original
*Open* / *Quit* items and adds a conversation section below them:

```
Open DeepSeek Harness
────────────────────────
Quit DeepSeek Harness
────────────────────────
Conversations: 1 running / 2 waiting      (disabled header)
📁 dsh_tray_follower  1 running · 1 waiting
   ⏸ Waiting for approval
   ▶ Configuring Git
   … 3 more conversations                 (only when over the row limit)
📁 default-workspace  0 running · 1 waiting
   ❓ Choose an option
dsh-tray-follower v0.2.3                  (footer, can be hidden)
```

- Conversations are grouped by workspace and ordered by urgency:
  waiting for approval / choice / input → running → completed / failed.
- **Idle conversations are hidden by default** (enable *Show idle
  conversations* to bring back the `Idle sessions (N)` submenu).
- Clicking a conversation row shows and focuses the DSH window.
- The header counts, the number of inline rows per workspace and the version
  footer are configurable (see [Settings](#settings-reference)).

**Native notifications.** While the DSH window is hidden, minimized or
unfocused, the bridge notifies you when a conversation:

- **needs attention** — an approval or a question is still pending after ~1.2 s;
- **completed** — the turn or goal finished;
- **failed** — the turn ended with an error, max-tokens or a blocked goal.

Clicking a notification restores and focuses the DSH window. Notifications are
deduplicated, rate-limited, never replayed on restart, and silenced while the
window is focused (configurable). A conversation that is following a goal does
not notify between rounds — only when the goal itself completes or blocks.

**Settings page.** **Settings → Tray follower** (设置 → 托盘随航) with two groups
(tray menu, notifications). Every change applies live — no DSH restart.

## Screenshots

<!--
  TODO(release): add the three captures below before publishing the listing.
  Suggested files: docs/assets/tray-menu.png, docs/assets/settings-page.png,
  docs/assets/notification.png (keep each < 500 KB and redact conversation titles).
-->

_Screenshots are added with the marketplace listing:_

1. `tray-menu` — the tray menu with two workspaces, one waiting and one running
   conversation.
2. `settings-page` — **Settings → Tray follower** with the two option groups.
3. `notification` — a native DeepSeek Harness notification for a waiting
   conversation.

## Requirements

- **Windows 10 or 11** — the tray bridge is Windows-specific (the Host plugin
  itself publishes state on every platform, but the tray menu and notifications
  depend on the Windows shell and Electron tray).
- **DSH Desktop 0.2.3-rc.1 or newer** — the settings page uses the
  `settings.section` slot and `ctx.configForms`, both available in that build.
- **Node.js 20+** — only to run the one-time bridge installer. The launcher
  prefers the Node runtime bundled with DSH, so a system Node.js is optional.
- No administrator rights, no global environment variables, and no changes to
  the DSH installation directory are needed.

## Install

> This repository is the source of truth: <https://github.com/Green233233/dsh_tray_follower>. The package is installable straight from a GitHub release tarball, no npm registry account needed.

### From the GitHub release (recommended)

1. Open **Settings → Plugins** (插件) in DSH Desktop and use **Add plugin** with the tarball URL:

```powershell
dsh plugin --profile desktop add https://github.com/Green233233/dsh_tray_follower/releases/download/v0.2.3/dsh-tray-follower-0.2.3.tgz
```

2. Enable the plugin row if it is installed disabled.

### From the repository source

```powershell
dsh plugin --profile desktop add github:Green233233/dsh_tray_follower#path:/packages/dsh-tray-follower
```

### From npm (after the package is published there)

1. Open **Settings → Plugins** (插件) in DSH Desktop.
2. Search for `dsh-tray-follower` and click **Install**.
3. Enable the plugin row if it is installed disabled.

Equivalent CLI, when `dsh` is on `PATH`:

```powershell
dsh plugin --profile desktop add dsh-tray-follower
```

After installation the Host plugin immediately starts publishing
`state.json`. The settings page appears at **Settings → Tray follower**.

## Enable the tray integration

The plugin alone already **tracks conversations and publishes state**, but the
tray menu extension and OS notifications require a **one-time bridge
installation**. The bridge runs inside the DSH Desktop Electron main process and
must be injected when DSH starts.

### Option A — full integration (recommended): install the bridge

The npm package ships its own installer. From the DSH profile directory
(`%USERPROFILE%\.dsh\profiles\desktop` by default, or `%DSH_HOME%\profiles\desktop`):

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"

# Dry run: print the plan, change nothing.
node node_modules\dsh-tray-follower\scripts\install-bridge.mjs

# Install: copy the bridge payload and point the DSH shortcuts at the hidden launcher.
node node_modules\dsh-tray-follower\scripts\install-bridge.mjs --apply
```

If the package manager linked the bin shim, this is equivalent:

```powershell
node_modules\.bin\dsh-tray-follower-bridge.cmd --apply
```

Then **fully quit DeepSeek Harness** (tray icon → Quit) and start it again from
its usual **DeepSeek Harness shortcut**. The shortcut now runs a hidden
launcher that starts DSH with a loopback-only Node inspector, injects the
bridge, and closes the inspector. Expected result: the tray menu gains the
conversation section and notifications start arriving.

Useful installer flags:

| Flag | Meaning |
| --- | --- |
| `--apply` | Execute (default is a dry run) |
| `--data-dir <path>` | Bridge data directory (default `%LOCALAPPDATA%\dsh-tray-follower`) |
| `--exe <path>` | DSH executable, if it is installed outside `%LOCALAPPDATA%\Programs\DeepSeek Harness` |
| `--no-shortcuts` | Copy the payload only; do not touch shortcuts |

The installer is user-level and fully reversible: every replaced `.lnk` is
backed up byte-for-byte under `%LOCALAPPDATA%\dsh-tray-follower\backup\shortcuts`
before it is changed.

### Option B — plugin only: no tray extension, no notifications

If you skip the bridge, DSH behaves exactly as before: no tray section, no OS
notifications. The Host plugin still publishes `state.json` and the settings
page still works, which is useful for debugging or for setups where the tray
menu is not needed.

> There is deliberately **no notifications-only mode**: notifications are
> in-process Electron notifications created by the bridge. The plugin does not
> spawn an external notifier (no PowerShell/WinRT/notify-send), so without the
> bridge there is no notification path.

### How injection works (and why it needs a restart)

Packaged Electron builds reject `NODE_OPTIONS=--require` preloads, so the bridge
is injected through a **loopback-only Node inspector**:

```
DeepSeek Harness shortcut
  └─ wscript.exe  <data>\app\launcher\launch-bridge.vbs
      └─ powershell.exe -WindowStyle Hidden -File launch-bridge.ps1
          └─ node <data>\app\injector\launch.mjs
              ├─ already running?  -> focus existing window, explain restart needed
              ├─ start DeepSeek Harness.exe --inspect=127.0.0.1:<free port>
              ├─ attach over CDP, evaluate the hook in the Electron main process
              ├─ adopt the Tray instance from the V8 heap
              └─ close the inspector and exit; DSH keeps running with the bridge
```

Because the inspector must exist at process start, **a DSH instance that is
already running cannot be patched** — quit DSH completely and launch it from the
shortcut. If injection fails, the launcher kills only the paused instance and
relaunches DSH normally, so you always get the application.

A DSH update may recreate the Start Menu shortcut; re-run
`install-bridge.mjs --apply` after an update.

## Settings reference

**Settings → Tray follower** (设置 → 托盘随航). All options are stored in the
DSH plugin configuration and published in `state.json` as
`options.tray.*` / `options.notifications.*`, so the bridge reacts within about a
second — **no DSH restart**.

| # | Field | Group | Type / default | Effect |
| --- | --- | --- | --- | --- |
| 1 | `showIdle` | Tray menu | boolean · `false` | Also list idle conversations in the tray menu (`Idle sessions (N)` submenu) |
| 2 | `maxSessionsPerWorkspace` | Tray menu | number 1–20 · `6` | Inline rows per workspace before the `… N more conversations` overflow row |
| 3 | `showHeaderCounts` | Tray menu | boolean · `true` | Show `N running / M waiting` in the tray header |
| 4 | `showFooter` | Tray menu | boolean · `true` | Show the `dsh-tray-follower vX.Y.Z` footer |
| 5 | `notifyOnCompleted` | Notifications | boolean · `true` | Notify when a conversation completes |
| 6 | `notifyOnFailed` | Notifications | boolean · `true` | Notify when a conversation fails |
| 7 | `notifyOnAttention` | Notifications | boolean · `true` | Notify when an approval / question needs you |
| 8 | `suppressWhenFocused` | Notifications | boolean · `true` | Do not notify while the DSH window is focused |
| 9 | `notificationSound` | Notifications | boolean · `true` | Play the system notification sound |

Environment overrides (advanced, both halves must see the same values):

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_TRAY_FOLLOWER_DIR` | `%LOCALAPPDATA%\dsh-tray-follower` | Data directory (state, logs, cursor, backups) |
| `DSH_TRAY_FOLLOWER_LANG` | system locale → `en` | Language for tray/notification text (`en`, `zh`) |

## Notification semantics

- **Sources:** `completed`, `failed`, `needs-attention` unread events published
  by the Host plugin. Each event has a deterministic id
  (`evt_` + SHA-1 of the logical occurrence), so reloaded plugins and re-delivered
  Host events cannot duplicate a notification.
- **Suppression:** no notification while the DSH window is focused (unless
  `suppressWhenFocused` is off); hidden, minimized and unfocused windows notify.
- **Filters:** each event kind can be switched off independently
  (`notifyOnCompleted` / `notifyOnFailed` / `notifyOnAttention`).
- **Sound:** controlled by `notificationSound` (mapped to Electron's `silent`
  flag).
- **Deduplication:** a persisted cursor (`cursor.json`, capped at 500 ids) means
  each event notifies at most once, across restarts.
- **Replay guard:** events older than 10 minutes are marked seen and never
  notified; on first run (or after deleting the cursor) currently present events
  are baselined silently, so installing the bridge cannot produce a toast storm.
- **Rate limit and coalescing:** bursts observed in one poll are summarized as
  `N conversations need attention`; at most one notification per 2 seconds.
- **Click behavior:** clicking a notification restores, shows and focuses the
  DSH window.
- **Timing:** an approval or question answered within ~1.2 seconds never
  notifies; a conversation following a goal stays quiet between rounds and
  notifies only when the goal completes or blocks.

## Privacy and security

- **Local only.** No network requests, no telemetry, no cloud service. The only
  socket involved is the Node inspector on `127.0.0.1` used once at launch.
- **Inspector is loopback-only and short-lived.** DSH starts with
  `--inspect=127.0.0.1:<free port>`; the bridge closes the inspector immediately
  after injection (logged as `inspector-closed`). Do not enable
  `DSH_TRAY_FOLLOWER_KEEP_INSPECTOR` in production.
- **Session metadata is read locally:** conversation titles, workspace
  names/paths, statuses, the current goal (when the `goals` service is mounted)
  and the Web GUI origin. It is written to
  `%LOCALAPPDATA%\dsh-tray-follower\state.json` for the bridge to read; the two
  halves never talk over IPC or network.
- **No DSH installation files are modified.** The bridge lives entirely under
  `%LOCALAPPDATA%\dsh-tray-follower\`; injection uses the official inspector
  channel. No global environment variables are written.
- **Reversible.** Shortcut replacements are backed up byte-for-byte and restored
  by the uninstaller.
- **Deletion.** `state.json`, logs, the notification cursor and shortcut backups
  live in one directory; remove it with the uninstaller's `--purge` flag or by
  deleting the directory after uninstalling.

## Uninstall and rollback

1. **Remove the bridge** (restores every shortcut byte-for-byte and removes the
   payload):

   ```powershell
   cd "$env:USERPROFILE\.dsh\profiles\desktop"
   node node_modules\dsh-tray-follower\scripts\uninstall-bridge.mjs          # dry run
   node node_modules\dsh-tray-follower\scripts\uninstall-bridge.mjs --apply  # restore
   # add --purge to also delete state.json, logs, cursor and shortcut backups
   ```

2. **Fully quit DSH** and start it again from the (restored) shortcut — it now
   runs in stock mode.
3. **Uninstall the plugin** from **Settings → Plugins** (or
   `dsh plugin --profile desktop remove dsh-tray-follower` when the CLI is on
   `PATH`).
4. Optional: delete `%LOCALAPPDATA%\dsh-tray-follower` to remove all remaining
   data.

**Rollback a version**: the DSH Plugins page can install a specific npm version
(`dsh plugin --profile desktop add dsh-tray-follower@0.1.x`) after removing
0.2.0. A downgrade leaves the bridge payload in place; the 0.2.0 bridge is
backward compatible with 0.1 state files, and the 0.1 plugin simply writes
`schemaVersion: 1` again.

## Troubleshooting

| Symptom | Check / fix |
| --- | --- |
| No `state.json` | Is the plugin enabled on the **Plugins** page? Look for `[dsh-tray-follower]` warnings in the DSH Host log. Default path: `%LOCALAPPDATA%\dsh-tray-follower\state.json`. |
| Settings page missing | DSH Desktop older than 0.2.3-rc.1, or the plugin is disabled. Update DSH and re-enable the plugin. |
| Plugin works, tray menu unchanged | The bridge was not injected. Start DSH from its shortcut (not `DeepSeek Harness.exe` directly), and make sure DSH was **fully quit** before launching. Check `injector.log` for `BRIDGE_OK` / `ALREADY_RUNNING`. Re-run `install-bridge.mjs --apply` if the installer was never run or a DSH update recreated the shortcut. |
| `injector.log` says the inspector never appeared | Port blocked/occupied by another Node inspector, the wrong executable, or antivirus interference. Retry; pass `--exe <path>` if DSH is installed elsewhere. |
| Bridge injected but no tray section | `bridge.log` should contain `tray-patched` and `menu-rebuilt`. `patched: false` means the tray was created too late (DSH quit early) or the platform is not Windows. |
| No notifications | The window may be focused (`notification-suppressed` in `bridge.log`), the event kind may be disabled in settings, or Windows **Focus Assist / Do Not Disturb** may block toasts. Check the DeepSeek Harness notification permission in Windows Settings. |
| Duplicate or replayed notifications | Delete `%LOCALAPPDATA%\dsh-tray-follower\cursor.json`. The next launch baselines silently; stale (older than 10 min) events are ignored. |
| DSH does not start after installing the bridge | The launcher shows a message box with the log tail. Run `uninstall-bridge.mjs --apply` to restore the original shortcuts, then start DSH normally. |
| Tray rows show the working-directory name instead of the conversation title | The optional `sessionTitle` service is not mounted in your DSH build; the plugin falls back to the folder name. |

## Data and log files

Everything is under `%LOCALAPPDATA%\dsh-tray-follower\` (override:
`DSH_TRAY_FOLLOWER_DIR`):

| Path | Written by | Purpose |
| --- | --- | --- |
| `state.json` | Host plugin | Conversation state and options (contract v2) |
| `bridge.json` | Bridge | Heartbeat, every 5 s |
| `bridge.log` (+ `.1`) | Bridge | Hook runtime log (rotated at 1 MiB) |
| `injector.log` (+ `.1`) | Injector | Launch/injection log (rotated at 512 KiB) |
| `cursor.json` | Bridge | Notification dedupe cursor |
| `app\` | Installer | Installed bridge payload (`shell-hook`, `injector`, `launcher`, `install.json`) |
| `backup\shortcuts\` | Installer | Byte-for-byte shortcut backups |

---

## 中文说明

在 **Windows 系统托盘**里查看每个工作区的 DSH 对话状态，并在 DSH 最小化或失焦时，由
**DeepSeek Harness 应用本身**弹出系统通知（Electron 主进程 `Notification`，显示为
DeepSeek Harness），不使用任何外部 PowerShell/WinRT 通知进程。

**功能**

- 托盘右键菜单保留原「打开 / 退出」，新增按工作区分组的对话列表：等待人工介入
  （批准 / 选择 / 输入）→ 运行中 → 已完成 / 失败；点击会话行可聚焦 DSH 窗口。
- **空闲对话默认不显示**，可在设置里打开；每个工作区内联行数、顶部计数、版本页脚均可配置。
- 通知：需要人工介入 / 完成 / 失败；窗口聚焦时不打扰、去重、限流、不回顾旧事件、点击通知回到 DSH。
- **设置 → 托盘随航**（9 项，保存后约 1 秒生效，无需重启）。

**安装**

1. 在 DSH 的 **插件** 页面搜索 `dsh-tray-follower` 安装（或
   `dsh plugin --profile desktop add dsh-tray-follower`）。
2. 托盘菜单与通知还需要一次性安装桌面桥接（用户级、可逆转）：

   ```powershell
   cd "$env:USERPROFILE\.dsh\profiles\desktop"
   node node_modules\dsh-tray-follower\scripts\install-bridge.mjs          # 预览
   node node_modules\dsh-tray-follower\scripts\install-bridge.mjs --apply  # 安装
   ```

3. **完全退出 DSH**（托盘图标 → 退出），再从原来的 DeepSeek Harness 快捷方式启动。

只装插件、不装桥接时，托盘菜单与系统通知都不会出现（这是刻意设计：通知必须由 DSH
自身进程发出）。桥接卸载：`node node_modules\dsh-tray-follower\scripts\uninstall-bridge.mjs --apply`
（加 `--purge` 可同时删除状态与日志）。

**隐私**：全部本地运行，不联网、无遥测；只把对话标题、工作区名/路径、状态等写入
`%LOCALAPPDATA%\dsh-tray-follower\state.json` 供桥接读取；注入使用仅回环
`127.0.0.1` 的 Node Inspector，注入完成后立即关闭；不修改 DSH 安装目录，不写全局环境变量。

**常见问题**：托盘菜单没变化 → 确认是「完全退出 DSH 后从快捷方式启动」；无通知 → 检查窗口
是否聚焦、设置里的通知开关、Windows 勿扰模式；重复通知 → 删除 `cursor.json`。日志在
`bridge.log` / `injector.log`。

## License

[MIT](LICENSE) © 2026 dsh-tray-follower contributors.

Not affiliated with DeepSeek. DeepSeek Harness is a product of its respective
owners.
