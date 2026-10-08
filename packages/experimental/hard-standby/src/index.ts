/**
 * Hard standby on terminal quota failures. When a root agent whose goal is
 * active hits an exhausted quota, the plugin schedules a wake at the reset
 * time — the provider's requested delay when present, otherwise the next
 * match of a configured reset cron, otherwise the standby cap — records the
 * wait as a durable event, and lets the failed turn end. When the wake fires
 * it re-arms an active disarmed goal, records the wake, and delivers a
 * continuation follow-up, so the mission resumes on a bounded rhythm instead
 * of stalling. A user-paused, blocked, or completed goal is never revived.
 * @module @deepseek-ai/dsh-experimental-hard-standby
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Loads the declaration-merged `Context` keys this plugin injects.
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-goal'
import {
  ACCOUNT_QUOTA_EXCEEDED_CODE,
  createUserMessage,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import { parseCron } from './cron.ts'
import { hardStandbyProjectionDefinition } from './projection.ts'
import { resolveWakeAt } from './wake.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Marks the continuation follow-up the hard standby delivered when a
     * scheduled quota wait woke. The message persists for replay and audit;
     * no reader needs the producer, and readers preserve the message without
     * this attribution.
     * @persistenceAttribution
     */
    'hard-standby': { kind: 'hard-standby' } & ContextFormed
  }
}

export const name = 'hard-standby'
export const inject = ['agents', 'goals', 'sessionProjections']

export type { HardStandbyProjectionState } from './projection.ts'
export { applyHardStandbyProjection, emptyHardStandbyState, hardStandbyProjectionDefinition } from './projection.ts'
export type { HardStandbyReason, HardStandbyScheduledData, HardStandbyWokeData } from './domain.ts'

/** Default upper bound of one standby wait, in hours. */
export const DEFAULT_MAX_STANDBY_HOURS = 24

/** Largest single `setTimeout` delay; longer waits chain through this bound. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

const HOUR_MS = 3_600_000

/** Standby plugin config. */
export interface Config {
  /**
   * Master switch; `false` registers nothing, so the session ends on quota
   * failures like any unmanaged session.
   */
  enabled?: boolean
  /**
   * Five-field UTC cron naming the quota-reset windows, used when the
   * provider sends no reset delay. Validated at load; omit when unset.
   */
  quotaResetCron?: string
  /**
   * Upper bound of one wait in hours. When neither the provider nor the cron
   * names a reset time, the cap is also the retry cadence.
   */
  maxStandbyHours?: number
}

/** Schemastery config for the standby plugin. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  quotaResetCron: z.string(),
  maxStandbyHours: z.number().step(1).min(1).default(DEFAULT_MAX_STANDBY_HOURS),
})

/** Fully materialized standby inputs. */
interface ResolvedConfig {
  readonly enabled: boolean
  readonly quotaResetCron: string | undefined
  readonly maxStandbyMs: number
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const enabled = config.enabled ?? true
  const quotaResetCron = config.quotaResetCron
  if (quotaResetCron !== undefined) parseCron(quotaResetCron)
  const maxStandbyHours = config.maxStandbyHours ?? DEFAULT_MAX_STANDBY_HOURS
  if (!Number.isSafeInteger(maxStandbyHours) || maxStandbyHours < 1) {
    throw new TypeError('maxStandbyHours must be a positive safe integer')
  }
  return { enabled, quotaResetCron, maxStandbyMs: maxStandbyHours * HOUR_MS }
}

/** Whether the failure is a terminal quota exhaustion the standby waits out. */
function isQuotaFailure(code: string): boolean {
  return code === QUOTA_EXCEEDED_CODE || code === ACCOUNT_QUOTA_EXCEEDED_CODE
}

/** The model-facing continuation order delivered when a standby wakes. */
function wakeOrder(providerCode: string): string {
  return `The provider quota window that stopped this session has been waited out (code ${providerCode}). `
    + 'Resume the mission now: read your durable ledger state, then take the next concrete action that advances the objective. '
    + 'Do not wait or ask for permission; propose completion with update_goal action complete only once the objective '
    + 'is genuinely achieved — the harness certifies it and denies an early attempt with the remaining work.'
}

/** Resolve one wake's delivery: resume an active disarmed goal, never revive paused or capped work. */
function wakeDecision(
  goal: GoalView | undefined,
): { deliver: false; skip: string } | { deliver: true; resume: boolean } {
  if (goal?.phase !== 'active') {
    return { deliver: false, skip: `goal phase ${goal?.phase ?? 'none'}` }
  }
  if (goal.activation !== 'armed') {
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      return { deliver: false, skip: 'goal round cap reached' }
    }
    return { deliver: true, resume: true }
  }
  return { deliver: true, resume: false }
}

