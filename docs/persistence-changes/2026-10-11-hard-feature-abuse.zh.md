---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-11-hard-feature-abuse

[English](2026-10-11-hard-feature-abuse.md) | 中文

## 概述

实验性的 hard harness 为功能滥用工作新增五个事件根——hard/feature/pair、hard/feature/pair/resolved、hard/feature/reviewed、hard/guard/declared 与 hard/entry/declared——并在 hard/feature/linked 上新增可选的 source 字段，标明关系由模型还是由 harness 记录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-11-hard-feature-abuse
baseline: false
changes:
  - root: "event:hard/entry/declared"
    previous: null
    after: "54f36275b85fb962e4fa165351038a0507f65691484172f206150c35bb30d6f8"
    decision: same-version
  - root: "event:hard/feature/linked"
    previous: "2026-10-10-hard-feature-map"
    after: "eacde8a049a74e19c6a7f9dfe7189ef2caf5b549b34dd9d18a8dbffda2ed27ed"
    decision: same-version
  - root: "event:hard/feature/pair"
    previous: null
    after: "d666933bbcf615e39a2f7358e416218cf954a44b0038c44217af990b85a8a243"
    decision: same-version
  - root: "event:hard/feature/pair/resolved"
    previous: null
    after: "06b2ac1f171f7cabb3a29fa01df4f084bb1ee5039a8edc6d41dbe39b0a0086c6"
    decision: same-version
  - root: "event:hard/feature/reviewed"
    previous: null
    after: "a4cfcf2c6c262dfcae4a01df5a5c4f6194c97931b6592cfbb8536e8a07b7d9d2"
    decision: same-version
  - root: "event:hard/guard/declared"
    previous: null
    after: "ea5fa056b01f9c556e5580555456691d47cbd59cd06c3f884823f39f6db3cc30"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

五个根均为新增，source 字段为可选，因此现有日志读回不变，没有 source 的关系按模型记录处理。台账投影把新记录折叠进可选状态字段，因此变更前缓存的投影状态无需重建即可继续折叠。Session 格式保持为 4。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/hard-ledger packages/experimental/hard-featuremap：全部测试通过，包括在空状态上折叠守卫差异对、解决记录、审查与声明。

<a id="dev-note"></a>
## 开发备注

无。
