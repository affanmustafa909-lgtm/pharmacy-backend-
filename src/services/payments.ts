import { randomBytes } from 'node:crypto'
import type { PaymentTxnStatus, Prisma } from '@prisma/client'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { money } from './money.js'

export type CardMethod = 'debit_card' | 'credit_card'

export type TestCardScenario = {
  number: string
  brand: string
  outcome: 'succeeded' | 'failed'
  failureCode?: string
  failureMessage?: string
  label: string
}

/** Published test PANs for the simulation only — never live banking. */
export const TEST_CARDS: TestCardScenario[] = [
  {
    number: '4111111111111111',
    brand: 'Visa',
    outcome: 'succeeded',
    label: 'Visa — success',
  },
  {
    number: '5555555555554444',
    brand: 'Mastercard',
    outcome: 'succeeded',
    label: 'Mastercard — success',
  },
  {
    number: '4000000000000002',
    brand: 'Visa',
    outcome: 'failed',
    failureCode: 'card_declined',
    failureMessage: 'Your card was declined. Try another card or pay with cash on delivery.',
    label: 'Visa — declined',
  },
  {
    number: '4000000000009995',
    brand: 'Visa',
    outcome: 'failed',
    failureCode: 'insufficient_funds',
    failureMessage: 'Insufficient funds. Try another card or pay with cash on delivery.',
    label: 'Visa — insufficient funds',
  },
]

const METHOD_LABEL: Record<CardMethod, string> = {
  debit_card: 'Debit Card',
  credit_card: 'Credit Card',
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, '')
}

