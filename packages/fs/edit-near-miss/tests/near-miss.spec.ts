/**
 * The near-miss hint over the real local filesystem and the real `edit`
 * tool, exercised through `ctx.tools.execute()`: an `old_string` that differs
 * from one passage only in trailing whitespace or Unicode punctuation is
 * denied with the exact file text, the file stays unchanged, and a retry with
 * that text succeeds; literal matches, misses and ambiguous matches pass
 * through to the tool.
 */

import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import * as NearMiss from '@deepseek-ai/dsh-edit-near-miss'
import { EDIT_NEAR_MISS, decodeEscapes, findNearMiss, formatHint, normalizeLine, quoteVisible } from '@deepseek-ai/dsh-edit-near-miss'

let dir: string

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'near-miss-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function setup(config: NearMiss.Config = {}, options: { policy?: boolean } = {}) {
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  // Mounted before the read-before-write policy, as in the base bundle.
  const fiber = await ctx.plugin(NearMiss, config)
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

/** The JSON string literal that the hint ends with. */
function quoted(hint: string): string {
  const last = hint.split('\n').at(-1) ?? ''
  return JSON.parse(last) as string
}

const NB = String.fromCharCode(0xA0)

// Line 2 ends with two spaces; line 4 uses curly quotes.
const SRC = 'def greet(name):  \n    msg = "hi"  \n    return msg\n# it\u2019s \u201Cdone\u201D\n'

describe('edit', () => {
  it('denies an edit that misses only trailing whitespace, quoting the exact file text', async () => {
    const { ctx } = await setup()
    const file = join(dir, 'g.py')
    await writeFile(file, SRC)
    const result = await call(ctx, 'edit', { file_path: file, old_string: 'def greet(name):\n    msg = "hi"\n', new_string: 'def greet(name):\n    msg = "hello"\n' })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe(EDIT_NEAR_MISS)
    const hint = text(result)
    expect(hint).toMatch(/old_string was not found in .*g\.py as written, but it matches one passage \(lines 1-2\)/)
    expect(hint).toContain('The file was not changed.')
    expect(quoted(hint)).toBe('def greet(name):  \n    msg = "hi"  \n')
    expect(await readFile(file, 'utf8')).toBe(SRC)

    const retry = await call(ctx, 'edit', { file_path: file, old_string: quoted(hint), new_string: 'def greet(name):\n    msg = "hello"\n' })
    expect(retry.isError).toBe(false)
    expect(await readFile(file, 'utf8')).toContain('msg = "hello"')
  })

  it('maps ASCII quotes to the curly quotes in the file', async () => {
    const { ctx } = await setup()
    const file = join(dir, 'g.py')
    await writeFile(file, SRC)
    const result = await call(ctx, 'edit', { file_path: file, old_string: '"done"', new_string: '"ok"' })
    expect(result.error?.info?.code).toBe(EDIT_NEAR_MISS)
    expect(text(result)).toContain('(line 4)')
    expect(quoted(text(result))).toBe('\u201Cdone\u201D')
  })

  it('passes through literal matches, misses and ambiguous normalized matches', async () => {
    const { ctx } = await setup()
    const file = join(dir, 'g.py')
    await writeFile(file, SRC)
    expect((await call(ctx, 'edit', { file_path: file, old_string: 'return msg', new_string: 'return msg.upper()' })).isError).toBe(false)

    const missing = await call(ctx, 'edit', { file_path: file, old_string: 'nothing like this', new_string: 'x' })
    expect(missing.isError).toBe(true)
    expect(missing.error?.info?.code).not.toBe(EDIT_NEAR_MISS)

    await writeFile(join(dir, 'twice.txt'), 'a \nb\na \nb\n')
    const twice = await call(ctx, 'edit', { file_path: join(dir, 'twice.txt'), old_string: 'a\nb', new_string: 'c', replace_all: true })
    expect(twice.error?.info?.code).not.toBe(EDIT_NEAR_MISS)
  })

  it('shows no-break spaces as escapes and accepts a retry with them', async () => {
    const { ctx } = await setup()
    const file = join(dir, 'README.md')
    const src = 'The widget' + NB + 'service stores every' + NB + 'record.\nIt flushes the cache' + NB + 'often.\n'
    await writeFile(file, src)
    const bs = String.fromCharCode(92)
    for (const old of ['The widget service stores every record.', 'The widget' + bs + 'u00a0service stores every' + bs + 'u00a0record.']) {
      const result = await call(ctx, 'edit', { file_path: file, old_string: old, new_string: 'x' })
      expect(result.error?.info?.code).toBe(EDIT_NEAR_MISS)
      expect(text(result).split('\n').at(-1)).toBe('"The widget' + bs + 'u00A0service stores every' + bs + 'u00A0record."')
      expect(quoted(text(result))).toBe('The widget' + NB + 'service stores every' + NB + 'record.')
    }
    expect(text(await call(ctx, 'edit', { file_path: file, old_string: 'The widget' + bs + 'u00a0service stores every' + bs + 'u00a0record.', new_string: 'x' }))).toContain('it contains escape text such as')
    expect((await call(ctx, 'edit', { file_path: file, old_string: 'The widget' + NB + 'service stores every' + NB + 'record.', new_string: 'x' })).isError).toBe(false)
    expect(await readFile(file, 'utf8')).toBe('x\nIt flushes the cache' + NB + 'often.\n')
  })

  it('handles CRLF files', async () => {
    const { ctx } = await setup()
    const file = join(dir, 'crlf.txt')
    await writeFile(file, 'one \r\ntwo\r\n')
    const result = await call(ctx, 'edit', { file_path: file, old_string: 'one\r\ntwo', new_string: 'x' })
    expect(result.error?.info?.code).toBe(EDIT_NEAR_MISS)
    expect(quoted(text(result))).toBe('one \ntwo')
    expect((await call(ctx, 'edit', { file_path: file, old_string: quoted(text(result)), new_string: 'x' })).isError).toBe(false)
    expect(await readFile(file, 'utf8')).toBe('x\r\n')
  })
})

