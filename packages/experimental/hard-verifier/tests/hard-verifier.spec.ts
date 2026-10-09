/** The verifier executes proofs of effect through a scripted shell and records durable verdicts. */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import HardVerifier, { GUARDED_SURFACE_PATTERNS, SINK_PATTERNS, claimHash, declarationCoversLine, parseSinkCitation, rootFingerprint, sampleCellForSpotCheck } from '@deepseek-ai/dsh-experimental-hard-verifier'
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
  it('compiles every class alternation under the host grep -E', () => {
    for (const [bugClass, patterns] of [...Object.entries(SINK_PATTERNS), ...Object.entries(GUARDED_SURFACE_PATTERNS)]) {
      // Exit 1 is "no match"; exit 2 is a pattern the grep could not parse.
      const result = spawnSync('grep', ['-E', patterns.join('|'), '/dev/null'])
      expect(result.status, bugClass).toBe(1)
    }
  })

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
    // A line no extractor recognizes falls back to its location.
    expect(surfaceOperands('src/odd.js:1:some unmatched line')).toEqual(['src/odd.js:1'])
    // An extractor that names nothing falls through to the next one, then to the line's location.
    expect(surfaceOperands('src/empty.js:1:module.exports = {}')).toEqual(['src/empty.js:1'])
    expect(surfaceOperands(`wp-admin/js/iris.min.js:5:!function(a,b){${'x'.repeat(30000)}}`)).toEqual(['wp-admin/js/iris.min.js:5'])
    expect(surfaceOperands('module.exports = {}')).toEqual(['module.exports = {}'])
    // WordPress: literal hooks, shortcodes, and routes name themselves; built or multi-line ones are named by location.
    expect(surfaceOperands("wp-admin/admin-ajax.php:171:add_action( 'wp_ajax_nopriv_heartbeat', 'wp_ajax_nopriv_heartbeat', 1 );")).toEqual(['wp_ajax_nopriv_heartbeat'])
    expect(surfaceOperands("wp-admin/admin-post.php:9:add_action( 'admin_post_export', 'export' );")).toEqual(['admin_post_export'])
    expect(surfaceOperands("wp-includes/media.php:2775:add_shortcode( 'gallery', 'gallery_shortcode' );")).toEqual(['gallery'])
    expect(surfaceOperands("wp-content/plugins/x/api.php:4:register_rest_route( 'x/v1', '/items', array(")).toEqual(['/items'])
    expect(surfaceOperands('wp-includes/rest-api/a.php:51:\t\tregister_rest_route(')).toEqual(['wp-includes/rest-api/a.php:51'])
    expect(surfaceOperands("wp-admin/admin-ajax.php:162:\tadd_action( 'wp_ajax_' . $_GET['action'], 'cb', 1 );")).toEqual(['wp-admin/admin-ajax.php:162'])
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
    expect(shell.runs[0]?.command).toMatch(new RegExp(`^git grep -I -n -E -e '.*' '${pinnedSha}' -- 'src/auth'$`, 'u'))
    expect(shell.runs[0]?.workdir).toBe('/tmp/hard-target')
  })

  it('drops the commit prefix of pinned grep output and counts the undeclared matches it does not list', async () => {
    const lines = Array.from({ length: 11 }, (_, index) => `${pinnedSha}:src/auth/run${String(index)}.ts:${String(index + 1)}:exec(cmd)`)
    const { ctx } = await harness([{ exitCode: 0, stdoutText: `${lines.join('\n')}\n` }], { coverageSpotCheckPercent: 100 })
    const root = armMatrix(ctx, '/tmp/hard-target')
    const reopened = await ctx.hardVerifier.auditCoverage(root, { ...clearedCell, declaredSinks: ['src/auth/run0.ts:1'] })
    expect(reopened?.declaredSinks).toEqual([
      ...Array.from({ length: 8 }, (_, index) => `src/auth/run${String(index + 1)}.ts:${String(index + 2)}:exec(cmd)`),
      '2 more undeclared matches not shown; grep the module for the rest',
    ])
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

/** A shell service on the `shell` key that really runs commands in the requested workdir, so citation checks run real git. */
class RealShell extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }

  resolve(request: { command: string; timeoutMs?: number; stdoutMaxBytes?: number; workdir?: string }) {
    return { command: request.command, workdir: request.workdir ?? tmpdir() }
  }

  async execute(spec: { command: string; workdir: string }) {
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = 0
    try {
      stdout = execFileSync('/bin/bash', ['-c', spec.command], {
        cwd: spec.workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      })
    } catch (error: unknown) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string }
      exitCode = failure.status ?? 1
      stdout = failure.stdout ?? ''
      stderr = failure.stderr ?? ''
    }
    return Promise.resolve({
      result: () => Promise.resolve({
        exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 0,
        stdout: { text: stdout, truncated: false },
        stderr: { text: stderr, truncated: false },
      }),
    })
  }
}

