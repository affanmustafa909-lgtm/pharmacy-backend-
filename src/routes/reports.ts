import { Router } from 'express'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { HttpError, pageParams } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import type { AuthUser } from '../lib/auth.js'
import { assertStoreAccess, accessibleStoreIds } from '../services/permissions.js'
import { money } from '../services/money.js'
import { summarizeOrders } from '../services/reportSummary.js'

/** Each record type is read up to this many rows. If it is hit, the page shows a warning. */
const ROW_LIMIT = 2000
/** The Excel file holds at most this many rows. */
const EXPORT_LIMIT = 5000

/**
 * Which stores this user may see in the report.
 * null = every store (owner). [] = no store. Otherwise the list of allowed store ids.
 * (Before, a manager with several stores only saw the first one. Now they see all of theirs.)
 */
async function reportStoreScope(user: AuthUser, storeId?: string): Promise<string[] | null> {
  if (storeId) {
    await assertStoreAccess(user, storeId)
    return [storeId]
  }
  const allowed = await accessibleStoreIds(user)
  return allowed ?? null
}

const querySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  storeId: z.string().optional(),
  type: z.enum(['all', 'order', 'prescription', 'product', 'service', 'charge', 'payment']).optional(),
  status: z.string().optional(),
  paymentMethod: z.string().optional(),
  q: z.string().optional(),
  productId: z.string().optional(),
})

interface ReportRow {
  id: string
  occurredAt: string
  storeName: string
  recordType: string
  status: string
  name: string
  amount: number
  reference: string
  paymentLabel?: string
  paymentStatus?: string
  deliveryCharge?: number
  serviceCharge?: number
  bfpCharge?: number
}

