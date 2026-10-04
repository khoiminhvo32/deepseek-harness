/** The CVSS 4.0 engine stays pinned to the vendored FIRST data and reference behavior. */

import { describe, expect, it } from 'vitest'
import { CVSS4_LOOKUP, CVSS4_MAX_COMPOSED } from '../src/cvss4-lookup.ts'
import { macroVector, parseVector, scoreVector, severityBand } from '../src/cvss4.ts'
import type { ParsedVector } from '../src/cvss4.ts'

/**
 * Build the highest-severity selected map of one macrovector from the
 * composed max fragments. The draft-era fragments express Safety as base
 * `SI:S`/`SA:S`; the final spec moves it to `MSI`/`MSA`, so the map
 * translates them the way the reference's modified-override `m()` reads them
 * back: base `N` plus the modified `S`.
 */
function maxSelectedOf(macro: string): ParsedVector {
  const firstOf = (list: readonly string[] | undefined): string => {
    const item = list?.[0]
    if (item === undefined) throw new Error('missing composed fragment')
    return item
  }
  const eq3Table = CVSS4_MAX_COMPOSED.eq3[macro[2] as '0' | '1' | '2'] as Record<string, readonly string[]>
  const fragments = [
    firstOf(CVSS4_MAX_COMPOSED.eq1[macro[0] as '0' | '1' | '2']),
    firstOf(CVSS4_MAX_COMPOSED.eq2[macro[1] as '0' | '1']),
    firstOf(eq3Table[macro[5] as '0' | '1']),
    firstOf(CVSS4_MAX_COMPOSED.eq4[macro[3] as '0' | '1' | '2']),
    firstOf(CVSS4_MAX_COMPOSED.eq5[macro[4] as '0' | '1' | '2']),
  ]
  const selected: Record<string, string> = {}
  for (const fragment of fragments) {
    for (const pair of fragment.split('/').filter(Boolean)) {
      const [metric, value] = pair.split(':') as [string, string]
      if ((metric === 'SI' || metric === 'SA') && value === 'S') {
        selected[metric] = 'N'
        selected[`M${metric}`] = 'S'
      } else {
        selected[metric] = value
      }
    }
  }
  for (const metric of ['E', 'CR', 'IR', 'AR']) {
    if (selected[metric] === undefined) selected[metric] = 'X'
  }
  return selected
}

describe('cvss4 parsing', () => {
  it('parses a complete vector and defaults the optional threat and requirement metrics', () => {
    const parsed = parseVector('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')
    expect(parsed.E).toBe('X')
    expect(parsed.CR).toBe('X')
    expect(parseVector('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:X/CR:X/IR:X/AR:X'))
      .toEqual(parsed)
  })

  it('rejects malformed vectors with concrete errors', () => {
    expect(() => parseVector('CVSS:3.1/AV:N')).toThrow('must start with CVSS:4.0/')
    expect(() => parseVector('CVSS:4.0/AV:N//')).toThrow('empty metric segment')
    expect(() => parseVector('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N')).toThrow('missing base metric SA')
    expect(() => parseVector('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/ZZ:N'))
      .toThrow('unknown metric ZZ')
    expect(() => parseVector('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/AV:N'))
      .toThrow('repeats metric AV')
    expect(() => parseVector('CVSS:4.0/AV:Q/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'))
      .toThrow('value Q is illegal for AV')
    expect(() => parseVector('CVSS:4.0/AV')).toThrow('not METRIC:VALUE')
  })
})

describe('cvss4 scoring', () => {
  it('scores every macrovector\'s highest-severity vector exactly at its lookup value', () => {
    const macros = Object.keys(CVSS4_LOOKUP)
    expect(macros.length).toBe(270)
    for (const macro of macros) {
      const selected = maxSelectedOf(macro)
      expect(macroVector(selected), `macrovector of the max vector for ${macro}`).toBe(macro)
      expect(scoreVector(selected), `score of the max vector for ${macro}`).toBe(CVSS4_LOOKUP[macro])
    }
  })

  it('returns zero for a vector with no impact on any system', () => {
    expect(scoreVector('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N')).toBe(0.0)
  })

  it('scores the global maximum at 10.0', () => {
    const selected = maxSelectedOf('000000')
    expect(macroVector(selected)).toBe('000000')
    expect(scoreVector(selected)).toBe(10.0)
  })

  it('maps macrovector equivalence classes across branch outcomes', () => {
    const base = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'
    expect(macroVector(parseVector(base))).toBe('000200')

    // eq1 digit 1 through UI alone, and digit 2 through AV:P
    const uiAlone = 'CVSS:4.0/AV:A/AC:L/AT:N/PR:H/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'
    expect(macroVector(parseVector(uiAlone))).toBe('100200')
    const physical = 'CVSS:4.0/AV:P/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'
    expect(macroVector(parseVector(physical))).toBe('200200')

    // eq3 digit 1 through VI alone
    const viOnly = base.replace('VC:H', 'VC:L').replace('VA:H', 'VA:L')
    expect(macroVector(parseVector(viOnly))).toBe('001200')

    // exploit maturity beyond the defaulted worst case
    expect(macroVector(parseVector(`${base}/E:P`))).toBe('000210')
    expect(macroVector(parseVector(`${base}/E:U`))).toBe('000220')

    // eq3 = 0 with eq6 = 0 through requirements below high
    const requirementsLow = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:L/SC:N/SI:N/SA:N/CR:L'
    expect(macroVector(parseVector(requirementsLow))).toBe('000200')
    expect(scoreVector(requirementsLow)).toBe(CVSS4_LOOKUP['000200'])

    // scoring through non-default exploit maturity exercises the digit-5 path
    expect(scoreVector(`${base}/E:P`)).toBe(CVSS4_LOOKUP['000210'])
    expect(scoreVector(`${base}/E:U`)).toBe(CVSS4_LOOKUP['000220'])

    // eq6 digit 1 when every high requirement pair fails
    const requirementsDown = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:L/VA:L/SC:N/SI:N/SA:N/CR:L/IR:L/AR:L'
    expect(macroVector(parseVector(requirementsDown))).toBe('001201')
  })

  it('bands scores per the specification ranges', () => {
    expect(severityBand(0)).toBe('None')
    expect(severityBand(0.1)).toBe('Low')
    expect(severityBand(3.9)).toBe('Low')
    expect(severityBand(4)).toBe('Medium')
    expect(severityBand(6.9)).toBe('Medium')
    expect(severityBand(7)).toBe('High')
    expect(severityBand(8.9)).toBe('High')
    expect(severityBand(9)).toBe('Critical')
    expect(severityBand(10)).toBe('Critical')
  })

  it('refines below the macrovector score as individual metrics weaken', () => {
    const strongest = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/E:A/CR:H/IR:H/AR:H'
    const weakerPrivileges = strongest.replace('PR:N', 'PR:L')
    const strong = scoreVector(parseVector(strongest))
    const weak = scoreVector(parseVector(weakerPrivileges))
    expect(weak).toBeLessThan(strong)
    expect(weak).toBeGreaterThanOrEqual(0)
    expect(strong).toBeLessThanOrEqual(10)
  })

  it('scores the published network vector family at the reference values', () => {
    // Published FIRST example vector family (spec section examples): the 9.3
    // critical network vector and its score come from the lookup data itself.
    const base = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'
    expect(scoreVector(base)).toBe(CVSS4_LOOKUP[macroVector(parseVector(base))])
  })
})
