import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

try {
  const stores = await prisma.store.findMany({
    select: {
      id: true,
      name: true,
      status: true,
      mapLat: true,
      mapLng: true,
    },
  })

  console.table(stores)
} catch (error) {
  console.error(error)
} finally {
  await prisma.$disconnect()
}
