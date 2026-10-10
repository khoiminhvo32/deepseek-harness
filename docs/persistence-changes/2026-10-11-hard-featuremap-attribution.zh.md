---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-11-hard-featuremap-attribution

[English](2026-10-11-hard-featuremap-attribution.md) | 中文

## 概述

实验性的 hard-featuremap 插件声明一个新的仅归属消息来源类型 hard-featuremap，用于标记任务武装时索引完成后注入的通知。该类型以同版本增量变更加入持久化的 user/message、developer/message、agent/inbox/spliced 与 session/title-llm-request 来源联合。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

仅归属：该类型除字面判别值外不携带任何载荷，因此旧读取方会按已声明的会话来源归属策略保留带有它的消息而不保留生产方，新读取方也接受不含该类型的日志。Session 格式保持为 4，无需迁移。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/hard-featuremap：全部测试通过，包括任务武装时索引完成后注入的通知。

<a id="dev-note"></a>
## 开发备注

无。
