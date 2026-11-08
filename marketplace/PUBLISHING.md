# Publishing checklist — `dsh-tray-follower`

This document is the release runbook for publishing `dsh-tray-follower` (single
npm package: Host plugin + Client settings page + optional Desktop tray bridge)
and getting it listed in the DSH plugin catalogs.

> **Environment note.** The build machine used for this repository has **no
> GitHub access** and **must not run `npm publish`**. Everything below is a
> step-by-step checklist for the release operator; the only automated steps are
> the local build and `npm pack --dry-run`, which are offline.

---

## 0. What gets published

One npm package, built by `scripts/build-market-package.mjs`:

```
dist/dsh-tray-follower/
  package.json            generated marketplace manifest (not the source manifest)
  index.js                Host half (tracks conversations, publishes state.json)
  client.js               Client half (Settings → Tray follower, 9 live options)
  lib/                    Host internals (11 modules)
  locale/{en,zh}.json     bundle metadata
  icon.svg
  cordis.patch.yml        bundle patch row
  bridge/shell-hook/      Electron-main hook (tray menu + native notifications)
  bridge/injector/        Node-inspector injector (launch.mjs / inject.mjs / lib)
  bridge/launcher/        hidden VBS + PowerShell launcher
  scripts/install-bridge.mjs     packaged installer (generated from tools/)
  scripts/uninstall-bridge.mjs   packaged uninstaller (generated from tools/)
  README.md               = marketplace/package-readme.md
  LICENSE  CHANGELOG.md
```

`npm pack` is run **inside `dist/dsh-tray-follower/`**. Never publish from the
repository root: the source `packages/dsh-tray-follower/package.json` is
`private`, has no `LICENSE`/`CHANGELOG` and declares tests that must not ship.

Current expected package shape (verify with the report, not by assumption):

| Metric | Expected at 0.2.0 |
| --- | --- |
| files in tarball | 50 |
| tarball size | ≈ 92 KiB |
| unpacked size | ≈ 343 KiB |
| `clientHalf` in report | `true` |
| lib modules | 11 |
| required runtime files missing | 0 |

---

## 1. One-time repository setup (before the first release)

1. Create/pick the public GitHub repository, e.g.
   `https://github.com/<owner>/dsh-tray-follower` (the build machine cannot do
   this; run it from a connected machine).
2. Replace the `Green233233` placeholder in the catalog templates. The placeholder
   appears only in:
   - `marketplace/awesome-plugin-entry.json` — `owner`, `url`, `page`, `icon`;
   - `marketplace/market-index-entry.json` — `title`, `homepage`,
     `repository.url`;
   - the build invocation (`--repository <url>`), which also fills
     `homepage` / `repository` / `bugs` in the generated `package.json`.
3. Confirm that `LICENSE` (MIT) and `CHANGELOG.md` exist at the repository root —
   the build fails if either is missing.
4. Create an npm account with publish rights to the unscoped name
   `dsh-tray-follower` (the name is currently unclaimed as of this release
   preparation) and enable 2FA.

A repository URL check is not automated because the build must stay offline; the
build prints a warning while the `Green233233` placeholder is in use.

```powershell
# verify no placeholder remains in the templates or the built package
Select-String -Path marketplace\*.json -Pattern 'Green233233'
Select-String -Path dist\dsh-tray-follower\package.json -Pattern 'Green233233'
```

Both commands must return nothing after the placeholders are replaced.

---

## 2. Version bump

The source manifest is owned by the plugin code, not by this packaging
directory. For a release, coordinate this order:

1. Bump `packages/dsh-tray-follower/package.json` → `"version": "0.2.0"` (or the
   release version).
2. Add the matching `CHANGELOG.md` section at the repository root (date +
   Added/Changed/Fixed).
3. Update version references in `README.md` / `bridge/README.md` if the release
   changed the installer behavior.
4. If the bridge version is tracked separately, bump its constants as well
   (`bridge/shell-hook/lib/constants.cjs`).

The build resolves the version as:

