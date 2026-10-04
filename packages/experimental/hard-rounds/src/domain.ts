/**
 * Session event vocabulary of the hard round driver: one start per admitted
 * goal round and one end per closing turn, merged into `SessionEventMap` so
 * round accounting persists as ordinary additive log records. Every event is
 * reconstructable; losing one cannot affect how the rest of a log
 * reconstructs.
 * @module @deepseek-ai/dsh-experimental-hard-rounds
 */

/** Which methodology pass a round belongs to. */
export type HardRoundPhase = 'A' | 'B'

/** One admitted goal round, appended when its round message enters history. */
export interface HardRoundStartData {
  /** The admitted round number, matching the goal's admitted count. */
  readonly round: number
  /** The methodology pass this round belongs to under the A/B rotation. */
  readonly phase: HardRoundPhase
  /** Open-work items the ledger reported at round start. */
  readonly openWorkCount: number
}

/** One closing turn of a round, appended when the turn ends. */
export interface HardRoundEndData {
  /** The round whose turn closed. */
  readonly round: number
  /** Model steps the round's turn consumed. */
  readonly steps: number
  /** Whether the turn closed naturally or was cancelled at the step cap. */
  readonly reason: 'closed' | 'step-cap'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One admitted goal round of the hard mission; the driver owns the
     * matching `hard/round/end` when the round's turn closes.
     */
    'hard/round/start': HardRoundStartData
    /** One closing turn of a hard round. */
    'hard/round/end': HardRoundEndData
  }
}
