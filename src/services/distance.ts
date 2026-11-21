import { HttpError } from '../lib/http.js'

const EARTH_RADIUS_KM = 6371
const ROAD_FACTOR = 1.25

function toRad(deg: number) {
  return (deg * Math.PI) / 180
}

export function haversineDistanceKm(input: {
  fromLat: number
  fromLng: number
  toLat: number
  toLng: number
}): number {
  const dLat = toRad(input.toLat - input.fromLat)
  const dLng = toRad(input.toLng - input.fromLng)
  const lat1 = toRad(input.fromLat)
  const lat2 = toRad(input.toLat)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  const km = EARTH_RADIUS_KM * c * ROAD_FACTOR
  return Math.max(0.1, Math.round(km * 100) / 100)
}

export async function getDeliveryDistanceKm(input: {
  fromLat: number
  fromLng: number
  toLat: number
  toLng: number
}): Promise<number> {
  const values = [input.fromLat, input.fromLng, input.toLat, input.toLng]

  if (
    values.some((value) => !Number.isFinite(value)) ||
    Math.abs(input.fromLat) > 90 ||
    Math.abs(input.toLat) > 90 ||
    Math.abs(input.fromLng) > 180 ||
    Math.abs(input.toLng) > 180
  ) {
    throw new HttpError(400, 'Valid pharmacy and delivery GPS coordinates are required')
  }

  if (
    Math.abs(input.fromLat - input.toLat) < 0.00005 &&
    Math.abs(input.fromLng - input.toLng) < 0.00005
  ) {
    return 0.1
  }

  const baseUrl = (process.env.ROUTING_BASE_URL || 'https://router.project-osrm.org')
    .replace(/\/+$/, '')

  const url =
    `${baseUrl}/route/v1/driving/` +
    `${input.fromLng},${input.fromLat};${input.toLng},${input.toLat}` +
    '?overview=false'

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      throw new Error(`Routing service returned HTTP ${response.status}`)
    }

    const result = (await response.json()) as {
      code?: string
      routes?: Array<{ distance?: number }>
    }

    const meters = result.routes?.[0]?.distance

    if (result.code !== 'Ok' || !Number.isFinite(meters) || (meters ?? 0) <= 0) {
      throw new Error('No road route was returned')
    }

    return Math.max(0.1, Math.round((meters! / 1000) * 100) / 100)
  } catch {
    // Fallback to road-adjusted Haversine distance if external routing is unavailable or timed out.
    return haversineDistanceKm(input)
  }
}