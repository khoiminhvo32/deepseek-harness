/**
 * The hard-harness feature map panel. The overview draws entry points beside
 * the features the model recorded and the links between features, from the
 * Session's `hardLedger` projection, so it updates as the mission records.
 * Selecting a feature fetches its symbol graph from the Host; selecting a
 * symbol fetches its call edges and source at the pinned commit. Nodes that
 * appear after the panel opened carry a fresh mark for a few seconds.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// The `hardLedger` key on SessionProjectionMap arrives through this merge.
import type {} from '@deepseek-ai/dsh-experimental-hard-ledger/client'
// The session standard kit (sessionId, useSessions) arrives through these merges.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { HardFeatureGraphView, HardSymbolDetail } from '@deepseek-ai/dsh-experimental-hard-featuremap/client'
import {
  FEATURE_GRAPH_ROUTE, SYMBOL_DETAIL_ROUTE, UNMAPPED_NODE, featureLayout, overviewId, overviewLayout,
  type LayoutEdge, type LayoutNode,
} from './feature-layout.ts'
import { NS, type HardKey } from './locales.ts'
import css from './FeatureMap.module.css'

/** Full props of the feature map panel, composed from the slot's shares. */
export type FeatureMapProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS>

/** How long a newly drawn node keeps its fresh mark. */
const FRESH_MS = 4000

/** Stroke of each edge kind. */
const EDGE_COLOR: Record<LayoutEdge['kind'], string> = {
  member: 'var(--dsw-alias-border-l2)',
  link: 'var(--dsw-alias-state-business-primary)',
  joern: 'var(--dsw-alias-label-tertiary)',
  repair: 'var(--dsw-alias-state-warn-primary)',
  'unique-name': 'var(--dsw-alias-state-error-primary)',
  hook: 'var(--dsw-alias-state-success-primary)',
}

/** Locale key of each call-edge source, in legend order. */
const LEGEND: readonly [LayoutEdge['kind'], HardKey][] = [
  ['joern', 'map.legend.joern'], ['repair', 'map.legend.repair'], ['unique-name', 'map.legend.uniqueName'], ['hook', 'map.legend.hook'],
]

/** Locale key of each symbol role. */
const ROLE_LABEL: Record<NonNullable<LayoutNode['role']>, HardKey> = {
  entry: 'map.role.entry', guard: 'map.role.guard', mutation: 'map.role.mutation', helper: 'map.role.helper', excluded: 'map.role.excluded',
}

/** A fetch of one Host route: pending, failed with a message, or the value. */
type Load<T> = { readonly state: 'loading' } | { readonly state: 'error'; readonly message: string } | { readonly state: 'ready'; readonly value: T }

/** The JSON each Host route answers with. */
interface RouteResponses {
  [FEATURE_GRAPH_ROUTE]: HardFeatureGraphView
  [SYMBOL_DETAIL_ROUTE]: HardSymbolDetail
}

/** Fetch one route's JSON while `key` stays the same; `key` undefined fetches nothing. */
function useRoute<R extends keyof RouteResponses>(
  route: R,
  params: Record<string, string> | undefined,
  key: string | undefined,
): Load<RouteResponses[R]> | undefined {
  type T = RouteResponses[R]
  const [load, setLoad] = useState<Load<T> | undefined>(undefined)
  useEffect(() => {
    if (params === undefined || key === undefined) {
      setLoad(undefined)
      return
    }
    let live = true
    setLoad({ state: 'loading' })
    fetch(`${route}?${new URLSearchParams(params).toString()}`)
      .then(async (response) => {
        const body = await response.json() as T & { error?: string }
        if (!live) return
        setLoad(response.ok ? { state: 'ready', value: body } : { state: 'error', message: body.error ?? String(response.status) })
      })
      .catch((error: unknown) => {
        if (live) setLoad({ state: 'error', message: String(error) })
      })
    return () => {
      live = false
    }
  // `key` names the inputs; `params` is rebuilt every render.
  }, [route, key])
  return load
}

