import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'
import { CoverageMatrix } from '../src/client/CoverageMatrix.tsx'
import { FeatureMap } from '../src/client/FeatureMap.tsx'
import { en, NS, zh } from '../src/client/locales.ts'

describe('registerHardUi', () => {
  it('registers the dictionaries, both tab types, and both keyed bodies through disposable effects', () => {
    const effects: string[] = []
    type Tab = { kind: string; title: () => string; guide: { title: () => string; description: () => string }[] }
    const tabs: Tab[] = []
    const bodies: { key: string; component: unknown; shares: object }[] = []
    const locale = { register: vi.fn(() => () => {}), bind: () => (key: string) => `t:${key}` }
    const ctx = {
      effect: (run: () => () => void, label: string) => {
        effects.push(label)
        run()
      },
      locale,
      sidebarRightTabs: {
        register: (definition: Tab) => {
          tabs.push(definition)
          return () => {}
        },
      },
      slots: {
        inject: (_name: string, run: () => void) => {
          run()
        },
        register: (seat: { key: string; inject: () => object }, component: unknown) => {
          bodies.push({ key: seat.key, component, shares: seat.inject() })
          return () => {}
        },
      },
    } as never as ClientContext
    apply(ctx)
    expect(locale.register).toHaveBeenCalledWith(NS, { zh, en })
    expect(effects).toEqual(['client-ui-hard: dictionaries', 'client-ui-hard: sidebar tab', 'client-ui-hard: feature map tab'])
    expect(tabs.map(tab => [tab.kind, tab.title(), tab.guide[0]?.title(), tab.guide[0]?.description()])).toEqual([
      ['hard-coverage', 't:tab.title', 't:guide.title', 't:guide.description'],
      ['hard-feature-map', 't:map.tab.title', 't:map.guide.title', 't:map.guide.description'],
    ])
    expect(bodies).toEqual([
      { key: '@deepseek-ai/dsh-experimental-client-ui-hard/coverage', component: CoverageMatrix, shares: { hooks: {} } },
      { key: '@deepseek-ai/dsh-experimental-client-ui-hard/feature-map', component: FeatureMap, shares: { hooks: {} } },
    ])
  })
})