1. `--version <semver>` when passed;
2. otherwise the source `packages/dsh-tray-follower/package.json` version;
3. never below the marketplace baseline `0.2.0` — a stale source manifest is
   overridden with a warning (so a forgotten bump cannot publish a package that
   claims 0.1.0 while containing 0.2.0 features).

The generated package stamps the resolved version into `package.json` and into
the packaged installer's `const VERSION`.

---

## 3. Build and inspect (offline)

```powershell
cd <repo root>

# 1. Build: writes dist/dsh-tray-follower/ + dist/market-package-report.json
node scripts/build-market-package.mjs --repository https://github.com/<owner>/dsh-tray-follower

# 2. The build must exit 0 and print BUILD OK. Review the report:
node -e "const r=require('./dist/market-package-report.json'); console.log(JSON.stringify({ok:r.ok,version:r.version,clientHalf:r.clientHalf,fileCount:r.fileCount,missing:r.checks.missingRequiredFiles,warnings:r.warnings},null,2))"

# 3. Syntax-check the entry points and installers
node --check dist/dsh-tray-follower/index.js
node --check dist/dsh-tray-follower/client.js
node --check dist/dsh-tray-follower/scripts/install-bridge.mjs
node --check dist/dsh-tray-follower/scripts/uninstall-bridge.mjs

# 4. Dry-run both packaged installers (no files are modified without --apply)
node dist/dsh-tray-follower/scripts/install-bridge.mjs
node dist/dsh-tray-follower/scripts/uninstall-bridge.mjs
```

Expected build output:

```
version:     0.2.0
client half: present (client.js)
files:       50 copied
npm pack:    dsh-tray-follower-0.2.0.tgz (tar 92.4 KiB, unpacked 342.4 KiB, 50 entries)
node --check: scripts/install-bridge.mjs OK
node --check: scripts/uninstall-bridge.mjs OK
node --check: index.js OK
node --check: client.js OK
BUILD OK
```

