---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-07-hard-audit-events

English | [中文](2026-10-07-hard-audit-events.zh.md)

## Summary

Adds the hard/audit/requested and hard/audit/result event roots, which record the independent audit's sampled requests and their settled results beside the hard mission's coverage verdicts.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-hard-audit-events
baseline: false
changes:
  - root: "event:hard/audit/requested"
    previous: null
    after: "6415d8462b85a55c3267e6d1412698543ff76974f098ec7ddd96c195904f741e"
    decision: same-version
  - root: "event:hard/audit/result"
    previous: null
    after: "13d18cc6c0d772d8e2d809e06721239716df321d0937b4a44df26eaa7d419333"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Purely additive event roots: no existing event changes shape and the envelope, surface set, and header are unchanged, so every prior event reconstructs as before and Session format stays 4 with no migration. Only sessions whose deployment enables the audit write them; older builds that predate this vocabulary refuse such logs instead of misreading them, which is the required-on-read contract for in-repo events.

<a id="verification"></a>
## Verification

pnpm vitest run packages/experimental/hard-audit: all tests passed with full line and branch coverage; pnpm run test:e2e apps/cli/tests/hard-audit.e2e.ts records both events through the shipped hard bundle.

<a id="dev-note"></a>
## Dev Note

None.
