import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'

export async function notifyCustomer(input: {
  customerId: string
  type: string
  title: string
  body: string
  data?: Prisma.InputJsonValue
}) {
  return prisma.customerNotification.create({
    data: {
      customerId: input.customerId,
      type: input.type,
      title: input.title,
      body: input.body,
      data: input.data ?? {},
    },
  })
}

export async function notifyRiderInbox(input: {
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
