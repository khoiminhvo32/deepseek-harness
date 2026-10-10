// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { HardLedgerClientView } from '@deepseek-ai/dsh-experimental-hard-ledger/client'
import type { HardFeatureGraphView, HardSymbolDetail } from '@deepseek-ai/dsh-experimental-hard-featuremap/client'
import { FEATURE_GRAPH_PATH, SYMBOL_DETAIL_PATH } from '../../hard-featuremap/src/routes.ts'
import { FeatureMap } from '../src/client/FeatureMap.tsx'
import { FEATURE_GRAPH_ROUTE, SYMBOL_DETAIL_ROUTE, featureLayout, overviewLayout, type FeatureMapView } from '../src/client/feature-layout.ts'
// The locale-namespace merge for `hard` lives beside the registrations.
import type {} from '../src/client/mount.ts'
import { panelProps, SESSION } from './panel-props.client.ts'

beforeAll(() => {
  // React Flow measures its viewport and nodes; jsdom has no layout.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.useRealTimers()
})

const FEATURE = {
  id: 'FE-1', name: 'Save a post', summary: 'An editor saves a post.', entryPoints: ['ajax:save'],
  symbols: [{ symbol: 'wp_ajax_save', role: 'entry' as const }], excluded: 1,
  states: [{ kind: 'meta', key: 'postmeta', access: 'write' as const }], reach: 4, required: 3,
}

const MAP: FeatureMapView = {
  commit: 'c'.repeat(40),
  entryPoints: [{ key: 'ajax:save', handler: 'wp_ajax_save', mapped: true }, { key: 'script:x.php', handler: null, mapped: false }],
  features: [FEATURE],
  links: [],
}

const GRAPH: HardFeatureGraphView = {
  feature: 'FE-1',
  nodes: [
    { id: 'wp_ajax_save', name: 'wp_ajax_save', role: 'entry', file: 'ajax.php', line: 2 },
    { id: 'save_post', name: 'save_post', role: 'helper', file: 'post.php', line: null },
    { id: 'esc_html', name: 'esc_html', role: 'excluded', file: null, line: null },
    { id: 'orphan', name: 'orphan', role: 'helper', file: 'o.php', line: 1 },
  ],
  edges: [{ from: 'wp_ajax_save', to: 'save_post', source: 'joern' }, { from: 'save_post', to: 'esc_html', source: 'hook' }],
}

const DETAIL: HardSymbolDetail = {
  symbol: { id: 'save_post', name: 'save_post', kind: 'function', owner: null, file: 'post.php', line: 10, end: 12 },
  callers: [{ caller: 'wp_ajax_save', callee: 'save_post', file: 'ajax.php', line: 4, source: 'joern' }],
  callees: [{ caller: 'save_post', callee: 'esc_html', file: 'post.php', line: null, source: 'repair' }],
  source: { startLine: 10, lines: ['function save_post() {', '}'], truncated: true },
}

function ledger(featureMap: FeatureMapView | undefined): HardLedgerClientView {
  return {
    cells: [], progress: { verdicted: 0, total: 0 }, bySource: { model: 0, modelVerified: 0, harness: 0 },
    blindClears: 0, gate: { complete: false, blockers: [] }, ...featureMap === undefined ? {} : { featureMap },
  }
}

