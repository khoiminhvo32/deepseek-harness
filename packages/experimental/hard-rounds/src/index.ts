/**
 * Hard round accounting on top of the shipped goal-round driver. The driver
 * owns reservation, revision fencing, and the goal-round cap; this plugin
 * observes each admitted goal round and adds the hard-mission layer: a
 * durable `hard/round/start` with the A/B rotation phase and the ledger's
 * open-work count, a model-facing round context injection naming the round,
 * the phase instruction, the open work, and — once no open work stands — the
 * completion gate's remaining blockers, per-round step accounting against
 * `stepsPerRound` with a cancel at the cap, a per-turn step cap against
 * `maxStepsPerTurn` enforced at the `agent/pre-step` boundary for every turn
 * whether or not a round owns it, and a durable `hard/round/end` when the
 * round's turn closes.
 * @module @deepseek-ai/dsh-experimental-hard-rounds
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Loads the declaration-merged `Context` keys this plugin injects.
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-hard-ledger'
import type {} from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
// Loads the declaration-merged `SessionEventMap` and `MessageSourceMap` entries.
import type {} from './domain.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Marks the round context the hard round driver injected after an
     * admitted goal round. The message persists for replay and audit; no
     * reader needs the producer, and readers preserve the message without
     * this attribution.
     * @persistenceAttribution
     */
    'hard-round': { kind: 'hard-round' } & ContextFormed
  }
}

export const name = 'hard-rounds'
export const inject = ['agents', 'goals', 'hardLedger', 'sessionProjections']

/** Default per-round model-step budget. */
export const DEFAULT_STEPS_PER_ROUND = 200

/** Default per-turn step cap. */
export const DEFAULT_MAX_STEPS_PER_TURN = 200

/** Default number of systematic passes between deep-reading passes. */
export const DEFAULT_DEEP_READ_EVERY_N = 3

/** Rounds module config. */
export interface Config {
  /**
   * Model-step budget per round turn; the turn is cancelled at the cap so one
   * runaway round cannot consume the whole round allowance. Checked in
   * `agent/turn-stopping`, which only fires when the model wants to stop, so
   * this bounds steering — the round cannot be talked out of its budget — but
   * never cost: a turn that never stops calling tools never reaches the check.
   * The cost bound is `maxStepsPerTurn`.
   */
  stepsPerRound?: number
  /**
   * Step cap for ONE turn, whether or not that turn belongs to an admitted
   * round. Unlike `stepsPerRound` — the round's steering budget, checked only
   * when the turn wants to close — this cap is checked at the `agent/pre-step`
   * boundary, so a turn that keeps calling tools without stopping is still
   * stopped. Reaching it rejects the step and appends `hard/step-cap/reached`.
   */
  maxStepsPerTurn?: number
  /**
   * Systematic passes between deep-reading passes under the A/B rotation.
   * Keep it equal to the mission's `deepReadEveryN`; the two values are
   * separate on purpose so the driver can rotate without reading plugin
   * config, but divergent values produce divergent cadence.
   */
  deepReadEveryN?: number
}

/** Schemastery config for the rounds module. */
export const Config: z<Config> = z.object({
  stepsPerRound: z.number().step(1).min(1).default(DEFAULT_STEPS_PER_ROUND),
  maxStepsPerTurn: z.number().step(1).min(1).max(2000).default(DEFAULT_MAX_STEPS_PER_TURN),
  deepReadEveryN: z.number().step(1).min(1).default(DEFAULT_DEEP_READ_EVERY_N),
})

/** Fully materialized rounds inputs. */
interface ResolvedConfig {
  readonly stepsPerRound: number
  readonly maxStepsPerTurn: number
  readonly deepReadEveryN: number
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const stepsPerRound = config.stepsPerRound ?? DEFAULT_STEPS_PER_ROUND
  if (!Number.isSafeInteger(stepsPerRound) || stepsPerRound < 1) {
    throw new TypeError('stepsPerRound must be a positive safe integer')
  }
  const maxStepsPerTurn = config.maxStepsPerTurn ?? DEFAULT_MAX_STEPS_PER_TURN
  if (!Number.isSafeInteger(maxStepsPerTurn) || maxStepsPerTurn < 1 || maxStepsPerTurn > 2000) {
    throw new TypeError('maxStepsPerTurn must be a safe integer between 1 and 2000')
  }
  const deepReadEveryN = config.deepReadEveryN ?? DEFAULT_DEEP_READ_EVERY_N
  if (!Number.isSafeInteger(deepReadEveryN) || deepReadEveryN < 1) {
    throw new TypeError('deepReadEveryN must be a positive safe integer')
  }
  return { stepsPerRound, maxStepsPerTurn, deepReadEveryN }
}

/** The methodology pass of one round: one deep-reading pass after every N systematic passes.
 * @param round - the admitted round number.
 * @param deepReadEveryN - systematic passes between deep-reading passes.
 * @returns `B` for the deep-reading round, `A` for a systematic round.
 */
export function phaseFor(round: number, deepReadEveryN: number): 'A' | 'B' {
  return round % (deepReadEveryN + 1) === 0 ? 'B' : 'A'
}

