/** Arms the configured objective as a durable goal, pins the target commit,
 * and enumerates the deterministic coverage matrix through the shell seam. */

import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import GoalService from '@deepseek-ai/dsh-goal'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import * as hardMission from '@deepseek-ai/dsh-experimental-hard-mission'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

/** Run git detached from the developer's global and system gitconfig. */
const GIT_CONFIG_ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

/** Seed one deterministic git repository: init, add everything, commit. */
function seedGitRepo(repo: string): void {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_CONFIG_ISOLATION },
  })
  git('init', '--quiet')
  git('add', '-A')
  git('-c', 'user.name=hard-test', '-c', 'user.email=hard@test', 'commit', '--quiet', '-m', 'seed')
}

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  readonly inbox: Inbox
  setStatus(status: AgentStatus): void
}

const isolatedInboxCtx = new Context()
await isolatedInboxCtx.plugin(SessionStore)
await isolatedInboxCtx.plugin(SessionProjectionRegistry)
await isolatedInboxCtx.plugin(AgentRegistry)

/** Build one registry-compatible live agent whose injections enter its test Inbox. */
function stubAgent(rawId: string, supplied?: Session, suppliedCtx?: Context): StubAgent {
  const agentCtx = suppliedCtx ?? isolatedInboxCtx
  const session = supplied ?? (suppliedCtx === undefined
    ? agentCtx.sessions.create(SessionId(rawId))
    : suppliedCtx.sessions.create(SessionId(rawId)))
  if (suppliedCtx === undefined) {
    if (agentCtx.sessions.get(session.id) !== session) agentCtx.sessions.enter(session)
  }
  const inbox = createInboxStub()
  let status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    get status() { return status },
    ctx: agentCtx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) {
      this.inbox.append('next-step', input)
    },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session, inbox, setStatus(value) { status = value } }
}

/** A shell service on the `shell` key that really executes commands, so arming runs real git. */
class GitShell extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }

  resolve(request: { command: string; timeoutMs?: number; stdoutMaxBytes?: number }): {
    command: string
    timeoutMs: number
    stdoutMaxBytes: number
  } {
    return {
      command: request.command,
      timeoutMs: request.timeoutMs ?? 30_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 65_536,
    }
  }

  async execute(spec: { command: string; timeoutMs: number; stdoutMaxBytes: number }): Promise<{
    result(): Promise<{
      exitCode: number | null
      timedOut: false
      aborted: false
      stdout: { text: string; truncated: false }
      stderr: { text: string; truncated: false }
    }>
  }> {
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = 0
    try {
      stdout = execFileSync('/bin/sh', ['-c', spec.command], {
        cwd: tmpdir(),
        timeout: spec.timeoutMs,
        maxBuffer: spec.stdoutMaxBytes,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error: unknown) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string }
      exitCode = failure.status ?? 1
      stdout = failure.stdout ?? ''
      stderr = failure.stderr ?? ''
    }
    return {
      result: () => Promise.resolve({
        exitCode,
        timedOut: false,
        aborted: false,
        stdout: { text: stdout, truncated: false },
        stderr: { text: stderr, truncated: false },
      }),
    }
  }
}

/** One seeded target git repository; created once per suite run. */
const targetRoot = await mkdtemp(join(tmpdir(), 'hard-mission-target-'))
const targetRepo = join(targetRoot, 'repo')
const targetSha: string = await (async () => {
  await mkdir(join(targetRepo, 'src', 'parser'), { recursive: true })
  await mkdir(join(targetRepo, 'vendor', 'lib'), { recursive: true })
  await writeFile(join(targetRepo, 'README.md'), '# target\n')
  await writeFile(join(targetRepo, 'src', 'main.ts'), 'export {}\n')
  await writeFile(join(targetRepo, 'src', 'parser', 'lexer.ts'), 'export {}\n')
  await writeFile(join(targetRepo, 'src', 'parser', 'token.ts'), 'export {}\n')
  await writeFile(join(targetRepo, 'vendor', 'lib', 'vendored.js'), 'export {}\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', targetRepo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_CONFIG_ISOLATION },
  })
  git('init', '--quiet')
  git('add', '-A')
  git('-c', 'user.name=hard-test', '-c', 'user.email=hard@test', 'commit', '--quiet', '-m', 'seed')
  return git('rev-parse', 'HEAD').trim()
})()

