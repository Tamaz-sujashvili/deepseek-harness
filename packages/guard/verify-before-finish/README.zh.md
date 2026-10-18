---
description: "一个回合结束门控：供希望 agent（智能体）在最后一次编辑之后、结束之前运行一次检查的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-verify-before-finish

[English](README.md) | 中文

## 概述

使用 `dsh-verify-before-finish` 防止 agent 在编辑没有任何检查覆盖时结束。插件在每条用户消息之后为每个 agent 记录文件编辑与验证命令。回合可能在存在编辑、且最后一次编辑之后没有通过的测试或复现命令的情况下结束。此时，插件发送一条消息，列出被修改的文件并要求运行检查。agent 随后再继续一步。插件不会阻止工具调用，也不会运行命令。

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

base bundle 仅在设置 `DSH_VERIFY_BEFORE_FINISH` 时挂载本插件。将它用于无人值守的编码任务，在这类任务中，未经检查的最终回答是错误补丁的常见原因。不要将它用于由用户自己运行检查的交互式会话。

### 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `editTools` | `edit`、`write`、`str_replace_editor` | 成功调用即视为文件编辑的工具。 |
| `readOnlyCommands` | `view` | 编辑工具的 `command` 参数中不修改文件的取值。 |
| `shellTools` | `bash` | `command` 参数为 shell 命令行的工具。 |
| `verifyPatterns` | 测试运行器与脚本运行 | 正则表达式。匹配的 shell 命令视为检查。 |
| `shellEditPatterns` | `sed -i`、`perl -i`、`git apply`、`patch`、重定向到源文件 | 正则表达式。匹配的 shell 命令视为编辑。 |
| `maxHoldsPerPrompt` | 1 | 每条用户消息最多发送的消息数。 |
| `maxListedPaths` | 8 | 每条消息最多列出的文件路径数。 |

无效的正则表达式或小于 1 的数字会使插件加载失败并报错。

-----

<a id="understand-the-implementation"></a>
## 理解实现

- `tools/post-execute` 记录证据。对编辑工具的成功调用会把其 `file_path` 或 `path` 参数加入已编辑文件。匹配 `shellEditPatterns` 的前台 shell 调用会加入一次没有路径的编辑。在编辑之后匹配 `verifyPatterns` 的前台 shell 调用成为最后一次检查，并记录其退出码。当一条命令同时包含编辑与检查时，插件按命令行中的顺序处理它们。
- `agent/turn-stopping` 读取证据。当存在编辑、且最后一次编辑之后没有通过的检查时，插件调用 `agent.steer()` 发送一条消息。达到超时的检查不算通过。随后循环再运行一步。
- `agent/pre-step` 在用户消息到达时删除该 agent 的证据。之前请求中的编辑不会触发消息。
- 状态按 agent 保存在内存中。恢复的会话从空证据开始。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`dsh-execution-risk-hints`](../execution-risk-hints/README.zh.md)：回合进行中关于薄弱检查的提示。
- [Agent 生命周期](../../../docs/agent-lifecycle.zh.md)：`agent/turn-stopping` 边界与 steering。

-----

<a id="model-experience"></a>
## 模型体验

### 验证缺口消息

#### 模型看到的内容

在以未经检查的编辑结束的回合末尾，模型会收到下面两条消息之一，作为来源为 `verify-before-finish` 的用户消息。第一条用于编辑之后没有检查的情况，第二条用于编辑之后检查失败的情况。

##### 编辑之后没有检查

```markdown
No test or reproduction command has run successfully after your latest edits.
Files changed since the user's last message:
- <path>
Before you finish, run one command that exercises the changed behavior (the relevant tests or a reproduction of the issue) and read its result. If no such check is possible here, state that in your answer.
```

##### 编辑之后的检查失败

```markdown
The last check after your edits did not pass: `<command>` exited with code <code>.
Files changed since the user's last message:
- <path>
Before you finish, fix the cause and run the check again, or state in your answer why this result is expected.
```

#### Token 影响

回合以通过的检查结束或没有编辑时为零。否则为一条约 60 到 120 个 token 的消息，加上额外一步的 token。

#### KV 缓存影响

消息追加在最后一条 assistant 消息之后，不改变之前的请求前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **模式匹配是启发式的** — 插件看不到 `shellEditPatterns` 未匹配的 shell 写操作。另外，不是测试的脚本运行也算作检查。
- **通过的检查不是证明** — 插件无法判断检查是否覆盖了被修改的行为。
- **不检查子 agent 的结果** — 子 agent 的编辑记录在子 agent 上，而不是其父 agent 上。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

依据：arXiv:2607.28815（ECLoop）在轨迹显示必要证据之前暂缓编辑与最终提交。在 SWE-bench Verified 上，Pass@1 提高 4.8 到 11.8 个百分点。消融实验中，仅提交检查一项就贡献 10 个百分点。

arXiv:2604.25850（AHE）报告，在 Terminal-Bench 2 上，结束前闭环检查的中间件单独带来 2.2 个百分点的提升。arXiv:2607.28871 发现 46.0% 的通过验证事件不能区分缺陷，因此通过的检查只是弱证据。`maxHoldsPerPrompt` 默认值 1 沿用 AHE（一次闭环检查）。ECLoop 使用 3 次预算。

</details>
