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

`runs`（1 到 10）是攻击臂的执行次数，`timeoutSeconds`（1 到 3600）限制单次运行，`stdoutMaxBytes` 限制捕获的 stdout，`pocWorkdir` 覆盖工作目录；没有它时 PoC 从武装矩阵固定的目标仓库运行，使模型相对的 `pocPath` 在它声称的代码里解析。良性臂总是最先、单次、在干净树上运行。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-hard-verifier)是全部受支持字段的唯一权威来源。已确认的根因会以 `HARD_VERIFIER_DUPLICATE` 拒绝重复提案，且不执行任何内容。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **证明必须依赖 payload。** 验证通过 shell seam 运行 PoC 并施加配置的超时；接受要求与 claim 文本绑定的确定性 `HARD-PASS <claimHash>` 标记以及失败的良性臂（specificity check）。标记之外不要求任何 stdout 形状——效果不上 stdout 的静默漏洞利用同样确认；而对任何输入都打印填充加标记的 PoC 会被以非载荷特定为由反驳。
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
- **效果类别细化延期** — 针对内存安全与 authz 类别的 sanitizer 信号与差分检查分类将随覆盖审计器落地；标记契约是 PR2 的唯一契约。
- **缺席形态的类别拒绝批量筛查** — `ABSENCE_SINK_CLASSES`（`authz`、`authn-bypass`、`login-bypass`）命名的是防护性检查，因此 `screenModules` 拒绝它们：对这些类别，空 grep 意味着没有找到任何防护，是可疑而非干净。批量联合还意味着模型的 pattern 只能在固定表之上增加覆盖，永远不能减。
- **网络策略属于部署** — PoC 运行期间的出网限制跟随已挂载的 sandbox provider；验证器不添加自己的策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
