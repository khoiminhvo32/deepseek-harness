# Hard harness

English | [中文](hard-harness.zh.md)

Experimental hard-harness services keep one long-running objective alive in a session. The [mission plugin](../../packages/experimental/hard-mission/README.md) arms the configured objective as a durable goal, the [ledger](../../packages/experimental/hard-ledger/README.md) owns findings, hypotheses, coverage, and sweep state over additive `hard/*` session events, the [verifier](../../packages/experimental/hard-verifier/README.md) executes findings' proofs of effect through the shell seam — benign arm first, exploit arm second, so the proof must depend on the payload — and recomputes their CVSS 4.0 scores, the [tools](../../packages/experimental/hard-tools/README.md) are the model-facing surface, the [stop gate](../../packages/experimental/hard-stopgate/README.md) steers the turn boundary back to work while an armed goal stands and owns completion: it runs the ledger's completion assessment on every `update_goal action complete` attempt, denies early attempts with the exact remaining work, and records each decision as a `hard/gate/decision` event, the [standby](../../packages/experimental/hard-standby/README.md) waits out terminal quota failures and wakes the mission at the reset time, the [handoff](../../packages/experimental/hard-handoff/README.md) injects the durable ledger summary after each successful compaction, the [round driver](../../packages/experimental/hard-rounds/README.md) accounts for admitted goal rounds over the shipped goal-round driver and enforces the per-round step budget, the [deep-read template](../../packages/experimental/hard-deepread/README.md) owns the Phase B flow-document contract, and the opt-in [independent audit](../../packages/experimental/hard-audit/README.md) has a fresh, blind reader re-read a sample of cleared cells in shadow mode. The verifier coverage cross-check re-greps sampled `cleared` cells — sink classes against the fixed sink patterns, and the guarded-surface classes `authz`/`authn-bypass` against the exported operations, reopening a cell whose module still matches an undeclared sink or exports an operation no declaration mentions — and the verifier resolves every `hard_record_flow` citation against the pinned commit before a `hard/flow/doc` summary is recorded.

## Running the bundle

The hard bundle is an installation-owned optional bundle: switch it on for a profile in the plugin manager (`dsh plugin --profile <name>`), and it stacks over whatever composition that profile selects — the headless composition for CLI sessions, the Web composition for GUI sessions with the coverage panel. Supply the objective and the target repository through a profile patch overriding the `hard-mission` row's `objective` and `target.repoPath` (the bundle ships blanks and fails the load until real values are set). The verifier's coverage cross-check samples `cleared` cells per `coverageSpotCheckPercent` and reopens under-declared cells as `suspicious`; a cross-check grep that errors marks the cell `suspicious` and fails the tool call instead of passing it.

## Ledger state

The ledger is log-derived: `ctx.hardLedger` appends validated `hard/*` events and reads the `hardLedger` session projection, a pure fold the framework restores at resume and advances on every commit. Finding ids (`F-n`) and hypothesis ids (`H-n`) are assigned from the projected counts. The verifier records exactly one verdict per proposal; a split verdict is flaky and never counts as progress.

The coverage matrix comes from the mission's arming record: at load the mission plugin captures the configured target — a git repository, a plain directory, or one file — into a git store the harness owns outside the target, and enumerates every file of that snapshot commit, so the denominator reproduces byte-for-byte on the same content. The snapshot holds what the model saw at arming, uncommitted changes included; files the model writes later stay outside it, and citations and the independent reader resolve against it. Nothing is excluded by default; a configured exclusion is recorded in the arming record and reported beside the coverage ratio. The matrix rides one additive `hard/mission/armed` event. Three economics keep the denominator reachable on real repositories: `CLASS_SCOPE` gives `dependencies` and `misconfig` one repository-level cell instead of one per module; modules whose every tracked file is non-executable (`inertModules`) are pre-verdicted by the harness without a model event; and `hard_clear_modules` batch-screens one class across modules behind a harness grep that unions the model's patterns with the fixed table, recording `source: model-verified` — the weakest model tier, which never satisfies the completion assessment's audit floor — while the model's own marks stay unattributed (read as `model`). The grep can only accuse: a module holding a binary or a language the fixed tables were not written for is recorded as unscreened, a batch screen there is refused, and a model clear there counts as a blind clear. `coverageProgress` counts verdicts over the scoped total, `uncoveredCells` lists only the cells that still need the model, `coverageBySource` partitions verdicts by decider, and `openWork` sends a hash-sampled share of batch-cleared cells back for a manual re-read so the screen's false-negative rate stays measured.

