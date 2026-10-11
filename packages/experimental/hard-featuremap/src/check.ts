/**
 * The feature completeness check. From a feature's entry points the harness
 * computes the reach (symbols the handlers call, transitively, to a depth,
 * without expanding widely shared library symbols) and the required set (the
 * near symbols, plus every reached guard and state-writing symbol). A
 * feature claim must account for every required symbol, either as a member
 * or as an exclusion with a reason, and a member outside the reach must cite
 * the call site that reaches it.
 * @module @deepseek-ai/dsh-experimental-hard-featuremap/check
 */

import type { HardEntryPoint } from './wordpress.ts'

/** The graph queries the check reads, bound to one snapshot. */
export interface HardFeatureGraph {
  /** The symbol's name and location, or undefined when the snapshot has no such symbol. */
  symbol(id: string): { readonly name: string; readonly file: string } | undefined
  /** The distinct symbols one symbol calls. */
  callees(id: string): readonly string[]
  /** How many distinct symbols call one symbol. */
  fanIn(id: string): number
  /** The entry point with a `kind:key` identity. */
  entryPoint(key: string): HardEntryPoint | undefined
}

/** The tunables of the check. */
export interface HardFeaturePolicy {
  /** How many call levels the reach follows from the handlers. */
  readonly depth: number
  /** The call levels whose non-library symbols are required. */
  readonly requiredDepth: number
  /** Distinct callers above which a symbol is a shared library symbol the reach does not expand. */
  readonly libraryFanIn: number
  /** The largest share of the required set a claim may exclude, in percent. */
  readonly maxExcludedPercent: number
  /** Names or ids of access-check symbols; every reached one is required. */
  readonly guards: ReadonlySet<string>
  /** Names or ids of state-writing symbols; every reached one is required. */
  readonly mutations: ReadonlySet<string>
}

/** Why a symbol is required. */
export type HardRequiredReason = 'entry' | 'near' | 'guard' | 'mutation'

/** The reach and required set of a feature's handlers. */
export interface HardRequiredSet {
  /** Reached symbols with the call level they were first reached at; handlers are level 0. */
  readonly reach: ReadonlyMap<string, number>
  /** Reached symbols the reach did not expand because they are widely shared. */
  readonly library: ReadonlySet<string>
  /** Required symbols with every reason that requires them. */
  readonly required: ReadonlyMap<string, readonly HardRequiredReason[]>
}

/**
 * The reach and required set of the given handlers.
 * @param graph - the snapshot graph.
 * @param handlers - the feature's handler symbols.
 * @param policy - the check tunables.
 * @returns the reach, the library symbols, and the required set.
 */
export function requiredSet(graph: HardFeatureGraph, handlers: readonly string[], policy: HardFeaturePolicy): HardRequiredSet {
  const handlerSet = new Set(handlers)
  const reach = new Map<string, number>(handlers.map(handler => [handler, 0]))
  const library = new Set<string>()
  let frontier = [...reach.keys()]
  for (let level = 1; level <= policy.depth; level += 1) {
    const next: string[] = []
    for (const node of frontier) {
      if (!handlerSet.has(node) && graph.fanIn(node) > policy.libraryFanIn) {
        library.add(node)
        continue
      }
      for (const callee of graph.callees(node)) {
        if (reach.has(callee)) continue
        reach.set(callee, level)
        next.push(callee)
      }
    }
    frontier = next
  }
  for (const node of frontier) {
    if (graph.fanIn(node) > policy.libraryFanIn) library.add(node)
  }
  const required = new Map<string, HardRequiredReason[]>()
  const require = (id: string, reason: HardRequiredReason): void => {
    required.set(id, [...required.get(id) ?? [], reason])
  }
  for (const [id, level] of reach) {
    const name = graph.symbol(id)?.name ?? id
    if (level === 0) require(id, 'entry')
    else if (level <= policy.requiredDepth && !library.has(id)) require(id, 'near')
    if (policy.guards.has(name) || policy.guards.has(id)) require(id, 'guard')
    if (policy.mutations.has(name) || policy.mutations.has(id)) require(id, 'mutation')
  }
  return { reach, library, required }
}

/** A feature as the model claims it. */
export interface HardFeatureClaim {
  /** Entry points as `kind:key`. */
  readonly entryPoints: readonly string[]
  readonly symbols: readonly { readonly symbol: string; readonly role: 'entry' | 'guard' | 'mutation' | 'helper' }[]
  readonly excluded: readonly { readonly symbol: string; readonly reason: 'utility' | 'other-feature' | 'unreachable' }[]
  /** For members outside the reach: the reached caller and the line of the call in the caller's file. */
  readonly via: readonly { readonly symbol: string; readonly caller: string; readonly line: number }[]
}

/** The outcome of one check. */
export interface HardFeatureCheck {
  /** Every reason the claim is refused; empty when it stands. */
  readonly shortfalls: readonly string[]
  readonly reach: number
  readonly required: number
}

/** Required symbols listed by name in one shortfall before the rest are counted. */
const LISTED_MISSING = 20

/**
 * Check one feature claim against the snapshot graph.
 * @param graph - the snapshot graph.
 * @param claim - the model's feature claim.
 * @param policy - the check tunables.
 * @param lineText - reads one line of a file at the pinned commit, undefined when the line does not exist.
 * @returns every shortfall, plus the reach and required-set sizes.
 */
