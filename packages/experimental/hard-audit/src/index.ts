/**
 * Independent, blind audit of cleared coverage cells, in shadow mode. When
 * the mission agent clears a cell, the plugin samples the clear by its tier,
 * records the request, and has a fresh spawned reader — told the cell, the
 * pinned target, and a neutral bug-class definition, never the mission
 * agent's verdict, declared sites, notes, flow documents, hypotheses,
 * findings, or other audits — look for a vulnerability in that cell. The
 * result is recorded beside the clear and changes nothing the mission agent
 * sees: no open work, no gate decision, no message. It measures the cost,
 * flag rate, and precision of an independent reader before any of it binds.
 * @module @deepseek-ai/dsh-experimental-hard-audit
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Loads the declaration-merged `Context` keys this plugin injects.
import type {} from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-shell'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { cellSampledForPercent, classScope } from '@deepseek-ai/dsh-experimental-hard-ledger'
import type { HardCoverageMatrix } from '@deepseek-ai/dsh-experimental-hard-ledger'
import type {} from '@deepseek-ai/dsh-experimental-hard-verifier'
import { extensionOf, harnessStatePrefixes, INERT_EXTENSIONS } from '@deepseek-ai/dsh-experimental-hard-mission'
import type {
  HardAuditLocation,
  HardAuditRequestedData,
  HardAuditResultData,
  HardAuditTier,
  HardAuditUnavailableCause,
  HardAuditUsage,
} from './domain.ts'
import { auditCellKey, chargedAudits, hardAuditProjectionDefinition } from './projection.ts'
import { parseReaderReport, READER_PERSONA, READER_REPORT_SCHEMA, readerPrompt } from './prompt.ts'
import type { HardAuditProjectionState } from './projection.ts'
import type { ReaderReport } from './prompt.ts'
import { firstContaminatingRead, namedPaths, readAccessOf } from './reads.ts'
import type { ReaderAccess } from './reads.ts'

export const name = 'hard-audit'
export const inject = ['agents', 'sessionProjections', 'subagents', 'shell', 'hardLedger', 'hardVerifier']

export type {
  HardAuditLocation,
  HardAuditOutcome,
  HardAuditRequestedData,
  HardAuditResultData,
  HardAuditTier,
  HardAuditUnavailableCause,
  HardAuditUsage,
} from './domain.ts'
export type { HardAuditProjectionState } from './projection.ts'
export { applyHardAuditProjection, auditCellKey, chargedAudits, hardAuditProjectionDefinition } from './projection.ts'
export { BUG_CLASS_DEFINITIONS, parseReaderReport, READER_PERSONA, READER_REPORT_SCHEMA, readerPrompt } from './prompt.ts'
export type { ReaderCell, ReaderReport } from './prompt.ts'
export { firstContaminatingRead, namedPaths, readAccessOf } from './reads.ts'
export type { ReaderAccess, ReadScope } from './reads.ts'

/** Default reader tools: the read-only file tools every base composition mounts. */
export const DEFAULT_READER_TOOLS: readonly string[] = ['read', 'read_image', 'glob', 'grep']

/** Default share of unscreened-module clears audited. */
export const DEFAULT_UNSCREENED_AUDIT_PERCENT = 50

/** Default share of batch-screen clears audited. */
export const DEFAULT_BATCH_AUDIT_PERCENT = 25

/** Default share of screenable per-cell clears audited. */
export const DEFAULT_AUDIT_PERCENT = 10

/** Default number of audits one mission may charge. */
export const DEFAULT_MAX_AUDITS_PER_MISSION = 12

/** Default number of readers running at once. */
export const DEFAULT_MAX_CONCURRENT_AUDITS = 1

/** Default wall-clock budget of one reader, in minutes. */
export const DEFAULT_AUDIT_TIMEOUT_MINUTES = 20

/** Default wall-clock budget of one workspace git check, in seconds. */
export const DEFAULT_GIT_TIMEOUT_SECONDS = 60

/** Largest git output one workspace check reads; a longer output fails the check closed. */
const GIT_STDOUT_MAX_BYTES = 1_048_576

/** Locations one flagged result keeps. */
const RESULT_LOCATION_LIMIT = 20

