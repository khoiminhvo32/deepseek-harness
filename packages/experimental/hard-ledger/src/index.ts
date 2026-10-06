/**
 * Log-derived ledger on the `hardLedger` key. The service validates and
 * appends `hard/*` session events and reads state from the hard-ledger
 * session projection, which the framework restores at resume and advances
 * on every commit; there is no parallel store and no historical scanning.
 * @module @deepseek-ai/dsh-experimental-hard-ledger
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  HardCoverageCellData,
  HardCoverageSource,
  HardCoverageVerdict,
  HardFindingId,
  HardFindingProposedData,
  HardFindingVerdictData,
  HardHypothesisId,
  HardHypothesisStateData,
  HardHypothesisStatus,
  HardMissionArmedData,
  HardSweepSummaryData,
} from './types.ts'
import type { HardCoverageMatrix, HardLedgerFindingEntry, HardLedgerProjectionState } from './projection.ts'
import { hardLedgerProjectionDefinition } from './projection.ts'
import { cellSampledForPercent, classScope } from './scope.ts'
import './domain.ts'

export type {
  HardCoverageCellData,
  HardCoverageSource,
  HardCoverageVerdict,
  HardFindingId,
  HardFindingProposedData,
  HardFindingVerdictData,
  HardHypothesisId,
  HardHypothesisStateData,
  HardHypothesisStatus,
  HardMissionArmedData,
  HardSweepSummaryData,
  HardVerdict,
} from './types.ts'
export { applyHardLedgerProjection, emptyHardLedgerState, hardLedgerProjectionDefinition } from './projection.ts'
export type { HardCoverageMatrix, HardLedgerProjectionState, HardLedgerFindingEntry } from './projection.ts'
export { cellSampledForPercent, CLASS_SCOPE, classScope } from './scope.ts'

declare module '@deepseek-ai/cordis' {
  /** The log-derived hard-harness ledger service. */
  interface Context {
    hardLedger: HardLedger
  }
}

/** Ledger service config. */
export interface Config {
  /**
   * Share of `model-verified` (batch-cleared) coverage cells openWork sends
   * back for a manual model re-read, in percent. Sampling is deterministic
   * per cell hash, so the same cell is always re-read or never; `0` disables
   * the re-read. This is the only measurement of the mechanical screen's
   * false-negative rate.
   */
  screenSpotCheckPercent?: number
}

/** Default share of screened cells the openWork re-read sends back. */
export const DEFAULT_SCREEN_SPOT_CHECK_PERCENT = 5

/** Schemastery config for the ledger service. */
export const Config: z<Config> = z.object({
  screenSpotCheckPercent: z.number().step(1).min(0).max(100).default(DEFAULT_SCREEN_SPOT_CHECK_PERCENT),
})

/** Fully materialized ledger settings. */
interface ResolvedConfig {
  readonly screenSpotCheckPercent: number
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const screenSpotCheckPercent = config.screenSpotCheckPercent ?? DEFAULT_SCREEN_SPOT_CHECK_PERCENT
  if (!Number.isSafeInteger(screenSpotCheckPercent) || screenSpotCheckPercent < 0 || screenSpotCheckPercent > 100) {
    throw new TypeError('screenSpotCheckPercent must be a safe integer from 0 through 100')
  }
  return { screenSpotCheckPercent }
}

/** Maximum characters retained for bounded reason and statement text. */
export const HARD_TEXT_LIMIT = 2000

/** Maximum coverage matrix rows one arming record may carry. */
export const HARD_MATRIX_MODULE_LIMIT = 500

/**
 * The hard-harness ledger: validates and appends `hard/*` events, and serves
 * findings, hypotheses, coverage, the armed coverage matrix, and open-work
 * state from the projection.
 */
export class HardLedger extends Service {
  static inject = ['sessionProjections']

  static Config: z<Config> = Config

