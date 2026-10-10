/** The fact reader accepts only a complete, well-formed export: header first, valid rows, end last. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { countHardCpgFacts, readHardCpgFacts } from '@deepseek-ai/dsh-experimental-hard-cpg'
import type { HardCpgFact } from '@deepseek-ai/dsh-experimental-hard-cpg'

const root = await mkdtemp(join(tmpdir(), 'hard-cpg-facts-'))
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const HEADER = { k: 'header', format: 2 }
const TYPE = { k: 'type', id: 'WP_REST_Posts_Controller', name: 'WP_REST_Posts_Controller', file: 'wp-includes/rest-api/endpoints/class-wp-rest-posts-controller.php', line: 17, inherits: ['WP_REST_Controller'] }
const FILE = { k: 'file', path: 'wp-admin/admin-ajax.php' }
const METHOD = { k: 'method', id: 'wp_ajax_inline_save', name: 'wp_ajax_inline_save', file: 'wp-admin/includes/ajax-actions.php', owner: null, line: 2001, end: 2120 }
const CALL = {
  k: 'call',
  caller: 'wp-admin/admin-ajax.php:<global>',
  name: 'add_action',
  target: 'add_action',
  resolved: ['add_action'],
  file: 'wp-admin/admin-ajax.php',
  line: 174,
  dispatch: 'static',
  args: [{ lit: '"wp_ajax_check_plugin_dependencies"' }, { arr: ['"WP_Plugin_Dependencies"', '"check_plugin_dependencies_during_ajax"'] }, { code: '$priority' }],
}
const END = { k: 'end' }

let seq = 0
async function factFile(lines: readonly (object | string)[]): Promise<string> {
  seq += 1
  const path = join(root, `facts-${seq}.jsonl`)
  await writeFile(path, lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + (lines.length > 0 ? '\n' : ''))
  return path
}

async function readAll(path: string): Promise<HardCpgFact[]> {
  const facts: HardCpgFact[] = []
  for await (const fact of readHardCpgFacts(path)) facts.push(fact)
  return facts
}

describe('readHardCpgFacts', () => {
  it('yields every fact between the header and the end row', async () => {
    const owned = { ...METHOD, id: 'WP_REST_Posts_Controller.update_item', owner: 'WP_REST_Posts_Controller', line: null, end: null }
    const path = await factFile([HEADER, FILE, TYPE, METHOD, CALL, owned, END])
    const facts = await readAll(path)
    expect(facts).toEqual([FILE, TYPE, METHOD, CALL, owned])
    expect(await countHardCpgFacts(path)).toEqual({ files: 1, types: 1, methods: 2, calls: 1 })
  })

  it.each([
    ['an empty file', [], 'row 0: the file is empty'],
    ['a first row that is not the header', [FILE, END], 'row 1: the first row is not the header'],
    ['a second header', [HEADER, HEADER, END], 'row 2: a second header row'],
    ['a row after the end', [HEADER, END, FILE], 'row 3: a row follows the end row'],
    ['a missing end row', [HEADER, FILE], 'row 2: the end row is missing, so the export was cut short'],
    ['a row that is not JSON', [HEADER, '{"k":"file",', END], 'row 2: not JSON'],
    ['an earlier fact format', [{ k: 'header', format: 1 }, END], 'row 1:'],
    ['an unknown row kind', [HEADER, { k: 'type', name: 'x' }, END], 'row 2:'],
    ['an unexpected field', [HEADER, { ...FILE, extra: true }, END], 'row 2:'],
    ['an invalid dispatch', [HEADER, { ...CALL, dispatch: 'virtual' }, END], 'row 2:'],
  ] as const)('refuses %s', async (_name, lines, reason) => {
    const path = await factFile(lines)
    const error = await readAll(path).then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toHaveProperty('code', 'HARD_CPG_FACTS_INVALID')
    expect((error as HarnessError).message).toContain(`${path} ${reason}`)
  })
})
