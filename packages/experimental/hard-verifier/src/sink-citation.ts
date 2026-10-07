/**
 * The declared-site citation grammar of a coverage cell: `path:locator`,
 * optionally followed by whitespace and a free note, where the locator is a
 * symbol, a positive line number, or an ascending line range `start-end`.
 * The verifier resolves citations at the pinned commit, and the coverage
 * cross-check matches its grep lines against them by path and symbol or line.
 * @module
 */

/** One parsed declared-site citation. */
export interface SinkCitation {
  /** Target-repo-relative path before the first colon. */
  readonly path: string
  /** The symbol or line token after the colon. */
  readonly locator: string
  /** The cited lines, inclusive, when the locator is a line or a line range; one line has `first === last`. */
  readonly lines?: { readonly first: number; readonly last: number }
}

/**
 * Parse one declared site as `path:locator[ note]`. The locator is the first
 * whitespace-free token after the colon; a positive integer cites a line, two
 * joined by `-` cite an ascending range, anything else a symbol. A
 * declaration without a colon-separated path and locator, or with a line of
 * zero or a descending range, is not a citation.
 * @param declaration - one declared-site string as the model wrote it.
 * @returns the parsed citation, or `undefined` when the text is not one.
 */
export function parseSinkCitation(declaration: string): SinkCitation | undefined {
  const match = /^(?<path>[^:\s][^:]*):(?<locator>\S+)(?:\s.*)?$/su.exec(declaration.trim())
  const path = match?.groups?.path
  const locator = match?.groups?.locator
  if (path === undefined || locator === undefined) return undefined
  const range = /^(?<start>\d+)(?:-(?<end>\d+))?$/u.exec(locator)?.groups
  if (range === undefined) return { path, locator }
  const first = Number(range.start)
  const last = range.end === undefined ? first : Number(range.end)
  return first >= 1 && last >= first ? { path, locator, lines: { first, last } } : undefined
}

/**
 * Whether one declared site covers one `grep -n` match line
 * (`path:line:content`). A citation covers a match on its own path when the
 * matched line falls in its cited lines or the matched content contains its
 * symbol. A declaration that is not a citation — older records, batch-screen
 * patterns — keeps the substring rule, so their audits read back unchanged.
 * @param declaration - one declared-site string.
 * @param grepLine - one match line the cross-check grep printed.
 * @returns true when the declaration accounts for the match.
 */
export function declarationCoversLine(declaration: string, grepLine: string): boolean {
  const citation = parseSinkCitation(declaration)
  const match = /^(?<path>.+?):(?<line>\d+):(?<content>.*)$/su.exec(grepLine)
  if (citation === undefined || match?.groups === undefined) return grepLine.includes(declaration)
  if (match.groups.path !== citation.path) return false
  if (citation.lines === undefined) return String(match.groups.content).includes(citation.locator)
  const matched = Number(match.groups.line)
  return matched >= citation.lines.first && matched <= citation.lines.last
}
