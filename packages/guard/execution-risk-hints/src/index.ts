/**
 * Advisory shell-execution hints. After each foreground shell call it updates
 * one agent's execution record and, when a risk pattern appears for the first
 * time since the last user message, attaches a short note to the call's
 * result as logged model context. It never blocks or rewrites a call. The
 * detectors and note text live in the package README.
 * @module @deepseek-ai/dsh-execution-risk-hints
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'execution-risk-hints': { kind: 'execution-risk-hints' } & ContextFormed
  }
}

export const name = 'execution-risk-hints'

/** Detector keys, in the order the README documents them. */
export type RiskKey = 'repeated-error' | 'time-budget' | 'non-fail-fast-check' | 'shallow-check'

const RISK_KEYS: readonly RiskKey[] = ['repeated-error', 'time-budget', 'non-fail-fast-check', 'shallow-check']

/** Plugin config; out-of-range numbers and unknown detector keys fail the plugin load. */
export interface Config {
  /** Tools whose `command` argument is a shell command line (default `bash`). */
  shellTools?: string[]
  /** Detectors to run (default: all four). */
  detectors?: RiskKey[]
  /** Consecutive failing shell results with the same error line that trigger `repeated-error` (default 2). */
  errorRepeatThreshold?: number
  /** Foreground duration in milliseconds from which a shell call counts as long (default 120000). */
  longStepMs?: number
  /** Total long-call time in milliseconds that triggers `time-budget` without a timeout (default 420000). */
  budgetMs?: number
  /** Maximum notes attached to one tool result (default 2). */
  maxNotesPerCall?: number
}

export const Config: z<Config> = z.object({
  shellTools: z.array(z.string()).default(['bash']),
  detectors: z.array(z.union([...RISK_KEYS])).default([...RISK_KEYS]),
  errorRepeatThreshold: z.number().default(2),
  longStepMs: z.number().default(120_000),
  budgetMs: z.number().default(420_000),
  maxNotesPerCall: z.number().default(2),
})

const VALIDATION_WORDS_RE = /\b(?:validate|validation|verify|verification|acceptance|final|evaluator|check|smoke test)\b/i
const HELP_OR_SYNTAX_RE = /(?:^|\s)(?:--help|-h)(?:\s|$)|\b(?:py_compile|compileall)\b|\bnode\s+--check\b|\bbash\s+-n\b/i
const EXISTENCE_ONLY_RE = /^\s*(?:pwd|ls|stat|file|which|type|readlink|test\s+-[efsd]|\[\s+-[efsd]|wc\s+-[clmw]|head|tail|cat)\b/i
const SEMANTIC_RUN_RE = new RegExp([
  String.raw`\b(?:pytest|unittest|tox|go\s+test|cargo\s+test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|vitest|jest|make\s+(?:test|check))\b`,
  String.raw`\b(?:curl\s+https?://|cmp|diff|sqlite3|psql|Rscript)\b`,
  String.raw`\b(?:python[0-9.]*|node|ruby)\s+(?!-)[^\s;&|]+\.(?:py|js|mjs|rb)\b`,
].join('|'), 'i')
const NON_FAIL_FAST_ASSERT_RE = /\b(?:diff|cmp)\b|\bgrep\s+-[a-z]*q|\btest\s+-[efsd]\b|\[\s+-[efsd]\b/i
const FAIL_FAST_GUARD_RE = /(?:^|[\n;&])\s*set\s+-[a-z]*e|\|\|\s*(?:exit|return)\b|\btrap\b[^\n]*\bexit\b/i
const MULTI_STEP_RE = /\n|;|\bfor\b|\bwhile\b|\buntil\b/
const REPORT_RE = /\b(?:echo|printf)\b/
const PY_EXCEPTION_RE = /^(?:[A-Za-z_][\w.]*\.)?[A-Z]\w*(?:Error|Exception|Exit|Interrupt)\b(?::.*)?$/
const ERROR_LINE_RE = new RegExp(
  String.raw`\b(?:error|fatal|panic|command not found|no such file or directory|cannot|not found|permission denied|undefined reference)\b`,
  'i',
)

/** One agent's execution record since its last user message. */
interface ExecutionRecord {
  lastSignature: string
  sameErrorRepeats: number
  longSteps: number
  longMs: number
  timeouts: number
  semanticRuns: number
  shallowRuns: number
  emitted: Set<string>
}

/** The foreground facts of one shell result that the detectors read. */
interface ShellOutcome {
  exitCode: number | null
  timedOut: boolean
  /** True when a foreground command reached its timeout and moved to the background. */
  promoted: boolean
  text: string
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`execution-risk-hints: invalid ${field} ${value} — must be an integer >= 1`)
  }
  return value
}

