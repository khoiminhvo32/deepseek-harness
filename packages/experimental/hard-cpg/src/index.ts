/**
 * Joern facts for the hard harness. The `hardCpg` service exports the pinned
 * snapshot commit, builds a PHP code property graph with the deployment's
 * Joern installation, runs the packaged query, and caches the resulting
 * JSON Lines facts beside the snapshot store, keyed by commit and query
 * digest. Only the packaged query ever reaches Joern: its interpreter runs
 * arbitrary Scala, so no model text or tool argument is passed to it.
 * @module @deepseek-ai/dsh-experimental-hard-cpg
 */

import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Loads the declaration-merged `Context` keys this plugin injects.
import type {} from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-experimental-hard-ledger'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { countHardCpgFacts, HARD_CPG_FACTS_FORMAT } from './facts.ts'
import type { HardCpgFactCounts } from './facts.ts'
import { HARD_CPG_FACTS_QUERY } from './query.ts'

export { countHardCpgFacts, HARD_CPG_FACTS_FORMAT, readHardCpgFacts } from './facts.ts'
export type { HardCpgArg, HardCpgFact, HardCpgFactCounts } from './facts.ts'
export { HARD_CPG_FACTS_QUERY } from './query.ts'

/** Default JVM heap for the frontend and the query, in MiB. */
export const DEFAULT_HEAP_MB = 8192
/** Default per-step time budget, in minutes; the shell's own timeout cap still applies. */
export const DEFAULT_STEP_TIMEOUT_MINUTES = 10

/** Joern facts plugin config. */
export interface Config {
  /** Build facts. Off by default: a deployment opts in once Joern is installed. */
  enabled?: boolean
  /** Absolute path of the Joern distribution (the `joern-cli` directory). Required when enabled. */
  joernHome?: string
  /**
   * Repository-relative paths the frontend skips, such as PoC stubs inside
   * the snapshot that redefine target functions. Empty by default: the facts
   * cover the whole pinned commit unless the deployment says otherwise.
   */
  excludePaths?: string[]
  /** JVM heap for the frontend and the query, in MiB. */
  heapMb?: number
  /** Time budget per step (export, frontend, query), in minutes. */
  stepTimeoutMinutes?: number
  /** Start building facts in the background when a mission arms. */
  buildOnArm?: boolean
}

/** Schemastery config for the Joern facts plugin. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  joernHome: z.string(),
  excludePaths: z.array(z.string()).default([]),
  heapMb: z.number().step(1).min(512).default(DEFAULT_HEAP_MB),
  stepTimeoutMinutes: z.number().step(1).min(1).default(DEFAULT_STEP_TIMEOUT_MINUTES),
  buildOnArm: z.boolean().default(true),
})

/** Fully materialized plugin inputs. */
interface ResolvedConfig {
  readonly enabled: boolean
  readonly joernHome: string
  readonly excludePaths: readonly string[]
  readonly heapMb: number
  readonly stepTimeoutMs: number
  readonly buildOnArm: boolean
}

/** Validate config even when the service is constructed outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const enabled = config.enabled ?? false
  const joernHome = config.joernHome ?? ''
  if (enabled && !isAbsolute(joernHome)) throw new TypeError('joernHome must be an absolute path when hard-cpg is enabled')
  const excludePaths = config.excludePaths ?? []
  for (const path of excludePaths) {
    const clean = normalize(path)
    if (path.length === 0 || isAbsolute(path) || clean === '..' || clean.startsWith('../')) {
      throw new TypeError(`excludePaths entries must be repository-relative paths inside the target: ${JSON.stringify(path)}`)
    }
  }
  const heapMb = config.heapMb ?? DEFAULT_HEAP_MB
  if (!Number.isSafeInteger(heapMb) || heapMb < 512) throw new TypeError('heapMb must be a safe integer of at least 512')
  const minutes = config.stepTimeoutMinutes ?? DEFAULT_STEP_TIMEOUT_MINUTES
  if (!Number.isSafeInteger(minutes) || minutes < 1) throw new TypeError('stepTimeoutMinutes must be a positive safe integer')
  return { enabled, joernHome, excludePaths, heapMb, stepTimeoutMs: minutes * 60_000, buildOnArm: config.buildOnArm ?? true }
}

/** The facts of one pinned commit. */
export interface HardCpgFacts {
  /** The pinned commit the facts describe. */
  readonly commit: string
  /** Absolute path of the validated fact file. */
  readonly path: string
  /** Per-kind fact counts. */
  readonly counts: HardCpgFactCounts
  /** Whether a cached file served the request instead of a new build. */
  readonly reused: boolean
}

/** The fact file name inside one cache directory. */
const FACTS_FILE = 'facts.jsonl'

/** Captured stdout per step: the facts go to a file, so stdout is only diagnostic. */
const STEP_STDOUT_MAX_BYTES = 65_536

/** Git with the developer's global and system configuration switched off. */
const HERMETIC_GIT = 'GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -c core.autocrlf=false'

/** POSIX-quote one shell argument. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

declare module '@deepseek-ai/cordis' {
  /** The hard-harness Joern facts service. */
  interface Context {
    hardCpg: HardCpg
  }
}

/**
 * The Joern facts service on the `hardCpg` key. Builds run through the shell
 * seam, write only beside the snapshot store, and are shared: concurrent
 * requests for the same commit and query wait for one build.
 */
export class HardCpg extends Service {
  static inject = ['agents', 'shell', 'hardLedger']

  static Config: z<Config> = Config

  private readonly resolved: ResolvedConfig
  private readonly building = new Map<string, Promise<HardCpgFacts>>()
  private readonly cancel = new AbortController()

