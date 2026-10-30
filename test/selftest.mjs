/**
 * Offline self-test for dsh-nix-dev-shell.
 *
 * It drives the plugin's decorator with a fake shell executor, so it never
 * invokes nix and never touches a live harness. Run with:
 *
 *   node test/selftest.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const TERM_OK = 'ok'

/** Build a NUL-separated env dump like `env -0`. */
function envDump(entries) {
  return `${entries.map(([key, value]) => `${key}=${value}`).join('\0')}\0`
}

/**
 * Create a fake shell executor that records every call. Capture helpers are
 * answered from `state.envDump`; every other call is only recorded.
 */
function makeShell(state) {
  const execute = async function execute(spec) {
    if (String(spec?.command ?? '').includes('print-dev-env')) {
      state.captureSpecs.push(spec)
      state.captures += 1
      if (state.failCapture) throw new Error('fake nix failure')
      return {
        result: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: state.envDump, truncated: false },
          stderr: { text: '', truncated: false },
        }),
      }
    }
    state.executed.push(spec)
    return { ok: true, spec }
  }
  return execute
}

/** Create a plugin context whose `shell` is the fake executor. */
function makeContext(state) {
  const executor = makeShell(state)
  const disposers = []
  const contexts = []
  const ctx = {
    logger: { warn() {} },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    inject(_names, callback) {
      callback({
        systemPrompt: {
          context(entry) {
            contexts.push(entry)
            return () => {}
          },
        },
      })
    },
  }
  ctx.shell = { execute: executor }
  return { ctx, executor, contexts, disposeAll: () => disposers.forEach((dispose) => dispose()) }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-nix-dev-shell-selftest-'))
const flakeDir = join(root, 'project')
const workdir = join(flakeDir, 'src', 'nested')
mkdirSync(join(flakeDir, 'src'), { recursive: true })
writeFileSync(join(flakeDir, 'flake.nix'), '{ outputs = { self }: {}; }\n')
const plainDir = join(root, 'plain')
mkdirSync(plainDir, { recursive: true })

const binDir = join(root, 'bin')
mkdirSync(binDir)
const shimNix = join(binDir, 'nix')
writeFileSync(shimNix, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@"\n')
chmodSync(shimNix, 0o755)

process.env.SAME_KEEP = 'baseline'
process.env.CHANGED_VAR = 'host'
const dump = envDump([
  ['SAME_KEEP', 'baseline'],
  ['CHANGED_VAR', 'dev'],
  ['NEW_VAR', 'hello'],
  ['TERM', 'xterm-256color'],
  ['NO_COLOR', ''],
  ['SHELL', '/nix/store/xxx-bash/bin/bash'],
  ['TMPDIR', '/build'],
  ['NIX_BUILD_TOP', '/build'],
  ['XDG_CACHE_HOME', '/tmp/ignored'],
  ['NIX_CACHE_HOME', '/tmp/ignored'],
  ['PWD', '/build'],
  ['SHLVL', '7'],
  ['DSH_PROFILE', 'web'],
  ['npm_config_registry', 'https://example.invalid'],
  ['OCAMLPATH', '/nix/store/x/site-lib'],
])

/** A resolved foreground spec, as the tool layer would pass it. */
function spec(overrides = {}) {
  return {
    command: 'echo hi',
    workdir,
    timeoutMs: 60000,
    onExpiry: 'kill',
    stdoutMaxBytes: 64000,
    sandboxPolicy: { mode: 'workspace-write', workspaceRoot: root },
    ...overrides,
  }
}

const results = []
function test(name, fn) {
  try {
    fn()
    results.push(['ok', name])
  } catch (error) {
    results.push(['fail', `${name}: ${error?.stack ?? error}`])
  }
}
async function testAsync(name, fn) {
  try {
    await fn()
    results.push(['ok', name])
  } catch (error) {
    results.push(['fail', `${name}: ${error?.stack ?? error}`])
  }
}

// 1. env mode: overlay diff, deny-list, and merge order.
await testAsync('env mode injects the captured overlay only', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, disposeAll } = makeContext(state)
  apply(ctx, {})
  const result = await ctx.shell.execute(spec({ env: { CHANGED_VAR: 'caller' } }))
  const applied = result.spec
  assert.equal(state.captures, 1)
  assert.equal(applied.env.NEW_VAR, 'hello')
  assert.match(applied.env.NIX_CACHE_HOME, /dsh-nix-dev-shell/, 'nix cache home is injected by the plugin')
  assert.equal(applied.env.OCAMLPATH, '/nix/store/x/site-lib')
  assert.equal(applied.env.CHANGED_VAR, 'caller', 'caller env wins over the dev shell')
  assert.equal(applied.env.SAME_KEEP, undefined, 'unchanged inherited vars are not re-injected')
  for (const denied of ['TERM', 'NO_COLOR', 'SHELL', 'TMPDIR', 'NIX_BUILD_TOP', 'XDG_CACHE_HOME', 'PWD', 'SHLVL', 'DSH_PROFILE', 'npm_config_registry']) {
    assert.equal(applied.env[denied], undefined, `${denied} must not be injected`)
  }
  disposeAll()
})

