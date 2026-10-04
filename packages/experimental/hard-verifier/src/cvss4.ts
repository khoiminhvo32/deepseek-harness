/**
 * Deterministic CVSS v4.0 engine: a typed port of the FIRST reference
 * calculator (https://github.com/FIRSTdotorg/cvss-v4-calculator, BSD-2-Clause).
 * Parsing follows the `expectedMetricOrder` table from the same repository;
 * scoring delegates to the vendored lookup in ./cvss4-lookup.ts. The
 * exhaustive test suite pins every MacroVector's refined score to its lookup
 * value, so a drift from the reference fails loudly here.
 * @module
 */

import { CVSS4_LOOKUP, CVSS4_MAX_COMPOSED, CVSS4_MAX_SEVERITY } from './cvss4-lookup.ts'

/** Metric ordering and legal values, verbatim from the reference `metrics.js`. */
const EXPECTED_METRIC_ORDER: Readonly<Record<string, readonly string[]>> = {
  AV: ['N', 'A', 'L', 'P'],
  AC: ['L', 'H'],
  AT: ['N', 'P'],
  PR: ['N', 'L', 'H'],
  UI: ['N', 'P', 'A'],
  VC: ['H', 'L', 'N'],
  VI: ['H', 'L', 'N'],
  VA: ['H', 'L', 'N'],
  SC: ['H', 'L', 'N'],
  SI: ['H', 'L', 'N'],
  SA: ['H', 'L', 'N'],
  E: ['X', 'A', 'P', 'U'],
  CR: ['X', 'H', 'M', 'L'],
  IR: ['X', 'H', 'M', 'L'],
  AR: ['X', 'H', 'M', 'L'],
  MAV: ['X', 'N', 'A', 'L', 'P'],
  MAC: ['X', 'L', 'H'],
  MAT: ['X', 'N', 'P'],
  MPR: ['X', 'N', 'L', 'H'],
  MUI: ['X', 'N', 'P', 'A'],
  MVC: ['X', 'H', 'L', 'N'],
  MVI: ['X', 'H', 'L', 'N'],
  MVA: ['X', 'H', 'L', 'N'],
  MSC: ['X', 'H', 'L', 'N'],
  MSI: ['X', 'S', 'H', 'L', 'N'],
  MSA: ['X', 'S', 'H', 'L', 'N'],
  S: ['X', 'N', 'P'],
  AU: ['X', 'N', 'Y'],
  R: ['X', 'A', 'U', 'I'],
  V: ['X', 'D', 'C'],
  RE: ['X', 'L', 'M', 'H'],
  U: ['X', 'Clear', 'Green', 'Amber', 'Red'],
}

/** Base metrics every vector must declare. */
const BASE_REQUIRED = ['AV', 'AC', 'AT', 'PR', 'UI', 'VC', 'VI', 'VA', 'SC', 'SI', 'SA'] as const

/** Severity-distance tables, verbatim from the reference `cvss_score.js`. */
const AV_LEVELS = { N: 0.0, A: 0.1, L: 0.2, P: 0.3 } as const
const PR_LEVELS = { N: 0.0, L: 0.1, H: 0.2 } as const
const UI_LEVELS = { N: 0.0, P: 0.1, A: 0.2 } as const
const AC_LEVELS = { L: 0.0, H: 0.1 } as const
const AT_LEVELS = { N: 0.0, P: 0.1 } as const
const VC_LEVELS = { H: 0.0, L: 0.1, N: 0.2 } as const
const VI_LEVELS = { H: 0.0, L: 0.1, N: 0.2 } as const
const VA_LEVELS = { H: 0.0, L: 0.1, N: 0.2 } as const
const SC_LEVELS = { H: 0.1, L: 0.2, N: 0.3 } as const
const SI_LEVELS = { S: 0.0, H: 0.1, L: 0.2, N: 0.3 } as const
const SA_LEVELS = { S: 0.0, H: 0.1, L: 0.2, N: 0.3 } as const
const CR_LEVELS = { H: 0.0, M: 0.1, L: 0.2 } as const

