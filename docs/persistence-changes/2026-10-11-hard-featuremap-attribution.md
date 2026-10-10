---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-11-hard-featuremap-attribution

English | [中文](2026-10-11-hard-featuremap-attribution.zh.md)

## Summary

The experimental hard-featuremap plugin declares one new attribution-only message source kind, hard-featuremap, which it stamps on the notice injected when indexing on arming finishes. The kind joins the persisted user/message, developer/message, agent/inbox/spliced, and session/title-llm-request source unions as a same-version additive change.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-11-hard-featuremap-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-05-hard-round-events"
    after: "c79aaef106c5cf2fae4592f3ea9446bbdaa935f1bedd0ca2df71a187804ef0f2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-hard-round-events"
    after: "acf709bb66636da2920836de09cf1dec927108b45572955e8190fc9b4b5219b8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-05-hard-round-events"
    after: "1f388d2650b450279d5b502944be8664ffc2b4600e387448804d41a0f5297d80"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-hard-round-events"
    after: "9f27e17004b6dbe5aac9c97746ac02a8233c75b52a56519ced9a7ed4be577a25"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Attribution-only: the kind carries no payload beyond the literal discriminator, so old readers preserve messages carrying it without the producer under the declared session-source-attribution policy, and new readers accept logs that lack the kind. The Session format stays 4 and no migration is required.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/hard-featuremap: all tests passed, including the injected notice after indexing on arming.

<a id="dev-note"></a>
## Dev Note

None.
