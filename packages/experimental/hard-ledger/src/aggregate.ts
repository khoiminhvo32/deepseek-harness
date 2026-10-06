/**
 * Pure ledger aggregates over one folded projection state. The service
 * methods delegate here, and the pilot report folds the log through the
 * projection and reads these same functions — one implementation of the
 * matrix-filtered, inert-aware math, never a report-side re-derivation.
 * @module @deepseek-ai/dsh-experimental-hard-ledger
 */

import { classScope } from './scope.ts'
import type { HardCoverageCellData, HardCoverageSource } from './types.ts'
import type { HardLedgerProjectionState } from './projection.ts'

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
 * batch clears the harness grep confirmed, and the purely mechanical
 * inert-module screen. A cell carrying no source reads as `model`, so older
 * logs partition unchanged.
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
    const folded = [...state.coverage].reverse().find(entry => entry.bugClass === bugClass)
    if (folded !== undefined) tally(cellData(folded).source)
  }
  return counts
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
