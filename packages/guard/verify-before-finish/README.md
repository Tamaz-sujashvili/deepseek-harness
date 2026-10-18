---
description: "A turn-stop gate for users and maintainers who want the agent to run one check after its last edit before it finishes."
kind: "package-reference"
---

# @deepseek-ai/dsh-verify-before-finish

English | [中文](README.zh.md)

## Summary

Use `dsh-verify-before-finish` to stop an agent from finishing with edits that no check covers. The plugin records file edits and verification commands for each agent after each user message. A turn can close with edits and no passing test or reproduction command after the last edit. In that case, the plugin sends one message that names the changed files and asks for a check. The agent then continues for one more step. The plugin does not block a tool call and does not run commands.

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

The base bundle mounts the plugin only when `DSH_VERIFY_BEFORE_FINISH` is set. Use it for unattended coding tasks, where a final answer without a check is a frequent cause of a wrong patch. Do not use it for interactive sessions in which the user wants to run the checks.

### Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `editTools` | `edit`, `write`, `str_replace_editor` | Tools whose successful calls are file edits. |
| `readOnlyCommands` | `view` | Values of the `command` argument of an edit tool that do not change files. |
| `shellTools` | `bash` | Tools whose `command` argument is a shell command line. |
| `verifyPatterns` | Test runners and script runs | Regular expressions. A matching shell command is a check. |
| `shellEditPatterns` | `sed -i`, `perl -i`, `git apply`, `patch`, redirects into source files | Regular expressions. A matching shell command is an edit. |
| `maxHoldsPerPrompt` | 1 | Maximum number of messages for one user message. |
| `maxListedPaths` | 8 | Maximum number of file paths in one message. |

An invalid regular expression or a number less than 1 stops the plugin load with an error.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

- `tools/post-execute` records evidence. A successful call to an edit tool adds its `file_path` or `path` argument to the edited files. A foreground shell call that matches `shellEditPatterns` adds an edit with no path. A foreground shell call that matches `verifyPatterns`, after an edit, becomes the last check with its exit code. When one command both edits and checks, the plugin applies them in command-line order.
- `agent/turn-stopping` reads the evidence. The plugin calls `agent.steer()` with one message when there are edits and no passing check after the last edit. A check that reached its timeout does not pass. The loop then runs one more step.
- `agent/pre-step` deletes the evidence of an agent when a user message arrives. Edits from an earlier request do not cause a message.
- The state is in memory for each agent. A resumed session starts with no evidence.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-execution-risk-hints`](../execution-risk-hints/README.md) for notes on weak checks during the turn.
- [Agent lifecycle](../../../docs/agent-lifecycle.md) for the `agent/turn-stopping` boundary and steering.

-----

<a id="model-experience"></a>
## Model Experience

### Verification gap message

#### What the model sees

At the end of a turn with unchecked edits, the model receives one of these two messages as a user message with the source `verify-before-finish`. The first is for edits with no check after them. The second is for a failed check after the edits.

##### No check after the edits

```markdown
No test or reproduction command has run successfully after your latest edits.
Files changed since the user's last message:
- <path>
Before you finish, run one command that exercises the changed behavior (the relevant tests or a reproduction of the issue) and read its result. If no such check is possible here, state that in your answer.
```

##### Failed check after the edits

```markdown
The last check after your edits did not pass: `<command>` exited with code <code>.
Files changed since the user's last message:
- <path>
Before you finish, fix the cause and run the check again, or state in your answer why this result is expected.
```

#### Token effect

Zero tokens when the turn ends with a passing check or without edits. Otherwise one message of approximately 60 to 120 tokens, plus the tokens of the additional step.

#### KV Cache effect

The message is appended after the last assistant message. It does not change the earlier request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Pattern matches are heuristic** — the plugin does not see a shell write that `shellEditPatterns` does not match. Also, a script run that is not a test counts as a check.
- **A passing check is not proof** — the plugin does not know if the check exercises the changed behavior.
- **No check for subagent results** — edits that a subagent makes are recorded for the subagent, not for its parent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Evidence: arXiv:2607.28815 (ECLoop) holds edits and the final submission until the trajectory shows the necessary evidence. On SWE-bench Verified, Pass@1 increased by 4.8 to 11.8 points. In the ablation, the commitment check alone contributed 10 points.

arXiv:2604.25850 (AHE) reports a middleware-only gain of 2.2 points on Terminal-Bench 2 for a closure check before finish. arXiv:2607.28871 found that 46.0% of passing validation events did not discriminate the bug, so a passing check is weak evidence. The default `maxHoldsPerPrompt` of 1 follows AHE (one closure check). ECLoop uses a budget of 3.

</details>
