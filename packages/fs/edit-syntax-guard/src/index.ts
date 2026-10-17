/**
 * Syntax guard for the model-facing `edit` and `write` tools.
 *
 * Inside the tool, at the `fs/edit-intent` / `fs/write-intent` slot (after
 * approval, path resolution and read-before-write policy), the guard reads
 * the target through `ctx.fs`, applies the edit in memory with the same
 * literal semantics as the filesystem provider (LF-normalized text, every
 * occurrence split and joined), and parses the file before and after with
 * tree-sitter. When the new text has more syntax problems than the old text,
 * the slot throws {@link EditSyntaxError}: nothing is written, and the model receives the first
 * new problem with numbered context lines so it can retry the edit.
 *
 * A file that already has syntax errors can still be edited as long as the
 * edit does not add more. Unsupported extensions, unreadable targets, files
 * over `maxFileBytes`, and edits the tool itself would reject (no match,
 * ambiguous match) pass through unchanged.
 *
 * Evidence: SWE-agent (arXiv:2405.15793) measured 18.0% resolve rate with a
 * lint-guarded edit command vs 15.0% without it on SWE-bench Lite.
 *
 * @module @deepseek-ai/dsh-edit-syntax-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { extname } from 'node:path'
import { GRAMMAR_NAMES, SyntaxChecker } from './syntax.ts'
import type { GrammarName, SyntaxProblem } from './syntax.ts'

export { GRAMMAR_NAMES, SyntaxChecker } from './syntax.ts'
export type { GrammarName, SyntaxProblem } from './syntax.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'edit-syntax-guard'

/** Services required by the guard. */
export const inject = ['fs']

/** Structured error code on a denial. */
export const EDIT_SYNTAX_REGRESSION = 'EDIT_SYNTAX_REGRESSION'

/** The failure the edit or write tool reports when the guard denies a call. */
export class EditSyntaxError extends HarnessError {
  /**
   * @param message - the model-facing denial from {@link formatDenial}.
   */
  constructor(message: string) {
    super(message, EDIT_SYNTAX_REGRESSION)
  }
}

/** Default extension-to-grammar map. */
export const DEFAULT_EXTENSIONS: Readonly<Record<string, GrammarName>> = {
  '.py': 'python',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
}

/** Plugin configuration for `edit-syntax-guard` (`cordis.yml` `config:`). */
export interface Config {
  /** Lower-case file extension (with dot) to grammar. Extensions not listed are not checked. */
  extensions?: Record<string, GrammarName>
  /** Files larger than this (UTF-16 code units of the new text) are not checked. */
  maxFileBytes?: number
  /** Context lines shown on each side of the first new problem. */
  contextLines?: number
  /** Problems counted per parse; a file already at this count is not checked. */
  maxProblems?: number
}

export const Config: z<Config> = z.object({
  extensions: z.dict(z.union(GRAMMAR_NAMES.map(n => z.const(n)))).default({ ...DEFAULT_EXTENSIONS }),
  maxFileBytes: z.number().default(2_000_000),
  contextLines: z.number().default(2),
  maxProblems: z.number().default(50),
})

/** Plugin config after schemastery defaulting. */
export type ResolvedConfig = Required<Config>

/** The in-memory result of an edit, or the reason the guard does not check it. */
export type SimulatedEdit = { kind: 'checked'; before: string; after: string } | { kind: 'skip' }

function normalize(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++
  return count
}

/**
 * Apply a literal edit the way the local filesystem provider does.
 *
 * @param before - the current file text.
 * @param edit - the `edit` tool arguments.
 * @returns the edited text, or `skip` when the tool itself would reject the edit.
 */
export function simulateEdit(before: string, edit: { oldString: string; newString: string; replaceAll: boolean }): SimulatedEdit {
  const content = normalize(before)
  const oldNorm = normalize(edit.oldString)
  if (oldNorm.length === 0) return { kind: 'skip' }
  const matches = countOccurrences(content, oldNorm)
  if (matches === 0 || (!edit.replaceAll && matches > 1)) return { kind: 'skip' }
  return { kind: 'checked', before: content, after: content.split(oldNorm).join(normalize(edit.newString)) }
}

/**
 * 1-based line of the first difference between two texts, or undefined when
 * they are equal or `before` is empty (a new file).
 *
 * @param before - the current text.
 * @param after - the edited text.
 * @returns the first changed line of `after`.
 */
export function firstChangedLine(before: string, after: string): number | undefined {
  if (before.length === 0 || before === after) return undefined
  const a = before.split('\n')
  const b = after.split('\n')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return Math.min(i, b.length - 1) + 1
}

/**
 * Format the denial the model sees: where the edit breaks the file, with
 * numbered lines around that place.
 *
 * Tree-sitter error recovery can place an `ERROR` node far from the cause
 * (often at the start of the enclosing block), so an edit is anchored at its
 * first changed line; a new file falls back to the first added problem.
 *
 * @param displayPath - the target path as the tools display it.
 * @param after - the rejected file text.
 * @param added - problems in `after` that `before` did not have.
 * @param contextLines - lines of context on each side.
 * @param changedLine - first changed line of the edit, from {@link firstChangedLine}.
 * @returns the denial text.
 */
