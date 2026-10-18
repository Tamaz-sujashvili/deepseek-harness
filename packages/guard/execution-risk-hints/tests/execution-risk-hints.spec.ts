import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ExecutionRiskHints from '@deepseek-ai/dsh-execution-risk-hints'
import { errorSignature, type Config } from '@deepseek-ai/dsh-execution-risk-hints'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the shell-execution hints, driven through a real agent
 * loop against a scripted mock adapter. The `bash` fixture maps marker words
 * in the command to canned outcomes.
 */

type Stream = { text: string }
type Outcome = { [key: string]: string | number | boolean | null | Stream }

const PASS: Outcome = { kind: 'foreground', exitCode: 0, timedOut: false, stdout: { text: 'ok' }, stderr: { text: '' } }

const OUTCOMES: { marker: string; value: Outcome; delayMs?: number }[] = [
  { marker: 'ERRA', value: { kind: 'foreground', exitCode: 1, timedOut: false, stdout: { text: '' }, stderr: { text: "Traceback (most recent call last):\n  File \"x.py\", line 3\nModuleNotFoundError: No module named 'foo'" } } },
  { marker: 'ERRB', value: { kind: 'foreground', exitCode: 1, timedOut: false, stdout: { text: 'ValueError: bad value 42' }, stderr: { text: '' } } },
  { marker: 'ERRC', value: { kind: 'foreground', exitCode: 2, timedOut: false, stdout: { text: 'ValueError: bad value 43' }, stderr: { text: '' } } },
  { marker: 'MISS', value: { kind: 'foreground', exitCode: 1, timedOut: false, stdout: { text: '' }, stderr: { text: '' } } },
  { marker: 'TIMEOUT', value: { kind: 'foreground', exitCode: null, timedOut: true, stdout: { text: '' }, stderr: { text: '' } } },
  { marker: 'PROMOTE', value: { kind: 'promoted', jobId: 'j1' } },
  { marker: 'SLOWERR', value: { kind: 'foreground', exitCode: 1, timedOut: false, stdout: { text: '' }, stderr: { text: "ModuleNotFoundError: No module named 'foo'" } }, delayMs: 30 },
  { marker: 'SLOW', value: { kind: 'foreground', exitCode: 0, timedOut: false, stdout: { text: 'ok' }, stderr: { text: '' } }, delayMs: 30 },
]

async function harness(config: Config, script: ConstructorParameters<typeof MockAdapter>[0]): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ExecutionRiskHints, config)
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'bash fixture',
    parameters: { command: { type: 'string', required: true }, description: { type: 'string' } },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const outcome = OUTCOMES.find(candidate => args.command.includes(candidate.marker))
      if (outcome?.delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, outcome.delayMs))
      return outcome?.value ?? PASS
    },
  }))
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

async function run(ctx: Context, agent: Agent, prompt = 'go'): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  await idle
}

async function notesFor(config: Config, calls: { command: string; description?: string }[]): Promise<{ text: string; summary: unknown }[]> {
  const ctx = await harness(config, [
    ...calls.map((args, i) => toolCallResponse(`c${i}`, 'bash', args)),
    textResponse('done'),
  ])
  const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
  await run(ctx, agent)
  return notes(agent)
}

function notes(agent: Agent): { text: string; summary: unknown }[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'execution-risk-hints')
    .map((e) => {
      const summary: unknown = Reflect.get(e.data.source, 'summary')
      return { text: e.data.content.map(block => block.type === 'text' ? block.text : '').join(''), summary }
    })
}

