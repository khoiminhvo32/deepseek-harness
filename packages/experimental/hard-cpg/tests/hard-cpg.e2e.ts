/** With a real Joern installation (`JOERN_HOME`), the packaged query exports resolved calls and callback arrays
 * from a pinned PHP commit and leaves excluded paths out. Skips without `JOERN_HOME`. */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import { HardCpg, readHardCpgFacts } from '@deepseek-ai/dsh-experimental-hard-cpg'
import type { HardCpgFact } from '@deepseek-ai/dsh-experimental-hard-cpg'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const joernHome = process.env['JOERN_HOME'] ?? ''
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

/** A shell on the `shell` key that runs each command with `/bin/sh` in its workdir. */
class LocalShell extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }

  resolve(request: { command: string; workdir: string }) {
    return request
  }

  execute(spec: { command: string; workdir: string }) {
    let exitCode = 0
    let stderr = ''
    try {
      execFileSync('/bin/sh', ['-c', spec.command], { cwd: spec.workdir, env: GIT_ENV, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    } catch (error: unknown) {
      const failure = error as { status?: number | null; stderr?: Buffer }
      exitCode = failure.status ?? 1
      stderr = failure.stderr?.toString() ?? ''
    }
    const result = { exitCode, timedOut: false, aborted: false, stdout: { text: '', truncated: false }, stderr: { text: stderr, truncated: false } }
    return Promise.resolve({ result: () => Promise.resolve(result) })
  }
}

describe.skipIf(joernHome === '')('hard-cpg with Joern', () => {
  const roots: string[] = []
  afterAll(async () => {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  })

  it('exports resolved calls and callback arrays from the pinned commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hard-cpg-e2e-'))
    roots.push(root)
    const repo = join(root, 'target')
    await mkdir(join(repo, 'poc'), { recursive: true })
    await writeFile(join(repo, 'post.php'), [
      '<?php',
      'function can_edit($id) { return $id > 0; }',
      'function save_post($id) { if (can_edit($id)) { store($id); } }',
      'function store($id) {}',
      'class Hooks { function register() { add_action("save", array($this, "on_save")); } function on_save() {} }',
      '',
    ].join('\n'))
    await writeFile(join(repo, 'poc', 'stub.php'), '<?php function can_edit($id) { return true; }\n')
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV })
    git('init', '--quiet')
    git('add', '-A')
    git('-c', 'user.name=hard-test', '-c', 'user.email=hard@test', 'commit', '--quiet', '-m', 'seed')
    const commit = git('rev-parse', 'HEAD').trim()
    const gitDir = join(root, 'snapshots', 'target.git')
    execFileSync('git', ['clone', '--quiet', '--bare', repo, gitDir], { env: GIT_ENV })

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(HardLedger, {})
    new LocalShell(ctx)
    await ctx.plugin(HardCpg, { enabled: true, joernHome, excludePaths: ['poc'], heapMb: 2048, buildOnArm: false })
    const session = ctx.sessions.create(SessionId(`e2e-${Math.random()}`), { meta: { cwd: repo } })
    const agent: Agent = {
      id: session.id, options: {}, session, inbox: createInboxStub(), status: 'running', ctx,
      send: () => {}, followup: () => {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
      inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(agent)
    ctx.hardLedger.recordMissionArmed(agent, {
      objective: 'audit', targetRepo: repo, commit, modules: ['.', 'poc'], bugClasses: ['logic'], snapshot: { gitDir, kind: 'git' },
    })

    const facts = await ctx.hardCpg.facts(agent)
    const rows: HardCpgFact[] = []
    for await (const fact of readHardCpgFacts(facts.path)) rows.push(fact)
    expect(rows.filter(row => row.k === 'file').map(row => row.path)).toEqual(['post.php'])
    expect(rows).toContainEqual(expect.objectContaining({ k: 'call', name: 'can_edit', resolved: ['can_edit'], file: 'post.php', line: 3 }))
    expect(rows).toContainEqual(expect.objectContaining({ k: 'call', name: 'add_action', args: [{ lit: '"save"' }, { arr: ['$this', '"on_save"'] }] }))
  }, 300_000)
})
