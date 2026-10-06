---
description: "The hard-rounds plugin for hard-harness deployments recording round accounting, injecting round context, and enforcing the per-round step budget."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-rounds

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-rounds` adds the hard-mission layer on top of the shipped goal-round driver. The driver owns reservation, revision fencing, and the goal-round cap; this plugin observes each admitted goal round and records a durable `hard/round/start` with the A/B rotation phase and the ledger's open-work count, injects a `<hard_round n/max>` context naming the phase instruction, the open work, and — once no open work stands — the completion gate's remaining blockers, cancels a turn at the `stepsPerRound` budget, and records `hard/round/end` when the round's turn closes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the goal service, the hard ledger, and `@deepseek-ai/dsh-goal-round-driver`; without the driver there are no admitted goal rounds and this plugin stays dormant.

```yaml
- id: goal-round-driver
  name: '@deepseek-ai/dsh-goal-round-driver'

- id: hard-rounds
  name: '@deepseek-ai/dsh-experimental-hard-rounds'
  config:
    stepsPerRound: 200
    deepReadEveryN: 3
```

`deepReadEveryN` rotates the methodology pass: one Phase B deep-reading round after every `deepReadEveryN` Phase A rounds. Keep it equal to the mission's `deepReadEveryN`; the two values are separate so the driver can rotate without reading another plugin's config, but divergent values produce divergent cadence. The completion gate's remaining blockers once no open work stands come from the hard ledger's `emptySweepsToFinish` config, so the context and the gate can never disagree. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-rounds) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Driver, not fork.** Reservation, revision fencing, round counting, and the blocked-at-cap path are the shipped goal-round driver's; this module only observes the events the driver already produces, so the two never diverge on admission semantics.
- **Deferred appends.** The post-commit append feed forbids reentrant appends, so the round start record and its context injection settle one microtask after the admitted message commits.
- **Deterministic rotation.** Phase B falls on rounds divisible by `deepReadEveryN + 1`, computed from the admitted round number alone.
- **Bounded turns.** Step accounting reads `step/start` events of the round's turn; at `stepsPerRound` the turn is cancelled with a `hook` cause and the round end records `step-cap`.

### Source map

| File | Role |
|---|---|
| [`src/domain.ts`](src/domain.ts) | `SessionEventMap` merge for the two `hard/round/*` events |
| [`src/index.ts`](src/index.ts) | Plugin: round observation, context injection, step cap |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Injected context

#### What the model sees

One `hard-round`-sourced user message per admitted round: the `<hard_round n/max>` header, the phase's instruction (systematic source-to-sink sweep for Phase A, the deep-reading pass for Phase B), the ledger's bounded open-work list, and the requirement to record progress with the hard tools.

#### Token effect

One bounded message per round; no standing prompt cost.

#### KV Cache effect

The injection appends after the reusable request prefix without invalidating earlier entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Driver required** — the module observes admitted goal rounds only; mounted alone it records nothing, by design rather than by omission.
- **One round per session** — rounds are sequential; a second admitted round while one is open is ignored until the first closes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
