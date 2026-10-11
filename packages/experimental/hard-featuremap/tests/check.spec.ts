/** The completeness check computes the reach and required set of a feature's handlers and refuses claims that leave
 * required symbols unaccounted for, hide guards or state writes, or reach outside the graph without a citation. */

import { describe, expect, it } from 'vitest'
import { checkFeature, requiredSet } from '@deepseek-ai/dsh-experimental-hard-featuremap'
import type { HardEntryPoint, HardFeatureClaim, HardFeatureGraph, HardFeaturePolicy } from '@deepseek-ai/dsh-experimental-hard-featuremap'

/**
 * save_handler → check_nonce (guard), update_title → write_meta (state write), esc (library, 50 callers) → deep
 * deep → deeper → deepest (beyond the depth); orphan is outside the reach; helper2 calls write_meta.
 */
const CALLS: Record<string, string[]> = {
  save_handler: ['check_nonce', 'update_title', 'esc'],
  update_title: ['write_meta', 'save_handler'],
  esc: ['inside_library'],
  check_nonce: [],
  write_meta: ['deep'],
  deep: ['deeper'],
  deeper: ['deepest'],
  orphan: [],
  helper2: ['write_meta'],
  wrapper: ['check_nonce'],
}
const FILES: Record<string, string> = { orphan_caller: 'caller.php' }
const ENTRIES: Record<string, HardEntryPoint> = {
  'ajax:save': { kind: 'ajax', key: 'save', handler: 'save_handler', file: 'a.php', line: 1, auth: 'authenticated', guards: [], checks: [] },
  'ajax:broken': { kind: 'ajax', key: 'broken', handler: null, file: 'a.php', line: 2, auth: 'authenticated', guards: [], checks: [] },
}

const graph: HardFeatureGraph = {
  symbol: id => id in CALLS || id in FILES ? { name: id.split('.').at(-1)!, file: FILES[id] ?? `${id}.php` } : undefined,
  callees: id => CALLS[id] ?? [],
  fanIn: id => id === 'esc' || id === 'deepest' ? 50 : 1,
  entryPoint: key => ENTRIES[key],
}

const policy: HardFeaturePolicy = {
  depth: 3,
  requiredDepth: 1,
  libraryFanIn: 40,
  maxExcludedPercent: 50,
  guards: new Set(['check_nonce']),
  mutations: new Set(['write_meta']),
}

const lines: Record<string, string> = { 'caller.php:7': '  orphan($id);', 'caller.php:8': '  other();' }
const lineText = (file: string, line: number): Promise<string | undefined> => Promise.resolve(lines[`${file}:${line}`])

const complete: HardFeatureClaim = {
  entryPoints: ['ajax:save'],
  symbols: [
    { symbol: 'save_handler', role: 'entry' },
    { symbol: 'check_nonce', role: 'guard' },
    { symbol: 'update_title', role: 'helper' },
    { symbol: 'write_meta', role: 'mutation' },
  ],
  excluded: [],
  via: [],
}

describe('requiredSet', () => {
  it('follows calls to the depth, stops at library symbols, and requires near symbols, guards, and state writes', () => {
    const set = requiredSet(graph, ['save_handler'], policy)
    expect([...set.reach]).toEqual([['save_handler', 0], ['check_nonce', 1], ['update_title', 1], ['esc', 1], ['write_meta', 2], ['deep', 3]])
    expect([...set.library]).toEqual(['esc'])
    expect([...set.required]).toEqual([
      ['save_handler', ['entry']],
      ['check_nonce', ['near', 'guard']],
      ['update_title', ['near']],
      ['write_meta', ['mutation']],
    ])
  })

  it('marks a library symbol at the reach boundary', () => {
    const set = requiredSet(graph, ['deep'], { ...policy, depth: 2 })
    expect([...set.library]).toEqual(['deepest'])
  })

  it('names an unknown symbol by its id', () => {
    const set = requiredSet({ ...graph, callees: () => ['ghost'] }, ['save_handler'], { ...policy, depth: 1, guards: new Set(['ghost']) })
    expect(set.required.get('ghost')).toEqual(['near', 'guard'])
  })
})

