/**
 * Arms the configured long-running objective as a durable session goal and
 * teaches the mission contract through a `hard:mission` system-prompt section.
 * The plugin mounts beside the goal service: it arms fresh root agents on
 * `startup` and never touches restored, paused, or completed goal state.
 * Arming also pins the configured target repository — it resolves the
 * configured commit to its full sha, enumerates the files that commit tracks
 * through the shell seam, and appends the coverage matrix as
 * `hard/mission/armed`, recording which modules the coverage cross-check can
 * screen and what any configured exclusion removed.
 * @module @deepseek-ai/dsh-experimental-hard-mission
 */

import { isAbsolute, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { HardMissionArmedData } from '@deepseek-ai/dsh-experimental-hard-ledger'
// Loads the declaration-merged `Context` keys this plugin injects.
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { DSH_HOME_DIR_NAME, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { HARD_EXCLUDED_SAMPLE_LIMIT, HARD_MATRIX_MODULE_LIMIT } from '@deepseek-ai/dsh-experimental-hard-ledger'
import { SCREENED_EXTENSIONS } from '@deepseek-ai/dsh-experimental-hard-verifier'
import {
  filterExcludedPaths,
  inertModulesFromPaths,
  INERT_EXTENSIONS,
  modulesFromPaths,
  unscreenedModulesFromFiles,
} from './modules.ts'
import type { TrackedFile } from './modules.ts'

export {
  extensionOf,
  filterExcludedPaths,
  inertModulesFromPaths,
  INERT_EXTENSIONS,
  moduleOfPath,
  modulesFromPaths,
  unscreenedModulesFromFiles,
} from './modules.ts'
export type { TrackedFile } from './modules.ts'

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

/**
 * Default root-anchored globs kept out of the module enumeration: none. The
 * harness audits every file the pinned commit tracks — vendored libraries and
 * built bundles run in production too — so any exclusion is the deployment's
 * explicit choice, recorded in the arming record and reported beside the
 * coverage ratio.
 */
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = []

/** Maximum drifted paths the first-arming refusal lists before it summarizes the rest. */
const DRIFT_LIST_LIMIT = 12

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
  /**
   * Root-anchored globs excluded from the tracked-file enumeration; empty by
   * default. The arming record states what they removed.
   */
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
 * List the files the pinned commit tracks, with git's binary classification:
 * a numstat diff of the commit's tree against the empty tree marks binary
 * content `-`, the same content test `grep -I` applies. The listing reads the
 * commit, not the index or the working tree. External diff drivers and
 * textconv filters stay off, so a target repository cannot run commands
 * through its attributes during arming.
 * @param ctx - the context whose shell seam executes the command.
 * @param target - the resolved target holding the repo path.
 * @param commit - the pinned full commit sha.
 * @returns one entry per tracked file, in git's output order.
 */
async function trackedFiles(ctx: Context, target: ResolvedTarget, commit: string): Promise<TrackedFile[]> {
  const repo = shellQuote(target.repoPath)
  const output = await gitOutput(
    ctx,
    target,
    `git -C ${repo} diff --numstat -z --no-renames --no-textconv --no-ext-diff`
      + ` "$(git -C ${repo} hash-object -t tree /dev/null)" ${shellQuote(commit)}`,
    'diff --numstat',
  )
  return output.split('\0').filter(record => record.length > 0).map((record) => {
    const [added = '', deleted = '', ...rest] = record.split('\t')
    return { path: rest.join('\t'), binary: added === '-' && deleted === '-' }
  })
}

/** How the target working tree departs from the pinned commit at load. */
interface WorkingTreeDrift {
  /** Tracked files whose working-tree content differs from the pinned commit. */
  readonly modified: readonly string[]
  /** Files git neither tracks nor ignores. */
  readonly untracked: readonly string[]
  /** Untracked paths git ignores, one entry per ignored directory. */
  readonly ignoredEntryCount: number
}

/**
 * Repo-relative directory prefixes of DeepSeek Harness's own state inside the
 * target: the project-local `.dsh/` directory, and the resolved harness home
 * when it lies inside the repository. The harness writes there before the
 * first arming (identity, profile files), so those paths are its own state,
 * not target content the commit should hold.
 * @param target - the resolved target holding the repo path.
 * @returns the forward-slash prefixes, each ending in `/`.
 */
function harnessStatePrefixes(target: ResolvedTarget): string[] {
  const prefixes = [`${DSH_HOME_DIR_NAME}/`]
  const home = relative(target.repoPath, resolveDshHome())
  if (home !== '' && !home.startsWith('..') && !isAbsolute(home)) prefixes.push(`${home.split(sep).join('/')}/`)
  return prefixes
}

/**
 * Measure how the target working tree departs from the pinned commit. The
 * model reads and runs the working tree while the matrix and every citation
 * resolve against the commit, so a first arming over modified or untracked
 * files would audit a tree the model never sees. Paths under the harness's
 * own state directories are not drift.
 * @param ctx - the context whose shell seam executes the commands.
 * @param target - the resolved target holding the repo path.
 * @param commit - the pinned full commit sha.
 * @returns the modified and untracked paths and the ignored-entry count.
 */
async function workingTreeDrift(ctx: Context, target: ResolvedTarget, commit: string): Promise<WorkingTreeDrift> {
  const repo = shellQuote(target.repoPath)
  const statePrefixes = harnessStatePrefixes(target)
  const paths = (output: string): string[] => output.split('\0')
    .filter(path => path.length > 0 && !statePrefixes.some(prefix => path.startsWith(prefix)))
  const modified = paths(await gitOutput(
    ctx, target, `git -C ${repo} diff --name-only -z --no-ext-diff ${shellQuote(commit)} --`, 'diff --name-only',
  ))
  const untracked = paths(await gitOutput(
    ctx, target, `git -C ${repo} ls-files --others --exclude-standard -z`, 'ls-files --others',
  ))
  const ignored = paths(await gitOutput(
    ctx, target, `git -C ${repo} ls-files --others --ignored --exclude-standard --directory -z`, 'ls-files --ignored',
  ))
  return { modified, untracked, ignoredEntryCount: ignored.length }
}

/**
 * The first-arming refusal over a drifted working tree, naming the bounded
 * set of offending paths.
 * @param target - the resolved target holding the repo path.
 * @param commit - the pinned full commit sha.
 * @param drift - the measured drift; at least one path is present.
 * @returns the error to throw.
 */
function driftError(target: ResolvedTarget, commit: string, drift: WorkingTreeDrift): Error {
  const entries = [
    ...drift.modified.map(path => `${path} (modified)`),
    ...drift.untracked.map(path => `${path} (untracked)`),
  ].sort()
  const listed = entries.length > DRIFT_LIST_LIMIT
    ? [...entries.slice(0, DRIFT_LIST_LIMIT), `…and ${entries.length - DRIFT_LIST_LIMIT} more`]
    : entries
  return new Error(
    `hard mission: target working tree differs from the pinned commit ${commit} in ${target.repoPath}: `
    + `${listed.join(', ')}; commit or remove them — the harness audits only what the pinned commit holds`,
  )
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
    + 'Every PoC takes its exploit input as $1 and must fail when the harness re-runs it with a benign '
    + 'payload: the proof must depend on the payload (the specificity check). '
    + 'Ending a turn does not end the mission.'
}

/** The pinned matrix plus the working-tree drift the first arming checks. */
interface PinnedTarget {
  readonly armed: Omit<HardMissionArmedData, 'objective'>
  readonly drift: WorkingTreeDrift
}

/**
 * Pin the target once at load: resolve the commit, list the files it tracks,
 * filter them through the configured exclusion globs, group them into
 * modules, and classify which modules the cross-check can screen. Every
 * structural failure is loud here — a mission without a verified matrix must
 * not load at all. Working-tree drift is only measured: a resumed session
 * loads over the files its own run created, so the drift refusal belongs to
 * the first arming.
 * @param ctx - the context whose shell seam and ledger the pinning uses.
 * @param resolved - the validated mission config.
 * @returns the armed payload every fresh root agent records, minus the objective, and the measured drift.
 */
async function pinTarget(ctx: Context, resolved: ResolvedConfig): Promise<PinnedTarget> {
  const target = resolved.target
  const commit = await pinnedCommit(ctx, target)
  const tracked = await trackedFiles(ctx, target, commit)
  const keptPaths = new Set(filterExcludedPaths(tracked.map(file => file.path), target.excludeGlobs))
  const kept = tracked.filter(file => keptPaths.has(file.path))
  const keptList = kept.map(file => file.path)
  const modules = modulesFromPaths(keptList, target.moduleDepth)
  if (modules.length === 0) {
    throw new Error(`hard mission: no tracked modules survived the exclusion globs in ${target.repoPath}`)
  }
  if (modules.length > HARD_MATRIX_MODULE_LIMIT) {
    const advice = target.moduleDepth > 1
      ? `lower target.moduleDepth from ${target.moduleDepth} so modules group coarser`
      : 'the target is too large for one mission even at the coarsest module grouping'
    throw new Error(`hard mission: ${modules.length} modules exceed the ${HARD_MATRIX_MODULE_LIMIT}-row log cap; ${advice}`)
  }
  const inertModules = inertModulesFromPaths(keptList, target.moduleDepth, INERT_EXTENSIONS)
  if (inertModules.length === modules.length) {
    throw new Error(`hard mission: target has no code modules — every module in ${target.repoPath} holds only inert files`)
  }
  const excluded = tracked.filter(file => !keptPaths.has(file.path)).map(file => file.path).sort()
  const drift = await workingTreeDrift(ctx, target, commit)
  return {
    armed: {
      targetRepo: target.repoPath,
      commit,
      modules,
      bugClasses: [...resolved.bugClasses],
      inertModules,
      unscreenedModules: unscreenedModulesFromFiles(kept, target.moduleDepth, INERT_EXTENSIONS, SCREENED_EXTENSIONS),
      ...(target.excludeGlobs.length === 0 ? {} : {
        exclusions: {
          globs: [...target.excludeGlobs],
          fileCount: excluded.length,
          sample: excluded.slice(0, HARD_EXCLUDED_SAMPLE_LIMIT),
        },
      }),
      ignoredEntryCount: drift.ignoredEntryCount,
    },
    drift,
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
  const { armed, drift } = await pinTarget(ctx, resolved)
  ctx.on('agent/created', ({ agent, source }) => {
    if (source !== 'startup') return
    if (!ctx.agents.roots().includes(agent)) return
    if (ctx.goals.get(agent) !== undefined) return
    // The first arming fails loud over drift; throwing here rejects the root
    // agent's registration before any goal or ledger record exists.
    if (drift.modified.length > 0 || drift.untracked.length > 0) throw driftError(resolved.target, armed.commit, drift)
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
