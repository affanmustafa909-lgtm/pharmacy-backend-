import { prisma } from './src/lib/prisma.js'

const products = await prisma.product.findMany({
  include: {
    store: {
      select: {
        name: true,
        status: true,
        isOpen: true,
        acceptingOrders: true,
      },
    },
    batches: true,
  },
  orderBy: { name: 'asc' },
})

for (const p of products) {
  console.log('\n-----------------------------------')
  console.log('MEDICINE:', p.name)
  console.log('STORE:', p.store.name)
  console.log('STORE STATUS:', p.store.status)
  console.log('STORE OPEN:', p.store.isOpen)
  console.log('ACCEPTING ORDERS:', p.store.acceptingOrders)
  console.log('PUBLISHED:', p.published)
  console.log('ONLINE SALE:', p.onlineSale)
  console.log('HELD:', p.held)
  console.log('PRODUCT STOCK:', p.stock)
  console.log('PRODUCT EXPIRY:', p.expiry)
  console.log('BATCH COUNT:', p.batches.length)

  for (const b of p.batches) {
    console.log('BATCH:', {
      batchNumber: b.batchNumber,
      quantity: b.quantity,
      expiry: b.expiry,
    })
  }
}

await prisma.$disconnect()
