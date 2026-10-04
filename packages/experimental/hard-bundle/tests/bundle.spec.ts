/** The optional hard bundle mounts the mission, stop gate, standby, and handoff plugins as one layer. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'

describe('Hard bundle', () => {
  it('publishes one layer containing the mission, the stop gate, the standby, and the handoff', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      publishConfig: { access: string }
      dsh: { bundle: { patch: string } }
      dependencies: Record<string, string>
    }
    expect(manifest.publishConfig.access).toBe('public')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toEqual({
      '@deepseek-ai/dsh-experimental-hard-handoff': 'workspace:*',
      '@deepseek-ai/dsh-experimental-hard-mission': 'workspace:*',
      '@deepseek-ai/dsh-experimental-hard-stopgate': 'workspace:*',
      '@deepseek-ai/dsh-experimental-hard-standby': 'workspace:*',
    })
    expect(yaml.load(readFileSync(new URL(`../${manifest.dsh.bundle.patch}`, import.meta.url), 'utf8'), {
      schema: entryListSchema,
    })).toEqual([{ insert: [
      {
        id: 'hard-mission',
        name: '@deepseek-ai/dsh-experimental-hard-mission',
        config: { objective: '' },
      },
      { id: 'hard-stopgate', name: '@deepseek-ai/dsh-experimental-hard-stopgate' },
      { id: 'hard-standby', name: '@deepseek-ai/dsh-experimental-hard-standby' },
      { id: 'hard-handoff', name: '@deepseek-ai/dsh-experimental-hard-handoff' },
    ] }])
  })

  it('carries no runtime API', async () => {
    const hardBundle = await import('@deepseek-ai/dsh-experimental-hard-bundle')
    expect(Object.keys(hardBundle)).toEqual([])
  })
})