// 2. The capture helper runs in the flake root and under the caller's sandbox policy.
await testAsync('capture helper inherits workdir and sandbox policy', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, disposeAll } = makeContext(state)
  apply(ctx, {})
  await ctx.shell.execute(spec())
  const helper = state.captureSpecs[0]
  assert.equal(helper.workdir, flakeDir)
  assert.deepEqual(helper.sandboxPolicy, spec().sandboxPolicy)
  assert.match(helper.command, /NIX_CACHE_HOME=/)
  assert.match(helper.command, /XDG_CACHE_HOME=/)
  assert.match(helper.command, /print-dev-env/)
  disposeAll()
})

// 3. A captured environment is reused across commands.
await testAsync('captured environment is cached', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, disposeAll } = makeContext(state)
  apply(ctx, {})
  await ctx.shell.execute(spec())
  await ctx.shell.execute(spec())
  await ctx.shell.execute(spec())
  assert.equal(state.captures, 1)
  disposeAll()
})

// 3b. Editing a split nix source refreshes the captured environment.
await testAsync('editing a split nix source refreshes the environment', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const splitDir = join(root, 'split')
  mkdirSync(join(splitDir, 'nix'), { recursive: true })
  writeFileSync(join(splitDir, 'flake.nix'), '{ outputs = { self }: {}; }\n')
  const moduleFile = join(splitDir, 'nix', 'devshell.nix')
  writeFileSync(moduleFile, '{}\n')
  const { ctx, disposeAll } = makeContext(state)
  apply(ctx, {})
  await ctx.shell.execute(spec({ workdir: splitDir }))
  await ctx.shell.execute(spec({ workdir: splitDir }))
  assert.equal(state.captures, 1, 'unchanged sources keep the cache')
  const future = new Date(Date.now() + 5000)
  utimesSync(moduleFile, future, future)
  await ctx.shell.execute(spec({ workdir: splitDir }))
  assert.equal(state.captures, 2, 'a changed nix module invalidates the cache')
  disposeAll()
})

// 4. No flake: behave exactly like the native executor.
await testAsync('workdir outside a flake passes through untouched', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, disposeAll } = makeContext(state)
  apply(ctx, {})
  const result = await ctx.shell.execute(spec({ workdir: plainDir }))
  assert.equal(state.captures, 0)
  assert.equal(result.spec.env, undefined)
  disposeAll()
})

// 5. Capture failure with no prior environment: native shell, single retry window.
await testAsync('failed capture falls back to the native shell and is negatively cached', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: true }
  const { ctx, disposeAll } = makeContext(state)
  apply(ctx, {})
  const first = await ctx.shell.execute(spec())
  const second = await ctx.shell.execute(spec())
  assert.equal(first.spec.env?.NEW_VAR, undefined)
  assert.equal(second.spec.env?.NEW_VAR, undefined)
  assert.match(first.spec.env.NIX_CACHE_HOME, /dsh-nix-dev-shell/)
  assert.equal(state.captures, 1, 'negative cache prevents a capture attempt per command')
  disposeAll()
})

// 6. A failed refresh keeps serving the last good environment.
await testAsync('failed refresh keeps the last good environment', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, disposeAll } = makeContext(state)
  apply(ctx, { ttlMs: 0, retryMs: 60000 })
  await ctx.shell.execute(spec())
  state.failCapture = true
  const stale = await ctx.shell.execute(spec())
  assert.equal(state.captures, 2, 'ttl 0 forces one refresh attempt')
  assert.equal(stale.spec.env.NEW_VAR, 'hello', 'stale but working environment is better than none')
  await ctx.shell.execute(spec())
  assert.equal(state.captures, 2, 'negative cache stops retrying inside retryMs')
  disposeAll()
})

// 7. wrap mode produces an exact `nix develop --command` argv.
await testAsync('wrap mode builds a correctly quoted nix develop command', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, disposeAll } = makeContext(state)
  apply(ctx, { mode: 'wrap', nixCommand: shimNix })
  const original = `echo 'a b' && echo "$HOME" && printf '%s\\n' "it's fine"`
  await ctx.shell.execute(spec({ command: original }))
  const recorded = state.executed.at(-1)
  const argv = execFileSync('bash', ['-c', recorded.command], { encoding: 'utf8' }).split('\n').slice(0, -1)
  assert.deepEqual(argv, [
    'develop',
    flakeDir,
    '--option',
    'warn-dirty',
    'false',
    '--command',
    'bash',
    '-c',
    original,
  ])
  assert.equal(typeof recorded.env.NIX_CACHE_HOME, 'string')
  disposeAll()
})

