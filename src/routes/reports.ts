import { Router } from 'express'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { HttpError, pageParams } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import type { AuthUser } from '../lib/auth.js'
import { assertStoreAccess, accessibleStoreIds } from '../services/permissions.js'
import { money } from '../services/money.js'

async function reportStoreScope(user: AuthUser, storeId?: string) {
  if (storeId) {
    await assertStoreAccess(user, storeId)
    return storeId
  }
  const allowed = await accessibleStoreIds(user)
  if (!allowed) return null
  if (!allowed.length) return '__none__'
  return allowed.length === 1 ? allowed[0] : allowed[0]
}

const querySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  storeId: z.string().optional(),
  type: z.enum(['all', 'order', 'prescription', 'product', 'service', 'charge']).optional(),
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
  deliveryCharge?: number
  serviceCharge?: number
  bfpCharge?: number
}

async function collect(userStoreId: string | null, query: z.infer<typeof querySchema>) {
  if (query.storeId) {
    if (userStoreId && query.storeId !== userStoreId) throw new HttpError(403, 'You cannot view another store')
  }
  const storeId = userStoreId ?? (query.storeId || undefined)
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

  if (type === 'all' || type === 'order' || type === 'charge') {
    const orders = await prisma.order.findMany({
      where: {
        ...(storeId ? { storeId } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(orderStatus ? { status: orderStatus } : {}),
        ...(query.productId ? { items: { some: { productId: query.productId } } } : {}),
      },
      include: { store: true, customer: true, items: true, charges: true },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    })
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
      where: { ...(storeId ? { storeId } : {}), ...(createdAt ? { submittedAt: createdAt } : {}) },
      include: { store: true },
      take: 2000,
    })
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
      where: { ...(storeId ? { storeId } : {}), ...(query.productId ? { id: query.productId } : {}), ...(createdAt ? { createdAt } : {}) },
      include: { store: true },
      take: 2000,
    })
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
  if (type === 'all' || type === 'service') {
    const services = await prisma.service.findMany({
      where: { ...(storeId ? { storeId } : {}), ...(createdAt ? { createdAt } : {}) },
      include: { store: true },
      take: 2000,
    })
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

  return rows
    .filter((row) => {
      if (query.status && query.status !== 'all' && row.status !== query.status) return false
      if (!q) return true
      return `${row.name} ${row.reference} ${row.storeName} ${row.status}`.toLowerCase().includes(q)
    })
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
}

export const reportRouter = Router()
reportRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'))

reportRouter.get('/', async (req, res, next) => {
  try {
    const parsed = querySchema.parse(req.query)
    const scope = await reportStoreScope(req.user!, parsed.storeId)
    const { page, pageSize, skip } = pageParams(req.query as Record<string, unknown>)
    const rows = await collect(scope, { ...parsed, storeId: parsed.storeId || scope || undefined })
    res.json({ page, pageSize, total: rows.length, pages: Math.max(1, Math.ceil(rows.length / pageSize)), items: rows.slice(skip, skip + pageSize) })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Filters are not valid') : error)
  }
})

reportRouter.get('/export', async (req, res, next) => {
  try {
    const parsed = querySchema.parse(req.query)
    const scope = await reportStoreScope(req.user!, parsed.storeId)
    const rows = await collect(scope, { ...parsed, storeId: parsed.storeId || scope || undefined })
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Report')
    sheet.addRow(['When', 'Store', 'Type', 'Status', 'Name', 'Amount', 'Reference'])
    rows.slice(0, 5000).forEach((row) => {
      sheet.addRow([row.occurredAt, row.storeName, row.recordType, row.status, row.name, row.amount, row.reference])
    })
    const file = await workbook.xlsx.writeBuffer()
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="hera-report.xlsx"')
    res.send(Buffer.from(file))
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Filters are not valid') : error)
  }
})
