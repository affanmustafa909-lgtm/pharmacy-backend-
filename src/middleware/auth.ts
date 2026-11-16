import type { NextFunction, Request, Response } from 'express'
import type { Role } from '@prisma/client'
import { verifyToken, type AuthUser } from '../lib/auth.js'
import { HttpError } from '../lib/http.js'

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return next(new HttpError(401, 'Sign in required'))
  try {
    req.user = verifyToken(token)
    return next()
  } catch {
    return next(new HttpError(401, 'Sign in required'))
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return next(new HttpError(403, 'You do not have access to this'))
    return next()
  }
}

/** @deprecated Prefer await assertStoreAccess from services/permissions */
export function assertStore(user: AuthUser, storeId: string) {
  if (user.role === 'ADMIN') return
  if (user.role === 'STAFF' && user.storeId === storeId) return
  throw new HttpError(403, 'You cannot manage this store')
}

export async function assertStoreAsync(user: AuthUser, storeId: string) {
  const { assertStoreAccess } = await import('../services/permissions.js')
  return assertStoreAccess(user, storeId)
}
