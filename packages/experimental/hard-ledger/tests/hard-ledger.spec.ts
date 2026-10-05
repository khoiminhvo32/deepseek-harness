/** The ledger appends hard/* events, assigns ids from the log, and folds state back from it. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const CLAIM_HASH = 'a'.repeat(64)
const FINGERPRINT = 'b'.repeat(64)

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

/** Build one registry-compatible live agent whose sessions back the ledger fold. */
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

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const fiber = await ctx.plugin(HardLedger, {})
  const root = stubAgent(`hard-ledger-root-${Math.random()}`)
  await ctx.agents.register(root.agent)
  return { ctx, fiber, root }
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

describe('hard ledger findings', () => {
  it('assigns sequential ids from the log and folds verdicts onto proposals', async () => {
    const { ctx, root } = await harness()
    const first = ctx.hardLedger.proposeFinding(root.agent, findingRequest())
    const second = ctx.hardLedger.proposeFinding(root.agent, findingRequest())
    expect(first).toBe('F-1')
    expect(second).toBe('F-2')
    expect(ctx.hardLedger.findings(root.agent)).toHaveLength(2)

    ctx.hardLedger.recordVerdict(root.agent, {
      id: first,
      verdict: 'confirmed',
      runs: 3,
      cvssComputed: 9.3,
      cvssMatch: true,
      reason: 'all 3 runs printed the claim hash and exited zero',
      fingerprint: FINGERPRINT,
    })
    const folded = ctx.hardLedger.findings(root.agent)
    expect(folded.find(record => record.proposed.id === first)?.verdict?.verdict).toBe('confirmed')
    expect(folded.find(record => record.proposed.id === second)?.verdict).toBeUndefined()
  })

  it('rejects invalid proposal fields with stable codes', async () => {
    const { ctx, root } = await harness()
    expect(() => ctx.hardLedger.proposeFinding(root.agent, { ...findingRequest(), title: ' ' }))
      .toThrow('title must be a non-empty string')
    expect(() => ctx.hardLedger.proposeFinding(root.agent, { ...findingRequest(), cvssVector: 'CVSS:3.1/AV:N' }))
      .toThrow('cvssVector must start with CVSS:4.0/')
    expect(() => ctx.hardLedger.proposeFinding(root.agent, { ...findingRequest(), cvssClaimed: 11 }))
      .toThrow('cvssClaimed must be a number between 0 and 10')
    expect(() => ctx.hardLedger.proposeFinding(root.agent, { ...findingRequest(), claimHash: 'nothex' }))
      .toThrow('claimHash must be 64 lowercase hex characters')
    expect(() => ctx.hardLedger.proposeFinding(root.agent, { ...findingRequest(), fingerprint: 'C'.repeat(64) }))
      .toThrow('fingerprint must be 64 lowercase hex characters')
    expect(() => ctx.hardLedger.proposeFinding(root.agent, { ...findingRequest(), claim: 'x'.repeat(2001) }))
      .toThrow('claim must not exceed 2000 characters')
  })

  it('reports unverified and flaky findings as open work', async () => {
    const { ctx, root } = await harness()
    const id = ctx.hardLedger.proposeFinding(root.agent, findingRequest())
    expect(ctx.hardLedger.openWork(root.agent)).toEqual([`finding ${id} awaits verification`])
    ctx.hardLedger.recordVerdict(root.agent, {
      id,
      verdict: 'flaky',
      runs: 3,
      cvssComputed: 9.3,
      cvssMatch: true,
      reason: 'run 2 exited 1 without printing the claim hash',
      fingerprint: FINGERPRINT,
    })
    expect(ctx.hardLedger.openWork(root.agent)).toEqual([`finding ${id} is flaky: run 2 exited 1 without printing the claim hash`])
  })
})

