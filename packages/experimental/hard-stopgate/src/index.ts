/**
 * Hard stop gate on the turn boundary, and the completion gate on the goal
 * tool. While an armed goal is active, a turn that tries to close receives a
 * steering continuation order naming the open work until the per-turn steer
 * budget is spent; goalless, disarmed, paused, blocked, and completed agents
 * close freely, and a pending standby wait closes freely because the
 * scheduled wake owns the session's rhythm. Completion is the harness's call:
 * an `update_goal action complete` attempt on the armed goal runs the
 * ledger's completion assessment, is denied with the exact remaining work
 * while any stands, and every decision is appended as `hard/gate/decision`.
 * @module @deepseek-ai/dsh-experimental-hard-stopgate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Loads the declaration-merged `Context` keys this plugin injects: the
// `hardStandby` projection key the standby-aware rule reads and the
// `hardLedger` key the completion gate and steering read.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-hard-ledger'
import type { HardGateDecisionData } from '@deepseek-ai/dsh-experimental-hard-ledger'
import type {} from '@deepseek-ai/dsh-experimental-hard-standby'
// Loads the `tools/pre-execute` seam this plugin gates on.
import type {} from '@deepseek-ai/dsh-tools'
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
export const inject = ['goals', 'sessionProjections', 'hardLedger']

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

/**
 * The model-facing denial for one gated completion: the exact remaining work
 * as one imperative, never a generic refusal.
 */
function completionDenial(blockers: readonly string[]): string {
  return `The mission is not complete. ${blockers.join('; ')}. Resolve these, then mark the goal complete.`
}

/** The model-facing continuation order for one blocked stopping attempt. */
function continuationOrder(goal: GoalView, work: readonly string[]): string {
  const listed = work.slice(0, 8).join('; ')
  const more = work.length > 8 ? `; and ${work.length - 8} more open item(s)` : ''
  return `The session objective is not complete: "${goal.objective}". `
    + `Goal round ${goal.roundsStarted} of ${goal.maxGoalRounds}. `
    + `Open work: ${listed}${more}. `
    + 'Resolve the next item now; do not stop or summarize. '
    + 'The harness owns completion: update_goal action complete is denied while this list is non-empty.'
}

/** Narrow the model-supplied tool arguments to `update_goal`'s complete action. */
function isCompleteGoalAction(args: unknown): boolean {
  if (typeof args !== 'object' || args === null || !('action' in args)) return false
  return args.action === 'complete'
}

/** Assemble the durable decision record for one completion attempt. */
function gateDecision(
  ctx: Context,
  agent: Agent,
  assessment: { complete: boolean; blockers: readonly string[] },
): HardGateDecisionData {
  const progress = ctx.hardLedger.coverageProgress(agent)
  const bySource = ctx.hardLedger.coverageBySource(agent)
  const exclusions = ctx.hardLedger.coverageMatrix(agent)?.exclusions
  const hypotheses = ctx.hardLedger.hypotheses(agent)
  const resolved = hypotheses
    .filter(hypothesis => hypothesis.status === 'confirmed' || hypothesis.status === 'refuted').length
  const findings = ctx.hardLedger.findings(agent)
  const countVerdict = (verdict: 'confirmed' | 'refuted' | 'flaky'): number =>
    findings.filter(entry => entry.verdict?.verdict === verdict).length
  return {
    decision: assessment.complete ? 'allow' : 'deny',
    openWorkCount: ctx.hardLedger.openWork(agent).length,
    coverage: {
      verdicted: progress.verdicted,
      total: progress.total,
      bySource: { model: bySource.model, modelVerified: bySource.modelVerified, harness: bySource.harness },
      blindClears: ctx.hardLedger.blindClears(agent),
      ...(exclusions === undefined ? {} : { excludedFileCount: exclusions.fileCount }),
    },
    hypotheses: { resolved, open: hypotheses.length - resolved },
    findings: {
      confirmed: countVerdict('confirmed'),
      refuted: countVerdict('refuted'),
      flaky: countVerdict('flaky'),
      pending: findings.filter(entry => entry.verdict === undefined).length,
    },
    emptySweeps: ctx.hardLedger.emptySweepRun(agent),
    blockers: assessment.complete ? [] : [...assessment.blockers],
  }
}

/**
 * Steer the turn back to work while open work stands, and decide completion:
 * the model proposes `update_goal action complete`, the ledger assesses, and
 * the harness records and enforces the verdict.
 */
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
  // The completion gate vetoes only; the goal tool stays the single writer,
  // and steering stays on the turn boundary so a denial never double-steers.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'update_goal') return next()
    const agent = exec.agent
    if (agent === undefined) return next()
    if (!isCompleteGoalAction(exec.arguments)) return next()
    const armedGoalId = ctx.hardLedger.armedGoalId(agent)
    if (armedGoalId === undefined) return next()
    const goal = ctx.goals.get(agent)
    if (goal?.id !== armedGoalId) return next()
    const assessment = ctx.hardLedger.completionAssessment(agent)
    agent.session.append('hard/gate/decision', gateDecision(ctx, agent, assessment))
    if (assessment.complete) return next()
    return { kind: 'deny', reason: completionDenial(assessment.blockers) }
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
    const work = ctx.hardLedger.openWork(agent)
    // Nothing open means the only remaining act is completing, which the
    // gate decides — steering here would order work that does not exist.
    if (work.length === 0) return
    steers.set(agent.id, { turn, count: steeredThisTurn + 1 })
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: continuationOrder(owing, work) }],
      source: { kind: 'hard-stopgate' },
    }))
  })
}
