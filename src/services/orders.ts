import type { ChargeRule, Prisma } from '@prisma/client'
import { calculateCharges, DeliveryRuleConfigurationError, type ChargeRuleInput } from '../domain/charges.js'
import { getStoreOrderEligibility } from '../domain/storeAvailability.js'
import { ENFORCE_OUT_OF_CITY_BLOCK, validateDeliveryCity } from '../domain/deliveryArea.js'
import { isExpired } from '../lib/expiry.js'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { notifyCustomer, notifyRiderInbox } from './notifications.js'
import { getDeliveryDistanceKm } from './distance.js'
import { formatAddressLine as formatCustomerLine } from './deliveryAddress.js'
import { geocodeStructuredAddress } from './geocode.js'
import { dec, money } from './money.js'
import { attachPaymentToCheckout, claimPaymentForCheckout } from './payments.js'
import { findAssignedRiderForStore } from './riders.js'

export type DeliveryType = 'standard' | 'express' | 'pickup'

export function toRule(rule: ChargeRule): ChargeRuleInput {
  return {
    kind: rule.kind,
    label: rule.label,
    mode: rule.mode,
    amount: money(rule.amount),
    percentBase: rule.percentBase,
    deliveryType: rule.deliveryType,
    minDistanceKm: rule.minDistanceKm,
    maxDistanceKm: rule.maxDistanceKm,
    perKmRate: rule.perKmRate != null ? money(rule.perKmRate) : null,
    active: rule.active,
  }
}