/** Characters one result reason keeps. */
const RESULT_REASON_LIMIT = 2_000

/** Reader tool names that expose the mission agent's claims or goal: the ledger, session history, and the goal tools. */
const CLAIM_EXPOSING_TOOL = /^(?:hard_|session_)|goal/u

/** Audit plugin config. */
export interface Config {
  /**
   * Master switch; `false` registers nothing. Audits spend model tokens on
   * a cold context each, so a deployment opts in.
   */
  enabled?: boolean
  /**
   * The `ctx.subagents` provider that runs the reader. It must start a fresh
   * child that never inherits the parent conversation — a fork provider
   * would hand the reader every claim it must not see — and must run in
   * process, so the reader's reads can be checked.
   */
  auditProvider?: string
  /**
   * Optional reader route. A different model family from the mission agent
   * is the strongest independence; omitted, the reader uses the mission
   * agent's route.
   */
  auditModel?: {
    /** The reader's provider route; omitted keeps the mission agent's. */
    provider?: string
    /** The reader's model id; omitted keeps the mission agent's. */
    model?: string
  }
  /**
   * The global tools the reader keeps, as an allow-list: tools added to the
   * composition later stay hidden from it. Ledger, session, and goal tools
   * are refused because they expose the mission agent's claims.
   */
  readerTools?: string[]
  /** Percent of model clears in modules the grep cross-check cannot screen to audit, 0 through 100. */
  unscreenedAuditPercent?: number
  /** Percent of batch-screen clears to audit, 0 through 100. */
  batchAuditPercent?: number
  /** Percent of screenable per-cell model clears to audit, 0 through 100. */
  auditPercent?: number
  /** Audits one mission may charge; a sampled clear past it is recorded as unavailable for budget. */
  maxAuditsPerMission?: number
  /** Readers running at once, across every mission in the process. */
  maxConcurrentAudits?: number
  /** Wall-clock budget of one reader in minutes; a reader past it is cancelled. */
  auditTimeoutMinutes?: number
  /** Wall-clock budget of one workspace git check in seconds. */
  gitTimeoutSeconds?: number
}

/** Schemastery config for the audit plugin. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  auditProvider: z.string().default('spawn'),
  auditModel: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  readerTools: z.array(z.string()).default([...DEFAULT_READER_TOOLS]),
  unscreenedAuditPercent: z.number().step(1).min(0).max(100).default(DEFAULT_UNSCREENED_AUDIT_PERCENT),
  batchAuditPercent: z.number().step(1).min(0).max(100).default(DEFAULT_BATCH_AUDIT_PERCENT),
  auditPercent: z.number().step(1).min(0).max(100).default(DEFAULT_AUDIT_PERCENT),
  maxAuditsPerMission: z.number().step(1).min(0).default(DEFAULT_MAX_AUDITS_PER_MISSION),
  maxConcurrentAudits: z.number().step(1).min(1).max(8).default(DEFAULT_MAX_CONCURRENT_AUDITS),
  auditTimeoutMinutes: z.number().step(1).min(1).default(DEFAULT_AUDIT_TIMEOUT_MINUTES),
  gitTimeoutSeconds: z.number().step(1).min(1).default(DEFAULT_GIT_TIMEOUT_SECONDS),
})

/** Fully materialized audit inputs. */
interface ResolvedConfig {
  readonly enabled: boolean
  readonly auditProvider: string
  readonly auditModel: { readonly provider?: string; readonly model?: string } | undefined
  readonly readerTools: readonly string[]
  readonly percents: Readonly<Record<HardAuditTier, number>>
  readonly maxAuditsPerMission: number
  readonly maxConcurrentAudits: number
  readonly auditTimeoutMs: number
  readonly gitTimeoutMs: number
}

