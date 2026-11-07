#!/usr/bin/env node
// 工程自检：语法检查 + 单元测试 + 清单元数据检查。
// 用法: node tools/check.mjs
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IGNORE_DIRS = new Set(['node_modules', '.git', 'extracted', 'dist', 'build', '.dsh-market'])
const SCAN_DIRS = ['packages', 'bridge', 'tools']
const failures = []
let checked = 0

function walk(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walk(full, out)
    } else out.push(full)
  }
  return out
}

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  if (result.status !== 0) {
    failures.push({ label, stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status })
    console.log(`FAIL ${label}`)
    if (result.stdout) console.log(indent(result.stdout))
    if (result.stderr) console.log(indent(result.stderr))
  } else {
    console.log(`ok   ${label}`)
  }
  return result.status === 0
}

const indent = (text) => String(text).trimEnd().split('\n').map((line) => '  ' + line).join('\n')

// 1. syntax check every JS module we own
const jsFiles = SCAN_DIRS.flatMap((dir) => walk(path.join(root, dir))).filter((file) => /\.(?:js|mjs|cjs)$/.test(file))
for (const file of jsFiles) {
  checked++
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failures.push({ label: `node --check ${path.relative(root, file)}`, stderr: result.stderr })
    console.log(`FAIL node --check ${path.relative(root, file)}`)
    console.log(indent(result.stderr))
  }
}
if (failures.length === 0) console.log(`ok   node --check (${checked} files)`)

// 2. JSON manifests parse + required bundle fields
for (const manifest of ['packages/dsh-tray-follower/package.json', 'bridge/shell-hook/package.json']) {
  const file = path.join(root, manifest)
  if (!fs.existsSync(file)) continue
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!json.name) throw new Error('missing name')
    if (!json.version) throw new Error('missing version')
    console.log(`ok   manifest ${manifest}`)
  } catch (error) {
    failures.push({ label: `manifest ${manifest}`, stderr: String(error) })
    console.log(`FAIL manifest ${manifest}: ${error}`)
  }
}

// 3. plugin unit tests (node --test; positional glob, directories are not discovered by Node 24)
const pluginTests = path.join(root, 'packages/dsh-tray-follower')
if (fs.existsSync(path.join(pluginTests, 'test'))) {
  run('node --test packages/dsh-tray-follower/test/*.test.mjs', process.execPath, ['--test', 'packages/dsh-tray-follower/test/*.test.mjs'])
}

// 4. bridge self-test
if (fs.existsSync(path.join(root, 'tools', 'bridge-selftest.mjs'))) {
  run('node tools/bridge-selftest.mjs', process.execPath, ['tools/bridge-selftest.mjs'])
}

// 5. design contract lint: state contract documented and required keys present in DESIGN.md
const design = fs.readFileSync(path.join(root, 'docs', 'DESIGN.md'), 'utf8')
for (const key of ['schemaVersion', 'workspaces', 'unreadEvents', 'updatedAt']) {
  if (!design.includes(key)) {
    failures.push({ label: `contract key ${key} missing from docs/DESIGN.md`, stderr: '' })
    console.log(`FAIL contract key ${key} missing from docs/DESIGN.md`)
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
