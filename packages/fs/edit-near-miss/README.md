---
description: "An edit-intent check for users and maintainers who want an edit whose old_string misses the file only by trailing whitespace or Unicode punctuation to return the exact file text for a retry."
kind: "package-reference"
---

# @deepseek-ai/dsh-edit-near-miss

English | [中文](README.zh.md)

## Summary

Use `dsh-edit-near-miss` to make failed `edit` calls cheaper to fix. When the literal `old_string` is not in the file, but exactly one passage matches it after normalization, the plugin denies the call before the file changes. The model receives the line range and the exact file text as a JSON string to use as `old_string`. The normalization removes trailing whitespace on each line and maps NFKC forms, Unicode quotes, dashes and spaces to ASCII. When `old_string` has no such match but contains escape text such as `\u00a0` as literal characters, the search runs again with those escapes decoded.

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

Mount the plugin after a filesystem provider and before `dsh-fs-observation-policy`. The base bundle mounts it only when `DSH_EDIT_NEAR_MISS` is set.

### Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `maxFileChars` | 2000000 | Files longer than this many UTF-16 code units are not checked. |
| `maxQuotedChars` | 8000 | Longest exact passage quoted in a hint. A longer passage gets only its line range. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

- The plugin listens on the `fs/edit-intent` slot of the `edit` tool, prepended, because `dsh-fs-observation-policy` occupies that slot without calling `next()` and plugin load order does not follow row order. It calls `next()` first, so the read-before-write policy decides first and its error wins.
- The match runs on LF-normalized text in normalized space, where each line keeps its index. Only a unique normalized match produces a hint. A literal match, no match, or two or more matches pass through, and the tool reports its own result or error.
- The exact text is cut from the original file only when NFKC maps each code unit of the first and last matched lines to one code unit, because each other substitution replaces one UTF-16 code unit with one. Otherwise the hint gives only the line range. The quoted text uses LF line endings, as the edit tool matches LF-normalized text, and shows invisible and space-like characters (for example U+00A0) as `\uXXXX` JSON escapes.
- Trailing whitespace on the last line of `old_string` is ignored only when the match ends at the end of a file line, so `foo ` does not match the `foo` of `foobar`.
- The plugin never writes the file and never applies a normalized match itself.
- A check failure (for example, an unreadable file) logs a warning and lets the tool run.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-tool-fs`](../tool-fs/README.md) for the `edit` tool and its literal matching.
- [`dsh-edit-syntax-guard`](../edit-syntax-guard/README.md) for the other check on the same slot.

-----

<a id="model-experience"></a>
## Model Experience

### Near-miss denial

#### What the model sees

A denied call returns a tool error with code `EDIT_NEAR_MISS`. When the exact text can be cut out and is not longer than `maxQuotedChars`, the last line is that text as a JSON string; otherwise the hint ends with a read instruction and quotes no file text:

##### Example denial

```markdown
Error: old_string was not found in g.py as written, but it matches one passage (lines 1-2) when trailing whitespace and Unicode quotes, dashes and spaces are ignored. The file was not changed.
Retry the edit with old_string set to the exact file text of that passage, given here as a JSON string in which invisible characters are \uXXXX escapes:
"def greet(name):  \n    msg = \"hi\"  \n"
```

##### Example denial for literal escape text

```markdown
Error: old_string was not found in README.md as written: it contains escape text such as \u00A0 as literal characters. With those escapes decoded, it matches one passage (line 3). The file was not changed. In the tool arguments, write a special character as one JSON escape such as \u00A0, not as the text \\u00A0.
Retry the edit with old_string set to the exact file text of that passage, given here as a JSON string in which invisible characters are \uXXXX escapes:
"The widget\u00A0service stores every\u00A0record."
```

##### Example denial without quoted text

```markdown
Error: old_string was not found in g.py as written, but it matches one passage (line 4) when trailing whitespace and Unicode quotes, dashes and spaces are ignored. The file was not changed.
Read line 4 and copy old_string from the file exactly, then retry the edit.
```

#### Token effect

Only a near miss adds tokens: two lines plus the quoted passage, which is about as long as the failed `old_string`. Without the plugin, the model usually reads the file again before it retries.

#### KV Cache effect

Append-only; the denial follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One extra call** — the plugin cannot change tool arguments, so the model must send a second `edit` call. Applying a unique normalized match inside the filesystem provider would remove that call; that changes `dsh-fs-local` behavior and is not done here.
- **Indentation is not normalized** — leading whitespace must match, because a changed indentation can change program meaning (for example, in Python).
- **Unique matches only** — with `replace_all`, a passage that matches two or more times gets no hint.
- **Base bundle only** — the Web app presets do not mount the plugin.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Evidence: arXiv:2609.11957 measured search/replace apply success under drift at 0.176 for exact matching and 0.571 for whitespace-normalized matching, with zero silent misapplications when ambiguous matches are refused. The normalization set follows the pi coding agent (`normalizeForFuzzyMatch` in `packages/coding-agent/src/core/tools/edit-diff.ts`).

</details>
