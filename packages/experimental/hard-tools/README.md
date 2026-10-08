---
description: "The hard-tools plugin exposing the model-facing finding, hypothesis, coverage, and sweep tools of the hard harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-tools

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-tools` registers the seven model-facing tools of the hard harness: `hard_submit_finding` returns the verifier's executed verdict on a claim; `hard_update_hypothesis` drives the hypothesis lifecycle; `hard_record_flow` records a module's flow document behind citation resolution at the pinned commit; `hard_mark_coverage` records one coverage cell; `hard_clear_modules` batch-screens one class behind a grep that can only refuse; `hard_sweep_summary` records a pass, citing evidence when it found nothing; `hard_status` reads the board and the remaining work back. The ledger checks every proof at record time.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the hard ledger and verifier.

```yaml
- id: hard-tools
  name: '@deepseek-ai/dsh-experimental-hard-tools'
```

All seven tools require a live agent and return compact JSON. Submit results carry `verdict.verdict`, the run count, the recomputed score, whether the claimed score matched, and a bounded reason; rejections surface stable codes such as `HARD_VERIFIER_DUPLICATE`, and a submission refused for a duplicate root cause or an unparsable vector records no proposal. The generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-hard-tools) is the exact schemas the model receives.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Verification at submission.** `hard_submit_finding` hashes the claim (the marker the PoC must print) and the root cause (the dedup key), proposes through the ledger, then awaits `hardVerifier.verify` before answering; the model sees the executed outcome, not an assumption. The tool description teaches the specificity contract: read the payload from `$1`, never hardcode it, because the harness re-runs the PoC with a benign payload and requires it to fail.
- **Lifecycle in the ledger.** Hypothesis transitions, coverage cells, and sweeps are ledger appends with fail-loud validation; the tools add only the hypothesis-membership check for `hypothesis_id`. A `cleared` verdict must cite the inspected code as `path:symbol`, `path:line`, or `path:start-end`; `hard_mark_coverage` resolves every site at the pinned commit before recording and refuses the clear naming each site that is not there. It also refuses a module that is not a row of the armed matrix, naming the valid rows, and refuses a `cleared` verdict on an inert module the screen already decided (`suspicious` still records); a harness reopen or fail-closed audit attributes its cell with `source: 'harness'`, so reports never read the model's own `suspicious` call as gaming. `hard_clear_modules` refuses the whole batch up front when any module is off-matrix, inert, or unscreened — a module holding a binary or a language the fixed pattern tables were not written for, where the grep proves nothing — before any grep runs.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the four tool registrations, schemas, and result rendering |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas and results

#### What the model sees

The generated [`hard_submit_finding`, `hard_update_hypothesis`, `hard_record_flow`, `hard_mark_coverage`, `hard_clear_modules`, `hard_sweep_summary`, and `hard_status` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-hard-tools). Successful results are compact JSON: the finding's id, claim hash, and fingerprint plus the executed verdict, the new or transitioned hypothesis id and status, the recorded flow document (or the rejected citations naming every failed cite), the recorded coverage cell, the batch clear's cleared-cell list (or the grep evidence that blocked it), the recorded sweep summary, or a status view: per-kind open-work counts, the gate, and the matrix axes — counts, never a ratio, so no progress number invites clearing for its own sake — a page of board cells with the total that matched, or a page of the open-work list.

#### Token effect

Fixed schema cost plus one compact result per call; submit results and full `hard_status` pages are the largest, and a status page is held at 200 entries.

#### KV Cache effect

Schemas are prefix-stable while their definitions and visibility are unchanged. Calls and results append after the reusable request prefix without invalidating earlier entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No prompt sections** — methodology guidance lives in the mission contract; a scope hiding the tools keeps whatever sections the deployment mounts.
- **No authority model yet** — any live agent (including a subagent) may call the tools; per-scope authority lands with the hard composition work.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
