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
import {
  blindClearsFromState,
  completionAssessmentFromState,
  coverageBySourceFromState,
  coverageProgressFromState,
  DEFAULT_EMPTY_SWEEPS_TO_FINISH,
  DEFAULT_SCREEN_SPOT_CHECK_PERCENT,
  emptySweepRunFromState,
  matrixBoardFromState,
  openWorkCountsFromState,
  openWorkFromState,
  refutationBreakdownFromState,
  unchainedMaterialFromState,
  uncoveredCellsFromState,
  chainMaterialFromState,
  DEFAULT_MIN_ENTRY_MAPPED_PERCENT,
  unmappedEntryPointsFromState,
} from './aggregate.ts'
import { classScope } from './scope.ts'
import type {
  CompletionAssessment,
  CoverageBySource,
  CoverageProgress,
  HardMatrixBoardCell,
  OpenWorkCounts,
  RefutationBreakdown,
} from './aggregate.ts'
import type {
  HardCoverageCellData,
  HardCoverageSource,
  HardCoverageVerdict,
  HardEmptySweepProof,
  HardFindingId,
  HardFindingProposedData,
  HardFindingRequest,
  HardFindingVerdictData,
  HardFeatureData,
  HardFeatureId,
  HardFeatureLinkData,
  HardFeatureMapIndexedData,
  HardFlawData,
  HardFlawId,
  HardFlowDocData,
  HardHypothesisId,
  HardHypothesisStateData,
  HardHypothesisStatus,
  HardMatrixExclusions,
  HardMissionArmedData,
  HardTargetSnapshot,
  HardSweepSummaryData,
} from './types.ts'
import type { HardCoverageMatrix, HardLedgerFindingEntry, HardLedgerProjectionState } from './projection.ts'
import { hardLedgerProjectionDefinition } from './projection.ts'
import './domain.ts'

export type {
  HardCoverageCellData,
  HardCoverageSource,
  HardCoverageVerdict,
  HardEmptySweepProof,
  HardFindingCause,
  HardFindingEvidence,
  HardFindingId,
  HardFindingProposedData,
  HardFindingRequest,
  HardFindingVerdictData,
  HardFeatureData,
  HardFeatureEntryRef,
  HardFeatureExclusionReason,
  HardFeatureId,
  HardFeatureLinkData,
  HardFeatureLinkKind,
  HardFeatureMapIndexedData,
  HardFeatureRole,
  HardFlawData,
  HardFlawId,
  HardFlowDocData,
  HardFlowDocSections,
  HardGateDecisionData,
  HardHypothesisId,
  HardHypothesisStateData,
  HardHypothesisStatus,
  HardLedgerClientView,
  HardMatrixExclusions,
  HardMissionArmedData,
  HardTargetSnapshot,
  HardSweepSummaryData,
  HardVerdict,
} from './types.ts'
export { applyHardLedgerProjection, emptyHardLedgerState, HARD_SWEEP_WINDOW, hardLedgerProjectionDefinition, hardLedgerStateSchema } from './projection.ts'
export type { HardCoverageMatrix, HardLedgerProjectionState, HardLedgerFindingEntry } from './projection.ts'
export {
  blindClearsFromState,
  chainMaterialFromState,
  completionAssessmentFromState,
  coverageBySourceFromState,
  coverageProgressFromState,
  emptySweepRunFromState,
  matrixBoardFromState,
  matrixCellsFromState,
  openWorkCountsFromState,
  openWorkFromState,
  refutationBreakdownFromState,
  unchainedMaterialFromState,
  uncoveredCellsFromState,
  unmappedEntryPointsFromState,
} from './aggregate.ts'
export { DEFAULT_EMPTY_SWEEPS_TO_FINISH, DEFAULT_MIN_ENTRY_MAPPED_PERCENT, DEFAULT_SCREEN_SPOT_CHECK_PERCENT } from './aggregate.ts'
export type {
  CompletionAssessment,
  CoverageBySource,
  CoverageProgress,
  HardMatrixBoardCell,
  LedgerThresholds,
  OpenWorkCounts,
  RefutationBreakdown,
} from './aggregate.ts'
export { cellSampledForPercent, CLASS_SCOPE, classScope } from './scope.ts'
export { pinnedGitArgs } from './pin.ts'

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
  /**
   * Trailing empty-verified sweeps the completion assessment requires; `0`
   * drops that condition. The assessment is a ledger judgment and every
   * consumer of it (the stop gate's veto, the rounds context) injects this
   * service, so the threshold lives here — one answer for all readers, and
   * no way for two plugins' separate configs to drift apart.
   */
  emptySweepsToFinish?: number
  /**
   * Share of the indexed feature map's entry points recorded features must
   * cover before the mission can complete, in percent; `0` drops the
   * condition. Without an indexed feature map there is nothing to cover.
   */
  minEntryMappedPercent?: number
}

/** Schemastery config for the ledger service. */
export const Config: z<Config> = z.object({
  screenSpotCheckPercent: z.number().step(1).min(0).max(100).default(DEFAULT_SCREEN_SPOT_CHECK_PERCENT),
  emptySweepsToFinish: z.number().step(1).min(0).max(16).default(DEFAULT_EMPTY_SWEEPS_TO_FINISH),
  minEntryMappedPercent: z.number().step(1).min(0).max(100).default(DEFAULT_MIN_ENTRY_MAPPED_PERCENT),
})

