/** The ledger appends hard/* events, assigns ids from the log, and folds state back from it. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import type { HardSweepSummaryData } from '@deepseek-ai/dsh-experimental-hard-ledger'
import { applyHardLedgerProjection, blindClearsFromState, completionAssessmentFromState, matrixBoardFromState, openWorkCountsFromState, coverageBySourceFromState, coverageProgressFromState, DEFAULT_SCREEN_SPOT_CHECK_PERCENT, emptyHardLedgerState, hardLedgerProjectionDefinition, matrixCellsFromState, refutationBreakdownFromState } from '@deepseek-ai/dsh-experimental-hard-ledger'
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

async function harness(config: { screenSpotCheckPercent?: number; emptySweepsToFinish?: number } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const fiber = await ctx.plugin(HardLedger, config)
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
    payload: "x' OR 1=1 --",
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
    expect(() => ctx.hardLedger.proposeFinding(root.agent, { ...findingRequest(), payload: ' ' }))
      .toThrow('payload must be a non-empty string')
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

  it('decomposes refuted verdicts by cause and reads legacy verdicts as unattributed', async () => {
    const { ctx, root } = await harness()
    const causes = ['benign-arm-passed', 'no-marker', 'nonzero-exit', 'timeout', 'no-runs'] as const
    for (const [index, cause] of causes.entries()) {
      const request = {
        ...findingRequest(),
        component: `src/auth/login${String(index)}.ts`,
        fingerprint: `${'b'.repeat(63)}${String(index)}`,
      }
      const id = ctx.hardLedger.proposeFinding(root.agent, request)
      ctx.hardLedger.recordVerdict(root.agent, {
        id,
        verdict: 'refuted',
        runs: cause === 'no-runs' ? 0 : 1,
        cvssComputed: 9.3,
        cvssMatch: true,
        reason: 'r',
        fingerprint: request.fingerprint,
        cause,
      })
    }
    // A verdict recorded before the cause codes existed folds unchanged.
    const legacyRequest = { ...findingRequest(), component: 'src/auth/legacy.ts', fingerprint: 'c'.repeat(64) }
    const legacyId = ctx.hardLedger.proposeFinding(root.agent, legacyRequest)
    ctx.hardLedger.recordVerdict(root.agent, {
      id: legacyId,
      verdict: 'refuted',
      runs: 2,
      cvssComputed: 9.3,
      cvssMatch: true,
      reason: 'r',
      fingerprint: legacyRequest.fingerprint,
    })

    expect(ctx.hardLedger.refutationBreakdown(root.agent)).toEqual({
      byCause: { 'benign-arm-passed': 1, 'no-marker': 1, 'nonzero-exit': 1, timeout: 1, 'no-runs': 1, unattributed: 1 },
      protocolFailures: 2,
      genuineRefutations: 1,
      infrastructure: 2,
    })
    expect(ctx.hardLedger.findings(root.agent).at(-1)?.verdict?.cause).toBeUndefined()
  })

  it('accepts the zero-run benign refutation shape in the projection schema', async () => {
    const { emptyHardLedgerState, hardLedgerStateSchema } = await import('@deepseek-ai/dsh-experimental-hard-ledger')
    const state = emptyHardLedgerState()
    const parsed = hardLedgerStateSchema.parse({
      ...state,
      findings: [{
        proposed: { ...findingRequest(), id: 'F-1' },
        verdict: {
          id: 'F-1', verdict: 'refuted', runs: 0, cvssComputed: 9.3, cvssMatch: true,
          reason: 'the proof passes with a benign payload, so it does not depend on the exploit input',
          fingerprint: FINGERPRINT, benignArm: 'passed', cause: 'benign-arm-passed',
        },
      }],
    })
    expect(parsed.findings[0]?.verdict?.runs).toBe(0)
    expect(parsed.findings[0]?.verdict?.cause).toBe('benign-arm-passed')
    // Cached states from before the flow-document event carry no flowDocs at
    // all; the schema must keep reading them.
    expect(parsed.flowDocs).toBeUndefined()
    const withFlow = hardLedgerStateSchema.parse({
      ...state,
      flowDocs: [{ module: 'src/web', sections: { entryPoints: 1, dataflows: 0, trustBoundaries: 0, stateMachines: 0, assumptions: 0, quirks: 0 }, citations: 1 }],
    })
    expect(withFlow.flowDocs).toHaveLength(1)
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
      .toThrow('an empty sweep requires emptyProofRef or emptyProofFlowDoc evidence')
    expect(() => { ctx.hardLedger.recordSweep(root.agent, {
      phase: 'A', cellsTouched: -1, newFindings: 1, emptyProofRef: { kind: 'hypothesis', hypothesisId: 'H-1' },
    }) }).toThrow('cellsTouched must be a non-negative safe integer')
    expect(() => { ctx.hardLedger.recordSweep(root.agent, {
      phase: 'A', cellsTouched: 1, newFindings: -1, emptyProofRef: { kind: 'hypothesis', hypothesisId: 'H-1' },
    }) }).toThrow('newFindings must be a non-negative safe integer')
    // A sweep that produced findings must not carry an empty proof.
    expect(() => { ctx.hardLedger.recordSweep(root.agent, {
      phase: 'A', cellsTouched: 1, newFindings: 2, emptyProofRef: { kind: 'hypothesis', hypothesisId: 'H-1' },
    }) }).toThrow('a sweep with findings carries no empty proof')
    ctx.hardLedger.writeHypothesis(root.agent, { statement: 'rebuilt parser', status: 'proposed' })
    ctx.hardLedger.writeHypothesis(root.agent, {
      id: 'H-1', statement: 'rebuilt parser', status: 'refuted', reason: 'the parser never accepts user input',
    })
    ctx.hardLedger.recordSweep(root.agent, {
      phase: 'A', cellsTouched: 4, newFindings: 0,
      emptyProofRef: { kind: 'hypothesis', hypothesisId: 'H-1' },
    })
    expect(ctx.hardLedger.sweepCount(root.agent, 'A')).toBe(1)
    expect(ctx.hardLedger.sweepCount(root.agent, 'B')).toBe(0)
    expect(ctx.hardLedger.emptySweepRun(root.agent)).toBe(1)
  })
})

describe('hard ledger flow documents', () => {
  const FULL_SECTIONS = {
    entryPoints: 1, dataflows: 2, trustBoundaries: 0, stateMachines: 0, assumptions: 1, quirks: 1,
  }

  it('records flow documents, folds the latest per module, and rejects inconsistent counts', async () => {
    const { ctx, root } = await harness()
    ctx.hardLedger.recordFlowDoc(root.agent, {
      module: 'src/web', sections: FULL_SECTIONS, citations: 5, quirkIds: ['H-1'],
    })
    ctx.hardLedger.recordFlowDoc(root.agent, {
      module: 'src/web', sections: { ...FULL_SECTIONS, quirks: 0 }, citations: 4,
    })
    const docs = ctx.hardLedger.flowDocs(root.agent)
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ module: 'src/web', citations: 4, sections: { quirks: 0 } })
    expect(docs[0]?.quirkIds).toBeUndefined()
    // The summary counts must agree: every entry carries exactly one citation.
    expect(() => { ctx.hardLedger.recordFlowDoc(root.agent, {
      module: 'src/db', sections: FULL_SECTIONS, citations: 4,
    }) }).toThrow('citations must equal the sum of the section counts')
    expect(() => { ctx.hardLedger.recordFlowDoc(root.agent, {
      module: 'src/db', sections: { ...FULL_SECTIONS, entryPoints: -1 }, citations: 5,
    }) }).toThrow('sections.entryPoints must be a non-negative safe integer')
    expect(() => { ctx.hardLedger.recordFlowDoc(root.agent, {
      module: 'src/db', sections: FULL_SECTIONS, citations: 5, quirkIds: ['H-1', 'H-2'],
    }) }).toThrow('quirkIds must name every recorded quirk')
  })

  it('accepts a recorded flow document as an empty-sweep proof and rejects unrecorded or citation-free ones', async () => {
    const { ctx, root } = await harness()
    expect(() => { ctx.hardLedger.recordSweep(root.agent, {
      phase: 'B', cellsTouched: 1, newFindings: 0, emptyProofFlowDoc: 'src/web',
    }) }).toThrow('empty sweep proof must cite a recorded flow document; none exists for src/web')
    ctx.hardLedger.recordFlowDoc(root.agent, {
      module: 'src/web', sections: { entryPoints: 0, dataflows: 0, trustBoundaries: 0, stateMachines: 0, assumptions: 0, quirks: 0 },
      citations: 0,
    })
    expect(() => { ctx.hardLedger.recordSweep(root.agent, {
      phase: 'B', cellsTouched: 1, newFindings: 0, emptyProofFlowDoc: 'src/web',
    }) }).toThrow('empty sweep proof must cite a flow document with resolvable citations; src/web recorded none')
    ctx.hardLedger.recordFlowDoc(root.agent, {
      module: 'src/db', sections: FULL_SECTIONS, citations: 5, quirkIds: ['H-1'],
    })
    ctx.hardLedger.recordSweep(root.agent, {
      phase: 'B', cellsTouched: 1, newFindings: 0, emptyProofFlowDoc: 'src/db',
    })
    expect(ctx.hardLedger.sweepCount(root.agent, 'B')).toBe(1)
    expect(ctx.hardLedger.emptySweepRun(root.agent)).toBe(1)
    // The reference and the flow-document proof are mutually exclusive.
    expect(() => { ctx.hardLedger.recordSweep(root.agent, {
      phase: 'B', cellsTouched: 1, newFindings: 0,
      emptyProofRef: { kind: 'cell', module: 'src/db', bugClass: 'sqli' }, emptyProofFlowDoc: 'src/db',
    }) }).toThrow('emptyProofRef and emptyProofFlowDoc are mutually exclusive')
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

  it('rejects non-string text and half-specified empty proofs', async () => {
    const { ctx, root } = await harness()
    expect(() => ctx.hardLedger.proposeFinding(root.agent, {
      ...findingRequest(), title: undefined as never,
    })).toThrow('title must be a non-empty string')
    expect(() => { ctx.hardLedger.recordSweep(root.agent, {
      phase: 'A', cellsTouched: 1, newFindings: 0, emptyProofRef: { kind: 'hypothesis', hypothesisId: ' ' },
    }) }).toThrow('emptyProofRef.hypothesisId must be a non-empty string')
    expect(() => { ctx.hardLedger.recordSweep(root.agent, {
      phase: 'A', cellsTouched: 1, newFindings: 0, emptyProofRef: { kind: 'cell', module: ' ', bugClass: 'sqli' },
    }) }).toThrow('emptyProofRef.module must be a non-empty string')
  })

  describe('empty sweep proofs', () => {
    it('accepts a refuted hypothesis and rejects unknown or unresolved ones', async () => {
      const { ctx, root } = await harness()
      const id = ctx.hardLedger.writeHypothesis(root.agent, { statement: 'login is replayable', status: 'proposed' })
      expect(() => { ctx.hardLedger.recordSweep(root.agent, {
        phase: 'A', cellsTouched: 1, newFindings: 0, emptyProofRef: { kind: 'hypothesis', hypothesisId: 'H-9' },
      }) }).toThrow('unknown hypothesis id H-9')
      expect(() => { ctx.hardLedger.recordSweep(root.agent, {
        phase: 'A', cellsTouched: 1, newFindings: 0, emptyProofRef: { kind: 'hypothesis', hypothesisId: id },
      }) }).toThrow('empty sweep proof must cite a refuted hypothesis; H-1 is proposed')
      ctx.hardLedger.writeHypothesis(root.agent, {
        id, statement: 'login is replayable', status: 'refuted', reason: 'replay returns 401',
      })
      ctx.hardLedger.recordSweep(root.agent, {
        phase: 'A', cellsTouched: 1, newFindings: 0, emptyProofRef: { kind: 'hypothesis', hypothesisId: id },
      })
      expect(ctx.hardLedger.emptySweepRun(root.agent)).toBe(1)
    })

    it('accepts a model-cleared cell and rejects unknown, uncleared, or harness-screened ones', async () => {
      const { ctx, root } = await harness()
      const sweep = (module: string, bugClass: string): HardSweepSummaryData => ({
        phase: 'A', cellsTouched: 1, newFindings: 0, emptyProofRef: { kind: 'cell', module, bugClass },
      })
      expect(() => { ctx.hardLedger.recordSweep(root.agent, sweep('src/db', 'sqli')) })
        .toThrow('unknown coverage cell src/db × sqli')
      ctx.hardLedger.markCoverage(root.agent, { module: 'src/db', bugClass: 'sqli', verdict: 'uncovered', declaredSinks: [] })
      expect(() => { ctx.hardLedger.recordSweep(root.agent, sweep('src/db', 'sqli')) })
        .toThrow('empty sweep proof must cite a cleared cell with declared sinks; src/db × sqli is uncovered')
      ctx.hardLedger.markCoverage(root.agent, {
        module: 'src/db', bugClass: 'sqli', verdict: 'cleared', declaredSinks: ['src/db/query.ts:42 rawQuery()'],
      })
      ctx.hardLedger.recordSweep(root.agent, sweep('src/db', 'sqli'))
      // A batch clear the harness grep verified still counts as model work.
      ctx.hardLedger.markCoverage(root.agent, {
        module: 'src/auth', bugClass: 'cmdi', verdict: 'cleared',
        declaredSinks: ['execSync'], source: 'model-verified',
      })
      ctx.hardLedger.recordSweep(root.agent, sweep('src/auth', 'cmdi'))
      expect(ctx.hardLedger.emptySweepRun(root.agent)).toBe(2)
      // A purely mechanical screen proves nothing about this sweep's work.
      ctx.hardLedger.markCoverage(root.agent, {
        module: 'src/ui', bugClass: 'xss', verdict: 'cleared',
        declaredSinks: ['innerHTML'], source: 'harness',
      })
      expect(() => { ctx.hardLedger.recordSweep(root.agent, sweep('src/ui', 'xss')) })
        .toThrow('empty sweep proof cannot cite a harness-screened cell')
    })
  })

  describe('completion assessment', () => {
    /** Arm a two-module two-class matrix; optionally give every cell a model verdict. */
    function armAndCover(ctx: Context, agent: Agent, cover: boolean): void {
      ctx.hardLedger.recordMissionArmed(agent, {
        objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'd'.repeat(40),
        modules: ['src/auth', 'src/db'], bugClasses: ['cmdi', 'sqli'],
      })
      if (!cover) return
      for (const module of ['src/auth', 'src/db']) {
        for (const bugClass of ['cmdi', 'sqli']) {
          ctx.hardLedger.markCoverage(agent, {
            module, bugClass, verdict: 'cleared', declaredSinks: [`${module}:1 sink()`],
          })
        }
      }
    }

    it('blocks on open work and the trailing empty sweeps, then certifies with enough of both', async () => {
      const { ctx, root } = await harness({ emptySweepsToFinish: 0 })
      armAndCover(ctx, root.agent, false)
      // Unverdicted matrix cells are the open work.
      const uncovered = ctx.hardLedger.completionAssessment(root.agent)
      expect(uncovered.complete).toBe(false)
      expect(uncovered.blockers[0]).toContain('4 coverage cell(s) have no verdict yet')

      armAndCover(ctx, root.agent, true)
      // With the sweep condition off, verdicts without a source read as model,
      // so the audit floor is satisfied and nothing else stands.
      expect(ctx.hardLedger.completionAssessment(root.agent)).toEqual({ complete: true, blockers: [] })

      const gated = await harness()
      armAndCover(gated.ctx, gated.root.agent, true)
      // Verdicts without a source read as model, so the audit floor is satisfied;
      // only the trailing-sweep condition stands at the ledger's configured 2.
      const noSweeps = gated.ctx.hardLedger.completionAssessment(gated.root.agent)
      expect(noSweeps.complete).toBe(false)
      expect(noSweeps.blockers).toEqual(['0 of 2 final sweeps are empty-verified'])

      gated.ctx.hardLedger.recordSweep(gated.root.agent, {
        phase: 'A', cellsTouched: 4, newFindings: 0, emptyProofRef: { kind: 'cell', module: 'src/db', bugClass: 'sqli' },
      })
      const oneSweep = gated.ctx.hardLedger.completionAssessment(gated.root.agent)
      expect(oneSweep.complete).toBe(false)
      expect(oneSweep.blockers).toEqual(['1 of 2 final sweeps are empty-verified'])

      gated.ctx.hardLedger.recordSweep(gated.root.agent, {
        phase: 'B', cellsTouched: 4, newFindings: 0, emptyProofRef: { kind: 'cell', module: 'src/db', bugClass: 'cmdi' },
      })
      expect(gated.ctx.hardLedger.completionAssessment(gated.root.agent)).toEqual({ complete: true, blockers: [] })
    })

    it('treats a harness-screened repository as unaudited even when every cell is verdicted', async () => {
      const { ctx, root } = await harness({ emptySweepsToFinish: 0 })
      ctx.hardLedger.recordMissionArmed(root.agent, {
        objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'd'.repeat(40),
        modules: ['notes'], bugClasses: ['cmdi'], inertModules: ['notes'],
      })
      // The screen pre-verdicts the only cell, so no open work stands and the sweep
      // condition is off — the model-audit floor is the single blocker.
      const floored = ctx.hardLedger.completionAssessment(root.agent)
      expect(floored.complete).toBe(false)
      expect(floored.blockers).toEqual(['no model-audited coverage cell or resolved hypothesis exists yet'])
      const id = ctx.hardLedger.writeHypothesis(root.agent, { statement: 'the parser accepts raw bytes', status: 'proposed' })
      ctx.hardLedger.writeHypothesis(root.agent, {
        id, statement: 'the parser accepts raw bytes', status: 'refuted', reason: 'the parser rejects them',
      })
      expect(ctx.hardLedger.completionAssessment(root.agent)).toEqual({ complete: true, blockers: [] })
    })

    it('does not count a batch screen toward the audit floor; one per-cell model read does', async () => {
      // The re-read spot check is off so the batch screen leaves no open work behind.
      const { ctx, root } = await harness({ emptySweepsToFinish: 0, screenSpotCheckPercent: 0 })
      ctx.hardLedger.recordMissionArmed(root.agent, {
        objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'd'.repeat(40),
        modules: ['src/auth', 'src/db'], bugClasses: ['cmdi'],
      })
      for (const module of ['src/auth', 'src/db']) {
        ctx.hardLedger.markCoverage(root.agent, {
          module, bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['execSync'], source: 'model-verified',
        })
      }
      // Every cell is verdicted, but the model read none of them.
      const screened = ctx.hardLedger.completionAssessment(root.agent)
      expect(screened.complete).toBe(false)
      expect(screened.blockers).toEqual(['no model-audited coverage cell or resolved hypothesis exists yet'])
      ctx.hardLedger.markCoverage(root.agent, {
        module: 'src/db', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['src/db/index.js:runQuery'],
      })
      expect(ctx.hardLedger.completionAssessment(root.agent)).toEqual({ complete: true, blockers: [] })
    })

    it('lists bounded open-work blockers with the remainder summary', async () => {
      const { ctx, root } = await harness({ emptySweepsToFinish: 0 })
      ctx.hardLedger.recordMissionArmed(root.agent, {
        objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'd'.repeat(40),
        modules: ['src'], bugClasses: ['cmdi'],
      })
      for (let index = 0; index < 9; index += 1) {
        ctx.hardLedger.writeHypothesis(root.agent, { statement: `hypothesis ${index}`, status: 'proposed' })
      }
      ctx.hardLedger.proposeFinding(root.agent, findingRequest())
      const assessment = ctx.hardLedger.completionAssessment(root.agent)
      expect(assessment.complete).toBe(false)
      // Open work lists findings first, then hypotheses, then coverage: 12 items
      // here, so the bound keeps 8, summarizes 4, and the audit floor trails last.
      expect(assessment.blockers.filter(blocker => blocker.startsWith('hypothesis H-'))).toHaveLength(7)
      expect(assessment.blockers[8]).toContain('4 more open item(s)')
      expect(assessment.blockers.at(-1)).toBe('no model-audited coverage cell or resolved hypothesis exists yet')
    })

    it('counts only the trailing run of empty sweeps', async () => {
      const { ctx, root } = await harness()
      armAndCover(ctx, root.agent, true)
      ctx.hardLedger.recordSweep(root.agent, {
        phase: 'A', cellsTouched: 4, newFindings: 0, emptyProofRef: { kind: 'cell', module: 'src/db', bugClass: 'sqli' },
      })
      ctx.hardLedger.recordSweep(root.agent, { phase: 'B', cellsTouched: 4, newFindings: 2 })
      ctx.hardLedger.recordSweep(root.agent, {
        phase: 'A', cellsTouched: 4, newFindings: 0, emptyProofRef: { kind: 'cell', module: 'src/db', bugClass: 'sqli' },
      })
      expect(ctx.hardLedger.emptySweepRun(root.agent)).toBe(1)
      const assessment = ctx.hardLedger.completionAssessment(root.agent)
      expect(assessment.complete).toBe(false)
      expect(assessment.blockers).toContain('1 of 2 final sweeps are empty-verified')
    })
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
    // A module outside the armed rows is refused; the invalid cell never lands.
    expect(() => { ctx.hardLedger.markCoverage(root.agent, { module: 'outside', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['s'] }) })
      .toThrow('module "outside" is not in the armed coverage matrix; the matrix rows at commit')
    expect(ctx.hardLedger.coverageProgress(root.agent)).toEqual({ verdicted: 1, total: 6 })
    // Matrix order: sorted modules outer, the configured class order inner —
    // the loop's own order, no re-sort.
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

  it('names the valid matrix rows when refusing outside modules, and passes everything without a matrix', async () => {
    const { ctx, root } = await harness()
    // No armed matrix (mission not mounted, or a legacy log): every module passes.
    ctx.hardLedger.markCoverage(root.agent, { module: 'anywhere', bugClass: 'cmdi', verdict: 'uncovered', declaredSinks: [] })
    expect(ctx.hardLedger.coverage(root.agent)).toHaveLength(1)

    armMatrix(ctx, root)
    expect(() => { ctx.hardLedger.assertModulesInMatrix(root.agent, ['src', 'poc']) })
      .toThrow(`module "poc" is not in the armed coverage matrix; the matrix rows at commit ${'c'.repeat(40)} are: ., src, src/parser`)
    expect(() => { ctx.hardLedger.assertModulesInMatrix(root.agent, ['poc', 'tmp']) })
      .toThrow('modules "poc", "tmp" are not in the armed coverage matrix')
    // Rows of the matrix, including the repository root, pass unchanged.
    ctx.hardLedger.assertModulesInMatrix(root.agent, ['.', 'src', 'src/parser'])
    ctx.hardLedger.markCoverage(root.agent, { module: '.', bugClass: 'sqli', verdict: 'uncovered', declaredSinks: [] })
  })

  it('refuses a cleared verdict on an inert module but keeps suspicious passable', async () => {
    const { ctx, root } = await harness()
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'c'.repeat(40),
      modules: ['data/manuals', 'docs', 'src'],
      bugClasses: ['cmdi', 'sqli'],
      inertModules: ['data/manuals', 'docs'],
    })
    // Cleared there duplicates the harness screen — the pilot's second run
    // burned four cells on exactly this.
    expect(() => { ctx.hardLedger.markCoverage(root.agent, {
      module: 'data/manuals', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['exec'],
    }) }).toThrow('module "data/manuals" is inert — the harness already screened it as containing no code')
    // A real sighting must surface, so suspicious still records.
    ctx.hardLedger.markCoverage(root.agent, { module: 'data/manuals', bugClass: 'cmdi', verdict: 'suspicious', declaredSinks: [] })
    expect(ctx.hardLedger.coverage(root.agent)).toHaveLength(1)
    // Non-inert modules clear normally.
    ctx.hardLedger.markCoverage(root.agent, { module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['exec'] })
    expect(ctx.hardLedger.coverage(root.agent)).toHaveLength(2)
    // A batch listing several inert modules names them all in the plural.
    expect(() => { ctx.hardLedger.assertClearableModules(root.agent, ['src', 'data/manuals', 'docs']) })
      .toThrow('modules "data/manuals", "docs" are inert — the harness already screened them as containing no code')
  })

  it('bounds the valid-rows list in the rejection message', async () => {
    const { ctx, root } = await harness()
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'd'.repeat(40),
      modules: Array.from({ length: 14 }, (_, index) => `m${String(index).padStart(2, '0')}`),
      bugClasses: ['cmdi'],
    })
    expect(() => { ctx.hardLedger.assertModulesInMatrix(root.agent, ['poc']) })
      .toThrow(`the matrix rows at commit ${'d'.repeat(40)} are: m00, m01, m02, m03, m04, m05, m06, m07, m08, m09, m10, m11, …and 2 more`)
  })

  it('refuses a batch screen over unscreened modules, naming them, and passes without a screenability record', async () => {
    const { ctx, root } = await harness()
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'c'.repeat(40),
      modules: ['lib', 'src', 'wp/admin'],
      bugClasses: ['cmdi'],
      unscreenedModules: ['lib', 'wp/admin'],
    })
    expect(ctx.hardLedger.coverageMatrix(root.agent)?.unscreenedModules).toEqual(['lib', 'wp/admin'])
    expect(() => { ctx.hardLedger.assertScreenableModules(root.agent, ['src', 'wp/admin']) })
      .toThrow('module "wp/admin" holds a binary file or a language the harness cannot screen, so its grep proves nothing')
    expect(() => { ctx.hardLedger.assertScreenableModules(root.agent, ['lib', 'wp/admin', 'lib']) })
      .toThrow('modules "lib", "wp/admin" hold a binary file or a language the harness cannot screen')
    expect(() => { ctx.hardLedger.assertScreenableModules(root.agent, ['src']) }).not.toThrow()
    // A per-cell verdict stays open on an unscreened module.
    ctx.hardLedger.markCoverage(root.agent, {
      module: 'wp/admin', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['wp/admin/ajax.php:my_delete_item'],
    })
    expect(ctx.hardLedger.blindClears(root.agent)).toBe(1)
    // An arming record without the field, or no matrix at all, screens everything.
    const legacy = await harness()
    expect(() => { legacy.ctx.hardLedger.assertScreenableModules(legacy.root.agent, ['wp/admin']) }).not.toThrow()
    legacy.ctx.hardLedger.recordMissionArmed(legacy.root.agent, {
      objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'c'.repeat(40),
      modules: ['wp/admin'], bugClasses: ['cmdi'],
    })
    expect(() => { legacy.ctx.hardLedger.assertScreenableModules(legacy.root.agent, ['wp/admin']) }).not.toThrow()
    expect(legacy.ctx.hardLedger.blindClears(legacy.root.agent)).toBe(0)
  })

  it('records exclusions and ignored entries, and rejects invalid screenability and exclusion records', async () => {
    const { ctx, root } = await harness()
    const armed = {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'c'.repeat(40),
      modules: ['docs', 'src'],
      bugClasses: ['cmdi'],
    }
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, { ...armed, unscreenedModules: ['src', 'docs'] }) })
      .toThrow('unscreenedModules must be a sorted deduplicated subset of modules')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, { ...armed, unscreenedModules: [' '] }) })
      .toThrow('unscreenedModules must be an array of non-empty module names')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, {
      ...armed, inertModules: ['docs'], unscreenedModules: ['docs'],
    }) }).toThrow('unscreenedModules must be disjoint from inertModules')
    const exclusions = { globs: ['vendor/**'], fileCount: 2, sample: ['vendor/a.php', 'vendor/b.php'] }
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, { ...armed, exclusions: { ...exclusions, globs: [] } }) })
      .toThrow('exclusions must name at least one applied glob')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, { ...armed, exclusions: { ...exclusions, globs: [' '] } }) })
      .toThrow('exclusions.globs[] must be a non-empty string')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, { ...armed, exclusions: { ...exclusions, fileCount: -1 } }) })
      .toThrow('exclusions.fileCount must be a non-negative safe integer')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, { ...armed, exclusions: { ...exclusions, fileCount: 1 } }) })
      .toThrow('exclusions.sample must not exceed the excluded file count or 20 paths')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, {
      ...armed, exclusions: { ...exclusions, fileCount: 30, sample: Array.from({ length: 21 }, (_, index) => `v/${String(index).padStart(2, '0')}`) },
    }) }).toThrow('exclusions.sample must not exceed the excluded file count or 20 paths')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, {
      ...armed, exclusions: { ...exclusions, sample: ['vendor/b.php', 'vendor/a.php'] },
    }) }).toThrow('exclusions.sample must be sorted')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, {
      ...armed, exclusions: { ...exclusions, sample: ['vendor/a.php', ' '] },
    }) }).toThrow('exclusions.sample[] must be a non-empty string')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, { ...armed, ignoredEntryCount: -1 }) })
      .toThrow('ignoredEntryCount must be a non-negative safe integer')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, { ...armed, ignoredEntryCount: 1.5 }) })
      .toThrow('ignoredEntryCount must be a non-negative safe integer')
    ctx.hardLedger.recordMissionArmed(root.agent, {
      ...armed, inertModules: ['docs'], unscreenedModules: ['src'], exclusions, ignoredEntryCount: 3,
    })
    expect(ctx.hardLedger.coverageMatrix(root.agent)).toEqual({
      modules: ['docs', 'src'], bugClasses: ['cmdi'], targetRepo: '/tmp/hard-target', commit: 'c'.repeat(40),
      inertModules: ['docs'], unscreenedModules: ['src'], exclusions, ignoredEntryCount: 3,
    })
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
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, {
      ...armed, inertModules: ['b', 'a'],
    }) }).toThrow('inertModules must be a sorted deduplicated subset of modules')
    expect(() => { ctx.hardLedger.recordMissionArmed(root.agent, {
      ...armed, inertModules: ['nope'],
    }) }).toThrow('inertModules must be a sorted deduplicated subset of modules')
    ctx.hardLedger.recordMissionArmed(root.agent, { ...armed, inertModules: ['src'] })
    expect(ctx.hardLedger.coverageBySource(root.agent)).toEqual({ model: 0, modelVerified: 0, harness: 1 })
  })

  it('computes cells over class scope and the inert screen: 3 modules, 17 classes, one inert docs module', async () => {
    const { ctx, root } = await harness()
    // DEFAULT_BUG_CLASSES shape: 15 module-scoped classes plus repo-scoped
    // dependencies and misconfig, so 3 modules arm 3*15+2 = 47 cells.
    const bugClasses = ['sqli', 'xss', 'cmdi', 'path-traversal', 'open-redirect', 'deserialization', 'ssrf',
      'authn', 'authn-bypass', 'login-bypass', 'oauth-bypass', 'session', 'authz', 'crypto-misuse', 'race',
      'dependencies', 'misconfig']
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'c'.repeat(40),
      modules: ['.', 'docs', 'src'],
      bugClasses,
      inertModules: ['docs'],
    })
    expect(ctx.hardLedger.coverageProgress(root.agent)).toEqual({ verdicted: 15, total: 47 })
    expect(ctx.hardLedger.coverageBySource(root.agent)).toEqual({ model: 0, modelVerified: 0, harness: 15 })
    const uncovered = ctx.hardLedger.uncoveredCells(root.agent)
    expect(uncovered).toHaveLength(32)
    // Matrix order: sorted modules outer, configured class order inner; the
    // inert docs module never appears; repo cells come last under '.'.
    expect(uncovered[0]).toEqual({ module: '.', bugClass: 'sqli' })
    expect(uncovered[14]).toEqual({ module: '.', bugClass: 'race' })
    expect(uncovered[15]).toEqual({ module: 'src', bugClass: 'sqli' })
    expect(uncovered).not.toContain(expect.objectContaining({ module: 'docs' }))
    expect(uncovered[30]).toEqual({ module: '.', bugClass: 'dependencies' })
    expect(uncovered[31]).toEqual({ module: '.', bugClass: 'misconfig' })

    // Marking repo cells: one event covers the whole repository, on any module.
    ctx.hardLedger.markCoverage(root.agent, {
      module: 'src', bugClass: 'dependencies', verdict: 'cleared', declaredSinks: ['package-lock.json'],
    })
    expect(ctx.hardLedger.coverageProgress(root.agent)).toEqual({ verdicted: 16, total: 47 })
    expect(ctx.hardLedger.uncoveredCells(root.agent).at(-1)).toEqual({ module: '.', bugClass: 'misconfig' })
  })

  it('partitions verdicted cells by source and re-reads batch clears per the screen spot-check', async () => {
    const plain = await harness()
    plain.ctx.hardLedger.recordMissionArmed(plain.root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'c'.repeat(40),
      modules: ['src'],
      bugClasses: ['cmdi'],
    })
    // An event without the optional source reads as model: legacy logs
    // partition unchanged.
    plain.ctx.hardLedger.markCoverage(plain.root.agent, {
      module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['s'],
    })
    expect(plain.ctx.hardLedger.coverageBySource(plain.root.agent)).toEqual({ model: 1, modelVerified: 0, harness: 0 })

    const { ctx, root } = await harness({ screenSpotCheckPercent: 100 })
    ctx.hardLedger.recordMissionArmed(root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'c'.repeat(40),
      modules: ['src'],
      bugClasses: ['cmdi', 'sqli'],
      inertModules: [],
    })
    ctx.hardLedger.markCoverage(root.agent, {
      module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['execSync'], source: 'model-verified',
    })
    ctx.hardLedger.markCoverage(root.agent, {
      module: 'src', bugClass: 'sqli', verdict: 'cleared', declaredSinks: ['rawQuery'], source: 'model-verified',
    })
    expect(ctx.hardLedger.coverageBySource(root.agent)).toEqual({ model: 0, modelVerified: 2, harness: 0 })
    const work = ctx.hardLedger.openWork(root.agent)
    expect(work).toContain('cell src × cmdi was batch-cleared; verify the mechanical screen')
    expect(work).toContain('cell src × sqli was batch-cleared; verify the mechanical screen')

    // Re-marking one cell by hand (no source: a model read) leaves the pool.
    ctx.hardLedger.markCoverage(root.agent, {
      module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['execSync'],
    })
    expect(ctx.hardLedger.coverageBySource(root.agent)).toEqual({ model: 1, modelVerified: 1, harness: 0 })
    expect(ctx.hardLedger.openWork(root.agent)).not.toContain('cell src × cmdi was batch-cleared; verify the mechanical screen')

    // percent 0 disables the re-read entirely.
    const off = await harness({ screenSpotCheckPercent: 0 })
    off.ctx.hardLedger.recordMissionArmed(off.root.agent, {
      objective: 'hunt bugs in the target repository',
      targetRepo: '/tmp/hard-target',
      commit: 'c'.repeat(40),
      modules: ['src'],
      bugClasses: ['cmdi'],
    })
    off.ctx.hardLedger.markCoverage(off.root.agent, {
      module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['execSync'], source: 'model-verified',
    })
    expect(off.ctx.hardLedger.openWork(off.root.agent)).not.toContain('verify the mechanical screen')
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