export function formatDenial(
  displayPath: string,
  after: string,
  added: readonly SyntaxProblem[],
  contextLines: number,
  changedLine?: number,
): string {
  const first = added[0]
  if (first === undefined) return `Edit rejected: it would introduce a syntax error in ${displayPath}. The file was not changed.`
  const lines = after.split('\n')
  const anchor = changedLine ?? first.line
  const from = Math.max(1, anchor - contextLines)
  const to = Math.min(lines.length, anchor + contextLines)
  const width = String(to).length
  const excerpt = lines.slice(from - 1, to).map((text, i) => {
    const n = from + i
    return `${n === anchor ? '>' : ' '} ${String(n).padStart(width)} | ${text}`
  })
  const what = first.kind === 'missing' ? `missing ${first.expected ?? 'token'}` : 'syntax error'
  const more = added.length > 1 ? ` (${added.length} new syntax problems in total)` : ''
  return [
    changedLine === undefined
      ? `Edit rejected: it would introduce a ${what} at ${displayPath}:${first.line}:${first.column}${more}. The file was not changed.`
      : `Edit rejected: the change at ${displayPath}:${changedLine} would introduce a ${what}${more}. The file was not changed.`,
    ...excerpt,
    'Fix the replacement text and retry the edit.',
  ].join('\n')
}

/**
 * Problems in `after` beyond those already present in `before`. Problems
 * are compared by count and kind, because an edit shifts line numbers.
 *
 * @param before - problems of the current text.
 * @param after - problems of the edited text.
 * @returns the problems of `after` that exceed `before`, or [] when the edit adds none.
 */
export function addedProblems(before: readonly SyntaxProblem[], after: readonly SyntaxProblem[]): SyntaxProblem[] {
  if (after.length <= before.length) return []
  const seen = new Map<string, number>()
  for (const p of before) seen.set(p.kind, (seen.get(p.kind) ?? 0) + 1)
  const out: SyntaxProblem[] = []
  for (const p of after) {
    const left = seen.get(p.kind) ?? 0
    if (left > 0) seen.set(p.kind, left - 1)
    else out.push(p)
  }
  return out
}

interface IntentArgs {
  old_string?: unknown
  new_string?: unknown
  old_str?: unknown
  new_str?: unknown
  replace_all?: unknown
  content?: unknown
  file_text?: unknown
}

/**
 * Register the guard on the `fs/edit-intent` and `fs/write-intent` slots.
 *
 * Both slots run inside the tool, after approval and after path resolution.
 * The listener first delegates with `next()`, so a read-before-write policy
 * mounted after this plugin still decides first and its error wins; then it
 * checks the edit and throws to deny it.
 *
 * @param ctx - plugin context; the listeners are effects scoped to this plugin.
 * @param config - resolved plugin configuration from schemastery.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (!Number.isInteger(resolved.maxFileBytes) || resolved.maxFileBytes < 1) throw new Error('edit-syntax-guard: maxFileBytes must be a positive integer')
  if (!Number.isInteger(resolved.contextLines) || resolved.contextLines < 0) throw new Error('edit-syntax-guard: contextLines must be a non-negative integer')
  if (!Number.isInteger(resolved.maxProblems) || resolved.maxProblems < 1) throw new Error('edit-syntax-guard: maxProblems must be a positive integer')
  const checker = new SyntaxChecker()

  async function denial(target: FsTarget, actor: object | undefined, slot: 'edit' | 'write'): Promise<string | undefined> {
    const exec: Partial<ToolExecution> | undefined = actor
    if (exec?.arguments === undefined || typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
    const grammar = resolved.extensions[extname(target.displayPath).toLowerCase()]
    if (grammar === undefined) return undefined
    const args: IntentArgs = exec.arguments
    const info = await ctx.fs.stat(target, exec.signal)
    if (info?.type === 'file' && info.size !== undefined && info.size > resolved.maxFileBytes) return undefined
    const existing = info?.type === 'file' ? await ctx.fs.readText(target, exec.signal) : undefined

    let simulated: SimulatedEdit
    if (slot === 'edit') {
      const oldString = args.old_string ?? args.old_str
      const newString = args.new_string ?? args.new_str
      if (existing === undefined || typeof oldString !== 'string' || typeof newString !== 'string') return undefined
      simulated = simulateEdit(existing, { oldString, newString, replaceAll: args.replace_all === true })
    } else {
      const content = args.content ?? args.file_text
      if (typeof content !== 'string') return undefined
      simulated = { kind: 'checked', before: normalize(existing ?? ''), after: normalize(content) }
    }
    if (simulated.kind === 'skip' || simulated.after.length > resolved.maxFileBytes) return undefined

    const before = await checker.problems(grammar, simulated.before, resolved.maxProblems)
    // At the cap the counts cannot show whether the edit added a problem.
    if (before.length >= resolved.maxProblems) return undefined
    const added = addedProblems(before, await checker.problems(grammar, simulated.after, resolved.maxProblems))
    if (added.length === 0) return undefined
    const changed = firstChangedLine(simulated.before, simulated.after)
    return formatDenial(target.displayPath, simulated.after, added, resolved.contextLines, changed)
  }

  async function guard(target: FsTarget, actor: object | undefined, slot: 'edit' | 'write'): Promise<void> {
    let reason: string | undefined
    try {
      reason = await denial(target, actor, slot)
    } catch (error: unknown) {
      // A guard failure (unreadable target, grammar load) must not block an
      // edit the tool would otherwise run; the tool reports its own errors.
      ctx.logger.warn('edit-syntax-guard: check skipped:', error)
      return
    }
    if (reason !== undefined) throw new EditSyntaxError(reason)
  }

  ctx.on('fs/edit-intent', async (target, actor, next) => {
    const intent = await next()
    await guard(target, actor, 'edit')
    return intent
  })
  ctx.on('fs/write-intent', async (target, actor, next) => {
    const intent = await next()
    await guard(target, actor, 'write')
    return intent
  })
}
