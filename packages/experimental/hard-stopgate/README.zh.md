---
description: "hard-stopgate 插件：面向必须让已武装目标的会话持续工作、而非在第一个回合边界就停下的部署。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-stopgate

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-stopgate` 监听 `agent/turn-stopping` 边界：只要有一个已武装且活跃的目标仍然成立，任何试图提前关闭的回合都会收到一条转向续作指令。无目标、已解除武装、暂停、受阻与已完成的状态可以自由关闭，并且每回合的预算会限制强制续作的次数，使无法推进目标的模型不能永远占住该回合。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

当任务目标下的回合必须持续到目标真正完成时（例如 hard-bundle 组合），将该插件与目标服务一同挂载。它通过 `ctx.goals` 读取目标状态、通过事件负载中的代理进行转向；不注册任何工具，也不注册提示区段。

```yaml
- id: hard-stopgate
  name: '@deepseek-ai/dsh-experimental-hard-stopgate'
  config:
    maxSteersPerTurn: 16
```

`maxSteersPerTurn` 必须是正安全整数。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-stopgate)是全部受支持字段的唯一权威来源。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **转向即阻止。** 串行的 `agent/turn-stopping` 监听器读取当前目标；已武装且活跃的目标使停止门调用 `agent.steer(...)` 发送续作指令，从而让循环观察到待处理输入并再运行一步。不转向直接返回即是放行——不存在单独的否决。
- **有界的失控。** 停止门按代理统计强制续作次数，并在回合号推进时重置。预算耗尽后回合关闭；由目标回合驱动器或用户开启下一回合。计数器在插件卸载与 `agent/disposed` 时清除。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、欠账目标判定、续作指令、回合停止监听器 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Steering messages

#### What the model sees

每次强制续作在停止边界发送一条转向消息。目标与回合编号从当前目标插值；下面的渲染示例使用目标 `find the deserialization bug`、第 0 回合、上限 9。

##### Continuation order

```markdown
The session objective is not complete: "find the deserialization bug". Goal round 0 of 9. Do not stop or summarize; take the next concrete action that advances the objective now. End the turn only after marking the goal complete with update_goal action complete once the objective is genuinely achieved.
```

#### Token effect

仅在已武装活跃目标下试图关闭的回合中，每次强制续作产生一条短消息。

#### KV Cache effect

追加在可复用请求前缀之后，不使更早的条目失效；预算限制了每回合的追加量。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **转向是建议性压力** — 循环会重读收件箱，无法推进目标的模型会耗尽预算后关闭回合；停止门不能强制边界保持敞开。
- **仅读取目标状态** — 停止门尚未读取 findings 台账，因此活跃目标内未验证的工作不会阻止关闭；对未完成工作的感知将随 hard 验证器加入。
- **完成路径依赖目标工具** — 指令指名 `update_goal action complete`；未挂载 `dsh-tool-goal` 的组合必须由其他消费方提供该操作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
