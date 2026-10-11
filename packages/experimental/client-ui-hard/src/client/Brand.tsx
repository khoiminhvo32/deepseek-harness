/** The Meebard Harness product name in the sidebar brand slot, shown while the hard bundle is mounted. */
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import css from './Brand.module.css'

/** Props of the brand name: the slot's locale share. */
export type MeebardBrandNameProps = PropsLocale<typeof NS>

/**
 * The product name in place of the local-build fallback.
 * @param props - the locale share.
 * @returns the name.
 */
export function MeebardBrandName({ t }: MeebardBrandNameProps): ReactNode {
  return <span className={css.name}>{t('brand.name')}</span>
}
