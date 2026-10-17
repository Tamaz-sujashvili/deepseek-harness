---
description: "面向模型的 code_search 与 code_related 工具：供为 agent（智能体）提供基于 senior-code-mcp 索引的语义与结构化代码搜索的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-code-search

[English](README.md) | 中文

## 概述

使用 `dsh-tool-code-search` 为模型提供基于 [senior-code-mcp](https://github.com/Tamaz-sujashvili/senior-code-mcp) 索引的语义与结构化代码搜索。`code_search` 返回与自然语言或代码查询匹配的函数、类和方法，以及它们的源码和图邻居。`code_related` 返回所指定符号的调用方、被调用方和导入。精确标识符、字符串和正则表达式仍使用 `dsh-tool-fs-search`（`grep`、`glob`）。

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

1. 安装 senior-code-mcp，并启动 Qdrant 与 Ollama。参见 senior-code-mcp 的 README。
2. 为工作区建立索引：`senior-code-ingest <workspace>`。
3. 将 `DSH_CODE_SEARCH_COMMAND` 设为 `senior-code-search` 可执行文件的绝对路径。base bundle 与 Web `standard` 预设仅在设置该变量时启用本插件。

### 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `command` | 必填 | `senior-code-search` 可执行文件的参数向量前缀。 |
| `repo` | 工作区目录名 | `code_search` 返回命中所属的已索引仓库名。`*` 返回所有仓库的命中。 |
| `env` | 无 | 进程的额外环境变量，例如 `QDRANT_URL`、`QDRANT_COLLECTION`、`GRAPH_PATH`、`OLLAMA_URL`。 |
| `topK` | 5 | 一次 `code_search` 调用的默认命中数。 |
| `maxHitLines` | 40 | 模型文本中单个命中的最大源码行数。 |
| `rawOutputMaxBytes` | 4 MiB | 工具解析的最大进程输出。 |
| `timeoutMs` | 60000 | 单次调用的协作式时间上限。 |
| `graceMs` | 2000 | 从 terminate 到 kill 的间隔。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

- 每次调用通过 `ctx.subprocess.spawn()` 启动一个 `senior-code-search` 进程。参数向量固定，不使用 shell。每个模型提供的值都是一个独立的 `--flag=value` 参数，因此以短横线开头的值无法变成标志。
- 进程输出一个 JSON 文档。退出码 2 加 `{"error": "..."}` 表示失败，工具会将其报告给模型。
- 工具在把每条 JSON 记录转换为规范值（`CodeSearchResult`、`CodeNode[]`）之前先进行校验。

-----

<a id="further-exploration"></a>
## 延伸阅读

- 生成的 schema 见[工具目录条目](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-code-search)。
- 与本包并存的 `grep` 与 `glob` 工具见 [`dsh-tool-fs-search`](../tool-fs-search/README.zh.md)。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到的内容

仅当 `code_search` 可见时才渲染该段。最后一句仅在 `grep` 可见时渲染。

##### 代码搜索指引

```markdown
Search code by meaning with code_search before reading files: it returns the matching functions/classes with their source and their callers/callees, so you can reuse an existing implementation instead of writing a new one. Use code_related to list what calls or is called by a symbol you already know. Use grep only for exact identifiers, strings, or regular expressions.
```

#### Token 影响

工具可见时，每个请求增加一个 303 个字符（约 75 个 token）的段落。

#### KV 缓存影响

可见工具集不变时，前缀保持稳定。

### 工具 schema

#### 模型看到的内容

生成的 [`code_search` 与 `code_related` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-code-search)。

#### Token 影响

工具可见时，每个请求的固定 schema 成本为 1,384 个序列化字符（约 350 个 token）。

#### KV 缓存影响

工具可见性与定义不变时，前缀保持稳定。

### 结果

#### 模型看到的内容

`code_search` 为每个命中返回一个块：`[n] path:start-end kind name (language) score=s`、第一行文档，以及至多 `maxHitLines` 行源码，随后是 `Related (callers/callees/imports):` 列表。`code_related` 为每个节点返回一行。没有命中时返回一句建议使用 `grep` 或重新建立索引的话。

#### Token 影响

默认结果（5 个命中，每个 40 行）是成本的主要部分，并随代码行长而变化。结果在压缩之前一直保留在历史中。

#### KV 缓存影响

仅追加；新结果位于可复用的请求前缀之后。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>


- **索引不会自动更新** — 较大改动后请重新运行 `senior-code-ingest`。
- **senior-code-mcp 只保留一个图文件** — 该图仅包含最后一次建立索引的仓库。
- **路径相对于已索引仓库的根目录** — 只有当会话工作区就是该根目录时，`read` 工具才能打开它们。
- **覆盖范围** — 本包有单元测试和一个真实进程集成测试（`DSH_CODE_SEARCH_IT_COMMAND`）。尚无录制会话快照、Loader 组合测试或 Web 工具卡片。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

工具拆分的依据：arXiv:2606.22417 比较了同一 harness 在有无语义与结构化索引时的表现。索引将解决率从 41.9% 提高到 50.4%，并将轮次从 36 减少到 28。该研究使用的是其他模型。

</details>
