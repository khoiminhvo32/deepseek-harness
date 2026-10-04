---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-04-hard-stopgate-attribution

English | [中文](2026-10-04-hard-stopgate-attribution.zh.md)

## Summary

The experimental hard-stopgate plugin declares one new attribution-only message source kind, hard-stopgate, which it stamps on steering injected at the agent/turn-stopping boundary. The kind joins the persisted user/message, developer/message, agent/inbox/spliced, and session/title-llm-request source unions as a same-version additive change.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-04-hard-stopgate-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "57fe84dbbb60822191e60ae16f66019c35d3bad98c0e35accf2d4bcded35b3cf"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "7bebe057450d53ad6ec39a037d23a0b7bca3c9d4cb60944285c164b27aa74764"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "11825e471796728ed16a881e680211711fc06cae6aa708824e70c28058ad3f9b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "94d23ce3756eb76efd78716072a69b2e57baa86970c6f7d2142577f431ef4825"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Attribution-only: the kind carries no payload beyond the literal discriminator, so old readers preserve messages carrying it without the producer under the declared session-source-attribution policy, and new readers accept logs that lack the kind. The Session format stays 4 and no migration is required.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-changes passes with the kind annotated @persistenceAttribution; the hard-stopgate unit suite steers through the new source, and the keyless recorded-session snapshot suite replays the log shape.

<a id="dev-note"></a>
## Dev Note

None.
