import { PrismaClient, Prisma } from '@prisma/client'

const prisma = new PrismaClient()
const dec = (value: number) => new Prisma.Decimal(value)

async function main() {
  const stores = await prisma.store.findMany()
  for (const store of stores) {
    const existing = await prisma.chargeRule.count({
      where: { storeId: store.id, kind: 'DELIVERY', active: true },
    })
    if (existing > 0) {
      const zeroOnly = await prisma.chargeRule.count({
        where: { storeId: store.id, kind: 'DELIVERY', active: true, amount: dec(0) },
      })
      if (zeroOnly === existing) {
        await prisma.chargeRule.updateMany({
          where: { storeId: store.id, kind: 'DELIVERY', deliveryType: 'standard' },
          data: { amount: dec(3.5), label: 'Standard delivery' },
        })
        await prisma.chargeRule.updateMany({
          where: { storeId: store.id, kind: 'DELIVERY', deliveryType: 'express' },
          data: { amount: dec(6.5), label: 'Express delivery' },
        })
        console.log(store.code, 'updated zero delivery rules')
      } else {
        console.log(store.code, 'already has delivery rules')
      }
      continue
    }
    await prisma.chargeRule.createMany({
      data: [
        {
          storeId: store.id,
          kind: 'DELIVERY',
          label: 'Standard delivery',
          mode: 'FIXED',
          amount: dec(3.5),
          deliveryType: 'standard',
          active: true,
        },
        {
          storeId: store.id,
          kind: 'DELIVERY',
          label: 'Express delivery',
          mode: 'FIXED',
          amount: dec(6.5),
          deliveryType: 'express',
          active: true,
        },
      ],
    })
    console.log(store.code, 'created delivery rules')
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
