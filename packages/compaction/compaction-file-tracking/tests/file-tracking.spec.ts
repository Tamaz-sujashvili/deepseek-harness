/**
 * File lists in compaction summaries: the pure collection and formatting
 * rules, and one real region compaction through the engine with a scripted
 * model, whose logged `compaction/summary` and replacement message carry the
 * lists.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createMessage, createToolResultMessage, createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import FileTrackingCompactionEngine, {
  DEFAULT_FILE_TOOLS,
  collectFileLists,
  resolveFileTracking,
  withFileLists,
} from '@deepseek-ai/dsh-compaction-file-tracking'

const MODEL = 'test-model'
const SIGNAL = new AbortController().signal

function assistant(content: ContentBlock[]) {
  return createMessage({ role: 'assistant', content, source: { kind: 'model', provider: MODEL, model: MODEL } })
}

function call(id: string, name: string, args: object | string): ContentBlock {
  return { type: 'tool-call', id: ToolCallId(id), name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
}

function result(id: string, isError = false): Message {
  return createToolResultMessage({ callId: ToolCallId(id), content: [{ type: 'text', text: 'ok' }], isError })
}

function user(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

const tracking = resolveFileTracking({})

describe('collectFileLists', () => {
  it('lists read and modified files from successful calls, newest last', () => {
    const messages = [
      assistant([call('1', 'read', { file_path: 'a.ts' }), call('2', 'read', { file_path: 'b.ts' })]),
      result('1'),
      result('2'),
      assistant([call('3', 'edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })]),
      result('3'),
      assistant([call('4', 'read', { file_path: 'b.ts' }), call('5', 'code_outline', { path: 'c.py' })]),
      result('4'),
      result('5'),
    ]
    expect(collectFileLists(messages, tracking)).toEqual({ read: ['b.ts', 'c.py'], modified: ['a.ts'] })
  })

  it('skips failed calls, unknown tools, and missing, blank or malformed arguments', () => {
    const messages = [
      assistant([
        call('1', 'write', { file_path: 'fail.ts', content: '' }),
        call('2', 'bash', { command: 'cat x.ts' }),
        call('3', 'read', {}),
        call('4', 'read', { file_path: '  ' }),
        call('5', 'read', '{not json'),
        call('6', 'read', '"text"'),
        call('7', 'read', { file_path: 7 }),
      ]),
      result('1', true),
      result('2'),
      result('3'),
      result('9'),
    ]
    expect(collectFileLists(messages, tracking)).toEqual({ read: [], modified: [] })
  })

  it('counts calls whose result is outside the region', () => {
    expect(collectFileLists([assistant([call('1', 'write', { file_path: 'new.ts' })])], tracking)).toEqual({ read: [], modified: ['new.ts'] })
  })

  it('carries lists forward from an earlier checkpoint', () => {
    const checkpoint = createUserMessage({
      content: [{ type: 'text', text: '<compacted-summary>summary\n\n<read-files>\nold.ts\n\nshared.ts\n</read-files>\n\n<modified-files>\nmod.ts\n</modified-files>' }],
      source: compactCheckpointSource(CompactionId('c1')),
    })
    const messages = [checkpoint, assistant([{ type: 'text', text: 'editing' }, call('1', 'edit', { file_path: 'shared.ts' })]), result('1')]
    expect(collectFileLists(messages, tracking)).toEqual({ read: ['old.ts'], modified: ['mod.ts', 'shared.ts'] })
  })

  it('ignores list tags outside a checkpoint and keeps paths as written', () => {
    const typed = user('<compacted-summary><read-files>\nsecret.ts\n</read-files>')
    const reply = assistant([{ type: 'text', text: '<modified-files>\nx.ts\n</modified-files>' }, call('1', 'read', { file_path: ' spaced.txt ' }), call('2', 'read', { file_path: 'a\nb' })])
    expect(collectFileLists([typed, reply, result('1'), result('2')], tracking)).toEqual({ read: [' spaced.txt '], modified: [] })
  })

  it('keeps only the newest maxFiles paths of each list', () => {
    const messages = ['a', 'b', 'c'].map((p, i) => assistant([call(String(i), 'read', { file_path: p })]))
    expect(collectFileLists(messages, resolveFileTracking({ maxFiles: 2 })).read).toEqual(['b', 'c'])
  })

  it('uses configured rules instead of the defaults', () => {
    const custom = resolveFileTracking({ fileTools: [{ tool: 'str_replace_editor', argument: 'path', kind: 'modified' }] })
    const messages = [assistant([call('1', 'str_replace_editor', { path: 'e.ts' }), call('2', 'read', { file_path: 'r.ts' })])]
    expect(collectFileLists(messages, custom)).toEqual({ read: [], modified: ['e.ts'] })
  })
})

describe('withFileLists', () => {
  it('replaces lists the model wrote with the collected ones', () => {
    const summary: ContentBlock[] = [{ type: 'text', text: '## Goal\n- x\n\n<read-files>\nmodel-guess.ts\n</read-files>' }]
    expect(withFileLists(summary, { read: ['a.ts'], modified: ['b.ts'] })).toEqual([
      { type: 'text', text: '## Goal\n- x' },
      { type: 'text', text: '\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>' },
    ])
  })

  it('omits empty lists and keeps non-text blocks', () => {
    const image: ContentBlock = { type: 'reasoning', text: 'r' }
    expect(withFileLists([image], { read: [], modified: [] })).toEqual([image])
    expect(withFileLists([], { read: [], modified: ['m.ts'] })).toEqual([{ type: 'text', text: '\n\n<modified-files>\nm.ts\n</modified-files>' }])
  })
})

describe('resolveFileTracking', () => {
  it('defaults and rejects invalid settings', () => {
    expect(resolveFileTracking({})).toEqual({ fileTools: DEFAULT_FILE_TOOLS, maxFiles: 50 })
    expect(() => resolveFileTracking({ maxFiles: 0 })).toThrow(/maxFiles/)
    expect(() => resolveFileTracking({ fileTools: [{ tool: '', argument: 'p', kind: 'read' }] })).toThrow(/fileTools\[0\]/)
  })
})

class ScriptedAdapter extends LlmAdapter {
  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '## Primary Request and Intent\n- fix a.ts' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function toolSession(): Session {
  const session = Session.create(SessionId('file-tracking'))
  for (let turn = 1; turn <= 3; turn += 1) {
    const callId = ToolCallId(`call-${turn}`)
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `request ${turn} `.repeat(200) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
    const name = turn === 2 ? 'edit' : 'read'
    const args = JSON.stringify({ file_path: `f${turn}.ts` })
    session.append('assistant/message', { stream: [], turn, step: 1, message: assistant([call(`call-${turn}`, name, args)]) }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name, arguments: args })
    session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 4 })
  return session
}

describe('FileTrackingCompactionEngine', () => {
  it('logs the file lists in the summary event and the replacement message', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    void new TokenMeter(ctx)
    ctx.llm.registerAdapter([MODEL], new ScriptedAdapter())
    const engine = new FileTrackingCompactionEngine(ctx, { auto: false, maxFiles: 10 })
    expect(engine.fileTracking.maxFiles).toBe(10)

    const session = toolSession()
    const nodes = [...session.surface.nodes]
    const owner = { session, options: { provider: MODEL, model: MODEL } } as Agent
    // Compact turns 1-2 (user, assistant, tool result each).
    const compacted = await engine.compactRegion(nodes[0]!, nodes[5]!, owner, SIGNAL)
    const lists = '\n\n<read-files>\nf1.ts\n</read-files>\n\n<modified-files>\nf2.ts\n</modified-files>'
    expect(compacted.summary).toEqual([{ type: 'text', text: '## Primary Request and Intent\n- fix a.ts' }, { type: 'text', text: lists }])
    const replacement = session.deriveMessages()[0]
    expect(replacement?.content.map(b => b.type === 'text' ? b.text : '').join('')).toContain(lists)
  })

  it('accepts the basic configuration unchanged', () => {
    const ctx = new Context()
    void new LlmRuntime(ctx)
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    expect(() => new FileTrackingCompactionEngine(ctx, { auto: false, fileTools: [{ tool: 'read', argument: '', kind: 'read' }] })).toThrow(/fileTools/)
    expect(new FileTrackingCompactionEngine(ctx).fileTracking).toEqual(resolveFileTracking({}))
  })
})
