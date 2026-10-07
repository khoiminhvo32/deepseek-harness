/**
 * Session-projection unit for the hard ledger: a pure fold over the `hard/*`
 * event types maintaining findings, hypotheses, coverage cells, sweep
 * counters, and the armed coverage matrix, so resumed sessions restore
 * ledger state without scanning the log (per the synchronous-read
 * deprecation decision).
 * @module
 */

import { z as zod } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  blindClearsFromState,
  completionAssessmentFromState,
  coverageBySourceFromState,
  coverageProgressFromState,
  matrixCellsFromState,
  DEFAULT_EMPTY_SWEEPS_TO_FINISH,
  DEFAULT_SCREEN_SPOT_CHECK_PERCENT,
} from './aggregate.ts'
import type { LedgerThresholds } from './aggregate.ts'
import { classScope } from './scope.ts'
import type {
  HardEmptySweepProof,
  HardFindingProposedData,
  HardFindingVerdictData,
  HardLedgerClientView,
} from './types.ts'

/** Sweep summaries the trailing-empty-sweep condition looks back over. */
export const HARD_SWEEP_WINDOW = 16

const emptyProofSchema: zod.ZodType<HardEmptySweepProof> = zod.discriminatedUnion('kind', [
  zod.object({ kind: zod.literal('hypothesis'), hypothesisId: zod.string().min(1) }),
  zod.object({ kind: zod.literal('cell'), module: zod.string().min(1), bugClass: zod.string().min(1) }),
])

const sweepSummarySchema = zod.object({
  phase: zod.union([zod.literal('A'), zod.literal('B')]),
  cellsTouched: zod.number().int().min(0),
  newFindings: zod.number().int().min(0),
  // Legacy free-text proof; only older logs carry it.
  emptyProof: zod.string().optional(),
  emptyProofRef: emptyProofSchema.optional(),
  // The flow-document proof rides beside the reference union: opening the
  // union itself would change the payload contract and force a Session-format
  // bump, while the recorded documents keep growing.
  emptyProofFlowDoc: zod.string().min(1).optional(),
})

/** One proposed finding with its verifier verdict once recorded. */
export interface HardLedgerFindingEntry {
  readonly proposed: HardFindingProposedData
  readonly verdict?: HardFindingVerdictData
}

const proposedSchema = zod.object({
  id: zod.string().min(1),
  title: zod.string().min(1),
  bugClass: zod.string().min(1),
  component: zod.string().min(1),
  claim: zod.string().min(1),
  payload: zod.string().min(1).optional(),
  cvssVector: zod.string().min(1),
  cvssClaimed: zod.number(),
  pocPath: zod.string().min(1),
  claimHash: zod.string().regex(/^[0-9a-f]{64}$/u),
  fingerprint: zod.string().regex(/^[0-9a-f]{64}$/u),
  hypothesisId: zod.string().min(1).optional(),
})

const verdictSchema = zod.object({
  id: zod.string().min(1),
  verdict: zod.enum(['confirmed', 'refuted', 'flaky']),
  // 0 is a legal run count: a benign-arm refutation rests on no exploit run.
  runs: zod.number().int().min(0),
  cvssComputed: zod.number().min(0).max(10),
  cvssMatch: zod.boolean(),
  reason: zod.string().min(1),
  fingerprint: zod.string().regex(/^[0-9a-f]{64}$/u),
  benignArm: zod.enum(['passed', 'failed']).optional(),
  cause: zod.enum(['benign-arm-passed', 'no-marker', 'nonzero-exit', 'timeout', 'aborted', 'no-runs']).optional(),
  evidence: zod.enum(['demonstrated', 'proven']).optional(),
})

const hypothesisSchema = zod.object({
  id: zod.string().min(1),
  statement: zod.string().min(1),
  status: zod.enum(['proposed', 'testing', 'confirmed', 'refuted', 'deferred']),
  reason: zod.string().min(1).optional(),
})