/** The phase's model-facing instruction for one round. */
function phaseOrder(phase: 'A' | 'B'): string {
  return phase === 'A'
    ? 'Phase A: continue the systematic source-to-sink sweep module by module: read a module once, then record every class you swept there with hard_mark_module.'
    : 'Phase B: run the deep-reading pass — model dataflow, trust boundaries, and state machines, then propose or test hypotheses.'
}

/**
 * The model-facing round context injected after the admitted round message.
 * When no open work stands, the context names the completion gate's remaining
 * blockers — the trailing-sweep and model-audit conditions live outside
 * openWork, so without this the model would be told to start work that no
 * longer exists.
 * @param round - the admitted round number.
 * @param maxRounds - the goal's round cap.
 * @param phase - the round's A/B rotation phase.
 * @param openWork - the ledger's open-work items.
 * @param gateBlockers - the completion gate's remaining blockers, empty while open work stands or the gate certifies.
 * @param coverage - the coverage denominator once a matrix is armed.
 * @returns the injected context text.
 */
function roundContext(
  round: number,
  maxRounds: number,
  phase: 'A' | 'B',
  openWork: readonly string[],
  gateBlockers: readonly string[],
  coverage: { verdicted: number; total: number } | undefined,
): string {
  const work = openWork.length > 0
    ? `Open work from the ledger:\n${openWork.slice(0, 10).map(item => `- ${item}`).join('\n')}${openWork.length > 10 ? `\n(+${openWork.length - 10} more)` : ''}`
    : gateBlockers.length > 0
      ? `Remaining before the harness can certify completion:\n${gateBlockers.map(item => `- ${item}`).join('\n')}`
      : 'The ledger reports no open work and the harness can certify completion; propose it with update_goal action complete.'
  const coverageLine = coverage === undefined || coverage.total === 0
    ? undefined
    : `Coverage: ${coverage.verdicted}/${coverage.total} cells verdicted.`
  return `<hard_round ${round}/${maxRounds}> phase ${phase}\n`
    + `${phaseOrder(phase)}\n`
    + (coverageLine === undefined ? '' : `${coverageLine}\n`)
    + `${work}\n`
    + 'Record progress with the hard tools; do not stop while concrete work remains.'
}

/** One round's live accounting, from its admitted message to its closing turn. */
interface RoundState {
  round: number
  maxRounds: number
  turn: number | undefined
  steps: number
  capFired: boolean
}

/** Register round accounting: start events, context injection, step cap, and end events. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  /** The one in-flight round per session; rounds are sequential. */
  const rounds = new Map<Agent['session'], RoundState>()
  ctx.effect(() => () => { rounds.clear() }, 'hard-rounds: clear round states')
  ctx.on('agent/disposed', ({ agent }) => { rounds.delete(agent.session) })

  ctx.on('session/event', (session, event) => {
    const state = rounds.get(session)
    if (event.type === 'user/message' && event.data.source.kind === 'goal' && state === undefined) {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined) return
      const goal = ctx.goals.get(agent)
      if (goal === undefined) return
      const round = event.data.source.round
      const phase = phaseFor(round, resolved.deepReadEveryN)
      const openWork = ctx.hardLedger.openWork(agent)
      const matrix = ctx.hardLedger.coverageMatrix(agent)
      const coverage = matrix === undefined ? undefined : ctx.hardLedger.coverageProgress(agent)
      const gateBlockers = openWork.length === 0
        ? ctx.hardLedger.completionAssessment(agent).blockers
        : []
      rounds.set(session, {
        round,
        maxRounds: goal.maxGoalRounds,
        turn: undefined,
        steps: 0,
        capFired: false,
      })
      // The post-commit append feed forbids reentrant appends, so the round
      // start record and its context injection settle one microtask later.
      queueMicrotask(() => {
        session.append('hard/round/start', { round, phase, openWorkCount: openWork.length })
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: roundContext(round, goal.maxGoalRounds, phase, openWork, gateBlockers, coverage) }],
          source: { kind: 'hard-round' },
        }))
      })
      return
    }
    if (state === undefined) return
    if (event.type === 'step/start') {
      state.turn = event.data.turn
      state.steps += 1
      return
    }
    if (event.type === 'turn/end' && state.turn === event.data.turn) {
      rounds.delete(session)
      const record = { round: state.round, steps: state.steps, reason: state.capFired ? 'step-cap' as const : 'closed' as const }
      queueMicrotask(() => { session.append('hard/round/end', record) })
    }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const state = rounds.get(agent.session)
    if (state === undefined || state.turn !== turn || state.capFired) return
    if (state.steps < resolved.stepsPerRound) return
    state.capFired = true
    agent.cancel({ kind: 'hook', reason: `hard round ${state.round} reached its ${resolved.stepsPerRound}-step budget` })
  })

  // The loop's own step position is 1-based and per turn, so it needs no
  // keyed counter here: trusting it cannot drift from the loop the way a
  // private counter could.
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    if (step <= resolved.maxStepsPerTurn) return await next()
    const state = rounds.get(agent.session)
    agent.session.append('hard/step-cap/reached', {
      turn,
      steps: step - 1,
      limit: resolved.maxStepsPerTurn,
      ...(state !== undefined && state.turn === turn ? { round: state.round } : {}),
    })
    return { kind: 'reject' }
  })
}