/** Fully materialized ledger settings. */
interface ResolvedConfig {
  readonly screenSpotCheckPercent: number
  readonly emptySweepsToFinish: number
  readonly minEntryMappedPercent: number
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const screenSpotCheckPercent = config.screenSpotCheckPercent ?? DEFAULT_SCREEN_SPOT_CHECK_PERCENT
  if (!Number.isSafeInteger(screenSpotCheckPercent) || screenSpotCheckPercent < 0 || screenSpotCheckPercent > 100) {
    throw new TypeError('screenSpotCheckPercent must be a safe integer from 0 through 100')
  }
  const emptySweepsToFinish = config.emptySweepsToFinish ?? DEFAULT_EMPTY_SWEEPS_TO_FINISH
  if (!Number.isSafeInteger(emptySweepsToFinish) || emptySweepsToFinish < 0 || emptySweepsToFinish > 16) {
    throw new TypeError('emptySweepsToFinish must be a safe integer from 0 through 16')
  }
  const minEntryMappedPercent = config.minEntryMappedPercent ?? DEFAULT_MIN_ENTRY_MAPPED_PERCENT
  if (!Number.isSafeInteger(minEntryMappedPercent) || minEntryMappedPercent < 0 || minEntryMappedPercent > 100) {
    throw new TypeError('minEntryMappedPercent must be a safe integer from 0 through 100')
  }
  return { screenSpotCheckPercent, emptySweepsToFinish, minEntryMappedPercent }
}

/** Maximum characters retained for bounded reason and statement text. */
export const HARD_TEXT_LIMIT = 2000

/** Maximum coverage matrix rows one arming record may carry. */
export const HARD_MATRIX_MODULE_LIMIT = 500

/** Maximum matrix rows one rejection message lists before it summarizes the rest. */
export const HARD_MATRIX_ROWS_LIST_LIMIT = 12

/** Maximum excluded paths one arming record samples; the count covers the rest. */
export const HARD_EXCLUDED_SAMPLE_LIMIT = 20

