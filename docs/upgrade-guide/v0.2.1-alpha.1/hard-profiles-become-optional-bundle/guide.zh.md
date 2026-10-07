---
kind: upgrade-guide
description: "hard 与 hard-web profile 模板消失；hard harness 变为通过插件管理器按 profile 开启的可选组合包。"
---

# Hard profile 由可选组合包取代

[English](guide.md) | 中文

## 变更

在 v0.2.1-alpha.1 中，`dsh --profile hard` 与 `dsh --profile hard-web` 会自动初始化内置模板，在 headless 或 Web 组合之上选择 `@deepseek-ai/dsh-experimental-hard-bundle`。运行过试点的人都用过这两个 profile 名。

下一个版本移除这两个模板：`dsh --profile hard` 报告 `profile "hard" does not exist`，没有任何 profile 名会自动武装 hard harness。hard bundle 改为随安装发行的可选组合包——与 agent-team、voice-input、auto-review、inspector 组合包同架。它在插件管理器中以关闭状态列出；开启它会把该组合包追加到所选 profile 的组合包列表；覆盖面板随同一组合包携带，只要 profile 的组合包含 Web 应用就会挂载。

磁盘上已存在的 profile 不受影响：已列出该组合包的既有 `hard` profile 仍照常启动它。

## 迁移

1. 打开插件管理器（Web 客户端右侧栏的 Plugins），或运行 `dsh plugin --profile <name>`，为应承载它的 profile 开启 `@deepseek-ai/dsh-experimental-hard-bundle`。Web 组合让会话获得覆盖面板；headless 组合则没有。
2. 确认：该 profile 的 `$DSH_HOME/profiles/<name>/package.json` 在 `dsh.profile.bundles` 中列出该组合包，且 `dsh --profile <name>` 启动时没有 `cannot resolve profile bundle` 行。
3. 按名针对 `hard-web` profile 的补丁层仍作为文件有效；把所有以 `--profile hard-web` 启动的自动化指向现在承载该组合包的 profile。
