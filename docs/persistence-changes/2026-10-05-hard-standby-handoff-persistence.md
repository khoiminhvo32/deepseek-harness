---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-05-hard-standby-handoff-persistence

English | [中文](2026-10-05-hard-standby-handoff-persistence.zh.md)

## Summary

The experimental hard-standby plugin adds two additive hard/standby/* session events — hard/standby/scheduled and hard/standby/woke — recording the quota-wait state machine for the hard harness. The hard-standby and hard-handoff plugins each declare one attribution-only message source kind, hard-standby and hard-handoff, stamped on wake follow-ups and post-compaction injections; the kinds join the persisted user/message, developer/message, agent/inbox/spliced, and session/title-llm-request source unions.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-hard-standby-handoff-persistence
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-04-hard-stopgate-attribution"
    after: "e82c3ea05bb0a7449de663ffdb258f0beb44c7291cd4e6117eb265ee5e40b904"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-04-hard-stopgate-attribution"
    after: "7bff3ac57ee262157f317b381269d4eeda35c52a89be0c6dc3383f29caf581b1"
    decision: same-version
  - root: "event:hard/standby/scheduled"
    previous: null
    after: "7bdf6fa6739c693b9467a46c74c303e1e231172f435cf493cb1a237cd8625d8f"
    decision: same-version
  - root: "event:hard/standby/woke"
    previous: null
    after: "a180010d63e5be8421eefcf892a98765b38ebc3471a14d1e41b02d502b377343"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-04-hard-stopgate-attribution"
    after: "d41dd98dfa6872df60fd9b893d3ec18e696e4d624ecabdc50c357be8047f8fe0"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-04-hard-stopgate-attribution"
    after: "e498c1aab48e96a0196f463e46215b5574e9331eb361794b4d74e1f7fb22f027"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Purely additive: the two event roots are new log records with no surface, envelope, or header change, and the two source kinds carry no payload beyond the literal discriminator, so old readers preserve messages carrying them without the producer under the declared session-source-attribution policy and new readers accept logs that lack the kinds. No existing event changes shape, reconstruction of every prior event is untouched, and Session format stays 4 with no migration. Older builds that predate this vocabulary refuse such logs instead of misreading them, which is the required-on-read contract for in-repo events.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-changes passes after the acknowledgement; the hard-standby suite schedules a wait, folds it through the hardStandby projection, and wakes with the hard-standby-sourced follow-up, and the hard-handoff suite injects the hard-handoff-sourced summary after a successful compaction end while failed ends inject nothing.

<a id="dev-note"></a>
## Dev Note

None.