afterAll(async () => {
  await rm(targetRoot, { recursive: true, force: true })
})

/** Boot the plugins every arming harness needs, without the mission plugin. */
async function baseHarness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  await ctx.plugin(HardLedger, {})
  new GitShell(ctx)
  return ctx
}

async function harness(config: hardMission.Config) {
  const ctx = await baseHarness()
  const fiber = await ctx.plugin(hardMission, config)
  const root = stubAgent(`hard-mission-root-${Math.random()}`, undefined, ctx)
  await ctx.agents.register(root.agent)
  return { ctx, fiber, root }
}

/** The default harness config targeting the shared repository. */
function missionConfig(
  overrides: Partial<Omit<hardMission.Config, 'target'>> & { target?: Partial<hardMission.TargetConfig> } = {},
): hardMission.Config {
  const { target, ...rest } = overrides
  return {
    objective: 'hunt bugs in the target repository',
    ...rest,
    target: { repoPath: targetRepo, ...target },
  }
}

describe('hard mission arming', () => {
  it('arms the configured objective when a root agent registers', async () => {
    const { ctx, root } = await harness(missionConfig({ maxGoalRounds: 9 }))
    expect(ctx.goals.get(root.agent)).toMatchObject({
      objective: 'hunt bugs in the target repository',
      phase: 'active',
      activation: 'armed',
      maxGoalRounds: 9,
    })
  })

  it('never duplicates or recreates across later creation boundaries', async () => {
    const { ctx, root } = await harness(missionConfig())
    const first = ctx.goals.get(root.agent)
    for (const source of ['startup', 'resume', 'clear', 'compact'] as const) {
      await agentEvents(ctx, root.agent).serial('agent/created', { source })
      const current = ctx.goals.get(root.agent)
      expect(current?.id).toBe(first?.id)
      expect(current?.revision).toBe(1)
    }
  })

  it('ignores child agents', async () => {
    const { ctx, root } = await harness(missionConfig())
    const child = stubAgent(`hard-mission-child-${Math.random()}`, undefined, ctx)
    ctx.agents.enter(child.agent, root.agent)
    await ctx.agents.announce(child.agent, 'startup')
    expect(ctx.goals.get(child.agent)).toBeUndefined()
    expect(ctx.goals.get(root.agent)?.revision).toBe(1)
  })

  it('stops arming after disposal', async () => {
    const { ctx, fiber, root } = await harness(missionConfig())
    expect(ctx.goals.get(root.agent)?.revision).toBe(1)
    await fiber.dispose()
    const later = stubAgent(`hard-mission-later-${Math.random()}`, undefined, ctx)
    await ctx.agents.register(later.agent)
    expect(ctx.goals.get(later.agent)).toBeUndefined()
  })
})

