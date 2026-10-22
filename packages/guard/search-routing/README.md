---
description: "A pre-execution guard for users and maintainers who want shell repository searches redirected to the code_search, grep and glob tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-search-routing

English | [中文](README.zh.md)

## Summary

Use `dsh-search-routing` to make the model use the search tools instead of the shell. A shell call whose command is only a repository search is denied before it runs. The denial names the visible replacement tools: `code_search` for behaviour, `grep` for exact text, `glob` for file paths. Commands that do other work, such as running tests or filtering program output, are not changed.

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

Mount the plugin with the tool runtime. The base bundle mounts it only when `DSH_SEARCH_ROUTING` is set.

### Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `shellTools` | `['bash']` | Shell tools whose `command` argument is checked. |
| `maxQuotedChars` | 200 | Maximum characters of the denied command in the denial text. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

- The guard listens on `tools/pre-execute` and checks a call only when the upstream decision is `allow` or `ask`.
- A command is a search when each `&&`, `||` or `;` statement is neutral (`cd`, `echo`) or a pipeline that starts with `rg`, `ag`, `ack`, `fd`, `git grep`, a recursive `grep`, or `find` with a name or path test, and continues only with filters such as `head`, `sort` or a non-recursive `grep`. At least one statement must be a search.
- Command substitution, redirection, subshells and `&` make the command "not a search", so the guard never denies a command that it cannot classify. The guard ignores `2>/dev/null` and `2>&1`, because they only discard or merge error output.
- When none of `code_search`, `grep` and `glob` is visible to the caller, nothing is denied.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-tool-code-search`](../../fs/tool-code-search/README.md) and [`dsh-tool-fs-search`](../../fs/tool-fs-search/README.md) for the replacement tools.

-----

<a id="model-experience"></a>
## Model Experience

### Denial

#### What the model sees

A denied call returns a tool error with code `SHELL_SEARCH_ROUTED`:

##### Example denial

```markdown
Error: Shell search was not run: `grep -rn "applyLiteralEdit" packages/`. Search with code_search with a description of the behaviour, to find where it is implemented; the grep tool for exact text or a regular expression; the glob tool for file paths. Use the shell for other work, such as running tests.
```

#### Token effect

Only a denied call adds these tokens: one line of about 60 tokens plus the quoted command.

#### KV Cache effect

Append-only; the denial follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Heuristic classifier** — the guard reads shell words, not a full shell grammar. An unusual search form is not routed.
- **No allow list** — a search that the replacement tools cannot express (for example, binary files) must use another shell form.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

In a 42-run A/B, DeepSeek called `code_search` in 2 of 28 runs where it was available and searched with `bash` in almost every run, although the system prompt asked for `code_search`. SWE-agent (arXiv:2405.15793) measured 18.0% vs 12.0% with dedicated, summarized search commands instead of iterative shell search.

</details>
