---
description: "A step budget for users and maintainers who want the agent to know how many model steps remain and to stop after a set number of steps."
kind: "package-reference"
---

# @deepseek-ai/dsh-step-budget

English | [中文](README.zh.md)

## Summary

Use `dsh-step-budget` to limit the model steps of one agent for one user message. At set thresholds, the agent gets a short notice with the steps that it used and the steps that remain. When the budget is reached, the agent is told to finish. After a small number of grace steps, the turn ends.

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

Mount the plugin with the agent loop and the tool runtime. The base bundle mounts it only when `DSH_STEP_BUDGET` is set. The value of `DSH_STEP_BUDGET` is `maxSteps`. A value that is not a positive integer gives the default of 100.

### Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `maxSteps` | 100 | Model steps that one agent can take for one user message. |
| `notifyAt` | `[0.5, 0.8]` | Fractions of `maxSteps` at which the agent gets a notice. |
| `graceSteps` | 2 | Steps that are allowed after the budget is reached. After them, the turn ends. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

- On `agent/pre-step`, the plugin counts the steps of each agent. A message from the user sets the count to zero.
- On `tools/post-execute`, when the count reaches a threshold, the plugin sends a notice with `agent.steer()`. The next step receives the notice. The plugin sends each threshold one time.
- The plugin sends notices only after a tool call. Thus a notice never continues a turn that is complete.
- When the count is more than `maxSteps` plus `graceSteps`, the plugin rejects the next step and the turn ends. A step that follows a reply with no tool calls is not rejected, so a turn that the model ends itself completes normally.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-repeat-tool-reminder`](../repeat-tool-reminder/README.md) for a reminder about repeated identical tool calls.

-----

<a id="model-experience"></a>
## Model Experience

### Notices

#### What the model sees

A notice is a user message with the source `step-budget`:

##### Example threshold notice

```markdown
Step budget: 50 of 100 steps used, 50 remain. Plan the rest of the task to fit in the remaining steps.
```

##### Example notice when the budget is reached

```markdown
Step budget reached: 100 of 100 steps used. After 2 more steps, the run stops. Do not explore further. Complete the change you have, then give your final answer.
```

#### Token effect

Each notice adds approximately 30 tokens. With the default configuration, one run gets a maximum of three notices.

#### KV Cache effect

Append-only. Each notice follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Steps only** — the budget counts model steps. It does not count tokens or cost.
- **No hand-off** — when the budget is reached, the plugin does not start a new agent. The run ends with the changes that are on disk.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Budget Tracker (arXiv:2511.17006) gives an agent continuous budget awareness. With it, cost-performance scaling was better than with a larger budget alone. The study used web search agents, not agents that write code. On SWE-bench Verified, more overthinking correlates with a lower resolve rate (arXiv:2502.08235). More iterations do not help runs that are stuck (arXiv:2501.14723).

</details>
