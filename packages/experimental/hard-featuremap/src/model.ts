/**
 * The in-memory view of one fact file that the repairs and the framework
 * profiles read: types with their parents, methods by id and by name, free
 * functions, and call sites in file order (the order is the call-site
 * sequence number the store keeps).
 * @module @deepseek-ai/dsh-experimental-hard-featuremap/model
 */

import type { HardCpgFact } from '@deepseek-ai/dsh-experimental-hard-cpg'

/** A declared type fact. */
export type TypeFact = Extract<HardCpgFact, { k: 'type' }>
/** An internal method fact. */
export type MethodFact = Extract<HardCpgFact, { k: 'method' }>
/** A call-site fact. */
export type CallFact = Extract<HardCpgFact, { k: 'call' }>

/** The indexed facts of one pinned commit. */
export interface FactModel {
  readonly files: readonly string[]
  readonly types: ReadonlyMap<string, TypeFact>
  readonly methods: ReadonlyMap<string, MethodFact>
  /** Method ids by method name, for name-only lookups. */
  readonly methodsByName: ReadonlyMap<string, readonly string[]>
  /** Ids of free functions (no owning type, not file-level code). */
  readonly functions: ReadonlySet<string>
  /** The file-level code of each file, by repository-relative path. */
  readonly fileLevel: ReadonlyMap<string, string>
  readonly calls: readonly CallFact[]
}

/**
 * Index facts read from one file.
 * @param facts - the facts in file order.
 * @returns the model the repairs and profiles read.
 */
export async function buildModel(facts: AsyncIterable<HardCpgFact>): Promise<FactModel> {
  const files: string[] = []
  const types = new Map<string, TypeFact>()
  const methods = new Map<string, MethodFact>()
  const methodsByName = new Map<string, string[]>()
  const functions = new Set<string>()
  const fileLevel = new Map<string, string>()
  const calls: CallFact[] = []
  for await (const fact of facts) {
    switch (fact.k) {
      case 'file':
        files.push(fact.path)
        break
      case 'type':
        types.set(fact.id, fact)
        break
      case 'method': {
        methods.set(fact.id, fact)
        const named = methodsByName.get(fact.name)
        if (named === undefined) methodsByName.set(fact.name, [fact.id])
        else named.push(fact.id)
        if (fact.fileLevel) fileLevel.set(fact.file, fact.id)
        else if (fact.owner === null) functions.add(fact.id)
        break
      }
      case 'call':
        calls.push(fact)
        break
    }
  }
  return { files, types, methods, methodsByName, functions, fileLevel, calls }
}

/**
 * A type followed by its ancestors, nearest first; cycles and unknown parents end the walk.
 * @param model - the indexed facts.
 * @param typeId - the starting type.
 * @returns the type and every known ancestor.
 */
export function lineage(model: FactModel, typeId: string): string[] {
  const seen: string[] = []
  const queue = [typeId]
  for (const id of queue) {
    const type = model.types.get(id)
    if (type === undefined || seen.includes(id)) continue
    seen.push(id)
    queue.push(...type.inherits)
  }
  return seen
}

/**
 * The method a type answers for a name: its own, or the nearest ancestor's.
 * @param model - the indexed facts.
 * @param typeId - the receiving type.
 * @param name - the method name.
 * @returns the method id, or undefined when no type in the lineage declares it.
 */
export function findMethod(model: FactModel, typeId: string, name: string): string | undefined {
  for (const id of lineage(model, typeId)) {
    const method = `${id}.${name}`
    if (model.methods.has(method)) return method
  }
  return undefined
}
