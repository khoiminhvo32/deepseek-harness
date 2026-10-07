---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-07-hard-audit-events

[English](2026-10-07-hard-audit-events.md) | 中文

## 概述

新增 hard/audit/requested 与 hard/audit/result 事件根，在 hard 任务的覆盖判定旁记录独立审计的抽样请求及其结算结果。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-hard-audit-events
baseline: false
changes:
  - root: "event:hard/audit/requested"
    previous: null
    after: "6415d8462b85a55c3267e6d1412698543ff76974f098ec7ddd96c195904f741e"
    decision: same-version
  - root: "event:hard/audit/result"
    previous: null
    after: "13d18cc6c0d772d8e2d809e06721239716df321d0937b4a44df26eaa7d419333"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

纯增量的事件根：没有既有事件改变结构，信封、surface 集合与头部都不变，因此每个既有事件照旧重建，Session 格式保持 4，无需迁移。只有启用审计的部署会写入它们；早于该词汇的旧构建会拒绝此类日志而不是误读，这正是仓库内事件的读取必需约定。

<a id="verification"></a>
## 验证

pnpm vitest run packages/experimental/hard-audit：全部测试通过，行与分支覆盖率均为 100%；pnpm run test:e2e apps/cli/tests/hard-audit.e2e.ts 通过随附的 hard bundle 记录两个事件。

<a id="dev-note"></a>
## 开发备注

无。
