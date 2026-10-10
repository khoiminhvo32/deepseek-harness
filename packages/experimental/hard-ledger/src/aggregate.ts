/**
 * Pure ledger aggregates over one folded projection state. The service
 * methods delegate here, and the pilot report folds the log through the
 * projection and reads these same functions — one implementation of the
 * matrix-filtered, inert-aware math, never a report-side re-derivation.
 * @module @deepseek-ai/dsh-experimental-hard-ledger
 */

import { cellSampledForPercent, classScope } from './scope.ts'
import type { HardCoverageCellData, HardCoverageSource } from './types.ts'
import type { HardLedgerProjectionState } from './projection.ts'

/** Default share of screened cells the openWork re-read sends back. */
export const DEFAULT_SCREEN_SPOT_CHECK_PERCENT = 5

/** Default number of trailing sweeps the completion assessment requires. */
export const DEFAULT_EMPTY_SWEEPS_TO_FINISH = 2

/** Default share of indexed entry points recorded features must cover, in percent. */
export const DEFAULT_MIN_ENTRY_MAPPED_PERCENT = 80

/** Verdicted matrix cells over the matrix cell total, `0/0` without a matrix. */
export type CoverageProgress = { verdicted: number; total: number }

/** Verdicted matrix cells partitioned by decider: model, model-verified, harness. */
export type CoverageBySource = { model: number; modelVerified: number; harness: number }

/** Refuted verdicts per cause code plus the protocol/genuine/infrastructure reading groups. */
export type RefutationBreakdown = {
  readonly byCause: Readonly<Record<string, number>>
  /** `benign-arm-passed` plus `no-marker`: the model has not internalized the proof contract. */
  readonly protocolFailures: number
  /** `nonzero-exit`: the exploit did not happen — a clean target produces these too. */
  readonly genuineRefutations: number
  /** `timeout` plus `aborted` plus `no-runs`: infrastructure, no conclusion available. */
  readonly infrastructure: number
}

/** One coverage entry as the projection folds it: zod's optional keeps `| undefined`. */
type FoldedCoverageCell = HardLedgerProjectionState['coverage'][number]

/** The two ledger thresholds the work and gate aggregates need. */
export interface LedgerThresholds {
  /** Share of batch-cleared cells openWork sends back for a manual re-read, in percent. */
  readonly screenSpotCheckPercent: number
  /** Trailing empty-verified sweeps the completion assessment requires. */
  readonly emptySweepsToFinish: number
  /** Share of indexed entry points recorded features must cover, in percent; `0` drops the condition. */
  readonly minEntryMappedPercent: number
}

/** Re-shape one folded cell so the optional source drops its `| undefined`. */
function cellData(cell: FoldedCoverageCell): HardCoverageCellData {
  const { source, ...rest } = cell
  return { ...rest, ...(source === undefined ? {} : { source }) }
}

/**
 * The latest verdict for every event-backed matrix cell: module-scoped
 * classes in matrix order, then each repository-scoped class once. Cells
 * outside the matrix are never listed; inert modules without an event are
 * absent here — they surface as `harness` counts in `coverageBySourceFromState`.
 * @param state - the folded ledger projection state.
 * @returns one record per verdicted matrix cell.
 */
export function matrixCellsFromState(state: HardLedgerProjectionState): readonly HardCoverageCellData[] {
  const matrix = state.matrix
  if (matrix === undefined) return []
  const matrixModules = new Set(matrix.modules)
  const latest = new Map<string, HardCoverageCellData>()
  for (const cell of state.coverage) {
    if (matrixModules.has(cell.module)) latest.set(`${cell.module}\u0000${cell.bugClass}`, cellData(cell))
  }
  const cells: HardCoverageCellData[] = []
  for (const module of matrix.modules) {
    for (const bugClass of matrix.bugClasses) {
      if (classScope(bugClass) !== 'module') continue
      const cell = latest.get(`${module}\u0000${bugClass}`)
      if (cell !== undefined) cells.push(cell)
    }
  }
  for (const bugClass of matrix.bugClasses) {
    if (classScope(bugClass) !== 'repo') continue
    const folded = [...state.coverage].reverse().find(entry => entry.bugClass === bugClass)
    if (folded !== undefined) cells.push(cellData(folded))
  }
  return cells
}

