/** The hard tools register, execute through the ledger and verifier, and dispose cleanly. */

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
  readonly stderrText?: string
  readonly timedOut?: boolean
}

/** A shell service on the `shell` key cycling a script of outcomes in call order. */
class SingleRunShell extends Service {
  private readonly calls: { command: string; timeoutMs?: number }[] = []

  constructor(ctx: Context, private readonly script: readonly ScriptedRun[]) {
    super(ctx, 'shell')
  }

  resolve(request: { command: string; timeoutMs?: number }): { command: string; timeoutMs?: number } {
    return { command: request.command, ...request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs } }
  }

  async execute(spec: { command: string; timeoutMs?: number }) {
    void spec
    this.calls.push({ command: spec.command, ...spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs } })
    const scripted = this.script[(this.calls.length - 1) % this.script.length] as ScriptedRun
    return {
      result: () => Promise.resolve({
        exitCode: scripted.exitCode,
        signal: null,
        timedOut: scripted.timedOut ?? false,
        aborted: false,
        timeoutMs: spec.timeoutMs === undefined ? 0 : spec.timeoutMs,
        stdout: { text: scripted.stdoutText, truncated: false },
        stderr: { text: scripted.stderrText ?? '', truncated: false },
      }),
    }
  }
}

/** The two outcomes one honest submit takes: the benign arm fails, the exploit arm satisfies. */
const SUBMIT_SCRIPT = (pass: string): ScriptedRun[] => [
  { exitCode: 1, stdoutText: '', stderrText: '' },
  { exitCode: 0, stdoutText: pass },
]

async function harness(scripted: ScriptedRun | readonly ScriptedRun[], verifyConfig: VerifierConfig = { runs: 1 }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(HardLedger, {})
  new SingleRunShell(ctx, Array.isArray(scripted) ? scripted : [scripted])
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
  it('registers the six tools and disposes them with the fiber', async () => {
    const { ctx, fiber } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    expect(['hard_submit_finding', 'hard_update_hypothesis', 'hard_record_flow', 'hard_mark_coverage', 'hard_sweep_summary', 'hard_clear_modules']
      .map(name => ctx.tools.get(name)?.name)).toHaveLength(6)
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
    const { ctx } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    for (const [name, args] of [
      ['hard_submit_finding', { title: 'x', bug_class: 'sqli', component: 'c', claim: 'x', cvss_vector: VECTOR, cvss_score: 9.3, poc_path: 'p', payload: "x' OR 1=1 --" }],
      ['hard_update_hypothesis', { statement: 'x', status: 'proposed' }],
      ['hard_mark_coverage', { module: 'm', bug_class: 'sqli', verdict: 'suspicious', declared_sinks: [] }],
      ['hard_record_flow', { module: 'm', entry_points: [], dataflows: [], trust_boundaries: [], state_machines: [], assumptions: [], quirks: [] }],
      ['hard_sweep_summary', { phase: 'A', cells_touched: 1, new_findings: 1 }],
    ] as const) {
      const result = await ctx.tools.execute({
        signal: testSignal, callId: ToolCallId(`agentless-${name}`), name, arguments: args,
      })
      expect(result.isError).toBe(true)
    }
  })

  it('renders generic presentation for each tool', async () => {
    const { ctx } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    expect(ctx.tools.get('hard_submit_finding')?.presentCall?.({
      title: 'x', bug_class: 'sqli', component: 'src/auth', symbol: 'login()', claim: 'x',
      cvss_vector: VECTOR, cvss_score: 9.3, poc_path: 'p', payload: "x' OR 1=1 --",
    })).toMatchObject({ card: 'generic', title: 'Submit finding: src/auth' })
    expect(ctx.tools.get('hard_update_hypothesis')?.presentCall?.({ statement: 'x', status: 'proposed' }))
      .toMatchObject({ title: 'Hypothesis proposed: proposed' })
    expect(ctx.tools.get('hard_update_hypothesis')?.presentCall?.({ hypothesis_id: 'H-1', statement: 'x', status: 'testing' }))
      .toMatchObject({ title: 'Hypothesis H-1: testing' })
    expect(ctx.tools.get('hard_mark_coverage')?.presentCall?.({ module: 'm', bug_class: 'sqli', verdict: 'cleared' }))
      .toMatchObject({ title: 'Coverage m x sqli: cleared' })
    expect(ctx.tools.get('hard_record_flow')?.presentCall?.({
      module: 'm', entry_points: [{ cite: 'a:1', snippet: 's', note: 'n' }], dataflows: [], trust_boundaries: [],
      state_machines: [], assumptions: [], quirks: [],
    })).toMatchObject({ title: 'Flow doc m: 1 citations' })
    expect(ctx.tools.get('hard_sweep_summary')?.presentCall?.({ phase: 'B', cells_touched: 2, new_findings: 3 }))
      .toMatchObject({ title: 'Sweep B: 3 findings' })
  })
})

