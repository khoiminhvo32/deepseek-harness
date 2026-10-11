/** With a real Joern installation (`JOERN_HOME`), the feature map imports a pinned PHP commit built through the
 * sandboxed shell, repairs the class-qualified free-function call Joern leaves unresolved, and links a fired hook to
 * its callback. Skips without `JOERN_HOME`. */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import HardCpg from '@deepseek-ai/dsh-experimental-hard-cpg'
import HardFeatureMap from '@deepseek-ai/dsh-experimental-hard-featuremap'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const joernHome = process.env['JOERN_HOME'] ?? ''
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

/** Boot hard-cpg and the feature map through the sandboxed shell over one pinned repository and arm a mission. */
async function boot(root: string, repo: string, language: 'php' | 'java', frameworks: ('wordpress' | 'spring')[]): Promise<{ ctx: Context; agent: Agent }> {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV })
  git('init', '--quiet')
  git('add', '-A')
  git('-c', 'user.name=hard-test', '-c', 'user.email=hard@test', 'commit', '--quiet', '-m', 'seed')
  const commit = git('rev-parse', 'HEAD').trim()
  const gitDir = join(root, 'snapshots', 'target.git')
  execFileSync('git', ['clone', '--quiet', '--bare', repo, gitDir], { env: GIT_ENV })
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxBashExecutor, { cwd: workspace, timeoutMs: 60_000 })
  await ctx.plugin(HardLedger, {})
  await ctx.plugin(HardCpg, { enabled: true, joernHome, language, heapMb: 2048, buildOnArm: false })
  await ctx.plugin(HardFeatureMap, { enabled: true, dbPath: join(root, 'featuremap.db'), frameworks, indexOnArm: false })
  const session = ctx.sessions.create(SessionId(`e2e-${Math.random()}`), { meta: { cwd: workspace } })
  const agent: Agent = {
    id: session.id, options: {}, session, inbox: createInboxStub(), status: 'running', ctx,
    send: () => {}, followup: () => {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  ctx.hardLedger.recordMissionArmed(agent, {
    objective: 'audit', targetRepo: repo, commit, modules: ['.'], bugClasses: ['logic'], snapshot: { gitDir, kind: 'git' },
  })
  return { ctx, agent }
}

describe.skipIf(joernHome === '')('hard-featuremap with Joern', () => {
  const roots: string[] = []
  const contexts: Context[] = []
  afterAll(async () => {
    await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  })

  it('repairs class-qualified free-function calls and links fired hooks', async () => {
    const root = await mkdtemp(join(homedir(), '.hard-featuremap-e2e-'))
    roots.push(root)
    const repo = join(root, 'target')
    await mkdir(join(repo, 'wp-admin'), { recursive: true })
    await writeFile(join(repo, 'post-api.php'), '<?php\nfunction wp_insert_post($post) { return 1; }\n')
    await writeFile(join(repo, 'post.php'), [
      '<?php',
      '// The free function lives in another file, as in WordPress, which is where Joern misresolves the call.',
      'class Saver { function save() { return wp_insert_post(array()); } }',
      'function on_init() {}',
      'add_action("init", "on_init");',
      'function boot() { do_action("init"); }',
      '',
    ].join('\n'))
    await writeFile(join(repo, 'wp-admin', 'admin-ajax.php'), '<?php\nadd_action("wp_ajax_save", "boot");\n')

    const booted = await boot(root, repo, 'php', ['wordpress'])
    contexts.push(booted.ctx)
    const { ctx, agent } = booted
    const snapshot = await ctx.hardFeatureMap.index(agent)
    expect(snapshot.reused).toBe(false)
    expect(await ctx.hardFeatureMap.callers(snapshot.id, 'wp_insert_post')).toEqual([
      { caller: 'Saver.save', callee: 'wp_insert_post', file: 'post.php', line: 3, source: 'repair' },
    ])
    expect(await ctx.hardFeatureMap.callees(snapshot.id, 'boot')).toContainEqual(
      { caller: 'boot', callee: 'on_init', file: 'post.php', line: 6, source: 'hook' },
    )
    expect(await ctx.hardFeatureMap.entryPoints(snapshot.id)).toContainEqual(
      { kind: 'ajax', key: 'save', handler: 'boot', file: 'wp-admin/admin-ajax.php', line: 2, auth: 'authenticated', guards: [], checks: [] },
    )
  }, 300_000)

  it('reads Spring routes with their prefix and guards from a Java commit', async () => {
    const root = await mkdtemp(join(homedir(), '.hard-featuremap-e2e-java-'))
    roots.push(root)
    const repo = join(root, 'target')
    await mkdir(join(repo, 'src', 'demo'), { recursive: true })
    await writeFile(join(repo, 'src', 'demo', 'PostController.java'), [
      'package demo;',
      'import org.springframework.web.bind.annotation.*;',
      'import org.springframework.security.access.prepost.PreAuthorize;',
      '@RestController',
      '@RequestMapping("/api/posts")',
      'public class PostController {',
      '  @GetMapping("/{id}") public String get(@PathVariable String id) { return load(id); }',
      '  @PostMapping @PreAuthorize("hasRole(\'ADMIN\')") public void create(@RequestBody String body) { save(body); }',
      '  String load(String id) { return id; }',
      '  void save(String b) {}',
      '}',
      '',
    ].join('\n'))
    const { ctx, agent } = await boot(root, repo, 'java', ['spring'])
    contexts.push(ctx)
    const snapshot = await ctx.hardFeatureMap.index(agent)
    const routes = (await ctx.hardFeatureMap.entryPoints(snapshot.id)).map(({ key, auth, guards }) => ({ key, auth, guards }))
    expect(routes).toEqual([
      { key: 'GET /api/posts/{id}', auth: 'unknown', guards: [] },
      { key: 'POST /api/posts', auth: 'authenticated', guards: ["PreAuthorize(hasRole('ADMIN'))"] },
    ])
    expect(await ctx.hardFeatureMap.callees(snapshot.id, 'demo.PostController.get:java.lang.String(java.lang.String)')).toEqual([
      expect.objectContaining({ callee: 'demo.PostController.load:java.lang.String(java.lang.String)', source: 'joern' }),
    ])
  }, 300_000)
})
