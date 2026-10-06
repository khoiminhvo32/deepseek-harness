# Hard harness

English | [中文](hard-harness.zh.md)

Experimental hard-harness services keep one long-running objective alive in a session. The [mission plugin](../../packages/experimental/hard-mission/README.md) arms the configured objective as a durable goal, the [ledger](../../packages/experimental/hard-ledger/README.md) owns findings, hypotheses, coverage, and sweep state over additive `hard/*` session events, the [verifier](../../packages/experimental/hard-verifier/README.md) executes findings' proofs of effect through the shell seam and recomputes their CVSS 4.0 scores, the [tools](../../packages/experimental/hard-tools/README.md) are the model-facing surface, the [stop gate](../../packages/experimental/hard-stopgate/README.md) steers the turn boundary back to work while an armed goal stands, the [standby](../../packages/experimental/hard-standby/README.md) waits out terminal quota failures and wakes the mission at the reset time, the [handoff](../../packages/experimental/hard-handoff/README.md) injects the durable ledger summary after each successful compaction, the [round driver](../../packages/experimental/hard-rounds/README.md) accounts for admitted goal rounds over the shipped goal-round driver and enforces the per-round step budget, and the [deep-read template](../../packages/experimental/hard-deepread/README.md) owns the Phase B flow-document contract. The verifier coverage cross-check re-greps sampled `cleared` cells against each bug class fixed sink patterns and reopens a cell whose module still matches an undeclared sink.

## Running the profile

The shipped `hard` profile stacks `dsh-base`, `dsh-headless`, and this bundle: `dsh --profile hard "<objective>"` arms the objective as the mission and keeps the session working until the goal completes. Supply the objective and the target repository through a profile patch overriding the `hard-mission` row's `objective` and `target.repoPath` (the bundle ships blanks and fails the load until real values are set). The verifier's coverage cross-check samples `cleared` cells per `coverageSpotCheckPercent` and reopens under-declared cells as `suspicious`; a cross-check grep that errors marks the cell `suspicious` and fails the tool call instead of passing it.

## Ledger state

The ledger is log-derived: `ctx.hardLedger` appends validated `hard/*` events and reads the `hardLedger` session projection, a pure fold the framework restores at resume and advances on every commit. Finding ids (`F-n`) and hypothesis ids (`H-n`) are assigned from the projected counts. The verifier records exactly one verdict per proposal; a split verdict is flaky and never counts as progress.

The coverage matrix comes from the mission's arming record: at load the mission plugin pins the configured target repository (resolving `target.commit` to its full sha) and enumerates the tracked modules with `git ls-files`, so the denominator respects `.gitignore` and reproduces byte-for-byte on the same commit. The matrix rides one additive `hard/mission/armed` event. Three economics keep the denominator reachable on real repositories: `CLASS_SCOPE` gives `dependencies` and `misconfig` one repository-level cell instead of one per module; modules whose every tracked file is non-executable (`inertModules`) are pre-verdicted by the harness without a model event; and `hard_clear_modules` batch-clears one class across modules behind a harness grep that unions the model's patterns with the fixed table, recording `source: model-verified` while the model's own marks stay unattributed (read as `model`). `coverageProgress` counts verdicts over the scoped total, `uncoveredCells` lists only the cells that still need the model, `coverageBySource` partitions verdicts by decider, and `openWork` sends a hash-sampled share of batch-cleared cells back for a manual re-read so the screen's false-negative rate stays measured.

## Proof-of-effect contract

`ctx.hardVerifier.verify` runs a finding's proof of concept through the configured shell, `runs` times. A run satisfies the contract only when it exits zero and prints `HARD-PASS <sha256 of claim>` on stdout; all runs passing confirms, all failing refutes, any split is flaky. The claimed CVSS 4.0 score is recomputed from the vector against the vendored FIRST reference data, and a confirmed root cause rejects duplicate proposals.

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
 * @param request - the validated finding fields; id assigned from the projection.
 * @returns the assigned finding id.
 */
proposeFinding(agent: Agent, request: Omit<HardFindingProposedData, 'id'>): HardFindingId

/**
 * Append the verifier's executed outcome for one proposed finding.
 * @param agent - the live agent whose session receives the record.
 * @param data - the verdict payload to persist.
 */
recordVerdict(agent: Agent, data: HardFindingVerdictData): void

/**
 * Propose a new hypothesis or transition an existing one through its lifecycle.
 * @param agent - the live agent whose session receives the record.
 * @param request - statement, status, optional existing id, and conditional reason.
 * @returns the assigned or confirmed hypothesis id.
 */
writeHypothesis( agent: Agent, request: { id?: string; statement: string; status: HardHypothesisStatus; reason?: string }, ): HardHypothesisId

/**
 * Append one coverage cell verdict, replacing any prior verdict for the cell.
 * @param agent - the live agent whose session receives the record.
 * @param request - the cell coordinates, verdict, and declared sink sites.
 */
markCoverage(agent: Agent, request: HardCoverageCellData): void

/**
 * Append one completed sweep summary.
 * @param agent - the live agent whose session receives the record.
 * @param request - the sweep phase, counters, and conditional empty proof.
 */
recordSweep(agent: Agent, request: HardSweepSummaryData): void

