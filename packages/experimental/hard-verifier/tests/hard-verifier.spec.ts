/** The verifier executes proofs of effect through a scripted shell and records durable verdicts. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import HardVerifier, { claimHash, rootFingerprint, sampleCellForSpotCheck } from '@deepseek-ai/dsh-experimental-hard-verifier'
import type { Config as VerifierConfig } from '@deepseek-ai/dsh-experimental-hard-verifier'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { HardFindingId } from '@deepseek-ai/dsh-experimental-hard-ledger'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const VECTOR = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'

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

/** One scripted shell outcome. */
interface ScriptedRun {
  readonly exitCode: number | null
  readonly stdoutText: string
  readonly stderrText?: string
  readonly timedOut?: boolean
}

/** Foreground result shape the scripted shell settles with. */
interface ScriptedExecution {
  result(): Promise<{
    exitCode: number | null
    signal: null
    timedOut: boolean
    aborted: false
    timeoutMs: number
    stdout: { text: string; truncated: false }
    stderr: { text: string; truncated: false }
  }>
}

/** A shell service on the `shell` key whose executions replay scripted outcomes in order. */
class ScriptedShell extends Service {
  readonly runs: { command: string; timeoutMs?: number; workdir?: string }[] = []

  constructor(ctx: Context, private readonly script: readonly ScriptedRun[]) {
    super(ctx, 'shell')
  }

  resolve(request: { command: string; timeoutMs?: number; workdir?: string }): {
    command: string
    timeoutMs?: number
    workdir?: string
  } {
    return {
      command: request.command,
      ...request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs },
      ...request.workdir === undefined ? {} : { workdir: request.workdir },
    }
  }

  async execute(spec: { command: string; timeoutMs?: number; workdir?: string }): Promise<ScriptedExecution> {
    this.runs.push({
      command: spec.command,
      ...spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs },
      ...spec.workdir === undefined ? {} : { workdir: spec.workdir },
    })
    const scripted = this.script[Math.min(this.runs.length - 1, this.script.length - 1)]
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

/** The first registered root agent of a harness context. */
function root0Agent(ctx: Context): Agent {
  const root = ctx.agents.list()[0]
  if (root === undefined) throw new Error('harness agent missing')
  return root
}

async function harness(script: readonly ScriptedRun[], config: VerifierConfig = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const shell = new ScriptedShell(ctx, script)
  await ctx.plugin(HardLedger, {})
  const fiber = await ctx.plugin(HardVerifier, config)
  const root = stubAgent(`hard-verifier-root-${Math.random()}`)
  await ctx.agents.register(root.agent)
  return { ctx, fiber, root, shell }
}

function findingRequest(claim: string) {
  return {
    title: 'SQL injection in login lookup',
    bugClass: 'sqli',
    component: 'src/auth/login.ts',
    claim,
    cvssVector: VECTOR,
    cvssClaimed: 9.3,
    pocPath: 'poc/F-1/poc.sh',
    claimHash: claimHash(claim),
    fingerprint: rootFingerprint({ bugClass: 'sqli', component: 'src/auth/login.ts', symbol: 'login()' }),
  }
}

