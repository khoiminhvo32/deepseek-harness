/**
 * Arms the configured long-running objective as a durable session goal and
 * teaches the mission contract through a `hard:mission` system-prompt section.
 * The plugin mounts beside the goal service: it arms fresh root agents on
 * `startup` and never touches restored, paused, or completed goal state.
 * Arming also pins the configured target repository — it resolves the
 * configured commit to its full sha, enumerates the tracked modules through
 * the shell seam, and appends the coverage matrix as `hard/mission/armed`.
 * @module @deepseek-ai/dsh-experimental-hard-mission
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { HardMissionArmedData } from '@deepseek-ai/dsh-experimental-hard-ledger'
// Loads the declaration-merged `Context` keys this plugin injects.
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { HARD_MATRIX_MODULE_LIMIT } from '@deepseek-ai/dsh-experimental-hard-ledger'
import { filterExcludedPaths, inertModulesFromPaths, INERT_EXTENSIONS, modulesFromPaths } from './modules.ts'

export { filterExcludedPaths, inertModulesFromPaths, INERT_EXTENSIONS, moduleOfPath, modulesFromPaths } from './modules.ts'

export const name = 'hard-mission'
export const inject = ['agents', 'goals', 'systemPrompt', 'shell', 'hardLedger']

/**
 * Bug classes the default mission contract sweeps in its systematic pass:
 * every OWASP Top 10 class with mechanical source-to-sink semantics, with
 * authentication surfaced as its distinct bypass flavors. Insecure design and
 * security logging stay in the deep-reading pass, where hypotheses rather
 * than source-sink patterns find them.
 */
export const DEFAULT_BUG_CLASSES: readonly string[] = [
  'sqli',
  'xss',
  'cmdi',
  'path-traversal',
  'open-redirect',
  'deserialization',
  'ssrf',
  'authn',
  'authn-bypass',
  'login-bypass',
  'oauth-bypass',
  'session',
  'authz',
  'crypto-misuse',
  'misconfig',
  'dependencies',
  'race',
]

/** Default automatic continuation-round cap handed to the created goal. */
export const DEFAULT_MAX_GOAL_ROUNDS = 64

/** Default number of systematic passes between deep-reading passes. */
export const DEFAULT_DEEP_READ_EVERY_N = 3

/** Default target commit ref, resolved to its full sha at arm time. */
export const DEFAULT_TARGET_COMMIT = 'HEAD'

/** Default directory segments per coverage module. */
export const DEFAULT_MODULE_DEPTH = 2

/** Default root-anchored globs kept out of the module enumeration. */
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  'node_modules/**',
  'vendor/**',
  'dist/**',
  'build/**',
  '.git/**',
  'docs/**',
  'doc/**',
  'locales/**',
  'i18n/**',
  'assets/**',
  'fixtures/**',
  'testdata/**',
  '__snapshots__/**',
  '**/*.min.js',
]

/** Wall-clock budget for one arming git command. */
const ARM_GIT_TIMEOUT_MS = 60_000

/** Stdout budget for the tracked-file listing; truncation fails the arm loudly. */
const ARM_LS_FILES_MAX_BYTES = 1 << 25

/** The pinned target repository the coverage matrix enumerates. */
export interface TargetConfig {
  /**
   * Absolute path of the target git repository. Required and non-blank: a
   * mission without a target has no coverage denominator and fails loudly.
   */
  repoPath: string
  /** Ref or sha to pin; resolved to the full commit sha at arm time. */
  commit?: string
  /** Directory segments per coverage module, 1 through 6. */
  moduleDepth?: number
  /** Root-anchored globs excluded from the tracked-file enumeration. */
  excludeGlobs?: string[]
}

/** Mission plugin config. */
export interface Config {
  /**
   * The durable objective the session must keep working toward. Required and
   * non-blank: a mission without an objective fails loudly at load.
   */
  objective: string
  /** Positive safe-integer cap on automatic continuation rounds. */
  maxGoalRounds?: number
  /**
   * Bug classes the systematic pass sweeps, named in the mission contract.
   * An empty list removes the class list from the contract.
   */
  bugClasses?: string[]
  /** Number of systematic passes between deep-reading passes. */
  deepReadEveryN?: number
  /** The target repository pinned and enumerated when the goal arms. */
  target: TargetConfig
}

/** Schemastery config for the mission plugin. */
export const Config: z<Config> = z.object({
  objective: z.string().required(),
  maxGoalRounds: z.number().step(1).min(1).default(DEFAULT_MAX_GOAL_ROUNDS),
  bugClasses: z.array(z.string()).default([...DEFAULT_BUG_CLASSES]),
  deepReadEveryN: z.number().step(1).min(1).default(DEFAULT_DEEP_READ_EVERY_N),
  target: z.object({
    repoPath: z.string().required(),
    commit: z.string().default(DEFAULT_TARGET_COMMIT),
    moduleDepth: z.number().step(1).min(1).max(6).default(DEFAULT_MODULE_DEPTH),
    excludeGlobs: z.array(z.string()).default([...DEFAULT_EXCLUDE_GLOBS]),
  }).required(),
})

