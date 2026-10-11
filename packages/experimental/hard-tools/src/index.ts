/**
 * Model-facing hard-harness tools. A finding is only accepted through the
 * verifier's executed proof-of-effect contract; hypotheses, coverage cells,
 * and sweep summaries record the methodology state that the stop gate later
 * audits, and `hard_status` reads that state back so the model sees the work
 * it is being pushed through. The tools register no prompt sections; the
 * mission contract owns guidance.
 * @module @deepseek-ai/dsh-experimental-hard-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { ABSENCE_SINK_CLASSES, claimHash, parseSinkCitation, rootFingerprint } from '@deepseek-ai/dsh-experimental-hard-verifier'
import type { HardEmptySweepProof, HardHypothesisStatus, HardMatrixBoardCell } from '@deepseek-ai/dsh-experimental-hard-ledger'
import { classScope } from '@deepseek-ai/dsh-experimental-hard-ledger'
// Loads the declaration-merged `goals` Context key read through `ctx.get`.
import type {} from '@deepseek-ai/dsh-goal'
import { HarnessError } from '@deepseek-ai/dsh-llm'

export const name = 'hard-tools'
export const inject = ['tools', 'hardLedger', 'hardVerifier']

/** Default longest line range one site of a cleared cell may cite. */
export const DEFAULT_MAX_CITED_RANGE_LINES = 300

/** Default number of distinct module files a cleared cell must cite. */
export const DEFAULT_MIN_CLEARED_FILES = 3

/** Tool policy config: the evidence a cleared coverage cell must carry. */
export interface Config {
  /**
   * Longest line range one declared site of a cleared cell may cite. A wider
   * range claims a read of a whole file that nothing checks, so the clear is
   * refused until it cites the function or the lines actually read.
   */
  maxCitedRangeLines?: number
  /**
   * Distinct files of the module a cleared module-scoped cell must cite,
   * capped by the module's file count at the pinned commit, so a large
   * module is never cleared on one line.
   */
  minClearedFiles?: number
}

/** Schemastery config for the hard tools. */
export const Config: z<Config> = z.object({
  maxCitedRangeLines: z.number().step(1).min(1).default(DEFAULT_MAX_CITED_RANGE_LINES),
  minClearedFiles: z.number().step(1).min(1).default(DEFAULT_MIN_CLEARED_FILES),
})

/** Fully materialized tool policy. */
interface ResolvedConfig {
  readonly maxCitedRangeLines: number
  readonly minClearedFiles: number
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const maxCitedRangeLines = config.maxCitedRangeLines ?? DEFAULT_MAX_CITED_RANGE_LINES
  if (!Number.isSafeInteger(maxCitedRangeLines) || maxCitedRangeLines < 1) {
    throw new TypeError('maxCitedRangeLines must be a positive safe integer')
  }
  const minClearedFiles = config.minClearedFiles ?? DEFAULT_MIN_CLEARED_FILES
  if (!Number.isSafeInteger(minClearedFiles) || minClearedFiles < 1) {
    throw new TypeError('minClearedFiles must be a positive safe integer')
  }
  return { maxCitedRangeLines, minClearedFiles }
}

/** Whether one target-relative path lies in one coverage module; the root module holds only root files. */
function inModule(path: string, module: string): boolean {
  return module === '.' ? !path.includes('/') : path.startsWith(`${module}/`)
}

const HYPOTHESIS_STATUSES: readonly HardHypothesisStatus[] = ['proposed', 'testing', 'confirmed', 'refuted', 'deferred']

const SUBMIT_DESCRIPTION = 'Submit one vulnerability finding for harness verification. The harness executes '
  + 'the proof of concept itself as bash poc_path payload from the target repository root, so the PoC must be a '
  + 'bash script; a proof written in another language needs a bash script that invokes it. The payload is the '
  + 'PoC\'s first argument ($1); read the payload '
  + 'from $1, never hardcode it in the script. The harness runs the specificity check: the same PoC is '
  + 're-run with a benign payload and MUST FAIL — only print HARD-PASS claim-hash when the real payload '
  + 'actually causes the effect. A finding only counts as confirmed when every exploit run exits zero, prints '
  + 'the exact line HARD-PASS claim-hash on stdout, and the benign run failed. '
  + 'Include a CVSS:4.0 vector and the score you believe it computes; the harness recomputes the score and '
  + 'records any mismatch.'

