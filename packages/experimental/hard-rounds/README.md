---
description: "The hard-rounds plugin for hard-harness deployments recording round accounting, injecting round context, and enforcing the per-round step budget and the per-turn step cap."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-rounds

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-rounds` adds the hard-mission layer on top of the shipped goal-round driver. The driver owns reservation, revision fencing, and the goal-round cap; this plugin records a durable `hard/round/start` with the A/B rotation phase, `chaining: true` when the round runs Phase C instead, and the ledger's open-work count, injects a `<hard_round n/max>` context naming the phase instruction, open work, and — once none stands — the completion gate's remaining blockers, cancels a round turn at the `stepsPerRound` steering budget, stops any turn at the `maxStepsPerTurn` cost cap (`hard/step-cap/reached`), and records `hard/round/end` when the round's turn closes.

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
    maxStepsPerTurn: 200
    deepReadEveryN: 3
    chainEveryN: 5
```

The two step budgets are different limits. `stepsPerRound` is the round's steering budget, checked in `agent/turn-stopping`, which only fires when the model wants to stop — it bounds how far the driver can push a round, never cost. `maxStepsPerTurn` is the cost cap, checked at the `agent/pre-step` boundary of every turn, round or not, so a turn that keeps calling tools without stopping is still stopped; the stop is recorded as `hard/step-cap/reached`. `deepReadEveryN` rotates the methodology pass: one Phase B deep-reading round after every `deepReadEveryN` Phase A rounds. Keep it equal to the mission's `deepReadEveryN`; the two values are separate so the driver can rotate without reading another plugin's config, but divergent values produce divergent cadence. `chainEveryN` schedules the chaining pass: every `chainEveryN`th round is Phase C, ahead of the A/B rotation, once the ledger holds two or more weaknesses or confirmed findings; `0` never schedules it, and unlinked material stays open work either way. The completion gate's remaining blockers once no open work stands come from the hard ledger's `emptySweepsToFinish` config, so the context and the gate can never disagree. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-rounds) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Driver, not fork.** Reservation, revision fencing, round counting, and the blocked-at-cap path are the shipped goal-round driver's; this module only observes the events the driver already produces, so the two never diverge on admission semantics.
- **Deferred appends.** The post-commit append feed forbids reentrant appends, so the round start record and its context injection settle one microtask after the admitted message commits.
- **Deterministic rotation.** Phase C falls on rounds divisible by `chainEveryN` while the ledger holds at least two weaknesses or confirmed findings; otherwise Phase B falls on rounds divisible by `deepReadEveryN + 1`. Both are computed from the admitted round number and the ledger state at admission, and the start record keeps the A/B slot while `chaining: true` marks a Phase C round.
- **Bounded turns.** Step accounting reads `step/start` events of the round's turn; at `stepsPerRound` the turn is cancelled with a `hook` cause and the round end records `step-cap`.
- **Cost cap at the step boundary.** The loop's own 1-based per-turn step position decides `maxStepsPerTurn` — trusting it cannot drift the way a private counter could. Reaching the cap rejects the step, so the turn closes `blocked`, in rounds and roundless turns alike.

### Source map

| File | Role |
|---|---|
| [`src/domain.ts`](src/domain.ts) | `SessionEventMap` merge for the `hard/round/*` events and `hard/step-cap/reached` |
| [`src/index.ts`](src/index.ts) | Plugin: round observation, context injection, step caps |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Injected context

#### What the model sees

One `hard-round`-sourced user message per admitted round: the `<hard_round n/max>` header, the phase's instruction (systematic source-to-sink sweep for Phase A, the deep-reading pass for Phase B, pairing what one weakness grants with what another requires and proving the strongest chain for Phase C), the ledger's bounded open-work list, and the requirement to record progress with the hard tools.

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
