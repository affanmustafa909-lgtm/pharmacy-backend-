
import { isExpired } from '../lib/expiry.js'
import { prisma } from '../lib/prisma.js'
import { HttpError } from '../lib/http.js'
import type { Prisma, StockMovementReason } from '@prisma/client'

type DbClient = Prisma.TransactionClient

async function calculateSellableStock(db: DbClient, productId: string) {
  const batches = await db.inventoryBatch.findMany({
    where: { productId },
  })

  if (batches.length === 0) {
    const product = await db.product.findUnique({
      where: { id: productId },
    })

    if (!product || isExpired(product.expiry)) return 0
    return product.stock
  }

  return batches.reduce((total, batch) => {
    if (isExpired(batch.expiry)) return total
    return total + Math.max(0, batch.quantity)
  }, 0)
}

export async function sellableStock(productId: string) {
  return calculateSellableStock(prisma, productId)
}

export async function syncProductStockFromBatches(productId: string) {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
    })

    if (!product) {
      throw new HttpError(404, 'Product not found')
    }

    const stock = await calculateSellableStock(tx, productId)

    await tx.product.update({
      where: { id: productId },
      data: { stock },
    })

    return stock
  })
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
  return prisma.$transaction(async (tx) => {
    // Prevent duplicate stock movements for the same order.
    if (input.orderNumber) {
      const existing = await tx.stockMovement.findFirst({
        where: {
          orderNumber: input.orderNumber,
          productId: input.productId,
          reason: input.reason,
        },
      })

      if (existing) return existing
    }

    const product = await tx.product.findUnique({
      where: { id: input.productId },
    })

    if (!product) {
      throw new HttpError(404, 'Product not found')
    }

    if (product.storeId !== input.storeId) {
      throw new HttpError(400, 'Product does not belong to this store')
    }

    const batches = await tx.inventoryBatch.findMany({
      where: { productId: input.productId },
      orderBy: { expiry: 'asc' },
    })

    if (input.quantity < 0) {
      let remaining = Math.abs(input.quantity)

      if (batches.length > 0) {
        for (const batch of batches) {
          if (remaining <= 0) break
          if (isExpired(batch.expiry) || batch.quantity <= 0) continue

          const take = Math.min(batch.quantity, remaining)

          const updated = await tx.inventoryBatch.updateMany({
            where: {
              id: batch.id,
              quantity: { gte: take },
            },
            data: {
              quantity: { decrement: take },
            },
          })

          if (updated.count !== 1) {
            throw new HttpError(409, 'Stock changed. Please try again.')
          }

          remaining -= take
        }

        if (remaining > 0) {
          throw new HttpError(
            409,
            `${product.name} does not have enough sellable stock`,
          )
        }
      } else {
        const updated = await tx.product.updateMany({
          where: {
            id: product.id,
            stock: { gte: Math.abs(input.quantity) },
          },
          data: {
            stock: { decrement: Math.abs(input.quantity) },
          },
        })

        if (updated.count !== 1) {
          throw new HttpError(
            409,
            `${product.name} does not have enough stock`,
          )
        }
      }
    } else if (input.quantity > 0) {
      if (batches.length > 0) {
        const openBatch = batches.find(
          (batch) => !isExpired(batch.expiry),
        )

        if (openBatch) {
          await tx.inventoryBatch.update({
            where: { id: openBatch.id },
            data: {
              quantity: { increment: input.quantity },
            },
          })
        } else {
          await tx.inventoryBatch.create({
            data: {
              productId: input.productId,
              storeId: input.storeId,
              batchNumber:
                product.batch ||
                `ADJ-${Date.now().toString(36).toUpperCase()}`,
              quantity: input.quantity,
              expiry: product.expiry || '12/30',
            },
          })
        }
      } else {
        await tx.product.update({
          where: { id: product.id },
          data: {
            stock: { increment: input.quantity },
          },
        })
      }
    }

    const movement = await tx.stockMovement.create({
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

    // Keep Product.stock synchronized with non-expired batches.
    const updatedStock = await calculateSellableStock(
      tx,
      input.productId,
    )

    await tx.product.update({
      where: { id: input.productId },
      data: { stock: updatedStock },
    })

    return movement
  })
}