/** Validate one integer config field against its inclusive range. */
function integerIn(field: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${field} must be a safe integer from ${min} through ${max}`)
  }
  return value
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const readerTools = config.readerTools ?? [...DEFAULT_READER_TOOLS]
  if (readerTools.length === 0 || readerTools.some(tool => tool.length === 0)) {
    throw new TypeError('readerTools must name at least one tool, each non-empty')
  }
  const exposing = readerTools.filter(tool => CLAIM_EXPOSING_TOOL.test(tool))
  if (exposing.length > 0) {
    throw new TypeError(`readerTools must not expose the mission agent's claims: ${exposing.join(', ')}`)
  }
  const auditProvider = config.auditProvider ?? 'spawn'
  if (auditProvider.length === 0) throw new TypeError('auditProvider must name a subagent provider')
  const model = config.auditModel
  const auditModel = model === undefined || (model.provider === undefined && model.model === undefined)
    ? undefined
    : {
      ...model.provider === undefined ? {} : { provider: model.provider },
      ...model.model === undefined ? {} : { model: model.model },
    }
  const unbounded = Number.MAX_SAFE_INTEGER
  return {
    enabled: config.enabled ?? false,
    auditProvider,
    auditModel,
    readerTools,
    percents: {
      'unscreened': integerIn('unscreenedAuditPercent', config.unscreenedAuditPercent ?? DEFAULT_UNSCREENED_AUDIT_PERCENT, 0, 100),
      'batch': integerIn('batchAuditPercent', config.batchAuditPercent ?? DEFAULT_BATCH_AUDIT_PERCENT, 0, 100),
      'per-cell': integerIn('auditPercent', config.auditPercent ?? DEFAULT_AUDIT_PERCENT, 0, 100),
    },
    maxAuditsPerMission: integerIn('maxAuditsPerMission', config.maxAuditsPerMission ?? DEFAULT_MAX_AUDITS_PER_MISSION, 0, unbounded),
    maxConcurrentAudits: integerIn('maxConcurrentAudits', config.maxConcurrentAudits ?? DEFAULT_MAX_CONCURRENT_AUDITS, 1, 8),
    auditTimeoutMs: integerIn('auditTimeoutMinutes', config.auditTimeoutMinutes ?? DEFAULT_AUDIT_TIMEOUT_MINUTES, 1, unbounded) * 60_000,
    gitTimeoutMs: integerIn('gitTimeoutSeconds', config.gitTimeoutSeconds ?? DEFAULT_GIT_TIMEOUT_SECONDS, 1, unbounded) * 1_000,
  }
}

/**
 * The audit tier of one coverage verdict, or undefined when the verdict is
 * not a model clear the reader should re-read.
 * @param data - the committed coverage verdict.
 * @param matrix - the armed matrix the verdict belongs to.
 * @returns the tier, or undefined for non-clears and harness clears.
 */
function tierOf(data: SessionEvent<'hard/coverage/cell'>['data'], matrix: HardCoverageMatrix): HardAuditTier | undefined {
  if (data.verdict !== 'cleared' || data.source === 'harness') return undefined
  if (data.source === 'model-verified') return 'batch'
  const unscreened = classScope(data.bugClass) === 'module' && (matrix.unscreenedModules ?? []).includes(data.module)
  return unscreened ? 'unscreened' : 'per-cell'
}

/** POSIX-quote one argument of a workspace git command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * The git pathspec covering one audited cell: the whole repository minus the
 * harness's own state for a repository-scoped class, the root files for the
 * root module, and the module directory otherwise.
 */
function cellPathspec(module: string, repoScoped: boolean, targetRepo: string): string {
  if (repoScoped) {
    return ['.', ...harnessStatePrefixes(targetRepo).map(prefix => `:(exclude)${prefix.slice(0, -1)}`)]
      .map(shellQuote).join(' ')
  }
  return shellQuote(module === '.' ? ':(glob)*' : module)
}

/** Whether one cited path names code inside the audited cell. */
function inCell(path: string, module: string, repoScoped: boolean): boolean {
  if (repoScoped) return true
  return module === '.' ? !path.includes('/') : path.startsWith(`${module}/`)
}

/** Whether one cited path is repository-relative and stays inside the repository. */
function repoRelative(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..')
}

/** The message of one thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Bound one reason to the stored length. */
function bounded(reason: string): string {
  return reason.length > RESULT_REASON_LIMIT ? `${reason.slice(0, RESULT_REASON_LIMIT - 1)}…` : reason
}

/** The live observation of one reader session, fed by its committed events. */
interface ReaderObservation {
  readonly accesses: ReaderAccess[]
  readonly ownOutputs: Set<string>
  readonly usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
}