describe('hard mission target pinning', () => {
  it('records the armed matrix: pinned sha, grouped modules, and the class columns', async () => {
    const { ctx, root } = await harness(missionConfig())
    expect(ctx.hardLedger.coverageMatrix(root.agent)).toEqual({
      // Nothing is excluded by default: the vendored tree is audited like the rest.
      modules: ['.', 'src', 'src/parser', 'vendor/lib'],
      bugClasses: [...hardMission.DEFAULT_BUG_CLASSES],
      targetRepo,
      commit: targetSha,
      // The root module holds only README.md, so the inert screen screens it.
      inertModules: ['.'],
      // Every code file is TypeScript or JavaScript, which the pattern tables cover.
      unscreenedModules: [],
      ignoredEntryCount: 0,
    })
    expect(ctx.goals.get(root.agent)?.revision).toBe(1)
  })

  it('fails loud when every module is inert — the target has no code modules', async () => {
    const docs = await mkdtemp(join(tmpdir(), 'hard-mission-docs-'))
    try {
      const repo = join(docs, 'repo')
      await mkdir(join(repo, 'guide'), { recursive: true })
      await writeFile(join(repo, 'README.md'), '# target\n')
      await writeFile(join(repo, 'guide', 'intro.md'), 'hello\n')
      seedGitRepo(repo)
      const ctx = await baseHarness()
      await expect(ctx.plugin(hardMission, missionConfig({ target: { repoPath: repo } })))
        .rejects.toThrow(/target has no code modules/)
    } finally {
      await rm(docs, { recursive: true, force: true })
    }
  })

  it('honors an explicit commit ref and module depth', async () => {
    const { ctx, root } = await harness(missionConfig({
      target: { commit: targetSha, moduleDepth: 1 },
    }))
    expect(ctx.hardLedger.coverageMatrix(root.agent)).toMatchObject({
      modules: ['.', 'src', 'vendor'],
      commit: targetSha,
    })
  })

  it('excludes configured trees before grouping and records what the exclusion removed', async () => {
    const { ctx, root } = await harness(missionConfig({ target: { excludeGlobs: ['vendor/**'] } }))
    const matrix = ctx.hardLedger.coverageMatrix(root.agent)
    expect(matrix?.modules).toEqual(['.', 'src', 'src/parser'])
    expect(matrix?.exclusions).toEqual({ globs: ['vendor/**'], fileCount: 1, sample: ['vendor/lib/vendored.js'] })
  })

  it('records no exclusion block when no glob is configured', async () => {
    const { ctx, root } = await harness(missionConfig())
    expect(ctx.hardLedger.coverageMatrix(root.agent)?.exclusions).toBeUndefined()
    expect(hardMission.DEFAULT_EXCLUDE_GLOBS).toEqual([])
  })

  it('marks a PHP module unscreened: the fixed patterns match none of five real WordPress holes', async () => {
    const php = await mkdtemp(join(tmpdir(), 'hard-mission-php-'))
    try {
      const repo = join(php, 'repo')
      await mkdir(join(repo, 'wp', 'admin'), { recursive: true })
      await mkdir(join(repo, 'src'), { recursive: true })
      await writeFile(join(repo, 'src', 'app.ts'), 'export {}\n')
      await writeFile(join(repo, 'wp', 'admin', 'ajax.php'), [
        '<?php',
        "add_action( 'wp_ajax_delete_item', 'my_delete_item' );",
        'function my_delete_item() {',
        "    $id = $_POST['id'];",
        '    global $wpdb;',
        '    $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}items WHERE id = $id" );',
        "    include $_GET['tpl'] . '.php';",
        "    file_put_contents( WP_CONTENT_DIR . '/' . $_POST['name'], $_POST['body'] );",
        "    passthru( 'convert ' . $_POST['file'] );",
        '}',
        '',
      ].join('\n'))
      seedGitRepo(repo)
      const { ctx, root } = await harness(missionConfig({ target: { repoPath: repo } }))
      expect(ctx.hardLedger.coverageMatrix(root.agent)?.unscreenedModules).toEqual(['wp/admin'])
    } finally {
      await rm(php, { recursive: true, force: true })
    }
  })

  it('marks binary, unknown-language, and mixed-language modules unscreened by content, not only extension', async () => {
    const mixed = await mkdtemp(join(tmpdir(), 'hard-mission-mixed-'))
    try {
      const repo = join(mixed, 'repo')
      for (const directory of ['bin', 'odd', 'mix', 'web', 'po']) await mkdir(join(repo, directory), { recursive: true })
      // A NUL byte makes git classify the file as binary whatever its extension says.
      await writeFile(join(repo, 'bin', 'blob.js'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]))
      await writeFile(join(repo, 'odd', 'thing.xyz'), 'run(x)\n')
      await writeFile(join(repo, 'mix', 'a.ts'), 'export {}\n')
      await writeFile(join(repo, 'mix', 'b.php'), '<?php echo 1;\n')
      await writeFile(join(repo, 'web', 'page.ts'), 'export {}\n')
      await writeFile(join(repo, 'web', 'notes.md'), '# notes\n')
      // Translation catalogs reach rendered pages, so they are no longer inert.
      await writeFile(join(repo, 'po', 'fr.po'), 'msgid "x"\nmsgstr "<b>y</b>"\n')
      seedGitRepo(repo)
      const { ctx, root } = await harness(missionConfig({ target: { repoPath: repo } }))
      const matrix = ctx.hardLedger.coverageMatrix(root.agent)
      expect(matrix?.unscreenedModules).toEqual(['bin', 'mix', 'odd', 'po'])
      expect(matrix?.inertModules).toEqual([])
    } finally {
      await rm(mixed, { recursive: true, force: true })
    }
  })

  it('refuses the first arming over files the pinned commit does not hold, and never re-checks on resume', async () => {
    const dirty = await mkdtemp(join(tmpdir(), 'hard-mission-dirty-'))
    try {
      const repo = join(dirty, 'repo')
      await mkdir(join(repo, 'src'), { recursive: true })
      await writeFile(join(repo, 'src', 'app.ts'), 'export {}\n')
      await writeFile(join(repo, '.gitignore'), 'build/\n')
      seedGitRepo(repo)
      await mkdir(join(repo, 'build'), { recursive: true })
      await writeFile(join(repo, 'build', 'out.js'), 'x\n')
      await writeFile(join(repo, 'src', 'new.ts'), 'export {}\n')
      await writeFile(join(repo, 'src', 'app.ts'), 'export const changed = 1\n')
      // Loading never fails on dirt: a resumed session must still load.
      const ctx = await baseHarness()
      await ctx.plugin(hardMission, missionConfig({ target: { repoPath: repo } }))
      const resumed = stubAgent(`hard-mission-resumed-${Math.random()}`, undefined, ctx)
      ctx.agents.enter(resumed.agent, undefined)
      await ctx.agents.announce(resumed.agent, 'resume')
      expect(ctx.goals.get(resumed.agent)).toBeUndefined()
      // The first arming names the untracked and the modified file. The agent
      // loop announces a created root directly, so the refusal fails its creation.
      const fresh = stubAgent(`hard-mission-fresh-${Math.random()}`, undefined, ctx)
      ctx.agents.enter(fresh.agent, undefined)
      await expect(ctx.agents.announce(fresh.agent, 'startup')).rejects.toThrow(
        /target working tree differs from the pinned commit .*: src\/app\.ts \(modified\), src\/new\.ts \(untracked\)/,
      )
      expect(ctx.goals.get(fresh.agent)).toBeUndefined()
    } finally {
      await rm(dirty, { recursive: true, force: true })
    }
  })

  it('treats the harness state directory inside the target as its own, not as drift', async () => {
    const stateful = await mkdtemp(join(tmpdir(), 'hard-mission-state-'))
    const previousHome = process.env.DSH_HOME
    try {
      const repo = join(stateful, 'repo')
      await mkdir(join(repo, 'src'), { recursive: true })
      await writeFile(join(repo, 'src', 'app.ts'), 'export {}\n')
      seedGitRepo(repo)
      // The project-local `.dsh/` directory and a DSH home placed inside the
      // target both hold harness state written before the first arming.
      await mkdir(join(repo, '.dsh', 'profiles', 'hard'), { recursive: true })
      await writeFile(join(repo, '.dsh', '.anonymous-user-id'), 'x\n')
      await mkdir(join(repo, 'state', 'home'), { recursive: true })
      await writeFile(join(repo, 'state', 'home', 'settings.json'), '{}\n')
      process.env.DSH_HOME = join(repo, 'state', 'home')
      const { ctx, root } = await harness(missionConfig({ target: { repoPath: repo } }))
      expect(ctx.goals.get(root.agent)?.phase).toBe('active')
      // A real untracked file beside the state directories still refuses.
      await writeFile(join(repo, 'src', 'new.ts'), 'export {}\n')
      const second = await baseHarness()
      await second.plugin(hardMission, missionConfig({ target: { repoPath: repo } }))
      const fresh = stubAgent(`hard-mission-state-fresh-${Math.random()}`, undefined, second)
      second.agents.enter(fresh.agent, undefined)
      await expect(second.agents.announce(fresh.agent, 'startup')).rejects.toThrow(/: src\/new\.ts \(untracked\);/)
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(stateful, { recursive: true, force: true })
    }
  })

  it('counts ignored entries without failing the arming', async () => {
    const ignored = await mkdtemp(join(tmpdir(), 'hard-mission-ignored-'))
    try {
      const repo = join(ignored, 'repo')
      await mkdir(join(repo, 'src'), { recursive: true })
      await writeFile(join(repo, 'src', 'app.ts'), 'export {}\n')
      await writeFile(join(repo, '.gitignore'), 'build/\n*.log\n')
      seedGitRepo(repo)
      await mkdir(join(repo, 'build', 'deep'), { recursive: true })
      await writeFile(join(repo, 'build', 'deep', 'a.js'), 'x\n')
      await writeFile(join(repo, 'build', 'b.js'), 'x\n')
      await writeFile(join(repo, 'trace.log'), 'x\n')
      const { ctx, root } = await harness(missionConfig({ target: { repoPath: repo } }))
      // One entry per ignored directory plus the ignored file.
      expect(ctx.hardLedger.coverageMatrix(root.agent)?.ignoredEntryCount).toBe(2)
      expect(ctx.goals.get(root.agent)?.phase).toBe('active')
    } finally {
      await rm(ignored, { recursive: true, force: true })
    }
  })

  it('fails loud at load when the target path is not a git repository', async () => {
    const ctx = await baseHarness()
    await expect(ctx.plugin(hardMission, missionConfig({ target: { repoPath: join(targetRoot, 'missing') } })))
      .rejects.toThrow(/git rev-parse failed/)
  })

  it('fails loud at load when no tracked module survives the exclusion globs', async () => {
    const excluded = await mkdtemp(join(tmpdir(), 'hard-mission-empty-'))
    try {
      const repo = join(excluded, 'repo')
      await mkdir(repo, { recursive: true })
      await writeFile(join(repo, 'keep.txt'), 'x\n')
      seedGitRepo(repo)
      const ctx = await baseHarness()
      await expect(ctx.plugin(hardMission, missionConfig({
        target: { repoPath: repo, excludeGlobs: ['**'] },
      }))).rejects.toThrow(/no tracked modules survived/)
    } finally {
      await rm(excluded, { recursive: true, force: true })
    }
  })

  it('fails loud at load when the module list exceeds the log cap', async () => {
    const oversized = await mkdtemp(join(tmpdir(), 'hard-mission-cap-'))
    try {
      const repo = join(oversized, 'repo')
      await mkdir(repo, { recursive: true })
      for (let index = 0; index <= 500; index += 1) {
        const directory = join(repo, `d${index}`)
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'f.ts'), 'export {}\n')
      }
      seedGitRepo(repo)
      const ctx = await baseHarness()
      const loaded = ctx.plugin(hardMission, missionConfig({
        target: { repoPath: repo, moduleDepth: 1 },
      }))
      await expect(loaded).rejects.toThrow(/log cap.*too large for one mission/)
      await expect(loaded).rejects.not.toThrow(/exclude/)
      const deeper = await baseHarness()
      await expect(deeper.plugin(hardMission, missionConfig({
        target: { repoPath: repo, moduleDepth: 2 },
      }))).rejects.toThrow(/log cap; lower target\.moduleDepth from 2 so modules group coarser/)
    } finally {
      await rm(oversized, { recursive: true, force: true })
    }
  })
})

