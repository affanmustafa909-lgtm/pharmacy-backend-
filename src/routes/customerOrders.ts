import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { isExpired } from '../lib/expiry.js'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import {
  assertDeliveryAddress,
  checkoutAddressInputSchema,
  deliveryAddressSchema,
  pickupContactSchema,
} from '../services/deliveryAddress.js'
import { money } from '../services/money.js'
import { listOrderMessages, postOrderMessage } from '../services/orderMessages.js'
import {
  mapOrderDetail,
  placeMultiStoreCheckout,
  placeOrder,
  planCheckoutSplit,
  quoteOrder,
  receiptHtml,
  recheckBuyAgain,
} from '../services/orders.js'
import { findNearbyStores } from '../services/nearbyStores.js'
import { claimPaymentForCheckout } from '../services/payments.js'

const itemsSchema = z
  .array(z.object({ productId: z.string().min(1), quantity: z.number().int().positive() }))
  .min(1, 'Cart is empty')
  .max(30)

const quoteSchema = z.object({
  storeId: z.string().min(1),
  deliveryType: z.enum(['standard', 'express', 'pickup']),
  addressId: z.string().min(1).optional(),
  promoCode: z.string().trim().max(40).optional(),
  prescriptionNumber: z.string().trim().max(40).optional(),
  items: itemsSchema,
})

const placeSchema = quoteSchema.extend({
  paymentLabel: z.string().min(1).max(80),
  paymentStatus: z.enum(['paid', 'unpaid']).optional(),
  paymentTransactionId: z.string().min(1).optional(),
  addressLine: z.string().max(240).default(''),
})

const checkoutSchema = z.object({
  deliveryType: z.enum(['standard', 'express', 'pickup']),
  paymentLabel: z.string().min(1).max(80),
  paymentStatus: z.enum(['paid', 'unpaid']).optional(),
  paymentTransactionId: z.string().min(1).optional(),
  items: itemsSchema,
  idempotencyKey: z.string().trim().min(8).max(120),
  confirmSplit: z.boolean().optional(),
  promoCode: z.string().trim().max(40).optional(),
  prescriptionNumber: z.string().trim().max(40).optional(),
  addressId: z.string().min(1).optional(),
  address: checkoutAddressInputSchema.optional(),
  pickupContact: pickupContactSchema.optional(),
  recipientName: z.string().trim().max(80).optional(),
  recipientPhone: z.string().trim().max(40).optional(),
  addressLine: z.string().trim().max(240).optional(),
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
      deliveryDistanceKm: quoted.deliveryDistanceKm,
      openUntil: quoted.store.openUntil,
      requiresPrescription: quoted.lines.some((line) => line.product.rxRequired),
    })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, error.issues[0]?.message || 'Check the order details') : error)
  }
})

customerOrderRouter.post('/nearby-stores', async (req, res, next) => {
  try {
    const body = z
      .object({
        addressId: z.string().min(1).optional(),
        address: deliveryAddressSchema
          .partial()
          .extend({
            city: z.string().trim().min(1).optional(),
            area: z.string().trim().min(1).optional(),
            line: z.string().trim().min(1).optional(),
          })
          .optional(),
        deliveryType: z.enum(['standard', 'express', 'pickup']).optional(),
        skus: z
          .array(z.object({ sku: z.string().min(1), quantity: z.number().int().positive() }))
          .max(40)
          .optional(),
      })
      .refine((value) => Boolean(value.addressId || value.address), {
        message: 'Provide a saved address or address details',
      })
      .parse(req.body)
    const result = await findNearbyStores({
      address: body.address ?? {},
      addressId: body.addressId,
      customerId: req.user!.id,
      deliveryType: body.deliveryType,
      skus: body.skus,
    })
    res.json(result)
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, error.issues[0]?.message || 'Check the address') : error)
  }
})