const coverageSchema = zod.object({
  module: zod.string().min(1),
  bugClass: zod.string().min(1),
  verdict: zod.enum(['cleared', 'suspicious', 'uncovered']),
  declaredSinks: zod.array(zod.string().min(1)).readonly(),
  source: zod.enum(['model', 'model-verified', 'harness']).optional(),
})

/** Validates one folded flow-document record: section and citation counts per module. */
const flowDocSchema = zod.object({
  module: zod.string().min(1),
  sections: zod.object({
    entryPoints: zod.number().int().min(0),
    dataflows: zod.number().int().min(0),
    trustBoundaries: zod.number().int().min(0),
    stateMachines: zod.number().int().min(0),
    assumptions: zod.number().int().min(0),
    quirks: zod.number().int().min(0),
  }),
  citations: zod.number().int().min(0),
  quirkIds: zod.array(zod.string().min(1)).readonly().optional(),
})

/** Validates one folded mission arming record: the pinned target and the matrix axes. */
const matrixSchema = zod.object({
  modules: zod.array(zod.string().min(1)).readonly(),
  bugClasses: zod.array(zod.string()).readonly(),
  targetRepo: zod.string().min(1),
  commit: zod.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u),
  inertModules: zod.array(zod.string().min(1)).optional(),
  unscreenedModules: zod.array(zod.string().min(1)).optional(),
  exclusions: zod.object({
    globs: zod.array(zod.string().min(1)),
    fileCount: zod.number().int().min(0),
    sample: zod.array(zod.string().min(1)),
  }).optional(),
  ignoredEntryCount: zod.number().int().min(0).optional(),
  snapshot: zod.object({
    gitDir: zod.string().min(1),
    kind: zod.enum(['git', 'directory', 'file']),
    origin: zod.object({
      commit: zod.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u),
      dirty: zod.boolean(),
    }).optional(),
  }).optional(),
})

/** Validates persisted projection state before it seeds a fold. */
export const hardLedgerStateSchema = zod.object({
  findings: zod.array(zod.object({ proposed: proposedSchema, verdict: verdictSchema.optional() })),
  hypotheses: zod.array(hypothesisSchema),
  coverage: zod.array(coverageSchema),
  // Optional: cached states from before the flow-document event fold without one.
  flowDocs: zod.array(flowDocSchema).optional(),
  sweeps: zod.object({ A: zod.number().int().min(0), B: zod.number().int().min(0) }),
  recentSweeps: zod.array(sweepSummarySchema).max(HARD_SWEEP_WINDOW).readonly(),
  goalId: zod.string().min(1).optional(),
  matrix: matrixSchema.optional(),
  failure: zod.string().min(1).nullable(),
})

/**
 * Pure projection transition over one committed session event.
 * @param state - the projection covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state (same reference when the event is unrelated).
 */
