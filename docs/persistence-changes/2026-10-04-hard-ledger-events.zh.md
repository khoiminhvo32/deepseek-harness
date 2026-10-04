---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-04-hard-ledger-events

[English](2026-10-04-hard-ledger-events.md) | 中文

## 概述

实验性 hard-ledger 插件新增五个增量 hard/* 会话事件：hard/finding/proposed、hard/finding/verdict、hard/hypothesis/state、hard/coverage/cell 与 hard/sweep/summary。它们为 hard 组合记录漏洞挖掘方法论状态（带验证器结论的 findings、假设生命周期、覆盖单元、扫描摘要）。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

纯增量事件 root：表面集合、信封与头部不变，任何既有事件形态不变，因此对既有事件的重放完全不受影响，Session 格式保持 4，无需迁移。早于该词汇表的构建会拒绝此类日志而非误读，这正是仓库内事件要求的读取契约。

<a id="verification"></a>
## 验证

确认后 pnpm run verify-persistence-changes 通过；hard-ledger、hard-verifier 与 hard-tools 套件端到端追加并折叠全部事件类型，穷举式 CVSS macrovector 扫描固定了验证器结论负载。

<a id="dev-note"></a>
## 开发备注

无。
