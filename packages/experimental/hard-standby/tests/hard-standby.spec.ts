/** The standby schedules on terminal quota failures, wakes on time, and never revives finished work. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import GoalService, { GoalId } from '@deepseek-ai/dsh-goal'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as hardStandby from '@deepseek-ai/dsh-experimental-hard-standby'
import { applyHardStandbyProjection, emptyHardStandbyState } from '@deepseek-ai/dsh-experimental-hard-standby'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
/** Fri 2026-01-02 12:00:00 UTC, the deterministic fake-clock epoch. */
const EPOCH = Date.UTC(2026, 0, 2, 12, 0, 0)

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  readonly inbox: Inbox
  followed: string[]
}


const isolatedInboxCtx = new Context()
await isolatedInboxCtx.plugin(SessionStore)
await isolatedInboxCtx.plugin(SessionProjectionRegistry)
await isolatedInboxCtx.plugin(AgentRegistry)

/** Build one registry-compatible live agent whose follow-ups are recorded. */
function stubAgent(rawId: string, suppliedCtx?: Context): StubAgent {
  const agentCtx = suppliedCtx ?? isolatedInboxCtx
  const session = agentCtx.sessions.create(SessionId(rawId))
  if (agentCtx.sessions.get(session.id) !== session) agentCtx.sessions.enter(session)
  const inbox = createInboxStub()
  const status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    status,
    ctx: agentCtx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) {
      this.inbox.append('next-step', input)
    },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  const stub: StubAgent = { agent, session, inbox, followed: [] }
  agent.followup = (message) => {
    const block = message.content[0]
    if (block?.type === 'text') stub.followed.push(block.text)
  }
  return stub
}


async function harness(config: hardStandby.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  const fiber = await ctx.plugin(hardStandby, config)
  const root = stubAgent(`hard-standby-root-${Math.random()}`, ctx)
  await ctx.agents.register(root.agent)
  return { ctx, fiber, root }
}

/** Fire one terminal model-request failure observation through the waterfall. */
async function failRequest(
  ctx: Context,
  agent: Agent,
  failure: { code: string; providerRetryAfterMs?: number },
): Promise<unknown> {
  return await agentEvents(ctx, agent).waterfall('agent/request-error', {
    turn: 1,
    step: 0,
    provider: 'test-provider',
    failure: { message: 'test failure', ...failure },
    retryPolicy: undefined,
    signal: new AbortController().signal,
  }, async () => undefined)
}

/** Capture the standby events of one kind appended to a session from now on. */
function recordStandbyEvents(ctx: Context, session: Session, type: 'hard/standby/scheduled' | 'hard/standby/woke'): () => unknown[] {
  const seen: unknown[] = []
  ctx.on('session/event', (eventSession, event) => {
    if (eventSession === session && event.type === type) seen.push(event.data)
  })
  return () => seen
}

/** Append one admitted goal round so the goal reaches its cap. */
function admitRound(agent: Agent, goal: { id: string; revision: number }, round: number): void {
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `goal round ${round}` }],
    source: { kind: 'goal', goalId: GoalId(goal.id), revision: goal.revision, round },
  }), { surfaceOp: 'append' })
}

