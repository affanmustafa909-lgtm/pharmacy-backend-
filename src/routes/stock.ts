import { Router } from 'express'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { assertStoreAccess } from '../services/permissions.js'

export const stockRouter = Router()
stockRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'))

stockRouter.get('/:productId/history', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.productId } })
    if (!product) throw new HttpError(404, 'Product not found')
    await assertStoreAccess(req.user!, product.storeId)
    const moves = await prisma.stockMovement.findMany({
      where: { productId: product.id },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    res.json({
      movements: moves.map((m) => ({
        id: m.id,
        quantity: m.quantity,
        reason: m.reason,
        note: m.note,
        orderNumber: m.orderNumber,
        staffName:
          m.user?.name ??
          (m.reason === 'order_fulfillment' || m.reason === 'cancellation_release' ? 'Customer (app)' : 'System'),
        createdAt: m.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    next(error)
  }
})

const adjustSchema = z.object({
  quantity: z.number().int().refine((v) => v !== 0, 'Quantity cannot be 0'),
  reason: z.enum(['restock', 'damage', 'expiry', 'manual_adjustment']),
  note: z.string().trim().min(3, 'Add a short reason').max(240),
})

stockRouter.post('/:productId/adjust', async (req, res, next) => {
  try {
    const body = adjustSchema.parse(req.body)
    const product = await prisma.product.findUnique({ where: { id: req.params.productId } })
    if (!product) throw new HttpError(404, 'Product not found')
    await assertStoreAccess(req.user!, product.storeId)

    const delta =
      body.reason === 'restock'
        ? Math.abs(body.quantity)
        : body.reason === 'damage' || body.reason === 'expiry'
          ? -Math.abs(body.quantity)
          : body.quantity
    if (product.stock + delta < 0) throw new HttpError(400, 'Stock cannot go below 0')

    const updated = await prisma.$transaction(
      async (tx) => {
        const result = await tx.product.updateMany({
          where: { id: product.id, stock: { gte: delta < 0 ? -delta : 0 } },
          data: { stock: { increment: delta } },
        })
        if (result.count !== 1) throw new HttpError(409, 'Stock changed, please try again')
        await tx.stockMovement.create({
          data: {
            productId: product.id,
            storeId: product.storeId,
            quantity: delta,
            reason: body.reason,
            note: body.note,
            userId: req.user!.id,
          },
        })
        return tx.product.findUnique({ where: { id: product.id } })
      },
      { maxWait: 10000, timeout: 30000 },
    )
    res.json({ stock: updated?.stock ?? 0 })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, error.issues[0]?.message || 'Check the values') : error)
  }
})