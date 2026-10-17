/**
 * Model-facing semantic + structural code search (`code_search`,
 * `code_related`) backed by the senior-code-mcp index.
 *
 * `grep` / `glob` (tool-fs-search) stay registered: they answer exact
 * identifier and string lookups. These tools answer the questions ripgrep
 * cannot — "where is the retry logic", "what calls this" — from an index of
 * symbol-level chunks (embeddings in Qdrant) and a call/import graph.
 * Evidence for the split: a structural + semantic index inside a coding
 * agent raised resolve rate 41.9% → 50.4% and cut turns 36 → 28 against the
 * same harness with grep only (arXiv:2606.22417).
 *
 * ## Spawn-backed, like tool-fs-search
 *
 * Each call spawns the `senior-code-search` JSON CLI through
 * `ctx.subprocess.spawn()` with a fixed argv (no shell), so cancellation,
 * process-tree termination and environment scrubbing stay behind the
 * subprocess seam. The CLI prints one JSON document; exit 2 carries
 * `{"error": ...}`.
 *
 * The index is built out of band (`senior-code-ingest <repo>`); returned
 * paths are relative to the ingested repo root, so they are follow-up
 * readable when the session workspace is that root.
 *
 * @module @deepseek-ai/dsh-tool-code-search
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-code-search'

/** Services required by the code search tools. */
export const inject = ['tools', 'systemPrompt', 'subprocess', 'workingDirectory']

/** Languages the index tags chunks with (senior-code-mcp `ingest/languages.py`). */
export const CODE_SEARCH_LANGUAGES = ['python', 'javascript', 'typescript', 'tsx', 'go', 'rust', 'java'] as const

/** Default number of semantic hits per `code_search` call. */
export const CODE_SEARCH_TOP_K = 5

/** Max lines of source kept per hit in the model-facing text. */
export const CODE_SEARCH_MAX_HIT_LINES = 40

/** Plugin configuration for `tool-code-search` (`cordis.yml` `config:`). */
export interface Config {
  /**
   * Ingested repo name whose hits `code_search` returns. Unset: the base name
   * of the session working directory, which is the name `senior-code-ingest`
   * records for that directory. `'*'`: hits from every ingested repo.
   */
  repo?: string
  /** argv prefix of the senior-code-search CLI, e.g. `['/path/.venv/bin/senior-code-search']`. */
  command: string[]
  /** Extra environment for the CLI (QDRANT_URL, QDRANT_COLLECTION, GRAPH_PATH, OLLAMA_URL, ...). */
  env?: Record<string, string>
  /** Default semantic hits per call. */
  topK?: number
  /** Max source lines per hit in the model-facing text. */
  maxHitLines?: number
  /** Max raw CLI stdout bytes parsed. */
  rawOutputMaxBytes?: number
  /** Cooperative tool-call timeout (ms). Embedding a query on a cold Ollama can take seconds. */
  timeoutMs?: number
  /** Terminate-escalation grace (ms). */
  graceMs?: number
}

export const Config: z<Config> = z.object({
  repo: z.string(),
  command: z.array(z.string()).required(),
  env: z.dict(z.string()),
  topK: z.number().default(CODE_SEARCH_TOP_K),
  maxHitLines: z.number().default(CODE_SEARCH_MAX_HIT_LINES),
  rawOutputMaxBytes: z.number().default(4 * 1024 * 1024),
  timeoutMs: z.number().default(60_000),
  graceMs: z.number().default(2_000),
})

/** Plugin config after schemastery defaulting. */
export type ResolvedConfig = Required<Omit<Config, 'env' | 'repo'>> & Pick<Config, 'env' | 'repo'>

/** One semantic hit, as the CLI returns it (snake_case wire names). */
export interface WireChunk {
  score: number
  path: string
  name: string
  kind: string
  language?: string | null | undefined
  start_line: number
  end_line: number
  docstring?: string | null | undefined
  text?: string | null | undefined
}

