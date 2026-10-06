/**
 * Verdict classification over executed PoC runs. The proof-of-effect
 * contract is mechanical: a run passes only when the process exits zero AND
 * its stdout prints `HARD-PASS <claimHash>` for the finding's claim. Payload
 * dependence is proven separately by the specificity check: the same PoC
 * re-run with a benign payload must fail, because a proof that passes
 * regardless of input proves nothing about the input. All exploit runs
 * passing confirms, all failing refutes, a split verdict is flaky and never
 * counts.
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
 * @returns true only for a zero-exit run that printed the marker. Output
 * beyond the marker is deliberately not required: payload dependence is
 * proven by the benign arm, not by stdout shape, and a silent exploit — one
 * whose effect leaves stdout untouched — is real.
 */
export function runSatisfied(run: PoCRunRecord, claimHash: string): boolean {
  if (run.exitCode !== 0 || run.timedOut || run.aborted) return false
  return run.stdoutText.includes(`HARD-PASS ${claimHash}`)
}

/**
 * Classify the executed runs into the durable verdict record. The benign arm
 * short-circuits: a PoC that satisfies the contract with a benign payload is
 * refuted by the specificity check before the exploit arm runs at all.
 * @param request - the finding id, executed runs, hashes, CVSS recompute facts, and the benign arm's outcome.
 * @returns the durable verdict payload ready to record.
 */
export function classifyRuns(request: {
  readonly id: HardFindingVerdictData['id']
  readonly runs: readonly PoCRunRecord[]
  readonly claimHash: string
  readonly cvssComputed: number
  readonly cvssMatch: boolean
  readonly fingerprint: string
  readonly benignArm?: HardFindingVerdictData['benignArm']
}): HardFindingVerdictData {
  const { runs, claimHash, id } = request
  if (request.benignArm === 'passed') {
    return {
      id,
      verdict: 'refuted',
      runs: 0,
      cvssComputed: request.cvssComputed,
      cvssMatch: request.cvssMatch,
      reason: 'the proof passes with a benign payload, so it does not depend on the exploit input',
      cause: 'benign-arm-passed',
      fingerprint: request.fingerprint,
      benignArm: 'passed',
    }
  }
  const benign = request.benignArm === undefined ? {} : { benignArm: request.benignArm }
  if (runs.length === 0) {
    return {
      id,
      verdict: 'refuted',
      runs: 0,
      cvssComputed: request.cvssComputed,
      cvssMatch: request.cvssMatch,
      reason: 'no runs were executed',
      cause: 'no-runs',
      fingerprint: request.fingerprint,
      ...benign,
    }
  }
  const satisfied = runs.map(run => runSatisfied(run, claimHash))
  const passCount = satisfied.filter(Boolean).length
  const runWord = runs.length === 1 ? '1 run' : `${runs.length} runs`

  let verdict: HardFindingVerdictData['verdict']
  let reason: string
  let cause: HardFindingVerdictData['cause']
  let evidence: HardFindingVerdictData['evidence']
  if (passCount === runs.length) {
    verdict = 'confirmed'
    reason = `${runWord} exited zero and printed the claim marker`
    // Carried explicitly so a confirm from before the benign arm existed —
    // evidence absent — reads as weaker, not identical.
    evidence = 'demonstrated'
  } else if (passCount === 0) {
    verdict = 'refuted'
    const first = runs[0]
    /* v8 ignore next -- defensive: guarded above, a non-empty run list always has a first run */
    if (first === undefined) {
      cause = 'no-runs'
      reason = 'no runs were executed'
    } else if (first.timedOut) {
      cause = 'timeout'
      reason = 'the PoC hit the verifier timeout without printing the claim marker'
    } else if (first.aborted) {
      cause = 'aborted'
      reason = 'the PoC was aborted before settling'
    } else {
      const tail = first.stderrTail.trim()
      const suffix = tail.length > 0 ? `: ${tail.slice(0, 160)}` : ''
      if (first.exitCode !== 0) {
        cause = 'nonzero-exit'
        reason = `exit code ${String(first.exitCode)} without the claim marker${suffix}`
      } else {
        cause = 'no-marker'
        reason = `exit code 0 without the claim marker${suffix}`
      }
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
    ...(cause === undefined ? {} : { cause }),
    ...(evidence === undefined ? {} : { evidence }),
    fingerprint: request.fingerprint,
    ...benign,
  }
}
