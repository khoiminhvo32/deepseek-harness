---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-04-hard-stopgate-attribution

[English](2026-10-04-hard-stopgate-attribution.md) | 中文

## 概述

实验性 hard-stopgate 插件声明一个新的仅归因消息来源 kind（hard-stopgate），它把该 kind 盖在 agent/turn-stopping 边界注入的转向消息上。该 kind 以同版本增量变更的方式加入持久的 user/message、developer/message、agent/inbox/spliced 与 session/title-llm-request 来源联合。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

仅归因：该 kind 在字面判别符之外不携带任何负载，因此在已声明的 session-source-attribution 策略下，旧读取器会保留携带该 kind 的消息而不需要生产者，新读取器也接受缺少该 kind 的日志。Session 格式保持 4，无需迁移。

<a id="verification"></a>
## 验证

在 kind 标注 @persistenceAttribution 后 pnpm run verify-persistence-changes 通过；hard-stopgate 单元套件通过新来源进行转向，无密钥的录制会话快照套件重放该日志形态。

<a id="dev-note"></a>
## 开发备注

无。