const HYPOTHESIS_DESCRIPTION = 'Propose a new hypothesis, or move an existing one through its lifecycle: '
  + 'proposed, testing, confirmed, refuted, deferred. refuted and deferred require a concrete reason; '
  + 'an empty sweep only counts when it refutes a hypothesis or clears a coverage cell. '
  + 'A chain hypothesis also names links: two or more recorded weaknesses (W-n) or confirmed findings (F-n) it '
  + 'combines, where what one grants satisfies what another requires, and states the combined impact. Prove a '
  + 'chain with one PoC through hard_submit_finding citing its hypothesis id; a chain you rule out is refuted with '
  + 'the reason, which still counts as considering its links.'

const FLAW_DESCRIPTION = 'Record one weakness as chaining material: a flaw, bug, or confirmed finding, kept whatever '
  + 'its standalone impact — record low and informational ones too, because a chain may need them. grants is what an '
  + 'attacker gains from it alone (a capability, a leaked value, a state change), requires is what the attacker needs '
  + 'before it is usable (a role, a configuration, another capability). sites are the code sites, each path:symbol, '
  + 'path:line, or path:start-end plus an optional note, resolved at the pinned commit. Once two or more weaknesses '
  + 'or confirmed findings exist, each must appear in the links of at least one chain hypothesis before the mission '
  + 'can complete.'

const COVERAGE_DESCRIPTION = 'Record one coverage cell verdict for the systematic pass: a module swept for one '
  + 'bug class. The module must be a row of the armed coverage matrix — sweeping an untracked directory you '
  + 'created yourself (such as a poc/ scratch folder) is refused. cleared requires the code sites you inspected '
  + 'for this class, each written path:symbol, path:line, or path:start-end (target-repo relative), optionally followed by a space '
  + 'and a note; in a module with no sink, cite the entry points you inspected. The harness resolves every site '
  + 'at the pinned commit and refuses a clear that cites code which is not there, and it may re-grep the module '
  + 'against your declared list. '
  + 'For authz and authn-bypass the reading is inverted: the harness greps the module for the operations it '
  + 'exports, so cleared requires one declaration per exported operation — name the guard that protects it, '
  + 'or state that it is deliberately unguarded with the reason. The harness reopens the cell naming any '
  + 'operation none of your declarations mention. '
  + 'logic covers business-logic flaws no sink pattern finds: a check in the wrong order, a state machine that '
  + 'skips a step, a limit enforced on one path but not its sibling, a value trusted after it was checked. A logic '
  + 'clear declares at least two sites, each with a note stating the invariant it upholds, and compares sibling '
  + 'paths that perform the same operation; the harness cannot grep it, so nothing but your read stands behind it.'

/**
 * The evidence rule a cleared cell meets, worded with the deployment's limits.
 * @param policy - the resolved tool policy.
 * @returns the sentence both coverage tools append to their description.
 */
function clearEvidenceRule(policy: ResolvedConfig): string {
  return ` A clear of a module-scoped class cites the function or the lines you read — at most ${String(policy.maxCitedRangeLines)} `
    + `lines per site, never a whole file — in at least ${String(policy.minClearedFiles)} different files of the module `
    + '(every file when it has fewer); a clear that falls short is refused naming the limit.'
}

const MARK_MODULE_DESCRIPTION = 'Record several bug classes for one module after reading it once: one entry per class '
  + 'with its verdict and declared sites, under the same rules as hard_mark_coverage for each entry. Every entry is '
  + 'checked, and every cleared site resolved at the pinned commit, before any is recorded, so one bad entry refuses '
  + 'the whole call naming it. Each recorded class may then be re-grepped and reopened exactly as hard_mark_coverage '
  + 'would. Prefer it to one hard_mark_coverage call per class whenever you swept a module for more than one class.'

/**
 * The mapping order a module sweep returns while entry points lack a feature,
 * so features are recorded while the code is fresh rather than after the sweep.
 * @param unmapped - indexed entry points no recorded feature covers.
 * @param total - all indexed entry points.
 * @returns the model-facing order.
 */
export function markModuleMapping(unmapped: number, total: number): string {
  return `${unmapped} of ${total} entry points are in no recorded feature. Before the next module, record with hard_record_feature `
    + 'every feature whose entry points you read in this module: map as you read, not after the sweep.'
}

/** The most classes one hard_mark_module call records. */
const MARK_MODULE_CELL_LIMIT = 32

