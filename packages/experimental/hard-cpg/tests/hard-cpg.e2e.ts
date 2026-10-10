/** With a real Joern installation (`JOERN_HOME`), the packaged query runs through dsh's real sandboxed Bash
 * executor, exports resolved calls and callback arrays from a pinned PHP commit, and leaves excluded paths out.
 * The session workspace and the snapshot store are separate directories under the home directory (the
 * workspace-write profile grants the temp directories wholesale), so the build succeeds only through the
 * per-call policy that confines writes to the snapshot store. Skips without `JOERN_HOME`. */

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
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import { HardCpg, readHardCpgFacts } from '@deepseek-ai/dsh-experimental-hard-cpg'
import type { HardCpgFact } from '@deepseek-ai/dsh-experimental-hard-cpg'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const joernHome = process.env['JOERN_HOME'] ?? ''
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

describe.skipIf(joernHome === '')('hard-cpg with Joern through the sandboxed shell', () => {
  const roots: string[] = []
  let ctx: Context | undefined
  const contexts: Context[] = []
  afterAll(async () => {
    await ctx?.fiber.dispose()
    await Promise.all(contexts.map(each => each.fiber.dispose()))
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  })

  it('exports resolved calls and callback arrays from the pinned commit', async () => {
    const root = await mkdtemp(join(homedir(), '.hard-cpg-e2e-'))
    roots.push(root)
    const repo = join(root, 'target')
    const workspace = join(root, 'workspace')
    await mkdir(join(repo, 'poc'), { recursive: true })
    await mkdir(workspace)
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

    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SandboxBashExecutor, { cwd: workspace, timeoutMs: 60_000 })
    const shell = ctx.shell
    const results: ShellRunResult[] = []
    const execute = shell.execute.bind(shell)
    shell.execute = async (spec: ShellExecSpec) => {
      const execution = await execute(spec)
      const result = execution.result.bind(execution)
      execution.result = async () => {
        const settled = await result()
        results.push(settled)
        return settled
      }
      return execution
    }
    await ctx.plugin(HardLedger, {})
    await ctx.plugin(HardCpg, { enabled: true, joernHome, excludePaths: ['poc'], heapMb: 2048, buildOnArm: false })
    const session = ctx.sessions.create(SessionId(`e2e-${Math.random()}`), { meta: { cwd: workspace } })
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
    expect(results.map(result => result.sandbox)).toEqual([
      { mode: 'workspace-write', denied: false, enforcement: 'full' },
      { mode: 'workspace-write', denied: false, enforcement: 'full' },
      { mode: 'workspace-write', denied: false, enforcement: 'full' },
    ])
    expect(facts.path.startsWith(join(root, 'snapshots', 'cpg', commit))).toBe(true)
    const rows: HardCpgFact[] = []
    for await (const fact of readHardCpgFacts(facts.path)) rows.push(fact)
    expect(rows.filter(row => row.k === 'file').map(row => row.path)).toEqual(['post.php'])
    expect(rows).toContainEqual({ k: 'type', id: 'Hooks', name: 'Hooks', file: 'post.php', line: 5, inherits: [], annotations: [] })
    expect(rows).toContainEqual(expect.objectContaining({ k: 'method', id: 'Hooks.on_save', owner: 'Hooks' }))
    expect(rows).toContainEqual(expect.objectContaining({ k: 'method', id: 'can_edit', owner: null }))
    expect(rows).toContainEqual(expect.objectContaining({ k: 'call', name: 'can_edit', resolved: ['can_edit'], file: 'post.php', line: 3 }))
    expect(rows).toContainEqual(expect.objectContaining({ k: 'call', name: 'add_action', args: [{ lit: '"save"' }, { arr: ['$this', '"on_save"'] }] }))
  }, 300_000)

  it('builds Python facts with decorators through the configured frontend', async () => {
    const root = await mkdtemp(join(homedir(), '.hard-cpg-e2e-py-'))
    roots.push(root)
    const repo = join(root, 'target')
    await mkdir(repo)
    await writeFile(join(repo, 'app.py'), [
      'from flask import Flask',
      'app = Flask(__name__)',
      'def login_required(f): return f',
      'def remove_post(pid): pass',
      '@app.route("/posts/<pid>/delete")',
      '@login_required',
      'def delete(pid):',
      '    remove_post(pid)',
      '',
    ].join('\n'))
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV })
    git('init', '--quiet')
    git('add', '-A')
    git('-c', 'user.name=hard-test', '-c', 'user.email=hard@test', 'commit', '--quiet', '-m', 'seed')
    const commit = git('rev-parse', 'HEAD').trim()
    const gitDir = join(root, 'snapshots', 'target.git')
    execFileSync('git', ['clone', '--quiet', '--bare', repo, gitDir], { env: GIT_ENV })
    const python = new Context()
    contexts.push(python)
    await python.plugin(SessionStore)
    await python.plugin(SessionProjectionRegistry)
    await python.plugin(AgentRegistry)
    await python.plugin(LocalSandboxProvider, {})
    await python.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: repo })
    await python.plugin(LocalSubprocessRuntime)
    await python.plugin(SandboxBashExecutor, { cwd: repo, timeoutMs: 60_000 })
    await python.plugin(HardLedger, {})
    await python.plugin(HardCpg, { enabled: true, joernHome, language: 'python', heapMb: 2048, buildOnArm: false })
    const session = python.sessions.create(SessionId(`e2e-py-${Math.random()}`), { meta: { cwd: repo } })
    const agent: Agent = {
      id: session.id, options: {}, session, inbox: createInboxStub(), status: 'running', ctx: python,
      send: () => {}, followup: () => {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
      inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
    }
    await python.agents.register(agent)
    python.hardLedger.recordMissionArmed(agent, {
      objective: 'audit', targetRepo: repo, commit, modules: ['.'], bugClasses: ['logic'], snapshot: { gitDir, kind: 'git' },
    })
    const facts = await python.hardCpg.facts(agent)
    const rows: HardCpgFact[] = []
    for await (const fact of readHardCpgFacts(facts.path)) rows.push(fact)
    expect(rows).toContainEqual(expect.objectContaining({ k: 'method', id: 'app.py:<module>', fileLevel: true }))
    expect(rows).toContainEqual(expect.objectContaining({
      k: 'method',
      id: 'app.py:<module>.delete',
      fileLevel: false,
      annotations: [expect.objectContaining({ name: 'route', args: ['"/posts/<pid>/delete"'] }), expect.objectContaining({ name: 'login_required' })],
    }))
    expect(rows).toContainEqual(expect.objectContaining({ k: 'call', caller: 'app.py:<module>.delete', name: 'remove_post', resolved: ['app.py:<module>.remove_post'] }))
  }, 300_000)
})
