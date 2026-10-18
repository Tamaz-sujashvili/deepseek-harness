/**
 * Classifier table and registry behaviour of the search-routing guard.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as Routing from '@deepseek-ai/dsh-search-routing'
import { SHELL_SEARCH_ROUTED, isOnlySearch, routingReason, tokenize } from '@deepseek-ai/dsh-search-routing'

describe('isOnlySearch', () => {
  const searches = [
    'rg "def build_graph"',
    'rg -n foo src | head -20',
    'grep -rn "applyLiteralEdit" packages/',
    'grep -R --include=*.ts foo .',
    'grep --recursive foo .',
    'cd packages && grep -rn foo . | sort | uniq',
    'find . -name "*.py"',
    'find packages -type f -iname "*edit*" | head',
    'git grep -n braceDepth',
    'fd edit packages',
    'ag foo',
    'find . -name "*.ts" | xargs grep -n foo',
  ]
  const notSearches = [
    'pytest -q tests',
    'npx vitest run packages/fs/tool-fs | grep FAIL',
    'grep -n foo src/a.py',
    'cat src/a.py | grep foo',
    'find . -type f -delete',
    'rg foo > out.txt',
    'rg foo &',
    'rg $(cat pattern) .',
    'grep -rn foo . && pytest',
    'cd src',
    'ls -la',
    'git log --oneline | grep fix',
    'find . -name "*.pyc" -exec rm {} ;',
    'find . -name "*.pyc" -delete',
    'find . -name x -exec rm \\;',
    'find . -name "*.log" -print0 | xargs -0 rm',
    'grep -rl foo . | xargs sed -i s/foo/bar/',
    'rg foo 2>&1',
    'timeout 10 rg foo',
    'cat <<EOF\nrg foo\nEOF',
  ]
  for (const command of searches) {
    it(`routes: ${command}`, () => { expect(isOnlySearch(command)).toBe(true) })
  }
  for (const command of notSearches) {
    it(`allows: ${command}`, () => { expect(isOnlySearch(command)).toBe(false) })
  }
})

describe('tokenize', () => {
  it('keeps quoted operators inside words', () => {
    expect(tokenize('rg "a|b" src && echo \'x;y\'')).toEqual(['rg', 'a|b', 'src', '&&', 'echo', 'x;y'])
    expect(tokenize('grep -rn a\\ b .')).toEqual(['grep', '-rn', 'a b', '.'])
  })
})

describe('routingReason', () => {
  it('names only visible tools and truncates the command', () => {
    expect(routingReason('rg foo', { codeSearch: true, grep: true, glob: false }, 200)).toBe(
      'Shell search was not run: `rg foo`. Search with code_search with a description of the behaviour, to find where it is implemented; '
      + 'the grep tool for exact text or a regular expression. Use the shell for other work, such as running tests.',
    )
    expect(routingReason('rg abcdef', { codeSearch: false, grep: true, glob: true }, 4)).toContain('`rg a…`')
  })
})

async function setup(tools: string[]) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const ran: string[] = []
  for (const name of ['bash', ...tools]) {
    ctx.tools.register(defineTool({
      name,
      description: name,
      parameters: { command: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: async (args) => { ran.push(`${name}:${args.command ?? ''}`); return 'ok' },
    }))
  }
  const fiber = await ctx.plugin(Routing, {})
  return { ctx, ran, fiber }
}

let n = 0
function call(ctx: Context, name: string, command: string) {
  return ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`c${++n}`), name, arguments: { command } })
}

describe('guard', () => {
  it('denies a shell search when a replacement tool is visible', async () => {
    const { ctx, ran } = await setup(['code_search', 'grep'])
    const result = await call(ctx, 'bash', 'grep -rn foo .')
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe(SHELL_SEARCH_ROUTED)
    expect(ran).toEqual([])
    expect((await call(ctx, 'bash', 'pytest -q')).isError).toBe(false)
    expect(ran).toEqual(['bash:pytest -q'])
  })

  it('allows shell search when no replacement tool is visible', async () => {
    const { ctx } = await setup([])
    expect((await call(ctx, 'bash', 'rg foo')).isError).toBe(false)
  })

  it('stops routing after fiber disposal (HMR safety)', async () => {
    const { ctx, fiber } = await setup(['grep'])
    await fiber.dispose()
    expect((await call(ctx, 'bash', 'rg foo')).isError).toBe(false)
  })
})
