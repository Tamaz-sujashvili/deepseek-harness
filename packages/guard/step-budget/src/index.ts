/**
 * Step budget with budget awareness.
 *
 * Each agent may take `maxSteps` model steps for one user message. When the
 * agent's used steps reach a fraction in `notifyAt`, and again when they
 * reach `maxSteps`, the next step receives a short notice with the steps
 * used and the steps that remain. After `graceSteps` more steps, further
 * steps are rejected and the turn ends. A new user message resets the count.
 *
 * Notices are sent only after a tool call, so a turn that has already
 * finished is never continued by a notice. A step proposed after a
 * text-only reply with no new messages is not rejected, so a turn that the
 * model ends itself still completes normally.
 *
 * Why: the Budget Tracker (arXiv:2511.17006) gives an agent continuous
 * budget awareness and gives better cost-performance scaling than a larger
 * budget alone. On SWE-bench Verified, more overthinking correlates with a
 * lower resolve rate (arXiv:2502.08235), and more iterations do not help
 * runs that are stuck (arXiv:2501.14723).
 *
 * @module @deepseek-ai/dsh-step-budget
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'step-budget': { kind: 'step-budget' } & ContextFormed
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'step-budget'

/** Plugin configuration for `step-budget` (`cordis.yml` `config:`). */
export interface Config {
  /** Model steps one agent may take for one user message (default 100). */
  maxSteps?: number
  /** Fractions of `maxSteps` at which the agent is told how many steps remain (default 0.5 and 0.8). */
  notifyAt?: number[]
  /** Steps allowed after the budget is reached before further steps are rejected (default 2). */
  graceSteps?: number
}

export const Config: z<Config> = z.object({
  maxSteps: z.number().step(1).min(1).default(100),
  notifyAt: z.array(z.number().min(0).max(1)).default([0.5, 0.8]),
  graceSteps: z.number().step(1).min(0).default(2),
})

/** Plugin config after schemastery defaulting. */
export type ResolvedConfig = Required<Config>

/** One agent's budget state since its last user message. */
interface Budget {
  /** Steps that entered since the last user message. */
  used: number
  /** Index of the next threshold in {@link thresholds} to announce. */
  next: number
  /** Whether a tool ran since the last proposed step. */
  toolRan: boolean
}

/**
 * Step counts at which a notice is due, in ascending order, ending with
 * `maxSteps`. Fractions that round to the same step count are announced once.
 *
 * @param config - resolved plugin configuration.
 * @returns ascending, unique step counts.
 */
export function thresholds(config: ResolvedConfig): number[] {
  const steps = config.notifyAt.map(f => Math.max(1, Math.ceil(f * config.maxSteps))).filter(s => s < config.maxSteps)
  return [...new Set([...steps, config.maxSteps])].sort((a, b) => a - b)
}

/**
 * Model-facing notice text.
 *
 * @param used - steps used since the last user message.
 * @param config - resolved plugin configuration.
 * @returns the notice.
 */
export function budgetNotice(used: number, config: ResolvedConfig): string {
  if (used < config.maxSteps) {
    return `Step budget: ${used} of ${config.maxSteps} steps used, ${config.maxSteps - used} remain. `
      + 'Plan the rest of the task to fit in the remaining steps.'
  }
  const after = config.graceSteps === 0
    ? 'No further steps are allowed.'
    : `After ${config.graceSteps} more step${config.graceSteps === 1 ? '' : 's'}, the run stops.`
  return `Step budget reached: ${used} of ${config.maxSteps} steps used. ${after} `
    + 'Do not explore further. Complete the change you have, then give your final answer.'
}

/**
 * Register the budget listeners.
 *
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - resolved plugin configuration from schemastery.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const marks = thresholds(resolved)
  const limit = resolved.maxSteps + resolved.graceSteps
  const budgets = new WeakMap<Agent, Budget>()

  ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    let budget = budgets.get(agent)
    if (budget === undefined || messages.some(message => message.source.kind === 'user')) {
      budget = { used: 0, next: 0, toolRan: false }
      budgets.set(agent, budget)
    }
    const finishing = !budget.toolRan && decision.messages.length === 0
    budget.toolRan = false
    if (budget.used >= limit) return finishing ? decision : { kind: 'reject' }
    budget.used += 1
    return decision
  })

  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const agent = exec.agent
    const budget = agent === undefined ? undefined : budgets.get(agent)
    if (budget !== undefined) budget.toolRan = true
    if (agent !== undefined && budget !== undefined && budget.next < marks.length && budget.used >= (marks[budget.next] ?? Infinity)) {
      while (budget.next < marks.length && budget.used >= (marks[budget.next] ?? Infinity)) budget.next += 1
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: budgetNotice(budget.used, resolved) }],
        source: { kind: 'step-budget', form: 'notice', summary: `step budget: ${budget.used}/${resolved.maxSteps}` },
      }))
    }
    return next()
  })
}
