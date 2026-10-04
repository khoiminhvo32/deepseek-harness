/** The stop gate steers an armed active goal's stopping attempts until the per-turn budget is spent. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import type { GoalRef } from '@deepseek-ai/dsh-goal'
import GoalService from '@deepseek-ai/dsh-goal'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as hardStopgate from '@deepseek-ai/dsh-experimental-hard-stopgate'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  readonly inbox: Inbox
  setStatus(status: AgentStatus): void
}

const isolatedInboxCtx = new Context()
await isolatedInboxCtx.plugin(SessionStore)
await isolatedInboxCtx.plugin(SessionProjectionRegistry)
await isolatedInboxCtx.plugin(AgentRegistry)

/** Build one registry-compatible live agent whose injections enter its test Inbox. */
function stubAgent(rawId: string, supplied?: Session, suppliedCtx?: Context): StubAgent {
  const agentCtx = suppliedCtx ?? isolatedInboxCtx
  const session = supplied ?? (suppliedCtx === undefined
    ? agentCtx.sessions.create(SessionId(rawId))
    : suppliedCtx.sessions.create(SessionId(rawId)))
  if (suppliedCtx === undefined) {
    if (agentCtx.sessions.get(session.id) !== session) agentCtx.sessions.enter(session)
  }
  const inbox = createInboxStub()
  let status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    get status() { return status },
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
  return { agent, session, inbox, setStatus(value) { status = value } }
}

/** A stub agent whose steering attempts are recorded verbatim. */
function recordingAgent(rawId: string, ctx: Context) {
  const base = stubAgent(rawId, undefined, ctx)
  const steered: string[] = []
  base.agent.steer = (message) => {
    const block = message.content[0]
    if (block?.type === 'text') steered.push(block.text)
    return { outcome: Promise.resolve({ status: 'rejected' as const }) }
  }
  return { ...base, steered }
}

async function harness(config: hardStopgate.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  const fiber = await ctx.plugin(hardStopgate, config)
  const root = recordingAgent(`hard-stopgate-root-${Math.random()}`, ctx)
  await ctx.agents.register(root.agent)
  return { ctx, fiber, root }
}

/** Fire one turn-stopping observation for the agent. */
async function stopAt(ctx: Context, agent: Agent, turn: number): Promise<void> {
  await agentEvents(ctx, agent).serial('agent/turn-stopping', {
    turn,
    signal: new AbortController().signal,
  })
}

describe('hard stopgate', () => {
  it('steers an armed active goal back to work at the boundary', async () => {
    const { ctx, root } = await harness()
    ctx.goals.create(root.agent, { objective: 'find the deserialization bug', maxGoalRounds: 9 })
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(1)
    expect(root.steered[0]).toContain('The session objective is not complete: "find the deserialization bug".')
    expect(root.steered[0]).toContain('Goal round 0 of 9')
    expect(root.steered[0]).toContain('update_goal action complete')
  })

  it('lets goalless and disarmed states close freely', async () => {
    const { ctx, root } = await harness()
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(0)

    const goal = ctx.goals.create(root.agent, { objective: 'temporary' })
    ctx.goals.disarm(root.agent)
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(0)
    expect(goal.activation).toBe('armed')
  })

  it('lets paused, blocked, and completed phases close freely', async () => {
    const { ctx, root } = await harness()
    ctx.goals.create(root.agent, { objective: 'state tour' })
    const ref = (): GoalRef => {
      const goal = ctx.goals.get(root.agent)
      if (goal === undefined) throw new Error('expected live goal')
      return { id: goal.id, revision: goal.revision }
    }

    ctx.goals.pause(root.agent, ref())
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(0)

    ctx.goals.resume(root.agent, ref())
    ctx.goals.block(root.agent, ref(), { code: 'test', message: 'wait for credentials' })
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(0)

    ctx.goals.resume(root.agent, ref())
    ctx.goals.complete(root.agent, ref())
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(0)
  })

  it('stops forcing after the per-turn budget and resumes on a new turn', async () => {
    const { ctx, root } = await harness({ maxSteersPerTurn: 2 })
    ctx.goals.create(root.agent, { objective: 'persist' })
    await stopAt(ctx, root.agent, 1)
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(2)
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(2)
    await stopAt(ctx, root.agent, 2)
    expect(root.steered).toHaveLength(3)
  })

  it('drops per-agent counters when the agent leaves the registry', async () => {
    const { ctx, root } = await harness({ maxSteersPerTurn: 1 })
    ctx.goals.create(root.agent, { objective: 'counter reset' })
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(1)
    agentEvents(ctx, root.agent).emit('agent/disposed', {})
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(2)
  })

  it('stops steering after disposal', async () => {
    const { ctx, fiber, root } = await harness()
    ctx.goals.create(root.agent, { objective: 'disposed work' })
    await fiber.dispose()
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(0)
  })
})

describe('hard stopgate config and namespace', () => {
  it('rejects an invalid direct-apply budget before registering anything', () => {
    const ctx = new Context()
    expect(() => { hardStopgate.apply(ctx, { maxSteersPerTurn: 0 }) })
      .toThrow('maxSteersPerTurn must be a positive safe integer')
  })

  it('uses the default budget on direct apply', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(GoalService)
    hardStopgate.apply(ctx, {})
    const root = recordingAgent('hard-stopgate-defaults', ctx)
    await ctx.agents.register(root.agent)
    ctx.goals.create(root.agent, { objective: 'default budget' })
    for (let attempt = 0; attempt < hardStopgate.DEFAULT_MAX_STEERS_PER_TURN; attempt += 1) {
      await stopAt(ctx, root.agent, 1)
    }
    expect(root.steered).toHaveLength(hardStopgate.DEFAULT_MAX_STEERS_PER_TURN)
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(hardStopgate.DEFAULT_MAX_STEERS_PER_TURN)
    await stopAt(ctx, root.agent, 2)
    expect(root.steered).toHaveLength(hardStopgate.DEFAULT_MAX_STEERS_PER_TURN + 1)
  })

  it('has the Loader-safe namespace export shape', () => {
    expect('default' in hardStopgate).toBe(false)
    expect(hardStopgate.name).toBe('hard-stopgate')
    expect(hardStopgate.inject).toEqual(['goals'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(hardStopgate)).toBe(hardStopgate)
  })
})