/**
 * Coverage progress over the matrix, filtered to matrix rows exactly as the
 * `coverageProgress` service method reports it: matrix cells holding a
 * verdict, of the whole matrix; inert modules count as screened; a
 * repository-scoped class is verdicted once.
 * @param state - the folded ledger projection state.
 * @returns the verdicted count and the matrix cell total, `0/0` without a matrix.
 */
export function coverageProgressFromState(state: HardLedgerProjectionState): CoverageProgress {
  const matrix = state.matrix
  if (matrix === undefined) return { verdicted: 0, total: 0 }
  const inert = new Set(matrix.inertModules ?? [])
  const moduleClasses = matrix.bugClasses.filter(bugClass => classScope(bugClass) === 'module')
  const repoClasses = matrix.bugClasses.filter(bugClass => classScope(bugClass) === 'repo')
  const verdictedModuleCells = new Set(state.coverage.map(cell => `${cell.module}\u0000${cell.bugClass}`))
  let verdicted = 0
  for (const module of matrix.modules) {
    for (const bugClass of moduleClasses) {
      if (inert.has(module) || verdictedModuleCells.has(`${module}\u0000${bugClass}`)) verdicted += 1
    }
  }
  for (const bugClass of repoClasses) {
    if (state.coverage.some(cell => cell.bugClass === bugClass)) verdicted += 1
  }
  return { verdicted, total: matrix.modules.length * moduleClasses.length + repoClasses.length }
}

/**
 * Verdicted matrix cells partitioned by who decided them, exactly as the
 * `coverageBySource` service method reports it: the model's own reads,
 * batch screens the model cleared without reading, and every harness decision —
 * both a re-open the harness appended over a model verdict and the purely
 * mechanical inert-module screen. A cell carrying no source reads as
 * `model`, so older logs partition unchanged.
 * @param state - the folded ledger projection state.
 * @returns the three counts; all zero without a matrix.
 */
export function coverageBySourceFromState(state: HardLedgerProjectionState): CoverageBySource {
  const matrix = state.matrix
  if (matrix === undefined) return { model: 0, modelVerified: 0, harness: 0 }
  const inert = new Set(matrix.inertModules ?? [])
  const matrixModules = new Set(matrix.modules)
  const latest = new Map<string, HardCoverageCellData>()
  for (const cell of state.coverage) {
    if (matrixModules.has(cell.module)) latest.set(`${cell.module}\u0000${cell.bugClass}`, cellData(cell))
  }
  const moduleClasses = matrix.bugClasses.filter(bugClass => classScope(bugClass) === 'module')
  const repoClasses = matrix.bugClasses.filter(bugClass => classScope(bugClass) === 'repo')
  const counts = { model: 0, modelVerified: 0, harness: 0 }
  const tally = (source: HardCoverageSource | undefined): void => {
    if (source === 'harness') counts.harness += 1
    else if (source === 'model-verified') counts.modelVerified += 1
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
    const folded = [...state.coverage].reverse().find(entry => entry.bugClass === bugClass)
    if (folded !== undefined) tally(cellData(folded).source)
  }
  return counts
}

/**
 * Model-cleared module-scoped matrix cells in modules the coverage
 * cross-check cannot screen, exactly as the `blindClears` service method
 * reports it. Nothing but the model's own read stands behind such a cell: the
 * grep is silent there, so it neither re-opens nor corroborates. Harness
 * decisions (re-opens and the inert screen) never count; repository-scoped
 * classes never count, because their cells are not tied to one module's
 * files. Zero without a matrix or on an arming record that predates the
 * screenability field.
 * @param state - the folded ledger projection state.
 * @returns the blind-clear count.
 */
