---
description: "一个编辑意图检查：供希望在 old_string 仅因行尾空白或 Unicode 标点与文件不符时，为重试返回文件确切文本的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-edit-near-miss

[English](README.md) | 中文

## 概述

使用 `dsh-edit-near-miss` 降低修复失败 `edit` 调用的成本。当字面 `old_string` 不在文件中，但规范化后恰好有一段文本与之匹配时，插件会在文件改变之前拒绝该调用。模型会收到该段的行范围，以及以 JSON 字符串给出、可用作 `old_string` 的确切文件文本。规范化会去除每行行尾空白，并把 NFKC 形式、Unicode 引号、破折号与空格映射为 ASCII。当 `old_string` 没有这样的匹配，但以字面字符包含 `\u00a0` 这类转义文本时，会解码这些转义后再搜索一次。

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

在文件系统提供者之后、`dsh-fs-observation-policy` 之前挂载本插件。base bundle 仅在设置 `DSH_EDIT_NEAR_MISS` 时挂载它。

### 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `maxFileChars` | 2000000 | 超过该 UTF-16 码元数的文件不检查。 |
| `maxQuotedChars` | 8000 | 提示中引用的确切文本最大长度。更长的文本只给出行范围。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

- 插件以前置方式监听 `edit` 工具的 `fs/edit-intent` 槽位，因为 `dsh-fs-observation-policy` 占用该槽位且不调用 `next()`，而插件加载顺序并不遵循配置行的顺序。它先调用 `next()`，因此先读后写策略先做决定，且该策略的错误优先。
- 匹配在 LF 规范化文本的规范化空间中进行，每行保持其行号。只有唯一的规范化匹配会产生提示。字面匹配、无匹配或两处以上匹配都会直接放行，由工具报告自身的结果或错误。
- 只有当 NFKC 把首尾两行匹配行的每个码元都映射为一个码元时，才会从原文件截取确切文本，因为其余替换都是一个 UTF-16 码元换一个。否则提示只给出行范围。引用的文本使用 LF 换行符，因为 edit 工具按 LF 规范化后的文本匹配；不可见字符与类空格字符（例如 U+00A0）以 `\uXXXX` JSON 转义显示。
- 只有当匹配在文件某行的行尾结束时，`old_string` 最后一行的行尾空白才会被忽略，因此 `foo ` 不会匹配 `foobar` 中的 `foo`。
- 插件从不写入文件，也从不自行应用规范化匹配。
- 检查失败（例如文件不可读）时记录警告，并让工具照常运行。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`dsh-tool-fs`](../tool-fs/README.zh.md)：`edit` 工具及其字面匹配。
- [`dsh-edit-syntax-guard`](../edit-syntax-guard/README.zh.md)：同一槽位上的另一项检查。

-----

<a id="model-experience"></a>
## 模型体验

### 近似匹配拒绝

#### 模型看到的内容

被拒绝的调用返回代码为 `EDIT_NEAR_MISS` 的工具错误。当确切文本可以截取且长度不超过 `maxQuotedChars` 时，最后一行是以 JSON 字符串给出的该文本；否则提示以读取指令结尾，且不引用文件文本：

##### 拒绝示例

```markdown
Error: old_string was not found in g.py as written, but it matches one passage (lines 1-2) when trailing whitespace and Unicode quotes, dashes and spaces are ignored. The file was not changed.
Retry the edit with old_string set to the exact file text of that passage, given here as a JSON string in which invisible characters are \uXXXX escapes:
"def greet(name):  \n    msg = \"hi\"  \n"
```

##### 字面转义文本的拒绝示例

```markdown
Error: old_string was not found in README.md as written: it contains escape text such as \u00A0 as literal characters. With those escapes decoded, it matches one passage (line 3). The file was not changed. In the tool arguments, write a special character as one JSON escape such as \u00A0, not as the text \\u00A0.
Retry the edit with old_string set to the exact file text of that passage, given here as a JSON string in which invisible characters are \uXXXX escapes:
"The widget\u00A0service stores every\u00A0record."
```

##### 不引用文本的拒绝示例

```markdown
Error: old_string was not found in g.py as written, but it matches one passage (line 4) when trailing whitespace and Unicode quotes, dashes and spaces are ignored. The file was not changed.
Read line 4 and copy old_string from the file exactly, then retry the edit.
```

#### Token 影响

只有近似匹配会增加 token：两行文字加上引用的文本，长度约等于失败的 `old_string`。没有本插件时，模型通常会在重试前再次读取文件。

#### KV Cache 影响

仅追加；拒绝信息位于可复用的请求前缀之后。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **多一次调用** — 插件无法修改工具参数，因此模型必须再发送一次 `edit` 调用。在文件系统提供者内部应用唯一的规范化匹配可以省去这次调用；这会改变 `dsh-fs-local` 的行为，本包不做此改动。
- **不规范化缩进** — 行首空白必须一致，因为缩进变化可能改变程序含义（例如 Python）。
- **仅限唯一匹配** — 使用 `replace_all` 时，匹配两处以上的文本不会得到提示。
- **仅限 base bundle** — Web 应用的预设不挂载本插件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

证据：arXiv:2609.11957 测得在文本漂移下，search/replace 的应用成功率为精确匹配 0.176、空白规范化匹配 0.571，且在拒绝歧义匹配时无静默误应用。规范化集合沿用 pi coding agent（`packages/coding-agent/src/core/tools/edit-diff.ts` 中的 `normalizeForFuzzyMatch`）。

</details>
