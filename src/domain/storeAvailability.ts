const STORE_TIME_ZONE = 'Asia/Karachi'

type StoreAvailabilityInput = {
  status: string
  isOpen: boolean
  acceptingOrders: boolean
  weeklyHours: unknown
  closedDays: unknown
  holidayHours: unknown
}

export type StoreOrderEligibility = {
  eligible: boolean
  reason: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

function timeMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function getPakistanDateTime(now: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: STORE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    day: values.weekday.toLowerCase().slice(0, 3),
    minutes: Number(values.hour) * 60 + Number(values.minute),
  }
}

function isClosedDay(closedDays: unknown, day: string): boolean {
  if (!Array.isArray(closedDays)) return false

  const names: Record<string, string> = {
    sun: 'sunday',
    mon: 'monday',
    tue: 'tuesday',
    wed: 'wednesday',
    thu: 'thursday',
    fri: 'friday',
    sat: 'saturday',
  }

  return closedDays.some((value) => {
    if (typeof value !== 'string') return false
    const normalized = value.trim().toLowerCase()
    return normalized === day || normalized === names[day]
  })
}

export function getStoreOrderEligibility(
  store: StoreAvailabilityInput,
  now = new Date(),
): StoreOrderEligibility {
  const unavailable = (reason: string): StoreOrderEligibility => ({
    eligible: false,
    reason,
  })

  if (store.status === 'archived') return unavailable('Store unavailable')
  if (store.status === 'draft') return unavailable('Not published')
  if (store.status === 'paused') return unavailable('Temporarily paused')
  if (store.status !== 'active') return unavailable('Store unavailable')
  if (!store.isOpen) return unavailable('Currently closed')
  if (!store.acceptingOrders) return unavailable('Not accepting orders')

  const local = getPakistanDateTime(now)

  let hours: unknown = null
  let holidayMatched = false

  if (Array.isArray(store.holidayHours)) {
    const holiday = store.holidayHours.find(
      (entry) => isRecord(entry) && entry.date === local.date,
    )

    if (holiday && isRecord(holiday)) {
      holidayMatched = true

      if (holiday.closed === true) {
        return unavailable('Closed for holiday')
      }

      if (validTime(holiday.open) && validTime(holiday.close)) {
        hours = holiday
      }
    }
  }

  if (!holidayMatched && isClosedDay(store.closedDays, local.day)) {
    return unavailable('Closed today')
  }

  if (!hours) {
    const weeklyHours = isRecord(store.weeklyHours)
      ? store.weeklyHours
      : {}

    // Empty schedule means no configured time restriction.
    if (Object.keys(weeklyHours).length === 0) {
      return { eligible: true, reason: null }
    }

    hours = weeklyHours[local.day]
  }

  if (!isRecord(hours) || !validTime(hours.open) || !validTime(hours.close)) {
    return unavailable('Outside working hours')
  }

  const opening = timeMinutes(hours.open)
  const closing = timeMinutes(hours.close)

  if (closing <= opening) {
    return unavailable('Store hours are incorrectly configured')
  }

  if (local.minutes < opening || local.minutes >= closing) {
    return unavailable('Outside working hours')
  }

  return { eligible: true, reason: null }
}
