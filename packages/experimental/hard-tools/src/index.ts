/**
 * Model-facing hard-harness tools. A finding is only accepted through the
 * verifier's executed proof-of-effect contract; hypotheses, coverage cells,
 * and sweep summaries record the methodology state that the stop gate later
 * audits. The tools register no prompt sections; the mission contract owns
 * guidance.
 * @module @deepseek-ai/dsh-experimental-hard-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { claimHash, rootFingerprint } from '@deepseek-ai/dsh-experimental-hard-verifier'
import type { HardHypothesisStatus } from '@deepseek-ai/dsh-experimental-hard-ledger'

export const name = 'hard-tools'
export const inject = ['tools', 'hardLedger', 'hardVerifier']

/** Tool policy config; reserved for future thresholds. */
export interface Config {}

/** Schemastery config for the hard tools. */
export const Config: z<Config> = z.object({})

const HYPOTHESIS_STATUSES: readonly HardHypothesisStatus[] = ['proposed', 'testing', 'confirmed', 'refuted', 'deferred']

const SUBMIT_DESCRIPTION = 'Submit one vulnerability finding for harness verification. The harness executes '
  + 'the proof of concept itself; a finding only counts as confirmed when every run exits zero and prints '
  + 'the exact line HARD-PASS claim-hash on stdout. Include a CVSS:4.0 vector and the score you believe '
  + 'it computes; the harness recomputes the score and records any mismatch.'

const HYPOTHESIS_DESCRIPTION = 'Propose a new hypothesis, or move an existing one through its lifecycle: '
  + 'proposed, testing, confirmed, refuted, deferred. refuted and deferred require a concrete reason; '
  + 'an empty sweep only counts when it refutes a hypothesis or clears a coverage cell.'

const COVERAGE_DESCRIPTION = 'Record one coverage cell verdict for the systematic pass: a module swept for one '
  + 'bug class. cleared requires the concrete sink sites you inspected, listed as file:symbol references; '
  + 'the harness may re-grep the module against your declared list.'

const SWEEP_DESCRIPTION = 'Record one completed sweep pass. When the pass found nothing, empty_proof is required: '
  + 'name the refuted hypothesis or the cleared coverage cell that proves the sweep was not skipped.'

/** Compact generic presentation shared by the hard tools. */
function present(title: string, rawInput: unknown): GenericCallView {
  return { card: 'generic', title, kind: 'other', rawInput }
}

/**
 * Parse one model string into a hypothesis id, rejecting blanks.
 * @param value - the raw model-provided id.
 * @returns the trimmed id.
 */
function hypothesisId(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error('hypothesis_id must not be blank when provided')
  return trimmed
}

