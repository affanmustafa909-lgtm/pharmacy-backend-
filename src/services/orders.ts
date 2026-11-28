import type { ChargeRule, Prisma } from '@prisma/client'
import { calculateCharges, type ChargeRuleInput } from '../domain/charges.js'
import { isExpired } from '../lib/expiry.js'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { notifyCustomer } from './notifications.js'
import { dec, money } from './money.js'
import { assertPromoUsable } from './promos.js'

export type DeliveryType = 'standard' | 'express' | 'pickup'

export function toRule(rule: ChargeRule): ChargeRuleInput {
  return {
    kind: rule.kind,
    label: rule.label,
    mode: rule.mode,
    amount: money(rule.amount),
    percentBase: rule.percentBase,
    deliveryType: rule.deliveryType,
    active: rule.active,
  }
}

type VerifiedItem = { name?: string; strength?: string; quantity?: string; sku?: string; approvedQty?: number }

function matchesVerified(productName: string, sku: string, items: VerifiedItem[]) {
  const name = productName.toLowerCase()
  return items.some((item) => {
    if (item.sku && item.sku.toLowerCase() === sku.toLowerCase()) return true
    const itemName = String(item.name ?? '').toLowerCase()
    return itemName && (name.includes(itemName) || itemName.includes(name))
  })
}

