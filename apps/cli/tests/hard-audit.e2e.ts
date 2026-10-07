/** Keyless end-to-end hard-profile run of the independent audit: the mission agent clears a
 * vulnerable cell, and a blind reader spawned through the shipped subagent provider reads the
 * module and flags it, recorded beside the clear. */

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
  new URL('./profiles/headless/tests/fixtures/hard-audit-llm.mjs', import.meta.url),
)
const fixtureModule = (await import(fixtureLlm)) as { CLAIMED_SINK: string }

/** The planted source-to-sink bug the mission agent clears and the reader flags. */
const REPORTS_SOURCE = `'use strict'

const { execSync } = require('node:child_process')

// Builds a usage report for one user. INSECURE: the user parameter reaches
// execSync() through string interpolation without validation.
function buildReport(user) {
  return execSync(\`node stats.js --user \${user}\`, { encoding: 'utf8' })
}

module.exports = { buildReport }
`

const MISSION = 'Hunt vulnerabilities in this repository; only verified findings count.'

function records(content: string) {
  return content.split('\n').filter(Boolean).map((line: string) => JSON.parse(line) as Record<string, unknown>)
}

describe('dsh --profile hard independent audit', () => {
  it('has a blind reader re-read a sampled clear and records its flag beside the clear', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-hard-audit-'))
    try {
      await mkdir(join(cwd, 'src'), { recursive: true })
      await writeFile(join(cwd, 'src', 'reports.js'), REPORTS_SOURCE)
      const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      })
      git('init', '--quiet')
      git('add', '-A')
      git('-c', 'user.name=hard-e2e', '-c', 'user.email=hard@e2e', 'commit', '--quiet', '-m', 'seed')

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
      // The cross-check is off so the wrong clear stands; every per-cell
      // clear is audited, so the one clear is sampled.
      await writeFile(join(profileDir, 'cordis.patch.yml'), [
        '- id: hard-mission',
        '  config:',
        `    objective: '${MISSION}'`,
        '    target:',
        `      repoPath: '${cwd}'`,
        '    bugClasses: [cmdi]',
        '- id: hard-verifier',
        '  config:',
        '    coverageSpotCheckPercent: 0',
        '- id: hard-audit',
        '  config:',
        '    enabled: true',
        '    auditPercent: 100',
        '- id: llm-deepseek',
        '  disabled: true',
        '- id: session-persistence-jsonl',
        '  config:',
        `    root: '${sessions}'`,
        '    compression: none',
        '- insert:',
        '    - id: hard-audit-fixture-llm',
        `      name: '${fixtureLlm}'`,
        '',
      ].join('\n'))

      const launch = resolveExampleLaunch({
        srcBin: dshBinScript,
        configArgs: ['--profile', 'hard', '--json', MISSION],
        tsconfigPath,
        env: {
          DSH_HOME: home,
          DSH_AGENTS_HOME: join(home, '.agents'),
          DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
        },
      })
      const execution = await execa(launch.command, launch.args, {
        cwd,
        env: launch.env,
        reject: false,
        timeout: 120_000,
      })
      expect(execution.stderr).not.toContain('did not activate')

      const logs = await Promise.all((await readdir(sessions, { recursive: true }))
        .filter(name => name.endsWith('.jsonl'))
        .map(async name => records(await readFile(join(sessions, name), 'utf8'))))
      const mission = logs.find(events => events.some(event => event.type === 'hard/mission/armed'))
      expect(mission).toBeDefined()
      const clearSeq = mission?.find(event => event.type === 'hard/coverage/cell')?.seq
      const requested = mission?.filter(event => event.type === 'hard/audit/requested').map(event => event.data)
      expect(requested).toEqual([{ module: 'src', bugClass: 'cmdi', auditedSeq: clearSeq, tier: 'per-cell' }])
      const results = mission?.filter(event => event.type === 'hard/audit/result').map(event => event.data as Record<string, unknown>)
      expect(results).toHaveLength(1)
      // The reader saw neither the claim nor any ledger, goal, session, shell, or write tool.
      expect(results?.[0]).toMatchObject({
        module: 'src',
        bugClass: 'cmdi',
        auditedSeq: clearSeq,
        outcome: 'flagged',
        reason: 'blind=true tools=glob,grep,read,read_image,structured_output',
        locations: [{ path: 'src/reports.js', line: 8, symbol: 'buildReport' }],
      })
      expect((results?.[0]?.usage as { inputTokens: number } | undefined)?.inputTokens).toBeGreaterThan(0)
      // The reader ran as its own child session of the mission.
      const childId = results?.[0]?.childSession
      const child = logs.find(events => events.some(event => event.type === 'subagent/descriptor'))
      expect(child?.some(event => event.type === 'tool/call' && (event.data as { name: string }).name === 'read')).toBe(true)
      expect(JSON.stringify(child)).not.toContain(fixtureModule.CLAIMED_SINK)
      expect(typeof childId).toBe('string')
      // Shadow mode: the mission agent never received a message about the audit.
      const missionMessages = JSON.stringify(mission?.filter(event => event.type === 'user/message' || event.type === 'tool/result'))
      expect(missionMessages).not.toContain('blind=true')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
