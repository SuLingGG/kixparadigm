#!/usr/bin/env node
'use strict'
// Re-apply the kixparadigm compatibility patch to an installed DSH 0.2.2 runtime.
//
// Why this exists
// ---------------
// 1. DSH 0.2.2's compaction schema removed the absolute `maxThresholdTokens` /
//    `maxRetainTokens` fields. kixparadigm's context budget is an absolute cap
//    (T = min(512K, 0.8·W), R = min(64K, 0.044·W)), which cannot be expressed by
//    the new ratio-only schema for arbitrary windows. The hunks below restore the
//    two fields and apply them when the concrete token budgets are resolved.
// 2. `@deepseek-ai/dsh-tool-subagent` preflights a configured `agentOptions.model`
//    against the live adapter catalog. kix-route tier values (`kix-route:cross`)
//    are virtual routes resolved in `agent/created`; they must bypass preflight.
// 3. `dsh-agent-loop` rejects a reasoning-effort change proposed in
//    `agent/request`. kix-cost adapts effort by complexity at request time, which
//    is exactly what that hook is for; 0.2.2's guard turned it into a hard error.
//
// Run after every DSH upgrade:
//   node scripts/patch-dsh-runtime.js --check
//   node scripts/patch-dsh-runtime.js
//   node scripts/patch-dsh-runtime.js --revert
//
// The patch is idempotent and leaves a `.kix-backup` beside every touched file.

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function parseArgs(argv) {
  const out = { check: false, revert: false, nodeModules: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') out.check = true
    else if (a === '--revert') out.revert = true
    else if (a === '--node-modules') out.nodeModules = argv[++i]
  }
  return out
}

function findNodeModules() {
  if (process.env.KIX_DSH_NODE_MODULES) return process.env.KIX_DSH_NODE_MODULES
  const candidates = []
  try {
    const which = spawnSync('which', ['dsh'], { encoding: 'utf8' })
    if (which.status === 0) {
      const bin = fs.realpathSync(which.stdout.trim())
      candidates.push(path.join(path.dirname(path.dirname(bin)), 'node_modules'))
    }
  } catch { /* ignore */ }
  try {
    const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' })
    if (root.status === 0) candidates.push(path.join(root.stdout.trim(), '@deepseek-ai', 'dsh', 'node_modules'))
  } catch { /* ignore */ }
  candidates.push(path.join(require('node:os').homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules')
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, '@deepseek-ai', 'dsh-compaction-basic', 'package.json'))) return c
  }
  return undefined
}

const C = 'dsh-compaction-basic/lib/index.js'
const S = 'dsh-tool-subagent/lib/index.js'
const A = 'dsh-agent-loop/lib/index.js'

