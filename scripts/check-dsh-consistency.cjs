#!/usr/bin/env node
'use strict'
// DSH-only consistency gate: syntax, persona budget, shelf pointers, and the
// byte-identity groups that the runtime plugins rely on.
const fs = require('node:fs')
const path = require('node:path')
const lib = require(path.join(__dirname, '..', 'dsh', 'preset', 'plugins', 'consistency-lib.cjs'))

const root = path.resolve(__dirname, '..')
const failures = []
const notes = []
const add = (r) => { failures.push(...(r.failures || [])); notes.push(...(r.notes || [])) }

for (const rel of ['dsh/preset', 'dsh/preset-classic', 'dsh/preset-null']) {
  add(lib.checkSyntax({ root, rel: `${rel}/plugins`, label: `${rel}/plugins` }))
}
for (const [rel, maxChars] of [['dsh/preset/agent.cordis.yml', 4500], ['dsh/preset-classic/agent.cordis.yml', 4500]]) {
  add(lib.checkPersonaBudget({ root, rel, maxChars, maxEstTokens: 2600 }))
}
add(lib.checkDefaultShelfPointers({ root }))
for (const f of fs.readdirSync(path.join(root, 'dsh/preset/plugins'))) {
  if (!/^kix-.*\.js$/.test(f) || /\.test\.js$/.test(f)) continue
  add(lib.checkPluginPair({ root, name: f }))
}

for (const n of notes) console.log(`  · ${n}`)
if (failures.length) {
  console.log(`\nCONSISTENCY FAIL (${failures.length})`)
  for (const f of failures) console.log(`  ✖ ${f}`)
  process.exitCode = 1
} else {
  console.log('\nCONSISTENCY PASS')
}
