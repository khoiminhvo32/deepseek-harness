---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-04-hard-ledger-events

English | [中文](2026-10-04-hard-ledger-events.zh.md)

## Summary

The experimental hard-ledger plugin adds five additive hard/* session events: hard/finding/proposed, hard/finding/verdict, hard/hypothesis/state, hard/coverage/cell, and hard/sweep/summary. They record vulnerability-hunting methodology state (findings with verifier outcomes, hypothesis lifecycle, coverage cells, sweep summaries) for the hard harness composition.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-04-hard-ledger-events
baseline: false
changes:
  - root: "event:hard/coverage/cell"
    previous: null
    after: "be0ae110c839a6218eaf7315ac9e1ac79840ed36f8ab5121141c96eb72b2a37c"
    decision: same-version
  - root: "event:hard/finding/proposed"
    previous: null
    after: "191eb7fd027003b069fbd1f4fd567fff129cc3f767f238a88fb26ad4def9df83"
    decision: same-version
  - root: "event:hard/finding/verdict"
    previous: null
    after: "d14c7ff86caaf48e763fbd5d1e8e25e776bb4b35913ed345b7b04cb72166e1bc"
    decision: same-version
  - root: "event:hard/hypothesis/state"
    previous: null
    after: "b2ca5611d82c38dcf57beda2d6ac9c50bb001052ab52932a04541186fafc40a1"
    decision: same-version
  - root: "event:hard/sweep/summary"
    previous: null
    after: "805ba772ea1180e8d0df6d274a8a9c95277505ad6542a5ddd9261831f833654b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Purely additive event roots: the surface set, envelope, and header are unchanged, and no existing event changes shape, so reconstruction of every prior event is untouched and Session format stays 4 with no migration. Older builds that predate this vocabulary refuse such logs instead of misreading them, which is the required-on-read contract for in-repo events.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-changes passes after the acknowledgement; the hard-ledger, hard-verifier, and hard-tools suites append and fold every event type end to end, and the exhaustive CVSS macrovector sweep pins the verifier verdict payloads.

<a id="dev-note"></a>
## Dev Note

None.
