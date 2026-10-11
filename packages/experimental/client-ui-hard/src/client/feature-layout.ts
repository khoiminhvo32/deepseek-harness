/**
 * Pure layouts of the feature map panel. Before any feature is recorded the
 * overview lists the indexed entry points by kind; afterwards it groups them
 * by feature. Features keep their record order and each cluster has a fixed
 * size, so a feature that appears later lands after the ones already drawn.
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
  readonly kind: 'entry' | 'feature' | 'symbol' | 'unmapped'
  readonly label: string
  readonly detail: string
  readonly role?: HardFeatureGraphNode['role']
  /** For an overview entry point: whether a recorded feature covers it. */
  readonly mapped?: boolean
  /** For the unmapped node: how many entry points no feature covers. */
  readonly count?: number
  /** For a feature node: whether the feature has an abuse review. */
  readonly reviewed?: boolean
  readonly x: number
  readonly y: number
}

/** One laid-out edge. */
export interface LayoutEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly kind: 'member' | 'link' | 'harness-link' | HardEdgeSource
  readonly label?: string
}

const COLUMN = 300
const ROW = 64
const CLUSTER_COLUMNS = 3
const CLUSTER_X = 340
const ENTRY_ROW = 36
const CLUSTER_ENTRIES = 6
const CLUSTER_Y = ROW + (CLUSTER_ENTRIES + 1) * ENTRY_ROW

/** The node id of the overview node that stands for every unmapped entry point. */
export const UNMAPPED_NODE = 'unmapped'

/**
 * The node id of an entry point or a feature in the overview.
 * @param kind - which column the node sits in.
 * @param key - the entry point key or the feature id.
 * @returns the React Flow node id.
 */
export function overviewId(kind: 'entry' | 'feature' | 'more', key: string): string {
  return `${kind}:${key}`
}

/**
 * The overview: entry points by kind until a feature is recorded, then one
 * cluster per feature.
 * @param map - the indexed feature map.
 * @returns the overview nodes and edges.
 */
export function overviewLayout(map: FeatureMapView): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  return map.features.length === 0 ? entryLayout(map) : clusterLayout(map)
}

/**
 * One cluster per feature in a grid of {@link CLUSTER_COLUMNS}: the feature with up to
 * {@link CLUSTER_ENTRIES} of its entry points below it and a count node for the rest, plus
 * one node beside the grid for the entry points no feature covers.
 * @param map - the indexed feature map with at least one feature.
 * @returns the overview nodes and edges.
 */
function clusterLayout(map: FeatureMapView): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const handler = new Map(map.entryPoints.map(entry => [entry.key, entry.handler]))
  const nodes: LayoutNode[] = []
  const edges: LayoutEdge[] = []
  map.features.forEach((feature, index) => {
    const x = (index % CLUSTER_COLUMNS) * CLUSTER_X
    const y = Math.floor(index / CLUSTER_COLUMNS) * CLUSTER_Y
    const featureNode = overviewId('feature', feature.id)
    nodes.push({ id: featureNode, kind: 'feature', label: `${feature.id} ${feature.name}`, detail: feature.summary, reviewed: feature.reviewed, x, y })
    feature.entryPoints.slice(0, CLUSTER_ENTRIES).forEach((key, row) => {
      const id = overviewId('entry', `${feature.id}:${key}`)
      nodes.push({ id, kind: 'entry', label: key, detail: handler.get(key) ?? '', mapped: true, x: x + 24, y: y + ROW + row * ENTRY_ROW })
      edges.push({ id: `member:${feature.id}:${key}`, from: featureNode, to: id, kind: 'member' })
    })
    const rest = feature.entryPoints.length - CLUSTER_ENTRIES
    if (rest > 0) {
      nodes.push({ id: overviewId('more', feature.id), kind: 'entry', label: `+${rest}`, detail: '', x: x + 24, y: y + ROW + CLUSTER_ENTRIES * ENTRY_ROW })
    }
  })
  const unmapped = map.entryPoints.filter(entry => !entry.mapped).length
  if (unmapped > 0) nodes.push({ id: UNMAPPED_NODE, kind: 'unmapped', label: '', detail: '', count: unmapped, x: CLUSTER_COLUMNS * CLUSTER_X + 40, y: 0 })
  for (const [index, link] of map.links.entries()) {
    edges.push({
      id: `link:${index}`, from: overviewId('feature', link.from), to: overviewId('feature', link.to),
      kind: link.source === 'harness' ? 'harness-link' : 'link', label: link.kind,
    })
  }
  return { nodes, edges }
}

/**
 * Every indexed entry point in one column per entry kind, in index order.
 * @param map - the indexed feature map without features.
 * @returns the overview nodes.
 */
function entryLayout(map: FeatureMapView): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
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
  return { nodes: entries, edges: [] }
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
