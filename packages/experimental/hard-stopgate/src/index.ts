/**
 * Hard stop gate on the turn boundary. While an armed goal is active, a turn
 * that tries to close receives a steering continuation order until the
 * per-turn steer budget is spent; goalless, disarmed, paused, blocked, and
 * completed agents close freely, and a pending standby wait closes freely
 * because the scheduled wake owns the session's rhythm. The gate reads only
 * goal state and the standby projection; open-work awareness (unverified
 * findings, uncovered sweep cells) joins with the hard-verifier ledger.
 * @module @deepseek-ai/dsh-experimental-hard-stopgate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Loads the declaration-merged `Context` keys this plugin injects, including
// the `hardStandby` projection key the standby-aware rule reads.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-hard-standby'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-session-projection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Marks steering that the hard stop gate injected at a turn-stopping
     * boundary. The message persists for replay and audit; no reader needs the
     * producer, and readers preserve the message without this attribution.
     * @persistenceAttribution
     */
    'hard-stopgate': { kind: 'hard-stopgate' } & ContextFormed
  }
}

export const name = 'hard-stopgate'
export const inject = ['goals', 'sessionProjections']

/** Default per-turn forced-continuation budget. */
export const DEFAULT_MAX_STEERS_PER_TURN = 16

/** Stop-gate plugin config. */
export interface Config {
  /**
   * Maximum forced continuations within one turn before the gate allows the
   * turn to close. The bound keeps a steering loop from running forever when
   * the model cannot or will not advance the goal.
   */
  maxSteersPerTurn?: number
}

/** Schemastery config for the stop gate. */
export const Config: z<Config> = z.object({
  maxSteersPerTurn: z.number().step(1).min(1).default(DEFAULT_MAX_STEERS_PER_TURN),
})

/**
 * The goal that still owes progress at this boundary, or `undefined` when the
 * turn may close: no goal, a disarmed goal, a non-active phase, a spent
 * per-turn steer budget, or a pending standby wait.
 */
function owingGoal(
  goal: GoalView | undefined,
  steeredThisTurn: number,
  maxSteers: number,
  pendingStandby: boolean,
): GoalView | undefined {
  if (goal === undefined || goal.activation !== 'armed' || goal.phase !== 'active') return undefined
  if (pendingStandby) return undefined
  return steeredThisTurn < maxSteers ? goal : undefined
}

/** The model-facing continuation order for one blocked stopping attempt. */
function continuationOrder(goal: GoalView): string {
  return `The session objective is not complete: "${goal.objective}". `
    + `Goal round ${goal.roundsStarted} of ${goal.maxGoalRounds}. `
    + 'Do not stop or summarize; take the next concrete action that advances the objective now. '
    + 'End the turn only after marking the goal complete with update_goal action complete '
    + 'once the objective is genuinely achieved.'
}

/** Steer the turn back to work while the goal still owes progress; enforce the per-turn budget. */
export function apply(ctx: Context, config: Config): void {
  const maxSteersPerTurn = config.maxSteersPerTurn ?? DEFAULT_MAX_STEERS_PER_TURN
  if (!Number.isSafeInteger(maxSteersPerTurn) || maxSteersPerTurn < 1) {
    throw new TypeError('maxSteersPerTurn must be a positive safe integer')
  }
  /** Forced continuations per agent, reset when the turn number advances. */
  const steers = new Map<Agent['id'], { turn: number; count: number }>()
  ctx.effect(() => () => { steers.clear() }, 'hard-stopgate: clear steer counters')
  ctx.on('agent/disposed', ({ agent }) => {
    steers.delete(agent.id)
  })
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const counted = steers.get(agent.id)
    const steeredThisTurn = counted?.turn === turn ? counted.count : 0
    // A pending standby wait owns the session's rhythm: let the turn close
    // cleanly so the scheduled wake delivers the next continuation instead.
    const scheduledWakeAt = ctx.sessionProjections.stateOf(agent.session, 'hardStandby')?.scheduled?.wakeAt
    const pendingStandby = scheduledWakeAt !== undefined && scheduledWakeAt > Date.now()
    const owing = owingGoal(ctx.goals.get(agent), steeredThisTurn, maxSteersPerTurn, pendingStandby)
    if (owing === undefined) return
    steers.set(agent.id, { turn, count: steeredThisTurn + 1 })
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: continuationOrder(owing) }],
      source: { kind: 'hard-stopgate' },
    }))
  })
}
