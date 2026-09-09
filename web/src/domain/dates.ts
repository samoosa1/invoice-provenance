// Reused from ledger-reconciler (https://github.com/samoosa1/ledger-reconciler), same author, MIT.
/**
 * Timezone-free dates.
 *
 * The Python original uses `datetime.date`, which has no timezone at all.
 * JavaScript's `Date` does, and worse, it is inconsistent about it:
 *
 *   new Date("2025-01-15")        -> UTC midnight
 *   new Date("January 15, 2025")  -> LOCAL midnight
 *
 * Mixing those two across the supported formats produces off-by-one-day
 * errors that only show up in some timezones, which is the worst kind of
 * bug: invisible where it was written, wrong where it runs. So the domain
 * layer never touches `Date` and works on a plain {year, month, day}
 * record instead. `Date.UTC` appears exactly once, to turn a record into a
 * day number for differencing, where it is timezone-independent by
 * definition.
 */

export interface PlainDate {
  year: number
  month: number // 1-12
  day: number // 1-31
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, '')
  if (w === 'sept') return 9
  const full = MONTHS.indexOf(w)
  if (full !== -1) return full + 1
  const abbrev = MONTHS.findIndex((m) => m.slice(0, 3) === w)
  return abbrev === -1 ? -1 : abbrev + 1
}

/** Rejects days that don't exist in that month, as strptime does. */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day <= daysInMonth
}

function make(year: number, month: number, day: number): PlainDate | null {
  return isRealDate(year, month, day) ? { year, month, day } : null
}

/**
 * Parses the formats the Python version accepts. Mirrors extract.parse_date.
 *   2025-01-15  2025/01/15  2025.01.15        year first, unambiguous
 *   15.01.2025  15/01/2025  01/15/2025  01/15/25
 *   21 January 2025   January 17, 2025   Mar 12, 2025   12 Mar 2025
 *
 * Day-first versus month-first is decided by the value when one reading is
 * impossible (a component above 12), otherwise by `preferUS`, which the
 * caller derives from other clues on the page (USD, EIN, a US state+ZIP).
 * Returns null on anything else, matching strptime raising ValueError.
 */
export function parseDate(raw: string, preferUS = false): PlainDate | null {
  const text = raw.trim().replace(/[.,]$/, '')

  const yearFirst = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text)
  if (yearFirst) return make(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]))

  const numeric = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(text)
  if (numeric) {
    const a = Number(numeric[1])
    const b = Number(numeric[2])
    let y = Number(numeric[3])
    if (y < 100) y += 2000
    if (a > 12 && b <= 12) return make(y, b, a)
    if (b > 12 && a <= 12) return make(y, a, b)
    return preferUS ? make(y, a, b) : make(y, b, a)
  }

  const dayFirstProse = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(text)
  if (dayFirstProse) {
    const m = monthIndex(dayFirstProse[2])
    return m === -1 ? null : make(Number(dayFirstProse[3]), m, Number(dayFirstProse[1]))
  }

  const prose = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text)
  if (prose) {
    const m = monthIndex(prose[1])
    return m === -1 ? null : make(Number(prose[3]), m, Number(prose[2]))
  }

  return null
}

/** Signed difference in whole days, a - b. */
export function daysBetween(a: PlainDate, b: PlainDate): number {
  const MS_PER_DAY = 86_400_000
  const at = Date.UTC(a.year, a.month - 1, a.day)
  const bt = Date.UTC(b.year, b.month - 1, b.day)
  return Math.round((at - bt) / MS_PER_DAY)
}

/** ISO 8601 date string, for display and report output. */
export function toISO(d: PlainDate): string {
  const mm = String(d.month).padStart(2, '0')
  const dd = String(d.day).padStart(2, '0')
  return `${d.year}-${mm}-${dd}`
}
