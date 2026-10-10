/** Source-safe hard-harness browser registration. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// ctx.slots lives on the renderer's Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { CoverageMatrix } from './CoverageMatrix.tsx'
import { FeatureMap } from './FeatureMap.tsx'
import { en, NS, zh, type HardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Hard-harness coverage panel copy. */
    hard: HardKey
  }
}

/** Required browser services: the tab registry, slots, and localized copy. */
export const inject = ['sessions', 'slots', 'locale', 'sidebarRightTabs']

/** Stage one: the coverage page's static face — a guide doorway, opened by kind. */
/**
 * Build the coverage tab type's registry definition.
 * @param t - namespace-bound translate, read fresh on every title call.
 * @returns the definition to register, with its guide capsule.
 */
export function coverageDefinition(t: TranslateNS<typeof NS>): SidebarRightTabDefinition {
  return {
    id: '@deepseek-ai/dsh-experimental-client-ui-hard/coverage',
    kind: 'hard-coverage',
    priority: 'extension',
    title: () => t('tab.title'),
    guide: [{
      id: 'coverage',
      order: 40,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
    }],
  }
}

/** Registry id and slot key of the feature map tab. */
const FEATURE_MAP_TAB = '@deepseek-ai/dsh-experimental-client-ui-hard/feature-map'

/**
 * Build the feature map tab type's registry definition.
 * @param t - namespace-bound translate, read fresh on every title call.
 * @returns the definition to register, with its guide capsule.
 */
export function featureMapDefinition(t: TranslateNS<typeof NS>): SidebarRightTabDefinition {
  return {
    id: FEATURE_MAP_TAB,
    kind: 'hard-feature-map',
    priority: 'extension',
    title: () => t('map.tab.title'),
    guide: [{
      id: 'feature-map',
      order: 41,
      title: () => t('map.guide.title'),
      description: () => t('map.guide.description'),
    }],
  }
}

/**
 * Register the hard-harness locale dictionaries, the coverage and feature map
 * tab types (each guide capsule is a doorway), and their keyed tab bodies. The bodies read the
 * Session's `hardLedger` projection from the shared Session store; the
 * feature map body also fetches symbol graphs from the hard-featuremap Host
 * routes. This registration performs no ledger RPC.
 * @param ctx - Client Context carrying the injected registry, slot, and locale services.
 */
export function registerHardUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-hard: dictionaries')
  const t = ctx.locale.bind(NS)
  const id = '@deepseek-ai/dsh-experimental-client-ui-hard/coverage'
  ctx.effect(() => ctx.sidebarRightTabs.register(coverageDefinition(t)), 'client-ui-hard: sidebar tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: id, locale: NS,
    inject: () => ({ hooks: {} }),
  }, CoverageMatrix))
  ctx.effect(() => ctx.sidebarRightTabs.register(featureMapDefinition(t)), 'client-ui-hard: feature map tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: FEATURE_MAP_TAB, locale: NS,
    inject: () => ({ hooks: {} }),
  }, FeatureMap))
}
