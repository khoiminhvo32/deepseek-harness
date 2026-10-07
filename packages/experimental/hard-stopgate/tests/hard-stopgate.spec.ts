/** The stop gate steers an armed active goal's stopping attempts until the per-turn budget is
 * spent, and its completion gate — not the model — decides `update_goal action complete`. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import type { GoalRef } from '@deepseek-ai/dsh-goal'
import GoalService from '@deepseek-ai/dsh-goal'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as toolGoal from '@deepseek-ai/dsh-tool-goal'
import * as hardStopgate from '@deepseek-ai/dsh-experimental-hard-stopgate'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import type { HardMissionArmedData } from '@deepseek-ai/dsh-experimental-hard-ledger'
import { hardStandbyProjectionDefinition } from '@deepseek-ai/dsh-experimental-hard-standby'
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

async function harness(config: hardStopgate.Config = {}, options: { tools?: boolean; ledger?: { emptySweepsToFinish?: number } } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(hardStandbyProjectionDefinition)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  if (options.tools === true) {
    // ToolRuntime injects systemPrompt; booting the real tool-goal plugin keeps the
    // veto test honest about the tool's name and action vocabulary.
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(toolGoal, {})
  }
  await ctx.plugin(HardLedger, options.ledger ?? {})
  const fiber = await ctx.plugin(hardStopgate, config)
  const root = recordingAgent(`hard-stopgate-root-${Math.random()}`, ctx)
  await ctx.agents.register(root.agent)
  return { ctx, fiber, root }
}

/** Open one message-triggered turn with a human message, as the goal tool's authority requires. */
function openTurn(stub: StubAgent, text = 'prompt'): void {
  const turn = stub.session.snapshotEvents()
    .filter(event => event.type === 'turn/start')
    .reduce((max, event) => Math.max(max, event.data.turn), 0) + 1
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  stub.agent.inbox.append('next-turn', message)
  const claimed = stub.inbox.splice('next-turn', 0, 1, [])
  if (claimed.length === 0) throw new Error('expected queued turn input')
  stub.session.append('turn/start', { turn })
  for (const admitted of claimed) {
    stub.session.append('user/message', admitted, { surfaceOp: 'append' })
  }
}

/** Arm the harness goal the gate keys on: a goal plus its ledger arming record. */
function armGoal(
  ctx: Context,
  agent: Agent,
  objective: string,
  matrix: Partial<Pick<HardMissionArmedData, 'modules' | 'unscreenedModules' | 'exclusions'>> = {},
): GoalRef {
  const goal = ctx.goals.create(agent, { objective, maxGoalRounds: 9 })
  ctx.hardLedger.recordMissionArmed(agent, {
    objective,
    targetRepo: '/tmp/hard-target',
    commit: 'a'.repeat(40),
    modules: ['src'],
    bugClasses: ['cmdi'],
    goalId: goal.id,
    ...matrix,
  })
  return { id: goal.id, revision: goal.revision }
}

/** Fire one turn-stopping observation for the agent. */
async function stopAt(ctx: Context, agent: Agent, turn: number): Promise<void> {
  await agentEvents(ctx, agent).serial('agent/turn-stopping', {
    turn,
    signal: new AbortController().signal,
  })
}

const testSignal = new AbortController().signal

/** Execute one registered tool under the agent's initiator, inside an open turn. */
async function execute(ctx: Context, name: string, args: unknown, agent: Agent): Promise<ToolExecutionResult> {
  return ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    signal: testSignal,
    callId: ToolCallId(`hard-stopgate-call-${Math.random()}`),
    name,
    arguments: args,
    agent,
  }))
}

describe('hard stopgate', () => {
  it('steers an armed active goal back to work at the boundary, naming the open work', async () => {
    const { ctx, root } = await harness()
    armGoal(ctx, root.agent, 'find the deserialization bug')
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(1)
    expect(root.steered[0]).toContain('The session objective is not complete: "find the deserialization bug".')
    expect(root.steered[0]).toContain('Goal round 0 of 9')
    expect(root.steered[0]).toContain('Open work: 1 coverage cell(s) have no verdict yet')
    expect(root.steered[0]).toContain('cell src × cmdi has no verdict')
    expect(root.steered[0]).toContain('update_goal action complete')
  })

  it('does not steer when no open work stands — completion is the gate\'s call', async () => {
    const { ctx, root } = await harness()
    // The armed matrix is small and the module screens inert, so the harness
    // pre-verdicts the only cell: nothing open, no steering order to give.
    const goal = ctx.goals.create(root.agent, { objective: 'find bugs', maxGoalRounds: 9 })
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'find bugs',
      targetRepo: '/tmp/hard-target',
      commit: 'a'.repeat(40),
      modules: ['notes'],
      bugClasses: ['cmdi'],
      inertModules: ['notes'],
      goalId: goal.id,
    })
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(0)
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

  it('lets the turn close while a standby wait is pending and steers again once it lapses', async () => {
    const { ctx, root } = await harness()
    armGoal(ctx, root.agent, 'find bugs')
    root.session.append('hard/standby/scheduled', {
      reason: 'quota',
      wakeAt: Date.now() + 600_000,
      providerCode: 'QUOTA',
    })
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(0)

    root.session.append('hard/standby/woke', { at: Date.now(), delivered: false, skip: 'goal phase paused' })
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(1)
  })

  it('lets paused, blocked, and completed phases close freely', async () => {
    const { ctx, root } = await harness()
    armGoal(ctx, root.agent, 'state tour')
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
    armGoal(ctx, root.agent, 'persist')
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
    armGoal(ctx, root.agent, 'counter reset')
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(1)
    agentEvents(ctx, root.agent).emit('agent/disposed', {})
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(2)
  })

  it('stops steering after disposal', async () => {
    const { ctx, fiber, root } = await harness()
    armGoal(ctx, root.agent, 'disposed work')
    await fiber.dispose()
    await stopAt(ctx, root.agent, 1)
    expect(root.steered).toHaveLength(0)
  })
})

