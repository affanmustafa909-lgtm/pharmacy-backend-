/**
 * One-shot: move active pharmacies onto Karachi map pins, widen delivery range,
 * extend hours into late evening, and set delivery areas to Karachi.
 * Fixes checkout when customers pin a Pakistan address.
 */
import { prisma } from '../src/lib/prisma.js'

const weeklyHours = {
  mon: { open: '09:00', close: '23:59' },
  tue: { open: '09:00', close: '23:59' },
  wed: { open: '09:00', close: '23:59' },
  thu: { open: '09:00', close: '23:59' },
  fri: { open: '09:00', close: '23:59' },
  sat: { open: '10:00', close: '23:59' },
  sun: { open: '10:00', close: '23:00' },
}

const byCode: Record<
  string,
  { address: string; city: string; mapLat: number; mapLng: number; openUntil: string }
> = {
  ALI: {
    address: 'Shop 12, Tariq Road, PECHS, Karachi',
    city: 'Karachi',
    mapLat: 24.8732,
    mapLng: 67.0615,
    openUntil: '11:59 PM',
  },
  CTY: {
    address: 'Near Teen Talwar, Clifton, Karachi',
    city: 'Karachi',
    mapLat: 24.8138,
    mapLng: 67.0225,
    openUntil: '11:59 PM',
  },
  HCP: {
    address: 'Bahadurabad Chowrangi, Karachi',
    city: 'Karachi',
    mapLat: 24.8821,
    mapLng: 67.0683,
    openUntil: '11:59 PM',
  },
  NEW: {
    address: 'DHA Phase 6, Karachi',
    city: 'Karachi',
    mapLat: 24.8025,
    mapLng: 67.0642,
    openUntil: '11:59 PM',
  },
}

const stores = await prisma.store.findMany()
for (const store of stores) {
  const mapped = byCode[store.code]
  await prisma.store.update({
    where: { id: store.id },
    data: {
      ...(mapped
        ? {
            address: mapped.address,
            city: mapped.city,
            mapLat: mapped.mapLat,
            mapLng: mapped.mapLng,
            openUntil: mapped.openUntil,
          }
        : {
            // Any other active store (e.g. Persistence Test) gets a Karachi pin too.
            city: store.city?.trim() || 'Karachi',
            mapLat: store.mapLat ?? 24.8607,
            mapLng: store.mapLng ?? 67.0011,
            openUntil: '11:59 PM',
          }),
      weeklyHours,
      maxDeliveryDistanceKm: 40,
      isOpen: true,
      acceptingOrders: true,
      status: store.status === 'archived' ? store.status : 'active',
    },
  })

  await prisma.storeDeliveryOption.updateMany({
    where: { storeId: store.id, type: { in: ['standard', 'express'] } },
    data: { deliveryArea: 'Karachi', available: true },
  })
}

console.log(`Updated ${stores.length} stores for local Karachi delivery coverage.`)
await prisma.$disconnect()