export function blindClearsFromState(state: HardLedgerProjectionState): number {
  const unscreened = new Set(state.matrix?.unscreenedModules ?? [])
  if (unscreened.size === 0) return 0
  let blind = 0
  for (const cell of matrixCellsFromState(state)) {
    if (cell.verdict !== 'cleared' || cell.source === 'harness') continue
    if (classScope(cell.bugClass) !== 'module') continue
    if (unscreened.has(cell.module)) blind += 1
  }
  return blind
}

/**
 * Refuted verdicts decomposed by cause code, exactly as the
 * `refutationBreakdown` service method reports it, so one run can say
 * whether it failed at the protocol layer or the target layer.
 * @param state - the folded ledger projection state.
 * @returns refuted-verdict counts per cause plus the reading groups; a
 *   refuted verdict predating the cause codes counts under `unattributed`
 *   in `byCause` and in no group.
 */
export function refutationBreakdownFromState(state: HardLedgerProjectionState): RefutationBreakdown {
  const byCause: Record<string, number> = {}
  let protocolFailures = 0
  let genuineRefutations = 0
  let infrastructure = 0
  for (const entry of state.findings) {
    const verdict = entry.verdict
    if (verdict === undefined || verdict.verdict !== 'refuted') continue
    const cause = verdict.cause ?? 'unattributed'
    byCause[cause] = (byCause[cause] ?? 0) + 1
    if (cause === 'benign-arm-passed' || cause === 'no-marker') protocolFailures += 1
    else if (cause === 'nonzero-exit') genuineRefutations += 1
    else if (cause === 'timeout' || cause === 'aborted' || cause === 'no-runs') infrastructure += 1
  }
  return { byCause, protocolFailures, genuineRefutations, infrastructure }
}

/**
 * Matrix cells that still need the model, in matrix order: sorted modules
 * outer, the configured class order inner, then repository-scoped cells
 * under the `.` module. Inert modules carry no module-class surface and are
 * never listed; a repository-scoped class is listed once, not per module.
 * @param state - the folded ledger projection state.
 * @returns one entry per uncovered matrix cell, empty without a matrix.
 */
export function uncoveredCellsFromState(state: HardLedgerProjectionState): readonly { module: string; bugClass: string }[] {
  const matrix = state.matrix
  if (matrix === undefined) return []
  const inert = new Set(matrix.inertModules ?? [])
  const verdicted = new Set(state.coverage.map(cell => `${cell.module}\u0000${cell.bugClass}`))
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
    if (classScope(bugClass) === 'repo' && !state.coverage.some(cell => cell.bugClass === bugClass)) {
      uncovered.push({ module: '.', bugClass })
    }
  }
  return uncovered
}

/**
 * One cell of the coverage board: a matrix cell with its current state. A
 * cell without a verdict carries neither `verdict` nor `source`; an inert
 * module's cell is the harness's screen; a repository-scoped class appears
 * once under the `.` module.
 */
export interface HardMatrixBoardCell {
  readonly module: string
  readonly bugClass: string
  readonly scope: 'module' | 'repo'
  readonly verdict?: HardCoverageCellData['verdict']
  readonly source?: HardCoverageSource
  /** A model clear in a module the coverage cross-check cannot screen. */
  readonly blind: boolean
}

/**
 * Every matrix cell with its current state, in matrix order: sorted modules
 * outer and the configured class order inner for module-scoped classes, then
 * each repository-scoped class once under the `.` module. Off-matrix cells
 * never appear. This is the board the model reads to see what it is being
 * pushed through, so it lists every cell — the caller filters and bounds it.
 * @param state - the folded ledger projection state.
 * @returns one entry per matrix cell; empty without a matrix.
 */
