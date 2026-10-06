/** The handoff injects deterministic ledger state after successful compactions only. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import GoalService from '@deepseek-ai/dsh-goal'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import type { HardFindingId, HardHypothesisId } from '@deepseek-ai/dsh-experimental-hard-ledger'
import * as hardHandoff from '@deepseek-ai/dsh-experimental-hard-handoff'
import { buildHandoff } from '@deepseek-ai/dsh-experimental-hard-handoff'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const CLAIM_HASH = 'a'.repeat(64)
const FINGERPRINT = 'b'.repeat(64)

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  readonly inbox: Inbox
  injected: string[]
}

const isolatedInboxCtx = new Context()
await isolatedInboxCtx.plugin(SessionStore)
await isolatedInboxCtx.plugin(SessionProjectionRegistry)
await isolatedInboxCtx.plugin(AgentRegistry)

/** Build one registry-compatible live agent whose injections are recorded. */
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
  const stub: StubAgent = { agent, session, inbox, injected: [] }
  agent.inject = (message) => {
    const block = message.content[0]
    if (block?.type === 'text') stub.injected.push(block.text)
    stub.inbox.append('next-step', message)
  }
  return stub
}

async function harness(config: hardHandoff.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  await ctx.plugin(HardLedger, {})
  const fiber = await ctx.plugin(hardHandoff, config)
  const root = stubAgent(`hard-handoff-root-${Math.random()}`, ctx)
  await ctx.agents.register(root.agent)
  return { ctx, fiber, root }
}

/** Append one successful or failed compaction end to a session. */
function compact(session: Session, error?: string): void {
  session.append('compaction/end', {
    compactionId: CompactionId('k1'),
    turn: 1,
    ...error === undefined ? {} : { error },
  })
}

function findingRequest(title: string) {
  return {
    title,
    bugClass: 'sqli',
    component: 'src/auth/login.ts',
    claim: 'The username parameter reaches string concatenation into the account query.',
    cvssVector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
    cvssClaimed: 9.3,
    pocPath: 'poc/F-1/poc.sh',
    payload: "x' OR 1=1 --",
    claimHash: CLAIM_HASH,
    fingerprint: FINGERPRINT,
  }
}

describe('hard handoff injection', () => {
  it('injects the ledger summary after a successful compaction', async () => {
    const { ctx, root } = await harness()
    ctx.goals.create(root.agent, { objective: 'find the deserialization bug', maxGoalRounds: 9 })
    const finding = ctx.hardLedger.proposeFinding(root.agent, findingRequest('SQL injection in login lookup'))
    compact(root.session)

    expect(root.injected).toHaveLength(1)
    expect(root.inbox.nextStep).toHaveLength(1)
    const text = root.injected[0]
    expect(text).toContain('Context was compacted')
    expect(text).toContain('find the deserialization bug')
    expect(text).toContain(`finding ${finding} awaits verification`)
    expect(text).toContain('Continue the mission with the next concrete action.')
  })

  it('injects nothing for failed compactions, untracked sessions, or unrelated events', async () => {
    const { ctx, root } = await harness()
    const stranger = stubAgent(`hard-handoff-stranger-${Math.random()}`, ctx)
    ctx.goals.create(root.agent, { objective: 'find bugs' })
    compact(root.session, 'summarizer failed')
    root.session.append('compaction/start', { compactionId: CompactionId('k2'), turn: 2 })
    compact(stranger.session)

    expect(root.injected).toEqual([])
    expect(stranger.injected).toEqual([])
  })

  it('renders the no-goal line when the session has no goal', async () => {
    const { root } = await harness()
    compact(root.session)
    expect(root.injected).toHaveLength(1)
    expect(root.injected[0]).toContain('Mission: none current.')
  })

  it('validates config when apply runs outside Loader normalization', () => {
    const ctx = new Context()
    expect(() => { hardHandoff.apply(ctx, {}) }).not.toThrow()
    expect(() => { hardHandoff.apply(ctx, { maxItems: 0 }) }).toThrow('maxItems must be a positive safe integer')
  })

  it('truncates open work past the configured item cap', async () => {
    const { ctx, root } = await harness({ maxItems: 2 })
    ctx.goals.create(root.agent, { objective: 'find bugs' })
    for (let index = 0; index < 4; index++) {
      ctx.hardLedger.proposeFinding(root.agent, findingRequest(`finding ${index}`))
    }
    compact(root.session)
    const text = root.injected[0]
    expect(text).toContain('- finding F-1 awaits verification')
    expect(text).toContain('- finding F-2 awaits verification')
    expect(text).not.toContain('F-3 awaits')
    expect(text).toContain('(+2 more open items not listed)')
  })
})

describe('buildHandoff', () => {
  const emptyInput = {
    goal: undefined,
    findings: [],
    hypotheses: [],
    coverage: [],
    openWork: [],
    maxItems: 32,
  }

  it('counts verdicts, hypotheses, and coverage cells deterministically', () => {
    const text = buildHandoff({
      ...emptyInput,
      findings: [
        { proposed: { ...findingRequest('a'), id: brandString<HardFindingId>('F-1') }, verdict: { id: brandString<HardFindingId>('F-1'), verdict: 'confirmed', runs: 3, cvssComputed: 9.3, cvssMatch: true, reason: 'r', fingerprint: FINGERPRINT } },
        { proposed: { ...findingRequest('b'), id: brandString<HardFindingId>('F-2') }, verdict: { id: brandString<HardFindingId>('F-2'), verdict: 'refuted', runs: 3, cvssComputed: 0, cvssMatch: true, reason: 'r', fingerprint: FINGERPRINT } },
        { proposed: { ...findingRequest('c'), id: brandString<HardFindingId>('F-3') } },
      ],
      hypotheses: [
        { id: brandString<HardHypothesisId>('H-1'), statement: 's', status: 'testing' },
        { id: brandString<HardHypothesisId>('H-2'), statement: 's', status: 'confirmed', reason: 'r' },
      ],
      coverage: [
        { module: 'src/a', bugClass: 'sqli', verdict: 'cleared', declaredSinks: [] },
        { module: 'src/b', bugClass: 'xss', verdict: 'uncovered', declaredSinks: [] },
      ],
    })
    expect(text).toContain('Findings: 3 recorded (1 confirmed, 1 refuted, 1 unverified).')
    expect(text).toContain('Hypotheses: 2 recorded (1 open, 1 resolved).')
    expect(text).toContain('Coverage cells: 2 recorded (1 cleared, 1 uncovered).')
    expect(text).not.toContain('Open work:')
  })

  it('lists open work and bounds item text', () => {
    const long = `hypothesis H-9 is deferred: ${'x'.repeat(400)}`
    const text = buildHandoff({ ...emptyInput, openWork: ['finding F-1 awaits verification', long] })
    expect(text).toContain('- finding F-1 awaits verification')
    expect(text).toContain('…')
    expect(text.length).toBeLessThan(600)
  })
})
