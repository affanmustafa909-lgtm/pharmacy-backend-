import { HttpError } from '../lib/http.js'

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

  const baseUrl = (process.env.ROUTING_BASE_URL || 'https://router.project-osrm.org')
    .replace(/\/+$/, '')

  const url =
    `${baseUrl}/route/v1/driving/` +
    `${input.fromLng},${input.fromLat};${input.toLng},${input.toLat}` +
    '?overview=false'

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      throw new Error(`Routing service returned HTTP ${response.status}`)
    }

    const result = await response.json() as {
      code?: string
      routes?: Array<{ distance?: number }>
    }

    const meters = result.routes?.[0]?.distance

    if (result.code !== 'Ok' || !Number.isFinite(meters) || (meters ?? 0) <= 0) {
      throw new Error('No road route was returned')
    }

    return Math.round((meters! / 1000) * 100) / 100
  } catch {
    throw new HttpError(
      503,
      'Road distance is temporarily unavailable. Please try again.'
    )
  }
}