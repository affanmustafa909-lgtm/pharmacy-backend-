import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { assertValidExpiry, daysLeft, isExpired, normalizeExpiry } from '../lib/expiry.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { assertStoreAccess } from '../services/permissions.js'

export const stockRouter = Router()
stockRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'))

const toHttp = (error: unknown) =>
  error instanceof z.ZodError ? new HttpError(400, error.issues[0]?.message || 'Check the values') : error

/* ------------------------------------------------------------------ */
/* TASK 1: expiry counts (one rule, used by dashboard AND list)        */
/* ------------------------------------------------------------------ */
const SOON_DAYS = 90

function classifyBatch(expiry: string, now: Date) {
  if (!String(expiry ?? '').trim()) return 'none' as const
  const left = daysLeft(expiry, now)
  if (left === null) return 'invalid' as const
  if (isExpired(expiry, now)) return 'expired' as const
  // daysLeft counts today as 1, so "today .. today+90" means daysLeft <= 91
  return left <= SOON_DAYS + 1 ? ('soon' as const) : ('ok' as const)
}

async function loadBatches(storeId: string) {
  return prisma.inventoryBatch.findMany({
    where: { storeId, quantity: { gt: 0 } },
    include: { product: { select: { name: true, sku: true } } },
  })
}

stockRouter.get('/expiry-summary', async (req, res, next) => {
  try {
    const { storeId } = z.object({ storeId: z.string().min(1, 'storeId is required') }).parse(req.query)
    await assertStoreAccess(req.user!, storeId)
    const now = new Date()
    const batches = await loadBatches(storeId)
    const count = (b: string) => batches.filter((x) => classifyBatch(x.expiry, now) === b).length
    res.json({
      scope: { storeId, asOf: now.toISOString(), soonDays: SOON_DAYS },
      expired: count('expired'),
      expiringSoon: count('soon'),
      invalidExpiry: count('invalid'),
    })
  } catch (error) {
    next(toHttp(error))
  }
})

stockRouter.get('/expiry-batches', async (req, res, next) => {
  try {
    const q = z
      .object({ storeId: z.string().min(1), bucket: z.enum(['expired', 'soon', 'invalid']) })
      .parse(req.query)
    await assertStoreAccess(req.user!, q.storeId)
    const now = new Date()
    const rows = (await loadBatches(q.storeId))
      .filter((b) => classifyBatch(b.expiry, now) === q.bucket)
      .sort((a, b) => (daysLeft(a.expiry, now) ?? 99999) - (daysLeft(b.expiry, now) ?? 99999))
      .map((b) => ({
        id: b.id,
        productName: b.product.name,
        sku: b.product.sku,
        batchNumber: b.batchNumber,
        quantity: b.quantity,
        expiry: normalizeExpiry(b.expiry) ?? b.expiry,
      }))
    res.json({ scope: { storeId: q.storeId, asOf: now.toISOString(), bucket: q.bucket }, count: rows.length, batches: rows })
  } catch (error) {
    next(toHttp(error))
  }
})

/* ------------------------------------------------------------------ */
/* TASK 2: opening balance (marks existing stock, invents NO old events) */
/* ------------------------------------------------------------------ */
stockRouter.post('/opening-balance', async (req, res, next) => {
  try {
    const { storeId } = z.object({ storeId: z.string().min(1) }).parse(req.body)
    await assertStoreAccess(req.user!, storeId, { roles: ['OWNER', 'STORE_MANAGER'] })
    const products = await prisma.product.findMany({ where: { storeId }, select: { id: true, stock: true } })
    const sums = await prisma.stockMovement.groupBy({ by: ['productId'], where: { storeId }, _sum: { quantity: true } })
    const sumMap = new Map(sums.map((s) => [s.productId, s._sum.quantity ?? 0]))
    const rows = products
      .map((p) => ({
        productId: p.id,
        storeId,
        quantity: p.stock - (sumMap.get(p.id) ?? 0),
        reason: 'opening_balance' as const,
        note: 'Opening balance (stock that existed before history tracking)',
        requestId: `opening:${p.id}`,
        userId: req.user!.id,
      }))
      .filter((r) => r.quantity !== 0)
    const result = await prisma.stockMovement.createMany({ data: rows, skipDuplicates: true })
    res.json({ created: result.count })
  } catch (error) {
    next(toHttp(error))
  }
})

