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
import { cellSampledForPercent, classScope, pinnedGitArgs } from '@deepseek-ai/dsh-experimental-hard-ledger'
import { parseVector, scoreVector } from './cvss4.ts'
import { GUARDED_SURFACE_PATTERNS, SINK_PATTERNS, surfaceOperands } from './sink-patterns.ts'
import { declarationCoversLine, parseSinkCitation } from './sink-citation.ts'

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

/**
 * The git command that addresses one armed matrix's pinned commit: the
 * harness-owned snapshot, or, for older records, the target repository every
 * command runs in.
 */
function pinnedGit(matrix: Parameters<typeof pinnedGitArgs>[0]): string {
  return ['git', ...pinnedGitArgs(matrix).map(shellQuote)].join(' ')
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

/** The armed matrix fields that address the pinned commit. */
type PinnedTarget = Parameters<typeof pinnedGitArgs>[0] & { readonly commit: string }

/**
 * The `git grep` over the pinned commit's tracked text files, so a file
 * written into the target after the arming (a report, a PoC, a scratch note)
 * never matches and every match is citable at that commit. Each output line
 * reads `<commit>:<path>:<line>:<text>`; {@link grepLines} drops the commit.
 * @param target - the armed matrix whose snapshot and commit the grep reads.
 * @param pattern - the shell-quoted extended-regex alternation.
 * @param options - extra `git grep` options placed before the pattern.
 * @returns the command line, run from the target repository root.
 */
function pinnedGrep(target: PinnedTarget, pattern: string, options = ''): string {
  return `${pinnedGit(target)} grep -I -n -E ${options}-e ${pattern} ${shellQuote(target.commit)}`
}

/**
 * The grep over one coverage cell's code at the pinned commit. A
 * repository-scoped class greps the whole tree whatever module recorded it;
 * the root module of a module-scoped class greps only the files directly at
 * the root, because its cell does not cover the subdirectories (their own
 * modules do); any other module greps its directory.
 * @param target - the armed matrix whose snapshot and commit the grep reads.
 * @param pattern - the shell-quoted extended-regex alternation.
 * @param module - the cell's module.
 * @param bugClass - the cell's bug class.
 * @returns the command line, run from the target repository root.
 */
function cellGrep(target: PinnedTarget, pattern: string, module: string, bugClass: string): string {
  if (classScope(bugClass) === 'repo') return pinnedGrep(target, pattern)
  if (module !== '.') return `${pinnedGrep(target, pattern)} -- ${shellQuote(module)}`
  return pinnedGrep(target, pattern, '--max-depth 0 ')
}

/**
 * The non-empty lines of one pinned grep's output, with the `<commit>:` prefix
 * `git grep` puts on every match removed so the paths compare with
 * target-relative citations.
 * @param stdout - the grep's stdout.
 * @param commit - the pinned commit the grep read.
 * @returns the trimmed `path:line:text` match lines.
 */
function grepLines(stdout: string, commit: string): string[] {
  const prefix = `${commit}:`
  return stdout.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => line.startsWith(prefix) ? line.slice(prefix.length) : line)
}

/** Undeclared matches one reopening lists; any further ones are counted in a closing note. */
const REOPEN_EVIDENCE_LIMIT = 8

/**
 * Cap one reopening's evidence, closing it with a count of the undeclared
 * matches left out so the model clears them all in one pass.
 * @param missed - every undeclared match, in grep order.
 * @returns at most {@link REOPEN_EVIDENCE_LIMIT} matches, plus the count note when some were left out.
 */
function reopenEvidence(missed: readonly string[]): string[] {
  const shown = missed.slice(0, REOPEN_EVIDENCE_LIMIT)
  const hidden = missed.length - shown.length
  return hidden === 0 ? shown : [...shown, `${String(hidden)} more undeclared matches not shown; grep the module for the rest`]
}

/** Characters of one grep match kept as recorded or returned evidence; a minified bundle line can run to megabytes. */
const EVIDENCE_LINE_LIMIT = 300

/**
 * Bound one grep match for storage and display, keeping its `path:line:`
 * location whole so the evidence still points at the code.
 * @param line - one full match line.
 * @returns the line, cut to {@link EVIDENCE_LINE_LIMIT} characters plus an ellipsis.
 */
function boundedEvidence(line: string): string {
  return line.length <= EVIDENCE_LINE_LIMIT ? line : `${line.slice(0, EVIDENCE_LINE_LIMIT)}…`
}

