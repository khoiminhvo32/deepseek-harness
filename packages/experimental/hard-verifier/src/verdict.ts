/**
 * Verdict classification over executed PoC runs. The proof-of-effect
 * contract is mechanical: a run passes only when the process exits zero AND
 * its stdout prints `HARD-PASS <claimHash>` for the finding's claim. All
 * runs passing confirms, all failing refutes, a split verdict is flaky and
 * never counts.
 * @module
 */

import type { HardFindingVerdictData } from '@deepseek-ai/dsh-experimental-hard-ledger'

/** One executed PoC run, reduced to the facts the verdict needs. */
export interface PoCRunRecord {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly stdoutText: string
  readonly stderrTail: string
}

/**
 * Whether one run satisfied the proof-of-effect contract.
 * @param run - the executed run's reduced facts.
 * @param claimHash - the expected `HARD-PASS` marker hash.
 * @returns true only for a zero-exit run that printed the marker.
 */
export function runSatisfied(run: PoCRunRecord, claimHash: string): boolean {
  return run.exitCode === 0 && !run.timedOut && !run.aborted && run.stdoutText.includes(`HARD-PASS ${claimHash}`)
}

/**
 * Classify the executed runs into the durable verdict record.
 * @param request - the finding id, executed runs, hashes, and CVSS recompute facts.
 * @returns the durable verdict payload ready to record.
 */
export function classifyRuns(request: {
  readonly id: HardFindingVerdictData['id']
  readonly runs: readonly PoCRunRecord[]
  readonly claimHash: string
  readonly cvssComputed: number
  readonly cvssMatch: boolean
  readonly fingerprint: string
}): HardFindingVerdictData {
  const { runs, claimHash, id } = request
  if (runs.length === 0) {
    return {
      id,
      verdict: 'refuted',
      runs: 0,
      cvssComputed: request.cvssComputed,
      cvssMatch: request.cvssMatch,
      reason: 'no runs were executed',
      fingerprint: request.fingerprint,
    }
  }
  const satisfied = runs.map(run => runSatisfied(run, claimHash))
  const passCount = satisfied.filter(Boolean).length
  const runWord = runs.length === 1 ? '1 run' : `${runs.length} runs`

  let verdict: HardFindingVerdictData['verdict']
  let reason: string
  if (passCount === runs.length) {
    verdict = 'confirmed'
    reason = `${runWord} exited zero and printed the claim marker`
  } else if (passCount === 0) {
    verdict = 'refuted'
    const first = runs[0]
    /* v8 ignore next -- defensive: guarded above, a non-empty run list always has a first run */
    if (first === undefined) {
      reason = 'no runs were executed'
    } else if (first.timedOut) {
      reason = 'the PoC hit the verifier timeout without printing the claim marker'
    } else if (first.aborted) {
      reason = 'the PoC was aborted before settling'
    } else {
      const tail = first.stderrTail.trim()
      reason = `exit code ${String(first.exitCode)} without the claim marker${tail.length > 0 ? `: ${tail.slice(0, 160)}` : ''}`
    }
  } else {
    verdict = 'flaky'
    reason = `${String(passCount)} of ${String(runs.length)} runs satisfied the contract; a flaky proof never counts`
  }

  return {
    id,
    verdict,
    runs: runs.length,
    cvssComputed: request.cvssComputed,
    cvssMatch: request.cvssMatch,
    reason,
    fingerprint: request.fingerprint,
  }
}