/** Maximum blocking items one completion assessment lists before it summarizes the rest. */
export const HARD_BLOCKER_LIMIT = 8

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
    ctx.sessionProjections.register(hardLedgerProjectionDefinition(this.resolved))
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
    const inertModules = data.inertModules === undefined
      ? undefined
      : this.moduleSubset('inertModules', data.inertModules, modules)
    const unscreenedModules = data.unscreenedModules === undefined
      ? undefined
      : this.moduleSubset('unscreenedModules', data.unscreenedModules, modules)
    if (unscreenedModules !== undefined && unscreenedModules.some(module => inertModules?.includes(module) === true)) {
      throw new HarnessError(
        'unscreenedModules must be disjoint from inertModules: an inert module carries no code to screen',
        'HARD_LEDGER_UNSORTED_MATRIX',
      )
    }
    const exclusions = data.exclusions === undefined ? undefined : this.exclusionsRecord(data.exclusions)
    if (data.ignoredEntryCount !== undefined
      && (!Number.isSafeInteger(data.ignoredEntryCount) || data.ignoredEntryCount < 0)) {
      throw new HarnessError('ignoredEntryCount must be a non-negative safe integer', 'HARD_LEDGER_INVALID_MATRIX_COUNT')
    }
    for (const bugClass of data.bugClasses) this.assertText('bugClasses[]', bugClass)
    if (data.goalId !== undefined) this.assertText('goalId', data.goalId)
    const snapshot = data.snapshot === undefined ? undefined : this.snapshotRecord(data.snapshot)
    agent.session.append('hard/mission/armed', {
      objective: data.objective,
      targetRepo: data.targetRepo,
      commit: data.commit,
      modules,
      bugClasses: [...data.bugClasses],
      ...(inertModules === undefined ? {} : { inertModules }),
      ...(unscreenedModules === undefined ? {} : { unscreenedModules }),
      ...(exclusions === undefined ? {} : { exclusions }),
      ...(data.ignoredEntryCount === undefined ? {} : { ignoredEntryCount: data.ignoredEntryCount }),
      ...(data.goalId === undefined ? {} : { goalId: data.goalId }),
      ...(snapshot === undefined ? {} : { snapshot }),
    })
  }

  /**
   * Validate the snapshot an arming record names: an absolute git directory,
   * a known target kind, and a full origin sha when present.
   * @param snapshot - the snapshot the caller supplied.
   * @returns a detached copy of the snapshot.
   */
  private snapshotRecord(snapshot: HardTargetSnapshot): HardTargetSnapshot {
    this.assertText('snapshot.gitDir', snapshot.gitDir)
    if (!snapshot.gitDir.startsWith('/')) {
      throw new HarnessError('snapshot.gitDir must be an absolute path', 'HARD_LEDGER_INVALID_SNAPSHOT')
    }
    if (!['git', 'directory', 'file'].includes(snapshot.kind)) {
      throw new HarnessError('snapshot.kind must be git, directory, or file', 'HARD_LEDGER_INVALID_SNAPSHOT')
    }
    if (snapshot.origin !== undefined && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(snapshot.origin.commit)) {
      throw new HarnessError('snapshot.origin.commit must be a full lowercase hex sha', 'HARD_LEDGER_INVALID_SNAPSHOT')
    }
    return {
      gitDir: snapshot.gitDir,
      kind: snapshot.kind,
      ...(snapshot.origin === undefined ? {} : { origin: { commit: snapshot.origin.commit, dirty: snapshot.origin.dirty } }),
    }
  }

  /**
   * Validate one module list an arming record carries beside the matrix rows:
   * non-empty names, sorted, deduplicated, and every entry a row.
   * @param field - the record field, worded for the error message.
   * @param supplied - the list the caller supplied.
   * @param modules - the validated matrix rows.
   * @returns a detached copy of the list.
   */
  private moduleSubset(field: string, supplied: readonly string[], modules: readonly string[]): readonly string[] {
    if (supplied.some(module => typeof module !== 'string' || module.trim().length === 0)) {
      throw new HarnessError(`${field} must be an array of non-empty module names`, 'HARD_LEDGER_INVALID_TEXT')
    }
    const sorted = [...supplied].sort()
    if (sorted.some((module, index) => module !== supplied[index])
      || new Set(supplied).size !== supplied.length
      || supplied.some(module => !modules.includes(module))) {
      throw new HarnessError(`${field} must be a sorted deduplicated subset of modules`, 'HARD_LEDGER_UNSORTED_MATRIX')
    }
    return [...supplied]
  }

  /**
   * Validate the exclusion record of one arming: at least one glob, a
   * non-negative count, and a sorted sample no longer than the count or
   * `HARD_EXCLUDED_SAMPLE_LIMIT`.
   * @param exclusions - the caller's exclusion record.
   * @returns a detached copy of the record.
   */
  private exclusionsRecord(exclusions: HardMatrixExclusions): HardMatrixExclusions {
    if (exclusions.globs.length === 0) {
      throw new HarnessError('exclusions must name at least one applied glob', 'HARD_LEDGER_INVALID_EXCLUSIONS')
    }
    for (const glob of exclusions.globs) this.assertText('exclusions.globs[]', glob)
    if (!Number.isSafeInteger(exclusions.fileCount) || exclusions.fileCount < 0) {
      throw new HarnessError('exclusions.fileCount must be a non-negative safe integer', 'HARD_LEDGER_INVALID_EXCLUSIONS')
    }
    const sample = exclusions.sample
    if (sample.length > Math.min(exclusions.fileCount, HARD_EXCLUDED_SAMPLE_LIMIT)) {
      throw new HarnessError(
        `exclusions.sample must not exceed the excluded file count or ${HARD_EXCLUDED_SAMPLE_LIMIT} paths`,
        'HARD_LEDGER_INVALID_EXCLUSIONS',
      )
    }
    for (const path of sample) this.assertText('exclusions.sample[]', path)
    if ([...sample].sort().some((path, index) => path !== sample[index])) {
      throw new HarnessError('exclusions.sample must be sorted', 'HARD_LEDGER_INVALID_EXCLUSIONS')
    }
    return { globs: [...exclusions.globs], fileCount: exclusions.fileCount, sample: [...sample] }
  }

  /**
   * Append one validated finding-proposal record and return its id.
   * @param agent - the live agent whose session receives the record.
   * @param request - the validated finding fields with the exploit payload required; id assigned from the projection.
   * @returns the assigned finding id.
   */
  proposeFinding(agent: Agent, request: HardFindingRequest): HardFindingId {
    this.assertText('title', request.title)
    this.assertText('claim', request.claim)
    this.assertText('component', request.component)
    this.assertText('bugClass', request.bugClass)
    this.assertText('payload', request.payload)
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
   * @param request - status, statement (omittable for an existing id, which keeps its
   *   statement), optional existing id, conditional reason, and the chain links
   *   (omittable for an existing id, which keeps its links).
   * @returns the assigned or confirmed hypothesis id.
   */
  writeHypothesis(
    agent: Agent,
    request: { id?: string; statement?: string; status: HardHypothesisStatus; reason?: string; links?: readonly string[] },
  ): HardHypothesisId {
    if (request.links !== undefined) this.assertChainLinks(agent, request.links)
    if (request.statement !== undefined) this.assertText('statement', request.statement)
    else if (request.id === undefined) {
      throw new HarnessError('proposing a hypothesis requires its statement', 'HARD_LEDGER_STATEMENT_REQUIRED')
    }
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
    // A transition without a statement or links keeps the ones the hypothesis already carries.
    const prior = this.hypotheses(agent).findLast(hypothesis => hypothesis.id === id)
    const statement = request.statement ?? prior?.statement
    /* v8 ignore next -- defensive: a known id always has a recorded statement. */
    if (statement === undefined) throw new HarnessError(`hypothesis ${id} has no statement`, 'HARD_LEDGER_STATEMENT_REQUIRED')
    const links = request.links ?? prior?.links
    const record: HardHypothesisStateData = {
      id,
      statement,
      status: request.status,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(links === undefined ? {} : { links: [...links] }),
    }
    agent.session.append('hard/hypothesis/state', record)
    return id
  }

  /**
   * Reject chain links that do not name at least two distinct recorded
   * weaknesses or confirmed findings: a chain combines material the ledger
   * holds, never an id the model has not recorded or proven.
   * @param agent - the live agent whose ledger holds the material.
   * @param links - the `W-n` and `F-n` ids the chain names.
   * @throws `HARD_LEDGER_INVALID_CHAIN` naming the problem.
   */
  private assertChainLinks(agent: Agent, links: readonly string[]): void {
    if (new Set(links).size !== links.length || links.length < 2) {
      throw new HarnessError('a chain links at least two distinct weaknesses or findings', 'HARD_LEDGER_INVALID_CHAIN')
    }
    const state = this.state(agent.session)
    const flaws = new Set((state.flaws ?? []).map(flaw => flaw.id))
    const confirmed = new Set(state.findings
      .filter(entry => entry.verdict?.verdict === 'confirmed')
      .map(entry => entry.proposed.id))
    const unknown = links.filter(id => !flaws.has(id) && !confirmed.has(id))
    if (unknown.length > 0) {
      throw new HarnessError(
        `chain links must name recorded weaknesses (W-n) or confirmed findings (F-n); not recorded: ${unknown.join(', ')}`,
        'HARD_LEDGER_INVALID_CHAIN',
      )
    }
  }

  /**
   * Append one weakness as chaining material and return its id. The caller
   * resolves every site at the pinned commit before this append.
   * @param agent - the live agent whose session receives the record.
   * @param request - the weakness fields without the assigned id; a named finding or hypothesis id must be recorded.
   * @returns the assigned weakness id.
   */
  recordFlaw(
    agent: Agent,
    request: Omit<HardFlawData, 'id' | 'findingId' | 'hypothesisId'> & { findingId?: string; hypothesisId?: string },
  ): HardFlawId {
    this.assertText('title', request.title)
    this.assertText('component', request.component)
    this.assertText('grants', request.grants)
    this.assertText('requires', request.requires)
    if (request.sites.length === 0) {
      throw new HarnessError('a weakness cites at least one code site', 'HARD_LEDGER_SITES_REQUIRED')
    }
    for (const site of request.sites) this.assertText('sites[]', site)
    const state = this.state(agent.session)
    if (request.findingId !== undefined && !state.findings.some(entry => entry.proposed.id === request.findingId)) {
      throw new HarnessError(`unknown finding id ${request.findingId}`, 'HARD_LEDGER_UNKNOWN_FINDING')
    }
    if (request.hypothesisId !== undefined && !state.hypotheses.some(entry => entry.id === request.hypothesisId)) {
      throw new HarnessError(`unknown hypothesis id ${request.hypothesisId}`, 'HARD_LEDGER_UNKNOWN_HYPOTHESIS')
    }
    const id = brandString<HardFlawId>(`W-${(state.flaws ?? []).length + 1}`)
    agent.session.append('hard/flaw/recorded', {
      id,
      title: request.title,
      component: request.component,
      grants: request.grants,
      requires: request.requires,
      sites: [...request.sites],
      ...(request.findingId === undefined ? {} : { findingId: brandString<HardFindingId>(request.findingId) }),
      ...(request.hypothesisId === undefined ? {} : { hypothesisId: brandString<HardHypothesisId>(request.hypothesisId) }),
    })
    return id
  }

  /**
   * Recorded weaknesses in record order.
   * @param agent - the live agent whose ledger state is read.
   * @returns one record per weakness.
   */
  flaws(agent: Agent): readonly HardFlawData[] {
    return (this.state(agent.session).flaws ?? []).map(({ id, findingId, hypothesisId, ...rest }) => ({
      ...rest,
      id: brandString<HardFlawId>(id),
      ...(findingId === undefined ? {} : { findingId: brandString<HardFindingId>(findingId) }),
      ...(hypothesisId === undefined ? {} : { hypothesisId: brandString<HardHypothesisId>(hypothesisId) }),
    }))
  }

  /**
   * Record the entry points of the feature map indexed for the pinned
   * commit, unless the session already holds this derivation.
   * @param agent - the live agent whose session receives the record.
   * @param data - the commit, the import derivation, and the entry points.
   * @returns whether a record was appended.
   */
  recordFeatureMapIndexed(agent: Agent, data: HardFeatureMapIndexedData): boolean {
    if (this.state(agent.session).featureMap?.derivation === data.derivation) return false
    agent.session.append('hard/featuremap/indexed', {
      commit: data.commit,
      derivation: data.derivation,
      entryPoints: data.entryPoints.map(entry => ({ key: entry.key, handler: entry.handler })),
    })
    return true
  }

  /**
   * Append one feature the caller already checked against the feature map
   * and return its id; naming an existing id revises that feature.
   * @param agent - the live agent whose session receives the record.
   * @param request - the feature without an id, or with the existing id it revises.
   * @returns the feature id.
   * @throws `HARD_LEDGER_UNKNOWN_FEATURE` for an id never recorded, or a text error for a blank field.
   */
  recordFeature(agent: Agent, request: Omit<HardFeatureData, 'id'> & { id?: string }): HardFeatureId {
    this.assertText('name', request.name)
    this.assertText('summary', request.summary)
    const features = this.state(agent.session).features ?? []
    if (request.id !== undefined && !features.some(feature => feature.id === request.id)) {
      throw new HarnessError(`unknown feature id ${request.id}`, 'HARD_LEDGER_UNKNOWN_FEATURE')
    }
    const id = brandString<HardFeatureId>(request.id ?? `FE-${features.length + 1}`)
    agent.session.append('hard/feature/recorded', {
      id,
      name: request.name,
      summary: request.summary,
      entryPoints: [...request.entryPoints],
      symbols: request.symbols.map(entry => ({ symbol: entry.symbol, role: entry.role })),
      excluded: request.excluded.map(entry => ({
        symbol: entry.symbol,
        reason: entry.reason,
        ...entry.note === undefined ? {} : { note: entry.note },
      })),
      states: request.states.map(entry => ({ kind: entry.kind, key: entry.key, access: entry.access })),
      check: { ...request.check },
    })
    return id
  }

  /**
   * Append one relation between two recorded features.
   * @param agent - the live agent whose session receives the record.
   * @param request - the two feature ids, the relation kind, and a note.
   * @throws `HARD_LEDGER_UNKNOWN_FEATURE` for an id never recorded, `HARD_LEDGER_INVALID_FEATURE_LINK` for a self link,
   *   or a text error for a blank note.
   */
  linkFeature(agent: Agent, request: { from: string; to: string; kind: HardFeatureLinkData['kind']; note: string }): void {
    this.assertText('note', request.note)
    const known = new Set((this.state(agent.session).features ?? []).map(feature => feature.id))
    const unknown = [request.from, request.to].filter(id => !known.has(id))
    if (unknown.length > 0) throw new HarnessError(`unknown feature id ${unknown.join(', ')}`, 'HARD_LEDGER_UNKNOWN_FEATURE')
    if (request.from === request.to) throw new HarnessError('a feature cannot link to itself', 'HARD_LEDGER_INVALID_FEATURE_LINK')
    agent.session.append('hard/feature/linked', {
      from: brandString<HardFeatureId>(request.from),
      to: brandString<HardFeatureId>(request.to),
      kind: request.kind,
      note: request.note,
    })
  }

  /**
   * The latest record of every feature, in first-record order.
   * @param agent - the live agent whose ledger state is read.
   * @returns one record per feature id.
   */
  features(agent: Agent): readonly HardFeatureData[] {
    return (this.state(agent.session).features ?? []).map(({ id, excluded, ...rest }) => ({
      ...rest,
      id: brandString<HardFeatureId>(id),
      excluded: excluded.map(({ note, ...entry }) => ({ ...entry, ...note === undefined ? {} : { note } })),
    }))
  }

  /**
   * Feature relations in record order.
   * @param agent - the live agent whose ledger state is read.
   * @returns one record per relation.
   */
  featureLinks(agent: Agent): readonly HardFeatureLinkData[] {
    return (this.state(agent.session).featureLinks ?? []).map(link => ({
      ...link,
      from: brandString<HardFeatureId>(link.from),
      to: brandString<HardFeatureId>(link.to),
    }))
  }

  /**
   * The latest indexed feature map of the session.
   * @param agent - the live agent whose ledger state is read.
   * @returns the indexed entry points, or undefined before any index.
   */
  featureMap(agent: Agent): HardFeatureMapIndexedData | undefined {
    return this.state(agent.session).featureMap
  }

  /**
   * Indexed entry points no recorded feature names. The math lives in
   * `unmappedEntryPointsFromState`.
   * @param agent - the live agent whose ledger state is read.
   * @returns the unmapped `kind:key` entry points.
   */
  unmappedEntryPoints(agent: Agent): readonly string[] {
    return unmappedEntryPointsFromState(this.state(agent.session))
  }

  /**
   * The ids a chain hypothesis may link: every recorded weakness, then every
   * confirmed finding no weakness already names. The math lives in
   * `chainMaterialFromState`.
   * @param agent - the live agent whose ledger state is read.
   * @returns the `W-n` and `F-n` ids in record order.
   */
  chainMaterial(agent: Agent): readonly string[] {
    return chainMaterialFromState(this.state(agent.session))
  }

  /**
   * Chain material no hypothesis links yet; empty while fewer than two
   * weaknesses and confirmed findings exist. The math lives in
   * `unchainedMaterialFromState`.
   * @param agent - the live agent whose ledger state is read.
   * @returns the unlinked `W-n` and `F-n` ids.
   */
  unchainedMaterial(agent: Agent): readonly string[] {
    return unchainedMaterialFromState(this.state(agent.session))
  }

  /**
   * Append one coverage cell verdict, replacing any prior verdict for the cell.
   * @param agent - the live agent whose session receives the record.
   * @param request - the cell coordinates, verdict, and declared sink sites; the module must be an armed matrix row when a matrix exists.
   */
  markCoverage(agent: Agent, request: HardCoverageCellData): void {
    this.assertText('module', request.module)
    this.assertText('bugClass', request.bugClass)
    this.assertCoverageCell(agent, request)
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
   * Validate the cell one coverage verdict names. A module-scoped class takes
   * a matrix row, and a cleared verdict refuses an inert row — it duplicates
   * the screen the harness already ran, while suspicious stays accepted so a
   * real sighting surfaces. A repository-scoped class has one cell for the
   * whole repository that a verdict on any module records, so no row check
   * applies: the root module `.` the steering names may be inert, or no row
   * at all, without affecting what the class covers.
   * @param agent - the live agent whose ledger matrix anchors the check.
   * @param cell - the module, bug class, and verdict being recorded.
   * @throws `HARD_LEDGER_MODULE_NOT_IN_MATRIX` or `HARD_LEDGER_INERT_MODULE` for a module-scoped class, as the row checks do.
   */
  assertCoverageCell(agent: Agent, cell: Pick<HardCoverageCellData, 'module' | 'bugClass' | 'verdict'>): void {
    if (classScope(cell.bugClass) === 'repo') return
    this.assertModulesInMatrix(agent, [cell.module])
    if (cell.verdict === 'cleared') this.assertClearableModules(agent, [cell.module])
  }

  /**
   * Reject modules outside the armed coverage matrix, naming the valid rows
   * so the caller can correct its target list instead of guessing. A module
   * the model invented — an untracked directory such as its own `poc/`
   * scratch folder — is not a matrix row, so sweeping it is wasted steps and
   * noise in the cell list. Without an armed matrix (the mission plugin is
   * not mounted, or the log predates arming) every module passes — the
   * merge-extensible default.
   * @param agent - the live agent whose ledger matrix anchors the check.
   * @param modules - the module names to validate.
   * @throws `HARD_LEDGER_MODULE_NOT_IN_MATRIX` listing the offending modules and the bounded valid rows.
   */
  assertModulesInMatrix(agent: Agent, modules: readonly string[]): void {
    const matrix = this.coverageMatrix(agent)
    if (matrix === undefined) return
    const unknown = [...new Set(modules)].filter(module => !matrix.modules.includes(module))
    if (unknown.length === 0) return
    const subject = unknown.length === 1
      ? `module "${unknown[0]}" is`
      : `modules ${unknown.map(entry => `"${entry}"`).join(', ')} are`
    const listed = matrix.modules.length > HARD_MATRIX_ROWS_LIST_LIMIT
      ? [...matrix.modules.slice(0, HARD_MATRIX_ROWS_LIST_LIMIT), `…and ${matrix.modules.length - HARD_MATRIX_ROWS_LIST_LIMIT} more`]
      : [...matrix.modules]
    throw new HarnessError(
      `${subject} not in the armed coverage matrix; the matrix rows at commit ${matrix.commit} are: ${listed.join(', ')}`,
      'HARD_LEDGER_MODULE_NOT_IN_MATRIX',
    )
  }

  /**
   * Reject `cleared` verdicts on inert modules. The harness already screened
   * an inert module as carrying no code, so its cells stand as harness
   * verdicts — a model `cleared` there is redundant work, not diligence.
   * A `suspicious` verdict still passes: if the model really saw something
   * in a module this size, that signal must not be blocked.
   * @param agent - the live agent whose ledger matrix carries the inert screen.
   * @param modules - the module names a `cleared` verdict is about to record.
   * @throws `HARD_LEDGER_INERT_MODULE` naming the inert modules in the list.
   */
  assertClearableModules(agent: Agent, modules: readonly string[]): void {
    const matrix = this.coverageMatrix(agent)
    const inert = matrix?.inertModules
    if (inert === undefined || inert.length === 0) return
    const blocked = [...new Set(modules)].filter(module => inert.includes(module))
    if (blocked.length === 0) return
    const subject = blocked.length === 1
      ? `module "${blocked[0]}" is`
      : `modules ${blocked.map(entry => `"${entry}"`).join(', ')} are`
    const pronoun = blocked.length === 1 ? 'it' : 'them'
    throw new HarnessError(
      `${subject} inert — the harness already screened ${pronoun} as containing no code, so a cleared verdict `
      + 'is redundant work; record suspicious instead if you actually found something there',
      'HARD_LEDGER_INERT_MODULE',
    )
  }

  /**
   * Reject a batch screen over modules the coverage cross-check cannot screen.
   * A batch clear rests only on a grep over the modules, and the grep is
   * silent on a module holding a binary or a language the fixed pattern
   * tables were not written for — so the shortcut is closed there and every
   * cell needs an individual model read. Per-cell verdicts stay open on such
   * modules; they surface as blind clears. Without an armed matrix, or on an
   * arming record that predates the screenability field, every module passes.
   * @param agent - the live agent whose ledger matrix carries the screenability record.
   * @param modules - the module names a batch screen is about to clear.
   * @throws `HARD_LEDGER_UNSCREENED_MODULE` naming the unscreened modules in the list.
   */
  assertScreenableModules(agent: Agent, modules: readonly string[]): void {
    const unscreened = this.coverageMatrix(agent)?.unscreenedModules
    if (unscreened === undefined || unscreened.length === 0) return
    const blocked = [...new Set(modules)].filter(module => unscreened.includes(module))
    if (blocked.length === 0) return
    const subject = blocked.length === 1
      ? `module "${blocked[0]}" holds`
      : `modules ${blocked.map(entry => `"${entry}"`).join(', ')} hold`
    throw new HarnessError(
      `${subject} a binary file or a language the harness cannot screen, so its grep proves nothing; `
      + 'read each cell yourself and record it with hard_mark_coverage',
      'HARD_LEDGER_UNSCREENED_MODULE',
    )
  }

  /**
   * Append one completed sweep summary. An empty sweep must cite verifiable
   * evidence the ledger can check — a refuted hypothesis, a model-cleared
   * cell with declared sinks, or a recorded flow document with resolvable
   * citations; a harness-screened cell cannot prove a sweep did work. A sweep
   * with findings carries no proof. The legacy free-text `emptyProof` is only
   * read from older logs; new records carry `emptyProofRef` or
   * `emptyProofFlowDoc`.
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
    if (request.newFindings === 0) {
      const proofs = [request.emptyProofRef, request.emptyProofFlowDoc].filter(proof => proof !== undefined)
      if (proofs.length === 0) {
        throw new HarnessError(
          'an empty sweep requires emptyProofRef or emptyProofFlowDoc evidence', 'HARD_LEDGER_EMPTY_PROOF_REQUIRED',
        )
      }
      if (proofs.length > 1) {
        throw new HarnessError(
          'emptyProofRef and emptyProofFlowDoc are mutually exclusive', 'HARD_LEDGER_EMPTY_PROOF_INVALID',
        )
      }
      if (request.emptyProof !== undefined) {
        throw new HarnessError(
          'the legacy emptyProof text is no longer accepted; cite emptyProofRef or emptyProofFlowDoc',
          'HARD_LEDGER_EMPTY_PROOF_INVALID',
        )
      }
      if (request.emptyProofRef !== undefined) this.assertEmptySweepProof(agent, request.emptyProofRef)
      else this.assertFlowDocProof(agent, request.emptyProofFlowDoc as string)
    } else {
      if (request.emptyProofRef !== undefined || request.emptyProofFlowDoc !== undefined) {
        throw new HarnessError(
          'a sweep with findings carries no empty proof', 'HARD_LEDGER_EMPTY_PROOF_INVALID',
        )
      }
    }
    agent.session.append('hard/sweep/summary', request)
  }

  /** The recorded-document check behind one empty sweep's flow proof. */
  private assertFlowDocProof(agent: Agent, module: string): void {
    this.assertText('emptyProofFlowDoc', module)
    const doc = (this.state(agent.session).flowDocs ?? []).find(entry => entry.module === module)
    if (doc === undefined) {
      throw new HarnessError(
        `empty sweep proof must cite a recorded flow document; none exists for ${module}`,
        'HARD_LEDGER_UNKNOWN_FLOW_DOC',
      )
    }
    if (doc.citations === 0) {
      throw new HarnessError(
        `empty sweep proof must cite a flow document with resolvable citations; ${module} recorded none`,
        'HARD_LEDGER_EMPTY_PROOF_INVALID',
      )
    }
  }

  /** The verified-referent check behind one empty sweep's proof. */
  private assertEmptySweepProof(agent: Agent, proof: HardEmptySweepProof): void {
    if (proof.kind === 'hypothesis') {
      this.assertText('emptyProofRef.hypothesisId', proof.hypothesisId)
      const record = this.state(agent.session).hypotheses.find(entry => entry.id === proof.hypothesisId)
      if (record === undefined) {
        throw new HarnessError(`unknown hypothesis id ${proof.hypothesisId}`, 'HARD_LEDGER_UNKNOWN_HYPOTHESIS')
      }
      if (record.status !== 'refuted') {
        throw new HarnessError(
          `empty sweep proof must cite a refuted hypothesis; ${proof.hypothesisId} is ${record.status}`,
          'HARD_LEDGER_EMPTY_PROOF_INVALID',
        )
      }
      return
    }
    this.assertText('emptyProofRef.module', proof.module)
    this.assertText('emptyProofRef.bugClass', proof.bugClass)
    const cell = this.coverage(agent).find(entry => entry.module === proof.module && entry.bugClass === proof.bugClass)
    if (cell === undefined) {
      throw new HarnessError(
        `unknown coverage cell ${proof.module} × ${proof.bugClass}`, 'HARD_LEDGER_UNKNOWN_CELL',
      )
    }
    if (cell.verdict !== 'cleared' || cell.declaredSinks.length === 0) {
      throw new HarnessError(
        `empty sweep proof must cite a cleared cell with declared sinks; ${proof.module} × ${proof.bugClass} is ${cell.verdict}`,
        'HARD_LEDGER_EMPTY_PROOF_INVALID',
      )
    }
    if (cell.source === 'harness') {
      throw new HarnessError(
        `empty sweep proof cannot cite a harness-screened cell; ${proof.module} × ${proof.bugClass} was cleared mechanically`,
        'HARD_LEDGER_EMPTY_PROOF_INVALID',
      )
    }
  }

  /**
   * Append one recorded flow document for a module. The verifier must have
   * resolved every citation against the pinned commit before this append —
   * the tool rejects the whole record when any cite fails, so a recorded
   * document certifies reads, not promises.
   * @param agent - the live agent whose session receives the record.
   * @param data - the summary to persist: section counts, resolved citation count, and the quirks' hypothesis ids.
   */
  recordFlowDoc(agent: Agent, data: HardFlowDocData): void {
    this.assertText('module', data.module)
    const sections = data.sections
    for (const [section, count] of Object.entries(sections)) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new HarnessError(
          `sections.${section} must be a non-negative safe integer`, 'HARD_LEDGER_INVALID_FLOW_DOC',
        )
      }
    }
    const sectionTotal = sections.entryPoints + sections.dataflows + sections.trustBoundaries
      + sections.stateMachines + sections.assumptions + sections.quirks
    if (!Number.isSafeInteger(data.citations) || data.citations !== sectionTotal) {
      throw new HarnessError(
        'citations must equal the sum of the section counts (every entry carries one citation)',
        'HARD_LEDGER_INVALID_FLOW_DOC',
      )
    }
    if (data.quirkIds !== undefined) {
      if (data.quirkIds.length !== sections.quirks) {
        throw new HarnessError(
          'quirkIds must name every recorded quirk', 'HARD_LEDGER_INVALID_FLOW_DOC',
        )
      }
      for (const id of data.quirkIds) this.assertText('quirkIds[]', id)
    }
    agent.session.append('hard/flow/doc', {
      module: data.module,
      sections: { ...data.sections },
      citations: data.citations,
      ...(data.quirkIds === undefined ? {} : { quirkIds: [...data.quirkIds] }),
    })
  }

  /**
   * Flow documents folded to their latest record per module.
   * @param agent - the live agent whose ledger state is read.
   * @returns one record per module, in first-recorded order.
   */
  flowDocs(agent: Agent): readonly HardFlowDocData[] {
    return (this.state(agent.session).flowDocs ?? []).map(({ quirkIds, ...doc }) => ({
      ...doc,
      ...(quirkIds === undefined ? {} : { quirkIds }),
    }))
  }

  /**
   * Findings folded from the projection, proposal plus latest verdict when present.
   * @param agent - the live agent whose ledger state is read.
   * @returns one record per proposal in id order.
   */
  findings(agent: Agent): readonly HardLedgerFindingEntry[] {
    return this.state(agent.session).findings.map((entry) => {
      const { proposed, verdict } = entry
      if (verdict === undefined) return { proposed: this.brandedProposal(proposed) }
      const { id, benignArm, cause, evidence, ...rest } = verdict
      return {
        proposed: this.brandedProposal(proposed),
        verdict: {
          ...rest,
          id: brandString<HardFindingId>(id),
          ...benignArm === undefined ? {} : { benignArm },
          ...cause === undefined ? {} : { cause },
          ...evidence === undefined ? {} : { evidence },
        },
      }
    })
  }

  /**
   * Decompose the refuted verdicts by cause code, so one run can say whether
   * it failed at the protocol layer or the target layer. The math lives in
   * `refutationBreakdownFromState` — the same function the pilot report
   * reads after folding the log.
   * @param agent - the live agent whose ledger holds the findings.
   * @returns refuted-verdict counts per cause plus the reading groups; a
   *   refuted verdict predating the cause codes counts under `unattributed`
   *   in `byCause` and in no group.
   */
  refutationBreakdown(agent: Agent): RefutationBreakdown {
    return refutationBreakdownFromState(this.state(agent.session))
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
      ...rest.links === undefined ? {} : { links: rest.links },
    }))
  }

  /** Restore the branded id view over one persisted proposal record. */
  private brandedProposal(
    proposed: Omit<HardFindingProposedData, 'id' | 'hypothesisId' | 'payload'> & {
      id: string
      payload?: string | undefined
      hypothesisId?: string | undefined
    },
  ): HardFindingProposedData {
    const { id, payload, hypothesisId, ...rest } = proposed
    return {
      ...rest,
      id: brandString<HardFindingId>(id),
      ...payload === undefined ? {} : { payload },
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
   * Consecutive empty-verified sweep summaries ending at the latest one.
   * Proof validity is a record-time invariant, so `newFindings === 0` is the
   * whole predicate here. The math lives in `emptySweepRunFromState`.
   * @param agent - the live agent whose ledger state is read.
   * @returns the trailing run length, bounded by the projection's sweep window.
   */
  emptySweepRun(agent: Agent): number {
    return emptySweepRunFromState(this.state(agent.session))
  }

  /**
   * The goal id the mission armed, when the arming record carries it. The
   * completion gate only fires for this goal; records without the id predate
   * goal attribution and never gate.
   * @param agent - the live agent whose ledger state is read.
   * @returns the armed goal id, or `undefined` without an attributed arming record.
   */
  armedGoalId(agent: Agent): string | undefined {
    return this.state(agent.session).goalId
  }

  /**
   * Whether the harness certifies the mission complete. Every condition reads
   * ledger state; none counts findings (a finding quota would pressure
   * fabrication — a clean repository must complete). The conditions: no open
   * work, the trailing sweep window all empty-verified (the threshold is this
   * service's `emptySweepsToFinish` config, so every consumer reads one
   * answer), and at least one model-audited coverage cell or resolved
   * hypothesis so a fully harness-screened repository reads as "nothing
   * audited yet", not "done". The math lives in
   * `completionAssessmentFromState`, shared with the projection's wire view.
   * @param agent - the live agent whose ledger state is read.
   * @returns the verdict plus the bounded blockers, phrased to serve directly as the denial reason.
   */
  completionAssessment(agent: Agent): CompletionAssessment {
    return completionAssessmentFromState(this.state(agent.session), this.resolved)
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
   * its verdict lookup deliberately ignores the recorded cell's module. The
   * math lives in `coverageProgressFromState` — the same function the pilot
   * report reads after folding the log.
   * @param agent - the live agent whose ledger state is read.
   * @returns the verdicted count and the matrix cell total, `0/0` without a matrix.
   */
  coverageProgress(agent: Agent): CoverageProgress {
    return coverageProgressFromState(this.state(agent.session))
  }

  /**
   * Matrix cells that still need the model, in matrix order: sorted modules
   * outer, the configured class order inner, then repository-scoped cells
   * under the `.` module. Inert modules carry no module-class surface and are
   * never listed; a repository-scoped class is listed once, not per module.
   * The math lives in `uncoveredCellsFromState`.
   * @param agent - the live agent whose ledger state is read.
   * @returns one entry per uncovered matrix cell, empty without a matrix.
   */
  uncoveredCells(agent: Agent): readonly { module: string; bugClass: string }[] {
    return uncoveredCellsFromState(this.state(agent.session))
  }

  /**
   * Verdicted matrix cells partitioned by who decided them: the model's own
   * reads, batch screens the model cleared without reading, and every harness
   * decision. A cell carrying no source reads as `model`, so older
   * logs partition unchanged. The math lives in `coverageBySourceFromState` —
   * the same function the pilot report reads after folding the log.
   * @param agent - the live agent whose ledger state is read.
   * @returns the three counts; all zero without a matrix.
   */
  coverageBySource(agent: Agent): CoverageBySource {
    return coverageBySourceFromState(this.state(agent.session))
  }

  /**
   * Model-cleared module-scoped matrix cells in modules the coverage
   * cross-check cannot screen, where nothing but the model's own read stands
   * behind the verdict. The math lives in `blindClearsFromState`.
   * @param agent - the live agent whose ledger state is read.
   * @returns the blind-clear count; zero without a screenability record.
   */
  blindClears(agent: Agent): number {
    return blindClearsFromState(this.state(agent.session))
  }

  /**
   * Model-facing open work summary: pending verifications, unresolved
   * states, coverage cells that still owe work, and batch-cleared cells the
   * deterministic screen spot-check sends back for a manual re-read. The
   * math lives in `openWorkFromState`.
   * @param agent - the live agent whose ledger state is read.
   * @returns bounded human-readable work items, empty when nothing is open.
   */
  openWork(agent: Agent): string[] {
    return openWorkFromState(this.state(agent.session), this.resolved)
  }

  /**
   * Open work counted by kind with the same predicates `openWork` lists by.
   * The math lives in `openWorkCountsFromState`.
   * @param agent - the live agent whose ledger state is read.
   * @returns the per-kind counts.
   */
  openWorkCounts(agent: Agent): OpenWorkCounts {
    return openWorkCountsFromState(this.state(agent.session), this.resolved)
  }

  /**
   * Every matrix cell with its current state, in matrix order — the board the
   * model reads to see what remains. The math lives in `matrixBoardFromState`.
   * @param agent - the live agent whose ledger state is read.
   * @returns one entry per matrix cell; empty without a matrix.
   */
  matrixBoard(agent: Agent): readonly HardMatrixBoardCell[] {
    return matrixBoardFromState(this.state(agent.session))
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
