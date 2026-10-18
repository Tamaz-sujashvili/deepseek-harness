/**
 * Compaction backend that appends deterministic file lists to each summary.
 *
 * The engine is `dsh-compaction-basic` with one change at its documented
 * `summarize()` hook: after the model writes the checkpoint, the engine
 * appends a `<read-files>` and a `<modified-files>` list. The lists come from
 * the file-path arguments of the tool calls in the compacted region (for
 * example `read`, `edit` and `write`) and from the lists of an earlier
 * checkpoint in that region, so they accumulate across compactions. A path
 * that was modified is listed only under `<modified-files>`. Calls whose tool
 * result is an error are not counted. Lists that the model wrote itself are
 * removed first, so each checkpoint carries exactly one copy.
 *
 * The lists are part of the logged `compaction/summary` content, so the
 * compacted request stays reconstructable from the Session log.
 *
 * Evidence: CORVUS (arXiv:2607.22711) keeps a registry of the files an agent
 * works on and reports 9-50% fewer input tokens per task at comparable pass
 * rates; MemTrace (arXiv:2610.04838) anchors compacted memory to files and
 * symbols so the agent can rebuild its state after a context refresh. The
 * list format follows the pi coding agent
 * (`packages/coding-agent/src/core/compaction/utils.ts`).
 *
 * @module @deepseek-ai/dsh-compaction-file-tracking
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig, SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** How one tool's call names a file. */
export interface FileToolRule {
  /** Tool name, for example `read`. */
  tool: string
  /** Name of the string argument that holds the file path. */
  argument: string
  /** `read` for a tool that only reads the file; `modified` for one that changes it. */
  kind: 'read' | 'modified'
}

/** File-tracking settings; every other key is a `dsh-compaction-basic` setting. */
export interface FileTrackingConfig {
  /** Tools whose calls name files; replaces the default list. */
  fileTools?: FileToolRule[]
  /** Most paths kept in each list; the most recently used paths are kept. */
  maxFiles?: number
}

/** Configuration of {@link FileTrackingCompactionEngine}. */
export type FileTrackingCompactionConfig = BasicCompactionConfig & FileTrackingConfig

/** Validated file-tracking settings. */
export interface ResolvedFileTracking {
  readonly fileTools: readonly FileToolRule[]
  readonly maxFiles: number
}

/** Default rules: the `dsh-tool-fs` tools and the `dsh-tool-code-search` read tools. */
export const DEFAULT_FILE_TOOLS: readonly FileToolRule[] = Object.freeze([
  { tool: 'read', argument: 'file_path', kind: 'read' },
  { tool: 'code_outline', argument: 'path', kind: 'read' },
  { tool: 'code_read_symbol', argument: 'path', kind: 'read' },
  { tool: 'edit', argument: 'file_path', kind: 'modified' },
  { tool: 'write', argument: 'file_path', kind: 'modified' },
])

const DEFAULT_MAX_FILES = 50

/**
 * Validate and default the file-tracking settings.
 *
 * @param config - the file-tracking keys of the engine configuration.
 * @returns frozen settings.
 */
export function resolveFileTracking(config: FileTrackingConfig): ResolvedFileTracking {
  const fileTools = config.fileTools ?? DEFAULT_FILE_TOOLS
  const maxFiles = config.maxFiles ?? DEFAULT_MAX_FILES
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error('compaction-file-tracking: maxFiles must be a positive integer')
  for (const [index, rule] of fileTools.entries()) {
    if (rule.tool.length === 0 || rule.argument.length === 0) {
      throw new Error(`compaction-file-tracking: fileTools[${index}] needs a non-empty tool and argument`)
    }
  }
  return Object.freeze({ fileTools: Object.freeze(fileTools.map(rule => Object.freeze({ ...rule }))), maxFiles })
}

/** Files read and modified in a compacted region, oldest first. */
export interface FileLists {
  read: string[]
  modified: string[]
}

const READ_TAG = 'read-files'
const MODIFIED_TAG = 'modified-files'

function listPattern(tag: string): RegExp {
  return new RegExp(`<${tag}>\\n[\\s\\S]*?</${tag}>`, 'g')
}

/** Move `path` to the newest position of `list`. */
function touch(list: string[], path: string): void {
  const at = list.indexOf(path)
  if (at !== -1) list.splice(at, 1)
  list.push(path)
}

function textOf(message: Message): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

function stringArgument(raw: string, key: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    // Malformed model-written arguments name no file; the tool reported its own error.
    void error
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || !(key in parsed)) return undefined
  const value: unknown = Reflect.get(parsed, key)
  // A path with a line ending cannot be written as one list line.
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value) ? value : undefined
}

