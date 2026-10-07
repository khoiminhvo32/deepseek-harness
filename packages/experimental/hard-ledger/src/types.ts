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

/**
 * Who decided one coverage cell's verdict. Absent means `model` — the
 * historical behavior — so older logs read back with unchanged meaning.
 * `model-verified` marks a batch clear the harness grep confirmed. `harness`
 * names both ways the harness concludes without the model: a re-open, where
 * the harness appends a suspicious verdict over a model decision it audited
 * (an event-backed cell), and the mechanical inert-module screen (a cell
 * with no event — the module was pre-screened as carrying no code). The two
 * share the source because both are harness conclusions; a reader that must
 * tell them apart uses the presence of an event, never the source value.
 */
export type HardCoverageSource = 'model' | 'model-verified' | 'harness'

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
  /**
   * The exploit input the PoC takes as its first argument. The verifier
   * re-runs the same PoC with a benign payload and requires it to fail, so a
   * proof that passes regardless of input proves nothing about the input
   * (the specificity check). Optional only so older logs read back unchanged;
   * the service input type `HardFindingRequest` requires it at compile time.
   */
  readonly payload?: string
  readonly hypothesisId?: HardHypothesisId
}

/**
 * What a caller supplies to `proposeFinding`: the proposed fields without the
 * assigned id, and with the payload required — the verifier re-runs the PoC
 * with it (the specificity check), so a proposal without an exploit input is
 * unverifiable. `HardFindingProposedData` keeps `payload` optional only so
 * older persisted logs read back unchanged.
 */
export type HardFindingRequest = Omit<HardFindingProposedData, 'id' | 'payload'> & {
  /** The exploit input the PoC takes as its first argument. */
  readonly payload: string
}

/** The outcome of the verifier's benign-payload arm of one PoC. */
export type HardBenignArmResult = 'passed' | 'failed'

/**
 * Why a verdict settled, as an aggregable code. Reading groups:
 * `benign-arm-passed` and `no-marker` mean the model has not internalized the
 * proof contract (the harness taught it poorly); `nonzero-exit` means the
 * exploit did not happen, which a clean target also produces; `timeout`,
 * `aborted`, and `no-runs` are infrastructure and support no conclusion.
 */
export type HardFindingCause =
  | 'benign-arm-passed'
  | 'no-marker'
  | 'nonzero-exit'
  | 'timeout'
  | 'aborted'
  | 'no-runs'

/** How strong the executed proof behind a verdict is. */
export type HardFindingEvidence = 'demonstrated' | 'proven'

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
  /**
   * How the benign-payload arm settled. Absent on older logs, which never ran
   * the control: `passed` means the same PoC satisfied the contract with a
   * benign input (the proof is not payload-specific), `failed` means the
   * control ran and the proof depended on the exploit input.
   */
  readonly benignArm?: HardBenignArmResult
  /**
   * Why the verdict settled, as a code the pilot can aggregate; the reading
   * groups live on `HardFindingCause`. Absent on older logs and on
   * `confirmed` and `flaky` verdicts.
   */
  readonly cause?: HardFindingCause
  /**
   * How strong the proof is. `demonstrated` — a model-written PoC passed the
   * specificity check — is everything the verifier can currently produce: a
   * model-written PoC cannot rule out a fabricator that branches on the
   * payload. `proven` — the harness drives the target and the model supplies
   * no executable code — is reserved for the differential runner, and no
   * branch assigns it today. Every confirmed verdict carries `demonstrated`
   * explicitly; absence marks older logs, whose confirms ran no benign arm
   * and are therefore weaker than `demonstrated`.
   */
  readonly evidence?: HardFindingEvidence
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
  /**
   * Who decided this verdict. Optional so the change is additive: absent
   * reads as `model`. Harness callers set this; model-facing tools never do.
   */
  readonly source?: HardCoverageSource
}

/**
 * Verifiable evidence behind one empty sweep summary: a reference the ledger
 * can check, never free text. A hypothesis proof must be `refuted`; a cell
 * proof must be `cleared` with declared sinks and must not be
 * harness-screened, because a machine screen cannot prove a sweep did work.
 */
export type HardEmptySweepProof =
  | { readonly kind: 'hypothesis'; readonly hypothesisId: string }
  | { readonly kind: 'cell'; readonly module: string; readonly bugClass: string }

/** Per-section entry counts of one flow document, in contract order. */
export interface HardFlowDocSections {
  readonly entryPoints: number
  readonly dataflows: number
  readonly trustBoundaries: number
  readonly stateMachines: number
  readonly assumptions: number
  readonly quirks: number
}

/**
 * One recorded flow document for a module, the durable Phase B record. The
 * verifier resolved every citation against the pinned commit before this
 * record was appended, so the counts certify reads, not promises. Notes and
 * snippets are deliberately absent — prose belongs to the tool result, and
 * the log carries only what the harness checked.
 */