function luhnOk(pan: string) {
  let sum = 0
  let alt = false
  for (let i = pan.length - 1; i >= 0; i -= 1) {
    let n = Number(pan[i])
    if (Number.isNaN(n)) return false
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

function detectBrand(pan: string) {
  if (/^4/.test(pan)) return 'Visa'
  if (/^5[1-5]/.test(pan) || /^2(2[2-9]|[3-6]\d|7[01]|720)/.test(pan)) return 'Mastercard'
  if (/^3[47]/.test(pan)) return 'Amex'
  return 'Card'
}

function parseExpiry(expiry: string): { month: number; year: number } {
  const match = expiry.trim().match(/^(\d{2})\s*\/\s*(\d{2})$/)
  if (!match) throw new HttpError(400, 'Use expiry as MM/YY', 'INVALID_EXPIRY')
  const month = Number(match[1])
  const year = 2000 + Number(match[2])
  if (month < 1 || month > 12) throw new HttpError(400, 'Expiry month must be 01–12', 'INVALID_EXPIRY')
  return { month, year }
}

function assertExpiryNotPast(expiry: string) {
  const { month, year } = parseExpiry(expiry)
  const now = new Date()
  const expEnd = new Date(year, month, 0, 23, 59, 59, 999)
  if (expEnd < now) throw new HttpError(400, 'Card is expired', 'CARD_EXPIRED')
}

function newTransactionId() {
  const stamp = Date.now().toString(36).toUpperCase()
  const rand = randomBytes(3).toString('hex').toUpperCase()
  return `TXN-${stamp}-${rand}`
}

function mapTxn(row: {
  id: string
  transactionId: string
  amount: Prisma.Decimal | number
  currency: string
  method: string
  status: PaymentTxnStatus
  cardLast4: string
  cardBrand: string
  cardholderName: string
  failureCode: string
  failureMessage: string
  orderNumber: string
  paidAt: Date | null
  createdAt: Date
  customer?: { id: string; name: string; email: string } | null
  orders?: { number: string; storeId: string; store?: { name: string } | null }[]
  checkoutGroup?: { id: string } | null
}) {
  return {
    id: row.id,
    transactionId: row.transactionId,
    amount: money(row.amount),
    currency: row.currency,
    method: row.method,
    paymentLabel: METHOD_LABEL[row.method as CardMethod] || row.method,
    status: row.status,
    cardLast4: row.cardLast4,
    cardBrand: row.cardBrand,
    cardholderName: row.cardholderName,
    failureCode: row.failureCode || undefined,
    failureMessage: row.failureMessage || undefined,
    orderNumber: row.orderNumber || undefined,
    orderNumbers: row.orders?.map((order) => order.number) ?? (row.orderNumber ? [row.orderNumber] : []),
    storeNames: row.orders?.map((order) => order.store?.name).filter(Boolean) ?? [],
    checkoutGroupId: row.checkoutGroup?.id,
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    customer: row.customer
      ? { id: row.customer.id, name: row.customer.name, email: row.customer.email }
      : undefined,
    testMode: true as const,
  }
}

export function listPublishedTestCards() {
  return {
    testMode: true as const,
    notice:
      'TEST MODE only — no real charges. Never enter a live card. CVV is validated then discarded; full card numbers are never stored.',
    cards: TEST_CARDS.map((card) => ({
      number: card.number,
      brand: card.brand,
      outcome: card.outcome,
      label: card.label,
      failureMessage: card.failureMessage,
      expiryHint: '12/30',
      cvvHint: card.brand === 'Amex' ? '1234' : '123',
    })),
  }
}

export async function simulateCardPayment(input: {
  customerId: string
  amount: number
  method: CardMethod
  cardholderName: string
  cardNumber: string
  expiry: string
  cvv: string
  idempotencyKey: string
  currency?: string
}) {
  const amount = Math.round(Number(input.amount) * 100) / 100
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(400, 'Payment amount must be greater than zero')
  }

  const existing = await prisma.paymentTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: {
      customer: { select: { id: true, name: true, email: true } },
      orders: { include: { store: { select: { name: true } } } },
      checkoutGroup: { select: { id: true } },
    },
  })
  if (existing) {
    return { ...mapTxn(existing), reused: true as const }
  }

  const name = input.cardholderName.trim()
  if (name.length < 2) throw new HttpError(400, 'Enter the cardholder name', 'INVALID_CARDHOLDER')

  const pan = digitsOnly(input.cardNumber)
  if (pan.length < 13 || pan.length > 19 || !luhnOk(pan)) {
    throw new HttpError(400, 'Enter a valid card number', 'INVALID_CARD_NUMBER')
  }

  assertExpiryNotPast(input.expiry)

  const cvv = digitsOnly(input.cvv)
  const brand = detectBrand(pan)
  const cvvLen = brand === 'Amex' ? 4 : 3
  if (cvv.length !== cvvLen) {
    throw new HttpError(400, `Enter a ${cvvLen}-digit CVV`, 'INVALID_CVV')
  }

  // CVV is validated above, then discarded — never persisted or logged.

  const matched = TEST_CARDS.find((card) => card.number === pan)
  const scenario = matched ?? {
    number: pan,
    brand,
    outcome: 'failed' as const,
    failureCode: 'unknown_test_card',
    failureMessage:
      'Use a published TEST MODE card number. Live cards are not accepted in this simulation.',
    label: 'Unknown test card',
  }

  // Brief processing delay so the client can show a processing animation.
  await new Promise((resolve) => setTimeout(resolve, 900))

  const succeeded = scenario.outcome === 'succeeded'
  const created = await prisma.paymentTransaction.create({
    data: {
      transactionId: newTransactionId(),
      customerId: input.customerId,
      amount,
      currency: input.currency || 'USD',
      method: input.method,
      status: succeeded ? 'succeeded' : 'failed',
      cardLast4: pan.slice(-4),
      cardBrand: scenario.brand || brand,
      cardholderName: name,
      failureCode: succeeded ? '' : scenario.failureCode || 'payment_failed',
      failureMessage: succeeded ? '' : scenario.failureMessage || 'Payment failed',
      idempotencyKey: input.idempotencyKey,
      paidAt: succeeded ? new Date() : null,
    },
    include: {
      customer: { select: { id: true, name: true, email: true } },
      orders: { include: { store: { select: { name: true } } } },
      checkoutGroup: { select: { id: true } },
    },
  })

  return { ...mapTxn(created), reused: false as const }
}

