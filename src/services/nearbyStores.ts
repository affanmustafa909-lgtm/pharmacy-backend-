import type { ChargeRule } from '@prisma/client'
import { calculateCharges, type ChargeRuleInput } from '../domain/charges.js'
import { prisma } from '../lib/prisma.js'
import { formatAddressLine, geocodeStructuredAddress } from './geocode.js'
import { haversineDistanceKm } from './distance.js'
import { formatAddressLine as formatCustomerLine, storeCoversArea } from './deliveryAddress.js'
import { money } from './money.js'

function toRule(rule: ChargeRule): ChargeRuleInput {
  return {
    kind: rule.kind,
    label: rule.label,
    mode: rule.mode,
    amount: money(rule.amount),
    percentBase: rule.percentBase,
    deliveryType: rule.deliveryType,
    minDistanceKm: rule.minDistanceKm,
    maxDistanceKm: rule.maxDistanceKm,
    perKmRate: rule.perKmRate != null ? money(rule.perKmRate) : null,
    active: rule.active,
  }
}

export type NearbyAddress = {
  houseNo?: string
  street?: string
  area?: string
  city?: string
  landmark?: string
  line?: string
  lat?: number | null
  lng?: number | null
}

export async function findNearbyStores(input: {
  address: NearbyAddress
  skus?: { sku: string; quantity: number }[]
  deliveryType?: 'standard' | 'express' | 'pickup'
}) {
  const line =
    formatCustomerLine({
      houseNo: input.address.houseNo,
      street: input.address.street,
      area: input.address.area,
      city: input.address.city,
      landmark: input.address.landmark,
      line: input.address.line,
    }) ||
    formatAddressLine({
      street: input.address.street,
      subCity: input.address.area,
      city: input.address.city,
      fallback: input.address.line,
    }) ||
    String(input.address.line ?? '').trim()

  let lat = input.address.lat ?? null
  let lng = input.address.lng ?? null
  if ((lat == null || lng == null) && line) {
    const geocoded = await geocodeStructuredAddress({
      street: [input.address.houseNo, input.address.street].filter(Boolean).join(' '),
      subCity: input.address.area,
      city: input.address.city,
      line,
    })
    if (geocoded) {
      lat = geocoded.latitude
      lng = geocoded.longitude
    }
  }

  const stores = await prisma.store.findMany({
    where: { status: 'active', isOpen: true, acceptingOrders: true },
    include: {
      deliveryOptions: true,
      chargeRules: { where: { active: true } },
      products: input.skus?.length
        ? {
            where: {
              sku: { in: input.skus.map((item) => item.sku) },
              held: false,
              onlineSale: true,
              published: true,
            },
          }
        : false,
    },
    orderBy: { name: 'asc' },
  })

  const deliveryType = input.deliveryType ?? 'standard'
  const skuQty = new Map((input.skus ?? []).map((item) => [item.sku, item.quantity]))
  const hasCustomerGeo = lat != null && lng != null

  // Prefer a human product name even when a store does not carry the SKU.
  const catalogNames = new Map<string, string>()
  if (input.skus?.length) {
    const named = await prisma.product.findMany({
      where: { sku: { in: input.skus.map((item) => item.sku) }, published: true },
      select: { sku: true, name: true },
      distinct: ['sku'],
    })
    for (const row of named) catalogNames.set(row.sku, row.name)
  }

  const isOpenEndedArea = (deliveryArea: string | null | undefined) => {
    const zone = String(deliveryArea ?? '').trim().toLowerCase()
    return !zone || zone === 'local delivery area' || zone === 'all'
  }

  let rows = stores
    .map((store) => {
      let distanceKm: number | null = null
      const hasStoreGeo = store.mapLat != null && store.mapLng != null
      if (hasCustomerGeo && hasStoreGeo) {
        distanceKm = haversineDistanceKm({
          fromLat: store.mapLat!,
          fromLng: store.mapLng!,
          toLat: lat!,
          toLng: lng!,
        })
      }

      const maxKm =
        store.maxDeliveryDistanceKm != null && store.maxDeliveryDistanceKm > 0
          ? store.maxDeliveryDistanceKm
          : 30
      const geoCovers = distanceKm != null && distanceKm <= maxKm

      const explicitTextCovers = store.deliveryOptions.some(
        (option) =>
          option.available &&
          option.type !== 'pickup' &&
          !isOpenEndedArea(option.deliveryArea) &&
          storeCoversArea(option.deliveryArea, { ...input.address, line }),
      )

      const openEndedTextCovers =
        store.deliveryOptions.some(
          (option) =>
            option.available && option.type !== 'pickup' && isOpenEndedArea(option.deliveryArea),
        ) ||
        (store.deliveryOptions.length === 0 && storeCoversArea('all', { ...input.address, line }))

      let covers = false
      if (deliveryType === 'pickup') {
        covers = true
      } else if (hasCustomerGeo && hasStoreGeo) {
        // Pin-to-pin distance is authoritative when both sides have GPS.
        covers = geoCovers
      } else if (hasCustomerGeo && !hasStoreGeo) {
        // Store has no map pin — never treat "Local delivery area" as worldwide.
        covers = explicitTextCovers
      } else {
        covers = explicitTextCovers || openEndedTextCovers
      }

      if (!covers) return null

      const option =
        store.deliveryOptions.find((item) => item.type === deliveryType && item.available) ??
        store.deliveryOptions.find((item) => item.type !== 'pickup' && item.available) ??
        null

      const charges = calculateCharges(
        0,
        deliveryType === 'pickup' ? 'pickup' : deliveryType,
        store.chargeRules.map(toRule),
        distanceKm,
      )

      const availability = (input.skus ?? []).map((wanted) => {
        const product = Array.isArray(store.products)
          ? store.products.find((row) => row.sku === wanted.sku)
          : undefined
        const qty = skuQty.get(wanted.sku) ?? wanted.quantity
        const inStock = Boolean(product && product.stock >= qty)
        return {
          sku: wanted.sku,
          quantity: qty,
          available: inStock,
          productId: product?.id ?? null,
          name: product?.name ?? catalogNames.get(wanted.sku) ?? wanted.sku,
          price: product ? money(product.price) : null,
          stock: product?.stock ?? 0,
        }
      })

      const canFulfillAll = !input.skus?.length || availability.every((item) => item.available)

      return {
        id: store.id,
        code: store.code,
        name: store.name,
        address: store.address,
        openUntil: store.openUntil,
        rating: store.rating,
        acceptingOrders: store.acceptingOrders,
        mapLat: store.mapLat,
        mapLng: store.mapLng,
        distanceKm,
        deliveryFee: charges.deliveryCharge,
        etaMinutes: option?.etaMinutes ?? (deliveryType === 'express' ? 30 : deliveryType === 'pickup' ? 20 : 60),
        deliveryArea: option?.deliveryArea ?? '',
        canFulfillAll,
        availability,
      }
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .sort((a, b) => {
      if (a.canFulfillAll !== b.canFulfillAll) return a.canFulfillAll ? -1 : 1
      if (a.distanceKm == null && b.distanceKm == null) return a.name.localeCompare(b.name)
      if (a.distanceKm == null) return 1
      if (b.distanceKm == null) return -1
      return a.distanceKm - b.distanceKm
    })

  // If any nearby store can fill the cart, only list those — don't spam
  // "unavailable here" on every pharmacy that happens to be in range.
  const wantedSkus = input.skus?.length ?? 0
  const fulfillable = wantedSkus > 0 ? rows.filter((row) => row.canFulfillAll) : rows
  let message: string | null = null
  if (rows.length === 0) {
    message =
      'No pharmacy can deliver to this address right now. Change the address or choose store pickup.'
  } else if (wantedSkus > 0 && fulfillable.length === 0) {
    message =
      'Nearby pharmacies are in range, but none have all cart items in stock. Change items or choose store pickup.'
  } else if (fulfillable.length > 0 && fulfillable.length < rows.length) {
    rows = fulfillable
    message = null
  } else {
    rows = fulfillable.length > 0 ? fulfillable : rows
  }

  return {
    address: { ...input.address, line, lat, lng },
    stores: rows,
    message,
  }
}