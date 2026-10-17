---
description: "一个无需模型的压缩步骤：供希望在每个 agent（智能体）步骤之前分批把较旧的大型工具输出替换为一行占位文本的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-observation-mask

[English](README.md) | 中文

## 概述

使用 `dsh-compaction-observation-mask` 在不调用 LLM 摘要的情况下保持上下文精简。每个 agent 步骤之前，插件原样保留最新的 `keepRecent` 个工具结果，并把每个更旧且大于 `minChars` 的结果替换为一行占位文本。模型消息与工具调用不变。替换以 Session 事件记录，因此回放会重建相同的请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 设置

与 `dsh-token-meter` 一起挂载本插件。base bundle 仅在设置 `DSH_OBSERVATION_MASK` 时挂载它。

### 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `keepRecent` | 10 | 始终原样保留的最新工具结果数。 |
| `minChars` | 400 | 不超过该大小的结果从不被遮蔽。 |
| `batchSize` | 5 | 运行一次遮蔽所需的最少合格结果数。 |
| `maxArgumentChars` | 160 | 占位文本中引用的工具参数最大字符数。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

- 插件监听 `agent/pre-step`，随后以 `next()` 委托。
- 每次替换遵循 `dsh-compaction-tool-result-pruner` 的影子协议：先追加 `compaction/prune` 影子计价事件，再追加一个在 Session 表面替换该节点并在 `sourceEventSeqs` 中引用它的 `tool/result` 事件。
- 仅当至少 `batchSize` 个结果合格时才遮蔽。这样请求前缀按批次改变，而不是每一步都改变。
- 遮蔽失败时记录警告；步骤继续。

-----

<a id="further-exploration"></a>
## 延伸阅读

- 本插件复用的影子协议见 [`dsh-compaction-tool-result-pruner`](../compaction-tool-result-pruner/README.zh.md)。
- 接近上下文上限时的 LLM 摘要见 [`dsh-compaction-basic`](../compaction-basic/README.zh.md)。

-----

<a id="model-experience"></a>
## 模型体验

### 被遮蔽的工具结果

#### 模型看到的内容

每个被遮蔽的结果变为一行：

##### 占位文本

```markdown
[Older tool output elided to save context: bash({"command":"cat file1.py"}) returned 1000 characters. Run the tool again if you need this output.]
```

#### Token 影响

每个被遮蔽的结果缩减为一行。最新的 `keepRecent` 个结果与较小的结果保持原大小。

#### KV 缓存影响

一次遮蔽会改变从第一个被遮蔽结果开始的请求内容，因此下一个请求只能复用到该位置为止的提供方缓存。分批（`batchSize`）限制这种情况发生的频率。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **年龄按工具结果计数，而不是按轮次** — 一个包含许多并行工具调用的步骤会使更早的结果更快变旧。
- **没有恢复路径** — 原始输出保留在 Session 日志中，但不在请求中；模型必须重新运行工具。
- **默认值未针对本 harness 调优** — `keepRecent` 与 `batchSize` 来自其他 agent 框架；请通过 A/B 测试调优。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

依据：arXiv:2508.21433 发现，在 SWE-bench Verified 上，遮蔽旧观察结果使 agent 成本减半，效果与 LLM 摘要相当或更好。arXiv:2405.15793（SWE-agent）发现，保留最近 5 个观察结果得到 18.0%，保留完整历史为 15.0%。

</details>
