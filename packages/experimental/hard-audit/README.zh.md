---
description: "hard-audit 插件：面向 hard 组合，以影子模式让一个全新的盲读者重读已清除覆盖单元的样本。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-audit

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-audit` 测量任务 agent 错误清除覆盖单元的频率。它按层级对模型清除抽样，记录 `hard/audit/requested`，并启动一个全新的读者：读者只看到单元、固定的目标与中立的漏洞类别定义，从不看到任务 agent 的声明。读者的标记或佐证在固定提交上核验后写入 `hard/audit/result`。影子模式：任务 agent 的未完成工作、完成门与消息都不会改变。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

hard bundle 以关闭状态挂载该插件，因为每次审计都会在冷上下文上消耗模型 token。部署通过修补该行来启用：

```yaml
- id: hard-audit
  config:
    enabled: true
    auditModel:
      provider: other-provider
      model: other-model
    maxAuditsPerMission: 12
```

清除按层级抽样：grep 交叉检查无法筛查的模块中的模型阅读用 `unscreenedAuditPercent`，无人阅读的批量筛查用 `batchAuditPercent`，可筛查的逐单元阅读用 `auditPercent`。harness 清除从不审计。抽样以固定提交对单元做哈希，因此不同目标的样本不同，恢复后保持稳定。超过 `maxAuditsPerMission` 的抽样清除记录为 `budget` 原因的 `unavailable`。通过 `auditModel` 使用不同模型家族的读者独立性最强；省略时读者沿用任务 agent 的路由。`readerTools` 是允许列表，之后新增的工具对读者保持隐藏，并拒绝 ledger、会话与目标工具。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-audit)列出每个字段。

每个读者都在固定快照的独立临时 worktree 中工作，因此无论目标是什么，任务 agent 之后的修改与 PoC 都不会到达读者。没有快照的武装记录（来自早于快照的构建）会让每次审计以 `git` 原因记为 `unavailable`。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### 设计

- **对声明盲，对代码不盲。** 读者的提示包含目标路径、提交、单元与中立的类别定义，并授权读取整个仓库：授权与注入流程会跨越模块。判定、声明的站点、笔记、流程文档、假设、发现与其他审计都不会到达读者。`auditProvider` 必须启动不继承父会话的子 agent，在创建每个任务 agent 时检查。
- **洁净的 worktree，并在事后核验。** 每次读取前，插件在把写入限制在快照根目录内的沙箱下，把固定提交从 harness 自有的快照检出到存储旁边新的临时 worktree，以该 worktree 作为读者的工作目录运行读者，结束后删除它。读取工具仍能打开任意路径，因此盲性从读者自己的日志核验：`read`、`read_image`、`glob`、`grep` 与 `lsp` 的每个路径参数在解析符号链接后都必须位于该 worktree 之内。读者自己先前工具结果中出现过的路径——即它的 spill 文件——是允许的。其他任何读取，包括存有任务 agent PoC 的实时目标，都记为 `contaminated`，该次测量作废。
- **二进制单元。** 固定提交中含非惰性二进制文件的模块不启动读者，记为 `binary`，因为读者没有反编译器。
- **只接受可解析的报告。** 每个位置或已检查符号都必须通过 verifier 的引用检查在固定提交上解析，且至少一个位于被审计的单元内；否则结果为 `citation`。
- **在空闲时等待。** 任务 agent 空闲而仍有排队或运行中的审计时，插件在空闲转换中占用 agent 的维护槽，直到审计结算，因此在 agent 空闲时退出的一次性 headless 运行会先记录它们。等待期间唤醒 agent 的输入会排队等候；任务 agent 看到的内容不变。`drainWhenIdle: false` 关闭这一等待。
- **配额中止时等待而不计量。** 回合因提供商配额（`QUOTA` 或 `ACCOUNT_QUOTA`）结束的阅读者没有读到任何内容，因此其请求不记录结果，也不计入 `maxAuditsPerMission`。请求会暂停 `quotaRetryMinutes`（默认 5）分钟，并在此后任务 agent 的第一次回复（说明提供商已恢复应答）或会话恢复时再次运行。
- **持久且可恢复。** `hardAudit` 投影折叠每个单元最新判定的 seq、待处理请求与已计入的预算。恢复的任务会重启待处理审计；读者启动前单元已被再次标记的请求结算为 `superseded`。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/domain.ts`](src/domain.ts) | `hard/audit/requested` 与 `hard/audit/result` 的 `SessionEventMap` 合并 |
| [`src/projection.ts`](src/projection.ts) | 会话投影单元：判定 seq、待处理请求、已计入预算 |
| [`src/prompt.ts`](src/prompt.ts) | 读者 persona、任务提示、类别定义与报告 schema |
| [`src/reads.ts`](src/reads.ts) | 读取路径提取与污染检查 |
| [`src/index.ts`](src/index.ts) | 插件：抽样、队列、工作区检查、读者运行、结果 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### 读者会话

#### 模型看到什么

任务 agent 什么也看不到：消息、工具与提示都不变。每个读者是独立的子会话，其系统提示带有覆盖部署 persona 的 persona，要求它以对抗方式阅读，并说明其他地方的任务或 ledger 指令针对的是另一个 agent。它的用户消息给出目标、提交、单元与类别定义，要求找出一个漏洞并给出位置，未发现时给出已检查的符号。它只持有读者工具与 `structured_output` 工具。

#### Token 影响

每个抽样清除一次冷上下文子运行，上限为 `maxAuditsPerMission`；读者不复用任务 agent 的提示缓存。任务 agent 的请求不变。

#### KV Cache 影响

对任务 agent 无影响；每个读者构建自己的前缀。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **仅影子模式** —— 标记尚不会重开单元或阻止完成；把审计绑定到完成门要等测得成本与标记率之后。
- **检测而非限制** —— 读取工具不受限制，污染读取在发生后才作废，而不是被阻止。
- **空闲等待** —— 空闲的任务 agent 会等待其审计，因此审计可能拉长任务的实际耗时，交互用户的下一条消息也要排在其后。
- **二进制模块** —— 读者没有反编译器，因此任何含非惰性二进制文件的模块或仓库级单元都记为 `binary`。
- **全局任务段** —— 任务与深读的系统提示段仍会到达读者；它们携带目标，不携带声明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

读者的工具调用、结果与用量通过 `session/event` 观察，按运行标签识别出的子会话归类，从不回读子会话日志。录制会话快照语料中没有该插件的场景：读者与任务 agent 并发运行，任务日志中审计记录的交错顺序不确定；改由真实组合的端到端测试覆盖。

</details>
