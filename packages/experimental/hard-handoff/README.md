---
description: "The hard-handoff plugin for hard-harness deployments injecting a durable ledger summary after each successful compaction."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-handoff

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-handoff` bridges compaction and the hard mission. When a successful `compaction/end` lands, the plugin injects one deterministic state summary assembled from the hard ledger folds and the current goal view — findings by verdict, open hypotheses, coverage cell counts, and the open-work list — so the model resumes with durable facts instead of a bare compaction summary. Failed compactions inject nothing.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the hard ledger and goal service in hard-harness compositions; it reads `ctx.hardLedger` and `ctx.goals` and injects into the live agent of the compacted session.

```yaml
- id: hard-handoff
  name: '@deepseek-ai/dsh-experimental-hard-handoff'
  config:
    maxItems: 32
```

`maxItems` bounds the listed open-work items per handoff; beyond the cap the summary states the remaining count instead of the items. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-handoff) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Log-derived only.** The summary reads the ledger projection and the goal service; it never reads files or rescans the log, so the injected text is reconstructable from session events and identical ledger state produces identical text.
- **Successful ends only.** A `compaction/end` carrying an `error` field injects nothing; the injection lands between the compaction marker pair, which the compaction contract explicitly supports.
- **Bounded by construction.** Listed items cap at `maxItems` with a stated remainder, and each item's text bounds at 240 characters, so one long claim cannot dominate the summary.

### Source map

| File | Role |
|---|---|
| [`src/message.ts`](src/message.ts) | Pure deterministic handoff builder |
| [`src/index.ts`](src/index.ts) | Plugin: compaction-end observer and injection |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Injected context

#### What the model sees

One `hard-handoff`-sourced user message after each successful compaction: the mission line (objective, phase, activation, round), counted findings by verdict, open versus resolved hypotheses, coverage cell counts by verdict, the bounded open-work list, and the instruction to continue with the next concrete action.

#### Token effect

One bounded message per compaction; no standing prompt cost.

#### KV Cache effect

The injection appends after the reusable request prefix without invalidating earlier entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Ledger-scoped state only** — the summary carries ledger and goal state; flow docs under `.dsh-hard/` stay file artifacts and are referenced by future rounds, not inlined.
- **Live agent required** — a compaction on a session without a live agent injects nothing; the injection belongs to the next request of a running composition.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