export function matrixBoardFromState(state: HardLedgerProjectionState): readonly HardMatrixBoardCell[] {
  const matrix = state.matrix
  if (matrix === undefined) return []
  const inert = new Set(matrix.inertModules ?? [])
  const unscreened = new Set(matrix.unscreenedModules ?? [])
  const latest = new Map<string, HardCoverageCellData>()
  for (const cell of state.coverage) latest.set(`${cell.module}\u0000${cell.bugClass}`, cellData(cell))
  const decided = (
    module: string,
    bugClass: string,
    scope: 'module' | 'repo',
    cell: HardCoverageCellData | undefined,
  ): HardMatrixBoardCell => {
    if (cell === undefined) return { module, bugClass, scope, blind: false }
    const source = cell.source ?? 'model'
    const blind = scope === 'module' && cell.verdict === 'cleared' && source !== 'harness' && unscreened.has(module)
    return { module, bugClass, scope, verdict: cell.verdict, source, blind }
  }
  const board: HardMatrixBoardCell[] = []
  for (const module of matrix.modules) {
    for (const bugClass of matrix.bugClasses) {
      if (classScope(bugClass) !== 'module') continue
      const cell = latest.get(`${module}\u0000${bugClass}`)
      board.push(cell === undefined && inert.has(module)
        ? { module, bugClass, scope: 'module', verdict: 'cleared', source: 'harness', blind: false }
        : decided(module, bugClass, 'module', cell))
    }
  }
  for (const bugClass of matrix.bugClasses) {
    if (classScope(bugClass) !== 'repo') continue
    const folded = [...state.coverage].reverse().find(entry => entry.bugClass === bugClass)
    board.push(decided('.', bugClass, 'repo', folded === undefined ? undefined : cellData(folded)))
  }
  return board
}

/** Open work counted by kind, for a summary that names how much remains without listing it. */
export type OpenWorkCounts = {
  /** Proposed findings the verifier has not decided. */
  readonly pendingFindings: number
  /** Findings whose runs split. */
  readonly flakyFindings: number
  /** Hypotheses still proposed, testing, or deferred. */
  readonly openHypotheses: number
  /** Matrix cells with no verdict yet. */
  readonly uncoveredCells: number
  /** Cells whose latest verdict is suspicious. */
  readonly suspiciousCells: number
  /** Batch-screened cells the spot-check sends back for a manual read. */
  readonly screenReReads: number
  /** Chain material no chain hypothesis links yet. */
  readonly unchainedMaterial: number
  /** Indexed entry points no recorded feature covers, while coverage is below the required share; otherwise 0. */
  readonly unmappedEntryPoints: number
}

/**
 * Indexed entry points no recorded feature names, in index order; empty when
 * no feature map is indexed.
 * @param state - the folded ledger projection state.
 * @returns the unmapped `kind:key` entry points.
 */
export function unmappedEntryPointsFromState(state: HardLedgerProjectionState): string[] {
  const mapped = new Set((state.features ?? []).flatMap(feature => feature.entryPoints))
  return (state.featureMap?.entryPoints ?? []).map(entry => entry.key).filter(key => !mapped.has(key))
}

/**
 * The unmapped entry points that are open work: all of them while recorded
 * features cover less than the required share, none once the share is met.
 * @param state - the folded ledger projection state.
 * @param percent - the required share of mapped entry points.
 * @returns the unmapped entry points that block completion, and the indexed total.
 */
function owedEntryPoints(state: HardLedgerProjectionState, percent: number): { owed: string[]; total: number } {
  const total = state.featureMap?.entryPoints.length ?? 0
  const unmapped = unmappedEntryPointsFromState(state)
  return { owed: (total - unmapped.length) * 100 < total * percent ? unmapped : [], total }
}

/**
 * The ids a chain hypothesis may link, in record order: every recorded
 * weakness, then every confirmed finding no weakness already names.
 * @param state - the folded ledger projection state.
 * @returns the `W-n` and `F-n` ids available as chain links.
 */
export function chainMaterialFromState(state: HardLedgerProjectionState): string[] {
  const flaws = state.flaws ?? []
  const named = new Set(flaws.map(flaw => flaw.findingId).filter(id => id !== undefined))
  const confirmed = state.findings
    .filter(entry => entry.verdict?.verdict === 'confirmed' && !named.has(entry.proposed.id))
    .map(entry => entry.proposed.id)
  return [...flaws.map(flaw => flaw.id), ...confirmed]
}

