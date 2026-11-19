
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { money } from '../services/money.js'

export const adminOrderRouter = Router()

adminOrderRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'))

adminOrderRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orders = await prisma.order.findMany({
      include: {
        customer: {
          select: {
            name: true,
            email: true,
            phone: true,
          },
        },
        store: true,
        items: true,
        charges: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 100,
    })

    res.json({
      orders: orders.map((order) => ({
        id: order.id,
        number: order.number,
        customer: order.customer,
        storeName: order.store.name,
        status: order.status,
        paymentStatus: order.paymentStatus,
        deliveryType: order.deliveryType,
        paymentLabel: order.paymentLabel,
        addressLine: order.addressLine,
        total: money(order.total),
        itemCount: order.items.reduce(
          (sum, item) => sum + item.quantity,
          0,
        ),
        items: order.items,
        createdAt: order.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    next(error)
  }
})
