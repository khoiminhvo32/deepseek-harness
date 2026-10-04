---
description: "hard-ledger 插件：面向 hard 组合，把 findings、假设、覆盖与扫描状态记录为持久会话事件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-ledger

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-ledger` 拥有 hard harness 的持久方法论状态：五个增量 `hard/*` 会话事件（finding 提案与验证器结论、假设生命周期、覆盖单元、扫描摘要），以及负责校验、追加并折叠这些事件的 `ctx.hardLedger` 服务。会话日志是唯一存储；id 从日志分配，所有折叠都从日志派生。

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

- **日志派生状态。** `findings`、`hypotheses`、`coverage`、`sweepCount` 与 `openWork` 读取 `hardLedger` 会话投影——对五个事件的纯折叠，框架在恢复时重建并随每次提交增量推进；没有并行存储，日志保持唯一事实来源，fork/重启行为天然跟随会话。
- **从日志分配顺序 id。** `F-<n>` 与 `H-<n>` 计数器统计各自类型的历史事件；假设迁移会对照日志中已存在的 id 校验成员资格。
- **增量事件，无需格式升级。** 五个事件都是纯增量 root：无表面、信封或头变化，任何既有事件形态不变，因此词汇增长无需格式升级。早于该词汇表的构建会拒绝此类日志而非误读，这正是仓库内事件要求的读取契约。
- **有界文本。** 自由文本字段上限 2000 字符；`refuted` 与 `deferred` 假设的 reason 字段、零发现扫描的 `emptyProof` 均为必填。

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | 纯事件负载词汇 |
| [`src/domain.ts`](src/domain.ts) | 五个 `hard/*` 事件的 `SessionEventMap` 合并 |
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
