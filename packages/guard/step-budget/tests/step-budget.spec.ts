import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as StepBudget from '@deepseek-ai/dsh-step-budget'
import { budgetNotice, thresholds, type Config, type ResolvedConfig } from '@deepseek-ai/dsh-step-budget'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the step budget, driven through a real agent loop
 * against a scripted mock adapter. The `read` fixture always succeeds.
 */

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function harness(config: Config, script: Script): Promise<{ ctx: Context; adapter: MockAdapter }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(StepBudget, config)
  ctx.tools.register(defineContentToolFixture({
    name: 'read',
    description: 'read',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ok' }] },
  }))
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

async function run(ctx: Context, agent: Agent, prompt = 'fix the bug'): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  await idle
}

/** Text of every budget notice in the agent's log. */
function notices(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'step-budget')
    .map(e => e.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

function calls(n: number): Script {
  return Array.from({ length: n }, (_, i) => toolCallResponse(`c${i + 1}`, 'read', {}))
}

const resolved = (config: Config): ResolvedConfig => ({ maxSteps: 100, notifyAt: [0.5, 0.8], graceSteps: 2, ...config })

describe('thresholds', () => {
  it('rounds fractions up, drops duplicates and ends with maxSteps', () => {
    expect(thresholds(resolved({ maxSteps: 10 }))).toEqual([5, 8, 10])
    expect(thresholds(resolved({ maxSteps: 3, notifyAt: [0.5, 0.6, 1] }))).toEqual([2, 3])
    expect(thresholds(resolved({ maxSteps: 4, notifyAt: [] }))).toEqual([4])
  })
})

describe('budgetNotice', () => {
  it('states used and remaining steps before the limit, and the stop after it', () => {
    expect(budgetNotice(5, resolved({ maxSteps: 10 }))).toBe(
      'Step budget: 5 of 10 steps used, 5 remain. Plan the rest of the task to fit in the remaining steps.',
    )
    expect(budgetNotice(10, resolved({ maxSteps: 10, graceSteps: 1 }))).toBe(
      'Step budget reached: 10 of 10 steps used. After 1 more step, the run stops. '
      + 'Do not explore further. Complete the change you have, then give your final answer.',
    )
    expect(budgetNotice(4, resolved({ maxSteps: 4, graceSteps: 0 }))).toContain('No further steps are allowed.')
  })
})

describe('step budget', () => {
  it('does nothing when the run ends under the first threshold', async () => {
    const { ctx, adapter } = await harness({ maxSteps: 10 }, [...calls(2), textResponse('done')])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)
    expect(notices(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(3)
  })

  it('announces each threshold once after a tool call', async () => {
    const { ctx } = await harness({ maxSteps: 4, notifyAt: [0.5] }, [...calls(4), textResponse('done')])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)
    const found = notices(agent)
    expect(found).toHaveLength(2)
    expect(found[0]).toContain('Step budget: 2 of 4 steps used, 2 remain.')
    expect(found[1]).toContain('Step budget reached: 4 of 4 steps used. After 2 more steps, the run stops.')
  })

  it('rejects steps after maxSteps plus graceSteps', async () => {
    const { ctx, adapter } = await harness({ maxSteps: 2, notifyAt: [], graceSteps: 1 }, [...calls(6), textResponse('done')])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)
    expect(adapter.requests).toHaveLength(3)
    expect(notices(agent)).toHaveLength(1)
  })

  it('resets the count on a new user message', async () => {
    const { ctx, adapter } = await harness({ maxSteps: 2, notifyAt: [], graceSteps: 0 }, [
      ...calls(1), textResponse('first'),
      toolCallResponse('d1', 'read', {}), textResponse('second'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent, 'first task')
    await run(ctx, agent, 'second task')
    expect(adapter.requests).toHaveLength(4)
  })
})