describe('hard_submit_finding', () => {
  it('submits, verifies, and returns a confirmed verdict with the recomputed score', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    const result = await execute(ctx, 'hard_submit_finding', {
      title: 'SQL injection in login lookup',
      bug_class: 'sqli',
      component: 'src/auth/login.ts',
      symbol: 'login()',
      claim: CLAIM,
      cvss_vector: VECTOR,
      cvss_score: 9.3,
      poc_path: 'poc/poc.sh',
      payload: "x' OR 1=1 --",
    }, root.agent)
    const value = resultJson(result)
    expect((value.finding as Record<string, unknown>)['id']).toBe('F-1')
    expect((value.verdict as Record<string, unknown>)).toMatchObject({
      verdict: 'confirmed', runs: 1, cvssComputed: 9.3, cvssMatch: true,
    })
    expect(ctx.hardLedger.findings(root.agent)).toHaveLength(1)
  })

  it('refutes a payload-agnostic PoC through the benign arm and names the specificity check', async () => {
    const { ctx, root } = await harness([{ exitCode: 0, stdoutText: PASS_OUTPUT }])
    const result = resultJson(await execute(ctx, 'hard_submit_finding', {
      title: 'x', bug_class: 'sqli', component: 'src/auth/login.ts', claim: CLAIM,
      cvss_vector: VECTOR, cvss_score: 9.3, poc_path: 'poc/poc.sh', payload: "x' OR 1=1 --",
    }, root.agent))
    expect((result.verdict as Record<string, unknown>)).toMatchObject({
      verdict: 'refuted', runs: 0,
      reason: 'the proof passes with a benign payload, so it does not depend on the exploit input',
    })
    expect(ctx.hardLedger.findings(root.agent)[0]?.verdict).toMatchObject({
      benignArm: 'passed', cause: 'benign-arm-passed',
    })
  })

  it('surfaces the duplicate root-cause rejection as a tool error', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    const args = {
      title: 'SQL injection in login lookup',
      bug_class: 'sqli', component: 'src/auth/login.ts', symbol: 'login()',
      claim: CLAIM, cvss_vector: VECTOR, cvss_score: 9.3, poc_path: 'poc/poc.sh', payload: "x' OR 1=1 --",
    }
    await execute(ctx, 'hard_submit_finding', args, root.agent)
    const second = await execute(ctx, 'hard_submit_finding', args, root.agent)
    expect(second.isError).toBe(true)
    expect(second.error?.info?.code).toBe('HARD_VERIFIER_DUPLICATE')
  })

  it('rejects a finding that cites an unknown hypothesis', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    const result = await execute(ctx, 'hard_submit_finding', {
      title: 'x', bug_class: 'sqli', component: 'src/auth/login.ts', claim: CLAIM,
      cvss_vector: VECTOR, cvss_score: 9.3, poc_path: 'poc/poc.sh', payload: "x' OR 1=1 --", hypothesis_id: 'H-9',
    }, root.agent)
    expect(result.isError).toBe(true)
  })
})