describe('hard ledger aggregates over folded state', () => {
  /** The log shape the pilot report folds: raw {type, data} session events. */
  function fold(events: readonly { type: string; data: unknown }[]): ReturnType<typeof emptyHardLedgerState> {
    let state = emptyHardLedgerState()
    for (const event of events) state = applyHardLedgerProjection(state, event as never)
    return state
  }

  it('filters the matrix math to armed rows and attributes inert cells to the harness', () => {
    const state = fold([
      {
        type: 'hard/mission/armed',
        data: {
          objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'c'.repeat(40),
          modules: ['data/manuals', 'src'], bugClasses: ['cmdi'], inertModules: ['data/manuals'],
        },
      },
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['s'] } },
      // A cell outside the matrix — recorded before the guard existed, or on a legacy log.
      { type: 'hard/coverage/cell', data: { module: 'poc', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['x'] } },
    ])
    // The inert module counts as verdicted (its screen), so 2 of 2 cells are done
    // — the off-matrix poc cell contributes nothing to either number.
    expect(coverageProgressFromState(state)).toEqual({ verdicted: 2, total: 2 })
    // The inert module has no event: its cell counts as the harness's screen.
    expect(coverageBySourceFromState(state)).toEqual({ model: 1, modelVerified: 0, harness: 1 })
    // matrixCellsFromState drives the gaming denominator: the off-matrix cell
    // is absent, so "cleared cells" counts matrix rows only.
    expect(matrixCellsFromState(state).map(cell => `${cell.module}×${cell.verdict}`)).toEqual(['src×cleared'])
  })

  it('lists a repository-scoped class once with the folded event, and re-opens with the harness name', () => {
    const state = fold([
      {
        type: 'hard/mission/armed',
        data: {
          objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'c'.repeat(40),
          modules: ['src', 'lib'], bugClasses: ['cmdi', 'dependencies'],
        },
      },
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'dependencies', verdict: 'cleared', declaredSinks: ['lock'] } },
      // The harness re-open appends a suspicious verdict under its own name,
      // whatever module name the original model event carried.
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'dependencies', verdict: 'suspicious', declaredSinks: ['lock'], source: 'harness' } },
      { type: 'hard/coverage/cell', data: { module: 'lib', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['exec'], source: 'model-verified' } },
    ])
    // The repo-scoped class appears once with the re-open verdict, not once per module;
    // module-scoped cells come first, repository-scoped ones trail.
    expect(matrixCellsFromState(state).map(cell => `${cell.module}×${cell.bugClass}×${cell.verdict}×${cell.source}`))
      .toEqual(['lib×cmdi×cleared×model-verified', 'src×dependencies×suspicious×harness'])
    // The model's dependency clear was flipped, so the model tally holds only
    // the verified cmdi clear; the re-open counts as the harness.
    expect(coverageBySourceFromState(state)).toEqual({ model: 0, modelVerified: 1, harness: 1 })
    // Total = 2 module-scoped cmdi cells + 1 repository-scoped dependencies
    // cell; verdicted are the lib cmdi clear and the dependencies re-open.
    expect(coverageProgressFromState(state)).toEqual({ verdicted: 2, total: 3 })
  })

  it('keeps the audit floor closed when the harness re-opens every model clear', () => {
    const state = fold([
      {
        type: 'hard/mission/armed',
        data: {
          objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'c'.repeat(40),
          modules: ['src'], bugClasses: ['cmdi', 'sqli'],
        },
      },
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['s'] } },
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'sqli', verdict: 'cleared', declaredSinks: ['s'] } },
      // The harness audits and flips both: nothing the model decided stands.
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'cmdi', verdict: 'suspicious', declaredSinks: ['s'], source: 'harness' } },
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'sqli', verdict: 'suspicious', declaredSinks: ['s'], source: 'harness' } },
    ])
    const assessment = completionAssessmentFromState(state, {
      screenSpotCheckPercent: DEFAULT_SCREEN_SPOT_CHECK_PERCENT, emptySweepsToFinish: 0,
    })
    expect(assessment.complete).toBe(false)
    // The re-opened cells are open work on their own; the floor blocker must
    // stand too — the model's full-clear tally cannot satisfy it.
    expect(assessment.blockers).toContain('no model-audited coverage cell or resolved hypothesis exists yet')
  })

  it('decomposes refutations by cause from the folded findings', () => {
    const state = fold([
      {
        type: 'hard/finding/proposed',
        data: {
          id: 'F-1', title: 't', bugClass: 'cmdi', component: 'c', claim: 'k',
          cvssVector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H',
          cvssClaimed: 9.3, pocPath: 'poc.sh', payload: 'x',
          claimHash: CLAIM_HASH, fingerprint: FINGERPRINT,
        },
      },
      {
        type: 'hard/finding/verdict',
        data: {
          id: 'F-1', verdict: 'refuted', runs: 0, cvssComputed: 9.3, cvssMatch: true,
          reason: 'benign payload satisfied the contract', fingerprint: FINGERPRINT,
          benignArm: 'passed', cause: 'benign-arm-passed', evidence: 'demonstrated',
        },
      },
    ])
    expect(refutationBreakdownFromState(state)).toEqual({
      byCause: { 'benign-arm-passed': 1 },
      protocolFailures: 1,
      genuineRefutations: 0,
      infrastructure: 0,
    })
  })

  it('skips undecided and non-refuted findings in the refutation breakdown', () => {
    const proposed = {
      type: 'hard/finding/proposed',
      data: {
        id: 'F-1', title: 't', bugClass: 'cmdi', component: 'c', claim: 'k',
        cvssVector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H',
        cvssClaimed: 9.3, pocPath: 'poc.sh', payload: 'x',
        claimHash: CLAIM_HASH, fingerprint: FINGERPRINT,
      },
    }
    const confirmed = {
      type: 'hard/finding/verdict',
      data: {
        id: 'F-1', verdict: 'confirmed', runs: 2, cvssComputed: 9.3, cvssMatch: true,
        reason: 'both runs printed the marker', fingerprint: FINGERPRINT,
        benignArm: 'failed', evidence: 'demonstrated',
      },
    }
    // F-1 confirmed (verdict present, not refuted); F-2 proposed with no verdict at all.
    const state = fold([proposed, confirmed, { ...proposed, data: { ...proposed.data, id: 'F-2' } }])
    expect(refutationBreakdownFromState(state)).toEqual({
      byCause: {}, protocolFailures: 0, genuineRefutations: 0, infrastructure: 0,
    })
  })

  it('returns no matrix cells without an arming record, and skips event-less repo classes', () => {
    // No matrix: no cells, whatever the coverage events carry; every by-source
    // count reads zero for the same reason.
    const unarced = fold([
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'dependencies', verdict: 'cleared', declaredSinks: ['lock'] } },
    ])
    expect(matrixCellsFromState(unarced)).toEqual([])
    expect(coverageBySourceFromState(unarced)).toEqual({ model: 0, modelVerified: 0, harness: 0 })
    // A repository-scoped class with no event-backed cell lists nothing —
    // the harness cannot show a repo cell the log never decided.
    const armed = fold([
      {
        type: 'hard/mission/armed',
        data: {
          objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'c'.repeat(40),
          modules: ['src'], bugClasses: ['cmdi', 'dependencies'],
        },
      },
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['s'] } },
    ])
    expect(matrixCellsFromState(armed).map(cell => `${cell.module}×${cell.bugClass}`)).toEqual(['src×cmdi'])
  })

  it('counts blind clears: model clears in unscreened modules, never harness decisions or repo-scoped cells', () => {
    const state = fold([
      {
        type: 'hard/mission/armed',
        data: {
          objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'c'.repeat(40),
          modules: ['notes', 'src', 'wp'], bugClasses: ['cmdi', 'sqli', 'dependencies'],
          inertModules: ['notes'], unscreenedModules: ['wp'],
        },
      },
      // A model read on an unscreened module: blind.
      { type: 'hard/coverage/cell', data: { module: 'wp', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['wp/a.php:run'] } },
      // A legacy batch screen recorded on an unscreened module before the refusal existed: blind.
      { type: 'hard/coverage/cell', data: { module: 'wp', bugClass: 'sqli', verdict: 'cleared', declaredSinks: ['p'], source: 'model-verified' } },
      // A model clear on a screened module, a repository-scoped class, and a suspicious verdict: not blind.
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['src/a.ts:run'] } },
      { type: 'hard/coverage/cell', data: { module: 'wp', bugClass: 'dependencies', verdict: 'cleared', declaredSinks: ['composer.lock'] } },
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'sqli', verdict: 'suspicious', declaredSinks: [] } },
    ])
    expect(blindClearsFromState(state)).toBe(2)
    // A harness re-open over the blind model read removes it from the count.
    const reopened = applyHardLedgerProjection(state, {
      type: 'hard/coverage/cell',
      data: { module: 'wp', bugClass: 'cmdi', verdict: 'suspicious', declaredSinks: ['wp/a.php:9: passthru($x)'], source: 'harness' },
    } as never)
    expect(blindClearsFromState(reopened)).toBe(1)
    expect(blindClearsFromState(emptyHardLedgerState())).toBe(0)
  })

  it('lays out the whole board: every matrix cell in matrix order with its state, repo classes last', () => {
    const state = fold([
      {
        type: 'hard/mission/armed',
        data: {
          objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'c'.repeat(40),
          modules: ['notes', 'src', 'wp'], bugClasses: ['cmdi', 'dependencies'],
          inertModules: ['notes'], unscreenedModules: ['wp'],
        },
      },
      { type: 'hard/coverage/cell', data: { module: 'wp', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['wp/a.php:run'] } },
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'cmdi', verdict: 'suspicious', declaredSinks: ['x'], source: 'harness' } },
      // An off-matrix cell never reaches the board.
      { type: 'hard/coverage/cell', data: { module: 'poc', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['p'] } },
    ])
    expect(matrixBoardFromState(state)).toEqual([
      // The inert module's cell is the harness's screen, without an event.
      { module: 'notes', bugClass: 'cmdi', scope: 'module', verdict: 'cleared', source: 'harness', blind: false },
      { module: 'src', bugClass: 'cmdi', scope: 'module', verdict: 'suspicious', source: 'harness', blind: false },
      { module: 'wp', bugClass: 'cmdi', scope: 'module', verdict: 'cleared', source: 'model', blind: true },
      // A repository-scoped class without an event has no verdict yet.
      { module: '.', bugClass: 'dependencies', scope: 'repo', blind: false },
    ])
    expect(matrixBoardFromState(emptyHardLedgerState())).toEqual([])
  })

  it('counts open work by kind with the same predicates the open-work list uses', () => {
    const state = fold([
      {
        type: 'hard/mission/armed',
        data: {
          objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'c'.repeat(40),
          modules: ['src', 'web'], bugClasses: ['cmdi', 'sqli'],
        },
      },
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'cmdi', verdict: 'suspicious', declaredSinks: [] } },
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'sqli', verdict: 'cleared', declaredSinks: ['p'], source: 'model-verified' } },
      { type: 'hard/finding/proposed', data: { ...findingRequest(), id: 'F-1' } },
      { type: 'hard/finding/proposed', data: { ...findingRequest(), id: 'F-2' } },
      {
        type: 'hard/finding/verdict',
        data: { id: 'F-2', verdict: 'flaky', runs: 3, cvssComputed: 9.3, cvssMatch: true, reason: 'split', fingerprint: FINGERPRINT },
      },
      { type: 'hard/hypothesis/state', data: { id: 'H-1', statement: 's', status: 'testing' } },
      { type: 'hard/hypothesis/state', data: { id: 'H-2', statement: 's', status: 'refuted', reason: 'r' } },
    ])
    expect(openWorkCountsFromState(state, { screenSpotCheckPercent: 100 })).toEqual({
      pendingFindings: 1, flakyFindings: 1, openHypotheses: 1, uncoveredCells: 2, suspiciousCells: 1, screenReReads: 1,
    })
    expect(openWorkCountsFromState(state, { screenSpotCheckPercent: 0 }).screenReReads).toBe(0)
  })

  it('carries screenability, exclusions, and blind clears through the client wire view', () => {
    const definition = hardLedgerProjectionDefinition()
    const state = fold([
      {
        type: 'hard/mission/armed',
        data: {
          objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'c'.repeat(40),
          modules: ['src', 'wp'], bugClasses: ['cmdi'], unscreenedModules: ['wp'],
          exclusions: { globs: ['vendor/**'], fileCount: 7, sample: ['vendor/a.php'] }, ignoredEntryCount: 2,
        },
      },
      { type: 'hard/coverage/cell', data: { module: 'wp', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['wp/a.php:run'] } },
    ])
    const view = definition.wire.view(state)
    expect(definition.wire.viewSchema.parse(view)).toEqual(view)
    // The sample stays host-side; the panel needs only the globs and the count.
    expect(view.matrix).toMatchObject({ unscreenedModules: ['wp'], exclusions: { globs: ['vendor/**'], fileCount: 7 } })
    expect(view.blindClears).toBe(1)
  })

  it('publishes the client wire view: schema-validated matrix, cells, aggregates, and gate', () => {
    const definition = hardLedgerProjectionDefinition()
    const state = fold([
      {
        type: 'hard/mission/armed',
        data: {
          objective: 'hunt bugs', targetRepo: '/tmp/hard-target', commit: 'c'.repeat(40),
          modules: ['data/manuals', 'src'], bugClasses: ['cmdi'], inertModules: ['data/manuals'],
        },
      },
      { type: 'hard/coverage/cell', data: { module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['s'] } },
      // Off-matrix and legacy cells stay out of the client's cell list.
      { type: 'hard/coverage/cell', data: { module: 'poc', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['x'], source: 'model-verified' } },
    ])
    const view = definition.wire.view(state)
    // The view schema round-trips: the wire value is what the client store publishes.
    expect(definition.wire.viewSchema.parse(view)).toEqual(view)
    expect(view.matrix).toEqual({
      modules: ['data/manuals', 'src'], bugClasses: ['cmdi'], classScopes: { cmdi: 'module' },
      inertModules: ['data/manuals'],
      targetRepo: '/tmp/hard-target', commit: 'c'.repeat(40),
    })
    expect(view.cells).toEqual([{ module: 'src', bugClass: 'cmdi', verdict: 'cleared', source: undefined }])
    expect(view.progress).toEqual({ verdicted: 2, total: 2 })
    expect(view.bySource).toEqual({ model: 1, modelVerified: 0, harness: 1 })
    // The gate comes from the same assessment the service reports.
    expect(view.gate.complete).toBe(false)
    expect(view.gate.blockers.length).toBeGreaterThan(0)
  })
})
