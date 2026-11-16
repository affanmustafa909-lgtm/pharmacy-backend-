import { Router } from 'express'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

export const notificationRouter = Router()
notificationRouter.use(requireAuth, requireRole('CUSTOMER'))

notificationRouter.get('/mine', async (req, res) => {
  const items = await prisma.customerNotification.findMany({
    where: { customerId: req.user!.id },
    orderBy: { createdAt: 'desc' },
    take: 80,
  })
  const unreadCount = await prisma.customerNotification.count({
    where: { customerId: req.user!.id, read: false },
  })
  res.json({
    unreadCount,
    notifications: items.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      body: item.body,
      data: item.data,
      read: item.read,
      createdAt: item.createdAt.toISOString(),
    })),
  })
})

notificationRouter.post('/read', async (req, res, next) => {
  try {
    const body = z
      .object({
        ids: z.array(z.string()).optional(),
        all: z.boolean().optional(),
      })
      .parse(req.body)
    if (body.all) {
      await prisma.customerNotification.updateMany({
        where: { customerId: req.user!.id, read: false },
        data: { read: true },
      })
    } else if (body.ids?.length) {
      await prisma.customerNotification.updateMany({
        where: { customerId: req.user!.id, id: { in: body.ids } },
        data: { read: true },
      })
    } else {
      throw new HttpError(400, 'Choose notifications to mark as read')
    }
    res.json({ ok: true })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Check the request') : error)
  }
})