/** Fully materialized mission contract inputs. */
interface ResolvedConfig {
  readonly objective: string
  readonly maxGoalRounds: number
  readonly bugClasses: readonly string[]
  readonly deepReadEveryN: number
  readonly target: ResolvedTarget
}

/** Fully materialized target-pinning inputs. */
export interface ResolvedTarget {
  readonly repoPath: string
  readonly commit: string
  readonly moduleDepth: number
  readonly excludeGlobs: readonly string[]
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const { objective } = config
  if (typeof objective !== 'string' || objective.trim().length === 0) {
    throw new TypeError('objective must be a non-empty string')
  }
  const maxGoalRounds = config.maxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS
  if (!Number.isSafeInteger(maxGoalRounds) || maxGoalRounds < 1) {
    throw new TypeError('maxGoalRounds must be a positive safe integer')
  }
  const bugClasses = config.bugClasses ?? [...DEFAULT_BUG_CLASSES]
  if (!Array.isArray(bugClasses)
    || bugClasses.some(bugClass => typeof bugClass !== 'string' || bugClass.trim().length === 0)) {
    throw new TypeError('bugClasses must be an array of non-empty class names')
  }
  const deepReadEveryN = config.deepReadEveryN ?? DEFAULT_DEEP_READ_EVERY_N
  if (!Number.isSafeInteger(deepReadEveryN) || deepReadEveryN < 1) {
    throw new TypeError('deepReadEveryN must be a positive safe integer')
  }
  return {
    objective,
    maxGoalRounds,
    bugClasses,
    deepReadEveryN,
    target: resolveTarget(config.target),
  }
}

/** Validate and default the target config; every branch fails loud. */
function resolveTarget(target: TargetConfig | undefined): ResolvedTarget {
  if (target === undefined || typeof target !== 'object') {
    throw new TypeError('target is required: set target.repoPath to the target repository')
  }
  const { repoPath } = target
  if (typeof repoPath !== 'string' || repoPath.trim().length === 0) {
    throw new TypeError('target.repoPath must be a non-empty string')
  }
  if (!isAbsolute(repoPath)) {
    throw new TypeError('target.repoPath must be an absolute path')
  }
  const commit = target.commit ?? DEFAULT_TARGET_COMMIT
  if (typeof commit !== 'string' || commit.trim().length === 0) {
    throw new TypeError('target.commit must be a non-empty string')
  }
  const moduleDepth = target.moduleDepth ?? DEFAULT_MODULE_DEPTH
  if (!Number.isSafeInteger(moduleDepth) || moduleDepth < 1 || moduleDepth > 6) {
    throw new TypeError('target.moduleDepth must be a safe integer between 1 and 6')
  }
  const excludeGlobs = target.excludeGlobs ?? [...DEFAULT_EXCLUDE_GLOBS]
  if (!Array.isArray(excludeGlobs)
    || excludeGlobs.some(glob => typeof glob !== 'string' || glob.trim().length === 0)) {
    throw new TypeError('target.excludeGlobs must be an array of non-empty globs')
  }
  return { repoPath, commit, moduleDepth, excludeGlobs }
}

/** POSIX-quote one argument of an arming git command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Run one read-only git command against the pinned target through the shell
 * seam and return its complete stdout.
 * @param ctx - the context whose shell seam executes the command.
 * @param target - the resolved target the command runs against.
 * @param command - the full git command line; every variable argument is pre-quoted.
 * @param label - the command name used in failure diagnostics.
 * @returns the complete stdout text.
 */
async function gitOutput(ctx: Context, target: ResolvedTarget, command: string, label: string): Promise<string> {
  const spec = ctx.shell.resolve({
    command,
    timeoutMs: ARM_GIT_TIMEOUT_MS,
    stdoutMaxBytes: ARM_LS_FILES_MAX_BYTES,
  })
  const execution = await ctx.shell.execute(spec)
  const result = await execution.result()
  if (result.timedOut || result.aborted || result.exitCode !== 0) {
    const detail = result.stderr.text.trim().slice(-400) || `exit ${result.exitCode}`
    throw new Error(`hard mission: git ${label} failed in ${target.repoPath}: ${detail}`)
  }
  if (result.stdout.truncated) {
    throw new Error(`hard mission: git ${label} output exceeded the capture budget in ${target.repoPath}`)
  }
  return result.stdout.text
}

