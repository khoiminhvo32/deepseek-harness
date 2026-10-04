/**
 * Deterministic handoff text for one post-compaction context injection,
 * assembled only from ledger folds and the current goal view — never from
 * files or raw log scans — so the injected summary is reconstructable from
 * the session log.
 * @module
 */

import type { HardLedgerFindingEntry } from '@deepseek-ai/dsh-experimental-hard-ledger'
import type { HardCoverageCellData, HardHypothesisStateData } from '@deepseek-ai/dsh-experimental-hard-ledger'
import type { GoalView } from '@deepseek-ai/dsh-goal'

/** Inputs for one handoff summary. */
export interface HandoffInput {
  /** Current goal view, `undefined` when the session has no goal. */
  readonly goal: GoalView | undefined
  /** Ledger findings, proposal plus latest verdict when present. */
  readonly findings: readonly HardLedgerFindingEntry[]
  /** Ledger hypotheses folded to their latest state. */
  readonly hypotheses: readonly HardHypothesisStateData[]
  /** Ledger coverage cells folded to their latest verdict. */
  readonly coverage: readonly HardCoverageCellData[]
  /** The ledger's model-facing open-work items. */
  readonly openWork: readonly string[]
  /** Maximum open-work items listed before truncation. */
  readonly maxItems: number
}

/** Per-item text bound so one long claim cannot dominate the summary. */
const ITEM_TEXT_LIMIT = 240

/** Bound one line to the item text limit. */
function boundItem(text: string): string {
  return text.length <= ITEM_TEXT_LIMIT ? text : `${text.slice(0, ITEM_TEXT_LIMIT - 1)}…`
}

/** Render the mission line from the goal view, or its absence. */
function missionLine(goal: GoalView | undefined): string {
  if (goal === undefined) return 'Mission: none current.'
  return `Mission: "${goal.objective}" (goal ${goal.phase}, activation ${goal.activation}, `
    + `round ${goal.roundsStarted} of ${goal.maxGoalRounds}).`
}

/** Render one counted line: `Label: total recorded (a x, b y).` */
function countLine(label: string, parts: readonly [string, number][]): string {
  const detailed = parts.filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${name}`)
    .join(', ')
  return `${label}: ${parts.reduce((total, [, count]) => total + count, 0)} recorded${detailed.length > 0 ? ` (${detailed})` : ''}.`
}

/**
 * Build the model-facing handoff summary.
 * @param input - goal view, ledger folds, open work, and the item cap.
 * @returns the bounded summary text, identical for identical ledger state.
 */
export function buildHandoff(input: HandoffInput): string {
  const confirmed = input.findings.filter(entry => entry.verdict?.verdict === 'confirmed').length
  const refuted = input.findings.filter(entry => entry.verdict?.verdict === 'refuted').length
  const flaky = input.findings.filter(entry => entry.verdict?.verdict === 'flaky').length
  const unverified = input.findings.filter(entry => entry.verdict === undefined).length
  const openHypotheses = input.hypotheses
    .filter(hypothesis => hypothesis.status === 'proposed' || hypothesis.status === 'testing' || hypothesis.status === 'deferred')
  const cleared = input.coverage.filter(cell => cell.verdict === 'cleared').length
  const suspicious = input.coverage.filter(cell => cell.verdict === 'suspicious').length
  const uncovered = input.coverage.filter(cell => cell.verdict === 'uncovered').length

  const lines = [
    'Context was compacted; this durable state summary is authoritative for the mission.',
    missionLine(input.goal),
    countLine('Findings', [['confirmed', confirmed], ['refuted', refuted], ['flaky', flaky], ['unverified', unverified]]),
    countLine('Hypotheses', [['open', openHypotheses.length], ['resolved', input.hypotheses.length - openHypotheses.length]]),
    countLine('Coverage cells', [['cleared', cleared], ['suspicious', suspicious], ['uncovered', uncovered]]),
  ]
  if (input.openWork.length > 0) {
    lines.push('Open work:')
    for (const item of input.openWork.slice(0, input.maxItems)) lines.push(`- ${boundItem(item)}`)
    if (input.openWork.length > input.maxItems) {
      lines.push(`(+${input.openWork.length - input.maxItems} more open items not listed)`)
    }
  }
  lines.push('Continue the mission with the next concrete action.')
  return lines.join('\n')
}
