---
description: "一个执行前守卫：供希望在文件改变之前拒绝会引入语法错误的 edit 与 write 调用的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-edit-syntax-guard

[English](README.md) | 中文

## 概述

使用 `dsh-edit-syntax-guard` 拒绝会引入语法错误的 `edit` 与 `write` 调用。调用运行之前，守卫在内存中应用该编辑，用 tree-sitter 解析编辑前后的文件；当新文本的语法问题更多时拒绝该调用。文件不会改变，模型会收到出错位置和带行号的上下文，以便重试。

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

在 `dsh-tool-fs` 与文件系统提供方之后挂载本插件。base bundle 仅在设置 `DSH_EDIT_SYNTAX_GUARD` 时挂载它。

### 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `editTool` | `edit` | 字面编辑工具的名称。 |
| `writeTool` | `write` | 整文件写入工具的名称。 |
| `extensions` | Python、JavaScript、TypeScript、TSX、Go、Rust 与 Java 的 12 个扩展名 | 小写扩展名（含点）到语法的映射。其他文件不检查。 |
| `maxFileBytes` | 2000000 | 更大的文件不检查。 |
| `contextLines` | 2 | 摘录两侧的上下文行数。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

- 守卫监听 `tools/pre-execute`。仅当上游决定为 `allow` 或 `ask` 时才检查调用，因此其他策略的拒绝优先，也不会请人类批准一个本会被拒绝的编辑。
- `edit` 按本地提供方的字面规则模拟：文本统一为 LF，并替换 `old_string` 的每一处出现。工具本身会拒绝的编辑（无匹配、匹配不唯一）直接放行，由工具报告自己的错误。
- 守卫比较 `ERROR` 节点与缺失节点的数量。已有语法错误的文件仍可编辑，只要编辑不增加新的错误。
- 守卫失败（文件不可读、语法加载错误）时记录警告并放行调用。
- 语法来自 `@vscode/tree-sitter-wasm`（WASM，无原生构建）。每个插件实例拥有一个解析器运行时及其语法缓存。

-----

<a id="further-exploration"></a>
## 延伸阅读

- 本守卫检查的 `edit` 与 `write` 工具见 [`dsh-tool-fs`](../tool-fs/README.zh.md)。
- `tools/pre-execute` 见 [`dsh-tools` 扩展点](../../core/tools/README.zh.md#extension-points)。

-----

<a id="model-experience"></a>
## 模型体验

### 拒绝

#### 模型看到的内容

被拒绝的调用返回错误码为 `EDIT_SYNTAX_REGRESSION` 的工具错误：

##### 拒绝示例

```markdown
Error: Edit rejected: the change at m.py:5 would introduce a syntax error. The file was not changed.
  3 |
  4 |
> 5 | def sub(a, b)
  6 |     return a - b
  7 |
Fix the replacement text and retry the edit.
```

#### Token 影响

仅被拒绝的调用增加这些 token：一行标题、`2 * contextLines + 1` 行摘录和一行说明。

#### KV 缓存影响

仅追加；拒绝信息位于可复用的请求前缀之后。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **仅检查语法** — 守卫不运行 linter、类型检查器或 LSP 诊断。
- **字面编辑模拟** — 模拟遵循本地文件系统提供方。编辑规则不同的提供方可能使守卫跳过检查或误判。
- **新文件的位置是近似的** — tree-sitter 的错误恢复可能把 `ERROR` 节点放在外层块的开头。编辑定位到其第一处改动行；整个新文件使用解析器给出的位置。
- **单文件运行时** — WASM 文件从已安装的包中读取；单文件可执行程序必须在二进制旁边附带它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

依据：SWE-agent（arXiv:2405.15793）在 SWE-bench Lite 上测得：带 lint 守卫的编辑命令解决率为 18.0%，不带时为 15.0%。

</details>
