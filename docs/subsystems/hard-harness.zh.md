# Hard harness

[English](hard-harness.md) | 中文

Experimental hard-harness services keep one long-running objective alive in a session. The [mission plugin](../../packages/experimental/hard-mission/README.zh.md) arms the configured objective as a durable goal, the [ledger](../../packages/experimental/hard-ledger/README.zh.md) owns findings, hypotheses, coverage, and sweep state over additive `hard/*` session events, the [verifier](../../packages/experimental/hard-verifier/README.zh.md) executes findings' proofs of effect through the shell seam — benign arm first, exploit arm second, so the proof must depend on the payload — and recomputes their CVSS 4.0 scores, the [tools](../../packages/experimental/hard-tools/README.zh.md) are the model-facing surface, the [stop gate](../../packages/experimental/hard-stopgate/README.zh.md) steers the turn boundary back to work while an armed goal stands and owns completion: it runs the ledger's completion assessment on every `update_goal action complete` attempt, denies early attempts with the exact remaining work, and records each decision as a `hard/gate/decision` event, the [standby](../../packages/experimental/hard-standby/README.zh.md) waits out terminal quota failures and wakes the mission at the reset time, the [handoff](../../packages/experimental/hard-handoff/README.zh.md) injects the durable ledger summary after each successful compaction, the [round driver](../../packages/experimental/hard-rounds/README.zh.md) accounts for admitted goal rounds over the shipped goal-round driver and enforces the per-round step budget, and the [deep-read template](../../packages/experimental/hard-deepread/README.zh.md) owns the Phase B flow-document contract. The verifier coverage cross-check re-greps sampled `cleared` cells against each bug class fixed sink patterns and reopens a cell whose module still matches an undeclared sink.

## Running the profile

The shipped `hard` profile stacks `dsh-base`, `dsh-headless`, and this bundle: `dsh --profile hard "<objective>"` arms the objective as the mission and keeps the session working until the goal completes. Supply the objective and the target repository through a profile patch overriding the `hard-mission` row's `objective` and `target.repoPath` (the bundle ships blanks and fails the load until real values are set). The verifier's coverage cross-check samples `cleared` cells per `coverageSpotCheckPercent` and reopens under-declared cells as `suspicious`; a cross-check grep that errors marks the cell `suspicious` and fails the tool call instead of passing it.

## Ledger state

The ledger is log-derived: `ctx.hardLedger` appends validated `hard/*` events and reads the `hardLedger` session projection, a pure fold the framework restores at resume and advances on every commit. Finding ids (`F-n`) and hypothesis ids (`H-n`) are assigned from the projected counts. The verifier records exactly one verdict per proposal; a split verdict is flaky and never counts as progress.

覆盖矩阵来自 mission 的武装记录：加载时 mission 插件固定已配置的目标仓库（把 `target.commit` 解析为完整 sha），并用 `git ls-files` 枚举已跟踪模块，因此分母天然尊重 `.gitignore`，同一提交上逐字节复现。矩阵承载于一条增量 `hard/mission/armed` 事件。三层经济学让分母在真实仓库上可达：`CLASS_SCOPE` 给 `dependencies` 与 `misconfig` 各一个仓库级单元而非每模块一个；所有已跟踪文件都非可执行的模块（`inertModules`）由 harness 直接预判定，无需模型事件；`hard_clear_modules` 在 harness grep（模型 pattern 与固定表取并集）背后跨模块批量清除一个类别，记录 `source: model-verified`，而模型自己的标记不带归因（读作 `model`）。`coverageProgress` 按范围化总数统计判定，`uncoveredCells` 只列出仍需要模型的单元，`coverageBySource` 按决定方拆分判定，`openWork` 把按哈希抽样的批量清除单元送回人工重读，使筛查的假阴性率始终被测量。

## Proof-of-effect contract

`ctx.hardVerifier.verify` runs a finding's proof of concept through the configured shell, `runs` times. A run satisfies the contract only when it exits zero and prints `HARD-PASS <sha256 of claim>` on stdout; all runs passing confirms, all failing refutes, any split is flaky. The claimed CVSS 4.0 score is recomputed from the vector against the vendored FIRST reference data, and a confirmed root cause rejects duplicate proposals. Every refuted verdict carries an aggregable `cause` (`benign-arm-passed`, `no-marker`, `nonzero-exit`, `timeout`, `aborted`, `no-runs`), and `ctx.hardLedger.refutationBreakdown` groups them into protocol failures, genuine refutations, and infrastructure; the optional `evidence` field reserves `proven` for a future differential runner, and every confirmed verdict carries `demonstrated` — everything the verifier produces today is a model-written PoC through the specificity check — while confirms recorded before the specificity check lack the field and read as weaker.

## Step budgets

The two step limits measure different things. `hard-rounds`' `stepsPerRound` is a round's steering budget, checked in `agent/turn-stopping` — a hook that only fires when the model wants to stop — so it bounds how far the driver can push a round, never cost. `maxStepsPerTurn` is the cost cap, checked at the `agent/pre-step` boundary of every turn, whether or not a round owns it; reaching it rejects the step, the turn closes `blocked`, and the stop is recorded as a durable `hard/step-cap/reached` event naming the turn, the steps that had run, the limit, and the round when one owns the turn.

## Design rationale

The hard-harness design record (.agents/plans/2026-10-04-hard-harness-design.md) owns the verification-driven contract and the two-pass methodology. The standby keeps the session alive through provider quota windows: it schedules a bounded wait on a terminal `QUOTA` failure, folds it through the `hardStandby` projection, and at the wake resumes an active disarmed goal and delivers a continuation follow-up, never reviving paused or capped work. The handoff bridges compaction: after each successful `compaction/end` it injects one deterministic summary of findings, hypotheses, coverage, and open work, assembled only from ledger folds.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * Append one completed sweep summary. An empty sweep must cite verifiable
 * evidence the ledger can check — a refuted hypothesis, or a model-cleared
 * cell with declared sinks; a harness-screened cell cannot prove a sweep
 * did work. A sweep with findings carries no proof. The legacy free-text
 * `emptyProof` is only read from older logs; new records always use
 * `emptyProofRef`.
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
 * Decompose the refuted verdicts by cause code, so one run can say whether
 * it failed at the protocol layer or the target layer.
 * @param agent - the live agent whose ledger holds the findings.
 * @returns refuted-verdict counts per cause plus the reading groups; a
 *   refuted verdict predating the cause codes counts under `unattributed`
 *   in `byCause` and in no group.
 */
refutationBreakdown(agent: Agent): { readonly byCause: Readonly<Record<string, number>> /** `benign-arm-passed` plus `no-marker`: the model has not internalized the proof contract. */ readonly protocolFailures: number /** `nonzero-exit`: the exploit did not happen — a clean target produces these too. */ readonly genuineRefutations: number /** `timeout` plus `aborted` plus `no-runs`: infrastructure, no conclusion available. */ readonly infrastructure: number }

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
 * whole predicate here.
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
 * audited yet", not "done".
 * @param agent - the live agent whose ledger state is read.
 * @returns the verdict plus the bounded blockers, phrased to serve directly as the denial reason.
 */
completionAssessment(agent: Agent): { complete: boolean blockers: readonly string[] }

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

Types: [Agent](core.zh.md)

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

Types: [Agent](core.zh.md)

Source: [`packages/experimental/hard-verifier/src/index.ts`](../../packages/experimental/hard-verifier/src/index.ts)
<!-- END GENERATED cordis-surface -->