describe('hard standby scheduling', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules a capped wake on a quota failure and delivers the continuation order', async () => {
    vi.useFakeTimers()
    const { ctx, root } = await harness()
    const goal = ctx.goals.create(root.agent, { objective: 'find bugs', maxGoalRounds: 9 })
    const scheduledOf = recordStandbyEvents(ctx, root.session, 'hard/standby/scheduled')
    const wokeOf = recordStandbyEvents(ctx, root.session, 'hard/standby/woke')
    const now = Date.now()
    await failRequest(ctx, root.agent, { code: 'QUOTA' })
    const scheduled = scheduledOf()
    expect(scheduled).toEqual([{ reason: 'quota', wakeAt: now + 24 * HOUR_MS, providerCode: 'QUOTA' }])

    await vi.advanceTimersByTimeAsync(24 * HOUR_MS + 1)
    expect(wokeOf()).toEqual([{ at: now + 24 * HOUR_MS, delivered: true }])
    expect(root.followed).toHaveLength(1)
    expect(root.followed[0]).toContain('code QUOTA')
    expect(ctx.goals.get(root.agent)?.activation).toBe('armed')
    expect(goal.phase).toBe('active')
  })

  it('prefers the provider reset delay and treats account quota as quota', async () => {
    vi.useFakeTimers()
    const { ctx, root } = await harness()
    ctx.goals.create(root.agent, { objective: 'find bugs' })
    const scheduledOf = recordStandbyEvents(ctx, root.session, 'hard/standby/scheduled')
    const now = Date.now()
    await failRequest(ctx, root.agent, { code: 'ACCOUNT_QUOTA', providerRetryAfterMs: 5 * MINUTE_MS })
    expect(scheduledOf()).toEqual([{
      reason: 'quota',
      wakeAt: now + 5 * MINUTE_MS,
      providerCode: 'ACCOUNT_QUOTA',
      providerRetryAfterMs: 5 * MINUTE_MS,
    }])
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS + 1)
    expect(root.followed).toHaveLength(1)
  })

  it('keeps the configured cron window and never reschedules while pending', async () => {
    vi.useFakeTimers({ now: EPOCH })
    const { ctx, root } = await harness({ quotaResetCron: '30 * * * *' })
    ctx.goals.create(root.agent, { objective: 'find bugs' })
    const scheduledOf = recordStandbyEvents(ctx, root.session, 'hard/standby/scheduled')
    await failRequest(ctx, root.agent, { code: 'QUOTA' })
    expect(scheduledOf())
      .toEqual([{ reason: 'quota', wakeAt: EPOCH + 30 * MINUTE_MS, providerCode: 'QUOTA' }])

    await failRequest(ctx, root.agent, { code: 'QUOTA', providerRetryAfterMs: 5 * MINUTE_MS })
    expect(scheduledOf()).toHaveLength(1)
  })

  it('re-arms a disarmed goal at wake and delivers', async () => {
    vi.useFakeTimers()
    const { ctx, root } = await harness()
    ctx.goals.create(root.agent, { objective: 'find bugs' })
    await failRequest(ctx, root.agent, { code: 'QUOTA' })
    ctx.goals.disarm(root.agent)
    const wokeOf = recordStandbyEvents(ctx, root.session, 'hard/standby/woke')
    await vi.advanceTimersByTimeAsync(24 * HOUR_MS + 1)
    expect(ctx.goals.get(root.agent)?.activation).toBe('armed')
    expect(wokeOf()).toEqual([expect.objectContaining({ delivered: true })])
    expect(root.followed).toHaveLength(1)
  })

  it('skips a paused goal and a round-capped goal without following up', async () => {
    vi.useFakeTimers()
    const { ctx, root } = await harness()
    const goal = ctx.goals.create(root.agent, { objective: 'find bugs', maxGoalRounds: 1 })
    const wokeOf = recordStandbyEvents(ctx, root.session, 'hard/standby/woke')
    await failRequest(ctx, root.agent, { code: 'QUOTA' })
    ctx.goals.pause(root.agent, { id: goal.id, revision: goal.revision })
    await vi.advanceTimersByTimeAsync(24 * HOUR_MS + 1)
    expect(wokeOf()).toEqual([
      expect.objectContaining({ delivered: false, skip: 'goal phase paused' }),
    ])
    expect(root.followed).toHaveLength(0)

    // Second cycle: an active disarmed goal at its round cap is not resumed.
    const resumed = ctx.goals.resume(root.agent, { id: goal.id, revision: goal.revision + 1 })
    admitRound(root.agent, resumed, 1)
    await failRequest(ctx, root.agent, { code: 'QUOTA' })
    ctx.goals.disarm(root.agent)
    await vi.advanceTimersByTimeAsync(24 * HOUR_MS + 1)
    expect(wokeOf()).toEqual([
      expect.objectContaining({ delivered: false, skip: 'goal phase paused' }),
      expect.objectContaining({ delivered: false, skip: 'goal round cap reached' }),
    ])
    expect(root.followed).toHaveLength(0)
  })

  it('ignores non-quota failures, non-root agents, and inactive goals', async () => {
    const { ctx, root } = await harness()
    const child = stubAgent(`hard-standby-child-${Math.random()}`, ctx)
    ctx.goals.create(root.agent, { objective: 'find bugs' })
    await failRequest(ctx, root.agent, { code: 'RATE_LIMIT' })
    await failRequest(ctx, child.agent, { code: 'QUOTA' })
    const goal = ctx.goals.get(root.agent)
    ctx.goals.pause(root.agent, { id: goal!.id, revision: goal!.revision })
    const scheduledOf = recordStandbyEvents(ctx, root.session, 'hard/standby/scheduled')
    await failRequest(ctx, root.agent, { code: 'QUOTA' })
    expect(scheduledOf()).toEqual([])
  })

  it('registers nothing when disabled', async () => {
    const { ctx, root } = await harness({ enabled: false })
    ctx.goals.create(root.agent, { objective: 'find bugs' })
    const scheduledOf = recordStandbyEvents(ctx, root.session, 'hard/standby/scheduled')
    await failRequest(ctx, root.agent, { code: 'QUOTA' })
    expect(scheduledOf()).toEqual([])
    expect(ctx.sessionProjections.stateOf(root.session, 'hardStandby')).toBeUndefined()
  })

  it('skips a cleared goal at wake and cancels every wait on plugin unload', async () => {
    vi.useFakeTimers()
    const { ctx, fiber, root } = await harness()
    const goal = ctx.goals.create(root.agent, { objective: 'find bugs' })
    const wokeOf = recordStandbyEvents(ctx, root.session, 'hard/standby/woke')
    await failRequest(ctx, root.agent, { code: 'QUOTA' })
    ctx.goals.clear(root.agent, { id: goal.id, revision: goal.revision })
    await vi.advanceTimersByTimeAsync(24 * HOUR_MS + 1)
    expect(wokeOf()).toEqual([
      expect.objectContaining({ delivered: false, skip: 'goal phase none' }),
    ])

    await failRequest(ctx, root.agent, { code: 'QUOTA' })
    await fiber.dispose()
    await vi.advanceTimersByTimeAsync(24 * HOUR_MS + 1)
    expect(wokeOf()).toHaveLength(1)
  })

  it('cancels the wake on disposal and re-arms it when the session resumes', async () => {
    vi.useFakeTimers()
    const { ctx, root } = await harness()
    ctx.goals.create(root.agent, { objective: 'find bugs' })
    const wokeOf = recordStandbyEvents(ctx, root.session, 'hard/standby/woke')
    await failRequest(ctx, root.agent, { code: 'QUOTA' })
    agentEvents(ctx, root.agent).emit('agent/disposed', {})
    await vi.advanceTimersByTimeAsync(24 * HOUR_MS + 1)
    expect(wokeOf()).toEqual([])

    await agentEvents(ctx, root.agent).serial('agent/created', { source: 'resume' })
    await vi.advanceTimersByTimeAsync(24 * HOUR_MS + 1)
    expect(wokeOf()).toEqual([
      expect.objectContaining({ delivered: true }),
    ])
    expect(root.followed[0]).toContain('code QUOTA')
  })

  it('closes a pending wait once the provider answers before the wake, and never wakes it later', async () => {
    vi.useFakeTimers()
    const { ctx, root } = await harness()
    ctx.goals.create(root.agent, { objective: 'find bugs' })
    const wokeOf = recordStandbyEvents(ctx, root.session, 'hard/standby/woke')
    await failRequest(ctx, root.agent, { code: 'QUOTA' })
    const reply = (step: number): void => {
      root.session.append('assistant/message', {
        stream: [], turn: 2, step,
        message: createAssistantMessage({ content: [{ type: 'text', text: 'resuming' }], source: { provider: 'test-provider', model: 'test-model' } }),
      }, { surfaceOp: 'append' })
    }
    reply(1)
    reply(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(wokeOf()).toEqual([{ at: Date.now(), delivered: false, skip: 'the provider answered before the wake time' }])
    expect(ctx.sessionProjections.stateOf(root.session, 'hardStandby')?.scheduled).toBeNull()
    // A later reply with no wait pending appends nothing, and the stale wake never fires.
    reply(3)
    await vi.advanceTimersByTimeAsync(24 * HOUR_MS + 1)
    expect(wokeOf()).toHaveLength(1)
    expect(root.followed).toEqual([])
  })

  it('leaves a delegated child alone when it answers', async () => {
    vi.useFakeTimers()
    const { ctx, root } = await harness()
    ctx.goals.create(root.agent, { objective: 'find bugs' })
    await failRequest(ctx, root.agent, { code: 'QUOTA' })
    const child = stubAgent(`hard-standby-child-${Math.random()}`, ctx)
    child.session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'child' }], source: { provider: 'test-provider', model: 'test-model' } }),
    }, { surfaceOp: 'append' })
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.sessionProjections.stateOf(root.session, 'hardStandby')?.scheduled).not.toBeNull()
  })

  it('validates config loudly', async () => {
    await expect(harness({ maxStandbyHours: 0 })).rejects.toThrow()
    await expect(harness({ quotaResetCron: 'not a cron' })).rejects.toThrow()
  })

  it('validates config when apply runs outside Loader normalization', async () => {
    const bare = new Context()
    expect(() => { hardStandby.apply(bare, { quotaResetCron: 'not a cron' }) }).toThrow('five fields')
    expect(() => { hardStandby.apply(bare, { maxStandbyHours: 0 }) }).toThrow('maxStandbyHours must be a positive safe integer')

    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    expect(() => { hardStandby.apply(ctx, {}) }).not.toThrow()
  })
})

