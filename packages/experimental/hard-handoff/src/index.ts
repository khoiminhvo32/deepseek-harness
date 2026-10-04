/**
 * Hard handoff around compaction. When a successful `compaction/end` lands,
 * the plugin injects one deterministic state summary assembled from the hard
 * ledger folds and the current goal view, so the model resumes with durable
 * facts instead of a bare compaction summary. Failed compactions inject
 * nothing.
 * @module @deepseek-ai/dsh-experimental-hard-handoff
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Loads the declaration-merged `Context` keys this plugin injects.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-experimental-hard-ledger'
import type {} from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { buildHandoff } from './message.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Marks injected context the hard handoff assembled after a successful
     * compaction. The message persists for replay and audit; no reader needs
     * the producer, and readers preserve the message without this attribution.
     * @persistenceAttribution
     */
    'hard-handoff': { kind: 'hard-handoff' } & ContextFormed
  }
}

export const name = 'hard-handoff'
export const inject = ['agents', 'goals', 'hardLedger']

export { buildHandoff } from './message.ts'
export type { HandoffInput } from './message.ts'

/** Default bound on listed open-work items per handoff. */
export const DEFAULT_MAX_HANDOFF_ITEMS = 32

/** Handoff plugin config. */
export interface Config {
  /** Maximum open-work items listed in one handoff before truncation. */
  maxItems?: number
}

/** Schemastery config for the handoff plugin. */
export const Config: z<Config> = z.object({
  maxItems: z.number().step(1).min(1).default(DEFAULT_MAX_HANDOFF_ITEMS),
})

/** Register the compaction-end observer that injects the ledger handoff. */
export function apply(ctx: Context, config: Config): void {
  const maxItems = config.maxItems ?? DEFAULT_MAX_HANDOFF_ITEMS
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new TypeError('maxItems must be a positive safe integer')
  }
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/end') return
    if (event.data.error !== undefined) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: buildHandoff({
        goal: ctx.goals.get(agent),
        findings: ctx.hardLedger.findings(agent),
        hypotheses: ctx.hardLedger.hypotheses(agent),
        coverage: ctx.hardLedger.coverage(agent),
        openWork: ctx.hardLedger.openWork(agent),
        maxItems,
      }) }],
      source: { kind: 'hard-handoff' },
    }))
  })
}
