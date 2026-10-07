/** The optional hard bundle mounts all nine hard plugins and the web coverage panel as one layer. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'

describe('Hard bundle', () => {
  it('publishes one layer containing the nine hard plugins and the web-only panel row', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      publishConfig: { access: string }
      dsh: { bundle: { patch: string } }
      dependencies: Record<string, string>
    }
    expect(manifest.publishConfig.access).toBe('public')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toEqual({
      '@deepseek-ai/dsh-experimental-client-ui-hard': 'workspace:*',
      '@deepseek-ai/dsh-experimental-hard-deepread': 'workspace:*',
      '@deepseek-ai/dsh-experimental-hard-handoff': 'workspace:*',
      '@deepseek-ai/dsh-experimental-hard-ledger': 'workspace:*',
      '@deepseek-ai/dsh-experimental-hard-mission': 'workspace:*',
      '@deepseek-ai/dsh-experimental-hard-rounds': 'workspace:*',
      '@deepseek-ai/dsh-experimental-hard-stopgate': 'workspace:*',
      '@deepseek-ai/dsh-experimental-hard-standby': 'workspace:*',
      '@deepseek-ai/dsh-experimental-hard-tools': 'workspace:*',
      '@deepseek-ai/dsh-experimental-hard-verifier': 'workspace:*',
    })
    expect(yaml.load(readFileSync(new URL(`../${manifest.dsh.bundle.patch}`, import.meta.url), 'utf8'), {
      schema: entryListSchema,
    })).toEqual([{ insert: [
      { id: 'hard-ledger', name: '@deepseek-ai/dsh-experimental-hard-ledger' },
      { id: 'hard-verifier', name: '@deepseek-ai/dsh-experimental-hard-verifier' },
      { id: 'hard-tools', name: '@deepseek-ai/dsh-experimental-hard-tools' },
      {
        id: 'hard-mission',
        name: '@deepseek-ai/dsh-experimental-hard-mission',
        config: { objective: '', target: { repoPath: '', commit: 'HEAD' } },
      },
      { id: 'hard-stopgate', name: '@deepseek-ai/dsh-experimental-hard-stopgate' },
      { id: 'hard-standby', name: '@deepseek-ai/dsh-experimental-hard-standby' },
      { id: 'hard-handoff', name: '@deepseek-ai/dsh-experimental-hard-handoff' },
      { id: 'hard-rounds', name: '@deepseek-ai/dsh-experimental-hard-rounds' },
      { id: 'hard-deepread', name: '@deepseek-ai/dsh-experimental-hard-deepread' },
      {
        id: 'ui-hard',
        name: '@deepseek-ai/dsh-experimental-client-ui-hard',
        // entryListSchema reads the !!js expression as a tagged literal.
        disabled: { __jsExpr: "!ctx.get('profileContext')?.startedBundles.includes('@deepseek-ai/dsh-web-app')" },
      },
    ] }])
  })

  it('carries no runtime API', async () => {
    const hardBundle = await import('@deepseek-ai/dsh-experimental-hard-bundle')
    expect(Object.keys(hardBundle)).toEqual([])
  })
})
