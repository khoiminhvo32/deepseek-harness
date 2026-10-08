---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-08-hard-weakness-chains

[English](2026-10-08-hard-weakness-chains.md) | 中文

## 概述

新增用于把弱点保留为串联素材的 hard/flaw/recorded 事件，为 hard/hypothesis/state 增加可选的链接字段，并为 hard/round/start 增加可选的串联标记。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-hard-weakness-chains
baseline: false
changes:
  - root: "event:hard/flaw/recorded"
    previous: null
    after: "883e93df3e09e9bced9ebd4b2b89c040643b9b2a5d1ee6e7d207e44873eeaf6a"
    decision: same-version
  - root: "event:hard/hypothesis/state"
    previous: "2026-10-04-hard-ledger-events"
    after: "11064b683a0aa59bf53f2f29e2ae178888f8a6b14989eed85879d6cc8d23cd69"
    decision: same-version
  - root: "event:hard/round/start"
    previous: "2026-10-05-hard-round-events"
    after: "3454a1b61bdcf0c0a266f4f3ab44447a25194f021d8f10053794bf01095d80a2"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

三项变更都是增量的。已有日志不含弱点记录、链接或串联标记，读回时保持不变：不带链接的假设是普通假设，不带标记的轮次开始记录运行的是其 A/B 槽位。台账投影把弱点折叠进可选状态字段，因此变更之前缓存的投影状态无需重建即可继续折叠。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/hard-ledger packages/experimental/hard-tools packages/experimental/hard-rounds：全部测试通过，包括把弱点记录折叠到早于它的缓存状态上。

<a id="dev-note"></a>
## 开发备注

无。
