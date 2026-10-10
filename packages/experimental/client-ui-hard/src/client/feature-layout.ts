/**
 * Pure layouts of the feature map panel. Entry points keep their index order
 * and features their record order, so a feature that appears later lands
 * after the ones already drawn and nothing already on screen moves.
 */
import type { HardLedgerClientView } from '@deepseek-ai/dsh-experimental-hard-ledger/client'
import type { HardEdgeSource, HardFeatureGraphNode, HardFeatureGraphView } from '@deepseek-ai/dsh-experimental-hard-featuremap/client'

/** The browser route of one feature's symbol graph. */
export const FEATURE_GRAPH_ROUTE = 'api/hard-featuremap.feature'
/** The browser route of one symbol's detail. */
export const SYMBOL_DETAIL_ROUTE = 'api/hard-featuremap.symbol'

/** The indexed feature map of the wire view. */
export type FeatureMapView = NonNullable<HardLedgerClientView['featureMap']>

/** One laid-out node. */
export interface LayoutNode {
  readonly id: string
  readonly kind: 'entry' | 'feature' | 'symbol'
  readonly label: string
  readonly detail: string
  readonly role?: HardFeatureGraphNode['role']
  /** For an overview entry point: whether a recorded feature covers it. */
  readonly mapped?: boolean
  readonly x: number
  readonly y: number
}

/** One laid-out edge. */
export interface LayoutEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly kind: 'member' | 'link' | HardEdgeSource
  readonly label?: string
}

const COLUMN = 300
const ROW = 64

/**
 * The node id of an entry point or a feature in the overview.
 * @param kind - which column the node sits in.
 * @param key - the entry point key or the feature id.
 * @returns the React Flow node id.
 */
export function overviewId(kind: 'entry' | 'feature', key: string): string {
  return `${kind}:${key}`
}

/**
 * Every indexed entry point in one column per entry kind, in index order, with
 * the features in record order in the column after the last kind.
 * @param map - the indexed feature map.
 * @returns the overview nodes and edges.
 */
export function overviewLayout(map: FeatureMapView): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const kinds: string[] = []
  const rows = new Map<string, number>()
  const entries = map.entryPoints.map((entry) => {
    const kind = entry.key.slice(0, Math.max(0, entry.key.indexOf(':')))
    if (!kinds.includes(kind)) kinds.push(kind)
    const row = rows.get(kind) ?? 0
    rows.set(kind, row + 1)
    return {
      id: overviewId('entry', entry.key), kind: 'entry' as const, label: entry.key, detail: entry.handler ?? '', mapped: entry.mapped,
      x: kinds.indexOf(kind) * COLUMN, y: row * ROW,
    }
  })
  const nodes: LayoutNode[] = [
    ...entries,
    ...map.features.map((feature, row) => ({
      id: overviewId('feature', feature.id), kind: 'feature' as const, label: `${feature.id} ${feature.name}`, detail: feature.summary,
      x: (kinds.length + 0.5) * COLUMN, y: row * ROW,
    })),
  ]
  const edges: LayoutEdge[] = [
    ...map.features.flatMap(feature => feature.entryPoints.map(key => ({
      id: `member:${key}:${feature.id}`, from: overviewId('entry', key), to: overviewId('feature', feature.id), kind: 'member' as const,
    }))),
    ...map.links.map((link, index) => ({
      id: `link:${index}`, from: overviewId('feature', link.from), to: overviewId('feature', link.to), kind: 'link' as const, label: link.kind,
    })),
  ]
  return { nodes, edges }
}

/**
 * A feature's symbols layered by call distance from its entry symbols; excluded and unreached symbols take the last column.
 * @param graph - the feature graph from the Host route.
 * @returns the detail nodes and edges.
 */
export function featureLayout(graph: HardFeatureGraphView): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const level = new Map<string, number>(graph.nodes.filter(node => node.role === 'entry').map(node => [node.id, 0]))
  let frontier = [...level.keys()]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const edge of graph.edges) {
      const from = level.get(edge.from)
      if (from === undefined || !frontier.includes(edge.from) || level.has(edge.to)) continue
      level.set(edge.to, from + 1)
      next.push(edge.to)
    }
    frontier = next
  }
  const deepest = Math.max(0, ...level.values())
  const rows = new Map<number, number>()
  const nodes = graph.nodes.map((node) => {
    const reached = level.get(node.id)
    const column = node.role === 'excluded' || reached === undefined ? deepest + 1 : reached
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    const where = node.file === null ? '' : `${node.file}${node.line === null ? '' : `:${node.line}`}`
    return { id: node.id, kind: 'symbol' as const, label: node.name, detail: where, role: node.role, x: column * COLUMN, y: row * ROW }
  })
  const edges = graph.edges.map((edge, index) => ({ id: `edge:${index}`, from: edge.from, to: edge.to, kind: edge.source }))
  return { nodes, edges }
}
