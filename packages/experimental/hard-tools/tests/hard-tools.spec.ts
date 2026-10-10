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
import GoalService from '@deepseek-ai/dsh-goal'
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

/**
 * Answers for the verifier's declared-site citation commands: every cited
 * path is a tracked text file of 999 lines containing any symbol, except the
 * listed untracked paths.
 */
interface CitationAnswers {
  readonly untracked?: readonly string[]
}

/** The scripted answer to one citation git command, or `undefined` when the command is not one. */
function citationAnswer(command: string, answers: CitationAnswers): ScriptedRun | undefined {
  const path = /-- '([^']+)'$/u.exec(command)?.[1] ?? /:([^']+)' \| awk/u.exec(command)?.[1]
  if (command.startsWith('git ls-tree')) {
    return { exitCode: 0, stdoutText: path !== undefined && !(answers.untracked ?? []).includes(path) ? `${path}\n` : '' }
  }
  if (command.startsWith('git diff --numstat')) return { exitCode: 0, stdoutText: `1\t0\t${path ?? ''}\n` }
  if (command.startsWith('git grep -I -F')) return { exitCode: 0, stdoutText: `sha:${path ?? ''}:1\n` }
  if (command.includes("awk 'END")) return { exitCode: 0, stdoutText: '999\n' }
  if (command.includes('awk \'$2 == "blob"')) return { exitCode: 0, stdoutText: '2\n' }
  return undefined
}

/** A shell service on the `shell` key cycling a script of outcomes in call order. */
class SingleRunShell extends Service {
  private readonly calls: { command: string; timeoutMs?: number }[] = []

  /** Every command this shell received, citation commands included. */
  readonly commands: string[] = []

  constructor(ctx: Context, private readonly script: readonly ScriptedRun[], private readonly citations?: CitationAnswers) {
    super(ctx, 'shell')
  }

  resolve(request: { command: string; timeoutMs?: number }): { command: string; timeoutMs?: number } {
    return { command: request.command, ...request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs } }
  }

  async execute(spec: { command: string; timeoutMs?: number }) {
    this.commands.push(spec.command)
    const answered = this.citations === undefined ? undefined : citationAnswer(spec.command, this.citations)
    if (answered === undefined) {
      this.calls.push({ command: spec.command, ...spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs } })
    }
    const scripted = answered ?? this.script[(this.calls.length - 1) % this.script.length]
    if (scripted === undefined) throw new Error('scripted shell has no run')
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

