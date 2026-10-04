---
description: "The hard-stopgate plugin for deployments that must keep an armed goal's session working instead of stopping at the first turn boundary."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-stopgate

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-stopgate` listens on the `agent/turn-stopping` boundary and steers a continuation order whenever a turn tries to close while an armed, active goal still stands. Goalless, disarmed, paused, blocked, and completed agents close freely, and a per-turn budget bounds the forced continuations so a model that cannot advance the goal cannot hold the turn open forever.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the goal service when turns under a mission goal must continue until the goal is genuinely complete, such as in the hard-bundle composition. It reads goal state through `ctx.goals` and steers through the agent payload; it registers no tools and no prompt sections.

```yaml
- id: hard-stopgate
  name: '@deepseek-ai/dsh-experimental-hard-stopgate'
  config:
    maxSteersPerTurn: 16
```

`maxSteersPerTurn` must be a positive safe integer. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-stopgate) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Steering is the block.** A serial `agent/turn-stopping` listener reads the current goal; an armed, active goal makes the gate call `agent.steer(...)` with a continuation order, which makes the loop observe pending input and run another step. Returning without steering is what allows closure — there is no separate veto.
- **Bounded runaway.** The gate counts forced continuations per agent and resets the count when the turn number advances. Once the budget is spent the turn closes; a goal-round driver or the user opens the next turn. Counters are dropped on plugin disposal and on `agent/disposed`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, the owing-goal decision, the continuation order, and the turn-stopping listener |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Steering messages

#### What the model sees

One steering message per forced continuation, sent at the stopping boundary. The objective and the round numbers are interpolated from the current goal; the rendered example uses the objective `find the deserialization bug`, round 0, and a cap of 9.

##### Continuation order

```markdown
The session objective is not complete: "find the deserialization bug". Goal round 0 of 9. Do not stop or summarize; take the next concrete action that advances the objective now. End the turn only after marking the goal complete with update_goal action complete once the objective is genuinely achieved.
```

#### Token effect

One short message per forced continuation, only in turns that attempt to close under an armed active goal.

#### KV Cache effect

Appends after the reusable request prefix without invalidating earlier entries; the budget bounds the appended volume per turn.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Steering is advisory pressure** — the loop re-reads the inbox, so a model that cannot advance burns the budget and the turn closes; the gate cannot force the boundary to stay open.
- **Goal state only** — the gate does not yet read a findings ledger, so unverified work inside an active goal does not block closure; open-work awareness joins with the hard verifier.
- **Completion path assumes the goal tools** — the order names `update_goal action complete`; a composition without `dsh-tool-goal` must surface that action through another consumer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
