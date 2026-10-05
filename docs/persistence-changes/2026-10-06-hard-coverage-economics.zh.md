---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-06-hard-coverage-economics

[English](2026-10-06-hard-coverage-economics.md) | 中文

## 概述

hard harness 的覆盖经济学变更新增两个可选属性：hard/mission/armed 新增 inertModules（武装模块中每个已跟踪文件都只带惰性扩展名的已排序子集），hard/coverage/cell 新增 source（标明结论由谁决定：model、经 grep 验证的批量清除 model-verified，或纯机械的 harness 筛查）。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-hard-coverage-economics
baseline: false
changes:
  - root: "event:hard/coverage/cell"
    previous: "2026-10-04-hard-ledger-events"
    after: "c1f5a2e424cdeeee133c7b4d2f5599d1c13ab0290e07cb92619fc5c923b55502"
    decision: same-version
  - root: "event:hard/mission/armed"
    previous: "2026-10-05-hard-mission-armed"
    after: "4a44bc0b449762e9c5f0b13fbea08a7fb607f34d1681aee1edb5d88ee1249161"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两者都是同版本事件上的可选属性：生产者可以省略它们；旧日志读回时 inertModules 缺失视为空筛、source 缺失视为 model，没有任何持久化事件改变形状，Session 格式保持 4，无需迁移。早于该词表的旧构建会拒绝此类日志而非误读，这正是仓库内事件要求的读取契约。

<a id="verification"></a>
## 验证

确认通过后 pnpm run verify-persistence-changes 通过；hard-ledger 套件折叠两个可选属性，按三个决定方拆分 coverageBySource，并证明无 source 的旧事件按 model 读回；无密钥的录制会话快照套件端到端重放带惰性筛查的武装矩阵。

<a id="dev-note"></a>
## 开发备注

无。