/** One graph node, as the CLI returns it. */
export interface WireNode {
  name?: string | null | undefined
  kind?: string | null | undefined
  language?: string | null | undefined
  path?: string | null | undefined
  start_line?: number | null | undefined
  end_line?: number | null | undefined
  hops: number
}

/** Canonical hit value returned to the model / PTC programs. */
export interface CodeHit {
  path: string
  name: string
  kind: string
  language?: string
  startLine: number
  endLine: number
  score: number
  docstring?: string
  source?: string
}

/** Canonical graph neighbour value. */
export interface CodeNode {
  name: string
  kind: string
  language?: string
  path?: string
  startLine?: number
  endLine?: number
  hops: number
}

/** Canonical `code_search` result. */
export interface CodeSearchResult {
  hits: CodeHit[]
  related: CodeNode[]
}

/** A CLI failure the model can act on (missing index, services down, bad argv). */
export class CodeSearchError extends Error {
  override name = 'CodeSearchError'
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`tool-code-search: ${field} must be a positive integer`)
}

function validateLanguage(language: string | undefined): void {
  if (language !== undefined && !(CODE_SEARCH_LANGUAGES as readonly string[]).includes(language)) {
    throw new Error(`language must be one of ${CODE_SEARCH_LANGUAGES.join(', ')}`)
  }
}

function boundedInt(field: string, value: number | undefined, fallback: number, max: number): number {
  const v = value ?? fallback
  if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`${field} must be an integer between 0 and ${max}`)
  return v
}

/**
 * Build the CLI argv tail for one `code_search` call. Every model-controlled
 * value is its own argv element in `--flag=value` form, so a leading-dash
 * query can never be parsed as a flag.
 *
 * @param input - validated `code_search` arguments after defaulting; `repo` undefined searches every repo.
 * @returns the CLI argv tail (after the configured command).
 */
export function buildContextArgv(input: { query: string; topK: number; hops: number; language?: string; repo?: string }): string[] {
  const argv = ['context', `--query=${input.query}`, `--top-k=${input.topK}`, `--hops=${input.hops}`]
  if (input.language !== undefined) argv.push(`--language=${input.language}`)
  if (input.repo !== undefined) argv.push(`--repo=${input.repo}`)
  return argv
}

/**
 * Confine a model-supplied file path to the session working directory.
 * `code_outline` / `code_read_symbol` read files through an external
 * process, outside the `read` tool's filesystem sandbox, so they accept only
 * paths inside the workspace. The CLI repeats the check on the real path, so
 * a symlink cannot leave the workspace either.
 *
 * @param workdir - the session working directory (the process cwd).
 * @param path - the model-supplied path, absolute or relative to `workdir`.
 * @returns the path relative to `workdir`.
 * @throws {CodeSearchError} when the path is outside the workspace.
 */
export function workspaceRelative(workdir: string, path: string): string {
  const rel = relative(workdir, resolve(workdir, path))
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CodeSearchError(`path must name a file inside the workspace: ${path}`)
  }
  return rel
}

/**
 * Resolve the repo filter for one call.
 *
 * @param configured - the `repo` config value.
 * @param workdir - the session working directory.
 * @returns the repo name to filter on, or undefined for every repo (`'*'`).
 */
export function resolveRepo(configured: string | undefined, workdir: string): string | undefined {
  if (configured === '*') return undefined
  return configured ?? basename(workdir)
}

/**
 * Build the CLI argv tail for one `code_related` call (one `--name=` per name).
 *
 * @param input - validated `code_related` arguments after defaulting.
 * @returns the CLI argv tail (after the configured command).
 */
