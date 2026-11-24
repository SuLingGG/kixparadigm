'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SCRIPT = path.join(__dirname, 'patch-dsh-runtime.js')
const PKGS = ['dsh-compaction-basic', 'dsh-tool-subagent', 'dsh-agent-loop']

function sourceNodeModules() {
  const explicit = process.env.KIX_TEST_DSH_NODE_MODULES || process.env.KIX_DSH_NODE_MODULES
  if (explicit) return explicit
  const candidates = [
    path.join(os.homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules',
  ]
  return candidates.find((p) => fs.existsSync(path.join(p, '@deepseek-ai', 'dsh-compaction-basic', 'package.json')))
}

function copyFixture(src, dst) {
  fs.mkdirSync(path.join(dst, '@deepseek-ai'), { recursive: true })
  for (const pkg of PKGS) {
    fs.cpSync(path.join(src, '@deepseek-ai', pkg), path.join(dst, '@deepseek-ai', pkg), { recursive: true })
  }
}

function run(nm, ...args) {
  return spawnSync(process.execPath, [SCRIPT, '--node-modules', nm, ...args], { encoding: 'utf8' })
}

test('patch apply / check / revert cycle is idempotent', (t) => {
  const src = sourceNodeModules()
  if (!src) { t.skip('no installed 0.2.2 DSH runtime available'); return }
  let version = ''
  try { version = JSON.parse(fs.readFileSync(path.join(src, '@deepseek-ai', 'dsh-compaction-basic', 'package.json'), 'utf8')).version } catch { /* ignore */ }
  if (!version.startsWith('0.2.2')) { t.skip(`installed runtime is ${version || 'unknown'}, patch targets 0.2.2`); return }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-patch-'))
  try {
    copyFixture(src, tmp)
    // A fresh runtime must report missing hunks.
    const before = run(tmp, '--check')
    assert.equal(before.status, 1, 'fresh runtime reported as patched')
    const apply = run(tmp)
    assert.equal(apply.status, 0, apply.stderr)
    const after = run(tmp, '--check')
    assert.equal(after.status, 0, 'patched runtime failed check')
    const again = run(tmp)
    assert.equal(again.status, 0)
    const revert = run(tmp, '--revert')
    assert.equal(revert.status, 0)
    const reverted = run(tmp, '--check')
    assert.equal(reverted.status, 1, 'revert did not restore pristine files')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
