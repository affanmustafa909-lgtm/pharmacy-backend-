import {
  DEFAULT_MAX_DELIVERY_DISTANCE_KM,
  validateDeliveryCity,
} from '../domain/deliveryArea.js'
import { prisma } from '../lib/prisma.js'
import { getDeliveryDistanceKm } from './distance.js'
import { formatAddressLine } from './geocode.js'

type StoreRow = {
  id: string
  code: string
  name: string
  address: string
  city: string
  country: string
  maxDeliveryDistanceKm: number | null
  openUntil: string
  rating: number
  phone: string
  pharmacist: string
  mapLat: number | null
  mapLng: number | null
  chargeRules: Array<{
    id: string
    label: string
    mode: string
    amount: number | string | { toString(): string }
    deliveryType: string | null
    minDistanceKm: number | null
    maxDistanceKm: number | null
    perKmRate: number | string | { toString(): string } | null
  }>
}

export type AvailableStoreContext = {
  customerId?: string
  addressId?: string
  latitude?: number | null
  longitude?: number | null
  city?: string | null
  country?: string | null
  line?: string | null
}

async function resolveCustomerLocation(input: AvailableStoreContext) {
  if (input.addressId && input.customerId) {
    const address = await prisma.customerAddress.findFirst({
      where: { id: input.addressId, customerId: input.customerId },
    })
    if (address) {
      return {
        latitude: address.latitude,
        longitude: address.longitude,
        city: address.city || null,
        country: address.country || null,
        line: formatAddressLine({
          street: address.street,
          subCity: address.subCity,
          city: address.city,
          state: address.state,
          postalCode: address.postalCode,
          country: address.country,
          fallback: address.line,
        }),
      }
    }
  }

  if (input.customerId && (input.latitude == null || input.longitude == null)) {
    const fallback = await prisma.customerAddress.findFirst({
      where: { customerId: input.customerId },
      orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
    })
    if (fallback) {
      return {
        latitude: fallback.latitude,
        longitude: fallback.longitude,
        city: fallback.city || null,
        country: fallback.country || null,
        line: formatAddressLine({
          street: fallback.street,
          subCity: fallback.subCity,
          city: fallback.city,
          state: fallback.state,
          postalCode: fallback.postalCode,
          country: fallback.country,
          fallback: fallback.line,
        }),
      }
    }
  }

  return {
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    city: input.city ?? null,
    country: input.country ?? null,
    line: input.line ?? null,
  }
}

export async function filterStoresAvailableToCustomer(
  stores: StoreRow[],
  input: AvailableStoreContext,
): Promise<Array<StoreRow & { deliveryDistanceKm: number | null; available: boolean }>> {
  const location = await resolveCustomerLocation(input)
  const hasCoords =
    location.latitude != null &&
    location.longitude != null &&
    Number.isFinite(location.latitude) &&
    Number.isFinite(location.longitude)

  // Without a delivery place, only return stores that accept pickup / browsing
  // is limited — still return open stores but mark distance null. Prefer filtering
  // strictly when we know where the customer is.
  if (!hasCoords && !location.city && !location.line) {
    return stores.map((store) => ({ ...store, deliveryDistanceKm: null, available: true }))
  }

  const results: Array<StoreRow & { deliveryDistanceKm: number | null; available: boolean }> = []

  for (const store of stores) {
    let distanceKm: number | null = null

    if (
      hasCoords &&
      store.mapLat != null &&
      store.mapLng != null
    ) {
      try {
        distanceKm = await getDeliveryDistanceKm({
          fromLat: store.mapLat,
          fromLng: store.mapLng,
          toLat: location.latitude!,
          toLng: location.longitude!,
        })
      } catch {
        distanceKm = null
      }
    }

    const area = validateDeliveryCity({
      storeName: store.name,
      storeCity: store.city,
      storeAddress: store.address,
      storeCountry: store.country,
      maxDeliveryDistanceKm: store.maxDeliveryDistanceKm ?? DEFAULT_MAX_DELIVERY_DISTANCE_KM,
      customerCity: location.city,
      customerCountry: location.country,
      customerLine: location.line,
      distanceKm,
    })

    // When GPS is known, require an in-range distance. When only city is known,
    // city/country validation is enough.
    const inRange =
      distanceKm == null
        ? area.allowed
        : area.allowed && distanceKm <= area.maxDistanceKm

    if (!inRange) continue

    results.push({
      ...store,
      deliveryDistanceKm: distanceKm,
      available: true,
    })
  }

  return results.sort((a, b) => {
    const da = a.deliveryDistanceKm ?? Number.POSITIVE_INFINITY
    const db = b.deliveryDistanceKm ?? Number.POSITIVE_INFINITY
    if (da !== db) return da - db
    return a.name.localeCompare(b.name)
  })
}
