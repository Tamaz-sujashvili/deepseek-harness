---
description: "一个执行前守卫：供希望把 shell 中的仓库搜索重定向到 code_search、grep 与 glob 工具的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-search-routing

[English](README.md) | 中文

## 概述

使用 `dsh-search-routing` 让模型使用搜索工具，而不是 shell。命令仅为仓库搜索的 shell 调用会在运行之前被拒绝。拒绝信息会列出可见的替代工具：查找行为用 `code_search`，精确文本用 `grep`，文件路径用 `glob`。执行其他工作的命令（例如运行测试或过滤程序输出）不受影响。

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

与工具运行时一起挂载本插件。base bundle 仅在设置 `DSH_SEARCH_ROUTING` 时挂载它。

### 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `shellTools` | `['bash']` | 检查其 `command` 参数的 shell 工具。 |
| `maxQuotedChars` | 200 | 拒绝信息中引用的被拒命令的最大字符数。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

- 守卫监听 `tools/pre-execute`，仅当上游决定为 `allow` 或 `ask` 时才检查调用。
- 当每条 `&&`、`||` 或 `;` 语句要么是中性语句（`cd`、`echo`），要么是以 `rg`、`ag`、`ack`、`fd`、`git grep`、递归 `grep` 或带名称／路径测试的 `find` 开头、之后只接 `head`、`sort` 或非递归 `grep` 等过滤器的管道时，命令被视为搜索。至少一条语句必须是搜索。
- 命令替换、重定向、子 shell 与 `&` 使命令“不是搜索”，因此守卫绝不会拒绝它无法分类的命令。
- 当调用方看不到 `code_search`、`grep` 与 `glob` 中的任何一个时，不拒绝任何调用。

-----

<a id="further-exploration"></a>
## 延伸阅读

- 替代工具见 [`dsh-tool-code-search`](../../fs/tool-code-search/README.zh.md) 与 [`dsh-tool-fs-search`](../../fs/tool-fs-search/README.zh.md)。

-----

<a id="model-experience"></a>
## 模型体验

### 拒绝

#### 模型看到的内容

被拒绝的调用返回错误码为 `SHELL_SEARCH_ROUTED` 的工具错误：

##### 拒绝示例

```markdown
Error: Shell search was not run: `grep -rn "applyLiteralEdit" packages/`. Search with code_search with a description of the behaviour, to find where it is implemented; the grep tool for exact text or a regular expression; the glob tool for file paths. Use the shell for other work, such as running tests.
```

#### Token 影响

仅被拒绝的调用增加这些 token：一行约 60 个 token 的文字加上被引用的命令。

#### KV 缓存影响

仅追加；拒绝信息位于可复用的请求前缀之后。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **启发式分类器** — 守卫读取 shell 单词，而不是完整的 shell 语法。不常见的搜索形式不会被重定向。
- **没有允许列表** — 替代工具无法表达的搜索（例如二进制文件）必须改用其他 shell 形式。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

在一次 42 轮的 A/B 测试中，即使系统提示词要求使用 `code_search`，DeepSeek 在 28 次可用的运行中只调用了 2 次 `code_search`，几乎每次都用 `bash` 搜索。SWE-agent（arXiv:2405.15793）测得：使用专用、带摘要的搜索命令得到 18.0%，迭代式 shell 搜索为 12.0%。

</details>
