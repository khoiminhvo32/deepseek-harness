/**
 * The hard harness feature map. The `hardFeatureMap` service imports the Joern
 * facts `hardCpg` builds for a mission's pinned commit into one SQLite
 * database shared across projects and sessions: symbols, call sites, call
 * edges tagged with the rule that made them (Joern, a repair, a unique name,
 * or a hook), and, under the WordPress profile, hook registrations and entry
 * points. The database is derived data and can always be rebuilt.
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
import { readHardCpgFacts } from '@deepseek-ai/dsh-experimental-hard-cpg'
import { buildModel } from './model.ts'
import { callEdges } from './repair.ts'
import { HardFeatureMapStore } from './store.ts'
import type { HardEdgeRow, HardSnapshotStats } from './store.ts'
import { hookEdges, wordpressEntryPoints, wordpressHooks } from './wordpress.ts'
import type { HardEntryPoint } from './wordpress.ts'

export { buildModel, findMethod, lineage } from './model.ts'
export type { FactModel } from './model.ts'
export { callEdges } from './repair.ts'
export type { HardCallEdge, HardEdgeSource } from './repair.ts'
export { HARD_FEATUREMAP_SCHEMA_VERSION, HardFeatureMapStore } from './store.ts'
export type { HardEdgeRow, HardSnapshotImport, HardSnapshotStats } from './store.ts'
export { hookEdges, phpString, resolveCallback, wordpressEntryPoints, wordpressHooks } from './wordpress.ts'
export type { HardEntryAuth, HardEntryKind, HardEntryPoint, HardHook } from './wordpress.ts'

/**
 * The framework profile that reads hooks and entry points: `wordpress`, or
 * `none` for call edges only.
 */
export type HardFramework = 'none' | 'wordpress'

/** The directories whose top-level PHP files a WordPress install serves directly. */
export const WORDPRESS_SCRIPT_DIRS: readonly string[] = ['.', 'wp-admin', 'wp-admin/network', 'wp-admin/user']

/** Bumped when the rows an import derives from the same facts change. */
const IMPORT_VERSION = 1

/** Feature map plugin config. */
export interface Config {
  /** Import facts. Off by default; it needs `hard-cpg` enabled. */
  enabled?: boolean
  /** Absolute path of the shared database file. Required when enabled. */
  dbPath?: string
  /** The framework profile. */
  framework?: HardFramework
  /**
   * Repository-relative directories (`.` for the root) whose top-level PHP
   * files are requested directly. Empty selects the profile's directories:
   * {@link WORDPRESS_SCRIPT_DIRS} under the WordPress profile, none otherwise.
   */
  scriptDirs?: string[]
  /** Import in the background when a mission arms. */
  indexOnArm?: boolean
}

/** Schemastery config for the feature map plugin. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  dbPath: z.string(),
  framework: z.union(['none', 'wordpress']).default('none'),
  scriptDirs: z.array(z.string()).default([]),
  indexOnArm: z.boolean().default(true),
})

/** Fully materialized plugin inputs. */
interface ResolvedConfig {
  readonly enabled: boolean
  readonly dbPath: string
  readonly framework: HardFramework
  readonly scriptDirs: readonly string[]
  readonly indexOnArm: boolean
}

/** Validate config even when the service is constructed outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const enabled = config.enabled ?? false
  const dbPath = config.dbPath ?? ''
  if (enabled && !isAbsolute(dbPath)) throw new TypeError('dbPath must be an absolute path when hard-featuremap is enabled')
  const framework = config.framework ?? 'none'
  const configured = config.scriptDirs ?? []
  const scriptDirs = configured.length > 0 ? configured : framework === 'wordpress' ? [...WORDPRESS_SCRIPT_DIRS] : []
  for (const dir of scriptDirs) {
    const clean = normalize(dir)
    if (dir.length === 0 || isAbsolute(dir) || clean === '..' || clean.startsWith('../')) {
      throw new TypeError(`scriptDirs entries must be repository-relative directories inside the target: ${JSON.stringify(dir)}`)
    }
  }
  return { enabled, dbPath, framework, scriptDirs: scriptDirs.map(dir => normalize(dir)), indexOnArm: config.indexOnArm ?? true }
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
  static inject = ['agents', 'hardLedger', 'hardCpg']

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
    const { framework, scriptDirs } = this.resolved
    const derivation = createHash('sha256')
      .update([String(IMPORT_VERSION), basename(dirname(facts.path)), framework, ...scriptDirs].join('\0'))
      .digest('hex').slice(0, 16)
    const key = [matrix.targetRepo, facts.commit, derivation].join('\0')
    const pending = this.importing.get(key)
    if (pending !== undefined) return pending
    const run = (async (): Promise<HardFeatureMapSnapshot> => {
      const store = await this.store()
      const existing = store.findSnapshot(matrix.targetRepo, facts.commit, derivation)
      if (existing !== undefined) return { id: existing, commit: facts.commit, stats: store.stats(existing), reused: true }
      const model = await buildModel(readHardCpgFacts(facts.path))
      const hooks = framework === 'wordpress' ? wordpressHooks(model) : []
      const entryPoints = framework === 'wordpress' ? wordpressEntryPoints(model, hooks, scriptDirs) : []
      const id = store.importSnapshot({
        projectRoot: matrix.targetRepo,
        commit: facts.commit,
        derivation,
        framework,
        factsPath: facts.path,
        model,
        edges: [...callEdges(model), ...hookEdges(hooks)],
        hooks,
        entryPoints,
      })
      return { id, commit: facts.commit, stats: store.stats(id), reused: false }
    })()
    this.importing.set(key, run)
    try {
      return await run
    } finally {
      this.importing.delete(key)
    }
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
