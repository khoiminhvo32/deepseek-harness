/** The feature map service imports the pinned commit's facts once per derivation, shares concurrent imports, and
 * answers queries from the shared database. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import type { HardMissionArmedData } from '@deepseek-ai/dsh-experimental-hard-ledger'
import type { HardCpgFacts } from '@deepseek-ai/dsh-experimental-hard-cpg'
import * as hardFeatureMap from '@deepseek-ai/dsh-experimental-hard-featuremap'
import { HardFeatureMap, WORDPRESS_SCRIPT_DIRS } from '@deepseek-ai/dsh-experimental-hard-featuremap'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const root = await mkdtemp(join(tmpdir(), 'hard-featuremap-'))
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(() => {
  vi.restoreAllMocks()
})

const COMMIT = 'b'.repeat(40)
const factsDir = join(root, 'cpg', COMMIT, '0123456789abcdef')
const factsPath = join(factsDir, 'facts.jsonl')
await (await import('node:fs/promises')).mkdir(factsDir, { recursive: true })
await writeFile(factsPath, [
  { k: 'header', format: 2 },
  { k: 'file', path: 'wp-admin/admin-ajax.php' },
  { k: 'method', id: 'wp-admin/admin-ajax.php:<global>', name: '<global>', file: 'wp-admin/admin-ajax.php', owner: null, line: 1, end: 9 },
  { k: 'method', id: 'wp_ajax_save', name: 'wp_ajax_save', file: 'ajax.php', owner: null, line: 3, end: 8 },
  { k: 'method', id: 'save_post', name: 'save_post', file: 'post.php', owner: null, line: 1, end: 2 },
  { k: 'call', caller: 'wp_ajax_save', name: 'save_post', target: 'save_post', resolved: ['save_post'], file: 'ajax.php', line: 5, dispatch: 'static', args: [] },
  { k: 'call', caller: 'wp-admin/admin-ajax.php:<global>', name: 'add_action', target: 'add_action', resolved: [], file: 'wp-admin/admin-ajax.php', line: 4, dispatch: 'static', args: [{ lit: '"wp_ajax_save"' }, { lit: '"wp_ajax_save"' }] },
  { k: 'end' },
].map(row => JSON.stringify(row)).join('\n') + '\n')

/** A hard-cpg stand-in on the `hardCpg` key that serves the fixture facts or a scripted failure. */
class FakeCpg extends Service {
  requests = 0
  failure: Error | undefined

  constructor(ctx: Context) {
    super(ctx, 'hardCpg')
  }

  facts(): Promise<HardCpgFacts> {
    this.requests += 1
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return Promise.resolve({ commit: COMMIT, path: factsPath, counts: { files: 1, types: 0, methods: 3, calls: 2 }, reused: true })
  }
}

function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd: root } })
  return {
    id: session.id, options: {}, session, inbox: createInboxStub(), status: 'running', ctx,
    send: () => {}, followup: () => {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
}

const ARMED: HardMissionArmedData = { objective: 'audit', targetRepo: '/targets/wordpress', commit: COMMIT, modules: ['.'], bugClasses: ['logic'] }

let dbSeq = 0
async function harness(config: hardFeatureMap.Config = {}, arm = true) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(HardLedger, {})
  const cpg = new FakeCpg(ctx)
  dbSeq += 1
  const fiber = await ctx.plugin(HardFeatureMap, Object.assign({ enabled: true, dbPath: join(root, `map-${dbSeq}.db`), framework: 'wordpress', indexOnArm: false }, config))
  const agent = stubAgent(ctx, `mission-${Math.random()}`)
  await ctx.agents.register(agent)
  if (arm) ctx.hardLedger.recordMissionArmed(agent, ARMED)
  return { ctx, fiber, agent, cpg }
}

describe('hard-featuremap config', () => {
  it('refuses an enabled plugin without an absolute dbPath', () => {
    expect(() => new HardFeatureMap(new Context(), { enabled: true })).toThrow('dbPath must be an absolute path')
    expect(() => new HardFeatureMap(new Context(), { enabled: true, dbPath: 'map.db' })).toThrow('dbPath must be an absolute path')
  })

  it('refuses script directories outside the target', () => {
    for (const dir of ['', '/abs', '..', '../up']) {
      expect(() => new HardFeatureMap(new Context(), { scriptDirs: [dir] })).toThrow('scriptDirs entries must be repository-relative')
    }
  })

  it('accepts a disabled plugin and refuses work while disabled', async () => {
    expect(new HardFeatureMap(new Context()).enabled).toBe(false)
    const { ctx, agent } = await harness({ enabled: false })
    expect(ctx.hardFeatureMap.enabled).toBe(false)
    await expect(ctx.hardFeatureMap.index(agent)).rejects.toMatchObject({ code: 'HARD_FEATUREMAP_DISABLED' })
    await expect(ctx.hardFeatureMap.entryPoints(1)).rejects.toMatchObject({ code: 'HARD_FEATUREMAP_DISABLED' })
  })

  it('lists the configured script directories instead of the profile defaults', async () => {
    const { ctx, agent } = await harness({ scriptDirs: ['wp-includes'] })
    const snapshot = await ctx.hardFeatureMap.index(agent)
    expect((await ctx.hardFeatureMap.entryPoints(snapshot.id)).map(entry => entry.kind)).toEqual(['ajax'])
  })

  it('declares its service dependencies and the WordPress script directories', () => {
    expect(HardFeatureMap.inject).toEqual(['agents', 'hardLedger', 'hardCpg'])
    expect(WORDPRESS_SCRIPT_DIRS).toEqual(['.', 'wp-admin', 'wp-admin/network', 'wp-admin/user'])
  })
})