/**
 * Resolve the configured commit to the full sha the enumeration pins.
 * @param ctx - the context whose shell seam executes the command.
 * @param target - the resolved target holding the repo path and ref.
 * @returns the full lowercase hex commit sha.
 */
async function pinnedCommit(ctx: Context, target: ResolvedTarget): Promise<string> {
  const output = await gitOutput(
    ctx,
    target,
    `git -C ${shellQuote(target.repoPath)} rev-parse ${shellQuote(target.commit)}`,
    'rev-parse',
  )
  const sha = output.trim().split('\n')[0] ?? ''
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
    throw new Error(`hard mission: target.commit ${target.commit} did not resolve to a full sha in ${target.repoPath}`)
  }
  return sha
}

/**
 * List the tracked file paths at the pinned repository.
 * @param ctx - the context whose shell seam executes the command.
 * @param target - the resolved target holding the repo path.
 * @returns repo-relative forward-slash paths, in git's output order.
 */
async function trackedFiles(ctx: Context, target: ResolvedTarget): Promise<string[]> {
  const output = await gitOutput(ctx, target, `git -C ${shellQuote(target.repoPath)} ls-files -z`, 'ls-files')
  return output.split('\0').filter(path => path.length > 0)
}

/** Render the model-facing mission contract from the resolved config. */
function missionContract(resolved: ResolvedConfig): string {
  const sweep = resolved.bugClasses.length > 0
    ? `Systematic passes sweep these bug classes: ${resolved.bugClasses.join(', ')}. `
    : ''
  return `Mission: ${resolved.objective} `
    + 'This session carries one durable goal and keeps working toward it across turns. '
    + 'Do not stop to announce progress while concrete work remains; take the next action instead. '
    + sweep
    + `Every ${resolved.deepReadEveryN} systematic passes, run a deep-reading pass that models dataflow, `
    + 'trust boundaries, and state machines to form and test hypotheses beyond pattern matching. '
    + 'Propose completion with update_goal action complete once the objective is genuinely achieved; '
    + 'the harness, not you, certifies it — an early attempt is denied with the exact remaining work, '
    + 'and an empty sweep only counts when it cites a refuted hypothesis or a cell you cleared. '
    + 'Ending a turn does not end the mission.'
}

/**
 * Pin the target once at load: resolve the commit, filter the tracked files
 * through the exclusion globs, and group them into modules. Every failure is
 * loud here — a mission without a verified matrix must not load at all.
 * @param ctx - the context whose shell seam and ledger the pinning uses.
 * @param resolved - the validated mission config.
 * @returns the armed payload every root agent records, minus the objective.
 */
async function armTargetMatrix(ctx: Context, resolved: ResolvedConfig): Promise<Omit<HardMissionArmedData, 'objective'>> {
  const target = resolved.target
  const commit = await pinnedCommit(ctx, target)
  const tracked = await trackedFiles(ctx, target)
  const kept = filterExcludedPaths(tracked, target.excludeGlobs)
  const modules = modulesFromPaths(kept, target.moduleDepth)
  if (modules.length === 0) {
    throw new Error(`hard mission: no tracked modules survived the exclusion globs in ${target.repoPath}`)
  }
  if (modules.length > HARD_MATRIX_MODULE_LIMIT) {
    throw new Error(
      `hard mission: ${modules.length} modules exceed the ${HARD_MATRIX_MODULE_LIMIT}-row log cap; `
      + `lower target.moduleDepth from ${target.moduleDepth} or exclude more trees`,
    )
  }
  const inertModules = inertModulesFromPaths(kept, target.moduleDepth, INERT_EXTENSIONS)
  if (inertModules.length === modules.length) {
    throw new Error(`hard mission: target has no code modules — every module in ${target.repoPath} holds only inert files`)
  }
  return {
    targetRepo: target.repoPath,
    commit,
    modules,
    bugClasses: [...resolved.bugClasses],
    inertModules,
  }
}

/** Register the mission contract section, pin the target, and arm fresh root goals on startup. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'hard:mission',
    order: ctx.systemPrompt.getSectionOrder('HARD_MISSION'),
    text: missionContract(resolved),
  })
  const armed = await armTargetMatrix(ctx, resolved)
  ctx.on('agent/created', ({ agent, source }) => {
    if (source !== 'startup') return
    if (!ctx.agents.roots().includes(agent)) return
    if (ctx.goals.get(agent) !== undefined) return
    const goal = ctx.goals.create(agent, {
      objective: resolved.objective,
      maxGoalRounds: resolved.maxGoalRounds,
    })
    ctx.hardLedger.recordMissionArmed(agent, {
      objective: resolved.objective,
      ...armed,
      goalId: goal.id,
    })
  })
}
