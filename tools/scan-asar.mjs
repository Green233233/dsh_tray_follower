#!/usr/bin/env node
// Scan an Electron app.asar header without unpacking it.
// Usage: node scan-asar.mjs <app.asar> [regex] [--limit N]
import fs from 'node:fs'

const [, , asarPath, patternArg, limitArg] = process.argv
if (!asarPath) {
  console.error('usage: node scan-asar.mjs <app.asar> [regex] [--limit N]')
  process.exit(2)
}
const pattern = patternArg && patternArg !== '-' ? new RegExp(patternArg) : null
const limit = limitArg ? Number(limitArg) : 200

const fd = fs.openSync(asarPath, 'r')
const headerSizeBuf = Buffer.alloc(16)
fs.readSync(fd, headerSizeBuf, 0, 16, 0)
// asar pickle: [uint32 4][uint32 headerPayloadLen][uint32 headerJsonLen][json bytes]
const jsonLen = headerSizeBuf.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
fs.closeSync(fd)
const header = JSON.parse(jsonBuf.toString('utf8'))

const files = []
function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (value.files) walk(value, path)
    else files.push({ path, size: value.size ?? 0, unpacked: Boolean(value.unpacked) })
  }
}
walk(header, '')

if (pattern) {
  const hits = files.filter(f => pattern.test(f.path))
  for (const f of hits.slice(0, limit)) console.log(`${f.path}\t${f.size}\t${f.unpacked ? 'unpacked' : ''}`)
  console.error(`# total files=${files.length} matches=${hits.length}`)
} else {
  for (const f of files.slice(0, limit)) console.log(`${f.path}\t${f.size}`)
  console.error(`# total files=${files.length}`)
}
