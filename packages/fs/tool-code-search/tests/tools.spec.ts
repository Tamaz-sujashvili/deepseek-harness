/**
 * Consumer-surface tests for `code_search` / `code_related` over a FAKE
 * subprocess service, exercised through `ctx.tools.execute()`: registration,
 * prompt routing, HMR disposal, argv construction, argument validation, CLI
 * JSON validation, error classification and model-facing text.
 */

import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessCollectedOutputs, SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import * as ToolCodeSearch from '@deepseek-ai/dsh-tool-code-search'
import { basename } from 'node:path'
import { buildContextArgv, buildRelatedArgv, workspaceRelative, formatCodeSearch, formatNodes, formatOutline, formatSymbol, parseOutlineEntry, parseWireChunk, parseWireNode, resolveRepo, toHit, toNode } from '@deepseek-ai/dsh-tool-code-search'

const testToolSignal = new AbortController().signal

interface Scripted {
  stdout: string
  stderr?: string
  exitCode?: number | null
  lossy?: boolean
}

class FakeHandle implements SubprocessHandle {
  readonly control = undefined
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>

  constructor(script: Scripted | { reject: Error }) {
    if ('reject' in script) {
      this.collected = {}
      this.done = Promise.reject(script.reject)
      return
    }
    const read = (text: string, lossy = false): { readFrom: () => SubprocessOutputRead } => ({
      readFrom: () => ({ text, nextOffset: 0, lossy }),
    })
    this.collected = { stdout: read(script.stdout, script.lossy), stderr: read(script.stderr ?? '') }
    this.done = Promise.resolve({ exitCode: script.exitCode === undefined ? 0 : script.exitCode, signal: null })
  }

  terminate(): void {}

  waitForExit(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

class FakeSubprocess extends SubprocessRuntime {
  async terminalEnvironment() { return { platform: 'posix' as const } }
  spawns: SubprocessSpawnSpec[] = []
  handler: (spec: SubprocessSpawnSpec) => Scripted | { reject: Error } = () => ({ stdout: '[]' })
  override async resolveExecutable(command: string): Promise<string> { return command }
  override spawnTerminal(): Promise<never> { throw new Error('code search spawns pipes, never terminals') }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    return new FakeHandle(this.handler(spec))
  }
}

const CONFIG = { command: ['/opt/scm/bin/senior-code-search'], env: { QDRANT_COLLECTION: 'code_chunks' } } satisfies ToolCodeSearch.Config

async function setup(config: Partial<ToolCodeSearch.Config> = {}) {
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeSubprocess)
  const subprocess = ctx.subprocess as FakeSubprocess
  const fiber = await ctx.plugin(ToolCodeSearch, { ...CONFIG, ...config })
  return { ctx, subprocess, fiber }
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId(`call-${++callCounter}`), name, arguments: args })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

const HIT = {
  score: 0.71234,
  id: 'src/store.ts:10:20:find',
  repo: 'app',
  path: 'src/store.ts',
  name: 'find',
  kind: 'method',
  language: 'typescript',
  start_line: 10,
  end_line: 20,
  docstring: 'Find a user by id.\nSecond line.',
  text: 'find(id) {\n  return this.db.get(id)\n}\n',
}
const NODE = { node: 'loadConfig', name: 'loadConfig', kind: 'function', language: 'typescript', path: 'src/config.ts', start_line: 3, end_line: 9, hops: 1 }

describe('registration', () => {
  it('registers code_search and code_related with routing guidance', async () => {
    const { ctx, subprocess } = await setup()
    expect(subprocess.spawns).toHaveLength(0)
    expect(ctx.tools.schemas().map(s => s.name).sort()).toEqual(['code_outline', 'code_read_symbol', 'code_related', 'code_search'])
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('call code_search first, before grep, find or reading files')
    expect(prompt).not.toContain('Use grep only for exact identifiers')
    expect(ctx.tools.get('code_search')?.timeoutMs).toBe(60_000)
  })

  it('unregisters tools and prompt section on fiber disposal (HMR safety)', async () => {
    const { ctx, fiber } = await setup()
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
    expect((await ctx.systemPrompt.assemble()).sections.map(s => s.name)).not.toContain('tool:code_search')
  })

  it('rejects an empty command at load', async () => {
    const ctx = new Context()
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FakeSubprocess)
    await expect(ToolCodeSearch.apply(ctx, { command: [' '] })).rejects.toThrow(/command must name/)
    await expect(ToolCodeSearch.apply(ctx, { command: ['x'], topK: 0 })).rejects.toThrow(/topK must be a positive integer/)
  })
})

