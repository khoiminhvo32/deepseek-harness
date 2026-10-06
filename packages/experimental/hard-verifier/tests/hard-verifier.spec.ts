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
import HardVerifier, { GUARDED_SURFACE_PATTERNS, SINK_PATTERNS, claimHash, rootFingerprint, sampleCellForSpotCheck } from '@deepseek-ai/dsh-experimental-hard-verifier'
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
    payload: 'x; touch poc/pwned.txt',
    claimHash: claimHash(claim),
    fingerprint: rootFingerprint({ bugClass: 'sqli', component: 'src/auth/login.ts', symbol: 'login()' }),
  }
}

/** The benign run the verifier executes first; a real PoC fails it. */
const benignFail = { exitCode: 1, stdoutText: '', stderrText: '' }

describe('hard verifier execution', () => {
  it('confirms when every run exits zero and prints the claim marker, and records the verdict', async () => {
    const claim = 'The username parameter reaches concatenation in the login query.'
    const { ctx, root, shell } = await harness([
      benignFail,
      { exitCode: 0, stdoutText: `exploit output\nHARD-PASS ${claimHash(claim)}\n` },
      { exitCode: 0, stdoutText: `exploit output\nHARD-PASS ${claimHash(claim)}` },
      { exitCode: 0, stdoutText: `exploit output\nHARD-PASS ${claimHash(claim)}` },
    ], { runs: 3, timeoutSeconds: 30 })
    const request = findingRequest(claim)
    const id = ctx.hardLedger.proposeFinding(root.agent, request)
    const verdict = await ctx.hardVerifier.verify(root.agent, { ...request, id })
    expect(verdict.verdict).toBe('confirmed')
    expect(verdict.runs).toBe(3)
    expect(verdict.benignArm).toBe('failed')
    expect(verdict.cvssComputed).toBe(9.3)
    expect(verdict.cvssMatch).toBe(true)
    // Explicit so pre-control confirms (evidence absent) read as weaker.
    expect(verdict.evidence).toBe('demonstrated')
    // The benign arm runs first, once, with the deterministic benign payload;
    // the exploit arm re-runs the same PoC with the model's payload.
    expect(shell.runs[0]?.command).toBe(`bash 'poc/F-1/poc.sh' 'hard-benign-${claimHash(claim).slice(0, 8)}'`)
    expect(shell.runs[0]?.timeoutMs).toBe(30000)
    expect(shell.runs[0]?.workdir).toBeUndefined()
    expect(shell.runs[1]?.command).toBe("bash 'poc/F-1/poc.sh' 'x; touch poc/pwned.txt'")
    const folded = ctx.hardLedger.findings(root.agent)
    expect(folded[0]?.verdict?.verdict).toBe('confirmed')
    expect(ctx.hardLedger.openWork(root.agent)).toEqual([])
    expect(shell.resolve({ command: 'bare' })).toEqual({ command: 'bare' })
  })

  it('refutes when no run satisfies the contract and surfaces the failure tail', async () => {
    const claim = 'A failed claim.'
    const { ctx, root } = await harness([
      benignFail,
      { exitCode: 1, stdoutText: '', stderrText: 'AssertionError: expected 403' },
    ])
    const request = findingRequest(claim)
    const id = ctx.hardLedger.proposeFinding(root.agent, request)
    const verdict = await ctx.hardVerifier.verify(root.agent, { ...request, id })
    expect(verdict.verdict).toBe('refuted')
    expect(verdict.cause).toBe('nonzero-exit')
    expect(verdict.reason).toContain('AssertionError')
    expect(ctx.hardLedger.openWork(root.agent)).toEqual([])
  })

  it('refutes a timed-out run and flags a split verdict flaky', async () => {
    const claim = 'A flaky claim.'
    const { ctx, root } = await harness([
      benignFail,
      { exitCode: 0, stdoutText: `exploit output\nHARD-PASS ${claimHash(claim)}` },
      { exitCode: null, stdoutText: '', timedOut: true },
    ], { runs: 2 })
    const request = findingRequest(claim)
    const id = ctx.hardLedger.proposeFinding(root.agent, request)
    const verdict = await ctx.hardVerifier.verify(root.agent, { ...request, id })
    expect(verdict.verdict).toBe('flaky')
    expect(verdict.cause).toBeUndefined()

    const timeoutClaim = 'A slow claim.'
    const { root: root2 } = await harness([benignFail, { exitCode: null, stdoutText: '', timedOut: true }])
    const request2 = findingRequest(timeoutClaim)
    const id2 = ctx.hardLedger.proposeFinding(root2.agent, request2)
    const verdict2 = await ctx.hardVerifier.verify(root2.agent, { ...request2, id: id2 })
    expect(verdict2.verdict).toBe('refuted')
    expect(verdict2.cause).toBe('timeout')
  })

  it('flags a claimed score that does not match the recomputation', async () => {
    const claim = 'An overclaimed score.'
    const { ctx, root } = await harness([benignFail, { exitCode: 0, stdoutText: `exploit output\nHARD-PASS ${claimHash(claim)}` }])
    const request = { ...findingRequest(claim), cvssClaimed: 10 }
    const id = ctx.hardLedger.proposeFinding(root.agent, request)
    const verdict = await ctx.hardVerifier.verify(root.agent, { ...request, id })
    expect(verdict.cvssComputed).toBe(9.3)
    expect(verdict.cvssMatch).toBe(false)
  })

  it('passes the configured workdir through to the shell request', async () => {
    const claim = 'The workdir claim.'
    const { ctx, shell } = await harness([benignFail, { exitCode: 0, stdoutText: `exploit output\nHARD-PASS ${claimHash(claim)}` }], {
      runs: 1, timeoutSeconds: 30, pocWorkdir: '/tmp/hard-target',
    })
    const request = findingRequest(claim)
    const id = ctx.hardLedger.proposeFinding(root0Agent(ctx), request)
    await ctx.hardVerifier.verify(root0Agent(ctx), { ...request, id })
    expect(shell.runs[0]?.workdir).toBe('/tmp/hard-target')
  })

  it('rejects a duplicate proposal of a confirmed root cause without executing anything', async () => {
    const claim = 'The duplicate claim.'
    const { ctx, root, shell } = await harness([benignFail, { exitCode: 0, stdoutText: `exploit output\nHARD-PASS ${claimHash(claim)}` }])
    const request = findingRequest(claim)
    const id = ctx.hardLedger.proposeFinding(root.agent, request)
    await ctx.hardVerifier.verify(root.agent, { ...request, id })
    const runsBefore = shell.runs.length
    const secondId = ctx.hardLedger.proposeFinding(root.agent, request)
    await expect(ctx.hardVerifier.verify(root.agent, { ...request, id: secondId }))
      .rejects.toThrow('a confirmed finding with the same root cause already exists (F-1)')
    expect(shell.runs.length).toBe(runsBefore)
  })

  it('refutes early when the benign arm satisfies the contract', async () => {
    const claim = 'A payload-agnostic claim.'
    const { ctx, root, shell } = await harness([
      { exitCode: 0, stdoutText: `exploit succeeded\nHARD-PASS ${claimHash(claim)}\n` },
    ], { runs: 3 })
    const request = findingRequest(claim)
    const id = ctx.hardLedger.proposeFinding(root.agent, request)
    const verdict = await ctx.hardVerifier.verify(root.agent, { ...request, id })
    expect(verdict.verdict).toBe('refuted')
    expect(verdict.cause).toBe('benign-arm-passed')
    expect(verdict.reason).toBe('the proof passes with a benign payload, so it does not depend on the exploit input')
    expect(verdict.benignArm).toBe('passed')
    expect(verdict.runs).toBe(0)
    // Short circuit: the exploit arm never ran.
    expect(shell.runs).toHaveLength(1)
    expect(ctx.hardLedger.openWork(root.agent)).toEqual([])
  })

  it('runs the PoC from the pinned target repository once a matrix is armed', async () => {
    const claim = 'The pinned workdir claim.'
    const { ctx, root, shell } = await harness([benignFail, { exitCode: 0, stdoutText: `exploit output\nHARD-PASS ${claimHash(claim)}` }], {
      runs: 1,
    })
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'c'.repeat(40),
      modules: ['src'], bugClasses: ['cmdi'],
    })
    const request = findingRequest(claim)
    const id = ctx.hardLedger.proposeFinding(root.agent, request)
    await ctx.hardVerifier.verify(root.agent, { ...request, id })
    expect(shell.runs[0]?.workdir).toBe('/tmp/hard-target')
    expect(shell.runs[1]?.workdir).toBe('/tmp/hard-target')
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
  it('classifies run outcomes into causes through the pure classifier', async () => {
    const { classifyRuns, claimHash, rootFingerprint } = await import('@deepseek-ai/dsh-experimental-hard-verifier')
    const claim = 'The units claim.'
    const hash = claimHash(claim)
    const fingerprint = rootFingerprint({ bugClass: 'sqli', component: 'src/auth' })
    const empty = classifyRuns({
      id: brandString<HardFindingId>('F-1'), runs: [], claimHash: hash, cvssComputed: 5, cvssMatch: true, fingerprint,
    })
    expect(empty.verdict).toBe('refuted')
    expect(empty.cause).toBe('no-runs')
    // A marker-only stdout is a silent proof, not a refutation: output shape
    // carries no payload-dependence evidence, the benign arm does.
    const silent = classifyRuns({
      id: brandString<HardFindingId>('F-1'),
      runs: [{ exitCode: 0, timedOut: false, aborted: false, stdoutText: `HARD-PASS ${hash}\n`, stderrTail: '' }],
      claimHash: hash, cvssComputed: 5, cvssMatch: true, fingerprint,
    })
    expect(silent.verdict).toBe('confirmed')
    expect(silent.cause).toBeUndefined()
    expect(silent.evidence).toBe('demonstrated')
    const noMarker = classifyRuns({
      id: brandString<HardFindingId>('F-1'),
      runs: [{ exitCode: 0, timedOut: false, aborted: false, stdoutText: 'nothing happened', stderrTail: 'swallowed' }],
      claimHash: hash, cvssComputed: 5, cvssMatch: true, fingerprint,
    })
    expect(noMarker.verdict).toBe('refuted')
    expect(noMarker.cause).toBe('no-marker')
    expect(noMarker.reason).toContain('swallowed')
    const aborted = classifyRuns({
      id: brandString<HardFindingId>('F-1'),
      runs: [{ exitCode: null, timedOut: false, aborted: true, stdoutText: '', stderrTail: '' }],
      claimHash: hash, cvssComputed: 5, cvssMatch: true, fingerprint,
    })
    expect(aborted.reason).toBe('the PoC was aborted before settling')
    expect(aborted.cause).toBe('aborted')
  })
})