describe('hard standby projection', () => {
  it('folds scheduled and woke transitions and leaves unrelated events alone', () => {
    let state = emptyHardStandbyState()
    const unrelated = { type: 'goal/change', seq: SessionSeq(0), time: 0, data: {} } as never
    expect(applyHardStandbyProjection(state, unrelated)).toBe(state)

    state = applyHardStandbyProjection(state, {
      type: 'hard/standby/scheduled',
      seq: SessionSeq(1),
      time: 1,
      data: { reason: 'quota', wakeAt: 100, providerCode: 'QUOTA' },
    })
    expect(state.scheduled).toEqual({ reason: 'quota', wakeAt: 100, providerCode: 'QUOTA' })

    state = applyHardStandbyProjection(state, {
      type: 'hard/standby/woke',
      seq: SessionSeq(2),
      time: 2,
      data: { at: 100, delivered: false, skip: 'goal phase paused' },
    })
    expect(state.scheduled).toBeNull()
    expect(state.lastWake).toEqual({ at: 100, delivered: false, skip: 'goal phase paused' })
  })
})

describe('hard standby wake chaining', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('chains waits longer than one timer bound and still wakes once', async () => {
    vi.useFakeTimers()
    // 599 hours exceeds the 2^31-1 ms setTimeout ceiling, forcing the chain branch.
    const { ctx, root } = await harness({ maxStandbyHours: 599 })
    ctx.goals.create(root.agent, { objective: 'find bugs' })
    const wokeOf = recordStandbyEvents(ctx, root.session, 'hard/standby/woke')
    await failRequest(ctx, root.agent, { code: 'QUOTA' })
    await vi.advanceTimersByTimeAsync(599 * HOUR_MS + 1)
    expect(root.followed).toHaveLength(1)
    expect(wokeOf()).toEqual([expect.objectContaining({ delivered: true })])
  })
})
