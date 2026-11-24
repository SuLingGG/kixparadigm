'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const lib = require('./install-lib.js')

test('managed preset block replaces an empty YAML root', () => {
  const block = `${lib.PRESET_BEGIN}\n- insert:\n    - id: preset-x\n${lib.PRESET_END}`
  const out = lib.replaceBlock('# comment\n[]\n', lib.PRESET_BEGIN, lib.PRESET_END, block)
  assert.ok(!/^\[\]$/m.test(out), 'empty root must be removed')
  assert.ok(out.includes('- id: preset-x'))
  const again = lib.replaceBlock(out, lib.PRESET_BEGIN, lib.PRESET_END, block)
  assert.equal(again, out, 'block replacement is idempotent')
})

test('managed block removal restores an empty patch root', () => {
  const block = `${lib.PRESET_BEGIN}\n- insert:\n    - id: preset-x\n${lib.PRESET_END}`
  const withBlock = lib.replaceBlock('# comment\n[]\n', lib.PRESET_BEGIN, lib.PRESET_END, block)
  const out = lib.removeBlock(withBlock, lib.PRESET_BEGIN, lib.PRESET_END)
  assert.ok(out.includes('[]'))
  assert.ok(!out.includes(lib.PRESET_BEGIN))
})

test('vision-bridge merge is valid and idempotent', () => {
  const first = lib.mergeVisionBridgePatch('[]\n')
  assert.equal(first.changed, true)
  assert.ok(first.text.includes('- id: dsh-vision-bridge'))
  const second = lib.mergeVisionBridgePatch(first.text)
  assert.equal(second.changed, false)
  assert.equal(second.text, first.text)
})

test('copyTree follows a directory pointer and prunes stale mirror files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-copy-'))
  const src = path.join(tmp, 'src')
  const classic = path.join(tmp, 'classic')
  const dst = path.join(tmp, 'dst')
  fs.mkdirSync(path.join(src, 'plugins'), { recursive: true })
  fs.mkdirSync(path.join(classic, 'skills'), { recursive: true })
  fs.writeFileSync(path.join(src, 'plugins', 'a.js'), 'a')
  fs.writeFileSync(path.join(classic, 'skills', 'keep.md'), 'k')
  fs.symlinkSync(path.join('..', 'classic', 'skills'), path.join(src, 'skills'))
  lib.copyTree(src, dst)
  assert.ok(fs.existsSync(path.join(dst, 'skills', 'keep.md')))
  fs.rmSync(path.join(classic, 'skills', 'keep.md'))
  fs.writeFileSync(path.join(classic, 'skills', 'new.md'), 'n')
  lib.copyTree(src, dst)
  assert.ok(!fs.existsSync(path.join(dst, 'skills', 'keep.md')), 'stale pointer content pruned')
  assert.ok(fs.existsSync(path.join(dst, 'skills', 'new.md')))
})
