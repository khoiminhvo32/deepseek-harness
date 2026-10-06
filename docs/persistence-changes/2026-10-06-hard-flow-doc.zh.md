---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-06-hard-flow-doc

[English](2026-10-06-hard-flow-doc.md) | 中文

## 概述

深读阶段（Phase B）变得可检验。新的 `hard/flow/doc` 事件在校验器将每一条引用对照钉住的提交解析通过之后，存储一个模块的 flow 文档记录：按契约顺序的各节条目数、已解析引用总数，以及由怪癖开启的假设 id。散文与片段留在工具结果中；日志只保存 harness 检验过的内容。`hard/sweep/summary` 新增可选的 `emptyProofFlowDoc` —— 作为 `emptyProofRef` 的兄弟字段，指向一条已记录、引用可解析的 flow 文档，以证明深读阶段确实运行 —— 因此什么都没找到的 Phase B pass 必须引用一份已记录的文档，而不是一句承诺。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-hard-flow-doc
baseline: false
changes:
  - root: "event:hard/flow/doc"
    previous: null
    after: "01a9d33aab4a3d0c41b3d8be2eea3428447c888a48e8c7368b4cfaa59b33e5c5"
    decision: same-version
  - root: "event:hard/sweep/summary"
    previous: "2026-10-06-hard-completion-gate"
    after: "86d644bd25fa85186753fe688a9f5b3304ed56264923f4ab6f3e9fc65f598a45"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两处变更均为增量式，在当前 Session 格式版本下读取。`hard/flow/doc` 是新的可忽略事件根；旧日志不含它，投影状态将其折叠进一个可选的状态字段。`emptyProofFlowDoc` 是 `hard/sweep/summary` 上的可选属性，旧日志读回不变；新 sweep 可以携带 `emptyProofRef` 或 `emptyProofFlowDoc` 之一，不能同时携带。flow 引用有意不并入 `emptyProofRef` 判别联合：在其中添加变体会被归类为联合变体变更，从而迫使 Session 格式版本升级，而这个兄弟属性以同版本保持了同样的可验证语义。

<a id="verification"></a>
## 验证

无密钥的 hard-profile 端到端运行先记录一条捏造的引用 —— 校验器拒绝并点名失败的引用、工具结果标记为错误 —— 然后记录一条可解析的引用，并在持久日志中断言折叠后的 `hard/flow/doc` 摘要。单元测试钉住 flow 文档折叠、引用总数不变式，以及两条空 sweep 证明路径：未记录的模块和零引用的文档都会拒绝该证明，而带引用的已记录文档通过。授权快照端到端回放被拒与被接受的记录流。

<a id="dev-note"></a>
## 开发备注

无。