## Proof-of-effect contract

`ctx.hardVerifier.verify` runs a finding's proof of concept through the configured shell, `runs` times. A run satisfies the contract only when it exits zero and prints `HARD-PASS <sha256 of claim>` on stdout; all runs passing confirms, all failing refutes, any split is flaky. The claimed CVSS 4.0 score is recomputed from the vector against the vendored FIRST reference data, and a confirmed root cause rejects duplicate proposals. Every refuted verdict carries an aggregable `cause` (`benign-arm-passed`, `no-marker`, `nonzero-exit`, `timeout`, `aborted`, `no-runs`), and `ctx.hardLedger.refutationBreakdown` groups them into protocol failures, genuine refutations, and infrastructure; the optional `evidence` field reserves `proven` for a future differential runner, and every confirmed verdict carries `demonstrated` — everything the verifier produces today is a model-written PoC through the specificity check — while confirms recorded before the specificity check lack the field and read as weaker.

## Step budgets

The two step limits measure different things. `hard-rounds`' `stepsPerRound` is a round's steering budget, checked in `agent/turn-stopping` — a hook that only fires when the model wants to stop — so it bounds how far the driver can push a round, never cost. `maxStepsPerTurn` is the cost cap, checked at the `agent/pre-step` boundary of every turn, whether or not a round owns it; reaching it rejects the step, the turn closes `blocked`, and the stop is recorded as a durable `hard/step-cap/reached` event naming the turn, the steps that had run, the limit, and the round when one owns the turn.

## Independent audit

A clear has no machine witness, so the audit measures how often a clear is wrong by having another model read the same cell. When the mission agent clears a cell, `hard-audit` samples the clear by tier — unscreened model reads most, batch screens next, screenable per-cell reads least, salted by the pinned commit — and records `hard/audit/requested` with the seq of the clear it reads. A spawned reader gets the target, the commit, the cell, and a neutral class definition, never the verdict, declared sites, or any other ledger record, and may read the whole repository. The reader works in a temporary worktree of the snapshot commit, so the mission agent's later edits and PoCs never reach it. Its report counts only when every cited site resolves at the pinned commit, the cell holds no unreadable binary, and every path the reader read stayed inside its worktree; otherwise `hard/audit/result` records `unavailable` with the cause. The audit runs in shadow mode: nothing it records reaches the mission agent, its open work, or the completion gate.

## Design rationale

The hard-harness design record (.agents/plans/2026-10-04-hard-harness-design.md) owns the verification-driven contract and the two-pass methodology. The standby keeps the session alive through provider quota windows: it schedules a bounded wait on a terminal `QUOTA` failure, folds it through the `hardStandby` projection, and at the wake resumes an active disarmed goal and delivers a continuation follow-up, never reviving paused or capped work. The handoff bridges compaction: after each successful `compaction/end` it injects one deterministic summary of findings, hypotheses, coverage, and open work, assembled only from ledger folds.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxhardledger--hardledger"></a>

### `ctx.hardLedger` — `HardLedger`

The hard-harness ledger: validates and appends `hard/*` events, and serves findings, hypotheses, coverage, the armed coverage matrix, and open-work state from the projection.