/** The ids drawn since the panel opened that are younger than {@link FRESH_MS}. */
function useFresh(ids: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | undefined>(undefined)
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  const joined = ids.join('\u0000')
  useEffect(() => {
    if (seen.current === undefined) {
      seen.current = new Set(ids)
      return
    }
    const known = seen.current
    const added = ids.filter(id => !known.has(id))
    for (const id of added) known.add(id)
    setFresh(current => new Set([...current, ...added]))
    const timer = setTimeout(() => {
      setFresh(current => new Set([...current].filter(id => !added.includes(id))))
    }, FRESH_MS)
    return () => {
      clearTimeout(timer)
    }
  // `joined` is the value of `ids`.
  }, [joined])
  return fresh
}

function flowNodes(nodes: readonly LayoutNode[], fresh: ReadonlySet<string>, selected: string | undefined, t: FeatureMapProps['t']): Node[] {
  return nodes.map(node => ({
    id: node.id,
    position: { x: node.x, y: node.y },
    className: [css.node, css[`kind-${node.kind}`], node.role === undefined ? undefined : css[`role-${node.role}`],
      node.mapped === false ? css.entryUnmapped : undefined, fresh.has(node.id) ? css.fresh : undefined,
      node.id === selected ? css.selected : undefined].filter(Boolean).join(' '),
    data: {
      label: (
        <div className={css.nodeBody} title={node.detail}>
          <span className={css.nodeLabel}>{node.count === undefined ? node.label : t('map.unmapped', { count: node.count })}</span>
          {node.role === undefined ? null : <span className={css.nodeRole}>{t(ROLE_LABEL[node.role])}</span>}
          {fresh.has(node.id) ? <span className={css.freshMark}>{t('map.fresh')}</span> : null}
        </div>
      ),
    },
    draggable: false,
  }))
}

function flowEdges(edges: readonly LayoutEdge[]): Edge[] {
  return edges.map(edge => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    ...edge.label === undefined ? {} : { label: edge.label },
    style: { stroke: EDGE_COLOR[edge.kind] },
    animated: edge.kind === 'link',
  }))
}

/**
 * The feature map tab body.
 * @param props - the slot's runtime and locale shares.
 * @returns the panel.
 */
