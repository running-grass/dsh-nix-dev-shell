/**
 * dsh-nix-dev-shell — run the harness's bash commands inside the workspace's
 * Nix dev shell when a `flake.nix` is present.
 *
 * Design notes
 * ------------
 * - This is a *decorator*, not a second executor. It patches the live
 *   `ctx.shell` instance's `execute` method and always delegates to the
 *   original implementation, so whichever executor the profile mounts
 *   (`dsh-bash-sandbox` here, `dsh-bash-local` elsewhere) keeps owning
 *   sandboxing, deadlines, output caps and background process mechanics. A
 *   failure in this plugin can only fall back to the original behavior.
 * - `env` mode (default) captures the dev-shell environment once per flake
 *   revision through the same executor (thus the same sandbox policy) and
 *   injects it into each spawn. No per-command `nix develop` startup, no
 *   `shellHook` output mixed into every tool result.
 * - `wrap` mode keeps literal `nix develop <flake> --command bash -c <cmd>`
 *   semantics at the cost of one nix evaluation per command.
 *
 * @module dsh-nix-dev-shell
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

export const name = 'nix-dev-shell'

/** Wait for the shell capability seam before decorating it. */
export const inject = ['shell']

/** Cordis proxy key that reveals the raw service instance behind a traceable proxy. */
const ORIGINAL = Symbol.for('cordis.original')

const DEFAULTS = {
  /** Master switch; `false` leaves the native shell untouched. */
  enabled: true,
  /** `'env'` injects the captured dev-shell environment; `'wrap'` runs under `nix develop`. */
  mode: 'env',
  /** Flake filename to look for while walking ancestors. */
  flakeFile: 'flake.nix',
  /** How many parent directories to inspect above the workdir. */
  maxAncestors: 40,
  /** Budget for one dev-shell environment capture. */
  captureTimeoutMs: 30000,
  /** How long a failed capture is remembered before it is retried. */
  retryMs: 60000,
  /** How long a captured environment is reused before it is refreshed. */
  ttlMs: 600000,
  /** Nix cache directory for sandboxed nix runs; empty uses a per-call temp directory. */
  cacheDir: '',
  /** Point NIX_CACHE_HOME at {@link DEFAULTS.cacheDir} for confined commands in a flake. */
  injectCacheHome: true,
  /** Tell the model (runtime prompt context) when a captured dev shell is active. */
  promptContext: true,
  /** nix executable name or absolute path. */
  nixCommand: 'nix',
}

/**
 * Variables that must never be inherited from the dev shell into a command:
 * shell/bookkeeping state, the harness-owned terminal policy (the executor's
 * `TERM=dumb`/`NO_COLOR` must win), and Nix's build-time scratch paths.
 */
const DENY_ENV = new Set([
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'SHELL',
  'PS1',
  'PS2',
  'PS4',
  'BASH_ENV',
  'BASHOPTS',
  'SHELLOPTS',
  'IFS',
  'OPTERR',
  'LINENO',
  'RANDOM',
  'SECONDS',
  'EPOCHREALTIME',
  'EPOCHSECONDS',
  'TERM',
  'NO_COLOR',
  'PAGER',
  'GIT_PAGER',
  'TMP',
  'TMPDIR',
  'TEMP',
  'TEMPDIR',
  'NIX_BUILD_TOP',
  'XDG_CACHE_HOME',
  'NIX_CACHE_HOME',
  'shellHook',
])

/** POSIX single-quote one shell word. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

/** Coerce and validate the row's plain-object config. */
function normalizeConfig(config) {
  const input = config !== null && typeof config === 'object' ? config : {}
  const pick = (key) => input[key]
  const num = (key, fallback, { min = 0 } = {}) => {
    const value = pick(key)
    return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback
  }
  const str = (key, fallback) => {
    const value = pick(key)
    return typeof value === 'string' ? value : fallback
  }
  return {
    enabled: pick('enabled') !== false,
    mode: pick('mode') === 'wrap' ? 'wrap' : 'env',
    flakeFile: str('flakeFile', DEFAULTS.flakeFile),
    maxAncestors: Math.floor(num('maxAncestors', DEFAULTS.maxAncestors)),
    captureTimeoutMs: Math.floor(num('captureTimeoutMs', DEFAULTS.captureTimeoutMs, { min: 1000 })),
    retryMs: Math.floor(num('retryMs', DEFAULTS.retryMs)),
    ttlMs: Math.floor(num('ttlMs', DEFAULTS.ttlMs)),
    cacheDir: str('cacheDir', DEFAULTS.cacheDir),
    injectCacheHome: pick('injectCacheHome') !== false,
    promptContext: pick('promptContext') !== false,
    nixCommand: str('nixCommand', DEFAULTS.nixCommand),
  }
}