export function buildRelatedArgv(input: { names: readonly string[]; hops: number; language?: string }): string[] {
  const argv = ['related', ...input.names.map(n => `--name=${n}`), `--hops=${input.hops}`]
  if (input.language !== undefined) argv.push(`--language=${input.language}`)
  return argv
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(record: JsonRecord, key: string): string | null | undefined {
  const value = record[key]
  if (value === undefined || value === null || typeof value === 'string') return value
  throw new CodeSearchError(`code search returned a non-string ${key}`)
}

function optionalInt(record: JsonRecord, key: string): number | null | undefined {
  const value = record[key]
  if (value === undefined || value === null || Number.isInteger(value)) return value as number | null | undefined
  throw new CodeSearchError(`code search returned a non-integer ${key}`)
}

function requiredString(record: JsonRecord, key: string): string {
  const value = optionalString(record, key)
  if (value === undefined || value === null) throw new CodeSearchError(`code search returned a record without ${key}`)
  return value
}

function requiredInt(record: JsonRecord, key: string): number {
  const value = optionalInt(record, key)
  if (value === undefined || value === null) throw new CodeSearchError(`code search returned a record without ${key}`)
  return value
}

/**
 * Validate one CLI hit record.
 *
 * @param value - one element of the CLI `similar_chunks` array.
 * @returns the typed record.
 * @throws {CodeSearchError} when a required field is missing or mistyped.
 */
export function parseWireChunk(value: unknown): WireChunk {
  if (!isRecord(value)) throw new CodeSearchError('code search returned a non-object hit')
  const score = value['score']
  if (typeof score !== 'number') throw new CodeSearchError('code search returned a hit without score')
  return {
    score,
    path: requiredString(value, 'path'),
    name: requiredString(value, 'name'),
    kind: requiredString(value, 'kind'),
    language: optionalString(value, 'language'),
    start_line: requiredInt(value, 'start_line'),
    end_line: requiredInt(value, 'end_line'),
    docstring: optionalString(value, 'docstring'),
    text: optionalString(value, 'text'),
  }
}

/**
 * Validate one CLI graph-node record.
 *
 * @param value - one element of a CLI node array.
 * @returns the typed record.
 * @throws {CodeSearchError} when `hops` is missing or a field is mistyped.
 */
export function parseWireNode(value: unknown): WireNode {
  if (!isRecord(value)) throw new CodeSearchError('code search returned a non-object graph node')
  return {
    name: optionalString(value, 'name'),
    kind: optionalString(value, 'kind'),
    language: optionalString(value, 'language'),
    path: optionalString(value, 'path'),
    start_line: optionalInt(value, 'start_line'),
    end_line: optionalInt(value, 'end_line'),
    hops: requiredInt(value, 'hops'),
  }
}

/** One definition of a file outline (canonical value). */
export interface OutlineEntry {
  name: string
  qualified: string
  kind: string
  language?: string
  startLine: number
  endLine: number
}

/** The exact source of one definition (canonical value). */
export interface SymbolSource extends OutlineEntry {
  path: string
  source: string
  /** Line ranges of other definitions with the same name (overload signatures, redefinitions). */
  otherRanges?: Array<{ startLine: number; endLine: number }>
}

/**
 * Validate one CLI outline record.
 *
 * @param value - one element of the CLI `outline` array.
 * @returns the canonical outline entry.
 * @throws {CodeSearchError} when a required field is missing or mistyped.
 */
export function parseOutlineEntry(value: unknown): OutlineEntry {
  if (!isRecord(value)) throw new CodeSearchError('code search returned a non-object outline entry')
  const language = optionalString(value, 'language')
  return {
    name: requiredString(value, 'name'),
    qualified: requiredString(value, 'qualified'),
    kind: requiredString(value, 'kind'),
    ...language != null ? { language } : {},
    startLine: requiredInt(value, 'start_line'),
    endLine: requiredInt(value, 'end_line'),
  }
}

/**
 * Validate the CLI `symbol` document.
 *
 * @param value - the CLI `symbol` result.
 * @returns the canonical symbol source.
 * @throws {CodeSearchError} when a required field is missing or mistyped.
 */
export function parseSymbolSource(value: unknown): SymbolSource {
  if (!isRecord(value)) throw new CodeSearchError('code search returned a non-object symbol')
  const others = value['other_ranges']
  const otherRanges = others === undefined || others === null
    ? []
    : expectArray(others, 'other_ranges').map((range) => {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(n => Number.isInteger(n))) {
        throw new CodeSearchError('code search returned a malformed other_ranges entry')
      }
      return { startLine: range[0] as number, endLine: range[1] as number }
    })
  return {
    ...parseOutlineEntry(value),
    path: requiredString(value, 'path'),
    source: requiredString(value, 'source'),
    ...otherRanges.length > 0 ? { otherRanges } : {},
  }
}

