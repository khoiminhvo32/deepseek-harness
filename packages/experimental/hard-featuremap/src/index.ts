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
import { readHardCpgFacts } from '@deepseek-ai/dsh-experimental-hard-cpg'
import { buildModel } from './model.ts'
import { callEdges } from './repair.ts'
import { HardFeatureMapStore } from './store.ts'
import type { HardEdgeRow, HardSnapshotStats } from './store.ts'
import { httpEntryPoints } from './http.ts'
import type { HardHttpFramework } from './http.ts'
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
export { httpEntryPoints } from './http.ts'
export type { HardHttpFramework } from './http.ts'

/** A framework profile that reads entry points: WordPress, or one of the HTTP route profiles. */
export type HardFramework = 'wordpress' | HardHttpFramework

/** Every framework profile, in the order an import reads them. */
export const HARD_FRAMEWORKS: readonly HardFramework[] = ['wordpress', 'laravel', 'spring', 'aspnet', 'flask', 'fastapi', 'express']

/** The directories whose top-level PHP files a WordPress install serves directly. */
export const WORDPRESS_SCRIPT_DIRS: readonly string[] = ['.', 'wp-admin', 'wp-admin/network', 'wp-admin/user']

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
}

/** Schemastery config for the feature map plugin. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  dbPath: z.string(),
  frameworks: z.array(z.union([...HARD_FRAMEWORKS])).default([]),
  scriptDirs: z.array(z.string()).default([]),
  indexOnArm: z.boolean().default(true),
})

/** Fully materialized plugin inputs. */
interface ResolvedConfig {
  readonly enabled: boolean
  readonly dbPath: string
  readonly frameworks: readonly HardFramework[]
  readonly scriptDirs: readonly string[]
  readonly indexOnArm: boolean
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
  return { enabled, dbPath, frameworks, scriptDirs: scriptDirs.map(dir => normalize(dir)), indexOnArm: config.indexOnArm ?? true }
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
    const { frameworks, scriptDirs } = this.resolved
    const derivation = createHash('sha256')
      .update([String(IMPORT_VERSION), basename(dirname(facts.path)), frameworks.join(','), ...scriptDirs].join('\0'))
      .digest('hex').slice(0, 16)
    const key = [matrix.targetRepo, facts.commit, derivation].join('\0')
    const pending = this.importing.get(key)
    if (pending !== undefined) return pending
    const run = (async (): Promise<HardFeatureMapSnapshot> => {
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
