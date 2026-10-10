/** The Joern facts service exports the pinned commit, runs the frontend and the packaged query through the shell
 * seam, validates the output, and caches it per commit and query; any failure leaves no cache entry behind. */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import type { HardMissionArmedData } from '@deepseek-ai/dsh-experimental-hard-ledger'
import * as hardCpg from '@deepseek-ai/dsh-experimental-hard-cpg'
import { HardCpg } from '@deepseek-ai/dsh-experimental-hard-cpg'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

const suiteRoot = await mkdtemp(join(tmpdir(), 'hard-cpg-'))
afterAll(async () => {
  await rm(suiteRoot, { recursive: true, force: true })
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** One PHP target committed and cloned bare, as the harness snapshot store holds it. */
const targetRepo = join(suiteRoot, 'target')
const commit: string = await (async () => {
  await mkdir(join(targetRepo, 'poc'), { recursive: true })
  await writeFile(join(targetRepo, 'index.php'), '<?php function main() { helper(); }\n')
  await writeFile(join(targetRepo, 'poc', 'stub.php'), '<?php function helper() {}\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', targetRepo, ...args], { encoding: 'utf8', env: GIT_ENV })
  git('init', '--quiet')
  git('add', '-A')
  git('-c', 'user.name=hard-test', '-c', 'user.email=hard@test', 'commit', '--quiet', '-m', 'seed')
  return git('rev-parse', 'HEAD').trim()
})()
const gitDir = join(suiteRoot, 'snapshots', 'target.git')
execFileSync('git', ['clone', '--quiet', '--bare', targetRepo, gitDir], { env: GIT_ENV })

const FACTS = [
  { k: 'header', format: 3 },
  { k: 'file', path: 'index.php' },
  { k: 'method', id: 'main', name: 'main', file: 'index.php', owner: null, fileLevel: false, annotations: [], line: 1, end: 1 },
  { k: 'call', caller: 'main', name: 'helper', target: 'helper', resolved: [], file: 'index.php', line: 1, dispatch: 'static', args: [] },
  { k: 'end' },
].map(row => JSON.stringify(row)).join('\n') + '\n'

/**
 * A stand-in Joern distribution: the frontend checks the exported tree and writes a graph file, the query
 * writes canned facts, and both append their argv to `calls.log`. A `mode` file selects a failure.
 */
const joernHome = join(suiteRoot, 'joern-cli')
await mkdir(join(joernHome, 'frontends', 'php2cpg', 'bin'), { recursive: true })
await mkdir(join(joernHome, 'frontends', 'pysrc2cpg', 'bin'), { recursive: true })
await mkdir(join(joernHome, 'bin'), { recursive: true })
await writeFile(join(joernHome, 'facts.jsonl'), FACTS)
await writeFile(join(joernHome, 'mode'), 'ok')
await writeFile(join(joernHome, 'frontends', 'php2cpg', 'bin', 'php2cpg'), [
  '#!/bin/sh',
  'home=$(cd "$(dirname "$0")/../../.." && pwd)',
  'printf "php2cpg %s\\n" "$*" >> "$home/calls.log"',
  'if [ "$(cat "$home/mode")" = frontend-fail ]; then echo "php-parser crashed" >&2; exit 3; fi',
  'tree=""; out=""',
  'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2;; --exclude) shift 2;; -J*) shift;; *) tree=$1; shift;; esac; done',
  '[ -f "$tree/index.php" ] || { echo "no exported tree at $tree" >&2; exit 4; }',
  'echo graph > "$out"',
  '',
].join('\n'))
await writeFile(join(joernHome, 'bin', 'repl-bridge'), [
  '#!/bin/sh',
  'home=$(cd "$(dirname "$0")/.." && pwd)',
  'printf "query %s\\n" "$*" >> "$home/calls.log"',
  'out=""',
  'while [ $# -gt 0 ]; do case "$1" in outFile=*) out=${1#outFile=};; esac; shift; done',
  'if [ "$(cat "$home/mode")" = truncated ]; then head -n 2 "$home/facts.jsonl" > "$out"; exit 0; fi',
  'cat "$home/facts.jsonl" > "$out"',
  '',
].join('\n'))
await chmod(join(joernHome, 'frontends', 'php2cpg', 'bin', 'php2cpg'), 0o755)
await writeFile(join(joernHome, 'frontends', 'pysrc2cpg', 'bin', 'pysrc2cpg'), readFileSync(join(joernHome, 'frontends', 'php2cpg', 'bin', 'php2cpg'), 'utf8').replace('php2cpg %s', 'pysrc2cpg %s'))
await chmod(join(joernHome, 'frontends', 'pysrc2cpg', 'bin', 'pysrc2cpg'), 0o755)
await chmod(join(joernHome, 'bin', 'repl-bridge'), 0o755)

async function setMode(mode: 'ok' | 'frontend-fail' | 'truncated'): Promise<void> {
  await writeFile(join(joernHome, 'mode'), mode)
  await rm(join(joernHome, 'calls.log'), { force: true })
}
function calls(): string[] {
  const log = join(joernHome, 'calls.log')
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
}

interface ExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  stdoutMaxBytes: number
  signal?: AbortSignal
  sandboxPolicy?: unknown
}
interface ExecResult {
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stdout: { text: string; truncated: boolean }
  stderr: { text: string; truncated: boolean }
}