const HUNKS = [
  {
    id: 'compaction-config-keys',
    pkg: 'dsh-compaction-basic',
    file: 'lib/index.js',
    marker: '"maxThresholdTokens",',
    find: 'const POLICY_CONFIG_KEYS = [\n\t"thresholdRatio",\n\t"headroomTokens",\n\t"retainRatio",\n\t"retainTokens",',
    replace: 'const POLICY_CONFIG_KEYS = [\n\t"thresholdRatio",\n\t"headroomTokens",\n\t"retainRatio",\n\t"retainTokens",\n\t"maxThresholdTokens",\n\t"maxRetainTokens",',
  },
  {
    id: 'compaction-resolved-defaults',
    pkg: 'dsh-compaction-basic',
    file: 'lib/index.js',
    marker: 'maxThresholdTokens: config.maxThresholdTokens',
    find: '\treturn deepFreeze({\n\t\tthresholdRatio,\n\t\theadroomTokens,\n\t\t...retention,',
    replace: '\treturn deepFreeze({\n\t\tthresholdRatio,\n\t\theadroomTokens,\n\t\t...retention,\n\t\tmaxThresholdTokens: config.maxThresholdTokens,\n\t\tmaxRetainTokens: config.maxRetainTokens,',
  },
  {
    id: 'compaction-target-policy',
    pkg: 'dsh-compaction-basic',
    file: 'lib/index.js',
    marker: 'maxThresholdTokens: override?.maxThresholdTokens',
    find: '\t\tthresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,\n\t\theadroomTokens: override?.headroomTokens ?? config.headroomTokens,\n\t\t...resolveRetention(override ?? {}, inheritedRetention),',
    replace: '\t\tthresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,\n\t\theadroomTokens: override?.headroomTokens ?? config.headroomTokens,\n\t\tmaxThresholdTokens: override?.maxThresholdTokens ?? config.maxThresholdTokens,\n\t\tmaxRetainTokens: override?.maxRetainTokens ?? config.maxRetainTokens,\n\t\t...resolveRetention(override ?? {}, inheritedRetention),',
  },
  {
    id: 'compaction-resolve-spec',
    pkg: 'dsh-compaction-basic',
    file: 'lib/index.js',
    marker: 'policy.maxThresholdTokens ?? Number.POSITIVE_INFINITY',
    find: '\tconst thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens));\n\tconst retainTokens = policy.retainTokens === void 0 ? Math.floor(messageBudgetTokens * policy.retainRatio) : policy.retainTokens;',
    replace: '\tconst thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens, policy.maxThresholdTokens ?? Number.POSITIVE_INFINITY));\n\tconst rawRetainTokens = policy.retainTokens === void 0 ? Math.floor(messageBudgetTokens * policy.retainRatio) : policy.retainTokens;\n\tconst retainTokens = Math.min(rawRetainTokens, policy.maxRetainTokens ?? Number.POSITIVE_INFINITY);',
  },
  {
    id: 'compaction-validate-caps',
    pkg: 'dsh-compaction-basic',
    file: 'lib/index.js',
    marker: 'assertPositiveInteger(`${name}.maxThresholdTokens`',
    find: '\tif (retainRatio !== void 0) assertRatio(`${name}.retainRatio`, retainRatio);\n\tif (retainTokens !== void 0) assertNonNegativeInteger(`${name}.retainTokens`, retainTokens);',
    replace: '\tif (retainRatio !== void 0) assertRatio(`${name}.retainRatio`, retainRatio);\n\tif (retainTokens !== void 0) assertNonNegativeInteger(`${name}.retainTokens`, retainTokens);\n\tif (config.maxThresholdTokens !== void 0) assertPositiveInteger(`${name}.maxThresholdTokens`, config.maxThresholdTokens);\n\tif (config.maxRetainTokens !== void 0) assertPositiveInteger(`${name}.maxRetainTokens`, config.maxRetainTokens);',
  },
  {
    id: 'subagent-sentinel-preflight',
    pkg: 'dsh-tool-subagent',
    file: 'lib/index.js',
    marker: 'startsWith("kix-route:")',
    find: '\tconst model = requested?.model ?? parentOptions.model;\n\tif (provider === void 0 || model === void 0) throw new Error("cannot select child LLM values without an effective provider and model");',
    replace: '\tconst model = requested?.model ?? parentOptions.model;\n\tif (provider === void 0 || model === void 0) throw new Error("cannot select child LLM values without an effective provider and model");\n\t// kix-route tier sentinels are virtual routes resolved in agent/created;\n\t// adapter preflight cannot know them.\n\tif (typeof model === "string" && model.startsWith("kix-route:")) return;',
  },
  {
    id: 'agent-loop-effort-adaptation',
    pkg: 'dsh-agent-loop',
    file: 'lib/index.js',
    marker: 'kix-cost adapts reasoning effort',
    find: '\t\tif (proposedConfig.reasoningEffort !== selection.reasoningEffort) throw new Error(`agent "${this.id}": agent/request proposed reasoning effort "${proposedConfig.reasoningEffort ?? "adapter default"}" after step preparation fixed "${selection.reasoningEffort ?? "adapter default"}"; use agent.model.select() before step preparation`);',
    replace: '\t\t// kix-cost adapts reasoning effort at request time (complexity-aware tiers).',
  },
]

