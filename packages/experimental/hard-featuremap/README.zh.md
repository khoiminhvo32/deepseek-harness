---
description: "hard harness 部署使用的 hard-featuremap 插件，把 Joern 事实导入共享的 SQLite 功能地图。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-featuremap

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-featuremap` 提供 `hardFeatureMap` 服务，把 `hard-cpg` 为任务固定提交构建的 Joern 事实导入一个由所有项目与会话共享的 SQLite 数据库。它存储符号、调用点、标注了生成规则的调用边，以及所配置框架配置档读出的入口点与路由层守卫：WordPress、Laravel、Spring、ASP.NET Core、Flask、FastAPI 与 Express。修复步骤补上 Joern 未解析的调用边。数据库只保存派生数据，因此重建而不迁移。插件默认关闭。

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
    frameworks: [wordpress]
```

bundle 把 `dbPath` 设为 harness 主目录下 `hard` 目录中的 `featuremap.db`。`frameworks` 列出要读取的配置档，可选 `wordpress`、`laravel`、`spring`、`aspnet`、`flask`、`fastapi` 与 `express`；留空只保留调用边。请让 `hard-cpg` 的 `language` 与之匹配。`scriptDirs` 列出其顶层 PHP 文件会被直接请求的目录；启用 WordPress 配置档时，留空即选用 WordPress 安装的根目录、`wp-admin`、`wp-admin/network` 与 `wp-admin/user`。启用 `indexOnArm`（默认开启）时，任务武装会在后台导入并记录边的计数。使用方调用 `ctx.hardFeatureMap.index(agent)` 取得快照 id，再调用 `callers`、`callees` 与 `entryPoints`。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-featuremap)列出全部字段。

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

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin only writes and queries a database beside the snapshot store; later tools own any model-facing use.

#### KV Cache effect

None; the plugin adds no request content of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **控制器之外注册的 REST 路由**——不读取嵌套数组中的 `register_rest_route` 回调；`WP_REST_Controller` 后代之外的插件路由会缺失。
- **Cron 与 XML-RPC 入口点**——计划任务 hook 与 XML-RPC 方法表尚不是入口点；`xmlrpc.php` 以脚本形式出现。
- **声明之外的路由前缀**——不读取用 `app.use('/prefix', router)` 挂载的 Express 路由器、Laravel 路由组与 `Route::resource`，以及 ASP.NET 约定路由；Django 没有配置档。
- **全局中间件**——配置档看不到全应用的认证，因此没有自身守卫的路由为 `unknown`，而不是 `public`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

在排除 PoC 桩的 WordPress 7.1.3 事实上测得：183,100 个调用点得到 53,338 条 `joern`、20,780 条 `repair`、3,927 条 `unique-name` 与 1,692 条 `hook` 边；`wp_insert_post`（24 个，与 grep 一致）、`wp_delete_post`、`update_user_meta`、`wp_set_current_user` 与 `check_ajax_referer` 的每个调用点都已链接；1,435 次 hook 注册中有 1,348 次解析出回调；370 个入口点（114 个 admin-ajax 动作、99 个 REST 处理函数、8 个短代码、149 个脚本）。派生约 0.6 秒，导入约 1 秒，快照 52 MB。

</details>
