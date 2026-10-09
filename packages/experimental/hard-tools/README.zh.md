---
description: "hard-tools 插件：暴露 hard harness 面向模型的 finding、假设、覆盖与扫描工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-tools

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-tools` 注册 hard harness 的九个面向模型工具：`hard_submit_finding` 返回验证器的执行结论；`hard_update_hypothesis` 驱动假设，包括链接弱点与已确认 finding 的链；`hard_record_flaw` 记录一个弱点及其给予与需要的东西；`hard_record_flow` 记录模块的 flow 文档；`hard_mark_coverage` 与 `hard_mark_module` 记录覆盖单元，后者一次读取记录多个类别；`hard_clear_modules` 在一个只能拒绝的 grep 背后批量筛查一个类别；`hard_sweep_summary` 记录一次扫描；`hard_status` 回读棋盘、剩余工作与串联素材。每个被引用的位置都先在钉住提交处解析。

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
  config:
    maxCitedRangeLines: 300
    minClearedFiles: 3
```

这两个字段规定 `hard_mark_coverage` 与 `hard_mark_module` 中已清除的模块级单元必须携带的证据：任何声明位置引用的行数都不能超过 `maxCitedRangeLines`，且这些位置必须落在该模块至少 `minClearedFiles` 个不同文件中；当模块在被钉住的提交处的文件更少时，必须覆盖每个文件。两个工具的描述都会写明所配置的值，不满足要求的清除会在记录任何内容之前以 `HARD_TOOLS_CLEAR_EVIDENCE` 被拒绝。

九个工具都要求存活代理并返回紧凑 JSON。提交结果携带 `verdict.verdict`、运行次数、重算分数、声称分数是否匹配以及有界的 reason；拒绝以 `HARD_VERIFIER_DUPLICATE` 等稳定代码浮现；因根因重复或向量无法解析而被拒绝的提交不会记录任何提案。生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-hard-tools)是模型收到的确切 schema。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **提交时验证。** `hard_submit_finding` 对 claim（PoC 必须打印的标记）与根因（去重键）做哈希，通过台账提出，然后等待 `hardVerifier.verify` 再作答；模型看到的是执行后的结论，而不是假设。工具描述传授 specificity 契约：从 `$1` 读取 payload、绝不硬编码，因为 harness 会用良性载荷重跑 PoC 并要求其失败。
- **生命周期在台账。** 假设迁移、覆盖单元与扫描都是带响亮失败校验的台账追加；工具只补充 `hypothesis_id` 的假设成员资格检查。`cleared` 判定必须以 `path:symbol`、`path:line` 或 `path:start-end` 引用所检查的代码；`hard_mark_coverage` 在记录之前于被固定的提交上解析每个位置，并在拒绝清除时点名每个不存在的位置。它也拒绝非武装矩阵行的模块并点名有效行，也拒绝在筛查早已裁决的惰性模块上给出 `cleared`（`suspicious` 仍可记录）；harness 重开或 fail-closed 审计给其单元显式标注 `source: 'harness'`，报告因此不会把模型自己给出的 `suspicious` 判定读作投机。`hard_clear_modules` 在任何模块越界、惰性或不可筛查时于任何 grep 之前拒绝整批——不可筛查模块含二进制，或固定模式表并非为其语言编写，在那里 grep 什么也证明不了。`logic` 清除必须声明至少两个位置，每个位置后附一条说明其所维护不变量的备注，因为没有 sink 模式能筛查业务逻辑缺陷。

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

The generated [`hard_submit_finding`, `hard_update_hypothesis`, `hard_record_flaw`, `hard_record_flow`, `hard_mark_coverage`, `hard_mark_module`, `hard_clear_modules`, `hard_sweep_summary`, and `hard_status` schemas](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-hard-tools). Successful results are compact JSON: the finding's id, claim hash, and fingerprint plus the executed verdict, the new or transitioned hypothesis id and status, the recorded flow document (or the rejected citations naming every failed cite), the recorded coverage cell, the batch clear's cleared-cell list (or the grep evidence that blocked it), the recorded sweep summary, or a status view: per-kind open-work counts, the gate, and the matrix axes — counts, never a ratio, so no progress number invites clearing for its own sake — a page of board cells with the total that matched, or a page of the open-work list.

#### Token effect

Fixed schema cost plus one compact result per call; submit results and full `hard_status` pages are the largest, and a status page is held at 200 entries.

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
