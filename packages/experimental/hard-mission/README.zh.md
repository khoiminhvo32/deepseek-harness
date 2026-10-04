---
description: "hard-mission 插件：面向以单一长期目标持续运转的部署，会话必须不断向该目标推进。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-mission

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-mission` 将配置的目标武装为持久的会话目标，并注册 `hard:mission` 系统提示区段来传达任务契约：跨回合持续推进、交替执行系统化扫描与深度阅读两类过程、且只能通过目标工具声明完成。它仅在 `startup` 时为全新根代理武装目标；恢复、清除、压缩与子代理的既有目标状态不受影响。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

当部署拥有一个长期目标（例如对固定目标仓库的持续漏洞研究）时，将该插件与目标服务一同挂载。目标必须显式配置；空白目标会使加载失败。

```yaml
- id: hard-mission
  name: '@deepseek-ai/dsh-experimental-hard-mission'
  config:
    objective: 'Find and verify every authentication bypass in the target repository'
    maxGoalRounds: 64
    deepReadEveryN: 3
```

`bugClasses` 默认为具有机械 source-to-sink 语义的全部 OWASP Top 10 类别清单（sqli、xss、cmdi、path-traversal、open-redirect、deserialization、ssrf、authn、authn-bypass、login-bypass、oauth-bypass、session、authz、crypto-misuse、misconfig、dependencies、race）；空列表会从契约中移除类别清单。不安全设计与安全日志没有机械的 source-sink 对，保留在深度阅读过程。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-mission)是全部受支持字段的唯一权威来源。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **创建时武装。** 插件监听 `agent/created`，仅当来源为 `startup`、该代理是注册表根代理且当前没有目标时，才通过 `ctx.goals.create` 武装目标。其他来源、子代理与既有目标一律不动，目标服务对持久会话的恢复并解除武装策略保持权威。
- **单一契约区段。** `hard:mission` 区段从解析后的配置渲染目标、系统化扫描类别清单与深度阅读节奏。它是静态文本：仅当部署配置变化时才会变化。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、契约渲染、区段注册、启动时武装 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

一个固定的任务契约，其目标、漏洞类别清单与深度阅读节奏从部署配置插值而来。下面的渲染示例使用配置目标 `Find and verify every authentication bypass`、默认类别清单与默认节奏。

##### Mission contract

```markdown
Mission: Find and verify every authentication bypass
This session carries one durable goal and keeps working toward it across turns. Do not stop to announce progress while concrete work remains; take the next action instead. Systematic passes sweep these bug classes: sqli, xss, cmdi, path-traversal, open-redirect, deserialization, ssrf, authn, authn-bypass, login-bypass, oauth-bypass, session, authz, crypto-misuse, misconfig, dependencies, race. Every 3 systematic passes, run a deep-reading pass that models dataflow, trust boundaries, and state machines to form and test hypotheses beyond pattern matching. Declare completion only with update_goal action complete once the objective is genuinely achieved; ending a turn does not end the mission.
```

#### Token effect

在该区段注册可见的每个请求上产生少量固定输入开销。

#### KV Cache effect

在插件作用域与配置不变时保持前缀稳定。激活、卸载或配置变化可能使该提示区段的复用失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **仅在启动时武装** — 恢复或清除后的会话保留目标服务恢复的（已解除武装的）目标；恢复与配额待机唤醒时的自动重新武装属于 hard-standby 插件。
- **完成路径依赖目标工具** — 契约指名 `update_goal action complete`；未挂载 `dsh-tool-goal` 的组合必须由其他消费方提供该操作。
- **无完成评估器** — 本插件只负责武装与引导；完成认证推迟到 hard 停止门与验证器包。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
