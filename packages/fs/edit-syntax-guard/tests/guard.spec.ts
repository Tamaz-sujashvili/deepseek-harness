/**
 * The guard over the real local filesystem and the real `edit` / `write`
 * tools, exercised through `ctx.tools.execute()`: a syntax-breaking edit is
 * denied before dispatch and the file stays unchanged; valid edits, edits to
 * already-broken files, unsupported extensions, and edits the tool itself
 * rejects pass through.
 */

import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as Guard from '@deepseek-ai/dsh-edit-syntax-guard'
import { EDIT_SYNTAX_REGRESSION, SyntaxChecker, addedProblems, firstChangedLine, formatDenial, simulateEdit } from '@deepseek-ai/dsh-edit-syntax-guard'

let dir: string

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'syntax-guard-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function setup(config: Guard.Config = {}, options: { policy?: boolean } = {}) {
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  // Mounted before the read-before-write policy, as in the base bundle.
  const fiber = await ctx.plugin(Guard, config)
  if (options.policy === true) await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  return { ctx, fiber }
}

let counter = 0
function call(ctx: Context, name: string, args: object, agent?: object) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`c${++counter}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent: agent as never } : {},
  })
}

/** A stand-in agent; the observation policy keys reads by agent session id. */
const agent = { session: { header: { id: 'session-1' } } }

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

const PY = 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n'

describe('edit', () => {
  it('denies an edit that breaks Python syntax and leaves the file unchanged', async () => {
    const { ctx } = await setup()
    const file = join(dir, 'm.py')
    await writeFile(file, PY)
    const result = await call(ctx, 'edit', { file_path: file, old_string: 'def sub(a, b):', new_string: 'def sub(a, b)' })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe(EDIT_SYNTAX_REGRESSION)
    expect(text(result)).toMatch(/Edit rejected: the change at .*m\.py:5 would introduce a syntax error/)
    expect(text(result)).toContain('> 5 | def sub(a, b)')
    expect(await readFile(file, 'utf8')).toBe(PY)
  })

  it('applies a valid edit', async () => {
    const { ctx } = await setup()
    const file = join(dir, 'm.py')
    await writeFile(file, PY)
    const result = await call(ctx, 'edit', { file_path: file, old_string: 'return a - b', new_string: 'return b - a' })
    expect(result.isError).toBe(false)
    expect(await readFile(file, 'utf8')).toContain('return b - a')
  })

  it('allows editing a file that is already broken when the edit adds no new problem', async () => {
    const { ctx } = await setup()
    const file = join(dir, 'broken.ts')
    await writeFile(file, 'function a( {\n}\nconst x = 1\n')
    const result = await call(ctx, 'edit', { file_path: file, old_string: 'const x = 1', new_string: 'const x = 2' })
    expect(result.isError).toBe(false)
  })

  it('passes through unsupported extensions and edits the tool rejects itself', async () => {
    const { ctx } = await setup()
    await writeFile(join(dir, 'notes.txt'), 'a (\n')
    expect((await call(ctx, 'edit', { file_path: join(dir, 'notes.txt'), old_string: 'a (', new_string: 'a ((' })).isError).toBe(false)
    await writeFile(join(dir, 'm.py'), PY)
    const missing = await call(ctx, 'edit', { file_path: join(dir, 'm.py'), old_string: 'nope', new_string: 'x(' })
    expect(missing.isError).toBe(true)
    expect(missing.error?.info?.code).not.toBe(EDIT_SYNTAX_REGRESSION)
  })

  it('checks every replacement with replace_all and CRLF files', async () => {
    const { ctx } = await setup()
    const file = join(dir, 'crlf.go')
    const src = 'package p\r\n\r\nfunc a() int { return 1 }\r\nfunc b() int { return 1 }\r\n'
    await writeFile(file, src)
    const result = await call(ctx, 'edit', { file_path: file, old_string: 'return 1 }', new_string: 'return (1 }', replace_all: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('2 new syntax problems in total')
    expect(await readFile(file, 'utf8')).toBe(src)
  })
})

describe('write', () => {
  it('denies writing a new file with a syntax error', async () => {
    const { ctx } = await setup()
    const file = join(dir, 'new.rs')
    const result = await call(ctx, 'write', { file_path: file, content: 'fn main() {\n    let x = ;\n}\n' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(':2:')
  })

  it('writes valid content', async () => {
    const { ctx } = await setup()
    const file = join(dir, 'Ok.java')
    expect((await call(ctx, 'write', { file_path: file, content: 'class Ok { void f() {} }\n' })).isError).toBe(false)
    expect(await readFile(file, 'utf8')).toContain('class Ok')
  })
})

describe('ordering with the read-before-write policy', () => {
  it('reports the policy error for an unread file, without file content', async () => {
    const { ctx } = await setup({}, { policy: true })
    const file = join(dir, 'm.py')
    await writeFile(file, PY)
    const result = await call(ctx, 'edit', { file_path: file, old_string: 'def sub(a, b):', new_string: 'def sub(a, b)' })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).not.toBe(EDIT_SYNTAX_REGRESSION)
    expect(text(result)).not.toContain('def sub')
  })

  it('checks after the file was read', async () => {
    const { ctx } = await setup({}, { policy: true })
    const file = join(dir, 'm.py')
    await writeFile(file, PY)
    expect((await call(ctx, 'read', { file_path: file }, agent)).isError).toBe(false)
    const result = await call(ctx, 'edit', { file_path: file, old_string: 'def sub(a, b):', new_string: 'def sub(a, b)' }, agent)
    expect(result.error?.info?.code).toBe(EDIT_SYNTAX_REGRESSION)
  })
})

describe('plugin lifecycle and config', () => {
  it('stops checking after fiber disposal (HMR safety)', async () => {
    const { ctx, fiber } = await setup()
    await fiber.dispose()
    const file = join(dir, 'm.py')
    await writeFile(file, PY)
    expect((await call(ctx, 'edit', { file_path: file, old_string: 'def sub(a, b):', new_string: 'def sub(a, b)' })).isError).toBe(false)
  })

  it('checks only the configured extensions', async () => {
    const { ctx } = await setup({ extensions: { '.ts': 'typescript' } })
    const file = join(dir, 'm.py')
    await writeFile(file, PY)
    expect((await call(ctx, 'edit', { file_path: file, old_string: 'def sub(a, b):', new_string: 'def sub(a, b)' })).isError).toBe(false)
  })

  it('does not judge files already at the problem cap', async () => {
    const { ctx } = await setup({ maxProblems: 1 })
    const file = join(dir, 'bad.py')
    await writeFile(file, 'def a(:\n    pass\n')
    expect((await call(ctx, 'edit', { file_path: file, old_string: 'pass', new_string: 'pass)' })).isError).toBe(false)
  })

  it('rejects invalid numeric config at load', () => {
    const ctx = new Context()
    expect(() => { Guard.apply(ctx, { maxFileBytes: 0 }) }).toThrow(/maxFileBytes/)
  })
})

describe('pure helpers', () => {
  it('simulates the provider literal edit', () => {
    expect(simulateEdit('a\r\nb\r\n', { oldString: 'b', newString: 'c', replaceAll: false })).toEqual({ kind: 'checked', before: 'a\nb\n', after: 'a\nc\n' })
    expect(simulateEdit('x x', { oldString: 'x', newString: 'y', replaceAll: false })).toEqual({ kind: 'skip' })
    expect(simulateEdit('x', { oldString: '', newString: 'y', replaceAll: false })).toEqual({ kind: 'skip' })
  })

  it('counts only added problems', () => {
    const e = { line: 1, column: 1, kind: 'error' as const }
    expect(addedProblems([e], [{ ...e, line: 9 }])).toEqual([])
    expect(addedProblems([], [e])).toEqual([e])
    expect(formatDenial('a.py', 'x', [], 2)).toContain('would introduce a syntax error in a.py')
    expect(firstChangedLine('a\nb\nc', 'a\nB\nc')).toBe(2)
    expect(firstChangedLine('', 'a')).toBeUndefined()
    expect(firstChangedLine('a\nb', 'a')).toBe(1)
  })

  it('reports missing tokens', async () => {
    const problems = await new SyntaxChecker().problems('javascript', 'const a = [1, 2\n')
    expect(problems.length).toBeGreaterThan(0)
  })
})