```ts cordis-catalog
/**
 * Append the mission arming record: the pinned target and the enumerated
 * coverage matrix axes. The mission plugin appends it once, right after
 * the goal is created.
 * @param agent - the live agent whose session receives the record.
 * @param data - the armed payload to persist.
 */
recordMissionArmed(agent: Agent, data: HardMissionArmedData): void

/**
 * Append one validated finding-proposal record and return its id.
 * @param agent - the live agent whose session receives the record.
 * @param request - the validated finding fields with the exploit payload required; id assigned from the projection.
 * @returns the assigned finding id.
 */
proposeFinding(agent: Agent, request: HardFindingRequest): HardFindingId

/**
 * Append the verifier's executed outcome for one proposed finding.
 * @param agent - the live agent whose session receives the record.
 * @param data - the verdict payload to persist.
 */
recordVerdict(agent: Agent, data: HardFindingVerdictData): void

/**
 * Propose a new hypothesis or transition an existing one through its lifecycle.
 * @param agent - the live agent whose session receives the record.
 * @param request - status, statement (omittable for an existing id, which keeps its
 *   statement), optional existing id, and conditional reason.
 * @returns the assigned or confirmed hypothesis id.
 */
writeHypothesis( agent: Agent, request: { id?: string; statement?: string; status: HardHypothesisStatus; reason?: string }, ): HardHypothesisId

/**
 * Append one coverage cell verdict, replacing any prior verdict for the cell.
 * @param agent - the live agent whose session receives the record.
 * @param request - the cell coordinates, verdict, and declared sink sites; the module must be an armed matrix row when a matrix exists.
 */
markCoverage(agent: Agent, request: HardCoverageCellData): void

/**
 * Validate the cell one coverage verdict names. A module-scoped class takes
 * a matrix row, and a cleared verdict refuses an inert row — it duplicates
 * the screen the harness already ran, while suspicious stays accepted so a
 * real sighting surfaces. A repository-scoped class has one cell for the
 * whole repository that a verdict on any module records, so no row check
 * applies: the root module `.` the steering names may be inert, or no row
 * at all, without affecting what the class covers.
 * @param agent - the live agent whose ledger matrix anchors the check.
 * @param cell - the module, bug class, and verdict being recorded.
 * @throws `HARD_LEDGER_MODULE_NOT_IN_MATRIX` or `HARD_LEDGER_INERT_MODULE` for a module-scoped class, as the row checks do.
 */
assertCoverageCell(agent: Agent, cell: Pick<HardCoverageCellData, 'module' | 'bugClass' | 'verdict'>): void

/**
 * Reject modules outside the armed coverage matrix, naming the valid rows
 * so the caller can correct its target list instead of guessing. A module
 * the model invented — an untracked directory such as its own `poc/`
 * scratch folder — is not a matrix row, so sweeping it is wasted steps and
 * noise in the cell list. Without an armed matrix (the mission plugin is
 * not mounted, or the log predates arming) every module passes — the
 * merge-extensible default.
 * @param agent - the live agent whose ledger matrix anchors the check.
 * @param modules - the module names to validate.
 * @throws `HARD_LEDGER_MODULE_NOT_IN_MATRIX` listing the offending modules and the bounded valid rows.
 */
assertModulesInMatrix(agent: Agent, modules: readonly string[]): void

/**
 * Reject `cleared` verdicts on inert modules. The harness already screened
 * an inert module as carrying no code, so its cells stand as harness
 * verdicts — a model `cleared` there is redundant work, not diligence.
 * A `suspicious` verdict still passes: if the model really saw something
 * in a module this size, that signal must not be blocked.
 * @param agent - the live agent whose ledger matrix carries the inert screen.
 * @param modules - the module names a `cleared` verdict is about to record.
 * @throws `HARD_LEDGER_INERT_MODULE` naming the inert modules in the list.
 */
assertClearableModules(agent: Agent, modules: readonly string[]): void

/**
 * Reject a batch screen over modules the coverage cross-check cannot screen.
 * A batch clear rests only on a grep over the modules, and the grep is
 * silent on a module holding a binary or a language the fixed pattern
 * tables were not written for — so the shortcut is closed there and every
 * cell needs an individual model read. Per-cell verdicts stay open on such
 * modules; they surface as blind clears. Without an armed matrix, or on an
 * arming record that predates the screenability field, every module passes.
 * @param agent - the live agent whose ledger matrix carries the screenability record.
 * @param modules - the module names a batch screen is about to clear.
 * @throws `HARD_LEDGER_UNSCREENED_MODULE` naming the unscreened modules in the list.
 */
assertScreenableModules(agent: Agent, modules: readonly string[]): void

/**
 * Append one completed sweep summary. An empty sweep must cite verifiable
 * evidence the ledger can check — a refuted hypothesis, a model-cleared
 * cell with declared sinks, or a recorded flow document with resolvable
 * citations; a harness-screened cell cannot prove a sweep did work. A sweep
 * with findings carries no proof. The legacy free-text `emptyProof` is only
 * read from older logs; new records carry `emptyProofRef` or
 * `emptyProofFlowDoc`.
 * @param agent - the live agent whose session receives the record.
 * @param request - the sweep phase, counters, and conditional empty proof.
 */
recordSweep(agent: Agent, request: HardSweepSummaryData): void

/**
 * Append one recorded flow document for a module. The verifier must have
 * resolved every citation against the pinned commit before this append —
 * the tool rejects the whole record when any cite fails, so a recorded
 * document certifies reads, not promises.
 * @param agent - the live agent whose session receives the record.
 * @param data - the summary to persist: section counts, resolved citation count, and the quirks' hypothesis ids.
 */
recordFlowDoc(agent: Agent, data: HardFlowDocData): void

/**
 * Flow documents folded to their latest record per module.
 * @param agent - the live agent whose ledger state is read.
 * @returns one record per module, in first-recorded order.
 */
flowDocs(agent: Agent): readonly HardFlowDocData[]

/**
 * Findings folded from the projection, proposal plus latest verdict when present.
 * @param agent - the live agent whose ledger state is read.
 * @returns one record per proposal in id order.
 */
findings(agent: Agent): readonly HardLedgerFindingEntry[]

/**
 * Decompose the refuted verdicts by cause code, so one run can say whether
 * it failed at the protocol layer or the target layer. The math lives in
 * `refutationBreakdownFromState` — the same function the pilot report
 * reads after folding the log.
 * @param agent - the live agent whose ledger holds the findings.
 * @returns refuted-verdict counts per cause plus the reading groups; a
 *   refuted verdict predating the cause codes counts under `unattributed`
 *   in `byCause` and in no group.
 */
refutationBreakdown(agent: Agent): RefutationBreakdown

/**
 * Hypotheses folded to their latest state per id.
 * @param agent - the live agent whose ledger state is read.
 * @returns one record per hypothesis id.
 */
hypotheses(agent: Agent): readonly HardHypothesisStateData[]

/**
 * Coverage cells folded to their latest verdict per module and class.
 * @param agent - the live agent whose ledger state is read.
 * @returns one record per module and bug-class cell.
 */
coverage(agent: Agent): readonly HardCoverageCellData[]

/**
 * Count of recorded sweeps by phase, for the rotation cadence.
 * @param agent - the live agent whose ledger state is read.
 * @param phase - the sweep phase to count.
 * @returns the number of summaries recorded for the phase.
 */
sweepCount(agent: Agent, phase: 'A' | 'B'): number

/**
 * Consecutive empty-verified sweep summaries ending at the latest one.
 * Proof validity is a record-time invariant, so `newFindings === 0` is the
 * whole predicate here. The math lives in `emptySweepRunFromState`.
 * @param agent - the live agent whose ledger state is read.
 * @returns the trailing run length, bounded by the projection's sweep window.
 */
emptySweepRun(agent: Agent): number

/**
 * The goal id the mission armed, when the arming record carries it. The
 * completion gate only fires for this goal; records without the id predate
 * goal attribution and never gate.
 * @param agent - the live agent whose ledger state is read.
 * @returns the armed goal id, or `undefined` without an attributed arming record.
 */
armedGoalId(agent: Agent): string | undefined

/**
 * Whether the harness certifies the mission complete. Every condition reads
 * ledger state; none counts findings (a finding quota would pressure
 * fabrication — a clean repository must complete). The conditions: no open
 * work, the trailing sweep window all empty-verified (the threshold is this
 * service's `emptySweepsToFinish` config, so every consumer reads one
 * answer), and at least one model-audited coverage cell or resolved
 * hypothesis so a fully harness-screened repository reads as "nothing
 * audited yet", not "done". The math lives in
 * `completionAssessmentFromState`, shared with the projection's wire view.
 * @param agent - the live agent whose ledger state is read.
 * @returns the verdict plus the bounded blockers, phrased to serve directly as the denial reason.
 */
completionAssessment(agent: Agent): CompletionAssessment

/**
 * The coverage matrix folded from the mission arming record.
 * @param agent - the live agent whose ledger state is read.
 * @returns the matrix axes and pinned target, or `undefined` when no
 *   arming record exists (legacy log, or the mission plugin is not mounted).
 */
coverageMatrix(agent: Agent): HardCoverageMatrix | undefined

/**
 * Coverage progress over the matrix: matrix cells holding a verdict,
 * of the whole matrix. Cells outside the matrix never count. A
 * repository-scoped class is verdicted once for the whole repository, so
 * its verdict lookup deliberately ignores the recorded cell's module. The
 * math lives in `coverageProgressFromState` — the same function the pilot
 * report reads after folding the log.
 * @param agent - the live agent whose ledger state is read.
 * @returns the verdicted count and the matrix cell total, `0/0` without a matrix.
 */
coverageProgress(agent: Agent): CoverageProgress

/**
 * Matrix cells that still need the model, in matrix order: sorted modules
 * outer, the configured class order inner, then repository-scoped cells
 * under the `.` module. Inert modules carry no module-class surface and are
 * never listed; a repository-scoped class is listed once, not per module.
 * The math lives in `uncoveredCellsFromState`.
 * @param agent - the live agent whose ledger state is read.
 * @returns one entry per uncovered matrix cell, empty without a matrix.
 */
uncoveredCells(agent: Agent): readonly { module: string; bugClass: string }[]

/**
 * Verdicted matrix cells partitioned by who decided them: the model's own
 * reads, batch screens the model cleared without reading, and every harness
 * decision. A cell carrying no source reads as `model`, so older
 * logs partition unchanged. The math lives in `coverageBySourceFromState` —
 * the same function the pilot report reads after folding the log.
 * @param agent - the live agent whose ledger state is read.
 * @returns the three counts; all zero without a matrix.
 */
coverageBySource(agent: Agent): CoverageBySource

/**
 * Model-cleared module-scoped matrix cells in modules the coverage
 * cross-check cannot screen, where nothing but the model's own read stands
 * behind the verdict. The math lives in `blindClearsFromState`.
 * @param agent - the live agent whose ledger state is read.
 * @returns the blind-clear count; zero without a screenability record.
 */
blindClears(agent: Agent): number

/**
 * Model-facing open work summary: pending verifications, unresolved
 * states, coverage cells that still owe work, and batch-cleared cells the
 * deterministic screen spot-check sends back for a manual re-read. The
 * math lives in `openWorkFromState`.
 * @param agent - the live agent whose ledger state is read.
 * @returns bounded human-readable work items, empty when nothing is open.
 */
openWork(agent: Agent): string[]

/**
 * Open work counted by kind with the same predicates `openWork` lists by.
 * The math lives in `openWorkCountsFromState`.
 * @param agent - the live agent whose ledger state is read.
 * @returns the per-kind counts.
 */
openWorkCounts(agent: Agent): OpenWorkCounts

/**
 * Every matrix cell with its current state, in matrix order — the board the
 * model reads to see what remains. The math lives in `matrixBoardFromState`.
 * @param agent - the live agent whose ledger state is read.
 * @returns one entry per matrix cell; empty without a matrix.
 */
matrixBoard(agent: Agent): readonly HardMatrixBoardCell[]
```