/** One cleared cell for the cross-check tests. */
const clearedCell = {
  module: 'src/auth',
  bugClass: 'cmdi',
  verdict: 'cleared' as const,
  declaredSinks: ['src/auth/login.ts:10 system('],
}

/** The pinned commit sha shape the arming record requires. */
const pinnedSha = 'a'.repeat(40)

/** Arm the primary root's ledger with a one-module coverage matrix rooted at targetRepo. */
function armMatrix(ctx: Context, targetRepo: string): Agent {
  const root = root0Agent(ctx)
  ctx.hardLedger.recordMissionArmed(root, {
    objective: 'hunt bugs in the target repository',
    targetRepo,
    commit: pinnedSha,
    modules: ['src/auth'],
    bugClasses: ['cmdi'],
  })
  return root
}

describe('hard verifier coverage cross-check', () => {
  it('keeps every sink and surface pattern single-line so a shell-quoted grep parses', () => {
    for (const [bugClass, patterns] of Object.entries(SINK_PATTERNS)) {
      for (const pattern of patterns) {
        // A real control character inside the quoted grep pattern makes BSD
        // grep reject the whole expression ("brackets not balanced", exit 2).
        expect(pattern, `${bugClass}: ${pattern}`).not.toMatch(/[\u0000-\u001f]/u)
      }
    }
    for (const [bugClass, patterns] of Object.entries(GUARDED_SURFACE_PATTERNS)) {
      for (const pattern of patterns) {
        expect(pattern, `${bugClass}: ${pattern}`).not.toMatch(/[\u0000-\u001f]/u)
      }
    }
  })

  it('reduces matched surface lines back to the operations they declare', async () => {
    const { surfaceOperands } = await import('@deepseek-ai/dsh-experimental-hard-verifier')
    expect(surfaceOperands('src/web/render.js:13:module.exports = { renderPage }')).toEqual(['renderPage'])
    expect(surfaceOperands('src/db/index.js:30:module.exports = { findUser, countSessions }')).toEqual(['findUser', 'countSessions'])
    expect(surfaceOperands('src/api.ts:3:export async function handler(req) {')).toEqual(['handler'])
    expect(surfaceOperands('src/api.ts:9:export const routes = [1];')).toEqual(['routes'])
    expect(surfaceOperands('src/legacy.js:2:exports.util = buildUtil;')).toEqual(['util'])
    expect(surfaceOperands('src/app.ts:12:app.get(\'/view/:id\', handler)')).toEqual(['/view/:id'])
    expect(surfaceOperands('src/api.ts:4:@Get(\'/account\')')).toEqual(['/account'])
    expect(surfaceOperands('src/api.ts:5:@Get')).toEqual(['Get'])
    // A line no extractor recognizes falls back to the whole matched line.
    expect(surfaceOperands('src/odd.js:1:some unmatched line')).toEqual(['src/odd.js:1:some unmatched line'])
  })


  it('samples deterministically by cell and respects the bounds', () => {
    expect(sampleCellForSpotCheck(clearedCell, 0)).toBe(false)
    expect(sampleCellForSpotCheck(clearedCell, 100)).toBe(true)
    expect(sampleCellForSpotCheck(clearedCell, 20)).toBe(sampleCellForSpotCheck(clearedCell, 20))
  })

  it('skips non-cleared cells, unknown classes, unsampled cells, and missing matrices without running the shell', async () => {
    const unsampled = await harness([], { coverageSpotCheckPercent: 0 })
    const unsampledRoot = root0Agent(unsampled.ctx)
    expect(await unsampled.ctx.hardVerifier.auditCoverage(unsampledRoot, clearedCell)).toBeUndefined()
    expect(unsampled.shell.runs).toEqual([])

    const sampled = await harness([], { coverageSpotCheckPercent: 100 })
    const sampledRoot = root0Agent(sampled.ctx)
    expect(await sampled.ctx.hardVerifier.auditCoverage(sampledRoot, { ...clearedCell, verdict: 'suspicious' })).toBeUndefined()
    expect(await sampled.ctx.hardVerifier.auditCoverage(sampledRoot, { ...clearedCell, bugClass: 'no-such-class' })).toBeUndefined()
    expect(await sampled.ctx.hardVerifier.auditCoverage(sampledRoot, clearedCell)).toBeUndefined()
    expect(sampled.shell.runs).toEqual([])
  })

  it('reopens a cleared cell whose grep surfaces undeclared sinks, anchored at the pinned target repo', async () => {
    const { ctx, shell } = await harness(
      [{ exitCode: 0, stdoutText: 'src/auth/exec.ts:5: exec(userCmd)\nsrc/auth/login.ts:10 system(cmd)\n' }],
      { coverageSpotCheckPercent: 100 },
    )
    const root = armMatrix(ctx, '/tmp/hard-target')
    const reopened = await ctx.hardVerifier.auditCoverage(root, clearedCell)
    expect(reopened).toEqual({
      module: 'src/auth',
      bugClass: 'cmdi',
      verdict: 'suspicious',
      declaredSinks: ['src/auth/exec.ts:5: exec(userCmd)'],
      source: 'harness',
    })
    expect(shell.runs[0]?.command).toContain('grep -rInE')
    expect(shell.runs[0]?.command).toContain('src/auth')
    expect(shell.runs[0]?.workdir).toBe('/tmp/hard-target')
  })

  it('leaves the cell alone when every match was declared or the grep found nothing', async () => {
    const declared = await harness(
      [{ exitCode: 0, stdoutText: 'src/auth/login.ts:10 system(cmd)\n' }],
      { coverageSpotCheckPercent: 100 },
    )
    const declaredRoot = armMatrix(declared.ctx, '/tmp/hard-target')
    expect(await declared.ctx.hardVerifier.auditCoverage(declaredRoot, clearedCell)).toBeUndefined()

    const clean = await harness([{ exitCode: 1, stdoutText: '' }], { coverageSpotCheckPercent: 100 })
    const cleanRoot = armMatrix(clean.ctx, '/tmp/hard-target')
    expect(await clean.ctx.hardVerifier.auditCoverage(cleanRoot, clearedCell)).toBeUndefined()
  })

  it('fails closed when the cross-check grep errors or times out', async () => {
    const { ctx, shell } = await harness(
      [
        { exitCode: 2, stderrText: 'grep: brackets ([ ]) not balanced', stdoutText: '' },
        { exitCode: null, timedOut: true, stdoutText: '' },
      ],
      { coverageSpotCheckPercent: 100 },
    )
    const root = armMatrix(ctx, '/tmp/hard-target')
    const failed = await ctx.hardVerifier.auditCoverage(root, clearedCell).catch((error: unknown) => error)
    expect((failed as { code?: string }).code).toBe('HARD_VERIFIER_AUDIT_FAILED')
    expect((failed as Error).message).toContain('hard audit: grep over src/auth failed with exit 2')
    const timedOut = await ctx.hardVerifier.auditCoverage(root, clearedCell).catch((error: unknown) => error)
    expect((timedOut as { code?: string }).code).toBe('HARD_VERIFIER_AUDIT_FAILED')
    // A masked grep reported exit 0 with empty output — the silent pass this
    // check must never produce.
    expect(shell.runs[0]?.command).not.toContain('|| true')
    expect(shell.runs).toHaveLength(2)
  })

  it('validates the spot-check percent fail-loud', () => {
    expect(() => new HardVerifier(new Context(), { coverageSpotCheckPercent: 101 }))
      .toThrow('coverageSpotCheckPercent must be a safe integer from 0 through 100')
  })

  it('audits guarded-surface classes by exported operations and reopens naming the undeclared ones', async () => {
    const { ctx, shell } = await harness(
      [{ exitCode: 0, stdoutText: 'src/web/render.js:13:module.exports = { renderPage }\nsrc/web/routes.js:20:module.exports = { handleDashboardQuery }\n' }],
      { coverageSpotCheckPercent: 100 },
    )
    const root = armMatrix(ctx, '/tmp/hard-target')
    const reopened = await ctx.hardVerifier.auditCoverage(root, {
      module: 'src/auth', bugClass: 'authz', verdict: 'cleared',
      declaredSinks: ['renderPage → requireRole(\'editor\')'],
    })
    expect(reopened).toEqual({
      module: 'src/auth', bugClass: 'authz', verdict: 'suspicious', declaredSinks: ['handleDashboardQuery'], source: 'harness',
    })
    expect(shell.runs[0]?.command).toContain('module\\.exports')
    // Declaring every exported operation keeps the cell standing.
    const declared = await harness(
      [{ exitCode: 1, stdoutText: '' }],
      { coverageSpotCheckPercent: 100 },
    )
    const declaredRoot = armMatrix(declared.ctx, '/tmp/hard-target')
    expect(await declared.ctx.hardVerifier.auditCoverage(declaredRoot, {
      module: 'src/auth', bugClass: 'authz', verdict: 'cleared', declaredSinks: ['renderPage', 'handleDashboardQuery'],
    })).toBeUndefined()
  })

  it('throws without a matrix when resolving flow citations', async () => {
    const { ctx } = await harness([])
    const root = root0Agent(ctx)
    const failure = await ctx.hardVerifier.checkFlowCitations(root, [
      { cite: 'src/web/render.js:5', snippet: 'function renderPage' },
    ]).catch((error: unknown) => error)
    expect((failure as { code?: string }).code).toBe('HARD_VERIFIER_NO_MATRIX')
  })

  it('resolves citations against the pinned commit through ls-tree and piped git show', async () => {
    const { ctx, shell } = await harness(
      [
        { exitCode: 0, stdoutText: 'src/web/render.js\n' },
        { exitCode: 0, stdoutText: "function renderPage(slug) {\n  const fragment = 'pages/' + slug + '.html'\n" },
      ],
      { coverageSpotCheckPercent: 100 },
    )
    const root = armMatrix(ctx, '/tmp/hard-target')
    const result = await ctx.hardVerifier.checkFlowCitations(root, [
      { cite: 'src/web/render.js:5-6', snippet: 'function renderPage(slug) {' },
    ])
    expect(result.rejected).toEqual([])
    expect(shell.runs[0]?.command).toBe(`git ls-tree --name-only '${'a'.repeat(40)}' -- 'src/web/render.js'`)
    expect(shell.runs[0]?.workdir).toBe('/tmp/hard-target')
    expect(shell.runs[1]?.command).toContain(`git show '${'a'.repeat(40)}:src/web/render.js'`)
    expect(shell.runs[1]?.command).toContain('sed -n \'5,6p\'')
    expect(shell.runs[1]?.command).toContain('set -o pipefail')
  })

  it('rejects untracked paths, missing lines, and mismatched snippets without throwing', async () => {
    const { ctx } = await harness(
      [
        { exitCode: 0, stdoutText: '' }, // untracked path
        { exitCode: 0, stdoutText: 'src/web/render.js\n' }, // tracked, but the read misses
        { exitCode: 0, stdoutText: 'other content entirely\n' }, // snippet mismatch
        { exitCode: 0, stdoutText: '' }, // sed beyond the file end
      ],
      { coverageSpotCheckPercent: 100 },
    )
    const root = armMatrix(ctx, '/tmp/hard-target')
    const result = await ctx.hardVerifier.checkFlowCitations(root, [
      { cite: 'src/web/ghost.js:1', snippet: 'anything' },
      { cite: 'src/web/render.js:5', snippet: 'function renderPage' },
      { cite: 'src/web/render.js:2', snippet: 'function renderPage' },
      { cite: 'src/web/render.js:500', snippet: 'far away' },
    ])
    expect(result.rejected.map(entry => `${entry.cite}: ${entry.reason}`)).toEqual([
      'src/web/ghost.js:1: path is not tracked at the pinned commit',
      'src/web/render.js:5: snippet does not match the file content at the pinned commit',
      'src/web/render.js:2: snippet does not match the file content at the pinned commit',
      'src/web/render.js:500: snippet does not match the file content at the pinned commit',
    ])
  })

  it('rejects malformed cites without a shell run and fails closed on an unsettled git call', async () => {
    const malformed = await harness([{ exitCode: 0, stdoutText: '' }], { coverageSpotCheckPercent: 100 })
    const malformedRoot = armMatrix(malformed.ctx, '/tmp/hard-target')
    const result = await malformed.ctx.hardVerifier.checkFlowCitations(malformedRoot, [
      { cite: 'src/web/render.js', snippet: 'x' },
      { cite: 'src/web/render.js:0', snippet: 'x' },
      { cite: 'src/web/render.js:5-2', snippet: 'x' },
    ])
    expect(result.rejected).toHaveLength(3)
    expect(malformed.shell.runs).toEqual([])

    const unsettled = await harness(
      [{ exitCode: 2, stderrText: 'fatal: not a git repository', stdoutText: '' }],
      { coverageSpotCheckPercent: 100 },
    )
    const unsettledRoot = armMatrix(unsettled.ctx, '/tmp/hard-target')
    const failed = await unsettled.ctx.hardVerifier.checkFlowCitations(unsettledRoot, [
      { cite: 'src/web/render.js:5', snippet: 'x' },
    ]).catch((error: unknown) => error)
    expect((failed as { code?: string }).code).toBe('HARD_VERIFIER_CITATION_FAILED')
    expect((failed as Error).message).toContain('hard flow citations: ls-tree over src/web/render.js failed with exit 2')
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