/**
 * Collect the files named by a compacted region, in the order they were last used.
 *
 * Lists in an earlier checkpoint (a user message with a compaction-checkpoint
 * source) count as uses at their position. A tool call counts unless its
 * result in the region is an error. Paths are kept as written; a path that
 * contains a line ending is not listed.
 *
 * @param messages - the replayed region given to the summarizer.
 * @param tracking - resolved file-tracking settings.
 * @returns the read-only and modified paths, oldest first, each list capped at `maxFiles`.
 */
export function collectFileLists(messages: readonly Message[], tracking: ResolvedFileTracking): FileLists {
  const rules = new Map(tracking.fileTools.map(rule => [rule.tool, rule]))
  const read: string[] = []
  const modified: string[] = []
  const pending = new Map<string, { path: string; kind: FileToolRule['kind'] }>()
  const use = (path: string, kind: FileToolRule['kind']): void => { touch(kind === 'read' ? read : modified, path) }

  for (const message of messages) {
    if (message.role === 'tool') {
      const call = pending.get(message.toolCallId)
      pending.delete(message.toolCallId)
      if (call !== undefined && message.isError !== true) use(call.path, call.kind)
      continue
    }
    const text = textOf(message)
    // Only an earlier checkpoint carries lists forward; tags typed in other messages are ignored.
    if (message.role === 'user' && isCompactCheckpointSource(message.source)) {
      for (const [tag, kind] of [[READ_TAG, 'read'], [MODIFIED_TAG, 'modified']] as const) {
        for (const [list] of text.matchAll(listPattern(tag))) {
          const body = list.slice(tag.length + 2, list.length - tag.length - 3)
          for (const line of body.split('\n')) if (line.trim().length > 0) use(line, kind)
        }
      }
    }
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'tool-call') continue
      const rule = rules.get(block.name)
      const path = rule === undefined ? undefined : stringArgument(block.arguments, rule.argument)
      if (rule !== undefined && path !== undefined) pending.set(block.id, { path, kind: rule.kind })
    }
  }
  // A call whose result is outside the region (still pending) cannot be checked; count it.
  for (const call of pending.values()) use(call.path, call.kind)

  const changed = new Set(modified)
  return {
    read: read.filter(path => !changed.has(path)).slice(-tracking.maxFiles),
    modified: modified.slice(-tracking.maxFiles),
  }
}

/**
 * Replace any file lists in a summary with the given ones.
 *
 * @param summary - text blocks written by the summarizer.
 * @param lists - the lists to append; an empty list is omitted.
 * @returns new summary blocks; the input is unchanged when both lists are empty and the summary has no lists.
 */
export function withFileLists(summary: readonly ContentBlock[], lists: FileLists): ContentBlock[] {
  const stripped = summary.map(block => block.type !== 'text'
    ? block
    : { ...block, text: block.text.replace(listPattern(READ_TAG), '').replace(listPattern(MODIFIED_TAG), '').trimEnd() })
  const sections = [
    ...lists.read.length === 0 ? [] : [`<${READ_TAG}>\n${lists.read.join('\n')}\n</${READ_TAG}>`],
    ...lists.modified.length === 0 ? [] : [`<${MODIFIED_TAG}>\n${lists.modified.join('\n')}\n</${MODIFIED_TAG}>`],
  ]
  return sections.length === 0 ? stripped : [...stripped, { type: 'text', text: `\n\n${sections.join('\n\n')}` }]
}

const fileToolRule: z<FileToolRule> = z.object({
  tool: z.string().required(),
  argument: z.string().required(),
  kind: z.union([z.const('read'), z.const('modified')]).required(),
})

/**
 * `dsh-compaction-basic` with deterministic `<read-files>` and
 * `<modified-files>` lists appended to every summary.
 */
export class FileTrackingCompactionEngine extends BasicCompactionEngine {
  static override Config = z.intersect([
    BasicCompactionEngine.Config,
    z.object({
      fileTools: z.array(fileToolRule),
      maxFiles: z.number().step(1).min(1),
    }),
  ])

  /** Resolved file-tracking settings. */
  readonly fileTracking: ResolvedFileTracking

  constructor(ctx: Context, config: FileTrackingCompactionConfig = {}) {
    const { fileTools, maxFiles, ...basic } = config
    // Validated before the base constructor registers the service, so a bad value registers nothing.
    const fileTracking = resolveFileTracking({
      ...fileTools === undefined ? {} : { fileTools },
      ...maxFiles === undefined ? {} : { maxFiles },
    })
    super(ctx, basic)
    this.fileTracking = fileTracking
  }

  /**
   * Summarize with the basic engine, then append the region's file lists.
   * @param input - replayed conversation prefix to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns the basic summary with the file lists appended.
   */
  protected override async summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    const result = await super.summarize(input, agent, signal)
    return { ...result, summary: withFileLists(result.summary, collectFileLists(input.messages, this.fileTracking)) }
  }
}

export default FileTrackingCompactionEngine