describe('hard ledger hypotheses', () => {
  it('assigns H ids, transitions by id, and requires reasons for terminal doubts', async () => {
    const { ctx, root } = await harness()
    const id = ctx.hardLedger.writeHypothesis(root.agent, {
      statement: 'The refresh endpoint accepts a reused token once inside its grace window.',
      status: 'proposed',
    })
    expect(id).toBe('H-1')
    ctx.hardLedger.writeHypothesis(root.agent, { id, statement: 'same', status: 'testing' })
    ctx.hardLedger.writeHypothesis(root.agent, {
      id, statement: 'same', status: 'refuted',
      reason: 'grace window replay returns 401 with the replay audit event',
    })
    const folded = ctx.hardLedger.hypotheses(root.agent)
    expect(folded).toHaveLength(1)
    expect(folded[0]).toMatchObject({ id: 'H-1', status: 'refuted' })
  })

  it('rejects unknown ids, testing without id, and missing reasons', async () => {
    const { ctx, root } = await harness()
    expect(() => ctx.hardLedger.writeHypothesis(root.agent, { statement: 'x', status: 'testing' }))
      .toThrow('status testing requires an existing hypothesis id')
    const id = ctx.hardLedger.writeHypothesis(root.agent, { statement: 'x', status: 'proposed' })
    expect(() => ctx.hardLedger.writeHypothesis(root.agent, { id: 'H-9', statement: 'x', status: 'testing' }))
      .toThrow('unknown hypothesis id H-9')
    expect(() => ctx.hardLedger.writeHypothesis(root.agent, {
      id, statement: 'x', status: 'deferred',
    })).toThrow('status deferred requires a concrete reason')
  })

  it('lists open hypotheses as open work across statuses', async () => {
    const { ctx, root } = await harness()
    const first = ctx.hardLedger.writeHypothesis(root.agent, { statement: 'state confusion', status: 'proposed' })
    const second = ctx.hardLedger.writeHypothesis(root.agent, { statement: 'grace window replay', status: 'proposed' })
    ctx.hardLedger.writeHypothesis(root.agent, { id: first, statement: 'state confusion', status: 'testing' })
    ctx.hardLedger.writeHypothesis(root.agent, {
      id: second, statement: 'grace window replay', status: 'deferred', reason: 'needs credentials',
    })
    expect(ctx.hardLedger.openWork(root.agent)).toEqual([
      'hypothesis H-1 is testing',
      'hypothesis H-2 is deferred',
    ])
    ctx.hardLedger.writeHypothesis(root.agent, {
      id: first, statement: 'state confusion', status: 'refuted', reason: 'replay audit refutes it',
    })
    ctx.hardLedger.writeHypothesis(root.agent, {
      id: second, statement: 'grace window replay', status: 'confirmed',
    })
    expect(ctx.hardLedger.openWork(root.agent)).toEqual([])
  })
})

