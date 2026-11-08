# dsh-tray-follower

A DSH **bundle** with a Host half and a small web Client half that tracks every
top-level conversation of the running DeepSeek Harness Host, grouped by
workspace, and publishes their status to a state file. The DSH Desktop **shell
bridge** (see `bridge/shell-hook/` in the repository) reads that file to build
the tray icon's right-click menu and to raise native notifications while the
window is hidden or unfocused.

The plugin publishes state only. **Notifications are emitted exclusively by the
DSH Desktop shell bridge** (in-process Electron `Notification`, so they appear
under the DeepSeek Harness name) — the plugin never starts an external notifier
process (no PowerShell/WinRT/notify-send). Without the bridge the plugin still
publishes `state.json`, but no tray section and no OS notifications appear.

- Package name / row: `dsh-tray-follower`
- Host half: `index.js` exports `Config`, `name`, `inject`, `apply`.
- Client half: `client.js` registers the **Settings → Tray follower** page
  (slot `settings.section`) that edits the Host `Config` live.
- State contract: [docs/DESIGN.md §4 / §4.1](../../docs/DESIGN.md) — implemented exactly
  (`schemaVersion: 2`, includes the published `options`).
- One runtime dependency: `@deepseek-ai/schemastery` (the Host Config schema);
  the Client half imports only React from the browser module table.

## What it publishes

`%LOCALAPPDATA%\dsh-tray-follower\state.json`
(override with `DSH_TRAY_FOLLOWER_DIR`), written atomically (tmp + rename) with a
≤250 ms debounce:

```jsonc
{
  "schemaVersion": 2,
  "updatedAt": 1730000000000,
  "hostPid": 1234,
  "webOrigin": "http://127.0.0.1:61983",
  "options": {
    "tray": { "showIdle": false, "maxSessionsPerWorkspace": 6, "showHeaderCounts": true, "showFooter": true },
    "notifications": { "notifyOnCompleted": true, "notifyOnFailed": true, "notifyOnAttention": true, "suppressWhenFocused": true, "notificationSound": true }
  },
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

## Notifications

Notifications are not sent by this plugin. The DSH Desktop shell bridge (see
`bridge/`) reads `unreadEvents` from `state.json`, checks the real window
focus/visibility state, and raises a native notification through the Electron
main process (`new Notification(...)`), which Windows attributes to DeepSeek
Harness itself. This matches the product requirement that notifications be sent
in DSH's own name and that no external PowerShell/WinRT notifier be used.

The bridge suppresses notifications while its window is focused/visible (unless
`suppressWhenFocused` is turned off), keeps a persistent cursor so events are
never replayed, silently baselines existing events on first run, and ignores
events older than 10 minutes. Kind filters and the sound toggle come from
`state.json.options` (Settings → Tray follower). When the bridge is not
installed (or injection failed), the Host keeps publishing state and no OS
notification is raised — a deliberately accepted degraded mode.

## Settings

All options live in **DSH Settings → Tray follower** (native page registered by
`client.js`). They are declared as a `.volatile()` Host `Config` schema, so a
change is applied without restarting DSH: the Host polls the live values every
second and republishes `state.json.options` immediately; the bridge reads them on
its next poll (≤1 s).

| Field | Type / default | Group | Meaning |
|---|---|---|---|
| `showIdle` | boolean / `false` | Tray menu | Also list idle conversations (off = idle conversations never appear in the tray menu) |
| `maxSessionsPerWorkspace` | number 1–20 / `6` | Tray menu | Max conversations listed per workspace (overflow shows "还有 N 个会话") |
| `showHeaderCounts` | boolean / `true` | Tray menu | Show running/pending counts in the menu header |
| `showFooter` | boolean / `true` | Tray menu | Show the version footer |
| `notifyOnCompleted` | boolean / `true` | Notifications | Notify when a conversation completes/stops |
| `notifyOnFailed` | boolean / `true` | Notifications | Notify when a conversation fails |
| `notifyOnAttention` | boolean / `true` | Notifications | Notify when an approval/answer is needed |
| `suppressWhenFocused` | boolean / `true` | Notifications | Stay quiet while the DSH window is focused |
| `notificationSound` | boolean / `true` | Notifications | Play the system alert sound with each notification |

Environment overrides are unchanged:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_TRAY_FOLLOWER_DIR` | `%LOCALAPPDATA%\dsh-tray-follower` (`$XDG_STATE_HOME/dsh-tray-follower`, `~/Library/Application Support/...` elsewhere) | data directory holding `state.json` |
| `DSH_TRAY_FOLLOWER_LANG` | `DSH_LOCALE`, `LC_ALL`, `LC_MESSAGES`, `LANG`, JS locale → `en` | runtime language for `detail` (`en`, `zh`) |

## Bundle contents

```
package.json          name, exports (., ./client, ./locale/*.json, ./icon), files, dsh.bundle.patch, dsh.client
cordis.patch.yml      insert row: id dsh-tray-follower, name dsh-tray-follower
index.js              Host plugin: Config schema, services, events, timers, state writer
lib/                  pure modules (unit-tested with node --test)
client.js             Client half: Settings → Tray follower page (settings.section)
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

- Host half cannot know whether the DSH window is focused: focus-based
  suppression is the bridge's job. Without the bridge there is no tray section
  and no notification at all (by design — no external notifier process is
  started). The Settings page itself works without the bridge (it edits the
  Host Config), but the settings only change tray/notification behaviour once
  the bridge is installed and DSH was started from the bridge launcher.
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
- Portable: the Host writes the state contract on every platform; tray menu and
  notifications require the DSH Desktop bridge (Windows-focused in this repo).
