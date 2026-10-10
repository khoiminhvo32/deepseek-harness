---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-10-hard-feature-map

English | [中文](2026-10-10-hard-feature-map.zh.md)

## Summary

Adds the hard/featuremap/indexed, hard/feature/recorded, and hard/feature/linked events for the hard harness feature map.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-10-hard-feature-map
baseline: false
changes:
  - root: "event:hard/feature/linked"
    previous: null
    after: "cd4908c1207d6767117f4e09395408db86f453a0cbc398f9ee0593191f876c7a"
    decision: same-version
  - root: "event:hard/feature/recorded"
    previous: null
    after: "013a116aceedf81d16bc6c243418a0fde01180a6786d15002f1e34ce6053e92e"
    decision: same-version
  - root: "event:hard/featuremap/indexed"
    previous: null
    after: "23081f7f97e4b4c163aac9698255273e730dd41afc0dfb6be87815326252efce"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

All three changes are new event roots. Existing logs carry none of them and read back unchanged: without an indexed feature map the ledger owes no entry points, and without feature records it holds no features. The ledger projection folds the new records into optional state fields, so cached projection states from before the change fold without a rebuild.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/hard-ledger packages/experimental/hard-tools: all tests passed, including the fold of feature map records onto a cached state that predates them.

<a id="dev-note"></a>
## Dev Note

None.