describe('mission contract section', () => {
  it('registers the configured contract and disposes it with the fiber', async () => {
    const { ctx, fiber } = await harness(missionConfig({
      objective: 'find every authentication bypass',
      bugClasses: ['authn', 'authz'],
      deepReadEveryN: 2,
    }))
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'hard:mission')
    expect(section?.text).toContain('Mission: find every authentication bypass')
    expect(section?.text).toContain('Systematic passes sweep these bug classes: authn, authz.')
    expect(section?.text).toContain('Every 2 systematic passes')
    expect(section?.text).toContain('update_goal action complete')
    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble()).sections.some(item => item.name === 'hard:mission')).toBe(false)
  })

  it('omits the class list when bugClasses is empty', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    new GitShell(ctx)
    await hardMission.apply(ctx, { objective: 'audit the parser', bugClasses: [], target: { repoPath: targetRepo } })
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'hard:mission')
    expect(section?.text).toContain('Mission: audit the parser')
    expect(section?.text).not.toContain('bug classes')
  })

  it('uses the default class list, round cap, and cadence on direct apply', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    new GitShell(ctx)
    await hardMission.apply(ctx, {
      objective: 'defaults',
      target: { repoPath: targetRepo },
    })
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'hard:mission')
    expect(section?.text).toContain(hardMission.DEFAULT_BUG_CLASSES.join(', '))
    expect(section?.text).toContain(`Every ${hardMission.DEFAULT_DEEP_READ_EVERY_N} systematic passes`)
  })
})

