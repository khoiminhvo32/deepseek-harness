/** The feature map tools read the map, record features only after the completeness check passes, and link features;
 * a citation outside the reach is read from the pinned commit through the shell seam. */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import type { HardCpgFacts } from '@deepseek-ai/dsh-experimental-hard-cpg'
import { FEATURE_GRAPH_PATH, HardFeatureMap, SYMBOL_DETAIL_PATH } from '@deepseek-ai/dsh-experimental-hard-featuremap'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const root = await mkdtemp(join(tmpdir(), 'hard-featuremap-tools-'))
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The pinned target: ajax.php line 9 calls log_change through a computed name the graph does not see. */
const repo = join(root, 'target')
await mkdir(repo)
await writeFile(join(repo, 'ajax.php'), ['<?php', 'function wp_ajax_save() {', '  check_ajax_referer("save");', '  save_post();', '}', 'function wp_ajax_trash() {', '  current_user_can("delete_posts");', '  update_post_meta(1, "trashed", 1);', '  $fn = "log_" . "change"; $fn(); // log_change()', '}', ''].join('\n'))
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV })
git('init', '--quiet')
git('add', '-A')
git('-c', 'user.name=hard-test', '-c', 'user.email=hard@test', 'commit', '--quiet', '-m', 'seed')
const COMMIT = git('rev-parse', 'HEAD').trim()
const gitDir = join(root, 'snapshots', 'target.git')
execFileSync('git', ['clone', '--quiet', '--bare', repo, gitDir], { env: GIT_ENV })

const factsPath = join(root, 'cpg', 'facts.jsonl')
await mkdir(join(root, 'cpg'))
const method = (id: string, line: number) => ({ k: 'method', id, name: id, file: 'ajax.php', owner: null, fileLevel: false, annotations: [], line, end: line + 2 })
const call = (caller: string, name: string, line: number, args: unknown[] = []) => ({ k: 'call', caller, name, target: name, resolved: [name], file: 'ajax.php', line, dispatch: 'static', args })
await writeFile(factsPath, [
  { k: 'header', format: 3 },
  { k: 'file', path: 'ajax.php' },
  method('wp_ajax_save', 2), method('wp_ajax_trash', 6), method('check_ajax_referer', 20), method('current_user_can', 30),
  method('save_post', 40), method('update_post_meta', 50), method('log_change', 60),
  { ...method('ghost', 0), line: null, end: null }, { ...method('open_end', 1), end: null },
  call('wp_ajax_save', 'check_ajax_referer', 3), call('wp_ajax_save', 'save_post', 4), call('save_post', 'update_post_meta', 41),
  call('wp_ajax_trash', 'current_user_can', 7), call('wp_ajax_trash', 'update_post_meta', 8),
  { k: 'end' },
].map(row => JSON.stringify(row)).join('\n') + '\n')

class FakeCpg extends Service {
  constructor(ctx: Context) {
    super(ctx, 'hardCpg')
  }

  facts(): Promise<HardCpgFacts> {
    return Promise.resolve({ commit: COMMIT, path: factsPath, counts: { files: 1, types: 0, methods: 7, calls: 5 }, reused: true })
  }
}

/** A shell on the `shell` key that runs commands with /bin/sh. */
class LocalShell extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }

  resolve(request: { command: string; workdir: string }) {
    return request
  }

  execute(spec: { command: string; workdir: string }) {
    const stdout = execFileSync('/bin/sh', ['-c', spec.command], { cwd: spec.workdir, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'ignore'] })
    const result = { exitCode: 0, timedOut: false, aborted: false, stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false } }
    return Promise.resolve({ result: () => Promise.resolve(result) })
  }
}

