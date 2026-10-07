---
description: "使用实验性的 Web 覆盖矩阵面板查看 hard harness 会话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-hard

[English](README.md) | 中文

## 概述

本包为 hard harness 会话的 Web 客户端在右侧栏新增一个标签页：以模块 × 缺陷类别网格呈现已武装的覆盖矩阵、覆盖率、已固定的目标，以及完成门的当前评估。它从共享 Session store 读取会话的 `hardLedger` 投影——Host 投影帧持续保持其最新——并且每个单元格同时呈现判定结论与判定方，机器筛查永远不会被读成模型自己的扫描。浏览器投影不扩展稳定 API Proxy，也不注册任何面向模型的输入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

为 Web 组合的 profile 开启 hard bundle：该组合包会在九个 hard 插件旁挂载本面板，且仅在那里挂载——headless 组合会禁用该行。Web Client 加载器挂载 `/client` 导出；根 Host 导出为惰性，本包没有用户配置字段。

<a id="open-the-panel"></a>
### 打开面板

右侧栏的 guide 标签页列出 Hard 覆盖胶囊；点选它会在原标签页位置打开覆盖页面。面板无需刷新控件：投影帧在面板保持打开时持续更新矩阵。

<a id="read-the-matrix"></a>
### 读懂矩阵

行是已武装的模块，列是已武装的缺陷类别——两者都是会话数据，保持不翻译。每个单元格的颜色同时命名判定与判定方：蓝色是模型自己读码后清除，绿色是模型未审读就清除的批量筛查，中性灰是惰性模块筛查，红色是被 harness 交叉检查重开的单元格，琥珀色是模型自己给出的可疑判定，空心边框是尚无判定的单元格。角上的圆点标记 harness 无法筛查的模块中的模型清除，这类判定背后只有模型自己的审读；标记叠加在颜色之上而不替换颜色。悬停单元格会点名模块、类别、判定、判定方以及任何标记。头部显示比例、目标仓库与固定提交、完成门（已认证，或未通过并列出前几条阻塞项），以及存在时的盲清除计数；其下一行说明已配置排除移除了多少已跟踪文件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

Client 导出通过 Cordis effect 注册语言字典、一个侧栏标签类型（两段式标签注册的第一段），以及键控的 `sidebar.right.pane.tab` 主体（第二段）。卸载插件 fiber 会同时移除三者，内建的 guide 随即恢复。

组件的一切都来自 `useSessions` 座位：视图来自 `projectionsBySession[sessionId].values.hardLedger`——hard-ledger 投影发布的 wire 摘要——矩阵轴、每格最新判定与判定方、覆盖聚合，以及门评估。没有投影值时，基线读取期间面板显示加载提示，之后显示空态提示；有投影但没有武装记录时同样显示空态提示。各视觉面是共享状态令牌之上的纯 CSS 类；tooltip 使用共享原语。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 语言、标签类型与槽位注册 |
| [`src/client/CoverageMatrix.tsx`](src/client/CoverageMatrix.tsx) | 由投影推导的矩阵、头部与图例 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文面板文案 |
| [`src/index.ts`](src/index.ts) | 惰性 Host 入口 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Hard bundle](../hard-bundle/README.zh.md)——在 Web 组合上挂载本面板的层。
- [Hard ledger](../hard-ledger/README.zh.md)——投影及其客户端 wire 视图。
- [右侧栏](../../client/ui-sidebar-right/README.zh.md)——标签注册表与键控标签主体座位。
- [实验包](../README.zh.md)——孵化状态与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

无，此浏览器投影不注册任何面向模型的输入。

#### KV Cache 效应

无直接影响；后续模型可见的使用由 hard 工具负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅覆盖**——findings、hypotheses 与 round 进度是后续面板；矩阵是第一个界面。
- **无会话卡片**——`hard/*` 事件不进入对话；面板才是阅读界面。
- **延迟激活**——在已打开的对话中启用 hard bundle 后，需刷新页面才能收到其 `hardLedger` 投影。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景——点击展开</summary>

无。

</details>