const CLEAR_MODULES_DESCRIPTION = 'Batch-screen one bug class across several modules without reading them cell by '
  + 'cell. Provide extended-regex patterns for this class\'s sinks; the harness greps each module for the union of '
  + 'your patterns and its own fixed table, so your patterns can only add matches, never subtract. Any match clears '
  + 'nothing and returns the matching lines for a manual read. An empty grep records every cell as a batch screen — '
  + 'the weakest verdict: a silent grep is not proof of absence, it never satisfies the completion requirement for '
  + 'audited cells, and the harness may send screened cells back for a manual read. Modules the harness cannot '
  + 'screen are refused: any module holding a binary file or a language its fixed table was not written for — read '
  + 'those cells yourself with hard_mark_coverage. login-bypass is refused: its sinks are protective checks, so an '
  + 'empty grep is suspicious, not clean. For authz and authn-bypass the fixed table names the exported operations '
  + 'instead of sinks, and any match names an operation whose guard hard_mark_coverage must declare. '
  + 'Repository-wide classes (dependencies, misconfig) are one cell each: record them with hard_mark_coverage.'

const STATUS_DESCRIPTION = 'Read the coverage board and the remaining work without changing anything. '
  + 'view summary: how much work remains of each kind, the completion gate\'s blockers, the matrix axes, the '
  + 'modules the harness cannot screen, any configured exclusion, and the goal round. view cells: matrix cells '
  + 'with their verdict and who decided it, filtered by state (uncovered by default, or suspicious, cleared, all) '
  + 'and by module_prefix, paged with limit (default 50, at most 200) and offset; totalMatching says how many '
  + 'matched. A cell without a verdict still needs your read. A blind cell is a clear in a module the harness '
  + 'cannot screen: nothing but your own read stands behind it. view open-work: the full open-work list, paged '
  + 'the same way. view chains: every recorded weakness with what it grants and requires, the confirmed findings, '
  + 'every chain hypothesis with its links, and the material no chain hypothesis links yet.'

/** Default page size of a `hard_status` listing. */
const STATUS_DEFAULT_LIMIT = 50

/** Page-size ceiling of a `hard_status` listing; a larger request is held here. */
const STATUS_MAX_LIMIT = 200

/** Unscreened module names one `hard_status` summary lists before it relies on the count. */
const STATUS_UNSCREENED_LIST_LIMIT = 20

/** The bug class whose clears declare invariants rather than sinks. */
const LOGIC_CLASS = 'logic'

/**
 * Refuse a logic clear that does not state what it checked: at least two
 * declared sites, each followed by a note naming the invariant. A logic flaw
 * has no sink the harness can grep, so the declared invariants are the only
 * record of the read.
 * @param cell - the coverage cell about to be recorded.
 * @throws `HARD_TOOLS_LOGIC_INVARIANTS_REQUIRED` when the clear names fewer than two sites or a site without a note.
 */
function assertLogicInvariants(cell: { bugClass: string; verdict: string; declaredSinks: readonly string[] }): void {
  if (cell.bugClass !== LOGIC_CLASS || cell.verdict !== 'cleared') return
  if (cell.declaredSinks.length < 2 || cell.declaredSinks.some(sink => sink.trim().split(/\s+/u).length < 2)) {
    throw new HarnessError(
      'a logic clear declares at least two sites, each path:locator followed by a note stating the invariant it upholds',
      'HARD_TOOLS_LOGIC_INVARIANTS_REQUIRED',
    )
  }
}

/** The state filters a `hard_status` cell listing accepts. */
const STATUS_FILTERS = ['uncovered', 'suspicious', 'cleared', 'all'] as const

/** Whether one board cell passes a `hard_status` state filter. */
function cellMatchesFilter(cell: HardMatrixBoardCell, filter: (typeof STATUS_FILTERS)[number]): boolean {
  switch (filter) {
    case 'uncovered': return cell.verdict === undefined || cell.verdict === 'uncovered'
    case 'suspicious': return cell.verdict === 'suspicious'
    case 'cleared': return cell.verdict === 'cleared'
    case 'all': return true
  }
}

/**
 * Read and bound the page window of one `hard_status` listing: the limit
 * defaults to 50 and is held at 200, the offset defaults to 0.
 * @param args - the raw paging arguments.
 * @returns the validated limit and offset.
 */
function statusPage(args: { limit?: number; offset?: number }): { limit: number; offset: number } {
  const limit = args.limit ?? STATUS_DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
  const offset = args.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
  return { limit: Math.min(limit, STATUS_MAX_LIMIT), offset }
}

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

