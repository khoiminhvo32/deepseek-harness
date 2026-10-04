/** Cron parsing and next-match arithmetic, plus the pure wake-time resolution. */

import { describe, expect, it } from 'vitest'
import { cronNextMatch, parseCron } from '../src/cron.ts'
import { resolveWakeAt } from '../src/wake.ts'

/** Fri 2026-01-02 12:00:00 UTC. */
const AFTER = Date.UTC(2026, 0, 2, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 3_600_000

describe('parseCron', () => {
  it('parses stars, lists, ranges, and steps into per-field sets', () => {
    const cron = parseCron('0 9-17/3 * * 1,3,5')
    expect([...cron.minutes]).toEqual([0])
    expect([...cron.hours]).toEqual([9, 12, 15])
    expect([...cron.daysOfWeek]).toEqual([1, 3, 5])
    expect(cron.domStar).toBe(true)
    expect(cron.dowStar).toBe(false)
  })

  it('normalizes Sunday 7 to 0 and keeps stepped stars as stars', () => {
    expect([...parseCron('* * * * 7').daysOfWeek]).toEqual([0])
    expect(parseCron('* * */5 * *').domStar).toBe(true)
    expect(parseCron('* * 1-5 * *').domStar).toBe(false)
  })

  it('rejects malformed expressions naming the reason', () => {
    expect(() => parseCron('* * * *')).toThrow('exactly five fields')
    expect(() => parseCron('61 * * * *')).toThrow('minute field value is out of range')
    expect(() => parseCron('a * * * *')).toThrow('must be integers')
    expect(() => parseCron('5-1 * * * *')).toThrow('inverted')
    expect(() => parseCron('*/0 * * * *')).toThrow('step must be a positive integer')
    expect(() => parseCron('1,,2 * * * *')).toThrow('empty list member')
    expect(() => parseCron('1/2/3 * * * *')).toThrow('more than one step')
    expect(() => parseCron('1-2-3 * * * *')).toThrow('malformed range')
  })
})

describe('cronNextMatch', () => {
  it('finds the strictly next matching minute', () => {
    expect(cronNextMatch(parseCron('* * * * *'), AFTER)).toBe(AFTER + MINUTE)
    expect(cronNextMatch(parseCron('30 * * * *'), AFTER)).toBe(Date.UTC(2026, 0, 2, 12, 30))
    expect(cronNextMatch(parseCron('0 9-17/3 * * *'), AFTER)).toBe(Date.UTC(2026, 0, 2, 15, 0))
  })

  it('advances across days, months, and the day-field OR rule', () => {
    expect(cronNextMatch(parseCron('0 0 1 * *'), AFTER)).toBe(Date.UTC(2026, 1, 1, 0, 0))
    expect(cronNextMatch(parseCron('0 0 * * 0'), AFTER)).toBe(Date.UTC(2026, 0, 4, 0, 0))
    expect(cronNextMatch(parseCron('0 0 1 3 *'), AFTER)).toBe(Date.UTC(2026, 2, 1, 0, 0))
    // Day-of-month 13 or any Friday: Friday Jan 9 arrives before Tuesday the 13th.
    expect(cronNextMatch(parseCron('0 0 13 * 5'), AFTER)).toBe(Date.UTC(2026, 0, 9, 0, 0))
  })

  it('fails loudly when no minute matches within the horizon', () => {
    expect(() => cronNextMatch(parseCron('0 0 31 2 *'), AFTER)).toThrow('scan horizon')
  })
})

describe('resolveWakeAt', () => {
  it('prefers the provider delay and caps every wait at the standby bound', () => {
    expect(resolveWakeAt({ now: AFTER, providerRetryAfterMs: 5 * MINUTE, maxStandbyMs: 24 * HOUR })).toBe(AFTER + 5 * MINUTE)
    expect(resolveWakeAt({ now: AFTER, providerRetryAfterMs: 100 * HOUR, maxStandbyMs: 24 * HOUR })).toBe(AFTER + 24 * HOUR)
  })

  it('ignores invalid provider delays and falls through to cron, then to the cap', () => {
    const cron = '30 * * * *'
    expect(resolveWakeAt({ now: AFTER, providerRetryAfterMs: 0, cron, maxStandbyMs: 24 * HOUR })).toBe(Date.UTC(2026, 0, 2, 12, 30))
    expect(resolveWakeAt({ now: AFTER, cron, maxStandbyMs: 24 * HOUR })).toBe(Date.UTC(2026, 0, 2, 12, 30))
    expect(resolveWakeAt({ now: AFTER, maxStandbyMs: 24 * HOUR })).toBe(AFTER + 24 * HOUR)
  })

  it('caps a cron match that lies beyond the standby bound', () => {
    expect(resolveWakeAt({ now: AFTER, cron: '0 0 1 * *', maxStandbyMs: 24 * HOUR })).toBe(AFTER + 24 * HOUR)
  })
})