describe('hard mission config and namespace', () => {
  it('fails loud on a blank objective before registering anything', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    new GitShell(ctx)
    await expect(hardMission.apply(ctx, { objective: '   ', target: { repoPath: targetRepo } }))
      .rejects.toThrow('objective must be a non-empty string')
    expect((await ctx.systemPrompt.assemble()).sections.some(item => item.name === 'hard:mission')).toBe(false)
  })

  it('fails loud when the target config is missing', async () => {
    const ctx = new Context()
    const config: hardMission.Config = { objective: 'x', target: { repoPath: targetRepo } }
    delete (config as { target?: hardMission.TargetConfig }).target
    await expect(hardMission.apply(ctx, config)).rejects.toThrow('target is required')
  })

  it('rejects invalid direct-apply values', async () => {
    const ctx = new Context()
    await expect(hardMission.apply(ctx, { objective: 'x', maxGoalRounds: 1.5, target: { repoPath: targetRepo } }))
      .rejects.toThrow('maxGoalRounds must be a positive safe integer')
    await expect(hardMission.apply(ctx, { objective: 'x', deepReadEveryN: 0, target: { repoPath: targetRepo } }))
      .rejects.toThrow('deepReadEveryN must be a positive safe integer')
    await expect(hardMission.apply(ctx, { objective: 'x', bugClasses: ['ok', ' '], target: { repoPath: targetRepo } }))
      .rejects.toThrow('bugClasses must be an array of non-empty class names')
    await expect(hardMission.apply(ctx, { objective: 'x', target: { repoPath: '   ' } }))
      .rejects.toThrow('target.repoPath must be a non-empty string')
    await expect(hardMission.apply(ctx, { objective: 'x', target: { repoPath: 'relative/path' } }))
      .rejects.toThrow('target.repoPath must be an absolute path')
    await expect(hardMission.apply(ctx, { objective: 'x', target: { repoPath: targetRepo, commit: ' ' } }))
      .rejects.toThrow('target.commit must be a non-empty string')
    await expect(hardMission.apply(ctx, { objective: 'x', target: { repoPath: targetRepo, moduleDepth: 0 } }))
      .rejects.toThrow('target.moduleDepth must be a safe integer between 1 and 6')
    await expect(hardMission.apply(ctx, { objective: 'x', target: { repoPath: targetRepo, moduleDepth: 7 } }))
      .rejects.toThrow('target.moduleDepth must be a safe integer between 1 and 6')
    await expect(hardMission.apply(ctx, { objective: 'x', target: { repoPath: targetRepo, excludeGlobs: ['ok', ' '] } }))
      .rejects.toThrow('target.excludeGlobs must be an array of non-empty globs')
  })

  it('has the Loader-safe namespace export shape', () => {
    expect('default' in hardMission).toBe(false)
    expect(hardMission.name).toBe('hard-mission')
    expect(hardMission.inject).toEqual(['agents', 'goals', 'systemPrompt', 'shell', 'hardLedger'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(hardMission)).toBe(hardMission)
  })
})