export async function quoteOrder(input: {
  storeId: string
  deliveryType: DeliveryType
  items: { productId: string; quantity: number }[]
  promoCode?: string
  prescriptionNumber?: string
  customerId?: string
  enforceRx?: boolean
}) {
  if (!input.items?.length) throw new HttpError(400, 'Cart is empty', 'EMPTY_CART')
  const store = await prisma.store.findUnique({ where: { id: input.storeId } })
  if (!store) throw new HttpError(404, 'Store not found')
  if (store.status !== 'active' || !store.isOpen || !store.acceptingOrders) {
    throw new HttpError(400, 'This store is not accepting app orders right now')
  }

  const products = await prisma.product.findMany({
    where: { id: { in: input.items.map((item) => item.productId) } },
  })
  const byId = new Map(products.map((product) => [product.id, product]))
  let productSubtotal = 0
  const lines = input.items.map((item) => {
    const product = byId.get(item.productId)
    if (!product) throw new HttpError(400, 'A product in the cart was removed and cannot be ordered')
    if (product.held || !product.onlineSale || !product.published) {
      throw new HttpError(400, `${product.name} is unavailable`)
    }
    if (product.storeId !== input.storeId) throw new HttpError(400, 'All products in one order must come from the same store')
    if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new HttpError(400, 'Quantity must be at least 1')
    if (isExpired(product.expiry)) throw new HttpError(400, `${product.name} has expired and cannot be sold`, 'EXPIRED')
    if (product.stock <= 0) {
      throw new HttpError(400, `${product.name} is out of stock`, 'OUT_OF_STOCK')
    }
    if (product.stock < item.quantity) {
      throw new HttpError(400, `${product.name} does not have enough stock`, 'OUT_OF_STOCK')
    }
    const unitPrice = money(product.price)
    const lineTotal = Math.round(unitPrice * item.quantity * 100) / 100
    productSubtotal += lineTotal
    return { product, quantity: item.quantity, unitPrice, lineTotal }
  })

  const rxLines = lines.filter((line) => line.product.rxRequired || line.product.controlled)
  let controlledPrescriptionId: string | null = null
  if (input.enforceRx && rxLines.length) {
    if (!input.customerId) throw new HttpError(401, 'Sign in to order prescription medicines')
    const prescription = input.prescriptionNumber
      ? await prisma.prescription.findFirst({
          where: { number: input.prescriptionNumber, customerId: input.customerId, storeId: input.storeId, status: 'approved' },
        })
      : await prisma.prescription.findFirst({
          where: { customerId: input.customerId, storeId: input.storeId, status: 'approved' },
          orderBy: { updatedAt: 'desc' },
        })
    if (!prescription) {
      throw new HttpError(400, 'A pharmacist-verified prescription is required before checkout', 'RX_REQUIRED')
    }
    const verified = Array.isArray(prescription.verifiedItems) ? (prescription.verifiedItems as VerifiedItem[]) : []
    const fallbackName = prescription.medicineName
    const controlledLines = lines.filter((line) => line.product.controlled)
    for (const line of rxLines) {
      const ok =
        matchesVerified(line.product.name, line.product.sku, verified) ||
        (fallbackName && line.product.name.toLowerCase().includes(fallbackName.toLowerCase()))
      if (!ok) {
        throw new HttpError(400, `${line.product.name} needs pharmacist verification before checkout`, 'RX_REQUIRED')
      }
    }
    if (controlledLines.length) {
      // ADM-02: stricter rules for controlled medicines.
      if (!prescription.prescriber.trim()) {
        throw new HttpError(400, 'This prescription has no prescriber name. Controlled medicines cannot be sold.', 'RX_CONTROLLED')
      }
      if (prescription.orderNumber) {
        throw new HttpError(400, 'This prescription was already used for an order. Controlled medicines need a new prescription.', 'RX_USED')
      }
      const reviewed = prescription.reviewedAt ?? prescription.submittedAt
      if (Date.now() - reviewed.getTime() > 30 * 86400000) {
        throw new HttpError(400, 'This prescription is older than 30 days. Upload a new one.', 'RX_OLD')
      }
      for (const line of controlledLines) {
        const item = verified.find(
          (v) =>
            (v.sku && v.sku.toLowerCase() === line.product.sku.toLowerCase()) ||
            String(v.name ?? '').toLowerCase() === line.product.name.toLowerCase(),
        )
        const allowedQty = item?.approvedQty ?? (Number(item?.quantity) || 0)
        if (!item || allowedQty < 1) {
          throw new HttpError(400, `${line.product.name} is not on the approved prescription`, 'RX_CONTROLLED')
        }
        if (line.quantity > allowedQty) {
          throw new HttpError(400, `${line.product.name}: prescription allows only ${allowedQty}`, 'RX_CONTROLLED')
        }
      }
      controlledPrescriptionId = prescription.id
    }
  }

  const rules = await prisma.chargeRule.findMany({ where: { storeId: input.storeId, active: true } })
  const charges = calculateCharges(productSubtotal, input.deliveryType, rules.map(toRule))
  let discount = 0
  let promoLabel = ''
  let promoId: string | null = null
  if (input.promoCode?.trim()) {
    const promo = await prisma.promoCode.findFirst({
      where: { code: input.promoCode.trim().toUpperCase() },
    })
    if (!promo) throw new HttpError(400, 'Promo code is not valid')
    await assertPromoUsable(promo, { storeId: input.storeId, customerId: input.customerId })
    // The discount can never be bigger than the bill.
    discount = Math.min(money(promo.discount), charges.total)
    promoLabel = promo.code
    promoId = promo.id
  }
  const total = Math.max(0, Math.round((charges.total - discount) * 100) / 100)
  return {
    lines,
    store,
    promoId,
    controlledPrescriptionId,
    charges: { ...charges, discount, total, promoCode: promoLabel || null },
  }
}

