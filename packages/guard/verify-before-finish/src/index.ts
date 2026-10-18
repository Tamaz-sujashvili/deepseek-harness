/**
 * Turn-stop verification gate. It tracks file edits and verification commands
 * in each agent's tool calls since the last user message, and when the turn is
 * about to close with edits that no later successful check covers, it steers
 * the agent into one more step that names the evidence gap. Configuration and
 * message text live in the package README.
 * @module @deepseek-ai/dsh-verify-before-finish
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'verify-before-finish': { kind: 'verify-before-finish' } & ContextFormed
  }
}

export const name = 'verify-before-finish'

/**
 * Plugin config. Pattern lists are JavaScript regular-expression sources,
 * compiled case-insensitively at load; an invalid source or an out-of-range
 * number fails the plugin load.
 */
export interface Config {
  /** Tools whose successful calls count as file edits (default `edit`, `write`, `str_replace_editor`). */
  editTools?: string[]
  /** Values of an edit tool's `command` argument that do not change files (default `view`). */
  readOnlyCommands?: string[]
  /** Tools whose `command` argument is a shell command line (default `bash`). */
  shellTools?: string[]
  /** Shell command patterns that count as a verification run (test runners and script runs by default). */
  verifyPatterns?: string[]
  /** Shell command patterns that count as a file edit (in-place editors, redirects into source files, patches). */
  shellEditPatterns?: string[]
  /** Maximum steered continuations for one user message (default 1). */
  maxHoldsPerPrompt?: number
  /** Maximum edited paths named in the steering message (default 8). */
  maxListedPaths?: number
}

const DEFAULT_VERIFY_PATTERNS = [
  String.raw`\bpytest\b`,
  String.raw`\bpython[0-9.]*\s+-m\s+(pytest|unittest|doctest)\b`,
  String.raw`\b(tox|nox)\b`,
  String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b`,
  String.raw`\b(vitest|jest|mocha|ava)\b`,
  String.raw`\bgo\s+test\b`,
  String.raw`\bcargo\s+(test|nextest)\b`,
  String.raw`\bmake\s+(test|check)\b`,
  String.raw`\bctest\b`,
  String.raw`\b(mvn|mvnw|gradle|gradlew)\b[^\n;|&]*\btest\b`,
  String.raw`\b(rspec|phpunit|dotnet\s+test)\b`,
  String.raw`\bruntests\.py\b`,
  String.raw`\b(python[0-9.]*|node|ruby|Rscript|bash|sh)\s+(?!-)[^\s;&|]+\.(py|js|mjs|cjs|ts|rb|R|sh)\b`,
]

const DEFAULT_SHELL_EDIT_PATTERNS = [
  String.raw`\bsed\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*i`,
  String.raw`\bperl\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*i`,
  String.raw`\b(git\s+apply|patch)\b`,
  String.raw`(^|[^<>&0-9])>{1,2}\s*[^\s;&|>]+\.(py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|rb|c|cc|cpp|h|hpp|cs|php|R)\b`,
]

export const Config: z<Config> = z.object({
  editTools: z.array(z.string()).default(['edit', 'write', 'str_replace_editor']),
  readOnlyCommands: z.array(z.string()).default(['view']),
  shellTools: z.array(z.string()).default(['bash']),
  verifyPatterns: z.array(z.string()).default(DEFAULT_VERIFY_PATTERNS),
  shellEditPatterns: z.array(z.string()).default(DEFAULT_SHELL_EDIT_PATTERNS),
  maxHoldsPerPrompt: z.number().default(1),
  maxListedPaths: z.number().default(8),
})

/** The foreground facts of one shell result: its exit code (`null` when it ended without exiting) and whether it reached its timeout. */
interface ShellOutcome {
  exitCode: number | null
  timedOut: boolean
}

/** The newest verification run after an edit. */
interface Check extends ShellOutcome {
  command: string
}

/** One agent's evidence state since its last user message. */
interface Evidence {
  /** Edited paths in first-edit order; a shell edit with no known path adds `undefined` once. */
  edited: Set<string | undefined>
  /** Whether any edit happened after the newest verification run. */
  editedSinceCheck: boolean
  /** The newest verification run, when one ran after an edit. */
  check: Check | undefined
  /** Steered continuations already spent for this user message. */
  holds: number
}

function compile(sources: string[], field: string): RegExp[] {
  return sources.map((source) => {
    try {
      return new RegExp(source, 'i')
    } catch (error) {
      throw new Error(`verify-before-finish: invalid ${field} pattern ${JSON.stringify(source)}: ${String(error)}`, { cause: error })
    }
  })
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`verify-before-finish: invalid ${field} ${value} — must be an integer >= 1`)
  }
  return value
}

/** The string value of one named argument, when the parsed arguments are an object that holds one. */
function stringArgument(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const value: unknown = Reflect.get(args, key)
  return typeof value === 'string' ? value : undefined
}

/**
 * Read a foreground shell result. Returns `undefined` for a failed call, a
 * background or promoted job, or a value without an exit code, because none
 * of them is a finished command.
 */
function foregroundOutcome(result: ToolExecutionResult): ShellOutcome | undefined {
  if (result.isError) return undefined
  const value = result.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.kind !== undefined && value.kind !== 'foreground') return undefined
  const code = value.exitCode
  if (code !== null && typeof code !== 'number') return undefined
  return { exitCode: code, timedOut: value.timedOut === true }
}

/** The start offset of the last match of any pattern in `command`, or -1 when none matches. */
function lastMatchAt(patterns: RegExp[], command: string): number {
  let at = -1
  for (const pattern of patterns) {
    for (const match of command.matchAll(new RegExp(pattern.source, 'gi'))) at = Math.max(at, match.index)
  }
  return at
}

function passed(check: Check | undefined): boolean {
  return check !== undefined && check.exitCode === 0 && !check.timedOut
}

function quote(command: string): string {
  const line = (command.split('\n', 1)[0] ?? '').trim()
  const short = line.length > 160 ? `${line.slice(0, 160)}…` : line
  return command.includes('\n') ? `${short} …` : short
}

/** The steering text for an agent whose newest edits have no passing check after them. */
function gapMessage(evidence: Evidence, maxListedPaths: number): string {
  const paths = [...evidence.edited].filter((path): path is string => path !== undefined)
  const listed = paths.slice(0, maxListedPaths).map(path => `- ${path}`)
  if (paths.length > maxListedPaths) listed.push(`- … and ${paths.length - maxListedPaths} more`)
  if (evidence.edited.has(undefined)) listed.push('- files changed by shell commands')
  const changed = `Files changed since the user's last message:\n${listed.join('\n')}`
  const check = evidence.check
  if (!evidence.editedSinceCheck && check !== undefined) {
    const status = check.timedOut
      ? 'reached its timeout before it finished'
      : check.exitCode === null ? 'ended without an exit code' : `exited with code ${check.exitCode}`
    return `The last check after your edits did not pass: \`${quote(check.command)}\` ${status}.\n${changed}\n`
      + 'Before you finish, fix the cause and run the check again, or state in your answer why this result is expected.'
  }
  return `No test or reproduction command has run successfully after your latest edits.\n${changed}\n`
    + 'Before you finish, run one command that exercises the changed behavior (the relevant tests or a reproduction of the issue) and read its result. '
    + 'If no such check is possible here, state that in your answer.'
}