/**
 * Validate the entries of one hard_mark_module call beyond what the argument
 * schema checks: between one and {@link MARK_MODULE_CELL_LIMIT} entries, each
 * bug class at most once, and declared sites for every cleared entry.
 * @param module - the module every entry belongs to.
 * @param entries - the schema-checked `cells` argument.
 * @returns one coverage cell per entry, in argument order.
 */
function readModuleCells(
  module: string,
  entries: readonly { readonly bug_class: string; readonly verdict: 'cleared' | 'suspicious' | 'uncovered'; readonly declared_sinks?: readonly string[] }[],
): { module: string; bugClass: string; verdict: 'cleared' | 'suspicious' | 'uncovered'; declaredSinks: string[] }[] {
  if (entries.length === 0 || entries.length > MARK_MODULE_CELL_LIMIT) {
    throw new Error(`cells must list between 1 and ${MARK_MODULE_CELL_LIMIT} entries`)
  }
  const seen = new Set<string>()
  return entries.map((entry) => {
    const bugClass = entry.bug_class
    if (seen.has(bugClass)) throw new Error(`cells name bug_class ${bugClass} more than once`)
    seen.add(bugClass)
    const declaredSinks = [...entry.declared_sinks ?? []]
    if (entry.verdict === 'cleared' && declaredSinks.length === 0) {
      throw new HarnessError(`${bugClass}: cleared requires the declared sinks inspected for this cell`, 'HARD_LEDGER_SINKS_REQUIRED')
    }
    return { module, bugClass, verdict: entry.verdict, declaredSinks }
  })
}

