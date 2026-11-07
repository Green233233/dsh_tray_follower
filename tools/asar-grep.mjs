#!/usr/bin/env node
// Search file contents inside an Electron app.asar without extracting it.
// Usage: node asar-grep.mjs <app.asar> <path-regex> <content-regex> [--limit N] [--context-chars N]
import fs from 'node:fs'

const [, , asarPath, pathPattern, contentPattern, ...rest] = process.argv
if (!asarPath || !pathPattern || !contentPattern) {
  console.error('usage: node asar-grep.mjs <app.asar> <path-regex> <content-regex> [--limit N] [--context-chars N]')
  process.exit(2)
}
const argOf = (name, fallback) => {
  const index = rest.indexOf(name)
  return index >= 0 ? Number(rest[index + 1]) : fallback
}
const limit = argOf('--limit', 100)
const ctx = argOf('--context-chars', 160)
const pathRe = new RegExp(pathPattern)
const contentRe = new RegExp(contentPattern, 'g')

const fd = fs.openSync(asarPath, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(4)
const jsonSize = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonSize)
fs.readSync(fd, jsonBuf, 0, jsonSize, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const dataOffset = 8 + headerSize

const entries = []
const walk = (node, prefix) => {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (value.files) walk(value, p)
    else entries.push({ path: p, size: value.size ?? 0, offset: Number(value.offset ?? 0), unpacked: Boolean(value.unpacked) })
  }
}
walk(header, '')

let hits = 0
for (const entry of entries) {
  if (!pathRe.test(entry.path)) continue
  if (entry.unpacked || entry.size === 0 || entry.size > 8 * 1024 * 1024) continue
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, dataOffset + entry.offset)
  const text = buf.toString('utf8')
  contentRe.lastIndex = 0
  let match
  let filePrinted = false
  while ((match = contentRe.exec(text)) !== null) {
    hits++
    const start = Math.max(0, match.index - ctx)
    const end = Math.min(text.length, match.index + match[0].length + ctx)
    const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim()
    if (!filePrinted) { console.log(`\n### ${entry.path}`); filePrinted = true }
    console.log(`  @${match.index}: ${snippet}`)
    if (hits >= limit) { console.error(`# stopped at limit ${limit}`); fs.closeSync(fd); process.exit(0) }
  }
}
console.error(`# hits=${hits}`)
fs.closeSync(fd)
