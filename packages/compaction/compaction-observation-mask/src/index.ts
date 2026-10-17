/**
 * Model-free, replay-safe masking of old tool results.
 *
 * Before each agent step, the plugin keeps the newest `keepRecent` tool
 * results verbatim and replaces each older result larger than `minChars`
 * with one placeholder line that names the tool, its arguments and the
 * original size. Model messages and tool calls are never changed. Masking
 * runs only when at least `batchSize` results qualify, so the request prefix
 * (and the provider KV cache) changes once per batch instead of every step.
 *
 * Each replacement uses the shadow protocol of
 * `@deepseek-ai/dsh-compaction-tool-result-pruner`: a `compaction/prune`
 * shadow-price event, then a `tool/result` event that replaces the node on
 * the Session surface and cites it in `sourceEventSeqs`. The masked request
 * is therefore reconstructable from the Session log.
 *
 * Evidence: arXiv:2508.21433 found that masking old observations halved
 * agent cost and matched or beat LLM summarization on SWE-bench Verified;
 * arXiv:2405.15793 (SWE-agent) found that keeping the last 5 observations
 * scored 18.0% vs 15.0% with the full history.
 *
 * @module @deepseek-ai/dsh-compaction-observation-mask
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'compaction-observation-mask'

/** Services required by the plugin. */
export const inject = ['tokenMeter']

/** Prefix of every placeholder; a result that starts with it is already masked. */
export const MASK_PREFIX = '[Older tool output elided'

/** Plugin configuration for `compaction-observation-mask` (`cordis.yml` `config:`). */
export interface Config {
  /** Newest tool results that always stay verbatim. */
  keepRecent?: number
  /** Results at or below this many characters are never masked. */
  minChars?: number
  /** Minimum number of qualifying results before one masking pass runs. */
  batchSize?: number
  /** Maximum characters of tool arguments quoted in the placeholder. */
  maxArgumentChars?: number
}

export const Config: z<Config> = z.object({
  keepRecent: z.number().step(1).min(0).default(10),
  minChars: z.number().step(1).min(0).default(400),
  batchSize: z.number().step(1).min(1).default(5),
  maxArgumentChars: z.number().step(1).min(0).default(160),
})

/** Plugin config after schemastery defaulting. */
export type ResolvedConfig = Required<Config>

/** One masked result. */
export interface MaskedEntry {
  originalSeq: SessionSeq
  replacementSeq: SessionSeq
  charsBefore: number
}

/** Result of one {@link maskSession} pass. */
export interface MaskResult {
  masked: MaskedEntry[]
  charsRemoved: number
}

interface CallInfo {
  name: string
  arguments: string
}

function textChars(blocks: readonly ContentBlock[]): number {
  let chars = 0
  for (const block of blocks) if (block.type === 'text') chars += block.text.length
  return chars
}

function isMasked(blocks: readonly ContentBlock[]): boolean {
  const first = blocks[0]
  return blocks.length === 1 && first?.type === 'text' && first.text.startsWith(MASK_PREFIX)
}

/**
 * Build the placeholder text for one masked result.
 *
 * @param call - the tool name and raw JSON arguments, when the call is on the surface.
 * @param chars - characters of the original output.
 * @param maxArgumentChars - maximum quoted argument characters.
 * @returns the placeholder line.
 */
export function placeholder(call: CallInfo | undefined, chars: number, maxArgumentChars: number): string {
  const args = call === undefined ? '' : call.arguments.replace(/\s+/g, ' ')
  const quoted = args.length > maxArgumentChars ? `${args.slice(0, maxArgumentChars)}…` : args
  const what = call === undefined ? 'a tool call' : `${call.name}(${quoted})`
  return `${MASK_PREFIX} to save context: ${what} returned ${chars} characters. Run the tool again if you need this output.]`
}

interface Candidate {
  seq: SessionSeq
  event: SessionEvent<'tool/result'>
  message: ToolResultMessage
}

/**
 * Mask old tool results of one Session in place (one batch).
 *
 * @param ctx - context providing `tokenMeter` for the shadow-price events.
 * @param session - the Session whose current surface is rewritten.
 * @param config - resolved plugin config.
 * @returns the landed replacements; empty when fewer than `batchSize` results qualify.
 */
export function maskSession(ctx: Context, session: Session, config: ResolvedConfig): MaskResult {
  const calls = new Map<string, CallInfo>()
  const results: Candidate[] = []
  for (const seq of [...session.surface.nodes]) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read, same as the tool-result pruner.
    const event = session.eventAt(seq)
    if (event?.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call') calls.set(block.id, { name: block.name, arguments: block.arguments })
      }
    } else if (event?.type === 'tool/result') {
      results.push({ seq, event, message: session.deriveEventMessage(event) as ToolResultMessage })
    }
  }

  const old = results.slice(0, Math.max(0, results.length - config.keepRecent))
  // A placeholder must be shorter than the output it replaces, whatever minChars is.
  const eligible = old
    .filter(r => !isMasked(r.message.content) && textChars(r.message.content) > config.minChars)
    .map((r) => {
      const charsBefore = textChars(r.message.content)
      return { ...r, charsBefore, text: placeholder(calls.get(r.message.toolCallId), charsBefore, config.maxArgumentChars) }
    })
    .filter(r => r.text.length < r.charsBefore)
  if (eligible.length < config.batchSize) return { masked: [], charsRemoved: 0 }

  const masked: MaskedEntry[] = []
  let charsRemoved = 0
  for (const { seq, event, message, charsBefore, text } of eligible) {
    const replacement = freezeMessage<ToolResultMessage>({ ...message, content: [{ type: 'text', text }] })
    // Shadow-price protocol: the metering event and its replacement are
    // appended synchronously adjacent (see the tool-result pruner).
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: ctx.tokenMeter.estimateMessage(message),
    })
    const appended = session.append('tool/result', { ...event.data, message: replacement }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
    masked.push({ originalSeq: seq, replacementSeq: appended.seq, charsBefore })
    charsRemoved += charsBefore - text.length
  }
  return { masked, charsRemoved }
}

/**
 * Register the masking pass on `agent/pre-step`.
 *
 * @param ctx - plugin context; the listener is an effect scoped to this plugin.
 * @param config - resolved plugin configuration from schemastery.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    if (!signal.aborted) {
      try {
        const result = maskSession(ctx, agent.session, resolved)
        if (result.masked.length > 0) {
          ctx.logger.info(`observation mask: elided ${result.masked.length} tool results (~${result.charsRemoved} characters)`)
        }
      } catch (error: unknown) {
        // Masking is an optimization: a failed pass must not stop the turn.
        ctx.logger.warn('observation mask failed; continuing the turn:', error)
      }
    }
    return next()
  })
}
