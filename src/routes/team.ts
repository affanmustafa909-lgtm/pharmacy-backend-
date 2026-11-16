import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { DeskRole } from '@prisma/client'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { assertStoreAccess, canInviteStaff, writeAudit } from '../services/permissions.js'

const deskRoleSchema = z.enum(['OWNER', 'STORE_MANAGER', 'PHARMACIST', 'ORDER_STAFF'])

export const teamRouter = Router()
teamRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'))

teamRouter.get('/stores/:storeId/team', async (req, res, next) => {
  try {
    await assertStoreAccess(req.user!, req.params.storeId)
    const [members, invites] = await Promise.all([
      prisma.storeAssignment.findMany({
        where: { storeId: req.params.storeId },
        include: { user: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.staffInvite.findMany({
        where: { storeId: req.params.storeId, status: { in: ['pending', 'accepted'] } },
        orderBy: { createdAt: 'desc' },
      }),
    ])
    res.json({
      members: members.map((item) => ({
        id: item.id,
        userId: item.userId,
        name: item.user.name,
        email: item.user.email,
        deskRole: item.deskRole,
        canChangePrice: item.canChangePrice,
        canRefund: item.canRefund,
        createdAt: item.createdAt.toISOString(),
      })),
      invites: invites.map((item) => ({
        id: item.id,
        email: item.email,
        deskRole: item.deskRole,
        status: item.status,
        canChangePrice: item.canChangePrice,
        canRefund: item.canRefund,
        createdAt: item.createdAt.toISOString(),
        acceptedAt: item.acceptedAt?.toISOString() ?? null,
      })),
    })
  } catch (error) {
    next(error)
  }
})

teamRouter.post('/stores/:storeId/invites', async (req, res, next) => {
  try {
    const access = await assertStoreAccess(req.user!, req.params.storeId, {
      roles: ['OWNER'],
    })
    if (req.user!.role !== 'ADMIN' && !canInviteStaff(access.deskRole)) {
      throw new HttpError(403, 'Only the main owner can invite staff')
    }
    if (req.user!.role !== 'ADMIN') {
      // Non-admin owners still need OWNER desk role (already checked)
    }
    // Main Owner = ADMIN or OWNER assignment
    if (req.user!.role === 'STAFF' && access.deskRole !== 'OWNER') {
      throw new HttpError(403, 'Only the main owner can invite staff')
    }
    const body = z
      .object({
        email: z.string().email(),
        deskRole: deskRoleSchema,
        canChangePrice: z.boolean().optional(),
        canRefund: z.boolean().optional(),
      })
      .parse(req.body)
    if (body.deskRole === 'OWNER' && req.user!.role !== 'ADMIN') {
      throw new HttpError(403, 'Only the main admin can invite another owner')
    }
    const email = body.email.toLowerCase()
    const existingInvite = await prisma.staffInvite.findFirst({
      where: { email, storeId: req.params.storeId, status: 'pending' },
    })
    if (existingInvite) throw new HttpError(400, 'An invite is already pending for this email')
    const existingAssignment = await prisma.storeAssignment.findFirst({
      where: { storeId: req.params.storeId, user: { email } },
    })
    if (existingAssignment) throw new HttpError(400, 'This user already has access to the store')

    const existingUser = await prisma.user.findUnique({ where: { email } })
    if (existingUser && (existingUser.role === 'ADMIN' || existingUser.role === 'CUSTOMER')) {
      // allow inviting existing staff-like users; customers get upgraded on accept
    }

    const invite = await prisma.staffInvite.create({
      data: {
        email,
        storeId: req.params.storeId,
        deskRole: body.deskRole as DeskRole,
        canChangePrice: body.canChangePrice ?? false,
        canRefund: body.canRefund ?? false,
        token: randomBytes(24).toString('hex'),
        invitedById: req.user!.id,
      },
    })

    // Auto-accept if user already exists as STAFF/ADMIN so portal works without email flow
    if (existingUser && (existingUser.role === 'STAFF' || existingUser.role === 'ADMIN')) {
      await prisma.storeAssignment.upsert({
        where: { userId_storeId: { userId: existingUser.id, storeId: req.params.storeId } },
        create: {
          userId: existingUser.id,
          storeId: req.params.storeId,
          deskRole: invite.deskRole,
          canChangePrice: invite.canChangePrice,
          canRefund: invite.canRefund,
        },
        update: {
          deskRole: invite.deskRole,
          canChangePrice: invite.canChangePrice,
          canRefund: invite.canRefund,
        },
      })
      if (existingUser.role === 'STAFF' && !existingUser.storeId) {
        await prisma.user.update({
          where: { id: existingUser.id },
          data: { storeId: req.params.storeId, deskRole: invite.deskRole, canChangePrice: invite.canChangePrice, canRefund: invite.canRefund },
        })
      }
      await prisma.staffInvite.update({
        where: { id: invite.id },
        data: { status: 'accepted', acceptedAt: new Date(), acceptedUserId: existingUser.id },
      })
      if (invite.deskRole === 'PHARMACIST') {
        await prisma.store.update({
          where: { id: req.params.storeId },
          data: { pharmacistUserId: existingUser.id, pharmacist: existingUser.name },
        })
      }
      if (invite.deskRole === 'STORE_MANAGER') {
        await prisma.store.update({
          where: { id: req.params.storeId },
          data: { managerUserId: existingUser.id },
        })
      }
    }

    await writeAudit({
      actorId: req.user!.id,
      storeId: req.params.storeId,
      action: 'staff.invite',
      detail: `Invited ${email} as ${body.deskRole}`,
      meta: { inviteId: invite.id, deskRole: body.deskRole },
    })
    res.status(201).json({
      id: invite.id,
      email: invite.email,
      deskRole: invite.deskRole,
      status: existingUser && (existingUser.role === 'STAFF' || existingUser.role === 'ADMIN') ? 'accepted' : 'pending',
      token: invite.token,
    })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Check the invite form and try again') : error)
  }
})

teamRouter.patch('/assignments/:id', async (req, res, next) => {
  try {
    const assignment = await prisma.storeAssignment.findUnique({ where: { id: req.params.id } })
    if (!assignment) throw new HttpError(404, 'Assignment not found')
    const access = await assertStoreAccess(req.user!, assignment.storeId, { roles: ['OWNER'] })
    if (req.user!.role === 'STAFF' && access.deskRole !== 'OWNER') {
      throw new HttpError(403, 'Only the owner can change roles')
    }
    const body = z
      .object({
        deskRole: deskRoleSchema.optional(),
        canChangePrice: z.boolean().optional(),
        canRefund: z.boolean().optional(),
      })
      .parse(req.body)
    const updated = await prisma.storeAssignment.update({
      where: { id: assignment.id },
      data: {
        ...(body.deskRole ? { deskRole: body.deskRole as DeskRole } : {}),
        ...(body.canChangePrice != null ? { canChangePrice: body.canChangePrice } : {}),
        ...(body.canRefund != null ? { canRefund: body.canRefund } : {}),
      },
      include: { user: true },
    })
    await prisma.user.update({
      where: { id: updated.userId },
      data: {
        deskRole: updated.deskRole,
        canChangePrice: updated.canChangePrice,
        canRefund: updated.canRefund,
      },
    })
    if (updated.deskRole === 'PHARMACIST') {
      await prisma.store.update({
        where: { id: updated.storeId },
        data: { pharmacistUserId: updated.userId, pharmacist: updated.user.name },
      })
    }
    if (updated.deskRole === 'STORE_MANAGER') {
      await prisma.store.update({ where: { id: updated.storeId }, data: { managerUserId: updated.userId } })
    }
    await writeAudit({
      actorId: req.user!.id,
      storeId: updated.storeId,
      action: 'staff.role_change',
      detail: `Updated ${updated.user.email} to ${updated.deskRole}`,
      meta: { assignmentId: updated.id },
    })
    res.json({
      id: updated.id,
      userId: updated.userId,
      deskRole: updated.deskRole,
      canChangePrice: updated.canChangePrice,
      canRefund: updated.canRefund,
    })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Invalid role update') : error)
  }
})

teamRouter.delete('/assignments/:id', async (req, res, next) => {
  try {
    const assignment = await prisma.storeAssignment.findUnique({ where: { id: req.params.id }, include: { user: true } })
    if (!assignment) throw new HttpError(404, 'Assignment not found')
    const access = await assertStoreAccess(req.user!, assignment.storeId, { roles: ['OWNER'] })
    if (req.user!.role === 'STAFF' && access.deskRole !== 'OWNER') {
      throw new HttpError(403, 'Only the owner can revoke access')
    }
    await prisma.storeAssignment.delete({ where: { id: assignment.id } })
    if (assignment.user.storeId === assignment.storeId) {
      const nextStore = await prisma.storeAssignment.findFirst({ where: { userId: assignment.userId } })
      await prisma.user.update({
        where: { id: assignment.userId },
        data: { storeId: nextStore?.storeId ?? null },
      })
    }
    const store = await prisma.store.findUnique({ where: { id: assignment.storeId } })
    if (store?.pharmacistUserId === assignment.userId) {
      await prisma.store.update({ where: { id: store.id }, data: { pharmacistUserId: null } })
    }
    if (store?.managerUserId === assignment.userId) {
      await prisma.store.update({ where: { id: store.id }, data: { managerUserId: null } })
    }
    await writeAudit({
      actorId: req.user!.id,
      storeId: assignment.storeId,
      action: 'staff.revoke',
      detail: `Revoked access for ${assignment.user.email}`,
      meta: { userId: assignment.userId },
    })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

teamRouter.post('/invites/:id/revoke', async (req, res, next) => {
  try {
    const invite = await prisma.staffInvite.findUnique({ where: { id: req.params.id } })
    if (!invite) throw new HttpError(404, 'Invite not found')
    const access = await assertStoreAccess(req.user!, invite.storeId, { roles: ['OWNER'] })
    if (req.user!.role === 'STAFF' && access.deskRole !== 'OWNER') {
      throw new HttpError(403, 'Only the owner can revoke invites')
    }
    if (invite.status !== 'pending') throw new HttpError(400, 'Only pending invites can be revoked')
    await prisma.staffInvite.update({ where: { id: invite.id }, data: { status: 'revoked' } })
    await writeAudit({
      actorId: req.user!.id,
      storeId: invite.storeId,
      action: 'staff.invite_revoke',
      detail: `Revoked invite for ${invite.email}`,
      meta: { inviteId: invite.id },
    })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

teamRouter.get('/stores/:storeId/products-catalog', async (req, res, next) => {
  try {
    await assertStoreAccess(req.user!, req.params.storeId)
    const products = await prisma.product.findMany({
      where: { storeId: req.params.storeId, held: false },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        sku: true,
        name: true,
        strength: true,
        unitLabel: true,
        stock: true,
        price: true,
        rxRequired: true,
      },
    })
    res.json({
      products: products.map((product) => ({
        ...product,
        price: Number(product.price),
      })),
    })
  } catch (error) {
    next(error)
  }
})
