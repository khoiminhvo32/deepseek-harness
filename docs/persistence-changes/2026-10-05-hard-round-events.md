---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-05-hard-round-events

English | [中文](2026-10-05-hard-round-events.zh.md)

## Summary

The experimental hard-rounds plugin adds two additive hard/round/* session events — hard/round/start and hard/round/end — recording the hard mission's round accounting (the admitted round with its A/B rotation phase and open-work count, and the closing turn with its step count and end reason).

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-hard-round-events
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-05-hard-standby-handoff-persistence"
    after: "77f83914f9fe917b255099fd191f39b898cd9231b02612a5a7b1fa2bc04ecf1d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-hard-standby-handoff-persistence"
    after: "c804ffb892a79ccdda0153e8cd32f3d9cfb32f57729d2d8c4f838408f3ad42b8"
    decision: same-version
  - root: "event:hard/round/end"
    previous: null
    after: "9c8583a2e073f7ddb70f3ae373b1916e1c75f9c7e338078bd09b3a59df203cfc"
    decision: same-version
  - root: "event:hard/round/start"
    previous: null
    after: "ccbb541cf9d9b06d32fe9bbad9ec4a1a1d8345cae91e4a0a4aef7321b51d499c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-05-hard-standby-handoff-persistence"
    after: "cbc1bf21e03adafde104933b2b523b6858f20b71406c601b9bdfe428a5ec93cb"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-hard-standby-handoff-persistence"
    after: "1fafc3d9d02d3a8252d106de4dfa6be3fc1b9d8d800b68f83d70244ab88689ba"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Purely additive event roots: the surface set, envelope, and header are unchanged, and no existing event changes shape, so reconstruction of every prior event is untouched and Session format stays 4 with no migration. Older builds that predate this vocabulary refuse such logs instead of misreading them, which is the required-on-read contract for in-repo events.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-changes passes after the acknowledgement; the hard-rounds suite appends a start per admitted goal round, cancels at the per-round step budget, and records an end per closing turn.

<a id="dev-note"></a>
## Dev Note

None.
