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
  HardFeatureData,
  HardFeatureLinkData,
  HardFeatureMapIndexedData,
  HardFlawData,
  HardFlowDocData,
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
    /**
     * One recorded weakness kept as chaining material, with every site
     * already resolved at the pinned commit; the ledger folds it into the
     * weakness list chain hypotheses link.
     */
    'hard/flaw/recorded': HardFlawData
    /**
     * The entry points of the feature map indexed for the pinned commit; the
     * ledger folds the latest one as the set features must cover.
     */
    'hard/featuremap/indexed': HardFeatureMapIndexedData
    /**
     * One feature the harness checked against the feature map; recording an
     * existing id revises it, and the ledger folds the latest per id.
     */
    'hard/feature/recorded': HardFeatureData
    /** One relation between two recorded features. */
    'hard/feature/linked': HardFeatureLinkData
    /**
     * One flow document recorded for a module, with every citation already
     * resolved against the pinned commit; the ledger folds it as the durable
     * Phase B record. Counts only — the prose lives in the tool result.
     */
    'hard/flow/doc': HardFlowDocData
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
