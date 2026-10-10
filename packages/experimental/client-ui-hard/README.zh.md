---
description: "使用实验性的 Web 覆盖矩阵与功能地图面板查看 hard harness 会话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-hard

[English](README.md) | 中文

## 概述

本包为 hard harness 会话的 Web 客户端在右侧栏新增两个标签页。覆盖标签页显示已武装的模块 × 缺陷类别矩阵、覆盖率、已固定的目标与完成门；每个单元格同时显示判定与判定方。功能地图标签页把目标的入口点、模型记录的功能及其关系绘制成图，并可打开任一功能的符号图以及任一符号的调用边与源码。两者都读取会话的 `hardLedger` 投影，Host 投影帧持续保持其最新。两者都不扩展稳定 API Proxy，也不注册任何面向模型的输入。

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

右侧栏的 guide 标签页列出 Meebard 覆盖矩阵胶囊与 Meebard 功能地图胶囊；点选其一会在 guide 标签页的位置打开对应页面。两个面板都无需刷新控件：投影帧在面板保持打开时持续更新它们。

<a id="read-the-matrix"></a>
### 读懂矩阵

行是已武装的模块，列是已武装的缺陷类别——两者都是会话数据，保持不翻译。每个单元格的颜色同时命名判定与判定方：蓝色是模型自己读码后清除，绿色是模型未审读就清除的批量筛查，中性灰是惰性模块筛查，红色是被 harness 交叉检查重开的单元格，琥珀色是模型自己给出的可疑判定，空心边框是尚无判定的单元格。角上的圆点标记 harness 无法筛查的模块中的模型清除，这类判定背后只有模型自己的审读；标记叠加在颜色之上而不替换颜色。悬停单元格会点名模块、类别、判定、判定方以及任何标记。头部显示比例、目标仓库与固定提交、完成门（已认证，或未通过并列出前几条阻塞项），以及存在时的盲清除计数；其下一行说明已配置排除移除了多少已跟踪文件。

<a id="read-the-feature-map"></a>
### 读懂功能地图

任务用 `hard-featuremap` 为目标建立索引后，功能地图标签页才会显示内容。头部统计功能数、已映射入口点占全部已索引入口点的数量，以及功能关系数；图下方的折叠列表点名所有未被任何已记录功能覆盖的入口点。总览图按入口类型（ajax、rest、script 等）每类一列绘制所有已索引的入口点，未被任何功能覆盖的入口点变暗，功能放在其后的一列；入口点向列出它的每个功能各连一条边，每条已记录的功能关系是一条动画边。入口点保持索引顺序、功能保持记录顺序，因此新功能落在已绘制功能的下方；标签页打开期间出现的节点会带绿色外圈与“新”标记四秒。

从功能标签行或其节点点选一个功能，会显示其摘要、可达数、必需数与排除数以及已记录的状态，并把总览替换为来自 Host 的功能符号图：处理函数在第一列，每多一层调用放在下一列，已排除的符号在最后一列并变暗，守卫与状态写入带描边，边的颜色表示生成它的规则（Joern、修复、唯一名称、hook）。功能记录被修订时会重新获取图。点选一个符号会列出其调用方与被调用方——每一项都可继续打开——并显示其在固定提交中的源码行。“全部功能”返回总览。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

Client 导出通过 Cordis effect 注册语言字典、两个侧栏标签类型（两段式标签注册的第一段），以及它们键控的 `sidebar.right.pane.tab` 主体（第二段）。卸载插件 fiber 会移除全部注册，内建的 guide 随即恢复。

组件的一切都来自 `useSessions` 座位：视图来自 `projectionsBySession[sessionId].values.hardLedger`——hard-ledger 投影发布的 wire 摘要——矩阵轴、每格最新判定与判定方、覆盖聚合，以及门评估。没有投影值时，基线读取期间面板显示加载提示，之后显示空态提示；有投影但没有武装记录时同样显示空态提示。各视觉面是共享状态令牌之上的纯 CSS 类；tooltip 使用共享原语。

功能地图从同一视图读取 `featureMap`，并用 React Flow 绘制，Client bundle 会内联该库。其布局是记录顺序的纯函数。功能图与符号详情来自 `GET api/hard-featuremap.feature` 与 `GET api/hard-featuremap.symbol`，由 `hard-featuremap` 注册在 Web 连接上；面板只导入该包的 `./client` 类型，自行保留两个路径的副本，并由一个测试将其与 Host 常量比对。选择改变之后才到达的响应会被丢弃。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 语言、标签类型与槽位注册 |
| [`src/client/CoverageMatrix.tsx`](src/client/CoverageMatrix.tsx) | 由投影推导的矩阵、头部与图例 |
| [`src/client/FeatureMap.tsx`](src/client/FeatureMap.tsx) | 功能地图总览、功能图与符号详情 |
| [`src/client/feature-layout.ts`](src/client/feature-layout.ts) | 纯函数图布局与 Host 路由路径 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文面板文案 |
| [`src/index.ts`](src/index.ts) | 惰性 Host 入口 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Hard bundle](../hard-bundle/README.zh.md)——在 Web 组合上挂载本面板的层。
- [Hard ledger](../hard-ledger/README.zh.md)——投影及其客户端 wire 视图。
- [Hard feature map](../hard-featuremap/README.zh.md)——功能地图以及功能地图标签页读取的路由。
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

- **仅覆盖与功能**——findings、hypotheses 与 round 进度是后续面板。
- **功能地图需要存活的 agent**——功能图与符号路由只在会话的 agent 运行时应答；重新打开已结束的会话可看到总览，但看不到图。
- **没有跨项目页面**——功能地图数据库跨项目共享，但标签页只显示一个会话的目标。
- **无会话卡片**——`hard/*` 事件不进入对话；面板才是阅读界面。
- **延迟激活**——在已打开的对话中启用 hard bundle 后，需刷新页面才能收到其 `hardLedger` 投影。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景——点击展开</summary>

无。

</details>
