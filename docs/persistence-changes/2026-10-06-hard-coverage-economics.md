---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-06-hard-coverage-economics

English | [中文](2026-10-06-hard-coverage-economics.zh.md)

## Summary

The hard-harness coverage economics change adds two optional properties: hard/mission/armed gains inertModules, the sorted subset of armed modules whose every tracked file carries an inert extension, and hard/coverage/cell gains source, naming who decided the verdict (model, model-verified batch clear, or a purely mechanical harness screen).

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-hard-coverage-economics
baseline: false
changes:
  - root: "event:hard/coverage/cell"
    previous: "2026-10-04-hard-ledger-events"
    after: "c1f5a2e424cdeeee133c7b4d2f5599d1c13ab0290e07cb92619fc5c923b55502"
    decision: same-version
  - root: "event:hard/mission/armed"
    previous: "2026-10-05-hard-mission-armed"
    after: "4a44bc0b449762e9c5f0b13fbea08a7fb607f34d1681aee1edb5d88ee1249161"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both additions are optional properties on same-version events: producers may omit them, old logs read back with absent inertModules screened as empty and absent source read as model, so no persisted event changes shape and Session format stays 4 with no migration. Older builds refuse these logs instead of misreading them, the required-on-read contract for in-repo events.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-changes passes after the acknowledgement; the hard-ledger suite folds both optional properties, partitions coverageBySource across the three deciders, and proves legacy events without source read as model, and the keyless recorded-session snapshot suite replays the armed matrix with the inert screen end to end.

<a id="dev-note"></a>
## Dev Note

None.
