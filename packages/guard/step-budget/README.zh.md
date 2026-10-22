---
description: "一个步数预算：供希望智能体知道剩余模型步数、并在设定步数后停止的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-step-budget

[English](README.md) | 中文

## 概述

使用 `dsh-step-budget` 限制一个智能体为一条用户消息所用的模型步数。在设定的阈值处，智能体会收到一条简短通知，说明已用步数与剩余步数。达到预算时，智能体会被要求结束。再经过少量宽限步后，本轮结束。

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

与智能体循环和工具运行时一起挂载此插件。基础 bundle 仅在设置了 `DSH_STEP_BUDGET` 时挂载它。`DSH_STEP_BUDGET` 的值即 `maxSteps`。不是正整数的值使用默认值 100。

### 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `maxSteps` | 100 | 一个智能体为一条用户消息可走的模型步数。 |
| `notifyAt` | `[0.5, 0.8]` | 智能体收到通知时 `maxSteps` 的比例。 |
| `graceSteps` | 2 | 达到预算后仍允许的步数。之后本轮结束。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

- 在 `agent/pre-step` 上，插件为每个智能体计数步数。来自用户的消息把计数清零。
- 在 `tools/post-execute` 上，计数达到阈值时，插件用 `agent.steer()` 发送通知。下一步会收到该通知。每个阈值只发送一次。
- 插件只在工具调用之后发送通知。因此通知绝不会延续一个已经完成的轮次。
- 计数超过 `maxSteps` 加 `graceSteps` 时，插件拒绝下一步，本轮结束。紧随无工具调用回复的一步不会被拒绝，因此模型自行结束的轮次会正常完成。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`dsh-repeat-tool-reminder`](../repeat-tool-reminder/README.zh.md)：针对重复相同工具调用的提醒。

-----

<a id="model-experience"></a>
## 模型体验

### 通知

#### 模型看到的内容

通知是一条来源为 `step-budget` 的用户消息：

##### 阈值通知示例

```markdown
Step budget: 50 of 100 steps used, 50 remain. Plan the rest of the task to fit in the remaining steps.
```

##### 达到预算时的通知示例

```markdown
Step budget reached: 100 of 100 steps used. After 2 more steps, the run stops. Do not explore further. Complete the change you have, then give your final answer.
```

#### Token 影响

每条通知约增加 30 个 token。默认配置下，一次运行最多收到三条通知。

#### KV 缓存影响

仅追加。每条通知位于可复用的请求前缀之后。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只计步数** — 预算只计模型步数，不计 token 或费用。
- **不交接** — 达到预算时，插件不会启动新的智能体。运行以磁盘上已有的改动结束。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

Budget Tracker（arXiv:2511.17006）让智能体持续感知预算。使用它时，成本与性能的扩展优于仅增大预算。该研究使用网页搜索智能体，而非编写代码的智能体。在 SWE-bench Verified 上，过度思考越多，解决率越低（arXiv:2502.08235）。更多迭代无助于卡住的运行（arXiv:2501.14723）。

</details>
