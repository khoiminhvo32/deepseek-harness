/**
 * The hard verifier: executes a finding's proof of concept through the shell
 * seam, applies the mechanical proof-of-effect contract, recomputes the
 * claimed CVSS 4.0 score, and records the durable verdict. The model never
 * runs its own proof for acceptance: only a harness-executed run counts.
 * @module @deepseek-ai/dsh-experimental-hard-verifier
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { HardFindingProposedData, HardFindingVerdictData } from '@deepseek-ai/dsh-experimental-hard-ledger'
import { parseVector, scoreVector } from './cvss4.ts'
import { classifyRuns } from './verdict.ts'
import type { PoCRunRecord } from './verdict.ts'
// Loads the declaration-merged `shell` Context key this service executes through.
import type {} from '@deepseek-ai/dsh-shell'

/** Default PoC execution count; every run must satisfy the contract to confirm. */
export const DEFAULT_VERIFIER_RUNS = 3

/** Default per-run timeout in seconds. */
export const DEFAULT_VERIFIER_TIMEOUT_SECONDS = 120

/** Default foreground stdout capture budget per run, in bytes. */
export const DEFAULT_STDOUT_MAX_BYTES = 65536

/** Verifier plugin config. */
export interface Config {
  /**
   * PoC executions per verification. Every run must satisfy the
   * proof-of-effect contract for `confirmed`; any split is `flaky`.
   */
  runs?: number
  /** Per-run timeout in seconds; a timed-out run never satisfies the contract. */
  timeoutSeconds?: number
  /** Foreground stdout capture budget per run in bytes. */
  stdoutMaxBytes?: number
  /** Working directory for PoC execution; defaults to the shell provider's own. */
  pocWorkdir?: string
}

/** Schemastery config for the verifier. */
export const Config: z<Config> = z.object({
  runs: z.number().step(1).min(1).max(10).default(DEFAULT_VERIFIER_RUNS),
  timeoutSeconds: z.number().step(1).min(1).max(3600).default(DEFAULT_VERIFIER_TIMEOUT_SECONDS),
  stdoutMaxBytes: z.number().step(1).min(1024).default(DEFAULT_STDOUT_MAX_BYTES),
  pocWorkdir: z.string(),
})

/** Fully materialized verifier settings. */
interface ResolvedConfig {
  readonly runs: number
  readonly timeoutSeconds: number
  readonly stdoutMaxBytes: number
  readonly pocWorkdir?: string
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const runs = config.runs ?? DEFAULT_VERIFIER_RUNS
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) {
    throw new TypeError('runs must be a safe integer between 1 and 10')
  }
  const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_VERIFIER_TIMEOUT_SECONDS
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new TypeError('timeoutSeconds must be a safe integer between 1 and 3600')
  }
  const stdoutMaxBytes = config.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES
  if (!Number.isSafeInteger(stdoutMaxBytes) || stdoutMaxBytes < 1024) {
    throw new TypeError('stdoutMaxBytes must be a safe integer of at least 1024')
  }
  if (config.pocWorkdir !== undefined && config.pocWorkdir.trim().length === 0) {
    throw new TypeError('pocWorkdir must not be blank when provided')
  }
  return {
    runs,
    timeoutSeconds,
    stdoutMaxBytes,
    ...config.pocWorkdir === undefined ? {} : { pocWorkdir: config.pocWorkdir },
  }
}

/** POSIX-quote one path argument for the PoC command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Deterministically recompute the score and compare with the model's claim. */
function recomputeCvss(proposed: HardFindingProposedData): { computed: number; match: boolean } {
  let computed: number
  try {
    computed = scoreVector(parseVector(proposed.cvssVector))
  } catch (error: unknown) {
    /* v8 ignore next -- defensive: parseVector only throws Error instances */
    throw new HarnessError(
      `${proposed.id}: cvss vector does not parse: ${error instanceof Error ? error.message : String(error)}`,
      'HARD_VERIFIER_INVALID_VECTOR',
    )
  }
  return { computed, match: Math.abs(computed - proposed.cvssClaimed) < 1e-9 }
}

/**
 * Owns proof execution and verdict recording on the `hardVerifier` key.
 * Depends on the shell seam for execution and the ledger for durable state.
 */
declare module '@deepseek-ai/cordis' {
  /** The hard-harness proof-of-effect verification service. */
  interface Context {
    hardVerifier: HardVerifier
  }
}

/**
 * The hard-harness verifier on the `hardVerifier` key: rejects duplicates,
 * executes proofs of effect through the shell seam, recomputes CVSS 4.0
 * scores against the claimed ones, and records the durable verdict.
 */
export class HardVerifier extends Service {
  static inject = ['shell', 'hardLedger']

  static Config: z<Config> = Config

  private readonly resolved: ResolvedConfig

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'hardVerifier')
    this.resolved = resolveConfig(config)
  }

  /**
   * Verify one proposed finding: reject duplicates, recompute CVSS, execute
   * the configured number of PoC runs through the shell seam, classify, and
   * append the durable verdict.
   * @param agent - the live agent whose ledger receives the verdict.
   * @param proposed - the proposal record to verify.
   * @returns the appended verdict record.
   */
  async verify(agent: Agent, proposed: HardFindingProposedData): Promise<HardFindingVerdictData> {
    const config = this.resolved
    const ledger = this.ctx.hardLedger
    for (const record of ledger.findings(agent)) {
      if (record.proposed.fingerprint === proposed.fingerprint && record.proposed.id !== proposed.id
        && record.verdict?.verdict === 'confirmed') {
        throw new HarnessError(
          `${proposed.id}: a confirmed finding with the same root cause already exists (${record.proposed.id})`,
          'HARD_VERIFIER_DUPLICATE',
        )
      }
    }

    const { computed, match } = recomputeCvss(proposed)
    const command = `bash ${shellQuote(proposed.pocPath)}`
    const runs: PoCRunRecord[] = []
    for (let index = 0; index < config.runs; index += 1) {
      const spec = this.ctx.shell.resolve({
        command,
        timeoutMs: config.timeoutSeconds * 1000,
        stdoutMaxBytes: config.stdoutMaxBytes,
        ...config.pocWorkdir === undefined ? {} : { workdir: config.pocWorkdir },
      })
      const execution = await this.ctx.shell.execute(spec)
      const result = await execution.result()
      runs.push({
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        stdoutText: result.stdout.text,
        stderrTail: result.stderr.text.slice(-400),
      })
    }

    const verdict = classifyRuns({
      id: proposed.id,
      runs,
      claimHash: proposed.claimHash,
      cvssComputed: computed,
      cvssMatch: match,
      fingerprint: proposed.fingerprint,
    })
    ledger.recordVerdict(agent, verdict)
    return verdict
  }
}

export { parseVector, scoreVector, macroVector, severityBand } from './cvss4.ts'
export { claimHash, rootFingerprint } from './fingerprint.ts'
export { classifyRuns, runSatisfied } from './verdict.ts'
export type { PoCRunRecord } from './verdict.ts'
export default HardVerifier
