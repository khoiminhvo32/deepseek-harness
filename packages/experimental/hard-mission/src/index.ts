/**
 * Arms the configured long-running objective as a durable session goal and
 * teaches the mission contract through a `hard:mission` system-prompt section.
 * The plugin mounts beside the goal service: it arms fresh root agents on
 * `startup` and never touches restored, paused, or completed goal state.
 * @module @deepseek-ai/dsh-experimental-hard-mission
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Loads the declaration-merged `Context` keys this plugin injects.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'hard-mission'
export const inject = ['agents', 'goals', 'systemPrompt']

/**
 * Bug classes the default mission contract sweeps in its systematic pass:
 * every OWASP Top 10 class with mechanical source-to-sink semantics, with
 * authentication surfaced as its distinct bypass flavors. Insecure design and
 * security logging stay in the deep-reading pass, where hypotheses rather
 * than source-sink patterns find them.
 */
export const DEFAULT_BUG_CLASSES: readonly string[] = [
  'sqli',
  'xss',
  'cmdi',
  'path-traversal',
  'open-redirect',
  'deserialization',
  'ssrf',
  'authn',
  'authn-bypass',
  'login-bypass',
  'oauth-bypass',
  'session',
  'authz',
  'crypto-misuse',
  'misconfig',
  'dependencies',
  'race',
]

/** Default automatic continuation-round cap handed to the created goal. */
export const DEFAULT_MAX_GOAL_ROUNDS = 64

/** Default number of systematic passes between deep-reading passes. */
export const DEFAULT_DEEP_READ_EVERY_N = 3

/** Mission plugin config. */
export interface Config {
  /**
   * The durable objective the session must keep working toward. Required and
   * non-blank: a mission without an objective fails loudly at load.
   */
  objective: string
  /** Positive safe-integer cap on automatic continuation rounds. */
  maxGoalRounds?: number
  /**
   * Bug classes the systematic pass sweeps, named in the mission contract.
   * An empty list removes the class list from the contract.
   */
  bugClasses?: string[]
  /** Number of systematic passes between deep-reading passes. */
  deepReadEveryN?: number
}

/** Schemastery config for the mission plugin. */
export const Config: z<Config> = z.object({
  objective: z.string().required(),
  maxGoalRounds: z.number().step(1).min(1).default(DEFAULT_MAX_GOAL_ROUNDS),
  bugClasses: z.array(z.string()).default([...DEFAULT_BUG_CLASSES]),
  deepReadEveryN: z.number().step(1).min(1).default(DEFAULT_DEEP_READ_EVERY_N),
})

/** Fully materialized mission contract inputs. */
interface ResolvedConfig {
  readonly objective: string
  readonly maxGoalRounds: number
  readonly bugClasses: readonly string[]
  readonly deepReadEveryN: number
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const { objective } = config
  if (typeof objective !== 'string' || objective.trim().length === 0) {
    throw new TypeError('objective must be a non-empty string')
  }
  const maxGoalRounds = config.maxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS
  if (!Number.isSafeInteger(maxGoalRounds) || maxGoalRounds < 1) {
    throw new TypeError('maxGoalRounds must be a positive safe integer')
  }
  const bugClasses = config.bugClasses ?? [...DEFAULT_BUG_CLASSES]
  if (!Array.isArray(bugClasses)
    || bugClasses.some(bugClass => typeof bugClass !== 'string' || bugClass.trim().length === 0)) {
    throw new TypeError('bugClasses must be an array of non-empty class names')
  }
  const deepReadEveryN = config.deepReadEveryN ?? DEFAULT_DEEP_READ_EVERY_N
  if (!Number.isSafeInteger(deepReadEveryN) || deepReadEveryN < 1) {
    throw new TypeError('deepReadEveryN must be a positive safe integer')
  }
  return { objective, maxGoalRounds, bugClasses, deepReadEveryN }
}

/** Render the model-facing mission contract from the resolved config. */
function missionContract(resolved: ResolvedConfig): string {
  const sweep = resolved.bugClasses.length > 0
    ? `Systematic passes sweep these bug classes: ${resolved.bugClasses.join(', ')}. `
    : ''
  return `Mission: ${resolved.objective} `
    + 'This session carries one durable goal and keeps working toward it across turns. '
    + 'Do not stop to announce progress while concrete work remains; take the next action instead. '
    + sweep
    + `Every ${resolved.deepReadEveryN} systematic passes, run a deep-reading pass that models dataflow, `
    + 'trust boundaries, and state machines to form and test hypotheses beyond pattern matching. '
    + 'Declare completion only with update_goal action complete once the objective is genuinely achieved; '
    + 'ending a turn does not end the mission.'
}

/** Register the mission contract section and arm fresh root goals on startup. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'hard:mission',
    order: ctx.systemPrompt.getSectionOrder('HARD_MISSION'),
    text: missionContract(resolved),
  })
  ctx.on('agent/created', ({ agent, source }) => {
    if (source !== 'startup') return
    if (!ctx.agents.roots().includes(agent)) return
    if (ctx.goals.get(agent) !== undefined) return
    ctx.goals.create(agent, {
      objective: resolved.objective,
      maxGoalRounds: resolved.maxGoalRounds,
    })
  })
}
