import { Router } from 'express'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { isExpired } from '../lib/expiry.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { money } from '../services/money.js'
import { mapOrderDetail, placeOrder, quoteOrder, receiptHtml, recheckBuyAgain } from '../services/orders.js'

const itemsSchema = z
  .array(z.object({ productId: z.string().min(1), quantity: z.number().int().positive() }))
  .min(1, 'Cart is empty')
  .max(30)

const quoteSchema = z.object({
  storeId: z.string().min(1),
  deliveryType: z.enum(['standard', 'express', 'pickup']),
  promoCode: z.string().trim().max(40).optional(),
  prescriptionNumber: z.string().trim().max(40).optional(),
  items: itemsSchema,
})

const placeSchema = quoteSchema.extend({
  paymentLabel: z.string().min(1).max(80),
  addressLine: z.string().max(240).default(''),
})

export const customerOrderRouter = Router()
customerOrderRouter.use(requireAuth, requireRole('CUSTOMER'))

customerOrderRouter.post('/quote', async (req, res, next) => {
  try {
    const body = quoteSchema.parse(req.body)
    const quoted = await quoteOrder({
      ...body,
      customerId: req.user!.id,
      enforceRx: false,
    })
    const setting = await prisma.setting.findUnique({ where: { id: 'default' } })
    const config = setting?.mobileConfig as { tracking?: Record<string, number> } | null
    const etaMinutes =
      body.deliveryType === 'express'
        ? Number(config?.tracking?.expressEtaMinutes) || 25
        : body.deliveryType === 'pickup'
          ? Number(config?.tracking?.pickupEtaMinutes) || 40
          : Number(config?.tracking?.standardEtaMinutes) || 45
    res.json({
      ...quoted.charges,
      etaMinutes,
      storeName: quoted.store.name,
      storeAddress: quoted.store.address,
      openUntil: quoted.store.openUntil,
      requiresPrescription: quoted.lines.some((line) => line.product.rxRequired || line.product.controlled),
    })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, error.issues[0]?.message || 'Check the order details') : error)
  }
})

customerOrderRouter.post('/', async (req, res, next) => {
  try {
    const body = placeSchema.parse(req.body)
    const order = await placeOrder({
      ...body,
      customerId: req.user!.id,
      customerEmail: req.user!.email,
    })
    res.status(201).json({
      id: order.number,
      total: money(order.total),
      itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
      deliveryType: order.deliveryType,
      paymentLabel: order.paymentLabel,
      createdAt: order.createdAt.toISOString(),
      productSubtotal: money(order.productSubtotal),
      deliveryCharge: money(order.deliveryCharge),
      serviceCharge: money(order.serviceCharge),
      bfpCharge: money(order.bfpCharge),
      discount: money(order.discount),
      charges: order.charges.map((charge) => ({
        kind: charge.kind,
        label: charge.label,
        amount: money(charge.amount),
        mode: charge.mode,
        rate: money(charge.rate),
        percentBase: charge.percentBase,
      })),
      items: order.items.map((item) => ({
        productId: item.productId,
        name: item.name,
        sku: item.sku,
        unitPrice: money(item.unitPrice),
        quantity: item.quantity,
        lineTotal: money(item.lineTotal),
      })),
    })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, error.issues[0]?.message || 'Check the order details') : error)
  }
})

customerOrderRouter.get('/mine', async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { customerId: req.user!.id },
    include: { items: true, charges: true, store: true, rider: true },
    orderBy: { createdAt: 'desc' },
    take: 40,
  })
  res.json({
    orders: orders.map((order) => ({
      id: order.number,
      total: money(order.total),
      status: order.status,
      storeName: order.store.name,
      deliveryType: order.deliveryType,
      paymentLabel: order.paymentLabel,
      createdAt: order.createdAt.toISOString(),
      itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
      items: order.items.map((item) => ({
        productId: item.productId,
        name: item.name,
        sku: item.sku,
        unitPrice: money(item.unitPrice),
        quantity: item.quantity,
        lineTotal: money(item.lineTotal),
      })),
    })),
  })
})

customerOrderRouter.post('/:number/cancel', async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { number: req.params.number, customerId: req.user!.id },
      include: { items: true },
    })
    if (!order) throw new HttpError(404, 'Order not found')
    if (order.status !== 'placed') throw new HttpError(400, 'This order can no longer be cancelled')

    await prisma.$transaction(
      async (tx) => {
        const claimed = await tx.order.updateMany({
          where: { id: order.id, status: 'placed' },
          data: { status: 'cancelled', cancelReason: 'Cancelled by customer' },
        })
        if (claimed.count !== 1) throw new HttpError(409, 'Order status just changed')

        for (const item of order.items) {
          if (!item.productId) continue
          await tx.product.update({
            where: { id: item.productId },
            data: { stock: { increment: item.quantity } },
          })
          await tx.stockMovement.create({
            data: {
              productId: item.productId,
              storeId: order.storeId,
              quantity: item.quantity,
              reason: 'cancellation_release',
              orderNumber: order.number,
              note: 'Customer cancelled order',
              userId: null,
            },
          })
          const batches = await tx.inventoryBatch.findMany({
            where: { productId: item.productId },
            orderBy: { expiry: 'asc' },
          })
          const target = batches.find((b) => !isExpired(b.expiry))
          if (target) {
            await tx.inventoryBatch.update({
              where: { id: target.id },
              data: { quantity: { increment: item.quantity } },
            })
          }
        }
        await tx.orderActivity.create({
          data: { orderId: order.id, label: 'Order cancelled', detail: 'Cancelled by customer', actor: 'Customer' },
        })
        await tx.notice.create({
          data: { title: 'Order cancelled', body: `${order.number} was cancelled by the customer.`, at: 'Just now', page: 'orders' },
        })
      },
      { maxWait: 10000, timeout: 30000 },
    )
    res.json({ id: order.number, status: 'cancelled' })
  } catch (error) {
    next(error)
  }
})

customerOrderRouter.post('/buy-again', async (req, res, next) => {
  try {
    const body = z
      .object({
        orderNumber: z.string().min(1),
        storeId: z.string().optional(),
      })
      .parse(req.body)
    const result = await recheckBuyAgain({
      customerId: req.user!.id,
      orderNumber: body.orderNumber,
      storeId: body.storeId,
    })
    res.json(result)
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Check the order details') : error)
  }
})

customerOrderRouter.get('/:number/receipt', async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { number: req.params.number, customerId: req.user!.id },
      include: { items: true, charges: true, store: true, rider: true },
    })
    if (!order) throw new HttpError(404, 'Order not found')
    const detail = mapOrderDetail(order)
    const format = String(req.query.format ?? 'json')
    if (format === 'html') {
      res.type('html').send(receiptHtml(detail))
      return
    }
    res.json({ ...detail, html: receiptHtml(detail) })
  } catch (error) {
    next(error)
  }
})

customerOrderRouter.get('/:number', async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { number: req.params.number, customerId: req.user!.id },
      include: { items: true, charges: true, store: true, rider: true },
    })
    if (!order) throw new HttpError(404, 'Order not found')
    res.json(mapOrderDetail(order))
  } catch (error) {
    next(error)
  }
})