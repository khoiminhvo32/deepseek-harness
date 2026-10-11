/**
 * Guard pairs: entry points that reach the same state write where one lacks
 * every guard of a category that most of the others carry. Framework-neutral:
 * guards come from routing (annotations, decorators, middleware), from the
 * symbols reached on the call graph, and from the model's declared guards,
 * and the category of a guard comes from its declaration or from name
 * patterns.
 * @module @deepseek-ai/dsh-experimental-hard-featuremap/pairs
 */

import type { HardFeatureId, HardFeaturePairData, HardGuardCategory } from '@deepseek-ai/dsh-experimental-hard-ledger'
import type { HardEntryAuth } from './wordpress.ts'

/** The guard categories in the order pairs are reported. */
export const HARD_GUARD_CATEGORIES: readonly HardGuardCategory[] = ['csrf', 'authentication', 'authorization']

/** What one mapped entry point checks and writes. */
export interface HardGuardProfile {
  /** The entry point as `kind:key`. */
  readonly key: string
  readonly auth: HardEntryAuth
  /** The first recorded feature that lists the entry point. */
  readonly feature: HardFeatureId
  /** Routing guards and reached guard symbols. */
  readonly guards: readonly string[]
  /** Reached state writes and the feature's declared written state. */
  readonly writes: readonly string[]
}

/**
 * The guard pairs among mapped entry points. Within each written state, an
 * entry point that has no guard of a category is paired with the first one
 * that has when at least half the writers have one. CSRF is compared only
 * between entry points of the same kind, because a kind such as a REST API
 * checks request forgery once in the server. An entry point routed as
 * authenticated counts as having an authentication guard. One pair is kept
 * per weaker entry point and category, naming every state it was found on.
 * @param profiles - the mapped entry points in index order.
 * @param categoryOf - the category of one guard.
 * @returns the pairs without ids.
 */
export function guardPairs(profiles: readonly HardGuardProfile[], categoryOf: (guard: string) => HardGuardCategory): Omit<HardFeaturePairData, 'id'>[] {
  const writers = new Map<string, HardGuardProfile[]>()
  for (const profile of profiles) {
    for (const state of new Set(profile.writes)) writers.set(state, [...writers.get(state) ?? [], profile])
  }
  const found = new Map<string, Omit<HardFeaturePairData, 'id'>>()
  for (const [state, group] of writers) {
    for (const category of HARD_GUARD_CATEGORIES) {
      for (const peers of category === 'csrf' ? byKind(group) : [group]) {
        const guardsOf = (profile: HardGuardProfile) => profile.guards.filter(guard => categoryOf(guard) === category)
        const has = (profile: HardGuardProfile) => guardsOf(profile).length > 0 || (category === 'authentication' && profile.auth === 'authenticated')
        const stronger = peers.filter(has)
        const strongest = stronger[0]
        if (strongest === undefined || stronger.length * 2 < peers.length) continue
        for (const weaker of peers.filter(profile => !has(profile))) {
          const id = `${weaker.key}\u0000${category}`
          const prior = found.get(id)
          if (prior !== undefined) {
            found.set(id, { ...prior, states: [...prior.states, state] })
            continue
          }
          const missing = guardsOf(strongest)
          found.set(id, {
            category,
            states: [state],
            weaker: { entry: weaker.key, feature: weaker.feature },
            stronger: { entry: strongest.key, feature: strongest.feature },
            missing: missing.length > 0 ? missing : ['an authenticated route'],
          })
        }
      }
    }
  }
  return profiles.flatMap(profile => HARD_GUARD_CATEGORIES.flatMap((category) => {
    const pair = found.get(`${profile.key}\u0000${category}`)
    return pair === undefined ? [] : [pair]
  }))
}

/** The writers of one state split by entry kind, the part of the key before the first colon. */
function byKind(group: readonly HardGuardProfile[]): HardGuardProfile[][] {
  const kinds = new Map<string, HardGuardProfile[]>()
  for (const profile of group) {
    const kind = profile.key.slice(0, profile.key.indexOf(':'))
    kinds.set(kind, [...kinds.get(kind) ?? [], profile])
  }
  return [...kinds.values()]
}

/**
 * The category of a guard: its declared category when the model declared it,
 * otherwise CSRF or authentication when its name matches that pattern, and
 * authorization for every other guard.
 * @param declared - declared guard categories by symbol.
 * @param patterns - the CSRF and authentication name patterns.
 * @returns the classifier.
 */
export function guardCategories(
  declared: ReadonlyMap<string, HardGuardCategory>,
  patterns: { readonly csrf: RegExp; readonly authentication: RegExp },
): (guard: string) => HardGuardCategory {
  return (guard) => {
    const category = declared.get(guard)
    if (category !== undefined) return category
    if (patterns.csrf.test(guard)) return 'csrf'
    return patterns.authentication.test(guard) ? 'authentication' : 'authorization'
  }
}
