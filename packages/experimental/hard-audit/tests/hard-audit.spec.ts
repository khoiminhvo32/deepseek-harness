/** The independent audit samples model clears, has a blind reader re-read each sampled cell, and records the
 * result beside the clear without touching anything the mission agent sees. */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import type { HardMissionArmedData } from '@deepseek-ai/dsh-experimental-hard-ledger'
import HardVerifier from '@deepseek-ai/dsh-experimental-hard-verifier'
import * as hardAudit from '@deepseek-ai/dsh-experimental-hard-audit'
import type { HardAuditRequestedData, HardAuditResultData } from '@deepseek-ai/dsh-experimental-hard-audit'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

/** Run git detached from the developer's global and system gitconfig. */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

const APP_SOURCE = [
  "const { execSync } = require('child_process')",
  'function runShell(cmd) {',
  '  return execSync(cmd)',
  '}',
  'module.exports = { runShell }',
  '',
].join('\n')

/** One seeded target repository per suite: code modules, a binary module, and a root manifest. */
const suiteRoot = await mkdtemp(join(tmpdir(), 'hard-audit-'))
const targetRepo = join(suiteRoot, 'repo')
const outsideFile = join(suiteRoot, 'outside.txt')
const targetSha: string = await (async () => {
  await mkdir(join(targetRepo, 'src'), { recursive: true })
  await mkdir(join(targetRepo, 'lib'), { recursive: true })
  await mkdir(join(targetRepo, 'bin'), { recursive: true })
  await mkdir(join(targetRepo, 'art'), { recursive: true })
  await writeFile(join(targetRepo, 'src', 'app.js'), APP_SOURCE)
  await writeFile(join(targetRepo, 'lib', 'util.js'), 'function slugify(text) {\n  return text.toLowerCase()\n}\nmodule.exports = { slugify }\n')
  await writeFile(join(targetRepo, 'bin', 'tool.so'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 1, 2, 3]))
  await writeFile(join(targetRepo, 'bin', 'run.sh'), '#!/bin/sh\n./tool.so "$@"\n')
  // A binary image beside code: inert, so it never makes its module unreadable.
  await writeFile(join(targetRepo, 'art', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
  await writeFile(join(targetRepo, 'art', 'draw.js'), 'function draw() {\n  return 1\n}\n')
  await writeFile(join(targetRepo, 'package.json'), '{"name":"target","dependencies":{"left-pad":"1.0.0"}}\n')
  await writeFile(outsideFile, 'outside the target\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', targetRepo, ...args], { encoding: 'utf8', env: GIT_ENV })
  git('init', '--quiet')
  git('add', '-A')
  git('-c', 'user.name=hard-test', '-c', 'user.email=hard@test', 'commit', '--quiet', '-m', 'seed')
  return git('rev-parse', 'HEAD').trim()
})()

/** A second repository without binaries, so a repository-wide cell can be read. */
const plainRepo = join(suiteRoot, 'plain')
const plainSha: string = await (async () => {
  await mkdir(join(plainRepo, 'src'), { recursive: true })
  await writeFile(join(plainRepo, 'src', 'app.js'), APP_SOURCE)
  await writeFile(join(plainRepo, 'package.json'), '{"name":"plain"}\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', plainRepo, ...args], { encoding: 'utf8', env: GIT_ENV })
  git('init', '--quiet')
  git('add', '-A')
  git('-c', 'user.name=hard-test', '-c', 'user.email=hard@test', 'commit', '--quiet', '-m', 'seed')
  return git('rev-parse', 'HEAD').trim()
})()

/** A harness-owned snapshot of one repository: a bare clone, so the pinned commit is the repository's own. */
function snapshotOf(repo: string, name: string): string {
  const gitDir = join(suiteRoot, `${name}.git`)
  execFileSync('git', ['clone', '--quiet', '--bare', repo, gitDir], { env: GIT_ENV })
  return gitDir
}
const targetSnapshot = snapshotOf(targetRepo, 'target')
const plainSnapshot = snapshotOf(plainRepo, 'plain')