/** The string value of one named argument, when the parsed arguments are an object that holds one. */
function stringArgument(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const value: unknown = Reflect.get(args, key)
  return typeof value === 'string' ? value : undefined
}

function streamText(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ''
  const text: unknown = Reflect.get(value, 'text')
  return typeof text === 'string' ? text : ''
}

/** Read a shell result value. Returns `undefined` for failed calls and background jobs. */
function shellOutcome(result: ToolExecutionResult): ShellOutcome | undefined {
  if (result.isError) return undefined
  const value = result.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.kind === 'promoted') return { exitCode: null, timedOut: true, promoted: true, text: '' }
  if (value.kind !== undefined && value.kind !== 'foreground') return undefined
  const code = value.exitCode
  return {
    exitCode: typeof code === 'number' ? code : null,
    timedOut: value.timedOut === true,
    promoted: false,
    text: `${streamText(value.stderr)}\n${streamText(value.stdout)}`,
  }
}

/**
 * The error line of a failing command, normalized so runs that differ only
 * in numbers compare equal.
 * @param exitCode - the command's exit code, or `null` when it ended without exiting.
 * @param text - the command's stderr and stdout text.
 * @returns the normalized error line, or an empty string for a passing command or output with no recognizable error line.
 */
export function errorSignature(exitCode: number | null, text: string): string {
  if (exitCode === 0 || exitCode === null) return ''
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const line = lines.findLast(candidate => PY_EXCEPTION_RE.test(candidate)) ?? lines.find(candidate => ERROR_LINE_RE.test(candidate))
  if (line === undefined) return ''
  return line.replace(/\b0x[0-9a-f]+/gi, 'ADDR').replace(/\d+(?:\.\d+)?/g, 'N').slice(0, 160)
}

const REPORT_ONLY_RE = /^\s*(?:echo|printf|cd)\b/

/**
 * Whether every step of a command is a help, syntax, existence, or report
 * step, so a real run chained with `--help` is not shallow.
 */
function looksShallow(command: string, description: string): boolean {
  const steps = command.split(/&&|\|\||[;\n|]/).map(step => step.trim()).filter(step => step.length > 0)
  const help = steps.some(step => HELP_OR_SYNTAX_RE.test(step))
  const existence = VALIDATION_WORDS_RE.test(description) && steps.some(step => EXISTENCE_ONLY_RE.test(step))
  if (!help && !existence) return false
  return steps.every(step => HELP_OR_SYNTAX_RE.test(step) || EXISTENCE_ONLY_RE.test(step) || REPORT_ONLY_RE.test(step))
}

function looksNonFailFast(command: string, description: string): boolean {
  if (!VALIDATION_WORDS_RE.test(`${description}\n${command}`)) return false
  if (!NON_FAIL_FAST_ASSERT_RE.test(command) || FAIL_FAST_GUARD_RE.test(command)) return false
  return MULTI_STEP_RE.test(command) && REPORT_RE.test(command)
}

