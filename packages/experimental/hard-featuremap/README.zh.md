---
description: "hard harness 部署使用的 hard-featuremap 插件，把 Joern 事实导入共享的 SQLite 功能地图。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-featuremap

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-featuremap` 提供 `hardFeatureMap` 服务，把 `hard-cpg` 为任务固定提交构建的 Joern 事实导入一个跨项目共享的 SQLite 数据库：符号、标注生成规则的调用边，以及框架入口点及其守卫。模型记录功能（harness 检查其完整性），声明目标自行编写的守卫与入口点，关闭 harness 推导出的守卫差异对，并对每个功能做滥用审查。插件默认关闭。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

与 `hard-cpg` 一起启用 hard bundle 已挂载的这一行：

```yaml
- id: hard-featuremap
  config:
    enabled: true
    dbPath: !!js dshHomePath('hard', 'featuremap.db')
    frameworks: [wordpress]
```

patch 会替换 bundle 行的整个 `config`，因此需要重新写出 `dbPath`，即数据库的绝对路径；bundle 自身的行把 `featuremap.db` 放在 harness 主目录下的 `hard` 目录中。`frameworks` 列出要读取的配置档，可选 `wordpress`、`laravel`、`spring`、`aspnet`、`flask`、`fastapi` 与 `express`；留空只保留调用边。请让 `hard-cpg` 的 `language` 与之匹配。`scriptDirs` 列出其顶层 PHP 文件会被直接请求的目录；启用 WordPress 配置档时，留空即选用 WordPress 安装的根目录、`wp-admin`、`wp-admin/network` 与 `wp-admin/user`。启用 `indexOnArm`（默认开启）时，任务武装会在后台导入并记录边的计数。建立索引时还会把入口点记入会话，台账的 `minEntryMappedPercent`（默认 80）会让完成门保持阻塞，直到已记录功能覆盖这一比例。检查从功能的处理函数出发读取 `featureDepth`（默认 4）层调用，不展开拥有超过 `libraryFanIn`（默认 40）个不同调用方的符号，要求 `requiredDepth`（默认 2）层以内的非库符号以及 `guards` 与 `mutations` 中每个被到达的名称（留空时，若启用 WordPress 配置档则选用 WordPress 列表），并允许功能最多排除 `maxExcludedPercent`（默认 50）的必需符号。使用方调用 `ctx.hardFeatureMap.index(agent)` 取得快照 id，再调用 `callers`、`callees` 与 `entryPoints`；`featureGraph(agent, featureId)` 与 `symbolDetail(agent, symbol)` 返回[功能地图标签页](../client-ui-hard/README.zh.md#read-the-feature-map)的显示数据。存在 Web 连接时，已启用的插件把这两者提供为 `GET /api/hard-featuremap.feature?session=<id>&feature=<FE-n>` 与 `GET /api/hard-featuremap.symbol?session=<id>&symbol=<id>`；缺少任一参数时返回 400，会话没有存活的 agent 或功能、符号不存在时返回 404，读取失败时返回 409 并附带错误。`csrfGuardPattern`、`authenticationGuardPattern` 与 `guardCandidatePattern` 是不区分大小写的正则表达式，默认值与框架无关；无法编译的模式在加载时即失败。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-featuremap)列出全部字段。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **每条边都标明来源。** `joern` 是图自身的解析。`repair` 涵盖通过类型继承链解析的类型限定调用、`parent`/`self`/`static` 调用或无接收者调用（Ruby），以及 PHP 会路由到全局函数的类限定调用（Joern issue 3050）。`unique-name` 只在仅有一个方法使用该名称时，链接对未知接收者的动态调用。`hook` 把带字面名称的触发链接到在该名称下注册的每个回调。使用方应把 `unique-name` 边的权重排在其他边之后。
- **事实指明目标，否则不链接。** 修复只在事实恰好指明一个目标时才加边；计算出的 hook 名称、闭包回调或变量调用保持不链接。
- **WordPress 入口点。** admin-ajax 与 admin-post 动作来自 hook 注册，`nopriv` 动作为公开；admin-ajax 处理函数还来自核心命名约定 `wp_ajax_<action>`，因为核心在循环中用计算出的名称注册大多数动作。REST 处理函数是 `WP_REST_Controller` 后代的 `get_items`、`get_item`、`create_item`、`update_item` 与 `delete_item` 方法。短代码与被直接请求的脚本补全列表。
- **HTTP 路由配置档。** 每条路由是 `http` 类型的入口点，键为 `VERB path`，并附带其路由层守卫。Spring 拼接类上 `@RequestMapping` 的前缀，读取 `@PreAuthorize`、`@Secured` 与 `@RolesAllowed`；ASP.NET Core 展开 `[Route]` 中的 `[controller]` 与 `[action]`，读取 `[Authorize]`，`[AllowAnonymous]` 使路由公开；Flask 与 FastAPI 读取带路径的路由装饰器，并把 `login_required` 等表示访问控制的装饰器视为守卫；Express 读取 `get`、`post` 等路由调用，把最后一个参数视为处理函数（被引用的闭包或同文件函数），其余视为中间件；Laravel 读取带控制器数组、`Controller@method` 字符串或闭包的 `Route::` 调用，以及链式 `middleware`。带守卫的路由为 `authenticated`，显式开放的为 `public`，其余为 `unknown`，因为不读取全局中间件。
- **每个派生一个快照。** 快照按目标根目录、提交，以及事实缓存键、框架、脚本目录与导入版本的摘要作为键。不同的派生在旧快照旁导入；相同的派生被复用，并发请求共享一次导入。
- **功能必须交代它到达的内容。** 检查从功能入口点的处理函数出发沿调用边走到 `featureDepth`，在被广泛共享的库符号处停止展开，并计算必需集合：处理函数、近处的非库符号，以及每个被到达的守卫与状态写入。主张必须把每个必需符号列为成员，或带理由（`utility`、`other-feature`、`unreachable`）列为排除项；守卫或状态写入不能以 `utility` 排除；可达范围之外的成员需要 `via`，即被到达的调用方与行号，harness 在固定提交上读取该行并要求其提到该符号；角色为 `guard` 或 `mutation` 的成员本身必须是或调用一个守卫或状态写入。所有不足之处一次报告，只有通过的主张才会写入台账。
- **守卫差异对，适用于任何框架。** 每记录一个功能后，harness 为已记录功能的每个入口点建立画像：其路由层守卫、从处理函数与前置检查（如 REST 权限回调）到达的守卫，以及其到达的状态写入加上所属功能声明的写入状态。守卫的类别来自其声明，或来自 `csrfGuardPattern` 与 `authenticationGuardPattern`；其余守卫均为授权检查。在每个被写入的状态中，若某入口点缺少至少半数写入方都具备的某类全部守卫，就形成一个 `P-n` 差异对；CSRF 只在同一入口类型内比较。harness 每个差异对只记录一次，并以来源 `harness` 把两个功能链接为 `shares-state`。
- **项目自有的守卫与路由须凭证据声明。** `hard_declare_guard` 接收守卫符号以及其内部一行表示拒绝的代码——异常、abort 或 exit、401 或 403 状态，或拒绝提示——声明后的守卫随即计入功能检查与差异对。`hard_declare_entry_point` 接收一个 `custom:` 入口点、其处理函数，以及点名该处理函数的分发行。`guards` 视图按名称（`guardCandidatePattern`）以及以 401 或 403 拒绝的调用给出候选。
- **滥用审查。** `hard_review_feature` 为单个功能按每个视角（skip-step、wrong-actor、wrong-object、sequence、race-replay、input、shared-state、limits）记录一个“如果……会怎样”的问题，为相互链接的功能记录一起使用时可做到什么；每个问题以 finding、hypothesis 或 weakness id、驳回或不适用结束。台账在存在未关闭差异对或缺少审查时阻塞完成门。
- **显示读取保持有界。** 功能图包含一个已记录功能的成员与排除项以及它们之间的调用边。符号详情最多返回 100 个调用方、100 个被调用方与 200 行源码，源码从固定提交的 harness 快照读取；没有位置或快照的符号没有源码。
- **派生数据，因此重建。** 带有其他 schema 版本标记的数据库会被删除并重新创建，因为事实随时可以再次导入。

### Source map

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、`hardFeatureMap` 服务与武装触发 |
| [`src/model.ts`](src/model.ts) | 内存事实索引与类型继承链 |
| [`src/repair.ts`](src/repair.ts) | 调用边与修复 |
| [`src/wordpress.ts`](src/wordpress.ts) | WordPress hook、hook 边与入口点 |
| [`src/http.ts`](src/http.ts) | HTTP 路由配置档 |
| [`src/store.ts`](src/store.ts) | SQLite schema、导入与查询 |
| [`src/check.ts`](src/check.ts) | 可达范围、必需集合与功能完整性检查 |
| [`src/tools.ts`](src/tools.ts) | 三个模型工具与提示段落 |
| [`src/web.ts`](src/web.ts) | 功能地图标签页的 Host 路由 |
| [`src/pairs.ts`](src/pairs.ts) | 守卫差异对与守卫类别 |
| [`src/routes.ts`](src/routes.ts) | 路由路径，不含导入以供 Client 测试使用 |
| [`src/types.ts`](src/types.ts)、[`src/client.ts`](src/client.ts) | 显示类型及其仅类型的 `./client` 导出 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

启用插件后，`hard:feature-map` 段落教授地图任务：列出入口点、查找符号 id、读取功能必须交代的内容、记录每个功能的符号、排除项与状态，并链接在不同守卫下写入同一状态的功能。

##### Feature map section

```markdown
Feature map. The harness builds a map of the target from its call graph: entry points a request reaches, the symbols behind them, and the guards and state writes they reach. Map every feature, and map while you sweep: record each feature as soon as you have read the code behind its entry points instead of leaving the map for the end. See what is mapped with hard_query_map view features. List entry points with hard_query_map (view entry-points, unmapped_only true), find symbol ids with view symbol, and see what a feature must account for with view required and its entry points. Record each feature with hard_record_feature: a name, what it does and for whom, its entry points, its symbols with roles (entry, guard, mutation, helper), the required symbols it leaves out with a reason (utility, other-feature, unreachable), and the state it reads or writes. The harness refuses a feature that leaves a required symbol unaccounted for, excludes a guard or a state write as utility, or names a symbol outside the reach without citing the call that reaches it (via). Link related features with hard_link_feature. Two features that write the same state behind different guards are where feature abuse hides: link them with kind shares-state and test the weaker path.