/** A Web connection on the `connection` key that keeps the registered fetch routes. */
class FakeConnection extends Service {
  readonly routes = new Map<string, ConnectionFetchRoute>()
  readonly fetch = {
    register: (route: ConnectionFetchRoute) => {
      this.routes.set(route.path, route)
      return () => {
        this.routes.delete(route.path)
        return Promise.resolve()
      }
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  async get(path: string, query: Record<string, string>): Promise<{ status: number; body: unknown }> {
    const route = this.routes.get(path)
    if (route === undefined) throw new Error(`no route ${path}`)
    const response = await route.fetch(new Request(`http://host${path}?${new URLSearchParams(query).toString()}`))
    return { status: response.status, body: await response.json() }
  }
}

let seq = 0
async function harness(arm: 'snapshot' | 'legacy' = 'snapshot') {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(HardLedger, {})
  new FakeCpg(ctx)
  new LocalShell(ctx)
  const web = new FakeConnection(ctx)
  seq += 1
  await ctx.plugin(HardFeatureMap, {
    enabled: true, dbPath: join(root, `map-${seq}.db`), frameworks: ['wordpress'], scriptDirs: ['none'], indexOnArm: false,
    requiredDepth: 1, guards: ['check_ajax_referer', 'current_user_can'], mutations: ['update_post_meta'],
  })
  const session = ctx.sessions.create(SessionId(`tools-${Math.random()}`), { meta: { cwd: repo } })
  const agent: Agent = {
    id: session.id, options: {}, session, inbox: createInboxStub(), status: 'running', ctx,
    send: () => {}, followup: () => {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  ctx.hardLedger.recordMissionArmed(agent, {
    objective: 'audit', targetRepo: repo, commit: COMMIT, modules: ['.'], bugClasses: ['logic'],
    ...arm === 'snapshot' ? { snapshot: { gitDir, kind: 'git' as const } } : {},
  })
  return { ctx, agent, web }
}

async function run(ctx: Context, agent: Agent | undefined, name: string, args: unknown): Promise<ToolExecutionResult> {
  const call = () => ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`call-${Math.random()}`), name, arguments: args, ...agent === undefined ? {} : { agent } })
  return agent === undefined ? call() : ctx.agents.withInitiator(agent, call)
}

function json(result: ToolExecutionResult): Record<string, unknown> {
  const block = result.content[0]
  if (result.isError || block?.type !== 'text') throw new Error(`expected success, got ${JSON.stringify(result.content)}`)
  return JSON.parse(block.text) as Record<string, unknown>
}

function errorText(result: ToolExecutionResult): string {
  const block = result.content[0]
  expect(result.isError).toBe(true)
  return block?.type === 'text' ? block.text : ''
}

const SAVE = {
  name: 'Save a post',
  summary: 'An editor saves a post over admin-ajax.',
  entry_points: ['ajax:save'],
  symbols: [
    { symbol: 'wp_ajax_save', role: 'entry' },
    { symbol: 'check_ajax_referer', role: 'guard' },
    { symbol: 'save_post', role: 'helper' },
    { symbol: 'update_post_meta', role: 'mutation' },
  ],
  states: [{ kind: 'meta', key: 'postmeta', access: 'write' }],
}

describe('hard_query_map', () => {
  it('lists entry points, finds symbols, reads edges, and computes the required set', async () => {
    const { ctx, agent } = await harness()
    expect(json(await run(ctx, agent, 'hard_query_map', { view: 'entry-points' }))).toEqual({
      total: 2,
      offset: 0,
      items: [
        { key: 'ajax:save', handler: 'wp_ajax_save', auth: 'authenticated', guards: [], mapped: false },
        { key: 'ajax:trash', handler: 'wp_ajax_trash', auth: 'authenticated', guards: [], mapped: false },
      ],
    })
    expect(json(await run(ctx, agent, 'hard_query_map', { view: 'entry-points', kind: 'rest' }))).toEqual({ total: 0, offset: 0, items: [] })
    expect(json(await run(ctx, agent, 'hard_query_map', { view: 'entry-points', offset: 1, limit: 1 }))).toMatchObject({ total: 2, offset: 1, items: [{ key: 'ajax:trash' }] })
    // An underscore is literal, not a LIKE wildcard: save_post has no "post_".
    expect(json(await run(ctx, agent, 'hard_query_map', { view: 'symbol', symbol: 'post_' }))).toMatchObject({ items: [{ id: 'update_post_meta' }] })
    expect(json(await run(ctx, agent, 'hard_query_map', { view: 'symbol', symbol: 'POST' }))).toEqual({
      items: [
        expect.objectContaining({ id: 'save_post', kind: 'function', file: 'ajax.php' }),
        expect.objectContaining({ id: 'update_post_meta' }),
      ],
    })
    expect(json(await run(ctx, agent, 'hard_query_map', { view: 'callers', symbol: 'update_post_meta' }))).toMatchObject({
      symbol: 'update_post_meta', total: 2, items: [{ caller: 'wp_ajax_trash', source: 'joern' }, { caller: 'save_post', source: 'joern' }],
    })
    expect(json(await run(ctx, agent, 'hard_query_map', { view: 'callees', symbol: 'wp_ajax_save' }))).toMatchObject({ total: 2 })
    expect(json(await run(ctx, agent, 'hard_query_map', { view: 'required', entry_points: ['ajax:save'] }))).toEqual({
      handlers: ['wp_ajax_save'],
      reach: 4,
      library: 0,
      total: 4,
      offset: 0,
      items: [
        { symbol: 'wp_ajax_save', reasons: ['entry'] },
        { symbol: 'check_ajax_referer', reasons: ['near', 'guard'] },
        { symbol: 'save_post', reasons: ['near'] },
        { symbol: 'update_post_meta', reasons: ['mutation'] },
      ],
    })
  })

  it('reports a view without its input', async () => {
    const { ctx, agent } = await harness()
    expect(errorText(await run(ctx, agent, 'hard_query_map', { view: 'callers' }))).toContain('symbol is required for this view')
    expect(errorText(await run(ctx, agent, 'hard_query_map', { view: 'symbol', symbol: '  ' }))).toContain('symbol is required for this view')
    expect(errorText(await run(ctx, agent, 'hard_query_map', { view: 'required' }))).toContain('view required needs entry_points')
    expect(errorText(await run(ctx, agent, 'hard_query_map', { view: 'required', entry_points: ['ajax:none'] }))).toContain('entry point ajax:none is not in the feature map or has no resolved handler')
    expect(errorText(await run(ctx, undefined, 'hard_query_map', { view: 'entry-points' }))).toContain('hard_query_map requires a live agent')
  })
})

describe('hard_record_feature', () => {
  it('refuses an incomplete feature with every shortfall and records a complete one', async () => {
    const { ctx, agent } = await harness()
    const refused = errorText(await run(ctx, agent, 'hard_record_feature', { ...SAVE, symbols: SAVE.symbols.slice(0, 2) }))
    expect(refused).toContain('hard_record_feature refused — 2 required symbols are neither members nor excluded: save_post (near); update_post_meta (mutation)')
    expect(ctx.hardLedger.features(agent)).toEqual([])
    expect(json(await run(ctx, agent, 'hard_record_feature', SAVE))).toEqual({ feature: { id: 'FE-1' }, check: { reach: 4, required: 4 }, unmappedEntryPoints: 1 })
    expect(ctx.hardLedger.features(agent)[0]).toMatchObject({ id: 'FE-1', entryPoints: ['ajax:save'], check: { commit: COMMIT, reach: 4, required: 4 } })
    expect(json(await run(ctx, agent, 'hard_query_map', { view: 'entry-points', unmapped_only: true }))).toMatchObject({ total: 1, items: [{ key: 'ajax:trash' }] })
    const revised = { ...SAVE, feature_id: ' FE-1 ', summary: 'Revised.', symbols: SAVE.symbols.filter(member => member.symbol !== 'save_post'), excluded: [{ symbol: 'save_post', reason: 'other-feature', note: 'shared' }, { symbol: 'log_change', reason: 'unreachable' }] }
    expect(json(await run(ctx, agent, 'hard_record_feature', revised))).toMatchObject({ feature: { id: 'FE-1' } })
    expect(ctx.hardLedger.features(agent)).toHaveLength(1)
    expect(errorText(await run(ctx, undefined, 'hard_record_feature', SAVE))).toContain('hard_record_feature requires a live agent')
  })

  it('reads a cited call outside the reach from the pinned commit', async () => {
    const { ctx, agent } = await harness()
    const trash = {
      name: 'Trash a post',
      summary: 'An editor trashes a post and the change is logged.',
      entry_points: ['ajax:trash'],
      symbols: [{ symbol: 'wp_ajax_trash', role: 'entry' }, { symbol: 'current_user_can', role: 'guard' }, { symbol: 'update_post_meta', role: 'mutation' }, { symbol: 'log_change', role: 'helper' }],
    }
    expect(errorText(await run(ctx, agent, 'hard_record_feature', trash))).toContain('log_change is outside the reach')
    expect(errorText(await run(ctx, agent, 'hard_record_feature', { ...trash, via: [{ symbol: 'log_change', caller: 'wp_ajax_trash', line: 8 }] }))).toContain('the via line ajax.php:8 does not mention log_change')
    expect(errorText(await run(ctx, agent, 'hard_record_feature', { ...trash, via: [{ symbol: 'log_change', caller: 'wp_ajax_trash', line: 99 }] }))).toContain('the via line ajax.php:99 for log_change does not exist at the pinned commit')
    expect(json(await run(ctx, agent, 'hard_record_feature', { ...trash, via: [{ symbol: 'log_change', caller: 'wp_ajax_trash', line: 9 }] }))).toMatchObject({ feature: { id: 'FE-1' } })
  })

  it('cannot read citations without a harness snapshot', async () => {
    const { ctx, agent } = await harness('legacy')
    const result = await run(ctx, agent, 'hard_record_feature', {
      name: 'Trash', summary: 'Trash a post.', entry_points: ['ajax:trash'],
      symbols: [{ symbol: 'wp_ajax_trash', role: 'entry' }, { symbol: 'current_user_can', role: 'guard' }, { symbol: 'update_post_meta', role: 'mutation' }, { symbol: 'log_change', role: 'helper' }],
      via: [{ symbol: 'log_change', caller: 'wp_ajax_trash', line: 9 }],
    })
    expect(errorText(result)).toContain('the via line ajax.php:9 for log_change does not exist at the pinned commit')
  })
})

describe('hard_link_feature', () => {
  it('links recorded features and passes ledger refusals through', async () => {
    const { ctx, agent } = await harness()
    json(await run(ctx, agent, 'hard_record_feature', SAVE))
    json(await run(ctx, agent, 'hard_record_feature', { ...SAVE, name: 'Save again' }))
    expect(json(await run(ctx, agent, 'hard_link_feature', { from: 'FE-1 ', to: 'FE-2', kind: 'shares-state', note: 'both write postmeta' }))).toEqual({ linked: { from: 'FE-1', to: 'FE-2', kind: 'shares-state' } })
    expect(ctx.hardLedger.featureLinks(agent)).toEqual([{ from: 'FE-1', to: 'FE-2', kind: 'shares-state', note: 'both write postmeta' }])
    expect(errorText(await run(ctx, agent, 'hard_link_feature', { from: 'FE-1', to: 'FE-9', kind: 'calls', note: 'x' }))).toContain('unknown feature id FE-9')
    expect(errorText(await run(ctx, undefined, 'hard_link_feature', { from: 'FE-1', to: 'FE-2', kind: 'calls', note: 'x' }))).toContain('hard_link_feature requires a live agent')
  })

  it('presents each call compactly', async () => {
    const { ctx } = await harness()
    expect(ctx.tools.get('hard_query_map')?.presentCall?.({ view: 'symbol' })).toEqual({ card: 'generic', title: 'Feature map: symbol', kind: 'other', rawInput: { view: 'symbol' } })
    expect(ctx.tools.get('hard_record_feature')?.presentCall?.(SAVE)).toEqual({ card: 'generic', title: 'Feature: Save a post', kind: 'other', rawInput: 'ajax:save' })
    expect(ctx.tools.get('hard_link_feature')?.presentCall?.({ from: 'FE-1', to: 'FE-2', kind: 'calls', note: 'n' })).toEqual({ card: 'generic', title: 'Feature link: FE-1 calls FE-2', kind: 'other', rawInput: 'n' })
  })
})

describe('panel routes', () => {
  const SAVE_WITHOUT_HELPER = {
    ...SAVE,
    symbols: SAVE.symbols.filter(member => member.symbol !== 'save_post'),
    excluded: [{ symbol: 'save_post', reason: 'utility' }],
  }

  it('answer a recorded feature\'s symbol graph with each role and edge rule', async () => {
    const { ctx, agent, web } = await harness()
    json(await run(ctx, agent, 'hard_record_feature', SAVE_WITHOUT_HELPER))
    const graph = await web.get(FEATURE_GRAPH_PATH, { session: agent.id, feature: 'FE-1' })
    expect(graph.status).toBe(200)
    expect(graph.body).toEqual({
      feature: 'FE-1',
      nodes: [
        { id: 'save_post', name: 'save_post', role: 'excluded', file: 'ajax.php', line: 40 },
        { id: 'wp_ajax_save', name: 'wp_ajax_save', role: 'entry', file: 'ajax.php', line: 2 },
        { id: 'check_ajax_referer', name: 'check_ajax_referer', role: 'guard', file: 'ajax.php', line: 20 },
        { id: 'update_post_meta', name: 'update_post_meta', role: 'mutation', file: 'ajax.php', line: 50 },
      ],
      edges: [
        { from: 'save_post', to: 'update_post_meta', source: 'joern' },
        { from: 'wp_ajax_save', to: 'check_ajax_referer', source: 'joern' },
        { from: 'wp_ajax_save', to: 'save_post', source: 'joern' },
      ],
    })
    expect(await web.get(FEATURE_GRAPH_PATH, { session: agent.id, feature: 'FE-9' })).toEqual({ status: 404, body: { error: 'no feature FE-9' } })
  })

  it('answer a symbol\'s edges and its lines at the pinned commit', async () => {
    const { ctx, agent, web } = await harness()
    const detail = await web.get(SYMBOL_DETAIL_PATH, { session: agent.id, symbol: 'wp_ajax_save' })
    expect(detail).toEqual({
      status: 200,
      body: {
        symbol: { id: 'wp_ajax_save', name: 'wp_ajax_save', kind: 'function', owner: null, file: 'ajax.php', line: 2, end: 4 },
        callers: [],
        callees: [
          { caller: 'wp_ajax_save', callee: 'check_ajax_referer', file: 'ajax.php', line: 3, source: 'joern' },
          { caller: 'wp_ajax_save', callee: 'save_post', file: 'ajax.php', line: 4, source: 'joern' },
        ],
        source: { startLine: 2, lines: ['function wp_ajax_save() {', '  check_ajax_referer("save");', '  save_post();'], truncated: false },
      },
    })
    // log_change sits past the end of the pinned file.
    expect((await web.get(SYMBOL_DETAIL_PATH, { session: agent.id, symbol: 'log_change' })).body).toMatchObject({ source: null })
    expect(await web.get(SYMBOL_DETAIL_PATH, { session: agent.id, symbol: 'missing' })).toEqual({ status: 404, body: { error: 'no symbol missing' } })
    expect(await ctx.hardFeatureMap.featureGraph(agent, 'FE-1')).toBeUndefined()
    // A symbol without a location has no source; one without an end line reads its first line.
    expect((await web.get(SYMBOL_DETAIL_PATH, { session: agent.id, symbol: 'ghost' })).body).toMatchObject({ source: null })
    expect((await web.get(SYMBOL_DETAIL_PATH, { session: agent.id, symbol: 'open_end' })).body).toMatchObject({ source: { startLine: 1, lines: ['<?php'], truncated: false } })
    // A feature recorded against another derivation can name a symbol this snapshot lacks.
    ctx.hardLedger.recordFeature(agent, { name: 'Old', summary: 'Recorded earlier.', entryPoints: [], symbols: [{ symbol: 'renamed', role: 'helper' }], excluded: [], states: [], check: { commit: COMMIT, reach: 0, required: 0 } })
    expect(await ctx.hardFeatureMap.featureGraph(agent, 'FE-1')).toEqual({ feature: 'FE-1', nodes: [{ id: 'renamed', name: 'renamed', role: 'helper', file: null, line: null }], edges: [] })
  })

  it('refuse a request without its parameters or live agent, and report a failed read', async () => {
    const { ctx, agent, web } = await harness()
    expect(await web.get(SYMBOL_DETAIL_PATH, { session: agent.id })).toEqual({ status: 400, body: { error: 'session and symbol are required' } })
    expect(await web.get(FEATURE_GRAPH_PATH, { session: '', feature: 'FE-1' })).toEqual({ status: 400, body: { error: 'session and feature are required' } })
    expect(await web.get(FEATURE_GRAPH_PATH, { session: 'gone', feature: 'FE-1' })).toEqual({ status: 404, body: { error: 'session gone has no live agent' } })
    vi.spyOn(ctx.hardFeatureMap, 'symbolDetail').mockRejectedValueOnce(new Error('store closed'))
    expect(await web.get(SYMBOL_DETAIL_PATH, { session: agent.id, symbol: 'wp_ajax_save' })).toEqual({ status: 409, body: { error: 'Error: store closed' } })
  })

  it('register only beside a Web connection and leave on disposal', async () => {
    const { ctx, web } = await harness()
    expect([...web.routes.keys()]).toEqual([FEATURE_GRAPH_PATH, SYMBOL_DETAIL_PATH])
    await ctx.fiber.dispose()
    expect(web.routes.size).toBe(0)
  })
})