  constructor(ctx: Context, config: Config = {}) {
    const resolved = resolveConfig(config)
    super(ctx, 'hardCpg')
    this.resolved = resolved
    ctx.effect(() => () => {
      this.cancel.abort()
    }, 'hard-cpg: cancel running builds')
    if (this.resolved.enabled && this.resolved.buildOnArm) {
      ctx.on('session/event', (session, event) => {
        if (event.type !== 'hard/mission/armed') return
        const agent = ctx.agents.get(session.id)
        if (agent === undefined) return
        this.facts(agent).then((facts) => {
          ctx.logger.info(`hard-cpg: facts for ${facts.commit} ready: ${facts.counts.files} files, ${facts.counts.types} types, ${facts.counts.methods} methods, ${facts.counts.calls} calls`)
        }, (error: unknown) => {
          ctx.logger.warn(`hard-cpg: building facts on arming failed: ${String(error)}`)
        })
      })
    }
  }

  /** Whether the deployment enabled fact building. */
  get enabled(): boolean {
    return this.resolved.enabled
  }

  /**
   * The facts of the agent's pinned commit, built on first request and
   * reused from the cache afterwards.
   * @param agent - an agent whose session armed a hard mission.
   * @returns the validated fact file and its counts.
   * @throws HarnessError `HARD_CPG_DISABLED`, `HARD_CPG_NOT_ARMED`, `HARD_CPG_NO_SNAPSHOT`, `HARD_CPG_FAILED`, or `HARD_CPG_FACTS_INVALID`.
   */
  async facts(agent: Agent): Promise<HardCpgFacts> {
    if (!this.resolved.enabled) throw new HarnessError('hard-cpg is disabled; set enabled and joernHome to build facts', 'HARD_CPG_DISABLED')
    const matrix = this.ctx.hardLedger.coverageMatrix(agent)
    if (matrix === undefined) throw new HarnessError('hard-cpg needs an armed mission to know the pinned commit', 'HARD_CPG_NOT_ARMED')
    const snapshot = matrix.snapshot
    if (snapshot === undefined) {
      throw new HarnessError('the arming record predates harness snapshots, so there is no store to export or cache beside', 'HARD_CPG_NO_SNAPSHOT')
    }
    const dir = join(dirname(snapshot.gitDir), 'cpg', matrix.commit, this.cacheKey())
    const pending = this.building.get(dir)
    if (pending !== undefined) return pending
    const build = this.cachedOrBuilt(dir, snapshot.gitDir, matrix.commit)
    this.building.set(dir, build)
    try {
      return await build
    } finally {
      this.building.delete(dir)
    }
  }

  /** The cache key: fact format, query text, Joern installation, and exclusions. */
  private cacheKey(): string {
    const parts = [String(HARD_CPG_FACTS_FORMAT), HARD_CPG_FACTS_QUERY, this.resolved.joernHome, ...this.resolved.excludePaths]
    return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
  }

  private async cachedOrBuilt(dir: string, gitDir: string, commit: string): Promise<HardCpgFacts> {
    const path = join(dir, FACTS_FILE)
    const cached = await access(path).then(() => true, () => false)
    if (cached) return { commit, path, counts: await countHardCpgFacts(path), reused: true }
    await mkdir(dir, { recursive: true })
    const work = await mkdtemp(join(dir, '.build-'))
    try {
      const tree = join(work, 'tree')
      const graph = join(work, 'cpg.bin')
      const output = join(work, FACTS_FILE)
      const query = join(work, 'facts.sc')
      await writeFile(query, HARD_CPG_FACTS_QUERY)
      const policy: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: dirname(gitDir) }
      const { joernHome, heapMb } = this.resolved
      await this.step('export', work, policy,
        `mkdir ${shellQuote(tree)} && ${HERMETIC_GIT} --git-dir=${shellQuote(gitDir)} archive --format=tar ${shellQuote(commit)} | tar -x -C ${shellQuote(tree)}`)
      const excludes = this.resolved.excludePaths.map(path => ` --exclude ${shellQuote(path)}`).join('')
      await this.step('frontend', work, policy,
        `${shellQuote(join(joernHome, 'frontends', 'php2cpg', 'bin', 'php2cpg'))} -J-Xmx${heapMb}m ${shellQuote(tree)} -o ${shellQuote(graph)}${excludes}`)
      await this.step('query', work, policy, [
        shellQuote(join(joernHome, 'bin', 'repl-bridge')),
        `-J-Xmx${heapMb}m`,
        shellQuote(`-Dlog4j.configurationFile=${join(joernHome, 'conf', 'log4j2.xml')}`),
        '--script', shellQuote(query),
        '--param', shellQuote(`cpgFile=${graph}`),
        '--param', shellQuote(`outFile=${output}`),
      ].join(' '))
      const counts = await countHardCpgFacts(output)
      await rename(output, path)
      return { commit, path, counts, reused: false }
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  /** Run one build step through the shell seam; anything but a clean exit throws with the stderr tail. */
  private async step(what: string, workdir: string, sandboxPolicy: SandboxExecutionPolicy, command: string): Promise<void> {
    const spec = this.ctx.shell.resolve({
      command,
      workdir,
      timeoutMs: this.resolved.stepTimeoutMs,
      stdoutMaxBytes: STEP_STDOUT_MAX_BYTES,
      signal: this.cancel.signal,
      sandboxPolicy,
    })
    const result = await (await this.ctx.shell.execute(spec)).result()
    if (result.timedOut || result.aborted || result.exitCode !== 0) {
      const how = result.timedOut ? 'timed out' : result.aborted ? 'was cancelled' : `exited with ${result.exitCode}`
      throw new HarnessError(`hard-cpg ${what} step ${how}: ${result.stderr.text.trim().slice(-600)}`, 'HARD_CPG_FAILED')
    }
  }
}

export default HardCpg