/** A fetch stub answering each route from a table keyed by route and value. */
function stubFetch(table: Record<string, { status: number; body: unknown }>) {
  const fetch = vi.fn((input: string) => {
    const url = new URL(input, 'http://host/')
    const key = `${url.pathname.slice(1)}:${url.searchParams.get('feature') ?? url.searchParams.get('symbol') ?? ''}`
    const answer = table[key]
    if (answer === undefined) return Promise.reject(new Error(`unexpected ${key}`))
    expect(url.searchParams.get('session')).toBe(SESSION)
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }))
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('feature map layouts', () => {
  it('fetch the Host routes the hard-featuremap plugin registers', () => {
    expect(`/${FEATURE_GRAPH_ROUTE}`).toBe(FEATURE_GRAPH_PATH)
    expect(`/${SYMBOL_DETAIL_ROUTE}`).toBe(SYMBOL_DETAIL_PATH)
  })

  it('keep drawn nodes in place when features and links arrive', () => {
    const before = overviewLayout(MAP)
    const after = overviewLayout({
      ...MAP,
      entryPoints: MAP.entryPoints.map(entry => ({ ...entry, mapped: true })),
      features: [FEATURE, { ...FEATURE, id: 'FE-2', name: 'Trash', entryPoints: ['script:x.php', 'ajax:save'] }],
      links: [{ from: 'FE-1', to: 'FE-2', kind: 'shares-state', note: 'n' }],
    })
    expect(after.nodes.slice(0, 3).map(node => [node.id, node.x, node.y])).toEqual(before.nodes.map(node => [node.id, node.x, node.y]))
    // One column per entry kind in index order, unmapped entry points included; features after the last kind.
    expect(before.nodes.map(node => [node.id, node.x, node.y, node.detail, node.mapped])).toEqual([
      ['entry:ajax:save', 0, 0, 'wp_ajax_save', true], ['entry:script:x.php', 300, 0, '', false],
      ['feature:FE-1', 750, 0, 'An editor saves a post.', undefined],
    ])
    expect(after.nodes.at(-1)).toMatchObject({ id: 'feature:FE-2', x: 750, y: 64 })
    expect(after.edges.map(edge => [edge.from, edge.to, edge.kind, edge.label])).toEqual([
      ['entry:ajax:save', 'feature:FE-1', 'member', undefined],
      ['entry:script:x.php', 'feature:FE-2', 'member', undefined],
      ['entry:ajax:save', 'feature:FE-2', 'member', undefined],
      ['feature:FE-1', 'feature:FE-2', 'link', 'shares-state'],
    ])
    const sameKind = overviewLayout({ ...MAP, entryPoints: [{ key: 'nokind', handler: null, mapped: false }, { key: 'other', handler: null, mapped: false }] })
    expect(sameKind.nodes.slice(0, 2).map(node => [node.x, node.y])).toEqual([[0, 0], [0, 64]])
  })

  it('layer a feature graph by call distance and park excluded and unreached symbols last', () => {
    const layout = featureLayout(GRAPH)
    expect(layout.nodes.map(node => [node.id, node.x, node.y, node.detail])).toEqual([
      ['wp_ajax_save', 0, 0, 'ajax.php:2'], ['save_post', 300, 0, 'post.php'], ['esc_html', 900, 0, ''], ['orphan', 900, 64, 'o.php:1'],
    ])
    expect(layout.edges.map(edge => edge.kind)).toEqual(['joern', 'hook'])
    expect(featureLayout({ feature: 'FE-1', nodes: [], edges: [] }).nodes).toEqual([])
  })
})