export async function placeOrder(input: {
  customerId: string
  customerEmail?: string
  storeId: string
  deliveryType: DeliveryType
  paymentLabel: string
  addressLine: string
  items: { productId: string; quantity: number }[]
  promoCode?: string
  prescriptionNumber?: string
}) {
  if (input.deliveryType !== 'pickup' && !input.addressLine.trim()) {
    throw new HttpError(400, 'Add a delivery address')
  }
  let customer = await prisma.user.findUnique({ where: { id: input.customerId } })
  if ((!customer || customer.role !== 'CUSTOMER') && input.customerEmail) {
    customer = await prisma.user.findFirst({
      where: { email: input.customerEmail.toLowerCase(), role: 'CUSTOMER' },
    })
  }
  if (!customer || customer.role !== 'CUSTOMER') {
    throw new HttpError(401, 'Sign in again to place this order')
  }
  input.customerId = customer.id
  const quoted = await quoteOrder({ ...input, enforceRx: true })
  const order = await prisma.$transaction(async (tx) => {
    for (const line of quoted.lines) {
      const updated = await tx.product.updateMany({
        where: { id: line.product.id, stock: { gte: line.quantity } },
        data: { stock: { decrement: line.quantity } },
      })
      if (updated.count !== 1) throw new HttpError(409, `${line.product.name} just sold out`)
    }
    // ADM-05: lock the promo row so two customers cannot both take the last use.
    if (quoted.promoId) {
      await tx.$queryRaw`SELECT id FROM "PromoCode" WHERE id = ${quoted.promoId} FOR UPDATE`
      const promo = await tx.promoCode.findUnique({ where: { id: quoted.promoId } })
      if (!promo) throw new HttpError(400, 'Promo code is not valid')
      const now = new Date()
      if (!promo.active || (promo.endsAt && now > promo.endsAt) || (promo.startsAt && now < promo.startsAt)) {
        throw new HttpError(400, 'This promo is no longer available', 'PROMO_EXPIRED')
      }
      if (promo.maxUses != null) {
        const used = await tx.promoRedemption.count({ where: { promoId: promo.id, order: { status: { not: 'cancelled' } } } })
        if (used >= promo.maxUses) throw new HttpError(400, 'This promo has reached its usage limit', 'PROMO_LIMIT')
      }
      if (promo.perCustomerLimit != null) {
        const mine = await tx.promoRedemption.count({
          where: { promoId: promo.id, customerId: input.customerId, order: { status: { not: 'cancelled' } } },
        })
        if (mine >= promo.perCustomerLimit) throw new HttpError(400, 'You have already used this promo the maximum number of times', 'PROMO_CUSTOMER_LIMIT')
      }
    }
    const count = await tx.order.count()
    const number = `RX-${10480 + count + 1}`
    for (const line of quoted.lines) {
      const existingMove = await tx.stockMovement.findFirst({
        where: { orderNumber: number, productId: line.product.id, reason: 'order_fulfillment' },
      })
      if (existingMove) continue
      // Leave userId null for customer checkout — stock log is system/order driven, not a desk staff edit.
      await tx.stockMovement.create({
        data: {
          productId: line.product.id,
          storeId: input.storeId,
          quantity: -line.quantity,
          reason: 'order_fulfillment',
          orderNumber: number,
          note: 'Order placement',
          userId: null,
        },
      })
      const batches = await tx.inventoryBatch.findMany({
        where: { productId: line.product.id },
        orderBy: { expiry: 'asc' },
      })
      let remaining = line.quantity
      for (const batch of batches) {
        if (remaining <= 0) break
        if (isExpired(batch.expiry) || batch.quantity <= 0) continue
        const take = Math.min(batch.quantity, remaining)
        await tx.inventoryBatch.update({ where: { id: batch.id }, data: { quantity: { decrement: take } } })
        remaining -= take
      }
    }
    const created = await tx.order.create({
      data: {
        number,
        customerId: input.customerId,
        storeId: input.storeId,
        status: 'placed',
        paymentStatus: 'paid',
        channel: 'Mobile app',
        deliveryType: input.deliveryType,
        paymentLabel: input.paymentLabel,
        addressLine: input.deliveryType === 'pickup' ? quoted.store.address : input.addressLine,
        prescriptionNumber: input.prescriptionNumber ?? '',
        productSubtotal: dec(quoted.charges.productSubtotal),
        deliveryCharge: dec(quoted.charges.deliveryCharge),
        serviceCharge: dec(quoted.charges.serviceCharge),
        bfpCharge: dec(quoted.charges.bfpCharge),
        discount: dec(quoted.charges.discount),
        total: dec(quoted.charges.total),
        items: {
          create: quoted.lines.map((line) => ({
            productId: line.product.id,
            name: line.product.name,
            sku: line.product.sku,
            unitPrice: dec(line.unitPrice),
            quantity: line.quantity,
            lineTotal: dec(line.lineTotal),
          })),
        },
        charges: {
          create: quoted.charges.lines.map((line) => ({
            kind: line.kind,
            label: line.label,
            mode: line.mode,
            rate: dec(line.rate),
            percentBase: line.percentBase,
            baseAmount: dec(line.baseAmount),
            amount: dec(line.amount),
          })),
        },
        activities: {
          create: [{ label: 'Order placed', detail: input.deliveryType, actor: 'Customer' }],
        },
      },
      include: { items: true, charges: true, store: true },
    })
    if (quoted.promoId && quoted.charges.discount > 0) {
      await tx.promoRedemption.create({
        data: { promoId: quoted.promoId, orderId: created.id, customerId: input.customerId, discount: dec(quoted.charges.discount) },
      })
    }
    if (quoted.controlledPrescriptionId) {
      await tx.prescription.update({ where: { id: quoted.controlledPrescriptionId }, data: { orderNumber: number } })
      await tx.auditLog.create({
        data: {
          storeId: input.storeId,
          action: 'controlled.sale',
          detail: `${number}: ${quoted.lines.filter((l) => l.product.controlled).map((l) => `${l.product.name} x${l.quantity}`).join(', ')}`,
          meta: { order: number, prescriptionId: quoted.controlledPrescriptionId },
        },
      })
    }
    await tx.notice.create({
      data: {
        title: 'New app order',
        body: `${created.number} was placed at ${created.store.name}.`,
        at: 'Just now',
        page: 'orders',
      },
    })
    return created
   }, { maxWait: 10000, timeout: 30000 })
  await notifyCustomer({
    customerId: input.customerId,
    type: 'order',
    title: 'Order placed',
    body: `${order.number} is confirmed at ${order.store.name}.`,
    data: { orderNumber: order.number, status: order.status },
  })
  return order
}