/** One pending wake: its timer cancellation and the provider code to report. */
interface PendingWake {
  cancel: () => void
  providerCode: string
}

/** Register the standby projection, the quota listener, and the wake timers. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  ctx.sessionProjections.register(hardStandbyProjectionDefinition)
  /** Pending wake per agent, if any. */
  const timers = new Map<Agent['id'], PendingWake>()
  ctx.effect(() => () => {
    for (const pending of timers.values()) pending.cancel()
    timers.clear()
  }, 'hard-standby: clear wake timers')

  function arm(id: Agent['id'], delayMs: number, providerCode: string): void {
    timers.get(id)?.cancel()
    const pending: PendingWake = {
      providerCode,
      cancel: () => { clearTimeout(handle) },
    }
    let handle: ReturnType<typeof setTimeout>
    const tick = (remaining: number): void => {
      if (remaining > MAX_TIMEOUT_MS) {
        handle = setTimeout(() => { tick(remaining - MAX_TIMEOUT_MS) }, MAX_TIMEOUT_MS)
      } else {
        handle = setTimeout(() => { wake(id) }, Math.max(remaining, 0))
      }
    }
    tick(delayMs)
    timers.set(id, pending)
  }

  function wake(id: Agent['id']): void {
    const pending = timers.get(id)
    if (pending === undefined) return
    timers.delete(id)
    const live = ctx.agents.get(id)
    /* v8 ignore next -- defensive: disposal cancels the timer before the agent leaves the registry. */
    if (live === undefined) return
    const decision = wakeDecision(ctx.goals.get(live))
    if (!decision.deliver) {
      live.session.append('hard/standby/woke', { at: Date.now(), delivered: false, skip: decision.skip })
      return
    }
    const goal = ctx.goals.get(live)
    /* v8 ignore next -- defensive: wakeDecision only delivers when a live goal view exists. */
    if (goal === undefined) return
    if (decision.resume) ctx.goals.resume(live, { id: goal.id, revision: goal.revision })
    live.session.append('hard/standby/woke', { at: Date.now(), delivered: true })
    live.followup(createUserMessage({
      content: [{ type: 'text', text: wakeOrder(pending.providerCode) }],
      source: { kind: 'hard-standby' },
    }))
  }

  ctx.on('agent/request-error', async ({ agent, failure }, next) => {
    if (!isQuotaFailure(failure.code)) return next()
    if (!ctx.agents.roots().includes(agent)) return next()
    if (ctx.goals.get(agent)?.phase !== 'active') return next()
    if (timers.has(agent.id)) return next()
    const now = Date.now()
    const wakeAt = resolveWakeAt({
      now,
      cron: resolved.quotaResetCron,
      maxStandbyMs: resolved.maxStandbyMs,
      ...failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs },
    })
    agent.session.append('hard/standby/scheduled', {
      reason: 'quota',
      wakeAt,
      providerCode: failure.code,
      ...failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs },
    })
    arm(agent.id, wakeAt - now, failure.code)
    return next()
  })

  ctx.on('agent/created', ({ agent, source }) => {
    if (source !== 'resume') return
    const state = ctx.sessionProjections.stateOf(agent.session, 'hardStandby')
    const wakeAt = state?.scheduled?.wakeAt
    const providerCode = state?.scheduled?.providerCode
    if (wakeAt === undefined || providerCode === undefined || timers.has(agent.id)) return
    arm(agent.id, Math.max(wakeAt - Date.now(), 0), providerCode)
  })

  /** Sessions whose pending wait is being closed; the close appends one microtask later. */
  const closing = new Set<Agent['session']>()
  // A model reply proves the quota window ended before the wake: the user or a
  // recharge resumed the session. Close the wait, or the stop gate keeps
  // treating the session as standing by until the stale wake time.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message' || closing.has(session)) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined || !ctx.agents.roots().includes(agent)) return
    if (ctx.sessionProjections.stateOf(session, 'hardStandby')?.scheduled == null) return
    timers.get(agent.id)?.cancel()
    timers.delete(agent.id)
    closing.add(session)
    // The post-commit append feed forbids reentrant appends.
    queueMicrotask(() => {
      closing.delete(session)
      session.append('hard/standby/woke', { at: Date.now(), delivered: false, skip: 'the provider answered before the wake time' })
    })
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const pending = timers.get(agent.id)
    if (pending === undefined) return
    timers.delete(agent.id)
    pending.cancel()
  })
}
