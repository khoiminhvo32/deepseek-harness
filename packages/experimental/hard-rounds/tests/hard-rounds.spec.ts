/** Hard rounds observe admitted goal rounds and pin the A/B phase, open work, and step budget. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import GoalService, { GoalId } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import * as hardRounds from '@deepseek-ai/dsh-experimental-hard-rounds'
import { phaseFor } from '@deepseek-ai/dsh-experimental-hard-rounds'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const CLAIM_HASH = 'a'.repeat(64)
const FINGERPRINT = 'b'.repeat(64)

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  readonly inbox: Inbox
  injected: string[]
  cancelled: { kind: string; reason?: string } | undefined
}

const isolatedInboxCtx = new Context()
await isolatedInboxCtx.plugin(SessionStore)
await isolatedInboxCtx.plugin(SessionProjectionRegistry)
await isolatedInboxCtx.plugin(AgentRegistry)

/** Build one registry-compatible live agent whose injections and cancels are recorded. */
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
    cancel(cause) {
      stub.cancelled = cause
    },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  const stub: StubAgent = { agent, session, inbox, injected: [], cancelled: undefined }
  agent.inject = (message) => {
    const block = message.content[0]
    if (block?.type === 'text') stub.injected.push(block.text)
    stub.inbox.append('next-step', message)
  }
  return stub
}

async function harness(config: hardRounds.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  await ctx.plugin(HardLedger, {})
  const fiber = await ctx.plugin(hardRounds, config)
  const root = stubAgent(`hard-rounds-root-${Math.random()}`, ctx)
  await ctx.agents.register(root.agent)
  return { ctx, fiber, root }
}

/** Append one admitted goal round so the rounds module observes it. */
function admitRound(agent: Agent, goal: { id: string; revision: number }, round: number): void {
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `goal round ${round}` }],
    source: { kind: 'goal', goalId: GoalId(goal.id), revision: goal.revision, round },
  }), { surfaceOp: 'append' })
}

function findingRequest() {
  return {
    title: 'SQL injection in login lookup',
    bugClass: 'sqli',
    component: 'src/auth/login.ts',
    claim: 'The username parameter reaches string concatenation into the account query.',
    cvssVector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
    cvssClaimed: 9.3,
    pocPath: 'poc/F-1/poc.sh',
    claimHash: CLAIM_HASH,
    fingerprint: FINGERPRINT,
  }
}

/** Let one deferred microtask settle before asserting. */
const drain = (): Promise<void> => new Promise((resolve) => { queueMicrotask(resolve) })

/** The events of one kind recorded by the probe installed on the context. */
function probe(ctx: Context, session: Session, type: 'hard/round/start' | 'hard/round/end'): () => unknown[] {
  const seen: unknown[] = []
  ctx.on('session/event', (eventSession, event) => {
    if (eventSession !== session) return
    const probeEvent = event as { type: string; data: { round?: number } }
    if (probeEvent.type === type && probeEvent.data.round !== undefined) seen.push(probeEvent.data)
  })
  return () => seen
}

