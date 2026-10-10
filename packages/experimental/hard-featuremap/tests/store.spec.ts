/** The store writes one snapshot per import in a transaction, answers edge and entry-point queries, and rebuilds a
 * file stamped with another schema version. */

import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { callEdges, HARD_FEATUREMAP_SCHEMA_VERSION, HardFeatureMapStore, hookEdges, wordpressEntryPoints, wordpressHooks } from '@deepseek-ai/dsh-experimental-hard-featuremap'
import type { HardSnapshotImport } from '@deepseek-ai/dsh-experimental-hard-featuremap'
import { call, method, modelOf, type } from './facts.ts'

const root = await mkdtemp(join(tmpdir(), 'hard-featuremap-store-'))
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const model = await modelOf([
  { k: 'file', path: 'wp-admin/admin-ajax.php' },
  { k: 'file', path: 'wp-admin/admin-ajax.php' },
  type('Hooks'),
  type('Hooks'),
  method('wp-admin/admin-ajax.php:<global>', null, 'wp-admin/admin-ajax.php'),
  method('wp_ajax_save'),
  method('Hooks.on_save', 'Hooks'),
  method('save_post'),
  call('wp-admin/admin-ajax.php:<global>', 'add_action', { args: [{ lit: '"wp_ajax_save"' }, { lit: '"wp_ajax_save"' }], file: 'wp-admin/admin-ajax.php', line: 5 }),
  call('wp_ajax_save', 'save_post', { resolved: ['save_post'], line: 12 }),
  call('save_post', 'do_action', { args: [{ lit: '"saved"' }], line: 30 }),
  call('Hooks.on_save', 'add_action', { args: [{ lit: '"saved"' }, { arr: ['$this', '"on_save"'] }], line: 40 }),
  call('Hooks.on_save', 'save_post', { target: 'Hooks.save_post', line: 41 }),
])
const hooks = wordpressHooks(model)

function snapshotImport(overrides: Partial<HardSnapshotImport> = {}): HardSnapshotImport {
  return {
    projectRoot: '/targets/wordpress',
    commit: 'a'.repeat(40),
    derivation: 'd1',
    framework: 'wordpress',
    factsPath: '/cache/facts.jsonl',
    model,
    edges: [...callEdges(model), ...hookEdges(hooks)],
    hooks,
    entryPoints: wordpressEntryPoints(model, hooks, ['wp-admin']),
    ...overrides,
  }
}

describe('HardFeatureMapStore', () => {
  it('creates an owner-only database and imports one snapshot', async () => {
    const path = join(root, 'nested', 'map.db')
    const store = await HardFeatureMapStore.open(path)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(store.findSnapshot('/targets/wordpress', 'a'.repeat(40), 'd1')).toBeUndefined()
    const id = store.importSnapshot(snapshotImport())
    expect(store.findSnapshot('/targets/wordpress', 'a'.repeat(40), 'd1')).toBe(id)
    expect(store.findSnapshot('/targets/wordpress', 'a'.repeat(40), 'd2')).toBeUndefined()
    expect(store.stats(id)).toEqual({
      files: 1,
      types: 1,
      symbols: 4,
      callSites: 5,
      edges: { 'joern': 1, 'repair': 1, 'unique-name': 0, 'hook': 1 },
      hooks: 3,
      entryPoints: 2,
    })
    expect(store.callers(id, 'save_post')).toEqual([
      { caller: 'wp_ajax_save', callee: 'save_post', file: 'code.php', line: 12, source: 'joern' },
      { caller: 'Hooks.on_save', callee: 'save_post', file: 'code.php', line: 41, source: 'repair' },
    ])
    expect(store.callees(id, 'save_post')).toEqual([{ caller: 'save_post', callee: 'Hooks.on_save', file: 'code.php', line: 30, source: 'hook' }])
    expect(store.entryPoints(id)).toEqual([
      { kind: 'ajax', key: 'save', handler: 'wp_ajax_save', file: 'wp-admin/admin-ajax.php', line: 5, auth: 'authenticated' },
      { kind: 'script', key: 'wp-admin/admin-ajax.php', handler: 'wp-admin/admin-ajax.php:<global>', file: 'wp-admin/admin-ajax.php', line: null, auth: 'unknown' },
    ])
    const second = store.importSnapshot(snapshotImport({ derivation: 'd2' }))
    expect(second).not.toBe(id)
    store.close()
  })

  it('keeps a current database across reopening and keeps an existing file mode', async () => {
    const path = join(root, 'reopen.db')
    const first = await HardFeatureMapStore.open(path)
    const id = first.importSnapshot(snapshotImport())
    first.close()
    await chmod(path, 0o640)
    const again = await HardFeatureMapStore.open(path)
    expect(again.findSnapshot('/targets/wordpress', 'a'.repeat(40), 'd1')).toBe(id)
    expect((await stat(path)).mode & 0o777).toBe(0o640)
    again.close()
  })

  it('drops and rebuilds a database stamped with another schema version', async () => {
    const path = join(root, 'stale.db')
    const raw = new DatabaseSync(path)
    raw.exec('CREATE TABLE legacy (x INTEGER); CREATE TABLE "odd""name" (y INTEGER); PRAGMA user_version = 99')
    raw.close()
    const store = await HardFeatureMapStore.open(path)
    store.close()
    const check = new DatabaseSync(path)
    const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(row => row.name)
    expect(tables).not.toContain('legacy')
    expect(tables).toContain('call_edge')
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(HARD_FEATUREMAP_SCHEMA_VERSION)
    check.close()
  })

  it('rolls back a failed import entirely', async () => {
    const store = await HardFeatureMapStore.open(join(root, 'rollback.db'))
    store.importSnapshot(snapshotImport())
    expect(() => store.importSnapshot(snapshotImport())).toThrow(/UNIQUE constraint failed/)
    expect(store.stats(1).callSites).toBe(5)
    expect(store.stats(2).callSites).toBe(0)
    store.close()
  })

  it('reports a database path it cannot create', async () => {
    const blocker = join(root, 'blocker')
    await writeFile(blocker, 'not a directory')
    await expect(HardFeatureMapStore.open(join(blocker, 'map.db'))).rejects.toMatchObject({ code: 'EEXIST' })
    const locked = join(root, 'locked')
    await mkdir(locked, { mode: 0o500 })
    await expect(HardFeatureMapStore.open(join(locked, 'map.db'))).rejects.toMatchObject({ code: 'EACCES' })
    await chmod(locked, 0o700)
  })
})