describe('checkFeature', () => {
  it('accepts a claim that accounts for every required symbol', async () => {
    expect(await checkFeature(graph, complete, policy, lineText)).toEqual({ shortfalls: [], reach: 6, required: 4 })
  })

  it('accepts exclusions with reasons within the excluded share', async () => {
    const claim = { ...complete, symbols: complete.symbols.filter(member => member.symbol !== 'update_title'), excluded: [{ symbol: 'update_title', reason: 'other-feature' as const }] }
    expect((await checkFeature(graph, claim, policy, lineText)).shortfalls).toEqual([])
  })

  it('lists every shortfall at once', async () => {
    const claim: HardFeatureClaim = {
      entryPoints: ['ajax:save', 'ajax:missing', 'ajax:broken'],
      symbols: [
        { symbol: 'save_handler', role: 'entry' },
        { symbol: 'nope', role: 'helper' },
        { symbol: 'update_title', role: 'helper' },
        { symbol: 'esc', role: 'guard' },
        { symbol: 'helper2', role: 'mutation' },
        { symbol: 'wrapper', role: 'guard' },
      ],
      excluded: [{ symbol: 'write_meta', reason: 'utility' }, { symbol: 'check_nonce', reason: 'unreachable' }],
      via: [],
    }
    expect((await checkFeature(graph, claim, { ...policy, maxExcludedPercent: 25 }, lineText)).shortfalls).toEqual([
      'entry point ajax:missing is not in the feature map; read the list with hard_query_map view entry-points',
      'entry point ajax:broken has no resolved handler; name its handler as a symbol with role entry',
      'symbols not in the feature map: nope; find ids with hard_query_map view symbol',
      'guards and state writes cannot be excluded as utility: write_meta',
      'the claim excludes 2 of 4 required symbols; at most 25% may be excluded',
      "helper2 is outside the reach of the feature's handlers; cite the call that reaches it in via (caller and line)",
      "wrapper is outside the reach of the feature's handlers; cite the call that reaches it in via (caller and line)",
      'esc has role guard but neither is nor calls a known access check',
    ])
  })

  it('names a missing required symbol and checks roles through the call graph, cycles included', async () => {
    const claim: HardFeatureClaim = {
      ...complete,
      symbols: [
        { symbol: 'save_handler', role: 'entry' },
        { symbol: 'check_nonce', role: 'mutation' },
        { symbol: 'write_meta', role: 'mutation' },
        { symbol: 'deep', role: 'helper' },
      ],
    }
    expect((await checkFeature(graph, claim, policy, lineText)).shortfalls).toEqual([
      '1 required symbols are neither members nor excluded: update_title (near)',
      'check_nonce has role mutation but neither is nor calls a known state write',
    ])
    const cyclic = { ...complete, symbols: complete.symbols.map(member => member.symbol === 'update_title' ? { ...member, role: 'guard' as const } : member) }
    expect((await checkFeature(graph, cyclic, policy, lineText)).shortfalls).toEqual([])
  })

  it('lists the first twenty missing symbols and counts the rest', async () => {
    const many = Array.from({ length: 25 }, (_, n) => `f${n}`)
    const wide: HardFeatureGraph = {
      symbol: id => ({ name: id, file: 'x.php' }),
      callees: id => id === 'root' ? many : [],
      fanIn: () => 1,
      entryPoint: () => undefined,
    }
    const result = await checkFeature(wide, { entryPoints: [], symbols: [{ symbol: 'root', role: 'entry' }], excluded: [], via: [] }, policy, lineText)
    expect(result.shortfalls[0]).toMatch(/^25 required symbols are neither members nor excluded: f0 \(near\); .* f19 \(near\) and 5 more$/)
  })

  it('needs at least one handler', async () => {
    expect(await checkFeature(graph, { entryPoints: [], symbols: [{ symbol: 'nope', role: 'entry' }], excluded: [], via: [] }, policy, lineText)).toEqual({
      shortfalls: ['symbols not in the feature map: nope; find ids with hard_query_map view symbol', 'a feature needs at least one entry point with a handler or one symbol with role entry'],
      reach: 0,
      required: 0,
    })
  })

  it('checks the citation of a member outside the reach', async () => {
    const outside = (via: HardFeatureClaim['via']): HardFeatureClaim => ({ ...complete, symbols: [...complete.symbols, { symbol: 'orphan', role: 'helper' }], via })
    const shortfalls = async (via: HardFeatureClaim['via']): Promise<readonly string[]> => (await checkFeature(graph, outside(via), policy, lineText)).shortfalls
    expect(await shortfalls([{ symbol: 'orphan', caller: 'save_handler', line: 7 }])).toEqual(['the via line save_handler.php:7 for orphan does not exist at the pinned commit'])
    expect(await shortfalls([{ symbol: 'orphan', caller: 'stranger', line: 7 }])).toEqual(['the via caller stranger of orphan is neither reached nor a member'])
    expect(await shortfalls([{ symbol: 'orphan', caller: 'helper2', line: 7 }])).toEqual(['the via caller helper2 of orphan is neither reached nor a member'])
    const withCaller = { ...outside([{ symbol: 'orphan', caller: 'orphan_caller', line: 7 }]) }
    withCaller.symbols = [...withCaller.symbols, { symbol: 'orphan_caller', role: 'helper' }]
    const callerGraph: HardFeatureGraph = { ...graph, callees: id => id === 'save_handler' ? [...CALLS['save_handler']!, 'orphan_caller'] : CALLS[id] ?? [] }
    expect((await checkFeature(callerGraph, withCaller, policy, lineText)).shortfalls).toEqual([])
    const wrongLine = { ...withCaller, via: [{ symbol: 'orphan', caller: 'orphan_caller', line: 8 }] }
    expect((await checkFeature(callerGraph, wrongLine, policy, lineText)).shortfalls).toEqual(['the via line caller.php:8 does not mention orphan'])
    const ghostCaller = { ...withCaller, symbols: [...withCaller.symbols, { symbol: 'ghost_caller', role: 'helper' as const }], via: [{ symbol: 'orphan', caller: 'ghost_caller', line: 7 }] }
    expect((await checkFeature(callerGraph, ghostCaller, policy, lineText)).shortfalls).toContain('the via caller ghost_caller of orphan is not in the feature map')
  })
})
