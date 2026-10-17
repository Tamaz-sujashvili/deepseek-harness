---
description: "A model-free compaction step for users and maintainers who want old large tool outputs replaced by one placeholder line, in batches, before each agent step."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-observation-mask

English | [中文](README.zh.md)

## Summary

Use `dsh-compaction-observation-mask` to keep context small without an LLM summary. Before each agent step, the plugin keeps the newest `keepRecent` tool results verbatim and replaces each older result larger than `minChars` with one placeholder line. Model messages and tool calls do not change. The replacements are logged Session events, so replay rebuilds the same request.

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

Mount the plugin with `dsh-token-meter`. The base bundle mounts it only when `DSH_OBSERVATION_MASK` is set.

### Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `keepRecent` | 10 | Newest tool results that always stay verbatim. |
| `minChars` | 400 | Results at or below this size are never masked. |
| `batchSize` | 5 | Minimum number of qualifying results before one masking pass runs. |
| `maxArgumentChars` | 160 | Maximum characters of tool arguments quoted in the placeholder. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

- The plugin listens on `agent/pre-step` and then delegates with `next()`.
- Each replacement follows the shadow protocol of `dsh-compaction-tool-result-pruner`: a `compaction/prune` shadow-price event, then a `tool/result` event that replaces the node on the Session surface and cites it in `sourceEventSeqs`.
- Masking runs only when at least `batchSize` results qualify. This changes the request prefix once for each batch, not at each step.
- A failed pass logs a warning; the step continues.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-compaction-tool-result-pruner`](../compaction-tool-result-pruner/README.md) for the shadow protocol that this plugin reuses.
- [`dsh-compaction-basic`](../compaction-basic/README.md) for LLM summarization near the context limit.

-----

<a id="model-experience"></a>
## Model Experience

### Masked tool results

#### What the model sees

Each masked result becomes one line:

##### Placeholder

```markdown
[Older tool output elided to save context: bash({"command":"cat file1.py"}) returned 1000 characters. Run the tool again if you need this output.]
```

#### Token effect

Each masked result shrinks to one line. The newest `keepRecent` results and small results keep their full size.

#### KV Cache effect

A masking pass changes the request from the first masked result onward, so the provider cache is reused only up to that point on the next request. Batching (`batchSize`) limits how often this happens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Age is counted in tool results, not turns** — a step with many parallel tool calls ages earlier results faster.
- **No recovery path** — the original output stays in the Session log but not in the request; the model must run the tool again.
- **Defaults are not tuned for this harness** — `keepRecent` and `batchSize` come from other agent scaffolds; tune them with an A/B test.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Evidence: arXiv:2508.21433 found that masking old observations halved agent cost and matched or beat LLM summarization on SWE-bench Verified. arXiv:2405.15793 (SWE-agent) found that the last 5 observations gave 18.0% vs 15.0% with the full history.

</details>
