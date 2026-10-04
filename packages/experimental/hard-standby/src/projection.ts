/**
 * Session-projection unit for the hard standby: a pure fold over the two
 * `hard/standby/*` event types maintaining the scheduled wait and its latest
 * wake, so resumed sessions restore the standby state machine without
 * scanning the log (per the synchronous-read deprecation decision).
 * @module
 */

import { z as zod } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const scheduledSchema = zod.object({
  reason: zod.enum(['quota', 'outage']),
  wakeAt: zod.number().int().positive(),
  providerCode: zod.string().min(1),
  providerRetryAfterMs: zod.number().int().positive().optional(),
})

const wokeSchema = zod.object({
  at: zod.number().int().positive(),
  delivered: zod.boolean(),
  skip: zod.string().min(1).optional(),
})

/** Validates persisted projection state before it seeds a fold. */
export const hardStandbyStateSchema = zod.object({
  scheduled: scheduledSchema.nullable(),
  lastWake: wokeSchema.nullable(),
  failure: zod.string().min(1).nullable(),
})

/**
 * Pure projection transition over one committed session event.
 * @param state - the projection covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state (same reference when the event is unrelated).
 */
export function applyHardStandbyProjection(state: HardStandbyProjectionState, event: Parameters<ProjectionDefinition<'hardStandby', HardStandbyProjectionState>['apply']>[1]): HardStandbyProjectionState {
  /* v8 ignore next -- defensive: a failed fold stops advancing until the state is repaired. */
  if (state.failure !== null) return state
  switch (event.type) {
    case 'hard/standby/scheduled':
      return { ...state, scheduled: event.data }
    case 'hard/standby/woke':
      return { ...state, scheduled: null, lastWake: event.data }
    default:
      return state
  }
}

/** Host-side standby state restored at resume and maintained incrementally. */
export type HardStandbyProjectionState = zod.infer<typeof hardStandbyStateSchema>

/** Build the empty projection state (also used by direct unit tests).
 * @returns the initial standby projection state.
 */
export function emptyHardStandbyState(): HardStandbyProjectionState {
  return hardStandbyStateSchema.parse({ scheduled: null, lastWake: null, failure: null })
}

/** The host-only projection unit registered by the hard-standby plugin. */
export const hardStandbyProjectionDefinition = {
  key: 'hardStandby',
  stateSchema: hardStandbyStateSchema,
  init: (): HardStandbyProjectionState => ({
    scheduled: null,
    lastWake: null,
    failure: null,
  }),
  apply: applyHardStandbyProjection,
  stateVersion: 1,
} satisfies ProjectionDefinition<'hardStandby', HardStandbyProjectionState>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    hardStandby: HardStandbyProjectionState
  }
}
