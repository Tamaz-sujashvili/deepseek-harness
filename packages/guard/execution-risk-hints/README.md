---
description: "Advisory notes on shell results for users and maintainers who want the agent told about repeated errors, weak checks, and long foreground runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-execution-risk-hints

English | [中文](README.zh.md)

## Summary

Use `dsh-execution-risk-hints` to give the agent short notes about risk patterns in its shell commands. After each foreground shell call, the plugin updates a record for the agent. When a pattern occurs for the first time after the last user message, the plugin attaches a note to the tool result. The plugin finds four patterns. These are repeated error lines, checks that do not stop at a failure, checks of help text or syntax only, and long commands. The plugin does not block or change a call.

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

The base bundle mounts the plugin only when `DSH_EXECUTION_RISK_HINTS` is set. Use it for long unattended tasks in which the agent runs many shell commands.

### Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `shellTools` | `bash` | Tools whose `command` argument is a shell command line. |
| `detectors` | All four | Detectors to run: `repeated-error`, `time-budget`, `non-fail-fast-check`, `shallow-check`. |
| `errorRepeatThreshold` | 2 | Number of consecutive failed commands with the same error line that cause a note. |
| `longStepMs` | 120000 | Duration in milliseconds from which a foreground command is long. |
| `budgetMs` | 420000 | Total time in long commands that causes a note when no timeout occurred. |
| `maxNotesPerCall` | 2 | Maximum number of notes on one tool result. |

A number less than 1 or an unknown detector stops the plugin load with an error.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

- `tools/pre-execute` records the start time of each shell call after the pre-execute decision. `tools/post-execute` reads the foreground result value: exit code, timeout state, stdout, and stderr. A result of a command that moved to the background is a timeout. Background jobs and failed calls are ignored.
- `repeated-error`: the error line is the last exception line of the output, or else the first line that contains an error word. Numbers become `N` and hexadecimal addresses become `ADDR`. A command that fails with no error line, for example `grep` with no match, resets the count.
- `time-budget`: a note when there are two or more long commands and one timeout, or when the total time of long commands is `budgetMs` or more.
- `non-fail-fast-check`: a note for a multi-step check script that runs `diff`, `cmp`, `grep -q`, or `test -f` and prints a message. The note occurs only when the script has no `set -e`, `|| exit`, or `trap ... exit`.
- `shallow-check`: a note for a check that runs only `--help`, `-h`, `py_compile`, `node --check`, `bash -n`, or an existence command such as `ls`. Each step of the command must be of these types. The note occurs only before the first test or script run.
- Each note key is sent one time for each user message. The notes ride the decision's `additionalContexts`, so the `tool/result` event keeps the tool's own output.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-repeat-tool-reminder`](../repeat-tool-reminder/README.md) for identical repeated calls.
- [`dsh-verify-before-finish`](../verify-before-finish/README.md) for the check at the end of a turn.

-----

<a id="model-experience"></a>
## Model Experience

### Execution notes

#### What the model sees

After the tool result, the model receives one user message with the source `execution-risk-hints`. It starts with `Execution notes:` and lists one or two notes. This example is the note for a repeated error. The other notes use the text in the `observe` function of `src/index.ts`.

##### Repeated error note

```markdown
Execution notes:
- The last 2 shell commands failed with the same error:
`ModuleNotFoundError: No module named 'foo'`
The approach behind them has not changed the outcome. Before you run another variant, check the assumption it depends on (path, working directory, installed module, function signature, test name) and change the approach.
```

#### Token effect

Zero tokens when no pattern occurs. Each note is approximately 40 to 80 tokens, and each note key occurs at most one time for each user message.

#### KV Cache effect

The note is appended after the tool result. It does not change the earlier request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Detectors are regular expressions** — they can miss a pattern or report a false one. Each note is advice only.
- **Durations include queue time** — the time from `tools/pre-execute` to `tools/post-execute` includes approval waits.
- **Benchmark-specific detectors are not ported** — the source middleware also has detectors for localhost checks, performance margins, and model wrappers. This package does not include them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Source: `ExecutionRiskHintsMiddleware` of the evolved harness in arXiv:2604.25850 (AHE). Its middleware-only ablation gave 71.9% against 69.7% on Terminal-Bench 2. The repeated-error note states the failure in words and does not tell the model only "do not repeat": arXiv:2608.23651 found that a do-not-repeat instruction did not reduce repetition, and a runtime description of the failure did. arXiv:2607.28871 found that a generic reminder about check quality reduced closure on weak evidence by 3.2 points.

</details>