/** Shared compact JSON result renderer for the four tools. */
function renderJson(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Register the four hard-harness tools. */
export function apply(ctx: Context, _config: Config): void {
  const ledger = ctx.hardLedger
  const verifier = ctx.hardVerifier

  ctx.tools.register(defineTool({
    name: 'hard_submit_finding',
    description: SUBMIT_DESCRIPTION,
    parameters: {
      title: { type: 'string', required: true, description: 'Short finding title.' },
      bug_class: { type: 'string', required: true, description: 'Bug class, matching the mission class list.' },
      component: { type: 'string', required: true, description: 'Component, module, or file the claim is about.' },
      symbol: { type: 'string', description: 'Containing function or symbol, when known; strengthens dedup.' },
      claim: { type: 'string', required: true, description: 'The claimed vulnerability, concrete enough to test.' },
      cvss_vector: { type: 'string', required: true, description: 'CVSS:4.0/... vector string for the finding.' },
      cvss_score: { type: 'number', required: true, description: 'The score you believe the vector computes.' },
      poc_path: {
        type: 'string', required: true,
        description: 'Repository-relative path of the PoC script. It must print HARD-PASS sha256-of-claim '
          + 'on stdout and exit zero when the claim holds.',
      },
      hypothesis_id: { type: 'string', description: 'H-n id this finding confirms, when it tests a hypothesis.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          finding: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              id: { type: 'string', required: true },
              claimHash: { type: 'string', required: true },
              fingerprint: { type: 'string', required: true },
            },
          },
          verdict: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              verdict: { type: 'string', required: true, enum: ['confirmed', 'refuted', 'flaky'] },
              runs: { type: 'integer', required: true },
              cvssComputed: { type: 'number', required: true },
              cvssMatch: { type: 'boolean', required: true },
              reason: { type: 'string', required: true },
            },
          },
        },
      } as const,
      render: renderJson,
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('hard_submit_finding requires a live agent')
      const knownRaw = args.hypothesis_id === undefined ? undefined : hypothesisId(args.hypothesis_id)
      const known = knownRaw === undefined
        ? undefined
        : ledger.hypotheses(exec.agent).find(record => record.id === knownRaw)?.id
      if (knownRaw !== undefined && known === undefined) {
        throw new Error(`unknown hypothesis_id ${knownRaw}`)
      }
      const request = {
        title: args.title,
        bugClass: args.bug_class,
        component: args.component,
        claim: args.claim,
        cvssVector: args.cvss_vector,
        cvssClaimed: args.cvss_score,
        pocPath: args.poc_path,
        claimHash: claimHash(args.claim),
        fingerprint: rootFingerprint({
          bugClass: args.bug_class,
          component: args.component,
          ...args.symbol === undefined ? {} : { symbol: args.symbol },
        }),
        ...known === undefined ? {} : { hypothesisId: known },
      }
      const id = ledger.proposeFinding(exec.agent, request)
      const verdict = await verifier.verify(exec.agent, { ...request, id })
      return {
        finding: { id, claimHash: request.claimHash, fingerprint: request.fingerprint },
        verdict: {
          verdict: verdict.verdict,
          runs: verdict.runs,
          cvssComputed: verdict.cvssComputed,
          cvssMatch: verdict.cvssMatch,
          reason: verdict.reason,
        },
      }
    },
    presentCall: args => present(`Submit finding: ${args.component}`, args.title),
  }))

  ctx.tools.register(defineTool({
    name: 'hard_update_hypothesis',
    description: HYPOTHESIS_DESCRIPTION,
    parameters: {
      hypothesis_id: { type: 'string', description: 'H-n id to transition; omit to propose a new hypothesis.' },
      statement: { type: 'string', required: true, description: 'The hypothesis, concrete enough to test or refute.' },
      status: { type: 'string', required: true, enum: [...HYPOTHESIS_STATUSES], description: 'New lifecycle status.' },
      reason: { type: 'string', description: 'Required for refuted and deferred: the evidence or retry condition.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          hypothesis: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              id: { type: 'string', required: true },
              status: { type: 'string', required: true },
            },
          },
        },
      } as const,
      render: (_args, value) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      if (exec.agent === undefined) throw new Error('hard_update_hypothesis requires a live agent')
      const id = ledger.writeHypothesis(exec.agent, {
        ...args.hypothesis_id === undefined ? {} : { id: hypothesisId(args.hypothesis_id) },
        statement: args.statement,
        status: args.status,
        ...args.reason === undefined ? {} : { reason: args.reason },
      })
      return Promise.resolve({ hypothesis: { id, status: args.status } })
    },
    presentCall: args => present(`Hypothesis ${args.hypothesis_id ?? 'proposed'}: ${args.status}`, args.statement),
  }))

  ctx.tools.register(defineTool({
    name: 'hard_mark_coverage',
    description: COVERAGE_DESCRIPTION,
    parameters: {
      module: { type: 'string', required: true, description: 'Module or directory swept, target-repo relative.' },
      bug_class: { type: 'string', required: true, description: 'Bug class swept in this cell.' },
      verdict: { type: 'string', required: true, enum: ['cleared', 'suspicious', 'uncovered'], description: 'Cell verdict.' },
      declared_sinks: {
        type: 'array', description: 'Sink sites inspected, as file:symbol references; required for cleared.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          coverage: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              module: { type: 'string', required: true },
              bugClass: { type: 'string', required: true },
              verdict: { type: 'string', required: true },
            },
          },
          reopenedSinks: { type: 'array', required: true, description: 'Undeclared sink sites the cross-check grep found; empty when the cell stands.' },
        },
      } as const,
      render: renderJson,
    },
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('hard_mark_coverage requires a live agent')
      const declaredSinks = (args.declared_sinks ?? []).filter((sink): sink is string => typeof sink === 'string')
      const cell = { module: args.module, bugClass: args.bug_class, verdict: args.verdict, declaredSinks }
      ledger.markCoverage(agent, cell)
      return verifier.auditCoverage(cell).then((reopened) => {
        if (reopened !== undefined) ledger.markCoverage(agent, reopened)
        const coverage = reopened === undefined
          ? { module: cell.module, bugClass: cell.bugClass, verdict: cell.verdict }
          : { module: reopened.module, bugClass: reopened.bugClass, verdict: reopened.verdict }
        return {
          coverage,
          reopenedSinks: reopened === undefined ? [] : [...reopened.declaredSinks],
        }
      })
    },
    presentCall: args => present(`Coverage ${args.module} x ${args.bug_class}: ${args.verdict}`, args.module),
  }))

  ctx.tools.register(defineTool({
    name: 'hard_sweep_summary',
    description: SWEEP_DESCRIPTION,
    parameters: {
      phase: {
        type: 'string', required: true, enum: ['A', 'B'],
        description: 'A: systematic source-sink sweep. B: deep-reading pass.',
      },
      cells_touched: { type: 'number', required: true, description: 'Coverage cells touched this pass.' },
      new_findings: { type: 'number', required: true, description: 'Confirmed findings this pass produced.' },
      empty_proof: {
        type: 'string',
        description: 'Required when new_findings is zero: the refuted hypothesis or cleared cell.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          sweep: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              phase: { type: 'string', required: true, enum: ['A', 'B'] },
              cellsTouched: { type: 'integer', required: true },
              newFindings: { type: 'integer', required: true },
            },
          },
        },
      } as const,
      render: renderJson,
    },
    execute(args, exec) {
      if (exec.agent === undefined) throw new Error('hard_sweep_summary requires a live agent')
      ledger.recordSweep(exec.agent, {
        phase: args.phase,
        cellsTouched: args.cells_touched,
        newFindings: args.new_findings,
        ...args.empty_proof === undefined ? {} : { emptyProof: args.empty_proof },
      })
      return Promise.resolve({
        sweep: { phase: args.phase, cellsTouched: args.cells_touched, newFindings: args.new_findings },
      })
    },
    presentCall: args => present(`Sweep ${args.phase}: ${args.new_findings} findings`, args.phase),
  }))
}