afterAll(async () => {
  await rm(suiteRoot, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** A shell service on the `shell` key that really executes commands in the requested workdir. */
class GitShell extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }

  resolve(request: { command: string; timeoutMs?: number; stdoutMaxBytes?: number; workdir?: string }) {
    return {
      command: request.command,
      timeoutMs: request.timeoutMs ?? 30_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 65_536,
      workdir: request.workdir,
    }
  }

  execute(spec: { command: string; timeoutMs: number; stdoutMaxBytes: number; workdir?: string }) {
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = 0
    try {
      stdout = execFileSync('/bin/sh', ['-c', spec.command], {
        cwd: spec.workdir !== undefined && existsSync(spec.workdir) ? spec.workdir : tmpdir(),
        timeout: spec.timeoutMs,
        maxBuffer: spec.stdoutMaxBytes,
        encoding: 'utf8',
        env: GIT_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error: unknown) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string }
      exitCode = failure.status ?? 1
      stdout = failure.stdout ?? ''
      stderr = failure.stderr ?? ''
    }
    const result = {
      exitCode,
      timedOut: false,
      aborted: false,
      stdout: { text: stdout, truncated: false },
      stderr: { text: stderr, truncated: false },
    }
    return Promise.resolve({ result: () => Promise.resolve(result) })
  }
}

/** One scripted reader: the tool calls it makes, the results they return, and how it ends. */
interface ScriptedReader {
  readonly calls?: readonly { readonly name: string; readonly args: Record<string, unknown>; readonly result?: string }[]
  readonly structured?: unknown
  readonly stopReason?: SubagentResult['stopReason']
  readonly diagnostic?: string
  /** Runs while the reader is live, before it settles. */
  readonly during?: () => Promise<void> | void
  /** Omit the in-process child, as a remote provider would. */
  readonly remote?: boolean
  /** The reader's working directory; defaults to the target repository. */
  readonly cwd?: string
  /** Reject the run's result, as an infrastructure fault would. */
  readonly fault?: Error
  /** Leave the final message without usage, as a provider that reports none would. */
  readonly noFinalUsage?: boolean
  /** End the reader's turn on this provider quota failure code before it reads anything. */
  readonly quota?: 'QUOTA' | 'ACCOUNT_QUOTA'
}

/** Build one registry-compatible agent stub over a session already entered in `ctx`. */
function stubAgent(ctx: Context, session: Session, options: Agent['options'] = {}): Agent {
  return {
    id: session.id,
    options,
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

/** Commit one reader turn into the child session exactly as the agent loop would. */
function replayReader(child: Session, script: ScriptedReader): void {
  child.append('turn/start', { turn: 1 })
  if (script.quota !== undefined) {
    child.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: '429: insufficient balance', code: script.quota } } })
    return
  }
  for (const [index, call] of (script.calls ?? []).entries()) {
    const callId = ToolCallId(`reader-${index}`)
    const args = JSON.stringify(call.args)
    child.append('step/start', { turn: 1, step: index + 1 })
    child.append('assistant/message', {
      stream: [],
      turn: 1,
      step: index + 1,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 5 },
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: call.name, arguments: args }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    child.append('tool/call', { turn: 1, step: index + 1, callId, name: call.name, arguments: args })
    child.append('tool/result', {
      turn: 1,
      step: index + 1,
      message: createToolResultMessage({
        callId,
        content: call.name === 'read_image'
          ? [{ type: 'image', attachment: { attachmentId: 'reader-image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } as never }]
          : [{ type: 'text', text: call.result ?? 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    child.append('step/end', { turn: 1, step: index + 1 })
  }
  child.append('step/start', { turn: 1, step: 99 })
  child.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 99,
    ...script.noFinalUsage === true ? {} : { usage: { inputTokens: 1, outputTokens: 1 } },
    message: createAssistantMessage({ content: [{ type: 'text', text: 'reported' }], source: { provider: 'test-provider', model: 'test-model' } }),
  }, { surfaceOp: 'append' })
  child.append('step/end', { turn: 1, step: 99 })
  child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** A `subagents` service whose readers replay scripts in start order and record every start request. */
class ScriptedSubagents extends Service {
  readonly starts: SubagentStartRequest[] = []
  readonly disposed: string[] = []
  readonly scripts: ScriptedReader[] = []
  provider: { inheritsParentContext: boolean } | undefined = { inheritsParentContext: false }
  startError: Error | undefined
  beforeStart: (() => void) | undefined

  constructor(ctx: Context, private readonly host: Context) {
    super(ctx, 'subagents')
  }

  getProvider(): { inheritsParentContext: boolean } | undefined {
    return this.provider
  }

  async start(name: string, request: SubagentStartRequest) {
    this.starts.push(request)
    this.beforeStart?.()
    if (this.startError !== undefined) throw this.startError
    const script = this.scripts.shift() ?? {}
    const id = SessionId(`reader-${Math.random()}`)
    const child = this.host.sessions.create(id, { meta: { cwd: script.cwd ?? request.cwd ?? targetRepo } })
    child.append('subagent/descriptor', { version: 3, mode: 'one-shot', provider: name, ...request.label === undefined ? {} : { label: request.label } })
    const agent = stubAgent(this.host, child, { provider: 'test-provider', model: 'reader-model' })
    const result = (async (): Promise<SubagentResult> => {
      await Promise.resolve()
      replayReader(child, script)
      await script.during?.()
      if (script.fault !== undefined) throw script.fault
      return {
        output: [],
        stopReason: script.stopReason ?? 'completed',
        ...script.structured === undefined ? {} : { structured: script.structured },
        ...script.diagnostic === undefined ? {} : { diagnostic: script.diagnostic },
      }
    })()
    return {
      id,
      localAgent: script.remote === true ? undefined : agent,
      result,
      dispose: async () => {
        this.disposed.push(id)
        await result.catch(() => undefined)
      },
    }
  }
}

const MATRIX: Omit<HardMissionArmedData, 'objective' | 'targetRepo' | 'commit'> = {
  modules: ['.', 'art', 'bin', 'lib', 'src'],
  bugClasses: ['cmdi', 'dependencies'],
}

/** The unscreened rows and the snapshot of the shared repository's arming record. */
const UNSCREENED = { unscreenedModules: ['bin'], snapshot: { gitDir: targetSnapshot, kind: 'git' as const } }

/** Boot one audit harness with a live root agent armed over the shared repository. */
async function harness(config: hardAudit.Config = {}, matrix: Partial<HardMissionArmedData> = UNSCREENED) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(HardLedger, {})
  new GitShell(ctx)
  await ctx.plugin(HardVerifier, {})
  const subagents = new ScriptedSubagents(ctx, ctx)
  const sampled = { enabled: true, auditPercent: 100, batchAuditPercent: 100, unscreenedAuditPercent: 100 }
  const fiber = await ctx.plugin(hardAudit, Object.assign(sampled, config))
  const session = ctx.sessions.create(SessionId(`mission-${Math.random()}`), { meta: { cwd: targetRepo } })
  const root = stubAgent(ctx, session)
  await ctx.agents.register(root)
  ctx.hardLedger.recordMissionArmed(root, { objective: 'audit', targetRepo, commit: targetSha, ...MATRIX, ...matrix })
  return { ctx, fiber, root, subagents }
}

/** Wait until the root log holds `count` audit results. */
async function results(root: Agent, count: number): Promise<HardAuditResultData[]> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const found = root.session.snapshotEvents().filter(event => event.type === 'hard/audit/result').map(event => event.data)
    if (found.length >= count) return found
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`expected ${count} audit results`)
}

function requests(root: Agent): HardAuditRequestedData[] {
  return root.session.snapshotEvents().filter(event => event.type === 'hard/audit/requested').map(event => event.data)
}

/** Clear one cell as the model would, returning the clear's seq. */
function clear(ctx: Context, root: Agent, module: string, bugClass = 'cmdi', source?: 'model' | 'model-verified' | 'harness'): number {
  ctx.hardLedger.markCoverage(root, { module, bugClass, verdict: 'cleared', declaredSinks: ['src/app.js:runShell - unguarded'], ...source === undefined ? {} : { source } })
  return root.session.seq - 1
}

const CLEAN_SRC = { outcome: 'clean', locations: [], examined: [{ path: 'src/app.js', symbol: 'runShell' }], reason: 'no caller passes input' }

describe('hard-audit sampling and request', () => {
  it('reads a sampled per-cell clear blind and records the corroboration beside it', async () => {
    const { ctx, root, subagents } = await harness({ auditModel: { provider: 'other', model: 'other-model' } })
    subagents.scripts.push({
      calls: [
        { name: 'read', args: { file_path: 'src/app.js' } },
        { name: 'grep', args: { pattern: 'runShell' } },
        { name: 'glob', args: { pattern: '**/*.js', path: 'lib' } },
        { name: 'bash', args: { command: 'ls' } },
        { name: 'read_image', args: { file_path: 'src/app.js' } },
      ],
      structured: CLEAN_SRC,
    })
    const seq = clear(ctx, root, 'src')
    const [result] = await results(root, 1)
    expect(requests(root)).toEqual([{ module: 'src', bugClass: 'cmdi', auditedSeq: seq, tier: 'per-cell' }])
    expect(result).toMatchObject({
      module: 'src',
      bugClass: 'cmdi',
      auditedSeq: seq,
      outcome: 'corroborated',
      examined: 1,
      reason: 'no caller passes input',
      auditor: { provider: 'test-provider', model: 'reader-model' },
      usage: { inputTokens: 501, outputTokens: 51, cacheReadTokens: 200, cacheWriteTokens: 25 },
    })
    expect(result?.childSession).toBe(subagents.disposed[0])
    const start = subagents.starts[0]
    const prompt = start?.prompt[0]?.type === 'text' ? start.prompt[0].text : ''
    // The reader works in a worktree of the snapshot, never in the live target, and the worktree is gone afterwards.
    expect(start?.cwd?.startsWith(`${suiteRoot}/.reader-`)).toBe(true)
    expect(start?.cwd).toMatch(/\/tree$/)
    expect(start?.cwd).not.toBe(targetRepo)
    expect(existsSync(start?.cwd ?? '')).toBe(false)
    expect(prompt).toContain(`Target: the git repository at ${start?.cwd ?? ''}, whose working tree matches commit ${targetSha}.`)
    expect(prompt).not.toContain(targetRepo)
    expect(prompt).toContain('Find one vulnerability of the class "cmdi" (untrusted input reaches an operating-system command, shell, or process invocation) in the module src/.')
    // Blind to the claim: the declared site and the verdict never reach the reader.
    expect(prompt).not.toContain('unguarded')
    expect(prompt).not.toContain('runShell')
    expect(prompt).not.toContain('cleared')
    expect(start?.parent).toBe(root)
    expect({ ...start, parent: undefined }).toMatchObject({
      maxDepth: 1,
      toolFilter: { allow: ['read', 'read_image', 'glob', 'grep'] },
      persona: hardAudit.READER_PERSONA,
      outputSchema: hardAudit.READER_REPORT_SCHEMA,
      agentOptions: { provider: 'other', model: 'other-model' },
    })
    expect(start?.label).toMatch(new RegExp(`^hard-audit src cmdi @${seq} `))
  })

  it('records a flagged reader with its resolved locations', async () => {
    const { ctx, root, subagents } = await harness()
    subagents.scripts.push({
      structured: {
        outcome: 'flagged',
        locations: [{ path: 'src/app.js', line: 3, symbol: 'runShell' }, { path: 'src/app.js', line: 2 }],
        examined: [],
        reason: `cmd reaches execSync ${'x'.repeat(3000)}`,
      },
      noFinalUsage: true,
    })
    clear(ctx, root, 'src')
    const [result] = await results(root, 1)
    expect(result?.reason).toHaveLength(2000)
    expect(result?.reason.endsWith('…')).toBe(true)
    expect(result?.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(result).toMatchObject({
      outcome: 'flagged',
      locations: [{ path: 'src/app.js', line: 3, symbol: 'runShell' }, { path: 'src/app.js', line: 2 }],
    })
    expect(result?.cause).toBeUndefined()
  })

  it('samples by tier and never audits harness clears or non-clears', async () => {
    const { ctx, root, subagents } = await harness({ auditPercent: 0, batchAuditPercent: 100, unscreenedAuditPercent: 0 })
    subagents.scripts.push({ structured: { ...CLEAN_SRC, examined: [{ path: 'lib/util.js', symbol: 'slugify' }] } })
    clear(ctx, root, 'src')
    clear(ctx, root, 'bin')
    clear(ctx, root, 'art', 'cmdi', 'harness')
    ctx.hardLedger.markCoverage(root, { module: 'src', bugClass: 'cmdi', verdict: 'suspicious', declaredSinks: [] })
    const batchSeq = clear(ctx, root, 'lib', 'cmdi', 'model-verified')
    await results(root, 1)
    expect(requests(root)).toEqual([{ module: 'lib', bugClass: 'cmdi', auditedSeq: batchSeq, tier: 'batch' }])
  })

  it('names unscreened clears by tier and salts the sample with the pinned commit', async () => {
    const { ctx, root } = await harness({ auditPercent: 0, batchAuditPercent: 0, unscreenedAuditPercent: 100 })
    clear(ctx, root, 'bin')
    await results(root, 1)
    expect(requests(root)).toMatchObject([{ module: 'bin', tier: 'unscreened' }])
    const cell = { module: 'src', bugClass: 'cmdi' }
    const salted = Array.from({ length: 64 }, (_, index) => hardAuditSample(cell, `${index}`))
    expect(new Set(salted).size).toBe(2)
  })

  it('ignores clears on agents that are not mission roots or have no armed matrix', async () => {
    const { ctx, root } = await harness()
    const loose = stubAgent(ctx, ctx.sessions.create(SessionId(`loose-${Math.random()}`), { meta: { cwd: targetRepo } }))
    await ctx.agents.register(loose)
    ctx.hardLedger.markCoverage(loose, { module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['src/app.js:runShell'] })
    const unregistered = ctx.sessions.create(SessionId(`unregistered-${Math.random()}`), { meta: { cwd: targetRepo } })
    unregistered.append('hard/coverage/cell', { module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['x'] })
    // A model-spawned child, labelled or not, is never observed as a reader.
    unregistered.append('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'spawn' })
    unregistered.append('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'spawn', label: 'hard-audit src cmdi @1 forged' })
    replayReader(unregistered, { calls: [{ name: 'read', args: { file_path: '/etc/passwd' } }] })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(requests(loose)).toEqual([])
    expect(requests(root)).toEqual([])
  })

  it('refuses a sampled clear past the mission budget without spawning a reader', async () => {
    const { ctx, root, subagents } = await harness({ maxAuditsPerMission: 1 })
    subagents.scripts.push({ structured: CLEAN_SRC })
    clear(ctx, root, 'src')
    await results(root, 1)
    clear(ctx, root, 'lib')
    const settled = await results(root, 2)
    expect(settled[1]).toEqual({
      module: 'lib',
      bugClass: 'cmdi',
      auditedSeq: requests(root)[1]?.auditedSeq,
      outcome: 'unavailable',
      cause: 'budget',
      reason: "the mission's audit budget of 1 is spent",
    })
    expect(subagents.starts).toHaveLength(1)
    const state = ctx.sessionProjections.stateOf(root.session, 'hardAudit')
    expect(state === undefined ? -1 : hardAudit.chargedAudits(state)).toBe(1)
  })
})

/** The audit's sampling decision for one cell under a salt. */
function hardAuditSample(cell: { module: string; bugClass: string }, salt: string): boolean {
  return cellSampled(cell, 50, salt)
}

const { cellSampledForPercent: cellSampled } = await import('@deepseek-ai/dsh-experimental-hard-ledger')

describe('hard-audit unavailable results', () => {
  it('reports a binary module without spawning a reader, and reads past inert binaries', async () => {
    const { ctx, root, subagents } = await harness()
    subagents.scripts.push({ structured: { ...CLEAN_SRC, examined: [{ path: 'art/draw.js', symbol: 'draw' }] } })
    clear(ctx, root, 'bin')
    clear(ctx, root, 'art')
    const settled = await results(root, 2)
    expect(settled[0]).toMatchObject({ module: 'bin', outcome: 'unavailable', cause: 'binary', reason: 'binary module, no decompiler tool: bin/tool.so' })
    expect(settled[0]?.childSession).toBeUndefined()
    expect(settled[1]).toMatchObject({ module: 'art', outcome: 'corroborated' })
    expect(subagents.starts).toHaveLength(1)
  })

  it('shows the reader the pinned content only: edits and PoCs in the live target stay out of its worktree', async () => {
    const { ctx, root, subagents } = await harness()
    const resolve = vi.spyOn(ctx.shell, 'resolve')
    const edited = join(targetRepo, 'src', 'app.js')
    const poc = join(targetRepo, 'poc')
    await writeFile(edited, `${APP_SOURCE}// edited by the mission agent\n`)
    await mkdir(poc, { recursive: true })
    await writeFile(join(poc, 'cmdi.sh'), 'echo claimed\n')
    let seen: { app: string; poc: boolean } | undefined
    subagents.scripts.push({
      structured: CLEAN_SRC,
      during: () => {
        const tree = subagents.starts[0]?.cwd ?? ''
        seen = { app: readFileSync(join(tree, 'src', 'app.js'), 'utf8'), poc: existsSync(join(tree, 'poc')) }
      },
    })
    try {
      clear(ctx, root, 'src')
      expect((await results(root, 1))[0]).toMatchObject({ outcome: 'corroborated' })
      expect(seen).toEqual({ app: APP_SOURCE, poc: false })
      // Worktree writes are confined to the snapshot root, whatever the session's sandbox allows.
      const writes = resolve.mock.calls.map(([request]) => request).filter(request => request.command.includes(' worktree '))
      expect(writes.map(request => request.sandboxPolicy)).toEqual([
        { mode: 'workspace-write', workspaceRoot: suiteRoot },
        { mode: 'workspace-write', workspaceRoot: suiteRoot },
      ])
    } finally {
      await writeFile(edited, APP_SOURCE)
      await rm(poc, { recursive: true, force: true })
    }
  })

  it('reports a record without a snapshot, and a worktree that cannot be added or removed', async () => {
    const legacy = await harness({}, { unscreenedModules: ['bin'] })
    clear(legacy.ctx, legacy.root, 'src')
    expect((await results(legacy.root, 1))[0]).toMatchObject({
      outcome: 'unavailable',
      cause: 'git',
      reason: 'the arming record predates harness snapshots, so no pristine copy of the target exists to read',
    })
    expect(legacy.subagents.starts).toHaveLength(0)

    const { ctx, root, subagents } = await harness()
    const real = ctx.shell.execute.bind(ctx.shell)
    const refused = { exitCode: 2, timedOut: false, aborted: false, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }
    const execute = vi.spyOn(ctx.shell, 'execute').mockImplementation(spec => spec.command.includes('worktree add')
      ? Promise.resolve({ result: () => Promise.resolve(refused) } as never)
      : real(spec))
    clear(ctx, root, 'src')
    expect((await results(root, 1))[0]).toMatchObject({ cause: 'git', reason: 'hard audit worktree add failed with exit 2' })
    expect(subagents.starts).toHaveLength(0)
    execute.mockImplementation(spec => spec.command.includes('worktree remove')
      ? Promise.resolve({ result: () => Promise.resolve({ ...refused, timedOut: true }) } as never)
      : real(spec))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    subagents.scripts.push({ structured: CLEAN_SRC })
    clear(ctx, root, 'src')
    expect((await results(root, 2))[1]).toMatchObject({ outcome: 'corroborated' })
    const removal = /^hard-audit: could not remove the reader worktree .*: hard audit worktree remove did not settle/
    expect(warn.mock.calls.some(([line]) => removal.test(String(line)))).toBe(true)
    // The temporary directory is removed even when git could not unregister the worktree.
    expect(existsSync(subagents.starts[0]?.cwd ?? '')).toBe(false)
  })

  it('voids a reader that read outside its worktree, such as the live target, and keeps its own spill reads', async () => {
    const { ctx, root, subagents } = await harness()
    subagents.scripts.push({ calls: [{ name: 'read', args: { file_path: '../outside.txt' } }], structured: CLEAN_SRC })
    clear(ctx, root, 'src')
    expect((await results(root, 1))[0]).toMatchObject({ outcome: 'unavailable', cause: 'contaminated', reason: 'the reader read ../outside.txt, outside its worktree of the pinned commit' })

    // The live target holds the mission agent's PoCs and edits: reading it breaks blindness.
    const live = join(targetRepo, 'src', 'app.js')
    subagents.scripts.push({ calls: [{ name: 'read', args: { file_path: live } }], structured: CLEAN_SRC })
    clear(ctx, root, 'src')
    expect((await results(root, 2))[1]).toMatchObject({ cause: 'contaminated', reason: `the reader read ${live}, outside its worktree of the pinned commit` })

    subagents.scripts.push({
      calls: [
        { name: 'grep', args: { pattern: 'exec' }, result: `Output saved to ${outsideFile} — use read with offset/limit.` },
        { name: 'read', args: { file_path: outsideFile } },
      ],
      structured: CLEAN_SRC,
    })
    clear(ctx, root, 'src')
    expect((await results(root, 3))[2]).toMatchObject({ outcome: 'corroborated' })

    subagents.scripts.push({ cwd: suiteRoot, calls: [{ name: 'glob', args: { pattern: '**/*' } }], structured: CLEAN_SRC })
    clear(ctx, root, 'src')
    expect((await results(root, 4))[3]).toMatchObject({ cause: 'contaminated', reason: 'the reader read ., outside its worktree of the pinned commit' })
  })

  it('refuses reports whose cited code does not resolve or lies outside the cell', async () => {
    const { ctx, root, subagents } = await harness()
    const cases: [unknown, string][] = [
      [{ ...CLEAN_SRC, examined: [{ path: 'src/app.js', symbol: 'missingFn' }] }, `src/app.js has no missingFn at commit ${targetSha.slice(0, 7)}`],
      [{ ...CLEAN_SRC, examined: [{ path: 'lib/util.js', symbol: 'slugify' }] }, 'the report cited no code inside the audited cell'],
      [{ ...CLEAN_SRC, examined: [] }, 'a clean report named no examined code'],
      [{ outcome: 'flagged', locations: [], examined: [], reason: 'x' }, 'a flagged report named no location'],
      [{ outcome: 'flagged', locations: [{ path: '../etc/passwd', line: 1 }], examined: [], reason: 'x' }, '../etc/passwd is not a repository-relative path with a positive line'],
      [{ outcome: 'flagged', locations: [{ path: 'src/app.js', line: 0 }], examined: [], reason: 'x' }, 'src/app.js is not a repository-relative path with a positive line'],
      [{ outcome: 'flagged', locations: [{ path: 'src/app.js', line: 90 }], examined: [], reason: 'x' }, `src/app.js has no line 90 at commit ${targetSha.slice(0, 7)}`],
    ]
    for (const [index, [structured]] of cases.entries()) {
      subagents.scripts.push({ structured })
      clear(ctx, root, 'src')
      await results(root, index + 1)
    }
    const settled = await results(root, cases.length)
    expect(settled.map(result => [result.cause, result.reason])).toEqual(cases.map(([, reason]) => ['citation', reason]))
  })

  it('reads root-file and repository-wide cells by their own scope', async () => {
    const { ctx, root, subagents } = await harness()
    subagents.scripts.push({ structured: { outcome: 'flagged', locations: [{ path: 'package.json', line: 1 }], examined: [], reason: 'root manifest' } })
    subagents.scripts.push({ structured: { outcome: 'flagged', locations: [{ path: 'src/app.js', line: 1 }], examined: [], reason: 'not a root file' } })
    clear(ctx, root, '.')
    await results(root, 1)
    clear(ctx, root, '.')
    await results(root, 2)
    // The repository-wide cell holds the binary module, so no reader can read all of it.
    clear(ctx, root, '.', 'dependencies')
    const settled = await results(root, 3)
    expect(settled.map(result => [result.outcome, result.reason])).toEqual([
      ['flagged', 'root manifest'],
      ['unavailable', 'the report cited no code inside the audited cell'],
      ['unavailable', 'binary module, no decompiler tool: bin/tool.so'],
    ])
    const prompts = subagents.starts.map(start => start.prompt[0]?.type === 'text' ? start.prompt[0].text : '')
    expect(prompts[0]).toContain('in the files at the repository root (not its subdirectories).')

    const plain = await harness({}, { targetRepo: plainRepo, commit: plainSha, modules: ['.', 'src'], snapshot: { gitDir: plainSnapshot, kind: 'git' } })
    plain.subagents.scripts.push({ cwd: plainRepo, structured: { outcome: 'flagged', locations: [{ path: 'src/app.js', line: 3, symbol: 'runShell' }], examined: [], reason: 'repository-wide' } })
    clear(plain.ctx, plain.root, '.', 'dependencies')
    expect((await results(plain.root, 1))[0]).toMatchObject({ outcome: 'flagged', reason: 'repository-wide' })
    plain.subagents.scripts.push({ cwd: plainRepo, structured: { ...CLEAN_SRC } })
    clear(plain.ctx, plain.root, 'src')
    await results(plain.root, 2)
    expect(requests(plain.root)[1]).toMatchObject({ module: 'src', tier: 'per-cell' })
    const repoPrompt = plain.subagents.starts[0]?.prompt[0]
    expect(repoPrompt?.type === 'text' ? repoPrompt.text : '').toContain('of the class "dependencies" (a declared or vendored dependency version carries a known vulnerability that the code reaches) in the whole repository.')
  })

  it('reports a reader that failed, ran remotely, or could not start', async () => {
    const { ctx, root, subagents } = await harness()
    subagents.scripts.push({ stopReason: 'error', diagnostic: 'model overloaded' })
    subagents.scripts.push({ structured: { outcome: 'maybe' } })
    subagents.scripts.push({ remote: true, structured: CLEAN_SRC })
    for (const count of [1, 2, 3]) {
      clear(ctx, root, 'src')
      await results(root, count)
    }
    const settled = await results(root, 3)
    expect(settled.map(result => [result.cause, result.reason])).toEqual([
      ['reader-failed', 'the reader ended error without a structured report: model overloaded'],
      ['reader-failed', 'the reader ended completed without a structured report'],
      ['reader-failed', 'the reader ran outside this process, so its reads cannot be checked'],
    ])
    subagents.scripts.push({ fault: new Error('child crashed') })
    clear(ctx, root, 'src')
    expect((await results(root, 4))[3]).toMatchObject({ cause: 'reader-failed', reason: 'the reader could not run: child crashed' })
    expect(subagents.disposed).toHaveLength(4)
    subagents.startError = new Error('provider refused')
    clear(ctx, root, 'src')
    expect((await results(root, 5))[4]).toMatchObject({ cause: 'reader-failed', reason: 'the reader could not run: provider refused' })
    subagents.startError = Object.assign(Object.create(null) as object, { toString: () => 'opaque' }) as Error
    clear(ctx, root, 'src')
    expect((await results(root, 6))[5]).toMatchObject({ reason: 'the reader could not run: opaque' })
  })

  it('reports a git failure as unavailable', async () => {
    const { ctx, root } = await harness({}, { ...UNSCREENED, snapshot: { gitDir: join(suiteRoot, 'missing.git'), kind: 'git' } })
    clear(ctx, root, 'src')
    expect((await results(root, 1))[0]).toMatchObject({ outcome: 'unavailable', cause: 'git' })
  })

  it('fails a truncated or unsettled snapshot check closed', async () => {
    const { ctx, root, subagents } = await harness()
    const unsettled = { exitCode: 0, timedOut: false, aborted: false, stdout: { text: '', truncated: true }, stderr: { text: 'cut', truncated: false } }
    vi.spyOn(ctx.shell, 'execute').mockResolvedValueOnce({ result: () => Promise.resolve(unsettled) } as never)
    clear(ctx, root, 'src')
    expect((await results(root, 1))[0]).toMatchObject({ cause: 'git', reason: 'hard audit binary check did not settle: cut' })
    vi.restoreAllMocks()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    subagents.scripts.push({ structured: CLEAN_SRC, during: () => { vi.spyOn(ctx.shell, 'execute').mockRejectedValue(new Error('shell gone')) } })
    clear(ctx, root, 'src')
    expect((await results(root, 2))[1]).toMatchObject({ cause: 'git', reason: 'shell gone' })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not remove the reader worktree .*: shell gone$/))
    vi.restoreAllMocks()
    subagents.scripts.push({ structured: CLEAN_SRC })
    vi.spyOn(ctx.hardVerifier, 'checkSinkCitations').mockRejectedValueOnce(new Error('citation git failed'))
    clear(ctx, root, 'src')
    expect((await results(root, 3))[2]).toMatchObject({ cause: 'git', reason: 'citation git failed' })
  })

  it('supersedes a queued audit whose cell was marked again before its reader started', async () => {
    const { ctx, root, subagents } = await harness()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    subagents.scripts.push({ structured: CLEAN_SRC, during: () => gate })
    clear(ctx, root, 'src')
    await vi.waitFor(() => { expect(subagents.starts).toHaveLength(1) })
    clear(ctx, root, 'lib')
    clear(ctx, root, 'lib')
    await new Promise(resolve => setTimeout(resolve, 10))
    subagents.scripts.push({ structured: { ...CLEAN_SRC, examined: [{ path: 'lib/util.js', symbol: 'slugify' }] } })
    release()
    const settled = await results(root, 3)
    expect(settled.map(result => [result.module, result.outcome, result.cause])).toEqual([
      ['src', 'corroborated', undefined],
      ['lib', 'unavailable', 'superseded'],
      ['lib', 'corroborated', undefined],
    ])
  })
})

describe('hard-audit lifecycle', () => {
  it('parks a reader stopped by provider quota without a result or a charge, and retries it once the mission agent answers again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { ctx, root, subagents } = await harness({ maxAuditsPerMission: 1, quotaRetryMinutes: 5 })
      subagents.scripts.push({ quota: 'QUOTA', stopReason: 'error' }, { quota: 'ACCOUNT_QUOTA', stopReason: 'error' }, { calls: [], structured: CLEAN_SRC })
      clear(ctx, root, 'src')
      for (let attempt = 0; attempt < 400 && subagents.disposed.length === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(root.session.snapshotEvents().filter(event => event.type === 'hard/audit/result')).toEqual([])
      expect(subagents.starts).toHaveLength(1)
      const reply = (): void => {
        root.session.append('assistant/message', {
          stream: [], turn: 2, step: 1,
          message: createAssistantMessage({ content: [{ type: 'text', text: 'working' }], source: { provider: 'test-provider', model: 'test-model' } }),
        }, { surfaceOp: 'append' })
      }
      // Before the wait has passed, a reply leaves the request parked.
      reply()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(subagents.starts).toHaveLength(1)
      vi.setSystemTime(Date.now() + 5 * 60_000)
      reply()
      // The retry meets an account-level quota stop and parks again.
      for (let attempt = 0; attempt < 400 && subagents.disposed.length < 2; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(root.session.snapshotEvents().filter(event => event.type === 'hard/audit/result')).toEqual([])
      vi.setSystemTime(Date.now() + 5 * 60_000)
      reply()
      const [settled] = await results(root, 1)
      expect(settled).toMatchObject({ outcome: 'corroborated' })
      // The quota stops charged nothing, so the single-audit budget still covered the retry.
      expect(subagents.starts).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts pending audits on resume and refuses an unusable provider at agent creation', async () => {
    const { ctx, root, subagents } = await harness()
    const seq = clear(ctx, root, 'lib', 'cmdi', 'harness')
    root.session.append('hard/audit/requested', { module: 'lib', bugClass: 'cmdi', auditedSeq: seq, tier: 'per-cell' })
    subagents.scripts.push({ structured: { ...CLEAN_SRC, examined: [{ path: 'lib/util.js', symbol: 'slugify' }] } })
    await agentEvents(ctx, root).serial('agent/created', { source: 'resume' })
    // A second resume while the audit is queued or running does not start it twice.
    await agentEvents(ctx, root).serial('agent/created', { source: 'resume' })
    expect((await results(root, 1))[0]).toMatchObject({ module: 'lib', auditedSeq: seq, outcome: 'corroborated' })
    expect(subagents.starts).toHaveLength(1)

    subagents.provider = { inheritsParentContext: true }
    await expect(agentEvents(ctx, root).serial('agent/created', { source: 'startup' })).rejects.toThrow('inherits the parent conversation')
    subagents.provider = undefined
    await expect(agentEvents(ctx, root).serial('agent/created', { source: 'startup' })).rejects.toThrow('subagent provider "spawn" is not registered')
    // A delegated child is not a mission: its creation never checks the provider.
    const child = stubAgent(ctx, ctx.sessions.create(SessionId(`child-${Math.random()}`), { meta: { cwd: targetRepo } }))
    ctx.agents.enter(child, root)
    await agentEvents(ctx, child).serial('agent/created', { source: 'startup' })
  })

  it('drops queued and running audits when the mission agent is disposed', async () => {
    const { ctx, root, subagents } = await harness()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    subagents.scripts.push({ structured: CLEAN_SRC, during: () => gate })
    clear(ctx, root, 'src')
    clear(ctx, root, 'lib')
    await vi.waitFor(() => { expect(subagents.starts).toHaveLength(1) })
    const other = stubAgent(ctx, ctx.sessions.create(SessionId(`other-${Math.random()}`), { meta: { cwd: targetRepo } }))
    agentEvents(ctx, other).emit('agent/disposed', {})
    agentEvents(ctx, root).emit('agent/disposed', {})
    release()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(root.session.snapshotEvents().filter(event => event.type === 'hard/audit/result')).toEqual([])
    expect(subagents.starts).toHaveLength(1)
  })

  it('cancels a reader past its time budget and on plugin disposal', async () => {
    const { ctx, fiber, root, subagents } = await harness()
    const timers: (() => void)[] = []
    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: () => void, delay?: number) => {
      if (delay === 20 * 60_000) {
        timers.push(callback)
        return realSetTimeout(() => {}, 0)
      }
      return realSetTimeout(callback, delay)
    })
    let aborted: AbortSignal | undefined
    subagents.scripts.push({
      during: async () => {
        aborted = subagents.starts[0]?.signal
        timers[0]?.()
        await Promise.resolve()
      },
      stopReason: 'aborted',
    })
    clear(ctx, root, 'src')
    expect((await results(root, 1))[0]).toMatchObject({ cause: 'reader-failed', reason: 'the reader ended aborted without a structured report' })
    expect(aborted?.aborted).toBe(true)

    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    subagents.scripts.push({ structured: CLEAN_SRC, during: () => gate })
    clear(ctx, root, 'src')
    await vi.waitFor(() => { expect(subagents.starts).toHaveLength(2) })
    await fiber.dispose()
    release()
    await new Promise(resolve => realSetTimeout(resolve, 30))
    expect(subagents.starts[1]?.signal.aborted).toBe(true)
    expect(root.session.snapshotEvents().filter(event => event.type === 'hard/audit/result')).toHaveLength(1)
  })

  it('logs an audit that throws instead of settling', async () => {
    const { ctx, root, subagents } = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    subagents.scripts.push({ structured: CLEAN_SRC, during: () => gate })
    clear(ctx, root, 'src')
    await vi.waitFor(() => { expect(subagents.starts).toHaveLength(1) })
    clear(ctx, root, 'lib')
    await vi.waitFor(() => { expect(requests(root)).toHaveLength(2) })
    vi.spyOn(ctx.hardLedger, 'coverageMatrix').mockImplementation(() => { throw new Error('ledger broke') })
    release()
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('hard-audit: audit of lib × cmdi failed: ledger broke') })
  })

  it('records nothing for a mission agent that left before its request or its audit began', async () => {
    const { ctx, root, subagents } = await harness()
    const real = ctx.agents.get.bind(ctx.agents)
    // The clear's listener sees the agent; the deferred request does not.
    vi.spyOn(ctx.agents, 'get').mockImplementationOnce(real).mockImplementationOnce(() => undefined)
    clear(ctx, root, 'src')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(requests(root)).toEqual([])
    vi.restoreAllMocks()

    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    subagents.scripts.push({ structured: CLEAN_SRC, during: () => gate })
    clear(ctx, root, 'src')
    await vi.waitFor(() => { expect(subagents.starts).toHaveLength(1) })
    clear(ctx, root, 'lib')
    await vi.waitFor(() => { expect(requests(root)).toHaveLength(2) })
    vi.spyOn(ctx.agents, 'get').mockImplementation(() => undefined)
    release()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(subagents.starts).toHaveLength(1)
    expect(root.session.snapshotEvents().filter(event => event.type === 'hard/audit/result')).toEqual([])
  })

  it('records nothing when the mission agent leaves while the reader is starting', async () => {
    const { ctx, root, subagents } = await harness()
    subagents.beforeStart = () => { agentEvents(ctx, root).emit('agent/disposed', {}) }
    subagents.startError = new Error('cancelled before publication')
    clear(ctx, root, 'src')
    await vi.waitFor(() => { expect(subagents.starts).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(root.session.snapshotEvents().filter(event => event.type === 'hard/audit/result')).toEqual([])
  })

  it('holds an idle mission agent until its audits settle, so a one-shot run records them', async () => {
    const { ctx, root, subagents } = await harness()
    const holds: Promise<unknown>[] = []
    const cancel = new AbortController()
    root.runMaintenance = (task) => {
      const held = task(cancel.signal)
      holds.push(held)
      return held
    }
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    subagents.scripts.push({ structured: CLEAN_SRC, during: () => gate })
    clear(ctx, root, 'src')
    await vi.waitFor(() => { expect(subagents.starts).toHaveLength(1) })
    agentEvents(ctx, root).emit('agent/status', { status: 'running' })
    expect(holds).toHaveLength(0)
    agentEvents(ctx, root).emit('agent/status', { status: 'idle' })
    expect(holds).toHaveLength(1)
    let settled = false
    void holds[0]?.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    release()
    await vi.waitFor(() => { expect(settled).toBe(true) })
    expect(root.session.snapshotEvents().filter(event => event.type === 'hard/audit/result')).toHaveLength(1)
    // Nothing pending: an idle transition holds nothing.
    agentEvents(ctx, root).emit('agent/status', { status: 'idle' })
    expect(holds).toHaveLength(1)
  })

  it('releases the hold on cancellation or disposal, and never holds a busy agent or when switched off', async () => {
    const { ctx, root, subagents } = await harness()
    const signals: AbortController[] = []
    const holds: Promise<unknown>[] = []
    root.runMaintenance = (task) => {
      const controller = new AbortController()
      signals.push(controller)
      const held = task(controller.signal)
      holds.push(held)
      return held
    }
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    subagents.scripts.push({ structured: CLEAN_SRC, during: () => gate })
    clear(ctx, root, 'src')
    await vi.waitFor(() => { expect(subagents.starts).toHaveLength(1) })
    agentEvents(ctx, root).emit('agent/status', { status: 'idle' })
    signals[0]?.abort()
    await holds[0]
    agentEvents(ctx, root).emit('agent/status', { status: 'idle' })
    agentEvents(ctx, root).emit('agent/disposed', {})
    await holds[1]
    // A hold another maintenance task already owns is reported, not raised.
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    root.runMaintenance = () => { throw new Error('agent already has active work') }
    clear(ctx, root, 'lib')
    await vi.waitFor(() => { expect(requests(root)).toHaveLength(2) })
    agentEvents(ctx, root).emit('agent/status', { status: 'idle' })
    expect(warn).toHaveBeenCalledWith(`hard-audit: could not hold ${root.id} for its audits: agent already has active work`)
    release()

    const off = await harness({ drainWhenIdle: false })
    let offHeld = false
    off.root.runMaintenance = (task) => { offHeld = true; return task(new AbortController().signal) }
    let offRelease: () => void = () => {}
    const offGate = new Promise<void>((resolve) => { offRelease = resolve })
    off.subagents.scripts.push({ structured: CLEAN_SRC, during: () => offGate })
    clear(off.ctx, off.root, 'src')
    await vi.waitFor(() => { expect(off.subagents.starts).toHaveLength(1) })
    agentEvents(off.ctx, off.root).emit('agent/status', { status: 'idle' })
    expect(offHeld).toBe(false)
    offRelease()
    await results(off.root, 1)
  })

  it('registers nothing when disabled and refuses invalid config', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    hardAudit.apply(ctx, {})
    expect(ctx.sessionProjections.stateOf(ctx.sessions.create(SessionId('x')), 'hardAudit')).toBeUndefined()
    const invalid: [hardAudit.Config, string][] = [
      [{ readerTools: [] }, 'readerTools must name at least one tool, each non-empty'],
      [{ readerTools: ['read', 'hard_status', 'session_search', 'update_goal'] }, "readerTools must not expose the mission agent's claims: hard_status, session_search, update_goal"],
      [{ auditProvider: '' }, 'auditProvider must name a subagent provider'],
      [{ auditPercent: 101 }, 'auditPercent must be a safe integer from 0 through 100'],
      [{ maxConcurrentAudits: 0 }, 'maxConcurrentAudits must be a safe integer from 1 through 8'],
    ]
    for (const [config, message] of invalid) {
      expect(() => { hardAudit.apply(ctx, Object.assign({ enabled: true }, config)) }).toThrow(message)
    }
    expect(hardAudit.inject).toEqual(['agents', 'sessionProjections', 'subagents', 'shell', 'hardLedger', 'hardVerifier'])
    expect(hardAudit.Config({})).toMatchObject({ enabled: false, auditProvider: 'spawn', readerTools: ['read', 'read_image', 'glob', 'grep'] })
  })

  it('treats an auditModel with neither field as the mission route', async () => {
    const { ctx, root, subagents } = await harness({ auditModel: {} })
    subagents.scripts.push({ structured: CLEAN_SRC })
    clear(ctx, root, 'src')
    await results(root, 1)
    expect(subagents.starts[0]?.agentOptions).toBeUndefined()
    const partial = await harness({ auditModel: { model: 'only-model' } })
    partial.subagents.scripts.push({ structured: CLEAN_SRC })
    clear(partial.ctx, partial.root, 'src')
    await results(partial.root, 1)
    expect(partial.subagents.starts[0]?.agentOptions).toEqual({ model: 'only-model' })
    const routed = await harness({ auditModel: { provider: 'only-provider' } })
    routed.subagents.scripts.push({ structured: CLEAN_SRC })
    clear(routed.ctx, routed.root, 'src')
    await results(routed.root, 1)
    expect(routed.subagents.starts[0]?.agentOptions).toEqual({ provider: 'only-provider' })
  })
})

describe('hard-audit reads', () => {
  it('extracts the path each read tool reads', () => {
    expect(hardAudit.readAccessOf('read', '{"file_path":"a.js"}')).toEqual({ tool: 'read', path: 'a.js' })
    expect(hardAudit.readAccessOf('lsp', '{"file_path":"a.js","line":1}')).toEqual({ tool: 'lsp', path: 'a.js' })
    expect(hardAudit.readAccessOf('grep', '{"pattern":"x"}')).toEqual({ tool: 'grep' })
    expect(hardAudit.readAccessOf('read', '{}')).toBeUndefined()
    expect(hardAudit.readAccessOf('read', 'not json')).toBeUndefined()
    expect(hardAudit.readAccessOf('glob', 'null')).toEqual({ tool: 'glob' })
    expect(hardAudit.readAccessOf('glob', '{"path":7}')).toBeUndefined()
    expect(hardAudit.readAccessOf('bash', '{"command":"cat /etc/passwd"}')).toBeUndefined()
  })

  it('names absolute paths in tool output', () => {
    expect(hardAudit.namedPaths('saved to /tmp/a.txt and "/var/b" (/c)')).toEqual(['/tmp/a.txt', '/var/b', '/c'])
    expect(hardAudit.namedPaths('relative a/b only')).toEqual([])
    // A spill notice ends its sentence right after the path; the period is prose.
    expect(hardAudit.namedPaths('Full sorted result stored at: /var/folders/T/dsh-spill-x/af-glob-results.txt. Use read with offset/limit'))
      .toEqual(['/var/folders/T/dsh-spill-x/af-glob-results.txt'])
    expect(hardAudit.namedPaths('see /tmp/a, /tmp/b; and /tmp/c!')).toEqual(['/tmp/a', '/tmp/b', '/tmp/c'])
  })

  it('finds the first read outside the worktree, through symlinks and the home directory', async () => {
    const escape = join(targetRepo, 'escape-link')
    await symlink(suiteRoot, escape)
    try {
      const scope = { cwd: targetRepo, root: targetRepo, ownOutputs: new Set<string>() }
      expect(await hardAudit.firstContaminatingRead([{ tool: 'read', path: 'src/app.js' }, { tool: 'grep' }], scope)).toBeUndefined()
      expect(await hardAudit.firstContaminatingRead([{ tool: 'read', path: `${targetRepo}/src/app.js` }, { tool: 'read', path: 'escape-link/outside.txt' }], scope)).toBe('escape-link/outside.txt')
      expect(await hardAudit.firstContaminatingRead([{ tool: 'read', path: '~' }], scope)).toBe('~')
      expect(await hardAudit.firstContaminatingRead([{ tool: 'read', path: '~/x' }], scope)).toBe('~/x')
      expect(await hardAudit.firstContaminatingRead([{ tool: 'read', path: outsideFile }], { ...scope, ownOutputs: new Set([outsideFile]) })).toBeUndefined()
      expect(await hardAudit.firstContaminatingRead([{ tool: 'read', path: 'missing/x' }], { ...scope, cwd: join(targetRepo, 'src') })).toBeUndefined()
      expect(await hardAudit.firstContaminatingRead([{ tool: 'read', path: outsideFile }], { ...scope, root: '/' })).toBeUndefined()
    } finally {
      await rm(escape)
    }
  })
})

describe('hard-audit prompt', () => {
  it('names a class outside the definition table without a definition', () => {
    const prompt = hardAudit.readerPrompt({ module: 'src', bugClass: 'prototype-pollution', repoScoped: false, targetRepo: '/t', commit: 'c' })
    expect(prompt).toContain('Find one vulnerability of the class "prototype-pollution" in the module src/.')
    expect(hardAudit.parseReaderReport({ outcome: 'clean' })).toBeUndefined()
  })
})

describe('hard-audit projection', () => {
  it('folds clears, requests, and results into the pending set and the charged budget', () => {
    const empty = { cells: {}, pending: [], requested: 0, budgetRefused: 0 }
    const event = (type: string, seq: number, data: unknown) => ({ type, seq, time: 0, data }) as never
    let state = hardAudit.applyHardAuditProjection(empty, event('hard/coverage/cell', 4, { module: 'src', bugClass: 'cmdi', verdict: 'cleared', declaredSinks: ['a'] }))
    expect(state.cells).toEqual({ [hardAudit.auditCellKey({ module: 'src', bugClass: 'cmdi' })]: 4 })
    state = hardAudit.applyHardAuditProjection(state, event('hard/audit/requested', 5, { module: 'src', bugClass: 'cmdi', auditedSeq: 4, tier: 'per-cell' }))
    state = hardAudit.applyHardAuditProjection(state, event('hard/audit/requested', 6, { module: 'lib', bugClass: 'cmdi', auditedSeq: 4, tier: 'per-cell' }))
    state = hardAudit.applyHardAuditProjection(state, event('hard/audit/result', 7, { module: 'src', bugClass: 'cmdi', auditedSeq: 4, outcome: 'unavailable', cause: 'budget', reason: 'x' }))
    expect(state.pending).toEqual([{ module: 'lib', bugClass: 'cmdi', auditedSeq: 4, tier: 'per-cell' }])
    expect(hardAudit.chargedAudits(state)).toBe(1)
    state = hardAudit.applyHardAuditProjection(state, event('hard/audit/result', 8, { module: 'lib', bugClass: 'cmdi', auditedSeq: 4, outcome: 'corroborated', reason: 'x' }))
    expect(state.pending).toEqual([])
    expect(hardAudit.chargedAudits(state)).toBe(1)
    expect(hardAudit.applyHardAuditProjection(state, event('turn/start', 9, { turn: 1 }))).toBe(state)
    expect(hardAuditProjection.stateSchema.safeParse(state).success).toBe(true)
  })
})

const hardAuditProjection = hardAudit.hardAuditProjectionDefinition
