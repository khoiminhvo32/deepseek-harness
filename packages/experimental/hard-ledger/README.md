---
description: "The hard-ledger plugin for hard-harness deployments recording findings, hypotheses, coverage, and sweep state as durable session events."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-ledger

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-ledger` owns the durable methodology state of the hard harness: additive `hard/*` session events (finding proposals and verifier verdicts, hypothesis lifecycle, coverage cells, sweep summaries, and the mission arming record) plus the `ctx.hardLedger` service that validates, appends, and folds them. The session log is the only store; ids are assigned from the log and every fold derives from it.

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
- **Sequential ids from the log.** `F-<n>` and `H-<n>` counters count prior events of their type; hypothesis transitions verify membership against ids already present in the log.
- **Additive events, no format bump.** The events are purely additive roots: no surface, envelope, or header change and no existing event changes shape, so vocabulary growth needs no format bump. Older builds refuse such logs instead of misreading them, the required-on-read contract for in-repo events.
- **Bounded text.** Free-text fields cap at 2000 characters; reason fields for `refuted` and `deferred` hypotheses and `emptyProof` for zero-finding sweeps are mandatory.
- **Coverage denominator from the arming record.** The mission plugin appends one `hard/mission/armed` event carrying the pinned target repository, the resolved commit sha, the sorted module rows, and the bug-class columns. The fold stores it as the matrix; `coverageProgress` counts verdicts over `modules × bugClasses`, `uncoveredCells` lists the cells that still owe work in deterministic order, and `openWork` names both uncovered and suspicious cells so the stop gate and the round context see the remaining sweep. Cells outside the matrix never count, and a log without an arming record keeps the legacy shape: empty results, no throw.

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
