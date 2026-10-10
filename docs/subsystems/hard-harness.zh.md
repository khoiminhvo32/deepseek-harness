# Hard harness

[English](hard-harness.md) | 中文

Experimental hard-harness services keep one long-running objective alive in a session. The [mission plugin](../../packages/experimental/hard-mission/README.zh.md) arms the configured objective as a durable goal, the [ledger](../../packages/experimental/hard-ledger/README.zh.md) owns findings, hypotheses, coverage, and sweep state over additive `hard/*` session events, the [verifier](../../packages/experimental/hard-verifier/README.zh.md) executes findings' proofs of effect through the shell seam — benign arm first, exploit arm second, so the proof must depend on the payload — and recomputes their CVSS 4.0 scores, the [tools](../../packages/experimental/hard-tools/README.zh.md) are the model-facing surface, the [stop gate](../../packages/experimental/hard-stopgate/README.zh.md) steers the turn boundary back to work while an armed goal stands and owns completion: it runs the ledger's completion assessment on every `update_goal action complete` attempt, denies early attempts with the exact remaining work, and records each decision as a `hard/gate/decision` event, the [standby](../../packages/experimental/hard-standby/README.zh.md) waits out terminal quota failures and wakes the mission at the reset time, the [handoff](../../packages/experimental/hard-handoff/README.zh.md) injects the durable ledger summary after each successful compaction, the [round driver](../../packages/experimental/hard-rounds/README.zh.md) accounts for admitted goal rounds over the shipped goal-round driver and enforces the per-round step budget, the [deep-read template](../../packages/experimental/hard-deepread/README.zh.md) owns the Phase B flow-document contract, and the opt-in [independent audit](../../packages/experimental/hard-audit/README.zh.md) has a fresh, blind reader re-read a sample of cleared cells in shadow mode. The verifier coverage cross-check re-greps sampled `cleared` cells — sink classes against the fixed sink patterns, and the guarded-surface classes `authz`/`authn-bypass` against the exported operations, reopening a cell whose module still matches an undeclared sink or exports an operation no declaration mentions — and the verifier resolves every `hard_record_flow` citation against the pinned commit before a `hard/flow/doc` summary is recorded.

## Running the bundle

The hard bundle is an installation-owned optional bundle: switch it on for a profile in the plugin manager (`dsh plugin --profile <name>`), and it stacks over whatever composition that profile selects — the headless composition for CLI sessions, the Web composition for GUI sessions with the coverage panel. Supply the objective and the target repository through a profile patch overriding the `hard-mission` row's `objective` and `target.repoPath` (the bundle ships blanks and fails the load until real values are set). The verifier's coverage cross-check samples `cleared` cells per `coverageSpotCheckPercent` and reopens under-declared cells as `suspicious`; a cross-check grep that errors marks the cell `suspicious` and fails the tool call instead of passing it.

## Ledger state

The ledger is log-derived: `ctx.hardLedger` appends validated `hard/*` events and reads the `hardLedger` session projection, a pure fold the framework restores at resume and advances on every commit. Finding ids (`F-n`), hypothesis ids (`H-n`), and weakness ids (`W-n`) are assigned from the projected counts. The verifier records exactly one verdict per proposal; a split verdict is flaky and never counts as progress. Weaknesses are kept as chaining material whatever their standalone impact; once two or more weaknesses or confirmed findings exist, each must appear in the links of a chain hypothesis before the gate certifies completion, and the round driver schedules a chaining round (Phase C) every `chainEveryN` rounds.

