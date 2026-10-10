/** Real Loader composition: hard-cpg (over a stand-in Joern distribution) and the feature map mounted from cordis.yml
 * beside the agent loop, the real local shell, and the ledger. A scripted model reads the map and records a feature;
 * the section reaches the request and the feature lands in the session log. */

import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import HardLedger from '@deepseek-ai/dsh-experimental-hard-ledger'
import HardCpg from '@deepseek-ai/dsh-experimental-hard-cpg'
import HardFeatureMap from '@deepseek-ai/dsh-experimental-hard-featuremap'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
})

it('loads from cordis.yml, teaches the mapping task, and records a checked feature from a model tool call', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-featuremap-composition-'))
  const repo = join(root, 'target')
  await mkdir(repo)
  await writeFile(join(repo, 'ajax.php'), '<?php\nfunction wp_ajax_save() { check_ajax_referer("save"); save_post(); }\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV })
  git('init', '--quiet')
  git('add', '-A')
  git('-c', 'user.name=hard-test', '-c', 'user.email=hard@test', 'commit', '--quiet', '-m', 'seed')
  const commit = git('rev-parse', 'HEAD').trim()
  const gitDir = join(root, 'snapshots', 'target.git')
  execFileSync('git', ['clone', '--quiet', '--bare', repo, gitDir], { env: GIT_ENV })

  // A stand-in Joern: the frontend writes a graph file, the query writes these facts.
  const joernHome = join(root, 'joern-cli')
  await mkdir(join(joernHome, 'frontends', 'php2cpg', 'bin'), { recursive: true })
  await mkdir(join(joernHome, 'bin'), { recursive: true })
  const method = (id: string) => ({ k: 'method', id, name: id, file: 'ajax.php', owner: null, fileLevel: false, annotations: [], line: 2, end: 2 })
  const call = (caller: string, name: string) => ({ k: 'call', caller, name, target: name, resolved: [name], file: 'ajax.php', line: 2, dispatch: 'static', args: [] })
  await writeFile(join(joernHome, 'facts.jsonl'), [
    { k: 'header', format: 3 },
    { k: 'file', path: 'ajax.php' },
    { ...method('ajax.php:<global>'), name: '<global>', fileLevel: true },
    method('wp_ajax_save'), method('check_ajax_referer'), method('save_post'),
    { ...call('ajax.php:<global>', 'add_action'), resolved: [], args: [{ lit: '"wp_ajax_save"' }, { lit: '"wp_ajax_save"' }] },
    call('wp_ajax_save', 'check_ajax_referer'), call('wp_ajax_save', 'save_post'),
    { k: 'end' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  await writeFile(join(joernHome, 'frontends', 'php2cpg', 'bin', 'php2cpg'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o) echo graph > "$2"; shift 2;; *) shift;; esac; done\n')
  await writeFile(join(joernHome, 'bin', 'repl-bridge'), '#!/bin/sh\nhome=$(cd "$(dirname "$0")/.." && pwd)\nwhile [ $# -gt 0 ]; do case "$1" in outFile=*) cat "$home/facts.jsonl" > "${1#outFile=}";; esac; shift; done\n')
  await chmod(join(joernHome, 'frontends', 'php2cpg', 'bin', 'php2cpg'), 0o755)
  await chmod(join(joernHome, 'bin', 'repl-bridge'), 0o755)

  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-experimental-hard-ledger', HardLedger],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    ...[...modules.keys()].map(name => `- name: '${name}'`),
    "- name: '@deepseek-ai/dsh-bash-local'",
    '  config:',
    `    cwd: '${repo}'`,
    "- name: '@deepseek-ai/dsh-experimental-hard-cpg'",
    '  config:',
    '    enabled: true',
    `    joernHome: '${joernHome}'`,
    '    buildOnArm: false',
    "- name: '@deepseek-ai/dsh-experimental-hard-featuremap'",
    '  config:',
    '    enabled: true',
    `    dbPath: '${join(root, 'featuremap.db')}'`,
    '    frameworks: [wordpress]',
    '    indexOnArm: false',
  ].join('\n') + '\n')
  expect([LocalBashExecutor, HardCpg, HardFeatureMap].every(plugin => typeof plugin === 'function')).toBe(true)

  const context = ctx = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = undefined
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()

  const feature = {
    name: 'Save a post',
    summary: 'An editor saves a post over admin-ajax.',
    entry_points: ['ajax:save'],
    symbols: [{ symbol: 'wp_ajax_save', role: 'entry' }, { symbol: 'check_ajax_referer', role: 'guard' }, { symbol: 'save_post', role: 'helper' }],
  }
  const adapter = new MockAdapter([
    toolCallResponse('c1', 'hard_query_map', { view: 'required', entry_points: ['ajax:save'] }),
    toolCallResponse('c2', 'hard_record_feature', feature),
    textResponse('mapped'),
  ])
  context.llm.registerAdapter(['mock'], adapter)
  const agent = await context.agentLoop.create(SessionId('composed'), { provider: 'mock', model: 'mock' })
  context.hardLedger.recordMissionArmed(agent, { objective: 'audit', targetRepo: repo, commit, modules: ['.'], bugClasses: ['logic'], snapshot: { gitDir, kind: 'git' } })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'map the features' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  expect(adapter.requests).toHaveLength(3)
  const first = adapter.requests[0]!
  expect(JSON.stringify(first.messages[0])).toContain('Feature map. The harness builds a map of the target from its call graph')
  expect(first.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['hard_query_map', 'hard_record_feature', 'hard_link_feature']))
  const events = agent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'hard/featuremap/indexed').map(event => event.data)).toEqual([{
    commit,
    derivation: expect.stringMatching(/^[0-9a-f]{16}$/) as string,
    entryPoints: [{ key: 'ajax:save', handler: 'wp_ajax_save' }, { key: 'script:ajax.php', handler: 'ajax.php:<global>' }],
  }])
  expect(JSON.stringify(adapter.requests[1]!.messages.at(-1))).toContain('{\\"symbol\\":\\"check_ajax_referer\\",\\"reasons\\":[\\"near\\",\\"guard\\"]}')
  expect(events.filter(event => event.type === 'hard/feature/recorded').map(event => event.data)).toEqual([expect.objectContaining({
    id: 'FE-1',
    entryPoints: ['ajax:save'],
    check: { commit, reach: 3, required: 3 },
  })])
  expect(context.hardLedger.unmappedEntryPoints(agent)).toEqual(['script:ajax.php'])
})
