import { Router, type Request, type RequestHandler, type Response } from 'express'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { assertValidExpiry, isExpired, normalizeExpiry } from '../lib/expiry.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { assertStoreAccess } from '../services/permissions.js'

export const purchasingRouter = Router()
purchasingRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'))

type H = (req: Request, res: Response) => Promise<unknown>
const route =
  (fn: H): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch((e) =>
      next(e instanceof z.ZodError ? new HttpError(400, e.issues[0]?.message || 'Check the values') : e),
    )
  }

const isDuplicate = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
const cents = (v: Prisma.Decimal | number | string) => Math.round(Number(v) * 100)
const money = (c: number) => c / 100

function summarize(inv: {
  lines: { quantity: number; unitCost: Prisma.Decimal }[]
  payments: { amount: Prisma.Decimal }[]
}) {
  const total = inv.lines.reduce((s, l) => s + l.quantity * cents(l.unitCost), 0)
  const paid = inv.payments.reduce((s, p) => s + cents(p.amount), 0)
  return { total: money(total), paid: money(paid), balance: money(total - paid) }
}

const audit = (
  tx: Prisma.TransactionClient,
  actorId: string,
  storeId: string,
  action: string,
  detail: string,
  meta: Prisma.InputJsonValue = {},
) => tx.auditLog.create({ data: { actorId, storeId, action, detail, meta } })

const TX = { maxWait: 10000, timeout: 30000 }

/* ================= TASK 3: SUPPLIERS ================= */
const supplierBody = z.object({
  name: z.string().trim().min(2, 'Supplier name is required').max(120),
  contact: z.string().trim().max(120).default(''),
  address: z.string().trim().max(240).default(''),
  active: z.boolean().default(true),
})

purchasingRouter.get(
  '/suppliers',
  route(async (req, res) => {
    const q = z.object({ storeId: z.string().min(1), q: z.string().trim().optional() }).parse(req.query)
    await assertStoreAccess(req.user!, q.storeId)
    const suppliers = await prisma.supplier.findMany({
      where: { storeId: q.storeId, ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}) },
      orderBy: { name: 'asc' },
    })
    res.json({ suppliers })
  }),
)

purchasingRouter.post(
  '/suppliers',
  route(async (req, res) => {
    const b = supplierBody.extend({ storeId: z.string().min(1) }).parse(req.body)
    await assertStoreAccess(req.user!, b.storeId)
    const supplier = await prisma.supplier.create({ data: b })
    res.status(201).json({ supplier })
  }),
)

purchasingRouter.put(
  '/suppliers/:id',
  route(async (req, res) => {
    const b = supplierBody.parse(req.body)
    const existing = await prisma.supplier.findUnique({ where: { id: String(req.params.id) } })
    if (!existing) throw new HttpError(404, 'Supplier not found')
    await assertStoreAccess(req.user!, existing.storeId)
    const supplier = await prisma.supplier.update({ where: { id: existing.id }, data: b })
    res.json({ supplier })
  }),
)

/* ================= TASK 4: PURCHASE INVOICES ================= */
// NOTE: the "sku" field accepts either the SKU or the product NAME.
const lineSchema = z.object({
  sku: z.string().trim().min(1, 'Product name or SKU is required'),
  batchNumber: z.string().trim().min(1, 'Batch number is required').max(60),
  expiry: z.string().trim().min(1, 'Expiry is required'),
  quantity: z.number().int().positive('Quantity must be more than 0'),
  unitCost: z.number().min(0, 'Unit cost cannot be negative'),
})
const invoiceSchema = z.object({
  storeId: z.string().min(1),
  supplierId: z.string().min(1),
  number: z.string().trim().min(1, 'Invoice number is required').max(60),
  note: z.string().trim().max(240).default(''),
  lines: z.array(lineSchema).min(1, 'Add at least one line'),
})