覆盖矩阵来自 mission 的武装记录：加载时 mission 插件把已配置的目标——git 仓库、普通目录或单个文件——捕获进 harness 在目标之外拥有的 git 存储，并枚举该快照提交中的每个文件，因此分母在相同内容上逐字节复现。快照保存的是武装时模型所看到的内容，包括未提交的改动；模型之后写入的文件都在快照之外，引用与独立读者都按快照解析。默认不排除任何内容；已配置的排除会记录在武装记录中，并在覆盖率旁报告。矩阵承载于一条增量 `hard/mission/armed` 事件。三层经济学让分母在真实仓库上可达：`CLASS_SCOPE` 给 `dependencies` 与 `misconfig` 各一个仓库级单元而非每模块一个；所有已跟踪文件都非可执行的模块（`inertModules`）由 harness 直接预判定，无需模型事件；`hard_clear_modules` 在 harness grep（模型 pattern 与固定表取并集）背后跨模块批量筛查一个类别，记录 `source: model-verified`——最弱的模型级别，从不满足完成评估的审计下限——而模型自己的标记不带归因（读作 `model`）。grep 只能指控：含二进制或固定表并非为其语言编写的模块被记录为不可筛查，在那里批量筛查会被拒绝，模型清除计为盲清除。`coverageProgress` 按范围化总数统计判定，`uncoveredCells` 只列出仍需要模型的单元，`coverageBySource` 按决定方拆分判定，`openWork` 把按哈希抽样的批量清除单元送回人工重读，使筛查的假阴性率始终被测量。

## Proof-of-effect contract

`ctx.hardVerifier.verify` runs a finding's proof of concept through the configured shell, `runs` times. A run satisfies the contract only when it exits zero and prints `HARD-PASS <sha256 of claim>` on stdout; all runs passing confirms, all failing refutes, any split is flaky. The claimed CVSS 4.0 score is recomputed from the vector against the vendored FIRST reference data, and a confirmed root cause rejects duplicate proposals. Every refuted verdict carries an aggregable `cause` (`benign-arm-passed`, `no-marker`, `nonzero-exit`, `timeout`, `aborted`, `no-runs`), and `ctx.hardLedger.refutationBreakdown` groups them into protocol failures, genuine refutations, and infrastructure; the optional `evidence` field reserves `proven` for a future differential runner, and every confirmed verdict carries `demonstrated` — everything the verifier produces today is a model-written PoC through the specificity check — while confirms recorded before the specificity check lack the field and read as weaker.

## Step budgets

The two step limits measure different things. `hard-rounds`' `stepsPerRound` is a round's steering budget, checked in `agent/turn-stopping` — a hook that only fires when the model wants to stop — so it bounds how far the driver can push a round, never cost. `maxStepsPerTurn` is the cost cap, checked at the `agent/pre-step` boundary of every turn, whether or not a round owns it; reaching it rejects the step, the turn closes `blocked`, and the stop is recorded as a durable `hard/step-cap/reached` event naming the turn, the steps that had run, the limit, and the round when one owns the turn.

## Independent audit

清除没有机器见证，因此审计让另一个模型阅读同一单元，以测量清除出错的频率。任务 agent 清除单元时，`hard-audit` 按层级抽样——不可筛查的模型阅读最多，批量筛查其次，可筛查的逐单元阅读最少，以固定提交为盐——并记录 `hard/audit/requested` 及其所读清除的 seq。被启动的读者得到目标、提交、单元与中立的类别定义，从不得到判定、声明的站点或任何其他台账记录，并可读取整个仓库。读者在快照提交的临时 worktree 中工作，因此任务 agent 之后的修改与 PoC 永远不会到达读者。只有当每个引用站点都在固定提交上解析、单元不含无法阅读的二进制文件、且读者读取的每个路径都位于其 worktree 之内时，其报告才计入；否则 `hard/audit/result` 记录带原因的 `unavailable`。审计以影子模式运行：它记录的任何内容都不会到达任务 agent、其未完成工作或完成门。

## Design rationale

The hard-harness design record (.agents/plans/2026-10-04-hard-harness-design.md) owns the verification-driven contract and the two-pass methodology. The standby keeps the session alive through provider quota windows: it schedules a bounded wait on a terminal `QUOTA` failure, folds it through the `hardStandby` projection, and at the wake resumes an active disarmed goal and delivers a continuation follow-up, never reviving paused or capped work. The handoff bridges compaction: after each successful `compaction/end` it injects one deterministic summary of findings, hypotheses, coverage, and open work, assembled only from ledger folds.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxhardcpg--hardcpg"></a>