describe('hard submit with hypothesis linkage', () => {
  it('links a finding to an existing hypothesis and omits the symbol', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    const proposed = resultJson(await execute(ctx, 'hard_update_hypothesis', {
      statement: 'The refresh endpoint accepts a replayed token in its grace window.',
      status: 'proposed',
    }, root.agent))
    const id = (proposed.hypothesis as Record<string, unknown>)['id']
    const result = await execute(ctx, 'hard_submit_finding', {
      title: 'OAuth state confusion', bug_class: 'oauth-bypass', component: 'src/oauth', claim: CLAIM,
      cvss_vector: VECTOR, cvss_score: 9.3, poc_path: 'poc/poc.sh', payload: 'replay:token-9', hypothesis_id: id,
    }, root.agent)
    const value = resultJson(result)
    expect((value.finding as Record<string, unknown>)['id']).toBe('F-1')
    expect(ctx.hardLedger.findings(root.agent)[0]?.proposed.hypothesisId).toBe(id)
  })

  it('records a phase B sweep', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    const value = resultJson(await execute(ctx, 'hard_sweep_summary', {
      phase: 'B', cells_touched: 2, new_findings: 1,
    }, root.agent))
    expect(value.sweep).toMatchObject({ phase: 'B' })
    expect(ctx.hardLedger.sweepCount(root.agent, 'B')).toBe(1)
  })
})

