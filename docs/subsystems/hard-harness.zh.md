# Hard harness

[English](hard-harness.md) | 中文

Experimental hard-harness services keep one long-running objective alive in a session. The [mission plugin](../../packages/experimental/hard-mission/README.zh.md) arms the configured objective as a durable goal, the [ledger](../../packages/experimental/hard-ledger/README.zh.md) owns findings, hypotheses, coverage, and sweep state over additive `hard/*` session events, the [verifier](../../packages/experimental/hard-verifier/README.zh.md) executes findings' proofs of effect through the shell seam and recomputes their CVSS 4.0 scores, the [tools](../../packages/experimental/hard-tools/README.zh.md) are the model-facing surface, and the [stop gate](../../packages/experimental/hard-stopgate/README.zh.md) steers the turn boundary back to work while an armed goal stands.

## Ledger state

The ledger is log-derived: `ctx.hardLedger` appends validated `hard/*` events and reads the `hardLedger` session projection, a pure fold the framework restores at resume and advances on every commit. Finding ids (`F-n`) and hypothesis ids (`H-n`) are assigned from the projected counts. The verifier records exactly one verdict per proposal; a split verdict is flaky and never counts as progress.

## Proof-of-effect contract

`ctx.hardVerifier.verify` runs a finding's proof of concept through the configured shell, `runs` times. A run satisfies the contract only when it exits zero and prints `HARD-PASS <sha256 of claim>` on stdout; all runs passing confirms, all failing refutes, any split is flaky. The claimed CVSS 4.0 score is recomputed from the vector against the vendored FIRST reference data, and a confirmed root cause rejects duplicate proposals.

## Design rationale

The hard-harness design record (.agents/plans/2026-10-04-hard-harness-design.md) owns the verification-driven contract, the two-pass methodology, and the quota-standby and compaction-handoff plans that remain deferred.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxhardledger--hardledger"></a>

### `ctx.hardLedger` — `HardLedger`

The hard-harness ledger: validates and appends `hard/*` events, and serves findings, hypotheses, coverage, and open-work state from the projection.

```ts cordis-catalog
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
 * Model-facing open work summary: pending verifications and unresolved states.
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
 * Verify one proposed finding: reject duplicates, recompute CVSS, execute
 * the configured number of PoC runs through the shell seam, classify, and
 * append the durable verdict.
 * @param agent - the live agent whose ledger receives the verdict.
 * @param proposed - the proposal record to verify.
 * @returns the appended verdict record.
 */
async verify(agent: Agent, proposed: HardFindingProposedData): Promise<HardFindingVerdictData>
```

Types: [Agent](core.zh.md)

Source: [`packages/experimental/hard-verifier/src/index.ts`](../../packages/experimental/hard-verifier/src/index.ts)
<!-- END GENERATED cordis-surface -->