/** Register the nine hard-harness tools. */
export function apply(ctx: Context, config: Config): void {  const ledger = ctx.hardLedger
  const verifier = ctx.hardVerifier
  const policy = resolveConfig(config)

  /**
   * Refuse cleared module-scoped cells whose sites do not show a real read:
   * a site citing more than `maxCitedRangeLines` lines, or fewer distinct
   * module files than `minClearedFiles` allows for the module's size. Every
   * cell belongs to one module, so the file count is read once.
   * @param agent - the live agent whose matrix pins the commit.
   * @param cells - the cells about to be recorded, all in one module.
   * @param prefix - names the offending cell in a multi-cell refusal.
   * @throws `HARD_TOOLS_CLEAR_EVIDENCE` naming every site and cell that falls short, so one corrected call can pass.
   */
  async function assertClearEvidence(
    agent: Parameters<typeof ledger.markCoverage>[0],
    cells: readonly { module: string; bugClass: string; verdict: string; declaredSinks: readonly string[] }[],
    prefix: (cell: { bugClass: string }) => string,
  ): Promise<void> {
    const clears = cells.filter(cell => cell.verdict === 'cleared' && classScope(cell.bugClass) === 'module')
    const shortfalls: string[] = []
    for (const cell of clears) {
      for (const sink of cell.declaredSinks) {
        const lines = parseSinkCitation(sink)?.lines
        if (lines === undefined || lines.last - lines.first + 1 <= policy.maxCitedRangeLines) continue
        shortfalls.push(`${prefix(cell)}${sink} cites ${String(lines.last - lines.first + 1)} lines; a clear cites the function `
          + `or the lines you read, at most ${String(policy.maxCitedRangeLines)} lines per site`)
      }
    }
    const [first] = clears
    if (first !== undefined && ledger.coverageMatrix(agent) !== undefined) {
      // One file is the floor every module meets, so it needs no count.
      const required = policy.minClearedFiles > 1
        ? Math.min(policy.minClearedFiles, await verifier.moduleFileCount(agent, first.module))
        : 1
      for (const cell of clears) {
        const files = new Set(cell.declaredSinks
          .map(sink => parseSinkCitation(sink)?.path)
          .filter((path): path is string => path !== undefined && inModule(path, cell.module)))
        if (files.size >= required) continue
        shortfalls.push(`${prefix(cell)}a clear of module "${cell.module}" cites sites in ${String(files.size)} of its files; `
          + `cite the sites you inspected in at least ${String(required)} different files of the module`)
      }
    }
    if (shortfalls.length > 0) throw new HarnessError(shortfalls.join('; '), 'HARD_TOOLS_CLEAR_EVIDENCE')
  }

  /**
   * Record one checked coverage verdict, then run the cross-check over it. A
   * cross-check that cannot run fails closed: the cell is re-recorded as a
   * harness-decided suspicious verdict and the failure rethrown.
   */
  async function recordAndCrossCheck(
    agent: NonNullable<Parameters<typeof ledger.markCoverage>[0]>,
    cell: { module: string; bugClass: string; verdict: 'cleared' | 'suspicious' | 'uncovered'; declaredSinks: string[] },
  ): Promise<{ coverage: { module: string; bugClass: string; verdict: string }; reopenedSinks: string[] }> {
    ledger.markCoverage(agent, cell)
    let reopened
    try {
      reopened = await verifier.auditCoverage(agent, cell)
    } catch (error: unknown) {
      /* v8 ignore next -- defensive: auditCoverage fails only with HARD_VERIFIER_AUDIT_FAILED. */
      if (!(error instanceof HarnessError) || error.code !== 'HARD_VERIFIER_AUDIT_FAILED') throw error
      ledger.markCoverage(agent, {
        module: cell.module, bugClass: cell.bugClass, verdict: 'suspicious', declaredSinks: [], source: 'harness',
      })
      throw error
    }
    if (reopened !== undefined) ledger.markCoverage(agent, reopened)
    const decided = reopened ?? cell
    return {
      coverage: { module: decided.module, bugClass: decided.bugClass, verdict: decided.verdict },
      reopenedSinks: reopened === undefined ? [] : [...reopened.declaredSinks],
    }
  }

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
        description: 'Target-repository-relative path of the PoC bash script, run as bash poc_path payload. '
          + 'It must take the exploit input as $1, '
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
      // A claim the verifier could never decide is refused before it becomes a finding that awaits verification forever.
      verifier.assertVerifiable(exec.agent, request)
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
      statement: {
        type: 'string',
        description: 'The hypothesis, concrete enough to test or refute. Required to propose one; '
          + 'omit it when moving an existing hypothesis to keep its statement.',
      },
      status: { type: 'string', required: true, enum: [...HYPOTHESIS_STATUSES], description: 'New lifecycle status.' },
      reason: { type: 'string', description: 'Required for refuted and deferred: the evidence or retry condition.' },
      links: {
        type: 'array', items: { type: 'string' },
        description: 'For a chain hypothesis: the W-n weaknesses and F-n confirmed findings it combines, at least two; '
          + 'omit it when moving an existing hypothesis to keep its links.',
      },
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
        ...args.statement === undefined ? {} : { statement: args.statement },
        status: args.status,
        ...args.reason === undefined ? {} : { reason: args.reason },
        ...args.links === undefined ? {} : { links: args.links },
      })
      return Promise.resolve({ hypothesis: { id, status: args.status } })
    },
    presentCall: args => present(`Hypothesis ${args.hypothesis_id ?? 'proposed'}: ${args.status}`, args.statement),
  }))

  ctx.tools.register(defineTool({
    name: 'hard_record_flaw',
    description: FLAW_DESCRIPTION,
    parameters: {
      title: { type: 'string', required: true, description: 'One-line name of the weakness.' },
      component: { type: 'string', required: true, description: 'Component, module, or file the weakness lives in.' },
      grants: { type: 'string', required: true, description: 'What an attacker gains from this weakness alone.' },
      requires: { type: 'string', required: true, description: 'What an attacker needs before the weakness is usable.' },
      sites: {
        type: 'array', required: true, items: { type: 'string' },
        description: 'Code sites as path:symbol, path:line, or path:start-end plus an optional note; at least one.',
      },
      finding_id: { type: 'string', description: 'The F-n finding that proved this weakness, when one exists.' },
      hypothesis_id: { type: 'string', description: 'The H-n hypothesis this weakness came from, when one exists.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          flaw: {
            type: 'object', additionalProperties: false, required: true,
            properties: { id: { type: 'string', required: true } },
          },
          unchained: { type: 'array', required: true, items: { type: 'string' }, description: 'Material no chain hypothesis links yet.' },
        },
      } as const,
      render: renderJson,
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('hard_record_flaw requires a live agent')
      if (args.sites.length > 0 && ledger.coverageMatrix(agent) !== undefined) {
        const { rejected } = await verifier.checkSinkCitations(agent, args.sites)
        if (rejected.length > 0) {
          throw new Error('hard_record_flaw rejected — every site must resolve at the pinned commit: '
            + rejected.map(entry => `${entry.sink} (${entry.reason})`).join('; '))
        }
      }
      const id = ledger.recordFlaw(agent, {
        title: args.title,
        component: args.component,
        grants: args.grants,
        requires: args.requires,
        sites: args.sites,
        ...args.finding_id === undefined ? {} : { findingId: args.finding_id.trim() },
        ...args.hypothesis_id === undefined ? {} : { hypothesisId: hypothesisId(args.hypothesis_id) },
      })
      return { flaw: { id }, unchained: [...ledger.unchainedMaterial(agent)] }
    },
    presentCall: args => present(`Weakness: ${args.title}`, args.component),
  }))

  ctx.tools.register(defineTool({
    name: 'hard_mark_coverage',
    description: COVERAGE_DESCRIPTION + clearEvidenceRule(policy),
    parameters: {
      module: { type: 'string', required: true, description: 'Module or directory swept, target-repo relative.' },
      bug_class: { type: 'string', required: true, description: 'Bug class swept in this cell.' },
      verdict: { type: 'string', required: true, enum: ['cleared', 'suspicious', 'uncovered'], description: 'Cell verdict.' },
      declared_sinks: {
        type: 'array', description: 'Code sites inspected, as path:symbol, path:line, or path:start-end plus an optional note; required for cleared.',
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
      // The ledger's row checks are cheap and decide first, so a refused cell
      // never costs a git call.
      ledger.assertCoverageCell(agent, cell)
      assertLogicInvariants(cell)
      // A clear claims the cited code was read: resolve every site at the
      // pinned commit before the record exists. Without an armed matrix there
      // is no commit to resolve against, and the merge-extensible default holds.
      const resolved = assertClearEvidence(agent, [cell], () => '').then(() =>
        args.verdict === 'cleared' && declaredSinks.length > 0 && ledger.coverageMatrix(agent) !== undefined
          ? verifier.checkSinkCitations(agent, declaredSinks)
          : { rejected: [] })
      return resolved.then(({ rejected }) => {
        if (rejected.length > 0) {
          throw new Error('hard_mark_coverage rejected — every declared site must resolve at the pinned commit: '
            + rejected.map(entry => `${entry.sink} (${entry.reason})`).join('; '))
        }
        return recordAndCrossCheck(agent, cell)
      })
    },
    presentCall: args => present(`Coverage ${args.module} x ${args.bug_class}: ${args.verdict}`, args.module),
  }))

  ctx.tools.register(defineTool({
    name: 'hard_mark_module',
    description: MARK_MODULE_DESCRIPTION + clearEvidenceRule(policy),
    parameters: {
      module: { type: 'string', required: true, description: 'Module swept, target-repo relative.' },
      cells: {
        type: 'array', required: true,
        description: 'One entry per bug class swept in this module.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            bug_class: { type: 'string', required: true, description: 'Bug class of this entry; each class at most once.' },
            verdict: { type: 'string', required: true, enum: ['cleared', 'suspicious', 'uncovered'], description: 'Verdict for this class.' },
            declared_sinks: {
              type: 'array', items: { type: 'string' },
              description: 'Code sites inspected for this class, as in hard_mark_coverage; required for cleared.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          module: { type: 'string', required: true },
          cells: {
            type: 'array', required: true,
            description: 'Per class: the recorded verdict, any sinks the cross-check reopened it with, and a cross-check failure.',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                bugClass: { type: 'string', required: true },
                verdict: { type: 'string', required: true },
                reopenedSinks: { type: 'array', required: true, items: { type: 'string' } },
                crossCheckFailed: { type: 'string' },
              },
            },
          },
          mapping: { type: 'string', description: 'While indexed entry points lack a feature: how many, and the order to map them now.' },
        },
      } as const,
      render: renderJson,
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('hard_mark_module requires a live agent')
      const cells = readModuleCells(args.module, args.cells)
      // Every entry is checked before any is recorded, so a refusal leaves the ledger untouched.
      for (const cell of cells) {
        try {
          ledger.assertCoverageCell(agent, cell)
          assertLogicInvariants(cell)
        } catch (error: unknown) {
          /* v8 ignore next -- defensive: both checks fail only with a HarnessError. */
          if (!(error instanceof HarnessError)) throw error
          throw new HarnessError(`${cell.bugClass}: ${error.message}`, error.code)
        }
      }
      await assertClearEvidence(agent, cells, cell => `${cell.bugClass}: `)
      const cleared = cells.filter(cell => cell.verdict === 'cleared')
      const sinks = [...new Set(cleared.flatMap(cell => cell.declaredSinks))]
      if (sinks.length > 0 && ledger.coverageMatrix(agent) !== undefined) {
        const { rejected } = await verifier.checkSinkCitations(agent, sinks)
        if (rejected.length > 0) {
          const reasons = new Map(rejected.map(entry => [entry.sink, entry.reason]))
          const named = cleared.flatMap(cell => cell.declaredSinks
            .filter(sink => reasons.has(sink))
            .map(sink => `${cell.bugClass}: ${sink} (${String(reasons.get(sink))})`))
          throw new Error(`hard_mark_module rejected — every declared site must resolve at the pinned commit: ${named.join('; ')}`)
        }
      }
      const recorded: { bugClass: string; verdict: string; reopenedSinks: string[]; crossCheckFailed?: string }[] = []
      for (const cell of cells) {
        try {
          const { coverage, reopenedSinks } = await recordAndCrossCheck(agent, cell)
          recorded.push({ bugClass: coverage.bugClass, verdict: coverage.verdict, reopenedSinks })
        } catch (error: unknown) {
          // A failed cross-check already re-recorded this class as suspicious; the other classes still record.
          /* v8 ignore next -- defensive: recordAndCrossCheck fails only with HARD_VERIFIER_AUDIT_FAILED once its entry is checked. */
          if (!(error instanceof HarnessError) || error.code !== 'HARD_VERIFIER_AUDIT_FAILED') throw error
          recorded.push({ bugClass: cell.bugClass, verdict: 'suspicious', reopenedSinks: [], crossCheckFailed: error.message })
        }
      }
      const total = ledger.featureMap(agent)?.entryPoints.length ?? 0
      const unmapped = ledger.unmappedEntryPoints(agent).length
      return {
        module: args.module,
        cells: recorded,
        ...unmapped === 0 ? {} : { mapping: markModuleMapping(unmapped, total) },
      }
    },
    presentCall: args => present(`Coverage ${args.module}: ${args.cells.length} classes`, args.module),
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
      if (classScope(args.bug_class) === 'repo') {
        throw new Error(`hard_clear_modules refuses ${args.bug_class}: it covers the whole repository in one cell, `
          + 'which a module grep cannot screen; record that cell with hard_mark_coverage on module "."')
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
    name: 'hard_status',
    description: STATUS_DESCRIPTION,
    parameters: {
      view: { type: 'string', required: true, enum: ['summary', 'cells', 'open-work', 'chains'], description: 'What to read.' },
      filter: {
        type: 'string', enum: [...STATUS_FILTERS],
        description: 'With view cells: which cells to list; uncovered by default.',
      },
      module_prefix: { type: 'string', description: 'With view cells: list only modules starting with this prefix.' },
      limit: { type: 'number', description: 'With view cells or open-work: page size, default 50, at most 200.' },
      offset: { type: 'number', description: 'With view cells or open-work: entries to skip, default 0.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          summary: {
            type: 'object', additionalProperties: false,
            properties: {
              matrix: {
                type: 'object', additionalProperties: false,
                properties: {
                  moduleCount: { type: 'integer', required: true },
                  bugClasses: { type: 'array', required: true, items: { type: 'string' } },
                  inertModuleCount: { type: 'integer', required: true },
                  unscreenedModules: { type: 'array', required: true, items: { type: 'string' }, description: 'The first unscreened modules; the count covers the rest.' },
                  unscreenedModuleCount: { type: 'integer', required: true },
                  excludeGlobs: { type: 'array', items: { type: 'string' } },
                  excludedFileCount: { type: 'integer' },
                },
              },
              openWork: {
                type: 'object', additionalProperties: false, required: true,
                properties: {
                  pendingFindings: { type: 'integer', required: true },
                  flakyFindings: { type: 'integer', required: true },
                  openHypotheses: { type: 'integer', required: true },
                  uncoveredCells: { type: 'integer', required: true },
                  suspiciousCells: { type: 'integer', required: true },
                  screenReReads: { type: 'integer', required: true },
                  unchainedMaterial: { type: 'integer', required: true },
                  unmappedEntryPoints: { type: 'integer', required: true },
                  unresolvedPairs: { type: 'integer', required: true },
                  unreviewedFeatures: { type: 'integer', required: true },
                },
              },
              gate: {
                type: 'object', additionalProperties: false, required: true,
                properties: {
                  complete: { type: 'boolean', required: true },
                  blockers: { type: 'array', required: true, items: { type: 'string' } },
                },
              },
              goalRound: {
                type: 'object', additionalProperties: false,
                properties: { started: { type: 'integer', required: true }, max: { type: 'integer', required: true } },
              },
            },
          },
          cells: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                module: { type: 'string', required: true },
                bugClass: { type: 'string', required: true },
                scope: { type: 'string', required: true, enum: ['module', 'repo'] },
                verdict: { type: 'string', enum: ['cleared', 'suspicious', 'uncovered'] },
                source: { type: 'string', enum: ['model', 'model-verified', 'harness'] },
                blind: { type: 'boolean', required: true },
              },
            },
          },
          openWork: { type: 'array', items: { type: 'string' } },
          chains: {
            type: 'object', additionalProperties: false,
            properties: {
              weaknesses: {
                type: 'array', required: true,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    component: { type: 'string', required: true },
                    grants: { type: 'string', required: true },
                    requires: { type: 'string', required: true },
                    findingId: { type: 'string' },
                  },
                },
              },
              confirmedFindings: {
                type: 'array', required: true,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    component: { type: 'string', required: true },
                  },
                },
              },
              chainHypotheses: {
                type: 'array', required: true,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    status: { type: 'string', required: true },
                    links: { type: 'array', required: true, items: { type: 'string' } },
                    statement: { type: 'string', required: true },
                  },
                },
              },
              unchained: { type: 'array', required: true, items: { type: 'string' }, description: 'Material no chain hypothesis links yet.' },
            },
          },
          totalMatching: { type: 'integer' },
          offset: { type: 'integer' },
        },
      } as const,
      render: renderJson,
    },
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('hard_status requires a live agent')
      if (args.view === 'summary') {
        const matrix = ledger.coverageMatrix(agent)
        const unscreened = matrix?.unscreenedModules ?? []
        const goal = ctx.get('goals')?.get(agent)
        const gate = ledger.completionAssessment(agent)
        return Promise.resolve({
          summary: {
            ...(matrix === undefined ? {} : {
              matrix: {
                moduleCount: matrix.modules.length,
                bugClasses: [...matrix.bugClasses],
                inertModuleCount: (matrix.inertModules ?? []).length,
                unscreenedModules: unscreened.slice(0, STATUS_UNSCREENED_LIST_LIMIT),
                unscreenedModuleCount: unscreened.length,
                ...(matrix.exclusions === undefined ? {} : {
                  excludeGlobs: [...matrix.exclusions.globs],
                  excludedFileCount: matrix.exclusions.fileCount,
                }),
              },
            }),
            openWork: ledger.openWorkCounts(agent),
            gate: { complete: gate.complete, blockers: [...gate.blockers] },
            ...(goal === undefined ? {} : { goalRound: { started: goal.roundsStarted, max: goal.maxGoalRounds } }),
          },
        })
      }
      if (args.view === 'chains') {
        return Promise.resolve({
          chains: {
            weaknesses: ledger.flaws(agent).map(flaw => ({
              id: flaw.id,
              title: flaw.title,
              component: flaw.component,
              grants: flaw.grants,
              requires: flaw.requires,
              ...(flaw.findingId === undefined ? {} : { findingId: flaw.findingId }),
            })),
            confirmedFindings: ledger.findings(agent)
              .filter(entry => entry.verdict?.verdict === 'confirmed')
              .map(entry => ({ id: entry.proposed.id, title: entry.proposed.title, component: entry.proposed.component })),
            chainHypotheses: ledger.hypotheses(agent).flatMap(hypothesis => hypothesis.links === undefined
              ? []
              : [{ id: hypothesis.id, status: hypothesis.status, links: [...hypothesis.links], statement: hypothesis.statement }]),
            unchained: [...ledger.unchainedMaterial(agent)],
          },
        })
      }
      const { limit, offset } = statusPage(args)
      if (args.view === 'open-work') {
        const work = ledger.openWork(agent)
        return Promise.resolve({ openWork: work.slice(offset, offset + limit), totalMatching: work.length, offset })
      }
      const filter = args.filter ?? 'uncovered'
      const prefix = args.module_prefix
      const matching = ledger.matrixBoard(agent).filter(cell => cellMatchesFilter(cell, filter)
        && (prefix === undefined || cell.module.startsWith(prefix)))
      return Promise.resolve({
        cells: matching.slice(offset, offset + limit).map(cell => ({ ...cell })),
        totalMatching: matching.length,
        offset,
      })
    },
    presentCall: args => present(`Status: ${args.view}${args.filter === undefined ? '' : ` (${args.filter})`}`, args.view),
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
