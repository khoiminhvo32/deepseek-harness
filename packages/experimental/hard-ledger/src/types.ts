/**
 * Durable vocabulary of the hard-harness ledger: findings, hypotheses,
 * coverage cells, and sweep summaries recorded as typed `hard/*` session
 * events. The session log is the single source of truth; the ledger service
 * folds these events, never a parallel store.
 * @module @deepseek-ai/dsh-experimental-hard-ledger
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity of one proposed finding, `F-<n>`. */
export type HardFindingId = Branded<'HardFindingId'>

/** Opaque identity of one hypothesis, `H-<n>`. */
export type HardHypothesisId = Branded<'HardHypothesisId'>

/** Verification outcome of one finding, decided by the verifier only. */
export type HardVerdict = 'confirmed' | 'refuted' | 'flaky'

/** Hypothesis lifecycle status in the deep-reading pass. */
export type HardHypothesisStatus = 'proposed' | 'testing' | 'confirmed' | 'refuted' | 'deferred'

/** Verdict a model may declare for one coverage cell. */
export type HardCoverageVerdict = 'cleared' | 'suspicious' | 'uncovered'

/** One proposed finding, appended before verification runs. */
export interface HardFindingProposedData {
  readonly id: HardFindingId
  readonly title: string
  readonly bugClass: string
  /** Target component, module, or file the claim is about. */
  readonly component: string
  /** The claimed vulnerability, stated concretely enough to test. */
  readonly claim: string
  /** CVSS vector string, `CVSS:4.0/...`. */
  readonly cvssVector: string
  /** The score the model claims for its own vector; verifier recomputes. */
  readonly cvssClaimed: number
  /** Repository-relative path of the PoC the verifier must execute. */
  readonly pocPath: string
  /** Deterministic proof-of-effect hash the PoC must print on success. */
  readonly claimHash: string
  /** Root-cause dedup key over component, symbol, and bug class. */
  readonly fingerprint: string
  readonly hypothesisId?: HardHypothesisId
}

/** One verifier-decided outcome, appended after the PoC runs settle. */
export interface HardFindingVerdictData {
  readonly id: HardFindingId
  readonly verdict: HardVerdict
  /** Number of PoC runs the verdict rests on. */
  readonly runs: number
  /** Score recomputed deterministically from the proposed vector. */
  readonly cvssComputed: number
  /** Whether the model's claimed score matched the recomputed one. */
  readonly cvssMatch: boolean
  /** Concrete failure or confirmation story, bounded length. */
  readonly reason: string
  readonly fingerprint: string
}

/** One hypothesis state transition, appended by the hypothesis tool. */
export interface HardHypothesisStateData {
  readonly id: HardHypothesisId
  readonly statement: string
  readonly status: HardHypothesisStatus
  /** Required for `refuted` and `deferred`: the concrete evidence or retry condition. */
  readonly reason?: string
}

/** One coverage cell verdict for the systematic pass. */
export interface HardCoverageCellData {
  /** Module or directory swept, relative to the target repository root. */
  readonly module: string
  readonly bugClass: string
  readonly verdict: HardCoverageVerdict
  /** Sink sites the model declares it inspected for this cell. */
  readonly declaredSinks: readonly string[]
}

/** One completed sweep pass summary; purely informational. */
export interface HardSweepSummaryData {
  readonly phase: 'A' | 'B'
  readonly cellsTouched: number
  readonly newFindings: number
  /** Required for an empty sweep: the refuted hypothesis or cleared cell evidence. */
  readonly emptyProof?: string
}

/** Mission arming record: the pinned target and the coverage matrix axes. */
export interface HardMissionArmedData {
  /** The durable objective the armed goal carries. */
  readonly objective: string
  /** Absolute path of the target repository the modules enumerate. */
  readonly targetRepo: string
  /** Full commit sha the enumeration pinned at arm time, never a ref. */
  readonly commit: string
  /** Sorted, deduplicated module names — the coverage matrix rows. */
  readonly modules: readonly string[]
  /** Bug class names swept in the systematic pass — the coverage matrix columns. */
  readonly bugClasses: readonly string[]
}