export async function recheckBuyAgain(input: {
  customerId: string
  orderNumber: string
  storeId?: string
}) {
  const order = await prisma.order.findFirst({
    where: { number: input.orderNumber, customerId: input.customerId },
    include: { items: true, store: true },
  })
  if (!order) throw new HttpError(404, 'Order not found')
  const targetStoreId = input.storeId || order.storeId
  const lines = []
  for (const item of order.items) {
    const product = await prisma.product.findFirst({
      where: {
        storeId: targetStoreId,
        sku: item.sku,
        held: false,
        onlineSale: true,
      },
      include: { store: true },
    })
    if (!product) {
      lines.push({
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        available: false,
        reason: 'Not available at this store',
      })
      continue
    }
    const expired = isExpired(product.expiry)
    const enough = product.stock >= item.quantity
    lines.push({
      sku: item.sku,
      name: product.name,
      quantity: item.quantity,
      productId: product.id,
      storeId: product.storeId,
      price: money(product.price),
      previousPrice: money(item.unitPrice),
      stock: product.stock,
      rxRequired: product.rxRequired,
      available: !expired && enough,
      reason: expired ? 'Expired' : enough ? null : 'Not enough stock',
    })
  }
  return { orderNumber: order.number, storeId: targetStoreId, lines }
}

