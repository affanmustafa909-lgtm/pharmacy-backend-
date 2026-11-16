import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
const stores = await prisma.store.findMany({
  orderBy: { createdAt: 'desc' },
  select: { id: true, code: true, name: true, status: true, createdAt: true },
})
console.log(JSON.stringify(stores, null, 2))
await prisma.$disconnect()
