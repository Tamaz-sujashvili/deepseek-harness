# @deepseek-ai/dsh-tool-code-search

English

## Summary

This package gives the model two code search tools that use a [senior-code-mcp](https://github.com/Tamaz-sujashvili/senior-code-mcp) index:

- `code_search`: semantic search. The tool embeds the query and returns the functions, classes and methods that match it. Each hit has the path, the line range, the docstring and the source. The tool also returns the graph neighbours of the hits (callers, callees, imports).
- `code_related`: structural search. The tool returns the callers, callees and imports of the symbols that you name.

`grep` and `glob` from `@deepseek-ai/dsh-tool-fs-search` stay available. Use them for exact identifiers, strings and regular expressions.

## Use this package

1. Install senior-code-mcp and start Qdrant and Ollama. Refer to the senior-code-mcp README.
2. Index the workspace: `senior-code-ingest <workspace>`.
3. Set `DSH_CODE_SEARCH_COMMAND` to the absolute path of the `senior-code-search` executable. The base bundle and the Web `standard` preset enable the plugin only when this variable is set.

Plugin configuration (`cordis.yml`):

| Key | Default | Meaning |
| --- | --- | --- |
| `command` | required | Argument vector prefix of the `senior-code-search` executable. |
| `env` | none | Extra environment for the process, for example `QDRANT_URL`, `QDRANT_COLLECTION`, `GRAPH_PATH`, `OLLAMA_URL`. |
| `topK` | 5 | Default number of hits for one `code_search` call. |
| `maxHitLines` | 40 | Maximum source lines for one hit in the model text. |
| `rawOutputMaxBytes` | 4 MiB | Maximum process output that the tool parses. |
| `timeoutMs` | 60000 | Cooperative time limit for one call. |
| `graceMs` | 2000 | Time between terminate and kill. |

## Understand the implementation

- Each call starts one `senior-code-search` process through `ctx.subprocess.spawn()`. The argument vector is fixed. No shell is used. Each model value is one `--flag=value` argument, so a value that starts with a dash cannot become a flag.
- The process writes one JSON document. Exit code 2 with `{"error": "..."}` is a failure that the tool reports to the model.
- The tool validates each JSON record before it converts it to the canonical value (`CodeSearchResult`, `CodeNode[]`).
- The prompt section `tool:code_search` (order `TOOL_CODE_SEARCH`, after `grep`) tells the model to use `code_search` before it reads files, and to use `grep` only for exact text.

## Model Experience

- Tools added: `code_search` (4 parameters), `code_related` (3 parameters). The serialized schemas are 1,384 characters (approximately 350 tokens) in each request.
- Prompt added: one section of 303 characters (approximately 75 tokens).
- Result size: one hit is a header line, one doc line and at most `maxHitLines` source lines. The default result (5 hits, 40 lines each) is the largest part of the cost. It changes with the line length of the code.
- KV cache: the schemas and the prompt section are static, so they do not break the prompt-prefix cache.
- Evidence: arXiv:2606.22417 compared one harness with and without a semantic and structural index. The index increased the resolve rate from 41.9% to 50.4%. It decreased the turns from 36 to 28. That study used a different model. Do an A/B test on your model.

## Known Limitations and Deferred Work

- The index is not updated automatically. Run `senior-code-ingest` again after large changes.
- senior-code-mcp keeps one graph file. The graph contains only the last repository that you indexed.
- Paths in the results are relative to the indexed repository root. The `read` tool can open them only when the session workspace is that root.
- The package has unit tests and a real-process integration test (`DSH_CODE_SEARCH_IT_COMMAND`). It does not yet have a recorded-session snapshot, a Loader-composition test, a Chinese README or a Web tool card.
