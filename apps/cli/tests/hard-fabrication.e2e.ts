/** Keyless end-to-end hard-profile run: stop-gate steering, refuted payload-agnostic
 * fabrications, a model-written proof, the coverage cross-check, and the armed target
 * matrix. */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const fixtureLlm = fileURLToPath(
  new URL('./profiles/headless/tests/fixtures/hard-llm.mjs', import.meta.url),
)
const fixtureModule = (await import(fixtureLlm)) as { CONFIRMED_CLAIM: string }

/** The planted source-to-sink bug: the user parameter reaches execSync() through interpolation. */
const REPORTS_SOURCE = `'use strict'

const { execSync } = require('node:child_process')

// Builds a usage report for one user. INSECURE: the user parameter reaches
// execSync() through string interpolation without validation.
function buildReport(user) {
  return execSync(\`node stats.js --user \${user}\`, { encoding: 'utf8' })
}

module.exports = { buildReport }
`

/** The planted logic flaw: a session record with no expiry field never expires. */
const SESSION_SOURCE = `'use strict'

// Validates one session record. INSECURE: a record with no expiry field is
// treated as never-expiring instead of being rejected.
function sessionValid(session) {
  if (session.expiry === undefined) return true
  return session.expiry > Date.now()
}

module.exports = { sessionValid }
`

const MISSION = 'Hunt vulnerabilities in this repository; only verified findings count.'

function records(content: string) {
  return content.split('\n').filter(Boolean).map((line: string) => JSON.parse(line) as Record<string, unknown>)
}

