# Proposal: agent tool upgrades after code search

Status: proposal. Date: 2026-10-18. Branch: `feat/code-search` in the `Tamaz-sujashvili/deepseek-harness` fork.

## 1. Purpose

The `feat/code-search` branch adds semantic and structural code search (`code_search`, `code_related`). This document proposes the next tool changes. The objective is the same: a higher resolve rate on SWE-bench-style tasks and fewer tokens for each task.

Each proposal has:

- the current behaviour of the harness, from the source code,
- the change,
- the evidence (arXiv identifier and result),
- the expected effect and the confidence.

## 2. Evidence rules

- The research pass got all identifiers from the academic search tools. It did not invent identifiers. Most sources from 2025 and 2026 are arXiv preprints and are not peer-reviewed. SWE-agent (NeurIPS 2024) and AutoCodeRover (ISSTA 2024) are peer-reviewed.
- Most studies used Claude, GPT or Qwen models. No study measured these changes on DeepSeek models in this harness. The effect on DeepSeek models is not known. Section 5 gives the test procedure.
- "Full text" means that the number comes from the body of the paper. "Abstract" means that the number comes only from the abstract.

## 3. Summary

| Priority | Change | Harness today | Expected quality | Expected tokens | Confidence |
| --- | --- | --- | --- | --- | --- |
| P1 | Syntax and lint check after each edit | No check after `edit` / `write` | +1 to +3 pp | Fewer failed edits | High |
| P1 | Mask old tool results by age | Compaction is by size and by LLM summary only | Neutral to +2.6 pp | About -50% cost | High |
| P2 | Outline and symbol read | `read` returns up to 2,000 lines; no outline | +1 to +5 pp | -12 to -41% input | Medium |
| P2 | Best-of-N patch selection (opt-in) | No patch selection | +6 to +12 pp | N times the cost | High |
| P3 | Test-log extraction for test runners | Head/tail retention and spill | Neutral | Depends on cache | Low |
| P3 | Retry only on external feedback; turn budget | Repeat-call reminder only; no turn limit | Small | Fewer wasted turns | Medium |
| P3 | Deferred tool schemas | All schemas in each request, or PTC mode | Neutral | Smaller requests | Medium |
| No | Mandatory reproduction test in a single run | Not present | About 0 or negative | More tokens | Medium |

## 4. Proposals

### 4.1 P1: syntax and lint check after each edit

Harness today: `fs/tool-fs` `edit` replaces an exact `old_string`. `fs-observation-policy` makes sure that the file was read first. Nothing parses the file after the edit. The LSP client ignores `publishDiagnostics` (`lsp/lsp-stdio/src/connection.ts`).

Change: add a plugin `fs/edit-syntax-guard` on `tools/post-execute` for `edit` and `write`.

1. Parse the old and the new file with tree-sitter (the same grammars as senior-code-mcp).
2. If the new file has a syntax error that the old file did not have, undo the edit.
3. Return the error line and a short diff to the model, so that it can correct the edit.
4. Optional: when an LSP server is configured, also return new LSP diagnostics.

Evidence:

- arXiv:2405.15793 (SWE-agent, full text): edit with a lint check 18.0%, without the check 15.0%, no edit tool 10.3% (SWE-bench Lite, GPT-4 Turbo). 51.7% of runs had at least one failed edit.
- arXiv:2604.05407 (CODESTRUCT, full text): AST edit operations gave +1.2 to +5.0 pp Pass@1 and -12 to -38% tokens. Errors for each instance decreased by 76 to 88% for strong models.

### 4.2 P1: mask old tool results by age

Harness today: `compaction-basic` summarizes old history with one LLM call at 80% of the context. `compaction-tool-result-pruner` trims large results only when the context is full.

Change: add `compaction/compaction-observation-mask`. Before each model request, replace tool results older than M turns with a placeholder that names the tool and the arguments. Keep all model messages and tool calls. Keep LLM summary as the last step near the limit.

Make M a `Config` value. Tune M for this harness, because the value from one harness did not work in another harness.

Evidence:

- arXiv:2508.21433 (full text): masking cut the cost by half and matched or exceeded LLM summary (Qwen3-Coder 480B: 54.8% vs 53.8%). Summary calls used up to 7.2% of the cost of an instance.
- arXiv:2609.20804 (full text): rule-based elision before summary was the most efficient of five methods. Elided content that the agent can recover was rarely used and did not add accuracy.
- arXiv:2405.15793 (full text): the last 5 observations gave 18.0%. The full history gave 15.0%.

KV cache: masking changes old messages, so it breaks the prefix cache from that point. Mask in blocks (for example every 10 turns) so that the cached prefix stays valid for most requests. Measure the cost for each solved task, not only tokens.

### 4.3 P2: outline and symbol read

Harness today: `read` returns up to 2,000 numbered lines (`READ_LIMIT`). The `lsp` tool has `goToDefinition`, `findReferences`, `goToImplementation` and `hover`, but no `documentSymbol`.

Change: add two tools to `tool-code-search`. The senior-code-mcp parser already has the data.

- `code_outline(path)`: classes, functions and methods with line ranges.
- `code_read_symbol(path, qualified_name)`: the full source of one definition.

