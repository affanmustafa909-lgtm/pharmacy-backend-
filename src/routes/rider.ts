import { Router, type Request } from 'express'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { assertStatusTransition } from '../services/orderStatus.js'
import { mapOrderDetail } from '../services/orders.js'
import { notifyCustomer } from '../services/notifications.js'
import { listOrderMessages, postOrderMessage } from '../services/orderMessages.js'
import { loadRiderOrder, requireRiderForUser } from '../services/riders.js'

export const riderRouter = Router()

riderRouter.use(requireAuth, requireRole('RIDER'))

async function resolveRider(req: Request) {
  return requireRiderForUser(req.user!.id)
}

riderRouter.get('/me', async (req, res, next) => {
  try {
    const rider = await resolveRider(req)
    res.json({
      rider: {
        id: rider.id,
        name: rider.name,
        phone: rider.phone,
        vehicle: rider.vehicle,
        storeId: rider.storeId,
        storeName: rider.store?.name ?? '',
        storeAddress: rider.store?.address ?? '',
        isPrimary: rider.isPrimary,
      },
    })
  } catch (error) {
    next(error)
  }
})

riderRouter.get('/orders', async (req, res, next) => {
  try {
    const rider = await resolveRider(req)
    const status = String(req.query.status ?? '').trim()
    const includeCompleted = String(req.query.includeCompleted ?? '') === '1'

    if (!rider.storeId) throw new HttpError(403, 'Your rider account is not assigned to a pharmacy yet')

    const orders = await prisma.order.findMany({
      where: {
        riderId: rider.id,
        storeId: rider.storeId,
        deliveryType: { not: 'pickup' },
        ...(status
          ? { status: status as never }
          : includeCompleted
            ? { status: { not: 'cancelled' } }
            : {
                status: {
                  in: ['placed', 'preparing', 'out_for_delivery'],
                },
              }),
      },
      include: {
        store: true,
        items: true,
        charges: true,
        rider: true,
        customer: { select: { name: true, phone: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    res.json({
      orders: orders.map((order) => ({
        ...mapOrderDetail(order),
        customerName: order.customer.name,
        customerPhone: order.customer.phone,
        lastMessage: order.messages[0]
          ? {
              body: order.messages[0].body,
              senderRole: order.messages[0].senderRole,
              createdAt: order.messages[0].createdAt.toISOString(),
            }
          : null,
        nextAction:
          order.status === 'placed'
            ? 'confirm'
            : order.status === 'preparing'
              ? 'pickup'
              : order.status === 'out_for_delivery'
                ? 'deliver'
                : null,
      })),
    })
  } catch (error) {
    next(error)
  }
})

riderRouter.get('/orders/:number', async (req, res, next) => {
  try {
    const rider = await resolveRider(req)
    const order = await loadRiderOrder(String(req.params.number), rider.id)
    res.json({
      ...mapOrderDetail(order),
      customerName: order.customer.name,
      customerPhone: order.customer.phone,
      nextAction:
        order.status === 'placed'
          ? 'confirm'
          : order.status === 'preparing'
            ? 'pickup'
            : order.status === 'out_for_delivery'
              ? 'deliver'
              : null,
    })
  } catch (error) {
    next(error)
  }
})

riderRouter.get('/orders/:number/messages', async (req, res, next) => {
  try {
    const rider = await resolveRider(req)
    const order = await loadRiderOrder(String(req.params.number), rider.id)
    const messages = await listOrderMessages(order.id)
    res.json({
      orderNumber: order.number,
      customerName: order.customer.name,
      customerPhone: order.customer.phone,
      messages,
    })
  } catch (error) {
    next(error)
  }
})

riderRouter.post('/orders/:number/messages', async (req, res, next) => {
  try {
    const rider = await resolveRider(req)
    const body = z.object({ body: z.string().trim().min(1).max(500) }).parse(req.body)
    const order = await loadRiderOrder(String(req.params.number), rider.id)
    const message = await postOrderMessage({
      orderId: order.id,
      orderNumber: order.number,
      senderRole: 'rider',
      senderName: rider.name,
      body: body.body,
      customerId: order.customerId,
      riderId: rider.id,
      riderUserId: rider.userId,
    })
    res.status(201).json({ message })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Type a short message') : error)
  }
})

async function advanceRiderOrder(
  req: Request,
  nextStatus: 'preparing' | 'out_for_delivery' | 'delivered',
  activityLabel: string,
  customerMessage: { title: string; body: (number: string) => string },
) {
  const rider = await resolveRider(req)
  const order = await loadRiderOrder(String(req.params.number), rider.id)

  if (order.storeId !== rider.storeId) {
    throw new HttpError(403, 'This order belongs to a different pharmacy')
  }

  assertStatusTransition(order.deliveryType, order.status, nextStatus)

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { status: nextStatus },
    include: { items: true, charges: true, store: true, rider: true },
  })

  await prisma.orderActivity.create({
    data: {
      orderId: order.id,
      label: activityLabel,
      detail: rider.name,
      actor: rider.name,
    },
  })

  await notifyCustomer({
    customerId: order.customerId,
    type: 'order',
    title: customerMessage.title,
    body: customerMessage.body(order.number),
    data: { orderNumber: order.number, status: nextStatus },
  })

  return updated
}

riderRouter.post('/orders/:number/confirm', async (req, res, next) => {
  try {
    const updated = await advanceRiderOrder(req, 'preparing', 'Rider confirmed order', {
      title: 'Rider confirmed',
      body: (number) => `${number}: your rider confirmed and is heading to the pharmacy.`,
    })
    res.json(mapOrderDetail(updated))
  } catch (error) {
    next(error)
  }
})

riderRouter.post('/orders/:number/pickup', async (req, res, next) => {
  try {
    const updated = await advanceRiderOrder(
      req,
      'out_for_delivery',
      'Picked up medicine from pharmacy',
      {
        title: 'On the way',
        body: (number) => `${number}: medicine picked up — rider is on the way to you.`,
      },
    )
    res.json(mapOrderDetail(updated))
  } catch (error) {
    next(error)
  }
})

riderRouter.post('/orders/:number/deliver', async (req, res, next) => {
  try {
    const updated = await advanceRiderOrder(req, 'delivered', 'Delivered to customer', {
      title: 'Delivered',
      body: (number) => `${number} was delivered. Thanks for ordering with Hera.`,
    })
    res.json(mapOrderDetail(updated))
  } catch (error) {
    next(error)
  }
})

riderRouter.get('/notifications', async (req, res, next) => {
  try {
    const rider = await resolveRider(req)
    const notifications = await prisma.riderNotification.findMany({
      where: { riderId: rider.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    const unreadCount = await prisma.riderNotification.count({
      where: { riderId: rider.id, read: false },
    })
    res.json({
      unreadCount,
      notifications: notifications.map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        body: item.body,
        data: item.data,
        read: item.read,
        createdAt: item.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    next(error)
  }
})

riderRouter.post('/notifications/read', async (req, res, next) => {
  try {
    const rider = await resolveRider(req)
    const body = z
      .object({
        ids: z.array(z.string()).optional(),
        all: z.boolean().optional(),
      })
      .parse(req.body)

    if (body.all) {
      await prisma.riderNotification.updateMany({
        where: { riderId: rider.id, read: false },
        data: { read: true },
      })
    } else if (body.ids?.length) {
      await prisma.riderNotification.updateMany({
        where: { riderId: rider.id, id: { in: body.ids } },
        data: { read: true },
      })
    }

    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})
