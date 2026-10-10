/**
 * The hard harness feature map. The `hardFeatureMap` service imports the Joern
 * facts `hardCpg` builds for a mission's pinned commit into one SQLite
 * database shared across projects and sessions: symbols, call sites, call
 * edges tagged with the rule that made them (Joern, a repair, a unique name,
 * or a hook), and the entry points the configured framework profiles read:
 * WordPress hooks and routes, and the HTTP routes of Laravel, Spring, ASP.NET
 * Core, Flask, FastAPI, and Express. The database is derived data and can
 * always be rebuilt.
 * @module @deepseek-ai/dsh-experimental-hard-featuremap
 */

import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, normalize } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Loads the declaration-merged `Context` keys this plugin injects.
import type {} from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-experimental-hard-ledger'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { HardFeatureGraph, HardFeaturePolicy } from './check.ts'
import { FEATURE_MAP_SECTION, featureMapTools } from './tools.ts'
import type { HardFeatureMapAccess } from './tools.ts'
import { readHardCpgFacts } from '@deepseek-ai/dsh-experimental-hard-cpg'
import { buildModel } from './model.ts'
import { callEdges } from './repair.ts'
import { HardFeatureMapStore } from './store.ts'
import type { HardEdgeRow, HardSnapshotStats } from './store.ts'
import { httpEntryPoints } from './http.ts'
import type { HardHttpFramework } from './http.ts'
import { hookEdges, WORDPRESS_GUARDS, WORDPRESS_MUTATIONS, wordpressEntryPoints, wordpressHooks } from './wordpress.ts'
import type { HardEntryPoint } from './wordpress.ts'

export { buildModel, findMethod, lineage } from './model.ts'
export type { FactModel } from './model.ts'
export { callEdges } from './repair.ts'
export type { HardCallEdge, HardEdgeSource } from './repair.ts'
export { HARD_FEATUREMAP_SCHEMA_VERSION, HardFeatureMapStore } from './store.ts'
export type { HardEdgeRow, HardSnapshotImport, HardSnapshotStats } from './store.ts'
export { hookEdges, phpString, resolveCallback, WORDPRESS_GUARDS, WORDPRESS_MUTATIONS, wordpressEntryPoints, wordpressHooks } from './wordpress.ts'
export { checkFeature, requiredSet } from './check.ts'
export type { HardFeatureCheck, HardFeatureClaim, HardFeatureGraph, HardFeaturePolicy, HardRequiredReason, HardRequiredSet } from './check.ts'
export { FEATURE_MAP_SECTION, featureMapTools } from './tools.ts'
export type { HardFeatureMapAccess } from './tools.ts'
export type { HardSymbolRow } from './store.ts'
export type { HardEntryAuth, HardEntryKind, HardEntryPoint, HardHook } from './wordpress.ts'
export { httpEntryPoints } from './http.ts'
export type { HardHttpFramework } from './http.ts'

/** A framework profile that reads entry points: WordPress, or one of the HTTP route profiles. */
export type HardFramework = 'wordpress' | HardHttpFramework

/** Every framework profile, in the order an import reads them. */
export const HARD_FRAMEWORKS: readonly HardFramework[] = ['wordpress', 'laravel', 'spring', 'aspnet', 'flask', 'fastapi', 'express']

/** The directories whose top-level PHP files a WordPress install serves directly. */
export const WORDPRESS_SCRIPT_DIRS: readonly string[] = ['.', 'wp-admin', 'wp-admin/network', 'wp-admin/user']

/** Default call levels the feature check follows. */
export const DEFAULT_FEATURE_DEPTH = 4
/** Default call levels whose non-library symbols are required. */
export const DEFAULT_REQUIRED_DEPTH = 2
/** Default distinct-caller count above which a symbol is a library symbol. */
export const DEFAULT_LIBRARY_FAN_IN = 40
/** Default largest excluded share of a feature's required symbols, in percent. */
export const DEFAULT_MAX_EXCLUDED_PERCENT = 50

/** Time budget for reading one cited line from the snapshot store. */
const LINE_READ_TIMEOUT_MS = 30_000
/** Captured bytes of one cited line. */
const LINE_READ_MAX_BYTES = 65_536
/** Git with the developer's global and system configuration switched off. */
const HERMETIC_GIT = 'GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -c core.autocrlf=false'

/** POSIX-quote one shell argument. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Bumped when the rows an import derives from the same facts change. */
const IMPORT_VERSION = 2