purchasingRouter.post(
  '/purchases',
  route(async (req, res) => {
    const b = invoiceSchema.parse(req.body)
    await assertStoreAccess(req.user!, b.storeId)
    const supplier = await prisma.supplier.findFirst({ where: { id: b.supplierId, storeId: b.storeId } })
    if (!supplier) throw new HttpError(404, 'Supplier not found for this store')

    // Find products by SKU OR by name (case-insensitive).
    const keys = [...new Set(b.lines.map((l) => l.sku))]
    const products = await prisma.product.findMany({
      where: {
        storeId: b.storeId,
        OR: [{ sku: { in: keys } }, ...keys.map((k) => ({ name: { equals: k, mode: 'insensitive' as const } }))],
      },
      select: { id: true, sku: true, name: true },
    })
    const find = (k: string) =>
      products.find((p) => p.sku === k) ?? products.find((p) => p.name.toLowerCase() === k.toLowerCase())

    const lines = b.lines.map((l) => {
      const p = find(l.sku)
      if (!p) throw new HttpError(400, `Product "${l.sku}" was not found in this store`)
      assertValidExpiry(p.name, l.expiry)
      const expiry = normalizeExpiry(l.expiry)
      if (!expiry) throw new HttpError(400, `${p.name}: expiry is required`)
      if (isExpired(expiry)) throw new HttpError(400, `${p.name}: this batch is already expired`)
      return { productId: p.id, batchNumber: l.batchNumber, expiry, quantity: l.quantity, unitCost: l.unitCost }
    })

    try {
      const invoice = await prisma.purchaseInvoice.create({
        data: {
          number: b.number,
          supplierId: b.supplierId,
          storeId: b.storeId,
          note: b.note,
          createdById: req.user!.id,
          lines: { create: lines },
        },
        include: { lines: true },
      })
      res.status(201).json({ invoice })
    } catch (e) {
      if (isDuplicate(e)) throw new HttpError(409, 'This invoice number is already used in this store')
      throw e
    }
  }),
)

purchasingRouter.get(
  '/purchases',
  route(async (req, res) => {
    const q = z.object({ storeId: z.string().min(1), supplierId: z.string().optional() }).parse(req.query)
    await assertStoreAccess(req.user!, q.storeId)
    const rows = await prisma.purchaseInvoice.findMany({
      where: { storeId: q.storeId, ...(q.supplierId ? { supplierId: q.supplierId } : {}) },
      include: { lines: true, payments: true, supplier: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    res.json({
      purchases: rows.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        supplierId: r.supplierId,
        supplierName: r.supplier.name,
        createdAt: r.createdAt.toISOString(),
        receivedAt: r.receivedAt?.toISOString() ?? null,
        ...summarize(r),
      })),
    })
  }),
)

purchasingRouter.get(
  '/purchases/:id',
  route(async (req, res) => {
    const inv = await prisma.purchaseInvoice.findUnique({
      where: { id: String(req.params.id) },
      include: { lines: true, payments: { orderBy: { paidAt: 'asc' } }, supplier: true },
    })
    if (!inv) throw new HttpError(404, 'Invoice not found')
    await assertStoreAccess(req.user!, inv.storeId)
    res.json({ invoice: inv, ...summarize(inv) })
  }),
)

// Receive: stock goes up ONCE. Second call => repeated:true, +0.
purchasingRouter.post(
  '/purchases/:id/receive',
  route(async (req, res) => {
    const id = String(req.params.id)
    const inv = await prisma.purchaseInvoice.findUnique({ where: { id }, include: { lines: true } })
    if (!inv) throw new HttpError(404, 'Invoice not found')
    await assertStoreAccess(req.user!, inv.storeId)

    const received = await prisma.$transaction(async (tx) => {
      const flip = await tx.purchaseInvoice.updateMany({
        where: { id, status: 'draft' },
        data: { status: 'received', receivedAt: new Date() },
      })
      if (flip.count !== 1) {
        const cur = await tx.purchaseInvoice.findUnique({ where: { id }, select: { status: true } })
        if (cur?.status === 'cancelled') throw new HttpError(409, 'This invoice is cancelled')
        return false // already received
      }
      for (const l of inv.lines) {
        await tx.product.update({ where: { id: l.productId }, data: { stock: { increment: l.quantity } } })
        const batch = await tx.inventoryBatch.findFirst({
          where: { productId: l.productId, batchNumber: l.batchNumber, expiry: l.expiry },
        })
        if (batch) {
          await tx.inventoryBatch.update({ where: { id: batch.id }, data: { quantity: { increment: l.quantity } } })
        } else {
          await tx.inventoryBatch.create({
            data: { productId: l.productId, storeId: inv.storeId, batchNumber: l.batchNumber, quantity: l.quantity, expiry: l.expiry },
          })
        }
        await tx.stockMovement.create({
          data: {
            productId: l.productId,
            storeId: inv.storeId,
            quantity: l.quantity,
            reason: 'purchase_receive',
            note: `Purchase ${inv.number}`,
            batchNumber: l.batchNumber,
            unitCost: l.unitCost,
            requestId: `receive:${l.id}`,
            userId: req.user!.id,
          },
        })
      }
      await audit(tx, req.user!.id, inv.storeId, 'purchase.receive', `Invoice ${inv.number} received`, { invoiceId: id })
      return true
    }, TX)
    res.json({ received, repeated: !received })
  }),
)