export function FeatureMap({ sessionId, useSessions, t }: FeatureMapProps): ReactNode {
  const view = useSessions(state => state.projectionsBySession[sessionId]?.values.hardLedger)
  const map = view?.featureMap
  const [feature, setFeature] = useState<string | undefined>(undefined)
  const [symbol, setSymbol] = useState<string | undefined>(undefined)
  const [unmappedOpen, setUnmappedOpen] = useState(false)
  const record = map?.features.find(entry => entry.id === feature)
  // A revised record changes this key, so the graph refetches.
  const recordKey = record === undefined ? undefined : JSON.stringify(record)
  const graph = useRoute(FEATURE_GRAPH_ROUTE, feature === undefined ? undefined : { session: sessionId, feature }, recordKey)
  const detail = useRoute(SYMBOL_DETAIL_ROUTE, symbol === undefined ? undefined : { session: sessionId, symbol }, symbol)
  const overview = map === undefined ? { nodes: [], edges: [] } : overviewLayout(map)
  const fresh = useFresh(overview.nodes.map(node => node.id))

  if (map === undefined) {
    return (
      <div className={css.root} data-hard-feature-map>
        <div className={css.notice} role="status"><StateDot state="warning" />{t('map.empty')}</div>
      </div>
    )
  }

  const unmapped = map.entryPoints.filter(entry => !entry.mapped)
  const mappedCount = map.entryPoints.length - unmapped.length
  const open = (id: string | undefined) => {
    setFeature(id)
    setSymbol(undefined)
  }
  const shown = record !== undefined && graph?.state === 'ready' ? featureLayout(graph.value) : overview

  return (
    <div className={css.root} data-hard-feature-map>
      <div className={css.header}>
        <span className={css.summary}>
          {t('map.summary', { features: map.features.length, mapped: mappedCount, total: map.entryPoints.length, links: map.links.length })}
        </span>
        <span className={css.commit}>{map.commit.slice(0, 12)}</span>
      </div>
      <div className={css.features} role="list">
        {map.features.map(entry => (
          <button
            key={entry.id}
            type="button"
            role="listitem"
            className={[css.chip, entry.id === feature ? css.chipActive : undefined, fresh.has(overviewId('feature', entry.id)) ? css.fresh : undefined]
              .filter(Boolean).join(' ')}
            onClick={() => {
              open(entry.id === feature ? undefined : entry.id)
            }}
          >
            {entry.id} {entry.name}
          </button>
        ))}
      </div>
      {record === undefined ? null : (
        <div className={css.featureCard}>
          <button type="button" className={css.back} onClick={() => { open(undefined) }}>{t('map.back')}</button>
          <strong>{record.id} {record.name}</strong>
          <span>{record.summary}</span>
          <span className={css.meta}>{t('map.featureMeta', { reach: record.reach, required: record.required, excluded: record.excluded })}</span>
          {record.states.length === 0 ? null : (
            <span className={css.meta}>
              {t('map.states')}: {record.states.map(entry => `${entry.access} ${entry.kind}:${entry.key}`).join(', ')}
            </span>
          )}
          {graph?.state === 'loading' ? <span className={css.meta} role="status">{t('map.loading')}</span> : null}
          {graph?.state === 'error' ? <span className={css.error} role="alert">{t('map.error', { message: graph.message })}</span> : null}
          <div className={css.legend}>
            {LEGEND.map(([kind, key]) => <span key={kind}><i style={{ background: EDGE_COLOR[kind] }} />{t(key)}</span>)}
          </div>
        </div>
      )}
      <div className={css.canvas}>
        <ReactFlow
          nodes={flowNodes(shown.nodes, fresh, record === undefined ? undefined : symbol, t)}
          edges={flowEdges(shown.edges)}
          nodesConnectable={false}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_event, node) => {
            if (record !== undefined) setSymbol(node.id)
            else if (node.id.startsWith('feature:')) open(node.id.slice('feature:'.length))
            else if (node.id === UNMAPPED_NODE) setUnmappedOpen(true)
          }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {detail === undefined ? null : <SymbolPanel detail={detail} t={t} onSelect={setSymbol} />}
      {unmapped.length === 0 ? null : (
        <details
          className={css.unmapped}
          open={unmappedOpen}
          onToggle={(event) => {
            setUnmappedOpen(event.currentTarget.open)
          }}
        >
          <summary>{t('map.unmapped', { count: unmapped.length })}</summary>
          <ul>{unmapped.map(entry => <li key={entry.key}><code>{entry.key}</code> {entry.handler ?? ''}</li>)}</ul>
        </details>
      )}
    </div>
  )
}

/** One symbol's callers, callees, and source. */
function SymbolPanel({ detail, t, onSelect }: { detail: Load<HardSymbolDetail>; t: FeatureMapProps['t']; onSelect: (symbol: string) => void }): ReactNode {
  if (detail.state === 'loading') return <div className={css.detail} role="status">{t('map.loading')}</div>
  if (detail.state === 'error') return <div className={css.detail}><span className={css.error} role="alert">{t('map.error', { message: detail.message })}</span></div>
  const { symbol, callers, callees, source } = detail.value
  const edgeList = (edges: HardSymbolDetail['callers'], end: 'caller' | 'callee') => (
    <ul>
      {edges.map(edge => (
        <li key={`${edge[end]}:${edge.file}:${edge.line ?? ''}`}>
          <button type="button" className={css.link} onClick={() => { onSelect(edge[end]) }}>{edge[end]}</button>
          <span className={css.meta}> {edge.file}:{edge.line ?? '?'} · {edge.source}</span>
        </li>
      ))}
    </ul>
  )
  return (
    <div className={css.detail} data-hard-symbol={symbol.id}>
      <strong>{symbol.id}</strong>
      <span className={css.meta}>{symbol.file}:{symbol.line ?? '?'}</span>
      <span>{t('map.callers', { count: callers.length })}</span>
      {edgeList(callers, 'caller')}
      <span>{t('map.callees', { count: callees.length })}</span>
      {edgeList(callees, 'callee')}
      <span>{t('map.source')}</span>
      {source === null ? <span className={css.meta}>{t('map.noSource')}</span> : (
        <>
          <pre className={css.source}>{source.lines.map((line, index) => `${String(source.startLine + index).padStart(5)}  ${line}`).join('\n')}</pre>
          {source.truncated ? <span className={css.meta}>{t('map.truncated', { count: source.lines.length })}</span> : null}
        </>
      )}
    </div>
  )
}
