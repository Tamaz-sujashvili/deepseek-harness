---
description: "A compaction backend for users and maintainers who want every compaction summary to end with deterministic lists of the files that the compacted history read and modified."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-file-tracking

English | [中文](README.zh.md)

## Summary

Use `dsh-compaction-file-tracking` to keep exact file paths across compaction. The engine is `dsh-compaction-basic` with one change: after the model writes a summary, the engine appends a `<read-files>` list and a `<modified-files>` list. The lists come from the file-path arguments of the compacted tool calls and from the lists of an earlier summary, so they accumulate across compactions. The model does not write these lists, so they cannot drop or invent a path.

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

Mount this package in place of `dsh-compaction-basic`; both register the `compaction` service, so mount only one. The base bundle mounts this package and disables `dsh-compaction-basic` only when `DSH_COMPACTION_FILE_TRACKING` is set.

### Configuration

All `dsh-compaction-basic` keys apply unchanged. This package adds two keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `fileTools` | `read`, `code_outline`, `code_read_symbol` (read); `edit`, `write` (modified) | Rules `{ tool, argument, kind }` that name the file-path argument of each tool. A configured list replaces the default list. |
| `maxFiles` | 50 | Most paths kept in each list. The most recently used paths are kept. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

- The engine overrides the documented `summarize()` hook of `BasicCompactionEngine`. Pressure, retention, overflow recovery and the durable Session events do not change.
- A tool call counts when its result in the compacted region is not an error. A call whose result is outside the region also counts.
- Lists in an earlier checkpoint (a user message with a compaction-checkpoint source) count as uses at their position, so paths carry forward. List tags in other messages are ignored. A path that was modified is listed only under `<modified-files>`. Paths are kept as the tool call wrote them.
- Lists that the model wrote are removed from its summary before the collected lists are appended, so each summary has one copy.
- The lists are part of the summary content of the logged `compaction/summary` event and of the replacement `user/message`, so replay rebuilds the same request.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-compaction-basic`](../compaction-basic/README.md) for the summary prompt, thresholds and retention that this engine uses.

-----

<a id="model-experience"></a>
## Model Experience

### File lists in the compaction summary

#### What the model sees

The summary inside `<compacted-summary>` ends with one or two lists. An empty list is omitted:

##### Example lists

```markdown
<read-files>
src/config.ts
tests/config.spec.ts
</read-files>

<modified-files>
src/index.ts
</modified-files>
```

#### Token effect

Each summary grows by one line per listed path plus two tag lines per list, capped by `maxFiles`. The summarization request itself does not change.

#### KV Cache effect

Replacing, as for `dsh-compaction-basic`: the summary replaces the compacted region once per compaction. The lists add no other change to the request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Tool arguments only** — files that `bash` reads or changes (for example `sed -i`) are not listed.
- **Paths are not normalized** — a relative and an absolute path to one file are two entries. A path that contains a line ending is not listed.
- **Lists are parsed from text** — an earlier summary carries its lists only as `<read-files>` and `<modified-files>` text blocks; other summarizers that drop them break the carry-forward.
- **Base bundle only** — the Web app presets mount `dsh-compaction-basic`, so `DSH_COMPACTION_FILE_TRACKING` does not change Web agents.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Evidence: CORVUS (arXiv:2607.22711) keeps a registry of the files an agent works on and reports 9-50% fewer input tokens per task at comparable pass rates. MemTrace (arXiv:2610.04838) anchors compacted memory to files and symbols so that the agent can rebuild its state after a context refresh. The list format follows the pi coding agent (`packages/coding-agent/src/core/compaction/utils.ts`).

</details>