Types: [Agent](core.md)

Source: [`packages/experimental/hard-ledger/src/index.ts`](../../packages/experimental/hard-ledger/src/index.ts)

<a id="ctxhardverifier--hardverifier"></a>

### `ctx.hardVerifier` — `HardVerifier`

The hard-harness verifier on the `hardVerifier` key: rejects duplicates, executes proofs of effect through the shell seam, recomputes CVSS 4.0 scores against the claimed ones, and records the durable verdict.

```ts cordis-catalog
/**
 * Verify one proposed finding: reject duplicates, recompute CVSS, then run
 * the proof through the shell seam in two arms and append the durable
 * verdict. The benign arm runs the PoC once with a benign payload derived
 * from the claim hash and must FAIL — a proof that passes regardless of
 * input proves nothing about the input (the specificity check). Only then
 * does the exploit arm run the configured number of times with the model's
 * payload. The PoC executes from the pinned target repository the armed
 * matrix records (matching the model-relative `pocPath` and coverage
 * modules); `pocWorkdir` is the explicit override and no matrix keeps the
 * legacy shell cwd.
 * @param agent - the live agent whose ledger receives the verdict.
 * @param proposed - the proposal record to verify; its `payload` is the exploit input.
 * @returns the appended verdict record.
 */
async verify( agent: Agent, proposed: HardFindingRequest & Pick<HardFindingProposedData, 'id'>, ): Promise<HardFindingVerdictData>

/**
 * Refuse a proposal the verifier could never decide: a root cause a
 * confirmed finding already holds, or a CVSS vector that does not parse.
 * Callers run it before appending the proposal, so a refused claim never
 * becomes a finding that awaits verification forever; `verify` runs it
 * again for callers that skip it.
 * @param agent - the live agent whose ledger holds the findings.
 * @param request - the proposal fields, with its id once it has been appended.
 * @returns the recomputed score and whether the claimed score matches it.
 * @throws `HARD_VERIFIER_DUPLICATE` or `HARD_VERIFIER_INVALID_VECTOR`.
 */
assertVerifiable( agent: Agent, request: Pick<HardFindingRequest, 'fingerprint' | 'cvssVector' | 'cvssClaimed'> & { readonly id?: string }, ): { computed: number; match: boolean }

/**
 * Deterministic cross-check of one `cleared` coverage cell, branched by the
 * class's reading. Presence classes (the default): re-grep the module
 * against the fixed sink patterns and reopen the cell as `suspicious` when
 * undeclared sink sites surface. Guarded-surface classes (`authz`,
 * `authn-bypass`): re-grep for the exported operations and reopen when the
 * module still exports an operation the model never declared a guard for —
 * the reopening evidence is the missed operation names. Both greps run from
 * the pinned target repository the armed coverage matrix records, so the
 * module path is always target-repo relative: a repository-scoped class
 * greps the whole tree, and the root module `.` greps only the files at the
 * root. Sampling follows the
 * configured spot-check percent by cell hash; an unsampled cell, a
 * non-cleared cell, a class without applicable patterns, a missing matrix,
 * or a grep with no undeclared matches returns `undefined` and changes
 * nothing. The check fails closed: a grep that errors, times out, or is
 * aborted never reads as a clean cell.
 * @param agent - the live agent whose ledger matrix anchors the grep.
 * @param cell - the coverage cell the model just marked `cleared`.
 * @returns the reopening record to persist through the ledger, or `undefined` when the check passes or does not apply.
 * @throws `HARD_VERIFIER_AUDIT_FAILED` when the cross-check grep errors, times
 *   out, or is aborted — an unevaluated grep is not evidence of absence.
 */
async auditCoverage(agent: Agent, cell: CoverageAuditCell): Promise<CoverageReopenRecord | undefined>

/**
 * Resolve every flow-document citation against the pinned target commit —
 * `git show <sha>:<path>`, never the working tree — so a citation the model
 * edited into existence after the arming cannot resolve. A cite passes only
 * when the path is tracked at the pinned commit, the line exists there, and
 * the snippet is a trimmed substring of that line's content. The check is
 * the flow-document floor: prose cannot be verified, but a resolvable
 * citation forces the model to open the right file at the right lines, so
 * fabricating one costs approximately what reading it does. It fails
 * closed: a git invocation that errors, times out, or is aborted throws
 * instead of reading as a failed citation.
 * @param agent - the live agent whose ledger matrix carries the pinned commit.
 * @param citations - the citations to resolve, in any order.
 * @returns the rejected citations with per-cite reasons; empty means every cite resolved.
 * @throws `HARD_VERIFIER_NO_MATRIX` when no coverage matrix is armed.
 * @throws `HARD_VERIFIER_CITATION_FAILED` when a git invocation does not settle cleanly.
 */
async checkFlowCitations( agent: Agent, citations: readonly FlowCitationEntry[], ): Promise<{ rejected: readonly FlowCitationReject[] }>

/**
 * Resolve every declared site of a `cleared` coverage cell against the
 * pinned commit, through git alone so the outcome does not depend on the
 * host's `grep`. A site passes when its path is tracked at the commit and,
 * for a text file, the commit's file has the cited line or contains the
 * cited symbol (`git grep -I -F`). A binary — classified by a numstat diff
 * against the empty tree, the content test `grep -I` applies — passes the
 * path check without its content being read as resolved: its module is
 * unscreened, so the clear stands as a blind clear. A symbol match can sit in
 * a comment; this guards against citing code that does not exist, not
 * against a wrong clear. It fails closed: a git invocation that errors,
 * times out, or is aborted throws instead of reading as a verdict.
 * @param agent - the live agent whose ledger matrix carries the pinned commit.
 * @param sinks - the declared-site strings, in any order.
 * @returns the refused sites with per-site reasons; empty means every site resolved.
 * @throws `HARD_VERIFIER_NO_MATRIX` when no coverage matrix is armed.
 * @throws `HARD_VERIFIER_CITATION_FAILED` when a git invocation does not settle cleanly.
 */
async checkSinkCitations(agent: Agent, sinks: readonly string[]): Promise<{ rejected: readonly SinkCitationReject[] }>

/**
 * Mechanical screen behind the batch clear: grep the requested modules for
 * the union of the model's patterns and the class's fixed patterns,
 * anchored at the pinned target repository; the root module `.` greps only
 * the files at the root. The union means the model's
 * patterns can only ADD matches, never subtract — a narrow pattern choice
 * cannot sneak past the harness table. Any match fails the whole batch and
 * returns the matching lines as evidence for a manual read. An empty grep
 * is silence, not proof of absence: the caller records the cells as a batch
 * screen, the weakest model tier, and refuses modules the tables cannot
 * screen before this runs. The pattern table follows the class's reading:
 * guarded-surface classes grep for the exported operations, sink classes
 * grep for the sink shapes, and the one remaining absence-shaped class
 * (`login-bypass`) is refused — for its protective sinks an empty grep is
 * suspicious, not clean.
 * @param agent - the live agent whose ledger matrix anchors the grep.
 * @param bugClass - the bug class to prove absent.
 * @param modules - the target-repo-relative modules to grep.
 * @param patterns - the model's own extended-regex absence patterns.
 * @returns `clean: true` when every grep came back empty, else `clean: false` with the bounded matching lines.
 * @throws when the class is absence-shaped or has no fixed patterns, the grep errors, or no matrix is armed.
 */
async screenModules( agent: Agent, bugClass: string, modules: readonly string[], patterns: readonly string[], ): Promise<{ clean: boolean; evidence: readonly string[] }>
```

Types: [Agent](core.md)

Source: [`packages/experimental/hard-verifier/src/index.ts`](../../packages/experimental/hard-verifier/src/index.ts)
<!-- END GENERATED cordis-surface -->
