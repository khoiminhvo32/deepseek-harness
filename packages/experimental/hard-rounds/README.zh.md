---
description: "hard-rounds 插件：面向 hard 组合，记录轮次账目、注入轮次上下文，并执行每轮步数预算。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-rounds

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-rounds` 在随附的 goal-round driver 之上叠加 hard 任务层。driver 拥有预约、修订围栏与轮次上限；本插件观察每个被接纳的 goal 轮次，记录携带 A/B 轮换阶段与台账未完成工作计数的持久 `hard/round/start`，注入命名阶段指令、未完成工作——以及在没有未完成工作时——完成门剩余阻塞项的 `<hard_round n/max>` 上下文，在 `stepsPerRound` 预算处取消 turn，并在轮次的 turn 收尾时记录 `hard/round/end`。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

与 goal 服务、hard ledger 以及 `@deepseek-ai/dsh-goal-round-driver` 一同挂载；没有 driver 就没有被接纳的 goal 轮次，本插件保持休眠。

```yaml
- id: goal-round-driver
  name: '@deepseek-ai/dsh-goal-round-driver'

- id: hard-rounds
  name: '@deepseek-ai/dsh-experimental-hard-rounds'
  config:
    stepsPerRound: 200
    deepReadEveryN: 3
    emptySweepsToFinish: 2
```

`deepReadEveryN` 轮换方法论阶段：每 `deepReadEveryN` 个 Phase A 轮次之后是一个 Phase B 深读轮次。保持它与 mission 的 `deepReadEveryN` 相等；两者分开存放是为了让驱动无需读取其他插件的配置即可轮换，但取值分叉会产生分叉的节奏。`emptySweepsToFinish` 在没有未完成工作时渲染完成门的剩余阻塞项；出于同样原因，保持它与 stopgate 的 `emptySweepsToFinish` 相等。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-rounds)是每个可接受字段的穷尽来源。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **驱动而非分叉。** 预约、修订围栏、轮次计数与上限阻塞路径都属于随附的 goal-round driver；本模块只观察 driver 已经产生的事件，两者在接纳语义上不会分叉。
- **延迟追加。** 提交后的追加流禁止重入追加，因此轮次 start 记录与其上下文注入在被接纳消息提交一个微任务之后落地。
- **确定性轮换。** Phase B 落在能被 `deepReadEveryN + 1` 整除的轮次上，仅由被接纳的轮次号计算。
- **有界 turn。** 步数账目读取该轮 turn 的 `step/start` 事件；达到 `stepsPerRound` 时以 `hook` 原因取消 turn，轮次 end 记录 `step-cap`。

### Source map

| File | Role |
|---|---|
| [`src/domain.ts`](src/domain.ts) | 两个 `hard/round/*` 事件的 `SessionEventMap` 合并 |
| [`src/index.ts`](src/index.ts) | 插件：轮次观察、上下文注入、步数上限 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Injected context

#### What the model sees

每个被接纳的轮次一条 `hard-round` 源的 user 消息：`<hard_round n/max>` 头、该阶段的指令（Phase A 为系统性 source-to-sink 扫描，Phase B 为深读 pass）、台账的有界未完成工作列表，以及用 hard 工具记录进度的要求。

#### Token effect

每轮一条有界消息；没有常驻提示成本。

#### KV Cache effect

注入追加在可复用请求前缀之后，不会使更早的条目失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **需要 driver** — 本模块只观察被接纳的 goal 轮次；单独挂载时它不记录任何内容，这是刻意设计而非疏漏。
- **每会话一轮** — 轮次是串行的；一轮未收尾时第二个被接纳的轮次会被忽略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