/** A parsed, validated CVSS v4.0 vector: metric abbreviations to declared values. */
export type ParsedVector = Readonly<Record<string, string>>

/**
 * Parse and validate one vector string; every violation throws.
 * @param vector - the raw `CVSS:4.0/...` string.
 * @returns the parsed metric map with optional metrics defaulted to `X`.
 */
export function parseVector(vector: string): ParsedVector {
  const prefix = 'CVSS:4.0/'
  if (!vector.startsWith(prefix)) {
    throw new Error('cvss vector must start with CVSS:4.0/')
  }
  const selected: Record<string, string> = {}
  for (const part of vector.slice(prefix.length).split('/')) {
    if (part.length === 0) throw new Error('cvss vector contains an empty metric segment')
    const separator = part.indexOf(':')
    if (separator <= 0) throw new Error(`cvss vector segment "${part}" is not METRIC:VALUE`)
    const metric = part.slice(0, separator)
    const value = part.slice(separator + 1)
    const legal = EXPECTED_METRIC_ORDER[metric]
    if (legal === undefined) throw new Error(`cvss vector has unknown metric ${metric}`)
    if (!legal.includes(value)) throw new Error(`cvss vector value ${value} is illegal for ${metric}`)
    if (selected[metric] !== undefined) throw new Error(`cvss vector repeats metric ${metric}`)
    selected[metric] = value
  }
  for (const metric of BASE_REQUIRED) {
    if (selected[metric] === undefined) throw new Error(`cvss vector is missing base metric ${metric}`)
  }
  // The reference calculator always carries the optional threat and requirement
  // metrics; "not specified" is their X value, so defaulted vectors score identically.
  for (const metric of ['E', 'CR', 'IR', 'AR']) {
    if (selected[metric] === undefined) selected[metric] = 'X'
  }
  return selected
}

/** The reference `m()`: X-defaulting for threat and requirement metrics, then modified overrides. */
function m(selected: ParsedVector, metric: string): string {
  const value = selected[metric]
  if (metric === 'E' && value === 'X') return 'A'
  if ((metric === 'CR' || metric === 'IR' || metric === 'AR') && value === 'X') return 'H'
  const modified = selected[`M${metric}`]
  if (modified !== undefined && modified !== 'X') return modified
  // Absent only for metrics every caller defaults or requires; '' compares
  // false against every legal value exactly like the reference's undefined.
  return value ?? ''
}

/**
 * The reference `macroVector()`: six equivalence-class digits for one parsed vector.
 * @param selected - the parsed metric map.
 * @returns the six-digit macrovector key.
 */
export function macroVector(selected: ParsedVector): string {
  let eq1: string
  if (m(selected, 'AV') === 'N' && m(selected, 'PR') === 'N' && m(selected, 'UI') === 'N') {
    eq1 = '0'
  } else if ((m(selected, 'AV') === 'N' || m(selected, 'PR') === 'N' || m(selected, 'UI') === 'N')
    && !(m(selected, 'AV') === 'N' && m(selected, 'PR') === 'N' && m(selected, 'UI') === 'N')
    && !(m(selected, 'AV') === 'P')) {
    eq1 = '1'
  } else {
    eq1 = '2'
  }

  const eq2 = m(selected, 'AC') === 'L' && m(selected, 'AT') === 'N' ? '0' : '1'

  let eq3: 0 | 1 | 2
  if (m(selected, 'VC') === 'H' && m(selected, 'VI') === 'H') {
    eq3 = 0
  } else if (!(m(selected, 'VC') === 'H' && m(selected, 'VI') === 'H')
    && (m(selected, 'VC') === 'H' || m(selected, 'VI') === 'H' || m(selected, 'VA') === 'H')) {
    eq3 = 1
  } else {
    eq3 = 2
  }

  let eq4: 0 | 1 | 2
  if (m(selected, 'MSI') === 'S' || m(selected, 'MSA') === 'S') {
    eq4 = 0
  } else if ((m(selected, 'SC') === 'H' || m(selected, 'SI') === 'H' || m(selected, 'SA') === 'H')) {
    eq4 = 1
  } else {
    eq4 = 2
  }

  const exploit = m(selected, 'E')
  const eq5: 0 | 1 | 2 = exploit === 'A' ? 0 : exploit === 'P' ? 1 : 2

  const eq6: 0 | 1 = (m(selected, 'CR') === 'H' && m(selected, 'VC') === 'H')
    || (m(selected, 'IR') === 'H' && m(selected, 'VI') === 'H')
    || (m(selected, 'AR') === 'H' && m(selected, 'VA') === 'H')
    ? 0 : 1

  return `${eq1}${eq2}${eq3}${eq4}${eq5}${eq6}`
}

