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
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
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
  { k: 'header', format: 3 },
  { k: 'file', path: 'wp-admin/admin-ajax.php' },
  { k: 'method', id: 'wp-admin/admin-ajax.php:<global>', name: '<global>', file: 'wp-admin/admin-ajax.php', owner: null, fileLevel: true, annotations: [], line: 1, end: 9 },
  { k: 'method', id: 'wp_ajax_save', name: 'wp_ajax_save', file: 'ajax.php', owner: null, fileLevel: false, annotations: [], line: 3, end: 8 },
  { k: 'method', id: 'save_post', name: 'save_post', file: 'post.php', owner: null, fileLevel: false, annotations: [], line: 1, end: 2 },
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
/** A shell on the `shell` key; these specs never read cited lines. */
class UnusedShell extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }
}

async function harness(config: hardFeatureMap.Config = {}, arm = true) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  new UnusedShell(ctx)
  await ctx.plugin(HardLedger, {})
  const cpg = new FakeCpg(ctx)
  dbSeq += 1
  const fiber = await ctx.plugin(HardFeatureMap, Object.assign({ enabled: true, dbPath: join(root, `map-${dbSeq}.db`), frameworks: ['wordpress'], indexOnArm: false }, config))
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

  it('refuses a guard pattern that is not a regular expression', () => {
    expect(() => new HardFeatureMap(new Context(), { csrfGuardPattern: '(' })).toThrow('csrfGuardPattern is not a valid regular expression')
  })

  it('refuses check tunables out of range', () => {
    expect(() => new HardFeatureMap(new Context(), { featureDepth: 0 })).toThrow('featureDepth must be a safe integer from 1 through 8')
    expect(() => new HardFeatureMap(new Context(), { featureDepth: 2, requiredDepth: 3 })).toThrow('requiredDepth must be a safe integer from 1 through 2')
    expect(() => new HardFeatureMap(new Context(), { maxExcludedPercent: 101 })).toThrow('maxExcludedPercent must be a safe integer from 0 through 100')
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

  it('reads the configured frameworks in profile order, once each', async () => {
    const { ctx, agent } = await harness({ frameworks: ['express', 'wordpress', 'express'] })
    const snapshot = await ctx.hardFeatureMap.index(agent)
    expect(snapshot.stats.entryPoints).toBe(2)
  })

  it('declares its service dependencies and the WordPress script directories', () => {
    expect(HardFeatureMap.inject).toEqual(['agents', 'hardLedger', 'hardCpg', 'shell', 'tools', 'systemPrompt'])
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
    const indexed = agent.session.snapshotEvents().filter(event => event.type === 'hard/featuremap/indexed')
    expect(indexed.map(event => event.data)).toEqual([{
      commit: COMMIT,
      derivation: expect.stringMatching(/^[0-9a-f]{16}$/) as string,
      entryPoints: [{ key: 'ajax:save', handler: 'wp_ajax_save' }, { key: 'script:wp-admin/admin-ajax.php', handler: 'wp-admin/admin-ajax.php:<global>' }],
    }])
    expect(ctx.hardLedger.unmappedEntryPoints(agent)).toEqual(['ajax:save', 'script:wp-admin/admin-ajax.php'])
  })

  it('registers the feature map tools and section only while enabled, and removes them on disposal', async () => {
    const names = ['hard_query_map', 'hard_record_feature', 'hard_link_feature']
    const off = await harness({ enabled: false })
    expect(names.map(name => off.ctx.tools.get(name))).toEqual([undefined, undefined, undefined])
    expect((await off.ctx.systemPrompt.assemble()).sections.some(section => section.name === 'hard:feature-map')).toBe(false)
    const on = await harness()
    expect(names.map(name => on.ctx.tools.get(name)?.name)).toEqual(names)
    const section = (await on.ctx.systemPrompt.assemble()).sections.find(item => item.name === 'hard:feature-map')
    expect(section?.text).toBe(hardFeatureMap.FEATURE_MAP_SECTION)
    await on.fiber.dispose()
    expect(names.map(name => on.ctx.tools.get(name))).toEqual([undefined, undefined, undefined])
  })

  it('shares one import between concurrent requests', async () => {
    const { ctx, agent } = await harness()
    const [a, b] = await Promise.all([ctx.hardFeatureMap.index(agent), ctx.hardFeatureMap.index(agent)])
    expect(b).toEqual(a)
  })

  it('imports call edges only without a framework profile, as a separate derivation', async () => {
    const { ctx, agent } = await harness({ frameworks: [], dbPath: join(root, 'shared.db') })
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
  async function armed(failure?: Error, config: hardFeatureMap.Config = {}) {
    const { ctx, cpg } = await harness(Object.assign({ indexOnArm: true }, config), false)
    cpg.failure = failure
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const stranger = ctx.sessions.create(SessionId(`no-agent-${Math.random()}`))
    ctx.hardLedger.recordMissionArmed({ session: stranger } as Agent, ARMED)
    const agent = stubAgent(ctx, `armed-${Math.random()}`)
    const inject = vi.spyOn(agent, 'inject')
    await ctx.agents.register(agent)
    agent.session.append('compaction/start', { compactionId: CompactionId('k1'), turn: 1 })
    ctx.hardLedger.recordMissionArmed(agent, ARMED)
    await vi.waitFor(() => {
      expect(info.mock.calls.length + warn.mock.calls.length).toBe(1)
    })
    return { info, warn, inject }
  }

  it('imports in the background, logs the edge counts, and tells the model to map while sweeping', async () => {
    const { info, inject } = await armed()
    const ready = /^hard-featuremap: snapshot \d+ for b{40} ready: 1 joern, 0 repair, 0 unique-name, 0 hook edges, 2 entry points$/
    expect(info).toHaveBeenCalledWith(expect.stringMatching(ready))
    await vi.waitFor(() => {
      expect(inject).toHaveBeenCalledTimes(1)
    })
    expect(inject.mock.calls[0]?.[0]).toMatchObject({
      source: { kind: 'hard-featuremap' },
      content: [{ type: 'text', text: hardFeatureMap.featureMapReady(['ajax:save', 'script:wp-admin/admin-ajax.php']) }],
    })
  })

  it('injects no notice when the map holds no entry points', async () => {
    const { inject } = await armed(undefined, { frameworks: [] })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(inject).not.toHaveBeenCalled()
  })

  it('counts entry points per kind in the ready notice', () => {
    expect(hardFeatureMap.featureMapReady(['ajax:a', 'rest:b', 'ajax:c'])).toBe(
      '<hard_feature_map> The feature map of the pinned commit is ready: 3 entry points (2 ajax, 1 rest). '
      + 'Map features while you sweep, not after: whenever you have read the code behind an entry point, record its feature with '
      + 'hard_record_feature before moving on; hard_query_map view entry-points with unmapped_only true lists what is left.',
    )
  })

  it('logs a failed background import instead of raising', async () => {
    const { warn } = await armed(new Error('joern crashed'))
    expect(warn).toHaveBeenCalledWith('hard-featuremap: indexing on arming failed: Error: joern crashed')
  })
})
