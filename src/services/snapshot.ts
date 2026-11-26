import type { AuthUser } from '../lib/auth.js'
import { isExpired, parseExpiry } from '../lib/expiry.js'
import { prisma } from '../lib/prisma.js'
import { accessibleStoreIds, loadStoreAccess } from './permissions.js'
import { normalizeMobileConfig } from './mobileConfig.js'
import { money } from './money.js'
import { DEFAULT_MAX_DELIVERY_DISTANCE_KM, resolveStoreCity } from '../domain/deliveryArea.js'

const TIERS = {
  Silver: [
    'Refill reminder 3 days before a dose runs out',
    'Standard pharmacist chat during store hours',
    'Free standard delivery over $35',
  ],
  Gold: [
    '1.5 adherence points per filled prescription',
    'Priority pharmacist chat under 15 minutes',
    '2 same-day delivery credits each month',
    'No service fee on refills up to $150',
  ],
  Platinum: [
    '2 points per filled prescription',
    'Dedicated pharmacist for chronic patients',
    'Unlimited same-day delivery in Manhattan',
    'Household profiles for family reminders',
  ],
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}`
}

function delta(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : 100
  return Math.round(((current - previous) / previous) * 1000) / 10
}

function emptyMetrics() {
  return {
    netSales: 0,
    salesDelta: 0,
    ordersToday: 0,
    ordersDelta: 0,
    refunds: 0,
    refundsDelta: 0,
    rxRevenue: 0,
    rxDelta: 0,
    retailRevenue: 0,
    retailDelta: 0,
    dispensed: 0,
    capacity: 1500,
  }
}

export async function buildSnapshot(actor: AuthUser) {
  const access = await loadStoreAccess(actor)
  const assignedStoreIds = access.map((item) => item.storeId)
  const allowedIds = await accessibleStoreIds(actor)
  const storeWhere = allowedIds ? { id: { in: allowedIds.length ? allowedIds : ['__none__'] } } : {}
  const storeFilter = allowedIds ? { storeId: { in: allowedIds.length ? allowedIds : ['__none__'] } } : {}
  const primaryAccess = access[0]
  const [stores, products, orders, prescriptions, customers, reminders, campaigns, history, threads, notices, payouts, setting, promos, batches] =
    await Promise.all([
      prisma.store.findMany({
        where: storeWhere,
        include: {
          chargeRules: { where: { active: true }, orderBy: [{ kind: 'asc' }, { label: 'asc' }] },
          deliveryOptions: true,
        },
        orderBy: { name: 'asc' },
      }),
      prisma.product.findMany({ where: storeFilter, include: { store: true }, orderBy: { name: 'asc' }, take: 200 }),
      prisma.order.findMany({
        where: storeFilter,
        include: {
          customer: true,
          store: true,
          rider: true,
          items: true,
          charges: true,
          paymentTransaction: true,
          activities: { orderBy: { createdAt: 'asc' } },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      prisma.prescription.findMany({ where: storeFilter, include: { store: true, reviewer: true }, orderBy: { submittedAt: 'desc' }, take: 100 }),
      prisma.user.findMany({
        where: { role: 'CUSTOMER' },
        include: {
          orders: { where: storeFilter },
          addresses: { orderBy: [{ isDefault: 'desc' }, { label: 'asc' }] },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.reminder.findMany({ orderBy: { medicine: 'asc' } }),
      prisma.campaign.findMany(),
      prisma.careEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.messageThread.findMany({ include: { customer: true, messages: { orderBy: { createdAt: 'asc' } } } }),
      prisma.notice.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.payout.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.setting.findUnique({ where: { id: 'default' } }),
      prisma.promoCode.findMany({ orderBy: { code: 'asc' } }),
      prisma.inventoryBatch.findMany({ where: storeFilter, take: 500 }),
    ])

  const customerLogins = customers.length
    ? await prisma.auditLog.findMany({
        where: {
          action: 'customer.login',
          actorId: { in: customers.map((customer) => customer.id) },
        },
        orderBy: { createdAt: 'desc' },
        distinct: ['actorId'],
        select: { actorId: true, createdAt: true },
      })
    : []

  const lastLoginByCustomer = new Map(
    customerLogins
      .filter((item) => item.actorId)
      .map((item) => [item.actorId!, item.createdAt.toISOString()]),
  )
  const now = new Date()
  const thisMonth = monthKey(now)
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const prevKey = monthKey(prev)
  const today = now.toDateString()

  const metrics: Record<string, ReturnType<typeof emptyMetrics>> = { all: emptyMetrics() }
  const chart: Record<string, { month: string; sales: number; returns: number }[]> = {}
  const monthLabels = Array.from({ length: 9 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (8 - index), 1)
    return { key: monthKey(date), month: date.toLocaleString('en-US', { month: 'short' }) }
  })
  for (const store of stores) {
    metrics[store.id] = { ...emptyMetrics(), capacity: 500 }
    chart[store.id] = monthLabels.map((item) => ({ month: item.month, sales: 0, returns: 0 }))
  }
  chart.all = monthLabels.map((item) => ({ month: item.month, sales: 0, returns: 0 }))

  const monthTotals = new Map<string, { sales: number; refunds: number }>()
  for (const order of orders) {
    const created = order.createdAt
    const key = monthKey(created)
    const total = money(order.total)
    const bucket = metrics[order.storeId] ?? metrics.all
    const cancelled = order.status === 'cancelled'
    if (!cancelled) {
      bucket.netSales += total
      metrics.all.netSales += total
      if (created.toDateString() === today) {
        bucket.ordersToday += total
        metrics.all.ordersToday += total
      }
      if (order.items.some((item) => item.name.toLowerCase().includes('loradine'))) {
        bucket.rxRevenue += total
        metrics.all.rxRevenue += total
      } else {
        bucket.retailRevenue += total
        metrics.all.retailRevenue += total
      }
      if (order.status === 'delivered') {
        bucket.dispensed += 1
        metrics.all.dispensed += 1
      }
    } else {
      bucket.refunds += total
      metrics.all.refunds += total
    }
    const current = monthTotals.get(`${order.storeId}:${key}`) ?? { sales: 0, refunds: 0 }
    if (cancelled) current.refunds += total
    else current.sales += total
    monthTotals.set(`${order.storeId}:${key}`, current)
    const allCurrent = monthTotals.get(`all:${key}`) ?? { sales: 0, refunds: 0 }
    if (cancelled) allCurrent.refunds += total
    else allCurrent.sales += total
    monthTotals.set(`all:${key}`, allCurrent)
    const series = chart[order.storeId]
    const point = series?.find((_item, index) => monthLabels[index]?.key === key)
    if (point) {
      if (cancelled) point.returns += Math.round(total)
      else point.sales += Math.round(total)
    }
    const allPoint = chart.all.find((_item, index) => monthLabels[index]?.key === key)
    if (allPoint) {
      if (cancelled) allPoint.returns += Math.round(total)
      else allPoint.sales += Math.round(total)
    }
  }

  for (const id of Object.keys(metrics)) {
    const current = monthTotals.get(`${id}:${thisMonth}`)?.sales ?? 0
    const previous = monthTotals.get(`${id}:${prevKey}`)?.sales ?? 0
    metrics[id].salesDelta = delta(current, previous)
    metrics[id].ordersDelta = metrics[id].salesDelta
    metrics[id].rxDelta = metrics[id].salesDelta
    metrics[id].retailDelta = metrics[id].salesDelta
    metrics[id].refundsDelta = delta(monthTotals.get(`${id}:${thisMonth}`)?.refunds ?? 0, monthTotals.get(`${id}:${prevKey}`)?.refunds ?? 0)
    metrics[id].netSales = Math.round(metrics[id].netSales * 100) / 100
    metrics[id].ordersToday = Math.round(metrics[id].ordersToday * 100) / 100
  }

  const initials = actor.name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase()
  const lowStockThreshold = setting?.lowStockThreshold ?? 12
  const pendingRx = prescriptions.filter((item) => item.status === 'pending' || item.status === 'needs_clearer_photo').length
  const lowStock = products.filter((product) => {
    const threshold = product.lowStockThreshold ?? product.store.lowStockThreshold ?? lowStockThreshold
    return product.stock > 0 && product.stock <= threshold
  }).length
   const expiryLimit = new Date()
  expiryLimit.setDate(expiryLimit.getDate() + 60)
  const expiringBatches = batches.filter((batch) => {
    if (batch.quantity <= 0 || isExpired(batch.expiry)) return false
    const expiryDate = parseExpiry(batch.expiry)
    return expiryDate !== null && expiryDate <= expiryLimit
  }).length
  const ordersTodayCount = orders.filter((order) => order.createdAt.toDateString() === today && order.status !== 'cancelled').length

  return {
    admin: {
      name: actor.name,
      firstName: actor.name.split(' ')[0] ?? actor.name,
      email: actor.email,
      role: actor.role === 'ADMIN' ? 'Pharmacy lead' : primaryAccess?.deskRole === 'STORE_MANAGER' ? 'Store manager' : 'Store staff',
      roleKey: actor.role,
      storeId: actor.storeId ?? primaryAccess?.storeId ?? null,
      deskRole: actor.role === 'ADMIN' ? 'OWNER' : primaryAccess?.deskRole,
      assignedStoreIds: actor.role === 'ADMIN' ? stores.map((store) => store.id) : assignedStoreIds,
      canChangePrice: actor.role === 'ADMIN' ? true : primaryAccess?.canChangePrice ?? false,
      canRefund: actor.role === 'ADMIN' ? true : primaryAccess?.canRefund ?? false,
      initials,
    },
    dashboardCounts: {
      pendingRx,
      lowStock,
      expiringBatches,
      ordersToday: ordersTodayCount,
    },
    metrics,
    chart,
    locations: stores.map((store) => ({
      pharmacyId: store.id,
      code: store.code,
      name: store.name.replace('Hera ', ''),
      revenue: Math.round(metrics[store.id]?.netSales ?? 0),
      delta: `${(metrics[store.id]?.salesDelta ?? 0) >= 0 ? '↑' : '↓'} ${Math.abs(metrics[store.id]?.salesDelta ?? 0)}% this month`,
      active: store.isOpen,
    })),
    orders: orders.slice(0, 50).map((order) => ({
      id: order.number,
      customerId: order.customerId,
      customerName: order.customer.name,
      customerEmail: order.customer.email,
      customerPhone: order.customer.phone,
      pharmacyId: order.storeId,
      pharmacyName: order.store.name,
      riderId: order.riderId,
      riderName: order.rider?.name ?? null,
      riderPhone: order.rider?.phone ?? null,
      itemSummary: order.items.map((item) => `${item.name} × ${item.quantity}`).join(', '),
      items: order.items.map((item) => ({
        name: item.name,
        sku: item.sku,
        unitPrice: money(item.unitPrice),
        quantity: item.quantity,
        lineTotal: money(item.lineTotal),
      })),
      total: money(order.total),
      status: order.status,
      paymentStatus: order.paymentStatus,
      channel: order.channel,
      deliveryType: order.deliveryType,
      deliveryDistanceKm: order.deliveryDistanceKm,
      paymentLabel: order.paymentLabel,
      transactionId: order.paymentTransaction?.transactionId ?? null,
      paymentMethod: order.paymentTransaction?.method ?? null,
      cardLast4: order.paymentTransaction?.cardLast4 || null,
      cardBrand: order.paymentTransaction?.cardBrand || null,
      paidAt: order.paymentTransaction?.paidAt?.toISOString() ?? null,
      addressLine: order.addressLine,
      prescriptionNumber: order.prescriptionNumber,
      cancelReason: order.cancelReason,
      refundReason: order.refundReason,
      refundAmount: money(order.refundAmount),
      createdAt: order.createdAt.toISOString(),
      productSubtotal: money(order.productSubtotal),
      deliveryCharge: money(order.deliveryCharge),
      serviceCharge: money(order.serviceCharge),
      bfpCharge: money(order.bfpCharge),
      discount: money(order.discount),
      activities: order.activities.map((activity) => ({
        id: activity.id,
        label: activity.label,
        detail: activity.detail,
        actor: activity.actor,
        createdAt: activity.createdAt.toISOString(),
      })),
      charges: order.charges.map((charge) => ({
        kind: charge.kind,
        label: charge.label,
        amount: money(charge.amount),
        mode: charge.mode,
        rate: money(charge.rate),
        percentBase: charge.percentBase,
      })),
    })),
    medicines: products.map((product) => ({
      id: product.id,
      storeId: product.storeId,
      storeName: product.store.name,
      name: product.name,
      brand: product.brand,
      genericName: product.genericName,
      strength: product.strength,
      category: product.category,
      price: money(product.price),
      unitLabel: product.unitLabel,
      sku: product.sku,
      stock: product.stock,
      batch: product.batch,
      expiry: product.expiry,
      held: product.held,
      onlineSale: product.onlineSale,
      published: product.published,
      outOfStock: product.stock <= 0,
      rxRequired: product.rxRequired,
      lowStockAlerts: product.lowStockAlerts,
      description: product.description,
      imageUrl: product.imageUrl,
    })),
    prescriptions: prescriptions.map((item) => ({
      id: item.number,
      customerId: item.customerId,
      customerName: item.customerName,
      medicineName: item.medicineName,
      prescriber: item.prescriber,
      pharmacyId: item.storeId,
      pharmacyName: item.store.name,
      status: item.status,
      uploadType: item.uploadType || 'prescription',
      quantity: item.quantity,
      submittedAt: item.submittedAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      notes: item.notes,
      imageUrl: item.imageUrl,
      imageReadable: item.imageReadable,
      scannedText: item.scannedText,
      detectedDetails:
        item.detectedDetails && typeof item.detectedDetails === 'object' ? item.detectedDetails : {},
      linkedProductId: item.linkedProductId ?? null,
      verifiedItems: Array.isArray(item.verifiedItems) ? item.verifiedItems : [],
      customerNote: item.customerNote,
      reviewer: item.reviewer?.name ?? '',
      reviewedAt: item.reviewedAt?.toISOString() ?? null,
      orderNumber: item.orderNumber || null,
    })),
    customers: customers.map((customer) => ({
      id: customer.id,
      lastLogin: lastLoginByCustomer.get(customer.id) ?? null,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      city: customer.city || customer.addresses[0]?.city || '',
      dateOfBirth: customer.dateOfBirth,
      gender: customer.gender,
      allergies: customer.allergies,
      addresses: customer.addresses.map((addr) => ({
        id: addr.id,
        label: addr.label,
        line: addr.line,
        street: addr.street,
        subCity: addr.subCity,
        city: addr.city,
        state: addr.state,
        country: addr.country,
        postalCode: addr.postalCode,
      })),
      orders: customer.orders.length,
      spend: customer.orders.reduce((sum, order) => sum + (order.status === 'cancelled' ? 0 : money(order.total)), 0),
      status: 'active',
      since: customer.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    })),
    pharmacies: stores.map((store) => ({
      id: store.id,
      code: store.code,
      name: store.name,
      address: store.address,
      city: resolveStoreCity(store),
      country: store.country || '',
      maxDeliveryDistanceKm: store.maxDeliveryDistanceKm ?? DEFAULT_MAX_DELIVERY_DISTANCE_KM,
      openUntil: store.openUntil,
      weeklyHours: store.weeklyHours,
      closedDays: store.closedDays,
      holidayHours: store.holidayHours,
      mapLat: store.mapLat,
      mapLng: store.mapLng,
      rating: store.rating,
      status: store.status,
      isOpen: store.isOpen,
      acceptingOrders: store.acceptingOrders,
      ordersToday: orders.filter((order) => order.storeId === store.id && order.createdAt.toDateString() === today && order.status !== 'cancelled').length,
      revenueToday: orders.filter((order) => order.storeId === store.id && order.createdAt.toDateString() === today && order.status !== 'cancelled').reduce((sum, order) => sum + money(order.total), 0),
      pharmacist: store.pharmacist,
      pharmacistUserId: store.pharmacistUserId,
      managerUserId: store.managerUserId,
      phone: store.phone,
      deliveryOptions: store.deliveryOptions.map((option) => ({
        id: option.id,
        type: option.type,
        label: option.label,
        available: option.available,
        fee: money(option.fee),
        etaMinutes: option.etaMinutes,
        deliveryArea: option.deliveryArea,
      })),
      fees: store.chargeRules.map((rule) => ({
        id: rule.id,
        kind: rule.kind,
        label: rule.label,
        mode: rule.mode,
        amount: money(rule.amount),
        percentBase: rule.percentBase,
        deliveryType: rule.deliveryType,
        minDistanceKm: rule.minDistanceKm,
        maxDistanceKm: rule.maxDistanceKm,
        perKmRate: rule.perKmRate != null ? money(rule.perKmRate) : null,
      })),
    })),
    reminders,
    care: {
      points: setting?.carePoints ?? 0,
      tier: (setting?.careTier ?? 'Gold') as 'Gold',
      memberSince: setting?.memberSince ?? '',
      pointsToNext: setting?.pointsToNext ?? 0,
      nextTier: setting?.nextTier ?? 'Platinum',
      rewardValue: setting?.rewardValue ?? 0,
      tiers: TIERS,
      campaigns,
      history: history.map((event) => ({ id: event.id, title: event.title, date: event.dateLabel, points: event.points })),
    },
    threads: threads.map((thread) => ({
      id: thread.id,
      customerId: thread.customerId,
      name: thread.customer.name,
      online: thread.online,
      unread: thread.unread,
      messages: thread.messages.map((message) => ({
        id: message.id,
        from: message.from === 'staff' ? 'staff' : 'patient',
        text: message.text,
        at: message.at,
      })),
    })),
    notices: notices.map((notice) => ({
      id: notice.id,
      title: notice.title,
      body: notice.body,
      at: notice.at,
      read: notice.read,
      page: notice.page,
    })),
    settings: {
      storeName: setting?.storeName ?? 'Hera Pharmacy',
      alertEmail: setting?.alertEmail ?? true,
      lowStockThreshold: setting?.lowStockThreshold ?? 12,
      autoApproveRefills: setting?.autoApproveRefills ?? false,
      showOutOfStock: setting?.showOutOfStock ?? true,
    },
    mobileConfig: normalizeMobileConfig(setting?.mobileConfig),
    promos: promos.map((promo) => ({
      id: promo.id,
      code: promo.code,
      label: promo.label,
      discount: money(promo.discount),
      active: promo.active,
    })),
    payouts: payouts.map((payout) => ({
      id: payout.id,
      amount: money(payout.amount),
      note: payout.note,
      at: payout.createdAt.toISOString(),
    })),
  }
}
