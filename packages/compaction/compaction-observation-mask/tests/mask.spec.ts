/**
 * Masking over real Sessions: which results are masked, batching, the
 * placeholder text, replay of the masked surface from the log, and the
 * shadow-price events.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as Mask from '@deepseek-ai/dsh-compaction-observation-mask'
import { MASK_PREFIX, maskSession, placeholder } from '@deepseek-ai/dsh-compaction-observation-mask'

function meterContext(): Context {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return ctx
}

function appendToolStep(session: Session, turn: number, call: string, content: ContentBlock[]): void {
  const callId = ToolCallId(call)
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: `{"command":"cat file${turn}.py"}` }],
      source: { kind: 'model', provider: 'test-model', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content, isError: false }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

const BIG = 'x'.repeat(1000)
const CONFIG: Mask.ResolvedConfig = { keepRecent: 2, minChars: 400, batchSize: 2, maxArgumentChars: 160 }

function toolTexts(session: Session): string[] {
  return session.deriveMessages()
    .filter(m => m.role === 'tool')
    .map(m => m.content.map(b => (b.type === 'text' ? b.text : '')).join(''))
}

describe('maskSession', () => {
  it('masks old large results, keeps the newest and small ones', () => {
    const ctx = meterContext()
    const session = Session.create(SessionId('mask'))
    for (let turn = 1; turn <= 5; turn++) appendToolStep(session, turn, `c${turn}`, [{ type: 'text', text: turn === 2 ? 'small' : BIG }])
    const result = maskSession(ctx, session, CONFIG)
    expect(result.masked).toHaveLength(2) // turns 1 and 3; 2 is small; 4 and 5 are recent
    const texts = toolTexts(session)
    expect(texts[0]).toBe(`${MASK_PREFIX} to save context: bash({"command":"cat file1.py"}) returned 1000 characters. Run the tool again if you need this output.]`)
    expect(texts[1]).toBe('small')
    expect(texts[2]?.startsWith(MASK_PREFIX)).toBe(true)
    expect(texts.slice(3)).toEqual([BIG, BIG])
    expect(result.charsRemoved).toBeGreaterThan(1500)
  })

  it('waits for a full batch and never masks twice', () => {
    const ctx = meterContext()
    const session = Session.create(SessionId('batch'))
    for (let turn = 1; turn <= 3; turn++) appendToolStep(session, turn, `c${turn}`, [{ type: 'text', text: BIG }])
    expect(maskSession(ctx, session, CONFIG).masked).toHaveLength(0) // 1 eligible < batchSize 2
    appendToolStep(session, 4, 'c4', [{ type: 'text', text: BIG }])
    expect(maskSession(ctx, session, CONFIG).masked).toHaveLength(2)
    appendToolStep(session, 5, 'c5', [{ type: 'text', text: BIG }])
    expect(maskSession(ctx, session, CONFIG).masked).toHaveLength(0) // only c3 newly old
  })

  it('logs replay-safe replacements with shadow-price events', () => {
    const ctx = meterContext()
    const session = Session.create(SessionId('replay'))
    for (let turn = 1; turn <= 4; turn++) appendToolStep(session, turn, `c${turn}`, [{ type: 'text', text: BIG }])
    maskSession(ctx, session, CONFIG)
    const events = session.snapshotEvents()
    expect(events.filter(e => e.type === 'compaction/prune')).toHaveLength(2)
    const restored = Session.create(SessionId('replay'), events)
    expect(toolTexts(restored)).toEqual(toolTexts(session))
  })
})

describe('placeholder size', () => {
  it('never replaces an output with a longer placeholder', () => {
    const ctx = meterContext()
    const session = Session.create(SessionId('tiny'))
    for (let turn = 1; turn <= 3; turn++) appendToolStep(session, turn, `c${turn}`, [{ type: 'text', text: 'ok' }])
    expect(maskSession(ctx, session, { keepRecent: 0, minChars: 0, batchSize: 1, maxArgumentChars: 160 }).masked).toHaveLength(0)
  })
})

describe('plugin', () => {
  it('rejects invalid config', () => {
    expect(() => new Mask.Config({ batchSize: 0 })).toThrow()
    expect(new Mask.Config({})).toEqual({ keepRecent: 10, minChars: 400, batchSize: 5, maxArgumentChars: 160 })
  })

  it('truncates long arguments in the placeholder', () => {
    const text = placeholder({ name: 'read', arguments: `{"file_path":"${'a'.repeat(300)}"}` }, 10, 20)
    expect(text).toContain('read({"file_path":"aaaaaa…)')
    expect(placeholder(undefined, 5, 20)).toContain('a tool call returned 5 characters')
  })
})
