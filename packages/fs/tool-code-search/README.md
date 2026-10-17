---
description: "The model-facing code_search and code_related tools for users and maintainers who give agents semantic and structural code search over a senior-code-mcp index."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-code-search

English | [中文](README.zh.md)

## Summary

Use `dsh-tool-code-search` to give models semantic and structural code search over a [senior-code-mcp](https://github.com/Tamaz-sujashvili/senior-code-mcp) index. `code_search` returns the functions, classes and methods that match a natural-language or code query, with their source and their graph neighbours. `code_related` returns the callers, callees and imports of named symbols. `code_outline` lists the definitions of one file with line ranges, and `code_read_symbol` returns the exact source of one definition; both parse the file at call time and need no index. Keep `dsh-tool-fs-search` (`grep`, `glob`) for exact identifiers, strings and regular expressions.

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

1. Install senior-code-mcp and start Qdrant and Ollama. Refer to the senior-code-mcp README.
2. Index the workspace: `senior-code-ingest <workspace>`.
3. Set `DSH_CODE_SEARCH_COMMAND` to the absolute path of the `senior-code-search` executable. The base bundle and the Web `standard` preset enable the plugin only when this variable is set.

### Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `command` | required | Argument vector prefix of the `senior-code-search` executable. |
| `repo` | workspace directory name | Ingested repository name that `code_search` returns hits from. `*` returns hits from all repositories. |
| `env` | none | Extra environment for the process, for example `QDRANT_URL`, `QDRANT_COLLECTION`, `GRAPH_PATH`, `OLLAMA_URL`. |
| `topK` | 5 | Default number of hits for one `code_search` call. |
| `maxHitLines` | 40 | Maximum source lines for one hit in the model text. |
| `rawOutputMaxBytes` | 4 MiB | Maximum process output that the tool parses. |
| `timeoutMs` | 60000 | Cooperative time limit for one call. |
| `graceMs` | 2000 | Time between terminate and kill. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

- Each call starts one `senior-code-search` process through `ctx.subprocess.spawn()`. The argument vector is fixed. No shell is used. Each model value is one `--flag=value` argument, so a value that starts with a dash cannot become a flag.
- The process writes one JSON document. Exit code 2 with `{"error": "..."}` is a failure that the tool reports to the model.
- The tool validates each JSON record before it converts it to the canonical value (`CodeSearchResult`, `CodeNode[]`).

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tool catalog entry](../../../docs/tool-catalog.md#deepseek-aidsh-tool-code-search) for the generated schemas.
- [`dsh-tool-fs-search`](../tool-fs-search/README.md) for the `grep` and `glob` tools that stay registered beside this package.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The section renders only while `code_search` is visible. The last sentence renders only while `grep` is visible.

##### Code search guidance

```markdown
When you need to find where some behaviour is implemented, call code_search first, before grep, find or reading files: one call returns the matching functions/classes with their source and their callers/callees. Use code_related to list what calls or is called by a symbol you already know. Use code_outline to see the functions and classes of a file, and code_read_symbol to read one of them, instead of reading the whole file. Use grep only for exact identifiers, strings, or regular expressions.
```

#### Token effect

One section of 430 characters (approximately 110 tokens) on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the visible tool set is unchanged.

### Tool schemas

#### What the model sees

The generated [`code_search`, `code_related`, `code_outline` and `code_read_symbol` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-code-search).

#### Token effect

Fixed schema cost of 2,237 serialized characters (approximately 560 tokens) on every request where the tools are visible.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Results

#### What the model sees

`code_search` returns one block for each hit: `[n] path:start-end kind name (language) score=s`, the first doc line, and at most `maxHitLines` source lines, then a `Related (callers/callees/imports):` list. `code_related` returns one line for each node. `code_outline` returns one `start-end kind qualified` line for each definition. `code_read_symbol` returns a header line and the source with file line numbers, in the `read` layout. Zero hits return a sentence that recommends `grep` or a new index.

#### Token effect

The default result (5 hits, 40 lines each) is the largest part of the cost. It changes with the line length of the code. The result stays in the history until compaction.

#### KV Cache effect

Append-only; new results follow the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


- **The index is not updated automatically** — run `senior-code-ingest` again after large changes.
- **senior-code-mcp keeps one graph file** — the graph contains only the last repository that you indexed.
- **Paths are relative to the indexed repository root** — the `read` tool can open them only when the session workspace is that root.
- **Coverage** — the package has unit tests and a real-process integration test (`DSH_CODE_SEARCH_IT_COMMAND`). It does not yet have a recorded-session snapshot, a Loader-composition test or a Web tool card.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Evidence for the tool split: arXiv:2606.22417 compared one harness with and without a semantic and structural index. The index increased the resolve rate from 41.9% to 50.4% and decreased the turns from 36 to 28. That study used a different model.

</details>