  private readonly resolved: ResolvedConfig

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'hardLedger')
    this.resolved = resolveConfig(config)
    ctx.sessionProjections.register(hardLedgerProjectionDefinition)
  }

  /**
   * Append the mission arming record: the pinned target and the enumerated
   * coverage matrix axes. The mission plugin appends it once, right after
   * the goal is created.
   * @param agent - the live agent whose session receives the record.
   * @param data - the armed payload to persist.
   */
  recordMissionArmed(agent: Agent, data: HardMissionArmedData): void {
    this.assertText('objective', data.objective)
    this.assertText('targetRepo', data.targetRepo)
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(data.commit)) {
      throw new HarnessError('commit must be a full lowercase hex sha', 'HARD_LEDGER_INVALID_COMMIT')
    }
    const modules = [...data.modules]
    if (modules.length === 0) {
      throw new HarnessError('modules must list at least one module', 'HARD_LEDGER_EMPTY_MATRIX')
    }
    if (modules.length > HARD_MATRIX_MODULE_LIMIT) {
      throw new HarnessError(
        `modules must not exceed ${HARD_MATRIX_MODULE_LIMIT} rows`, 'HARD_LEDGER_MATRIX_TOO_LARGE',
      )
    }
    for (const module of modules) this.assertText('modules[]', module)
    const sorted = [...modules].sort()
    if (sorted.some((module, index) => module !== modules[index])
      || new Set(modules).size !== modules.length) {
      throw new HarnessError('modules must be sorted and deduplicated', 'HARD_LEDGER_UNSORTED_MATRIX')
    }
    let inertModules: readonly string[] = []
    if (data.inertModules !== undefined) {
      const suppliedInert: readonly string[] = data.inertModules
      if (suppliedInert.some(module => typeof module !== 'string' || module.trim().length === 0)) {
        throw new HarnessError('inertModules must be an array of non-empty module names', 'HARD_LEDGER_INVALID_TEXT')
      }
      const inertSorted = [...suppliedInert].sort()
      if (inertSorted.some((module, index) => module !== suppliedInert[index])
        || new Set(suppliedInert).size !== suppliedInert.length
        || suppliedInert.some(module => !modules.includes(module))) {
        throw new HarnessError('inertModules must be a sorted deduplicated subset of modules', 'HARD_LEDGER_UNSORTED_MATRIX')
      }
      inertModules = [...suppliedInert]
    }
    for (const bugClass of data.bugClasses) this.assertText('bugClasses[]', bugClass)
    agent.session.append('hard/mission/armed', {
      objective: data.objective,
      targetRepo: data.targetRepo,
      commit: data.commit,
      modules,
      bugClasses: [...data.bugClasses],
      ...(data.inertModules === undefined ? {} : { inertModules }),
    })
  }

  /**
   * Append one validated finding-proposal record and return its id.
   * @param agent - the live agent whose session receives the record.
   * @param request - the validated finding fields; id assigned from the projection.
   * @returns the assigned finding id.
   */
  proposeFinding(agent: Agent, request: Omit<HardFindingProposedData, 'id'>): HardFindingId {
    this.assertText('title', request.title)
    this.assertText('claim', request.claim)
    this.assertText('component', request.component)
    this.assertText('bugClass', request.bugClass)
    if (!request.cvssVector.startsWith('CVSS:4.0/')) {
      throw new HarnessError('cvssVector must start with CVSS:4.0/', 'HARD_LEDGER_INVALID_VECTOR')
    }
    if (!Number.isFinite(request.cvssClaimed) || request.cvssClaimed < 0 || request.cvssClaimed > 10) {
      throw new HarnessError('cvssClaimed must be a number between 0 and 10', 'HARD_LEDGER_INVALID_SCORE')
    }
    this.assertText('pocPath', request.pocPath)
    this.assertHex('claimHash', request.claimHash, 64)
    this.assertHex('fingerprint', request.fingerprint, 64)
    const id = brandString<HardFindingId>(`F-${this.state(agent.session).findings.length + 1}`)
    agent.session.append('hard/finding/proposed', { ...request, id })
    return id
  }

  /**
   * Append the verifier's executed outcome for one proposed finding.
   * @param agent - the live agent whose session receives the record.
   * @param data - the verdict payload to persist.
   */
  recordVerdict(agent: Agent, data: HardFindingVerdictData): void {
    this.assertText('reason', data.reason)
    this.assertHex('fingerprint', data.fingerprint, 64)
    agent.session.append('hard/finding/verdict', data)
  }

  /**
   * Propose a new hypothesis or transition an existing one through its lifecycle.
   * @param agent - the live agent whose session receives the record.
   * @param request - statement, status, optional existing id, and conditional reason.
   * @returns the assigned or confirmed hypothesis id.
   */
  writeHypothesis(
    agent: Agent,
    request: { id?: string; statement: string; status: HardHypothesisStatus; reason?: string },
  ): HardHypothesisId {
    this.assertText('statement', request.statement)
    if (request.status === 'refuted' || request.status === 'deferred') {
      if (request.reason === undefined || request.reason.trim().length === 0) {
        throw new HarnessError(
          `status ${request.status} requires a concrete reason`, 'HARD_LEDGER_REASON_REQUIRED',
        )
      }
      this.assertText('reason', request.reason)
    }
    if (request.status === 'testing' && !request.id) {
      throw new HarnessError('status testing requires an existing hypothesis id', 'HARD_LEDGER_ID_REQUIRED')
    }
    const known = this.hypothesisIds(agent)
    let id: HardHypothesisId
    if (request.id === undefined) {
      id = brandString<HardHypothesisId>(`H-${known.length + 1}`)
    } else {
      id = brandString<HardHypothesisId>(request.id)
      if (!known.includes(id)) {
        throw new HarnessError(`unknown hypothesis id ${request.id}`, 'HARD_LEDGER_UNKNOWN_HYPOTHESIS')
      }
    }
    const record: HardHypothesisStateData = {
      id,
      statement: request.statement,
      status: request.status,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    }
    agent.session.append('hard/hypothesis/state', record)
    return id
  }

  /**
   * Append one coverage cell verdict, replacing any prior verdict for the cell.
   * @param agent - the live agent whose session receives the record.
   * @param request - the cell coordinates, verdict, and declared sink sites.
   */
  markCoverage(agent: Agent, request: HardCoverageCellData): void {
    this.assertText('module', request.module)
    this.assertText('bugClass', request.bugClass)
    const verdicts: readonly HardCoverageVerdict[] = ['cleared', 'suspicious', 'uncovered']
    if (!verdicts.includes(request.verdict)) {
      throw new HarnessError(
        `verdict must be one of ${verdicts.join(', ')}`, 'HARD_LEDGER_INVALID_COVERAGE_VERDICT',
      )
    }
    const sources: readonly HardCoverageSource[] = ['model', 'model-verified', 'harness']
    if (request.source !== undefined && !sources.includes(request.source)) {
      throw new HarnessError(
        `source must be one of ${sources.join(', ')}`, 'HARD_LEDGER_INVALID_COVERAGE_SOURCE',
      )
    }
    if (request.verdict === 'cleared' && request.declaredSinks.length === 0) {
      throw new HarnessError(
        'cleared requires the declared sinks inspected for this cell', 'HARD_LEDGER_SINKS_REQUIRED',
      )
    }
    for (const sink of request.declaredSinks) this.assertText('declaredSinks[]', sink)
    agent.session.append('hard/coverage/cell', {
      ...request,
      declaredSinks: [...request.declaredSinks],
      ...(request.source === undefined ? {} : { source: request.source }),
    })
  }

  /**
   * Append one completed sweep summary.
   * @param agent - the live agent whose session receives the record.
   * @param request - the sweep phase, counters, and conditional empty proof.
   */
  recordSweep(agent: Agent, request: HardSweepSummaryData): void {
    if (!Number.isSafeInteger(request.cellsTouched) || request.cellsTouched < 0) {
      throw new HarnessError('cellsTouched must be a non-negative safe integer', 'HARD_LEDGER_INVALID_SWEEP')
    }
    if (!Number.isSafeInteger(request.newFindings) || request.newFindings < 0) {
      throw new HarnessError('newFindings must be a non-negative safe integer', 'HARD_LEDGER_INVALID_SWEEP')
    }
    if (request.newFindings === 0 && (request.emptyProof === undefined || request.emptyProof.trim().length === 0)) {
      throw new HarnessError(
        'an empty sweep requires emptyProof evidence', 'HARD_LEDGER_EMPTY_PROOF_REQUIRED',
      )
    }
    if (request.emptyProof !== undefined) this.assertText('emptyProof', request.emptyProof)
    agent.session.append('hard/sweep/summary', request)
  }

  /**
   * Findings folded from the projection, proposal plus latest verdict when present.
   * @param agent - the live agent whose ledger state is read.
   * @returns one record per proposal in id order.
   */
  findings(agent: Agent): readonly HardLedgerFindingEntry[] {
    return this.state(agent.session).findings.map(entry => ({
      proposed: this.brandedProposal(entry.proposed),
      ...entry.verdict === undefined
        ? {}
        : { verdict: { ...entry.verdict, id: brandString<HardFindingId>(entry.verdict.id) } },
    }))
  }

  /**
   * Hypotheses folded to their latest state per id.
   * @param agent - the live agent whose ledger state is read.
   * @returns one record per hypothesis id.
   */
  hypotheses(agent: Agent): readonly HardHypothesisStateData[] {
    return this.state(agent.session).hypotheses.map(({ id, statement, status, ...rest }) => ({
      id: brandString<HardHypothesisId>(id),
      statement,
      status,
      ...rest.reason === undefined ? {} : { reason: rest.reason },
    }))
  }

  /** Restore the branded id view over one persisted proposal record. */
  private brandedProposal(
    proposed: Omit<HardFindingProposedData, 'id' | 'hypothesisId'> & {
      id: string
      hypothesisId?: string | undefined
    },
  ): HardFindingProposedData {
    const { id, hypothesisId, ...rest } = proposed
    return {
      ...rest,
      id: brandString<HardFindingId>(id),
      ...hypothesisId === undefined ? {} : { hypothesisId: brandString<HardHypothesisId>(hypothesisId) },
    }
  }

  /**
   * Coverage cells folded to their latest verdict per module and class.
   * @param agent - the live agent whose ledger state is read.
   * @returns one record per module and bug-class cell.
   */
  coverage(agent: Agent): readonly HardCoverageCellData[] {
    return this.state(agent.session).coverage.map(({ source, ...cell }) => ({
      ...cell,
      ...(source === undefined ? {} : { source }),
    }))
  }

  /**
   * Count of recorded sweeps by phase, for the rotation cadence.
   * @param agent - the live agent whose ledger state is read.
   * @param phase - the sweep phase to count.
   * @returns the number of summaries recorded for the phase.
   */
  sweepCount(agent: Agent, phase: 'A' | 'B'): number {
    return this.state(agent.session).sweeps[phase]
  }

  /**
   * The coverage matrix folded from the mission arming record.
   * @param agent - the live agent whose ledger state is read.
   * @returns the matrix axes and pinned target, or `undefined` when no
   *   arming record exists (legacy log, or the mission plugin is not mounted).
   */
  coverageMatrix(agent: Agent): HardCoverageMatrix | undefined {
    return this.state(agent.session).matrix
  }

  /**
   * Coverage progress over the matrix: matrix cells holding a verdict,
   * of the whole matrix. Cells outside the matrix never count. A
   * repository-scoped class is verdicted once for the whole repository, so
   * its verdict lookup deliberately ignores the recorded cell's module.
   * @param agent - the live agent whose ledger state is read.
   * @returns the verdicted count and the matrix cell total, `0/0` without a matrix.
   */
  coverageProgress(agent: Agent): { verdicted: number; total: number } {
    const state = this.state(agent.session)
    const matrix = state.matrix
    if (matrix === undefined) return { verdicted: 0, total: 0 }
    const inert = new Set(matrix.inertModules ?? [])
    const moduleClasses = matrix.bugClasses.filter(bugClass => classScope(bugClass) === 'module')
    const repoClasses = matrix.bugClasses.filter(bugClass => classScope(bugClass) === 'repo')
    const verdictedModuleCells = new Set(this.coverage(agent).map(cell => `${cell.module}\u0000${cell.bugClass}`))
    let verdicted = 0
    for (const module of matrix.modules) {
      for (const bugClass of moduleClasses) {
        if (inert.has(module) || verdictedModuleCells.has(`${module}\u0000${bugClass}`)) verdicted += 1
      }
    }
    for (const bugClass of repoClasses) {
      if (this.coverage(agent).some(cell => cell.bugClass === bugClass)) verdicted += 1
    }
    return { verdicted, total: matrix.modules.length * moduleClasses.length + repoClasses.length }
  }

  /**
   * Matrix cells that still need the model, in matrix order: sorted modules
   * outer, the configured class order inner, then repository-scoped cells
   * under the `.` module. Inert modules carry no module-class surface and are
   * never listed; a repository-scoped class is listed once, not per module.
   * @param agent - the live agent whose ledger state is read.
   * @returns one entry per uncovered matrix cell, empty without a matrix.
   */
  uncoveredCells(agent: Agent): readonly { module: string; bugClass: string }[] {
    const state = this.state(agent.session)
    const matrix = state.matrix
    if (matrix === undefined) return []
    const inert = new Set(matrix.inertModules ?? [])
    const verdicted = new Set(this.coverage(agent).map(cell => `${cell.module}\u0000${cell.bugClass}`))
    const uncovered: { module: string; bugClass: string }[] = []
    for (const module of matrix.modules) {
      if (inert.has(module)) continue
      for (const bugClass of matrix.bugClasses) {
        if (classScope(bugClass) === 'module' && !verdicted.has(`${module}\u0000${bugClass}`)) {
          uncovered.push({ module, bugClass })
        }
      }
    }
    for (const bugClass of matrix.bugClasses) {
      if (classScope(bugClass) === 'repo' && !this.coverage(agent).some(cell => cell.bugClass === bugClass)) {
        uncovered.push({ module: '.', bugClass })
      }
    }
    return uncovered
  }

  /**
   * Verdicted matrix cells partitioned by who decided them: the model's own
   * reads, batch clears the harness grep confirmed, and the purely mechanical
   * inert-module screen. A cell carrying no source reads as `model`, so older
   * logs partition unchanged.
   * @param agent - the live agent whose ledger state is read.
   * @returns the three counts; all zero without a matrix.
   */
  coverageBySource(agent: Agent): { model: number; modelVerified: number; harness: number } {
    const state = this.state(agent.session)
    const matrix = state.matrix
    if (matrix === undefined) return { model: 0, modelVerified: 0, harness: 0 }
    const inert = new Set(matrix.inertModules ?? [])
    const latest = new Map<string, HardCoverageCellData>()
    for (const cell of this.coverage(agent)) latest.set(`${cell.module}\u0000${cell.bugClass}`, cell)
    const moduleClasses = matrix.bugClasses.filter(bugClass => classScope(bugClass) === 'module')
    const repoClasses = matrix.bugClasses.filter(bugClass => classScope(bugClass) === 'repo')
    const counts = { model: 0, modelVerified: 0, harness: 0 }
    const tally = (source: HardCoverageSource | undefined): void => {
      if (source === 'model-verified') counts.modelVerified += 1
      else counts.model += 1
    }
    for (const module of matrix.modules) {
      for (const bugClass of moduleClasses) {
        const cell = latest.get(`${module}\u0000${bugClass}`)
        if (cell !== undefined) tally(cell.source)
        else if (inert.has(module)) counts.harness += 1
      }
    }
    for (const bugClass of repoClasses) {
      const cell = [...this.coverage(agent)].reverse().find(entry => entry.bugClass === bugClass)
      if (cell !== undefined) tally(cell.source)
    }
    return counts
  }

  /**
   * Model-facing open work summary: pending verifications, unresolved
   * states, coverage cells that still owe work, and batch-cleared cells the
   * deterministic screen spot-check sends back for a manual re-read.
   * @param agent - the live agent whose ledger state is read.
   * @returns bounded human-readable work items, empty when nothing is open.
   */
  openWork(agent: Agent): string[] {
    const work: string[] = []
    for (const record of this.state(agent.session).findings) {
      if (record.verdict === undefined) work.push(`finding ${record.proposed.id} awaits verification`)
      if (record.verdict?.verdict === 'flaky') {
        work.push(`finding ${record.proposed.id} is flaky: ${record.verdict.reason}`)
      }
    }
    for (const hypothesis of this.state(agent.session).hypotheses) {
      if (hypothesis.status === 'proposed' || hypothesis.status === 'testing' || hypothesis.status === 'deferred') {
        work.push(`hypothesis ${hypothesis.id} is ${hypothesis.status}`)
      }
    }
    const uncovered = this.uncoveredCells(agent)
    if (uncovered.length > 0) {
      work.push(`${uncovered.length} coverage cell(s) have no verdict yet`)
      for (const cell of uncovered.slice(0, 5)) {
        work.push(`cell ${cell.module} × ${cell.bugClass} has no verdict`)
      }
    }
    for (const cell of this.coverage(agent)) {
      if (cell.verdict === 'suspicious') {
        work.push(`cell ${cell.module} × ${cell.bugClass} is suspicious: re-verify the declared sinks`)
      }
      if (cell.source === 'model-verified' && cellSampledForPercent(cell, this.resolved.screenSpotCheckPercent)) {
        work.push(`cell ${cell.module} × ${cell.bugClass} was batch-cleared; verify the mechanical screen`)
      }
    }
    return work
  }

  /** Read the projection state for one agent's session. */
  private state(session: Agent['session']): HardLedgerProjectionState {
    const state = this.ctx.sessionProjections.stateOf(session, 'hardLedger')
    /* v8 ignore next -- defensive: the constructor registers the projection this read requires. */
    if (state === undefined) throw new Error('hard ledger projection is not registered')
    /* v8 ignore next -- defensive: appends are pre-validated, so replay failure is unreachable here */
    if (state.failure !== null) throw new Error(state.failure)
    return state
  }

  private hypothesisIds(agent: Agent): HardHypothesisId[] {
    return this.state(agent.session).hypotheses.map(record => brandString<HardHypothesisId>(record.id))
  }

  private assertText(field: string, value: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new HarnessError(`${field} must be a non-empty string`, 'HARD_LEDGER_INVALID_TEXT')
    }
    if (value.length > HARD_TEXT_LIMIT) {
      throw new HarnessError(`${field} must not exceed ${HARD_TEXT_LIMIT} characters`, 'HARD_LEDGER_TEXT_TOO_LONG')
    }
  }

  private assertHex(field: string, value: string, length: number): void {
    if (typeof value !== 'string' || value.length !== length || !/^[0-9a-f]+$/.test(value)) {
      throw new HarnessError(`${field} must be ${length} lowercase hex characters`, 'HARD_LEDGER_INVALID_HASH')
    }
  }
}

export default HardLedger