/** The reference `extractValueMetric()`: read one metric's value out of a composed max-vector string. */
function extractValueMetric(metric: string, composed: string): string {
  const extracted = composed.slice(composed.indexOf(metric) + metric.length + 1)
  const slash = extracted.indexOf('/')
  /* v8 ignore next -- reference port: composed fragments always carry the trailing separator */
  return slash > 0 ? extracted.substring(0, slash) : extracted
}

/** Read one vendored-table entry; the tables cover every reachable key by construction. */
function tableAt(table: { readonly [key: string]: unknown }, key: string): number {
  const found = table[key]
  /* v8 ignore next -- defensive: the vendored tables cover every reachable key */
  if (typeof found !== 'number') throw new Error(`cvss table entry ${key} is missing`)
  return found
}

/** The reference `getEQMaxes()`: highest-severity composed fragments for one equivalence class. */
function getEQMaxes(macro: string, eq: 1 | 2 | 3 | 4 | 5): readonly string[] {
  switch (eq) {
    case 1:
      return CVSS4_MAX_COMPOSED.eq1[macro.charAt(0) as '0' | '1' | '2']
    case 2:
      return CVSS4_MAX_COMPOSED.eq2[macro.charAt(1) as '0' | '1']
    case 3: {
      const byDigit5 = macro.charAt(5)
      const byEq6 = CVSS4_MAX_COMPOSED.eq3[macro.charAt(2) as '0' | '1' | '2']
      /* v8 ignore next -- defensive: eq3=2 composes only with eq6=1, so one arm stays unexercised */
      if (byDigit5 === '0' && '0' in byEq6) return byEq6['0']
      /* v8 ignore next -- defensive: eq3=2 composes only with eq6=1, so one arm stays unexercised */
      if (byDigit5 === '1' && '1' in byEq6) return byEq6['1']
      /* v8 ignore next -- defensive: exploit-maturity digit 2 pairs with no eq3 table row */
      return []
    }
    case 4:
      return CVSS4_MAX_COMPOSED.eq4[macro.charAt(3) as '0' | '1' | '2']
    case 5:
      return CVSS4_MAX_COMPOSED.eq5[macro.charAt(4) as '0' | '1' | '2']
  }
}

/**
 * Severity band for one score, per the specification ranges.
 * @param score - the computed base score.
 * @returns the band name from None through Critical.
 */
export function severityBand(score: number): 'None' | 'Low' | 'Medium' | 'High' | 'Critical' {
  if (score <= 0) return 'None'
  if (score < 4) return 'Low'
  if (score < 7) return 'Medium'
  if (score < 9) return 'High'
  return 'Critical'
}

/**
 * The reference `cvss_score()`: lookup the MacroVector's score, then refine it
 * by the severity distances of the to-be-scored vector from its MacroVector's
 * highest-severity vectors. Behaviorally identical to the reference code.
 * @param vector - a raw vector string or an already-parsed metric map.
 * @returns the base score rounded to one decimal.
 */
