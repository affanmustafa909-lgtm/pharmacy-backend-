import type { OrderStatus } from '@prisma/client'
import { HttpError } from '../lib/http.js'

const PICKUP_FLOW: OrderStatus[] = ['placed', 'preparing', 'ready_for_pickup', 'collected']
const DELIVERY_FLOW: OrderStatus[] = ['placed', 'preparing', 'out_for_delivery', 'delivered']

export function allowedStatusesForDelivery(deliveryType: string): OrderStatus[] {
  return deliveryType === 'pickup' ? [...PICKUP_FLOW, 'cancelled'] : [...DELIVERY_FLOW, 'cancelled']
}

export function assertStatusTransition(deliveryType: string, from: OrderStatus, to: OrderStatus) {
  if (from === to) return
  if (to === 'cancelled') {
    if (from === 'delivered' || from === 'collected' || from === 'cancelled') {
      throw new HttpError(400, 'This order cannot be cancelled')
    }
    return
  }
  const flow = deliveryType === 'pickup' ? PICKUP_FLOW : DELIVERY_FLOW
  if (!flow.includes(to)) {
    throw new HttpError(400, `Status ${to.replaceAll('_', ' ')} is not valid for ${deliveryType} orders`)
  }
  if (from === 'cancelled') throw new HttpError(400, 'Cancelled orders cannot change status')
  const fromIndex = flow.indexOf(from)
  const toIndex = flow.indexOf(to)
  if (fromIndex < 0 || toIndex < 0 || toIndex < fromIndex) {
    throw new HttpError(400, `Cannot move from ${from.replaceAll('_', ' ')} to ${to.replaceAll('_', ' ')}`)
  }
  if (toIndex > fromIndex + 1) {
    throw new HttpError(400, 'Skip status steps are not allowed')
  }
}
