---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-05-hard-standby-handoff-persistence

[English](2026-10-05-hard-standby-handoff-persistence.md) | 中文

## 概述

实验性 hard-standby 插件新增两个增量的 hard/standby/* 会话事件——hard/standby/scheduled 与 hard/standby/woke——记录 hard harness 的配额等待状态机。hard-standby 与 hard-handoff 插件各声明一个仅归因的消息源类别 hard-standby 与 hard-handoff，分别盖在唤醒 follow-up 与 compaction 后注入上；这两个类别加入持久的 user/message、developer/message、agent/inbox/spliced 与 session/title-llm-request 源联合。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-hard-standby-handoff-persistence
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-04-hard-stopgate-attribution"
    after: "e82c3ea05bb0a7449de663ffdb258f0beb44c7291cd4e6117eb265ee5e40b904"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-04-hard-stopgate-attribution"
    after: "7bff3ac57ee262157f317b381269d4eeda35c52a89be0c6dc3383f29caf581b1"
    decision: same-version
  - root: "event:hard/standby/scheduled"
    previous: null
    after: "7bdf6fa6739c693b9467a46c74c303e1e231172f435cf493cb1a237cd8625d8f"
    decision: same-version
  - root: "event:hard/standby/woke"
    previous: null
    after: "a180010d63e5be8421eefcf892a98765b38ebc3471a14d1e41b02d502b377343"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-04-hard-stopgate-attribution"
    after: "d41dd98dfa6872df60fd9b893d3ec18e696e4d624ecabdc50c357be8047f8fe0"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-04-hard-stopgate-attribution"
    after: "e498c1aab48e96a0196f463e46215b5574e9331eb361794b4d74e1f7fb22f027"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

纯增量：两个事件 root 是新的日志记录，无表面、信封或头变化；两个消息源类别在字面判别值之外不携带任何负载，因此旧读取器在既定的会话源归因策略下会原样保留携带它们的消息而无视生产者，新读取器也接受缺少这些类别的日志。任何既有事件形态不变，所有先前事件的重建不受影响，Session 格式保持 4、无需迁移。早于该词汇表的构建会拒绝此类日志而非误读，这正是仓库内事件要求的读取契约。

<a id="verification"></a>
## 验证

确认后 pnpm run verify-persistence-changes 通过；hard-standby 套件安排等待、经 hardStandby 投影折叠并以 hard-standby 源 follow-up 唤醒，hard-handoff 套件在成功的 compaction 收尾后注入 hard-handoff 源摘要，失败的收尾不注入。

<a id="dev-note"></a>
## 开发备注

无。
