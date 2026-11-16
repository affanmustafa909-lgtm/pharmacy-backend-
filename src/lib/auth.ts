import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import type { Role } from '@prisma/client'
import { env } from '../env.js'

export interface AuthUser {
  id: string
  role: Role
  storeId: string | null
  email: string
  name: string
}

export function signToken(user: AuthUser) {
  return jwt.sign(
    { sub: user.id, role: user.role, storeId: user.storeId, email: user.email, name: user.name },
    env.jwtSecret,
    { expiresIn: '12h' },
  )
}

export function verifyToken(token: string): AuthUser {
  const payload = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload
  return {
    id: String(payload.sub),
    role: payload.role as Role,
    storeId: (payload.storeId as string | null) ?? null,
    email: String(payload.email),
    name: String(payload.name),
  }
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12)
}

export function checkPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash)
}
