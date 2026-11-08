#!/usr/bin/env node
/**
 * dsh-tray-follower marketplace package builder.
 *
 * Builds ONE publishable npm package from the repository sources:
 *
 *   dist/dsh-tray-follower/
 *     package.json              generated marketplace manifest
 *     index.js                  Host half
 *     client.js                 Client settings page (when present in the source)
 *     lib/                      Host internals
 *     locale/{en,zh}.json       Bundle metadata
 *     icon.svg  cordis.patch.yml
 *     bridge/{shell-hook,injector,launcher}/   optional Desktop tray bridge
 *     scripts/{install,uninstall}-bridge.mjs   packaged installers
 *     README.md  LICENSE  CHANGELOG.md
 *
 * It then verifies the result and runs `npm pack --dry-run --json` (local only,
 * no network) to prove that the tarball would contain every required runtime
 * file. A machine-readable report is written to
 * `dist/market-package-report.json`; the process exits non-zero on any failure.
 *
 * The repository sources are never modified: `packages/`, `bridge/` and
 * `tools/` are read-only inputs. The packaged installer scripts are generated
 * from `tools/install-bridge.mjs` / `tools/uninstall-bridge.mjs` with their
 * repository-relative references adapted to the packaged layout.
 *
 * Usage:
 *   node scripts/build-market-package.mjs [--version <semver>]
 *                                        [--repository <url>]
 *                                        [--skip-pack] [--help]
 *
 * Exit codes: 0 = build verified, 1 = build failed / verification failed.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-tray-follower'
const PLUGIN_DIR = path.join(ROOT, 'packages', PACKAGE_NAME)
const BRIDGE_DIR = path.join(ROOT, 'bridge')
const MARKETPLACE_DIR = path.join(ROOT, 'marketplace')
const TOOLS_DIR = path.join(ROOT, 'tools')
const DIST_DIR = path.join(ROOT, 'dist')
const OUT_PACKAGE_DIR = path.join(DIST_DIR, PACKAGE_NAME)
const REPORT_FILE = path.join(DIST_DIR, 'market-package-report.json')

/** Marketplace release baseline (used when the source manifest is stale). */
const BASELINE_VERSION = '0.2.0'
/** Package description used for the published listing (the source text is internal). */
const MARKETPLACE_DESCRIPTION =
  'Per-workspace DSH conversation status in the Windows system tray, with native DeepSeek Harness notifications and live tray/notification settings.'
/** Sanity limit for the published tarball (npm/plugin-market friendly). */
const MAX_PACK_SIZE_BYTES = 10 * 1024 * 1024
/** Files whose absence means the package cannot run at all. */
const REQUIRED_SOURCE_FILES = [
  ['host plugin entry', path.join(PLUGIN_DIR, 'index.js')],
  ['locale/en.json', path.join(PLUGIN_DIR, 'locale', 'en.json')],
  ['locale/zh.json', path.join(PLUGIN_DIR, 'locale', 'zh.json')],
  ['icon.svg', path.join(PLUGIN_DIR, 'icon.svg')],
  ['cordis.patch.yml', path.join(PLUGIN_DIR, 'cordis.patch.yml')],
  ['bridge hook', path.join(BRIDGE_DIR, 'shell-hook', 'hook.cjs')],
  ['bridge injector launcher', path.join(BRIDGE_DIR, 'injector', 'launch.mjs')],
  ['bridge launcher VBS', path.join(BRIDGE_DIR, 'launcher', 'launch-bridge.vbs')],
  ['installer source', path.join(TOOLS_DIR, 'install-bridge.mjs')],
  ['uninstaller source', path.join(TOOLS_DIR, 'uninstall-bridge.mjs')],
  ['LICENSE', path.join(ROOT, 'LICENSE')],
  ['CHANGELOG.md', path.join(ROOT, 'CHANGELOG.md')],
  ['marketplace README', path.join(MARKETPLACE_DIR, 'package-readme.md')]
]
const REQUIRED_SOURCE_DIRECTORIES = [
  ['host lib', path.join(PLUGIN_DIR, 'lib')],
  ['bridge shell-hook', path.join(BRIDGE_DIR, 'shell-hook')],
  ['bridge injector', path.join(BRIDGE_DIR, 'injector')],
  ['bridge launcher', path.join(BRIDGE_DIR, 'launcher')]
]
/** Runtime files that must be present in the built package AND in the tarball. */
const REQUIRED_PACKAGE_FILES = [
  'package.json',
  'index.js',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'bridge/shell-hook/hook.cjs',
  'bridge/injector/launch.mjs',
  'bridge/launcher/launch-bridge.vbs',
  'scripts/install-bridge.mjs',
  'scripts/uninstall-bridge.mjs'
]
const JUNK_FILE_PATTERN = /\.(log|tmp)$/i
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', '.git', '.pnpm'])

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** @returns {{ version: string, repository: string, skipPack: boolean, help: boolean }} */
function parseArgs(argv) {
  const options = { version: '', repository: '', skipPack: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      return argv[index] === undefined ? '' : argv[index]
    }
    switch (arg) {
      case '--version':
      case '-v':
        options.version = next()
        break
      case '--repository':
        options.repository = next()
        break
      case '--skip-pack':
        options.skipPack = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        if (arg.startsWith('--version=')) options.version = arg.slice('--version='.length)
        else if (arg.startsWith('--repository=')) options.repository = arg.slice('--repository='.length)
        else if (arg.trim() !== '') throw new Error(`unknown argument: ${arg}`)
        break
    }
  }
  return options
}