/** Feature map plugin config. */
export interface Config {
  /** Import facts. Off by default; it needs `hard-cpg` enabled. */
  enabled?: boolean
  /** Absolute path of the shared database file. Required when enabled. */
  dbPath?: string
  /** The framework profiles to read; empty keeps call edges only. */
  frameworks?: HardFramework[]
  /**
   * Repository-relative directories (`.` for the root) whose top-level PHP
   * files are requested directly. Empty selects {@link WORDPRESS_SCRIPT_DIRS}
   * when the WordPress profile is on, none otherwise.
   */
  scriptDirs?: string[]
  /** Import in the background when a mission arms. */
  indexOnArm?: boolean
  /** Call levels the feature check follows from a feature's handlers. */
  featureDepth?: number
  /** Call levels whose non-library symbols a feature must account for. */
  requiredDepth?: number
  /** Distinct callers above which a symbol is a shared library symbol the check does not expand. */
  libraryFanIn?: number
  /** The largest share of a feature's required symbols it may exclude, in percent. */
  maxExcludedPercent?: number
  /** Names of access-check symbols a feature must account for when reached; empty selects the WordPress list when its profile is on. */
  guards?: string[]
  /** Names of state-writing symbols a feature must account for when reached; empty selects the WordPress list when its profile is on. */
  mutations?: string[]
}

/** Schemastery config for the feature map plugin. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  dbPath: z.string(),
  frameworks: z.array(z.union([...HARD_FRAMEWORKS])).default([]),
  scriptDirs: z.array(z.string()).default([]),
  indexOnArm: z.boolean().default(true),
  featureDepth: z.number().step(1).min(1).max(8).default(DEFAULT_FEATURE_DEPTH),
  requiredDepth: z.number().step(1).min(1).max(8).default(DEFAULT_REQUIRED_DEPTH),
  libraryFanIn: z.number().step(1).min(1).default(DEFAULT_LIBRARY_FAN_IN),
  maxExcludedPercent: z.number().step(1).min(0).max(100).default(DEFAULT_MAX_EXCLUDED_PERCENT),
  guards: z.array(z.string()).default([]),
  mutations: z.array(z.string()).default([]),
})

/** Fully materialized plugin inputs. */
interface ResolvedConfig {
  readonly enabled: boolean
  readonly dbPath: string
  readonly frameworks: readonly HardFramework[]
  readonly scriptDirs: readonly string[]
  readonly indexOnArm: boolean
  readonly policy: HardFeaturePolicy
}

