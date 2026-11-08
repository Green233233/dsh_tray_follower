# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-11-08

### Added

- **About page in DSH Settings** (`设置 → 关于` / *Settings → About*, section id
  `tray-follower-about`): author information, repository link, license and the
  acknowledgement line for @DuoZhao2026.
- **Tray row deep link**: clicking a conversation row now opens that conversation
  inside DSH instead of only focusing the window (bridge dispatches
  `dsh-tray-follower:open-session`; the Client half calls
  `uiWorkspace.openSession`).
- Native `Switch` component from `@deepseek-ai/dsh-client-ui-primitives` on the
  settings page, matching the rest of the application.

### Changed

- Chinese display name is now **托盘随航** (English: *Tray follower*; renamed from
  托盘跟随).
- Version and bridge payload are 0.2.2.

### Fixed

- Idle conversations are no longer truncated: the idle list is sorted
  newest-first and lists every idle conversation (hard cap 100 instead of 10).

## [0.2.0] - 2026-11-08

Marketplace release: one publishable npm package containing the Host plugin, the
Web-UI settings page and the optional Desktop tray bridge.

### Added

- **Settings page in DSH Settings** (`设置 → 托盘跟随` / *Settings → Tray
  follower*): nine live options for the tray menu and notifications. Changes are
  applied within about one second — no DSH restart.
- **Config schema** (`@deepseek-ai/schemastery`, all fields volatile) on the Host
  half; the live values are published in the state contract as `options`.
- **State contract v2**: a top-level `options` object with
  `tray` and `notifications` groups (`schemaVersion: 2`). The bridge accepts v1
  files and falls back to the documented defaults.
- **Notification settings**: per-event filters (`completed` / `failed` /
  `needs-attention`), foreground suppression toggle and notification sound
  toggle, all enforced by the bridge.
- **Tray menu settings**: per-workspace inline row limit (1–20), header counts
  and version footer toggles.
- **Marketplace packaging**: `LICENSE`, this changelog, a user-facing README,
  catalog entry templates, a deterministic build script
  (`scripts/build-market-package.mjs`) and the packaged bridge installers
  (`scripts/install-bridge.mjs`, `scripts/uninstall-bridge.mjs`).

### Changed

- **Idle conversations are hidden from the tray menu by default**
  (`showIdle: false`). Enable *托盘右键菜单 → 显示空闲会话* to restore the old
  `空闲会话 (N)` submenu behavior.
- The tray bridge reads `options` from `state.json` and rebuilds the menu and
  notification decisions from the live settings.
- The single npm package now ships the bridge payload (`bridge/shell-hook`,
  `bridge/injector`, `bridge/launcher`) so `dsh plugin add dsh-tray-follower`
  installs everything needed for the optional tray integration.

### Fixed

- Bridge installer resolution when run from an installed npm package: the
  packaged scripts resolve the payload relative to the package root instead of
  assuming a repository checkout.

## [0.1.0] - 2026-10-25

Initial release.

### Added

- DSH Host plugin (bundle) that tracks every top-level conversation grouped by
  workspace and publishes the state contract to
  `%LOCALAPPDATA%\dsh-tray-follower\state.json` (atomic writes, ≤250 ms
  debounce, localized `en`/`zh`).
- Status derivation: `running`, `waiting-approval`, `waiting-choice`,
  `waiting-input`, `completed`, `failed`, `idle`; deterministic unread event
  ids for `completed` / `failed` / `needs-attention`.
- DSH Desktop Electron-main bridge: tray menu extension grouped by workspace
  and native in-process `Notification` messages attributed to DeepSeek Harness
  (no external PowerShell/WinRT notifier), notification dedupe, replay guard,
  rate limit, and a persisted notification cursor.
- Node-inspector based injection (`--inspect=127.0.0.1:<port>`, loopback only,
  inspector closed after injection) and a hidden VBS/PowerShell launcher wired
  into the existing DeepSeek Harness shortcuts with byte-level backups.
- User-level, reversible bridge installer/uninstaller
  (`tools/install-bridge.mjs`, `tools/uninstall-bridge.mjs`) and an isolated
  end-to-end probe (`tools/probe-electron-hook.mjs`) that never touches the
  running DSH instance.
- Unit tests for the plugin (`node --test`) and the bridge
  (`tools/bridge-selftest.mjs`).
