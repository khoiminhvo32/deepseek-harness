/** The four hard tools register, execute through the ledger and verifier, and dispose cleanly. */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import HardVerifier from '@deepseek-ai/dsh-experimental-hard-verifier'
import type { Config as VerifierConfig } from '@deepseek-ai/dsh-experimental-hard-verifier'
import * as hardTools from '@deepseek-ai/dsh-experimental-hard-tools'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const VECTOR = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'
const CLAIM = 'The username parameter reaches concatenation in the login query.'
const CLAIM_HASH = createHash('sha256').update(CLAIM, 'utf8').digest('hex')
const PASS_OUTPUT = `exploit output\nHARD-PASS ${CLAIM_HASH}\n`

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

/** Build one registry-compatible live agent. */
function stubAgent(rawId: string): StubAgent {
  const session = isolatedInboxCtx.sessions.create(SessionId(rawId))
  if (isolatedInboxCtx.sessions.get(session.id) !== session) isolatedInboxCtx.sessions.enter(session)
  const inbox = createInboxStub()
  let status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    get status() { return status },
    ctx: isolatedInboxCtx,
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

interface ScriptedRun {
  readonly exitCode: number | null
  readonly stdoutText: string
}

/** A shell service on the `shell` key replaying one scripted outcome forever. */
class SingleRunShell extends Service {
  constructor(ctx: Context, private readonly scripted: ScriptedRun) {
    super(ctx, 'shell')
  }

  resolve(request: { command: string; timeoutMs?: number }): { command: string; timeoutMs?: number } {
    return { command: request.command, ...request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs } }
  }

  async execute(spec: { command: string; timeoutMs?: number }) {
    void spec
    return {
      result: () => Promise.resolve({
        exitCode: this.scripted.exitCode,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: spec.timeoutMs === undefined ? 0 : spec.timeoutMs,
        stdout: { text: this.scripted.stdoutText, truncated: false },
        stderr: { text: '', truncated: false },
      }),
    }
  }
}

async function harness(scripted: ScriptedRun, verifyConfig: VerifierConfig = { runs: 1 }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(HardLedger, {})
  new SingleRunShell(ctx, scripted)
  await ctx.plugin(HardVerifier, verifyConfig)
  const fiber = await ctx.plugin(hardTools, {})
  const root = stubAgent(`hard-tools-root-${Math.random()}`)
  await ctx.agents.register(root.agent)
  return { ctx, fiber, root }
}

const testSignal = new AbortController().signal

/** Execute one registered tool for the agent. */
async function execute(ctx: Context, name: string, args: unknown, agent: Agent): Promise<ToolExecutionResult> {
  return ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    signal: testSignal,
    callId: ToolCallId(`call-${Math.random()}`),
    name,
    arguments: args,
    agent,
  }))
}

/** Parse the compact JSON of a successful tool result. */
function resultJson(result: ToolExecutionResult): Record<string, unknown> {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected tool success')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected text tool result')
  return JSON.parse(block.text) as Record<string, unknown>
}

