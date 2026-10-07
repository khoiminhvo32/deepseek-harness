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
import { ABSENCE_SINK_CLASSES, claimHash, rootFingerprint } from '@deepseek-ai/dsh-experimental-hard-verifier'
import type { HardEmptySweepProof, HardHypothesisStatus } from '@deepseek-ai/dsh-experimental-hard-ledger'
import { HarnessError } from '@deepseek-ai/dsh-llm'

export const name = 'hard-tools'
export const inject = ['tools', 'hardLedger', 'hardVerifier']

/** Tool policy config; reserved for future thresholds. */
export interface Config {}

/** Schemastery config for the hard tools. */
export const Config: z<Config> = z.object({})

const HYPOTHESIS_STATUSES: readonly HardHypothesisStatus[] = ['proposed', 'testing', 'confirmed', 'refuted', 'deferred']

const SUBMIT_DESCRIPTION = 'Submit one vulnerability finding for harness verification. The harness executes '
  + 'the proof of concept itself, passing the payload as the PoC\'s first argument ($1); read the payload '
  + 'from $1, never hardcode it in the script. The harness runs the specificity check: the same PoC is '
  + 're-run with a benign payload and MUST FAIL — only print HARD-PASS claim-hash when the real payload '
  + 'actually causes the effect. A finding only counts as confirmed when every exploit run exits zero, prints '
  + 'the exact line HARD-PASS claim-hash on stdout, and the benign run failed. '
  + 'Include a CVSS:4.0 vector and the score you believe it computes; the harness recomputes the score and '
  + 'records any mismatch.'

const HYPOTHESIS_DESCRIPTION = 'Propose a new hypothesis, or move an existing one through its lifecycle: '
  + 'proposed, testing, confirmed, refuted, deferred. refuted and deferred require a concrete reason; '
  + 'an empty sweep only counts when it refutes a hypothesis or clears a coverage cell.'

const COVERAGE_DESCRIPTION = 'Record one coverage cell verdict for the systematic pass: a module swept for one '
  + 'bug class. The module must be a row of the armed coverage matrix — sweeping an untracked directory you '
  + 'created yourself (such as a poc/ scratch folder) is refused. Most classes: cleared requires the concrete '
  + 'sink sites you inspected, listed as file:symbol references; the harness may re-grep the module against '
  + 'your declared list. '
  + 'For authz and authn-bypass the reading is inverted: the harness greps the module for the operations it '
  + 'exports, so cleared requires one declaration per exported operation — name the guard that protects it, '
  + 'or state that it is deliberately unguarded with the reason. The harness reopens the cell naming any '
  + 'operation none of your declarations mention.'

const CLEAR_MODULES_DESCRIPTION = 'Batch-screen one bug class across several modules without reading them cell by '
  + 'cell. Provide extended-regex patterns for this class\'s sinks; the harness greps each module for the union of '
  + 'your patterns and its own fixed table, so your patterns can only add matches, never subtract. Any match clears '
  + 'nothing and returns the matching lines for a manual read. An empty grep records every cell as a batch screen — '
  + 'the weakest verdict: a silent grep is not proof of absence, it never satisfies the completion requirement for '
  + 'audited cells, and the harness may send screened cells back for a manual read. Modules the harness cannot '
  + 'screen are refused: any module holding a binary file or a language its fixed table was not written for — read '
  + 'those cells yourself with hard_mark_coverage. login-bypass is refused: its sinks are protective checks, so an '
  + 'empty grep is suspicious, not clean. For authz and authn-bypass the fixed table names the exported operations '
  + 'instead of sinks, and any match names an operation whose guard hard_mark_coverage must declare.'

const SWEEP_DESCRIPTION = 'Record one completed sweep pass. When the pass found nothing, empty_proof is required: '
  + 'name the refuted hypothesis, the cleared coverage cell, or the recorded flow document that proves the sweep '
  + 'was not skipped.'

