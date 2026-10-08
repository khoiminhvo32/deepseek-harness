---
description: "hard-mission 插件：面向以单一长期目标持续运转的部署，会话必须不断向该目标推进。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-mission

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-mission` 将配置的目标武装为持久的会话目标，把目标——git 仓库、普通目录或单个文件——固定在 harness 自有的快照中，并注册 `hard:mission` 系统提示区段来传达任务契约：跨回合持续推进、交替执行系统化扫描与深度阅读、把完成交给目标工具处理，并让每个 PoC 在良性载荷下失败。武装时把快照中的每个文件枚举进覆盖矩阵，并为每个全新根代理追加一次 `hard/mission/armed`。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

当部署拥有一个长期目标（例如对固定目标仓库的持续漏洞研究）时，将该插件与目标服务一同挂载。objective 与 target 均为必填；空白 objective、相对的 `target.repoPath`，或不存在的路径都会使加载失败。

```yaml
- id: hard-mission
  name: '@deepseek-ai/dsh-experimental-hard-mission'
  config:
    objective: 'Find and verify every authentication bypass in the target repository'
    maxGoalRounds: 64
    deepReadEveryN: 3
    target:
      repoPath: /abs/path/to/target   # a git repository, a plain directory, or one file
      moduleDepth: 2
      excludeGlobs: []   # empty by default; an exclusion is recorded and reported