describe('hard verifier execution', () => {
  it('confirms when every run exits zero and prints the claim marker, and records the verdict', async () => {
    const claim = 'The username parameter reaches concatenation in the login query.'
    const { ctx, root, shell } = await harness([
      { exitCode: 0, stdoutText: `exploit output\nHARD-PASS ${claimHash(claim)}\n` },
      { exitCode: 0, stdoutText: `HARD-PASS ${claimHash(claim)}` },
      { exitCode: 0, stdoutText: `HARD-PASS ${claimHash(claim)}` },
    ], { runs: 3, timeoutSeconds: 30 })
    const request = findingRequest(claim)
    const id = ctx.hardLedger.proposeFinding(root.agent, request)
    const verdict = await ctx.hardVerifier.verify(root.agent, { ...request, id })
    expect(verdict.verdict).toBe('confirmed')
    expect(verdict.runs).toBe(3)
    expect(verdict.cvssComputed).toBe(9.3)
    expect(verdict.cvssMatch).toBe(true)
    expect(shell.runs[0]?.command).toBe("bash 'poc/F-1/poc.sh'")
    expect(shell.runs[0]?.timeoutMs).toBe(30000)
    expect(shell.runs[0]?.workdir).toBeUndefined()
    const folded = ctx.hardLedger.findings(root.agent)
    expect(folded[0]?.verdict?.verdict).toBe('confirmed')
    expect(ctx.hardLedger.openWork(root.agent)).toEqual([])
    expect(shell.resolve({ command: 'bare' })).toEqual({ command: 'bare' })
  })

  it('refutes when no run satisfies the contract and surfaces the failure tail', async () => {
    const claim = 'A failed claim.'
    const { ctx, root } = await harness([
      { exitCode: 1, stdoutText: '', stderrText: 'AssertionError: expected 403' },
    ])
    const request = findingRequest(claim)
    const id = ctx.hardLedger.proposeFinding(root.agent, request)
    const verdict = await ctx.hardVerifier.verify(root.agent, { ...request, id })
    expect(verdict.verdict).toBe('refuted')
    expect(verdict.reason).toContain('exit code 1')
    expect(verdict.reason).toContain('AssertionError')
    expect(ctx.hardLedger.openWork(root.agent)).toEqual([])
  })

  it('refutes a timed-out run and flags a split verdict flaky', async () => {
    const claim = 'A flaky claim.'
    const { ctx, root } = await harness([
      { exitCode: 0, stdoutText: `HARD-PASS ${claimHash(claim)}` },
      { exitCode: null, stdoutText: '', timedOut: true },
    ], { runs: 2 })
    const request = findingRequest(claim)
    const id = ctx.hardLedger.proposeFinding(root.agent, request)
    const verdict = await ctx.hardVerifier.verify(root.agent, { ...request, id })
    expect(verdict.verdict).toBe('flaky')
    expect(verdict.reason).toContain('of 2 runs')

    const timeoutClaim = 'A slow claim.'
    const { root: root2 } = await harness([{ exitCode: null, stdoutText: '', timedOut: true }])
    const request2 = findingRequest(timeoutClaim)
    const id2 = ctx.hardLedger.proposeFinding(root2.agent, request2)
    const verdict2 = await ctx.hardVerifier.verify(root2.agent, { ...request2, id: id2 })
    expect(verdict2.verdict).toBe('refuted')
    expect(verdict2.reason).toContain('timeout')
  })

  it('flags a claimed score that does not match the recomputation', async () => {
    const claim = 'An overclaimed score.'
    const { ctx, root } = await harness([{ exitCode: 0, stdoutText: `HARD-PASS ${claimHash(claim)}` }])
    const request = { ...findingRequest(claim), cvssClaimed: 10 }
    const id = ctx.hardLedger.proposeFinding(root.agent, request)
    const verdict = await ctx.hardVerifier.verify(root.agent, { ...request, id })
    expect(verdict.cvssComputed).toBe(9.3)
    expect(verdict.cvssMatch).toBe(false)
  })

  it('passes the configured workdir through to the shell request', async () => {
    const claim = 'The workdir claim.'
    const { ctx, shell } = await harness([{ exitCode: 0, stdoutText: `HARD-PASS ${claimHash(claim)}` }], {
      runs: 1, timeoutSeconds: 30, pocWorkdir: '/tmp/hard-target',
    })
    const request = findingRequest(claim)
    const id = ctx.hardLedger.proposeFinding(root0Agent(ctx), request)
    await ctx.hardVerifier.verify(root0Agent(ctx), { ...request, id })
    expect(shell.runs[0]?.workdir).toBe('/tmp/hard-target')
  })

  it('rejects a duplicate proposal of a confirmed root cause without executing anything', async () => {
    const claim = 'The duplicate claim.'
    const { ctx, root, shell } = await harness([{ exitCode: 0, stdoutText: `HARD-PASS ${claimHash(claim)}` }])
    const request = findingRequest(claim)
    const id = ctx.hardLedger.proposeFinding(root.agent, request)
    await ctx.hardVerifier.verify(root.agent, { ...request, id })
    const runsBefore = shell.runs.length
    const secondId = ctx.hardLedger.proposeFinding(root.agent, request)
    await expect(ctx.hardVerifier.verify(root.agent, { ...request, id: secondId }))
      .rejects.toThrow('a confirmed finding with the same root cause already exists (F-1)')
    expect(shell.runs.length).toBe(runsBefore)
  })

  it('rejects an unparsable vector with a stable code', async () => {
    const claim = 'A bad vector.'
    const { ctx, root } = await harness([])
    // The ledger only checks the version prefix; the verifier owns full parsing.
    const request = { ...findingRequest(claim), cvssVector: 'CVSS:4.0/AV:Q/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N' }
    const id = ctx.hardLedger.proposeFinding(root.agent, request)
    const failure = await ctx.hardVerifier.verify(root.agent, { ...request, id }).catch((error: unknown) => error)
    expect((failure as { code?: string }).code).toBe('HARD_VERIFIER_INVALID_VECTOR')
  })
})

