import { isExpired } from '../lib/expiry.js'
import { prisma } from '../lib/prisma.js'
import { HttpError } from '../lib/http.js'
import type { StockMovementReason } from '@prisma/client'

export async function sellableStock(productId: string) {
  const batches = await prisma.inventoryBatch.findMany({ where: { productId } })
  if (batches.length === 0) {
    const product = await prisma.product.findUnique({ where: { id: productId } })
    if (!product) return 0
    return isExpired(product.expiry) ? 0 : product.stock
  }
  return batches.reduce((sum, batch) => sum + (isExpired(batch.expiry) ? 0 : batch.quantity), 0)
}

export async function syncProductStockFromBatches(productId: string) {
  const stock = await sellableStock(productId)
  await prisma.product.update({ where: { id: productId }, data: { stock } })
  return stock
}

export async function recordStockMovement(input: {
  productId: string
  storeId: string
  quantity: number
  reason: StockMovementReason
  note?: string
  orderNumber?: string
  userId?: string | null
}) {
  if (input.orderNumber) {
    const existing = await prisma.stockMovement.findFirst({
      where: {
        orderNumber: input.orderNumber,
        productId: input.productId,
        reason: input.reason,
      },
    })
    if (existing) return existing
  }
  const product = await prisma.product.findUnique({ where: { id: input.productId } })
  if (!product) throw new HttpError(404, 'Product not found')

  const movement = await prisma.$transaction(async (tx) => {
    const created = await tx.stockMovement.create({
      data: {
        productId: input.productId,
        storeId: input.storeId,
        quantity: input.quantity,
        reason: input.reason,
        note: input.note ?? '',
        orderNumber: input.orderNumber ?? '',
        userId: input.userId ?? null,
      },
    })
    const batches = await tx.inventoryBatch.findMany({
      where: { productId: input.productId },
      orderBy: { expiry: 'asc' },
    })
    if (batches.length && input.quantity < 0) {
      let remaining = Math.abs(input.quantity)
      for (const batch of batches) {
        if (remaining <= 0) break
        if (isExpired(batch.expiry) || batch.quantity <= 0) continue
        const take = Math.min(batch.quantity, remaining)
        await tx.inventoryBatch.update({
          where: { id: batch.id },
          data: { quantity: { decrement: take } },
        })
        remaining -= take
      }
      if (remaining > 0) throw new HttpError(409, `${product.name} does not have enough sellable stock`)
    } else if (batches.length && input.quantity > 0) {
      // restock goes to first non-expired batch or creates a default batch
      const open = batches.find((batch) => !isExpired(batch.expiry))
      if (open) {
        await tx.inventoryBatch.update({
          where: { id: open.id },
          data: { quantity: { increment: input.quantity } },
        })
      } else {
        await tx.inventoryBatch.create({
          data: {
            productId: input.productId,
            storeId: input.storeId,
            batchNumber: product.batch || `ADJ-${Date.now().toString(36).toUpperCase()}`,
            quantity: input.quantity,
            expiry: product.expiry || '12/30',
          },
        })
      }
    } else {
      const next = product.stock + input.quantity
      if (next < 0) throw new HttpError(409, `${product.name} does not have enough stock`)
      await tx.product.update({ where: { id: product.id }, data: { stock: next } })
    }
    return created
  })

  if ((await prisma.inventoryBatch.count({ where: { productId: input.productId } })) > 0) {
    await syncProductStockFromBatches(input.productId)
  }
  return movement
}
