---
description: "The hard-ledger plugin for hard-harness deployments recording findings, hypotheses, coverage, and sweep state as durable session events."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-ledger

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-ledger` owns the durable methodology state of the hard harness: additive `hard/*` session events (finding proposals and verifier verdicts, hypothesis lifecycle including chain links, recorded weaknesses, feature map entry points and features, coverage cells, sweep summaries, and the mission arming record) plus the `ctx.hardLedger` service that validates, appends, and folds them. The session log is the only store; ids are assigned from the log and every fold derives from it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the goal service in hard-harness compositions; the tools and verifier depend on its service and event types.

```yaml
- id: hard-ledger
  name: '@deepseek-ai/dsh-experimental-hard-ledger'
```

The service key is `hardLedger`. Append-side helpers validate fail-loud with stable `HARD_LEDGER_*` codes: blank text, non-CVSS:4.0 vectors, out-of-range scores, malformed hashes, unsinked `cleared` cells, and proof-less empty sweeps are all rejected before an event commits.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Log-derived state.** `findings`, `hypotheses`, `coverage`, `sweepCount`, `coverageMatrix`, and `openWork` read the `hardLedger` session projection, a pure fold over the `hard/*` events that the framework restores at resume and advances incrementally on every commit; there is no parallel store, so the log remains the single source of truth and fork/restart behavior follows the session for free.
- **Client wire view.** The projection definition carries a `wire` view — a strict-schema summary of the armed matrix, the latest per-cell verdicts with their deciders, the coverage aggregates, and the gate assessment, with the service's own thresholds — published to the session store under `hardLedger` for the Web coverage panel. The client-safe vocabulary lives at the `./client` subpath and is types only: nothing there may drag a runtime import into the browser bundle.
- **Sequential ids from the log.** `F-<n>`, `H-<n>`, and `W-<n>` counters count prior events of their type; hypothesis transitions verify membership against ids already present in the log.
- **Weaknesses and chains.** `recordFlaw` appends `hard/flaw/recorded`: a weakness kept as chaining material whatever its standalone impact, naming what it grants an attacker and what it requires. A hypothesis carrying `links` is a chain over two or more distinct recorded weaknesses or confirmed findings; a transition without links keeps the ones it carries. Once two or more weaknesses or confirmed findings exist (a confirmed finding a weakness names counts once, through the weakness), `openWork` lists every one no chain hypothesis links, so the completion gate holds until each was considered — a chain proposed and refuted with its reason counts.
- **Feature map.** `recordFeatureMapIndexed` appends `hard/featuremap/indexed` with the entry points of the feature map indexed for the pinned commit, once per import derivation. `recordFeature` appends `hard/feature/recorded` with a feature the caller already checked against the map, assigning `FE-n` or revising a named existing id; `linkFeature` appends `hard/feature/linked` between two recorded features. While recorded features cover less than `minEntryMappedPercent` of the indexed entry points, `openWork` names the unmapped ones, so the completion gate holds; `unmappedEntryPoints` reads them back.
- **Additive events, no format bump.** The events are purely additive roots: no surface, envelope, or header change and no existing event changes shape, so vocabulary growth needs no format bump. Older builds refuse such logs instead of misreading them, the required-on-read contract for in-repo events.
- **Bounded text.** Free-text fields cap at 2000 characters; reason fields for `refuted` and `deferred` hypotheses are mandatory.
- **Completion assessment and verifiable empty sweeps.** `completionAssessment(agent, emptySweepsToFinish)` certifies completion purely from ledger state — no open work, a trailing run of empty-verified sweeps, and at least one model-audited coverage cell or resolved hypothesis — a batch screen (`model-verified`) never satisfies that floor, because the model read none of those cells; it never counts findings, because a finding quota pressures fabrication. An empty sweep must cite `emptyProofRef` — a hypothesis the ledger has folded to `refuted`, or a cell whose latest verdict is `cleared` with declared sinks and a source other than `harness` (a machine screen cannot prove a sweep did work) — or, for Phase B, `emptyProofFlowDoc`: the module whose recorded `hard/flow/doc` carries at least one resolved citation. The two fields are mutually exclusive. The service also appends `recordFlowDoc` — the durable flow-document summary the verifier records after resolving every citation against the pinned commit — and reads it back through `flowDocs`. The record-time check fails loud with a stable code, so the log only ever holds proofs that were true when recorded. `emptySweepRun` counts the trailing run and `armedGoalId` names the goal the gate keys on.
- **Coverage denominator from the arming record.** The mission plugin appends one `hard/mission/armed` event carrying the pinned target repository, the resolved commit sha, the sorted module rows, the bug-class columns, the inert-module screen, the unscreened modules the coverage cross-check cannot grep meaningfully (any binary, or a language the fixed pattern tables were not written for), and what any configured exclusion removed. Two protocol facts shape the matrix math. `CLASS_SCOPE` marks `dependencies` and `misconfig` as repository-level: each contributes exactly one cell instead of one per module, and unknown classes default to module scope (fail-safe toward more work). An inert module carries no executable file, so its module-class cells count as verdicted with the harness as the deciding source, and `uncoveredCells` never lists them. `markCoverage` refuses a module that is not an armed matrix row — naming the valid rows so the caller can correct its list — and refuses a `cleared` verdict on an inert module, whose cells the screen already decided (`suspicious` still records, so a real sighting surfaces). `assertScreenableModules` refuses a batch screen over an unscreened module, and `blindClears` counts the model clears that stand in unscreened modules with nothing but the model's read behind them; repository-scoped classes never count as blind. Without an arming record, or on one that predates the screenability field, every module passes. `matrixBoard` lists every matrix cell with its current state in matrix order and `openWorkCounts` counts the open work by kind with the same predicates `openWork` lists by — the board and the counts `hard_status` reads back to the model. `coverageProgress`, `coverageBySource`, and `refutationBreakdown` delegate to the pure functions in `src/aggregate.ts`, which the pilot report reads too after folding the log — one implementation of the matrix math, never a report-side re-derivation. Cells outside the matrix never count, and a log without an arming record keeps the legacy shape: empty results, no throw.
- **Verdict attribution.** Every coverage cell may carry `source`: `model` (the model read the code; the historical default when absent), `model-verified` (a batch screen: the model cleared the cells without reading them and a grep found nothing — the weakest model tier, because a silent grep is not proof of absence), or `harness` (the harness decided the verdict — a mechanical screen, a cross-check reopen, or the fail-closed audit). The distinction is an honesty requirement — reports can tell the confidence levels apart, and a model's own `suspicious` call is correct behavior, not gaming — and model-facing tools never set it; only harness callers do.
- **Measured refutations.** Every refuted verdict carries a `cause` code — `benign-arm-passed`, `no-marker`, `nonzero-exit`, `timeout`, `aborted`, or `no-runs` — and `refutationBreakdown` aggregates them into protocol-failure, genuine-refutation, and infrastructure groups, so a run can say whether it failed at the protocol layer or the target layer; verdicts recorded before the codes exist aggregate under `unattributed`. The optional `evidence` field reserves `proven` for a future differential runner; confirmed verdicts carry `demonstrated` — everything the verifier produces today is a model-written PoC through the specificity check — while confirms recorded before the specificity check lack the field and read as weaker.
- **Completion threshold lives here.** `emptySweepsToFinish` (default 2, 0–16; `0` drops the condition) and `minEntryMappedPercent` (default 80, 0–100; `0` drops the condition, and without an indexed feature map nothing is owed) are this service's config, not the stop gate's: `completionAssessment` is a ledger judgment, and every consumer of it — the stop gate's veto, the round context's blockers — injects this service, so they read one config and cannot drift.
- **Screen spot-check.** `screenSpotCheckPercent` (default 5) sends a deterministic hash-sampled share of batch-cleared cells back into `openWork` as `verify the mechanical screen`, so the model re-reads them and the screen's false-negative rate stays measured. Re-marking a cell by hand removes it from the pool; `0` disables the re-read.

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Pure event payload vocabulary |
| [`src/domain.ts`](src/domain.ts) | `SessionEventMap` merge for the `hard/*` events |
| [`src/projection.ts`](src/projection.ts) | Session-projection unit: pure fold, state schema, definition |
| [`src/index.ts`](src/index.ts) | `HardLedger` service: validation, appends, projection reads, open-work summary |

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as ledger events and service folds never enter a model request directly; the hard tools surface selected state through tool results.

#### KV Cache effect

None; the events are durable log records without request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Coverage cross-check deferred** — the service records declared sinks but does not yet re-grep modules against them; the deterministic spot-check lands with the hard coverage auditor.
- **Projection-backed reads** — state comes from the `hardLedger` session projection, restored at resume and advanced on every commit; folds never scan the log.
- **Single-goal semantics** — the ledger assumes one hard mission per session; multi-mission fan-out would need scoping.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
