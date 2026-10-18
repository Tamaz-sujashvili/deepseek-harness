/**
 * Redirect shell repository searches to the dedicated search tools.
 *
 * On `tools/pre-execute`, a shell call whose command is only a repository
 * search — `rg`, `ag`, `ack`, `fd`, `git grep`, a recursive `grep`, or
 * `find` with a name or path test, optionally piped through filters such as
 * `head` or `sort` — is denied. The denial names the visible replacement
 * tools: `code_search` for behaviour, `grep` for exact text, `glob` for
 * paths. Commands that do other work (running tests, building, a `grep`
 * over program output) are never denied. When no replacement tool is
 * visible to the caller, nothing is denied.
 *
 * Why: models often ignore prompt guidance and keep searching through the
 * shell, so tools such as `code_search` are rarely called. SWE-agent
 * (arXiv:2405.15793) measured 18.0% vs 12.0% with dedicated, summarized
 * search commands instead of iterative shell search.
 *
 * @module @deepseek-ai/dsh-search-routing
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'search-routing'

/** Services required by the guard. */
export const inject = ['tools']

/** Structured error code on a denial. */
export const SHELL_SEARCH_ROUTED = 'SHELL_SEARCH_ROUTED'

/** Plugin configuration for `search-routing` (`cordis.yml` `config:`). */
export interface Config {
  /** Names of shell tools whose `command` argument is checked. */
  shellTools?: string[]
  /** Maximum characters of the denied command quoted back to the model. */
  maxQuotedChars?: number
}

export const Config: z<Config> = z.object({
  shellTools: z.array(z.string()).default(['bash']),
  maxQuotedChars: z.number().step(1).min(1).default(200),
})

/** Plugin config after schemastery defaulting. */
export type ResolvedConfig = Required<Config>

/** Programs that always search a directory tree. */
const TREE_SEARCHERS = new Set(['rg', 'ag', 'ack', 'fd', 'fdfind'])
/** grep variants; they search a tree only with a recursive flag. */
const GREPS = new Set(['grep', 'egrep', 'fgrep'])
/** `find` tests that make it a name or path search. */
const FIND_TESTS = new Set(['-name', '-iname', '-path', '-ipath', '-regex', '-iregex', '-wholename'])
/** `find` actions that change files or write output; with any of them `find` does real work. */
const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'])
/** Programs allowed after a search in a pipeline. */
const FILTERS = new Set(['head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'awk', 'less', 'more', 'cat', 'tr', 'nl', 'column'])
/** Statements that do no work of their own and do not change the verdict. */
const NEUTRAL = new Set(['cd', 'echo', 'pwd', 'true', ':'])

/**
 * Split a command into shell words. Quotes group words; backslash escapes
 * the next character. Operators `|`, `||`, `&&`, `;` and newlines are
 * returned as their own tokens. This is a classifier, not a full shell
 * parser: anything it cannot classify is treated as "not a search".
 *
 * @param command - the shell command text.
 * @returns words and operator tokens in order.
 */
export function tokenize(command: string): string[] {
  const out: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | undefined
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? ''
    if (quote !== undefined) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i] ?? ''
      else word += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i] ?? ''
      inWord = true
    } else if (c === ' ' || c === '\t') {
      if (inWord) out.push(word)
      word = ''
      inWord = false
    } else if (c === '|' || c === '&' || c === ';' || c === '\n') {
      if (inWord) out.push(word)
      word = ''
      inWord = false
      const next = command[i + 1]
      if ((c === '|' || c === '&') && next === c) {
        out.push(c + c)
        i++
      } else {
        out.push(c === '\n' ? ';' : c)
      }
    } else {
      word += c
      inWord = true
    }
  }
  if (inWord) out.push(word)
  return out
}

function program(words: readonly string[]): { name: string; args: string[] } | undefined {
  let i = 0
  // Skip `VAR=value` prefixes and `command` / `env` wrappers.
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '') || words[i] === 'command' || words[i] === 'env')) i++
  const name = words[i]
  if (name === undefined) return undefined
  return { name: name.split('/').at(-1) ?? name, args: words.slice(i + 1) }
}

function isRecursiveGrep(args: readonly string[]): boolean {
  return args.some(a => a === '--recursive' || a === '--dereference-recursive' || (/^-[A-Za-z]+$/.test(a) && /[rR]/.test(a)))
}

