/**
 * Session event vocabulary of the independent audit: one request per sampled
 * cleared cell and one result per request, merged into `SessionEventMap` so
 * the pending set and the measurements persist as ordinary additive log
 * records. The pending set lives in the log, not in the config of the
 * process that reads it.
 * @module @deepseek-ai/dsh-experimental-hard-audit
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * The sampling tier of one audited clear, inverse to what the harness can
 * cross-check: `unscreened` is a model read in a module the grep cross-check
 * cannot screen, `batch` is a batch screen nobody read, and `per-cell` is a
 * model read the cross-check can screen.
 */
export type HardAuditTier = 'unscreened' | 'batch' | 'per-cell'

/** How one audit settled. Only `corroborated` and `flagged` are measurements. */
export type HardAuditOutcome = 'corroborated' | 'flagged' | 'unavailable'

/**
 * Why an audit produced no measurement: `budget` (the mission's audit budget
 * was spent), `superseded` (the cell was re-marked before the reader started),
 * `binary` (the module holds a binary the reader cannot read), `workspace-drift`
 * (the module differed from the pinned commit before or after the read),
 * `git` (a workspace check did not settle), `reader-failed` (the reader ended
 * without a structured report), `contaminated` (the reader read outside the
 * target or into harness state), and `citation` (the report cited code that
 * does not exist at the pinned commit, or no code inside the cell).
 */
export type HardAuditUnavailableCause =
  | 'budget'
  | 'superseded'
  | 'binary'
  | 'workspace-drift'
  | 'git'
  | 'reader-failed'
  | 'contaminated'
  | 'citation'

/** One sampled clear queued for an independent read. */
export interface HardAuditRequestedData {
  readonly module: string
  readonly bugClass: string
  /** Seq of the `hard/coverage/cell` event whose clear this audit reads. */
  readonly auditedSeq: number
  readonly tier: HardAuditTier
}

/** One code location the reader names, relative to the target repository root. */
export interface HardAuditLocation {
  readonly path: string
  /** One-based line. */
  readonly line: number
  readonly symbol?: string
}

/** Token totals of one reader session, summed over its assistant messages. */
export interface HardAuditUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** The settled result of one requested audit. */
export interface HardAuditResultData {
  readonly module: string
  readonly bugClass: string
  /** Seq of the audited `hard/coverage/cell` event; pairs the result with its request. */
  readonly auditedSeq: number
  readonly outcome: HardAuditOutcome
  /** Present exactly when the outcome is `unavailable`. */
  readonly cause?: HardAuditUnavailableCause
  /** The reader's own reason, or the harness's reason for `unavailable`; bounded length. */
  readonly reason: string
  /** The resolved locations of a `flagged` result, bounded count. */
  readonly locations?: readonly HardAuditLocation[]
  /** How many resolved code sites a `corroborated` result examined. */
  readonly examined?: number
  /** The reader's route, present once a reader ran. */
  readonly auditor?: { readonly provider: string; readonly model: string }
  /** The reader's child session, present once a reader ran. */
  readonly childSession?: SessionId
  /** The reader's token totals, present once a reader ran. */
  readonly usage?: HardAuditUsage
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One sampled clear queued for an independent read; the audit plugin
     * owns the matching `hard/audit/result` for the same cell and seq.
     */
    'hard/audit/requested': HardAuditRequestedData
    /** The settled result of one requested audit. */
    'hard/audit/result': HardAuditResultData
  }
}