/** Whether a resolved spec will run through a confining executor. */
function isConfined(spec) {
  const mode = spec.sandboxPolicy?.mode
  return mode !== undefined && mode !== 'danger-full-access'
}

/**
 * The nix cache directory handed to sandboxed nix runs. A relative `cacheDir`
 * is anchored at the flake root (not at the harness process's cwd, which is not
 * necessarily the workspace and may be read-only inside the sandbox).
 * @param cfg - normalized config.
 * @param anchorDir - the flake root used for relative paths.
 * @returns an absolute cache directory.
 */
function nixCacheDir(cfg, anchorDir) {
  if (cfg.cacheDir.length === 0) return join(tmpdir(), 'dsh-nix-dev-shell')
  return isAbsolute(cfg.cacheDir) ? cfg.cacheDir : join(anchorDir, cfg.cacheDir)
}

/** Nearest ancestor directory (inclusive) that holds the configured flake file. */
function findFlakeDir(cfg, workdir) {
  let current = resolvePath(workdir ?? process.cwd())
  for (let depth = 0; depth <= cfg.maxAncestors; depth += 1) {
    try {
      const candidate = join(current, cfg.flakeFile)
      if (existsSync(candidate) && statSync(candidate).isFile()) return current
    } catch {
      // Unreadable directories are skipped; the walk continues upward.
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

/** Directory names never scanned by {@link collectNixSources}. */
const SKIP_DIRS = new Set(['.git', '.direnv', '_build', 'node_modules', 'result', 'target'])

/** Stat `*.nix` files near the flake root so split flake sources invalidate the cache too. */
function collectNixSources(dir, depth, out) {
  if (out.length >= 256) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= 256) return
    if (entry.name.startsWith('.')) continue
    const child = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth > 0 && !SKIP_DIRS.has(entry.name)) collectNixSources(child, depth - 1, out)
      continue
    }
    if (!entry.name.endsWith('.nix')) continue
    try {
      const stat = statSync(child)
      out.push(`${child}:${stat.mtimeMs}:${stat.size}`)
    } catch {
      // Unreadable entries are ignored; the flake itself still has a stamp.
    }
  }
}

/**
 * A cheap revision stamp for one flake: the flake entry point, its lock file,
 * and every `*.nix` source within three directory levels (bounded), so a split
 * `nix/` devShell module edit refreshes the environment without waiting for
 * the TTL.
 */
function flakeStamp(cfg, flakeDir) {
  try {
    const parts = []
    const pushFile = (filePath) => {
      const stat = statSync(filePath)
      parts.push(`${filePath}:${stat.mtimeMs}:${stat.size}`)
    }
    pushFile(join(flakeDir, cfg.flakeFile))
    const lockPath = join(flakeDir, 'flake.lock')
    if (existsSync(lockPath)) pushFile(lockPath)
    const nested = []
    collectNixSources(flakeDir, 2, nested)
    parts.push(...nested)
    parts.sort()
    return parts.join('|')
  } catch {
    return null
  }
}

/**
 * Placement among runtime-context entries: right after the sandbox policy
 * (`CONTEXT_ORDERS.SANDBOX_POLICY` = 110) and before the approval policy
 * (115), so the environment fact is read together with the sandbox fact.
 */
const PROMPT_CONTEXT_ORDER = 112

/**
 * The single line handed to the model while a dev shell is active. It names the
 * plugin deliberately: without it models attribute `IN_NIX_SHELL` and the Nix
 * toolchain to direnv, or silently treat the environment as the native one.
 * @param flakeDir - the flake root the dev shell was captured from.
 * @returns one English sentence for the runtime prompt context.
 */
function devShellContextLine(flakeDir) {
  return `Bash commands run inside the Nix dev shell of ${flakeDir} (dsh-nix-dev-shell plugin, not direnv): IN_NIX_SHELL=impure, tools come from /nix/store, and \`nix\` works directly.`
}

/** The helper shell program that prints the dev-shell environment as NUL-separated pairs. */
function captureScript(cfg, cacheDir) {
  const lines = []
  if (cacheDir !== '') {
    // NIX_CACHE_HOME is the precise knob (Nix ≥ 2.34); XDG_CACHE_HOME keeps
    // older Nix working. Both are stripped from the captured overlay.
    lines.push(`export NIX_CACHE_HOME=${shQuote(cacheDir)}`)
    lines.push(`export XDG_CACHE_HOME=${shQuote(cacheDir)}`)
    lines.push('mkdir -p "$NIX_CACHE_HOME" 2>/dev/null || true')
  }
  lines.push(
    `if ! command -v ${shQuote(cfg.nixCommand)} >/dev/null 2>&1; then echo "dsh-nix-dev-shell: nix executable not found" >&2; exit 127; fi`,
  )
  // Sourcing the printed snippet also evaluates the flake's shellHook; its
  // output is intentionally discarded so tool results stay clean.
  lines.push(
    `{ eval "$(${shQuote(cfg.nixCommand)} print-dev-env --option warn-dirty false 2>/dev/null)"; } >/dev/null 2>&1 || { echo "dsh-nix-dev-shell: nix print-dev-env failed" >&2; exit 1; }`,
  )
  lines.push('env -0')
  return lines.join('\n')
}

