---
kind: upgrade-guide
description: "从 dsh 安装与 profile 目录都无法解析的 profile bundle 会使加载失败，而不是在缺少该 bundle 的情况下启动。"
---

# 无法解析的 profile bundle 使加载失败

[English](guide.md) | 中文

## 变更

在 v0.2.1-alpha.1 中，profile 加载先从 dsh 安装、再从 profile 目录解析每一条 `dsh.profile.bundles`（`packages/boot/app-boot` 的 `loadProfileDirectory`）。当两个锚点都无法解析某个 bundle 时，加载器把失败记入 `skippedBundles`，每次启动打印一次 `dsh: skipping profile bundle "<name>": …`，然后照常启动。

下一版本改为使加载失败：解析错误向上抛出，`dsh` 以非零码退出，并打印 `cannot resolve profile bundle "<name>" from the dsh installation or <profileDir>`。凡 profile 声明的 bundle 在两个锚点都缺失的人都受影响——此前的启动会静默降级为缺少该 bundle 插件的会话。

bundle *内容* 的失败保持旧有行为：manifest 读取失败、patch 缺失或损坏、以及未豁免的 peer 不兼容，仍会跳过并出现在 `skippedBundles`。只有缺失的引用对象才响亮失败。

## 迁移

1. 如果 bundle 应当存在，把它安装进 profile：运行 `dsh plugin --profile <name> install`，或在 `$DSH_HOME/profiles/<name>/package.json` 的 `dependencies` 中声明该 bundle 并安装。
2. 如果 bundle 不再需要，从 `$DSH_HOME/profiles/<name>/package.json` 的 `dsh.profile.bundles` 中删除它的名字。
3. 在 workspace 检出中开发未发布的 bundle 时——experimental hard bundle 不是 `apps/cli` 的依赖——把包软链接进 profile：`ln -sfn <repo>/packages/<group>/<pkg> "$DSH_HOME/profiles/<name>/node_modules/@deepseek-ai/<pkg>"`。
4. 确认：`dsh --profile <name>` 启动时没有 `cannot resolve profile bundle` 行，也没有 `did not activate` 警告。