/* ------------------------------------------------------------------ */
/* History                                                              */
/* ------------------------------------------------------------------ */
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
        batchNumber: m.batchNumber,
        unitCost: m.unitCost === null ? null : Number(m.unitCost),
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

/* ------------------------------------------------------------------ */
/* Adjust / write-off (TASK 2 + TASK 10)                                */
/* requestId = repeat-safe: same requestId twice => applied ONCE        */
/* ------------------------------------------------------------------ */
const adjustSchema = z.object({
  quantity: z.number().int().refine((v) => v !== 0, 'Quantity cannot be 0'),
  reason: z.enum(['restock', 'damage', 'expiry', 'manual_adjustment']),
  note: z.string().trim().min(3, 'Add a short reason').max(240),
  requestId: z.string().trim().min(8, 'requestId too short').max(80).optional(),
  batchNumber: z.string().trim().max(60).optional(),
  expiry: z.string().trim().max(40).optional(), // only needed to restock into a NEW batch
  unitCost: z.number().min(0).optional(),
})

stockRouter.post('/:productId/adjust', async (req, res, next) => {
  try {
    const body = adjustSchema.parse(req.body)
    const product = await prisma.product.findUnique({ where: { id: req.params.productId } })
    if (!product) throw new HttpError(404, 'Product not found')
    // Only an owner or a store manager may change stock (restock, damage, write-off, adjustment).
    await assertStoreAccess(req.user!, product.storeId, { roles: ['OWNER', 'STORE_MANAGER'] })

    const delta =
      body.reason === 'restock'
        ? Math.abs(body.quantity)
        : body.reason === 'damage' || body.reason === 'expiry'
          ? -Math.abs(body.quantity)
          : body.quantity
    if (product.stock + delta < 0) throw new HttpError(400, 'Stock cannot go below 0')

    try {
      const updated = await prisma.$transaction(
        async (tx) => {
          const result = await tx.product.updateMany({
            where: { id: product.id, stock: { gte: delta < 0 ? -delta : 0 } },
            data: { stock: { increment: delta } },
          })
          if (result.count !== 1) throw new HttpError(409, 'Stock changed, please try again')

          if (body.batchNumber) {
            if (delta < 0) {
              const r = await tx.inventoryBatch.updateMany({
                where: { productId: product.id, batchNumber: body.batchNumber, quantity: { gte: -delta } },
                data: { quantity: { decrement: -delta } },
              })
              if (r.count !== 1) throw new HttpError(400, 'This batch does not have enough quantity')
            } else {
              const batch = await tx.inventoryBatch.findFirst({
                where: { productId: product.id, batchNumber: body.batchNumber },
              })
              if (batch) {
                await tx.inventoryBatch.update({ where: { id: batch.id }, data: { quantity: { increment: delta } } })
              } else {
                if (!body.expiry) throw new HttpError(400, 'Expiry is required for a new batch')
                assertValidExpiry(product.name, body.expiry)
                await tx.inventoryBatch.create({
                  data: {
                    productId: product.id,
                    storeId: product.storeId,
                    batchNumber: body.batchNumber,
                    quantity: delta,
                    expiry: normalizeExpiry(body.expiry) ?? body.expiry,
                  },
                })
              }
            }
          }

          await tx.stockMovement.create({
            data: {
              productId: product.id,
              storeId: product.storeId,
              quantity: delta,
              reason: body.reason,
              note: body.note,
              userId: req.user!.id,
              batchNumber: body.batchNumber ?? '',
              unitCost: body.unitCost,
              requestId: body.requestId,
            },
          })

          if (body.reason === 'damage' || body.reason === 'expiry') {
            await tx.auditLog.create({
              data: {
                actorId: req.user!.id,
                storeId: product.storeId,
                action: 'stock.writeoff',
                detail: `${product.name}: -${-delta} (${body.reason})`,
                meta: { sku: product.sku, batch: body.batchNumber ?? '', qty: -delta, cost: (body.unitCost ?? 0) * -delta },
              },
            })
          }
          return tx.product.findUnique({ where: { id: product.id } })
        },
        { maxWait: 10000, timeout: 30000 },
      )
      res.json({ stock: updated?.stock ?? 0, repeated: false })
    } catch (error) {
      // same requestId sent again => already applied, do NOT apply twice
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const again = await prisma.product.findUnique({ where: { id: product.id } })
        res.json({ stock: again?.stock ?? 0, repeated: true })
        return
      }
      throw error
    }
  } catch (error) {
    next(toHttp(error))
  }
})