Expected installer dry-run (paths abbreviated):

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
```

The report's `pack.files` array is the authoritative tarball file list. It must
contain at least:

```
package.json
index.js
client.js
locale/en.json
locale/zh.json
icon.svg
cordis.patch.yml
README.md
LICENSE
CHANGELOG.md
bridge/shell-hook/hook.cjs
bridge/injector/launch.mjs
bridge/launcher/launch-bridge.vbs
scripts/install-bridge.mjs
scripts/uninstall-bridge.mjs
lib/*.js (11 files)
```

If the report lists a problem or the tarball is ≥ 10 MiB, stop: do not publish.

### 3.1 Optional tarball inspection (still offline)

```powershell
cd dist\dsh-tray-follower
npm pack --dry-run --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s)[0];console.log(j.filename,j.size,'bytes',j.entries?.length??j.files.length,'entries');for(const f of j.files)console.log(' ',f.path)})"
```

Check the list yourself: no `test/`, no `docs/`, no `tools/`, no `*.tgz`, no
`*.log`, no `node_modules/`, no `dist/`, no `docs/recon` extracts.

---

## 4. Publish to npm

Run on a machine with npm registry access (not this one):

```powershell
npm login                     # or: npm whoami (must show the release account)
cd dist\dsh-tray-follower
npm publish --access public   # publishConfig.access=public is already in package.json
```

Rules:

- **Only** publish from `dist/dsh-tray-follower/`.
- Do not run `npm publish` from the repository root or from
  `packages/dsh-tray-follower/` (source manifest is `private: true`).
- The published tarball must be byte-identical to the verified build. If the
  build is rerun after verification, verify again (the build is deterministic:
  content, entry list and shasum only change when sources change).

Verify the published artifact from a clean directory:

```powershell
npm view dsh-tray-follower version dist-tags --json
npm view dsh-tray-follower dist.tarball
npm pack dsh-tray-follower@0.2.0 --json   # downloads and reports size/shasum
```

Compare `size` / `shasum` with `dist/market-package-report.json`
(`pack.size`, `pack.shasum`). If they differ, the published tarball was not the
verified build — publish a new patch version, do not overwrite.

---

## 5. Install test in DSH (release gate)

Do this **before** submitting the catalog entry; a dead npm package must never
appear in the listings.

1. On Windows 10/11 with DSH Desktop 0.2.2-rc.1+:
   open **Settings → Plugins**, search `dsh-tray-follower`, install it.
   Equivalent CLI on a clean profile:
   `dsh plugin --profile desktop add dsh-tray-follower@0.2.0`.
2. Verify the plugin row is present and enabled, and **Settings → Tray
   follower** renders the two option groups with the documented defaults
   (`showIdle=false`, `maxSessionsPerWorkspace=6`, both header/footer `true`,
   all five notification options `true`).
3. Toggle a setting; confirm the tray behavior after bridge installation changes
   within ~1 s (no DSH restart).
4. Verify the Host half writes
   `%LOCALAPPDATA%\dsh-tray-follower\state.json` with `schemaVersion: 2` and an
   `options` object.
5. Verify the packaged bridge installer location inside the installed package:
   `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-tray-follower\scripts\install-bridge.mjs`
   (use the real profile root if `DSH_HOME` is overridden).
6. Run it with `--apply`, fully quit DSH, relaunch from the shortcut, and confirm
   the tray conversation section and a native notification.
7. Run `scripts/uninstall-bridge.mjs --apply` and confirm the tray menu returns
   to the shell's original Open/Quit entries.

See `marketplace/VALIDATION.md` for the exact commands and expected outputs,
including an installed-layout simulation that works offline.

---

## 6. awesome-dsh-plugin listing (PR checklist)

The community list is `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`
(source of `https://awesome-dsh-plugin.com/plugins.json`). **GitHub is not
reachable from the build machine** — perform these steps from a connected
machine when the time comes.

1. Publish the npm package first (step 4) — entries point at a real npm
   package and version.
2. Fork the awesome list and add the entry from
   `marketplace/awesome-plugin-entry.json` to the plugin data file used to
   generate `plugins.json` (keep the same field order and shape as neighbouring
   entries; do not add a `_comment` field).
3. Fill/replace the placeholders:
   - `owner` — the GitHub owner;
   - `url` — `https://github.com/<owner>/dsh-tray-follower`;
   - `page` — `https://awesome-dsh-plugin.com/p/<owner>/dsh-tray-follower/`;
   - `icon` — a reachable square icon (PNG ≥ 128 px preferred; if the site
     rejects SVG, export `icon.svg` to PNG and host it in the repo under
     `docs/assets/`).
4. Keep `category` = `"notify"` (the catalog's id for **Notifications &
   Integrations**; the display name is "通知与集成"). The literal string
   `"notification"` is **not** a valid category id in the published catalog.
5. Keep:
   - `npm` = `dsh-tray-follower`
   - `version` = the published version (`0.2.0`)
   - `install` = `dsh plugin --profile desktop add dsh-tray-follower`
   - `stars` = `0` (the site's automation refreshes stars/downloads)
   - `added` = the date the entry is merged (`2026-11-08`)
   - `capabilities` = `["shell","fs-read","fs-write","network","env"]` —
     matches reality: the installer/launcher spawns User-level processes, the
     tray bridge reads/writes under `%LOCALAPPDATA%`, the injector uses a
     loopback-only inspector, and the launcher reads environment variables.
6. PR title/body template:

   > **Add dsh-tray-follower — per-workspace tray status + native DSH
   > notifications**
   >
   > - npm: https://www.npmjs.com/package/dsh-tray-follower
   > - repo: https://github.com/<owner>/dsh-tray-follower
   > - platform: Windows 10/11, DSH Desktop ≥ 0.2.2-rc.1
   > - capabilities: shell, fs-read, fs-write, network (loopback inspector only), env
   > - no telemetry, no cloud service; MIT license
   > - tray bridge is optional and installed once with a reversible user-level
   >   script; the plugin alone only publishes local state
   >
   > Entry JSON: see `marketplace/awesome-plugin-entry.json` in the repo.

7. PR checklist before pushing:
   - [ ] npm package and version exist (the entry is dead otherwise)
   - [ ] `LICENSE` is MIT and visible in the repo root
   - [ ] `README.md` explains install, the one-time bridge step, and uninstall
   - [ ] description `en` and `zh` are both present, ≤ ~400 characters, and
         mention Windows + DSH Desktop
   - [ ] `url` / `page` / `icon` open in a browser
   - [ ] no secrets, no absolute local paths, no `dist/` artifacts in the diff
   - [ ] the entry keeps the catalog's field shape (no extra fields)
8. After merge: the site's pipeline regenerates `plugins.json` and the
   format-1 market catalog. Confirm the entry appears at
   `https://awesome-dsh-plugin.com/p/<owner>/dsh-tray-follower/`.

---

## 7. Market index publishing / registration

The DSH plugin market consumes a **format-1 catalog package** (observed locally
as `dsh-plugin-catalog-<date>.<rev>.tgz`) that contains:

- `index.json` — `{format: 1, title, description, metadata: {categories,
  labels, sortKeys}, plugins: [...]}`; each entry is the format represented by
  `marketplace/market-index-entry.json`;
- `plugins.json` — the awesome-dsh-plugin catalog (`{name, owner, url, page,
  category, description, npm, version, stars, capabilities, install, added,
  icon}`).

What this means for a release:

1. The catalog's `versions[].source.type` must be `"npm"`: the market installs
   the package from the npm registry, so **npm publication is a hard
   prerequisite** (a GitHub-only release cannot be listed by the default
   catalog).
2. The entry template to submit/merge is
   `marketplace/market-index-entry.json`. `versions[].publishTimestamp` is
   filled by the catalog pipeline (a Unix timestamp in seconds), so it is
   intentionally absent from the template.
3. `metadata.category` is `"notify"`; `keywords` / `labels` / `sortKeys` are
   optional, so empty arrays/objects are valid.
4. `versions[].engines.dsh` declares the minimum DSH build. This package needs
   `>=0.2.2-rc.1 <0.3.0-0` (settings slot + `configForms`); keep it in sync with
   the README requirements when DSH compatibility changes.
5. Registration flow: merge the awesome-dsh-plugin PR → the catalog pipeline
   rebuilds the package and publishes the new `index.json`/`plugins.json` →
   DSH clients pick it up from their configured market index.
6. Verify from a DSH build that exposes the market (this machine currently has
   **no market index configured**, so this is a manual post-merge step):

   ```text
   plugin_market list_indexes        → the configured index URL(s)
   plugin_market list_plugins {query: "dsh-tray-follower"}
     → bundle result: name dsh-tray-follower, version 0.2.0, source npm
   ```

   Or use the DSH **Plugins → Market** page: search `dsh-tray-follower`, confirm
   the entry, category label, and version, then install it from the market on a
   scratch profile.
7. If the project later self-hosts a catalog (custom index): serve the
   format-1 `index.json` + `plugins.json` package over HTTPS, add the index URL
   in DSH's market settings, and repeat the verification. A custom index does not
   replace the awesome-list listing.

**Compatibility metadata recap**

| Field | Value | Why |
| --- | --- | --- |
| `source.type` | `npm` | default catalog installs from the npm registry |
| `category` | `notify` | real catalog id for Notifications & Integrations |
| `engines.dsh` | `>=0.2.2-rc.1 <0.3.0-0` | settings page APIs in this release |
| `engines.node` (package.json) | `>=20` | installer/runtime baseline |
| `license` | `MIT` | root `LICENSE` |

---

## 8. Rollback

Order matters: stop new installs, then fix forward.

1. **Mark the version deprecated** (keeps existing installs working and warns new
   users):

   ```powershell
   npm deprecate dsh-tray-follower@0.2.0 "Tray bridge regression; use 0.2.1 or newer"
   ```

2. **Unpublish only if the release is unusable and < 72 h old** (npm policy):

   ```powershell
   npm unpublish dsh-tray-follower@0.2.0
   ```

   After 72 h, never unpublish: deprecate and publish a fixed patch instead.
3. **Catalog**: open a PR against awesome-dsh-plugin removing the entry (or
   updating its `version` after a fixed release); ask maintainers to regenerate
   the catalog. Remove/replace the `marketplace/` entry files in the repo so the
   templates do not advertise the broken version.
4. **Users**: document the downgrade path in `CHANGELOG.md`
   (`dsh plugin --profile desktop add dsh-tray-follower@0.1.x`) and remind them
   to run `scripts/uninstall-bridge.mjs --apply` before downgrading the bridge
   payload if the bridge changed incompatibly.
5. **Post-mortem**: add the regression and the verification gap to the release
   notes; add a test to `tools/check.mjs` or the build script so the same class
   of failure fails the build next time.

---

## 9. Post-release verification list

Run after `npm publish` and after the catalog update:

- [ ] `npm view dsh-tray-follower version` → `0.2.0` (or the release version)
- [ ] `npm view dsh-tray-follower dist.tarball` → registry tarball URL
- [ ] `npm pack dsh-tray-follower@<version> --json` size/shasum match
      `dist/market-package-report.json`
- [ ] Fresh DSH profile install (`Plugins` page or
      `dsh plugin --profile desktop add dsh-tray-follower@<version>`) succeeds
- [ ] Plugin row enabled; **Settings → Tray follower** shows all 9 options with
      the documented defaults
- [ ] `state.json` exists with `schemaVersion: 2` + `options`
- [ ] Packaged bridge installer runs from the installed package location and
      `--apply` works; after a full DSH restart the tray menu and one native
      notification are observed
- [ ] `scripts/uninstall-bridge.mjs --apply` restores the stock shortcuts and
      tray menu
- [ ] awesome-dsh-plugin entry merged and page reachable
- [ ] Market/search shows the plugin with version and `npm` source
- [ ] `CHANGELOG.md` entry and git tag (`v0.2.0`) published
- [ ] `dist/` was not committed (it is gitignored) and no tarball is in the repo

---

## 10. Packaging decisions and deviations (recorded for reviewers)

These are intentional, verified decisions made while preparing the marketplace
package; see `marketplace/VALIDATION.md` for the checks behind them.

1. **`marketplace/package-readme.md` replaces the source README in the package.**
   The package README is the user-facing marketplace document; the internal
   `packages/dsh-tray-follower/README.md` documents internals and stays out of
   `dist/`.
2. **The generated `package.json` description is taken from the marketplace
   text, not the source manifest.** The source description still mentions a
   removed "fallback Windows notifications" path; publishing it would describe
   behavior that no longer exists.
3. **`category` is `notify`, not `notification`.** `notify` is the id used by the
   real published catalog (`index.json` categories and `plugins.json` entries);
   `notification` would not match a category and the entry would be ignored or
   rejected.
4. **`versions[].engines.dsh` is set to `>=0.2.2-rc.1 <0.3.0-0`** instead of an
   empty object. It documents the release gate (settings slot +
   `configForms`) and matches the shape of existing catalog entries that pin a
   DSH range.
5. **The bridge payload ships inside the single npm package** (`bridge/`) and the
   installers are regenerated under `scripts/` by the build, so
   `dsh plugin add dsh-tray-follower` is enough to install everything. The
   installers resolve the payload relative to the package root and only copy it
   to `%LOCALAPPDATA%\dsh-tray-follower\app`; the repo `tools/` originals are
   never modified.
6. **`bin` shims** (`dsh-tray-follower-bridge`,
   `dsh-tray-follower-bridge-uninstall`) are added so the installers can be run
   from the profile's `node_modules/.bin` without hunting for the package path.
   The README still documents the direct `node node_modules/...` path.
7. **The package ships no tests.** `test/` is intentionally excluded from
   `files`; tests run in the repository (`node tools/check.mjs`), and shipping
   them would only bloat the marketplace package.
8. **`private: true` is stripped** and `publishConfig.access = "public"` is set
   in the generated manifest; the source bundle keeps `private: true` so it
   cannot be published accidentally from `packages/`.
9. **The bridge is optional.** The package README documents two modes: full
   integration (install the bridge) and plugin-only (state + settings, no tray
   menu, no notifications). There is deliberately **no notifications-only
   mode** — notifications are in-process Electron notifications created by the
   bridge, and the plugin never spawns an external notifier.
