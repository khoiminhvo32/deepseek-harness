---
description: "The hard-tools plugin exposing the model-facing finding, hypothesis, coverage, and sweep tools of the hard harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-tools

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-tools` registers the five model-facing tools of the hard harness: `hard_submit_finding` submits a claim with its CVSS 4.0 vector, the exploit payload the PoC takes as `$1`, and the PoC path, and returns the verifier's executed verdict; `hard_update_hypothesis` drives the hypothesis lifecycle; `hard_mark_coverage` records systematic-pass cells; `hard_clear_modules` batch-clears one class across several modules behind a harness-verified absence grep; `hard_sweep_summary` records completed passes; an empty sweep must cite a verifiable proof reference — a refuted hypothesis or a model-cleared cell — which the ledger checks at record time.

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

All five tools require a live agent and return compact JSON. Submit results carry `verdict.verdict`, the run count, the recomputed score, whether the claimed score matched, and a bounded reason; rejections surface stable codes such as `HARD_VERIFIER_DUPLICATE`. The generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-hard-tools) is the exact schemas the model receives.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Verification at submission.** `hard_submit_finding` hashes the claim (the marker the PoC must print) and the root cause (the dedup key), proposes through the ledger, then awaits `hardVerifier.verify` before answering; the model sees the executed outcome, not an assumption. The tool description teaches the specificity contract: read the payload from `$1`, never hardcode it, because the harness re-runs the PoC with a benign payload and requires it to fail.
- **Lifecycle in the ledger.** Hypothesis transitions, coverage cells, and sweeps are ledger appends with fail-loud validation; the tools add only the hypothesis-membership check for `hypothesis_id`.

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

The generated [`hard_submit_finding`, `hard_update_hypothesis`, `hard_mark_coverage`, `hard_clear_modules`, and `hard_sweep_summary` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-hard-tools). Successful results are compact JSON: the finding's id, claim hash, and fingerprint plus the executed verdict, the new or transitioned hypothesis id and status, the recorded coverage cell, the batch clear's cleared-cell list (or the grep evidence that blocked it), or the recorded sweep summary.

#### Token effect

Fixed schema cost plus one compact result per call; submit results are the largest (finding plus verdict objects).

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
