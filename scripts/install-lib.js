#!/usr/bin/env node
'use strict'
// kixparadigm-dsh installer — installs the DSH-side presets and mirrors into
// $DSH_HOME, registers preset declarations in the web profile, installs the
// vision bridge, and applies the small runtime compatibility patch that the
// 0.2.2 host needs (absolute compaction caps, kix-route sentinels, effort tiers).
//
// Usage:
//   kixparadigm install [--preset-only] [--no-runtime-patch]
//   kixparadigm uninstall [--revert-runtime]
//   kixparadigm doctor
//   kixparadigm runtime-patch [--check] [--revert]
//   kixparadigm detect-runtime

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const PKG_ROOT = path.join(__dirname, '..')
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'))
const CFG = PKG.kixparadigm || {}
const VARIANTS = (Array.isArray(CFG.variants) && CFG.variants.length
  ? CFG.variants
  : [{ id: 'kixparadigm', dir: 'dsh/preset' }, { id: 'kixparadigm-classic', dir: 'dsh/preset-classic' }]
).map((v) => ({ id: String(v.id), dir: String(v.dir) }))
const BRIDGE_DIR = CFG.bridgeDir || 'dsh/vision-bridge'
const BRIDGE_NAME = 'dsh-vision-bridge'
const PRESET_BEGIN = '# BEGIN kixparadigm-managed presets'
const PRESET_END = '# END kixparadigm-managed presets'
const LEGACY_BEGIN = '# BEGIN kix-presets'
const LEGACY_END = '# END kix-presets'
const PATCH_SCRIPT = path.join(__dirname, 'patch-dsh-runtime.js')

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
function profileDir() {
  return path.join(dshHome(), 'profiles', 'web')
}
function makeLog(quiet) {
  return {
    info(m) { if (!quiet) console.log(`  ${m}`) },
    ok(m) { if (!quiet) console.log(`  ✔ ${m}`) },
    warn(m) { console.log(`  ⚠ ${m}`) },
    step(m) { if (!quiet) console.log(`\n==> ${m}`) },
  }
}

/** Follow a directory symlink (or a git symlink text file) to its real tree. */
function linkedDir(p) {
  try {
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) {
      const rst = fs.statSync(p)
      return rst.isDirectory() ? p : null
    }
    if (st.isDirectory()) return p
    if (!st.isFile() || st.size > 256) return null
    const body = fs.readFileSync(p, 'utf8').trim()
    if (!body || /[\n\0]/.test(body) || path.isAbsolute(body)) return null
    const target = path.resolve(path.dirname(p), body)
    return fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : null
  } catch { return null }
}

function copyFileKeepingMtime(s, d) {
  fs.copyFileSync(s, d)
  try { const st = fs.statSync(s); fs.utimesSync(d, st.atime, st.mtime) } catch { /* best effort */ }
}

/** Mirror src into dst; follow shelf pointers; prune target-only files. */
function copyTree(src, dst, log, opts = {}) {
  const added = [], updated = [], same = [], targetOnly = [], pruned = []
  fs.mkdirSync(dst, { recursive: true })
  const walk = (from, to, isPointer) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, entry.name)
      const d = path.join(to, entry.name)
      const real = linkedDir(s)
      if (real) {
        fs.mkdirSync(d, { recursive: true })
        walk(real, d, true)
        if (isPointer || entry.isSymbolicLink()) pruneMirror(real, d)
      } else if (entry.isDirectory()) {
        fs.mkdirSync(d, { recursive: true })
        walk(s, d, false)
      } else {
        if (!fs.existsSync(d)) { copyFileKeepingMtime(s, d); added.push(path.relative(dst, d)) }
        else {
          const a = fs.statSync(s), b = fs.statSync(d)
          if (a.size === b.size && Math.round(a.mtimeMs / 1000) === Math.round(b.mtimeMs / 1000)) same.push(path.relative(dst, d))
          else { copyFileKeepingMtime(s, d); updated.push(path.relative(dst, d)) }
        }
      }
    }
  }
  const pruneMirror = (from, to) => {
    if (!fs.existsSync(to)) return
    for (const entry of fs.readdirSync(to, { withFileTypes: true })) {
      const t = path.join(to, entry.name)
      const s = path.join(from, entry.name)
      if (!fs.existsSync(s)) { fs.rmSync(t, { recursive: true, force: true }); pruned.push(path.relative(dst, t)) }
      else if (entry.isDirectory()) pruneMirror(s, t)
    }
  }
  walk(src, dst, false)
  // Report target-only files outside pointer trees (kept, not deleted).
  const walk2 = (from, rel) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name
      const srcP = path.join(src, r)
      if (entry.isDirectory()) { if (!fs.existsSync(srcP)) targetOnly.push(r + '/'); else walk2(path.join(from, entry.name), r) }
      else if (!fs.existsSync(srcP)) targetOnly.push(r)
    }
  }
  walk2(dst, '')
  return { added, updated, same, targetOnly, pruned }
}