customerOrderRouter.post('/plan', async (req, res, next) => {
  try {
    const body = z
      .object({
        deliveryType: z.enum(['standard', 'express', 'pickup']),
        items: itemsSchema,
        promoCode: z.string().trim().max(40).optional(),
        prescriptionNumber: z.string().trim().max(40).optional(),
        addressId: z.string().min(1).optional(),
      })
      .parse(req.body)
    const plan = await planCheckoutSplit({
      customerId: req.user!.id,
      ...body,
    })
    res.json(plan)
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, error.issues[0]?.message || 'Check the order details') : error)
  }
})

customerOrderRouter.post('/checkout', async (req, res, next) => {
  try {
    const body = checkoutSchema.parse(req.body)
    let recipientName = body.recipientName ?? ''
    let recipientPhone = body.recipientPhone ?? ''
    let addressLine = body.addressLine ?? ''
    let addressJson: Prisma.InputJsonValue | undefined

    if (body.deliveryType === 'pickup') {
      const contact = pickupContactSchema.parse(
        body.pickupContact ?? {
          recipientName: body.recipientName,
          phone: body.recipientPhone,
        },
      )
      recipientName = contact.recipientName
      recipientPhone = contact.phone
      addressLine = ''
    } else {
      const raw = (body.address ?? {}) as Record<string, unknown>
      const lineParts = String(body.addressLine ?? raw.line ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
      const textOr = (value: unknown, fallback: string, min = 2) => {
        const text = String(value ?? '').trim()
        return text.length >= min ? text : fallback
      }
      let cityGuess = lineParts.length >= 2 ? lineParts[lineParts.length - 1] : 'City'
      if (/^[A-Z]{2}$/i.test(cityGuess) && lineParts.length >= 3) {
        cityGuess = lineParts[lineParts.length - 2]
      } else {
        cityGuess = cityGuess.replace(/\s+[A-Z]{2}$/i, '').trim() || cityGuess
      }
      // Pad 1-character saved fields (e.g. area "d") so checkout is not blocked after card pay.
      const pad = (value: unknown, fallback: string) => {
        const text = String(value ?? '').trim()
        if (!text) return fallback
        return text.length >= 2 ? text : `${text}${fallback}`.slice(0, 80)
      }
      const address = assertDeliveryAddress(
        deliveryAddressSchema.parse({
          label: textOr(raw.label, 'Home', 1),
          recipientName: textOr(raw.recipientName, textOr(body.recipientName, 'Customer')),
          phone: textOr(raw.phone, textOr(body.recipientPhone, '+10000000000', 8), 8),
          houseNo: textOr(raw.houseNo, 'N/A', 1),
          street: pad(raw.street, lineParts[0] || body.addressLine || 'Address'),
          area: pad(raw.area, 'Local area'),
          city: pad(raw.city, cityGuess.length >= 2 ? cityGuess : 'City'),
          landmark: String(raw.landmark ?? '').trim(),
          deliveryInstructions: String(raw.deliveryInstructions ?? '').trim(),
          lat: typeof raw.lat === 'number' ? raw.lat : null,
          lng: typeof raw.lng === 'number' ? raw.lng : null,
          isDefault: Boolean(raw.isDefault),
        }),
      )
      recipientName = address.recipientName
      recipientPhone = address.phone
      addressLine = address.line
      addressJson = address
    }

    const result = await placeMultiStoreCheckout({
      customerId: req.user!.id,
      customerEmail: req.user!.email,
      idempotencyKey: body.idempotencyKey,
      deliveryType: body.deliveryType,
      paymentLabel: body.paymentLabel,
      paymentStatus: body.paymentStatus,
      paymentTransactionId: body.paymentTransactionId,
      recipientName,
      recipientPhone,
      addressLine,
      addressId: body.addressId,
      addressJson,
      items: body.items,
      promoCode: body.promoCode,
      prescriptionNumber: body.prescriptionNumber,
      confirmSplit: body.confirmSplit,
    })

    res.status(result.reused ? 200 : 201).json({
      checkoutGroupId: result.checkoutGroupId,
      combinedTotal: result.combinedTotal,
      reused: result.reused,
      transactionId: result.paymentTransaction?.transactionId ?? null,
      paymentStatus: result.orders[0]?.paymentStatus ?? body.paymentStatus ?? 'paid',
      paymentLabel: result.orders[0]?.paymentLabel ?? body.paymentLabel,
      orders: result.orders.map((order) => ({
        id: order.number,
        storeId: order.storeId,
        storeName: order.store.name,
        total: money(order.total),
        productSubtotal: money(order.productSubtotal),
        deliveryCharge: money(order.deliveryCharge),
        serviceCharge: money(order.serviceCharge),
        bfpCharge: money(order.bfpCharge),
        discount: money(order.discount),
        paymentStatus: order.paymentStatus,
        paymentLabel: order.paymentLabel,
        transactionId: result.paymentTransaction?.transactionId ?? null,
        itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
        deliveryType: order.deliveryType,
        recipientName: order.recipientName,
        recipientPhone: order.recipientPhone,
        addressLine: order.addressLine,
        riderName: order.rider?.name ?? null,
        riderPhone: order.rider?.phone ?? null,
      })),
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0]
      const field = issue?.path?.length ? String(issue.path[issue.path.length - 1]) : ''
      const message = issue?.message || 'Check the order details'
      next(
        new HttpError(
          400,
          field && /at least 2 character/i.test(message)
            ? `Complete the ${field} field (at least 2 characters)`
            : message,
        ),
      )
      return
    }
    next(error)
  }
})

customerOrderRouter.post('/', async (req, res, next) => {
  try {
    const body = placeSchema.parse(req.body)
    let paymentLabel = body.paymentLabel
    let paymentStatus = body.paymentStatus
    let paymentTransactionId = body.paymentTransactionId
    let transactionId: string | null = null

    if (paymentTransactionId) {
      const quoted = await quoteOrder({
        ...body,
        customerId: req.user!.id,
        enforceRx: false,
      })
      const claimed = await claimPaymentForCheckout({
        customerId: req.user!.id,
        paymentTransactionId,
        expectedAmount: quoted.charges.total,
        paymentLabel,
      })
      paymentTransactionId = claimed.txn.id
      paymentLabel = claimed.paymentLabel
      paymentStatus = 'paid'
      transactionId = claimed.txn.transactionId
    }

    const order = await placeOrder({
      ...body,
      paymentLabel,
      paymentStatus,
      paymentTransactionId,
      customerId: req.user!.id,
      customerEmail: req.user!.email,
    })

    if (paymentTransactionId) {
      await prisma.paymentTransaction.update({
        where: { id: paymentTransactionId },
        data: {
          orderNumber: order.number,
          orders: { connect: { number: order.number } },
        },
      })
    }

    res.status(201).json({
      id: order.number,
      total: money(order.total),
      itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
      deliveryType: order.deliveryType,
      paymentLabel: order.paymentLabel,
      paymentStatus: order.paymentStatus,
      transactionId,
      createdAt: order.createdAt.toISOString(),
      productSubtotal: money(order.productSubtotal),
      deliveryCharge: money(order.deliveryCharge),
      deliveryDistanceKm: order.deliveryDistanceKm,
      serviceCharge: money(order.serviceCharge),
      bfpCharge: money(order.bfpCharge),
      discount: money(order.discount),
      rider: order.rider
        ? {
            id: order.rider.id,
            name: order.rider.name,
            phone: order.rider.phone,
            vehicle: order.rider.vehicle,
          }
        : null,
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
    include: { items: true, charges: true, store: true, paymentTransaction: true },
    orderBy: { createdAt: 'desc' },
    take: 40,
  })
  res.json({
    orders: orders.map((order) => ({
      id: order.number,
      total: money(order.total),
      status: order.status,
      paymentStatus: order.paymentStatus,
      checkoutGroupId: order.checkoutGroupId,
      storeName: order.store.name,
      deliveryType: order.deliveryType,
      paymentLabel: order.paymentLabel,
      transactionId: order.paymentTransaction?.transactionId ?? null,
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

customerOrderRouter.get('/:number/messages', async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { number: req.params.number, customerId: req.user!.id },
      include: { rider: true },
    })
    if (!order) throw new HttpError(404, 'Order not found')
    const messages = await listOrderMessages(order.id)
    res.json({
      orderNumber: order.number,
      riderName: order.rider?.name ?? null,
      riderPhone: order.rider?.phone ?? null,
      messages,
    })
  } catch (error) {
    next(error)
  }
})

customerOrderRouter.post('/:number/messages', async (req, res, next) => {
  try {
    const body = z.object({ body: z.string().trim().min(1).max(500) }).parse(req.body)
    const order = await prisma.order.findFirst({
      where: { number: req.params.number, customerId: req.user!.id },
      include: { rider: true, customer: { select: { name: true } } },
    })
    if (!order) throw new HttpError(404, 'Order not found')
    if (!order.riderId) {
      throw new HttpError(409, 'A rider is not assigned to this order yet')
    }
    const message = await postOrderMessage({
      orderId: order.id,
      orderNumber: order.number,
      senderRole: 'customer',
      senderName: order.customer.name || req.user!.name,
      body: body.body,
      customerId: order.customerId,
      riderId: order.riderId,
      riderUserId: order.rider?.userId,
    })
    res.status(201).json({ message })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Type a short message') : error)
  }
})

customerOrderRouter.get('/:number/receipt', async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { number: req.params.number, customerId: req.user!.id },
      include: { items: true, charges: true, store: true, rider: true, paymentTransaction: true },
    })
    if (!order) throw new HttpError(404, 'Order not found')
    const detail = mapOrderDetail(order)
    let related: ReturnType<typeof mapOrderDetail>[] = []
    if (order.checkoutGroupId) {
      const siblings = await prisma.order.findMany({
        where: {
          checkoutGroupId: order.checkoutGroupId,
          customerId: req.user!.id,
          NOT: { id: order.id },
        },
        include: { items: true, charges: true, store: true, rider: true, paymentTransaction: true },
        orderBy: { createdAt: 'asc' },
      })
      related = siblings.map(mapOrderDetail)
    }
    const html = receiptHtml(detail, related)
    const format = String(req.query.format ?? 'json')
    if (format === 'html') {
      res.type('html').send(html)
      return
    }
    const all = [detail, ...related]
    res.json({
      ...detail,
      relatedOrders: related,
      combinedTotal: Math.round(all.reduce((sum, row) => sum + row.total, 0) * 100) / 100,
      html,
      text: [
        `Hera Pharmacy receipt`,
        ...all.flatMap((row) => [
          `${row.id} · ${row.storeName}`,
          ...row.items.map((item) => `  ${item.name} ×${item.quantity} · $${item.lineTotal.toFixed(2)}`),
          `  Products $${row.productSubtotal.toFixed(2)} · Delivery $${row.deliveryCharge.toFixed(2)} · Service $${row.serviceCharge.toFixed(2)} · BFP $${row.bfpCharge.toFixed(2)}`,
          `  Store total $${row.total.toFixed(2)} · Payment ${row.paymentStatus}`,
        ]),
        `Final total $${all.reduce((sum, row) => sum + row.total, 0).toFixed(2)}`,
      ].join('\n'),
    })
  } catch (error) {
    next(error)
  }
})

customerOrderRouter.get('/:number', async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { number: req.params.number, customerId: req.user!.id },
      include: {
        items: true,
        charges: true,
        store: true,
        rider: true,
        paymentTransaction: true,
        activities: { orderBy: { createdAt: 'asc' } },
      },
    })
    if (!order) throw new HttpError(404, 'Order not found')
    res.json(mapOrderDetail(order))
  } catch (error) {
    next(error)
  }
})