type VerifiedItem = { name?: string; strength?: string; quantity?: string; sku?: string }

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
  addressId?: string
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
  const storeEligibility = getStoreOrderEligibility(store)
  if (!storeEligibility.eligible) {
    throw new HttpError(
      400,
      storeEligibility.reason ?? 'This store is not accepting app orders right now',
      'STORE_NOT_ACCEPTING_ORDERS',
    )
  }


  let deliveryDistanceKm: number | null = null
  let resolvedAddressLine = ''

  if (input.deliveryType !== 'pickup') {
    if (!input.customerId || !input.addressId) {
      throw new HttpError(400, 'Select a saved delivery address')
    }

    const address = await prisma.customerAddress.findFirst({
      where: { id: input.addressId, customerId: input.customerId },
    })

    if (!address) {
      throw new HttpError(400, 'Selected delivery address was not found')
    }

    // Show only what the customer entered — do not append geocoded state/country
    // (Nominatim often returns local-script names the user never typed).
    resolvedAddressLine =
      formatCustomerLine({
        houseNo: address.houseNo,
        street: address.street,
        area: address.subCity,
        city: address.city,
        landmark: address.landmark,
        line: address.line,
      }) || address.line

    let toLat = address.latitude
    let toLng = address.longitude

    if (toLat == null || toLng == null) {
      const geocoded = await geocodeStructuredAddress({
        street: address.street,
        subCity: address.subCity,
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        country: address.country,
        line: address.line,
      })
      if (geocoded) {
        toLat = geocoded.latitude
        toLng = geocoded.longitude
        await prisma.customerAddress.update({
          where: { id: address.id },
          data: { latitude: toLat, longitude: toLng },
        })
      }
    }

    if (
      toLat == null ||
      toLng == null ||
      store.mapLat == null ||
      store.mapLng == null
    ) {
      throw new HttpError(
        400,
        'GPS coordinates are missing. Update your delivery place using Search or Current Location.'
      )
    }

    deliveryDistanceKm = await getDeliveryDistanceKm({
      fromLat: store.mapLat,
      fromLng: store.mapLng,
      toLat,
      toLng,
    })

    const areaCheck = validateDeliveryCity({
      storeName: store.name,
      storeCity: store.city,
      storeAddress: store.address,
      storeCountry: store.country,
      maxDeliveryDistanceKm: store.maxDeliveryDistanceKm,
      customerCity: address.city,
      customerCountry: address.country,
      customerLine: address.line,
      distanceKm: deliveryDistanceKm,
    })

    if (ENFORCE_OUT_OF_CITY_BLOCK && !areaCheck.allowed) {
      throw new HttpError(
        400,
        areaCheck.reason || 'Sorry, we cannot take out-of-city delivery orders.',
        'OUT_OF_CITY',
      )
    }
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

  const rxLines = lines.filter((line) => line.product.rxRequired)
  if (input.enforceRx && rxLines.length) {
    if (!input.customerId) throw new HttpError(401, 'Sign in to order prescription medicines')
    const prescription = input.prescriptionNumber
      ? await prisma.prescription.findFirst({
          where: {
            number: input.prescriptionNumber,
            customerId: input.customerId,
            storeId: input.storeId,
            status: 'approved',
          },
        })
      : await prisma.prescription.findFirst({
          where: {
            customerId: input.customerId,
            storeId: input.storeId,
            status: 'approved',
          },
          orderBy: { updatedAt: 'desc' },
        })
    if (!prescription) {
      throw new HttpError(400, 'A pharmacist-verified prescription is required before checkout', 'RX_REQUIRED')
    }
    const verified = Array.isArray(prescription.verifiedItems)
      ? (prescription.verifiedItems as VerifiedItem[])
      : []
    const fallbackName = prescription.medicineName
    for (const line of rxLines) {
      const ok =
        matchesVerified(line.product.name, line.product.sku, verified) ||
        (fallbackName && line.product.name.toLowerCase().includes(fallbackName.toLowerCase()))
      if (!ok) {
        throw new HttpError(400, `${line.product.name} needs pharmacist verification before checkout`, 'RX_REQUIRED')
      }
    }
  }

  const rules = await prisma.chargeRule.findMany({ where: { storeId: input.storeId, active: true } })
  let charges: ReturnType<typeof calculateCharges>
  try {
    charges = calculateCharges(
      productSubtotal,
      input.deliveryType,
      rules.map(toRule),
      deliveryDistanceKm,
    )
  } catch (error) {
    if (error instanceof DeliveryRuleConfigurationError) {
      throw new HttpError(400, error.message, 'DELIVERY_RULE_NOT_CONFIGURED')
    }
    throw error
  }
  let discount = 0
  let promoLabel = ''
  if (input.promoCode?.trim()) {
    const promo = await prisma.promoCode.findFirst({
      where: { code: input.promoCode.trim().toUpperCase(), active: true },
    })
    if (!promo) throw new HttpError(400, 'Promo code is not valid')
    discount = money(promo.discount)
    promoLabel = promo.code
  }
  const total = Math.max(0, Math.round((charges.total - discount) * 100) / 100)
  return {
    lines,
    store,
    deliveryDistanceKm,
    resolvedAddressLine,
    charges: { ...charges, discount, total, promoCode: promoLabel || null },
  }
}

