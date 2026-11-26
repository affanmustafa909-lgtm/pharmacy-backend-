export interface GeocodedPlace {
  displayName: string
  street: string
  subCity: string
  city: string
  state: string
  country: string
  postalCode: string
  latitude: number
  longitude: number
}

interface NominatimAddress {
  house_number?: string
  road?: string
  pedestrian?: string
  building?: string
  suburb?: string
  neighbourhood?: string
  quarter?: string
  borough?: string
  city_district?: string
  district?: string
  town?: string
  city?: string
  village?: string
  municipality?: string
  county?: string
  state?: string
  region?: string
  country?: string
  postcode?: string
}

interface NominatimItem {
  display_name?: string
  lat?: string
  lon?: string
  address?: NominatimAddress
}

const NOMINATIM_BASE = (process.env.GEOCODER_BASE_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '')
const HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'en',
  'User-Agent': 'HeraPharmacyApp/1.0 (delivery-geocoder)',
}

function nominatimUrl(pathAndQuery: string) {
  const joiner = pathAndQuery.includes('?') ? '&' : '?'
  return `${NOMINATIM_BASE}${pathAndQuery}${joiner}accept-language=en`
}

function mapNominatim(item: NominatimItem): GeocodedPlace | null {
  const lat = Number(item.lat)
  const lng = Number(item.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

  const addr = item.address ?? {}
  const streetParts = [addr.house_number, addr.road || addr.pedestrian || addr.building].filter(Boolean)
  const street = streetParts.join(' ').trim()
  const subCity = (
    addr.suburb ||
    addr.neighbourhood ||
    addr.quarter ||
    addr.borough ||
    addr.city_district ||
    addr.district ||
    ''
  ).trim()
  const city = (addr.city || addr.town || addr.village || addr.municipality || addr.county || '').trim()
  const state = (addr.state || addr.region || '').trim()
  const country = (addr.country || '').trim()
  const postalCode = (addr.postcode || '').trim()

  const fallbackLine = [street, subCity, city, state, postalCode, country].filter(Boolean).join(', ')
  return {
    displayName: item.display_name || fallbackLine,
    street,
    subCity,
    city,
    state,
    country,
    postalCode,
    latitude: Math.round(lat * 1_000_000) / 1_000_000,
    longitude: Math.round(lng * 1_000_000) / 1_000_000,
  }
}

export function formatAddressLine(parts: {
  street?: string
  subCity?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
  fallback?: string
}) {
  const composed = [
    parts.street?.trim(),
    parts.subCity?.trim(),
    parts.city?.trim(),
    parts.state?.trim(),
    parts.postalCode?.trim(),
    parts.country?.trim(),
  ]
    .filter(Boolean)
    .join(', ')
  return composed || (parts.fallback?.trim() ?? '')
}

export async function searchPlaces(query: string, limit = 6): Promise<GeocodedPlace[]> {
  const q = query.trim()
  if (q.length < 2) return []

  const url = nominatimUrl(
    `/search?format=jsonv2&addressdetails=1&limit=${Math.min(limit, 10)}&q=${encodeURIComponent(q)}`,
  )
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(7000),
      headers: HEADERS,
    })
    if (!response.ok) return []
    const items = (await response.json()) as NominatimItem[]
    return items.map(mapNominatim).filter((place): place is GeocodedPlace => Boolean(place))
  } catch {
    return []
  }
}

export async function reverseGeocode(lat: number, lng: number): Promise<GeocodedPlace | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const url = nominatimUrl(
    `/reverse?format=jsonv2&addressdetails=1&lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lng))}`,
  )
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(7000),
      headers: HEADERS,
    })
    if (!response.ok) return null
    const item = (await response.json()) as NominatimItem
    return mapNominatim(item)
  } catch {
    return null
  }
}

export async function geocodeStructuredAddress(parts: {
  street?: string
  subCity?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
  line?: string
}): Promise<GeocodedPlace | null> {
  const queries = [
    formatAddressLine(parts),
    [parts.subCity, parts.city, parts.state, parts.country].filter(Boolean).join(', '),
    [parts.city, parts.country].filter(Boolean).join(', '),
    parts.line?.trim() ?? '',
  ].filter((q, idx, arr) => q.length >= 2 && arr.indexOf(q) === idx)

  for (const query of queries) {
    const results = await searchPlaces(query, 1)
    if (results.length > 0) return results[0]
  }
  return null
}
