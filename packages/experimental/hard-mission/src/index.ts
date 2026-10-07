/**
 * Arms the configured long-running objective as a durable session goal and
 * teaches the mission contract through a `hard:mission` system-prompt section.
 * The plugin mounts beside the goal service: it arms fresh root agents on
 * `startup` and never touches restored, paused, or completed goal state.
 * Arming also pins the configured target — a git repository, a plain
 * directory, or one file — by capturing it into a git snapshot the harness
 * owns outside the target, enumerates the snapshot's files through the shell
 * seam, and appends the coverage matrix as `hard/mission/armed`, recording
 * which modules the coverage cross-check can screen and what any configured
 * exclusion removed.
 * @module @deepseek-ai/dsh-experimental-hard-mission
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { HardMissionArmedData, HardTargetSnapshot } from '@deepseek-ai/dsh-experimental-hard-ledger'
// Loads the declaration-merged `Context` keys this plugin injects.
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { DSH_HOME_DIR_NAME, dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
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

/** Wall-clock budget for one arming git command. */
const ARM_GIT_TIMEOUT_MS = 60_000

/** Stdout budget for the tracked-file listing; truncation fails the arm loudly. */
const ARM_LS_FILES_MAX_BYTES = 1 << 25

/** The pinned target the coverage matrix enumerates. */
export interface TargetConfig {
  /**
   * Absolute path of the target: a git repository, a plain directory, or one
   * file such as a shared library. Required and non-blank: a mission without
   * a target has no coverage denominator and fails loudly.
   */
  repoPath: string
  /**
   * Optional ref a git target's checked-out HEAD must resolve to; arming
   * fails when it does not, and on a target that is not a git work tree.
   * Omitted, the target is captured as it is.
   */
  commit?: string
  /**
   * Absolute directory holding the harness-owned snapshot repositories,
   * omitted for `hard/snapshots` under the DSH home. A root inside the target
   * is kept out of the snapshot.
   */
  snapshotRoot?: string
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
    commit: z.string(),
    snapshotRoot: z.string(),
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
  readonly commit: string | undefined
  readonly snapshotRoot: string
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
  const commit = target.commit
  if (commit !== undefined && (typeof commit !== 'string' || commit.trim().length === 0)) {
    throw new TypeError('target.commit must be a non-empty string when set')
  }
  const snapshotRoot = target.snapshotRoot ?? dshHomePath('hard', 'snapshots')
  if (typeof snapshotRoot !== 'string' || !isAbsolute(snapshotRoot)) {
    throw new TypeError('target.snapshotRoot must be an absolute path')
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
  return { repoPath, commit, snapshotRoot, moduleDepth, excludeGlobs }
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

/** A target resolved for capture: what it is, its work tree, and the paths a single-file target keeps. */
interface TargetShape {
  readonly kind: HardTargetSnapshot['kind']
  /** The directory the snapshot's paths are relative to and PoCs run in. */
  readonly workTree: string
  /** The one file a single-file target captures; absent for directories. */
  readonly file?: string
}

/**
 * Classify the target path: one file, a git work tree (it holds `.git`), or
 * a plain directory. A path that does not exist fails loudly.
 * @param repoPath - the configured absolute target path.
 * @returns the target's kind, work tree, and file.
 */
async function targetShape(repoPath: string): Promise<TargetShape> {
  let info
  try {
    info = await stat(repoPath)
  } catch {
    // ENOENT or EACCES: a target the harness cannot stat cannot be pinned.
    throw new Error(`hard mission: target ${repoPath} does not exist or cannot be read`)
  }
  if (info.isFile()) return { kind: 'file', workTree: dirname(repoPath), file: basename(repoPath) }
  if (!info.isDirectory()) throw new Error(`hard mission: target ${repoPath} is neither a file nor a directory`)
  return { kind: existsSync(join(repoPath, '.git')) ? 'git' : 'directory', workTree: repoPath }
}

/**
 * The harness-owned git directory every snapshot under one root accumulates
 * in. A snapshot commit is a function of its content alone, so one store
 * serves every target: identical files share objects, and each snapshot
 * commit keeps its own ref so it outlives later snapshots.
 * @param snapshotRoot - the configured snapshot root.
 * @returns the absolute git directory path.
 */
export function snapshotGitDir(snapshotRoot: string): string {
  return join(snapshotRoot, 'store.git')
}

/**
 * Git with the developer's global and system configuration switched off, so
 * a snapshot of the same content is the same commit on every machine.
 */
const HERMETIC_GIT = 'GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -c core.autocrlf=false -c core.safecrlf=false'

/** The fixed identity and time that make a snapshot commit a function of its tree alone. */
const SNAPSHOT_IDENTITY = 'GIT_AUTHOR_NAME=dsh-hard GIT_AUTHOR_EMAIL=hard@dsh.invalid GIT_AUTHOR_DATE="@0 +0000" '
  + 'GIT_COMMITTER_NAME=dsh-hard GIT_COMMITTER_EMAIL=hard@dsh.invalid GIT_COMMITTER_DATE="@0 +0000"'

/** A captured target: the snapshot record and the paths outside it. */
interface CapturedTarget {
  readonly snapshot: HardTargetSnapshot
  readonly commit: string
  readonly workTree: string
  readonly ignoredEntryCount: number
}

/**
 * Capture the target into the harness-owned snapshot repository and return
 * its commit. A git work tree contributes its tracked files plus the
 * untracked files its ignore rules keep, with working-tree content; a plain
 * directory contributes every file its ignore files keep; a single file
 * contributes itself. The harness's own state directories and the target's
 * `.git` never enter. Nothing is written inside the target: the index and
 * the objects live in the snapshot repository.
 * @param ctx - the context whose shell seam executes the commands.
 * @param target - the resolved target.
 * @returns the snapshot record, its commit, the work tree, and the ignored-entry count.
 */
async function captureTarget(ctx: Context, target: ResolvedTarget): Promise<CapturedTarget> {
  const shape = await targetShape(target.repoPath)
  if (target.commit !== undefined && shape.kind !== 'git') {
    throw new Error(`hard mission: target.commit applies to a git work tree, and ${target.repoPath} is not one`)
  }
  // The canonical spelling: the record names the store the way every later reader resolves it.
  await mkdir(target.snapshotRoot, { recursive: true })
  const gitDir = snapshotGitDir(await realpath(target.snapshotRoot))
  const git = `${HERMETIC_GIT} --git-dir=${shellQuote(gitDir)} --work-tree=${shellQuote(shape.workTree)}`
  // A private index per capture: concurrent missions share the store, never an index.
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-hard-snapshot-'))
  try {
    return await captureInto(ctx, target, shape, gitDir, git, join(scratch, 'index'), join(scratch, 'pathspec'))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Capture the target with one private index and pathspec file; the body of {@link captureTarget}. */
async function captureInto(
  ctx: Context,
  target: ResolvedTarget,
  shape: TargetShape,
  gitDir: string,
  git: string,
  index: string,
  pathspec: string,
): Promise<CapturedTarget> {
  const statePrefixes = [...harnessStatePrefixes(shape.workTree), ...insidePrefix(shape.workTree, target.snapshotRoot)]
  const kept = (output: string): string[] => output.split('\0')
    .filter(path => path.length > 0 && !statePrefixes.some(prefix => path.startsWith(prefix)))
  if (!existsSync(gitDir)) await gitOutput(ctx, target, `${HERMETIC_GIT} init --bare --quiet ${shellQuote(gitDir)}`, 'init')
  let origin: HardTargetSnapshot['origin']
  let ignored: string[]
  let paths: string[]
  const repo = `git -C ${shellQuote(shape.workTree)}`
  if (shape.kind === 'git') {
    const head = (await gitOutput(ctx, target, `${repo} rev-parse --verify -q HEAD || true`, 'rev-parse HEAD')).trim()
    if (target.commit !== undefined) {
      const wanted = (await gitOutput(ctx, target, `${repo} rev-parse --verify ${shellQuote(`${target.commit}^{commit}`)}`, 'rev-parse')).trim()
      if (wanted !== head) {
        throw new Error(`hard mission: target.commit ${target.commit} is ${wanted}, but ${target.repoPath} has ${head} checked out`)
      }
    }
    const listed = kept(await gitOutput(ctx, target, `${repo} ls-files -z --cached --others --exclude-standard`, 'ls-files'))
    paths = listed.filter(path => existsSync(join(shape.workTree, path)))
    ignored = kept(await gitOutput(ctx, target, `${repo} ls-files -z --others --ignored --exclude-standard --directory`, 'ls-files --ignored'))
    if (head.length > 0) {
      const status = kept((await gitOutput(ctx, target, `${repo} status --porcelain -z --untracked-files=all`, 'status'))
        .split('\0').map(entry => entry.slice(3)).join('\0'))
      origin = { commit: head, dirty: status.length > 0 }
    }
  } else if (shape.kind === 'directory') {
    const excludes = statePrefixes.map(prefix => shellQuote(`:(exclude)${prefix.slice(0, -1)}`)).join(' ')
    paths = kept(await gitOutput(ctx, target,
      `rm -f ${shellQuote(index)} && GIT_INDEX_FILE=${shellQuote(index)} ${git} ls-files -z --others --exclude-standard -- . ${excludes}`, 'ls-files'))
    ignored = kept(await gitOutput(ctx, target,
      `GIT_INDEX_FILE=${shellQuote(index)} ${git} ls-files -z --others --ignored --exclude-standard --directory -- . ${excludes}`, 'ls-files --ignored'))
  } else {
    paths = [shape.file as string]
    ignored = []
  }
  if (paths.length === 0) throw new Error(`hard mission: target ${target.repoPath} holds no file to capture`)
  await writeFile(pathspec, paths.join('\0') + '\0')
  const commit = (await gitOutput(ctx, target, [
    'set -e',
    `rm -f ${shellQuote(index)}`,
    `export GIT_INDEX_FILE=${shellQuote(index)}`,
    `GIT_LITERAL_PATHSPECS=1 ${git} add -f --pathspec-from-file=${shellQuote(pathspec)} --pathspec-file-nul`,
    `tree=$(${git} write-tree)`,
    `commit=$(${SNAPSHOT_IDENTITY} ${git} commit-tree "$tree" -m 'hard target snapshot')`,
    `${git} update-ref "refs/hard/snapshots/$commit" "$commit"`,
    'echo "$commit"',
  ].join('\n'), 'snapshot')).trim()
  /* v8 ignore next -- defensive: the script runs under set -e, so a failed commit-tree fails the command first. */
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(commit)) throw new Error(`hard mission: the snapshot of ${target.repoPath} produced no commit`)
  return {
    snapshot: { gitDir, kind: shape.kind, ...(origin === undefined ? {} : { origin }) },
    commit,
    workTree: shape.workTree,
    ignoredEntryCount: ignored.length,
  }
}

/**
 * List the files the snapshot commit holds, with git's binary
 * classification: a numstat diff of the commit's tree against the empty tree
 * marks binary content `-`, the same content test `grep -I` applies.
 * External diff drivers and textconv filters stay off.
 * @param ctx - the context whose shell seam executes the command.
 * @param target - the resolved target, for diagnostics.
 * @param gitDir - the snapshot repository.
 * @param commit - the snapshot commit.
 * @returns one entry per file, in git's output order.
 */
async function trackedFiles(ctx: Context, target: ResolvedTarget, gitDir: string, commit: string): Promise<TrackedFile[]> {
  const git = `${HERMETIC_GIT} --git-dir=${shellQuote(gitDir)}`
  const output = await gitOutput(
    ctx,
    target,
    `${git} diff --numstat -z --no-renames --no-textconv --no-ext-diff "$(${git} hash-object -t tree /dev/null)" ${shellQuote(commit)}`,
    'diff --numstat',
  )
  return output.split('\0').filter(record => record.length > 0).map((record) => {
    const [added = '', deleted = '', ...rest] = record.split('\t')
    return { path: rest.join('\t'), binary: added === '-' && deleted === '-' }
  })
}

/**
 * Repo-relative directory prefixes of DeepSeek Harness's own state inside the
 * target: the project-local `.dsh/` directory, and the resolved harness home
 * when it lies inside the repository. The harness writes there before the
 * first arming (identity, profile files), so those paths are its own state,
 * not target content the commit should hold, and the session logs there are
 * not target content an independent reader may open.
 * @param repoPath - the absolute target repository path.
 * @returns the forward-slash prefixes, each ending in `/`.
 */
export function harnessStatePrefixes(repoPath: string): string[] {
  return [`${DSH_HOME_DIR_NAME}/`, ...insidePrefix(repoPath, resolveDshHome())]
}

/** The repo-relative prefix of one directory when it lies inside the work tree, else nothing. */
function insidePrefix(repoPath: string, directory: string): string[] {
  const inside = relative(repoPath, directory)
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) ? [`${inside.split(sep).join('/')}/`] : []
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

/**
 * Pin the target once at load: capture it into the harness-owned snapshot,
 * list the snapshot's files, filter them through the configured exclusion
 * globs, group them into modules, and classify which modules the
 * cross-check can screen. Every structural failure is loud here — a mission
 * without a verified matrix must not load at all.
 * @param ctx - the context whose shell seam and ledger the pinning uses.
 * @param resolved - the validated mission config.
 * @returns the armed payload every fresh root agent records, minus the objective.
 */
async function pinTarget(ctx: Context, resolved: ResolvedConfig): Promise<Omit<HardMissionArmedData, 'objective'>> {
  const target = resolved.target
  const captured = await captureTarget(ctx, target)
  const tracked = await trackedFiles(ctx, target, captured.snapshot.gitDir, captured.commit)
  const keptPaths = new Set(filterExcludedPaths(tracked.map(file => file.path), target.excludeGlobs))
  const kept = tracked.filter(file => keptPaths.has(file.path))
  const keptList = kept.map(file => file.path)
  const modules = modulesFromPaths(keptList, target.moduleDepth)
  if (modules.length === 0) {
    throw new Error(`hard mission: no modules survived the exclusion globs in ${target.repoPath}`)
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
  return {
    targetRepo: captured.workTree,
    commit: captured.commit,
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
    ignoredEntryCount: captured.ignoredEntryCount,
    snapshot: captured.snapshot,
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
  const armed = await pinTarget(ctx, resolved)
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
