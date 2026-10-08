---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-08-hard-weakness-chains

English | [中文](2026-10-08-hard-weakness-chains.zh.md)

## Summary

Adds the hard/flaw/recorded event for weaknesses kept as chaining material, optional chain links on hard/hypothesis/state, and an optional chaining marker on hard/round/start.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-hard-weakness-chains
baseline: false
changes:
  - root: "event:hard/flaw/recorded"
    previous: null
    after: "883e93df3e09e9bced9ebd4b2b89c040643b9b2a5d1ee6e7d207e44873eeaf6a"
    decision: same-version
  - root: "event:hard/hypothesis/state"
    previous: "2026-10-04-hard-ledger-events"
    after: "11064b683a0aa59bf53f2f29e2ae178888f8a6b14989eed85879d6cc8d23cd69"
    decision: same-version
  - root: "event:hard/round/start"
    previous: "2026-10-05-hard-round-events"
    after: "3454a1b61bdcf0c0a266f4f3ab44447a25194f021d8f10053794bf01095d80a2"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

All three changes are additive. Existing logs carry no weakness records, no links, and no chaining marker, and read back unchanged: a hypothesis without links is an ordinary hypothesis and a round start without the marker ran its A/B slot. The ledger projection folds weaknesses into an optional state field, so cached projection states from before the change fold without a rebuild.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/hard-ledger packages/experimental/hard-tools packages/experimental/hard-rounds: all tests passed, including the fold of a weakness record onto a cached state that predates it.

<a id="dev-note"></a>
## Dev Note

None.