describe('hard verifier declared-site citations', () => {
  it('parses path:symbol, path:line, and path:start-end with an optional note, and refuses everything else', () => {
    expect(parseSinkCitation('src/files/store.js:readDoc - confirmed path traversal')).toEqual({ path: 'src/files/store.js', locator: 'readDoc' })
    expect(parseSinkCitation('lib/util/text.js:slugify')).toEqual({ path: 'lib/util/text.js', locator: 'slugify' })
    expect(parseSinkCitation('src/reports.js:8 execSync with interpolation')).toEqual({ path: 'src/reports.js', locator: '8', lines: { first: 8, last: 8 } })
    expect(parseSinkCitation('src/web/routes.js:14-24 dispatches every view')).toEqual({ path: 'src/web/routes.js', locator: '14-24', lines: { first: 14, last: 24 } })
    expect(parseSinkCitation('src/web/routes.js:24-14')).toBeUndefined()
    expect(parseSinkCitation('src/web/routes.js:0-3')).toBeUndefined()
    expect(parseSinkCitation('execSync')).toBeUndefined()
    expect(parseSinkCitation('src/reports.js:')).toBeUndefined()
    expect(parseSinkCitation(':readDoc')).toBeUndefined()
    expect(parseSinkCitation('src/reports.js: readDoc')).toBeUndefined()
    expect(parseSinkCitation('src/reports.js:0')).toBeUndefined()
  })

  it('matches a grep line to a citation by path and line or symbol, and keeps the legacy substring rule', () => {
    const line = 'src/auth/exec.ts:5:  return exec(userCmd)'
    expect(declarationCoversLine('src/auth/exec.ts:exec - spawns the command', line)).toBe(true)
    expect(declarationCoversLine('src/auth/exec.ts:5', line)).toBe(true)
    expect(declarationCoversLine('src/auth/exec.ts:6', line)).toBe(false)
    expect(declarationCoversLine('src/auth/exec.ts:3-7 the command path', line)).toBe(true)
    expect(declarationCoversLine('src/auth/exec.ts:6-9', line)).toBe(false)
    expect(declarationCoversLine('src/auth/other.ts:exec', line)).toBe(false)
    expect(declarationCoversLine('src/auth/exec.ts:require', line)).toBe(false)
    // Declarations that are not citations — older logs, batch-screen patterns — keep the substring rule.
    expect(declarationCoversLine('exec(userCmd)', line)).toBe(true)
    expect(declarationCoversLine('spawn', line)).toBe(false)
  })

  it('keeps a cleared cell standing when a cited site covers each grep match, and reopens what no citation covers', async () => {
    const { ctx } = await harness(
      [{ exitCode: 0, stdoutText: 'src/auth/exec.ts:5:  return exec(userCmd)\nsrc/auth/run.ts:9:  spawn(cmd)\n' }],
      { coverageSpotCheckPercent: 100 },
    )
    const root = armMatrix(ctx, '/tmp/hard-target')
    const reopened = await ctx.hardVerifier.auditCoverage(root, {
      module: 'src/auth', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['src/auth/exec.ts:exec - guarded by allowlist'],
    })
    expect(reopened?.declaredSinks).toEqual(['src/auth/run.ts:9:  spawn(cmd)'])
  })

  it('resolves cited sites at the pinned commit with git alone, and never treats a binary as resolved content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hard-verifier-cite-'))
    try {
      const repo = join(root, 'repo')
      await mkdir(join(repo, 'src'), { recursive: true })
      await mkdir(join(repo, 'lib'), { recursive: true })
      await writeFile(join(repo, 'src', 'store.js'), "'use strict'\nfunction readDoc(name) {\n  return name\n}")
      await writeFile(join(repo, 'lib', 'libt.so'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x72, 0x75, 0x6e]))
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      })
      git('init', '--quiet')
      git('add', '-A')
      git('-c', 'user.name=hard-test', '-c', 'user.email=hard@test', 'commit', '--quiet', '-m', 'seed')
      const commit = git('rev-parse', 'HEAD').trim()
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(AgentRegistry)
      new RealShell(ctx)
      await ctx.plugin(HardLedger, {})
      await ctx.plugin(HardVerifier, {})
      const agentStub = stubAgent(`hard-verifier-cite-${Math.random()}`)
      await ctx.agents.register(agentStub.agent)
      ctx.hardLedger.recordMissionArmed(agentStub.agent, {
        objective: 'hunt bugs', targetRepo: repo, commit, modules: ['lib', 'src'], bugClasses: ['cmdi'],
      })
      const short = commit.slice(0, 7)
      const result = await ctx.hardVerifier.checkSinkCitations(agentStub.agent, [
        'src/store.js:readDoc - entry point, no sink reached',
        // The final line has no trailing newline and still counts.
        'src/store.js:4',
        'src/store.js:fndUser',
        'src/store.js:5',
        'src/store.js:2-4 the whole reader',
        'src/store.js:3-6',
        'src/ghost.js:readDoc',
        // A binary is tracked, so its citation passes the path check; its
        // content is never read as resolved — the module is unscreened.
        'lib/libt.so:run_tool',
        'execSync',
      ])
      expect(result.rejected).toEqual([
        { sink: 'src/store.js:fndUser', reason: `src/store.js has no fndUser at commit ${short}` },
        { sink: 'src/store.js:5', reason: `src/store.js has 4 lines at commit ${short}, so no line 5` },
        { sink: 'src/store.js:3-6', reason: `src/store.js has 4 lines at commit ${short}, so no line 6` },
        { sink: 'src/ghost.js:readDoc', reason: `src/ghost.js is not tracked at commit ${short}` },
        { sink: 'execSync', reason: 'a declared site must be path:symbol, path:line, or path:start-end, optionally followed by a note' },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed on an unsettled git call and refuses to resolve without a matrix', async () => {
    const unsettled = await harness([{ exitCode: 128, stderrText: 'fatal: bad object', stdoutText: '' }])
    const unsettledRoot = armMatrix(unsettled.ctx, '/tmp/hard-target')
    const failed = await unsettled.ctx.hardVerifier.checkSinkCitations(unsettledRoot, ['src/a.ts:run'])
      .catch((error: unknown) => error)
    expect((failed as { code?: string }).code).toBe('HARD_VERIFIER_CITATION_FAILED')
    expect((failed as Error).message).toContain('hard sink citations: ls-tree over src/a.ts failed with exit 128')
    const bare = await harness([])
    const missing = await bare.ctx.hardVerifier.checkSinkCitations(root0Agent(bare.ctx), ['src/a.ts:run'])
      .catch((error: unknown) => error)
    expect((missing as { code?: string }).code).toBe('HARD_VERIFIER_NO_MATRIX')
    const countless = await bare.ctx.hardVerifier.moduleFileCount(root0Agent(bare.ctx), 'src').catch((error: unknown) => error)
    expect((countless as { code?: string }).code).toBe('HARD_VERIFIER_NO_MATRIX')
  })
})

