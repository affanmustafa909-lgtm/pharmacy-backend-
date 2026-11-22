import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { notifyCustomer, notifyRiderInbox } from './notifications.js'

function mapMessage(message: {
  id: string
  senderRole: string
  senderName: string
  body: string
  createdAt: Date
}) {
  return {
    id: message.id,
    senderRole: message.senderRole as 'rider' | 'customer',
    senderName: message.senderName,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
  }
}

export async function listOrderMessages(orderId: string) {
  const messages = await prisma.orderMessage.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })
  return messages.map(mapMessage)
}

export async function postOrderMessage(input: {
  orderId: string
  orderNumber: string
  senderRole: 'rider' | 'customer'
  senderName: string
  body: string
  customerId: string
  riderId?: string | null
  riderUserId?: string | null
}) {
  const body = input.body.trim()
  if (!body) throw new HttpError(400, 'Type a message first')
  if (body.length > 500) throw new HttpError(400, 'Keep messages under 500 characters')

  const created = await prisma.orderMessage.create({
    data: {
      orderId: input.orderId,
      senderRole: input.senderRole,
      senderName: input.senderName,
      body,
    },
  })

  if (input.senderRole === 'rider') {
    await notifyCustomer({
      customerId: input.customerId,
      type: 'message',
      title: `Message from ${input.senderName}`,
      body,
      data: { orderNumber: input.orderNumber, kind: 'order_message' },
    })
  } else if (input.riderId) {
    await notifyRiderInbox({
      riderId: input.riderId,
      userId: input.riderUserId,
      type: 'message',
      title: `Message from ${input.senderName}`,
      body,
      data: { orderNumber: input.orderNumber, kind: 'order_message' },
    })
  }

  return mapMessage(created)
}