/** Deterministically recompute the score and compare with the model's claim. */
function recomputeCvss(proposed: Pick<HardFindingProposedData, 'cvssVector' | 'cvssClaimed'>, subject: string): { computed: number; match: boolean } {
  let computed: number
  try {
    computed = scoreVector(parseVector(proposed.cvssVector))
  } catch (error: unknown) {
    /* v8 ignore next -- defensive: parseVector only throws Error instances */
    throw new HarnessError(
      `${subject}: cvss vector does not parse: ${error instanceof Error ? error.message : String(error)}`,
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

/** One declared site the pinned-commit resolver refused, with the why. */
export interface SinkCitationReject {
  readonly sink: string
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
    const { computed, match } = this.assertVerifiable(agent, proposed)
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
   * Refuse a proposal the verifier could never decide: a root cause a
   * confirmed finding already holds, or a CVSS vector that does not parse.
   * Callers run it before appending the proposal, so a refused claim never
   * becomes a finding that awaits verification forever; `verify` runs it
   * again for callers that skip it.
   * @param agent - the live agent whose ledger holds the findings.
   * @param request - the proposal fields, with its id once it has been appended.
   * @returns the recomputed score and whether the claimed score matches it.
   * @throws `HARD_VERIFIER_DUPLICATE` or `HARD_VERIFIER_INVALID_VECTOR`.
   */
  assertVerifiable(
    agent: Agent,
    request: Pick<HardFindingRequest, 'fingerprint' | 'cvssVector' | 'cvssClaimed'> & { readonly id?: string },
  ): { computed: number; match: boolean } {
    const subject = request.id === undefined ? 'proposal' : request.id
    for (const record of this.ctx.hardLedger.findings(agent)) {
      if (record.proposed.fingerprint === request.fingerprint && record.proposed.id !== request.id
        && record.verdict?.verdict === 'confirmed') {
        throw new HarnessError(
          `${subject}: a confirmed finding with the same root cause already exists (${record.proposed.id})`,
          'HARD_VERIFIER_DUPLICATE',
        )
      }
    }
    return recomputeCvss(request, subject)
  }

  /**
   * Deterministic cross-check of one `cleared` coverage cell, branched by the
   * class's reading. Presence classes (the default): re-grep the module
   * against the fixed sink patterns and reopen the cell as `suspicious` when
   * undeclared sink sites surface. Guarded-surface classes (`authz`,
   * `authn-bypass`): re-grep for the exported operations and reopen when the
   * module still exports an operation the model never declared a guard for —
   * the reopening evidence is the missed operation names. Both greps read the
   * commit the armed coverage matrix pins, never the working tree, so a file
   * written into the target after the arming cannot reopen a cell, and the
   * module path is always target-repo relative: a repository-scoped class
   * greps the whole tree, and the root module `.` greps only the files at the
   * root. Sampling follows the
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
    const matrix = this.ctx.hardLedger.coverageMatrix(agent)
    if (matrix === undefined) return undefined
    const config = this.resolved
    const spec = this.ctx.shell.resolve({
      command: cellGrep(matrix, shellQuote(patterns.join('|')), cell.module, cell.bugClass),
      timeoutMs: config.timeoutSeconds * 1000,
      stdoutMaxBytes: config.stdoutMaxBytes,
      workdir: matrix.targetRepo,
    })
    const execution = await this.ctx.shell.execute(spec)
    const result = await execution.result()
    assertGrepSettled(result, `audit: grep over ${cell.module}`, 'HARD_VERIFIER_AUDIT_FAILED')
    const missed = grepLines(result.stdout.text, matrix.commit)
      .filter(line => !cell.declaredSinks.some(sink => declarationCoversLine(sink, line)))
      .map(boundedEvidence)
    if (missed.length === 0) return undefined
    return { module: cell.module, bugClass: cell.bugClass, verdict: 'suspicious', declaredSinks: reopenEvidence(missed), source: 'harness' }
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
    const matrix = this.ctx.hardLedger.coverageMatrix(agent)
    if (matrix === undefined) return undefined
    const config = this.resolved
    const spec = this.ctx.shell.resolve({
      command: cellGrep(matrix, shellQuote(patterns.join('|')), cell.module, cell.bugClass),
      timeoutMs: config.timeoutSeconds * 1000,
      stdoutMaxBytes: config.stdoutMaxBytes,
      workdir: matrix.targetRepo,
    })
    const execution = await this.ctx.shell.execute(spec)
    const result = await execution.result()
    assertGrepSettled(result, `audit: grep over ${cell.module}`, 'HARD_VERIFIER_AUDIT_FAILED')
    const missed = [...new Set(grepLines(result.stdout.text, matrix.commit).flatMap(line => surfaceOperands(line)))]
      // An operation named by its location (`path:line`) is also covered by a line or range citation of that line.
      .filter(operand => !cell.declaredSinks.some(declaration => declaration.includes(operand)
        || (/:\d+$/u.test(operand) && declarationCoversLine(declaration, `${operand}:`))))
    if (missed.length === 0) return undefined
    return { module: cell.module, bugClass: cell.bugClass, verdict: 'suspicious', declaredSinks: reopenEvidence(missed), source: 'harness' }
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
    const git = pinnedGit(matrix)
    const config = this.resolved
    const rejected: FlowCitationReject[] = []
    // The tracked check separates "the model named a path the pinned tree
    // never had" from infrastructure failure: once ls-tree settles, a later
    // git failure is never a citation verdict.
    const tracked = new Map<string, boolean>()
    const trackedAt = (path: string): Promise<boolean> => this.trackedAtCommit(
      tracked, git, targetRepo, commit, path, 'flow citations',
    )
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
      if (!await trackedAt(path)) {
        rejected.push({ cite, reason: 'path is not tracked at the pinned commit' })
        continue
      }
      const spec = this.ctx.shell.resolve({
        command: `set -o pipefail; ${git} show ${shellQuote(`${commit}:${path}`)}`
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
   * Resolve every declared site of a `cleared` coverage cell against the
   * pinned commit, through git alone so the outcome does not depend on the
   * host's `grep`. A site passes when its path is tracked at the commit and,
   * for a text file, the commit's file has the cited line or contains the
   * cited symbol (`git grep -I -F`). A binary — classified by a numstat diff
   * against the empty tree, the content test `grep -I` applies — passes the
   * path check without its content being read as resolved: its module is
   * unscreened, so the clear stands as a blind clear. A symbol match can sit in
   * a comment; this guards against citing code that does not exist, not
   * against a wrong clear. It fails closed: a git invocation that errors,
   * times out, or is aborted throws instead of reading as a verdict.
   * @param agent - the live agent whose ledger matrix carries the pinned commit.
   * @param sinks - the declared-site strings, in any order.
   * @returns the refused sites with per-site reasons; empty means every site resolved.
   * @throws `HARD_VERIFIER_NO_MATRIX` when no coverage matrix is armed.
   * @throws `HARD_VERIFIER_CITATION_FAILED` when a git invocation does not settle cleanly.
   */
  async checkSinkCitations(agent: Agent, sinks: readonly string[]): Promise<{ rejected: readonly SinkCitationReject[] }> {
    const matrix = this.ctx.hardLedger.coverageMatrix(agent)
    if (matrix === undefined) {
      throw new HarnessError('hard sink citations: no armed coverage matrix pins a commit', 'HARD_VERIFIER_NO_MATRIX')
    }
    const { commit, targetRepo } = matrix
    const git = pinnedGit(matrix)
    const short = commit.slice(0, 7)
    const tracked = new Map<string, boolean>()
    const binary = new Map<string, boolean>()
    const lineCounts = new Map<string, number>()
    const rejected: SinkCitationReject[] = []
    for (const sink of sinks) {
      const citation = parseSinkCitation(sink)
      if (citation === undefined) {
        rejected.push({ sink, reason: 'a declared site must be path:symbol, path:line, or path:start-end, optionally followed by a note' })
        continue
      }
      const { path } = citation
      if (!await this.trackedAtCommit(tracked, git, targetRepo, commit, path, 'sink citations')) {
        rejected.push({ sink, reason: `${path} is not tracked at commit ${short}` })
        continue
      }
      let isBinary = binary.get(path)
      if (isBinary === undefined) {
        const numstat = await this.gitAt(
          targetRepo,
          `${git} diff --numstat --no-renames --no-textconv --no-ext-diff "$(${git} hash-object -t tree /dev/null)" ${shellQuote(commit)} -- ${shellQuote(path)}`,
          `sink citations: numstat over ${path}`,
        )
        isBinary = numstat.startsWith('-\t-\t')
        binary.set(path, isBinary)
      }
      if (isBinary) continue
      if (citation.lines !== undefined) {
        let count = lineCounts.get(path)
        if (count === undefined) {
          count = Number((await this.gitAt(
            targetRepo,
            `set -o pipefail; ${git} show ${shellQuote(`${commit}:${path}`)} | awk 'END { print NR }'`,
            `sink citations: line count of ${path}`,
          )).trim())
          lineCounts.set(path, count)
        }
        const last = citation.lines.last
        if (last > count) rejected.push({ sink, reason: `${path} has ${count} lines at commit ${short}, so no line ${last}` })
        continue
      }
      const found = await this.gitAt(
        targetRepo,
        `${git} grep -I -F -c -e ${shellQuote(citation.locator)} ${shellQuote(commit)} -- ${shellQuote(path)}`,
        `sink citations: grep for ${citation.locator} in ${path}`,
      )
      if (found.trim().length === 0) rejected.push({ sink, reason: `${path} has no ${citation.locator} at commit ${short}` })
    }
    return { rejected }
  }

  /**
   * Whether one path is tracked at the pinned commit, memoized per call site.
   * @param memo - the caller's per-check cache.
   * @param git - the quoted git command that addresses the pinned commit.
   * @param targetRepo - the pinned target repository.
   * @param commit - the pinned full commit sha.
   * @param path - the target-repo-relative path.
   * @param what - the check name, worded for the failure message.
   * @returns true when `git ls-tree` lists the path at the commit.
   */
  private async trackedAtCommit(
    memo: Map<string, boolean>,
    git: string,
    targetRepo: string,
    commit: string,
    path: string,
    what: string,
  ): Promise<boolean> {
    const known = memo.get(path)
    if (known !== undefined) return known
    const listed = await this.gitAt(
      targetRepo,
      `${git} ls-tree --name-only ${shellQuote(commit)} -- ${shellQuote(path)}`,
      `${what}: ls-tree over ${path}`,
    )
    const tracked = listed.split('\n').some(line => line.trim() === path)
    memo.set(path, tracked)
    return tracked
  }

  /**
   * Run one read-only git command in the pinned target repository and return
   * its stdout; exit 1 is a settled empty answer (a `git grep` without a
   * match), anything else unsettled throws.
   * @param targetRepo - the pinned target repository.
   * @param command - the full command line; every variable argument is pre-quoted.
   * @param what - the subject, worded for the failure message.
   * @returns the command's stdout text.
   */
  private async gitAt(targetRepo: string, command: string, what: string): Promise<string> {
    const spec = this.ctx.shell.resolve({
      command,
      timeoutMs: this.resolved.timeoutSeconds * 1000,
      stdoutMaxBytes: this.resolved.stdoutMaxBytes,
      workdir: targetRepo,
    })
    const execution = await this.ctx.shell.execute(spec)
    const result = await execution.result()
    assertGrepSettled(result, what, 'HARD_VERIFIER_CITATION_FAILED')
    return result.stdout.text
  }

  /**
   * Mechanical screen behind the batch clear: grep the requested modules for
   * the union of the model's patterns and the class's fixed patterns at the
   * pinned commit, never the working tree; the root module `.` greps only
   * the files at the root. The union means the model's
   * patterns can only ADD matches, never subtract — a narrow pattern choice
   * cannot sneak past the harness table. Any match fails the whole batch and
   * returns the matching lines as evidence for a manual read. An empty grep
   * is silence, not proof of absence: the caller records the cells as a batch
   * screen, the weakest model tier, and refuses modules the tables cannot
   * screen before this runs. The pattern table follows the class's reading:
   * guarded-surface classes grep for the exported operations, sink classes
   * grep for the sink shapes, and the one remaining absence-shaped class
   * (`login-bypass`) is refused — for its protective sinks an empty grep is
   * suspicious, not clean.
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
    const matrix = this.ctx.hardLedger.coverageMatrix(agent)
    if (matrix === undefined) {
      throw new HarnessError('hard screen: no armed coverage matrix', 'HARD_VERIFIER_NO_MATRIX')
    }
    const pattern = shellQuote([...new Set([...patterns, ...classPatterns])].join('|'))
    // The root module greps only its own files, so it runs apart from the directory modules.
    const directories = modules.filter(module => module !== '.')
    const commands = [
      ...directories.length === 0 ? [] : [`${pinnedGrep(matrix, pattern)} -- ${directories.map(shellQuote).join(' ')}`],
      ...modules.includes('.') ? [cellGrep(matrix, pattern, '.', bugClass)] : [],
    ]
    const evidence: string[] = []
    for (const command of commands) {
      const spec = this.ctx.shell.resolve({
        command,
        timeoutMs: this.resolved.timeoutSeconds * 1000,
        stdoutMaxBytes: this.resolved.stdoutMaxBytes,
        workdir: matrix.targetRepo,
      })
      const execution = await this.ctx.shell.execute(spec)
      const result = await execution.result()
      assertGrepSettled(result, `screen: grep over ${modules.join(', ')}`, 'HARD_VERIFIER_SCREEN_FAILED')
      evidence.push(...grepLines(result.stdout.text, matrix.commit).map(boundedEvidence))
    }
    return { clean: evidence.length === 0, evidence: evidence.slice(0, 8) }
  }
}

export { parseVector, scoreVector, macroVector, severityBand } from './cvss4.ts'
export { GUARDED_SURFACE_PATTERNS, SCREENED_EXTENSIONS, SINK_PATTERNS, surfaceOperands } from './sink-patterns.ts'
export { declarationCoversLine, parseSinkCitation } from './sink-citation.ts'
export type { SinkCitation } from './sink-citation.ts'
export { claimHash, rootFingerprint } from './fingerprint.ts'
export { classifyRuns, runSatisfied } from './verdict.ts'
export type { PoCRunRecord } from './verdict.ts'
export default HardVerifier
