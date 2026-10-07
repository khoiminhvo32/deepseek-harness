---
kind: upgrade-guide
description: "hard mission 通过 harness 自有的快照固定任意目标，因此武装记录中的提交是快照的提交，target.commit 只检查 HEAD。"
---

# Hard mission 通过快照固定任意目标

[English](guide.md) | 中文

## 变更

在 v0.2.1-alpha.1 中，`hard-mission` 要求目标是 git 仓库：它把 `target.commit`（默认 `HEAD`）解析为目标自身 git 中的 sha，并从该提交读取矩阵与每条引用。普通目录或单个文件会导致加载失败。

下一个版本把每个目标捕获进 harness 自有的 git 存储：

- `target.repoPath` 可以指向 git 仓库、普通目录，或单个文件（例如共享库）。武装时把它捕获进 `<target.snapshotRoot>/store.git`；hard 组合包把 `snapshotRoot` 设为 DSH home 下的 `hard/snapshots`。目标内部不会写入任何内容。
- git 目标贡献其已跟踪文件以及忽略规则保留的未跟踪文件，内容取自工作区，因此本地改动会被捕获而不是被忽略。普通目录贡献其忽略文件保留的每个文件。
- `hard/mission/armed` 在 `commit` 中记录快照提交，并新增 `snapshot`，包含存储位置、目标类型，以及对 git 目标而言以 `origin.commit` 记录的 HEAD 和 `dirty` 标记。
- `target.commit` 不再有默认值。设置后，它只检查 git 目标是否检出了该提交；对其他目标会导致加载失败。
- `DEFAULT_TARGET_COMMIT` 导出已移除。

## 迁移

1. 对目标不是 git 仓库的 profile 补丁，删除 `commit: HEAD`；对 git 目标它是多余的。
2. 在把运行与仓库历史比较的工具中，从 `snapshot.origin.commit` 而不是 `commit` 读取目标自身的提交。
3. 为快照存储预留空间：它保存每个被捕获目标的压缩副本，相同文件在不同目标间共享存储。
4. 确认：会话的 `hard/mission/armed` 事件携带 `snapshot`，并且 `git --git-dir=<snapshot.gitDir> ls-tree -r <commit>` 列出矩阵枚举的内容。