function usage() {
  return [
    'dsh-tray-follower marketplace package builder',
    '',
    '  node scripts/build-market-package.mjs [options]',
    '',
    '  --version <semver>     package version (default: source package.json, baseline 0.2.0)',
    '  --repository <url>     GitHub repository URL used for repository/homepage/bugs',
    '  --skip-pack            skip the `npm pack --dry-run` verification step',
    '  --help, -h             show this help',
    '',
    'Output: dist/dsh-tray-follower/ and dist/market-package-report.json'
  ].join('\n')
}

const warnings = []
const problems = []

/** Record a non-fatal build assumption. */
function warn(message) {
  warnings.push(message)
}

/** Record a fatal verification problem. */
function problem(message) {
  problems.push(message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSemver(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
}

/** Compare two semantic versions (numeric core + prerelease ordering). */
function compareVersions(left, right) {
  const split = (value) => {
    const [core, prerelease = ''] = value.split('-')
    return { core: core.split('.').map((part) => Number.parseInt(part, 10) || 0), prerelease }
  }
  const a = split(left)
  const b = split(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === '') return 1
  if (b.prerelease === '') return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

/** @returns {{ value: any, error: string | null }} */
function readJson(file) {
  try {
    return { value: JSON.parse(readText(file)), error: null }
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function removeDir(dir) {
  if (!fs.existsSync(dir)) return
  fs.rmSync(dir, { recursive: true, force: true })
}

function relativeToRoot(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

function listFilesRecursive(dir) {
  const files = []
  if (!fs.existsSync(dir)) return files
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue
      files.push(...listFilesRecursive(full))
    } else if (entry.isFile()) {
      if (JUNK_FILE_PATTERN.test(entry.name)) continue
      files.push(full)
    }
  }
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Copy one file into the package, creating parent directories.
 * Returns the destination path.
 */
function copyFileInto(source, destination) {
  ensureDir(path.dirname(destination))
  fs.copyFileSync(source, destination)
  return destination
}

/** Copy a directory tree, skipping logs/tmp files and VCS/package directories. */
function copyTreeInto(sourceDir, destinationDir) {
  const copied = []
  if (!fs.existsSync(sourceDir)) return copied
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name)
    const destination = path.join(destinationDir, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue
      copied.push(...copyTreeInto(source, destination))
    } else if (entry.isFile()) {
      if (JUNK_FILE_PATTERN.test(entry.name)) continue
      copied.push(copyFileInto(source, destination))
    } else {
      warn(`skipping special file in payload: ${relativeToRoot(source)}`)
    }
  }
  return copied
}

function runNodeCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true })
  return {
    file: path.relative(OUT_PACKAGE_DIR, file).split(path.sep).join('/'),
    ok: result.status === 0,
    error: result.status === 0 ? null : `${result.stderr || result.stdout || `exit code ${result.status}`}`.trim()
  }
}

