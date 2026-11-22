import 'dotenv/config'
import { PrismaClient, Prisma } from '@prisma/client'
import { extractCityFromAddress } from '../src/domain/deliveryArea.js'

const prisma = new PrismaClient()
const dec = (value: number) => new Prisma.Decimal(value)

const DEFAULT_DISTANCE_TIERS = [
  // Standard delivery: lower fee for nearby places, higher for far places
  {
    label: 'Nearby standard (0-3 km)',
    deliveryType: 'standard',
    amount: 2.0,
    minDistanceKm: 0,
    maxDistanceKm: 3,
    perKmRate: 0,
  },
  {
    label: 'Mid-range standard (3-8 km)',
    deliveryType: 'standard',
    amount: 4.5,
    minDistanceKm: 3,
    maxDistanceKm: 8,
    perKmRate: 0,
  },
  {
    label: 'Far standard (8+ km)',
    deliveryType: 'standard',
    amount: 7.5,
    minDistanceKm: 8,
    maxDistanceKm: null,
    perKmRate: 0.5,
  },
  // Express delivery: faster courier, distance-tiered
  {
    label: 'Nearby express (0-3 km)',
    deliveryType: 'express',
    amount: 4.0,
    minDistanceKm: 0,
    maxDistanceKm: 3,
    perKmRate: 0,
  },
  {
    label: 'Mid-range express (3-8 km)',
    deliveryType: 'express',
    amount: 7.5,
    minDistanceKm: 3,
    maxDistanceKm: 8,
    perKmRate: 0,
  },
  {
    label: 'Far express (8+ km)',
    deliveryType: 'express',
    amount: 11.0,
    minDistanceKm: 8,
    maxDistanceKm: null,
    perKmRate: 0.75,
  },
] as const

async function main() {
  const stores = await prisma.store.findMany()
  for (const store of stores) {
    // Ensure store has map coordinates, city, country, and max delivery distance
    const storePatch: Record<string, unknown> = {}
    if (store.mapLat == null || store.mapLng == null) {
      storePatch.mapLat = 40.7549
      storePatch.mapLng = -73.974
    }
    if (!store.city) {
      storePatch.city = extractCityFromAddress(store.address) || 'New York'
    }
    if (!store.country) {
      storePatch.country = 'United States'
    }
    if (store.maxDeliveryDistanceKm == null) {
      storePatch.maxDeliveryDistanceKm = 30
    }
    if (Object.keys(storePatch).length > 0) {
      await prisma.store.update({
        where: { id: store.id },
        data: storePatch,
      })
    }

    const tieredCount = await prisma.chargeRule.count({
      where: {
        storeId: store.id,
        kind: 'DELIVERY',
        active: true,
        OR: [
          { minDistanceKm: { not: null } },
          { maxDistanceKm: { not: null } },
        ],
      },
    })

    if (tieredCount > 0) {
      console.log(store.code, 'already has distance-based delivery tiers')
      continue
    }

    // Replace legacy flat standard/express delivery rules with distance-based tiers
    await prisma.chargeRule.deleteMany({
      where: {
        storeId: store.id,
        kind: 'DELIVERY',
        deliveryType: { in: ['standard', 'express'] },
      },
    })

    await prisma.chargeRule.createMany({
      data: DEFAULT_DISTANCE_TIERS.map((tier) => ({
        storeId: store.id,
        kind: 'DELIVERY',
        label: tier.label,
        mode: 'FIXED',
        amount: dec(tier.amount),
        deliveryType: tier.deliveryType,
        minDistanceKm: tier.minDistanceKm,
        maxDistanceKm: tier.maxDistanceKm,
        perKmRate: tier.perKmRate > 0 ? dec(tier.perKmRate) : null,
        active: true,
      })),
    })

    console.log(store.code, 'configured distance-based delivery charge tiers')
  }

  // Backfill structured details on existing customer addresses if empty
  const addresses = await prisma.customerAddress.findMany()
  for (const addr of addresses) {
    if (!addr.country && !addr.city && !addr.subCity) {
      const parts = addr.line.split(',').map((s) => s.trim()).filter(Boolean)
      const street = parts[0] ?? addr.line
      const city = parts[1] ?? 'New York'
      const stateZip = (parts[2] ?? 'NY 10017').split(/\s+/)
      const state = stateZip[0] ?? 'NY'
      const postalCode = stateZip[1] ?? '10017'
      const subCity = addr.label.toLowerCase().includes('work') ? 'Midtown East' : 'Manhattan'
      const country = 'United States'
      await prisma.customerAddress.update({
        where: { id: addr.id },
        data: {
          street,
          subCity,
          city,
          state,
          country,
          postalCode,
          latitude: addr.latitude ?? 40.758,
          longitude: addr.longitude ?? -73.9855,
        },
      })
      console.log('Backfilled structured fields for address:', addr.label)
    }
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
