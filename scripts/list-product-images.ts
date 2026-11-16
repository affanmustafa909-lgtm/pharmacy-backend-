import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const products = await prisma.product.findMany({
    select: { id: true, sku: true, name: true, imageUrl: true },
    orderBy: { name: 'asc' },
  })
  console.log(JSON.stringify(products, null, 2))
}

main()
  .finally(async () => {
    await prisma.$disconnect()
  })
