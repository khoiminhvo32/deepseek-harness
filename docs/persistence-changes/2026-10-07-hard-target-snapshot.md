---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-07-hard-target-snapshot

English | [中文](2026-10-07-hard-target-snapshot.zh.md)

## Summary

Adds an optional snapshot field to the hard mission arming record, naming the harness-owned git store, target kind, and target origin the pinned commit lives in.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-hard-target-snapshot
baseline: false
changes:
  - root: "event:hard/mission/armed"
    previous: "2026-10-07-hard-arming-screenability"
    after: "bb1d804db3f09ab543cf85193e4d0634cec45e5c001d1973900ea52b9b873517"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The field is optional and additive. An arming record without it pinned a commit of the target repository itself, which every reader still reaches by running git in the target directory, so older logs read and replay as before, and the ledger projection folds the field into an optional matrix field without a cache rebuild. Session format stays 4 with no migration.

<a id="verification"></a>
## Verification

pnpm vitest run packages/experimental/hard-ledger packages/experimental/hard-mission packages/experimental/hard-audit: all tests passed; pnpm run test:snapshot -t hard-fabrication replays the refreshed arming record; the hard e2e tests arm git and plain-directory targets through the shipped bundle.

<a id="dev-note"></a>
## Dev Note

None.
