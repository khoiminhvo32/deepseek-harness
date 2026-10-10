/**
 * Call edges over one fact model. Joern's own resolution comes first; for a
 * call Joern left unresolved, the repairs below add an edge only when the
 * facts name exactly one target, and every edge records which rule made it.
 * @module @deepseek-ai/dsh-experimental-hard-featuremap/repair
 */

import { findMethod } from './model.ts'
import type { FactModel } from './model.ts'

/**
 * Which rule made a call edge: `joern` (the graph's own resolution),
 * `repair` (a type-qualified, relative, or receiverless call resolved through
 * the type lineage, or a free function a class-qualified call meant), `unique-name`
 * (a method call on an unknown receiver whose name only one method carries),
 * or `hook` (a fired hook reaching a registered callback).
 */
export type HardEdgeSource = 'joern' | 'repair' | 'unique-name' | 'hook'

/** One call edge; `site` is the sequence number of the call site that made it (for a hook edge, the firing site). */
export interface HardCallEdge {
  readonly site: number
  readonly caller: string
  readonly callee: string
  readonly file: string
  readonly line: number | null
  readonly source: HardEdgeSource
}

/** The target Joern gives a call it could not name. */
const UNKNOWN_TARGET = '<unknownFullName>'

/**
 * The call edges of every call site in the model.
 * @param model - the indexed facts.
 * @returns one edge per resolved target, in call-site order.
 */
export function callEdges(model: FactModel): HardCallEdge[] {
  const edges: HardCallEdge[] = []
  model.calls.forEach((call, site) => {
    const edge = (callee: string, source: HardEdgeSource): void => {
      edges.push({ site, caller: call.caller, callee, file: call.file, line: call.line, source })
    }
    if (call.resolved.length > 0) {
      for (const callee of call.resolved) edge(callee, 'joern')
      return
    }
    const repaired = repairTarget(model, call.caller, call.target, call.name)
    if (repaired !== undefined) {
      edge(repaired, 'repair')
      return
    }
    const [only, ...others] = model.methodsByName.get(call.name) ?? []
    if (call.dispatch === 'dynamic' && only !== undefined && others.length === 0) edge(only, 'unique-name')
  })
  return edges
}

/**
 * The single target a call Joern left unresolved means, when the facts name one.
 * A call Joern could not name at all (Ruby's receiverless calls) and a
 * `parent`, `self`, or `static` prefix are relative to the caller's type; a
 * known type prefix resolves through that type's lineage and, failing that, to
 * the free function of the same name, because PHP resolves an unqualified call
 * inside a class to the global function (Joern issue 3050).
 */
function repairTarget(model: FactModel, caller: string, target: string, name: string): string | undefined {
  const owner = model.methods.get(caller)?.owner ?? null
  if (target === UNKNOWN_TARGET) return owner === null ? undefined : findMethod(model, owner, name)
  const dot = target.lastIndexOf('.')
  if (dot <= 0) return model.functions.has(name) ? name : undefined
  const prefix = target.slice(0, dot)
  if (prefix === 'parent') {
    for (const parent of owner === null ? [] : model.types.get(owner)?.inherits ?? []) {
      const found = findMethod(model, parent, name)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (prefix === 'self' || prefix === 'static') return owner === null ? undefined : findMethod(model, owner, name)
  if (!model.types.has(prefix)) return undefined
  return findMethod(model, prefix, name) ?? (model.functions.has(name) ? name : undefined)
}