export function applyHardLedgerProjection(state: HardLedgerProjectionState, event: Parameters<ProjectionDefinition<'hardLedger', HardLedgerProjectionState>['apply']>[1]): HardLedgerProjectionState {
  /* v8 ignore next -- defensive: a failed fold stops advancing until the state is repaired. */
  if (state.failure !== null) return state
  switch (event.type) {
    case 'hard/finding/proposed':
      return { ...state, findings: [...state.findings, { proposed: event.data }] }
    case 'hard/finding/verdict': {
      const findings = state.findings.map(entry => entry.proposed.id === event.data.id
        ? { proposed: entry.proposed, verdict: event.data }
        : entry)
      const changed = findings.some((entry, index) => entry !== state.findings[index])
      return changed ? { ...state, findings } : state
    }
    case 'hard/hypothesis/state': {
      const index = state.hypotheses.findIndex(record => record.id === event.data.id)
      const hypotheses = index === -1
        ? [...state.hypotheses, event.data]
        : state.hypotheses.map((record, position) => position === index ? event.data : record)
      return { ...state, hypotheses }
    }
    case 'hard/coverage/cell': {
      const key = (record: { module: string; bugClass: string }): string => `${record.module}\u0000${record.bugClass}`
      const index = state.coverage.findIndex(record => key(record) === key(event.data))
      const coverage = index === -1
        ? [...state.coverage, event.data]
        : state.coverage.map((record, position) => position === index ? event.data : record)
      return { ...state, coverage }
    }
    case 'hard/flow/doc': {
      const index = state.flowDocs?.findIndex(record => record.module === event.data.module) ?? -1
      const flowDocs = index === -1
        ? [...state.flowDocs ?? [], event.data]
        : (state.flowDocs ?? []).map((record, position) => position === index ? event.data : record)
      return { ...state, flowDocs }
    }
    case 'hard/sweep/summary':
      return {
        ...state,
        sweeps: { ...state.sweeps, [event.data.phase]: state.sweeps[event.data.phase] + 1 },
        recentSweeps: [...state.recentSweeps, event.data].slice(-HARD_SWEEP_WINDOW),
      }
    case 'hard/mission/armed':
      return {
        ...state,
        goalId: event.data.goalId,
        matrix: {
          modules: [...event.data.modules],
          bugClasses: [...event.data.bugClasses],
          targetRepo: event.data.targetRepo,
          commit: event.data.commit,
          ...(event.data.inertModules === undefined ? {} : { inertModules: [...event.data.inertModules] }),
          ...(event.data.unscreenedModules === undefined ? {} : { unscreenedModules: [...event.data.unscreenedModules] }),
          ...(event.data.exclusions === undefined ? {} : {
            exclusions: {
              globs: [...event.data.exclusions.globs],
              fileCount: event.data.exclusions.fileCount,
              sample: [...event.data.exclusions.sample],
            },
          }),
          ...(event.data.ignoredEntryCount === undefined ? {} : { ignoredEntryCount: event.data.ignoredEntryCount }),
          ...(event.data.snapshot === undefined ? {} : {
            snapshot: {
              gitDir: event.data.snapshot.gitDir,
              kind: event.data.snapshot.kind,
              ...(event.data.snapshot.origin === undefined ? {} : { origin: { ...event.data.snapshot.origin } }),
            },
          }),
        },
      }
    default:
      return state
  }
}

/** Host-side ledger state restored at resume and maintained incrementally. */
export type HardLedgerProjectionState = zod.infer<typeof hardLedgerStateSchema>

/** Build the empty projection state (also used by direct unit tests).
 * @returns the initial zeroed ledger projection state.
 */
export function emptyHardLedgerState(): HardLedgerProjectionState {
  return hardLedgerStateSchema.parse({
    findings: [],
    hypotheses: [],
    coverage: [],
    sweeps: { A: 0, B: 0 },
    recentSweeps: [],
    failure: null,
  })
}

/** The coverage matrix folded from the mission arming record, when one exists. */
export type HardCoverageMatrix = NonNullable<HardLedgerProjectionState['matrix']>

/** The wire schema of the client view; strict so a drifted summary fails loud. */
const clientViewSchema = zod.object({
  matrix: zod.object({
    modules: zod.array(zod.string()),
    bugClasses: zod.array(zod.string()),
    classScopes: zod.record(zod.string(), zod.enum(['module', 'repo'])),
    inertModules: zod.array(zod.string()).optional(),
    unscreenedModules: zod.array(zod.string()).optional(),
    exclusions: zod.object({
      globs: zod.array(zod.string()),
      fileCount: zod.number().int().min(0),
    }).optional(),
    targetRepo: zod.string(),
    commit: zod.string(),
  }).optional(),
  cells: zod.array(zod.object({
    module: zod.string(),
    bugClass: zod.string(),
    verdict: zod.enum(['cleared', 'suspicious', 'uncovered']),
    source: zod.enum(['model', 'model-verified', 'harness']).optional(),
  })),
  progress: zod.object({
    verdicted: zod.number().int().min(0),
    total: zod.number().int().min(0),
  }),
  bySource: zod.object({
    model: zod.number().int().min(0),
    modelVerified: zod.number().int().min(0),
    harness: zod.number().int().min(0),
  }),
  blindClears: zod.number().int().min(0),
  gate: zod.object({
    complete: zod.boolean(),
    blockers: zod.array(zod.string()),
  }),
}).strict() as zod.ZodType<HardLedgerClientView>