/**
 * Turn the helper's `env -0` output into the environment overlay worth
 * injecting: anything the dev shell changed or added relative to this process,
 * minus bookkeeping and harness-owned names.
 */
function parseEnvOverlay(raw, baseline = process.env) {
  const overlay = Object.create(null)
  for (const entry of raw.split('\0')) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const key = entry.slice(0, separator)
    const value = entry.slice(separator + 1)
    if (DENY_ENV.has(key)) continue
    if (key.startsWith('DSH_') || key.startsWith('npm_')) continue
    if (baseline[key] === value) continue
    overlay[key] = value
  }
  return overlay
}

/**
 * Create the plugin's state and decorator.
 * @param ctx - the plugin context (with `shell` injected).
 * @param cfg - normalized config.
 * @returns the decorator installer.
 */
function createDecorator(ctx, cfg) {
  /** flakeDir -> { stamp, env, error, at, refreshedAt } */
  const cache = new Map()
  /** flakeDir -> Promise<overlay | null> (single flight) */
  const inflight = new Map()

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // Logging must never change execution behavior.
    }
  }

  /**
   * Run the capture helper through the *undecorated* executor, so the helper
   * shares the caller's sandbox policy and cannot recurse into this decorator.
   */
  async function captureOverlay(runOriginal, spec, flakeDir) {
    const helper = {
      command: captureScript(cfg, isConfined(spec) ? nixCacheDir(cfg, flakeDir) : ''),
      workdir: flakeDir,
      timeoutMs: cfg.captureTimeoutMs,
      onExpiry: 'kill',
      stdoutMaxBytes: 4 * 1024 * 1024,
      ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
      ...(spec.sandboxPolicy !== undefined ? { sandboxPolicy: spec.sandboxPolicy } : {}),
    }
    const execution = await runOriginal(helper)
    const result = await execution.result()
    if (result.exitCode !== 0) {
      const detail = result.stderr.text.trim()
      throw new Error(`exit=${String(result.exitCode)} ${detail.length > 0 ? detail.slice(0, 800) : '(no stderr)'}`)
    }
    if (result.stdout.text.length === 0) throw new Error('capture returned empty stdout')
    return parseEnvOverlay(result.stdout.text)
  }

  /**
   * Resolve (and cache) the dev-shell environment overlay for one flake.
   * A previously captured environment keeps being served when a refresh fails:
   * a temporarily broken flake (mid-refactor tree, transient network) must not
   * silently downgrade every command to the native shell.
   */
  async function resolveOverlay(runOriginal, spec, flakeDir) {
    const stamp = flakeStamp(cfg, flakeDir)
    const now = Date.now()
    const cached = cache.get(flakeDir)
    const previous = cached?.env ?? null
    if (cached !== undefined && stamp !== null && cached.stamp === stamp) {
      if (cached.error === null && now - cached.refreshedAt < cfg.ttlMs) return cached.env
      // A recent failed refresh keeps the negative cache for both flavors.
      if (cached.error !== null && now - cached.at < cfg.retryMs) return previous
    }
    const pending = inflight.get(flakeDir)
    if (pending !== undefined) return pending
    const work = (async () => {
      try {
        const env = await captureOverlay(runOriginal, spec, flakeDir)
        const at = Date.now()
        cache.set(flakeDir, { stamp: flakeStamp(cfg, flakeDir), env, error: null, at, refreshedAt: at })
        return env
      } catch (error) {
        const at = Date.now()
        cache.set(flakeDir, { stamp: flakeStamp(cfg, flakeDir), env: previous, error, at, refreshedAt: at })
        warn(
          previous === null
            ? `nix-dev-shell: no dev shell for ${flakeDir}, using the native shell: ${String(error)}`
            : `nix-dev-shell: dev shell refresh failed for ${flakeDir}, reusing the last captured environment: ${String(error)}`,
        )
        return previous
      } finally {
        inflight.delete(flakeDir)
      }
    })()
    inflight.set(flakeDir, work)
    return work
  }

  /** `wrap` mode: replace the command with a `nix develop --command` invocation. */
  function wrapSpec(spec, flakeDir, cacheEnv) {
    const inner = `${shQuote(cfg.nixCommand)} develop ${shQuote(flakeDir)} --option warn-dirty false --command bash -c ${shQuote(spec.command)}`
    return {
      ...spec,
      command: inner,
      ...(cacheEnv === undefined ? {} : { env: { ...cacheEnv, ...(spec.env ?? {}) } }),
    }
  }

  /** Install the decorator on the live executor instance. */
  function install() {
    const proxyShell = ctx.shell
    if (proxyShell === undefined || proxyShell === null || typeof proxyShell.execute !== 'function') return undefined
    // The raw instance behind the traceable proxy is where property shadowing is stable.
    const rawShell = proxyShell[ORIGINAL] ?? proxyShell
    if (typeof rawShell.execute !== 'function') return undefined
    if (rawShell.execute[Symbol.for('dsh-nix-dev-shell')] === true) return undefined
    const originalExecute = rawShell.execute
    // Executors define `execute` on their prototype, but an implementation may
    // own the property; restore exactly what was shadowed either way.
    const ownDescriptor = Object.getOwnPropertyDescriptor(rawShell, 'execute')

    /** @this the caller's Cordis shadow, so `this.ctx` keeps its usual semantics. */
    const wrapped = async function wrapped(spec) {
      const self = this
      const runOriginal = (next) => originalExecute.call(self, next)
      try {
        if (!cfg.enabled || spec === null || typeof spec !== 'object' || typeof spec.command !== 'string') {
          return runOriginal(spec)
        }
        const flakeDir = findFlakeDir(cfg, spec.workdir)
        if (flakeDir === null) return runOriginal(spec)
        // A confining sandbox makes ~/.cache/nix read-only, so an explicit
        // `nix` command would fail on its fetcher cache. Point Nix at a
        // writable cache (NIX_CACHE_HOME only affects nix, not other tools).
        const cacheEnv = cfg.injectCacheHome && isConfined(spec) ? { NIX_CACHE_HOME: nixCacheDir(cfg, flakeDir) } : undefined
        if (cfg.mode === 'wrap') return runOriginal(wrapSpec(spec, flakeDir, cacheEnv))
        const overlay = await resolveOverlay(runOriginal, spec, flakeDir)
        if (overlay === null) {
          return cacheEnv === undefined ? runOriginal(spec) : runOriginal({ ...spec, env: { ...cacheEnv, ...(spec.env ?? {}) } })
        }
        return runOriginal({ ...spec, env: { ...cacheEnv, ...overlay, ...(spec.env ?? {}) } })
      } catch (error) {
        warn(`nix-dev-shell: falling back to the native shell: ${String(error)}`)
        return runOriginal(spec)
      }
    }
    Object.defineProperty(wrapped, Symbol.for('dsh-nix-dev-shell'), { value: true })
    rawShell.execute = wrapped
    return () => {
      if (rawShell.execute !== wrapped) return
      if (ownDescriptor !== undefined) Object.defineProperty(rawShell, 'execute', ownDescriptor)
      else delete rawShell.execute
    }
  }

  /**
   * The runtime prompt-context line for one assembly, or '' when the assembly's
   * workspace has no captured dev shell (yet).
   * @param workdir - the assembling agent's session cwd, when it has one.
   * @returns the line to contribute, possibly empty.
   */
  function activeLine(workdir) {
    if (!cfg.promptContext || typeof workdir !== 'string' || workdir.length === 0) return ''
    const flakeDir = findFlakeDir(cfg, workdir)
    if (flakeDir === null) return ''
    const cached = cache.get(flakeDir)
    if (cached === undefined || cached.env === null) return ''
    return devShellContextLine(flakeDir)
  }

  return { install, activeLine }
}

/**
 * Decorate the mounted shell executor so every bash command that runs under a
 * directory covered by a `flake.nix` starts inside that Nix dev shell.
 * @param ctx - the plugin context; `shell` is injected.
 * @param config - the row config (see `DEFAULTS`).
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const decorator = createDecorator(ctx, cfg)
  ctx.effect(() => decorator.install(), 'dsh-nix-dev-shell: decorate ctx.shell.execute')
  // Runtime prompt context (not a tool description): tool schemas are owned by
  // their tool plugins, while ctx.systemPrompt.context is the registry the
  // working-directory and sandbox-policy plugins use for the same kind of fact.
  if (cfg.promptContext && typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'nix-dev-shell:active',
        order: PROMPT_CONTEXT_ORDER,
        interpolate: false,
        text: (context) => decorator.activeLine(context?.agent?.session?.header?.cwd),
      })
    })
  }
}