Update the prompt: outline first, then the symbol, then `read` with `offset`/`limit` for more context. Keep the code text exact. Do not compress code that the model will edit.

Evidence:

- arXiv:2405.15793 (full text): a 100-line window gave 18.0%, the full file 12.7%.
- arXiv:2604.05407 (full text): without the AST read tool, Pass@1 decreased by 7.8 pp (Qwen3-32B) and input tokens increased by 41%.
- arXiv:2407.01489 (Agentless, full text): a skeleton step (class and function headers) comes before full code reads.
- arXiv:2610.21073 (abstract): at the same token budget, whole verbatim files were better than compressed code by 6.3 pp. Thus the symbol read must return exact text.

Also test a lower `readLimit` (200 to 400) as a configuration experiment. The 100-line result is from GPT-4 Turbo and is possibly not correct for current models.

### 4.4 P2: best-of-N patch selection (opt-in)

Harness today: no patch selection. The parts are available: `experimental/worktree` (isolated worktrees), `workflow/workflow` (`parallel()`), `experimental/agent-team`.

Change: add a workflow `best-of-n`:

1. Run N agents in N worktrees. Use different seeds or different localization hits.
2. Normalize each patch (remove whitespace and comment changes).
3. Remove patches that fail the existing regression tests.
4. Remove patches that fail generated reproduction tests. Keep only tests that fail on the original code.
5. Vote. Give the top 3 to an LLM selector that can write new tests to separate them.

Evidence:

- arXiv:2407.01489 (full text): voting 25.67%, with regression tests 27.00%, with reproduction tests 32.00%.
- arXiv:2501.14723 (CodeMonkeys, full text): random selection 45.8%, their selection 57.4%, oracle 69.8%. Selection used less than 10% of the total cost.
- arXiv:2504.07164 (R2E-Gym, abstract): test-based and test-free verifiers each stop at approximately 42 to 43%. Together they reach 51%.

Cost: the token cost increases approximately N times. Keep this mode off by default. Use it only when quality is more important than cost.

### 4.5 P3: test-log extraction

Harness today: `bash` keeps the tail of long output (64,000 bytes for each stream) and writes the full output to a spill file. `spill-policy` keeps the head and the tail of large results.

Change: for test-runner output (pytest, jest, go test, cargo test), keep the failed test names, the assertion lines and the last stack frame in the repository. Keep the spill file.

Evidence (low confidence):

- arXiv:2605.28876 (abstract): grep plus tail reducers were on the cost and quality Pareto front.
- arXiv:2607.12161 (abstract): a 38.4% decrease in tool-output tokens increased the billed cost by 6.8%, because of cache effects.

Do this change only if the A/B test shows a lower cost for each solved task.

### 4.6 P3: retry only on external feedback; turn budget

Harness today: `guard/repeat-tool-reminder` sends a reminder after 3, 5 and 8 identical calls. There is no limit on turns or tokens for one task.

Change:

- Do not add "review your own patch" turns without new data.
- Retry only on external feedback: syntax errors (4.1), test failures, patch errors.
- Add a turn and token budget guard. When the budget is near, tell the model to finish, or start a new agent (4.4).

Evidence:

- arXiv:2310.01798 (abstract): without external feedback, models do not correct their reasoning, and the result can be worse.
- arXiv:2502.08235 (abstract): more "overthinking" correlates with a lower SWE-bench Verified score.
- arXiv:2501.14723 (full text): more iterations do not help runs that are stuck. New parallel runs add coverage.

### 4.7 P3: deferred tool schemas

Harness today: `native` mode sends all visible tool schemas in each request. `ptc` mode sends one `run_code` tool and a generated SDK prompt.

Change: send the full schemas only for core tools. For other tools, send the name and one line, and load the schema when the model asks for it.

Evidence: arXiv:2609.22114 (abstract): filtering tool schemas (approximately 21,000 to 57,000 tokens in each turn) was the only saving that gave the same result each time.

### 4.8 Not proposed: mandatory reproduction test in a single run

- arXiv:2602.07900 (abstract): successful and failed runs wrote tests at the same rate. Prompts for more or fewer tests did not change the result significantly.
- arXiv:2607.00990 (abstract): reproduction tests used as the target of the fix misled the agent.
- arXiv:2610.18004 (abstract): generated tests often accept incorrect patches.

Use reproduction tests only for patch selection (4.4).

## 5. Test procedure

Do this procedure for each change, one change at a time:

1. Use a fixed DeepSeek model, a fixed task set (for example 100 tasks from SWE-bench Verified), and 3 seeds.
2. Run the branch without the change (A) and with the change (B).
3. Record: resolve rate, localization accuracy, turns, input and output tokens, cached tokens, and cost for each solved task.
4. Use a paired test (Wilcoxon or McNemar) on the same tasks. Do not merge a change that does not improve the resolve rate or the cost for each solved task.
5. If possible, also report results on test suites with stronger tests. arXiv:2503.15223 reports a 6.2 pp increase in reported results that comes from weak benchmark tests.

## 6. Gaps in the evidence

- No study measured these changes on DeepSeek models in a plugin harness.
- No SWE-bench study measures test-log extraction separately from general truncation.
- No study measures outline-first reads together with a semantic and graph index. The two effects possibly overlap.
- The Aider repository map is not academically verified.
