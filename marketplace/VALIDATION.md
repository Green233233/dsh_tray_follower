# Verification — `dsh-tray-follower` marketplace package

How to verify the built marketplace package **before** publishing or submitting
it to a catalog. Steps 1–6 are offline and can run on the build machine; step 7
(the tray bridge) needs Windows + a DSH Desktop restart and is the release
operator's gate.

Environment used for the recorded outputs below:

| Item | Value |
| --- | --- |
| OS | Windows 11 |
| Node | 24.18.1 |
| npm | 11.16.0 |
| DSH Desktop | 0.2.2-rc.1 |
| Package under test | `dist/dsh-tray-follower` @ `0.2.0` |

---

## 1. Build

```powershell
cd <repo root>
node scripts/build-market-package.mjs
```

Expected (recorded):

```
== dsh-tray-follower marketplace package builder ==
repo:        <repo>
source:      packages/dsh-tray-follower
output:      dist/dsh-tray-follower

version:     0.2.0
client half: present (client.js)
files:       50 copied
npm pack:    dsh-tray-follower-0.2.0.tgz (tar 92.4 KiB, unpacked 342.4 KiB, 50 entries)
node --check: scripts/install-bridge.mjs OK
node --check: scripts/uninstall-bridge.mjs OK
node --check: index.js OK
node --check: client.js OK
WARN: repository/homepage/bugs use the `Green233233` placeholder; pass --repository <url> or edit them before publishing
report:      dist/market-package-report.json
BUILD OK
```

Exit code must be **0**. The placeholder warning is expected and must disappear
for a real release by passing `--repository https://github.com/<owner>/<repo>`.

**Failure checks** (run one at a time in a scratch copy; the build must exit
non-zero with a clear `ERROR:` line):

- remove/rename `packages/dsh-tray-follower/index.js` → `missing source host
  plugin entry`;
- remove `marketplace/package-readme.md` → `missing source marketplace README`;
- pass `--version banana` → `--version must be a semver`;
- pass `--repository not-a-url` → `--repository must be an http(s) URL`.

---

## 2. Inspect the report

```powershell
node -e "const r=require('./dist/market-package-report.json'); const ok=r.ok && r.clientHalf && r.checks.missingRequiredFiles.length===0 && r.checks.libFiles>0 && r.pack && r.pack.entryCount===r.fileCount && r.pack.size<10*1024*1024; console.log(JSON.stringify({ok:r.ok,version:r.version,clientHalf:r.clientHalf,fileCount:r.fileCount,libFiles:r.checks.libFiles,packSize:r.pack.size,missing:r.checks.missingRequiredFiles,warnings:r.warnings},null,2)); if(!ok) process.exit(1)"
```

Expected: `ok: true`, `version: "0.2.0"`, `clientHalf: true`, `fileCount: 50`,
`libFiles: 11`, `packSize: 94566` (≈ 92.4 KiB), `missing: []`, and at most the
placeholder warning.

Also check the generated manifest:

```powershell
node -e "const p=require('./dist/dsh-tray-follower/package.json'); const checks={name:p.name,version:p.version,license:p.license,privateIncluded:'private' in p,clientExport:p.exports['./client'],bundlePatch:p.dsh.bundle.patch,clientPlatform:p.dsh.client.platform,deps:p.dependencies,peer:p.peerDependencies,engines:p.engines}; console.log(JSON.stringify(checks,null,2)); if(p.name!=='dsh-tray-follower'||p.license!=='MIT'||'private' in p||!p.dsh.bundle.patch||!p.dsh.client||p.dependencies['@deepseek-ai/schemastery']!=='~3.19.0'||p.peerDependencies['@deepseek-ai/cordis']!=='~4.1.0') process.exit(1)"
```

Expected: `name` `dsh-tray-follower`, `version` `0.2.0`, `license` `MIT`,
`privateIncluded: false`, `clientExport` `./client.js`, `bundlePatch`
`./cordis.patch.yml`, `clientPlatform` `web`, dependency
`@deepseek-ai/schemastery ~3.19.0`, peer `@deepseek-ai/cordis ~4.1.0`,
`engines.node >=20`.

---

## 3. Syntax checks

```powershell
node --check dist/dsh-tray-follower/index.js
node --check dist/dsh-tray-follower/client.js
node --check dist/dsh-tray-follower/scripts/install-bridge.mjs
node --check dist/dsh-tray-follower/scripts/uninstall-bridge.mjs
node --check scripts/build-market-package.mjs
```

Expected: exit code 0 and no output for each command.

Additionally confirm the packaged installers no longer reference the repository
layout and resolve the payload inside the package:

