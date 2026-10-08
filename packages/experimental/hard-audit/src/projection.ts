/**
 * Session-projection unit for the independent audit: a pure fold over
 * coverage verdicts and the two `hard/audit/*` event types maintaining the
 * current verdict seq of every cell, the requests still awaiting a result,
 * and the budget already charged, so a resumed session restarts its pending
 * audits without scanning the log.
 * @module
 */

import { z as zod } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const requestSchema = zod.object({
  module: zod.string().min(1),
  bugClass: zod.string().min(1),
  auditedSeq: zod.number().int().min(0),
  tier: zod.enum(['unscreened', 'batch', 'per-cell']),
})

/** Validates persisted projection state before it seeds a fold. */
export const hardAuditStateSchema = zod.object({
  /** Seq of the latest coverage verdict per cell, keyed by {@link auditCellKey}. */
  cells: zod.record(zod.string(), zod.number().int().min(0)),
  /** Requests without a result, in request order. */
  pending: zod.array(requestSchema),
  /** Requests ever appended. */
  requested: zod.number().int().min(0),
  /**
   * Results that measured nothing and charge nothing: refused for budget, or
   * superseded because the cell was marked again before its reader started.
   */
  uncharged: zod.number().int().min(0),
})

/** Host-side audit state restored at resume and maintained incrementally. */
export type HardAuditProjectionState = zod.infer<typeof hardAuditStateSchema>

/**
 * The projection key of one coverage cell.
 * @param cell - the cell coordinates.
 * @returns a key no two distinct cells share.
 */
export function auditCellKey(cell: { readonly module: string; readonly bugClass: string }): string {
  return `${cell.module}\u0000${cell.bugClass}`
}

/**
 * The audit budget one mission has charged: every request except those whose
 * result refused it for budget or found it superseded, so a model that marks
 * the same cell again spends one audit, not one per mark.
 * @param state - the folded audit state.
 * @returns the number of charged requests.
 */
export function chargedAudits(state: HardAuditProjectionState): number {
  return state.requested - state.uncharged
}

/**
 * Pure projection transition over one committed session event.
 * @param state - the projection covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state (same reference when the event is unrelated).
 */
export function applyHardAuditProjection(
  state: HardAuditProjectionState,
  event: Parameters<ProjectionDefinition<'hardAudit', HardAuditProjectionState>['apply']>[1],
): HardAuditProjectionState {
  switch (event.type) {
    case 'hard/coverage/cell':
      return { ...state, cells: { ...state.cells, [auditCellKey(event.data)]: event.seq } }
    case 'hard/audit/requested':
      return { ...state, pending: [...state.pending, event.data], requested: state.requested + 1 }
    case 'hard/audit/result': {
      const { data } = event
      const pending = state.pending.filter(request =>
        request.auditedSeq !== data.auditedSeq || auditCellKey(request) !== auditCellKey(data))
      const uncharged = state.uncharged + (data.cause === 'budget' || data.cause === 'superseded' ? 1 : 0)
      return { ...state, pending, uncharged }
    }
    default:
      return state
  }
}

/** The host-only projection unit registered by the hard-audit plugin. */
export const hardAuditProjectionDefinition = {
  key: 'hardAudit',
  stateSchema: hardAuditStateSchema,
  init: (): HardAuditProjectionState => ({ cells: {}, pending: [], requested: 0, uncharged: 0 }),
  apply: applyHardAuditProjection,
  // Version 2 renames the budget refusals to `uncharged` and adds superseded results to it; the bump rebuilds from the log.
  stateVersion: 2,
} satisfies ProjectionDefinition<'hardAudit', HardAuditProjectionState>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    hardAudit: HardAuditProjectionState
  }
}