describe('hardFeatureMap.index', () => {
  it('needs an armed mission', async () => {
    const { ctx, agent, cpg } = await harness({}, false)
    await expect(ctx.hardFeatureMap.index(agent)).rejects.toMatchObject({ code: 'HARD_FEATUREMAP_NOT_ARMED' })
    expect(cpg.requests).toBe(0)
  })

  it('imports the facts under the WordPress profile, then reuses the import', async () => {
    const { ctx, agent } = await harness()
    const first = await ctx.hardFeatureMap.index(agent)
    expect(first).toMatchObject({ commit: COMMIT, reused: false, stats: { symbols: 3, callSites: 2, hooks: 1, entryPoints: 2 } })
    expect(await ctx.hardFeatureMap.callers(first.id, 'save_post')).toEqual([{ caller: 'wp_ajax_save', callee: 'save_post', file: 'ajax.php', line: 5, source: 'joern' }])
    expect(await ctx.hardFeatureMap.callees(first.id, 'wp_ajax_save')).toHaveLength(1)
    expect((await ctx.hardFeatureMap.entryPoints(first.id)).map(entry => entry.kind)).toEqual(['ajax', 'script'])
    expect(await ctx.hardFeatureMap.index(agent)).toEqual({ ...first, reused: true })
  })

  it('shares one import between concurrent requests', async () => {
    const { ctx, agent } = await harness()
    const [a, b] = await Promise.all([ctx.hardFeatureMap.index(agent), ctx.hardFeatureMap.index(agent)])
    expect(b).toEqual(a)
  })

  it('imports call edges only without a framework profile, as a separate derivation', async () => {
    const { ctx, agent } = await harness({ framework: 'none', dbPath: join(root, 'shared.db') })
    const plain = await ctx.hardFeatureMap.index(agent)
    expect(plain.stats).toMatchObject({ hooks: 0, entryPoints: 0, callSites: 2 })
    const wordpress = await harness({ dbPath: join(root, 'shared.db') })
    const profiled = await wordpress.ctx.hardFeatureMap.index(wordpress.agent)
    expect(profiled.id).not.toBe(plain.id)
    expect(profiled.reused).toBe(false)
  })

  it('passes a facts failure through', async () => {
    const { ctx, agent, cpg } = await harness()
    cpg.failure = new HarnessError('hard-cpg is disabled', 'HARD_CPG_DISABLED')
    await expect(ctx.hardFeatureMap.index(agent)).rejects.toMatchObject({ code: 'HARD_CPG_DISABLED' })
  })

  it('closes the database when the plugin is disposed', async () => {
    const { ctx, agent, fiber } = await harness()
    await ctx.hardFeatureMap.index(agent)
    const close = vi.spyOn(hardFeatureMap.HardFeatureMapStore.prototype, 'close')
    await fiber.dispose()
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1)
    })
  })
})

describe('indexing on arming', () => {
  async function armed(failure?: Error) {
    const { ctx, cpg } = await harness({ indexOnArm: true }, false)
    cpg.failure = failure
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const stranger = ctx.sessions.create(SessionId(`no-agent-${Math.random()}`))
    ctx.hardLedger.recordMissionArmed({ session: stranger } as Agent, ARMED)
    const agent = stubAgent(ctx, `armed-${Math.random()}`)
    await ctx.agents.register(agent)
    agent.session.append('compaction/start', { compactionId: CompactionId('k1'), turn: 1 })
    ctx.hardLedger.recordMissionArmed(agent, ARMED)
    await vi.waitFor(() => {
      expect(info.mock.calls.length + warn.mock.calls.length).toBe(1)
    })
    return { info, warn }
  }

  it('imports in the background and logs the edge counts', async () => {
    const { info } = await armed()
    const ready = /^hard-featuremap: snapshot \d+ for b{40} ready: 1 joern, 0 repair, 0 unique-name, 0 hook edges, 2 entry points$/
    expect(info).toHaveBeenCalledWith(expect.stringMatching(ready))
  })

  it('logs a failed background import instead of raising', async () => {
    const { warn } = await armed(new Error('joern crashed'))
    expect(warn).toHaveBeenCalledWith('hard-featuremap: indexing on arming failed: Error: joern crashed')
  })
})
