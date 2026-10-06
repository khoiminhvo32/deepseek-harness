/** Boot proof for the `hard-web` profile: the hard harness stack activates inside the
 * shipped Web composition (no headless bundle), and the mission arms a fresh root
 * agent's durable session log. A composition conflict surfaces here as a pending
 * plugin (did not activate) or a load-time throw — both fail this file. */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'
import { loadProfile, PluginPackages, createRuntimeResolution } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-experimental-hard-ledger'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
// The real boot: the built app-boot package embeds the bootstrap Include the
// source plane cannot supply.
const { boot } = createRequire(import.meta.url)(join(REPO_ROOT, 'packages/boot/app-boot/lib/index.js')) as typeof import('@deepseek-ai/dsh-app-boot')
/** The installation anchor whose dependency surface the runtime resolution mirrors. */
const INSTALL_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')
const HARD_BUNDLE_DIR = join(REPO_ROOT, 'packages/experimental/hard-bundle')
const MISSION = 'Hunt vulnerabilities in this repository; only verified findings count.'

function records(content: string) {
  return content.split('\n').filter(Boolean).map((line: string) => JSON.parse(line) as Record<string, unknown>)
}

describe('the hard-web profile boots the hard harness inside the Web composition', () => {
  it('activates every hard plugin and arms the mission in the durable session log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hard-web-boot-'))
    try {
      // The mission target is a real git repository: pinning resolves the commit
      // and enumerates the tracked modules at load time. Config isolation keeps a
      // developer's global gitconfig out of the run.
      const target = join(root, 'target')
      await mkdir(join(target, 'src'), { recursive: true })
      await writeFile(join(target, 'src', 'handler.js'), 'module.exports = {}\n')
      const git = (...args: string[]) => execFileSync('git', ['-C', target, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      })
      git('init', '--quiet')
      git('add', '-A')
      git('-c', 'user.name=hard-web-e2e', '-c', 'user.email=hard-web@e2e', 'commit', '--quiet', '-m', 'seed')
      const commit = git('rev-parse', 'HEAD').trim()

      const home = join(root, '.dsh')
      const sessions = join(home, 'sessions')
      const profileDir = join(home, 'profiles', 'hard-web')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-hard-web',
        private: true,
        dependencies: {
          '@deepseek-ai/dsh-experimental-hard-bundle': 'workspace:*',
        },
        dsh: {
          profile: {
            bundles: [
              '@deepseek-ai/dsh-base',
              '@deepseek-ai/dsh-web-app',
              '@deepseek-ai/dsh-experimental-hard-bundle',
            ],
          },
        },
      }, undefined, 2) + '\n')
      // The bundle is not an installation dependency, so the profile directory is
      // its only resolution anchor — the same link an out-of-tree install makes.
      await mkdir(join(profileDir, 'node_modules', '@deepseek-ai'), { recursive: true })
      await symlink(HARD_BUNDLE_DIR, join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-experimental-hard-bundle'), 'junction')
      // The user patch layer supplies what the bundle ships as blanks; the
      // mission fails the load until real values are set.
      await writeFile(join(profileDir, 'cordis.patch.yml'), [
        '- id: hard-mission',
        '  config:',
        `    objective: '${MISSION}'`,
        '    target:',
        `      repoPath: '${target}'`,
        '    bugClasses: [cmdi, sqli]',
        '',
      ].join('\n'))
      const profile = loadProfile('dsh-test', 'hard-web', INSTALL_ANCHOR, home)
      expect(profile.skippedBundles).toEqual([])
      const resolution = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, home, profile })

      // Host rows with side effects outside this process stay off; every agent
      // capability row stays on, so a hard plugin that waits for a missing Web
      // service still surfaces as a pending entry in the boot audit.
      const overrides: PatchOptions[] = [
        { id: 'storage-json', config: { root: join(home, 'storages') } },
        { id: 'session-persistence-jsonl', config: { root: sessions, compression: 'none' } },
        { id: 'webserver', disabled: true },
        { id: 'hmr', disabled: true },
        { id: 'web-runtime', disabled: true },
        { id: 'session-telemetry-otel', disabled: true },
        { id: 'modules', disabled: true },
        { id: 'connection', disabled: true },
        { id: 'session-log-download', disabled: true },
        { id: 'open-in-app', disabled: true },
        { id: 'client-hmr', disabled: true },
        { id: 'directory-picker', disabled: true },
        { insert: [
          { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
          { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
        ] },
        { id: 'agent-preset-registry', config: { default: 'standard' } },
      ]
      const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      const rootConfig = join(profileDir, 'cordis.yml')
      await writeFile(rootConfig, '[]\n')
      const ctx = await boot('dsh-test', rootConfig, [...profile.layers.flatMap(layer => layer.patches), ...profile.patches, ...overrides], async (bootCtx) => {
        bootCtx.provide('profileContext', { name: 'hard-web', dir: profileDir, patchPath: profile.patchPath,
          installAnchor: INSTALL_ANCHOR, home, cwd: home,
          startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-hard-bundle'],
          overlays: [], telemetryDisabledEnv: '1' })
        await bootCtx.plugin(PluginPackages, { resolution })
        bootCtx.provide('connection', {
          fetch: { register: () => () => {} },
          rpc: { intercept: () => () => {} },
        } as never)
        provideCmdline(bootCtx, { args: [], exit: () => {} })
      })
      // The boot audit runs inside boot(): every inactive entry would have
      // written this warning before the promise resolved. mockRestore resets
      // the call log, so the lines are captured before restoring.
      const bootWarnings = warn.mock.calls.map(call => String(call[0]))
      warn.mockRestore()
      expect(bootWarnings.filter(line => line.includes('did not activate'))).toEqual([])
      // A bundle neither anchor resolves throws before boot; this tripwire
      // covers the diagnostic text should the failure ever surface as a warning.
      expect(bootWarnings.filter(line => line.includes('cannot resolve profile bundle'))).toEqual([])

      const handle = await ctx.agents.create({
        sessionId: SessionId('hard-web-boot-proof'),
        setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
      })
      // The armed events route into the session's write handle; the backend's
      // flush barrier materializes the durable artifact this assertion reads.
      await ctx.get('sessionPersistence')?.flush()
      // The hard tool surface registers into the composition: the Web agent
      // catalogs it like any other tool, so a dropped row fails here too.
      expect(ctx.tools.schemas(handle.agent).map(schema => schema.name)
        .filter(name => name.startsWith('hard_')).sort()).toEqual([
        'hard_clear_modules',
        'hard_mark_coverage',
        'hard_submit_finding',
        'hard_sweep_summary',
        'hard_update_hypothesis',
      ])
      await handle.dispose()
      const armed = records(await readSessionLog(sessions))
        .find(event => event.type === 'hard/mission/armed')
      expect(armed).toBeDefined()
      expect(armed?.data).toMatchObject({
        objective: MISSION,
        targetRepo: target,
        commit,
        modules: ['src'],
      })
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})

async function readSessionLog(sessions: string): Promise<string> {
  const entries = await readdir(sessions, { recursive: true })
  const logs = entries.filter(entry => entry.endsWith('.jsonl'))
  if (logs.length === 0) throw new Error(`no session log under ${sessions}`)
  logs.sort()
  return readFile(join(sessions, logs.at(-1) as string), 'utf8')
}