describe('hard verifier root module and repository classes', () => {
  /** A git runner for one temporary repository, isolated from the host's git configuration. */
  function gitIn(tree: string): (...args: string[]) => string {
    return (...args) => execFileSync('git', ['-C', tree, ...args], {
      encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
  }

  it('greps the pinned commit, never files written into the target after the arming, and only root files for the root module', async () => {
    const tree = await mkdtemp(join(tmpdir(), 'hard-pinned-grep-'))
    try {
      await mkdir(join(tree, 'sub'))
      await writeFile(join(tree, 'sub/deep.js'), 'exec(cmd)\n')
      await writeFile(join(tree, '.hidden.js'), 'execSync(x)\n')
      await writeFile(join(tree, 'app.js'), 'const a = 1\nsystem(cmd)\n')
      const git = gitIn(tree)
      git('init', '--quiet')
      git('add', '-A')
      git('-c', 'user.name=hard-test', '-c', 'user.email=hard@test', 'commit', '--quiet', '-m', 'seed')
      const commit = git('rev-parse', 'HEAD').trim()
      // Written after the arming: a report quoting a sink, and a new sink in a tracked file.
      await writeFile(join(tree, 'report.md'), 'found `exec(` in sub/deep.js\n')
      await writeFile(join(tree, 'app.js'), 'const a = 1\nsystem(cmd)\nexecSync(late)\n')
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(AgentRegistry)
      new RealShell(ctx)
      await ctx.plugin(HardLedger, {})
      await ctx.plugin(HardVerifier, { coverageSpotCheckPercent: 100 })
      const agentStub = stubAgent(`hard-verifier-pinned-grep-${Math.random()}`)
      await ctx.agents.register(agentStub.agent)
      ctx.hardLedger.recordMissionArmed(agentStub.agent, {
        objective: 'hunt bugs', targetRepo: tree, commit, modules: ['.', 'sub'], bugClasses: ['cmdi'],
      })
      const reopened = await ctx.hardVerifier.auditCoverage(agentStub.agent, {
        module: '.', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['app.js:1'],
      })
      expect(reopened?.declaredSinks).toEqual(['.hidden.js:1:execSync(x)', 'app.js:2:system(cmd)'])
      expect(await ctx.hardVerifier.auditCoverage(agentStub.agent, {
        module: '.', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['.hidden.js:1', 'app.js:2'],
      })).toBeUndefined()
      expect(await ctx.hardVerifier.screenModules(agentStub.agent, 'cmdi', ['sub', '.'], [])).toEqual({
        clean: false, evidence: ['sub/deep.js:1:exec(cmd)', '.hidden.js:1:execSync(x)', 'app.js:2:system(cmd)'],
      })
      // Module sizes come from the pinned commit too: the report written afterwards is not counted.
      expect(await ctx.hardVerifier.moduleFileCount(agentStub.agent, '.')).toBe(2)
      expect(await ctx.hardVerifier.moduleFileCount(agentStub.agent, 'sub')).toBe(1)
    } finally {
      await rm(tree, { recursive: true, force: true })
    }
  })

  it('skips CSS stylesheets for the keyword classes at every scope, and keeps them for the rest', async () => {
    const tree = await mkdtemp(join(tmpdir(), 'hard-css-grep-'))
    try {
      await mkdir(join(tree, 'src'))
      await writeFile(join(tree, 'src/app.js'), 'const h = md5(x)\n')
      await writeFile(join(tree, 'src/theme.css'), '/* md5( */ .a { display_errors: 1 }\n')
      await writeFile(join(tree, 'root.css'), '/* md5( WP_DEBUG */\n')
      await writeFile(join(tree, 'boot.php'), "<?php ini_set('display_errors', 1); md5($x);\n")
      const git = gitIn(tree)
      git('init', '--quiet')
      git('add', '-A')
      git('-c', 'user.name=hard-test', '-c', 'user.email=hard@test', 'commit', '--quiet', '-m', 'seed')
      const commit = git('rev-parse', 'HEAD').trim()
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(AgentRegistry)
      new RealShell(ctx)
      await ctx.plugin(HardLedger, {})
      await ctx.plugin(HardVerifier, { coverageSpotCheckPercent: 100 })
      const agentStub = stubAgent(`hard-verifier-css-${Math.random()}`)
      await ctx.agents.register(agentStub.agent)
      ctx.hardLedger.recordMissionArmed(agentStub.agent, {
        objective: 'hunt bugs', targetRepo: tree, commit, modules: ['.', 'src'], bugClasses: ['crypto-misuse', 'misconfig'],
      })
      const reopened = async (module: string, bugClass: string): Promise<readonly string[] | undefined> =>
        (await ctx.hardVerifier.auditCoverage(agentStub.agent, { module, bugClass, verdict: 'cleared', declaredSinks: ['x.ts:1'] }))?.declaredSinks
      expect(await reopened('src', 'crypto-misuse')).toEqual(['src/app.js:1:const h = md5(x)'])
      expect(await reopened('.', 'crypto-misuse')).toEqual(["boot.php:1:<?php ini_set('display_errors', 1); md5($x);"])
      expect(await reopened('src', 'misconfig')).toEqual(["boot.php:1:<?php ini_set('display_errors', 1); md5($x);"])
      expect(await ctx.hardVerifier.screenModules(agentStub.agent, 'crypto-misuse', ['src', '.'], [])).toEqual({
        clean: false, evidence: ['src/app.js:1:const h = md5(x)', "boot.php:1:<?php ini_set('display_errors', 1); md5($x);"],
      })
    } finally {
      await rm(tree, { recursive: true, force: true })
    }
  })

  it('greps the whole tree for a repository class on any module and matches the paths to citations', async () => {
    const { ctx, shell } = await harness(
      [{ exitCode: 0, stdoutText: `${pinnedSha}:package.json:3:  "dependencies": {\n${pinnedSha}:vendor/lib/package.json:2:  "dependencies": {}\n` }],
      { coverageSpotCheckPercent: 100 },
    )
    const root = armMatrix(ctx, '/tmp/hard-target')
    const reopened = await ctx.hardVerifier.auditCoverage(root, {
      module: 'src/auth', bugClass: 'dependencies', verdict: 'cleared', declaredSinks: ['package.json:dependencies'],
    })
    expect(shell.runs[0]?.command).toMatch(new RegExp(`^git grep -I -n -E -e '.*' '${pinnedSha}'$`, 'u'))
    expect(reopened).toEqual({
      module: 'src/auth', bugClass: 'dependencies', verdict: 'suspicious',
      declaredSinks: ['vendor/lib/package.json:2:  "dependencies": {}'], source: 'harness',
    })
  })

  it('batch-screens the root module apart from the directory modules and merges the evidence', async () => {
    const { ctx, shell } = await harness([
      { exitCode: 0, stdoutText: 'src/auth/run.js:4:exec(cmd)\n' },
      { exitCode: 0, stdoutText: 'app.js:2:system(cmd)\n' },
    ])
    const root = armMatrix(ctx, '/tmp/hard-target')
    const screen = await ctx.hardVerifier.screenModules(root, 'cmdi', ['src/auth', '.'], ['spawn'])
    expect(screen).toEqual({ clean: false, evidence: ['src/auth/run.js:4:exec(cmd)', 'app.js:2:system(cmd)'] })
    expect(shell.runs[0]?.command).toMatch(new RegExp(`^git grep -I -n -E -e '.*' '${pinnedSha}' -- 'src/auth'$`, 'u'))
    expect(shell.runs[1]?.command).toContain('--max-depth 0 ')
    const rootOnly = await harness([{ exitCode: 1, stdoutText: '' }])
    const rootOnlyAgent = armMatrix(rootOnly.ctx, '/tmp/hard-target')
    expect(await rootOnly.ctx.hardVerifier.screenModules(rootOnlyAgent, 'cmdi', ['.'], ['spawn'])).toEqual({ clean: true, evidence: [] })
    expect(rootOnly.shell.runs).toHaveLength(1)
  })

  it('bounds each grep match it records or returns, so a minified bundle line cannot overflow the ledger', async () => {
    const minified = `src/auth/app.min.js:1:${'x'.repeat(5000)}redirect(u)`
    const { ctx } = await harness([{ exitCode: 0, stdoutText: `${minified}\n` }, { exitCode: 0, stdoutText: `${minified}\n` }], { coverageSpotCheckPercent: 100 })
    const root = armMatrix(ctx, '/tmp/hard-target')
    const reopened = await ctx.hardVerifier.auditCoverage(root, { module: 'src/auth', bugClass: 'open-redirect', verdict: 'cleared', declaredSinks: ['src/auth/login.ts:10'] })
    const recorded = reopened?.declaredSinks[0] ?? ''
    expect(recorded).toHaveLength(301)
    expect(recorded.startsWith('src/auth/app.min.js:1:')).toBe(true)
    expect(recorded.endsWith('…')).toBe(true)
    // The ledger accepts the reopening the cross-check produced.
    expect(reopened).toBeDefined()
    if (reopened !== undefined) {
      expect(() => { ctx.hardLedger.markCoverage(root, { ...reopened, declaredSinks: [...reopened.declaredSinks] }) }).not.toThrow()
    }
    const screen = await ctx.hardVerifier.screenModules(root, 'open-redirect', ['src/auth'], ['redirect'])
    expect(screen.evidence[0]).toHaveLength(301)
  })

  it('covers a location-named operation with a line or range citation of that line', async () => {
    const { ctx } = await harness([
      { exitCode: 0, stdoutText: 'src/auth/api.php:51:\t\tregister_rest_route(\nsrc/auth/api.php:90:\t\tregister_rest_route(\n' },
    ], { coverageSpotCheckPercent: 100 })
    const root = armMatrix(ctx, '/tmp/hard-target')
    const reopened = await ctx.hardVerifier.auditCoverage(root, {
      module: 'src/auth', bugClass: 'authz', verdict: 'cleared',
      declaredSinks: ['src/auth/api.php:45-60 permission_callback requires edit_theme_options'],
    })
    expect(reopened?.declaredSinks).toEqual(['src/auth/api.php:90'])
  })

  it('refuses an undecidable proposal before it is recorded', async () => {
    const claim = 'Checked before the proposal exists.'
    const { ctx, root, shell } = await harness([benignFail, { exitCode: 0, stdoutText: `HARD-PASS ${claimHash(claim)}` }], { runs: 1 })
    const request = findingRequest(claim)
    const badVector = await Promise.resolve().then(() => ctx.hardVerifier.assertVerifiable(root.agent, {
      ...request, cvssVector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:U/SI:N/SA:N',
    })).catch((error: unknown) => error)
    expect((badVector as { code?: string }).code).toBe('HARD_VERIFIER_INVALID_VECTOR')
    expect((badVector as Error).message).toMatch(/^proposal: cvss vector does not parse/u)
    expect(ctx.hardVerifier.assertVerifiable(root.agent, request)).toEqual({ computed: 9.3, match: true })
    const id = ctx.hardLedger.proposeFinding(root.agent, request)
    await ctx.hardVerifier.verify(root.agent, { ...request, id })
    expect(() => ctx.hardVerifier.assertVerifiable(root.agent, request))
      .toThrow('proposal: a confirmed finding with the same root cause already exists (F-1)')
    expect(shell.runs).toHaveLength(2)
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