/**
 * Build the client view of one folded state. Deliberately unmemoized: every
 * `hard/*` event changes some field the view carries, so a reused-reference
 * optimization would only save a 32-cell object per event.
 * @param state - the folded ledger projection state.
 * @param thresholds - the ledger's spot-check percent and trailing-sweep requirement, shared with the service.
 * @returns the summary the client store publishes under `hardLedger`.
 */
function buildHardLedgerView(state: HardLedgerProjectionState, thresholds: LedgerThresholds): HardLedgerClientView {
  const matrix = state.matrix
  return {
    ...(matrix === undefined ? {} : {
      matrix: {
        modules: [...matrix.modules],
        bugClasses: [...matrix.bugClasses],
        classScopes: Object.fromEntries(matrix.bugClasses.map(bugClass => [bugClass, classScope(bugClass)])),
        ...(matrix.inertModules === undefined ? {} : { inertModules: [...matrix.inertModules] }),
        ...(matrix.unscreenedModules === undefined ? {} : { unscreenedModules: [...matrix.unscreenedModules] }),
        ...(matrix.exclusions === undefined ? {} : {
          exclusions: { globs: [...matrix.exclusions.globs], fileCount: matrix.exclusions.fileCount },
        }),
        targetRepo: matrix.targetRepo,
        commit: matrix.commit,
      },
    }),
    cells: matrixCellsFromState(state).map(cell => ({
      module: cell.module,
      bugClass: cell.bugClass,
      verdict: cell.verdict,
      ...(cell.source === undefined ? {} : { source: cell.source }),
    })),
    progress: coverageProgressFromState(state),
    bySource: coverageBySourceFromState(state),
    blindClears: blindClearsFromState(state),
    gate: completionAssessmentFromState(state, thresholds),
  }
}

/** The registered hard-ledger projection: the fold plus its required client wire view. */
export type HardLedgerProjectionDefinition = Omit<
  ProjectionDefinition<'hardLedger', HardLedgerProjectionState>,
  'wire'
> & {
  wire: {
    viewSchema: zod.ZodType<HardLedgerClientView>
    view: (state: HardLedgerProjectionState) => HardLedgerClientView
  }
}

/**
 * The hard-ledger projection unit registered by the hard-ledger service.
 * The thresholds parameterize the gate blockers the wire view carries, and
 * the service passes its resolved config so the panel reads one answer; the
 * defaults exist so direct unit tests fold without constructing a service.
 * @param thresholds - the ledger's screen spot-check percent and trailing-sweep requirement.
 * @returns the projection definition with its client wire view.
 */
export function hardLedgerProjectionDefinition(thresholds: LedgerThresholds = {
  screenSpotCheckPercent: DEFAULT_SCREEN_SPOT_CHECK_PERCENT,
  emptySweepsToFinish: DEFAULT_EMPTY_SWEEPS_TO_FINISH,
}): HardLedgerProjectionDefinition {
  return {
    key: 'hardLedger',
    stateSchema: hardLedgerStateSchema,
    init: (): HardLedgerProjectionState => ({
      findings: [],
      hypotheses: [],
      coverage: [],
      sweeps: { A: 0, B: 0 },
      recentSweeps: [],
      failure: null,
    }),
    apply: applyHardLedgerProjection,
    wire: { viewSchema: clientViewSchema, view: state => buildHardLedgerView(state, thresholds) },
    // Version 4 changes the empty-sweep proof from free text to a verifiable
    // reference and adds the bounded sweep window plus the armed goal id; the
    // bump forces a full log rebuild so both recover on resume. The flow
    // documents added after it fold into an optional state field, so no
    // rebuild is required.
    stateVersion: 4,
  } satisfies HardLedgerProjectionDefinition
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    hardLedger: HardLedgerProjectionState
  }
}
