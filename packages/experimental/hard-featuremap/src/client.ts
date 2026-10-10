/**
 * Client-safe feature map vocabulary for the browser panel: the graph and
 * symbol detail the Host routes return. Types only: this file rides the
 * browser bundle's type check, so any runtime import here would drag SQLite
 * or the Host service into the client graph.
 * @module @deepseek-ai/dsh-experimental-hard-featuremap/client
 */

export type { HardEdgeRow, HardEdgeSource, HardFeatureGraphNode, HardFeatureGraphView, HardSymbolDetail, HardSymbolRow } from './types.ts'
