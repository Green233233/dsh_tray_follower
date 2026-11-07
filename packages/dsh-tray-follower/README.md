# dsh-tray-follower (Host half)

A dependency-free DSH **bundle** that tracks every top-level conversation of the
running DeepSeek Harness Host, grouped by workspace, and publishes their status
to a state file. The DSH Desktop **shell bridge** (see `bridge/shell-hook/` in
the repository) reads that file to build the tray icon's right-click menu and to
raise native notifications while the window is hidden or unfocused.

The plugin also has a degraded fallback channel: when the bridge heartbeat is
missing or stale it raises Windows toasts itself through PowerShell/WinRT.

- Package name / row: `dsh-tray-follower`
- Host-only bundle (`index.js` exports `name`, `inject`, `apply`); no Client
  half, no runtime dependencies, no `@deepseek-ai/*` imports.
- State contract: [docs/DESIGN.md §4](../../docs/DESIGN.md) — implemented exactly.

## What it publishes

`%LOCALAPPDATA%\dsh-tray-follower\state.json`
(override with `DSH_TRAY_FOLLOWER_DIR`), written atomically (tmp + rename) with a
≤250 ms debounce:

```jsonc
{
  "schemaVersion": 1,
  "updatedAt": 1730000000000,
  "hostPid": 1234,
  "webOrigin": "http://127.0.0.1:61983",
  "workspaces": [
    {
      "id": "ws_...",
      "title": "dsh_tray_follower",
      "path": "C:\\...\\dsh_tray_follower",
      "sessions": [
        {
          "id": "session-...",
          "title": "配置 Git 等工程管理",
          "status": "running",
          "detail": "Running bash",
          "updatedAt": 1730000000000,
          "startedAt": 1730000000000
        }
      ]
    }
  ],
  "unreadEvents": [
    {
      "id": "evt_...",
      "kind": "completed",
      "sessionId": "session-...",
      "workspaceId": "ws_...",
      "title": "Task completed",
      "body": "dsh_tray_follower • 配置 Git 等工程管理",
      "createdAt": 1730000000000
    }
  ]
}
```

Notes:

- `webOrigin` comes from the Host's `webApp.getAdvertisedUrl()` (falling back to
  `webServer.getOrigin()`, then `DSH_WEB_URL`); it is `""` when unknown.
- `workspaces` keeps the `workspaceRegistry` durable order. Conversations that
  belong to no workspace are published under the synthetic section
  `id: "unassigned"` instead of being dropped.
- Only **live top-level conversations** are published. Subagent children
  (`SessionHeader.origin === 'subagent'` or `delegationDepth > 0`) are ignored.
  A conversation that stops being live keeps its final `completed`/`failed`
  state for five minutes, then disappears from the file.
- `unreadEvents` keeps the last 50 events. Ids are deterministic
  (`evt_` + SHA-1 of the logical occurrence), so re-delivered Host events and
  plugin reloads cannot duplicate a notification on the bridge side.
- On unload the file is flushed and **left in place**; a stale `updatedAt` is
  how the bridge can recognize that the Host is gone.

## Status derivation

| status | meaning |
|---|---|
| `running` | the agent is running, or an active goal keeps continuing between rounds |
| `waiting-approval` | an `approval/request` is pending (or `approval/asked` was logged without its outcome) |
| `waiting-choice` | `ask_user_question` with options / plan review is pending |
| `waiting-input` | free-text `ask_user_question` is pending |
| `completed` | the last turn ended `completed` (or a goal completed) |
| `failed` | the last turn ended `error` / `max-tokens` / `blocked`, a goal was blocked, or `agent/error` was recorded and the agent stopped |
| `idle` | live, nothing pending, no outcome yet (user aborts and crash markers stay `idle`) |

`detail` is a short localized line for the menu (`Running bash`, `Waiting for
approval: …`, `Completed`, …).

Unread events are emitted for user-relevant stops only:

| kind | source |
|---|---|
| `completed` | `turn/end` reason `completed`, goal `complete` |
| `failed` | `turn/end` reason `error`/`max-tokens`/`blocked`, goal `block`, `agent/error` (once the agent stops) |
| `needs-attention` | pending approval / question that is **still pending after 1.2 s** |

