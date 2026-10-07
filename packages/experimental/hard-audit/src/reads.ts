/**
 * Contamination detection for the independent reader. The reader's tools can
 * open any path the process can, so blindness to the mission agent's claims
 * is checked after the fact: every path argument the reader passed to a read
 * tool must resolve inside the target repository and outside the harness's
 * own state, where session logs carry the mission agent's verdicts. A read
 * outside the target is still allowed when an earlier result of the reader's
 * own tools named that exact path — the spill file holding its own oversized
 * search result. The check voids a measurement; it does not prevent the read.
 * @module
 */

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** One read-tool call of the reader: the tool and its path argument, if any. */
export interface ReaderAccess {
  readonly tool: string
  /** The path argument as the reader wrote it; absent means the session workspace. */
  readonly path?: string
}

/** The path argument each read tool takes; `optional` tools default to the workspace. */
const PATH_ARGUMENTS: Readonly<Record<string, { readonly name: string; readonly optional: boolean }>> = {
  read: { name: 'file_path', optional: false },
  read_image: { name: 'file_path', optional: false },
  lsp: { name: 'file_path', optional: false },
  glob: { name: 'path', optional: true },
  grep: { name: 'path', optional: true },
}

/**
 * The read access one reader tool call made, from its raw arguments.
 * @param tool - the called tool's name.
 * @param args - the raw JSON arguments exactly as the model produced them.
 * @returns the access, or undefined for a tool that reads no path or arguments that never reached execution.
 */
export function readAccessOf(tool: string, args: string): ReaderAccess | undefined {
  const argument = PATH_ARGUMENTS[tool]
  if (argument === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    // SyntaxError: arguments that are not JSON fail validation before the tool runs, so nothing was read.
    return undefined
  }
  const value = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)[argument.name] : undefined
  if (typeof value === 'string') return { tool, path: value }
  return argument.optional && value === undefined ? { tool } : undefined
}

/**
 * Absolute paths named in one tool result's text, so a later read of the
 * reader's own spill file is recognized as its own output.
 * @param text - the model-facing text of one tool result.
 * @returns every absolute POSIX path token in the text.
 */
export function namedPaths(text: string): string[] {
  return [...text.matchAll(/(?:^|[\s'"`(])(\/[^\s'"`)]+)/gu)].map(match => match[1] as string)
}

/** Where the reader may read and what it may never touch. */
export interface ReadScope {
  /** The reader's session workspace, which relative paths resolve against. */
  readonly cwd: string
  /** The pinned target repository. */
  readonly targetRepo: string
  /** Harness state directories: project `.dsh/` state and the DSH home. */
  readonly stateDirs: readonly string[]
  /** Absolute paths the reader's own earlier tool results named. */
  readonly ownOutputs: ReadonlySet<string>
}

/**
 * The first read that breaks the reader's blindness, if any.
 * @param accesses - the reader's read accesses in call order.
 * @param scope - the target, the harness state, and the reader's own outputs.
 * @returns the offending path as the reader wrote it (`.` for a workspace default), or undefined when every read stayed in scope.
 */
export async function firstContaminatingRead(accesses: readonly ReaderAccess[], scope: ReadScope): Promise<string | undefined> {
  const target = await canonical(scope.targetRepo)
  const stateDirs = await Promise.all(scope.stateDirs.map(canonical))
  for (const access of accesses) {
    const lexical = absolute(access.path, scope.cwd)
    const real = await canonical(lexical)
    const inScope = isUnder(real, target) || scope.ownOutputs.has(lexical) || scope.ownOutputs.has(real)
    if (!inScope || stateDirs.some(dir => isUnder(real, dir))) return access.path ?? '.'
  }
  return undefined
}

/** Resolve one path argument the way the read tools do: home-relative, absolute, or workspace-relative. */
function absolute(path: string | undefined, cwd: string): string {
  if (path === undefined) return resolve(cwd)
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

/**
 * The symlink-free form of one absolute path. A path that does not resolve
 * keeps its unresolved tail below the nearest ancestor that does, so it
 * compares against canonical roots on the same terms.
 */
async function canonical(path: string): Promise<string> {
  const lexical = resolve(path)
  const parent = dirname(lexical)
  try {
    return await realpath(lexical)
  } catch {
    // ENOENT or EACCES: nothing was read through this path's own symlink; resolve its parent instead.
    /* v8 ignore next -- defensive: the filesystem root always resolves, so the walk ends before it. */
    if (parent === lexical) return lexical
    return join(await canonical(parent), basename(lexical))
  }
}

/** Whether `path` is `root` or lies below it. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}
