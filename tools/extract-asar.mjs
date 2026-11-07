#!/usr/bin/env node
// Extract selected files out of an Electron app.asar archive (read-only).
// Usage: node extract-asar.mjs <app.asar> <outDir> <regex> [<regex>...]
import fs from 'node:fs'
import path from 'node:path'

const [, , asarPath, outDir, ...patterns] = process.argv
if (!asarPath || !outDir || patterns.length === 0) {
  console.error('usage: node extract-asar.mjs <app.asar> <outDir> <regex>...')
  process.exit(2)
}
const regexes = patterns.map(p => new RegExp(p))

const fd = fs.openSync(asarPath, 'r')
const sizeBuf = Buffer.alloc(16)
fs.readSync(fd, sizeBuf, 0, 16, 0)
const headerSize = sizeBuf.readUInt32LE(4)
const jsonSize = sizeBuf.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonSize)
fs.readSync(fd, jsonBuf, 0, jsonSize, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const dataOffset = 8 + headerSize

const entries = []
function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (value.files) walk(value, p)
    else entries.push({ path: p, size: value.size ?? 0, offset: value.offset ?? 0, unpacked: Boolean(value.unpacked) })
  }
}
walk(header, '')

let written = 0
for (const entry of entries) {
  if (!regexes.some(r => r.test(entry.path))) continue
  if (entry.unpacked) continue
  const dest = path.join(outDir, ...entry.path.split('/'))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset))
  fs.writeFileSync(dest, buf)
  written++
}
fs.closeSync(fd)
console.error(`# extracted ${written} files to ${outDir}`)
