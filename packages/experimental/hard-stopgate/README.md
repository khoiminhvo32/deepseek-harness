---
description: "The hard-stopgate plugin for deployments that must keep an armed goal's session working instead of stopping at the first turn boundary, and whose completion decision belongs to the harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-stopgate

English | [中文](README.zh.md)

## Summary

`dsh-experimental-hard-stopgate` listens on the `agent/turn-stopping` boundary and steers a continuation order naming the ledger's open work whenever a turn tries to close while an armed, active goal still stands. It also owns completion: an `update_goal action complete` attempt on the armed goal runs the hard-ledger completion assessment, is denied with the exact remaining work while any stands, and every decision is appended as a `hard/gate/decision` event. Goalless, disarmed, paused, blocked, and completed agents close freely, and a per-turn budget bounds the forced continuations so a model that cannot advance the goal cannot hold the turn open forever.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the goal service and the hard ledger when turns under a mission goal must continue until the harness certifies completion, such as in the hard-bundle composition. It reads goal state through `ctx.goals`, open work and the completion assessment through `ctx.hardLedger`, and steers through the agent payload; it registers no tools and no prompt sections.

```yaml
- id: hard-stopgate
  name: '@deepseek-ai/dsh-experimental-hard-stopgate'
  config:
    maxSteersPerTurn: 16
    emptySweepsToFinish: 2
```

`maxSteersPerTurn` must be a positive safe integer; `emptySweepsToFinish` must be a safe integer from 0 through 16 and `0` drops the trailing-sweep condition. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-hard-stopgate) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Steering is the block.** A serial `agent/turn-stopping` listener reads the current goal and the ledger's open work; an armed, active goal with open work makes the gate call `agent.steer(...)` with a continuation order that names the remaining items, which makes the loop observe pending input and run another step. With no open work the turn closes — completion is the gate's call, not a steering order. Counters are dropped on plugin disposal and on `agent/disposed`.
- **Completion is veto-only.** A `tools/pre-execute` waterfall listener narrows `update_goal` arguments to `action complete`, checks the armed goal id the arming record carries, and asks the ledger for the assessment. A deny turns the blockers list into one imperative and never runs the tool body; the goal tool stays the single writer. Steering stays on the turn boundary so a denial never double-steers.
- **Every decision is logged.** Both branches append one `hard/gate/decision` event with the coverage, hypothesis, and finding counters, the trailing empty-sweep run, and the blockers, so a completion without a recorded assessment cannot exist.
- **Bounded runaway.** The gate counts forced continuations per agent and resets the count when the turn number advances. Once the budget is spent the turn closes; a goal-round driver or the user opens the next turn.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, the completion veto and its decision record, the owing-goal decision, the continuation order, and the turn-stopping listener |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Steering messages

#### What the model sees

One steering message per forced continuation, sent at the stopping boundary. The objective, the round numbers, and the open-work items are interpolated from the current goal and ledger; the rendered example uses the objective `find the deserialization bug`, round 0, a cap of 9, and one open coverage cell.

##### Continuation order

```markdown
The session objective is not complete: "find the deserialization bug". Goal round 0 of 9. Open work: 1 coverage cell(s) have no verdict yet; cell src × cmdi has no verdict. Resolve the next item now; do not stop or summarize. The harness owns completion: update_goal action complete is denied while this list is non-empty.
```

#### Token effect

One short message per forced continuation, only in turns that attempt to close under an armed active goal.

#### KV Cache effect

Appends after the reusable request prefix without invalidating earlier entries; the budget bounds the appended volume per turn.

### Completion denial

#### What the model sees

A too-early `update_goal action complete` fails as a tool error whose message names the exact remaining work, followed by the imperative to resolve and retry:

##### Denial reason

```markdown
The mission is not complete. 1 coverage cell(s) have no verdict yet; cell src × cmdi has no verdict. Resolve these, then mark the goal complete.
```

#### Token effect

One tool-error result per denied completion attempt; the model re-reads it as ordinary failure content.

#### KV Cache effect

Same shape as any failed tool result; the denial reason is bounded by the open-work list it reports.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Steering is advisory pressure** — the loop re-reads the inbox, so a model that cannot advance burns the budget and the turn closes; the gate cannot force the boundary to stay open.
- **Completion reads the ledger, not the target repository** — the assessment trusts coverage verdicts and sweep proofs recorded in the log; it does not re-verify them at gate time.
- **Completion path assumes the goal tools** — the veto keys on the `update_goal` tool name and the `complete` action; a composition without `dsh-tool-goal` must surface that action through another consumer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