An immediately answered approval or question never notifies. A conversation
that is following an armed goal suppresses its between-round `completed` turns
and notifies only when the goal itself completes or blocks.

## Fallback notifications

The preferred channel is the bridge (it knows whether the DSH window is
focused). The bridge owns `<dataDir>\bridge.json`, contract
`{ "pid": number, "ts": number, "version": string }`, refreshed regularly.
The Host sends its own toast only when that heartbeat is absent, malformed,
more than 15 s old, or clock-skewed:

- Windows: WinRT `ToastGeneric` through
  `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand`
  (UTF-16LE base64, so Chinese text and quotes need no shell escaping), filed
  under the built-in Windows PowerShell AUMID. Clicking it opens `dsh://open`
  when the Host runs inside DSH Desktop (Electron `RUN_AS_NODE`), else the Web
  GUI origin when known.
- Any other platform, or when no PowerShell exists: silent no-op.

Fallback toasts are rate-limited (1 per 1.5 s, newest event wins) and can be
disabled entirely.

## Configuration (environment only)

There is intentionally no `Config` schema: a plugin Config would need
`@deepseek-ai/schemastery` and the bundle is dependency-free.

| Variable | Default | Meaning |
|---|---|---|
| `DSH_TRAY_FOLLOWER_DIR` | `%LOCALAPPDATA%\dsh-tray-follower` (`$XDG_STATE_HOME/dsh-tray-follower`, `~/Library/Application Support/...` elsewhere) | data directory holding `state.json` |
| `DSH_TRAY_FOLLOWER_LANG` | `DSH_LOCALE`, `LC_ALL`, `LC_MESSAGES`, `LANG`, JS locale → `en` | runtime language for `detail` / notifications (`en`, `zh`) |
| `DSH_TRAY_FOLLOWER_NOTIFY` | enabled | `0`/`off`/`false` disables the PowerShell fallback toasts |

## Bundle contents

```
package.json          name, exports (., ./locale/*.json, ./icon), files, dsh.bundle.patch
cordis.patch.yml      insert row: id dsh-tray-follower, name dsh-tray-follower
index.js              Host plugin: services, events, timers, state writer, fallback toast
lib/                  pure modules (unit-tested with node --test)
locale/en.json        meta.title "Tray follower" / meta.description
locale/zh.json        meta.title "托盘跟随者" / meta.description
icon.svg              original icon (SVG, < 64 KiB)
test/*.test.mjs       node --test suites
```

## Install

Installed by the repository's install step through `plugin_manager`
`install_bundle` with the absolute package directory; do not edit the profile's
`package.json` / `cordis.patch.yml` by hand. Row metadata
(`id: dsh-tray-follower`, `name: dsh-tray-follower`) lives in
`cordis.patch.yml`.

## Develop / verify

```powershell
# syntax
Get-ChildItem -Recurse packages/dsh-tray-follower -Include *.js,*.mjs | ForEach-Object { node --check $_.FullName }

# unit tests (Node 24 does not expand a positional directory argument; use the glob)
node --test "packages/dsh-tray-follower/test/*.test.mjs"
```

## Known limitations

- Host-only: no Client half, so no settings page; configuration is environment
  only.
- The Host cannot know whether the DSH window is focused: focus-based
  suppression is the bridge's job. The fallback toasts may therefore appear
  even while DSH is focused.
- Titles depend on the optional `sessionTitle` service (`sessionTitle.get`) and
  its `session/title` log event; without it the tray falls back to the working
  directory's last segment.
- Only sessions live in the current Host process are tracked; conversations
  from previous runs are not listed.
- Waiting states from `approval/request` / `user-questions/request` additionally
  depend on being reached by the waterfall: if an earlier answerer claims a
  request before this plugin's listener runs, the state falls back to the
  session log (`approval/asked`, `tool/call` of `ask_user_question`), which
  covers tool approvals and questions but not arbitrary non-tool requests.
- `webOrigin`/bridging assume the desktop shell can read the data directory
  written by the Host process (same user profile).
- Portability: Windows 10/11 for the fallback toast; elsewhere the plugin still
  writes the state file but cannot notify without the bridge.
