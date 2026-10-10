/**
 * The JSON Lines fact format the packaged Joern query writes, and a reader
 * that validates it. A fact file is one `header` row, then `file`, `method`,
 * and `call` rows in any order, then one `end` row; a file without the end row
 * is a truncated export and fails to read.
 * @module @deepseek-ai/dsh-experimental-hard-cpg/facts
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** The fact format version the packaged query writes and the reader accepts. */
export const HARD_CPG_FACTS_FORMAT = 1

const lineNumber = z.number().int().nonnegative().nullable()

/** One argument summary: a literal's source text, a desugared array literal's element texts, or other source text. */
const argSchema = z.union([
  z.strictObject({ lit: z.string() }),
  z.strictObject({ arr: z.array(z.string()) }),
  z.strictObject({ code: z.string() }),
])

const rowSchema = z.discriminatedUnion('k', [
  z.strictObject({ k: z.literal('header'), format: z.literal(HARD_CPG_FACTS_FORMAT) }),
  z.strictObject({ k: z.literal('file'), path: z.string() }),
  z.strictObject({ k: z.literal('method'), id: z.string(), name: z.string(), file: z.string(), line: lineNumber, end: lineNumber }),
  z.strictObject({
    k: z.literal('call'),
    caller: z.string(),
    name: z.string(),
    target: z.string(),
    resolved: z.array(z.string()),
    file: z.string(),
    line: lineNumber,
    dispatch: z.enum(['static', 'dynamic']),
    args: z.array(argSchema),
  }),
  z.strictObject({ k: z.literal('end') }),
])

type Row = z.infer<typeof rowSchema>

/** One argument summary of a call site. */
export type HardCpgArg = z.infer<typeof argSchema>

/**
 * One fact: a target file (repository-relative path), an internal method
 * (`id` is Joern's full name), or a call site whose `resolved` lists the
 * internal methods the graph links it to (empty when unresolved).
 */
export type HardCpgFact = Exclude<Row, { k: 'header' } | { k: 'end' }>

/**
 * Read and validate one fact file row by row.
 * @param path - absolute path of a fact file.
 * @returns the facts in file order, excluding the header and end rows.
 * @throws HarnessError `HARD_CPG_FACTS_INVALID` naming the first invalid row, a missing header, or a missing end row.
 */
export async function* readHardCpgFacts(path: string): AsyncGenerator<HardCpgFact> {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  let number = 0
  let ended = false
  for await (const text of lines) {
    number += 1
    const row = parseRow(path, number, text)
    if (number === 1) {
      if (row.k !== 'header') throw invalid(path, number, 'the first row is not the header')
      continue
    }
    if (ended) throw invalid(path, number, 'a row follows the end row')
    if (row.k === 'header') throw invalid(path, number, 'a second header row')
    if (row.k === 'end') {
      ended = true
      continue
    }
    yield row
  }
  if (number === 0) throw invalid(path, 0, 'the file is empty')
  if (!ended) throw invalid(path, number, 'the end row is missing, so the export was cut short')
}

/** Counts of each fact kind in one file. */
export interface HardCpgFactCounts {
  readonly files: number
  readonly methods: number
  readonly calls: number
}

/**
 * Validate one whole fact file and count its facts.
 * @param path - absolute path of a fact file.
 * @returns the per-kind counts.
 * @throws HarnessError `HARD_CPG_FACTS_INVALID` as {@link readHardCpgFacts} does.
 */
export async function countHardCpgFacts(path: string): Promise<HardCpgFactCounts> {
  const counts = { files: 0, methods: 0, calls: 0 }
  for await (const fact of readHardCpgFacts(path)) {
    if (fact.k === 'file') counts.files += 1
    else if (fact.k === 'method') counts.methods += 1
    else counts.calls += 1
  }
  return counts
}

function parseRow(path: string, number: number, text: string): Row {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    throw invalid(path, number, `not JSON: ${String(error)}`)
  }
  const parsed = rowSchema.safeParse(value)
  if (!parsed.success) throw invalid(path, number, z.prettifyError(parsed.error))
  return parsed.data
}

function invalid(path: string, number: number, reason: string): HarnessError {
  return new HarnessError(`hard-cpg fact file ${path} row ${number}: ${reason}`, 'HARD_CPG_FACTS_INVALID')
}