export interface HardFlowDocData {
  /** The module the document reads, target-repo relative. */
  readonly module: string
  /** Entries recorded per section, in contract order. */
  readonly sections: HardFlowDocSections
  /** Total citations the verifier resolved for this document. */
  readonly citations: number
  /**
   * Hypothesis ids opened from the document's quirks, in quirk order.
   * Optional so the change is additive; absent reads as none.
   */
  readonly quirkIds?: readonly string[]
}

/** One completed sweep pass summary; purely informational. */
export interface HardSweepSummaryData {
  readonly phase: 'A' | 'B'
  readonly cellsTouched: number
  readonly newFindings: number
  /**
   * Legacy free-text proof of an empty sweep; only older logs carry it. New
   * records carry the verifiable `emptyProofRef` instead.
   */
  readonly emptyProof?: string
  /**
   * Verifiable evidence an empty sweep rests on, checked at record time: a
   * refuted hypothesis, or a model-cleared cell with declared sinks.
   */
  readonly emptyProofRef?: HardEmptySweepProof
  /**
   * A Phase B empty sweep's alternative proof: the module whose recorded flow
   * document (a `hard/flow/doc` with at least one resolved citation) proves
   * the deep-reading pass ran. A sibling of `emptyProofRef`, not a variant of
   * it: opening the reference union would change the payload contract and
   * force a Session-format bump, while the recorded documents keep growing.
   * Optional so the change is additive; the two fields are mutually exclusive.
   */
  readonly emptyProofFlowDoc?: string
}

/** The harness's recorded decision on one completion attempt. */
export interface HardGateDecisionData {
  /** `allow` when the harness certifies completion, `deny` when work remains. */
  readonly decision: 'allow' | 'deny'
  /** Open-work items at decision time. */
  readonly openWorkCount: number
  readonly coverage: {
    readonly verdicted: number
    readonly total: number
    readonly bySource: { readonly model: number; readonly modelVerified: number; readonly harness: number }
  }
  readonly hypotheses: {
    /** Hypotheses in a terminal status (`confirmed` or `refuted`). */
    readonly resolved: number
    /** Hypotheses still proposed, testing, or deferred. */
    readonly open: number
  }
  readonly findings: {
    readonly confirmed: number
    readonly refuted: number
    readonly flaky: number
    /** Proposed findings the verifier has not decided. */
    readonly pending: number
  }
  /** Consecutive empty-verified sweep summaries ending at the latest one. */
  readonly emptySweeps: number
  /** The bounded blocking items; empty when `allow`. */
  readonly blockers: readonly string[]
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
  /**
   * Sorted subset of `modules` where every tracked file carries an inert
   * extension: no code, so no module-class surface. Optional so the change is
   * additive; absent reads as an empty screen.
   */
  readonly inertModules?: readonly string[]
  /**
   * Id of the goal this arming created. Optional so the change is additive;
   * records without it predate goal attribution, and the completion gate
   * never fires for them.
   */
  readonly goalId?: string
}

/**
 * The client view of one folded hard-ledger state — the projection's wire
 * value, deliberately a summary: the armed matrix axes, every event-backed
 * matrix cell's verdict and decider, the coverage aggregates, and the gate's
 * current assessment. Full findings, hypotheses, and declared sinks stay
 * host-side; the panel renders the matrix, not the transcript.
 */
export interface HardLedgerClientView {
  /** The armed matrix axes and pinned target, absent until the mission arms. */
  readonly matrix?: {
    readonly modules: readonly string[]
    readonly bugClasses: readonly string[]
    /** Sweep scope per bug class: repository-level classes render one cell, not one per module. */
    readonly classScopes: Readonly<Record<string, 'module' | 'repo'>>
    readonly inertModules?: readonly string[]
    readonly targetRepo: string
    readonly commit: string
  }
  /** Latest verdict per event-backed matrix cell; off-matrix cells are absent. */
  readonly cells: readonly {
    readonly module: string
    readonly bugClass: string
    readonly verdict: HardCoverageVerdict
    readonly source?: HardCoverageSource
  }[]
  /** Verdicted matrix cells over the matrix cell total. */
  readonly progress: { readonly verdicted: number; readonly total: number }
  /** The same cells partitioned by decider. */
  readonly bySource: { readonly model: number; readonly modelVerified: number; readonly harness: number }
  /** The harness's current completion assessment with its bounded blockers. */
  readonly gate: { readonly complete: boolean; readonly blockers: readonly string[] }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  /** The hard ledger's client-visible wire value. */
  interface SessionProjectionMap {
    hardLedger: HardLedgerClientView
  }
}
