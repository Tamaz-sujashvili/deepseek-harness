/**
 * Near-miss hint for the model-facing `edit` tool.
 *
 * At the `fs/edit-intent` slot (after approval, path resolution and the
 * read-before-write policy), the plugin reads the target and checks the
 * literal `old_string`. When the literal text is absent but exactly one
 * passage of the file matches it after normalization (trailing whitespace per
 * line, NFKC, Unicode quotes, dashes and spaces), the slot throws
 * {@link EditNearMissError}: the file is not written, and the model receives
 * the line range and the exact file text of that passage as a JSON string to
 * use as `old_string` in a retry.
 *
 * The plugin never applies a normalized match itself. Edits with a literal
 * match, with no normalized match, or with several normalized matches pass
 * through unchanged, so the tool reports its own result or error.
 *
 * Evidence: arXiv:2609.11957 measured search/replace apply success under
 * whitespace drift at 0.176 for exact matching and 0.571 for whitespace-
 * normalized matching, with zero silent misapplications when ambiguous
 * matches are refused. The normalization set follows the pi coding agent
 * (`normalizeForFuzzyMatch` in packages/coding-agent/src/core/tools/edit-diff.ts).
 *
 * @module @deepseek-ai/dsh-edit-near-miss
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'edit-near-miss'

/** Services required by the plugin. */
export const inject = ['fs']

/** Structured error code of a near-miss denial. */
export const EDIT_NEAR_MISS = 'EDIT_NEAR_MISS'

/** The failure the edit tool reports when a near miss is found. */
export class EditNearMissError extends HarnessError {
  /**
   * @param message - the model-facing hint from {@link formatHint}.
   */
  constructor(message: string) {
    super(message, EDIT_NEAR_MISS)
  }
}

/** Plugin configuration for `edit-near-miss` (`cordis.yml` `config:`). */
export interface Config {
  /** Files longer than this many UTF-16 code units are not checked. */
  maxFileChars?: number
  /** Longest exact passage (UTF-16 code units) quoted in a hint; a longer one gets only its line range. */
  maxQuotedChars?: number
}

export const Config: z<Config> = z.object({
  maxFileChars: z.number().default(2_000_000),
  maxQuotedChars: z.number().default(8000),
})

/** Plugin config after schemastery defaulting. */
export type ResolvedConfig = Required<Config>

/**
 * Normalize one line for near-miss matching: NFKC, Unicode single and double
 * quotes to ASCII, Unicode dashes and the minus sign to `-`, Unicode spaces to
 * a space, then strip trailing whitespace.
 *
 * @param line - one line without its line ending.
 * @returns the normalized line.
 */
export function normalizeLine(line: string): string {
  return line
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, '\'')
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
    .trimEnd()
}

/**
 * Normalize multi-line text line by line; line count and order are kept.
 *
 * @param text - LF-normalized text.
 * @returns the normalized text.
 */
export function normalizeText(text: string): string {
  return text.split('\n').map(normalizeLine).join('\n')
}

/** Result of {@link findNearMiss}; `escapes` is true when the match needed decoded `\uXXXX` escape text. */
export type NearMiss =
  | { kind: 'none' }
  /** One normalized match whose exact file text is known and unique. */
  | { kind: 'exact'; startLine: number; endLine: number; text: string; escapes: boolean }
  /** One normalized match whose exact file text cannot be cut out with confidence. */
  | { kind: 'lines'; startLine: number; endLine: number; escapes: boolean }

/**
 * Decode `\uXXXX` escape text, which a model sometimes writes as literal
 * characters when it means the escaped character.
 *
 * @param text - text that may contain literal escape sequences.
 * @returns the text with each `\uXXXX` sequence replaced by its character.
 */
export function decodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/** Invisible or space-like characters that a hint shows as `\uXXXX` escapes. */
const INVISIBLE = /[\u00A0\u00AD\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u2064\u3000\uFEFF]/g

/**
 * Quote text as a JSON string whose invisible and space-like characters are
 * written as `\uXXXX` escapes, so that the model can see them.
 *
 * @param text - the exact file text.
 * @returns a JSON string literal.
 */