const FLOW_DESCRIPTION = 'Record one flow document for a module after the deep-reading pass. All six sections are '
  + 'required; an empty section means you explicitly found nothing, not that you skipped it. Every entry carries '
  + 'cite, snippet, and note: cite is a path:line or path:line-line reference into the target repository, snippet '
  + 'is the short source text at those lines, note is your reading of them. The harness resolves every citation '
  + 'against the pinned commit — never the working tree — and rejects the whole record naming the failed cites, '
  + 'so copy snippets from what you actually read. Each quirk entry automatically opens a proposed hypothesis.'

/** Schema of one flow-document entry shared by the six sections; value-schema items are total. */
const FLOW_ENTRY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    cite: { type: 'string', description: 'path:line or path:line-line, target-repo relative.' },
    snippet: { type: 'string', description: 'The short source text at those lines, copied verbatim.' },
    note: { type: 'string', description: 'Your reading of the cited lines.' },
  },
} as const

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

/** Shared compact JSON result renderer for the hard tools. */
function renderJson(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** The tool argument key of each flow-document section, in contract order. */
const FLOW_SECTION_KEYS = ['entry_points', 'dataflows', 'trust_boundaries', 'state_machines', 'assumptions', 'quirks'] as const

type FlowSectionKey = (typeof FLOW_SECTION_KEYS)[number]

/** One validated flow-document entry. */
interface FlowEntry {
  readonly cite: string
  readonly snippet: string
  readonly note: string
}

/**
 * Read one required string field of a flow entry, rejecting blanks and
 * unbounded text: the snippet and note ride the tool result, so their sizes
 * are bounded here rather than by the log.
 * @param section - the section key, worded for the error message.
 * @param source - the raw entry object.
 * @param field - the field to read.
 * @param limit - the character bound.
 * @returns the trimmed field value.
 */
function flowField(section: string, source: Record<string, unknown>, field: 'cite' | 'snippet' | 'note', limit: number): string {
  const value = source[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${section} entries require a non-empty ${field}`)
  }
  if (value.length > limit) {
    throw new Error(`${section} ${field} must not exceed ${limit} characters`)
  }
  return value
}

/**
 * Read and validate the six flow sections: each required, each an array (an
 * empty one is an explicit empty section), each entry carrying a bounded
 * cite, snippet, and note.
 * @param args - the raw tool arguments.
 * @returns the six validated sections in contract order.
 */
function readFlowSections(args: Record<FlowSectionKey, unknown>): Record<FlowSectionKey, readonly FlowEntry[]> {
  const sections = {} as Record<FlowSectionKey, readonly FlowEntry[]>
  for (const key of FLOW_SECTION_KEYS) {
    const raw = args[key]
    if (!Array.isArray(raw)) {
      throw new Error(`${key} must be an array (an empty one records an explicit empty section)`)
    }
    sections[key] = raw.map((item): FlowEntry => {
      if (typeof item !== 'object' || item === null) throw new Error(`${key} entries must be objects`)
      const source = item as Record<string, unknown>
      return {
        cite: flowField(key, source, 'cite', 500),
        snippet: flowField(key, source, 'snippet', 500),
        note: flowField(key, source, 'note', 1000),
      }
    })
  }
  return sections
}

/** Register the six hard-harness tools. */
export function apply(ctx: Context, _config: Config): void {  const ledger = ctx.hardLedger
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
        description: 'Target-repository-relative path of the PoC script. It must take the exploit input as $1, '
          + 'print HARD-PASS sha256-of-claim on stdout, and exit zero only when the payload causes the effect.',
      },
      payload: {
        type: 'string', required: true,
        description: 'The exploit input the PoC takes as its first argument. The harness re-runs the same PoC '
          + 'with a benign payload and requires it to fail (the specificity check).',
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
        payload: args.payload,
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
      return verifier.auditCoverage(agent, cell).then((reopened) => {
        if (reopened !== undefined) ledger.markCoverage(agent, reopened)
        const coverage = reopened === undefined
          ? { module: cell.module, bugClass: cell.bugClass, verdict: cell.verdict }
          : { module: reopened.module, bugClass: reopened.bugClass, verdict: reopened.verdict }
        return {
          coverage,
          reopenedSinks: reopened === undefined ? [] : [...reopened.declaredSinks],
        }
      }).catch((error: unknown) => {
        // Fail closed: a cross-check that could not run must not leave the
        // cell standing cleared in the durable ledger. The cell is
        // harness-decided here, so it is attributed like a reopen.
        if (!(error instanceof HarnessError) || error.code !== 'HARD_VERIFIER_AUDIT_FAILED') throw error
        ledger.markCoverage(agent, {
          module: cell.module, bugClass: cell.bugClass, verdict: 'suspicious', declaredSinks: [], source: 'harness',
        })
        throw error
      })
    },
    presentCall: args => present(`Coverage ${args.module} x ${args.bug_class}: ${args.verdict}`, args.module),
  }))

  ctx.tools.register(defineTool({
    name: 'hard_record_flow',
    description: FLOW_DESCRIPTION,
    parameters: {
      module: { type: 'string', required: true, description: 'Module or module-cluster read, target-repo relative.' },
      entry_points: { type: 'array', required: true, description: 'Entry-point citations; an empty array records an explicit empty section.', items: FLOW_ENTRY_SCHEMA },
      dataflows: { type: 'array', required: true, description: 'Dataflow citations; an empty array records an explicit empty section.', items: FLOW_ENTRY_SCHEMA },
      trust_boundaries: { type: 'array', required: true, description: 'Trust-boundary citations; an empty array records an explicit empty section.', items: FLOW_ENTRY_SCHEMA },
      state_machines: { type: 'array', required: true, description: 'State-machine citations; an empty array records an explicit empty section.', items: FLOW_ENTRY_SCHEMA },
      assumptions: { type: 'array', required: true, description: 'Assumption citations; an empty array records an explicit empty section.', items: FLOW_ENTRY_SCHEMA },
      quirks: { type: 'array', required: true, description: 'Suspicious-quirk citations; each opens a proposed hypothesis.', items: FLOW_ENTRY_SCHEMA },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          flow: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              module: { type: 'string', required: true },
              citations: { type: 'integer', required: true },
              quirkIds: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      } as const,
      render: renderJson,
    },
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('hard_record_flow requires a live agent')
      const sections = readFlowSections(args)
      const citations = FLOW_SECTION_KEYS.flatMap(key => sections[key]
        .map(entry => ({ cite: entry.cite, snippet: entry.snippet })))
      return verifier.checkFlowCitations(agent, citations).then(({ rejected }) => {
        if (rejected.length > 0) {
          throw new Error('hard_record_flow rejected — every citation must resolve at the pinned commit: '
            + rejected.map(entry => `${entry.cite} (${entry.reason})`).join('; '))
        }
        const quirkIds = sections.quirks.map(entry => ledger.writeHypothesis(agent, {
          statement: `quirk ${entry.cite}: ${entry.note}`,
          status: 'proposed',
        }))
        ledger.recordFlowDoc(agent, {
          module: args.module,
          sections: {
            entryPoints: sections.entry_points.length,
            dataflows: sections.dataflows.length,
            trustBoundaries: sections.trust_boundaries.length,
            stateMachines: sections.state_machines.length,
            assumptions: sections.assumptions.length,
            quirks: sections.quirks.length,
          },
          citations: citations.length,
          ...(quirkIds.length === 0 ? {} : { quirkIds }),
        })
        return {
          flow: {
            module: args.module,
            citations: citations.length,
            ...(quirkIds.length === 0 ? {} : { quirkIds }),
          },
        }
      })
    },
    presentCall: args => present(`Flow doc ${args.module}: `
      + `${args.entry_points.length + args.dataflows.length + args.trust_boundaries.length + args.state_machines.length + args.assumptions.length + args.quirks.length} citations`, args.module),
  }))

  ctx.tools.register(defineTool({
    name: 'hard_clear_modules',
    description: CLEAR_MODULES_DESCRIPTION,
    parameters: {
      modules: { type: 'array', required: true, description: 'Target-repo-relative module names to clear in one batch.' },
      bug_class: { type: 'string', required: true, description: 'One module-scoped bug class absent from all listed modules.' },
      patterns: {
        type: 'array', required: true,
        description: 'Extended-regex patterns proving the class\'s sinks are absent; the harness unions them with its own fixed table.',
      },
      rationale: { type: 'string', required: true, description: 'Why this pattern set is sufficient for this repository.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          cleared: { type: 'number', required: true, description: 'Cells cleared; 0 when any module still matches.' },
          clearedCells: {
            type: 'array', required: true,
            items: { type: 'object', additionalProperties: false, properties: { module: { type: 'string', required: true }, bugClass: { type: 'string', required: true } } },
            description: 'The cleared module and class pairs, empty when nothing cleared.',
          },
          evidence: {
            type: 'array', required: true,
            description: 'Matching lines proving a sink exists; empty when the batch cleared.',
          },
        },
      } as const,
      render: renderJson,
    },
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('hard_clear_modules requires a live agent')
      if (ledger.coverageMatrix(agent) === undefined) throw new Error('hard_clear_modules requires an armed coverage matrix')
      if (ABSENCE_SINK_CLASSES.has(args.bug_class)) {
        throw new Error(`hard_clear_modules refuses ${args.bug_class}: its sinks are protective checks, so an `
          + 'empty grep means no guard was found, which is suspicious rather than clean; verify its cells '
          + 'individually with hard_mark_coverage')
      }
      if (args.modules.some(entry => typeof entry !== 'string' || entry.trim().length === 0)) {
        throw new Error('modules entries must be non-empty strings')
      }
      const modules = [...new Set(args.modules.filter((entry): entry is string => typeof entry === 'string'))]
      if (modules.length === 0) throw new Error('modules must list at least one module')
      if (modules.length > 50) throw new Error('modules must not exceed 50 entries per batch')
      ledger.assertModulesInMatrix(agent, modules)
      // A batch clear on an inert module duplicates the screen the harness
      // already ran, and one on an unscreened module rests on a grep that is
      // silent there; refuse the whole batch before any grep runs.
      ledger.assertClearableModules(agent, modules)
      ledger.assertScreenableModules(agent, modules)
      if (args.patterns.some(entry => typeof entry !== 'string' || entry.trim().length === 0)) {
        throw new Error('patterns entries must be non-empty strings')
      }
      const patterns = args.patterns.filter((entry): entry is string => typeof entry === 'string')
      if (patterns.length === 0 || patterns.length > 10) {
        throw new Error('patterns must list between 1 and 10 extended-regex patterns')
      }
      for (const pattern of patterns) {
        if (pattern.length > 500) throw new Error('patterns entries must not exceed 500 characters')
      }
      if (typeof args.rationale !== 'string' || args.rationale.trim().length === 0) {
        throw new Error('rationale must explain why this pattern set is sufficient for this repository')
      }
      return verifier.screenModules(agent, args.bug_class, modules, patterns).then((screen) => {
        if (!screen.clean) {
          return { cleared: 0, clearedCells: [], evidence: [...screen.evidence] }
        }
        const clearedCells = modules.map(module => ({ module, bugClass: args.bug_class }))
        for (const cell of clearedCells) {
          ledger.markCoverage(agent, {
            module: cell.module,
            bugClass: cell.bugClass,
            verdict: 'cleared',
            declaredSinks: [...patterns],
            source: 'model-verified',
          })
        }
        return { cleared: clearedCells.length, clearedCells, evidence: [] }
      })
    },
    presentCall: args => present(`Batch clear ${args.modules.length} module(s) x ${args.bug_class}`, args.bug_class),
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
      empty_proof_kind: {
        type: 'string', enum: ['hypothesis', 'cell', 'flow'],
        description: 'Required when new_findings is zero: what proves this sweep did work.',
      },
      empty_proof_id: {
        type: 'string',
        description: 'With empty_proof_kind hypothesis: the H-n id, which must already be refuted.',
      },
      empty_proof_module: {
        type: 'string',
        description: 'With empty_proof_kind cell or flow: the module being cited.',
      },
      empty_proof_bug_class: {
        type: 'string',
        description: 'With empty_proof_kind cell: the bug class of the cleared cell being cited.',
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
              emptyProofRef: {
                type: 'object', additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, enum: ['hypothesis', 'cell'] },
                  hypothesisId: { type: 'string' },
                  module: { type: 'string' },
                  bugClass: { type: 'string' },
                },
              },
              emptyProofFlowDoc: { type: 'string', description: 'The cited flow-document module, for empty_proof_kind flow.' },
            },
          },
        },
      } as const,
      render: renderJson,
    },
    execute(args, exec) {
      if (exec.agent === undefined) throw new Error('hard_sweep_summary requires a live agent')
      const proof = emptyProofFrom(args)
      ledger.recordSweep(exec.agent, {
        phase: args.phase,
        cellsTouched: args.cells_touched,
        newFindings: args.new_findings,
        ...(proof === undefined ? {} : proof.kind === 'flow' ? { emptyProofFlowDoc: proof.module } : { emptyProofRef: proof }),
      })
      return Promise.resolve({
        sweep: {
          phase: args.phase,
          cellsTouched: args.cells_touched,
          newFindings: args.new_findings,
          ...(proof === undefined ? {} : proof.kind === 'flow' ? { emptyProofFlowDoc: proof.module } : { emptyProofRef: proof }),
        },
      })
    },
    presentCall: args => present(`Sweep ${args.phase}: ${args.new_findings} findings`, args.phase),
  }))
}

/** The assembled empty-sweep proof: a ledger reference, or the flow-document module. */
type EmptyProof = HardEmptySweepProof | { readonly kind: 'flow'; readonly module: string }

/** Assemble the structured empty-sweep proof from the model's arguments, failing loud on a half-specified one. */
function emptyProofFrom(args: {
  empty_proof_kind?: 'hypothesis' | 'cell' | 'flow'
  empty_proof_id?: string
  empty_proof_module?: string
  empty_proof_bug_class?: string
}): EmptyProof | undefined {
  const kind = args.empty_proof_kind
  if (kind === undefined) {
    if (args.empty_proof_id !== undefined || args.empty_proof_module !== undefined
      || args.empty_proof_bug_class !== undefined) {
      throw new Error('empty_proof_id, empty_proof_module, and empty_proof_bug_class require empty_proof_kind')
    }
    return undefined
  }
  if (kind === 'hypothesis') {
    if (args.empty_proof_module !== undefined || args.empty_proof_bug_class !== undefined) {
      throw new Error('empty_proof_module and empty_proof_bug_class are valid only with empty_proof_kind cell')
    }
    const id = args.empty_proof_id
    if (id === undefined || id.trim().length === 0) {
      throw new Error('empty_proof_kind hypothesis requires the empty_proof_id of a refuted hypothesis')
    }
    return { kind: 'hypothesis', hypothesisId: id }
  }
  if (args.empty_proof_id !== undefined) {
    throw new Error('empty_proof_id is valid only with empty_proof_kind hypothesis')
  }
  const module = args.empty_proof_module
  if (module === undefined || module.trim().length === 0) {
    throw new Error(`empty_proof_kind ${kind} requires a non-empty empty_proof_module`)
  }
  if (kind === 'flow') {
    if (args.empty_proof_bug_class !== undefined) {
      throw new Error('empty_proof_bug_class is valid only with empty_proof_kind cell')
    }
    return { kind: 'flow', module }
  }  const bugClass = args.empty_proof_bug_class
  if (bugClass === undefined || bugClass.trim().length === 0) {
    throw new Error('empty_proof_kind cell requires a non-empty empty_proof_bug_class')
  }
  return { kind: 'cell', module, bugClass }
}
