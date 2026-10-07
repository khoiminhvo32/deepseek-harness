---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-07-hard-target-snapshot

[English](2026-10-07-hard-target-snapshot.md) | 中文

## 概述

为 hard 任务武装记录新增可选的 snapshot 字段，记录固定提交所在的 harness 自有 git 存储、目标类型与目标来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-hard-target-snapshot
baseline: false
changes:
  - root: "event:hard/mission/armed"
    previous: "2026-10-07-hard-arming-screenability"
    after: "bb1d804db3f09ab543cf85193e4d0634cec45e5c001d1973900ea52b9b873517"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该字段可选且为增量。没有该字段的武装记录固定的是目标仓库自身的提交，每个读取方仍在目标目录中运行 git 即可到达，因此旧日志的读取与回放不变；台账投影把该字段折叠为矩阵上的可选字段，缓存无需重建。Session 格式保持 4，无需迁移。

<a id="verification"></a>
## 验证

pnpm vitest run packages/experimental/hard-ledger packages/experimental/hard-mission packages/experimental/hard-audit：全部测试通过；pnpm run test:snapshot -t hard-fabrication 回放刷新后的武装记录；hard e2e 测试通过随附的 bundle 武装 git 目标与普通目录目标。

<a id="dev-note"></a>
## 开发备注

无。