export async function placeOrder(input: {
  customerId: string
  customerEmail?: string
  storeId: string
  addressId?: string
  deliveryType: DeliveryType
  paymentLabel: string
  paymentStatus?: 'paid' | 'unpaid'
  paymentTransactionId?: string
  addressLine: string
  recipientName?: string
  recipientPhone?: string
  addressJson?: Prisma.InputJsonValue
  checkoutGroupId?: string
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
  const paymentStatus = input.paymentStatus === 'unpaid' ? 'unpaid' : 'paid'

  // Assign an active rider when available; otherwise leave waiting for assignment.
  let assignedRider: Awaited<ReturnType<typeof findAssignedRiderForStore>> = null
  if (input.deliveryType !== 'pickup') {
    assignedRider = await findAssignedRiderForStore(input.storeId)
  }

  const order = await prisma.$transaction(async (tx) => {
    for (const line of quoted.lines) {
      const updated = await tx.product.updateMany({
        where: { id: line.product.id, stock: { gte: line.quantity } },
        data: { stock: { decrement: line.quantity } },
      })
      if (updated.count !== 1) throw new HttpError(409, `${line.product.name} just sold out`)
    }
    const count = await tx.order.count()
    const number = `RX-${10480 + count + 1}`
    for (const line of quoted.lines) {
      const existingMove = await tx.stockMovement.findFirst({
        where: { orderNumber: number, productId: line.product.id, reason: 'order_fulfillment' },
      })
      if (existingMove) continue
      // Leave userId null for customer checkout â€” stock log is system/order driven, not a desk staff edit.
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
        checkoutGroupId: input.checkoutGroupId,
        paymentTransactionId: input.paymentTransactionId,
        riderId: assignedRider?.id ?? null,
        status: 'placed',
        paymentStatus,
        channel: 'Mobile app',
        deliveryType: input.deliveryType,
        paymentLabel: input.paymentLabel,
        addressLine:
          input.deliveryType === 'pickup'
            ? quoted.store.address
            : quoted.resolvedAddressLine || input.addressLine,
        recipientName: String(input.recipientName ?? '').trim(),
        recipientPhone: String(input.recipientPhone ?? '').trim(),
        addressJson: input.addressJson,
        deliveryDistanceKm: quoted.deliveryDistanceKm,
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
          create: [
            { label: 'Order placed', detail: input.deliveryType, actor: 'Customer' },
            ...(assignedRider
              ? [
                  {
                    label: 'Rider assigned',
                    detail: assignedRider.name,
                    actor: 'System',
                  },
                ]
              : input.deliveryType !== 'pickup'
                ? [
                    {
                      label: 'Waiting for rider assignment',
                      detail: 'A rider will be assigned soon',
                      actor: 'System',
                    },
                  ]
                : []),
          ],
        },
      },
      include: { items: true, charges: true, store: true, rider: true, activities: true },
    })

    // Pickup orders still surface on the pharmacy desk. Delivery orders notify
    // only the assigned rider for that pharmacy â€” not a global broadcast.
    if (input.deliveryType === 'pickup') {
      await tx.notice.create({
        data: {
          title: 'New pickup order',
          body: `${created.number} was placed at ${created.store.name}.`,
          at: 'Just now',
          page: 'orders',
        },
      })
    }

    return created
   }, { maxWait: 10000, timeout: 30000 })
  await notifyCustomer({
    customerId: input.customerId,
    type: 'order',
    title: 'Order placed',
    body: `${order.number} is confirmed at ${order.store.name}.`,
    data: { orderNumber: order.number, status: order.status },
  })

  if (assignedRider) {
    await notifyRiderInbox({
      riderId: assignedRider.id,
      userId: assignedRider.userId,
      type: 'order',
      title: 'New delivery order',
      body: `${order.number} at ${order.store.name} â€” confirm, pick up the medicine, then deliver to the customer.`,
      data: {
        orderNumber: order.number,
        storeId: order.storeId,
        status: order.status,
        action: 'confirm',
      },
    })
  }

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
  paymentStatus?: string
  checkoutGroupId?: string | null
  total: Prisma.Decimal
  discount: Prisma.Decimal
  deliveryType: string
  paymentLabel: string
  addressLine: string
  recipientName?: string | null
  recipientPhone?: string | null
  deliveryDistanceKm: number | null
  createdAt: Date
  productSubtotal: Prisma.Decimal
  deliveryCharge: Prisma.Decimal
  serviceCharge: Prisma.Decimal
  bfpCharge: Prisma.Decimal
  prescriptionNumber: string
  paymentTransaction?: {
    transactionId: string
    method: string
    status: string
    cardLast4: string
    cardBrand: string
    paidAt: Date | null
  } | null
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
  rider?: { id: string; name: string; phone: string; vehicle: string } | null
  activities?: Array<{ label: string; detail: string; actor: string; createdAt: Date }>
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
  const activities = (order.activities ?? [])
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => ({
      label: row.label,
      detail: row.detail,
      actor: row.actor,
      at: row.createdAt.toISOString(),
    }))
  const activityTime = (index: number) => {
    const row = activities[index]
    if (!row) return null
    return new Date(row.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  return {
    id: order.number,
    status: order.status,
    paymentStatus: order.paymentStatus ?? 'paid',
    checkoutGroupId: order.checkoutGroupId ?? null,
    total: money(order.total),
    discount: money(order.discount),
    deliveryType: order.deliveryType,
    paymentLabel: order.paymentLabel,
    transactionId: order.paymentTransaction?.transactionId ?? null,
    paymentMethod: order.paymentTransaction?.method ?? null,
    cardLast4: order.paymentTransaction?.cardLast4 || null,
    cardBrand: order.paymentTransaction?.cardBrand || null,
    paidAt: order.paymentTransaction?.paidAt?.toISOString() ?? null,
    addressLine: order.addressLine,
    recipientName: String(order.recipientName ?? '').trim() || null,
    recipientPhone: String(order.recipientPhone ?? '').trim() || null,
    deliveryDistanceKm: order.deliveryDistanceKm,
    storeName: order.store.name,
    storeAddress: order.store.address,
    openUntil: order.store.openUntil,
    storePhone: order.store.phone,
    riderName: order.rider?.name ?? null,
    riderPhone: order.rider?.phone ?? null,
    rider: order.rider
      ? {
          id: order.rider.id,
          name: order.rider.name,
          phone: order.rider.phone,
          vehicle: order.rider.vehicle,
        }
      : null,
    waitingForRider: !pickup && !order.rider,
    createdAt: order.createdAt.toISOString(),
    productSubtotal: money(order.productSubtotal),
    deliveryCharge: money(order.deliveryCharge),
    serviceCharge: money(order.serviceCharge),
    bfpCharge: money(order.bfpCharge),
    prescriptionNumber: order.prescriptionNumber || null,
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
    activities,
    steps: pickup
      ? [
          {
            id: 'confirmed',
            title: 'Order confirmed',
            completed: completed >= 1,
            timeLabel: activityTime(0) ?? undefined,
          },
          {
            id: 'packed',
            title: 'Preparing for pickup',
            completed: completed >= 2,
            timeLabel: activityTime(1) ?? undefined,
          },
          {
            id: 'ready',
            title: 'Ready for pickup',
            completed: completed >= 3,
            timeLabel: activityTime(2) ?? undefined,
          },
          {
            id: 'collected',
            title: 'Collected',
            completed: completed >= 4,
            timeLabel: activityTime(3) ?? undefined,
          },
        ]
      : [
          {
            id: 'confirmed',
            title: 'Order placed',
            completed: completed >= 1,
            timeLabel: activityTime(0) ?? undefined,
          },
          {
            id: 'packed',
            title: order.rider ? 'Rider assigned' : 'Waiting for rider assignment',
            completed: completed >= 2 || Boolean(order.rider),
            timeLabel: activityTime(1) ?? undefined,
          },
          {
            id: 'on_way',
            title: 'Picked up · On the way',
            completed: completed >= 3,
            timeLabel: activityTime(2) ?? undefined,
          },
          {
            id: 'delivered',
            title: 'Delivered',
            completed: completed >= 4,
            timeLabel: activityTime(3) ?? undefined,
          },
        ],
  }
}

function storeSectionHtml(detail: ReturnType<typeof mapOrderDetail>) {
  const rows = detail.items
    .map(
      (item) =>
        `<tr><td>${item.name}</td><td>${item.quantity}</td><td>$${item.unitPrice.toFixed(2)}</td><td>$${item.lineTotal.toFixed(2)}</td></tr>`,
    )
    .join('')
  return `<section style="margin:20px 0;padding-bottom:16px;border-bottom:1px solid #e5e5e5">
  <h2 style="margin:0 0 6px;font-size:18px">${detail.storeName}</h2>
  <p class="muted" style="margin:0 0 8px">${detail.id} · ${detail.storeAddress}</p>
  <table><thead><tr><th>Product</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
  <p>Products: $${detail.productSubtotal.toFixed(2)}<br/>Delivery: $${detail.deliveryCharge.toFixed(2)}<br/>Service: $${detail.serviceCharge.toFixed(2)}<br/>BFP: $${detail.bfpCharge.toFixed(2)}<br/>Discount: $${detail.discount.toFixed(2)}<br/><strong>Store total: $${detail.total.toFixed(2)}</strong></p>
  </section>`
}

export function receiptHtml(
  detail: ReturnType<typeof mapOrderDetail>,
  related: Array<ReturnType<typeof mapOrderDetail>> = [],
) {
  const stores = [detail, ...related.filter((row) => row.id !== detail.id)]
  const combinedTotal = Math.round(stores.reduce((sum, row) => sum + row.total, 0) * 100) / 100
  const splitNote =
    stores.length > 1
      ? `<p class="note"><strong>Multi-store checkout</strong> — ${stores.length} pharmacy orders in this receipt.</p>`
      : ''
  const recipient = [detail.recipientName, detail.recipientPhone].filter(Boolean).join(' · ')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt ${detail.id}</title>
  <style>
    :root{color-scheme:light}
    body{margin:0;background:#eeede9;color:#131315;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    .sheet{max-width:440px;margin:24px auto;background:#fff;border-radius:24px;padding:28px 24px;box-shadow:0 10px 30px rgba(17,17,17,.08)}
    .brand{display:flex;align-items:center;gap:12px;margin-bottom:18px}
    .mark{width:42px;height:42px;border-radius:14px;background:#171a18;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800}
    h1{margin:0;font-size:22px} .sub{color:#8a8a8e;font-size:13px;margin-top:2px}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}
    .cell{background:#f5f5f3;border-radius:14px;padding:12px}
    .label{font-size:11px;font-weight:700;color:#a0a0a4;text-transform:uppercase}
    .value{font-size:13px;font-weight:600;margin-top:4px;text-transform:capitalize}
    .addr{border:1px solid #e5e5e5;border-radius:14px;padding:12px;margin:12px 0}
    table{width:100%;border-collapse:collapse;margin:12px 0} th,td{padding:8px 0;text-align:left;border-bottom:1px solid #e5e5e5;font-size:13px}
    th{color:#a0a0a4;font-size:11px;text-transform:uppercase}
    .totals p{display:flex;justify-content:space-between;margin:6px 0;font-size:13px}
    .grand{margin-top:16px;background:#171a18;color:#fff;border-radius:16px;padding:16px;display:flex;justify-content:space-between;align-items:center}
    .grand strong{font-size:22px}
    .pill{display:inline-block;background:#e6f7f5;color:#1f9a8c;border-radius:999px;padding:6px 12px;font-size:12px;font-weight:700}
    .muted{color:#8a8a8e}.note{background:#e6f7f5;border-radius:12px;padding:10px 12px}
    .thanks{text-align:center;color:#8a8a8e;margin-top:18px;font-size:13px}
  </style></head>
  <body><div class="sheet">
    <div class="brand"><div class="mark">H</div><div><h1>Hera Pharmacy</h1><div class="sub">Official order receipt</div></div></div>
    <div class="meta">
      <div class="cell"><div class="label">Date</div><div class="value">${new Date(detail.createdAt).toLocaleString()}</div></div>
      <div class="cell"><div class="label">Payment</div><div class="value">${detail.paymentLabel} · ${detail.paymentStatus}${detail.transactionId ? ` · ${detail.transactionId}` : ''}</div></div>
    </div>
    <div class="addr">
      <div class="label">${detail.deliveryType === 'pickup' ? 'Pickup' : 'Deliver to'}</div>
      ${recipient ? `<div class="value">${recipient}</div>` : ''}
      <div class="muted" style="margin-top:4px">${detail.addressLine || 'Store pickup'}</div>
    </div>
    ${splitNote}
    ${stores.map(storeSectionHtml).join('')}
    <div class="grand"><span class="muted" style="color:rgba(255,255,255,.75)">Final total</span><strong>$${combinedTotal.toFixed(2)}</strong></div>
    <p class="thanks">Thank you for choosing Hera</p>
  </div></body></html>`
}

async function resolveCustomerAddressId(customerId: string, addressId?: string) {
  if (addressId) {
    const match = await prisma.customerAddress.findFirst({
      where: { id: addressId, customerId },
      select: { id: true },
    })
    if (match) return match.id
  }
  const fallback = await prisma.customerAddress.findFirst({
    where: { customerId },
    orderBy: [{ isDefault: 'desc' }, { label: 'asc' }],
    select: { id: true },
  })
  return fallback?.id
}

export async function planCheckoutSplit(input: {
  customerId: string
  deliveryType: DeliveryType
  items: { productId: string; quantity: number }[]
  promoCode?: string
  prescriptionNumber?: string
  addressId?: string
}) {
  if (!input.items.length) throw new HttpError(400, 'Cart is empty', 'EMPTY_CART')
  const addressId =
    input.deliveryType === 'pickup' ? undefined : await resolveCustomerAddressId(input.customerId, input.addressId)
  if (input.deliveryType !== 'pickup' && !addressId) {
    throw new HttpError(400, 'Select a saved delivery address')
  }
  const products = await prisma.product.findMany({
    where: { id: { in: input.items.map((item) => item.productId) } },
    include: { store: true },
  })
  const byId = new Map(products.map((product) => [product.id, product]))
  const groups = new Map<string, { productId: string; quantity: number }[]>()
  for (const item of input.items) {
    const product = byId.get(item.productId)
    if (!product) throw new HttpError(400, 'A product in the cart was removed and cannot be ordered')
    const list = groups.get(product.storeId) ?? []
    list.push(item)
    groups.set(product.storeId, list)
  }

  const storePlans = []
  for (const [storeId, items] of groups) {
    const quoted = await quoteOrder({
      storeId,
      addressId,
      deliveryType: input.deliveryType,
      items,
      promoCode: input.promoCode,
      prescriptionNumber: input.prescriptionNumber,
      customerId: input.customerId,
      enforceRx: false,
    })
    storePlans.push({
      storeId,
      storeName: quoted.store.name,
      storeAddress: quoted.store.address,
      items: quoted.lines.map((line) => ({
        productId: line.product.id,
        name: line.product.name,
        sku: line.product.sku,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
      })),
      ...quoted.charges,
      etaMinutes: input.deliveryType === 'express' ? 30 : input.deliveryType === 'pickup' ? 20 : 60,
    })
  }

  const combinedTotal = Math.round(storePlans.reduce((sum, plan) => sum + plan.total, 0) * 100) / 100
  return {
    split: storePlans.length > 1,
    stores: storePlans,
    combinedTotal,
    message:
      storePlans.length > 1
        ? 'Your cart ships from more than one pharmacy. Confirm the split to place both orders together.'
        : null,
  }
}

export async function placeMultiStoreCheckout(input: {
  customerId: string
  customerEmail?: string
  idempotencyKey: string
  deliveryType: DeliveryType
  paymentLabel: string
  paymentStatus?: 'paid' | 'unpaid'
  paymentTransactionId?: string
  recipientName: string
  recipientPhone: string
  addressLine: string
  addressId?: string
  addressJson?: Prisma.InputJsonValue
  items: { productId: string; quantity: number }[]
  promoCode?: string
  prescriptionNumber?: string
  confirmSplit?: boolean
}) {
  const existing = await prisma.checkoutGroup.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: {
      orders: {
        include: {
          items: true,
          charges: true,
          store: true,
          rider: true,
          paymentTransaction: true,
        },
      },
      paymentTransaction: true,
    },
  })
  if (existing) {
    return {
      checkoutGroupId: existing.id,
      orders: existing.orders,
      combinedTotal: existing.orders.reduce((sum, order) => sum + money(order.total), 0),
      reused: true,
      paymentTransaction: existing.paymentTransaction,
    }
  }

  const addressId =
    input.deliveryType === 'pickup'
      ? undefined
      : await resolveCustomerAddressId(input.customerId, input.addressId)

  const plan = await planCheckoutSplit({
    customerId: input.customerId,
    deliveryType: input.deliveryType,
    items: input.items,
    promoCode: input.promoCode,
    prescriptionNumber: input.prescriptionNumber,
    addressId,
  })
  if (plan.split && !input.confirmSplit) {
    throw new HttpError(409, plan.message || 'Confirm the multi-store split before placing orders', 'CONFIRM_SPLIT')
  }
  if (input.deliveryType !== 'pickup' && !input.addressLine.trim()) {
    throw new HttpError(400, 'Add a delivery address')
  }
  if (!input.recipientName.trim() || !input.recipientPhone.trim()) {
    throw new HttpError(400, 'Add recipient name and phone number')
  }

  const isCod =
    /cash on delivery|^cod$/i.test(input.paymentLabel) || input.paymentStatus === 'unpaid'
  let paymentLabel = input.paymentLabel
  let paymentStatus: 'paid' | 'unpaid' = isCod ? 'unpaid' : input.paymentStatus === 'unpaid' ? 'unpaid' : 'paid'
  let paymentTransactionId: string | undefined

  if (input.paymentTransactionId) {
    const claimed = await claimPaymentForCheckout({
      customerId: input.customerId,
      paymentTransactionId: input.paymentTransactionId,
      expectedAmount: plan.combinedTotal,
      paymentLabel: input.paymentLabel,
    })
    paymentTransactionId = claimed.txn.id
    paymentLabel = claimed.paymentLabel
    paymentStatus = 'paid'
  }

  const group = await prisma.checkoutGroup.create({
    data: {
      customerId: input.customerId,
      idempotencyKey: input.idempotencyKey,
      deliveryType: input.deliveryType,
      paymentLabel,
      recipientName: input.recipientName.trim(),
      recipientPhone: input.recipientPhone.trim(),
      addressLine: input.addressLine,
      addressJson: input.addressJson,
    },
  })

  const orders = []
  try {
    for (const storePlan of plan.stores) {
      const order = await placeOrder({
        customerId: input.customerId,
        customerEmail: input.customerEmail,
        storeId: storePlan.storeId,
        addressId,
        deliveryType: input.deliveryType,
        paymentLabel,
        paymentStatus,
        paymentTransactionId,
        addressLine: input.addressLine,
        recipientName: input.recipientName,
        recipientPhone: input.recipientPhone,
        addressJson: input.addressJson,
        checkoutGroupId: group.id,
        items: storePlan.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        promoCode: input.promoCode,
        prescriptionNumber: input.prescriptionNumber,
      })
      orders.push(order)
    }
  } catch (error) {
    // Leave a successful simulated payment reusable when no orders were created.
    if (orders.length === 0) {
      await prisma.checkoutGroup.delete({ where: { id: group.id } }).catch(() => undefined)
    }
    throw error
  }

  if (paymentTransactionId) {
    await attachPaymentToCheckout({
      paymentTransactionId,
      checkoutGroupId: group.id,
      orderNumbers: orders.map((order) => order.number),
    })
  }

  const paymentTransaction = paymentTransactionId
    ? await prisma.paymentTransaction.findUnique({ where: { id: paymentTransactionId } })
    : null

  return {
    checkoutGroupId: group.id,
    orders,
    combinedTotal: Math.round(orders.reduce((sum, order) => sum + money(order.total), 0) * 100) / 100,
    reused: false,
    paymentTransaction,
  }
}

export type Tx = Prisma.TransactionClient

