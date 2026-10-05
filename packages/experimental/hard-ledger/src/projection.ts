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
import type {
  HardFindingProposedData,
  HardFindingVerdictData,
} from './types.ts'

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
  runs: zod.number().int().min(1),
  cvssComputed: zod.number().min(0).max(10),
  cvssMatch: zod.boolean(),
  reason: zod.string().min(1),
  fingerprint: zod.string().regex(/^[0-9a-f]{64}$/u),
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
})

/** Validates one folded mission arming record: the pinned target and the matrix axes. */
const matrixSchema = zod.object({
  modules: zod.array(zod.string().min(1)).readonly(),
  bugClasses: zod.array(zod.string()).readonly(),
  targetRepo: zod.string().min(1),
  commit: zod.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u),
})

/** Validates persisted projection state before it seeds a fold. */
export const hardLedgerStateSchema = zod.object({
  findings: zod.array(zod.object({ proposed: proposedSchema, verdict: verdictSchema.optional() })),
  hypotheses: zod.array(hypothesisSchema),
  coverage: zod.array(coverageSchema),
  sweeps: zod.object({ A: zod.number().int().min(0), B: zod.number().int().min(0) }),
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
    case 'hard/sweep/summary':
      return { ...state, sweeps: { ...state.sweeps, [event.data.phase]: state.sweeps[event.data.phase] + 1 } }
    case 'hard/mission/armed':
      return {
        ...state,
        matrix: {
          modules: [...event.data.modules],
          bugClasses: [...event.data.bugClasses],
          targetRepo: event.data.targetRepo,
          commit: event.data.commit,
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
    failure: null,
  })
}

/** The coverage matrix folded from the mission arming record, when one exists. */
export type HardCoverageMatrix = NonNullable<HardLedgerProjectionState['matrix']>

/** The host-only projection unit registered by the hard-ledger service. */
export const hardLedgerProjectionDefinition = {
  key: 'hardLedger',
  stateSchema: hardLedgerStateSchema,
  init: (): HardLedgerProjectionState => ({
    findings: [],
    hypotheses: [],
    coverage: [],
    sweeps: { A: 0, B: 0 },
    failure: null,
  }),
  apply: applyHardLedgerProjection,
  // Version 2 adds the optional coverage matrix; the bump forces a full log
  // rebuild so matrices recorded before the upgrade are recovered on resume.
  stateVersion: 2,
} satisfies ProjectionDefinition<'hardLedger', HardLedgerProjectionState>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    hardLedger: HardLedgerProjectionState
  }
}