### `ctx.hardCpg` — `HardCpg`

The Joern facts service on the `hardCpg` key. Builds run through the shell seam, write only beside the snapshot store, and are shared: concurrent requests for the same commit and query wait for one build.

```ts cordis-catalog
/**
 * The facts of the agent's pinned commit, built on first request and
 * reused from the cache afterwards.
 * @param agent - an agent whose session armed a hard mission.
 * @returns the validated fact file and its counts.
 * @throws HarnessError `HARD_CPG_DISABLED`, `HARD_CPG_NOT_ARMED`, `HARD_CPG_NO_SNAPSHOT`, `HARD_CPG_FAILED`, or `HARD_CPG_FACTS_INVALID`.
 */
async facts(agent: Agent): Promise<HardCpgFacts>
```

Types: [Agent](core.zh.md)

Source: [`packages/experimental/hard-cpg/src/index.ts`](../../packages/experimental/hard-cpg/src/index.ts)

<a id="ctxhardfeaturemap--hardfeaturemap"></a>

### `ctx.hardFeatureMap` — `HardFeatureMap`

The feature map service on the `hardFeatureMap` key. Imports are shared: concurrent requests for one project, commit, and derivation wait for one import, and an earlier import of the same derivation is reused.

```ts cordis-catalog
/**
 * Import the facts of the agent's pinned commit, or reuse an earlier import.
 * @param agent - an agent whose session armed a hard mission.
 * @returns the imported snapshot.
 * @throws HarnessError `HARD_FEATUREMAP_DISABLED`, `HARD_FEATUREMAP_NOT_ARMED`, or any `hardCpg.facts` error.
 */
async index(agent: Agent): Promise<HardFeatureMapSnapshot>

/**
 * Every edge into a symbol of one snapshot.
 * @param snapshot - snapshot id from {@link index}.
 * @param symbol - callee symbol id.
 * @returns the edges, each with the rule that made it.
 */
async callers(snapshot: number, symbol: string): Promise<HardEdgeRow[]>

/**
 * Every edge out of a symbol of one snapshot.
 * @param snapshot - snapshot id from {@link index}.
 * @param symbol - caller symbol id.
 * @returns the edges, each with the rule that made it.
 */
async callees(snapshot: number, symbol: string): Promise<HardEdgeRow[]>

/**
 * The entry points of one snapshot.
 * @param snapshot - snapshot id from {@link index}.
 * @returns the entry points.
 */
async entryPoints(snapshot: number): Promise<HardEntryPoint[]>
```

Types: [Agent](core.zh.md)

Source: [`packages/experimental/hard-featuremap/src/index.ts`](../../packages/experimental/hard-featuremap/src/index.ts)

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
 *   statement), optional existing id, conditional reason, and the chain links
 *   (omittable for an existing id, which keeps its links).
 * @returns the assigned or confirmed hypothesis id.
 */
writeHypothesis( agent: Agent, request: { id?: string; statement?: string; status: HardHypothesisStatus; reason?: string; links?: readonly string[] }, ): HardHypothesisId

/**
 * Append one weakness as chaining material and return its id. The caller
 * resolves every site at the pinned commit before this append.
 * @param agent - the live agent whose session receives the record.
 * @param request - the weakness fields without the assigned id; a named finding or hypothesis id must be recorded.
 * @returns the assigned weakness id.
 */
recordFlaw( agent: Agent, request: Omit<HardFlawData, 'id' | 'findingId' | 'hypothesisId'> & { findingId?: string; hypothesisId?: string }, ): HardFlawId

/**
 * Recorded weaknesses in record order.
 * @param agent - the live agent whose ledger state is read.
 * @returns one record per weakness.
 */
flaws(agent: Agent): readonly HardFlawData[]

/**
 * Record the entry points of the feature map indexed for the pinned
 * commit, unless the session already holds this derivation.
 * @param agent - the live agent whose session receives the record.
 * @param data - the commit, the import derivation, and the entry points.
 * @returns whether a record was appended.
 */
