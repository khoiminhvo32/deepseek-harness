/**
 * Session event vocabulary of the hard standby: scheduled quota waits and
 * their wakes, merged into `SessionEventMap` so the standby state machine
 * persists as ordinary additive log records and survives restarts. Every
 * event is reconstructable; losing one cannot affect how the rest of a log
 * reconstructs.
 * @module @deepseek-ai/dsh-experimental-hard-standby
 */

/** Why the session entered standby. */
export type HardStandbyReason = 'quota' | 'outage'

/** One scheduled standby wait, appended when a terminal quota failure arrives. */
export interface HardStandbyScheduledData {
  readonly reason: HardStandbyReason
  /** Epoch milliseconds when the session wakes and continues the mission. */
  readonly wakeAt: number
  /** The provider-neutral failure code that triggered the wait. */
  readonly providerCode: string
  /** Provider-requested delay the wake time was derived from, when present. */
  readonly providerRetryAfterMs?: number
}

/** One wake attempt closing a scheduled standby, appended when the timer fires. */
export interface HardStandbyWokeData {
  /** Epoch milliseconds of the wake attempt. */
  readonly at: number
  /** Whether a continuation follow-up was delivered to a live armed goal. */
  readonly delivered: boolean
  /** Why no follow-up was delivered, bounded length. */
  readonly skip?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A scheduled wait entered after a terminal quota failure; the standby
     * owns the matching `hard/standby/woke` when the wake time arrives.
     */
    'hard/standby/scheduled': HardStandbyScheduledData
    /** One wake attempt closing the scheduled wait. */
    'hard/standby/woke': HardStandbyWokeData
  }
}
