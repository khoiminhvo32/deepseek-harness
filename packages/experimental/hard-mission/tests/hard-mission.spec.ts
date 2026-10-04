/** Arms the configured objective as a durable goal and registers the mission contract section. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import GoalService from '@deepseek-ai/dsh-goal'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as hardMission from '@deepseek-ai/dsh-experimental-hard-mission'
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

async function harness(config: hardMission.Config = { objective: 'hunt bugs in the target repository' }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  const fiber = await ctx.plugin(hardMission, config)
  const root = stubAgent(`hard-mission-root-${Math.random()}`, undefined, ctx)
  await ctx.agents.register(root.agent)
  return { ctx, fiber, root }
}

describe('hard mission arming', () => {
  it('arms the configured objective when a root agent registers', async () => {
    const { ctx, root } = await harness({ objective: 'hunt bugs', maxGoalRounds: 9 })
    expect(ctx.goals.get(root.agent)).toMatchObject({
      objective: 'hunt bugs',
      phase: 'active',
      activation: 'armed',
      maxGoalRounds: 9,
    })
  })

  it('never duplicates or recreates across later creation boundaries', async () => {
    const { ctx, root } = await harness()
    const first = ctx.goals.get(root.agent)
    for (const source of ['startup', 'resume', 'clear', 'compact'] as const) {
      await agentEvents(ctx, root.agent).serial('agent/created', { source })
      const current = ctx.goals.get(root.agent)
      expect(current?.id).toBe(first?.id)
      expect(current?.revision).toBe(1)
    }
  })

  it('ignores child agents', async () => {
    const { ctx, root } = await harness()
    const child = stubAgent(`hard-mission-child-${Math.random()}`, undefined, ctx)
    ctx.agents.enter(child.agent, root.agent)
    await ctx.agents.announce(child.agent, 'startup')
    expect(ctx.goals.get(child.agent)).toBeUndefined()
    expect(ctx.goals.get(root.agent)?.revision).toBe(1)
  })

  it('stops arming after disposal', async () => {
    const { ctx, fiber, root } = await harness()
    expect(ctx.goals.get(root.agent)?.revision).toBe(1)
    await fiber.dispose()
    const later = stubAgent(`hard-mission-later-${Math.random()}`, undefined, ctx)
    await ctx.agents.register(later.agent)
    expect(ctx.goals.get(later.agent)).toBeUndefined()
  })
})

describe('mission contract section', () => {
  it('registers the configured contract and disposes it with the fiber', async () => {
    const { ctx, fiber } = await harness({
      objective: 'find every authentication bypass',
      bugClasses: ['authn', 'authz'],
      deepReadEveryN: 2,
    })
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'hard:mission')
    expect(section?.text).toContain('Mission: find every authentication bypass')
    expect(section?.text).toContain('Systematic passes sweep these bug classes: authn, authz.')
    expect(section?.text).toContain('Every 2 systematic passes')
    expect(section?.text).toContain('update_goal action complete')
    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble()).sections.some(item => item.name === 'hard:mission')).toBe(false)
  })

  it('omits the class list when bugClasses is empty', async () => {
    const { ctx } = await harness({ objective: 'audit the parser', bugClasses: [] })
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'hard:mission')
    expect(section?.text).toContain('Mission: audit the parser')
    expect(section?.text).not.toContain('bug classes')
  })

  it('uses the default class list, round cap, and cadence on direct apply', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    hardMission.apply(ctx, { objective: 'defaults' })
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'hard:mission')
    expect(section?.text).toContain(hardMission.DEFAULT_BUG_CLASSES.join(', '))
    expect(section?.text).toContain(`Every ${hardMission.DEFAULT_DEEP_READ_EVERY_N} systematic passes`)
  })
})

describe('hard mission config and namespace', () => {
  it('fails loud on a blank objective before registering anything', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    expect(() => { hardMission.apply(ctx, { objective: '   ' }) }).toThrow('objective must be a non-empty string')
    expect((await ctx.systemPrompt.assemble()).sections.some(item => item.name === 'hard:mission')).toBe(false)
  })

  it('rejects invalid direct-apply values', () => {
    const ctx = new Context()
    expect(() => { hardMission.apply(ctx, { objective: 'x', maxGoalRounds: 1.5 }) })
      .toThrow('maxGoalRounds must be a positive safe integer')
    expect(() => { hardMission.apply(ctx, { objective: 'x', deepReadEveryN: 0 }) })
      .toThrow('deepReadEveryN must be a positive safe integer')
    expect(() => { hardMission.apply(ctx, { objective: 'x', bugClasses: ['ok', ' '] }) })
      .toThrow('bugClasses must be an array of non-empty class names')
  })

  it('has the Loader-safe namespace export shape', () => {
    expect('default' in hardMission).toBe(false)
    expect(hardMission.name).toBe('hard-mission')
    expect(hardMission.inject).toEqual(['agents', 'goals', 'systemPrompt'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(hardMission)).toBe(hardMission)
  })
})