purchasingRouter.post(
  '/purchases/:id/cancel',
  route(async (req, res) => {
    const id = String(req.params.id)
    const inv = await prisma.purchaseInvoice.findUnique({ where: { id }, select: { storeId: true, status: true } })
    if (!inv) throw new HttpError(404, 'Invoice not found')
    await assertStoreAccess(req.user!, inv.storeId)
    const r = await prisma.purchaseInvoice.updateMany({ where: { id, status: 'draft' }, data: { status: 'cancelled' } })
    if (r.count === 0 && inv.status === 'received') throw new HttpError(409, 'A received invoice cannot be cancelled')
    res.json({ cancelled: true })
  }),
)

/* ================= TASK 5: SUPPLIER PAYMENTS ================= */
const paymentSchema = z.object({
  amount: z.number().positive('Amount must be more than 0'),
  receiptRef: z.string().trim().min(3, 'Receipt reference is required').max(80),
  note: z.string().trim().max(240).default(''),
})

purchasingRouter.post(
  '/purchases/:id/payments',
  route(async (req, res) => {
    const id = String(req.params.id)
    const b = paymentSchema.parse(req.body)
    const head = await prisma.purchaseInvoice.findUnique({ where: { id }, select: { storeId: true, number: true } })
    if (!head) throw new HttpError(404, 'Invoice not found')
    await assertStoreAccess(req.user!, head.storeId)

    const out = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PurchaseInvoice" WHERE id = ${id} FOR UPDATE`
      const inv = await tx.purchaseInvoice.findUnique({ where: { id }, include: { lines: true, payments: true } })
      if (!inv) throw new HttpError(404, 'Invoice not found')
      if (inv.status === 'cancelled') throw new HttpError(409, 'This invoice is cancelled')
      const s = summarize(inv)
      if (inv.payments.some((p) => p.receiptRef === b.receiptRef)) return { repeated: true, ...s }
      const amount = cents(b.amount)
      if (amount > cents(s.balance)) {
        throw new HttpError(400, `Payment is more than the remaining balance (${s.balance})`)
      }
      await tx.supplierPayment.create({
        data: { invoiceId: id, amount: b.amount, receiptRef: b.receiptRef, note: b.note, userId: req.user!.id },
      })
      await audit(tx, req.user!.id, inv.storeId, 'supplier.payment', `Invoice ${inv.number}: paid ${b.amount}`, {
        receiptRef: b.receiptRef,
      })
      return { repeated: false, total: s.total, paid: money(cents(s.paid) + amount), balance: money(cents(s.balance) - amount) }
    }, TX)
    res.json(out)
  }),
)

/* ================= TASK 7: INTER-STORE TRANSFER ================= */
// NOTE: the "sku" field accepts either the SKU or the product NAME.
const dispatchSchema = z.object({
  fromStoreId: z.string().min(1),
  toStoreId: z.string().min(1),
  sku: z.string().trim().min(1, 'Product name or SKU is required'),
  batchNumber: z.string().trim().min(1),
  quantity: z.number().int().positive('Quantity must be more than 0'),
  requestId: z.string().trim().min(8).max(80).optional(),
})

