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

/** One turn stopped at the per-turn step cap, appended at the pre-step boundary. */
export interface HardStepCapReachedData {
  /** The turn that was stopped. */
  readonly turn: number
  /** Model steps that had run when the cap stopped the turn. */
  readonly steps: number
  /** The per-turn cap that was applied. */
  readonly limit: number
  /** The running round, absent when the turn belongs to no admitted round. */
  readonly round?: number
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
    /**
     * One turn stopped at the per-turn step cap, appended in both round and
     * roundless turns; the cost cap's durable record.
     */
    'hard/step-cap/reached': HardStepCapReachedData
  }
}
