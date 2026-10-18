---
description: "一个压缩后端：供希望每份压缩摘要末尾都带有确定性文件列表（列出被压缩历史读取与修改的文件）的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-file-tracking

[English](README.md) | 中文

## 概述

使用 `dsh-compaction-file-tracking` 在压缩前后保留确切的文件路径。该引擎就是 `dsh-compaction-basic`，只有一处改动：模型写完摘要后，引擎追加一个 `<read-files>` 列表和一个 `<modified-files>` 列表。列表来自被压缩工具调用的文件路径参数以及更早摘要中的列表，因此会跨多次压缩累积。这些列表不由模型书写，因此不会遗漏或编造路径。

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

用本包替代 `dsh-compaction-basic` 挂载；两者都注册 `compaction` 服务，因此只挂载其一。base bundle 仅在设置 `DSH_COMPACTION_FILE_TRACKING` 时挂载本包并停用 `dsh-compaction-basic`。

### 配置

所有 `dsh-compaction-basic` 键照常适用。本包新增两个键：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `fileTools` | `read`、`code_outline`、`code_read_symbol`（读取）；`edit`、`write`（修改） | 规则 `{ tool, argument, kind }`，指明每个工具的文件路径参数。配置的列表会替换默认列表。 |
| `maxFiles` | 50 | 每个列表最多保留的路径数。保留最近使用的路径。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

- 引擎覆盖 `BasicCompactionEngine` 文档化的 `summarize()` 钩子。压力判断、保留策略、溢出恢复与持久 Session 事件均不变。
- 当工具调用在被压缩区域内的结果不是错误时计入。结果位于区域之外的调用也计入。
- 更早检查点（来源为压缩检查点的用户消息）中的列表在其位置计为一次使用，因此路径会延续下去。其他消息中的列表标签会被忽略。被修改过的路径只列在 `<modified-files>` 下。路径按工具调用中的原样保留。
- 追加收集到的列表之前，会先从模型摘要中删除模型自己写的列表，因此每份摘要只有一份列表。
- 列表属于已记录的 `compaction/summary` 事件与替换用 `user/message` 的摘要内容，因此回放会重建相同的请求。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`dsh-compaction-basic`](../compaction-basic/README.zh.md)：本引擎使用的摘要提示、阈值与保留策略。

-----

<a id="model-experience"></a>
## 模型体验

### 压缩摘要中的文件列表

#### 模型看到的内容

`<compacted-summary>` 内的摘要以一个或两个列表结尾。空列表会被省略：

##### 列表示例

```markdown
<read-files>
src/config.ts
tests/config.spec.ts
</read-files>

<modified-files>
src/index.ts
</modified-files>
```

#### Token 影响

每份摘要按每个路径一行、每个列表两行标签增长，上限由 `maxFiles` 决定。摘要请求本身不变。

#### KV Cache 影响

替换式，与 `dsh-compaction-basic` 相同：每次压缩时摘要替换被压缩区域一次。列表不会给请求前缀带来其他变化。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限工具参数** — `bash` 读取或修改的文件（例如 `sed -i`）不会列出。
- **路径不做规范化** — 同一文件的相对路径与绝对路径是两个条目。包含换行符的路径不会列出。
- **列表从文本解析** — 更早的摘要只以 `<read-files>` 与 `<modified-files>` 文本块携带列表；丢弃它们的其他摘要器会中断延续。
- **仅限 base bundle** — Web 应用的预设挂载 `dsh-compaction-basic`，因此 `DSH_COMPACTION_FILE_TRACKING` 不影响 Web agent。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

证据：CORVUS（arXiv:2607.22711）维护 agent 正在处理的文件登记表，报告每个任务输入 token 减少 9-50%，通过率相当。MemTrace（arXiv:2610.04838）把压缩后的记忆锚定到文件与符号上，使 agent 能在上下文刷新后重建状态。列表格式沿用 pi coding agent（`packages/coding-agent/src/core/compaction/utils.ts`）。

</details>