describe('dsh --profile hard fabrication traps', () => {
  it('steers a clean claim, refutes a dead PoC and an echo-only PoC, confirms the model-written proof, and cross-checks coverage', async () => {
    const { createHash } = await import('node:crypto')
    const claimHash = createHash('sha256').update(fixtureModule.CONFIRMED_CLAIM).digest('hex')
    void claimHash
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-hard-fabrication-'))
    try {
      await mkdir(join(cwd, 'src'), { recursive: true })
      await writeFile(join(cwd, 'src', 'reports.js'), REPORTS_SOURCE)
      await writeFile(join(cwd, 'src', 'session.js'), SESSION_SOURCE)
      // One notes-only module so the full inert chain runs for real: arming
      // enumerates it, the ledger pre-verdicts its cells, and openWork never
      // lists them. Not named docs — the default exclude globs drop that
      // directory from the matrix before inert screening ever sees it.
      await mkdir(join(cwd, 'notes'), { recursive: true })
      await writeFile(join(cwd, 'notes', 'NOTES.md'), '# Hard target\n\nNotes only; this module screens inert in the coverage matrix.\n')
      // The target is a real git repository so the mission pins the commit and
      // enumerates the tracked modules at load time. Config isolation keeps a
      // developer's global gitconfig (autocrlf, gpgsign) out of the run.
      const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      })
      git('init', '--quiet')
      git('add', '-A')
      git('-c', 'user.name=hard-e2e', '-c', 'user.email=hard@e2e', 'commit', '--quiet', '-m', 'seed')
      const commit = git('rev-parse', 'HEAD').trim()

      const home = join(cwd, '.dsh')
      const sessions = join(home, 'sessions')
      const profileDir = join(home, 'profiles', 'hard')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-hard',
        private: true,
        dependencies: {
          '@deepseek-ai/dsh-experimental-hard-bundle': 'workspace:^',
        },
        dsh: {
          profile: {
            bundles: [
              '@deepseek-ai/dsh-base',
              '@deepseek-ai/dsh-headless',
              '@deepseek-ai/dsh-experimental-hard-bundle',
            ],
          },
        },
      }, undefined, 2) + '\n')
      // coverageSpotCheckPercent: 100 makes the deterministic cross-check run
      // for every cleared cell instead of its default 20 percent sample; the
      // ledger screen spot-check is off (0) so the batch-cleared cell is not
      // sent back for a re-read, and the ledger's completion assessment
      // requires one trailing empty-verified sweep. The two-class matrix
      // keeps the fixture's work surface exact.
      await writeFile(join(profileDir, 'cordis.patch.yml'), [
        '- id: hard-mission',
        '  config:',
        `    objective: '${MISSION}'`,
        '    target:',
        `      repoPath: '${cwd}'`,
        '    bugClasses: [cmdi, sqli]',
        '- id: hard-verifier',
        '  config:',
        '    coverageSpotCheckPercent: 100',
        '- id: hard-ledger',
        '  config:',
        '    screenSpotCheckPercent: 0',
        '    emptySweepsToFinish: 1',
        '- id: llm-deepseek',
        '  disabled: true',
        '- id: session-persistence-jsonl',
        '  config:',
        `    root: '${sessions}'`,
        '    compression: none',
        '- insert:',
        '    - id: hard-fixture-llm',
        `      name: '${fixtureLlm}'`,
        '',
      ].join('\n'))

      const launch = resolveExampleLaunch({
        srcBin: dshBinScript,
        configArgs: ['--profile', 'hard', '--json', MISSION],
        tsconfigPath,
        env: {
          DSH_HOME: home,
          DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
        },
      })
      const execution = await execa(launch.command, launch.args, {
        cwd,
        env: launch.env,
        reject: false,
        timeout: 120_000,
      })

      expect(execution.exitCode, execution.stderr.slice(-2000)).toBe(0)
      // Regression tripwire for the composition itself: every mounted plugin
      // must have activated, so a removed bundle row fails here loudly.
      expect(execution.stderr).not.toContain('did not activate')

      const sessionFiles = records(await readSessionLog(sessions))
      // The mission pinned the target and armed the coverage matrix from the
      // tracked tree: both planted sources group into the src module while
      // the notes module screens inert.
      const armed = sessionFiles.find(event => event.type === 'hard/mission/armed')?.data as {
        targetRepo: string
        commit: string
        modules: string[]
        bugClasses: string[]
        inertModules?: string[]
      } | undefined
      expect(armed).toBeDefined()
      expect(armed?.targetRepo).toBe(cwd)
      expect(armed?.commit).toBe(commit)
      expect(armed?.modules).toEqual(['notes', 'src'])
      expect(armed?.bugClasses.length).toBeGreaterThan(0)
      // The notes module holds only Markdown, so it screens inert; the src
      // files are all JavaScript and stay in the work surface.
      expect(armed?.inertModules).toEqual(['notes'])
      // The stop gate steered the premature clean claim back to work.
      const steerings = sessionFiles.filter(event => event.type === 'user/message')
        .filter((event) => {
          const source = (event.data as { source?: { kind?: string } }).source
          return source?.kind === 'hard-stopgate'
        })
      expect(steerings.length).toBeGreaterThanOrEqual(1)

      // The dead PoC and both payload-agnostic PoCs — marker-only and filler —
      // were refuted; the model-written proof of the planted bug was confirmed.
      const verdicts = sessionFiles.filter(event => event.type === 'hard/finding/verdict')
        .map(event => event.data as { verdict: string; reason: string; cause?: string; benignArm?: string })
      expect(verdicts.filter(v => v.verdict === 'refuted')).toHaveLength(3)
      // The specificity check catches both payload-agnostic proofs: the same PoC
      // satisfies the contract with a benign payload, so the proof does not
      // depend on the exploit input. The dead PoC's exploit never happened.
      expect(verdicts.filter(v => v.cause === 'benign-arm-passed')).toHaveLength(2)
      expect(verdicts.find(v => v.cause === 'nonzero-exit')).toBeDefined()
      expect(verdicts.filter(v => v.verdict === 'confirmed')).toHaveLength(1)
      expect(verdicts.find(v => v.verdict === 'confirmed')?.benignArm).toBe('failed')

      // The coverage cross-check reopened the under-declared cell, then the
      // corrected clearance stood; the batch clear landed as model-verified
      // while the model's own marks carry no source (they read as model).
      const coverage = sessionFiles.filter(event => event.type === 'hard/coverage/cell')
        .map(event => event.data as { verdict: string; source?: string })
      expect(coverage).toEqual([
        expect.objectContaining({ verdict: 'cleared' }),
        expect.objectContaining({ verdict: 'suspicious' }),
        expect.objectContaining({ verdict: 'cleared' }),
        expect.objectContaining({ verdict: 'cleared', source: 'model-verified' }),
      ])
      expect(coverage.slice(0, 3).every(cell => cell.source === undefined)).toBe(true)

      // The empty sweep cites the model-cleared cell as its verifiable proof.
      const sweeps = sessionFiles.filter(event => event.type === 'hard/sweep/summary')
        .map(event => event.data as { newFindings: number; emptyProofRef?: { kind: string; module: string } })
      expect(sweeps).toEqual([
        { phase: 'A', cellsTouched: 2, newFindings: 0, emptyProofRef: { kind: 'cell', module: 'src', bugClass: 'cmdi' } },
      ])

      // The gate owns completion: the early attempt was denied with the
      // remaining work, and the post-certification attempt was allowed.
      const gateDecisions = sessionFiles.filter(event => event.type === 'hard/gate/decision')
        .map(event => event.data as { decision: string; openWorkCount: number; blockers: string[] })
      expect(gateDecisions).toHaveLength(2)
      expect(gateDecisions[0]).toMatchObject({ decision: 'deny', openWorkCount: 2 })
      expect(gateDecisions[0]?.blockers.join(' ')).toContain('cell src × sqli has no verdict')
      expect(gateDecisions[1]).toMatchObject({ decision: 'allow', openWorkCount: 0, blockers: [] })

      // A completed goal — accepted only through the gate's allow branch.
      const goalStates = sessionFiles.filter(event => event.type === 'goal/change')
        .map(event => event.data as { operation: string })
      expect(goalStates.at(-1)).toMatchObject({ operation: 'complete' })
    } finally {
      // DSH_HARD_E2E_KEEP=1 keeps the temp dir for authored-snapshot harvest.
      if (process.env.DSH_HARD_E2E_KEEP !== '1') await rm(cwd, { recursive: true, force: true })
      else console.log(`hard-fabrication e2e kept ${cwd}`)
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