describe('FeatureMap', () => {
  it('waits for the indexed map', () => {
    render(<FeatureMap {...panelProps({ state: 'ready', view: ledger(undefined) }).props} />)
    expect(screen.getByRole('status').textContent).toContain('功能地图尚未建立索引')
  })

  it('shows the totals, the features, the unmapped entry points, and the overview graph', () => {
    const { container } = render(<FeatureMap {...panelProps({ state: 'ready', view: ledger(MAP) }).props} />)
    expect(screen.getByText('1 个功能 · 已映射 1/2 个入口点 · 0 条关系')).toBeTruthy()
    expect(screen.getByText('未映射的入口点（1）')).toBeTruthy()
    expect(container.querySelector('.react-flow__node[data-id="feature:FE-1"]')?.textContent).toContain('FE-1 Save a post')
    expect(container.querySelector('.react-flow__node[data-id="entry:ajax:save"]')).not.toBeNull()
    expect(container.querySelector('.react-flow__node[data-id="entry:script:x.php"]')?.className).toContain('entryUnmapped')
  })

  it('opens a feature\'s symbol graph and a symbol\'s detail from the Host routes', async () => {
    const fetch = stubFetch({
      'api/hard-featuremap.feature:FE-1': { status: 200, body: GRAPH },
      'api/hard-featuremap.symbol:save_post': { status: 200, body: DETAIL },
      'api/hard-featuremap.symbol:esc_html': { status: 200, body: { ...DETAIL, symbol: { ...DETAIL.symbol, id: 'esc_html', line: null }, source: null } },
      'api/hard-featuremap.symbol:orphan': { status: 200, body: { ...DETAIL, symbol: { ...DETAIL.symbol, id: 'orphan' }, source: { ...DETAIL.source, truncated: false } } },
      'api/hard-featuremap.symbol:wp_ajax_save': { status: 500, body: {} },
    })
    const { container } = render(<FeatureMap {...panelProps({ state: 'ready', view: ledger(MAP) }).props} />)
    fireEvent.click(screen.getByText('FE-1 Save a post', { selector: 'button' }))
    expect(screen.getByText('正在加载…')).toBeTruthy()
    await waitFor(() => {
      expect(container.querySelector('.react-flow__node[data-id="save_post"]')).not.toBeNull()
    })
    expect(screen.getByText('可达 4 · 必需 3 · 排除 1')).toBeTruthy()
    expect(screen.getByText('状态: write meta:postmeta')).toBeTruthy()
    expect(container.querySelector('.react-flow__node[data-id="esc_html"]')?.textContent).toContain('已排除')

    const node = container.querySelector('.react-flow__node[data-id="save_post"]')
    if (node === null) throw new Error('no save_post node')
    fireEvent.click(node)
    await waitFor(() => {
      expect(container.querySelector('[data-hard-symbol="save_post"]')).not.toBeNull()
    })
    expect(screen.getByText('调用方（1）')).toBeTruthy()
    expect(container.querySelector('pre')?.textContent).toBe('   10  function save_post() {\n   11  }')
    expect(screen.getByText('源码在 2 行处截断')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'esc_html' }))
    await waitFor(() => {
      expect(container.querySelector('[data-hard-symbol="esc_html"]')?.textContent).toContain('post.php:?')
    })
    expect(screen.getByText('无法读取源码')).toBeTruthy()
    fireEvent.click(container.querySelector('.react-flow__node[data-id="orphan"]') ?? document.body)
    await waitFor(() => {
      expect(container.querySelector('[data-hard-symbol="orphan"]')).not.toBeNull()
    })
    expect(screen.queryByText('源码在 2 行处截断')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'wp_ajax_save' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('无法加载：500')
    })
    fireEvent.click(container.querySelector('.react-flow__node[data-id="save_post"]') ?? document.body)
    await waitFor(() => {
      expect(container.querySelector('[data-hard-symbol="save_post"]')).not.toBeNull()
    })
    expect(fetch).toHaveBeenCalledTimes(6)

    fireEvent.click(screen.getByText('全部功能'))
    expect(container.querySelector('.react-flow__node[data-id="feature:FE-1"]')).not.toBeNull()
    expect(container.querySelector('[data-hard-symbol]')).toBeNull()
  })

  it('opens a feature from its overview node and refetches when the feature is revised', async () => {
    const fetch = stubFetch({ 'api/hard-featuremap.feature:FE-1': { status: 200, body: GRAPH } })
    const { props, publish } = panelProps({ state: 'ready', view: ledger(MAP) })
    const { container } = render(<FeatureMap {...props} />)
    fireEvent.click(container.querySelector('.react-flow__node[data-id="entry:ajax:save"]') ?? document.body)
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(container.querySelector('.react-flow__node[data-id="feature:FE-1"]') ?? document.body)
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })
    act(() => {
      publish(ledger({ ...MAP, features: [{ ...FEATURE, reach: 5 }] }))
    })
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2)
    })
    fireEvent.click(screen.getByText('FE-1 Save a post', { selector: 'button' }))
    expect(container.querySelector('.react-flow__node[data-id="feature:FE-1"]')).not.toBeNull()
  })

  it('omits empty sections and draws feature links', () => {
    const { container } = render(<FeatureMap {...panelProps({ state: 'ready', view: ledger({
      ...MAP,
      entryPoints: [MAP.entryPoints[0]!],
      features: [{ ...FEATURE, states: [] }, { ...FEATURE, id: 'FE-2', states: [] }],
      links: [{ from: 'FE-1', to: 'FE-2', kind: 'gates', note: 'n' }],
    }) }).props} />)
    expect(screen.queryByText(/未映射的入口点/)).toBeNull()
    // jsdom measures no node, so React Flow draws no edge; the summary counts the link.
    expect(screen.getByText('2 个功能 · 已映射 1/1 个入口点 · 1 条关系')).toBeTruthy()
    expect(container.querySelector('.react-flow__node[data-id="feature:FE-2"]')).not.toBeNull()
    fireEvent.click(screen.getByText('FE-2 Save a post', { selector: 'button' }))
    expect(screen.queryByText(/^状态/)).toBeNull()
  })

  it('drops a fetch answer that arrives after the selection moved on', async () => {
    const pending: { resolve: (response: Response) => void; reject: (error: Error) => void }[] = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }))))
    render(<FeatureMap {...panelProps({ state: 'ready', view: ledger(MAP) }).props} />)
    const chip = screen.getByText('FE-1 Save a post', { selector: 'button' })
    fireEvent.click(chip)
    fireEvent.click(chip)
    fireEvent.click(chip)
    fireEvent.click(chip)
    await act(async () => {
      pending[0]?.resolve(new Response(JSON.stringify(GRAPH)))
      pending[1]?.reject(new Error('late'))
      await Promise.resolve()
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('正在加载…')).toBeNull()
  })

  it('reports a failed graph fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    render(<FeatureMap {...panelProps({ state: 'ready', view: ledger(MAP) }).props} />)
    fireEvent.click(screen.getByText('FE-1 Save a post', { selector: 'button' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('无法加载：Error: offline')
    })
  })

  it('marks features that arrive while the panel is open, then clears the mark', () => {
    vi.useFakeTimers()
    const { props, publish } = panelProps({ state: 'ready', view: ledger(MAP) })
    const { container } = render(<FeatureMap {...props} />)
    expect(screen.queryByText('新')).toBeNull()
    act(() => {
      publish(ledger({ ...MAP, features: [FEATURE, { ...FEATURE, id: 'FE-2', name: 'Trash' }] }))
    })
    expect(container.querySelector('.react-flow__node[data-id="feature:FE-2"]')?.textContent).toContain('新')
    expect(screen.getByText('FE-2 Trash', { selector: 'button' }).className).toContain('fresh')
    act(() => {
      publish(ledger({ ...MAP, features: [FEATURE, { ...FEATURE, id: 'FE-2', name: 'Trash', summary: 'revised' }] }))
    })
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.queryByText('新')).toBeNull()
  })
})
