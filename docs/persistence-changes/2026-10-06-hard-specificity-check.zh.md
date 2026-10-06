---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-06-hard-specificity-check

[English](2026-10-06-hard-specificity-check.md) | 中文

## 概述

效果证明契约新增一个阴性对照：提案发现现在记录其 PoC 以 `$1` 接收的利用 `payload`，验证器的结论记录良性载荷臂的结果。harness 用由 claim 哈希派生的良性载荷重跑同一 PoC 并要求其失败——无论输入如何都通过的证明对输入什么都没证明（specificity check）。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-hard-specificity-check
baseline: false
changes:
  - root: "event:hard/finding/proposed"
    previous: "2026-10-04-hard-ledger-events"
    after: "a6070ac85f65889290ca90622dd0f508b6621a74e9b5319ff07ef86442b002d0"
    decision: same-version
  - root: "event:hard/finding/verdict"
    previous: "2026-10-04-hard-ledger-events"
    after: "0827984ae17179d37b7bb163f0f9e5bfbd979128c9a2fd705dc2046e5548e45f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

纯增量：两个既有事件体上各一个可选属性。表面集合、信封与头部不变，每个既有事件的重构不变，Session 格式保持 4，无需迁移。旧日志读回时没有 `payload`、没有良性臂结果——这正是字段缺席所编码的"对照未运行"状态；早于该词汇的旧构建会拒绝新日志而不是误读它，这是仓库内事件的 required-on-read 契约。

<a id="verification"></a>
## 验证

确认后 pnpm run verify-persistence-changes 通过。hard-verifier 套件驱动双臂执行的各结论分支与提前停止，hard-tools 套件通过工具 schema 携带 payload 提交发现，keyless recorded-session 快照端到端回放四条提案发现——三条被反驳（死 PoC、回声陷阱、载荷无关证明）与一条确认。

<a id="dev-note"></a>
## 开发备注

新字段仅在类型层面为旧日志可选；`proposeFinding` 与 `verify` 在运行时拒绝缺失 payload 的提案，因此只有本次更改之前写入的日志才会缺少它们。
