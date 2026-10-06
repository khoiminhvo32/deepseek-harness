/**
 * The hard verifier: executes a finding's proof of concept through the shell
 * seam, applies the mechanical proof-of-effect contract, recomputes the
 * claimed CVSS 4.0 score, and records the durable verdict. The model never
 * runs its own proof for acceptance: only a harness-executed run counts.
 * @module @deepseek-ai/dsh-experimental-hard-verifier
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  HardFindingProposedData,
  HardFindingRequest,
  HardFindingVerdictData,
} from '@deepseek-ai/dsh-experimental-hard-ledger'
import { cellSampledForPercent } from '@deepseek-ai/dsh-experimental-hard-ledger'
import { parseVector, scoreVector } from './cvss4.ts'
import { GUARDED_SURFACE_PATTERNS, SINK_PATTERNS, surfaceOperands } from './sink-patterns.ts'

/**
 * Bug class whose sink pattern names a PROTECTIVE check (the login flow). For
 * this class an empty grep means no protective sink was found anywhere — a
 * suspicious absence, not a clean sweep — so batch clearing is refused and
 * each cell needs an individual model read. The other two absence classes
 * (`authz`, `authn-bypass`) moved to `GUARDED_SURFACE_PATTERNS`, where the
 * grep names the guarded surface and zero matches is the clean result.
 */
export const ABSENCE_SINK_CLASSES: ReadonlySet<string> = new Set(['login-bypass'])
import { classifyRuns, runSatisfied } from './verdict.ts'
import type { PoCRunRecord } from './verdict.ts'
// Loads the declaration-merged `shell` Context key this service executes through.
import type {} from '@deepseek-ai/dsh-shell'

/** Default PoC execution count; every run must satisfy the contract to confirm. */
export const DEFAULT_VERIFIER_RUNS = 3

/** Default per-run timeout in seconds. */
export const DEFAULT_VERIFIER_TIMEOUT_SECONDS = 120

/** Default foreground stdout capture budget per run, in bytes. */
export const DEFAULT_STDOUT_MAX_BYTES = 65536

/** Default share of `cleared` coverage cells the cross-check re-greps, in percent. */
export const DEFAULT_COVERAGE_SPOT_CHECK_PERCENT = 20

/** Verifier plugin config. */
export interface Config {
  /**
   * PoC executions per verification. Every run must satisfy the
   * proof-of-effect contract for `confirmed`; any split is `flaky`.
   */
  runs?: number
  /** Per-run timeout in seconds; a timed-out run never satisfies the contract. */
  timeoutSeconds?: number
  /** Foreground stdout capture budget per run in bytes. */
  stdoutMaxBytes?: number
  /** Working directory for PoC execution; defaults to the shell provider's own. */
  pocWorkdir?: string
  /**
   * Share of `cleared` coverage cells the deterministic cross-check re-greps,
   * in percent. Cells are sampled by their own module and class hash, so the
   * same cell is always sampled or always skipped; `0` disables the check.
   */
  coverageSpotCheckPercent?: number
}

/** Schemastery config for the verifier. */
export const Config: z<Config> = z.object({
  runs: z.number().step(1).min(1).max(10).default(DEFAULT_VERIFIER_RUNS),
  timeoutSeconds: z.number().step(1).min(1).max(3600).default(DEFAULT_VERIFIER_TIMEOUT_SECONDS),
  stdoutMaxBytes: z.number().step(1).min(1024).default(DEFAULT_STDOUT_MAX_BYTES),
  pocWorkdir: z.string(),
  coverageSpotCheckPercent: z.number().step(1).min(0).max(100).default(DEFAULT_COVERAGE_SPOT_CHECK_PERCENT),
})

