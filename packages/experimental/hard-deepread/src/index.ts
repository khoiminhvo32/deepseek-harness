/**
 * Teaches the deep-reading pass of the hard harness: the `hard:deep-read`
 * system-prompt section owns the flow-document contract and the subagent
 * fan-out template, so a Phase B round produces structured module documents
 * and hypothesis records instead of free-form reading notes. The section is
 * static guidance; the model executes it with the shipped `subagent` tool
 * and records the results through the hard ledger tools.
 * @module @deepseek-ai/dsh-experimental-hard-deepread
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Loads the declaration-merged `Context` keys this plugin injects.
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'hard-deepread'
export const inject = ['systemPrompt']

/** Repository directory holding one flow document per module or module cluster. */
export const FLOW_DOC_DIR = '.dsh-hard/flow'

/** Deep-read plugin config. */
export interface Config {
  /**
   * Maximum modules one deep-reading pass may fan out; the bound keeps one
   * Phase B round from spawning an unbounded subagent fleet.
   */
  maxModulesPerPass?: number
}

/** Schemastery config for the deep-read plugin. */
export const Config: z<Config> = z.object({
  maxModulesPerPass: z.number().step(1).min(1).max(16).default(6),
})

/** Fully materialized deep-read inputs. */
interface ResolvedConfig {
  readonly maxModulesPerPass: number
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const maxModulesPerPass = config.maxModulesPerPass ?? 6
  if (!Number.isSafeInteger(maxModulesPerPass) || maxModulesPerPass < 1 || maxModulesPerPass > 16) {
    throw new TypeError('maxModulesPerPass must be a safe integer from 1 through 16')
  }
  return { maxModulesPerPass }
}

/** Render the model-facing deep-reading contract from the resolved config. */
function deepReadContract(resolved: ResolvedConfig): string {
  return `Deep-reading pass (Phase B): when a round names phase B, read ${resolved.maxModulesPerPass} module `
    + 'or module-cluster at a time for understanding rather than pattern matching. '
    + 'For each module, spawn one subagent whose prompt demands a structured flow document with exactly these sections: '
    + 'entry points; dataflow; trust boundaries; state machines; assumptions; suspicious quirks. '
    + `Save each document as ${FLOW_DOC_DIR}/<module>.md and cite it later by path. `
    + 'Record every suspicious quirk as a hypothesis with hard_update_hypothesis: status proposed first, '
    + 'then testing with a concrete falsification step; never mark confirmed without executed evidence. '
    + 'Quirks that survive testing convert into findings submitted with hard_submit_finding and a real PoC. '
    + 'A deep-reading pass with no quirks found still records its progress: '
    + 'summarize the pass with hard_sweep_summary phase B and an emptyProof naming the modules read and the assumptions checked.'
}

/** Register the deep-reading contract section. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'hard:deep-read',
    order: ctx.systemPrompt.getSectionOrder('HARD_DEEP_READ'),
    text: deepReadContract(resolved),
  })
}