```

`target.repoPath` 为必填且必须是绝对路径。加载时插件把目标捕获进快照存储 `<target.snapshotRoot>/store.git`，这是 harness 在目标之外拥有的 git 目录（默认在 DSH home 下的 `hard/snapshots`；hard 组合包同样如此设置）。git 目标贡献其已跟踪文件以及忽略规则保留的未跟踪文件，内容取自工作区；普通目录贡献其忽略文件保留的每个文件；单个文件只贡献它自己，其所在目录成为 PoC 运行的工作树。harness 自身的状态目录与目标的 `.git` 从不进入快照，目标内部也不会写入任何内容。快照提交使用固定的身份与时间，因此相同内容总是固定为相同提交，并由 ref 让每个快照提交保持存活。武装事件把它记录在 `commit` 中，并新增 `snapshot`（存储位置、目标类型，以及 git 目标以 `origin.commit` 记录的 HEAD 和 `dirty` 标记）；被忽略的条目计入 `ignoredEntryCount`。`target.commit` 是可选的：设置后 git 目标必须检出该提交，其他目标会导致加载失败。插件列出快照中的文件——即把其树与空树做 numstat 差异比较，同时标记二进制内容——随后经 `target.excludeGlobs`（根锚定 glob，默认为空）过滤，并按路径前 `target.moduleDepth`（默认 2）个目录段分组幸存者；仓库根部的文件成为模块 `.`。幸存模块为零或多于 500 个都会使加载失败；后者应调低 `moduleDepth`，让模块分组更粗——harness 从不建议为了凑上限而丢弃代码。结果已排序并去重，因此对同一提交重新武装会得到逐字节相同的矩阵，账本将其作为覆盖分母。

默认不排除任何内容：随附的第三方库、构建产物与翻译目录同样会进入生产环境，因此 harness 审计快照中的每个文件。排除是部署方的显式决定，武装事件会记录它——已应用的 glob、被排除的已跟踪文件数与有界样本——从而报告和面板能说明覆盖率遗漏了什么。**审计一棵很大的 `vendor/` 目录树会成倍增加任务成本；**排除它是合理的选择，但绝不会悄无声息。

分组之后，每个已跟踪文件都带惰性扩展名（`.md`、`.markdown`、`.txt`、`.rst`，以及位图与字体二进制）的模块会记入武装事件的 `inertModules`，不需要模块级 class 覆盖。清单刻意保守：未知扩展名按代码处理，`.svg` 仍是代码（可携带 `<script>`），配置与模板格式仍是代码，gettext 目录仍是代码（未转义地输出到页面的译文是 XSS 向量），无扩展名文件（Dockerfile、Makefile）仍是代码——因此筛查只会漏筛，绝不会把有暴露面的模块筛掉。当所有模块都被筛为惰性时加载即失败：`target has no code modules`。

每个非惰性模块，只要含有已跟踪的二进制文件——无论扩展名为何，因为交叉核查的 `grep -I` 按内容跳过二进制——或含有扩展名不在验证器固定模式表适用范围内的已跟踪文件（`SCREENED_EXTENSIONS`：JavaScript 与 TypeScript 家族、Python、Java 和 PHP），就会记入 `unscreenedModules`。交叉核查的 grep 在这类模块上保持沉默，因此既不会重新打开也不能支撑其中的清除：批量清除会被拒绝，而模型自己的清除记为盲清除，由报告和面板计数。

快照就是任务武装时模型所看到的内容。模型之后写入的文件——PoC、修改——都在快照之外，因此引用与独立读者始终按武装时的内容解析。每次加载都会重新捕获目标，但恢复的会话保留其武装记录的提交。

`bugClasses` 默认为具有机械 source-to-sink 语义的全部 OWASP Top 10 类别清单（sqli、xss、cmdi、path-traversal、open-redirect、deserialization、ssrf、authn、authn-bypass、login-bypass、oauth-bypass、session、authz、crypto-misuse、misconfig、dependencies、race）；空列表会从契约中移除类别清单。不安全设计与安全日志没有机械的 source-sink 对，保留在深度阅读过程。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-mission)是全部受支持字段的唯一权威来源。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **创建时武装。** 插件监听 `agent/created`，仅当来源为 `startup`、该代理是注册表根代理且当前没有目标时，才通过 `ctx.goals.create` 武装目标。其他来源、子代理与既有目标一律不动，目标服务对持久会话的恢复并解除武装策略保持权威。
- **加载时固定目标。** 在任何代理存在之前，`apply` 通过 shell 接缝把目标捕获进快照存储并枚举覆盖矩阵，期间关闭开发者的全局 git 配置、外部 diff 驱动与 textconv，并为每次捕获使用私有 index，因此并发任务只共享按内容寻址的存储。会写入的命令在以快照根目录为根的 `workspace-write` 沙箱中运行，因此捕获在任何会话沙箱下都能工作，且不能写到别处；对 git 目标的 `status` 读取不获取锁。错误配置的目标——路径不存在、`target.commit` 未被检出、无幸存模块或矩阵过大——在加载即失败，而不是武装一个没有分母的任务。矩阵承载于账本折叠的增量 `hard/mission/armed` 会话事件。
- **单一契约区段。** `hard:mission` 区段从解析后的配置渲染目标、系统化扫描类别清单与深度阅读节奏。它是静态文本：仅当部署配置变化时才会变化。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、契约渲染、区段注册、启动时武装、目标固定 |
| [`src/modules.ts`](src/modules.ts) | 对已跟踪路径的纯模块分组、排除 glob 过滤，以及惰性与不可筛查分类 |

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
This session carries one durable goal and keeps working toward it across turns. Do not stop to announce progress while concrete work remains; take the next action instead. Systematic passes sweep these bug classes: sqli, xss, cmdi, path-traversal, open-redirect, deserialization, ssrf, authn, authn-bypass, login-bypass, oauth-bypass, session, authz, crypto-misuse, misconfig, dependencies, race. Every 3 systematic passes, run a deep-reading pass that models dataflow, trust boundaries, and state machines to form and test hypotheses beyond pattern matching. Propose completion with update_goal action complete once the objective is genuinely achieved; the harness, not you, certifies it — an early attempt is denied with the exact remaining work, and an empty sweep only counts when it cites a refuted hypothesis or a cell you cleared. Ending a turn does not end the mission.
```

#### Token effect

在该区段注册可见的每个请求上产生少量固定输入开销。

#### KV Cache effect

在插件作用域与配置不变时保持前缀稳定。激活、卸载或配置变化可能使该提示区段的复用失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **仅在启动时武装** — 恢复或清除后的会话保留目标服务恢复的（已解除武装的）目标；恢复与配额待机唤醒时的自动重新武装属于 hard-standby 插件。
- **完成路径依赖目标工具** — 契约指名 `update_goal action complete`；未挂载 `dsh-tool-goal` 的组合必须由其他消费方提供该操作。
- **仅武装与引导** — 本插件自身既不否决完成也不认证完成；hard 停止门在这份矩阵之上拥有该决定，武装记录携带门所依据的 `goalId`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
