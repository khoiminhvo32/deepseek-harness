---
kind: upgrade-guide
description: "hard mission 默认不再排除任何目录树，并且不再把批量筛查当作已审计覆盖。"
---

# Hard mission 审计被固定提交的全部内容

[English](guide.md) | 中文

## 变更

在 v0.2.1-alpha.1 中，除非 `target.excludeGlobs` 另有配置，`hard-mission` 会把 `node_modules`、`vendor`、`dist`、`build`、`docs`、`doc`、`locales`、`i18n`、`assets`、`fixtures`、`testdata`、`__snapshots__` 与压缩后的 bundle 排除出覆盖矩阵，并从索引列出已跟踪文件。gettext 目录（`.po`、`.pot`、`.mo`）被筛为惰性。完成可以只依赖批量清除的单元。

下一个版本改变运行 hard 组合包的人都能观察到的三项行为：

- `target.excludeGlobs` 默认为 `[]`。矩阵枚举被固定提交跟踪的每个文件，因此同一目标会产生更多模块。已配置的排除记录在 `hard/mission/armed` 中，并在覆盖率旁报告。
- gettext 目录按代码计，因此含有它们的模块不再被筛为惰性。
- 批量筛查（`hard_clear_modules` 产生的 `model-verified` 单元）不再满足完成评估对“模型审读过的单元”的要求，并且 `hard_clear_modules` 拒绝 harness 无法筛查的模块——任何含有二进制，或含有 JavaScript 与 TypeScript 系列、Python、Java 之外文件的模块。

## 迁移

1. 决定任务应跳过什么，并在 profile 补丁中显式写出，例如在 `hard-mission` 条目下写 `target: { excludeGlobs: ['vendor/**', 'dist/**'] }`。保持列表为空即审计全部内容。
2. 预期任务会在 harness 无法筛查的模块中逐格审读；只做批量筛查的运行还必须记录至少一次逐格审读或一个已解决的假设才能完成。
3. 确认：会话的 `hard/mission/armed` 事件携带 `unscreenedModules`、`ignoredEntryCount`，并且在你配置了 glob 时携带含被排除文件数的 `exclusions`。
