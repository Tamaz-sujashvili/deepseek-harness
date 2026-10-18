import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture, defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as VerifyBeforeFinish from '@deepseek-ai/dsh-verify-before-finish'
import type { Config } from '@deepseek-ai/dsh-verify-before-finish'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the turn-stop verification gate, driven through a real
 * agent loop against a scripted mock adapter. The `bash` fixture exits 1 when
 * its command contains `FAIL` and 0 otherwise, and reports a timeout when it
 * contains `HANG`.
 */

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function harness(config: Config, script: Script): Promise<{ ctx: Context; adapter: MockAdapter }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(VerifyBeforeFinish, config)
  for (const toolName of ['edit', 'str_replace_editor']) {
    ctx.tools.register(defineContentToolFixture({
      name: toolName,
      description: toolName,
      parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
  }
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'bash fixture',
    parameters: { command: { type: 'string', required: true } },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      return { kind: 'foreground', exitCode: args.command.includes('FAIL') ? 1 : 0, timedOut: args.command.includes('HANG') }
    },
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

/** Text of every gate message in the agent's log. */
function gates(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'verify-before-finish')
    .map(e => e.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

describe('turn-stop gate', () => {
  it('steers once when edits have no check after them, then lets the turn close after a passing check', async () => {
    const { ctx, adapter } = await harness({}, [
      toolCallResponse('c1', 'edit', { file_path: 'src/a.py' }),
      textResponse('done'),
      toolCallResponse('c2', 'bash', { command: 'python -m pytest tests/test_a.py' }),
      textResponse('verified'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)

    const found = gates(agent)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('No test or reproduction command has run successfully after your latest edits.')
    expect(found[0]).toContain('- src/a.py')
    expect(adapter.requests).toHaveLength(4)
  })

  it('does not steer when a passing check follows the last edit', async () => {
    const { ctx, adapter } = await harness({}, [
      toolCallResponse('c1', 'edit', { file_path: 'src/a.py' }),
      toolCallResponse('c2', 'bash', { command: 'pytest -q' }),
      textResponse('done'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)

    expect(gates(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(3)
  })

  it('names the failing check and its exit code', async () => {
    const { ctx } = await harness({}, [
      toolCallResponse('c1', 'edit', { file_path: 'src/a.py' }),
      toolCallResponse('c2', 'bash', { command: 'pytest tests/FAIL_case.py' }),
      textResponse('done'),
      textResponse('the failure is pre-existing'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)

    const found = gates(agent)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('The last check after your edits did not pass: `pytest tests/FAIL_case.py` exited with code 1.')
  })

  it('steers again when an edit follows a passing check', async () => {
    const { ctx } = await harness({}, [
      toolCallResponse('c1', 'edit', { file_path: 'src/a.py' }),
      toolCallResponse('c2', 'bash', { command: 'go test ./...' }),
      toolCallResponse('c3', 'edit', { file_path: 'src/b.py' }),
      textResponse('done'),
      textResponse('ok'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)

    const found = gates(agent)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('- src/a.py\n- src/b.py')
  })

  it('stops steering after maxHoldsPerPrompt continuations', async () => {
    const { ctx, adapter } = await harness({ maxHoldsPerPrompt: 2 }, [
      toolCallResponse('c1', 'edit', { file_path: 'src/a.py' }),
      textResponse('done'),
      textResponse('still done'),
      textResponse('really done'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)

    expect(gates(agent)).toHaveLength(2)
    expect(adapter.requests).toHaveLength(4)
  })

  it('ignores turns without edits and read-only editor commands', async () => {
    const { ctx, adapter } = await harness({}, [
      toolCallResponse('c1', 'str_replace_editor', { command: 'view', path: 'src/a.py' }),
      toolCallResponse('c2', 'bash', { command: 'pytest' }),
      textResponse('done'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)

    expect(gates(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(3)
  })

  it('counts in-place shell edits', async () => {
    const { ctx } = await harness({}, [
      toolCallResponse('c1', 'bash', { command: "sed -i 's/a/b/' src/a.py" }),
      textResponse('done'),
      textResponse('ok'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)

    const found = gates(agent)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('- files changed by shell commands')
  })

  it('treats an edit and a check in one shell command as checked', async () => {
    const { ctx } = await harness({}, [
      toolCallResponse('c1', 'bash', { command: "sed -i 's/a/b/' src/a.py && pytest" }),
      textResponse('done'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)

    expect(gates(agent)).toEqual([])
  })

  it('keeps an edit unchecked when the same command edits after the check', async () => {
    const { ctx } = await harness({}, [
      toolCallResponse('c1', 'edit', { file_path: 'src/a.py' }),
      toolCallResponse('c2', 'bash', { command: "pytest -q && sed -i 's/a/b/' src/a.py" }),
      textResponse('done'),
      textResponse('ok'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)

    const found = gates(agent)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('No test or reproduction command has run successfully after your latest edits.')
  })

  it('does not accept a check that reached its timeout', async () => {
    const { ctx } = await harness({}, [
      toolCallResponse('c1', 'edit', { file_path: 'src/a.py' }),
      toolCallResponse('c2', 'bash', { command: 'pytest HANG' }),
      textResponse('done'),
      textResponse('ok'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)

    expect(gates(agent)[0]).toContain('`pytest HANG` reached its timeout before it finished.')
  })

  it('forgets earlier edits at the next user message', async () => {
    const { ctx } = await harness({}, [
      toolCallResponse('c1', 'edit', { file_path: 'src/a.py' }),
      textResponse('done'),
      textResponse('cannot test here'),
      textResponse('you are welcome'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)
    await run(ctx, agent, 'thanks')

    expect(gates(agent)).toHaveLength(1)
  })

  it('caps the listed paths at maxListedPaths', async () => {
    const { ctx } = await harness({ maxListedPaths: 1 }, [
      toolCallResponse('c1', 'edit', { file_path: 'src/a.py' }),
      toolCallResponse('c2', 'edit', { file_path: 'src/b.py' }),
      toolCallResponse('c3', 'edit', { file_path: 'src/c.py' }),
      textResponse('done'),
      textResponse('ok'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)

    expect(gates(agent)[0]).toContain('- src/a.py\n- … and 2 more')
  })
})

describe('configuration', () => {
  it('fails the load on an invalid pattern', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(VerifyBeforeFinish, { verifyPatterns: ['('] })).rejects.toThrow(/invalid verifyPatterns pattern/)
  })

  it('fails the load on a non-positive hold budget', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(VerifyBeforeFinish, { maxHoldsPerPrompt: 0 })).rejects.toThrow(/invalid maxHoldsPerPrompt 0/)
  })
})