describe('hard stopgate completion gate', () => {
  it('denies an early complete through the real update_goal tool, naming the remaining work', async () => {
    const { ctx, root } = await harness({}, { tools: true })
    const ref = armGoal(ctx, root.agent, 'find the deserialization bug')
    openTurn(root)
    const denied = await execute(ctx, 'update_goal', {
      goal_id: ref.id, revision: ref.revision, action: 'complete',
    }, root.agent)
    expect(denied.isError).toBe(true)
    expect(denied.error?.message).toContain('The mission is not complete.')
    expect(denied.error?.message).toContain('cell src × cmdi has no verdict')
    expect(denied.error?.message).toContain('Resolve these, then mark the goal complete.')
    // The durable decision record sits in the log, keyed to the armed goal.
    const decisions = root.session.snapshotEvents().filter(event => event.type === 'hard/gate/decision')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.data).toMatchObject({
      decision: 'deny',
      openWorkCount: 2,
      coverage: { verdicted: 0, total: 1, bySource: { model: 0, modelVerified: 0, harness: 0 } },
      hypotheses: { resolved: 0, open: 0 },
      findings: { confirmed: 0, refuted: 0, flaky: 0, pending: 0 },
      emptySweeps: 0,
      blockers: [
        '1 coverage cell(s) have no verdict yet',
        'cell src × cmdi has no verdict',
        '0 of 2 final sweeps are empty-verified',
        'no model-audited coverage cell or resolved hypothesis exists yet',
      ],
    })
  })

  it('allows complete once the ledger certifies, and records the allow', async () => {
    const { ctx, root } = await harness({}, { tools: true, ledger: { emptySweepsToFinish: 1 } })
    armGoal(ctx, root.agent, 'find bugs')
    ctx.hardLedger.markCoverage(root.agent, {
      module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['src/exec.ts:1 system()'],
    })
    const id = ctx.hardLedger.writeHypothesis(root.agent, { statement: 'the parser is pure', status: 'proposed' })
    ctx.hardLedger.writeHypothesis(root.agent, {
      id, statement: 'the parser is pure', status: 'refuted', reason: 'it coerces input',
    })
    ctx.hardLedger.recordSweep(root.agent, {
      phase: 'A', cellsTouched: 1, newFindings: 0, emptyProofRef: { kind: 'cell', module: 'src', bugClass: 'cmdi' },
    })
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected live goal')
    openTurn(root)
    const allowed = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(allowed.isError).toBe(false)
    const decisions = root.session.snapshotEvents().filter(event => event.type === 'hard/gate/decision')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.data).toMatchObject({
      decision: 'allow',
      openWorkCount: 0,
      emptySweeps: 1,
      blockers: [],
    })
  })

  it('records blind clears and the configured exclusion count beside the coverage ratio', async () => {
    const { ctx, root } = await harness({}, { tools: true })
    const ref = armGoal(ctx, root.agent, 'find bugs', {
      modules: ['src', 'wp'],
      unscreenedModules: ['wp'],
      exclusions: { globs: ['vendor/**'], fileCount: 3, sample: ['vendor/a.php', 'vendor/b.php', 'vendor/c.php'] },
    })
    ctx.hardLedger.markCoverage(root.agent, {
      module: 'wp', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['wp/ajax.php:my_delete_item'],
    })
    openTurn(root)
    await execute(ctx, 'update_goal', { goal_id: ref.id, revision: ref.revision, action: 'complete' }, root.agent)
    const decisions = root.session.snapshotEvents().filter(event => event.type === 'hard/gate/decision')
    expect(decisions[0]?.data).toMatchObject({
      decision: 'deny',
      coverage: { verdicted: 1, total: 2, blindClears: 1, excludedFileCount: 3 },
    })
    // Without exclusions the count is absent, not zero: nothing was left out.
    const plain = await harness({}, { tools: true })
    const plainRef = armGoal(plain.ctx, plain.root.agent, 'find bugs')
    openTurn(plain.root)
    await execute(plain.ctx, 'update_goal', { goal_id: plainRef.id, revision: plainRef.revision, action: 'complete' }, plain.root.agent)
    const plainDecision = plain.root.session.snapshotEvents().find(event => event.type === 'hard/gate/decision')
    expect(plainDecision?.data).toMatchObject({ coverage: { blindClears: 0 } })
    expect((plainDecision?.data as { coverage: Record<string, unknown> }).coverage).not.toHaveProperty('excludedFileCount')
  })

  it('denies again when the gate still blocks after a first attempt', async () => {
    const { ctx, root } = await harness({}, { tools: true, ledger: { emptySweepsToFinish: 1 } })
    armGoal(ctx, root.agent, 'find bugs')
    ctx.hardLedger.markCoverage(root.agent, {
      module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['src/exec.ts:1 system()'],
    })
    const id = ctx.hardLedger.writeHypothesis(root.agent, { statement: 'the parser is pure', status: 'proposed' })
    ctx.hardLedger.writeHypothesis(root.agent, {
      id, statement: 'the parser is pure', status: 'refuted', reason: 'it coerces input',
    })
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected live goal')
    openTurn(root)
    const denied = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(denied.isError).toBe(true)
    expect(denied.error?.message).toContain('0 of 1 final sweeps are empty-verified')
    const decisions = root.session.snapshotEvents().filter(event => event.type === 'hard/gate/decision')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.data).toMatchObject({ decision: 'deny', emptySweeps: 0 })
  })

  it('does not gate non-complete actions, foreign goals, or unattributed armings', async () => {
    const { ctx, root } = await harness({}, { tools: true })
    const ref = armGoal(ctx, root.agent, 'find bugs')
    openTurn(root)
    // An edit on the armed goal runs the tool body — only action complete is gated.
    const edited = await execute(ctx, 'update_goal', {
      goal_id: ref.id, revision: ref.revision, action: 'edit', objective: 'find bugs, edited',
    }, root.agent)
    expect(edited.isError).toBe(false)

    // An arming record without the goal id predates attribution and never gates.
    const unattributedRoot = recordingAgent(`hard-stopgate-legacy-${Math.random()}`, ctx)
    await ctx.agents.register(unattributedRoot.agent)
    ctx.goals.create(unattributedRoot.agent, { objective: 'legacy mission' })
    ctx.hardLedger.recordMissionArmed(unattributedRoot.agent, {
      objective: 'legacy mission', targetRepo: '/tmp/hard-target', commit: 'a'.repeat(40),
      modules: ['src'], bugClasses: ['cmdi'],
    })
    const legacyGoal = ctx.goals.get(unattributedRoot.agent)
    if (legacyGoal === undefined) throw new Error('expected live goal')
    openTurn(unattributedRoot)
    const legacyComplete = await execute(ctx, 'update_goal', {
      goal_id: legacyGoal.id, revision: legacyGoal.revision, action: 'complete',
    }, unattributedRoot.agent)
    expect(legacyComplete.isError).toBe(false)

    // A mismatched goalId names a goal the service never created: the veto
    // passes the call through because the armed goal is not the caller's.
    const mismatchedRoot = recordingAgent(`hard-stopgate-mismatch-${Math.random()}`, ctx)
    await ctx.agents.register(mismatchedRoot.agent)
    const mismatchedGoal = ctx.goals.create(mismatchedRoot.agent, { objective: 'mismatched attribution' })
    ctx.hardLedger.recordMissionArmed(mismatchedRoot.agent, {
      objective: 'mismatched attribution', targetRepo: '/tmp/hard-target', commit: 'a'.repeat(40),
      modules: ['src'], bugClasses: ['cmdi'],
      goalId: 'goal-00000000-0000-0000-0000-000000000000',
    })
    openTurn(mismatchedRoot)
    const mismatchedComplete = await execute(ctx, 'update_goal', {
      goal_id: mismatchedGoal.id, revision: mismatchedGoal.revision, action: 'complete',
    }, mismatchedRoot.agent)
    expect(mismatchedComplete.isError).toBe(false)
  })
})

describe('hard stopgate config and namespace', () => {
  it('rejects an invalid direct-apply budget before registering anything', () => {
    const ctx = new Context()
    expect(() => { hardStopgate.apply(ctx, { maxSteersPerTurn: 0 }) })
      .toThrow('maxSteersPerTurn must be a positive safe integer')
  })

  it('reads the empty-sweep threshold from the ledger, not the gate', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(GoalService)
    await expect(ctx.plugin(HardLedger, { emptySweepsToFinish: 17 }))
      .rejects.toThrow('expected number <= 16 but got 17')
    await ctx.plugin(HardLedger, {})
    expect(() => { hardStopgate.apply(ctx, {}) }).not.toThrow()
  })

  it('uses the default budget on direct apply', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(GoalService)
    await ctx.plugin(HardLedger, {})
    hardStopgate.apply(ctx, {})
    const root = recordingAgent('hard-stopgate-defaults', ctx)
    await ctx.agents.register(root.agent)
    armGoal(ctx, root.agent, 'default budget')
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
    expect(hardStopgate.inject).toEqual(['goals', 'sessionProjections', 'hardLedger'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(hardStopgate)).toBe(hardStopgate)
  })
})
