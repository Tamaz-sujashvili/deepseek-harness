/**
 * Tree-sitter WASM syntax checks for the edit guard. One {@link SyntaxChecker}
 * belongs to one plugin instance; it initializes the WASM runtime once and
 * caches each grammar it loads.
 *
 * @module @deepseek-ai/dsh-edit-syntax-guard/syntax
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type * as TreeSitter from '@vscode/tree-sitter-wasm'

/** Grammars shipped by `@vscode/tree-sitter-wasm` that the guard can load. */
export type GrammarName = 'python' | 'javascript' | 'typescript' | 'tsx' | 'go' | 'rust' | 'java'

/** Every grammar name, in a stable order. */
export const GRAMMAR_NAMES: readonly GrammarName[] = ['python', 'javascript', 'typescript', 'tsx', 'go', 'rust', 'java']

/** One syntax problem: an `ERROR` node or a node the parser inserted as missing. */
export interface SyntaxProblem {
  /** 1-based line. */
  line: number
  /** 1-based column. */
  column: number
  /** `error` for an unparsable region, `missing` for an inserted token such as `)`. */
  kind: 'error' | 'missing'
  /** The missing node type (for `missing`), for example `)` or `identifier`. */
  expected?: string
}

type TreeSitterModule = typeof TreeSitter

/**
 * Parser for one process-local plugin instance.
 */
export class SyntaxChecker {
  private module: Promise<TreeSitterModule> | undefined
  private readonly languages = new Map<GrammarName, Promise<TreeSitter.Language>>()
  private readonly wasmDir: string

  /**
   * @param wasmDir - directory holding `tree-sitter.wasm` and the `tree-sitter-<name>.wasm` grammars;
   *   defaults to the installed `@vscode/tree-sitter-wasm` package.
   */
  constructor(wasmDir?: string) {
    this.wasmDir = wasmDir ?? join(dirname(createRequire(import.meta.url).resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm')
  }

  private async runtime(): Promise<TreeSitterModule> {
    this.module ??= (async () => {
      const mod = createRequire(import.meta.url)('@vscode/tree-sitter-wasm') as TreeSitterModule
      await mod.Parser.init({ locateFile: (file: string) => join(this.wasmDir, file) })
      return mod
    })()
    return this.module
  }

  private async language(name: GrammarName): Promise<TreeSitter.Language> {
    let pending = this.languages.get(name)
    if (pending === undefined) {
      pending = (async () => {
        const mod = await this.runtime()
        return mod.Language.load(await readFile(join(this.wasmDir, `tree-sitter-${name}.wasm`)))
      })()
      this.languages.set(name, pending)
    }
    return pending
  }

  /**
   * Parse `source` and list its syntax problems in document order.
   *
   * @param grammar - the grammar to parse with.
   * @param source - the complete file text.
   * @param limit - maximum number of problems returned.
   * @returns every `ERROR` and missing node, at most `limit` entries.
   */
  async problems(grammar: GrammarName, source: string, limit = 50): Promise<SyntaxProblem[]> {
    const mod = await this.runtime()
    const parser = new mod.Parser()
    try {
      parser.setLanguage(await this.language(grammar))
      const tree = parser.parse(source)
      if (tree === null) return [{ line: 1, column: 1, kind: 'error' }]
      try {
        const out: SyntaxProblem[] = []
        if (!tree.rootNode.hasError) return out
        const todo: TreeSitter.Node[] = [tree.rootNode]
        for (let node = todo.pop(); node !== undefined && out.length < limit; node = todo.pop()) {
          if (node.isMissing) {
            out.push({ line: node.startPosition.row + 1, column: node.startPosition.column + 1, kind: 'missing', expected: node.type })
          } else if (node.isError) {
            out.push({ line: node.startPosition.row + 1, column: node.startPosition.column + 1, kind: 'error' })
            continue
          }
          if (!node.hasError) continue
          for (let i = node.childCount - 1; i >= 0; i--) {
            const child = node.child(i)
            if (child !== null) todo.push(child)
          }
        }
        return out
      } finally {
        tree.delete()
      }
    } finally {
      parser.delete()
    }
  }
}