// 8. wrap mode does not redirect the cache for an unconfined caller.
await testAsync('wrap mode leaves the environment alone under danger-full-access', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, disposeAll } = makeContext(state)
  apply(ctx, { mode: 'wrap', nixCommand: shimNix })
  await ctx.shell.execute(spec({ sandboxPolicy: { mode: 'danger-full-access' } }))
  assert.equal(state.executed.at(-1).env, undefined)
  disposeAll()
})

// 9. Unconfined capture helpers do not override the host nix cache.
await testAsync('unconfined capture does not override the nix cache home', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, disposeAll } = makeContext(state)
  apply(ctx, {})
  await ctx.shell.execute(spec({ sandboxPolicy: { mode: 'danger-full-access' } }))
  assert.doesNotMatch(state.captureSpecs[0].command, /NIX_CACHE_HOME=/)
  assert.doesNotMatch(state.captureSpecs[0].command, /XDG_CACHE_HOME=/)
  disposeAll()
})

// 9b. Confined env mode lets explicit nix commands work without a manual override.
await testAsync('confined env mode injects NIX_CACHE_HOME', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, disposeAll } = makeContext(state)
  apply(ctx, {})
  const result = await ctx.shell.execute(spec())
  assert.match(result.spec.env.NIX_CACHE_HOME, /dsh-nix-dev-shell/)
  disposeAll()
})

// 9c. A relative cacheDir is anchored at the flake root, not at process.cwd().
await testAsync('relative cacheDir is anchored at the flake root', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, disposeAll } = makeContext(state)
  apply(ctx, { cacheDir: '.cache/nix' })
  const result = await ctx.shell.execute(spec())
  assert.equal(result.spec.env.NIX_CACHE_HOME, join(flakeDir, '.cache/nix'))
  assert.match(state.captureSpecs[0].command, /NIX_CACHE_HOME=/)
  disposeAll()
})

// 9d. Runtime prompt context: silent until a dev shell is captured, then one line.
await testAsync('prompt context stays silent until a dev shell is captured', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, contexts, disposeAll } = makeContext(state)
  apply(ctx, {})
  assert.equal(contexts.length, 1)
  const entry = contexts[0]
  assert.equal(entry.name, 'nix-dev-shell:active')
  assert.equal(entry.interpolate, false)
  const lineFor = (cwd) => entry.text({ agent: { session: { header: { cwd } } } })
  assert.equal(lineFor(workdir), '', 'no capture yet: no claim')
  await ctx.shell.execute(spec())
  const line = lineFor(workdir)
  assert.match(line, /Nix dev shell of/)
  assert.match(line, /nix develop/)
  assert.match(line, /IN_NIX_SHELL=impure/)
  assert.ok(line.includes(flakeDir), 'the line names the flake root')
  assert.equal(lineFor(plainDir), '', 'a directory outside the flake stays silent')
  assert.equal(entry.text({}), '', 'agentless assembly stays silent')
  assert.equal(entry.text({ agent: undefined }), '')
  disposeAll()
})

// 9e. A failed capture keeps the prompt context silent.
await testAsync('prompt context stays silent when capture fails', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: true }
  const { ctx, contexts } = makeContext(state)
  apply(ctx, {})
  await ctx.shell.execute(spec())
  assert.equal(contexts[0].text({ agent: { session: { header: { cwd: workdir } } } }), '')
})

// 9f. promptContext: false registers nothing at all.
await testAsync('promptContext: false registers no prompt context', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, contexts } = makeContext(state)
  apply(ctx, { promptContext: false })
  assert.equal(contexts.length, 0)
})

// 10. Disposal restores the untouched executor method.
test('dispose restores the original execute', () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, executor, disposeAll } = makeContext(state)
  apply(ctx, {})
  assert.notEqual(ctx.shell.execute, executor)
  disposeAll()
  assert.equal(ctx.shell.execute, executor)
})

// 11. Plugin can be disabled entirely.
await testAsync('enabled: false leaves the executor untouched', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, disposeAll } = makeContext(state)
  apply(ctx, { enabled: false })
  const result = await ctx.shell.execute(spec())
  assert.equal(state.captures, 0)
  assert.equal(result.spec.env, undefined)
  disposeAll()
})

// 12. Malformed specs never break the executor.
await testAsync('malformed specs pass through', async () => {
  const state = { captures: 0, captureSpecs: [], executed: [], envDump: dump, failCapture: false }
  const { ctx, disposeAll } = makeContext(state)
  apply(ctx, {})
  await ctx.shell.execute(null)
  await ctx.shell.execute({ command: 42 })
  assert.equal(state.captures, 0)
  assert.equal(state.executed.length, 2)
  disposeAll()
})

rmSync(root, { recursive: true, force: true })

const failed = results.filter(([status]) => status === 'fail')
for (const [status, name] of results) {
  if (status === 'ok') console.log(`ok   ${name}`)
  else console.error(`FAIL ${name}`)
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed (${TERM_OK})`)
process.exit(failed.length === 0 ? 0 : 1)