```powershell
Select-String -Path dist\dsh-tray-follower\scripts\*.mjs -Pattern 'tools[/\\]'
# Expected: no matches
Select-String -Path dist\dsh-tray-follower\scripts\install-bridge.mjs -Pattern "VERSION = '0.2.0'"
# Expected: one match
```

The build script already performs both checks; this is a manual double-check.

---

## 4. Tarball file list (`npm pack --dry-run`, offline)

```powershell
cd dist\dsh-tray-follower
npm pack --dry-run --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s)[0];const files=j.files.map(f=>f.path);const required=['package.json','index.js','client.js','locale/en.json','locale/zh.json','icon.svg','cordis.patch.yml','README.md','LICENSE','CHANGELOG.md','bridge/shell-hook/hook.cjs','bridge/injector/launch.mjs','bridge/launcher/launch-bridge.vbs','scripts/install-bridge.mjs','scripts/uninstall-bridge.mjs'];const missing=required.filter(f=>!files.includes(f));const forbidden=files.filter(f=>/^(test|tools|docs)\//.test(f)||/\.(tgz|log|tmp)$/.test(f)||f.includes('node_modules'));console.log({filename:j.filename,size:j.size,unpackedSize:j.unpackedSize,entryCount:j.entryCount??files.length,missing,forbidden});if(missing.length||forbidden.length||j.size>=10*1024*1024)process.exit(1)})"
```

Expected:

```
{
  filename: 'dsh-tray-follower-0.2.0.tgz',
  size: 94566,
  unpackedSize: 350583,
  entryCount: 50,
  missing: [],
  forbidden: []
}
```

The tarball must contain **all 11 `lib/*.js` modules** plus `client.js`; the
build asserts both. No `test/`, `tools/`, `docs/`, `node_modules/`, logs or
tarballs may appear.

---

## 5. Packaged installers: dry runs and installed-layout resolution

Both scripts default to a dry run (no file changes) and print their plan.

```powershell
node dist/dsh-tray-follower/scripts/uninstall-bridge.mjs
```

Expected: exit 0; on a machine with the bridge installed it prints the manifest
version, the shortcut restore plan and the payload removal plan; on a machine
without it prints `No install manifest found; nothing recorded to restore.` and
exits 0.

```powershell
node dist/dsh-tray-follower/scripts/install-bridge.mjs
```

Expected (paths abbreviated, exit 0):

```
== dsh-tray-follower bridge installer ==
repo:      <repo>\dist\dsh-tray-follower
data dir:  C:\Users\<you>\AppData\Local\dsh-tray-follower
DSH exe:   C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe
mode:      dry run (pass --apply to execute)

planned payload:
  copy <pkg>\bridge\shell-hook -> ...\app\shell-hook
  copy <pkg>\bridge\injector   -> ...\app\injector
  copy <pkg>\bridge\launcher   -> ...\app\launcher
planned shortcuts:
  replace  ...\Start Menu\Programs\DeepSeek Harness.lnk
  ...
Dry run complete. Re-run with --apply to install.
Uninstall later with: node "<pkg>\scripts\uninstall-bridge.mjs" --apply
```

**Installed-layout simulation** (proves the payload resolves after the package
is laid out like `node_modules/dsh-tray-follower`, which is what
`dsh plugin add` creates — offline, no writes):

```powershell
$tmp = Join-Path $env:TEMP ("dsh-tf-install-check-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path (Join-Path $tmp 'node_modules') | Out-Null
Copy-Item -Recurse dist\dsh-tray-follower (Join-Path $tmp 'node_modules\dsh-tray-follower')
node (Join-Path $tmp 'node_modules\dsh-tray-follower\scripts\install-bridge.mjs')
# Expected: same plan as above, with repo: <tmp>\node_modules\dsh-tray-follower
#           and payload sources under <tmp>\node_modules\dsh-tray-follower\bridge\*
Remove-Item -Recurse -Force $tmp
```

---

## 6. Expected package contents

```
dist/dsh-tray-follower/
  package.json
  index.js
  client.js
  lib/{atomic-json,classify,constants,ids,paths,settings,state-writer,state,status,strings,tracker}.js
  locale/{en,zh}.json
  icon.svg
  cordis.patch.yml
  bridge/shell-hook/{hook.cjs,package.json,lib/*.cjs}
  bridge/injector/{launch.mjs,inject.mjs,lib/*.mjs}
  bridge/launcher/{launch-bridge.vbs,launch-bridge.ps1,launch-once.ps1}
  scripts/{install-bridge.mjs,uninstall-bridge.mjs}
  README.md  LICENSE  CHANGELOG.md
```

