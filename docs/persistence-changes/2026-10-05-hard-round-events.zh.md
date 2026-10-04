---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-05-hard-round-events

[English](2026-10-05-hard-round-events.md) | 中文

## 概述

实验性 hard-rounds 插件新增两个增量的 hard/round/* 会话事件——hard/round/start 与 hard/round/end——记录 hard 任务的轮次账目（被接纳的轮次及其 A/B 轮换阶段与未完成工作计数，以及收尾 turn 的步数与结束原因）。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-hard-round-events
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-05-hard-standby-handoff-persistence"
    after: "77f83914f9fe917b255099fd191f39b898cd9231b02612a5a7b1fa2bc04ecf1d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-hard-standby-handoff-persistence"
    after: "c804ffb892a79ccdda0153e8cd32f3d9cfb32f57729d2d8c4f838408f3ad42b8"
    decision: same-version
  - root: "event:hard/round/end"
    previous: null
    after: "9c8583a2e073f7ddb70f3ae373b1916e1c75f9c7e338078bd09b3a59df203cfc"
    decision: same-version
  - root: "event:hard/round/start"
    previous: null
    after: "ccbb541cf9d9b06d32fe9bbad9ec4a1a1d8345cae91e4a0a4aef7321b51d499c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-05-hard-standby-handoff-persistence"
    after: "cbc1bf21e03adafde104933b2b523b6858f20b71406c601b9bdfe428a5ec93cb"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-hard-standby-handoff-persistence"
    after: "1fafc3d9d02d3a8252d106de4dfa6be3fc1b9d8d800b68f83d70244ab88689ba"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

纯增量事件 root：表面集合、信封与头均不变，任何既有事件形态不变，因此所有先前事件的重建不受影响，Session 格式保持 4、无需迁移。早于该词汇表的构建会拒绝此类日志而非误读，这正是仓库内事件要求的读取契约。

<a id="verification"></a>
## 验证

确认后 pnpm run verify-persistence-changes 通过；hard-rounds 套件为每个被接纳的 goal 轮次记录 start、在每轮步数预算处取消，并为每个收尾 turn 记录 end。

<a id="dev-note"></a>
## 开发备注

无。
