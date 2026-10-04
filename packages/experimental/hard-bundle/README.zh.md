---
description: "可选的 hard-agent 组合包：任务武装、回合停止门、配额待机与 compaction 交接，让会话必须持续维持一个目标。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-hard-bundle

[English](README.md) | 中文

## 概述

启用这个可选组合包会以单一层挂载 hard-agent 四插件：`hard-mission` 将配置的目标武装为持久的会话目标，`hard-stopgate` 在该目标成立期间把回合边界重新推回工作，`hard-standby` 熬过终端配额失败并在重置时刻唤醒任务，`hard-handoff` 在每次成功 compaction 后注入持久台账摘要。组合包默认携带空白目标，在部署通过自己的补丁提供真实目标之前会加载失败。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

将该组合包的补丁层插入 `dsh-base` 之后，并在自己的组合中覆盖任务目标，例如通过 `cordis.patch.yml`：

```yaml
- overwrite:
    id: hard-mission
    config:
      objective: 'Find and verify every authentication bypass in the target repository'
```

目标工具与目标服务来自 `dsh-base`；本组合包只添加任务、停止门、待机与交接。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入携带空白目标的 `hard-mission` 行——在部署设置真实目标之前这是一次刻意的响亮失败——以及默认配置的停止门、待机与交接行。每个插件拥有自己的行为与生命周期；参见 [hard-mission](../hard-mission/README.zh.md)、[hard-stopgate](../hard-stopgate/README.zh.md)、[hard-standby](../hard-standby/README.zh.md) 与 [hard-handoff](../hard-handoff/README.zh.md)。

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as this bundle only mounts the four hard plugins; their prompt sections, steering messages, wake follow-ups, and injected handoffs are owned and documented by those packages.

#### KV Cache effect

None; the bundle adds no request content of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **空白目标刻意导致加载失败** — 随附行携带 `objective: ''`；启用该组合包的部署必须通过自己的补丁提供目标。
- **Headless 优先** — 该组合包面向 CLI 与 headless profile 组合插件；hard 会话的 Web/桌面呈现将推迟。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
