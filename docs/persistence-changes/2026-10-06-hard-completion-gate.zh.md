---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-06-hard-completion-gate

[English](2026-10-06-hard-completion-gate.md) | 中文

## 概述

完成门补上了 hard-harness 的权威缺口：模型通过 `update_goal action complete` 提议完成，由 hard-stopgate 插件裁决。三项事件更改承载记录。新的 `hard/gate/decision` 事件保存每一次门评估，包含按裁决来源拆分的覆盖进度、假设与发现计数、末尾空扫描连击数，以及有界的阻塞项。`hard/mission/armed` 新增可选 `goalId`，让门只对 mission 武装的那个目标生效。`hard/sweep/summary` 新增可选 `emptyProofRef`——指向已反驳假设或模型已清除单元格的可验证引用——而旧的自由文本 `emptyProof` 保留给更旧的日志。


## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-hard-completion-gate
baseline: false
changes:
  - root: "event:hard/gate/decision"
    previous: null
    after: "11dde453fdedbc2b3f5d81c0872f8212ee4c6ef4ad3b5ff3d78b5c6f211204f1"
    decision: same-version
  - root: "event:hard/mission/armed"
    previous: "2026-10-06-hard-coverage-economics"
    after: "5691d737530f411af6eb333e9f8a92d2a13a605dc501603e33e1e9d6654b120f"
    decision: same-version
  - root: "event:hard/sweep/summary"
    previous: "2026-10-04-hard-ledger-events"
    after: "53eefd2160b1a8732740741877d174a72ed34016e7a2641be5fe424ccd55e75a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

纯增量：一个新事件根和既有事件体上的两个可选属性。表面集合、信封与头部不变，每个既有事件的重构不变，Session 格式保持 4，无需迁移。旧日志以扫描的旧版 `emptyProof` 文本读回且没有门决策，恢复中的门前会话保持原义；早于该词汇的旧构建会拒绝新日志而不是误读它，这是仓库内事件的 required-on-read 契约。


<a id="verification"></a>
## 验证

确认后 pnpm run verify-persistence-changes 通过。hard-stopgate 套件通过真实的 update_goal 工具驱动否决的两个分支，hard-ledger 套件验证空扫描引用检查与完成评估阻塞项，keyless recorded-session 快照端到端回放一次 deny-then-allow 的门对。


<a id="dev-note"></a>
## 开发备注

`emptyProof` 字符串在词汇表中保持不变，因此重构是增量的；`recordSweep` 在新记录上拒绝它，所以只有旧日志能携带它。