describe('hard tools registration', () => {
  it('registers the four tools and disposes them with the fiber', async () => {
    const { ctx, fiber } = await harness({ exitCode: 0, stdoutText: PASS_OUTPUT })
    expect(['hard_submit_finding', 'hard_update_hypothesis', 'hard_mark_coverage', 'hard_sweep_summary']
      .map(name => ctx.tools.get(name)?.name)).toHaveLength(4)
    await fiber.dispose()
    expect(ctx.tools.get('hard_submit_finding')).toBeUndefined()
    expect(ctx.tools.get('hard_sweep_summary')).toBeUndefined()
  })

  it('has the Loader-safe namespace export shape', () => {
    expect('default' in hardTools).toBe(false)
    expect(hardTools.name).toBe('hard-tools')
    expect(hardTools.inject).toEqual(['tools', 'hardLedger', 'hardVerifier'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(hardTools)).toBe(hardTools)
  })
})

describe('hard tools agentless and presentation', () => {
  it('rejects every tool without a live agent', async () => {
    const { ctx } = await harness({ exitCode: 0, stdoutText: PASS_OUTPUT })
    for (const [name, args] of [
      ['hard_submit_finding', { title: 'x', bug_class: 'sqli', component: 'c', claim: 'x', cvss_vector: VECTOR, cvss_score: 9.3, poc_path: 'p' }],
      ['hard_update_hypothesis', { statement: 'x', status: 'proposed' }],
      ['hard_mark_coverage', { module: 'm', bug_class: 'sqli', verdict: 'suspicious', declared_sinks: [] }],
      ['hard_sweep_summary', { phase: 'A', cells_touched: 1, new_findings: 1 }],
    ] as const) {
      const result = await ctx.tools.execute({
        signal: testSignal, callId: ToolCallId(`agentless-${name}`), name, arguments: args,
      })
      expect(result.isError).toBe(true)
    }
  })

  it('renders generic presentation for each tool', async () => {
    const { ctx } = await harness({ exitCode: 0, stdoutText: PASS_OUTPUT })
    expect(ctx.tools.get('hard_submit_finding')?.presentCall?.({
      title: 'x', bug_class: 'sqli', component: 'src/auth', symbol: 'login()', claim: 'x',
      cvss_vector: VECTOR, cvss_score: 9.3, poc_path: 'p',
    })).toMatchObject({ card: 'generic', title: 'Submit finding: src/auth' })
    expect(ctx.tools.get('hard_update_hypothesis')?.presentCall?.({ statement: 'x', status: 'proposed' }))
      .toMatchObject({ title: 'Hypothesis proposed: proposed' })
    expect(ctx.tools.get('hard_update_hypothesis')?.presentCall?.({ hypothesis_id: 'H-1', statement: 'x', status: 'testing' }))
      .toMatchObject({ title: 'Hypothesis H-1: testing' })
    expect(ctx.tools.get('hard_mark_coverage')?.presentCall?.({ module: 'm', bug_class: 'sqli', verdict: 'cleared' }))
      .toMatchObject({ title: 'Coverage m x sqli: cleared' })
    expect(ctx.tools.get('hard_sweep_summary')?.presentCall?.({ phase: 'B', cells_touched: 2, new_findings: 3 }))
      .toMatchObject({ title: 'Sweep B: 3 findings' })
  })
})

describe('hard_submit_finding', () => {
  it('submits, verifies, and returns a confirmed verdict with the recomputed score', async () => {
    const { ctx, root } = await harness({ exitCode: 0, stdoutText: PASS_OUTPUT })
    const result = await execute(ctx, 'hard_submit_finding', {
      title: 'SQL injection in login lookup',
      bug_class: 'sqli',
      component: 'src/auth/login.ts',
      symbol: 'login()',
      claim: CLAIM,
      cvss_vector: VECTOR,
      cvss_score: 9.3,
      poc_path: 'poc/poc.sh',
    }, root.agent)
    const value = resultJson(result)
    expect((value.finding as Record<string, unknown>)['id']).toBe('F-1')
    expect((value.verdict as Record<string, unknown>)).toMatchObject({
      verdict: 'confirmed', runs: 1, cvssComputed: 9.3, cvssMatch: true,
    })
    expect(ctx.hardLedger.findings(root.agent)).toHaveLength(1)
  })

  it('surfaces the duplicate root-cause rejection as a tool error', async () => {
    const { ctx, root } = await harness({ exitCode: 0, stdoutText: PASS_OUTPUT })
    const args = {
      title: 'SQL injection in login lookup',
      bug_class: 'sqli', component: 'src/auth/login.ts', symbol: 'login()',
      claim: CLAIM, cvss_vector: VECTOR, cvss_score: 9.3, poc_path: 'poc/poc.sh',
    }
    await execute(ctx, 'hard_submit_finding', args, root.agent)
    const second = await execute(ctx, 'hard_submit_finding', args, root.agent)
    expect(second.isError).toBe(true)
    expect(second.error?.info?.code).toBe('HARD_VERIFIER_DUPLICATE')
  })

  it('rejects a finding that cites an unknown hypothesis', async () => {
    const { ctx, root } = await harness({ exitCode: 0, stdoutText: PASS_OUTPUT })
    const result = await execute(ctx, 'hard_submit_finding', {
      title: 'x', bug_class: 'sqli', component: 'src/auth/login.ts', claim: CLAIM,
      cvss_vector: VECTOR, cvss_score: 9.3, poc_path: 'poc/poc.sh', hypothesis_id: 'H-9',
    }, root.agent)
    expect(result.isError).toBe(true)
  })
})

describe('hard submit with hypothesis linkage', () => {
  it('links a finding to an existing hypothesis and omits the symbol', async () => {
    const { ctx, root } = await harness({ exitCode: 0, stdoutText: PASS_OUTPUT })
    const proposed = resultJson(await execute(ctx, 'hard_update_hypothesis', {
      statement: 'The refresh endpoint accepts a replayed token in its grace window.',
      status: 'proposed',
    }, root.agent))
    const id = (proposed.hypothesis as Record<string, unknown>)['id']
    const result = await execute(ctx, 'hard_submit_finding', {
      title: 'OAuth state confusion', bug_class: 'oauth-bypass', component: 'src/oauth', claim: CLAIM,
      cvss_vector: VECTOR, cvss_score: 9.3, poc_path: 'poc/poc.sh', hypothesis_id: id,
    }, root.agent)
    const value = resultJson(result)
    expect((value.finding as Record<string, unknown>)['id']).toBe('F-1')
    expect(ctx.hardLedger.findings(root.agent)[0]?.proposed.hypothesisId).toBe(id)
  })

  it('records a phase B sweep', async () => {
    const { ctx, root } = await harness({ exitCode: 0, stdoutText: PASS_OUTPUT })
    const value = resultJson(await execute(ctx, 'hard_sweep_summary', {
      phase: 'B', cells_touched: 2, new_findings: 1,
    }, root.agent))
    expect(value.sweep).toMatchObject({ phase: 'B' })
    expect(ctx.hardLedger.sweepCount(root.agent, 'B')).toBe(1)
  })
})

describe('hard_update_hypothesis and methodology tools', () => {
  it('proposes then transitions a hypothesis by id', async () => {
    const { ctx, root } = await harness({ exitCode: 0, stdoutText: PASS_OUTPUT })
    const proposed = resultJson(await execute(ctx, 'hard_update_hypothesis', {
      statement: 'The refresh endpoint accepts a replayed token in its grace window.',
      status: 'proposed',
    }, root.agent))
    const id = (proposed.hypothesis as Record<string, unknown>)['id']
    expect(id).toBe('H-1')
    const testing = resultJson(await execute(ctx, 'hard_update_hypothesis', {
      hypothesis_id: id, statement: 'same', status: 'testing',
    }, root.agent))
    expect((testing.hypothesis as Record<string, unknown>)['status']).toBe('testing')
    const refuted = await execute(ctx, 'hard_update_hypothesis', {
      hypothesis_id: id, statement: 'same', status: 'refuted',
    }, root.agent)
    expect(refuted.isError).toBe(true)
    const refutedWithReason = resultJson(await execute(ctx, 'hard_update_hypothesis', {
      hypothesis_id: id, statement: 'same', status: 'refuted',
      reason: 'replay returns 401 and the audit event records the reuse',
    }, root.agent))
    expect((refutedWithReason.hypothesis as Record<string, unknown>)['status']).toBe('refuted')
  })

  it('records coverage cells and requires sinks for cleared', async () => {
    const { ctx, root } = await harness({ exitCode: 0, stdoutText: PASS_OUTPUT })
    const missing = await execute(ctx, 'hard_mark_coverage', {
      module: 'src/db', bug_class: 'sqli', verdict: 'cleared', declared_sinks: [],
    }, root.agent)
    expect(missing.isError).toBe(true)
    const cleared = resultJson(await execute(ctx, 'hard_mark_coverage', {
      module: 'src/db', bug_class: 'sqli', verdict: 'cleared',
      declared_sinks: ['src/db/query.ts:42 rawQuery()'],
    }, root.agent))
    expect(cleared.coverage).toMatchObject({ module: 'src/db', verdict: 'cleared' })
    expect(ctx.hardLedger.coverage(root.agent)).toHaveLength(1)
  })

  it('reopens a cleared cell whose cross-check grep finds undeclared sinks', async () => {
    const { ctx, root } = await harness(
      { exitCode: 0, stdoutText: 'src/db/exec.ts:9: exec(userCmd)\n' },
      { runs: 1, coverageSpotCheckPercent: 100 },
    )
    const reopened = resultJson(await execute(ctx, 'hard_mark_coverage', {
      module: 'src/db', bug_class: 'cmdi', verdict: 'cleared',
      declared_sinks: ['src/db/query.ts:42 rawQuery()'],
    }, root.agent))
    expect(reopened.coverage).toMatchObject({ module: 'src/db', verdict: 'suspicious' })
    expect(reopened.reopenedSinks).toEqual(['src/db/exec.ts:9: exec(userCmd)'])
    expect(ctx.hardLedger.coverage(root.agent)).toEqual([
      expect.objectContaining({ verdict: 'suspicious', declaredSinks: ['src/db/exec.ts:9: exec(userCmd)'] }),
    ])
  })

  it('defaults omitted declared_sinks and rejects blank hypothesis ids', async () => {
    const { ctx, root } = await harness({ exitCode: 0, stdoutText: PASS_OUTPUT })
    const omitted = resultJson(await execute(ctx, 'hard_mark_coverage', {
      module: 'src/auth', bug_class: 'authn', verdict: 'suspicious',
    }, root.agent))
    expect(omitted.coverage).toMatchObject({ module: 'src/auth', verdict: 'suspicious' })
    const blank = await execute(ctx, 'hard_submit_finding', {
      title: 'x', bug_class: 'sqli', component: 'c', claim: CLAIM,
      cvss_vector: VECTOR, cvss_score: 9.3, poc_path: 'poc/poc.sh', hypothesis_id: ' ',
    }, root.agent)
    expect(blank.isError).toBe(true)
  })

  it('requires empty-sweep proof when a sweep finds nothing', async () => {
    const { ctx, root } = await harness({ exitCode: 0, stdoutText: PASS_OUTPUT })
    const empty = await execute(ctx, 'hard_sweep_summary', {
      phase: 'A', cells_touched: 3, new_findings: 0,
    }, root.agent)
    expect(empty.isError).toBe(true)
    const proven = resultJson(await execute(ctx, 'hard_sweep_summary', {
      phase: 'A', cells_touched: 3, new_findings: 0,
      empty_proof: 'H-1 refuted with replay evidence',
    }, root.agent))
    expect(proven.sweep).toMatchObject({ phase: 'A', newFindings: 0 })
    expect(ctx.hardLedger.sweepCount(root.agent, 'A')).toBe(1)
  })
})
