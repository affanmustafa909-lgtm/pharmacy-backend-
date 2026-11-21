import type { Prisma } from '@prisma/client'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'

export async function findAssignedRiderForStore(storeId: string) {
  const primary = await prisma.rider.findFirst({
    where: {
      storeId,
      active: true,
      approvalStatus: 'approved',
      isPrimary: true,
    },
    orderBy: { createdAt: 'asc' },
  })
  if (primary) return primary

  return prisma.rider.findFirst({
    where: { storeId, active: true, approvalStatus: 'approved' },
    orderBy: [{ createdAt: 'asc' }],
  })
}

export async function notifyRider(input: {
  riderId: string
  userId?: string | null
  type: string
  title: string
  body: string
  data?: Prisma.InputJsonValue
}) {
  return prisma.riderNotification.create({
    data: {
      riderId: input.riderId,
      userId: input.userId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
      data: input.data ?? {},
    },
  })
}

export async function requireRiderForUser(userId: string) {
  const rider = await prisma.rider.findFirst({
    where: { userId },
    include: { store: true },
  })
  if (!rider) throw new HttpError(403, 'No rider profile is linked to this account')
  if (rider.approvalStatus === 'pending') {
    throw new HttpError(403, 'Your rider account is waiting for admin approval')
  }
  if (rider.approvalStatus === 'rejected') {
    throw new HttpError(
      403,
      rider.rejectedReason
        ? `Your rider application was rejected: ${rider.rejectedReason}`
        : 'Your rider application was rejected',
    )
  }
  if (!rider.active || !rider.storeId) {
    throw new HttpError(403, 'Your rider account is not active for a pharmacy yet')
  }
  return rider
}

export async function loadRiderOrder(orderNumber: string, riderId: string) {
  const order = await prisma.order.findFirst({
    where: { number: orderNumber, riderId },
    include: {
      items: true,
      charges: true,
      store: true,
      rider: true,
      customer: { select: { id: true, name: true, phone: true } },
    },
  })
  if (!order) throw new HttpError(404, 'Order not found for this rider')
  return order
}