/** Ensures a successful simulated payment can be attached to a new checkout exactly once. */
export async function claimPaymentForCheckout(input: {
  customerId: string
  paymentTransactionId: string
  expectedAmount: number
  paymentLabel: string
}) {
  const txn = await prisma.paymentTransaction.findUnique({
    where: { id: input.paymentTransactionId },
    include: { checkoutGroup: true, orders: true },
  })
  if (!txn || txn.customerId !== input.customerId) {
    throw new HttpError(404, 'Payment not found', 'PAYMENT_NOT_FOUND')
  }
  if (txn.status !== 'succeeded') {
    throw new HttpError(409, 'Payment was not successful. Retry with another card.', 'PAYMENT_NOT_SUCCESS')
  }
  if (txn.checkoutGroup || txn.orders.length > 0 || txn.orderNumber) {
    throw new HttpError(409, 'This payment was already used for an order', 'PAYMENT_ALREADY_USED')
  }
  if (Math.abs(money(txn.amount) - input.expectedAmount) > 0.01) {
    throw new HttpError(
      409,
      `Payment amount ${money(txn.amount).toFixed(2)} does not match order total ${input.expectedAmount.toFixed(2)}`,
      'PAYMENT_AMOUNT_MISMATCH',
    )
  }
  const label = METHOD_LABEL[txn.method as CardMethod] || input.paymentLabel
  return { txn, paymentLabel: label }
}

export async function attachPaymentToCheckout(input: {
  paymentTransactionId: string
  checkoutGroupId: string
  orderNumbers: string[]
}) {
  const primary = input.orderNumbers[0] || ''
  await prisma.$transaction([
    prisma.paymentTransaction.update({
      where: { id: input.paymentTransactionId },
      data: {
        orderNumber: primary,
        orders: {
          connect: input.orderNumbers.map((number) => ({ number })),
        },
      },
    }),
    prisma.checkoutGroup.update({
      where: { id: input.checkoutGroupId },
      data: { paymentTransactionId: input.paymentTransactionId },
    }),
  ])
}

export async function listPaymentTransactions(input: {
  storeIds: string[] | null
  status?: PaymentTxnStatus
  method?: string
  q?: string
  from?: Date
  to?: Date
  take?: number
}) {
  const take = Math.min(input.take ?? 200, 500)
  const q = input.q?.trim()
  const rows = await prisma.paymentTransaction.findMany({
    where: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.method ? { method: input.method } : {}),
      ...(input.from || input.to
        ? { createdAt: { gte: input.from, lte: input.to } }
        : {}),
      ...(q
        ? {
            OR: [
              { transactionId: { contains: q, mode: 'insensitive' } },
              { orderNumber: { contains: q, mode: 'insensitive' } },
              { cardholderName: { contains: q, mode: 'insensitive' } },
              { cardLast4: { contains: q } },
              { customer: { name: { contains: q, mode: 'insensitive' } } },
              { customer: { email: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
      ...(input.storeIds
        ? {
            OR: [
              { orders: { some: { storeId: { in: input.storeIds } } } },
              // Failed / unattached attempts still visible to admins with full access only.
              ...(input.storeIds.length === 0
                ? []
                : [{ orders: { none: {} }, status: 'failed' as const }]),
            ],
          }
        : {}),
    },
    include: {
      customer: { select: { id: true, name: true, email: true } },
      orders: { include: { store: { select: { name: true } } } },
      checkoutGroup: { select: { id: true } },
    },
    orderBy: { createdAt: 'desc' },
    take,
  })

  // When scoped to stores, also include failed attempts for customers who ordered at those stores historically is complex;
  // keep failed unattached visible for unrestricted admins (storeIds null). For staff, filter to store-linked only.
  const filtered =
    input.storeIds == null
      ? rows
      : rows.filter(
          (row) =>
            row.orders.some((order) => input.storeIds!.includes(order.storeId)) ||
            (row.status === 'failed' && row.orders.length === 0),
        )

  const mapped = filtered.map(mapTxn)
  const succeeded = mapped.filter((row) => row.status === 'succeeded')
  const failed = mapped.filter((row) => row.status === 'failed')
  return {
    testMode: true as const,
    summary: {
      totalAttempts: mapped.length,
      succeeded: succeeded.length,
      failed: failed.length,
      succeededAmount: Math.round(succeeded.reduce((sum, row) => sum + row.amount, 0) * 100) / 100,
      failedAmount: Math.round(failed.reduce((sum, row) => sum + row.amount, 0) * 100) / 100,
    },
    transactions: mapped,
  }
}