/** Fully materialized verifier settings. */
interface ResolvedConfig {
  readonly runs: number
  readonly timeoutSeconds: number
  readonly stdoutMaxBytes: number
  readonly pocWorkdir?: string
  readonly coverageSpotCheckPercent: number
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const runs = config.runs ?? DEFAULT_VERIFIER_RUNS
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) {
    throw new TypeError('runs must be a safe integer between 1 and 10')
  }
  const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_VERIFIER_TIMEOUT_SECONDS
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new TypeError('timeoutSeconds must be a safe integer between 1 and 3600')
  }
  const stdoutMaxBytes = config.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES
  if (!Number.isSafeInteger(stdoutMaxBytes) || stdoutMaxBytes < 1024) {
    throw new TypeError('stdoutMaxBytes must be a safe integer of at least 1024')
  }
  if (config.pocWorkdir !== undefined && config.pocWorkdir.trim().length === 0) {
    throw new TypeError('pocWorkdir must not be blank when provided')
  }
  const coverageSpotCheckPercent = config.coverageSpotCheckPercent ?? DEFAULT_COVERAGE_SPOT_CHECK_PERCENT
  if (!Number.isSafeInteger(coverageSpotCheckPercent) || coverageSpotCheckPercent < 0 || coverageSpotCheckPercent > 100) {
    throw new TypeError('coverageSpotCheckPercent must be a safe integer from 0 through 100')
  }
  return {
    runs,
    timeoutSeconds,
    stdoutMaxBytes,
    ...config.pocWorkdir === undefined ? {} : { pocWorkdir: config.pocWorkdir },
    coverageSpotCheckPercent,
  }
}

/** POSIX-quote one path argument for the PoC command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** The settled foreground fields the fail-closed grep guard reads. */
interface GrepOutcome {
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly exitCode: number | null
  readonly stderr: { readonly text: string }
}

/**
 * Fail closed when a grep did not settle cleanly: an infrastructure error, a
 * timeout, or an abort throws instead of reading as an evaluated result.
 * @param result - the settled shell result of the grep run.
 * @param what - the grepped subject, worded for the error message.
 * @param code - the fail-closed error code to throw.
 */
function assertGrepSettled(result: GrepOutcome, what: string, code: string): void {
  if (result.timedOut || result.aborted || (result.exitCode !== 0 && result.exitCode !== 1)) {
    throw new HarnessError(
      `hard ${what} failed with exit ${String(result.exitCode)}: `
      + result.stderr.text.trim().slice(-400),
      code,
    )
  }
}

/** Deterministically recompute the score and compare with the model's claim. */
function recomputeCvss(proposed: HardFindingProposedData): { computed: number; match: boolean } {
  let computed: number
  try {
    computed = scoreVector(parseVector(proposed.cvssVector))
  } catch (error: unknown) {
    /* v8 ignore next -- defensive: parseVector only throws Error instances */
    throw new HarnessError(
      `${proposed.id}: cvss vector does not parse: ${error instanceof Error ? error.message : String(error)}`,
      'HARD_VERIFIER_INVALID_VECTOR',
    )
  }
  return { computed, match: Math.abs(computed - proposed.cvssClaimed) < 1e-9 }
}

/** Structural coverage-cell input for the cross-check; bridges ledger-type identities across package builds. */
export interface CoverageAuditCell {
  readonly module: string
  readonly bugClass: string
  readonly verdict: 'cleared' | 'suspicious' | 'uncovered'
  readonly declaredSinks: readonly string[]
}

/** One model-supplied flow-document citation the harness must resolve. */
export interface FlowCitationEntry {
  /** `path:line` or `path:line-line`, target-repo relative. */
  readonly cite: string
  /** Short source text expected at the cited lines. */
  readonly snippet: string
}

/** One citation the pinned-commit resolver refused, with the why. */
export interface FlowCitationReject {
  readonly cite: string
  readonly reason: string
}

/**
 * Structural reopening record the cross-check produces for a failed audit.
 * `source: 'harness'` is set explicitly, same as the confirmed branch's
 * `evidence: 'demonstrated'`: the reopen is the one coverage decision the
 * harness makes on its own, and attribution in the data is what lets
 * consumers separate harness reopens from the model's own `suspicious`
 * verdicts — a well-behaved model that found something is not gaming.
 */
export interface CoverageReopenRecord {
  readonly module: string
  readonly bugClass: string
  readonly verdict: 'suspicious'
  readonly declaredSinks: readonly string[]
  readonly source: 'harness'
}

/**
 * Deterministic sampling of one coverage cell: the hash of its module and
 * class decides the spot check, so the same cell is always sampled or always
 * skipped and the check never depends on wall-clock randomness.
 * @param cell - the coverage cell under test.
 * @param percent - the share of cells to sample, 0 through 100.
 * @returns true when the cross-check inspects this cell.
 */
export function sampleCellForSpotCheck(cell: { module: string; bugClass: string }, percent: number): boolean {
  return cellSampledForPercent(cell, percent)
}

