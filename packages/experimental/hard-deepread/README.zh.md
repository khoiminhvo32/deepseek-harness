---
description: "hard-deepread 插件：面向 hard 组合，拥有 Phase B 深读契约：flow 文档、子代理扇出与假设记录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-deepread

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-deepread` 以 `hard:deep-read` 系统提示节的形式拥有 hard 任务的 Phase B 契约。当轮次命名 phase B 时，该节指引模型按模块或模块簇扇出子代理（每次 pass 有上限），要求一份结构化 flow 文档——入口、数据流、信任边界、状态机、假设、可疑怪癖——将其保存到 `.dsh-hard/flow/<module>.md`，并把每个怪癖作为带具体证伪步骤的台账假设记录下来。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在 hard 组合中与 hard mission 和 ledger 工具一同挂载；该节补充 mission 契约中的轮换规则。

```yaml
- id: hard-deepread
  name: '@deepseek-ai/dsh-experimental-hard-deepread'
  config:
    maxModulesPerPass: 6
```

`maxModulesPerPass` 限制一次深读 pass 可扇出的模块数。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-deepread)是每个可接受字段的穷尽来源。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **指引而非机制。** 插件只注册一个静态系统提示节；扇出本身经由随附的 `subagent` 工具运行，结果经由 hard ledger 工具落地，因此不存在需要信任的新执行路径。
- **结构化文档。** flow 文档的分节是固定协议：入口、数据流、信任边界、状态机、假设、可疑怪癖——这正是 Phase A 模式扫描产不出的形状。
- **证据纪律。** 假设按 `proposed → testing` 推进并携带具体证伪步骤；没有执行证据的确认超出契约，无怪癖的 pass 仍通过 `hard_sweep_summary` 携带 `emptyProof` 记录进度。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件：深读契约节与扇出上限 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

固定的 Phase B 契约：每次 pass 最多读 `maxModulesPerPass` 个模块，每模块一个子代理并要求六节 flow 文档，文档保存为 `.dsh-hard/flow/<module>.md`，怪癖经 `hard_update_hypothesis` 记录为假设，存活下来的怪癖转为带真实 PoC 的 finding，无怪癖的 pass 以 `hard_sweep_summary` phase B 加 `emptyProof` 收尾。

##### Deep-read policy

```markdown
Deep-reading pass (Phase B): when a round names phase B, read 6 module or module-cluster at a time for understanding rather than pattern matching. For each module, spawn one subagent whose prompt demands a structured flow document with exactly these sections: entry points; dataflow; trust boundaries; state machines; assumptions; suspicious quirks. Save each document as .dsh-hard/flow/<module>.md and cite it later by path. Record every suspicious quirk as a hypothesis with hard_update_hypothesis: status proposed first, then testing with a concrete falsification step; never mark confirmed without executed evidence. Quirks that survive testing convert into findings submitted with hard_submit_finding and a real PoC. A deep-reading pass with no quirks found still records its progress: summarize the pass with hard_sweep_summary phase B and an emptyProof naming the modules read and the assumptions checked.
```

#### Token effect

在本插件的提示注册可见的每个请求上有少量固定输入成本。

#### KV Cache effect

在插件作用域与配置上限不变时前缀稳定；激活、卸载或配置变更可能使该提示节的复用失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **子代理质量是模型判断** — 契约命名了文档分节但无法强制其深度；台账的假设生命周期才是强制点。
- **flow 文档是文件工件** — 文档位于 `.dsh-hard/flow/` 下并以路径引用；只有台账记录是持久的会话事件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