describe('hard rounds accounting', () => {
  it('records a round start with phase and open work, and injects the round context', async () => {
    const { ctx, root } = await harness()
    const goal = ctx.goals.create(root.agent, { objective: 'find bugs', maxGoalRounds: 9 })
    ctx.hardLedger.proposeFinding(root.agent, findingRequest())
    const starts = probe(ctx, root.session, 'hard/round/start')

    admitRound(root.agent, goal, 1)
    await drain()
    expect(starts()).toEqual([{ round: 1, phase: 'A', openWorkCount: 1 }])
    expect(root.injected).toHaveLength(1)
    expect(root.injected[0]).toContain('<hard_round 1/9> phase A')
    expect(root.injected[0]).toContain('- finding F-1 awaits verification')
    expect(root.injected[0]).not.toContain('Coverage:')
    expect(root.inbox.nextStep).toHaveLength(1)
  })

  it('reports the coverage denominator in the round context once a matrix is armed', async () => {
    const { ctx, root } = await harness()
    const goal = ctx.goals.create(root.agent, { objective: 'find bugs', maxGoalRounds: 9 })
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'find bugs',
      targetRepo: '/tmp/hard-target',
      commit: 'c'.repeat(40),
      modules: ['src', 'src/auth'],
      bugClasses: ['cmdi', 'sqli'],
    })
    ctx.hardLedger.markCoverage(root.agent, { module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['s'] })
    ctx.hardLedger.markCoverage(root.agent, { module: 'src', bugClass: 'sqli', verdict: 'uncovered', declaredSinks: [] })

    admitRound(root.agent, goal, 1)
    await drain()
    expect(root.injected[0]).toContain('Coverage: 2/4 cells verdicted.')
    expect(root.injected[0]).toContain('2 coverage cell(s) have no verdict yet')
  })

  it('rotates to the deep-reading phase after every N systematic rounds', async () => {
    expect(phaseFor(1, 3)).toBe('A')
    expect(phaseFor(3, 3)).toBe('A')
    expect(phaseFor(4, 3)).toBe('B')
    expect(phaseFor(8, 3)).toBe('B')

    const { ctx, root } = await harness()
    const goal = ctx.goals.create(root.agent, { objective: 'find bugs', maxGoalRounds: 9 })
    const starts = probe(ctx, root.session, 'hard/round/start')
    for (const round of [1, 2, 3]) {
      admitRound(root.agent, goal, round)
      await drain()
      root.session.append('step/start', { turn: round, step: 0 })
      root.session.append('turn/end', { turn: round, reason: { kind: 'completed' } })
      await drain()
    }
    admitRound(root.agent, goal, 4)
    await drain()
    expect(starts()).toEqual([
      { round: 1, phase: 'A', openWorkCount: 0 },
      { round: 2, phase: 'A', openWorkCount: 0 },
      { round: 3, phase: 'A', openWorkCount: 0 },
      { round: 4, phase: 'B', openWorkCount: 0 },
    ])
    expect(root.injected[3]).toContain('<hard_round 4/9> phase B')
    expect(root.injected[3]).toContain('Phase B: run the deep-reading pass')
  })

  it('counts steps, cancels at the step cap, and records the round end', async () => {
    const { ctx, root } = await harness({ stepsPerRound: 2 })
    const goal = ctx.goals.create(root.agent, { objective: 'find bugs', maxGoalRounds: 9 })
    const ends = probe(ctx, root.session, 'hard/round/end')
    admitRound(root.agent, goal, 1)
    await drain()

    root.session.append('step/start', { turn: 1, step: 0 })
    root.session.append('step/start', { turn: 1, step: 1 })
    await agentEvents(ctx, root.agent).serial('agent/turn-stopping', { turn: 1, signal: new AbortController().signal })
    expect(root.cancelled).toEqual({ kind: 'hook', reason: 'hard round 1 reached its 2-step budget' })

    root.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'cap' } } })
    await drain()
    expect(ends()).toEqual([{ round: 1, steps: 2, reason: 'step-cap' }])
  })

  it('records a plain close below the cap and ignores other turns and sessions', async () => {
    const { ctx, root } = await harness({ stepsPerRound: 200 })
    const stranger = stubAgent(`hard-rounds-stranger-${Math.random()}`, ctx)
    const goal = ctx.goals.create(root.agent, { objective: 'find bugs', maxGoalRounds: 9 })
    const ends = probe(ctx, root.session, 'hard/round/end')
    admitRound(root.agent, goal, 1)
    await drain()

    root.session.append('step/start', { turn: 2, step: 0 })
    root.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    stranger.session.append('step/start', { turn: 1, step: 0 })
    expect(ends()).toEqual([])
    expect(root.cancelled).toBeUndefined()

    root.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await drain()
    expect(ends()).toEqual([{ round: 1, steps: 1, reason: 'closed' }])
  })

  it('ignores non-goal messages and unknown sessions', async () => {
    const { ctx, root } = await harness()
    const starts = probe(ctx, root.session, 'hard/round/start')
    root.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'plain human turn' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(starts()).toEqual([])
    expect(root.injected).toEqual([])
  })

  it('validates config when apply runs outside Loader normalization', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    expect(() => { hardRounds.apply(ctx, { stepsPerRound: 0 }) }).toThrow('stepsPerRound must be a positive safe integer')
    expect(() => { hardRounds.apply(ctx, { deepReadEveryN: 1.5 }) }).toThrow('deepReadEveryN must be a positive safe integer')
    expect(() => { hardRounds.apply(ctx, {}) }).not.toThrow()
  })

  it('has the Loader-safe namespace export shape', () => {
    expect(hardRounds.name).toBe('hard-rounds')
    expect(hardRounds.inject).toEqual(['agents', 'goals', 'hardLedger', 'sessionProjections'])
  })
})
