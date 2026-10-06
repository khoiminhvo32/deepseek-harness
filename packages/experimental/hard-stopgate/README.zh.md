---
description: "hard-stopgate 插件：面向必须让已武装目标的会话持续工作、而非在第一个回合边界就停下，且完成裁决属于 harness 本身的部署。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-stopgate

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-stopgate` 监听 `agent/turn-stopping` 边界：只要有一个已武装且活跃的目标仍然成立，任何试图提前关闭的回合都会收到一条点名列出台账未完成工作的转向续作指令。它同时拥有完成裁决权：对已武装目标的 `update_goal action complete` 尝试会运行 hard-ledger 的完成评估，在工作未清时以确切的剩余工作为由拒绝，并且每一次决策都会以 `hard/gate/decision` 事件落盘。无目标、已解除武装、暂停、受阻与已完成的状态可以自由关闭，并且每回合的预算会限制强制续作的次数，使无法推进目标的模型不能永远占住该回合。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

当任务目标下的回合必须持续到 harness 认证完成时（例如 hard-bundle 组合），将该插件与目标服务和 hard 台账一同挂载。它通过 `ctx.goals` 读取目标状态、通过 `ctx.hardLedger` 读取未完成工作与完成评估、通过事件负载中的代理进行转向；不注册任何工具，也不注册提示区段。

```yaml
- id: hard-stopgate
  name: '@deepseek-ai/dsh-experimental-hard-stopgate'
  config:
    maxSteersPerTurn: 16
```

`maxSteersPerTurn` 必须是正安全整数。评估读取的末尾空扫描阈值位于 hard 台账的 `emptySweepsToFinish`，因此停止门、round 上下文与任何其他消费方都从同一配置取值。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-stopgate)是全部受支持字段的唯一权威来源。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **转向即阻止。** 串行的 `agent/turn-stopping` 监听器读取当前目标与台账的未完成工作；已武装且活跃的目标存在未完成工作时，停止门调用 `agent.steer(...)` 发送点名剩余项的续作指令，从而让循环观察到待处理输入并再运行一步。没有未完成工作时回合自由关闭——完成是门的决定，不是一条转向指令。计数器在插件卸载与 `agent/disposed` 时清除。
- **完成是否决权。** `tools/pre-execute` 瀑布监听器把 `update_goal` 参数收窄到 `action complete`，比对武装记录携带的目标 id，再向台账索取评估。拒绝时把阻塞项列表转成一条祈使指令且绝不运行工具体；目标工具仍是唯一写入方。转向保持在回合边界，因此拒绝永远不会双重转向。
- **每次决策都落盘。** 两个分支都追加一条 `hard/gate/decision` 事件，含覆盖、假设与发现计数、末尾空扫描连击和阻塞项，因此不存在没有记录评估的完成。
- **有界的失控。** 停止门按代理统计强制续作次数，并在回合号推进时重置。预算耗尽后回合关闭；由目标回合驱动器或用户开启下一回合。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、完成否决及其决策记录、欠账目标判定、续作指令、回合停止监听器 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Steering messages

#### What the model sees

每次强制续作在停止边界发送一条转向消息。目标、回合编号与未完成工作项从当前目标与台账插值；下面的渲染示例使用目标 `find the deserialization bug`、第 0 回合、上限 9，以及一个未判定覆盖单元格。

##### Continuation order

```markdown
The session objective is not complete: "find the deserialization bug". Goal round 0 of 9. Open work: 1 coverage cell(s) have no verdict yet; cell src × cmdi has no verdict. Resolve the next item now; do not stop or summarize. The harness owns completion: update_goal action complete is denied while this list is non-empty.
```

#### Token effect

仅在已武装活跃目标下试图关闭的回合中，每次强制续作产生一条短消息。

#### KV Cache effect

追加在可复用请求前缀之后，不使更早的条目失效；预算限制了每回合的追加量。

### Completion denial

#### What the model sees

过早的 `update_goal action complete` 以工具错误失败，消息点名确切的剩余工作，后接解决后重试的祈使指令：

##### Denial reason

```markdown
The mission is not complete. 1 coverage cell(s) have no verdict yet; cell src × cmdi has no verdict. Resolve these, then mark the goal complete.
```

#### Token effect

每次被拒绝的完成尝试产生一条工具错误结果；模型把它作为普通失败内容读回。

#### KV Cache effect

形状与任何失败的工具结果相同；拒绝理由被它报告的未完成工作列表限定。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **转向是建议性压力** — 循环会重读收件箱，无法推进目标的模型会耗尽预算后关闭回合；停止门不能强制边界保持敞开。
- **完成读取台账而非目标仓库** — 评估信任日志中记录的覆盖判定与扫描证明，不会在门时刻重新验证它们。
- **完成路径依赖目标工具** — 否决以 `update_goal` 工具名和 `complete` 操作为键；未挂载 `dsh-tool-goal` 的组合必须由其他消费方提供该操作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
