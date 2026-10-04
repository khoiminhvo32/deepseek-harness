---
description: "The hard-deepread plugin for hard-harness deployments owning the Phase B deep-reading contract: flow documents, subagent fan-out, and hypothesis recording."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-deepread

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-deepread` owns the Phase B contract of the hard mission as the `hard:deep-read` system-prompt section. When a round names phase B, the section directs the model to fan out one subagent per module or module cluster (bounded per pass), demand a structured flow document — entry points, dataflow, trust boundaries, state machines, assumptions, suspicious quirks — save it under `.dsh-hard/flow/<module>.md`, and record every quirk as a ledger hypothesis with a concrete falsification step.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the hard mission and the ledger tools in hard-harness compositions; the section complements the mission contract's rotation rule.

```yaml
- id: hard-deepread
  name: '@deepseek-ai/dsh-experimental-hard-deepread'
  config:
    maxModulesPerPass: 6
```

`maxModulesPerPass` bounds how many modules one deep-reading pass may fan out. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-deepread) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Guidance, not machinery.** The plugin registers one static system-prompt section; the fan-out itself runs through the shipped `subagent` tool and the results land through the hard ledger tools, so no new execution path exists to trust.
- **Structured documents.** The flow-document sections are fixed protocol: entry points, dataflow, trust boundaries, state machines, assumptions, suspicious quirks — the shapes Phase A pattern sweeps cannot produce.
- **Evidence discipline.** Hypotheses move `proposed → testing` with a concrete falsification step; confirmation without executed evidence is out of contract, and a quirk-free pass still records its progress through `hard_sweep_summary` with an `emptyProof`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin: deep-reading contract section and fan-out bound |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

A fixed Phase B contract: read up to `maxModulesPerPass` modules per pass, spawn one subagent per module demanding the six-section flow document, save documents as `.dsh-hard/flow/<module>.md`, record quirks as hypotheses through `hard_update_hypothesis`, convert surviving quirks into findings with real PoCs, and summarize a quirk-free pass with `hard_sweep_summary` phase B plus an `emptyProof`.

##### Deep-read policy

```markdown
Deep-reading pass (Phase B): when a round names phase B, read 6 module or module-cluster at a time for understanding rather than pattern matching. For each module, spawn one subagent whose prompt demands a structured flow document with exactly these sections: entry points; dataflow; trust boundaries; state machines; assumptions; suspicious quirks. Save each document as .dsh-hard/flow/<module>.md and cite it later by path. Record every suspicious quirk as a hypothesis with hard_update_hypothesis: status proposed first, then testing with a concrete falsification step; never mark confirmed without executed evidence. Quirks that survive testing convert into findings submitted with hard_submit_finding and a real PoC. A deep-reading pass with no quirks found still records its progress: summarize the pass with hard_sweep_summary phase B and an emptyProof naming the modules read and the assumptions checked.
```

#### Token effect

Small fixed input cost on every request where this plugin's prompt registration is in scope.

#### KV Cache effect

Prefix-stable while the plugin scope and configured bound are unchanged; activation, disposal, or configuration changes may invalidate reuse from this prompt section.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Subagent quality is model judgment** — the contract names the document sections but cannot enforce their depth; the ledger's hypothesis lifecycle is the enforcement point.
- **Flow docs are file artifacts** — documents live under `.dsh-hard/flow/` and are cited by path; only the ledger records are durable session events.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