describe('ordering with the read-before-write policy', () => {
  it('reports the policy error for an unread file, without file content', async () => {
    const { ctx } = await setup({}, { policy: true })
    const file = join(dir, 'g.py')
    await writeFile(file, SRC)
    const result = await call(ctx, 'edit', { file_path: file, old_string: '"done"', new_string: '"ok"' })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).not.toBe(EDIT_NEAR_MISS)
    expect(text(result)).not.toContain('\u201C')
  })

  it('runs before a policy that was registered first and occupies the slot', async () => {
    const ctx = new Context()
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(FsPolicy)
    await ctx.plugin(NearMiss, {})
    await ctx.plugin(ToolFs)
    const file = join(dir, 'g.py')
    await writeFile(file, SRC)
    expect((await call(ctx, 'read', { file_path: file }, agent)).isError).toBe(false)
    const result = await call(ctx, 'edit', { file_path: file, old_string: '"done"', new_string: '"ok"' }, agent)
    expect(result.error?.info?.code).toBe(EDIT_NEAR_MISS)
  })

  it('hints after the file was read', async () => {
    const { ctx } = await setup({}, { policy: true })
    const file = join(dir, 'g.py')
    await writeFile(file, SRC)
    expect((await call(ctx, 'read', { file_path: file }, agent)).isError).toBe(false)
    const result = await call(ctx, 'edit', { file_path: file, old_string: '"done"', new_string: '"ok"' }, agent)
    expect(result.error?.info?.code).toBe(EDIT_NEAR_MISS)
  })
})

describe('plugin lifecycle and config', () => {
  it('stops hinting after fiber disposal (HMR safety)', async () => {
    const { ctx, fiber } = await setup()
    await fiber.dispose()
    const file = join(dir, 'g.py')
    await writeFile(file, SRC)
    const result = await call(ctx, 'edit', { file_path: file, old_string: '"done"', new_string: '"ok"' })
    expect(result.error?.info?.code).not.toBe(EDIT_NEAR_MISS)
  })

  it('skips files over maxFileChars and quotes only up to maxQuotedChars', async () => {
    const file = join(dir, 'g.py')
    await writeFile(file, SRC)
    const small = await setup({ maxFileChars: 10 })
    expect((await call(small.ctx, 'edit', { file_path: file, old_string: '"done"', new_string: '"ok"' })).error?.info?.code).not.toBe(EDIT_NEAR_MISS)
    const short = await setup({ maxQuotedChars: 3 })
    const result = await call(short.ctx, 'edit', { file_path: file, old_string: '"done"', new_string: '"ok"' })
    expect(result.error?.info?.code).toBe(EDIT_NEAR_MISS)
    expect(text(result)).toContain('Read line 4 and copy old_string from the file exactly')
  })

  it('ignores calls without string old_string, directories, and unreadable files', async () => {
    const { ctx } = await setup()
    const file = join(dir, 'g.py')
    await writeFile(file, SRC)
    const target = await ctx.fs.resolve(file)
    const signal = new AbortController().signal
    const slot = (actor: object | undefined) => ctx.waterfall('fs/edit-intent', target, actor, () => undefined)
    await expect(slot(undefined)).resolves.toBeUndefined()
    await expect(slot({ arguments: { old_string: 1 }, signal })).resolves.toBeUndefined()
    await expect(slot({ arguments: { old_str: '"done"' }, signal })).rejects.toMatchObject({ code: EDIT_NEAR_MISS })
    const folder = await ctx.fs.resolve(dir)
    await expect(ctx.waterfall('fs/edit-intent', folder, { arguments: { old_string: 'x' }, signal }, () => undefined)).resolves.toBeUndefined()
    vi.spyOn(ctx.fs, 'readText').mockRejectedValueOnce(new Error('boom'))
    await expect(slot({ arguments: { old_string: '"done"' }, signal })).resolves.toBeUndefined()
  })

  it('rejects invalid numeric config at load', () => {
    const ctx = new Context()
    expect(() => { NearMiss.apply(ctx, { maxFileChars: 0, maxQuotedChars: 1 }) }).toThrow(/maxFileChars/)
    expect(() => { NearMiss.apply(ctx, { maxFileChars: 1, maxQuotedChars: -1 }) }).toThrow(/maxQuotedChars/)
  })
})

