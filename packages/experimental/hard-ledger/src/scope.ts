/**
 * Coverage cell economics shared by every hard plugin: the protocol scope of
 * each bug class and the deterministic cell sampling the cross-check and the
 * screen re-read both use. Values are security-adjacent protocol, not
 * tunables: they are properties of the bug classes, not deployment choices.
 * @module
 */

import { createHash } from 'node:crypto'

/**
 * Scope of each bug class: one cell for the whole repository, or one cell per
 * module. A class missing from the table defaults to `module` — fail-safe
 * toward more work, never less. `dependencies` and `misconfig` live in
 * manifests, lockfiles, CI recipes, and framework configuration, which are
 * repository-level artifacts; the remaining classes follow code, so their
 * cells are per-module.
 */
export const CLASS_SCOPE: Readonly<Record<string, 'repo' | 'module'>> = {
  dependencies: 'repo',
  misconfig: 'repo',
}

/**
 * The scope one bug class sweeps: defaults to `module` for unknown classes.
 * @param bugClass - the bug class name to classify.
 * @returns `repo` for repository-level classes, `module` otherwise.
 */
export function classScope(bugClass: string): 'repo' | 'module' {
  return CLASS_SCOPE[bugClass] ?? 'module'
}

/**
 * Deterministic sampling of one coverage cell by the hash of its coordinates:
 * the same cell is always sampled or always skipped at a given percent, so
 * neither the coverage cross-check nor the screen re-read depends on
 * wall-clock randomness. The coverage cross-check exposes this as
 * `sampleCellForSpotCheck`.
 * @param cell - the coverage cell coordinates.
 * @param percent - the share of cells to sample, 0 through 100.
 * @returns true when the caller inspects this cell.
 */
export function cellSampledForPercent(cell: { module: string; bugClass: string }, percent: number): boolean {
  if (percent <= 0) return false
  if (percent >= 100) return true
  const digest = createHash('sha256').update(`${cell.module}\u0000${cell.bugClass}`).digest()
  return (digest[0] ?? 255) * 100 < percent * 256
}
