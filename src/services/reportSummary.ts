/**
 * Order totals for the Reports page and the Excel export.
 *
 * Definitions (these exact words are also shown on the Reports page):
 * - completed: order status is delivered or collected. This is the revenue figure.
 * - cancelled: order status is cancelled. Never counted as revenue.
 * - unpaid: payment is still pending or failed, cancelled orders excluded.
 *           An order can be completed and unpaid at the same time.
 * - refunded: payment status is refunded.
 * - charges: delivery, service and BFP charges on completed orders only.
 */

export interface SummaryRow {
  recordType: string
  status: string
  amount: number
  paymentStatus?: string
  deliveryCharge?: number
  serviceCharge?: number
  bfpCharge?: number
}

export interface Bucket {
  count: number
  total: number
}

export interface ReportSummary {
  orders: number
  completed: Bucket
  cancelled: Bucket
  unpaid: Bucket
  refunded: Bucket
  charges: { delivery: number; service: number; bfp: number }
}

const toCents = (value: number | undefined) => Math.round((value ?? 0) * 100)
const toMoney = (cents: number) => cents / 100

export function summarizeOrders(rows: SummaryRow[]): ReportSummary {
  let orders = 0
  const completed = { count: 0, cents: 0 }
  const cancelled = { count: 0, cents: 0 }
  const unpaid = { count: 0, cents: 0 }
  const refunded = { count: 0, cents: 0 }
  const charges = { delivery: 0, service: 0, bfp: 0 }

  for (const row of rows) {
    if (row.recordType !== 'order') continue
    orders += 1
    const amount = toCents(row.amount)
    const isCancelled = row.status === 'cancelled'
    const isCompleted = row.status === 'delivered' || row.status === 'collected'

    if (isCancelled) {
      cancelled.count += 1
      cancelled.cents += amount
    }
    if (isCompleted) {
      completed.count += 1
      completed.cents += amount
      charges.delivery += toCents(row.deliveryCharge)
      charges.service += toCents(row.serviceCharge)
      charges.bfp += toCents(row.bfpCharge)
    }
    if (!isCancelled && (row.paymentStatus === 'pending' || row.paymentStatus === 'failed')) {
      unpaid.count += 1
      unpaid.cents += amount
    }
    if (row.paymentStatus === 'refunded') {
      refunded.count += 1
      refunded.cents += amount
    }
  }

  return {
    orders,
    completed: { count: completed.count, total: toMoney(completed.cents) },
    cancelled: { count: cancelled.count, total: toMoney(cancelled.cents) },
    unpaid: { count: unpaid.count, total: toMoney(unpaid.cents) },
    refunded: { count: refunded.count, total: toMoney(refunded.cents) },
    charges: { delivery: toMoney(charges.delivery), service: toMoney(charges.service), bfp: toMoney(charges.bfp) },
  }
}