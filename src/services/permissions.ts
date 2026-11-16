import type { DeskRole, Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { HttpError } from '../lib/http.js'
import type { AuthUser } from '../lib/auth.js'

export type StoreAccess = {
  storeId: string
  deskRole: DeskRole
  canChangePrice: boolean
  canRefund: boolean
}

export async function loadStoreAccess(user: AuthUser): Promise<StoreAccess[]> {
  if (user.role === 'ADMIN') {
    const stores = await prisma.store.findMany({
      where: { status: { not: 'archived' } },
      select: { id: true },
    })
    return stores.map((store) => ({
      storeId: store.id,
      deskRole: 'OWNER' as const,
      canChangePrice: true,
      canRefund: true,
    }))
  }
  const assignments = await prisma.storeAssignment.findMany({
    where: { userId: user.id },
    include: { store: { select: { status: true } } },
  })
  return assignments
    .filter((item) => item.store.status !== 'archived')
    .map((item) => ({
      storeId: item.storeId,
      deskRole: item.deskRole,
      canChangePrice: item.canChangePrice,
      canRefund: item.canRefund,
    }))
}

export async function accessibleStoreIds(user: AuthUser): Promise<string[] | null> {
  if (user.role === 'ADMIN') return null
  const access = await loadStoreAccess(user)
  return access.map((item) => item.storeId)
}

export async function assertStoreAccess(
  user: AuthUser,
  storeId: string,
  options?: { roles?: DeskRole[]; requirePrice?: boolean; requireRefund?: boolean; allowDraft?: boolean },
) {
  if (user.role === 'ADMIN') {
    const store = await prisma.store.findUnique({ where: { id: storeId } })
    if (!store) throw new HttpError(404, 'Store not found')
    if (store.status === 'archived' && !options?.allowDraft) throw new HttpError(403, 'This store is archived')
    return {
      storeId,
      deskRole: 'OWNER' as DeskRole,
      canChangePrice: true,
      canRefund: true,
    }
  }

  const assignment = await prisma.storeAssignment.findUnique({
    where: { userId_storeId: { userId: user.id, storeId } },
    include: { store: true },
  })
  if (!assignment) throw new HttpError(403, 'You cannot manage this store')
  if (assignment.store.status === 'archived') throw new HttpError(403, 'This store is archived')
  if (options?.roles && !options.roles.includes(assignment.deskRole)) {
    throw new HttpError(403, 'Your role cannot perform this action')
  }
  if (options?.requirePrice && !assignment.canChangePrice) {
    throw new HttpError(403, 'Price changes require explicit permission')
  }
  if (options?.requireRefund && !assignment.canRefund) {
    throw new HttpError(403, 'Refunds require explicit permission')
  }
  return {
    storeId: assignment.storeId,
    deskRole: assignment.deskRole,
    canChangePrice: assignment.canChangePrice,
    canRefund: assignment.canRefund,
  }
}

export function canReviewPrescriptions(deskRole: DeskRole) {
  return deskRole === 'OWNER' || deskRole === 'STORE_MANAGER' || deskRole === 'PHARMACIST'
}

export function canManageOrders(deskRole: DeskRole) {
  return deskRole === 'OWNER' || deskRole === 'STORE_MANAGER' || deskRole === 'ORDER_STAFF'
}

export function canManageInventory(deskRole: DeskRole) {
  return deskRole === 'OWNER' || deskRole === 'STORE_MANAGER'
}

export function canInviteStaff(deskRole: DeskRole) {
  return deskRole === 'OWNER'
}

export async function writeAudit(input: {
  actorId?: string | null
  storeId?: string | null
  action: string
  detail?: string
  meta?: Prisma.InputJsonValue
}) {
  return prisma.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      storeId: input.storeId ?? null,
      action: input.action,
      detail: input.detail ?? '',
      meta: input.meta ?? {},
    },
  })
}
