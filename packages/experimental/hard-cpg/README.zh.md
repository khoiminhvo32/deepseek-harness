---
description: "hard harness 部署使用的 hard-cpg 插件，为固定快照提交构建 Joern 调用图事实。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-cpg

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-cpg` 提供 `hardCpg` 服务，把 hard 任务的固定快照提交转成 Joern 事实：目标文件、内部方法，以及附带已解析内部目标与有界参数摘要的调用点。它用 `git archive` 导出该提交，通过 shell seam 运行 Joern 的 PHP 前端与一个随包查询，并把校验过的 JSON Lines 文件按提交与查询摘要缓存在快照存储旁。插件默认关闭；部署方安装 Joern 后再启用。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

安装 Joern 发行包（需要 JDK 21，且 PATH 上有 PHP），然后启用 hard bundle 已挂载的这一行：

```yaml
- id: hard-cpg
  config:
    enabled: true
    joernHome: '/opt/joern/joern-cli'
    excludePaths: ['poc']
```

`excludePaths` 列出前端跳过的仓库相对路径；留空即覆盖整个固定提交，并请列出重定义目标函数的 PoC 桩，因为它们会在图中截走调用。启用 `buildOnArm`（默认开启）时，任务武装会启动后台构建并记录计数。使用方调用 `ctx.hardCpg.facts(agent)`，再用 `readHardCpgFacts` 读取文件。每个步骤既受 `stepTimeoutMinutes` 约束，也受 shell 单条命令超时上限约束。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-cpg)列出全部字段。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **只用固定内容。** 导出读取固定提交处的快照存储，从不读取实时目标，因此事实与引用描述的是同一批文件。
- **只用随包查询。** Joern 的解释器执行任意 Scala，因此服务只把随包脚本与 harness 构造的路径交给它；[决策笔记](../../../.agents/notes/implemented/architecture/2026-10-10-hard-harness-maps-features-from-joern-facts.zh.md)记录了原因。
- **与框架无关的事实。** 查询写出事实格式 2：一行 header，若干 file、type、method、call 行，以及一行 end。type 行携带其继承的完整名称，method 行携带其声明类型。call 行携带 Joern 的目标名、它解析到的内部方法、分派类型，以及最多四个参数摘要；被脱糖的数组字面量参数会变成其元素文本，回调数组正是借此保留它所指的方法。
- **使用前先校验。** 构建在把文件移入缓存之前先用读取器完整计数，读取器拒绝缺少 header、含无效行或缺少 end 行的文件，因此被截断的导出永远不会被使用。
- **每个键只构建一次。** 缓存键对事实格式、查询文本、`joernHome` 与 `excludePaths` 做摘要；同一键的并发请求共享一次构建，卸载插件会取消正在运行的步骤。

### Source map

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、`hardCpg` 服务、构建步骤与武装触发 |
| [`src/facts.ts`](src/facts.ts) | 事实格式 schema、读取器与计数器 |
| [`src/query.ts`](src/query.ts) | 随包的 Joern 查询 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin only writes fact files beside the snapshot store; consumers own any model-facing use.

#### KV Cache effect

None; the plugin adds no request content of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **仅支持 PHP**——构建运行 PHP 前端；其他语言需要各自的前端与测量。
- **Joern 的 PHP 调用解析不完整**——在类内部调用的自由函数被解析为不存在的类方法，`parent::`、后期静态绑定、变量调用与计算出的名称仍未解析；修复属于基于这些事实的使用方。
- **只支持带快照的记录**——没有 harness 快照的武装记录没有可导出的存储，会被拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

在 WordPress 7.1.3 上用 Joern v4.0.653 测得：前端约 30 秒，查询约 30 秒，1,513 个文件、14,500 个方法与 183,000 个调用点的事实文件约 48 MB。

</details>