/**
 * Model-facing outline: one `start-end kind qualified` line per definition.
 *
 * @param path - the file path the model asked for.
 * @param entries - canonical outline entries in source order.
 * @returns the text block.
 */
export function formatOutline(path: string, entries: readonly OutlineEntry[]): string {
  if (entries.length === 0) return `No definitions found in ${path}.`
  return [`${path} (${entries.length} definitions):`, ...entries.map(e => `${e.startLine}-${e.endLine} ${e.kind} ${e.qualified}`)].join('\n')
}

/**
 * Model-facing symbol source with file line numbers, in the `read` tool layout.
 *
 * @param value - the canonical symbol source.
 * @returns the text block.
 */
export function formatSymbol(value: SymbolSource): string {
  const lines = value.source.replace(/\n$/, '').split('\n')
  const width = String(value.startLine + lines.length - 1).length
  const body = lines.map((line, i) => `${String(value.startLine + i).padStart(width)}\t${line}`)
  const others = value.otherRanges === undefined
    ? []
    : [`Other definitions named ${value.qualified}: ${value.otherRanges.map(r => `${r.startLine}-${r.endLine}`).join(', ')}`]
  return [`${value.path}:${value.startLine}-${value.endLine} ${value.kind} ${value.qualified}`, ...body, ...others].join('\n')
}

/**
 * Convert a validated hit to the canonical tool value (camelCase, no nulls).
 *
 * @param chunk - a validated CLI hit.
 * @returns the canonical hit.
 */
export function toHit(chunk: WireChunk): CodeHit {
  return {
    path: chunk.path,
    name: chunk.name,
    kind: chunk.kind,
    ...chunk.language != null ? { language: chunk.language } : {},
    startLine: chunk.start_line,
    endLine: chunk.end_line,
    score: Math.round(chunk.score * 1000) / 1000,
    ...chunk.docstring != null ? { docstring: chunk.docstring } : {},
    ...chunk.text != null ? { source: chunk.text } : {},
  }
}

/**
 * Convert a validated graph node to the canonical tool value.
 *
 * @param node - a validated CLI graph node.
 * @returns the canonical node; a missing name or kind (module nodes) reads `?`.
 */
export function toNode(node: WireNode): CodeNode {
  return {
    name: node.name ?? '?',
    kind: node.kind ?? '?',
    ...node.language != null ? { language: node.language } : {},
    ...node.path != null ? { path: node.path } : {},
    ...node.start_line != null ? { startLine: node.start_line } : {},
    ...node.end_line != null ? { endLine: node.end_line } : {},
    hops: node.hops,
  }
}

function location(n: { path?: string; startLine?: number; endLine?: number }): string {
  if (n.path === undefined) return '(no file)'
  if (n.startLine === undefined) return n.path
  return n.endLine !== undefined && n.endLine !== n.startLine ? `${n.path}:${n.startLine}-${n.endLine}` : `${n.path}:${n.startLine}`
}

function clipLines(text: string, maxLines: number): string {
  const lines = text.replace(/\n$/, '').split('\n')
  if (lines.length <= maxLines) return lines.join('\n')
  return `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} more lines; use read for the rest)`
}

/**
 * Model-facing text: one block per hit (location, kind, name, score, first
 * doc line, clipped source), then a compact neighbour list.
 *
 * @param value - the canonical `code_search` result.
 * @param maxHitLines - max source lines kept per hit.
 * @returns the text block.
 */