describe('hard_update_hypothesis and methodology tools', () => {
  it('proposes then transitions a hypothesis by id', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
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
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
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
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'a'.repeat(40),
      modules: ['src/db'],
      bugClasses: ['cmdi'],
    })
    const reopened = resultJson(await execute(ctx, 'hard_mark_coverage', {
      module: 'src/db', bug_class: 'cmdi', verdict: 'cleared',
      declared_sinks: ['src/db/query.ts:42 rawQuery()'],
    }, root.agent))
    expect(reopened.coverage).toMatchObject({ module: 'src/db', verdict: 'suspicious' })
    expect(reopened.reopenedSinks).toEqual(['src/db/exec.ts:9: exec(userCmd)'])
    expect(ctx.hardLedger.coverage(root.agent)).toEqual([
      expect.objectContaining({ verdict: 'suspicious', declaredSinks: ['src/db/exec.ts:9: exec(userCmd)'], source: 'harness' }),
    ])
  })

  it('marks the cell suspicious and fails the tool call when the cross-check grep errors', async () => {
    const { ctx, root } = await harness(
      { exitCode: 2, stdoutText: '' },
      { runs: 1, coverageSpotCheckPercent: 100 },
    )
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'a'.repeat(40),
      modules: ['src/db'],
      bugClasses: ['cmdi'],
    })
    const failed = await execute(ctx, 'hard_mark_coverage', {
      module: 'src/db', bug_class: 'cmdi', verdict: 'cleared',
      declared_sinks: ['src/db/query.ts:42 rawQuery()'],
    }, root.agent)
    expect(failed.isError).toBe(true)
    expect(failed.error?.info?.code).toBe('HARD_VERIFIER_AUDIT_FAILED')
    // The just-marked clearance did not stand: the durable cell reads
    // suspicious, attributed to the harness that decided it.
    expect(ctx.hardLedger.coverage(root.agent)).toEqual([
      expect.objectContaining({ verdict: 'suspicious', declaredSinks: [], source: 'harness' }),
    ])
  })

  it('batch-clears modules the harness grep proves clean, as model-verified', async () => {
    const { ctx, root } = await harness({ exitCode: 1, stdoutText: '' })
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'a'.repeat(40),
      modules: ['src/auth', 'src/db'],
      bugClasses: ['cmdi', 'sqli'],
    })
    const cleared = resultJson(await execute(ctx, 'hard_clear_modules', {
      modules: ['src/auth', 'src/db'],
      bug_class: 'sqli',
      patterns: ['SELECT[^\\n]*\\+'],
      rationale: 'No SQL statement is built in this repository.',
    }, root.agent))
    expect(cleared.cleared).toBe(2)
    expect(cleared.clearedCells).toEqual([
      { module: 'src/auth', bugClass: 'sqli' },
      { module: 'src/db', bugClass: 'sqli' },
    ])
    expect(ctx.hardLedger.coverageBySource(root.agent)).toEqual({ model: 0, modelVerified: 2, harness: 0 })
    const cell = ctx.hardLedger.coverage(root.agent)[0]
    expect(cell).toMatchObject({ verdict: 'cleared', source: 'model-verified' })
  })

  it('clears nothing and returns evidence when a module still matches', async () => {
    const { ctx, root } = await harness({ exitCode: 0, stdoutText: 'src/db/query.ts:42: rawQuery("s" + user)\n' })
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'a'.repeat(40),
      modules: ['src/auth', 'src/db'],
      bugClasses: ['sqli'],
    })
    const cleared = resultJson(await execute(ctx, 'hard_clear_modules', {
      modules: ['src/auth', 'src/db'],
      bug_class: 'sqli',
      patterns: ['SELECT[^\\n]*\\+'],
      rationale: 'No SQL statement is built in this repository.',
    }, root.agent))
    expect(cleared.cleared).toBe(0)
    expect(cleared.evidence).toEqual(['src/db/query.ts:42: rawQuery("s" + user)'])
    expect(ctx.hardLedger.coverage(root.agent)).toEqual([])
  })

  it('batch-clears guarded-surface classes when the module exports nothing, and refuses login-bypass', async () => {
    // The guarded-surface grep names exported operations: zero matches prove
    // the module exposes no operation for these classes to guard.
    const { ctx, root } = await harness({ exitCode: 1, stdoutText: '' })
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'a'.repeat(40),
      modules: ['src'],
      bugClasses: ['authz', 'login-bypass', 'sqli'],
    })
    const guarded = resultJson(await execute(ctx, 'hard_clear_modules', {
      modules: ['src'], bug_class: 'authz', patterns: ['checkPermission'], rationale: 'r',
    }, root.agent))
    expect(guarded.cleared).toBe(1)
    const refused = await execute(ctx, 'hard_clear_modules', {
      modules: ['src'], bug_class: 'login-bypass', patterns: ['login'], rationale: 'r',
    }, root.agent)
    expect(refused.isError).toBe(true)
    expect(refused.content[0]).toMatchObject({ type: 'text' })
    const text = (refused.content[0] as { type: string; text: string }).text
    expect(text).toContain('protective checks')
    const unknown = await execute(ctx, 'hard_clear_modules', {
      modules: ['src', 'nope'], bug_class: 'sqli', patterns: ['SELECT'], rationale: 'r',
    }, root.agent)
    expect(unknown.isError).toBe(true)
    expect((unknown.content[0] as { type: string; text: string }).text)
      .toContain('module "nope" is not in the armed coverage matrix; the matrix rows at commit')
    // The whole batch was refused before any cell was cleared.
    expect(ctx.hardLedger.coverage(root.agent)).toHaveLength(1)
  })

  it('refuses a coverage cell outside the armed matrix, naming the valid rows', async () => {    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'a'.repeat(40),
      modules: ['src/db'],
      bugClasses: ['cmdi'],
    })
    const refused = await execute(ctx, 'hard_mark_coverage', {
      module: 'poc', bug_class: 'cmdi', verdict: 'cleared', declared_sinks: ['execSync'],
    }, root.agent)
    expect(refused.isError).toBe(true)
    expect((refused.content[0] as { type: string; text: string }).text)
      .toContain('module "poc" is not in the armed coverage matrix; the matrix rows at commit')
    expect((refused.content[0] as { type: string; text: string }).text).toContain('are: src/db')
    // Without an armed matrix every module passes — the merge-extensible default.
    const bare = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    const unArmed = resultJson(await execute(bare.ctx, 'hard_mark_coverage', {
      module: 'poc', bug_class: 'cmdi', verdict: 'suspicious', declared_sinks: [],
    }, bare.root.agent))
    expect(unArmed.coverage).toMatchObject({ module: 'poc', verdict: 'suspicious' })
  })

  it('refuses a batch that contains an inert module before any grep runs', async () => {
    const { ctx, root } = await harness({ exitCode: 1, stdoutText: '' })
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'a'.repeat(40),
      modules: ['data/manuals', 'src'],
      bugClasses: ['sqli'],
      inertModules: ['data/manuals'],
    })
    const refused = await execute(ctx, 'hard_clear_modules', {
      modules: ['data/manuals', 'src'], bug_class: 'sqli', patterns: ['SELECT'], rationale: 'r',
    }, root.agent)
    expect(refused.isError).toBe(true)
    expect((refused.content[0] as { type: string; text: string }).text)
      .toContain('module "data/manuals" is inert — the harness already screened it as containing no code')
    // The whole batch was refused before any cell was cleared.
    expect(ctx.hardLedger.coverage(root.agent)).toEqual([])
  })

  it('defaults omitted declared_sinks and rejects blank hypothesis ids', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    const omitted = resultJson(await execute(ctx, 'hard_mark_coverage', {
      module: 'src/auth', bug_class: 'authn', verdict: 'suspicious',
    }, root.agent))
    expect(omitted.coverage).toMatchObject({ module: 'src/auth', verdict: 'suspicious' })
    const blank = await execute(ctx, 'hard_submit_finding', {
      title: 'x', bug_class: 'sqli', component: 'c', claim: CLAIM,
      cvss_vector: VECTOR, cvss_score: 9.3, poc_path: 'poc/poc.sh', payload: 'x', hypothesis_id: ' ',
    }, root.agent)
    expect(blank.isError).toBe(true)
  })

  it('requires empty-sweep proof when a sweep finds nothing', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    const empty = await execute(ctx, 'hard_sweep_summary', {
      phase: 'A', cells_touched: 3, new_findings: 0,
    }, root.agent)
    expect(empty.isError).toBe(true)
    // A half-specified proof fails loud before the ledger rejects the referent.
    const half = await execute(ctx, 'hard_sweep_summary', {
      phase: 'A', cells_touched: 3, new_findings: 0, empty_proof_kind: 'cell',
    }, root.agent)
    expect(half.isError).toBe(true)
    expect(half.error?.message).toContain('empty_proof_kind cell requires a non-empty empty_proof_module')
    const id = resultJson(await execute(ctx, 'hard_update_hypothesis', {
      statement: 'the report builder accepts raw arguments.',
      status: 'proposed',
    }, root.agent)).hypothesis as Record<string, unknown>
    const testing = await execute(ctx, 'hard_update_hypothesis', {
      hypothesis_id: id['id'], statement: 'the report builder accepts raw arguments.', status: 'testing',
    }, root.agent)
    expect(testing.isError).toBe(false)
    // A sweep whose proof cites an unresolved hypothesis is refused.
    const unresolved = await execute(ctx, 'hard_sweep_summary', {
      phase: 'A', cells_touched: 3, new_findings: 0, empty_proof_kind: 'hypothesis', empty_proof_id: id['id'],
    }, root.agent)
    expect(unresolved.isError).toBe(true)
    const refuted = resultJson(await execute(ctx, 'hard_update_hypothesis', {
      hypothesis_id: id['id'], statement: 'the report builder accepts raw arguments.', status: 'refuted',
      reason: 'the builder interpolates after validation',
    }, root.agent)).hypothesis as Record<string, unknown>
    expect(refuted['status']).toBe('refuted')
    const proven = resultJson(await execute(ctx, 'hard_sweep_summary', {
      phase: 'A', cells_touched: 3, new_findings: 0,
      empty_proof_kind: 'hypothesis', empty_proof_id: id['id'],
    }, root.agent))
    expect(proven.sweep).toMatchObject({
      phase: 'A', newFindings: 0, emptyProofRef: { kind: 'hypothesis', hypothesisId: id['id'] },
    })
    expect(ctx.hardLedger.sweepCount(root.agent, 'A')).toBe(1)
    // A sweep with findings must not carry an empty proof.
    const withFindings = await execute(ctx, 'hard_sweep_summary', {
      phase: 'B', cells_touched: 1, new_findings: 1, empty_proof_kind: 'hypothesis', empty_proof_id: id['id'],
    }, root.agent)
    expect(withFindings.isError).toBe(true)
  })

  it('cites a cleared cell as an empty-sweep proof and refuses a harness-screened one', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    ctx.hardLedger.markCoverage(root.agent, {
      module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['src/exec.ts:1 system()'],
    })
    const proven = resultJson(await execute(ctx, 'hard_sweep_summary', {
      phase: 'A', cells_touched: 1, new_findings: 0,
      empty_proof_kind: 'cell', empty_proof_module: 'src', empty_proof_bug_class: 'cmdi',
    }, root.agent))
    expect(proven.sweep).toMatchObject({
      emptyProofRef: { kind: 'cell', module: 'src', bugClass: 'cmdi' },
    })
    ctx.hardLedger.markCoverage(root.agent, {
      module: 'notes', bugClass: 'sqli', verdict: 'cleared', declaredSinks: ['rawQuery'], source: 'harness',
    })
    const screened = await execute(ctx, 'hard_sweep_summary', {
      phase: 'B', cells_touched: 1, new_findings: 0,
      empty_proof_kind: 'cell', empty_proof_module: 'notes', empty_proof_bug_class: 'sqli',
    }, root.agent)
    expect(screened.isError).toBe(true)
    expect(screened.error?.message).toContain('empty sweep proof cannot cite a harness-screened cell')
  })

  it('cites a recorded flow document as an empty-sweep proof and refuses a citation-free one', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    ctx.hardLedger.recordFlowDoc(root.agent, {
      module: 'src/web',
      sections: { entryPoints: 1, dataflows: 0, trustBoundaries: 0, stateMachines: 0, assumptions: 0, quirks: 0 },
      citations: 1,
    })
    const proven = resultJson(await execute(ctx, 'hard_sweep_summary', {
      phase: 'B', cells_touched: 1, new_findings: 0, empty_proof_kind: 'flow', empty_proof_module: 'src/web',
    }, root.agent))
    expect(proven.sweep).toMatchObject({ emptyProofFlowDoc: 'src/web' })
    const halfSpecified = await execute(ctx, 'hard_sweep_summary', {
      phase: 'B', cells_touched: 1, new_findings: 0, empty_proof_kind: 'flow',
      empty_proof_module: 'src/web', empty_proof_bug_class: 'cmdi',
    }, root.agent)
    expect(halfSpecified.isError).toBe(true)
    expect(halfSpecified.error?.message).toContain('empty_proof_bug_class is valid only with empty_proof_kind cell')
  })
})