/**
 * Chain material no hypothesis links yet. With fewer than two items nothing
 * can be chained, so nothing is owed; otherwise every item must appear in at
 * least one chain hypothesis, whatever that hypothesis's status — a chain
 * proposed and refuted with its reason counts as considered.
 * @param state - the folded ledger projection state.
 * @returns the unlinked `W-n` and `F-n` ids, in record order.
 */
export function unchainedMaterialFromState(state: HardLedgerProjectionState): string[] {
  const material = chainMaterialFromState(state)
  if (material.length < 2) return []
  const linked = new Set(state.hypotheses.flatMap(hypothesis => hypothesis.links ?? []))
  return material.filter(id => !linked.has(id))
}

/**
 * Open work counted by kind, with the same predicates `openWorkFromState`
 * lists items by, so the counts and the list never disagree.
 * @param state - the folded ledger projection state.
 * @param thresholds - the ledger's screen spot-check percent.
 * @returns the per-kind counts; all zero when nothing is open.
 */
export function openWorkCountsFromState(
  state: HardLedgerProjectionState,
  thresholds: Pick<LedgerThresholds, 'screenSpotCheckPercent' | 'minEntryMappedPercent'>,
): OpenWorkCounts {
  return {
    pendingFindings: state.findings.filter(record => record.verdict === undefined).length,
    flakyFindings: state.findings.filter(record => record.verdict?.verdict === 'flaky').length,
    openHypotheses: state.hypotheses.filter(hypothesis => isOpenHypothesis(hypothesis.status)).length,
    uncoveredCells: uncoveredCellsFromState(state).length,
    suspiciousCells: state.coverage.filter(cell => cell.verdict === 'suspicious').length,
    screenReReads: state.coverage.filter(cell => isScreenReRead(cell, thresholds.screenSpotCheckPercent)).length,
    unchainedMaterial: unchainedMaterialFromState(state).length,
    unmappedEntryPoints: owedEntryPoints(state, thresholds.minEntryMappedPercent).owed.length,
  }
}

/** Whether a hypothesis status still owes work. */
function isOpenHypothesis(status: HardLedgerProjectionState['hypotheses'][number]['status']): boolean {
  return status === 'proposed' || status === 'testing' || status === 'deferred'
}

/** Whether the spot-check sends one batch-screened cell back for a manual read. */
function isScreenReRead(cell: FoldedCoverageCell, percent: number): boolean {
  return cell.source === 'model-verified' && cellSampledForPercent(cell, percent)
}

/**
 * Model-facing open work summary, identical to the service method's output:
 * pending verifications, unresolved states, coverage cells that still owe
 * work, and batch-cleared cells the deterministic screen spot-check sends
 * back for a manual re-read.
 * @param state - the folded ledger projection state.
 * @param thresholds - the ledger's screen spot-check percent.
 * @returns bounded human-readable work items, empty when nothing is open.
 */