/**
 * Install the gate's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; patterns and limits are re-checked here and fail the load when invalid.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees every field after validation.
  const editTools = new Set(config.editTools as string[])
  const readOnlyCommands = new Set(config.readOnlyCommands as string[])
  const shellTools = new Set(config.shellTools as string[])
  const verifyPatterns = compile(config.verifyPatterns as string[], 'verifyPatterns')
  const shellEditPatterns = compile(config.shellEditPatterns as string[], 'shellEditPatterns')
  const maxHolds = positiveInteger(config.maxHoldsPerPrompt as number, 'maxHoldsPerPrompt')
  const maxListedPaths = positiveInteger(config.maxListedPaths as number, 'maxListedPaths')

  const states = new WeakMap<Agent, Evidence>()

  function evidenceOf(agent: Agent): Evidence {
    let evidence = states.get(agent)
    if (evidence === undefined) {
      evidence = { edited: new Set(), editedSinceCheck: false, check: undefined, holds: 0 }
      states.set(agent, evidence)
    }
    return evidence
  }

  function recordEdit(agent: Agent, path: string | undefined): void {
    const evidence = evidenceOf(agent)
    evidence.edited.add(path)
    evidence.editedSinceCheck = true
  }

  function observe(exec: ToolExecution, result: ToolExecutionResult): void {
    const agent = exec.agent
    if (agent === undefined) return
    if (editTools.has(exec.name)) {
      if (result.isError) return
      const command = stringArgument(exec.arguments, 'command')
      if (command !== undefined && readOnlyCommands.has(command)) return
      recordEdit(agent, stringArgument(exec.arguments, 'file_path') ?? stringArgument(exec.arguments, 'path'))
      return
    }
    if (!shellTools.has(exec.name)) return
    const command = stringArgument(exec.arguments, 'command')
    if (command === undefined) return
    const outcome = foregroundOutcome(result)
    if (outcome === undefined) return
    // One command can both edit and check; apply them in command-line order,
    // so `pytest && sed -i …` leaves the edit unchecked.
    const editAt = lastMatchAt(shellEditPatterns, command)
    const checkAt = lastMatchAt(verifyPatterns, command)
    if (editAt >= 0 && editAt < checkAt) recordEdit(agent, undefined)
    if (checkAt >= 0) recordCheck(agent, { command, ...outcome })
    if (editAt > checkAt) recordEdit(agent, undefined)
  }

  function recordCheck(agent: Agent, check: Check): void {
    const evidence = states.get(agent)
    // A check with no edit before it in this prompt verifies nothing new.
    if (evidence === undefined || evidence.edited.size === 0) return
    evidence.check = check
    evidence.editedSinceCheck = false
  }

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    observe(exec, result)
    return next()
  })

  // A user message starts a new request; earlier edits belong to the old one.
  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) states.delete(agent)
    return next()
  })

  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    if (signal.aborted) return
    const evidence = states.get(agent)
    if (evidence === undefined || evidence.edited.size === 0) return
    if ((!evidence.editedSinceCheck && passed(evidence.check)) || evidence.holds >= maxHolds) return
    evidence.holds += 1
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: gapMessage(evidence, maxListedPaths) }],
      source: { kind: 'verify-before-finish', form: 'notice', summary: 'verification gap' },
    }))
  })
}