export function scoreVector(vector: string | ParsedVector): number {
  const selected = typeof vector === 'string' ? parseVector(vector) : vector

  if (['VC', 'VI', 'VA', 'SC', 'SI', 'SA'].every(metric => m(selected, metric) === 'N')) {
    return 0.0
  }

  const macro = macroVector(selected)
  // Defensive data-drift guard: every legal vector resolves to a macro in the
  // official table (the exhaustive suite scores all 270 entries), so this arm
  // is unreachable by construction.
  const lookupValue = CVSS4_LOOKUP[macro]
  /* v8 ignore next -- defensive: the official lookup covers every reachable macrovector */
  if (lookupValue === undefined) {
    throw new Error(`cvss macrovector ${macro} has no lookup entry; the vector is not scoreable`)
  }

  const eq1 = Number(macro[0])
  const eq2 = Number(macro[1])
  const eq3 = Number(macro[2])
  const eq4 = Number(macro[3])
  const eq5 = Number(macro[4])
  const eq6 = Number(macro[5])

  const nextLower = (parts: readonly (number | string)[]): string => parts.map(String).join('')
  const scoreOf = (key: string): number | undefined => CVSS4_LOOKUP[key]

  const scoreEq1 = scoreOf(nextLower([eq1 + 1, eq2, eq3, eq4, eq5, eq6]))
  const scoreEq2 = scoreOf(nextLower([eq1, eq2 + 1, eq3, eq4, eq5, eq6]))

  let scoreEq3Eq6: number | undefined
  if (eq3 === 1 && eq6 === 1) {
    scoreEq3Eq6 = scoreOf(nextLower([eq1, eq2, eq3 + 1, eq4, eq5, eq6]))
  } else if (eq3 === 0 && eq6 === 1) {
    scoreEq3Eq6 = scoreOf(nextLower([eq1, eq2, eq3 + 1, eq4, eq5, eq6]))
  } else if (eq3 === 1 && eq6 === 0) {
    scoreEq3Eq6 = scoreOf(nextLower([eq1, eq2, eq3, eq4, eq5, eq6 + 1]))
  } else if (eq3 === 0 && eq6 === 0) {
    const left = scoreOf(nextLower([eq1, eq2, eq3, eq4, eq5, eq6 + 1]))
    const right = scoreOf(nextLower([eq1, eq2, eq3 + 1, eq4, eq5, eq6]))
    /* v8 ignore next -- reference port: a missing lower macro loses via the sentinel */
    scoreEq3Eq6 = (left ?? -1) > (right ?? -1) ? left : right
  } else {
    scoreEq3Eq6 = scoreOf(nextLower([eq1, eq2, eq3 + 1, eq4, eq5, eq6 + 1]))
  }

  const scoreEq4 = scoreOf(nextLower([eq1, eq2, eq3, eq4 + 1, eq5, eq6]))
  const scoreEq5 = scoreOf(nextLower([eq1, eq2, eq3, eq4, eq5 + 1, eq6]))

  const eq3Eq6Maxes = getEQMaxes(macro, 3)
  const maxVectors: string[] = []
  for (const eq1Max of getEQMaxes(macro, 1)) {
    for (const eq2Max of getEQMaxes(macro, 2)) {
      for (const eq3Eq6Max of eq3Eq6Maxes) {
        for (const eq4Max of getEQMaxes(macro, 4)) {
          for (const eq5Max of getEQMaxes(macro, 5)) {
            maxVectors.push(eq1Max + eq2Max + eq3Eq6Max + eq4Max + eq5Max)
          }
        }
      }
    }
  }

  const distance = (metric: string, levels: Readonly<Record<string, number>>, maxVector: string): number =>
    tableAt(levels, m(selected, metric)) - tableAt(levels, extractValueMetric(metric, maxVector))

  let reference: string | undefined
  for (const maxVector of maxVectors) {
    const distances = [
      distance('AV', AV_LEVELS, maxVector), distance('PR', PR_LEVELS, maxVector), distance('UI', UI_LEVELS, maxVector),
      distance('AC', AC_LEVELS, maxVector), distance('AT', AT_LEVELS, maxVector),
      distance('VC', VC_LEVELS, maxVector), distance('VI', VI_LEVELS, maxVector), distance('VA', VA_LEVELS, maxVector),
      distance('SC', SC_LEVELS, maxVector), distance('SI', SI_LEVELS, maxVector), distance('SA', SA_LEVELS, maxVector),
      distance('CR', CR_LEVELS, maxVector), distance('IR', CR_LEVELS, maxVector), distance('AR', CR_LEVELS, maxVector),
    ]
    if (distances.some(value => value < 0)) continue
    reference = maxVector
    break
  }
  // Unreachable for reachable macros: the composed tables always supply a
  // qualifying highest-severity fragment combination (exhaustive suite).
  /* v8 ignore next -- defensive: composed fragments always qualify for reachable macros */
  if (reference === undefined) {
    throw new Error(`cvss macrovector ${macro} exposes no qualifying highest-severity vector`)
  }

  const currentEq1 = distance('AV', AV_LEVELS, reference) + distance('PR', PR_LEVELS, reference) + distance('UI', UI_LEVELS, reference)
  const currentEq2 = distance('AC', AC_LEVELS, reference) + distance('AT', AT_LEVELS, reference)
  const currentEq3Eq6 = distance('VC', VC_LEVELS, reference) + distance('VI', VI_LEVELS, reference)
    + distance('VA', VA_LEVELS, reference) + distance('CR', CR_LEVELS, reference)
    + distance('IR', CR_LEVELS, reference) + distance('AR', CR_LEVELS, reference)
  const currentEq4 = distance('SC', SC_LEVELS, reference) + distance('SI', SI_LEVELS, reference) + distance('SA', SA_LEVELS, reference)

  const step = 0.1
  const available = (value: number | undefined): number | undefined => value === undefined ? undefined : lookupValue - value

  const availableEq1 = available(scoreEq1)
  const availableEq2 = available(scoreEq2)
  const availableEq3Eq6 = available(scoreEq3Eq6)
  const availableEq4 = available(scoreEq4)
  const availableEq5 = available(scoreEq5)

  let nExistingLower = 0
  let normalizedEq1 = 0
  let normalizedEq2 = 0
  let normalizedEq3Eq6 = 0
  let normalizedEq4 = 0
  let normalizedEq5 = 0

  if (availableEq1 !== undefined) {
    nExistingLower += 1
    normalizedEq1 = availableEq1 * (currentEq1 / (tableAt(CVSS4_MAX_SEVERITY.eq1, String(eq1)) * step))
  }
  if (availableEq2 !== undefined) {
    nExistingLower += 1
    normalizedEq2 = availableEq2 * (currentEq2 / (tableAt(CVSS4_MAX_SEVERITY.eq2, String(eq2)) * step))
  }
  if (availableEq3Eq6 !== undefined) {
    nExistingLower += 1
    const depthByEq6 = CVSS4_MAX_SEVERITY.eq3eq6[String(eq3) as '0' | '1' | '2']
    normalizedEq3Eq6 = availableEq3Eq6
      * (currentEq3Eq6 / (tableAt(depthByEq6, String(eq6)) * step))
  }
  if (availableEq4 !== undefined) {
    nExistingLower += 1
    normalizedEq4 = availableEq4 * (currentEq4 / (tableAt(CVSS4_MAX_SEVERITY.eq4, String(eq4)) * step))
  }
  if (availableEq5 !== undefined) {
    nExistingLower += 1
    normalizedEq5 = availableEq5 * 0
  }

  const meanDistance = nExistingLower === 0
    ? 0
    : (normalizedEq1 + normalizedEq2 + normalizedEq3Eq6 + normalizedEq4 + normalizedEq5) / nExistingLower

  let value = lookupValue - meanDistance
  /* v8 ignore next -- defensive: the refined value lies between the lookup bounds, so clamps cannot fire */
  if (value < 0) value = 0.0
  /* v8 ignore next -- defensive: the refined value lies between the lookup bounds, so clamps cannot fire */
  if (value > 10) value = 10.0
  return Math.round(value * 10) / 10
}
