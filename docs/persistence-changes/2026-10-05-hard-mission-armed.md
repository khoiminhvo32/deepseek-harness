---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-05-hard-mission-armed

English | [中文](2026-10-05-hard-mission-armed.zh.md)

## Summary

The experimental hard-mission plugin adds one additive hard/mission/armed session event, appended once when the mission arms a root goal. It records the pinned target repository, the resolved full commit sha, the enumerated module list that forms the coverage matrix rows, and the bug class columns.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-hard-mission-armed
baseline: false
changes:
  - root: "event:hard/mission/armed"
    previous: null
    after: "dc11307aaf8f65502dd82718a38d0215b5beded7561880bc4a268d9bd6d468b1"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Purely additive event root: the surface set, envelope, and header are unchanged, and no existing event changes shape, so reconstruction of every prior event is untouched and Session format stays 4 with no migration. Older builds that predate this vocabulary refuse such logs instead of misreading them, which is the required-on-read contract for in-repo events.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-changes passes after the acknowledgement; the hard-ledger suite folds the arming record into the coverage matrix and drives coverageProgress, uncoveredCells, and openWork from it, and the keyless recorded-session snapshot suite replays the armed log shape end to end.

<a id="dev-note"></a>
## Dev Note

None.