describe('hard_record_flow', () => {
  const RENDER_LINES = [
    '\'use strict\'',
    '',
    "const { execSync } = require('node:child_process')",
    '',
    'function renderPage(slug) {',
    "  const fragment = 'pages/' + slug + '.html'",
    "  return execSync('wc -c ' + fragment, { encoding: 'utf8' }).trim()",
    '}',
    '',
    'module.exports = { renderPage }',
  ]
  const RENDER_LINES_ARRAY = RENDER_LINES

  function renderShow(startLine: number, endLine: number): ScriptedRun {
    const slice = RENDER_LINES_ARRAY.slice(startLine - 1, endLine)
    return { exitCode: 0, stdoutText: slice.length === 0 ? '' : slice.join('\n') + '\n' }
  }

  function flowArgs(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      module: 'src/web',
      entry_points: [{ cite: 'src/web/render.js:5', snippet: 'function renderPage', note: 'the one module entry point' }],
      dataflows: [{ cite: 'src/web/render.js:7', snippet: 'execSync', note: 'fragment reaches wc' }],
      trust_boundaries: [],
      state_machines: [],
      assumptions: [],
      quirks: [{ cite: 'src/web/render.js:7', snippet: 'execSync', note: 'unquoted shell build' }],
      ...overrides,
    }
  }

  it('resolves citations at the pinned commit, opens quirk hypotheses, and records the flow doc', async () => {
    const { ctx, root } = await harness([
      // One ls-tree per unique path, then one piped git-show read per cite.
      { exitCode: 0, stdoutText: 'src/web/render.js\n' },
      renderShow(5, 5),
      renderShow(7, 7),
      renderShow(7, 7),
    ])
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target', commit: 'a'.repeat(40),
      modules: ['src/web'], bugClasses: ['cmdi'],
    })
    const result = resultJson(await execute(ctx, 'hard_record_flow', flowArgs(), root.agent))
    expect(result.flow).toMatchObject({ module: 'src/web', citations: 3, quirkIds: ['H-1'] })
    expect(ctx.hardLedger.flowDocs(root.agent)[0]).toMatchObject({
      module: 'src/web', citations: 3, sections: { entryPoints: 1, dataflows: 1, quirks: 1 },
    })
    expect(ctx.hardLedger.hypotheses(root.agent)[0]).toMatchObject({ id: 'H-1', status: 'proposed' })
    expect(ctx.hardLedger.hypotheses(root.agent)[0]?.statement).toContain('src/web/render.js:7')
  })

  it('rejects the whole record naming every failed citation and records nothing', async () => {
    const { ctx, root } = await harness([
      { exitCode: 0, stdoutText: 'src/web/render.js\n' }, // ls-tree: the path is tracked
      { exitCode: 0, stdoutText: 'unrelated content\n' }, // the first cite's snippet does not match
      { exitCode: 0, stdoutText: '' }, // ls-tree finds nothing for the second path
      { exitCode: 0, stdoutText: 'unrelated content\n' }, // the third cite's snippet does not match
    ])
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target', commit: 'a'.repeat(40),
      modules: ['src/web'], bugClasses: ['cmdi'],
    })
    const refused = await execute(ctx, 'hard_record_flow', flowArgs({
      dataflows: [{ cite: 'src/web/missing.js:2-3', snippet: 'whatever', note: 'n' }],
    }), root.agent)
    expect(refused.isError).toBe(true)
    const text = (refused.content[0] as { type: string; text: string }).text
    expect(text).toContain('src/web/missing.js:2-3 (path is not tracked at the pinned commit)')
    expect(text).toContain('src/web/render.js:7 (snippet does not match the file content at the pinned commit)')
    expect(ctx.hardLedger.flowDocs(root.agent)).toEqual([])
    expect(ctx.hardLedger.hypotheses(root.agent)).toEqual([])
  })

  it('fails loud without a matrix or a malformed citation before any shell run', async () => {
    const { ctx, root } = await harness([{ exitCode: 0, stdoutText: '' }])
    const noMatrix = await execute(ctx, 'hard_record_flow', flowArgs(), root.agent)
    expect(noMatrix.isError).toBe(true)
    expect(noMatrix.error?.message).toContain('no armed coverage matrix pins a commit')
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target', commit: 'a'.repeat(40),
      modules: ['src/web'], bugClasses: ['cmdi'],
    })
    const malformed = await execute(ctx, 'hard_record_flow', flowArgs({
      entry_points: [{ cite: 'src/web/render.js', snippet: 'x', note: 'n' }],
    }), root.agent)
    expect(malformed.isError).toBe(true)
    expect((malformed.content[0] as { type: string; text: string }).text).toContain('cite must be path:line or path:line-line')
  })
})
