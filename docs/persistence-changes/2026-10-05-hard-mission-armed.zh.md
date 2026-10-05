---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-05-hard-mission-armed

[English](2026-10-05-hard-mission-armed.md) | 中文

## 概述

实验性 hard-mission 插件新增一条增量的 hard/mission/armed 会话事件，在任务武装根目标时追加一次。它记录已固定的目标仓库、解析出的完整提交 sha、构成覆盖矩阵行的模块清单，以及 bug 类别列。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-hard-mission-armed
baseline: false
changes:
  - root: "event:hard/mission/armed"
    previous: null
    after: "dc11307aaf8f65502dd82718a38d0215b5beded7561880bc4a268d9bd6d468b1"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

纯增量事件根：事件面集合、信封与头部均不变，且没有任何既有事件改变形状，因此所有先前事件的重构不受影响，Session 格式保持 4，无需迁移。早于该词表的旧构建会拒绝此类日志而不是误读，这正是仓库内事件所要求的读取必须识别契约。

<a id="verification"></a>
## 验证

确认通过后 pnpm run verify-persistence-changes 通过；hard-ledger 套件把武装记录折叠进覆盖矩阵，并据此驱动 coverageProgress、uncoveredCells 与 openWork，且无密钥的录制会话快照套件端到端重放武装后的日志形状。

<a id="dev-note"></a>
## 开发备注

无。