/**
 * Install the hint listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; numbers are re-checked here and fail the load when out of range.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees every field after validation.
  const shellTools = new Set(config.shellTools as string[])
  const detectors = new Set(config.detectors as RiskKey[])
  const errorRepeatThreshold = positiveInteger(config.errorRepeatThreshold as number, 'errorRepeatThreshold')
  const longStepMs = positiveInteger(config.longStepMs as number, 'longStepMs')
  const budgetMs = positiveInteger(config.budgetMs as number, 'budgetMs')
  const maxNotesPerCall = positiveInteger(config.maxNotesPerCall as number, 'maxNotesPerCall')

  const records = new WeakMap<Agent, ExecutionRecord>()
  // Keyed by the execution object, which pre-execute and post-execute share;
  // an entry whose post-execute never runs is collected with its execution.
  const started = new WeakMap<ToolExecution, number>()

  function recordOf(agent: Agent): ExecutionRecord {
    let record = records.get(agent)
    if (record === undefined) {
      record = { lastSignature: '', sameErrorRepeats: 0, longSteps: 0, longMs: 0, timeouts: 0, semanticRuns: 0, shallowRuns: 0, emitted: new Set() }
      records.set(agent, record)
    }
    return record
  }

  /** Update the agent's record with one shell result and return the notes it triggers, highest priority first. */
  function observe(
    record: ExecutionRecord,
    command: string,
    description: string,
    outcome: ShellOutcome,
    durationMs: number,
  ): { key: string; note: string }[] {
    const candidates: { key: string; note: string }[] = []

    if (outcome.timedOut || durationMs >= longStepMs) {
      record.longSteps += 1
      record.longMs += durationMs
    }
    if (outcome.timedOut) record.timeouts += 1
    const shallow = looksShallow(command, description)
    if (shallow) record.shallowRuns += 1
    else if (SEMANTIC_RUN_RE.test(command)) record.semanticRuns += 1

    const signature = outcome.timedOut ? '' : errorSignature(outcome.exitCode, outcome.text)
    if (signature !== '' && signature === record.lastSignature) {
      record.sameErrorRepeats += 1
    } else {
      record.lastSignature = signature
      record.sameErrorRepeats = signature === '' ? 0 : 1
    }

    if (detectors.has('repeated-error') && record.sameErrorRepeats >= errorRepeatThreshold) {
      candidates.push({
        key: `repeated-error:${signature}`,
        note: `The last ${record.sameErrorRepeats} shell commands failed with the same error:\n\`${signature}\`\n`
          + 'The approach behind them has not changed the outcome. Before you run another variant, check the assumption it depends on '
          + '(path, working directory, installed module, function signature, test name) and change the approach.',
      })
    }
    if (detectors.has('time-budget') && record.longSteps >= 2 && (record.timeouts >= 1 || record.longMs >= budgetMs)) {
      candidates.push({
        key: 'time-budget',
        note: `About ${Math.round(record.longMs / 1000)}s went into long foreground commands or timeouts since the user's last message. `
          + 'Prefer short probes, run long jobs in the background and poll them, and deliver the best verified result instead of starting another long run.',
      })
    }
    if (detectors.has('non-fail-fast-check') && looksNonFailFast(command, description)) {
      candidates.push({
        key: 'non-fail-fast-check',
        note: 'This check runs diff/cmp/test-style assertions in a multi-step script without `set -e` or `|| exit 1`. '
          + 'A failed assertion can be followed by a success message and exit code 0. Make each assertion stop the script, or run the assertions separately, before you trust the result.',
      })
    }
    if (detectors.has('shallow-check') && shallow && (VALIDATION_WORDS_RE.test(description) || record.shallowRuns >= 2) && record.semanticRuns === 0) {
      candidates.push({
        key: 'shallow-check',
        note: 'This command checks only help text, syntax, or file existence. It does not show that the change works. '
          + 'Run the real entry point or the relevant tests with the arguments the task describes, and read the output.',
      })
    }
    return candidates
  }

  function hintFor(exec: ToolExecution, result: ToolExecutionResult): UserMessage | undefined {
    const startedAt = started.get(exec)
    started.delete(exec)
    if (exec.agent === undefined || !shellTools.has(exec.name)) return undefined
    const command = stringArgument(exec.arguments, 'command')
    const outcome = shellOutcome(result)
    if (command === undefined || outcome === undefined) return undefined
    const record = recordOf(exec.agent)
    const durationMs = startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt)
    const fresh = observe(record, command, stringArgument(exec.arguments, 'description') ?? '', outcome, durationMs)
      .filter(candidate => !record.emitted.has(candidate.key))
      .slice(0, maxNotesPerCall)
    if (fresh.length === 0) return undefined
    for (const candidate of fresh) record.emitted.add(candidate.key)
    return createUserMessage({
      content: [{ type: 'text', text: `Execution notes:\n${fresh.map(candidate => `- ${candidate.note}`).join('\n')}` }],
      source: { kind: 'execution-risk-hints', form: 'notice', summary: fresh.map(candidate => candidate.key.split(':')[0]).join(', ') },
    })
  }

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = await next()
    if (exec.agent !== undefined && shellTools.has(exec.name)) started.set(exec, Date.now())
    return decision
  })

  // Observe and enrich, never veto: delegate first, then fold the note onto
  // whichever decision came back so a blocked call keeps its note too.
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const hint = hintFor(exec, result)
    const downstream = await next()
    if (hint === undefined) return downstream
    return { ...downstream, additionalContexts: [hint, ...downstream.additionalContexts ?? []] }
  })

  // A user message starts a new request; earlier notes and counters belong to the old one.
  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) records.delete(agent)
    return next()
  })
}
