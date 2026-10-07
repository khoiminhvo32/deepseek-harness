---
description: "hard-mission 插件：面向以单一长期目标持续运转的部署，会话必须不断向该目标推进。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-mission

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-mission` 将配置的目标武装为持久的会话目标，固定目标仓库，并注册 `hard:mission` 系统提示区段来传达任务契约：跨回合持续推进、交替执行系统化扫描与深度阅读、把完成交给目标工具处理，并让每个 PoC 在良性载荷下失败（specificity check）。武装时把被固定提交跟踪的每个文件枚举进覆盖矩阵，记录惰性与不可筛查模块，并只追加一次 `hard/mission/armed`；仅在 `startup` 时为全新根代理武装，且工作区须与该提交一致。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

当部署拥有一个长期目标（例如对固定目标仓库的持续漏洞研究）时，将该插件与目标服务一同挂载。objective 与 target 均为必填；空白 objective、相对的 `target.repoPath`，或不是 git 仓库的目标都会使加载失败。

```yaml
- id: hard-mission
  name: '@deepseek-ai/dsh-experimental-hard-mission'
  config:
    objective: 'Find and verify every authentication bypass in the target repository'
    maxGoalRounds: 64
    deepReadEveryN: 3
    target:
      repoPath: /abs/path/to/target-repo
      commit: HEAD
      moduleDepth: 2
      excludeGlobs: []   # empty by default; an exclusion is recorded and reported
```

`target.repoPath` 为必填且必须是绝对路径。加载时插件通过 `git rev-parse` 解析 `target.commit`（默认 `HEAD`），并列出该提交跟踪的文件——即把提交的树与空树做 numstat 差异比较，同时标记二进制内容——因此枚举绑定到被固定的提交，而不是索引或工作区。随后经 `target.excludeGlobs`（根锚定 glob，默认为空）过滤，并按路径前 `target.moduleDepth`（默认 2）个目录段分组幸存者；仓库根部的文件成为模块 `.`。幸存模块为零或多于 500 个都会使加载失败；后者应调低 `moduleDepth`，让模块分组更粗——harness 从不建议为了凑上限而丢弃代码。结果已排序并去重，因此对同一提交重新武装会得到逐字节相同的矩阵，账本将其作为覆盖分母。

默认不排除任何内容：随附的第三方库、构建产物与翻译目录同样会进入生产环境，因此 harness 审计被固定提交跟踪的每个文件。排除是部署方的显式决定，武装事件会记录它——已应用的 glob、被排除的已跟踪文件数与有界样本——从而报告和面板能说明覆盖率遗漏了什么。**审计一棵很大的 `vendor/` 目录树会成倍增加任务成本；**排除它是合理的选择，但绝不会悄无声息。

分组之后，每个已跟踪文件都带惰性扩展名（`.md`、`.markdown`、`.txt`、`.rst`，以及位图与字体二进制）的模块会记入武装事件的 `inertModules`，不需要模块级 class 覆盖。清单刻意保守：未知扩展名按代码处理，`.svg` 仍是代码（可携带 `<script>`），配置与模板格式仍是代码，gettext 目录仍是代码（未转义地输出到页面的译文是 XSS 向量），无扩展名文件（Dockerfile、Makefile）仍是代码——因此筛查只会漏筛，绝不会把有暴露面的模块筛掉。当所有模块都被筛为惰性时加载即失败：`target has no code modules`。

每个非惰性模块，只要含有已跟踪的二进制文件——无论扩展名为何，因为交叉核查的 `grep -I` 按内容跳过二进制——或含有扩展名不在验证器固定模式表适用范围内的已跟踪文件（`SCREENED_EXTENSIONS`：JavaScript 与 TypeScript 系列、Python 和 Java），就会记入 `unscreenedModules`。交叉核查的 grep 在这类模块上保持沉默，因此既不会重新打开也不能支撑其中的清除：批量清除会被拒绝，而模型自己的清除记为盲清除，由报告和面板计数。

目标首次武装时，工作区必须与被固定的提交一致，因为模型读取并运行的是工作区，而矩阵与每一条引用都按提交解析。当已跟踪文件与提交不同，或存在未跟踪且未被忽略的文件时，全新根代理的首次武装会失败——在任何目标存在之前拒绝其创建——并列出有界的路径集合。harness 自身状态目录下的路径（项目本地的 `.dsh/`，以及位于目标内的 DSH home）不算偏离；被忽略的条目计入武装事件的 `ignoredEntryCount`。加载本身从不因偏离而失败，因此恢复的会话仍能在其自身运行产生的文件之上加载。

`bugClasses` 默认为具有机械 source-to-sink 语义的全部 OWASP Top 10 类别清单（sqli、xss、cmdi、path-traversal、open-redirect、deserialization、ssrf、authn、authn-bypass、login-bypass、oauth-bypass、session、authz、crypto-misuse、misconfig、dependencies、race）；空列表会从契约中移除类别清单。不安全设计与安全日志没有机械的 source-sink 对，保留在深度阅读过程。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-mission)是全部受支持字段的唯一权威来源。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **创建时武装。** 插件监听 `agent/created`，仅当来源为 `startup`、该代理是注册表根代理且当前没有目标时，才通过 `ctx.goals.create` 武装目标。其他来源、子代理与既有目标一律不动，目标服务对持久会话的恢复并解除武装策略保持权威。
- **加载时固定目标。** 在任何代理存在之前，`apply` 通过 shell 接缝解析目标提交并枚举覆盖矩阵（先 `git rev-parse`，再在关闭外部 diff 驱动与 textconv 的情况下对提交的树做 numstat 差异比较），因此错误配置的目标——仓库缺失、提交无法解析、无幸存模块或矩阵过大——在加载即失败，而不是武装一个没有分母的任务。矩阵承载于账本折叠的增量 `hard/mission/armed` 会话事件。
- **首次武装时拒绝偏离。** 同一次加载会测量工作区偏离，但不会因此失败；`agent/created` 监听器在工作区偏离时为全新根代理抛错，代理循环直接 announce，因而这会变成创建失败。恢复的会话从不重新检查。
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
