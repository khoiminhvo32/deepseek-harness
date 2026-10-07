---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-07-hard-arming-screenability

[English](2026-10-07-hard-arming-screenability.md) | 中文

## 概述

为 hard 任务武装记录新增可选的可筛查性、排除与忽略条目字段，并为 hard 完成门决策记录新增可选的盲清除计数与被排除文件计数。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-hard-arming-screenability
baseline: false
changes:
  - root: "event:hard/gate/decision"
    previous: "2026-10-06-hard-completion-gate"
    after: "73c3f056eb86f03647a688becfbfd75a3976b31a6faf98077b23005e14256e82"
    decision: same-version
  - root: "event:hard/mission/armed"
    previous: "2026-10-06-hard-completion-gate"
    after: "b849266f726df8bf4c85bf3443d3f695d1dcc9da8aaec961419bfe36d3c7ced6"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

所有新字段均为可选。已有武装记录读作没有不可筛查模块、没有排除、没有忽略条目计数，与此前的处理方式一致；已有完成门决策读作不含这两个计数。台账投影把新的武装字段折叠为矩阵上的可选字段，因此缓存状态无需重建。

<a id="verification"></a>
## 验证

pnpm vitest run packages/experimental/hard-ledger packages/experimental/hard-mission packages/experimental/hard-stopgate packages/experimental/hard-tools packages/experimental/client-ui-hard：全部测试通过；pnpm run test:snapshot -t hard 使用刷新后的会话夹具回放 hard-fabrication。

<a id="dev-note"></a>
## 开发备注

无。