export function mapOrderDetail(order: {
  number: string
  status: string
  total: Prisma.Decimal
  discount: Prisma.Decimal
  deliveryType: string
  paymentLabel: string
  addressLine: string
  createdAt: Date
  productSubtotal: Prisma.Decimal
  deliveryCharge: Prisma.Decimal
  serviceCharge: Prisma.Decimal
  bfpCharge: Prisma.Decimal
  prescriptionNumber: string
  items: Array<{
    name: string
    sku: string
    unitPrice: Prisma.Decimal
    quantity: number
    lineTotal: Prisma.Decimal
    productId: string | null
  }>
  charges?: Array<{
    kind: string
    label: string
    amount: Prisma.Decimal
    mode: string
    rate: Prisma.Decimal
    percentBase: string | null
  }>
  store: { name: string; address: string; openUntil: string; phone: string }
  rider?: { name: string; phone: string; vehicle: string } | null
}) {
  const pickup = order.deliveryType === 'pickup'
  const pickupRank: Record<string, number> = {
    placed: 1,
    preparing: 2,
    ready_for_pickup: 3,
    collected: 4,
    cancelled: 0,
  }
  const deliveryRank: Record<string, number> = {
    placed: 1,
    preparing: 2,
    out_for_delivery: 3,
    delivered: 4,
    cancelled: 0,
  }
  const completed = (pickup ? pickupRank : deliveryRank)[order.status] ?? 1
  return {
    id: order.number,
    status: order.status,
    total: money(order.total),
    discount: money(order.discount),
    deliveryType: order.deliveryType,
    paymentLabel: order.paymentLabel,
    addressLine: order.addressLine,
    storeName: order.store.name,
    storeAddress: order.store.address,
    openUntil: order.store.openUntil,
    storePhone: order.store.phone,
    createdAt: order.createdAt.toISOString(),
    productSubtotal: money(order.productSubtotal),
    deliveryCharge: money(order.deliveryCharge),
    serviceCharge: money(order.serviceCharge),
    bfpCharge: money(order.bfpCharge),
    prescriptionNumber: order.prescriptionNumber || null,
    rider: order.rider ? { name: order.rider.name, phone: order.rider.phone, vehicle: order.rider.vehicle } : null,
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
    items: order.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      sku: item.sku,
      unitPrice: money(item.unitPrice),
      quantity: item.quantity,
      lineTotal: money(item.lineTotal),
    })),
    charges: (order.charges ?? []).map((charge) => ({
      kind: charge.kind,
      label: charge.label,
      amount: money(charge.amount),
      mode: charge.mode,
      rate: money(charge.rate),
      percentBase: charge.percentBase,
    })),
    steps: pickup
      ? [
          { id: 'confirmed', title: 'Order confirmed', completed: completed >= 1 },
          { id: 'packed', title: 'Preparing for pickup', completed: completed >= 2 },
          { id: 'ready', title: 'Ready for pickup', completed: completed >= 3 },
          { id: 'collected', title: 'Collected', completed: completed >= 4 },
        ]
      : [
          { id: 'confirmed', title: 'Order confirmed', completed: completed >= 1 },
          { id: 'packed', title: 'Packed at pharmacy', completed: completed >= 2 },
          { id: 'on_way', title: 'On the way', completed: completed >= 3 },
          { id: 'delivered', title: 'Delivered', completed: completed >= 4 },
        ],
  }
}

export function receiptHtml(detail: ReturnType<typeof mapOrderDetail>) {
  const rows = detail.items
    .map(
      (item) =>
        `<tr><td>${item.name}</td><td>${item.quantity}</td><td>$${item.unitPrice.toFixed(2)}</td><td>$${item.lineTotal.toFixed(2)}</td></tr>`,
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${detail.id}</title>
  <style>body{font-family:Georgia,serif;color:#131315;padding:24px}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{border-bottom:1px solid #e5e5e5;padding:8px;text-align:left}.muted{color:#8a8a8e}</style></head>
  <body><h1>Hera Pharmacy</h1><p class="muted">${detail.id} · ${new Date(detail.createdAt).toLocaleString()}</p>
  <p>${detail.storeName}<br/>${detail.storeAddress}</p>
  <table><thead><tr><th>Product</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
  <p>Products: $${detail.productSubtotal.toFixed(2)}<br/>Delivery: $${detail.deliveryCharge.toFixed(2)}<br/>Service: $${detail.serviceCharge.toFixed(2)}<br/>BFP: $${detail.bfpCharge.toFixed(2)}<br/>Discount: $${detail.discount.toFixed(2)}<br/><strong>Total: $${detail.total.toFixed(2)}</strong></p>
  <p class="muted">${detail.deliveryType} · ${detail.paymentLabel}</p></body></html>`
}

export type Tx = Prisma.TransactionClient