/** Validate config even when the service is constructed outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const enabled = config.enabled ?? false
  const dbPath = config.dbPath ?? ''
  if (enabled && !isAbsolute(dbPath)) throw new TypeError('dbPath must be an absolute path when hard-featuremap is enabled')
  const frameworks = HARD_FRAMEWORKS.filter(framework => (config.frameworks ?? []).includes(framework))
  const configured = config.scriptDirs ?? []
  const scriptDirs = configured.length > 0 ? configured : frameworks.includes('wordpress') ? [...WORDPRESS_SCRIPT_DIRS] : []
  for (const dir of scriptDirs) {
    const clean = normalize(dir)
    if (dir.length === 0 || isAbsolute(dir) || clean === '..' || clean.startsWith('../')) {
      throw new TypeError(`scriptDirs entries must be repository-relative directories inside the target: ${JSON.stringify(dir)}`)
    }
  }
  const featureDepth = integerIn('featureDepth', config.featureDepth ?? DEFAULT_FEATURE_DEPTH, 1, 8)
  const requiredDepth = integerIn('requiredDepth', config.requiredDepth ?? DEFAULT_REQUIRED_DEPTH, 1, featureDepth)
  const libraryFanIn = integerIn('libraryFanIn', config.libraryFanIn ?? DEFAULT_LIBRARY_FAN_IN, 1, Number.MAX_SAFE_INTEGER)
  const maxExcludedPercent = integerIn('maxExcludedPercent', config.maxExcludedPercent ?? DEFAULT_MAX_EXCLUDED_PERCENT, 0, 100)
  const wordpress = frameworks.includes('wordpress')
  const listOr = (configuredList: readonly string[], fallback: readonly string[]): ReadonlySet<string> =>
    new Set(configuredList.length > 0 ? configuredList : wordpress ? fallback : [])
  return {
    enabled,
    dbPath,
    frameworks,
    scriptDirs: scriptDirs.map(dir => normalize(dir)),
    indexOnArm: config.indexOnArm ?? true,
    policy: {
      depth: featureDepth,
      requiredDepth,
      libraryFanIn,
      maxExcludedPercent,
      guards: listOr(config.guards ?? [], WORDPRESS_GUARDS),
      mutations: listOr(config.mutations ?? [], WORDPRESS_MUTATIONS),
    },
  }
}

/** Validate one integer config field against its inclusive range. */
function integerIn(field: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${field} must be a safe integer from ${min} through ${max}`)
  return value
}

/** One imported snapshot. */
export interface HardFeatureMapSnapshot {
  /** Snapshot id in the database. */
  readonly id: number
  /** The pinned commit it describes. */
  readonly commit: string
  /** Row counts. */
  readonly stats: HardSnapshotStats
  /** Whether an earlier import served the request. */
  readonly reused: boolean
}

declare module '@deepseek-ai/cordis' {
  /** The hard-harness feature map service. */
  interface Context {
    hardFeatureMap: HardFeatureMap
  }
}

/**
 * The feature map service on the `hardFeatureMap` key. Imports are shared:
 * concurrent requests for one project, commit, and derivation wait for one
 * import, and an earlier import of the same derivation is reused.
 */
export class HardFeatureMap extends Service {
  static inject = ['agents', 'hardLedger', 'hardCpg', 'shell', 'tools', 'systemPrompt']

  static Config: z<Config> = Config

  private readonly resolved: ResolvedConfig
  private readonly importing = new Map<string, Promise<HardFeatureMapSnapshot>>()
  private opened: Promise<HardFeatureMapStore> | undefined

  constructor(ctx: Context, config: Config = {}) {
    const resolved = resolveConfig(config)
    super(ctx, 'hardFeatureMap')
    this.resolved = resolved
    ctx.effect(() => () => {
      void this.opened?.then((store) => {
        store.close()
      })
    }, 'hard-featuremap: close the database')
    if (resolved.enabled) {
      ctx.systemPrompt.section({ name: 'hard:feature-map', order: ctx.systemPrompt.getSectionOrder('HARD_FEATURE_MAP'), text: FEATURE_MAP_SECTION })
      for (const tool of featureMapTools(this.access(), ctx.hardLedger)) ctx.effect(() => ctx.tools.register(tool), `hard-featuremap: ${tool.name}`)
    }
    if (resolved.enabled && resolved.indexOnArm) {
      ctx.on('session/event', (session, event) => {
        if (event.type !== 'hard/mission/armed') return
        const agent = ctx.agents.get(session.id)
        if (agent === undefined) return
        this.index(agent).then((snapshot) => {
          const { edges, entryPoints } = snapshot.stats
          ctx.logger.info(`hard-featuremap: snapshot ${snapshot.id} for ${snapshot.commit} ready: ${edges.joern} joern, ${edges.repair} repair, ${edges['unique-name']} unique-name, ${edges.hook} hook edges, ${entryPoints} entry points`)
        }, (error: unknown) => {
          ctx.logger.warn(`hard-featuremap: indexing on arming failed: ${String(error)}`)
        })
      })
    }
  }

  /** Whether the deployment enabled the feature map. */
  get enabled(): boolean {
    return this.resolved.enabled
  }

  /**
   * Import the facts of the agent's pinned commit, or reuse an earlier import.
   * @param agent - an agent whose session armed a hard mission.
   * @returns the imported snapshot.
   * @throws HarnessError `HARD_FEATUREMAP_DISABLED`, `HARD_FEATUREMAP_NOT_ARMED`, or any `hardCpg.facts` error.
   */
  async index(agent: Agent): Promise<HardFeatureMapSnapshot> {
    if (!this.resolved.enabled) throw new HarnessError('hard-featuremap is disabled; set enabled and dbPath to build the map', 'HARD_FEATUREMAP_DISABLED')
    const matrix = this.ctx.hardLedger.coverageMatrix(agent)
    if (matrix === undefined) throw new HarnessError('hard-featuremap needs an armed mission to know the target', 'HARD_FEATUREMAP_NOT_ARMED')
    const facts = await this.ctx.hardCpg.facts(agent)
    const { frameworks, scriptDirs } = this.resolved
    const derivation = createHash('sha256')
      .update([String(IMPORT_VERSION), basename(dirname(facts.path)), frameworks.join(','), ...scriptDirs].join('\0'))
      .digest('hex').slice(0, 16)
    const key = [matrix.targetRepo, facts.commit, derivation].join('\0')
    const run = this.importing.get(key) ?? (async (): Promise<HardFeatureMapSnapshot> => {
      const store = await this.store()
      const existing = store.findSnapshot(matrix.targetRepo, facts.commit, derivation)
      if (existing !== undefined) return { id: existing, commit: facts.commit, stats: store.stats(existing), reused: true }
      const model = await buildModel(readHardCpgFacts(facts.path))
      const wordpress = frameworks.includes('wordpress')
      const hooks = wordpress ? wordpressHooks(model) : []
      const http = frameworks.filter((framework): framework is HardHttpFramework => framework !== 'wordpress')
      const entryPoints = [...wordpress ? wordpressEntryPoints(model, hooks, scriptDirs) : [], ...httpEntryPoints(model, http)]
      const id = store.importSnapshot({
        projectRoot: matrix.targetRepo,
        commit: facts.commit,
        derivation,
        frameworks,
        factsPath: facts.path,
        model,
        edges: [...callEdges(model), ...hookEdges(hooks)],
        hooks,
        entryPoints,
      })
      return { id, commit: facts.commit, stats: store.stats(id), reused: false }
    })()
    this.importing.set(key, run)
    let snapshot: HardFeatureMapSnapshot
    try {
      snapshot = await run
    } finally {
      this.importing.delete(key)
    }
    const entryPoints = (await this.store()).entryPoints(snapshot.id).map(entry => ({ key: `${entry.kind}:${entry.key}`, handler: entry.handler }))
    this.ctx.hardLedger.recordFeatureMapIndexed(agent, { commit: snapshot.commit, derivation, entryPoints })
    return snapshot
  }

  /** The reads the feature map tools use. */
  private access(): HardFeatureMapAccess {
    return {
      snapshotOf: async (agent) => {
        const snapshot = await this.index(agent)
        return { id: snapshot.id, commit: snapshot.commit }
      },
      graph: async (snapshot) => {
        const store = await this.store()
        const entries = new Map(store.entryPoints(snapshot).map(entry => [`${entry.kind}:${entry.key}`, entry]))
        return {
          symbol: id => store.symbol(snapshot, id),
          callees: id => store.calleeIds(snapshot, id),
          fanIn: id => store.fanIn(snapshot, id),
          entryPoint: key => entries.get(key),
        } satisfies HardFeatureGraph
      },
      entryPoints: snapshot => this.entryPoints(snapshot),
      findSymbols: async (snapshot, text, limit) => (await this.store()).findSymbols(snapshot, text, limit),
      callers: (snapshot, symbol) => this.callers(snapshot, symbol),
      callees: (snapshot, symbol) => this.callees(snapshot, symbol),
      lineText: (agent, file, line) => this.lineText(agent, file, line),
      policy: this.resolved.policy,
    }
  }

  /** One line of a file at the agent's pinned commit, read from the snapshot store; undefined when it does not exist. */
  private async lineText(agent: Agent, file: string, line: number): Promise<string | undefined> {
    const matrix = this.ctx.hardLedger.coverageMatrix(agent)
    const gitDir = matrix?.snapshot?.gitDir
    if (matrix === undefined || gitDir === undefined || !Number.isSafeInteger(line) || line < 1) return undefined
    const spec = this.ctx.shell.resolve({
      command: `${HERMETIC_GIT} --git-dir=${shellQuote(gitDir)} show ${shellQuote(`${matrix.commit}:${file}`)} | sed -n '${line}p'`,
      workdir: dirname(gitDir),
      timeoutMs: LINE_READ_TIMEOUT_MS,
      stdoutMaxBytes: LINE_READ_MAX_BYTES,
    })
    const result = await (await this.ctx.shell.execute(spec)).result()
    const text = result.stdout.text.replace(/\n$/, '')
    return result.exitCode === 0 && text.length > 0 ? text : undefined
  }

  /**
   * Every edge into a symbol of one snapshot.
   * @param snapshot - snapshot id from {@link index}.
   * @param symbol - callee symbol id.
   * @returns the edges, each with the rule that made it.
   */
  async callers(snapshot: number, symbol: string): Promise<HardEdgeRow[]> {
    return (await this.store()).callers(snapshot, symbol)
  }

  /**
   * Every edge out of a symbol of one snapshot.
   * @param snapshot - snapshot id from {@link index}.
   * @param symbol - caller symbol id.
   * @returns the edges, each with the rule that made it.
   */
  async callees(snapshot: number, symbol: string): Promise<HardEdgeRow[]> {
    return (await this.store()).callees(snapshot, symbol)
  }

  /**
   * The entry points of one snapshot.
   * @param snapshot - snapshot id from {@link index}.
   * @returns the entry points.
   */
  async entryPoints(snapshot: number): Promise<HardEntryPoint[]> {
    return (await this.store()).entryPoints(snapshot)
  }

  private store(): Promise<HardFeatureMapStore> {
    if (!this.resolved.enabled) return Promise.reject(new HarnessError('hard-featuremap is disabled; set enabled and dbPath to build the map', 'HARD_FEATUREMAP_DISABLED'))
    this.opened ??= HardFeatureMapStore.open(this.resolved.dbPath)
    return this.opened
  }
}

export default HardFeatureMap