describe('code_search', () => {
  it('spawns the CLI with flag=value argv and returns hits + neighbours', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => ({ stdout: JSON.stringify({ query: 'q', seed_names: ['find'], similar_chunks: [HIT], related_symbols: [NODE] }) })
    const result = await call(ctx, 'code_search', { query: '--find user', language: 'typescript', top_k: 3 })
    expect(result.isError).toBe(false)
    expect(subprocess.spawns[0]?.argv).toEqual([
      '/opt/scm/bin/senior-code-search', 'context', '--query=--find user', '--top-k=3', '--hops=1', '--language=typescript',
      `--repo=${basename(subprocess.spawns[0]?.cwd ?? '')}`,
    ])
    expect(subprocess.spawns[0]?.env).toEqual({ QDRANT_COLLECTION: 'code_chunks' })
    expect(result.value).toEqual({
      hits: [{
        path: 'src/store.ts', name: 'find', kind: 'method', language: 'typescript', startLine: 10, endLine: 20, score: 0.712,
        docstring: 'Find a user by id.\nSecond line.', source: HIT.text,
      }],
      related: [{ name: 'loadConfig', kind: 'function', language: 'typescript', path: 'src/config.ts', startLine: 3, endLine: 9, hops: 1 }],
    })
    expect(text(result)).toBe([
      '[1] src/store.ts:10-20 method find (typescript) score=0.712',
      '  doc: Find a user by id.',
      'find(id) {\n  return this.db.get(id)\n}',
      '',
      'Related (callers/callees/imports):\n- hop 1: function loadConfig src/config.ts:3-9',
    ].join('\n'))
  })

  it('validates arguments before spawning', async () => {
    const { ctx, subprocess } = await setup()
    for (const args of [{ query: '  ' }, { query: 'q', language: 'cobol' }, { query: 'q', top_k: 0 }, { query: 'q', top_k: 21 }, { query: 'q', hops: 3 }]) {
      const result = await call(ctx, 'code_search', args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
    }
    expect(subprocess.spawns).toHaveLength(0)
  })

  it('reports the CLI error document', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => ({ stdout: JSON.stringify({ error: 'ConnectError: [Errno 61] Connection refused' }), exitCode: 2 })
    const result = await call(ctx, 'code_search', { query: 'q' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('code search failed: ConnectError: [Errno 61] Connection refused')
  })

  it('reports non-JSON output with the stderr tail', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => ({ stdout: 'Traceback', stderr: 'line1\nModuleNotFoundError: qdrant_client', exitCode: 1 })
    const result = await call(ctx, 'code_search', { query: 'q' })
    expect(text(result)).toContain('non-JSON output (exit 1): line1 | ModuleNotFoundError: qdrant_client')
  })

  it('reports a spawn failure as a missing install', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => ({ reject: new Error('ENOENT') })
    const result = await call(ctx, 'code_search', { query: 'q' })
    expect(text(result)).toContain('code search subprocess failed')
  })

  it('rejects over-cap and malformed output', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => ({ stdout: '{', lossy: true })
    expect(text(await call(ctx, 'code_search', { query: 'q' }))).toContain('output exceeded')
    subprocess.handler = () => ({ stdout: JSON.stringify({ similar_chunks: [{ ...HIT, start_line: 'ten' }], related_symbols: [] }) })
    expect(text(await call(ctx, 'code_search', { query: 'q' }))).toContain('non-integer start_line')
  })

  it('tells the model what to do on zero hits', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => ({ stdout: JSON.stringify({ similar_chunks: [], related_symbols: [] }) })
    expect(text(await call(ctx, 'code_search', { query: 'q' }))).toContain('Try grep for exact identifiers')
  })
})

describe('code_related', () => {
  it('passes one --name per symbol and renders neighbours', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => ({ stdout: JSON.stringify([{ ...NODE, hops: 0 }, { node: 'module:fs', name: 'fs', kind: 'module', hops: 1 }]) })
    const result = await call(ctx, 'code_related', { names: ['UserStore.find', ' ', 'save'], hops: 2 })
    expect(subprocess.spawns[0]?.argv.slice(1)).toEqual(['related', '--name=UserStore.find', '--name=save', '--hops=2'])
    expect(text(result)).toBe('- seed: function loadConfig src/config.ts:3-9\n- hop 1: module fs (no file)')
  })

  it('rejects blank names and zero hops', async () => {
    const { ctx, subprocess } = await setup()
    expect((await call(ctx, 'code_related', { names: [' '] })).isError).toBe(true)
    expect((await call(ctx, 'code_related', { names: ['a'], hops: 0 })).isError).toBe(true)
    expect(subprocess.spawns).toHaveLength(0)
  })
})

