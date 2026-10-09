---
description: "hard-verifier 插件：面向 hard 组合，执行 findings 的效果证明并重算其 CVSS 4.0 分数。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-hard-verifier

[English](README.md) | 中文

## 概述

`dsh-experimental-hard-verifier` 通过 shell seam 执行 finding 的概念验证，并机械地判定结论。证明分两臂运行：良性臂用由 claim 哈希派生的良性载荷重跑一次 PoC 并要求其失败——无论输入如何都通过的证明对输入什么都没证明（specificity check）——只有之后攻击臂才用模型提供的 payload 运行 PoC，一次运行仅在退出码为零且在 stdout 打印 `HARD-PASS <claim 的 sha256>` 时才算满足契约。全部攻击运行通过即确认，全部失败即反驳，任何分裂都是 flaky 且永不计入。引擎使用逐字引自 FIRST 参考计算器的数据与逻辑，从 CVSS 4.0 向量重算所声称的分数。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

与 hard ledger 一同挂载；hard 工具在提出 finding 后调用 `ctx.hardVerifier.verify`。

```yaml
- id: hard-verifier
  name: '@deepseek-ai/dsh-experimental-hard-verifier'
  config:
    runs: 3
    timeoutSeconds: 120
```

`runs`（1 到 10）是攻击臂的执行次数，`timeoutSeconds`（1 到 3600）限制单次运行，`stdoutMaxBytes` 限制捕获的 stdout，`pocWorkdir` 覆盖工作目录；没有它时 PoC 从武装矩阵固定的目标仓库运行，使模型相对的 `pocPath` 在它声称的代码里解析。良性臂总是最先、单次、在干净树上运行。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-verifier)是全部受支持字段的唯一权威来源。已确认的根因会以 `HARD_VERIFIER_DUPLICATE` 拒绝重复提案，且不执行任何内容。`assertVerifiable` 在调用方追加提案之前执行这项检查与向量解析（`HARD_VERIFIER_INVALID_VECTOR`），因此验证器永远无法裁决的声明不会一直处于待验证状态。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **证明必须依赖 payload。** 验证通过 shell seam 运行 PoC 并施加配置的超时；接受要求与 claim 文本绑定的确定性 `HARD-PASS <claimHash>` 标记以及失败的良性臂（specificity check）。标记之外不要求任何 stdout 形状——效果不上 stdout 的静默漏洞利用同样确认；而对任何输入都打印填充加标记的 PoC 会被以非载荷特定为由反驳。每条 refuted verdict 都指明原因——`benign-arm-passed`、`no-marker`、`nonzero-exit`、`timeout`、`aborted` 或 `no-runs`——使各次运行可聚合为协议、目标与基础设施三组失败。
- **与参考一致的 CVSS。** `src/cvss4-lookup.ts` 逐字引入 FIRST 计算器的 macrovector 分数、组合最大值与严重度深度（BSD-2-Clause）；`src/cvss4.ts` 一一对应地移植其评分算法。穷举套件对全部 270 个 macrovector 的最高严重度向量评分，结果与查找值完全一致，任何与 FIRST 的漂移都会响亮失败。
- **确定性去重。** `rootFingerprint` 对归一化的 bug 类别、组件与所在符号做哈希；`claimHash` 对 claim 文本做哈希，正是 PoC 必须打印的内容。
- **持久结论。** 每次验证都通过台账追加 `hard/finding/verdict` 记录，包括重算分数以及模型声称的分数是否匹配。

### Source map

| File | Role |
|---|---|
| [`src/cvss4-lookup.ts`](src/cvss4-lookup.ts) | 官方 FIRST 查找数据，逐字引入 |
| [`src/cvss4.ts`](src/cvss4.ts) | 参考解析与评分算法的类型化移植 |
| [`src/fingerprint.ts`](src/fingerprint.ts) | claim 哈希与根因指纹 |
| [`src/verdict.ts`](src/verdict.ts) | 效果证明契约与结论分类 |
| [`src/index.ts`](src/index.ts) | `HardVerifier` 服务：重复拒绝、执行、CVSS 重算、记录 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the service executes proofs and records verdicts; the tools consumer owns all model-visible results, whose submit JSON carries the verdict, run count, recomputed score, score match, and a bounded reason.

#### KV Cache effect

Results append after the reusable request prefix without invalidating earlier entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Bash PoC** — 执行运行 `bash <pocPath>`；Windows PoC 运行器需要 pwsh provider 路径，已延期。
- **flow 引用解析** — `checkFlowCitations(agent, citations)` 通过 `git ls-tree` 与 `git show` 将每条 `path:line` 引用对照钉住的提交解析，从不读工作树：路径必须在提交中被跟踪、行必须存在、片段必须出现在该内容中。git 调用未干净结束即 fail closed，并以原因返回被拒引用，`hard_record_flow` 因此能点名每条失败引用拒绝整份文档。
- **声明位置解析** — `checkSinkCitations(agent, sinks)` 只用 git 在被固定的提交上解析已清除覆盖单元的每个声明位置（写作 `path:symbol`、`path:line` 或 `path:start-end`，可带备注）——`git ls-tree`、与空树的 numstat 差异比较、`git grep -I -F` 以及行数统计——因此结果不依赖宿主机的 `grep`。二进制文件通过路径检查，但其内容不会被当作已解析，因为它所在的模块不可筛查。符号可能匹配在注释里：这一检查拒绝引用不存在的代码，而不是拒绝错误的清除。覆盖交叉核查按路径与符号或行号把 grep 行与引用匹配，对不是引用的声明保留子串规则。与批量筛查一样，它在被固定的提交上运行 `git grep -I -n -E`，从不读取工作树，因此在固定之后写入目标的报告、PoC 或修改既不会重新打开单元，也不会给出模型无法引用的行。交叉检查对模块目录执行 grep；对根模块 `.` 只检查根目录下的文件（`--max-depth 0`）；对仓库级类别检查整棵树，并去掉 `<commit>:` 前缀，使路径能与引用比较。一次重新打开最多列出八个未声明的匹配，并在末尾给出其余匹配的数量。
- **效果类别细化延期** — 针对内存安全与 authz 类别的 sanitizer 信号与差分检查分类将随覆盖审计器落地；标记契约是 PR2 的唯一契约。
- **受保护面类别反转读法** — 对 `authz` 与 `authn-bypass`，缺陷是防护的缺席，因此 `GUARDED_SURFACE_PATTERNS` 命名的是导出的操作而非防护本身：交叉检查会重开一个已清除的单元格，点名模型声明中未提及的每个导出操作；零匹配是沉默，既不重开任何单元，也不认证任何单元。提取器无法命名的匹配以其 `path:line` 位置报告，引用该行的声明即可覆盖它，因此压缩打包文件中的超长行永远不会成为证据。`ABSENCE_SINK_CLASSES` 只保留 `login-bypass`——它的 sink 是防护性检查，批量筛查会被拒绝：对它，空 grep 是可疑而非干净。批量联合仍然意味着模型的 pattern 只能在固定表之上增加覆盖，永远不能减。每条重开记录都携带 `source: 'harness'`，因此报告能区分 harness 的重开与模型自己给出的 `suspicious` 判定——发现了东西是正确行为，不是投机。
- **网络策略属于部署** — PoC 运行期间的出网限制跟随已挂载的 sandbox provider；验证器不添加自己的策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
