import { Router } from 'express'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { accessibleStoreIds } from '../services/permissions.js'
import {
  listPaymentTransactions,
  listPublishedTestCards,
  simulateCardPayment,
} from '../services/payments.js'

const simulateSchema = z.object({
  amount: z.number().positive().max(100000),
  method: z.enum(['debit_card', 'credit_card']),
  cardholderName: z.string().trim().min(2).max(80),
  cardNumber: z.string().min(12).max(30),
  expiry: z.string().trim().min(4).max(7),
  cvv: z.string().min(3).max(4),
  idempotencyKey: z.string().trim().min(8).max(120),
  currency: z.string().trim().length(3).optional(),
})

export const paymentRouter = Router()

paymentRouter.get('/test-cards', requireAuth, requireRole('CUSTOMER'), (_req, res) => {
  res.json(listPublishedTestCards())
})

paymentRouter.post('/simulate', requireAuth, requireRole('CUSTOMER'), async (req, res, next) => {
  try {
    const body = simulateSchema.parse(req.body)
    const result = await simulateCardPayment({
      customerId: req.user!.id,
      amount: body.amount,
      method: body.method,
      cardholderName: body.cardholderName,
      cardNumber: body.cardNumber,
      expiry: body.expiry,
      cvv: body.cvv,
      idempotencyKey: body.idempotencyKey,
      currency: body.currency,
    })
    // Always 200: the attempt was recorded. Clients read `status` for success/failure.
    res.json(result)
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, error.issues[0]?.message || 'Check card details') : error)
  }
})

export const adminPaymentRouter = Router()
adminPaymentRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'))

adminPaymentRouter.get('/', async (req, res, next) => {
  try {
    const query = z
      .object({
        status: z.enum(['pending', 'processing', 'succeeded', 'failed']).optional(),
        method: z.string().optional(),
        q: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        storeId: z.string().optional(),
      })
      .parse(req.query)

    let storeIds = await accessibleStoreIds(req.user!)
    if (query.storeId) {
      if (storeIds && !storeIds.includes(query.storeId)) {
        throw new HttpError(403, 'You cannot view payments for this store')
      }
      storeIds = [query.storeId]
    }

    const from = query.from ? new Date(query.from) : undefined
    const to = query.to ? new Date(query.to) : undefined
    if (from && Number.isNaN(from.getTime())) throw new HttpError(400, 'Start date is invalid')
    if (to && Number.isNaN(to.getTime())) throw new HttpError(400, 'End date is invalid')

    const payload = await listPaymentTransactions({
      storeIds,
      status: query.status,
      method: query.method,
      q: query.q,
      from,
      to,
    })
    res.json(payload)
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, error.issues[0]?.message || 'Check filters') : error)
  }
})
