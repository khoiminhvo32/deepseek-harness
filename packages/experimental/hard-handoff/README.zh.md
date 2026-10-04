---
description: "hard-handoff 插件：面向 hard 组合，在每次成功 compaction 后注入持久台账摘要。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-handoff

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-handoff` 桥接 compaction 与 hard 任务。当一次成功的 `compaction/end` 落地时，插件注入一份确定性的状态摘要——由 hard 台账折叠与当前目标视图组装：按结论统计的 findings、未决假设、覆盖单元计数与未完成工作列表——让模型带着持久事实恢复，而不是只有一份光秃秃的 compaction 摘要。失败的 compaction 不注入任何内容。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在 hard 组合中与 hard ledger 和目标服务一同挂载；它读取 `ctx.hardLedger` 与 `ctx.goals`，并向被压缩会话的活跃 agent 注入。

```yaml
- id: hard-handoff
  name: '@deepseek-ai/dsh-experimental-hard-handoff'
  config:
    maxItems: 32
```

`maxItems` 限制每份摘要列出的未完成工作条数；超出上限时摘要只陈述剩余数量而不列出条目。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-handoff)是每个可接受字段的穷尽来源。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **仅日志派生。** 摘要读取台账投影与目标服务；从不读文件、也从不重扫日志，因此注入文本可从会话事件重建，相同台账状态产生相同文本。
- **只认成功的收尾。** 携带 `error` 字段的 `compaction/end` 不注入；注入落在 compaction 标记对之间，这正是 compaction 契约明确支持的位置。
- **构造即有界。** 列出条目上限 `maxItems` 并陈述剩余数量，每条文本上限 240 字符，单条长主张无法主导摘要。

### Source map

| File | Role |
|---|---|
| [`src/message.ts`](src/message.ts) | 纯确定性 handoff 构建器 |
| [`src/index.ts`](src/index.ts) | 插件：compaction 收尾观察与注入 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Injected context

#### What the model sees

每次成功 compaction 后一条 `hard-handoff` 源的 user 消息：任务行（目标、阶段、武装状态、轮次）、按结论计数的 findings、未决与已决假设、按结论计数的覆盖单元、有界的未完成工作列表，以及"继续下一个具体动作"的指令。

#### Token effect

每次 compaction 一条有界消息；没有常驻提示成本。

#### KV Cache effect

注入追加在可复用请求前缀之后，不会使更早的条目失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **仅台账状态** — 摘要携带台账与目标状态；`.dsh-hard/` 下的 flow doc 仍是文件工件，由后续轮次引用，不内联。
- **需要活跃 agent** — 没有活跃 agent 的会话 compaction 不注入；注入属于运行中组合的下一次请求。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
