---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-11-hard-feature-abuse

English | [中文](2026-10-11-hard-feature-abuse.zh.md)

## Summary

The experimental hard harness adds five event roots for feature abuse work — hard/feature/pair, hard/feature/pair/resolved, hard/feature/reviewed, hard/guard/declared, and hard/entry/declared — and an optional source field on hard/feature/linked that names whether the model or the harness recorded the relation.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-11-hard-feature-abuse
baseline: false
changes:
  - root: "event:hard/entry/declared"
    previous: null
    after: "54f36275b85fb962e4fa165351038a0507f65691484172f206150c35bb30d6f8"
    decision: same-version
  - root: "event:hard/feature/linked"
    previous: "2026-10-10-hard-feature-map"
    after: "eacde8a049a74e19c6a7f9dfe7189ef2caf5b549b34dd9d18a8dbffda2ed27ed"
    decision: same-version
  - root: "event:hard/feature/pair"
    previous: null
    after: "d666933bbcf615e39a2f7358e416218cf954a44b0038c44217af990b85a8a243"
    decision: same-version
  - root: "event:hard/feature/pair/resolved"
    previous: null
    after: "06b2ac1f171f7cabb3a29fa01df4f084bb1ee5039a8edc6d41dbe39b0a0086c6"
    decision: same-version
  - root: "event:hard/feature/reviewed"
    previous: null
    after: "a4cfcf2c6c262dfcae4a01df5a5c4f6194c97931b6592cfbb8536e8a07b7d9d2"
    decision: same-version
  - root: "event:hard/guard/declared"
    previous: null
    after: "ea5fa056b01f9c556e5580555456691d47cbd59cd06c3f884823f39f6db3cc30"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

All five roots are new and the source field is optional, so existing logs read back unchanged and a relation without a source reads as the model's. The ledger projection folds the new records into optional state fields, so cached projection states from before the change fold without a rebuild. The Session format stays 4.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/hard-ledger packages/experimental/hard-featuremap: all tests passed, including the fold of guard pairs, resolutions, reviews, and declarations onto an empty state.

<a id="dev-note"></a>
## Dev Note

None.