function presetText(presetYml) {
  try {
    const raw = fs.readFileSync(presetYml, 'utf8')
    const get = (k) => {
      const m = raw.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))
      return m ? m[1].trim() : undefined
    }
    return { name: get('name'), description: get('description') }
  } catch { return {} }
}

function shq(value) { return JSON.stringify(String(value)) }

/** YAML for one preset declaration. */
function presetRow(id, dir, order, log) {
  const meta = presetText(path.join(dir, 'preset.yml'))
  const includePath = 'file://' + path.join(profileDir(), 'kix-presets', id, 'agent.cordis.yml').split(path.sep).join('/')
  const name = meta.name || id
  const description = meta.description || `${id} (kixparadigm)`
  return [
    '- insert:',
    `    - id: preset-${id}`,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    `        id: ${shq(id)}`,
    `        name: ${shq(name)}`,
    `        description: ${shq(description)}`,
    `        order: ${order}`,
    '        plugins:',
    `          - id: ${shq(id + '-body')}`,
    '            name: cordis:include',
    '            config:',
    `              path: ${shq(includePath)}`,
  ].join('\n')
}

/** Child presets shipped under a variant's children/ directory. */
function childRows(variantDir, log) {
  const dir = path.join(variantDir, 'children')
  if (!fs.existsSync(dir)) return []
  const order = { 'lite': 90, 'reviewer': 91, 'qa': 92, 'dev': 93 }
  const rows = []
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.cordis.yml')) continue
    const key = file.replace(/\.cordis\.yml$/, '')
    if (key === 'role-tools') continue
    const id = `kix-${key}`
    const includePath = 'file://' + path.join(profileDir(), 'kix-presets', 'kixparadigm', 'children', file).split(path.sep).join('/')
    rows.push([
      '- insert:',
      `    - id: preset-${id}`,
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      `        id: ${shq(id)}`,
      `        name: ${shq(id)}`,
      `        description: ${shq(`kix ${key} subagent preset`)}`,
      `        order: ${order[key] ?? 95}`,
      '        plugins:',
      `          - id: ${shq(id + '-body')}`,
      '            name: cordis:include',
      '            config:',
      `              path: ${shq(includePath)}`,
    ].join('\n'))
  }
  return rows
}

function managedBlock(log) {
  const rows = []
  let order = 10
  for (const v of VARIANTS) {
    rows.push(presetRow(v.id, path.join(PKG_ROOT, v.dir), order++, log))
  }
  const main = VARIANTS.find((v) => v.id === 'kixparadigm') || VARIANTS[0]
  rows.push(...childRows(path.join(PKG_ROOT, main.dir), log))
  return `${PRESET_BEGIN}\n# Managed by kixparadigm install. Do not edit inside this block.\n\n${rows.join('\n\n')}\n${PRESET_END}`
}

/** Is the document an empty YAML root (`[]` with only comments)? */
function isEmptyRoot(text) {
  const semantic = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  return semantic.length === 0 || (semantic.length === 1 && semantic[0] === '[]')
}

