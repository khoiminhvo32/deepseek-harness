/**
 * Minimal five-field Vixie cron arithmetic for quota-reset schedules,
 * evaluated in UTC at minute granularity. Supports `*`, single values,
 * inclusive ranges, `a-b/n` steps, and comma-separated lists per field;
 * day-of-month and day-of-week combine with Vixie OR semantics when both
 * are restricted. This is deliberately smaller than the Host schedule
 * dialect: no named months or weekdays, no macros, no time zones.
 * @module
 */

/** One parsed cron expression: per-field minute-of-match sets. */
export interface ParsedCron {
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly daysOfWeek: ReadonlySet<number>
  /** True when the day-of-month field is a bare star. */
  readonly domStar: boolean
  /** True when the day-of-week field is a bare star. */
  readonly dowStar: boolean
}

/** Upper bound on the forward scan so an unsatisfiable-looking expression fails loudly. */
const SCAN_LIMIT_DAYS = 2766

/** Parse one field into the set of matching numbers within its bounds. */
function parseField(field: string, min: number, max: number, label: string): Set<number> {
  const matches = new Set<number>()
  for (const part of field.split(',')) {
    if (part.length === 0) throw new TypeError(`cron ${label} field has an empty list member`)
    const [range, stepText, ...extra] = part.split('/')
    /* v8 ignore next -- defensive: a non-empty part always splits to a first member. */
    if (range === undefined) throw new TypeError(`cron ${label} field has an empty list member`)
    if (extra.length > 0) throw new TypeError(`cron ${label} field has more than one step`)
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isSafeInteger(step) || step < 1) throw new TypeError(`cron ${label} field step must be a positive integer`)
    let low: number
    let high: number
    if (range === '*') {
      low = min
      high = max
    } else {
      const [lowText, highText, ...rangeExtra] = range.split('-')
      if (rangeExtra.length > 0 || lowText === undefined) throw new TypeError(`cron ${label} field has a malformed range`)
      low = Number(lowText)
      high = highText === undefined ? low : Number(highText)
      if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) throw new TypeError(`cron ${label} field values must be integers`)
      if (low < min || high > max) throw new TypeError(`cron ${label} field value is out of range`)
      if (low > high) throw new TypeError(`cron ${label} field range is inverted`)
    }
    for (let value = low; value <= high; value += step) matches.add(value)
  }
  /* v8 ignore next -- defensive: every accepted member adds at least one match. */
  if (matches.size === 0) throw new TypeError(`cron ${label} field matches nothing`)
  return matches
}

/**
 * Parse a five-field cron expression.
 * @param expression - minute, hour, day-of-month, month, day-of-week; `0` and `7` both mean Sunday.
 * @returns the parsed per-field match sets.
 * @throws TypeError naming the offending field when the expression is malformed.
 */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/u)
  if (fields.length !== 5) throw new TypeError('cron expression must have exactly five fields')
  const minuteField = fields[0]
  const hourField = fields[1]
  const dayOfMonthField = fields[2]
  const monthField = fields[3]
  const dayOfWeekField = fields[4]
  /* v8 ignore next -- defensive: the field count above guarantees all five members. */
  if (minuteField === undefined || hourField === undefined || dayOfMonthField === undefined
    || monthField === undefined || dayOfWeekField === undefined) throw new TypeError('cron expression must have exactly five fields')
  const dayField = parseField(dayOfMonthField, 1, 31, 'day-of-month')
  const daysOfWeek = new Set([...parseField(dayOfWeekField, 0, 7, 'day-of-week')].map(day => day === 7 ? 0 : day))
  return {
    minutes: parseField(minuteField, 0, 59, 'minute'),
    hours: parseField(hourField, 0, 23, 'hour'),
    daysOfMonth: dayField,
    months: parseField(monthField, 1, 12, 'month'),
    daysOfWeek,
    domStar: /^\*$/u.test(dayOfMonthField) || /^\*\//u.test(dayOfMonthField),
    dowStar: /^\*$/u.test(dayOfWeekField) || /^\*\//u.test(dayOfWeekField),
  }
}

/** UTC start-of-day offset arithmetic for one epoch-ms instant. */
function startOfUtcDay(time: number): number {
  return time - (time % 86_400_000)
}

/** Whether the instant's UTC date matches the day fields, with Vixie OR when both are restricted. */
function dayMatches(cron: ParsedCron, time: number): boolean {
  const date = new Date(time)
  const dom = date.getUTCDate()
  const dow = date.getUTCDay()
  const domOk = cron.daysOfMonth.has(dom)
  const dowOk = cron.daysOfWeek.has(dow)
  if (cron.domStar && cron.dowStar) return true
  if (cron.domStar) return dowOk
  if (cron.dowStar) return domOk
  return domOk || dowOk
}

/**
 * Find the first minute strictly after `after` that the expression matches.
 * @param cron - parsed expression.
 * @param after - epoch milliseconds; seconds are truncated before scanning.
 * @returns epoch milliseconds of the matching minute boundary.
 * @throws Error when no minute matches within the scan bound.
 */
export function cronNextMatch(cron: ParsedCron, after: number): number {
  let candidate = Math.floor(after / 60_000) * 60_000 + 60_000
  const limit = startOfUtcDay(candidate) + SCAN_LIMIT_DAYS * 86_400_000
  while (candidate < limit) {
    if (!cron.months.has(new Date(candidate).getUTCMonth() + 1)) {
      candidate = startOfUtcDay(candidate) + 86_400_000
      continue
    }
    if (!dayMatches(cron, candidate)) {
      candidate = startOfUtcDay(candidate) + 86_400_000
      continue
    }
    if (!cron.hours.has(new Date(candidate).getUTCHours())) {
      candidate += 3_600_000
      continue
    }
    if (!cron.minutes.has(new Date(candidate).getUTCMinutes())) {
      candidate += 60_000
      continue
    }
    return candidate
  }
  throw new Error('cron expression matches no minute within the scan horizon')
}
