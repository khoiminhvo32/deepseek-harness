---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-06-hard-step-cap-and-verdict-cause

English | [中文](2026-10-06-hard-step-cap-and-verdict-cause.zh.md)

## Summary

Two measured-run capabilities land additively. The hard rounds module records `hard/step-cap/reached` when a turn is stopped at the new `maxStepsPerTurn` cost cap, enforced at the `agent/pre-step` boundary for every turn whether or not a round owns it. The verdict vocabulary gains two optional properties: `cause`, the aggregable reason code every refuted branch assigns, and `evidence`, which every confirmed verdict sets to `demonstrated` while `proven` stays reserved for a future differential runner.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-hard-step-cap-and-verdict-cause
baseline: false
changes:
  - root: "event:hard/finding/verdict"
    previous: "2026-10-06-hard-specificity-check"
    after: "f7a6cd245cf6a3fa2484efa9bba047af12b13ab4af377d30140f48aadbc33185"
    decision: same-version
  - root: "event:hard/step-cap/reached"
    previous: null
    after: "c26fb18293ce01561b803f4dcc29afe79ba6ba499fb4baa78ce056b5a3411a5e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Purely additive: one new event root and two optional properties on `hard/finding/verdict`. The surface set, envelope, and header are unchanged, every prior event reconstructs unchanged, and Session format stays 4 with no migration. Old verdicts read back without `cause` and `evidence` — no cause attribution, and a confirm from before the control ran lacks the `demonstrated` evidence every new confirm records, so old confirms read as weaker than new ones; older builds that predate the vocabulary refuse the new log instead of misreading it, which is the required-on-read contract for in-repo events.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-changes passes after the acknowledgement. The hard-rounds suite drives the cap in round and roundless turns and pins per-agent separation, the hard-verifier suite asserts a cause on every refuted branch and `demonstrated` evidence on the confirmed branch, the hard-ledger suite aggregates `refutationBreakdown` with legacy verdicts counted as `unattributed` and parses the zero-run benign refutation through the state schema, and the keyless recorded-session snapshot replays the cause- and evidence-carrying verdicts end to end.

<a id="dev-note"></a>
## Dev Note

None.
