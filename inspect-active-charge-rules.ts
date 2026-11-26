import { prisma } from './src/lib/prisma.js'

async function main() {
  const rules = await prisma.chargeRule.findMany({
    include: {
      store: {
        select: {
          name: true,
          city: true,
          maxDeliveryDistanceKm: true,
        },
      },
    },
    orderBy: [
      { storeId: 'asc' },
      { kind: 'asc' },
      { minDistanceKm: 'asc' },
    ],
  })

  console.log(JSON.stringify(
    rules.map((r) => ({
      store: r.store.name,
      city: r.store.city,
      coverageKm: r.store.maxDeliveryDistanceKm,
      id: r.id,
      kind: r.kind,
      label: r.label,
      deliveryType: r.deliveryType,
      minKm: r.minDistanceKm,
      maxKm: r.maxDistanceKm,
      amount: r.amount.toString(),
      perKmRate: r.perKmRate?.toString() ?? null,
      active: r.active,
    })),
    null,
    2,
  ))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