export function formatCodeSearch(value: CodeSearchResult, maxHitLines: number): string {
  if (value.hits.length === 0) return 'No indexed code matched. Try grep for exact identifiers, or re-run senior-code-ingest if the index is stale.'
  const parts = value.hits.map((h, i) => {
    const head = `[${i + 1}] ${location(h)} ${h.kind} ${h.name}${h.language !== undefined ? ` (${h.language})` : ''} score=${h.score}`
    const doc = h.docstring !== undefined ? `\n  doc: ${h.docstring.split('\n')[0]}` : ''
    const src = h.source !== undefined ? `\n${clipLines(h.source, maxHitLines)}` : ''
    return head + doc + src
  })
  if (value.related.length > 0) parts.push(`Related (callers/callees/imports):\n${formatNodes(value.related)}`)
  return parts.join('\n\n')
}

/**
 * Model-facing neighbour list, one line per node.
 *
 * @param nodes - canonical graph nodes.
 * @returns the text block.
 */
export function formatNodes(nodes: readonly CodeNode[]): string {
  if (nodes.length === 0) return 'No graph neighbours found for these names.'
  return nodes.map(n => `- ${n.hops === 0 ? 'seed' : `hop ${n.hops}`}: ${n.kind} ${n.name} ${location(n)}`).join('\n')
}

/**
 * Run the CLI once and parse its single JSON document.
 *
 * @param ctx - plugin context providing `subprocess` and `workingDirectory`.
 * @param exec - the tool execution; its signal cancels the process.
 * @param config - resolved plugin config.
 * @param argvFor - builds the CLI argv tail ({@link buildContextArgv} / {@link buildRelatedArgv}) for the resolved working directory.
 * @returns the parsed JSON document.
 * @throws {CodeSearchError} on spawn failure, abort, non-zero exit, or non-JSON output.
 */
export async function runCodeSearch(
  ctx: Context,
  exec: ToolExecution,
  config: ResolvedConfig,
  argvFor: (workdir: string) => readonly string[],
): Promise<unknown> {
  if (exec.signal.aborted) throw new CodeSearchError('code search was aborted before completion')
  const workdir = exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  const argv = argvFor(workdir)
  let handle: SubprocessHandle
  try {
    handle = ctx.subprocess.spawn({
      argv: [...config.command, ...argv],
      cwd: workdir,
      ...config.env !== undefined ? { env: config.env } : {},
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: config.rawOutputMaxBytes },
        stderr: { maxBytes: 16 * 1024 },
      },
      graceMs: config.graceMs,
      signal: exec.signal,
    } satisfies SubprocessSpawnSpec)
  } catch (error: unknown) {
    throw new CodeSearchError(`code search could not start ${config.command[0] ?? '(empty command)'}; is senior-code-mcp installed?`, { cause: error })
  }
  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    throw new CodeSearchError('code search subprocess failed before reporting an outcome', { cause: error })
  }
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while awaited
  if (exec.signal.aborted) throw new CodeSearchError('code search was aborted before completion')
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined) throw new CodeSearchError('code search produced no collected stdout')
  if (stdout.lossy) throw new CodeSearchError(`code search output exceeded ${config.rawOutputMaxBytes} bytes; lower top_k or hops`)
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.text)
  } catch {
    const tail = stderr?.text.trim().split('\n').slice(-3).join(' | ') ?? ''
    throw new CodeSearchError(`code search returned non-JSON output (exit ${outcome.exitCode ?? outcome.signal})${tail ? `: ${tail}` : ''}`)
  }
  if (isRecord(parsed) && 'error' in parsed) {
    throw new CodeSearchError(`code search failed: ${String(parsed['error'])}`)
  }
  if (outcome.exitCode !== 0) throw new CodeSearchError(`code search exited with ${outcome.exitCode ?? outcome.signal}`)
  return parsed
}

function expectArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new CodeSearchError(`code search returned malformed ${what}`)
  return value
}

const HIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    name: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    language: { type: 'string' },
    startLine: { type: 'integer', required: true },
    endLine: { type: 'integer', required: true },
    score: { type: 'number', required: true },
    docstring: { type: 'string' },
    source: { type: 'string' },
  },
} as const

const NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    language: { type: 'string' },
    path: { type: 'string' },
    startLine: { type: 'integer' },
    endLine: { type: 'integer' },
    hops: { type: 'integer', required: true },
  },
} as const