/** Find a runnable npm CLI without relying on a shell where possible. */
function resolveNpm() {
  const fromNode = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const candidates = [
    process.env.npm_execpath,
    fromNode,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '' && fs.existsSync(candidate))
  if (candidates.length > 0) {
    return { command: process.execPath, prefixArgs: [candidates[0]], shell: false }
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefixArgs: [], shell: process.platform === 'win32' }
}

function quoteCommandForLog(npm, args) {
  return [path.basename(npm.command), ...npm.prefixArgs.map((arg) => path.basename(arg)), ...args].join(' ')
}

// ---------------------------------------------------------------------------
// installer adaptation
// ---------------------------------------------------------------------------

/**
 * Adapt a repository installer (tools/*.mjs) to the packaged layout.
 *
 * The payload keeps the same shape (`<package root>/bridge/<part>`), so the
 * relative imports (`../bridge/injector/lib/*.mjs`) and the
 * `repoRoot = dirname(script dir)` resolution already work: in the package the
 * script lives in `<pkg>/scripts/` and the payload in `<pkg>/bridge/`.
 * What must change:
 *   - the reported installer version (`const VERSION`);
 *   - every `tools/<script>.mjs` reference -> `scripts/<script>.mjs`;
 *   - the generated uninstall hint -> `path.join(repoRoot, 'scripts', ...)`;
 *   - a generated-file header so nobody edits the dist copy.
 */
function adaptInstaller(sourceText, kind, version) {
  let text = sourceText
  const baseName = kind === 'install' ? 'install-bridge.mjs' : 'uninstall-bridge.mjs'
  const applied = []

  if (kind === 'install') {
    if (!/const VERSION = '[^']*'/.test(text)) {
      throw new Error(`${baseName}: cannot find the VERSION constant to stamp`)
    }
    text = text.replace(/const VERSION = '[^']*'/, `const VERSION = '${version}'`)
    applied.push('version stamp')
  }

  const pathJoinOriginal = "path.join(repoRoot, 'tools', 'uninstall-bridge.mjs')"
  const pathJoinPackaged = "path.join(repoRoot, 'scripts', 'uninstall-bridge.mjs')"
  if (text.includes(pathJoinOriginal)) {
    text = text.split(pathJoinOriginal).join(pathJoinPackaged)
    applied.push('uninstall hint path')
  }

  const slashReplacements = [
    ['tools/install-bridge.mjs', 'scripts/install-bridge.mjs'],
    ['tools/uninstall-bridge.mjs', 'scripts/uninstall-bridge.mjs']
  ]
  for (const [from, to] of slashReplacements) {
    if (text.includes(from)) {
      text = text.split(from).join(to)
      applied.push(`${from} -> ${to}`)
    }
  }

  if (/tools[\\/](?:install|uninstall)-bridge\.mjs/.test(text)) {
    throw new Error(`${baseName}: repository-relative installer reference left after adaptation`)
  }

  const lines = text.split('\n')
  if (!lines[0].startsWith('#!')) {
    throw new Error(`${baseName}: expected a shebang on the first line`)
  }
  const header = [
    '// ---------------------------------------------------------------------------',
    '// PACKAGED BUILD. Generated by scripts/build-market-package.mjs for the npm',
    `// package ${PACKAGE_NAME}@${version}. Do not edit this copy.`,
    '//',
    '// Packaged layout: this script lives in <package root>/scripts/ and the bridge',
    '// payload ships in <package root>/bridge/{shell-hook,injector,launcher}. The',
    '// installer copies that payload to %LOCALAPPDATA%\\dsh-tray-follower\\app',
    '// (override: --data-dir / DSH_TRAY_FOLLOWER_DIR); the launch-time hook path is',
    '// %LOCALAPPDATA%\\dsh-tray-follower\\app\\shell-hook\\hook.cjs.',
    '// ---------------------------------------------------------------------------'
  ]
  text = [lines[0], ...header, ...lines.slice(1)].join('\n')
  return { text, applied }
}

