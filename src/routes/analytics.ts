import { Router, type Request, type RequestHandler, type Response } from 'express'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { assertStoreAccess } from '../services/permissions.js'

export const analyticsRouter = Router()
analyticsRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'))

type H = (req: Request, res: Response) => Promise<unknown>
const route =
  (fn: H): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch((e) =>
      next(e instanceof z.ZodError ? new HttpError(400, e.issues[0]?.message || 'Check the values') : e),
    )
  }

const DAY = 86_400_000
const PK_OFFSET_MS = 5 * 3_600_000 // business time = UTC+5

const query = z.object({
  storeId: z.string().min(1, 'storeId is required'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD').optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

/** Period in business time. Default = last 30 days. Both dates are included. */
function period(q: { from?: string; to?: string }) {
  const today = new Date(Date.now() + PK_OFFSET_MS).toISOString().slice(0, 10)
  const to = q.to ?? today
  const from = q.from ?? new Date(new Date(`${to}T00:00:00Z`).getTime() - 29 * DAY).toISOString().slice(0, 10)
  const start = new Date(`${from}T00:00:00+05:00`)
  const end = new Date(`${to}T23:59:59.999+05:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new HttpError(400, 'Invalid date')
  if (start > end) throw new HttpError(400, 'from must be on or before to')
  if (end.getTime() - start.getTime() > 366 * DAY) throw new HttpError(400, 'Choose a period of 366 days or less')
  return { from, to, start, end }
}

/** One definition for every metric: orders that were not cancelled. */
const DEFINITION = 'Counts all orders in the period that were not cancelled. Dates are in business time (UTC+5).'

/* ---------- Top products ---------- */
analyticsRouter.get(
  '/top-products',
  route(async (req, res) => {
    const q = query.parse(req.query)
    await assertStoreAccess(req.user!, q.storeId)
    const p = period(q)
    const rows = await prisma.orderItem.groupBy({
      by: ['sku', 'name'],
      where: { order: { storeId: q.storeId, createdAt: { gte: p.start, lte: p.end }, status: { not: 'cancelled' } } },
      _sum: { quantity: true, lineTotal: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: q.limit,
    })
    res.json({
      scope: { storeId: q.storeId, from: p.from, to: p.to, definition: DEFINITION },
      products: rows.map((r, i) => ({
        rank: i + 1,
        sku: r.sku,
        name: r.name,
        units: r._sum.quantity ?? 0,
        revenue: Number(r._sum.lineTotal ?? 0),
      })),
    })
  }),
)

/* ---------- Peak business hours ---------- */
analyticsRouter.get(
  '/peak-hours',
  route(async (req, res) => {
    const q = query.parse(req.query)
    await assertStoreAccess(req.user!, q.storeId)
    const p = period(q)
    const rows = await prisma.$queryRaw<{ hour: number; orders: bigint; revenue: Prisma.Decimal | null }[]>`
      SELECT EXTRACT(HOUR FROM ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Karachi'))::int AS hour,
             COUNT(*)::bigint AS orders,
             COALESCE(SUM("total"), 0) AS revenue
      FROM "Order"
      WHERE "storeId" = ${q.storeId}
        AND "createdAt" >= ${p.start}
        AND "createdAt" <= ${p.end}
        AND "status" <> 'cancelled'
      GROUP BY 1
      ORDER BY 1`
    const byHour = new Map(rows.map((r) => [Number(r.hour), r]))
    const hours = Array.from({ length: 24 }, (_, hour) => {
      const r = byHour.get(hour)
      return { hour, label: `${String(hour).padStart(2, '0')}:00`, orders: Number(r?.orders ?? 0), revenue: Number(r?.revenue ?? 0) }
    })
    const peak = [...hours].filter((h) => h.orders > 0).sort((a, b) => b.orders - a.orders).slice(0, 3)
    res.json({
      scope: { storeId: q.storeId, from: p.from, to: p.to, definition: DEFINITION },
      hours,
      peak,
    })
  }),
)

/* ---------- Rider performance ---------- */
analyticsRouter.get(
  '/riders',
  route(async (req, res) => {
    const q = query.parse(req.query)
    await assertStoreAccess(req.user!, q.storeId)
    const p = period(q)
    const [riders, orders, unassigned] = await Promise.all([
      prisma.rider.findMany({ where: { storeId: q.storeId }, orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
      prisma.order.findMany({
        where: { storeId: q.storeId, riderId: { not: null }, createdAt: { gte: p.start, lte: p.end } },
        select: {
          riderId: true,
          status: true,
          total: true,
          activities: {
            where: { label: { in: ['Status → out for delivery', 'Status → delivered'] } },
            select: { label: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
      prisma.order.findMany({
        where: {
          storeId: q.storeId,
          riderId: null,
          deliveryType: { not: 'pickup' },
          status: { in: ['placed', 'preparing', 'out_for_delivery'] },
        },
        select: { number: true, status: true, createdAt: true, customer: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
    ])

    const stats = new Map(
      riders.map((r) => [r.id, { assigned: 0, delivered: 0, cancelled: 0, revenue: 0, minutes: [] as number[] }]),
    )
    for (const o of orders) {
      const st = o.riderId ? stats.get(o.riderId) : undefined
      if (!st) continue
      st.assigned += 1
      if (o.status === 'cancelled') st.cancelled += 1
      if (o.status === 'delivered') {
        st.delivered += 1
        st.revenue += Number(o.total)
        const out = o.activities.find((a) => a.label === 'Status → out for delivery')
        const done = [...o.activities].reverse().find((a) => a.label === 'Status → delivered')
        if (out && done && done.createdAt >= out.createdAt) {
          st.minutes.push((done.createdAt.getTime() - out.createdAt.getTime()) / 60_000)
        }
      }
    }

    res.json({
      scope: {
        storeId: q.storeId,
        from: p.from,
        to: p.to,
        definition:
          'Orders created in the period that have a rider. Delivered time = from "out for delivery" to "delivered". Revenue = total of delivered orders. Dates are in business time (UTC+5).',
      },
      riders: riders.map((r) => {
        const st = stats.get(r.id)!
        return {
          id: r.id,
          name: r.name,
          vehicle: r.vehicle,
          active: r.active,
          assigned: st.assigned,
          delivered: st.delivered,
          cancelled: st.cancelled,
          inProgress: st.assigned - st.delivered - st.cancelled,
          avgDeliveryMinutes: st.minutes.length ? Math.round((st.minutes.reduce((a, b) => a + b, 0) / st.minutes.length) * 10) / 10 : null,
          revenue: Math.round(st.revenue * 100) / 100,
        }
      }),
      unassigned: unassigned.map((o) => ({
        number: o.number,
        status: o.status,
        customer: o.customer.name,
        createdAt: o.createdAt.toISOString(),
      })),
    })
  }),
)
