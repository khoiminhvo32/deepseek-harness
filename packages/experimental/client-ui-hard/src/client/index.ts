/** Browser entry registering the hard-harness coverage panel. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { registerHardUi } from './mount.ts'

export { inject } from './mount.ts'
export type { CoverageMatrixProps } from './CoverageMatrix.tsx'
export type { HardKey } from './locales.ts'

/**
 * Register the hard-harness locale dictionaries and the coverage tab on the Client Context.
 * @param ctx - Client Context with the declared `inject` services available.
 */
export function apply(ctx: ClientContext): void {
  registerHardUi(ctx)
}