// ---------------------------------------------------------------------------
// package manifest generation
// ---------------------------------------------------------------------------

function marketplaceManifest({ sourceManifest, version, repositoryUrl, hasClient }) {
  const source = isPlainObject(sourceManifest) ? sourceManifest : {}
  const sourceDsh = isPlainObject(source.dsh) ? source.dsh : {}
  const sourceBundle = isPlainObject(sourceDsh.bundle) ? sourceDsh.bundle : {}

  const keywordSet = new Set()
  for (const keyword of Array.isArray(source.keywords) ? source.keywords : []) {
    if (typeof keyword === 'string' && keyword.trim() !== '') keywordSet.add(keyword.trim())
  }
  for (const keyword of ['deepseek', 'deepseek-harness', 'dsh-plugin', 'dsh-bundle', 'tray', 'notification', 'windows', 'desktop']) {
    keywordSet.add(keyword)
  }

  const dependencies = { ...(isPlainObject(source.dependencies) ? source.dependencies : {}), '@deepseek-ai/schemastery': '~3.19.0' }
  const peerDependencies = { ...(isPlainObject(source.peerDependencies) ? source.peerDependencies : {}), '@deepseek-ai/cordis': '~4.1.0' }

  const exportsField = { '.': './index.js' }
  if (hasClient) exportsField['./client'] = './client.js'
  exportsField['./locale/*.json'] = './locale/*.json'
  exportsField['./icon'] = './icon.svg'
  exportsField['./package.json'] = './package.json'

  const dsh = { ...sourceDsh }
  delete dsh.client
  dsh.bundle = { ...sourceBundle, patch: './cordis.patch.yml' }
  if (hasClient) {
    dsh.client = isPlainObject(sourceDsh.client)
      ? sourceDsh.client
      : {
          platform: 'web',
          immediately: true,
          inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings']
        }
    if (!isPlainObject(sourceDsh.client)) {
      warn('source package.json declares no dsh.client; inferred the standard DSH web client declaration')
    }
  } else if (isPlainObject(sourceDsh.client)) {
    warn('source package.json declares dsh.client but client.js is absent; the client half was omitted from the package')
  }
  if (!hasClient) {
    warn('client.js is not present in packages/dsh-tray-follower yet; the built package is host+bridge only')
  }

  const githubUrl = repositoryUrl.replace(/\/+$/, '')
  const repoWeb = githubUrl.replace(/\.git$/, '')

  return {
    name: PACKAGE_NAME,
    version,
    description: MARKETPLACE_DESCRIPTION,
    keywords: [...keywordSet],
    license: 'MIT',
    author:
      typeof source.author === 'string' && source.author.trim() !== '' ? source.author : 'dsh-tray-follower contributors',
    homepage: `${repoWeb}#readme`,
    repository: { type: 'git', url: `git+${repoWeb}.git` },
    bugs: { url: `${repoWeb}/issues` },
    type: 'module',
    main: './index.js',
    exports: exportsField,
    bin: {
      'dsh-tray-follower-bridge': 'scripts/install-bridge.mjs',
      'dsh-tray-follower-bridge-uninstall': 'scripts/uninstall-bridge.mjs'
    },
    files: [
      'index.js',
      ...(hasClient ? ['client.js'] : []),
      'lib',
      'locale/*.json',
      'icon.svg',
      'cordis.patch.yml',
      'bridge',
      'scripts',
      'README.md',
      'LICENSE',
      'CHANGELOG.md'
    ],
    engines: { node: '>=20' },
    scripts: {
      'bridge:install': 'node scripts/install-bridge.mjs',
      'bridge:install:apply': 'node scripts/install-bridge.mjs --apply',
      'bridge:uninstall': 'node scripts/uninstall-bridge.mjs',
      'bridge:uninstall:apply': 'node scripts/uninstall-bridge.mjs --apply'
    },
    dependencies,
    peerDependencies,
    dsh,
    publishConfig: { access: 'public' }
  }
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function build(options) {
  // --- read the source manifest defensively (it may be mid-edit) -----------
  const sourceManifestPath = path.join(PLUGIN_DIR, 'package.json')
  const manifestResult = fs.existsSync(sourceManifestPath)
    ? readJson(sourceManifestPath)
    : { value: null, error: 'missing packages/dsh-tray-follower/package.json' }
  let sourceManifest = manifestResult.value
  if (manifestResult.error) {
    warn(`source package.json is unreadable (${manifestResult.error}); falling back to build defaults`)
    sourceManifest = {}
  }
  if (!isPlainObject(sourceManifest)) sourceManifest = {}

  const sourceVersion = isSemver(sourceManifest.version) ? sourceManifest.version : ''
  let version
  if (options.version !== '') {
    if (!isSemver(options.version)) throw new Error(`--version must be a semver like 0.2.0 (got "${options.version}")`)
    version = options.version
    if (sourceVersion !== '' && sourceVersion !== version) {
      warn(`--version ${version} overrides source package.json version ${sourceVersion}`)
    }
  } else if (sourceVersion !== '') {
    version = sourceVersion
    if (compareVersions(sourceVersion, BASELINE_VERSION) < 0) {
      warn(`source package.json version ${sourceVersion} is behind the marketplace baseline ${BASELINE_VERSION}; building ${BASELINE_VERSION}`)
      version = BASELINE_VERSION
    }
  } else {
    version = BASELINE_VERSION
    warn(`source package.json has no valid version; using marketplace baseline ${BASELINE_VERSION}`)
  }

  const repositoryUrl =
    options.repository !== '' ? options.repository : 'https://github.com/your-org/dsh-tray-follower'
  if (options.repository !== '') {
    if (!/^https?:\/\/[^\s]+$/i.test(options.repository)) {
      throw new Error(`--repository must be an http(s) URL (got "${options.repository}")`)
    }
  } else {
    warn('repository/homepage/bugs use the `your-org` placeholder; pass --repository <url> or edit them before publishing')
  }

  const clientFile = path.join(PLUGIN_DIR, 'client.js')
  const hasClient = fs.existsSync(clientFile)

  // --- validate required sources -------------------------------------------
  for (const [label, file] of REQUIRED_SOURCE_FILES) {
    if (!fs.existsSync(file)) problem(`missing source ${label}: ${relativeToRoot(file)}`)
  }
  for (const [label, dir] of REQUIRED_SOURCE_DIRECTORIES) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      problem(`missing source directory ${label}: ${relativeToRoot(dir)}`)
    }
  }
  const libSources = listFilesRecursive(path.join(PLUGIN_DIR, 'lib')).filter((file) => file.endsWith('.js'))
  if (libSources.length === 0) problem('packages/dsh-tray-follower/lib contains no .js files')
  if (problems.length > 0) return { version, sourceVersion, hasClient, packageFiles: [], syntaxChecks: [], pack: null }

  // --- prepare output -------------------------------------------------------
  ensureDir(DIST_DIR)
  if (!path.basename(OUT_PACKAGE_DIR).startsWith(PACKAGE_NAME)) {
    throw new Error(`refusing to clear unexpected output directory: ${OUT_PACKAGE_DIR}`)
  }
  removeDir(OUT_PACKAGE_DIR)
  ensureDir(OUT_PACKAGE_DIR)

  const copied = []

  // Host half.
  copied.push(copyFileInto(path.join(PLUGIN_DIR, 'index.js'), path.join(OUT_PACKAGE_DIR, 'index.js')))
  copied.push(...copyTreeInto(path.join(PLUGIN_DIR, 'lib'), path.join(OUT_PACKAGE_DIR, 'lib')))
  copied.push(...copyTreeInto(path.join(PLUGIN_DIR, 'locale'), path.join(OUT_PACKAGE_DIR, 'locale')))
  copied.push(copyFileInto(path.join(PLUGIN_DIR, 'icon.svg'), path.join(OUT_PACKAGE_DIR, 'icon.svg')))
  copied.push(copyFileInto(path.join(PLUGIN_DIR, 'cordis.patch.yml'), path.join(OUT_PACKAGE_DIR, 'cordis.patch.yml')))
  if (hasClient) {
    copied.push(copyFileInto(clientFile, path.join(OUT_PACKAGE_DIR, 'client.js')))
  }

  // Bridge payload (optional Desktop half, but shipped so one npm package is enough).
  for (const part of ['shell-hook', 'injector', 'launcher']) {
    copied.push(...copyTreeInto(path.join(BRIDGE_DIR, part), path.join(OUT_PACKAGE_DIR, 'bridge', part)))
  }

  // Documentation required by the marketplace listing.
  copied.push(copyFileInto(path.join(ROOT, 'LICENSE'), path.join(OUT_PACKAGE_DIR, 'LICENSE')))
  copied.push(copyFileInto(path.join(ROOT, 'CHANGELOG.md'), path.join(OUT_PACKAGE_DIR, 'CHANGELOG.md')))
  copied.push(copyFileInto(path.join(MARKETPLACE_DIR, 'package-readme.md'), path.join(OUT_PACKAGE_DIR, 'README.md')))

  // --- generate the packaged bridge installers -----------------------------
  const scriptsDir = path.join(OUT_PACKAGE_DIR, 'scripts')
  ensureDir(scriptsDir)
  const installSource = readText(path.join(TOOLS_DIR, 'install-bridge.mjs'))
  const uninstallSource = readText(path.join(TOOLS_DIR, 'uninstall-bridge.mjs'))
  const adaptedInstall = adaptInstaller(installSource, 'install', version)
  const adaptedUninstall = adaptInstaller(uninstallSource, 'uninstall', version)
  const installPath = path.join(scriptsDir, 'install-bridge.mjs')
  const uninstallPath = path.join(scriptsDir, 'uninstall-bridge.mjs')
  fs.writeFileSync(installPath, adaptedInstall.text, { encoding: 'utf8', mode: 0o755 })
  fs.writeFileSync(uninstallPath, adaptedUninstall.text, { encoding: 'utf8', mode: 0o755 })
  copied.push(installPath, uninstallPath)

  // --- manifest -------------------------------------------------------------
  const manifest = marketplaceManifest({
    sourceManifest,
    version,
    repositoryUrl,
    hasClient
  })
  const manifestPath = path.join(OUT_PACKAGE_DIR, 'package.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  copied.push(manifestPath)

  // --- output verification ---------------------------------------------------
  const packageFiles = listFilesRecursive(OUT_PACKAGE_DIR)
  for (const required of REQUIRED_PACKAGE_FILES) {
    const full = path.join(OUT_PACKAGE_DIR, required)
    if (!fs.existsSync(full)) problem(`required file missing from the package: ${required}`)
    else if (fs.statSync(full).size === 0) problem(`required file is empty: ${required}`)
  }
  const packagedLib = packageFiles.filter((file) => {
    const rel = path.relative(OUT_PACKAGE_DIR, file).split(path.sep).join('/')
    return rel.startsWith('lib/') && rel.endsWith('.js')
  })
  if (packagedLib.length === 0) problem('package contains no lib/*.js files')
  if (hasClient && !fs.existsSync(path.join(OUT_PACKAGE_DIR, 'client.js'))) {
    problem('client.js exists in the source but was not copied into the package')
  }

  // Syntax-check the generated installers (the ones users execute) and the
  // package entry points.
  const syntaxChecks = [runNodeCheck(installPath), runNodeCheck(uninstallPath)]
  syntaxChecks.push(runNodeCheck(path.join(OUT_PACKAGE_DIR, 'index.js')))
  if (hasClient) syntaxChecks.push(runNodeCheck(path.join(OUT_PACKAGE_DIR, 'client.js')))
  for (const check of syntaxChecks) {
    if (!check.ok) problem(`node --check failed for ${check.file}: ${check.error}`)
  }

  for (const [label, file] of [
    ['installer', installPath],
    ['uninstaller', uninstallPath]
  ]) {
    const text = readText(file)
    if (/tools[\\/](?:install|uninstall)-bridge\.mjs/.test(text)) {
      problem(`${label} still references the repository tools/ layout`)
    }
    if (label === 'installer' && !text.includes(`const VERSION = '${version}'`)) {
      problem('installer does not carry the built package version')
    }
    if (text.includes(ROOT)) {
      problem(`${label} embeds the build machine's repository path`)
    }
    // Every packaged relative import (../bridge/...) must resolve inside the package.
    for (const match of text.matchAll(/from '(\.\.\/[^']+)'/g)) {
      const specifier = match[1]
      const target = path.resolve(path.dirname(file), specifier)
      if (!fs.existsSync(target)) {
        problem(`${label} imports a module that is missing from the package: ${specifier}`)
      }
    }
  }

  // --- npm pack verification (local only, no network) -----------------------
  let pack = null
  if (!options.skipPack) {
    pack = runNpmPack()
    if (pack.ok) {
      const packedPaths = pack.entries.map((entry) => entry.path)
      for (const required of REQUIRED_PACKAGE_FILES) {
        if (!packedPaths.includes(required)) problem(`npm pack is missing required file: ${required}`)
      }
      if (!packedPaths.some((entry) => entry.startsWith('lib/') && entry.endsWith('.js'))) {
        problem('npm pack contains no lib/*.js files')
      }
      if (hasClient && !packedPaths.includes('client.js')) problem('npm pack is missing client.js')
      if (packedPaths.some((entry) => entry.includes('..') || path.isAbsolute(entry))) {
        problem('npm pack contains an unsafe path')
      }
      if (pack.size > MAX_PACK_SIZE_BYTES) {
        problem(`npm pack tarball is too large: ${pack.size} bytes (limit ${MAX_PACK_SIZE_BYTES})`)
      }
      if (pack.entryCount !== packedPaths.length) {
        warn(`npm pack reported entryCount ${pack.entryCount} but listed ${packedPaths.length} files`)
      }
    }
  } else {
    warn('npm pack verification skipped (--skip-pack)')
  }

  return { version, sourceVersion, hasClient, packageFiles, syntaxChecks, pack }
}

