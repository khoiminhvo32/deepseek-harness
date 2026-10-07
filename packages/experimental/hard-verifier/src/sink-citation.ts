/**
 * The declared-site citation grammar of a coverage cell: `path:locator`,
 * optionally followed by whitespace and a free note, where the locator is a
 * symbol or a positive line number. The verifier resolves citations at the
 * pinned commit, and the coverage cross-check matches its grep lines against
 * them by path and symbol or line.
 * @module
 */

/** One parsed declared-site citation. */
export interface SinkCitation {
  /** Target-repo-relative path before the first colon. */
  readonly path: string
  /** The symbol or line token after the colon. */
  readonly locator: string
  /** The cited line, when the locator is a positive integer. */
  readonly line?: number
}

/**
 * Parse one declared site as `path:locator[ note]`. The locator is the first
 * whitespace-free token after the colon; a positive integer cites a line,
 * anything else a symbol. A declaration without a colon-separated path and
 * locator is not a citation.
 * @param declaration - one declared-site string as the model wrote it.
 * @returns the parsed citation, or `undefined` when the text is not one.
 */
export function parseSinkCitation(declaration: string): SinkCitation | undefined {
  const match = /^(?<path>[^:\s][^:]*):(?<locator>\S+)(?:\s.*)?$/su.exec(declaration.trim())
  const path = match?.groups?.path
  const locator = match?.groups?.locator
  if (path === undefined || locator === undefined) return undefined
  if (!/^\d+$/u.test(locator)) return { path, locator }
  const line = Number(locator)
  return line >= 1 ? { path, locator, line } : undefined
}

/**
 * Whether one declared site covers one `grep -n` match line
 * (`path:line:content`). A citation covers a match on its own path when the
 * line numbers agree or the matched content contains its symbol. A
 * declaration that is not a citation — older records, batch-screen patterns —
 * keeps the substring rule, so their audits read back unchanged.
 * @param declaration - one declared-site string.
 * @param grepLine - one match line the cross-check grep printed.
 * @returns true when the declaration accounts for the match.
 */
export function declarationCoversLine(declaration: string, grepLine: string): boolean {
  const citation = parseSinkCitation(declaration)
  const match = /^(?<path>.+?):(?<line>\d+):(?<content>.*)$/su.exec(grepLine)
  if (citation === undefined || match?.groups === undefined) return grepLine.includes(declaration)
  if (match.groups.path !== citation.path) return false
  return citation.line === undefined
    ? (match.groups.content ?? '').includes(citation.locator)
    : Number(match.groups.line) === citation.line
}