recordFeatureMapIndexed(agent: Agent, data: HardFeatureMapIndexedData): boolean

/**
 * Append one feature the caller already checked against the feature map
 * and return its id; naming an existing id revises that feature.
 * @param agent - the live agent whose session receives the record.
 * @param request - the feature without an id, or with the existing id it revises.
 * @returns the feature id.
 * @throws `HARD_LEDGER_UNKNOWN_FEATURE` for an id never recorded, or a text error for a blank field.
 */
recordFeature(agent: Agent, request: Omit<HardFeatureData, 'id'> & { id?: string }): HardFeatureId

/**
 * Append one relation between two recorded features.
 * @param agent - the live agent whose session receives the record.
 * @param request - the two feature ids, the relation kind, and a note.
 * @throws `HARD_LEDGER_UNKNOWN_FEATURE` for an id never recorded, `HARD_LEDGER_INVALID_FEATURE_LINK` for a self link,
 *   or a text error for a blank note.
 */
linkFeature(agent: Agent, request: { from: string; to: string; kind: HardFeatureLinkData['kind']; note: string }): void

/**
 * The latest record of every feature, in first-record order.
 * @param agent - the live agent whose ledger state is read.
 * @returns one record per feature id.
 */
features(agent: Agent): readonly HardFeatureData[]

/**
 * Feature relations in record order.
 * @param agent - the live agent whose ledger state is read.
 * @returns one record per relation.
 */
featureLinks(agent: Agent): readonly HardFeatureLinkData[]

/**
 * The latest indexed feature map of the session.
 * @param agent - the live agent whose ledger state is read.
 * @returns the indexed entry points, or undefined before any index.
 */
featureMap(agent: Agent): HardFeatureMapIndexedData | undefined

/**
 * Indexed entry points no recorded feature names. The math lives in
 * `unmappedEntryPointsFromState`.
 * @param agent - the live agent whose ledger state is read.
 * @returns the unmapped `kind:key` entry points.
 */
unmappedEntryPoints(agent: Agent): readonly string[]

/**
 * The ids a chain hypothesis may link: every recorded weakness, then every
 * confirmed finding no weakness already names. The math lives in
 * `chainMaterialFromState`.
 * @param agent - the live agent whose ledger state is read.
 * @returns the `W-n` and `F-n` ids in record order.
 */
chainMaterial(agent: Agent): readonly string[]

/**
 * Chain material no hypothesis links yet; empty while fewer than two
 * weaknesses and confirmed findings exist. The math lives in
 * `unchainedMaterialFromState`.
 * @param agent - the live agent whose ledger state is read.
 * @returns the unlinked `W-n` and `F-n` ids.
 */
unchainedMaterial(agent: Agent): readonly string[]

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
 * the reopening evidence is the missed operation names. Both greps read the
 * commit the armed coverage matrix pins, never the working tree, so a file
 * written into the target after the arming cannot reopen a cell, and the
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
 * Count the files one coverage module holds at the pinned commit: every
 * tracked file under its directory, or the files directly at the root for
 * the root module `.`, which does not cover the subdirectories.
 * @param agent - the live agent whose ledger matrix carries the pinned commit.
 * @param module - the target-repo-relative module.
 * @returns the module's file count at the pinned commit.
 * @throws `HARD_VERIFIER_NO_MATRIX` when no coverage matrix is armed.
 * @throws `HARD_VERIFIER_CITATION_FAILED` when the git invocation does not settle cleanly.
 */
async moduleFileCount(agent: Agent, module: string): Promise<number>

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
 * the union of the model's patterns and the class's fixed patterns at the
 * pinned commit, never the working tree; the root module `.` greps only
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

Types: [Agent](core.zh.md)

Source: [`packages/experimental/hard-verifier/src/index.ts`](../../packages/experimental/hard-verifier/src/index.ts)
<!-- END GENERATED cordis-surface -->
