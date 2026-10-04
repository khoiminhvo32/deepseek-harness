/**
 * Pure wake-time resolution for the hard standby: the provider's requested
 * delay wins, a configured reset cron names the next window, and the standby
 * cap bounds every wait. The cap doubles as the last-resort cadence when
 * neither the provider nor configuration names a reset time, so the mission
 * keeps retrying on a bounded rhythm instead of stalling silently.
 * @module
 */

import { cronNextMatch, parseCron } from './cron.ts'

/** Inputs for one wake-time resolution. */
export interface ResolveWakeAtInput {
  /** Epoch milliseconds of the failure. */
  readonly now: number
  /** Provider-requested delay in milliseconds, when valid and available. */
  readonly providerRetryAfterMs?: number
  /** Five-field UTC reset cron, when configured. */
  readonly cron?: string | undefined
  /** Upper bound of any wait in milliseconds; also the last-resort delay. */
  readonly maxStandbyMs: number
}

/**
 * Resolve when a standby should wake.
 * @param input - failure time, provider delay, configured reset cron, and the wait cap.
 * @returns the wake epoch in milliseconds, never later than `now + maxStandbyMs`.
 */
export function resolveWakeAt(input: ResolveWakeAtInput): number {
  const cap = input.now + input.maxStandbyMs
  const retryAfter = input.providerRetryAfterMs
  if (retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(input.now + retryAfter, cap)
  }
  if (input.cron !== undefined) return Math.min(cronNextMatch(parseCron(input.cron), input.now), cap)
  return cap
}
