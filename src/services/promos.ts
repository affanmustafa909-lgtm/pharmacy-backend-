import type { Prisma, PromoCode } from '@prisma/client'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { money } from './money.js'

export type PromoStatus = 'live' | 'scheduled' | 'expired' | 'paused' | 'used_up'

export function promoStoreIds(promo: { storeIds: Prisma.JsonValue }): string[] {
  return Array.isArray(promo.storeIds) ? promo.storeIds.map(String) : []
}

/** Number of times a promo was used. Cancelled orders do not count. */
export async function promoUsage(promoId: string, customerId?: string) {
  return prisma.promoRedemption.count({
    where: {
      promoId,
      ...(customerId ? { customerId } : {}),
      order: { status: { not: 'cancelled' } },
    },
  })
}

export function promoStatus(promo: PromoCode, used: number, now = new Date()): PromoStatus {
  if (!promo.active) return 'paused'
  if (promo.endsAt && now > promo.endsAt) return 'expired'
  if (promo.startsAt && now < promo.startsAt) return 'scheduled'
  if (promo.maxUses != null && used >= promo.maxUses) return 'used_up'
  return 'live'
}

export function serializePromo(promo: PromoCode, used: number, now = new Date()) {
  return {
    id: promo.id,
    code: promo.code,
    label: promo.label,
    discount: money(promo.discount),
    active: promo.active,
    startsAt: promo.startsAt?.toISOString() ?? null,
    endsAt: promo.endsAt?.toISOString() ?? null,
    maxUses: promo.maxUses,
    perCustomerLimit: promo.perCustomerLimit,
    storeIds: promoStoreIds(promo),
    used,
    status: promoStatus(promo, used, now),
  }
}

/** Throws a clear error if this promo cannot be used for this order. */
export async function assertPromoUsable(
  promo: PromoCode,
  input: { storeId: string; customerId?: string; now?: Date },
) {
  const now = input.now ?? new Date()
  if (!promo.active) throw new HttpError(400, 'Promo code is not valid', 'PROMO_INVALID')
  if (promo.startsAt && now < promo.startsAt) throw new HttpError(400, 'This promo has not started yet', 'PROMO_NOT_STARTED')
  if (promo.endsAt && now > promo.endsAt) throw new HttpError(400, 'This promo has expired', 'PROMO_EXPIRED')
  const stores = promoStoreIds(promo)
  if (stores.length && !stores.includes(input.storeId)) {
    throw new HttpError(400, 'This promo is not available at this store', 'PROMO_STORE')
  }
  if (promo.maxUses != null) {
    const used = await promoUsage(promo.id)
    if (used >= promo.maxUses) throw new HttpError(400, 'This promo has reached its usage limit', 'PROMO_LIMIT')
  }
  if (promo.perCustomerLimit != null && input.customerId) {
    const mine = await promoUsage(promo.id, input.customerId)
    if (mine >= promo.perCustomerLimit) {
      throw new HttpError(400, 'You have already used this promo the maximum number of times', 'PROMO_CUSTOMER_LIMIT')
    }
  }
}
