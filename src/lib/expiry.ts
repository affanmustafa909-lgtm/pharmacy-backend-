/** Parse common pharmacy expiry labels (MM/YY, MM/YYYY, YYYY-MM-DD, YYYY-MM). */
export function parseExpiry(value: string | null | undefined): Date | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null

  const iso = raw.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/)
  if (iso) {
    const year = Number(iso[1])
    const month = Number(iso[2])
    const day = iso[3] ? Number(iso[3]) : daysInMonth(year, month)
    if (!validYmd(year, month, day)) return null
    return endOfDay(year, month, day)
  }

  const slash = raw.match(/^(\d{1,2})[\/.\-](\d{2}|\d{4})$/)
  if (slash) {
    const month = Number(slash[1])
    let year = Number(slash[2])
    if (year < 100) year += 2000
    const day = daysInMonth(year, month)
    if (!validYmd(year, month, day)) return null
    return endOfDay(year, month, day)
  }

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  return endOfDay(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate())
}

export function isExpired(value: string | null | undefined, now = new Date()): boolean {
  const expiry = parseExpiry(value)
  if (!expiry) return false
  return expiry.getTime() < now.getTime()
}

export function assertNotExpired(name: string, expiry: string | null | undefined) {
  if (isExpired(expiry)) {
    const err = new Error(`${name} has expired and cannot be sold`) as Error & { status?: number; code?: string }
    err.status = 400
    err.code = 'EXPIRED'
    throw err
  }
}

function daysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate()
}

function validYmd(year: number, month: number, day: number) {
  return year >= 2000 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}

function endOfDay(year: number, month: number, day: number) {
  return new Date(year, month - 1, day, 23, 59, 59, 999)
}