export function openWorkFromState(
  state: HardLedgerProjectionState,
  thresholds: Pick<LedgerThresholds, 'screenSpotCheckPercent' | 'minEntryMappedPercent'>,
): string[] {
  const work: string[] = []
  for (const record of state.findings) {
    if (record.verdict === undefined) work.push(`finding ${record.proposed.id} awaits verification`)
    if (record.verdict?.verdict === 'flaky') {
      work.push(`finding ${record.proposed.id} is flaky: ${record.verdict.reason}`)
    }
  }
  for (const hypothesis of state.hypotheses) {
    if (isOpenHypothesis(hypothesis.status)) {
      work.push(`hypothesis ${hypothesis.id} is ${hypothesis.status}`)
    }
  }
  const uncovered = uncoveredCellsFromState(state)
  if (uncovered.length > 0) {
    work.push(`${uncovered.length} coverage cell(s) have no verdict yet`)
    for (const cell of uncovered.slice(0, 5)) {
      work.push(`cell ${cell.module} × ${cell.bugClass} has no verdict`)
    }
  }
  for (const cell of state.coverage) {
    if (cell.verdict === 'suspicious') {
      work.push(`cell ${cell.module} × ${cell.bugClass} is suspicious: re-verify the declared sinks`)
    }
    if (isScreenReRead(cell, thresholds.screenSpotCheckPercent)) {
      work.push(`cell ${cell.module} × ${cell.bugClass} was batch-cleared; verify the mechanical screen`)
    }
  }
  for (const id of unchainedMaterialFromState(state)) {
    work.push(`${id} is in no chain hypothesis: link it with another weakness or finding, or propose that chain and refute it with the reason`)
  }
  const { owed, total } = owedEntryPoints(state, thresholds.minEntryMappedPercent)
  if (owed.length > 0) {
    work.push(`${owed.length} of ${total} entry points are in no recorded feature; features must cover ${thresholds.minEntryMappedPercent}%: map them with hard_record_feature`)
    for (const key of owed.slice(0, 5)) work.push(`entry point ${key} is in no feature`)
  }
  return work
}

/**
 * Consecutive empty-verified sweep summaries ending at the latest one. Proof
 * validity is a record-time invariant, so `newFindings === 0` is the whole
 * predicate here.
 * @param state - the folded ledger projection state.
 * @returns the trailing run length, bounded by the projection's sweep window.
 */
export function emptySweepRunFromState(state: HardLedgerProjectionState): number {
  const recent = [...state.recentSweeps].reverse()
  let run = 0
  for (const sweep of recent) {
    if (sweep.newFindings !== 0) break
    run += 1
  }
  return run
}

/** The harness's verdict on one completion attempt, with its bounded blockers. */
export type CompletionAssessment = { complete: boolean; blockers: readonly string[] }

/** Maximum blocking items one completion assessment lists before it summarizes the rest. */
const AGGREGATE_BLOCKER_LIMIT = 8

/**
 * Whether the harness certifies the mission complete, identical to the
 * service method's output: no open work, the trailing sweep window all
 * empty-verified, and at least one model-audited coverage cell or resolved
 * hypothesis so a fully harness-screened or fully batch-screened repository
 * reads as "nothing audited yet", not "done". Never counts findings.
 * @param state - the folded ledger projection state.
 * @param thresholds - the ledger's spot-check percent and trailing-sweep requirement.
 * @returns the verdict plus the bounded blockers, phrased to serve directly as the denial reason.
 */
export function completionAssessmentFromState(state: HardLedgerProjectionState, thresholds: LedgerThresholds): CompletionAssessment {
  const blockers: string[] = []
  const work = openWorkFromState(state, thresholds)
  if (work.length > 0) {
    blockers.push(...work.slice(0, AGGREGATE_BLOCKER_LIMIT))
    if (work.length > AGGREGATE_BLOCKER_LIMIT) blockers.push(`…and ${work.length - AGGREGATE_BLOCKER_LIMIT} more open item(s)`)
  }
  if (thresholds.emptySweepsToFinish > 0) {
    const trailing = emptySweepRunFromState(state)
    if (trailing < thresholds.emptySweepsToFinish) {
      blockers.push(`${trailing} of ${thresholds.emptySweepsToFinish} final sweeps are empty-verified`)
    }
  }
  const bySource = coverageBySourceFromState(state)
  const resolved = state.hypotheses
    .filter(hypothesis => hypothesis.status === 'confirmed' || hypothesis.status === 'refuted').length
  // The audit floor asks whether any model read stands: a cell the model
  // decided individually that the harness has not re-opened. A re-open
  // appends the latest verdict under the harness's name, so the bySource
  // counts already exclude flipped cells. A batch screen (`model-verified`)
  // never counts — the model read none of those cells, and a silent grep is
  // not an audit.
  if (bySource.model === 0 && resolved === 0) {
    blockers.push('no model-audited coverage cell or resolved hypothesis exists yet')
  }
  return { complete: blockers.length === 0, blockers }
}