async function collect(storeIds: string[] | null, query: z.infer<typeof querySchema>) {
  const storeFilter = storeIds ? { storeId: { in: storeIds } } : {}
  const from = query.from ? new Date(query.from) : undefined
  const to = query.to ? new Date(query.to) : undefined
  if (from && Number.isNaN(from.getTime())) throw new HttpError(400, 'Start date is invalid')
  if (to && Number.isNaN(to.getTime())) throw new HttpError(400, 'End date is invalid')
  const createdAt = from || to ? { gte: from, lte: to } : undefined
  const type = query.type ?? 'all'
  const q = query.q?.trim().toLowerCase() ?? ''
  const orderStatuses = ['placed', 'preparing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'cancelled'] as const
  const orderStatus = orderStatuses.find((status) => status === query.status)
  const paymentMethod = query.paymentMethod?.trim().toLowerCase()
  const rows: ReportRow[] = []
  let truncated = false

  if (type === 'all' || type === 'order' || type === 'charge') {
    const orders = await prisma.order.findMany({
      where: {
        ...storeFilter,
        ...(createdAt ? { createdAt } : {}),
        ...(orderStatus ? { status: orderStatus } : {}),
        ...(query.productId ? { items: { some: { productId: query.productId } } } : {}),
      },
      include: { store: true, customer: true, items: true, charges: true },
      orderBy: { createdAt: 'desc' },
      take: ROW_LIMIT,
    })
    if (orders.length >= ROW_LIMIT) truncated = true
    orders.forEach((order) => {
      if (paymentMethod && !order.paymentLabel.toLowerCase().includes(paymentMethod)) return
      if (type === 'all' || type === 'order') {
        rows.push({
          id: order.id,
          occurredAt: order.createdAt.toISOString(),
          storeName: order.store.name,
          recordType: 'order',
          status: order.status,
          name: order.items.map((item) => item.name).join(', ') || 'Order',
          amount: money(order.total),
          reference: order.number,
          paymentLabel: order.paymentLabel,
          paymentStatus: order.paymentStatus,
          deliveryCharge: money(order.deliveryCharge),
          serviceCharge: money(order.serviceCharge),
          bfpCharge: money(order.bfpCharge),
        })
      }
      if (type === 'charge') {
        order.charges.forEach((charge) => {
          rows.push({
            id: `${order.id}-${charge.id}`,
            occurredAt: order.createdAt.toISOString(),
            storeName: order.store.name,
            recordType: 'charge',
            status: charge.kind,
            name: charge.label,
            amount: money(charge.amount),
            reference: order.number,
            paymentLabel: order.paymentLabel,
          })
        })
      }
    })
  }
  if (type === 'all' || type === 'prescription') {
    const items = await prisma.prescription.findMany({
      where: { ...storeFilter, ...(createdAt ? { submittedAt: createdAt } : {}) },
      include: { store: true },
      take: ROW_LIMIT,
    })
    if (items.length >= ROW_LIMIT) truncated = true
    items.forEach((item) => {
      rows.push({
        id: item.id,
        occurredAt: item.submittedAt.toISOString(),
        storeName: item.store.name,
        recordType: 'prescription',
        status: item.status,
        name: item.medicineName,
        amount: 0,
        reference: item.number,
      })
    })
  }
  if (type === 'all' || type === 'product') {
    const products = await prisma.product.findMany({
      where: { ...storeFilter, ...(query.productId ? { id: query.productId } : {}), ...(createdAt ? { createdAt } : {}) },
      include: { store: true },
      take: ROW_LIMIT,
    })
    if (products.length >= ROW_LIMIT) truncated = true
    products.forEach((product) => {
      rows.push({
        id: product.id,
        occurredAt: product.createdAt.toISOString(),
        storeName: product.store.name,
        recordType: 'product',
        status: product.held ? 'held' : 'active',
        name: product.name,
        amount: money(product.price),
        reference: product.sku,
      })
    })
  }
  if (type === 'all' || type === 'payment') {
    const paymentStatusFilter =
      query.status === 'succeeded' || query.status === 'failed' || query.status === 'pending' || query.status === 'processing'
        ? (query.status as 'succeeded' | 'failed' | 'pending' | 'processing')
        : undefined
    const payments = await prisma.paymentTransaction.findMany({
      where: {
        ...(createdAt ? { createdAt } : {}),
        ...(paymentStatusFilter ? { status: paymentStatusFilter } : {}),
        ...(storeIds
          ? {
              OR: [
                { orders: { some: { storeId: { in: storeIds } } } },
                { orders: { none: {} }, status: 'failed' },
              ],
            }
          : {}),
      },
      include: {
        customer: true,
        orders: { include: { store: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: ROW_LIMIT,
    })
    if (payments.length >= ROW_LIMIT) truncated = true
    payments.forEach((payment) => {
      const label = payment.method === 'credit_card' ? 'Credit Card' : payment.method === 'debit_card' ? 'Debit Card' : payment.method
      if (paymentMethod && !label.toLowerCase().includes(paymentMethod) && !payment.method.toLowerCase().includes(paymentMethod)) {
        return
      }
      rows.push({
        id: payment.id,
        occurredAt: payment.createdAt.toISOString(),
        storeName: payment.orders.map((order) => order.store.name).filter(Boolean).join(' · ') || '—',
        recordType: 'payment',
        status: payment.status,
        name: `${payment.customer.name} · ${payment.cardBrand || 'Card'} •••• ${payment.cardLast4 || '----'}`,
        amount: money(payment.amount),
        reference: payment.transactionId,
        paymentLabel: label,
        paymentStatus: payment.status === 'succeeded' ? 'paid' : payment.status,
      })
    })
  }

  if (type === 'all' || type === 'service') {
    const services = await prisma.service.findMany({
      where: { ...storeFilter, ...(createdAt ? { createdAt } : {}) },
      include: { store: true },
      take: ROW_LIMIT,
    })
    if (services.length >= ROW_LIMIT) truncated = true
    services.forEach((service) => {
      rows.push({
        id: service.id,
        occurredAt: service.createdAt.toISOString(),
        storeName: service.store.name,
        recordType: 'service',
        status: service.active ? 'active' : 'inactive',
        name: service.name,
        amount: 0,
        reference: service.id,
      })
    })
  }

  const filtered = rows
    .filter((row) => {
      if (query.status && query.status !== 'all' && row.status !== query.status) return false
      if (!q) return true
      return `${row.name} ${row.reference} ${row.storeName} ${row.status}`.toLowerCase().includes(q)
    })
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))

  return { rows: filtered, truncated }
}

export const reportRouter = Router()
reportRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'))

// The list and the Excel file both call collect() with the SAME filters,
// so the exported rows always match what the page shows.
reportRouter.get('/', async (req, res, next) => {
  try {
    const parsed = querySchema.parse(req.query)
    const scope = await reportStoreScope(req.user!, parsed.storeId)
    const { page, pageSize, skip } = pageParams(req.query as Record<string, unknown>)
    const { rows, truncated } = await collect(scope, parsed)
    res.json({
      page,
      pageSize,
      total: rows.length,
      pages: Math.max(1, Math.ceil(rows.length / pageSize)),
      items: rows.slice(skip, skip + pageSize),
      summary: summarizeOrders(rows),
      truncated,
    })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Filters are not valid') : error)
  }
})

reportRouter.get('/export', async (req, res, next) => {
  try {
    const parsed = querySchema.parse(req.query)
    const scope = await reportStoreScope(req.user!, parsed.storeId)
    const { rows, truncated } = await collect(scope, parsed)
    const summary = summarizeOrders(rows)

    let storeLabel = scope === null ? 'All stores' : 'All stores you can access'
    if (parsed.storeId) {
      const store = await prisma.store.findUnique({ where: { id: parsed.storeId }, select: { name: true } })
      storeLabel = store?.name ?? parsed.storeId
    }

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Report')
    sheet.addRow([
      'When',
      'Store',
      'Type',
      'Status',
      'Name',
      'Amount',
      'Reference',
      'Payment',
      'Payment status',
      'Delivery charge',
      'Service charge',
      'BFP charge',
    ])
    rows.slice(0, EXPORT_LIMIT).forEach((row) => {
      sheet.addRow([
        row.occurredAt,
        row.storeName,
        row.recordType,
        row.status,
        row.name,
        row.amount,
        row.reference,
        row.paymentLabel ?? '',
        row.paymentStatus ?? '',
        row.deliveryCharge ?? '',
        row.serviceCharge ?? '',
        row.bfpCharge ?? '',
      ])
    })

    const info = workbook.addWorksheet('Summary')
    info.addRow(['Filters used'])
    info.addRow(['Store', storeLabel])
    info.addRow(['From', parsed.from ?? 'any'])
    info.addRow(['To', parsed.to ?? 'any'])
    info.addRow(['Type', parsed.type ?? 'all'])
    info.addRow(['Status', parsed.status ?? 'any'])
    info.addRow(['Payment', parsed.paymentMethod ?? 'any'])
    info.addRow(['Search', parsed.q ?? ''])
    info.addRow(['Rows in this file', Math.min(rows.length, EXPORT_LIMIT)])
    info.addRow([])
    info.addRow(['Order totals (order records matching the filters)', 'Orders', 'Amount'])
    info.addRow(['Completed (delivered or collected)', summary.completed.count, summary.completed.total])
    info.addRow(['Cancelled', summary.cancelled.count, summary.cancelled.total])
    info.addRow(['Unpaid (pending or failed, not cancelled)', summary.unpaid.count, summary.unpaid.total])
    info.addRow(['Refunded', summary.refunded.count, summary.refunded.total])
    info.addRow([])
    info.addRow(['Charges on completed orders'])
    info.addRow(['Delivery', '', summary.charges.delivery])
    info.addRow(['Service', '', summary.charges.service])
    info.addRow(['BFP', '', summary.charges.bfp])
    if (truncated || rows.length > EXPORT_LIMIT) {
      info.addRow([])
      info.addRow(['Warning: there are more records than this file can hold. Narrow the dates or store.'])
    }

    const file = await workbook.xlsx.writeBuffer()
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="hera-report.xlsx"')
    res.send(Buffer.from(file))
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Filters are not valid') : error)
  }
})