describe('hard ledger coverage and sweeps', () => {
  it('keeps unrelated cells untouched when updating one cell or hypothesis', async () => {
    const { ctx, root } = await harness()
    const first = ctx.hardLedger.writeHypothesis(root.agent, { statement: 'one', status: 'proposed' })
    ctx.hardLedger.writeHypothesis(root.agent, { statement: 'two', status: 'proposed' })
    ctx.hardLedger.markCoverage(root.agent, { module: 'a', bugClass: 'sqli', verdict: 'suspicious', declaredSinks: [] })
    ctx.hardLedger.markCoverage(root.agent, { module: 'b', bugClass: 'authz', verdict: 'uncovered', declaredSinks: [] })

    ctx.hardLedger.writeHypothesis(root.agent, { id: first, statement: 'one', status: 'testing' })
    const hypotheses = ctx.hardLedger.hypotheses(root.agent)
    expect(hypotheses[0]).toMatchObject({ id: 'H-1', status: 'testing' })
    expect(hypotheses[1]).toMatchObject({ id: 'H-2', status: 'proposed' })
    ctx.hardLedger.markCoverage(root.agent, { module: 'a', bugClass: 'sqli', verdict: 'cleared', declaredSinks: ['a:1'] })
    const cells = ctx.hardLedger.coverage(root.agent)
    expect(cells[0]).toMatchObject({ module: 'a', verdict: 'cleared' })
    expect(cells[1]).toMatchObject({ module: 'b', verdict: 'uncovered' })
  })

  it('keeps the latest verdict per module and class and requires sinks for cleared', async () => {
    const { ctx, root } = await harness()
    expect(() => { ctx.hardLedger.markCoverage(root.agent, {
      module: 'src/db', bugClass: 'sqli', verdict: 'cleared', declaredSinks: [],
    }) }).toThrow('cleared requires the declared sinks inspected for this cell')
    expect(() => { ctx.hardLedger.markCoverage(root.agent, {
      module: 'src/db', bugClass: 'sqli', verdict: 'sealed' as never, declaredSinks: [],
    }) }).toThrow('verdict must be one of cleared, suspicious, uncovered')
    ctx.hardLedger.markCoverage(root.agent, {
      module: 'src/db', bugClass: 'sqli', verdict: 'suspicious', declaredSinks: [],
    })
    ctx.hardLedger.markCoverage(root.agent, {
      module: 'src/db', bugClass: 'sqli', verdict: 'cleared',
      declaredSinks: ['src/db/query.ts:42 rawQuery()', 'src/db/search.ts:17 orderBy()'],
    })
    const cells = ctx.hardLedger.coverage(root.agent)
    expect(cells).toHaveLength(1)
    expect(cells[0]).toMatchObject({ verdict: 'cleared' })
  })

  it('requires empty-sweep proof and validates counters', async () => {
    const { ctx, root } = await harness()
    expect(() => { ctx.hardLedger.recordSweep(root.agent, { phase: 'A', cellsTouched: 4, newFindings: 0 }) })
      .toThrow('an empty sweep requires emptyProof evidence')
    expect(() => { ctx.hardLedger.recordSweep(root.agent, { phase: 'A', cellsTouched: -1, newFindings: 1 }) })
      .toThrow('cellsTouched must be a non-negative safe integer')
    expect(() => { ctx.hardLedger.recordSweep(root.agent, { phase: 'A', cellsTouched: 1, newFindings: -1 }) })
      .toThrow('newFindings must be a non-negative safe integer')
    ctx.hardLedger.recordSweep(root.agent, {
      phase: 'A', cellsTouched: 4, newFindings: 0,
      emptyProof: 'H-1 refuted with replay evidence; cell src/db x sqli cleared',
    })
    expect(ctx.hardLedger.sweepCount(root.agent, 'A')).toBe(1)
    expect(ctx.hardLedger.sweepCount(root.agent, 'B')).toBe(0)
  })
})

describe('hard ledger projection units', () => {
  it('ignores a verdict for an unknown finding id', async () => {
    const { ctx, root } = await harness()
    ctx.hardLedger.recordVerdict(root.agent, {
      id: 'F-9' as never,
      verdict: 'confirmed',
      runs: 1,
      cvssComputed: 5,
      cvssMatch: true,
      reason: 'orphan verdict',
      fingerprint: FINGERPRINT,
    })
    expect(ctx.hardLedger.findings(root.agent)).toEqual([])
    expect(ctx.hardLedger.openWork(root.agent)).toEqual([])
  })

  it('accepts deferred with reason, uncovered without sinks, and counts phase B sweeps', async () => {
    const { ctx, root } = await harness()
    const id = ctx.hardLedger.writeHypothesis(root.agent, { statement: 'x', status: 'proposed' })
    ctx.hardLedger.writeHypothesis(root.agent, {
      id, statement: 'x', status: 'deferred', reason: 'retry when credentials exist',
    })
    ctx.hardLedger.markCoverage(root.agent, {
      module: 'src/db', bugClass: 'sqli', verdict: 'uncovered', declaredSinks: [],
    })
    ctx.hardLedger.recordSweep(root.agent, { phase: 'B', cellsTouched: 1, newFindings: 1 })
    expect(ctx.hardLedger.hypotheses(root.agent)[0]).toMatchObject({ status: 'deferred' })
    expect(ctx.hardLedger.coverage(root.agent)[0]).toMatchObject({ verdict: 'uncovered' })
    expect(ctx.hardLedger.sweepCount(root.agent, 'B')).toBe(1)
  })

  it('rejects non-string text and overlong empty proofs', async () => {
    const { ctx, root } = await harness()
    expect(() => ctx.hardLedger.proposeFinding(root.agent, {
      ...findingRequest(), title: undefined as never,
    })).toThrow('title must be a non-empty string')
    expect(() => { ctx.hardLedger.recordSweep(root.agent, {
      phase: 'A', cellsTouched: 1, newFindings: 0, emptyProof: 'x'.repeat(2001),
    }) }).toThrow('emptyProof must not exceed 2000 characters')
  })
})

