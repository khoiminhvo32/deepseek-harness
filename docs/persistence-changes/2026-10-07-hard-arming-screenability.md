---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-07-hard-arming-screenability

English | [中文](2026-10-07-hard-arming-screenability.zh.md)

## Summary

Adds optional screenability, exclusion, and ignored-entry fields to the hard mission arming record, and optional blind-clear and excluded-file counts to the hard gate decision record.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-hard-arming-screenability
baseline: false
changes:
  - root: "event:hard/gate/decision"
    previous: "2026-10-06-hard-completion-gate"
    after: "73c3f056eb86f03647a688becfbfd75a3976b31a6faf98077b23005e14256e82"
    decision: same-version
  - root: "event:hard/mission/armed"
    previous: "2026-10-06-hard-completion-gate"
    after: "b849266f726df8bf4c85bf3443d3f695d1dcc9da8aaec961419bfe36d3c7ced6"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Every new field is optional. Existing arming records read as an unscreened set of none, no exclusions, and no ignored-entry count, which is how they were treated before; existing gate decisions read without the two counts. The ledger projection folds the new arming fields into optional matrix fields, so no cached state needs a rebuild.

<a id="verification"></a>
## Verification

pnpm vitest run packages/experimental/hard-ledger packages/experimental/hard-mission packages/experimental/hard-stopgate packages/experimental/hard-tools packages/experimental/client-ui-hard: all tests passed; pnpm run test:snapshot -t hard replays hard-fabrication with the refreshed session fixture.

<a id="dev-note"></a>
## Dev Note

None.
