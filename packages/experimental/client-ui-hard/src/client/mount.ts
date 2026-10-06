/** Source-safe hard-harness browser registration. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// ctx.slots lives on the renderer's Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { CoverageMatrix } from './CoverageMatrix.tsx'
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

/**
 * Register the hard-harness locale dictionaries, the coverage tab type (its
 * guide capsule is the doorway), and the keyed tab body. The body reads the
 * Session's `hardLedger` projection from the shared Session store; this
 * registration performs no ledger RPC.
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
}