describe('code_outline and code_read_symbol', () => {
  it('lists definitions of one file', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => ({ stdout: JSON.stringify([
      { name: 'Store', qualified: 'Store', kind: 'class', language: 'typescript', start_line: 1, end_line: 9 },
      { name: 'save', qualified: 'Store.save', kind: 'method', language: 'typescript', start_line: 3, end_line: 5 },
    ]) })
    const result = await call(ctx, 'code_outline', { path: 'src/store.ts' })
    expect(subprocess.spawns[0]?.argv.slice(1)).toEqual(['outline', '--path=src/store.ts'])
    expect(text(result)).toBe('src/store.ts (2 definitions):\n1-9 class Store\n3-5 method Store.save')
  })

  it('returns numbered symbol source', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => ({ stdout: JSON.stringify({
      path: 'src/store.ts', name: 'save', qualified: 'Store.save', kind: 'method', language: 'typescript',
      start_line: 9, end_line: 11, source: '  save() {\n    return 1\n  }\n',
    }) })
    const result = await call(ctx, 'code_read_symbol', { path: 'src/store.ts', name: '--Store.save' })
    expect(subprocess.spawns[0]?.argv.slice(1)).toEqual(['symbol', '--path=src/store.ts', '--name=--Store.save'])
    expect(text(result)).toBe('src/store.ts:9-11 method Store.save\n 9\t  save() {\n10\t    return 1\n11\t  }')
    subprocess.handler = () => ({ stdout: JSON.stringify({
      path: 'a.ts', name: 'foo', qualified: 'A.foo', kind: 'method', start_line: 4, end_line: 4, source: 'foo(x) {}', other_ranges: [[2, 2], [3, 3]],
    }) })
    expect(text(await call(ctx, 'code_read_symbol', { path: 'a.ts', name: 'A.foo' }))).toBe('a.ts:4-4 method A.foo\n4\tfoo(x) {}\nOther definitions named A.foo: 2-2, 3-3')
  })

  it('reports an unknown symbol from the CLI error document', async () => {
    const { ctx, subprocess } = await setup()
    subprocess.handler = () => ({ stdout: JSON.stringify({ error: "LookupError: no definition named 'x' in a.py; known: f" }), exitCode: 2 })
    expect(text(await call(ctx, 'code_read_symbol', { path: 'a.py', name: 'x' }))).toContain('known: f')
    expect((await call(ctx, 'code_outline', { path: ' ' })).isError).toBe(true)
  })
})

describe('pure helpers', () => {
  it('confines outline/symbol paths to the workspace', () => {
    expect(workspaceRelative('/work/app', 'src/a.ts')).toBe('src/a.ts')
    expect(workspaceRelative('/work/app', '/work/app/src/a.ts')).toBe('src/a.ts')
    expect(() => workspaceRelative('/work/app', '../other/a.ts')).toThrow(/inside the workspace/)
    expect(() => workspaceRelative('/work/app', '/etc/passwd')).toThrow(/inside the workspace/)
    expect(() => workspaceRelative('/work/app', '.')).toThrow(/inside the workspace/)
    expect(workspaceRelative('/work/app', '..foo/a.ts')).toBe('..foo/a.ts')
  })

  it('resolves the repo filter from config or the working directory', () => {
    expect(resolveRepo(undefined, '/work/my-app')).toBe('my-app')
    expect(resolveRepo('other', '/work/my-app')).toBe('other')
    expect(resolveRepo('*', '/work/my-app')).toBeUndefined()
  })

  it('builds argv without the optional language', () => {
    expect(buildContextArgv({ query: 'q', topK: 5, hops: 0 })).toEqual(['context', '--query=q', '--top-k=5', '--hops=0'])
    expect(buildRelatedArgv({ names: ['a'], hops: 1, language: 'go' })).toEqual(['related', '--name=a', '--hops=1', '--language=go'])
  })

  it('drops nulls when converting wire records', () => {
    expect(toHit(parseWireChunk({ ...HIT, language: null, docstring: null, text: null }))).toEqual({
      path: 'src/store.ts', name: 'find', kind: 'method', startLine: 10, endLine: 20, score: 0.712,
    })
    expect(toNode(parseWireNode({ hops: 2 }))).toEqual({ name: '?', kind: '?', hops: 2 })
    expect(() => parseWireNode({ name: 'x' })).toThrow(/without hops/)
    expect(() => parseWireChunk([])).toThrow(/non-object hit/)
  })

  it('clips long sources', () => {
    const source = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const out = formatCodeSearch({ hits: [{ path: 'a.py', name: 'f', kind: 'function', startLine: 1, endLine: 1, score: 1, source }], related: [] }, 3)
    expect(out).toBe('[1] a.py:1 function f score=1\nline 0\nline 1\nline 2\n… (47 more lines; use read for the rest)')
    expect(formatNodes([])).toBe('No graph neighbours found for these names.')
    expect(formatOutline('a.py', [])).toBe('No definitions found in a.py.')
    expect(() => parseOutlineEntry({ name: 'f' })).toThrow(/without qualified/)
    expect(formatSymbol({ path: 'a.py', name: 'f', qualified: 'f', kind: 'function', startLine: 1, endLine: 1, source: 'def f(): pass' }))
      .toBe('a.py:1-1 function f\n1\tdef f(): pass')
  })
})
