import { Router } from 'express'
import { z } from 'zod'
import { checkPassword, hashPassword, signToken } from '../lib/auth.js'
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

// Customer sign up. Role hamesha CUSTOMER, frontend se role nahi liya jata.
authRouter.post('/register', async (req, res, next) => {
  try {
    const body = z
      .object({
        name: z.string().trim().min(2).max(80),
        email: z.string().email(),
        password: z.string().min(8).max(100),
      })
      .parse(req.body)
    const email = body.email.toLowerCase()
    limit(`register:${email}`)

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) throw new HttpError(409, 'An account with this email already exists')

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email,
        passwordHash: await hashPassword(body.password),
        role: 'CUSTOMER',
      },
    })

    const authUser = { id: user.id, role: user.role, storeId: null, email: user.email, name: user.name }
    res.status(201).json({
      token: signToken(authUser),
      user: { id: user.id, name: user.name, email: user.email, role: user.role, storeId: null },
    })
  } catch (error) {
    next(
      error instanceof z.ZodError
        ? new HttpError(400, 'Enter a valid name, email and a password of at least 8 characters')
        : error,
    )
  }
})

// Logged-in user apna email/password badalta hai (purana password zaroori).
authRouter.post('/change-credentials', requireAuth, async (req, res, next) => {
  try {
    const body = z
      .object({
        currentPassword: z.string().min(8),
        newEmail: z.string().email().optional(),
        newPassword: z.string().min(8).max(100).optional(),
      })
      .parse(req.body)
    if (!body.newEmail && !body.newPassword) throw new HttpError(400, 'Enter a new email or a new password')

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
    if (!user) throw new HttpError(401, 'Sign in required')
    if (!(await checkPassword(body.currentPassword, user.passwordHash))) {
      throw new HttpError(400, 'Current password is incorrect')
    }

    const data: { email?: string; passwordHash?: string } = {}
    if (body.newEmail) {
      const email = body.newEmail.toLowerCase()
      if (email !== user.email) {
        const taken = await prisma.user.findUnique({ where: { email } })
        if (taken) throw new HttpError(409, 'This email is already used by another account')
        data.email = email
      }
    }
    if (body.newPassword) data.passwordHash = await hashPassword(body.newPassword)
    if (Object.keys(data).length > 0) await prisma.user.update({ where: { id: user.id }, data })

    res.json({ ok: true })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Enter a valid email and a password of at least 8 characters') : error)
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