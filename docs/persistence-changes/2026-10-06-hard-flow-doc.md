---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-06-hard-flow-doc

English | [中文](2026-10-06-hard-flow-doc.zh.md)

## Summary

The deep-reading pass (Phase B) becomes checkable. The new `hard/flow/doc` event stores one module's recorded flow document after the verifier resolved every citation against the pinned commit: per-section entry counts in contract order, the resolved citation total, and the hypothesis ids opened from the quirks. Prose and snippets stay in the tool result; the log carries only what the harness checked. `hard/sweep/summary` gains an optional `emptyProofFlowDoc` — a sibling of `emptyProofRef` naming the recorded flow document whose resolvable citations prove the deep-reading pass ran — so a Phase B pass that found nothing must cite a recorded, citation-resolved document instead of a promise.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-hard-flow-doc
baseline: false
changes:
  - root: "event:hard/flow/doc"
    previous: null
    after: "01a9d33aab4a3d0c41b3d8be2eea3428447c888a48e8c7368b4cfaa59b33e5c5"
    decision: same-version
  - root: "event:hard/sweep/summary"
    previous: "2026-10-06-hard-completion-gate"
    after: "86d644bd25fa85186753fe688a9f5b3304ed56264923f4ab6f3e9fc65f598a45"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both changes are additive and read under the current Session format version. `hard/flow/doc` is a new ignorable event root; older logs carry none and the projection state folds it into an optional state field. `emptyProofFlowDoc` is an optional property on `hard/sweep/summary`, so older logs read back unchanged; new sweeps may carry either `emptyProofRef` or `emptyProofFlowDoc`, never both. The flow reference deliberately does not join the `emptyProofRef` discriminated union: adding a variant there is classified as a union-variants change and would force a Session-format version bump, while this sibling property keeps the same verifiable semantics at same-version.

<a id="verification"></a>
## Verification

The keyless e2e hard-profile run records a fabricated citation, which the verifier rejects naming the failed cite and the tool result marks as an error, then records a resolvable citation and asserts the folded `hard/flow/doc` summary in the durable log. Unit tests pin the flow-document fold, the citation-total invariant, and both empty-proof paths: an unrecorded module and a zero-citation document refuse the sweep proof, while a recorded document with citations passes it. The authored snapshot replays the rejected and resolved record flow end to end.

<a id="dev-note"></a>
## Dev Note

None.
