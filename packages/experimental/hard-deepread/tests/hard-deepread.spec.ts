/** The deep-read plugin registers the Phase B contract section with its fan-out bound. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as hardDeepread from '@deepseek-ai/dsh-experimental-hard-deepread'

async function harness(config: hardDeepread.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  const fiber = await ctx.plugin(hardDeepread, config)
  return { ctx, fiber }
}

describe('hard deepread section', () => {
  it('registers the deep-reading contract with the flow-document template', async () => {
    const { ctx } = await harness()
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'hard:deep-read')
    expect(section).toBeDefined()
    expect(section?.text).toContain('Deep-reading pass (Phase B): when a round names phase B, read 6 module')
    expect(section?.text).toContain('entry points; dataflow; trust boundaries; state machines; assumptions; suspicious quirks')
    expect(section?.text).toContain('Record each document with hard_record_flow')
    expect(section?.text).toContain('resolves every citation against the pinned commit')
    expect(section?.text).toContain('hard_update_hypothesis')
    expect(section?.text).toContain('citing the recorded flow documents as the empty proof')
  })

  it('honors the configured module bound', async () => {
    const { ctx } = await harness({ maxModulesPerPass: 2 })
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'hard:deep-read')
    expect(section?.text).toContain('read 2 module')
  })

  it('validates config when apply runs outside Loader normalization', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    expect(() => { hardDeepread.apply(ctx, { maxModulesPerPass: 0 }) }).toThrow('maxModulesPerPass must be a safe integer from 1 through 16')
    expect(() => { hardDeepread.apply(ctx, { maxModulesPerPass: 17 }) }).toThrow('maxModulesPerPass must be a safe integer from 1 through 16')
    expect(() => { hardDeepread.apply(ctx, {}) }).not.toThrow()
  })

  it('has the Loader-safe namespace export shape', () => {
    expect(hardDeepread.name).toBe('hard-deepread')
    expect(hardDeepread.inject).toEqual(['systemPrompt'])
    expect('FLOW_DOC_DIR' in hardDeepread).toBe(false)
  })
})