purchasingRouter.post(
  '/transfers/dispatch',
  route(async (req, res) => {
    const b = dispatchSchema.parse(req.body)
    await assertStoreAccess(req.user!, b.fromStoreId)
    if (b.fromStoreId === b.toStoreId) throw new HttpError(400, 'Source and destination must be different')
    const dest = await prisma.store.findUnique({ where: { id: b.toStoreId }, select: { id: true } })
    if (!dest) throw new HttpError(404, 'Destination store not found')

    const product = await prisma.product.findFirst({
      where: { storeId: b.fromStoreId, OR: [{ sku: b.sku }, { name: { equals: b.sku, mode: 'insensitive' } }] },
    })
    if (!product) throw new HttpError(404, 'Product not found in the source store')

    const destProduct = await prisma.product.findFirst({
      where: {
        storeId: b.toStoreId,
        OR: [{ sku: product.sku }, { name: { equals: product.name, mode: 'insensitive' } }],
      },
      select: { id: true },
    })
    if (!destProduct) throw new HttpError(400, 'This product does not exist in the destination store')

    const batch = await prisma.inventoryBatch.findFirst({ where: { productId: product.id, batchNumber: b.batchNumber } })
    if (!batch) throw new HttpError(404, 'Batch not found in the source store')

    try {
      const transfer = await prisma.$transaction(async (tx) => {
        const p = await tx.product.updateMany({
          where: { id: product.id, stock: { gte: b.quantity } },
          data: { stock: { decrement: b.quantity } },
        })
        if (p.count !== 1) throw new HttpError(400, 'Not enough stock in the source store')
        const bt = await tx.inventoryBatch.updateMany({
          where: { id: batch.id, quantity: { gte: b.quantity } },
          data: { quantity: { decrement: b.quantity } },
        })
        if (bt.count !== 1) throw new HttpError(400, 'Not enough quantity in this batch')
        const t = await tx.stockTransfer.create({
          data: {
            fromStoreId: b.fromStoreId,
            toStoreId: b.toStoreId,
            sku: product.sku,
            batchNumber: b.batchNumber,
            expiry: batch.expiry,
            quantity: b.quantity,
            requestId: b.requestId,
            dispatchedById: req.user!.id,
          },
        })
        await tx.stockMovement.create({
          data: {
            productId: product.id,
            storeId: b.fromStoreId,
            quantity: -b.quantity,
            reason: 'transfer_out',
            note: `Transfer ${t.id} to store ${b.toStoreId}`,
            batchNumber: b.batchNumber,
            requestId: `tout:${t.id}`,
            userId: req.user!.id,
          },
        })
        await audit(tx, req.user!.id, b.fromStoreId, 'transfer.dispatch', `${product.sku} x${b.quantity} -> ${b.toStoreId}`, {
          transferId: t.id,
        })
        return t
      }, TX)
      res.status(201).json({ transfer, repeated: false })
    } catch (e) {
      if (isDuplicate(e) && b.requestId) {
        const existing = await prisma.stockTransfer.findUnique({ where: { requestId: b.requestId } })
        res.json({ transfer: existing, repeated: true })
        return
      }
      throw e
    }
  }),
)

purchasingRouter.post(
  '/transfers/:id/receive',
  route(async (req, res) => {
    const id = String(req.params.id)
    const t = await prisma.stockTransfer.findUnique({ where: { id } })
    if (!t) throw new HttpError(404, 'Transfer not found')
    await assertStoreAccess(req.user!, t.toStoreId)

    const received = await prisma.$transaction(async (tx) => {
      const flip = await tx.stockTransfer.updateMany({
        where: { id, status: 'in_transit' },
        data: { status: 'received', receivedAt: new Date(), receivedById: req.user!.id },
      })
      if (flip.count !== 1) return false // already received => +0

      // Find the product in the destination store: by SKU first, then by the source product's name.
      let dest = await tx.product.findUnique({ where: { storeId_sku: { storeId: t.toStoreId, sku: t.sku } } })
      if (!dest) {
        const src = await tx.product.findUnique({
          where: { storeId_sku: { storeId: t.fromStoreId, sku: t.sku } },
          select: { name: true },
        })
        if (src) {
          dest = await tx.product.findFirst({
            where: { storeId: t.toStoreId, name: { equals: src.name, mode: 'insensitive' } },
          })
        }
      }
      if (!dest) throw new HttpError(400, 'This product does not exist in the destination store')

      await tx.product.update({ where: { id: dest.id }, data: { stock: { increment: t.quantity } } })
      const batch = await tx.inventoryBatch.findFirst({
        where: { productId: dest.id, batchNumber: t.batchNumber, expiry: t.expiry },
      })
      if (batch) {
        await tx.inventoryBatch.update({ where: { id: batch.id }, data: { quantity: { increment: t.quantity } } })
      } else {
        await tx.inventoryBatch.create({
          data: { productId: dest.id, storeId: t.toStoreId, batchNumber: t.batchNumber, quantity: t.quantity, expiry: t.expiry },
        })
      }
      await tx.stockMovement.create({
        data: {
          productId: dest.id,
          storeId: t.toStoreId,
          quantity: t.quantity,
          reason: 'transfer_in',
          note: `Transfer ${t.id} from store ${t.fromStoreId}`,
          batchNumber: t.batchNumber,
          requestId: `tin:${t.id}`,
          userId: req.user!.id,
        },
      })
      await audit(tx, req.user!.id, t.toStoreId, 'transfer.receive', `${t.sku} x${t.quantity} received`, { transferId: t.id })
      return true
    }, TX)
    res.json({ received, repeated: !received })
  }),
)

purchasingRouter.get(
  '/transfers',
  route(async (req, res) => {
    const { storeId } = z.object({ storeId: z.string().min(1) }).parse(req.query)
    await assertStoreAccess(req.user!, storeId)
    const transfers = await prisma.stockTransfer.findMany({
      where: { OR: [{ fromStoreId: storeId }, { toStoreId: storeId }] },
      orderBy: { dispatchedAt: 'desc' },
      take: 200,
    })
    res.json({ transfers })
  }),
)