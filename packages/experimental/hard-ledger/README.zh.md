---
description: "hard-ledger 插件：面向 hard 组合，把 findings、假设、覆盖与扫描状态记录为持久会话事件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-ledger

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-ledger` 拥有 hard harness 的持久方法论状态：增量 `hard/*` 会话事件（finding 提案与验证器结论、假设生命周期、覆盖单元、扫描摘要，以及任务武装记录），以及负责校验、追加并折叠这些事件的 `ctx.hardLedger` 服务。会话日志是唯一存储；id 从日志分配，所有折叠都从日志派生。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在 hard 组合中与目标服务一同挂载；hard 工具与验证器依赖其服务和事件类型。

```yaml
- id: hard-ledger
  name: '@deepseek-ai/dsh-experimental-hard-ledger'
```

服务键为 `hardLedger`。追加侧辅助函数以稳定的 `HARD_LEDGER_*` 代码响亮失败：空白文本、非 CVSS:4.0 向量、越界分数、畸形哈希、无 sink 佐证的 `cleared` 单元、无证明的空扫描，全部在事件提交前被拒绝。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **日志派生状态。** `findings`、`hypotheses`、`coverage`、`sweepCount`、`coverageMatrix` 与 `openWork` 读取 `hardLedger` 会话投影——对 `hard/*` 事件的纯折叠，框架在恢复时重建并随每次提交增量推进；没有并行存储，日志保持唯一事实来源，fork/重启行为天然跟随会话。
- **从日志分配顺序 id。** `F-<n>` 与 `H-<n>` 计数器统计各自类型的历史事件；假设迁移会对照日志中已存在的 id 校验成员资格。
- **增量事件，无需格式升级。** 这些事件都是纯增量 root：无表面、信封或头变化，任何既有事件形态不变，因此词汇增长无需格式升级。早于该词汇表的构建会拒绝此类日志而非误读，这正是仓库内事件要求的读取契约。
- **有界文本。** 自由文本字段上限 2000 字符；`refuted` 与 `deferred` 假设的 reason 字段为必填。
- **完成评估与可验证空扫描。** `completionAssessment(agent, emptySweepsToFinish)` 纯粹从台账状态认证完成——没有未完成工作、末尾连续的空验证扫描、以及至少一个模型审读过的覆盖单元格或已解决的假设；它绝不统计发现数量，因为发现配额会诱导捏造。空扫描必须引用 `emptyProofRef`——台账已折叠为 `refuted` 的假设，或最新判定为 `cleared`、带已声明 sink 且来源不是 `harness` 的单元格（机器筛查无法证明扫描确实做了）——Phase B 也可以引用 `emptyProofFlowDoc`：其已记录的 `hard/flow/doc` 带至少一条已解析引用的模块。两个字段互斥。服务还提供 `recordFlowDoc`——校验器在对照钉住的提交解析每条引用之后记录的持久 flow 文档摘要——并通过 `flowDocs` 读回。记录时校验以稳定代码响亮失败，因此日志只保存记录时刻为真的证明。`emptySweepRun` 统计末尾连击，`armedGoalId` 给出门所依据的目标命名。
- **来自武装记录的覆盖分母。** mission 插件追加一条 `hard/mission/armed` 事件，携带已固定的目标仓库、解析后的提交 sha、已排序的模块行、bug 类别列与惰性模块筛查。两个协议事实决定矩阵运算：`CLASS_SCOPE` 把 `dependencies` 与 `misconfig` 标为仓库级——各贡献一个单元而非每模块一个，未知类别默认模块级（向更多工作一侧失败安全）；惰性模块不含可执行文件，其模块级单元按已判定计数且判定方为 harness，`uncoveredCells` 永不列出它们。`coverageProgress` 按范围化总数统计判定，`uncoveredCells` 列出仍需要模型的单元（仓库级单元只出现一次，挂在 `.` 模块下），`coverageBySource` 按决定方拆分已判定单元：模型自己的阅读、经 harness grep 确认的批量清除、以及机械筛查。矩阵外的单元永不计数；没有武装记录的日志保持旧有形状——空结果，不抛错。
- **结论归因。** 每个覆盖单元可携带 `source`：`model`（模型自己读了代码；缺省时的历史默认）、`model-verified`（批量清除且经 harness grep 确认）、或 `harness`（模型完全未参与的纯机械筛查）。这个区分是诚实性要求——报告能分辨三种置信级别——且面向模型的工具绝不设置它，只有 harness 调用方设置。
- **可度量的反驳。** 每条 refuted verdict 携带 `cause` 代码——`benign-arm-passed`、`no-marker`、`nonzero-exit`、`timeout`、`aborted` 或 `no-runs`——`refutationBreakdown` 将它们聚合为协议失败、真实反驳与基础设施三组，让一次运行说得出它坏在协议层还是目标层；早于这些代码记录的 verdict 计入 `unattributed`。可选的 `evidence` 字段为将来的差分运行器保留 `proven`；confirmed verdict 显式携带 `demonstrated`——验证器如今产出的全部都是通过 specificity check 的模型所写 PoC——而早于 specificity check 记录的 confirm 缺少该字段，读作更弱。
- **完成阈值归台账所有。** `emptySweepsToFinish`（默认 2，0–16；`0` 取消该条件）是本服务的配置而非停止门的：`completionAssessment` 是台账内的判断，而它的每个消费方——停止门的否决、round 上下文的阻塞项——都注入本服务，因此它们读的是同一份配置，不可能漂移。
- **筛查抽查。** `screenSpotCheckPercent`（默认 5）把按单元哈希确定性抽样的一部分批量清除单元送回 `openWork`，标注 `verify the mechanical screen`，让模型重读、使筛查的假阴性率始终被测量。手工重标某单元会把它移出池子；`0` 关闭重读。

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | 纯事件负载词汇 |
| [`src/domain.ts`](src/domain.ts) | `hard/*` 事件的 `SessionEventMap` 合并 |
| [`src/projection.ts`](src/projection.ts) | 会话投影单元：纯折叠、状态 schema、定义 |
| [`src/index.ts`](src/index.ts) | `HardLedger` 服务：校验、追加、投影读取、未完成工作摘要 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as ledger events and service folds never enter a model request directly; the hard tools surface selected state through tool results.

#### KV Cache effect

None; the events are durable log records without request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **覆盖交叉检查延期** — 服务记录声明的 sink，但尚未对模块重新 grep 交叉核对；确定性的抽查将随 hard 覆盖审计器落地。
- **投影支撑的读取** — 状态来自 `hardLedger` 会话投影，在恢复时重建并随每次提交推进；折叠从不扫描日志。
- **单目标语义** — 台账假定每个会话只有一个 hard 任务；多任务扇出需要作用域支持。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