describe('coverage module enumeration', () => {
  it('groups tracked paths by the first moduleDepth directory segments', () => {
    expect(hardMission.modulesFromPaths([
      'src/parser/lexer.ts',
      'src/parser/token.ts',
      'src/read.ts',
      'README.md',
    ], 2)).toEqual(['.', 'src', 'src/parser'])
    expect(hardMission.modulesFromPaths(['src/parser/lexer.ts', 'README.md'], 1)).toEqual(['.', 'src'])
    expect(hardMission.modulesFromPaths(['src/parser/lexer.ts'], 3)).toEqual(['src/parser'])
    expect(hardMission.modulesFromPaths(['src/parser/lexer.ts'], 6)).toEqual(['src/parser'])
  })

  it('is idempotent over duplicates and stable in its sort order', () => {
    expect(hardMission.modulesFromPaths([
      'b/x.ts',
      'a/x.ts',
      'b/y.ts',
      'a/x.ts',
    ], 1)).toEqual(['a', 'b'])
    expect(hardMission.modulesFromPaths([], 2)).toEqual([])
  })

  it('filters exclusion globs against the whole repo-relative path', () => {
    const globs = ['node_modules/**', 'vendor/**', 'dist/**', 'build/**']
    expect(hardMission.filterExcludedPaths([
      'node_modules/pkg/index.js',
      'vendor/lib/v.js',
      'dist/out.js',
      'src/keep.js',
      'a/node_modules/nested.js',
    ], globs)).toEqual(['src/keep.js', 'a/node_modules/nested.js'])
    expect(hardMission.filterExcludedPaths(['src/keep.js'], ['**/node_modules/**'])).toEqual(['src/keep.js'])
    expect(hardMission.filterExcludedPaths(['x/node_modules/n.js'], ['**/node_modules/**'])).toEqual([])
    expect(hardMission.filterExcludedPaths(['src/a.ts', 'src/b.ts'], [])).toEqual(['src/a.ts', 'src/b.ts'])
    expect(hardMission.filterExcludedPaths(['a.b.ts'], ['*.b.ts'])).toEqual([])
    expect(hardMission.filterExcludedPaths(['src/a.b.ts'], ['src/*.b.ts'])).toEqual([])
    expect(hardMission.filterExcludedPaths(['src/deep/a.b.ts'], ['src/*.b.ts'])).toEqual(['src/deep/a.b.ts'])
    expect(hardMission.filterExcludedPaths(['src/a.ts'], ['src/?.ts'])).toEqual([])
  })

  it('screens modules whose every file carries an inert extension', () => {
    const inert = hardMission.INERT_EXTENSIONS
    expect(hardMission.inertModulesFromPaths(['notes/a.md', 'notes/b.png', 'README.md'], 1, inert)).toEqual(['.', 'notes'])
    expect(hardMission.inertModulesFromPaths(['src/a.md', 'src/logo.svg'], 1, inert)).toEqual([])
    expect(hardMission.inertModulesFromPaths(['src/a.md', 'src/lib.rs'], 1, inert)).toEqual([])
    expect(hardMission.inertModulesFromPaths([], 2, inert)).toEqual([])
    // An extensionless file (Dockerfile, Makefile) is code.
    expect(hardMission.inertModulesFromPaths(['deploy/Dockerfile', 'deploy/README.md'], 1, inert)).toEqual([])
    // A dotfile is its own extension, not an inert one.
    expect(hardMission.inertModulesFromPaths(['.gitignore'], 2, inert)).toEqual([])
    // Translation catalogs are rendered into pages, so they are not inert.
    expect(hardMission.inertModulesFromPaths(['i18n/fr.po', 'i18n/fr.mo', 'i18n/app.pot'], 1, inert)).toEqual([])
    // The extension is the basename's: a dotted directory does not lend one to an extensionless file.
    expect(hardMission.inertModulesFromPaths(['docs.v1/Makefile'], 1, inert)).toEqual([])
  })
})