/**
 * Findings folded from the projection, proposal plus latest verdict when present.
 * @param agent - the live agent whose ledger state is read.
 * @returns one record per proposal in id order.
 */
findings(agent: Agent): readonly HardLedgerFindingEntry[]

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
 * its verdict lookup deliberately ignores the recorded cell's module.
 * @param agent - the live agent whose ledger state is read.
 * @returns the verdicted count and the matrix cell total, `0/0` without a matrix.
 */
coverageProgress(agent: Agent): { verdicted: number; total: number }

/**
 * Matrix cells that still need the model, in matrix order: sorted modules
 * outer, the configured class order inner, then repository-scoped cells
 * under the `.` module. Inert modules carry no module-class surface and are
 * never listed; a repository-scoped class is listed once, not per module.
 * @param agent - the live agent whose ledger state is read.
 * @returns one entry per uncovered matrix cell, empty without a matrix.
 */
uncoveredCells(agent: Agent): readonly { module: string; bugClass: string }[]

/**
 * Verdicted matrix cells partitioned by who decided them: the model's own
 * reads, batch clears the harness grep confirmed, and the purely mechanical
 * inert-module screen. A cell carrying no source reads as `model`, so older
 * logs partition unchanged.
 * @param agent - the live agent whose ledger state is read.
 * @returns the three counts; all zero without a matrix.
 */
coverageBySource(agent: Agent): { model: number; modelVerified: number; harness: number }

/**
 * Model-facing open work summary: pending verifications, unresolved
 * states, coverage cells that still owe work, and batch-cleared cells the
 * deterministic screen spot-check sends back for a manual re-read.
 * @param agent - the live agent whose ledger state is read.
 * @returns bounded human-readable work items, empty when nothing is open.
 */
openWork(agent: Agent): string[]
```

Types: [Agent](core.md)

Source: [`packages/experimental/hard-ledger/src/index.ts`](../../packages/experimental/hard-ledger/src/index.ts)

<a id="ctxhardverifier--hardverifier"></a>

### `ctx.hardVerifier` — `HardVerifier`

The hard-harness verifier on the `hardVerifier` key: rejects duplicates, executes proofs of effect through the shell seam, recomputes CVSS 4.0 scores against the claimed ones, and records the durable verdict.

```ts cordis-catalog
/**
 * Verify one proposed finding: reject duplicates, recompute CVSS, execute
 * the configured number of PoC runs through the shell seam, classify, and
 * append the durable verdict.
 * @param agent - the live agent whose ledger receives the verdict.
 * @param proposed - the proposal record to verify.
 * @returns the appended verdict record.
 */
async verify(agent: Agent, proposed: HardFindingProposedData): Promise<HardFindingVerdictData>

/**
 * Deterministic cross-check of one `cleared` coverage cell: re-grep the
 * module against the bug class's fixed sink patterns and reopen the cell
 * as `suspicious` when undeclared sink sites surface. The grep runs from
 * the pinned target repository the armed coverage matrix records, so the
 * module path is always target-repo relative. Sampling follows the
 * configured spot-check percent by cell hash; an unsampled cell, a
 * non-cleared cell, a class without patterns, a missing matrix, or a grep
 * with no undeclared matches returns `undefined` and changes nothing. The
 * check fails closed: a grep that errors, times out, or is aborted never
 * reads as a clean cell.
 * @param agent - the live agent whose ledger matrix anchors the grep.
 * @param cell - the coverage cell the model just marked `cleared`.
 * @returns the reopening record to persist through the ledger, or `undefined` when the check passes or does not apply.
 * @throws `HARD_VERIFIER_AUDIT_FAILED` when the cross-check grep errors, times
 *   out, or is aborted — an unevaluated grep is not evidence of absence.
 */
async auditCoverage(agent: Agent, cell: CoverageAuditCell): Promise<CoverageReopenRecord | undefined>

/**
 * Mechanical absence screen behind the batch clear: grep the requested
 * modules for the union of the model's patterns and the class's fixed sink
 * patterns, anchored at the pinned target repository. The union means the
 * model's patterns can only ADD coverage, never subtract — a narrow
 * pattern choice cannot sneak past the harness table. An empty grep on
 * every module proves the absence predicate; any match fails the whole
 * batch and returns the matching lines as evidence for a manual read.
 * Absence-shaped classes are refused: for their protective sinks, an empty
 * grep is suspicious, not clean.
 * @param agent - the live agent whose ledger matrix anchors the grep.
 * @param bugClass - the bug class to prove absent.
 * @param modules - the target-repo-relative modules to grep.
 * @param patterns - the model's own extended-regex absence patterns.
 * @returns `clean: true` when every grep came back empty, else `clean: false` with the bounded matching lines.
 * @throws when the class is absence-shaped or has no sink patterns, the grep errors, or no matrix is armed.
 */
async screenModules( agent: Agent, bugClass: string, modules: readonly string[], patterns: readonly string[], ): Promise<{ clean: boolean; evidence: readonly string[] }>
```

Types: [Agent](core.md)

Source: [`packages/experimental/hard-verifier/src/index.ts`](../../packages/experimental/hard-verifier/src/index.ts)
<!-- END GENERATED cordis-surface -->
