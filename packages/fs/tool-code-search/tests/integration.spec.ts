/**
 * Real-process integration: spawns the installed `senior-code-search` CLI
 * through the local subprocess runtime against a live index. Skipped unless
 * `DSH_CODE_SEARCH_IT_COMMAND` names the executable; the index (Qdrant,
 * Ollama, graph.json) must already hold the CLI's `tests/fixtures/polyglot`.
 */

import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolCodeSearch from '@deepseek-ai/dsh-tool-code-search'

const command = process.env['DSH_CODE_SEARCH_IT_COMMAND']

describe.skipIf(command === undefined)('senior-code-search CLI', () => {
  it('returns typed hits and graph neighbours from the live index', async () => {
    const ctx = new Context()
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(ToolCodeSearch, { command: [command!], repo: 'polyglot', env: { ...process.env } as Record<string, string> })

    const search = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('it-1'),
      name: 'code_search',
      arguments: { query: 'build an empty in-memory user repository', language: 'go', top_k: 2 },
    })
    expect(search.isError).toBe(false)
    // JSON round trip: `value` is the registry's JsonValue; the spec reads it as the declared output.
    const value = JSON.parse(JSON.stringify(search.value)) as ToolCodeSearch.CodeSearchResult
    expect(value.hits.length).toBeGreaterThan(0)
    expect(value.hits.every(h => h.language === 'go')).toBe(true)

    const related = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('it-2'),
      name: 'code_related',
      arguments: { names: ['Lookup'], language: 'go' },
    })
    const nodes = JSON.parse(JSON.stringify(related.value)) as ToolCodeSearch.CodeNode[]
    expect(nodes.map(n => n.name)).toEqual(expect.arrayContaining(['Lookup', 'NewMemoryRepo']))
  }, 60_000)
})
