---
description: "A guard for users and maintainers who want edit and write calls that add syntax errors to be denied before the file changes."
kind: "package-reference"
---

# @deepseek-ai/dsh-edit-syntax-guard

English | [中文](README.zh.md)

## Summary

Use `dsh-edit-syntax-guard` to deny `edit` and `write` calls that add syntax errors. Before the tool changes the file, the guard applies the edit in memory, parses the file before and after with tree-sitter, and denies the call when the new text has more syntax problems. The file does not change, and the model receives the location and numbered context lines so it can retry.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Setup

Mount the plugin with a filesystem provider and `dsh-tool-fs`. Its position relative to `dsh-fs-observation-policy` does not matter. The base bundle mounts it only when `DSH_EDIT_SYNTAX_GUARD` is set.

### Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `extensions` | 12 extensions for Python, JavaScript, TypeScript, TSX, Go, Rust and Java | Lower-case extension (with dot) to grammar. Other files are not checked. |
| `maxFileBytes` | 2000000 | Larger files are not checked. |
| `contextLines` | 2 | Context lines on each side of the excerpt. |
| `maxProblems` | 50 | Problems counted per parse. A file that already has this many problems is not checked. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

- The guard listens on the `fs/edit-intent` and `fs/write-intent` slots, which run inside the `edit` and `write` tools after approval and path resolution. Both listeners are prepended, because `dsh-fs-observation-policy` occupies these slots without calling `next()` and plugin load order does not follow row order. Each listener calls `next()` first, so the read-before-write policy decides first and its error wins.
- `edit` is simulated with the local provider's literal rules: LF-normalized text, and every occurrence of `old_string` replaced. An edit that the tool itself rejects (no match, ambiguous match) passes through, so the tool reports its own error.
- The guard compares the number of `ERROR` and missing nodes. A file that already has syntax errors can still be edited, as long as the edit does not add more.
- A guard failure (unreadable file, grammar load error) logs a warning and allows the call.
- Grammars come from `@vscode/tree-sitter-wasm` (WASM, no native build). Each plugin instance owns one parser runtime and its grammar cache.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-tool-fs`](../tool-fs/README.md) for the `edit` and `write` tools that this guard checks.
- [`dsh-fs-observation-policy`](../fs-observation-policy/README.md) for the read-before-write policy on the same slots.

-----

<a id="model-experience"></a>
## Model Experience

### Denial

#### What the model sees

A denied call returns a tool error with code `EDIT_SYNTAX_REGRESSION`:

##### Example denial

```markdown
Error: Edit rejected: the change at m.py:5 would introduce a syntax error. The file was not changed.
  3 |
  4 |
> 5 | def sub(a, b)
  6 |     return a - b
  7 |
Fix the replacement text and retry the edit.
```

#### Token effect

Only a denied call adds these tokens: one header line, `2 * contextLines + 1` excerpt lines and one instruction line.

#### KV Cache effect

Append-only; the denial follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Syntax only** — the guard does not run linters, type checkers or LSP diagnostics.
- **Literal edit simulation** — the simulation follows the local filesystem provider. A provider with different edit rules can make the guard skip or misjudge a check.
- **Location is approximate for new files** — tree-sitter error recovery can place an `ERROR` node at the start of the enclosing block. An edit is located at its first changed line; a whole new file uses the parser position.
- **Single-file runtimes** — the WASM files are read from the installed package; a single-file executable must ship them beside the binary.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Evidence: SWE-agent (arXiv:2405.15793) measured 18.0% resolve rate with a lint-guarded edit command vs 15.0% without it on SWE-bench Lite.

</details>
