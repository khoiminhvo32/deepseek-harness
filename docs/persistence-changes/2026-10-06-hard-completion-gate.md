---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-06-hard-completion-gate

English | [中文](2026-10-06-hard-completion-gate.zh.md)

## Summary

The completion gate closes the hard-harness authority gap: the model proposes completion with `update_goal action complete`, and the hard-stopgate plugin decides. Three event changes carry the record. The new `hard/gate/decision` event stores every gate assessment, with coverage progress split by deciding source, hypothesis and finding counters, the trailing empty-sweep run, and the bounded blockers. `hard/mission/armed` gains an optional `goalId` so the gate only fires for the goal the mission armed. `hard/sweep/summary` gains an optional `emptyProofRef` — a verified reference to a refuted hypothesis or a model-cleared cell — while the legacy free-text `emptyProof` stays for older logs.


## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-hard-completion-gate
baseline: false
changes:
  - root: "event:hard/gate/decision"
    previous: null
    after: "11dde453fdedbc2b3f5d81c0872f8212ee4c6ef4ad3b5ff3d78b5c6f211204f1"
    decision: same-version
  - root: "event:hard/mission/armed"
    previous: "2026-10-06-hard-coverage-economics"
    after: "5691d737530f411af6eb333e9f8a92d2a13a605dc501603e33e1e9d6654b120f"
    decision: same-version
  - root: "event:hard/sweep/summary"
    previous: "2026-10-04-hard-ledger-events"
    after: "53eefd2160b1a8732740741877d174a72ed34016e7a2641be5fe424ccd55e75a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Purely additive: one new event root and two optional properties on existing event bodies. The surface set, envelope, and header are unchanged, every prior event reconstructs unchanged, and Session format stays 4 with no migration. Old logs read back with the sweep's legacy `emptyProof` text and no gate decisions, so a resumed pre-gate session keeps its meaning; older builds that predate the gate vocabulary refuse the new log instead of misreading it, which is the required-on-read contract for in-repo events.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-changes passes after the acknowledgement. The hard-stopgate suite drives the veto through the real update_goal tool in both branches, the hard-ledger suite verifies the empty-sweep referent checks and the completion assessment blockers, and the keyless recorded-session snapshot replays a deny-then-allow gate pair end to end.

<a id="dev-note"></a>
## Dev Note

The `emptyProof` string stays in the vocabulary unchanged so the refactoring is additive; `recordSweep` refuses it on new records, so only older logs can carry one.