function isTreeSearch(words: readonly string[]): boolean {
  const p = program(words)
  if (p === undefined) return false
  if (TREE_SEARCHERS.has(p.name)) return true
  if (GREPS.has(p.name)) return isRecursiveGrep(p.args)
  if (p.name === 'git') return p.args[0] === 'grep'
  if (p.name === 'find') return p.args.some(a => FIND_TESTS.has(a)) && !p.args.some(a => FIND_ACTIONS.has(a))
  if (p.name === 'xargs') return isTreeSearch(p.args) || (GREPS.has(program(p.args)?.name ?? ''))
  return false
}

function isFilter(words: readonly string[]): boolean {
  const p = program(words)
  if (p === undefined) return false
  if (FILTERS.has(p.name)) return true
  if (GREPS.has(p.name)) return !isRecursiveGrep(p.args)
  if (p.name === 'sed') return p.args.includes('-n')
  if (p.name === 'xargs') return isTreeSearch(words) || GREPS.has(program(p.args)?.name ?? '')
  return false
}

/**
 * Decide whether a shell command is only a repository search.
 *
 * Every `&&` / `||` / `;` statement must be either neutral (`cd`, `echo`)
 * or a pipeline whose first stage is a tree search and whose later stages
 * are filters; at least one statement must be a search. Backgrounding (`&`),
 * subshells and redirections make the command "not a search".
 *
 * @param command - the shell command text.
 * @returns true when the whole command only searches the repository.
 */
export function isOnlySearch(command: string): boolean {
  if (/[`$<>(){}]/.test(command.replace(/'[^']*'/g, "''"))) return false
  const tokens = tokenize(command)
  const statements: string[][][] = [[[]]]
  for (const t of tokens) {
    const stmt = statements.at(-1) as string[][]
    if (t === '&&' || t === '||' || t === ';') statements.push([[]])
    else if (t === '|') stmt.push([])
    else if (t === '&') return false
    else (stmt.at(-1) as string[]).push(t)
  }
  let searched = false
  for (const stages of statements) {
    const nonEmpty = stages.filter(s => s.length > 0)
    if (nonEmpty.length === 0) continue
    const first = nonEmpty[0] as string[]
    const head = program(first)?.name
    if (nonEmpty.length === 1 && head !== undefined && NEUTRAL.has(head)) continue
    if (!isTreeSearch(first) || !nonEmpty.slice(1).every(isFilter)) return false
    searched = true
  }
  return searched
}

/**
 * Model-facing denial text naming the visible replacement tools.
 *
 * @param command - the denied command.
 * @param visible - which replacement tools the caller can use.
 * @param maxQuotedChars - maximum quoted command characters.
 * @returns the denial reason.
 */
export function routingReason(
  command: string,
  visible: { codeSearch: boolean; grep: boolean; glob: boolean },
  maxQuotedChars: number,
): string {
  const quoted = command.length > maxQuotedChars ? `${command.slice(0, maxQuotedChars)}…` : command
  const options = [
    visible.codeSearch ? 'code_search with a description of the behaviour, to find where it is implemented' : undefined,
    visible.grep ? 'the grep tool for exact text or a regular expression' : undefined,
    visible.glob ? 'the glob tool for file paths' : undefined,
  ].filter((o): o is string => o !== undefined)
  return `Shell search was not run: \`${quoted}\`. Search with ${options.join('; ')}. Use the shell for other work, such as running tests.`
}

/**
 * Register the routing guard on `tools/pre-execute`.
 *
 * @param ctx - plugin context; the listener is an effect scoped to this plugin.
 * @param config - resolved plugin configuration from schemastery.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const shellTools = new Set(resolved.shellTools)
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    const decision = await next()
    if (decision.kind !== 'allow' && decision.kind !== 'ask') return decision
    if (!shellTools.has(exec.name)) return decision
    const args = exec.arguments as { command?: unknown }
    if (typeof args.command !== 'string' || !isOnlySearch(args.command)) return decision
    const visible = {
      codeSearch: ctx.tools.get('code_search', exec.agent) !== undefined,
      grep: ctx.tools.get('grep', exec.agent) !== undefined,
      glob: ctx.tools.get('glob', exec.agent) !== undefined,
    }
    if (!visible.codeSearch && !visible.grep && !visible.glob) return decision
    return {
      kind: 'deny',
      reason: routingReason(args.command.trim(), visible, resolved.maxQuotedChars),
      info: { name: 'SearchRoutingDenial', code: SHELL_SEARCH_ROUTED },
    }
  })
}