export async function checkFeature(
  graph: HardFeatureGraph,
  claim: HardFeatureClaim,
  policy: HardFeaturePolicy,
  lineText: (file: string, line: number) => Promise<string | undefined>,
): Promise<HardFeatureCheck> {
  const shortfalls: string[] = []
  const handlers: string[] = []
  for (const key of claim.entryPoints) {
    const entry = graph.entryPoint(key)
    if (entry === undefined) shortfalls.push(`entry point ${key} is not in the feature map; read the list with hard_query_map view entry-points`)
    else if (entry.handler === null) shortfalls.push(`entry point ${key} has no resolved handler; name its handler as a symbol with role entry`)
    else handlers.push(entry.handler)
  }
  const unknown = claim.symbols.map(member => member.symbol).filter(id => graph.symbol(id) === undefined)
  if (unknown.length > 0) shortfalls.push(`symbols not in the feature map: ${unknown.join(', ')}; find ids with hard_query_map view symbol`)
  for (const member of claim.symbols) {
    if (member.role === 'entry' && graph.symbol(member.symbol) !== undefined && !handlers.includes(member.symbol)) handlers.push(member.symbol)
  }
  if (handlers.length === 0) {
    shortfalls.push('a feature needs at least one entry point with a handler or one symbol with role entry')
    return { shortfalls, reach: 0, required: 0 }
  }
  const { reach, required } = requiredSet(graph, handlers, policy)
  const members = new Set(claim.symbols.map(member => member.symbol))
  const excluded = new Map(claim.excluded.map(entry => [entry.symbol, entry.reason]))
  const missing = [...required].filter(([id]) => !members.has(id) && !excluded.has(id))
  if (missing.length > 0) {
    const listed = missing.slice(0, LISTED_MISSING).map(([id, reasons]) => `${id} (${reasons.join(', ')})`)
    const more = missing.length > LISTED_MISSING ? ` and ${missing.length - LISTED_MISSING} more` : ''
    shortfalls.push(`${missing.length} required symbols are neither members nor excluded: ${listed.join('; ')}${more}`)
  }
  const sensitive = [...excluded].filter(([id, reason]) => reason === 'utility' && required.get(id)?.some(why => why === 'guard' || why === 'mutation'))
  if (sensitive.length > 0) {
    shortfalls.push(`guards and state writes cannot be excluded as utility: ${sensitive.map(([id]) => id).join(', ')}`)
  }
  const excludedRequired = [...excluded.keys()].filter(id => required.has(id)).length
  if (excludedRequired * 100 > required.size * policy.maxExcludedPercent) {
    shortfalls.push(`the claim excludes ${excludedRequired} of ${required.size} required symbols; at most ${policy.maxExcludedPercent}% may be excluded`)
  }
  for (const member of claim.symbols) {
    const found = graph.symbol(member.symbol)
    if (found === undefined || reach.has(member.symbol)) continue
    const via = claim.via.find(entry => entry.symbol === member.symbol)
    const problem = await citationProblem(graph, { id: member.symbol, name: found.name }, via, reach, members, lineText)
    if (problem !== undefined) shortfalls.push(problem)
  }
  for (const member of claim.symbols) {
    if (member.role !== 'guard' && member.role !== 'mutation') continue
    const names = member.role === 'guard' ? policy.guards : policy.mutations
    if (graph.symbol(member.symbol) !== undefined && !reachesName(graph, member.symbol, names, policy.requiredDepth + 1)) {
      shortfalls.push(`${member.symbol} has role ${member.role} but neither is nor calls a known ${member.role === 'guard' ? 'access check' : 'state write'}`)
    }
  }
  return { shortfalls, reach: reach.size, required: required.size }
}

async function citationProblem(
  graph: HardFeatureGraph,
  target: { readonly id: string; readonly name: string },
  via: { readonly caller: string; readonly line: number } | undefined,
  reach: ReadonlyMap<string, number>,
  members: ReadonlySet<string>,
  lineText: (file: string, line: number) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (via === undefined) {
    return `${target.id} is outside the reach of the feature's handlers; cite the call that reaches it in via (caller and line)`
  }
  if (!reach.has(via.caller) && !members.has(via.caller)) return `the via caller ${via.caller} of ${target.id} is neither reached nor a member`
  const caller = graph.symbol(via.caller)
  if (caller === undefined) return `the via caller ${via.caller} of ${target.id} is not in the feature map`
  const text = await lineText(caller.file, via.line)
  if (text === undefined) return `the via line ${caller.file}:${via.line} for ${target.id} does not exist at the pinned commit`
  if (!text.includes(target.name)) return `the via line ${caller.file}:${via.line} does not mention ${target.name}`
  return undefined
}

/** Whether a symbol is, or calls within a depth, a symbol with one of the names. */
function reachesName(graph: HardFeatureGraph, start: string, names: ReadonlySet<string>, depth: number): boolean {
  const seen = new Set([start])
  let frontier = [start]
  for (let level = 0; level <= depth; level += 1) {
    if (frontier.some(id => names.has(id) || names.has(graph.symbol(id)?.name ?? id))) return true
    frontier = frontier.flatMap(id => graph.callees(id)).filter((id) => {
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  }
  return false
}