describe('hard verifier verdict units', () => {
  it('classifies empty run lists and aborted runs through the pure classifier', async () => {
    const { classifyRuns, claimHash, rootFingerprint } = await import('@deepseek-ai/dsh-experimental-hard-verifier')
    const claim = 'The units claim.'
    const hash = claimHash(claim)
    const fingerprint = rootFingerprint({ bugClass: 'sqli', component: 'src/auth' })
    const empty = classifyRuns({
      id: brandString<HardFindingId>('F-1'), runs: [], claimHash: hash, cvssComputed: 5, cvssMatch: true, fingerprint,
    })
    expect(empty.verdict).toBe('refuted')
    expect(empty.reason).toBe('no runs were executed')
    const aborted = classifyRuns({
      id: brandString<HardFindingId>('F-1'),
      runs: [{ exitCode: null, timedOut: false, aborted: true, stdoutText: '', stderrTail: '' }],
      claimHash: hash, cvssComputed: 5, cvssMatch: true, fingerprint,
    })
    expect(aborted.reason).toBe('the PoC was aborted before settling')
  })
})

/** One cleared cell for the cross-check tests. */
const clearedCell = {
  module: 'src/auth',
  bugClass: 'cmdi',
  verdict: 'cleared' as const,
  declaredSinks: ['src/auth/login.ts:10 system('],
}

describe('hard verifier coverage cross-check', () => {
  it('samples deterministically by cell and respects the bounds', () => {
    expect(sampleCellForSpotCheck(clearedCell, 0)).toBe(false)
    expect(sampleCellForSpotCheck(clearedCell, 100)).toBe(true)
    expect(sampleCellForSpotCheck(clearedCell, 20)).toBe(sampleCellForSpotCheck(clearedCell, 20))
  })

  it('skips non-cleared cells, unknown classes, and unsampled cells without running the shell', async () => {
    const unsampled = await harness([], { coverageSpotCheckPercent: 0 })
    expect(await unsampled.ctx.hardVerifier.auditCoverage(clearedCell)).toBeUndefined()
    expect(unsampled.shell.runs).toEqual([])

    const sampled = await harness([], { coverageSpotCheckPercent: 100 })
    expect(await sampled.ctx.hardVerifier.auditCoverage({ ...clearedCell, verdict: 'suspicious' })).toBeUndefined()
    expect(await sampled.ctx.hardVerifier.auditCoverage({ ...clearedCell, bugClass: 'no-such-class' })).toBeUndefined()
    expect(sampled.shell.runs).toEqual([])
  })

  it('reopens a cleared cell whose grep surfaces undeclared sinks', async () => {
    const { ctx, shell } = await harness(
      [{ exitCode: 0, stdoutText: 'src/auth/exec.ts:5: exec(userCmd)\nsrc/auth/login.ts:10 system(cmd)\n' }],
      { coverageSpotCheckPercent: 100 },
    )
    const reopened = await ctx.hardVerifier.auditCoverage(clearedCell)
    expect(reopened).toEqual({
      module: 'src/auth',
      bugClass: 'cmdi',
      verdict: 'suspicious',
      declaredSinks: ['src/auth/exec.ts:5: exec(userCmd)'],
    })
    expect(shell.runs[0]?.command).toContain('grep -rInE')
    expect(shell.runs[0]?.command).toContain('src/auth')
  })

  it('leaves the cell alone when every match was declared or the run failed', async () => {
    const declared = await harness(
      [{ exitCode: 0, stdoutText: 'src/auth/login.ts:10 system(cmd)\n' }],
      { coverageSpotCheckPercent: 100 },
    )
    expect(await declared.ctx.hardVerifier.auditCoverage(clearedCell)).toBeUndefined()

    const failed = await harness([{ exitCode: 1, stdoutText: '' }], { coverageSpotCheckPercent: 100 })
    expect(await failed.ctx.hardVerifier.auditCoverage(clearedCell)).toBeUndefined()
  })

  it('validates the spot-check percent fail-loud', () => {
    expect(() => new HardVerifier(new Context(), { coverageSpotCheckPercent: 101 }))
      .toThrow('coverageSpotCheckPercent must be a safe integer from 0 through 100')
  })
})

describe('hard verifier config and shape', () => {
  it('validates direct-apply config fail-loud', () => {
    expect(() => new HardVerifier(new Context(), { runs: 0 }))
      .toThrow('runs must be a safe integer between 1 and 10')
    expect(() => new HardVerifier(new Context(), { timeoutSeconds: 0 }))
      .toThrow('timeoutSeconds must be a safe integer between 1 and 3600')
    expect(() => new HardVerifier(new Context(), { stdoutMaxBytes: 512 }))
      .toThrow('stdoutMaxBytes must be a safe integer of at least 1024')
    expect(() => new HardVerifier(new Context(), { pocWorkdir: ' ' }))
      .toThrow('pocWorkdir must not be blank when provided')
  })

  it('is a default-exported service on the hardVerifier key', async () => {
    const { ctx } = await harness([{ exitCode: 0, stdoutText: '' }])
    expect(ctx.hardVerifier).toBeInstanceOf(HardVerifier)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(HardVerifier)).toBe(HardVerifier)
  })
})
