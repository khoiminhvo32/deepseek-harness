/**
 * Session event vocabulary of the hard ledger, merged into
 * `SessionEventMap` so `hard/*` events persist as ordinary additive log
 * records. Every event is `ignorable`: losing one cannot affect how the
 * rest of a log reconstructs.
 * @module @deepseek-ai/dsh-experimental-hard-ledger
 */

import type {
  HardCoverageCellData,
  HardFindingProposedData,
  HardFindingVerdictData,
  HardGateDecisionData,
  HardHypothesisStateData,
  HardMissionArmedData,
  HardSweepSummaryData,
} from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Mission armed with the pinned target and the enumerated coverage
     * matrix axes; the mission plugin appends it once right after the goal
     * is created, and the ledger folds it into the coverage matrix.
     */
    'hard/mission/armed': HardMissionArmedData
    /**
     * A proposed finding awaiting verifier execution; the verifier owns the
     * matching `hard/finding/verdict`.
     */
    'hard/finding/proposed': HardFindingProposedData
    /** The verifier's executed outcome for one proposed finding. */
    'hard/finding/verdict': HardFindingVerdictData
    /** One hypothesis state transition in the deep-reading pass. */
    'hard/hypothesis/state': HardHypothesisStateData
    /** One coverage cell verdict for the systematic pass. */
    'hard/coverage/cell': HardCoverageCellData
    /**
     * One completed sweep pass summary; an empty sweep carries a verifiable
     * `emptyProof` reference the ledger checked at record time.
     */
    'hard/sweep/summary': HardSweepSummaryData
    /**
     * The harness's decision on one `update_goal action complete` attempt:
     * the stop gate appends one record per attempt, in both the allow and
     * the deny branch, so every completion stands on a recorded assessment.
     */
    'hard/gate/decision': HardGateDecisionData
  }
}