function pkgFile(nm, hunk) {
  return path.join(nm, '@deepseek-ai', hunk.pkg, hunk.file)
}

function backupPath(file) { return file + '.kix-backup' }

function apply(nm, check) {
  const results = []
  for (const hunk of HUNKS) {
    const file = pkgFile(nm, hunk)
    if (!fs.existsSync(file)) { results.push({ hunk, state: 'missing-package', file }); continue }
    const text = fs.readFileSync(file, 'utf8')
    if (text.includes(hunk.marker)) { results.push({ hunk, state: 'patched', file }); continue }
    if (!text.includes(hunk.find)) { results.push({ hunk, state: 'anchor-missing', file }); continue }
    results.push({ hunk, state: 'needs-patch', file })
  }
  if (check) {
    const bad = results.filter((r) => r.state !== 'patched')
    for (const r of results) {
      if (r.state === 'patched') console.log(`  ✔ ${r.hunk.id}`)
      else console.log(`  ✖ ${r.hunk.id} (${r.state})`)
    }
    return bad.length === 0 ? 0 : 1
  }
  const pending = results.filter((r) => r.state === 'needs-patch')
  if (!pending.length) { console.log('runtime already patched'); return 0 }
  const createdBackups = []
  const applied = []
  try {
    for (const r of pending) {
      const text = fs.readFileSync(r.file, 'utf8')
      if (!fs.existsSync(backupPath(r.file))) { fs.copyFileSync(r.file, backupPath(r.file)); createdBackups.push(backupPath(r.file)) }
      const next = text.replace(r.hunk.find, r.hunk.replace)
      if (next === text) throw new Error(`replacement did not change ${r.file}`)
      fs.writeFileSync(r.file, next)
      applied.push(r)
      console.log(`  ✔ ${r.hunk.id}`)
    }
  } catch (e) {
    for (const r of applied) {
      const bak = backupPath(r.file)
      if (fs.existsSync(bak)) fs.copyFileSync(bak, r.file)
    }
    console.error(`runtime patch failed and was rolled back: ${e.message}`)
    return 2
  }
  {
    const manifest = { version: 1, patchedAt: new Date().toISOString(), hunks: pending.map((r) => r.hunk.id) }
    fs.writeFileSync(path.join(nm, '.kix-paradigm-runtime-patch.json'), JSON.stringify(manifest, null, 2))
  }
  console.log(`patched ${pending.length} hunk(s) under ${nm}`)
  return 0
}

function revert(nm) {
  let restored = 0
  for (const hunk of HUNKS) {
    const file = pkgFile(nm, hunk)
    const bak = backupPath(file)
    if (fs.existsSync(bak)) { fs.copyFileSync(bak, file); fs.rmSync(bak); restored++ }
  }
  const manifest = path.join(nm, '.kix-paradigm-runtime-patch.json')
  if (fs.existsSync(manifest)) fs.rmSync(manifest)
  console.log(restored ? `restored ${restored} file(s)` : 'no backups found; nothing reverted')
  return 0
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const nm = opts.nodeModules || findNodeModules()
  if (!nm) {
    console.error('cannot locate the DSH runtime; pass --node-modules <...>/@deepseek-ai/dsh/node_modules')
    return 2
  }
  const pkg = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(nm, '@deepseek-ai', name, 'package.json'), 'utf8')).version } catch { return '?' }
  }
  console.log(`DSH runtime: ${nm}`)
  console.log(`versions: compaction ${pkg('dsh-compaction-basic')}, subagent ${pkg('dsh-tool-subagent')}, agent-loop ${pkg('dsh-agent-loop')}`)
  return opts.revert ? revert(nm) : apply(nm, opts.check)
}

process.exitCode = main()
