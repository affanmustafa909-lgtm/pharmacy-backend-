import { Router } from 'express'
import { z } from 'zod'
import { checkPassword, signToken } from '../lib/auth.js'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { loadStoreAccess } from '../services/permissions.js'

const loginAttempts = new Map<string, { count: number; resetAt: number }>()

function limit(key: string) {
  const now = Date.now()
  const current = loginAttempts.get(key)
  if (!current || current.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 })
    return
  }
  current.count += 1
  if (current.count > 20) throw new HttpError(429, 'Too many sign-in attempts. Try again later.')
}

export const authRouter = Router()

authRouter.post('/login', async (req, res, next) => {
  try {
    const body = z.object({ email: z.string().email(), password: z.string().min(8) }).parse(req.body)
    limit(body.email.toLowerCase())
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } })
    if (!user || !(await checkPassword(body.password, user.passwordHash))) {
      throw new HttpError(401, 'Email or password is incorrect')
    }
    const access = await loadStoreAccess({
      id: user.id,
      role: user.role,
      storeId: user.storeId,
      email: user.email,
      name: user.name,
    })
    const assignedStoreIds = access.map((item) => item.storeId)
    const primaryStoreId =
      assignedStoreIds.length === 1 ? assignedStoreIds[0] : user.storeId ?? assignedStoreIds[0] ?? null
    const authUser = {
      id: user.id,
      role: user.role,
      storeId: primaryStoreId,
      email: user.email,
      name: user.name,
    }
    res.json({
      token: signToken(authUser),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        storeId: primaryStoreId,
        deskRole: user.role === 'ADMIN' ? 'OWNER' : user.deskRole,
        assignedStoreIds: user.role === 'ADMIN' ? assignedStoreIds : assignedStoreIds,
        canChangePrice: user.role === 'ADMIN' ? true : user.canChangePrice,
        canRefund: user.role === 'ADMIN' ? true : user.canRefund,
      },
    })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Enter a valid email and password') : error)
  }
})

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
    if (!user) throw new HttpError(401, 'Sign in required')
    const access = await loadStoreAccess({
      id: user.id,
      role: user.role,
      storeId: user.storeId,
      email: user.email,
      name: user.name,
    })
    const assignedStoreIds = access.map((item) => item.storeId)
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        city: user.city,
        role: user.role,
        storeId: assignedStoreIds.length === 1 ? assignedStoreIds[0] : user.storeId,
        deskRole: user.role === 'ADMIN' ? 'OWNER' : user.deskRole,
        assignedStoreIds,
        canChangePrice: user.role === 'ADMIN' ? true : user.canChangePrice,
        canRefund: user.role === 'ADMIN' ? true : user.canRefund,
      },
    })
  } catch (error) {
    next(error)
  }
})