const OUTLINE_PROPERTIES = {
  name: { type: 'string', required: true },
  qualified: { type: 'string', required: true },
  kind: { type: 'string', required: true },
  language: { type: 'string' },
  startLine: { type: 'integer', required: true },
  endLine: { type: 'integer', required: true },
} as const

const OUTLINE_SCHEMA = { type: 'object', additionalProperties: false, properties: OUTLINE_PROPERTIES } as const

const SYMBOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...OUTLINE_PROPERTIES,
    path: { type: 'string', required: true },
    source: { type: 'string', required: true },
    otherRanges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { startLine: { type: 'integer', required: true }, endLine: { type: 'integer', required: true } },
      },
    },
  },
} as const

const LANGUAGE_PARAM = {
  type: 'string',
  description: `Restrict to one language: ${CODE_SEARCH_LANGUAGES.join(', ')}.`,
} as const

/**
 * Register `code_search` and `code_related` plus their routing guidance.
 *
 * @param ctx - plugin context; registrations are effects scoped to this plugin.
 * @param config - resolved plugin configuration from schemastery.
 */
// oxlint-disable-next-line typescript/require-await -- async keeps a load-time config rejection a rejection
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as ResolvedConfig
  if ((resolved.command[0] ?? '').trim().length === 0) {
    throw new Error('tool-code-search: command must name the senior-code-search executable')
  }
  assertPositiveInteger('topK', resolved.topK)
  assertPositiveInteger('maxHitLines', resolved.maxHitLines)
  assertPositiveInteger('rawOutputMaxBytes', resolved.rawOutputMaxBytes)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  assertPositiveInteger('graceMs', resolved.graceMs)

  ctx.systemPrompt.section({
    name: 'tool:code_search',
    order: ctx.systemPrompt.getSectionOrder('TOOL_CODE_SEARCH'),
    text: ({ scope }) => {
      if (ctx.tools.get('code_search', scope) === undefined) return ''
      const grep = ctx.tools.get('grep', scope) !== undefined
      return 'When you need to find where some behaviour is implemented, call code_search first, before grep, find or reading files: '
        + 'one call returns the matching functions/classes with their source and their callers/callees. '
        + 'Use code_related to list what calls or is called by a symbol you already know. '
        + 'Use code_outline to see the functions and classes of a file, and code_read_symbol to read one of them, instead of reading the whole file.'
        + (grep ? ' Use grep only for exact identifiers, strings, or regular expressions.' : '')
    },
  })

  ctx.tools.register(defineTool({
    name: 'code_search',
    description: 'Semantic + structural code search over the indexed repository. Embeds a natural-language or code query, '
      + 'returns the best-matching functions/classes/methods (path, lines, docstring, source) and their graph neighbours '
      + '(callers, callees, imports). Prefer it over grep for "where is X done" questions.',
    parameters: {
      query: { type: 'string', required: true, description: 'What the code does, in words or as a code fragment.' },
      language: LANGUAGE_PARAM,
      top_k: { type: 'integer', description: `Number of hits (1-20, default ${resolved.topK}).` },
      hops: { type: 'integer', description: 'Graph hops around the hits (0-2, default 1). 0 = no neighbours.' },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: { type: 'array', required: true, items: HIT_SCHEMA },
          related: { type: 'array', required: true, items: NODE_SCHEMA },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatCodeSearch(value, resolved.maxHitLines) }],
    },
    async execute(args, exec) {
      if (args.query.trim().length === 0) throw new Error('query must be a non-empty string')
      validateLanguage(args.language)
      const topK = boundedInt('top_k', args.top_k, resolved.topK, 20)
      if (topK === 0) throw new Error('top_k must be at least 1')
      const hops = boundedInt('hops', args.hops, 1, 2)
      const raw = await runCodeSearch(ctx, exec, resolved, (workdir) => {
        const repo = resolveRepo(resolved.repo, workdir)
        return buildContextArgv({
          query: args.query,
          topK,
          hops,
          ...args.language !== undefined ? { language: args.language } : {},
          ...repo !== undefined ? { repo } : {},
        })
      })
      if (!isRecord(raw)) throw new CodeSearchError('code search returned a non-object context result')
      return {
        hits: expectArray(raw['similar_chunks'], 'similar_chunks').map(c => toHit(parseWireChunk(c))),
        related: expectArray(raw['related_symbols'], 'related_symbols').map(n => toNode(parseWireNode(n))),
      }
    },
    presentCall: args => ({ card: 'generic', title: `code_search ${args.query}`, kind: 'search' }),
  }))

  ctx.tools.register(defineTool({
    name: 'code_related',
    description: 'Structural code search: list the callers, callees and imports of named symbols from the call/import graph. '
      + 'Accepts plain names ("save") or qualified names ("UserStore.save").',
    parameters: {
      names: { type: 'array', required: true, items: { type: 'string' }, description: 'Symbol names to start from.' },
      hops: { type: 'integer', description: 'Graph hops (1-3, default 1).' },
      language: LANGUAGE_PARAM,
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: { type: 'array', items: NODE_SCHEMA },
      render: (_args, value) => [{ type: 'text', text: formatNodes(value) }],
    },
    async execute(args, exec) {
      const names = args.names.filter(n => n.trim().length > 0)
      if (names.length === 0) throw new Error('names must contain at least one non-empty name')
      validateLanguage(args.language)
      const hops = boundedInt('hops', args.hops, 1, 3)
      if (hops === 0) throw new Error('hops must be at least 1')
      const raw = await runCodeSearch(ctx, exec, resolved, () => buildRelatedArgv({
        names,
        hops,
        ...args.language !== undefined ? { language: args.language } : {},
      }))
      return expectArray(raw, 'graph result').map(n => toNode(parseWireNode(n)))
    },
    presentCall: args => ({ card: 'generic', title: `code_related ${args.names.join(', ')}`, kind: 'search' }),
  }))

  ctx.tools.register(defineTool({
    name: 'code_outline',
    description: 'List the functions, classes, methods and types defined in one source file, with their line ranges. '
      + 'Parses the file now, so the result matches the current file content.',
    parameters: {
      path: { type: 'string', required: true, description: 'Source file path; a relative path resolves against the workspace.' },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: { type: 'array', items: OUTLINE_SCHEMA },
      render: (args, value) => [{ type: 'text', text: formatOutline(args.path, value) }],
    },
    async execute(args, exec) {
      if (args.path.trim().length === 0) throw new Error('path must be a non-empty string')
      const raw = await runCodeSearch(ctx, exec, resolved, workdir => ['outline', `--path=${workspaceRelative(workdir, args.path)}`])
      return expectArray(raw, 'outline').map(parseOutlineEntry)
    },
    presentCall: args => ({ card: 'generic', title: `code_outline ${args.path}`, kind: 'read', locations: [{ path: args.path }] }),
  }))

  ctx.tools.register(defineTool({
    name: 'code_read_symbol',
    description: 'Read the exact source of one function, class or method in a file, with file line numbers. '
      + 'Accepts a qualified name from code_outline ("UserStore.save") or a plain name.',
    parameters: {
      path: { type: 'string', required: true, description: 'Source file path; a relative path resolves against the workspace.' },
      name: { type: 'string', required: true, description: 'Qualified or plain definition name.' },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: SYMBOL_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatSymbol(value) }],
    },
    async execute(args, exec) {
      if (args.path.trim().length === 0) throw new Error('path must be a non-empty string')
      if (args.name.trim().length === 0) throw new Error('name must be a non-empty string')
      const raw = await runCodeSearch(ctx, exec, resolved, workdir => ['symbol', `--path=${workspaceRelative(workdir, args.path)}`, `--name=${args.name}`])
      return parseSymbolSource(raw)
    },
    presentCall: args => ({ card: 'generic', title: `code_read_symbol ${args.path} ${args.name}`, kind: 'read', locations: [{ path: args.path }] }),
  }))
}