function replaceBlock(text, begin, end, block) {
  const re = new RegExp(`${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  if (re.test(text)) return text.replace(re, block)
  // Replace legacy block if present.
  const legacy = new RegExp(`${LEGACY_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${LEGACY_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  if (legacy.test(text)) return text.replace(legacy, block)
  if (isEmptyRoot(text)) {
    const prefix = text.replace(/^\s*\[\]\s*$/m, '').replace(/\s+$/, '')
    return `${prefix}\n\n${block}\n`
  }
  return `${text.replace(/\s+$/, '')}\n\n${block}\n`
}

function removeBlock(text, begin, end) {
  const re = new RegExp(`\\n?${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g')
  const out = text.replace(re, '\n')
  if (isEmptyRoot(out)) {
    const comments = out.replace(/\s+$/, '')
    return comments ? `${comments}\n\n[]\n` : '[]\n'
  }
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
}


/** npm pack drops the preset's shelf symlinks; materialize skills/agents from
 *  the classic copy so the default shelf still resolves its relative links. */
function ensureShelf(variant, dst, log) {
  if (variant.id !== 'kixparadigm') return
  const markers = { skills: path.join('handoff', 'SKILL.md'), agents: 'kixparadigm.agent.md' }
  for (const [dirName, marker] of Object.entries(markers)) {
    const classic = path.join(PKG_ROOT, 'dsh/preset-classic', dirName)
    const target = path.join(dst, dirName)
    if (!fs.existsSync(path.join(classic, marker))) continue
    if (fs.existsSync(path.join(target, marker)) && fs.statSync(path.join(target, marker)).isFile()) continue
    log.info(`materializing ${dirName}/ from preset-classic (packed install)`)
    copyTree(classic, target, log, { mirror: true })
  }
}

function installPresets(log) {
  const results = []
  for (const v of VARIANTS) {
    const src = path.join(PKG_ROOT, v.dir)
    const dst = path.join(dshHome(), '.agent-presets', v.id)
    if (!fs.existsSync(path.join(src, 'agent.cordis.yml'))) throw new Error(`preset source missing agent.cordis.yml: ${src}`)
    log.step(`install preset ${v.id} -> ${dst}`)
    const r = copyTree(src, dst, log)
    ensureShelf(v, dst, log)
    log.ok(`preset ${v.id}: added ${r.added.length} / updated ${r.updated.length} / same ${r.same.length}`)
    // Materialize a REAL copy inside the profiles tree. dsh-app-boot resolves an
    // included file's realpath and only paths under profiles/ get the host's
    // @deepseek-ai/* interception layer; a path under .agent-presets falls back
    // to bare Node resolution and can hit another DSH install.
    const profileCopy = path.join(profileDir(), 'kix-presets', v.id)
    if (fs.existsSync(profileDir())) {
      log.step(`materialize preset body into profiles tree ${v.id} -> ${profileCopy}`)
      const pr = copyTree(src, profileCopy, log)
      ensureShelf(v, profileCopy, log)
      log.ok(`profile body ${v.id}: added ${pr.added.length} / updated ${pr.updated.length} / same ${pr.same.length}`)
    } else {
      log.warn(`web profile missing; cannot materialize ${v.id} body (start dsh web once, then re-run install)`)
    }
    if (r.pruned.length) log.info(`pruned ${r.pruned.length} stale mirror file(s)`)
    results.push({ v, r })
  }
  return results
}

function installPresetDeclarations(log) {
  const profile = profileDir()
  if (!fs.existsSync(profile)) {
    log.warn(`web profile not found: ${profile}`)
    log.warn('start `dsh web` once to create the profile, then re-run `kixparadigm install`')
    return false
  }
  const patch = path.join(profile, 'cordis.patch.yml')
  const existed = fs.existsSync(patch)
  const current = existed ? fs.readFileSync(patch, 'utf8') : ''
  const next = replaceBlock(current, PRESET_BEGIN, PRESET_END, managedBlock(log))
  fs.mkdirSync(path.dirname(patch), { recursive: true })
  if (!existed || next !== current) fs.writeFileSync(patch, next, 'utf8')
  log.ok(`preset declarations registered in ${patch}`)
  return true
}

/** Merge the vision bridge insert into a patch-list document (legacy helper). */
function mergeVisionBridgePatch(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const block = [
    '# ── dsh-vision-bridge（无缝识图，由 kixparadigm 安装）──────────────',
    '- insert:',
    '    - id: dsh-vision-bridge',
    '      name: dsh-vision-bridge',
  ].join(newline)
  if (new RegExp(`^\\s*- id:\\s*${BRIDGE_NAME}\\s*$`, 'm').test(text)) return { text, changed: false }
  if (isEmptyRoot(text)) return { text: `${text.replace(/\s+$/, '')}${newline}${newline}${block}${newline}`, changed: true }
  return { text: `${text.replace(/\s+$/, '')}${newline}${newline}${block}${newline}`, changed: true }
}

function ensureLink(linkPath, targetPath, log) {
  const target = path.resolve(targetPath)
  try {
    const st = fs.lstatSync(linkPath)
    if (st.isSymbolicLink() && path.resolve(fs.readlinkSync(linkPath)) === target) { log.ok(`link ok: ${linkPath}`); return true }
    fs.rmSync(linkPath, { recursive: true, force: true })
  } catch { /* absent */ }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  log.ok(`linked ${linkPath} -> ${target}`)
  return true
}

function installVisionBridge(log) {
  const profile = profileDir()
  if (!fs.existsSync(profile)) { log.warn('web profile not found; skip vision-bridge'); return }
  const source = path.join(profile, 'plugins', BRIDGE_NAME)
  const junction = path.join(profile, 'node_modules', BRIDGE_NAME)
  const bridgeSource = path.join(PKG_ROOT, BRIDGE_DIR)
  const patch = path.join(profile, 'cordis.patch.yml')
  if (!fs.existsSync(bridgeSource)) { log.warn('vision-bridge source missing; skip'); return }
  log.step(`install vision-bridge -> ${source}`)
  copyTree(bridgeSource, source, log)
  ensureLink(junction, source, log)
  const current = fs.existsSync(patch) ? fs.readFileSync(patch, 'utf8') : ''
  const merged = mergeVisionBridgePatch(current)
  if (merged.changed) fs.writeFileSync(patch, merged.text, 'utf8')
  log.ok('vision-bridge registered')
}

function findDshNodeModules(log) {
  const candidates = []
  if (process.env.KIX_DSH_NODE_MODULES) candidates.push(process.env.KIX_DSH_NODE_MODULES)
  if (process.env.DSH_NODE_MODULES) candidates.push(process.env.DSH_NODE_MODULES)
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
  candidates.push(path.join(os.homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules')
  candidates.push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules')
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(path.join(c, '@deepseek-ai', 'dsh-compaction-basic', 'package.json'))) return c
    } catch { /* ignore */ }
  }
  return undefined
}

function runRuntimePatch(log, opts = {}) {
  const nm = opts.nodeModules || findDshNodeModules(log)
  if (!nm) {
    log.warn('cannot locate the installed DSH runtime; set KIX_DSH_NODE_MODULES=<...>/@deepseek-ai/dsh/node_modules')
    log.warn('without the runtime patch the preset mounts as broken (absolute compaction keys)')
    return false
  }
  log.step(`runtime patch -> ${nm}`)
  const args = [PATCH_SCRIPT]
  if (opts.check) args.push('--check')
  if (opts.revert) args.push('--revert')
  args.push('--node-modules', nm)
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' })
  return r.status === 0
}

function reportSettings(log) {
  const home = dshHome()
  log.step('provider settings check')
  const imported = path.join(home, 'settings.yaml.imported')
  const settings = path.join(home, 'settings.yaml')
  if (fs.existsSync(imported)) log.ok('settings.yaml was imported by DSH 0.2.x; edit the web profile cordis.patch.yml (or the GUI)')
  else if (fs.existsSync(settings)) log.ok('settings.yaml present (legacy layout)')
  else log.warn('no settings.yaml found; configure an LLM provider in the GUI before creating a session')
}

function install(log, opts = {}) {
  installPresets(log)
  const profileReady = installPresetDeclarations(log)
  if (!opts.presetOnly) installVisionBridge(log)
  if (profileReady && !opts.noRuntimePatch) runRuntimePatch(log)
  reportSettings(log)
  log.step('done. Restart dsh web, then pick kixparadigm in the preset picker and create a session.')
}

function uninstall(log, opts = {}) {
  log.step('uninstall kixparadigm presets')
  for (const v of VARIANTS) {
    const dir = path.join(dshHome(), '.agent-presets', v.id)
    if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); log.ok(`removed ${dir}`) }
    else log.info(`absent: ${dir}`)
  }
  const children = path.join(dshHome(), '.agent-presets', 'kixparadigm', 'children')
  if (fs.existsSync(children)) fs.rmSync(children, { recursive: true, force: true })
  const profileCopies = path.join(profileDir(), 'kix-presets')
  if (fs.existsSync(profileCopies)) { fs.rmSync(profileCopies, { recursive: true, force: true }); log.ok(`removed ${profileCopies}`) }
  const patch = path.join(profileDir(), 'cordis.patch.yml')
  if (fs.existsSync(patch)) {
    fs.writeFileSync(patch, removeBlock(fs.readFileSync(patch, 'utf8'), PRESET_BEGIN, PRESET_END), 'utf8')
    log.ok('removed managed preset declarations')
    // Vision bridge is shared by variants; only remove when no preset remains.
    if (!fs.existsSync(path.join(dshHome(), '.agent-presets', 'kixparadigm', 'agent.cordis.yml'))) {
      const source = path.join(profileDir(), 'plugins', BRIDGE_NAME)
      const link = path.join(profileDir(), 'node_modules', BRIDGE_NAME)
      fs.rmSync(source, { recursive: true, force: true })
      try { fs.unlinkSync(link) } catch { /* absent */ }
      const text = fs.readFileSync(patch, 'utf8')
      fs.writeFileSync(patch, text.replace(/\n?# ── dsh-vision-bridge[\s\S]*?- id: dsh-vision-bridge\n\s*-?\s*name: dsh-vision-bridge\n?/g, '\n'), 'utf8')
    }
  }
  if (opts.revertRuntime) runRuntimePatch(log, { revert: true })
  log.ok('uninstall complete. Restart dsh web.')
}

function doctor(log) {
  const home = dshHome()
  log.step(`doctor — DSH_HOME = ${home}`)
  let ok = true
  for (const v of VARIANTS) {
    if (fs.existsSync(path.join(home, '.agent-presets', v.id, 'agent.cordis.yml'))) log.ok(`preset ${v.id} installed`)
    else { log.warn(`preset ${v.id} missing`); ok = false }
    if (fs.existsSync(path.join(home, 'profiles', 'web', 'kix-presets', v.id, 'agent.cordis.yml'))) log.ok(`profile body ${v.id} materialized`)
    else { log.warn(`profile body ${v.id} missing (re-run install)`); ok = false }
  }
  const patch = path.join(profileDir(), 'cordis.patch.yml')
  if (fs.existsSync(patch) && fs.readFileSync(patch, 'utf8').includes(PRESET_BEGIN)) log.ok('profile preset declarations present')
  else { log.warn('profile preset declarations missing (re-run install)'); ok = false }
  const nm = findDshNodeModules(log)
  if (!nm) { log.warn('DSH runtime not found; cannot verify runtime patch'); ok = false }
  else {
    const r = spawnSync(process.execPath, [PATCH_SCRIPT, '--check', '--node-modules', nm], { stdio: 'inherit' })
    if (r.status === 0) log.ok('runtime patch applied')
    else { log.warn('runtime patch missing (re-run install)'); ok = false }
  }
  return ok
}

function cli(argv) {
  const args = argv || []
  const quiet = args.includes('--quiet') || args.includes('-q')
  const log = makeLog(quiet)
  if (args.includes('--version') || args.includes('-v') || args.includes('version')) { console.log(PKG.version); return }
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    console.log(`kixparadigm (DSH-only) ${PKG.version}
usage:
  kixparadigm install [--preset-only] [--no-runtime-patch]
  kixparadigm uninstall [--revert-runtime]
  kixparadigm doctor
  kixparadigm runtime-patch [--check] [--revert]
  kixparadigm detect-runtime
target: $DSH_HOME (default ~/.dsh)`)
    return
  }
  const cmd = args.find((a) => !a.startsWith('-')) || 'install'
  try {
    switch (cmd) {
      case 'install': install(log, { presetOnly: args.includes('--preset-only'), noRuntimePatch: args.includes('--no-runtime-patch') }); break
      case 'uninstall': uninstall(log, { revertRuntime: args.includes('--revert-runtime') }); break
      case 'doctor': process.exitCode = doctor(log) ? 0 : 1; break
      case 'runtime-patch': {
        const ok2 = runRuntimePatch(log, { check: args.includes('--check'), revert: args.includes('--revert') })
        process.exitCode = ok2 ? 0 : 1
        break
      }
      case 'detect-runtime': console.log(findDshNodeModules(log) || ''); break
      default: log.warn(`unknown command: ${cmd} (see --help)`); process.exitCode = 1
    }
  } catch (e) {
    log.warn(`failed: ${e.message}`)
    if (process.env.KIX_DEBUG) console.error(e)
    process.exitCode = 1
  }
}

if (require.main === module) cli(process.argv.slice(2))
module.exports = { cli, dshHome, profileDir, copyTree, findDshNodeModules, mergeVisionBridgePatch, replaceBlock, removeBlock, managedBlock, PRESET_BEGIN, PRESET_END }