50 files total. `dist/market-package-report.json` sits next to (not inside) the
package directory and is **not** part of the tarball.

---

## 7. Full integration test (manual, Windows + DSH restart)

Use a disposable Windows user / VM, or back up
`%USERPROFILE%\.dsh\profiles\desktop` first. These steps are the release gate;
they cannot run headless.

### 7.1 Install the plugin

Option A — from the built package (pre-publish, local):

```powershell
# Use the same local-install mechanism as the DSH Plugins page / plugin_manager
# install_bundle, or, when the CLI is available:
dsh plugin --profile desktop add "<repo>\dist\dsh-tray-follower"
```

Option B — after publishing:

```powershell
dsh plugin --profile desktop add dsh-tray-follower@0.2.0
```

Expected:

- plugin row `dsh-tray-follower` present and enabled;
- **Settings → Tray follower** (设置 → 托盘跟随) renders:
  - group “Tray menu” / 「托盘右键菜单」: `showIdle` off,
    `maxSessionsPerWorkspace` 6, `showHeaderCounts` on, `showFooter` on;
  - group “Notifications” / 「通知」: all five toggles on;
- toggling a switch writes without restart and survives a DSH restart;
- `%LOCALAPPDATA%\dsh-tray-follower\state.json` exists and contains:

```jsonc
{
  "schemaVersion": 2,
  "updatedAt": 1730000000000,
  "options": {
    "tray": { "showIdle": false, "maxSessionsPerWorkspace": 6, "showHeaderCounts": true, "showFooter": true },
    "notifications": { "notifyOnCompleted": true, "notifyOnFailed": true, "notifyOnAttention": true, "suppressWhenFocused": true, "notificationSound": true }
  },
  "workspaces": [ /* ... */ ],
  "unreadEvents": [ /* ... */ ]
}
```

### 7.2 Install the tray bridge

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
node node_modules\dsh-tray-follower\scripts\install-bridge.mjs          # dry run
node node_modules\dsh-tray-follower\scripts\install-bridge.mjs --apply
```

Expected: payload copied to `%LOCALAPPDATA%\dsh-tray-follower\app\{shell-hook,
injector,launcher}` + `install.json`; every DeepSeek Harness `.lnk` rewritten to
`wscript.exe "<data>\app\launcher\launch-bridge.vbs" "<data>"` with a byte
backup under `backup\shortcuts`.

### 7.3 Restart and observe

1. Fully quit DSH (tray → Quit), launch it from the **DeepSeek Harness shortcut**.
2. `%LOCALAPPDATA%\dsh-tray-follower\injector.log` ends with `BRIDGE_OK:
   injected into DeepSeek Harness ... patched=true trayAdopted=true`.
3. Right-click the tray icon:
   - original Open / Quit items still work;
   - header `对话：N 运行 / M 待处理` (or English);
   - one submenu per workspace with status glyphs and no idle rows by default;
   - footer `dsh-tray-follower v0.2.0`.
4. Enable `showIdle` in settings and confirm the `空闲会话 (N)` /
   `Idle sessions (N)` submenu appears within ~1 s.
5. Hide/minimize DSH and trigger an approval request:
   - a native notification titled in DSH's own name appears;
   - `bridge.log` contains `notification-shown`;
   - clicking it restores and focuses DSH.
6. Trigger a completion while the window is **focused**: no notification
   (`notification-suppressed {"reason":"focused"}`).
7. Disable `notificationSound`, `notifyOnCompleted`, etc. and confirm the
   behavior follows the settings.

### 7.4 Uninstall / rollback

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
node node_modules\dsh-tray-follower\scripts\uninstall-bridge.mjs --apply
```

Expected: shortcuts restored byte-for-byte, payload removed, manifest removed;
after a full DSH restart the tray menu is the stock Open/Quit menu and no
notifications are raised. Uninstall the plugin on the Plugins page afterwards;
`state.json` remains unless `--purge` or a manual delete removes the data dir.

---

## 8. Release evidence to keep

Attach these to the release record / PR:

- `dist/market-package-report.json` (contains `ok`, version, file list, pack
  size + shasum, warnings, syntax checks);
- terminal output of the build and of the `npm pack --dry-run` assertion
  (step 4);
- install/uninstall dry-run output (step 5);
- DSH screenshots or screen recording of the tray menu, settings page and a
  native notification (step 7) — also used as the marketplace screenshots.

The npm publish itself and the awesome-list PR are documented in
`marketplace/PUBLISHING.md`; neither is performed by this build/validation
procedure.
