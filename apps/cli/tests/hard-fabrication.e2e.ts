/** Keyless end-to-end hard-profile run: stop-gate steering, refuted fabrication, verified finding. */

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

/** The fabrication trap: a PoC that fails, so the fake finding must be refuted. */
const FAILING_POC = '#!/bin/sh\nexit 1\n'

/** The real PoC: the injection payload escapes the interpolated command and lands the file. */
const PROOF_POC = `#!/bin/sh
set -e
cd "$(dirname "$0")/../.."
node -e "const {buildReport}=require('./src/reports.js'); buildReport('x; touch pwned.txt')"
test -f pwned.txt
echo "HARD-PASS \${HASH}"
`

const MISSION = 'Hunt vulnerabilities in this repository; only verified findings count.'

function records(content: string) {
  return content.split('\n').filter(Boolean).map((line: string) => JSON.parse(line) as Record<string, unknown>)
}

describe('dsh --profile hard fabrication trap', () => {
  it('steers an early clean claim, refutes a fabricated PoC, and confirms the planted command injection', async () => {
    const { createHash } = await import('node:crypto')
    const claimHash = createHash('sha256').update(fixtureModule.CONFIRMED_CLAIM).digest('hex')
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-hard-fabrication-'))
    try {
      await mkdir(join(cwd, 'src'), { recursive: true })
      await mkdir(join(cwd, 'poc', 'F-1'), { recursive: true })
      await mkdir(join(cwd, 'poc', 'F-2'), { recursive: true })
      await writeFile(join(cwd, 'src', 'reports.js'), REPORTS_SOURCE)
      await writeFile(join(cwd, 'src', 'session.js'), SESSION_SOURCE)
      await writeFile(join(cwd, 'poc', 'F-1', 'poc.sh'), FAILING_POC, { mode: 0o755 })
      await writeFile(join(cwd, 'poc', 'F-2', 'poc.sh'), PROOF_POC.replaceAll('${HASH}', claimHash), { mode: 0o755 })

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
      await writeFile(join(profileDir, 'cordis.patch.yml'), [
        '- id: hard-mission',
        '  config:',
        `    objective: '${MISSION}'`,
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
      const sessionFiles = records(await readSessionLog(sessions))
      // The stop gate steered the premature clean claim back to work.
      const steerings = sessionFiles.filter(event => event.type === 'user/message')
        .filter((event) => {
          const source = (event.data as { source?: { kind?: string } }).source
          return source?.kind === 'hard-stopgate'
        })
      expect(steerings.length).toBeGreaterThanOrEqual(1)

      // The fabricated PoC was refuted; the planted bug was confirmed.
      const verdicts = sessionFiles.filter(event => event.type === 'hard/finding/verdict')
        .map(event => (event.data as { verdict: string }).verdict)
      expect(verdicts).toContain('refuted')
      expect(verdicts).toContain('confirmed')

      // A completed goal from an honest completion claim.
      const goalStates = sessionFiles.filter(event => event.type === 'goal/change')
        .map(event => event.data as { operation: string })
      expect(goalStates.at(-1)).toMatchObject({ operation: 'complete' })
    } finally {
      await rm(cwd, { recursive: true, force: true })
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