/** Run `npm pack --dry-run --json` inside the built package. */
function runNpmPack() {
  const npm = resolveNpm()
  const packArgs = ['pack', '--dry-run', '--json', '--ignore-scripts']
  const commandArgs = [...npm.prefixArgs, ...packArgs]
  const commandLabel = quoteCommandForLog(npm, packArgs)
  const result = spawnSync(npm.command, commandArgs, {
    cwd: OUT_PACKAGE_DIR,
    encoding: 'utf8',
    windowsHide: true,
    shell: npm.shell,
    maxBuffer: 32 * 1024 * 1024
  })
  const stdout = (result.stdout || '').replace(/^\uFEFF/, '')
  if (result.status !== 0) {
    problem(`npm pack --dry-run failed (exit ${result.status}): ${(result.stderr || stdout || 'no output').trim().split('\n').slice(-5).join(' | ')}`)
    return { ok: false, command: commandLabel }
  }
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    problem(`cannot parse npm pack --json output: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, command: commandLabel }
  }
  const record = Array.isArray(parsed) ? parsed[0] : parsed
  if (!isPlainObject(record)) {
    problem('npm pack --json returned an unexpected shape')
    return { ok: false, command: commandLabel }
  }
  const entries = Array.isArray(record.files)
    ? record.files
        .filter((entry) => isPlainObject(entry) && typeof entry.path === 'string')
        .map((entry) => ({ path: entry.path.split(path.sep).join('/'), size: Number(entry.size) || 0 }))
    : []
  return {
    ok: true,
    command: commandLabel,
    filename: typeof record.filename === 'string' ? record.filename : '',
    size: Number(record.size) || 0,
    unpackedSize: Number(record.unpackedSize) || 0,
    entryCount: Number(record.entryCount) || entries.length,
    shasum: typeof record.shasum === 'string' ? record.shasum : '',
    integrity: typeof record.integrity === 'string' ? record.integrity : '',
    entries
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return 0
  }

  console.log('== dsh-tray-follower marketplace package builder ==')
  console.log(`repo:        ${ROOT}`)
  console.log(`source:      packages/${PACKAGE_NAME}`)
  console.log(`output:      ${relativeToRoot(OUT_PACKAGE_DIR)}`)
  console.log('')

  let result
  try {
    result = build(options)
  } catch (error) {
    problem(error instanceof Error ? error.message : String(error))
    result = { version: null, sourceVersion: null, hasClient: false, packageFiles: [], syntaxChecks: [], pack: null }
  }

  const ok = problems.length === 0
  const packageFiles = (result.packageFiles || [])
    .map((file) => path.relative(OUT_PACKAGE_DIR, file).split(path.sep).join('/'))
    .sort()
  const missingRequiredFiles = [
    ...REQUIRED_PACKAGE_FILES.filter((file) => !packageFiles.includes(file)),
    ...(result.hasClient && !packageFiles.includes('client.js') ? ['client.js'] : [])
  ]

  const report = {
    ok,
    package: PACKAGE_NAME,
    version: result.version,
    builtAt: new Date().toISOString(),
    packageDir: relativeToRoot(OUT_PACKAGE_DIR),
    source: {
      dir: relativeToRoot(PLUGIN_DIR),
      version: result.sourceVersion || null
    },
    clientHalf: result.hasClient === true,
    fileCount: packageFiles.length,
    files: packageFiles,
    checks: {
      missingRequiredFiles,
      libFiles: packageFiles.filter((file) => file.startsWith('lib/') && file.endsWith('.js')).length,
      syntax: result.syntaxChecks
    },
    pack: result.pack
      ? {
          command: result.pack.command,
          filename: result.pack.filename,
          size: result.pack.size,
          unpackedSize: result.pack.unpackedSize,
          entryCount: result.pack.entryCount,
          shasum: result.pack.shasum,
          integrity: result.pack.integrity,
          files: result.pack.entries.map((entry) => entry.path)
        }
      : { skipped: true },
    warnings,
    problems
  }

  ensureDir(DIST_DIR)
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  // --- console summary -------------------------------------------------------
  if (result.version) {
    console.log(`version:     ${result.version}${result.sourceVersion && result.sourceVersion !== result.version ? ` (source ${result.sourceVersion})` : ''}`)
  }
  console.log(`client half: ${result.hasClient ? 'present (client.js)' : 'absent (host + bridge only)'}`)
  console.log(`files:       ${packageFiles.length} copied`)
  if (result.pack && result.pack.ok) {
    console.log(
      `npm pack:    ${result.pack.filename} (tar ${formatBytes(result.pack.size)}, unpacked ${formatBytes(result.pack.unpackedSize)}, ${result.pack.entryCount} entries)`
    )
  } else if (options.skipPack) {
    console.log('npm pack:    skipped (--skip-pack)')
  }
  for (const check of result.syntaxChecks || []) {
    console.log(`node --check: ${check.file} ${check.ok ? 'OK' : 'FAILED'}`)
  }
  for (const warning of warnings) console.log(`WARN: ${warning}`)
  for (const issue of problems) console.log(`ERROR: ${issue}`)
  console.log('')
  console.log(`report:      ${relativeToRoot(REPORT_FILE)}`)
  if (ok) {
    console.log('BUILD OK')
    return 0
  }
  console.log(`BUILD FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})`)
  return 1
}

function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`
}

let exitCode = 1
try {
  exitCode = main()
} catch (error) {
  console.error(`FATAL: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  exitCode = 1
}
process.exitCode = exitCode
