---
description: "针对 shell 结果的建议性提示：供希望把重复错误、薄弱检查与长时间前台运行告知 agent（智能体）的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-execution-risk-hints

[English](README.md) | 中文

## 概述

使用 `dsh-execution-risk-hints` 就 shell 命令中的风险模式向 agent 提供简短提示。每次前台 shell 调用之后，插件更新该 agent 的记录。当某个模式在最后一条用户消息之后首次出现时，插件把一条提示附加到工具结果上。插件识别四种模式：重复出现的错误行、遇到失败不停止的检查、只检查帮助文本或语法的检查，以及长时间命令。插件不会阻止或修改调用。

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

base bundle 仅在设置 `DSH_EXECUTION_RISK_HINTS` 时挂载本插件。将它用于 agent 会运行大量 shell 命令的长时间无人值守任务。

### 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `shellTools` | `bash` | `command` 参数为 shell 命令行的工具。 |
| `detectors` | 全部四个 | 要运行的检测器：`repeated-error`、`time-budget`、`non-fail-fast-check`、`shallow-check`。 |
| `errorRepeatThreshold` | 2 | 触发提示所需的、错误行相同的连续失败命令数。 |
| `longStepMs` | 120000 | 前台命令被视为长时间运行的时长（毫秒）。 |
| `budgetMs` | 420000 | 未发生超时时，长时间命令累计达到该时长即触发提示。 |
| `maxNotesPerCall` | 2 | 单个工具结果上的最多提示数。 |

小于 1 的数字或未知的检测器会使插件加载失败并报错。

-----

<a id="understand-the-implementation"></a>
## 理解实现

- `tools/pre-execute` 在执行前决策之后记录每次 shell 调用的开始时间。`tools/post-execute` 读取前台结果值：退出码、超时状态、stdout 与 stderr。转入后台的命令结果视为超时。后台作业与失败的调用被忽略。
- `repeated-error`：错误行是输出中最后一个异常行，否则是第一个包含错误词的行。数字变为 `N`，十六进制地址变为 `ADDR`。失败但没有错误行的命令（例如没有匹配的 `grep`）会重置计数。
- `time-budget`：当存在两条或更多长时间命令且发生一次超时，或长时间命令累计时间达到 `budgetMs` 时给出提示。
- `non-fail-fast-check`：针对运行 `diff`、`cmp`、`grep -q` 或 `test -f` 并打印消息的多步检查脚本给出提示。仅当脚本没有 `set -e`、`|| exit` 或 `trap ... exit` 时才给出。
- `shallow-check`：针对只运行 `--help`、`-h`、`py_compile`、`node --check`、`bash -n` 或 `ls` 等存在性命令的检查给出提示。命令的每一步都必须属于这些类型。仅在第一次测试或脚本运行之前才给出。
- 每个提示键在每条用户消息内只发送一次。提示通过决策的 `additionalContexts` 传递，因此 `tool/result` 事件保留工具自身的输出。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`dsh-repeat-tool-reminder`](../repeat-tool-reminder/README.zh.md)：完全相同的重复调用。
- [`dsh-verify-before-finish`](../verify-before-finish/README.zh.md)：回合结束时的检查。

-----

<a id="model-experience"></a>
## 模型体验

### 执行提示

#### 模型看到的内容

工具结果之后，模型会收到一条来源为 `execution-risk-hints` 的用户消息。它以 `Execution notes:` 开头，列出一到两条提示。下面的示例是重复错误的提示。其他提示的文本见 `src/index.ts` 中的 `observe` 函数。

##### 重复错误提示

```markdown
Execution notes:
- The last 2 shell commands failed with the same error:
`ModuleNotFoundError: No module named 'foo'`
The approach behind them has not changed the outcome. Before you run another variant, check the assumption it depends on (path, working directory, installed module, function signature, test name) and change the approach.
```

#### Token 影响

未出现模式时为零。每条提示约 40 到 80 个 token，每个提示键在每条用户消息内最多出现一次。

#### KV 缓存影响

提示追加在工具结果之后，不改变之前的请求前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **检测器基于正则表达式** — 可能漏报或误报模式。每条提示仅为建议。
- **时长包含排队时间** — 从 `tools/pre-execute` 到 `tools/post-execute` 的时间包含审批等待。
- **未移植基准专用的检测器** — 源中间件还包含针对 localhost 检查、性能余量与模型封装器的检测器，本包不包含它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

来源：arXiv:2604.25850（AHE）演化后 harness 中的 `ExecutionRiskHintsMiddleware`。其仅中间件消融在 Terminal-Bench 2 上为 71.9%，对照为 69.7%。重复错误提示用文字描述失败，而不是只告诉模型“不要重复”：arXiv:2608.23651 发现“不要重复”指令不能减少重复，而运行时对失败的描述可以。arXiv:2607.28871 发现，一条关于检查质量的通用提醒使基于薄弱证据结束的比例降低 3.2 个百分点。

</details>