describe('repeated-error', () => {
  it('notes the second consecutive failure with the same error line, once', async () => {
    const found = await notesFor({}, [{ command: 'python ERRA.py' }, { command: 'python3 ERRA.py' }, { command: 'python ERRA.py --x' }])
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain("The last 2 shell commands failed with the same error:\n`ModuleNotFoundError: No module named 'foo'`")
    expect(found[0]!.summary).toBe('repeated-error')
  })

  it('compares error lines with numbers normalized', async () => {
    const found = await notesFor({}, [{ command: 'run ERRB' }, { command: 'run ERRC' }])
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain('`ValueError: bad value N`')
  })

  it('resets on a passing command and ignores failures without an error line', async () => {
    const found = await notesFor({}, [{ command: 'ERRA' }, { command: 'ls' }, { command: 'ERRA' }, { command: 'grep x MISS' }, { command: 'grep x MISS' }])
    expect(found).toEqual([])
  })

  it('starts over at the next user message', async () => {
    const ctx = await harness({}, [
      toolCallResponse('c1', 'bash', { command: 'ERRA' }),
      toolCallResponse('c2', 'bash', { command: 'ERRA' }),
      textResponse('done'),
      toolCallResponse('c3', 'bash', { command: 'ERRA' }),
      toolCallResponse('c4', 'bash', { command: 'ERRA' }),
      textResponse('done again'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent)
    await run(ctx, agent, 'try again')
    expect(notes(agent)).toHaveLength(2)
  })
})

describe('validation quality', () => {
  it('notes a multi-step check without a fail-fast guard', async () => {
    const found = await notesFor({}, [{ command: 'diff out.txt expected.txt; echo "all checks passed"', description: 'Final check of the output' }])
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain('without `set -e` or `|| exit 1`')
  })

  it('accepts a check guarded by set -e', async () => {
    const found = await notesFor({}, [{ command: 'set -e\ndiff out.txt expected.txt\necho passed', description: 'verify output' }])
    expect(found).toEqual([])
  })

  it('accepts an && chain whose success message depends on the assertion', async () => {
    const found = await notesFor({}, [{ command: 'diff actual expected && echo passed', description: 'final check' }])
    expect(found).toEqual([])
  })

  it('does not call a help step chained with a real run shallow', async () => {
    const found = await notesFor({}, [{ command: 'pytest --help && pytest -q', description: 'verify the fix' }])
    expect(found).toEqual([])
  })

  it('notes a help-only check before any real run, but not after one', async () => {
    const before = await notesFor({}, [{ command: 'python cli.py --help', description: 'Verify the CLI works' }])
    expect(before).toHaveLength(1)
    expect(before[0]!.text).toContain('checks only help text, syntax, or file existence')
    const after = await notesFor({}, [{ command: 'pytest -q' }, { command: 'python cli.py --help', description: 'Verify the CLI works' }])
    expect(after).toEqual([])
  })
})

describe('time-budget', () => {
  it('notes the second long call once a timeout has happened', async () => {
    const found = await notesFor({ longStepMs: 10 }, [{ command: 'TIMEOUT' }, { command: 'SLOW' }])
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain('went into long foreground commands or timeouts')
  })

  it('counts a command moved to the background as a timeout', async () => {
    const found = await notesFor({ longStepMs: 10 }, [{ command: 'PROMOTE' }, { command: 'PROMOTE' }])
    expect(found).toHaveLength(1)
  })
})

describe('configuration', () => {
  it('caps the notes on one result at maxNotesPerCall, highest priority first', async () => {
    const found = await notesFor({ maxNotesPerCall: 1, longStepMs: 10 }, [{ command: 'TIMEOUT' }, { command: 'ERRA' }, { command: 'SLOWERR' }])
    expect(found.map(note => note.summary)).toEqual(['repeated-error'])
  })

  it('runs only the selected detectors', async () => {
    const found = await notesFor({ detectors: ['shallow-check'] }, [{ command: 'ERRA' }, { command: 'ERRA' }])
    expect(found).toEqual([])
  })

  it('fails the load on an out-of-range number', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(ExecutionRiskHints, { errorRepeatThreshold: 0 })).rejects.toThrow(/invalid errorRepeatThreshold 0/)
  })
})

describe('errorSignature', () => {
  it('prefers the last exception line and falls back to the first error line', () => {
    expect(errorSignature(1, 'Traceback\nKeyError: 3\nRuntimeError: boom at 0xdeadbeef')).toBe('RuntimeError: boom at ADDR')
    expect(errorSignature(127, 'bash: foo: command not found')).toBe('bash: foo: command not found')
    expect(errorSignature(0, 'Error: ignored')).toBe('')
    expect(errorSignature(1, 'nothing useful')).toBe('')
  })
})
