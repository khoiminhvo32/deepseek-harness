/**
 * The feature map's display vocabulary, shared by the Host service and the
 * browser panel. Types only: the browser bundle type-checks this file through
 * the `./client` export, so a runtime import here would drag SQLite or the
 * Host service into the client graph.
 * @module @deepseek-ai/dsh-experimental-hard-featuremap/types
 */

/**
 * Which rule made a call edge: `joern` (the graph's own resolution),
 * `repair` (a type-qualified, relative, or receiverless call resolved through
 * the type lineage, or a free function a class-qualified call meant), `unique-name`
 * (a method call on an unknown receiver whose name only one method carries),
 * or `hook` (a fired hook reaching a registered callback).
 */
export type HardEdgeSource = 'joern' | 'repair' | 'unique-name' | 'hook'

/** One symbol as a query returns it. */
export interface HardSymbolRow {
  readonly id: string
  readonly name: string
  readonly kind: 'function' | 'method' | 'script'
  readonly owner: string | null
  readonly file: string
  readonly line: number | null
  readonly end: number | null
}

/** One edge as a query returns it: the other end, where the call is, and which rule made it. */
export interface HardEdgeRow {
  readonly caller: string
  readonly callee: string
  readonly file: string
  readonly line: number | null
  readonly source: HardEdgeSource
}

/** One symbol of a feature graph: the symbol, its role in the feature (or `excluded`), and where it is. */
export interface HardFeatureGraphNode {
  readonly id: string
  readonly name: string
  readonly role: 'entry' | 'guard' | 'mutation' | 'helper' | 'excluded'
  readonly file: string | null
  readonly line: number | null
}

/** The symbols of one recorded feature and the call edges among them. */
export interface HardFeatureGraphView {
  readonly feature: string
  readonly nodes: readonly HardFeatureGraphNode[]
  readonly edges: readonly { readonly from: string; readonly to: string; readonly source: HardEdgeSource }[]
}

/** One symbol with its call edges and its source at the pinned commit. */
export interface HardSymbolDetail {
  readonly symbol: HardSymbolRow
  readonly callers: readonly HardEdgeRow[]
  readonly callees: readonly HardEdgeRow[]
  /** The symbol's lines at the pinned commit, cut at the service's line bound; null when they cannot be read. */
  readonly source: { readonly startLine: number; readonly lines: readonly string[]; readonly truncated: boolean } | null
}
