/**
 * Deterministic hashes binding a finding to its claim and its root cause:
 * the claim hash is the proof-of-effect marker the PoC must print, and the
 * fingerprint deduplicates proposals that share component, symbol, and bug
 * class.
 * @module
 */

import { createHash } from 'node:crypto'

/** Normalize one fingerprint component: trimmed, lowercased, whitespace-collapsed. */
function normalize(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/gu, ' ')
}

/**
 * Full 64-hex hash of the claim text; the PoC must print `HARD-PASS <hash>`.
 * @param claim - the finding's claim text.
 * @returns the sha256 hex digest the verifier matches on.
 */
export function claimHash(claim: string): string {
  return createHash('sha256').update(claim, 'utf8').digest('hex')
}

/**
 * Full 64-hex root-cause dedup key over bug class, component, and the
 * containing symbol when the model can name one. Identical hashes merge.
 * @param request - the normalized components of the root cause.
 * @returns the sha256 hex fingerprint.
 */
export function rootFingerprint(request: { bugClass: string; component: string; symbol?: string }): string {
  return createHash('sha256')
    .update(`${normalize(request.bugClass)}\u0000${normalize(request.component)}\u0000${request.symbol === undefined ? '' : normalize(request.symbol)}`, 'utf8')
    .digest('hex')
}