async function harness(
  scripted: ScriptedRun | readonly ScriptedRun[],
  verifyConfig: VerifierConfig = { runs: 1 },
  citations?: CitationAnswers,
  // One required file keeps the file count out of the scripted shell; the clear-evidence suite sets its own.
  toolsConfig: hardTools.Config = { minClearedFiles: 1 },
) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(HardLedger, {})
  const shell = new SingleRunShell(ctx, Array.isArray(scripted) ? scripted : [scripted], citations)
  await ctx.plugin(HardVerifier, verifyConfig)
  const fiber = await ctx.plugin(hardTools, toolsConfig)
  const root = stubAgent(`hard-tools-root-${Math.random()}`)
  await ctx.agents.register(root.agent)
  return { ctx, fiber, root, shell }
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
  it('registers the nine tools and disposes them with the fiber', async () => {
    const { ctx, fiber } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    const names = ['hard_submit_finding', 'hard_update_hypothesis', 'hard_record_flaw', 'hard_record_flow', 'hard_mark_coverage', 'hard_mark_module', 'hard_sweep_summary', 'hard_clear_modules', 'hard_status']
    expect(names.map(name => ctx.tools.get(name)?.name)).toEqual(names)
    await fiber.dispose()
    expect(ctx.tools.get('hard_submit_finding')).toBeUndefined()
    expect(ctx.tools.get('hard_status')).toBeUndefined()
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
      ['hard_record_flaw', { title: 'x', component: 'c', grants: 'g', requires: 'r', sites: ['a.ts:1'] }],
      ['hard_mark_coverage', { module: 'm', bug_class: 'sqli', verdict: 'suspicious', declared_sinks: [] }],
      ['hard_mark_module', { module: 'm', cells: [{ bug_class: 'sqli', verdict: 'suspicious' }] }],
      ['hard_record_flow', { module: 'm', entry_points: [], dataflows: [], trust_boundaries: [], state_machines: [], assumptions: [], quirks: [] }],
      ['hard_sweep_summary', { phase: 'A', cells_touched: 1, new_findings: 1 }],
      ['hard_status', { view: 'summary' }],
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
    expect(ctx.tools.get('hard_record_flaw')?.presentCall?.({ title: 'Slug leak', component: 'c', grants: 'g', requires: 'r', sites: ['a.ts:1'] }))
      .toMatchObject({ title: 'Weakness: Slug leak' })
    expect(ctx.tools.get('hard_mark_coverage')?.presentCall?.({ module: 'm', bug_class: 'sqli', verdict: 'cleared' }))
      .toMatchObject({ title: 'Coverage m x sqli: cleared' })
    expect(ctx.tools.get('hard_record_flow')?.presentCall?.({
      module: 'm', entry_points: [{ cite: 'a:1', snippet: 's', note: 'n' }], dataflows: [], trust_boundaries: [],
      state_machines: [], assumptions: [], quirks: [],
    })).toMatchObject({ title: 'Flow doc m: 1 citations' })
    expect(ctx.tools.get('hard_sweep_summary')?.presentCall?.({ phase: 'B', cells_touched: 2, new_findings: 3 }))
      .toMatchObject({ title: 'Sweep B: 3 findings' })
    expect(ctx.tools.get('hard_status')?.presentCall?.({ view: 'cells', filter: 'suspicious' }))
      .toMatchObject({ title: 'Status: cells (suspicious)' })
    expect(ctx.tools.get('hard_status')?.presentCall?.({ view: 'summary' }))
      .toMatchObject({ title: 'Status: summary' })
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

  it('refuses an unparsable vector and a duplicate root cause before recording a proposal', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    const args = {
      title: 'SQL injection in login lookup',
      bug_class: 'sqli', component: 'src/auth/login.ts', symbol: 'login()',
      claim: CLAIM, cvss_vector: VECTOR, cvss_score: 9.3, poc_path: 'poc/poc.sh', payload: "x' OR 1=1 --",
    }
    const badVector = await execute(ctx, 'hard_submit_finding', {
      ...args, cvss_vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:U/SI:N/SA:N',
    }, root.agent)
    expect(badVector.error?.info?.code).toBe('HARD_VERIFIER_INVALID_VECTOR')
    expect(ctx.hardLedger.findings(root.agent)).toEqual([])
    expect(ctx.hardLedger.openWork(root.agent)).toEqual([])
    await execute(ctx, 'hard_submit_finding', args, root.agent)
    const duplicate = await execute(ctx, 'hard_submit_finding', args, root.agent)
    expect(duplicate.error?.info?.code).toBe('HARD_VERIFIER_DUPLICATE')
    expect(ctx.hardLedger.findings(root.agent)).toHaveLength(1)
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

  it('moves an existing hypothesis without restating it, and refuses a proposal without a statement', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    const statement = 'The session check accepts a token committed to the repository.'
    await execute(ctx, 'hard_update_hypothesis', { statement, status: 'proposed' }, root.agent)
    const testing = resultJson(await execute(ctx, 'hard_update_hypothesis', { hypothesis_id: 'H-1', status: 'testing' }, root.agent))
    expect((testing.hypothesis as Record<string, unknown>)['status']).toBe('testing')
    const confirmed = resultJson(await execute(ctx, 'hard_update_hypothesis', {
      hypothesis_id: 'H-1', status: 'confirmed', reason: 'the PoC exited 0 with the marker; the benign arm failed',
    }, root.agent))
    expect((confirmed.hypothesis as Record<string, unknown>)['status']).toBe('confirmed')
    expect(ctx.hardLedger.hypotheses(root.agent)).toMatchObject([{ id: 'H-1', statement, status: 'confirmed' }])
    const unstated = await execute(ctx, 'hard_update_hypothesis', { status: 'proposed' }, root.agent)
    expect(unstated.isError).toBe(true)
    expect(unstated.error?.info?.code).toBe('HARD_LEDGER_STATEMENT_REQUIRED')
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
      {},
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

  it('refuses a clear whose declared sites do not resolve at the pinned commit, naming each, and records nothing', async () => {
    const { ctx, root, shell } = await harness({ exitCode: 1, stdoutText: '' }, { runs: 1, coverageSpotCheckPercent: 100 }, {
      untracked: ['src/db/ghost.ts'],
    })
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'a'.repeat(40),
      modules: ['src/db'],
      bugClasses: ['cmdi'],
    })
    const refused = await execute(ctx, 'hard_mark_coverage', {
      module: 'src/db', bug_class: 'cmdi', verdict: 'cleared',
      declared_sinks: ['src/db/query.ts:runQuery - parameterized', 'src/db/ghost.ts:exec', 'execSync'],
    }, root.agent)
    expect(refused.isError).toBe(true)
    const text = (refused.content[0] as { type: string; text: string }).text
    expect(text).toContain('every declared site must resolve at the pinned commit')
    expect(text).toContain('src/db/ghost.ts:exec (src/db/ghost.ts is not tracked at commit aaaaaaa)')
    expect(text).toContain('execSync (a declared site must be path:symbol, path:line, or path:start-end, optionally followed by a note)')
    expect(ctx.hardLedger.coverage(root.agent)).toEqual([])
    // The cross-check never ran: the refusal precedes the record and the audit.
    expect(shell.commands.some(command => command.includes(' grep -I -n -E '))).toBe(false)
  })

  it('resolves cleared sites only: a suspicious verdict records without any citation command', async () => {
    const { ctx, root, shell } = await harness({ exitCode: 1, stdoutText: '' }, { runs: 1, coverageSpotCheckPercent: 100 }, {})
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'a'.repeat(40),
      modules: ['src/db'],
      bugClasses: ['cmdi'],
    })
    resultJson(await execute(ctx, 'hard_mark_coverage', {
      module: 'src/db', bug_class: 'cmdi', verdict: 'suspicious', declared_sinks: ['the query builder looks unsafe'],
    }, root.agent))
    expect(shell.commands).toEqual([])
  })

  it('marks the cell suspicious and fails the tool call when the cross-check grep errors', async () => {
    const { ctx, root } = await harness(
      { exitCode: 2, stdoutText: '' },
      { runs: 1, coverageSpotCheckPercent: 100 },
      {},
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

  /** Arm a two-module matrix over the scripted target. */
  function armModules(ctx: Context, agent: Agent): void {
    ctx.hardLedger.recordMissionArmed(agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'a'.repeat(40),
      modules: ['docs', 'src/db'],
      bugClasses: ['cmdi', 'sqli', 'xss', 'dependencies'],
      inertModules: ['docs'],
    })
  }

  it('records several classes of one module in one call, cross-checking each', async () => {
    const { ctx, root } = await harness({ exitCode: 0, stdoutText: 'src/db/exec.ts:9: exec(userCmd)\n' }, { runs: 1, coverageSpotCheckPercent: 100 }, {})
    armModules(ctx, root.agent)
    const value = resultJson(await execute(ctx, 'hard_mark_module', {
      module: 'src/db',
      cells: [
        { bug_class: 'cmdi', verdict: 'cleared', declared_sinks: ['src/db/query.ts:42 rawQuery()'] },
        { bug_class: 'xss', verdict: 'suspicious', declared_sinks: ['the template echoes input'] },
        { bug_class: 'dependencies', verdict: 'uncovered' },
      ],
    }, root.agent))
    expect(value).toEqual({
      module: 'src/db',
      cells: [
        { bugClass: 'cmdi', verdict: 'suspicious', reopenedSinks: ['src/db/exec.ts:9: exec(userCmd)'] },
        { bugClass: 'xss', verdict: 'suspicious', reopenedSinks: [] },
        { bugClass: 'dependencies', verdict: 'uncovered', reopenedSinks: [] },
      ],
    })
    expect(ctx.hardLedger.coverage(root.agent).map(cell => [cell.bugClass, cell.verdict, cell.source ?? 'model'])).toEqual([
      ['cmdi', 'suspicious', 'harness'], ['xss', 'suspicious', 'model'], ['dependencies', 'uncovered', 'model'],
    ])
    expect(ctx.tools.get('hard_mark_module')?.presentCall?.({ module: 'src/db', cells: [{ bug_class: 'cmdi', verdict: 'uncovered' }, { bug_class: 'xss', verdict: 'uncovered' }] }))
      .toMatchObject({ title: 'Coverage src/db: 2 classes' })
  })

  it('refuses the whole call naming the bad entry, and records nothing', async () => {
    const { ctx, root, shell } = await harness({ exitCode: 1, stdoutText: '' }, { runs: 1, coverageSpotCheckPercent: 100 }, { untracked: ['src/db/ghost.ts'] })
    armModules(ctx, root.agent)
    const refused = async (args: unknown): Promise<string> => {
      const result = await execute(ctx, 'hard_mark_module', args, root.agent)
      expect(result.isError).toBe(true)
      return (result.content[0] as { type: string; text: string }).text
    }
    const good = { bug_class: 'cmdi', verdict: 'cleared', declared_sinks: ['src/db/query.ts:run'] }
    expect(await refused({ module: 'src/db', cells: [] })).toContain('cells must list between 1 and 32 entries')
    expect(await refused({ module: 'src/db', cells: [good, 'x'] })).toContain('"cells[1]" must be an object')
    expect(await refused({ module: 'src/db', cells: [good, good] })).toContain('cells name bug_class cmdi more than once')
    expect(await refused({ module: 'src/db', cells: [{ bug_class: 'sqli', verdict: 'cleared', declared_sinks: [] }] }))
      .toContain('sqli: cleared requires the declared sinks inspected for this cell')
    expect(await refused({ module: 'docs', cells: [{ bug_class: 'xss', verdict: 'cleared', declared_sinks: ['docs/a.txt:1'] }] }))
      .toContain('xss: module "docs" is inert')
    expect(await refused({ module: 'poc', cells: [{ bug_class: 'xss', verdict: 'suspicious' }] }))
      .toContain('xss: module "poc" is not in the armed coverage matrix')
    const unresolved = await refused({ module: 'src/db', cells: [good, { bug_class: 'sqli', verdict: 'cleared', declared_sinks: ['src/db/ghost.ts:exec'] }] })
    expect(unresolved).toContain('hard_mark_module rejected')
    expect(unresolved).toContain('sqli: src/db/ghost.ts:exec (src/db/ghost.ts is not tracked at commit aaaaaaa)')
    expect(ctx.hardLedger.coverage(root.agent)).toEqual([])
    expect(shell.commands.some(command => command.includes(' grep -I -n -E '))).toBe(false)
  })

  it('keeps recording the other classes when one cross-check cannot run', async () => {
    const { ctx, root } = await harness({ exitCode: 2, stdoutText: '' }, { runs: 1, coverageSpotCheckPercent: 100 }, {})
    armModules(ctx, root.agent)
    const value = resultJson(await execute(ctx, 'hard_mark_module', {
      module: 'src/db',
      cells: [
        { bug_class: 'cmdi', verdict: 'cleared', declared_sinks: ['src/db/query.ts:42'] },
        { bug_class: 'sqli', verdict: 'suspicious', declared_sinks: ['raw query'] },
      ],
    }, root.agent))
    expect(value.cells).toEqual([
      { bugClass: 'cmdi', verdict: 'suspicious', reopenedSinks: [], crossCheckFailed: expect.stringContaining('failed with exit 2') as string },
      { bugClass: 'sqli', verdict: 'suspicious', reopenedSinks: [] },
    ])
    expect(ctx.hardLedger.coverage(root.agent).find(cell => cell.bugClass === 'cmdi')).toMatchObject({ verdict: 'suspicious', source: 'harness' })
  })

  it('records without resolving sites when no matrix pins a commit', async () => {
    const { ctx, root, shell } = await harness({ exitCode: 1, stdoutText: '' }, { runs: 1, coverageSpotCheckPercent: 0 }, {})
    const value = resultJson(await execute(ctx, 'hard_mark_module', {
      module: 'src/db', cells: [{ bug_class: 'cmdi', verdict: 'cleared', declared_sinks: ['src/db/query.ts:42'] }],
    }, root.agent))
    expect(value.cells).toEqual([{ bugClass: 'cmdi', verdict: 'cleared', reopenedSinks: [] }])
    expect(shell.commands).toEqual([])
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
    // The guarded-surface grep names exported operations: zero matches record
    // a batch screen, which re-opens nothing and certifies nothing.
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
    // A repository class is one cell no module grep can screen.
    const repoWide = await execute(ctx, 'hard_clear_modules', {
      modules: ['.'], bug_class: 'dependencies', patterns: ['package\\.json'], rationale: 'r',
    }, root.agent)
    expect(repoWide.isError).toBe(true)
    expect((repoWide.content[0] as { type: string; text: string }).text)
      .toContain('hard_clear_modules refuses dependencies: it covers the whole repository in one cell')
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

  it('refuses a batch over a module the harness cannot screen before any grep runs', async () => {
    // A grep that would match proves the refusal precedes the screen: had the
    // screen run, this batch would have returned evidence instead of an error.
    const { ctx, root } = await harness(
      { exitCode: 0, stdoutText: 'wp/admin/ajax.php:9: passthru($cmd)\n' },
      { runs: 1, coverageSpotCheckPercent: 0 },
      {},
    )
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'a'.repeat(40),
      modules: ['src', 'wp/admin'],
      bugClasses: ['cmdi'],
      unscreenedModules: ['wp/admin'],
    })
    const refused = await execute(ctx, 'hard_clear_modules', {
      modules: ['src', 'wp/admin'], bug_class: 'cmdi', patterns: ['passthru\\('], rationale: 'r',
    }, root.agent)
    expect(refused.isError).toBe(true)
    expect((refused.content[0] as { type: string; text: string }).text)
      .toContain('module "wp/admin" holds a binary file or a language the harness cannot screen, so its grep proves nothing')
    expect(ctx.hardLedger.coverage(root.agent)).toEqual([])
    // The same module stays open to an individual read, which counts as a blind clear.
    resultJson(await execute(ctx, 'hard_mark_coverage', {
      module: 'wp/admin', bug_class: 'cmdi', verdict: 'cleared', declared_sinks: ['wp/admin/ajax.php:my_delete_item'],
    }, root.agent))
    expect(ctx.hardLedger.blindClears(root.agent)).toBe(1)
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

describe('weaknesses, chains, and logic clears', () => {
  const weakness = {
    title: 'Re-parent skips edit_post', component: 'src/db', grants: 'set any post_parent', requires: 'upload_files',
    sites: ['src/db/media.ts:972 type check only'],
  }

  function arm(ctx: Context, agent: Agent, bugClasses: string[] = ['cmdi']): void {
    ctx.hardLedger.recordMissionArmed(agent, {
      objective: 'hunt bugs in the target repository', targetRepo: '/tmp/hard-target', commit: 'a'.repeat(40),
      modules: ['src/db'], bugClasses,
    })
  }

  it('records a weakness only when every site resolves, and reports the material no chain links', async () => {
    const { ctx, root, shell } = await harness({ exitCode: 1, stdoutText: '' }, { runs: 1 }, { untracked: ['src/db/ghost.ts'] })
    arm(ctx, root.agent)
    const refused = await execute(ctx, 'hard_record_flaw', { ...weakness, sites: ['src/db/ghost.ts:exec'] }, root.agent)
    expect(refused.isError).toBe(true)
    expect((refused.content[0] as { type: string; text: string }).text)
      .toContain('hard_record_flaw rejected — every site must resolve at the pinned commit: src/db/ghost.ts:exec (src/db/ghost.ts is not tracked at commit aaaaaaa)')
    expect(ctx.hardLedger.flaws(root.agent)).toEqual([])
    expect(resultJson(await execute(ctx, 'hard_record_flaw', weakness, root.agent))).toEqual({ flaw: { id: 'W-1' }, unchained: [] })
    const hypothesis = ctx.hardLedger.writeHypothesis(root.agent, { statement: 'slug leak', status: 'proposed' })
    expect(resultJson(await execute(ctx, 'hard_record_flaw', { ...weakness, hypothesis_id: ` ${hypothesis} ` }, root.agent)))
      .toEqual({ flaw: { id: 'W-2' }, unchained: ['W-1', 'W-2'] })
    const unknown = await execute(ctx, 'hard_record_flaw', { ...weakness, finding_id: 'F-9' }, root.agent)
    expect((unknown.content[0] as { type: string; text: string }).text).toContain('unknown finding id F-9')
    expect(shell.commands.some(command => command.includes(' grep -I -n -E '))).toBe(false)
  })

  it('records a weakness without resolving sites when no matrix pins a commit', async () => {
    const { ctx, root, shell } = await harness({ exitCode: 1, stdoutText: '' })
    expect(resultJson(await execute(ctx, 'hard_record_flaw', weakness, root.agent))).toEqual({ flaw: { id: 'W-1' }, unchained: [] })
    expect(shell.commands).toEqual([])
  })

  it('links a chain hypothesis to weaknesses and reads the chain board back', async () => {
    const { ctx, root } = await harness({ exitCode: 1, stdoutText: '' })
    const finding = ctx.hardLedger.proposeFinding(root.agent, {
      title: 'Slug leak', bugClass: 'authz', component: 'src/db', claim: 'leaks slugs', cvssVector: VECTOR, cvssClaimed: 9.3,
      pocPath: 'poc.sh', payload: 'x', claimHash: 'c'.repeat(64), fingerprint: 'd'.repeat(64),
    })
    ctx.hardLedger.recordVerdict(root.agent, {
      id: finding, verdict: 'confirmed', runs: 1, cvssComputed: 9.3, cvssMatch: true, reason: 'proved', fingerprint: 'd'.repeat(64),
    })
    await execute(ctx, 'hard_record_flaw', { ...weakness, finding_id: finding }, root.agent)
    await execute(ctx, 'hard_record_flaw', weakness, root.agent)
    const summary = resultJson(await execute(ctx, 'hard_status', { view: 'summary' }, root.agent))
    expect((summary.summary as { openWork: { unchainedMaterial: number } }).openWork.unchainedMaterial).toBe(2)
    ctx.hardLedger.writeHypothesis(root.agent, { statement: 'ordinary', status: 'proposed' })
    expect(resultJson(await execute(ctx, 'hard_update_hypothesis', {
      statement: 'W-2 grants what W-1 requires', status: 'proposed', links: ['W-2', 'W-1'],
    }, root.agent))).toEqual({ hypothesis: { id: 'H-2', status: 'proposed' } })
    expect(resultJson(await execute(ctx, 'hard_status', { view: 'chains' }, root.agent))).toEqual({
      chains: {
        weaknesses: [
          { id: 'W-1', title: weakness.title, component: 'src/db', grants: weakness.grants, requires: weakness.requires, findingId: 'F-1' },
          { id: 'W-2', title: weakness.title, component: 'src/db', grants: weakness.grants, requires: weakness.requires },
        ],
        confirmedFindings: [{ id: 'F-1', title: 'Slug leak', component: 'src/db' }],
        chainHypotheses: [{ id: 'H-2', status: 'proposed', links: ['W-2', 'W-1'], statement: 'W-2 grants what W-1 requires' }],
        unchained: [],
      },
    })
    const bad = await execute(ctx, 'hard_update_hypothesis', { statement: 'x', status: 'proposed', links: ['W-1'] }, root.agent)
    expect((bad.content[0] as { type: string; text: string }).text).toContain('a chain links at least two distinct weaknesses or findings')
  })

  it('refuses a logic clear that does not declare two sites with invariant notes, in both coverage tools', async () => {
    const { ctx, root } = await harness({ exitCode: 1, stdoutText: '' }, { runs: 1, coverageSpotCheckPercent: 100 }, {})
    arm(ctx, root.agent, ['logic', 'cmdi'])
    const message = 'a logic clear declares at least two sites, each path:locator followed by a note stating the invariant it upholds'
    for (const declared of [['src/db/a.ts:1 owner checked'], ['src/db/a.ts:1', 'src/db/b.ts:2 owner checked']]) {
      const refused = await execute(ctx, 'hard_mark_coverage', { module: 'src/db', bug_class: 'logic', verdict: 'cleared', declared_sinks: declared }, root.agent)
      expect((refused.content[0] as { type: string; text: string }).text).toContain(message)
    }
    const batch = await execute(ctx, 'hard_mark_module', {
      module: 'src/db', cells: [{ bug_class: 'cmdi', verdict: 'suspicious' }, { bug_class: 'logic', verdict: 'cleared', declared_sinks: ['src/db/a.ts:1'] }],
    }, root.agent)
    expect((batch.content[0] as { type: string; text: string }).text).toContain(`logic: ${message}`)
    expect(ctx.hardLedger.coverage(root.agent)).toEqual([])
    expect(resultJson(await execute(ctx, 'hard_mark_coverage', {
      module: 'src/db', bug_class: 'logic', verdict: 'cleared',
      declared_sinks: ['src/db/a.ts:1 update checks owner', 'src/db/b.ts:2 sibling update checks owner too'],
    }, root.agent))).toEqual({ coverage: { module: 'src/db', bugClass: 'logic', verdict: 'cleared' }, reopenedSinks: [] })
    // A suspicious logic cell needs no invariants.
    expect(resultJson(await execute(ctx, 'hard_mark_coverage', { module: 'src/db', bug_class: 'logic', verdict: 'suspicious' }, root.agent)))
      .toMatchObject({ coverage: { verdict: 'suspicious' } })
  })
})

describe('clear evidence policy', () => {
  function arm(ctx: Context, agent: Agent): void {
    ctx.hardLedger.recordMissionArmed(agent, {
      objective: 'hunt bugs in the target repository', targetRepo: '/tmp/hard-target', commit: 'a'.repeat(40),
      modules: ['src/db'], bugClasses: ['sqli', 'cmdi', 'dependencies'],
    })
  }
  const text = (result: ToolExecutionResult): string => (result.content[0] as { type: string; text: string }).text

  it('refuses a cleared site citing more lines than the limit, in both coverage tools', async () => {
    const { ctx, root } = await harness({ exitCode: 1, stdoutText: '' }, { runs: 1 }, {}, { minClearedFiles: 1, maxCitedRangeLines: 300 })
    arm(ctx, root.agent)
    const wide = await execute(ctx, 'hard_mark_coverage', {
      module: 'src/db', bug_class: 'sqli', verdict: 'cleared', declared_sinks: ['src/db/query.ts:1-301 whole file read'],
    }, root.agent)
    expect(text(wide)).toContain('src/db/query.ts:1-301 whole file read cites 301 lines; a clear cites the function or the lines you read, at most 300 lines per site')
    const batch = await execute(ctx, 'hard_mark_module', {
      module: 'src/db', cells: [{ bug_class: 'cmdi', verdict: 'cleared', declared_sinks: ['src/db/run.ts:10-900'] }],
    }, root.agent)
    expect(text(batch)).toContain('cmdi: src/db/run.ts:10-900 cites 891 lines')
    expect(ctx.hardLedger.coverage(root.agent)).toEqual([])
    expect(resultJson(await execute(ctx, 'hard_mark_coverage', {
      module: 'src/db', bug_class: 'sqli', verdict: 'cleared', declared_sinks: ['src/db/query.ts:1-300 read in full'],
    }, root.agent))).toMatchObject({ coverage: { verdict: 'cleared' } })
  })

  it('requires sites in several module files, capped by the module size, and counts only files inside the module', async () => {
    const { ctx, root } = await harness({ exitCode: 1, stdoutText: '' }, { runs: 1 }, {}, { minClearedFiles: 3 })
    arm(ctx, root.agent)
    const thin = await execute(ctx, 'hard_mark_coverage', {
      module: 'src/db', bug_class: 'sqli', verdict: 'cleared',
      declared_sinks: ['src/db/a.ts:1 prepared', 'src/db/b.ts:2 prepared', 'src/api/c.ts:3 outside the module'],
    }, root.agent)
    expect(text(thin)).toContain('a clear of module "src/db" cites sites in 2 of its files; cite the sites you inspected in at least 3 different files of the module')
    const batch = await execute(ctx, 'hard_mark_module', {
      module: 'src/db', cells: [
        { bug_class: 'cmdi', verdict: 'cleared', declared_sinks: ['src/db/a.ts:1'] },
        { bug_class: 'sqli', verdict: 'cleared', declared_sinks: ['src/db/a.ts:1', 'src/db/b.ts:1-400'] },
      ],
    }, root.agent)
    // Every shortfall of every entry is named in one refusal.
    expect(text(batch)).toContain('sqli: src/db/b.ts:1-400 cites 400 lines; a clear cites the function or the lines you read, at most 300 lines per site; '
      + 'cmdi: a clear of module "src/db" cites sites in 1 of its files; cite the sites you inspected in at least 3 different files of the module; '
      + 'sqli: a clear of module "src/db" cites sites in 2 of its files')
    expect(resultJson(await execute(ctx, 'hard_mark_coverage', {
      module: 'src/db', bug_class: 'sqli', verdict: 'cleared',
      declared_sinks: ['src/db/a.ts:1 prepared', 'src/db/b.ts:2 prepared', 'src/db/c.ts:3 prepared'],
    }, root.agent))).toMatchObject({ coverage: { verdict: 'cleared' } })
    // The root module holds only root files: a nested path does not count toward its clear.
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository', targetRepo: '/tmp/hard-target', commit: 'a'.repeat(40),
      modules: ['.', 'src/db'], bugClasses: ['sqli', 'cmdi', 'dependencies'],
    })
    expect(text(await execute(ctx, 'hard_mark_coverage', {
      module: '.', bug_class: 'sqli', verdict: 'cleared', declared_sinks: ['index.php:1 entry', 'src/db/a.ts:1 nested'],
    }, root.agent))).toContain('a clear of module "." cites sites in 1 of its files')
    // A repository-scoped class and a suspicious verdict carry no file requirement.
    expect(resultJson(await execute(ctx, 'hard_mark_coverage', {
      module: 'src/db', bug_class: 'dependencies', verdict: 'cleared', declared_sinks: ['package.json:dependencies'],
    }, root.agent))).toMatchObject({ coverage: { verdict: 'cleared' } })
    expect(resultJson(await execute(ctx, 'hard_mark_coverage', { module: 'src/db', bug_class: 'cmdi', verdict: 'suspicious' }, root.agent)))
      .toMatchObject({ coverage: { verdict: 'suspicious' } })
  })

  it('states the deployment limits in both coverage tool descriptions and validates them', async () => {
    const { ctx } = await harness({ exitCode: 1, stdoutText: '' }, { runs: 1 }, undefined, { maxCitedRangeLines: 120, minClearedFiles: 4 })
    for (const name of ['hard_mark_coverage', 'hard_mark_module']) {
      expect(ctx.tools.get(name)?.description).toContain('at most 120 lines per site, never a whole file — in at least 4 different files of the module')
    }
    const defaults = await harness({ exitCode: 1, stdoutText: '' }, { runs: 1 }, undefined, {})
    expect(defaults.ctx.tools.get('hard_mark_coverage')?.description)
      .toContain('at most 300 lines per site, never a whole file — in at least 3 different files of the module')
    const bare = new Context()
    expect(() => { hardTools.apply(bare, { maxCitedRangeLines: 0 }) }).toThrow('maxCitedRangeLines must be a positive safe integer')
    expect(() => { hardTools.apply(bare, { minClearedFiles: 1.5 }) }).toThrow('minClearedFiles must be a positive safe integer')
  })
})

describe('hard_status', () => {
  /** Arm a 3-module, 2-class matrix with one inert and one unscreened module and an exclusion. */
  function armBoard(ctx: Context, agent: Agent): void {
    ctx.hardLedger.recordMissionArmed(agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'a'.repeat(40),
      modules: ['docs', 'src/api', 'wp'],
      bugClasses: ['cmdi', 'sqli'],
      inertModules: ['docs'],
      unscreenedModules: ['wp'],
      exclusions: { globs: ['vendor/**'], fileCount: 9, sample: ['vendor/a.php'] },
    })
    ctx.hardLedger.markCoverage(agent, { module: 'wp', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['wp/a.php:run'] })
    ctx.hardLedger.markCoverage(agent, { module: 'src/api', bugClass: 'sqli', verdict: 'suspicious', declaredSinks: [] })
  }

  it('summarizes remaining work by kind, the gate, and the matrix — counts, never a ratio', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    armBoard(ctx, root.agent)
    const status = resultJson(await execute(ctx, 'hard_status', { view: 'summary' }, root.agent))
    const summary = status.summary as { gate: { complete: boolean; blockers: string[] } }
    expect(summary.gate.blockers).toContain('2 coverage cell(s) have no verdict yet')
    expect(summary).toEqual({
      matrix: {
        moduleCount: 3, bugClasses: ['cmdi', 'sqli'], inertModuleCount: 1,
        unscreenedModules: ['wp'], unscreenedModuleCount: 1,
        excludeGlobs: ['vendor/**'], excludedFileCount: 9,
      },
      openWork: {
        pendingFindings: 0, flakyFindings: 0, openHypotheses: 0, uncoveredCells: 2, suspiciousCells: 1, screenReReads: 0,
        unchainedMaterial: 0,
      },
      gate: { complete: false, blockers: summary.gate.blockers },
    })
    // No ratio or percentage reaches the model: a salient number invites clearing for the number's sake.
    expect(JSON.stringify(status)).not.toMatch(/percent|ratio|verdicted|total/u)
  })

  it('names the goal round when the goal service is mounted', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    await ctx.plugin(GoalService)
    armBoard(ctx, root.agent)
    ctx.goals.create(root.agent, { objective: 'hunt bugs', maxGoalRounds: 9 })
    const status = resultJson(await execute(ctx, 'hard_status', { view: 'summary' }, root.agent))
    expect((status.summary as { goalRound: unknown }).goalRound).toEqual({ started: 0, max: 9 })
  })

  it('lists cells filtered by state and module prefix, paged with the total that matched', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    armBoard(ctx, root.agent)
    // The default filter is the cells that still need a verdict.
    const open = resultJson(await execute(ctx, 'hard_status', { view: 'cells' }, root.agent))
    expect(open).toEqual({
      cells: [
        { module: 'src/api', bugClass: 'cmdi', scope: 'module', blind: false },
        { module: 'wp', bugClass: 'sqli', scope: 'module', blind: false },
      ],
      totalMatching: 2,
      offset: 0,
    })
    const cleared = resultJson(await execute(ctx, 'hard_status', { view: 'cells', filter: 'cleared' }, root.agent))
    // The inert screen and the blind model clear are both cleared — told apart by source and the blind mark.
    expect(cleared.cells).toEqual([
      { module: 'docs', bugClass: 'cmdi', scope: 'module', verdict: 'cleared', source: 'harness', blind: false },
      { module: 'docs', bugClass: 'sqli', scope: 'module', verdict: 'cleared', source: 'harness', blind: false },
      { module: 'wp', bugClass: 'cmdi', scope: 'module', verdict: 'cleared', source: 'model', blind: true },
    ])
    const suspicious = resultJson(await execute(ctx, 'hard_status', { view: 'cells', filter: 'suspicious', module_prefix: 'src' }, root.agent))
    expect(suspicious.cells).toEqual([{ module: 'src/api', bugClass: 'sqli', scope: 'module', verdict: 'suspicious', source: 'model', blind: false }])
    const page = resultJson(await execute(ctx, 'hard_status', { view: 'cells', filter: 'all', limit: 2, offset: 4 }, root.agent))
    expect(page.totalMatching).toBe(6)
    expect(page.offset).toBe(4)
    expect((page.cells as { module: string }[]).map(cell => cell.module)).toEqual(['wp', 'wp'])
  })

  it('pages the full open-work list and bounds every page hard', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'a'.repeat(40),
      modules: Array.from({ length: 150 }, (_, index) => `m${String(index).padStart(3, '0')}`),
      bugClasses: ['cmdi', 'sqli'],
    })
    // 300 open cells: a limit above the ceiling is held at 200.
    const capped = resultJson(await execute(ctx, 'hard_status', { view: 'cells', filter: 'all', limit: 5000 }, root.agent))
    expect(capped.cells).toHaveLength(200)
    expect(capped.totalMatching).toBe(300)
    const work = resultJson(await execute(ctx, 'hard_status', { view: 'open-work' }, root.agent))
    expect(work.openWork).toEqual(ctx.hardLedger.openWork(root.agent))
    expect(work.totalMatching).toBe(ctx.hardLedger.openWork(root.agent).length)
    for (const bad of [{ limit: 0 }, { limit: 1.5 }, { offset: -1 }]) {
      const refused = await execute(ctx, 'hard_status', { view: 'cells', ...bad }, root.agent)
      expect(refused.isError).toBe(true)
    }
  })

  it('reports an unarmed ledger without a matrix and with an empty board', async () => {
    const { ctx, root } = await harness(SUBMIT_SCRIPT(PASS_OUTPUT))
    const status = resultJson(await execute(ctx, 'hard_status', { view: 'summary' }, root.agent))
    expect(status.summary).not.toHaveProperty('matrix')
    const cells = resultJson(await execute(ctx, 'hard_status', { view: 'cells', filter: 'all' }, root.agent))
    expect(cells).toEqual({ cells: [], totalMatching: 0, offset: 0 })
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
