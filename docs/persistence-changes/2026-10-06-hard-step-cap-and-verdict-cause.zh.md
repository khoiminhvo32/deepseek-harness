---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-06-hard-step-cap-and-verdict-cause

[English](2026-10-06-hard-step-cap-and-verdict-cause.md) | 中文

## 概述

以纯增量方式落地两项可度量能力。hard rounds 模块在某个 turn 因新的 `maxStepsPerTurn` 成本上限被停止时记录 `hard/step-cap/reached`——该上限在 `agent/pre-step` 边界检查，对每一个 turn 生效，无论它是否属于某个 round。verdict 词汇新增两个可选属性：`cause`，每个 refuted 分支都会指派的可聚合原因代码；`evidence`，为将来的差分运行器保留 `proven`，缺席时读作 `demonstrated`。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-hard-step-cap-and-verdict-cause
baseline: false
changes:
  - root: "event:hard/finding/verdict"
    previous: "2026-10-06-hard-specificity-check"
    after: "f7a6cd245cf6a3fa2484efa9bba047af12b13ab4af377d30140f48aadbc33185"
    decision: same-version
  - root: "event:hard/step-cap/reached"
    previous: null
    after: "c26fb18293ce01561b803f4dcc29afe79ba6ba499fb4baa78ce056b5a3411a5e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

纯增量：一个新事件根，以及 `hard/finding/verdict` 上的两个可选属性。表面集合、信封与头部不变，每个既有事件的重构不变，Session 格式保持 4，无需迁移。旧 verdict 读回时没有 `cause` 与 `evidence`——正是字段语义所定义的缺席状态（无原因归因、evidence 读作 `demonstrated`）；早于该词汇的旧构建会拒绝新日志而不是误读它，这是仓库内事件的 required-on-read 契约。

<a id="verification"></a>
## 验证

确认后 pnpm run verify-persistence-changes 通过。hard-rounds 套件在属于 round 与不属于 round 的 turn 上驱动该上限并固定逐 agent 的隔离，hard-verifier 套件为每个 refuted 分支断言 cause，hard-ledger 套件聚合 `refutationBreakdown`（旧 verdict 计入 `unattributed`）并让零运行的良性反驳通过状态 schema 解析，keyless recorded-session 快照端到端回放携带 cause 的 verdict。

<a id="dev-note"></a>
## 开发备注

无。