/**
 * Owns proof execution and verdict recording on the `hardVerifier` key.
 * Depends on the shell seam for execution and the ledger for durable state.
 */
declare module '@deepseek-ai/cordis' {
  /** The hard-harness proof-of-effect verification service. */
  interface Context {
    hardVerifier: HardVerifier
  }
}

/**
 * The hard-harness verifier on the `hardVerifier` key: rejects duplicates,
 * executes proofs of effect through the shell seam, recomputes CVSS 4.0
 * scores against the claimed ones, and records the durable verdict.
 */
export class HardVerifier extends Service {
  static inject = ['shell', 'hardLedger']

  static Config: z<Config> = Config

  private readonly resolved: ResolvedConfig

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'hardVerifier')
    this.resolved = resolveConfig(config)
  }

  /**
   * Verify one proposed finding: reject duplicates, recompute CVSS, then run
   * the proof through the shell seam in two arms and append the durable
   * verdict. The benign arm runs the PoC once with a benign payload derived
   * from the claim hash and must FAIL — a proof that passes regardless of
   * input proves nothing about the input (the specificity check). Only then
   * does the exploit arm run the configured number of times with the model's
   * payload. The PoC executes from the pinned target repository the armed
   * matrix records (matching the model-relative `pocPath` and coverage
   * modules); `pocWorkdir` is the explicit override and no matrix keeps the
   * legacy shell cwd.
   * @param agent - the live agent whose ledger receives the verdict.
   * @param proposed - the proposal record to verify; its `payload` is the exploit input.
   * @returns the appended verdict record.
   */
  async verify(
    agent: Agent,
    proposed: HardFindingRequest & Pick<HardFindingProposedData, 'id'>,
  ): Promise<HardFindingVerdictData> {
    const config = this.resolved
    const ledger = this.ctx.hardLedger
    for (const record of ledger.findings(agent)) {
      if (record.proposed.fingerprint === proposed.fingerprint && record.proposed.id !== proposed.id
        && record.verdict?.verdict === 'confirmed') {
        throw new HarnessError(
          `${proposed.id}: a confirmed finding with the same root cause already exists (${record.proposed.id})`,
          'HARD_VERIFIER_DUPLICATE',
        )
      }
    }

    const { computed, match } = recomputeCvss(proposed)
    const matrix = ledger.coverageMatrix(agent)
    const workdir = config.pocWorkdir ?? matrix?.targetRepo
    const command = (payload: string): string => `bash ${shellQuote(proposed.pocPath)} ${shellQuote(payload)}`
    const runOnce = async (payload: string): Promise<PoCRunRecord> => {
      const spec = this.ctx.shell.resolve({
        command: command(payload),
        timeoutMs: config.timeoutSeconds * 1000,
        stdoutMaxBytes: config.stdoutMaxBytes,
        ...workdir === undefined ? {} : { workdir },
      })
      const execution = await this.ctx.shell.execute(spec)
      const result = await execution.result()
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        stdoutText: result.stdout.text,
        stderrTail: result.stderr.text.slice(-400),
      }
    }

    // The benign arm runs FIRST and ONCE: it settles on the clean tree — a
    // PoC that leaves artifacts (a touched file) would let the later exploit
    // arm see the earlier arm's state — and one run is enough because the
    // benign payload is derived from the claim hash, not chosen at random,
    // so the control is deterministic and the snapshot reproducible.
    const benignRun = await runOnce(`hard-benign-${proposed.claimHash.slice(0, 8)}`)
    if (runSatisfied(benignRun, proposed.claimHash)) {
      const verdict = classifyRuns({
        id: proposed.id,
        runs: [],
        claimHash: proposed.claimHash,
        cvssComputed: computed,
        cvssMatch: match,
        fingerprint: proposed.fingerprint,
        benignArm: 'passed',
      })
      ledger.recordVerdict(agent, verdict)
      return verdict
    }

    const runs: PoCRunRecord[] = []
    for (let index = 0; index < config.runs; index += 1) {
      runs.push(await runOnce(proposed.payload))
    }

    const verdict = classifyRuns({
      id: proposed.id,
      runs,
      claimHash: proposed.claimHash,
      cvssComputed: computed,
      cvssMatch: match,
      fingerprint: proposed.fingerprint,
      benignArm: 'failed',
    })
    ledger.recordVerdict(agent, verdict)
    return verdict
  }

  /**
   * Deterministic cross-check of one `cleared` coverage cell, branched by the
   * class's reading. Presence classes (the default): re-grep the module
   * against the fixed sink patterns and reopen the cell as `suspicious` when
   * undeclared sink sites surface. Guarded-surface classes (`authz`,
   * `authn-bypass`): re-grep for the exported operations and reopen when the
   * module still exports an operation the model never declared a guard for —
   * the reopening evidence is the missed operation names. Both greps run from
   * the pinned target repository the armed coverage matrix records, so the
   * module path is always target-repo relative. Sampling follows the
   * configured spot-check percent by cell hash; an unsampled cell, a
   * non-cleared cell, a class without applicable patterns, a missing matrix,
   * or a grep with no undeclared matches returns `undefined` and changes
   * nothing. The check fails closed: a grep that errors, times out, or is
   * aborted never reads as a clean cell.
   * @param agent - the live agent whose ledger matrix anchors the grep.
   * @param cell - the coverage cell the model just marked `cleared`.
   * @returns the reopening record to persist through the ledger, or `undefined` when the check passes or does not apply.
   * @throws `HARD_VERIFIER_AUDIT_FAILED` when the cross-check grep errors, times
   *   out, or is aborted — an unevaluated grep is not evidence of absence.
   */
  async auditCoverage(agent: Agent, cell: CoverageAuditCell): Promise<CoverageReopenRecord | undefined> {
    if (cell.verdict !== 'cleared') return undefined
    const guardedPatterns = GUARDED_SURFACE_PATTERNS[cell.bugClass]
    if (guardedPatterns !== undefined) return this.auditGuardedSurface(agent, cell, guardedPatterns)
    const patterns = SINK_PATTERNS[cell.bugClass]
    if (patterns === undefined || patterns.length === 0) return undefined
    if (!sampleCellForSpotCheck(cell, this.resolved.coverageSpotCheckPercent)) return undefined
    const targetRepo = this.ctx.hardLedger.coverageMatrix(agent)?.targetRepo
    if (targetRepo === undefined) return undefined
    const config = this.resolved
    const spec = this.ctx.shell.resolve({
      command: `grep -rInE ${shellQuote(patterns.join('|'))} ${shellQuote(cell.module)}`,
      timeoutMs: config.timeoutSeconds * 1000,
      stdoutMaxBytes: config.stdoutMaxBytes,
      workdir: targetRepo,
    })
    const execution = await this.ctx.shell.execute(spec)
    const result = await execution.result()
    assertGrepSettled(result, `audit: grep over ${cell.module}`, 'HARD_VERIFIER_AUDIT_FAILED')
    const missed = result.stdout.text.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !cell.declaredSinks.some(sink => line.includes(sink)))
      .slice(0, 8)
    if (missed.length === 0) return undefined
    return { module: cell.module, bugClass: cell.bugClass, verdict: 'suspicious', declaredSinks: missed, source: 'harness' }
  }

  /**
   * The guarded-surface half of the cross-check: grep the module for its
   * exported operations, reduce each match back to the operation name, and
   * reopen the cell naming every operation none of the model's declarations
   * mention. A declaration may phrase the guard however it likes — the check
   * only requires the operation's name to appear in it, because the absence
   * contract is "for every exported operation, name what protects it — or
   * declare it deliberately unguarded, with the reason".
   * @param agent - the live agent whose ledger matrix anchors the grep.
   * @param cell - the cleared coverage cell being audited.
   * @param patterns - the class's guarded-surface grep patterns.
   * @returns the reopening record whose `declaredSinks` list the missed operations, or `undefined` when none is missed.
   * @throws `HARD_VERIFIER_AUDIT_FAILED` when the grep does not settle cleanly.
   */
  private async auditGuardedSurface(
    agent: Agent,
    cell: CoverageAuditCell,
    patterns: readonly string[],
  ): Promise<CoverageReopenRecord | undefined> {
    if (!sampleCellForSpotCheck(cell, this.resolved.coverageSpotCheckPercent)) return undefined
    const targetRepo = this.ctx.hardLedger.coverageMatrix(agent)?.targetRepo
    if (targetRepo === undefined) return undefined
    const config = this.resolved
    const spec = this.ctx.shell.resolve({
      command: `grep -rInE ${shellQuote(patterns.join('|'))} ${shellQuote(cell.module)}`,
      timeoutMs: config.timeoutSeconds * 1000,
      stdoutMaxBytes: config.stdoutMaxBytes,
      workdir: targetRepo,
    })
    const execution = await this.ctx.shell.execute(spec)
    const result = await execution.result()
    assertGrepSettled(result, `audit: grep over ${cell.module}`, 'HARD_VERIFIER_AUDIT_FAILED')
    const missed = [...new Set(result.stdout.text.split('\n').flatMap(line => surfaceOperands(line)))]
      .filter(operand => !cell.declaredSinks.some(declaration => declaration.includes(operand)))
      .slice(0, 8)
    if (missed.length === 0) return undefined
    return { module: cell.module, bugClass: cell.bugClass, verdict: 'suspicious', declaredSinks: missed, source: 'harness' }
  }

  /**
   * Resolve every flow-document citation against the pinned target commit —
   * `git show <sha>:<path>`, never the working tree — so a citation the model
   * edited into existence after the arming cannot resolve. A cite passes only
   * when the path is tracked at the pinned commit, the line exists there, and
   * the snippet is a trimmed substring of that line's content. The check is
   * the flow-document floor: prose cannot be verified, but a resolvable
   * citation forces the model to open the right file at the right lines, so
   * fabricating one costs approximately what reading it does. It fails
   * closed: a git invocation that errors, times out, or is aborted throws
   * instead of reading as a failed citation.
   * @param agent - the live agent whose ledger matrix carries the pinned commit.
   * @param citations - the citations to resolve, in any order.
   * @returns the rejected citations with per-cite reasons; empty means every cite resolved.
   * @throws `HARD_VERIFIER_NO_MATRIX` when no coverage matrix is armed.
   * @throws `HARD_VERIFIER_CITATION_FAILED` when a git invocation does not settle cleanly.
   */
  async checkFlowCitations(
    agent: Agent,
    citations: readonly FlowCitationEntry[],
  ): Promise<{ rejected: readonly FlowCitationReject[] }> {
    const matrix = this.ctx.hardLedger.coverageMatrix(agent)
    if (matrix === undefined) {
      throw new HarnessError('hard flow citations: no armed coverage matrix pins a commit', 'HARD_VERIFIER_NO_MATRIX')
    }
    const { commit, targetRepo } = matrix
    const config = this.resolved
    const rejected: FlowCitationReject[] = []
    // The tracked check separates "the model named a path the pinned tree
    // never had" from infrastructure failure: once ls-tree settles, a later
    // git failure is never a citation verdict.
    const tracked = new Map<string, boolean>()
    for (const { cite, snippet } of citations) {
      const parsed = /^(?<path>.+):(?<start>\d{1,7})(?:-(?<end>\d{1,7}))?$/u.exec(cite.trim())
      if (parsed?.groups === undefined) {
        rejected.push({ cite, reason: 'cite must be path:line or path:line-line' })
        continue
      }
      const path = parsed.groups.path ?? ''
      const start = Number(parsed.groups.start ?? '0')
      const end = parsed.groups.end === undefined ? start : Number(parsed.groups.end)
      if (start < 1 || end < start) {
        rejected.push({ cite, reason: 'cite must be path:line or path:line-line' })
        continue
      }
      let isTracked = tracked.get(path)
      if (isTracked === undefined) {
        const spec = this.ctx.shell.resolve({
          command: `git ls-tree --name-only ${shellQuote(commit)} -- ${shellQuote(path)}`,
          timeoutMs: config.timeoutSeconds * 1000,
          stdoutMaxBytes: config.stdoutMaxBytes,
          workdir: targetRepo,
        })
        const execution = await this.ctx.shell.execute(spec)
        const result = await execution.result()
        assertGrepSettled(result, `flow citations: ls-tree over ${path}`, 'HARD_VERIFIER_CITATION_FAILED')
        isTracked = result.stdout.text.split('\n').some(line => line.trim() === path)
        tracked.set(path, isTracked)
      }
      if (!isTracked) {
        rejected.push({ cite, reason: 'path is not tracked at the pinned commit' })
        continue
      }
      const spec = this.ctx.shell.resolve({
        command: `set -o pipefail; git show ${shellQuote(`${commit}:${path}`)}`
          + ` | sed -n ${shellQuote(`${String(start)},${String(end)}p`)}`,
        timeoutMs: config.timeoutSeconds * 1000,
        stdoutMaxBytes: config.stdoutMaxBytes,
        workdir: targetRepo,
      })
      const execution = await this.ctx.shell.execute(spec)
      const result = await execution.result()
      assertGrepSettled(result, `flow citations: read of ${path}`, 'HARD_VERIFIER_CITATION_FAILED')
      if (!result.stdout.text.trim().includes(snippet.trim())) {
        rejected.push({ cite, reason: 'snippet does not match the file content at the pinned commit' })
      }
    }
    return { rejected }
  }

  /**
   * Mechanical absence screen behind the batch clear: grep the requested
   * modules for the union of the model's patterns and the class's fixed
   * patterns, anchored at the pinned target repository. The union means the
   * model's patterns can only ADD coverage, never subtract — a narrow
   * pattern choice cannot sneak past the harness table. An empty grep on
   * every module proves the absence predicate; any match fails the whole
   * batch and returns the matching lines as evidence for a manual read.
   * The pattern table follows the class's reading: guarded-surface classes
   * grep for the exported operations (zero matches = no exported surface),
   * sink classes grep for the sink shapes, and the one remaining
   * absence-shaped class (`login-bypass`) is refused — for its protective
   * sinks an empty grep is suspicious, not clean.
   * @param agent - the live agent whose ledger matrix anchors the grep.
   * @param bugClass - the bug class to prove absent.
   * @param modules - the target-repo-relative modules to grep.
   * @param patterns - the model's own extended-regex absence patterns.
   * @returns `clean: true` when every grep came back empty, else `clean: false` with the bounded matching lines.
   * @throws when the class is absence-shaped or has no fixed patterns, the grep errors, or no matrix is armed.
   */
  async screenModules(
    agent: Agent,
    bugClass: string,
    modules: readonly string[],
    patterns: readonly string[],
  ): Promise<{ clean: boolean; evidence: readonly string[] }> {
    const guardedPatterns = GUARDED_SURFACE_PATTERNS[bugClass]
    const classPatterns = guardedPatterns ?? SINK_PATTERNS[bugClass]
    if (classPatterns === undefined || classPatterns.length === 0) {
      throw new HarnessError(
        `hard screen: bug class ${bugClass} has no fixed sink patterns to verify against`,
        'HARD_VERIFIER_UNKNOWN_CLASS',
      )
    }
    if (ABSENCE_SINK_CLASSES.has(bugClass)) {
      throw new HarnessError(
        `hard screen: bug class ${bugClass} is absence-shaped — its sinks are protective checks, `
        + 'so an empty grep means no guard was found, which is suspicious rather than clean; '
        + 'verify its cells individually with hard_mark_coverage',
        'HARD_VERIFIER_ABSENCE_CLASS',
      )
    }
    const targetRepo = this.ctx.hardLedger.coverageMatrix(agent)?.targetRepo
    if (targetRepo === undefined) {
      throw new HarnessError('hard screen: no armed coverage matrix', 'HARD_VERIFIER_NO_MATRIX')
    }
    const union = [...new Set([...patterns, ...classPatterns])]
    const spec = this.ctx.shell.resolve({
      command: `grep -rInE ${shellQuote(union.join('|'))} ${modules.map(shellQuote).join(' ')}`,
      timeoutMs: this.resolved.timeoutSeconds * 1000,
      stdoutMaxBytes: this.resolved.stdoutMaxBytes,
      workdir: targetRepo,
    })
    const execution = await this.ctx.shell.execute(spec)
    const result = await execution.result()
    assertGrepSettled(result, `screen: grep over ${modules.join(', ')}`, 'HARD_VERIFIER_SCREEN_FAILED')
    const evidence = result.stdout.text.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .slice(0, 8)
    return { clean: evidence.length === 0, evidence }
  }
}

export { parseVector, scoreVector, macroVector, severityBand } from './cvss4.ts'
export { GUARDED_SURFACE_PATTERNS, SINK_PATTERNS, surfaceOperands } from './sink-patterns.ts'
export { claimHash, rootFingerprint } from './fingerprint.ts'
export { classifyRuns, runSatisfied } from './verdict.ts'
export type { PoCRunRecord } from './verdict.ts'
export default HardVerifier