describe('pure helpers', () => {
  it('normalizes quotes, dashes, Unicode spaces, NFKC and trailing whitespace', () => {
    expect(normalizeLine('\u2018a\u2019 \u201Cb\u201D \u2013 \u2212 x\u00A0y \uFB01  ')).toBe('\'a\' "b" - - x y fi')
  })

  it('cuts a match that starts and ends inside lines', () => {
    expect(findNearMiss('let s = \u201Chi\u201D; // end\n', 's = "hi";')).toEqual({ kind: 'exact', startLine: 1, endLine: 1, text: 's = \u201Chi\u201D;', escapes: false })
    expect(findNearMiss('x\nlet s = \u201Chi\u201D;', 's = "hi"')).toEqual({ kind: 'exact', startLine: 2, endLine: 2, text: 's = \u201Chi\u201D', escapes: false })
  })

  it('reports only the line range when NFKC changes a boundary line', () => {
    expect(findNearMiss('x = \uFB01le \n', 'x = file\n')).toEqual({ kind: 'lines', startLine: 1, endLine: 1, escapes: false })
    expect(findNearMiss('a \nx = \uFB01le\n', 'a\nx = file')).toEqual({ kind: 'lines', startLine: 1, endLine: 2, escapes: false })
  })

  it('keeps trailing whitespace of the last whole line when the match ends with a line ending', () => {
    expect(findNearMiss('a  \nb  \nc\n', 'a\nb\n')).toEqual({ kind: 'exact', startLine: 1, endLine: 2, text: 'a  \nb  \n', escapes: false })
  })

  it('keeps trailing whitespace significant on a partial last line', () => {
    expect(findNearMiss('foobar\n', 'foo ')).toEqual({ kind: 'none' })
    expect(findNearMiss('x foo\u2019  \n', 'foo\' ')).toEqual({ kind: 'exact', startLine: 1, endLine: 1, text: 'foo\u2019', escapes: false })
    expect(findNearMiss('x foo\u2019', 'foo\' ')).toEqual({ kind: 'exact', startLine: 1, endLine: 1, text: 'foo\u2019', escapes: false })
  })

  it('returns none for literal, blank, missing and ambiguous text', () => {
    expect(findNearMiss('a b', 'a')).toEqual({ kind: 'none' })
    expect(findNearMiss('a b', '  ')).toEqual({ kind: 'none' })
    expect(findNearMiss('a b', 'zz')).toEqual({ kind: 'none' })
    expect(findNearMiss('\u201Ca\u201D "a"', '\u201Ca"')).toEqual({ kind: 'none' })
  })

  it('decodes literal escape text and quotes invisible characters visibly', () => {
    const bs = String.fromCharCode(92)
    expect(decodeEscapes('a' + bs + 'u00a0b' + bs + 'u202F')).toBe('a' + NB + 'b' + String.fromCharCode(0x202F))
    expect(quoteVisible('a' + NB + '"')).toBe('"a' + bs + 'u00A0' + bs + '""')
    expect(findNearMiss('a' + bs + 'u00a0b', 'zz' + bs + 'u00a0')).toEqual({ kind: 'none' })
  })

  it('formats both hint kinds', () => {
    expect(formatHint('f', { kind: 'lines', startLine: 2, endLine: 3, escapes: false }, 100)).toContain('Read lines 2-3 and copy old_string')
    expect(formatHint('f', { kind: 'exact', startLine: 1, endLine: 1, text: 'a ', escapes: false }, 100).split('\n').at(-1)).toBe('"a "')
  })
})
