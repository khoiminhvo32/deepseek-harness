---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-10-hard-feature-map

[English](2026-10-10-hard-feature-map.md) | 中文

## 概述

为 hard harness 功能地图新增 hard/featuremap/indexed、hard/feature/recorded 与 hard/feature/linked 事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-10-hard-feature-map
baseline: false
changes:
  - root: "event:hard/feature/linked"
    previous: null
    after: "cd4908c1207d6767117f4e09395408db86f453a0cbc398f9ee0593191f876c7a"
    decision: same-version
  - root: "event:hard/feature/recorded"
    previous: null
    after: "013a116aceedf81d16bc6c243418a0fde01180a6786d15002f1e34ce6053e92e"
    decision: same-version
  - root: "event:hard/featuremap/indexed"
    previous: null
    after: "23081f7f97e4b4c163aac9698255273e730dd41afc0dfb6be87815326252efce"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

三项变更都是新的事件根。已有日志不含其中任何一项，读回结果不变：没有已索引的功能地图时，台账不要求任何入口点；没有功能记录时，台账不含任何功能。台账投影把新记录折叠进可选状态字段，因此变更之前缓存的投影状态无需重建即可继续折叠。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/hard-ledger packages/experimental/hard-tools：全部测试通过，包括把功能地图记录折叠到早于它们的缓存状态上。

<a id="dev-note"></a>
## 开发备注

无。