export function quoteVisible(text: string): string {
  return JSON.stringify(text).replace(INVISIBLE, c => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
}

function lfNormalize(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++
  return count
}

/** Offset of the first character of 0-based line `line`. */
function lineStart(text: string, line: number): number {
  let at = 0
  for (let n = 0; n < line; n++) at = text.indexOf('\n', at) + 1
  return at
}

/** 0-based index of the line that contains offset `at`. */
function lineIndex(text: string, at: number): number {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** Text of 0-based line `line`, without its line ending. */
function lineText(text: string, line: number): string {
  const start = lineStart(text, line)
  const end = text.indexOf('\n', start)
  return text.slice(start, end === -1 ? text.length : end)
}

/**
 * Find the passage that a failed literal `old_string` most likely meant.
 *
 * The match runs in normalized space, where each line keeps its index. A
 * column maps back to the original line only when NFKC maps each code unit of
 * that line to one code unit, because every other substitution replaces one
 * UTF-16 code unit with one. The exact text is reported only when it occurs once in the file
 * and normalizes to the normalized `old_string`. Line endings are LF, as the
 * edit tool matches LF-normalized text. When `old_string` has no match but
 * contains `\uXXXX` escape text, the search runs again with the escapes decoded.
 *
 * @param content - the current file text.
 * @param oldString - the literal text the model asked to replace.
 * @returns `none` when the literal text is present, is blank, or has zero or several normalized matches.
 */
export function findNearMiss(content: string, oldString: string): NearMiss {
  const file = lfNormalize(content)
  const old = lfNormalize(oldString)
  if (old.trim().length === 0 || file.includes(old)) return { kind: 'none' }
  const plain = matchNormalized(file, old, false)
  const decoded = decodeEscapes(old)
  return plain.kind === 'none' && decoded !== old ? matchNormalized(file, decoded, true) : plain
}

/** One unique normalized match of `old` in `file`, both LF-normalized. */
function matchNormalized(file: string, old: string, escapes: boolean): NearMiss {
  const normOld = normalizeText(old)
  const normFile = normalizeText(file)
  const at = normFile.indexOf(normOld)
  if (at === -1 || normFile.indexOf(normOld, at + 1) !== -1) return { kind: 'none' }

  const end = at + normOld.length
  // Trailing whitespace of a partial last line is significant: `foo ` must not match the `foo` of `foobar`.
  const lastOldLine = old.slice(old.lastIndexOf('\n') + 1)
  if (lastOldLine !== lastOldLine.trimEnd() && end < normFile.length && normFile[end] !== '\n') return { kind: 'none' }
  const startLine = lineIndex(normFile, at)
  // `cutLine` holds offset `end`; a match ending with a line ending is shown as ending on the line before it.
  const cutLine = lineIndex(normFile, end)
  const endColumn = end - lineStart(normFile, cutLine)
  const range = { startLine: startLine + 1, endLine: endColumn === 0 && cutLine > startLine ? cutLine : cutLine + 1, escapes }

  // Columns map one to one only on lines where NFKC maps each code unit to one code unit.
  const stable = (line: number): boolean => {
    const units = Array.from(lineText(file, line))
    const mapped = units.map(unit => unit.normalize('NFKC'))
    return mapped.every(unit => unit.length === 1) && mapped.join('') === units.join('').normalize('NFKC')
  }
  if (!stable(startLine) || (endColumn > 0 && !stable(cutLine))) return { kind: 'lines', ...range }
  const text = file.slice(
    lineStart(file, startLine) + at - lineStart(normFile, startLine),
    lineStart(file, cutLine) + endColumn,
  )
  /* v8 ignore next 2 -- invariant: with NFKC-stable boundary lines the cut text normalizes to the unique match */
  if (normalizeText(text) !== normOld || countOccurrences(file, text) !== 1) return { kind: 'lines', ...range }
  return { kind: 'exact', ...range, text }
}

/**
 * Format the hint the model sees for one near miss.
 *
 * @param displayPath - the target path as the tools display it.
 * @param miss - a near miss other than `none`.
 * @param maxQuotedChars - longest exact text quoted in the hint.
 * @returns the hint text.
 */
export function formatHint(displayPath: string, miss: Exclude<NearMiss, { kind: 'none' }>, maxQuotedChars: number): string {
  const where = miss.startLine === miss.endLine ? `line ${miss.startLine}` : `lines ${miss.startLine}-${miss.endLine}`
  const head = miss.escapes
    ? `old_string was not found in ${displayPath} as written: it contains escape text such as \\u00A0 as literal characters. With those escapes decoded, it matches one passage (${where}). The file was not changed. In the tool arguments, write a special character as one JSON escape such as \\u00A0, not as the text \\\\u00A0.`
    : `old_string was not found in ${displayPath} as written, but it matches one passage (${where}) when trailing whitespace and Unicode quotes, dashes and spaces are ignored. The file was not changed.`
  if (miss.kind === 'exact' && miss.text.length <= maxQuotedChars) {
    return `${head}\nRetry the edit with old_string set to the exact file text of that passage, given here as a JSON string in which invisible characters are \\uXXXX escapes:\n${quoteVisible(miss.text)}`
  }
  return `${head}\nRead ${where} and copy old_string from the file exactly, then retry the edit.`
}

interface IntentArgs {
  old_string?: unknown
  old_str?: unknown
}

/**
 * Register the near-miss check on the `fs/edit-intent` slot.
 *
 * The listener is prepended to the slot and first delegates with `next()`, so
 * a read-before-write policy decides first and its error wins; then it checks
 * the edit and throws to deny it.
 *
 * @param ctx - plugin context; the listener is an effect scoped to this plugin.
 * @param config - resolved plugin configuration from schemastery.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (!Number.isInteger(resolved.maxFileChars) || resolved.maxFileChars < 1) throw new Error('edit-near-miss: maxFileChars must be a positive integer')
  if (!Number.isInteger(resolved.maxQuotedChars) || resolved.maxQuotedChars < 0) throw new Error('edit-near-miss: maxQuotedChars must be a non-negative integer')

  async function hint(target: FsTarget, actor: object | undefined): Promise<string | undefined> {
    const exec: Partial<ToolExecution> | undefined = actor
    if (exec?.arguments === undefined || typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
    const args: IntentArgs = exec.arguments
    const oldString = args.old_string ?? args.old_str
    if (typeof oldString !== 'string') return undefined
    const info = await ctx.fs.stat(target, exec.signal)
    if (info?.type !== 'file') return undefined
    const content = await ctx.fs.readText(target, exec.signal)
    if (content.length > resolved.maxFileChars) return undefined
    const miss = findNearMiss(content, oldString)
    return miss.kind === 'none' ? undefined : formatHint(target.displayPath, miss, resolved.maxQuotedChars)
  }

  // Prepended: the read-before-write policy occupies the slot without calling
  // next(), and plugin load order does not follow cordis.yml row order.
  ctx.on('fs/edit-intent', async (target, actor, next) => {
    const intent = await next()
    let reason: string | undefined
    try {
      reason = await hint(target, actor)
    } catch (error: unknown) {
      // The hint is optional: an unreadable target must not block an edit the
      // tool would otherwise run; the tool reports its own errors.
      ctx.logger.warn('edit-near-miss: check skipped:', error)
    }
    if (reason !== undefined) throw new EditNearMissError(reason)
    return intent
  }, { prepend: true })
}
