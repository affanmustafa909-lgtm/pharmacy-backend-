/**
 * Pharmacy expiry helpers.
 * Keep this file IDENTICAL on backend and frontend so both apply the same rule.
 *
 * Rule: a medicine is valid for the WHOLE expiry day (until 23:59:59.999 business time).
 * "MM/YY" or "MM/YYYY" means the last day of that month.
 */

/** Pharmacy timezone, in minutes ahead of UTC. 300 = UTC+5 (no daylight saving). Change if needed. */
export const BUSINESS_UTC_OFFSET_MINUTES = 300

const MIN_YEAR = 2000
const MAX_YEAR = 2100
const DAY_MS = 86_400_000

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

interface Ymd {
  year: number
  month: number
  day: number
}

type HttpError = Error & { status?: number; code?: string }

function httpError(message: string, code: string): HttpError {
  const err = new Error(message) as HttpError
  err.status = 400
  err.code = code
  return err
}

function daysInMonth(year: number, month: number) {
  // month is 1-based; day 0 of the next month is the last day of this one
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Validates the parts. If day is omitted, the last day of the month is used. */
function toYmd(year: number, month: number, day?: number): Ymd | null {
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12) return null
  const last = daysInMonth(year, month)
  const d = day ?? last
  if (!Number.isInteger(d) || d < 1 || d > last) return null
  return { year, month, day: d }
}

function monthFromName(word: string): number | null {
  const text = word.toLowerCase()
  if (text.length < 3) return null
  const index = MONTH_NAMES.findIndex((name) => name.startsWith(text))
  return index === -1 ? null : index + 1
}

function parseYmd(value: string | null | undefined): Ymd | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null

  // YYYY-MM, YYYY-MM-DD (also with / or .). A time part after the day is ignored.
  let m = raw.match(/^(\d{4})[-\/.](\d{1,2})(?:[-\/.](\d{1,2})(?:[T\s].*)?)?$/)
  if (m) return toYmd(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined)

  // DD/MM/YYYY (also - or .). If the second number cannot be a month, it is read as MM/DD/YYYY.
  m = raw.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/)
  if (m) {
    let day = Number(m[1])
    let month = Number(m[2])
    if (month > 12 && day <= 12) [day, month] = [month, day]
    return toYmd(Number(m[3]), month, day)
  }

  // MM/YY, MM/YYYY (also - or .) -> last day of that month
  m = raw.match(/^(\d{1,2})[-\/.](\d{2}|\d{4})$/)
  if (m) {
    const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2])
    return toYmd(year, Number(m[1]))
  }

  // "MAY 2026", "May-26" -> last day of that month
  m = raw.match(/^([A-Za-z]{3,9})[\s\-\/.,]*(\d{2}|\d{4})$/)
  if (m) {
    const month = monthFromName(m[1])
    if (!month) return null
    const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2])
    return toYmd(year, month)
  }

  return null
}

function endOfDay({ year, month, day }: Ymd): Date {
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999) - BUSINESS_UTC_OFFSET_MINUTES * 60_000)
}

/** Parse common pharmacy expiry labels. Returns the exact moment the medicine stops being valid, or null. */
export function parseExpiry(value: string | null | undefined): Date | null {
  const ymd = parseYmd(value)
  return ymd ? endOfDay(ymd) : null
}

/** Canonical "YYYY-MM-DD" for storing in the database and for <input type="date">. Null if unreadable. */
export function normalizeExpiry(value: string | null | undefined): string | null {
  const ymd = parseYmd(value)
  if (!ymd) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${ymd.year}-${pad(ymd.month)}-${pad(ymd.day)}`
}

/** True when the value is empty (no expiry) or a readable date. */
export function isValidExpiry(value: string | null | undefined): boolean {
  if (!String(value ?? '').trim()) return true
  return parseYmd(value) !== null
}

export function isExpired(value: string | null | undefined, now = new Date()): boolean {
  const expiry = parseExpiry(value)
  if (!expiry) return false
  return expiry.getTime() < now.getTime()
}

/** Whole days left (0 or less = expired). Null if there is no readable expiry. */
export function daysLeft(value: string | null | undefined, now = new Date()): number | null {
  const expiry = parseExpiry(value)
  if (!expiry) return null
  return Math.ceil((expiry.getTime() - now.getTime()) / DAY_MS)
}

/** Use when SELLING. Throws if the medicine has expired. */
export function assertNotExpired(name: string, expiry: string | null | undefined, now = new Date()) {
  if (isExpired(expiry, now)) {
    throw httpError(`${name} has expired and cannot be sold`, 'EXPIRED')
  }
}

/** Use when SAVING a medicine. Throws if an expiry was given but cannot be read. */
export function assertValidExpiry(name: string, expiry: string | null | undefined) {
  if (!isValidExpiry(expiry)) {
    throw httpError(`${name} has an invalid expiry date "${String(expiry).trim()}"`, 'INVALID_EXPIRY')
  }
}