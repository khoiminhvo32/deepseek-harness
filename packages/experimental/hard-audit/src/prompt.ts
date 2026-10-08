/**
 * The reader's model-facing contract: the adversarial persona, the task
 * prompt built only from the cell, the pinned target, and a neutral bug-class
 * definition, and the structured report schema. Nothing here carries the
 * mission agent's verdict, declared sites, notes, flow documents,
 * hypotheses, findings, or other audits.
 * @module
 */

import { z as zod } from 'zod'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

/**
 * Neutral definitions of the default bug classes: what the vulnerability is,
 * never where the mission agent looked. A class outside the table is named
 * without a definition.
 */
export const BUG_CLASS_DEFINITIONS: Readonly<Record<string, string>> = {
  'sqli': 'untrusted input reaches a SQL query as query text rather than as a bound parameter',
  'xss': 'untrusted input reaches HTML, script, or URL output in a browser context without encoding for that context',
  'cmdi': 'untrusted input reaches an operating-system command, shell, or process invocation',
  'path-traversal': 'untrusted input chooses a filesystem path outside the directory the code intends',
  'open-redirect': 'untrusted input chooses the destination of a redirect to another origin',
  'deserialization': 'untrusted bytes are deserialized into objects, code, or types the sender chooses',
  'ssrf': 'untrusted input chooses the destination of a server-side network request',
  'authn': 'an identity is accepted without the proof the design requires, such as credentials, tokens, or signatures',
  'authn-bypass': 'a request reaches an authenticated operation without passing authentication',
  'login-bypass': 'the login flow accepts a session or identity without valid credentials',
  'oauth-bypass': 'an OAuth or OpenID Connect flow accepts a token, code, state, or redirect it should reject',
  'session': 'session identifiers are predictable, fixed by the client, leaked, or not invalidated when they must be',
  'authz': 'an operation acts on a resource or function without checking that the caller is allowed to',
  'crypto-misuse': 'cryptography uses a weak algorithm, a fixed or predictable key, nonce, or random value, or an unverified result',
  'misconfig': 'configuration, framework settings, or deployment recipes enable an unsafe default or a debug surface',
  'dependencies': 'a declared or vendored dependency version carries a known vulnerability that the code reaches',
  'race': 'concurrent operations interleave so that a check and its use, or two updates, observe inconsistent state',
  'logic': 'the code enforces its business rules incompletely: a check in the wrong order, a state machine that skips a step, a rule enforced on one path but not a sibling path performing the same operation, or a value trusted after it was checked',
}

/**
 * The reader's persona, shadowing the deployment persona for the reader
 * alone. The mission sections registered globally still reach the reader;
 * they carry the objective, not the mission agent's claims, and the persona
 * tells the reader they address another agent.
 */
export const READER_PERSONA = 'You are an independent security auditor. You read code adversarially: assume the vulnerability '
  + 'you are asked about exists until your own reading shows it does not, and report only what you read yourself. '
  + 'Mission, goal, or ledger instructions elsewhere in your instructions address a different agent: you have no goal '
  + 'and no ledger, and your task ends when you report through the structured_output tool.'

/** The coordinates and pinned target one reader prompt names. */
export interface ReaderCell {
  readonly module: string
  readonly bugClass: string
  /** Whether the class is swept once for the whole repository instead of per module. */
  readonly repoScoped: boolean
  readonly targetRepo: string
  readonly commit: string
}

/**
 * The reader's task prompt.
 * @param cell - the audited cell and the pinned target.
 * @returns the user-message text delivered to the reader.
 */
export function readerPrompt(cell: ReaderCell): string {
  const definition = BUG_CLASS_DEFINITIONS[cell.bugClass]
  const bugClass = definition === undefined ? `"${cell.bugClass}"` : `"${cell.bugClass}" (${definition})`
  const scope = cell.repoScoped
    ? 'the whole repository'
    : cell.module === '.'
      ? 'the files at the repository root (not its subdirectories)'
      : `the module ${cell.module}/`
  return `Target: the git repository at ${cell.targetRepo}, whose working tree matches commit ${cell.commit}. `
    + `Find one vulnerability of the class ${bugClass} in ${scope}. `
    + 'You may read any file in the repository: callers, routes, and middleware outside the module often decide '
    + 'whether input is untrusted or a check exists. Read only inside the repository. Do not trust comments or names; read the code. '
    + 'If you find a vulnerability, report outcome "flagged" with every location that shows it: path relative to the '
    + 'repository root, one-based line, and the enclosing symbol when there is one. At least one location must lie in the '
    + 'audited code. If you read carefully and find none, report outcome "clean" and list in examined every function or '
    + 'other symbol you inspected as path relative to the repository root and symbol name; at least one must lie in the '
    + 'audited code. Every symbol must be one identifier copied exactly as it appears in that file, such as a function, '
    + 'class, or constant name, never a description or a list. Explain your conclusion in reason.'
}

/** The structured report the reader must return. */
export const READER_REPORT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'locations', 'examined', 'reason'],
  properties: {
    outcome: { type: 'string', enum: ['flagged', 'clean'] },
    locations: {
      type: 'array',
      description: 'Every location showing the vulnerability; required when flagged.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'line'],
        properties: {
          path: { type: 'string', description: 'Path relative to the repository root.' },
          line: { type: 'integer', description: 'One-based line.' },
          symbol: { type: 'string', description: 'The enclosing function or other symbol.' },
        },
      },
    },
    examined: {
      type: 'array',
      description: 'Every function or other symbol inspected; required when clean.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'symbol'],
        properties: {
          path: { type: 'string', description: 'Path relative to the repository root.' },
          symbol: { type: 'string' },
        },
      },
    },
    reason: { type: 'string', description: 'Why you reached this outcome.' },
  },
}

const reportSchema = zod.object({
  outcome: zod.enum(['flagged', 'clean']),
  locations: zod.array(zod.object({
    path: zod.string(),
    line: zod.number().int(),
    symbol: zod.string().optional(),
  })),
  examined: zod.array(zod.object({ path: zod.string(), symbol: zod.string() })),
  reason: zod.string(),
})

/** The reader's validated structured report. */
export type ReaderReport = zod.infer<typeof reportSchema>

/**
 * Validate the reader's structured value at the subagent boundary.
 * @param value - the structured result the subagent seam returned.
 * @returns the typed report, or undefined when the value does not match.
 */
export function parseReaderReport(value: unknown): ReaderReport | undefined {
  const parsed = reportSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
