# 运行 Meebard Harness 安全审计

[English](hard-harness.md) | 中文

## Summary

Meebard Harness（即 hard harness）把一个 Web UI 会话变成针对单一目标的长时间安全审计：目标可以是 git 仓库、普通目录或单个文件。代理按固定的缺陷类别清单扫描每个模块，深入阅读模块，记录发现的每个弱点，把弱点串联成更高的影响，并用 harness 亲自运行的概念验证（PoC）证明每个 finding。会话会跨越多个 turn、provider 配额中断和连接故障持续工作，直到 harness 认证审计完成。请预期这是一次长时间运行：中等规模的目标需要许多小时和大量模型请求。

## Table of Contents

- [开始之前](#before-you-start)
- [创建 hard-web profile](#create-profile)
- [开始审计](#start-an-audit)
- [跟进审计](#follow-the-audit)
- [保持审计运行](#keep-running)
- [添加盲审](#blind-audits)
- [故障排查](#troubleshooting)
- [Further Exploration](#further-exploration)

<a id="before-you-start"></a>
## 开始之前

你需要可用的 `dsh` 命令：已安装的 `dsh`，或在仓库检出根目录运行 `pnpm dsh`。你还需要一个模型 key，其提供方的条款允许在本应用中使用；[配置模型](./providers.zh.md)说明了如何添加。下面的命令使用 `$DSH_HOME`，默认为 `~/.dsh`。

先选定目标。profile 加载时，harness 会把目标捕获进它自己的 git 快照，因此之后在目标目录中的修改永远不会改变审计所读取或引用的内容。

<a id="create-profile"></a>
## 创建 hard-web profile

profile 是 `$DSH_HOME/profiles/` 下的一个目录。创建 `$DSH_HOME/profiles/hard-web/package.json`，写入 Web bundle 与 hard bundle：

```json
{
  "name": "dsh-profile-hard-web",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-experimental-hard-bundle"] } }
}
```

然后创建 `$DSH_HOME/profiles/hard-web/cordis.patch.yml`，写入目标说明与目标的绝对路径：

```yaml
- id: hard-mission
  config:
    objective: 'Find and prove exploitable vulnerabilities in the target'
    target:
      repoPath: '/absolute/path/to/target'
```

objective 是代理持续推进的持久目标，因此请写明你希望找到并证明什么。[hard-mission 参考](../../../packages/experimental/hard-mission/README.zh.md)列出了其他字段，例如 `bugClasses` 与 `target.moduleDepth`。

<a id="start-an-audit"></a>
## 开始审计

用该 profile 启动 Web UI：

```sh
pnpm dsh --profile hard-web
```

已安装的命令是 `dsh --profile hard-web`。添加 `--port <n>` 选择端口，添加 `--no-open` 跳过打开浏览器；命令会打印带访问令牌的 URL。

在 Web UI 中，在 **Settings → Models** 配置模型，把目标目录添加为工作区，然后开始一个会话。该 profile 中的每个新会话都是对所配置目标的一次独立审计。发送一条简短指令，例如“Start the audit.”。之后代理会按轮次工作，无需进一步提示。

打开右侧边栏的 **Meebard coverage matrix** 标签页，查看模块 × 缺陷类别网格、覆盖率、被钉住的提交，以及仍在阻塞完成的事项。

<a id="follow-the-audit"></a>
## 跟进审计

代理按三类轮次工作。系统性轮次按每个缺陷类别扫描模块，并为每个单元记录一个判定。深读轮次建模数据流、信任边界与状态机，并提出假设。一旦存在两个或更多弱点或已确认 finding，串联轮次会每隔几轮运行一次，把一个弱点给予的东西与另一个弱点需要的东西组合起来。

harness 检查代理的工作，而不是信任它：

- 已清除的单元必须引用它检查过的代码。harness 在被钉住的提交上解析每个引用，并拒绝引用不存在代码的清除。
- harness 对抽样的已清除单元重新 grep，发现代理未声明的 sink 位置时重开该单元。
- finding 只有在 harness 运行其 PoC 后才算数：exploit 运行必须成功，同一个 PoC 在无害 payload 下必须失败。
- 代理无法提前结束。完成尝试会被拒绝，并附带确切的剩余工作。

你随时可以询问代理，例如：“List the confirmed findings, the recorded weaknesses, and the open hypotheses.” 已确认 finding 是可报告的结果；弱点与假设是后续工作的素材。

<a id="keep-running"></a>
## 保持审计运行

当 provider 报告配额耗尽时，harness 会等到重置时间再恢复审计。当 turn 因限流、服务器错误、超时或连接故障结束时，它会等待几分钟再恢复。[hard-standby 参考](../../../packages/experimental/hard-standby/README.zh.md)列出了确切的故障与等待时间。

服务器重启会停止审计的自动续作。重启后，打开该会话，在会话的目标区域选择 **Resume goal**。普通消息只运行一个 turn，该 turn 之后审计不会自行继续。

只在没有委派代理运行时重启服务器。重启会停止委派代理，它们未发出的工作会丢失。

<a id="blind-audits"></a>
## 添加盲审

你可以让第二个模型在看不到代理推理的情况下，重新阅读代理已清除单元的一个样本。每次重读都会消耗额外的模型请求。把下面的条目加入 `cordis.patch.yml`：

```yaml
- id: hard-audit
  config:
    enabled: true
```

[hard-audit 参考](../../../packages/experimental/hard-audit/README.zh.md)说明了抽样、每个任务的预算，以及如何把阅读者路由到另一个模型。

<a id="troubleshooting"></a>
## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 启动时打印 `hard-mission … $.target missing required value`，且覆盖标签页保持为空。 | `cordis.patch.yml` 没有 `target.repoPath`。添加目标的绝对路径并重启。 |
| 会话停止，且没有新的轮次开始。 | 目标在当前服务器进程中未处于活动状态，例如重启之后。选择 **Resume goal**。 |
| 代理报告某个引用因文件“has N lines”而被拒绝。 | 代理引用了超出文件末尾的行。代理会更正该引用；无需操作。 |
| 模型请求因配额错误失败。 | harness 会等待重置并自行恢复。错误说明余额耗尽时，请检查你的 provider 账户。 |

<a id="further-exploration"></a>
## Further Exploration

- [Hard harness 子系统](../../subsystems/hard-harness.zh.md)：台账、验证器与完成门如何协同工作。
- [Hard 工具参考](../../../packages/experimental/hard-tools/README.zh.md)：代理用来记录工作的工具。
- [配置模型](./providers.zh.md)
