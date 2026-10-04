---
description: "hard-standby 插件：面向 hard 组合，等待终端配额耗尽的窗口关闭，并在重置时刻唤醒任务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-standby

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-standby` 让 hard harness 会话熬过 provider 配额耗尽。当拥有活跃目标的 root agent 遇到终端 `QUOTA` 失败时，插件安排一次唤醒——优先使用 provider 的重置延迟，否则取配置的重置 cron 的下一次匹配，否则等待至上限——把等待记录为持久的 `hard/standby/scheduled` 事件，并让失败的 turn 自然结束。唤醒时刻，它重新武装处于活跃但已解除武装状态的目标，记录 `hard/standby/woke`，并投递续作 follow-up，使任务以有界的节奏恢复，而不是无声停滞。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在 headless hard 组合中与目标服务和 hard mission 一同挂载；stop gate 读取其 `hardStandby` 投影，在等待挂起期间让 turn 干净收场。

```yaml
- id: hard-standby
  name: '@deepseek-ai/dsh-experimental-hard-standby'
  config:
    quotaResetCron: '0 9 * * *'
    maxStandbyHours: 24
```

`enabled: false` 时不挂载任何内容：会话在配额失败时像无管理会话一样结束。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-standby)是每个可接受字段的穷尽来源。

唤醒时刻按固定顺序解析：adapter 报告了 provider 的 `Retry-After` 延迟时以其为准；否则取 `quotaResetCron`（五段 Vixie 格式，按 UTC、分钟粒度求值）的下一次匹配作为窗口；否则等待至 `maxStandbyHours`。每次等待都以 `maxStandbyHours` 为上限；当两个来源都不给出重置时间时，上限同时充当重试节奏，让无管理的配额中断以有界节奏重试，而不是无声停滞。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **瀑布观察者，从不重试。** `agent/request-error` 监听器只做调度：记录 standby 事件、武装唤醒计时器，并始终调用 `next()`，让失败保持终端。短暂抖动仍归重试策略管。
- **持久状态机。** `hardStandby` 会话投影把 `hard/standby/scheduled` 折叠为挂起的等待，把 `hard/standby/woke` 折叠回空闲；框架在恢复时重建投影，因此等待中途重启的会话会在 agent 以 `resume` 源重建时重新武装剩余等待。
- **投递尊重目标权威。** 唤醒时，活跃且已武装的目标直接收到 follow-up；活跃但已解除武装的目标先经目标服务 resume。paused、blocked、complete 的目标绝不被复活——只有活跃阶段会继续；到达轮次上限的目标保持解除武装并记录跳过原因。
- **有界计时器。** 超过单个 `setTimeout` 上限的等待按上限链式分段；agent 释放会取消计时器，插件卸载会取消所有挂起的唤醒。

### Source map

| File | Role |
|---|---|
| [`src/domain.ts`](src/domain.ts) | 两个 `hard/standby/*` 事件的 `SessionEventMap` 合并 |
| [`src/cron.ts`](src/cron.ts) | 五段 UTC cron 解析与下一次匹配运算 |
| [`src/wake.ts`](src/wake.ts) | 纯唤醒时刻解析：provider 延迟、cron 窗口、上限 |
| [`src/projection.ts`](src/projection.ts) | 会话投影单元：纯折叠、状态 schema、定义 |
| [`src/index.ts`](src/index.ts) | 插件：配额监听、唤醒计时器、投递决策 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Follow-up messages

#### What the model sees

每次唤醒投递一条续作指令，以 `hard-standby` 源的 user 消息到达：造成等待的 provider 代码、读取持久台账状态的指令，以及继续具体任务工作、不要等待或请示的要求。scheduled 与 woke 记录本身是不含请求内容的持久日志事件。

#### Token effect

每个唤醒周期一条有界消息；没有常驻提示成本。

#### KV Cache effect

该消息追加在可复用请求前缀之后，不会使更早的条目失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **进程内等待** — 唤醒计时器存在于 Host 进程内；等待中途退出的进程依赖持久的 `scheduled` 记录和其后的 `resume` 重新武装。在配额窗口之间完全停止的长驻组合不会自行启动。
- **仅配额族** — 只有 `QUOTA` 与 `ACCOUNT_QUOTA` 会安排等待；`outage` 是保留词汇，直到 provider 级故障类有自己的触发条件。
- **仅 UTC cron** — `quotaResetCron` 不支持时区；依赖时区重置窗口的地区需要在表达式中写死偏移。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