describe('hard ledger coverage matrix', () => {
  /** Arm one three-module, two-class matrix on the harness root. */
  function armMatrix(ctx: Context, root: StubAgent): void {
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'c'.repeat(40),
      modules: ['.', 'src', 'src/parser'],
      bugClasses: ['cmdi', 'sqli'],
    })
  }

  it('folds the arming record into the matrix and counts verdicted cells over the total', async () => {
    const { ctx, root } = await harness()
    expect(ctx.hardLedger.coverageMatrix(root.agent)).toBeUndefined()
    expect(ctx.hardLedger.coverageProgress(root.agent)).toEqual({ verdicted: 0, total: 0 })
    expect(ctx.hardLedger.uncoveredCells(root.agent)).toEqual([])

    armMatrix(ctx, root)
    expect(ctx.hardLedger.coverageMatrix(root.agent)).toEqual({
      modules: ['.', 'src', 'src/parser'],
      bugClasses: ['cmdi', 'sqli'],
      targetRepo: '/tmp/hard-target',
      commit: 'c'.repeat(40),
    })
    expect(ctx.hardLedger.coverageProgress(root.agent)).toEqual({ verdicted: 0, total: 6 })
    ctx.hardLedger.markCoverage(root.agent, { module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['s'] })
    ctx.hardLedger.markCoverage(root.agent, { module: 'outside', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['s'] })
    expect(ctx.hardLedger.coverageProgress(root.agent)).toEqual({ verdicted: 1, total: 6 })
    expect(ctx.hardLedger.uncoveredCells(root.agent)).toEqual([
      { module: '.', bugClass: 'cmdi' },
      { module: '.', bugClass: 'sqli' },
      { module: 'src', bugClass: 'sqli' },
      { module: 'src/parser', bugClass: 'cmdi' },
      { module: 'src/parser', bugClass: 'sqli' },
    ])
  })

  it('lists uncovered and suspicious cells as open work, and keeps legacy logs unchanged', async () => {
    const { ctx, root } = await harness()
    expect(ctx.hardLedger.openWork(root.agent)).toEqual([])

    armMatrix(ctx, root)
    const open = ctx.hardLedger.openWork(root.agent)
    expect(open[0]).toContain('6 coverage cell(s) have no verdict yet')
    expect(open).toContain('cell . × cmdi has no verdict')

    ctx.hardLedger.markCoverage(root.agent, { module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['s'] })
    ctx.hardLedger.markCoverage(root.agent, { module: 'src', bugClass: 'sqli', verdict: 'suspicious', declaredSinks: [] })
    const after = ctx.hardLedger.openWork(root.agent)
    expect(after).toContain('cell src × sqli is suspicious: re-verify the declared sinks')
    expect(after).not.toContain('cell src × cmdi has no verdict')
  })

  it('rejects invalid arming records with stable codes', async () => {
    const { ctx, root } = await harness()
    const armed = {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'c'.repeat(40),
      modules: ['src'],
      bugClasses: ['cmdi'],
    }
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, { ...armed, commit: 'HEAD' }) })
      .toThrow('commit must be a full lowercase hex sha')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, { ...armed, modules: [] }) })
      .toThrow('modules must list at least one module')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, {
      ...armed, modules: Array.from({ length: 501 }, (_, index) => `m${index}`),
    }) }).toThrow('modules must not exceed 500 rows')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, { ...armed, modules: ['b', 'a'] }) })
      .toThrow('modules must be sorted and deduplicated')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, { ...armed, modules: ['a', 'a'] }) })
      .toThrow('modules must be sorted and deduplicated')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, { ...armed, bugClasses: ['ok', ' '] }) })
      .toThrow('bugClasses[] must be a non-empty string')
    ctx.hardLedger.recordMissionArmed(root.agent, armed)
    expect(ctx.hardLedger.coverageProgress(root.agent)).toEqual({ verdicted: 0, total: 1 })
  })
})

describe('hard ledger service shape', () => {
  it('is a default-exported service on the hardLedger key', async () => {
    const { ctx } = await harness()
    expect(ctx.hardLedger).toBeInstanceOf(HardLedger)
    expect(HardLedger.name).toBe('HardLedger')
  })

  it('survives the Loader namespace rules for class plugins', () => {
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(HardLedger)).toBe(HardLedger)
  })
})