/** One queued audit: the mission agent and the request it recorded. */
interface AuditJob {
  readonly agentId: SessionId
  readonly request: HardAuditRequestedData
}

/** The identity of one job across the queue, the running set, and resume. */
function jobKey(job: AuditJob): string {
  return `${job.agentId}\u0000${auditCellKey(job.request)}\u0000${job.request.auditedSeq}`
}

/** Register the audit projection, the clear listener, the reader observation, and the audit queue. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  ctx.sessionProjections.register(hardAuditProjectionDefinition)

  const queue: AuditJob[] = []
  const known = new Set<string>()
  const running = new Map<string, { readonly agentId: SessionId; readonly controller: AbortController }>()
  /** Reader observations awaiting their child's descriptor, by the unique run label. */
  const labeled = new Map<string, ReaderObservation>()
  /** Reader observations by child session id. */
  const readers = new Map<SessionId, ReaderObservation>()

  ctx.effect(() => () => {
    for (const { controller } of running.values()) controller.abort(new Error('hard-audit disposed'))
    running.clear()
    queue.length = 0
    known.clear()
  }, 'hard-audit: cancel running readers')

  /** The mission's folded audit state. */
  function auditState(agent: Agent): HardAuditProjectionState {
    const state = ctx.sessionProjections.stateOf(agent.session, 'hardAudit')
    /* v8 ignore next -- defensive: apply registers the unit before any listener can read it. */
    if (state === undefined) throw new HarnessError('hard audit: the hardAudit projection is not registered', 'HARD_AUDIT_PROJECTION')
    return state
  }

  /** Run one read-only git command in the target; a timeout, abort, or truncation throws. */
  async function git(targetRepo: string, command: string, what: string): Promise<{ exitCode: number; stdout: string }> {
    const spec = ctx.shell.resolve({ command, timeoutMs: resolved.gitTimeoutMs, stdoutMaxBytes: GIT_STDOUT_MAX_BYTES, workdir: targetRepo })
    const result = await (await ctx.shell.execute(spec)).result()
    if (result.timedOut || result.aborted || result.exitCode === null || result.stdout.truncated) {
      throw new HarnessError(`hard audit ${what} did not settle: ${result.stderr.text.trim().slice(-400)}`, 'HARD_AUDIT_GIT_FAILED')
    }
    return { exitCode: result.exitCode, stdout: result.stdout.text }
  }

  /** The binary files of one cell at the pinned commit that are not inert. */
  async function binaryFiles(matrix: HardCoverageMatrix, pathspec: string): Promise<string[]> {
    const repo = shellQuote(matrix.targetRepo)
    const { exitCode, stdout } = await git(
      matrix.targetRepo,
      `git -C ${repo} diff --numstat --no-renames --no-textconv --no-ext-diff "$(git -C ${repo} hash-object -t tree /dev/null)" ${shellQuote(matrix.commit)} -- ${pathspec}`,
      'binary check',
    )
    if (exitCode !== 0) throw new HarnessError(`hard audit binary check failed with exit ${exitCode}`, 'HARD_AUDIT_GIT_FAILED')
    return stdout.split('\n')
      .filter(line => line.startsWith('-\t-\t'))
      .map(line => line.slice(4))
      .filter(path => !INERT_EXTENSIONS.has(extensionOf(path)))
  }

  /** Whether the working tree of one cell differs from the pinned commit, untracked files included. */
  async function cellDrifted(matrix: HardCoverageMatrix, pathspec: string): Promise<boolean> {
    const repo = shellQuote(matrix.targetRepo)
    const status = await git(matrix.targetRepo, `git -C ${repo} status --porcelain --untracked-files=all -- ${pathspec}`, 'status check')
    /* v8 ignore next -- defensive: the binary check already read this repository; status fails only on a repository fault. */
    if (status.exitCode !== 0) throw new HarnessError(`hard audit status check failed with exit ${status.exitCode}`, 'HARD_AUDIT_GIT_FAILED')
    if (status.stdout.trim().length > 0) return true
    const diff = await git(matrix.targetRepo, `git -C ${repo} diff --quiet ${shellQuote(matrix.commit)} -- ${pathspec}`, 'diff check')
    /* v8 ignore next -- defensive: the binary check already read this commit; diff fails only on a repository fault. */
    if (diff.exitCode !== 0 && diff.exitCode !== 1) throw new HarnessError(`hard audit diff check failed with exit ${diff.exitCode}`, 'HARD_AUDIT_GIT_FAILED')
    return diff.exitCode === 1
  }

  /** Spawn the reader and wait for it to settle, cancelling it at the time budget. */
  async function runReader(
    agent: Agent,
    request: HardAuditRequestedData,
    matrix: HardCoverageMatrix,
    observation: ReaderObservation,
    signal: AbortSignal,
  ): Promise<{ run: SubagentRun; result: Awaited<SubagentRun['result']> }> {
    const label = `hard-audit ${request.module} ${request.bugClass} @${request.auditedSeq} ${randomUUID()}`
    labeled.set(label, observation)
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort(new Error('hard-audit reader time budget spent')) }, resolved.auditTimeoutMs)
    try {
      const run = await ctx.subagents.start(resolved.auditProvider, {
        label,
        prompt: [{
          type: 'text',
          text: readerPrompt({
            module: request.module,
            bugClass: request.bugClass,
            repoScoped: classScope(request.bugClass) === 'repo',
            targetRepo: matrix.targetRepo,
            commit: matrix.commit,
          }),
        }],
        parent: agent,
        signal: AbortSignal.any([signal, timeout.signal]),
        ...resolved.auditModel === undefined ? {} : { agentOptions: resolved.auditModel },
        outputSchema: READER_REPORT_SCHEMA,
        // The reader is the mission agent's direct child and holds no delegation tool.
        maxDepth: 1,
        toolFilter: { allow: [...resolved.readerTools] },
        persona: READER_PERSONA,
      })
      try {
        return { run, result: await run.result }
      } catch (error: unknown) {
        readers.delete(run.id)
        await run.dispose()
        throw error
      }
    } finally {
      clearTimeout(timer)
      labeled.delete(label)
    }
  }

  /** Resolve every site the reader cited at the pinned commit; the first refusal reason, if any. */
  async function citationRefusal(agent: Agent, request: HardAuditRequestedData, report: ReaderReport): Promise<string | undefined> {
    const repoScoped = classScope(request.bugClass) === 'repo'
    const sites = report.outcome === 'flagged'
      ? report.locations.map(location => ({ path: location.path, cites: [`${location.path}:${location.line}`, ...location.symbol === undefined ? [] : [`${location.path}:${location.symbol}`]], line: location.line }))
      : report.examined.map(site => ({ path: site.path, cites: [`${site.path}:${site.symbol}`], line: 1 }))
    if (sites.length === 0) {
      return report.outcome === 'flagged' ? 'a flagged report named no location' : 'a clean report named no examined code'
    }
    const outside = sites.find(site => !repoRelative(site.path) || site.line < 1)
    if (outside !== undefined) return `${outside.path} is not a repository-relative path with a positive line`
    if (!sites.some(site => inCell(site.path, request.module, repoScoped))) return 'the report cited no code inside the audited cell'
    const { rejected } = await ctx.hardVerifier.checkSinkCitations(agent, sites.flatMap(site => site.cites))
    return rejected.length === 0 ? undefined : rejected.map(reject => reject.reason).join('; ')
  }

  /** Read one cell independently and settle its result; undefined when the mission agent is gone. */
  async function audit(job: AuditJob, signal: AbortSignal): Promise<HardAuditResultData | undefined> {
    const agent = ctx.agents.get(job.agentId)
    if (agent === undefined) return undefined
    const { request } = job
    const base = { module: request.module, bugClass: request.bugClass, auditedSeq: request.auditedSeq }
    const unavailable = (cause: HardAuditUnavailableCause, reason: string, ran?: Partial<HardAuditResultData>): HardAuditResultData =>
      ({ ...base, outcome: 'unavailable', cause, reason: bounded(reason), ...ran })
    if (auditState(agent).cells[auditCellKey(request)] !== request.auditedSeq) {
      return unavailable('superseded', 'the cell was marked again before the reader started')
    }
    const matrix = ctx.hardLedger.coverageMatrix(agent)
    /* v8 ignore next -- defensive: a request is only recorded over an armed matrix, and arming is never undone. */
    if (matrix === undefined) return unavailable('git', 'no armed coverage matrix pins the target')
    const pathspec = cellPathspec(request.module, classScope(request.bugClass) === 'repo', matrix.targetRepo)
    try {
      const binaries = await binaryFiles(matrix, pathspec)
      if (binaries.length > 0) return unavailable('binary', `binary module, no decompiler tool: ${binaries.slice(0, 5).join(', ')}`)
      if (await cellDrifted(matrix, pathspec)) return unavailable('workspace-drift', 'module differs from pinned commit before the read')
    } catch (error: unknown) {
      return unavailable('git', errorText(error))
    }

    const observation: ReaderObservation = {
      accesses: [],
      ownOutputs: new Set(),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
    let reader: Awaited<ReturnType<typeof runReader>>
    try {
      reader = await runReader(agent, request, matrix, observation, signal)
    } catch (error: unknown) {
      if (signal.aborted) return undefined
      return unavailable('reader-failed', `the reader could not run: ${errorText(error)}`)
    }
    const { run, result } = reader
    const child = run.localAgent
    const cwd = child?.session.header.cwd
    try {
      await run.dispose()
    } finally {
      readers.delete(run.id)
    }
    if (signal.aborted) return undefined
    const usage: HardAuditUsage = { ...observation.usage }
    const ran: Partial<HardAuditResultData> = {
      auditor: { provider: child?.options.provider ?? 'default', model: child?.options.model ?? 'default' },
      childSession: run.id,
      usage,
    }

    try {
      if (await cellDrifted(matrix, pathspec)) return unavailable('workspace-drift', 'module differs from pinned commit after the read', ran)
    } catch (error: unknown) {
      return unavailable('git', errorText(error), ran)
    }
    if (child === undefined || cwd === undefined) {
      return unavailable('reader-failed', 'the reader ran outside this process, so its reads cannot be checked', ran)
    }
    const stateDirs = [
      ...harnessStatePrefixes(matrix.targetRepo).map(prefix => join(matrix.targetRepo, prefix)),
      resolveDshHome(),
    ]
    const contaminating = await firstContaminatingRead(observation.accesses, {
      cwd,
      targetRepo: matrix.targetRepo,
      stateDirs,
      ownOutputs: observation.ownOutputs,
    })
    if (contaminating !== undefined) {
      return unavailable('contaminated', `the reader read ${contaminating}, outside the target or inside harness state`, ran)
    }
    const report = result.stopReason === 'completed' ? parseReaderReport(result.structured) : undefined
    if (report === undefined) {
      const detail = result.diagnostic === undefined ? '' : `: ${result.diagnostic}`
      return unavailable('reader-failed', `the reader ended ${result.stopReason} without a structured report${detail}`, ran)
    }
    let refusal: string | undefined
    try {
      refusal = await citationRefusal(agent, request, report)
    } catch (error: unknown) {
      return unavailable('git', errorText(error), ran)
    }
    if (refusal !== undefined) return unavailable('citation', refusal, ran)
    if (report.outcome === 'clean') {
      return { ...base, outcome: 'corroborated', reason: bounded(report.reason), examined: report.examined.length, ...ran }
    }
    const locations: HardAuditLocation[] = report.locations.slice(0, RESULT_LOCATION_LIMIT).map(location => ({
      path: location.path,
      line: location.line,
      ...location.symbol === undefined ? {} : { symbol: location.symbol },
    }))
    return { ...base, outcome: 'flagged', reason: bounded(report.reason), locations, ...ran }
  }

  /** Start queued audits up to the concurrency bound. */
  function pump(): void {
    while (running.size < resolved.maxConcurrentAudits) {
      const job = queue.shift()
      if (job === undefined) return
      const key = jobKey(job)
      const controller = new AbortController()
      running.set(key, { agentId: job.agentId, controller })
      void audit(job, controller.signal).then(
        (result) => {
          if (result === undefined || controller.signal.aborted) return
          ctx.agents.get(job.agentId)?.session.append('hard/audit/result', result)
        },
        (error: unknown) => {
          ctx.logger.warn(`hard-audit: audit of ${job.request.module} × ${job.request.bugClass} failed: ${errorText(error)}`)
        },
      ).finally(() => {
        running.delete(key)
        known.delete(key)
        pump()
      })
    }
  }

  /** Queue one recorded request once per process. */
  function enqueue(job: AuditJob): void {
    const key = jobKey(job)
    if (known.has(key)) return
    known.add(key)
    queue.push(job)
    pump()
  }

  /** Record one sampled clear: a request, refused at once when the mission's budget is spent. */
  function request(agentId: SessionId, data: HardAuditRequestedData): void {
    const agent = ctx.agents.get(agentId)
    if (agent === undefined) return
    const charged = chargedAudits(auditState(agent))
    agent.session.append('hard/audit/requested', data)
    if (charged >= resolved.maxAuditsPerMission) {
      agent.session.append('hard/audit/result', {
        module: data.module,
        bugClass: data.bugClass,
        auditedSeq: data.auditedSeq,
        outcome: 'unavailable',
        cause: 'budget',
        reason: `the mission's audit budget of ${resolved.maxAuditsPerMission} is spent`,
      })
      return
    }
    enqueue({ agentId, request: data })
  }

  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'subagent/descriptor': {
        const label = event.data.label
        const observation = label === undefined ? undefined : labeled.get(label)
        if (label !== undefined && observation !== undefined) {
          labeled.delete(label)
          readers.set(session.id, observation)
        }
        return
      }
      case 'tool/call': {
        const access = readers.has(session.id) ? readAccessOf(event.data.name, event.data.arguments) : undefined
        if (access !== undefined) readers.get(session.id)?.accesses.push(access)
        return
      }
      case 'tool/result': {
        const observation = readers.get(session.id)
        if (observation === undefined) return
        for (const block of event.data.message.content) {
          if (block.type === 'text') for (const path of namedPaths(block.text)) observation.ownOutputs.add(path)
        }
        return
      }
      case 'assistant/message': {
        const usage = event.data.usage
        const observation = readers.get(session.id)
        if (observation === undefined || usage === undefined) return
        observation.usage.inputTokens += usage.inputTokens
        observation.usage.outputTokens += usage.outputTokens
        observation.usage.cacheReadTokens += usage.cacheReadTokens ?? 0
        observation.usage.cacheWriteTokens += usage.cacheWriteTokens ?? 0
        return
      }
      case 'hard/coverage/cell': {
        const agent = ctx.agents.get(session.id)
        if (agent === undefined || !ctx.agents.roots().includes(agent)) return
        const matrix = ctx.hardLedger.coverageMatrix(agent)
        if (matrix === undefined) return
        const tier = tierOf(event.data, matrix)
        if (tier === undefined || !cellSampledForPercent(event.data, resolved.percents[tier], matrix.commit)) return
        const data: HardAuditRequestedData = { module: event.data.module, bugClass: event.data.bugClass, auditedSeq: event.seq, tier }
        // The request is appended after the clear's own append returns, never inside its observer dispatch.
        queueMicrotask(() => { request(agent.id, data) })
        return
      }
      default:
        return
    }
  })

  ctx.on('agent/created', ({ agent, source }) => {
    if (!ctx.agents.roots().includes(agent)) return
    const provider = ctx.subagents.getProvider(resolved.auditProvider)
    if (provider === undefined) {
      throw new HarnessError(`hard audit: subagent provider "${resolved.auditProvider}" is not registered`, 'HARD_AUDIT_PROVIDER')
    }
    if (provider.inheritsParentContext) {
      throw new HarnessError(
        `hard audit: subagent provider "${resolved.auditProvider}" inherits the parent conversation, which would show the reader every claim it must not see`,
        'HARD_AUDIT_PROVIDER',
      )
    }
    if (source !== 'resume') return
    for (const pending of auditState(agent).pending) enqueue({ agentId: agent.id, request: pending })
  })

  ctx.on('agent/disposed', ({ agent }) => {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const job = queue[index] as AuditJob
      if (job.agentId !== agent.id) continue
      queue.splice(index, 1)
      known.delete(jobKey(job))
    }
    for (const { agentId, controller } of running.values()) {
      if (agentId === agent.id) controller.abort(new Error('hard-audit: mission agent disposed'))
    }
  })
}