Abuse. Each time you record a feature the harness compares the guards of entry points that write the same state: one that lacks a guard category (csrf, authentication, authorization) most of the others carry becomes a guard pair, and the harness links the two features as shares-state. Close every pair (hard_query_map view pairs) with hard_resolve_pair: a finding or hypothesis that tests the weaker path, or safe with the line of the check that covers it. When the target checks access in its own code, declare each such guard with hard_declare_guard and the line where it denies; view guards suggests candidates. Declare entry points no framework profile finds, such as a hand-written router, with hard_declare_entry_point and the dispatch line. Once features cover the required share, review every feature with hard_review_feature and ask what if for each lens: skip-step (skip a step of the intended flow), wrong-actor (a lower role or no login), wrong-object (someone else's object), sequence (steps out of order), race-replay (repeat or race a request), input (unexpected types, empty, arrays, extremes), shared-state (the same result through a weaker feature), limits (exceed a count, go negative, overflow). Record where each question led: a finding, a hypothesis, a weakness (it becomes chain material), refuted, or not-applicable. Review every pair of linked features together as well: what does using them together allow that neither allows alone? Chain what the reviews find with the weaknesses you already hold.
```

#### Token effect

插件启用期间每次请求有少量固定输入成本。

#### KV Cache effect

插件启用期间前缀保持稳定；启用或停用会改变提示前缀。

### Injected notice

#### What the model sees

任务武装时的索引完成且地图包含入口点后，插件会向正在进行的对话注入一条通知，列出每类入口点的数量，并要求在扫描时同步绘制功能。在 WordPress 7.1.3 上内容为：

##### Ready notice

```markdown
<hard_feature_map> The feature map of the pinned commit is ready: 370 entry points (114 ajax, 99 rest, 8 shortcode, 149 script). Map features while you sweep, not after: whenever you have read the code behind an entry point, record its feature with hard_record_feature before moving on; hard_query_map view entry-points with unmapped_only true lists what is left.
```

#### Token effect

每个已武装会话一条短消息。

#### KV Cache effect

追加在可复用前缀之后；先前条目保持缓存。

### Tool schemas and results

#### What the model sees

生成的 [`hard_query_map`、`hard_record_feature`、`hard_link_feature`、`hard_declare_guard`、`hard_declare_entry_point`、`hard_resolve_pair` 与 `hard_review_feature` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-hard-featuremap)。结果是紧凑 JSON：已记录的功能及其入口点、成员与排除数量和状态、功能关系，以及功能覆盖了多少入口点；一页带路由层守卫及是否已被功能覆盖的入口点、匹配的符号、一页标明生成规则的调用边、给定入口点的必需集合及每个符号的原因、已记录功能的 id 连同可达规模、必需集合规模与仍未映射的入口点数，或已记录的链接。被拒绝的功能会一次返回所有不足之处。

#### Token effect

插件启用期间有固定 schema 成本，每次调用另加一个紧凑结果；每页最多 200 项，拒绝信息最多按名称列出 20 个缺失符号。

#### KV Cache effect

插件启用期间 schema 前缀保持稳定。调用与结果追加在可复用的请求前缀之后，不会使先前条目失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **控制器之外注册的 REST 路由**——不读取嵌套数组中的 `register_rest_route` 回调；`WP_REST_Controller` 后代之外的插件路由会缺失。
- **Cron 与 XML-RPC 入口点**——计划任务 hook 与 XML-RPC 方法表尚不是入口点；`xmlrpc.php` 以脚本形式出现。
- **声明之外的路由前缀**——不读取用 `app.use('/prefix', router)` 挂载的 Express 路由器、Laravel 路由组与 `Route::resource`，以及 ASP.NET 约定路由；Django 没有配置档。
- **检查成本**——检查对每个被到达的符号查询一次数据库；在 WordPress 上，Quick Edit 功能（185 个被到达符号）约需 4 秒。
- **守卫与状态写入列表**——只有 WordPress 配置档提供默认列表；其他框架在未配置 `guards` 与 `mutations` 时只依赖近处符号规则。
- **全局中间件**——配置档看不到全应用的认证，因此没有自身守卫的路由为 `unknown`，而不是 `public`。
- **守卫差异对比较的是类别而非参数**——两条路径对不同对象（附件与其父文章）调用同一检查时不构成差异对；由滥用审查的 wrong-object 视角覆盖。
- **拒绝证据基于文本**——声明守卫所引用的行需要包含异常、abort、exit、401/403 或拒绝提示，而非守卫的代码也可能包含这些内容。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

在排除 PoC 桩的 WordPress 7.1.3 事实上测得：183,100 个调用点得到 53,338 条 `joern`、20,780 条 `repair`、3,927 条 `unique-name` 与 1,692 条 `hook` 边；`wp_insert_post`（24 个，与 grep 一致）、`wp_delete_post`、`update_user_meta`、`wp_set_current_user` 与 `check_ajax_referer` 的每个调用点都已链接；1,435 次 hook 注册中有 1,348 次解析出回调；370 个入口点（114 个 admin-ajax 动作、99 个 REST 处理函数、8 个短代码、149 个脚本）。派生约 0.6 秒，导入约 1 秒，快照 52 MB。

</details>
