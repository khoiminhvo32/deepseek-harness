---
description: "hard-tools 插件：暴露 hard harness 面向模型的 finding、假设、覆盖与扫描工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-tools

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-tools` 注册 hard harness 的四个面向模型工具：`hard_submit_finding` 携带 CVSS 4.0 向量与 PoC 提交 claim 并返回验证器执行后的结论；`hard_update_hypothesis` 驱动假设生命周期；`hard_mark_coverage` 记录系统化扫描单元；`hard_sweep_summary` 记录完成的扫描过程，空扫描必须携带证明。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

与 hard ledger 和 verifier 一同挂载。

```yaml
- id: hard-tools
  name: '@deepseek-ai/dsh-experimental-hard-tools'
```

四个工具都要求存活代理并返回紧凑 JSON。提交结果携带 `verdict.verdict`、运行次数、重算分数、声称分数是否匹配以及有界的 reason；拒绝以 `HARD_VERIFIER_DUPLICATE` 等稳定代码浮现。生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-hard-tools)是模型收到的确切 schema。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **提交时验证。** `hard_submit_finding` 对 claim（PoC 必须打印的标记）与根因（去重键）做哈希，通过台账提出，然后等待 `hardVerifier.verify` 再作答；模型看到的是执行后的结论，而不是假设。
- **生命周期在台账。** 假设迁移、覆盖单元与扫描都是带响亮失败校验的台账追加；工具只补充 `hypothesis_id` 的假设成员资格检查。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：四个工具的注册、schema 与结果渲染 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas and results

#### What the model sees

The generated [`hard_submit_finding`, `hard_update_hypothesis`, `hard_mark_coverage`, and `hard_sweep_summary` schemas](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-hard-tools). Successful results are compact JSON: the finding's id, claim hash, and fingerprint plus the executed verdict, the new or transitioned hypothesis id and status, the recorded coverage cell, or the recorded sweep summary.

#### Token effect

Fixed schema cost plus one compact result per call; submit results are the largest (finding plus verdict objects).

#### KV Cache effect

Schemas are prefix-stable while their definitions and visibility are unchanged. Calls and results append after the reusable request prefix without invalidating earlier entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **无提示区段** — 方法论引导位于任务契约中；隐藏工具的作用域仍保留部署挂载的区段。
- **尚无权限模型** — 任何存活代理（包括子代理）都可调用这些工具；按作用域的权限将随 hard 组合工作落地。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
