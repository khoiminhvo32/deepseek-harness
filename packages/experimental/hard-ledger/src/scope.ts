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
 * `sampleCellForSpotCheck`. A salt draws an independent sample over the same
 * cells: the independent audit salts with the pinned commit, so its sample
 * differs between targets and stays stable across resumes.
 * @param cell - the coverage cell coordinates.
 * @param percent - the share of cells to sample, 0 through 100.
 * @param salt - optional sample identity; omitted keeps the unsalted sample.
 * @returns true when the caller inspects this cell.
 */
export function cellSampledForPercent(cell: { module: string; bugClass: string }, percent: number, salt?: string): boolean {
  if (percent <= 0) return false
  if (percent >= 100) return true
  const coordinates = `${cell.module}\u0000${cell.bugClass}`
  const digest = createHash('sha256').update(salt === undefined ? coordinates : `${coordinates}\u0000${salt}`).digest()
  return digest.readUInt8(0) * 100 < percent * 256
}
