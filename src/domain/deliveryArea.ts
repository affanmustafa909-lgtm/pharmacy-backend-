export const DEFAULT_MAX_DELIVERY_DISTANCE_KM = 30
/** Set ENFORCE_OUT_OF_CITY=true (or change default to true) to re-enable out-of-city order blocking. */
export const ENFORCE_OUT_OF_CITY_BLOCK = process.env.ENFORCE_OUT_OF_CITY === 'true'

export function normalizePlaceName(value?: string | null): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\./g, ' ')
    .replace(/\bcity of\b/g, ' ')
    .replace(/\bcity\b/g, ' ')
    .replace(/\bmetropolitan\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractCityFromAddress(address?: string | null): string {
  const parts = String(address ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length >= 2) {
    // e.g. "245 Park Ave, New York, NY" -> "New York"
    return parts[1].replace(/\d+/g, '').trim()
  }
  return ''
}

export function resolveStoreCity(store: { city?: string | null; address?: string | null }): string {
  const explicit = String(store.city ?? '').trim()
  if (explicit) return explicit
  return extractCityFromAddress(store.address)
}

export function validateDeliveryCity(input: {
  storeName: string
  storeCity?: string | null
  storeAddress?: string | null
  storeCountry?: string | null
  maxDeliveryDistanceKm?: number | null
  customerCity?: string | null
  customerCountry?: string | null
  customerLine?: string | null
  distanceKm?: number | null
}): { allowed: boolean; reason?: string; storeCity: string; maxDistanceKm: number } {
  const storeCity = resolveStoreCity({ city: input.storeCity, address: input.storeAddress })
  const maxDistanceKm =
    input.maxDeliveryDistanceKm != null && input.maxDeliveryDistanceKm > 0
      ? input.maxDeliveryDistanceKm
      : DEFAULT_MAX_DELIVERY_DISTANCE_KM

  const normStoreCountry = normalizePlaceName(input.storeCountry)
  const normCustomerCountry = normalizePlaceName(input.customerCountry)

  if (normStoreCountry && normCustomerCountry && normStoreCountry !== normCustomerCountry) {
    return {
      allowed: false,
      storeCity,
      maxDistanceKm,
      reason: `Sorry, we cannot take out-of-city orders. ${input.storeName} only delivers in ${storeCity || input.storeCountry}, not ${input.customerCountry}.`,
    }
  }

  const normStoreCity = normalizePlaceName(storeCity)
  const rawCustomerCity = String(input.customerCity ?? '').trim()
  const normCustomerCity = normalizePlaceName(rawCustomerCity)

  if (normStoreCity && normCustomerCity) {
    const matches =
      normStoreCity === normCustomerCity ||
      normCustomerCity.includes(normStoreCity) ||
      normStoreCity.includes(normCustomerCity)
    if (!matches) {
      return {
        allowed: false,
        storeCity,
        maxDistanceKm,
        reason: `Sorry, we cannot take out-of-city orders. ${input.storeName} only delivers within ${storeCity} (selected place is in ${rawCustomerCity}).`,
      }
    }
  } else if (normStoreCity && input.customerLine) {
    // If customerCity wasn't explicitly set, check distance strictly below
  }

  if (input.distanceKm != null && Number.isFinite(input.distanceKm) && input.distanceKm > maxDistanceKm) {
    const where = storeCity ? `within ${storeCity}` : 'locally'
    return {
      allowed: false,
      storeCity,
      maxDistanceKm,
      reason: `Sorry, we cannot take out-of-city orders. This address is ${input.distanceKm.toFixed(1)} km away, outside ${input.storeName}'s ${maxDistanceKm} km delivery area ${where}.`,
    }
  }

  return { allowed: true, storeCity, maxDistanceKm }
}
