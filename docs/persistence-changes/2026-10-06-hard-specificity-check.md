---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-06-hard-specificity-check

English | [中文](2026-10-06-hard-specificity-check.zh.md)

## Summary

The proof-of-effect contract gains a negative control: a proposed finding now records the exploit `payload` its PoC takes as `$1`, and the verifier's verdict records how the benign-payload arm settled. The harness re-runs the same PoC with a benign payload derived from the claim hash and requires it to fail — a proof that passes regardless of input proves nothing about the input (the specificity check).

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-hard-specificity-check
baseline: false
changes:
  - root: "event:hard/finding/proposed"
    previous: "2026-10-04-hard-ledger-events"
    after: "a6070ac85f65889290ca90622dd0f508b6621a74e9b5319ff07ef86442b002d0"
    decision: same-version
  - root: "event:hard/finding/verdict"
    previous: "2026-10-04-hard-ledger-events"
    after: "0827984ae17179d37b7bb163f0f9e5bfbd979128c9a2fd705dc2046e5548e45f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Purely additive: one optional property on each of two existing event bodies. The surface set, envelope, and header are unchanged, every prior event reconstructs unchanged, and Session format stays 4 with no migration. Old logs read back without `payload` and with no benign-arm outcome — exactly the "control not run" state the field's absence encodes; older builds that predate the vocabulary refuse the new log instead of misreading it, which is the required-on-read contract for in-repo events.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-changes passes after the acknowledgement. The hard-verifier suite drives both verdict branches of the two-arm execution and the early stop, the hard-tools suite submits findings with payloads through the tool schema, and the keyless recorded-session snapshot replays four proposed findings — three refuted (a dead PoC and two payload-agnostic proofs) and one confirmed — end to end.

<a id="dev-note"></a>
## Dev Note

The new fields are optional at the type level only for older logs; the service input type `HardFindingRequest` requires the payload at compile time, so only logs written before this change can lack it.