/** A shell on the `shell` key that runs commands for real and can replace one step's result. */
class RecordingShell extends Service {
  readonly specs: ExecSpec[] = []
  replace: ((spec: ExecSpec) => ExecResult | undefined) | undefined

  constructor(ctx: Context) {
    super(ctx, 'shell')
  }

  resolve(request: ExecSpec): ExecSpec {
    return request
  }

  execute(spec: ExecSpec) {
    this.specs.push(spec)
    const replaced = this.replace?.(spec)
    if (replaced !== undefined) return Promise.resolve({ result: () => Promise.resolve(replaced) })
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = 0
    try {
      stdout = execFileSync('/bin/sh', ['-c', spec.command], { cwd: spec.workdir, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error: unknown) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string }
      exitCode = failure.status ?? 1
      stdout = failure.stdout ?? ''
      stderr = failure.stderr ?? ''
    }
    const result: ExecResult = {
      exitCode,
      timedOut: false,
      aborted: false,
      stdout: { text: stdout, truncated: false },
      stderr: { text: stderr, truncated: false },
    }
    return Promise.resolve({ result: () => Promise.resolve(result) })
  }
}

function stubAgent(ctx: Context, sessionId: string): Agent {
  const session = ctx.sessions.create(SessionId(sessionId), { meta: { cwd: targetRepo } })
  return {
    id: session.id,
    options: {},
    session,
    inbox: createInboxStub(),
    status: 'running',
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

const ARMED: Omit<HardMissionArmedData, 'snapshot'> = { objective: 'audit', targetRepo, commit, modules: ['.', 'poc'], bugClasses: ['logic'] }

/** Boot the service over a fresh snapshot copy so each test owns its cache directory. */
async function harness(config: hardCpg.Config = {}, arm: 'snapshot' | 'legacy' | 'none' = 'snapshot') {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(HardLedger, {})
  const shell = new RecordingShell(ctx)
  const own = await mkdtemp(join(suiteRoot, 'store-'))
  const ownGitDir = join(own, 'target.git')
  execFileSync('git', ['clone', '--quiet', '--bare', gitDir, ownGitDir], { env: GIT_ENV })
  const fiber = await ctx.plugin(HardCpg, Object.assign({ enabled: true, joernHome, buildOnArm: false }, config))
  const root = stubAgent(ctx, `mission-${Math.random()}`)
  await ctx.agents.register(root)
  if (arm === 'snapshot') ctx.hardLedger.recordMissionArmed(root, { ...ARMED, snapshot: { gitDir: ownGitDir, kind: 'git' } })
  if (arm === 'legacy') ctx.hardLedger.recordMissionArmed(root, ARMED)
  return { ctx, fiber, root, shell, gitDir: ownGitDir }
}

function cacheEntries(ownGitDir: string): Promise<string[]> {
  return readdir(join(dirname(ownGitDir), 'cpg', commit))
}

describe('hard-cpg config', () => {
  it('refuses an enabled plugin without an absolute joernHome', () => {
    const ctx = new Context()
    expect(() => new HardCpg(ctx, { enabled: true })).toThrow('joernHome must be an absolute path')
    expect(() => new HardCpg(ctx, { enabled: true, joernHome: 'joern-cli' })).toThrow('joernHome must be an absolute path')
  })

  it.each(['', '/abs/poc', '..', '../outside', 'a/../../outside'])('refuses the exclusion %j', (path) => {
    expect(() => new HardCpg(new Context(), { excludePaths: [path] })).toThrow('excludePaths entries must be repository-relative')
  })

  it('refuses a heap or step budget out of range', () => {
    expect(() => new HardCpg(new Context(), { heapMb: 100 })).toThrow('heapMb must be a safe integer of at least 512')
    expect(() => new HardCpg(new Context(), { heapMb: 1024.5 })).toThrow('heapMb must be a safe integer of at least 512')
    expect(() => new HardCpg(new Context(), { stepTimeoutMinutes: 0 })).toThrow('stepTimeoutMinutes must be a positive safe integer')
    expect(() => new HardCpg(new Context(), { stepTimeoutMinutes: 1.5 })).toThrow('stepTimeoutMinutes must be a positive safe integer')
  })

  it('accepts a disabled plugin without Joern and reports it disabled', async () => {
    const { ctx, root } = await harness({ enabled: false })
    expect(ctx.hardCpg.enabled).toBe(false)
    expect(new HardCpg(new Context()).enabled).toBe(false)
    await expect(ctx.hardCpg.facts(root)).rejects.toMatchObject({ code: 'HARD_CPG_DISABLED' })
  })

  it('declares its service dependencies', () => {
    expect(HardCpg.inject).toEqual(['agents', 'shell', 'hardLedger'])
  })
})

describe('hardCpg.facts', () => {
  it('needs an armed mission with a harness snapshot', async () => {
    const unarmed = await harness({}, 'none')
    await expect(unarmed.ctx.hardCpg.facts(unarmed.root)).rejects.toMatchObject({ code: 'HARD_CPG_NOT_ARMED' })
    const legacy = await harness({}, 'legacy')
    await expect(legacy.ctx.hardCpg.facts(legacy.root)).rejects.toMatchObject({ code: 'HARD_CPG_NO_SNAPSHOT' })
    expect(legacy.shell.specs).toEqual([])
  })

  it('builds validated facts from the pinned commit beside the snapshot store, then reuses them', async () => {
    await setMode('ok')
    const { ctx, root, shell, gitDir: ownGitDir } = await harness({ excludePaths: ['poc'], heapMb: 2048, stepTimeoutMinutes: 3 })
    const built = await ctx.hardCpg.facts(root)
    expect(built).toMatchObject({ commit, reused: false, counts: { files: 1, types: 0, methods: 1, calls: 1 } })
    expect(built.path).toMatch(new RegExp(`^${join(dirname(ownGitDir), 'cpg', commit)}/[0-9a-f]{16}/facts\\.jsonl$`))
    expect(readFileSync(built.path, 'utf8')).toBe(FACTS)
    expect(shell.specs.map(spec => spec.command)).toEqual([
      expect.stringContaining(`archive --format=tar '${commit}'`),
      expect.stringContaining('/frontends/php2cpg/bin/php2cpg\' -J-Xmx2048m'),
      expect.stringContaining('/bin/repl-bridge\' -J-Xmx2048m'),
    ])
    for (const spec of shell.specs) {
      expect(spec.sandboxPolicy).toEqual({ mode: 'workspace-write', workspaceRoot: dirname(ownGitDir) })
      expect(spec.timeoutMs).toBe(180_000)
      expect(spec.signal).toBeInstanceOf(AbortSignal)
    }
    const [frontend, query] = calls()
    expect(frontend).toMatch(/^php2cpg -J-Xmx2048m \S+\/tree -o \S+\/cpg\.bin --exclude poc$/)
    expect(query).toContain('--script ')
    expect(query).toContain('/facts.sc --param cpgFile=')
    expect(await cacheEntries(ownGitDir)).toHaveLength(1)
    expect((await readdir(dirname(built.path))).sort()).toEqual(['facts.jsonl'])

    const again = await ctx.hardCpg.facts(root)
    expect(again).toEqual({ ...built, reused: true })
    expect(shell.specs).toHaveLength(3)
  })

  it('shares one build between concurrent requests', async () => {
    await setMode('ok')
    const { ctx, root, shell } = await harness()
    const [first, second] = await Promise.all([ctx.hardCpg.facts(root), ctx.hardCpg.facts(root)])
    expect(second).toEqual(first)
    expect(shell.specs).toHaveLength(3)
  })

  it('runs the frontend of the configured language and keys the cache by it', async () => {
    await setMode('ok')
    const php = await harness()
    const python = await harness({ language: 'python' })
    const a = await php.ctx.hardCpg.facts(php.root)
    const b = await python.ctx.hardCpg.facts(python.root)
    expect(python.shell.specs[1]?.command).toContain("/frontends/pysrc2cpg/bin/pysrc2cpg' -J-Xmx")
    expect(calls().map(line => line.split(' ')[0])).toEqual(['php2cpg', 'query', 'pysrc2cpg', 'query'])
    expect(a.path.split('/').at(-2)).not.toBe(b.path.split('/').at(-2))
  })

  it('keys the cache by the exclusions', async () => {
    await setMode('ok')
    const plain = await harness()
    const excluded = await harness({ excludePaths: ['poc'] })
    const a = await plain.ctx.hardCpg.facts(plain.root)
    const b = await excluded.ctx.hardCpg.facts(excluded.root)
    expect(a.path.split('/').at(-2)).not.toBe(b.path.split('/').at(-2))
  })

  it('reports a failed step with its stderr and leaves no cache entry', async () => {
    await setMode('frontend-fail')
    const { ctx, root, gitDir: ownGitDir } = await harness()
    await expect(ctx.hardCpg.facts(root)).rejects.toMatchObject({ code: 'HARD_CPG_FAILED', message: 'hard-cpg frontend step exited with 3: php-parser crashed' })
    const [entry] = await cacheEntries(ownGitDir)
    expect(await readdir(join(dirname(ownGitDir), 'cpg', commit, entry!))).toEqual([])
  })

  it('refuses a cut-short export and leaves no cache entry', async () => {
    await setMode('truncated')
    const { ctx, root, gitDir: ownGitDir } = await harness()
    await expect(ctx.hardCpg.facts(root)).rejects.toThrow('the end row is missing')
    await expect(ctx.hardCpg.facts(root)).rejects.toHaveProperty('code', 'HARD_CPG_FACTS_INVALID')
    const [entry] = await cacheEntries(ownGitDir)
    expect(await readdir(join(dirname(ownGitDir), 'cpg', commit, entry!))).toEqual([])
  })

  it.each([
    ['timed out', { timedOut: true, aborted: false, exitCode: null }],
    ['was cancelled', { timedOut: false, aborted: true, exitCode: null }],
  ] as const)('reports a step that %s', async (how, outcome) => {
    await setMode('ok')
    const { ctx, root, shell } = await harness()
    shell.replace = spec => spec.command.includes('repl-bridge')
      ? { ...outcome, stdout: { text: '', truncated: false }, stderr: { text: 'killed\n', truncated: false } }
      : undefined
    await expect(ctx.hardCpg.facts(root)).rejects.toMatchObject({ code: 'HARD_CPG_FAILED', message: `hard-cpg query step ${how}: killed` })
  })

  it('cancels running steps when the plugin is disposed', async () => {
    await setMode('ok')
    const { ctx, root, shell, fiber } = await harness()
    let seen: AbortSignal | undefined
    shell.replace = (spec) => {
      seen = spec.signal
      return undefined
    }
    await ctx.hardCpg.facts(root)
    expect(seen?.aborted).toBe(false)
    await fiber.dispose()
    expect(seen?.aborted).toBe(true)
  })
})

describe('building on arming', () => {
  async function armedBuild(mode: 'ok' | 'frontend-fail') {
    await setMode(mode)
    const { ctx, shell, gitDir: ownGitDir } = await harness({ buildOnArm: true }, 'none')
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const root = stubAgent(ctx, `armed-${Math.random()}`)
    await ctx.agents.register(root)
    root.session.append('compaction/start', { compactionId: CompactionId('k1'), turn: 1 })
    const stranger = ctx.sessions.create(SessionId(`no-agent-${Math.random()}`))
    ctx.hardLedger.recordMissionArmed({ session: stranger } as Agent, { ...ARMED, snapshot: { gitDir: ownGitDir, kind: 'git' } })
    ctx.hardLedger.recordMissionArmed(root, { ...ARMED, snapshot: { gitDir: ownGitDir, kind: 'git' } })
    await vi.waitFor(() => {
      expect(info.mock.calls.length + warn.mock.calls.length).toBe(1)
    })
    return { info, warn, shell }
  }

  it('starts a background build when a live agent arms and logs the counts', async () => {
    const { info, shell } = await armedBuild('ok')
    expect(info).toHaveBeenCalledWith(`hard-cpg: facts for ${commit} ready: 1 files, 0 types, 1 methods, 1 calls`)
    expect(shell.specs).toHaveLength(3)
  })

  it('logs a failed background build instead of raising', async () => {
    const { warn } = await armedBuild('frontend-fail')
    const failed = /^hard-cpg: building facts on arming failed: .*hard-cpg frontend step exited with 3/
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(failed))
  })
})
